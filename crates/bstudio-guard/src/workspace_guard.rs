//! 작업 공간(`packages/agent/src/workspace.ts`)의 막는 검사(ADR-191 3단계 3w): 숨긴 이름·비밀 파일 판정, 프로젝트 안쪽 판정, 들어온 경로의 글자 검사.
//! 파일 시스템 접근(`lstat`·`realpath`·`open`·`readdir`)과 경로 계산(`path.resolve`·`path.relative`)은 TS에 남는다. 여기는 그 결과(이름, 상대 경로)를 읽어 정한다.
//!
//! **호출 자리마다 막는 쪽인지 여는 쪽인지가 다르다. 같은 "꼴 맞추기" 함수를 둘에 함께 쓰지 않는다.**
//!  - 거부 목록(넓게 맞춘다. 틀려도 더 막을 뿐): [`is_denied`], [`is_denied_file_name`], [`is_secret_file`]. 이름은 [`path_policy::fold_name`]으로 접어 견준다
//!    (대소문자·유니코드 정규화·보이지 않는 문자·끝의 점과 공백). 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 되며 파일 시스템도 그렇게 읽는다.
//!  - 허용 목록(좁게 맞춘다. 넓히면 범위 밖이 범위 안이 된다): [`is_inside_relative`](`안에 있다`가 통과), [`is_env_template`](`.env.example` 예외는 닮은 이름까지 열면 안 된다).
//!    예외는 접지 않고 글자 그대로(NFC·소문자만) 맞춘다. 꼴을 못 맞추거나 모르는 입력은 거부 목록에서는 걸린 것으로, 허용 목록에서는 범위 밖·예외 아님으로 본다.
//!
//! 옛 TS와 같은 입력에 같은 결과를 낸다. 다른 곳은 하나이고 더 막는 쪽이다: `.env.` 뒤에 줄 끝 글자(`\n`·`\r`·U+2028·U+2029)가 오는 이름을
//! 옛 정규식(`/^\.env(\..*)?$/`)의 `.`이 못 맞춰 통과시켰으나 새 구현은 막는다(`.env.`로 시작하면 숨긴다).

use crate::path_policy::fold_name;
use unicode_normalization::UnicodeNormalization;

/// 에이전트가 읽거나 쓰면 안 되는 디렉터리 이름(접은 꼴). 생성물이거나 거대하거나 비밀이 들어 있다
const DENIED_SEGMENTS: [&str; 7] = [".git", "node_modules", ".next", "build", ".gradle", ".venv", "__pycache__"];
const TEMPLATE_SUFFIXES: [&str; 4] = ["example", "sample", "template", "dist"];

/// 접은 이름이 `.env`이거나 `.env.`로 시작한다(거부 목록: 넓게)
fn looks_like_env(folded: &str) -> bool {
    folded == ".env" || folded.starts_with(".env.")
}

/// `.env` 계열이지만 형식만 보여 주는 예시 파일인가(허용 목록: 좁게). 옛 `/^\.env(\.[\w-]+)*\.(example|sample|template|dist)$/`을
/// NFC·소문자로 바꾼 글자에 건 것과 같다: `.env` 뒤가 `.`로 시작하는 ASCII 단어 글자(`[A-Za-z0-9_-]`) 조각들이고 마지막 조각이 예시 낱말이다
pub fn is_env_template(segment: &str) -> bool {
    let lowered: String = segment.nfc().collect::<String>().to_lowercase();
    let Some(rest) = lowered.strip_prefix(".env.") else {
        return false;
    };
    let parts: Vec<&str> = rest.split('.').collect();
    let word = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    parts.iter().all(|part| word(part)) && parts.last().is_some_and(|last| TEMPLATE_SUFFIXES.contains(last))
}

/// `.env`·`.env.*` 이름인가(예시 파일은 뺀다). 거부 목록이라 넓게 접은 꼴로 보고, 예외는 좁게 본다
pub fn is_denied_file_name(segment: &str) -> bool {
    looks_like_env(&fold_name(segment)) && !is_env_template(segment)
}

/// 경로 조각 하나가 숨긴 이름(생성물 폴더·`.env` 계열)인가
pub fn is_denied(segment: &str) -> bool {
    DENIED_SEGMENTS.contains(&fold_name(segment).as_str()) || is_denied_file_name(segment)
}

/// 경로의 어느 구간이든 `.env`·`.env.*`이면 비밀 파일이다(예시 파일은 뺀다). 역슬래시도 구분자로 읽는다(거부 목록이라 넓게)
pub fn is_secret_file(file: &str) -> bool {
    file.replace('\\', "/").split('/').any(is_denied_file_name)
}

/// 플랫폼의 `path.isAbsolute`. `backslash_sep`은 `path.sep === '\\'`(Windows)다
fn is_absolute(file: &str, backslash_sep: bool) -> bool {
    let bytes = file.as_bytes();
    if !backslash_sep {
        return file.starts_with('/');
    }
    matches!(bytes.first(), Some(b'/' | b'\\')) || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
}

/// `path.relative(root, target)`의 결과가 프로젝트 안쪽을 가리키는가(허용 목록: 통과가 곧 안쪽). 빈 글자는 루트 자신이다.
/// `..`로 시작하는 이름(`..proj`)은 바깥이 아니라 안쪽 이름이다. 절대 경로(다른 드라이브)는 바깥이다
pub fn is_inside_relative(relative: &str, backslash_sep: bool) -> bool {
    let sep = if backslash_sep { '\\' } else { '/' };
    relative.is_empty() || (relative != ".." && !relative.strip_prefix("..").is_some_and(|rest| rest.starts_with(sep)) && !is_absolute(relative, backslash_sep))
}

/// 들어온 경로 글자의 문제: 0 없음, 1 절대 경로, 2 쓸 수 없는 글자(NUL, POSIX의 역슬래시). `external`(바깥에서 온 변경 알림)은 둘째 검사를 하지 않는다
pub fn input_problem(file: &str, backslash_sep: bool, external: bool) -> u8 {
    if is_absolute(file, backslash_sep) {
        return 1;
    }
    if !external && (file.contains('\0') || (!backslash_sep && file.contains('\\'))) {
        return 2;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 숨긴_이름은_접은_꼴로_본다() {
        for name in [".git", ".GIT", ".git.", ".git ", ".gi\u{200B}t", "node_modules", "Node_Modules", "BUILD", ".env", ".ENV", ".env.local", ".Env.production", ".env.", ".env.local\n", "\u{FF0E}env"] {
            assert!(is_denied(name), "{name:?}");
        }
        for name in ["src", "gitx", ".gitx", "env", ".envx", ".env_local", "builds", ".git/x", ""] {
            assert!(!is_denied(name), "{name:?}");
        }
    }

    #[test]
    fn 예시_파일은_글자_그대로만_연다() {
        for name in [".env.example", ".ENV.EXAMPLE", ".env.local.example", ".env.production.dist", ".env.a-b_c.template", ".env.sample"] {
            assert!(!is_denied_file_name(name), "{name:?}");
        }
        for name in [".env.example.", ".env.example ", ".env.exam\u{200B}ple", ".env.example\n", ".env.examples", ".env.example.x", ".env..example", ".env.\u{FF45}xample", ".env.exa mple", ".env.é.example", ".env.example\u{0301}"] {
            assert!(is_denied_file_name(name), "{name:?}");
        }
    }

    #[test]
    fn 비밀_파일은_구간마다_본다() {
        assert!(is_secret_file("backend/.env"));
        assert!(is_secret_file("a\\.env.local"));
        assert!(is_secret_file("a/.ENV/b"));
        assert!(!is_secret_file(".env.example"));
        assert!(!is_secret_file("a/.git/x"));
    }

    #[test]
    fn 안쪽_판정은_상대_경로의_첫_조각만_본다() {
        for rel in ["", "a", "a/b", "..a", "..a/b", ".../x", "a/../b"] {
            assert!(is_inside_relative(rel, false), "{rel:?}");
        }
        for rel in ["..", "../a", "../..", "/etc", "/"] {
            assert!(!is_inside_relative(rel, false), "{rel:?}");
        }
        assert!(is_inside_relative("..\\x", false), "POSIX에서 역슬래시는 이름의 글자");
        assert!(!is_inside_relative("..\\x", true));
        assert!(!is_inside_relative("D:\\x", true));
        assert!(!is_inside_relative("\\\\srv\\x", true));
        assert!(is_inside_relative("D:x", true));
    }

    #[test]
    fn 입력_글자_검사() {
        assert_eq!(input_problem("/etc", false, false), 1);
        assert_eq!(input_problem("a\0b", false, false), 2);
        assert_eq!(input_problem("a\\b", false, false), 2);
        assert_eq!(input_problem("a\\b", true, false), 0);
        assert_eq!(input_problem("a\\b", false, true), 0);
        assert_eq!(input_problem("a\0b", false, true), 0);
        assert_eq!(input_problem("C:\\x", true, true), 1);
        assert_eq!(input_problem("C:/x", false, false), 0);
    }
}
