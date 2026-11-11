//! 부하 확인 러너의 계획과 출력 해석(옛 TS: `packages/sandbox/src/docker/load-runner.ts`, ADR-195 4f A4a).
//! 러너를 띄우는 `LocalDockerProvider.load`는 TS에 남는다. 여기는 순수 함수만 둔다.
//!
//! 값은 JS처럼 읽는다: 수는 `f64`(`NaN`·`Infinity`가 `Math.min` 등을 거치는 방식까지 같게), 러너 출력은 `JSON.parse`의 문법(`js_json::parse`).
//! 의도한 차이: 러너 출력의 중첩이 `js_json`의 깊이 한도를 넘으면 읽지 못한 것으로 본다(JS는 더 깊어도 읽는다). 이 함수는 읽지 못하면
//! `None`("재지 못했다")이라 통과가 아니라 모른다 쪽으로 틀린다.

use crate::js::{self, number_to_string};
use crate::js_json::{self, JsObject, JsValue};

/// 요청 하나가 이 시간 안에 응답하지 않으면 응답을 받지 못한 요청으로 센다
pub const LOAD_REQUEST_TIMEOUT_MS: f64 = 10_000.0;
/// 준비 요청과 재는 요청을 합친 전체 상한. 넘으면 남은 요청을 보내지 않고 끝낸다
pub const LOAD_DEADLINE_MS: f64 = 60_000.0;
/// 러너 컨테이너의 b-studio.service 라벨. compose 서비스가 아니라 일회용 컨테이너라 사용량 화면에는 나오지 않는다
pub const LOAD_RUNNER_SERVICE: &str = "b-studio-load";
/// 러너 스레드 상한. 스레드마다 CPU 하나를 준다
const MAX_LOAD_THREADS: f64 = 4.0;
/// 스레드 하나가 맡을 연결 수. 이보다 많으면 스레드를 나눈다
const CONNECTIONS_PER_THREAD: f64 = 250.0;

/// `Math.min`: `NaN`이 끼면 `NaN`
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `Math.max`: `NaN`이 끼면 `NaN`
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// 러너 스레드 수. 동시 연결이 많을수록 스레드를 늘리되, 도커가 쓸 수 있는 CPU의 절반을 넘지 않는다(재는 대상과 CPU를 다투지 않게).
/// 스레드 수만큼 --cpus를 준다. CPU 한도가 스레드 수보다 작으면 러너가 스로틀링에 걸려 응답 시간이 부풀려진다(트러블슈팅 128)
pub fn load_threads(concurrent: f64, daemon_cpus: Option<f64>) -> f64 {
    let by_load = (concurrent / CONNECTIONS_PER_THREAD).ceil();
    // `daemonCpus && daemonCpus > 0` — 0·NaN·undefined는 1
    let by_cpu = match daemon_cpus {
        Some(cpus) if cpus > 0.0 => js_max(1.0, (cpus / 2.0).floor()),
        _ => 1.0,
    };
    js_max(1.0, js_min(js_min(MAX_LOAD_THREADS, by_load), by_cpu))
}

pub struct LoadRunPlan<'a> {
    /// 컨테이너 이름. 중단됐을 때 이 이름으로만 지운다
    pub name: &'a str,
    /// 샌드박스의 internal 네트워크(compose가 만든 실제 이름)
    pub network: &'a str,
    pub sandbox_id: &'a str,
    pub threads: f64,
    /// 샌드박스 컨테이너에 쓰는 Docker 런타임(gVisor 등). 서비스와 같은 격리로 돌린다. 빈 글자는 없는 것과 같다
    pub runtime: Option<&'a str>,
    /// 러너 이미지. 샌드박스 출입구(edge)와 같은 이미지다
    pub image: &'a str,
}

/// 러너 컨테이너의 `docker run` 인자. 스크립트는 표준 입력으로 넘기므로 마운트가 없다.
/// internal 네트워크에만 붙여 샌드박스 밖으로 나가지 못하고, 파일 시스템은 읽기 전용이며 권한을 모두 내려놓는다.
/// 이미지는 새로 받지 않는다(--pull never) — 확인 도중에 네트워크에서 무언가를 받는 일이 없게 한다
pub fn load_run_args(plan: &LoadRunPlan) -> Vec<String> {
    let mut args: Vec<String> = [
        "run", "--rm", "--interactive", "--pull", "never",
        "--name", plan.name,
        "--label", &format!("b-studio.sandbox={}", plan.sandbox_id),
        "--label", &format!("b-studio.service={LOAD_RUNNER_SERVICE}"),
        "--network", plan.network,
        "--cpus", &number_to_string(plan.threads),
        "--memory", "512m",
        "--pids-limit", "256",
        "--ulimit", "nofile=4096:4096",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--user", "65534:65534",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if let Some(runtime) = plan.runtime.filter(|r| !r.is_empty()) {
        args.push("--runtime".into());
        args.push(runtime.to_owned());
    }
    args.push(plan.image.to_owned());
    args.extend(["node", "--input-type=module", "-"].iter().map(|s| (*s).to_owned()));
    args
}

/// 러너에 넘길 설정. 대상은 서비스 이름과 컨테이너 포트로만 정해진다 — 경로가 다른 호스트를 가리킬 방법이 없다.
/// `request`는 JS의 `LoadRequest`를 읽은 값이다. 없는 속성(`undefined`)은 설정에도 없다
pub fn load_config(request: &JsValue, port: f64, threads: f64) -> Result<JsValue, String> {
    let mut config = JsObject::new();
    let put = |config: &mut JsObject, key: &str, value: Option<&JsValue>| {
        if let Some(value) = value {
            config.set(key, value.clone());
        }
    };
    put(&mut config, "host", request.prop("service"));
    config.set("port", JsValue::Num(port));
    put(&mut config, "method", request.prop("method"));
    put(&mut config, "path", request.prop("path"));
    // `request.headers ? { headers } : {}` — 거짓 값(null·빈 글자·0)이면 넣지 않는다
    if let Some(headers) = request.prop("headers").filter(|v| v.truthy()) {
        config.set("headers", headers.clone());
    }
    // `request.body !== undefined` — null도 넣는다
    put(&mut config, "body", request.prop("body"));
    put(&mut config, "requests", request.prop("requests"));
    put(&mut config, "concurrent", request.prop("concurrent"));
    // `request.warmup ?? 0`
    config.set("warmup", request.prop("warmup").filter(|v| !matches!(v, JsValue::Null)).cloned().unwrap_or(JsValue::Num(0.0)));
    // `request.latencyOf ? { latencyOf: [...request.latencyOf] } : {}` — 펼치기는 배열이면 복사, 글자면 글자(코드 포인트)마다, 그 밖의 참인 값은 던진다
    if let Some(latency_of) = request.prop("latencyOf").filter(|v| v.truthy()) {
        let spread = match latency_of {
            JsValue::Arr(items) => items.clone(),
            JsValue::Str(text) => text.chars().map(|c| JsValue::Str(c.to_string())).collect(),
            _ => return Err("latencyOf를 펼칠 수 없습니다(배열이어야 합니다)".into()),
        };
        config.set("latencyOf", JsValue::Arr(spread));
    }
    config.set("threads", JsValue::Num(threads));
    config.set("requestTimeoutMs", JsValue::Num(LOAD_REQUEST_TIMEOUT_MS));
    config.set("deadlineMs", JsValue::Num(LOAD_DEADLINE_MS));
    Ok(JsValue::Obj(config))
}

/// 설정을 스크립트 앞에 붙인다. `config_json`은 설정을 `JSON.stringify`한 글자다. JSON은 그대로 자바스크립트 값이라 따옴표를 따로 다루지 않는다
pub fn load_script(runner: &str, config_json: &str) -> String {
    format!("globalThis.B_STUDIO_LOAD = {config_json};\n{runner}")
}

fn is_count(value: Option<&JsValue>) -> Option<f64> {
    match value {
        Some(JsValue::Num(n)) if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 => Some(*n),
        _ => None,
    }
}

fn is_ms(value: Option<&JsValue>) -> Option<f64> {
    match value {
        Some(JsValue::Num(n)) if n.is_finite() && *n >= 0.0 => Some(*n),
        _ => None,
    }
}

/// 값이 모두 0 이상의 정수인 객체. `Object.entries` 순서로 복사한다
fn counts(value: Option<&JsValue>) -> Option<JsObject> {
    let Some(JsValue::Obj(object)) = value else { return None };
    let mut copy = JsObject::new();
    for (key, amount) in object.entries_js_order() {
        is_count(Some(amount))?;
        copy.set(key, amount.clone());
    }
    Some(copy)
}

/// 응답 시간 요약. 표본이 없으면 `count`만 있다
fn latency(value: Option<&JsValue>) -> Option<(f64, JsObject)> {
    let value = value?;
    let count = is_count(value.prop("count"))?;
    let mut summary = JsObject::new();
    summary.set("count", JsValue::Num(count));
    if count == 0.0 {
        return Some((count, summary));
    }
    for key in ["p50", "p95", "p99", "max"] {
        summary.set(key, JsValue::Num(is_ms(value.prop(key))?));
    }
    Some((count, summary))
}

fn sum(object: &JsObject) -> f64 {
    object.entries_js_order().iter().fold(0.0, |total, (_, amount)| total + if let JsValue::Num(n) = amount { *n } else { 0.0 })
}

/// 러너 출력의 마지막 줄을 읽는다. 꼴이 하나라도 어긋나면 `None` — 호출자가 "재지 못했다"로 다룬다.
/// 읽은 값끼리도 맞춰 본다: 받은 응답 수가 상태 코드별 합과 같아야 하고, 받은 응답과 받지 못한 요청의 합이 보낸 요청 수와 같아야 한다.
/// 덜 센 결과로 통과하는 일을 막는다
pub fn parse_load_output(stdout: &str, requests: f64, concurrent: f64) -> Option<JsValue> {
    let trimmed = js::trim(stdout);
    let last = trimmed.rsplit('\n').next().filter(|line| !line.is_empty())?;
    let parsed = js_json::parse(last).ok()?;
    if !matches!(parsed, JsValue::Obj(_)) {
        return None;
    }
    let statuses = counts(parsed.prop("statuses"))?;
    let errors = counts(parsed.prop("errors"))?;
    let (measured_count, measured) = latency(parsed.prop("latency"))?;
    let (_, connect) = latency(parsed.prop("connect"))?;
    let connect_errors = is_count(parsed.prop("connect")?.prop("errors"))?;
    let completed = is_count(parsed.prop("completed"))?;
    let threads = is_count(parsed.prop("threads"))?;
    let elapsed_ms = is_ms(parsed.prop("elapsedMs"))?;
    let loop_delay = parsed.prop("loopDelay")?;
    let (loop_p99, loop_max) = (is_ms(loop_delay.prop("p99"))?, is_ms(loop_delay.prop("max"))?);
    let warmup = parsed.prop("warmup")?;
    let (warmup_requests, warmup_errors) = (is_count(warmup.prop("requests"))?, is_count(warmup.prop("errors"))?);
    // `parsed.requests !== request.requests` — NaN은 어느 쪽에도 같지 않다
    if !matches!(parsed.prop("requests"), Some(JsValue::Num(n)) if *n == requests) || !matches!(parsed.prop("concurrent"), Some(JsValue::Num(n)) if *n == concurrent) {
        return None;
    }
    // /^[1-5]\d\d$/ — JS의 `\d`는 ASCII 숫자뿐이고 `$`는 맨 끝에만 맞는다
    let status_shape = |key: &str| matches!(key.as_bytes(), [b'1'..=b'5', b'0'..=b'9', b'0'..=b'9']);
    if !statuses.entries().iter().all(|(key, _)| status_shape(key)) {
        return None;
    }
    let (responded, failed) = (sum(&statuses), sum(&errors));
    if responded != completed || responded + failed != requests {
        return None;
    }
    if measured_count > responded {
        return None;
    }
    let mut connect_out = connect;
    connect_out.set("errors", JsValue::Num(connect_errors));
    let mut loop_out = JsObject::new();
    loop_out.set("p99", JsValue::Num(loop_p99));
    loop_out.set("max", JsValue::Num(loop_max));
    let mut warmup_out = JsObject::new();
    warmup_out.set("requests", JsValue::Num(warmup_requests));
    warmup_out.set("errors", JsValue::Num(warmup_errors));
    let mut result = JsObject::new();
    result.set("requests", JsValue::Num(requests));
    result.set("concurrent", JsValue::Num(concurrent));
    result.set("threads", JsValue::Num(threads));
    result.set("completed", JsValue::Num(completed));
    result.set("elapsedMs", JsValue::Num(elapsed_ms));
    result.set("statuses", JsValue::Obj(statuses));
    result.set("errors", JsValue::Obj(errors));
    result.set("latency", JsValue::Obj(measured));
    result.set("connect", JsValue::Obj(connect_out));
    result.set("loopDelay", JsValue::Obj(loop_out));
    result.set("warmup", JsValue::Obj(warmup_out));
    Some(JsValue::Obj(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> JsValue {
        js_json::parse(text).unwrap()
    }

    #[test]
    fn 스레드_수는_연결_수와_cpu의_절반으로_정한다() {
        assert_eq!(load_threads(1.0, None), 1.0);
        assert_eq!(load_threads(250.0, Some(8.0)), 1.0);
        assert_eq!(load_threads(251.0, Some(8.0)), 2.0);
        assert_eq!(load_threads(10_000.0, Some(8.0)), 4.0);
        assert_eq!(load_threads(10_000.0, Some(4.0)), 2.0);
        assert_eq!(load_threads(10_000.0, Some(1.0)), 1.0);
        assert_eq!(load_threads(10_000.0, Some(0.0)), 1.0);
        assert_eq!(load_threads(10_000.0, Some(-4.0)), 1.0);
        assert_eq!(load_threads(10_000.0, Some(f64::NAN)), 1.0);
        assert_eq!(load_threads(0.0, Some(8.0)), 1.0);
        assert_eq!(load_threads(-5.0, Some(8.0)), 1.0);
        assert!(load_threads(f64::NAN, Some(8.0)).is_nan());
        assert_eq!(load_threads(f64::INFINITY, Some(f64::INFINITY)), 4.0);
    }

    #[test]
    fn 러너_인자는_고립_옵션을_모두_담는다() {
        let plan = LoadRunPlan { name: "n", network: "net", sandbox_id: "sb", threads: 2.0, runtime: Some("runsc"), image: "img:1" };
        let args = load_run_args(&plan);
        assert_eq!(args[..5], ["run", "--rm", "--interactive", "--pull", "never"]);
        assert!(args.windows(2).any(|w| w == ["--label", "b-studio.sandbox=sb"]));
        assert!(args.windows(2).any(|w| w == ["--cpus", "2"]));
        assert!(args.windows(2).any(|w| w == ["--runtime", "runsc"]));
        assert!(args.windows(2).any(|w| w == ["--cap-drop", "ALL"]));
        assert!(args.contains(&"--read-only".to_owned()));
        assert_eq!(args[args.len() - 4..], ["img:1", "node", "--input-type=module", "-"]);
        let none = load_run_args(&LoadRunPlan { runtime: Some(""), ..plan });
        assert!(!none.contains(&"--runtime".to_owned()));
    }

    #[test]
    fn 설정은_정해진_순서로_만든다() {
        let request = json(r#"{"service":"api","method":"GET","path":"/x","headers":{"a":"b"},"body":null,"concurrent":5,"requests":10,"latencyOf":[200],"extra":1}"#);
        let config = load_config(&request, 8080.0, 2.0).unwrap();
        assert_eq!(
            js_json::stringify(&config),
            r#"{"host":"api","port":8080,"method":"GET","path":"/x","headers":{"a":"b"},"body":null,"requests":10,"concurrent":5,"warmup":0,"latencyOf":[200],"threads":2,"requestTimeoutMs":10000,"deadlineMs":60000}"#
        );
        let bare = load_config(&json(r#"{"service":"a","method":"GET","path":"/","headers":"","warmup":null,"latencyOf":0,"requests":1,"concurrent":1}"#), 1.0, 1.0).unwrap();
        assert_eq!(js_json::stringify(&bare), r#"{"host":"a","port":1,"method":"GET","path":"/","requests":1,"concurrent":1,"warmup":0,"threads":1,"requestTimeoutMs":10000,"deadlineMs":60000}"#);
        assert!(load_config(&json(r#"{"latencyOf":5}"#), 1.0, 1.0).is_err());
    }

    #[test]
    fn 스크립트는_설정_뒤_줄바꿈_다음에_러너를_붙인다() {
        assert_eq!(load_script("RUN();", r#"{"a":"'`$\n"}"#), "globalThis.B_STUDIO_LOAD = {\"a\":\"'`$\\n\"};\nRUN();");
    }

    const OK: &str = r#"{"requests":10,"concurrent":2,"threads":1,"completed":8,"elapsedMs":12.5,"statuses":{"500":1,"200":7},"errors":{"timeout":2},"latency":{"count":8,"p50":1,"p95":2,"p99":3,"max":4},"connect":{"count":0,"errors":0},"loopDelay":{"p99":1,"max":2},"warmup":{"requests":0,"errors":0}}"#;

    #[test]
    fn 맞는_출력은_읽는다() {
        let got = parse_load_output(&format!("log line\n{OK}\n"), 10.0, 2.0).unwrap();
        let text = js_json::stringify(&got);
        assert!(text.starts_with(r#"{"requests":10,"concurrent":2,"threads":1,"completed":8,"elapsedMs":12.5,"statuses":{"200":7,"500":1},"errors":{"timeout":2},"latency":{"count":8"#), "{text}");
        assert!(text.contains(r#""connect":{"count":0,"errors":0}"#));
    }

    #[test]
    fn 어긋난_출력은_읽지_않는다() {
        let bad = |mutated: String| parse_load_output(&mutated, 10.0, 2.0).is_none();
        assert!(parse_load_output("", 10.0, 2.0).is_none());
        assert!(parse_load_output("not json", 10.0, 2.0).is_none());
        assert!(parse_load_output("[1]", 10.0, 2.0).is_none());
        assert!(bad(OK.replace(r#""completed":8"#, r#""completed":7"#)));
        assert!(bad(OK.replace(r#""timeout":2"#, r#""timeout":1"#)));
        assert!(bad(OK.replace(r#""500":1"#, r#""600":1"#)));
        assert!(bad(OK.replace(r#""500":1"#, r#""50":1"#)));
        assert!(bad(OK.replace(r#""count":8"#, r#""count":9"#)));
        assert!(bad(OK.replace(r#""requests":10,"concurrent":2,"threads""#, r#""requests":11,"concurrent":2,"threads""#)));
        assert!(bad(OK.replace(r#""elapsedMs":12.5"#, r#""elapsedMs":-1"#)));
        assert!(bad(OK.replace(r#""threads":1"#, r#""threads":1.5"#)));
        assert!(bad(OK.replace(r#""p99":3"#, r#""p99":null"#)));
        assert!(bad(OK.replace(r#""connect":{"count":0,"errors":0}"#, r#""connect":{"count":0}"#)));
        assert!(parse_load_output(OK, 10.0, 3.0).is_none());
        assert!(parse_load_output(OK, f64::NAN, 2.0).is_none());
    }
}
