//! 통과한 확인이 무엇을 쟀는지 사람이 읽을 줄로 남기는 규칙(ADR-191 3단계 3e). `packages/agent/src/check-evidence.ts`에서 옮겼다.
//!
//! 판정을 다시 하지 않는다 — 판정에 쓴 것과 같은 결과에서 잰 값만 적는다. 값을 적기 전에 **가린 뒤에 자른다**(먼저 자르면 긴 시크릿의
//! 앞부분이 가림 대상과 일치하지 않아 그대로 남는다). 가리는 함수(`redact`)는 JS 쪽 것을 부른다: 부르는 순서와 횟수가 옛 TS와 같다.
//!
//! 의도한 차이: (1) 서로게이트 쌍의 가운데를 자르면 U+FFFD가 된다(JS는 짝 없는 서로게이트가 남는다). (2) 모양이 어긋난 입력
//! (배열이어야 할 자리의 문자열, `null`의 속성 읽기)은 던진다. 호출하는 쪽은 던지면 근거 줄을 비운다.

use crate::js::{self, math_round, to_fixed, truncate_utf16, utf16_len};
use crate::js_json::JsValue;
use crate::review_input::{opt_prop, prop, template};

pub const MAX_EVIDENCE_LINES: usize = 12;
const MAX_LINE_LENGTH: usize = 240;
const MAX_VALUE_LENGTH: usize = 60;

/// 시크릿 값을 가리는 함수(JS 쪽). 던지면 이유를 돌려준다
pub type Redact<'a> = &'a dyn Fn(&str) -> Result<String, String>;

/// `Number.prototype.toLocaleString('ko-KR')`: 3자리 묶음 쉼표, 소수는 최대 3자리(가장 짧게 되읽히는 10진 자릿수에서 반올림해 가운데는 위로),
/// `NaN`, `∞`, `-0`을 그대로 쓴다
pub fn to_locale_ko(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    if x.is_infinite() {
        return format!("{sign}∞");
    }
    if x == 0.0 {
        return format!("{sign}0");
    }
    // 가장 짧게 되읽히는 자릿수: "1.2345e-7"
    let (shortest, exp) = js::shortest_digits(x.abs());
    let mut digits: Vec<u8> = shortest.bytes().map(|c| c - b'0').collect();
    // 값 = 0.digits × 10^point
    let mut point = exp + 1;
    // 소수 3자리까지 남기고 반올림한다: 정수 자릿수는 point개, 그 뒤 3개까지가 남는 자리
    let keep = point + 3;
    if keep < 0 {
        return format!("{sign}0");
    }
    let keep = keep as usize;
    if digits.len() > keep {
        let round_up = digits[keep] >= 5;
        digits.truncate(keep);
        if round_up {
            let mut i = digits.len();
            loop {
                if i == 0 {
                    digits.insert(0, 1);
                    point += 1;
                    break;
                }
                i -= 1;
                if digits[i] == 9 {
                    digits[i] = 0;
                } else {
                    digits[i] += 1;
                    break;
                }
            }
        }
    }
    // 정수부(point자리)와 소수부로 나눈다
    let (int_digits, frac_digits): (Vec<u8>, Vec<u8>) = if point <= 0 {
        (vec![0], std::iter::repeat_n(0, (-point) as usize).chain(digits.iter().copied()).collect())
    } else {
        let p = point as usize;
        let mut int = digits.iter().copied().take(p).collect::<Vec<_>>();
        int.resize(p, 0);
        (int, digits.iter().copied().skip(p).collect())
    };
    let mut frac = frac_digits;
    while frac.last() == Some(&0) {
        frac.pop();
    }
    let int_text: String = int_digits.iter().map(|d| char::from(b'0' + d)).collect();
    let mut grouped = String::new();
    for (i, c) in int_text.chars().enumerate() {
        if i > 0 && (int_text.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let mut out = format!("{sign}{grouped}");
    if !frac.is_empty() {
        out.push('.');
        out.extend(frac.iter().map(|d| char::from(b'0' + d)));
    }
    out
}

/// 값을 따옴표로 감싸 적는다. 가린 뒤에 자른다
fn quote(value: &JsValue, redact: Redact) -> Result<String, String> {
    quote_text(&value.to_js_string(), redact)
}

fn quote_text(original: &str, redact: Redact) -> Result<String, String> {
    let text = redact(original)?;
    Ok(if utf16_len(&text) > MAX_VALUE_LENGTH { format!("'{}…'", truncate_utf16(&text, MAX_VALUE_LENGTH)) } else { format!("'{text}'") })
}

fn quote_all(values: &[&JsValue], redact: Redact) -> Result<String, String> {
    Ok(values.iter().map(|v| quote(v, redact)).collect::<Result<Vec<_>, _>>()?.join(", "))
}

/// 줄 수를 묶는다(`finish_evidence`의 첫 단계). 상한을 넘으면 앞 `MAX_EVIDENCE_LINES - 1`줄과 "그 밖에 N가지"다
pub fn cap_evidence_lines(lines: &[String]) -> Vec<String> {
    if lines.len() > MAX_EVIDENCE_LINES {
        let mut head = lines[..MAX_EVIDENCE_LINES - 1].to_vec();
        head.push(format!("그 밖에 {}가지", lines.len() - (MAX_EVIDENCE_LINES - 1)));
        head
    } else {
        lines.to_vec()
    }
}

/// 가린 줄의 길이를 묶는다(`finish_evidence`의 둘째 단계). 가리는 함수를 비동기로 부르는 쪽(`bstudio-io`의 게이트)이 줄마다 가린 뒤 부른다
pub fn clamp_evidence_line(safe: String) -> String {
    if utf16_len(&safe) > MAX_LINE_LENGTH {
        format!("{}…", truncate_utf16(&safe, MAX_LINE_LENGTH))
    } else {
        safe
    }
}

/// 줄 수와 길이를 묶고 시크릿 값을 가린다
pub fn finish_evidence(lines: &[String], redact: Redact) -> Result<Vec<String>, String> {
    cap_evidence_lines(lines).iter().map(|line| Ok(clamp_evidence_line(redact(line)?))).collect()
}

/// `text.includes(candidate)`. 후보는 문자열로 바꿔 찾는다
fn includes_text(text: &str, candidate: &JsValue) -> bool {
    text.contains(candidate.to_js_string().as_str())
}

/// 배열이어야 하는 자리(`filter`·`map`). 아니면 던진다
fn array<'a>(value: &'a JsValue, what: &str) -> Result<&'a [JsValue], String> {
    match value {
        JsValue::Arr(items) => Ok(items),
        _ => Err(format!("{what}이(가) 배열이 아닙니다")),
    }
}

/// `array.length`
fn length(value: Option<&JsValue>, what: &str) -> Result<usize, String> {
    match value {
        Some(JsValue::Arr(items)) => Ok(items.len()),
        Some(JsValue::Str(s)) => Ok(utf16_len(s)),
        _ => Err(format!("{what}의 길이를 읽을 수 없습니다")),
    }
}

fn text_lines(page: Option<&JsValue>, text: &str, place: &str, redact: Redact) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    if let Some(expect) = opt_prop(page, "expectText").filter(|v| v.truthy()) {
        if includes_text(text, expect) {
            lines.push(format!("{} {place}에 있음", quote(expect, redact)?));
        }
    }
    if let Some(any) = opt_prop(page, "expectAnyText").filter(|v| v.truthy()) {
        let list = array(any, "expectAnyText")?;
        let found: Vec<&JsValue> = list.iter().filter(|c| includes_text(text, c)).collect();
        if !found.is_empty() {
            lines.push(format!("{} {place}에 있음 (적은 {}개 중 하나면 통과)", quote_all(&found, redact)?, list.len()));
        }
    }
    if let Some(all) = opt_prop(page, "expectAllText").filter(|v| v.truthy()) {
        let list = array(all, "expectAllText")?;
        let found: Vec<&JsValue> = list.iter().filter(|c| includes_text(text, c)).collect();
        if !found.is_empty() {
            lines.push(format!("{} {place}에 {}있음", quote_all(&found, redact)?, if found.len() == list.len() { "모두 " } else { "" }));
        }
    }
    Ok(lines)
}

fn status_line(status: Option<&JsValue>, page: Option<&JsValue>, context: Option<&JsValue>) -> String {
    // `status ?? '응답 없음'`
    let got = format!("HTTP {}", match status {
        None | Some(JsValue::Null) => "응답 없음".to_owned(),
        Some(v) => v.to_js_string(),
    });
    match opt_prop(context, "probedId") {
        Some(id) => format!("{got} — 추정한 id({})로 열어 404·500만 실패로 봤습니다", id.to_js_string()),
        None => format!("{got} (기대 {})", template(opt_prop(page, "expectStatus"))),
    }
}

/// `value.toLocaleString('ko-KR')`. 수는 규칙대로, 문자열은 그대로, 그 밖의 값은 던진다
fn locale(value: &JsValue, what: &str) -> Result<String, String> {
    match value {
        JsValue::Num(n) => Ok(to_locale_ko(*n)),
        JsValue::Str(s) => Ok(s.clone()),
        JsValue::Bool(b) => Ok(b.to_string()),
        _ => Err(format!("{what}을(를) 숫자로 쓸 수 없습니다")),
    }
}

fn api_line(context: Option<&JsValue>, place: &str, redact: Redact) -> Result<Option<String>, String> {
    let Some(api) = opt_prop(context, "api").filter(|v| v.truthy()) else { return Ok(None) };
    // value가 없으면 `String(undefined)`: "undefined"
    let quoted = quote_text(&template(opt_prop(Some(api), "value")), redact)?;
    Ok(Some(format!("{}의 {} 값 {quoted} {place}에 있음", template(opt_prop(Some(api), "service")), template(opt_prop(Some(api), "jsonPath")))))
}

/// browser 모드 화면 확인이 통과했을 때의 근거. 판정에 쓴 result 그대로에서 만든다
pub fn browser_page_evidence(page: &JsValue, result: &JsValue, context: Option<&JsValue>, redact: Redact) -> Result<Vec<String>, String> {
    let page_opt = Some(page);
    let mut lines = vec![status_line(opt_prop(Some(result), "status"), page_opt, context)];
    let text = match opt_prop(Some(result), "text") {
        Some(JsValue::Str(s)) => s.as_str(),
        _ => return Err("result.text가 문자열이 아닙니다".into()),
    };
    lines.extend(text_lines(page_opt, text, "화면", redact)?);
    let viewport = opt_prop(Some(result), "viewportTexts").filter(|v| v.truthy());
    if let (Some(expect), Some(viewport)) = (opt_prop(page_opt, "expectInViewport").filter(|v| v.truthy()), viewport) {
        let expect = array(expect, "expectInViewport")?;
        let findings = array(prop(Some(viewport), "findings")?.ok_or("findings가 없습니다")?, "findings")?;
        let mut visible: Vec<&JsValue> = Vec::new();
        for finding in findings {
            if prop(Some(finding), "visible")?.is_some_and(JsValue::truthy) {
                let shown = prop(Some(finding), "text")?;
                if let Some(shown) = shown {
                    if expect.iter().any(|e| match (e, shown) {
                        (JsValue::Num(a), JsValue::Num(b)) => js::same_value_zero(*a, *b),
                        _ => e.strict_equals(shown),
                    }) {
                        visible.push(shown);
                    }
                }
            }
        }
        if !visible.is_empty() {
            lines.push(format!(
                "첫 화면에 온전히 보임 (창 {}x{}): {}",
                template(opt_prop(Some(viewport), "width")),
                template(opt_prop(Some(viewport), "height")),
                quote_all(&visible, redact)?
            ));
        }
    }
    if let Some(line) = api_line(context, "화면", redact)? {
        lines.push(line);
    }
    let console = length(opt_prop(Some(result), "consoleErrors"), "consoleErrors")?;
    let failed = length(opt_prop(Some(result), "failedRequests"), "failedRequests")?;
    let media = length(opt_prop(Some(result), "mediaErrors"), "mediaErrors")?;
    let tolerated = format!("console.error {console}건 · 실패한 요청 {failed}건 · 미디어 오류 {media}건");
    let page_errors = length(opt_prop(Some(result), "pageErrors"), "pageErrors")?;
    lines.push(if opt_prop(page_opt, "allowConsoleErrors").is_some_and(JsValue::truthy) {
        format!("스크립트 예외 {page_errors}건 — {tolerated}은 실패로 보지 않았습니다(allowConsoleErrors)")
    } else {
        format!("스크립트 예외 {page_errors}건 · {tolerated}")
    });
    if opt_prop(page_opt, "allowLoadingPlaceholder").is_some_and(JsValue::truthy) {
        lines.push("로딩 문구에서 멈췄는지는 보지 않았습니다(allowLoadingPlaceholder)".into());
    }
    if opt_prop(page_opt, "noHorizontalScroll").is_some_and(JsValue::truthy) {
        lines.push(format!("가로 넘침 {}px", template(opt_prop(Some(result), "horizontalOverflowPx"))));
    }
    if let Some(load) = opt_prop(Some(result), "loadMs") {
        let budget = match opt_prop(page_opt, "maxLoadMs") {
            Some(max) => format!(" (예산 {}ms)", locale(max, "maxLoadMs")?),
            None => String::new(),
        };
        lines.push(format!("로드 {}ms{budget}", locale(load, "loadMs")?));
    }
    // 첫 항목은 페이지를 연 것(open <경로>)이라 선언한 단계 수와 맞춘다
    let declared_steps = match opt_prop(page_opt, "steps") {
        Some(JsValue::Arr(items)) => !items.is_empty(),
        Some(JsValue::Str(s)) => !s.is_empty(),
        _ => false,
    };
    if declared_steps {
        let steps = array(opt_prop(Some(result), "steps").ok_or("steps가 없습니다")?, "steps")?;
        let ran = steps.get(1..).unwrap_or(&[]);
        if !ran.is_empty() {
            let mut ok = 0;
            let mut labels = Vec::new();
            for step in ran {
                if prop(Some(step), "ok")?.is_some_and(JsValue::truthy) {
                    ok += 1;
                }
                labels.push(match prop(Some(step), "label")? {
                    None | Some(JsValue::Null) => String::new(),
                    Some(v) => v.to_js_string(),
                });
            }
            lines.push(format!("단계 {ok}/{}개 실행: {}", ran.len(), labels.join(" → ")));
        }
    }
    if opt_prop(context, "auto").is_some_and(JsValue::truthy) {
        lines.push("Next.js 오류 화면 표지 없음".into());
    }
    Ok(lines)
}

/// http 모드 화면 확인이 통과했을 때의 근거. 자바스크립트를 실행하지 않았다는 사실을 함께 적는다
pub fn http_page_evidence(page: &JsValue, response: &JsValue, context: Option<&JsValue>, redact: Redact) -> Result<Vec<String>, String> {
    let page_opt = Some(page);
    let mut lines = vec![status_line(opt_prop(Some(response), "status"), page_opt, context)];
    let text = match opt_prop(Some(response), "text") {
        Some(JsValue::Str(s)) => s.as_str(),
        _ => return Err("response.text가 문자열이 아닙니다".into()),
    };
    lines.extend(text_lines(page_opt, text, "응답 본문", redact)?);
    if let Some(line) = api_line(context, "응답 본문", redact)? {
        lines.push(line);
    }
    if opt_prop(context, "auto").is_some_and(JsValue::truthy) {
        lines.push("Next.js 오류 화면 표지 없음".into());
    }
    lines.push("HTTP 확인이라 자바스크립트를 실행하지 않았습니다 — 화면에 그려졌는지, 콘솔 오류·실패한 요청은 보지 않았습니다".into());
    Ok(lines)
}

/// 테스트 명령이 통과했을 때의 근거. 무엇을 어디서 돌렸고 얼마나 걸렸는지
pub fn test_evidence(service: &str, command: &[String], elapsed_ms: f64) -> Vec<String> {
    let seconds = elapsed_ms / 1000.0;
    let took = if seconds < 10.0 { to_fixed(seconds, 1) } else { to_locale_ko(math_round(seconds)) };
    vec![format!("{service}에서 `{}` 종료 코드 0", command.join(" ")), format!("걸린 시간 {took}초")]
}
