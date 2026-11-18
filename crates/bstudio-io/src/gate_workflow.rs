//! 게이트가 끝에 다시 읽는 두 파일(ADR-157·164, 2단계 (b)). 판정은 `bstudio-guard`가 하고,
//! 여기는 파일 읽기(작업 공간과 같은 `workspace_io::read_project_file`)와 조율만 한다.
//!
//! **막는 쪽이다.** 읽지 못하는 파일 자리(링크·일반 파일 아님·너무 큼)는 "문서가 없다"로 넘기지 않고 실패로 돌려준다.
//! `#requirementRecordChecks`는 실행 전 스냅샷(TS 상태)과 지금 파일을 견주고, 다르면 요구사항 기록 판정을 돌린다.
//! 요구사항 id는 TS의 `parseRequirementsMarkdown` 결과가 필요하므로 `Hook`으로 받는다(판정 자체는 Rust).

use std::path::Path;

use bstudio_guard::js_json::{JsObject, JsValue};
use bstudio_guard::requirement_integrity::{review_requirement_records, MANUAL_VERIFICATION_CHECK};
use bstudio_guard::requirements::REQUIREMENTS_FILE;
use bstudio_guard::spec_load::{SpecFailure, SPEC_FILE};
use serde_json::Value;

use crate::checkpoint_remote::Hook;
use crate::workspace_io::{self, FileRead};

/// 옛 `readProjectFileSync`의 기본 상한(256KiB, `workspace.ts`의 `MAX_READ_BYTES`)
const MAX_READ_BYTES: f64 = 256.0 * 1024.0;

fn read_project_file(root: &str, relative: &str) -> FileRead {
    workspace_io::read_project_file(Path::new(root), relative, MAX_READ_BYTES)
}

async fn read_project_file_async(root: String, relative: String) -> FileRead {
    match tokio::task::spawn_blocking(move || read_project_file(&root, &relative)).await {
        Ok(read) => read,
        // 읽기 작업이 패닉하면 읽지 못한 것으로 본다(통과가 아니다)
        Err(_) => FileRead::Irregular("읽을 수 없습니다".to_owned()),
    }
}

pub enum LatestWorkflow {
    Missing,
    Irregular(String),
    /// `None`이면 스키마에 workflow가 없다
    Workflow(Option<JsValue>),
    SpecError(SpecFailure),
}

/// `#latestWorkflow`의 파일 읽기·`loadProject` 판정. `always`와 바뀐 파일 판정(TS 상태)은 부르는 쪽이 한다
pub async fn latest_workflow(root: &str) -> LatestWorkflow {
    match read_project_file_async(root.to_owned(), SPEC_FILE.to_owned()).await {
        FileRead::Missing => LatestWorkflow::Missing,
        FileRead::Irregular(reason) => LatestWorkflow::Irregular(reason),
        FileRead::Bytes { .. } => match crate::spec_load::load_project(root).await {
            Ok(project) => LatestWorkflow::Workflow(project.prop("spec").and_then(|spec| spec.prop("workflow")).cloned()),
            Err(failure) => LatestWorkflow::SpecError(failure),
        },
    }
}

/// `#latestWorkflow` 결과를 napi가 그대로 돌려줄 JSON으로
pub fn latest_workflow_json(result: &LatestWorkflow) -> String {
    let mut out = JsObject::new();
    match result {
        LatestWorkflow::Missing => {
            out.set("kind", JsValue::Str("missing".to_owned()));
        }
        LatestWorkflow::Irregular(reason) => {
            out.set("kind", JsValue::Str("irregular".to_owned()));
            out.set("reason", JsValue::Str(reason.clone()));
        }
        LatestWorkflow::Workflow(workflow) => {
            out.set("kind", JsValue::Str("ok".to_owned()));
            if let Some(workflow) = workflow {
                out.set("workflow", workflow.clone());
            }
        }
        LatestWorkflow::SpecError(failure) => {
            out.set("kind", JsValue::Str("specError".to_owned()));
            out.set("message", JsValue::Str(failure.message.clone()));
            out.set("issues", JsValue::Arr(failure.issues.iter().cloned().map(JsValue::Str).collect()));
        }
    }
    bstudio_guard::js_json::to_native(&JsValue::Obj(out))
}

fn text_of(read: FileRead) -> Result<Option<String>, FileRead> {
    match read {
        FileRead::Missing => Ok(None),
        FileRead::Irregular(reason) => Err(FileRead::Irregular(reason)),
        FileRead::Bytes { content, .. } => Ok(Some(String::from_utf8_lossy(&content).into_owned())),
    }
}

fn ids_from_reply(reply: &str) -> Option<(Vec<String>, Vec<String>, Vec<String>)> {
    let value: Value = serde_json::from_str(reply).ok()?;
    let list = |key: &str| value.get(key).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>());
    Some((list("beforeEffective")?, list("afterEffective")?, list("afterIds")?))
}

/// `#requirementRecordChecks`의 파일 읽기·판정. `before`는 실행 시작 때 TS가 고정한 스냅샷의 글자다
pub async fn requirement_record_checks(root: &str, before: Option<String>, hook: &Hook) -> Result<String, String> {
    let after = match text_of(read_project_file_async(root.to_owned(), REQUIREMENTS_FILE.to_owned()).await) {
        Ok(text) => text,
        Err(FileRead::Irregular(reason)) => {
            let mut check = JsObject::new();
            check.set("stage", JsValue::Str("review".to_owned()));
            check.set("name", JsValue::Str(MANUAL_VERIFICATION_CHECK.to_owned()));
            check.set("ok", JsValue::Bool(false));
            check.set("attempts", JsValue::Num(1.0));
            check.set(
                "detail",
                JsValue::Str(format!("{REQUIREMENTS_FILE}을(를) 읽을 수 없어 검증 기록을 견줄 수 없습니다: {reason}. 일반 파일로 되돌리세요")),
            );
            return Ok(bstudio_guard::js_json::to_native(&JsValue::Arr(vec![JsValue::Obj(check)])));
        }
        Err(_) => unreachable!(),
    };
    if before == after {
        return Ok("[]".to_owned());
    }
    let request = serde_json::json!({ "before": before, "after": after }).to_string();
    let reply = hook(request).await.ok_or_else(|| "요구사항 id 계산에 실패했습니다".to_owned())?;
    let (before_effective, after_effective, after_ids) = ids_from_reply(&reply).ok_or_else(|| "요구사항 id 결과를 읽지 못했습니다".to_owned())?;
    let before_text = before.as_deref().map(bstudio_guard::js::encode_lone_surrogates);
    let after_text = after.as_deref().map(bstudio_guard::js::encode_lone_surrogates);
    let checks = review_requirement_records(before_text.as_deref(), after_text.as_deref(), &before_effective, &after_effective, &after_ids);
    serde_json::to_string(&checks).map_err(|error| error.to_string())
}
