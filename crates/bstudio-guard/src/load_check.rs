//! 부하 확인의 통과 판정(ADR-191 3단계 3e). `packages/agent/src/load-check.ts`에서 옮겼다.
//!
//! 러너가 잰 값으로 통과 여부를 정한다. 문제 목록이 비어야 통과다. 응답을 받지 못한 요청이 하나라도 있으면 실패이고, 응답 시간을 잴
//! 응답이 없어도 실패이며, 서버 오류(5xx)도 `allStatusIn`에 적지 않았으면 실패다. 비교 연산(`>`, `!==`, `>=`)과 합계·비율을 계산하는
//! 순서는 옛 TS와 같은 f64 연산이다(바꾸면 부동소수 결과가 달라진다).
//!
//! 의도한 차이: (1) 상태 코드·오류 이름을 글자로 늘어놓을 때 `localeCompare` 대신 UTF-16 순서로 정렬한다(판정이 아니라 설명 글자의 순서만
//! 다르고, ASCII 대문자·숫자 이름에서는 같다). (2) 수여야 하는 값(`count`·`p95`·합계에 들어가는 값·기준값)이 수가 아니면 던진다(JS는 글자를
//! 이어 붙이거나 형을 바꿔 견준다). (3) 이름에 짝 없는 서로게이트가 있으면 던진다.

use crate::js::{cmp_utf16, math_round, number_to_string, to_fixed};
use crate::js_json::{self, JsValue};
use crate::review_input::{join, js_max, js_min, opt_prop, prop, require_num, require_obj, template};

const LATENCY_KEYS: [(&str, &str); 4] = [("p50Ms", "p50"), ("p95Ms", "p95"), ("p99Ms", "p99"), ("maxMs", "max")];

pub struct LoadJudgement {
    pub note: String,
    pub problems: Vec<String>,
    pub evidence: Vec<String>,
}

impl LoadJudgement {
    pub fn to_value(&self) -> JsValue {
        let list = |v: &[String]| JsValue::Arr(v.iter().map(|s| JsValue::str(s.as_str())).collect());
        js_json::object(vec![
            ("note", Some(JsValue::str(self.note.as_str()))),
            ("problems", Some(list(&self.problems))),
            ("evidence", Some(list(&self.evidence))),
        ])
    }
}

/// studio.yaml의 선언을 러너에 넘길 요청으로 바꾼다. requests를 생략하면 연결마다 한 건이다
pub fn load_request_for(check: &JsValue) -> Result<JsValue, String> {
    let get = |key: &str| prop(Some(check), key);
    let expect = get("expect")?;
    let latency_of = prop(expect, "latencyOf")?.filter(|v| v.truthy());
    let concurrent = get("concurrent")?;
    let requests = get("requests")?.filter(|v| !matches!(v, JsValue::Null)).or(concurrent);
    Ok(js_json::object(vec![
        ("service", get("service")?.cloned()),
        ("method", get("method")?.cloned()),
        ("path", get("path")?.cloned()),
        ("headers", get("headers")?.filter(|v| v.truthy()).cloned()),
        ("body", get("body")?.cloned()),
        ("concurrent", concurrent.cloned()),
        ("requests", requests.cloned()),
        ("warmup", get("warmup")?.cloned()),
        ("latencyOf", latency_of.cloned()),
    ]))
}

fn ms(value: Option<&JsValue>) -> String {
    format!("{}ms", template(value))
}

/// `Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}:${n}`).join(', ')`
fn tally(counts: &[(&str, &JsValue)]) -> String {
    let mut sorted: Vec<&(&str, &JsValue)> = counts.iter().collect();
    sorted.sort_by(|a, b| cmp_utf16(a.0, b.0));
    sorted.iter().map(|(key, amount)| format!("{key}:{}", amount.to_js_string())).collect::<Vec<_>>().join(", ")
}

/// `Object.values(counts).reduce((sum, amount) => sum + amount, 0)`. 더하는 순서는 객체의 JS 순서다
fn total(counts: &[(&str, &JsValue)]) -> Result<f64, String> {
    let mut sum = 0.0;
    for (_, amount) in counts {
        sum += require_num(Some(amount), "응답 수")?;
    }
    Ok(sum)
}

/// 응답 시간 기준을 사람이 읽는 한 줄로. 예: "p95 200ms 이하, 409 응답만"
pub fn describe_load_expect(expect: &JsValue) -> Result<String, String> {
    if matches!(expect, JsValue::Null) {
        return Err("expect가 비어 있습니다".into());
    }
    let mut parts: Vec<String> = Vec::new();
    for (key, label) in LATENCY_KEYS {
        if let Some(limit) = expect.prop(key) {
            parts.push(format!("{label} {} 이하", ms(Some(limit))));
        }
    }
    if let Some(of) = expect.prop("latencyOf").filter(|v| v.truthy()) {
        let JsValue::Arr(of) = of else { return Err("latencyOf가 배열이 아닙니다".into()) };
        parts.push(format!("{} 응답만", join(of, "·")));
    }
    Ok(parts.join(", "))
}

fn latency_of_text(expect: &JsValue) -> Result<Option<String>, String> {
    match expect.prop("latencyOf").filter(|v| v.truthy()) {
        None => Ok(None),
        Some(JsValue::Arr(of)) => Ok(Some(join(of, "·"))),
        Some(_) => Err("latencyOf가 배열이 아닙니다".into()),
    }
}

/// 러너가 잰 값으로 통과 여부를 정한다. 원인을 추정하지 않고 숫자만 남긴다
pub fn judge_load(check: &JsValue, result: &JsValue) -> Result<LoadJudgement, String> {
    let expect = prop(Some(check), "expect")?.ok_or("expect가 없습니다")?;
    if matches!(expect, JsValue::Null) {
        return Err("expect가 비어 있습니다".into());
    }
    let latency = prop(Some(result), "latency")?.ok_or("latency가 없습니다")?;
    if matches!(latency, JsValue::Null) {
        return Err("latency가 비어 있습니다".into());
    }
    let latency_of = latency_of_text(expect)?;
    let scope = latency_of.as_ref().map_or(String::new(), |t| format!("{t} 응답 "));
    let sample = latency_of.as_ref().map_or("응답".to_owned(), |t| format!("{t} 응답"));

    // 상태 코드별·사유별 응답 수. 객체의 JS 순서(정수 꼴 키가 먼저)를 지킨다
    let errors = require_obj(prop(Some(result), "errors")?, "errors")?.entries_js_order();
    let statuses = require_obj(prop(Some(result), "statuses")?, "statuses")?.entries_js_order();
    let failed = total(&errors)?;
    let status_detail = {
        let text = tally(&statuses);
        if text.is_empty() { "없음".to_owned() } else { text }
    };
    let elapsed = require_num(prop(Some(result), "elapsedMs")?, "elapsedMs")?;
    let seconds = elapsed / 1000.0;
    let completed = require_num(prop(Some(result), "completed")?, "completed")?;
    let rate = if seconds > 0.0 { math_round(completed / seconds) } else { 0.0 };
    // 1초가 안 되는 측정을 "0.0초"로 적지 않는다
    let took = if seconds >= 1.0 { format!("{}초", to_fixed(seconds, 1)) } else { format!("{}ms", number_to_string(math_round(elapsed))) };

    let count = match latency.prop("count") {
        None => f64::NAN,
        Some(v) => require_num(Some(v), "latency.count")?,
    };
    let latency_line = if count > 0.0 {
        format!(
            "응답 시간({scope}{}건) p50 {} · p95 {} · p99 {} · 최대 {}",
            number_to_string(count),
            ms(latency.prop("p50")),
            ms(latency.prop("p95")),
            ms(latency.prop("p99")),
            ms(latency.prop("max"))
        )
    } else {
        format!("응답 시간을 잴 {sample} 없음")
    };
    let connect = prop(Some(result), "connect")?.ok_or("connect가 없습니다")?;
    let loop_delay = prop(Some(result), "loopDelay")?.ok_or("loopDelay가 없습니다")?;
    let warmup = prop(Some(result), "warmup")?.ok_or("warmup가 없습니다")?;
    let connect_p95 = |connect: &JsValue| -> Result<String, String> {
        Ok(match prop(Some(connect), "p95")? {
            Some(p95) => ms(Some(p95)),
            None => "-".to_owned(),
        })
    };
    let loop_p99 = prop(Some(loop_delay), "p99")?;
    let mut parts = vec![
        format!(
            "동시 {} · {}건 중 응답 {}건 ({took}, 초당 {}건)",
            template(opt_prop(Some(result), "concurrent")),
            template(opt_prop(Some(result), "requests")),
            number_to_string(completed),
            number_to_string(rate)
        ),
        format!("상태 {status_detail}"),
        latency_line,
        format!("연결 p95 {} · 러너 밀림 p99 {}", connect_p95(connect)?, ms(loop_p99)),
    ];
    // `warmup.requests > 0`: 없으면 `undefined > 0`이라 거짓
    let warm_requests = match prop(Some(warmup), "requests")? {
        None => f64::NAN,
        Some(v) => require_num(Some(v), "warmup.requests")?,
    };
    if warm_requests > 0.0 {
        let warm_errors = match prop(Some(warmup), "errors")? {
            None => f64::NAN,
            Some(v) => require_num(Some(v), "warmup.errors")?,
        };
        parts.push(format!("준비 요청 {}건{}", number_to_string(warm_requests), if warm_errors > 0.0 { format!(" (실패 {}건)", number_to_string(warm_errors)) } else { String::new() }));
    }

    let mut problems: Vec<String> = Vec::new();
    if failed > 0.0 {
        problems.push(format!("응답을 받지 못한 요청 {}건 ({})", number_to_string(failed), tally(&errors)));
    }

    let mut success_count = 0.0;
    for (status, amount) in &statuses {
        let amount = require_num(Some(amount), "응답 수")?;
        if status.starts_with('2') {
            success_count += amount;
        }
    }
    let requests_text = template(opt_prop(Some(result), "requests"));
    let success_expect = opt_prop(Some(expect), "successCount");
    if let Some(exactly) = opt_prop(success_expect, "exactly") {
        if !JsValue::Num(success_count).strict_equals(exactly) {
            problems.push(format!("성공 {}/{requests_text} (기대: 정확히 {})", number_to_string(success_count), exactly.to_js_string()));
        }
    }
    if let Some(at_most) = opt_prop(success_expect, "atMost") {
        // successCount > atMost
        if js_json::js_less(at_most, &JsValue::Num(success_count)) {
            problems.push(format!("성공 {}/{requests_text} (기대: 최대 {})", number_to_string(success_count), at_most.to_js_string()));
        }
    }
    if let Some(allowed) = opt_prop(Some(expect), "allStatusIn").filter(|v| v.truthy()) {
        let JsValue::Arr(allowed) = allowed else { return Err("allStatusIn이 배열이 아닙니다".into()) };
        let set: Vec<String> = allowed.iter().map(JsValue::to_js_string).collect();
        let mut outside: Vec<&str> = statuses.iter().map(|(k, _)| *k).filter(|k| !set.iter().any(|s| s == k)).collect();
        if !outside.is_empty() {
            outside.sort_by(|a, b| cmp_utf16(a, b));
            problems.push(format!("기대 밖 상태 코드: {} (기대: {})", outside.join(", "), join(allowed, ", ")));
        }
    } else {
        // 상태 코드 기대를 적지 않았어도 서버 오류는 통과로 세지 않는다. 빨리 실패하는 서비스가 응답 시간 기준을 통과하는 일을 막는다
        let server_errors: Vec<(&str, &JsValue)> = statuses.iter().filter(|(k, _)| k.starts_with('5')).copied().collect();
        let sum = total(&server_errors)?;
        if sum > 0.0 {
            problems.push(format!("서버 오류 응답 {}건 ({}). 의도한 응답이면 expect.allStatusIn에 적으세요", number_to_string(sum), tally(&server_errors)));
        }
    }

    let mut exceeded: Vec<f64> = Vec::new();
    if matches!(latency.prop("count"), Some(JsValue::Num(n)) if *n == 0.0) {
        problems.push(format!("응답 시간을 잴 {sample}이 없습니다 (기준: {})", describe_load_expect(expect)?));
    } else {
        for (key, label) in LATENCY_KEYS {
            let (Some(limit), Some(actual)) = (opt_prop(Some(expect), key), latency.prop(label)) else { continue };
            let (limit_n, actual_n) = (require_num(Some(limit), key)?, require_num(Some(actual), label)?);
            if actual_n > limit_n {
                problems.push(format!("{scope}{label} {} (기준: {} 이하)", ms(Some(actual)), ms(Some(limit))));
                exceeded.push(limit_n);
            }
        }
    }
    // 러너는 응답을 늦게 받아 적을 수는 있어도 일찍 적지는 못한다. 그래서 통과에는 영향이 없고, 기준을 넘겼을 때만 러너의 밀림이 섞였을 수 있다고 알린다
    if !exceeded.is_empty() {
        let p99 = require_num(loop_p99, "loopDelay.p99")?;
        let smallest = exceeded[1..].iter().fold(exceeded[0], |acc, x| js_min(acc, *x));
        if p99 >= js_max(5.0, smallest * 0.1) {
            problems.push(format!("러너 자신이 p99 {} 밀렸습니다. 이 값이 응답 시간에 섞였을 수 있습니다 — concurrent나 requests를 줄여 다시 재 보세요", ms(loop_p99)));
        }
    }

    let mut limits: Vec<String> = Vec::new();
    for (key, label) in LATENCY_KEYS {
        if let (Some(limit), Some(actual)) = (opt_prop(Some(expect), key), latency.prop(label)) {
            limits.push(format!("{scope}{label} {} (기준 {} 이하, {}건)", ms(Some(actual)), ms(Some(limit)), template(latency.prop("count"))));
        }
    }
    let mut evidence = vec![format!(
        "샌드박스 네트워크 안에서 {} {} · 동시 {} · {}건 ({took})",
        template(opt_prop(Some(check), "method")),
        template(opt_prop(Some(check), "path")),
        template(opt_prop(Some(result), "concurrent")),
        template(opt_prop(Some(result), "requests"))
    )];
    evidence.extend(limits);
    evidence.push(format!("상태 {status_detail} · 응답을 받지 못한 요청 0건"));
    evidence.push(format!("러너 밀림 p99 {} · 연결 p95 {}", ms(loop_p99), connect_p95(connect)?));
    Ok(LoadJudgement { note: parts.join(" · "), problems, evidence })
}
