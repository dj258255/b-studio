//! 연결·인증 판정(ADR-191 3단계 3t). 옮기기 전 TS는 `packages/agent/src/`의 `mcp-http-server.ts`(authorize·hostAllowed·hostnameOf·
//! tokenMatches), `browser-check.ts`(isAllowedRequest·isAutomaticFavicon·describeStep), `change-tracker.ts`(rejectedChangeFeedback)였다.
//!
//! 호출부마다 막는 쪽인지 여는 쪽인지가 다르다.
//! - 여는 쪽(같다고 나오면 인증·허용이 열린다): `host_allowed`, `token_matches`, `authorize`, `is_allowed_request`, `is_automatic_favicon_path`.
//!   이 함수들의 문자열 입력은 짝 없는 서로게이트가 경계에서 U+FFFD가 되어 서로 다른 두 값이 같아지지 않게 TS가 `encodeLoneSurrogates`로 바꿔 보낸다
//! - 막는 쪽/글: `describe_step`·`rejected_change_feedback`는 사람이 읽는 글만 만든다
//!
//! 토큰 비교는 상수 시간이다: 길이가 달라도 일찍 끝내지 않고 두 값 중 긴 쪽의 길이만큼 모두 훑는다(옛 TS는 길이가 다르면 먼저 거부했다).
//! 입력은 JS 문자열이 아니라 Rust 문자열이라 UTF-8 바이트로 견준다(옛 TS도 `Buffer.from(…, 'utf8')`의 바이트로 견줬다).
//!
//! 의도한 차이:
//! - 빈 토큰은 어떤 요청도 맞지 않는다(옛 TS는 `Bearer `(빈 토큰)과 빈 토큰이 맞았다). 서버는 늘 무작위 토큰을 쓰므로 닿지 않던 자리를 닫는다
//! - 짝 없는 서로게이트가 든 글자(`describe_step`·`rejected_change_feedback`의 출력)는 U+FFFD가 된다
//! - 호스트 이름의 소문자 변환은 Rust `to_lowercase`다(Unicode 버전이 다르면 아주 드문 글자에서 JS와 다를 수 있다)

use crate::js;
use crate::js_json::{self, JsValue};

/// 루프백 이름. Host 헤더 위조(DNS 재바인딩)를 막으려고 이 이름만 받는다
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

/// 네트워크로 나가지 않는 내부 스킴. 허용 목록과 무관하게 통과시킨다
const INTERNAL_SCHEMES: [&str; 3] = ["data:", "blob:", "about:"];

/// Host 헤더에서 호스트 이름만 꺼낸다. `[::1]:1234` → `::1`, `127.0.0.1:1234` → `127.0.0.1`, `localhost` → `localhost`.
/// 대괄호가 있으면 그 안을 쓰고(닫는 대괄호가 없으면 빈 글자), 없으면 콜론이 하나일 때만 그 앞을 쓴다(둘 이상이면 포트 없는 IPv6)
pub fn hostname_of(host: Option<&str>) -> String {
    let value = js::trim(host.unwrap_or(""));
    if let Some(rest) = value.strip_prefix('[') {
        return match rest.find(']') {
            Some(end) => rest[..end].to_owned(),
            None => String::new(),
        };
    }
    match value.find(':') {
        None => value.to_owned(),
        Some(colon) if value[colon + 1..].contains(':') => value.to_owned(),
        Some(colon) => value[..colon].to_owned(),
    }
}

/// Host 헤더가 루프백 이름이거나 따로 허용한 이름인가(여는 쪽). 이름은 대소문자를 가리지 않는다
pub fn host_allowed(host: Option<&str>, allowed_hosts: &[String]) -> bool {
    let name = hostname_of(host).to_lowercase();
    LOOPBACK_HOSTS.contains(&name.as_str()) || allowed_hosts.iter().any(|allowed| allowed.to_lowercase() == name)
}

/// 두 바이트열이 같은가를 값의 위치와 무관한 시간으로 견준다. 길이 차이도 결과에 섞고, 짧은 쪽을 0으로 채워 긴 쪽 길이만큼 모두 훑는다.
/// `on_step`은 한 바이트를 견줄 때마다 불린다(시험이 훑은 횟수를 세는 자리. 실제 판정은 아무것도 하지 않는 클로저로 같은 코드를 쓴다)
pub fn constant_time_eq_with(a: &[u8], b: &[u8], mut on_step: impl FnMut()) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        on_step();
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= usize::from(x ^ y);
    }
    std::hint::black_box(diff) == 0
}

/// bearer 토큰이 맞는가(여는 쪽). `Bearer ` 접두는 대소문자를 구분하고, 접두 뒤 전부가 토큰이어야 한다. 빈 토큰은 맞지 않는다
pub fn token_matches(authorization: Option<&str>, token: &str) -> bool {
    let Some(provided) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
        return false;
    };
    // 비교는 항상 끝까지 한다. 빈 토큰은 마지막에 거부한다(비교 결과와 섞어 일찍 끝내지 않는다)
    let equal = constant_time_eq_with(provided.as_bytes(), token.as_bytes(), || {});
    equal & !token.is_empty()
}

/// 통과하면 `None`, 막으면 응답할 상태와 이유
pub fn authorize(host: Option<&str>, authorization: Option<&str>, token: &str, allowed_hosts: &[String]) -> Option<(u16, &'static str)> {
    if !host_allowed(host, allowed_hosts) {
        return Some((403, "MCP 서버는 루프백에서만 접근할 수 있습니다"));
    }
    if !token_matches(authorization, token) {
        return Some((401, "unauthorized"));
    }
    None
}

/// `{ status, message }` 객체
pub fn denial_value(denied: (u16, &str)) -> JsValue {
    js_json::object(vec![("status", Some(JsValue::Num(f64::from(denied.0)))), ("message", Some(JsValue::str(denied.1)))])
}

/// 요청 출처가 허용되는가(여는 쪽). URL 파싱은 호출하는 쪽의 `new URL`이 하고 `protocol`·`origin`만 받는다.
/// 내부 스킴은 허용 목록과 무관하게 통과시키고, 그 밖에는 출처가 허용 목록과 글자 그대로 같아야 한다
pub fn is_allowed_request(protocol: &str, origin: &str, allowed_origins: &[String]) -> bool {
    INTERNAL_SCHEMES.contains(&protocol) || allowed_origins.iter().any(|allowed| allowed == origin)
}

/// 브라우저가 알아서 요청하는 파비콘 경로인가(여는 쪽: 실패로 세지 않는다). `new URL(url).pathname`을 받는다
pub fn is_automatic_favicon_path(pathname: &str) -> bool {
    pathname == "/favicon.ico"
}

/// 실패한 단계를 사람이 알아볼 수 있게 무슨 동작을 어디에 하려 했는지 적는다. 값이 있는 첫 동작을 쓰고, 모두 없으면 `waitFor`로 적는다.
/// 인자는 `undefined`가 아닌 값의 글자(`String(값)`)이고 `undefined`는 `None`이다
pub fn describe_step(click: Option<&str>, fill_selector: Option<&str>, press: Option<&str>, wait_for: Option<&str>) -> String {
    if let Some(selector) = click {
        return format!("click {selector}");
    }
    if let Some(selector) = fill_selector {
        return format!("fill {selector}");
    }
    if let Some(key) = press {
        return format!("press {key}");
    }
    format!("waitFor {}", wait_for.unwrap_or("undefined"))
}

/// 게이트가 다룰 수 없는 경로가 바뀌었을 때 에이전트에게 돌려주는 글. 20개까지 적고 나머지는 개수로 알린다
pub fn rejected_change_feedback(rejected: &[String]) -> String {
    let mut lines = vec!["[b-studio 검증 게이트] 게이트가 검증할 수 없는 경로가 이번 실행에서 바뀌어 통과시키지 않았습니다.".to_owned()];
    lines.extend(rejected.iter().take(20).map(|file| format!("- {file}")));
    if rejected.len() > 20 {
        lines.push(format!("- 외 {}개", rejected.len() - 20));
    }
    lines.push("비밀 파일(.env 등)이나 생성물은 체크포인트에 넣지 않습니다. 필요 없는 파일이면 지우고, 생성물이면 .gitignore에 넣은 뒤 턴을 끝내세요.".to_owned());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn 호스트_이름은_포트와_대괄호를_걷어낸다() {
        assert_eq!(hostname_of(Some("127.0.0.1:1234")), "127.0.0.1");
        assert_eq!(hostname_of(Some("[::1]:1234")), "::1");
        assert_eq!(hostname_of(Some("::1")), "::1");
        assert_eq!(hostname_of(Some("[::1")), "");
        assert_eq!(hostname_of(Some("  localhost  ")), "localhost");
        assert_eq!(hostname_of(None), "");
    }

    #[test]
    fn 호스트는_루프백과_허용_이름만_받는다() {
        let allowed = hosts(&["Host.Docker.Internal"]);
        assert!(host_allowed(Some("LOCALHOST:80"), &[]));
        assert!(host_allowed(Some("host.docker.internal:3000"), &allowed));
        assert!(!host_allowed(Some("host.docker.internal:3000"), &[]));
        assert!(!host_allowed(Some("evil.localhost"), &[]));
        assert!(!host_allowed(Some("localhost.evil.com"), &[]));
        assert!(!host_allowed(Some("localhostx"), &[]));
        assert!(!host_allowed(None, &[]));
    }

    #[test]
    fn 토큰은_접두와_전체가_같아야_맞는다() {
        assert!(token_matches(Some("Bearer abc"), "abc"));
        assert!(!token_matches(Some("bearer abc"), "abc"));
        assert!(!token_matches(Some("Bearer abc "), "abc"));
        assert!(!token_matches(Some("Bearer ab"), "abc"));
        assert!(!token_matches(Some("Bearer abcd"), "abc"));
        assert!(!token_matches(Some("abc"), "abc"));
        assert!(!token_matches(None, "abc"));
        assert!(!token_matches(Some("Bearer "), ""));
    }

    /// 상수 시간: 어긋난 자리와 길이에 상관없이 긴 쪽 길이만큼 모두 훑는다
    #[test]
    fn 토큰_비교는_일찍_끝내지_않는다() {
        let token = b"0123456789abcdef";
        for provided in [&b"0123456789abcdef"[..], b"X123456789abcdef", b"0123456789abcdeX", b"", b"0", b"0123456789abcdef0123", b"zzzzzzzzzzzzzzzzzzzzzzzz"] {
            let mut steps = 0;
            constant_time_eq_with(provided, token, || steps += 1);
            assert_eq!(steps, provided.len().max(token.len()), "{provided:?}");
        }
        // 길이만 다르고 접두가 같은 경우도 거부
        assert!(!constant_time_eq_with(b"abc", b"abc\0", || {}));
        assert!(!constant_time_eq_with(b"abc\0", b"abc", || {}));
    }

    #[test]
    fn 인증은_호스트가_먼저다() {
        assert_eq!(authorize(Some("evil.com"), Some("Bearer t"), "t", &[]), Some((403, "MCP 서버는 루프백에서만 접근할 수 있습니다")));
        assert_eq!(authorize(Some("localhost"), Some("Bearer x"), "t", &[]), Some((401, "unauthorized")));
        assert_eq!(authorize(Some("localhost"), Some("Bearer t"), "t", &[]), None);
    }

    #[test]
    fn 요청_출처는_내부_스킴이거나_허용_목록과_같다() {
        let allowed = hosts(&["http://localhost:3000"]);
        assert!(is_allowed_request("data:", "null", &[]));
        assert!(is_allowed_request("http:", "http://localhost:3000", &allowed));
        assert!(!is_allowed_request("http:", "http://localhost:3001", &allowed));
        assert!(!is_allowed_request("http:", "HTTP://localhost:3000", &allowed));
        assert!(!is_allowed_request("file:", "null", &allowed));
        assert!(!is_allowed_request("DATA:", "null", &allowed));
    }

    #[test]
    fn 파비콘과_단계_설명() {
        assert!(is_automatic_favicon_path("/favicon.ico"));
        assert!(!is_automatic_favicon_path("/favicon.ico/"));
        assert!(!is_automatic_favicon_path("/Favicon.ico"));
        assert_eq!(describe_step(Some("#a"), None, None, None), "click #a");
        assert_eq!(describe_step(None, Some("#b"), None, None), "fill #b");
        assert_eq!(describe_step(None, None, Some("Enter"), None), "press Enter");
        assert_eq!(describe_step(None, None, None, Some(".c")), "waitFor .c");
        assert_eq!(describe_step(None, None, None, None), "waitFor undefined");
    }

    #[test]
    fn 거부된_경로_안내는_스무_개까지() {
        let many: Vec<String> = (0..23).map(|i| format!("f{i}")).collect();
        let text = rejected_change_feedback(&many);
        assert!(text.contains("- f19\n"));
        assert!(!text.contains("- f20"));
        assert!(text.contains("- 외 3개"));
        assert!(!rejected_change_feedback(&many[..20]).contains("외 "));
    }
}
