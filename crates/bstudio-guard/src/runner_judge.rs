//! 로컬 CLI 러너의 판정과 사용량 계산(ADR-191 3단계 3ac). 옮기기 전 TS는 `packages/agent/src/claude-code-runner.ts`의 `describeResultFailure`·
//! `mcpSetupFailure`·`noResultMessage`·`isTransientNetworkFailure`·`resolveCompactWindow`와 사용량 도우미(`setUsage`·`addUsageInto`·`usageByModelOf`·
//! `mergeUsageByModel`·`apiDurationOf`)였다. 입력은 CLI가 준 JSON을 `JSON.parse`한 값이라 모양이 어긋날 수 있고, JS는 그것을 조용히 읽거나 던졌다.
//!
//! 호출부마다 막는 쪽인지 여는 쪽인지가 다르다.
//! - 닫는 쪽("실패"로 이어진다): `describe_result_failure`, `mcp_setup_failure`. 모르는 모양은 실패로 본다. 옛 "실패"가 새 "성공(`None`)"이 되면 안 된다
//! - 글만 만든다: `no_result_message`(표시용이라 짝 없는 서로게이트는 U+FFFD가 되어도 된다)
//! - 다시 시도하는 쪽: `is_transient_network_failure`(맞으면 같은 세션을 이어받아 재시도한다. 통과·허용이 아니다)
//! - 설정 읽기: `resolve_compact_window`
//! - 계산: 사용량. 판정이 아니라 합산이다
//!
//! 의도한 차이:
//! - `mcp_server_errors`의 항목은 이름이 없거나 문자열이 아니면(`null`·숫자) 이 서버의 오류로 센다(옛 TS는 `name`이 `undefined`일 때만 셌고 `null`은 다른 서버의 오류로 보고 버려
//!   연결 실패를 "성공"으로 읽을 수 있었다 — 트러블슈팅 179)
//! - 목록이 배열이 아니거나 항목이 `null`이면 옛 TS는 던졌다(`.filter`·`.find`·`null.name`). 여기서는 "연결하지 못했다"는 실패를 돌려준다(던지지 않고 닫는다)
//! - `describe_result_failure`의 `errors`가 비어 있지 않은 문자열이면 옛 TS는 `.join`에서 던졌다. 여기서는 오류 목록 없이 같은 실패를 돌려준다
//! - 사용량의 토큰 수가 숫자가 아닌 값(문자열 등)이면 옛 TS는 문자열을 이어 붙였다(`0 + "5"`는 `"05"`). 여기서는 `Number(값)`으로 읽는다
//! - `modelUsage`가 문자열이면 옛 TS는 글자 하나하나를 모델로 셌다(키 `"0"`·`"1"`). 여기서는 모델이 없는 것으로 본다
//! - 모델 이름이 `__proto__`이면 옛 TS는 객체의 프로토타입을 바꿔 그 사용량이 사라졌다. 여기서는 보통 키로 센다(더 센다)

use crate::js;
use crate::js_json::{self, JsObject, JsValue};

pub const DEFAULT_COMPACT_WINDOW: u64 = 200_000;
pub const MIN_COMPACT_WINDOW: u64 = 50_000;
const COMPACT_WINDOW_ENV: &str = "B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW";
/// `Number.MAX_SAFE_INTEGER`
const MAX_SAFE_INTEGER: u128 = 9_007_199_254_740_991;

/// `{ window, ignored? }`. `window`가 `None`이면 CLI 기본 동작을 쓴다
pub struct CompactWindow {
    pub window: Option<u64>,
    pub ignored: Option<String>,
}

/// `B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW` 값을 해석한다. 비면 기본값, `0`·`off`(대소문자 무시)면 끄기, 숫자가 아니거나 최소 창 미만이면 기본값과 이유
pub fn resolve_compact_window(raw: Option<&str>) -> CompactWindow {
    let text = js::trim(raw.unwrap_or(""));
    if text.is_empty() {
        return CompactWindow { window: Some(DEFAULT_COMPACT_WINDOW), ignored: None };
    }
    if text == "0" || text.eq_ignore_ascii_case("off") {
        return CompactWindow { window: None, ignored: None };
    }
    // JS의 `/^\d+$/`는 ASCII 숫자만이다. 앞의 0은 `Number`가 무시한다. 안전한 정수(2^53-1 이하)가 아니면 쓰지 않는다
    if text.bytes().all(|b| b.is_ascii_digit()) {
        let digits = text.trim_start_matches('0');
        let value = if digits.is_empty() { Some(0) } else { digits.parse::<u128>().ok() };
        if let Some(value) = value.filter(|value| (u128::from(MIN_COMPACT_WINDOW)..=MAX_SAFE_INTEGER).contains(value)) {
            return CompactWindow { window: Some(value as u64), ignored: None };
        }
    }
    CompactWindow {
        window: Some(DEFAULT_COMPACT_WINDOW),
        ignored: Some(format!("{COMPACT_WINDOW_ENV}={text} 값을 무시하고 기본값 200,000 토큰을 씁니다 (50,000 이상의 정수, 끄려면 0 또는 off)")),
    }
}

/// 메시지에 일시적 네트워크 오류의 근거가 있는 패턴이 있는가. JS `/.../i`는 유니코드 플래그 없이 ASCII만 대소문자를 접는다(`ſ`는 `s`가 아니다)
pub fn is_transient_network_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    const LITERALS: [&str; 6] = ["enotfound", "econnreset", "etimedout", "eai_again", "can't reach the api server", "overloaded_error"];
    if LITERALS.iter().any(|literal| lower.contains(literal)) {
        return true;
    }
    // `\boverloaded\b`: 앞뒤가 단어 글자(ASCII 영숫자·`_`)가 아니어야 한다
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(at) = lower[from..].find("overloaded") {
        let start = from + at;
        let end = start + "overloaded".len();
        if (start == 0 || !word(bytes[start - 1])) && (end == bytes.len() || !word(bytes[end])) {
            return true;
        }
        from = start + 1;
    }
    false
}

fn text_of(value: Option<&JsValue>) -> String {
    match value {
        None | Some(JsValue::Null) => String::new(),
        Some(v) => v.to_js_string(),
    }
}

/// result 메시지가 실패이면 그 설명(닫는 쪽). 성공이어야만 `None`이다: `subtype`이 `success`이고 `is_error`가 거짓이고 `stop_reason`이 `refusal`이 아닐 때
pub fn describe_result_failure(message: &JsValue) -> Option<String> {
    let subtype = message.prop("subtype");
    match subtype {
        Some(JsValue::Str(s)) if s == "success" => {
            if message.prop("is_error").is_some_and(JsValue::truthy) {
                return Some(format!("모델 호출이 실패했습니다: {}", text_of(message.prop("result"))));
            }
            if matches!(message.prop("stop_reason"), Some(JsValue::Str(s)) if s == "refusal") {
                return Some("모델이 요청을 거절했습니다".to_owned());
            }
            None
        }
        Some(JsValue::Str(s)) if s == "error_max_turns" => Some("Claude Code의 최대 턴 수를 넘었습니다".to_owned()),
        Some(JsValue::Str(s)) if s == "error_max_budget_usd" => Some("Claude Code의 비용 한도를 넘었습니다".to_owned()),
        _ => {
            let detail = match message.prop("errors") {
                Some(JsValue::Arr(items)) if !items.is_empty() => {
                    let joined = items.iter().map(|item| text_of(Some(item))).collect::<Vec<_>>().join("; ");
                    format!(": {joined}")
                }
                _ => String::new(),
            };
            Some(format!("Claude Code 실행 중 오류가 났습니다{detail}"))
        }
    }
}

/// 프로세스가 결과 없이 끝났다는 실패 메시지. `exit`가 없으면 `has_exit`가 거짓이다
pub fn no_result_message(has_exit: bool, error_message: Option<&str>, signal: Option<&str>, code: Option<f64>, stderr: &str) -> String {
    if !has_exit {
        return "Claude Code가 결과를 보내지 않고 종료됐습니다".to_owned();
    }
    let how = if let Some(message) = error_message {
        format!("실행하지 못함: {message}")
    } else if let Some(signal) = signal.filter(|s| !s.is_empty()) {
        format!("신호 {signal}")
    } else {
        format!("종료 코드 {}", code.map_or_else(|| "없음".to_owned(), js::number_to_string))
    };
    let lines: Vec<&str> = js::trim(stderr).split('\n').collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" / ");
    if tail.is_empty() {
        format!("Claude Code가 결과를 보내지 않고 종료됐습니다 ({how})")
    } else {
        format!("Claude Code가 결과를 보내지 않고 종료됐습니다 ({how}): {tail}")
    }
}

fn malformed_mcp(server: &str) -> String {
    format!("Claude Code가 {server} 도구 서버에 연결하지 못했습니다: 도구 서버 목록의 형식을 읽지 못했습니다")
}

/// init이 도구 서버를 연결하지 못했다고 알리면 그 설명(닫는 쪽). `connected`로 확인하고 오류가 없을 때만 `None`이다. 모르는 모양은 실패다
pub fn mcp_setup_failure(message: &JsValue, server: &str) -> Option<String> {
    // 이 서버의 오류: 이름이 이 서버이거나, 이름이 없거나 문자열이 아닌(어느 서버의 것인지 모르는) 항목
    let mut errors: Vec<&JsValue> = Vec::new();
    match message.prop("mcp_server_errors") {
        None | Some(JsValue::Null) => {}
        Some(JsValue::Arr(items)) => {
            for entry in items {
                match entry {
                    JsValue::Null => return Some(malformed_mcp(server)),
                    JsValue::Obj(_) => match entry.prop("name") {
                        Some(JsValue::Str(name)) if name != server => {}
                        _ => errors.push(entry),
                    },
                    // 숫자·문자열·불: `entry.name`은 undefined라 이 서버의 오류로 센다
                    other => errors.push(other),
                }
            }
        }
        Some(_) => return Some(malformed_mcp(server)),
    }
    let mut status: Option<&JsValue> = None;
    match message.prop("mcp_servers") {
        None | Some(JsValue::Null) => {}
        Some(JsValue::Arr(items)) => {
            for entry in items {
                match entry {
                    JsValue::Null => return Some(malformed_mcp(server)),
                    JsValue::Obj(_) => {
                        if matches!(entry.prop("name"), Some(JsValue::Str(name)) if name == server) {
                            status = entry.prop("status");
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
        Some(_) => return Some(malformed_mcp(server)),
    }
    // connected로 확인한 경우만 통과다. 목록에 없음·needs-auth·pending·disabled·모르는 값은 "모른다"이고 실패로 본다
    if errors.is_empty() && matches!(status, Some(JsValue::Str(s)) if s == "connected") {
        return None;
    }
    let first = errors.first().copied();
    let field = |key: &str| first.and_then(|entry| entry.prop(key)).filter(|v| !matches!(v, JsValue::Null));
    let detail: Option<JsValue> = field("message").or_else(|| field("type")).or(status.filter(|v| !matches!(v, JsValue::Null))).cloned();
    let detail = detail.unwrap_or_else(|| JsValue::str("목록에 없음"));
    let suffix = if detail.truthy() { format!(": {}", detail.to_js_string()) } else { String::new() };
    Some(format!("Claude Code가 {server} 도구 서버에 연결하지 못했습니다{suffix}"))
}

/// 토큰 수 네 묶음
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Usage {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Usage {
    pub fn add(self, other: Usage) -> Usage {
        Usage { input: self.input + other.input, output: self.output + other.output, cache_read: self.cache_read + other.cache_read, cache_write: self.cache_write + other.cache_write }
    }

    pub fn to_value(self) -> JsValue {
        js_json::object(vec![
            ("inputTokens", Some(JsValue::Num(self.input))),
            ("outputTokens", Some(JsValue::Num(self.output))),
            ("cacheReadTokens", Some(JsValue::Num(self.cache_read))),
            ("cacheWriteTokens", Some(JsValue::Num(self.cache_write))),
        ])
    }

    /// `AgentUsage` 모양의 값에서 읽는다(우리 코드가 만든 값이라 숫자다)
    pub fn from_agent(value: &JsValue) -> Usage {
        let read = |key: &str| value.prop(key).map_or(0.0, JsValue::to_number);
        Usage { input: read("inputTokens"), output: read("outputTokens"), cache_read: read("cacheReadTokens"), cache_write: read("cacheWriteTokens") }
    }
}

fn token(entry: &JsValue, key: &str) -> f64 {
    match entry.prop(key) {
        None | Some(JsValue::Null) => 0.0,
        Some(v) => v.to_number(),
    }
}

/// `modelUsage`의 항목 하나. `null`은 옛 TS가 던졌다(`null.inputTokens`)
fn entry_usage(entry: &JsValue) -> Result<Usage, String> {
    if matches!(entry, JsValue::Null) {
        return Err("modelUsage의 항목이 null입니다".to_owned());
    }
    Ok(Usage { input: token(entry, "inputTokens"), output: token(entry, "outputTokens"), cache_read: token(entry, "cacheReadInputTokens"), cache_write: token(entry, "cacheCreationInputTokens") })
}

/// `Object.entries(modelUsage ?? {})`. 객체는 JS 순서, 배열은 위치가 키, 그 밖의 값은 모델이 없다
fn model_entries(model_usage: Option<&JsValue>) -> Vec<(String, &JsValue)> {
    match model_usage {
        Some(JsValue::Obj(object)) => object.entries_js_order().into_iter().map(|(key, value)| (key.to_owned(), value)).collect(),
        Some(JsValue::Arr(items)) => items.iter().enumerate().map(|(index, value)| (index.to_string(), value)).collect(),
        _ => Vec::new(),
    }
}

/// result의 `modelUsage`(query 하나의 누적값) → 전체 합과 모델 이름별 사용량. 합은 JS `reduce`처럼 앞에서부터 더한다
pub fn usage_of(model_usage: Option<&JsValue>) -> Result<(Usage, Vec<(String, Usage)>), String> {
    let mut total = Usage::default();
    let mut by_model = Vec::new();
    for (key, entry) in model_entries(model_usage) {
        let usage = entry_usage(entry)?;
        total = total.add(usage);
        by_model.push((key, usage));
    }
    Ok((total, by_model))
}

pub fn by_model_value(by_model: &[(String, Usage)]) -> JsValue {
    let mut object = JsObject::new();
    for (model, usage) in by_model {
        object.set(model, usage.to_value());
    }
    JsValue::Obj(object)
}

/// 끝난 query들의 모델별 사용량(`base`)과 지금 query의 것(`query`)을 더해 실행 전체로 만든다. 순서는 `base`의 키, 그 뒤에 새 키
pub fn merge_usage_by_model(base: &JsValue, query: &JsValue) -> JsValue {
    let mut out = JsObject::new();
    let read = |value: &JsValue| -> Vec<(String, Usage)> {
        match value {
            JsValue::Obj(object) => object.entries_js_order().into_iter().map(|(key, entry)| (key.to_owned(), Usage::from_agent(entry))).collect(),
            _ => Vec::new(),
        }
    };
    for (model, usage) in read(base) {
        out.set(&model, usage.to_value());
    }
    for (model, usage) in read(query) {
        let merged = match out.get(&model) {
            Some(existing) => Usage::from_agent(existing).add(usage),
            None => Usage::default().add(usage),
        };
        out.set(&model, merged.to_value());
    }
    JsValue::Obj(out)
}

/// result가 알려 주는 API 호출 시간 합(ms). 유한한 0 이상의 수가 아니면 재지 않은 것으로 본다
pub fn api_duration_of(value: Option<&JsValue>) -> Option<f64> {
    match value {
        Some(JsValue::Num(n)) if n.is_finite() && *n >= 0.0 => Some(js::math_round(*n)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> JsValue {
        js_json::parse(text).unwrap()
    }

    #[test]
    fn 압축_창은_경계를_정확히_읽는다() {
        assert_eq!(resolve_compact_window(Some("50000")).window, Some(50_000));
        assert_eq!(resolve_compact_window(Some("49999")).window, Some(DEFAULT_COMPACT_WINDOW));
        assert!(resolve_compact_window(Some("49999")).ignored.is_some());
        assert_eq!(resolve_compact_window(Some("9007199254740991")).window, Some(9_007_199_254_740_991));
        assert_eq!(resolve_compact_window(Some("9007199254740992")).window, Some(DEFAULT_COMPACT_WINDOW));
        assert_eq!(resolve_compact_window(Some(" OFF ")).window, None);
        assert_eq!(resolve_compact_window(Some("0050000")).window, Some(50_000));
        assert_eq!(resolve_compact_window(Some("")).window, Some(DEFAULT_COMPACT_WINDOW));
        assert_eq!(resolve_compact_window(Some("５００００")).window, Some(DEFAULT_COMPACT_WINDOW));
    }

    #[test]
    fn 네트워크_오류는_근거_있는_패턴만() {
        assert!(is_transient_network_failure("getaddrinfo ENOTFOUND x"));
        assert!(is_transient_network_failure("the API is overloaded."));
        assert!(!is_transient_network_failure("overloadedx"));
        assert!(!is_transient_network_failure("_overloaded"));
        assert!(!is_transient_network_failure("401 unauthorized"));
        assert!(is_transient_network_failure("x overloaded_error"));
        assert!(!is_transient_network_failure("ſ"));
    }

    #[test]
    fn 결과는_성공일_때만_none이다() {
        assert_eq!(describe_result_failure(&json(r#"{"subtype":"success"}"#)), None);
        assert!(describe_result_failure(&json(r#"{"subtype":"success","is_error":true,"result":"x"}"#)).unwrap().contains(": x"));
        assert!(describe_result_failure(&json(r#"{"subtype":"success","is_error":1}"#)).is_some());
        assert!(describe_result_failure(&json(r#"{"subtype":"success","stop_reason":"refusal"}"#)).is_some());
        assert!(describe_result_failure(&json(r#"{}"#)).is_some());
        assert!(describe_result_failure(&json(r#"{"subtype":"Success"}"#)).is_some());
        assert!(describe_result_failure(&JsValue::Null).is_some());
    }

    #[test]
    fn 도구_서버는_connected와_오류_없음일_때만_통과() {
        let ok = json(r#"{"mcp_servers":[{"name":"b-studio","status":"connected"}]}"#);
        assert_eq!(mcp_setup_failure(&ok, "b-studio"), None);
        let null_name = json(r#"{"mcp_servers":[{"name":"b-studio","status":"connected"}],"mcp_server_errors":[{"name":null,"message":"x"}]}"#);
        assert!(mcp_setup_failure(&null_name, "b-studio").unwrap().ends_with(": x"));
        let other = json(r#"{"mcp_servers":[{"name":"b-studio","status":"connected"}],"mcp_server_errors":[{"name":"other","message":"x"}]}"#);
        assert_eq!(mcp_setup_failure(&other, "b-studio"), None);
        assert!(mcp_setup_failure(&json(r#"{"mcp_servers":[null]}"#), "b-studio").is_some());
        assert!(mcp_setup_failure(&json(r#"{"mcp_servers":"x"}"#), "b-studio").is_some());
    }

    #[test]
    fn 사용량은_앞에서부터_더한다() {
        let usage = json(r#"{"a":{"inputTokens":1,"outputTokens":2},"b":{"cacheReadInputTokens":3,"cacheCreationInputTokens":4}}"#);
        let (total, by_model) = usage_of(Some(&usage)).unwrap();
        assert_eq!(total, Usage { input: 1.0, output: 2.0, cache_read: 3.0, cache_write: 4.0 });
        assert_eq!(by_model.len(), 2);
        assert!(usage_of(Some(&json(r#"{"a":null}"#))).is_err());
        assert_eq!(usage_of(None).unwrap().0, Usage::default());
    }

    #[test]
    fn api_시간은_유한한_0_이상만() {
        assert_eq!(api_duration_of(Some(&JsValue::Num(1.5))), Some(2.0));
        assert_eq!(api_duration_of(Some(&JsValue::Num(-1.0))), None);
        assert_eq!(api_duration_of(Some(&JsValue::Num(f64::NAN))), None);
        assert_eq!(api_duration_of(Some(&JsValue::str("1"))), None);
    }

    #[test]
    fn 결과_없음_메시지() {
        assert_eq!(no_result_message(false, None, None, None, ""), "Claude Code가 결과를 보내지 않고 종료됐습니다");
        assert_eq!(no_result_message(true, None, None, Some(1.0), " a\nb\nc\nd \n"), "Claude Code가 결과를 보내지 않고 종료됐습니다 (종료 코드 1): b / c / d");
        assert!(no_result_message(true, None, Some("SIGTERM"), None, "").ends_with("(신호 SIGTERM)"));
    }
}
