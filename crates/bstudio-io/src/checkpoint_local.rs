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
//! 경로 규칙(옛 TS 그대로):
//! - `#excludedDiff`·`#applyExcludedDiff`·`ignoredChangedSince`는 프로젝트 폴더 기준 이름을 `path.join`으로 잇는다. 옛 코드는 이름에 `..`가 있으면
//!   폴더 밖으로 나갈 수 있었다(후보는 `studio.yaml` 같은 생성 파일 이름이라 보통 그런 값이 없다). 이번 이전은 **동작을 바꾸지 않는다** — 좁히는 일은 따로 한다.
//! - `#applyExcludedDiff`의 제거는 옛 `rm(target, { force: true })`와 같다. 폴더면 지우지 않고 오류다(`unlink_force`). 링크는 링크 자리만 지운다.
//! - `#carryForwardExcludedSnapshot`의 복사는 링크를 따라가지 않고 링크로 복사한다(옛 `fs.cp` 기본값과 같은 쪽; 링크 너머를 복사하지 않는다).
//! - `#stageExcludedSnapshot`은 링크를 `link:<가리키는 곳>`으로 기록하면서 내용도 읽는다(옛 코드와 같다 — 읽기는 링크를 따라간다).

use std::collections::{HashMap, HashSet};
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

async fn read_manifest(repo: &Repo, sha: &str) -> Option<Map<String, Value>> {
    let text = read_text(&node_path::join(&[&excluded_dir(repo, sha), "manifest.json"])).await?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `fs.writeFile`처럼 상위 폴더를 만들고 쓴다(옛 코드는 `mkdir(dirname, { recursive: true })`를 먼저 불렀다)
async fn write_create(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    tokio::fs::create_dir_all(node_path::dirname(path)).await?;
    tokio::fs::write(path, bytes).await
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

/// `fs.rm(path, { force: true })` — 폴더는 지우지 않고 오류다(`recursive` 없음). 링크는 링크 자리만 지운다
async fn unlink_force(path: &str) -> std::io::Result<()> {
    use std::io::ErrorKind::NotFound;
    match tokio::fs::symlink_metadata(path).await {
        Err(error) if error.kind() == NotFound => Ok(()),
        Err(error) => Err(error),
        // EISDIR: `fs.rm`은 recursive가 아니면 폴더를 지우지 않는다(옛 코드도 던졌다)
        Ok(meta) if meta.file_type().is_dir() => Err(std::io::Error::from_raw_os_error(21)),
        Ok(_) => match tokio::fs::remove_file(path).await {
            Err(error) if error.kind() == NotFound => Ok(()),
            other => other,
        },
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

    /// `excludedFiles` 제공자를 부른다(상태가 TS에 있다)
    async fn excluded_files(&self, project_root: &str) -> Res<Vec<String>> {
        let answer = self.hook(json!({ "op": "excludedFiles", "projectRoot": project_root })).await?;
        Ok(string_array(answer.get("files")))
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
            let before = if map_truthy(previous, &file) { read_bytes(&node_path::join(&[&excluded_dir(self, base), "files", &file])).await } else { None };
            let same = match (&content, &before) {
                (None, None) => true,
                (Some(content), Some(before)) => content == before,
                _ => false,
            };
            if !same {
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
            let absolute = node_path::join(&[&project_root, file]);
            if let Ok(meta) = tokio::fs::symlink_metadata(&absolute).await {
                if meta.file_type().is_symlink() {
                    let target = tokio::fs::read_link(&absolute).await.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
                    links.insert(file.clone(), format!("link:{target}"));
                }
            }
            let content = read_bytes(&absolute).await;
            manifest.insert(file.clone(), json!(content.is_some()));
            if let Some(bytes) = &content {
                let to = node_path::join(&[&files_dir, file]);
                if let Err(error) = write_create(&to, bytes).await {
                    return Err(cleanup_staged(&dir, io_fail(error, "open", &to)).await);
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
            let current = read_bytes(&node_path::join(&[&project_root, &file])).await;
            let existed = map_truthy(&manifest, &file);
            let at_target = if existed { read_bytes(&node_path::join(&[&snapshot, "files", &file])).await } else { None };
            let changed = if existed { current.is_none() || at_target.is_none() || current != at_target } else { current.is_some() };
            if changed {
                changes.push(json!({
                    "file": file,
                    "before": current.as_deref().map(b64).map(Value::String).unwrap_or(Value::Null),
                    "after": at_target.as_deref().map(b64).map(Value::String).unwrap_or(Value::Null),
                }));
            }
        }
        Ok(changes)
    }

    /// `#excludedDiff`가 고른 변경을 실제로 적용한다(없던 파일은 지우고, 있던 파일은 그 내용으로 되돌린다)
    async fn apply_excluded_diff(&mut self, changes: &[Value]) -> Res<Vec<String>> {
        let project_root = project_root(self).await;
        let mut applied = Vec::new();
        for change in changes {
            let file = change.get("file").and_then(Value::as_str).unwrap_or_default().to_owned();
            let target = node_path::join(&[&project_root, &file]);
            match change.get("after").and_then(Value::as_str) {
                None => {
                    if let Err(error) = unlink_force(&target).await {
                        return Err(io_fail(error, "rm", &target));
                    }
                }
                Some(encoded) => {
                    let Some(bytes) = unb64(encoded) else { return fail("생성 파일 내용을 풀지 못했습니다") };
                    if let Err(error) = write_create(&target, &bytes).await {
                        return Err(io_fail(error, "open", &target));
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
                manifest.insert(file.clone(), json!(before.is_some()));
                if let Some(encoded) = before {
                    let Some(bytes) = unb64(encoded) else { return fail("생성 파일 내용을 풀지 못했습니다") };
                    let target = node_path::join(&[&dir, "excluded", &file]);
                    if let Err(error) = write_create(&target, &bytes).await {
                        return Err(io_fail(error, "open", &target));
                    }
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
        let mut subdirs: Vec<String> = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
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
