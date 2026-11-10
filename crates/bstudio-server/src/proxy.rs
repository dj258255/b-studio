//! Node로 요청을 바꾸지 않고 넘기는 프록시(ADR-195 결정 2~4).
//!
//! 프록시 라이브러리를 쓰지 않고 hyper의 낮은 층(`client::conn::http1`)으로 직접 넘긴다. 라이브러리는 Host를 다시 쓰거나
//! `x-forwarded-*`를 더하는 기본 동작이 있고, 인증이 두 헤더(`isLocalHost`는 Host, `isSameOrigin`은 `x-forwarded-host`를 먼저)를 읽기 때문이다.
//! 요청마다 소켓을 새로 연다(유닉스 소켓은 연결이 싸고, 손님이 끊으면 그 연결 하나만 닫으면 되어 취소가 단순하다).
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{HeaderMap, CONTENT_TYPE};
use axum::http::uri::{Parts, PathAndQuery};
use axum::http::{HeaderValue, StatusCode, Uri, Version};
use axum::response::Response;
use axum::Router;
use hyper::body::{Body as HttpBody, Frame, Incoming, SizeHint};
use hyper::client::conn::http1;
use hyper::server::conn::http1 as server_http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::net::{TcpListener, UnixStream};
use tokio::task::JoinHandle;

/// 헤더를 다 받기까지의 한도. Node(`server.headersTimeout`)와 같다. 요청 시간 한도는 없다(SSE)
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(60);

/// 요청·응답 양쪽에서 빼는 hop-by-hop 헤더(RFC 9110 7.6.1의 고정 목록). 메시지 틀(연결·전송 방식)을 앞단과 Node가 각자 정하므로 뺀다
const HOP_BY_HOP: [&str; 8] = ["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate"];

#[derive(Clone)]
struct Upstream {
    socket: Arc<PathBuf>,
}

/// 모든 경로·메서드를 이 소켓의 Node로 넘기는 라우터. 뒤 조각에서 경로를 옮기면 여기에 경로를 더한다(나머지는 fallback으로 계속 넘어간다)
pub fn router(upstream: impl Into<PathBuf>) -> Router {
    Router::new().fallback(forward).with_state(Upstream { socket: Arc::new(upstream.into()) })
}

/// 공개 포트에서 듣는다. `shutdown`이 끝나면 새 연결을 받지 않는다
pub async fn serve(listener: TcpListener, router: Router, shutdown: impl Future<Output = ()>) {
    serve_with_header_timeout(listener, router, shutdown, HEADER_TIMEOUT).await;
}

pub async fn serve_with_header_timeout(listener: TcpListener, router: Router, shutdown: impl Future<Output = ()>, header_timeout: Duration) {
    tokio::pin!(shutdown);
    loop {
        let stream = tokio::select! {
            _ = &mut shutdown => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(error) => {
                    // 파일 기술자 부족 같은 일시 오류에 바쁜 루프가 되지 않게 잠깐 쉰다
                    eprintln!("[b-studio 앞단] 연결을 받지 못했습니다: {error}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
        };
        let _ = stream.set_nodelay(true);
        let service = TowerToHyperService::new(router.clone());
        tokio::spawn(async move {
            // 업그레이드(`with_upgrades`)는 켜지 않는다. 지금 Node도 받지 않는다
            let connection = server_http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(header_timeout).serve_connection(TokioIo::new(stream), service);
            let _ = connection.await;
        });
    }
}

async fn forward(State(upstream): State<Upstream>, request: Request) -> Response {
    match forward_inner(&upstream.socket, request).await {
        Ok(response) => response,
        Err(message) => {
            eprintln!("[b-studio 앞단] {message}");
            bad_gateway(&message)
        }
    }
}

fn bad_gateway(message: &str) -> Response {
    let body = format!("{{\"error\":{}}}", json_string(message));
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::BAD_GATEWAY;
    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    response
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// hop-by-hop을 뺀다: 고정 목록만. `Connection`에 이름이 적힌 헤더는 빼지 않는다(RFC 9110 7.6.1과 다르게).
/// 받는 쪽은 우리 Node이고 Node는 그 이름을 따로 다루지 않으므로, 빼면 직접 붙을 때와 판단이 갈린다.
/// 손님이 `Connection: origin`을 보내 Origin을 빼면 같은 출처 확인(`isSameOrigin`)이 "Origin 없음"으로 통과한다
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}

/// 떨어지면 연결 구동 작업을 멈춘다. 손님이 끊어 요청·응답이 버려지면 Node로 가는 연결도 닫힌다
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Node의 응답 본문을 그대로 흘리면서, 손님이 끊어 이 본문이 버려질 때 Node 연결도 닫는다
struct Streamed {
    inner: Incoming,
    _driver: AbortOnDrop,
}

impl HttpBody for Streamed {
    type Data = <Incoming as HttpBody>::Data;
    type Error = <Incoming as HttpBody>::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

async fn forward_inner(socket: &PathBuf, request: Request) -> Result<Response, String> {
    let (mut parts, body) = request.into_parts();

    let stream = UnixStream::connect(socket).await.map_err(|error| format!("Node 서버에 연결하지 못했습니다: {error}"))?;
    let (mut sender, connection) = http1::handshake::<_, Body>(TokioIo::new(stream)).await.map_err(|error| format!("Node 서버와 연결을 시작하지 못했습니다: {error}"))?;
    // 이 연결 하나만 구동한다. 요청이 버려지면(손님이 끊으면) 아래 guard가 떨어지며 연결을 닫는다
    let driver = AbortOnDrop(tokio::spawn(async move {
        let _ = connection.await;
    }));

    strip_hop_by_hop(&mut parts.headers);
    // 경로·쿼리는 원문 그대로, origin-form으로 넘긴다. Host는 헤더에 있는 그대로이고 낮은 층 클라이언트는 만들어 붙이지 않는다
    let mut uri_parts = Parts::default();
    uri_parts.path_and_query = Some(parts.uri.path_and_query().cloned().unwrap_or_else(|| PathAndQuery::from_static("/")));
    let uri = Uri::from_parts(uri_parts).map_err(|error| format!("요청 주소를 넘기지 못했습니다: {error}"))?;

    let mut upstream_request = Request::new(body);
    *upstream_request.method_mut() = parts.method;
    *upstream_request.uri_mut() = uri;
    *upstream_request.version_mut() = Version::HTTP_11;
    *upstream_request.headers_mut() = parts.headers;

    let response = sender.send_request(upstream_request).await.map_err(|error| format!("Node 서버가 응답하지 않았습니다: {error}"))?;
    let (mut response_parts, incoming) = response.into_parts();
    strip_hop_by_hop(&mut response_parts.headers);
    // sender도 본문과 함께 살려 둔다(먼저 떨어지면 연결이 닫혀 본문이 끊긴다)
    let body = Body::new(Streamed { inner: incoming, _driver: driver });
    drop(sender);
    Ok(Response::from_parts(response_parts, body))
}
