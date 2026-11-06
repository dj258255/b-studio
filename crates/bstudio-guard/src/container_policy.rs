//! 만든 컨테이너가 샌드박스 격리를 벗어나는 설정을 가졌는지 본다(이슈 #701).
//!
//! compose 파일은 에이전트가 세션 중에 고칠 수 있으므로, compose를 읽지 않고 **만들어진 컨테이너의 실제 설정**
//! (`docker inspect`)을 본다. 거부 목록이다. 걸리면 시작하지 않는다.
//!  - 권한: `privileged`, `cap_add`, `devices`, seccomp·AppArmor·SELinux를 끄는 `security_opt`
//!  - 호스트·다른 컨테이너의 네임스페이스(`host`, `container:`)
//!  - 네트워크: 서비스는 sandbox 하나, edge는 그것과 egress만
//!  - 포트 공개: edge만
//!  - 호스트 경로 마운트: 컨테이너 런타임 소켓과 시스템 폴더
//!  - 서비스 이름 `studio`(edge가 studio 자신의 호출로 본다)
//!
//! 거부 목록이므로 **모양을 모르는 값은 걸린 것으로 센다**(`알 수 없는 형식: …`). 옮기기 전 TS는 진릿값으로 읽거나 던졌다(의도한 차이).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

const COMPOSE_SERVICE_LABEL: &str = "com.docker.compose.service";

/// 마운트하면 컨테이너가 호스트(또는 Docker VM)를 다룰 수 있게 되는 폴더. 이 폴더 자신과 그 아래가 걸린다
const SYSTEM_DIRS: [&str; 9] = [
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/var/run",
    "/var/lib/docker",
    "/var/lib/containerd",
    "/boot",
];

/// `(?i)`는 Unicode 단순 대소문자 접기라 옛 JS(비유니코드 `/i`)보다 넓다(`ſ`→`s`, 켈빈 기호→`k`). 거부 목록이라 넓으면 더 막을 뿐이고,
/// macOS의 대소문자 무시 볼륨도 이렇게 접는다(의도한 차이)
static SOCKET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^|[/\\])(docker|containerd|podman|buildkitd|colima)[^/\\]*\.sock$")
        .expect("정규식")
});
static SECURITY_OPT: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        r"(?i)unconfined",
        r"(?i)^label[=:]disable$",
        r"(?i)^no-new-privileges[=:]false$",
    ]
    .map(|p| Regex::new(p).expect("정규식"))
});
static WINDOWS_DRIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").expect("정규식"));
static DESKTOP_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/(run/desktop/mnt/host|host_mnt)/[^/]").expect("정규식"));

pub struct PolicyOptions<'a> {
    pub project_name: &'a str,
    pub sandbox_network: &'a str,
    pub egress_network: &'a str,
    pub edge_service: &'a str,
    /// `@b-studio/spec`의 `STUDIO_CALLER`. 값을 여기 박지 않고 부르는 쪽에서 받는다
    pub studio_caller: &'a str,
}

/// 필드 하나를 읽은 결과. 없거나 `null`이면 `Missing`(TS의 `?? []`처럼 빈 것), 기대한 형이 아니면 `Wrong`
enum Field<T> {
    Missing,
    Present(T),
    Wrong,
}

fn object(value: Option<&Value>) -> Field<&Map<String, Value>> {
    match value {
        None | Some(Value::Null) => Field::Missing,
        Some(Value::Object(map)) => Field::Present(map),
        Some(_) => Field::Wrong,
    }
}

fn array(value: Option<&Value>) -> Field<&Vec<Value>> {
    match value {
        None | Some(Value::Null) => Field::Missing,
        Some(Value::Array(items)) => Field::Present(items),
        Some(_) => Field::Wrong,
    }
}

fn string(value: Option<&Value>) -> Field<&str> {
    match value {
        None | Some(Value::Null) => Field::Missing,
        Some(Value::String(s)) => Field::Present(s),
        Some(_) => Field::Wrong,
    }
}

/// 문자열 배열. 항목 하나라도 문자열이 아니면 `Wrong`
fn strings(value: Option<&Value>) -> Field<Vec<&str>> {
    match array(value) {
        Field::Missing => Field::Missing,
        Field::Wrong => Field::Wrong,
        Field::Present(items) => items
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()
            .map_or(Field::Wrong, Field::Present),
    }
}

fn unknown(path: &str) -> String {
    format!("알 수 없는 형식: {path}")
}

/// JS가 `JSON.stringify`로 넘긴 `docker inspect` 한 항목을 읽어 판정한다. 읽지 못하면 오류(부르는 쪽이 시작하지 않는다)
pub fn find_violations_json(
    container_json: &str,
    options: &PolicyOptions,
) -> Result<Vec<String>, String> {
    let container: Value = serde_json::from_str(container_json)
        .map_err(|e| format!("컨테이너 설정을 읽지 못했습니다: {e}"))?;
    Ok(find_violations(&container, options))
}

pub fn find_violations(container: &Value, options: &PolicyOptions) -> Vec<String> {
    let mut problems = Vec::new();
    let Value::Object(container) = container else {
        return vec![unknown("container")];
    };
    let empty = Map::new();
    let host = match object(container.get("HostConfig")) {
        Field::Present(map) => map,
        Field::Missing => &empty,
        Field::Wrong => {
            problems.push(unknown("HostConfig"));
            &empty
        }
    };

    // Config.Labels의 서비스 이름. 옛 TS처럼 Config·Labels가 없으면 서비스 이름이 없는 것으로 본다
    let labels = match object(container.get("Config")) {
        Field::Present(config) => object(config.get("Labels")),
        Field::Missing => Field::Missing,
        Field::Wrong => Field::Wrong,
    };
    let service = match labels {
        Field::Present(labels) => match string(labels.get(COMPOSE_SERVICE_LABEL)) {
            Field::Present(s) => Some(s),
            Field::Missing => None,
            Field::Wrong => {
                problems.push(unknown("Config.Labels"));
                None
            }
        },
        Field::Missing => None,
        Field::Wrong => {
            problems.push(unknown("Config.Labels"));
            None
        }
    };
    let is_edge = service == Some(options.edge_service);

    if service == Some(options.studio_caller) {
        problems.push(format!(
            "서비스 이름 '{}'는 쓸 수 없습니다(edge가 studio의 호출로 봅니다)",
            options.studio_caller
        ));
    }
    match host.get("Privileged") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => {}
        Some(Value::Bool(true)) => problems.push("privileged".to_owned()),
        Some(_) => problems.push(unknown("HostConfig.Privileged")),
    }
    match strings(host.get("CapAdd")) {
        Field::Present(caps) if !caps.is_empty() => {
            problems.push(format!("cap_add: {}", caps.join(", ")))
        }
        Field::Wrong => problems.push(unknown("HostConfig.CapAdd")),
        _ => {}
    }
    for (key, label) in [
        ("Devices", "devices"),
        ("DeviceRequests", "device_requests(gpus)"),
    ] {
        match array(host.get(key)) {
            Field::Present(items) if !items.is_empty() => problems.push(label.to_owned()),
            Field::Wrong => problems.push(unknown(&format!("HostConfig.{key}"))),
            _ => {}
        }
    }
    match strings(host.get("SecurityOpt")) {
        Field::Present(options) => {
            for option in options {
                if SECURITY_OPT.iter().any(|re| re.is_match(option)) {
                    problems.push(format!("security_opt: {option}"));
                }
            }
        }
        Field::Wrong => problems.push(unknown("HostConfig.SecurityOpt")),
        Field::Missing => {}
    }
    for (name, key) in [
        ("pid", "PidMode"),
        ("ipc", "IpcMode"),
        ("uts", "UTSMode"),
        ("userns_mode", "UsernsMode"),
        ("cgroup", "CgroupnsMode"),
        ("network_mode", "NetworkMode"),
    ] {
        match string(host.get(key)) {
            Field::Present(mode) if mode == "host" || mode.starts_with("container:") => {
                problems.push(format!("{name}: {mode}"))
            }
            Field::Wrong => problems.push(unknown(&format!("HostConfig.{key}"))),
            _ => {}
        }
    }

    // compose는 네트워크 이름 앞에 프로젝트 이름을 붙인다
    let mut allowed = vec![format!(
        "{}_{}",
        options.project_name, options.sandbox_network
    )];
    if is_edge {
        allowed.push(format!(
            "{}_{}",
            options.project_name, options.egress_network
        ));
    }
    let networks = match object(container.get("NetworkSettings")) {
        Field::Present(settings) => object(settings.get("Networks")),
        Field::Missing => Field::Missing,
        Field::Wrong => Field::Wrong,
    };
    match networks {
        Field::Present(networks) => {
            let extra: Vec<&str> = networks
                .keys()
                .map(String::as_str)
                .filter(|n| !allowed.iter().any(|a| a == n))
                .collect();
            if !extra.is_empty() {
                problems.push(format!("networks: {}", extra.join(", ")));
            }
        }
        Field::Wrong => problems.push(unknown("NetworkSettings.Networks")),
        Field::Missing => {}
    }

    if !is_edge {
        match object(host.get("PortBindings")) {
            Field::Present(bindings) => {
                let mut published = Vec::new();
                for (port, binding) in bindings {
                    match array(Some(binding)) {
                        Field::Present(items) if !items.is_empty() => published.push(port.as_str()),
                        Field::Wrong => {
                            problems.push(unknown(&format!("HostConfig.PortBindings.{port}")))
                        }
                        _ => {}
                    }
                }
                if !published.is_empty() {
                    problems.push(format!("ports: {}", published.join(", ")));
                }
            }
            Field::Wrong => problems.push(unknown("HostConfig.PortBindings")),
            Field::Missing => {}
        }
    }

    match array(container.get("Mounts")) {
        Field::Present(mounts) => {
            for mount in mounts {
                let Value::Object(mount) = mount else {
                    problems.push(unknown("Mounts"));
                    continue;
                };
                // 옛 TS와 같이 Type이 정확히 'bind'인 것만 본다(모양이 다른 Type은 'bind'가 아니다)
                if mount.get("Type").and_then(Value::as_str) != Some("bind") {
                    continue;
                }
                match string(mount.get("Source")) {
                    Field::Present("") | Field::Missing => {}
                    Field::Present(source) => {
                        if is_sensitive_host_path(source) {
                            problems.push(format!("호스트 경로 마운트: {source}"));
                        }
                    }
                    Field::Wrong => problems.push(unknown("Mounts.Source")),
                }
            }
        }
        Field::Wrong => problems.push(unknown("Mounts")),
        Field::Missing => {}
    }
    problems
}

/// 거부 목록이므로 모양을 모르는 경로(상대 경로 등)는 걸린 것으로 본다.
/// Docker Desktop은 호스트 폴더를 VM의 `/run/desktop/mnt/host/…`, `/host_mnt/…`로 보여 주므로 그 아래는 호스트 폴더로 읽고,
/// Windows 드라이브 경로(`C:\…`)도 호스트 폴더로 본다
pub fn is_sensitive_host_path(source: &str) -> bool {
    if SOCKET_NAME.is_match(source) {
        return true;
    }
    if WINDOWS_DRIVE.is_match(source) {
        return false;
    }
    if DESKTOP_HOST.is_match(source) && !source.split('/').any(|part| part == "..") {
        return false;
    }
    if !source.starts_with('/') {
        return true;
    }
    let normalized = normalize_absolute_posix(source);
    if normalized == "/" {
        return true;
    }
    SYSTEM_DIRS.iter().any(|dir| {
        normalized == *dir
            || normalized
                .strip_prefix(dir)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// 절대 POSIX 경로에 `path.posix.normalize`를 하고 끝의 `/`를 뗀다(비면 `/`).
/// Rust `Path::components()`는 `..`를 풀지 않아 쓰지 않는다. 역슬래시는 POSIX에서 보통 글자다
fn normalize_absolute_posix(source: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in source.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const OPTIONS: PolicyOptions = PolicyOptions {
        project_name: "sb1",
        sandbox_network: "b-studio-sandbox",
        egress_network: "b-studio-egress",
        edge_service: "b-studio-edge",
        studio_caller: "studio",
    };

    fn service(name: &str) -> Value {
        json!({
            "Id": format!("id-{name}"),
            "Config": { "Labels": { "com.docker.compose.service": name } },
            "HostConfig": { "Privileged": false, "CapAdd": null, "SecurityOpt": null, "PidMode": "", "IpcMode": "private", "NetworkMode": "sb1_b-studio-sandbox", "PortBindings": {} },
            "NetworkSettings": { "Networks": { "sb1_b-studio-sandbox": {} } },
            "Mounts": []
        })
    }

    #[test]
    fn override대로_만든_서비스는_통과한다() {
        assert!(find_violations(&service("api"), &OPTIONS).is_empty());
    }

    #[test]
    fn 권한과_네임스페이스와_네트워크를_순서대로_잡는다() {
        let mut c = service("api");
        c["HostConfig"]["Privileged"] = json!(true);
        c["HostConfig"]["CapAdd"] = json!(["CAP_SYS_ADMIN"]);
        c["HostConfig"]["SecurityOpt"] = json!(["seccomp=UNCONFINED", "label:disable"]);
        c["HostConfig"]["PidMode"] = json!("host");
        c["NetworkSettings"]["Networks"] =
            json!({ "sb1_b-studio-sandbox": {}, "sb1_default": {}, "a": {} });
        c["HostConfig"]["PortBindings"] = json!({ "80/tcp": [{}], "81/tcp": null });
        assert_eq!(
            find_violations(&c, &OPTIONS),
            vec![
                "privileged",
                "cap_add: CAP_SYS_ADMIN",
                "security_opt: seccomp=UNCONFINED",
                "security_opt: label:disable",
                "pid: host",
                "networks: sb1_default, a",
                "ports: 80/tcp"
            ]
        );
    }

    #[test]
    fn 모양이_다른_값은_걸린_것으로_센다_의도한_차이() {
        let mut c = service("api");
        c["HostConfig"]["Privileged"] = json!("true");
        c["HostConfig"]["CapAdd"] = json!("SYS_ADMIN");
        c["HostConfig"]["PortBindings"] = json!({ "80/tcp": "x" });
        c["Mounts"] = json!([{ "Type": "bind", "Source": 1 }, "x"]);
        assert_eq!(
            find_violations(&c, &OPTIONS),
            vec![
                "알 수 없는 형식: HostConfig.Privileged",
                "알 수 없는 형식: HostConfig.CapAdd",
                "알 수 없는 형식: HostConfig.PortBindings.80/tcp",
                "알 수 없는 형식: Mounts.Source",
                "알 수 없는 형식: Mounts"
            ]
        );
        assert_eq!(
            find_violations(&json!([]), &OPTIONS),
            vec!["알 수 없는 형식: container"]
        );
    }

    #[test]
    fn 시스템_폴더와_소켓과_모르는_경로는_걸린다() {
        for source in [
            "/",
            "/proc",
            "/sys/fs",
            "/etc/../etc/passwd",
            "//etc",
            "/etc/./",
            "relative/path",
            "",
            "/tmp/x/podman.sock",
            "/home/x/DOCKER.sock",
            "/x/a\\docker.sock",
            "/run/desktop/mnt/host/../../../etc",
            "/host_mnt/../etc",
        ] {
            assert!(is_sensitive_host_path(source), "{source:?}");
        }
    }

    #[test]
    fn 프로젝트_폴더와_docker_desktop_자리는_걸리지_않는다() {
        for source in [
            "/Users/me/shop",
            "/etcetera",
            "/run/desktop/mnt/host/c/Users",
            "/host_mnt/Users/me",
            "C:\\Users\\me",
            "/etc\\x",
            "/home/a/../b",
        ] {
            assert!(!is_sensitive_host_path(source), "{source:?}");
        }
    }

    #[test]
    fn 유니코드_대소문자_접기로_소켓을_넓게_잡는다_의도한_차이() {
        assert!(is_sensitive_host_path("/run/x/docker.ſock"));
    }
}
