//! CLI 실행 파일 고르기의 판정(ADR-191 3단계 3ac). 옮기기 전 TS는 `packages/agent/src/claude-cli-process.ts`의 `resolveCliCommand`·`childEnv`·`insideRoot`
//! (트러블슈팅 167)였다. 이 모듈은 파일 시스템을 읽지 않는 부분만 담는다(PATH 나누기, 절대 항목 거르기, 후보 경로 만들기, 폴더 안인지의 글자 비교).
//! 파일 상태를 읽는 부분(실제 경로·파일 종류·실행 권한)은 `bstudio-io`의 `cli_command`가 같은 크레이트 안에서 이 판정을 불러 쓴다.
//!
//! 호출부마다 막는 쪽인지 여는 쪽인지가 다르다.
//! - 막는 쪽(거부 목록): `is_under`(프로젝트 안인가). 모르면 안으로 본다
//! - 여는 쪽(허용 목록): `path_entries`·`candidate`가 고른 항목만 후보가 된다. 상대 항목·빈 항목은 후보가 아니다
//!
//! 의도한 차이(옛 TS는 열린 쪽으로 틀렸다 — 트러블슈팅 176):
//! - 폴더 안인지를 `path.relative(...).startsWith('..')`로 봐서 `..bin` 같은 이름의 폴더 안 파일을 "밖"으로 읽었다. 여기서는 구성 요소 단위로 본다
//! - 실제 경로의 대소문자가 다르면(대소문자를 구분하지 않는 볼륨) 같은 폴더가 "밖"으로 읽혔다. 여기서는 폴더의 식별자(장치·inode)로도 견준다
//! - 이 판정은 macOS·Linux만 다룬다(`node_path`와 같다). 다른 플랫폼에서는 후보를 고르지 않는다(막는 쪽으로 틀린다)

use crate::node_path;

/// PATH 값을 나눈 항목 중 절대 경로만. 빈 항목·상대 항목·따옴표로 감싼 항목은 후보가 아니다(자식의 cwd가 프로젝트라 프로젝트 폴더로 풀린다)
pub fn path_entries(value: &str) -> Vec<&str> {
    value.split(':').filter(|dir| !dir.is_empty() && node_path::is_absolute(dir)).collect()
}

/// 명령에 경로 구분자가 있는가(있으면 PATH를 보지 않고 절대 경로만 받는다)
pub fn has_separator(command: &str) -> bool {
    command.contains('/')
}

/// PATH 항목과 명령 이름으로 후보 경로를 만든다(`path.posix.join`)
pub fn candidate(dir: &str, command: &str) -> String {
    node_path::join(&[dir, command])
}

/// 절대 경로를 글자로 풀어 앞에서부터의 조상 경로를 돌려준다. `/a/b` → `/`, `/a`, `/a/b`. 풀 수 없으면(상대 경로) 빈 목록
pub fn prefixes(absolute: &str) -> Vec<String> {
    if !node_path::is_absolute(absolute) {
        return Vec::new();
    }
    let normal = node_path::normalize(absolute);
    let mut out = vec!["/".to_owned()];
    let mut acc = String::new();
    for part in normal.split('/').filter(|part| !part.is_empty()) {
        acc.push('/');
        acc.push_str(part);
        out.push(acc.clone());
    }
    out
}

/// `real`이 `root`와 같거나 그 안인가(구성 요소 단위 비교, 막는 쪽). 둘 다 정규화한 절대 경로여야 하고 아니면 안으로 본다
pub fn is_under(real: &str, root: &str) -> bool {
    if !node_path::is_absolute(real) || !node_path::is_absolute(root) {
        return true;
    }
    let real: Vec<&str> = real.split('/').filter(|part| !part.is_empty()).collect();
    let root: Vec<&str> = root.split('/').filter(|part| !part.is_empty()).collect();
    real.len() >= root.len() && real[..root.len()] == root[..]
}

/// 자식의 PATH 값. 빈 항목·상대 항목과 `inside`가 true인 항목을 뺀다(막는 쪽: `inside`는 모르면 true)
pub fn child_path(value: &str, inside: &dyn Fn(&str) -> bool) -> String {
    path_entries(value).into_iter().filter(|dir| !inside(dir)).collect::<Vec<_>>().join(":")
}

/// 못 찾았을 때의 이유(TS가 `spawn <명령> ENOENT: <이유>`로 던진다)
pub const REASON_RELATIVE_COMMAND: &str = "실행 파일 경로는 절대 경로여야 합니다";
pub const REASON_INSIDE_PROJECT: &str = "프로젝트 폴더 안의 실행 파일은 띄우지 않습니다";
pub const REASON_NOT_FOUND: &str = "PATH의 절대 경로 항목에서 찾지 못했습니다(빈 항목·상대 항목과 프로젝트 폴더 안은 보지 않습니다)";
pub const REASON_UNSUPPORTED: &str = "이 플랫폼에서는 실행 파일을 고르지 않습니다(macOS·Linux만 지원)";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_항목은_절대_경로만_남는다() {
        assert_eq!(path_entries("/a::b:.:/c:\"/d\":"), vec!["/a", "/c"]);
        assert!(path_entries("").is_empty());
        assert!(path_entries(":").is_empty());
    }

    #[test]
    fn 후보는_정규화한다() {
        assert_eq!(candidate("/a/b/", "x"), "/a/b/x");
        assert_eq!(candidate("/a/../b", "x"), "/b/x");
    }

    #[test]
    fn 조상은_앞에서부터() {
        assert_eq!(prefixes("/a//b/../c"), vec!["/", "/a", "/a/c"]);
        assert!(prefixes("a/b").is_empty());
    }

    #[test]
    fn 안인지는_구성_요소로_본다() {
        assert!(is_under("/p", "/p"));
        assert!(is_under("/p/x", "/p"));
        assert!(is_under("/p/..x/y", "/p"));
        assert!(!is_under("/pp", "/p"));
        assert!(!is_under("/", "/p"));
        assert!(is_under("rel", "/p"));
        assert!(is_under("/p", "rel"));
    }

    #[test]
    fn 자식_path는_거른_항목만_잇는다() {
        let kept = child_path(":/a:.:/b:/proj", &|dir| dir == "/proj");
        assert_eq!(kept, "/a:/b");
    }
}
