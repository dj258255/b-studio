//! 만든 컨테이너를 시작하기 전에 확인하고, 확인한 컨테이너만 시작하는 조율(옛 TS: `LocalDockerProvider.#verifyMasks`·`#startVerified`·
//! `#waitForDependency`, `git-mask.ts`의 `findMissingMasks`·`selectEvaluationAssetVolumes`. ADR-195 4f A4b).
//!
//! 판정은 `bstudio_guard::container_verify`(와 `container_policy`·`git_mask`)가 하고, 여기는 docker를 부르는 순서와 링크를 푸는 일만 한다.
//! **확인 단계 전체가 함수 하나(`verify_containers`)다.** 목록 → inspect → volume inspect → 컨테이너마다 판정 → 위반 컨테이너 지우기를
//! 순서대로 하며, 확인한 id 목록(`inspect`가 돌려준 `Id`)과 지우는 id 목록은 이 함수 안의 같은 값이다. TS는 결과만 받아 오류로 바꾼다.
//! 위반이 있으면 확인 결과(`Verified`)를 돌려주지 않는다 — 시작 단계로 가는 길이 없다.
//!
//! 막는 쪽/여는 쪽: 이 모듈은 모두 막는 쪽이다. 읽지 못한 것, 일부만 읽은 것, 모양을 모르는 것은 통과가 아니라 실패(또는 "모른다")로 돌려준다.
//!
//! 확인하는 쪽과 실제로 쓰는 쪽이 같은 입력을 다르게 읽는 자리(점검한 것):
//!  - 호스트 경로: 컨테이너가 알려 주는 `Source`는 사용자가 쓴 경로 그대로이거나 Docker Desktop 접두어(`/host_mnt/…`)가 붙은 꼴이다. 링크를 풀어(`real_path`)
//!    계획의 원본과 견주고, `.git`을 찾을 때는 접두어를 뗀 경로도 함께 본다(옛 TS는 그대로만 봐서 Docker Desktop에서 `.git` 확인을 건너뛰었다)
//!  - 컨테이너 안 경로(target)는 호스트 규칙이 아니라 항상 POSIX 규칙으로 견준다(`is_inside_posix`)
//!  - 지울 컨테이너는 `inspect`가 돌려준 `Id`로 가리킨다(이름이 아니라 같은 값)

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bstudio_guard::container_policy::{self, PolicyOptions};
use bstudio_guard::container_verify::{self as judge, DependencyDecision, InspectProblem, InspectedMount, VolumeProblem};
use bstudio_guard::git_mask::{self, AssetCopy, GitEntry as PlanEntry, MaskVolume, Mount};
use bstudio_guard::js_json::JsValue;
use bstudio_guard::{compose_deps, node_path};
use serde_json::Value;
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::git_mask_fs::{detect_git_entries, real_path};
use crate::process::run_command;
use crate::stream_exec::ExecOutput;

/// 취소 신호. 한 번 깨면 이후 모든 대기가 곧바로 끝난다(`Notify`의 허가증은 한 번만 쓰여 여러 번 기다리는 이 조율에는 맞지 않는다)
#[derive(Default)]
pub struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

async fn docker(bin: &str, env: Option<&[(String, String)]>, args: &[String], cancel: Option<&Cancel>) -> ExecOutput {
    match cancel {
        Some(cancel) => run_command(bin, args, None, env, None, cancel.cancelled()).await,
        None => run_command(bin, args, None, env, None, std::future::pending::<()>()).await,
    }
}

fn args(parts: &[&str], rest: impl IntoIterator<Item = String>) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).chain(rest).collect()
}

// ── 가림이 빠진 자리 찾기 ────────────────────────────────────────────────

/// 합친 마스크에서 평가 자산 볼륨만 고른다. 평가 자산 자리의 확인은 **계획**(override에 적은 target·원본)을 기대해야 한다 —
/// 컨테이너의 실제 마운트에서 거꾸로 계산하면 프로젝트 마운트의 원본을 알아보지 못할 때 기대 목록이 비어 통과한다.
/// 볼륨의 원본이 b-studio 복사본(또는 그 안쪽)인 것으로 알아본다
pub async fn select_evaluation_asset_volumes(volumes: &[MaskVolume], assets: &[AssetCopy], cwd: &str) -> Vec<MaskVolume> {
    let mut roots = Vec::new();
    for asset in assets {
        roots.push(real_path(&asset.source, cwd).await);
    }
    let mut picked = Vec::new();
    for volume in volumes {
        let source = real_path(&volume.source, cwd).await;
        if roots.iter().any(|root| node_path::is_inside(cwd, root, &source)) {
            picked.push(volume.clone());
        }
    }
    picked
}

/// 사후 확인(설정이 아니라 결과를 본다): 컨테이너의 실제 마운트에서 `.git`이 든 호스트 폴더를 덮는 마운트가 있는데 그 안의 `.git` 자리에
/// 읽기 전용 마운트(상태 폴더는 빈 폴더)가 없으면 빠진 자리(컨테이너 안 경로)를 돌려준다.
/// 평가 자산 자리는 **계획**(`planned`의 target·원본)을 기대한다. 계획에 있는 자리마다 모두 본다: 마운트가 하나뿐, 읽기 전용, 원본이 계획한 복사본,
/// 그 자리 안쪽에 다른 `Mounts` 항목이 없음, `HostConfig.Tmpfs`가 그 자리를 덮지 않음.
/// 마운트·볼륨 옵션의 모양을 몰라 확인하지 못하면 오류(부르는 쪽이 그 컨테이너를 실패로 센다)
pub async fn find_missing_masks(
    project_root: &str,
    mounts: &[InspectedMount],
    volumes: &HashMap<String, Value>,
    planned: &[MaskVolume],
    tmpfs: &[String],
    cwd: &str,
) -> Result<Vec<String>, String> {
    let root = real_path(project_root, cwd).await;
    let mut missing: Vec<String> = Vec::new();
    let mut record = |target: &str| {
        if !missing.iter().any(|seen| seen == target) {
            missing.push(target.to_owned());
        }
    };

    // `.git`은 컨테이너의 실제 마운트에서 본다. Docker Desktop 접두어가 붙은 Source는 그대로의 경로와 뗀 경로를 모두 호스트 마운트로 본다
    // (더 많이 알아볼수록 요구하는 가림이 늘 뿐이다)
    let mut host_mounts: Vec<Mount> = Vec::new();
    for mount in mounts {
        let Some(raw) = judge::host_source(mount, volumes)? else { continue };
        let mut candidates = vec![raw.clone()];
        if let Some(stripped) = git_mask::docker_desktop_host_path(&raw) {
            if stripped != raw {
                candidates.push(stripped);
            }
        }
        for candidate in candidates {
            host_mounts.push(Mount { service: "container".to_owned(), source: real_path(&candidate, cwd).await, target: mount.destination.clone() });
        }
    }
    if !host_mounts.is_empty() {
        let sources: Vec<String> = host_mounts.iter().map(|mount| mount.source.clone()).collect();
        let entries: Vec<PlanEntry> = detect_git_entries(&root, &sources, cwd)
            .await
            .into_iter()
            .map(|entry| PlanEntry { dir: entry.dir, kind: entry.kind, has_state: entry.has_state, aliases: entry.aliases })
            .collect();
        for (service, volumes) in git_mask::plan_git_mask(cwd, &host_mounts, &entries) {
            if service != "container" {
                continue;
            }
            for volume in volumes {
                let actuals: Vec<&InspectedMount> = mounts.iter().filter(|mount| mount.destination == volume.target).collect();
                // 같은 자리에 마운트가 여럿이면 어느 것이 이겼는지 알 수 없다
                if actuals.len() != 1 || actuals[0].rw != Some(false) {
                    record(&volume.target);
                }
            }
        }
    }

    // 평가 자산 자리는 계획에 있는 것을 전부 본다. "읽기 전용 마운트가 있다"만 보면 더 깊은 사용자 마운트나 같은 자리의 tmpfs가
    // 위에 내용을 덮어도 통과한다
    for volume in planned {
        let slot = judge::asset_slot(mounts, tmpfs, volumes, &volume.target)?;
        let source_matches = match &slot.source {
            Some(source) => real_path(source, cwd).await == real_path(&volume.source, cwd).await,
            None => false,
        };
        if !slot.ok(source_matches) {
            record(&volume.target);
        }
    }
    Ok(missing)
}

// ── 확인 단계 ───────────────────────────────────────────────────────────

pub struct VerifyInput {
    pub docker_bin: String,
    pub env: Option<Vec<(String, String)>>,
    /// `compose ps --all --quiet --no-trunc`의 전체 인자(`docker` 뒤). 파일·프로젝트 이름은 부르는 쪽이 정한다
    pub list_args: Vec<String>,
    pub project_root: String,
    pub cwd: String,
    pub project_name: String,
    pub sandbox_network: String,
    pub egress_network: String,
    pub edge_service: String,
    pub studio_caller: String,
    /// compose가 컨테이너에 붙이는 서비스 이름 라벨
    pub service_label: String,
    /// override에 적은 마운트 계획(서비스 → 마운트). 평가 자산 자리의 기대는 여기서 고른다
    pub git_mask: Vec<(String, Vec<MaskVolume>)>,
    pub assets: Vec<AssetCopy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedContainer {
    pub id: String,
    pub service: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    ListFailed,
    NoContainers,
    InspectFailed,
    InspectUnparsed,
    InspectPartial,
    VolumeFailed,
    VolumeUnparsed,
    VolumePartial,
    /// 샌드박스 격리를 벗어나는 설정(에이전트가 고칠 compose 문제라 플랫폼 실패가 아니다)
    Policy,
    /// `.git`·평가 자산 가림이 빠짐(플랫폼 실패)
    Mask,
}

impl FailureKind {
    /// 플랫폼 실패인가. 정책 위반만 아니다
    pub fn platform(self) -> bool {
        self != FailureKind::Policy
    }

    pub fn as_str(self) -> &'static str {
        match self {
            FailureKind::ListFailed => "list-failed",
            FailureKind::NoContainers => "no-containers",
            FailureKind::InspectFailed => "inspect-failed",
            FailureKind::InspectUnparsed => "inspect-unparsed",
            FailureKind::InspectPartial => "inspect-partial",
            FailureKind::VolumeFailed => "volume-failed",
            FailureKind::VolumeUnparsed => "volume-unparsed",
            FailureKind::VolumePartial => "volume-partial",
            FailureKind::Policy => "policy",
            FailureKind::Mask => "mask",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyFailure {
    pub kind: FailureKind,
    /// 실패한 docker 명령의 stderr(가리기 전 원문). 명령이 실패한 종류에만 있다
    pub stderr: Option<String>,
    /// 사유 줄들(위반·빠진 자리·빠진 볼륨 이름)
    pub detail: Option<String>,
    /// 위반 컨테이너를 지우려 했는데 지우지 못했다(아직 돌고 있을 수 있다)
    pub removal_failed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    /// 모든 컨테이너가 통과했다. 시작할 수 있는 것은 이 목록뿐이다
    Verified(Vec<VerifiedContainer>),
    Failed(VerifyFailure),
}

fn failed(kind: FailureKind, stderr: Option<String>, detail: Option<String>) -> VerifyOutcome {
    VerifyOutcome::Failed(VerifyFailure { kind, stderr, detail, removal_failed: false })
}

pub async fn verify_containers(input: &VerifyInput) -> VerifyOutcome {
    let env = input.env.as_deref();
    let listed = docker(&input.docker_bin, env, &input.list_args, None).await;
    // 목록을 읽지 못한 것을 "컨테이너 없음"으로 보면 확인을 건너뛴 채 시작하게 된다
    if listed.exit_code != 0 {
        return failed(FailureKind::ListFailed, Some(listed.stderr), None);
    }
    let ids = judge::parse_ids(&listed.stdout);
    // 만들기가 성공했는데 컨테이너가 보이지 않는다. 볼 것이 없다는 것은 확인했다는 뜻이 아니다
    if ids.is_empty() {
        return failed(FailureKind::NoContainers, None, None);
    }
    let inspected = docker(&input.docker_bin, env, &args(&["inspect"], ids.iter().cloned()), None).await;
    if inspected.exit_code != 0 {
        return failed(FailureKind::InspectFailed, Some(inspected.stderr), None);
    }
    let containers = match judge::parse_inspect(&inspected.stdout, &ids) {
        Ok(containers) => containers,
        Err(InspectProblem::Unparsed) => return failed(FailureKind::InspectUnparsed, None, None),
        Err(InspectProblem::Partial) => return failed(FailureKind::InspectPartial, None, None),
    };

    let names = judge::volume_names(&containers);
    let mut volumes: HashMap<String, Value> = HashMap::new();
    if !names.is_empty() {
        let output = docker(&input.docker_bin, env, &args(&["volume", "inspect"], names.iter().cloned()), None).await;
        // 볼륨 정보를 읽지 못하면 호스트 폴더에 묶인 이름 있는 볼륨을 알아볼 수 없어, 그 마운트의 보호가 빠져도 지나치게 된다
        if output.exit_code != 0 {
            return failed(FailureKind::VolumeFailed, Some(output.stderr), None);
        }
        volumes = match judge::parse_volumes(&output.stdout, &names) {
            Ok(volumes) => volumes,
            Err(VolumeProblem::Unparsed) => return failed(FailureKind::VolumeUnparsed, None, None),
            Err(VolumeProblem::Partial(unknown)) => return failed(FailureKind::VolumePartial, None, Some(unknown.join(", "))),
        };
    }

    // 평가 자산 자리의 기대는 계획(override에 적은 target·원본)에서 가져온다. 실제 마운트에서 거꾸로 계산하지 않는다
    let mut plan: Vec<(String, Vec<MaskVolume>)> = Vec::new();
    for (service, planned_volumes) in &input.git_mask {
        let picked = select_evaluation_asset_volumes(planned_volumes, &input.assets, &input.cwd).await;
        if !picked.is_empty() {
            plan.push((service.clone(), picked));
        }
    }

    let options = PolicyOptions {
        project_name: &input.project_name,
        sandbox_network: &input.sandbox_network,
        egress_network: &input.egress_network,
        edge_service: &input.edge_service,
        studio_caller: &input.studio_caller,
    };
    let mut violations: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    // 지울 id는 확인한 컨테이너의 `Id`(위에서 문자열임을 확인했다). 목록·확인·지우기가 같은 값이다
    let mut remove: Vec<String> = Vec::new();
    let mut verified: Vec<VerifiedContainer> = Vec::new();
    for container in &containers {
        let id = container.get("Id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let service = container.pointer("/Config/Labels").and_then(|labels| labels.get(&input.service_label)).and_then(Value::as_str).map(str::to_owned);
        let name = service.clone().or_else(|| container.get("Name").and_then(Value::as_str).map(str::to_owned)).unwrap_or_else(|| id.clone());
        // compose 파일로 권한·네임스페이스·네트워크·포트·호스트 경로를 바꾼 컨테이너(이슈 #701). 마운트처럼 실제 설정을 본다
        let escalated = container_policy::find_violations(container, &options);
        let missing = match missing_masks(input, container, &volumes, &plan, service.as_deref()).await {
            Ok(missing) => missing,
            // 모양을 몰라 확인하지 못했다. 확인하지 못한 컨테이너는 가림이 빠진 것으로 센다
            Err(reason) => vec![reason],
        };
        if escalated.is_empty() && missing.is_empty() {
            verified.push(VerifiedContainer { id, service });
            continue;
        }
        remove.push(id);
        if !escalated.is_empty() {
            violations.push(format!("{name}: {}", escalated.join(", ")));
        }
        if !missing.is_empty() {
            failures.push(format!("{name}: {}", missing.join(", ")));
        }
    }
    if remove.is_empty() {
        return VerifyOutcome::Verified(verified);
    }
    // 지워 두면 다음 up이 새로 만들고 다시 확인한다. 남겨 두면 만들어진 채로 있어 다른 경로로 시작될 여지가 생긴다
    let removed = docker(&input.docker_bin, env, &args(&["rm", "--force"], remove), None).await;
    let kind = if violations.is_empty() { FailureKind::Mask } else { FailureKind::Policy };
    let detail = if kind == FailureKind::Policy { violations.into_iter().chain(failures).collect::<Vec<_>>().join("\n") } else { failures.join("\n") };
    VerifyOutcome::Failed(VerifyFailure { kind, stderr: None, detail: Some(detail), removal_failed: removed.exit_code != 0 })
}

async fn missing_masks(
    input: &VerifyInput,
    container: &Value,
    volumes: &HashMap<String, Value>,
    plan: &[(String, Vec<MaskVolume>)],
    service: Option<&str>,
) -> Result<Vec<String>, String> {
    let mounts = judge::parse_mounts(container)?;
    let tmpfs = judge::parse_tmpfs(container)?;
    let planned: &[MaskVolume] = match service {
        Some(service) => plan.iter().find(|(name, _)| name == service).map(|(_, volumes)| volumes.as_slice()).unwrap_or(&[]),
        // 어느 서비스의 컨테이너인지 모르면 평가 자산 자리를 정할 수 없다. 계획에 평가 자산이 있는데 모르면 실패다
        None if !plan.is_empty() => return Err("서비스 이름을 알 수 없어 평가 자산 자리를 확인하지 못했습니다".to_owned()),
        None => &[],
    };
    find_missing_masks(&input.project_root, &mounts, volumes, planned, &tmpfs, &input.cwd).await
}

// ── 확인한 컨테이너만 시작 ────────────────────────────────────────────────

pub struct StartInput {
    pub docker_bin: String,
    pub env: Option<Vec<(String, String)>>,
    pub verified: Vec<VerifiedContainer>,
    pub services: Vec<String>,
    /// 서비스 → (의존 → 조건). 서비스가 둘 이상일 때만 쓴다. 없으면 시작하지 않는다
    pub depends_on: Option<JsValue>,
    pub poll_ms: u64,
    pub wait_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartOutcome {
    /// 확인한 목록에서 찾지 못한 서비스. 비어 있지 않으면 아무것도 시작하지 않았다
    pub missing: Vec<String>,
    /// 기다리는 중에 취소됐다(부르는 쪽이 취소를 그대로 던진다)
    pub aborted: bool,
    pub result: ExecOutput,
}

fn ok_result() -> ExecOutput {
    ExecOutput { exit_code: 0, stdout: String::new(), stderr: String::new() }
}

/// 확인한 컨테이너를 id로 시작한다. 서비스가 여럿이면 `up --no-deps a b`가 하던 대로 **목록 안의 의존 순서**를 지키고,
/// `service_healthy`·`service_completed_successfully` 조건은 그 상태가 될 때까지 기다린 뒤 다음 묶음을 시작한다.
/// 목록에 없는 의존 서비스는 건드리지 않는다. 시작하는 것은 `verified`에 든 id뿐이다(컨테이너를 만들 수 있는 명령을 쓰지 않는다)
pub async fn start_verified(input: &StartInput, cancel: &Cancel) -> StartOutcome {
    let env = input.env.as_deref();
    let ids_of = |names: &[String]| -> Vec<String> {
        input.verified.iter().filter(|container| container.service.as_ref().is_some_and(|service| names.contains(service))).map(|container| container.id.clone()).collect()
    };
    let missing: Vec<String> = input.services.iter().filter(|service| ids_of(std::slice::from_ref(service)).is_empty()).cloned().collect();
    let outcome = |result: ExecOutput| StartOutcome { missing: Vec::new(), aborted: false, result };
    if !missing.is_empty() {
        return StartOutcome { missing, aborted: false, result: ok_result() };
    }
    if input.services.len() == 1 {
        return outcome(docker(&input.docker_bin, env, &args(&["start"], ids_of(&input.services)), Some(cancel)).await);
    }
    let Some(depends_on) = &input.depends_on else {
        return outcome(ExecOutput { exit_code: 1, stdout: String::new(), stderr: "서비스의 의존 순서를 알 수 없어 시작하지 않았습니다".to_owned() });
    };

    let waves = compose_deps::start_waves(&input.services, depends_on);
    let mut last = ok_result();
    for (index, wave) in waves.iter().enumerate() {
        last = docker(&input.docker_bin, env, &args(&["start"], ids_of(wave)), Some(cancel)).await;
        if last.exit_code != 0 {
            return outcome(last);
        }
        let later: Vec<String> = waves[index + 1..].iter().flatten().cloned().collect();
        for service in wave {
            let Some(condition) = compose_deps::awaited_condition(service, &later, depends_on) else { continue };
            match wait_for_dependency(input, &ids_of(std::slice::from_ref(service)), service, condition, cancel).await {
                Ok(None) => {}
                Ok(Some(problem)) => return outcome(ExecOutput { exit_code: 1, stdout: String::new(), stderr: problem }),
                Err(Aborted) => return StartOutcome { missing: Vec::new(), aborted: true, result: last },
            }
        }
    }
    outcome(last)
}

struct Aborted;

/// 의존 서비스가 조건을 채울 때까지 기다린다. 채우지 못하면 사유를 돌려준다(compose의 "dependency failed to start"와 같은 자리)
async fn wait_for_dependency(input: &StartInput, ids: &[String], service: &str, condition: &str, cancel: &Cancel) -> Result<Option<String>, Aborted> {
    let deadline = Instant::now() + Duration::from_millis(input.wait_ms);
    loop {
        if cancel.is_cancelled() {
            return Err(Aborted);
        }
        let inspected = docker(&input.docker_bin, input.env.as_deref(), &args(&["inspect", "--format", "{{json .State}}"], ids.iter().cloned()), None).await;
        if inspected.exit_code != 0 {
            return Ok(Some(format!("dependency failed to start: {service}의 상태를 읽지 못했습니다")));
        }
        let Some(states) = judge::parse_states(&inspected.stdout) else {
            return Ok(Some(format!("dependency failed to start: {service}의 상태를 해석하지 못했습니다")));
        };
        match judge::dependency_decision(condition, service, &states) {
            DependencyDecision::Ready => return Ok(None),
            DependencyDecision::Failed(problem) => return Ok(Some(problem)),
            DependencyDecision::Wait => {}
        }
        if Instant::now() > deadline {
            // JS `Math.round`: 반올림은 올림 쪽
            let seconds = (input.wait_ms as f64 / 1000.0 + 0.5).floor() as u64;
            return Ok(Some(format!("dependency failed to start: {service}이(가) {seconds}초 안에 준비되지 않았습니다")));
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(input.poll_ms)) => {}
            _ = cancel.cancelled() => return Err(Aborted),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    /// 가짜 docker. 명령(`compose`→list, `inspect`, `inspect --format`→state, `volume`, `rm`, `start`)마다 `<키>.out`·`.err`·`.code`를 읽어 흉내 내고 부른 인자를 `calls`에 남긴다
    struct Fake {
        dir: tempfile::TempDir,
    }

    impl Fake {
        fn new() -> Fake {
            let dir = tempfile::tempdir().unwrap();
            let script = format!(
                "#!/bin/sh\nD='{}'\nprintf '%s\\n' \"$*\" >> \"$D/calls\"\nkey=$1\n[ \"$1\" = inspect ] && [ \"$2\" = --format ] && key=state\n[ -f \"$D/$key.out\" ] && cat \"$D/$key.out\"\n[ -f \"$D/$key.err\" ] && cat \"$D/$key.err\" >&2\ncode=0\n[ -f \"$D/$key.code\" ] && code=$(cat \"$D/$key.code\")\nexit $code\n",
                dir.path().display()
            );
            let bin = dir.path().join("docker");
            fs::write(&bin, script).unwrap();
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
            Fake { dir }
        }

        fn set(&self, key: &str, out: &str) -> &Self {
            fs::write(self.dir.path().join(format!("{key}.out")), out).unwrap();
            self
        }

        fn fail(&self, key: &str, code: i32, err: &str) -> &Self {
            fs::write(self.dir.path().join(format!("{key}.code")), code.to_string()).unwrap();
            fs::write(self.dir.path().join(format!("{key}.err")), err).unwrap();
            self
        }

        fn bin(&self) -> String {
            self.dir.path().join("docker").to_string_lossy().into_owned()
        }

        fn calls(&self) -> Vec<String> {
            fs::read_to_string(self.dir.path().join("calls")).unwrap_or_default().lines().map(str::to_owned).collect()
        }

        fn removed(&self) -> Vec<String> {
            self.calls().into_iter().filter(|call| call.starts_with("rm ")).collect()
        }
    }

    type Case = (&'static str, Box<dyn Fn(&Fake)>, FailureKind);

    struct Project {
        dir: tempfile::TempDir,
        root: String,
        copy: String,
    }

    fn project() -> Project {
        let dir = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(dir.path()).unwrap();
        let root = base.join("proj");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();
        fs::write(root.join("tests/acceptance"), "x").unwrap();
        let copy = base.join("copy-acceptance");
        fs::write(&copy, "x").unwrap();
        Project { root: root.to_string_lossy().into_owned(), copy: copy.to_string_lossy().into_owned(), dir }
    }

    fn input(fake: &Fake, project: &Project, with_assets: bool) -> VerifyInput {
        let volumes = if with_assets {
            vec![("api".to_owned(), vec![MaskVolume {
                kind: "bind".into(),
                source: project.copy.clone(),
                target: "/app/tests/acceptance".into(),
                read_only: true,
                bind: git_mask::BindOptions { create_host_path: false },
            }])]
        } else {
            Vec::new()
        };
        let assets = if with_assets { vec![AssetCopy { path: "tests/acceptance".into(), source: project.copy.clone() }] } else { Vec::new() };
        VerifyInput {
            docker_bin: fake.bin(),
            env: None,
            list_args: args(&["compose", "ps"], std::iter::empty()),
            project_root: project.root.clone(),
            cwd: "/".to_owned(),
            project_name: "studio-p".into(),
            sandbox_network: "b-studio-sandbox".into(),
            egress_network: "b-studio-egress".into(),
            edge_service: "edge".into(),
            studio_caller: "studio".into(),
            service_label: "com.docker.compose.service".into(),
            git_mask: volumes,
            assets,
        }
    }

    fn container(id: &str, mounts: Value) -> Value {
        json!({
            "Id": id,
            "Name": format!("/{id}"),
            "Config": { "Labels": { "com.docker.compose.service": "api" } },
            "HostConfig": { "NetworkMode": "studio-p_b-studio-sandbox" },
            "NetworkSettings": { "Networks": { "studio-p_b-studio-sandbox": {} } },
            "Mounts": mounts,
        })
    }

    fn project_mounts(project: &Project) -> Value {
        json!([
            { "Type": "bind", "Source": project.root, "Destination": "/app", "RW": true },
            { "Type": "bind", "Source": format!("{}/.git", project.root), "Destination": "/app/.git", "RW": false },
        ])
    }

    fn healthy(fake: &Fake, project: &Project, extra: Value) -> Value {
        let mut mounts = project_mounts(project).as_array().unwrap().clone();
        mounts.extend(extra.as_array().unwrap().iter().cloned());
        fake.set("compose", "c1\n");
        container("c1", Value::Array(mounts))
    }

    fn put(fake: &Fake, containers: Vec<Value>) {
        fake.set("inspect", &Value::Array(containers).to_string());
    }

    fn failure(outcome: VerifyOutcome) -> VerifyFailure {
        match outcome {
            VerifyOutcome::Failed(failure) => failure,
            VerifyOutcome::Verified(list) => panic!("통과하면 안 된다: {list:?}"),
        }
    }

    #[tokio::test]
    async fn 정상이면_확인한_컨테이너를_돌려주고_아무것도_지우지_않는다() {
        let (fake, project) = (Fake::new(), project());
        let c = healthy(&fake, &project, json!([]));
        put(&fake, vec![c]);
        let outcome = verify_containers(&input(&fake, &project, false)).await;
        assert_eq!(outcome, VerifyOutcome::Verified(vec![VerifiedContainer { id: "c1".into(), service: Some("api".into()) }]));
        assert!(fake.removed().is_empty());
        assert_eq!(fake.calls(), vec!["compose ps", "inspect c1"]);
    }

    #[tokio::test]
    async fn 목록이_비0으로_끝나면_실패다() {
        let (fake, project) = (Fake::new(), project());
        fake.fail("compose", 1, "boom");
        let failure = failure(verify_containers(&input(&fake, &project, false)).await);
        assert_eq!((failure.kind, failure.stderr.as_deref()), (FailureKind::ListFailed, Some("boom")));
        assert!(failure.kind.platform());
        // 목록을 읽지 못한 것을 컨테이너 없음으로 보고 inspect로 가지 않는다
        assert_eq!(fake.calls(), vec!["compose ps"]);
    }

    #[tokio::test]
    async fn 컨테이너가_0개면_실패다() {
        let (fake, project) = (Fake::new(), project());
        fake.set("compose", "\n  \n");
        assert_eq!(failure(verify_containers(&input(&fake, &project, false)).await).kind, FailureKind::NoContainers);
        assert_eq!(fake.calls(), vec!["compose ps"]);
    }

    #[tokio::test]
    async fn inspect가_비0으로_끝나거나_해석하지_못하거나_배열이_아니거나_일부만_오면_실패다() {
        let project = project();
        let cases: Vec<Case> = vec![
            ("비0", Box::new(|f| { f.fail("inspect", 1, "x"); }), FailureKind::InspectFailed),
            ("해석 실패", Box::new(|f| { f.set("inspect", "not json"); }), FailureKind::InspectUnparsed),
            ("배열 아님", Box::new(|f| { f.set("inspect", "{\"Id\":\"c1\"}"); }), FailureKind::InspectPartial),
            ("목록 일부 빠짐", Box::new(|f| { f.set("inspect", "[{\"Id\":\"c1\"}]"); }), FailureKind::InspectPartial),
        ];
        for (name, setup, expected) in cases {
            let fake = Fake::new();
            fake.set("compose", "c1\nc2\n");
            setup(&fake);
            let failure = failure(verify_containers(&input(&fake, &project, false)).await);
            assert_eq!(failure.kind, expected, "{name}");
            assert!(fake.removed().is_empty(), "{name}: 확인하지 못했으면 지우지도 않는다");
        }
    }

    #[tokio::test]
    async fn 볼륨_정보를_읽지_못하면_실패다() {
        let project = project();
        let mounts = json!([{ "Type": "volume", "Name": "db", "Destination": "/data", "RW": true }]);
        let cases: Vec<Case> = vec![
            ("비0", Box::new(|f| { f.fail("volume", 1, "v"); }), FailureKind::VolumeFailed),
            ("해석 실패", Box::new(|f| { f.set("volume", "nope"); }), FailureKind::VolumeUnparsed),
            ("일부 빠짐", Box::new(|f| { f.set("volume", "[{\"Name\":\"other\"}]"); }), FailureKind::VolumePartial),
        ];
        for (name, setup, expected) in cases {
            let fake = Fake::new();
            let c = healthy(&fake, &project, mounts.clone());
            put(&fake, vec![c]);
            setup(&fake);
            let failure = failure(verify_containers(&input(&fake, &project, false)).await);
            assert_eq!(failure.kind, expected, "{name}");
            assert!(fake.removed().is_empty(), "{name}");
            if expected == FailureKind::VolumePartial {
                assert_eq!(failure.detail.as_deref(), Some("db"));
            }
        }
    }

    #[tokio::test]
    async fn 볼륨_정보가_있으면_통과한다() {
        let (fake, project) = (Fake::new(), project());
        let c = healthy(&fake, &project, json!([{ "Type": "volume", "Name": "db", "Destination": "/data", "RW": true }]));
        put(&fake, vec![c]);
        fake.set("volume", "[{\"Name\":\"db\",\"Driver\":\"local\",\"Options\":null}]");
        assert!(matches!(verify_containers(&input(&fake, &project, false)).await, VerifyOutcome::Verified(_)));
        assert!(fake.calls().contains(&"volume inspect db".to_owned()));
    }

    #[tokio::test]
    async fn 정책_위반은_플랫폼_실패가_아니고_그_컨테이너만_지운다() {
        let (fake, project) = (Fake::new(), project());
        fake.set("compose", "c1\nc2\n");
        let mut bad = container("c1", project_mounts(&project));
        bad["HostConfig"]["Privileged"] = json!(true);
        let good = container("c2", project_mounts(&project));
        put(&fake, vec![bad, good]);
        let failure = failure(verify_containers(&input(&fake, &project, false)).await);
        assert_eq!(failure.kind, FailureKind::Policy);
        assert!(!failure.kind.platform());
        assert!(!failure.removal_failed);
        assert!(failure.detail.as_deref().unwrap().starts_with("api: "));
        // 지운 id는 확인한 컨테이너의 Id다(위반한 것만)
        assert_eq!(fake.removed(), vec!["rm --force c1"]);
    }

    #[tokio::test]
    async fn 지우지_못하면_그_사실을_알린다() {
        let (fake, project) = (Fake::new(), project());
        let mut bad = healthy(&fake, &project, json!([]));
        bad["HostConfig"]["Privileged"] = json!(true);
        put(&fake, vec![bad]);
        fake.fail("rm", 1, "denied");
        let failure = failure(verify_containers(&input(&fake, &project, false)).await);
        assert_eq!(failure.kind, FailureKind::Policy);
        assert!(failure.removal_failed);
    }

    #[tokio::test]
    async fn git_자리_마운트가_없거나_읽기_전용이_아니면_플랫폼_실패이고_지운다() {
        let project = project();
        let cases = [
            ("마운트 없음", json!([{ "Type": "bind", "Source": project.root, "Destination": "/app", "RW": true }])),
            (
                "RW가 true",
                json!([
                    { "Type": "bind", "Source": project.root, "Destination": "/app", "RW": true },
                    { "Type": "bind", "Source": format!("{}/.git", project.root), "Destination": "/app/.git", "RW": true },
                ]),
            ),
            (
                "RW가 없음",
                json!([
                    { "Type": "bind", "Source": project.root, "Destination": "/app", "RW": true },
                    { "Type": "bind", "Source": format!("{}/.git", project.root), "Destination": "/app/.git" },
                ]),
            ),
            (
                "같은 자리에 마운트 여럿",
                json!([
                    { "Type": "bind", "Source": project.root, "Destination": "/app", "RW": true },
                    { "Type": "bind", "Source": format!("{}/.git", project.root), "Destination": "/app/.git", "RW": false },
                    { "Type": "bind", "Source": "/elsewhere", "Destination": "/app/.git", "RW": true },
                ]),
            ),
        ];
        for (name, mounts) in cases {
            let fake = Fake::new();
            fake.set("compose", "c1\n");
            put(&fake, vec![container("c1", mounts)]);
            let failure = failure(verify_containers(&input(&fake, &project, false)).await);
            assert_eq!(failure.kind, FailureKind::Mask, "{name}");
            assert!(failure.kind.platform(), "{name}");
            assert!(failure.detail.as_deref().unwrap().contains("/app/.git"), "{name}");
            assert_eq!(fake.removed(), vec!["rm --force c1"], "{name}");
        }
    }

    #[tokio::test]
    async fn docker_desktop_접두어가_붙은_프로젝트_마운트도_git_자리를_요구한다() {
        let (fake, project) = (Fake::new(), project());
        fake.set("compose", "c1\n");
        let mounts = json!([{ "Type": "bind", "Source": format!("/host_mnt{}", project.root), "Destination": "/app", "RW": true }]);
        put(&fake, vec![container("c1", mounts)]);
        // 접두어를 떼지 않으면 프로젝트 마운트를 알아보지 못해 `.git` 확인을 건너뛰고 통과한다
        assert_eq!(failure(verify_containers(&input(&fake, &project, false)).await).kind, FailureKind::Mask);
    }

    #[tokio::test]
    async fn mounts_모양을_모르면_통과하지_못하고_지운다() {
        let (fake, project) = (Fake::new(), project());
        fake.set("compose", "c1\n");
        let mut weird = container("c1", json!("not an array"));
        weird["Mounts"] = json!("not an array");
        put(&fake, vec![weird]);
        let failure = failure(verify_containers(&input(&fake, &project, false)).await);
        // 모양을 모르는 값은 정책 판정도 "알 수 없는 형식"으로 걸러 낸다. 어느 쪽이든 통과하지 못하고 지워진다
        assert_ne!(failure.kind, FailureKind::NoContainers);
        assert_eq!(fake.removed(), vec!["rm --force c1"]);
    }

    async fn asset_case(mounts: Value, tmpfs: Option<Value>, project: &Project) -> (VerifyOutcome, Vec<String>) {
        let fake = Fake::new();
        fake.set("compose", "c1\n");
        let mut all = project_mounts(project).as_array().unwrap().clone();
        all.extend(mounts.as_array().unwrap().iter().cloned());
        let mut c = container("c1", Value::Array(all));
        if let Some(tmpfs) = tmpfs {
            c["HostConfig"]["Tmpfs"] = tmpfs;
        }
        put(&fake, vec![c]);
        let outcome = verify_containers(&input(&fake, project, true)).await;
        (outcome, fake.removed())
    }

    #[tokio::test]
    async fn 평가_자산_자리가_계획한_복사본_읽기_전용이면_통과한다() {
        let project = project();
        let mounts = json!([{ "Type": "bind", "Source": project.copy, "Destination": "/app/tests/acceptance", "RW": false }]);
        let (outcome, removed) = asset_case(mounts, None, &project).await;
        assert!(matches!(outcome, VerifyOutcome::Verified(_)), "{outcome:?}");
        assert!(removed.is_empty());
    }

    #[tokio::test]
    async fn 평가_자산_자리의_빠짐과_어긋남은_모두_실패다() {
        let project = project();
        let copy = project.copy.clone();
        let target = "/app/tests/acceptance";
        let cases: Vec<(&str, Value, Option<Value>)> = vec![
            ("마운트 없음", json!([]), None),
            ("RW가 true", json!([{ "Type": "bind", "Source": copy, "Destination": target, "RW": true }]), None),
            ("원본이 계획과 다름", json!([{ "Type": "bind", "Source": format!("{}/proj/tests/acceptance", project.dir.path().canonicalize().unwrap().display()), "Destination": target, "RW": false }]), None),
            ("같은 자리에 마운트 여럿", json!([{ "Type": "bind", "Source": copy, "Destination": target, "RW": false }, { "Type": "bind", "Source": copy, "Destination": target, "RW": false }]), None),
            ("자리 안쪽의 다른 마운트", json!([{ "Type": "bind", "Source": copy, "Destination": target, "RW": false }, { "Type": "bind", "Source": "/other", "Destination": format!("{target}/inner"), "RW": false }]), None),
            ("tmpfs가 그 자리를 덮음", json!([{ "Type": "bind", "Source": copy, "Destination": target, "RW": false }]), Some(json!({ target: "" }))),
            ("tmpfs가 그 안쪽을 덮음", json!([{ "Type": "bind", "Source": copy, "Destination": target, "RW": false }]), Some(json!({ format!("{target}/x"): "size=1m" }))),
            ("tmpfs 모양을 모름", json!([{ "Type": "bind", "Source": copy, "Destination": target, "RW": false }]), Some(json!(["/x"]))),
            ("Docker Desktop 접두어의 `..`", json!([{ "Type": "bind", "Source": "/host_mnt/../etc", "Destination": target, "RW": false }]), None),
        ];
        for (name, mounts, tmpfs) in cases {
            let (outcome, removed) = asset_case(mounts, tmpfs, &project).await;
            let failure = failure(outcome);
            // 호스트 시스템 폴더를 가리키는 원본은 정책 위반으로 먼저 걸린다
            let expected = if name.starts_with("Docker Desktop") { FailureKind::Policy } else { FailureKind::Mask };
            assert_eq!(failure.kind, expected, "{name}");
            assert_eq!(removed, vec!["rm --force c1"], "{name}");
        }
    }

    #[tokio::test]
    async fn 접두어가_붙은_복사본_원본은_뗀_경로로_계획과_견준다() {
        let project = project();
        let mounts = json!([{ "Type": "bind", "Source": format!("/host_mnt{}", project.copy), "Destination": "/app/tests/acceptance", "RW": false }]);
        let (outcome, _) = asset_case(mounts, None, &project).await;
        assert!(matches!(outcome, VerifyOutcome::Verified(_)), "{outcome:?}");
    }

    #[tokio::test]
    async fn 서비스_이름을_모르는_컨테이너는_평가_자산이_계획에_있으면_통과하지_못한다() {
        let project = project();
        let fake = Fake::new();
        fake.set("compose", "c1\n");
        let mut c = container("c1", project_mounts(&project));
        c["Config"] = json!({ "Labels": {} });
        put(&fake, vec![c]);
        let failure = failure(verify_containers(&input(&fake, &project, true)).await);
        assert_eq!(failure.kind, FailureKind::Mask);
    }

    #[tokio::test]
    async fn 평가_자산_볼륨_고르기는_복사본_안쪽_원본만_고른다() {
        let project = project();
        let volume = |source: &str, target: &str| MaskVolume { kind: "bind".into(), source: source.into(), target: target.into(), read_only: true, bind: git_mask::BindOptions { create_host_path: false } };
        let git = volume(&format!("{}/.git", project.root), "/app/.git");
        let asset = volume(&project.copy, "/app/tests/acceptance");
        let assets = vec![AssetCopy { path: "tests/acceptance".into(), source: project.copy.clone() }];
        let picked = select_evaluation_asset_volumes(&[git, asset.clone()], &assets, "/").await;
        assert_eq!(picked, vec![asset]);
        assert!(select_evaluation_asset_volumes(&[volume(&project.copy, "/x")], &[], "/").await.is_empty());
    }

    // ── 시작 ──

    fn verified(list: &[(&str, &str)]) -> Vec<VerifiedContainer> {
        list.iter().map(|(id, service)| VerifiedContainer { id: (*id).into(), service: Some((*service).into()) }).collect()
    }

    fn start_input(fake: &Fake, list: &[(&str, &str)], services: &[&str], depends_on: Option<&str>) -> StartInput {
        StartInput {
            docker_bin: fake.bin(),
            env: None,
            verified: verified(list),
            services: services.iter().map(|s| (*s).to_owned()).collect(),
            depends_on: depends_on.map(|text| bstudio_guard::js_json::parse_native(text).unwrap()),
            poll_ms: 5,
            wait_ms: 60,
        }
    }

    #[tokio::test]
    async fn 확인한_목록에_없는_서비스는_아무것도_시작하지_않는다() {
        let fake = Fake::new();
        let outcome = start_verified(&start_input(&fake, &[("c1", "api")], &["api", "db"], Some("{}")), &Cancel::default()).await;
        assert_eq!(outcome.missing, vec!["db"]);
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 서비스_하나는_확인한_id로_시작한다() {
        let fake = Fake::new();
        let outcome = start_verified(&start_input(&fake, &[("c1", "api"), ("c2", "db")], &["api"], None), &Cancel::default()).await;
        assert!(outcome.missing.is_empty() && outcome.result.exit_code == 0);
        assert_eq!(fake.calls(), vec!["start c1"]);
    }

    #[tokio::test]
    async fn 서비스가_여럿이면_의존_순서로_묶음을_시작하고_건강해질_때까지_기다린다() {
        let fake = Fake::new();
        fake.set("state", "{\"Status\":\"running\",\"Health\":{\"Status\":\"healthy\"}}\n");
        let depends = "{\"api\":{\"db\":{\"condition\":\"service_healthy\"}}}";
        let outcome = start_verified(&start_input(&fake, &[("c1", "api"), ("c2", "db")], &["api", "db"], Some(depends)), &Cancel::default()).await;
        assert_eq!(outcome.result.exit_code, 0);
        assert_eq!(fake.calls(), vec!["start c2", "inspect --format {{json .State}} c2", "start c1"]);
    }

    #[tokio::test]
    async fn 의존_서비스가_준비되지_않으면_두_번째_묶음을_시작하지_않는다() {
        let fake = Fake::new();
        fake.set("state", "{\"Status\":\"running\",\"Health\":{\"Status\":\"starting\"}}\n");
        let depends = "{\"api\":{\"db\":{\"condition\":\"service_healthy\"}}}";
        let outcome = start_verified(&start_input(&fake, &[("c1", "api"), ("c2", "db")], &["api", "db"], Some(depends)), &Cancel::default()).await;
        assert_eq!(outcome.result.exit_code, 1);
        assert!(outcome.result.stderr.contains("준비되지 않았습니다"), "{}", outcome.result.stderr);
        assert!(!fake.calls().iter().any(|call| call == "start c1"));
    }

    #[tokio::test]
    async fn 상태를_읽지_못하면_실패로_두_번째_묶음을_시작하지_않는다() {
        let depends = "{\"api\":{\"db\":{\"condition\":\"service_healthy\"}}}";
        for (name, setup) in [("비0", 0), ("해석 실패", 1), ("빈 출력", 2)] {
            let fake = Fake::new();
            match setup {
                0 => { fake.fail("state", 1, "x"); }
                1 => { fake.set("state", "nope\n"); }
                _ => {}
            }
            let outcome = start_verified(&start_input(&fake, &[("c1", "api"), ("c2", "db")], &["api", "db"], Some(depends)), &Cancel::default()).await;
            assert_eq!(outcome.result.exit_code, 1, "{name}");
            assert!(outcome.result.stderr.starts_with("dependency failed to start: db의 상태를"), "{name}: {}", outcome.result.stderr);
            assert!(!fake.calls().iter().any(|call| call == "start c1"), "{name}");
        }
    }

    #[tokio::test]
    async fn 시작이_비0으로_끝나면_거기서_멈춘다() {
        let fake = Fake::new();
        fake.fail("start", 1, "port is already allocated");
        let outcome = start_verified(&start_input(&fake, &[("c1", "api"), ("c2", "db")], &["api", "db"], Some("{}")), &Cancel::default()).await;
        assert_eq!(outcome.result.exit_code, 1);
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn 의존_순서를_모르면_시작하지_않는다() {
        let fake = Fake::new();
        let outcome = start_verified(&start_input(&fake, &[("c1", "api"), ("c2", "db")], &["api", "db"], None), &Cancel::default()).await;
        assert_eq!(outcome.result.exit_code, 1);
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 기다리는_중에_취소하면_끝나고_다음_묶음을_시작하지_않는다() {
        let fake = Fake::new();
        fake.set("state", "{\"Status\":\"running\",\"Health\":{\"Status\":\"starting\"}}\n");
        let depends = "{\"api\":{\"db\":{\"condition\":\"service_healthy\"}}}";
        let mut input = start_input(&fake, &[("c1", "api"), ("c2", "db")], &["api", "db"], Some(depends));
        input.wait_ms = 60_000;
        input.poll_ms = 20;
        let cancel = std::sync::Arc::new(Cancel::default());
        let trigger = cancel.clone();
        let calls_file = fake.dir.path().join("calls");
        // 첫 의존 상태 조회가 시작된 뒤(= 기다리는 중)에 취소한다. 시간이 아니라 부른 명령을 보고 정한다
        tokio::spawn(async move {
            loop {
                if fs::read_to_string(&calls_file).unwrap_or_default().contains("inspect --format") {
                    trigger.cancel();
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        let outcome = tokio::time::timeout(Duration::from_secs(60), start_verified(&input, &cancel)).await.expect("취소하면 끝나야 한다");
        assert!(outcome.aborted, "{outcome:?}");
        assert!(!fake.calls().iter().any(|call| call == "start c1"));
    }

    #[test]
    fn 파일_경로_도우미가_쓰는_폴더가_임시_폴더_안이다() {
        // 가짜 docker는 임시 폴더에만 쓴다
        let fake = Fake::new();
        assert!(Path::new(&fake.bin()).starts_with(fake.dir.path()));
    }
}
