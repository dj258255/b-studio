//! 테스트 탭의 결과 단계 판정(ADR-191 3단계 3d). 옛 `packages/agent/src/test-results.ts`와 같은 입력에 같은 결과를 낸다.
//!
//! 실행기가 남긴 보고서(JUnit XML, Vitest/Jest JSON)를 읽고, 발견 단계가 찾은 테스트 행과 이어 붙이고, 상태별 개수를 세고,
//! 대화 입력창을 채우는 글을 만든다. 순수 함수만 있다.
//!
//! 옛 정규식은 같은 뜻으로 손으로 옮겼다(되돌아감 우선순위까지): `<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)`의 게으른 속성 부분은
//! 첫 `/>`나 `>`에서 멈추고, 속성 정규식 `([\w:-]+)\s*=\s*"((?:[^"\\]|\\.)*)"`의 값은 `\` 뒤 줄 끝 글자가 오면 그 시작에서 실패한다.
//! `\b`·`\w`는 ASCII, `\s`는 JS 공백, `.`는 줄 끝 글자(`\n` `\r` U+2028 U+2029)를 맞추지 않는다.
//!
//! 의도한 차이(모두 던지거나 읽지 않는 쪽):
//! - 엔티티 `&constructor;`: 옛 TS는 `XML_ENTITIES['constructor']`가 상속된 `Object` 함수라 그 함수의 글자
//!   (`function Object() { [native code] }`)로 바꿨다. 새 코드는 모르는 엔티티로 보고 그대로 둔다(자기 항목만 본다).
//! - 짝 없는 서로게이트는 U+FFFD로 읽는다(Node 경계 규칙, js_json 참고). 단, 엔티티가 만든 서로게이트 한 쌍(`&#xD83D;&#xDE00;`)은 JS처럼 한 글자로 합친다.
//! - 키가 NUL로 시작하는 JSON과 2,000단계를 넘는 중첩은 읽지 못한 JSON으로 본다(`parseJestLikeJson`은 빈 결과).
//! - 문자열이 아닌 값을 이름·경로로 받으면 던진다(옛 TS도 `.replace`·`.toLowerCase`에서 던졌다. 던지는 자리만 다를 수 있다).
//! - 오류의 종류와 메시지(`RangeError`·`TypeError` 대신 `Error`와 한국어 문구).

use crate::js;
use crate::js_json::{self, object, JsValue};
use std::borrow::Cow;
use std::collections::HashMap;

const MAX_STACK_LINES: usize = 5;

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `Math.round`. `js::math_round`는 -0.5 이상 0 미만에서 +0을 돌려주는데 JS는 -0이다
fn math_round(x: f64) -> f64 {
    let r = js::math_round(x);
    if r == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        r
    }
}

// ---------------------------------------------------------------------------
// 엔티티·속성
// ---------------------------------------------------------------------------

/// 16진수 글자들(`[0-9a-fA-F]+`)을 `parseInt(digits, 16)`처럼 수로 읽는다. 54비트를 넘으면 JS처럼 가장 가까운 수로 반올림한다
fn parse_hex(digits: &str) -> f64 {
    let d = digits.trim_start_matches('0');
    if d.is_empty() {
        return 0.0;
    }
    if d.len() <= 13 {
        return u64::from_str_radix(d, 16).expect("16진수") as f64;
    }
    let (head, tail) = d.split_at(16.min(d.len()));
    let mut m = u64::from_str_radix(head, 16).expect("16진수");
    // 아래 자리에 0이 아닌 것이 있으면 맨 아래 비트에 표시한다(m은 61비트 이상이라 53비트 반올림 자리 밑이다)
    if tail.bytes().any(|b| b != b'0') {
        m |= 1;
    }
    (m as f64) * 2f64.powi(i32::try_from(tail.len() * 4).unwrap_or(i32::MAX))
}

/// `/&(#x?[0-9a-fA-F]+|[a-z]+);/`가 `amp`(`&` 자리)에서 맞으면 `;` 다음 위치와 괄호 안 글자
fn entity_at(text: &str, amp: usize) -> Option<(usize, &str)> {
    let b = text.as_bytes();
    let mut j = amp + 1;
    if b.get(j) == Some(&b'#') {
        j += 1;
        if b.get(j) == Some(&b'x') {
            j += 1;
        }
        let digits_start = j;
        while b.get(j).is_some_and(u8::is_ascii_hexdigit) {
            j += 1;
        }
        if j > digits_start && b.get(j) == Some(&b';') {
            return Some((j + 1, &text[amp + 1..j]));
        }
        return None;
    }
    let start = j;
    while b.get(j).is_some_and(u8::is_ascii_lowercase) {
        j += 1;
    }
    if j > start && b.get(j) == Some(&b';') {
        return Some((j + 1, &text[start..j]));
    }
    None
}

/// 엔티티 풀기. `String.fromCodePoint`가 범위 밖 값에서 던지는 것도 같다(`Err`)
fn decode_xml_entities(text: &str) -> Result<String, String> {
    if !text.contains('&') {
        return Ok(text.to_owned());
    }
    // JS 문자열처럼 UTF-16 코드 단위로 모은다: 엔티티가 만든 짝 서로게이트 두 개는 한 글자가 된다
    let mut out: Vec<u16> = Vec::with_capacity(text.len());
    let mut pos = 0;
    while let Some(rel) = text[pos..].find('&') {
        let amp = pos + rel;
        out.extend(text[pos..amp].encode_utf16());
        let Some((end, code)) = entity_at(text, amp) else {
            out.push(u16::from(b'&'));
            pos = amp + 1;
            continue;
        };
        pos = end;
        if let Some(rest) = code.strip_prefix('#') {
            let value = match rest.strip_prefix('x') {
                Some(hex) => parse_hex(hex),
                None => js::parse_int(rest),
            };
            if !value.is_finite() {
                out.extend(text[amp..end].encode_utf16());
                continue;
            }
            if value > 1_114_111.0 {
                return Err(format!("엔티티의 코드 포인트가 범위를 벗어났습니다: {}", &text[amp..end]));
            }
            let cp = value as u32;
            match char::from_u32(cp) {
                Some(c) => {
                    let mut buf = [0u16; 2];
                    out.extend_from_slice(c.encode_utf16(&mut buf));
                }
                // 서로게이트 한 개(JS 문자열은 담을 수 있다)
                None => out.push(cp as u16),
            }
            continue;
        }
        let replacement = match code {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            "apos" => "'",
            _ => {
                out.extend(text[amp..end].encode_utf16());
                continue;
            }
        };
        out.extend(replacement.encode_utf16());
    }
    out.extend(text[pos..].encode_utf16());
    Ok(String::from_utf16_lossy(&out))
}

fn skip_ws(raw: &str, mut pos: usize) -> usize {
    while let Some(c) = raw[pos..].chars().next() {
        if !js::is_js_whitespace(c) {
            break;
        }
        pos += c.len_utf8();
    }
    pos
}

/// `/([\w:-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g`로 속성을 읽는다(큰따옴표 값만). 같은 이름이 다시 나오면 뒤의 값이 이긴다
fn parse_xml_attrs(raw: &str) -> Result<Vec<(String, String)>, String> {
    let b = raw.as_bytes();
    let is_name = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'_' | b':' | b'-');
    let mut attrs: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !is_name(b[i]) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < b.len() && is_name(b[j]) {
            j += 1;
        }
        let name_end = j;
        let value = (|| {
            let mut k = skip_ws(raw, name_end);
            if b.get(k) != Some(&b'=') {
                return None;
            }
            k = skip_ws(raw, k + 1);
            if b.get(k) != Some(&b'"') {
                return None;
            }
            k += 1;
            let value_start = k;
            loop {
                match b.get(k) {
                    None => return None,
                    Some(b'"') => return Some((value_start, k)),
                    Some(b'\\') => {
                        let next = raw[k + 1..].chars().next()?;
                        if js::is_js_line_terminator(next) {
                            return None;
                        }
                        k += 1 + next.len_utf8();
                    }
                    Some(_) => k += 1,
                }
            }
        })();
        match value {
            Some((vs, ve)) => {
                attrs.push((raw[i..name_end].to_owned(), decode_xml_entities(&raw[vs..ve])?));
                i = ve + 1;
            }
            // 이름 글자 도중에서 다시 시작해도 같은 자리에서 실패하므로 이름 끝으로 건너뛴다
            None => i = name_end,
        }
    }
    Ok(attrs)
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

struct Element<'a> {
    end: usize,
    attrs: &'a str,
    body: Option<&'a str>,
}

/// `from` 이후에서 `/<TAG\b([^>]*?)(?:\/>|>([\s\S]*?)<\/TAG>)/`의 첫 맞음(시작 위치와 내용)
fn find_element<'a>(s: &'a str, tag: &str, from: usize) -> Option<(usize, Element<'a>)> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let b = s.as_bytes();
    let mut search = from;
    while let Some(rel) = s[search..].find(&open) {
        let start = search + rel;
        let after_tag = start + open.len();
        if after_tag < b.len() && is_word_byte(b[after_tag]) {
            search = start + 1;
            continue;
        }
        // 게으른 `[^>]*?`: 첫 `/>`나 `>`에서 멈춘다(`>`는 먹을 수 없다)
        let mut p = after_tag;
        let found = loop {
            if p >= b.len() {
                break None;
            }
            if b[p] == b'/' && b.get(p + 1) == Some(&b'>') {
                break Some(Element { end: p + 2, attrs: &s[after_tag..p], body: None });
            }
            if b[p] == b'>' {
                break s[p + 1..].find(&close).map(|c| Element { end: p + 1 + c + close.len(), attrs: &s[after_tag..p], body: Some(&s[p + 1..p + 1 + c]) });
            }
            p += 1;
        };
        if let Some(element) = found {
            return Some((start, element));
        }
        search = start + 1;
    }
    None
}

/// `/<TAG\b/.test(text)`
fn has_open_tag(text: &str, tag: &str) -> bool {
    let open = format!("<{tag}");
    let b = text.as_bytes();
    text.match_indices(&open).any(|(i, _)| b.get(i + open.len()).is_none_or(|c| !is_word_byte(*c)))
}

fn status_object(status: &str, duration: Option<f64>, failure_message: Option<String>, stack: Option<Vec<String>>) -> JsValue {
    object(vec![
        ("status", Some(JsValue::str(status))),
        ("durationMs", duration.map(JsValue::Num)),
        ("failureMessage", failure_message.map(JsValue::Str)),
        ("stack", stack.map(|lines| JsValue::Arr(lines.into_iter().map(JsValue::Str).collect()))),
    ])
}

/// JUnit XML을 읽는다. 결과는 `{cases: [...]}`
pub fn parse_junit_xml(xml: &str) -> Result<JsValue, String> {
    let mut cases = Vec::new();
    let mut from = 0;
    while let Some((_, element)) = find_element(xml, "testcase", from) {
        from = element.end;
        let attrs = parse_xml_attrs(element.attrs)?;
        let name = attr(&attrs, "name").unwrap_or("");
        let class_or_file = attr(&attrs, "classname").or_else(|| attr(&attrs, "class")).unwrap_or("");
        let duration = attr(&attrs, "time").map(|t| math_round(js::to_number(t) * 1000.0));

        let mut result = status_object("pass", duration.filter(|d| d.is_finite()), None, None);
        if let Some(body) = element.body {
            let skipped = has_open_tag(body, "skipped");
            let failure = find_element(body, "failure", 0);
            let error = if failure.is_none() { find_element(body, "error", 0) } else { None };
            if skipped {
                result = status_object("skip", duration, None, None);
            } else if let Some((_, problem)) = failure.or(error) {
                let problem_attrs = parse_xml_attrs(problem.attrs)?;
                let text = match problem.body {
                    Some(raw) if !raw.is_empty() => Some(js::trim(&decode_xml_entities(raw)?).to_owned()),
                    _ => None,
                };
                let message = attr(&problem_attrs, "message").map(str::to_owned).or_else(|| text.as_ref().and_then(|t| t.split('\n').next()).map(str::to_owned));
                let stack = text.as_ref().filter(|t| !t.is_empty()).map(|t| t.split('\n').take(MAX_STACK_LINES).map(str::to_owned).collect::<Vec<_>>());
                result = status_object("fail", duration, message.filter(|m| !m.is_empty()), stack);
            }
        }
        cases.push(object(vec![("classOrFile", Some(JsValue::str(class_or_file))), ("name", Some(JsValue::str(name))), ("result", Some(result))]));
    }
    Ok(object(vec![("cases", Some(JsValue::Arr(cases)))]))
}

// ---------------------------------------------------------------------------
// Vitest / Jest JSON
// ---------------------------------------------------------------------------

/// `for (const x of value ?? [])`: 배열은 원소, 문자열은 글자(코드 포인트), 없거나 null은 빈 반복, 그 밖은 던진다
fn iterate(value: Option<&JsValue>) -> Result<Vec<Cow<'_, JsValue>>, String> {
    match value {
        None | Some(JsValue::Null) => Ok(Vec::new()),
        Some(JsValue::Arr(items)) => Ok(items.iter().map(Cow::Borrowed).collect()),
        Some(JsValue::Str(s)) => Ok(s.chars().map(|c| Cow::Owned(JsValue::Str(c.to_string()))).collect()),
        Some(_) => Err("반복할 수 없는 값입니다".to_owned()),
    }
}

fn nullish_or<'a>(first: Option<&'a JsValue>, fallback: impl FnOnce() -> Option<&'a JsValue>) -> Option<&'a JsValue> {
    match first {
        None | Some(JsValue::Null) => fallback(),
        some => some,
    }
}

/// 보고서 한 건의 묶음 제목들. ancestorTitles가 없는 옛 형식은 fullName이 title로 끝나면 그 앞부분을 묶음 하나로 본다
fn jest_like_suite_path(assertion: &JsValue) -> Vec<String> {
    if let Some(JsValue::Arr(titles)) = assertion.prop("ancestorTitles") {
        return titles.iter().filter_map(|t| t.as_str()).filter(|t| !js::trim(t).is_empty()).map(str::to_owned).collect();
    }
    if let (Some(JsValue::Str(full_name)), Some(JsValue::Str(title))) = (assertion.prop("fullName"), assertion.prop("title")) {
        if !title.is_empty() {
            if let Some(prefix) = full_name.strip_suffix(title.as_str()) {
                let prefix = js::trim(prefix);
                if !prefix.is_empty() {
                    return vec![prefix.to_owned()];
                }
            }
        }
    }
    Vec::new()
}

fn jest_like_status(status: Option<&JsValue>) -> &'static str {
    match status.and_then(JsValue::as_str) {
        Some("passed") => "pass",
        Some("failed") => "fail",
        Some("skipped" | "pending" | "todo" | "disabled") => "skip",
        _ => "not-run",
    }
}

/// Jest/Vitest json을 읽는다. JSON이 아니면 빈 결과, JSON `null`이면 던진다(옛 코드가 `null.testResults`에서 던졌다)
pub fn parse_jest_like_json(json: &str) -> Result<JsValue, String> {
    let empty = || object(vec![("cases", Some(JsValue::Arr(Vec::new())))]);
    let Ok(report) = js_json::parse(json) else {
        return Ok(empty());
    };
    if matches!(report, JsValue::Null) {
        return Err("보고서가 null입니다".to_owned());
    }
    let mut cases = Vec::new();
    for file in iterate(report.prop("testResults"))? {
        if matches!(*file, JsValue::Null) {
            return Err("테스트 파일 항목이 null입니다".to_owned());
        }
        // `file.name ?? file.testFilePath ?? ''`
        let class_or_file = nullish_or(file.prop("name"), || nullish_or(file.prop("testFilePath"), || None)).cloned().unwrap_or_else(|| JsValue::str(""));
        for assertion in iterate(file.prop("assertionResults"))? {
            if matches!(*assertion, JsValue::Null) {
                return Err("테스트 항목이 null입니다".to_owned());
            }
            let title = nullish_or(assertion.prop("title"), || None).cloned().unwrap_or_else(|| JsValue::str(""));
            let status = jest_like_status(assertion.prop("status"));
            let duration = match assertion.prop("duration") {
                Some(JsValue::Num(d)) => Some(math_round(*d)),
                _ => None,
            };
            // `assertion.failureMessages?.[0]`: 배열은 첫 원소, 문자열은 첫 UTF-16 단위, 객체는 "0" 키
            let failure_text: Option<JsValue> = match assertion.prop("failureMessages") {
                Some(JsValue::Arr(items)) => items.first().cloned(),
                Some(JsValue::Str(s)) => s.chars().next().map(|c| JsValue::Str(if c.len_utf16() > 1 { "\u{FFFD}".to_owned() } else { c.to_string() })),
                Some(JsValue::Obj(o)) => o.get("0").cloned(),
                _ => None,
            };
            let (failure_message, stack) = match &failure_text {
                None | Some(JsValue::Null) => (None, None),
                Some(JsValue::Str(text)) => {
                    let first = text.split('\n').next().map(str::to_owned);
                    let stack = if text.is_empty() { None } else { Some(text.split('\n').take(MAX_STACK_LINES).map(str::to_owned).collect::<Vec<_>>()) };
                    (first, stack)
                }
                Some(_) => return Err("failureMessages의 첫 항목이 문자열이 아닙니다".to_owned()),
            };
            let suite_path = jest_like_suite_path(&assertion);
            let failed = status == "fail";
            cases.push(object(vec![
                ("classOrFile", Some(class_or_file.clone())),
                ("name", Some(title)),
                ("suitePath", if suite_path.is_empty() { None } else { Some(JsValue::Arr(suite_path.into_iter().map(JsValue::Str).collect())) }),
                (
                    "result",
                    Some(status_object(status, duration, failure_message.filter(|m| failed && !m.is_empty()), stack.filter(|s| failed && !s.is_empty()))),
                ),
            ]));
        }
    }
    Ok(object(vec![("cases", Some(JsValue::Arr(cases)))]))
}

// ---------------------------------------------------------------------------
// 발견한 테스트와 파싱한 결과를 잇는다
// ---------------------------------------------------------------------------

/// `.replace(/\s+/g, ' ')`
fn collapse_ws(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_ws = false;
    for c in text.chars() {
        if js::is_js_whitespace(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// `.replace(/OPEN.*$/, '')`: `.`는 줄 끝 글자를 맞추지 않고 `$`는 글자 끝이라, 마지막 줄 끝 글자 뒤의 첫 OPEN부터 끝까지를 지운다
fn cut_from_open(text: &str, open: char) -> &str {
    let tail_start = text.char_indices().rev().find(|(_, c)| js::is_js_line_terminator(*c)).map_or(0, |(i, c)| i + c.len_utf8());
    match text[tail_start..].find(open) {
        Some(p) => &text[..tail_start + p],
        None => text,
    }
}

/// 표시 이름 비교용: 앞뒤 공백·연속 공백·대소문자만 맞춘다(괄호는 그대로 둔다)
fn plain_name(text: &str) -> String {
    collapse_ws(&js::trim(text).to_lowercase())
}

fn normalize_name(text: &str) -> String {
    plain_name(cut_from_open(cut_from_open(text, '('), '['))
}

/// `filePath.split(/[/\\]/).pop()`에서 `.replace(/\.[^.]+$/, '')`
fn base_name(file_path: &str) -> &str {
    let segment = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    match segment.rfind('.') {
        Some(dot) if dot + 1 < segment.len() => &segment[..dot],
        _ => segment,
    }
}

fn require_str<'a>(value: Option<&'a JsValue>, what: &str) -> Result<&'a str, String> {
    value.and_then(JsValue::as_str).ok_or_else(|| format!("{what}이(가) 문자열이 아닙니다"))
}

/// 발견한 행마다 짝지은 보고서 케이스의 위치(없으면 -1)를 돌려준다. `ids`는 케이스마다 같은 객체면 같은 값이다(옛 코드는 `Set`으로 객체를 셌다).
/// 행은 `{name, displayName, file, suitePath}`, 케이스는 `{name, classOrFile, suitePath}`만 담은 JSON(Node 경계 규칙)이다
pub fn attach_results(rows_json: &str, cases_json: &str, ids: &[u32]) -> Result<Vec<i64>, String> {
    let (rows, cases) = match (js_json::parse_native(rows_json)?, js_json::parse_native(cases_json)?) {
        (JsValue::Arr(rows), JsValue::Arr(cases)) => (rows, cases),
        _ => return Err("행과 케이스는 배열이어야 합니다".to_owned()),
    };
    if ids.len() != cases.len() {
        return Err("케이스와 id의 길이가 다릅니다".to_owned());
    }
    let mut by_normalized: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_plain: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, case) in cases.iter().enumerate() {
        let name = require_str(case.prop("name"), "케이스 이름")?;
        by_normalized.entry(normalize_name(name)).or_default().push(i);
        by_plain.entry(plain_name(name)).or_default().push(i);
    }
    let mut used = vec![false; ids.iter().map(|id| *id as usize + 1).max().unwrap_or(0)];
    let unused = |list: Option<&Vec<usize>>, used: &[bool]| -> Vec<usize> { list.map_or_else(Vec::new, |l| l.iter().copied().filter(|c| !used[ids[*c] as usize]).collect()) };

    let mut picked = Vec::with_capacity(rows.len());
    for row in &rows {
        let row_key = normalize_name(require_str(row.prop("name"), "행 이름")?);
        let mut candidates = unused(by_normalized.get(&row_key), &used);
        if candidates.is_empty() {
            if let Some(display) = row.prop("displayName").filter(|d| d.truthy()) {
                let key = plain_name(require_str(Some(display), "표시 이름")?);
                candidates = unused(by_plain.get(&key), &used);
            }
        }
        let chosen = match candidates.len() {
            0 => None,
            1 => Some(candidates[0]),
            _ => {
                // 이름이 같은 후보가 여럿이면 classOrFile·묶음 경로가 파일 이름이나 스위트 이름을 담고 있는 것을 우선한다
                let file_base = base_name(require_str(row.prop("file"), "행 파일")?).to_lowercase();
                let row_suites: &[JsValue] = match row.prop("suitePath") {
                    Some(JsValue::Arr(items)) => items,
                    _ => return Err("행의 suitePath가 배열이 아닙니다".to_owned()),
                };
                let suite_names = row_suites.iter().map(|s| require_str(Some(s), "묶음 제목").map(str::to_lowercase)).collect::<Result<Vec<_>, _>>()?;
                let mut best: Option<(usize, i64)> = None;
                for &candidate in &candidates {
                    let haystack = require_str(cases[candidate].prop("classOrFile"), "케이스 classOrFile")?.to_lowercase();
                    let mut score = 0;
                    if haystack.contains(&file_base) {
                        score += 2;
                    }
                    for suite in &suite_names {
                        if haystack.contains(suite.as_str()) {
                            score += 1;
                        }
                    }
                    // 보고서가 묶음 경로를 담고 있으면(Jest/Vitest) 발견 행의 묶음 경로와 같을 때 가장 강하게 친다
                    if let Some(candidate_suite) = cases[candidate].prop("suitePath").filter(|s| s.truthy()) {
                        match candidate_suite {
                            JsValue::Arr(titles) => {
                                if titles.len() == row_suites.len() {
                                    let mut all_equal = true;
                                    for (title, row_title) in titles.iter().zip(row_suites) {
                                        let a = plain_name(require_str(Some(title), "보고서 묶음 제목")?);
                                        let b = plain_name(require_str(Some(row_title), "묶음 제목")?);
                                        if a != b {
                                            all_equal = false;
                                            break;
                                        }
                                    }
                                    if all_equal {
                                        score += 4;
                                    }
                                }
                            }
                            // 문자열은 `.length`는 있지만 `.every`가 없어, 길이가 같을 때만 던진다
                            JsValue::Str(s) if js::utf16_len(s) == row_suites.len() => return Err("suitePath가 배열이 아닙니다".to_owned()),
                            _ => {}
                        }
                    }
                    // 점수가 높은 것, 같으면 앞의 것(안정 정렬의 첫 원소)
                    if best.is_none_or(|(_, top)| score > top) {
                        best = Some((candidate, score));
                    }
                }
                best.map(|(candidate, _)| candidate)
            }
        };
        match chosen {
            Some(index) => {
                used[ids[index] as usize] = true;
                picked.push(index as i64);
            }
            None => picked.push(-1),
        }
    }
    Ok(picked)
}

/// 상태 목록(`JSON.stringify(rows.map((row) => row.result?.status))`)으로 `{pass, fail, skip, notRun}`을 센다
pub fn count_by_status(statuses_json: &str) -> Result<String, String> {
    let JsValue::Arr(statuses) = js_json::parse(statuses_json)? else {
        return Err("상태 목록은 배열이어야 합니다".to_owned());
    };
    let (mut pass, mut fail, mut skip, mut not_run) = (0.0, 0.0, 0.0, 0.0);
    for status in &statuses {
        match status.as_str() {
            Some("pass") => pass += 1.0,
            Some("fail") => fail += 1.0,
            Some("skip") => skip += 1.0,
            _ => not_run += 1.0,
        }
    }
    Ok(js_json::stringify(&object(vec![
        ("pass", Some(JsValue::Num(pass))),
        ("fail", Some(JsValue::Num(fail))),
        ("skip", Some(JsValue::Num(skip))),
        ("notRun", Some(JsValue::Num(not_run))),
    ])))
}

// ---------------------------------------------------------------------------
// 대화 입력창 채우기
// ---------------------------------------------------------------------------

/// 템플릿 리터럴 `${value}`: 없으면 `undefined`
fn template(value: Option<&JsValue>) -> String {
    value.map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
}

/// `array.join('\n')`: null은 빈 글자
fn join_lines(items: &[JsValue]) -> String {
    items.iter().map(|v| if matches!(v, JsValue::Null) { String::new() } else { v.to_js_string() }).collect::<Vec<_>>().join("\n")
}

/// 실패한 테스트의 "이 테스트 고쳐 줘" 버튼이 채우는 글. 입력은 `{displayName, file, line, result}`의 JSON
pub fn build_fix_test_prefill(row_json: &str) -> Result<String, String> {
    let row = js_json::parse_native(row_json)?;
    let result = row.prop("result");
    let failure = match result.and_then(|r| r.prop("failureMessage")).filter(|m| m.truthy()) {
        Some(message) => format!("\n\n실패 메시지:\n{}", message.to_js_string()),
        None => String::new(),
    };
    // `row.result?.stack?.length ? ... stack.join('\n')`: 길이가 0이 아닌 배열만 이어 붙이고, 그 밖의 값은 `.join`이 없어 던진다
    let stack = match result.and_then(|r| r.prop("stack")) {
        Some(JsValue::Arr(items)) if !items.is_empty() => format!("\n\n스택(앞부분):\n{}", join_lines(items)),
        Some(JsValue::Str(s)) if !s.is_empty() => return Err("stack이 배열이 아닙니다".to_owned()),
        Some(JsValue::Obj(o)) if o.get("length").is_some_and(JsValue::truthy) => return Err("stack이 배열이 아닙니다".to_owned()),
        _ => String::new(),
    };
    Ok(format!(
        "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: {}\n위치: {}:{}{failure}{stack}",
        template(row.prop("displayName")),
        template(row.prop("file")),
        template(row.prop("line")),
    ))
}

/// 요구사항인데 테스트가 없는 항목의 "테스트 추가" 버튼이 채우는 글. 입력은 `{id, title, acceptance, ears, scenarios}`의 JSON
pub fn build_add_test_prefill(requirement_json: &str) -> Result<String, String> {
    let requirement = js_json::parse_native(requirement_json)?;
    let id = template(requirement.prop("id"));
    let mut lines: Vec<String> = vec![
        format!("[{id}] {}", template(requirement.prop("title"))),
        String::new(),
        format!("이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 {id}을(를) 넣어 테스트를 추가해 주세요."),
    ];
    if let Some(ears) = requirement.prop("ears").filter(|e| e.truthy()) {
        lines.push(String::new());
        lines.push(format!("EARS: {}", template(ears.prop("statement"))));
    }
    let Some(JsValue::Arr(acceptance)) = requirement.prop("acceptance") else {
        return Err("acceptance가 배열이 아닙니다".to_owned());
    };
    lines.push(String::new());
    lines.push("인수 조건:".to_owned());
    lines.extend(acceptance.iter().map(|item| format!("- {}", item.to_js_string())));
    // `scenarios && scenarios.length > 0`
    let scenarios: Vec<Cow<'_, JsValue>> = match requirement.prop("scenarios").filter(|s| s.truthy()) {
        Some(JsValue::Arr(items)) => items.iter().map(Cow::Borrowed).collect(),
        Some(JsValue::Str(s)) => s.chars().map(|c| Cow::Owned(JsValue::Str(c.to_string()))).collect(),
        Some(JsValue::Obj(o)) if o.get("length").is_some_and(|l| l.to_number() > 0.0) => return Err("scenarios가 배열이 아닙니다".to_owned()),
        _ => Vec::new(),
    };
    if !scenarios.is_empty() {
        lines.push(String::new());
        lines.push("시나리오:".to_owned());
        for scenario in &scenarios {
            if matches!(**scenario, JsValue::Null) {
                return Err("시나리오 항목이 null입니다".to_owned());
            }
            lines.push(format!(
                "- {}: (Given) {} (When) {} (Then) {}",
                template(scenario.prop("id")),
                template(scenario.prop("given")),
                template(scenario.prop("when")),
                template(scenario.prop("then")),
            ));
        }
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_json(xml: &str) -> String {
        js_json::stringify(&parse_junit_xml(xml).unwrap())
    }

    #[test]
    fn 엔티티를_풀고_범위_밖은_던진다() {
        assert_eq!(decode_xml_entities("a &amp; b &lt;&gt;&quot;&apos; &#65;&#x42;&#X43; &unknown; &Amp; &constructor;").unwrap(), "a & b <>\"' AB&#X43; &unknown; &Amp; &constructor;");
        assert_eq!(decode_xml_entities("&#xD83D;&#xDE00;").unwrap(), "😀");
        assert_eq!(decode_xml_entities("&#xD800;").unwrap(), "\u{FFFD}");
        assert_eq!(decode_xml_entities("&#12ab;&#1e3;&#abc;").unwrap(), "\u{c}\u{1}&#abc;");
        assert!(decode_xml_entities("&#x110000;").unwrap_err().contains("범위"));
        assert!(decode_xml_entities("&#1114112;").is_err());
        assert_eq!(decode_xml_entities("&#1114111;").unwrap(), "\u{10FFFF}");
        // 너무 길어 무한대가 되면 그대로 둔다
        let huge = format!("&#{};", "9".repeat(400));
        assert_eq!(decode_xml_entities(&huge).unwrap(), huge);
        assert_eq!(decode_xml_entities("&&amp;&").unwrap(), "&&&");
    }

    #[test]
    fn 속성은_큰따옴표_값만_읽고_뒤의_같은_이름이_이긴다() {
        let attrs = parse_xml_attrs(r#" a="1" b='2' a = "3"  c:d-e="x\"y" f="\
" g="h""#).unwrap();
        // f는 `\` 뒤 줄바꿈이라 실패하고, 그 안의 g="h"는 따로 읽힌다
        assert_eq!(attr(&attrs, "a"), Some("3"));
        assert_eq!(attr(&attrs, "b"), None);
        assert_eq!(attr(&attrs, "c:d-e"), Some(r#"x\"y"#));
        assert_eq!(attr(&attrs, "f"), None);
        assert_eq!(attr(&attrs, "g"), Some("h"));
    }

    #[test]
    fn 게으른_속성_부분은_첫_닫는_기호에서_멈춘다() {
        // `/>`가 먼저면 자기 닫힘이고 속성은 그 앞까지
        let (_, e) = find_element(r#"<testcase a="x/>y">"#, "testcase", 0).unwrap();
        assert_eq!((e.attrs, e.body), (r#" a="x"#, None));
        // `>` 뒤에 닫는 태그가 없으면 이 시작은 실패한다(뒤의 자기 닫힘도 찾지 못한 채 다음 시작으로)
        assert!(find_element("<testcase a>", "testcase", 0).is_none());
        let (start, e) = find_element("<testcase a><testcase b/>", "testcase", 0).unwrap();
        assert_eq!((start, e.attrs), (12, " b"));
        // `\b`: 단어 글자가 이어지면 다른 태그다
        assert!(find_element("<testcases/>", "testcase", 0).is_none());
        assert!(find_element("<testcase_x/>", "testcase", 0).is_none());
        assert!(find_element("<testcase-x/>", "testcase", 0).is_some());
    }

    #[test]
    fn junit_상태_판정() {
        let xml = r#"<testsuite><testcase classname="A" name="ok" time="0.5"/>
<testcase classname="A" name="sk" time="1"><skipped/></testcase>
<testcase name="bad" time="x"><failure message="boom">line1
line2</failure></testcase>
<testcase name="err"><error>E&amp;1</error></testcase></testsuite>"#;
        assert_eq!(
            run_json(xml),
            r#"{"cases":[{"classOrFile":"A","name":"ok","result":{"status":"pass","durationMs":500}},{"classOrFile":"A","name":"sk","result":{"status":"skip","durationMs":1000}},{"classOrFile":"","name":"bad","result":{"status":"fail","durationMs":null,"failureMessage":"boom","stack":["line1","line2"]}},{"classOrFile":"","name":"err","result":{"status":"fail","failureMessage":"E&1","stack":["E&1"]}}]}"#
        );
    }

    #[test]
    fn jest_보고서의_상태와_묶음_경로() {
        let json = r#"{"testResults":[{"name":"/a.test.ts","assertionResults":[
          {"title":"t1","status":"passed","duration":1.5,"ancestorTitles":["A"," ","B"]},
          {"title":"t2","fullName":"A t2","status":"failed","failureMessages":["boom\nstack1\nstack2"]},
          {"title":"t3","status":"todo"},{"status":"zzz"}]}]}"#;
        assert_eq!(
            js_json::stringify(&parse_jest_like_json(json).unwrap()),
            r#"{"cases":[{"classOrFile":"/a.test.ts","name":"t1","suitePath":["A","B"],"result":{"status":"pass","durationMs":2}},{"classOrFile":"/a.test.ts","name":"t2","suitePath":["A"],"result":{"status":"fail","failureMessage":"boom","stack":["boom","stack1","stack2"]}},{"classOrFile":"/a.test.ts","name":"t3","result":{"status":"skip"}},{"classOrFile":"/a.test.ts","name":"","result":{"status":"not-run"}}]}"#
        );
        assert_eq!(js_json::stringify(&parse_jest_like_json("{oops").unwrap()), r#"{"cases":[]}"#);
        assert!(parse_jest_like_json("null").is_err());
        assert_eq!(js_json::stringify(&parse_jest_like_json("[]").unwrap()), r#"{"cases":[]}"#);
    }

    #[test]
    fn 이름_정규화() {
        assert_eq!(normalize_name("  Foo Bar(1)  "), "foo bar");
        assert_eq!(normalize_name("a[1](x)"), "a");
        // 줄 끝 글자 뒤의 `(`부터만 지운다
        assert_eq!(normalize_name("a(b\nc(d"), "a(b c");
        assert_eq!(normalize_name("a(b\n"), "a(b");
        assert_eq!(plain_name("A\u{a0}\u{feff} B"), "a b");
        assert_eq!(base_name("src\\Foo.test.ts"), "Foo.test");
        assert_eq!(base_name("a/b."), "b.");
        assert_eq!(base_name("a/.x"), "");
        assert_eq!(base_name(""), "");
    }

    #[test]
    fn 짝짓기는_앞의_같은_점수를_고르고_쓴_케이스는_다시_고르지_않는다() {
        let rows = r#"[{"name":"t","displayName":"","file":"x/Foo.test.ts","suitePath":["A"]},{"name":"t","file":"x/Foo.test.ts","suitePath":["A"]},{"name":"t","file":"x","suitePath":[]}]"#;
        let cases = r#"[{"name":"t","classOrFile":"other"},{"name":"t","classOrFile":"/Foo.test.ts"},{"name":"t","classOrFile":"/Foo.test.ts","suitePath":["a"]}]"#;
        assert_eq!(attach_results(rows, cases, &[0, 1, 2]).unwrap(), vec![2, 1, 0]);
        // 같은 객체가 두 번 나오면 하나를 쓰면 둘 다 쓴 것이다
        assert_eq!(attach_results(r#"[{"name":"t","file":"","suitePath":[]},{"name":"t","file":"","suitePath":[]}]"#, r#"[{"name":"t","classOrFile":""},{"name":"t","classOrFile":""}]"#, &[0, 0]).unwrap(), vec![0, -1]);
    }

    #[test]
    fn 개수와_글() {
        assert_eq!(count_by_status(r#"["pass","fail",null,"skip","x","pass"]"#).unwrap(), r#"{"pass":2,"fail":1,"skip":1,"notRun":2}"#);
        let fix = build_fix_test_prefill(r#"{"displayName":"d","file":"f","line":3,"result":{"failureMessage":"m","stack":["a",null,"b"]}}"#).unwrap();
        assert_eq!(fix, "다음 테스트가 실패합니다. 고쳐 주세요.\n\n테스트: d\n위치: f:3\n\n실패 메시지:\nm\n\n스택(앞부분):\na\n\nb");
        let add = build_add_test_prefill(r#"{"id":"R1","title":"T","acceptance":["a","b"],"scenarios":[{"id":"R1.1","given":"g","when":"w","then":"t"}]}"#).unwrap();
        assert_eq!(
            add,
            "[R1] T\n\n이 요구사항의 인수 조건을 검증하는 테스트가 아직 없습니다. 테스트 이름에 R1을(를) 넣어 테스트를 추가해 주세요.\n\n인수 조건:\n- a\n- b\n\n시나리오:\n- R1.1: (Given) g (When) w (Then) t"
        );
    }
}
