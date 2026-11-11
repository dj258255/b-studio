//! 앞단이 직접 답하는 경로(ADR-195 4d). 세션·프로젝트 같은 Node 메모리 상태를 읽지 않고, 요청·환경·디스크만으로 응답이 정해지는 경로만 둔다.
//!
//! 규칙: 인증 판단(`auth::decide`)이 `Allow`일 때만 부른다. 정확히 맞는 경로·메서드가 아니거나, 응답을 Node와 같게 만들 수 없는 입력이면
//! `None`을 돌려주어 Node로 넘긴다(Node가 판단하고 처리한다). 좁게 맞추면 Node가 처리하므로 안전하다.
pub mod ai_accounts;

use axum::body::Body;
use axum::http::header::{HeaderMap, CONTENT_LENGTH, CONTENT_TYPE, TRANSFER_ENCODING};
use axum::http::{HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;

use crate::auth::Env;

/// 앞단이 직접 답한다면 그 응답. None이면 Node로 넘긴다
pub fn try_direct(method: &Method, uri: &Uri, headers: &HeaderMap, env: &Env) -> Option<Response> {
    // 직접 처리하는 메서드는 GET뿐이다(HEAD·OPTIONS·405는 Node의 규칙대로 Node가 답한다)
    if method != Method::GET || has_body(headers) {
        return None;
    }
    // 경로는 원문이 정확히 맞을 때만(점 구간·%2e·역슬래시·겹친 슬래시·끝 슬래시는 Node가 정규화해 맞춘다). 쿼리는 이 경로가 읽지 않는다
    match uri.path() {
        "/api/ai-accounts" => ai_accounts::get(env),
        _ => None,
    }
}

/// 본문이 있을 수 있는 요청인가(Node는 GET 본문을 읽지 않는다. 그 경우의 연결 처리까지 같게 하려고 넘긴다)
fn has_body(headers: &HeaderMap) -> bool {
    headers.contains_key(TRANSFER_ENCODING) || headers.get_all(CONTENT_LENGTH).iter().any(|value| value.as_bytes() != b"0")
}

/// `Response.json(body, { status })`와 같은 응답: content-type은 `application/json`(charset 없음)
pub(crate) fn json_response(status: u16, body: String) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}
