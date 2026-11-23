//! 세션 터미널의 OTLP/HTTP JSON 텔레메트리 본문 해석(ADR-216, 4f B5b). 옛 구현은 `apps/studio/lib/server/terminal-telemetry.ts`의 `apiRequestsFromOtlp`였다
//! (그 파일은 아직 TS에 있고 시험이 기대값 JSON과 견준다; 옛 사본 `session-terminal-telemetry-legacy.ts`는 #1347에서 지웠다). Node를 모른다. 본문 글(JSON)과 받은 시각을 받아 **모델 호출 목록**을 돌려주는 순수 함수다.
//! 서브에이전트 신호(`agentSignalsFromOtlp`)는 화면의 에이전트 내역에만 쓰고 한도에 닿지 않아 TS에 남긴다.
//!
//! **막는 검사의 입력이다. 덜 세는 쪽이 여는 쪽이다.** 모델 호출 수는 턴 상한을, 토큰은 토큰 한도를 정한다. 그래서 모르는 값은 센다:
//! - 이름이 `api_request`인 레코드는 값이 이상해도 **모델 호출 하나로 센다**(옛 판정은 필수 속성이 하나 빠지거나 값이 이상하면 레코드를 통째로 버렸고, 그 호출은 턴에서도 빠졌다).
//!   토큰을 알 수 없는 호출은 `tokens_complete = false`로 돌려준다. 읽을 수 있는 토큰은 더하고(내려잡은 값이다) 나머지는 0이지만, 부른 쪽이 "토큰 한도를 확인할 수 없음"으로 다룬다
//! - 모델 이름을 모르면 `unknown`이라 부른다
//! - 건너뛰는 자리는 세어서 돌려준다(`defects`): 본문이 읽히지 않거나, `resourceLogs`·`scopeLogs`·`logRecords`가 배열이 아니거나, 레코드가 객체가 아니다.
//!   그 안에 모델 호출이 있었는지 알 수 없으므로 부른 쪽이 "확인할 수 없음"으로 다룬다. 없는 칸(`resourceLogs`가 없는 빈 내보내기)은 결함이 아니다
//! - 항목 수 상한(1,000)은 없다. 크기는 관문이 읽기 전에 거는 본문 상한(4MiB)이 막는다. 옛 상한은 넘친 호출을 말없이 버렸다
//! - 시각: CLI가 준 시각이 받은 시각의 앞뒤 `CLOCK_WINDOW_MS` 안이면 그대로 쓴다. 밖이거나 읽을 수 없으면 받은 시각을 쓴다(`TimeSource::ReceivedOffClock`·`Received`).
//!   옛 판정은 이상한 시각을 그대로 써서 어느 실행의 창에도 들지 않았고, 그 호출은 턴에서 빠졌다
//!
//! 의도한 차이(옛 코드와 다른 칸. 나머지는 입력 전체가 같다. 모두 닫는 쪽이다):
//! - 위의 네 가지(모양이 틀린 `api_request`를 센다, 상한 없음, 이상한 시각을 받은 시각으로, 읽지 못한 칸을 센다)
//! - Codex의 `response.completed`는 옛 규칙 그대로다(모양이 틀리면 버린다). Codex는 실험이라 지원 범위 밖이다(ADR-200). 시각 규칙만 공통이다
//! - 짝 없는 서로게이트 이스케이프는 U+FFFD로 읽는다(`js_json`). 깊이 2000을 넘는 본문은 읽지 않는다(결함으로 센다)

use bstudio_guard::js::{self, truncate_utf16};
use bstudio_guard::js_json::{self, JsObject, JsValue};
use std::collections::HashMap;

/// 값의 상한. 이보다 큰 숫자는 바깥에서 온 잘못된 값으로 본다(토큰·시간·비용 어느 것도 10억을 넘지 않는다)
pub const MAX_ATTRIBUTE: f64 = 1_000_000_000.0;
/// 이름·도구·대화 id 같은 짧은 글의 상한(UTF-16 코드 단위)
pub const MAX_LABEL: usize = 120;
/// CLI가 준 시각을 믿는 범위: 받은 시각의 앞뒤 이만큼(ms). 한도를 늦게 걸리게 하는 시각을 받은 시각으로 바꿔 막는다.
/// 실제 CLI는 1초마다 내보내므로(`OTEL_LOGS_EXPORT_INTERVAL`) 정상 호출은 늘 이 안이다
pub const CLOCK_WINDOW_MS: i64 = 60_000;
/// 모델 이름을 알 수 없는 호출의 이름
pub const UNKNOWN_MODEL: &str = "unknown";

const API_REQUEST_EVENTS: [&str; 2] = ["api_request", "claude_code.api_request"];

/// 호출 시각을 어디서 얻었나
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeSource {
    /// 레코드의 `timeUnixNano`
    Cli,
    /// 레코드의 `observedTimeUnixNano`(`timeUnixNano`가 0이거나 없다. Codex가 0을 보낸다)
    Observed,
    /// 레코드에 쓸 시각이 없어 받은 시각을 썼다
    Received,
    /// 레코드의 시각이 받은 시각의 앞뒤 `CLOCK_WINDOW_MS` 밖이거나 너무 커서 받은 시각을 썼다
    ReceivedOffClock,
}

impl TimeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Observed => "observed",
            Self::Received => "received",
            Self::ReceivedOffClock => "received_off_clock",
        }
    }
}

/// 모델 호출 하나
#[derive(Clone, Debug, PartialEq)]
pub struct ModelCall {
    /// 호출 시각(ms). 믿을 수 없는 시각은 받은 시각으로 바뀌어 있다
    pub at_ms: i64,
    pub time_source: TimeSource,
    pub model: String,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    /// 네 토큰 수를 모두 읽었다. 아니면 읽은 것만 더해졌고 나머지는 0이다
    pub tokens_complete: bool,
    pub request_id: Option<String>,
    pub prompt_id: Option<String>,
    pub session_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<f64>,
    pub agent: Option<String>,
    pub conversation_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Telemetry {
    pub calls: Vec<ModelCall>,
    /// 읽지 못하고 건너뛴 자리의 수(그 안의 모델 호출은 알 수 없다)
    pub defects: u32,
}

/// 본문(JSON 글)에서 모델 호출을 꺼낸다. `now_ms`는 받은 시각이다
pub fn parse_model_calls(body: &str, now_ms: i64) -> Telemetry {
    let mut out = Telemetry::default();
    let Ok(value) = js_json::parse(body) else {
        out.defects = 1;
        return out;
    };
    let JsValue::Obj(root) = &value else {
        out.defects = 1;
        return out;
    };
    let Some(resource_logs) = root.get("resourceLogs") else { return out };
    let JsValue::Arr(resource_logs) = resource_logs else {
        out.defects = 1;
        return out;
    };
    for resource_log in resource_logs {
        let JsValue::Obj(resource_log) = resource_log else {
            out.defects += 1;
            continue;
        };
        let Some(scope_logs) = resource_log.get("scopeLogs") else { continue };
        let JsValue::Arr(scope_logs) = scope_logs else {
            out.defects += 1;
            continue;
        };
        for scope_log in scope_logs {
            let JsValue::Obj(scope_log) = scope_log else {
                out.defects += 1;
                continue;
            };
            let Some(log_records) = scope_log.get("logRecords") else { continue };
            let JsValue::Arr(log_records) = log_records else {
                out.defects += 1;
                continue;
            };
            for record in log_records {
                let JsValue::Obj(record) = record else {
                    out.defects += 1;
                    continue;
                };
                if let Some(call) = call_from_record(record, now_ms) {
                    out.calls.push(call);
                }
            }
        }
    }
    out
}

/// 속성 이름 → 값. 같은 이름이 또 나오면 뒤의 것이 이긴다. 값이 없는 속성은 `None`이다(있기는 하다)
struct Attributes<'a> {
    map: HashMap<&'a str, Option<&'a JsValue>>,
}

impl<'a> Attributes<'a> {
    fn of(record: &'a JsObject) -> Self {
        let mut map = HashMap::new();
        if let Some(JsValue::Arr(entries)) = record.get("attributes") {
            for entry in entries {
                let JsValue::Obj(attribute) = entry else { continue };
                let Some(JsValue::Str(key)) = attribute.get("key") else { continue };
                map.insert(key.as_str(), attribute.get("value"));
            }
        }
        Self { map }
    }

    /// 속성의 값. 없으면 `None`
    fn get(&self, key: &str) -> Option<&'a JsValue> {
        self.map.get(key).copied().flatten()
    }

    fn has(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    fn string(&self, key: &str) -> Option<&'a str> {
        string_value(self.get(key))
    }
}

fn call_from_record(record: &JsObject, now_ms: i64) -> Option<ModelCall> {
    let attributes = Attributes::of(record);
    if is_codex_completed(&attributes) {
        return codex_call(record, &attributes, now_ms);
    }
    if !is_api_request(record, &attributes) {
        return None;
    }
    Some(claude_call(record, &attributes, now_ms))
}

/// 이름이 `api_request`인 레코드는 늘 모델 호출 하나다. 읽을 수 없는 토큰은 0으로 두고 `tokens_complete`를 내린다
fn claude_call(record: &JsObject, attributes: &Attributes<'_>, now_ms: i64) -> ModelCall {
    let tokens = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"].map(|key| numeric(attributes.get(key)));
    let tokens_complete = tokens.iter().all(|token| matches!(token, Numeric::Ok(_)));
    let (at_ms, time_source) = event_time(record, now_ms);
    let cost = optional_number(attributes.get("cost_usd"));
    let duration = optional_number(attributes.get("duration_ms"));
    ModelCall {
        at_ms,
        time_source,
        model: attributes.string("model").filter(|model| !model.is_empty()).unwrap_or(UNKNOWN_MODEL).to_owned(),
        input_tokens: tokens[0].value(),
        output_tokens: tokens[1].value(),
        cache_read_tokens: tokens[2].value(),
        cache_write_tokens: tokens[3].value(),
        tokens_complete,
        request_id: non_empty(attributes.string("request_id")),
        prompt_id: non_empty(attributes.string("prompt.id")),
        session_id: non_empty(attributes.string("session.id")),
        cost_usd: cost,
        duration_ms: duration,
        agent: claude_agent_of(attributes),
        conversation_id: None,
    }
}

/// codex가 응답 하나를 다 받은 기록인가. 같은 응답에 토큰 수가 없는 기록이 먼저 오므로, 토큰 수가 있는 것만 받는다
fn is_codex_completed(attributes: &Attributes<'_>) -> bool {
    attributes.string("event.name") == Some("codex.sse_event") && attributes.string("event.kind") == Some("response.completed") && attributes.has("input_token_count")
}

/// codex의 응답 하나(옛 `codexUsageFromRecord`와 같다, 실험). 입력 토큰은 캐시 읽기를 포함하므로 빼서 claude와 같은 뜻(캐시 밖 입력)으로 맞춘다.
/// 모양이 틀리면 버린다(Codex는 지원 범위 밖이라 옛 규칙을 그대로 둔다)
fn codex_call(record: &JsObject, attributes: &Attributes<'_>, now_ms: i64) -> Option<ModelCall> {
    let model = attributes.string("model").filter(|model| !model.is_empty())?;
    let input = numeric(attributes.get("input_token_count"));
    let output = numeric(attributes.get("output_token_count"));
    let cached = numeric(attributes.get("cached_token_count"));
    let cache_write = numeric(attributes.get("cache_write_token_count"));
    let duration = numeric(attributes.get("duration_ms"));
    if matches!(input, Numeric::Absent) || matches!(output, Numeric::Absent) || matches!(cached, Numeric::Absent) {
        return None;
    }
    if [input, output, cached, cache_write, duration].iter().any(|entry| matches!(entry, Numeric::Bad)) {
        return None;
    }
    // 캐시 읽기가 입력보다 많으면 두 값 중 하나가 틀렸다. 어느 쪽인지 모르니 버린다
    if cached.value() > input.value() {
        return None;
    }
    let conversation = attributes.string("conversation.id").filter(|text| !text.is_empty());
    let stamp = attributes.string("event.timestamp").filter(|text| !text.is_empty());
    let (at_ms, time_source) = event_time(record, now_ms);
    Some(ModelCall {
        at_ms,
        time_source,
        model: model.to_owned(),
        input_tokens: input.value() - cached.value(),
        output_tokens: output.value(),
        cache_read_tokens: cached.value(),
        cache_write_tokens: cache_write.value(),
        tokens_complete: true,
        request_id: conversation.zip(stamp).map(|(conversation, stamp)| format!("{conversation}:{stamp}")),
        prompt_id: None,
        session_id: conversation.map(str::to_owned),
        cost_usd: None,
        duration_ms: match duration {
            Numeric::Ok(value) => Some(value),
            _ => None,
        },
        agent: None,
        conversation_id: conversation.and_then(|text| short_label(Some(text))),
    })
}

/// 이벤트 이름이 `api_request`인지. 속성과 본문 두 자리를 모두 본다
fn is_api_request(record: &JsObject, attributes: &Attributes<'_>) -> bool {
    if attributes.string("event.name").is_some_and(|name| API_REQUEST_EVENTS.contains(&name)) {
        return true;
    }
    string_value(record.get("body")).is_some_and(|name| API_REQUEST_EVENTS.contains(&name))
}

/// Claude 요청을 낸 서브에이전트 종류. `agent.name`이 먼저, 없으면 `query_source`의 `agent:<출처>:<이름>`
fn claude_agent_of(attributes: &Attributes<'_>) -> Option<String> {
    if let Some(named) = short_label(attributes.string("agent.name")) {
        return Some(named);
    }
    let source = attributes.string("query_source").filter(|source| source.starts_with("agent:"))?;
    short_label(Some(&source.split(':').skip(2).collect::<Vec<_>>().join(":")))
}

/// 짧은 글 속성. 비었으면 없다. 길면 자른다
pub(crate) fn short_label(text: Option<&str>) -> Option<String> {
    let trimmed = js::trim(text?);
    if trimmed.is_empty() {
        None
    } else {
        Some(truncate_utf16(trimmed, MAX_LABEL))
    }
}

fn non_empty(text: Option<&str>) -> Option<String> {
    text.filter(|text| !text.is_empty()).map(str::to_owned)
}

/// OTLP AnyValue의 `stringValue`. 그 꼴이 아니면 없다
fn string_value(value: Option<&JsValue>) -> Option<&str> {
    match value?.prop("stringValue")? {
        JsValue::Str(text) => Some(text),
        _ => None,
    }
}

/// 숫자 속성. 없으면 `Absent`, 값이 이상하면(숫자로 읽을 수 없음·음수·10억 초과) `Bad`
#[derive(Clone, Copy, Debug, PartialEq)]
enum Numeric {
    Absent,
    Bad,
    Ok(f64),
}

impl Numeric {
    fn value(self) -> f64 {
        match self {
            Self::Ok(value) => value,
            _ => 0.0,
        }
    }
}

fn numeric(raw: Option<&JsValue>) -> Numeric {
    let Some(raw) = raw else { return Numeric::Absent };
    match any_value_to_number(raw) {
        Some(number) if number.is_finite() && (0.0..=MAX_ATTRIBUTE).contains(&number) => Numeric::Ok(number),
        _ => Numeric::Bad,
    }
}

/// 값이 이상해도 호출은 센다. 비용·시간은 읽은 것만 싣는다
fn optional_number(raw: Option<&JsValue>) -> Option<f64> {
    match numeric(raw) {
        Numeric::Ok(value) => Some(value),
        _ => None,
    }
}

/// `intValue`(문자열일 수 있음)·`doubleValue`·숫자 꼴 `stringValue`를 숫자로 바꾼다. 아니면 없다(옛 `anyValueToNumber`와 같다)
fn any_value_to_number(value: &JsValue) -> Option<f64> {
    if let JsValue::Num(number) = value {
        return number.is_finite().then_some(*number);
    }
    let JsValue::Obj(record) = value else { return None };
    for key in ["intValue", "doubleValue"] {
        match record.get(key) {
            Some(JsValue::Num(number)) => return number.is_finite().then_some(*number),
            Some(JsValue::Str(raw)) => {
                let trimmed = js::trim(raw);
                if !trimmed.is_empty() {
                    let parsed = js::to_number(trimmed);
                    if parsed.is_finite() {
                        return Some(parsed);
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(JsValue::Str(text)) = record.get("stringValue") {
        let text = js::trim(text);
        let parsed = js::to_number(text);
        if !text.is_empty() && parsed.is_finite() {
            return Some(parsed);
        }
    }
    None
}

/// 로그 레코드의 시각. `timeUnixNano` → `observedTimeUnixNano` → 받은 시각. 0은 값이 없다는 뜻이다(codex가 0을 보낸다).
/// 읽은 시각이 받은 시각의 앞뒤 `CLOCK_WINDOW_MS` 밖이면 받은 시각을 쓴다
fn event_time(record: &JsObject, now_ms: i64) -> (i64, TimeSource) {
    for (key, source) in [("timeUnixNano", TimeSource::Cli), ("observedTimeUnixNano", TimeSource::Observed)] {
        let Some(raw) = record.get(key) else { continue };
        let millis = match raw {
            JsValue::Str(text) if text == "0" => continue,
            JsValue::Num(number) if *number == 0.0 => continue,
            JsValue::Str(text) if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) => {
                text.parse::<u128>().ok().map(|nanos| nanos / 1_000_000).and_then(|millis| i64::try_from(millis).ok())
            }
            JsValue::Num(number) if number.is_finite() && *number >= 0.0 => {
                let millis = (number / 1_000_000.0).floor();
                (millis < 9.0e18).then_some(millis as i64)
            }
            _ => continue,
        };
        return match millis {
            Some(millis) if (now_ms - CLOCK_WINDOW_MS..=now_ms + CLOCK_WINDOW_MS).contains(&millis) => (millis, source),
            _ => (now_ms, TimeSource::ReceivedOffClock),
        };
    }
    (now_ms, TimeSource::Received)
}

#[cfg(test)]
#[path = "telemetry_tests.rs"]
mod tests;
