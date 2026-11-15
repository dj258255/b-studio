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

use bstudio_guard::connection_judge::{host_allowed, token_matches};
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
    routes: Vec<String>,
    handler: Handler,
    max_body_bytes: usize,
}

pub struct LoopbackServer {
    pub port: u16,
    shutdown: watch::Sender<bool>,
    accept: Mutex<Option<JoinHandle<()>>>,
}

impl LoopbackServer {
    /// 127.0.0.1의 임의 포트를 연다
    pub async fn start(config: LoopbackConfig) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let shared = Arc::new(Shared { token: config.token, allowed_hosts: config.allowed_hosts, routes: config.routes, handler: config.handler, max_body_bytes: config.max_body_bytes });
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
    for line in &owned[1..] {
        let colon = line.iter().position(|byte| *byte == b':').ok_or(HeadError::Drop)?;
        let (name, value) = (&line[..colon], trim_ows(&line[colon + 1..]));
        if name.is_empty() || !name.iter().all(|byte| is_tchar(*byte)) || !value.iter().all(|byte| matches!(byte, 0x09 | 0x20..=0x7e | 0x80..=0xff)) {
            return Err(HeadError::Drop);
        }
        let name = name.to_ascii_lowercase();
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
    Ok(Head { method: method.to_owned(), target: String::from_utf8_lossy(target).into_owned(), http11, host, authorization, body, expect_continue, keep_alive })
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
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "Status",
    }
}

async fn write_response(stream: &mut TcpStream, status: u16, content_type: Option<&str>, body: &[u8], keep_alive: bool, with_body: bool) -> bool {
    let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    if let Some(content_type) = content_type {
        out.push_str(&format!("content-type: {content_type}\r\n"));
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
    // ① Host ② 토큰 ③ 메서드·라우트. 거절하면 본문을 읽지 않고 응답한 뒤 닫는다
    let denied = if !host_allowed(head.host.as_deref(), &shared.allowed_hosts) {
        Some(json_reply(403, r#"{"error":"루프백에서만 접근할 수 있습니다"}"#))
    } else if !token_matches(head.authorization.as_deref(), &shared.token) {
        Some(json_reply(401, r#"{"error":"unauthorized"}"#))
    } else if route_index(&head.method, &head.target, &shared.routes).is_none() {
        Some(json_reply(404, r#"{"error":"not found"}"#))
    } else {
        None
    };
    let with_body = head.method != "HEAD";
    if let Some((status, body)) = denied {
        write_response(stream, status, Some("application/json"), &body, false, with_body).await;
        return Next::Linger;
    }
    let route = route_index(&head.method, &head.target, &shared.routes).unwrap_or(usize::MAX);

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
    let answer = (shared.handler)(HandlerRequest { route, body }).await;
    let ok = write_response(stream, answer.status, Some("application/json"), &answer.body, head.keep_alive, with_body).await;
    if ok && head.keep_alive {
        Next::KeepAlive
    } else {
        Next::Close
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
}
