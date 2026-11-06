//! `docker stats`·`docker inspect` 출력을 읽고 서비스별 사용량으로 합친다(옛 TS: `packages/sandbox/src/docker/usage.ts`).
//!
//! 값의 종류가 어긋난 입력(숫자 자리에 문자열 등)은 옛 TS가 읽던 대로 읽는다: `JsValue`의 형 변환을 쓴다.
//! 옛 TS가 던지던 자리(`null.Name`, 문자열이 아닌 값의 `.split`, 배열이 아닌 값의 `.map`)는 `Err`로 돌려준다.

use crate::js::{self, math_round};
use crate::js_json::{self, js_less, nullish, object, opt_strict_equals, JsValue};

/// `docker stats`의 크기 표기(43.12MiB, 1.2kB, 0B)를 바이트로 바꾼다
pub fn parse_docker_bytes(text: &str) -> Option<f64> {
    let t = js::trim(text);
    let b = t.as_bytes();
    // /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)$/i
    let mut end = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if end == 0 {
        return None;
    }
    if b.get(end) == Some(&b'.') {
        let frac = b[end + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if frac > 0 {
            end += 1 + frac;
        }
    }
    let number: f64 = t[..end].parse().ok()?;
    // 단위는 ASCII 글자뿐이고 대소문자를 가리지 않는다(JS `/i`는 비ASCII 글자를 ASCII로 접지 않는다)
    let unit = t[end..].trim_start_matches(js::is_js_whitespace).to_ascii_lowercase();
    let factor: f64 = match unit.as_str() {
        "b" => 1.0,
        "kb" => 1_000.0,
        "mb" => 1_000_000.0,
        "gb" => 1_000_000_000.0,
        "tb" => 1_000_000_000_000.0,
        "kib" => 1_024.0,
        "mib" => 1_048_576.0,
        "gib" => 1_073_741_824.0,
        "tib" => 1_099_511_627_776.0,
        _ => return None,
    };
    Some(math_round(number * factor))
}

fn split_text<'a>(value: Option<&'a JsValue>, what: &str) -> Result<&'a str, String> {
    match value {
        None | Some(JsValue::Null) => Ok(""),
        Some(JsValue::Str(s)) => Ok(s),
        Some(_) => Err(format!("{what}이(가) 문자열이 아니라 split을 부를 수 없습니다")),
    }
}

fn opt_num(v: Option<f64>) -> Option<JsValue> {
    v.map(JsValue::Num)
}

/// `docker stats --no-stream --format '{{json .}}'` 출력 (컨테이너마다 JSON 한 줄)
pub fn parse_stats_output(stdout: &str) -> Result<Vec<StatsRow>, String> {
    let mut rows = Vec::new();
    for line in stdout.split('\n') {
        if !js::trim(line).starts_with('{') {
            continue;
        }
        let row = js_json::parse(line)?;
        // NetIO는 "수신 / 송신"이다(예: "28.8kB / 23.4kB"). docker가 값을 못 주면 "--"라 둘 다 없다
        let net_io = split_text(row.prop("NetIO"), "NetIO")?;
        let mut net = net_io.split('/');
        let (rx, tx) = (net.next().unwrap_or(""), net.next());
        let name = match row.prop("Name") {
            None | Some(JsValue::Null) => JsValue::str(""),
            Some(v) => v.clone(),
        };
        let cpu_text = match row.prop("CPUPerc") {
            None | Some(JsValue::Null) => String::new(),
            Some(v) => v.to_js_string(),
        };
        let cpu = js::parse_float(&cpu_text);
        let mem_usage = split_text(row.prop("MemUsage"), "MemUsage")?;
        rows.push(StatsRow {
            name,
            cpu_percent: if cpu.is_nan() || cpu == 0.0 { 0.0 } else { cpu },
            memory_bytes: parse_docker_bytes(mem_usage.split('/').next().unwrap_or("")),
            network_rx_bytes: parse_docker_bytes(rx),
            network_tx_bytes: parse_docker_bytes(tx.unwrap_or("")),
        });
    }
    Ok(rows)
}

#[derive(Clone, Debug, PartialEq)]
pub struct StatsRow {
    pub name: JsValue,
    pub cpu_percent: f64,
    pub memory_bytes: Option<f64>,
    pub network_rx_bytes: Option<f64>,
    pub network_tx_bytes: Option<f64>,
}

impl StatsRow {
    pub fn to_value(&self) -> JsValue {
        object(vec![
            ("name", Some(self.name.clone())),
            ("cpuPercent", Some(JsValue::Num(self.cpu_percent))),
            ("memoryBytes", opt_num(self.memory_bytes)),
            ("networkRxBytes", opt_num(self.network_rx_bytes)),
            ("networkTxBytes", opt_num(self.network_tx_bytes)),
        ])
    }
}

/// 컨테이너를 시작한 적이 없으면 Docker가 이 값을 StartedAt에 넣는다
const NEVER_STARTED: &str = "0001-01-01T00:00:00Z";
pub const CONTAINER_STATES: [&str; 7] = ["created", "running", "paused", "restarting", "removing", "exited", "dead"];
const HEALTH_STATUSES: [&str; 3] = ["starting", "healthy", "unhealthy"];

/// `x ?? ''`가 문자열이면 그 글자, 아니면 어느 집합에도 들지 않는 값(`Set.has`는 문자열이 아니면 거짓)
fn str_in(value: Option<&JsValue>, set: &[&str]) -> Option<String> {
    match value {
        Some(JsValue::Str(s)) if set.contains(&s.as_str()) => Some(s.clone()),
        _ => None,
    }
}

/// `value ?? default`
pub fn or_default(value: Option<&JsValue>, default: JsValue) -> JsValue {
    if nullish(value) {
        default
    } else {
        value.cloned().expect("nullish가 아니면 있다")
    }
}

/// `(value ?? '').replace(/^\//, '')`
pub fn container_name(value: Option<&JsValue>) -> Result<String, String> {
    match value {
        None | Some(JsValue::Null) => Ok(String::new()),
        Some(JsValue::Str(s)) => Ok(s.strip_prefix('/').unwrap_or(s).to_owned()),
        Some(_) => Err("Name이 문자열이 아니라 replace를 부를 수 없습니다".into()),
    }
}

/// `docker inspect <컨테이너...>` 출력 (JSON 배열)
pub fn parse_inspect_output(stdout: &str) -> Result<JsValue, String> {
    let text = js::trim(stdout);
    let rows = js_json::parse(if text.is_empty() { "[]" } else { text })?;
    let JsValue::Arr(rows) = rows else { return Err("rows.map is not a function".into()) };
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        if matches!(row, JsValue::Null) {
            return Err("null의 속성을 읽을 수 없습니다".into());
        }
        let state = row.prop("State");
        let status = state.and_then(|s| s.prop("Status"));
        let host = row.prop("HostConfig");
        let memory = host.and_then(|h| h.prop("Memory")).filter(|v| v.truthy());
        let nano = host.and_then(|h| h.prop("NanoCpus")).filter(|v| v.truthy());
        let started = state.and_then(|s| s.prop("StartedAt")).filter(|v| v.truthy() && !matches!(v, JsValue::Str(s) if s == NEVER_STARTED));
        let service = row.prop("Config").and_then(|c| c.prop("Labels")).and_then(|l| l.prop("com.docker.compose.service"));
        out.push(object(vec![
            ("name", Some(JsValue::Str(container_name(row.prop("Name"))?))),
            ("service", Some(or_default(service, JsValue::str("unknown")))),
            ("state", Some(JsValue::Str(str_in(status, &CONTAINER_STATES).unwrap_or_else(|| "unknown".into())))),
            ("exitCode", Some(or_default(state.and_then(|s| s.prop("ExitCode")), JsValue::Num(0.0)))),
            ("oomKilled", Some(or_default(state.and_then(|s| s.prop("OOMKilled")), JsValue::Bool(false)))),
            ("memoryLimitBytes", memory.cloned()),
            ("cpuLimit", nano.map(|v| JsValue::Num(v.to_number() / 1e9))),
            ("restartCount", row.prop("RestartCount").cloned()),
            ("startedAt", started.cloned()),
            ("health", str_in(state.and_then(|s| s.prop("Health")).and_then(|h| h.prop("Status")), &HEALTH_STATUSES).map(JsValue::Str)),
        ]));
    }
    Ok(JsValue::Arr(out))
}

/// `classifyRole`: edge 프록시는 플랫폼, studio.yaml에 적은 서비스는 managed, 나머지는 supporting
pub fn classify_role(service: Option<&JsValue>, managed: &[String], edge_service: &str) -> &'static str {
    match service {
        Some(JsValue::Str(s)) if s == edge_service => "platform",
        Some(JsValue::Str(s)) if managed.iter().any(|m| m == s) => "managed",
        _ => "supporting",
    }
}

/// 이 프로젝트의 compose 서비스를 세 갈래(서비스/부가 서비스/플랫폼)로 나눠 사용량과 합친다
pub fn merge_usage(inspected: &JsValue, stats: &JsValue, managed: &[String], edge_service: &str) -> Result<JsValue, String> {
    let (JsValue::Arr(inspected), JsValue::Arr(stats)) = (inspected, stats) else { return Err("inspected와 stats는 배열이어야 합니다".into()) };
    let mut rows: Vec<JsValue> = Vec::with_capacity(inspected.len());
    for row in inspected {
        if matches!(row, JsValue::Null) {
            return Err("null의 속성을 읽을 수 없습니다".into());
        }
        let state = row.prop("state");
        let is = |name: &str| matches!(state, Some(JsValue::Str(s)) if s == name);
        let live = if is("running") {
            let name = row.prop("name");
            // stats 행에도 null이 들어 있으면 `candidate.name`이 던진다
            let mut found = None;
            for candidate in stats {
                if matches!(candidate, JsValue::Null) {
                    return Err("null의 속성을 읽을 수 없습니다".into());
                }
                if opt_strict_equals(candidate.prop("name"), name) {
                    found = Some(candidate);
                    break;
                }
            }
            found
        } else {
            None
        };
        let from_live = |k: &str| live.and_then(|l| l.prop(k)).cloned();
        rows.push(object(vec![
            ("service", row.prop("service").cloned()),
            ("containerName", row.prop("name").cloned()),
            ("role", Some(JsValue::str(classify_role(row.prop("service"), managed, edge_service)))),
            ("state", state.cloned()),
            ("health", row.prop("health").cloned()),
            ("cpuPercent", from_live("cpuPercent")),
            ("memoryBytes", from_live("memoryBytes")),
            ("memoryLimitBytes", row.prop("memoryLimitBytes").cloned()),
            ("cpuLimit", row.prop("cpuLimit").cloned()),
            ("networkRxBytes", from_live("networkRxBytes")),
            ("networkTxBytes", from_live("networkTxBytes")),
            ("restartCount", row.prop("restartCount").cloned()),
            ("startedAt", if is("running") { row.prop("startedAt").cloned() } else { None }),
            ("exitCode", if is("exited") || is("dead") { row.prop("exitCode").cloned() } else { None }),
            ("oomKilled", row.prop("oomKilled").cloned()),
        ]));
    }
    let sorted = js::stable_sort_by(rows, &|a, b| {
        // service가 없으면 undefined라 어느 비교도 거짓이다
        let (Some(a), Some(b)) = (a.prop("service"), b.prop("service")) else { return 0.0 };
        if js_less(a, b) {
            -1.0
        } else if js_less(b, a) {
            1.0
        } else {
            0.0
        }
    });
    Ok(JsValue::Arr(sorted))
}

/// 기동 직후 stats에서 기동 네트워크 지표를 만든다. edge 프록시와 값이 없는 컨테이너는 뺀다
pub fn boot_network_from_usage(usage: &JsValue, exclude: &str) -> Result<JsValue, String> {
    let JsValue::Arr(usage) = usage else { return Err("usage는 배열이어야 합니다".into()) };
    let mut out = Vec::new();
    for entry in usage {
        if matches!(entry, JsValue::Null) {
            return Err("null의 속성을 읽을 수 없습니다".into());
        }
        let (service, rx, tx) = (entry.prop("service"), entry.prop("networkRxBytes"), entry.prop("networkTxBytes"));
        if matches!(service, Some(JsValue::Str(s)) if s == exclude) || rx.is_none() || tx.is_none() {
            continue;
        }
        out.push(object(vec![("service", service.cloned()), ("rxBytes", rx.cloned()), ("txBytes", tx.cloned())]));
    }
    Ok(JsValue::Arr(out))
}

/// 사람이 읽는 크기. 화면과 에이전트 도구가 같은 표기를 쓴다
pub fn format_bytes(bytes: Option<f64>) -> String {
    let Some(bytes) = bytes else { return "-".into() };
    const GIB: f64 = 1_073_741_824.0;
    const MIB: f64 = 1_048_576.0;
    if bytes >= GIB {
        format!("{}GiB", js::to_fixed(bytes / GIB, 2))
    } else if bytes >= MIB {
        format!("{}MiB", js::number_to_string(math_round(bytes / MIB)))
    } else {
        format!("{}KiB", js::number_to_string(math_round(bytes / 1_024.0)))
    }
}

/// 종료 코드 137은 SIGKILL로 끝났다는 뜻이고, 한도를 넘은 경우가 흔하다
pub fn describe_usage(usage: &JsValue) -> Result<String, String> {
    if matches!(usage, JsValue::Null) {
        return Err("null의 속성을 읽을 수 없습니다".into());
    }
    let bytes = |k: &str| usage.prop(k).map(JsValue::to_number);
    let truthy = |k: &str| usage.prop(k).is_some_and(JsValue::truthy);
    let memory = format!(
        "{}{}",
        format_bytes(bytes("memoryBytes")),
        if truthy("memoryLimitBytes") { format!(" / {}", format_bytes(bytes("memoryLimitBytes"))) } else { String::new() }
    );
    let cpu = match usage.prop("cpuPercent") {
        None => "-".to_owned(),
        Some(JsValue::Num(n)) => format!(
            "{}%{}",
            js::to_fixed(*n, 1),
            if truthy("cpuLimit") { format!(" / {}%", js::number_to_string(usage.prop("cpuLimit").map_or(f64::NAN, JsValue::to_number) * 100.0)) } else { String::new() }
        ),
        Some(_) => return Err("cpuPercent가 숫자가 아니라 toFixed를 부를 수 없습니다".into()),
    };
    let ended = match usage.prop("exitCode") {
        None => String::new(),
        Some(code) => format!(
            ", 종료 코드 {}{}",
            code.to_js_string(),
            if truthy("oomKilled") {
                " (메모리 한도를 넘어 종료됨)"
            } else if matches!(code, JsValue::Num(n) if *n == 137.0) {
                " (강제 종료, 메모리 부족일 수 있음)"
            } else {
                ""
            }
        ),
    };
    let text = |k: &str| usage.prop(k).map_or_else(|| "undefined".to_owned(), JsValue::to_js_string);
    Ok(format!("{}: {}, CPU {cpu}, 메모리 {memory}{ended}", text("service"), text("state")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> JsValue {
        js_json::parse(text).unwrap()
    }

    #[test]
    fn docker_크기_표기를_바이트로_바꾼다() {
        assert_eq!(parse_docker_bytes("43.12MiB"), Some(math_round(43.12 * 1_048_576.0)));
        assert_eq!(parse_docker_bytes("1.2kB"), Some(1200.0));
        assert_eq!(parse_docker_bytes("0B"), Some(0.0));
        assert_eq!(parse_docker_bytes(" 5 mib "), Some(5_242_880.0));
        assert_eq!(parse_docker_bytes("--"), None);
        assert_eq!(parse_docker_bytes("1.B"), None);
        assert_eq!(parse_docker_bytes("1ib"), None);
        assert_eq!(parse_docker_bytes("1KIB"), Some(1024.0));
        // 비ASCII 글자는 ASCII 단위와 같게 접히지 않는다(JS /i)
        assert_eq!(parse_docker_bytes("1\u{212A}B"), None);
        assert_eq!(parse_docker_bytes("1\u{3000}\u{FEFF}kb"), Some(1000.0));
        assert_eq!(parse_docker_bytes("1.5"), None);
    }

    #[test]
    fn stats_행은_숫자를_읽고_이름을_그대로_둔다() {
        let rows = parse_stats_output("{\"Name\":\"a\",\"CPUPerc\":\"12.5%\",\"MemUsage\":\"10MiB / 1GiB\",\"NetIO\":\"1kB / 2kB\"}\nnoise\n  {\"Name\":5,\"CPUPerc\":\"--\",\"NetIO\":\"--\"}").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].cpu_percent, 12.5);
        assert_eq!(rows[0].memory_bytes, Some(10_485_760.0));
        assert_eq!(rows[0].network_tx_bytes, Some(2000.0));
        assert_eq!(rows[1].name, JsValue::Num(5.0));
        assert_eq!(rows[1].cpu_percent, 0.0);
        assert_eq!(rows[1].memory_bytes, None);
        // 줄 앞에 JSON이 아닌 공백(U+00A0)이 있으면 trim은 지우지만 JSON.parse는 던진다
        assert!(parse_stats_output("\u{a0}{\"Name\":\"a\"}").is_err());
        // NetIO가 문자열이 아니면 JS는 split에서 던진다
        assert!(parse_stats_output("{\"NetIO\":5}").is_err());
    }

    #[test]
    fn inspect_행은_값의_종류가_어긋나도_js처럼_읽는다() {
        let v = parse_inspect_output(
            r#"[{"Name":"/web-1","RestartCount":2,"State":{"Status":"running","ExitCode":0,"StartedAt":"2026-01-01T00:00:00Z","Health":{"Status":"healthy"}},"HostConfig":{"Memory":0,"NanoCpus":"2000000000"},"Config":{"Labels":{"com.docker.compose.service":"web"}}}, 5]"#,
        )
        .unwrap();
        let JsValue::Arr(rows) = v else { panic!() };
        assert_eq!(rows[0].prop("name"), Some(&JsValue::str("web-1")));
        assert_eq!(rows[0].prop("memoryLimitBytes"), None);
        assert_eq!(rows[0].prop("cpuLimit"), Some(&JsValue::Num(2.0)));
        assert_eq!(rows[1].prop("service"), Some(&JsValue::str("unknown")));
        assert_eq!(rows[1].prop("state"), Some(&JsValue::str("unknown")));
        assert!(parse_inspect_output("[null]").is_err());
        assert!(parse_inspect_output("{}").is_err());
        assert!(parse_inspect_output("  ").unwrap() == JsValue::Arr(vec![]));
    }

    #[test]
    fn 크기_서식은_js_반올림을_따른다() {
        assert_eq!(format_bytes(None), "-");
        assert_eq!(format_bytes(Some(1_073_741_824.0 * 1.005)), "1.00GiB");
        assert_eq!(format_bytes(Some(1_048_576.0 * 2.5)), "3MiB");
        assert_eq!(format_bytes(Some(512.0)), "1KiB");
        assert_eq!(format_bytes(Some(f64::NAN)), "NaNKiB");
        assert_eq!(format_bytes(Some(-1.0)), "0KiB");
        assert_eq!(format_bytes(Some(f64::INFINITY)), "InfinityGiB");
    }

    #[test]
    fn 사용량_서술은_cpu_한도를_js_수_표기로_쓴다() {
        let u = p(r#"{"service":"api","state":"exited","cpuPercent":1.25,"cpuLimit":1.1,"exitCode":137,"memoryBytes":1048576,"memoryLimitBytes":2097152}"#);
        assert_eq!(describe_usage(&u).unwrap(), "api: exited, CPU 1.3% / 110.00000000000001%, 메모리 1MiB / 2MiB, 종료 코드 137 (강제 종료, 메모리 부족일 수 있음)");
        let u = p(r#"{"service":"db","state":"running"}"#);
        assert_eq!(describe_usage(&u).unwrap(), "db: running, CPU -, 메모리 -");
    }

    #[test]
    fn 병합은_service를_utf16_순서로_정렬한다() {
        let inspected = p(r#"[{"name":"b","service":"～","state":"running"},{"name":"a","service":"😀","state":"exited","exitCode":1}]"#);
        let stats = p(r#"[{"name":"b","cpuPercent":3,"memoryBytes":5}]"#);
        let merged = merge_usage(&inspected, &stats, &[], "edge").unwrap();
        let JsValue::Arr(rows) = merged else { panic!() };
        assert_eq!(rows[0].prop("service"), Some(&JsValue::str("😀")));
        assert_eq!(rows[1].prop("cpuPercent"), Some(&JsValue::Num(3.0)));
        assert_eq!(rows[0].prop("exitCode"), Some(&JsValue::Num(1.0)));
    }
}
