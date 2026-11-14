//! 출처 제한의 판정(ADR-198·199). 요청 가로채기(첫 층)와 로컬 전달 프록시(둘째 층)가 **같은 함수**를 부른다.
//!
//! 호출부별로 막는 쪽인지 여는 쪽인지:
//!
//! | 함수 | 쓰임 | 방향 |
//! |---|---|---|
//! | [`is_allowed_url`] | 요청 가로채기, 프록시의 URL·터널 판정 | **여는 쪽**(허용 목록에 있으면 통과). 파싱할 수 없으면 거부한다 |
//! | [`tunnel_target`] | 막은 CONNECT와 같은 곳으로 가던 요청을 실패 기록에서 빼기 | 기록을 거르는 쪽. 모르면 `None`(거르지 않는다 = 실패로 남긴다) |
//! | [`parse_authority`] | 프록시의 CONNECT 대상 읽기 | 여는 쪽. 모르는 모양은 `None`(= 막는다) |
//! | [`is_tunnel_allowed`] | 프록시의 CONNECT 판정, 요청 가로채기가 https 홉을 터널 꼴로 적을지 | 여는 쪽(터널을 연다). 기록 쪽에서는 "프록시가 막았을 때만" 터널 꼴로 적어, 터널 억제가 허용 출처의 실패를 가리지 않게 한다 |
//!
//! URL 파싱은 WHATWG를 따르는 `url` 크레이트가 한 번만 하고, 판정과 접속이 그 결과를 함께 쓴다.

use bstudio_guard::connection_judge::is_allowed_request;
use url::{Host, Url};

/// 요청 URL이 허용 출처에 있는가(여는 쪽). 내부 스킴(data·blob·about)은 허용하고, 파싱할 수 없으면 거부한다
pub fn is_allowed_url(url: &str, allowed: &[String]) -> bool {
    let Ok(parsed) = Url::parse(url) else { return false };
    is_allowed_parsed(&parsed, allowed)
}

pub fn is_allowed_parsed(parsed: &Url, allowed: &[String]) -> bool {
    let protocol = format!("{}:", parsed.scheme());
    is_allowed_request(&protocol, &parsed.origin().ascii_serialization(), allowed)
}

/// CONNECT 터널을 열어도 되는가(여는 쪽). 터널은 https인지 웹소켓인지 알 수 없으므로, 같은 `host:port`의 http나 https가 허용일 때만 연다.
/// 프록시의 CONNECT 판정과, 요청 가로채기가 https 홉을 "프록시가 막았을 터널" 꼴로 적을지 정할 때 같은 함수를 쓴다.
/// `host_port`는 [`tunnel_target`]과 같은 꼴(IPv6는 대괄호)이다
pub fn is_tunnel_allowed(host_port: &str, is_allowed: impl Fn(&str) -> bool) -> bool {
    is_allowed(&format!("http://{host_port}/")) || is_allowed(&format!("https://{host_port}/"))
}

/// URL이 CONNECT로 가는 대상의 `host:port`. 스킴을 모르는 터널이라 기본 포트로 맞춘다(https·wss는 443, 그 밖은 80). 파싱하지 못하면 `None`.
/// 호스트는 WHATWG `hostname`과 같게 적는다(IPv6는 대괄호를 포함한다)
pub fn tunnel_target(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = host_text(&parsed)?;
    let port = parsed.port().unwrap_or(if matches!(parsed.scheme(), "https" | "wss") { 443 } else { 80 });
    Some(format!("{host}:{port}"))
}

/// WHATWG `hostname`(IPv6는 `[::1]`). 호스트가 없는 URL(`data:`)은 `None`
pub fn host_text(parsed: &Url) -> Option<String> {
    match parsed.host()? {
        Host::Domain(domain) => Some(domain.to_owned()),
        Host::Ipv4(address) => Some(address.to_string()),
        Host::Ipv6(address) => Some(format!("[{address}]")),
    }
}

/// 소켓 접속에 줄 호스트(대괄호 없는 주소)
pub fn socket_host(host: &str) -> &str {
    host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(host)
}

/// CONNECT 대상 `host:port`. 사용자 정보·경로·공백이 낄 수 없는 글자만 받고, 포트는 1~65535다. 읽은 결과는 `http://host:port/`의 파싱이다
/// (판정과 접속이 같은 파싱을 쓴다). 모르는 모양은 `None`이고 부르는 쪽은 막는다
pub fn parse_authority(authority: &str) -> Option<(Url, u16)> {
    let (host, port_text) = authority.rsplit_once(':')?;
    let host_ok = if host.starts_with('[') {
        host.len() > 2 && host.ends_with(']') && host[1..host.len() - 1].chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
    } else {
        !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    };
    if !host_ok || port_text.is_empty() || port_text.len() > 5 || !port_text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let port: u32 = port_text.parse().ok()?;
    if !(1..=65_535).contains(&port) {
        return None;
    }
    let parsed = Url::parse(&format!("http://{host}:{port}/")).ok()?;
    Some((parsed, port as u16))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn allows_only_listed_origins_and_internal_schemes() {
        let list = allowed(&["http://127.0.0.1:5173"]);
        assert!(is_allowed_url("http://127.0.0.1:5173/a?b=1#c", &list));
        assert!(!is_allowed_url("http://127.0.0.1:5174/", &list));
        assert!(!is_allowed_url("http://localhost:5173/", &list));
        assert!(!is_allowed_url("https://127.0.0.1:5173/", &list));
        assert!(!is_allowed_url("http://[::1]:5173/", &list));
        assert!(is_allowed_url("data:text/plain,x", &list));
        assert!(is_allowed_url("about:blank", &list));
        assert!(is_allowed_url("blob:http://evil.example/uuid", &list));
        // 파싱할 수 없으면 거부한다(닫힌 쪽)
        assert!(!is_allowed_url("", &list));
        assert!(!is_allowed_url("/relative", &list));
        assert!(!is_allowed_url("http://", &list));
    }

    #[test]
    fn default_ports_are_elided_in_the_origin_like_whatwg() {
        let list = allowed(&["http://example.test", "https://secure.test"]);
        assert!(is_allowed_url("http://example.test:80/x", &list));
        assert!(is_allowed_url("https://secure.test:443/x", &list));
        assert!(!is_allowed_url("http://example.test:8080/x", &list));
    }

    #[test]
    fn tunnel_targets_use_the_default_port_of_the_scheme() {
        assert_eq!(tunnel_target("https://127.0.0.1/x").as_deref(), Some("127.0.0.1:443"));
        assert_eq!(tunnel_target("wss://h.test/x").as_deref(), Some("h.test:443"));
        assert_eq!(tunnel_target("ws://h.test/x").as_deref(), Some("h.test:80"));
        assert_eq!(tunnel_target("http://h.test:81/x").as_deref(), Some("h.test:81"));
        assert_eq!(tunnel_target("http://[::1]:9/x").as_deref(), Some("[::1]:9"));
        assert_eq!(tunnel_target("not a url"), None);
        assert_eq!(tunnel_target("data:text/plain,x"), None);
    }

    #[test]
    fn tunnel_is_allowed_only_when_http_or_https_of_the_same_host_port_is() {
        let list = allowed(&["http://127.0.0.1:5173", "https://secure.test"]);
        let judge = |url: &str| is_allowed_url(url, &list);
        assert!(is_tunnel_allowed("127.0.0.1:5173", judge));
        assert!(is_tunnel_allowed("secure.test:443", judge));
        assert!(!is_tunnel_allowed("127.0.0.1:5174", judge));
        assert!(!is_tunnel_allowed("secure.test:444", judge));
        assert!(!is_tunnel_allowed("[::1]:5173", judge));
    }

    #[test]
    fn authority_accepts_only_plain_host_and_port() {
        let (url, port) = parse_authority("127.0.0.1:8080").unwrap();
        assert_eq!((url.host_str(), port), (Some("127.0.0.1"), 8080));
        assert!(parse_authority("[::1]:9").is_some());
        assert!(parse_authority("localhost:80").is_some());
        for bad in ["", "host", "host:", ":80", "host:0", "host:65536", "host:123456", "user@host:80", "host/path:80", "host :80", "a:b:80", "[::1:80", "[zz]:80", "[]:80", "host:8a", "ホスト:80"] {
            assert!(parse_authority(bad).is_none(), "{bad}");
        }
    }
}
