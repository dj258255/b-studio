//! 샌드박스의 끝맺음·부하 러너·사내 API 호출·만들기 준비(옛 TS: `LocalDockerProvider.cleanup`·`create`의 앞뒤, `LocalDockerSandbox.destroy`·`callExternal`·`runLoad`,
//! `removeSandboxImages`·`assertRuntime`)(ADR-195 4f A4c-3c).
//!
//! 판정(`load_threads`·`load_run_args`·`load_config`·`load_script`·`parse_load_output`·`external_call_script`·`parse_runtimes`·`parse_container_state`)은
//! `bstudio_guard`가 하고, 여기는 docker를 부르는 순서와 지우는 대상만 정한다. **`up`은 부르지 않는다**(A4c-3a·3b와 같다: `up`은 TS의 `#upQueue`·`#gitMask`를 지난다).
//! `destroy`의 `down`은 옛 코드도 `#upQueue`를 타지 않았다(`#compose`는 첫 인자가 `up`일 때만 줄을 세운다). 그대로 줄 밖에서 부른다(ADR-195 A4c-3c).
//!
//! **지우는 코드다.** 지우는 자리와 대상은 옛 코드와 같고, 이름은 늘 계산한 값(샌드박스 id에서 파생)이나 필터 결과로 정한다. 모든 자리는 `is_sandbox_id`를 먼저 지난다.
//!  1. `compose --project-name <id> down --volumes --remove-orphans --rmi local`(external 공유 캐시는 지우지 않는다). destroy는 compose 파일을 가리키고, cleanup은 임시 폴더에서 파일 없이 돈다
//!  2. `image ls --filter reference=<id>-* --format {{.Repository}}:{{.Tag}}` 결과 가운데 `<id>-`로 시작하는 이름만 `image rm`(`--force` 없음)
//!  3. destroy의 작업 폴더(`b-studio-xxxxxx`): 그 경로가 링크면 링크만, 폴더면 안의 링크도 따라가지 않고 지운다(`safe_fs::remove_sandbox_dir`. 옛 `rm({ recursive, force })`와 같다)
//!  4. 평가 자산 복사본: `<루트>/<id>` 하나만(`safe_fs::remove_sandbox_dir`)
//!  5. 부하 러너: 중단·시간 초과가 되면 **이 실행이 만든 이름**(`<id>-load-<랜덤 hex 8자>`)으로만 `rm --force`
//!  6. create가 실패했을 때: 이 create가 만든 작업 폴더와 복사본 폴더(`abort_create`)
//!
//! 막는 쪽/여는 쪽: 모두 지우기 목록(막는 쪽)이라 모르는 입력은 지우지 않는 쪽이다. 옛 TS보다 더 막는 자리(`HARDENED`)는 id가 `b-studio`가 만든 꼴이 아니면 docker를 부르지 않는 것,
//! 작업 폴더 이름이 `b-studio-<6자>`가 아니면 지우지 않는 것, `runLoad`의 실패 이유를 **가린 뒤에** 자르는 것(TS, `lifecycle-run.ts`)이다.
//! 사내 API 호출은 **등록한 이름이 아니거나 경로가 `/`로 시작하지 않으면 docker를 부르기 전에** 거절한다(옛 코드와 같은 순서).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bstudio_guard::js;
use bstudio_guard::js_json;
use bstudio_guard::load_runner::{self, LoadRunPlan};
use bstudio_guard::node_path;
use bstudio_guard::{docker_format, external_call};

use crate::container_verify::Cancel;
use crate::process::run_command_with_limit;
use crate::safe_fs;
use crate::stream_exec::ExecOutput;
use crate::up_loop::{compose_command, docker, ComposeRef};

/// 옛 `execFile`의 기본 `maxBuffer`(스트림마다 1MiB)
const MAX_BUFFER: usize = 1024 * 1024;
/// 러너가 스스로 끝내는 상한 뒤에도 돌아오지 않으면 도커 쪽이 멈춘 것으로 본다(TS `LOAD_RUN_GRACE_MS`)
pub const LOAD_RUN_GRACE_MS: u64 = 30_000;

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

// ── 이름 ────────────────────────────────────────────────────────────────

/// `b-studio`가 만든 샌드박스 id인가(TS `SANDBOX_ID`: `^studio-[a-z][a-z0-9-]*-[0-9a-f]{6}$`). 지우는 모든 자리가 먼저 본다
pub fn is_sandbox_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("studio-") else { return false };
    let bytes = rest.as_bytes();
    // 이름(1자 이상) + '-' + 16진 6자
    if bytes.len() < 1 + 1 + 6 {
        return false;
    }
    let (name, tail) = bytes.split_at(bytes.len() - 7);
    tail[0] == b'-'
        && tail[1..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        && name[0].is_ascii_lowercase()
        && name.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// 작업 폴더의 이름꼴(`mkdtemp`의 `b-studio-` + 6자). 지우기 전에 부르는 쪽이 넘긴 경로의 끝 이름을 본다
fn is_work_dir_name(name: &str) -> bool {
    name.strip_prefix("b-studio-").is_some_and(|suffix| suffix.len() == 6 && suffix.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// 샌드박스 id의 평가 자산 복사본 폴더(`<루트>/<id>`). 호출 전에 `is_sandbox_id`를 지나야 한다
fn assets_dir(root: &str, id: &str) -> String {
    node_path::join(&[root, id])
}

fn counter_hex(width: usize) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    hasher.write_u32(std::process::id());
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::SeqCst));
    let text = format!("{:016x}", hasher.finish());
    text[..width].to_owned()
}

// ── 던지는 호출(옛 `execChecked`) ───────────────────────────────────────

/// 옛 `execChecked`가 던지던 것과 같은 정보. `code`가 `None`이면 출력이 상한을 넘어 멈춘 것이다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedFailure {
    pub message: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// `bin args`를 한 번 돌리고, 비0 종료·출력 상한 초과·띄우기 실패면 실패로 돌려준다. 환경은 상속하고(`env`를 주지 않는다) `cwd`는 부르는 쪽이 정한다
async fn exec_checked(bin: &str, args: &[String], cwd: Option<&str>) -> Result<ExecOutput, CheckedFailure> {
    let output = run_command_with_limit(bin, args, None, None, cwd, std::future::pending::<()>(), MAX_BUFFER + 1).await;
    let command = std::iter::once(bin).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
    if output.stdout.len() > MAX_BUFFER || output.stderr.len() > MAX_BUFFER {
        return Err(CheckedFailure { message: format!("maxBuffer length exceeded: {command}"), code: None, stdout: output.stdout, stderr: output.stderr });
    }
    if output.exit_code != 0 {
        return Err(CheckedFailure { message: format!("Command failed: {command}\n{}", output.stderr), code: Some(output.exit_code), stdout: output.stdout, stderr: output.stderr });
    }
    Ok(output)
}

// ── 이미지 지우기 ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveImagesError {
    /// 샌드박스 id의 꼴이 아니다(아무것도 부르지 않았다)
    InvalidId,
    Exec(CheckedFailure),
}

/// compose가 샌드박스용으로 빌드한 이미지(`<샌드박스 id>-<서비스>`)를 지운다. 빌드 캐시는 지우지 않는다.
/// 지울 이름은 `image ls --filter reference=<id>-*`의 결과 가운데 `<id>-`로 시작하는 것이고, `--force`는 쓰지 않는다(쓰는 컨테이너가 있으면 지워지지 않고 실패한다)
pub async fn remove_sandbox_images(docker_bin: &str, id: &str, cwd: Option<&str>) -> Result<(), RemoveImagesError> {
    if !is_sandbox_id(id) {
        return Err(RemoveImagesError::InvalidId);
    }
    let list = vec!["image".to_owned(), "ls".to_owned(), "--filter".to_owned(), format!("reference={id}-*"), "--format".to_owned(), "{{.Repository}}:{{.Tag}}".to_owned()];
    let listed = exec_checked(docker_bin, &list, cwd).await.map_err(RemoveImagesError::Exec)?;
    let prefix = format!("{id}-");
    let images: Vec<String> = listed.stdout.split('\n').map(js::trim).filter(|line| line.starts_with(&prefix)).map(str::to_owned).collect();
    if !images.is_empty() {
        let mut remove = strings(&["image", "rm"]);
        remove.extend(images);
        exec_checked(docker_bin, &remove, cwd).await.map_err(RemoveImagesError::Exec)?;
    }
    Ok(())
}

/// `compose --project-name <id> down --volumes --remove-orphans --rmi local`의 인자(compose 파일을 가리키지 않는다)
fn cleanup_args(id: &str) -> Vec<String> {
    vec!["compose".into(), "--project-name".into(), id.into(), "down".into(), "--volumes".into(), "--remove-orphans".into(), "--rmi".into(), "local".into()]
}

// ── cleanup ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupOutcome {
    /// 샌드박스 id의 꼴이 아니다(아무것도 부르지 않았다)
    InvalidId,
    /// 지우기가 실패했으면 그 글(먼저 실패한 것: down·이미지가 평가 자산보다 앞선다). 없으면 모두 지웠다
    Done { failure: Option<String> },
}

/// compose 파일 없이 프로젝트 이름으로 컨테이너·볼륨·네트워크·이 샌드박스가 빌드한 이미지를 지우고, 평가 자산 복사본 폴더를 지운다.
/// 작업 디렉터리의 compose 파일을 읽지 않도록 `cwd`(임시 폴더)에서 돈다. 어느 한 단계가 실패해도 다음 단계는 한다(평가 자산 지우기는 늘 한다)
pub async fn cleanup_sandbox(docker_bin: &str, id: &str, asset_root: &str, cwd: Option<&str>) -> CleanupOutcome {
    if !is_sandbox_id(id) {
        return CleanupOutcome::InvalidId;
    }
    let mut failure: Option<String> = None;
    match exec_checked(docker_bin, &cleanup_args(id), cwd).await {
        Err(error) => failure = Some(error.message),
        // 컨테이너가 이미 없으면 --rmi local이 이미지를 찾지 못한다. 이름으로 한 번 더 지운다
        Ok(_) => match remove_sandbox_images(docker_bin, id, cwd).await {
            Ok(()) => {}
            Err(RemoveImagesError::Exec(error)) => failure = Some(error.message),
            Err(RemoveImagesError::InvalidId) => failure = Some(format!("b-studio가 만든 샌드박스 id가 아닙니다: {id}")),
        },
    }
    // 평가 자산 복사본은 샌드박스와 함께 지운다. 그 샌드박스 id의 폴더만, 링크를 따라가지 않고 지운다
    if let Err(error) = safe_fs::remove_sandbox_dir_async(PathBuf::from(assets_dir(asset_root, id))).await {
        failure.get_or_insert_with(|| error.to_string());
    }
    CleanupOutcome::Done { failure }
}

// ── destroy ─────────────────────────────────────────────────────────────

pub struct DestroyInput {
    /// 환경은 compose가 시크릿 자리를 채울 값이다(`composeEnvironment`). `project_name`은 샌드박스 id다
    pub compose: ComposeRef,
    pub override_path: String,
    pub work_dir: String,
    pub asset_root: String,
    /// 이미지 목록·지우기를 돌릴 폴더(임시 폴더). 환경은 상속한다(옛 `removeSandboxImages`)
    pub cwd: Option<String>,
}

/// `down`이 비0으로 끝났다(시크릿을 가리기 전 stderr)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownFailure {
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DestroyOutcome {
    /// 샌드박스 id의 꼴이 아니다(아무것도 부르지 않았다)
    InvalidId,
    /// 단계마다의 결과. 옛 `try { down; 이미지 } finally { rm 작업 폴더 } finally { 평가 자산 }`처럼 앞 단계가 실패해도 뒤 단계는 한다
    Done {
        down: Option<DownFailure>,
        images: Option<RemoveImagesError>,
        work_dir: Option<String>,
        assets: Option<String>,
    },
}

/// 샌드박스를 지운다: `down` → 이 샌드박스가 빌드한 이미지(`down`이 실패하면 건너뛴다) → 작업 폴더 → 평가 자산 복사본. `up`의 줄(`#upQueue`)을 타지 않는다(옛 코드와 같다).
/// 작업 폴더 이름이 `b-studio-<6자>`가 아니면 지우지 않고 알린다
pub async fn destroy_sandbox(input: &DestroyInput) -> DestroyOutcome {
    let id = input.compose.project_name.as_deref().unwrap_or("");
    if !is_sandbox_id(id) {
        return DestroyOutcome::InvalidId;
    }
    let down_args = compose_command(&input.compose, &input.override_path, &strings(&["down", "--volumes", "--remove-orphans", "--rmi", "local"]));
    let downed = docker(&input.compose, &down_args, None).await;
    let (mut down, mut images) = (None, None);
    if downed.exit_code != 0 {
        down = Some(DownFailure { stderr: downed.stderr });
    } else if let Err(error) = remove_sandbox_images(&input.compose.docker_bin, id, input.cwd.as_deref()).await {
        images = Some(error);
    }

    let work_dir = remove_work_dir(&input.work_dir).await.err();
    let assets = safe_fs::remove_sandbox_dir_async(PathBuf::from(assets_dir(&input.asset_root, id))).await.err().map(|error| error.to_string());
    DestroyOutcome::Done { down, images, work_dir, assets }
}

/// 작업 폴더를 지운다. 경로가 링크면 링크만, 폴더면 안의 링크도 따라가지 않고, 없으면 무시한다(옛 `rm(dir, { recursive, force })`).
/// 이름이 `b-studio-<6자>`가 아니거나 절대 경로가 아니면 지우지 않는다
async fn remove_work_dir(work_dir: &str) -> Result<(), String> {
    let path = PathBuf::from(work_dir);
    let name_ok = path.file_name().and_then(|name| name.to_str()).is_some_and(is_work_dir_name);
    if !path.is_absolute() || !name_ok {
        return Err(format!("작업 폴더 이름이 맞지 않아 지우지 않았습니다: {work_dir}"));
    }
    safe_fs::remove_sandbox_dir_async(path).await.map_err(|error| error.to_string())
}

// ── create의 앞뒤 ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeCheck {
    /// 데몬 정보를 읽지 못했다(옛 `execChecked`가 던진 글)
    InfoFailed(String),
    /// 등록되지 않았다. 등록된 런타임 목록
    Missing(Vec<String>),
    Present,
}

/// 런타임이 Docker 데몬에 등록돼 있는지 본다(`docker info --format {{json .Runtimes}}`). 컨테이너를 만들기 전에 알리려고 `create`가 먼저 부른다
pub async fn assert_runtime(docker_bin: &str, runtime: &str) -> RuntimeCheck {
    let args = strings(&["info", "--format", "{{json .Runtimes}}"]);
    match exec_checked(docker_bin, &args, None).await {
        Err(error) => RuntimeCheck::InfoFailed(error.message),
        Ok(output) => {
            let available = docker_format::parse_runtimes(&output.stdout);
            if available.iter().any(|name| name == runtime) {
                RuntimeCheck::Present
            } else {
                RuntimeCheck::Missing(available)
            }
        }
    }
}

/// 이 샌드박스의 작업 폴더를 임시 폴더 아래에 만든다(`mkdtemp`와 같다: `b-studio-` + 무작위 6자, 권한 0700). 만든 절대 경로를 돌려준다
pub async fn make_work_dir() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let base = std::env::temp_dir();
        for _ in 0..16 {
            let suffix: String = counter_hex(12).chars().map(|c| if c.is_ascii_digit() || c.is_ascii_lowercase() { c } else { 'a' }).take(6).collect();
            let path = base.join(format!("b-studio-{suffix}"));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => return Ok(path.to_string_lossy().into_owned()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("작업 폴더 이름을 정하지 못했습니다".to_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// create가 샌드박스를 돌려주지 못하면 destroy도 불리지 않는다. 이 create가 만든 작업 폴더와 그 샌드박스 id의 복사본 폴더만 지운다.
/// 지우기 실패가 원래 오류(만들기를 거절한 이유)를 가리지 않도록 실패는 글로 돌려주고 부르는 쪽이 던지지 않는다
pub async fn abort_create(work_dir: &str, asset_root: &str, id: &str) -> Vec<String> {
    if !is_sandbox_id(id) {
        return vec![format!("b-studio가 만든 샌드박스 id가 아닙니다: {id}")];
    }
    let mut failures = Vec::new();
    if let Err(error) = remove_work_dir(work_dir).await {
        failures.push(error);
    }
    if let Err(error) = safe_fs::remove_sandbox_dir_async(PathBuf::from(assets_dir(asset_root, id))).await {
        failures.push(error.to_string());
    }
    failures
}

// ── 사내 API 호출 ───────────────────────────────────────────────────────

pub struct ExternalInput {
    pub compose: ComposeRef,
    pub override_path: String,
    pub edge_service: String,
    /// 등록한 사내 API 이름들
    pub externals: Vec<String>,
    pub name: String,
    pub path: String,
    pub edge_script: String,
    /// `{ name, via, ...request }`의 `JSON.stringify`(TS가 만든다. 짝 없는 서로게이트가 napi 경계에서 바뀌지 않게)
    pub request_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalOutcome {
    NotRegistered,
    PathNotAbsolute,
    /// 비0 종료·취소·빈 출력(시크릿을 가리기 전 stderr)
    Failed { stderr: String },
    /// 표준 출력의 마지막 줄(JSON)
    Done { last: String },
}

/// 등록한 사내 API이고 경로가 `/`로 시작하면 edge 컨테이너 안에서 호출 스크립트를 돌려 마지막 줄을 돌려준다. 앞의 둘이 맞지 않으면 docker를 부르지 않는다.
/// edge 컨테이너 안에서 실행해 샌드박스 서비스와 같은 네트워크 위치·정책·인증 시크릿으로 부른다(스튜디오용 포트를 따로 열지 않는다)
pub async fn call_external(input: &ExternalInput, cancel: Option<&Cancel>) -> ExternalOutcome {
    if !input.externals.iter().any(|external| external == &input.name) {
        return ExternalOutcome::NotRegistered;
    }
    if !input.path.starts_with('/') {
        return ExternalOutcome::PathNotAbsolute;
    }
    let script = external_call::external_call_script(&input.edge_script, &input.request_json);
    let args = compose_command(&input.compose, &input.override_path, &["exec".to_owned(), "-T".to_owned(), input.edge_service.clone(), "node".to_owned(), "--input-type=module".to_owned(), "-".to_owned()]);
    let env = input.compose.env.as_deref();
    let result = match cancel {
        Some(cancel) => crate::process::run_command(&input.compose.docker_bin, &args, Some(&script), env, None, cancel.cancelled()).await,
        None => crate::process::run_command(&input.compose.docker_bin, &args, Some(&script), env, None, std::future::pending::<()>()).await,
    };
    let last = js::trim(&result.stdout).split('\n').next_back().unwrap_or("").to_owned();
    if result.exit_code != 0 || last.is_empty() {
        return ExternalOutcome::Failed { stderr: result.stderr };
    }
    ExternalOutcome::Done { last }
}

// ── 부하 러너 ───────────────────────────────────────────────────────────

pub struct LoadInput {
    pub compose: ComposeRef,
    pub override_path: String,
    pub service: String,
    /// 서비스의 컨테이너 포트
    pub port: f64,
    /// 샌드박스의 internal 네트워크 이름의 끝(`SANDBOX_NETWORK`). 실제 이름은 `<id>_<끝>`이다
    pub sandbox_network: String,
    pub runtime: Option<String>,
    pub image: String,
    /// `LoadRequest`의 `encodeNative`
    pub request_json: String,
    pub requests: f64,
    pub concurrent: f64,
    /// 러너 스크립트 원문(TS가 한 번 읽어 둔다)
    pub runner_script: String,
    /// 이미 읽어 둔 도커 CPU 수. `None`이면 이번에 `docker info`로 읽는다(`Some(None)`은 읽었지만 알 수 없었다는 뜻이다)
    pub daemon_cpus: Option<Option<f64>>,
    /// `docker run`을 기다리는 상한(ms). 러너가 스스로 끝내는 상한 + 여유다
    pub limit_ms: u64,
    /// 호출 전에 이미 중단된 신호인가(옛 `signal?.aborted`는 실행 뒤에도 본다. 등록 전의 취소는 신호 콜백이 모른다)
    pub signal_already_aborted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LoadOutcome {
    /// 샌드박스 id의 꼴이 아니다(아무것도 부르지 않았다)
    InvalidId,
    /// `compose ps` 출력을 읽지 못했다(옛 `parseContainerState`가 던진 글)
    StateUnreadable(String),
    NotRunning(String),
    /// 부하 요청을 러너 설정으로 만들지 못했다
    ConfigInvalid(String),
    /// 신호로 중단했다(이 실행의 이름으로 `rm --force`를 불렀다)
    Aborted,
    /// 상한 시간 안에 끝나지 않았다(이 실행의 이름으로 `rm --force`를 불렀다)
    TimedOut,
    /// 러너가 비0으로 끝났다(시크릿을 가리기 전 stderr)
    RunnerFailed { exit_code: i32, stderr: String },
    /// 러너 출력을 읽지 못했다(시크릿을 가리기 전 stdout)
    Unreadable { stdout: String },
    /// `LoadResult`를 `encodeNative`한 JSON
    Done(String),
}

pub struct LoadReport {
    /// 이번에 `docker info`로 새로 읽은 CPU 수(`None`이면 읽지 않았다). TS가 캐시한다
    pub daemon_cpus_read: Option<Option<f64>>,
    pub outcome: LoadOutcome,
}

/// 서비스 상태 확인(`compose ps`) → 도커 CPU 수(`docker info`, 없으면) → 러너 스레드 수 → 러너 컨테이너 이름(`<id>-load-<랜덤 hex 8자>`) → 설정·스크립트 →
/// `docker run`(표준 입력으로 스크립트, 상한 시간) → 중단·시간 초과면 **그 이름으로만** `rm --force` → 종료 코드·출력 해석.
/// 시간 초과는 성공이 아니고, 결과를 읽지 못해도 성공이 아니다
pub async fn run_load(input: &LoadInput, cancel: &Cancel) -> LoadReport {
    let id = input.compose.project_name.clone().unwrap_or_default();
    let report = |outcome: LoadOutcome, daemon_cpus_read: Option<Option<f64>>| LoadReport { daemon_cpus_read, outcome };
    if !is_sandbox_id(&id) {
        return report(LoadOutcome::InvalidId, None);
    }

    // 꺼 뒀거나 죽은 서비스에 보내면 전부 연결 실패로만 나온다. 보내기 전에 까닭을 알린다
    let ps = compose_command(&input.compose, &input.override_path, &strings(&["ps", "--all", "--format", "json", &input.service]));
    let listed = docker(&input.compose, &ps, None).await;
    let state = match docker_format::parse_container_state(&listed.stdout) {
        Ok(state) => state,
        Err(message) => return report(LoadOutcome::StateUnreadable(message), None),
    };
    if state != "running" {
        return report(LoadOutcome::NotRunning(state), None);
    }

    let mut daemon_cpus_read = None;
    let cpus = match input.daemon_cpus {
        Some(known) => known,
        None => {
            let info = docker(&input.compose, &strings(&["info", "--format", "{{.NCPU}}"]), None).await;
            let read = if info.exit_code == 0 { Some(js::parse_int(js::trim(&info.stdout))).filter(|value| !value.is_nan() && *value != 0.0) } else { None };
            daemon_cpus_read = Some(read);
            read
        }
    };
    let threads = load_runner::load_threads(input.concurrent, cpus);
    let name = format!("{id}-load-{}", counter_hex(8));
    let request = match js_json::parse_native(&input.request_json) {
        Ok(request) => request,
        Err(message) => return report(LoadOutcome::ConfigInvalid(message), daemon_cpus_read),
    };
    let config = match load_runner::load_config(&request, input.port, threads) {
        Ok(config) => config,
        Err(message) => return report(LoadOutcome::ConfigInvalid(message), daemon_cpus_read),
    };
    let script = load_runner::load_script(&input.runner_script, &js_json::stringify(&config));
    let network = format!("{id}_{}", input.sandbox_network);
    let args = load_runner::load_run_args(&LoadRunPlan { name: &name, network: &network, sandbox_id: &id, threads, runtime: input.runtime.as_deref(), image: &input.image });

    // 신호가 깨거나 상한(`limit_ms`)이 지나면 docker 클라이언트만 끝난다
    let limit_hit = Arc::new(AtomicBool::new(false));
    let waiting = {
        let limit_hit = limit_hit.clone();
        async move {
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = tokio::time::sleep(Duration::from_millis(input.limit_ms)) => limit_hit.store(true, Ordering::SeqCst),
            }
        }
    };
    let env = input.compose.env.as_deref();
    let result = crate::process::run_command(&input.compose.docker_bin, &args, Some(&script), env, None, waiting).await;

    let signal_aborted = input.signal_already_aborted || cancel.is_cancelled();
    if signal_aborted || limit_hit.load(Ordering::SeqCst) {
        // 중단하면 docker 클라이언트만 끝나고 컨테이너는 남는다. 이 실행이 만든 이름으로만 지운다(5)
        docker(&input.compose, &strings(&["rm", "--force", &name]), None).await;
        return report(if signal_aborted { LoadOutcome::Aborted } else { LoadOutcome::TimedOut }, daemon_cpus_read);
    }
    if result.exit_code != 0 {
        return report(LoadOutcome::RunnerFailed { exit_code: result.exit_code, stderr: result.stderr }, daemon_cpus_read);
    }
    match load_runner::parse_load_output(&result.stdout, input.requests, input.concurrent) {
        Some(parsed) => report(LoadOutcome::Done(js_json::to_native(&parsed)), daemon_cpus_read),
        None => report(LoadOutcome::Unreadable { stdout: result.stdout }, daemon_cpus_read),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::fake_docker::Fake;
    use std::fs;
    use std::os::unix::fs::symlink;

    const ID: &str = "studio-shop-a1b2c3";

    fn compose(fake: &Fake) -> ComposeRef {
        ComposeRef { docker_bin: fake.bin(), env: None, project_root: "/p".into(), compose_path: "/p/compose.yaml".into(), project_name: Some(ID.into()) }
    }

    fn calls_with(fake: &Fake, first: &str) -> Vec<String> {
        fake.calls().into_iter().filter(|call| call.starts_with(first)).collect()
    }

    // ── 이름 ──

    #[test]
    fn 샌드박스_id는_b_studio가_만든_꼴만_받는다() {
        for good in ["studio-shop-a1b2c3", "studio-a-000000", "studio-my-shop-2-abcdef", "studio-a-b-abcdef"] {
            assert!(is_sandbox_id(good), "{good}");
        }
        for bad in [
            "", "studio-", "studio--a1b2c3", "studio-1shop-a1b2c3", "studio-shop-A1B2C3", "studio-shop-a1b2c", "studio-shop-a1b2c3\n", "Studio-shop-a1b2c3", "studio-shop-a1b2c3x",
            "studio-shop_x-a1b2c3", "studio-shop-a1b2g3", "studio-상점-a1b2c3", "x-studio-shop-a1b2c3", "studio-shop-a1b2c3/..", "studio-shop a1b2c3",
        ] {
            assert!(!is_sandbox_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn 작업_폴더_이름꼴() {
        assert!(is_work_dir_name("b-studio-aB3x9Z"));
        for bad in ["b-studio-", "b-studio-abc", "b-studio-abcdefg", "b-studio-ab/cde", "b-studio-ab.cde", "studio-abcdef", "B-studio-abcdef", ".."] {
            assert!(!is_work_dir_name(bad), "{bad}");
        }
    }

    // ── 이미지 ──

    #[tokio::test]
    async fn 이미지는_목록의_접두사가_맞는_이름만_force_없이_지운다() {
        let fake = Fake::new();
        fake.set("imagels", &format!("{ID}-web:latest\n{ID}-api:latest\n other-image:latest\n{ID}x-web:latest\n<none>:<none>\n  {ID}-db:1\r\n"));
        remove_sandbox_images(&fake.bin(), ID, None).await.unwrap();
        let calls = fake.calls();
        assert_eq!(calls[0], format!("image ls --filter reference={ID}-* --format {{{{.Repository}}}}:{{{{.Tag}}}}"));
        assert_eq!(calls[1], format!("image rm {ID}-web:latest {ID}-api:latest {ID}-db:1"));
        assert_eq!(calls.len(), 2);
    }

    #[tokio::test]
    async fn 이미지가_없으면_rm을_부르지_않고_id_꼴이_아니면_아무것도_부르지_않는다() {
        let fake = Fake::new();
        fake.set("imagels", "unrelated:latest\n");
        remove_sandbox_images(&fake.bin(), ID, None).await.unwrap();
        assert_eq!(fake.calls().len(), 1);
        let fake = Fake::new();
        assert_eq!(remove_sandbox_images(&fake.bin(), "studio-x-zzzzzz", None).await, Err(RemoveImagesError::InvalidId));
        assert_eq!(remove_sandbox_images(&fake.bin(), "*", None).await, Err(RemoveImagesError::InvalidId));
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 이미지_목록이나_rm이_실패하면_옛_execchecked_글로_돌려준다() {
        let fake = Fake::new();
        fake.fail("imagels", 3, "boom");
        let Err(RemoveImagesError::Exec(failure)) = remove_sandbox_images(&fake.bin(), ID, None).await else { panic!() };
        assert_eq!(failure.code, Some(3));
        assert_eq!(failure.stderr, "boom");
        assert!(failure.message.starts_with(&format!("Command failed: {} image ls --filter reference={ID}-*", fake.bin())));
        assert!(failure.message.ends_with("\nboom"));
        let fake = Fake::new();
        fake.set("imagels", &format!("{ID}-web:latest\n"));
        fake.fail("imagerm", 1, "in use");
        assert!(matches!(remove_sandbox_images(&fake.bin(), ID, None).await, Err(RemoveImagesError::Exec(_))));
    }

    // ── cleanup ──

    #[tokio::test]
    async fn cleanup은_파일_없이_프로젝트_이름으로_지우고_평가_자산은_그_id의_폴더만_지운다() {
        let fake = Fake::new();
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(ID).join("deep")).unwrap();
        fs::write(root.path().join(ID).join("deep/a"), "x").unwrap();
        fs::create_dir_all(root.path().join("studio-other-ffffff")).unwrap();
        let outcome = cleanup_sandbox(&fake.bin(), ID, root.path().to_str().unwrap(), Some("/")).await;
        assert_eq!(outcome, CleanupOutcome::Done { failure: None });
        let calls = fake.calls();
        assert_eq!(calls[0], format!("compose --project-name {ID} down --volumes --remove-orphans --rmi local"));
        assert!(calls[1].starts_with("image ls --filter"));
        assert!(!root.path().join(ID).exists());
        assert!(root.path().join("studio-other-ffffff").exists());
    }

    #[tokio::test]
    async fn cleanup은_down이_실패하면_이미지를_건너뛰고_평가_자산은_지우고_실패_글을_돌려준다() {
        let fake = Fake::new();
        fake.fail("down", 1, "no daemon");
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(ID)).unwrap();
        let CleanupOutcome::Done { failure } = cleanup_sandbox(&fake.bin(), ID, root.path().to_str().unwrap(), None).await else { panic!() };
        assert!(failure.unwrap().ends_with("\nno daemon"));
        assert_eq!(fake.calls().len(), 1);
        assert!(!root.path().join(ID).exists());
    }

    #[tokio::test]
    async fn cleanup은_평가_자산을_지우지_못해도_먼저_난_down_실패를_돌려준다() {
        use std::os::unix::fs::PermissionsExt;
        let fake = Fake::new();
        fake.fail("down", 1, "no daemon");
        let root = tempfile::tempdir().unwrap();
        let locked = root.path().join(ID).join("locked");
        fs::create_dir_all(&locked).unwrap();
        fs::write(locked.join("f"), "x").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
        let CleanupOutcome::Done { failure } = cleanup_sandbox(&fake.bin(), ID, root.path().to_str().unwrap(), None).await else { panic!() };
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failure.unwrap().ends_with("\nno daemon"), "먼저 난 실패가 이긴다");
        assert!(locked.join("f").exists(), "지우지 못한 것은 남는다");
        // down이 성공하면 평가 자산을 지우지 못한 것이 실패다
        let fake = Fake::new();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
        let CleanupOutcome::Done { failure } = cleanup_sandbox(&fake.bin(), ID, root.path().to_str().unwrap(), None).await else { panic!() };
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failure.is_some());
    }

    #[tokio::test]
    async fn cleanup은_id_꼴이_아니면_아무것도_부르거나_지우지_않는다() {
        let fake = Fake::new();
        // `..`가 가리키는 폴더가 시험의 임시 폴더 안에 머물도록 루트를 한 단계 안에 둔다(검사가 빠져도 시험 밖을 지우지 않는다)
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("assets").join("inner");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(base.path().join("assets").join("x")).unwrap();
        for bad in ["..", "../x", "studio-x", ""] {
            assert_eq!(cleanup_sandbox(&fake.bin(), bad, root.to_str().unwrap(), None).await, CleanupOutcome::InvalidId);
        }
        assert!(fake.calls().is_empty());
        assert!(root.exists() && base.path().join("assets").join("x").exists());
    }

    // ── destroy ──

    fn destroy_input(fake: &Fake, work_dir: &str, root: &str) -> DestroyInput {
        DestroyInput { compose: compose(fake), override_path: "/w/compose.override.yaml".into(), work_dir: work_dir.into(), asset_root: root.into(), cwd: Some("/".into()) }
    }

    fn work_dir_in(base: &std::path::Path) -> String {
        let dir = base.join("b-studio-abc123");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("compose.override.yaml"), "x").unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn destroy는_down_이미지_작업_폴더_평가_자산_순서로_옛_인자_그대로_지운다() {
        let fake = Fake::new();
        fake.set("imagels", &format!("{ID}-web:latest\n"));
        let tmp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let work = work_dir_in(tmp.path());
        fs::create_dir_all(root.path().join(ID)).unwrap();
        fs::create_dir_all(root.path().join("studio-keep-aaaaaa")).unwrap();
        let outcome = destroy_sandbox(&destroy_input(&fake, &work, root.path().to_str().unwrap())).await;
        assert_eq!(outcome, DestroyOutcome::Done { down: None, images: None, work_dir: None, assets: None });
        let calls = fake.calls();
        assert_eq!(calls[0], format!("compose --project-name {ID} --project-directory /p --file /p/compose.yaml --file /w/compose.override.yaml down --volumes --remove-orphans --rmi local"));
        assert_eq!(calls[1], format!("image ls --filter reference={ID}-* --format {{{{.Repository}}}}:{{{{.Tag}}}}"));
        assert_eq!(calls[2], format!("image rm {ID}-web:latest"));
        assert_eq!(calls.len(), 3);
        assert!(!std::path::Path::new(&work).exists());
        assert!(!root.path().join(ID).exists());
        assert!(root.path().join("studio-keep-aaaaaa").exists());
    }

    #[tokio::test]
    async fn destroy는_down이_실패해도_작업_폴더와_평가_자산을_지우고_이미지는_건너뛴다() {
        let fake = Fake::new();
        fake.fail("down", 1, "daemon down");
        let tmp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let work = work_dir_in(tmp.path());
        fs::create_dir_all(root.path().join(ID)).unwrap();
        let outcome = destroy_sandbox(&destroy_input(&fake, &work, root.path().to_str().unwrap())).await;
        assert_eq!(outcome, DestroyOutcome::Done { down: Some(DownFailure { stderr: "daemon down".into() }), images: None, work_dir: None, assets: None });
        assert_eq!(fake.calls().len(), 1);
        assert!(!std::path::Path::new(&work).exists());
        assert!(!root.path().join(ID).exists());
    }

    #[tokio::test]
    async fn destroy의_작업_폴더가_링크면_링크만_지우고_너머는_지우지_않는다() {
        let fake = Fake::new();
        let tmp = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::write(target.path().join("precious"), "keep").unwrap();
        let link = tmp.path().join("b-studio-abc123");
        symlink(target.path(), &link).unwrap();
        let root = tempfile::tempdir().unwrap();
        let outcome = destroy_sandbox(&destroy_input(&fake, link.to_str().unwrap(), root.path().to_str().unwrap())).await;
        assert!(matches!(outcome, DestroyOutcome::Done { work_dir: None, .. }));
        assert!(fs::symlink_metadata(&link).is_err(), "링크는 지워진다");
        assert_eq!(fs::read_to_string(target.path().join("precious")).unwrap(), "keep");
    }

    #[tokio::test]
    async fn destroy의_작업_폴더_안의_링크도_따라가지_않는다() {
        let fake = Fake::new();
        let tmp = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::write(target.path().join("precious"), "keep").unwrap();
        let work = work_dir_in(tmp.path());
        symlink(target.path(), std::path::Path::new(&work).join("sub/link")).unwrap();
        let root = tempfile::tempdir().unwrap();
        destroy_sandbox(&destroy_input(&fake, &work, root.path().to_str().unwrap())).await;
        assert!(!std::path::Path::new(&work).exists());
        assert_eq!(fs::read_to_string(target.path().join("precious")).unwrap(), "keep");
    }

    #[tokio::test]
    async fn destroy의_작업_폴더가_파일이면_그_파일만_지운다() {
        let fake = Fake::new();
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("b-studio-abc123");
        fs::write(&file, "x").unwrap();
        let root = tempfile::tempdir().unwrap();
        let outcome = destroy_sandbox(&destroy_input(&fake, file.to_str().unwrap(), root.path().to_str().unwrap())).await;
        assert!(matches!(outcome, DestroyOutcome::Done { work_dir: None, .. }));
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn destroy는_이름꼴이_맞지_않는_작업_폴더나_상대_경로를_지우지_않는다() {
        let fake = Fake::new();
        let tmp = tempfile::tempdir().unwrap();
        let precious = tmp.path().join("projects");
        fs::create_dir_all(&precious).unwrap();
        let root = tempfile::tempdir().unwrap();
        // 절대 경로이면서 이름꼴이 맞지 않는 폴더, 이름꼴은 맞지만 상대 경로인 것, 빈 경로. (검사가 빠졌을 때 시험 밖을 지우지 않도록 `/` 같은 경로는 넣지 않는다)
        for bad in [precious.to_str().unwrap(), "b-studio-abc123", ""] {
            let outcome = destroy_sandbox(&destroy_input(&fake, bad, root.path().to_str().unwrap())).await;
            assert!(matches!(outcome, DestroyOutcome::Done { work_dir: Some(_), .. }), "{bad}");
        }
        assert!(precious.exists());
    }

    #[tokio::test]
    async fn destroy는_id_꼴이_아니면_아무것도_부르거나_지우지_않는다() {
        let fake = Fake::new();
        let tmp = tempfile::tempdir().unwrap();
        let work = work_dir_in(tmp.path());
        let root = tempfile::tempdir().unwrap();
        let mut input = destroy_input(&fake, &work, root.path().to_str().unwrap());
        input.compose.project_name = Some("studio-x".into());
        assert_eq!(destroy_sandbox(&input).await, DestroyOutcome::InvalidId);
        input.compose.project_name = None;
        assert_eq!(destroy_sandbox(&input).await, DestroyOutcome::InvalidId);
        assert!(fake.calls().is_empty());
        assert!(std::path::Path::new(&work).exists());
    }

    // ── create의 앞뒤 ──

    #[tokio::test]
    async fn 런타임_확인() {
        let fake = Fake::new();
        fake.set("info", "{\"runc\":{\"path\":\"runc\"},\"runsc\":{\"path\":\"runsc\"}}\n");
        assert_eq!(assert_runtime(&fake.bin(), "runsc").await, RuntimeCheck::Present);
        assert_eq!(assert_runtime(&fake.bin(), "kata").await, RuntimeCheck::Missing(vec!["runc".into(), "runsc".into()]));
        assert_eq!(fake.calls()[0], "info --format {{json .Runtimes}}");
        let fake = Fake::new();
        fake.fail("info", 1, "Cannot connect");
        let RuntimeCheck::InfoFailed(message) = assert_runtime(&fake.bin(), "runsc").await else { panic!() };
        assert!(message.ends_with("\nCannot connect"));
    }

    #[tokio::test]
    async fn 작업_폴더를_만들고_create_실패_때_그_폴더와_복사본만_지운다() {
        let dir = make_work_dir().await.unwrap();
        let path = std::path::Path::new(&dir);
        assert!(path.is_absolute() && path.is_dir());
        assert!(is_work_dir_name(path.file_name().unwrap().to_str().unwrap()));
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(ID)).unwrap();
        fs::create_dir_all(root.path().join("studio-keep-aaaaaa")).unwrap();
        assert!(abort_create(&dir, root.path().to_str().unwrap(), ID).await.is_empty());
        assert!(!path.exists());
        assert!(!root.path().join(ID).exists());
        assert!(root.path().join("studio-keep-aaaaaa").exists());
        // 이름꼴이 맞지 않으면 지우지 않고 알린다
        let keep = tempfile::tempdir().unwrap();
        assert_eq!(abort_create(keep.path().to_str().unwrap(), root.path().to_str().unwrap(), ID).await.len(), 1);
        assert!(keep.path().exists());
        // id 꼴이 아니면 복사본 폴더 쪽도 건드리지 않는다(`..`가 시험의 임시 폴더 안에 머물도록 루트를 한 단계 안에 둔다)
        let base = tempfile::tempdir().unwrap();
        let inner = base.path().join("assets").join("inner");
        fs::create_dir_all(&inner).unwrap();
        let work = make_work_dir().await.unwrap();
        assert_eq!(abort_create(&work, inner.to_str().unwrap(), "../x").await.len(), 1);
        assert!(std::path::Path::new(&work).exists(), "id 꼴이 틀리면 작업 폴더도 지우지 않는다");
        let _ = fs::remove_dir(&work);
    }

    #[tokio::test]
    async fn 작업_폴더는_소유자만_쓸_수_있다() {
        use std::os::unix::fs::PermissionsExt;
        let dir = make_work_dir().await.unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = fs::remove_dir(&dir);
    }

    #[tokio::test]
    async fn 작업_폴더_이름은_겹치지_않는다() {
        let (a, b) = (make_work_dir().await.unwrap(), make_work_dir().await.unwrap());
        assert_ne!(a, b);
        let _ = fs::remove_dir(&a);
        let _ = fs::remove_dir(&b);
    }

    // ── 사내 API ──

    fn external_input(fake: &Fake) -> ExternalInput {
        ExternalInput {
            compose: compose(fake),
            override_path: "/w/o.yaml".into(),
            edge_service: "edge".into(),
            externals: vec!["billing".into()],
            name: "billing".into(),
            path: "/v1/ping".into(),
            edge_script: "// edge".into(),
            request_json: "{\"name\":\"billing\"}".into(),
        }
    }

    #[tokio::test]
    async fn 등록하지_않은_이름과_슬래시로_시작하지_않는_경로는_docker를_부르기_전에_거절한다() {
        let fake = Fake::new();
        let mut input = external_input(&fake);
        input.name = "payments".into();
        assert_eq!(call_external(&input, None).await, ExternalOutcome::NotRegistered);
        let mut input = external_input(&fake);
        input.path = "v1/ping".into();
        assert_eq!(call_external(&input, None).await, ExternalOutcome::PathNotAbsolute);
        input.path = "".into();
        assert_eq!(call_external(&input, None).await, ExternalOutcome::PathNotAbsolute);
        input.path = "//evil.example/x".into();
        // 슬래시 둘로 시작하는 경로의 해석은 호출 스크립트(`externalCallScript`)가 한다. 여기는 옛 코드처럼 `/` 시작만 본다
        assert!(matches!(call_external(&input, None).await, ExternalOutcome::Done { .. } | ExternalOutcome::Failed { .. }));
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn 이름과_경로가_모두_틀리면_이름을_먼저_거절한다() {
        let fake = Fake::new();
        let mut input = external_input(&fake);
        input.name = "payments".into();
        input.path = "v1".into();
        assert_eq!(call_external(&input, None).await, ExternalOutcome::NotRegistered);
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 사내_api가_비0으로_끝나면_출력이_있어도_실패다() {
        let fake = Fake::new();
        fake.set("exec", "{\"status\":200}\n");
        fake.fail("exec", 1, "node crashed");
        assert_eq!(call_external(&external_input(&fake), None).await, ExternalOutcome::Failed { stderr: "node crashed".into() });
    }

    #[tokio::test]
    async fn 사내_api는_edge에서_node로_돌리고_마지막_줄을_돌려준다() {
        let fake = Fake::new();
        fake.set("exec", "noise\n{\"status\":200}\n");
        let outcome = call_external(&external_input(&fake), None).await;
        assert_eq!(outcome, ExternalOutcome::Done { last: "{\"status\":200}".into() });
        assert_eq!(fake.calls()[0], format!("compose --project-name {ID} --project-directory /p --file /p/compose.yaml --file /w/o.yaml exec -T edge node --input-type=module -"));
        let fake = Fake::new();
        fake.fail("exec", 1, "node: boom");
        assert_eq!(call_external(&external_input(&fake), None).await, ExternalOutcome::Failed { stderr: "node: boom".into() });
        let fake = Fake::new();
        assert_eq!(call_external(&external_input(&fake), None).await, ExternalOutcome::Failed { stderr: String::new() });
    }

    // ── 부하 러너 ──

    fn load_input(fake: &Fake) -> LoadInput {
        LoadInput {
            compose: compose(fake),
            override_path: "/w/o.yaml".into(),
            service: "api".into(),
            port: 8080.0,
            sandbox_network: "sandbox".into(),
            runtime: None,
            image: "busybox:1.37".into(),
            request_json: "{\"service\":\"api\",\"method\":\"GET\",\"path\":\"/\",\"requests\":10,\"concurrent\":2}".into(),
            requests: 10.0,
            concurrent: 2.0,
            runner_script: "// runner".into(),
            daemon_cpus: None,
            limit_ms: 60_000,
            signal_already_aborted: false,
        }
    }

    fn running(fake: &Fake) {
        fake.set("ps", "{\"Service\":\"api\",\"State\":\"running\"}\n");
        fake.set("info", "8\n");
    }

    const OUTPUT: &str = "{\"requests\":10,\"concurrent\":2,\"threads\":1,\"completed\":10,\"elapsedMs\":5,\"statuses\":{\"200\":10},\"errors\":{},\"latency\":{\"count\":10,\"p50\":1,\"p95\":2,\"p99\":2,\"max\":3},\"connect\":{\"count\":10,\"p50\":1,\"p95\":1,\"p99\":1,\"max\":1,\"errors\":0},\"loopDelay\":{\"p99\":1,\"max\":1},\"warmup\":{\"requests\":0,\"errors\":0}}";

    #[tokio::test]
    async fn 부하는_상태_확인_cpu_읽기_run_순서로_돌고_성공하면_rm을_부르지_않는다() {
        let fake = Fake::new();
        running(&fake);
        fake.set("run", &format!("{OUTPUT}\n"));
        let report = run_load(&load_input(&fake), &Cancel::default()).await;
        assert!(matches!(report.outcome, LoadOutcome::Done(_)), "{:?}", report.outcome);
        assert_eq!(report.daemon_cpus_read, Some(Some(8.0)));
        let calls = fake.calls();
        assert!(calls[0].contains(" ps --all --format json api"));
        assert_eq!(calls[1], "info --format {{.NCPU}}");
        assert!(calls[2].starts_with("run --rm --interactive --pull never --name studio-shop-a1b2c3-load-"));
        assert!(calls[2].contains(&format!("--network {ID}_sandbox")));
        assert_eq!(calls.len(), 3);
    }

    #[tokio::test]
    async fn 이미_읽어_둔_cpu_수가_있으면_info를_부르지_않는다() {
        let fake = Fake::new();
        running(&fake);
        fake.set("run", &format!("{OUTPUT}\n"));
        let mut input = load_input(&fake);
        input.daemon_cpus = Some(Some(2.0));
        let report = run_load(&input, &Cancel::default()).await;
        assert!(report.daemon_cpus_read.is_none());
        assert!(calls_with(&fake, "info").is_empty());
        // 알 수 없었다는 것도 읽은 것이다
        let mut input = load_input(&fake);
        input.daemon_cpus = Some(None);
        run_load(&input, &Cancel::default()).await;
        assert!(calls_with(&fake, "info").is_empty());
    }

    #[tokio::test]
    async fn 알고_있는_cpu_수가_러너의_cpu_제한을_정한다() {
        let fake = Fake::new();
        running(&fake);
        fake.set("run", &format!("{OUTPUT}\n"));
        let mut input = load_input(&fake);
        input.request_json = "{\"service\":\"api\",\"method\":\"GET\",\"path\":\"/\",\"requests\":1000,\"concurrent\":1000}".into();
        input.concurrent = 1000.0;
        input.daemon_cpus = Some(Some(16.0));
        run_load(&input, &Cancel::default()).await;
        assert!(calls_with(&fake, "run")[0].contains("--cpus 4 "), "동시 1000이면 스레드 4개");
        // 도커 CPU가 2개로 알려져 있으면 절반인 1개를 넘지 않는다
        let fake = Fake::new();
        running(&fake);
        fake.set("run", &format!("{OUTPUT}\n"));
        input.compose = compose(&fake);
        input.daemon_cpus = Some(Some(2.0));
        run_load(&input, &Cancel::default()).await;
        assert!(calls_with(&fake, "run")[0].contains("--cpus 1 "));
    }

    #[tokio::test]
    async fn 읽은_cpu_수는_옛_parseint처럼_읽고_0과_숫자가_아닌_것은_알_수_없음이다() {
        for (info, want) in [("8\n", Some(8.0)), ("0\n", None), ("abc\n", None), ("3.7\n", Some(3.0)), ("  8 cores\n", Some(8.0)), ("", None)] {
            let fake = Fake::new();
            fake.set("ps", "{\"Service\":\"api\",\"State\":\"running\"}\n");
            fake.set("info", info);
            fake.set("run", &format!("{OUTPUT}\n"));
            let report = run_load(&load_input(&fake), &Cancel::default()).await;
            assert_eq!(report.daemon_cpus_read, Some(want), "{info:?}");
        }
        let fake = Fake::new();
        fake.set("ps", "{\"Service\":\"api\",\"State\":\"running\"}\n");
        fake.fail("info", 1, "x");
        assert_eq!(run_load(&load_input(&fake), &Cancel::default()).await.daemon_cpus_read, Some(None));
    }

    #[tokio::test]
    async fn 러너_컨테이너_이름은_실행마다_다르고_스크립트는_표준_입력으로_간다() {
        let fake = Fake::new();
        running(&fake);
        fake.set("run", &format!("{OUTPUT}\n"));
        fake.hook("run", 1, "cat > \"$D/stdin.txt\"");
        for _ in 0..3 {
            run_load(&load_input(&fake), &Cancel::default()).await;
        }
        let names: std::collections::HashSet<String> = calls_with(&fake, "run").iter().map(|run| run.split(' ').skip_while(|word| *word != "--name").nth(1).unwrap().to_owned()).collect();
        assert_eq!(names.len(), 3);
        let stdin = fs::read_to_string(fake.dir.path().join("stdin.txt")).unwrap();
        assert!(stdin.starts_with("globalThis.B_STUDIO_LOAD = {\"host\":\"api\",\"port\":8080"), "{stdin}");
        assert!(stdin.ends_with("\n// runner"));
    }

    #[tokio::test]
    async fn 서비스가_실행_중이_아니면_러너를_띄우지_않는다() {
        let fake = Fake::new();
        fake.set("ps", "{\"Service\":\"api\",\"State\":\"exited\"}\n");
        let report = run_load(&load_input(&fake), &Cancel::default()).await;
        assert_eq!(report.outcome, LoadOutcome::NotRunning("exited".into()));
        assert_eq!(fake.calls().len(), 1);
        let fake = Fake::new();
        assert_eq!(run_load(&load_input(&fake), &Cancel::default()).await.outcome, LoadOutcome::NotRunning("unknown".into()));
    }

    #[tokio::test]
    async fn 러너가_비0으로_끝나면_종료_코드와_stderr를_그대로_돌려준다() {
        let fake = Fake::new();
        running(&fake);
        fake.fail("run", 137, "Killed");
        let report = run_load(&load_input(&fake), &Cancel::default()).await;
        assert_eq!(report.outcome, LoadOutcome::RunnerFailed { exit_code: 137, stderr: "Killed".into() });
        assert!(calls_with(&fake, "rm").is_empty());
    }

    #[tokio::test]
    async fn 러너_출력을_읽지_못하면_성공이_아니다() {
        let fake = Fake::new();
        running(&fake);
        fake.set("run", "not json\n");
        let report = run_load(&load_input(&fake), &Cancel::default()).await;
        assert_eq!(report.outcome, LoadOutcome::Unreadable { stdout: "not json\n".into() });
        // 상태 코드 합이 맞지 않는 결과도 성공이 아니다
        let fake = Fake::new();
        running(&fake);
        fake.set("run", &OUTPUT.replace("\"200\":10", "\"200\":9"));
        assert!(matches!(run_load(&load_input(&fake), &Cancel::default()).await.outcome, LoadOutcome::Unreadable { .. }));
    }

    #[tokio::test]
    async fn 시간_초과는_오류이고_이_실행의_이름으로만_rm_force를_부른다() {
        let fake = Fake::new();
        running(&fake);
        fake.set("run", &format!("{OUTPUT}\n"));
        fs::write(fake.dir.path().join("run.sleep"), "5").unwrap();
        let mut input = load_input(&fake);
        input.limit_ms = 300;
        let report = run_load(&input, &Cancel::default()).await;
        assert_eq!(report.outcome, LoadOutcome::TimedOut);
        let run = calls_with(&fake, "run").remove(0);
        let name = run.split(' ').skip_while(|word| *word != "--name").nth(1).unwrap().to_owned();
        assert!(name.starts_with(&format!("{ID}-load-")) && name.len() == ID.len() + "-load-".len() + 8);
        assert_eq!(calls_with(&fake, "rm"), vec![format!("rm --force {name}")]);
    }

    #[tokio::test]
    async fn 신호로_중단해도_이_실행의_이름으로만_rm_force를_부른다() {
        let fake = Fake::new();
        running(&fake);
        fs::write(fake.dir.path().join("run.sleep"), "5").unwrap();
        let cancel = Arc::new(Cancel::default());
        let abort = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            abort.cancel();
        });
        let report = run_load(&load_input(&fake), &cancel).await;
        assert_eq!(report.outcome, LoadOutcome::Aborted);
        let rms = calls_with(&fake, "rm");
        assert_eq!(rms.len(), 1);
        assert!(rms[0].starts_with(&format!("rm --force {ID}-load-")));
    }

    #[tokio::test]
    async fn 호출_전에_중단된_신호는_실행_뒤에_알아보고_rm을_부른다() {
        let fake = Fake::new();
        running(&fake);
        fake.set("run", &format!("{OUTPUT}\n"));
        let mut input = load_input(&fake);
        input.signal_already_aborted = true;
        let report = run_load(&input, &Cancel::default()).await;
        assert_eq!(report.outcome, LoadOutcome::Aborted);
        assert_eq!(calls_with(&fake, "rm").len(), 1);
    }

    #[tokio::test]
    async fn id_꼴이_아니면_부하도_rm도_부르지_않는다() {
        let fake = Fake::new();
        let mut input = load_input(&fake);
        input.compose.project_name = Some("x; rm".into());
        assert_eq!(run_load(&input, &Cancel::default()).await.outcome, LoadOutcome::InvalidId);
        assert!(fake.calls().is_empty());
    }
}
