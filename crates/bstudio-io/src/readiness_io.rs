//! 서비스 준비 확인(옛 TS: `LocalDockerSandbox.#awaitReady` + `readiness.ts`의 `waitForReady`), 모르는 프로세스 검사(`#recordProcessBaseline`·`strayProcesses`),
//! 인프라 복구의 확인 절반(`#missingServices`)(ADR-195 4f A4c-3a).
//!
//! 판정은 `bstudio_guard`(`readiness`·`docker_format`·`stray_processes`)가 하고, 여기는 docker를 부르는 순서·HTTP·반복만 한다.
//!
//! **통과시키는 판정이다.** 준비 판정은 "서비스가 요청을 받는다"를, 모르는 프로세스 검사는 "남은 프로세스가 없다"를 게이트가 믿는 근거다. 아래는 모두 통과가 아니라
//! 실패나 "아직"이다: 응답이 HTTP가 아님·연결 실패·시간 초과·기대와 다른 상태 코드·헤더를 읽지 못함, 컨테이너 상태를 읽지 못함(`unknown`),
//! `ps` 출력을 해석하지 못함(running이 아닌 것), 프로세스 목록을 읽지 못함(기준선을 지우고 "모른다").
//!
//! **근거를 읽는 대상 = 보고하는 대상**: `compose port`에서 읽은 호스트 포트 하나가 HTTP 확인의 대상이자 돌려주는 엔드포인트의 포트다.
//! **호스트는 `127.0.0.1`로 고정이다.** 옛 TS는 `new URL(ready.path, endpoint.url)`을 확인했는데, URL 해석은 `\`를 `/`로 읽고 탭·줄바꿈을 지워
//! `/\example.com/`이 `http://example.com/`이 됐다(트러블슈팅 192). 여기서는 경로를 요청 줄에만 쓰므로 어떤 경로도 다른 호스트로 풀리지 않는다.
//! 경로를 요청 줄로 바꾸는 규칙은 `fetch`(WHATWG URL)와 같되 아래 둘만 더 막는다: `\`는 구분자가 아니라 `%5C`로, 탭·줄바꿈은 지우지 않고 `%09`·`%0A`·`%0D`로 보낸다.
//!
//! 막는 쪽/여는 쪽: `await_ready_once`의 `Ready`와 `scan`의 "프로세스 없음"은 여는 쪽(통과)이다. 모르는 입력은 모두 그 결과가 아니다.
//! 다시 만들기(`Recreate`)는 이 함수가 하지 않는다: `up`은 TS의 `#upQueue`·`#gitMask`를 지나야 하므로 "다시 만들어 달라"는 결과만 돌려주고 TS가 기존 경로로 `up`한 뒤 다시 부른다.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bstudio_guard::docker_format::{egress_audit_excerpt, parse_container_state, parse_container_states, parse_host_port, parse_log_line};
use bstudio_guard::js;
use bstudio_guard::js_json::JsValue;
use bstudio_guard::readiness::{crash_log_excerpt, decide_readiness, should_retry_transient_crash, Probe, ReadinessDecision, ReadinessPolicy};
use bstudio_guard::secrets::Redactor;
use bstudio_guard::stray_processes::{foreign_processes, parse_process_scan, ScannedProcess};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::container_verify::Cancel;
use crate::log_stream::run_command_log_stream;
use crate::up_loop::{compose_command, docker, ComposeRef};

// ── HTTP 확인 ───────────────────────────────────────────────────────────

/// 헤더 블록의 상한. Node(undici)의 기본 `max-http-header-size`와 같다
const MAX_HEAD: usize = 16 * 1024;
/// 정보 응답(1xx)은 건너뛰고 최종 응답을 읽는다(undici와 같다). 끝없이 이어지는 것은 막는다
const MAX_INFORMATIONAL: usize = 8;

fn percent(target: &mut String, byte: u8) {
    target.push_str(&format!("%{byte:02X}"));
}

/// 경로 조각의 인코딩. `fetch`의 경로 집합(C0 제어·공백·`"`·`<`·`>`·`` ` ``·`{`·`}`·DEL·비ASCII)에 더해 `\`도 인코딩한다(`fetch`는 `/`로 읽는다. 트러블슈팅 192).
/// 탭·줄바꿈도 `fetch`는 지우지만 여기서는 C0 제어로 인코딩한다
fn encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte <= 0x20 || byte >= 0x7f || matches!(byte, b'"' | b'<' | b'>' | b'`' | b'{' | b'}' | b'\\') {
            percent(&mut out, byte);
        } else {
            out.push(byte as char);
        }
    }
    out
}

/// 쿼리의 인코딩. `fetch`(특수 스킴)의 쿼리 집합: C0 제어·공백·`"`·`'`·`<`·`>`·DEL·비ASCII. `\`·`` ` ``·`{`·`}`는 그대로 둔다(`fetch`와 같다)
fn encode_query(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for byte in query.bytes() {
        if byte <= 0x20 || byte >= 0x7f || matches!(byte, b'"' | b'\'' | b'<' | b'>') {
            percent(&mut out, byte);
        } else {
            out.push(byte as char);
        }
    }
    out
}

/// `ready.path`를 HTTP 요청 줄의 대상(origin-form)으로 바꾼다. 호스트는 여기서 정하지 않는다(요청은 늘 `127.0.0.1:<포트>`로 간다).
/// `fetch`(`new URL(path, base)`)와 같은 규칙: 앞뒤 공백·제어 문자를 떼고, `#` 뒤를 버리고, `.`·`..` 조각을 접고(`%2e` 꼴 포함), 경로·쿼리를 각자의 집합으로 인코딩한다.
/// 다른 점은 모듈 머리말의 둘(`\`, 탭·줄바꿈)뿐이다
pub fn request_target(path: &str) -> String {
    let trimmed = path.trim_matches(|c: char| c <= ' ');
    let without_fragment = trimmed.split('#').next().unwrap_or("");
    let (path_part, query) = match without_fragment.split_once('?') {
        Some((path_part, query)) => (path_part, Some(query)),
        None => (without_fragment, None),
    };
    let rest = path_part.strip_prefix('/').unwrap_or(path_part);
    let segments: Vec<&str> = rest.split('/').collect();
    let mut out: Vec<String> = Vec::with_capacity(segments.len());
    for (index, segment) in segments.iter().enumerate() {
        let last = index + 1 == segments.len();
        match segment.to_ascii_lowercase().as_str() {
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                out.pop();
                if last {
                    out.push(String::new());
                }
            }
            "." | "%2e" => {
                if last {
                    out.push(String::new());
                }
            }
            _ => out.push(encode_path_segment(segment)),
        }
    }
    let mut target = format!("/{}", out.join("/"));
    // 빈 쿼리(`/a?`)는 `fetch`가 요청 줄에 싣지 않는다(`URL.search`가 빈 문자열이다)
    if let Some(query) = query.filter(|query| !query.is_empty()) {
        target.push('?');
        target.push_str(&encode_query(query));
    }
    target
}

fn request_for(port: u16, path: &str) -> String {
    // 머리글은 Node `fetch`가 보내던 것과 같다(서버가 요청 머리글에 따라 다르게 답하는 경우를 같게 한다). 연결만 `keep-alive`가 아니라 `close`다
    format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: */*\r\nAccept-Language: *\r\nSec-Fetch-Mode: cors\r\nUser-Agent: node\r\nAccept-Encoding: gzip, deflate\r\n\r\n",
        request_target(path)
    )
}

/// 입출력 오류를 옛 `describeFetchError`가 돌려주던 이름으로(`cause.code`, 없으면 `fetch failed`)
fn io_code(error: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match error.kind() {
        ConnectionRefused => "ECONNREFUSED",
        ConnectionReset => "ECONNRESET",
        ConnectionAborted => "ECONNABORTED",
        TimedOut => "ETIMEDOUT",
        AddrNotAvailable => "EADDRNOTAVAIL",
        _ => "fetch failed",
    }
    .to_owned()
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

/// 응답 머리 하나(상태 줄과 헤더 줄, 마지막 빈 줄까지)를 읽는다. 오류는 옛 `fetch`가 내던 `cause.code` 이름이다
fn parse_head(block: &[u8]) -> Result<u16, String> {
    let text = block.strip_suffix(b"\r\n\r\n").ok_or("UND_ERR_SOCKET")?;
    let mut lines = text.split(|byte| *byte == b'\n').map(|line| line.strip_suffix(b"\r").unwrap_or(line));
    let status_line = lines.next().ok_or("HPE_INVALID_CONSTANT")?;
    let after = status_line.strip_prefix(b"HTTP/").ok_or("HPE_INVALID_CONSTANT")?;
    let (version, rest) = match after.iter().position(|byte| *byte == b' ') {
        Some(at) => (&after[..at], Some(&after[at + 1..])),
        None => (after, None),
    };
    if version != b"1.1" && version != b"1.0" {
        return Err("HPE_INVALID_VERSION".to_owned());
    }
    let code: &[u8] = rest.map(|rest| &rest[..rest.len().min(3)]).unwrap_or(&[]);
    let tail: &[u8] = rest.map(|rest| &rest[code.len()..]).unwrap_or(&[]);
    if code.len() != 3 || !code.iter().all(u8::is_ascii_digit) || !(tail.is_empty() || tail[0] == b' ') {
        return Err("HPE_INVALID_STATUS".to_owned());
    }
    for line in lines {
        let colon = line.iter().position(|byte| *byte == b':').ok_or("HPE_INVALID_HEADER_TOKEN")?;
        if colon == 0 || !line[..colon].iter().copied().all(is_token_byte) {
            return Err("HPE_INVALID_HEADER_TOKEN".to_owned());
        }
        if line[colon + 1..].iter().any(|byte| (*byte < 0x20 && *byte != b'\t') || *byte == 0x7f) {
            return Err("HPE_INVALID_HEADER_TOKEN".to_owned());
        }
    }
    Ok(std::str::from_utf8(code).expect("숫자").parse::<u16>().expect("세 자리 숫자"))
}

fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n").map(|at| at + 4)
}

/// `http://127.0.0.1:<port><path>`에 GET을 한 번 보내 상태 코드만 돌려준다. 리다이렉트를 따르지 않고 본문을 읽지 않는다.
/// 연결부터 응답 머리(상태 줄과 헤더)까지 `timeout` 안에 끝나야 하고, 머리가 HTTP 응답으로 읽혀야 한다. 실패는 옛 `fetch`가 내던 이름(`describeFetchError`)이다:
/// `TIMEOUT`·`ECONNREFUSED`·`UND_ERR_SOCKET`(응답 없이 끊김)·`HPE_*`(HTTP가 아님)·`UND_ERR_HEADERS_OVERFLOW`
pub async fn probe_http(port: u16, path: &str, timeout: Duration) -> Result<u16, String> {
    let request = request_for(port, path);
    match tokio::time::timeout(timeout, async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|error| io_code(&error))?;
        stream.write_all(request.as_bytes()).await.map_err(|error| if error.kind() == std::io::ErrorKind::ConnectionReset { "ECONNRESET".to_owned() } else { "UND_ERR_SOCKET".to_owned() })?;
        let mut head: Vec<u8> = Vec::with_capacity(512);
        let mut informational = 0;
        let mut chunk = [0u8; 1024];
        loop {
            // 처음 몇 글자가 `HTTP/`가 아니면 더 기다리지 않는다
            let seen = head.len().min(5);
            if head[..seen] != b"HTTP/"[..seen] {
                return Err("HPE_INVALID_CONSTANT".to_owned());
            }
            // 줄 끝은 CRLF여야 한다(낱개 LF는 HTTP 머리가 아니다)
            if head.iter().enumerate().any(|(at, byte)| *byte == b'\n' && (at == 0 || head[at - 1] != b'\r')) {
                return Err("HPE_INVALID_HEADER_TOKEN".to_owned());
            }
            if let Some(end) = find_head_end(&head) {
                let status = parse_head(&head[..end])?;
                if (100..200).contains(&status) {
                    informational += 1;
                    if informational > MAX_INFORMATIONAL {
                        return Err("UND_ERR_SOCKET".to_owned());
                    }
                    head.drain(..end);
                    continue;
                }
                return Ok(status);
            }
            if head.len() > MAX_HEAD {
                return Err("UND_ERR_HEADERS_OVERFLOW".to_owned());
            }
            match stream.read(&mut chunk).await {
                Ok(0) => return Err("UND_ERR_SOCKET".to_owned()),
                Ok(read) => head.extend_from_slice(&chunk[..read]),
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => return Err("ECONNRESET".to_owned()),
                Err(_) => return Err("UND_ERR_SOCKET".to_owned()),
            }
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("TIMEOUT".to_owned()),
    }
}

// ── 준비 확인 ───────────────────────────────────────────────────────────

pub struct ReadyCheck {
    pub path: String,
    pub expect_status: f64,
    pub success_threshold: f64,
    pub timeout_ms: f64,
    pub interval_ms: f64,
}

pub struct ReadyInput {
    /// docker 실행 파일·환경·프로젝트 이름·폴더·compose 파일
    pub compose: ComposeRef,
    pub override_path: String,
    pub service: String,
    pub edge_service: String,
    /// edge가 이 서비스를 위해 열어 둔 컨테이너 포트(`compose port <edge> <이 값>`)
    pub edge_port: String,
    /// 없으면 엔드포인트만 읽는다
    pub ready: Option<ReadyCheck>,
    /// 1부터. 1번째 시도가 일시 오류로 죽었을 때만 다시 만들어 달라고 한다
    pub attempt: i64,
    /// 가릴 시크릿 (이름, 값)(JS `Object.entries` 순서)
    pub secrets: Vec<(String, String)>,
    /// 부르는 시점에 이미 취소돼 있었다(Rust의 취소 신호는 등록한 뒤의 취소만 안다)
    pub aborted: bool,
}

/// 확인 한 번. 옛 `ProbeResult`와 같은 모양(`at`·`ok`·`status`|`error`·`containerState`)이다
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeRecord {
    pub at: u64,
    pub ok: bool,
    pub status: Option<u16>,
    pub error: Option<String>,
    pub container_state: String,
}

impl ProbeRecord {
    pub fn to_json(&self) -> String {
        let mut object = serde_json::Map::new();
        object.insert("at".into(), serde_json::Value::from(self.at));
        object.insert("ok".into(), serde_json::Value::from(self.ok));
        if let Some(status) = self.status {
            object.insert("status".into(), serde_json::Value::from(status));
        }
        if let Some(error) = &self.error {
            object.insert("error".into(), serde_json::Value::from(error.clone()));
        }
        object.insert("containerState".into(), serde_json::Value::from(self.container_state.clone()));
        serde_json::Value::Object(object).to_string()
    }

    fn as_probe(&self) -> Probe {
        Probe { ok: self.ok, status: self.status.map(f64::from), error: self.error.clone(), container_state: self.container_state.clone() }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AwaitOutcome {
    /// 준비됐다(`ready`가 없으면 엔드포인트만 읽었다). 값은 확인한 그 호스트 포트다
    Ready { port: f64 },
    /// `compose port`가 비0으로 끝났다. 부르는 쪽이 옛 글 그대로의 오류로 바꾼다
    EndpointDocker { exit_code: i32, stderr: String },
    /// `compose port` 출력에서 호스트 포트를 읽지 못했다
    EndpointUnparsed(String),
    /// 읽은 포트가 TCP 포트가 아니다(옛 `new URL`이 `Invalid URL`로 던졌다)
    InvalidPort,
    /// 준비되지 않았다. `reason`에는 죽은 컨테이너의 앱 로그와 egress 기록이 이미 붙어 있다
    Failed { reason: String, history: Vec<ProbeRecord> },
    /// 일시 오류로 죽었다: 컨테이너를 한 번 다시 만들어 달라(`reason`은 이벤트에 실을 이유)
    Recreate { reason: String },
    /// 취소됐다. `at_top`이면 확인 사이(`throwIfAborted`), 아니면 쉬는 중(`sleep`)이었다
    Aborted { at_top: bool },
    /// 확인 알림을 받는 쪽이 멈추라고 했다(받는 쪽이 던졌다)
    Stopped,
}

/// 확인이 끝날 때마다 `ProbeRecord`의 JSON을 알린다. 알림을 처리할 때까지 기다리고, 계속하면 `true`다
pub type OnProbe<'a> = &'a (dyn Fn(String) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

fn ms_duration(ms: f64) -> Duration {
    if ms.is_nan() || ms < 1.0 {
        return Duration::from_millis(1);
    }
    Duration::from_millis(ms.min(2_147_483_647.0) as u64)
}

async fn container_state(input: &ReadyInput) -> String {
    let rest: Vec<String> = ["ps", "--all", "--format", "json", &input.service].iter().map(|part| (*part).to_owned()).collect();
    let output = docker(&input.compose, &compose_command(&input.compose, &input.override_path, &rest), None).await;
    // 종료 코드는 보지 않는다(옛 `state()`와 같다). 읽지 못하면 `unknown`이고 `unknown`은 준비가 아니다
    parse_container_state(&output.stdout).unwrap_or_else(|_| "unknown".to_owned())
}

/// 컨테이너 상태와 HTTP를 함께 한 번 확인한다
async fn probe_once(input: &ReadyInput, check: &ReadyCheck, port: u16) -> ProbeRecord {
    let timeout = ms_duration(check.interval_ms.max(2000.0));
    let (state, http) = tokio::join!(container_state(input), probe_http(port, &check.path, timeout));
    let (status, error) = match http {
        Ok(status) => (Some(status), None),
        Err(error) => (None, Some(error)),
    };
    // 컨테이너 상태를 읽지 못하면(`unknown`) HTTP가 맞아도 성공이 아니다: 확인하지 못한 것을 "있다"로 읽지 않는다(옛 TS는 `exited`·`dead`만 막았다)
    let ok = status.is_some_and(|status| f64::from(status) == check.expect_status) && state != "unknown";
    ProbeRecord { at: now_ms(), ok, status, error, container_state: state }
}

/// 서비스의 로그 끝 `tail`줄의 글(시간표시와 서비스 접두를 뗀 본문, 시크릿을 가린 것). 옛 `logs({ follow: false })`와 같다:
/// 로그를 못 읽으면 읽은 만큼만(띄우기에 실패하면 빈 목록) 돌려준다
async fn read_logs(input: &ReadyInput, redactor: &Redactor, service: &str, tail: u32) -> Vec<String> {
    let rest: Vec<String> = ["logs", "--no-color", "--timestamps", "--tail"].iter().map(|part| (*part).to_owned()).chain([tail.to_string(), service.to_owned()]).collect();
    let args = compose_command(&input.compose, &input.override_path, &rest);
    let (mut stream, pump) = run_command_log_stream(&input.compose.docker_bin, &args, input.compose.env.as_deref(), None);
    let drain = async {
        let mut lines: Vec<String> = Vec::new();
        while let Some(raw) = stream.next_line().await {
            if let Some(JsValue::Str(text)) = parse_log_line(&raw).as_ref().and_then(|line| line.prop("text")) {
                lines.push(redactor.redact(text));
            }
        }
        lines
    };
    tokio::join!(pump, drain).1
}

pub async fn await_ready_once(input: &ReadyInput, cancel: &Cancel, on_probe: OnProbe<'_>) -> AwaitOutcome {
    // 엔드포인트: edge가 공개한 호스트 포트. 서비스는 internal 네트워크에 있어 포트를 공개할 수 없다
    let rest: Vec<String> = ["port", &input.edge_service, &input.edge_port].iter().map(|part| (*part).to_owned()).collect();
    let output = docker(&input.compose, &compose_command(&input.compose, &input.override_path, &rest), None).await;
    if output.exit_code != 0 {
        return AwaitOutcome::EndpointDocker { exit_code: output.exit_code, stderr: output.stderr };
    }
    let port = match parse_host_port(&output.stdout) {
        Ok(port) => port,
        Err(message) => return AwaitOutcome::EndpointUnparsed(message),
    };
    let Some(check) = &input.ready else {
        return AwaitOutcome::Ready { port };
    };
    // 확인할 포트와 보고할 포트는 같은 값이다. TCP 포트가 아니면 확인하지 않는다
    if port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
        return AwaitOutcome::InvalidPort;
    }
    let port_number = port as u16;
    let redactor = Redactor::new(input.secrets.clone());
    let policy = ReadinessPolicy { success_threshold: check.success_threshold, timeout_ms: check.timeout_ms };
    let started = Instant::now();
    let mut history: Vec<ProbeRecord> = Vec::new();
    let reason = loop {
        if input.aborted || cancel.is_cancelled() {
            return AwaitOutcome::Aborted { at_top: true };
        }
        let probe = probe_once(input, check, port_number).await;
        history.push(probe.clone());
        if !on_probe(probe.to_json()).await {
            return AwaitOutcome::Stopped;
        }
        let probes: Vec<Probe> = history.iter().map(ProbeRecord::as_probe).collect();
        match decide_readiness(&probes, &policy, started.elapsed().as_millis() as f64) {
            ReadinessDecision::Ready => return AwaitOutcome::Ready { port },
            ReadinessDecision::Failed { reason } => break reason,
            ReadinessDecision::Waiting => {}
        }
        tokio::select! {
            _ = tokio::time::sleep(ms_duration(check.interval_ms)) => {}
            _ = cancel.cancelled() => return AwaitOutcome::Aborted { at_top: false },
        }
    };
    let mut reason = reason;
    // 컨테이너가 죽었으면 앱 로그의 마지막 오류 줄을 이유에 붙인다. 로그를 못 읽어도 원래 이유는 그대로 둔다
    let crashed = history.last().is_some_and(|probe| probe.container_state == "exited" || probe.container_state == "dead");
    if crashed {
        let lines = read_logs(input, &redactor, &input.service, 60).await;
        let excerpt = crash_log_excerpt(&lines, 6);
        // 트러블슈팅 #90: 설치 스크립트가 막 쓴 실행 파일을 실행하다 생기는 일시 오류(ETXTBSY 등)로 죽었으면 한 번만 다시 만든다
        if should_retry_transient_crash(input.attempt, &excerpt) {
            let joined = excerpt.join(" / ");
            return AwaitOutcome::Recreate { reason: if joined.is_empty() { reason } else { joined } };
        }
        if !excerpt.is_empty() {
            reason = format!("{reason}\n앱 로그 마지막 줄:\n{}", excerpt.join("\n"));
        }
        // edge의 egress 감사 로그도 같이 본다(#411). 실행이 끝나 컨테이너가 지워지면 사라지므로 실패 바로 그 순간에 덧붙인다
        let egress_lines = read_logs(input, &redactor, &input.edge_service, 200).await;
        let egress = egress_audit_excerpt(&egress_lines, 5.0);
        if !egress.is_empty() {
            reason = format!("{reason}\negress 최근 기록:\n{}", egress.join("\n"));
        }
    }
    AwaitOutcome::Failed { reason, history }
}

// ── 모르는 프로세스 검사 ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ScanOutcome {
    Processes(Vec<ScannedProcess>),
    /// 읽지 못한 까닭(호출자는 확인하지 못한 서비스를 다시 띄운다)
    Error(String),
}

pub struct ScanInput {
    pub compose: ComposeRef,
    pub override_path: String,
    /// 컨테이너에서 도는 찾기 스크립트(TS의 `PROCESS_SCAN_SCRIPT`)
    pub script: String,
    pub secrets: Vec<(String, String)>,
}

/// 서비스 안에서 찾기를 돌린다. 출력은 시크릿을 가린 뒤에 읽는다(옛 `exec`가 가린 글을 읽었다). 셸이 없거나 읽지 못하면 그 까닭을 돌려준다
pub async fn scan_processes(input: &ScanInput, service: &str, cancel: Option<&Cancel>) -> ScanOutcome {
    let rest: Vec<String> = ["exec", "-T", service, "sh", "-c", &input.script].iter().map(|part| (*part).to_owned()).collect();
    let output = docker(&input.compose, &compose_command(&input.compose, &input.override_path, &rest), cancel).await;
    let redactor = Redactor::new(input.secrets.clone());
    let (stdout, stderr) = (redactor.redact(&output.stdout), redactor.redact(&output.stderr));
    if output.exit_code == 0 {
        return ScanOutcome::Processes(parse_process_scan(&stdout));
    }
    let lowered = stderr.to_ascii_lowercase();
    if output.exit_code == 126 || output.exit_code == 127 || lowered.contains("executable file not found") || lowered.contains("no such file or directory") {
        return ScanOutcome::Error("sh가 없어 서비스 안의 프로세스를 확인하지 못했습니다".to_owned());
    }
    let trimmed = js::trim(&stderr);
    ScanOutcome::Error(format!("서비스 안의 프로세스를 읽지 못했습니다: {}", if trimmed.is_empty() { format!("종료 코드 {}", output.exit_code) } else { trimmed.to_owned() }))
}

#[derive(Debug, Clone, PartialEq)]
pub struct StrayReport {
    pub service: String,
    /// 읽지 못했다
    pub error: Option<String>,
    /// 기준선에 없던 프로세스 `(pid, 명령)`
    pub processes: Vec<(f64, String)>,
}

/// 서비스마다 running인지 보고, running이면 찾아서 기준선에 없던 것만 알린다. 멈춘 서비스는 건너뛴다(게이트가 켜 버리지 않게).
/// 컨테이너 상태를 읽지 못하면(출력이 JSON이 아님) 건너뛰지 않고 전체가 실패한다 — 읽지 못한 것을 "멈춘 서비스"로 보면 모르는 프로세스가 통과한다
pub async fn stray_processes(input: Arc<ScanInput>, services: Vec<String>, baseline: Vec<(String, Vec<(f64, String)>)>, cancel: Arc<Cancel>) -> Result<Vec<StrayReport>, String> {
    let baseline = Arc::new(baseline);
    let mut tasks = tokio::task::JoinSet::new();
    for (index, service) in services.iter().cloned().enumerate() {
        let (input, baseline, cancel) = (input.clone(), baseline.clone(), cancel.clone());
        tasks.spawn(async move {
            let result: Result<Option<StrayReport>, String> = async {
                let rest: Vec<String> = ["ps", "--all", "--format", "json", &service].iter().map(|part| (*part).to_owned()).collect();
                let listed = docker(&input.compose, &compose_command(&input.compose, &input.override_path, &rest), None).await;
                if parse_container_state(&listed.stdout)? != "running" {
                    return Ok(None);
                }
                Ok(match scan_processes(&input, &service, Some(&cancel)).await {
                    ScanOutcome::Error(error) => Some(StrayReport { service: service.clone(), error: Some(error), processes: Vec::new() }),
                    ScanOutcome::Processes(now) => {
                        let now_keys: Vec<(f64, String)> = now.iter().map(|process| (process.pid, process.start.clone())).collect();
                        let known = baseline.iter().find(|(name, _)| *name == service).map(|(_, list)| list.as_slice());
                        let foreign = foreign_processes(&now_keys, known);
                        (!foreign.is_empty()).then(|| StrayReport { service: service.clone(), error: None, processes: foreign.into_iter().map(|at| (now[at].pid, now[at].command.clone())).collect() })
                    }
                })
            }
            .await;
            (index, result)
        });
    }
    let mut slots: Vec<Option<Result<Option<StrayReport>, String>>> = (0..services.len()).map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        let (index, result) = joined.map_err(|error| format!("프로세스 검사 작업이 끝나지 못했습니다: {error}"))?;
        slots[index] = Some(result);
    }
    let mut reports = Vec::new();
    for slot in slots {
        if let Some(report) = slot.expect("모든 작업이 끝났다")? {
            reports.push(report);
        }
    }
    Ok(reports)
}

// ── 인프라 확인 ─────────────────────────────────────────────────────────

/// 넘긴 서비스 이름 중 컨테이너가 running이 아닌(혹은 아예 없는) 것만 돌려준다. `ps` 출력을 해석하지 못하면 모두 running이 아닌 것으로 본다
/// (옛 TS는 던졌다. 던지는 쪽도 통과가 아니지만, 해석하지 못한 것을 "있다"로 읽는 길이 어디에도 없게 한다)
pub async fn missing_services(compose: &ComposeRef, override_path: &str, names: &[String], cancel: Option<&Cancel>) -> Vec<String> {
    if names.is_empty() {
        return Vec::new();
    }
    let rest: Vec<String> = ["ps", "--all", "--format", "json"].iter().map(|part| (*part).to_owned()).chain(names.iter().cloned()).collect();
    let output = docker(compose, &compose_command(compose, override_path, &rest), cancel).await;
    match parse_container_states(&output.stdout) {
        Ok(states) => names.iter().filter(|name| states.iter().find(|(service, _)| service == *name).map(|(_, state)| state.as_str()) != Some("running")).cloned().collect(),
        Err(_) => names.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_docker::Fake;
    use std::sync::Mutex;
    use tokio::net::TcpListener;

    // ── 요청 줄 ──

    /// 각 줄은 `fetch`(Node)가 같은 입력으로 요청 줄에 보낸 값을 직접 받아 적은 것이다
    #[test]
    fn 요청_줄은_fetch가_보내던_것과_같다() {
        let same: &[(&str, &str)] = &[
            ("/", "/"),
            ("/a b", "/a%20b"),
            ("/a\"b", "/a%22b"),
            ("/a<b>c", "/a%3Cb%3Ec"),
            ("/a`b", "/a%60b"),
            ("/a{b}c", "/a%7Bb%7Dc"),
            ("/a^b", "/a^b"),
            ("/a|b", "/a|b"),
            ("/a'b", "/a'b"),
            ("/a\u{7f}b", "/a%7Fb"),
            ("/a\u{1}b", "/a%01b"),
            ("/é", "/%C3%A9"),
            ("/a?é", "/a?%C3%A9"),
            ("/a?x'y", "/a?x%27y"),
            ("/a?x`y{z}", "/a?x`y{z}"),
            ("/a?x\\y", "/a?x\\y"),
            ("/a?x y", "/a?x%20y"),
            ("/a?x?y", "/a?x?y"),
            ("/a?", "/a"),
            ("/a?#x", "/a"),
            ("/a?b#c", "/a?b"),
            ("/a#b?c", "/a"),
            ("/a%zz", "/a%zz"),
            ("/a%2", "/a%2"),
            ("/%", "/%"),
            ("/a ", "/a"),
            ("/ a", "/%20a"),
            ("/a/../b", "/b"),
            ("/a/./b", "/a/b"),
            ("/..", "/"),
            ("/a/..", "/"),
            ("/a/.", "/a/"),
            ("/a/%2e%2e/b", "/b"),
            ("/a/.%2E/b", "/b"),
            ("/a/%2E/b", "/a/b"),
            ("/a//../b", "/a/b"),
            ("/a$b&c=d;e,f:g@h[i]j~k!l*m(n)o+p", "/a$b&c=d;e,f:g@h[i]j~k!l*m(n)o+p"),
        ];
        for (input, expected) in same {
            assert_eq!(request_target(input), *expected, "{input:?}");
        }
    }

    /// HARDENED(트러블슈팅 192): `fetch`는 `\`를 `/`로 읽고 탭·줄바꿈을 지워 `/\example.com/`을 `http://example.com/`으로 풀었다
    #[test]
    fn 역슬래시와_탭과_줄바꿈은_구분자도_지울_글자도_아니고_그대로_인코딩한다() {
        assert_eq!(request_target("/\\example.com/"), "/%5Cexample.com/");
        assert_eq!(request_target("/\t/example.com/"), "/%09/example.com/");
        assert_eq!(request_target("/\n/example.com/"), "/%0A/example.com/");
        assert_eq!(request_target("/\r/example.com/"), "/%0D/example.com/");
        assert_eq!(request_target("/a\\b/c"), "/a%5Cb/c");
        assert_eq!(request_target("/\\a"), "/%5Ca");
        // 호스트처럼 보이는 앞부분도 경로의 한 조각일 뿐이다
        assert_eq!(request_target("//example.com/"), "//example.com/");
        assert_eq!(request_target("/http://example.com/"), "/http://example.com/");
        assert_eq!(request_target("http://example.com/x"), "/http://example.com/x");
    }

    #[test]
    fn 줄을_깨는_글자는_요청_줄에_그대로_나가지_않는다() {
        let line = request_for(80, "/a b\r\nX-Evil: 1#frag");
        assert_eq!(line.matches("\r\n").count(), 9, "{line:?}");
        assert!(line.starts_with("GET /a%20b%0D%0AX-Evil:%201 HTTP/1.1\r\nHost: 127.0.0.1:80\r\n"));
    }

    // ── HTTP 확인 ──

    async fn server(reply: &'static [u8]) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 4096];
                    let mut got = Vec::new();
                    while !got.windows(4).any(|window| window == b"\r\n\r\n") {
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(read) => got.extend_from_slice(&buffer[..read]),
                        }
                    }
                    log.lock().unwrap().push(String::from_utf8_lossy(&got).into_owned());
                    if reply == b"SLOW" {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await;
                    } else if reply == b"HANG" {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    } else if reply == b"RESET" {
                        #[allow(deprecated)]
                        socket.set_linger(Some(Duration::ZERO)).unwrap();
                    } else {
                        let _ = socket.write_all(reply).await;
                    }
                });
            }
        });
        (port, seen)
    }

    async fn status(reply: &'static [u8]) -> Result<u16, String> {
        let (port, _) = server(reply).await;
        probe_http(port, "/", Duration::from_millis(600)).await
    }

    #[tokio::test]
    async fn 상태_줄과_헤더가_http_응답이면_상태_코드만_읽는다() {
        assert_eq!(status(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await, Ok(200));
        assert_eq!(status(b"HTTP/1.0 200 OK\r\n\r\nbody").await, Ok(200));
        assert_eq!(status(b"HTTP/1.1 204\r\n\r\n").await, Ok(204));
        assert_eq!(status(b"HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\n\r\n").await, Ok(302));
        assert_eq!(status(b"HTTP/1.1 999 X\r\n\r\n").await, Ok(999));
        // 정보 응답은 건너뛰고 최종 응답을 읽는다
        assert_eq!(status(b"HTTP/1.1 103 Early\r\n\r\nHTTP/1.1 200 OK\r\n\r\n").await, Ok(200));
    }

    #[tokio::test]
    async fn 통과가_아닌_응답은_옛_fetch의_오류_이름으로_돌아온다() {
        assert_eq!(status(b"hello world\r\n\r\n").await, Err("HPE_INVALID_CONSTANT".into()));
        assert_eq!(status(b"hello").await, Err("HPE_INVALID_CONSTANT".into()));
        assert_eq!(status(b"HTTP/2 200\r\n\r\n").await, Err("HPE_INVALID_VERSION".into()));
        assert_eq!(status(b"HTTP/1.1 20 X\r\n\r\n").await, Err("HPE_INVALID_STATUS".into()));
        assert_eq!(status(b"HTTP/1.1 2000\r\n\r\n").await, Err("HPE_INVALID_STATUS".into()));
        assert_eq!(status(b"HTTP/1.1 abc OK\r\n\r\n").await, Err("HPE_INVALID_STATUS".into()));
        // 상태 줄이 맞아도 헤더가 HTTP가 아니면 통과가 아니다
        assert_eq!(status(b"HTTP/1.1 200 OK\r\nbad header line\r\n\r\n").await, Err("HPE_INVALID_HEADER_TOKEN".into()));
        assert_eq!(status(b"HTTP/1.1 200 OK\nContent-Length: 0\n\n").await, Err("HPE_INVALID_HEADER_TOKEN".into()));
        // 응답이 끊겼다
        assert_eq!(status(b"").await, Err("UND_ERR_SOCKET".into()));
        assert_eq!(status(b"HTTP/1.1 200 OK\r\n").await, Err("UND_ERR_SOCKET".into()));
        assert_eq!(status(b"RESET").await, Err("ECONNRESET".into()));
        assert_eq!(status(b"HANG").await, Err("TIMEOUT".into()));
    }

    #[tokio::test]
    async fn 너무_긴_머리와_무한한_정보_응답은_통과가_아니다() {
        let mut long = b"HTTP/1.1 200 OK\r\nX: ".to_vec();
        long.extend(std::iter::repeat_n(b'a', 20_000));
        long.extend_from_slice(b"\r\n\r\n");
        assert_eq!(status(Box::leak(long.into_boxed_slice())).await, Err("UND_ERR_HEADERS_OVERFLOW".into()));
        let many = b"HTTP/1.1 100 C\r\n\r\n".repeat(12);
        assert_eq!(status(Box::leak(many.into_boxed_slice())).await, Err("UND_ERR_SOCKET".into()));
    }

    #[tokio::test]
    async fn 연결할_수_없으면_econnrefused이다() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(probe_http(port, "/", Duration::from_secs(2)).await, Err("ECONNREFUSED".into()));
    }

    #[tokio::test]
    async fn 요청은_127_0_0_1과_고정한_경로로만_간다() {
        let (port, seen) = server(b"HTTP/1.1 200 OK\r\n\r\n").await;
        assert_eq!(probe_http(port, "/\\example.com/", Duration::from_secs(2)).await, Ok(200));
        assert_eq!(probe_http(port, "/\t/example.com/?q=1#x", Duration::from_secs(2)).await, Ok(200));
        let seen = seen.lock().unwrap();
        assert!(seen[0].starts_with(&format!("GET /%5Cexample.com/ HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n")), "{:?}", seen[0]);
        assert!(seen[1].starts_with(&format!("GET /%09/example.com/?q=1 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n")), "{:?}", seen[1]);
    }

    // ── 준비 확인 ──

    const STATE_RUNNING: &str = "{\"Service\":\"api\",\"State\":\"running\"}\n";

    fn compose(fake: &Fake) -> ComposeRef {
        ComposeRef { docker_bin: fake.bin(), env: None, project_root: "/tmp/p".into(), compose_path: "/tmp/p/compose.yaml".into(), project_name: Some("studio-p".into()) }
    }

    fn ready_input(fake: &Fake, check: Option<ReadyCheck>) -> ReadyInput {
        ReadyInput { compose: compose(fake), override_path: "/tmp/o.yaml".into(), service: "api".into(), edge_service: "edge".into(), edge_port: "3000".into(), ready: check, attempt: 1, secrets: Vec::new(), aborted: false }
    }

    fn check(path: &str, expect_status: f64) -> ReadyCheck {
        ReadyCheck { path: path.into(), expect_status, success_threshold: 2.0, timeout_ms: 800.0, interval_ms: 5.0 }
    }

    fn collector() -> (Arc<Mutex<Vec<String>>>, impl Fn(String) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync) {
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = log.clone();
        (log, move |json| {
            sink.lock().unwrap().push(json);
            Box::pin(async { true })
        })
    }

    async fn run(input: &ReadyInput) -> (AwaitOutcome, Vec<String>) {
        let (log, on_probe) = collector();
        let outcome = await_ready_once(input, &Cancel::default(), &on_probe).await;
        let events = log.lock().unwrap().clone();
        (outcome, events)
    }

    fn port_output(port: u16) -> String {
        format!("0.0.0.0:{port}\n")
    }

    #[tokio::test]
    async fn 두_번_연속_성공하면_준비됐고_확인한_포트를_돌려준다() {
        let (port, seen) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
        let fake = Fake::new();
        fake.set("other", &port_output(port)).set("ps", STATE_RUNNING);
        let (outcome, events) = run(&ready_input(&fake, Some(check("/health", 200.0)))).await;
        assert_eq!(outcome, AwaitOutcome::Ready { port: f64::from(port) });
        assert_eq!(events.len(), 2);
        let first: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
        assert_eq!((first["ok"].clone(), first["status"].clone(), first["containerState"].clone()), (true.into(), 200.into(), "running".into()));
        assert!(first.get("error").is_none());
        assert_eq!(seen.lock().unwrap().len(), 2);
        // 호출 순서: port → (ps → ps)
        assert_eq!(fake.verbs(), vec!["compose".to_owned(), "compose ps".to_owned(), "compose ps".to_owned()]);
    }

    #[tokio::test]
    async fn ready가_없으면_엔드포인트만_읽는다() {
        let fake = Fake::new();
        fake.set("other", "0.0.0.0:43210\n");
        let (outcome, events) = run(&ready_input(&fake, None)).await;
        assert_eq!(outcome, AwaitOutcome::Ready { port: 43210.0 });
        assert!(events.is_empty());
        assert_eq!(fake.calls().len(), 1);
        assert!(fake.calls()[0].ends_with("port edge 3000"), "{:?}", fake.calls());
    }

    #[tokio::test]
    async fn 포트를_읽지_못하면_확인하지_않는다() {
        let fake = Fake::new();
        fake.set("other", "no port here\n");
        assert!(matches!(run(&ready_input(&fake, Some(check("/", 200.0)))).await.0, AwaitOutcome::EndpointUnparsed(_)));
        let fake = Fake::new();
        fake.fail("other", 1, "no such service");
        assert_eq!(run(&ready_input(&fake, Some(check("/", 200.0)))).await.0, AwaitOutcome::EndpointDocker { exit_code: 1, stderr: "no such service".into() });
        // 포트가 TCP 포트가 아니다
        let fake = Fake::new();
        fake.set("other", "0.0.0.0:70000\n");
        assert_eq!(run(&ready_input(&fake, Some(check("/", 200.0)))).await.0, AwaitOutcome::InvalidPort);
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn 기대와_다른_상태_코드는_통과가_아니고_시간이_지나면_실패다() {
        let (port, _) = server(b"HTTP/1.1 503 Service Unavailable\r\n\r\n").await;
        let fake = Fake::new();
        fake.set("other", &port_output(port)).set("ps", STATE_RUNNING);
        let (outcome, events) = run(&ready_input(&fake, Some(check("/", 200.0)))).await;
        let AwaitOutcome::Failed { reason, history } = outcome else { panic!("{outcome:?}") };
        assert_eq!(reason, "1초 안에 준비되지 않았습니다 (마지막 확인: HTTP 503, 컨테이너 running)");
        assert!(history.iter().all(|probe| !probe.ok && probe.status == Some(503)));
        assert_eq!(events.len(), history.len());
    }

    #[tokio::test]
    async fn 컨테이너_상태를_읽지_못하면_http가_맞아도_성공이_아니다() {
        // HARDENED: 옛 TS는 상태를 읽지 못해도(unknown) HTTP가 연속으로 맞으면 준비됐다고 봤다
        let (port, _) = server(b"HTTP/1.1 200 OK\r\n\r\n").await;
        for garbled in ["not json at all", "", "{\"Service\":\"api\"}\n", "{\"Service\":\"api\",\"State\":\"weird\"}\n"] {
            let fake = Fake::new();
            fake.set("other", &port_output(port)).set("ps", garbled);
            let mut input = ready_input(&fake, Some(check("/", 200.0)));
            input.ready.as_mut().unwrap().timeout_ms = 100.0;
            let (outcome, events) = run(&input).await;
            let AwaitOutcome::Failed { reason, history } = outcome else { panic!("{garbled:?}: {outcome:?}") };
            assert_eq!(reason, "0초 안에 준비되지 않았습니다 (마지막 확인: HTTP 200, 컨테이너 unknown)", "{garbled:?}");
            assert!(history.iter().all(|probe| !probe.ok && probe.status == Some(200)), "{garbled:?}");
            assert!(events.iter().all(|json| json.contains("\"ok\":false") && json.contains("\"containerState\":\"unknown\"")), "{events:?}");
        }
        // 읽히는 상태(running)면 같은 HTTP가 성공이다
        let fake = Fake::new();
        fake.set("other", &port_output(port)).set("ps", STATE_RUNNING);
        assert_eq!(run(&ready_input(&fake, Some(check("/", 200.0)))).await.0, AwaitOutcome::Ready { port: f64::from(port) });
    }

    #[tokio::test]
    async fn 확인_간격이_짧아도_응답은_2초까지_기다린다() {
        // 응답 머리가 0.4초 뒤에 온다: 간격(5ms)이 아니라 max(간격, 2000ms)가 시간 제한이다
        let (port, _) = server(b"SLOW").await;
        let fake = Fake::new();
        fake.set("other", &port_output(port)).set("ps", STATE_RUNNING);
        let mut input = ready_input(&fake, Some(check("/", 200.0)));
        input.ready.as_mut().unwrap().timeout_ms = 10_000.0;
        assert_eq!(run(&input).await.0, AwaitOutcome::Ready { port: f64::from(port) });
    }

    #[tokio::test]
    async fn 연결할_수_없으면_econnrefused가_이유에_남는다() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let fake = Fake::new();
        fake.set("other", &port_output(port)).set("ps", STATE_RUNNING);
        let mut input = ready_input(&fake, Some(check("/", 200.0)));
        input.ready.as_mut().unwrap().timeout_ms = 100.0;
        let AwaitOutcome::Failed { reason, .. } = run(&input).await.0 else { panic!() };
        assert_eq!(reason, "0초 안에 준비되지 않았습니다 (마지막 확인: ECONNREFUSED, 컨테이너 running)");
    }

    fn crashed(fake: &Fake, port: u16) {
        fake.set("other", &port_output(port)).set("ps", "{\"Service\":\"api\",\"State\":\"exited\"}\n");
    }

    #[tokio::test]
    async fn 컨테이너가_죽으면_바로_실패하고_앱_로그와_egress_기록이_이유에_붙는다() {
        let (port, _) = server(b"HTTP/1.1 200 OK\r\n\r\n").await;
        let fake = Fake::new();
        crashed(&fake, port);
        fake.hook("other", 2, "printf 'api-1  | 2026-01-01T00:00:00Z starting\\napi-1  | 2026-01-01T00:00:01Z Error: boom\\n'; exit 0");
        fake.hook("other", 3, "printf 'edge-1  | 2026-01-01T00:00:00.123456789Z {\"edge\":\"egress\",\"decision\":\"deny\",\"host\":\"x.com\",\"reason\":\"not allowed\"}\\n'; exit 0");
        let (outcome, events) = run(&ready_input(&fake, Some(check("/", 200.0)))).await;
        let AwaitOutcome::Failed { reason, history } = outcome else { panic!("{outcome:?}") };
        assert_eq!(events.len(), 1);
        assert_eq!(history.len(), 1);
        assert_eq!(reason, "앱이 켜지다가 종료됐습니다 (컨테이너 exited)\n앱 로그 마지막 줄:\nError: boom\negress 최근 기록:\nx.com: not allowed");
        // 로그는 앱 → edge 순서로, 각각 정해진 줄 수만 읽는다
        let logs: Vec<String> = fake.calls().into_iter().filter(|call| call.contains(" logs ")).collect();
        assert!(logs[0].ends_with("logs --no-color --timestamps --tail 60 api"), "{logs:?}");
        assert!(logs[1].ends_with("logs --no-color --timestamps --tail 200 edge"), "{logs:?}");
    }

    #[tokio::test]
    async fn 일시_오류로_죽었으면_한_번만_다시_만들어_달라고_한다() {
        let (port, _) = server(b"HTTP/1.1 200 OK\r\n\r\n").await;
        let fake = Fake::new();
        crashed(&fake, port);
        fake.hook("other", 2, "printf 'api-1  | 2026-01-01T00:00:01Z Error: spawn ETXTBSY\\n'; exit 0");
        let (outcome, _) = run(&ready_input(&fake, Some(check("/", 200.0)))).await;
        assert_eq!(outcome, AwaitOutcome::Recreate { reason: "Error: spawn ETXTBSY".into() });
        // egress 로그는 읽지 않는다(다시 만든다)
        assert_eq!(fake.calls().iter().filter(|call| call.contains(" logs ")).count(), 1);
        // 두 번째 시도에서는 다시 만들어 달라고 하지 않는다
        let fake2 = Fake::new();
        crashed(&fake2, port);
        fake2.hook("other", 2, "printf 'api-1  | 2026-01-01T00:00:01Z Error: spawn ETXTBSY\\n'; exit 0");
        let mut second = ready_input(&fake2, Some(check("/", 200.0)));
        second.attempt = 2;
        let AwaitOutcome::Failed { reason, .. } = run(&second).await.0 else { panic!() };
        assert!(reason.contains("앱 로그 마지막 줄:\nError: spawn ETXTBSY"), "{reason}");
    }

    #[tokio::test]
    async fn 로그의_시크릿은_가려서_이유에_붙는다() {
        let (port, _) = server(b"HTTP/1.1 200 OK\r\n\r\n").await;
        let fake = Fake::new();
        crashed(&fake, port);
        fake.hook("other", 2, "printf 'api-1  | 2026-01-01T00:00:01Z Error: bad token SECRETVALUE1\\n'; exit 0");
        let mut input = ready_input(&fake, Some(check("/", 200.0)));
        input.secrets = vec![("TOKEN".into(), "SECRETVALUE1".into())];
        let AwaitOutcome::Failed { reason, .. } = run(&input).await.0 else { panic!() };
        assert!(!reason.contains("SECRETVALUE1"), "{reason}");
        assert!(reason.contains("Error: bad token"), "{reason}");
    }

    #[tokio::test]
    async fn 알림을_받는_쪽이_멈추라고_하면_멈춘다() {
        let (port, _) = server(b"HTTP/1.1 200 OK\r\n\r\n").await;
        let fake = Fake::new();
        fake.set("other", &port_output(port)).set("ps", STATE_RUNNING);
        let stop = |_: String| -> Pin<Box<dyn Future<Output = bool> + Send>> { Box::pin(async { false }) };
        let outcome = await_ready_once(&ready_input(&fake, Some(check("/", 200.0))), &Cancel::default(), &stop).await;
        assert_eq!(outcome, AwaitOutcome::Stopped);
    }

    #[tokio::test]
    async fn 이미_취소됐으면_확인하지_않고_쉬는_중의_취소는_쉬는_중으로_알린다() {
        let (port, _) = server(b"HTTP/1.1 503 X\r\n\r\n").await;
        let fake = Fake::new();
        fake.set("other", &port_output(port)).set("ps", STATE_RUNNING);
        let mut input = ready_input(&fake, Some(check("/", 200.0)));
        input.aborted = true;
        let (outcome, events) = run(&input).await;
        assert_eq!(outcome, AwaitOutcome::Aborted { at_top: true });
        assert!(events.is_empty());
        // 쉬는 중에 취소한다
        let mut input = ready_input(&fake, Some(check("/", 200.0)));
        input.ready.as_mut().unwrap().interval_ms = 60_000.0;
        input.ready.as_mut().unwrap().timeout_ms = 600_000.0;
        let cancel = Arc::new(Cancel::default());
        let (_, on_probe) = collector();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            trigger.cancel();
        });
        assert_eq!(await_ready_once(&input, &cancel, &on_probe).await, AwaitOutcome::Aborted { at_top: false });
    }

    // ── 모르는 프로세스 검사 ──

    fn scan_input(fake: &Fake) -> ScanInput {
        ScanInput { compose: compose(fake), override_path: "/tmp/o.yaml".into(), script: "SCAN".into(), secrets: Vec::new() }
    }

    #[tokio::test]
    async fn 찾기_출력은_pid_순서로_읽고_실패는_그_까닭이_된다() {
        let fake = Fake::new();
        fake.set("exec", "20 500 sleep 100\n3 40 sh\n");
        let ScanOutcome::Processes(found) = scan_processes(&scan_input(&fake), "api", None).await else { panic!() };
        assert_eq!(found.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![3.0, 20.0]);
        assert!(fake.calls()[0].ends_with("exec -T api sh -c SCAN"), "{:?}", fake.calls());
        for (code, err, expected) in [
            (126, "", "sh가 없어 서비스 안의 프로세스를 확인하지 못했습니다"),
            (127, "", "sh가 없어 서비스 안의 프로세스를 확인하지 못했습니다"),
            (1, "OCI runtime exec failed: exec failed: Executable File Not Found in $PATH", "sh가 없어 서비스 안의 프로세스를 확인하지 못했습니다"),
            (1, "No Such File or Directory", "sh가 없어 서비스 안의 프로세스를 확인하지 못했습니다"),
            (3, "  /proc/1/stat를 읽지 못했습니다\n", "서비스 안의 프로세스를 읽지 못했습니다: /proc/1/stat를 읽지 못했습니다"),
            (2, "", "서비스 안의 프로세스를 읽지 못했습니다: 종료 코드 2"),
        ] {
            let fake = Fake::new();
            fake.fail("exec", code, err);
            assert_eq!(scan_processes(&scan_input(&fake), "api", None).await, ScanOutcome::Error(expected.into()), "{code} {err}");
        }
    }

    #[tokio::test]
    async fn 찾기_출력과_오류의_시크릿은_가린_글을_읽는다() {
        let fake = Fake::new();
        fake.set("exec", "5 10 curl -H token=SECRETVALUE1\n");
        let mut input = scan_input(&fake);
        input.secrets = vec![("T".into(), "SECRETVALUE1".into())];
        let ScanOutcome::Processes(found) = scan_processes(&input, "api", None).await else { panic!() };
        assert!(!found[0].command.contains("SECRETVALUE1"), "{:?}", found[0].command);
        let fake = Fake::new();
        fake.fail("exec", 1, "boom SECRETVALUE1");
        let ScanOutcome::Error(message) = scan_processes(&{ let mut i = scan_input(&fake); i.secrets = input.secrets.clone(); i }, "api", None).await else { panic!() };
        assert!(!message.contains("SECRETVALUE1"), "{message}");
    }

    async fn stray(fake: &Fake, services: &[&str], baseline: Vec<(String, Vec<(f64, String)>)>) -> Result<Vec<StrayReport>, String> {
        stray_processes(Arc::new(scan_input(fake)), services.iter().map(|s| (*s).to_owned()).collect(), baseline, Arc::new(Cancel::default())).await
    }

    #[tokio::test]
    async fn 기준선에_없던_프로세스만_알리고_멈춘_서비스는_건너뛴다() {
        let fake = Fake::new();
        fake.set("ps", STATE_RUNNING).set("exec", "7 100 node\n15 200 sh -c loop\n");
        let reports = stray(&fake, &["api"], vec![("api".into(), vec![(7.0, "100".into())])]).await.unwrap();
        assert_eq!(reports, vec![StrayReport { service: "api".into(), error: None, processes: vec![(15.0, "sh -c loop".into())] }]);
        // 기준선이 없으면 모두 모르는 것이다
        let reports = stray(&fake, &["api"], Vec::new()).await.unwrap();
        assert_eq!(reports[0].processes.len(), 2);
        // 기준선과 같으면 보고할 것이 없다
        assert!(stray(&fake, &["api"], vec![("api".into(), vec![(7.0, "100".into()), (15.0, "200".into())])]).await.unwrap().is_empty());
        // 멈춘 서비스는 찾지 않는다
        let stopped = Fake::new();
        stopped.set("ps", "{\"Service\":\"api\",\"State\":\"exited\"}\n").set("exec", "7 100 node\n");
        assert!(stray(&stopped, &["api"], Vec::new()).await.unwrap().is_empty());
        assert!(!stopped.calls().iter().any(|call| call.contains(" exec ")));
        // 출력이 없으면(컨테이너가 없다) 멈춘 것으로 본다
        let none = Fake::new();
        assert!(stray(&none, &["api"], Vec::new()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn 읽지_못하면_그_서비스는_오류로_보고하고_상태를_읽지_못하면_전체가_실패한다() {
        let fake = Fake::new();
        fake.set("ps", STATE_RUNNING).fail("exec", 3, "/proc/1/stat를 읽지 못했습니다");
        let reports = stray(&fake, &["api"], vec![("api".into(), vec![(7.0, "100".into())])]).await.unwrap();
        assert_eq!(reports.len(), 1);
        assert!(reports[0].error.as_deref().unwrap().starts_with("서비스 안의 프로세스를 읽지 못했습니다"), "{reports:?}");
        // 상태 출력이 JSON이 아니면 "멈춘 서비스"로 보고 통과시키지 않는다
        let garbled = Fake::new();
        garbled.set("ps", "{not json").set("exec", "");
        assert!(stray(&garbled, &["api"], Vec::new()).await.is_err());
    }

    #[tokio::test]
    async fn 서비스_여럿은_이름_순서대로_보고한다() {
        let fake = Fake::new();
        fake.set("ps", "[{\"Service\":\"x\",\"State\":\"running\"}]").set("exec", "9 1 a\n");
        let reports = stray(&fake, &["a", "b", "c"], Vec::new()).await.unwrap();
        assert_eq!(reports.iter().map(|r| r.service.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    }

    // ── 인프라 확인 ──

    #[tokio::test]
    async fn running이_아닌_서비스와_출력에_없는_서비스가_빠진_것이다() {
        let fake = Fake::new();
        fake.set("ps", "{\"Service\":\"edge\",\"State\":\"running\"}\n{\"Service\":\"db\",\"State\":\"exited\"}\n");
        let names: Vec<String> = ["api", "db", "edge"].iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(missing_services(&compose(&fake), "/tmp/o.yaml", &names, None).await, vec!["api".to_owned(), "db".to_owned()]);
        assert!(fake.calls()[0].ends_with("ps --all --format json api db edge"), "{:?}", fake.calls());
        assert!(missing_services(&compose(&fake), "/tmp/o.yaml", &[], None).await.is_empty());
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn ps_출력을_해석하지_못하면_모두_running이_아니다() {
        let fake = Fake::new();
        fake.set("ps", "{not json");
        let names: Vec<String> = ["api", "edge"].iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(missing_services(&compose(&fake), "/tmp/o.yaml", &names, None).await, names);
        // 비0 종료여도 출력은 읽는다(옛 TS와 같다). 출력이 없으면 모두 없다
        let failed = Fake::new();
        failed.fail("ps", 1, "daemon down");
        assert_eq!(missing_services(&compose(&failed), "/tmp/o.yaml", &names, None).await, names);
    }
}
