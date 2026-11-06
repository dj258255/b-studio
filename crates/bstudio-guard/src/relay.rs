//! 파일 변경을 서비스 컨테이너의 파일 감시기에 알리는 계획(ADR-191 2단계 2b-2b 첫 묶음, #1026).
//!
//! 호스트에서 바뀐 파일은 바인드 마운트를 거쳐 컨테이너에 보이지만, 컨테이너 커널을 거치지 않아 감시기(inotify)에 알림이 가지 않는다.
//! 바뀐 경로마다 어느 서비스 컨테이너의 어느 경로에서 새 폴더를 옮기거나(`move`) 부모 목록을 다시 읽게 할지(`nudge`) 정한다.
//! 컨테이너 안에서 실제로 옮기는 스크립트(`RELAY_SCRIPT`)와 실행은 TS(`relay.ts`, `compose-provider.ts`)에 있다.
//!
//! 경로 규칙은 옛 TS와 같게 `node_path`(Node `path.posix`)를 쓴다. 의도한 차이:
//! - 바뀐 경로를 정렬할 때 옛 TS는 `localeCompare`(ICU 정렬)를 썼다. 그대로 옮길 수 없어 UTF-16 코드 단위 순서로 정렬한다.
//!   무엇을 어디에 알리는지는 같고, 서비스·알림·파일의 나열 순서만 바뀔 수 있다
//! - 모양이 어긋난 compose 설정(문자열이 아닌 bind 마운트의 source·target, 객체가 아닌 서비스)은 던진다. 옛 TS는 일부를 그대로 넘겼다가
//!   나중에 던지거나 이상한 경로를 만들었다
//! - `servicePaths`는 자기 키만 본다. 옛 TS는 `servicePaths[service]`로 읽어 `constructor` 같은 이름이면 프로토타입의 함수를 읽고 던졌다

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{js, node_path};

/// 서비스 하나의 바인드 마운트. 필드 순서는 옛 TS 객체와 같다
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct BindMount {
    pub service: String,
    pub managed: bool,
    /// 호스트 절대 경로
    pub source: String,
    /// 컨테이너 안 절대 경로
    pub target: String,
    /// 이 서비스가 실제로 일하는 하위 폴더(호스트 절대 경로). 여러 서비스가 같은 루트를 마운트할 때 더 좁은 서비스를 가린다(ADR-088)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subroot: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileChange {
    pub file: String,
    /// `directory`·`file`·`deleted`
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RelayTarget {
    /// `move`(새 폴더를 옮겼다 되돌림) 또는 `nudge`(부모 목록을 다시 읽게 함)
    pub action: &'static str,
    /// 컨테이너 안 절대 경로
    #[serde(rename = "containerPath")]
    pub container_path: String,
    /// 이 알림으로 전하는 프로젝트 기준 경로
    pub files: Vec<String>,
}

/// JS의 참 같은 값(`if (value)`)
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `docker compose config --format json`의 서비스들(JS `Object.entries` 순서의 [이름, 서비스] 목록)에서 바인드 마운트만 모은다.
/// `service_paths`(서비스 이름 → 프로젝트 루트 기준 상대 경로, `Object.entries` 순서)를 주면 subroot를 함께 계산한다
pub fn bind_mounts(cwd: &str, services: &[(String, Value)], managed: &[String], service_paths: &[(String, String)]) -> Result<Vec<BindMount>, String> {
    let mut mounts = Vec::new();
    for (service, spec) in services {
        let Value::Object(spec) = spec else {
            return Err(format!("compose 설정의 서비스 '{service}'가 객체가 아닙니다"));
        };
        let volumes = match spec.get("volumes") {
            None | Some(Value::Null) => continue,
            Some(Value::Array(volumes)) => volumes,
            Some(_) => return Err(format!("compose 설정의 서비스 '{service}'의 volumes가 배열이 아닙니다")),
        };
        for volume in volumes {
            let volume = match volume {
                Value::Null => return Err(format!("compose 설정의 서비스 '{service}'에 null 마운트가 있습니다")),
                // 객체가 아닌 값은 type이 없으므로 bind가 아니다(옛 TS와 같다)
                Value::Object(volume) => volume,
                _ => continue,
            };
            if volume.get("type") != Some(&Value::String("bind".into())) {
                continue;
            }
            let source = match volume.get("source") {
                Some(value) if truthy(value) => value,
                _ => continue,
            };
            let (Value::String(source), Some(Value::String(target))) = (source, volume.get("target")) else {
                return Err(format!("compose 설정의 서비스 '{service}'의 bind 마운트에 source·target 문자열이 없습니다"));
            };
            let source = node_path::resolve(cwd, &[source]);
            // Object.fromEntries는 같은 키가 다시 나오면 뒤의 값을 쓴다
            let subroot = service_paths
                .iter()
                .rev()
                .find(|(name, _)| name == service)
                .map(|(_, path)| if path == "." { source.clone() } else { node_path::resolve(cwd, &[&source, path]) });
            mounts.push(BindMount { service: service.clone(), managed: managed.contains(service), source, target: target.clone(), subroot });
        }
    }
    Ok(mounts)
}

struct Entry {
    file: String,
    kind: String,
    absolute: String,
}

/// subroot가 target을 실제로 감싸면 그 길이(더 좁을수록 큰 점수), 아니면 -1
fn subroot_score(cwd: &str, mount: &BindMount, target: &str) -> i64 {
    match &mount.subroot {
        Some(subroot) if node_path::is_inside(cwd, subroot, target) => js::utf16_len(subroot) as i64,
        _ => -1,
    }
}

/// 바뀐 경로를 서비스별 알림으로 바꾼다. 결과는 서비스가 처음 나온 순서의 [서비스, 알림 목록]이다.
/// - 새 폴더는 옮긴다. 마운트 폴더 자체나 그 상위는 옮기면 서비스의 마운트가 흔들리므로 옮기지 않고 부모 목록만 다시 읽게 한다
/// - 옮기는 새 폴더 안의 경로와, 지운 폴더 안의 경로는 따로 알리지 않는다
/// - 새 파일과 지운 경로는 부모 폴더 하나에 한 번만 알린다
/// - 여러 서비스가 마운트하면 managed 서비스, 그다음 subroot가 더 좁은 서비스, 그다음 더 좁게 마운트한 서비스의 컨테이너에서 알린다
/// - 프로젝트 폴더 밖이나 프로젝트 폴더 자체를 가리키는 경로, 어느 마운트에도 들지 않는 경로는 알리지 않는다
pub fn plan_relay(cwd: &str, project_root: &str, changes: &[FileChange], mounts: &[BindMount]) -> Vec<(String, Vec<RelayTarget>)> {
    let root = node_path::resolve(cwd, &[project_root]);
    // 같은 경로가 여러 번 오면 마지막 종류를 쓰고, 자리는 처음 것을 지킨다(JS Map)
    let mut latest: Vec<(String, String)> = Vec::new();
    for change in changes {
        let file = change.file.trim_end_matches('/');
        if file.is_empty() {
            continue;
        }
        match latest.iter_mut().find(|(seen, _)| seen == file) {
            Some(slot) => slot.1 = change.kind.clone(),
            None => latest.push((file.to_owned(), change.kind.clone())),
        }
    }
    let mut entries: Vec<Entry> = latest
        .into_iter()
        .map(|(file, kind)| {
            let absolute = node_path::resolve(cwd, &[&root, &file]);
            Entry { file, kind, absolute }
        })
        .filter(|entry| node_path::is_inside(cwd, &root, &entry.absolute) && entry.absolute != root)
        .collect();
    // 의도한 차이: 옛 TS의 localeCompare 대신 UTF-16 순서(안정 정렬)
    entries.sort_by(|a, b| js::cmp_utf16(&a.file, &b.file));

    let moved: Vec<usize> = (0..entries.len())
        .filter(|&i| entries[i].kind == "directory" && !mounts.iter().any(|mount| node_path::is_inside(cwd, &entries[i].absolute, &mount.source)))
        .collect();
    let deleted: Vec<usize> = (0..entries.len()).filter(|&i| entries[i].kind == "deleted").collect();

    let mut plan: Vec<(String, Vec<RelayTarget>)> = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        if moved.iter().any(|&j| j != i && node_path::is_inside(cwd, &entries[j].absolute, &entry.absolute)) {
            continue;
        }
        if entry.kind == "deleted" && deleted.iter().any(|&j| j != i && node_path::is_inside(cwd, &entries[j].absolute, &entry.absolute)) {
            continue;
        }

        let action = if moved.contains(&i) { "move" } else { "nudge" };
        let target = if action == "move" { entry.absolute.clone() } else { node_path::dirname(&entry.absolute) };
        let mut candidates: Vec<&BindMount> = mounts.iter().filter(|mount| node_path::is_inside(cwd, &mount.source, &target)).collect();
        // 옛 TS의 비교 함수와 같은 순서(Array.prototype.sort도 Vec::sort_by도 안정 정렬이다)
        candidates.sort_by(|a, b| {
            b.managed
                .cmp(&a.managed)
                .then_with(|| subroot_score(cwd, b, &target).cmp(&subroot_score(cwd, a, &target)))
                .then_with(|| js::utf16_len(&b.source).cmp(&js::utf16_len(&a.source)))
        });
        let Some(mount) = candidates.first() else {
            continue;
        };

        let container_path = node_path::join(&[&mount.target, &node_path::relative(cwd, &mount.source, &target)]);
        let index = match plan.iter().position(|(service, _)| service == &mount.service) {
            Some(index) => index,
            None => {
                plan.push((mount.service.clone(), Vec::new()));
                plan.len() - 1
            }
        };
        let targets = &mut plan[index].1;
        match targets.iter_mut().find(|candidate| candidate.action == action && candidate.container_path == container_path) {
            Some(existing) => existing.files.push(entry.file.clone()),
            None => targets.push(RelayTarget { action, container_path, files: vec![entry.file.clone()] }),
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CWD: &str = "/work";

    fn mount(service: &str, managed: bool, source: &str, target: &str, subroot: Option<&str>) -> BindMount {
        BindMount { service: service.into(), managed, source: source.into(), target: target.into(), subroot: subroot.map(Into::into) }
    }

    fn change(file: &str, kind: &str) -> FileChange {
        FileChange { file: file.into(), kind: kind.into() }
    }

    fn plan_json(changes: &[FileChange], mounts: &[BindMount]) -> Value {
        serde_json::to_value(plan_relay(CWD, "/p", changes, mounts)).unwrap()
    }

    #[test]
    fn 바인드_마운트만_모으고_상대_경로는_cwd로_푼다() {
        let services = vec![
            ("web".to_owned(), json!({ "volumes": [{ "type": "bind", "source": "./p", "target": "/app" }, { "type": "volume", "source": "cache", "target": "/c" }, { "type": "bind", "source": "", "target": "/x" }, 5] })),
            ("db".to_owned(), json!({})),
            ("api".to_owned(), json!({ "volumes": [{ "type": "bind", "source": "/p", "target": "/srv" }] })),
        ];
        let mounts = bind_mounts(CWD, &services, &["web".into()], &[("web".into(), ".".into()), ("api".into(), "api".into())]).unwrap();
        assert_eq!(mounts, vec![mount("web", true, "/work/p", "/app", Some("/work/p")), mount("api", false, "/p", "/srv", Some("/p/api"))]);
    }

    #[test]
    fn 모양이_어긋난_compose_설정은_던진다() {
        for spec in [json!(null), json!({ "volumes": "x" }), json!({ "volumes": [null] }), json!({ "volumes": [{ "type": "bind", "source": 5, "target": "/a" }] }), json!({ "volumes": [{ "type": "bind", "source": "/a" }] })] {
            assert!(bind_mounts(CWD, &[("web".into(), spec.clone())], &[], &[]).is_err(), "{spec}");
        }
    }

    #[test]
    fn service_paths는_자기_키만_본다() {
        // 옛 TS는 servicePaths['constructor']로 프로토타입의 함수를 읽고 path.resolve에서 던졌다(의도한 차이)
        let services = vec![("constructor".to_owned(), json!({ "volumes": [{ "type": "bind", "source": "/p", "target": "/app" }] }))];
        assert_eq!(bind_mounts(CWD, &services, &[], &[]).unwrap(), vec![mount("constructor", false, "/p", "/app", None)]);
    }

    #[test]
    fn 새_폴더는_옮기고_안의_경로는_따로_알리지_않는다() {
        let mounts = [mount("web", true, "/p", "/app", None)];
        let got = plan_json(&[change("src/new", "directory"), change("src/new/a.ts", "file"), change("src/b.ts", "file")], &mounts);
        assert_eq!(got, json!([["web", [{ "action": "nudge", "containerPath": "/app/src", "files": ["src/b.ts"] }, { "action": "move", "containerPath": "/app/src/new", "files": ["src/new"] }]]]));
    }

    #[test]
    fn 마운트_폴더나_그_상위는_옮기지_않고_부모만_다시_읽게_한다() {
        let mounts = [mount("web", true, "/p/web", "/app", None), mount("root", false, "/p", "/r", None)];
        let got = plan_json(&[change("web", "directory")], &mounts);
        assert_eq!(got, json!([["root", [{ "action": "nudge", "containerPath": "/r", "files": ["web"] }]]]));
    }

    #[test]
    fn 지운_폴더_안의_경로는_한_번만_알린다() {
        let mounts = [mount("web", true, "/p", "/app", None)];
        let got = plan_json(&[change("old", "deleted"), change("old/a", "deleted"), change("x/y", "deleted")], &mounts);
        assert_eq!(got, json!([["web", [{ "action": "nudge", "containerPath": "/app", "files": ["old"] }, { "action": "nudge", "containerPath": "/app/x", "files": ["x/y"] }]]]));
    }

    #[test]
    fn 프로젝트_밖이나_프로젝트_자체는_알리지_않는다() {
        let mounts = [mount("web", true, "/", "/host", None)];
        assert_eq!(plan_json(&[change("../etc/passwd", "file"), change(".", "directory"), change("/etc/x", "file"), change("///", "file")], &mounts), json!([]));
        // `..`로 시작하는 이름은 프로젝트 안이다
        assert_eq!(plan_json(&[change("..proj/a", "file")], &mounts), json!([["web", [{ "action": "nudge", "containerPath": "/host/p/..proj", "files": ["..proj/a"] }]]]));
    }

    #[test]
    fn managed_그다음_subroot_그다음_좁은_마운트에서_알린다() {
        let mounts = [
            mount("db", false, "/p/api/data", "/data", None),
            mount("web", true, "/p", "/app", Some("/p/web")),
            mount("api", true, "/p", "/app", Some("/p/api")),
        ];
        let got = plan_json(&[change("api/data/x", "file"), change("web/a", "file"), change("docs/r.md", "file")], &mounts);
        assert_eq!(
            got,
            json!([
                ["api", [{ "action": "nudge", "containerPath": "/app/api/data", "files": ["api/data/x"] }]],
                ["web", [{ "action": "nudge", "containerPath": "/app/docs", "files": ["docs/r.md"] }, { "action": "nudge", "containerPath": "/app/web", "files": ["web/a"] }]]
            ])
        );
    }

    #[test]
    fn 같은_경로는_마지막_종류를_쓰고_끝의_빗금은_뗀다() {
        let mounts = [mount("web", true, "/p", "/app", None)];
        let got = plan_json(&[change("n/", "file"), change("n///", "directory")], &mounts);
        assert_eq!(got, json!([["web", [{ "action": "move", "containerPath": "/app/n", "files": ["n"] }]]]));
    }

    #[test]
    fn 정렬은_utf16_순서다() {
        // 의도한 차이: 옛 TS의 localeCompare는 "B"보다 "a"를 앞에 둔다
        let mounts = [mount("web", true, "/p", "/app", None)];
        let got = plan_json(&[change("a/x", "file"), change("B/x", "file")], &mounts);
        assert_eq!(got[0][1][0]["files"], json!(["B/x"]));
    }
}
