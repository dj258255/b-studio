//! 의존성 스냅샷 계획·채우기·저장·정리(옛 TS: `LocalDockerSandbox.#planSnapshots`·`#seedSnapshot`·`#captureSnapshot`·`#pruneSnapshots`), 공유 볼륨 만들기
//! (`#ensureSharedVolumes`), 사용량 읽기(`stats()`)(ADR-195 4f A4c-3b).
//!
//! 판정(`snapshot_name`·`snapshots_to_prune`·`parse_inspect_output`·`parse_stats_output`·`merge_usage`)은 `bstudio_guard`가 하고, 여기는 키 파일을 읽고
//! docker를 부르는 순서만 한다. **`up`은 부르지 않는다**: 스냅샷 채우기는 컨테이너를 만들기 전에, 저장은 서비스가 준비된 뒤에 도는데, 그 앞뒤의 `up`은
//! TS의 `#upQueue`·`#gitMask`를 지나야 한다. 이 모듈은 `volume`·`run`·`inspect`·`stats`·`compose ps`만 부른다.
//!
//! **지우는 코드다.** `volume rm`의 대상은 아래 넷뿐이고, 이름은 늘 계산한 값이나 라벨 필터의 결과로 정한다(부르는 쪽이 넘긴 문자열을 그대로 쓰지 않는다).
//!  1. 이 기동이 방금 만들려던 이 샌드박스의 볼륨(`<샌드박스 id>_<볼륨>`), `--force` — 채우기(seed)가 실패했을 때
//!  2. 복사 단계가 종료 코드 3(표시 파일 없음)으로 끝난 스냅샷, `--force` 없음 — 다른 샌드박스가 쓰는 중이면 지워지지 않는다
//!  3. 저장(capture)의 복사가 실패한 그 스냅샷, `--force`
//!  4. 정리(prune): 같은 자리 라벨(`b-studio.snapshot.slot=<자리>`)의 목록 가운데 `snapshots_to_prune`이 고른 것, `--force` 없음
//!
//! 막는 쪽/여는 쪽: 지우기 목록은 넓게 맞추면 멀쩡한 것이 지워지므로 모두 좁게 읽는다. 옛 TS보다 더 막는 자리(`HARDENED`)는 아래 넷이고, 실제 docker는
//! 이 입력을 내지 않는다.
//!  - 종료 코드 3은 **복사 단계**에서 나온 것만 "표시 파일 없음"이다(옛 TS는 `volume create`의 3도 그렇게 읽어 멀쩡한 스냅샷을 지웠다).
//!  - 정리는 방금 저장한 스냅샷, 라벨 필터 목록에 없던 이름, `b-studio-snapshot-` 접두사가 없는 이름을 지우지 않는다(옛 TS는 `inspect` 출력에 든 이름을 그대로 지웠다).
//!  - 정리가 쓰는 자리는 부르는 쪽이 넘긴 문자열이 아니라 계획의 (프로젝트, 서비스, 볼륨)에서 다시 계산한다. 계획의 이름이 계산값과 다르면 아무것도 부르지 않는다.
//!  - 만든 시각을 읽을 수 없으면(날짜 읽기 실패) 정리하지 않는다("모른다"는 지우지 않는 쪽).
//! 목록(`volume ls`)이 비0으로 끝나도 정리하지 않는다(옛 TS도 빈 stdout이라 결과는 같다).
//!
//! 이벤트: 이 함수들은 결과(이벤트에 쓸 값)를 돌려주고, 이벤트를 알리는 것은 TS다. 이벤트가 docker 호출 사이의 어디에서 나는지는 옛 TS와 같다
//! (seed는 마지막, capture는 저장이 끝난 뒤 정리 전 — 그래서 저장과 정리는 따로 부른다).
//! `capturing`(같은 스냅샷을 프로세스 안에서 두 번 저장하지 않는 집합)은 TS에 둔다. 저장 → 이벤트 → 정리 전체가 그 집합 안에 있어야 하는데 이벤트가 TS 콜백이다.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::{node_path, snapshots, usage};
use tokio::task::JoinSet;

use crate::container_verify::Cancel;
use crate::process::run_command_with_limit;
use crate::stream_exec::ExecOutput;
use crate::up_loop::{compose_command, docker, ComposeRef};

/// 스냅샷 볼륨에 붙이는 라벨. 정리할 때 이 라벨로 찾는다(TS `SNAPSHOT_LABEL`)
pub const SNAPSHOT_LABEL: &str = "b-studio.snapshot";
/// 복사가 끝까지 끝난 스냅샷에만 남기는 표시 파일(TS `SNAPSHOT_MARKER`)
pub const SNAPSHOT_MARKER: &str = ".b-studio-snapshot-complete";
/// 같은 자리에 남길 스냅샷 수(TS `SNAPSHOTS_TO_KEEP`)
pub const SNAPSHOTS_TO_KEEP: f64 = 2.0;
/// 스냅샷 볼륨 이름의 접두사(`snapshot_name`이 만든다)
const SNAPSHOT_PREFIX: &str = "b-studio-snapshot-";
/// 표시 파일이 없다는 뜻으로 seed 스크립트가 내는 종료 코드
const EXIT_INCOMPLETE: i32 = 3;

/// 끝까지 복사된 스냅샷만 쓴다. 표시 파일이 없으면 3으로 끝내 깨진 스냅샷을 지우게 한다
fn seed_script() -> String {
    format!("[ -f /from/{SNAPSHOT_MARKER} ] || exit 3\ncp -a /from/. /to/ && rm -f /to/{SNAPSHOT_MARKER}")
}

/// 표시 파일은 복사가 끝난 뒤에만 남긴다
fn capture_script() -> String {
    format!("cp -a /from/. /to/ && touch /to/{SNAPSHOT_MARKER}")
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

// ── 계획 ────────────────────────────────────────────────────────────────

/// 스냅샷을 정한 (서비스, 볼륨) 하나. `spec_path`는 프로젝트 루트 기준 서비스 폴더, `key`는 그 폴더 기준 키 파일
#[derive(Debug, Clone)]
pub struct PlanVolume {
    pub service: String,
    pub volume: String,
    pub spec_path: String,
    pub key: Vec<String>,
}

/// 한 스냅샷의 이름들. 모두 계산한 값이다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub service: String,
    pub volume: String,
    pub snapshot: String,
    pub slot: String,
    /// compose가 이 샌드박스에 만들 볼륨 이름
    pub sandbox_volume: String,
}

/// 이 샌드박스와 프로젝트를 가리키는 이름. 계획의 이름을 다시 계산해 견주는 데 쓴다
#[derive(Debug, Clone)]
pub struct Scope {
    pub project_name: String,
    pub sandbox_id: String,
}

impl Scope {
    /// 계획의 `slot`·`sandbox_volume`이 (프로젝트, 서비스, 볼륨, 샌드박스)에서 계산한 값과 같고 스냅샷 이름이 `snapshot_name`의 꼴인지 본다
    fn accepts(&self, plan: &Plan) -> bool {
        plan.slot == snapshots::snapshot_slot(&self.project_name, &plan.service, &plan.volume)
            && plan.sandbox_volume == snapshots::compose_volume_name(&self.sandbox_id, &plan.volume)
            && is_snapshot_name(&plan.snapshot)
    }
}

fn is_snapshot_name(name: &str) -> bool {
    name.strip_prefix(SNAPSHOT_PREFIX).is_some_and(|hash| hash.len() == 24 && hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

/// 키 파일을 호스트에서 읽어 스냅샷마다 이름을 만든다. 파일이 없거나 읽을 수 없으면(폴더·권한) 없는 파일로 센다(옛 TS `readFile(...).catch(() => undefined)`).
/// 경로는 `path.join`과 같게 접는다(`node_path::join`)
pub async fn plan_snapshots(scope: &Scope, root: &str, volumes: &[PlanVolume]) -> Vec<Plan> {
    let mut plans = Vec::with_capacity(volumes.len());
    for item in volumes {
        let mut files: Vec<(String, Option<Vec<u8>>)> = Vec::with_capacity(item.key.len());
        for file in &item.key {
            let content = tokio::fs::read(node_path::join(&[root, &item.spec_path, file])).await.ok();
            files.push((file.clone(), content));
        }
        plans.push(Plan {
            service: item.service.clone(),
            volume: item.volume.clone(),
            snapshot: snapshots::snapshot_name(&scope.project_name, &item.service, &item.volume, &files),
            slot: snapshots::snapshot_slot(&scope.project_name, &item.service, &item.volume),
            sandbox_volume: snapshots::compose_volume_name(&scope.sandbox_id, &item.volume),
        });
    }
    plans
}

// ── seed ────────────────────────────────────────────────────────────────

/// seed의 결과. `Seeded`면 볼륨이 채워졌다. 그 밖에는 빈 볼륨으로 평소처럼 설치한다
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedOutcome {
    Missing,
    Seeded { elapsed_ms: u64 },
    Failed { reason: String },
}

/// 스냅샷이 있으면 이 샌드박스의 볼륨을 미리 만들어 채운다. 실패하면 빈 볼륨으로 평소처럼 설치한다.
/// `cancel`은 inspect·create·복사에만 걸린다(지우기는 취소돼도 한다 — 반쯤 만든 볼륨이 남지 않게)
pub async fn seed_snapshot(compose: &ComposeRef, scope: &Scope, plan: &Plan, image: &str, cancel: Option<&Cancel>) -> SeedOutcome {
    if !scope.accepts(plan) {
        return SeedOutcome::Failed { reason: "스냅샷 계획의 이름이 맞지 않습니다".to_owned() };
    }
    if docker(compose, &strings(&["volume", "inspect", &plan.snapshot]), cancel).await.exit_code != 0 {
        return SeedOutcome::Missing;
    }

    let started = Instant::now();
    // compose가 자기 볼륨으로 알아보도록 compose 라벨을 붙인다. 그래야 경고 없이 쓰고 destroy() 때 함께 지운다
    let create = vec![
        "volume".to_owned(),
        "create".to_owned(),
        "--label".to_owned(),
        format!("com.docker.compose.project={}", scope.sandbox_id),
        "--label".to_owned(),
        format!("com.docker.compose.volume={}", plan.volume),
        plan.sandbox_volume.clone(),
    ];
    let created = docker(compose, &create, cancel).await;
    let (copied, from_copy): (ExecOutput, bool) = if created.exit_code == 0 {
        let run = vec![
            "run".to_owned(),
            "--rm".to_owned(),
            "--network".to_owned(),
            "none".to_owned(),
            "--volume".to_owned(),
            format!("{}:/from:ro", plan.snapshot),
            "--volume".to_owned(),
            format!("{}:/to", plan.sandbox_volume),
            image.to_owned(),
            "sh".to_owned(),
            "-c".to_owned(),
            seed_script(),
        ];
        (docker(compose, &run, cancel).await, true)
    } else {
        (created, false)
    };

    if copied.exit_code == 0 {
        return SeedOutcome::Seeded { elapsed_ms: started.elapsed().as_millis() as u64 };
    }

    // 1. 이 샌드박스의 볼륨
    docker(compose, &strings(&["volume", "rm", "--force", &plan.sandbox_volume]), None).await;
    // 2. 끝까지 복사되지 않은 스냅샷은 지워서 이번 기동이 새로 만들게 한다(다른 샌드박스가 쓰는 중이면 지워지지 않는다). 표시 파일이 없다는 뜻은 복사 단계의 3뿐이다
    let incomplete = from_copy && copied.exit_code == EXIT_INCOMPLETE;
    if incomplete {
        docker(compose, &strings(&["volume", "rm", &plan.snapshot]), None).await;
    }
    let stderr = js::trim(&copied.stderr);
    SeedOutcome::Failed {
        reason: if incomplete {
            "스냅샷이 끝까지 저장되지 않았습니다".to_owned()
        } else if stderr.is_empty() {
            format!("exit {}", copied.exit_code)
        } else {
            stderr.to_owned()
        },
    }
}

// ── capture ─────────────────────────────────────────────────────────────

/// capture의 결과. `Existing`은 그사이 다른 세션이 만들어 둔 것을 쓴다는 뜻이다(이벤트도 정리도 없다)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureOutcome {
    Existing,
    Captured { elapsed_ms: u64 },
    /// `message`·`detail`로 TS가 옛 글 그대로의 오류를 만들어 이유를 적는다
    Failed { message: String, detail: String },
}

/// 설치 단계만 끝난 샌드박스 볼륨을 스냅샷 볼륨으로 복사한다. 복사가 실패하면 **그 스냅샷만** `--force`로 지운다.
/// 정리는 하지 않는다(`prune_snapshots`를 이어서 부른다)
pub async fn capture_snapshot(compose: &ComposeRef, scope: &Scope, plan: &Plan, image: &str) -> CaptureOutcome {
    if !scope.accepts(plan) {
        return CaptureOutcome::Failed { message: "스냅샷 계획의 이름이 맞지 않습니다".to_owned(), detail: String::new() };
    }
    let started = Instant::now();
    // 그사이 다른 세션이 만들었으면 그것을 쓴다
    if docker(compose, &strings(&["volume", "inspect", &plan.snapshot]), None).await.exit_code == 0 {
        return CaptureOutcome::Existing;
    }

    let create = vec![
        "volume".to_owned(),
        "create".to_owned(),
        "--label".to_owned(),
        format!("{SNAPSHOT_LABEL}=true"),
        "--label".to_owned(),
        format!("{SNAPSHOT_LABEL}.slot={}", plan.slot),
        plan.snapshot.clone(),
    ];
    let created = docker(compose, &create, None).await;
    if created.exit_code != 0 {
        return CaptureOutcome::Failed { message: "스냅샷 볼륨을 만들지 못했습니다".to_owned(), detail: created.stderr };
    }

    let run = vec![
        "run".to_owned(),
        "--rm".to_owned(),
        "--network".to_owned(),
        "none".to_owned(),
        "--volume".to_owned(),
        format!("{}:/from:ro", plan.sandbox_volume),
        "--volume".to_owned(),
        format!("{}:/to", plan.snapshot),
        image.to_owned(),
        "sh".to_owned(),
        "-c".to_owned(),
        capture_script(),
    ];
    let copied = docker(compose, &run, None).await;
    if copied.exit_code != 0 {
        // 3. 복사가 끝나지 않은 이 스냅샷
        docker(compose, &strings(&["volume", "rm", "--force", &plan.snapshot]), None).await;
        return CaptureOutcome::Failed { message: "스냅샷을 복사하지 못했습니다".to_owned(), detail: copied.stderr };
    }
    CaptureOutcome::Captured { elapsed_ms: started.elapsed().as_millis() as u64 }
}

// ── prune ───────────────────────────────────────────────────────────────

/// 만든 시각 글(`2026-11-12T00:00:00Z` 등)을 JS `Date.parse`와 같게 읽어 ms로 돌려준다(읽을 수 없으면 `NaN`). 읽는 것 자체가 실패하면 `None`이고 정리하지 않는다.
/// Rust에는 JS와 같은 해석(옛 TS와 같은 결과)이 없어 TS가 읽는다. 글 목록을 한 번에 넘기고 같은 길이의 숫자 목록을 받는다
pub type DateParser = Arc<dyn Fn(Vec<String>) -> Pin<Box<dyn Future<Output = Option<Vec<f64>>> + Send>> + Send + Sync>;

/// 정리의 결과. `removed`는 `volume rm`을 부른 이름이다(지워졌는지는 모른다 — 다른 샌드박스가 쓰는 중이면 지워지지 않는다)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PruneOutcome {
    Done { removed: Vec<String> },
    /// 만든 시각을 읽지 못해 정리하지 않았다
    DatesUnknown,
    /// 계획의 이름이 계산값과 다르다
    Refused,
}

/// lockfile이 바뀔 때마다 스냅샷이 쌓이므로 같은 자리에서는 최근 것만 남긴다. 자리는 계획에서 다시 계산한다.
/// 4. 지우는 대상은 라벨 필터 목록 가운데 `snapshots_to_prune`이 고른 것이다(`--force` 없음). 방금 저장한 것과 접두사가 다른 이름은 지우지 않는다
pub async fn prune_snapshots(compose: &ComposeRef, scope: &Scope, plan: &Plan, parse_dates: &DateParser) -> PruneOutcome {
    if !scope.accepts(plan) {
        return PruneOutcome::Refused;
    }
    let listed = docker(compose, &strings(&["volume", "ls", "--quiet", "--filter", &format!("label={SNAPSHOT_LABEL}.slot={}", plan.slot)]), None).await;
    if listed.exit_code != 0 {
        return PruneOutcome::Done { removed: Vec::new() };
    }
    let names: Vec<String> = listed.stdout.split('\n').filter(|name| !name.is_empty()).map(str::to_owned).collect();
    if names.len() as f64 <= SNAPSHOTS_TO_KEEP {
        return PruneOutcome::Done { removed: Vec::new() };
    }
    let mut inspect = strings(&["volume", "inspect", "--format", "{{.Name}} {{.CreatedAt}}"]);
    inspect.extend(names.iter().cloned());
    let inspected = docker(compose, &inspect, None).await;

    // `snapshots_to_prune`이 읽는 줄(`<이름> <시각>`)의 시각 글을 모아 TS가 한 번에 읽게 한다
    let mut texts: Vec<String> = Vec::new();
    for line in inspected.stdout.split('\n') {
        let parts = js::split_ws(line);
        if parts.len() >= 2 && !parts[0].is_empty() && !texts.iter().any(|text| text == parts[1]) {
            texts.push(parts[1].to_owned());
        }
    }
    let Some(values) = parse_dates(texts.clone()).await.filter(|values| values.len() == texts.len()) else { return PruneOutcome::DatesUnknown };
    let lookup = |text: &str| texts.iter().position(|seen| seen == text).map_or(f64::NAN, |at| values[at]);

    let listed_names: HashSet<&str> = names.iter().map(String::as_str).collect();
    let doomed: Vec<String> = snapshots::snapshots_to_prune(&inspected.stdout, SNAPSHOTS_TO_KEEP, &lookup)
        .into_iter()
        .filter(|name| name != &plan.snapshot && listed_names.contains(name.as_str()) && name.starts_with(SNAPSHOT_PREFIX))
        .collect();
    for name in &doomed {
        // 다른 샌드박스가 복사 중인 스냅샷은 지워지지 않고 남는다(--force 없음)
        docker(compose, &strings(&["volume", "rm", name]), None).await;
    }
    PruneOutcome::Done { removed: doomed }
}

// ── 공유 볼륨 ───────────────────────────────────────────────────────────

/// `execChecked`가 던지던 것과 같은 정보. `code`가 `None`이면 출력이 상한을 넘어 멈춘 것이다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedFailure {
    pub command: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// 옛 `execFile`의 기본 `maxBuffer`(스트림마다 1MiB)
const MAX_BUFFER: usize = 1024 * 1024;

/// compose는 external 볼륨을 만들어 주지 않으므로 먼저 만든다. 이미 있으면 그대로 둔다. 모두 동시에 만들고, 하나라도 실패하면 **먼저 끝난 실패**를 돌려준다
/// (옛 `Promise.all`과 같다). 나머지도 끝까지 기다린다 — 옛 TS는 던진 뒤에도 남은 호출이 돌고 있었다. 환경은 상속한다(옛 `execChecked`는 `env`를 주지 않았다)
pub async fn ensure_shared_volumes(docker_bin: &str, names: &[String]) -> Option<SharedFailure> {
    let mut set: JoinSet<Option<SharedFailure>> = JoinSet::new();
    for name in names {
        let bin = docker_bin.to_owned();
        let args = vec!["volume".to_owned(), "create".to_owned(), "--label".to_owned(), "b-studio.cache=true".to_owned(), name.clone()];
        set.spawn(async move {
            let output = run_command_with_limit(&bin, &args, None, None, None, std::future::pending::<()>(), MAX_BUFFER + 1).await;
            let command = std::iter::once(bin.as_str()).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
            // 출력이 상한을 넘으면 종료 코드보다 먼저 그것이 실패다
            if output.stdout.len() > MAX_BUFFER || output.stderr.len() > MAX_BUFFER {
                return Some(SharedFailure { command, code: None, stdout: output.stdout, stderr: output.stderr });
            }
            (output.exit_code != 0).then_some(SharedFailure { command, code: Some(output.exit_code), stdout: output.stdout, stderr: output.stderr })
        });
    }
    let mut first = None;
    while let Some(joined) = set.join_next().await {
        // 태스크가 죽으면(panic) 만들었는지 알 수 없다 — 통과가 아니라 실패다
        let failure = joined.unwrap_or_else(|error| Some(SharedFailure { command: String::new(), code: Some(1), stdout: String::new(), stderr: error.to_string() }));
        if first.is_none() {
            first = failure;
        }
    }
    first
}

// ── stats ───────────────────────────────────────────────────────────────

pub struct StatsInput {
    pub compose: ComposeRef,
    pub override_path: String,
    /// studio.yaml의 managed 서비스 이름
    pub managed: Vec<String>,
    pub edge_service: String,
    /// 사용량 조회(ps·inspect·stats) 전체의 상한(ms)
    pub timeout_ms: f64,
}

/// `Done`은 `merge_usage`의 결과(JS 값 문자열). 실패는 TS가 옛 글 그대로의 오류로 바꾼다(`timed_out`이면 이유는 "응답하지 않았습니다")
#[derive(Debug, Clone, PartialEq)]
pub enum StatsOutcome {
    Done(String),
    /// `compose ps`가 비0으로 끝났다(시크릿을 가리기 전 stderr)
    ListFailed { timed_out: bool, stderr: String },
    InspectFailed { timed_out: bool, stderr: String },
    /// 조회는 끝났는데 상한이 지났다
    TimedOut,
    /// 출력 해석 오류. 옛 TS는 그 글로 `Error`를 던졌다
    Parse(String),
}

/// `compose ps --all --quiet` → `inspect` → 실행 중인 것만 `stats --no-stream`을 상한 시간 안에 읽는다. 상한은 처음부터 잰다(옛 `AbortSignal.timeout`).
/// 목록·inspect를 읽지 못하면 "컨테이너 없음"이 아니라 오류이고, stats만 실패하면 사용량 없이 돌려준다
pub async fn read_stats(input: &StatsInput) -> StatsOutcome {
    let cancel = Arc::new(Cancel::default());
    let limit = if input.timeout_ms.is_finite() && input.timeout_ms > 0.0 { Duration::from_secs_f64(input.timeout_ms / 1000.0) } else { Duration::ZERO };
    let timer = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(limit).await;
            cancel.cancel();
        })
    };
    let outcome = read_stats_within(input, &cancel).await;
    timer.abort();
    outcome
}

async fn read_stats_within(input: &StatsInput, cancel: &Cancel) -> StatsOutcome {
    let compose = &input.compose;
    let list = compose_command(compose, &input.override_path, &strings(&["ps", "--all", "--quiet"]));
    let listed = docker(compose, &list, Some(cancel)).await;
    if listed.exit_code != 0 {
        return StatsOutcome::ListFailed { timed_out: cancel.is_cancelled(), stderr: listed.stderr };
    }
    let ids: Vec<String> = listed.stdout.split('\n').filter(|id| !id.is_empty()).map(str::to_owned).collect();
    if ids.is_empty() {
        return StatsOutcome::Done(js_json::to_native(&JsValue::Arr(Vec::new())));
    }
    let mut inspect = vec!["inspect".to_owned()];
    inspect.extend(ids);
    let inspected = docker(compose, &inspect, Some(cancel)).await;
    if inspected.exit_code != 0 {
        return StatsOutcome::InspectFailed { timed_out: cancel.is_cancelled(), stderr: inspected.stderr };
    }
    let rows = match usage::parse_inspect_output(&inspected.stdout) {
        Ok(rows) => rows,
        Err(message) => return StatsOutcome::Parse(message),
    };

    // docker stats는 CPU 사용률을 재느라 1초 남짓 걸리므로 실행 중인 컨테이너만 묻는다
    let running: Vec<String> = match &rows {
        JsValue::Arr(items) => items
            .iter()
            .filter(|row| matches!(row.prop("state"), Some(JsValue::Str(state)) if state == "running"))
            .filter_map(|row| match row.prop("name") {
                Some(JsValue::Str(name)) => Some(name.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let stats = if running.is_empty() {
        None
    } else {
        let mut args = strings(&["stats", "--no-stream", "--format", "{{json .}}"]);
        args.extend(running);
        Some(docker(compose, &args, Some(cancel)).await)
    };
    if cancel.is_cancelled() {
        return StatsOutcome::TimedOut;
    }
    let stats_rows = match stats.filter(|stats| stats.exit_code == 0) {
        Some(stats) => match usage::parse_stats_output(&stats.stdout) {
            Ok(rows) => JsValue::Arr(rows.iter().map(usage::StatsRow::to_value).collect()),
            Err(message) => return StatsOutcome::Parse(message),
        },
        None => JsValue::Arr(Vec::new()),
    };
    match usage::merge_usage(&rows, &stats_rows, &input.managed, &input.edge_service) {
        Ok(merged) => StatsOutcome::Done(js_json::to_native(&merged)),
        Err(message) => StatsOutcome::Parse(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_docker::Fake;
    use std::fs;

    const IMAGE: &str = "busybox:1.37";

    fn scope() -> Scope {
        Scope { project_name: "proj".into(), sandbox_id: "studio-p".into() }
    }

    fn compose(fake: &Fake) -> ComposeRef {
        ComposeRef { docker_bin: fake.bin(), env: None, project_root: "/p".into(), compose_path: "/p/compose.yaml".into(), project_name: Some("studio-p".into()) }
    }

    fn plan_for(volume: &str) -> Plan {
        let files = vec![("package-lock.json".to_owned(), Some(b"lock-v1".to_vec()))];
        Plan {
            service: "api".into(),
            volume: volume.into(),
            snapshot: snapshots::snapshot_name("proj", "api", volume, &files),
            slot: snapshots::snapshot_slot("proj", "api", volume),
            sandbox_volume: snapshots::compose_volume_name("studio-p", volume),
        }
    }

    /// `2026-11-12T00:00:00Z`꼴만 읽는 시험용 날짜 읽개(진짜는 TS의 `Date.parse`다). 읽을 수 없으면 NaN
    fn iso(texts: Vec<String>) -> Pin<Box<dyn Future<Output = Option<Vec<f64>>> + Send>> {
        Box::pin(async move {
            Some(
                texts
                    .iter()
                    .map(|text| {
                        let digits: String = text.chars().filter(char::is_ascii_digit).collect();
                        digits.parse::<f64>().unwrap_or(f64::NAN)
                    })
                    .collect(),
            )
        })
    }

    fn parser() -> DateParser {
        Arc::new(iso)
    }

    fn rms(fake: &Fake) -> Vec<String> {
        fake.calls().into_iter().filter(|call| call.starts_with("volume rm")).collect()
    }

    // ── 이름 ──

    #[test]
    fn 계획의_이름은_계산한_값과_같을_때만_받는다() {
        let plan = plan_for("nm");
        assert!(scope().accepts(&plan));
        assert!(!scope().accepts(&Plan { slot: "proj/api/other".into(), ..plan.clone() }));
        assert!(!scope().accepts(&Plan { sandbox_volume: "studio-q_nm".into(), ..plan.clone() }));
        assert!(!scope().accepts(&Plan { snapshot: "important-data".into(), ..plan.clone() }));
        assert!(!scope().accepts(&Plan { snapshot: format!("{SNAPSHOT_PREFIX}{}", "A".repeat(24)), ..plan.clone() }));
        assert!(!scope().accepts(&Plan { snapshot: format!("{SNAPSHOT_PREFIX}{}", "a".repeat(23)), ..plan }));
    }

    #[tokio::test]
    async fn 이름이_맞지_않는_계획은_docker를_부르지_않는다() {
        let fake = Fake::new();
        let bad = Plan { snapshot: "my-database-volume".into(), ..plan_for("nm") };
        assert!(matches!(seed_snapshot(&compose(&fake), &scope(), &bad, IMAGE, None).await, SeedOutcome::Failed { .. }));
        assert!(matches!(capture_snapshot(&compose(&fake), &scope(), &bad, IMAGE).await, CaptureOutcome::Failed { .. }));
        assert_eq!(prune_snapshots(&compose(&fake), &scope(), &bad, &parser()).await, PruneOutcome::Refused);
        assert!(fake.calls().is_empty());
    }

    // ── 계획 ──

    #[tokio::test]
    async fn 키_파일을_읽어_이름을_만들고_없는_파일은_없음으로_센다() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("api/sub")).unwrap();
        fs::write(root.join("api/package-lock.json"), "lock-v1").unwrap();
        fs::create_dir_all(root.join("api/dir-as-key")).unwrap();
        let root = root.to_string_lossy().into_owned();
        let volume = |key: &[&str]| PlanVolume { service: "api".into(), volume: "nm".into(), spec_path: "api".into(), key: key.iter().map(|k| (*k).to_owned()).collect() };
        let plans = plan_snapshots(&scope(), &root, &[volume(&["package-lock.json"]), volume(&["./sub/../package-lock.json"]), volume(&["missing.json"]), volume(&["dir-as-key"])]).await;
        assert_eq!(plans[0].snapshot, plan_for("nm").snapshot);
        // 접히는 경로도 같은 파일이지만 이름은 키 글자로 묶인다(경로가 이름에 든다)
        assert_ne!(plans[1].snapshot, plans[0].snapshot);
        let missing = snapshots::snapshot_name("proj", "api", "nm", &[("missing.json".into(), None)]);
        assert_eq!(plans[2].snapshot, missing);
        // 폴더는 읽을 수 없어 없는 파일이다
        assert_eq!(plans[3].snapshot, snapshots::snapshot_name("proj", "api", "nm", &[("dir-as-key".into(), None)]));
        assert_eq!(plans[0].slot, "proj/api/nm");
        assert_eq!(plans[0].sandbox_volume, "studio-p_nm");
    }

    // ── seed ──

    #[tokio::test]
    async fn 스냅샷이_없으면_missing이고_더_부르지_않는다() {
        let fake = Fake::new();
        fake.fail("volume", 1, "no such volume");
        assert_eq!(seed_snapshot(&compose(&fake), &scope(), &plan_for("nm"), IMAGE, None).await, SeedOutcome::Missing);
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn seed가_끝나면_seeded이고_아무것도_지우지_않는다() {
        let fake = Fake::new();
        let plan = plan_for("nm");
        assert!(matches!(seed_snapshot(&compose(&fake), &scope(), &plan, IMAGE, None).await, SeedOutcome::Seeded { .. }));
        // 복사 스크립트 인자에 줄바꿈이 있어 기록은 여러 줄이다
        let calls = fake.calls();
        assert_eq!(calls[0], format!("volume inspect {}", plan.snapshot));
        assert_eq!(calls[1], format!("volume create --label com.docker.compose.project=studio-p --label com.docker.compose.volume=nm {}", plan.sandbox_volume));
        assert_eq!(calls.iter().filter(|call| call.starts_with("volume") || call.starts_with("run ")).count(), 3);
        assert!(calls[2].starts_with(&format!("run --rm --network none --volume {}:/from:ro --volume {}:/to {IMAGE} sh -c ", plan.snapshot, plan.sandbox_volume)));
        assert!(rms(&fake).is_empty());
    }

    #[tokio::test]
    async fn 복사가_3이면_샌드박스_볼륨은_force로_스냅샷은_force_없이_지운다() {
        let fake = Fake::new();
        let plan = plan_for("nm");
        fake.fail("run", 3, "");
        let outcome = seed_snapshot(&compose(&fake), &scope(), &plan, IMAGE, None).await;
        assert_eq!(outcome, SeedOutcome::Failed { reason: "스냅샷이 끝까지 저장되지 않았습니다".into() });
        assert_eq!(rms(&fake), vec![format!("volume rm --force {}", plan.sandbox_volume), format!("volume rm {}", plan.snapshot)]);
    }

    #[tokio::test]
    async fn 복사가_다른_코드로_실패하면_샌드박스_볼륨만_지운다() {
        let fake = Fake::new();
        let plan = plan_for("nm");
        fake.fail("run", 1, "  cp: no space \n");
        assert_eq!(seed_snapshot(&compose(&fake), &scope(), &plan, IMAGE, None).await, SeedOutcome::Failed { reason: "cp: no space".into() });
        assert_eq!(rms(&fake), vec![format!("volume rm --force {}", plan.sandbox_volume)]);

        let fake = Fake::new();
        fake.fail("run", 2, "");
        assert_eq!(seed_snapshot(&compose(&fake), &scope(), &plan, IMAGE, None).await, SeedOutcome::Failed { reason: "exit 2".into() });
    }

    #[tokio::test]
    async fn volume_create의_종료_코드_3은_스냅샷을_지우지_않는다() {
        let fake = Fake::new();
        let plan = plan_for("nm");
        // 호출 순서: 1번 inspect는 통과, 2번 create가 3으로 실패
        fake.hook("volume", 2, "echo 3 > \"$D/volume.2.code\"");
        let outcome = seed_snapshot(&compose(&fake), &scope(), &plan, IMAGE, None).await;
        assert_eq!(outcome, SeedOutcome::Failed { reason: "exit 3".into() });
        assert_eq!(rms(&fake), vec![format!("volume rm --force {}", plan.sandbox_volume)]);
    }

    // ── capture ──

    #[tokio::test]
    async fn 이미_있으면_existing이고_만들지_않는다() {
        let fake = Fake::new();
        assert_eq!(capture_snapshot(&compose(&fake), &scope(), &plan_for("nm"), IMAGE).await, CaptureOutcome::Existing);
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn 저장은_inspect_create_복사_순서이고_복사가_실패하면_그_스냅샷만_force로_지운다() {
        let plan = plan_for("nm");
        let fake = Fake::new();
        // inspect(1번 volume 호출)는 없음, create(2번)는 성공
        fake.hook("volume", 1, "echo 1 > \"$D/volume.1.code\"");
        assert!(matches!(capture_snapshot(&compose(&fake), &scope(), &plan, IMAGE).await, CaptureOutcome::Captured { .. }));
        let calls = fake.calls();
        assert_eq!(calls[1], format!("volume create --label b-studio.snapshot=true --label b-studio.snapshot.slot=proj/api/nm {}", plan.snapshot));
        assert!(calls[2].starts_with(&format!("run --rm --network none --volume {}:/from:ro --volume {}:/to {IMAGE} sh -c ", plan.sandbox_volume, plan.snapshot)));
        assert!(rms(&fake).is_empty());

        let fake = Fake::new();
        fake.hook("volume", 1, "echo 1 > \"$D/volume.1.code\"");
        fake.fail("run", 1, "cp: I/O error\n");
        let outcome = capture_snapshot(&compose(&fake), &scope(), &plan, IMAGE).await;
        assert_eq!(outcome, CaptureOutcome::Failed { message: "스냅샷을 복사하지 못했습니다".into(), detail: "cp: I/O error\n".into() });
        assert_eq!(rms(&fake), vec![format!("volume rm --force {}", plan.snapshot)]);
    }

    // ── prune ──

    fn name(letter: char) -> String {
        format!("{SNAPSHOT_PREFIX}{}", letter.to_string().repeat(24))
    }

    #[tokio::test]
    async fn 정리는_라벨_필터_목록에서_오래된_것을_force_없이_지운다() {
        let plan = plan_for("nm");
        let fake = Fake::new();
        let (a, b) = (name('a'), name('b'));
        fake.hook("volume", 1, &format!("printf '%s\\n' '{}' '{}' '{}' > \"$D/volume.1.out\"", plan.snapshot, a, b));
        fake.hook("volume", 2, &format!("printf '%s\\n' '{} 2026-11-12T00:00:00Z' '{a} 2026-11-01T00:00:00Z' '{b} 2026-11-02T00:00:00Z' > \"$D/volume.2.out\"", plan.snapshot));
        let outcome = prune_snapshots(&compose(&fake), &scope(), &plan, &parser()).await;
        assert_eq!(outcome, PruneOutcome::Done { removed: vec![a.clone()] });
        assert_eq!(fake.calls()[0], "volume ls --quiet --filter label=b-studio.snapshot.slot=proj/api/nm");
        assert_eq!(fake.calls()[1], format!("volume inspect --format {{{{.Name}}}} {{{{.CreatedAt}}}} {} {a} {b}", plan.snapshot));
        assert_eq!(rms(&fake), vec![format!("volume rm {a}")]);
    }

    #[tokio::test]
    async fn 둘_이하이거나_목록을_읽지_못하면_정리하지_않는다() {
        let plan = plan_for("nm");
        let fake = Fake::new();
        fake.set("volume", &format!("{}\n{}\n", plan.snapshot, name('a')));
        assert_eq!(prune_snapshots(&compose(&fake), &scope(), &plan, &parser()).await, PruneOutcome::Done { removed: vec![] });
        assert_eq!(fake.calls().len(), 1);

        let fake = Fake::new();
        fake.fail("volume", 1, "Cannot connect to the Docker daemon");
        fake.set("volume", &format!("{}\n{}\n{}\n", plan.snapshot, name('a'), name('b')));
        assert_eq!(prune_snapshots(&compose(&fake), &scope(), &plan, &parser()).await, PruneOutcome::Done { removed: vec![] });
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn 날짜를_읽지_못하면_정리하지_않는다() {
        let plan = plan_for("nm");
        let fake = Fake::new();
        let (a, b) = (name('a'), name('b'));
        fake.hook("volume", 1, &format!("printf '%s\\n' '{}' '{}' '{}' > \"$D/volume.1.out\"", plan.snapshot, a, b));
        fake.hook("volume", 2, &format!("printf '%s\\n' '{} 2026-11-12T00:00:00Z' '{a} 2026-11-01T00:00:00Z' '{b} 2026-11-02T00:00:00Z' > \"$D/volume.2.out\"", plan.snapshot));
        let failing: DateParser = Arc::new(|_| Box::pin(async { None }));
        assert_eq!(prune_snapshots(&compose(&fake), &scope(), &plan, &failing).await, PruneOutcome::DatesUnknown);
        // 길이가 다른 답도 읽은 것이 아니다(호출 번호가 새로 시작하도록 다시 꾸민다)
        let fake = Fake::new();
        fake.hook("volume", 1, &format!("printf '%s\\n' '{}' '{}' '{}' > \"$D/volume.1.out\"", plan.snapshot, a, b));
        fake.hook("volume", 2, &format!("printf '%s\\n' '{} 2026-11-12T00:00:00Z' '{a} 2026-11-01T00:00:00Z' '{b} 2026-11-02T00:00:00Z' > \"$D/volume.2.out\"", plan.snapshot));
        let short: DateParser = Arc::new(|_| Box::pin(async { Some(vec![1.0]) }));
        assert_eq!(prune_snapshots(&compose(&fake), &scope(), &plan, &short).await, PruneOutcome::DatesUnknown);
        assert!(rms(&fake).is_empty());
    }

    #[tokio::test]
    async fn 정리는_방금_저장한_것과_목록에_없던_이름과_접두사가_다른_이름을_지우지_않는다() {
        let plan = plan_for("nm");
        let fake = Fake::new();
        let (a, b) = (name('a'), name('b'));
        let stranger = name('c');
        fake.hook("volume", 1, &format!("printf '%s\\n' '{}' '{a}' '{b}' > \"$D/volume.1.out\"", plan.snapshot));
        // 방금 저장한 것은 시각을 읽지 못해 0(가장 오래됨), 목록에 없던 이름과 남의 볼륨이 끼어 있다
        fake.hook(
            "volume",
            2,
            &format!("printf '%s\\n' '{} not-a-date' '{a} 2026-11-01T00:00:00Z' '{b} 2026-11-02T00:00:00Z' '{stranger} 2026-10-01T00:00:00Z' 'important-data 2026-09-01T00:00:00Z' > \"$D/volume.2.out\"", plan.snapshot),
        );
        let outcome = prune_snapshots(&compose(&fake), &scope(), &plan, &parser()).await;
        assert_eq!(outcome, PruneOutcome::Done { removed: vec![] });
        assert!(rms(&fake).is_empty());
    }

    #[tokio::test]
    async fn 정리는_라벨이_붙은_남의_볼륨도_접두사가_다르면_지우지_않는다() {
        let plan = plan_for("nm");
        let fake = Fake::new();
        let (a, b) = (name('a'), name('b'));
        // 목록(라벨 필터 결과)에 접두사가 다른 이름이 들어 있고 가장 오래됐다
        fake.hook("volume", 1, &format!("printf '%s\\n' '{}' '{a}' '{b}' 'foreign-volume' > \"$D/volume.1.out\"", plan.snapshot));
        fake.hook(
            "volume",
            2,
            &format!("printf '%s\\n' '{} 2026-11-12T00:00:00Z' '{a} 2026-11-03T00:00:00Z' '{b} 2026-11-02T00:00:00Z' 'foreign-volume 2026-01-01T00:00:00Z' > \"$D/volume.2.out\"", plan.snapshot),
        );
        let outcome = prune_snapshots(&compose(&fake), &scope(), &plan, &parser()).await;
        assert_eq!(outcome, PruneOutcome::Done { removed: vec![b.clone()] });
        assert_eq!(rms(&fake), vec![format!("volume rm {b}")]);
    }

    // ── 공유 볼륨 ──

    #[tokio::test]
    async fn 공유_볼륨은_이름마다_캐시_라벨로_만든다() {
        let fake = Fake::new();
        assert_eq!(ensure_shared_volumes(&fake.bin(), &["b-studio-cache-uv".into(), "shared".into()]).await, None);
        let mut calls = fake.calls();
        calls.sort();
        assert_eq!(calls, vec!["volume create --label b-studio.cache=true b-studio-cache-uv", "volume create --label b-studio.cache=true shared"]);
        // 없으면 부르지 않는다
        let fake = Fake::new();
        assert_eq!(ensure_shared_volumes(&fake.bin(), &[]).await, None);
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 공유_볼륨을_만들지_못하면_실패의_글을_돌려주고_나머지도_끝까지_만든다() {
        let fake = Fake::new();
        fake.fail("volume", 1, "boom\n");
        let failure = ensure_shared_volumes(&fake.bin(), &["a".into(), "b".into()]).await.unwrap();
        assert_eq!(failure.code, Some(1));
        assert_eq!(failure.stderr, "boom\n");
        assert!(failure.command.ends_with("volume create --label b-studio.cache=true a") || failure.command.ends_with("volume create --label b-studio.cache=true b"));
        assert_eq!(fake.calls().len(), 2);
        // docker를 띄우지 못해도 실패다
        let failure = ensure_shared_volumes("/no/such/docker", &["a".into()]).await.unwrap();
        assert_eq!(failure.code, Some(1));
        assert!(failure.stderr.contains("ENOENT"));
    }

    #[tokio::test]
    async fn 공유_볼륨_출력이_상한을_넘으면_종료_코드_없는_실패다() {
        let fake = Fake::new();
        // 종료 코드는 0이어도 출력이 스트림마다 1MiB를 넘으면 실패다(옛 `execFile`의 maxBuffer)
        fs::write(fake.dir.path().join("volume.out"), "x".repeat(MAX_BUFFER + 10)).unwrap();
        let failure = ensure_shared_volumes(&fake.bin(), &["shared".into()]).await.unwrap();
        assert_eq!(failure.code, None);
        assert!(failure.stdout.len() > MAX_BUFFER);
        // 정확히 상한만큼은 넘친 것이 아니다
        let fake = Fake::new();
        fs::write(fake.dir.path().join("volume.out"), "x".repeat(MAX_BUFFER)).unwrap();
        assert_eq!(ensure_shared_volumes(&fake.bin(), &["shared".into()]).await, None);
    }

    // ── stats ──

    fn stats_input(fake: &Fake, timeout_ms: f64) -> StatsInput {
        StatsInput { compose: compose(fake), override_path: "/o/compose.override.yaml".into(), managed: vec!["api".into()], edge_service: "edge".into(), timeout_ms }
    }

    fn container(id: &str, name: &str, service: &str, status: &str) -> String {
        format!(
            r#"{{"Id":"{id}","Name":"/{name}","State":{{"Status":"{status}","ExitCode":0,"OOMKilled":false,"StartedAt":"2026-11-12T01:00:00Z"}},"Config":{{"Labels":{{"com.docker.compose.service":"{service}"}}}},"HostConfig":{{"Memory":0,"NanoCpus":0}},"RestartCount":0}}"#
        )
    }

    #[tokio::test]
    async fn 컨테이너가_없으면_빈_목록이고_ps_인자는_compose_옵션을_앞세운다() {
        let fake = Fake::new();
        assert_eq!(read_stats(&stats_input(&fake, 5_000.0)).await, StatsOutcome::Done("[]".into()));
        assert_eq!(fake.calls(), vec!["compose --project-name studio-p --project-directory /p --file /p/compose.yaml --file /o/compose.override.yaml ps --all --quiet"]);
    }

    #[tokio::test]
    async fn 실행_중인_컨테이너만_stats를_묻는다() {
        let fake = Fake::new();
        fake.set("ps", "aaa\nbbb\n");
        fake.set("inspect", &format!("[{},{}]\n", container("aaa", "studio-p-api-1", "api", "running"), container("bbb", "studio-p-db-1", "db", "exited")));
        let outcome = read_stats(&stats_input(&fake, 5_000.0)).await;
        let StatsOutcome::Done(json) = outcome else { panic!("{outcome:?}") };
        assert!(json.contains("\"role\":\"managed\"") && json.contains("\"role\":\"supporting\""), "{json}");
        let calls = fake.calls();
        assert_eq!(calls[1], "inspect aaa bbb");
        assert_eq!(calls[2], "stats --no-stream --format {{json .}} studio-p-api-1");
    }

    #[tokio::test]
    async fn 목록과_inspect를_읽지_못하면_오류이고_stats만_실패하면_사용량_없이_돌려준다() {
        let fake = Fake::new();
        fake.fail("ps", 1, "daemon down\n");
        assert_eq!(read_stats(&stats_input(&fake, 5_000.0)).await, StatsOutcome::ListFailed { timed_out: false, stderr: "daemon down\n".into() });

        let fake = Fake::new();
        fake.set("ps", "aaa\n");
        fake.fail("inspect", 1, "No such object\n");
        assert_eq!(read_stats(&stats_input(&fake, 5_000.0)).await, StatsOutcome::InspectFailed { timed_out: false, stderr: "No such object\n".into() });

        let fake = Fake::new();
        fake.set("ps", "aaa\n");
        fake.set("inspect", &format!("[{}]\n", container("aaa", "studio-p-api-1", "api", "running")));
        fake.fail("other", 1, "stats unavailable\n");
        assert!(matches!(read_stats(&stats_input(&fake, 5_000.0)).await, StatsOutcome::Done(_)));
    }

    #[tokio::test]
    async fn stats가_비0으로_끝나면_부분_출력이_있어도_쓰지_않는다() {
        let fake = Fake::new();
        fake.set("ps", "aaa\n");
        fake.set("inspect", &format!("[{}]\n", container("aaa", "studio-p-api-1", "api", "running")));
        let line = r#"{"CPUPerc":"12.50%","MemUsage":"43.12MiB / 512MiB","Name":"studio-p-api-1","NetIO":"28.8kB / 23.4kB"}"#;
        fake.set("other", &format!("{line}\n"));
        // 같은 줄이라도 종료 코드가 0이면 쓴다
        let StatsOutcome::Done(json) = read_stats(&stats_input(&fake, 5_000.0)).await else { panic!() };
        assert!(json.contains("cpuPercent"), "{json}");
        // 비0이면 stdout에 줄이 있어도 사용량은 없다
        fake.fail("other", 1, "partial failure\n");
        let StatsOutcome::Done(json) = read_stats(&stats_input(&fake, 5_000.0)).await else { panic!() };
        assert!(!json.contains("cpuPercent"), "{json}");
        assert!(json.contains("\"state\":\"running\""), "{json}");
    }

    #[tokio::test]
    async fn 실행_중이_아닌_컨테이너의_이름은_stats에_넘기지_않는다() {
        let fake = Fake::new();
        fake.set("ps", "aaa\nbbb\n");
        fake.set("inspect", &format!("[{},{}]\n", container("aaa", "studio-p-api-1", "api", "running"), container("bbb", "studio-p-db-1", "db", "exited")));
        read_stats(&stats_input(&fake, 5_000.0)).await;
        let stats_call = fake.calls().into_iter().find(|call| call.starts_with("stats")).unwrap();
        assert!(stats_call.contains("studio-p-api-1") && !stats_call.contains("studio-p-db-1"), "{stats_call}");
    }

    #[tokio::test]
    async fn 상한을_넘기면_시간_초과다() {
        let fake = Fake::new();
        fake.set("ps", "aaa\n");
        fs::write(fake.dir.path().join("ps.sleep"), "5").unwrap();
        assert!(matches!(read_stats(&stats_input(&fake, 200.0)).await, StatsOutcome::ListFailed { timed_out: true, .. }));

        let fake = Fake::new();
        fake.set("ps", "aaa\n");
        fake.set("inspect", &format!("[{}]\n", container("aaa", "studio-p-api-1", "api", "running")));
        fs::write(fake.dir.path().join("other.sleep"), "5").unwrap();
        assert_eq!(read_stats(&stats_input(&fake, 400.0)).await, StatsOutcome::TimedOut);
    }

    #[tokio::test]
    async fn 해석할_수_없는_inspect_출력은_해석_오류다() {
        let fake = Fake::new();
        fake.set("ps", "aaa\n");
        fake.set("inspect", "not json\n");
        assert!(matches!(read_stats(&stats_input(&fake, 5_000.0)).await, StatsOutcome::Parse(_)));
    }
}
