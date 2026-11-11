//! 앞단 연결 시험(ADR-195 4c): 거절은 앞단이 직접 답하고 Node(가짜 upstream)에 닿지 않는다. 통과·허용·넘김은 요청을 하나도 바꾸지 않고
//! 넘긴다(앞단은 `x-b-studio-user`를 넣지 않는다). 판단이 틀렸을 때의 열림은 Node가 다시 판단하므로 막히지만, 여기서는 앞단이 무엇을 하는지 본다.
mod common;

use bstudio_server::auth::Env;
use bstudio_server::proxy::AuthGate;
use common::*;

async fn run(env: Env, request: &str) -> (RawResponse, Vec<String>) {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front_with(sock, AuthGate::with_env(env)).await;
    let response = raw_request(port, request).await;
    let heads = seen.heads.lock().unwrap().clone();
    (response, heads)
}

fn env(pairs: &[(&str, &str)]) -> Env {
    Env::from_pairs(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
}

fn header(response: &RawResponse, name: &str) -> Option<String> {
    response.header_lines().into_iter().find(|(n, _)| n == name).map(|(_, v)| v)
}

#[tokio::test]
async fn 거절은_앞단이_직접_답하고_upstream에_닿지_않는다() {
    // API 경로: JSON. 인증 없음 모드에서 이 컴퓨터의 주소가 아닌 Host
    let (response, heads) = run(env(&[]), "GET /api/agents HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await;
    assert_eq!(response.status(), 403);
    assert_eq!(header(&response, "content-type").as_deref(), Some("application/json"));
    let body = String::from_utf8(response.body.clone()).unwrap();
    assert_eq!(body, "{\"error\":\"인증 없이 띄운 스튜디오는 이 컴퓨터의 주소(127.0.0.1 · localhost)로 온 요청만 받습니다. 다른 이름으로 쓰려면 B_STUDIO_ALLOWED_HOSTS에 그 이름을 적거나 인증을 켜세요\"}");
    assert!(heads.is_empty(), "거절한 요청이 Node에 닿았다: {heads:?}");

    // 화면 경로: text/plain
    let (response, heads) = run(env(&[]), "GET /x HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await;
    assert_eq!(response.status(), 403);
    assert_eq!(header(&response, "content-type").as_deref(), Some("text/plain; charset=utf-8"));
    assert!(String::from_utf8(response.body).unwrap().starts_with("인증 없이 띄운 스튜디오는"));
    assert!(heads.is_empty());

    // 다른 출처의 상태 변경 요청
    let (response, heads) = run(env(&[]), "POST /api/x HTTP/1.1\r\nHost: localhost\r\nOrigin: http://evil.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
    assert_eq!(response.status(), 403);
    assert_eq!(String::from_utf8(response.body).unwrap(), "{\"error\":\"다른 출처에서 보낸 요청은 받지 않습니다\"}");
    assert!(heads.is_empty());
}

#[tokio::test]
async fn 머리만_받는_요청의_거절은_본문이_없다() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front_with(sock, AuthGate::with_env(env(&[]))).await;
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(b"HEAD /api/agents HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8(raw).unwrap();
    assert!(text.starts_with("HTTP/1.1 403 Forbidden\r\n"), "{text}");
    assert!(text.to_ascii_lowercase().contains("content-type: application/json\r\n"));
    assert!(text.ends_with("\r\n\r\n"), "머리 뒤에 본문이 있다: {text}");
    assert!(seen.heads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn 통과와_허용은_요청을_하나도_바꾸지_않고_넘긴다() {
    let request = "GET //a/../b%2F%20c/.//d?x=%7B1%7D HTTP/1.1\r\nHost: Localhost:3000\r\nCookie: a=1\r\nCookie: b_studio_session=junk\r\nX-B-Studio-User: mallory\r\nOrigin: http://localhost:3000\r\nConnection: close\r\n\r\n";
    // none 모드: 허용(local). 앞단은 사용자 헤더를 넣지 않고, 손님이 보낸 값도 지우지 않는다(Node가 지우고 다시 넣는다)
    let (response, heads) = run(env(&[]), request).await;
    assert_eq!(response.status(), 200);
    assert_eq!(heads.len(), 1);
    let head = heads[0].to_ascii_lowercase();
    assert!(head.starts_with("get //a/../b%2f%20c/.//d?x=%7b1%7d http/1.1\r\n"), "{head}");
    assert!(head.contains("host: localhost:3000\r\n") && head.contains("cookie: a=1\r\n") && head.contains("cookie: b_studio_session=junk\r\n"));
    assert_eq!(head.matches("x-b-studio-user").count(), 1, "앞단이 사용자 헤더를 더하거나 지웠다: {head}");
    assert!(head.contains("x-b-studio-user: mallory\r\n"));

    // 공개 경로는 Host가 틀려도 통과
    let (response, heads) = run(env(&[]), "GET /api/health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await;
    assert_eq!((response.status(), heads.len()), (200, 1));
}

#[tokio::test]
async fn 앞단이_판단하지_못하는_입력은_그대로_넘긴다() {
    // Host가 비어 주소를 만들지 못한다: Node가 500을 준다. 앞단은 판단하지 않고 넘긴다
    let (response, heads) = run(env(&[]), "GET /api/x HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n").await;
    assert_eq!((response.status(), heads.len()), (200, 1));
    // 주소에 사용자 정보가 든다
    let (_, heads) = run(env(&[]), "GET //u:p@h/api/x HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await;
    assert_eq!(heads.len(), 1);
    // 프록시 모드의 사용자 헤더 이름이 헤더 이름이 아니다
    let proxy = env(&[("B_STUDIO_AUTH", "proxy"), ("B_STUDIO_AUTH_PROXY_SECRET", &"S".repeat(32)), ("B_STUDIO_AUTH_USER_HEADER", "x user")]);
    let (_, heads) = run(proxy, "GET /api/x HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n").await;
    assert_eq!(heads.len(), 1);
}

#[tokio::test]
async fn token_모드는_무효화_기록을_읽어_막는다() {
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    let state = short_dir();
    let secret = "S".repeat(32);
    let sid = "0123456789abcdef0123456789abcdef";
    let payload = base64_url(format!("{{\"u\":\"alice\",\"sid\":\"{sid}\",\"iat\":{},\"exp\":{}}}", now_ms() - 1000, now_ms() + 3_600_000).as_bytes());
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    let cookie = format!("b_studio_session={payload}.{}", base64_url(&mac.finalize().into_bytes()));
    let config = |dir: &std::path::Path| {
        env(&[
            ("B_STUDIO_AUTH", "token"),
            ("B_STUDIO_AUTH_SECRET", &secret),
            ("B_STUDIO_AUTH_TOKENS", &format!("alice:{}", "a".repeat(24))),
            ("B_STUDIO_AUTH_STATE_DIR", dir.to_str().unwrap()),
        ])
    };
    let request = format!("GET /api/x HTTP/1.1\r\nHost: h\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n");

    // 기록이 없으면 허용
    let (response, heads) = run(config(state.path()), &request).await;
    assert_eq!((response.status(), heads.len()), (200, 1));
    // 로그아웃한 세션이면 거절하고 Node에 닿지 않는다
    std::fs::write(state.path().join("revocations.json"), format!("{{\"version\":1,\"sessions\":{{\"{sid}\":{}}},\"users\":{{}}}}", now_ms() + 100_000)).unwrap();
    let (response, heads) = run(config(state.path()), &request).await;
    assert_eq!(response.status(), 401);
    assert_eq!(String::from_utf8(response.body).unwrap(), "{\"error\":\"로그인이 필요합니다\"}");
    assert!(heads.is_empty());
    // 기록을 읽지 못하면 막는다(500)
    std::fs::write(state.path().join("revocations.json"), "{").unwrap();
    let (response, heads) = run(config(state.path()), &request).await;
    assert_eq!(response.status(), 500);
    assert!(String::from_utf8(response.body).unwrap().contains("JSON이 아닙니다"));
    assert!(heads.is_empty());
    // 상대 경로 폴더는 앞단이 읽지 않고 Node에 넘긴다(Node는 작업 폴더가 다르다)
    let (_, heads) = run(env(&[("B_STUDIO_AUTH", "token"), ("B_STUDIO_AUTH_SECRET", &secret), ("B_STUDIO_AUTH_TOKENS", &format!("alice:{}", "a".repeat(24))), ("B_STUDIO_AUTH_STATE_DIR", "rel/dir")]), &request).await;
    assert_eq!(heads.len(), 1);
}

#[tokio::test]
async fn 판단을_끄면_모두_넘긴다() {
    let dir = short_dir();
    let sock = dir.path().join("u.sock");
    let seen = Seen::default();
    spawn_upstream(&sock, seen.clone(), Reply::Raw(OK_EMPTY.to_vec())).await;
    let (port, _stop) = spawn_front_with(sock, AuthGate::disabled()).await;
    let response = raw_request(port, "GET /api/x HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n").await;
    assert_eq!((response.status(), seen.heads.lock().unwrap().len()), (200, 1));
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[tokio::test]
async fn 설정_오류의_500은_json_이스케이프를_지킨다() {
    let (response, heads) = run(env(&[("B_STUDIO_AUTH", "token"), ("B_STUDIO_AUTH_SECRET", &"S".repeat(32))]), "GET /api/x HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n").await;
    assert_eq!(response.status(), 500);
    assert_eq!(String::from_utf8(response.body).unwrap(), "{\"error\":\"B_STUDIO_AUTH=token이면 B_STUDIO_AUTH_TOKENS에 \\\"이름:토큰\\\"을 하나 이상 넣어야 합니다\"}");
    assert!(heads.is_empty());
}
