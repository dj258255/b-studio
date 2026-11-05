//! 서비스 컨테이너가 프로젝트 폴더의 `.git`과 평가 자산을 쓰지 못하게 하는 마운트 계획(ADR-158, ADR-175 후속)의 판정 부분.
//!
//! 작업 복사본이 서비스 컨테이너에 읽기·쓰기로 마운트되면 컨테이너 안 명령이 `.git`(체크포인트 저장소, b-studio 상태 폴더)과
//! 평가 자산을 고칠 수 있다. 서비스가 프로젝트를 마운트한 자리마다 더 구체적인 경로의 읽기 전용 마운트를 겹쳐 막는다
//! (Docker는 더 깊은 경로의 마운트를 위에 얹는다).
//!
//! 파일 시스템을 읽는 쪽(`realpath`, `lstat`, 빈 폴더 준비)은 아직 TS(`git-mask.ts`)에 있고, 여기는 그 결과를 받아 계획하고
//! 비교만 한다. 경로 규칙은 옛 TS와 같게 `node_path`(Node `path.posix`)를 쓴다.
//!
//! 의도한 차이 하나: 서비스마다 마운트를 target으로 정렬할 때 옛 TS는 `localeCompare`(ICU 정렬)를 썼다. ICU 정렬은 그대로 옮길 수
//! 없어 UTF-16 코드 단위 순서로 정렬한다. Docker 엔진은 마운트를 경로 깊이 순으로 다시 정렬해 붙이고, 같은 깊이의 서로 다른 경로는
//! 겹치지 않으므로 이 순서는 무엇이 막히는지를 바꾸지 않는다(오류 메시지의 나열 순서만 바뀔 수 있다).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{js, node_path};

const GIT: &str = ".git";
const STATE: &str = "b-studio";
/// 상태 폴더 자리에 읽기 전용으로 얹을 빈 폴더(`.git` 안)
const STATE_MASK: &str = "b-studio-empty";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Mount {
    pub service: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitEntry {
    pub dir: String,
    /// `directory` 또는 `file`(worktree·submodule의 gitdir 포인터)
    pub kind: String,
    pub has_state: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetCopy {
    /// 프로젝트 폴더 기준 선언 경로
    pub path: String,
    /// b-studio가 가진 복사본의 호스트 절대 경로
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BindOptions {
    pub create_host_path: bool,
}

/// compose의 긴 문법 마운트 한 개(읽기 전용 bind). 필드 순서는 옛 TS 객체와 같다
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaskVolume {
    #[serde(rename = "type")]
    pub kind: String,
    pub source: String,
    pub target: String,
    pub read_only: bool,
    pub bind: BindOptions,
}

fn read_only(source: String, target: String) -> MaskVolume {
    MaskVolume { kind: "bind".to_owned(), source, target, read_only: true, bind: BindOptions { create_host_path: false } }
}

/// 서비스 이름 → target → 마운트. 서비스는 처음 나온 순서를 지키고(JS `Map`), 같은 target은 자리를 지킨 채 값만 바뀐다
#[derive(Default)]
struct Plan {
    services: Vec<(String, Vec<MaskVolume>)>,
}

impl Plan {
    fn volumes(&mut self, service: &str) -> &mut Vec<MaskVolume> {
        if let Some(index) = self.services.iter().position(|(name, _)| name == service) {
            &mut self.services[index].1
        } else {
            self.services.push((service.to_owned(), Vec::new()));
            &mut self.services.last_mut().expect("방금 넣었다").1
        }
    }

    fn set(&mut self, service: &str, volume: MaskVolume) {
        let volumes = self.volumes(service);
        match volumes.iter_mut().find(|v| v.target == volume.target) {
            Some(existing) => *existing = volume,
            None => volumes.push(volume),
        }
    }

    fn into_record(self) -> Vec<(String, Vec<MaskVolume>)> {
        self.services
            .into_iter()
            .map(|(service, mut volumes)| {
                volumes.sort_by(|a, b| js::cmp_utf16(&a.target, &b.target));
                (service, volumes)
            })
            .collect()
    }
}

/// 서비스 → 마운트 목록을 JS 객체(키 순서 유지)로
pub fn record_to_json(record: &[(String, Vec<MaskVolume>)]) -> Value {
    let mut map = Map::new();
    for (service, volumes) in record {
        map.insert(service.clone(), serde_json::to_value(volumes).expect("직렬화"));
    }
    Value::Object(map)
}

/// JS 객체(서비스 → 마운트 목록)를 읽는다
pub fn record_from_json(value: &Value) -> Result<Vec<(String, Vec<MaskVolume>)>, String> {
    let Value::Object(map) = value else { return Err("마스크 계획의 형식이 다릅니다".to_owned()) };
    map.iter()
        .map(|(service, volumes)| {
            serde_json::from_value::<Vec<MaskVolume>>(volumes.clone()).map(|v| (service.clone(), v)).map_err(|e| format!("마스크 계획을 읽지 못했습니다: {e}"))
        })
        .collect()
}

/// `.git` 마스크 계획.
///  - 서비스가 `.git`이 든 폴더(또는 그 상위)를 마운트하면 그 안의 `.git`을 읽기 전용으로, 상태 폴더는 빈 폴더(읽기 전용)로 덮는다
///  - 서비스가 `.git` 안쪽을 직접 마운트하면 같은 자리에서 읽기 전용(상태 폴더는 빈 폴더)으로 바꾼다
///  - 같은 자리를 둘 이상의 규칙이 덮으면 상태 폴더를 가리는 쪽이 남는다
pub fn plan_git_mask(cwd: &str, mounts: &[Mount], entries: &[GitEntry]) -> Vec<(String, Vec<MaskVolume>)> {
    let mut plan = Plan::default();
    let mask_suffix = format!("/{STATE_MASK}");
    let add = |plan: &mut Plan, service: &str, volume: MaskVolume| {
        let keep_existing = plan.volumes(service).iter().any(|v| v.target == volume.target && v.source.ends_with(&mask_suffix));
        if !keep_existing {
            plan.set(service, volume);
        }
    };
    for mount in mounts {
        let source = node_path::resolve(cwd, &[&mount.source]);
        for entry in entries {
            let git = node_path::join(&[&entry.dir, GIT]);
            let state = node_path::join(&[&git, STATE]);
            if node_path::is_inside(cwd, &source, &entry.dir) {
                let container_git = node_path::join(&[&mount.target, &node_path::relative(cwd, &source, &git)]);
                add(&mut plan, &mount.service, read_only(git.clone(), container_git.clone()));
                if entry.kind == "directory" && entry.has_state {
                    add(&mut plan, &mount.service, read_only(node_path::join(&[&git, STATE_MASK]), node_path::join(&[&container_git, STATE])));
                }
            } else if node_path::is_inside(cwd, &git, &source) {
                if node_path::is_inside(cwd, &state, &source) {
                    add(&mut plan, &mount.service, read_only(node_path::join(&[&git, STATE_MASK]), mount.target.clone()));
                } else {
                    add(&mut plan, &mount.service, read_only(source.clone(), mount.target.clone()));
                }
            }
        }
    }
    plan.into_record()
}

/// 평가 자산 하나가 덧붙는 자리
#[derive(Debug, Clone)]
struct AssetMaskEntry {
    service: String,
    target: String,
    source: String,
    /// 이 target을 만든 평가 자산의 작업 복사본 절대 경로
    asset: String,
}

fn asset_mask_entries(cwd: &str, mounts: &[Mount], project_root: &str, assets: &[AssetCopy]) -> Vec<AssetMaskEntry> {
    let mut entries = Vec::new();
    for mount in mounts {
        let source = node_path::resolve(cwd, &[&mount.source]);
        for asset in assets {
            let asset_abs = node_path::resolve(cwd, &[project_root, &asset.path]);
            if node_path::is_inside(cwd, &source, &asset_abs) {
                entries.push(AssetMaskEntry {
                    service: mount.service.clone(),
                    target: node_path::join(&[&mount.target, &node_path::relative(cwd, &source, &asset_abs)]),
                    source: asset.source.clone(),
                    asset: asset_abs,
                });
            } else if node_path::is_inside(cwd, &asset_abs, &source) {
                // 자산 폴더나 그 하위를 직접 마운트했다. 같은 자리(target)에 복사본의 같은 하위 경로를 붙인다
                entries.push(AssetMaskEntry {
                    service: mount.service.clone(),
                    target: mount.target.clone(),
                    source: node_path::join(&[&asset.source, &node_path::relative(cwd, &asset_abs, &source)]),
                    asset: asset_abs,
                });
            }
        }
    }
    entries
}

/// 선언된 평가 자산을 서비스 컨테이너에 읽기 전용으로 덧붙이는 마운트 계획. 원본은 작업 복사본이 아니라 b-studio가 가진 복사본이다
pub fn plan_evaluation_asset_mask(cwd: &str, mounts: &[Mount], project_root: &str, assets: &[AssetCopy]) -> Vec<(String, Vec<MaskVolume>)> {
    let mut plan = Plan::default();
    for entry in asset_mask_entries(cwd, mounts, project_root, assets) {
        plan.set(&entry.service, read_only(entry.source, entry.target));
    }
    plan.into_record()
}

/// compose 설정의 마운트 한 개(종류를 가리지 않는다). `host_source`는 호스트 경로인 원본을 TS가 `realpath`로 푼 값
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeMount {
    pub service: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub target: String,
    pub host_source: Option<String>,
}

/// 사용자 compose의 마운트 가운데 평가 자산 자리 안쪽(같은 자리 포함)에 있는 것이 있으면 그 이유. 자산을 직접 마운트한 그 마운트 자신만 뺀다.
/// tmpfs·이름 있는 볼륨도 같은 자리에서 우리 마운트를 덮으므로 종류를 가리지 않는다
pub fn nested_asset_mount_error(cwd: &str, compose_mounts: &[ComposeMount], mounts: &[Mount], project_root: &str, assets: &[AssetCopy]) -> Option<String> {
    for entry in asset_mask_entries(cwd, mounts, project_root, assets) {
        for mount in compose_mounts {
            if mount.service != entry.service {
                continue;
            }
            if mount.target == entry.target {
                if let Some(host) = &mount.host_source {
                    if node_path::is_inside(cwd, host, &entry.asset) || node_path::is_inside(cwd, &entry.asset, host) {
                        continue;
                    }
                }
                let shown = mount.host_source.as_deref().unwrap_or(&mount.kind);
                return Some(format!(
                    "서비스 {}가 평가 자산 자리 {}에 다른 마운트({shown})를 겹쳤습니다. 평가 자산을 보호할 수 없어 샌드박스를 만들지 않습니다",
                    mount.service, entry.target
                ));
            }
            if is_inside_posix(&entry.target, &mount.target) {
                return Some(format!(
                    "서비스 {}의 마운트 {}({})가 평가 자산 자리 {} 안쪽에 있습니다. 평가 자산을 보호할 수 없어 샌드박스를 만들지 않습니다",
                    mount.service, mount.target, mount.kind, entry.target
                ));
            }
        }
    }
    None
}

/// 컨테이너 안 경로(target)를 비교한다. 호스트 경로가 아니라 항상 POSIX 규칙이다(현재 폴더는 절대 경로끼리라 쓰이지 않는다)
pub fn is_inside_posix(parent: &str, target: &str) -> bool {
    node_path::is_inside("/", parent, target)
}

fn unknown(what: &str) -> String {
    format!("compose 설정의 {what} 형식을 알 수 없어 .git 보호를 정할 수 없습니다")
}

/// 이름 있는 볼륨이 로컬 드라이버로 호스트 폴더에 묶인 꼴(`driver_opts: { type: none, o: bind, device: <경로> }`)이면 그 호스트 경로.
/// 모양을 모르는 값이면 오류다 — 없는 것으로 보면 그 볼륨의 `.git`을 막지 않게 된다(열린 쪽)
pub fn bound_device(volume: Option<&Value>) -> Result<Option<String>, String> {
    let volume = match volume {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(map)) => map,
        // 옛 TS는 진릿값이면 객체로 읽었다. 문자열·숫자 등은 driver·driver_opts가 없는 것과 같았다
        Some(Value::Bool(false)) => return Ok(None),
        Some(_) => return Err(unknown("volumes")),
    };
    match volume.get("driver") {
        None => {}
        Some(Value::String(driver)) if driver == "local" => {}
        Some(_) => return Ok(None),
    }
    let options = match volume.get("driver_opts") {
        None | Some(Value::Null) => None,
        Some(Value::Object(options)) => Some(options),
        Some(_) => return Err(unknown("volumes.driver_opts")),
    };
    let o = match options.and_then(|o| o.get("o")) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err(unknown("volumes.driver_opts.o")),
    };
    let device = match options.and_then(|o| o.get("device")) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(unknown("volumes.driver_opts.device")),
    };
    let binds = o.split(',').map(js::trim).any(|option| option == "bind" || option == "rbind");
    Ok(device.filter(|d| !d.is_empty() && node_path::is_absolute(d) && binds))
}

/// compose 서비스의 `volumes` 한 항목
#[derive(Debug, Clone)]
struct ComposeVolume {
    kind: String,
    source: Option<String>,
    target: String,
}

fn services(config: &Value) -> Result<&Map<String, Value>, String> {
    match config.get("services") {
        Some(Value::Object(services)) => Ok(services),
        None | Some(Value::Null) => Err(unknown("services")),
        Some(_) => Err(unknown("services")),
    }
}

fn service_volumes(spec: Option<&Value>) -> Result<Vec<ComposeVolume>, String> {
    let Some(spec) = spec else { return Ok(Vec::new()) };
    let volumes = match spec.get("volumes") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(unknown("services.volumes")),
    };
    volumes
        .iter()
        .map(|item| {
            let kind = item.get("type").and_then(Value::as_str).ok_or_else(|| unknown("services.volumes.type"))?;
            let target = item.get("target").and_then(Value::as_str).ok_or_else(|| unknown("services.volumes.target"))?;
            let source = match item.get("source") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(_) => return Err(unknown("services.volumes.source")),
            };
            Ok(ComposeVolume { kind: kind.to_owned(), source, target: target.to_owned() })
        })
        .collect()
}

fn volumes_from(spec: Option<&Value>) -> Result<Vec<String>, String> {
    match spec.and_then(|s| s.get("volumes_from")) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items.iter().map(|i| i.as_str().map(str::to_owned).ok_or_else(|| unknown("services.volumes_from"))).collect(),
        Some(_) => Err(unknown("services.volumes_from")),
    }
}

/// 서비스별 마운트를 `volumes_from`까지 물려받아 펼친다(전이적, 순환은 끊는다).
/// `volumes_from`이 compose 밖 컨테이너(`container:<이름>`)를 가리키면 무엇이 붙는지 알 수 없으므로 오류다
fn inherited_volumes(config: &Value) -> Result<Vec<(String, ComposeVolume)>, String> {
    let services = services(config)?;
    fn effective(services: &Map<String, Value>, service: &str, seen: &mut Vec<String>) -> Result<Vec<ComposeVolume>, String> {
        if seen.iter().any(|s| s == service) {
            return Ok(Vec::new());
        }
        seen.push(service.to_owned());
        let spec = services.get(service);
        let mut inherited = Vec::new();
        for entry in volumes_from(spec)? {
            let name = entry.split(':').next().unwrap_or("");
            if name == "container" {
                return Err(format!("서비스 {service}의 volumes_from({entry})이 compose 밖의 컨테이너를 가리켜 무엇이 마운트되는지 알 수 없습니다. .git 보호를 정할 수 없어 멈춥니다"));
            }
            inherited.extend(effective(services, name, seen)?);
        }
        let mut own = service_volumes(spec)?;
        own.extend(inherited);
        Ok(own)
    }
    let mut out = Vec::new();
    for service in services.keys() {
        let mut seen = Vec::new();
        for volume in effective(services, service, &mut seen)? {
            out.push((service.clone(), volume));
        }
    }
    Ok(out)
}

fn named_volume<'a>(config: &'a Value, name: &str) -> Result<Option<&'a Value>, String> {
    match config.get("volumes") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(volumes)) => Ok(volumes.get(name)),
        Some(_) => Err(unknown("volumes")),
    }
}

/// 서비스가 호스트 폴더를 붙이는 모든 꼴을 모은다: bind 마운트, 호스트 폴더에 묶은 이름 있는 볼륨, `volumes_from`으로 물려받은 마운트
pub fn collect_host_mounts(cwd: &str, config: &Value) -> Result<Vec<Mount>, String> {
    let mut mounts = Vec::new();
    for (service, volume) in inherited_volumes(config)? {
        let Some(source) = volume.source.filter(|s| !s.is_empty()) else { continue };
        if volume.kind == "bind" {
            mounts.push(Mount { service, source: node_path::resolve(cwd, &[&source]), target: volume.target });
        } else if volume.kind == "volume" {
            if let Some(device) = bound_device(named_volume(config, &source)?)? {
                mounts.push(Mount { service, source: node_path::resolve(cwd, &[&device]), target: volume.target });
            }
        }
    }
    Ok(mounts)
}

/// compose의 `tmpfs`(문자열 또는 목록)에서 컨테이너 경로만 뽑는다. `경로:옵션` 꼴이면 경로만
fn tmpfs_targets(tmpfs: Option<&Value>) -> Result<Vec<String>, String> {
    let entries: Vec<&str> = match tmpfs {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(items)) => items.iter().map(|i| i.as_str().ok_or_else(|| unknown("services.tmpfs"))).collect::<Result<_, _>>()?,
        Some(_) => return Err(unknown("services.tmpfs")),
    };
    Ok(entries.into_iter().map(|e| js::trim(e.split(':').next().unwrap_or("")).to_owned()).filter(|e| !e.is_empty()).collect())
}

/// 서비스의 모든 종류 마운트(bind·volume·tmpfs 등). `host`는 호스트 경로인 원본을 `resolve`한 값이고, TS가 `realpath`로 풀어 `hostSource`로 넘긴다.
/// tmpfs는 서비스 설정에만 있으므로 먼저 모두 더하고(물려받지 않는다), 그다음 물려받은 볼륨까지 펼친다
#[derive(Debug, Serialize)]
pub struct ComposeMountSpec {
    pub service: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

pub fn compose_mount_specs(cwd: &str, config: &Value) -> Result<Vec<ComposeMountSpec>, String> {
    let mut specs = Vec::new();
    for (service, spec) in services(config)? {
        for target in tmpfs_targets(spec.get("tmpfs"))? {
            specs.push(ComposeMountSpec { service: service.clone(), kind: "tmpfs".to_owned(), target, host: None });
        }
    }
    for (service, volume) in inherited_volumes(config)? {
        let host = match &volume.source {
            None => None,
            Some(source) if volume.kind == "bind" => Some(source.clone()),
            Some(source) if volume.kind == "volume" => bound_device(named_volume(config, source)?)?,
            Some(_) => None,
        };
        specs.push(ComposeMountSpec { service, kind: volume.kind, target: volume.target, host: host.map(|h| node_path::resolve(cwd, &[&h])) });
    }
    Ok(specs)
}

/// 마스크 계획을 서비스·target으로 합친다. 뒤에 오는 계획이 같은 target에서 이긴다
pub fn merge_masks(plans: Vec<Vec<(String, Vec<MaskVolume>)>>) -> Vec<(String, Vec<MaskVolume>)> {
    let mut merged = Plan::default();
    for plan in plans {
        for (service, volumes) in plan {
            merged.volumes(&service);
            for volume in volumes {
                merged.set(&service, volume);
            }
        }
    }
    merged.into_record()
}

/// Docker Desktop은 bind 마운트의 Source를 호스트 경로 앞에 `/host_mnt` 또는 `/run/desktop/mnt/host`를 붙여 알려 주기도 한다.
/// 맨 앞이 **정확히** 그 접두어이고, 뗀 나머지가 절대 경로이며 `..` 요소가 없을 때만 그 경로로 본다. 그 밖의 꼴은 받지 않는다(`None`)
pub fn docker_desktop_host_path(source: &str) -> Option<String> {
    for prefix in ["/host_mnt/", "/run/desktop/mnt/host/"] {
        let Some(rest) = source.strip_prefix(prefix) else { continue };
        // 접두어의 마지막 `/`는 남긴다 — 뗀 경로가 `/Users/…`처럼 절대 경로여야 한다
        let stripped = format!("/{rest}");
        if stripped.split('/').any(|part| part == "..") {
            return None;
        }
        return Some(stripped);
    }
    Some(source.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CWD: &str = "/cwd";

    fn mount(service: &str, source: &str, target: &str) -> Mount {
        Mount { service: service.into(), source: source.into(), target: target.into() }
    }

    fn entry(dir: &str, has_state: bool) -> GitEntry {
        GitEntry { dir: dir.into(), kind: "directory".into(), has_state }
    }

    #[test]
    fn 프로젝트를_마운트하면_git과_상태_폴더를_덮는다() {
        let plan = plan_git_mask(CWD, &[mount("api", "/p", "/app")], &[entry("/p", true)]);
        let targets: Vec<_> = plan[0].1.iter().map(|v| (v.source.as_str(), v.target.as_str())).collect();
        assert_eq!(targets, vec![("/p/.git", "/app/.git"), ("/p/.git/b-studio-empty", "/app/.git/b-studio")]);
    }

    #[test]
    fn git_안쪽을_직접_마운트하면_같은_자리를_바꾼다() {
        let plan = plan_git_mask(CWD, &[mount("a", "/p/.git/b-studio/x", "/s"), mount("a", "/p/.git/objects", "/o")], &[entry("/p", true)]);
        let targets: Vec<_> = plan[0].1.iter().map(|v| (v.source.as_str(), v.target.as_str())).collect();
        assert_eq!(targets, vec![("/p/.git/objects", "/o"), ("/p/.git/b-studio-empty", "/s")]);
    }

    #[test]
    fn 하위_폴더만_마운트하면_아무것도_하지_않는다() {
        assert!(plan_git_mask(CWD, &[mount("a", "/p/web", "/app")], &[entry("/p", true)]).is_empty());
    }

    #[test]
    fn volumes_from은_전이적이고_밖의_컨테이너는_오류다() {
        let config = json!({ "services": {
            "a": { "volumes": [{ "type": "bind", "source": "/p", "target": "/app" }] },
            "b": { "volumes_from": ["a:ro"] },
            "c": { "volumes_from": ["b"] }
        }});
        let mounts = collect_host_mounts(CWD, &config).unwrap();
        assert_eq!(mounts.iter().map(|m| m.service.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
        let bad = json!({ "services": { "a": { "volumes_from": ["container:x"] } } });
        assert!(collect_host_mounts(CWD, &bad).unwrap_err().contains("compose 밖의 컨테이너"));
    }

    #[test]
    fn 호스트에_묶은_볼륨만_호스트_마운트로_본다() {
        assert_eq!(bound_device(Some(&json!({ "driver_opts": { "o": "bind", "device": "/h" } }))).unwrap(), Some("/h".into()));
        assert_eq!(bound_device(Some(&json!({ "driver": "local", "driver_opts": { "o": "rw, rbind", "device": "/h" } }))).unwrap(), Some("/h".into()));
        assert_eq!(bound_device(Some(&json!({ "driver": "nfs", "driver_opts": { "o": "bind", "device": "/h" } }))).unwrap(), None);
        assert_eq!(bound_device(Some(&json!({ "driver_opts": { "o": "bind", "device": "rel" } }))).unwrap(), None);
        assert!(bound_device(Some(&json!({ "driver_opts": { "o": 1, "device": "/h" } }))).is_err());
    }

    #[test]
    fn docker_desktop_접두어만_뗀다() {
        assert_eq!(docker_desktop_host_path("/host_mnt/Users/a"), Some("/Users/a".into()));
        assert_eq!(docker_desktop_host_path("/run/desktop/mnt/host/c/x"), Some("/c/x".into()));
        assert_eq!(docker_desktop_host_path("/host_mnt/../etc"), None);
        assert_eq!(docker_desktop_host_path("/x/host_mnt/a"), Some("/x/host_mnt/a".into()));
    }

    #[test]
    fn 평가_자산_자리에_겹친_마운트는_오류다() {
        let mounts = [mount("api", "/p", "/app")];
        let assets = [AssetCopy { path: "tests/check.mjs".into(), source: "/cache/a/check.mjs".into() }];
        let tmpfs = [ComposeMount { service: "api".into(), kind: "tmpfs".into(), target: "/app/tests".into(), host_source: None }];
        assert!(nested_asset_mount_error(CWD, &tmpfs, &mounts, "/p", &assets).is_none());
        let deeper = [ComposeMount { service: "api".into(), kind: "tmpfs".into(), target: "/app/tests/check.mjs".into(), host_source: None }];
        assert!(nested_asset_mount_error(CWD, &deeper, &mounts, "/p", &assets).unwrap().contains("다른 마운트(tmpfs)"));
    }
}
