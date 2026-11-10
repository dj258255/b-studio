//! bstudio-guard를 Node에 붙이는 napi 층. 형 변환만 하고 판정은 하지 않는다.
//! TS 쪽 껍데기는 `packages/sandbox/src/native.ts`다.

use bstudio_guard::{container_policy, docs, js, readonly_docker, secrets};
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

// ── agent: requirement-issues(3단계 3c). 객체는 JSON 문자열로 받고, 문장은 그대로 주고받는다
use bstudio_guard::requirement_issues as ri;

#[napi]
pub fn req_issue_label() -> String {
    ri::REQUIREMENT_LABEL.to_owned()
}

#[napi]
pub fn req_issue_content_hash(text: String) -> String {
    ri::content_hash(&text)
}

#[napi]
pub fn req_issue_build_region_content(requirement_json: String) -> Result<String> {
    fail(ri::build_region_content(&input(&requirement_json, "요구사항")?))
}

#[napi]
pub fn req_issue_requirement_content_hash(requirement_json: String) -> Result<String> {
    fail(ri::requirement_content_hash(&input(&requirement_json, "요구사항")?))
}

#[napi]
pub fn req_issue_build_managed_region(requirement_json: String, rev: f64) -> Result<String> {
    fail(ri::build_managed_region(&input(&requirement_json, "요구사항")?, rev))
}

/// 관리형 영역이 없으면 null
#[napi]
pub fn req_issue_parse_managed_region(body: String) -> Option<String> {
    ri::parse_managed_region(&body).map(|r| out(&ri::managed_region_value(&r)))
}

#[napi]
pub fn req_issue_sub_issue_title(requirement_json: String) -> Result<String> {
    Ok(ri::sub_issue_title(&input(&requirement_json, "요구사항")?))
}

#[napi]
pub fn req_issue_id_from_title(title: String) -> Option<String> {
    ri::requirement_id_from_issue_title(&title)
}

#[napi]
pub fn req_issue_tracking_title(project: String) -> String {
    ri::tracking_issue_title(&project)
}

#[napi]
pub fn req_issue_find_tracking_issue(issues_json: String, project_name: String) -> Result<Option<String>> {
    Ok(fail(ri::find_tracking_issue(&input(&issues_json, "이슈 목록")?, &project_name))?.map(|v| out(&v)))
}

#[napi]
pub fn req_issue_label_set(requirement_json: String, status: String) -> Result<Vec<String>> {
    Ok(ri::requirement_label_set(&input(&requirement_json, "요구사항")?, &status))
}

#[napi]
pub fn req_issue_build_tracking_body(project_name: String, rows_json: String, updated_at: Option<String>) -> Result<String> {
    fail(ri::build_tracking_issue_body(&project_name, &input(&rows_json, "추적 표")?, updated_at.as_deref()))
}

/// 찾은 자리(없으면 -1)
#[napi]
pub fn req_issue_find_existing_remote(requirement_json: String, remote_json: String) -> Result<i32> {
    let requirement = input(&requirement_json, "요구사항")?;
    let JsValue::Arr(remote) = input(&remote_json, "원격 이슈")? else { return Err(Error::from_reason("원격 이슈는 배열이어야 합니다")) };
    Ok(ri::find_existing_remote_issue(&requirement, &remote).map_or(-1, |i| i as i32))
}

#[napi]
pub fn req_issue_plan(inputs_json: String, remote_json: String) -> Result<String> {
    Ok(out(&fail(ri::plan_requirement_publish(&input(&inputs_json, "발행 입력")?, &input(&remote_json, "원격 이슈")?))?))
}

#[napi]
pub fn req_issue_summarize_plan(entries_json: String) -> Result<String> {
    Ok(out(&fail(ri::summarize_requirement_plan(&input(&entries_json, "계획")?))?))
}

#[napi]
pub fn req_issue_build_status_comment(requirement_id: String, status: String, rows_json: String) -> Result<String> {
    fail(ri::build_status_comment(&requirement_id, &status, &input(&rows_json, "근거 표")?))
}

#[napi]
pub fn req_issue_is_status_comment(body: String, requirement_id: Option<String>) -> bool {
    ri::is_status_comment(&body, requirement_id.as_deref())
}

/// 처음 맞는 댓글의 자리(없으면 -1)
#[napi]
pub fn req_issue_find_pinned_status_comment(bodies: Vec<String>, requirement_id: String) -> i32 {
    ri::find_pinned_status_comment(&bodies, &requirement_id)
}

#[napi]
pub fn req_issue_implements_trailer(ref_json: String) -> Result<String> {
    Ok(ri::implements_trailer(&input(&ref_json, "구현 참조")?))
}

#[napi]
pub fn req_issue_extract_mentions(texts: Vec<String>) -> Vec<String> {
    ri::extract_requirement_mentions(&texts)
}

#[napi]
pub fn req_issue_build_addendum(refs_json: String, include_closes: bool) -> Result<String> {
    fail(ri::build_requirements_addendum(&input(&refs_json, "구현 참조")?, include_closes))
}

#[napi]
pub fn req_issue_build_review_context(entries_json: String) -> Result<String> {
    fail(ri::build_review_requirements_context(&input(&entries_json, "요구사항 목록")?))
}

#[napi]
pub fn req_issue_form_yaml() -> String {
    ri::build_requirement_issue_form_yaml()
}

#[napi]
pub fn req_issue_parse_issue_form(title: String, body: String) -> Option<String> {
    ri::parse_requirement_issue_form(&title, &body).map(|v| out(&v))
}

#[napi]
pub fn req_issue_draft_from_issue(title: String, body: String) -> String {
    out(&ri::draft_requirement_from_issue(&title, &body))
}

#[napi]
pub fn req_issue_draft_managed(title: String, body: String) -> Option<String> {
    ri::draft_managed_requirement(&title, &body).map(|v| out(&v))
}

#[napi]
pub fn req_issue_extract_tracking_numbers(body: String) -> String {
    out(&JsValue::Arr(ri::extract_tracking_sub_issue_numbers(&body).into_iter().map(JsValue::Num).collect()))
}

#[napi]
pub fn req_issue_managed_to_requirement(draft_json: String) -> Result<String> {
    Ok(out(&ri::managed_requirement_to_requirement(&input(&draft_json, "초안")?)))
}

#[napi]
pub fn req_issue_is_allowed_endpoint(pathname: String) -> bool {
    ri::is_allowed_requirement_endpoint(&pathname)
}

// ── agent: import-graph(ADR-191 3단계 3b). `packages/agent/src/import-graph.ts`의 순수 코어. 큰 구조는 JSON 문자열(encodeNative·decodeNative),
// 문자열 목록은 그대로 주고받는다. 별칭 설정은 `{ baseUrl?, paths: [{ pattern, targets }] }`, 역방향 그래프는 `[[파일, [import하는 파일…]], …]`(넣은 순서)다.
use bstudio_guard::import_graph::{self, AliasConfig, AliasPath, Token};
use std::collections::HashSet;

fn alias_to_value(alias: &AliasConfig, base_url_first: bool) -> JsValue {
    let base_url = alias.base_url.as_ref().map(|b| JsValue::str(b.clone()));
    let paths = JsValue::Arr(
        alias
            .paths
            .iter()
            .map(|p| js_json::object(vec![("pattern", Some(JsValue::str(p.pattern.clone()))), ("targets", Some(JsValue::Arr(p.targets.iter().map(|t| JsValue::str(t.clone())).collect())))]))
            .collect(),
    );
    // 옛 TS가 만든 객체의 키 순서: base에 baseUrl이 있었으면 baseUrl이 먼저, 아니면 paths가 먼저
    if base_url_first {
        js_json::object(vec![("baseUrl", base_url), ("paths", Some(paths))])
    } else {
        js_json::object(vec![("paths", Some(paths)), ("baseUrl", base_url)])
    }
}

fn alias_from_json(json: &str) -> Result<AliasConfig> {
    let value = input(json, "별칭 설정")?;
    let base_url = value.prop("baseUrl").and_then(JsValue::as_str).map(str::to_owned);
    let mut paths = Vec::new();
    if let Some(JsValue::Arr(items)) = value.prop("paths") {
        for item in items {
            let pattern = item.prop("pattern").and_then(JsValue::as_str).ok_or_else(|| Error::from_reason("별칭 paths 항목에 pattern이 없습니다"))?.to_owned();
            let targets = match item.prop("targets") {
                Some(JsValue::Arr(t)) => t.iter().filter_map(JsValue::as_str).map(str::to_owned).collect(),
                _ => return Err(Error::from_reason("별칭 paths 항목에 targets가 없습니다")),
            };
            paths.push(AliasPath { pattern, targets });
        }
    }
    Ok(AliasConfig { base_url, paths })
}

#[napi]
pub fn import_graph_is_page_file(relative: String) -> bool {
    import_graph::is_page_file_in_service(&relative)
}

#[napi]
pub fn import_graph_route_wrapper_folder(relative: String) -> Option<String> {
    import_graph::route_wrapper_folder(&relative)
}

#[napi]
pub fn import_graph_is_source_file(relative: String) -> bool {
    import_graph::is_graph_source_file(&relative)
}

/// 토큰 목록(JSON). `["s", 값, 템플릿 여부]`, `["w", 단어]`, `["p", UTF-16 코드 단위(수)]`, `["r"]`(정규식 리터럴)
#[napi]
pub fn import_graph_tokenize(source: String) -> String {
    let tokens = import_graph::tokenize(&source)
        .into_iter()
        .map(|t| match t {
            Token::Str { value, template } => JsValue::Arr(vec![JsValue::str("s"), JsValue::Str(value), JsValue::Bool(template)]),
            Token::Word(w) => JsValue::Arr(vec![JsValue::str("w"), JsValue::Str(w)]),
            Token::P(unit) => JsValue::Arr(vec![JsValue::str("p"), JsValue::Num(f64::from(unit))]),
            Token::Re => JsValue::Arr(vec![JsValue::str("r")]),
        })
        .collect();
    out(&JsValue::Arr(tokens))
}

#[napi]
pub fn import_graph_extract_specifiers(source: String) -> Vec<String> {
    import_graph::extract_import_specifiers(&source)
}

#[napi]
pub fn import_graph_normalize_path(value: String) -> Option<String> {
    import_graph::normalize_service_path(&value)
}

#[napi]
pub fn import_graph_dir_of(file: String) -> String {
    import_graph::dir_of(&file)
}

#[napi]
pub fn import_graph_strip_jsonc(text: String) -> String {
    import_graph::strip_jsonc(&text)
}

#[napi]
pub fn import_graph_extends_path(text: String, config_dir: String) -> Option<String> {
    import_graph::tsconfig_extends_path(&text, &config_dir)
}

/// `baseJson`은 extends로 물려받은 별칭 설정(없으면 null). 결과는 별칭 설정 JSON
#[napi]
pub fn import_graph_parse_alias_config(text: String, config_dir: String, base_json: Option<String>) -> Result<String> {
    let base = base_json.map(|json| alias_from_json(&json)).transpose()?;
    let (alias, base_url_first) = import_graph::parse_alias_config(&text, &config_dir, base.as_ref());
    Ok(out(&alias_to_value(&alias, base_url_first)))
}

#[napi]
pub fn import_graph_resolve_import(specifier: String, from_file: String, files: Vec<String>, alias_json: String) -> Result<Option<String>> {
    let alias = alias_from_json(&alias_json)?;
    let files: HashSet<String> = files.into_iter().collect();
    Ok(import_graph::resolve_import(&specifier, &from_file, &files, &alias))
}

/// `sourceFiles[i]`의 내용이 `sourceTexts[i]`다(넣은 순서). 결과는 `[[파일, [import하는 파일…]], …]`
#[napi]
pub fn import_graph_build_reverse(source_files: Vec<String>, source_texts: Vec<String>, files: Vec<String>, alias_json: String) -> Result<String> {
    if source_files.len() != source_texts.len() {
        return Err(Error::from_reason("소스 파일 이름과 내용의 개수가 다릅니다"));
    }
    let alias = alias_from_json(&alias_json)?;
    let files: HashSet<String> = files.into_iter().collect();
    let sources: Vec<(String, String)> = source_files.into_iter().zip(source_texts).collect();
    let reverse = import_graph::build_reverse_graph(&sources, &files, &alias);
    Ok(out(&JsValue::Arr(
        reverse.into_iter().map(|(target, importers)| JsValue::Arr(vec![JsValue::Str(target), JsValue::Arr(importers.into_iter().map(JsValue::Str).collect())])).collect(),
    )))
}

/// `reverseJson`은 `[[파일, [import하는 파일…]], …]`. 결과는 `{ candidates: [{ page, cause, distance, tie }], truncated: [{ cause, stoppedAt }] }`
#[napi]
pub fn import_graph_trace_pages(changed: Vec<String>, reverse_json: String, files: Vec<String>, max_depth: f64) -> Result<String> {
    let value = input(&reverse_json, "역방향 그래프")?;
    let JsValue::Arr(rows) = value else { return Err(Error::from_reason("역방향 그래프가 배열이 아닙니다")) };
    let mut reverse: import_graph::ReverseGraph = Vec::new();
    for row in &rows {
        let JsValue::Arr(pair) = row else { return Err(Error::from_reason("역방향 그래프 항목이 배열이 아닙니다")) };
        let (Some(JsValue::Str(target)), Some(JsValue::Arr(list))) = (pair.first(), pair.get(1)) else { return Err(Error::from_reason("역방향 그래프 항목의 모양이 맞지 않습니다")) };
        reverse.push((target.clone(), list.iter().filter_map(JsValue::as_str).map(str::to_owned).collect()));
    }
    let result = import_graph::trace_pages(&changed, &reverse, &files, max_depth);
    let candidates = result
        .candidates
        .into_iter()
        .map(|c| {
            js_json::object(vec![
                ("page", Some(JsValue::Str(c.page))),
                ("cause", Some(JsValue::Str(c.cause))),
                ("distance", Some(JsValue::Num(f64::from(c.distance)))),
                ("tie", Some(JsValue::Num(f64::from(c.tie)))),
            ])
        })
        .collect();
    let truncated = result.truncated.into_iter().map(|t| js_json::object(vec![("cause", Some(JsValue::Str(t.cause))), ("stoppedAt", Some(JsValue::Str(t.stopped_at)))])).collect();
    Ok(out(&js_json::object(vec![("candidates", Some(JsValue::Arr(candidates))), ("truncated", Some(JsValue::Arr(truncated)))])))
}

// ── 테스트 실행·결과(ADR-191 3d). 결과 객체는 JSON 문자열이다(`NaN`·`Infinity`가 나올 수 있는 결과는 표시 객체로, js_json 참고).
// TS 껍데기: packages/agent/src/{test-run,test-results}.ts

use bstudio_guard::{test_results, test_run};

/// 상수는 Rust가 정한 값을 TS가 읽어 쓴다(한 곳이 정한다)
#[napi]
pub fn test_run_constants() -> String {
    format!(
        "{{\"jestLikeReportPath\":{},\"pytestReportPath\":{},\"containerProjectRoot\":{}}}",
        bstudio_guard::js::json_quote(test_run::JEST_LIKE_REPORT_PATH),
        bstudio_guard::js::json_quote(test_run::PYTEST_REPORT_PATH),
        bstudio_guard::js::json_quote(test_run::CONTAINER_PROJECT_ROOT),
    )
}

/// 알 수 없는 실행기는 던진다
#[napi]
pub fn build_test_run_plan(
    runner: String,
    file: Option<String>,
    class_name: Option<String>,
    test_name: Option<String>,
    wrapper: Option<bool>,
    extra_report_roots: Vec<String>,
) -> Result<String> {
    fail(test_run::build_test_run_plan(&runner, file.as_deref(), class_name.as_deref(), test_name.as_deref(), wrapper, &extra_report_roots)).map(|plan| plan.to_json())
}

#[napi]
pub fn clear_test_reports_command(extra_report_roots: Vec<String>) -> Vec<String> {
    test_run::clear_test_reports_command(&extra_report_roots)
}

#[napi]
pub fn report_roots_for_includes(includes: Vec<String>, root: String) -> Vec<String> {
    test_run::report_roots_for_includes(&includes, &root)
}

#[napi]
pub fn split_collected_reports(stdout: String, single_file_label: String) -> String {
    test_run::reports_to_json(&test_run::split_collected_reports(&stdout, &single_file_label))
}

/// `package_json`은 부르는 쪽의 `package.json` 값(없으면 undefined·null)
#[napi]
pub fn detect_runner(template: String, has_pom_xml: Option<bool>, package_json: Option<String>) -> Result<Option<String>> {
    let package_json = package_json.map(|text| input(&text, "package.json")).transpose()?;
    Ok(test_run::detect_runner(&template, has_pom_xml == Some(true), package_json.as_ref()).map(str::to_owned))
}

#[napi]
pub fn runner_label(runner: String) -> Result<String> {
    fail(test_run::runner_label(&runner)).map(str::to_owned)
}

/// 범위 밖 엔티티(`&#x110000;`)는 던진다
#[napi]
pub fn parse_j_unit_xml(xml: String) -> Result<String> {
    fail(test_results::parse_junit_xml(&xml)).map(|run| out(&run))
}

/// JSON이 아니면 빈 결과, JSON `null`이면 던진다
#[napi]
pub fn parse_jest_like_json(json: String) -> Result<String> {
    fail(test_results::parse_jest_like_json(&json)).map(|run| out(&run))
}

/// 행마다 짝지은 케이스의 위치(없으면 -1). 행·케이스는 판정에 쓰는 필드만 담은 JSON, `ids`는 같은 객체면 같은 값
#[napi]
pub fn attach_results(rows_json: String, cases_json: String, ids: Vec<u32>) -> Result<Vec<i64>> {
    fail(test_results::attach_results(&rows_json, &cases_json, &ids))
}

#[napi]
pub fn count_by_status(statuses_json: String) -> Result<String> {
    fail(test_results::count_by_status(&statuses_json))
}

#[napi]
pub fn build_fix_test_prefill(row_json: String) -> Result<String> {
    fail(test_results::build_fix_test_prefill(&row_json))
}

#[napi]
pub fn build_add_test_prefill(requirement_json: String) -> Result<String> {
    fail(test_results::build_add_test_prefill(&requirement_json))
}

// ── 게이트 리뷰 판정(ADR-191 3단계 3e). 확인 선언 변경(declared-checks), 근거 줄(check-evidence), 부하 판정(load-check), 계약 비교(contract-diff).
// 입력·출력은 JSON 문자열이다(`NaN`·`Infinity`·`-0`은 표시 객체, js_json 모듈). 판정 입력은 짝 없는 서로게이트가 있으면 던진다(review_input).
// 모양이 어긋난 입력은 던진다. TS 껍데기: packages/agent/src/{declared-checks,check-evidence,load-check,contract-diff}.ts
use bstudio_guard::{check_evidence, contract_diff, declared_checks, load_check, review_input};

/// 판정에 쓸 JSON. 짝 없는 서로게이트가 있으면 던진다
fn review_json(json: &str, what: &str) -> Result<JsValue> {
    fail(review_input::parse_checked(json, what))
}

fn change_of(added: Vec<String>, removed: Vec<String>, changed: Vec<String>) -> declared_checks::DeclaredCheckChange {
    declared_checks::DeclaredCheckChange { added, removed, changed }
}

#[napi]
pub fn diff_declared_checks(started_json: String, latest_json: String) -> Result<String> {
    let (started, latest) = (review_json(&started_json, "시작할 때의 선언")?, review_json(&latest_json, "지금의 선언")?);
    Ok(out(&fail(declared_checks::diff_declared_checks(Some(&started), Some(&latest)))?.to_value()))
}

#[napi]
pub fn weakened_declarations(started_json: String, latest_json: String) -> Result<Vec<String>> {
    let (started, latest) = (review_json(&started_json, "시작할 때의 선언")?, review_json(&latest_json, "지금의 선언")?);
    fail(declared_checks::weakened_declarations(Some(&started), Some(&latest)))
}

#[napi]
pub fn has_declared_check_change(added: Vec<String>, removed: Vec<String>, changed: Vec<String>) -> bool {
    declared_checks::has_declared_check_change(&change_of(added, removed, changed))
}

#[napi]
pub fn describe_declared_check_change(added: Vec<String>, removed: Vec<String>, changed: Vec<String>) -> String {
    declared_checks::describe_declared_check_change(&change_of(added, removed, changed))
}

/// 남은 선언이 없으면 null
#[napi]
pub fn with_declared_checks(started_json: String, latest_json: String) -> Result<Option<String>> {
    let (started, latest) = (review_json(&started_json, "시작할 때의 선언")?, review_json(&latest_json, "지금의 선언")?);
    Ok(fail(declared_checks::with_declared_checks(Some(&started), Some(&latest)))?.map(|merged| out(&merged)))
}

#[napi]
pub fn load_request_for(check_json: String) -> Result<String> {
    Ok(out(&fail(load_check::load_request_for(&review_json(&check_json, "부하 확인 선언")?))?))
}

#[napi]
pub fn describe_load_expect(expect_json: String) -> Result<String> {
    fail(load_check::describe_load_expect(&review_json(&expect_json, "응답 시간 기준")?))
}

#[napi]
pub fn judge_load(check_json: String, result_json: String) -> Result<String> {
    let (check, result) = (review_json(&check_json, "부하 확인 선언")?, review_json(&result_json, "부하 결과")?);
    Ok(out(&fail(load_check::judge_load(&check, &result))?.to_value()))
}

/// 시크릿을 가리는 JS 함수를 부른다. 던지면 그 이유를 돌려준다
fn redactor<'a, 'f>(redact: &'a Function<'f, String, String>) -> impl Fn(&str) -> std::result::Result<String, String> + 'a {
    move |text| redact.call(text.to_owned()).map_err(|e| e.reason.clone())
}

/// 근거 줄에 쓰는 JSON. 판정이 아니라 설명이라 짝 없는 서로게이트는 U+FFFD로 읽는다
fn evidence_json(json: &str, what: &str) -> Result<JsValue> {
    input(json, what)
}

#[napi]
pub fn finish_evidence(lines: Vec<String>, redact: Function<String, String>) -> Result<Vec<String>> {
    fail(check_evidence::finish_evidence(&lines, &redactor(&redact)))
}

#[napi]
pub fn browser_page_evidence(page_json: String, result_json: String, context_json: String, redact: Function<String, String>) -> Result<Vec<String>> {
    let (page, result, context) = (evidence_json(&page_json, "화면 확인 선언")?, evidence_json(&result_json, "화면 확인 결과")?, evidence_json(&context_json, "근거 맥락")?);
    fail(check_evidence::browser_page_evidence(&page, &result, Some(&context), &redactor(&redact)))
}

#[napi]
pub fn http_page_evidence(page_json: String, response_json: String, context_json: String, redact: Function<String, String>) -> Result<Vec<String>> {
    let (page, response, context) = (evidence_json(&page_json, "화면 확인 선언")?, evidence_json(&response_json, "HTTP 응답")?, evidence_json(&context_json, "근거 맥락")?);
    fail(check_evidence::http_page_evidence(&page, &response, Some(&context), &redactor(&redact)))
}

#[napi]
pub fn test_evidence(service: String, command: Vec<String>, elapsed_ms: f64) -> Vec<String> {
    check_evidence::test_evidence(&service, &command, elapsed_ms)
}

/// before가 `null`이면 이전 문서가 없다
#[napi]
pub fn diff_contracts(before_json: String, after_json: String) -> Result<String> {
    let (before, after) = (review_json(&before_json, "이전 계약")?, review_json(&after_json, "지금 계약")?);
    let changes = fail(contract_diff::diff_contracts(Some(&before), &after))?;
    Ok(out(&JsValue::Arr(changes.iter().map(contract_diff::ContractChange::to_value).collect())))
}

#[napi]
pub fn summarize_contract(document_json: String) -> Result<String> {
    fail(contract_diff::summarize_contract(&review_json(&document_json, "계약")?))
}

#[napi]
pub fn format_contract_changes(changes_json: String) -> Result<String> {
    // 변경 목록은 비교 결과를 글자로 옮길 뿐이라 짝 없는 서로게이트는 U+FFFD로 읽는다(근거 줄과 같다)
    fail(contract_diff::format_contract_changes(&input(&changes_json, "계약 변경 목록")?))
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

// ── agent: coordination·escalation(3단계 3i). 객체는 JSON 문자열(encodeNative·decodeNative). 선언한 모양이 어긋난 입력은 던진다
use bstudio_guard::{coordination, escalation};

#[napi]
pub fn coord_normalize_message(text: String) -> String {
    coordination::normalize_message(&text)
}

#[napi]
pub fn coord_signature_key(signature_json: String) -> Result<String> {
    fail(coordination::signature_key(&input(&signature_json, "실패 서명")?))
}

#[napi]
pub fn coord_signatures_from_report(report_json: String) -> Result<String> {
    Ok(out(&JsValue::Arr(fail(coordination::signatures_from_report(&input(&report_json, "검증 보고서")?))?)))
}

#[napi]
pub fn coord_signature_from_check(check_json: String) -> Result<String> {
    Ok(out(&fail(coordination::signature_from_check(&input(&check_json, "워크플로 확인")?))?))
}

#[napi]
pub fn coord_failure_notes_from_report(report_json: String, checks_json: String) -> Result<String> {
    let notes = coordination::failure_notes_from_report(&input(&report_json, "검증 보고서")?, &input(&checks_json, "워크플로 확인 목록")?);
    Ok(out(&JsValue::Arr(fail(notes)?)))
}

#[napi]
pub fn coord_failure_notes_from_events(events_json: String) -> Result<String> {
    Ok(out(&JsValue::Arr(fail(coordination::failure_notes_from_events(&input(&events_json, "세션 이벤트")?))?)))
}

#[napi]
pub fn coord_note_bytes(body: String) -> f64 {
    coordination::note_bytes(&body) as f64
}

#[napi]
pub fn coord_can_read(topology: String, reader_lane: String, reader_group: Option<String>, note_by: String, note_lane: String, note_group: Option<String>, hub: String) -> bool {
    coordination::can_read(&topology, &reader_lane, reader_group.as_deref(), &note_by, &note_lane, note_group.as_deref(), &hub)
}

/// `reportJson`이 없으면(undefined) 보고서 없이 확인 목록만 본다
#[napi]
pub fn escalation_signature_set_key(report_json: Option<String>, checks_json: String) -> Result<String> {
    let report = match report_json {
        Some(text) => Some(input(&text, "검증 보고서")?),
        None => None,
    };
    fail(escalation::signature_set_key(report.as_ref(), &input(&checks_json, "워크플로 확인 목록")?))
}

#[napi]
pub fn escalation_should_escalate(history: Vec<String>, times: f64) -> bool {
    escalation::should_escalate(&history, times)
}

#[napi]
pub fn escalation_should_promote(same_signature_times: Option<f64>, default_times: f64, after_failures: Option<f64>, history: Vec<String>) -> bool {
    escalation::should_promote(same_signature_times, default_times, after_failures, &history)
}

#[napi]
pub fn escalation_retry_budget_for(retry_budget: Option<f64>, default_budget: f64) -> f64 {
    escalation::retry_budget_for(retry_budget, default_budget)
}

#[napi]
pub fn escalation_prompt(summary: String, last_feedback: Option<String>) -> String {
    escalation::escalation_prompt(&summary, last_feedback.as_deref())
}

// ── 커밋 메시지 만들기·PR 리뷰의 순수 판정(ADR-191 3g). TS 껍데기: packages/agent/src/commit-message.ts, pr-review.ts
// 지적·입력 객체는 encodeNative한 JSON 문자열로 받는다. 결과 객체는 JSON 문자열이다(옛 TS의 JSON.stringify와 같은 글자)

use bstudio_guard::{commit_message, pr_review};

fn commit_changes<'a>(files: &'a [String], kinds: &'a [String]) -> Vec<commit_message::Change<'a>> {
    files.iter().zip(kinds).map(|(file, change)| commit_message::Change { file, change }).collect()
}

#[napi]
pub fn classify_commit(request: String, files: Vec<String>, kinds: Vec<String>) -> String {
    commit_message::classify_commit(&request, &commit_changes(&files, &kinds)).to_owned()
}

#[napi]
pub fn generate_commit_subject(request: String, files: Vec<String>, kinds: Vec<String>, agent_summary: Option<String>, request_is_answer: bool) -> String {
    commit_message::generate_commit_subject(&request, &commit_changes(&files, &kinds), agent_summary.as_deref(), request_is_answer)
}

#[napi]
pub fn summarize_commit_text(text: String, max_chars: f64) -> String {
    commit_message::summarize(&text, max_chars)
}

#[napi]
pub fn to_commit_mood(text: String) -> String {
    commit_message::to_commit_mood(&text)
}

#[napi]
pub fn pr_review_fix_marker() -> String {
    pr_review::FIX_MARKER.to_owned()
}

#[napi]
pub fn is_blocking_severity(severity: String) -> bool {
    pr_review::is_blocking_severity(&severity)
}

#[napi]
pub fn has_blocking_findings(severities: Vec<String>) -> bool {
    pr_review::has_blocking_findings(&severities)
}

/// `[blocker, major, minor, nit]`
#[napi]
pub fn pr_review_severity_counts(severities: Vec<String>) -> Vec<u32> {
    pr_review::severity_counts(&severities).to_vec()
}

#[napi]
pub fn next_pr_review_step(severities: Vec<String>, round: f64, max_rounds: f64) -> String {
    pr_review::next_pr_review_step(&severities, round, max_rounds).to_owned()
}

/// `{ diff, truncated, omittedFiles }` JSON. 상한이 정수가 아니면 던진다(구분이 없는 diff를 자를 때만)
#[napi]
pub fn truncate_diff(diff: String, max_chars: f64) -> Result<String> {
    Ok(fail(pr_review::truncate_diff(&diff, max_chars))?.to_json())
}

#[napi]
pub fn diff_file_paths(diff: String) -> Vec<String> {
    pr_review::diff_file_paths(&diff)
}

#[napi]
pub fn extract_diff_referenced_names(diff: String) -> Vec<String> {
    pr_review::extract_diff_referenced_names(&diff)
}

#[napi]
pub fn build_pr_review_external_context(paths: Vec<String>, excerpts: Vec<String>, max_chars: f64) -> String {
    pr_review::build_pr_review_external_context(&paths, &excerpts, max_chars)
}

#[napi]
pub fn build_pr_review_user_prompt(input_json: String) -> Result<String> {
    fail(pr_review::build_pr_review_user_prompt(&input(&input_json, "리뷰 요청")?))
}

#[napi]
pub fn pr_review_marker(round: f64) -> String {
    pr_review::pr_review_marker(round)
}

#[napi]
pub fn build_pr_review_comment(input_json: String) -> Result<String> {
    fail(pr_review::build_pr_review_comment(&input(&input_json, "리뷰 코멘트 입력")?))
}

#[napi]
pub fn build_pr_review_resolved_context(resolved_json: String) -> Result<String> {
    fail(pr_review::build_pr_review_resolved_context(&input(&resolved_json, "닫은 지적 목록")?))
}

/// `{ finding, reason? }` JSON
#[napi]
pub fn build_review_resolution_comment(input_json: String) -> Result<String> {
    let value = input(&input_json, "닫은 지적")?;
    let finding = value.prop("finding").ok_or_else(|| Error::from_reason("finding이 없습니다"))?;
    fail(pr_review::build_review_resolution_comment(finding, value.prop("reason")))
}

#[napi]
pub fn build_pr_review_fix_request(findings_json: String) -> Result<String> {
    fail(pr_review::build_pr_review_fix_request(&input(&findings_json, "지적 목록")?))
}

/// 고침 요청이 아니거나 제목이 없으면 null
#[napi]
pub fn extract_pr_review_fix_titles(request: String) -> Option<Vec<String>> {
    pr_review::extract_pr_review_fix_titles(&request)
}

// ── agent: next-routes·project-status·stuck-loading(ADR-191 3단계 3h). TS 껍데기: packages/agent/src/{next-routes,project-status,stuck-loading}.ts

use bstudio_guard::{next_routes as nr, project_status as ps, stuck_loading as sl};

fn sample_params(json: &str) -> Result<js_json::JsObject> {
    match input(json, "sampleParams")? {
        JsValue::Obj(o) => Ok(o),
        _ => Err(Error::from_reason("sampleParams가 객체가 아닙니다")),
    }
}

#[napi]
pub fn next_routes_is_id_like_segment(name: String) -> bool {
    nr::is_id_like_segment(&name)
}

/// `max_pages`는 `Math.floor` 전의 값 그대로(`NaN`·`Infinity` 포함), `max_pages_cap`은 spec의 `AUTO_PAGE_MAX`
#[napi]
pub fn next_routes_from_changed_files(
    files: Vec<String>,
    service_path: String,
    sample_params_json: String,
    max_pages: f64,
    max_pages_cap: f64,
    fallback_value: Option<String>,
) -> Result<String> {
    let params = sample_params(&sample_params_json)?;
    Ok(out(&nr::routes_from_changed_files(&files, &service_path, &params, max_pages, max_pages_cap, fallback_value.as_deref()).to_value()))
}

#[napi]
pub fn next_routes_from_candidates(
    candidates_json: String,
    service_path: String,
    sample_params_json: String,
    max_pages: f64,
    max_pages_cap: f64,
    fallback_value: Option<String>,
) -> Result<String> {
    let params = sample_params(&sample_params_json)?;
    let candidates = fail(nr::parse_candidates(&input(&candidates_json, "후보 목록")?))?;
    Ok(out(&nr::routes_from_candidates(&candidates, &service_path, &params, max_pages, max_pages_cap, fallback_value.as_deref()).to_value()))
}

#[napi]
pub fn project_status_build(input_json: String) -> Result<String> {
    Ok(out(&fail(ps::build_project_status(&input(&input_json, "현황 입력")?))?))
}

/// `evidence_json`이 null이면 증거를 모르는 것(HTTP 모드)
#[napi]
pub fn stuck_loading_detect(text: String, evidence_json: Option<String>) -> Result<Option<String>> {
    let evidence = match evidence_json {
        Some(json) => Some(input(&json, "증거")?),
        None => None,
    };
    Ok(sl::detect_stuck_loading(&text, evidence.as_ref()))
}

use bstudio_guard::{cli_failure, services};

#[napi]
pub fn services_for_files(input_json: String) -> Result<String> {
    fail(services::services_for_files_json(&input_json))
}

#[napi]
pub fn owns_file(path: String, includes: Vec<String>, file: String) -> bool {
    services::owns_file(&path, &includes, &file)
}

#[napi]
pub fn is_compose_file(root: String, compose_path: String, cwd: String, file: String) -> bool {
    services::is_compose_file(&root, &compose_path, &cwd, &file)
}

#[napi]
pub fn describe_cli_text(raw: String) -> String {
    cli_failure::describe_cli_text(&raw)
}

#[napi]
pub fn cli_failure_reason(summary: String, detail: String) -> String {
    cli_failure::failure_reason(&summary, &detail)
}

// ── 요구사항 순수 코어(ADR-191 3단계 3j). 객체는 JSON 문자열(NaN·Infinity는 표시 객체, js_json 모듈). 모양이 어긋난 입력은 던진다.
// 짝 없는 서로게이트는 U+FFFD로 읽는다. TS 껍데기: packages/agent/src/requirements.ts, doc-lint.ts
use bstudio_guard::{doc_lint, requirements as rq};

/// 값이 없으면 `null`·`undefined`를 받는다(`requirement?`)
fn optional_input(json: Option<&str>, what: &str) -> Result<Option<JsValue>> {
    json.map(|text| input(text, what)).transpose()
}

fn positions(indexes: Vec<usize>) -> Vec<u32> {
    indexes.into_iter().map(|i| i as u32).collect()
}

#[napi]
pub fn req_core_requirements_file() -> String {
    rq::REQUIREMENTS_FILE.to_owned()
}

/// `[재추출 병합의 짝짓기 문턱, 분할 힌트 문턱]`
#[napi]
pub fn req_core_merge_thresholds() -> Vec<f64> {
    vec![rq::MERGE_MATCH_THRESHOLD, rq::MERGE_SPLIT_HINT_THRESHOLD]
}

#[napi]
pub fn req_core_weak_words_ko() -> Vec<String> {
    rq::WEAK_WORDS_KO.iter().map(|w| (*w).to_owned()).collect()
}

#[napi]
pub fn req_core_weak_words_en() -> Vec<String> {
    rq::WEAK_WORDS_EN.iter().map(|w| (*w).to_owned()).collect()
}

#[napi]
pub fn req_core_find_mentioned_ids(text: String) -> Vec<String> {
    rq::find_mentioned_ids(&text)
}

#[napi]
pub fn req_core_mentions_requirement_id(text: String, id: String) -> bool {
    rq::mentions_requirement_id(&text, &id)
}

/// `[{ id, rev? }]`
#[napi]
pub fn req_core_implements_trailers(text: String) -> String {
    let items = rq::extract_implements_trailers(&text)
        .into_iter()
        .map(|(id, rev)| js_json::object(vec![("id", Some(JsValue::Str(id))), ("rev", rev.map(JsValue::Num))]))
        .collect();
    out(&JsValue::Arr(items))
}

#[napi]
pub fn req_core_checkpoint_mention_indexes(messages: Vec<String>, id: String) -> Vec<u32> {
    positions(rq::find_checkpoint_mention_indexes(&messages, &id))
}

#[napi]
pub fn req_core_gate_check_mention_indexes(names: Vec<String>, id: String) -> Vec<u32> {
    positions(rq::find_gate_check_mention_indexes(&names, &id))
}

#[napi]
pub fn req_core_is_likely_test_file(path: String) -> bool {
    rq::is_likely_test_file(&path)
}

/// 바꿀 것이 없으면 null
#[napi]
pub fn req_core_aligned_scenario_ids(requirement_id: String, scenario_ids: Vec<String>) -> Result<Option<Vec<String>>> {
    fail(rq::aligned_scenario_ids(&requirement_id, &scenario_ids))
}

#[napi]
pub fn req_core_requirement_hash(requirement_json: String) -> Result<String> {
    fail(rq::compute_requirement_hash(&input(&requirement_json, "요구사항")?))
}

#[napi]
pub fn req_core_content_drifted(requirement_json: String) -> Result<bool> {
    fail(rq::requirement_content_drifted(&input(&requirement_json, "요구사항")?))
}

/// 바뀐 것이 없으면 null
#[napi]
pub fn req_core_revise(requirement_json: String, now: String) -> Result<Option<String>> {
    Ok(fail(rq::revise_requirement_if_changed(&input(&requirement_json, "요구사항")?, &now))?.map(|r| out(&r)))
}

#[napi]
pub fn req_core_carry_forward(next_json: String, previous_json: String) -> Result<String> {
    Ok(out(&fail(rq::carry_forward_requirement_revision(&input(&next_json, "요구사항")?, &input(&previous_json, "이전 요구사항")?))?))
}

#[napi]
pub fn req_core_discard_revision(requirement_json: String) -> Result<String> {
    Ok(out(&fail(rq::discard_revision(&input(&requirement_json, "요구사항")?))?))
}

#[napi]
pub fn req_core_status(evidence_json: String, requirement_json: Option<String>) -> Result<String> {
    let evidence = input(&evidence_json, "증거")?;
    let requirement = optional_input(requirement_json.as_deref(), "요구사항")?;
    Ok(fail(rq::compute_requirement_status(&evidence, requirement.as_ref()))?.to_owned())
}

#[napi]
pub fn req_core_verification_source(evidence_json: String, requirement_json: Option<String>) -> Result<String> {
    let evidence = input(&evidence_json, "증거")?;
    let requirement = optional_input(requirement_json.as_deref(), "요구사항")?;
    Ok(fail(rq::requirement_verification_source(&evidence, requirement.as_ref()))?.to_owned())
}

#[napi]
pub fn req_core_verification_badge(status: String, evidence_json: String, requirement_json: Option<String>) -> Result<String> {
    let evidence = input(&evidence_json, "증거")?;
    let requirement = optional_input(requirement_json.as_deref(), "요구사항")?;
    Ok(fail(rq::matrix_verification_badge(&status, &evidence, requirement.as_ref()))?.to_owned())
}

#[napi]
pub fn req_core_confidence(status: String) -> String {
    rq::requirement_confidence(&status).to_owned()
}

#[napi]
pub fn req_core_summarize_coverage(requirements_json: String, status_json: String) -> Result<String> {
    Ok(out(&fail(rq::summarize_coverage(&input(&requirements_json, "요구사항 목록")?, &input(&status_json, "상태 표")?))?))
}

#[napi]
pub fn req_core_lint_requirement(requirement_json: String) -> Result<String> {
    let warnings = fail(rq::lint_requirement(&input(&requirement_json, "요구사항")?))?;
    Ok(out(&JsValue::Arr(warnings.iter().map(rq::LintWarning::to_value).collect())))
}

#[napi]
pub fn req_core_requirement_is_ready(requirement_json: String) -> Result<bool> {
    fail(rq::requirement_is_ready(&input(&requirement_json, "요구사항")?))
}

#[napi]
pub fn req_core_ready_badge(requirements_json: String) -> Result<bool> {
    fail(rq::requirements_ready_badge(&input(&requirements_json, "요구사항 목록")?))
}

#[napi]
pub fn req_core_is_manual_step_text(text: String) -> bool {
    rq::is_manual_step_text(&text)
}

/// `{ movedIndexes, manualSteps }`
#[napi]
pub fn req_core_partition_manual_steps(requirements_json: String, manual_steps: Vec<String>) -> Result<String> {
    let (moved, steps) = fail(rq::partition_manual_steps(&input(&requirements_json, "요구사항 목록")?, &manual_steps))?;
    Ok(out(&js_json::object(vec![
        ("movedIndexes", Some(JsValue::Arr(moved.into_iter().map(|i| JsValue::Num(i as f64)).collect()))),
        ("manualSteps", Some(JsValue::Arr(steps.into_iter().map(JsValue::Str).collect()))),
    ])))
}

#[napi]
pub fn req_core_extract_heuristically(spec_text: String) -> String {
    out(&rq::extract_requirements_heuristically(&spec_text))
}

#[napi]
pub fn req_core_extract_path_references(spec_text: String) -> Vec<String> {
    rq::extract_path_references(&spec_text)
}

#[napi]
pub fn req_core_missing_reference_question(path: String) -> String {
    rq::build_missing_reference_question(&path)
}

#[napi]
pub fn req_core_referenced_files_context(files_json: String, max_chars: f64) -> Result<String> {
    fail(rq::build_referenced_files_context(&input(&files_json, "참조 파일 목록")?, max_chars))
}

#[napi]
pub fn req_core_verify_spec_quote(spec_quote: String, spec_text: String) -> bool {
    rq::verify_spec_quote(&spec_quote, &spec_text)
}

#[napi]
pub fn req_core_extraction_user_prompt(spec_text: String, referenced_files_context: Option<String>) -> String {
    rq::build_extraction_user_prompt(&spec_text, referenced_files_context.as_deref())
}

#[napi]
pub fn req_core_recommendation_user_prompt(questions: Vec<String>, spec_text: String, stack_summary: Option<String>) -> String {
    rq::build_recommendation_user_prompt(&questions, &spec_text, stack_summary.as_deref())
}

#[napi]
pub fn req_core_extraction_retry_note(reason: String) -> String {
    rq::build_extraction_retry_note(&reason)
}

#[napi]
pub fn req_core_summarize_requirements_for_guide(requirements_json: String, max_chars: f64) -> Result<String> {
    fail(rq::summarize_requirements_for_guide(&input(&requirements_json, "요구사항 목록")?, max_chars))
}

#[napi]
pub fn req_core_summarize_manual_steps_for_guide(manual_steps: Vec<String>, max_chars: f64) -> String {
    rq::summarize_manual_steps_for_guide(&manual_steps, max_chars)
}

#[napi]
pub fn req_core_work_prefill(requirement_json: String) -> Result<String> {
    fail(rq::build_requirement_work_prefill(&input(&requirement_json, "요구사항")?))
}

#[napi]
pub fn req_core_all_must_prefill(requirements_json: String) -> Result<String> {
    fail(rq::build_all_must_haves_prefill(&input(&requirements_json, "요구사항 목록")?))
}

#[napi]
pub fn req_core_text_similarity(a: String, b: String) -> f64 {
    rq::text_similarity(&a, &b)
}

#[napi]
pub fn req_core_api_signature(title: String) -> Option<String> {
    rq::api_signature(&title)
}

#[napi]
pub fn req_core_requirement_similarity(a_json: String, b_json: String) -> Result<f64> {
    fail(rq::requirement_similarity(&input(&a_json, "요구사항")?, &input(&b_json, "요구사항")?))
}

#[napi]
pub fn req_core_merge(incoming_json: String, existing_json: String, now: String) -> Result<String> {
    Ok(out(&fail(rq::merge_reextracted_requirements(&input(&incoming_json, "새 요구사항 목록")?, &input(&existing_json, "기존 요구사항 목록")?, &now))?))
}

#[napi]
pub fn req_core_unexecuted_tests(requirement_id: String, rows_json: String) -> Result<String> {
    Ok(out(&fail(rq::find_unexecuted_tests(&requirement_id, &input(&rows_json, "테스트 실행 행")?))?))
}

#[napi]
pub fn req_core_matrix_csv(matrix_json: String) -> Result<String> {
    fail(rq::build_matrix_csv(&input(&matrix_json, "추적 매트릭스")?))
}

/// `[{ line, code, message }]`
#[napi]
pub fn doc_lint_text(text: String) -> String {
    out(&JsValue::Arr(doc_lint::lint_text(&text).iter().map(doc_lint::Finding::to_value).collect()))
}

// ── agent: "문서" 탭(3단계 3k)

#[napi]
pub fn docs_slugify_title(title: String) -> String {
    docs::slugify_title(&title)
}

#[napi]
pub fn docs_next_design_doc_number(existing: Vec<String>) -> f64 {
    docs::next_design_doc_number(&existing)
}

#[napi]
pub fn docs_next_adr_number(existing: Vec<String>) -> f64 {
    docs::next_adr_number(&existing)
}

#[napi]
pub fn docs_design_doc_file_path(number: f64, title: String) -> String {
    docs::design_doc_file_path(number, &title)
}

#[napi]
pub fn docs_adr_file_path(number: f64, title: String) -> String {
    docs::adr_file_path(number, &title)
}

#[napi]
pub fn docs_build_design_doc_template(number: f64, title: String) -> String {
    docs::build_design_doc_template(number, &title)
}

#[napi]
pub fn docs_build_adr_template(number: f64, title: String, date: String, related: Vec<String>) -> String {
    docs::build_adr_template(number, &title, &date, &related)
}

/// 알 수 없는 종류는 던진다(껍데기는 고정된 종류만 넘긴다)
#[napi]
pub fn docs_build_entry(kind: String, title: String, fields: Vec<String>) -> Result<String> {
    fail(docs::build_entry(&kind, &title, &fields))
}

/// 알 수 없는 종류는 던진다(껍데기는 고정된 종류만 넘긴다)
#[napi]
pub fn docs_append_entry(kind: String, existing: Option<String>, entry: String) -> Result<String> {
    fail(docs::append_entry(&kind, existing.as_deref(), &entry))
}

#[napi]
pub fn docs_build_roadmap_template() -> String {
    docs::build_roadmap_template()
}

#[napi]
#[allow(clippy::too_many_arguments)]
pub fn docs_regenerate_roadmap_status(
    existing: Option<String>,
    statuses: Vec<String>,
    counts: Vec<f64>,
    must_total: f64,
    must_done: f64,
    should_total: f64,
    should_done: f64,
) -> String {
    docs::regenerate_roadmap_status(existing.as_deref(), &statuses, &counts, (must_total, must_done), (should_total, should_done))
}

/// `{title, paragraph}` JSON
#[napi]
pub fn docs_extract_doc_summary(markdown: String) -> String {
    let (title, paragraph) = docs::extract_doc_summary(&markdown);
    format!(r#"{{"title":{},"paragraph":{}}}"#, js::json_quote(&title), js::json_quote(&paragraph))
}

/// `{path, title, paragraph}` JSON
#[napi]
pub fn docs_build_doc_summary(path: String, markdown: String) -> String {
    let (path, title, paragraph) = docs::build_doc_summary(&path, &markdown);
    format!(r#"{{"path":{},"title":{},"paragraph":{}}}"#, js::json_quote(&path), js::json_quote(&title), js::json_quote(&paragraph))
}

/// 모양이 어긋난 요약 목록은 던진다
#[napi]
pub fn docs_regenerate_docs_readme(existing: Option<String>, docs_json: String) -> Result<String> {
    fail(docs::regenerate_docs_readme(existing.as_deref(), &docs_json))
}

// ── 계획 요약·레인 계약(ADR-191 3m). project·lanes는 읽는 필드만 담은 JSON 문자열. TS 껍데기: packages/agent/src/{plan-brief,lane-contracts}.ts
use bstudio_guard::plan_brief;

#[napi]
pub fn should_plan_brief(request: String) -> bool {
    plan_brief::should_plan_brief(&request)
}

#[napi]
pub fn plan_word_limit(request: String, short: f64, long: f64) -> f64 {
    plan_brief::plan_word_limit(&request, short, long)
}

/// project: `{ name, managed: [[이름, { template, path }]] }`
#[napi]
pub fn build_plan_brief_system(project_json: String, request: String, short: f64, long: f64) -> Result<String> {
    fail(plan_brief::build_plan_brief_system(&input(&project_json, "프로젝트 요약")?, &request, short, long))
}

#[napi]
pub fn append_plan_to_request(request: String, plan: String, max_chars: f64) -> String {
    plan_brief::append_plan_to_request(&request, &plan, max_chars)
}

#[napi]
pub fn build_contract_system(project_json: String, max_contracts: f64) -> Result<String> {
    fail(plan_brief::build_contract_system(&input(&project_json, "프로젝트 요약")?, max_contracts))
}

/// lanes: `[{ id, paths, tasks: [{ id, title, request }] }]`
#[napi]
pub fn build_contract_user(request: String, lanes_json: String) -> Result<String> {
    fail(plan_brief::build_contract_user(&request, &input(&lanes_json, "레인 목록")?))
}

// ── agent: 설계 파이프라인(3단계 3o)
use bstudio_guard::design_pipeline;

#[napi]
pub fn design_pipeline_next_doc_number(existing: Vec<String>) -> f64 {
    design_pipeline::next_design_pipeline_doc_number(&existing)
}

#[napi]
pub fn design_pipeline_doc_path(number: f64, title: String) -> String {
    design_pipeline::design_pipeline_doc_path(number, &title)
}

#[napi]
pub fn design_pipeline_sidecar_path(doc_path: String) -> String {
    design_pipeline::design_pipeline_sidecar_path(&doc_path)
}

#[napi]
pub fn design_pipeline_is_doc_path(file: String) -> bool {
    design_pipeline::is_design_pipeline_doc_path(&file)
}

/// 묶음 목록 JSON(`encodeNative` 꼴: 유한하지 않은 수는 표시 객체)
#[napi]
pub fn design_pipeline_parse_bundles_table(markdown: String) -> String {
    design_pipeline::parse_design_bundles_table(&markdown)
}

#[napi]
pub fn design_pipeline_build_request_prompt(title: String, requirement_ids: Vec<String>, detail: Option<String>) -> String {
    design_pipeline::build_design_pipeline_request_prompt(&title, &requirement_ids, detail.as_deref())
}

#[napi]
pub fn design_pipeline_build_doc_template(number: f64, title: String, requirement_ids: Vec<String>) -> String {
    design_pipeline::build_design_pipeline_doc_template(number, &title, &requirement_ids)
}

/// 막는 기록들의 순번 목록. 모양이 어긋난 기록은 던진다(껍데기는 던지면 구현을 시작하지 않는다)
#[napi]
pub fn design_pipeline_check_approval(requirement_ids: Vec<String>, docs_json: String) -> Result<Vec<u32>> {
    let indexes = fail(design_pipeline::check_design_approval(&requirement_ids, &docs_json))?;
    Ok(indexes.into_iter().map(|i| i as u32).collect())
}

#[napi]
pub fn design_pipeline_review_independence(implementer: String, reviewer: String) -> String {
    design_pipeline::review_independence(&implementer, &reviewer).to_owned()
}

/// `{designApproved, completed, succeeded, reasons}` JSON
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn design_pipeline_derive_result(
    design_status: String,
    checkpoint_exists: bool,
    has_review: bool,
    review_ran: bool,
    review_passed: bool,
    independence: String,
    has_verification: bool,
    verification_ran: bool,
    verification_ok: bool,
    tests_rerun: bool,
) -> String {
    let review = design_pipeline::ReviewInput { ran: review_ran, passed: review_passed, independence: &independence };
    let verification = design_pipeline::VerificationInput { ran: verification_ran, ok: verification_ok, tests_rerun };
    let result = design_pipeline::derive_design_pipeline_result(
        &design_status,
        checkpoint_exists,
        has_review.then_some(&review),
        has_verification.then_some(&verification),
    );
    let value = js_json::object(vec![
        ("designApproved", Some(JsValue::Bool(result.design_approved))),
        ("completed", Some(JsValue::Bool(result.completed))),
        ("succeeded", Some(JsValue::Bool(result.succeeded))),
        ("reasons", Some(JsValue::Arr(result.reasons.iter().map(JsValue::str).collect()))),
    ]);
    js_json::to_native(&value)
}

// ── 탐색 QA의 판정·변환·프롬프트(ADR-191 3p). 구조가 있는 입력은 encodeNative한 JSON 문자열. TS 껍데기: packages/agent/src/explore-qa.ts
use bstudio_guard::explore_qa;

#[napi]
pub fn explore_qa_diagnostics_count(console_errors: f64, page_errors: f64, failed_requests: f64, accessibility_violations: f64, horizontal_overflow_px: f64) -> f64 {
    explore_qa::diagnostics_count(console_errors, page_errors, failed_requests, accessibility_violations, horizontal_overflow_px)
}

#[napi]
pub fn explore_qa_match_score(name: String, text: String, role: String, test_id: Option<String>, tag: String, needle: String) -> f64 {
    explore_qa::match_score(&name, &text, &role, test_id.as_deref(), &tag, &needle)
}

#[napi]
pub fn explore_qa_describe_scroll_position(y: f64, max: f64, at_bottom: bool, at_top: bool) -> String {
    explore_qa::describe_scroll_position(y, max, at_bottom, at_top)
}

/// result: `{ url, title, elements: [{ ref, role, name, testId? }], truncated }`. 모양이 어긋나면 던진다
#[napi]
pub fn explore_qa_format_snapshot(result_json: String, max_elements: f64) -> Result<String> {
    fail(explore_qa::format_snapshot(&input(&result_json, "스냅샷")?, max_elements))
}

#[napi]
pub fn explore_qa_normalize_ref(value: String) -> Option<String> {
    explore_qa::normalize_ref(&value)
}

#[napi]
pub fn explore_qa_is_inspection_goal(goal_text: String) -> bool {
    explore_qa::is_inspection_goal(&goal_text)
}

#[napi]
pub fn explore_qa_build_system_prompt(goal_text: Option<String>) -> String {
    explore_qa::build_qa_system_prompt(goal_text.as_deref())
}

/// goal: `{ goal, startPath, confirmText? }`
#[napi]
pub fn explore_qa_build_user_prompt(goal_json: String) -> Result<String> {
    Ok(explore_qa::build_qa_user_prompt(&input(&goal_json, "탐색 목표")?))
}

#[napi]
pub fn explore_qa_build_wrap_up_prompt(reason: String) -> String {
    explore_qa::build_wrap_up_prompt(&reason)
}

/// 입력은 `explore_qa::judge` 문서의 모양. `{status, reason}` JSON. review.findings가 배열이 아니면 던진다
#[napi]
pub fn explore_qa_judge(input_json: String, page_text: String) -> Result<String> {
    let (status, reason) = fail(explore_qa::judge(&input(&input_json, "판정 입력")?, &page_text))?;
    Ok(format!(r#"{{"status":{},"reason":{}}}"#, js::json_quote(&status), js::json_quote(&reason)))
}

/// actions: `[{ index, tool, ok, stableSelector?, text?, key?, forText? }]`. `{steps, skipped}` JSON(encodeNative 형식). 배열이 아니면 던진다
#[napi]
pub fn explore_qa_to_page_check_steps(actions_json: String) -> Result<String> {
    let steps = fail(explore_qa::to_page_check_steps(&input(&actions_json, "행동 기록")?))?;
    Ok(js_json::to_native(&steps))
}

/// element: `{ ref, role, name, testId? }`
#[napi]
pub fn explore_qa_format_element(element_json: String) -> Result<String> {
    Ok(explore_qa::format_element(&input(&element_json, "요소")?))
}

// ── 저장소 연동(3단계 3n). 짝 없는 서로게이트는 U+FFFD로 읽는다. TS 껍데기: packages/agent/src/repository.ts
use bstudio_guard::repository as repo;

#[napi]
pub fn repo_remote_needs_url(trimmed: String) -> bool {
    repo::remote_needs_url(&trimmed)
}

/// `{kind, display, host?, path?, webUrl?}` JSON. 스킴 꼴이면 `new URL`의 조각(`protocol`·`host`·`hostname`·디코드한 `pathname`)을 모두 준다
#[napi]
pub fn repo_parse_remote(url: String, protocol: Option<String>, host: Option<String>, hostname: Option<String>, pathname: Option<String>, provider: Option<String>) -> String {
    let parsed = protocol.as_deref().map(|protocol| repo::ParsedUrl {
        protocol,
        host: host.as_deref().unwrap_or(""),
        hostname: hostname.as_deref().unwrap_or(""),
        pathname: pathname.as_deref().unwrap_or(""),
    });
    out(&repo::parse_remote(&url, parsed.as_ref(), provider.as_deref()).to_value())
}

#[napi]
pub fn repo_compare_url(kind: String, web_url: Option<String>, base: String, branch: String) -> Option<String> {
    repo::compare_url(&kind, web_url.as_deref(), &base, &branch)
}

#[napi]
pub fn repo_can_create_pull_request(kind: String, token: Option<String>, env_token: Option<String>) -> bool {
    repo::can_create_pull_request(&kind, token.as_deref(), env_token.as_deref())
}

#[napi]
pub fn repo_parse_pull_request_number(url: String) -> Option<f64> {
    repo::parse_pull_request_number(&url)
}

/// `{total, checked, items:[{checked, text}]}` JSON
#[napi]
pub fn repo_parse_task_list(body: Option<String>) -> String {
    out(&repo::parse_task_list(body.as_deref()))
}

#[napi]
pub fn repo_parse_closing_references(text: Option<String>) -> Vec<f64> {
    repo::parse_closing_references(text.as_deref())
}

#[napi]
pub fn repo_map_review_state(raw: String) -> String {
    repo::map_review_state(&raw).to_owned()
}

/// `{patch?, truncated}` JSON
#[napi]
pub fn repo_cap_patch(patch: Option<String>, running_total: f64) -> String {
    out(&repo::cap_patch(patch.as_deref(), running_total))
}

#[napi]
pub fn repo_combine_check_status(completed: Vec<bool>, conclusions: Vec<Option<String>>) -> String {
    let conclusions: Vec<Option<&str>> = conclusions.iter().map(Option::as_deref).collect();
    repo::combine_check_status(&completed, &conclusions).to_owned()
}

#[napi]
pub fn repo_merge_managed_pull_request_body(existing_body: Option<String>, managed_body: String) -> String {
    repo::merge_managed_pull_request_body(existing_body.as_deref(), &managed_body)
}

#[napi]
pub fn repo_managed_body_squeezed_out(body: String, managed_body: String) -> bool {
    repo::managed_body_squeezed_out(&body, &managed_body)
}

#[napi]
pub fn repo_cap_body(body: String) -> String {
    repo::cap_body(&body)
}

/// `{title, body, missing}` JSON. 모양이 어긋난 입력은 던진다
#[napi]
pub fn repo_build_pull_request(input_json: String) -> Result<String> {
    Ok(out(&fail(repo::build_pull_request(&input_json))?))
}

// ── 경로 이름·도구 정책(ADR-191 3q). 막는 검사다. TS 껍데기: packages/agent/src/{path-names,policy}.ts
use bstudio_guard::path_policy;

/// 꼴을 맞출 수 없으면(프로젝트 밖, 절대 경로, NUL, POSIX 역슬래시) null. `backslash_sep`은 `path.sep === '\\'`
#[napi]
pub fn normalize_project_path(file: String, lenient: bool, backslash_sep: bool) -> Option<String> {
    path_policy::normalize_project_path(&file, lenient, backslash_sep)
}

#[napi]
pub fn fold_name(segment: String) -> String {
    path_policy::fold_name(&segment)
}

#[napi]
pub fn canonical_project_path(file: String, lenient: bool, backslash_sep: bool) -> Option<String> {
    path_policy::canonical_project_path(&file, lenient, backslash_sep)
}

#[napi]
pub fn is_protected_path(file: String, candidate: String, backslash_sep: bool) -> bool {
    path_policy::is_protected_path(&file, &candidate, backslash_sep)
}

#[napi]
pub fn is_within_scope(file: String, scope: String, backslash_sep: bool) -> bool {
    path_policy::is_within_scope(&file, &scope, backslash_sep)
}

#[napi]
pub fn is_tool_allowed(tool: String, allowed_tools: Vec<String>) -> bool {
    path_policy::is_tool_allowed(&tool, &allowed_tools)
}

#[napi]
pub fn has_approval_token(token: Option<String>) -> bool {
    path_policy::has_approval_token(token.as_deref())
}

/// `{"decision":"allow"|"deny","reason"?}` JSON. policy_json은 `{allowedTools?, deniedCommands?, requireApprovalFor?, protectedPaths?, writablePaths?}` 또는 `null`.
/// 모양이 어긋난 정책은 던진다(부르는 쪽이 요청을 거부로 처리한다)
#[napi]
pub fn check_tool_policy(
    tool: String,
    file: String,
    scope_file: String,
    command: Vec<String>,
    policy_json: String,
    approval_token: Option<String>,
    default_denied: Vec<String>,
    backslash_sep: bool,
) -> Result<String> {
    let policy: Option<path_policy::Policy> = serde_json::from_str(&policy_json).map_err(|e| Error::from_reason(format!("실행 정책의 모양이 어긋났습니다: {e}")))?;
    let decision = path_policy::check_tool_policy(&tool, &file, &scope_file, &command, policy.as_ref(), approval_token.as_deref(), &default_denied, backslash_sep);
    Ok(match decision.reason {
        Some(reason) => format!(r#"{{"decision":"deny","reason":{}}}"#, js::json_quote(&reason)),
        None => r#"{"decision":"allow"}"#.to_owned(),
    })
}

// ── 체크포인트의 git 출력 판정(ADR-191 3단계 3s). 형 변환만 한다. 문자열 목록·JSON 문자열로 주고받는다.
// TS 껍데기: packages/agent/src/checkpoints.ts

use bstudio_guard::checkpoint_git as cg;

#[napi]
pub fn checkpoint_split_nul(output: String) -> Vec<String> {
    cg::split_nul(&output)
}

/// 형식을 읽지 못하면 null(부르는 쪽이 던진다)
#[napi]
pub fn checkpoint_dangerous_local_config(output: String, separate_git_dir: bool) -> Option<Vec<String>> {
    cg::dangerous_local_config(&output, separate_git_dir)
}

#[napi]
pub fn checkpoint_info_attributes(text: String) -> Vec<String> {
    cg::info_attributes(&text)
}

/// 기대 쪽 글자(`expectedKeys`·`expectedValues`)는 TS가 `encodeLoneSurrogates`한 것. 결과의 경로도 그 인코딩이다
#[napi]
pub fn checkpoint_staged_mismatch(ls_files: String, staged_names: String, subdir: String, expected_keys: Vec<String>, expected_values: Vec<String>) -> Vec<String> {
    cg::staged_mismatch(&ls_files, &staged_names, &subdir, &expected_keys, &expected_values)
}

#[napi]
pub fn checkpoint_pending_files(output: String, subdir: String) -> Vec<String> {
    cg::pending_files(&output, &subdir)
}

/// [경로, 종류] 쌍
#[napi]
pub fn checkpoint_pending_changes(output: String, subdir: String) -> Vec<Vec<String>> {
    cg::pending_changes(&output, &subdir).into_iter().map(|(file, change)| vec![file, change.to_owned()]).collect()
}

/// [추가, 삭제]
#[napi]
pub fn checkpoint_commit_stat(output: String) -> Vec<f64> {
    let (insertions, deletions) = cg::commit_stat(&output);
    vec![insertions, deletions]
}

/// [sha, shortSha, subject, author] 목록
#[napi]
pub fn checkpoint_remote_commits(output: String) -> Vec<Vec<String>> {
    cg::remote_commits(&output).into_iter().map(Vec::from).collect()
}

/// `ourEmail`은 TS가 `encodeLoneSurrogates`한 글자
#[napi]
pub fn checkpoint_author_is_ours(git_email: String, our_email: String) -> bool {
    cg::author_is_ours(&git_email, &our_email)
}

/// `[{sha, shortSha, subject, body, ours, trailers, verifyTrailers, incompleteTrailers}]` JSON
#[napi]
pub fn checkpoint_session_records(output: String, our_email: String) -> String {
    out(&cg::session_records(&output, &our_email))
}

/// `{sha, shortSha, subject, createdAt, ours, trailers, verifyTrailers, incompleteTrailers}` JSON
#[napi]
pub fn checkpoint_show_record(output: String, our_email: String) -> String {
    out(&cg::show_record(&output, &our_email))
}

#[napi]
pub fn checkpoint_commit_message(subject: String, body: Option<String>, trailers: Vec<String>) -> String {
    cg::commit_message(&subject, body.as_deref(), &trailers)
}

#[napi]
pub fn checkpoint_strip_space(text: String) -> String {
    cg::strip_space(&text)
}

#[napi]
pub fn checkpoint_one_line(message: String) -> String {
    cg::one_line(&message)
}

#[napi]
pub fn checkpoint_cap_text(text: String, max: u32) -> String {
    cg::cap_text(&text, max as usize)
}

#[napi]
pub fn checkpoint_subcommand(args: Vec<String>) -> Option<String> {
    cg::subcommand(&args)
}

#[napi]
pub fn checkpoint_redact_credentials(text: String) -> String {
    cg::redact_credentials(&text)
}

#[napi]
pub fn checkpoint_is_index_lock_failure(stderr: String) -> bool {
    cg::is_index_lock_failure(&stderr)
}

#[napi]
pub fn checkpoint_with_object_particle(word: String) -> String {
    cg::with_object_particle(&word)
}

#[napi]
pub fn checkpoint_is_dot_git(name: String) -> bool {
    cg::is_dot_git(&name)
}

#[napi]
pub fn checkpoint_is_sha(text: String) -> bool {
    cg::is_sha(&text)
}

#[napi]
pub fn checkpoint_is_backup_id(text: String) -> bool {
    cg::is_backup_id(&text)
}

/// `{base, missingBase?}` JSON
#[napi]
pub fn checkpoint_pull_request_target(listed: String, base_ref: String, info_base: String) -> String {
    out(&cg::pull_request_target(&listed, &base_ref, &info_base))
}

/// 환경 변수 이름과 같은 자리의 남길지(true)·뺄지(false)
#[napi]
pub fn checkpoint_git_env_keep(keys: Vec<String>) -> Vec<bool> {
    cg::git_env_keep(&keys)
}

// ── agent: 연결·인증·조율 판정(3단계 3t). 호스트·토큰·출처를 견주는 입력은 TS가 encodeLoneSurrogates한 글자를 보낸다.
// 구조가 있는 입력은 encodeNative한 JSON 문자열이다
use bstudio_guard::connection_judge;

#[napi]
pub fn conn_authorize(host: Option<String>, authorization: Option<String>, token: String, allowed_hosts: Vec<String>) -> Option<String> {
    connection_judge::authorize(host.as_deref(), authorization.as_deref(), &token, &allowed_hosts).map(|denied| out(&connection_judge::denial_value(denied)))
}

#[napi]
pub fn conn_host_allowed(host: Option<String>, allowed_hosts: Vec<String>) -> bool {
    connection_judge::host_allowed(host.as_deref(), &allowed_hosts)
}

#[napi]
pub fn conn_hostname_of(host: Option<String>) -> String {
    connection_judge::hostname_of(host.as_deref())
}

#[napi]
pub fn conn_token_matches(authorization: Option<String>, token: String) -> bool {
    connection_judge::token_matches(authorization.as_deref(), &token)
}

#[napi]
pub fn conn_is_allowed_request(protocol: String, origin: String, allowed_origins: Vec<String>) -> bool {
    connection_judge::is_allowed_request(&protocol, &origin, &allowed_origins)
}

#[napi]
pub fn conn_is_automatic_favicon_path(pathname: String) -> bool {
    connection_judge::is_automatic_favicon_path(&pathname)
}

#[napi]
pub fn conn_describe_step(click: Option<String>, fill_selector: Option<String>, press: Option<String>, wait_for: Option<String>) -> String {
    connection_judge::describe_step(click.as_deref(), fill_selector.as_deref(), press.as_deref(), wait_for.as_deref())
}

#[napi]
pub fn conn_rejected_change_feedback(rejected: Vec<String>) -> String {
    connection_judge::rejected_change_feedback(&rejected)
}

#[napi]
pub fn coord_board_validate(model_writes: bool, by: String, kind: String, body: String, refs_len: f64, note_bytes_limit: f64) -> Option<String> {
    coordination::board_validate(model_writes, &by, &kind, &body, refs_len as usize, note_bytes_limit)
}

/// 입력 `[{priority, at, id, bytes}]`(읽을 수 있는 메모, 들어온 순서). 결과 `{selected: [위치], truncated, bytes}` JSON. 모양이 어긋난 입력은 던진다
#[napi]
pub fn coord_board_pick_notes(notes_json: String, read_limit: f64, budget: f64) -> Result<String> {
    let value = input(&notes_json, "읽을 메모 목록")?;
    let JsValue::Arr(items) = &value else { return Err(Error::from_reason("읽을 메모 목록이 배열이 아닙니다")) };
    let mut keys = Vec::with_capacity(items.len());
    for item in items {
        let number = |key: &str| match item.prop(key) {
            Some(JsValue::Num(n)) => Ok(*n),
            _ => Err(Error::from_reason(format!("메모의 {key}이(가) 수가 아닙니다"))),
        };
        let text = |key: &str| match item.prop(key) {
            Some(JsValue::Str(s)) => Ok(s.clone()),
            _ => Err(Error::from_reason(format!("메모의 {key}이(가) 문자열이 아닙니다"))),
        };
        keys.push(coordination::NoteSortKey { priority: number("priority")?, at: text("at")?, id: text("id")?, bytes: number("bytes")? });
    }
    let (selected, truncated, bytes) = coordination::board_pick_notes(&keys, read_limit, budget);
    let selected = JsValue::Arr(selected.into_iter().map(|i| JsValue::Num(i as f64)).collect());
    Ok(out(&bstudio_guard::js_json::object(vec![("selected", Some(selected)), ("truncated", Some(JsValue::Bool(truncated))), ("bytes", Some(JsValue::Num(bytes)))])))
}

#[napi]
pub fn coord_mcp_post_input_error(args_json: String) -> Result<Option<String>> {
    Ok(coordination::mcp_post_input_error(&input(&args_json, "post_note 입력")?))
}

#[napi]
pub fn coord_mcp_read_input_error(args_json: String) -> Result<Option<String>> {
    Ok(coordination::mcp_read_input_error(&input(&args_json, "read_notes 입력")?))
}

#[napi]
pub fn coord_format_note(kind: String, priority: f64, lane: String, body: String, refs: Vec<String>) -> String {
    coordination::format_note(&kind, priority, &lane, &body, &refs)
}

// ── 검증 통과 판정·도구 입력 검사(ADR-191 3단계 3u). 막는 검사이고 일부는 여는 쪽(서비스 허용 목록·origin)이다. TS 껍데기: packages/agent/src/{verify,tools}.ts
use bstudio_guard::{tool_input, verify_judge};

#[napi]
pub fn verify_ok(restarted_ready: Vec<bool>, contract_errored: Vec<bool>, change_breaking: Vec<bool>, allow_breaking: bool, secret_leaks: u32, spec_error: bool) -> bool {
    verify_judge::verify_ok(&restarted_ready, &contract_errored, &change_breaking, allow_breaking, secret_leaks as usize, spec_error)
}

#[napi]
pub fn verify_platform_failure(sync_error: Option<String>, sync_platform: bool, services: Vec<String>, ready: Vec<bool>, platform: Vec<bool>, errors: Vec<String>) -> Option<String> {
    verify_judge::platform_failure_of(sync_error.as_deref(), sync_platform, &services, &ready, &platform, &errors)
}

#[napi]
pub fn verify_mentions_deleted_file(log_tail: Vec<String>, deleted: Vec<String>) -> bool {
    verify_judge::mentions_deleted_file(&log_tail, &deleted)
}

/// 읽을 수 없는 보고서도 던지지 않고 "검증 실패"로 시작하는 글을 돌려준다
#[napi]
pub fn verify_format_report(report_json: String, allow_breaking: bool, spec_file: String) -> String {
    verify_judge::format_verification_report(&report_json, allow_breaking, &spec_file)
}

/// 맞으면 null, 아니면 던질 오류 글. value_json은 encodeNative한 값(없으면 undefined)
#[napi]
pub fn tool_input_error(kind: String, key: String, value_json: Option<String>) -> Option<String> {
    tool_input::input_error(&kind, &key, value_json.as_deref())
}

#[napi]
pub fn tool_clamp(value: f64, min: f64, max: f64) -> f64 {
    tool_input::clamp(value, min, max)
}

#[napi]
pub fn tool_compose_service_names(compose: Option<Vec<String>>, managed: Vec<String>) -> Vec<String> {
    tool_input::compose_service_names(compose.as_deref(), &managed)
}

#[napi]
pub fn tool_service_allowed(name: String, managed: Vec<String>) -> bool {
    tool_input::service_allowed(&name, &managed)
}

#[napi]
pub fn tool_service_or_addon_allowed(name: String, compose: Option<Vec<String>>, managed: Vec<String>) -> bool {
    tool_input::service_or_addon_allowed(&name, compose.as_deref(), &managed)
}

#[napi]
pub fn tool_summarize_approval(name: String, input_json: Option<String>) -> String {
    tool_input::summarize_approval(&name, input_json.as_deref())
}

#[napi]
pub fn tool_mismatch_addable(max: u32, seen_requests: Vec<String>, seen_checks: Vec<String>, seen_followed: Vec<String>, request: String, check: String, followed: String) -> bool {
    tool_input::mismatch_addable(max as usize, &seen_requests, &seen_checks, &seen_followed, &request, &check, &followed)
}

#[napi]
pub fn tool_http_path_ok(path: String) -> bool {
    tool_input::http_path_ok(&path)
}

#[napi]
pub fn tool_same_origin(request_origin: String, service_origin: String) -> bool {
    tool_input::same_origin(&request_origin, &service_origin)
}

use bstudio_guard::gate_helpers as gh;

/// 오류 표지 글자. 없으면 null
#[napi]
pub fn gate_next_error_marker(text: String, expect_status: f64) -> Option<String> {
    gh::next_error_marker(&text, expect_status).map(str::to_owned)
}

/// `{service, mode, expectStatus, viewport?}` JSON → pageChecks 모양 JSON
#[napi]
pub fn gate_auto_page_check(config_json: String, route_path: String) -> Result<String> {
    Ok(out(&gh::auto_page_check(&input(&config_json, "자동 페이지 설정")?, &route_path)))
}

#[napi]
pub fn gate_contains_api_text(text: String, value: String) -> bool {
    gh::contains_api_text(&text, &value)
}

#[napi]
pub fn gate_contains_api_number(text: String, value: f64) -> bool {
    gh::contains_api_number(&text, value)
}

#[napi]
pub fn gate_missing_api_value(service: String, json_path: String, value_text: Option<String>, value_number: Option<f64>, page_path: String) -> String {
    gh::missing_api_value(&service, &json_path, value_text.as_deref(), value_number, &page_path)
}

/// finding: `{text, visible, problem?}`. 알 수 없는 문제 종류는 던진다
#[napi]
pub fn gate_viewport_problem_text(finding_json: String, width: f64, height: f64) -> Result<String> {
    fail(gh::viewport_problem_text_for(&input(&finding_json, "화면 글자 결과")?, width, height))
}

/// `{expected:[{key,text}], report: null | {width,height,findings:[{key,text,visible,problem?}]}}` JSON → 문제 문구 목록
#[napi]
pub fn gate_viewport_problems(input_json: String) -> Result<Vec<String>> {
    fail(gh::viewport_problems(&input(&input_json, "첫 화면 글자 판정 입력")?))
}

#[napi]
pub fn gate_missing_all_text(values: Vec<String>) -> String {
    gh::missing_all_text(&values)
}

#[napi]
pub fn gate_missing_any_text(values: Vec<String>) -> String {
    gh::missing_any_text(&values)
}

#[napi]
pub fn gate_dynamic_probe_data_hint(probed_id: String) -> String {
    gh::dynamic_probe_data_hint(&probed_id)
}

/// 동적 세그먼트인 `split('/')` 조각의 번호
#[napi]
pub fn gate_dynamic_segments(page_file: String) -> Vec<f64> {
    gh::dynamic_segments(&page_file).into_iter().map(|i| i as f64).collect()
}

/// sampleParams는 `[[키, 값], …]`
#[napi]
pub fn gate_accepted_notes(spec_file: String, in_run_keys: Vec<String>, sample_params: Vec<Vec<String>>, in_run_sample_id_from: bool, from_service: Option<String>, from_path: Option<String>) -> Vec<String> {
    let params = sample_pairs(sample_params);
    let from = from_service.as_deref().zip(from_path.as_deref());
    gh::accepted_notes(&spec_file, &in_run_keys, &params, in_run_sample_id_from, from)
}

#[napi]
pub fn gate_uses_in_run_value(page_file: String, in_run_keys: Vec<String>, in_run_sample_id_from: bool, used_fallback_count: f64) -> bool {
    gh::uses_in_run_value(&page_file, &in_run_keys, in_run_sample_id_from, used_fallback_count as usize)
}

#[napi]
pub fn gate_sampled_values(page_file: String, sample_params: Vec<Vec<String>>) -> Option<String> {
    gh::sampled_values(&page_file, &sample_pairs(sample_params))
}

fn sample_pairs(entries: Vec<Vec<String>>) -> Vec<(String, String)> {
    entries.into_iter().filter_map(|mut entry| if entry.len() == 2 { let v = entry.pop()?; Some((entry.pop()?, v)) } else { None }).collect()
}

#[napi]
pub fn gate_strip_html(html: String) -> String {
    gh::strip_html(&html)
}

/// `[{stage, name, attempts, detail?}]` JSON
#[napi]
pub fn gate_format_failed_checks(checks_json: String) -> Result<String> {
    fail(gh::format_failed_checks(&input(&checks_json, "실패한 검사 목록")?))
}

#[napi]
pub fn gate_compare_detail(ratio: f64, max: f64, width: f64, height: f64) -> String {
    gh::compare_detail(ratio, max, width, height)
}

/// `{successCount?: {exactly?, atMost?}, allStatusIn?: number[]}` JSON
#[napi]
pub fn gate_describe_concurrency_expect(expect_json: String) -> Result<String> {
    fail(gh::describe_concurrency_expect(&input(&expect_json, "동시 요청 기대")?))
}

// ── agent: 작업 공간의 막는 검사(3단계 3w). TS 껍데기: packages/agent/src/workspace.ts
use bstudio_guard::workspace_guard as wg;

/// 숨긴 이름(생성물 폴더·`.env` 계열)인가. 거부 목록이라 짝 없는 서로게이트가 U+FFFD로 합쳐져도 더 막을 뿐이다
#[napi]
pub fn workspace_is_denied(segment: String) -> bool {
    wg::is_denied(&segment)
}

#[napi]
pub fn workspace_is_secret_file(file: String) -> bool {
    wg::is_secret_file(&file)
}

/// `path.relative(root, target)`의 결과가 안쪽인가. 허용 목록이라 TS가 `encodeLoneSurrogates`한 글자를 보낸다
#[napi]
pub fn workspace_is_inside(relative: String, backslash_sep: bool) -> bool {
    wg::is_inside_relative(&relative, backslash_sep)
}

/// 0 없음, 1 절대 경로, 2 쓸 수 없는 글자
#[napi]
pub fn workspace_input_problem(file: String, backslash_sep: bool, external: bool) -> u32 {
    u32::from(wg::input_problem(&file, backslash_sep, external))
}

// ── agent: 워크플로 판정(3단계 3v). 트레일러 만들기·읽기, 단계, 배포 막음, 검토, 확인 요약. 형 변환만 한다.
// TS 껍데기: packages/agent/src/workflow.ts, packages/agent/src/checkpoints.ts

use bstudio_guard::workflow as wf;

#[napi]
pub fn workflow_format_passed_trailer(stages: Vec<String>) -> String {
    wf::format_workflow_trailer(&stages)
}

#[napi]
pub fn workflow_format_verify_trailer(mode: String) -> String {
    wf::format_verify_trailer(&mode)
}

#[napi]
pub fn workflow_format_incomplete_trailer(reason: String) -> String {
    wf::format_incomplete_trailer(&reason)
}

#[napi]
pub fn workflow_parse_passed_trailer(values: Vec<String>) -> Option<Vec<String>> {
    wf::parse_workflow_trailer_values(&values)
}

#[napi]
pub fn workflow_parse_verify_trailer(values: Vec<String>) -> Option<String> {
    wf::parse_verify_trailer_values(&values).map(str::to_owned)
}

#[napi]
pub fn workflow_parse_incomplete_trailer(values: Vec<String>) -> Option<String> {
    wf::parse_incomplete_trailer_values(&values).map(str::to_owned)
}

#[napi]
pub fn workflow_is_doc_checkpoint_path(file: String) -> bool {
    wf::is_doc_checkpoint_path(&file)
}

#[napi]
pub fn workflow_has_empty_passed_trailer(trailers: Vec<String>) -> bool {
    wf::has_empty_passed_trailer(&trailers)
}

#[napi]
pub fn workflow_has_docs_verify_trailer(trailers: Vec<String>) -> bool {
    wf::has_docs_verify_trailer(&trailers)
}

#[napi]
pub fn workflow_stages(required: Option<Vec<String>>, page_checks: u32, tests: u32, concurrency_checks: u32, load_checks: u32) -> Vec<String> {
    wf::workflow_stages(required.as_deref(), page_checks as usize, tests as usize, concurrency_checks as usize, load_checks as usize)
}

#[napi]
pub fn workflow_release_requirements(release_requires: Option<Vec<String>>) -> Vec<String> {
    wf::workflow_release_requirements(release_requires.as_deref())
}

/// 요구 목록에서 빠진 단계의 위치. `-1`은 `checkpoint`(게이트를 거치지 않은 직접 수정 체크포인트). 입력은 `encodeLoneSurrogates`한 꼴
#[napi]
pub fn workflow_release_blockers(requires: Option<Vec<String>>, declared: bool, passed: Option<Vec<String>>, verify: Option<String>) -> Vec<i32> {
    match wf::release_blockers(requires.as_deref(), declared, passed.as_deref(), verify.as_deref()) {
        wf::Blockers::Checkpoint => vec![-1],
        wf::Blockers::Missing(indices) => indices.into_iter().map(|index| index as i32).collect(),
    }
}

#[napi]
pub fn workflow_missing_verification_stages(stages: Vec<String>, passed: Vec<String>) -> Vec<u32> {
    wf::missing_verification_stages(&stages, &passed).into_iter().map(|index| index as u32).collect()
}

#[napi]
pub fn workflow_protected_paths(protected: Option<Vec<String>>, evaluation_assets: Option<Vec<String>>) -> Vec<String> {
    wf::protected_paths_for(protected.as_deref().unwrap_or(&[]), evaluation_assets.as_deref().unwrap_or(&[]))
}

#[napi]
pub fn workflow_max_turns(json: String) -> Result<String> {
    fail(wf::max_turns_json(&json))
}

#[napi]
pub fn workflow_review_changes(json: String) -> Result<String> {
    fail(wf::review_changes_json(&json))
}

#[napi]
pub fn workflow_uncovered_change_warnings(json: String) -> Result<String> {
    fail(wf::uncovered_change_warnings_json(&json))
}

#[napi]
pub fn workflow_format_checked_coverage(json: String, declared_check_name: String) -> Result<String> {
    fail(wf::format_checked_coverage_json(&json, &declared_check_name))
}

// ── 작업 계획·요구사항 검증 기록 무결성(ADR-191 3단계 3x). 막는 판정이다. TS 껍데기: packages/agent/src/{task-plan,requirement-integrity}.ts
// 글자는 TS가 `encodeLoneSurrogates`해서 보내고 결과의 글자는 TS가 `decodeLoneSurrogates`로 푼다. 어긋난 모양의 입력은 던진다
use bstudio_guard::{requirement_integrity as rint, task_plan as tp};

/// `{maxLanes, maxTasks, warnings}` JSON. 값이 없으면 null
#[napi]
pub fn task_plan_limits(max_lanes: Option<String>, max_tasks: Option<String>) -> String {
    let (lanes, tasks, warnings) = tp::plan_limits(max_lanes.as_deref(), max_tasks.as_deref());
    serde_json::json!({ "maxLanes": lanes, "maxTasks": tasks, "warnings": warnings }).to_string()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanTaskInput {
    id: String,
    #[serde(default)]
    depends_on: Vec<String>,
    backend: Option<String>,
    model: Option<String>,
    paths: Vec<String>,
}

/// `tasks_json`은 `[{id, dependsOn, backend?, model?, paths}]`(글자는 인코딩한 것). `{error}` 또는 `{lanes: [{id, tasks: [순번], paths}]}` JSON
#[napi]
pub fn task_plan_lanes(tasks_json: String, max_tasks: f64, max_lanes: f64, backslash_sep: bool) -> Result<String> {
    let inputs: Vec<PlanTaskInput> = parse::<Vec<PlanTaskInput>>(&tasks_json, "작업 계획")?;
    let tasks: Vec<tp::PlanTask> = inputs.into_iter().map(|t| tp::PlanTask { id: t.id, depends_on: t.depends_on, backend: t.backend, model: t.model, paths: t.paths }).collect();
    Ok(match tp::plan_lanes(&tasks, max_tasks, max_lanes, backslash_sep) {
        Err(message) => serde_json::json!({ "error": message }),
        Ok(lanes) => serde_json::json!({ "lanes": lanes.into_iter().map(|l| serde_json::json!({ "id": l.id, "tasks": l.tasks, "paths": l.paths })).collect::<Vec<_>>() }),
    }
    .to_string())
}

/// `file`·`paths`는 TS가 `encodeLoneSurrogates`한 글자
#[napi]
pub fn task_plan_is_in_scope(file: String, paths: Vec<String>, backslash_sep: bool) -> bool {
    tp::is_in_scope(&file, &paths, backslash_sep)
}

fn diff_json(diff: &rint::Diff) -> String {
    serde_json::to_string(diff).expect("직렬화")
}

/// `{forged, removed, tampered}` JSON. `*Effective`·`afterIds`는 TS가 `parseRequirementsMarkdown`으로 읽은 id 목록(인코딩한 글자)
#[napi]
pub fn req_integrity_diff(before: Option<String>, after: Option<String>, before_effective: Vec<String>, after_effective: Vec<String>, after_ids: Vec<String>) -> String {
    diff_json(&rint::diff_verification_records(before.as_deref(), after.as_deref(), &before_effective, &after_effective, &after_ids))
}

#[napi]
pub fn req_integrity_has_tamper(diff_json: String) -> Result<bool> {
    Ok(rint::has_verification_tamper(&parse::<rint::Diff>(&diff_json, "검증 기록 변화")?))
}

#[napi]
pub fn req_integrity_describe_tamper(diff_json: String) -> Result<Vec<String>> {
    Ok(rint::describe_verification_tamper(&parse::<rint::Diff>(&diff_json, "검증 기록 변화")?))
}

#[napi]
pub fn req_integrity_describe_removed(diff_json: String) -> Result<Vec<String>> {
    Ok(rint::describe_removed_verifications(&parse::<rint::Diff>(&diff_json, "검증 기록 변화")?))
}

#[napi]
pub fn req_integrity_tampered_ids(diff_json: String) -> Result<Vec<String>> {
    Ok(rint::tampered_requirement_ids(&parse::<rint::Diff>(&diff_json, "검증 기록 변화")?))
}

/// `{unchanged: true}` · `{needsIds: 글}`(그 글의 요구사항 id 목록을 `textIds`로 주고 다시 부른다) · `{text}` JSON
#[napi]
pub fn req_integrity_restore(before: Option<String>, after: String, before_effective: Vec<String>, after_effective: Vec<String>, after_ids: Vec<String>, text_ids: Option<Vec<String>>) -> String {
    match rint::restore_verification_records(before.as_deref(), &after, &before_effective, &after_effective, &after_ids, text_ids.as_deref()) {
        rint::Restore::Unchanged => serde_json::json!({ "unchanged": true }),
        rint::Restore::NeedsIds(text) => serde_json::json!({ "needsIds": text }),
        rint::Restore::Text(text) => serde_json::json!({ "text": text }),
    }
    .to_string()
}

/// `[{stage, name, ok, attempts, detail}]` JSON
#[napi]
pub fn req_integrity_review(before: Option<String>, after: Option<String>, before_effective: Vec<String>, after_effective: Vec<String>, after_ids: Vec<String>) -> String {
    serde_json::to_string(&rint::review_requirement_records(before.as_deref(), after.as_deref(), &before_effective, &after_effective, &after_ids)).expect("직렬화")
}

// ── agent: 요구사항 추적표와 시험 파일 훑기(3단계 3z). TS 껍데기: packages/agent/src/requirements.ts
use bstudio_guard::requirements_trace as rt;

/// 시험 파일 하나에서 뽑은 것(JSON). 시험 파일이 아니면 null. 이름·경로는 TS가 `encodeLoneSurrogates`해서 보낸다
#[napi]
pub fn req_trace_file_index(path: String, content: String) -> Result<Option<String>> {
    Ok(fail(rt::file_index(&path, &content))?.map(|index| out(&index.to_value())))
}

fn indexes_input(indexes_json: &str) -> Result<Vec<rt::IndexedFile>> {
    // `[index | null]`을 `[{ path, index }]`로 읽는다(경로는 결과에서 TS가 자리로 찾으므로 여기서는 쓰지 않는다)
    let parsed = input(indexes_json, "시험 파일 색인")?;
    let items = match &parsed {
        JsValue::Arr(items) => items,
        _ => return Err(Error::from_reason("시험 파일 색인은 배열이어야 합니다")),
    };
    items
        .iter()
        .map(|item| match item {
            JsValue::Null => Ok(rt::IndexedFile { path: String::new(), index: None }),
            other => fail(rt::FileIndex::from_value(other)).map(|index| rt::IndexedFile { path: String::new(), index: Some(index) }),
        })
        .collect()
}

/// `[[파일 자리, 이름]]`
#[napi]
pub fn req_trace_scan_requirement(indexes_json: String, id: String) -> Result<String> {
    Ok(out(&rt::found_value(&rt::scan_for_requirement_id(&indexes_input(&indexes_json)?, &id))))
}

#[napi]
pub fn req_trace_scan_scenario(indexes_json: String, scenario_id: String) -> Result<String> {
    Ok(out(&rt::found_value(&rt::scan_for_scenario_id(&indexes_input(&indexes_json)?, &scenario_id))))
}

#[napi]
pub fn req_trace_scan_orphans(indexes_json: String) -> Result<String> {
    Ok(out(&rt::found_value(&rt::scan_for_orphans(&indexes_input(&indexes_json)?))))
}

fn trace_array<'a>(params: &'a JsValue, key: &str) -> Result<&'a [JsValue]> {
    match params.prop(key) {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(Error::from_reason(format!("{key}은(는) 배열이어야 합니다"))),
    }
}

fn trace_run_rows(params: &JsValue) -> Result<&[JsValue]> {
    match params.prop("testRunRows") {
        None | Some(JsValue::Null) => Ok(&[]),
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(Error::from_reason("testRunRows는 배열이어야 합니다")),
    }
}

/// `{ scenarioId, checkpoints, testFiles: [{ path, index }], gateChecks, testRunRows, parentEvidence? }`
#[napi]
pub fn req_trace_scenario_evidence(params_json: String) -> Result<String> {
    let params = input(&params_json, "시나리오 증거 입력")?;
    let files = fail(rt::indexed_files(params.prop("testFiles")))?;
    let scenario_id = match params.prop("scenarioId") {
        Some(JsValue::Str(id)) => id.as_str(),
        _ => return Err(Error::from_reason("scenarioId는 문자열이어야 합니다")),
    };
    let evidence = fail(rt::build_scenario_evidence(scenario_id, trace_array(&params, "checkpoints")?, &files, trace_array(&params, "gateChecks")?, trace_run_rows(&params)?, params.prop("parentEvidence")))?;
    Ok(out(&evidence))
}

/// `{ requirement, checkpoints, testFiles: [{ path, index }], gateChecks, testRunRows, parentEvidence }` → 시나리오 id 목록
#[napi]
pub fn req_trace_unverified_scenario_ids(params_json: String) -> Result<String> {
    let params = input(&params_json, "시나리오 확인 입력")?;
    let files = fail(rt::indexed_files(params.prop("testFiles")))?;
    let requirement = params.prop("requirement").ok_or_else(|| Error::from_reason("requirement가 없습니다"))?;
    let parent = params.prop("parentEvidence").ok_or_else(|| Error::from_reason("parentEvidence가 없습니다"))?;
    let ids = fail(rt::find_unverified_scenario_ids(requirement, trace_array(&params, "checkpoints")?, &files, trace_array(&params, "gateChecks")?, trace_run_rows(&params)?, parent))?;
    Ok(out(&JsValue::Arr(ids)))
}

#[napi]
pub fn req_trace_matrix(input_json: String) -> Result<String> {
    Ok(out(&fail(rt::build_traceability_matrix(&input(&input_json, "추적표 입력")?))?))
}

use bstudio_guard::static_shadow as ss;

/// 고정 경로와 겹치는지(3단계 3aa)의 한 단계. `input_json`은 `{servicePath, pageFile, values, check, maxFolders}`, `known_json`은 지금까지 읽은
/// `{lstat: {경로: missing|error|link|dir|other}, readdir: {폴더: null | [[이름, l|d|f]]}}`(경로는 프로젝트 루트 기준 상대 경로).
/// `{need: {kind: "lstat"|"readdir", path}}`(읽고 다시 부른다) · `{shadows: [{name, where}]}` · `{unknown: 메시지}` JSON
#[napi]
pub fn static_shadow_step(input_json: String, known_json: String) -> Result<String> {
    let input = parse::<ss::Input>(&input_json, "고정 경로 확인 입력")?;
    let known = parse::<ss::Known>(&known_json, "읽은 폴더 목록")?;
    Ok(match ss::step(&input, &known) {
        ss::Step::Need(ss::Need::Lstat(path)) => serde_json::json!({ "need": { "kind": "lstat", "path": path } }),
        ss::Step::Need(ss::Need::Readdir(path)) => serde_json::json!({ "need": { "kind": "readdir", "path": path } }),
        ss::Step::Shadows(shadows) => serde_json::json!({ "shadows": shadows.into_iter().map(|s| serde_json::json!({ "name": s.name, "where": s.place })).collect::<Vec<_>>() }),
        ss::Step::Unknown(message) => serde_json::json!({ "unknown": message }),
    }
    .to_string())
}

// ── agent: 로컬 CLI 러너의 실행 파일 고르기·판정·사용량(ADR-191 3단계 3ac). TS 껍데기: packages/agent/src/claude-cli-process.ts, claude-code-runner.ts
use bstudio_guard::runner_judge as rj;
use bstudio_io::cli_command as cli_cmd;

/// 통과하면 `{ path }`(그 글자를 그대로 spawn에 쓴다), 못 찾으면 `{ reason }`. PATH·루트의 파일 상태는 여기서 읽는다(확인한 경로 = 띄울 경로)
#[napi]
pub fn cli_resolve_command(command: String, path_value: Option<String>, forbidden_root: Option<String>) -> String {
    let result = cli_cmd::resolve_cli_command(&command, path_value.as_deref(), forbidden_root.as_deref());
    out(&match result {
        Ok(path) => js_json::object(vec![("path", Some(JsValue::str(path)))]),
        Err(reason) => js_json::object(vec![("reason", Some(JsValue::str(reason)))]),
    })
}

#[napi]
pub fn cli_child_path(value: String, forbidden_root: Option<String>) -> String {
    cli_cmd::child_path(&value, forbidden_root.as_deref())
}

/// `{ window: number | null, ignored?: string }`
#[napi]
pub fn runner_resolve_compact_window(raw: Option<String>) -> String {
    let setting = rj::resolve_compact_window(raw.as_deref());
    out(&js_json::object(vec![
        ("window", Some(setting.window.map_or(JsValue::Null, |window| JsValue::Num(window as f64)))),
        ("ignored", setting.ignored.map(JsValue::str)),
    ]))
}

#[napi]
pub fn runner_is_transient_network_failure(message: String) -> bool {
    rj::is_transient_network_failure(&message)
}

/// 입력은 result 메시지의 `{ subtype, is_error, result, stop_reason, errors }`(encodeNative한 JSON). 실패가 아니면 null
#[napi]
pub fn runner_describe_result_failure(message_json: String) -> Result<Option<String>> {
    Ok(rj::describe_result_failure(&input(&message_json, "결과 메시지")?))
}

/// 입력은 init 메시지의 `{ mcp_servers, mcp_server_errors }`(encodeNative한 JSON). 연결됐으면 null
#[napi]
pub fn runner_mcp_setup_failure(message_json: String, server: String) -> Result<Option<String>> {
    Ok(rj::mcp_setup_failure(&input(&message_json, "init 메시지")?, &server))
}

#[napi]
pub fn runner_no_result_message(has_exit: bool, error_message: Option<String>, signal: Option<String>, code: Option<f64>, stderr: String) -> String {
    rj::no_result_message(has_exit, error_message.as_deref(), signal.as_deref(), code, &stderr)
}

/// 입력은 result의 `modelUsage`(encodeNative한 JSON, 없으면 `null`). 결과 `{ total: AgentUsage, byModel: Record<string, AgentUsage> }`. null 항목이 있으면 던진다(옛 TS도 던졌다)
#[napi]
pub fn runner_usage_of(model_usage_json: String) -> Result<String> {
    let value = input(&model_usage_json, "modelUsage")?;
    let (total, by_model) = fail(rj::usage_of(Some(&value)))?;
    Ok(out(&js_json::object(vec![("total", Some(total.to_value())), ("byModel", Some(rj::by_model_value(&by_model)))])))
}

#[napi]
pub fn runner_merge_usage_by_model(base_json: String, query_json: String) -> Result<String> {
    Ok(out(&rj::merge_usage_by_model(&input(&base_json, "기준 사용량")?, &input(&query_json, "이번 사용량")?)))
}

#[napi]
pub fn runner_add_usage(target_json: String, source_json: String) -> Result<String> {
    Ok(out(&rj::Usage::from_agent(&input(&target_json, "사용량")?).add(rj::Usage::from_agent(&input(&source_json, "사용량")?)).to_value()))
}

/// 입력은 `duration_api_ms`(encodeNative한 JSON, 없으면 `null`)
#[napi]
pub fn runner_api_duration_of(value_json: String) -> Result<Option<f64>> {
    Ok(rj::api_duration_of(Some(&input(&value_json, "API 시간")?)))
}

// ── agent: 요구사항 문서 읽기·쓰기(3단계 3ab). TS 껍데기: packages/agent/src/requirements.ts. 글자는 모두 TS가 `encodeLoneSurrogates`한 것이고 결과도 같은 인코딩이다
use bstudio_guard::requirements_markdown as rmd;

/// `{drafts, jsonBlock, assumptions, manualSteps}`(`encodeNative`와 같은 표기의 JSON). zod 검증 앞의 초안과 첫 JSON 블록의 글자. 던지지 않는다
#[napi]
pub fn req_md_parse_body(raw: String) -> String {
    out(&rmd::parse_body(&raw).to_value())
}

/// `requirements`는 몸통에서 읽어 zod가 검증한 목록, `stored`는 JSON 블록에서 zod가 검증한 요구사항 목록. 합친 목록 JSON
#[napi]
pub fn req_md_merge(requirements_json: String, stored_json: String) -> Result<String> {
    let requirements = input(&requirements_json, "요구사항 목록")?;
    let stored = input(&stored_json, "JSON 블록의 요구사항 목록")?;
    Ok(out(&fail(rmd::merge_stored(&requirements, &stored))?))
}

/// `{requirements, statusById, assumptions, manualSteps}`(encodeNative) → 마크다운. 모양이 어긋나면 던진다
#[napi]
pub fn req_md_serialize(input_json: String) -> Result<String> {
    fail(rmd::serialize(&input(&input_json, "요구사항 문서 입력")?))
}

// ── agent: 작은 판정 모음(3단계 3af). 형 변환만 한다. 이름·글은 껍데기가 encodeLoneSurrogates해서 보내고 결과 글에서 되돌린다.
use bstudio_guard::{database_branches, json_summary, steering, task_graph};

/// 덤프 바이트를 조각으로 먹이면 해시에 넣을 바이트를 돌려준다. `\restrict`·`\unrestrict` 줄을 빼고 줄 끝 글자는 그대로 둔다(줄을 통째로 쥐지 않는다)
#[napi]
pub struct NativeDumpNormalizer {
    inner: database_branches::DumpNormalizer,
}

#[napi]
impl NativeDumpNormalizer {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: database_branches::DumpNormalizer::new() }
    }

    #[napi]
    pub fn feed(&mut self, chunk: Buffer) -> Buffer {
        self.inner.feed(&chunk).into()
    }

    #[napi]
    pub fn finish(&mut self) -> Buffer {
        self.inner.finish().into()
    }
}

/// 되돌릴 덤프를 먼저 넣어 볼 임시 DB 이름. 입력·결과 모두 인코딩한 글자
#[napi]
pub fn agent_restore_database_name(encoded_name: String) -> String {
    database_branches::restore_database_name(&encoded_name)
}

/// 임시 덤프 파일 이름 목록 → 같은 길이의 pid(우리가 쓰는 꼴이 아니면 null). 지우는 코드라 모르는 이름은 null(지우지 않는다)
#[napi]
pub fn agent_temp_dump_pids(names: Vec<String>) -> Vec<Option<u32>> {
    names.iter().map(|name| database_branches::stale_temp_pid(name)).collect()
}

/// `[{ id, dependsOn }]`(id는 인코딩한 글자) → 실행할 수 없는 꼴이면 TaskGraphError 메시지(인코딩한 글자), 아니면 null. 모양이 어긋난 입력은 던진다
#[napi]
pub fn agent_task_graph_error(nodes_json: String) -> Result<Option<String>> {
    let value = input(&nodes_json, "작업 그래프")?;
    let JsValue::Arr(items) = value else { return Err(Error::from_reason("작업 그래프는 배열이어야 합니다")) };
    let mut nodes = Vec::with_capacity(items.len());
    for item in &items {
        let id = match item.prop("id") {
            Some(JsValue::Str(id)) => id.clone(),
            _ => return Err(Error::from_reason("작업 id는 문자열이어야 합니다")),
        };
        let depends_on = match item.prop("dependsOn") {
            None => Vec::new(),
            Some(JsValue::Arr(deps)) => deps
                .iter()
                .map(|dep| match dep {
                    JsValue::Str(s) => Ok(s.clone()),
                    _ => Err(Error::from_reason("의존성 id는 문자열이어야 합니다")),
                })
                .collect::<Result<Vec<_>>>()?,
            Some(_) => return Err(Error::from_reason("dependsOn은 배열이어야 합니다")),
        };
        nodes.push(task_graph::Node { id, depends_on });
    }
    Ok(task_graph::validate(&nodes))
}

#[napi]
pub fn agent_format_steering(texts: Vec<String>) -> String {
    steering::format_steering(&texts)
}

/// 마지막 메시지에 사용자 글을 넣는 방법: `concat`(글 뒤에 이어 붙임) · `push`(내용 배열에 블록을 더함) · `new`(새 메시지)
#[napi]
pub fn agent_append_user_plan(role: Option<String>, content_kind: String) -> String {
    steering::append_plan(role.as_deref(), &content_kind).as_str().to_owned()
}

/// JSON 글(인코딩한 글자)의 구조 요약. JSON이 아니거나 너무 깊으면 null
#[napi]
pub fn agent_summarize_json_content(content: String) -> Option<String> {
    json_summary::summarize_json_content(&content)
}

use bstudio_guard::visual_compare as vc;

/// 디자인 비교(3단계 3ae)의 결과. `error_kind`가 있으면 실패다: `"compare"`(옛 `VisualCompareError`)·`"decode"`(PNG를 읽지 못함)
#[napi(object)]
pub struct VisualCompareOut {
    pub error_kind: Option<String>,
    pub message: Option<String>,
    pub diff_pixels: f64,
    pub compared_pixels: f64,
    pub width: u32,
    pub height: u32,
    pub diff: Option<Buffer>,
}

/// `masks`는 `[x, y, width, height, ...]`를 이어 붙인 숫자들(NaN·소수·음수 그대로). 4의 배수가 아니면 남는 숫자는 버린다
#[napi]
pub fn visual_compare(actual: Buffer, reference: Buffer, masks: Vec<f64>, threshold: f64) -> VisualCompareOut {
    let masks: Vec<vc::Mask> = masks.chunks_exact(4).map(|m| vc::Mask { x: m[0], y: m[1], width: m[2], height: m[3] }).collect();
    let failed = |kind: &str, message: String| VisualCompareOut { error_kind: Some(kind.to_owned()), message: Some(message), diff_pixels: 0.0, compared_pixels: 0.0, width: 0, height: 0, diff: None };
    // 읽다가 패닉이 나도 통과로 이어지지 않게 읽지 못한 PNG로 돌려준다(닫는 쪽)
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| vc::compare(&actual, &reference, &masks, threshold)))
        .unwrap_or_else(|_| Err(vc::Error::Decode("비교 중 내부 오류가 났습니다".to_owned())));
    match outcome {
        Ok(done) => VisualCompareOut {
            error_kind: None,
            message: None,
            diff_pixels: done.diff_pixels as f64,
            compared_pixels: done.compared_pixels as f64,
            width: done.width,
            height: done.height,
            diff: Some(Buffer::from(done.diff)),
        },
        Err(vc::Error::Compare(message)) => failed("compare", message),
        Err(vc::Error::Decode(message)) => failed("decode", message),
    }
}
