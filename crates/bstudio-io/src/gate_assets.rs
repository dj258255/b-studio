//! 게이트의 남은 I/O 중 효과만 옮긴 곳(D2): 평가 자산 지문·훑기와 화면 확인의 관측(단계 저장·서비스 출처).
//!
//! - 평가 자산: 옛 TS `packages/agent/src/gate.ts`의 `fingerprintEvaluationAssets`·`collectEvaluationAsset`·`walkEvaluationAssetDir`·
//!   `recordEvaluationFile`·`parentsAreReal`. 판정(비교·글)은 `bstudio_guard::gate_assets`가 하고, 여기는 파일을 훑는다.
//! - 관측: 옛 `#saveSteps`·`#serviceOrigins`. 저장·엔드포인트는 TS 콜백(`Hook`)으로 부른다(상태는 TS가 든다).
//!
//! **막는 쪽이다(평가 자산).** 견줄 수 없는 입력(링크·특수 파일·읽기 실패·개수 상한·읽는 동안 바뀜)은 통과가 아니라 실패다.
//! 파일은 `workspace_io::read_regular_file`로 읽는다 — 링크를 따라가지 않고, 상한을 읽기 전에 보고, 다 읽지 못했으면 `complete`가 거짓이다.

use std::path::Path;
use std::pin::Pin;

use bstudio_guard::gate_assets as ga;
use bstudio_guard::node_path;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::checkpoint_remote::Hook;
use crate::workspace_io::{self, FileRead};

/// 평가 자산 파일 읽기 상한. 옛 `workspace.ts`의 `MAX_READ_BYTES`와 같다
const MAX_READ_BYTES: f64 = 256.0 * 1024.0;

/// Node `fs` 오류의 `code`. 모르면 `알 수 없는 오류`(옛 코드의 `code ?? '알 수 없는 오류'`)
fn errno_name(error: &std::io::Error) -> String {
    let Some(code) = error.raw_os_error() else { return "알 수 없는 오류".to_owned() };
    match code {
        libc::ENOENT => "ENOENT",
        libc::ENOTDIR => "ENOTDIR",
        libc::ELOOP => "ELOOP",
        libc::EMLINK => "EMLINK",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::EISDIR => "EISDIR",
        libc::EEXIST => "EEXIST",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOSPC => "ENOSPC",
        libc::EIO => "EIO",
        _ => return "알 수 없는 오류".to_owned(),
    }
    .to_owned()
}

/// 프로젝트 루트 기준 상대 경로의 상위 폴더 중 링크가 있으면 false. 열 수 없으면 true(아래 lstat이 판정한다)
fn parents_are_real(root: &str, relative: &str) -> bool {
    let parent = node_path::dirname(relative);
    if parent == "." {
        return true;
    }
    let Ok(real_parent) = std::fs::canonicalize(node_path::join(&[root, &parent])) else { return true };
    let Ok(real_root) = std::fs::canonicalize(root) else { return true };
    real_parent.to_string_lossy() == node_path::join(&[&real_root.to_string_lossy(), &parent])
}

/// 자산 하나(파일 또는 폴더)를 훑어 지문에 담는다. 문제가 있으면 사유를, 없으면 `None`을 돌려준다
async fn collect(root: &str, relative: &str, digests: &mut Vec<(String, String)>, count: &mut usize) -> Option<String> {
    // 상위 폴더가 링크면 그 너머를 보지 않는다(readProjectFileSync와 같은 규칙)
    if !parents_are_real(root, relative) {
        return Some("상위 폴더가 심볼릭 링크입니다".to_owned());
    }
    let absolute = node_path::join(&[root, relative]);
    let info = match tokio::fs::symlink_metadata(&absolute).await {
        Ok(info) => info,
        Err(error) => {
            let code = errno_name(&error);
            if code == "ENOENT" || code == "ENOTDIR" {
                return None;
            }
            return Some(format!("읽을 수 없습니다({code})"));
        }
    };
    let file_type = info.file_type();
    if file_type.is_symlink() {
        return Some("심볼릭 링크입니다".to_owned());
    }
    if !file_type.is_dir() {
        return record_file(&absolute, relative, digests, count);
    }
    walk_dir(&absolute, relative, digests, count).await
}

/// 폴더 아래의 일반 파일을 모두 지문에 담는다. 링크·특수 파일이 있으면 실패한다
fn walk_dir<'a>(
    dir: &'a str,
    relative: &'a str,
    digests: &'a mut Vec<(String, String)>,
    count: &'a mut usize,
) -> Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + 'a>> {
    Box::pin(async move {
        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(entries) => entries,
            Err(error) => return Some(format!("폴더를 읽지 못했습니다({})", errno_name(&error))),
        };
        let mut items: Vec<(String, std::fs::FileType)> = Vec::new();
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let file_type = match entry.file_type().await {
                        Ok(file_type) => file_type,
                        Err(error) => return Some(format!("폴더를 읽지 못했습니다({})", errno_name(&error))),
                    };
                    items.push((name, file_type));
                }
                Ok(None) => break,
                Err(error) => return Some(format!("폴더를 읽지 못했습니다({})", errno_name(&error))),
            }
        }
        // 옛 코드는 `a.name.localeCompare(b.name)`으로 정렬했다. 여기서는 UTF-16 순서다 — 여러 항목이 동시에 잘못됐을 때
        // 어느 것을 먼저 알리는지만 갈릴 수 있다(판정과 단일 오류의 글은 같다)
        items.sort_by(|a, b| bstudio_guard::js::cmp_utf16(&a.0, &b.0));
        for (name, file_type) in items {
            let child_relative = format!("{relative}/{name}");
            if file_type.is_symlink() {
                return Some(format!("{child_relative}: 심볼릭 링크입니다"));
            }
            if file_type.is_dir() {
                if let Some(error) = walk_dir(&node_path::join(&[dir, &name]), &child_relative, digests, count).await {
                    return Some(error);
                }
            } else if file_type.is_file() {
                if let Some(error) = record_file(&node_path::join(&[dir, &name]), &child_relative, digests, count) {
                    return Some(error);
                }
            } else {
                return Some(format!("{child_relative}: 일반 파일도 폴더도 아닙니다"));
            }
        }
        None
    })
}

/// 일반 파일 하나의 내용을 지문에 담는다. 바이트로 해시한다(글자로 바꾸면 다른 바이트가 같은 글자가 된다)
fn record_file(absolute: &str, relative: &str, digests: &mut Vec<(String, String)>, count: &mut usize) -> Option<String> {
    *count += 1;
    if *count > ga::MAX_FILES {
        return Some(format!("파일이 {}개를 넘습니다 — 선언을 좁히세요", ga::MAX_FILES));
    }
    match workspace_io::read_regular_file(Path::new(absolute), MAX_READ_BYTES) {
        FileRead::Missing => Some("파일이 없습니다".to_owned()),
        FileRead::Irregular(reason) => Some(reason),
        FileRead::Bytes { content, complete } => {
            // 확인한 크기만큼 다 읽지 못했으면 지문을 뜨는 동안 파일이 바뀐 것이다(닫힌 쪽)
            if !complete {
                return Some("읽는 동안 파일이 바뀌었습니다".to_owned());
            }
            let digest = Sha256::digest(&content);
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            digests.push((relative.to_owned(), hex));
            None
        }
    }
}

/// 선언한 평가 자산의 지문을 뜬다(옛 `fingerprintEvaluationAssets`)
pub async fn fingerprint(root: &str, assets: &[String]) -> ga::Baseline {
    let mut digests: Vec<(String, String)> = Vec::new();
    let mut count = 0usize;
    for asset in assets {
        let relative = node_path::normalize(asset);
        if let Some(error) = collect(root, &relative, &mut digests, &mut count).await {
            return ga::Baseline::Error(format!("{asset}: {error}"));
        }
    }
    ga::Baseline::Ok(digests)
}

pub fn baseline_json(baseline: &ga::Baseline) -> String {
    match baseline {
        ga::Baseline::Ok(digests) => json!({
            "kind": "ok",
            "digests": digests.iter().map(|(file, print)| json!([file, print])).collect::<Vec<_>>(),
        })
        .to_string(),
        ga::Baseline::Error(detail) => json!({ "kind": "error", "detail": detail }).to_string(),
    }
}

pub fn parse_baseline(text: &str) -> ga::Baseline {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return ga::Baseline::Error("평가 자산 기준선을 읽지 못했습니다".to_owned());
    };
    if value.get("kind").and_then(Value::as_str) == Some("ok") {
        let digests = value
            .get("digests")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let pair = item.as_array()?;
                        Some((pair.first()?.as_str()?.to_owned(), pair.get(1)?.as_str()?.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        return ga::Baseline::Ok(digests);
    }
    match value.get("detail").and_then(Value::as_str) {
        Some(detail) => ga::Baseline::Error(detail.to_owned()),
        None => ga::Baseline::Error("평가 자산 기준선을 읽지 못했습니다".to_owned()),
    }
}

pub fn checks_json(checks: &[ga::Check]) -> String {
    let items: Vec<Value> = checks
        .iter()
        .map(|check| {
            let mut item = Map::new();
            item.insert("stage".into(), json!(check.stage));
            item.insert("name".into(), json!(ga::CHECK_NAME));
            item.insert("ok".into(), json!(check.ok));
            item.insert("attempts".into(), json!(1));
            if let Some(detail) = &check.detail {
                item.insert("detail".into(), json!(detail));
            }
            Value::Object(item)
        })
        .collect();
    Value::Array(items).to_string()
}

/// `#evaluationAssetChecks` 한 번. `baseline`은 게이트를 만들 때 뜬 지문(TS가 JSON으로 들고 있다)
pub async fn evaluate(root: &str, assets: &[String], baseline: &str, has_tests: bool) -> String {
    let baseline = parse_baseline(baseline);
    let current = fingerprint(root, assets).await;
    checks_json(&ga::checks(!assets.is_empty(), has_tests, &baseline, &current))
}

async fn call_hook(hook: &Hook, request: Value) -> Option<Value> {
    let answer = hook(request.to_string()).await?;
    serde_json::from_str(&answer).ok()
}

/// 화면 확인이 요청해도 되는 출처(옛 `#serviceOrigins`)
pub async fn service_origins(names: &[String], skipped: &[String], hook: Option<&Hook>) -> String {
    let Some(hook) = hook else { return "[]".to_owned() };
    let skipped: std::collections::HashSet<&str> = skipped.iter().map(String::as_str).collect();
    let mut origins: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in names {
        if skipped.contains(name.as_str()) {
            continue;
        }
        let Some(value) = call_hook(hook, json!({ "op": "endpoint", "name": name })).await else { continue };
        if value.get("ok") != Some(&Value::Bool(true)) {
            continue;
        }
        let Some(url) = value.get("url").and_then(Value::as_str) else { continue };
        let Ok(parsed) = url::Url::parse(url) else { continue };
        let origin = parsed.origin().ascii_serialization();
        if seen.insert(origin.clone()) {
            origins.push(origin);
        }
    }
    json!(origins).to_string()
}

/// 단계 스크린샷을 저장하고 식별자를 붙인다(옛 `#saveSteps`). 저장 실패는 경고만 남기고 결과를 바꾸지 않는다
pub async fn save_steps(name: &str, steps_json: &str, has_save: bool, hook: Option<&Hook>) -> String {
    let Ok(value) = serde_json::from_str::<Value>(steps_json) else {
        return json!({ "steps": [], "warnings": [] }).to_string();
    };
    let steps = value.as_array().cloned().unwrap_or_default();
    let mut saved: Vec<Value> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let label = step.get("label").and_then(Value::as_str).unwrap_or("");
        let ok = step.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let mut artifact: Option<String> = None;
        if has_save {
            if let (Some(data), Some(hook)) = (step.get("screenshot").and_then(Value::as_str), hook) {
                let request = json!({
                    "op": "saveArtifact",
                    "name": format!("{name} {}. {label}", index + 1),
                    "data": data,
                    "contentType": "image/png",
                });
                match call_hook(hook, request).await {
                    Some(answer) if answer.get("ok") == Some(&Value::Bool(true)) => {
                        // 옛 코드는 빈 글자를 산출물로 넣지 않았다(`...(artifact ? { artifact } : {})`)
                        artifact = answer.get("artifact").and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned);
                    }
                    Some(answer) => {
                        let message = answer.get("message").and_then(Value::as_str).unwrap_or("알 수 없는 오류");
                        warnings.push(format!("화면 확인 스크린샷을 저장하지 못했습니다: {message}"));
                    }
                    None => warnings.push("화면 확인 스크린샷을 저장하지 못했습니다: 알 수 없는 오류".to_owned()),
                }
            }
        }
        let mut item = Map::new();
        item.insert("label".into(), json!(label));
        item.insert("ok".into(), json!(ok));
        if let Some(detail) = step.get("detail") {
            item.insert("detail".into(), detail.clone());
        }
        if let Some(artifact) = artifact {
            item.insert("artifact".into(), json!(artifact));
        }
        saved.push(Value::Object(item));
    }
    json!({ "steps": saved, "warnings": warnings }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@e"]).args(args).output().expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[tokio::test]
    async fn 지문은_일반_파일을_바이트로_해시하고_폴더를_걷는다() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets/nested")).unwrap();
        std::fs::write(dir.path().join("assets/a.txt"), b"a").unwrap();
        std::fs::write(dir.path().join("assets/nested/b.bin"), [0u8, 1, 255]).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let baseline = fingerprint(&root, &["assets".to_owned()]).await;
        let ga::Baseline::Ok(digests) = baseline else { panic!("지문이어야 한다: {baseline:?}") };
        assert_eq!(digests.iter().map(|(file, _)| file.clone()).collect::<Vec<_>>(), vec!["assets/a.txt".to_owned(), "assets/nested/b.bin".to_owned()]);
        let expected: String = Sha256::digest(b"a").iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(digests[0].1, expected);
    }

    #[tokio::test]
    async fn 링크와_상한은_실패다() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("assets/link")).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        assert_eq!(fingerprint(&root, &["assets".to_owned()]).await, ga::Baseline::Error("assets: assets/link: 심볼릭 링크입니다".to_owned()));
    }

    #[tokio::test]
    async fn 단계는_스크린샷이_없으면_저장하지_않고_있으면_훅을_부른다() {
        let steps = r#"[{"label":"첫째","ok":true},{"label":"둘째","ok":false,"detail":"실패","screenshot":"YQ=="}]"#;
        let hook: Hook = Arc::new(|request| {
            Box::pin(async move {
                if request.contains("\"saveArtifact\"") {
                    Some("{\"ok\":true,\"artifact\":\"a1\"}".to_owned())
                } else {
                    Some("{\"ok\":true}".to_owned())
                }
            })
        });
        let out = save_steps("확인", steps, true, Some(&hook)).await;
        let value: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["steps"], json!([{ "label": "첫째", "ok": true }, { "label": "둘째", "ok": false, "detail": "실패", "artifact": "a1" }]));
        assert_eq!(value["warnings"], json!([]));
    }

    #[tokio::test]
    async fn 저장_실패는_경고만_남긴다() {
        let steps = r#"[{"label":"하나","ok":true,"screenshot":"YQ=="}]"#;
        let hook: Hook = Arc::new(|_| Box::pin(async { Some("{\"ok\":false,\"message\":\"디스크 가득\"}".to_owned()) }));
        let out = save_steps("확인", steps, true, Some(&hook)).await;
        let value: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["steps"], json!([{ "label": "하나", "ok": true }]));
        assert_eq!(value["warnings"], json!(["화면 확인 스크린샷을 저장하지 못했습니다: 디스크 가득"]));
    }

    #[tokio::test]
    async fn 출처는_기본_포트를_지우고_중복과_실패를_뺀다() {
        let hook: Hook = Arc::new(|request| {
            Box::pin(async move {
                let value: Value = serde_json::from_str(&request).unwrap();
                let name = value["name"].as_str().unwrap_or("").to_owned();
                Some(match name.as_str() {
                    "web" => "{\"ok\":true,\"url\":\"http://127.0.0.1:8080/x\"}".to_owned(),
                    "api" => "{\"ok\":true,\"url\":\"http://127.0.0.1:8080/y\"}".to_owned(),
                    "bad" => "{\"ok\":false}".to_owned(),
                    _ => "{\"ok\":true,\"url\":\"https://example.com:443/z\"}".to_owned(),
                })
            })
        });
        let origins = service_origins(&["web".into(), "api".into(), "bad".into(), "edge".into()], &[], Some(&hook)).await;
        assert_eq!(origins, r#"["http://127.0.0.1:8080","https://example.com"]"#);
    }
}
