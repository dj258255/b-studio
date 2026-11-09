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
use napi::Env;
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
