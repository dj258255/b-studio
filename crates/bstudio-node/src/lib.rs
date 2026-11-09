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

// ── 출력 해석 함수(ADR-191 2단계 2b-1). 큰 구조는 JSON 문자열로 주고받는다. `NaN`·`Infinity`는 JSON으로 쓸 수 없어 표시 객체로
// 오간다(js_json 모듈). TS 껍데기: packages/sandbox/src/docker/{usage,host-containers,host-processes,snapshots,stray-processes,format}.ts

use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::{docker_format, host_containers, host_processes, snapshots, stray_processes, usage};
use napi::bindgen_prelude::{Buffer, Function};

fn out(value: &JsValue) -> String {
    js_json::to_native(value)
}

fn input(json: &str, what: &str) -> Result<JsValue> {
    js_json::parse_native(json).map_err(|e| Error::from_reason(format!("{what}을(를) 읽지 못했습니다: {e}")))
}

fn fail<T>(result: std::result::Result<T, String>) -> Result<T> {
    result.map_err(Error::from_reason)
}

#[napi]
pub fn parse_docker_bytes(text: String) -> Option<f64> {
    usage::parse_docker_bytes(&text)
}

#[napi]
pub fn parse_stats_output(stdout: String) -> Result<String> {
    let rows = fail(usage::parse_stats_output(&stdout))?;
    Ok(out(&JsValue::Arr(rows.iter().map(usage::StatsRow::to_value).collect())))
}

#[napi]
pub fn parse_inspect_output(stdout: String) -> Result<String> {
    Ok(out(&fail(usage::parse_inspect_output(&stdout))?))
}

#[napi]
pub fn merge_usage(inspected_json: String, stats_json: String, managed_names: Vec<String>, edge_service: String) -> Result<String> {
    let (inspected, stats) = (input(&inspected_json, "inspect 행")?, input(&stats_json, "stats 행")?);
    Ok(out(&fail(usage::merge_usage(&inspected, &stats, &managed_names, &edge_service))?))
}

#[napi]
pub fn boot_network_from_usage(usage_json: String, exclude: String) -> Result<String> {
    Ok(out(&fail(usage::boot_network_from_usage(&input(&usage_json, "사용량")?, &exclude))?))
}

#[napi]
pub fn format_bytes(bytes: Option<f64>) -> String {
    usage::format_bytes(bytes)
}

#[napi]
pub fn describe_usage(usage_json: String) -> Result<String> {
    fail(usage::describe_usage(&input(&usage_json, "사용량")?))
}

#[napi]
pub fn classify_ownership(label_keys: Vec<String>) -> String {
    host_containers::classify_ownership(&label_keys).to_owned()
}

#[napi]
pub fn parse_host_containers(stdout: String) -> Result<String> {
    Ok(out(&fail(host_containers::parse_host_containers(&stdout))?))
}

#[napi]
pub fn matches_project_root(working_dir: Option<String>, project_root: String, cwd: String) -> bool {
    host_containers::matches_project_root(working_dir.as_deref(), &project_root, &cwd)
}

#[napi]
pub fn discover_user_containers(containers_json: String, project_root: String, cwd: String) -> Result<String> {
    Ok(out(&fail(host_containers::discover_user_containers(&input(&containers_json, "컨테이너 목록")?, &project_root, &cwd))?))
}

#[napi]
pub fn merge_host_container_stats(names_json: String, stats_stdout: String) -> Result<String> {
    let JsValue::Arr(names) = input(&names_json, "컨테이너 이름")? else { return Err(Error::from_reason("컨테이너 이름은 배열이어야 합니다")) };
    Ok(out(&fail(host_containers::merge_host_container_stats(&names, &stats_stdout))?))
}

#[napi]
pub fn is_forwarder_process(command: String) -> bool {
    host_processes::is_forwarder_process(&command)
}

fn processes(rows: Vec<host_processes::ListeningProcess>) -> String {
    out(&JsValue::Arr(rows.iter().map(host_processes::ListeningProcess::to_value).collect()))
}

#[napi]
pub fn parse_lsof_listening(output: String) -> String {
    processes(host_processes::parse_lsof_listening(&output))
}

#[napi]
pub fn parse_ss_listening(output: String) -> String {
    processes(host_processes::parse_ss_listening(&output))
}

/// 남길 행의 인덱스. 행은 `pids[i]`·`commands[i]`·`ports[i]`가 한 쌍이다
#[napi]
pub fn match_declared_ports(pids: Vec<f64>, commands: Vec<String>, ports: Vec<f64>, declared_ports: Vec<f64>, exclude_pids: Vec<f64>) -> Result<Vec<u32>> {
    if pids.len() != commands.len() || pids.len() != ports.len() {
        return Err(Error::from_reason("pid·명령·포트의 개수가 다릅니다"));
    }
    let rows: Vec<_> = pids.into_iter().zip(commands).zip(ports).map(|((pid, command), port)| host_processes::ListeningProcess { pid, command, port }).collect();
    Ok(host_processes::match_declared_ports(&rows, &declared_ports, &exclude_pids).into_iter().map(|i| i as u32).collect())
}

#[napi]
pub fn parse_ps_row(output: String) -> Option<String> {
    host_processes::parse_ps_row(&output).map(|v| out(&v))
}

#[napi]
pub fn classify_actuator_probe(health_ok: bool, logfile_status: Option<f64>) -> String {
    out(&host_processes::classify_actuator_probe(health_ok, logfile_status))
}

/// `present[i]`가 거짓이면 파일이 없는 것이다(`contents[i]`는 자리만 채운 빈 버퍼)
#[napi]
pub fn snapshot_name(project: String, service: String, volume: String, paths: Vec<String>, present: Vec<bool>, contents: Vec<Buffer>) -> Result<String> {
    if paths.len() != present.len() || paths.len() != contents.len() {
        return Err(Error::from_reason("키 파일의 경로·유무·내용 개수가 다릅니다"));
    }
    let files: Vec<(String, Option<Vec<u8>>)> = paths.into_iter().zip(present).zip(contents).map(|((path, present), content)| (path, present.then(|| content.to_vec()))).collect();
    Ok(snapshots::snapshot_name(&project, &service, &volume, &files))
}

#[napi]
pub fn snapshot_slot(project: String, service: String, volume: String) -> String {
    snapshots::snapshot_slot(&project, &service, &volume)
}

#[napi]
pub fn compose_volume_name(compose_project: String, volume: String) -> String {
    snapshots::compose_volume_name(&compose_project, &volume)
}

/// 시각은 JS `Date.parse`로 읽어야 해서 읽는 함수를 받는다
#[napi]
pub fn snapshots_to_prune(inspect_output: String, keep: f64, parse_date: Function<String, f64>) -> Result<Vec<String>> {
    let failure = std::cell::RefCell::new(None);
    let names = snapshots::snapshots_to_prune(&inspect_output, keep, &|text| match parse_date.call(text.to_owned()) {
        Ok(ms) => ms,
        Err(e) => {
            failure.borrow_mut().get_or_insert(e);
            f64::NAN
        }
    });
    match failure.into_inner() {
        Some(e) => Err(e),
        None => Ok(names),
    }
}

#[napi]
pub fn describe_snapshot_event(event_json: String) -> Result<Option<String>> {
    fail(snapshots::describe_snapshot_event(&input(&event_json, "스냅샷 사건")?))
}

#[napi]
pub fn parse_process_scan(stdout: String) -> String {
    out(&JsValue::Arr(stray_processes::parse_process_scan(&stdout).iter().map(stray_processes::ScannedProcess::to_value).collect()))
}

/// 기준선이 없으면 TS가 빈 목록을 넘긴다(모두 모르는 것이 된다)
#[napi]
pub fn foreign_processes(now_pids: Vec<f64>, now_starts: Vec<String>, baseline_pids: Vec<f64>, baseline_starts: Vec<String>) -> Result<Vec<u32>> {
    if now_pids.len() != now_starts.len() || baseline_pids.len() != baseline_starts.len() {
        return Err(Error::from_reason("pid와 시작 시각의 개수가 다릅니다"));
    }
    let now: Vec<(f64, String)> = now_pids.into_iter().zip(now_starts).collect();
    let baseline: Vec<(f64, String)> = baseline_pids.into_iter().zip(baseline_starts).collect();
    Ok(stray_processes::foreign_processes(&now, Some(&baseline)).into_iter().map(|i| i as u32).collect())
}

#[napi]
pub fn parse_egress_denial(text: String) -> Option<String> {
    docker_format::parse_egress_denial(&text).map(|v| out(&v))
}

#[napi]
pub fn egress_audit_excerpt(lines: Vec<String>, max: f64) -> Vec<String> {
    docker_format::egress_audit_excerpt(&lines, max)
}

#[napi]
pub fn parse_runtimes(stdout: String) -> Vec<String> {
    docker_format::parse_runtimes(&stdout)
}

#[napi]
pub fn parse_host_port(stdout: String) -> Result<f64> {
    fail(docker_format::parse_host_port(&stdout))
}

fn pairs(rows: Vec<(String, String)>) -> Vec<Vec<String>> {
    rows.into_iter().map(|(a, b)| vec![a, b]).collect()
}

#[napi]
pub fn parse_container_states(stdout: String) -> Result<Vec<Vec<String>>> {
    fail(docker_format::parse_container_states(&stdout)).map(pairs)
}

#[napi]
pub fn parse_container_state(stdout: String) -> Result<String> {
    fail(docker_format::parse_container_state(&stdout))
}

/// [경로, 값] 쌍
#[napi]
pub fn parse_sync_output(stdout: String) -> Vec<Vec<String>> {
    pairs(docker_format::parse_sync_output(&stdout))
}

#[napi]
pub fn parse_log_line(raw: String) -> Option<String> {
    docker_format::parse_log_line(&raw).map(|v| out(&v))
}

#[napi]
pub struct NativeSyncObservations {
    inner: docker_format::SyncObservations,
}

#[napi]
impl NativeSyncObservations {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: docker_format::SyncObservations::new() }
    }

    #[napi]
    pub fn record(&mut self, file: String, value: Option<String>) {
        self.inner.record(&file, value.as_deref());
    }

    /// `expected_missing`은 기대값이 "MISSING"(지워져야 함)인 파일들
    #[napi]
    pub fn describe_timeout(&self, pending: Vec<String>, expected_missing: Vec<String>, timeout_ms: f64) -> String {
        self.inner.describe_timeout(&pending, &expected_missing, timeout_ms)
    }
}

impl Default for NativeSyncObservations {
    fn default() -> Self {
        Self::new()
    }
}

// ── compose override와 edge 설정(ADR-191 2단계 2b-2a). 격리를 정하는 판정이다. TS 껍데기: packages/sandbox/src/{edge-config,docker/format}.ts
// 입력은 JSON 문자열(encodeNative), 출력도 JSON 문자열이다. 모양이 어긋난 입력은 던진다(샌드박스를 만들지 않는 쪽)

use bstudio_guard::{compose_override, edge_config, public_url};

/// 상수(서비스 이름, 프록시 포트, 이미지, 네트워크 이름, 기본 허용 호스트). TS는 따로 적지 않고 이 값을 읽는다
#[napi]
pub fn edge_constants() -> String {
    out(&edge_config::constants())
}

/// `managed_names`는 managed 서비스 이름을 순서대로. 없는 이름이면 던진다
#[napi]
pub fn edge_port_for(managed_names: Vec<String>, service: String) -> Result<u32> {
    fail(edge_config::edge_port_for(&managed_names, &service))
}

#[napi]
pub fn direct_hosts(services: Vec<String>, externals: Vec<String>) -> Vec<String> {
    edge_config::direct_hosts(&services, &externals)
}

#[napi]
pub fn proxy_environment(direct: Vec<String>) -> String {
    out(&edge_config::pairs_to_object(&edge_config::proxy_environment(&direct)))
}

/// `input_json`: `{ managed: [[이름, 포트]], services: [...], egress?: [...], external?: [[이름, { baseUrl, policy }]] }`
#[napi]
pub fn edge_environment(input_json: String) -> Result<String> {
    let value = input(&input_json, "edge 설정 입력")?;
    Ok(out(&fail(compose_override::edge_environment_from(&value))?))
}

/// `input_json`은 `buildOverride`의 입력(packages/sandbox/src/docker/format.ts가 만든다)
#[napi]
pub fn build_override(input_json: String) -> Result<String> {
    let value = input(&input_json, "override 입력")?;
    Ok(out(&fail(compose_override::build_override(&value))?))
}

#[napi]
pub fn compose_up_args(explicit: Option<Vec<String>>, edge_service: String) -> Vec<String> {
    compose_override::compose_up_args(explicit.as_deref(), &edge_service)
}

/// 자리 표시자 채우기(spec의 TS와 같은 규칙인지 차등 시험으로 묶는다). `host_ports_json`은 서비스 이름 → 포트인 객체
#[napi]
pub fn resolve_public_url_placeholders(value: String, host_ports_json: String) -> Result<String> {
    let ports = input(&host_ports_json, "호스트 포트")?;
    let JsValue::Obj(ports) = ports else { return Err(Error::from_reason("호스트 포트는 객체여야 합니다")) };
    Ok(public_url::resolve(&value, &mut |svc| match ports.get(svc) {
        Some(port) => format!("http://127.0.0.1:{}", port.to_js_string()),
        None => public_url::placeholder(svc),
    }))
}

// ── relay(ADR-191 2단계 2b-2b 첫 묶음, #1026). TS 껍데기: packages/sandbox/src/docker/relay.ts

use bstudio_guard::relay;

/// `services_json`은 `Object.entries(services)`, `service_paths_json`은 `Object.entries(servicePaths)`(JS 순서를 TS가 정한다)
#[napi]
pub fn bind_mounts(services_json: String, managed: Vec<String>, service_paths_json: String, cwd: String) -> Result<String> {
    let services: Vec<(String, serde_json::Value)> = parse(&services_json, "compose 서비스 목록")?;
    let service_paths: Vec<(String, String)> = parse(&service_paths_json, "서비스 경로 목록")?;
    let mounts = relay::bind_mounts(&cwd, &services, &managed, &service_paths).map_err(Error::from_reason)?;
    serde_json::to_string(&mounts).map_err(|e| Error::from_reason(e.to_string()))
}

/// 결과는 서비스가 처음 나온 순서의 `[서비스, 알림 목록][]`(TS가 Map으로 바꾼다)
#[napi]
pub fn plan_relay(project_root: String, changes_json: String, mounts_json: String, cwd: String) -> Result<String> {
    let changes: Vec<relay::FileChange> = parse(&changes_json, "변경 목록")?;
    let mounts: Vec<relay::BindMount> = parse(&mounts_json, "마운트 목록")?;
    serde_json::to_string(&relay::plan_relay(&cwd, &project_root, &changes, &mounts)).map_err(|e| Error::from_reason(e.to_string()))
}

// ── readiness(ADR-191 2단계 2b-2b, #1034). TS 껍데기: packages/sandbox/src/readiness.ts

use bstudio_guard::readiness;

#[napi]
pub fn decide_readiness(history_json: String, policy_json: String, elapsed_ms: f64) -> Result<String> {
    let history: Vec<readiness::Probe> = parse(&history_json, "확인 기록")?;
    let policy: readiness::ReadinessPolicy = parse(&policy_json, "준비 정책")?;
    serde_json::to_string(&readiness::decide_readiness(&history, &policy, elapsed_ms)).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_transient_boot_error(lines: Vec<String>) -> bool {
    readiness::is_transient_boot_error(&lines)
}

#[napi]
pub fn should_retry_transient_crash(attempt: i64, excerpt: Vec<String>) -> bool {
    readiness::should_retry_transient_crash(attempt, &excerpt)
}

#[napi]
pub fn crash_log_excerpt(lines: Vec<String>, max: u32) -> Vec<String> {
    readiness::crash_log_excerpt(&lines, max as usize)
}

// ── 무중단 배포 계획(ADR-191 2단계 2b-2b 셋째 묶음, #1036). TS 껍데기: packages/sandbox/src/docker/deploy-plan.ts
// 입력은 JSON 문자열(encodeNative), 출력도 JSON 문자열이다. 객체를 돌려주는 `releasesToRetire`·`trimRecords`는 목록 안 위치를 낸다
// (TS가 같은 객체를 돌려주도록). 모양이 어긋난 입력은 던진다

use bstudio_guard::deploy_plan;

#[napi]
pub fn empty_deploy_state(project: String) -> String {
    out(&deploy_plan::empty_deploy_state(&project))
}

#[napi]
pub fn deploy_base_name(project: String) -> String {
    deploy_plan::base_name(&project)
}

#[napi]
pub fn deploy_release_name(project: String, id: String) -> String {
    deploy_plan::release_name(&project, &id)
}

#[napi]
pub fn deploy_proxy_name(project: String) -> String {
    deploy_plan::proxy_name(&project)
}

#[napi]
pub fn deploy_image_name(project: String, service: String, id: String) -> String {
    deploy_plan::image_name(&project, &service, &id)
}

#[napi]
pub fn deploy_container_name(compose_project: String, service: String) -> String {
    deploy_plan::container_name(&compose_project, &service)
}

/// `now_ms`는 `Date.getTime()`
#[napi]
pub fn new_release_id(now_ms: f64) -> String {
    deploy_plan::new_release_id(now_ms)
}

#[napi]
pub fn proxy_listen_port(index: f64) -> f64 {
    deploy_plan::proxy_listen_port(index)
}

/// 부가 서비스가 없으면 `"null"`
#[napi]
pub fn plan_base_compose(config_json: String, project_json: String) -> Result<String> {
    let config = input(&config_json, "compose 설정")?;
    let project = input(&project_json, "프로젝트")?;
    Ok(match fail(deploy_plan::plan_base_compose(&config, &project))? {
        Some(plan) => out(&plan),
        None => "null".to_owned(),
    })
}

#[napi]
pub fn plan_release_compose(config_json: String, project_json: String, release_id: String, images_json: String) -> Result<String> {
    let config = input(&config_json, "compose 설정")?;
    let project = input(&project_json, "프로젝트")?;
    let images = input(&images_json, "운영 이미지")?;
    Ok(out(&fail(deploy_plan::plan_release_compose(&config, &project, &release_id, &images))?))
}

/// `build_json`·`environment_json`은 없으면 `"null"`
#[napi]
pub fn build_args_for(dockerfile: String, build_json: String, environment_json: String) -> Result<String> {
    let build = input(&build_json, "build")?;
    let environment = input(&environment_json, "environment")?;
    Ok(out(&fail(deploy_plan::build_args_for(&dockerfile, Some(&build), Some(&environment)))?))
}

#[napi]
pub fn summarize_build_output(output: String, max_lines: f64) -> String {
    deploy_plan::summarize_build_output(&output, max_lines)
}

#[napi]
pub fn build_caddyfile(routes_json: String) -> Result<String> {
    fail(deploy_plan::build_caddyfile(&input(&routes_json, "프록시 경로")?))
}

/// `statuses_json`은 릴리스의 `status` 목록. 정리할 릴리스의 위치를 돌려준다
#[napi]
pub fn releases_to_retire(statuses_json: String, keep_previous: f64) -> Result<Vec<u32>> {
    let JsValue::Arr(statuses) = input(&statuses_json, "릴리스 상태 목록")? else { return Err(Error::from_reason("릴리스 상태 목록은 배열이어야 합니다")) };
    Ok(deploy_plan::releases_to_retire(&statuses, keep_previous).into_iter().map(|i| i as u32).collect())
}

/// `ids_json`은 릴리스의 `id` 목록. 남길 릴리스의 위치를 돌려준다
#[napi]
pub fn trim_records(ids_json: String, active: Option<String>) -> Result<Vec<u32>> {
    let JsValue::Arr(ids) = input(&ids_json, "릴리스 id 목록")? else { return Err(Error::from_reason("릴리스 id 목록은 배열이어야 합니다")) };
    Ok(deploy_plan::trim_records(&ids, active.as_deref()).into_iter().map(|i| i as u32).collect())
}

// ── I/O 조율: stream-exec(2단계 2c-1, #1041). 자식 프로세스 출력을 파일로 흘리거나 파일을 입력으로 넣는다.
// 판정은 하지 않는다 — bstudio-io가 syscall을 하고, 여기는 JS 값을 바꾸고 AbortSignal을 취소에 잇는다(ADR-193).
// 동기 함수로 둔다: !Send인 AbortSignal을 JS 스레드에서 받아 Send한 Notify로 바꾸면, 작업 future는 Notify만 들어 Send다.
use bstudio_io::stream_exec;
use napi::bindgen_prelude::{AbortSignal, AsyncBlock, AsyncBlockBuilder};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Status};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Notify;

/// TS `ExecResult`와 같은 모양. napi가 `{ exitCode, stdout, stderr }`로 바꾼다
#[napi(object)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl From<stream_exec::ExecOutput> for ExecResult {
    fn from(output: stream_exec::ExecOutput) -> Self {
        Self { exit_code: output.exit_code, stdout: output.stdout, stderr: output.stderr }
    }
}

fn env_pairs(env: Option<HashMap<String, String>>) -> Option<Vec<(String, String)>> {
    env.map(|map| map.into_iter().collect())
}

/// abort되면 Notify를 깨워 작업 future를 떨어뜨리고, 자식은 kill_on_drop으로 죽는다.
/// 콜백은 JS 객체 수명 동안 살아(from_napi_value가 Rc를 공유한다) abort 때 불린다. abort가 먼저 와도 Notify가 permit을 쥔다.
fn abort_notify(signal: Option<AbortSignal>) -> Arc<Notify> {
    let notify = Arc::new(Notify::new());
    if let Some(signal) = signal {
        let on_abort = notify.clone();
        signal.on_abort(move || on_abort.notify_one());
    }
    notify
}

/// stdout을 `output_file`로 흘리고 stderr만 잡는다. `signal`로 취소하면 자식을 죽인다
#[napi]
pub fn run_command_to_file(
    env: Env,
    bin: String,
    args: Vec<String>,
    output_file: String,
    env_vars: Option<HashMap<String, String>>,
    signal: Option<AbortSignal>,
) -> Result<AsyncBlock<ExecResult>> {
    let pairs = env_pairs(env_vars);
    let cancel = abort_notify(signal);
    let future = async move {
        let work = stream_exec::run_command_to_file(&bin, &args, &output_file, pairs.as_deref());
        tokio::select! {
            result = work => result.map(ExecResult::from).map_err(|error| Error::from_reason(error.to_string())),
            _ = cancel.notified() => Err(Error::from_reason("취소되었습니다")),
        }
    };
    AsyncBlockBuilder::new(future).build(&env)
}

/// `input_file`을 stdin으로 넣고 stdout·stderr를 잡는다. `signal`로 취소하면 자식을 죽인다
#[napi]
pub fn run_command_from_file(
    env: Env,
    bin: String,
    args: Vec<String>,
    input_file: String,
    env_vars: Option<HashMap<String, String>>,
    signal: Option<AbortSignal>,
) -> Result<AsyncBlock<ExecResult>> {
    let pairs = env_pairs(env_vars);
    let cancel = abort_notify(signal);
    let future = async move {
        let work = stream_exec::run_command_from_file(&bin, &args, &input_file, pairs.as_deref());
        tokio::select! {
            result = work => result.map(ExecResult::from).map_err(|error| Error::from_reason(error.to_string())),
            _ = cancel.notified() => Err(Error::from_reason("취소되었습니다")),
        }
    };
    AsyncBlockBuilder::new(future).build(&env)
}

/// `bin args`를 한 번 실행하고 stdout·stderr를 모은다(TS `#docker`). `signal`로 취소하면
/// 2c-1과 달리 거절하지 않고 그때까지의 부분 출력과 exitCode 1을 돌려준다(#1043).
/// 취소를 거절로 올리지 않으려면 select를 napi가 아니라 작업 안에서 해야 하므로, 취소 future를 넘긴다.
#[napi]
pub fn run_command(
    env: Env,
    bin: String,
    args: Vec<String>,
    input: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    signal: Option<AbortSignal>,
) -> Result<AsyncBlock<ExecResult>> {
    let pairs = env_pairs(env_vars);
    let cancel = abort_notify(signal);
    let future = async move {
        let output = bstudio_io::process::run_command(
            &bin,
            &args,
            input.as_deref(),
            pairs.as_deref(),
            cancel.notified(),
        )
        .await;
        Ok(ExecResult::from(output))
    };
    AsyncBlockBuilder::new(future).build(&env)
}

/// `bin args`를 실행하되 출력을 줄 단위로 `on_line`에 역류시키고 뒤쪽 200K를 모아 돌려준다(TS deploy `#docker`).
/// `on_line`은 `ThreadsafeFunction`으로 JS 콜백을 Rust 작업 스레드에서 부른다(CalleeHandled=false라 `(line)` 한 인자).
/// deploy의 onLine은 빠른 로그 출력이라 non-blocking push로 충분하다(백프레셔는 2c-3b의 logs에서 다룬다, #1045).
#[napi]
pub fn run_command_streaming(
    env: Env,
    bin: String,
    args: Vec<String>,
    input: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    cwd: Option<String>,
    on_line: ThreadsafeFunction<String, (), String, Status, false>,
    signal: Option<AbortSignal>,
) -> Result<AsyncBlock<ExecResult>> {
    let pairs = env_pairs(env_vars);
    let cancel = abort_notify(signal);
    let callback: bstudio_io::streaming::OnLine = Arc::new(move |line: String| {
        on_line.call(line, ThreadsafeFunctionCallMode::NonBlocking);
    });
    let future = async move {
        let output = bstudio_io::streaming::run_command_streaming(
            &bin,
            &args,
            input.as_deref(),
            pairs.as_deref(),
            cwd.as_deref(),
            callback,
            cancel.notified(),
        )
        .await;
        Ok(ExecResult::from(output))
    };
    AsyncBlockBuilder::new(future).build(&env)
}

// === 로그 스트림(ADR-193, 2c-3b): docker compose logs를 AsyncIterator로 당긴다 ===
// TS `compose-provider.ts`의 `logs()`(`spawn` + `readline`)를 옮긴 것. 당기기(pull) 모델이라 소비가 느리면
// bstudio-io 채널이 차서 docker 읽기가 막힌다(백프레셔). `parseLogLine`·`redact`·`Date` 변환은 TS가 한다.
use bstudio_io::log_stream;
use napi::bindgen_prelude::AsyncGenerator;
use tokio::sync::Mutex as AsyncMutex;

/// `docker compose logs`의 stdout을 줄 단위로 당겨 주는 async iterator. `next()`는 채널의 `recv().await`다.
#[napi(async_iterator)]
pub struct LogStream {
    inner: Arc<AsyncMutex<log_stream::LogStream>>,
    cancel: Arc<Notify>,
}

#[napi]
impl LogStream {
    /// `bin args`(= `docker compose logs ...`)를 띄운다. `signal`이 깨면 구독을 끊고 자식을 kill한다.
    #[napi(constructor)]
    pub fn new(
        bin: String,
        args: Vec<String>,
        env_vars: Option<HashMap<String, String>>,
        cwd: Option<String>,
        signal: Option<AbortSignal>,
    ) -> Self {
        let pairs = env_pairs(env_vars);
        let (stream, pump) = log_stream::run_command_log_stream(&bin, &args, pairs.as_deref(), cwd.as_deref());
        let cancel = stream.cancel_handle();
        // pump(docker를 끝까지 읽는 루프)를 napi의 global 런타임에 올린다.
        // JS 메인 스레드라 `tokio::spawn`은 "no reactor"로 패닉한다 — `bindgen_prelude::spawn`이 global RT.spawn이다.
        napi::bindgen_prelude::spawn(pump);
        if let Some(signal) = signal {
            let on_abort = cancel.clone();
            signal.on_abort(move || on_abort.notify_one());
        }
        Self { inner: Arc::new(AsyncMutex::new(stream)), cancel }
    }
}

#[napi]
impl AsyncGenerator for LogStream {
    type Yield = String;
    type Next = ();
    type Return = ();

    // future가 Send+'static이라 self를 빌릴 수 없다 → Arc<Mutex<Receiver>>를 clone해 넘긴다.
    fn next(&mut self, _value: Option<()>) -> impl std::future::Future<Output = Result<Option<String>>> + Send + 'static {
        let inner = self.inner.clone();
        async move { Ok(inner.lock().await.next_line().await) }
    }

    // JS가 `break`/`return`하면 불린다 → 구독을 끊고 자식을 kill한다(소비자 drop도 bstudio-io가 잡지만 명시한다).
    fn complete(&mut self, _value: Option<()>) -> impl std::future::Future<Output = Result<Option<String>>> + Send + 'static {
        self.cancel.notify_one();
        async move { Ok(None) }
    }
}

// === 링크 안전 파일 시스템 준비(ADR-193, 2c-1b) ===
// TS `evaluation-assets.ts`의 `prepareSlot`·`removeEvaluationAssets`.
// 판정과 syscall은 bstudio-io의 safe_fs가 한다. 여기는 형 변환만 한다. 오류는 메시지 그대로 JS Error가 된다.
use bstudio_io::safe_fs;
use std::path::PathBuf;

fn fs_error(error: std::io::Error) -> Error {
    Error::from_reason(error.to_string())
}

/// 평가 자산 복사본 자리를 준비한다. `kind`는 `"file"`·`"directory"`, 그 밖의 값은 거부한다
#[napi]
pub async fn prepare_evaluation_asset_slot(source: String, kind: String, parent: String) -> Result<()> {
    let kind = match kind.as_str() {
        "file" => safe_fs::SlotKind::File,
        "directory" => safe_fs::SlotKind::Directory,
        other => return Err(Error::from_reason(format!("알 수 없는 자리 종류입니다: {other}"))),
    };
    safe_fs::prepare_slot_async(PathBuf::from(source), kind, PathBuf::from(parent)).await.map_err(fs_error)
}

/// 한 샌드박스의 복사본 폴더를 지운다. 그 폴더가 링크면 링크만, 안의 링크도 따라가지 않는다
#[napi]
pub async fn remove_sandbox_directory(dir: String) -> Result<()> {
    safe_fs::remove_sandbox_dir_async(PathBuf::from(dir)).await.map_err(fs_error)
}

// ── git-mask의 파일 시스템 I/O(2c-6). 판정은 bstudio-guard, syscall은 bstudio-io::git_mask_fs ──

/// TS `GitEntry`와 같은 모양
#[napi(object)]
pub struct GitEntryJs {
    pub dir: String,
    pub kind: String,
    pub has_state: bool,
}

impl From<bstudio_io::git_mask_fs::GitEntry> for GitEntryJs {
    fn from(entry: bstudio_io::git_mask_fs::GitEntry) -> Self {
        Self { dir: entry.dir, kind: entry.kind, has_state: entry.has_state }
    }
}

/// 상태 폴더 준비가 실패한 자리. 던지지 않고 값으로 돌려 TS가 `SandboxError`로 바꾼다
#[napi(object)]
pub struct MaskFailureJs {
    pub state: String,
    pub detail: String,
}

#[napi(object)]
pub struct PreparedMasks {
    pub entries: Vec<GitEntryJs>,
    pub failure: Option<MaskFailureJs>,
}

/// 링크를 푼 실제 경로. 풀지 못하면 `path.resolve`와 같이 `cwd` 기준 절대 경로
#[napi]
pub fn real_path(env: Env, target: String, cwd: String) -> Result<AsyncBlock<String>> {
    AsyncBlockBuilder::new(async move { Ok(bstudio_io::git_mask_fs::real_path(&target, &cwd).await) }).build(&env)
}

/// 프로젝트 폴더에서 위로 올라가며 `.git`이 든 폴더를 찾는다
#[napi]
pub fn detect_git_entries(env: Env, project_root: String, mount_sources: Vec<String>, cwd: String) -> Result<AsyncBlock<Vec<GitEntryJs>>> {
    AsyncBlockBuilder::new(async move {
        let entries = bstudio_io::git_mask_fs::detect_git_entries(&project_root, &mount_sources, &cwd).await;
        Ok(entries.into_iter().map(GitEntryJs::from).collect())
    })
    .build(&env)
}

/// b-studio 저장소의 상태 폴더와 그 위에 얹을 빈 폴더를 미리 만든다. 실패하면 거기서 멈추고 `failure`를 채운다
#[napi]
pub fn prepare_state_masks(env: Env, entries: Vec<GitEntryJs>) -> Result<AsyncBlock<PreparedMasks>> {
    AsyncBlockBuilder::new(async move {
        let mut inner: Vec<bstudio_io::git_mask_fs::GitEntry> =
            entries.into_iter().map(|e| bstudio_io::git_mask_fs::GitEntry { dir: e.dir, kind: e.kind, has_state: e.has_state }).collect();
        let failure = bstudio_io::git_mask_fs::prepare_state_masks(&mut inner).await.err().map(|f| MaskFailureJs { state: f.state, detail: f.detail });
        Ok(PreparedMasks { entries: inner.into_iter().map(GitEntryJs::from).collect(), failure })
    })
    .build(&env)
}

// === 호스트 PTY(ADR-193, 2c-4a): node-pty를 portable-pty로 대체한다 ===
// 양방향이다: write/resize/kill은 동기 메서드, 출력(on_data)·종료(on_exit)는 ThreadsafeFunction으로 역류한다(2c-3a 밀어내기 경계 재사용).
// PTY는 blocking I/O라 bstudio-io가 std::thread로 격리한다 — 여기선 TSFN을 감싼 콜백만 주입한다.
use napi::bindgen_prelude::Buffer as NapiBuffer;

/// 호스트에 연 가상 터미널. TS host-terminal.ts의 `HostPty`(node-pty)를 대신한다.
#[napi]
pub struct HostPty {
    inner: Arc<bstudio_io::pty::HostPty>,
}

#[napi]
impl HostPty {
    /// `file args`로 PTY를 열고 띄운다. `on_data`는 출력(Buffer)마다, `on_exit`는 종료 코드로 한 번 불린다.
    /// `cols`/`rows`는 u32로 받아 u16으로 좁힌다(napi가 u16을 직접 받지 않는다). `env`는 상속 없이 통째 치환한다.
    #[napi(constructor)]
    pub fn new(
        file: String,
        args: Vec<String>,
        name: String,
        cols: u32,
        rows: u32,
        cwd: String,
        env_vars: HashMap<String, String>,
        on_data: ThreadsafeFunction<NapiBuffer, (), NapiBuffer, Status, false>,
        on_exit: ThreadsafeFunction<i32, (), i32, Status, false>,
    ) -> Result<Self> {
        let data_cb: bstudio_io::pty::OnData = Arc::new(move |bytes: Vec<u8>| {
            on_data.call(bytes.into(), ThreadsafeFunctionCallMode::NonBlocking);
        });
        let exit_cb: bstudio_io::pty::OnExit = Arc::new(move |code: i32| {
            on_exit.call(code, ThreadsafeFunctionCallMode::NonBlocking);
        });
        let pairs = env_pairs(Some(env_vars)).unwrap_or_default();
        let pty = bstudio_io::pty::open_host_pty(
            &file,
            &args,
            &name,
            cols as u16,
            rows as u16,
            &cwd,
            &pairs,
            data_cb,
            exit_cb,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(Self { inner: Arc::new(pty) })
    }

    /// 자식 pid(감시가 이 아래의 CLI를 찾는 데 쓴다). 플랫폼이 못 주면 undefined.
    #[napi(getter)]
    pub fn pid(&self) -> Option<u32> {
        self.inner.pid()
    }

    /// PTY에 입력을 쓴다.
    #[napi]
    pub fn write(&self, data: NapiBuffer) -> Result<()> {
        self.inner.write(&data).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 터미널 크기를 바꾼다(SIGWINCH).
    #[napi]
    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.inner.resize(cols as u16, rows as u16).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 자식을 죽인다(셸과 그 안의 CLI가 함께 끝난다).
    #[napi]
    pub fn kill(&self) -> Result<()> {
        self.inner.kill().map_err(|error| Error::from_reason(error.to_string()))
    }
}

// === 양방향 exec 세션(ADR-193, 2c-4b): docker exec -i 터미널 ===
// TS `agent-terminal.ts`의 `openAgentTerminal`이 쓰는 `spawn`을 옮긴 것. 출력·종료는 **하나의** ThreadsafeFunction으로 밀어
// 보낸다 — TSFN은 함수마다 큐가 따로라, 데이터용과 종료용을 나누면 종료가 마지막 출력보다 먼저 JS에 닿을 수 있다.
// write·close·kill은 동기다(채널에 넣거나 Notify를 깨우기만 한다).
use bstudio_io::exec_stream;

/// JS로 가는 사건 하나. `exited`가 false면 `data`가 있고, true면 `code`가 종료 코드다(시그널로 죽었으면 null).
#[napi(object)]
pub struct ExecEvent {
    pub data: Option<Buffer>,
    pub exited: bool,
    pub code: Option<i32>,
}

#[napi]
pub struct ExecSession {
    handle: exec_stream::ExecHandle,
}

#[napi]
impl ExecSession {
    /// `bin args`를 띄운다. `on_event`는 Rust 작업 스레드에서 `(event)` 한 인자로 불린다. 띄우기 실패도 `exited`(코드 -2)로 온다.
    #[napi(constructor)]
    pub fn new(
        bin: String,
        args: Vec<String>,
        env_vars: Option<HashMap<String, String>>,
        cwd: Option<String>,
        on_event: ThreadsafeFunction<ExecEvent, (), ExecEvent, Status, false>,
    ) -> Self {
        let pairs = env_pairs(env_vars);
        let callback: exec_stream::OnEvent = Arc::new(move |event| {
            let event = match event {
                exec_stream::ExecEvent::Data(data) => ExecEvent { data: Some(Buffer::from(data)), exited: false, code: None },
                exec_stream::ExecEvent::Exit(code) => ExecEvent { data: None, exited: true, code },
            };
            on_event.call(event, ThreadsafeFunctionCallMode::NonBlocking);
        });
        let (handle, pump) = exec_stream::spawn_exec(&bin, &args, pairs.as_deref(), cwd.as_deref(), callback);
        // JS 메인 스레드라 tokio::spawn은 "no reactor"로 패닉한다 — LogStream과 같이 global 런타임에 올린다
        napi::bindgen_prelude::spawn(pump);
        Self { handle }
    }

    /// stdin에 쓴다. 닫힌 뒤의 쓰기는 조용히 버리고 false를 준다
    #[napi]
    pub fn write(&self, data: Buffer) -> bool {
        self.handle.write(data.to_vec())
    }

    /// stdin을 닫는다(EOF)
    #[napi]
    pub fn end(&self) {
        self.handle.end_stdin();
    }

    /// 자식에게 SIGTERM을 보낸다
    #[napi]
    pub fn terminate(&self) {
        self.handle.terminate();
    }
}

// ── I/O 조율: 배포 개별 I/O(2단계 2c-5). deploy.ts의 잠금·빈 포트·상태/compose 파일·운영 주소 확인 한 번.
// 파일·소켓 syscall은 blocking이라 spawn_blocking으로 JS 스레드 밖에서 돌린다. 판정은 하지 않는다.
use bstudio_io::deploy_io;
use std::path::Path;
use std::time::Duration;

fn io_error(context: &str, error: std::io::Error) -> Error {
    Error::from_reason(format!("{context}: {error}"))
}

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(task).await.map_err(|e| Error::from_reason(format!("I/O 작업이 중단됐습니다: {e}")))
}

/// `127.0.0.1`의 빈 포트 하나
#[napi]
pub async fn free_port() -> Result<u32> {
    let port = blocking(deploy_io::free_port).await?.map_err(|e| io_error("빈 포트를 찾지 못했습니다", e))?;
    Ok(u32::from(port))
}

/// 배포 잠금을 잡는다. 잡았으면 0, 살아 있는 프로세스가 쥐고 있으면 그 pid(0이 아님). 그 밖의 I/O 오류는 거절한다
#[napi]
pub async fn acquire_deploy_lock(lock: String) -> Result<u32> {
    match blocking(move || deploy_io::acquire_lock(Path::new(&lock))).await?.map_err(|e| io_error("배포 잠금을 잡지 못했습니다", e))? {
        deploy_io::LockOutcome::Acquired => Ok(0),
        deploy_io::LockOutcome::Held(pid) => Ok(pid),
    }
}

/// 배포 잠금 파일을 지운다(없거나 지우지 못해도 알리지 않는다)
#[napi]
pub async fn release_deploy_lock(lock: String) -> Result<()> {
    blocking(move || deploy_io::release_lock(Path::new(&lock))).await
}

/// 파일을 UTF-8 문자열로 읽는다. 없거나 읽지 못하면 null
#[napi]
pub async fn read_text_file(path: String) -> Result<Option<String>> {
    blocking(move || deploy_io::read_text(Path::new(&path))).await
}

/// 부모 폴더를 만들고 파일을 쓴다(덮어쓴다)
#[napi]
pub async fn write_text_file(path: String, content: String) -> Result<()> {
    blocking(move || deploy_io::write_text(Path::new(&path), &content)).await?.map_err(|e| io_error("파일을 쓰지 못했습니다", e))
}

/// 부모 폴더를 만들고 임시 파일에 쓴 뒤 rename으로 바꿔 넣는다
#[napi]
pub async fn write_text_file_atomic(path: String, content: String) -> Result<()> {
    blocking(move || deploy_io::write_text_atomic(Path::new(&path), &content)).await?.map_err(|e| io_error("파일을 쓰지 못했습니다", e))
}

/// `probe_http_status`의 결과. 상태를 얻으면 `status`, 못 얻으면 `error`(문장)
#[napi(object)]
pub struct HttpProbe {
    pub status: Option<u32>,
    pub error: Option<String>,
}

/// `http://127.0.0.1:<port><path>`에 GET 한 번(리다이렉트 안 따름, 본문 안 읽음). 던지지 않는다
#[napi]
pub async fn probe_http_status(port: u32, path: String, timeout_ms: u32) -> Result<HttpProbe> {
    let Ok(port) = u16::try_from(port) else {
        return Ok(HttpProbe { status: None, error: Some(format!("포트 {port}이(가) 범위를 벗어났습니다")) });
    };
    Ok(match deploy_io::probe_http_status(port, &path, Duration::from_millis(u64::from(timeout_ms))).await {
        Ok(status) => HttpProbe { status: Some(u32::from(status)), error: None },
        Err(error) => HttpProbe { status: None, error: Some(error) },
    })
}

// ── 테스트 발견(ADR-191 3a). 결과는 JSON 문자열이다(옛 TS의 JSON.stringify와 같은 글자). TS 껍데기: packages/agent/src/test-discovery.ts

use bstudio_guard::test_discovery;

#[napi]
pub fn extract_requirement_ids(text: String) -> Vec<String> {
    test_discovery::extract_requirement_ids(&text)
}

#[napi]
pub fn extract_requirement_ids_with_suites(suite_path: Option<Vec<String>>, title: String) -> Vec<String> {
    test_discovery::extract_requirement_ids_with_suites(&suite_path.unwrap_or_default(), &title)
}

#[napi]
pub fn discover_junit_file(file_path: String, content: String) -> String {
    test_discovery::discover_junit_file(&file_path, &content).to_json()
}

#[napi]
pub fn detect_js_framework(content: String) -> String {
    test_discovery::detect_js_framework(&content).to_owned()
}

/// `framework`가 없으면(undefined·null) 내용으로 짐작한다
#[napi]
pub fn discover_js_file(file_path: String, content: String, framework: Option<String>) -> String {
    test_discovery::discover_js_file(&file_path, &content, framework.as_deref()).to_json()
}

#[napi]
pub fn discover_pytest_file(file_path: String, content: String) -> String {
    test_discovery::discover_pytest_file(&file_path, &content).to_json()
}

#[napi]
pub fn is_test_file_path(file_path: String) -> bool {
    test_discovery::is_test_file_path(&file_path)
}

/// 테스트 파일로 보이지 않으면 null
#[napi]
pub fn discover_tests_in_file(file_path: String, content: String) -> Option<String> {
    test_discovery::discover_tests_in_file(&file_path, &content).map(|file| file.to_json())
}

/// 모양이 어긋난 입력은 던진다
#[napi]
pub fn flatten_discovered_file(file_json: String) -> Result<String> {
    fail(test_discovery::flatten_discovered_file(&file_json))
}

// ── 토큰 예산·모델 선택(ADR-191 3f). 큰 구조는 JSON 문자열(NaN·Infinity는 표시 객체). TS 껍데기: packages/agent/src/{tool-output,context-clearing,model-router,cli-router}.ts

use bstudio_guard::{cli_router, context_clearing, model_router, tool_output};

#[napi]
pub fn clip_command_output(text: String, budget: f64) -> String {
    tool_output::clip_command_output(&text, budget)
}

#[napi]
pub fn clip_text(text: String, budget: f64, hint: Option<String>) -> String {
    tool_output::clip_text(&text, budget, hint.as_deref())
}

#[napi]
pub fn visible_html(html: String) -> String {
    tool_output::visible_html(&html)
}

#[napi]
pub fn is_html_content(content_type: Option<String>, text: String) -> bool {
    tool_output::is_html_content(content_type.as_deref(), &text)
}

#[napi]
pub fn repeat_note_prefix() -> String {
    tool_output::REPEAT_NOTE_PREFIX.to_owned()
}

#[napi]
pub fn repeat_note(call: f64) -> String {
    tool_output::repeat_note(call)
}

#[napi]
pub fn is_repeat_note(text: String) -> bool {
    tool_output::is_repeat_note(&text)
}

#[napi]
pub fn cleared_tool_result_prefix() -> String {
    context_clearing::CLEARED_TOOL_RESULT_PREFIX.to_owned()
}

#[napi]
pub fn cleared_tool_result_note(chars: f64) -> String {
    context_clearing::cleared_tool_result_note(chars)
}

#[napi]
pub fn is_cleared_tool_result(text: String) -> bool {
    context_clearing::is_cleared_tool_result(&text)
}

/// 비울 자리의 계획(JSON). 메시지는 읽기만 한다
#[napi]
pub fn plan_clear_old_tool_results(messages_json: String, keep_recent: f64, clear_at_least_chars: f64) -> Result<String> {
    fail(context_clearing::plan_clear_old_tool_results(&messages_json, keep_recent, clear_at_least_chars))
}

#[napi]
pub fn is_context_clearing_on(value: Option<String>) -> bool {
    context_clearing::is_context_clearing_on(value.as_deref())
}

#[napi]
pub fn estimate_tokens(text: String) -> f64 {
    model_router::estimate_tokens(&text)
}

#[napi]
pub fn classify_complexity(prompt: String, input_tokens: f64) -> String {
    model_router::classify_complexity(&prompt, input_tokens).to_owned()
}

#[napi]
pub fn classify_risk(prompt: String) -> String {
    model_router::classify_risk(&prompt).to_owned()
}

#[napi]
pub fn classify_task(prompt: String) -> String {
    model_router::classify_task(&prompt)
}

#[napi]
pub fn estimate_cost(pricing_json: String, usage_json: String) -> Result<Option<f64>> {
    fail(model_router::estimate_cost(&pricing_json, &usage_json))
}

#[napi]
pub fn route_model(profiles_json: String, request_json: String, stats_json: String) -> Result<String> {
    fail(model_router::route_model(&profiles_json, &request_json, &stats_json))
}

#[napi]
pub fn aggregate_model_stats(observations_json: String) -> Result<String> {
    fail(model_router::aggregate_model_stats(&observations_json))
}

#[napi]
pub fn validate_model_profiles(input_json: String, url_facts_json: String) -> Result<String> {
    fail(model_router::validate_model_profiles(&input_json, &url_facts_json))
}

#[napi]
pub fn cli_tiers() -> Vec<String> {
    cli_router::CLI_TIERS.iter().map(|t| (*t).to_owned()).collect()
}

#[napi]
pub fn tier_label(tier: String) -> Option<String> {
    cli_router::tier_label(&tier).map(str::to_owned)
}

#[napi]
pub fn next_cli_tier(tier: String) -> Option<String> {
    cli_router::next_cli_tier(&tier).map(str::to_owned)
}

#[napi]
pub fn higher_cli_tier(a: Option<String>, b: String) -> String {
    cli_router::higher_cli_tier(a.as_deref(), &b).to_owned()
}

#[napi]
pub fn route_cli_tier(prompt: String, intent: String, sticky_tier: Option<String>) -> Result<String> {
    fail(cli_router::route_cli_tier(&prompt, &intent, sticky_tier.as_deref()))
}
