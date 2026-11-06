//! 호스트에 떠 있는 컨테이너 목록을 읽고 분류한다(옛 TS: `packages/sandbox/src/docker/host-containers.ts`).

use crate::js::{self, parse_int};
use crate::js_json::{self, js_less, object, JsValue};
use crate::node_path;
use crate::usage::{container_name, or_default, parse_stats_output, CONTAINER_STATES};

const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL: &str = "com.docker.compose.service";
const COMPOSE_WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";
const COMPOSE_ONEOFF_LABEL: &str = "com.docker.compose.oneoff";
const SANDBOX_LABEL: &str = "b-studio.sandbox";
const DEPLOY_LABEL: &str = "b-studio.deploy";
const HEALTH_STATUSES: [&str; 3] = ["starting", "healthy", "unhealthy"];

/// b-studio 자신이 띄운 샌드박스·운영 배포 스택인지, 아니면 사용자가 직접 띄운 컨테이너인지. 라벨 이름 목록을 받는다
pub fn classify_ownership<S: AsRef<str>>(label_keys: &[S]) -> &'static str {
    let has = |name: &str| label_keys.iter().any(|k| k.as_ref() == name);
    if has(SANDBOX_LABEL) {
        "sandbox"
    } else if has(DEPLOY_LABEL) {
        "deploy"
    } else {
        "user"
    }
}

/// `docker inspect <컨테이너...>` 출력(JSON 배열)을 읽어, 소유자·compose 라벨·포트까지 뽑아낸다
pub fn parse_host_containers(stdout: &str) -> Result<JsValue, String> {
    let text = js::trim(stdout);
    let rows = js_json::parse(if text.is_empty() { "[]" } else { text })?;
    let JsValue::Arr(rows) = rows else { return Err("rows.map is not a function".into()) };
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        if matches!(row, JsValue::Null) {
            return Err("null의 속성을 읽을 수 없습니다".into());
        }
        let labels = or_default(row.prop("Config").and_then(|c| c.prop("Labels")), JsValue::Obj(Default::default()));
        // `LABEL in labels`는 객체가 아닌 값이면 던진다
        let keys: Vec<String> = match &labels {
            JsValue::Obj(o) => o.entries().iter().map(|(k, _)| k.clone()).collect(),
            JsValue::Arr(_) => Vec::new(),
            _ => return Err("라벨이 객체가 아니라 in 연산을 쓸 수 없습니다".into()),
        };
        let label = |name: &str| labels.prop(name);
        let state = row.prop("State");
        let oneoff = matches!(label(COMPOSE_ONEOFF_LABEL), Some(JsValue::Str(s)) if s == "True" || s == "true");
        let status = state.and_then(|s| s.prop("Status"));
        let health = state.and_then(|s| s.prop("Health")).and_then(|h| h.prop("Status"));
        out.push(object(vec![
            ("id", Some(or_default(row.prop("Id"), JsValue::str("")))),
            ("name", Some(JsValue::Str(container_name(row.prop("Name"))?))),
            ("owner", Some(JsValue::str(classify_ownership(&keys)))),
            ("composeProject", label(COMPOSE_PROJECT_LABEL).cloned()),
            ("composeService", label(COMPOSE_SERVICE_LABEL).cloned()),
            ("composeWorkingDir", label(COMPOSE_WORKING_DIR_LABEL).cloned()),
            ("oneOff", Some(JsValue::Bool(oneoff))),
            ("state", Some(match status {
                Some(JsValue::Str(s)) if CONTAINER_STATES.contains(&s.as_str()) => JsValue::Str(s.clone()),
                _ => JsValue::str("unknown"),
            })),
            ("health", match health {
                Some(JsValue::Str(s)) if HEALTH_STATUSES.contains(&s.as_str()) => Some(JsValue::Str(s.clone())),
                _ => None,
            }),
            ("ports", Some(parse_ports(row.prop("NetworkSettings").and_then(|n| n.prop("Ports")))?)),
            ("labels", Some(labels.clone())),
        ]));
    }
    Ok(JsValue::Arr(out))
}

/// `Object.entries(ports)`
fn port_entries(ports: &JsValue) -> Result<Vec<(String, &JsValue)>, String> {
    match ports {
        JsValue::Obj(o) => Ok(o.entries_js_order().into_iter().map(|(k, v)| (k.to_owned(), v)).collect()),
        JsValue::Arr(items) => Ok(items.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect()),
        // 문자열의 글자마다 `bindings.find`를 부르다 던진다
        JsValue::Str(_) => Err("bindings.find is not a function".into()),
        _ => Ok(Vec::new()),
    }
}

fn parse_ports(ports: Option<&JsValue>) -> Result<JsValue, String> {
    let Some(ports) = ports.filter(|p| p.truthy()) else { return Ok(JsValue::Arr(Vec::new())) };
    let mut result = Vec::new();
    for (key, bindings) in port_entries(ports)? {
        let mut parts = key.split('/');
        let port_text = parts.next().unwrap_or("");
        let protocol = parts.next().unwrap_or("tcp");
        let container_port = parse_int(port_text);
        if !container_port.is_finite() {
            continue;
        }
        let list: &[JsValue] = match bindings {
            b if !b.truthy() => &[],
            JsValue::Arr(items) => items,
            _ => return Err("bindings.find is not a function".into()),
        };
        if list.is_empty() {
            result.push(object(vec![("containerPort", Some(JsValue::Num(container_port))), ("protocol", Some(JsValue::str(protocol)))]));
            continue;
        }
        // IPv4(0.0.0.0)와 IPv6(::)에 같은 포트가 중복으로 잡히므로 IPv4 바인딩을 대표로 하나만 남긴다
        let mut chosen = None;
        for binding in list {
            if matches!(binding, JsValue::Null) {
                return Err("null의 속성을 읽을 수 없습니다".into());
            }
            if !matches!(binding.prop("HostIp"), Some(JsValue::Str(s)) if s == "::") {
                chosen = Some(binding);
                break;
            }
        }
        let ipv4 = chosen.unwrap_or(&list[0]);
        if matches!(ipv4, JsValue::Null) {
            return Err("null의 속성을 읽을 수 없습니다".into());
        }
        let host_port = ipv4.prop("HostPort").filter(|v| v.truthy()).map(|v| JsValue::Num(parse_int(&v.to_js_string())));
        result.push(object(vec![
            ("containerPort", Some(JsValue::Num(container_port))),
            ("protocol", Some(JsValue::str(protocol))),
            ("hostIp", ipv4.prop("HostIp").cloned()),
            ("hostPort", host_port),
        ]));
    }
    Ok(JsValue::Arr(result))
}

/// compose working_dir 라벨이 프로젝트 원본 폴더이거나 그 하위 폴더를 가리키는지 본다. `cwd`는 `path.resolve`가 쓰는 프로세스의 현재 폴더
pub fn matches_project_root(working_dir: Option<&str>, project_root: &str, cwd: &str) -> bool {
    let Some(working_dir) = working_dir.filter(|w| !w.is_empty()) else { return false };
    let a = node_path::resolve(cwd, &[working_dir]);
    let b = node_path::resolve(cwd, &[project_root]);
    let prefix = if b.ends_with('/') { b.clone() } else { format!("{b}/") };
    a == b || a.starts_with(&prefix)
}

/// 전체 컨테이너 목록에서 "사용자가 이 프로젝트 폴더에서 docker compose up으로 직접 띄운" 컨테이너만 골라 compose 프로젝트 단위로 묶는다.
/// 묶음은 `{project, workingDir, matchReason, services: [입력의 인덱스]}`로 돌려준다(부르는 쪽이 원래 객체를 그대로 끼운다)
pub fn discover_user_containers(containers: &JsValue, project_root: &str, cwd: &str) -> Result<JsValue, String> {
    let JsValue::Arr(containers) = containers else { return Err("containers는 배열이어야 합니다".into()) };
    // (project, workingDir, matchReason, 인덱스들). `Map`의 키는 SameValueZero라 같은 값끼리만 한 묶음이다
    let mut groups: Vec<(JsValue, JsValue, String, Vec<usize>)> = Vec::new();
    for (index, container) in containers.iter().enumerate() {
        if matches!(container, JsValue::Null) {
            return Err("null의 속성을 읽을 수 없습니다".into());
        }
        if !matches!(container.prop("owner"), Some(JsValue::Str(s)) if s == "user") {
            // `container.owner !== 'user'`
            continue;
        }
        if container.prop("oneOff").is_some_and(JsValue::truthy) {
            continue;
        }
        let project = container.prop("composeProject").filter(|p| p.truthy());
        let working_dir = container.prop("composeWorkingDir");
        let Some(project) = project else { continue };
        // matchesProjectRoot는 문자열 경로를 받는다. 문자열이 아닌 값은 `path.resolve`가 던진다
        let dir_text = match working_dir {
            None | Some(JsValue::Null) => None,
            Some(JsValue::Str(s)) => Some(s.as_str()),
            Some(v) if !v.truthy() => None,
            Some(_) => return Err("path 인자는 문자열이어야 합니다".into()),
        };
        if !matches_project_root(dir_text, project_root, cwd) {
            continue;
        }
        let same = |a: &JsValue, b: &JsValue| match (a, b) {
            (JsValue::Num(x), JsValue::Num(y)) => js::same_value_zero(*x, *y),
            _ => a.strict_equals(b),
        };
        if let Some(group) = groups.iter_mut().find(|g| same(&g.0, project)) {
            group.3.push(index);
        } else {
            let dir = working_dir.expect("working_dir가 있어야 일치한다").clone();
            let reason = format!("com.docker.compose.project.working_dir=\"{}\" (프로젝트 폴더와 일치)", dir.to_js_string());
            groups.push((project.clone(), dir, reason, vec![index]));
        }
    }
    let sorted = js::stable_sort_by(groups, &|a, b| if js_less(&a.0, &b.0) { -1.0 } else { 1.0 });
    Ok(JsValue::Arr(
        sorted
            .into_iter()
            .map(|(project, dir, reason, indexes)| {
                object(vec![
                    ("project", Some(project)),
                    ("workingDir", Some(dir)),
                    ("matchReason", Some(JsValue::Str(reason))),
                    ("services", Some(JsValue::Arr(indexes.into_iter().map(|i| JsValue::Num(i as f64)).collect()))),
                ])
            })
            .collect(),
    ))
}

/// `docker stats` 출력을 컨테이너 이름으로 맞춰 CPU·메모리를 붙일 값을 컨테이너마다 하나씩 돌려준다(죽은 컨테이너는 `null`)
pub fn merge_host_container_stats(names: &[JsValue], stats_stdout: &str) -> Result<JsValue, String> {
    let stats = parse_stats_output(stats_stdout)?;
    Ok(JsValue::Arr(
        names
            .iter()
            .map(|name| match stats.iter().find(|row| row.name.strict_equals(name)) {
                Some(live) => object(vec![("cpuPercent", Some(JsValue::Num(live.cpu_percent))), ("memoryBytes", live.memory_bytes.map(JsValue::Num))]),
                None => JsValue::Null,
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 라벨로_소유자를_가른다() {
        assert_eq!(classify_ownership(&["b-studio.sandbox"]), "sandbox");
        assert_eq!(classify_ownership(&["x", "b-studio.deploy"]), "deploy");
        assert_eq!(classify_ownership(&["b-studio.deploy", "b-studio.sandbox"]), "sandbox");
        assert_eq!(classify_ownership::<&str>(&[]), "user");
    }

    #[test]
    fn 포트는_정수_꼴_키가_먼저_온다() {
        let out = parse_host_containers(r#"[{"NetworkSettings":{"Ports":{"80/tcp":null,"8080":[{"HostIp":"0.0.0.0","HostPort":"9090"}],"x/tcp":null,"53/udp":[]}}}]"#).unwrap();
        let JsValue::Arr(rows) = out else { panic!() };
        let JsValue::Arr(ports) = rows[0].prop("ports").unwrap() else { panic!() };
        let ints: Vec<f64> = ports.iter().map(|p| match p.prop("containerPort") { Some(JsValue::Num(n)) => *n, _ => panic!() }).collect();
        assert_eq!(ints, vec![8080.0, 80.0, 53.0]);
        assert_eq!(ports[0].prop("hostPort"), Some(&JsValue::Num(9090.0)));
        assert_eq!(ports[1].prop("protocol"), Some(&JsValue::str("tcp")));
    }

    #[test]
    fn ipv4_바인딩을_대표로_고른다() {
        let out = parse_host_containers(r#"[{"NetworkSettings":{"Ports":{"80/tcp":[{"HostIp":"::","HostPort":"1"},{"HostIp":"0.0.0.0","HostPort":"2"}],"81/tcp":[{"HostIp":"::","HostPort":"3"}]}}}]"#).unwrap();
        let JsValue::Arr(rows) = out else { panic!() };
        let JsValue::Arr(ports) = rows[0].prop("ports").unwrap() else { panic!() };
        assert_eq!(ports[0].prop("hostPort"), Some(&JsValue::Num(2.0)));
        assert_eq!(ports[1].prop("hostPort"), Some(&JsValue::Num(3.0)));
    }

    #[test]
    fn 프로젝트_폴더_일치는_경계를_본다() {
        assert!(matches_project_root(Some("/a/b"), "/a/b", "/"));
        assert!(matches_project_root(Some("/a/b/c"), "/a/b/", "/"));
        assert!(!matches_project_root(Some("/a/bc"), "/a/b", "/"));
        assert!(matches_project_root(Some("/anything"), "/", "/"));
        assert!(!matches_project_root(None, "/a", "/"));
        assert!(!matches_project_root(Some(""), "/a", "/"));
        assert!(matches_project_root(Some("rel/x"), "/cwd/rel", "/cwd"));
    }

    #[test]
    fn 사용자_컨테이너만_프로젝트별로_묶고_이름순으로_낸다() {
        let containers = js_json::parse(
            r#"[
              {"owner":"user","oneOff":false,"composeProject":"z","composeWorkingDir":"/p/a"},
              {"owner":"sandbox","composeProject":"s","composeWorkingDir":"/p"},
              {"owner":"user","oneOff":true,"composeProject":"o","composeWorkingDir":"/p"},
              {"owner":"user","oneOff":false,"composeProject":"m","composeWorkingDir":"/q"},
              {"owner":"user","oneOff":false,"composeProject":"a","composeWorkingDir":"/p"},
              {"owner":"user","oneOff":false,"composeProject":"z","composeWorkingDir":"/p/b"}
            ]"#,
        )
        .unwrap();
        let out = discover_user_containers(&containers, "/p", "/").unwrap();
        let JsValue::Arr(groups) = out else { panic!() };
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].prop("project"), Some(&JsValue::str("a")));
        assert_eq!(groups[1].prop("services"), Some(&JsValue::Arr(vec![JsValue::Num(0.0), JsValue::Num(5.0)])));
        assert_eq!(groups[1].prop("workingDir"), Some(&JsValue::str("/p/a")));
        assert_eq!(groups[0].prop("none"), None);
    }
}
