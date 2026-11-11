//! 앞단 연결 시험(ADR-195 4d): 직접 처리하는 경로는 Node(가짜 upstream)에 닿지 않고, 조건이 하나라도 어긋나면 요청을 바꾸지 않고 넘긴다.
mod common;

use bstudio_server::auth::Env;
use bstudio_server::proxy::AuthGate;
use common::*;

async fn run_with(gate: AuthGate, request: &str) -> (RawResponse, Vec<String>) {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front_with(sock, gate).await;
    let response = raw_request(port, request).await;
    let heads = seen.heads.lock().unwrap().clone();
    (response, heads)
}

fn env(pairs: &[(&str, &str)]) -> Env {
    Env::from_pairs(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
}

const EMPTY_LIST: &str = "{\"accounts\":[{\"id\":\"claude-code\",\"name\":\"기본\",\"backend\":\"claude-code\",\"builtin\":true}]}";

fn get(target: &str, extra: &str) -> String {
    format!("GET {target} HTTP/1.1\r\nHost: localhost:3000\r\n{extra}Connection: close\r\n\r\n")
}

#[tokio::test]
async fn 계정_목록은_앞단이_직접_답하고_node에_닿지_않는다() {
    let home = short_dir();
    let e = env(&[("HOME", home.path().to_str().unwrap()), ("B_STUDIO_MODE", "claude-code")]);
    for target in ["/api/ai-accounts", "/api/ai-accounts?x=1&y=%7B"] {
        let (response, heads) = run_with(AuthGate::with_env(e.clone()), &get(target, "")).await;
        assert_eq!(response.status(), 200);
        assert_eq!(String::from_utf8(response.body.clone()).unwrap(), EMPTY_LIST);
        assert!(response.header_lines().contains(&("content-type".to_string(), "application/json".to_string())));
        assert!(heads.is_empty(), "직접 답해야 하는 요청이 Node에 닿았다: {heads:?}");
    }
}

#[tokio::test]
async fn 인증을_켜면_사용자_확인_뒤_403을_직접_준다() {
    let secret = "P".repeat(32);
    let e = env(&[("B_STUDIO_AUTH", "proxy"), ("B_STUDIO_AUTH_PROXY_SECRET", &secret)]);
    let request = get("/api/ai-accounts", &format!("X-B-Studio-Proxy-Secret: {secret}\r\nX-Forwarded-User: alice\r\n"));
    let (response, heads) = run_with(AuthGate::with_env(e.clone()), &request).await;
    assert_eq!(response.status(), 403);
    assert_eq!(String::from_utf8(response.body).unwrap(), "{\"error\":\"계정은 개인 PC 모드(로컬 CLI)에서만 씁니다\"}");
    assert!(heads.is_empty());
    // 사용자를 확인하지 못하면 이 경로의 응답이 아니라 인증 거절이다(401)
    let (response, heads) = run_with(AuthGate::with_env(e), &get("/api/ai-accounts", "")).await;
    assert_eq!(response.status(), 401);
    assert!(heads.is_empty());
}

/// 응답은 읽지 않고(HEAD 등은 본문 규칙이 달라 읽기 도구가 맞지 않는다) Node가 요청을 받을 때까지만 기다린다
async fn forwarded(gate: AuthGate, request: &str) -> usize {
    use tokio::io::AsyncWriteExt;
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front_with(sock, gate).await;
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    for _ in 0..100 {
        if !seen.heads.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let count = seen.heads.lock().unwrap().len();
    count
}

#[tokio::test]
async fn 조건이_어긋나면_그대로_넘긴다() {
    let home = short_dir();
    let e = || env(&[("HOME", home.path().to_str().unwrap()), ("B_STUDIO_MODE", "claude-code")]);
    let cases = [
        // 경로: 정규화가 필요하거나 끝 슬래시, 퍼센트 인코딩, 대소문자, 역슬래시, 겹친 슬래시, 하위 경로
        get("/api/ai-accounts/", ""),
        get("/api/%61i-accounts", ""),
        get("/api/AI-accounts", ""),
        get("/api/./ai-accounts", ""),
        get("/api/x/../ai-accounts", ""),
        get("/api//ai-accounts", ""),
        get("/api\\ai-accounts", ""),
        get("/api/ai-accounts/claude-code", ""),
        // 메서드
        "HEAD /api/ai-accounts HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".to_string(),
        "OPTIONS /api/ai-accounts HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".to_string(),
        "POST /api/ai-accounts HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_string(),
        "DELETE /api/ai-accounts HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nOrigin: http://localhost\r\nConnection: close\r\n\r\n".to_string(),
        // 본문이 있는 GET(청크)
        "GET /api/ai-accounts HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n".to_string(),
        // 본문이 있는 GET
        "GET /api/ai-accounts HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_string(),
    ];
    for request in cases {
        let heads = forwarded(AuthGate::with_env(e()), &request).await;
        assert_eq!(heads, 1, "넘기지 않았다: {request:?}");
    }
    // 판단을 끈 게이트는 직접 답하지 않는다
    assert_eq!(forwarded(AuthGate::disabled(), &get("/api/ai-accounts", "")).await, 1);
    // 판단하지 못하는 요청(Defer): Host 없음, 주소에 사용자 정보
    assert_eq!(forwarded(AuthGate::with_env(e()), "GET /api/ai-accounts HTTP/1.1\r\nConnection: close\r\n\r\n").await, 1);
    // 직접 답할 수 없는 설정: 홈이 없다·모드가 틀림·허용 목록이 틀림
    for broken in [env(&[]), env(&[("HOME", "/tmp"), ("B_STUDIO_MODE", "bogus")]), env(&[("HOME", "/tmp"), ("B_STUDIO_BACKENDS", "bogus")])] {
        assert_eq!(forwarded(AuthGate::with_env(broken), &get("/api/ai-accounts", "")).await, 1);
    }
    // 거절은 직접 답하는 경로여도 인증 거절이다(다른 Host)
    let (response, heads) = run_with(AuthGate::with_env(e()), "GET /api/ai-accounts HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await;
    assert_eq!((response.status(), heads.len()), (403, 0));
}
