//! `LocalDockerProvider`가 쓰는 순수 도우미(옛 TS: `packages/sandbox/src/docker/compose-provider.ts`, ADR-195 4f A4a).

use crate::js;

/// Docker VM 디스크가 가득 찼을 때 원인과 다음 행동을 알려 주는 문구
pub const DOCKER_OUT_OF_SPACE: &str = "Docker 디스크가 가득 찼습니다. 'studio sandbox prune --dry-run' 으로 남은 샌드박스 자원을 확인하고 정리하거나 Docker VM 디스크를 늘리세요.";

/// compose up 실패가 호스트↔VM 포트 가시성 차이로 인한 바인드 충돌인지 본다(`findFreeHostPort`가 미리 고른 포트를
/// VM 안의 다른 컨테이너가 이미 쓰고 있는 경우) — 다른 실패(디스크 부족, 이미지 빌드 실패 등)는 재시도하지 않는다.
///
/// 옛 TS는 `/failed to bind port .*address already in use|error starting userland proxy|address already in use|port is already allocated/i`였다.
/// 첫 가지는 `address already in use`를 품으므로 셋째 가지가 이미 덮는다. JS의 `/i`는 ASCII 글자만 접는다(`ſ`는 `s`가 아니다) —
/// `to_ascii_lowercase`가 같다
pub fn is_port_bind_conflict(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    ["address already in use", "error starting userland proxy", "port is already allocated"].iter().any(|needle| lower.contains(needle))
}

/// 디스크 부족으로 실패했으면 원문 뒤에 덧붙일 안내 문구. 아니면 `None`(원문을 그대로 돌려준다)
pub fn out_of_space_note(text: &str) -> Option<&'static str> {
    text.contains("no space left on device").then_some(DOCKER_OUT_OF_SPACE)
}

/// docker 명령이 디스크 부족으로 실패했는지 보고, 그렇다면 안내 문구를 덧붙인다.
/// 그 밖의 오류는 원문을 그대로 돌려준다. 오류를 삼키지 않도록 항상 원래 메시지를 포함한다
pub fn describe_docker_failure(text: &str) -> String {
    match out_of_space_note(text) {
        Some(note) => format!("{text}\n{note}"),
        None => text.to_owned(),
    }
}

/// `compose up` 인자에서 뽑은 것
#[derive(Debug, PartialEq, Eq)]
pub struct UpArgs {
    /// 컨테이너를 만들기만 한다(`--no-start`). 빌드와 다시 만들기(`--build`, `--force-recreate`)는 이 단계에서 한다
    pub create: Vec<String>,
    /// 이름을 준 서비스. 비어 있으면 compose 파일의 모든 서비스다
    pub services: Vec<String>,
    /// 이름을 주고 `--no-deps`를 붙인 up이면 true. 의존 서비스를 따라 띄우지 않으므로 확인한 컨테이너의 id로 바로 시작한다
    pub by_id: bool,
}

/// `compose up` 인자에서 만들기 단계의 인자와 시작할 대상을 뽑는다(트러블슈팅 121)
pub fn split_up_args(args: &[String]) -> UpArgs {
    let (command, rest) = match args.split_first() {
        Some((command, rest)) => (command.as_str(), rest),
        None => ("up", &[][..]),
    };
    let services: Vec<String> = rest.iter().filter(|arg| !arg.starts_with('-')).cloned().collect();
    let mut create = vec![command.to_owned(), "--no-start".to_owned()];
    create.extend(rest.iter().filter(|arg| arg.as_str() != "--detach").cloned());
    let by_id = !services.is_empty() && rest.iter().any(|arg| arg == "--no-deps");
    UpArgs { create, services, by_id }
}

/// 스튜디오 서버·CLI 환경 변수 `B_STUDIO_CONTAINER_RUNTIME`의 값. 격리 수준은 프로젝트가 아니라 운영자가 정한다
pub fn runtime_from_env(value: Option<&str>) -> Option<String> {
    value.map(js::trim).filter(|v| !v.is_empty()).map(str::to_owned)
}

/// `B_STUDIO_SANDBOX_BUILD_NO_CACHE`의 값이 `1`이나 `true`(대소문자 무관)이면 이 샌드박스 프로젝트의 이미지를 레이어 캐시 없이 빌드하고
/// 스냅샷도 쓰지 않는다. `docker builder prune`처럼 다른 프로젝트의 빌드 캐시까지 지우지 않는다 — 이 샌드박스에만 적용된다.
/// JS의 `toLowerCase`가 ASCII `1`·`true`로 접는 비ASCII 글자는 없으므로 ASCII 소문자화로 같다
pub fn sandbox_build_no_cache(value: Option<&str>) -> bool {
    matches!(value.map(|v| js::trim(v).to_ascii_lowercase()).as_deref(), Some("1" | "true"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn 포트_충돌_메시지만_충돌로_본다() {
        for text in [
            "Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:40001 failed: port is already allocated",
            "failed to bind port 0.0.0.0:80/tcp: listen tcp4 0.0.0.0:80: bind: Address Already In Use",
            "Error starting userland proxy: listen tcp4 0.0.0.0:3000",
            "ADDRESS ALREADY IN USE",
        ] {
            assert!(is_port_bind_conflict(text), "{text}");
        }
        for text in ["", "no space left on device", "pull access denied", "address already\nin use", "addreſs already in use", "port is already\nallocated"] {
            assert!(!is_port_bind_conflict(text), "{text}");
        }
    }

    #[test]
    fn 디스크_부족이면_안내를_덧붙인다() {
        assert_eq!(describe_docker_failure("write: no space left on device"), format!("write: no space left on device\n{DOCKER_OUT_OF_SPACE}"));
        assert_eq!(describe_docker_failure("No space left on device"), "No space left on device");
        assert_eq!(describe_docker_failure(""), "");
    }

    #[test]
    fn up_인자를_만들기와_시작_대상으로_나눈다() {
        let got = split_up_args(&strings(&["up", "--detach", "--build", "web", "--no-deps"]));
        assert_eq!(got, UpArgs { create: strings(&["up", "--no-start", "--build", "web", "--no-deps"]), services: strings(&["web"]), by_id: true });
        let all = split_up_args(&strings(&["up", "--detach", "--no-deps"]));
        assert_eq!((all.services.is_empty(), all.by_id), (true, false));
        let empty = split_up_args(&[]);
        assert_eq!(empty.create, strings(&["up", "--no-start"]));
        assert!(!empty.by_id);
        assert_eq!(split_up_args(&strings(&["create", "a", "b"])).create, strings(&["create", "--no-start", "a", "b"]));
    }

    #[test]
    fn 런타임과_캐시_환경_변수를_읽는다() {
        assert_eq!(runtime_from_env(Some("  runsc ")), Some("runsc".into()));
        assert_eq!(runtime_from_env(Some("   ")), None);
        assert_eq!(runtime_from_env(Some("")), None);
        assert_eq!(runtime_from_env(None), None);
        for yes in ["1", "true", " TRUE ", "True\n"] {
            assert!(sandbox_build_no_cache(Some(yes)), "{yes:?}");
        }
        for no in ["", "0", "yes", "2", "tru", "1 1", "\u{212a}"] {
            assert!(!sandbox_build_no_cache(Some(no)), "{no:?}");
        }
        assert!(!sandbox_build_no_cache(None));
    }
}
