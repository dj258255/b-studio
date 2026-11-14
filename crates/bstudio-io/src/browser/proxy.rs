//! 허용 출처 밖으로 나가는 요청을 네트워크 층에서 막는 로컬 전달 프록시(#1210, ADR-198, Rust 이전은 ADR-199).
//!
//! 화면 확인 브라우저(Chromium)를 이 프록시 뒤에서 띄운다. 요청 가로채기(CDP `Fetch`)가 보지 못하는 요청(서비스 워커·워커·미리 연결·
//! 웹소켓)도 브라우저의 모든 네트워크는 프록시를 지나므로 "무엇에 접속하는가"를 한 자리에서 판정한다.
//!
//! 판정은 부르는 쪽이 준 `is_allowed(url)` 하나다(요청 가로채기와 같은 함수). 프록시는 **판정한 URL의 host:port로만** 접속한다.
//! 같은 문자열을 한 번만 파싱해 판정과 접속에 함께 쓰고, Host 머리로 다른 곳에 가지 않는다. 모르는 요청(origin-form, 알 수 없는 메서드,
//! 파싱 실패, Host 불일치·중복·없음, Upgrade, 사용자 정보, http가 아닌 것)은 모두 막는다(막는 쪽으로 틀린다).
//!
//! 서비스 워커 스크립트 요청(`Service-Worker` 머리 또는 `Sec-Fetch-Dest: serviceworker`)은 허용 출처라도 막는다(ADR-198 결정 10).
//!
//! 막을 때는 업스트림에 접속하지 않고 클라이언트 연결을 끊는다(CONNECT는 403 뒤 끊는다). 상태 코드 응답을 주지 않는 이유: 403 같은 응답을
//! 주면 문서 이동이 응답으로 끝나 상태 코드를 따지지 않는 확인이 통과할 수 있다. 연결을 끊으면 브라우저는 요청이 실패한 것으로 본다.
//!
//! 한 연결에서 요청 하나만 다루고(응답 뒤 연결을 닫는다) 업스트림에는 `Connection: close`로 보낸다. 그래서 파이프라인으로 몰래 끼워 넣은
//! 둘째 요청이 판정 없이 지나갈 길이 없다. 업스트림 실패는 502다.

use super::origin::{host_text, is_tunnel_allowed, parse_authority, socket_host};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{AbortHandle, JoinSet};
use url::Url;

/// 막은 것의 종류. `Url`·`Tunnel`은 허용 출처 밖이거나 모르는 모양이라 막은 것이고, `ServiceWorker`는 허용 출처 안이라도 서비스 워커
/// 스크립트라 막은 것이다(그 URL은 허용 출처 안의 주소일 수 있으므로 "경계 밖이라 막은 요청"과 섞으면 안 된다)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyBlock {
    Url(String),
    Tunnel(String),
    ServiceWorker(String),
}

pub type IsAllowed = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type OnBlocked = Arc<dyn Fn(ProxyBlock) + Send + Sync>;

const FORWARDED_METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/// 한 연결 구간에서만 뜻이 있는 머리. 전달하지 않는다(RFC 9110 7.6.1)
const HOP_BY_HOP: [&str; 8] = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"];

/// 요청·응답 머리의 크기 상한. 넘으면 읽기를 멈추고 끊는다(읽기 전에 보는 상한)
const MAX_HEAD_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

pub struct OriginProxy {
    /// 브라우저의 `--proxy-server`에 넘길 주소(`http://127.0.0.1:포트`)
    pub server: String,
    accept_task: AbortHandle,
}

impl OriginProxy {
    pub async fn start(is_allowed: IsAllowed, on_blocked: OnBlocked) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let context = Arc::new(Context { is_allowed, on_blocked });
        // 연결 작업은 이 작업의 JoinSet이 쥔다. 이 작업을 멈추면 열려 있는 연결(클라이언트·업스트림)도 함께 닫힌다
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let context = context.clone();
                        connections.spawn(async move { handle(stream, context).await });
                    }
                    // 끝난 연결 작업을 치운다
                    Some(_) = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self { server: format!("http://127.0.0.1:{port}"), accept_task: task.abort_handle() })
    }

    /// 서버와 열려 있는 모든 연결을 닫는다
    pub fn close(&self) {
        self.accept_task.abort();
    }
}

impl Drop for OriginProxy {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

struct Context {
    is_allowed: IsAllowed,
    on_blocked: OnBlocked,
}

/// 머리를 `\r\n\r\n`까지 읽는다. 끝나지 않고 상한을 넘거나 연결이 끊기면 `None`
async fn read_head(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> Option<usize> {
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            return Some(position + 4);
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return None;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

fn header_values<'a>(headers: &'a [httparse::Header<'a>], name: &str) -> Vec<&'a [u8]> {
    headers.iter().filter(|header| header.name.eq_ignore_ascii_case(name)).map(|header| header.value).collect()
}

fn trim(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| !matches!(b, b' ' | b'\t')).unwrap_or(bytes.len());
    let end = bytes.iter().rposition(|b| !matches!(b, b' ' | b'\t')).map_or(start, |i| i + 1);
    &bytes[start..end]
}

/// 전달하지 않을 머리 이름: 한 연결 구간용 머리와 `Connection` 머리가 이름을 댄 머리
fn hop_headers(headers: &[httparse::Header<'_>]) -> Vec<String> {
    let mut named: Vec<String> = HOP_BY_HOP.iter().map(|name| (*name).to_owned()).collect();
    for value in header_values(headers, "connection") {
        for token in String::from_utf8_lossy(value).split(',') {
            named.push(token.trim().to_ascii_lowercase());
        }
    }
    named
}

async fn handle(mut client: TcpStream, context: Arc<Context>) {
    let _ = client.set_nodelay(true);
    let mut buffer = Vec::new();
    let Some(head_len) = read_head(&mut client, &mut buffer).await else { return };
    let mut headers = [httparse::EMPTY_HEADER; 96];
    let mut request = httparse::Request::new(&mut headers);
    // 형식이 깨진 요청은 응답하지 않고 끊는다
    if !matches!(request.parse(&buffer[..head_len]), Ok(httparse::Status::Complete(_))) {
        return;
    }
    let method = request.method.unwrap_or("").to_owned();
    let target = request.path.unwrap_or("").to_owned();
    let parsed_headers: Vec<httparse::Header<'_>> = request.headers.to_vec();
    let leftover = buffer[head_len..].to_vec();

    if method == "CONNECT" {
        return handle_connect(client, &context, &target, leftover).await;
    }
    handle_forward(client, &context, &method, &target, &parsed_headers, leftover).await;
}

async fn handle_connect(mut client: TcpStream, context: &Context, authority: &str, leftover: Vec<u8>) {
    // CONNECT는 https와 웹소켓(ws·wss)이 쓴다. 어느 쪽인지 알 수 없으므로, 허용 출처의 같은 host:port(http든 https든)일 때만 터널을 연다.
    // 그 host:port로는 평문 요청도 이미 허용돼 있어 터널이 허용 범위를 넓히지 않는다
    let target = parse_authority(authority).and_then(|(parsed, port)| {
        let host = host_text(&parsed)?;
        is_tunnel_allowed(&format!("{host}:{port}"), |url| (context.is_allowed)(url)).then_some((host, port))
    });
    let Some((host, port)) = target else {
        (context.on_blocked)(ProxyBlock::Tunnel(authority.to_owned()));
        let _ = client.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n").await;
        let _ = client.shutdown().await;
        return;
    };
    let upstream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((socket_host(&host), port))).await;
    let mut upstream = match upstream {
        Ok(Ok(stream)) => stream,
        // 연결 전의 실패는 502다. 통과로 바뀌지 않는다
        _ => {
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n").await;
            let _ = client.shutdown().await;
            return;
        }
    };
    let _ = upstream.set_nodelay(true);
    if client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.is_err() {
        return;
    }
    if !leftover.is_empty() && upstream.write_all(&leftover).await.is_err() {
        return;
    }
    // 터널이 선 뒤의 오류는 양쪽을 끊어 알린다
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
}

fn block_url(context: &Context, target: &str) {
    (context.on_blocked)(ProxyBlock::Url(target.to_owned()));
}

enum BodyFraming {
    None,
    Length(u64),
    Chunked,
}

/// 요청 본문의 길이를 정하는 머리. 모호하면 `Err`(끊는다): 둘 다 있거나, 길이가 숫자가 아니거나 여러 값이 다르거나, chunked가 아닌 전송 인코딩
fn body_framing(headers: &[httparse::Header<'_>]) -> Result<BodyFraming, ()> {
    let lengths = header_values(headers, "content-length");
    let encodings = header_values(headers, "transfer-encoding");
    if !encodings.is_empty() {
        if !lengths.is_empty() {
            return Err(());
        }
        let joined = encodings.iter().map(|value| String::from_utf8_lossy(trim(value)).to_ascii_lowercase()).collect::<Vec<_>>().join(",");
        let last = joined.rsplit(',').next().unwrap_or("").trim().to_owned();
        return if last == "chunked" { Ok(BodyFraming::Chunked) } else { Err(()) };
    }
    let mut length: Option<u64> = None;
    for value in lengths {
        let text = std::str::from_utf8(trim(value)).map_err(|_| ())?;
        if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
            return Err(());
        }
        let parsed: u64 = text.parse().map_err(|_| ())?;
        if length.is_some_and(|previous| previous != parsed) {
            return Err(());
        }
        length = Some(parsed);
    }
    Ok(length.map_or(BodyFraming::None, BodyFraming::Length))
}

async fn handle_forward(mut client: TcpStream, context: &Context, method: &str, target: &str, headers: &[httparse::Header<'_>], leftover: Vec<u8>) {
    // 판정과 접속이 같은 파싱 결과를 쓰도록 여기서 한 번만 파싱한다. origin-form(`GET /path`)이나 깨진 대상은 어디로 가는지 알 수 없으므로 막는다
    let Ok(parsed) = Url::parse(target) else {
        block_url(context, target);
        return;
    };
    // 서비스 워커 스크립트는 허용 출처라도 막는다. 둘 중 하나만 있어도 막고, 다른 막기와 구분해 알린다
    let service_worker = !header_values(headers, "service-worker").is_empty()
        || header_values(headers, "sec-fetch-dest").iter().any(|value| trim(value).eq_ignore_ascii_case(b"serviceworker"));
    if service_worker {
        (context.on_blocked)(ProxyBlock::ServiceWorker(target.to_owned()));
        return;
    }
    let host_headers = header_values(headers, "host");
    let parsed_host = host_text(&parsed).map(|host| match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    });
    let host_matches = match (host_headers.as_slice(), parsed_host) {
        // 절대 형식 URL과 Host 머리가 다르면 어느 쪽이 진짜 목적지인지 알 수 없다
        ([only], Some(expected)) => std::str::from_utf8(trim(only)).map(|text| text.to_ascii_lowercase() == expected).unwrap_or(false),
        _ => false,
    };
    if parsed.scheme() != "http"
        || !parsed.username().is_empty()
        || parsed.password().is_some_and(|password| !password.is_empty())
        || !FORWARDED_METHODS.contains(&method)
        || !header_values(headers, "upgrade").is_empty()
        || !host_matches
        || !(context.is_allowed)(target)
    {
        block_url(context, target);
        return;
    }
    let Some(host) = host_text(&parsed) else {
        block_url(context, target);
        return;
    };
    let port = parsed.port().unwrap_or(80);
    let Ok(framing) = body_framing(headers) else { return };

    let upstream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((socket_host(&host), port))).await;
    let Ok(Ok(mut upstream)) = upstream else {
        bad_gateway(&mut client).await;
        return;
    };
    let _ = upstream.set_nodelay(true);

    let mut path = parsed.path().to_owned();
    if let Some(query) = parsed.query().filter(|query| !query.is_empty()) {
        path.push('?');
        path.push_str(query);
    }
    let skipped = hop_headers(headers);
    let mut head = format!("{method} {path} HTTP/1.1\r\n").into_bytes();
    for header in headers {
        if skipped.contains(&header.name.to_ascii_lowercase()) {
            continue;
        }
        head.extend_from_slice(header.name.as_bytes());
        head.extend_from_slice(b": ");
        head.extend_from_slice(header.value);
        head.extend_from_slice(b"\r\n");
    }
    head.extend_from_slice(b"Connection: close\r\n\r\n");
    if upstream.write_all(&head).await.is_err() {
        bad_gateway(&mut client).await;
        return;
    }
    let sent = match framing {
        BodyFraming::None => true,
        BodyFraming::Length(length) => relay_length(&mut client, &mut upstream, leftover, length).await,
        BodyFraming::Chunked => relay_chunked(&mut client, &mut upstream, leftover).await,
    };
    if !sent {
        return;
    }
    relay_response(client, upstream).await;
}

async fn bad_gateway(client: &mut TcpStream) {
    let body = "b-studio 출처 제한 프록시: 업스트림에 접속하지 못했습니다";
    let response = format!("HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len());
    let _ = client.write_all(response.as_bytes()).await;
    let _ = client.shutdown().await;
}

/// Content-Length만큼만 클라이언트에서 업스트림으로 옮긴다. 더 온 바이트(몰래 끼운 요청)는 버린다
async fn relay_length(client: &mut TcpStream, upstream: &mut TcpStream, leftover: Vec<u8>, length: u64) -> bool {
    let from_buffer = (leftover.len() as u64).min(length) as usize;
    if upstream.write_all(&leftover[..from_buffer]).await.is_err() {
        return false;
    }
    let remaining = length - from_buffer as u64;
    if remaining == 0 {
        return true;
    }
    matches!(tokio::io::copy(&mut client.take(remaining), upstream).await, Ok(copied) if copied == remaining)
}

/// chunked 본문을 청크 경계를 읽어 가며 옮긴다. 마지막 청크(와 트레일러) 뒤는 옮기지 않는다
async fn relay_chunked(client: &mut TcpStream, upstream: &mut TcpStream, leftover: Vec<u8>) -> bool {
    let mut buffer = leftover;
    // 버퍼에서 한 줄(\r\n까지)을 꺼낸다. 모자라면 클라이언트에서 더 읽는다
    async fn line(client: &mut TcpStream, buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
        loop {
            if let Some(position) = buffer.windows(2).position(|window| window == b"\r\n") {
                return Some(buffer.drain(..position + 2).collect());
            }
            if buffer.len() > 8192 {
                return None;
            }
            let mut chunk = [0u8; 4096];
            let read = client.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
    }
    async fn exactly(client: &mut TcpStream, buffer: &mut Vec<u8>, count: usize) -> Option<Vec<u8>> {
        while buffer.len() < count {
            let mut chunk = [0u8; 8192];
            let read = client.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
        Some(buffer.drain(..count).collect())
    }
    loop {
        let Some(size_line) = line(client, &mut buffer).await else { return false };
        let text = String::from_utf8_lossy(&size_line[..size_line.len() - 2]).into_owned();
        let size_text = text.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_text, 16) else { return false };
        if upstream.write_all(&size_line).await.is_err() {
            return false;
        }
        if size == 0 {
            // 트레일러: 빈 줄까지
            loop {
                let Some(trailer) = line(client, &mut buffer).await else { return false };
                if upstream.write_all(&trailer).await.is_err() {
                    return false;
                }
                if trailer.len() == 2 {
                    return true;
                }
            }
        }
        let Some(data) = exactly(client, &mut buffer, size + 2).await else { return false };
        if upstream.write_all(&data).await.is_err() {
            return false;
        }
    }
}

/// 업스트림의 응답을 머리만 걸러 클라이언트로 옮기고, 본문은 업스트림이 닫을 때까지 그대로 옮긴다
async fn relay_response(mut client: TcpStream, mut upstream: TcpStream) {
    let mut buffer = Vec::new();
    loop {
        let Some(head_len) = read_head(&mut upstream, &mut buffer).await else {
            bad_gateway(&mut client).await;
            return;
        };
        let mut headers = [httparse::EMPTY_HEADER; 96];
        let mut response = httparse::Response::new(&mut headers);
        if !matches!(response.parse(&buffer[..head_len]), Ok(httparse::Status::Complete(_))) {
            bad_gateway(&mut client).await;
            return;
        }
        let code = response.code.unwrap_or(502);
        let reason = response.reason.unwrap_or("");
        let skipped = hop_headers(response.headers);
        let mut head = format!("HTTP/1.1 {code} {reason}\r\n").into_bytes();
        for header in response.headers.iter() {
            if skipped.contains(&header.name.to_ascii_lowercase()) {
                continue;
            }
            head.extend_from_slice(header.name.as_bytes());
            head.extend_from_slice(b": ");
            head.extend_from_slice(header.value);
            head.extend_from_slice(b"\r\n");
        }
        // 101(Upgrade)은 요청에서 이미 막았으므로 올 수 없다. 오면 알 수 없는 응답이라 502로 끝낸다
        if code == 101 {
            bad_gateway(&mut client).await;
            return;
        }
        let interim = (100..200).contains(&code);
        if !interim {
            head.extend_from_slice(b"Connection: close\r\n");
        }
        head.extend_from_slice(b"\r\n");
        if client.write_all(&head).await.is_err() {
            return;
        }
        buffer.drain(..head_len);
        if interim {
            continue;
        }
        break;
    }
    if !buffer.is_empty() && client.write_all(&buffer).await.is_err() {
        return;
    }
    // 본문: 업스트림이 닫을 때까지. 클라이언트가 먼저 끊으면(또는 더 보내면) 업스트림을 놓는다
    let (mut client_read, mut client_write) = client.into_split();
    let mut probe = [0u8; 1];
    tokio::select! {
        _ = tokio::io::copy(&mut upstream, &mut client_write) => {}
        _ = client_read.read(&mut probe) => {}
    }
    let _ = client_write.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::AsyncReadExt;

    struct Harness {
        proxy: OriginProxy,
        blocked: Arc<Mutex<Vec<ProxyBlock>>>,
        upstream_port: u16,
        upstream_requests: Arc<Mutex<Vec<String>>>,
        _upstream_task: tokio::task::JoinHandle<()>,
    }

    /// 허용 출처는 가짜 업스트림 하나뿐이다. 업스트림은 요청 머리를 기록하고 `reply`를 돌려준다
    async fn harness(reply: &'static [u8]) -> Harness {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let upstream_requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let task = tokio::spawn({
            let requests = upstream_requests.clone();
            async move {
                loop {
                    let Ok((mut stream, _)) = upstream.accept().await else { return };
                    let requests = requests.clone();
                    tokio::spawn(async move {
                        let mut received = Vec::new();
                        let mut chunk = [0u8; 4096];
                        // 요청 머리와 짧은 본문까지 받을 시간을 준다
                        loop {
                            match tokio::time::timeout(Duration::from_millis(300), stream.read(&mut chunk)).await {
                                Ok(Ok(read)) if read > 0 => received.extend_from_slice(&chunk[..read]),
                                _ => break,
                            }
                        }
                        requests.lock().unwrap().push(String::from_utf8_lossy(&received).into_owned());
                        let _ = stream.write_all(reply).await;
                        let _ = stream.shutdown().await;
                    });
                }
            }
        });
        let allowed_origin = format!("http://127.0.0.1:{upstream_port}");
        let blocked = Arc::new(Mutex::new(Vec::new()));
        let proxy = OriginProxy::start(
            Arc::new(move |url: &str| super::super::origin::is_allowed_url(url, std::slice::from_ref(&allowed_origin))),
            {
                let blocked = blocked.clone();
                Arc::new(move |block| blocked.lock().unwrap().push(block))
            },
        )
        .await
        .unwrap();
        Harness { proxy, blocked, upstream_port, upstream_requests, _upstream_task: task }
    }

    /// 프록시에 날것의 바이트를 보내고 연결이 끝날 때까지 받은 것을 돌려준다
    async fn raw(harness: &Harness, bytes: &[u8]) -> Vec<u8> {
        let address = harness.proxy.server.trim_start_matches("http://").to_owned();
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(bytes).await.unwrap();
        let mut received = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut received)).await;
        received
    }

    fn get(harness: &Harness, path: &str, extra: &str) -> Vec<u8> {
        format!("GET http://127.0.0.1:{port}{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}\r\n", port = harness.upstream_port).into_bytes()
    }

    const OK: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nX-Custom: yes\r\n\r\nhi";

    #[tokio::test]
    async fn forwards_an_allowed_request_in_origin_form_without_hop_headers() {
        let harness = harness(OK).await;
        let response = raw(&harness, &get(&harness, "/a/./b/../c?x=1#frag", "Proxy-Connection: keep-alive\r\nConnection: keep-alive, X-Hop\r\nX-Hop: 1\r\nX-Keep: 2\r\n")).await;
        let text = String::from_utf8_lossy(&response).into_owned();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"), "{text}");
        assert!(text.contains("X-Custom: yes") && text.ends_with("hi"), "{text}");
        assert!(!text.contains("Keep-Alive") && text.contains("Connection: close"), "{text}");
        let seen = harness.upstream_requests.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        // 업스트림이 받은 대상은 정규화된 origin-form이고, 한 구간용 머리와 Connection이 이름 댄 머리는 없다
        assert!(seen[0].starts_with("GET /a/c?x=1 HTTP/1.1\r\n"), "{}", seen[0]);
        assert!(seen[0].contains("X-Keep: 2") && !seen[0].contains("X-Hop") && !seen[0].contains("Proxy-Connection"), "{}", seen[0]);
        assert!(seen[0].contains("Connection: close"), "{}", seen[0]);
        assert!(harness.blocked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn blocks_what_it_cannot_judge_without_touching_the_upstream() {
        let harness = harness(OK).await;
        let port = harness.upstream_port;
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("origin-form", format!("GET /path HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").into_bytes()),
            ("알 수 없는 메서드", format!("PROPFIND http://127.0.0.1:{port}/x HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").into_bytes()),
            ("Host 불일치", format!("GET http://127.0.0.1:{port}/x HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n").into_bytes()),
            ("Host 중복", format!("GET http://127.0.0.1:{port}/x HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nHost: 127.0.0.1:{port}\r\n\r\n").into_bytes()),
            ("Host 없음", format!("GET http://127.0.0.1:{port}/x HTTP/1.1\r\n\r\n").into_bytes()),
            ("Upgrade", format!("GET http://127.0.0.1:{port}/x HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n").into_bytes()),
            ("사용자 정보", format!("GET http://user:pw@127.0.0.1:{port}/x HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").into_bytes()),
            ("https", format!("GET https://127.0.0.1:{port}/x HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").into_bytes()),
            ("허용 밖 출처", b"GET http://127.0.0.1:1/x HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec()),
            ("다른 이름", format!("GET http://localhost:{port}/x HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n").into_bytes()),
        ];
        for (name, bytes) in cases {
            let response = raw(&harness, &bytes).await;
            assert!(response.is_empty(), "{name}: 막을 때는 응답 없이 끊는다: {}", String::from_utf8_lossy(&response));
        }
        assert!(harness.upstream_requests.lock().unwrap().is_empty());
        assert_eq!(harness.blocked.lock().unwrap().len(), 10);
        assert!(harness.blocked.lock().unwrap().iter().all(|block| matches!(block, ProxyBlock::Url(_))));
    }

    #[tokio::test]
    async fn service_worker_script_requests_are_blocked_even_for_allowed_origins() {
        let harness = harness(OK).await;
        for extra in ["Service-Worker: script\r\n", "Sec-Fetch-Dest: serviceworker\r\n", "sec-fetch-dest: ServiceWorker\r\n"] {
            let response = raw(&harness, &get(&harness, "/sw.js", extra)).await;
            assert!(response.is_empty(), "{extra}");
        }
        assert!(harness.upstream_requests.lock().unwrap().is_empty());
        let blocked = harness.blocked.lock().unwrap().clone();
        assert_eq!(blocked.len(), 3);
        assert!(blocked.iter().all(|block| *block == ProxyBlock::ServiceWorker(format!("http://127.0.0.1:{}/sw.js", harness.upstream_port))));
        // 다른 Sec-Fetch-Dest는 막지 않는다
        let response = raw(&harness, &get(&harness, "/x", "Sec-Fetch-Dest: script\r\n")).await;
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
    }

    #[tokio::test]
    async fn connect_opens_a_tunnel_only_for_the_allowed_host_and_port() {
        let harness = harness(OK).await;
        let port = harness.upstream_port;
        // 허용: 200 뒤에 터널이 선다. 업스트림이 돌려주는 바이트가 그대로 온다
        let response = raw(&harness, format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\nGET /t HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await;
        let text = String::from_utf8_lossy(&response).into_owned();
        assert!(text.starts_with("HTTP/1.1 200 Connection Established\r\n\r\n"), "{text}");
        assert!(text.ends_with("hi"), "{text}");
        // 허용 밖 포트·이름·모양: 403 뒤 끊고, 막은 것으로 센다
        for authority in ["127.0.0.1:1", "localhost:1", "evil.test:443", "user@127.0.0.1:80", "127.0.0.1:99999", "127.0.0.1", "[::1]:80"] {
            let response = raw(&harness, format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes()).await;
            assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 403 Forbidden"), "{authority}");
        }
        let tunnels = harness.blocked.lock().unwrap().iter().filter(|block| matches!(block, ProxyBlock::Tunnel(_))).count();
        assert_eq!(tunnels, 7);
    }

    #[tokio::test]
    async fn an_unreachable_upstream_is_a_502_not_a_pass() {
        // 허용 출처인데 아무도 듣지 않는 포트
        let closed = {
            let probe = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            probe.local_addr().unwrap().port()
        };
        let origin = format!("http://127.0.0.1:{closed}");
        let proxy = OriginProxy::start(Arc::new(move |url: &str| super::super::origin::is_allowed_url(url, std::slice::from_ref(&origin))), Arc::new(|_| {})).await.unwrap();
        let address = proxy.server.trim_start_matches("http://").to_owned();
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(format!("GET http://127.0.0.1:{closed}/ HTTP/1.1\r\nHost: 127.0.0.1:{closed}\r\n\r\n").as_bytes()).await.unwrap();
        let mut received = Vec::new();
        stream.read_to_end(&mut received).await.unwrap();
        assert!(String::from_utf8_lossy(&received).starts_with("HTTP/1.1 502 Bad Gateway"));
    }

    #[tokio::test]
    async fn request_bodies_are_forwarded_by_their_framing_and_pipelined_extras_are_dropped() {
        let harness = harness(OK).await;
        let port = harness.upstream_port;
        let post = format!("POST http://127.0.0.1:{port}/p HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 5\r\n\r\nhelloGET http://127.0.0.1:1/smuggled HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n");
        let response = raw(&harness, post.as_bytes()).await;
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
        let chunked = format!("POST http://127.0.0.1:{port}/c HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;ext=1\r\nde\r\n0\r\nX-Trailer: 1\r\n\r\n");
        let response = raw(&harness, chunked.as_bytes()).await;
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
        let seen = harness.upstream_requests.lock().unwrap().clone();
        assert_eq!(seen.len(), 2);
        let first = seen.iter().find(|request| request.contains("POST /p")).unwrap();
        assert!(first.ends_with("hello"), "{first}");
        assert!(!first.contains("smuggled"));
        let second = seen.iter().find(|request| request.contains("POST /c")).unwrap();
        assert!(second.ends_with("3\r\nabc\r\n2;ext=1\r\nde\r\n0\r\nX-Trailer: 1\r\n\r\n"), "{second}");
        // 길이가 모호하면 끊는다
        let ambiguous = format!("POST http://127.0.0.1:{port}/a HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
        assert!(raw(&harness, ambiguous.as_bytes()).await.is_empty());
    }

    #[tokio::test]
    async fn closing_the_proxy_drops_open_connections() {
        let harness = harness(OK).await;
        let address = harness.proxy.server.trim_start_matches("http://").to_owned();
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(b"GET http://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\n").await.unwrap();
        harness.proxy.close();
        let mut received = Vec::new();
        let outcome = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut received)).await;
        assert!(outcome.is_ok(), "닫은 프록시의 연결은 끊겨야 한다");
    }
}
