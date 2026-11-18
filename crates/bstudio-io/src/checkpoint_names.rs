//! 체크포인트 `excludedFiles` 이름의 경계 검사(허용 목록).
//!
//! `CheckpointStore`의 공개 옵션 `excludedFiles`가 돌려준 이름은 프로젝트 폴더와 `path.join`으로 이어져
//! 읽고 쓴다(`checkpoint_local.rs`의 사이드카·백업·되살리기). 제품 경로(`generatedFilePaths`)는 고정 이름과
//! `readdir` 이름만 내지만, 공개 옵션이라 프로젝트 밖을 가리키는 이름이 들어올 수 있다.
//! 이름을 받은 자리에서 **한 번** 검사하고, 하나라도 어기면 그 이름만 빼지 않고 던진다 —
//! 생성 파일을 확인하지 못한 채 커밋·되돌리기가 통과하면 안 된다.

/// 이름 하나가 프로젝트 폴더 기준의 안전한 상대 경로인가. 어기면 이유(한국어)를 돌려준다.
///
/// 허용 목록이다: 상대 경로, 구분자는 `/`만, 빈 조각·`.`·`..` 없음, NUL 없음, `.git` 조각 없음.
/// `.git`은 대소문자를 가리지 않는다(대소문자를 구분하지 않는 볼륨에서 `.GIT/config`가 같은 폴더다 — 거부 목록은 넓게).
pub fn excluded_name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("빈 이름입니다");
    }
    if name.contains('\0') {
        return Some("NUL 문자가 있습니다");
    }
    if name.contains('\\') {
        return Some("경로 구분자는 `/`만 씁니다");
    }
    if name.starts_with('/') {
        return Some("절대 경로입니다");
    }
    if name.ends_with('/') {
        return Some("끝이 `/`입니다");
    }
    for segment in name.split('/') {
        if segment.is_empty() {
            return Some("빈 경로 조각이 있습니다");
        }
        if segment == "." {
            return Some("`.` 조각이 있습니다");
        }
        if segment == ".." {
            return Some("상위 폴더(`..`)를 가리킵니다");
        }
        if segment.eq_ignore_ascii_case(".git") {
            return Some("`.git` 조각이 있습니다");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_that_can_leave_the_project() {
        for (name, reason) in [
            ("../outside.txt", "상위 폴더"),
            ("/etc/hosts", "절대 경로"),
            ("a/../../x", "상위 폴더"),
            ("", "빈 이름"),
            ("a\0b", "NUL"),
            (".git/config", "`.git`"),
            ("a//b", "빈 경로 조각"),
            ("./a", "`.`"),
            ("a/", "끝이 `/`"),
            ("a\\b", "구분자"),
        ] {
            let problem = excluded_name_problem(name)
                .unwrap_or_else(|| panic!("{name:?}을(를) 거부해야 한다"));
            assert!(problem.contains(reason), "{name:?}: {problem}");
        }
    }

    #[test]
    fn product_names_pass() {
        for name in [
            "studio.yaml",
            "compose.b-studio.yaml",
            "Dockerfile.b-studio",
            "apps/web/Dockerfile.b-studio",
            "apps/web/commerce/consumer-app/Dockerfile.b-studio",
        ] {
            assert_eq!(excluded_name_problem(name), None, "{name}");
        }
    }
}
