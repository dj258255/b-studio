//! 루프백 HTTP 서버의 전송(ADR-201, 4f A7a). 훅 서버(`packages/agent/src/hook-server.ts`)가 쓰던 `node:http` 서버를 대신한다.
//!
//! 여기가 맡는 것: 127.0.0.1의 임의 포트 열기, 요청마다 Host·토큰·메서드·라우트 확인, 본문 상한, 닫기(열린 연결까지).
//! 맡지 않는 것: 본문 해석과 응답 만들기. 원래 바이트를 콜백에 그대로 넘기고, 콜백이 상태와 본문을 돌려준다.
//! 본문을 여기서 JSON으로 읽지 않는 이유: `JSON.parse`와 받는 입력이 달라서(짝 없는 서로게이트 이스케이프, 중복 키, 큰 수) 옛 코드가 `{}`로 두던 입력을
//! 다르게 읽으면 쓰기 직전 훅이 파일 경로를 보는지 못 보는지가 갈린다.
//!
//! 요청 하나의 순서는 ① Host ② 토큰 ③ 메서드와 요청 대상 ④ 본문 상한 ⑤ 콜백이다(옛 서버와 같다). 각 단계는 막는 쪽이다
//! (`host_allowed`·`token_matches`는 `bstudio_guard::connection_judge`의 여는 쪽 판정이고, 모르는 꼴은 맞지 않는 것으로 처리한다).
//!
//! HTTP/1.1 머리는 hyper에 맡기지 않고 직접 읽는다. 처음에는 hyper를 썼으나 차등 시험이 Node보다 넓은 자리를 세 군데 찾았다:
//! (1) `Uri`가 요청 대상의 `#프래그먼트`를 지워 `/stop#x`가 `/stop` 라우트가 된다(Node의 `req.url`은 원문이라 404였다),
//! (2) 줄 끝이 LF만이어도 받는다, (3) 같은 값의 Content-Length 둘, Content-Length와 chunked를 함께 보낸 것도 받는다. 모두 Node(llhttp)는 거절한다.
//! 머리를 직접 읽으면 요청 대상 원문과 Host·Authorization 원본 바이트를 그대로 볼 수 있고, 받는 꼴을 Node보다 좁은 부분집합으로 고정한다:
//! 모르는 꼴은 응답 없이 연결을 끊는다(Node의 `clientError`와 같다).
//!
//! Node와 맞춘 것
//! - Host·Authorization 헤더 값은 latin1(바이트 하나가 U+0000..U+00FF 한 글자)로 읽는다. Node의 `req.headers`가 그렇다. UTF-8로 읽으면
//!   허용 이름에 비 ASCII 글자가 있을 때 Node가 거절하던 요청을 받게 된다(넓어진다)
//! - 헤더가 여럿이면 첫 번째를 쓴다(Node는 `host`·`authorization`의 뒤 값을 버린다)
//! - 요청 대상은 원문 그대로 라우트 이름과 견준다. 절대 형식(`POST http://127.0.0.1:1/stop`)·`*`·프래그먼트가 붙은 것은 라우트가 아니다
//! - 요청을 읽는 데 시간 제한이 없다(`requestTimeout=0`·`headersTimeout=0`). 응답 뒤 다음 요청을 기다리는 연결만 5초 뒤 닫는다(`keepAliveTimeout`)
//! - 머리 크기 상한은 16KiB(`maxHeaderSize`), HTTP/1.1에서 Host가 없으면 400
//!
//! 의도한 차이(모두 거절 쪽): 요청 줄 공백이 둘, 요청 줄 앞의 빈 줄, `HTTP/0.9` 꼴, `HTTP/2.0` 같은 버전 글자, `Expect`가 `100-continue`가 아닌 것, 줄 접기,
//! 청크 확장·트레일러는 Node가 받거나 다른 응답을 주지만 여기서는 응답 없이 끊는다. 본문이 상한보다 크다고 `Content-Length`가 밝히면 본문을 읽기 전에 413이다
//! (Node는 상한을 넘는 바이트가 올 때까지 기다린다). 거절한 요청은 연결을 닫는다(Node는 본문을 건너뛰고 다음 요청을 읽는다).

use crate::mcp_server::{self, PostPlan, RpcRequest, ServerInfo, Step, Tool, ToolReply};
use bstudio_guard::connection_judge::{authorize, host_allowed, token_matches};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Mutex};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::timeout;

/// 본문 상한(바이트). 누적이 이 값을 **넘는** 순간 413이다(정확히 이 값은 받는다)
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// 요청 머리(요청 줄 + 헤더 + 끝 빈 줄)의 크기 상한. Node의 `maxHeaderSize` 기본값과 같다
pub const MAX_HEAD_BYTES: usize = 16 * 1024;
/// 응답 뒤 다음 요청을 기다리는 시간. Node의 `keepAliveTimeout` 기본값(5초)과 같다
const KEEP_ALIVE_IDLE: Duration = Duration::from_secs(5);
/// 본문을 읽지 않고 응답한 연결을 닫기 전에 클라이언트가 보내던 것을 흘려 보내는(읽어서 버리는) 한도. 바로 닫으면 커널이 RST를 보내 응답이 사라진다
const LINGER_MAX_BYTES: usize = 64 * 1024 * 1024;
const LINGER_MAX_TIME: Duration = Duration::from_secs(3);

/// 라우트·본문 검사를 통과한 요청. `route`는 `LoopbackConfig::routes`의 번호다(이름은 TS가 그 번호로 찾는다)
pub struct HandlerRequest {
    pub route: usize,
    pub body: Vec<u8>,
}

/// 콜백의 답. 응답 헤더는 `content-type: application/json` 하나다(A7b가 MCP를 얹을 때 이 꼴을 넓힌다)
pub struct HandlerResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub type Handler = Arc<dyn Fn(HandlerRequest) -> Pin<Box<dyn Future<Output = HandlerResponse> + Send>> + Send + Sync>;

pub struct LoopbackConfig {
    pub token: String,
    /// 루프백 말고 받을 Host 이름(TS가 `encodeLoneSurrogates`한 꼴)
    pub allowed_hosts: Vec<String>,
    /// 등록된 라우트의 요청 대상(쿼리 포함 원문, `encodeLoneSurrogates`한 꼴). POST이고 이 가운데 하나와 정확히 같은 요청만 콜백에 간다
    pub routes: Vec<String>,
    pub handler: Handler,
    pub max_body_bytes: usize,
}

struct Shared {
    token: String,
    allowed_hosts: Vec<String>,
    max_body_bytes: usize,
    mode: Mode,
}

/// 이 서버가 받은 요청으로 하는 일. 훅 서버는 라우트에 맞는 요청의 바이트를 콜백에 넘기고, MCP 서버는 요청을 직접 풀어 도구 콜백을 부른다
enum Mode {
    Hook { routes: Vec<String>, handler: Handler },
    Mcp(McpShared),
}

/// 도구 목록 콜백. 도구 목록의 JSON(`[{name, description?, input_schema}]`)이나 실패 이유를 돌려준다. HTTP 요청마다 필요할 때 한 번 부른다
pub type ListTools = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync>;
/// 도구 실행 콜백. 도구 이름과 검사를 통과한 인자(JSON)를 받아 결과를 돌려준다
pub type CallTool = Arc<dyn Fn(String, String) -> Pin<Box<dyn Future<Output = ToolReply> + Send>> + Send + Sync>;

pub struct McpConfig {
    pub token: String,
    /// 루프백 말고 받을 Host 이름(TS가 `encodeLoneSurrogates`한 꼴)
    pub allowed_hosts: Vec<String>,
    /// `initialize`가 돌려주는 서버 이름(`encodeLoneSurrogates`한 꼴)
    pub name: String,
    /// 스키마의 required에 없는 인자를 선택으로 연다(`zodShape`의 honorRequired)
    pub honor_required: bool,
    pub list: ListTools,
    pub call: CallTool,
    pub max_body_bytes: usize,
    /// SSE 응답이 열려 있는 동안 이 간격으로 `: keepalive` 주석을 보낸다(SDK는 15초)
    pub keep_alive: Duration,
}

struct McpShared {
    name: String,
    honor_required: bool,
    list: ListTools,
    call: CallTool,
    keep_alive: Duration,
}

/// SDK의 SSE keepalive 간격
pub const SSE_KEEP_ALIVE: Duration = Duration::from_secs(15);

pub struct LoopbackServer {
    pub port: u16,
    shutdown: watch::Sender<bool>,
    accept: Mutex<Option<JoinHandle<()>>>,
}

impl LoopbackServer {
    /// 127.0.0.1의 임의 포트를 연다(훅 서버)
    pub async fn start(config: LoopbackConfig) -> std::io::Result<Self> {
        let shared = Shared { token: config.token, allowed_hosts: config.allowed_hosts, max_body_bytes: config.max_body_bytes, mode: Mode::Hook { routes: config.routes, handler: config.handler } };
        Self::listen(shared).await
    }

    /// 127.0.0.1의 임의 포트를 연다(MCP 도구 서버, ADR-201 A7b)
    pub async fn start_mcp(config: McpConfig) -> std::io::Result<Self> {
        let mcp = McpShared { name: config.name, honor_required: config.honor_required, list: config.list, call: config.call, keep_alive: config.keep_alive };
        Self::listen(Shared { token: config.token, allowed_hosts: config.allowed_hosts, max_body_bytes: config.max_body_bytes, mode: Mode::Mcp(mcp) }).await
    }

    async fn listen(shared: Shared) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let shared = Arc::new(shared);
        let (shutdown, stop) = watch::channel(false);
        let accept = tokio::spawn(accept_loop(listener, shared, stop));
        Ok(Self { port, shutdown, accept: Mutex::new(Some(accept)) })
    }

    /// 새 연결을 받지 않고, 열린 연결(처리 중인 것 포함)을 끊고, 끝나면 돌아온다. 두 번 불러도 된다
    pub async fn close(&self) {
        let _ = self.shutdown.send(true);
        let task = self.accept.lock().await.take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

impl Drop for LoopbackServer {
    fn drop(&mut self) {
        // close를 부르지 못하고 버려져도 listener·연결이 남지 않게 한다
        let _ = self.shutdown.send(true);
    }
}

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    let mut connections: JoinSet<()> = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = async { let _ = stop.wait_for(|stopped| *stopped).await; } => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let _ = stream.set_nodelay(true);
                    let shared = shared.clone();
                    connections.spawn(async move { serve_connection(stream, shared).await });
                }
                // 파일 기술자 부족 같은 일시 오류에 바쁜 루프가 되지 않게 잠깐 쉰다
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            // 끝난 연결 작업을 치운다
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    // 새 연결을 받지 않는다(listener를 닫는다). 열린 연결은 끊고 끝나기를 기다린다
    drop(listener);
    connections.shutdown().await;
}

// ── 요청 머리 ──

/// llhttp가 아는 메서드 가운데 이 서버가 읽는 것. `CONNECT`는 Node가 응답 없이 끊으므로 뺐다. 이 밖은 모르는 꼴이라 끊는다
const METHODS: [&str; 33] = [
    "DELETE", "GET", "HEAD", "POST", "PUT", "OPTIONS", "TRACE", "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND", "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY", "CHECKOUT", "MERGE", "M-SEARCH", "NOTIFY",
    "SUBSCRIBE", "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE",
];

#[derive(Debug, PartialEq, Eq)]
pub enum BodyKind {
    None,
    Length(u64),
    Chunked,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    /// 요청 대상 원문(ASCII). 라우트 이름과 이 글자 그대로 견준다
    pub target: String,
    pub http11: bool,
    /// Host 헤더 첫 값을 latin1로 읽은 글. 없으면 `None`
    pub host: Option<String>,
    pub authorization: Option<String>,
    pub body: BodyKind,
    pub expect_continue: bool,
    pub keep_alive: bool,
    /// 모든 헤더(이름은 소문자, 값은 latin1, 받은 순서). MCP가 Accept·Content-Type·mcp-protocol-version을 읽는다
    pub headers: Vec<(String, String)>,
}

impl Head {
    /// 같은 이름의 헤더가 여럿이면 `, `로 이은 값(`Headers.get`·Node의 `req.headers`가 이어 붙이는 방식). 없으면 `None`
    pub fn joined(&self, name: &str) -> Option<String> {
        let values: Vec<&str> = self.headers.iter().filter(|(key, _)| key == name).map(|(_, value)| value.as_str()).collect();
        (!values.is_empty()).then(|| values.join(", "))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum HeadError {
    /// 모르는 꼴. 응답 없이 연결을 끊는다(Node의 `clientError`)
    Drop,
    /// HTTP/1.1인데 Host가 없다. Node처럼 400
    MissingHost,
}

fn is_tchar(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

/// 요청 대상의 꼴: `/`로 시작(origin-form), `*`, 또는 `스킴://…`(absolute-form). 바이트는 0x21..0x7E만
fn valid_target(target: &[u8]) -> bool {
    if target.is_empty() || !target.iter().all(|byte| (0x21..=0x7e).contains(byte)) {
        return false;
    }
    if target[0] == b'/' || target == b"*" {
        return true;
    }
    // absolute-form: 알파벳으로 시작하는 스킴 뒤에 "://"
    let scheme_end = target.iter().position(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')));
    target[0].is_ascii_alphabetic() && scheme_end.is_some_and(|end| target[end..].starts_with(b"://"))
}

fn trim_ows(value: &[u8]) -> &[u8] {
    let start = value.iter().position(|byte| !matches!(byte, b' ' | b'\t')).unwrap_or(value.len());
    let end = value.iter().rposition(|byte| !matches!(byte, b' ' | b'\t')).map_or(start, |at| at + 1);
    &value[start..end]
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

/// 요청 머리(끝 빈 줄까지)를 읽는다. 받는 꼴은 RFC 9112의 엄격한 부분집합이다: 줄 끝은 CRLF만, 요청 줄은 공백 하나씩, 헤더 이름은 token,
/// 값에 제어 문자 없음, 줄 접기 없음, Content-Length는 한 번·숫자만, Transfer-Encoding은 `chunked` 하나이고 Content-Length와 함께 오지 않으며,
/// 막는 쪽: 모르는 꼴은 `Err`다
pub fn parse_head(head: &[u8]) -> Result<Head, HeadError> {
    let body = head.strip_suffix(b"\r\n\r\n").ok_or(HeadError::Drop)?;
    // CRLF만 받는다: 줄 끝의 CR LF 쌍 말고는 CR도 LF도 나오면 안 된다(LF만으로 끝낸 줄, 줄 안의 CR은 Node도 거절한다)
    let owned = split_crlf(body);
    if owned.iter().any(|line| line.contains(&b'\r') || line.contains(&b'\n')) {
        return Err(HeadError::Drop);
    }
    let request_line = owned[0];
    let parts: Vec<&[u8]> = request_line.split(|byte| *byte == b' ').collect();
    let [method, target, version] = parts[..] else { return Err(HeadError::Drop) };
    let method = std::str::from_utf8(method).map_err(|_| HeadError::Drop)?;
    if !METHODS.contains(&method) || !valid_target(target) {
        return Err(HeadError::Drop);
    }
    let http11 = match version {
        b"HTTP/1.1" => true,
        b"HTTP/1.0" => false,
        _ => return Err(HeadError::Drop),
    };

    let mut host = None;
    let mut authorization = None;
    let mut content_lengths: Vec<&[u8]> = Vec::new();
    let mut transfer_encodings: Vec<&[u8]> = Vec::new();
    let mut connection_close = false;
    let mut connection_keep_alive = false;
    let mut expect_continue = false;
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in &owned[1..] {
        let colon = line.iter().position(|byte| *byte == b':').ok_or(HeadError::Drop)?;
        let (name, value) = (&line[..colon], trim_ows(&line[colon + 1..]));
        if name.is_empty() || !name.iter().all(|byte| is_tchar(*byte)) || !value.iter().all(|byte| matches!(byte, 0x09 | 0x20..=0x7e | 0x80..=0xff)) {
            return Err(HeadError::Drop);
        }
        let name = name.to_ascii_lowercase();
        headers.push((String::from_utf8_lossy(&name).into_owned(), latin1(value)));
        match name.as_slice() {
            b"host" => host = host.or_else(|| Some(latin1(value))),
            b"authorization" => authorization = authorization.or_else(|| Some(latin1(value))),
            b"content-length" => content_lengths.push(value),
            b"transfer-encoding" => transfer_encodings.push(value),
            b"connection" => {
                for token in value.split(|byte| *byte == b',') {
                    match trim_ows(token).to_ascii_lowercase().as_slice() {
                        b"close" => connection_close = true,
                        b"keep-alive" => connection_keep_alive = true,
                        // 그 밖의 이름(`upgrade` 등)은 이 서버가 쓰지 않는다. Node도 'upgrade' 처리기가 없으면 일반 요청으로 처리한다
                        _ => {}
                    }
                }
            }
            b"expect" => {
                if value.eq_ignore_ascii_case(b"100-continue") {
                    expect_continue = true;
                } else {
                    return Err(HeadError::Drop);
                }
            }
            _ => {}
        }
    }

    let body = match (content_lengths.as_slice(), transfer_encodings.as_slice()) {
        ([], []) => BodyKind::None,
        ([length], []) => {
            if length.is_empty() || !length.iter().all(u8::is_ascii_digit) {
                return Err(HeadError::Drop);
            }
            // 20자리를 넘는 값은 u64를 넘으니 가장 큰 값으로 본다(상한을 넘으므로 본문을 읽기 전에 413이 된다)
            BodyKind::Length(std::str::from_utf8(length).ok().and_then(|text| text.parse::<u64>().ok()).unwrap_or(u64::MAX))
        }
        ([], [encoding]) if encoding.eq_ignore_ascii_case(b"chunked") => BodyKind::Chunked,
        _ => return Err(HeadError::Drop),
    };
    if http11 && host.is_none() {
        return Err(HeadError::MissingHost);
    }
    let keep_alive = if http11 { !connection_close } else { connection_keep_alive && !connection_close };
    Ok(Head { method: method.to_owned(), target: String::from_utf8_lossy(target).into_owned(), http11, host, authorization, body, expect_continue, keep_alive, headers })
}

/// 메서드가 POST이고 요청 대상 원문이 등록된 라우트와 정확히 같으면 그 번호. 막는 쪽: 모르는 꼴은 `None`(404)
pub fn route_index(method: &str, target: &str, routes: &[String]) -> Option<usize> {
    if method != "POST" {
        return None;
    }
    routes.iter().position(|route| route == target)
}

fn split_crlf(mut rest: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    while let Some(at) = rest.windows(2).position(|pair| pair == b"\r\n") {
        lines.push(&rest[..at]);
        rest = &rest[at + 2..];
    }
    lines.push(rest);
    lines
}

// ── 연결 ──

/// 머리를 `buf`에서 `\r\n\r\n`까지 읽어 그 길이를 돌려준다. 상한을 넘거나 연결이 끊기면, 또는 LF만으로 끝난 줄이 보이면 `None`(끊는다).
/// 첫 요청의 머리는 시간 제한 없이 기다리고, 앞 요청 뒤 다음 요청을 기다리는 동안만 `KEEP_ALIVE_IDLE`이다
async fn read_head(stream: &mut TcpStream, buf: &mut Vec<u8>, idle_limit: bool) -> Option<usize> {
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(at) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            return (at + 4 <= MAX_HEAD_BYTES).then_some(at + 4);
        }
        if buf.len() > MAX_HEAD_BYTES || buf.iter().enumerate().any(|(i, byte)| *byte == b'\n' && (i == 0 || buf[i - 1] != b'\r')) {
            return None;
        }
        let read = if idle_limit && buf.is_empty() { timeout(KEEP_ALIVE_IDLE, stream.read(&mut chunk)).await.ok()?.ok()? } else { stream.read(&mut chunk).await.ok()? };
        if read == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..read]);
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        500 => "Internal Server Error",
        _ => "Status",
    }
}

async fn write_response(stream: &mut TcpStream, status: u16, content_type: Option<&str>, body: &[u8], keep_alive: bool, with_body: bool) -> bool {
    let headers: Vec<(&str, &str)> = content_type.map(|value| ("content-type", value)).into_iter().collect();
    write_response_with(stream, status, &headers, body, keep_alive, with_body).await
}

/// 헤더를 여럿 실을 수 있는 응답 쓰기. `content-length`는 여기서 붙인다
async fn write_response_with(stream: &mut TcpStream, status: u16, headers: &[(&str, &str)], body: &[u8], keep_alive: bool, with_body: bool) -> bool {
    let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (name, value) in headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!("content-length: {}\r\n", body.len()));
    if !keep_alive {
        out.push_str("connection: close\r\n");
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    if with_body {
        bytes.extend_from_slice(body);
    }
    stream.write_all(&bytes).await.is_ok()
}

/// 응답을 보낸 뒤 연결을 닫는다. 클라이언트가 아직 본문을 보내는 중일 수 있으니 쓰기 쪽만 닫고 보내던 것을 한도까지 읽어 버린다
/// (바로 닫으면 읽지 않은 바이트가 남아 커널이 RST를 보내고, 클라이언트가 응답을 읽기 전에 연결이 깨진다)
async fn close_gracefully(mut stream: TcpStream) {
    let _ = stream.shutdown().await;
    let drain = async {
        let mut sink = [0u8; 16 * 1024];
        let mut total = 0usize;
        loop {
            match stream.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    total += read;
                    if total > LINGER_MAX_BYTES {
                        break;
                    }
                }
            }
        }
    };
    let _ = timeout(LINGER_MAX_TIME, drain).await;
}

async fn serve_connection(mut stream: TcpStream, shared: Arc<Shared>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut served = false;
    loop {
        let Some(head_len) = read_head(&mut stream, &mut buf, served).await else { return };
        served = true;
        let raw: Vec<u8> = buf.drain(..head_len).collect();
        let head = match parse_head(&raw) {
            Ok(head) => head,
            Err(HeadError::MissingHost) => {
                write_response(&mut stream, 400, None, b"", false, false).await;
                return close_gracefully(stream).await;
            }
            // Node의 clientError처럼 응답 없이 끊는다
            Err(HeadError::Drop) => return,
        };
        match handle_request(&mut stream, &mut buf, head, &shared).await {
            Next::KeepAlive => {}
            Next::Close => return,
            Next::Linger => return close_gracefully(stream).await,
        }
    }
}

enum Next {
    KeepAlive,
    /// 응답했거나 응답할 수 없고, 읽지 않은 것이 없다
    Close,
    /// 거절했다. 본문을 읽지 않았을 수 있으니 흘려 보내고 닫는다
    Linger,
}

fn json_reply(status: u16, text: &str) -> (u16, Vec<u8>) {
    (status, text.as_bytes().to_vec())
}

async fn handle_request(stream: &mut TcpStream, buf: &mut Vec<u8>, head: Head, shared: &Shared) -> Next {
    let (routes, handler) = match &shared.mode {
        Mode::Hook { routes, handler } => (routes, handler),
        Mode::Mcp(mcp) => return handle_mcp(stream, buf, head, shared, mcp).await,
    };
    // ① Host ② 토큰 ③ 메서드·라우트. 거절하면 본문을 읽지 않고 응답한 뒤 닫는다
    let denied = if !host_allowed(head.host.as_deref(), &shared.allowed_hosts) {
        Some(json_reply(403, r#"{"error":"루프백에서만 접근할 수 있습니다"}"#))
    } else if !token_matches(head.authorization.as_deref(), &shared.token) {
        Some(json_reply(401, r#"{"error":"unauthorized"}"#))
    } else if route_index(&head.method, &head.target, routes).is_none() {
        Some(json_reply(404, r#"{"error":"not found"}"#))
    } else {
        None
    };
    let with_body = head.method != "HEAD";
    if let Some((status, body)) = denied {
        write_response(stream, status, Some("application/json"), &body, false, with_body).await;
        return Next::Linger;
    }
    let route = route_index(&head.method, &head.target, routes).unwrap_or(usize::MAX);

    // ④ 본문. 상한은 읽기 전에(선언된 길이) 그리고 읽는 동안(누적) 본다
    let max = shared.max_body_bytes;
    let oversize = match head.body {
        BodyKind::Length(length) => length > max as u64,
        _ => false,
    };
    if oversize {
        let (status, body) = json_reply(413, r#"{"error":"too large"}"#);
        write_response(stream, status, Some("application/json"), &body, false, with_body).await;
        return Next::Linger;
    }
    if head.expect_continue && head.body != BodyKind::None && stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await.is_err() {
        return Next::Close;
    }
    let body = match read_body(stream, buf, &head.body, max).await {
        BodyRead::Done(bytes) => bytes,
        BodyRead::TooLarge => {
            let (status, body) = json_reply(413, r#"{"error":"too large"}"#);
            write_response(stream, status, Some("application/json"), &body, false, with_body).await;
            return Next::Linger;
        }
        // 끝까지 받지 못했다(끊겼거나 청크 형식이 깨졌다). 처리를 부르지 않는다
        BodyRead::Broken => return Next::Close,
    };

    // ⑤ 콜백
    let answer = handler(HandlerRequest { route, body }).await;
    let ok = write_response(stream, answer.status, Some("application/json"), &answer.body, head.keep_alive, with_body).await;
    if ok && head.keep_alive {
        Next::KeepAlive
    } else {
        Next::Close
    }
}

// ── MCP 서버(ADR-201, 4f A7b) ──
// 옛 서버는 `node:http`로 받아 `@hono/node-server`가 Web 요청으로 바꾼 뒤 SDK 트랜스포트가 처리했다. 옛 서버는 요청 경로를 보지 않고(`/mcp`가 아니어도 같다),
// 메서드로만 갈라서 POST·GET·DELETE를 처리하고 나머지는 405로 답한다.

/// 거절 응답: JSON-RPC 오류 본문, content-type은 application/json
async fn write_rpc_error(stream: &mut TcpStream, status: u16, code: i32, message: &str, keep_alive: bool, with_body: bool) -> bool {
    let body = mcp_server::http_error_body(code, message);
    write_response_with(stream, status, &[("content-type", "application/json")], body.as_bytes(), keep_alive, with_body).await
}

/// `@hono/node-server`의 `buildUrl`이 요청 주소를 만들지 못하는 꼴인가의 반대. 만들지 못하면 SDK에 닿기 전에 본문 없는 400이다
fn request_url_valid(host: Option<&str>, target: &str) -> bool {
    if !target.starts_with('/') && (target.starts_with("http://") || target.starts_with("https://")) {
        return url::Url::parse(target).is_ok();
    }
    let Some(host) = host.filter(|host| !host.is_empty()) else { return false };
    let full = format!("http://{host}{target}");
    if !hono_plain_host(host) {
        let Ok(parsed) = url::Url::parse(&full) else { return false };
        let hostname = parsed.host_str().unwrap_or("");
        if hostname.chars().count() != host.chars().count() {
            let bare = if host.contains(':') { host.rsplit_once(':').filter(|(_, port)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())).map_or(host, |(name, _)| name) } else { host };
            return hostname == bare.to_lowercase();
        }
        return true;
    }
    if target.is_empty() {
        return true;
    }
    if !target.starts_with('/') {
        return false;
    }
    if !hono_plain_request_url(target) || has_dot_segment(target) {
        return url::Url::parse(&full).is_ok();
    }
    true
}

/// hono의 `reValidHost`: `^[a-z0-9._-]+(?::(?:[1-5]\d{3,4}|[6-9]\d{3}))?$`
fn hono_plain_host(host: &str) -> bool {
    let (name, port) = match host.split_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')) {
        return false;
    }
    let Some(port) = port else { return true };
    let digits = port.bytes().all(|b| b.is_ascii_digit());
    let first = port.as_bytes().first().copied().unwrap_or(b'0');
    digits && ((matches!(first, b'1'..=b'5') && (4..=5).contains(&port.len())) || (matches!(first, b'6'..=b'9') && port.len() == 4))
}

/// hono의 `reValidRequestUrl`: `^\/[!#$&-;=?-\[\]_a-z~]*$`
fn hono_plain_request_url(target: &str) -> bool {
    target.starts_with('/') && target.bytes().skip(1).all(|b| matches!(b, b'!' | b'#' | b'$' | b'&'..=b';' | b'=' | b'?'..=b'[' | b']' | b'_' | b'a'..=b'z' | b'~'))
}

/// hono의 `reDotSegment`: `\/\.\.?(?:[/?#]|$)`
fn has_dot_segment(target: &str) -> bool {
    let bytes = target.as_bytes();
    let ends = |at: usize| bytes.get(at).is_none_or(|b| matches!(b, b'/' | b'?' | b'#'));
    (0..bytes.len()).any(|i| bytes[i] == b'/' && ((bytes[i + 1..].starts_with(b"..") && ends(i + 3)) || (bytes[i + 1..].starts_with(b".") && ends(i + 2))))
}

/// 거절·단순 응답 뒤: 읽지 않은 본문이 있으면 흘려 보내고 닫고, 없으면 연결 유지 여부를 따른다
fn after_simple(head: &Head, ok: bool) -> Next {
    if head.body != BodyKind::None {
        Next::Linger
    } else if ok && head.keep_alive {
        Next::KeepAlive
    } else {
        Next::Close
    }
}

async fn handle_mcp(stream: &mut TcpStream, buf: &mut Vec<u8>, head: Head, shared: &Shared, mcp: &McpShared) -> Next {
    let with_body = head.method != "HEAD";
    // ① Host·토큰. 옛 서버가 요청마다 가장 먼저 `authorize`를 불렀다(글과 JSON-RPC 코드가 여기서 정해진다)
    if let Some((status, message)) = authorize(head.host.as_deref(), head.authorization.as_deref(), &shared.token, &shared.allowed_hosts) {
        write_rpc_error(stream, status, i32::from(status) * -100, message, false, with_body).await;
        return Next::Linger;
    }
    // ② hono가 요청 주소를 만들지 못하는 꼴
    if !request_url_valid(head.host.as_deref(), &head.target) {
        write_response_with(stream, 400, &[], b"", false, with_body).await;
        return Next::Linger;
    }
    match head.method.as_str() {
        "POST" => mcp_post(stream, buf, head, shared, mcp).await,
        "GET" => mcp_get(stream, head, mcp).await,
        "DELETE" => {
            if let Some(message) = mcp_server::protocol_version_error(head.joined("mcp-protocol-version").as_deref()) {
                let ok = write_rpc_error(stream, 400, -32000, &message, head.keep_alive, true).await;
                return after_simple(&head, ok);
            }
            let ok = write_response_with(stream, 200, &[], b"", head.keep_alive, true).await;
            after_simple(&head, ok)
        }
        _ => {
            let body = mcp_server::http_error_body(-32000, mcp_server::METHOD_NOT_ALLOWED);
            let ok = write_response_with(stream, 405, &[("allow", "GET, POST, DELETE"), ("content-type", "application/json")], body.as_bytes(), head.keep_alive, with_body).await;
            after_simple(&head, ok)
        }
    }
}

async fn mcp_post(stream: &mut TcpStream, buf: &mut Vec<u8>, head: Head, shared: &Shared, mcp: &McpShared) -> Next {
    // SDK의 순서: Accept → Content-Type → 본문(상한·JSON) → 배치·메시지 꼴 → 프로토콜 버전. 본문을 읽기 전의 거절은 본문을 흘려 보내고 닫는다
    if !mcp_server::accepts(head.joined("accept").as_deref(), &["application/json", "text/event-stream"]) {
        write_rpc_error(stream, 406, -32000, mcp_server::NOT_ACCEPTABLE_POST, false, true).await;
        return Next::Linger;
    }
    if !mcp_server::is_json_content_type(head.joined("content-type").as_deref()) {
        write_rpc_error(stream, 415, -32000, mcp_server::UNSUPPORTED_MEDIA_TYPE, false, true).await;
        return Next::Linger;
    }
    let max = shared.max_body_bytes;
    let too_large = matches!(head.body, BodyKind::Length(length) if length > max as u64);
    if too_large {
        write_rpc_error(stream, 413, -32000, &mcp_server::payload_too_large(max), false, true).await;
        return Next::Linger;
    }
    if head.expect_continue && head.body != BodyKind::None && stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await.is_err() {
        return Next::Close;
    }
    let body = match read_body(stream, buf, &head.body, max).await {
        BodyRead::Done(bytes) => bytes,
        BodyRead::TooLarge => {
            write_rpc_error(stream, 413, -32000, &mcp_server::payload_too_large(max), false, true).await;
            return Next::Linger;
        }
        BodyRead::Broken => return Next::Close,
    };
    match mcp_server::plan_post(&body, head.joined("mcp-protocol-version").as_deref()) {
        PostPlan::Reject { status, code, message } => {
            let ok = write_rpc_error(stream, status, code, &message, head.keep_alive, true).await;
            if ok && head.keep_alive { Next::KeepAlive } else { Next::Close }
        }
        PostPlan::Accepted => {
            let ok = write_response_with(stream, 202, &[], b"", head.keep_alive, true).await;
            if ok && head.keep_alive { Next::KeepAlive } else { Next::Close }
        }
        PostPlan::Requests(requests) => mcp_stream(stream, &head, mcp, requests).await,
    }
}

/// 응답 쓰기: HTTP/1.1이면 chunked 한 덩어리씩, HTTP/1.0이면 그대로(연결을 닫아 끝을 알린다)
async fn write_sse(stream: &mut TcpStream, chunked: bool, data: &str) -> bool {
    if !chunked {
        return stream.write_all(data.as_bytes()).await.is_ok();
    }
    let mut out = format!("{:x}\r\n", data.len()).into_bytes();
    out.extend_from_slice(data.as_bytes());
    out.extend_from_slice(b"\r\n");
    stream.write_all(&out).await.is_ok()
}

async fn write_sse_head(stream: &mut TcpStream, head: &Head) -> bool {
    let mut out = String::from("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache, no-transform\r\n");
    out.push_str(if head.keep_alive { "connection: keep-alive\r\n" } else { "connection: close\r\n" });
    out.push_str("x-accel-buffering: no\r\n");
    if head.http11 {
        out.push_str("transfer-encoding: chunked\r\n");
    }
    out.push_str("\r\n");
    stream.write_all(out.as_bytes()).await.is_ok()
}

/// 먼저 끝난 응답부터 내보내려고 만든 집합: 순서대로 한 번씩 폴링하고 끝난 것을 하나씩 돌려준다.
/// 요청마다 독립이라 느린 `run`이 다른 요청의 응답을 막지 않는다(SDK도 응답이 준비되는 대로 쓴다)
struct InOrder<'a> {
    /// (요청 id의 열쇠, 응답 메시지)
    futures: Vec<Pin<Box<dyn Future<Output = (String, String)> + Send + 'a>>>,
}

impl InOrder<'_> {
    async fn next(&mut self) -> Option<(String, String)> {
        if self.futures.is_empty() {
            return None;
        }
        std::future::poll_fn(|cx| {
            for index in 0..self.futures.len() {
                if let std::task::Poll::Ready(message) = self.futures[index].as_mut().poll(cx) {
                    drop(self.futures.remove(index));
                    return std::task::Poll::Ready(Some(message));
                }
            }
            std::task::Poll::Pending
        })
        .await
    }
}

async fn mcp_stream(stream: &mut TcpStream, head: &Head, mcp: &McpShared, requests: Vec<RpcRequest>) -> Next {
    // 도구 목록은 이 HTTP 요청에서 필요할 때 한 번 읽는다(함수로 준 목록은 요청마다 다시 읽는 것이 옛 동작이다)
    let tools: Option<Vec<Tool>> = if mcp_server::needs_tools(&requests) {
        match (mcp.list)().await.and_then(|text| mcp_server::parse_tools(&text, mcp.honor_required)) {
            Ok(tools) => Some(tools),
            Err(message) => {
                let body = mcp_server::internal_error_body(&message);
                let ok = write_response_with(stream, 500, &[("content-type", "application/json")], body.as_bytes(), head.keep_alive, true).await;
                return if ok && head.keep_alive { Next::KeepAlive } else { Next::Close };
            }
        }
    } else {
        None
    };
    let server = ServerInfo { name: &mcp.name };
    let mut pending = InOrder { futures: Vec::with_capacity(requests.len()) };
    // SDK는 응답을 요청 id로 묶는다: 같은 id의 요청이 둘이면 첫 응답으로 모든 id가 채워진 것으로 보고 스트림을 닫는다
    let mut expected: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
    for request in &requests {
        let step = mcp_server::handle_request(request, tools.as_deref(), &server);
        let call = match &step {
            Step::Call { name, args, .. } => Some((mcp.call)(name.clone(), args.clone())),
            Step::Done(_) => None,
        };
        let key = mcp_server::id_key(&request.id);
        expected.insert(key.clone());
        pending.futures.push(Box::pin(async move {
            let message = match (step, call) {
                (Step::Call { id, .. }, Some(call)) => mcp_server::call_result_message(&id, &call.await),
                (Step::Done(message), _) => message,
                (Step::Call { .. }, None) => String::new(),
            };
            (key, message)
        }));
    }
    if !write_sse_head(stream, head).await {
        return Next::Close;
    }
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + mcp.keep_alive, mcp.keep_alive);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            next = pending.next() => match next {
                Some((key, message)) => {
                    if !write_sse(stream, head.http11, &mcp_server::sse_event(&message)).await {
                        // 끊긴 연결: 이미 시작한 도구 실행은 끝까지 돈다(옛 서버도 그랬다)
                        return Next::Close;
                    }
                    answered.insert(key);
                    if answered.len() == expected.len() {
                        break;
                    }
                }
                None => break,
            },
            _ = tick.tick() => {
                if !write_sse(stream, head.http11, ": keepalive\n\n").await {
                    return Next::Close;
                }
            }
        }
    }
    if head.http11 {
        if stream.write_all(b"0\r\n\r\n").await.is_err() {
            return Next::Close;
        }
        return if head.keep_alive { Next::KeepAlive } else { Next::Close };
    }
    Next::Close
}

/// GET: SSE 스트림을 열어 두고 keepalive를 보낸다(서버가 먼저 보낼 메시지는 없다). 클라이언트가 끊으면 끝난다
async fn mcp_get(stream: &mut TcpStream, head: Head, mcp: &McpShared) -> Next {
    if !mcp_server::accepts(head.joined("accept").as_deref(), &["text/event-stream"]) {
        write_rpc_error(stream, 406, -32000, mcp_server::NOT_ACCEPTABLE_GET, false, true).await;
        return Next::Linger;
    }
    if let Some(message) = mcp_server::protocol_version_error(head.joined("mcp-protocol-version").as_deref()) {
        write_rpc_error(stream, 400, -32000, &message, false, true).await;
        return Next::Linger;
    }
    if !write_sse_head(stream, &head).await {
        return Next::Close;
    }
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + mcp.keep_alive, mcp.keep_alive);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut sink = [0u8; 1024];
    loop {
        tokio::select! {
            read = stream.read(&mut sink) => match read {
                Ok(0) | Err(_) => return Next::Close,
                Ok(_) => {}
            },
            _ = tick.tick() => {
                if !write_sse(stream, head.http11, ": keepalive\n\n").await {
                    return Next::Close;
                }
            }
        }
    }
}

enum BodyRead {
    Done(Vec<u8>),
    TooLarge,
    Broken,
}

/// `buf`에 이미 읽힌 바이트를 먼저 쓰고 모자란 만큼 소켓에서 읽는다. 읽은 만큼 `buf`에서 뺀다
async fn fill(stream: &mut TcpStream, buf: &mut Vec<u8>, needed: usize) -> bool {
    let mut chunk = [0u8; 16 * 1024];
    while buf.len() < needed {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(read) => buf.extend_from_slice(&chunk[..read]),
        }
    }
    true
}

async fn read_body(stream: &mut TcpStream, buf: &mut Vec<u8>, kind: &BodyKind, max: usize) -> BodyRead {
    match kind {
        BodyKind::None => BodyRead::Done(Vec::new()),
        BodyKind::Length(length) => {
            let length = *length as usize;
            if !fill(stream, buf, length).await {
                return BodyRead::Broken;
            }
            BodyRead::Done(buf.drain(..length).collect())
        }
        BodyKind::Chunked => {
            let mut body: Vec<u8> = Vec::new();
            loop {
                // 청크 크기 줄: 16진수만(확장은 받지 않는다), CRLF로 끝난다
                let line_end = loop {
                    if let Some(at) = buf.windows(2).position(|pair| pair == b"\r\n") {
                        break at;
                    }
                    // 크기 줄이 비정상으로 길면 끊는다
                    if buf.len() > 32 || !fill(stream, buf, buf.len() + 1).await {
                        return BodyRead::Broken;
                    }
                };
                let line = &buf[..line_end];
                if line.is_empty() || line.len() > 16 || !line.iter().all(u8::is_ascii_hexdigit) {
                    return BodyRead::Broken;
                }
                let size = usize::from_str_radix(std::str::from_utf8(line).unwrap_or("0"), 16).unwrap_or(usize::MAX);
                buf.drain(..line_end + 2);
                if size == 0 {
                    // 트레일러는 받지 않는다: 바로 빈 줄이어야 한다
                    if !fill(stream, buf, 2).await || &buf[..2] != b"\r\n" {
                        return BodyRead::Broken;
                    }
                    buf.drain(..2);
                    return BodyRead::Done(body);
                }
                // 상한은 쌓기 전에 본다
                if size > max || body.len() + size > max {
                    return BodyRead::TooLarge;
                }
                if !fill(stream, buf, size + 2).await || &buf[size..size + 2] != b"\r\n" {
                    return BodyRead::Broken;
                }
                body.extend_from_slice(&buf[..size]);
                buf.drain(..size + 2);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    fn routes() -> Vec<String> {
        vec!["/stop".to_owned(), "/pre-tool?x=1".to_owned()]
    }

    /// 콜백이 불린 횟수와 마지막 요청을 세는 서버. 콜백은 받은 본문의 길이를 200으로 돌려준다
    struct Fixture {
        server: LoopbackServer,
        calls: Arc<AtomicUsize>,
        last: Arc<std::sync::Mutex<Option<(usize, Vec<u8>)>>>,
    }

    async fn start(allowed_hosts: &[&str], max_body_bytes: usize, delay: Duration) -> Fixture {
        let calls = Arc::new(AtomicUsize::new(0));
        let last = Arc::new(std::sync::Mutex::new(None));
        let (calls2, last2) = (calls.clone(), last.clone());
        let handler: Handler = Arc::new(move |request: HandlerRequest| {
            let (calls, last) = (calls2.clone(), last2.clone());
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                let length = request.body.len();
                *last.lock().unwrap() = Some((request.route, request.body));
                tokio::time::sleep(delay).await;
                HandlerResponse { status: 200, body: format!("{{\"len\":{length}}}").into_bytes() }
            })
        });
        let server = LoopbackServer::start(LoopbackConfig { token: TOKEN.to_owned(), allowed_hosts: allowed_hosts.iter().map(|s| (*s).to_owned()).collect(), routes: routes(), handler, max_body_bytes }).await.unwrap();
        Fixture { server, calls, last }
    }

    /// 원시 요청을 보내고 연결이 닫힐 때까지(또는 2초) 읽은 응답 전체
    async fn raw(port: u16, request: &[u8]) -> Vec<u8> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request).await.unwrap();
        let mut out = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut out)).await;
        out
    }

    fn status_of(response: &[u8]) -> u16 {
        let text = String::from_utf8_lossy(response);
        text.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or(0)
    }

    fn body_of(response: &[u8]) -> String {
        let at = response.windows(4).position(|w| w == b"\r\n\r\n").map_or(response.len(), |p| p + 4);
        String::from_utf8_lossy(&response[at..]).into_owned()
    }

    fn post(target: &str, extra: &str, body: &str) -> Vec<u8> {
        format!("POST {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\n{extra}Connection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
    }

    fn head(text: &str) -> Result<Head, HeadError> {
        parse_head(text.as_bytes())
    }

    fn get(extra: &str) -> String {
        format!("POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}\r\n")
    }

    #[test]
    fn 라우트는_메서드가_post이고_요청_대상_원문이_정확히_같을_때만_맞는다() {
        let routes = routes();
        assert_eq!(route_index("POST", "/stop", &routes), Some(0));
        assert_eq!(route_index("POST", "/pre-tool?x=1", &routes), Some(1));
        // 쿼리를 떼고 비교하지 않는다(등록된 이름이 쿼리를 가진 것만 쿼리와 함께 맞고, 이름에 없는 쿼리는 다른 대상이다)
        assert_eq!(route_index("POST", "/stop?x=1", &routes), None);
        assert_eq!(route_index("POST", "/pre-tool", &routes), None);
        assert_eq!(route_index("POST", "/pre-tool?x=2", &routes), None);
        // 접두·끝 슬래시·대소문자·퍼센트 인코딩·프래그먼트는 다른 대상이다
        for other in ["/stop/", "/stopx", "/STOP", "/st%6Fp", "//stop", "/", "*", "/stop#x", "/stop?", "http://127.0.0.1:1/stop", "stop"] {
            assert_eq!(route_index("POST", other, &routes), None, "{other}");
        }
        for method in ["GET", "PUT", "HEAD", "DELETE", "OPTIONS", "PATCH", "post"] {
            assert_eq!(route_index(method, "/stop", &routes), None, "{method}");
        }
    }

    #[test]
    fn 요청_대상은_원문_그대로_읽는다_프래그먼트와_절대_형식도_지우거나_풀지_않는다() {
        // hyper의 Uri는 "/stop#x"의 프래그먼트를 지워 "/stop"으로 만들었다(차등 시험이 찾은 넓어짐)
        assert_eq!(head(&get("")).unwrap().target, "/stop");
        let fragment = head("POST /stop#x HTTP/1.1\r\nHost: a\r\n\r\n").unwrap();
        assert_eq!(fragment.target, "/stop#x");
        let absolute = head("POST http://127.0.0.1:1/stop HTTP/1.1\r\nHost: a\r\n\r\n").unwrap();
        assert_eq!(absolute.target, "http://127.0.0.1:1/stop");
        assert_eq!(route_index(&absolute.method, &absolute.target, &routes()), None);
        assert_eq!(head("POST /stop?a=%2F HTTP/1.1\r\nHost: a\r\n\r\n").unwrap().target, "/stop?a=%2F");
    }

    #[test]
    fn 머리는_엄격한_부분집합만_받고_모르는_꼴은_거절한다() {
        // 받는 꼴
        let ok = head(&get("Authorization:   Bearer x  \r\nContent-Length: 2\r\nConnection: close\r\n")).unwrap();
        assert_eq!((ok.authorization.as_deref(), ok.body, ok.keep_alive), (Some("Bearer x"), BodyKind::Length(2), false));
        assert_eq!(head(&get("Transfer-Encoding: Chunked\r\n")).unwrap().body, BodyKind::Chunked);
        // 거절: 줄 끝이 LF만, CR이 따로 있음, 요청 줄 공백 둘, 모르는 메서드·버전, 헤더 이름·값의 모르는 꼴, 줄 접기
        let bad = [
            "POST /stop HTTP/1.1\nHost: a\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\nX: 1\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nX: 1\nY: 2\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\rX: 1\r\n\r\n",
            "POST  /stop HTTP/1.1\r\nHost: a\r\n\r\n",
            "post /stop HTTP/1.1\r\nHost: a\r\n\r\n",
            "CONNECT /stop HTTP/1.1\r\nHost: a\r\n\r\n",
            "POST /stop HTTP/2.0\r\nHost: a\r\n\r\n",
            "POST /stop HTTP/1.1 x\r\nHost: a\r\n\r\n",
            "POST stop HTTP/1.1\r\nHost: a\r\n\r\n",
            "POST \\stop HTTP/1.1\r\nHost: a\r\n\r\n",
            "POST 127.0.0.1:80 HTTP/1.1\r\nHost: a\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost : a\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nX Y: 1\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\ngarbage\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\n folded\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\x01b\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nContent-Length: -1\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nContent-Length: 1x\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nContent-Length: +1\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
            "POST /stop HTTP/1.1\r\nHost: a\r\nExpect: nope\r\n\r\n",
        ];
        for text in bad {
            assert_eq!(head(text), Err(HeadError::Drop), "{text:?}");
        }
        assert_eq!(head("POST /stop HTTP/1.1\r\n\r\n"), Err(HeadError::MissingHost));
        assert_eq!(head("POST /stop HTTP/1.0\r\n\r\n").unwrap().host, None);
    }

    #[test]
    fn host_헤더는_latin1로_읽고_여럿이면_첫_값을_쓴다() {
        let mut raw = b"POST /stop HTTP/1.1\r\nHost: ".to_vec();
        raw.extend_from_slice(&[0xe9, 0xff]);
        raw.extend_from_slice(b"\r\nHost: second\r\n\r\n");
        assert_eq!(parse_head(&raw).unwrap().host.as_deref(), Some("\u{e9}\u{ff}"));
        // Authorization도 첫 값이다
        let auth = head("POST /stop HTTP/1.1\r\nHost: a\r\nAuthorization: Bearer first\r\nAuthorization: Bearer second\r\n\r\n").unwrap();
        assert_eq!(auth.authorization.as_deref(), Some("Bearer first"));
    }

    #[tokio::test]
    async fn 검사_순서는_host_토큰_라우트이고_통과하기_전에는_콜백을_부르지_않는다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let port = fx.server.port;
        let host = |h: &str| format!("POST /nope HTTP/1.1\r\nHost: {h}\r\nAuthorization: Bearer bad\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{{}}").into_bytes();
        let denied = raw(port, &host("evil.com")).await;
        assert_eq!((status_of(&denied), body_of(&denied).as_str()), (403, r#"{"error":"루프백에서만 접근할 수 있습니다"}"#));
        let unauthorized = raw(port, &host("localhost")).await;
        assert_eq!((status_of(&unauthorized), body_of(&unauthorized).as_str()), (401, r#"{"error":"unauthorized"}"#));
        let missing = raw(port, &post("/nope", "", "{}")).await;
        assert_eq!((status_of(&missing), body_of(&missing).as_str()), (404, r#"{"error":"not found"}"#));
        assert_eq!(fx.calls.load(Ordering::SeqCst), 0);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 응답은_콜백의_상태와_본문이고_content_type은_json이다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let response = raw(fx.server.port, &post("/stop", "", r#"{"a":1}"#)).await;
        assert_eq!((status_of(&response), body_of(&response).as_str()), (200, r#"{"len":7}"#));
        assert!(String::from_utf8_lossy(&response).to_ascii_lowercase().contains("content-type: application/json\r\n"));
        assert_eq!(fx.last.lock().unwrap().clone(), Some((0, br#"{"a":1}"#.to_vec())));
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 본문은_원래_바이트_그대로_넘기고_해석하지_않는다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        // 잘못된 UTF-8·짝 없는 서로게이트 이스케이프·NUL이 그대로 간다
        let body: Vec<u8> = [&b"{\"a\":\"\\ud800\"}"[..], &[0xff, 0xfe, 0x00]].concat();
        let mut request = format!("POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        request.extend_from_slice(&body);
        assert_eq!(status_of(&raw(fx.server.port, &request).await), 200);
        assert_eq!(fx.last.lock().unwrap().clone().map(|(_, b)| b), Some(body));
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 본문_상한은_넘는_순간부터_413이고_정확히_상한이면_받는다() {
        let fx = start(&[], 1024, Duration::ZERO).await;
        let port = fx.server.port;
        let exact = raw(port, &post("/stop", "", &"x".repeat(1024))).await;
        assert_eq!(status_of(&exact), 200);
        let over = raw(port, &post("/stop", "", &"x".repeat(1025))).await;
        assert_eq!((status_of(&over), body_of(&over).as_str()), (413, r#"{"error":"too large"}"#));
        assert_eq!(fx.calls.load(Ordering::SeqCst), 1);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn chunked로_보내도_누적이_상한을_넘는_순간_413이다() {
        let fx = start(&[], 1024, Duration::ZERO).await;
        let chunk = |n: usize| format!("{:x}\r\n{}\r\n", n, "y".repeat(n));
        let request = |chunks: &[usize]| {
            let mut text = format!("POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n");
            for n in chunks {
                text.push_str(&chunk(*n));
            }
            text.push_str("0\r\n\r\n");
            text.into_bytes()
        };
        assert_eq!(status_of(&raw(fx.server.port, &request(&[512, 512])).await), 200);
        assert_eq!(status_of(&raw(fx.server.port, &request(&[512, 512, 1])).await), 413);
        assert_eq!(fx.calls.load(Ordering::SeqCst), 1);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn host는_latin1로_읽고_여럿이면_첫_값을_쓴다() {
        // 허용 이름 "é"(U+00E9). Node의 req.headers는 헤더 바이트를 latin1로 읽는다: 0xE9 한 바이트는 맞고 UTF-8의 0xC3 0xA9는 "Ã©"라 맞지 않는다
        let fx = start(&["é"], MAX_BODY_BYTES, Duration::ZERO).await;
        let with_host = |host: &[u8]| {
            let mut request = b"POST /stop HTTP/1.1\r\nHost: ".to_vec();
            request.extend_from_slice(host);
            request.extend_from_slice(format!("\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{{}}").as_bytes());
            request
        };
        assert_eq!(status_of(&raw(fx.server.port, &with_host(&[0xe9])).await), 200);
        assert_eq!(status_of(&raw(fx.server.port, &with_host("é".as_bytes())).await), 403);
        assert_eq!(status_of(&raw(fx.server.port, &with_host(&[0xff, 0xfe])).await), 403);
        let dup = |first: &str, second: &str| format!("POST /stop HTTP/1.1\r\nHost: {first}\r\nHost: {second}\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{{}}").into_bytes();
        assert_eq!(status_of(&raw(fx.server.port, &dup("localhost", "evil.com")).await), 200);
        assert_eq!(status_of(&raw(fx.server.port, &dup("evil.com", "localhost")).await), 403);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 허용_이름은_글자_그대로만_맞고_접두·접미는_맞지_않는다() {
        let fx = start(&["host.docker.internal"], MAX_BODY_BYTES, Duration::ZERO).await;
        let status = |host: &str| {
            let request = format!("POST /stop HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{{}}").into_bytes();
            let port = fx.server.port;
            async move { status_of(&raw(port, &request).await) }
        };
        assert_eq!(status("host.docker.internal:80").await, 200);
        assert_eq!(status("HOST.docker.internal").await, 200);
        for near in ["host.docker.internal.evil.com", "xhost.docker.internal", "host.docker.internal@evil.com", "host.docker.interna", "host.docker.internal.", "evil.com"] {
            assert_eq!(status(near).await, 403, "{near}");
        }
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 토큰은_bearer_접두_뒤_전부가_같아야_한다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let status = |auth: &str| {
            let request = format!("POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: {auth}\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{{}}").into_bytes();
            let port = fx.server.port;
            async move { status_of(&raw(port, &request).await) }
        };
        assert_eq!(status(&format!("Bearer {TOKEN}")).await, 200);
        for bad in [format!("bearer {TOKEN}"), format!("Bearer  {TOKEN}"), format!("Bearer {TOKEN}x"), format!("Bearer {}", &TOKEN[..TOKEN.len() - 1]), TOKEN.to_owned(), "Bearer ".to_owned()] {
            assert_eq!(status(&bad).await, 401, "{bad}");
        }
        fx.server.close().await;
    }

    #[tokio::test]
    async fn close_뒤에는_새_연결을_받지_않는다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let port = fx.server.port;
        assert_eq!(status_of(&raw(port, &post("/stop", "", "{}")).await), 200);
        fx.server.close().await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
        // 두 번 불러도 된다
        fx.server.close().await;
    }

    #[tokio::test]
    async fn close는_열려_있는_연결과_처리_중인_연결을_끊고_끝난다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::from_secs(30)).await;
        let port = fx.server.port;
        // 연결만 열고 아무것도 보내지 않은 연결
        let mut idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        // 처리 중(콜백이 30초 걸린다)인 연결
        let mut busy = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        busy.write_all(&post("/stop", "", "{}")).await.unwrap();
        while fx.calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let started = std::time::Instant::now();
        fx.server.close().await;
        assert!(started.elapsed() < Duration::from_secs(5), "close가 처리를 기다렸다");
        for stream in [&mut idle, &mut busy] {
            let mut out = Vec::new();
            let read = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut out)).await.expect("연결이 끊기지 않았다");
            assert!(read.is_err() || out.is_empty(), "끊기며 응답이 나갔다: {:?}", String::from_utf8_lossy(&out));
        }
    }

    #[tokio::test]
    async fn 머리를_천천히_보내도_서버가_끊지_않는다_시간_제한_없음() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let mut stream = TcpStream::connect(("127.0.0.1", fx.server.port)).await.unwrap();
        stream.write_all(b"POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        stream.write_all(format!("Authorization: Bearer {TOKEN}\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{{}}").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut out)).await;
        assert_eq!(status_of(&out), 200);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 머리가_상한을_넘으면_받지_않는다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let big = post("/stop", &format!("X: {}\r\n", "a".repeat(17 * 1024)), "{}");
        let response = raw(fx.server.port, &big).await;
        assert_ne!(status_of(&response), 200);
        assert_eq!(fx.calls.load(Ordering::SeqCst), 0);
        let small = post("/stop", &format!("X: {}\r\n", "a".repeat(MAX_HEAD_BYTES - 500)), "{}");
        assert_eq!(status_of(&raw(fx.server.port, &small).await), 200);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 동시_요청_여러_개가_서로_기다리지_않는다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::from_millis(300)).await;
        let port = fx.server.port;
        let started = std::time::Instant::now();
        let tasks: Vec<_> = (0..8).map(|_| tokio::spawn(async move { status_of(&raw(port, &post("/stop", "", "{}")).await) })).collect();
        for task in tasks {
            assert_eq!(task.await.unwrap(), 200);
        }
        assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 같은_연결에_요청을_이어_보내면_차례로_답하고_거절한_요청_뒤에는_닫는다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let good = |body: &str| format!("POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        let bad = "POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer nope\r\nContent-Length: 2\r\n\r\n{}";
        // 맞는 요청 둘(keep-alive) 뒤에 틀린 요청, 그 뒤에 맞는 요청. 틀린 요청에서 연결이 닫히므로 마지막 요청은 처리되지 않는다
        let all = format!("{}{}{}{}", good("{\"n\":1}"), good("{\"n\":22}"), bad, good("{}"));
        let response = String::from_utf8_lossy(&raw(fx.server.port, all.as_bytes()).await).into_owned();
        assert_eq!(response.matches("HTTP/1.1 200").count(), 2, "{response}");
        assert_eq!(response.matches("HTTP/1.1 401").count(), 1, "{response}");
        assert!(response.contains(r#"{"len":7}"#) && response.contains(r#"{"len":8}"#), "{response}");
        assert_eq!(fx.calls.load(Ordering::SeqCst), 2);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 상한을_크게_넘는_본문을_보내는_중이어도_413_응답이_전달된다() {
        // 본문을 읽지 않고 닫으면 커널이 RST를 보내 클라이언트가 응답을 읽기 전에 연결이 깨진다. 보내던 것을 흘려 보내며 응답을 전달해야 한다
        let fx = start(&[], 1024, Duration::ZERO).await;
        let mut stream = TcpStream::connect(("127.0.0.1", fx.server.port)).await.unwrap();
        let big = vec![b'x'; 8 * 1024 * 1024];
        let head = format!("POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n", big.len());
        stream.write_all(head.as_bytes()).await.unwrap();
        // 본문을 다 보낸 뒤에 응답을 읽는다. 서버가 응답하고 바로 닫으면 쓰기가 깨진다(흘려 보내며 받아야 쓰기가 끝난다)
        stream.write_all(&big).await.expect("서버가 보내던 본문을 흘려 보내지 않고 연결을 닫았다");
        let mut out = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
        assert_eq!(status_of(&out), 413, "{:?}", String::from_utf8_lossy(&out));
        assert_eq!(fx.calls.load(Ordering::SeqCst), 0);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn head_요청의_거절_응답은_본문이_없다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let response = raw(fx.server.port, b"HEAD /stop HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n").await;
        assert_eq!(status_of(&response), 403);
        assert_eq!(body_of(&response), "");
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 두_번째_라우트는_번호_1로_콜백에_간다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        assert_eq!(status_of(&raw(fx.server.port, &post("/pre-tool?x=1", "", "{}")).await), 200);
        assert_eq!(fx.last.lock().unwrap().clone().map(|(route, _)| route), Some(1));
        fx.server.close().await;
    }

    #[tokio::test]
    async fn lf만으로_끝낸_머리는_기다리지_않고_바로_끊는다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let started = std::time::Instant::now();
        let response = raw(fx.server.port, b"POST /stop HTTP/1.1\nHost: 127.0.0.1\n\n").await;
        assert!(response.is_empty());
        assert!(started.elapsed() < Duration::from_millis(1500), "머리가 끝나기를 기다렸다: {:?}", started.elapsed());
        fx.server.close().await;
    }

    #[tokio::test]
    async fn 응답_뒤_다음_요청을_기다리는_연결은_5초_뒤_닫는다() {
        let fx = start(&[], MAX_BODY_BYTES, Duration::ZERO).await;
        let mut stream = TcpStream::connect(("127.0.0.1", fx.server.port)).await.unwrap();
        let request = format!("POST /stop HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 2\r\n\r\n{{}}");
        stream.write_all(request.as_bytes()).await.unwrap();
        let started = std::time::Instant::now();
        let mut out = Vec::new();
        let finished = tokio::time::timeout(Duration::from_secs(8), stream.read_to_end(&mut out)).await;
        assert!(finished.is_ok(), "연결이 닫히지 않았다");
        assert_eq!(status_of(&out), 200);
        assert!(started.elapsed() >= Duration::from_millis(4500) && started.elapsed() < Duration::from_secs(7), "{:?}", started.elapsed());
        fx.server.close().await;
    }

    // ── MCP 서버(A7b) ──

    const SPECS: &str = r#"[{"name":"echo","description":"d","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]"#;

    /// 도구 실행 `echo`는 `delay` 뒤 인자를 그대로 돌려준다. 호출 횟수와 마지막 인자를 센다
    struct McpFixture {
        server: LoopbackServer,
        calls: Arc<AtomicUsize>,
        last_args: Arc<std::sync::Mutex<Option<String>>>,
    }

    async fn start_mcp(delay: Duration, keep_alive: Duration, max_body_bytes: usize) -> McpFixture {
        let calls = Arc::new(AtomicUsize::new(0));
        let last_args = Arc::new(std::sync::Mutex::new(None));
        let (calls2, last2) = (calls.clone(), last_args.clone());
        let list: ListTools = Arc::new(|| Box::pin(async { Ok(SPECS.to_owned()) }));
        let call: CallTool = Arc::new(move |_name, args| {
            let (calls, last) = (calls2.clone(), last2.clone());
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                *last.lock().unwrap() = Some(args.clone());
                tokio::time::sleep(delay).await;
                ToolReply { ok: true, content: args, images: Vec::new() }
            })
        });
        let config = McpConfig { token: TOKEN.to_owned(), allowed_hosts: Vec::new(), name: "b-studio".to_owned(), honor_required: false, list, call, max_body_bytes, keep_alive };
        McpFixture { server: LoopbackServer::start_mcp(config).await.unwrap(), calls, last_args }
    }

    fn mcp_post(target: &str, extra: &str, body: &str) -> Vec<u8> {
        format!(
            "POST {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\n{extra}Connection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn call_body(text: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"echo","arguments":{{"text":"{text}"}}}}}}"#)
    }

    /// chunked 본문을 풀어 SSE 글만 돌려준다
    fn sse_text(response: &[u8]) -> String {
        let at = response.windows(4).position(|w| w == b"\r\n\r\n").map_or(response.len(), |p| p + 4);
        let mut rest = &response[at..];
        let mut out = Vec::new();
        while let Some(line_end) = rest.windows(2).position(|w| w == b"\r\n") {
            let size = usize::from_str_radix(std::str::from_utf8(&rest[..line_end]).unwrap_or("0"), 16).unwrap_or(0);
            if size == 0 {
                break;
            }
            out.extend_from_slice(&rest[line_end + 2..line_end + 2 + size]);
            rest = &rest[line_end + 2 + size + 2..];
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn mcp는_경로를_보지_않고_도구_호출을_sse로_답한다() {
        let fx = start_mcp(Duration::ZERO, SSE_KEEP_ALIVE, MAX_BODY_BYTES).await;
        for target in ["/mcp", "/", "/anything?x=1"] {
            let response = raw(fx.server.port, &mcp_post(target, "", &call_body("안녕"))).await;
            assert_eq!(status_of(&response), 200, "{target}");
            let text = String::from_utf8_lossy(&response).to_ascii_lowercase();
            assert!(text.contains("content-type: text/event-stream\r\n") && text.contains("transfer-encoding: chunked\r\n"), "{text}");
            assert_eq!(sse_text(&response), "event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"text\\\":\\\"안녕\\\"}\"}],\"isError\":false},\"jsonrpc\":\"2.0\",\"id\":1}\n\n");
        }
        assert_eq!(fx.last_args.lock().unwrap().clone().as_deref(), Some(r#"{"text":"안녕"}"#));
        fx.server.close().await;
    }

    #[tokio::test]
    async fn mcp_인증은_글과_json_rpc_코드를_옛_서버와_같게_낸다() {
        let fx = start_mcp(Duration::ZERO, SSE_KEEP_ALIVE, MAX_BODY_BYTES).await;
        let bad_host = String::from_utf8(mcp_post("/mcp", "", "{}")).unwrap().replace("Host: 127.0.0.1", "Host: evil.com").into_bytes();
        let response = raw(fx.server.port, &bad_host).await;
        assert_eq!((status_of(&response), body_of(&response).as_str()), (403, r#"{"jsonrpc":"2.0","error":{"code":-40300,"message":"MCP 서버는 루프백에서만 접근할 수 있습니다"},"id":null}"#));
        let bad_token = String::from_utf8(mcp_post("/mcp", "", "{}")).unwrap().replace(TOKEN, "x").into_bytes();
        let response = raw(fx.server.port, &bad_token).await;
        assert_eq!((status_of(&response), body_of(&response).as_str()), (401, r#"{"jsonrpc":"2.0","error":{"code":-40100,"message":"unauthorized"},"id":null}"#));
        assert_eq!(fx.calls.load(Ordering::SeqCst), 0);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn mcp_본문_상한은_넘는_순간부터_413이고_정확히_상한이면_받는다() {
        let ping = |pad: usize| format!(r#"{{"jsonrpc":"2.0","id":1,"method":"ping","params":{{"p":"{}"}}}}"#, "x".repeat(pad));
        let base = ping(0).len();
        let fx = start_mcp(Duration::ZERO, SSE_KEEP_ALIVE, 1024).await;
        let exact = raw(fx.server.port, &mcp_post("/mcp", "", &ping(1024 - base))).await;
        assert_eq!(status_of(&exact), 200);
        let over = raw(fx.server.port, &mcp_post("/mcp", "", &ping(1025 - base))).await;
        assert_eq!(status_of(&over), 413);
        assert!(body_of(&over).contains("Payload Too Large: Request body must not exceed 1024 bytes"), "{}", body_of(&over));
        fx.server.close().await;
    }

    #[tokio::test]
    async fn mcp_sse는_열려_있는_동안_keepalive를_보내고_응답을_마지막에_쓴다() {
        let fx = start_mcp(Duration::from_millis(450), Duration::from_millis(100), MAX_BODY_BYTES).await;
        let response = raw(fx.server.port, &mcp_post("/mcp", "", &call_body("x"))).await;
        let text = sse_text(&response);
        assert!(text.matches(": keepalive\n\n").count() >= 2, "{text}");
        assert!(text.ends_with("\"id\":1}\n\n"), "{text}");
        fx.server.close().await;
    }

    #[tokio::test]
    async fn mcp_get은_스트림을_열어_두고_끊으면_끝난다_닫으면_끊는다() {
        let fx = start_mcp(Duration::ZERO, Duration::from_millis(100), MAX_BODY_BYTES).await;
        let request = format!("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nAccept: text/event-stream\r\n\r\n");
        let mut stream = TcpStream::connect(("127.0.0.1", fx.server.port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut seen = Vec::new();
        let mut chunk = [0u8; 4096];
        let deadline = tokio::time::Instant::now() + Duration::from_millis(600);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Ok(read)) = tokio::time::timeout(Duration::from_millis(100), stream.read(&mut chunk)).await {
                seen.extend_from_slice(&chunk[..read]);
            }
        }
        assert_eq!(status_of(&seen), 200);
        assert!(String::from_utf8_lossy(&seen).matches(": keepalive").count() >= 2);
        // 서버를 닫으면 열린 스트림도 끊긴다
        fx.server.close().await;
        let mut rest = Vec::new();
        let closed = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut rest)).await;
        assert!(closed.is_ok(), "닫았는데 스트림이 열려 있다");
    }

    #[tokio::test]
    async fn mcp_close는_처리_중인_도구_호출이_있어도_끝난다() {
        let fx = start_mcp(Duration::from_secs(30), SSE_KEEP_ALIVE, MAX_BODY_BYTES).await;
        let mut busy = TcpStream::connect(("127.0.0.1", fx.server.port)).await.unwrap();
        busy.write_all(&mcp_post("/mcp", "", &call_body("x"))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fx.calls.load(Ordering::SeqCst), 1);
        let started = std::time::Instant::now();
        fx.server.close().await;
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn hono가_요청_주소를_만들지_못하는_꼴은_걸러낸다() {
        // 만들어지는 꼴
        for (host, target) in [("127.0.0.1:3000", "/mcp"), ("localhost", "/"), ("LOCALHOST:80", "/x"), ("[::1]:3000", "/mcp"), ("127.0.0.1", "//mcp"), ("127.0.0.1:3000", "/a/../b"), ("127.0.0.1:65535", "/x"), ("host.docker.internal:1234", "/mcp?a=1")] {
            assert!(request_url_valid(Some(host), target), "{host} {target}");
        }
        // 만들지 못하는 꼴(옛 서버는 SDK에 닿기 전에 본문 없는 400)
        for (host, target) in [("127.0.0.1:99999", "/mcp"), ("127.0.0.1:abc", "/mcp"), ("localhost:80:90", "/mcp"), ("127.0.0.1", "*"), ("", "/mcp")] {
            assert!(!request_url_valid(Some(host), target), "{host} {target}");
        }
        assert!(!request_url_valid(None, "/mcp"));
        // 절대 형식 요청 대상은 Host를 보지 않고 그 주소를 파싱한다
        assert!(request_url_valid(Some("127.0.0.1"), "http://example.com/x"));
        assert!(has_dot_segment("/a/../b") && has_dot_segment("/a/./b") && has_dot_segment("/..") && has_dot_segment("/a/..?x") && !has_dot_segment("/a/..b") && !has_dot_segment("/a/.b/c"));
    }

    #[tokio::test]
    async fn mcp_post는_accept와_content_type이_맞아야_하고_메서드는_post_get_delete만_받는다() {
        let fx = start_mcp(Duration::ZERO, SSE_KEEP_ALIVE, MAX_BODY_BYTES).await;
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let with = |from: &str, to: &str| String::from_utf8(mcp_post("/mcp", "", ping)).unwrap().replace(from, to).into_bytes();
        let no_accept = raw(fx.server.port, &with("Accept: application/json, text/event-stream", "Accept: application/json")).await;
        assert_eq!(status_of(&no_accept), 406);
        assert!(body_of(&no_accept).contains("Not Acceptable: Client must accept both application/json and text/event-stream"));
        let no_json = raw(fx.server.port, &with("Content-Type: application/json", "Content-Type: text/plain")).await;
        assert_eq!(status_of(&no_json), 415);
        assert!(body_of(&no_json).contains("Unsupported Media Type: Content-Type must be application/json"));
        // 알림만이면 202, 본문 없음
        let notification = raw(fx.server.port, &mcp_post("/mcp", "", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)).await;
        assert_eq!((status_of(&notification), body_of(&notification).as_str()), (202, ""));
        // DELETE는 200, 그 밖의 메서드는 405와 Allow
        let delete = raw(fx.server.port, format!("DELETE /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n").as_bytes()).await;
        assert_eq!((status_of(&delete), body_of(&delete).as_str()), (200, ""));
        let put = raw(fx.server.port, format!("PUT /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nConnection: close\r\n\r\n").as_bytes()).await;
        assert_eq!(status_of(&put), 405);
        assert!(String::from_utf8_lossy(&put).to_ascii_lowercase().contains("allow: get, post, delete\r\n"));
        // GET은 text/event-stream을 받아야 한다
        let get = raw(fx.server.port, format!("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nAccept: application/json\r\nConnection: close\r\n\r\n").as_bytes()).await;
        assert_eq!(status_of(&get), 406);
        assert_eq!(fx.calls.load(Ordering::SeqCst), 0);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn mcp_인자_검사를_통과하지_못하면_도구를_부르지_않고_통과하면_모르는_키를_지운_인자를_넘긴다() {
        let fx = start_mcp(Duration::ZERO, SSE_KEEP_ALIVE, MAX_BODY_BYTES).await;
        let body = |args: &str| format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"echo","arguments":{args}}}}}"#);
        for bad in [r#"{"text":1}"#, "{}", r#"{"text":null}"#, r#"{"TEXT":"x"}"#] {
            let response = raw(fx.server.port, &mcp_post("/mcp", "", &body(bad))).await;
            assert_eq!(status_of(&response), 200, "{bad}");
            assert!(sse_text(&response).contains("\"isError\":true") && sse_text(&response).contains("Input validation error: Invalid arguments for tool echo"), "{bad}: {}", sse_text(&response));
        }
        assert_eq!(fx.calls.load(Ordering::SeqCst), 0);
        let ok = raw(fx.server.port, &mcp_post("/mcp", "", &body(r#"{"extra":[1],"text":"t","more":{}}"#))).await;
        assert!(sse_text(&ok).contains("\"isError\":false"));
        assert_eq!(fx.last_args.lock().unwrap().clone().as_deref(), Some(r#"{"text":"t"}"#));
        fx.server.close().await;
    }

    #[tokio::test]
    async fn mcp_배치에서_같은_id의_요청이_둘이면_첫_응답만_쓰고_닫는다_도구_실행은_둘_다_한다() {
        let fx = start_mcp(Duration::ZERO, SSE_KEEP_ALIVE, MAX_BODY_BYTES).await;
        let one = |text: &str| format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"echo","arguments":{{"text":"{text}"}}}}}}"#);
        let response = raw(fx.server.port, &mcp_post("/mcp", "", &format!("[{},{}]", one("a"), one("b")))).await;
        assert_eq!(sse_text(&response).matches("event: message").count(), 1, "{}", sse_text(&response));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fx.calls.load(Ordering::SeqCst), 2);
        fx.server.close().await;
    }

    #[tokio::test]
    async fn mcp_느린_도구_호출이_같은_배치의_빠른_요청과_다른_연결의_요청을_막지_않는다() {
        let fx = start_mcp(Duration::from_millis(600), SSE_KEEP_ALIVE, MAX_BODY_BYTES).await;
        let port = fx.server.port;
        let batch = format!(r#"[{},{{"jsonrpc":"2.0","id":2,"method":"ping"}}]"#, call_body("x"));
        let slow = tokio::spawn(async move { raw(port, &mcp_post("/mcp", "", &batch)).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let started = std::time::Instant::now();
        let other = raw(port, &mcp_post("/mcp", "", r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#)).await;
        assert!(started.elapsed() < Duration::from_millis(400), "다른 연결의 요청이 막혔다: {:?}", started.elapsed());
        assert!(sse_text(&other).contains("\"id\":3"));
        // 같은 배치에서는 먼저 끝난 응답(ping)이 먼저 나온다
        let text = sse_text(&slow.await.unwrap());
        assert!(text.find("\"id\":2").unwrap() < text.find("\"id\":1").unwrap(), "{text}");
        fx.server.close().await;
    }

    #[tokio::test]
    async fn mcp_요청_주소를_만들_수_없는_host는_본문_없는_400이고_delete도_프로토콜_버전을_본다() {
        let fx = start_mcp(Duration::ZERO, SSE_KEEP_ALIVE, MAX_BODY_BYTES).await;
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        // 루프백 이름이라 인증은 통과하지만 포트가 범위 밖이라 hono가 요청 주소를 만들지 못한다(옛 서버: SDK에 닿기 전에 본문 없는 400)
        let bad_port = String::from_utf8(mcp_post("/mcp", "", ping)).unwrap().replace("Host: 127.0.0.1", "Host: 127.0.0.1:99999").into_bytes();
        let response = raw(fx.server.port, &bad_port).await;
        assert_eq!((status_of(&response), body_of(&response).as_str()), (400, ""));
        let delete = |version: &str| format!("DELETE /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nmcp-protocol-version: {version}\r\nConnection: close\r\n\r\n").into_bytes();
        assert_eq!(status_of(&raw(fx.server.port, &delete("1999")).await), 400);
        assert_eq!(status_of(&raw(fx.server.port, &delete("2025-03-26")).await), 200);
        fx.server.close().await;
    }
}
