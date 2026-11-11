//! 통합 시험 도구: 가짜 upstream(유닉스 소켓, 날것의 바이트)과 날것의 HTTP 손님
#![allow(dead_code)]
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixListener};
use tokio::sync::oneshot;

pub fn short_dir() -> tempfile::TempDir {
    // macOS의 기본 임시 폴더는 길어서 소켓 경로 상한(104)에 닿을 수 있다. 짧은 이름만 쓴다
    tempfile::Builder::new().prefix("bs").tempdir_in("/tmp").unwrap()
}

/// upstream이 받은 요청 머리(날것)와 본문
#[derive(Default, Clone)]
pub struct Seen {
    pub heads: Arc<Mutex<Vec<String>>>,
}

/// 가짜 upstream이 요청 하나에 하는 일
pub enum Reply {
    /// 날것의 응답 바이트를 그대로 쓰고 닫지 않는다
    Raw(Vec<u8>),
    /// 머리와 첫 조각을 쓰고 멈춘다. 손님이 끊기면 끊김을 신호로 알린다
    StallAfterFirstChunk { head_and_chunk: Vec<u8>, closed: oneshot::Sender<()> },
}

pub async fn spawn_upstream(path: &Path, seen: Seen, reply: Reply) {
    let listener = UnixListener::bind(path).unwrap();
    let reply = Arc::new(Mutex::new(Some(reply)));
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let seen = seen.clone();
            let reply = reply.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let end = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
                seen.heads.lock().unwrap().push(String::from_utf8_lossy(&buf[..end]).into_owned());
                let taken = reply.lock().unwrap().take();
                match taken {
                    Some(Reply::Raw(bytes)) => {
                        stream.write_all(&bytes).await.unwrap();
                        // 손님이 끊을 때까지 연결을 연다(keep-alive 흉내)
                        let _ = stream.read(&mut chunk).await;
                    }
                    Some(Reply::StallAfterFirstChunk { head_and_chunk, closed }) => {
                        stream.write_all(&head_and_chunk).await.unwrap();
                        // 끊김을 본다: 읽기가 0(EOF)이나 오류로 끝난다
                        loop {
                            match stream.read(&mut chunk).await {
                                Ok(0) | Err(_) => break,
                                Ok(_) => {}
                            }
                        }
                        let _ = closed.send(());
                    }
                    None => {}
                }
            });
        }
    });
}

/// 앞단을 TCP 임시 포트에 붙여 돌린다(인증 판단은 끈다: 프록시 규칙만 본다). (포트, 종료 신호)
pub async fn spawn_front(upstream: PathBuf) -> (u16, oneshot::Sender<()>) {
    spawn_front_with(upstream, bstudio_server::proxy::AuthGate::disabled()).await
}

/// 인증 판단을 정해서 앞단을 돌린다
pub async fn spawn_front_with(upstream: PathBuf, gate: bstudio_server::proxy::AuthGate) -> (u16, oneshot::Sender<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (stop, stopped) = oneshot::channel::<()>();
    let router = bstudio_server::proxy::router(upstream, gate);
    tokio::spawn(async move {
        bstudio_server::proxy::serve(listener, router, async {
            let _ = stopped.await;
        })
        .await;
    });
    (port, stop)
}

/// 날것의 응답 하나(머리 + content-length 본문)
pub struct RawResponse {
    pub head: String,
    pub body: Vec<u8>,
}

impl RawResponse {
    pub fn status(&self) -> u16 {
        self.head.split(' ').nth(1).unwrap().parse().unwrap()
    }
    /// 머리 줄들(상태 줄 제외), 이름은 소문자
    pub fn header_lines(&self) -> Vec<(String, String)> {
        parse_header_lines(&self.head)
    }
}

pub fn parse_header_lines(head: &str) -> Vec<(String, String)> {
    head.split("\r\n")
        .skip(1)
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (n, v) = l.split_once(':').unwrap();
            (n.trim().to_ascii_lowercase(), v.trim().to_string())
        })
        .collect()
}

/// 요청 바이트를 그대로 보내고 응답 하나를 읽는다(content-length 본문)
pub async fn raw_request(port: u16, request: &str) -> RawResponse {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    read_response(&mut stream).await
}

pub async fn read_response(stream: &mut TcpStream) -> RawResponse {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.expect("응답 머리가 오지 않았다").unwrap();
        assert!(n > 0, "머리가 오기 전에 연결이 닫혔다: {:?}", String::from_utf8_lossy(&buf));
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let length = parse_header_lines(&head).iter().find(|(n, _)| n == "content-length").map(|(_, v)| v.parse::<usize>().unwrap()).unwrap_or(0);
    let mut body = buf[end..].to_vec();
    while body.len() < length {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.expect("본문이 오지 않았다").unwrap();
        assert!(n > 0, "본문이 오기 전에 닫혔다");
        body.extend_from_slice(&chunk[..n]);
    }
    RawResponse { head, body }
}

pub const OK_EMPTY: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
