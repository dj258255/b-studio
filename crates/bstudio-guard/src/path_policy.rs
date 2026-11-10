//! 경로 이름 비교와 도구 정책 판정(ADR-191 3단계 3q). 옛 `packages/agent/src/path-names.ts`의 `normalizeProjectPath`·`foldName`·
//! `canonicalProjectPath`와 `policy.ts`의 `isToolAllowed`·`checkToolPolicy`·`hasApprovalToken`·`isProtectedPath`·`isWithinScope`·금지 명령 판정.
//!
//! **막는 검사다. 호출 자리마다 막는 쪽인지 여는 쪽인지가 다르다.**
//!  - 거부 목록(넓게 맞춘다. 틀려도 더 막을 뿐): `fold_name`, `canonical_project_path`, `is_protected_path`, 금지 명령 판정
//!  - 허용 목록(좁게 맞춘다. 넓히면 범위 밖이 범위 안이 된다): `normalize_project_path`만 쓰는 `is_within_scope`, `is_tool_allowed`
//!
//! 두 갈래는 같은 "꼴 맞추기" 함수를 함께 쓰지 않는다. 모르는 입력(꼴을 못 맞춘 경로·규칙)은 거부 목록에서는 걸린 것으로, 허용 목록에서는 범위 밖으로 본다.
//!
//! 옛 TS와 같은 입력에 같은 결과를 낸다. 다른 곳은 둘뿐이고 모두 더 막는 쪽이다.
//!  1. `fold_name`의 NFKD·NFKC·`\p{M}\p{Cf}`·대소문자 접기는 Node(ICU 77.1, Unicode 16)와 이 크레이트들의 Unicode 판이 달라, 옛 구현이 안 접던
//!     Unicode 16 미배정 글자 일부를 새 구현은 접는다(거부 목록이라 더 많이 같은 꼴로 모일 뿐이다. 차이 목록은 `docs/decisions.md` ADR-191 3q).
//!  2. `find(...)`가 찾은 규칙이 빈 글자일 때 옛 구현은 `if (found)`의 거짓으로 보아 통과시켰다(보호 경로 `''`, 금지 명령 `''`).
//!     새 구현은 찾았으면 거절한다(열린 쪽 틈을 닫는다).
//!
//! 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(Node도 파일 이름에는 그렇게 쓴다).

use crate::{js, node_path};
use regex::Regex;
use serde::Deserialize;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

/// 표기만 정리한다: 구분자, `.`·`..`·겹친 `/`. 이름은 건드리지 않는다. 루트 자체는 빈 글자다.
/// 프로젝트 밖으로 나가거나, 절대 경로거나, NUL이 들었거나, POSIX에서 역슬래시가 들었으면(`lenient` 아니면) `None`.
/// `backslash_sep`은 `path.sep === '\\'`(Windows)다
pub fn normalize_project_path(file: &str, lenient: bool, backslash_sep: bool) -> Option<String> {
    if file.contains('\0') {
        return None;
    }
    let slashed;
    let mut view = file;
    if file.contains('\\') {
        if !backslash_sep && !lenient {
            return None;
        }
        slashed = file.replace('\\', "/");
        view = &slashed;
    }
    let bytes = view.as_bytes();
    if view.starts_with('/') || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/') {
        return None;
    }
    let normalized = node_path::normalize(view);
    let normalized = normalized.strip_suffix('/').unwrap_or(&normalized);
    if normalized == "." || normalized.is_empty() {
        return Some(String::new());
    }
    if normalized == ".." || normalized.starts_with("../") {
        return None;
    }
    Some(normalized.to_owned())
}

fn mark_or_format() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\p{M}\p{Cf}]").expect("고정 정규식"))
}

/// 이름 한 조각을 거부 목록과 견줄 꼴로 **넓게** 접는다(NFKD → 결합 문자·서식 문자 제거 → 대문자 → 소문자 → NFKC → 끝의 점·공백 제거).
/// 점과 공백뿐인 이름은 그대로 둔다
pub fn fold_name(segment: &str) -> String {
    let decomposed: String = segment.nfkd().collect();
    let stripped = mark_or_format().replace_all(&decomposed, "");
    let folded: String = stripped.to_uppercase().to_lowercase().nfkc().collect();
    let trimmed = folded.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        folded
    } else {
        trimmed.to_owned()
    }
}

/// 거부 목록과 견줄 경로: 표기를 정리하고 조각마다 넓게 접는다. 허용 목록에는 쓰지 않는다
pub fn canonical_project_path(file: &str, lenient: bool, backslash_sep: bool) -> Option<String> {
    let normalized = normalize_project_path(file, lenient, backslash_sep)?;
    if normalized.is_empty() {
        return Some(normalized);
    }
    Some(normalized.split('/').map(fold_name).collect::<Vec<_>>().join("/"))
}

/// 보호 경로 판정(거부 목록: 넓게 맞춘다). 꼴을 맞출 수 없는 경로나 규칙은 보호되는 쪽(true)으로 본다
pub fn is_protected_path(file: &str, candidate: &str, backslash_sep: bool) -> bool {
    let target = canonical_project_path(file, false, backslash_sep);
    let rule = canonical_project_path(candidate, true, backslash_sep);
    let (Some(target), Some(rule)) = (target, rule) else {
        return true;
    };
    if rule.is_empty() {
        return true;
    }
    target == rule || target.strip_prefix(&rule).is_some_and(|rest| rest.starts_with('/')) || (rule.starts_with('.') && target.strip_prefix(&rule).is_some_and(|rest| rest.starts_with('.')))
}

/// 쓰기 범위 판정(허용 목록: 좁게 맞춘다). 표기만 정리하고 이름은 글자 그대로 비교한다. 꼴을 맞출 수 없으면 범위 밖(false)
pub fn is_within_scope(file: &str, scope: &str, backslash_sep: bool) -> bool {
    let target = normalize_project_path(file, false, backslash_sep);
    let rule = normalize_project_path(scope, true, backslash_sep);
    let (Some(target), Some(rule)) = (target, rule) else {
        return false;
    };
    if rule.is_empty() {
        return true;
    }
    target == rule || target.strip_prefix(&rule).is_some_and(|rest| rest.starts_with('/'))
}

/// 허용 목록에 직접 적혀 있지 않아도 다른 읽기 도구의 권한으로 쓸 수 있는 도구(트러블슈팅 127)
pub fn is_tool_allowed(tool: &str, allowed_tools: &[String]) -> bool {
    if allowed_tools.iter().any(|t| t == tool) {
        return true;
    }
    let implied: &[&str] = match tool {
        "read_lines" => &["read_file"],
        "search_files" => &["read_file", "list_files"],
        _ => return false,
    };
    implied.iter().all(|required| allowed_tools.iter().any(|t| t == required))
}

/// 승인 토큰은 비어 있지 않은 글자(JS `trim` 기준)여야 한다
pub fn has_approval_token(token: Option<&str>) -> bool {
    token.is_some_and(|t| !js::trim(t).is_empty())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub allowed_tools: Option<Vec<String>>,
    pub denied_commands: Option<Vec<String>>,
    pub require_approval_for: Option<Vec<String>>,
    pub protected_paths: Option<Vec<String>>,
    pub writable_paths: Option<Vec<String>>,
}

/// `reason`이 없으면 허용이거나 이유를 적지 않은 결정이다
#[derive(Debug, PartialEq, Eq)]
pub struct Decision {
    pub allow: bool,
    pub reason: Option<String>,
}

fn deny(reason: String) -> Decision {
    Decision { allow: false, reason: Some(reason) }
}

/// 서비스 컨테이너 안의 `gradle --stop`·`./gradlew --stop`(옛 `GRADLE_STOP`). 명령 구분자(; & |)를 넘어가지 않는다.
/// 옛 정규식의 lookahead `(?=\s)`는 `\s(?:[^;&|]*\s)?`로 같은 글자 모임을 만든다(첫 `\s`가 lookahead가 보던 글자)
fn gradle_stop() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let ws = js::WS_CLASS;
        Regex::new(&format!(r"(?:^|[{ws};&|(])(?:[^{ws}]*/)?gradlew?[{ws}](?:[^;&|]*[{ws}])?--stop(?:[{ws}]|$)")).expect("고정 정규식")
    })
}

fn split_rule(rule: &str) -> Vec<&str> {
    js::trim(rule).split(js::is_js_whitespace).filter(|p| !p.is_empty()).collect()
}

fn starts_with_tokens(command: &[String], rule: &[&str]) -> bool {
    if rule.is_empty() || command.len() < rule.len() || command[0].is_empty() {
        return false;
    }
    let executable = node_path::basename(&command[0]);
    rule.iter().enumerate().all(|(index, token)| {
        if index == 0 {
            executable == *token
        } else {
            command[index] == *token
        }
    })
}

fn is_shell_wrapper(command: &[String]) -> bool {
    let executable = command.first().filter(|c| !c.is_empty()).map(|c| node_path::basename(c)).unwrap_or_default();
    ["sh", "bash", "zsh", "fish", "dash", "env", "cmd", "powershell", "pwsh"].contains(&executable.as_str())
}

/// 옛 `new RegExp('(?:^|\\s)' + 토큰들(\s+로 이음) + '(?:\\s|$)').test(command.slice(1).join(' '))`을 손으로 옮긴 것이다.
/// 토큰에는 공백이 없으므로 토큰은 공백으로 둘러싸인(또는 끝에 닿은) 낱말과 통째로 같아야 한다. 토큰이 없으면(빈 규칙) 옛 정규식은
/// `(?:^|\s)(?:\s|$)`이라 빈 글자, 공백으로 시작, 공백으로 끝남, 공백 연속에서 맞는다(옛 그대로)
fn contains_command(command: &[String], rule: &[&str]) -> bool {
    let joined = command[1.min(command.len())..].join(" ");
    let s = joined.as_str();
    if rule.is_empty() {
        let chars: Vec<char> = s.chars().collect();
        return chars.is_empty()
            || js::is_js_whitespace(chars[0])
            || js::is_js_whitespace(chars[chars.len() - 1])
            || chars.windows(2).any(|w| js::is_js_whitespace(w[0]) && js::is_js_whitespace(w[1]));
    }
    let mut prev_ws = true; // 글자열의 시작은 `^`
    for (index, c) in s.char_indices() {
        if prev_ws && s[index..].starts_with(rule[0]) && tokens_follow(&s[index + rule[0].len()..], &rule[1..]) {
            return true;
        }
        prev_ws = js::is_js_whitespace(c);
    }
    false
}

/// 앞 토큰 바로 뒤의 글자열이 `(\s+토큰)*(\s|$)` 꼴인가
fn tokens_follow(rest: &str, tokens: &[&str]) -> bool {
    match tokens.split_first() {
        None => rest.chars().next().is_none_or(js::is_js_whitespace),
        Some((token, more)) => {
            let after = rest.trim_start_matches(js::is_js_whitespace);
            after.len() < rest.len() && after.starts_with(token) && tokens_follow(&after[token.len()..], more)
        }
    }
}

/// 도구 호출 전 판정. `file`은 입력의 `path`(문자열이 아니면 빈 글자), `command`는 입력의 `command`(문자열 배열이 아니면 빈 배열),
/// `default_denied`는 TS가 정한 기본 금지 명령 목록(두 곳에서 따로 정하지 않는다).
/// `scope_file`은 쓰기 범위(허용 목록)와 견줄 파일이다. 부르는 쪽이 `file`과 `writable_paths`를 같은 단사 인코딩으로 바꿔 넘긴다(짝 없는 서로게이트가
/// U+FFFD로 합쳐져 범위 밖이 범위 안이 되지 않게, 트러블슈팅 166). 보호 경로(거부 목록)와 프로젝트 밖 판정은 `file` 그대로(경계에서 U+FFFD,
/// 파일 시스템이 실제로 쓰는 이름)와 견준다
pub fn check_tool_policy(
    tool: &str,
    file: &str,
    scope_file: &str,
    command: &[String],
    policy: Option<&Policy>,
    approval_token: Option<&str>,
    default_denied: &[String],
    backslash_sep: bool,
) -> Decision {
    let default_policy = Policy::default();
    let policy_ref = policy.unwrap_or(&default_policy);
    if let Some(allowed) = &policy_ref.allowed_tools {
        if !is_tool_allowed(tool, allowed) {
            return deny(format!("tool '{tool}' is not in the allowed tool list"));
        }
    }

    let path_write = matches!(tool, "write_file" | "edit_file" | "delete_file");
    let has_protected = policy_ref.protected_paths.as_ref().is_some_and(|p| !p.is_empty());
    if path_write && (policy_ref.writable_paths.is_some() || has_protected) && normalize_project_path(file, false, backslash_sep).is_none() {
        return deny("path leaves the project".to_owned());
    }

    if path_write {
        if let Some(writable) = &policy_ref.writable_paths {
            if !writable.iter().any(|candidate| is_within_scope(scope_file, candidate, backslash_sep)) {
                return deny(format!("path is outside this task's writable scope: {}", writable.join(", ")));
            }
        }
    }

    if path_write && has_protected {
        let protected = policy_ref.protected_paths.as_ref().expect("has_protected");
        if let Some(found) = protected.iter().find(|candidate| is_protected_path(file, candidate, backslash_sep)) {
            return deny(format!("path is protected by execution policy: {found}"));
        }
    }

    if tool == "run_in_service" {
        let extra = policy_ref.denied_commands.as_deref().unwrap_or(&[]);
        let denied = default_denied.iter().chain(extra.iter()).find(|rule| {
            let tokens = split_rule(rule);
            starts_with_tokens(command, &tokens) || (is_shell_wrapper(command) && contains_command(command, &tokens))
        });
        if let Some(rule) = denied {
            return deny(format!("command is blocked by execution policy: {rule}"));
        }
        if gradle_stop().is_match(&command.join(" ")) {
            return deny("gradle --stop is blocked: it stops the Gradle daemon that runs this service (bootRun) and takes the service down. Use restart_service to restart the service instead".to_owned());
        }
    }

    if let Some(required) = &policy_ref.require_approval_for {
        if required.iter().any(|t| t == tool) && !has_approval_token(approval_token) {
            return deny("this tool requires an explicit approval before execution".to_owned());
        }
    }

    Decision { allow: true, reason: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| (*i).to_owned()).collect()
    }

    fn defaults() -> Vec<String> {
        s(&["git push", "git reset --hard", "git clean", "kubectl", "docker", "terraform apply"])
    }

    fn decide(tool: &str, file: &str, command: &[&str], policy: &str) -> Decision {
        let policy: Option<Policy> = serde_json::from_str(policy).unwrap();
        check_tool_policy(tool, file, file, &s(command), policy.as_ref(), None, &defaults(), false)
    }

    #[test]
    fn 이름_접기는_닮은_글자와_끝의_점_공백을_모은다() {
        assert_eq!(fold_name(".GIT"), ".git");
        assert_eq!(fold_name(".git."), ".git");
        assert_eq!(fold_name(".git "), ".git");
        assert_eq!(fold_name(".gi\u{200B}t"), ".git");
        assert_eq!(fold_name("\u{FF0E}\u{FF47}\u{FF49}\u{FF54}"), ".git");
        assert_eq!(fold_name("workflow\u{17F}"), "workflows");
        assert_eq!(fold_name("\u{212A}afka"), "kafka");
        assert_eq!(fold_name(".g\u{EF}t"), ".git");
        assert_eq!(fold_name("..."), "...");
        assert_eq!(fold_name("문서"), "문서");
        // NBSP는 호환 분해로 공백이 되어 끝에서 떨어진다
        assert_eq!(fold_name("a\u{A0}"), "a");
    }

    #[test]
    fn 표기_정리는_밖으로_나가는_경로와_절대_경로를_거른다() {
        assert_eq!(normalize_project_path("a//b/../c/", false, false).as_deref(), Some("a/c"));
        assert_eq!(normalize_project_path(".", false, false).as_deref(), Some(""));
        assert_eq!(normalize_project_path("", false, false).as_deref(), Some(""));
        for bad in ["..", "../x", "a/../../x", "/x", "C:/x", "a\0b", "a\\b"] {
            assert_eq!(normalize_project_path(bad, false, false), None, "{bad}");
        }
        assert_eq!(normalize_project_path("a:b.txt", false, false).as_deref(), Some("a:b.txt"));
        assert_eq!(normalize_project_path("a\\b", true, false).as_deref(), Some("a/b"));
        assert_eq!(normalize_project_path("a\\b", false, true).as_deref(), Some("a/b"));
    }

    #[test]
    fn 보호_경로는_넓게_쓰기_범위는_좁게_맞춘다() {
        assert!(is_protected_path(".GITHUB/workflows/x", ".github/workflows", false));
        assert!(is_protected_path(".env.local", ".env", false));
        assert!(!is_protected_path("srcx/a", "src", false));
        assert!(is_protected_path("../x", "infra", false));
        assert!(is_protected_path("x", "../outside", false));
        assert!(is_protected_path("x", ".", false));
        assert!(!is_within_scope("SRC/a", "src", false));
        assert!(!is_within_scope(".env.local", ".env", false));
        assert!(!is_within_scope("srcx/a", "src", false));
        assert!(is_within_scope("src/a", "./src/", false));
        assert!(!is_within_scope("../x", "web", false));
        assert!(!is_within_scope("x", "/abs", false));
        assert!(is_within_scope("anything", ".", false));
    }

    #[test]
    fn 금지_명령은_셸_감싸기와_gradle_stop_변형까지_막는다() {
        let deny = |command: &[&str]| !decide("run_in_service", "", command, "null").allow;
        assert!(deny(&["git", "push"]));
        assert!(deny(&["/usr/bin/git", "push", "origin"]));
        assert!(deny(&["sh", "-c", "git push origin main"]));
        assert!(deny(&["bash", "-lc", "ls && git   push"]));
        assert!(!deny(&["bash", "-lc", "xgit push"]));
        assert!(!deny(&["bash", "-lc", "git pushx"]));
        assert!(!deny(&["python", "-c", "git push"]));
        assert!(deny(&["./gradlew", "--stop"]));
        assert!(deny(&["./gradlew", "-p", "commerce", "--stop"]));
        assert!(deny(&["bash", "-lc", "cd x; gradle   --stop"]));
        assert!(!deny(&["./gradlew", "test;", "echo", "--stop"]));
        assert!(!deny(&["./gradlew", "--stopx"]));
        assert!(!deny(&["./gradlewx", "--stop"]));
        // JS `\s`는 U+FEFF를 공백으로 읽는다
        assert!(deny(&["bash", "-lc", "gradle\u{FEFF}--stop"]));
    }

    #[test]
    fn 빈_규칙을_찾으면_거절한다() {
        assert_eq!(decide("write_file", "web/x.ts", &[], r#"{"protectedPaths":[""]}"#).reason.as_deref(), Some("path is protected by execution policy: "));
        assert!(!decide("run_in_service", "", &["sh", "-c", " x"], r#"{"deniedCommands":[""]}"#).allow);
    }

    #[test]
    fn 읽기_도구_함의와_승인() {
        assert!(is_tool_allowed("read_lines", &s(&["read_file"])));
        assert!(!is_tool_allowed("read_lines", &s(&["list_files"])));
        assert!(is_tool_allowed("search_files", &s(&["read_file", "list_files"])));
        assert!(!is_tool_allowed("search_files", &s(&["read_file"])));
        assert!(!is_tool_allowed("constructor", &s(&["read_file"])));
        assert!(!has_approval_token(Some(" \u{FEFF}\n")));
        assert!(has_approval_token(Some("a")));
        assert!(!has_approval_token(None));
        assert!(!decide("write_file", "a", &[], r#"{"requireApprovalFor":["write_file"]}"#).allow);
    }
}
