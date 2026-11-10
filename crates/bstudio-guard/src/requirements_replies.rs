//! 요구사항 추출·추천 모델 답을 읽는 판정(옛 TS: `packages/agent/src/requirements.ts`와 `task-plan.ts`의 `parsePlannerReply`, ADR-191 3단계 3ad).
//!
//! 옮긴 것: 답에서 JSON 글자 꺼내기(코드 펜스·첫 `{`~마지막 `}`), `repairExtractionReply`(기계적으로 고칠 수 있는 어긋남 고치기),
//! `enforceSpecQuoteEvidence`(검증되지 않은 인용의 "명세에 있음"을 떼기), `firstLinesPreview`, 참조 파일 상한 문구 읽기와 JSON 파일 이름 판정, `addUsage`.
//! 남긴 것: zod 스키마 검증, 모델 호출, 파일 읽기, `jsonrepair`(깨진 JSON 고치기는 JS 라이브러리다. Rust는 `jsonrepair`에 건넬 글자를 꺼내 줄 뿐이고, 꺼낸 글자를 `JSON.parse`·`jsonrepair`·zod로 읽는 것은 TS다.
//! 꺼낸 대상과 검증하는 대상이 같다).
//!
//! 막는 쪽/여는 쪽: 이 모듈에서 여는 쪽(명세에 근거가 "있다"고 붙임)은 `enforce_spec_quote_evidence` 하나다. 인용 비교는 `requirements::verify_spec_quote`가 하고,
//! 모르는 입력(basis가 'spec'이 아닌 값, 모양이 어긋난 목록)은 강등하는 쪽(근거 없음)으로 처리한다. 나머지는 판정이 아니라 읽기·고르기이고, 결과는 이어지는 zod 검증을 그대로 거친다.
//!
//! 글자는 부르는 쪽이 `encodeLoneSurrogates`한 것을 받고 결과 글자도 같은 인코딩이다(짝 없는 서로게이트가 napi 경계에서 U+FFFD로 합쳐지지 않게).
//!
//! 의도한 차이: `verify_spec_quote`가 낱말 중간에서 자른 인용을 받지 않는다(트러블슈팅 179). 나머지는 옛 TS와 같다.

use crate::js;
use crate::js_json::{self, JsObject, JsValue};
use crate::requirements::{align_requirement, verify_spec_quote, MAX_REQUIREMENTS};

type Res<T> = Result<T, String>;

pub const MAX_CLARIFYING_QUESTIONS: usize = 5;
pub const MAX_OUT_OF_SCOPE: usize = 20;
pub const MAX_ASSUMPTIONS: usize = 10;
pub const MAX_MANUAL_STEPS: usize = 20;

// ---------------------------------------------------------------------------
// 답에서 JSON 글자 꺼내기(parsePlannerReply의 읽기 앞 단계)
// ---------------------------------------------------------------------------

const FENCE: &str = "```";

/// 짝 없는 서로게이트를 인코딩한 글자라 `{`·`` ` ``·공백은 인코딩 안에서 나오지 않는다(인코딩은 U+E000..U+E01F만 쓴다)
fn last_fence_start(text: &str) -> Option<usize> {
    (0..text.len()).rev().filter(|i| text.is_char_boundary(*i)).find(|i| text[*i..].starts_with(FENCE))
}

/// `/```(?:json)?\s*([\s\S]*)```/.exec(text)?.[1]`. 정규식의 되돌아가기 순서를 그대로 따른다:
/// 가장 왼쪽 펜스 시작 `p`(그 뒤에 `p+3` 이상에서 시작하는 펜스가 있어야 한다) → `json`을 먹은 쪽 먼저 → 공백을 많이 먹은 쪽 먼저 →
/// 끝은 항상 마지막 펜스의 시작(`[\s\S]*`가 욕심쟁이)
fn fenced_group(text: &str) -> Option<&str> {
    let last = last_fence_start(text)?;
    let p = (0..text.len()).filter(|i| text.is_char_boundary(*i)).find(|i| text[*i..].starts_with(FENCE) && last >= i + 3)?;
    let after = p + FENCE.len();
    let mut starts: Vec<usize> = Vec::new();
    let bases: Vec<usize> = if text[after..].starts_with("json") { vec![after + 4, after] } else { vec![after] };
    for base in bases {
        let mut ends = vec![base];
        for (offset, c) in text[base..].char_indices() {
            if !js::is_js_whitespace(c) {
                break;
            }
            ends.push(base + offset + c.len_utf8());
        }
        starts.extend(ends.into_iter().rev());
    }
    let start = starts.into_iter().find(|s| last >= *s)?;
    Some(&text[start..last])
}

/// `parsePlannerReply`가 `JSON.parse`에 건넬 글자와, 그것이 실패했을 때 `jsonrepair`에 건넬 글자. `{`가 없으면 `None`
pub fn extract_reply_json(text: &str) -> Option<(String, String)> {
    let source = match fenced_group(text) {
        Some(group) if group.contains('{') => group,
        _ => text,
    };
    let start = source.find('{')?;
    let end = source.rfind('}');
    Some(match end {
        Some(end) if end > start => (source[start..=end].to_owned(), source[start..].to_owned()),
        _ => (source[start..].to_owned(), source[start..].to_owned()),
    })
}

// ---------------------------------------------------------------------------
// repairExtractionReply
// ---------------------------------------------------------------------------

/// `{...value}`: 배열을 펼치면 인덱스 키를 가진 객체가 된다. 객체가 아니면 그대로(`None`)
fn spread(value: &JsValue) -> Option<JsObject> {
    match value {
        JsValue::Obj(o) => Some(o.clone()),
        JsValue::Arr(items) => {
            let mut o = JsObject::new();
            for (i, item) in items.iter().enumerate() {
                o.set(&i.to_string(), item.clone());
            }
            Some(o)
        }
        _ => None,
    }
}

/// 인코딩한 글자를 담은 값을 `JSON.stringify`한 글자. 짝 없는 서로게이트는 `JSON.stringify`가 쓰는 `\udXXX`(소문자 16진수)로 쓰고, 예약 글자는 글자 그대로 쓴다
fn stringify_like_js(value: &JsValue) -> String {
    let text = js_json::stringify(value);
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        match js::read_lone_escape(&chars, i) {
            Some((Ok(c), used)) => {
                out.push(c);
                i += used;
            }
            Some((Err(unit), used)) => {
                out.push_str(&format!("\\u{unit:04x}"));
                i += used;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

fn cap(reply: &mut JsObject, key: &str, max: usize) {
    if let Some(JsValue::Arr(items)) = reply.get_mut(key) {
        if items.len() > max {
            items.truncate(max);
        }
    }
}

fn repair_requirement(requirement: &JsValue) -> Res<JsValue> {
    let Some(mut candidate) = spread(requirement) else { return Ok(requirement.clone()) };
    // 모델은 해당 사항이 없는 선택 항목을 빼지 않고 null로 채우곤 한다
    for key in ["ears", "scenarios", "nfr", "trace", "rev", "hash", "revisedAt"] {
        if matches!(candidate.get(key), Some(JsValue::Null)) {
            candidate.remove(key);
        }
    }
    // 문자열 안의 JSON 예시가 배열 원소(객체)로 떨어져 나온 것을 원래 문장 하나로 다시 붙인다
    if let Some(JsValue::Arr(items)) = candidate.get("acceptance") {
        if items.iter().any(|item| !matches!(item, JsValue::Str(_))) {
            let joined = items
                .iter()
                .map(|item| match item {
                    JsValue::Str(s) => s.clone(),
                    other => stringify_like_js(other),
                })
                .collect::<Vec<_>>()
                .join(" ");
            candidate.set("acceptance", JsValue::Arr(vec![JsValue::Str(joined)]));
        }
    }
    let well_formed = match candidate.get_mut("scenarios") {
        Some(JsValue::Arr(scenarios)) => {
            if scenarios.len() > 20 {
                scenarios.truncate(20);
            }
            Some(scenarios.iter().all(|scenario| matches!(scenario.prop("id"), Some(JsValue::Str(_)))))
        }
        _ => None,
    };
    if well_formed == Some(true) && matches!(candidate.get("id"), Some(JsValue::Str(_))) {
        return align_requirement(&JsValue::Obj(candidate));
    }
    Ok(JsValue::Obj(candidate))
}

/// `repairExtractionReply`. 객체(배열 포함)가 아니면 그대로 돌려준다
pub fn repair_extraction_reply(raw: &JsValue) -> Res<JsValue> {
    let Some(mut reply) = spread(raw) else { return Ok(raw.clone()) };
    for key in ["questions", "outOfScope", "assumptions", "manualSteps"] {
        if matches!(reply.get(key), Some(JsValue::Null)) {
            reply.set(key, JsValue::Arr(Vec::new()));
        }
    }
    cap(&mut reply, "requirements", MAX_REQUIREMENTS);
    cap(&mut reply, "questions", MAX_CLARIFYING_QUESTIONS);
    cap(&mut reply, "outOfScope", MAX_OUT_OF_SCOPE);
    cap(&mut reply, "assumptions", MAX_ASSUMPTIONS);
    cap(&mut reply, "manualSteps", MAX_MANUAL_STEPS);
    if let Some(JsValue::Arr(requirements)) = reply.get("requirements") {
        let mut repaired = Vec::with_capacity(requirements.len());
        for requirement in requirements {
            repaired.push(repair_requirement(requirement)?);
        }
        reply.set("requirements", JsValue::Arr(repaired));
    }
    Ok(JsValue::Obj(reply))
}

// ---------------------------------------------------------------------------
// enforceSpecQuoteEvidence
// ---------------------------------------------------------------------------

/// 강등할 추천의 자리. `bases[i]`가 `"spec"`이고 `quotes[i]`가 없거나(빈 글자 포함) 명세에서 확인되지 않으면 강등한다.
/// `quotes`의 길이가 `bases`보다 짧으면 모자란 자리는 인용 없음으로 본다
pub fn enforce_spec_quote_evidence(bases: &[String], quotes: &[Option<String>], spec_text: &str) -> Vec<usize> {
    let mut demote = Vec::new();
    for (index, basis) in bases.iter().enumerate() {
        if basis != "spec" {
            continue;
        }
        let verified = quotes.get(index).and_then(Option::as_deref).is_some_and(|quote| !quote.is_empty() && verify_spec_quote(quote, spec_text));
        if !verified {
            demote.push(index);
        }
    }
    demote
}

// ---------------------------------------------------------------------------
// 참조 파일 미리보기
// ---------------------------------------------------------------------------

/// `/\.json$/i.test(path)`. `i`는 `u` 없이 쓰므로 ASCII 밖 글자(U+017F `ſ` 등)는 접히지 않는다
pub fn is_json_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 5 && bytes[bytes.len() - 5..].eq_ignore_ascii_case(b".json")
}

/// `/너무 큽니다 \((\d+) bytes\)/.exec(message)`의 숫자(`Number(...)`). 없으면 `None`
pub fn reference_too_big_bytes(message: &str) -> Option<f64> {
    const PREFIX: &str = "너무 큽니다 (";
    const SUFFIX: &str = " bytes)";
    let mut from = 0;
    while let Some(found) = message[from..].find(PREFIX) {
        let start = from + found + PREFIX.len();
        let digits = message[start..].bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && message[start + digits..].starts_with(SUFFIX) {
            return Some(js::to_number(&message[start..start + digits]));
        }
        from += found + 1;
        while !message.is_char_boundary(from) {
            from += 1;
        }
    }
    None
}

/// 인코딩한 글자를 JS 코드 단위로 나눈다: (먹은 글자 수, 코드 단위 수). 인코딩 이스케이프(짝 없는 서로게이트·예약 글자)는 한 단위다
fn logical_pieces(chars: &[char]) -> Vec<(usize, usize)> {
    let mut pieces = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match js::read_lone_escape(chars, i) {
            Some((_, used)) => {
                pieces.push((used, 1));
                i += used;
            }
            None => {
                pieces.push((1, chars[i].len_utf16()));
                i += 1;
            }
        }
    }
    pieces
}

/// `firstLinesPreview`: 앞 `max_lines`줄(`\r?\n`로 나눔)을 `\n`으로 이어 `trim`하고, `max_chars`(UTF-16 코드 단위)를 넘으면 그만큼에서 자르고 `…`를 붙인다.
/// 자르는 자리가 두 단위짜리 글자의 가운데면 앞 서로게이트만 남는다(`String.prototype.slice`와 같다. 그 글자는 짝 없는 서로게이트 인코딩으로 쓴다)
pub fn first_lines_preview(content: &str, max_lines: usize, max_chars: usize) -> String {
    let pieces: Vec<&str> = content.split('\n').collect();
    let last = pieces.len() - 1;
    let lines: Vec<&str> = pieces
        .iter()
        .enumerate()
        .take(max_lines)
        .map(|(i, line)| if i < last { line.strip_suffix('\r').unwrap_or(line) } else { line })
        .collect();
    let joined = lines.join("\n");
    let trimmed = js::trim(&joined);
    let chars: Vec<char> = trimmed.chars().collect();
    let pieces = logical_pieces(&chars);
    let total: usize = pieces.iter().map(|(_, units)| units).sum();
    if total <= max_chars {
        return trimmed.to_owned();
    }
    let mut out = String::new();
    let (mut at, mut units) = (0usize, 0usize);
    for (used, width) in pieces {
        if units + width > max_chars {
            if units < max_chars {
                // 두 단위짜리 글자의 앞 절반(높은 서로게이트)만 남는다
                let mut buf = [0u16; 2];
                let high = u32::from(chars[at].encode_utf16(&mut buf)[0]);
                out.push_str(&js::encode_lone_unit(high));
            }
            break;
        }
        out.extend(&chars[at..at + used]);
        at += used;
        units += width;
    }
    out.push('…');
    out
}

// ---------------------------------------------------------------------------
// addUsage
// ---------------------------------------------------------------------------

/// 사용량 넷(input·output·cacheRead·cacheWrite)을 항목마다 더한다
pub fn add_usage(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json::parse_native;

    fn json(text: &str) -> JsValue {
        parse_native(text).expect("json")
    }

    #[test]
    fn 펜스와_중괄호로_답에서_json을_꺼낸다() {
        assert_eq!(extract_reply_json("계획입니다.\n```json\n{\"tasks\":[]}\n```"), Some(("{\"tasks\":[]}".to_owned(), "{\"tasks\":[]}\n".to_owned())));
        assert_eq!(extract_reply_json("앞 {\"a\":1} 뒤"), Some(("{\"a\":1}".to_owned(), "{\"a\":1} 뒤".to_owned())));
        assert_eq!(extract_reply_json("나눌 수 없습니다"), None);
        // 중괄호가 없는 펜스 안은 쓰지 않고 전체 글에서 찾는다
        assert_eq!(extract_reply_json("{\"a\":1}\n```\nx\n```").map(|p| p.0), Some("{\"a\":1}".to_owned()));
        // 닫는 `}`가 없으면 끝까지
        assert_eq!(extract_reply_json("{\"a\":[1,2").map(|p| p.0), Some("{\"a\":[1,2".to_owned()));
        // 펜스가 하나뿐이면 펜스로 보지 않는다
        assert_eq!(extract_reply_json("```json\n{\"a\":1}").map(|p| p.0), Some("{\"a\":1}".to_owned()));
        // 마지막 펜스까지 잡는다
        assert_eq!(extract_reply_json("```json\n{\"a\":\"```\",\"b\":1}\n```").map(|p| p.0), Some("{\"a\":\"```\",\"b\":1}".to_owned()));
    }

    #[test]
    fn 고치기는_null_목록과_상한과_시나리오_id를_고친다() {
        let raw = json(r#"{"requirements":[{"id":"R1","title":"t","nfr":null,"acceptance":["a",{"x":1}],"scenarios":[{"id":"R9.1"}]}],"questions":null,"assumptions":["a","b","c","d","e","f","g","h","i","j","k"]}"#);
        let fixed = repair_extraction_reply(&raw).unwrap();
        let text = js_json::stringify(&fixed);
        assert!(text.contains(r#""questions":[]"#), "{text}");
        assert!(!text.contains("nfr"), "{text}");
        assert!(text.contains(r#""acceptance":["a {\"x\":1}"]"#), "{text}");
        assert!(text.contains(r#""id":"R1.1""#), "{text}");
        assert!(text.contains(r#""j"]"#) && !text.contains(r#""k""#), "{text}");
    }

    #[test]
    fn 근거_강등은_인용이_없거나_틀리면_한다() {
        let bases = vec!["spec".to_owned(), "spec".to_owned(), "practice".to_owned(), "spec".to_owned()];
        let quotes = vec![Some("보낸다".to_owned()), None, Some("x".to_owned()), Some("없다".to_owned())];
        assert_eq!(enforce_spec_quote_evidence(&bases, &quotes, "메일을 보낸다."), vec![1, 3]);
    }

    #[test]
    fn 참조_파일_판정() {
        assert!(is_json_path("a/B.JSON"));
        assert!(!is_json_path("a.jsonx"));
        assert!(!is_json_path("json"));
        assert_eq!(reference_too_big_bytes("파일이 너무 큽니다 (300000 bytes)"), Some(300000.0));
        assert_eq!(reference_too_big_bytes("너무 큽니다 (x bytes) 너무 큽니다 (5 bytes)"), Some(5.0));
        assert_eq!(reference_too_big_bytes("너무 큽니다 (5 byte)"), None);
    }

    #[test]
    fn 앞_몇_줄_미리보기() {
        assert_eq!(first_lines_preview("a\r\nb\n\nc\nd\ne\nf", 5, 300), "a\nb\n\nc\nd");
        assert_eq!(first_lines_preview("  x  \n", 5, 300), "x");
        assert_eq!(first_lines_preview(&"가".repeat(301), 5, 300), format!("{}…", "가".repeat(300)));
        assert_eq!(first_lines_preview(&"가".repeat(300), 5, 300), "가".repeat(300));
        // 두 단위짜리 글자의 가운데에서 자르면 앞 서로게이트만 남는다
        let cut = first_lines_preview(&format!("{}😀", "a".repeat(299)), 5, 300);
        assert_eq!(cut, format!("{}{}…", "a".repeat(299), js::encode_lone_unit(0xD83D)));
    }

    #[test]
    fn 사용량_합() {
        assert_eq!(add_usage([1.0, 2.0, 3.0, 4.0], [10.0, 20.0, 30.0, 40.0]), [11.0, 22.0, 33.0, 44.0]);
    }
}
