//! 인증 판단(ADR-195 4c). `apps/studio/lib/server/auth.ts`의 `decideRequest`와 그 상태(설정, 세션 쿠키 서명, 무효화 기록,
//! 같은 출처, 신뢰 Host)를 순수 Rust로 옮긴 판이다.
//!
//! **이 판단은 막는 검사다.** 앞단이 먼저 판단하고 거절만 직접 답한다. 통과한 요청은 하나도 바꾸지 않고 Node로 넘기며, Node가 같은 판단을
//! 다시 한다(Node의 판단은 지우지 않는다). 그래서 두 구현이 어긋나도 열리는 쪽으로는 틀리지 않고, 앞단이 더 막는 가용성 문제만 생긴다.
//!
//! **앞단이 판단하지 않고 Node에 넘기는 입력(`Decision::Defer`).** 앞단이 "통과"라고 말하는 것이 아니다. Node가 그대로 판단한다.
//! 그래서 열린 쪽 구멍이 아니다(Node가 막으면 막힌다). 아래 입력이 그렇다.
//! - Node가 인증 판단 전에 실패하는 입력(Host 없음, `new URL(...)`이 실패하는 Host·주소, 주소에 사용자 정보가 든 경우, TRACE·CONNECT, 모르는 메서드)
//! - 해석이 Node(Ada)와 다를 수 있는 꼴을 `url` 크레이트가 받지 못하는 경우
//! - 설정 오류 메시지에 짝 없는 서로게이트가 들어가는 경우(Rust 문자열로 담을 수 없다)
//! - 프록시 모드의 사용자 헤더 이름이 헤더 이름으로 쓸 수 없는 글자를 가진 경우(Node는 `Headers.get`이 던져 500을 준다)
//! - 서명이 맞는 쿠키의 내용을 풀지 못하는 경우(서명 키를 아는 쪽만 만들 수 있다)
//! - 상대 경로인 `B_STUDIO_AUTH_STATE_DIR`(Node는 시작할 때 작업 폴더를 `apps/studio`로 바꾸므로 앞단과 기준이 다르다)
//!
//! 글자 규칙은 JS와 같게 한다: `trim`(U+FEFF는 떼고 U+0085는 안 뗀다), 길이는 UTF-16 단위, `Number(문자열)`의 문법, 헤더 값은 Latin-1로 읽는다
//! (Node가 헤더 바이트를 Latin-1 문자열로 읽는다).
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use url::Url;

pub const SESSION_COOKIE: &str = "b_studio_session";
pub const PROXY_SECRET_HEADER: &str = "x-b-studio-proxy-secret";
pub const LOCAL_USER: &str = "local";
const REVOCATIONS_FILE: &str = "revocations.json";

/// 인증 판단이 읽는 환경 변수. 앞단이 시작할 때 한 번 읽는다(Node 자식은 같은 환경을 물려받는다)
const ENV_KEYS: [&str; 10] = [
    "B_STUDIO_AUTH",
    "B_STUDIO_AUTH_USER_HEADER",
    "B_STUDIO_AUTH_ADMINS",
    "B_STUDIO_AUTH_SESSION_HOURS",
    "B_STUDIO_AUTH_SECRET",
    "B_STUDIO_AUTH_TOKENS",
    "B_STUDIO_AUTH_PROXY_SECRET",
    "B_STUDIO_ALLOWED_HOSTS",
    "B_STUDIO_AUTH_STATE_DIR",
    "HOME",
];

/// 환경 변수 모음. 시험이 필요한 값만 넣을 수 있다
#[derive(Debug, Clone, Default)]
pub struct Env {
    vars: HashMap<String, String>,
}

impl Env {
    /// 이 프로세스의 환경에서 인증 판단이 읽는 값만 가져온다(UTF-8이 아니면 Node처럼 U+FFFD로 바꾼다)
    pub fn from_process() -> Self {
        let mut vars = HashMap::new();
        for key in ENV_KEYS {
            if let Some(value) = std::env::var_os(key) {
                vars.insert(key.to_string(), value.to_string_lossy().into_owned());
            }
        }
        Env { vars }
    }

    pub fn from_pairs<K: Into<String>, V: Into<String>>(pairs: impl IntoIterator<Item = (K, V)>) -> Self {
        Env { vars: pairs.into_iter().map(|(k, v)| (k.into(), v.into())).collect() }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.vars.get(key).map(String::as_str)
    }
}

/// 판단할 요청. Node의 `req.method`·`req.url`·`req.headers`가 되기 전의 날것이다
#[derive(Debug, Clone)]
pub struct RequestView {
    /// 메서드(대소문자는 여기서 바로잡는다)
    pub method: String,
    /// Node가 `req.url`로 보는 값: 요청 줄의 요청 대상 원문
    pub target: String,
    /// 받은 순서대로의 (소문자 이름, 값). 값은 바이트를 Latin-1로 읽은 문자열이다. 같은 이름이 여러 번 올 수 있다
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// 로그인 없이 여는 경로. 그대로 Node로 넘긴다
    Pass,
    /// 사용자를 확인했다. 그대로 Node로 넘긴다(사용자 헤더는 Node가 넣는다)
    Allow { user: String },
    /// 앞단이 직접 거절한다. `api`는 경로가 `/api/`로 시작하는지(JSON 본문 여부)
    Reject { status: u16, message: String, api: bool },
    /// 앞단이 판단하지 않는다. 그대로 Node로 넘기고 Node가 판단한다(모듈 머리말의 목록)
    Defer(&'static str),
}

/// 무효화 기록(`auth-state.ts`의 `Revocations`)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Revocations {
    pub sessions: HashMap<String, f64>,
    pub users: HashMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LoadError {
    /// 읽지 못했다. 인증을 건너뛰지 않고 막는다(500)
    Failed(String),
    /// 앞단이 읽을 수 없는 자리다. Node가 판단한다
    Defer(&'static str),
}

// ───────────────────────── JS와 같은 글자 규칙 ─────────────────────────

/// JS `String.prototype.trim`의 공백: Rust의 White_Space에서 U+0085를 빼고 U+FEFF를 더한 것
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Headers`가 값 앞뒤에서 떼는 HTTP 공백(탭·줄바꿈·CR·스페이스). NBSP는 떼지 않는다
fn trim_http_space(s: &str) -> &str {
    s.trim_matches(['\t', '\n', '\r', ' '])
}

/// JS `.length`(UTF-16 단위)
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `Number(문자열)`. NaN이면 None
pub fn js_number(s: &str) -> Option<f64> {
    let t = js_trim(s);
    if t.is_empty() {
        return Some(0.0);
    }
    let bytes = t.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            let mut value = 0f64;
            for c in t[2..].chars() {
                value = value * f64::from(radix) + f64::from(c.to_digit(radix)?);
            }
            return Some(value);
        }
    }
    let (negative, rest) = match t.as_bytes()[0] {
        b'+' => (false, &t[1..]),
        b'-' => (true, &t[1..]),
        _ => (false, t),
    };
    let magnitude = if rest == "Infinity" { f64::INFINITY } else if is_decimal_literal(rest) { rest.parse::<f64>().ok()? } else { return None };
    Some(if negative { -magnitude } else { magnitude })
}

/// StrUnsignedDecimalLiteral: `숫자+ [. 숫자*]` 또는 `. 숫자+`, 뒤에 `e[+-]숫자+`
fn is_decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == b.len()
}

/// JS `slice(0, n)`(UTF-16 단위). 자르는 자리가 짝 있는 서로게이트 사이면 Rust 문자열로 담을 수 없어 None
fn utf16_prefix(s: &str, units: usize) -> Option<String> {
    let mut used = 0;
    let mut end = 0;
    for c in s.chars() {
        let width = c.len_utf16();
        if used + width > units {
            return if used == units { Some(s[..end].to_string()) } else { None };
        }
        used += width;
        end += c.len_utf8();
    }
    Some(s.to_string())
}

/// JS `slice(0, -1)`. 마지막이 서로게이트 쌍이면 None
fn drop_last_unit(s: &str) -> Option<String> {
    match s.chars().next_back() {
        None => Some(String::new()),
        Some(c) if c.len_utf16() == 2 => None,
        Some(c) => Some(s[..s.len() - c.len_utf8()].to_string()),
    }
}

/// JS `JSON.stringify(문자열)`: 따옴표·역슬래시·제어 문자만 이스케이프한다(비ASCII는 그대로)
pub fn js_json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 헤더 바이트를 Node처럼 Latin-1 문자열로 읽는다
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn mac(payload: &str, secret: &str) -> String {
    let mut hmac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC은 어떤 길이의 키도 받는다");
    hmac.update(payload.as_bytes());
    URL_SAFE_NO_PAD.encode(hmac.finalize().into_bytes())
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

// ───────────────────────── 설정 ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    None,
    Token,
    Proxy,
}

struct Config {
    mode: Mode,
    secret: String,
    /// 접근 토큰 목록의 사용자 이름(판단에 쓰는 것은 이름뿐이다)
    token_users: HashSet<String>,
    user_header: String,
    proxy_secret: String,
}

enum ConfigError {
    Message(String),
    /// 메시지에 짝 없는 서로게이트가 들어가 Rust 문자열로 담을 수 없다
    Unrepresentable,
}

fn config_error(message: impl Into<String>) -> ConfigError {
    ConfigError::Message(message.into())
}

/// `authConfig(env)`. 설정이 틀리면 인증이 조용히 꺼지지 않도록 오류를 돌려준다
fn auth_config(env: &Env) -> Result<Config, ConfigError> {
    let mode_text = env.get("B_STUDIO_AUTH").map(js_trim).filter(|m| !m.is_empty()).unwrap_or("none");
    let mode = match mode_text {
        "none" => Mode::None,
        "token" => Mode::Token,
        "proxy" => Mode::Proxy,
        other => return Err(config_error(format!("B_STUDIO_AUTH는 none, token, proxy 중 하나여야 합니다 (지금 값: {other})"))),
    };
    let user_header = env.get("B_STUDIO_AUTH_USER_HEADER").map(|v| js_trim(v).to_lowercase()).filter(|v| !v.is_empty()).unwrap_or_else(|| "x-forwarded-user".to_string());
    // sessionHours는 쓰지 않지만 값이 틀리면 Node가 던지므로 같은 자리에서 확인한다
    check_hours(env.get("B_STUDIO_AUTH_SESSION_HOURS"))?;

    let mut config = Config { mode, secret: String::new(), token_users: HashSet::new(), user_header, proxy_secret: String::new() };
    if mode == Mode::Token {
        config.secret = env.get("B_STUDIO_AUTH_SECRET").unwrap_or("").to_string();
        if js_len(&config.secret) < 32 {
            return Err(config_error("B_STUDIO_AUTH=token이면 B_STUDIO_AUTH_SECRET에 32자 이상의 임의 값을 넣어야 합니다"));
        }
        config.token_users = parse_tokens(env.get("B_STUDIO_AUTH_TOKENS"))?;
    }
    if mode == Mode::Proxy {
        config.proxy_secret = env.get("B_STUDIO_AUTH_PROXY_SECRET").unwrap_or("").to_string();
        if js_len(&config.proxy_secret) < 32 {
            return Err(config_error("B_STUDIO_AUTH=proxy면 B_STUDIO_AUTH_PROXY_SECRET에 32자 이상의 임의 값을 넣고, SSO 프록시가 같은 값을 x-b-studio-proxy-secret 헤더로 보내게 해야 합니다"));
        }
    }
    Ok(config)
}

fn check_hours(value: Option<&str>) -> Result<(), ConfigError> {
    let Some(value) = value else { return Ok(()) };
    if js_trim(value).is_empty() {
        return Ok(());
    }
    match js_number(value) {
        Some(hours) if hours.is_finite() && hours > 0.0 && hours <= 720.0 => Ok(()),
        _ => Err(config_error(format!("B_STUDIO_AUTH_SESSION_HOURS는 0보다 크고 720 이하인 숫자여야 합니다 (지금 값: {value})"))),
    }
}

fn split_list(value: Option<&str>) -> Vec<&str> {
    value.unwrap_or("").split(',').map(js_trim).filter(|item| !item.is_empty()).collect()
}

fn user_name_ok(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'@' | b'-'))
}

/// `sha256:<64자리 소문자 16진수>`이면 그 16진수
fn token_hash(secret: &str) -> Option<&str> {
    let hex = secret.strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then_some(hex)
}

/// `"alice:토큰,bob:sha256:<64자리 16진수>"`. 오류 메시지는 TS와 같다
fn parse_tokens(value: Option<&str>) -> Result<HashSet<String>, ConfigError> {
    let mut users: HashSet<String> = HashSet::new();
    let mut digests: HashSet<String> = HashSet::new();
    for entry in split_list(value) {
        let colon = entry.find(':');
        // 콜론이 없으면 TS는 slice(0, -1)을 이름으로, entry 전체를 토큰으로 본다
        let (name, secret) = match colon {
            Some(at) => (entry[..at].to_string(), &entry[at + 1..]),
            None => (drop_last_unit(entry).ok_or(ConfigError::Unrepresentable)?, entry),
        };
        if colon.is_none_or(|at| at == 0) || !user_name_ok(&name) {
            let shown = if name.is_empty() { utf16_prefix(entry, 16).ok_or(ConfigError::Unrepresentable)? } else { name };
            return Err(config_error(format!("B_STUDIO_AUTH_TOKENS의 \"{shown}\"는 \"이름:토큰\" 형식이 아니거나 이름에 쓸 수 없는 글자가 있습니다")));
        }
        let hashed = token_hash(secret);
        if hashed.is_none() && js_len(secret) < 24 {
            return Err(config_error(format!("B_STUDIO_AUTH_TOKENS에서 {name}의 토큰은 24자 이상이거나 \"sha256:<64자리 16진수>\" 해시여야 합니다")));
        }
        if users.contains(&name) {
            return Err(config_error(format!("B_STUDIO_AUTH_TOKENS에 {name}이 두 번 있습니다")));
        }
        // 평문과 해시가 섞여 있어도 같은 토큰을 두 사람이 쓰는지 해시로 비교한다
        let digest = hashed.map(str::to_string).unwrap_or_else(|| hash_token(secret));
        if !digests.insert(digest) {
            return Err(config_error("B_STUDIO_AUTH_TOKENS에 같은 토큰을 쓰는 사용자가 있습니다"));
        }
        users.insert(name);
    }
    if users.is_empty() {
        return Err(config_error("B_STUDIO_AUTH=token이면 B_STUDIO_AUTH_TOKENS에 \"이름:토큰\"을 하나 이상 넣어야 합니다"));
    }
    Ok(users)
}

// ───────────────────────── 헤더 ─────────────────────────

/// Node의 `IncomingMessage`가 같은 이름이 여러 번 올 때 앞의 것만 남기는 헤더(`_http_incoming.js`의 `matchKnownFields`)
const FIRST_WINS: [&str; 18] = [
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

/// Node가 합친 뒤 Web `Headers.get`이 돌려주는 값. 없으면 None. 같은 이름이 여럿이면 Node의 규칙으로 합친다:
/// 위 목록은 첫 값만, `cookie`는 "; "로, 나머지(`set-cookie` 포함)는 ", "로 이은 뒤 `Headers`가 앞뒤 HTTP 공백을 뗀다
fn header_value(headers: &[(String, String)], name: &str) -> Option<String> {
    let mut values = headers.iter().filter(|(n, _)| n == name).map(|(_, v)| v.as_str());
    let first = values.next()?;
    let joined = if FIRST_WINS.contains(&name) {
        first.to_string()
    } else {
        let separator = if name == "cookie" { "; " } else { ", " };
        values.fold(first.to_string(), |acc, v| format!("{acc}{separator}{v}"))
    };
    Some(trim_http_space(&joined).to_string())
}

/// `Headers.get`이 받는 이름(HTTP token)인가. 아니면 던진다
fn is_header_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// `cookieValue`: Cookie 헤더에서 이름 하나의 값
fn cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    for part in cookie_header.split(';') {
        let Some(eq) = part.find('=') else { continue };
        if js_trim(&part[..eq]) == name {
            return Some(js_trim(&part[eq + 1..]));
        }
    }
    None
}

// ───────────────────────── 주소 ─────────────────────────

/// Node가 `new URL(req.url ?? '/', 'http://' + host)`로 만드는 경로. 계산하지 못하면 이유(Node가 판단하게 넘긴다)
fn request_pathname(target: &str, host: &str) -> Result<String, &'static str> {
    let base = Url::parse(&format!("http://{host}")).map_err(|_| "Host로 주소를 만들지 못함(Node가 500)")?;
    // 앞의 슬래시·역슬래시가 셋 이상이면 WHATWG는 둘 다 같은 "권한 부분의 슬래시 무시" 상태로 건너뛴다(`///x`는 `//x`와 같다).
    // `url` 크레이트는 이 상태를 거절하므로 같은 뜻의 `//`로 줄여 준다
    let leading = target.bytes().take_while(|b| *b == b'/' || *b == b'\\').count();
    let collapsed;
    let target = if leading >= 3 {
        collapsed = format!("//{}", &target[leading..]);
        collapsed.as_str()
    } else {
        target
    };
    let url = base.join(target).map_err(|_| "요청 주소를 해석하지 못함(Node가 500)")?;
    // `new Request(url)`은 사용자 정보가 든 주소를 던진다(Node가 500)
    if !url.username().is_empty() || url.password().is_some() {
        return Err("주소에 사용자 정보가 있음(Node가 500)");
    }
    Ok(url.path().to_string())
}

/// `new URL(origin).host`: 호스트와 기본 포트가 아닌 포트
fn url_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// `isSameOrigin`: Origin이 없는 요청(curl, CLI)은 통과한다
fn is_same_origin(headers: &[(String, String)]) -> bool {
    let origin = match header_value(headers, "origin") {
        None => return true,
        Some(origin) if origin.is_empty() => return true,
        Some(origin) => origin,
    };
    let host = header_value(headers, "x-forwarded-host").or_else(|| header_value(headers, "host"));
    match (Url::parse(&origin), host) {
        (Ok(url), Some(host)) => url_host(&url) == host,
        _ => false,
    }
}

/// `requestHostName`: Host에서 포트를 뗀 이름(소문자). IPv6는 대괄호째로 둔다
fn request_host_name(headers: &[(String, String)]) -> String {
    let host = js_trim(&header_value(headers, "host").unwrap_or_default()).to_lowercase();
    if host.starts_with('[') {
        return match host.find(']') {
            Some(close) => host[..=close].to_string(),
            None => String::new(),
        };
    }
    match host.rfind(':') {
        Some(colon) if colon + 1 < host.len() && host[colon + 1..].bytes().all(|b| b.is_ascii_digit()) => host[..colon].to_string(),
        _ => host,
    }
}

/// 인증이 없는 모드에서 받을 요청인가: 이 컴퓨터의 주소로 왔거나, `B_STUDIO_ALLOWED_HOSTS`에 적은 이름으로 왔다
fn is_trusted_host(headers: &[(String, String)], env: &Env) -> bool {
    let name = request_host_name(headers);
    if name == "127.0.0.1" || name == "localhost" || name == "[::1]" {
        return true;
    }
    split_list(env.get("B_STUDIO_ALLOWED_HOSTS")).into_iter().any(|allowed| allowed.to_lowercase() == name)
}

/// 로그인 없이 여는 경로
fn is_public_path(pathname: &str) -> bool {
    if matches!(pathname, "/api/auth/login" | "/api/auth/logout" | "/api/health" | "/api/health/routes") {
        return true;
    }
    // 작업 계획 게시판의 MCP 경로: /^\/api\/task-plans\/[^/]+\/board\/mcp$/
    pathname.strip_prefix("/api/task-plans/").and_then(|rest| rest.strip_suffix("/board/mcp")).is_some_and(|plan| !plan.is_empty() && !plan.contains('/'))
}

/// Node의 `http.METHODS`에서 CONNECT·TRACE(`new Request`가 던진다)를 뺀 것. 나머지는 llhttp가 400으로 거절해 판단까지 오지 않는다
const METHODS: [&str; 32] = [
    "ACL", "BIND", "CHECKOUT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT",
    "SEARCH", "SOURCE", "SUBSCRIBE", "UNBIND", "UNLINK", "UNLOCK",
];

// ───────────────────────── 세션 쿠키 ─────────────────────────

/// `readSigned` + `sessionClaims`: 서명·형식·만료·토큰 목록·무효화를 확인한 쿠키의 사용자. 풀지 못하면 Err(이유)
fn session_user(cookie: Option<&str>, config: &Config, now_ms: f64, revocations: &Revocations) -> Result<Option<String>, &'static str> {
    let Some(value) = cookie.filter(|v| !v.is_empty()) else { return Ok(None) };
    let mut parts = value.split('.');
    let (payload, signature, extra) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next());
    if payload.is_empty() || signature.is_empty() || extra.is_some() || !constant_time_eq(signature, &mac(payload, &config.secret)) {
        return Ok(None);
    }
    // 여기부터는 서명이 맞는 값이다(서명 키를 아는 쪽만 만든다). 풀지 못하면 Node가 판단한다
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| "서명이 맞는 쿠키의 base64를 풀지 못함")?;
    let data: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|_| "서명이 맞는 쿠키의 JSON을 풀지 못함")?;
    let Some(object) = data.as_object() else { return Ok(None) };
    let number = |key: &str| object.get(key).filter(|v| v.is_number()).and_then(|v| v.as_f64());
    let (Some(user), Some(sid), Some(iat), Some(exp)) = (object.get("u").and_then(|v| v.as_str()), object.get("sid").and_then(|v| v.as_str()), number("iat"), number("exp")) else {
        return Ok(None);
    };
    if sid.len() != 32 || !sid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Ok(None);
    }
    if exp <= now_ms || !config.token_users.contains(user) || is_revoked(user, sid, iat, revocations) {
        return Ok(None);
    }
    Ok(Some(user.to_string()))
}

/// 로그아웃한 세션이거나, 운영자가 무효화한 시각 이전에 발급한 쿠키인지
fn is_revoked(user: &str, sid: &str, issued_at: f64, revocations: &Revocations) -> bool {
    if revocations.sessions.contains_key(sid) {
        return true;
    }
    revocations.users.get(user).is_some_and(|not_before| issued_at <= *not_before)
}

// ───────────────────────── 판단 ─────────────────────────

fn reject(status: u16, message: impl Into<String>, api: bool) -> Decision {
    Decision::Reject { status, message: message.into(), api }
}

/// `decideRequest`. 순서와 메시지는 TS와 같다:
/// 설정 오류(500) → 다른 출처(403) → 공개 경로 통과 → 신뢰하지 않는 Host(403) → 무효화 기록(500) → 사용자 확인(401)
pub fn decide(request: &RequestView, env: &Env, now_ms: f64, load_revocations: &mut dyn FnMut() -> Result<Revocations, LoadError>) -> Decision {
    // Node는 인증 판단 전에 요청 주소와 메서드를 만든다. 거기서 실패하는 입력은 Node가 500·400을 주므로 넘긴다
    let method = request.method.to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Decision::Defer("Node가 판단 전에 거절하거나 던지는 메서드");
    }
    let Some(host) = header_value(&request.headers, "host") else { return Decision::Defer("Host 없음(Node가 400)") };
    let pathname = match request_pathname(&request.target, &host) {
        Ok(pathname) => pathname,
        Err(reason) => return Decision::Defer(reason),
    };

    let config = match auth_config(env) {
        Ok(config) => config,
        Err(ConfigError::Message(message)) => return reject(500, message, pathname.starts_with("/api/")),
        Err(ConfigError::Unrepresentable) => return Decision::Defer("설정 오류 메시지에 짝 없는 서로게이트가 들어감"),
    };

    let api = pathname.starts_with("/api/");
    if api && method != "GET" && method != "HEAD" && !is_same_origin(&request.headers) {
        return reject(403, "다른 출처에서 보낸 요청은 받지 않습니다", api);
    }

    if is_public_path(&pathname) {
        return Decision::Pass;
    }

    // 인증이 없는 모드에는 요청을 보낸 쪽을 가릴 수단이 Host뿐이다(DNS 리바인딩). 이 컴퓨터의 주소와 따로 허용한 이름만 받는다
    if config.mode == Mode::None && !is_trusted_host(&request.headers, env) {
        return reject(
            403,
            "인증 없이 띄운 스튜디오는 이 컴퓨터의 주소(127.0.0.1 · localhost)로 온 요청만 받습니다. 다른 이름으로 쓰려면 B_STUDIO_ALLOWED_HOSTS에 그 이름을 적거나 인증을 켜세요",
            api,
        );
    }

    let mut revocations = Revocations::default();
    if config.mode == Mode::Token {
        match load_revocations() {
            Ok(loaded) => revocations = loaded,
            Err(LoadError::Failed(message)) => return reject(500, message, api),
            Err(LoadError::Defer(reason)) => return Decision::Defer(reason),
        }
    }

    let user = match config.mode {
        Mode::None => Some(LOCAL_USER.to_string()),
        Mode::Token => {
            let cookie = header_value(&request.headers, "cookie");
            let cookie = cookie.as_deref().and_then(|header| cookie_value(header, SESSION_COOKIE));
            match session_user(cookie, &config, now_ms, &revocations) {
                Ok(user) => user,
                Err(reason) => return Decision::Defer(reason),
            }
        }
        Mode::Proxy => {
            // Node는 두 헤더를 먼저 읽고 `Headers.get`이 이름을 검사하며 던진다(500)
            if !is_header_name(&config.user_header) {
                return Decision::Defer("프록시 사용자 헤더 이름이 헤더 이름이 아님(Node가 500)");
            }
            let given = header_value(&request.headers, PROXY_SECRET_HEADER);
            let user = header_value(&request.headers, &config.user_header).map(|v| js_trim(&v).to_string());
            match (given, user) {
                (Some(given), Some(user)) if !given.is_empty() && constant_time_eq(&given, &config.proxy_secret) && (1..=256).contains(&user.len()) && user.bytes().all(|b| (0x21..=0x7E).contains(&b)) => Some(user),
                _ => None,
            }
        }
    };
    if let Some(user) = user {
        return Decision::Allow { user };
    }
    // 화면은 없다(ADR-186). 토큰 모드는 /api/auth/login으로 쿠키를 받은 손님만 쓴다
    if api || config.mode == Mode::Token {
        return reject(401, "로그인이 필요합니다", api);
    }
    reject(401, "사내 SSO 프록시를 거쳐 접속하세요", api)
}

// ───────────────────────── 무효화 기록 ─────────────────────────

/// POSIX `path.resolve(input)`: 상대 경로는 `cwd` 기준, `.`·`..`·겹친 `/`를 정리한다
pub fn path_resolve(input: &str, cwd: &str) -> String {
    let joined = if input.starts_with('/') { input.to_string() } else { format!("{cwd}/{input}") };
    let mut stack: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    format!("/{}", stack.join("/"))
}

fn home_dir(env: &Env) -> Option<String> {
    // libuv의 uv_os_homedir: HOME이 있으면(빈 값이어도) 그것, 없으면 passwd
    if let Some(home) = env.get("HOME") {
        return Some(home.to_string());
    }
    unsafe {
        let mut passwd: libc::passwd = std::mem::zeroed();
        let mut buffer = vec![0u8; 4096];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        if libc::getpwuid_r(libc::getuid(), &mut passwd, buffer.as_mut_ptr().cast(), buffer.len(), &mut result) != 0 || result.is_null() || passwd.pw_dir.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(passwd.pw_dir).to_string_lossy().into_owned())
    }
}

/// `authStateDir()`: `B_STUDIO_AUTH_STATE_DIR` 또는 `$HOME/.cache/b-studio/auth`. 상대 경로면 Node와 기준이 달라 넘긴다
/// (Node는 시작할 때 작업 폴더를 `apps/studio`로 바꾼다)
pub fn state_dir(env: &Env) -> Result<PathBuf, LoadError> {
    let raw = match env.get("B_STUDIO_AUTH_STATE_DIR") {
        Some(dir) => dir.to_string(),
        None => {
            let home = home_dir(env).ok_or_else(|| LoadError::Failed("무효화 기록 폴더를 정할 수 없습니다: 홈 폴더를 알 수 없습니다".to_string()))?;
            format!("{home}/.cache/b-studio/auth")
        }
    };
    if !raw.starts_with('/') {
        return Err(LoadError::Defer("무효화 기록 폴더가 상대 경로(Node는 작업 폴더가 다르다)"));
    }
    Ok(PathBuf::from(path_resolve(&raw, "/")))
}

/// 무효화 기록을 읽는 함수(`decide`의 `load_revocations`). 환경에서 폴더를 정한다
pub fn file_loader(env: &Env) -> impl FnMut() -> Result<Revocations, LoadError> + '_ {
    move || read_revocations(&state_dir(env)?)
}

/// `readRevocations(dir)`. 파일이 없으면(ENOENT) 무효화한 것이 없다. 읽을 수 없으면 막는다.
/// 의도한 차이: 파일 읽기 오류 글의 뒷부분은 Node의 fs 오류 글이 아니라 Rust 오류 글이고, 본문을 읽다 실패한 경우에도 같은 앞머리를 붙인다
pub fn read_revocations(dir: &Path) -> Result<Revocations, LoadError> {
    let file = dir.join(REVOCATIONS_FILE);
    let shown = file.display().to_string();
    let failed = |error: &dyn std::fmt::Display| LoadError::Failed(format!("{shown}을(를) 읽지 못했습니다: {error}"));
    match std::fs::metadata(&file) {
        Ok(_) => {}
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(Revocations::default()),
        Err(error) => return Err(failed(&error)),
    }
    let bytes = std::fs::read(&file).map_err(|error| failed(&error))?;
    parse_revocations(&String::from_utf8_lossy(&bytes), &shown)
}

/// `parseRevocations`. 오류 메시지는 TS와 같다. 같은 키가 둘이면 뒤의 값이다(JS와 같다)
pub fn parse_revocations(text: &str, file: &str) -> Result<Revocations, LoadError> {
    let data: serde_json::Value = serde_json::from_str(text).map_err(|_| LoadError::Failed(format!("{file}을(를) 읽지 못했습니다: JSON이 아닙니다")))?;
    let record = |key: &str| -> Option<HashMap<String, f64>> {
        let map = data.as_object()?.get(key)?.as_object()?;
        map.iter().map(|(name, value)| Some((name.clone(), if value.is_number() { value.as_f64()? } else { return None }))).collect()
    };
    match (record("sessions"), record("users")) {
        (Some(sessions), Some(users)) => Ok(Revocations { sessions, users }),
        _ => Err(LoadError::Failed(format!("{file}을(를) 읽지 못했습니다: sessions와 users가 숫자 값을 가진 객체여야 합니다"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim은_feff를_떼고_0085는_떼지_않는다() {
        assert_eq!(js_trim("\u{FEFF} a \u{A0}"), "a");
        assert_eq!(js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        assert_eq!(js_trim("\u{2028}a\u{3000}"), "a");
        assert_eq!(js_trim("\u{200B}a"), "\u{200B}a");
    }

    #[test]
    fn js_number는_js의_문법이다() {
        for (text, expected) in [
            ("12", Some(12.0)),
            (" 0x10 ", Some(16.0)),
            ("0b11", Some(3.0)),
            ("0o17", Some(15.0)),
            ("1e2", Some(100.0)),
            (".5", Some(0.5)),
            ("5.", Some(5.0)),
            ("+5", Some(5.0)),
            ("-0", Some(-0.0)),
            ("Infinity", Some(f64::INFINITY)),
            ("-Infinity", Some(f64::NEG_INFINITY)),
            ("0x", None),
            ("-0x10", None),
            ("1_0", None),
            ("1e", None),
            ("e5", None),
            (".", None),
            ("infinity", None),
            ("12px", None),
            ("1 2", None),
            ("", Some(0.0)),
            ("\u{FEFF}7\u{A0}", Some(7.0)),
        ] {
            assert_eq!(js_number(text), expected, "{text:?}");
        }
    }

    #[test]
    fn path_resolve는_node와_같다() {
        assert_eq!(path_resolve("/a//b/./c/../d/", "/cwd"), "/a/b/d");
        assert_eq!(path_resolve("../x", "/a/b"), "/a/x");
        assert_eq!(path_resolve("", "/a/b"), "/a/b");
        assert_eq!(path_resolve("/..", "/a"), "/");
        assert_eq!(path_resolve("/../../x", "/a"), "/x");
    }

    #[test]
    fn 짝_없는_서로게이트가_될_자름은_담지_않는다() {
        assert_eq!(utf16_prefix("가나😀", 2), Some("가나".to_string()));
        assert_eq!(utf16_prefix("가나😀", 3), None);
        assert_eq!(utf16_prefix("가나😀", 4), Some("가나😀".to_string()));
        assert_eq!(utf16_prefix("가😀", 2), None);
        assert_eq!(utf16_prefix("abc", 16), Some("abc".to_string()));
        assert_eq!(drop_last_unit("ab😀"), None);
        assert_eq!(drop_last_unit("ab가"), Some("ab".to_string()));
        assert_eq!(drop_last_unit(""), Some(String::new()));
    }

    #[test]
    fn json_문자열은_js_stringify와_같다() {
        assert_eq!(js_json_string("a\"b\\c\n\u{1}\u{7f}가\u{2028}"), "\"a\\\"b\\\\c\\n\\u0001\u{7f}가\u{2028}\"");
    }

    #[test]
    fn 요청_경로는_whatwg로_정리한다() {
        assert_eq!(request_pathname("/a/../b/./c", "h").unwrap(), "/b/c");
        assert_eq!(request_pathname("/a/%2e%2E/b", "h").unwrap(), "/b");
        assert_eq!(request_pathname("/a\\..\\api/x", "h").unwrap(), "/api/x");
        assert_eq!(request_pathname("//other/api/x", "h").unwrap(), "/api/x");
        assert_eq!(request_pathname("///other/api/x", "h").unwrap(), "/api/x");
        assert_eq!(request_pathname("/\\/\\other\\api/x", "h").unwrap(), "/api/x");
        assert!(request_pathname("/x", "").is_err());
        assert!(request_pathname("/x", "a b").is_err());
        assert!(request_pathname("/x", "u:p@h").is_err());
    }

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect()
    }

    #[test]
    fn 같은_이름의_헤더는_node처럼_합친다() {
        let h = headers(&[("host", "a"), ("host", "b"), ("cookie", "x=1"), ("cookie", "y=2"), ("origin", "o1"), ("origin", "o2"), ("x-forwarded-host", "f1"), ("x-forwarded-host", ""), ("x-forwarded-host", "f3"), ("referer", "r1"), ("referer", "r2")]);
        assert_eq!(header_value(&h, "host").as_deref(), Some("a"));
        assert_eq!(header_value(&h, "cookie").as_deref(), Some("x=1; y=2"));
        assert_eq!(header_value(&h, "origin").as_deref(), Some("o1, o2"));
        assert_eq!(header_value(&h, "x-forwarded-host").as_deref(), Some("f1, , f3"));
        assert_eq!(header_value(&h, "referer").as_deref(), Some("r1"));
        // 끝이 빈 값이면 합친 뒤 Headers가 끝의 공백을 뗀다
        assert_eq!(header_value(&headers(&[("x-a", "v"), ("x-a", "")]), "x-a").as_deref(), Some("v,"));
        assert_eq!(header_value(&h, "nope"), None);
    }

    #[test]
    fn 호스트_이름은_포트와_대괄호를_정리한다() {
        for (host, expected) in [("Localhost:3000", "localhost"), ("[::1]:3000", "[::1]"), ("[::1", ""), ("a:1:2", "a:1"), ("a:", "a:"), ("a:x", "a:x"), ("  127.0.0.1 ", "127.0.0.1"), ("a:٣", "a:٣")] {
            assert_eq!(request_host_name(&headers(&[("host", host)])), expected, "{host:?}");
        }
    }

    #[test]
    fn 게시판_mcp_경로는_세그먼트_하나만_받는다() {
        assert!(is_public_path("/api/task-plans/abc/board/mcp"));
        assert!(!is_public_path("/api/task-plans//board/mcp"));
        assert!(!is_public_path("/api/task-plans/a/b/board/mcp"));
        assert!(!is_public_path("/api/task-plans/a/board/mcp/"));
        assert!(!is_public_path("/api/healthz"));
    }

    #[test]
    fn 무효화_기록은_ts와_같은_오류를_낸다() {
        let ok = parse_revocations(r#"{"version":1,"sessions":{"a":1,"a":2},"users":{"u":3.5}}"#, "f").unwrap();
        assert_eq!(ok.sessions["a"], 2.0);
        assert_eq!(ok.users["u"], 3.5);
        let shape = LoadError::Failed("f을(를) 읽지 못했습니다: sessions와 users가 숫자 값을 가진 객체여야 합니다".to_string());
        for text in ["null", "5", "\"x\"", "[]", "{}", r#"{"sessions":{},"users":[]}"#, r#"{"sessions":{"a":"1"},"users":{}}"#, r#"{"sessions":null,"users":{}}"#] {
            assert_eq!(parse_revocations(text, "f").unwrap_err(), shape, "{text}");
        }
        assert_eq!(parse_revocations("{", "f").unwrap_err(), LoadError::Failed("f을(를) 읽지 못했습니다: JSON이 아닙니다".to_string()));
    }
}
