//! 만든 컨테이너를 시작하기 전에 확인하는 단계(`LocalDockerProvider.#verifyMasks`·`#waitForDependency`, ADR-195 4f A4b)의 판정 부분.
//! docker를 부르는 순서(목록 → inspect → volume inspect → 판정 → 지우기)는 `bstudio-io`의 `container_verify`가 하고, 여기는 그 출력을
//! 읽고 판정만 한다. 파일 시스템도 읽지 않는다(링크를 푼 경로는 부르는 쪽이 준다).
//!
//! 막는 검사다. 아래는 모두 **통과가 아니라 실패**로 읽는다.
//!  - `inspect` 출력을 해석하지 못함, 배열이 아님, 목록의 id가 일부 빠짐, id가 없는 항목
//!  - `volume inspect` 출력을 해석하지 못함, 물어본 볼륨이 일부 빠짐, 이름이 없는 항목
//!  - 컨테이너의 `Mounts`·`HostConfig.Tmpfs` 모양을 모름(그 컨테이너는 가림이 빠진 것으로 센다)
//!
//! 막는 쪽/여는 쪽: 이 모듈의 함수는 모두 **막는 쪽**이다. 모르는 입력은 확인하지 못한 것(실패)으로 돌려준다.
//! 옛 TS와 다른 점(모두 더 막는 쪽, 시험으로 고정): ① `.git` 자리에도 같은 target의 마운트가 여럿이면 실패 ② `.git`을 찾을 호스트 마운트를
//! 고를 때 Docker Desktop 접두어(`/host_mnt/…`)를 뗀 경로도 함께 본다 ③ `Mounts`·`Tmpfs`의 모양을 모르면 던지지 않고 그 컨테이너를 실패로 센다.

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use crate::git_mask::{bound_device, docker_desktop_host_path, is_inside_posix};

/// `docker inspect`의 `Mounts` 한 항목
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedMount {
    pub kind: String,
    pub name: Option<String>,
    pub source: Option<String>,
    pub destination: String,
    /// `RW`. `false`가 아니면(없거나 다른 형이면) 쓰기 가능으로 본다
    pub rw: Option<bool>,
}

fn unknown(what: &str) -> String {
    format!("알 수 없는 형식: {what}")
}

fn optional_string(map: &Map<String, Value>, key: &str, what: &str) -> Result<Option<String>, String> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(unknown(what)),
    }
}

/// 컨테이너의 `Mounts`. 없거나 `null`이면 빈 목록, 모양이 다르면 오류(그 컨테이너는 확인하지 못한 것)
pub fn parse_mounts(container: &Value) -> Result<Vec<InspectedMount>, String> {
    let items = match container.get("Mounts") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(unknown("Mounts")),
    };
    items
        .iter()
        .map(|item| {
            let Value::Object(map) = item else { return Err(unknown("Mounts[]")) };
            let Some(Value::String(destination)) = map.get("Destination") else { return Err(unknown("Mounts[].Destination")) };
            Ok(InspectedMount {
                kind: optional_string(map, "Type", "Mounts[].Type")?.unwrap_or_default(),
                name: optional_string(map, "Name", "Mounts[].Name")?,
                source: optional_string(map, "Source", "Mounts[].Source")?,
                destination: destination.clone(),
                rw: map.get("RW").and_then(Value::as_bool),
            })
        })
        .collect()
}

/// `HostConfig.Tmpfs`의 컨테이너 안 경로들(`Mounts`에는 나오지 않는다). 없거나 `null`이면 빈 목록, 모양이 다르면 오류
pub fn parse_tmpfs(container: &Value) -> Result<Vec<String>, String> {
    match container.get("HostConfig") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Object(_)) => {}
        Some(_) => return Err(unknown("HostConfig")),
    }
    match container.pointer("/HostConfig/Tmpfs") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Object(map)) => Ok(map.keys().cloned().collect()),
        Some(_) => Err(unknown("HostConfig.Tmpfs")),
    }
}

/// `compose ps --all --quiet --no-trunc`의 id 목록
pub fn parse_ids(stdout: &str) -> Vec<String> {
    stdout.split('\n').map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectProblem {
    /// JSON이 아님
    Unparsed,
    /// 배열이 아니거나, 목록의 id가 일부 빠졌거나, `Id`가 문자열이 아닌 항목이 있음
    Partial,
}

/// `docker inspect <ids>`의 출력을 읽고 목록의 컨테이너를 빠짐없이 봤는지 맞춘다. 일부만 돌아오면 나머지는 확인하지 않은 채 지나간다
pub fn parse_inspect(stdout: &str, ids: &[String]) -> Result<Vec<Value>, InspectProblem> {
    let parsed: Value = serde_json::from_str(stdout).map_err(|_| InspectProblem::Unparsed)?;
    let Value::Array(items) = parsed else { return Err(InspectProblem::Partial) };
    let mut seen = HashSet::new();
    for item in &items {
        // 지울 때 쓰는 id는 이 값이다. 문자열이 아닌 항목은 확인도 지우기도 할 수 없다
        match item.get("Id") {
            Some(Value::String(id)) => {
                seen.insert(id.as_str());
            }
            _ => return Err(InspectProblem::Partial),
        }
    }
    if ids.iter().any(|id| !seen.contains(id.as_str())) {
        return Err(InspectProblem::Partial);
    }
    Ok(items)
}

/// 컨테이너들이 쓰는 이름 있는 볼륨(처음 나온 순서, 겹치지 않게). `Mounts` 모양이 다른 컨테이너는 여기서 건너뛴다(그 컨테이너는 판정에서 실패가 된다)
pub fn volume_names(containers: &[Value]) -> Vec<String> {
    let mut names = Vec::new();
    for container in containers {
        for mount in parse_mounts(container).unwrap_or_default() {
            if mount.kind == "volume" {
                if let Some(name) = mount.name.filter(|name| !name.is_empty()) {
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
    }
    names
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VolumeProblem {
    /// JSON이 아니거나 배열이 아니거나, 이름이 없는 항목이 있음
    Unparsed,
    /// 물어본 볼륨 일부가 답에 없다(그 마운트가 호스트 폴더에 묶였는지 알 수 없다)
    Partial(Vec<String>),
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `docker volume inspect <names>`의 출력. 볼륨 이름 → `{ driver?, driver_opts }`(compose 설정과 같은 꼴, `bound_device`가 읽는다)
pub fn parse_volumes(stdout: &str, names: &[String]) -> Result<HashMap<String, Value>, VolumeProblem> {
    let parsed: Value = serde_json::from_str(stdout).map_err(|_| VolumeProblem::Unparsed)?;
    let Value::Array(items) = parsed else { return Err(VolumeProblem::Unparsed) };
    let mut options = HashMap::new();
    for item in &items {
        let Some(Value::String(name)) = item.get("Name") else { return Err(VolumeProblem::Unparsed) };
        let mut entry = Map::new();
        if let Some(driver) = item.get("Driver").filter(|driver| truthy(driver)) {
            entry.insert("driver".to_owned(), driver.clone());
        }
        let driver_opts = match item.get("Options") {
            None | Some(Value::Null) => Value::Object(Map::new()),
            Some(other) => other.clone(),
        };
        entry.insert("driver_opts".to_owned(), driver_opts);
        options.insert(name.clone(), Value::Object(entry));
    }
    let unknown: Vec<String> = names.iter().filter(|name| !options.contains_key(*name)).cloned().collect();
    if unknown.is_empty() { Ok(options) } else { Err(VolumeProblem::Partial(unknown)) }
}

/// 마운트가 가리키는 호스트 경로(bind의 `Source`, 호스트 폴더에 묶인 이름 있는 볼륨의 `device`). 그 밖의 마운트는 없다.
/// 볼륨 옵션의 모양을 모르면 오류(없는 것으로 보면 그 마운트의 `.git`을 막지 않게 된다)
pub fn host_source(mount: &InspectedMount, volumes: &HashMap<String, Value>) -> Result<Option<String>, String> {
    match mount.kind.as_str() {
        "bind" => Ok(mount.source.clone()),
        "volume" => match &mount.name {
            Some(name) if !name.is_empty() => bound_device(volumes.get(name)),
            _ => Ok(None),
        },
        _ => Ok(None),
    }
}

/// 평가 자산 자리 하나의 확인 가운데 **파일 시스템을 읽지 않고** 알 수 있는 부분
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetSlot {
    /// 그 자리(target)에 마운트가 하나뿐인가
    pub single: bool,
    /// 그 마운트의 `RW`가 `false`인가
    pub read_only: bool,
    /// 그 마운트의 호스트 원본. Docker Desktop이 붙인 접두어만 뗐고, 모르는 꼴이면 `None`
    pub source: Option<String>,
    /// 그 자리 안쪽에 다른 `Mounts` 항목이 있는가
    pub nested: bool,
    /// `HostConfig.Tmpfs`가 그 자리를 덮는가
    pub overwritten: bool,
}

impl AssetSlot {
    /// 링크를 푼 원본이 계획한 복사본과 같은지(`source_matches`)까지 더해 통과인지. 하나라도 어긋나면 실패다
    pub fn ok(&self, source_matches: bool) -> bool {
        self.single && self.read_only && self.source.is_some() && source_matches && !self.nested && !self.overwritten
    }
}

pub fn asset_slot(mounts: &[InspectedMount], tmpfs: &[String], volumes: &HashMap<String, Value>, target: &str) -> Result<AssetSlot, String> {
    let actuals: Vec<&InspectedMount> = mounts.iter().filter(|mount| mount.destination == target).collect();
    let (read_only, source) = match actuals.first() {
        Some(actual) => (actual.rw == Some(false), host_source(actual, volumes)?.and_then(|raw| docker_desktop_host_path(&raw))),
        None => (false, None),
    };
    Ok(AssetSlot {
        single: actuals.len() == 1,
        read_only,
        source,
        nested: mounts.iter().any(|mount| mount.destination != target && is_inside_posix(target, &mount.destination)),
        overwritten: tmpfs.iter().any(|path| is_inside_posix(target, path)),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyDecision {
    Ready,
    Wait,
    Failed(String),
}

/// `docker inspect --format '{{json .State}}'`의 줄들. 객체가 아닌 줄이 있으면 `None`(읽은 것으로 세지 않는다)
pub fn parse_states(stdout: &str) -> Option<Vec<Value>> {
    let mut states = Vec::new();
    for line in stdout.split('\n').filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<Value>(line) {
            Ok(state @ Value::Object(_)) => states.push(state),
            _ => return None,
        }
    }
    Some(states)
}

fn status(state: &Value) -> Option<&str> {
    state.get("Status").and_then(Value::as_str)
}

fn health_status(state: &Value) -> Option<&str> {
    state.get("Health").and_then(|health| health.get("Status")).and_then(Value::as_str)
}

fn has_health(state: &Value) -> bool {
    state.get("Health").is_some_and(truthy)
}

fn exited_ok(state: &Value) -> bool {
    status(state) == Some("exited") && state.get("ExitCode").and_then(Value::as_f64) == Some(0.0)
}

/// JS 템플릿 문자열이 `${failed.ExitCode}`를 찍는 모양
fn show_exit_code(state: &Value) -> String {
    match state.get("ExitCode") {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// 의존 서비스가 조건을 채웠는지. 상태를 하나도 못 읽었으면 실패다(기다릴 근거가 없다)
pub fn dependency_decision(condition: &str, service: &str, states: &[Value]) -> DependencyDecision {
    if states.is_empty() {
        return DependencyDecision::Failed(format!("dependency failed to start: {service}의 상태를 읽지 못했습니다"));
    }
    if condition == "service_healthy" {
        // compose와 같다: healthcheck가 없는 서비스에 service_healthy를 걸면 기다릴 수 없어 실패한다
        if states.iter().any(|state| !has_health(state)) {
            return DependencyDecision::Failed(format!("dependency failed to start: container {service} has no healthcheck configured"));
        }
        if states.iter().all(|state| health_status(state) == Some("healthy")) {
            return DependencyDecision::Ready;
        }
        if states.iter().any(|state| health_status(state) == Some("unhealthy")) {
            return DependencyDecision::Failed(format!("dependency failed to start: container {service} is unhealthy"));
        }
        if states.iter().any(|state| matches!(status(state), Some("exited" | "dead"))) {
            return DependencyDecision::Failed(format!("dependency failed to start: container {service} exited"));
        }
    } else {
        if states.iter().all(exited_ok) {
            return DependencyDecision::Ready;
        }
        if let Some(failed) = states.iter().find(|state| status(state) == Some("exited") && !exited_ok(state)) {
            return DependencyDecision::Failed(format!("service \"{service}\" didn't complete successfully: exit {}", show_exit_code(failed)));
        }
    }
    DependencyDecision::Wait
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn id_목록은_빈_줄과_공백을_거른다() {
        assert_eq!(parse_ids("a\n  b \n\n"), ids(&["a", "b"]));
        assert!(parse_ids("\n \n").is_empty());
    }

    #[test]
    fn inspect는_해석하지_못하면_실패다() {
        assert_eq!(parse_inspect("not json", &ids(&["a"])), Err(InspectProblem::Unparsed));
        assert_eq!(parse_inspect("", &ids(&["a"])), Err(InspectProblem::Unparsed));
    }

    #[test]
    fn inspect가_배열이_아니면_일부만_확인한_것이다() {
        assert_eq!(parse_inspect("{\"Id\":\"a\"}", &ids(&["a"])), Err(InspectProblem::Partial));
        assert_eq!(parse_inspect("null", &ids(&["a"])), Err(InspectProblem::Partial));
    }

    #[test]
    fn 목록의_id_일부가_빠지면_실패다() {
        assert_eq!(parse_inspect("[{\"Id\":\"a\"}]", &ids(&["a", "b"])), Err(InspectProblem::Partial));
        assert_eq!(parse_inspect("[]", &ids(&["a"])), Err(InspectProblem::Partial));
        assert!(parse_inspect("[{\"Id\":\"a\"},{\"Id\":\"b\"}]", &ids(&["a", "b"])).is_ok());
    }

    #[test]
    fn id가_문자열이_아닌_항목이_있으면_실패다() {
        assert_eq!(parse_inspect("[{\"Id\":\"a\"},{\"Id\":1}]", &ids(&["a"])), Err(InspectProblem::Partial));
        assert_eq!(parse_inspect("[{\"Id\":\"a\"},{}]", &ids(&["a"])), Err(InspectProblem::Partial));
        assert_eq!(parse_inspect("[{\"Id\":\"a\"},null]", &ids(&["a"])), Err(InspectProblem::Partial));
    }

    #[test]
    fn 목록에_없는_컨테이너도_돌아오면_함께_본다() {
        assert_eq!(parse_inspect("[{\"Id\":\"a\"},{\"Id\":\"x\"}]", &ids(&["a"])).unwrap().len(), 2);
    }

    #[test]
    fn 볼륨_이름은_처음_나온_순서로_겹치지_않게_모은다() {
        let containers = vec![
            json!({"Mounts": [{"Type": "volume", "Name": "db", "Destination": "/d"}, {"Type": "bind", "Source": "/x", "Destination": "/x"}]}),
            json!({"Mounts": [{"Type": "volume", "Name": "cache", "Destination": "/c"}, {"Type": "volume", "Name": "db", "Destination": "/d2"}, {"Type": "volume", "Destination": "/anon"}]}),
        ];
        assert_eq!(volume_names(&containers), ids(&["db", "cache"]));
    }

    #[test]
    fn 볼륨_출력이_배열이_아니거나_이름이_없으면_실패다() {
        let names = ids(&["db"]);
        assert_eq!(parse_volumes("nope", &names), Err(VolumeProblem::Unparsed));
        assert_eq!(parse_volumes("{\"Name\":\"db\"}", &names), Err(VolumeProblem::Unparsed));
        assert_eq!(parse_volumes("[{\"Driver\":\"local\"}]", &names), Err(VolumeProblem::Unparsed));
        assert_eq!(parse_volumes("[null]", &names), Err(VolumeProblem::Unparsed));
    }

    #[test]
    fn 물어본_볼륨이_일부_빠지면_실패이고_빠진_이름을_알린다() {
        assert_eq!(parse_volumes("[{\"Name\":\"db\"}]", &ids(&["db", "cache", "logs"])), Err(VolumeProblem::Partial(ids(&["cache", "logs"]))));
        assert_eq!(parse_volumes("[]", &ids(&["db"])), Err(VolumeProblem::Partial(ids(&["db"]))));
    }

    #[test]
    fn 볼륨_옵션은_드라이버가_있을_때만_드라이버를_담고_없으면_빈_옵션이다() {
        let options = parse_volumes("[{\"Name\":\"a\",\"Driver\":\"local\",\"Options\":{\"o\":\"bind\"}},{\"Name\":\"b\",\"Driver\":\"\",\"Options\":null}]", &ids(&["a", "b"])).unwrap();
        assert_eq!(options["a"], json!({"driver": "local", "driver_opts": {"o": "bind"}}));
        assert_eq!(options["b"], json!({"driver_opts": {}}));
    }

    fn mount(kind: &str, source: Option<&str>, destination: &str, rw: Option<bool>) -> InspectedMount {
        InspectedMount { kind: kind.into(), name: None, source: source.map(str::to_owned), destination: destination.into(), rw }
    }

    #[test]
    fn mounts_모양을_모르면_오류다() {
        assert!(parse_mounts(&json!({"Mounts": "x"})).is_err());
        assert!(parse_mounts(&json!({"Mounts": [1]})).is_err());
        assert!(parse_mounts(&json!({"Mounts": [{"Type": "bind"}]})).is_err());
        assert!(parse_mounts(&json!({"Mounts": [{"Destination": "/a", "Source": 3}]})).is_err());
        assert_eq!(parse_mounts(&json!({})).unwrap(), vec![]);
        assert_eq!(parse_mounts(&json!({"Mounts": null})).unwrap(), vec![]);
    }

    #[test]
    fn tmpfs_모양을_모르면_오류다() {
        assert!(parse_tmpfs(&json!({"HostConfig": {"Tmpfs": ["/a"]}})).is_err());
        assert!(parse_tmpfs(&json!({"HostConfig": 3})).is_err());
        assert_eq!(parse_tmpfs(&json!({"HostConfig": {"Tmpfs": {"/a": ""}}})).unwrap(), ids(&["/a"]));
        assert!(parse_tmpfs(&json!({})).unwrap().is_empty());
    }

    #[test]
    fn 평가_자산_자리는_읽기_전용_단일_마운트일_때만_통과한다() {
        let volumes = HashMap::new();
        let ro = |source: &str| mount("bind", Some(source), "/w/a", Some(false));
        let slot = asset_slot(&[ro("/copy")], &[], &volumes, "/w/a").unwrap();
        assert!(slot.ok(true));
        assert!(!slot.ok(false));
        // RW가 true이거나 정보가 없으면 실패
        assert!(!asset_slot(&[mount("bind", Some("/copy"), "/w/a", Some(true))], &[], &volumes, "/w/a").unwrap().ok(true));
        assert!(!asset_slot(&[mount("bind", Some("/copy"), "/w/a", None)], &[], &volumes, "/w/a").unwrap().ok(true));
        // 마운트 없음
        assert!(!asset_slot(&[], &[], &volumes, "/w/a").unwrap().ok(true));
    }

    #[test]
    fn 같은_자리에_마운트가_여럿이면_실패다() {
        let volumes = HashMap::new();
        let ro = mount("bind", Some("/copy"), "/w/a", Some(false));
        let slot = asset_slot(&[ro.clone(), ro], &[], &volumes, "/w/a").unwrap();
        assert!(!slot.single);
        assert!(!slot.ok(true));
    }

    #[test]
    fn 자리_안쪽의_다른_마운트와_tmpfs는_실패다() {
        let volumes = HashMap::new();
        let ro = mount("bind", Some("/copy"), "/w/a", Some(false));
        let nested = mount("bind", Some("/other"), "/w/a/inner", Some(false));
        assert!(!asset_slot(&[ro.clone(), nested], &[], &volumes, "/w/a").unwrap().ok(true));
        assert!(!asset_slot(std::slice::from_ref(&ro), &["/w/a".to_owned()], &volumes, "/w/a").unwrap().ok(true));
        assert!(!asset_slot(std::slice::from_ref(&ro), &["/w/a/x".to_owned()], &volumes, "/w/a").unwrap().ok(true));
        // 바깥이나 이름만 닮은 자리는 덮지 않는다
        assert!(asset_slot(std::slice::from_ref(&ro), &["/tmp".to_owned(), "/w/ab".to_owned()], &volumes, "/w/a").unwrap().ok(true));
        assert!(asset_slot(&[ro, mount("bind", Some("/p"), "/w", Some(true))], &[], &volumes, "/w/a").unwrap().ok(true));
    }

    #[test]
    fn docker_desktop_접두어만_떼고_그_밖의_꼴은_받지_않는다() {
        let volumes = HashMap::new();
        let at = |source: &str| asset_slot(&[mount("bind", Some(source), "/w/a", Some(false))], &[], &volumes, "/w/a").unwrap();
        assert_eq!(at("/host_mnt/Users/x/copy").source.as_deref(), Some("/Users/x/copy"));
        assert_eq!(at("/run/desktop/mnt/host/Users/x").source.as_deref(), Some("/Users/x"));
        assert_eq!(at("/host_mnt/../etc").source, None);
        assert!(!at("/host_mnt/../etc").ok(true));
    }

    #[test]
    fn 볼륨_마운트는_호스트에_묶인_볼륨일_때만_원본이_있다() {
        let mut volumes = HashMap::new();
        volumes.insert("bound".to_owned(), json!({"driver": "local", "driver_opts": {"type": "none", "o": "bind", "device": "/host/copy"}}));
        volumes.insert("plain".to_owned(), json!({"driver": "local", "driver_opts": {}}));
        let mut named = mount("volume", None, "/w/a", Some(false));
        named.name = Some("bound".into());
        assert_eq!(asset_slot(&[named.clone()], &[], &volumes, "/w/a").unwrap().source.as_deref(), Some("/host/copy"));
        named.name = Some("plain".into());
        assert_eq!(asset_slot(&[named.clone()], &[], &volumes, "/w/a").unwrap().source, None);
        // 볼륨 옵션의 모양을 모르면 오류
        volumes.insert("weird".to_owned(), json!({"driver": "local", "driver_opts": "x"}));
        named.name = Some("weird".into());
        assert!(asset_slot(&[named], &[], &volumes, "/w/a").is_err());
    }

    fn state(value: Value) -> Value {
        value
    }

    #[test]
    fn 상태를_하나도_못_읽으면_실패다() {
        assert_eq!(dependency_decision("service_healthy", "db", &[]), DependencyDecision::Failed("dependency failed to start: db의 상태를 읽지 못했습니다".into()));
        assert!(matches!(dependency_decision("service_completed_successfully", "db", &[]), DependencyDecision::Failed(_)));
    }

    #[test]
    fn 상태_줄은_객체가_아니면_읽지_못한_것이다() {
        assert!(parse_states("{\"Status\":\"running\"}\nnull\n").is_none());
        assert!(parse_states("{\"Status\":\"running\"}\nnope").is_none());
        assert_eq!(parse_states("\n{\"Status\":\"running\"}\n\n").unwrap().len(), 1);
    }

    #[test]
    fn service_healthy는_healthcheck가_없으면_실패한다() {
        let states = [state(json!({"Status": "running", "Health": null}))];
        assert_eq!(dependency_decision("service_healthy", "db", &states), DependencyDecision::Failed("dependency failed to start: container db has no healthcheck configured".into()));
        let states = [state(json!({"Status": "running"}))];
        assert!(matches!(dependency_decision("service_healthy", "db", &states), DependencyDecision::Failed(_)));
    }

    #[test]
    fn service_healthy_판정() {
        let healthy = state(json!({"Status": "running", "Health": {"Status": "healthy"}}));
        let starting = state(json!({"Status": "running", "Health": {"Status": "starting"}}));
        let unhealthy = state(json!({"Status": "running", "Health": {"Status": "unhealthy"}}));
        let exited = state(json!({"Status": "exited", "Health": {"Status": "starting"}}));
        assert_eq!(dependency_decision("service_healthy", "db", std::slice::from_ref(&healthy)), DependencyDecision::Ready);
        assert_eq!(dependency_decision("service_healthy", "db", &[healthy.clone(), starting.clone()]), DependencyDecision::Wait);
        assert_eq!(dependency_decision("service_healthy", "db", &[healthy.clone(), unhealthy]), DependencyDecision::Failed("dependency failed to start: container db is unhealthy".into()));
        assert_eq!(dependency_decision("service_healthy", "db", &[starting, exited]), DependencyDecision::Failed("dependency failed to start: container db exited".into()));
    }

    #[test]
    fn service_completed_successfully_판정() {
        let done = state(json!({"Status": "exited", "ExitCode": 0}));
        let running = state(json!({"Status": "running"}));
        let failed = state(json!({"Status": "exited", "ExitCode": 3}));
        assert_eq!(dependency_decision("service_completed_successfully", "m", std::slice::from_ref(&done)), DependencyDecision::Ready);
        assert_eq!(dependency_decision("service_completed_successfully", "m", &[done.clone(), running]), DependencyDecision::Wait);
        assert_eq!(dependency_decision("service_completed_successfully", "m", &[done, failed]), DependencyDecision::Failed("service \"m\" didn't complete successfully: exit 3".into()));
        // 종료 코드를 알 수 없으면 성공이 아니다
        assert_eq!(
            dependency_decision("service_completed_successfully", "m", &[state(json!({"Status": "exited"}))]),
            DependencyDecision::Failed("service \"m\" didn't complete successfully: exit undefined".into())
        );
    }
}
