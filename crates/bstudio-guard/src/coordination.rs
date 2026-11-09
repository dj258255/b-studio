//! 레인 협업의 실패 서명·메모 크기·읽기 권한 판정(ADR-191 3단계 3i). 옮기기 전 TS는 `packages/agent/src/coordination/`의
//! `signature.ts`·`notes.ts`·`topology.ts`였다.
//!
//! 서명은 "같은 실패"를 가르는 키라서 글자 하나라도 달라지면 같은 실패를 다른 실패로 본다. 그래서 JS가 읽던 규칙을 그대로 따른다:
//! - `normalize_message`: 첫 줄(`\n` 앞), JS `trim`, 해시(`\b[0-9a-f]{7,}\b`, 대소문자 무시) → `H`, 숫자열(`\d+`, ASCII) → `N`,
//!   UTF-16 코드 단위 200개로 자른다. 단어 글자는 ASCII뿐이다(JS `\b`)
//! - 입력은 `JSON.parse`한 값(`JsValue`)이다. 선언한 모양이 어긋나면 JS가 던지는 자리에서 `Err`를 낸다(`null.x`, 배열이 아닌 값의
//!   `for…of`·`.filter`, 문자열이 아닌 값의 `.split`). JS가 조용히 `undefined`로 읽는 자리(`5.ready`)는 그대로 `undefined`로 읽는다
//!
//! 의도한 차이: 짝 없는 서로게이트는 Node 경계에서 U+FFFD가 된다(입력, 그리고 200자 경계가 서로게이트 쌍을 가르는 결과).
//! 값이 `undefined`인 키는 JSON에 실리지 않아 "키가 없다"와 같다(`{ error: undefined }`와 `{}`가 같다).

use crate::js;
use crate::js_json::{self, JsValue};

/// `normalizeMessage`가 자르는 UTF-16 코드 단위 수
const MESSAGE_LIMIT: usize = 200;

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `/\b[0-9a-f]{7,}\b/gi` → `H`. `\b`는 ASCII 단어 글자 기준이라, 맞는 것은 "단어 글자 덩어리 전체가 16진 글자이고 7개 이상"인 덩어리다
/// (덩어리 안쪽에서 시작하면 앞이 단어 글자라 경계가 아니고, 덩어리가 16진 글자로만 끝나지 않으면 끝 경계가 없다)
fn replace_hex_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= 7 && run.bytes().all(|b| b.is_ascii_hexdigit()) {
            out.push('H');
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in text.chars() {
        if is_word(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// `/\d+/g` → `N`(ASCII 숫자)
fn replace_digit_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_digits = false;
    for c in text.chars() {
        if c.is_ascii_digit() {
            if !in_digits {
                out.push('N');
            }
            in_digits = true;
        } else {
            in_digits = false;
            out.push(c);
        }
    }
    out
}

/// 실패 메시지 정규화: 첫 줄만, 앞뒤 공백 제거, 16진 해시 → H, 숫자열 → N, 200자로 자른다
pub fn normalize_message(text: &str) -> String {
    let first = text.split('\n').next().unwrap_or("");
    let replaced = replace_digit_runs(&replace_hex_tokens(js::trim(first)));
    js::truncate_utf16(&replaced, MESSAGE_LIMIT)
}

/// 문자열이 아닌 값에 `.split`을 부르면 JS가 던진다
fn normalize_value(value: Option<&JsValue>) -> Result<String, String> {
    match value {
        Some(JsValue::Str(text)) => Ok(normalize_message(text)),
        _ => Err("실패 메시지가 문자열이 아닙니다".to_owned()),
    }
}

/// `null.x`는 던진다. 그 밖의 값은 `x`를 읽으면 속성이거나 `undefined`다(`JsValue::prop`)
fn deref<'a>(value: &'a JsValue, what: &str) -> Result<&'a JsValue, String> {
    if matches!(value, JsValue::Null) {
        return Err(format!("{what}이(가) null입니다"));
    }
    Ok(value)
}

/// `for…of`·`.filter`·`.map`을 부를 배열. 배열이 아니면 JS가 던진다
fn array_of<'a>(value: Option<&'a JsValue>, what: &str) -> Result<&'a [JsValue], String> {
    match value {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{what}이(가) 배열이 아닙니다")),
    }
}

/// `for…of`가 도는 값. 배열은 항목 그대로, 문자열은 코드 포인트 하나씩(JS의 문자열 반복), 그 밖은 반복할 수 없어 던진다
pub(crate) fn iterate(value: Option<&JsValue>, what: &str) -> Result<Vec<JsValue>, String> {
    match value {
        Some(JsValue::Arr(items)) => Ok(items.clone()),
        Some(JsValue::Str(text)) => Ok(text.chars().map(|c| JsValue::Str(c.to_string())).collect()),
        _ => Err(format!("{what}을(를) 반복할 수 없습니다")),
    }
}

/// 템플릿 글자 `${value}`: `undefined`는 "undefined"
fn template(value: Option<&JsValue>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(v) => v.to_js_string(),
    }
}

/// `[a, b].join(sep)`의 한 칸: `undefined`·`null`은 빈 글자
fn join_elem(value: Option<&JsValue>) -> String {
    match value {
        None | Some(JsValue::Null) => String::new(),
        Some(v) => v.to_js_string(),
    }
}

fn truthy(value: Option<&JsValue>) -> bool {
    value.is_some_and(JsValue::truthy)
}

/// `{ stage, service?, message, files? }`. 값이 없는 키는 넣지 않는다(키 순서는 옛 객체 리터럴과 같다)
fn signature(stage: Option<JsValue>, service: Option<JsValue>, message: String, files: Option<JsValue>) -> JsValue {
    js_json::object(vec![("stage", stage), ("service", service), ("message", Some(JsValue::Str(message))), ("files", files)])
}

/// 같은 원인의 실패를 하나로 묶는 키: `[stage, service ?? '', message, (files ?? []).join(',')].join('|')`
pub fn signature_key(sig: &JsValue) -> Result<String, String> {
    let sig = deref(sig, "서명")?;
    let service = sig.prop("service");
    let service = if js_json::nullish(service) { String::new() } else { join_elem(service) };
    let files = match sig.prop("files") {
        None | Some(JsValue::Null) => String::new(),
        Some(JsValue::Arr(items)) => items.iter().map(|f| join_elem(Some(f))).collect::<Vec<_>>().join(","),
        Some(_) => return Err("서명의 files가 배열이 아닙니다".to_owned()),
    };
    Ok([join_elem(sig.prop("stage")), service, join_elem(sig.prop("message")), files].join("|"))
}

/// 검증기가 통과하지 못한 항목만 서명으로 만든다: 준비 못 한 서비스, 어긋난 계약, 반영 확인 실패, 시크릿 검출
pub fn signatures_from_report(report: &JsValue) -> Result<Vec<JsValue>, String> {
    let report = deref(report, "검증 보고서")?;
    let mut signatures = Vec::new();
    for check in &iterate(report.prop("restarted"), "restarted")? {
        let check = deref(check, "서비스 확인")?;
        if truthy(check.prop("ready")) {
            continue;
        }
        // `check.error ?? check.logTail?.[0] ?? '서비스를 준비하지 못했습니다'`
        let message = if !js_json::nullish(check.prop("error")) {
            check.prop("error").cloned()
        } else {
            let first = match check.prop("logTail") {
                Some(JsValue::Arr(lines)) => lines.first().cloned(),
                // 문자열의 [0]은 첫 UTF-16 코드 단위다(쌍의 앞 절반이면 짝 없는 서로게이트라 경계에서 U+FFFD가 된다). 객체는 "0" 속성
                Some(JsValue::Str(text)) => text.chars().next().map(|c| JsValue::Str(if c.len_utf16() == 1 { c.to_string() } else { "\u{FFFD}".to_owned() })),
                Some(JsValue::Obj(o)) => o.get("0").cloned(),
                _ => None,
            };
            if js_json::nullish(first.as_ref()) {
                Some(JsValue::str("서비스를 준비하지 못했습니다"))
            } else {
                first
            }
        };
        signatures.push(signature(Some(JsValue::str("run")), check.prop("service").cloned(), normalize_value(message.as_ref())?, None));
    }
    for check in &iterate(report.prop("contracts"), "contracts")? {
        let check = deref(check, "계약 확인")?;
        let mut breaking = Vec::new();
        for change in array_of(check.prop("changes"), "changes")? {
            let change = deref(change, "계약 변경")?;
            if truthy(change.prop("breaking")) {
                breaking.push(change);
            }
        }
        let error = check.prop("error");
        // 오류도 없고 호환을 깨는 변경도 없으면 통과한 계약 확인이다
        if !truthy(error) && breaking.is_empty() {
            continue;
        }
        let message = if js_json::nullish(error) {
            let parts: Vec<String> = breaking
                .iter()
                .map(|change| {
                    let detail = if truthy(change.prop("detail")) { format!(": {}", template(change.prop("detail"))) } else { String::new() };
                    format!("{} {}{}", template(change.prop("kind")), template(change.prop("target")), detail)
                })
                .collect();
            normalize_message(&parts.join("; "))
        } else {
            normalize_value(error)?
        };
        signatures.push(signature(Some(JsValue::str("contract_check")), check.prop("service").cloned(), message, None));
    }
    // 샌드박스에 바뀐 파일이 반영되지 않으면 게이트는 여기서 멈춘다. `'error' in report.sync`는 객체가 아니면 던진다
    match report.prop("sync") {
        Some(JsValue::Obj(sync)) => {
            if sync.contains_key("error") {
                signatures.push(signature(Some(JsValue::str("sync")), None, normalize_value(sync.get("error"))?, None));
            }
        }
        Some(JsValue::Arr(_)) => {}
        _ => return Err("sync가 객체가 아닙니다".to_owned()),
    }
    for leak in &iterate(report.prop("secretLeaks"), "secretLeaks")? {
        let leak = deref(leak, "시크릿 검출")?;
        let secrets = array_of(leak.prop("secrets"), "secrets")?;
        // 시크릿 값은 넣지 않는다. 파일 경로와 시크릿 이름만 남긴다
        let names: Vec<String> = secrets.iter().map(|s| join_elem(Some(s))).collect();
        let text = format!("{}: {}", template(leak.prop("file")), names.join(", "));
        let file = leak.prop("file").cloned().unwrap_or(JsValue::Null);
        signatures.push(signature(Some(JsValue::str("secret_leak")), None, normalize_message(&text), Some(JsValue::Arr(vec![file]))));
    }
    Ok(signatures)
}

/// 실패한 워크플로 확인(브라우저·테스트·리뷰) 하나를 서명으로: `normalizeMessage(check.detail ?? check.name)`
pub fn signature_from_check(check: &JsValue) -> Result<JsValue, String> {
    let check = deref(check, "워크플로 확인")?;
    let source = if js_json::nullish(check.prop("detail")) { check.prop("name") } else { check.prop("detail") };
    Ok(signature(check.prop("stage").cloned(), None, normalize_value(source)?, None))
}

/// `[${stage} ${service}]`(service가 참일 때) 또는 `[${stage}]`, 그 뒤에 ` ${message}`
fn format_signature(sig: &JsValue) -> String {
    let service = sig.prop("service");
    let place = if truthy(service) { format!("{} {}", template(sig.prop("stage")), template(service)) } else { template(sig.prop("stage")) };
    format!("[{}] {}", place, template(sig.prop("message")))
}

fn to_note_input(sig: &JsValue) -> JsValue {
    let refs = match sig.prop("files") {
        Some(files) if files.truthy() => files.clone(),
        _ => JsValue::Arr(Vec::new()),
    };
    js_json::object(vec![("kind", Some(JsValue::str("failure"))), ("body", Some(JsValue::Str(format_signature(sig)))), ("refs", Some(refs))])
}

/// 검증 보고서와 워크플로 확인에서 failure 메모 입력을 만든다. 실패 서명만 넘긴다
pub fn failure_notes_from_report(report: &JsValue, checks: &JsValue) -> Result<Vec<JsValue>, String> {
    let mut signatures = signatures_from_report(report)?;
    for check in array_of(Some(checks), "checks")? {
        let check = deref(check, "워크플로 확인")?;
        if !truthy(check.prop("ok")) {
            signatures.push(signature_from_check(check)?);
        }
    }
    Ok(signatures.iter().map(to_note_input).collect())
}

/// 세션 기록에서 failure 메모 입력을 만든다: 검증 결과와 실패한 워크플로 확인만 본다
pub fn failure_notes_from_events(events: &JsValue) -> Result<Vec<JsValue>, String> {
    let mut signatures = Vec::new();
    for event in &iterate(Some(events), "events")? {
        let event = deref(event, "이벤트")?;
        let Some(agent) = event.prop("event").filter(|a| a.truthy()) else { continue };
        let kind = agent.prop("type").and_then(JsValue::as_str);
        if kind == Some("verify_result") && truthy(agent.prop("report")) {
            signatures.extend(signatures_from_report(agent.prop("report").unwrap_or(&JsValue::Null))?);
        } else if kind == Some("workflow_check") && truthy(agent.prop("check")) && !truthy(agent.prop("check").and_then(|c| c.prop("ok"))) {
            signatures.push(signature_from_check(agent.prop("check").unwrap_or(&JsValue::Null))?);
        }
    }
    Ok(signatures.iter().map(to_note_input).collect())
}

/// 메모 본문의 UTF-8 바이트 수(`Buffer.byteLength(body, 'utf8')`). 짝 없는 서로게이트는 경계에서 U+FFFD(3바이트)가 되어
/// `Buffer.byteLength`가 세는 3바이트와 같다
pub fn note_bytes(body: &str) -> usize {
    body.len()
}

/// 누가 누구의 메모를 읽을 수 있는가. star는 레인끼리 직접 보지 못하게 하고(허브·자기 것·플랫폼만), hierarchical은 같은 그룹까지,
/// mesh는 모든 레인을 연다. 모르는 topology는 star로 읽는다(옛 구현의 마지막 줄 `return false`)
pub fn can_read(topology: &str, reader_lane: &str, reader_group: Option<&str>, note_by: &str, note_lane: &str, note_group: Option<&str>, hub: &str) -> bool {
    // 조정자(허브)는 중계를 위해 모든 메모를 읽는다
    if reader_lane == hub {
        return true;
    }
    // 플랫폼(검증기)이 쓴 메모는 topology와 무관하게 모든 레인이 읽는다
    if note_by == "platform" {
        return true;
    }
    // 자기 메모는 항상 읽는다
    if note_lane == reader_lane {
        return true;
    }
    if topology == "mesh" {
        return true;
    }
    // 허브가 쓴 메모는 star·hierarchical 모두에서 읽는다
    if note_lane == hub {
        return true;
    }
    if topology == "hierarchical" {
        return reader_group.is_some() && note_group == reader_group;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 정규화는_해시와_숫자를_지운다() {
        assert_eq!(normalize_message("  cannot find symbol at line 42 \nnext"), "cannot find symbol at line N");
        assert_eq!(normalize_message("commit deadbeef failed"), "commit H failed");
        assert_eq!(normalize_message("feedback 1234567"), "feedback H");
        assert_eq!(normalize_message("x 123456"), "x N");
        assert_eq!(normalize_message("abcdef0g"), "abcdefNg");
        assert_eq!(normalize_message("ab_cdef0123"), "ab_cdefN");
    }

    #[test]
    fn 정규화는_이백_코드_단위로_자른다() {
        let long = "가".repeat(250);
        assert_eq!(js::utf16_len(&normalize_message(&long)), 200);
        // 서로게이트 쌍이 경계에 걸리면 U+FFFD(Node 경계 규칙)
        let pair = format!("{}😀", "x".repeat(199));
        assert_eq!(normalize_message(&pair), format!("{}\u{FFFD}", "x".repeat(199)));
    }

    #[test]
    fn 읽기_권한() {
        assert!(can_read("star", "hub", None, "model", "a", None, "hub"));
        assert!(!can_read("star", "a", None, "model", "b", None, "hub"));
        assert!(can_read("hierarchical", "a", Some("g"), "model", "b", Some("g"), "hub"));
        assert!(!can_read("hierarchical", "a", None, "model", "b", None, "hub"));
        assert!(can_read("mesh", "a", None, "model", "b", None, "hub"));
    }
}
