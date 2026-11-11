//! docker·compose CLI를 부를 때 넘기는 환경(이슈 #701, 옛 TS: `packages/sandbox/src/docker/compose-env.ts`, ADR-195 4f A4a).
//!
//! compose는 compose 파일의 `${VAR}`를 자기 프로세스 환경에서 채운다. compose 파일은 에이전트가 고칠 수 있으므로, studio의 환경을
//! 그대로 넘기면 `environment: { X: "${GITHUB_TOKEN}" }` 한 줄로 studio를 띄운 셸의 자격 증명이 샌드박스 컨테이너에 들어간다.
//! 가림은 선언된 시크릿만 알아 이 값은 로그에서도 가려지지 않는다.
//!
//! **허용 목록이다.** CLI가 데몬·컨텍스트·자격 증명 도우미·빌드를 찾는 데 쓰는 이름만 넘기고, 선언된 시크릿을 그 위에 얹는다.
//! 목록에 없는 이름은 넘기지 않는다(compose는 빈 문자열로 채운다). 이름은 **대소문자를 구분해** 견준다(`Path`는 `PATH`가 아니다 —
//! 옛 TS와 같다). 이름 비교를 넓게 바꾸면 범위 밖 환경 변수가 컨테이너로 간다. 모르는 이름은 넘기지 않는다.

/// 이름이 정확히 같아야 하는 것
const EXACT: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    // Windows에서 CLI와 자격 증명 도우미가 찾는 이름
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
];
/// 이 글자로 시작하는 이름
const PREFIXES: &[&str] = &["DOCKER_", "COMPOSE_", "BUILDKIT_", "BUILDX_", "LC_"];

/// 이 이름의 환경 변수를 CLI에 넘겨도 되는가. 허용 목록이므로 모르는 이름은 `false`다
pub fn is_allowed_name(name: &str) -> bool {
    EXACT.contains(&name) || PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

/// 허용한 환경 변수 위에 시크릿을 얹은 목록. 환경의 순서를 지키고, 시크릿이 같은 이름을 덮으면 그 자리에서 값만 바뀐다.
/// 환경에 값이 없는 이름(`undefined`)은 부르는 쪽이 넘기지 않는다
pub fn compose_environment(secrets: &[(String, String)], env: &[(String, String)]) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = env.iter().filter(|(name, _)| is_allowed_name(name)).cloned().collect();
    for (name, value) in secrets {
        match merged.iter_mut().find(|(existing, _)| existing == name) {
            Some(slot) => slot.1 = value.clone(),
            None => merged.push((name.clone(), value.clone())),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn 허용_목록의_이름만_넘긴다() {
        let env = pairs(&[("PATH", "/bin"), ("GITHUB_TOKEN", "x"), ("DOCKER_HOST", "h"), ("COMPOSE_PROJECT_NAME", "p"), ("LC_ALL", "C"), ("AWS_SECRET_ACCESS_KEY", "y"), ("HOME", "/h")]);
        let got = compose_environment(&[], &env);
        assert_eq!(got, pairs(&[("PATH", "/bin"), ("DOCKER_HOST", "h"), ("COMPOSE_PROJECT_NAME", "p"), ("LC_ALL", "C"), ("HOME", "/h")]));
    }

    #[test]
    fn 대소문자만_다른_이름은_넘기지_않는다() {
        for name in ["path", "Path", "home", "Home", "docker_host", "Docker_Host", "compose_x", "lc_all", "Lc_All", "systemroot", "SYSTEMROOT", "comspec", "programdata", "Pathext", "user", "Lang", "ssh_auth_sock", "tmpdir"] {
            assert!(!is_allowed_name(name), "{name}");
        }
        for name in ["SystemRoot", "ComSpec", "ProgramData", "LOCALAPPDATA"] {
            assert!(is_allowed_name(name), "{name}");
        }
    }

    #[test]
    fn 접두사는_뒤에_글자가_없어도_맞고_접두사만_닮으면_아니다() {
        assert!(is_allowed_name("DOCKER_"));
        assert!(is_allowed_name("BUILDX_NO_DEFAULT_ATTESTATIONS"));
        for name in ["DOCKER", "DOCKERX_A", "XDOCKER_A", "COMPOSE", "BUILDKIT", "LC", "LC-ALL", "", " PATH", "PATH ", "PATH\0"] {
            assert!(!is_allowed_name(name), "{name:?}");
        }
    }

    #[test]
    fn 빈_값도_그대로_넘긴다() {
        assert_eq!(compose_environment(&[], &pairs(&[("HOME", ""), ("TOKEN", "")])), pairs(&[("HOME", "")]));
    }

    #[test]
    fn 시크릿은_허용_목록과_상관없이_얹고_같은_이름은_값을_덮는다() {
        let env = pairs(&[("PATH", "/bin"), ("HOME", "/h")]);
        let secrets = pairs(&[("HOME", "/s"), ("API_KEY", "k"), ("", "empty-name")]);
        assert_eq!(compose_environment(&secrets, &env), pairs(&[("PATH", "/bin"), ("HOME", "/s"), ("API_KEY", "k"), ("", "empty-name")]));
    }
}
