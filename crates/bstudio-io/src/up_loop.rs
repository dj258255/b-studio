//! 컨테이너 만들기 반복(옛 TS: `LocalDockerProvider.#upOnce`·`#refreshGitMask`·`#writeOverride`, `git-mask.ts`의 `loadGitMask`·`computeGitMask`.
//! ADR-195 4f A4c-1).
//!
//! 판정은 `bstudio_guard::up_loop`(와 `git_mask`·`container_verify`·`compose_override`)가 하고, 여기는 docker를 부르는 순서와 파일을 읽고 쓰는 일만 한다.
//! **반복 전체가 함수 하나(`up_with_git_mask`)다.** 시도마다 마운트를 읽어 마스크를 계산하고(`compose config`) → override를 쓰고(임시 파일 + rename)
//! → `up --no-start`로 만들고 → 마스크를 다시 계산해 바뀌었으면 처음부터 → 만든 컨테이너를 확인하고(`verify_containers`) → 확인한 컨테이너만
//! 시작하고 → 시작한 뒤 다시 확인한다. 안정되지 않으면 `down --remove-orphans` 후 멈춘다.
//! **쓴 것 = 확인한 것**: 확인에 넘기는 마스크는 이 함수 안의 `mask` 한 값이고, override 파일은 그 값으로만 쓴다(쓰기가 실패하면 `mask`를
//! 새 값으로 올리지 않는다). 돌려주는 마스크도 그 값이다.
//!
//! 막는 쪽/여는 쪽: 이 모듈은 모두 막는 쪽이다. 아래는 통과가 아니라 실패로 돌려준다 — `compose config`의 비0 종료·해석 실패·모양 모름, 상태 폴더 준비 실패,
//! 평가 자산 자리 위의 깊은 마운트, override 만들기·쓰기·rename 실패, 마스크가 시도 안에서 계속 바뀜, 확인하지 못한 컨테이너.
//!
//! 확인하는 쪽과 실제로 쓰는 쪽이 같은 입력을 다르게 읽는 자리(점검한 것):
//!  - `compose config`는 override 없이 읽는다(마운트는 사용자 compose가 정한다). `up`은 override까지 읽는다. 같은 파일·프로젝트 이름·프로젝트 폴더·환경으로 읽는다
//!  - 호스트 경로: 마운트 원본과 프로젝트 폴더는 링크를 풀어(`real_path`) 계획하고, 확인할 때(`container_verify`)도 같은 함수로 푼다
//!  - override는 JSON으로 쓴다. compose는 YAML로 읽는다. YAML이 거부하거나 줄바꿈으로 접는 글자는 `\uXXXX`로 쓴다(`yaml_safe_json`)
//!  - 임시 파일은 `create_new`로 만든다(이미 있는 파일이나 링크를 따라가 덮어쓰지 않는다)

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

use bstudio_guard::git_mask::{self, AssetCopy, ComposeMount, GitEntry as PlanEntry, Mount};
use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::up_loop::{self as judge, Mask, GIT_MASK_ATTEMPTS};
use bstudio_guard::{compose_deps, compose_helpers};
use serde_json::Value;

use crate::container_verify::{start_verified, verify_containers, Cancel, StartInput, VerifiedContainer, VerifyFailure, VerifyInput, VerifyOutcome};
use crate::git_mask_fs::{detect_git_entries, prepare_state_masks, real_path};
use crate::process::{run_command, run_command_with_limit};
use crate::stream_exec::ExecOutput;

/// `compose config`를 읽을 대상. `up`을 부르는 쪽과 같은 파일·프로젝트 이름·프로젝트 폴더·환경이다(프로필만 모두 켠다)
#[derive(Debug, Clone)]
pub struct ComposeRef {
    pub docker_bin: String,
    pub env: Option<Vec<(String, String)>>,
    pub project_root: String,
    pub compose_path: String,
    pub project_name: Option<String>,
}

impl ComposeRef {
    fn config_args(&self) -> Vec<String> {
        let mut args = vec!["compose".to_owned()];
        if let Some(name) = self.project_name.as_deref().filter(|name| !name.is_empty()) {
            args.push("--project-name".to_owned());
            args.push(name.to_owned());
        }
        for part in ["--profile", "*", "--project-directory", &self.project_root, "--file", &self.compose_path, "config", "--format", "json"] {
            args.push(part.to_owned());
        }
        args
    }
}

/// 마스크를 계산하지 못한 이유. TS가 옛 글 그대로의 `SandboxError`로 바꾼다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskError {
    pub message: String,
    pub detail: Option<String>,
    pub platform: bool,
}

fn mask_error(message: impl Into<String>) -> MaskError {
    MaskError { message: message.into(), detail: None, platform: false }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadProblem {
    /// `compose config`가 비0으로 끝났다(가리기 전 stderr 원문)
    ConfigFailed(String),
    /// 출력을 해석하지 못했거나 모양을 모른다
    ConfigUnparsed,
    Mask(MaskError),
}

async fn read_compose_config(compose: &ComposeRef) -> Result<Value, LoadProblem> {
    let result = run_command(&compose.docker_bin, &compose.config_args(), None, compose.env.as_deref(), None, std::future::pending::<()>()).await;
    if result.exit_code != 0 {
        return Err(LoadProblem::ConfigFailed(result.stderr));
    }
    judge::config_from_stdout(&result.stdout).ok_or(LoadProblem::ConfigUnparsed)
}

/// `compose config`를 읽어 서비스별 마스크 마운트를 계산한다(옛 TS `loadGitMask`). 읽지 못하면 막을 자리를 알 수 없으므로 보호 없이 띄우지 않는다
pub async fn load_git_mask(compose: &ComposeRef, assets: &[AssetCopy], cwd: &str) -> Result<Mask, LoadProblem> {
    let config = read_compose_config(compose).await?;
    compute_git_mask(&compose.project_root, &config, assets, cwd).await.map_err(LoadProblem::Mask)
}

fn plan_entry(entry: crate::git_mask_fs::GitEntry) -> PlanEntry {
    PlanEntry { dir: entry.dir, kind: entry.kind, has_state: entry.has_state, aliases: entry.aliases }
}

/// 정규화한 compose 설정에서 서비스별 마스크 마운트를 계산한다(옛 TS `computeGitMask`). 마운트 원본은 링크를 풀어 `.git` 위치와 같은 꼴로 맞춘다.
/// `assets`가 있으면 평가 자산 마스크도 함께 계산한다(같은 target이면 `.git` 쪽 규칙이 이긴다). 모양을 모르는 설정은 실패다
pub async fn compute_git_mask(project_root: &str, config: &Value, assets: &[AssetCopy], cwd: &str) -> Result<Mask, MaskError> {
    let root = real_path(project_root, cwd).await;
    let mut mounts: Vec<Mount> = git_mask::collect_host_mounts(cwd, config).map_err(mask_error)?;
    for mount in &mut mounts {
        mount.source = real_path(&mount.source, cwd).await;
    }
    let sources: Vec<String> = mounts.iter().map(|mount| mount.source.clone()).collect();
    let mut found = detect_git_entries(&root, &sources, cwd).await;
    // b-studio가 만든 체크포인트 저장소인데 상태 폴더가 아직 없으면 미리 빈 폴더로 만들어 둔다. 만들지 못하면 멈춘다
    if let Err(failure) = prepare_state_masks(&mut found).await {
        return Err(MaskError { message: format!("{} 폴더를 가릴 빈 폴더를 준비하지 못했습니다", failure.state), detail: Some(failure.detail), platform: true });
    }
    let entries: Vec<PlanEntry> = found.into_iter().map(plan_entry).collect();
    let git_plan = git_mask::plan_git_mask(cwd, &mounts, &entries);
    // 목록은 선언에서만 정한다(작업 복사본의 지금 상태를 보지 않는다)
    if assets.is_empty() {
        return Ok(git_plan);
    }
    // 사용자 compose가 평가 자산 자리 위에 더 깊은 마운트를 얹으면 우리 복사본 위에 그 내용이 덮인다. bind뿐 아니라 tmpfs·이름 있는 볼륨까지 본다
    let specs = git_mask::compose_mount_specs(cwd, config).map_err(mask_error)?;
    let mut compose_mounts = Vec::with_capacity(specs.len());
    for spec in specs {
        let host_source = match spec.host {
            Some(host) => Some(real_path(&host, cwd).await),
            None => None,
        };
        compose_mounts.push(ComposeMount { service: spec.service, kind: spec.kind, target: spec.target, host_source });
    }
    if let Some(problem) = git_mask::nested_asset_mount_error(cwd, &compose_mounts, &mounts, &root, assets) {
        return Err(mask_error(problem));
    }
    let asset_plan = git_mask::plan_evaluation_asset_mask(cwd, &mounts, &root, assets);
    Ok(git_mask::merge_masks(vec![asset_plan, git_plan]))
}

// ── override 쓰기 ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteProblem {
    /// override를 만들지 못했다(입력의 모양이 어긋남). 옛 TS에서는 `buildOverride`가 던진 오류
    Build(String),
    /// 임시 파일을 쓰지 못했거나 바꿔 넣지 못했다
    Write(String),
}

fn random_hex() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    hasher.write_u32(std::process::id());
    format!("{:08x}", hasher.finish() as u32)
}

/// 임시 파일을 새로 만든다. 같은 이름의 파일이나 링크가 이미 있으면 따라가 쓰지 않고 실패한다(`create_new`)
async fn create_temporary(path: &str) -> std::io::Result<tokio::fs::File> {
    tokio::fs::OpenOptions::new().write(true).create_new(true).open(path).await
}

/// 마스크를 얹은 override를 JSON으로 임시 파일(`<path>.<랜덤 hex>.tmp`)에 쓴 뒤 `rename`으로 바꿔 넣는다. 다른 compose 호출이 반쯤 쓰인 파일을 읽지 않는다.
/// 파일 이름은 그대로 `compose.override.yaml`이다(YAML은 JSON을 포함한다). 쓰지 못하면 실패다 — 부르는 쪽이 쓰지 못한 마스크로 만들지 않는다
pub async fn write_override(path: &str, input: &JsValue, mask: &Mask) -> Result<(), WriteProblem> {
    let with_mask = judge::with_git_mask(input, mask).ok_or_else(|| WriteProblem::Build("override 입력은 객체여야 합니다".to_owned()))?;
    let built = bstudio_guard::compose_override::build_override(&with_mask).map_err(WriteProblem::Build)?;
    let text = judge::yaml_safe_json(&js_json::stringify(&built));
    let mut last = String::new();
    for _ in 0..8 {
        let temporary = format!("{path}.{}.tmp", random_hex());
        let created = create_temporary(&temporary).await;
        let mut file = match created {
            Ok(file) => file,
            // 같은 이름이 이미 있다. 덮어쓰지 않고 다른 이름으로 다시 한다
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last = error.to_string();
                continue;
            }
            Err(error) => return Err(WriteProblem::Write(error.to_string())),
        };
        let written = tokio::io::AsyncWriteExt::write_all(&mut file, text.as_bytes()).await;
        drop(file);
        if let Err(error) = written {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(WriteProblem::Write(error.to_string()));
        }
        if let Err(error) = tokio::fs::rename(&temporary, path).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(WriteProblem::Write(error.to_string()));
        }
        return Ok(());
    }
    Err(WriteProblem::Write(last))
}

// ── 만들기 반복 ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Created,
    Started,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Created => "created",
            Phase::Started => "started",
        }
    }
}

pub struct UpInput {
    pub compose: ComposeRef,
    pub cwd: String,
    /// override 파일의 경로(`compose.override.yaml`)
    pub override_path: String,
    /// `buildOverride`의 입력에서 `gitMask`만 뺀 것. 마스크는 이 함수가 얹는다
    pub override_input: JsValue,
    /// 지금 override 파일에 쓰여 있는 마스크
    pub mask: Mask,
    pub assets: Vec<AssetCopy>,
    /// `compose up`의 인자(`up` 자신과 옵션, 서비스 이름 포함)
    pub args: Vec<String>,
    pub sandbox_network: String,
    pub egress_network: String,
    pub edge_service: String,
    pub studio_caller: String,
    pub service_label: String,
    pub poll_ms: u64,
    pub wait_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DepsProblem {
    /// `compose config`가 비0으로 끝났다(가리기 전 stderr 원문. 비어 있을 수 있다)
    Failed(String),
    Unparsed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpOutcome {
    /// 만들기나 시작이 compose 실패로 끝났거나(그 결과 그대로), 확인까지 모두 통과했다(`exit_code == 0`)
    Done(ExecOutput),
    /// 취소됐다(부르는 쪽이 취소를 그대로 던진다)
    Aborted,
    Load(LoadProblem),
    Override(WriteProblem),
    /// 확인에서 실패했다. 위반 컨테이너는 이미 지웠다
    Verify { failure: VerifyFailure, phase: Phase },
    /// 확인한 목록에서 찾지 못한 서비스. 아무것도 시작하지 않았다
    Missing(Vec<String>),
    Deps(DepsProblem),
    /// 마스크가 시도 안에서 안정되지 않았다. 스택을 내렸다
    NotStable,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpResult {
    /// override 파일에 마지막으로 **쓴** 마스크. 실패해도 돌려준다(부르는 쪽이 자기 상태를 이 값으로 맞춘다)
    pub mask: Mask,
    pub outcome: UpOutcome,
}

async fn docker(compose: &ComposeRef, args: &[String], cancel: Option<&Cancel>) -> ExecOutput {
    let env = compose.env.as_deref();
    match cancel {
        Some(cancel) => run_command(&compose.docker_bin, args, None, env, None, cancel.cancelled()).await,
        None => run_command(&compose.docker_bin, args, None, env, None, std::future::pending::<()>()).await,
    }
}

fn compose_args(input: &UpInput, rest: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec!["compose".to_owned(), "--project-name".to_owned(), input.compose.project_name.clone().unwrap_or_default()];
    for part in ["--project-directory", &input.compose.project_root, "--file", &input.compose.compose_path, "--file", &input.override_path] {
        args.push(part.to_owned());
    }
    args.extend(rest.iter().cloned());
    args
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

/// compose 파일의 마운트를 다시 읽어 마스크가 달라졌으면 override를 새로 쓴다. 읽지 못하면 보호 없이 띄우지 않고 멈춘다.
/// 쓰지 못하면 `mask`를 올리지 않는다(`mask`는 파일에 쓰인 값이다)
async fn refresh(input: &UpInput, mask: &mut Mask) -> Result<(), UpOutcome> {
    let next = load_git_mask(&input.compose, &input.assets, &input.cwd).await.map_err(UpOutcome::Load)?;
    if judge::masks_equal(&next, mask) {
        return Ok(());
    }
    write_override(&input.override_path, &input.override_input, &next).await.map_err(UpOutcome::Override)?;
    *mask = next;
    Ok(())
}

async fn verify(input: &UpInput, mask: &Mask, phase: Phase) -> Result<Vec<VerifiedContainer>, UpOutcome> {
    let verify_input = VerifyInput {
        docker_bin: input.compose.docker_bin.clone(),
        env: input.compose.env.clone(),
        list_args: compose_args(input, &strings(&["ps", "--all", "--quiet", "--no-trunc"])),
        project_root: input.compose.project_root.clone(),
        cwd: input.cwd.clone(),
        project_name: input.compose.project_name.clone().unwrap_or_default(),
        sandbox_network: input.sandbox_network.clone(),
        egress_network: input.egress_network.clone(),
        edge_service: input.edge_service.clone(),
        studio_caller: input.studio_caller.clone(),
        service_label: input.service_label.clone(),
        // 확인하는 마스크는 override에 쓴 그 값이다
        git_mask: mask.clone(),
        assets: input.assets.clone(),
    };
    match verify_containers(&verify_input).await {
        VerifyOutcome::Verified(containers) => Ok(containers),
        VerifyOutcome::Failed(failure) => Err(UpOutcome::Verify { failure, phase }),
    }
}

/// 서비스 사이의 의존 관계를 읽는다(옛 TS `loadDependsOn`). 출력 상한은 64MB다
async fn load_depends_on(compose: &ComposeRef) -> Result<JsValue, DepsProblem> {
    let result = run_command_with_limit(&compose.docker_bin, &compose.config_args(), None, compose.env.as_deref(), None, std::future::pending::<()>(), 64 * 1024 * 1024).await;
    if result.exit_code != 0 {
        return Err(DepsProblem::Failed(result.stderr));
    }
    let parsed = js_json::parse(&result.stdout).map_err(|_| DepsProblem::Unparsed)?;
    Ok(compose_deps::parse_depends_on(&parsed))
}

/// 컨테이너는 up이 만들 때 마운트가 정해진다. compose 파일은 에이전트가 세션 중에 고칠 수 있으므로 시도마다 마운트를 다시 읽어 `.git` 마스크를 맞추고,
/// 만든 뒤 한 번 더 읽어 바뀌었으면 다시 올리며, 결과(실제 컨테이너의 마운트)를 시작하기 전에 확인한다. 확인한 컨테이너만 시작하고 시작한 뒤 다시 확인한다
pub async fn up_with_git_mask(input: &UpInput, cancel: &Cancel) -> UpResult {
    let mut mask = input.mask.clone();
    let outcome = attempts(input, cancel, &mut mask).await;
    UpResult { mask, outcome }
}

async fn attempts(input: &UpInput, cancel: &Cancel, mask: &mut Mask) -> UpOutcome {
    let split = compose_helpers::split_up_args(&input.args);
    for _ in 1..=GIT_MASK_ATTEMPTS {
        if cancel.is_cancelled() {
            return UpOutcome::Aborted;
        }
        if let Err(outcome) = refresh(input, mask).await {
            return outcome;
        }
        // 빌드 실패는 여기서 난다(`--build`는 만들기 단계에만 준다)
        let created = docker(&input.compose, &compose_args(input, &split.create), Some(cancel)).await;
        if created.exit_code != 0 {
            return UpOutcome::Done(created);
        }
        let before = mask.clone();
        if let Err(outcome) = refresh(input, mask).await {
            return outcome;
        }
        if !judge::masks_equal(&before, mask) {
            continue;
        }
        let verified = match verify(input, mask, Phase::Created).await {
            Ok(verified) => verified,
            Err(outcome) => return outcome,
        };
        // 포트 바인드 충돌은 여기서 난다(바인드는 시작할 때 일어난다)
        let started = if split.by_id {
            let depends_on = if split.services.len() == 1 {
                None
            } else {
                match load_depends_on(&input.compose).await {
                    Ok(depends_on) => Some(depends_on),
                    Err(problem) => return UpOutcome::Deps(problem),
                }
            };
            let start_input = StartInput {
                docker_bin: input.compose.docker_bin.clone(),
                env: input.compose.env.clone(),
                verified,
                services: split.services.clone(),
                depends_on,
                poll_ms: input.poll_ms,
                wait_ms: input.wait_ms,
            };
            let outcome = start_verified(&start_input, cancel).await;
            if !outcome.missing.is_empty() {
                return UpOutcome::Missing(outcome.missing);
            }
            if outcome.aborted {
                return UpOutcome::Aborted;
            }
            outcome.result
        } else {
            let mut rest = vec!["start".to_owned()];
            rest.extend(split.services.iter().cloned());
            docker(&input.compose, &compose_args(input, &rest), Some(cancel)).await
        };
        if started.exit_code != 0 {
            return UpOutcome::Done(started);
        }
        if let Err(outcome) = verify(input, mask, Phase::Started).await {
            return outcome;
        }
        return UpOutcome::Done(started);
    }
    // 내린 결과는 보지 않는다. 어느 쪽이든 마스크를 확정하지 못했다
    let _ = docker(&input.compose, &compose_args(input, &strings(&["down", "--remove-orphans"])), Some(cancel)).await;
    UpOutcome::NotStable
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    /// 가짜 docker. 명령(`config`·`up`·`ps`·`inspect`·`volume`·`rm`·`startid`(docker start)·`start`(compose start)·`down`)마다 `<키>.<호출 번호>.out`(없으면 `<키>.out`)을
    /// 읽어 흉내 내고, 부른 인자를 `calls`에 남긴다
    struct Fake {
        dir: tempfile::TempDir,
    }

    impl Fake {
        fn new() -> Fake {
            let dir = tempfile::tempdir().unwrap();
            let script = format!(
                r#"#!/bin/sh
D='{}'
printf '%s\n' "$*" >> "$D/calls"
key=other
case "$1" in
  inspect) key=inspect; [ "$2" = --format ] && key=state ;;
  volume) key=volume ;;
  rm) key=rm ;;
  start) key=startid ;;
  compose) for a in "$@"; do case "$a" in config) key=config ;; up) key=up ;; ps) key=ps ;; down) key=down ;; start) key=start ;; esac; done ;;
esac
n=$(cat "$D/n.$key" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$D/n.$key"
pick() {{ if [ -f "$D/$key.$n.$1" ]; then cat "$D/$key.$n.$1"; elif [ -f "$D/$key.$1" ]; then cat "$D/$key.$1"; fi; }}
pick out
pick err >&2
code=$(pick code)
exit ${{code:-0}}
"#,
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

        /// 호출의 첫 단어나 `compose`의 명령 단어만 남긴다(경로 인자를 빼고 순서만 견준다)
        fn verbs(&self) -> Vec<String> {
            self.calls()
                .into_iter()
                .map(|call| {
                    let words: Vec<&str> = call.split(' ').collect();
                    if words[0] == "compose" {
                        ["config", "up", "ps", "down", "start"].iter().find(|verb| words.contains(verb)).map(|verb| format!("compose {verb}")).unwrap_or_else(|| "compose".to_owned())
                    } else {
                        words[0].to_owned()
                    }
                })
                .collect()
        }
    }

    struct Project {
        dir: tempfile::TempDir,
        root: String,
        copy: String,
        override_path: String,
    }

    fn project() -> Project {
        let dir = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(dir.path()).unwrap();
        let root = base.join("proj");
        fs::create_dir_all(root.join(".git/b-studio")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n[b-studio]\n\tstart = x\n").unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();
        fs::write(root.join("tests/acceptance"), "x").unwrap();
        let copy = base.join("copy");
        fs::write(&copy, "x").unwrap();
        let override_path = base.join("compose.override.yaml");
        Project { root: root.to_string_lossy().into_owned(), copy: copy.to_string_lossy().into_owned(), override_path: override_path.to_string_lossy().into_owned(), dir }
    }

    fn config_for(project: &Project, target: &str) -> String {
        json!({ "services": { "api": { "volumes": [{ "type": "bind", "source": project.root, "target": target }] } } }).to_string()
    }

    fn container(project: &Project, mounts: Vec<Value>) -> Value {
        let _ = project;
        json!({ "Id": "c1", "Name": "/c1", "Config": { "Labels": { "com.docker.compose.service": "api" } }, "HostConfig": { "NetworkMode": "studio-p_b-studio-sandbox" },
            "NetworkSettings": { "Networks": { "studio-p_b-studio-sandbox": {} } }, "Mounts": mounts })
    }

    fn ok_mounts(project: &Project, target: &str) -> Vec<Value> {
        vec![
            json!({ "Type": "bind", "Source": project.root, "Destination": target, "RW": true }),
            json!({ "Type": "bind", "Source": format!("{}/.git", project.root), "Destination": format!("{target}/.git"), "RW": false }),
            json!({ "Type": "bind", "Source": format!("{}/.git/b-studio-empty", project.root), "Destination": format!("{target}/.git/b-studio"), "RW": false }),
        ]
    }

    fn override_input() -> JsValue {
        js_json::parse(r#"{"name":"p","managed":[],"services":[],"sandboxId":"studio-p","edgeScript":"","hostPorts":{}}"#).unwrap()
    }

    fn input(fake: &Fake, project: &Project, mask: Mask, assets: Vec<AssetCopy>, args: &[&str]) -> UpInput {
        UpInput {
            compose: ComposeRef {
                docker_bin: fake.bin(),
                env: None,
                project_root: project.root.clone(),
                compose_path: format!("{}/compose.yaml", project.root),
                project_name: Some("studio-p".to_owned()),
            },
            cwd: "/".to_owned(),
            override_path: project.override_path.clone(),
            override_input: override_input(),
            mask,
            assets,
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            sandbox_network: "b-studio-sandbox".into(),
            egress_network: "b-studio-egress".into(),
            edge_service: "b-studio-edge".into(),
            studio_caller: "studio".into(),
            service_label: "com.docker.compose.service".into(),
            poll_ms: 1,
            wait_ms: 20,
        }
    }

    const BY_ID: [&str; 4] = ["up", "--detach", "--no-deps", "api"];

    fn prepared() -> (Fake, Project) {
        let fake = Fake::new();
        let project = project();
        fake.set("config", &config_for(&project, "/app")).set("ps", "c1\n").set("volume", "[]");
        fake.set("inspect", &json!([container(&project, ok_mounts(&project, "/app"))]).to_string());
        (fake, project)
    }

    async fn up(input: &UpInput) -> UpResult {
        up_with_git_mask(input, &Cancel::default()).await
    }

    #[tokio::test]
    async fn 정상이면_만들고_확인하고_시작하고_다시_확인한다() {
        let (fake, project) = prepared();
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
        assert_eq!(result.outcome, UpOutcome::Done(ExecOutput { exit_code: 0, stdout: String::new(), stderr: String::new() }));
        assert_eq!(
            fake.verbs(),
            ["compose config", "compose up", "compose config", "compose ps", "inspect", "start", "compose ps", "inspect"],
            "{:?}",
            fake.calls()
        );
        // 만들기 인자: --no-start가 붙고 --detach가 빠진다
        assert!(fake.calls()[1].ends_with("up --no-start --no-deps api"), "{:?}", fake.calls());
        // 마스크가 계산돼 override에 쓰였고 돌려준 값과 같다
        assert!(!result.mask.is_empty());
        let written: Value = serde_json::from_str(&fs::read_to_string(&project.override_path).unwrap()).unwrap();
        assert_eq!(written["services"]["api"]["volumes"], serde_json::to_value(&result.mask[0].1).unwrap());
        drop(project.dir);
    }

    #[tokio::test]
    async fn 처음_마스크가_이미_같으면_다시_쓰지_않는다() {
        let (fake, project) = prepared();
        let first = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
        let before = fs::metadata(&project.override_path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = up(&input(&fake, &project, first.mask.clone(), Vec::new(), &BY_ID)).await;
        assert_eq!(second.mask, first.mask);
        assert_eq!(fs::metadata(&project.override_path).unwrap().modified().unwrap(), before);
    }

    #[tokio::test]
    async fn 시도_안에서_마스크가_계속_바뀌면_내리고_멈춘다() {
        let (fake, project) = prepared();
        for (n, target) in ["/a", "/b", "/c", "/d", "/e", "/f"].iter().enumerate() {
            fake.set(&format!("config.{}", n + 1), &config_for(&project, target));
        }
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
        assert_eq!(result.outcome, UpOutcome::NotStable);
        let verbs = fake.verbs();
        assert_eq!(verbs.last().map(String::as_str), Some("compose down"));
        // 확인도 시작도 하지 않았다
        assert!(!verbs.iter().any(|verb| verb == "inspect" || verb == "start"), "{verbs:?}");
        assert_eq!(verbs.iter().filter(|verb| *verb == "compose up").count(), 3);
        assert!(fake.calls().last().unwrap().ends_with("down --remove-orphans"));
    }

    #[tokio::test]
    async fn override를_쓰지_못하면_마스크를_올리지_않고_만들지_않는다() {
        let (fake, project) = prepared();
        let mut bad = input(&fake, &project, Vec::new(), Vec::new(), &BY_ID);
        bad.override_path = format!("{}/missing/compose.override.yaml", project.root);
        let result = up(&bad).await;
        assert!(matches!(result.outcome, UpOutcome::Override(WriteProblem::Write(_))), "{:?}", result.outcome);
        assert!(result.mask.is_empty());
        assert!(!fake.verbs().iter().any(|verb| verb == "compose up"));
    }

    #[tokio::test]
    async fn 확인에는_방금_쓴_마스크를_넘긴다() {
        // 평가 자산 자리의 기대는 마스크(계획)에서 온다. 처음 마스크는 비어 있으니 새로 계산한 마스크를 넘겨야 복사본이 빠진 것을 잡는다
        let (fake, project) = prepared();
        let assets = vec![AssetCopy { path: "tests/acceptance".into(), source: project.copy.clone() }];
        let result = up(&input(&fake, &project, Vec::new(), assets.clone(), &BY_ID)).await;
        match &result.outcome {
            UpOutcome::Verify { failure, phase } => {
                assert_eq!(*phase, Phase::Created);
                assert_eq!(failure.kind.as_str(), "mask");
                assert!(failure.detail.as_deref().unwrap_or_default().contains("/app/tests/acceptance"), "{failure:?}");
            }
            other => panic!("{other:?}"),
        }
        // 복사본이 마운트돼 있으면 통과한다
        let mut mounts = ok_mounts(&project, "/app");
        mounts.push(json!({ "Type": "bind", "Source": project.copy, "Destination": "/app/tests/acceptance", "RW": false }));
        fake.set("inspect", &json!([container(&project, mounts)]).to_string());
        let again = up(&input(&fake, &project, Vec::new(), assets, &BY_ID)).await;
        assert!(matches!(again.outcome, UpOutcome::Done(_)), "{:?}", again.outcome);
    }

    #[tokio::test]
    async fn compose_config의_실패는_모두_멈춘다() {
        let (fake, project) = prepared();
        fake.fail("config", 1, "nope");
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
        assert_eq!(result.outcome, UpOutcome::Load(LoadProblem::ConfigFailed("nope".into())));
        for bad in ["", "null", "[]", "5", "{", "not json"] {
            let (fake, project) = prepared();
            fake.set("config", bad);
            let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
            assert_eq!(result.outcome, UpOutcome::Load(LoadProblem::ConfigUnparsed), "{bad:?}");
            assert!(!fake.verbs().iter().any(|verb| verb == "compose up"), "{bad:?}");
        }
        let (fake, project) = prepared();
        fake.set("config", r#"{"services":{"api":{"volumes":"x"}}}"#);
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
        assert!(matches!(result.outcome, UpOutcome::Load(LoadProblem::Mask(_))), "{:?}", result.outcome);
    }

    #[tokio::test]
    async fn 상태_폴더_자리를_비울_수_없으면_멈춘다() {
        let (fake, project) = prepared();
        fs::create_dir_all(Path::new(&project.root).join(".git/b-studio-empty")).unwrap();
        fs::write(Path::new(&project.root).join(".git/b-studio-empty/x"), "x").unwrap();
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
        match result.outcome {
            UpOutcome::Load(LoadProblem::Mask(error)) => {
                assert!(error.message.ends_with("폴더를 가릴 빈 폴더를 준비하지 못했습니다"), "{error:?}");
                assert!(error.platform);
            }
            other => panic!("{other:?}"),
        }
        assert!(!fake.verbs().iter().any(|verb| verb == "compose up"));
    }

    #[tokio::test]
    async fn 평가_자산_위의_깊은_마운트는_멈춘다() {
        let (fake, project) = prepared();
        let assets = vec![AssetCopy { path: "tests/acceptance".into(), source: project.copy.clone() }];
        fake.set("config", &json!({ "services": { "api": { "volumes": [{ "type": "bind", "source": project.root, "target": "/app" }], "tmpfs": ["/app/tests/acceptance"] } } }).to_string());
        let result = up(&input(&fake, &project, Vec::new(), assets, &BY_ID)).await;
        match result.outcome {
            UpOutcome::Load(LoadProblem::Mask(error)) => assert!(error.message.contains("평가 자산 자리"), "{error:?}"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn 이미_취소됐으면_아무것도_부르지_않는다() {
        let (fake, project) = prepared();
        let cancel = Cancel::default();
        cancel.cancel();
        let result = up_with_git_mask(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID), &cancel).await;
        assert_eq!(result.outcome, UpOutcome::Aborted);
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 확인한_목록에_없는_서비스는_시작하지_않는다() {
        let (fake, project) = prepared();
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &["up", "--detach", "--no-deps", "ghost"])).await;
        assert_eq!(result.outcome, UpOutcome::Missing(vec!["ghost".into()]));
        assert!(!fake.verbs().iter().any(|verb| verb == "start"));
    }

    #[tokio::test]
    async fn 만들기가_실패하면_그_결과를_돌려준다_확인도_시작도_없다() {
        let (fake, project) = prepared();
        fake.fail("up", 2, "build failed");
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
        assert_eq!(result.outcome, UpOutcome::Done(ExecOutput { exit_code: 2, stdout: String::new(), stderr: "build failed".into() }));
        assert!(!fake.verbs().iter().any(|verb| verb == "inspect" || verb == "start"));
    }

    #[tokio::test]
    async fn 시작한_뒤_확인에서_가림이_빠지면_실패한다() {
        let (fake, project) = prepared();
        fake.set("inspect.2", &json!([container(&project, vec![ok_mounts(&project, "/app").remove(0)])]).to_string());
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &BY_ID)).await;
        match result.outcome {
            UpOutcome::Verify { failure, phase } => {
                assert_eq!(phase, Phase::Started);
                assert_eq!(failure.kind.as_str(), "mask");
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn 전체_up은_compose_start로_시작한다() {
        let (fake, project) = prepared();
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &["up", "--detach"])).await;
        assert!(matches!(result.outcome, UpOutcome::Done(_)));
        assert!(fake.verbs().iter().any(|verb| verb == "compose start"), "{:?}", fake.verbs());
        assert!(!fake.verbs().iter().any(|verb| verb == "start"));
    }

    #[tokio::test]
    async fn 서비스_둘의_의존_순서를_읽지_못하면_시작하지_않는다() {
        let (fake, project) = prepared();
        fake.set("config", &json!({ "services": { "api": { "volumes": [{ "type": "bind", "source": project.root, "target": "/app" }] },
            "worker": { "volumes": [{ "type": "bind", "source": project.root, "target": "/app" }] } } }).to_string());
        fake.set("ps", "c1\nc2\n");
        let mut second = container(&project, ok_mounts(&project, "/app"));
        second["Id"] = json!("c2");
        second["Config"]["Labels"]["com.docker.compose.service"] = json!("worker");
        fake.set("inspect", &json!([container(&project, ok_mounts(&project, "/app")), second]).to_string());
        fake.fail("config.3", 1, "deps");
        let result = up(&input(&fake, &project, Vec::new(), Vec::new(), &["up", "--detach", "--no-deps", "api", "worker"])).await;
        assert_eq!(result.outcome, UpOutcome::Deps(DepsProblem::Failed("deps".into())));
        assert!(!fake.verbs().iter().any(|verb| verb == "start"));
    }

    #[tokio::test]
    async fn write_override는_json을_쓰고_임시_파일을_남기지_않는다() {
        let project = project();
        write_override(&project.override_path, &override_input(), &Vec::new()).await.unwrap();
        let text = fs::read_to_string(&project.override_path).unwrap();
        assert!(text.starts_with('{'));
        assert!(serde_json::from_str::<Value>(&text).is_ok());
        let names: Vec<String> = fs::read_dir(Path::new(&project.override_path).parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(!names.iter().any(|name| name.ends_with(".tmp")), "{names:?}");
    }

    #[tokio::test]
    async fn write_override가_실패하면_옛_파일을_건드리지_않고_임시_파일을_지운다() {
        let project = project();
        write_override(&project.override_path, &override_input(), &Vec::new()).await.unwrap();
        let before = fs::read_to_string(&project.override_path).unwrap();
        // 바꿔 넣을 자리를 비어 있지 않은 폴더로 막는다(rename 실패)
        let blocked = format!("{}/blocked", project.root);
        fs::create_dir_all(format!("{blocked}/inner")).unwrap();
        let error = write_override(&blocked, &override_input(), &Vec::new()).await.unwrap_err();
        assert!(matches!(error, WriteProblem::Write(_)), "{error:?}");
        assert_eq!(fs::read_to_string(&project.override_path).unwrap(), before);
        let names: Vec<String> = fs::read_dir(&project.root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(!names.iter().any(|name| name.ends_with(".tmp")), "{names:?}");
        // 입력의 모양이 어긋나면 만들지 못한다
        assert!(matches!(write_override(&project.override_path, &JsValue::Null, &Vec::new()).await, Err(WriteProblem::Build(_))));
        assert_eq!(fs::read_to_string(&project.override_path).unwrap(), before);
    }

    #[tokio::test]
    async fn 임시_파일_이름이_이미_있으면_덮어쓰지_않는다() {
        // create_new로 열기 때문에 미리 만들어 둔 같은 이름의 파일이나 링크를 따라가 쓰지 않는다. 여기서는 이름이 겹칠 수 없으므로 열기 방식만 확인한다
        let project = project();
        let target = format!("{}/victim", project.root);
        fs::write(&target, "keep").unwrap();
        let link = format!("{}/link.tmp", project.root);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(create_temporary(&link).await.is_err());
        assert!(create_temporary(&target).await.is_err());
        assert!(create_temporary(&format!("{}/fresh.tmp", project.root)).await.is_ok());
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
    }

    #[tokio::test]
    async fn compute_git_mask는_서비스가_없으면_빈_마스크다() {
        let project = project();
        let mask = compute_git_mask(&project.root, &json!({ "services": {} }), &[], "/").await.unwrap();
        assert!(mask.is_empty());
    }
}
