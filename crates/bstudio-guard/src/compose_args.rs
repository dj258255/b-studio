//! `LocalDockerProvider`가 docker에 넘기는 인자 배열과 오류 글(옛 TS: `packages/sandbox/src/docker/compose-provider.ts`, ADR-195 4f A4c-4).
//!
//! 실행 순서와 클래스 상태(`#upQueue`·`#processBaseline`·`#composeConfig` 등)는 TS에 남는다. 여기는 같은 입력에 같은 배열·같은 글자를 내는
//! 순수 함수만 둔다. docker는 PATH 이름 검색으로 부르고(공통 규칙 6) 설정에서 온 값은 인자 배열로 넘긴다(공통 규칙 7) — 이 모듈은 아무것도 실행하지 않는다.
//!
//! `tail`·`edgePort`처럼 옛 TS가 `String(...)`으로 만든 값은 TS가 만든 글자를 그대로 받는다. JS의 수 표기(`1e+21`, `NaN`)를 Rust의
//! f64 표기로 다시 만들면 같은 수가 다른 글자가 되기 때문이다.

/// `docker compose --project-name … --project-directory … --file … --file …` 앞부분에 하위 명령 인자를 붙인다
pub fn compose_command_args(project_name: &str, project_root: &str, compose_path: &str, override_path: &str, args: &[String]) -> Vec<String> {
    let mut out = strings(&["compose", "--project-name"]);
    out.push(project_name.to_owned());
    out.push("--project-directory".to_owned());
    out.push(project_root.to_owned());
    out.push("--file".to_owned());
    out.push(compose_path.to_owned());
    out.push("--file".to_owned());
    out.push(override_path.to_owned());
    out.extend(args.iter().cloned());
    out
}

/// compose 파일 없이도 프로젝트 이름으로 이 샌드박스의 자원을 지우는 명령의 인자(외부 공유 캐시는 지우지 않는다)
pub fn sandbox_cleanup_args(project_name: &str) -> Vec<String> {
    let mut out = strings(&["compose", "--project-name"]);
    out.push(project_name.to_owned());
    out.extend(strings(&["down", "--volumes", "--remove-orphans", "--rmi", "local"]));
    out
}

/// 서비스를 켠다: 이미지를 다시 빌드하고 그 서비스만 띄운다(`--no-deps`)
pub fn service_start_args(name: &str) -> Vec<String> {
    let mut out = strings(&["up", "--detach", "--build", "--no-deps"]);
    out.push(name.to_owned());
    out
}

/// 서비스를 멈춘다(볼륨은 남는다)
pub fn service_stop_args(name: &str) -> Vec<String> {
    let mut out = strings(&["stop"]);
    out.push(name.to_owned());
    out
}

/// 서비스 하나를 켜거나 끈다(ADR-083)
pub fn service_running_args(name: &str, running: bool) -> Vec<String> {
    if running {
        service_start_args(name)
    } else {
        service_stop_args(name)
    }
}

/// 서비스를 새로 만들어 띄운다(`--build --force-recreate`, `--no-deps`)
pub fn service_recreate_args(name: &str) -> Vec<String> {
    let mut out = strings(&["up", "--detach", "--build", "--no-deps", "--force-recreate"]);
    out.push(name.to_owned());
    out
}

/// edge가 서비스를 위해 공개한 호스트 포트를 읽는 `compose port` 인자. 포트는 TS가 만든 글자다
pub fn edge_port_args(edge_service: &str, edge_port: &str) -> Vec<String> {
    let mut out = strings(&["port"]);
    out.push(edge_service.to_owned());
    out.push(edge_port.to_owned());
    out
}

/// 서비스 하나의 컨테이너 상태를 읽는 `compose ps` 인자
pub fn compose_ps_args(name: &str) -> Vec<String> {
    let mut out = strings(&["ps", "--all", "--format", "json"]);
    out.push(name.to_owned());
    out
}

/// `compose logs` 인자. 꺼 둔 서비스·부가 서비스도 이름으로 좁힌다
pub fn compose_logs_args(services: &[String], follow: bool, tail: &str) -> Vec<String> {
    let mut out = strings(&["logs"]);
    if follow {
        out.push("--follow".to_owned());
    }
    out.extend(strings(&["--no-color", "--timestamps", "--tail"]));
    out.push(tail.to_owned());
    out.extend(services.iter().cloned());
    out
}

/// `compose exec` 인자. `command`는 문자열로 이어 붙이지 않고 그대로 인자로 넘긴다
pub fn compose_exec_args(name: &str, command: &[String]) -> Vec<String> {
    let mut out = strings(&["exec", "-T"]);
    out.push(name.to_owned());
    out.extend(command.iter().cloned());
    out
}

/// `compose build` 인자. `selected`가 없으면 전체를 빌드하고, 비어 있으면 부르지 않는다(`None` — 인자 없는 build는 "전부 빌드"라는 뜻이라서다)
pub fn sandbox_build_args(no_cache: bool, selected: Option<Vec<String>>) -> Option<Vec<String>> {
    let mut out = strings(&["build"]);
    if no_cache {
        out.push("--no-cache".to_owned());
    }
    match selected {
        None => Some(out),
        Some(services) if services.is_empty() => None,
        Some(services) => {
            out.extend(services);
            Some(out)
        }
    }
}

/// `compose up`을 전체 서비스에 대해 돌릴 때 쓰는 인자(`up --detach --remove-orphans` + 넘긴 인자)
pub fn compose_up_remove_orphans_args(up_args: &[String]) -> Vec<String> {
    let mut out = strings(&["up", "--detach", "--remove-orphans"]);
    out.extend(up_args.iter().cloned());
    out
}

/// `docker compose <command> 실패 (<sandbox id>)`. 뒤에 붙는 stderr 원문·플랫폼 표시는 TS가 정한다
pub fn compose_failure_message(command: &str, sandbox_id: &str) -> String {
    format!("docker compose {command} 실패 ({sandbox_id})")
}

/// compose 서비스가 아닌 이름을 켜거나 끌 때의 거절 글
pub fn compose_service_required_message(name: &str, sandbox_id: &str) -> String {
    format!("'{name}'은(는) 이 프로젝트의 compose 서비스가 아닙니다 ({sandbox_id})")
}

/// managed 서비스가 아닌 이름을 다룰 때의 거절 글
pub fn managed_service_required_message(name: &str) -> String {
    format!("'{name}'은(는) 이 프로젝트의 managed 서비스가 아닙니다")
}

/// `compose config --format json`을 읽지 못했을 때의 글
pub fn compose_config_unreadable_message(sandbox_id: &str) -> String {
    format!("compose 설정을 읽지 못했습니다 ({sandbox_id})")
}

/// 한 서비스가 준비에 실패해 나머지 확인을 멈췄을 때, 멈춘 서비스에 붙이는 이유
pub fn readiness_stopped_message(failed_first: &str) -> String {
    format!("{failed_first} 서비스가 준비에 실패해 확인을 멈췄습니다")
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        strings(items)
    }

    #[test]
    fn compose_인자_앞부분에_하위_명령을_붙인다() {
        assert_eq!(
            compose_command_args("studio-p", "/proj", "/proj/compose.yaml", "/work/compose.override.yaml", &list(&["ps", "--all", "--format", "json", "web"])),
            list(&[
                "compose",
                "--project-name",
                "studio-p",
                "--project-directory",
                "/proj",
                "--file",
                "/proj/compose.yaml",
                "--file",
                "/work/compose.override.yaml",
                "ps",
                "--all",
                "--format",
                "json",
                "web",
            ])
        );
        assert_eq!(compose_command_args("", "", "", "", &[]), list(&["compose", "--project-name", "", "--project-directory", "", "--file", "", "--file", ""]));
    }

    #[test]
    fn 지우기_인자는_공유_캐시를_지우지_않는다() {
        assert_eq!(
            sandbox_cleanup_args("studio-p"),
            list(&["compose", "--project-name", "studio-p", "down", "--volumes", "--remove-orphans", "--rmi", "local"])
        );
    }

    #[test]
    fn 서비스_켜기_끄기_다시_만들기() {
        assert_eq!(service_start_args("web"), list(&["up", "--detach", "--build", "--no-deps", "web"]));
        assert_eq!(service_stop_args("web"), list(&["stop", "web"]));
        assert_eq!(service_running_args("web", true), service_start_args("web"));
        assert_eq!(service_running_args("web", false), service_stop_args("web"));
        assert_eq!(service_recreate_args("web"), list(&["up", "--detach", "--build", "--no-deps", "--force-recreate", "web"]));
        // 이름이 플래그처럼 보여도 위치 인자 하나로만 들어간다
        assert_eq!(service_start_args("--detach"), list(&["up", "--detach", "--build", "--no-deps", "--detach"]));
        assert_eq!(service_start_args(""), list(&["up", "--detach", "--build", "--no-deps", ""]));
    }

    #[test]
    fn 포트와_상태_조회() {
        assert_eq!(edge_port_args("edge", "3000"), list(&["port", "edge", "3000"]));
        assert_eq!(edge_port_args("", ""), list(&["port", "", ""]));
        assert_eq!(compose_ps_args("web"), list(&["ps", "--all", "--format", "json", "web"]));
    }

    #[test]
    fn 로그_인자_순서와_따라가기() {
        assert_eq!(compose_logs_args(&[], true, "200"), list(&["logs", "--follow", "--no-color", "--timestamps", "--tail", "200"]));
        assert_eq!(compose_logs_args(&list(&["web", "api"]), false, "0"), list(&["logs", "--no-color", "--timestamps", "--tail", "0", "web", "api"]));
        // 빈 이름·플래그처럼 보이는 이름도 붙인다
        assert_eq!(compose_logs_args(&list(&["", "--help"]), true, "x"), list(&["logs", "--follow", "--no-color", "--timestamps", "--tail", "x", "", "--help"]));
    }

    #[test]
    fn exec_인자는_명령을_그대로_잇는다() {
        assert_eq!(compose_exec_args("web", &[]), list(&["exec", "-T", "web"]));
        assert_eq!(compose_exec_args("web", &list(&["sh", "-c", "echo hi"])), list(&["exec", "-T", "web", "sh", "-c", "echo hi"]));
        assert_eq!(compose_exec_args("", &list(&[""])), list(&["exec", "-T", "", ""]));
    }

    #[test]
    fn 빌드_인자_선택이_없으면_전체_빈_목록이면_부르지_않는다() {
        assert_eq!(sandbox_build_args(false, None), Some(list(&["build"])));
        assert_eq!(sandbox_build_args(true, None), Some(list(&["build", "--no-cache"])));
        assert_eq!(sandbox_build_args(false, Some(vec![])), None);
        assert_eq!(sandbox_build_args(true, Some(vec![])), None);
        assert_eq!(sandbox_build_args(false, Some(list(&["web", "api"]))), Some(list(&["build", "web", "api"])));
        assert_eq!(sandbox_build_args(true, Some(list(&["web"]))), Some(list(&["build", "--no-cache", "web"])));
    }

    #[test]
    fn 전체_up_인자() {
        assert_eq!(compose_up_remove_orphans_args(&[]), list(&["up", "--detach", "--remove-orphans"]));
        assert_eq!(
            compose_up_remove_orphans_args(&list(&["--no-deps", "web", "edge"])),
            list(&["up", "--detach", "--remove-orphans", "--no-deps", "web", "edge"])
        );
    }

    #[test]
    fn 오류_글은_바이트까지_같다() {
        assert_eq!(compose_failure_message("up", "studio-p"), "docker compose up 실패 (studio-p)");
        assert_eq!(compose_failure_message("", ""), "docker compose  실패 ()");
        assert_eq!(compose_service_required_message("web", "studio-p"), "'web'은(는) 이 프로젝트의 compose 서비스가 아닙니다 (studio-p)");
        assert_eq!(managed_service_required_message("web"), "'web'은(는) 이 프로젝트의 managed 서비스가 아닙니다");
        assert_eq!(compose_config_unreadable_message("studio-p"), "compose 설정을 읽지 못했습니다 (studio-p)");
        assert_eq!(readiness_stopped_message("api"), "api 서비스가 준비에 실패해 확인을 멈췄습니다");
        // 이름에 따옴표·개행·유니코드가 있어도 그대로 들어간다
        assert_eq!(managed_service_required_message("we'b\n한"), "'we'b\n한'은(는) 이 프로젝트의 managed 서비스가 아닙니다");
    }
}
