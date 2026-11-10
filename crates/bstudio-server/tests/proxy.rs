//! 프록시 규칙 시험(ADR-195 결정 2~4). 날것의 바이트로 주고받아 앞단이 무엇을 바꾸는지 그대로 본다
mod common;

use std::time::Duration;

use common::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

fn lines(head: &str) -> Vec<(String, String)> {
    parse_header_lines(head)
}

fn all(lines: &[(String, String)], name: &str) -> Vec<String> {
    lines.iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect()
}

/// 규칙 1·2: 메서드·경로·쿼리 원문, Host·쿠키(둘)·Origin·x-forwarded-*·x-b-studio-*가 그대로 가고 hop-by-hop만 빠진다
#[tokio::test]
async fn 요청을_바꾸지_않고_넘기고_hop_by_hop만_뺀다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front(sock).await;

    let request = "GET //a/../b%2F%20c/.//d?x=%7B1%7D&y=a%20b&&z HTTP/1.1\r\n\
        Host: studio.example:8080\r\n\
        Cookie: a=1\r\n\
        Cookie: b_studio_local=tok\r\n\
        Origin: http://evil.example\r\n\
        X-Forwarded-Host: proxy.example\r\n\
        X-Forwarded-For: 1.2.3.4\r\n\
        X-B-Studio-User: alice\r\n\
        Connection: keep-alive, X-Secret-Hop\r\n\
        X-Secret-Hop: 1\r\n\
        Keep-Alive: timeout=5\r\n\
        TE: trailers\r\n\
        Trailer: x-t\r\n\
        Upgrade: websocket\r\n\
        Proxy-Authorization: Basic eA==\r\n\
        Proxy-Authenticate: Basic\r\n\r\n";
    let response = raw_request(port, request).await;
    assert_eq!(response.status(), 200);

    let head = seen.heads.lock().unwrap()[0].clone();
    let first = head.split("\r\n").next().unwrap();
    assert_eq!(first, "GET //a/../b%2F%20c/.//d?x=%7B1%7D&y=a%20b&&z HTTP/1.1");
    let h = lines(&head);
    assert_eq!(all(&h, "host"), ["studio.example:8080"], "Host를 다시 쓰면 안 된다");
    assert_eq!(all(&h, "cookie"), ["a=1", "b_studio_local=tok"], "쿠키는 순서·개수 그대로");
    assert_eq!(all(&h, "origin"), ["http://evil.example"]);
    assert_eq!(all(&h, "x-forwarded-host"), ["proxy.example"]);
    assert_eq!(all(&h, "x-forwarded-for"), ["1.2.3.4"], "손님이 보낸 값은 그대로, 앞단이 더하지 않는다");
    assert_eq!(all(&h, "x-b-studio-user"), ["alice"]);
    // Connection에 적힌 이름은 빼지 않는다. 받는 쪽은 우리 Node이고, Node에 직접 붙을 때도 그 헤더를 받았다
    assert_eq!(all(&h, "x-secret-hop"), ["1"]);
    for gone in ["keep-alive", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "transfer-encoding"] {
        assert!(all(&h, gone).is_empty(), "{gone}은 빠져야 한다: {head}");
    }
    // 앞단이 위에 없던 머리를 만들어 붙이지 않는다
    for (name, _) in &h {
        assert!(
            ["host", "cookie", "origin", "x-forwarded-host", "x-forwarded-for", "x-b-studio-user", "x-secret-hop", "connection", "content-length"].contains(&name.as_str()),
            "새로 생긴 머리: {name}"
        );
    }
}

/// 규칙 2: Connection에 인증이 읽는 헤더 이름을 적어도 빠지지 않는다. 빠지면 Origin이 없는 요청이 같은 출처로 읽히고(isSameOrigin),
/// Host가 없는 요청이 되어 Node에 직접 붙을 때와 판단이 갈린다
#[tokio::test]
async fn connection에_적은_이름으로_인증이_읽는_헤더를_뺄_수_없다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front(sock).await;

    let request = "POST /api/sessions HTTP/1.1\r\n\
        Host: 127.0.0.1:3000\r\n\
        Origin: http://evil.example\r\n\
        Cookie: b_studio_local=tok\r\n\
        X-Forwarded-Host: proxy.example\r\n\
        X-B-Studio-Proxy-Secret: s\r\n\
        Content-Length: 0\r\n\
        Connection: origin, host, cookie, x-forwarded-host, x-b-studio-proxy-secret\r\n\r\n";
    raw_request(port, request).await;
    let head = seen.heads.lock().unwrap()[0].clone();
    let h = lines(&head);
    assert_eq!(all(&h, "origin"), ["http://evil.example"], "{head}");
    assert_eq!(all(&h, "host"), ["127.0.0.1:3000"], "{head}");
    assert_eq!(all(&h, "cookie"), ["b_studio_local=tok"], "{head}");
    assert_eq!(all(&h, "x-forwarded-host"), ["proxy.example"], "{head}");
    assert_eq!(all(&h, "x-b-studio-proxy-secret"), ["s"], "{head}");
}

/// 규칙 2: 손님이 x-forwarded-*를 안 보냈으면 Node에도 없다(isSameOrigin이 x-forwarded-host를 먼저 본다)
#[tokio::test]
async fn x_forwarded나_via를_더하지_않는다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front(sock).await;

    raw_request(port, "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n\r\n").await;
    let head = seen.heads.lock().unwrap()[0].clone().to_ascii_lowercase();
    for banned in ["x-forwarded", "forwarded:", "via:", "x-real-ip"] {
        assert!(!head.contains(banned), "{banned}가 새로 붙었다: {head}");
    }
    assert!(head.contains("host: 127.0.0.1:3000\r\n"), "{head}");
}

/// 규칙 2(요청 쪽): Upgrade 요청은 받지 않는다 — 지금 Node처럼 업그레이드 없이 보통 요청으로 답한다
#[tokio::test]
async fn upgrade_요청은_업그레이드_없이_보통_요청으로_넘긴다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front(sock).await;

    let response = raw_request(port, "GET /ws HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\n\r\n").await;
    assert_eq!(response.status(), 200, "101이 아니다");
    let head = seen.heads.lock().unwrap()[0].to_ascii_lowercase();
    assert!(!head.contains("upgrade"), "{head}");
}

/// 규칙 2(응답 쪽): 같은 규칙. Set-Cookie 둘은 순서·개수 그대로, hop-by-hop은 빠지고 x-b-studio-*는 남는다
#[tokio::test]
async fn 응답도_같은_규칙으로_돌려준다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let upstream_reply = b"HTTP/1.1 201 Created\r\n\
        Set-Cookie: a=1; Path=/\r\n\
        Set-Cookie: b=2; HttpOnly\r\n\
        X-B-Studio-Note: kept\r\n\
        Connection: keep-alive, X-Hop\r\n\
        X-Hop: 1\r\n\
        Keep-Alive: timeout=5\r\n\
        Proxy-Authenticate: Basic\r\n\
        Content-Type: application/json\r\n\
        Content-Length: 12\r\n\r\n{\"ok\":true}\n"
        .to_vec();
    spawn_upstream(&sock, Seen::default(), Reply::Raw(upstream_reply)).await;
    let (port, _stop) = spawn_front(sock).await;

    let response = raw_request(port, "GET / HTTP/1.1\r\nHost: h\r\n\r\n").await;
    assert_eq!(response.status(), 201);
    let h = response.header_lines();
    assert_eq!(all(&h, "set-cookie"), ["a=1; Path=/", "b=2; HttpOnly"]);
    assert_eq!(all(&h, "x-b-studio-note"), ["kept"]);
    assert_eq!(all(&h, "content-type"), ["application/json"]);
    assert_eq!(all(&h, "x-hop"), ["1"], "Node가 보낸 헤더는 Connection에 적혀도 그대로(직접 붙을 때와 같다)");
    for gone in ["keep-alive", "proxy-authenticate"] {
        assert!(all(&h, gone).is_empty(), "{gone}은 빠져야 한다: {}", response.head);
    }
    assert_eq!(response.body, b"{\"ok\":true}\n");
}

/// 규칙 3: 응답을 모으지 않는다. upstream이 첫 조각만 보내고 멈춰도 손님은 그 조각을 받는다(SSE)
#[tokio::test]
async fn sse는_첫_조각을_바로_흘린다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let (closed_tx, _closed_rx) = oneshot::channel();
    let head_and_chunk = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\n\r\nd\r\ndata: first\n\n\r\n".to_vec();
    spawn_upstream(&sock, Seen::default(), Reply::StallAfterFirstChunk { head_and_chunk, closed: closed_tx }).await;
    let (port, _stop) = spawn_front(sock).await;

    let mut guest = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    guest.write_all(b"GET /api/agents/stream HTTP/1.1\r\nHost: h\r\nAccept: text/event-stream\r\n\r\n").await.unwrap();
    let mut got = Vec::new();
    let mut chunk = [0u8; 1024];
    let started = std::time::Instant::now();
    while !String::from_utf8_lossy(&got).contains("data: first") {
        let n = tokio::time::timeout(Duration::from_secs(2), guest.read(&mut chunk)).await.expect("upstream이 멈춰 있어도 첫 조각이 와야 한다(응답을 모으고 있다)").unwrap();
        assert!(n > 0);
        got.extend_from_slice(&chunk[..n]);
    }
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(String::from_utf8_lossy(&got).to_ascii_lowercase().contains("content-type: text/event-stream"));
}

/// 규칙 3: 손님이 끊으면 Node로 가는 연결도 끊어 Node가 close를 본다
#[tokio::test]
async fn 손님이_끊으면_upstream_연결도_끊긴다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let (closed_tx, closed_rx) = oneshot::channel();
    let head_and_chunk = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\nd\r\ndata: first\n\n\r\n".to_vec();
    spawn_upstream(&sock, Seen::default(), Reply::StallAfterFirstChunk { head_and_chunk, closed: closed_tx }).await;
    let (port, _stop) = spawn_front(sock).await;

    let mut guest = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    guest.write_all(b"GET /s HTTP/1.1\r\nHost: h\r\n\r\n").await.unwrap();
    let mut got = Vec::new();
    let mut chunk = [0u8; 1024];
    while !String::from_utf8_lossy(&got).contains("data: first") {
        let n = tokio::time::timeout(Duration::from_secs(2), guest.read(&mut chunk)).await.expect("첫 조각이 오지 않았다").unwrap();
        assert!(n > 0);
        got.extend_from_slice(&chunk[..n]);
    }
    drop(guest);
    tokio::time::timeout(Duration::from_secs(3), closed_rx).await.expect("손님이 끊었는데 upstream 연결이 열려 있다").unwrap();
}

/// 규칙 3: 응답 머리가 오기 전에 손님이 끊어도 upstream 연결이 끊긴다
#[tokio::test]
async fn 머리를_기다리는_중에_끊어도_upstream_연결이_끊긴다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let (closed_tx, closed_rx) = oneshot::channel();
    // 머리조차 쓰지 않고 멈춘다
    spawn_upstream(&sock, Seen::default(), Reply::StallAfterFirstChunk { head_and_chunk: Vec::new(), closed: closed_tx }).await;
    let (port, _stop) = spawn_front(sock).await;

    let mut guest = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    guest.write_all(b"GET /slow HTTP/1.1\r\nHost: h\r\n\r\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(guest);
    tokio::time::timeout(Duration::from_secs(3), closed_rx).await.expect("머리를 기다리는 중 끊었는데 upstream 연결이 열려 있다").unwrap();
}

/// 규칙 3: 요청 본문도 모으지 않는다. 본문이 다 오기 전에 upstream은 머리를 이미 받았다
#[tokio::test]
async fn 요청_본문을_모으지_않고_흘린다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front(sock).await;

    let mut guest = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    guest.write_all(b"POST /api/x HTTP/1.1\r\nHost: h\r\nContent-Length: 1000\r\nContent-Type: application/json\r\n\r\n{\"a\":").await.unwrap();
    let started = std::time::Instant::now();
    loop {
        if seen.heads.lock().unwrap().len() == 1 {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(2), "본문이 끝나지 않았는데 upstream이 머리를 받지 못했다(요청을 모으고 있다)");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let head = seen.heads.lock().unwrap()[0].to_ascii_lowercase();
    assert!(head.contains("content-length: 1000"), "{head}");
}

/// 규칙 4: Node에 닿지 못하면 502와 JSON 오류(한국어)
#[tokio::test]
async fn upstream이_없으면_502_json을_준다() {
    let dir = short_dir();
    let (port, _stop) = spawn_front(dir.path().join("none.sock")).await;

    let response = raw_request(port, "GET /api/health HTTP/1.1\r\nHost: h\r\n\r\n").await;
    assert_eq!(response.status(), 502);
    assert!(all(&response.header_lines(), "content-type")[0].starts_with("application/json"));
    let body = String::from_utf8(response.body).unwrap();
    let error = body.split("\"error\":\"").nth(1).unwrap_or_else(|| panic!("error 키가 없다: {body}"));
    assert!(error.chars().any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c)), "한국어 메시지여야 한다: {body}");
}

/// 규칙 3: 헤더 시간 한도. 머리를 끝내지 않는 손님은 한도 뒤에 끊긴다(요청 시간 한도는 없다)
#[tokio::test]
async fn 머리를_끝내지_않는_손님은_한도_뒤에_끊긴다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    spawn_upstream(&sock, Seen::default(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = bstudio_server::proxy::router(sock);
    tokio::spawn(bstudio_server::proxy::serve_with_header_timeout(listener, router, std::future::pending(), Duration::from_millis(500)));

    let mut guest = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    guest.write_all(b"GET / HTTP/1.1\r\nHost: h\r\n").await.unwrap(); // 머리를 끝내지 않는다
    let mut chunk = [0u8; 256];
    let n = tokio::time::timeout(Duration::from_secs(3), guest.read(&mut chunk)).await.expect("한도가 지나도 끊기지 않았다");
    // 408을 쓰고 닫거나 그냥 닫는다. 어느 쪽이든 더 읽을 것이 없어야 한다
    let _ = n;
    let after = tokio::time::timeout(Duration::from_secs(3), guest.read(&mut chunk)).await.expect("닫히지 않았다");
    assert!(matches!(after, Ok(0) | Err(_)));
}
