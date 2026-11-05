//! bstudio-guard를 Node에 붙이는 napi 층. 형 변환만 하고 판정은 하지 않는다.
//! TS 쪽 껍데기는 `packages/sandbox/src/native.ts`다.

use bstudio_guard::{container_policy, readonly_docker, secrets};
use napi::{Error, Result};
use napi_derive::napi;

/// 위반이면 이유, 아니면 null
#[napi]
pub fn assert_readonly_docker_args(args: Vec<String>) -> Option<String> {
    readonly_docker::violation(&args)
}

#[napi]
pub fn readonly_docker_subcommands() -> Vec<String> {
    readonly_docker::SUBCOMMANDS.iter().map(|s| (*s).to_owned()).collect()
}

/// `container_json`은 TS가 `JSON.stringify`로 만든 `docker inspect` 한 항목. 읽지 못하면 던진다(시작하지 않는 쪽)
#[napi]
pub fn find_policy_violations(
    container_json: String,
    project_name: String,
    sandbox_network: String,
    egress_network: String,
    edge_service: String,
    studio_caller: String,
) -> Result<Vec<String>> {
    let options = container_policy::PolicyOptions {
        project_name: &project_name,
        sandbox_network: &sandbox_network,
        egress_network: &egress_network,
        edge_service: &edge_service,
        studio_caller: &studio_caller,
    };
    container_policy::find_violations_json(&container_json, &options).map_err(Error::from_reason)
}

#[napi]
pub fn is_sensitive_host_path(source: String) -> bool {
    container_policy::is_sensitive_host_path(&source)
}

/// [이름, 값] 쌍을 나온 순서대로 돌려준다
#[napi]
pub fn parse_dotenv(text: String) -> Vec<Vec<String>> {
    secrets::parse_dotenv(&text).into_iter().map(|(k, v)| vec![k, v]).collect()
}

#[napi]
pub struct NativeRedactor {
    inner: secrets::Redactor,
}

#[napi]
impl NativeRedactor {
    /// `names[i]`와 `values[i]`가 한 쌍. JS `Object.entries`의 순서대로 받는다(같은 길이의 값끼리 그 순서를 지킨다)
    #[napi(constructor)]
    pub fn new(names: Vec<String>, values: Vec<String>) -> Result<Self> {
        if names.len() != values.len() {
            return Err(Error::from_reason("시크릿 이름과 값의 개수가 다릅니다"));
        }
        Ok(Self { inner: secrets::Redactor::new(names.into_iter().zip(values).collect()) })
    }

    #[napi]
    pub fn redact(&self, text: String) -> String {
        self.inner.redact(&text)
    }

    #[napi]
    pub fn find(&self, text: String) -> Vec<String> {
        self.inner.find(&text)
    }
}

// ── git-mask(ADR-191 2단계 첫 묶음). 큰 구조는 JSON 문자열로 주고받는다. TS 껍데기: packages/sandbox/src/docker/git-mask.ts

use bstudio_guard::{git_mask, node_path};

fn parse<T: serde::de::DeserializeOwned>(json: &str, what: &str) -> Result<T> {
    serde_json::from_str(json).map_err(|e| Error::from_reason(format!("{what}을(를) 읽지 못했습니다: {e}")))
}

fn record_json(record: &[(String, Vec<git_mask::MaskVolume>)]) -> String {
    git_mask::record_to_json(record).to_string()
}

#[napi]
pub fn plan_git_mask(mounts_json: String, entries_json: String, cwd: String) -> Result<String> {
    let mounts: Vec<git_mask::Mount> = parse(&mounts_json, "마운트 목록")?;
    let entries: Vec<git_mask::GitEntry> = parse(&entries_json, ".git 목록")?;
    Ok(record_json(&git_mask::plan_git_mask(&cwd, &mounts, &entries)))
}

#[napi]
pub fn plan_evaluation_asset_mask(mounts_json: String, project_root: String, assets_json: String, cwd: String) -> Result<String> {
    let mounts: Vec<git_mask::Mount> = parse(&mounts_json, "마운트 목록")?;
    let assets: Vec<git_mask::AssetCopy> = parse(&assets_json, "평가 자산 목록")?;
    Ok(record_json(&git_mask::plan_evaluation_asset_mask(&cwd, &mounts, &project_root, &assets)))
}

#[napi]
pub fn nested_asset_mount_error(compose_mounts_json: String, mounts_json: String, project_root: String, assets_json: String, cwd: String) -> Result<Option<String>> {
    let compose: Vec<git_mask::ComposeMount> = parse(&compose_mounts_json, "compose 마운트 목록")?;
    let mounts: Vec<git_mask::Mount> = parse(&mounts_json, "마운트 목록")?;
    let assets: Vec<git_mask::AssetCopy> = parse(&assets_json, "평가 자산 목록")?;
    Ok(git_mask::nested_asset_mount_error(&cwd, &compose, &mounts, &project_root, &assets))
}

/// 모양을 모르는 compose 설정이면 던진다(TS가 SandboxError로 바꾼다)
#[napi]
pub fn collect_host_mounts(config_json: String, cwd: String) -> Result<String> {
    let config: serde_json::Value = parse(&config_json, "compose 설정")?;
    let mounts = git_mask::collect_host_mounts(&cwd, &config).map_err(Error::from_reason)?;
    Ok(serde_json::to_string(&mounts).expect("직렬화"))
}

#[napi]
pub fn compose_mount_specs(config_json: String, cwd: String) -> Result<String> {
    let config: serde_json::Value = parse(&config_json, "compose 설정")?;
    let specs = git_mask::compose_mount_specs(&cwd, &config).map_err(Error::from_reason)?;
    Ok(serde_json::to_string(&specs).expect("직렬화"))
}

/// `volume_json`이 `undefined`면 TS가 `null`을 넘긴다
#[napi]
pub fn bound_device(volume_json: String) -> Result<Option<String>> {
    let volume: serde_json::Value = parse(&volume_json, "볼륨 설정")?;
    git_mask::bound_device(Some(&volume)).map_err(Error::from_reason)
}

#[napi]
pub fn merge_masks(plans_json: String) -> Result<String> {
    let plans: Vec<serde_json::Value> = parse(&plans_json, "마스크 계획 목록")?;
    let plans = plans.iter().map(git_mask::record_from_json).collect::<std::result::Result<Vec<_>, _>>().map_err(Error::from_reason)?;
    Ok(record_json(&git_mask::merge_masks(plans)))
}

#[napi]
pub fn docker_desktop_host_path(source: String) -> Option<String> {
    git_mask::docker_desktop_host_path(&source)
}

#[napi]
pub fn is_inside_host_path(cwd: String, parent: String, target: String) -> bool {
    node_path::is_inside(&cwd, &parent, &target)
}

#[napi]
pub fn is_inside_posix(parent: String, target: String) -> bool {
    git_mask::is_inside_posix(&parent, &target)
}
