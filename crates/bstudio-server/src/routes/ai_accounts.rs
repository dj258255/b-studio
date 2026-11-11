//! `GET /api/ai-accounts`(apps/studio/app/api/ai-accounts/route.ts의 GET). 읽는 것은 환경 변수와 `accounts.json`(Node가 임시 파일 + rename으로 쓴다)뿐이다.
//! POST(계정 더하기)와 `/api/ai-accounts/[id]`는 Node 메모리의 쓰기 대기열을 쓰므로 Node가 처리한다.
//!
//! 앞단이 답하는 것은 두 가지뿐이다: ① 인증을 켠 모드의 403, ② 목록 성공. 설정·파일이 틀려 Node가 500을 줄 입력(오류 글에 JS 오류 문구가 든다)과
//! Rust가 Node와 같다고 확신할 수 없는 입력은 모두 `None`(Node로 넘김)이다.
use std::collections::HashSet;

use axum::response::Response;
use serde_json::Value;

use super::json_response;
use crate::auth::{self, Env};

/// `CLI_ACCOUNT_BACKENDS`(cli-accounts.ts)의 순서
const CLI_ACCOUNT_BACKENDS: [&str; 5] = ["claude-code", "codex", "commandcode", "opencode", "gemini"];
/// `SESSION_BACKENDS`(sessions.ts)
const SESSION_BACKENDS: [&str; 6] = ["api", "claude-code", "codex", "commandcode", "opencode", "gemini"];
const SESSION_MODES: [&str; 7] = ["api", "claude-code", "codex", "commandcode", "opencode", "gemini", "demo"];

const FORBIDDEN_BODY: &str = "{\"error\":\"계정은 개인 PC 모드(로컬 CLI)에서만 씁니다\"}";

#[derive(Debug, Clone, PartialEq)]
struct Account {
    id: String,
    name: String,
    backend: &'static str,
    config_dir: Option<String>,
    sprite: Option<String>,
    builtin: bool,
}

pub fn get(env: &Env) -> Option<Response> {
    // `requireAccountsAccess`: 사용자는 인증 판단이 확인했다(Allow). 인증을 켠 모드는 403
    if !auth::auth_is_none(env)? {
        return Some(json_response(403, FORBIDDEN_BODY.to_string()));
    }
    let backends = allowed_backends(env)?;
    let file = accounts_file(env)?;
    let stored = match std::fs::read(&file) {
        Ok(bytes) => parse_stored(std::str::from_utf8(&bytes).ok()?)?,
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Vec::new(),
        Err(_) => return None,
    };
    Some(json_response(200, body(&list(&stored, &backends))))
}

/// `allowedAccountBackends()`: `sessionMode()`와 `B_STUDIO_BACKENDS`(없는 값이면 Node가 500이라 None) 중 계정이 있는 CLI
fn allowed_backends(env: &Env) -> Option<Vec<&'static str>> {
    let mode = env.get("B_STUDIO_MODE").map(auth::js_trim).filter(|v| !v.is_empty()).unwrap_or("api");
    if !SESSION_MODES.contains(&mode) {
        return None;
    }
    let mut allowed: HashSet<&str> = HashSet::from([mode]);
    if mode != "demo" {
        for raw in env.get("B_STUDIO_BACKENDS").unwrap_or("").split(',') {
            let value = auth::js_trim(raw);
            if value.is_empty() {
                continue;
            }
            allowed.insert(SESSION_BACKENDS.iter().find(|known| **known == value)?);
        }
    }
    Some(CLI_ACCOUNT_BACKENDS.iter().copied().filter(|backend| allowed.contains(backend)).collect())
}

/// `accountsFile(env)`. 홈·XDG 값이 절대 경로가 아니거나 Node의 `homedir()` 대체가 필요하면 None
fn accounts_file(env: &Env) -> Option<std::path::PathBuf> {
    let base = match env.get("XDG_CONFIG_HOME").map(auth::js_trim).filter(|v| !v.is_empty()) {
        Some(xdg) => xdg.to_string(),
        None => {
            let home = env.get("HOME").map(auth::js_trim).filter(|v| !v.is_empty())?;
            format!("{home}/.config")
        }
    };
    if !base.starts_with('/') {
        // Node는 시작할 때 작업 폴더를 apps/studio로 바꾼다. 상대 경로는 기준이 다르다
        return None;
    }
    Some(auth::path_resolve(&format!("{base}/b-studio/accounts.json"), "/").into())
}

/// 파일의 글과 허용한 CLI에서 응답 본문을 만든다(벡터 시험이 쓴다). 파일이 없으면 `None` 글. 꼴이 틀리면 None
pub fn render(text: Option<&str>, backends: &[&'static str]) -> Option<String> {
    let stored = match text {
        Some(text) => parse_stored(text)?,
        None => Vec::new(),
    };
    Some(body(&list(&stored, backends)))
}

/// 파일의 글 → 계정들. 꼴이 하나라도 틀리면 None(Node가 500)
fn parse_stored(text: &str) -> Option<Vec<Account>> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    parsed.as_object()?.get("accounts")?.as_array()?.iter().map(read_entry).collect()
}

fn read_entry(value: &Value) -> Option<Account> {
    let record = value.as_object()?;
    let id = record.get("id")?.as_str()?;
    if !valid_id(id) {
        return None;
    }
    let name = record.get("name")?.as_str()?;
    if auth::js_trim(name).is_empty() {
        return None;
    }
    let backend = *CLI_ACCOUNT_BACKENDS.iter().find(|known| Some(**known) == record.get("backend").and_then(Value::as_str))?;
    let config_dir = match record.get("configDir") {
        None => None,
        Some(dir) => {
            let dir = dir.as_str()?;
            if !dir.starts_with('/') {
                return None;
            }
            Some(dir.to_string())
        }
    };
    let sprite = match record.get("sprite") {
        None => None,
        Some(sprite) => {
            let sprite = sprite.as_str()?;
            if !valid_sprite(sprite) {
                return None;
            }
            Some(sprite.to_string())
        }
    };
    Some(Account { id: id.to_string(), name: name.to_string(), backend, config_dir, sprite, builtin: false })
}

/// `/^[a-z0-9][a-z0-9-]{0,39}$/`
fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=40).contains(&bytes.len()) && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// ai-accounts.ts의 `SPRITE`: `^(?:P1 P2{0,63}/){0,3}P1 P2{0,123}\.(?:png|gif)$`(i). 수량자는 P2에만 붙는다.
/// P1은 `. / \` 제어 글자를 뺀 한 글자, P2는 `/ \` 제어 글자를 뺀 글자. 글자는 UTF-16 단위로 센다.
/// ASCII가 아닌 글자(서로게이트 쌍, 대소문자 접기)는 같다고 확신할 수 없어 받지 않는다(None으로 Node에 넘긴다)
fn valid_sprite(sprite: &str) -> bool {
    if !sprite.is_ascii() {
        return false;
    }
    let bad = |c: u8| c == b'/' || c == b'\\' || c < 0x20;
    let mut parts: Vec<&str> = sprite.split('/').collect();
    let file = parts.pop().unwrap_or("");
    if parts.len() > 3 {
        return false;
    }
    for dir in parts {
        let b = dir.as_bytes();
        if b.is_empty() || b.len() > 64 || b[0] == b'.' || b.iter().any(|c| bad(*c)) {
            return false;
        }
    }
    let lower = file.to_ascii_lowercase();
    let Some(stem) = lower.strip_suffix(".png").or_else(|| lower.strip_suffix(".gif")) else { return false };
    let stem = &file.as_bytes()[..stem.len()];
    !stem.is_empty() && stem.len() <= 124 && stem[0] != b'.' && !stem.iter().any(|c| bad(*c))
}

/// `listAiAccounts(env, backends)`
fn list(stored: &[Account], backends: &[&'static str]) -> Vec<Account> {
    let mut result = Vec::new();
    for backend in backends {
        result.push(stored.iter().find(|account| account.id == *backend).cloned().unwrap_or_else(|| Account { id: backend.to_string(), name: "기본".to_string(), backend, config_dir: None, sprite: None, builtin: true }));
        result.extend(stored.iter().filter(|account| account.backend == *backend && account.id != *backend).cloned());
    }
    result
}

/// `JSON.stringify({ accounts })`: 키 순서는 id, name, backend, configDir, sprite, builtin
fn body(accounts: &[Account]) -> String {
    let items: Vec<String> = accounts
        .iter()
        .map(|account| {
            let mut out = format!("{{\"id\":{},\"name\":{},\"backend\":{}", auth::js_json_string(&account.id), auth::js_json_string(&account.name), auth::js_json_string(account.backend));
            if let Some(dir) = &account.config_dir {
                out.push_str(&format!(",\"configDir\":{}", auth::js_json_string(dir)));
            }
            if let Some(sprite) = &account.sprite {
                out.push_str(&format!(",\"sprite\":{}", auth::js_json_string(sprite)));
            }
            if account.builtin {
                out.push_str(",\"builtin\":true");
            }
            out.push('}');
            out
        })
        .collect();
    format!("{{\"accounts\":[{}]}}", items.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        Env::from_pairs(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
    }

    fn text(response: Response) -> (u16, String) {
        let (parts, body) = response.into_parts();
        let bytes = futures_body(body);
        (parts.status.as_u16(), bytes)
    }

    fn futures_body(body: axum::body::Body) -> String {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let bytes = rt.block_on(async { http_body_util::BodyExt::collect(body).await.unwrap().to_bytes() });
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[test]
    fn 파일이_없으면_허용한_cli의_기본_계정이다() {
        let dir = tempfile::tempdir().unwrap();
        let e = env(&[("HOME", dir.path().to_str().unwrap()), ("B_STUDIO_MODE", "claude-code"), ("B_STUDIO_BACKENDS", " codex ,, gemini")]);
        let (status, body) = text(get(&e).unwrap());
        assert_eq!(status, 200);
        assert_eq!(body, "{\"accounts\":[{\"id\":\"claude-code\",\"name\":\"기본\",\"backend\":\"claude-code\",\"builtin\":true},{\"id\":\"codex\",\"name\":\"기본\",\"backend\":\"codex\",\"builtin\":true},{\"id\":\"gemini\",\"name\":\"기본\",\"backend\":\"gemini\",\"builtin\":true}]}");
    }

    #[test]
    fn 홈의_config_폴더에서_읽고_xdg가_공백이면_홈을_쓴다() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join(".config/b-studio");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("accounts.json"), r#"{"accounts":[{"id":"acct-1","name":"x","backend":"codex"}]}"#).unwrap();
        for xdg in [None, Some("  ")] {
            let mut pairs = vec![("HOME", dir.path().to_str().unwrap()), ("B_STUDIO_MODE", "codex")];
            if let Some(xdg) = xdg {
                pairs.push(("XDG_CONFIG_HOME", xdg));
            }
            let (_, body) = text(get(&env(&pairs)).unwrap());
            assert!(body.contains("acct-1"), "{body}");
        }
    }

    #[test]
    fn 데모_모드는_빈_목록이다() {
        let dir = tempfile::tempdir().unwrap();
        let (_, body) = text(get(&env(&[("HOME", dir.path().to_str().unwrap()), ("B_STUDIO_MODE", "demo"), ("B_STUDIO_BACKENDS", "nope")])).unwrap());
        assert_eq!(body, "{\"accounts\":[]}");
    }

    #[test]
    fn 인증을_켜면_403이고_틀린_설정은_넘긴다() {
        let (status, body) = text(get(&env(&[("B_STUDIO_AUTH", "proxy"), ("B_STUDIO_AUTH_PROXY_SECRET", &"P".repeat(32))])).unwrap());
        assert_eq!((status, body.as_str()), (403, FORBIDDEN_BODY));
        assert!(get(&env(&[("B_STUDIO_AUTH", "bogus")])).is_none());
        assert!(get(&env(&[("HOME", "/tmp"), ("B_STUDIO_MODE", "bogus")])).is_none());
        assert!(get(&env(&[("HOME", "/tmp"), ("B_STUDIO_MODE", "codex"), ("B_STUDIO_BACKENDS", "bogus")])).is_none());
        assert!(get(&env(&[])).is_none(), "HOME 없음");
        assert!(get(&env(&[("HOME", "rel")])).is_none(), "상대 경로");
        assert!(get(&env(&[("HOME", "/tmp"), ("XDG_CONFIG_HOME", "rel")])).is_none());
    }

    #[test]
    fn 저장한_계정은_기본_계정_뒤에_온다() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("b-studio");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(
            cfg.join("accounts.json"),
            r#"{"accounts":[{"id":"acct-1","name":"업무 \"A\"\u0001","backend":"codex","configDir":"/h/.c","sprite":"a/b.PNG","extra":1},{"id":"claude-code","name":"내 것","backend":"claude-code"},{"id":"acct-2","name":"x","backend":"gemini"}]}"#,
        )
        .unwrap();
        let e = env(&[("XDG_CONFIG_HOME", dir.path().to_str().unwrap()), ("B_STUDIO_MODE", "claude-code"), ("B_STUDIO_BACKENDS", "codex")]);
        let (_, body) = text(get(&e).unwrap());
        assert_eq!(
            body,
            "{\"accounts\":[{\"id\":\"claude-code\",\"name\":\"내 것\",\"backend\":\"claude-code\"},{\"id\":\"codex\",\"name\":\"기본\",\"backend\":\"codex\",\"builtin\":true},{\"id\":\"acct-1\",\"name\":\"업무 \\\"A\\\"\\u0001\",\"backend\":\"codex\",\"configDir\":\"/h/.c\",\"sprite\":\"a/b.PNG\"}]}"
        );
    }

    #[test]
    fn 깨진_파일과_틀린_항목은_넘긴다() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("b-studio");
        std::fs::create_dir_all(&cfg).unwrap();
        let e = env(&[("XDG_CONFIG_HOME", dir.path().to_str().unwrap()), ("B_STUDIO_MODE", "codex")]);
        for bad in ["{", "[]", "{\"accounts\":{}}", "{\"accounts\":[1]}", "{\"accounts\":[{\"id\":\"A\",\"name\":\"x\",\"backend\":\"codex\"}]}", "{\"accounts\":[{\"id\":\"a\",\"name\":\" \",\"backend\":\"codex\"}]}", "{\"accounts\":[{\"id\":\"a\",\"name\":\"x\",\"backend\":\"api\"}]}", "{\"accounts\":[{\"id\":\"a\",\"name\":\"x\",\"backend\":\"codex\",\"configDir\":\"rel\"}]}", "{\"accounts\":[{\"id\":\"a\",\"name\":\"x\",\"backend\":\"codex\",\"sprite\":null}]}"] {
            std::fs::write(cfg.join("accounts.json"), bad).unwrap();
            assert!(get(&e).is_none(), "{bad}");
        }
        // 파일 자리가 폴더
        std::fs::remove_file(cfg.join("accounts.json")).unwrap();
        std::fs::create_dir(cfg.join("accounts.json")).unwrap();
        assert!(get(&e).is_none());
    }

    #[test]
    fn 그림_경로_규칙() {
        for ok in ["a.png", "A.GIF", "a/b/c/d.png", "pokemon/25.gif", &format!("{}.png", "x".repeat(124)), &format!("{}/a.png", "d".repeat(64)), "a.b.png", "ab..png"] {
            assert!(valid_sprite(ok), "{ok}");
        }
        for bad in ["", ".png", "a", "a.jpg", "/a.png", "a//b.png", ".a.png", "../a.png", "a/b/c/d/e.png", &format!("{}.png", "x".repeat(125)), &format!("{}/a.png", "d".repeat(65)), "a\\b.png", "a\u{1}.png", "é.png", "a.png ", "a.png\n", "a/.hidden/../x.png"] {
            assert!(!valid_sprite(bad), "{bad:?}");
        }
    }
}
