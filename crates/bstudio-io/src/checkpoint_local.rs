//! 체크포인트의 **로컬 경로** — 읽기 전용(`list`·`patch`·`fileAt`·`blobAt`·`listBlobs`·`sessionDiff`·`diffSince`·`commitBefore`·
//! `#checkpoint`·`#changedFiles`·`#changedBeyond`)과 생성 파일 사이드카·되살리기 백업(D1a). 옛 TS는
//! `packages/agent/src/checkpoints.ts`의 같은 이름 메서드와 비공개 `#excluded*`·`#backup*`이다.
//!
//! git을 부르는 코드는 [`crate::checkpoint_remote`]의 [`Repo`]를 그대로 쓴다 — 하드닝·위치 인자·인덱스 잠금 재시도·오류 글·글자 인코딩이
//! 원격 경로와 같아야 하고, 한 벌 더 두면 옛 동작과 갈라진다. 여기서는 **부르는 순서와 파일 I/O**만 정한다.
//!
//! 상태(백업 id와 생성 시각, `#start`·`#subdirCache` 캐시)는 Node가 든다. 백업 id는 TS가 만들어 넘기고, 처음 만든 시각도 TS가 넘긴다 —
//! 옛 코드가 쓰던 `backupSequence`와 `new Date()`를 그대로 이어 가기 위해서다. 스냅샷 폴더 이름(staging)만 Rust가 만든다(사용자에게 보이지 않는다).
//!
//! 경로 규칙:
//! - `excludedFiles`가 돌려준 이름은 받은 자리에서 허용 목록으로 검사한다(`checkpoint_names`). 프로젝트 밖을 가리키는 이름은
//!   그 이름만 빼지 않고 커밋·되돌리기를 멈춘다.
//! - 생성 파일을 프로젝트 폴더에서 읽고 쓰고 지우는 자리는 `workspace_io`의 dirfd·`O_NOFOLLOW`를 쓴다. **경로의 어느 조각이 링크여도
//!   따라가지 않는다** — 링크·비정규 파일·읽는 중 바뀜은 "없음"이 아니라 오류다(옛 코드는 `path.join` 뒤 `readFile`/`writeFile`이라 링크를 따라갔다).
//! - `#applyExcludedDiff`의 제거는 옛 `rm(target, { force: true })`와 같다. 없으면 성공, 폴더면 오류다. 링크는 링크 자리만 지운다.
//! - `#carryForwardExcludedSnapshot`의 복사는 링크를 따라가지 않고 링크로 복사한다(옛 `fs.cp` 기본값과 같은 쪽; 링크 너머를 복사하지 않는다).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use bstudio_guard::checkpoint_git as cg;
use bstudio_guard::js;
use bstudio_guard::js_json::JsValue;
use bstudio_guard::node_path;
use bstudio_guard::workflow;
use serde_json::{json, Map, Value};

use crate::checkpoint_remote::{node_error_message, sort_utf16, trim, Fail, Repo, Res};

const BACKUP_DIRNAME: &str = "b-studio/discarded";
/// 백업은 이 개수를 넘으면 오래된 것부터 지운다. 방금 만든 백업은 이 한도를 넘어도 지우지 않는다
const BACKUP_KEEP_MAX: usize = 10;
/// 백업 전체 용량이 이 값을 넘으면 오래된 것부터 지운다(방금 만든 백업은 예외)
const BACKUP_KEEP_BYTES: u64 = 200 * 1024 * 1024;
/// 체크포인트마다 생성 파일(제외됨) 스냅샷을 이 안에 둔다. 체크포인트 sha별 하위 폴더 하나씩이다
const EXCLUDED_DIRNAME: &str = "b-studio/excluded";
/// 커밋 전에 읽어 둔 생성 파일을 두는 곳. 정리(`prune_excluded_snapshots`)가 체크포인트 스냅샷으로 보지 않게 따로 둔다
const EXCLUDED_STAGING_DIRNAME: &str = "b-studio/excluded-staging";
/// 생성 파일은 작아서(studio.yaml 등 텍스트 몇 개) discard 백업(10개)보다 훨씬 넉넉하게 남겨도 된다
const EXCLUDED_KEEP_MAX: usize = 200;

const WORKFLOW_TRAILER: &str = "Workflow-Passed";
const WORKFLOW_VERIFY_TRAILER: &str = "Workflow-Verify";
const WORKFLOW_INCOMPLETE_TRAILER: &str = "Workflow-Incomplete";

const MAX_PATCH_CHARS: usize = 200_000;
/// git 한 번의 stdout·stderr 상한(바이트). 넘으면 멈추고 던진다
const GIT_MAX_BUFFER: usize = 64 * 1024 * 1024;
/// 샌드박스가 프로젝트 폴더에 만드는 생성물. 사용자 프로젝트의 .gitignore를 건드리지 않고 이 저장소에서만 제외한다
const GENERATED: [&str; 9] = ["node_modules/", ".next/", "build/", ".gradle/", ".venv/", "__pycache__/", "*.tsbuildinfo", "next-env.d.ts", "*.b-studio-relay-*"];
/// 중첩 저장소를 찾을 때의 상한. 닿으면 "확인하지 못함"(fail-closed)이다
const NESTED_LIMIT: usize = 100;

macro_rules! g {
    ($($arg:expr),* $(,)?) => { vec![$(String::from($arg)),*] };
}

fn cat(parts: Vec<Vec<String>>) -> Vec<String> {
    parts.into_iter().flatten().collect()
}

fn fail<T>(message: impl Into<String>) -> Res<T> {
    Err(Fail::Checkpoint(message.into()))
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// napi 입력에서 글자 하나. 없으면 빈 글자(옛 코드는 `undefined`를 `String(undefined)`로 읽지 않고 그 자리에서 실패했다)
fn text(input: &Value, key: &str) -> String {
    input.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn opt_text(input: &Value, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `[키, 값]` 쌍 목록. `null`이면 없다
fn pairs(input: &Value, key: &str) -> Option<Vec<(String, String)>> {
    let items = input.get(key)?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| {
                let pair = item.as_array()?;
                Some((pair.first()?.as_str()?.to_owned(), pair.get(1)?.as_str()?.to_owned()))
            })
            .collect(),
    )
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    match value.and_then(Value::as_array) {
        Some(items) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        None => Vec::new(),
    }
}

fn map_truthy(map: &Map<String, Value>, key: &str) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn string_list(value: Option<&JsValue>) -> Vec<String> {
    match value {
        Some(JsValue::Arr(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        _ => Vec::new(),
    }
}

fn io_fail(error: std::io::Error, op: &str, path: &str) -> Fail {
    let message = match error.raw_os_error() {
        Some(2) => format!("ENOENT: no such file or directory, {op} '{path}'"),
        Some(13) => format!("EACCES: permission denied, {op} '{path}'"),
        Some(20) => format!("ENOTDIR: not a directory, {op} '{path}'"),
        Some(21) => format!("EISDIR: illegal operation on a directory, {op} '{path}'"),
        Some(40) | Some(62) => format!("ELOOP: too many symbolic links encountered, {op} '{path}'"),
        Some(1) => format!("EPERM: operation not permitted, {op} '{path}'"),
        Some(17) => format!("EEXIST: file already exists, {op} '{path}'"),
        Some(28) => format!("ENOSPC: no space left on device, {op} '{path}'"),
        _ => node_error_message(&error, path),
    };
    Fail::Io(message)
}

fn backup_root(repo: &Repo) -> String {
    node_path::join(&[&repo.git_dir_path(), BACKUP_DIRNAME])
}

fn backup_dir(repo: &Repo, id: &str) -> String {
    node_path::join(&[&backup_root(repo), id])
}

fn excluded_root(repo: &Repo) -> String {
    node_path::join(&[&repo.git_dir_path(), EXCLUDED_DIRNAME])
}

fn excluded_dir(repo: &Repo, sha: &str) -> String {
    node_path::join(&[&excluded_root(repo), sha])
}

fn staging_root(repo: &Repo) -> String {
    node_path::join(&[&repo.git_dir_path(), EXCLUDED_STAGING_DIRNAME])
}

/// 커밋 전에 읽어 둔 생성 파일 묶음. `manifest`는 `Record<경로, 있었는가>`, `links`는 `링크 경로 → link:<가리키는 곳>`
struct Staged {
    dir: String,
    manifest: Map<String, Value>,
}

static STAGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// staging 폴더 이름. 옛 코드는 `randomUUID()`를 썼고 이름은 사용자에게 보이지 않는다(만들자마자 지우거나 sha 폴더로 옮긴다)
fn staging_name() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let sequence = STAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:x}-{:x}-{sequence:x}", std::process::id())
}

async fn read_bytes(path: &str) -> Option<Vec<u8>> {
    tokio::fs::read(path).await.ok()
}

async fn read_text(path: &str) -> Option<String> {
    read_bytes(path).await.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// 프로젝트 폴더의 생성 파일 자리 상태. 링크는 대상 글자만 든다(내용을 읽지 않는다)
#[derive(Clone, Debug, PartialEq, Eq)]
enum ExcludedState {
    Missing,
    File(Vec<u8>),
    Link(String),
}

/// 경로의 어느 조각도 링크를 따라가지 않고 자리 상태를 본다(`workspace_io`의 dirfd·`O_NOFOLLOW`).
/// 링크는 `Link(대상)`이고 내용을 읽지 않는다. 폴더·장치·읽는 중 바뀜은 "없음"이 아니라 오류다
fn inspect_excluded(root: &str, file: &str) -> Res<ExcludedState> {
    use crate::workspace_io::{lstat_project_file, read_project_file, readlink_project_file, FileRead, Kind};
    let stat = match lstat_project_file(Path::new(root), file) {
        Ok(stat) => stat,
        Err(failure) if failure.is_missing() => return Ok(ExcludedState::Missing),
        Err(failure) => return Err(Fail::Checkpoint(format!("생성 파일 자리를 확인하지 못했습니다: {file} — {}", failure.code()))),
    };
    match stat.kind {
        Kind::Link => match readlink_project_file(Path::new(root), file) {
            Ok(target) => Ok(ExcludedState::Link(target)),
            Err(failure) => Err(Fail::Checkpoint(format!("생성 파일 링크를 읽지 못했습니다: {file} — {}", failure.code()))),
        },
        Kind::File => match read_project_file(Path::new(root), file, f64::MAX) {
            FileRead::Bytes { content, complete } if complete => Ok(ExcludedState::File(content)),
            FileRead::Bytes { .. } => Err(Fail::Checkpoint(format!("생성 파일을 읽는 동안 바뀌었습니다: {file}"))),
            FileRead::Missing => Err(Fail::Checkpoint(format!("생성 파일이 확인하는 동안 사라졌습니다: {file}"))),
            FileRead::Irregular(reason) => Err(Fail::Checkpoint(format!("생성 파일을 읽지 못했습니다: {file} — {reason}"))),
        },
        Kind::Dir | Kind::Other => Err(Fail::Checkpoint(format!("생성 파일 자리가 일반 파일도 링크도 아닙니다: {file}"))),
    }
}

/// 링크를 `link:<대상>`으로 기록한 값인가
fn manifest_link(manifest: &Map<String, Value>, file: &str) -> Option<String> {
    manifest.get(file)?.as_str()?.strip_prefix("link:").map(str::to_owned)
}

/// 사이드카 스냅샷의 자리 상태. 링크는 기록만 읽고 대상 내용을 읽지 않는다
async fn snapshot_state(manifest: &Map<String, Value>, dir: &str, file: &str) -> Res<ExcludedState> {
    if let Some(target) = manifest_link(manifest, file) {
        return Ok(ExcludedState::Link(target));
    }
    if map_truthy(manifest, file) {
        let path = node_path::join(&[dir, "files", file]);
        match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(ExcludedState::File(bytes)),
            Err(_) => Err(Fail::Checkpoint(format!("생성 파일 스냅샷을 읽지 못했습니다: {file}"))),
        }
    } else {
        Ok(ExcludedState::Missing)
    }
}

/// 프로젝트 폴더의 생성 파일을 쓴다. 부모 폴더는 링크 없이 내려가고 파일은 `O_NOFOLLOW`로 연다
fn write_excluded(root: &str, file: &str, bytes: &[u8], make_dirs: bool) -> Res<()> {
    crate::workspace_io::write_project_file(Path::new(root), file, bytes, make_dirs)
        .map_err(|failure| Fail::Checkpoint(format!("생성 파일을 쓰지 못했습니다: {file} — {}", failure.code())))
}

/// 프로젝트 폴더의 생성 파일을 지운다. 없으면 그대로 성공이다. 부모 폴더는 링크 없이 내려간다
fn remove_excluded(root: &str, file: &str) -> Res<()> {
    match crate::workspace_io::remove_project_file(Path::new(root), file) {
        Ok(()) => Ok(()),
        Err(failure) if failure.is_missing() => Ok(()),
        Err(failure) => Err(Fail::Checkpoint(format!("생성 파일을 지우지 못했습니다: {file} — {}", failure.code()))),
    }
}

/// 프로젝트 폴더의 생성 파일 자리에 링크를 만든다. 부모 폴더는 링크 없이 내려간다. 같은 자리는 부르는 쪽이 먼저 지운다
fn link_excluded(root: &str, file: &str, target: &str) -> Res<()> {
    crate::workspace_io::symlink_project_file(Path::new(root), file, target)
        .map_err(|failure| Fail::Checkpoint(format!("생성 파일 링크를 만들지 못했습니다: {file} — {}", failure.code())))
}

async fn read_manifest(repo: &Repo, sha: &str) -> Option<Map<String, Value>> {
    let text = read_text(&node_path::join(&[&excluded_dir(repo, sha), "manifest.json"])).await?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `fs.rm(path, { recursive: true, force: true })`. 링크는 링크 자리만 지우고 너머를 건드리지 않는다
async fn remove_any(path: &str) -> std::io::Result<()> {
    use std::io::ErrorKind::NotFound;
    match tokio::fs::symlink_metadata(path).await {
        Err(error) if error.kind() == NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(meta) if meta.file_type().is_dir() => match tokio::fs::remove_dir_all(path).await {
            Err(error) if error.kind() == NotFound => Ok(()),
            other => other,
        },
        Ok(_) => match tokio::fs::remove_file(path).await {
            Err(error) if error.kind() == NotFound => Ok(()),
            other => other,
        },
    }
}

/// 스테이징 폴더를 지우고 원래 오류를 돌려준다. 정리에서 난 오류가 원래 오류를 덮어쓴다(옛 코드의 `catch { await rm(...); throw error }`와 같다)
async fn cleanup_staged(dir: &str, original: Fail) -> Fail {
    match remove_any(dir).await {
        Ok(()) => original,
        Err(error) => io_fail(error, "rm", dir),
    }
}

/// `fs.cp(from, to, { recursive: true })`. 링크는 링크로 복사한다(너머를 따라가지 않는다)
fn copy_tree<'a>(from: &'a str, to: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let meta = tokio::fs::symlink_metadata(from).await?;
        if meta.file_type().is_symlink() {
            let target = tokio::fs::read_link(from).await?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, to)?;
            return Ok(());
        }
        if meta.is_dir() {
            tokio::fs::create_dir_all(to).await?;
            let mut entries = tokio::fs::read_dir(from).await?;
            while let Some(entry) = entries.next_entry().await? {
                let name = entry.file_name().to_string_lossy().into_owned();
                copy_tree(&entry.path().to_string_lossy(), &node_path::join(&[to, &name])).await?;
            }
            return Ok(());
        }
        tokio::fs::copy(from, to).await?;
        Ok(())
    })
}

/// 폴더 안의 이름들. 읽지 못하면 빈 목록(옛 `readdir(root).catch(() => [])`)
async fn read_dir_names(path: &str) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(path).await else { return names };
    while let Ok(Some(entry)) = entries.next_entry().await {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    // Node `readdir`(libuv `scandir`)은 바이트 이름순으로 돌려준다. 파일 시스템의 원래 순서를 따르면 옛 구현과 갈린다
    names.sort();
    names
}

/// 파일 시스템에 쓰는 프로젝트 폴더. `subdir`은 git이 낸 글자(인코딩된 꼴)라 파일 이름으로 쓰기 전에 되돌린다
async fn project_root(repo: &mut Repo) -> String {
    let subdir = js::well_formed_from_encoded(&repo.subdir().await);
    if subdir.is_empty() {
        repo.root.clone()
    } else {
        node_path::join(&[&repo.root, &subdir])
    }
}

impl Repo {
    // ── 읽기 ────────────────────────────────────────────────────────────

    /// 커밋 하나의 부모(첫 번째). 없으면 없다(옛 `#firstParent`)
    async fn first_parent(&self, sha: &str) -> Res<Option<String>> {
        let output = self.git(g!["rev-list", "--parents", "-n", "1", sha]).await?;
        Ok(js::trim(&output).split(' ').nth(1).map(str::to_owned))
    }

    /// 저장소 루트 기준 경로를 프로젝트 기준으로 바꾸고, 프로젝트 밖 경로는 뺀다
    async fn from_root(&mut self, files: Vec<String>) -> Vec<String> {
        let subdir = self.subdir().await;
        if subdir.is_empty() {
            return files;
        }
        let prefix = format!("{subdir}/");
        // git이 낸 글자(인코딩된 꼴)를 파일 이름으로 되돌린다. 돌려주는 목록은 TS가 그대로 쓰는 값이다
        files
            .into_iter()
            .filter(|file| file.starts_with(&prefix))
            .map(|file| js::well_formed_from_encoded(&file[prefix.len()..]))
            .collect()
    }

    /// 커밋이 바꾼 파일. 병합 커밋은 첫 번째 부모와 비교한다(옛 `#changedFiles`)
    async fn commit_changed_files(&mut self, sha: &str) -> Res<Vec<String>> {
        let parent = self.first_parent(sha).await?;
        let relative = self.relative().await;
        let output = match parent {
            Some(parent) => self.git(cat(vec![g!["diff", "--name-only", "-z"], relative, g![parent, sha]])).await?,
            None => self.git(cat(vec![g!["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root"], relative, g![sha]])).await?,
        };
        Ok(cg::split_nul(&output))
    }

    /// 커밋이 바꾼 경로 중 `files`(프로젝트 기준)에 드러나지 않는 것의 수(옛 `#changedBeyond`)
    async fn changed_beyond(&mut self, sha: &str, files: &[String]) -> Res<usize> {
        let subdir = self.subdir().await;
        let parent = self.first_parent(sha).await?;
        let output = match parent {
            Some(parent) => self.git(g!["diff", "--no-renames", "--name-only", "-z", parent, sha]).await?,
            None => self.git(g!["diff-tree", "--no-renames", "--no-commit-id", "--name-only", "-r", "-z", "--root", sha]).await?,
        };
        let listed: HashSet<String> = files.iter().map(|file| if subdir.is_empty() { file.clone() } else { format!("{subdir}/{file}") }).collect();
        Ok(output.split('\0').filter(|file| !file.is_empty() && !listed.contains(*file)).count())
    }

    /// 체크포인트 하나(옛 `#checkpoint`). 통과 기록은 b-studio가 만든 커밋(`ours`)에서만 읽는다
    async fn checkpoint(&mut self, reference: &str) -> Res<Value> {
        let format = format!(
            "--format=%H%x00%h%x00%s%x00%cI%x00%ae%x00%(trailers:key={WORKFLOW_TRAILER},valueonly,separator=%x1f)%x00%(trailers:key={WORKFLOW_VERIFY_TRAILER},valueonly,separator=%x1f)%x00%(trailers:key={WORKFLOW_INCOMPLETE_TRAILER},valueonly,separator=%x1f)"
        );
        let output = self.git(g!["show", "-s", format, reference]).await?;
        let author = self.author_email.clone().unwrap_or_default();
        let record = cg::show_record(&output, &author);
        let field = |key: &str| record.prop(key).and_then(JsValue::as_str).unwrap_or_default().to_owned();
        let sha = field("sha");
        let short_sha = field("shortSha");
        let subject = field("subject");
        let created_at = field("createdAt");
        let ours = matches!(record.prop("ours"), Some(JsValue::Bool(true)));
        let trailers = string_list(record.prop("trailers"));
        let verify_trailers = string_list(record.prop("verifyTrailers"));
        let incomplete_trailers = string_list(record.prop("incompleteTrailers"));

        let start = self.start_sha().await?;
        let (message, files) = if sha == start {
            let base = self.get_meta("base").await;
            let files = self.from_root(cg::split_nul(&self.git(g!["ls-tree", "-r", "--name-only", "-z", sha.clone()]).await?)).await;
            (base.map_or_else(|| subject.clone(), |base| format!("세션 시작 ({base} 브랜치)")), files)
        } else {
            (subject.clone(), self.commit_changed_files(&sha).await?)
        };
        let passed = if ours { workflow::parse_workflow_trailer_values(&trailers) } else { None };
        let verify = if ours { workflow::parse_verify_trailer_values(&verify_trailers) } else { None };
        let incomplete = if ours { workflow::parse_incomplete_trailer_values(&incomplete_trailers) } else { None };
        let outside = if verify == Some("docs") { self.changed_beyond(&sha, &files).await? } else { 0 };

        let mut out = Map::new();
        out.insert("sha".into(), json!(sha));
        out.insert("shortSha".into(), json!(short_sha));
        out.insert("message".into(), json!(message));
        out.insert("createdAt".into(), json!(created_at));
        out.insert("files".into(), json!(files));
        if let Some(passed) = passed {
            out.insert("passedStages".into(), json!(passed));
        }
        if let Some(verify) = verify {
            out.insert("verify".into(), json!(verify));
        }
        if let Some(incomplete) = incomplete {
            out.insert("incomplete".into(), json!(incomplete));
        }
        if outside > 0 {
            out.insert("outsideFiles".into(), json!(outside));
        }
        Ok(Value::Object(out))
    }

    /// 최신 체크포인트부터. 복제한 저장소의 이전 기록은 포함하지 않고 세션 시작에서 끝난다(옛 `list`)
    async fn list(&mut self, limit: i64) -> Res<Value> {
        let start = self.start_sha().await?;
        let count = (limit - 1).max(0);
        let output = self.git(g!["log", "--first-parent", format!("-n{count}"), "--format=%H", format!("{start}..HEAD")]).await?;
        let mut shas: Vec<String> = output.split('\n').filter(|sha| !sha.is_empty()).map(str::to_owned).collect();
        shas.push(start);
        let mut out = Vec::with_capacity(shas.len());
        for sha in shas {
            out.push(self.checkpoint(&sha).await?);
        }
        Ok(Value::Array(out))
    }

    /// 체크포인트 하나의 변경(옛 `patch`). `redact`는 자르기 **전에** 부른다(경계에 걸친 시크릿의 앞부분이 남지 않게)
    async fn patch(&mut self, sha: &str) -> Res<Value> {
        let commit = self.resolve(sha).await?;
        let start = self.start_sha().await?;
        if commit == start {
            if let Some(base) = self.get_meta("base").await {
                return Ok(json!(format!("# 세션을 시작한 시점입니다. {base} 브랜치의 커밋이며 이 세션에서 바꾼 내용은 없습니다.\n")));
            }
        }
        // 병합 커밋도 체크포인트 사이의 변경으로 보이도록 첫 번째 부모와 비교한다
        let parent = self.first_parent(&commit).await?;
        let relative = self.relative().await;
        let patch = match parent {
            Some(parent) => self.git(cat(vec![g!["diff", "--no-color"], relative, g![parent, commit]])).await?,
            None => self.git(cat(vec![g!["show", "--format=", "--patch", "--no-color"], relative, g![commit]])).await?,
        };
        let answer = self.hook(json!({ "op": "redact", "text": patch })).await?;
        let redacted = answer.get("text").and_then(Value::as_str).ok_or(Fail::Hook)?;
        // 자르기는 옛 코드와 같이 되돌린 글자에서 하고(짝 없는 서로게이트·예약 글자도 한 단위), 보낼 때 다시 인코딩한다
        Ok(json!(cg::encode_reserved(&cg::cap_text(redacted, MAX_PATCH_CHARS))))
    }

    /// 체크포인트(기본 HEAD)에 커밋된 파일 내용. 그 시점에 파일이 없으면 null(옛 `fileAt`)
    async fn file_at(&mut self, file: &str, reference: &str) -> Res<Value> {
        let subdir = self.subdir().await;
        let target = if subdir.is_empty() { file.to_owned() } else { format!("{subdir}/{file}") };
        let output = self.git(g!["show", format!("{reference}:{target}")]).await.ok();
        Ok(output.map_or(Value::Null, Value::String))
    }

    /// 커밋된 파일의 바이트를 파일 종류까지 보고 꺼낸다(옛 `blobAt`). 내용은 base64로 넘긴다
    async fn blob_at(&mut self, file: &str, reference: &str) -> Res<Value> {
        let subdir = self.subdir().await;
        let target = if subdir.is_empty() { file.to_owned() } else { format!("{subdir}/{file}") };
        let entries = self.git(g!["ls-tree", "-z", reference, "--", target]).await?;
        let Some(entry) = entries.split('\0').find(|entry| !entry.is_empty()) else { return Ok(json!({ "kind": "missing" })) };
        let tab = entry.find('\t');
        let meta = match tab {
            Some(tab) => &entry[..tab],
            None => entry,
        };
        let parts: Vec<&str> = meta.split(' ').collect();
        let mode = parts.first().copied().unwrap_or("");
        let oid = parts.get(2).copied().unwrap_or("");
        if mode == "100644" || mode == "100755" {
            let content = self.run_git_bytes(g!["cat-file", "blob", oid], None).await?;
            return Ok(json!({ "kind": "file", "content": b64(&content), "executable": mode == "100755" }));
        }
        Ok(json!({ "kind": "unsupported", "mode": mode }))
    }

    /// 커밋된 폴더 아래의 일반 파일을 모두 꺼낸다(옛 `listBlobs`). 정렬은 TS가 `localeCompare`로 한다(옛 코드 그대로)
    async fn list_blobs(&mut self, reference: &str, dir: &str) -> Res<Value> {
        let subdir = self.subdir().await;
        let target = if subdir.is_empty() { dir.to_owned() } else { format!("{subdir}/{dir}") };
        let entries = self.git(g!["ls-tree", "-r", "-z", reference, "--", target]).await?;
        let mut blobs = Vec::new();
        for entry in entries.split('\0').filter(|entry| !entry.is_empty()) {
            let Some(tab) = entry.find('\t') else { continue };
            let parts: Vec<&str> = entry[..tab].split(' ').collect();
            let mode = parts.first().copied().unwrap_or("");
            if mode != "100644" && mode != "100755" {
                continue;
            }
            let root_path = &entry[tab + 1..];
            if !subdir.is_empty() && !root_path.starts_with(&format!("{subdir}/")) {
                continue;
            }
            let path = if subdir.is_empty() { root_path.to_owned() } else { root_path[subdir.len() + 1..].to_owned() };
            let oid = parts.get(2).copied().unwrap_or("");
            let content = self.run_git_bytes(g!["cat-file", "blob", oid], None).await?;
            blobs.push(json!({ "path": path, "content": b64(&content), "executable": mode == "100755" }));
        }
        Ok(Value::Array(blobs))
    }

    /// 세션 시작부터 지금 HEAD까지의 전체 변경(옛 `sessionDiff`)
    async fn session_diff(&mut self) -> Res<Value> {
        let start = self.start_sha().await?;
        let relative = self.relative().await;
        Ok(json!(self.git(cat(vec![g!["diff", "--no-color"], relative, g![start, "HEAD"]])).await?))
    }

    /// sha부터 지금 HEAD까지의 변경(옛 `diffSince`)
    async fn diff_since(&mut self, sha: &str) -> Res<Value> {
        let relative = self.relative().await;
        Ok(json!(self.git(cat(vec![g!["diff", "--no-color"], relative, g![sha, "HEAD"]])).await?))
    }

    /// 주어진 시각 이전에 만든 마지막 커밋(옛 `commitBefore`). git이 실패하면 없다
    async fn commit_before(&self, iso: &str) -> Res<Value> {
        let output = self.git(g!["rev-list", "-1", format!("--before={iso}"), "HEAD"]).await.unwrap_or_default();
        let found = js::trim(&output);
        Ok(if found.is_empty() { Value::Null } else { json!(found) })
    }

    // ── 생성 파일 사이드카 ──────────────────────────────────────────────

    /// `excludedFiles` 제공자를 부른다(상태가 TS에 있다).
    /// 이 이름들은 프로젝트 폴더와 `path.join`으로 이어져 읽고 쓴다. 제공자는 공개 옵션이라 프로젝트 밖을 가리키는 이름이
    /// 들어올 수 있으므로 **경계에서 한 번** 검사한다(허용 목록). 하나라도 어기면 그 이름만 빼지 않고 던진다 —
    /// 생성 파일을 확인하지 못한 채 커밋·되돌리기가 통과하면 안 된다
    async fn excluded_files(&self, project_root: &str) -> Res<Vec<String>> {
        let answer = self.hook(json!({ "op": "excludedFiles", "projectRoot": project_root })).await?;
        let files = string_array(answer.get("files"));
        for file in &files {
            if let Some(reason) = crate::checkpoint_names::excluded_name_problem(file) {
                return fail(format!("생성 파일 이름이 올바르지 않습니다: {file:?} — {reason}"));
            }
        }
        Ok(files)
    }

    /// 후보 중 이 저장소가 실제로 무시하는(`git status --ignored`) 파일만(옛 `#ignoredAmong`)
    async fn ignored_among(&mut self, files: &[String]) -> Res<Vec<String>> {
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let subdir = self.subdir().await;
        let scoped: Vec<String> = files.iter().map(|file| if subdir.is_empty() { file.clone() } else { format!("{subdir}/{file}") }).collect();
        // 파일 이름 그대로 읽는다(ADR-218)
        let output = self.run_git_env(
            cat(vec![g!["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--"], scoped]),
            &[("GIT_LITERAL_PATHSPECS", "1")],
        )
        .await?;
        let mut ignored = Vec::new();
        for entry in output.split('\0').filter(|entry| !entry.is_empty()) {
            if !entry.starts_with("!!") {
                continue;
            }
            let file = entry.get(3..).unwrap_or("");
            let relative = if subdir.is_empty() { file } else { file.get(subdir.len() + 1..).unwrap_or("") };
            ignored.push(js::well_formed_from_encoded(relative));
        }
        Ok(ignored)
    }

    /// 읽어 둔 생성 파일 하나의 지문(옛 `#excludedPrint`)
    async fn excluded_print(&self, dir: &str, file: &str, content: Option<&[u8]>, links: &HashMap<String, String>, subdir: &str) -> Res<String> {
        if let Some(link) = links.get(file) {
            return Ok(link.clone());
        }
        if content.is_none() {
            return Ok("missing".to_owned());
        }
        // hash-object도 add처럼 필터를 돈다. 돌기 전에 설정을 본다(이슈 #706)
        self.assert_safe_local_git().await?;
        let path_arg = if subdir.is_empty() { file.to_owned() } else { format!("{subdir}/{file}") };
        let staged_file = node_path::join(&[dir, "files", file]);
        let id = self.git(g!["hash-object", format!("--path={path_arg}"), "--", staged_file]).await?;
        Ok(format!("blob:{}", js::trim(&id)))
    }

    /// 읽어 둔 생성 파일 중 검증과 다른 것(옛 `#excludedMismatch`)
    async fn excluded_mismatch(
        &mut self,
        expected: &[(String, String)],
        dir: &str,
        manifest: &Map<String, Value>,
        links: &HashMap<String, String>,
        base: &str,
    ) -> Res<Vec<String>> {
        let previous = read_manifest(self, base).await;
        let subdir = self.subdir().await;
        let mut files: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for key in manifest.keys() {
            if seen.insert(key.clone()) {
                files.push(key.clone());
            }
        }
        for (key, _) in expected {
            if seen.insert(key.clone()) {
                files.push(key.clone());
            }
        }
        if let Some(previous) = &previous {
            for key in previous.keys() {
                if seen.insert(key.clone()) {
                    files.push(key.clone());
                }
            }
        }
        let mut mismatched = Vec::new();
        for file in files {
            // 옛 코드는 manifest가 참이면 `readFile(...)`을 catch 없이 불렀다. 읽지 못하면 "없다"가 아니라 확인 실패다
            let content = if map_truthy(manifest, &file) {
                let path = node_path::join(&[dir, "files", &file]);
                match tokio::fs::read(&path).await {
                    Ok(bytes) => Some(bytes),
                    Err(error) => return Err(Fail::Io(node_error_message(&error, &path))),
                }
            } else {
                None
            };
            if let Some((_, want)) = expected.iter().find(|(key, _)| *key == file) {
                if self.excluded_print(dir, &file, content.as_deref(), links, &subdir).await? != *want {
                    mismatched.push(file);
                }
                continue;
            }
            let Some(previous) = &previous else { continue };
            let before = snapshot_state(previous, &excluded_dir(self, base), &file).await?;
            let current = if let Some(target) = links.get(&file) {
                ExcludedState::Link(target.clone())
            } else if let Some(content) = &content {
                ExcludedState::File(content.clone())
            } else {
                ExcludedState::Missing
            };
            if current != before {
                mismatched.push(file);
            }
        }
        Ok(sort_utf16(mismatched))
    }

    /// 지금 디스크의 생성 파일을 임시 폴더로 읽어 둔다(옛 `#stageExcludedSnapshot`)
    async fn stage_excluded_snapshot(&mut self, expected: Option<Vec<(String, String)>>, base: Option<String>) -> Res<Staged> {
        let project_root = project_root(self).await;
        let candidates = if self.has_excluded_files { self.excluded_files(&project_root).await? } else { Vec::new() };
        let ignored = self.ignored_among(&candidates).await?;
        let dir = node_path::join(&[&staging_root(self), &staging_name()]);
        let files_dir = node_path::join(&[&dir, "files"]);
        if let Err(error) = tokio::fs::create_dir_all(&files_dir).await {
            return Err(io_fail(error, "mkdir", &files_dir));
        }
        let mut manifest = Map::new();
        let mut links = HashMap::new();
        for file in &ignored {
            let state = match inspect_excluded(&project_root, file) {
                Ok(state) => state,
                Err(error) => return Err(cleanup_staged(&dir, error).await),
            };
            match state {
                // 링크는 `link:<가리키는 곳>`으로 기록하고 내용은 읽지 않는다(git이 링크를 다루는 방식과 같다)
                ExcludedState::Link(target) => {
                    links.insert(file.clone(), format!("link:{target}"));
                    manifest.insert(file.clone(), json!(format!("link:{target}")));
                }
                ExcludedState::File(bytes) => {
                    manifest.insert(file.clone(), json!(true));
                    if let Err(error) = write_excluded(&files_dir, file, &bytes, true) {
                        return Err(cleanup_staged(&dir, error).await);
                    }
                }
                ExcludedState::Missing => {
                    manifest.insert(file.clone(), json!(false));
                }
            }
        }
        if let Some(expected) = &expected {
            let base = match base {
                Some(base) => base,
                None => match self.head_sha().await {
                    Ok(head) => head,
                    Err(error) => return Err(cleanup_staged(&dir, error).await),
                },
            };
            let mismatched = match self.excluded_mismatch(expected, &dir, &manifest, &links, &base).await {
                Ok(mismatched) => mismatched,
                Err(error) => return Err(cleanup_staged(&dir, error).await),
            };
            if !mismatched.is_empty() {
                return Err(cleanup_staged(&dir, Fail::StagedMismatch(mismatched)).await);
            }
        }
        Ok(Staged { dir, manifest })
    }

    /// 읽어 둔 생성 파일을 sha 체크포인트의 스냅샷으로 옮긴다(옛 `#placeExcludedSnapshot`)
    async fn place_excluded_snapshot(&mut self, sha: &str, staged: &Staged) -> Res<()> {
        let target = excluded_dir(self, sha);
        if let Err(error) = remove_any(&target).await {
            return Err(io_fail(error, "rm", &target));
        }
        if staged.manifest.is_empty() {
            if let Err(error) = remove_any(&staged.dir).await {
                return Err(io_fail(error, "rm", &staged.dir));
            }
            return Ok(());
        }
        let manifest = serde_json::to_string(&staged.manifest).map_err(|_| Fail::Checkpoint("생성 파일 목록을 글로 만들지 못했습니다".to_owned()))?;
        let manifest_file = node_path::join(&[&staged.dir, "manifest.json"]);
        if let Err(error) = tokio::fs::write(&manifest_file, manifest).await {
            return Err(io_fail(error, "open", &manifest_file));
        }
        let parent = node_path::dirname(&target);
        if let Err(error) = tokio::fs::create_dir_all(&parent).await {
            return Err(io_fail(error, "mkdir", &parent));
        }
        if let Err(error) = tokio::fs::rename(&staged.dir, &target).await {
            return Err(io_fail(error, "rename", &staged.dir));
        }
        self.prune_excluded_snapshots().await
    }

    /// 지금 체크포인트(sha)의 생성 파일 스냅샷을 남긴다(옛 `refreshExcludedSnapshot`)
    async fn refresh_excluded_snapshot(&mut self, sha: &str, expected: Option<Vec<(String, String)>>) -> Res<Value> {
        if !self.has_excluded_files {
            return Ok(Value::Null);
        }
        let commit = if sha == "HEAD" {
            self.head_sha().await?
        } else {
            self.resolve(sha).await?
        };
        let staged = self.stage_excluded_snapshot(expected, Some(commit.clone())).await?;
        self.place_excluded_snapshot(&commit, &staged).await?;
        Ok(Value::Null)
    }

    /// 부모의 생성 파일 스냅샷을 새 체크포인트로 그대로 옮긴다(지금 디스크를 보지 않는다)
    async fn carry_forward_excluded_snapshot(&self, parent_sha: &str, new_sha: &str) -> Res<Value> {
        if !self.has_excluded_files || parent_sha == new_sha {
            return Ok(Value::Null);
        }
        let from = excluded_dir(self, parent_sha);
        let to = excluded_dir(self, new_sha);
        if let Err(error) = remove_any(&to).await {
            return Err(io_fail(error, "rm", &to));
        }
        let has_parent = tokio::fs::metadata(&from).await.map(|meta| meta.is_dir()).unwrap_or(false);
        if !has_parent {
            return Ok(Value::Null);
        }
        if let Err(error) = copy_tree(&from, &to).await {
            return Err(io_fail(error, "cp", &from));
        }
        Ok(Value::Null)
    }

    /// target 체크포인트의 생성 파일 스냅샷과 지금 디스크를 비교해 바뀐 것만 돌려준다(옛 `#excludedDiff`)
    async fn excluded_diff(&mut self, target: &str) -> Res<Vec<Value>> {
        if !self.has_excluded_files {
            return Ok(Vec::new());
        }
        let project_root = project_root(self).await;
        let candidates = self.excluded_files(&project_root).await?;
        // 대상 체크포인트의 스냅샷이 없으면 그 시점 상태를 모른다. 모르는 것을 "없었다"로 보지 않는다
        let Some(manifest) = read_manifest(self, target).await else { return Ok(Vec::new()) };
        let mut files: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for file in self.ignored_among(&candidates).await? {
            if seen.insert(file.clone()) {
                files.push(file);
            }
        }
        for file in manifest.keys() {
            if seen.insert(file.clone()) {
                files.push(file.clone());
            }
        }
        let files = sort_utf16(files);
        let snapshot = excluded_dir(self, target);
        let mut changes = Vec::new();
        for file in files {
            let current = inspect_excluded(&project_root, &file)?;
            let target_state = snapshot_state(&manifest, &snapshot, &file).await?;
            if current == target_state {
                continue;
            }
            let (before, before_link) = match &current {
                ExcludedState::File(bytes) => (Value::String(b64(bytes)), Value::Null),
                ExcludedState::Link(target) => (Value::Null, Value::String(target.clone())),
                ExcludedState::Missing => (Value::Null, Value::Null),
            };
            let (after, after_link) = match &target_state {
                ExcludedState::File(bytes) => (Value::String(b64(bytes)), Value::Null),
                ExcludedState::Link(target) => (Value::Null, Value::String(target.clone())),
                ExcludedState::Missing => (Value::Null, Value::Null),
            };
            changes.push(json!({
                "file": file,
                "before": before,
                "after": after,
                "beforeLink": before_link,
                "afterLink": after_link,
            }));
        }
        Ok(changes)
    }

    /// `#excludedDiff`가 고른 변경을 실제로 적용한다(없던 파일은 지우고, 있던 파일은 그 내용으로 되돌린다)
    async fn apply_excluded_diff(&mut self, changes: &[Value]) -> Res<Vec<String>> {
        let project_root = project_root(self).await;
        let mut applied = Vec::new();
        for change in changes {
            let file = change.get("file").and_then(Value::as_str).unwrap_or_default().to_owned();
            let current = inspect_excluded(&project_root, &file)?;
            match (change.get("afterLink").and_then(Value::as_str), change.get("after").and_then(Value::as_str)) {
                // 스냅샷이 링크면 지금 자리를 nofollow로 지우고 같은 대상의 링크를 다시 만든다(너머는 건드리지 않는다)
                (Some(target), _) => {
                    if current != ExcludedState::Missing {
                        remove_excluded(&project_root, &file)?;
                    }
                    link_excluded(&project_root, &file, target)?;
                }
                // 스냅샷이 파일인데 지금이 링크면 링크 자체를 지우고 파일을 만든다(링크 너머에 쓰지 않는다)
                (None, Some(encoded)) => {
                    let Some(bytes) = unb64(encoded) else { return fail("생성 파일 내용을 풀지 못했습니다") };
                    if matches!(current, ExcludedState::Link(_)) {
                        remove_excluded(&project_root, &file)?;
                    }
                    write_excluded(&project_root, &file, &bytes, true)?;
                }
                (None, None) => {
                    if current != ExcludedState::Missing {
                        remove_excluded(&project_root, &file)?;
                    }
                }
            }
            applied.push(file);
        }
        Ok(applied)
    }

    /// 체크포인트마다 쌓이는 생성 파일 스냅샷을 `EXCLUDED_KEEP_MAX`개까지만 남긴다(옛 `#pruneExcludedSnapshots`)
    async fn prune_excluded_snapshots(&self) -> Res<()> {
        let root = excluded_root(self);
        let ids = read_dir_names(&root).await;
        if ids.len() <= EXCLUDED_KEEP_MAX {
            return Ok(());
        }
        let mut with_time = Vec::with_capacity(ids.len());
        for id in ids {
            let time = tokio::fs::metadata(node_path::join(&[&root, &id]))
                .await
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_millis() as i64)
                .unwrap_or(0);
            with_time.push((id, time));
        }
        with_time.sort_by_key(|(_, time)| *time);
        let remove = with_time.len() - EXCLUDED_KEEP_MAX;
        for (id, _) in with_time.into_iter().take(remove) {
            let path = node_path::join(&[&root, &id]);
            if let Err(error) = remove_any(&path).await {
                return Err(io_fail(error, "rm", &path));
            }
        }
        Ok(())
    }

    /// 체크포인트 뒤에 생기거나 바뀐 무시된 파일(옛 `ignoredChangedSince`)
    async fn ignored_changed_since(&mut self, sha: &str) -> Res<Value> {
        // 옛 코드는 `Date.parse(git show --format=%cI)/1000`을 썼다. 같은 순간의 초를 `%ct`로 받아 날짜 해석을 피한다
        let output = self.git(g!["show", "-s", "--format=%ct", sha]).await?;
        let Some(since) = js::trim(&output).parse::<i64>().ok() else { return Ok(json!([])) };
        let scope = self.scope().await;
        let output = self.git(cat(vec![g!["status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=normal"], scope])).await?;
        let entries: Vec<String> = output
            .split('\0')
            .filter(|entry| entry.starts_with("!! "))
            .map(|entry| entry[3..].to_owned())
            .filter(|file| !file.ends_with('/'))
            .collect();
        let files = self.from_root(entries).await;
        let project_root = project_root(self).await;
        let excluded: HashSet<String> = if self.has_excluded_files { self.excluded_files(&project_root).await?.into_iter().collect() } else { HashSet::new() };
        let mut changed = Vec::new();
        for file in files {
            if excluded.contains(&file) {
                continue;
            }
            let path = node_path::join(&[&project_root, &file]);
            if let Ok(meta) = tokio::fs::symlink_metadata(&path).await {
                if meta.is_file() {
                    let millis = meta
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|elapsed| elapsed.as_millis() as i64)
                        .unwrap_or(0);
                    if millis / 1000 > since {
                        changed.push(file);
                    }
                }
            }
        }
        Ok(json!(sort_utf16(changed)))
    }

    // ── 되살리기 백업 ───────────────────────────────────────────────────

    /// 인덱스 전체(base 대비)를 되살릴 수 있는 패치로 저장하고 생성 파일의 지금 내용도 함께 담는다(옛 `#backupChanges`)
    async fn backup_changes(&mut self, tracked: &[String], excluded: &[Value], base: &str) -> Res<Value> {
        // --binary로 바이너리 파일도 되살릴 수 있게 하고, 백업은 화면에 보여줄 것이 아니라 캡 없이 전체를 남긴다
        let patch = if tracked.is_empty() {
            String::new()
        } else {
            self.git(cat(vec![g!["diff", "--cached", "--no-color", "--binary", base]])).await?
        };
        if js::trim(&patch).is_empty() && excluded.is_empty() {
            return Ok(Value::Null);
        }
        // 백업 id와 만든 시각은 필요할 때만 TS에서 받는다(옛 코드는 버릴 것이 없으면 `backupId()`를 부르지 않았다)
        let (id, created_at) = self.backup_identity().await?;
        let dir = backup_dir(self, &id);
        if let Err(error) = tokio::fs::create_dir_all(&dir).await {
            return Err(io_fail(error, "mkdir", &dir));
        }
        let mut files: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for file in tracked {
            if seen.insert(file.clone()) {
                files.push(file.clone());
            }
        }
        for change in excluded {
            if let Some(file) = change.get("file").and_then(Value::as_str) {
                if seen.insert(file.to_owned()) {
                    files.push(file.to_owned());
                }
            }
        }
        let files = sort_utf16(files);
        if !js::trim(&patch).is_empty() {
            let target = node_path::join(&[&dir, "changes.patch"]);
            if let Err(error) = tokio::fs::write(&target, patch.as_bytes()).await {
                return Err(io_fail(error, "open", &target));
            }
        }
        if !excluded.is_empty() {
            let mut manifest = Map::new();
            for change in excluded {
                let file = change.get("file").and_then(Value::as_str).unwrap_or_default().to_owned();
                let before = change.get("before").and_then(Value::as_str);
                let before_link = change.get("beforeLink").and_then(Value::as_str);
                // 링크는 대상 글자만 기록하고 너머의 내용은 복사하지 않는다
                if let Some(target) = before_link {
                    manifest.insert(file, json!(format!("link:{target}")));
                    continue;
                }
                manifest.insert(file.clone(), json!(before.is_some()));
                if let Some(encoded) = before {
                    let Some(bytes) = unb64(encoded) else { return fail("생성 파일 내용을 풀지 못했습니다") };
                    write_excluded(&dir, &format!("excluded/{file}"), &bytes, true)?;
                }
            }
            let target = node_path::join(&[&dir, "excluded-manifest.json"]);
            let text = serde_json::to_string(&manifest).map_err(|_| Fail::Checkpoint("생성 파일 목록을 글로 만들지 못했습니다".to_owned()))?;
            if let Err(error) = tokio::fs::write(&target, text).await {
                return Err(io_fail(error, "open", &target));
            }
        }
        let backup = json!({ "id": id, "files": files, "createdAt": created_at });
        let target = node_path::join(&[&dir, "meta.json"]);
        let text = serde_json::to_string(&backup).map_err(|_| Fail::Checkpoint("백업 정보를 글로 만들지 못했습니다".to_owned()))?;
        if let Err(error) = tokio::fs::write(&target, text).await {
            return Err(io_fail(error, "open", &target));
        }
        self.prune_backups(&id).await?;
        Ok(backup)
    }

    /// 백업에 담은 생성 파일을 되살린다. manifest 이름은 백업 폴더가 손으로 바뀔 수 있어 경계에서 다시 검사하고,
    /// 파일 쓰기·지우기·링크 만들기는 프로젝트 폴더에서 nofollow로 한다. 확인하지 못하면 오류다.
    /// 링크는 대상 글자만 기록되어 있으므로 같은 대상의 링크를 다시 만들고, 너머의 내용은 읽거나 쓰지 않는다
    async fn restore_backup_excluded(&mut self, backup_dir: &str) -> Res<Value> {
        let text = match crate::workspace_io::read_project_file(Path::new(backup_dir), "excluded-manifest.json", f64::MAX) {
            crate::workspace_io::FileRead::Missing => return Ok(json!([])),
            crate::workspace_io::FileRead::Bytes { content, complete } if complete => String::from_utf8_lossy(&content).into_owned(),
            crate::workspace_io::FileRead::Bytes { .. } => return fail("백업의 생성 파일 목록을 읽는 동안 바뀌었습니다"),
            crate::workspace_io::FileRead::Irregular(reason) => return fail(format!("백업의 생성 파일 목록을 읽지 못했습니다 — {reason}")),
        };
        let value: Value = serde_json::from_str(&text).map_err(|_| Fail::Checkpoint("백업의 생성 파일 목록을 읽지 못했습니다".to_owned()))?;
        let Value::Object(manifest) = value else {
            return fail("백업의 생성 파일 목록이 객체가 아닙니다");
        };
        let project_root = project_root(self).await;
        let backup_root = Path::new(backup_dir);
        let mut applied = Vec::new();
        for (file, entry) in manifest {
            if let Some(reason) = crate::checkpoint_names::excluded_name_problem(&file) {
                return fail(format!("백업의 생성 파일 이름이 올바르지 않습니다: {file:?} — {reason}"));
            }
            if let Some(target) = entry.as_str().and_then(|text| text.strip_prefix("link:")) {
                remove_excluded(&project_root, &file)?;
                link_excluded(&project_root, &file, target)?;
            } else if entry.as_bool() == Some(true) {
                let relative = format!("excluded/{file}");
                let content = match crate::workspace_io::read_project_file(backup_root, &relative, f64::MAX) {
                    crate::workspace_io::FileRead::Bytes { content, complete } if complete => content,
                    crate::workspace_io::FileRead::Missing => return fail(format!("백업의 생성 파일이 없습니다: {file}")),
                    crate::workspace_io::FileRead::Bytes { .. } => return fail(format!("백업의 생성 파일을 읽는 동안 바뀌었습니다: {file}")),
                    crate::workspace_io::FileRead::Irregular(reason) => return fail(format!("백업의 생성 파일을 읽지 못했습니다: {file} — {reason}")),
                };
                // 스냅샷이 파일인데 지금 자리가 링크면 링크 자체를 지우고 파일을 만든다(너머에 쓰지 않는다)
                if matches!(inspect_excluded(&project_root, &file)?, ExcludedState::Link(_)) {
                    remove_excluded(&project_root, &file)?;
                }
                write_excluded(&project_root, &file, &content, true)?;
            } else if entry.as_bool() == Some(false) {
                remove_excluded(&project_root, &file)?;
            } else {
                return fail(format!("백업의 생성 파일 항목을 읽지 못했습니다: {file}"));
            }
            applied.push(file);
        }
        Ok(json!(applied))
    }

    /// 개수·용량 한도를 넘으면 오래된 백업부터 지운다. 방금 만든 백업(`keep_id`)은 지우지 않는다
    async fn prune_backups(&self, keep_id: &str) -> Res<()> {
        let root = backup_root(self);
        let mut sized = Vec::new();
        for id in sort_utf16(read_dir_names(&root).await) {
            let bytes = tokio::fs::metadata(node_path::join(&[&root, &id, "changes.patch"])).await.map(|meta| meta.len()).unwrap_or(0);
            sized.push((id, bytes));
        }
        let mut total: u64 = sized.iter().map(|(_, bytes)| *bytes).sum();
        let mut count = sized.len();
        for (id, bytes) in sized {
            if id == keep_id {
                continue;
            }
            if count <= BACKUP_KEEP_MAX && total <= BACKUP_KEEP_BYTES {
                break;
            }
            let path = node_path::join(&[&root, &id]);
            if let Err(error) = remove_any(&path).await {
                return Err(io_fail(error, "rm", &path));
            }
            total = total.saturating_sub(bytes);
            count -= 1;
        }
        Ok(())
    }

    /// 지금까지 남은 되살리기 백업(옛 `discardedBackups`). 정렬은 TS가 `id.localeCompare`로 한다
    async fn discarded_backups(&self) -> Res<Value> {
        let root = backup_root(self);
        let mut backups = Vec::new();
        for id in read_dir_names(&root).await {
            let path = node_path::join(&[&root, &id, "meta.json"]);
            if let Some(text) = read_text(&path).await {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    backups.push(value);
                }
            }
        }
        Ok(Value::Array(backups))
    }
}

// ── 쓰기(D1c) ──────────────────────────────────────────────────────────

impl Repo {
    /// 백업 id와 만든 시각은 TS가 정한다(옛 `backupId()`와 `new Date()`를 그대로 잇는다). 버릴 것이 없으면 부르지 않는다
    async fn backup_identity(&self) -> Res<(String, String)> {
        let answer = self.hook(json!({ "op": "backupIdentity" })).await?;
        let id = answer.get("id").and_then(Value::as_str).ok_or(Fail::Hook)?.to_owned();
        let created_at = answer.get("createdAt").and_then(Value::as_str).ok_or(Fail::Hook)?.to_owned();
        Ok((id, created_at))
    }

    /// 마지막 체크포인트 이후 바뀐 파일(프로젝트 기준, 정렬). 중첩 저장소 검사를 겸한다(옛 `pendingFiles`)
    async fn pending_files(&mut self) -> Res<Vec<String>> {
        self.assert_no_nested_repos().await?;
        let scope = self.scope().await;
        let output = self.git(cat(vec![g!["status", "--porcelain=v1", "-z", "--untracked-files=all"], scope])).await?;
        // 판정 함수는 raw 글자를 받는다(옛 TS가 `#git`의 raw 출력을 넘겼다). git 출력은 인코딩된 꼴이므로 되돌린다
        let subdir = dec(&self.subdir().await);
        Ok(sort_utf16(cg::pending_files(&dec(&output), &subdir)))
    }

    /// 사용자 전역 설정(커밋 훅, 서명)이 체크포인트 커밋을 막거나 입력을 기다리며 멈추지 않도록 이 저장소에만 설정한다
    async fn configure(&self) -> Res<()> {
        let hooks = node_path::join(&[&self.git_dir_path(), "b-studio-hooks"]);
        if let Err(error) = tokio::fs::create_dir_all(&hooks).await {
            return Err(io_fail(error, "mkdir", &hooks));
        }
        self.git(g!["config", "core.hooksPath", hooks]).await?;
        self.git(g!["config", "commit.gpgsign", "false"]).await?;
        self.git(g!["config", "user.name", dec(self.author_name.as_deref().unwrap_or(""))]).await?;
        self.git(g!["config", "user.email", dec(self.author_email.as_deref().unwrap_or(""))]).await?;
        self.exclude_generated().await
    }

    async fn exclude_generated(&self) -> Res<()> {
        let file = node_path::join(&[&self.git_dir_path(), "info", "exclude"]);
        let parent = node_path::dirname(&file);
        if let Err(error) = tokio::fs::create_dir_all(&parent).await {
            return Err(io_fail(error, "mkdir", &parent));
        }
        let current = read_text(&file).await.unwrap_or_default();
        let lines: HashSet<&str> = current.split('\n').collect();
        let missing: Vec<&str> = GENERATED.iter().copied().filter(|pattern| !lines.contains(pattern)).collect();
        if missing.is_empty() {
            return Ok(());
        }
        let separator = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
        let text = format!("{separator}# b-studio 샌드박스 생성물\n{}\n", missing.join("\n"));
        use tokio::io::AsyncWriteExt;
        let mut handle = tokio::fs::OpenOptions::new().append(true).create(true).open(&file).await.map_err(|error| io_fail(error, "open", &file))?;
        if let Err(error) = handle.write_all(text.as_bytes()).await {
            return Err(io_fail(error, "write", &file));
        }
        Ok(())
    }

    /// 저장소가 없으면 만들고, 지금 상태를 첫 체크포인트로 남긴다(옛 `init`)
    async fn init(&mut self, message: &str) -> Res<Value> {
        if let Some(dir) = self.git_dir.clone() {
            // 작업 폴더가 다른 저장소(사용자의 저장소) 안에 있어도 그 저장소를 쓰지 않고 따로 만든다
            let exists = tokio::fs::metadata(node_path::join(&[&dir, "HEAD"])).await.is_ok();
            if !exists {
                let parent = node_path::dirname(&dir);
                if let Err(error) = tokio::fs::create_dir_all(&parent).await {
                    return Err(io_fail(error, "mkdir", &parent));
                }
                self.git(g!["init", "-q", "-b", "main"]).await?;
            }
        } else {
            let toplevel = match self.git(g!["rev-parse", "--show-toplevel"]).await {
                Ok(output) => Some(resolve_real(&js::trim(&output)).await),
                Err(_) => None,
            };
            if toplevel.as_deref() != Some(resolve_real(&self.root).await.as_str()) {
                self.git(g!["init", "-q", "-b", "main"]).await?;
            }
        }

        self.configure().await?;
        self.assert_no_nested_repos().await?;
        self.git(g!["add", "-A"]).await?;
        self.git(g!["commit", "-q", "--allow-empty", "-m", cg::one_line(message)]).await?;
        let head = trim(&self.git(g!["rev-parse", "HEAD"]).await?);
        if self.get_meta("start").await.is_none() {
            self.set_meta("start", &head).await?;
        }
        let checkpoint = self.checkpoint(&head).await?;
        let sha = checkpoint.get("sha").and_then(Value::as_str).unwrap_or("").to_owned();
        self.refresh_excluded_snapshot(&sha, None).await?;
        Ok(checkpoint)
    }

    /// expectedHead를 주면 지금 HEAD가 그것과 같은지 보고, 그 sha(주지 않았으면 지금 HEAD)를 돌려준다(이슈 #706)
    async fn expect_head(&self, expected: Option<&str>) -> Res<String> {
        let head = trim(&self.git(g!["rev-parse", "--verify", "HEAD^{commit}"]).await?);
        if let Some(expected) = expected {
            if head != expected {
                return Err(Fail::HeadMoved { expected: expected.to_owned(), actual: head });
            }
        }
        Ok(head)
    }

    /// 스테이징된 변경이 기대한 지문과 다른 파일들(옛 `#stagedMismatch`). 기대는 TS가 encode한 꼴이고 결과도 그 꼴이다
    async fn staged_mismatch(&mut self, expected: &[(String, String)]) -> Res<Vec<String>> {
        let scope = self.scope().await;
        let staged = self.git(cat(vec![g!["diff", "--cached", "--name-only", "--no-renames", "-z"], scope.clone()])).await?;
        let index = self.git(cat(vec![g!["ls-files", "--stage", "-z"], scope])).await?;
        // 판정 함수는 raw git 출력·raw subdir을 받고 기대(TS가 encode한 것)만 인코딩된 꼴로 받는다
        let subdir = dec(&self.subdir().await);
        let keys: Vec<String> = expected.iter().map(|(key, _)| key.clone()).collect();
        let values: Vec<String> = expected.iter().map(|(_, value)| value.clone()).collect();
        Ok(cg::staged_mismatch(&dec(&index), &dec(&staged), &subdir, &keys, &values))
    }

    /// TS `sandbox.findSecrets`(콜백). 글자는 인코딩해 넘겨 짝 없는 서로게이트가 경계에서 바뀌지 않게 한다
    async fn find_secrets(&self, text: &str) -> Res<Vec<String>> {
        let answer = self.hook(json!({ "op": "findSecrets", "text": cg::encode_reserved(text) })).await?;
        Ok(string_array(answer.get("secrets")))
    }

    /// "파일 (시크릿 이름)" 목록. 값은 담지 않는다(옛 `#secretLeaks`)
    async fn secret_leaks(&mut self, files: &[String], text: &str, has_find_secrets: bool) -> Res<Vec<String>> {
        if !has_find_secrets {
            return Ok(Vec::new());
        }
        let mut leaks = Vec::new();
        let in_text = self.find_secrets(text).await?;
        if !in_text.is_empty() {
            leaks.push(format!("커밋 메시지 ({})", in_text.join(", ")));
        }
        let project_root = project_root(self).await;
        for file in files {
            // 옛 코드는 읽지 못한 파일을 건너뛰었다(검사는 하되 그 파일의 내용으로 막지 않는다)
            let content = read_text(&node_path::join(&[&project_root, file])).await;
            let found = match content {
                Some(content) => self.find_secrets(&content).await?,
                None => Vec::new(),
            };
            if !found.is_empty() {
                leaks.push(format!("{file} ({})", found.join(", ")));
            }
        }
        Ok(leaks)
    }

    /// 트리와 부모를 정해 커밋을 만들고, HEAD가 아직 그 부모일 때만 HEAD를 옮긴다(이슈 #706, 옛 `#commitTree`)
    async fn commit_tree(&self, tree: &str, parent: &str, message: &str, allow_empty: bool) -> Res<String> {
        if !allow_empty {
            let parent_tree = trim(&self.git(g!["rev-parse", format!("{parent}^{{tree}}")]).await?);
            if tree == parent_tree {
                return fail("git commit 실패: 커밋할 변경이 없습니다");
            }
        }
        let sha = trim(&self.git(g!["commit-tree", tree, "-p", parent, "-m", message]).await?);
        let reflog = format!("commit: {}", message.split('\n').next().unwrap_or(""));
        match self.git(g!["update-ref", "-m", reflog, "HEAD", &sha, parent]).await {
            Ok(_) => Ok(sha),
            Err(error) => {
                let head = trim(&self.git(g!["rev-parse", "--verify", "HEAD"]).await.unwrap_or_default());
                if head != parent {
                    return Err(Fail::HeadMoved { expected: parent.to_owned(), actual: head });
                }
                Err(error)
            }
        }
    }

    /// 바뀐 파일이 있으면 체크포인트로 남긴다(옛 `commit`)
    async fn commit(&mut self, input: &Value) -> Res<Value> {
        let message = text(input, "message");
        let body = opt_text(input, "body");
        let allow_empty = input.get("allowEmpty").and_then(Value::as_bool).unwrap_or(false);
        let trailers = string_array(input.get("trailers"));
        let expect_staged = pairs(input, "expectStaged");
        let expect_excluded = pairs(input, "expectExcluded");
        let expected_head = opt_text(input, "expectedHead");
        let has_find_secrets = input.get("hasFindSecrets").and_then(Value::as_bool).unwrap_or(false);
        let has_on_committed = input.get("hasOnCommitted").and_then(Value::as_bool).unwrap_or(false);

        let pending = self.pending_files().await?; // pendingFiles가 중첩 저장소 검사를 겸한다
        if !allow_empty && pending.is_empty() {
            return Ok(Value::Null);
        }
        // 부모는 스테이징하기 전에 정한다. 그 뒤에 끼어든 커밋은 HEAD를 옮길 때 걸린다
        let parent = self.expect_head(expected_head.as_deref()).await?;
        // 마지막 방어선(ADR-131): 코드 변경이 있는데 "통과한 단계 없음" 트레일러면 남기지 않는다
        let code_files: Vec<String> = pending.iter().filter(|file| !workflow::is_doc_checkpoint_path(file)).cloned().collect();
        if !code_files.is_empty() && workflow::has_empty_passed_trailer(&trailers) && !workflow::has_docs_verify_trailer(&trailers) {
            return fail(format!("검증 게이트를 거치지 않은 코드 변경이 있어 체크포인트를 남기지 않았습니다: {}", code_files.iter().take(20).cloned().collect::<Vec<_>>().join(", ")));
        }
        // 검증 게이트는 에이전트 도구로 쓴 파일만 보지만, 커밋은 명령이 만든 파일까지 담는다. 올리기 전 마지막으로 막는다
        if has_find_secrets {
            let leaks = self.secret_leaks(&pending, &format!("{message}\n{}", body.clone().unwrap_or_default()), true).await?;
            if !leaks.is_empty() {
                return fail(format!("시크릿 값이 들어 있어 체크포인트를 남기지 않았습니다: {}", leaks.join(", ")));
            }
        }
        // add는 저장소 설정의 필터를 돈다. 돌기 전에 설정을 본다(이슈 #706)
        self.assert_safe_local_git().await?;
        let scope = self.scope().await;
        self.git(cat(vec![g!["add", "-A"], scope.clone()])).await?;
        // 커밋되는 인덱스를 기준으로 표시(skip-worktree·assume-unchanged)가 걸린 항목이 HEAD나 작업 폴더와 다르면 멈춘다(이슈 #1444). TS의 사전 검사와 이 자리 사이에 표시를 건 경우도 닫는다
        if let Err(error) = self.assert_no_hidden_index_entries().await {
            let _ = self.git(cat(vec![g!["reset", "-q"], scope.clone()])).await;
            return Err(error);
        }
        if let Some(expected) = &expect_staged {
            let mismatched = match self.staged_mismatch(expected).await {
                Ok(mismatched) => mismatched,
                Err(error) => {
                    let _ = self.git(cat(vec![g!["reset", "-q"], scope.clone()])).await;
                    return Err(error);
                }
            };
            if !mismatched.is_empty() {
                let _ = self.git(cat(vec![g!["reset", "-q"], scope.clone()])).await;
                return Err(Fail::StagedMismatch(mismatched));
            }
        }
        let mut excluded: Option<Staged> = None;
        if let Some(expected) = &expect_excluded {
            match self.stage_excluded_snapshot(Some(expected.clone()), None).await {
                Ok(staged) => excluded = Some(staged),
                Err(error) => {
                    let _ = self.git(cat(vec![g!["reset", "-q"], scope.clone()])).await;
                    return Err(error);
                }
            }
        }
        let text_body = body.as_deref().map(|value| js::trim(value).to_owned());
        let tree = trim(&self.git(g!["write-tree"]).await?);
        let message_text = cg::commit_message(&message, text_body.as_deref(), &trailers);
        let sha = match self.commit_tree(&tree, &parent, &message_text, allow_empty).await {
            Ok(sha) => sha,
            Err(error) => {
                let _ = self.git(cat(vec![g!["reset", "-q"], scope])).await;
                // 옛 코드는 이 정리에서 난 오류가 원래 오류를 덮어쓰게 두었다
                if let Some(staged) = &excluded {
                    if let Err(remove) = remove_any(&staged.dir).await {
                        return Err(io_fail(remove, "rm", &staged.dir));
                    }
                }
                return Err(error);
            }
        };
        if has_on_committed {
            self.hook(json!({ "op": "onCommitted", "sha": sha })).await?;
        }
        let checkpoint = self.checkpoint(&sha).await?;
        let checkpoint_sha = checkpoint.get("sha").and_then(Value::as_str).unwrap_or("").to_owned();
        if let Some(staged) = &excluded {
            self.place_excluded_snapshot(&checkpoint_sha, staged).await?;
        } else {
            self.refresh_excluded_snapshot(&checkpoint_sha, None).await?;
        }
        Ok(checkpoint)
    }

    /// `add -A` 뒤 진짜 인덱스에서 `skip-worktree`·`assume-unchanged` 표시가 걸린 항목을 찾아, 커밋이 담을 내용(인덱스)이 HEAD와 다르거나
    /// 작업 폴더가 인덱스와 다르면(add가 읽지 않은 변경) 던진다. 막는 검사라 읽지 못한 것·일반 파일이 아닌 것도 통과가 아니다(fail-closed).
    /// sparse-checkout의 예외는 없다: `core.sparseCheckout`은 에이전트가 켤 수 있는 설정이다(ADR-236)
    async fn assert_no_hidden_index_entries(&mut self) -> Res<()> {
        let scope = self.scope().await;
        let listing = dec(&self.git(cat(vec![g!["ls-files", "-v", "-z"], scope])).await?);
        let flagged = parse_flagged_entries(&listing)?;
        if flagged.is_empty() {
            return Ok(());
        }
        let literal = [("GIT_LITERAL_PATHSPECS", "1")];
        let mut hidden: Vec<String> = Vec::new();
        for chunk in flagged.chunks(200) {
            let changed = self.run_git_env(cat(vec![g!["diff-index", "--cached", "--name-only", "-z", "HEAD", "--"], chunk.to_vec()]), &literal).await?;
            hidden.extend(cg::split_nul(&changed).into_iter().map(|file| dec(&file)));
            // 인덱스 항목(add가 방금 다시 읽지 않았다)의 blob과 작업 폴더의 파일을 견준다. 없는 것·일반 파일이 아닌 것은 지운/바꾼 것으로 센다
            let staged = dec(&self.run_git_env(cat(vec![g!["ls-files", "--stage", "-z", "--"], chunk.to_vec()]), &literal).await?);
            let mut regular: Vec<(String, String, bool)> = Vec::new();
            // 표시가 걸린 경로마다 인덱스 항목이 돌아왔는지 본다. 항목 수·이름이 맞지 않으면 어느 것도 믿지 않는다(파서 불일치로 열리지 않게)
            check_stage_covers(chunk, &staged)?;
            for entry in staged.split('\0').filter(|part| !part.is_empty()) {
                let Some((head, file)) = entry.split_once('\t') else { return fail("인덱스 항목을 읽지 못해 표시가 걸린 파일을 확인하지 못했습니다") };
                let mut fields = head.split(' ');
                let (mode, id) = (fields.next().unwrap_or(""), fields.next().unwrap_or(""));
                match tokio::fs::symlink_metadata(node_path::join(&[&self.root, file])).await {
                    Ok(meta) if meta.is_file() && (mode == "100644" || mode == "100755") => {
                        #[cfg(unix)]
                        let exec = {
                            use std::os::unix::fs::PermissionsExt;
                            meta.permissions().mode() & 0o111 != 0
                        };
                        #[cfg(not(unix))]
                        let exec = mode == "100755";
                        if exec != (mode == "100755") {
                            hidden.push(file.to_owned());
                        } else {
                            regular.push((file.to_owned(), id.to_owned(), exec));
                        }
                    }
                    _ => hidden.push(file.to_owned()),
                }
            }
            if !regular.is_empty() {
                let paths: Vec<String> = regular.iter().map(|(file, _, _)| file.clone()).collect();
                let ids = self.run_git_env(cat(vec![g!["hash-object", "--"], paths]), &literal).await?;
                let ids: Vec<&str> = ids.lines().collect();
                if ids.len() != regular.len() {
                    return fail("표시가 걸린 파일의 지문을 읽는 동안 작업 복사본이 바뀌었습니다");
                }
                for ((file, id, _), now) in regular.iter().zip(ids) {
                    if id != now {
                        hidden.push(file.clone());
                    }
                }
            }
        }
        if hidden.is_empty() {
            return Ok(());
        }
        hidden.sort();
        hidden.dedup();
        let shown = hidden.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        fail(format!(
            "인덱스 표시(skip-worktree·assume-unchanged)가 걸린 파일이 HEAD나 작업 폴더와 달라 체크포인트를 남기지 않았습니다({shown}{}). 표시를 지운 뒤 다시 시도하세요: git update-index --no-skip-worktree --no-assume-unchanged -- <파일>",
            if hidden.len() > 5 { " 등" } else { "" }
        ))
    }

    /// 지정한 경로만 범위로 체크포인트를 남긴다(옛 `commitPaths`)
    async fn commit_paths(&mut self, input: &Value) -> Res<Value> {
        let paths = string_array(input.get("paths"));
        if paths.is_empty() {
            return Ok(Value::Null);
        }
        let message = text(input, "message");
        let body = opt_text(input, "body");
        let trailers = string_array(input.get("trailers"));
        let expected_head = opt_text(input, "expectedHead");
        let has_find_secrets = input.get("hasFindSecrets").and_then(Value::as_bool).unwrap_or(false);
        let temp_id = text(input, "tempIndexId");

        let subdir = dec(&self.subdir().await);
        let scoped: Vec<String> = paths.iter().map(|file| if subdir.is_empty() { file.clone() } else { format!("{subdir}/{file}") }).collect();
        // 경로는 파일 이름 그대로다(git이 glob·pathspec 매직으로 읽지 않게 한다, ADR-218)
        let literal = [("GIT_LITERAL_PATHSPECS", "1")];
        let changed = cg::split_nul(
            &self.run_git_env(cat(vec![g!["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"], scoped.clone()]), &literal).await?,
        );
        if changed.is_empty() {
            return Ok(Value::Null);
        }
        if has_find_secrets {
            let leaks = self.secret_leaks(&paths, &format!("{message}\n{}", body.clone().unwrap_or_default()), true).await?;
            if !leaks.is_empty() {
                return fail(format!("시크릿 값이 들어 있어 체크포인트를 남기지 않았습니다: {}", leaks.join(", ")));
            }
        }
        let parent = self.expect_head(expected_head.as_deref()).await?;
        self.assert_safe_local_git().await?;
        // 부모의 트리에 이 경로들만 얹은 트리를 따로 만든다. 진짜 인덱스의 다른 스테이징은 건드리지 않는다
        let git_dir = trim(&self.git(g!["rev-parse", "--absolute-git-dir"]).await?);
        let index = node_path::join(&[&git_dir, &format!("b-studio-index-{}-{temp_id}", std::process::id())]);
        let index_env = [("GIT_INDEX_FILE", index.as_str()), ("GIT_LITERAL_PATHSPECS", "1")];
        let built: Res<String> = async {
            self.run_git_env(g!["read-tree", &parent], &index_env).await?;
            self.run_git_env(cat(vec![g!["add", "-A", "--"], scoped.clone()]), &index_env).await?;
            Ok(trim(&self.run_git_env(g!["write-tree"], &index_env).await?))
        }
        .await;
        // `finally` — 정리에서 난 오류가 결과를 덮어쓴다(옛 코드와 같다)
        let remove_error = match tokio::fs::remove_file(&index).await {
            Ok(()) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => Some(io_fail(error, "rm", &index)),
        };
        if let Some(error) = remove_error {
            return Err(error);
        }
        let tree = built?;
        // 만든 트리가 부모와 다른 경로는 넘긴 경로뿐이어야 한다. 하나라도 범위 밖이면 커밋하지 않는다
        let allowed: HashSet<String> = scoped.iter().cloned().collect();
        let touched: Vec<String> = cg::split_nul(&self.git(g!["diff-tree", "-r", "--no-renames", "--name-only", "-z", &parent, &tree]).await?).into_iter().map(|file| dec(&file)).collect();
        let outside: Vec<String> = touched.into_iter().filter(|file| !allowed.contains(file)).collect();
        if !outside.is_empty() {
            return fail(format!("지정한 경로 밖의 파일이 함께 담겨 체크포인트를 남기지 않았습니다: {}", outside.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
        }
        self.run_git_env(cat(vec![g!["add", "-A", "--"], scoped]), &literal).await?;
        let text_body = body.as_deref().map(|value| js::trim(value).to_owned());
        let message_text = cg::commit_message(&message, text_body.as_deref(), &trailers);
        let sha = self.commit_tree(&tree, &parent, &message_text, false).await?;
        let checkpoint = self.checkpoint(&sha).await?;
        let checkpoint_sha = checkpoint.get("sha").and_then(Value::as_str).unwrap_or("").to_owned();
        // 범위를 좁힌 커밋이라 생성 파일은 바꾸지 않았다 — 부모의 스냅샷을 그대로 물려받는다
        self.carry_forward_excluded_snapshot(&parent, &checkpoint_sha).await?;
        Ok(checkpoint)
    }

    /// 마지막 체크포인트 이후의 변경을 버린다(옛 `discard`)
    async fn discard(&mut self) -> Res<Value> {
        let files = self.pending_files().await?;
        let head = self.head_sha().await?;
        let excluded = self.excluded_diff(&head).await?;
        if files.is_empty() && excluded.is_empty() {
            return Ok(json!({ "files": files, "patch": "" }));
        }
        let scope = self.scope().await;
        let mut patch = String::new();
        if !files.is_empty() {
            self.git(cat(vec![g!["add", "-A"], scope.clone()])).await?;
            let relative = self.relative().await;
            patch = self.git(cat(vec![g!["diff", "--cached", "--no-color"], relative, g!["HEAD"]])).await?;
        }
        let backup = self.backup_changes(&files, &excluded, "HEAD").await?;
        if !files.is_empty() {
            self.git(g!["reset", "-q", "--hard", "HEAD"]).await?;
            self.git(cat(vec![g!["clean", "-q", "-fd"], scope])).await?;
        }
        let reverted = self.apply_excluded_diff(&excluded).await?;
        let mut merged: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for file in files.into_iter().chain(reverted) {
            if seen.insert(file.clone()) {
                merged.push(file);
            }
        }
        Ok(json!({ "files": sort_utf16(merged), "patch": cg::cap_text(&patch, MAX_PATCH_CHARS), "backup": backup }))
    }

    /// 이 세션 기록에 있는 체크포인트로 되돌린다(옛 `restore`)
    async fn restore(&mut self, sha: &str) -> Res<Value> {
        let commit = self.resolve(sha).await?;
        let start = self.start_sha().await?;
        let in_session = self.is_ancestor(&start, &commit).await && self.is_ancestor(&commit, "HEAD").await;
        if !in_session {
            return fail("현재 세션 기록에 없는 체크포인트입니다");
        }
        let scope = self.scope().await;
        let pending = self.pending_files().await?;
        let relative = self.relative().await;
        let committed: Vec<String> = cg::split_nul(&self.git(cat(vec![g!["diff", "--name-only", "-z"], relative, g![&commit, "HEAD"]])).await?).into_iter().map(|file| dec(&file)).collect();
        let excluded = self.excluded_diff(&commit).await?;
        self.git(cat(vec![g!["add", "-A"], scope.clone()])).await?;
        let backup = self.backup_changes(&pending, &excluded, "HEAD").await?;
        self.git(g!["reset", "-q", "--hard", &commit]).await?;
        self.git(cat(vec![g!["clean", "-q", "-fd"], scope])).await?;
        let reverted = self.apply_excluded_diff(&excluded).await?;
        let mut merged: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for file in pending.into_iter().chain(committed).chain(reverted) {
            if seen.insert(file.clone()) {
                merged.push(file);
            }
        }
        Ok(json!({ "checkpoint": self.checkpoint(&commit).await?, "files": sort_utf16(merged), "backup": backup }))
    }
}

// ── 걷기(D1c) ──────────────────────────────────────────────────────────

enum Partition<'a> {
    Repo(&'a Repo),
    Hook(&'a crate::checkpoint_remote::Hook),
}

impl Partition<'_> {
    async fn ignored(&self, dirs: Vec<String>) -> Res<HashSet<String>> {
        match self {
            Partition::Repo(repo) => repo.ignored_dirs(&dirs).await,
            Partition::Hook(hook) => {
                let answer = hook(json!({ "op": "partitionIgnored", "dirs": dirs }).to_string()).await.ok_or(Fail::Hook)?;
                let value: Value = serde_json::from_str(&answer).map_err(|_| Fail::Hook)?;
                if value.get("ok") != Some(&Value::Bool(true)) {
                    return Err(Fail::Hook);
                }
                Ok(string_array(value.get("ignored")).into_iter().collect())
            }
        }
    }
}

/// 작업 폴더를 걸으며 최상위 저장소가 아니고 git이 무시하지도 않는 `.git`을 모은다(fail-closed용. 옛 `findNestedGitRepos`)
fn walk_repos<'a>(
    base: &'a str,
    root: &'a str,
    top: Option<&'a str>,
    limit: usize,
    partition: &'a Partition<'a>,
    found: &'a mut Vec<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Res<()>> + Send + 'a>> {
    Box::pin(async move {
        if found.len() >= limit {
            return Ok(());
        }
        let mut entries = match tokio::fs::read_dir(root).await {
            Ok(entries) => entries,
            // 읽을 수 없는 폴더는 건너뛴다(권한 등). 옛 코드와 같다
            Err(_) => return Ok(()),
        };
        let mut listed = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            listed.push((entry.file_name().to_string_lossy().into_owned(), entry));
        }
        // Node `readdir`(libuv `scandir`)은 바이트 이름순이다. 한도로 자를 때 남는 항목이 옛 구현과 같으려면 같은 순서로 걷는다
        listed.sort_by(|a, b| a.0.cmp(&b.0));
        let mut subdirs: Vec<String> = Vec::new();
        for (name, entry) in listed {
            let full = node_path::join(&[root, &name]);
            if cg::is_dot_git(&name) {
                let is_top = top.map_or(false, |top| node_path::resolve(&cwd(), &[&full]) == top);
                if !is_top {
                    found.push(node_path::relative(&cwd(), base, &full));
                }
                continue; // .git 안으로는 들어가지 않는다
            }
            let Ok(file_type) = entry.file_type().await else { continue };
            if file_type.is_symlink() || !file_type.is_dir() {
                continue;
            }
            subdirs.push(full);
        }
        if found.len() >= limit || subdirs.is_empty() {
            return Ok(());
        }
        let relatives: Vec<String> = subdirs.iter().map(|sub| node_path::relative(&cwd(), base, sub)).collect();
        let ignored = partition.ignored(relatives).await?;
        for sub in subdirs {
            if found.len() >= limit {
                return Ok(());
            }
            let relative = node_path::relative(&cwd(), base, &sub);
            if !ignored.contains(&relative) {
                walk_repos(base, &sub, top, limit, partition, found).await?;
            }
        }
        Ok(())
    })
}

impl Repo {
    /// 주어진 프로젝트 기준 디렉터리 경로 중 git이 무시하는 집합(옛 `#ignoredDirs`). 실패는 통과가 아니다
    async fn ignored_dirs(&self, paths: &[String]) -> Res<HashSet<String>> {
        if paths.is_empty() {
            return Ok(HashSet::new());
        }
        let location: Vec<String> = match &self.git_dir {
            Some(dir) => g!["--git-dir", dir, "--work-tree", &self.root],
            None => Vec::new(),
        };
        let full = cat(vec![crate::checkpoint_remote::GIT_HARDENING.iter().map(|arg| (*arg).to_owned()).collect(), g!["-C", &self.root], location, g!["check-ignore", "-z", "--stdin"]]);
        let input = paths.join("\0");
        let env = crate::checkpoint_remote::git_env();
        let out = crate::process_bytes::run_command_bytes(
            &self.git_bin,
            &full,
            Some(input.as_bytes()),
            Some(&env),
            None,
            std::future::pending::<()>(),
            GIT_MAX_BUFFER + 1,
        )
        .await;
        let stderr = || js::trim(&String::from_utf8_lossy(&out.stderr)).to_owned();
        if let Some(spawn) = &out.spawn_error {
            return fail(format!("중첩 저장소의 무시 여부를 확인하지 못했습니다 (check-ignore ENOENT): {spawn}"));
        }
        if out.stdout.len() > GIT_MAX_BUFFER || out.stderr.len() > GIT_MAX_BUFFER {
            return fail(format!("중첩 저장소의 무시 여부를 확인하지 못했습니다 (check-ignore ERR_CHILD_PROCESS_STDIO_MAXBUFFER): {}", stderr()));
        }
        if out.aborted {
            return fail(format!("중첩 저장소의 무시 여부를 확인하지 못했습니다 (check-ignore null): {}", stderr()));
        }
        match out.exit_code {
            Some(0) | Some(1) => Ok(String::from_utf8_lossy(&out.stdout).split('\0').filter(|file| !file.is_empty()).map(str::to_owned).collect()),
            code => fail(format!("중첩 저장소의 무시 여부를 확인하지 못했습니다 (check-ignore {}): {}", code.map_or_else(|| "null".to_owned(), |code| code.to_string()), stderr())),
        }
    }

    /// 작업 폴더 안에 추적되는 중첩 git 저장소가 있으면 던진다. 한도에 닿으면 "확인하지 못함"으로 던진다(fail-closed)
    async fn assert_no_nested_repos(&self) -> Res<()> {
        let limit = NESTED_LIMIT;
        let top = node_path::resolve(&cwd(), &[&self.root, ".git"]);
        let partition = Partition::Repo(self);
        let mut found = Vec::new();
        walk_repos(&self.root, &self.root, Some(&top), limit, &partition, &mut found).await?;
        if found.len() >= limit {
            return fail(format!("작업 폴더 안에 추적되는 git 저장소가 너무 많아({limit}개 이상) 안전을 확인하지 못했습니다. 중첩된 git 저장소를 지우거나 작업 폴더 밖으로 옮기세요"));
        }
        if found.is_empty() {
            return Ok(());
        }
        let sample = format!("{}{}", found.iter().take(3).cloned().collect::<Vec<_>>().join(", "), if found.len() > 3 { " 등" } else { "" });
        fail(format!(
            "작업 폴더 안에 다른 git 저장소가 있습니다({sample}). 체크포인트는 작업 폴더 전체를 하나의 저장소로 다루므로, 중첩된 git 저장소를 지우거나 작업 폴더 밖으로 옮긴 뒤 다시 시도하세요"
        ))
    }
}

/// `ls-files -v -z` 출력에서 표시(skip-worktree·assume-unchanged)가 걸린 경로를 모은다. git 출력은 UTF-8로 바꾸면서 UTF-8이 아닌 바이트가 U+FFFD가 되므로,
/// 표시가 걸린 경로에 U+FFFD가 있으면 그 경로를 다시 찾을 수 없다 — 통과가 아니라 "확인하지 못함"으로 던진다(fail-closed)
fn parse_flagged_entries(listing: &str) -> Res<Vec<String>> {
    let mut flagged: Vec<String> = Vec::new();
    for record in listing.split('\0') {
        let mut chars = record.chars();
        let Some(tag) = chars.next() else { continue };
        if tag == 'S' || tag.is_ascii_lowercase() {
            // `T path`: 태그 한 글자와 공백 뒤가 경로다
            let file = chars.as_str().strip_prefix(' ').unwrap_or(chars.as_str());
            if file.contains('\u{FFFD}') {
                return fail("인덱스 표시가 걸린 파일의 이름이 UTF-8이 아니어서 끝까지 확인하지 못했습니다. 표시를 지우거나 파일 이름을 바꾼 뒤 다시 시도하세요");
            }
            flagged.push(file.to_owned());
        }
    }
    Ok(flagged)
}

/// `ls-files --stage -z -- <chunk>` 출력이 chunk의 경로를 하나도 빠짐없이 한 번씩 담았는지 본다. 아니면 던진다
fn check_stage_covers(chunk: &[String], staged: &str) -> Res<()> {
    let mut seen: Vec<&str> = Vec::new();
    for entry in staged.split('\0').filter(|part| !part.is_empty()) {
        let Some((_, file)) = entry.split_once('\t') else { return fail("인덱스 항목을 읽지 못해 표시가 걸린 파일을 확인하지 못했습니다") };
        seen.push(file);
    }
    let mut want: Vec<&str> = chunk.iter().map(String::as_str).collect();
    want.sort_unstable();
    seen.sort_unstable();
    if want != seen {
        return fail(format!("표시가 걸린 파일 {}개 중 {}개의 인덱스 항목만 돌아와 끝까지 확인하지 못했습니다", want.len(), seen.len()));
    }
    Ok(())
}

/// `findNestedGitRepos` op. 훅으로 `partitionIgnored`를 부른다
async fn find_nested_git_repos(repo: &Repo, input: &Value) -> Res<Value> {
    let root = text(input, "root");
    let top = opt_text(input, "top");
    let limit = input.get("limit").and_then(Value::as_i64).unwrap_or(NESTED_LIMIT as i64).max(0) as usize;
    let hook = repo.hook.as_ref().ok_or(Fail::Hook)?;
    let partition = Partition::Hook(hook);
    let mut found = Vec::new();
    walk_repos(&root, &root, top.as_deref(), limit, &partition, &mut found).await?;
    Ok(json!(found))
}

fn dec(text: &str) -> String {
    js::well_formed_from_encoded(text)
}

fn cwd() -> String {
    std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".to_owned())
}

/// Node `fs.realpath` 실패 시 `path.resolve`(옛 `resolveReal`)
async fn resolve_real(path: &str) -> String {
    match tokio::fs::canonicalize(path).await {
        Ok(real) => real.to_string_lossy().into_owned(),
        Err(_) => node_path::resolve(&cwd(), &[path]),
    }
}

/// napi 입구 하나로 들어온 로컬 연산. 모르는 이름이면 `None`(부르는 쪽이 오류를 만든다)
pub(crate) async fn dispatch(repo: &mut Repo, op: &str, input: &Value) -> Option<Res<Value>> {
    Some(match op {
        "checkpoint" => repo.checkpoint(input.get("ref").and_then(Value::as_str).unwrap_or("HEAD")).await,
        "list" => repo.list(input.get("limit").and_then(Value::as_i64).unwrap_or(50)).await,
        "patch" => repo.patch(&text(input, "sha")).await,
        "fileAt" => repo.file_at(&text(input, "file"), &opt_text(input, "ref").unwrap_or_else(|| "HEAD".to_owned())).await,
        "blobAt" => repo.blob_at(&text(input, "file"), &text(input, "ref")).await,
        "listBlobs" => repo.list_blobs(&text(input, "ref"), &text(input, "dir")).await,
        "sessionDiff" => repo.session_diff().await,
        "diffSince" => repo.diff_since(&text(input, "sha")).await,
        "commitBefore" => repo.commit_before(&text(input, "iso")).await,
        "discardedBackups" => repo.discarded_backups().await,
        "refreshExcludedSnapshot" => repo.refresh_excluded_snapshot(&opt_text(input, "sha").unwrap_or_else(|| "HEAD".to_owned()), pairs(input, "expected")).await,
        "stageExcludedSnapshot" => match repo.stage_excluded_snapshot(pairs(input, "expected"), opt_text(input, "base")).await {
            Ok(staged) => Ok(json!({ "dir": staged.dir, "manifest": Value::Object(staged.manifest) })),
            Err(error) => Err(error),
        },
        "placeExcludedSnapshot" => {
            let staged = Staged {
                dir: text(input, "dir"),
                manifest: input.get("manifest").and_then(Value::as_object).cloned().unwrap_or_default(),
            };
            repo.place_excluded_snapshot(&text(input, "sha"), &staged).await.map(|()| Value::Null)
        }
        "carryForwardExcludedSnapshot" => repo.carry_forward_excluded_snapshot(&text(input, "parentSha"), &text(input, "newSha")).await,
        "excludedDiff" => repo.excluded_diff(&text(input, "target")).await.map(Value::Array),
        "applyExcludedDiff" => {
            let changes = input.get("changes").and_then(Value::as_array).cloned().unwrap_or_default();
            repo.apply_excluded_diff(&changes).await.map(|files| json!(files))
        }
        "pendingExcludedFiles" => {
            if !repo.has_excluded_files {
                Ok(json!([]))
            } else {
                match repo.head_sha().await {
                    Ok(head) => repo.excluded_diff(&head).await.map(|changes| Value::Array(changes.into_iter().map(|change| change["file"].clone()).collect())),
                    Err(error) => Err(error),
                }
            }
        }
        "ignoredChangedSince" => repo.ignored_changed_since(&opt_text(input, "sha").unwrap_or_else(|| "HEAD".to_owned())).await,
        "backupChanges" => {
            let excluded = input.get("excluded").and_then(Value::as_array).cloned().unwrap_or_default();
            repo.backup_changes(&string_array(input.get("trackedFiles")), &excluded, &text(input, "base")).await
        }
        "pruneBackups" => repo.prune_backups(&text(input, "keepId")).await.map(|()| Value::Null),
        "restoreBackupExcluded" => repo.restore_backup_excluded(&text(input, "backupDir")).await,
        "configure" => repo.configure().await.map(|()| Value::Null),
        "init" => repo.init(&text(input, "message")).await,
        "commit" => repo.commit(input).await,
        "commitPaths" => repo.commit_paths(input).await,
        "discard" => repo.discard().await,
        "restore" => repo.restore(&text(input, "sha")).await,
        "assertNoNestedRepos" => repo.assert_no_nested_repos().await.map(|()| Value::Null),
        "findNestedGitRepos" => find_nested_git_repos(repo, input).await,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_remote::Hook;
    use std::sync::Arc;

    fn sh(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@e"]).args(args).output().expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn init(dir: &std::path::Path) {
        sh(dir, &["init", "-q", "-b", "main"]);
        // 체크포인트 커밋(commit-tree)이 쓸 작성자. 실제 저장소는 configure가 넣는다. 전역 작성자가 없는 CI에서도 돌게 한다
        sh(dir, &["config", "user.name", "t"]);
        sh(dir, &["config", "user.email", "t@e"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        sh(dir, &["add", "-A"]);
        sh(dir, &["commit", "-q", "-m", "init"]);
    }

    fn repo(dir: &std::path::Path) -> Repo {
        Repo {
            root: dir.to_string_lossy().into_owned(),
            git_bin: "git".into(),
            git_dir: None,
            start: None,
            subdir: Some(String::new()),
            hook: None,
            author_email: Some("t@e".into()),
            author_name: Some("t".into()),
            has_excluded_files: false,
        }
    }

    /// TS의 사전 검사를 비껴(검사 뒤에 표시를 건 경우) Rust 커밋만 부른다: 고친 내용을 add하고 표시를 건 뒤 작업 폴더만 되돌리거나, 표시를 건 파일을 지워도 멈춘다
    #[tokio::test]
    async fn 커밋은_add_뒤_표시가_걸린_항목이_인덱스나_작업_폴더와_다르면_멈춘다() {
        for flag in ["--skip-worktree", "--assume-unchanged"] {
            for mode in ["staged-then-restored", "deleted", "clean"] {
                let dir = tempfile::tempdir().unwrap();
                init(dir.path());
                std::fs::write(dir.path().join("other.txt"), "o\n").unwrap();
                match mode {
                    "staged-then-restored" => {
                        std::fs::write(dir.path().join("a.txt"), "evil\n").unwrap();
                        sh(dir.path(), &["add", "a.txt"]);
                        sh(dir.path(), &["update-index", flag, "a.txt"]);
                        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
                    }
                    "deleted" => {
                        sh(dir.path(), &["update-index", flag, "a.txt"]);
                        std::fs::remove_file(dir.path().join("a.txt")).unwrap();
                    }
                    _ => sh(dir.path(), &["update-index", flag, "a.txt"]),
                }
                let mut repo = repo(dir.path());
                let result = repo.commit(&json!({ "message": "m", "trailers": [] })).await;
                if mode == "clean" {
                    result.expect("표시만 걸고 바꾸지 않았으면 커밋된다");
                } else {
                    let error = format!("{:?}", result.expect_err("멈춰야 한다"));
                    assert!(error.contains("인덱스 표시"), "{flag} {mode}: {error}");
                    // 멈추면 add한 것을 되돌려 other.txt도 스테이징에 남지 않는다
                    let staged = std::process::Command::new("git").arg("-C").arg(dir.path()).args(["diff", "--cached", "--name-only"]).output().unwrap();
                    assert!(!String::from_utf8_lossy(&staged.stdout).contains("other.txt"));
                }
            }
        }
    }

    #[test]
    fn 표시가_걸린_경로가_utf8이_아니거나_인덱스_항목이_모자라면_던진다() {
        // 0xff가 든 이름은 lossy 변환에서 U+FFFD가 된다(git 출력을 그렇게 읽는다)
        let lossy = String::from_utf8_lossy(b"S web/bad\xff.ts\0H web/ok.ts\0");
        let error = format!("{:?}", parse_flagged_entries(&lossy).expect_err("던져야 한다"));
        assert!(error.contains("UTF-8"), "{error}");
        // 표시가 걸리지 않은 항목의 이름은 상관없다
        let unflagged = String::from_utf8_lossy(b"H web/bad\xff.ts\0s web/ok.ts\0");
        assert_eq!(parse_flagged_entries(&unflagged).unwrap(), vec!["web/ok.ts".to_owned()]);
        // 인덱스 항목이 하나 빠지거나 이름이 다르면 던지고, 맞으면 통과한다
        let chunk = vec!["a".to_owned(), "b".to_owned()];
        assert!(check_stage_covers(&chunk, "100644 abc 0\ta\0").is_err());
        assert!(check_stage_covers(&chunk, "100644 abc 0\ta\0100644 abc 0\tc\0").is_err());
        assert!(check_stage_covers(&chunk, "100644 abc 0\ta\0100644 abc 0\tb\0").is_ok());
    }

    /// UTF-8이 아닌 이름의 파일(리눅스에서는 만들 수 있다, macOS APFS는 거절할 수 있어 그때는 건너뛴다)에 표시를 걸고 고쳐도 커밋이 멈춘다
    #[tokio::test]
    async fn utf8이_아닌_이름에_표시를_걸고_고쳐도_커밋은_멈춘다() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let name = std::ffi::OsStr::from_bytes(b"bad\xff.txt");
        if std::fs::write(dir.path().join(name), "x\n").is_err() {
            return;
        }
        sh(dir.path(), &["add", "-A"]);
        sh(dir.path(), &["commit", "-q", "-m", "bad"]);
        let flagged = std::process::Command::new("git").arg("-C").arg(dir.path()).args(["update-index", "--skip-worktree", "--"]).arg(name).output().unwrap();
        assert!(flagged.status.success());
        std::fs::write(dir.path().join(name), "evil\n").unwrap();
        std::fs::write(dir.path().join("other.txt"), "o\n").unwrap();
        let mut repo = repo(dir.path());
        let error = format!("{:?}", repo.commit(&json!({ "message": "m", "trailers": [] })).await.expect_err("멈춰야 한다"));
        assert!(error.contains("UTF-8") || error.contains("인덱스 표시"), "{error}");
    }

    /// Node `readdir`은 libuv가 바이트 이름순으로 정렬해 돌려준다. 한도로 자르는 걷기와 폴더 이름 목록이
    /// 파일 시스템의 원래 순서(ext4는 해시 순서)를 따르면 리눅스에서만 옛 구현과 다른 항목이 남는다
    #[tokio::test]
    async fn 걷기와_폴더_이름_목록은_파일_시스템과_상관없이_바이트_이름순이다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let names: Vec<String> = (0..40).rev().map(|i| format!("d{i:02}")).collect();
        for name in &names {
            std::fs::create_dir_all(dir.path().join(name).join(".git")).unwrap();
        }
        let repo = repo(dir.path());
        let root = repo.root.clone();
        let top = node_path::join(&[&root, ".git"]);
        let partition = Partition::Repo(&repo);
        let mut found = Vec::new();
        walk_repos(&root, &root, Some(&top), 5, &partition, &mut found).await.expect("walk");
        let expected: Vec<String> = (0..5).map(|i| format!("d{i:02}/.git")).collect();
        assert_eq!(found, expected);

        let listed = read_dir_names(&root).await;
        let mut sorted = listed.clone();
        sorted.sort();
        assert_eq!(listed, sorted);
    }

    #[tokio::test]
    async fn 읽기는_체크포인트를_만들지_않고_바이트를_그대로_돌려준다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        std::fs::write(dir.path().join("bin.bin"), [0u8, 1, 255, 65]).unwrap();
        sh(dir.path(), &["add", "-A"]);
        sh(dir.path(), &["commit", "-q", "-m", "bin"]);
        let mut repo = repo(dir.path());
        let listed = repo.list(50).await.expect("list");
        assert_eq!(listed.as_array().unwrap().len(), 2);
        let head = listed[0]["sha"].as_str().unwrap().to_owned();
        let blob = repo.blob_at("bin.bin", &head).await.expect("blobAt");
        assert_eq!(blob["kind"], "file");
        assert_eq!(unb64(blob["content"].as_str().unwrap()).unwrap(), vec![0u8, 1, 255, 65]);
        assert_eq!(repo.file_at("a.txt", &head).await.unwrap(), json!("a\n"));
        assert_eq!(repo.file_at("nope", &head).await.unwrap(), Value::Null);
    }

    #[tokio::test]
    async fn 사이드카는_manifest와_파일을_같은_모양으로_남기고_되돌린다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        std::fs::create_dir_all(dir.path().join(".git/info")).unwrap();
        std::fs::write(dir.path().join(".git/info/exclude"), "/studio.yaml\n").unwrap();
        std::fs::write(dir.path().join("studio.yaml"), "one\n").unwrap();
        let hook: Hook = Arc::new(|_| Box::pin(async { Some("{\"ok\":true,\"files\":[\"studio.yaml\"]}".to_owned()) }));
        let mut repo = Repo { hook: Some(hook), has_excluded_files: true, ..repo(dir.path()) };
        let head = repo.head_sha().await.expect("head");
        repo.refresh_excluded_snapshot(&head, None).await.expect("snapshot");
        let manifest_path = node_path::join(&[&excluded_dir(&repo, &head), "manifest.json"]);
        assert_eq!(std::fs::read_to_string(manifest_path).unwrap(), "{\"studio.yaml\":true}");
        std::fs::write(dir.path().join("studio.yaml"), "two\n").unwrap();
        let changes = repo.excluded_diff(&head).await.expect("diff");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["file"], "studio.yaml");
        assert_eq!(unb64(changes[0]["before"].as_str().unwrap()).unwrap(), b"two\n");
        assert_eq!(unb64(changes[0]["after"].as_str().unwrap()).unwrap(), b"one\n");
        repo.apply_excluded_diff(&changes).await.expect("apply");
        assert_eq!(std::fs::read_to_string(dir.path().join("studio.yaml")).unwrap(), "one\n");
    }

    #[tokio::test]
    async fn 검증과_다른_생성_파일은_StagedMismatch로_멈춘다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        std::fs::create_dir_all(dir.path().join(".git/info")).unwrap();
        std::fs::write(dir.path().join(".git/info/exclude"), "/studio.yaml\n").unwrap();
        std::fs::write(dir.path().join("studio.yaml"), "one\n").unwrap();
        let hook: Hook = Arc::new(|_| Box::pin(async { Some("{\"ok\":true,\"files\":[\"studio.yaml\"]}".to_owned()) }));
        let mut repo = Repo { hook: Some(hook), has_excluded_files: true, ..repo(dir.path()) };
        let expected = vec![("studio.yaml".to_owned(), "blob:그런적없음".to_owned())];
        let result = repo.stage_excluded_snapshot(Some(expected), None).await;
        assert!(matches!(result, Err(Fail::StagedMismatch(files)) if files == vec!["studio.yaml".to_owned()]));
    }

    #[tokio::test]
    async fn 스테이징한_파일을_읽지_못하면_missing이_아니라_오류다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        std::fs::create_dir_all(dir.path().join(".git/info")).unwrap();
        std::fs::write(dir.path().join(".git/info/exclude"), "/studio.yaml\n").unwrap();
        std::fs::write(dir.path().join("studio.yaml"), "one\n").unwrap();
        let hook: Hook = Arc::new(|_| Box::pin(async { Some("{\"ok\":true,\"files\":[\"studio.yaml\"]}".to_owned()) }));
        let mut repo = Repo { hook: Some(hook), has_excluded_files: true, ..repo(dir.path()) };
        let staged = repo.stage_excluded_snapshot(None, None).await.expect("stage");
        // 스테이징한 파일을 폴더로 바꾼다(읽는 쪽은 EISDIR)
        let staged_file = node_path::join(&[&staged.dir, "files", "studio.yaml"]);
        std::fs::remove_file(&staged_file).unwrap();
        std::fs::create_dir(&staged_file).unwrap();
        let base = repo.head_sha().await.unwrap();
        // 기대 지문이 "missing"이어도 읽지 못한 것을 missing으로 읽어 통과시키면 안 된다
        let expected = vec![("studio.yaml".to_owned(), "missing".to_owned())];
        let result = repo.excluded_mismatch(&expected, &staged.dir, &staged.manifest, &HashMap::new(), &base).await;
        match result {
            Err(Fail::Io(message)) => assert_eq!(message, "EISDIR: illegal operation on a directory, read"),
            other => panic!("오류여야 한다: {other:?}"),
        }
    }

    #[tokio::test]
    async fn 첫_부모를_읽지_못하면_부모_없음이_아니라_오류다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let repo = repo(dir.path());
        match repo.first_parent("no-such-sha").await {
            Err(Fail::Checkpoint(message)) => assert!(message.starts_with("git rev-list 실패"), "{message}"),
            other => panic!("오류여야 한다: {other:?}"),
        }
    }

    fn failure_text(result: Res<Value>) -> String {
        match result {
            Err(Fail::Checkpoint(message)) => message,
            Err(other) => format!("{other:?}"),
            Ok(_) => "OK".to_owned(),
        }
    }

    fn malicious_excluded(name: &str) -> Hook {
        let name = name.to_owned();
        Arc::new(move |request| {
            let name = name.clone();
            Box::pin(async move {
                if request.contains("backupIdentity") {
                    Some(json!({ "ok": true, "id": "id-1", "createdAt": "2026-11-18T00:00:00.000Z" }).to_string())
                } else {
                    Some(json!({ "ok": true, "files": [name] }).to_string())
                }
            })
        })
    }

    fn assert_decoys(name: &str, label: &str, base: &std::path::Path, project: &std::path::Path, before_git: &[u8], before_hosts: &Option<Vec<u8>>) {
        assert_eq!(std::fs::read_to_string(base.join("outside.txt")).unwrap(), "decoy\n", "{name}: {label} 뒤에 ../outside.txt가 바뀌었다");
        assert_eq!(std::fs::read_to_string(base.join("absolute.txt")).unwrap(), "decoy\n", "{name}: {label} 뒤에 절대 경로 미끼가 바뀌었다");
        assert_eq!(std::fs::read(project.join(".git/config")).unwrap(), before_git, "{name}: {label} 뒤에 .git/config가 바뀌었다");
        assert_eq!(&std::fs::read("/etc/hosts").ok(), before_hosts, "{name}: {label} 뒤에 /etc/hosts가 바뀌었다");
    }

    /// `excludedFiles` 제공자가 어긋난 이름을 돌려주면 init·commit·discard·restore가 프로젝트 밖을 건드리지 않고 거부해야 한다.
    /// 미끼는 프로젝트 폴더 밖(부모 폴더)과 절대 경로에 두고, 이름이 `.git/config`면 그 파일도 본다
    #[tokio::test]
    async fn 생성_파일_이름은_경계에서_거부하고_프로젝트_밖을_건드리지_않는다() {
        let base = tempfile::tempdir().unwrap();
        let project = base.path().join("order");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(base.path().join("outside.txt"), "decoy\n").unwrap();
        let absolute = base.path().join("absolute.txt");
        std::fs::write(&absolute, "decoy\n").unwrap();
        let absolute_name = absolute.to_string_lossy().into_owned();
        let before_hosts = std::fs::read("/etc/hosts").ok();
        let cases = ["../outside.txt", "/etc/hosts", "a/../../outside.txt", "", "a\0b", ".git/config", "a//b", "./a", "a/"];

        // 기준 저장소를 만든다(정상 이름 없이). start 메타가 생긴다
        let mut benign = repo(&project);
        benign.init("시작").await.expect("init");
        let start = benign.start_sha().await.expect("start");
        std::fs::write(project.join("a.txt"), "changed\n").unwrap();

        let mut outcomes: Vec<(String, [String; 4])> = Vec::new();
        for (index, name) in cases.into_iter().map(str::to_owned).chain(std::iter::once(absolute_name)).enumerate() {
            let mut bad = Repo { hook: Some(malicious_excluded(&name)), has_excluded_files: true, ..repo(&project) };
            let init_error = failure_text(bad.init("다시 시작").await);
            assert_decoys(&name, "init", base.path(), &project, &std::fs::read(project.join(".git/config")).unwrap(), &before_hosts);

            // init 뒤의 기준선. configure가 .git/config를 쓰므로 그 뒤에 뜬다
            let before_git = std::fs::read(project.join(".git/config")).unwrap();
            // 앞 이름의 오류로 남은 파일이 다음 init에 커밋되므로, 매번 새 이름을 써서 track할 변경이 있게 한다
            std::fs::write(project.join(format!("b-{index}.txt")), "b\n").unwrap();
            let commit_error = failure_text(bad.commit(&json!({ "message": "커밋", "expectExcluded": [] })).await);
            assert_decoys(&name, "commit", base.path(), &project, &before_git, &before_hosts);

            let discard_error = failure_text(bad.discard().await);
            assert_decoys(&name, "discard", base.path(), &project, &before_git, &before_hosts);

            let restore_error = failure_text(bad.restore(&start).await);
            assert_decoys(&name, "restore", base.path(), &project, &before_git, &before_hosts);
            outcomes.push((name, [init_error, commit_error, discard_error, restore_error]));
        }
        let wrong: Vec<_> = outcomes.iter().filter(|(_, messages)| messages.iter().any(|message| !message.contains("생성 파일 이름"))).collect();
        assert!(wrong.is_empty(), "경계에서 거부되지 않은 이름/동작: {wrong:#?}");
    }

    fn tree_has_bytes(dir: &std::path::Path, needle: &[u8]) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if tree_has_bytes(&path, needle) {
                    return true;
                }
            } else if std::fs::read(&path).is_ok_and(|bytes| bytes == needle) {
                return true;
            }
        }
        false
    }

    fn manifest_of(project: &std::path::Path, sha: &str) -> Value {
        let dir = project.join(".git/b-studio/excluded").join(sha);
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap()
    }

    fn ignored_studio(project: &std::path::Path) {
        let exclude = project.join(".git/info/exclude");
        let mut text = std::fs::read_to_string(&exclude).unwrap_or_default();
        text.push_str("/studio.yaml\n");
        std::fs::write(&exclude, text).unwrap();
    }

    /// 프로젝트 안을 가리키는 링크는 `link:<대상>`으로 기록하고, 되돌리면 그 자리에 같은 대상의 링크를 다시 만든다
    #[cfg(unix)]
    #[tokio::test]
    async fn 생성_파일_링크는_기록하고_되돌리면_같은_대상을_다시_만든다() {
        let base = tempfile::tempdir().unwrap();
        let project = base.path().join("order");
        std::fs::create_dir_all(project.join("spec")).unwrap();
        std::fs::write(project.join("spec/real.yaml"), "inside\n").unwrap();
        std::fs::write(project.join("spec/other.yaml"), "other\n").unwrap();
        let mut benign = repo(&project);
        benign.init("시작").await.expect("init");
        ignored_studio(&project);
        std::os::unix::fs::symlink("spec/real.yaml", project.join("studio.yaml")).unwrap();

        let mut store = Repo { hook: Some(malicious_excluded("studio.yaml")), has_excluded_files: true, ..repo(&project) };
        let init = store.init("다시 시작").await.expect("링크가 있어도 init은 성공한다");
        let sha = init["sha"].as_str().unwrap().to_owned();
        assert_eq!(manifest_of(&project, &sha)["studio.yaml"], "link:spec/real.yaml");
        assert!(!project.join(".git/b-studio/excluded").join(&sha).join("files/studio.yaml").exists(), "링크 대상 내용을 사이드카에 쓰지 않는다");

        // 게이트가 링크를 `link:<대상>`으로 지문해도 같은 규칙으로 맞는다
        store
            .stage_excluded_snapshot(Some(vec![("studio.yaml".to_owned(), "link:spec/real.yaml".to_owned())]), None)
            .await
            .expect("링크 지문이 맞는다");
        let mismatch = store.stage_excluded_snapshot(Some(vec![("studio.yaml".to_owned(), "link:spec/other.yaml".to_owned())]), None).await;
        assert!(matches!(mismatch, Err(Fail::StagedMismatch(files)) if files == vec!["studio.yaml".to_owned()]));

        std::fs::write(project.join("a.txt"), "changed\n").unwrap();
        store.commit(&json!({ "message": "링크 커밋" })).await.expect("링크가 있어도 commit은 성공한다");

        // 지금 자리가 파일로 바뀌어도 되돌리면 스냅샷의 링크를 다시 만든다
        std::fs::remove_file(project.join("studio.yaml")).unwrap();
        std::fs::write(project.join("studio.yaml"), "changed\n").unwrap();
        store.discard().await.expect("링크로 되돌린다");
        assert_eq!(std::fs::read_link(project.join("studio.yaml")).unwrap(), std::path::Path::new("spec/real.yaml"));
        assert_eq!(std::fs::read_to_string(project.join("spec/real.yaml")).unwrap(), "inside\n");

        // 링크 대상이 바뀌어도 restore는 그 체크포인트의 링크를 다시 만든다
        std::fs::remove_file(project.join("studio.yaml")).unwrap();
        std::os::unix::fs::symlink("spec/other.yaml", project.join("studio.yaml")).unwrap();
        store.restore(&sha).await.expect("링크로 복원한다");
        assert_eq!(std::fs::read_link(project.join("studio.yaml")).unwrap(), std::path::Path::new("spec/real.yaml"));
        assert_eq!(std::fs::read_to_string(project.join("spec/other.yaml")).unwrap(), "other\n");
    }

    /// 프로젝트 밖을 가리키는 링크도 성공하되, 바깥 내용을 사이드카·백업에 넣지 않고 바깥 파일을 바꾸지 않는다
    #[cfg(unix)]
    #[tokio::test]
    async fn 바깥을_가리키는_링크는_내용을_읽지_않고_링크로_기록한다() {
        let base = tempfile::tempdir().unwrap();
        let project = base.path().join("order");
        let outside = base.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let one = outside.join("one.txt");
        let two = outside.join("two.txt");
        std::fs::write(&one, "outside-one\n").unwrap();
        std::fs::write(&two, "outside-two\n").unwrap();

        let mut benign = repo(&project);
        benign.init("시작").await.expect("init");
        ignored_studio(&project);
        std::os::unix::fs::symlink(&one, project.join("studio.yaml")).unwrap();

        let mut store = Repo { hook: Some(malicious_excluded("studio.yaml")), has_excluded_files: true, ..repo(&project) };
        let init = store.init("다시 시작").await.expect("바깥 링크가 있어도 init은 성공한다");
        let sha = init["sha"].as_str().unwrap().to_owned();
        assert_eq!(manifest_of(&project, &sha)["studio.yaml"], format!("link:{}", one.display()));
        assert!(!tree_has_bytes(&project.join(".git/b-studio"), b"outside-one\n"), "바깥 내용이 사이드카에 들어갔다");
        assert_eq!(std::fs::read_to_string(&one).unwrap(), "outside-one\n");

        // 링크 대상을 바꾸고 discard: 백업에는 대상 글자만, 바깥 파일은 그대로
        std::fs::remove_file(project.join("studio.yaml")).unwrap();
        std::os::unix::fs::symlink(&two, project.join("studio.yaml")).unwrap();
        store.discard().await.expect("바깥 링크를 되돌린다");
        assert_eq!(std::fs::read_link(project.join("studio.yaml")).unwrap(), one);
        assert_eq!(std::fs::read_to_string(&two).unwrap(), "outside-two\n");
        assert!(!tree_has_bytes(&project.join(".git/b-studio"), b"outside-two\n"), "바깥 내용이 백업에 들어갔다");
        let backup_manifest = std::fs::read_to_string(project.join(".git/b-studio/discarded/id-1/excluded-manifest.json")).unwrap();
        assert!(backup_manifest.contains(&format!("link:{}", two.display())), "{backup_manifest}");
        assert!(!project.join(".git/b-studio/discarded/id-1/excluded/studio.yaml").exists(), "백업에 링크 내용을 복사하지 않는다");

        std::fs::write(project.join("a.txt"), "changed\n").unwrap();
        store.commit(&json!({ "message": "바깥 링크 커밋" })).await.expect("바깥 링크가 있어도 commit은 성공한다");
    }

    /// 스냅샷은 파일이었는데 지금 자리가 링크면 링크 자체를 지우고 파일을 만든다(너머에 쓰지 않는다)
    #[cfg(unix)]
    #[tokio::test]
    async fn 스냅샷이_파일인데_지금_링크면_링크만_지우고_파일을_만든다() {
        let base = tempfile::tempdir().unwrap();
        let project = base.path().join("order");
        let outside = base.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let leak = outside.join("leak.txt");
        std::fs::write(&leak, "outside\n").unwrap();
        let mut benign = repo(&project);
        benign.init("시작").await.expect("init");
        ignored_studio(&project);
        std::fs::write(project.join("studio.yaml"), "inside\n").unwrap();

        let mut store = Repo { hook: Some(malicious_excluded("studio.yaml")), has_excluded_files: true, ..repo(&project) };
        let head = store.head_sha().await.expect("head");
        store.refresh_excluded_snapshot(&head, None).await.expect("snapshot");

        std::fs::remove_file(project.join("studio.yaml")).unwrap();
        std::os::unix::fs::symlink(&leak, project.join("studio.yaml")).unwrap();
        store.discard().await.expect("파일로 되돌린다");
        assert_eq!(std::fs::read_to_string(&leak).unwrap(), "outside\n");
        let info = std::fs::symlink_metadata(project.join("studio.yaml")).unwrap();
        assert!(info.is_file() && !info.file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(project.join("studio.yaml")).unwrap(), "inside\n");
    }

    /// `apply_excluded_diff`는 링크 자리를 지우고 링크나 파일을 만든다. 중간 폴더 링크는 따라가지 않는다
    #[cfg(unix)]
    #[tokio::test]
    async fn 되돌리기는_링크_자리만_바꾸고_중간_폴더_링크는_따라가지_않는다() {
        let base = tempfile::tempdir().unwrap();
        let project = base.path().join("order");
        let outside = base.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(outside.join("web")).unwrap();
        let leak = outside.join("leak.txt");
        std::fs::write(&leak, "outside\n").unwrap();
        let nested = outside.join("web/target.txt");
        std::fs::write(&nested, "outside-target\n").unwrap();
        std::os::unix::fs::symlink(&leak, project.join("studio.yaml")).unwrap();
        std::os::unix::fs::symlink(&outside, project.join("apps")).unwrap();

        let mut repo = repo(&project);
        // 스냅샷이 파일이면 링크를 지우고 파일을 만든다
        repo.apply_excluded_diff(&[json!({ "file": "studio.yaml", "after": b64(b"inside\n") })]).await.expect("파일로 되돌린다");
        assert!(std::fs::symlink_metadata(project.join("studio.yaml")).unwrap().is_file());
        assert_eq!(std::fs::read_to_string(&leak).unwrap(), "outside\n");

        // 스냅샷이 링크면 같은 대상의 링크를 다시 만든다
        std::fs::remove_file(project.join("studio.yaml")).unwrap();
        std::fs::write(project.join("studio.yaml"), "file\n").unwrap();
        repo.apply_excluded_diff(&[json!({ "file": "studio.yaml", "afterLink": leak.to_string_lossy() })]).await.expect("링크로 되돌린다");
        assert_eq!(std::fs::read_link(project.join("studio.yaml")).unwrap(), leak);
        assert_eq!(std::fs::read_to_string(&leak).unwrap(), "outside\n");

        // 중간 폴더가 링크면 따라가지 않고 오류다
        let remove = repo.apply_excluded_diff(&[json!({ "file": "apps/web/target.txt", "after": Value::Null })]).await;
        assert!(remove.is_err(), "중간 폴더 링크를 따라가지 않는다");
        assert_eq!(std::fs::read_to_string(&nested).unwrap(), "outside-target\n");
    }

    /// 백업 되살리기도 nofollow다. 백업 폴더의 manifest 이름은 손으로 바뀔 수 있어 경계에서 다시 검사하고,
    /// 프로젝트의 중간 폴더가 링크면 너머에 쓰지 않고 오류다
    #[cfg(unix)]
    #[tokio::test]
    async fn 백업_되살리기도_링크_너머를_건드리지_않는다() {
        let base = tempfile::tempdir().unwrap();
        let project = base.path().join("order");
        let outside = base.path().join("outside");
        let backup = base.path().join("backup");
        std::fs::create_dir_all(project.join("spec")).unwrap();
        std::fs::create_dir_all(outside.join("web")).unwrap();
        std::fs::create_dir_all(backup.join("excluded/apps/web")).unwrap();
        std::fs::write(project.join("spec/real.yaml"), "real\n").unwrap();
        let decoy = outside.join("web/Dockerfile.b-studio");
        std::fs::write(&decoy, "outside\n").unwrap();
        std::fs::write(backup.join("excluded/apps/web/Dockerfile.b-studio"), "backup\n").unwrap();
        std::os::unix::fs::symlink(&outside, project.join("apps")).unwrap();

        let manifest = backup.join("excluded-manifest.json");
        std::fs::write(&manifest, json!({ "apps/web/Dockerfile.b-studio": true }).to_string()).unwrap();
        let mut repo = repo(&project);
        let result = repo.restore_backup_excluded(&backup.to_string_lossy()).await;
        assert!(result.is_err(), "프로젝트의 링크 폴더를 따라 쓰지 않는다");
        assert_eq!(std::fs::read_to_string(&decoy).unwrap(), "outside\n");

        // 백업 manifest의 이름도 다시 검사한다
        std::fs::write(&manifest, json!({ "../outside.txt": true }).to_string()).unwrap();
        let result = repo.restore_backup_excluded(&backup.to_string_lossy()).await;
        assert!(result.is_err(), "백업 manifest의 `..` 이름을 거부한다");
        assert_eq!(std::fs::read_to_string(&decoy).unwrap(), "outside\n");

        // 링크 백업은 같은 대상의 링크로 되살린다
        std::fs::write(project.join("studio.yaml"), "file\n").unwrap();
        std::fs::write(&manifest, json!({ "studio.yaml": "link:spec/real.yaml" }).to_string()).unwrap();
        repo.restore_backup_excluded(&backup.to_string_lossy()).await.expect("링크를 되살린다");
        assert_eq!(std::fs::read_link(project.join("studio.yaml")).unwrap(), std::path::Path::new("spec/real.yaml"));
        assert_eq!(std::fs::read_to_string(project.join("spec/real.yaml")).unwrap(), "real\n");
    }

    #[tokio::test]
    async fn 백업은_패치와_생성_파일_내용과_메타를_남긴다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let excluded = vec![json!({ "file": "studio.yaml", "before": b64(b"two\n") })];
        let hook: Hook = Arc::new(|request| {
            Box::pin(async move {
                if request.contains("backupIdentity") {
                    Some("{\"ok\":true,\"id\":\"id-1\",\"createdAt\":\"2026-11-18T00:00:00.000Z\"}".to_owned())
                } else {
                    Some("{\"ok\":true}".to_owned())
                }
            })
        });
        let mut repo = Repo { hook: Some(hook), ..repo(dir.path()) };
        let backup = repo.backup_changes(&[], &excluded, "HEAD").await.expect("backup");
        assert_eq!(backup, json!({ "id": "id-1", "files": ["studio.yaml"], "createdAt": "2026-11-18T00:00:00.000Z" }));
        assert_eq!(std::fs::read(backup_dir(&repo, "id-1") + "/excluded/studio.yaml").unwrap(), b"two\n");
        assert_eq!(std::fs::read_to_string(backup_dir(&repo, "id-1") + "/excluded-manifest.json").unwrap(), "{\"studio.yaml\":true}");
        assert_eq!(std::fs::read_to_string(backup_dir(&repo, "id-1") + "/meta.json").unwrap(), backup.to_string());
    }
}
