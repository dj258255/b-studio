//! 서버가 멈춰 끝나지 못한 요청과 되돌리기를 닫는다(ADR-203, 4f B1b). 옛 `session-store.ts`의 `closeUnfinished`와 같은 결과를 기록 끝에 덧붙인다.
//! 그대로 두면 다시 그린 화면이 "처리 중"에 멈춘다.
//!
//! 이벤트의 필드는 JS와 같게 읽는다: `event.type === '…'`(글자여야 같다), `event.runId`(없으면 `undefined`, `Set`은 `SameValueZero`라 `-0`과 `0`·`NaN`끼리 같고
//! 객체는 늘 다른 값이다), `if (openRestore)`·`if (openBackupRestore)`(JS의 참·거짓), 없는 필드(`undefined`)는 새 이벤트에서 키가 빠진다(`JSON.stringify`).
//! 유한하지 않은 수는 기록에서 표시 객체라 수로 풀어 읽는다. `null` 이벤트는 옛 구현이 던졌다(`null.type`): 알리고 아무것도 덧붙이지 않는다.

use crate::json_text::{parse_encoded, revive_shallow, write_identity, ReadFail};
use crate::scan::{scan_document, Member, Scanned};
use crate::SessionRecord;
use bstudio_guard::js;
use bstudio_guard::js_json::JsValue;

/// `Set`의 `SameValueZero`로 견주는 `runId`
#[derive(PartialEq, Eq)]
enum RunKey {
    Undefined,
    Null,
    Bool(bool),
    /// -0은 0으로, NaN은 하나로 맞춘 비트
    Number(u64),
    Text(String),
    /// 객체·배열: 같은 객체가 아니면 다른 값이다(이벤트마다 새로 읽은 객체라 서로 같지 않다)
    Unique(u64),
}

struct OpenRun {
    key: RunKey,
    value: Option<JsValue>,
}

fn field(text: &str, members: &[Member], name: &str) -> Result<Option<JsValue>, String> {
    // 같은 키가 여러 번이면 마지막 값이다(`JSON.parse`)
    let Some(member) = members.iter().rfind(|member| member.key == name) else { return Ok(None) };
    match parse_encoded(&text[member.value.clone()]) {
        Ok(value) => Ok(Some(revive_shallow(value))),
        Err(ReadFail::Invalid) => Err("기록의 이벤트가 JSON이 아닙니다".to_owned()),
        Err(ReadFail::TooDeep) => Err(format!("이벤트의 {name} 값이 너무 깊어(2,000단계 초과) 읽지 못했습니다")),
    }
}

fn type_of(text: &str, members: &[Member]) -> Result<Option<String>, String> {
    Ok(match field(text, members, "type")? {
        Some(JsValue::Str(name)) => Some(name),
        _ => None,
    })
}

fn truthy(value: &Option<JsValue>) -> bool {
    value.as_ref().is_some_and(JsValue::truthy)
}

/// 새 이벤트의 한 키(`undefined`면 키를 쓰지 않는다)
fn member(out: &mut String, key: &str, value: &Option<JsValue>) {
    if let Some(value) = value {
        out.push(',');
        out.push_str(&js::json_quote(key));
        out.push(':');
        out.push_str(&write_identity(value));
    }
}

fn event_text(kind: &str, members: &[(&str, Option<JsValue>)], tail: &[(&str, &str)]) -> String {
    let mut out = format!("{{\"type\":{}", js::json_quote(kind));
    for (key, value) in members {
        member(&mut out, key, value);
    }
    for (key, text) in tail {
        out.push_str(&format!(",{}:{}", js::json_quote(key), js::json_quote(text)));
    }
    out.push('}');
    out
}

fn normalized(value: Option<JsValue>) -> Option<JsValue> {
    match value {
        // `Set.prototype.add`는 -0을 +0으로 바꿔 넣는다
        Some(JsValue::Num(n)) if n == 0.0 => Some(JsValue::Num(0.0)),
        other => other,
    }
}

impl SessionRecord {
    /// 끝나지 못한 요청·되돌리기·원격 동기화(옛 배포 포함)를 닫는 이벤트를 history 끝에 덧붙인다(상한 없이). 덧붙인 개수를 돌려준다.
    /// 이벤트 하나라도 읽지 못하면(JSON이 아니거나 `null`이거나 필드가 너무 깊다) 아무것도 덧붙이지 않고 알린다
    pub fn close_unfinished(&mut self, reason: &str) -> Result<usize, String> {
        let mut open_runs: Vec<OpenRun> = Vec::new();
        let mut open_restore: Option<JsValue> = None;
        let mut open_remote_sync = false;
        let mut open_backup_restore: Option<JsValue> = None;
        let mut open_deploy: Option<(Option<JsValue>, Option<JsValue>)> = None;
        let mut unique = 0_u64;

        for text in self.history() {
            let members = match scan_document(text) {
                Scanned::Object(members) => members,
                Scanned::NotObject => {
                    // 옛 구현은 `null.type`에서 던졌다. 그 밖의 값(수·글자·배열)은 `type`이 없을 뿐이다
                    if text.trim_matches([' ', '\t', '\n', '\r']) == "null" {
                        return Err("기록에 null 이벤트가 있어 끝나지 못한 요청을 닫지 못했습니다".to_owned());
                    }
                    continue;
                }
                Scanned::Invalid => return Err("기록의 이벤트가 JSON이 아닙니다".to_owned()),
            };
            let Some(kind) = type_of(text, &members)? else { continue };
            match kind.as_str() {
                "deploy_started" => open_deploy = Some((field(text, &members, "action")?, field(text, &members, "target")?)),
                "deploy_finished" | "deploy_failed" => open_deploy = None,
                "run_started" => {
                    let value = normalized(field(text, &members, "runId")?);
                    let key = match &value {
                        None => RunKey::Undefined,
                        Some(JsValue::Null) => RunKey::Null,
                        Some(JsValue::Bool(on)) => RunKey::Bool(*on),
                        Some(JsValue::Num(n)) => RunKey::Number(if n.is_nan() { f64::NAN.to_bits() } else { n.to_bits() }),
                        Some(JsValue::Str(text)) => RunKey::Text(text.clone()),
                        Some(JsValue::Arr(_) | JsValue::Obj(_)) => {
                            unique += 1;
                            RunKey::Unique(unique)
                        }
                    };
                    if !open_runs.iter().any(|run| run.key == key) {
                        open_runs.push(OpenRun { key, value });
                    }
                }
                "run_finished" => {
                    let value = normalized(field(text, &members, "runId")?);
                    let key = match &value {
                        None => Some(RunKey::Undefined),
                        Some(JsValue::Null) => Some(RunKey::Null),
                        Some(JsValue::Bool(on)) => Some(RunKey::Bool(*on)),
                        Some(JsValue::Num(n)) => Some(RunKey::Number(if n.is_nan() { f64::NAN.to_bits() } else { n.to_bits() })),
                        Some(JsValue::Str(text)) => Some(RunKey::Text(text.clone())),
                        // 방금 읽은 객체는 어느 것과도 같지 않다
                        Some(JsValue::Arr(_) | JsValue::Obj(_)) => None,
                    };
                    if let Some(key) = key {
                        open_runs.retain(|run| run.key != key);
                    }
                }
                "restore_started" => open_restore = field(text, &members, "checkpoint")?,
                "restored" | "restore_failed" => open_restore = None,
                "backup_restore_started" => open_backup_restore = field(text, &members, "backupId")?,
                "backup_restored" | "backup_restore_failed" => open_backup_restore = None,
                "remote_sync_started" => open_remote_sync = true,
                "remote_synced" | "remote_sync_failed" => open_remote_sync = false,
                _ => {}
            }
        }

        let mut closing: Vec<String> = Vec::new();
        for run in open_runs {
            closing.push(event_text("run_finished", &[("runId", run.value)], &[("status", "error"), ("summary", reason)]));
        }
        if truthy(&open_restore) {
            closing.push(event_text("restore_failed", &[("checkpoint", open_restore)], &[("error", reason)]));
        }
        if truthy(&open_backup_restore) {
            closing.push(event_text("backup_restore_failed", &[("backupId", open_backup_restore)], &[("error", reason)]));
        }
        if open_remote_sync {
            closing.push(event_text("remote_sync_failed", &[], &[("error", reason)]));
        }
        if let Some((action, target)) = open_deploy {
            closing.push(event_text("deploy_failed", &[("action", action), ("target", target)], &[("error", reason)]));
        }
        let count = closing.len();
        for text in closing {
            self.append(text)?;
        }
        Ok(count)
    }
}
