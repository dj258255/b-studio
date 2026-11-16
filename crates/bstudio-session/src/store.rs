//! 세션 파일을 쓰고 읽는다(ADR-203, 4f B1b). 옛 `session-store.ts`의 `writeSession`·`writeSessionSync`·`readSessions`와 같은 결과를 낸다.
//!
//! 쓰기: 폴더 만들기 → 임시 파일 → rename. 쓰는 도중 멈춰도 이전 파일이 남는다. 임시 파일 이름은 호출마다 달라야 한다
//! (같으면 같은 세션 파일에 동시에 쓰는 두 저장이 서로의 임시 파일을 지우고 rename이 깨진다).
//! 파일의 글자는 옛 `JSON.stringify(toPersisted(session))`와 바이트까지 같다: TS가 `head`(`version`~`snapshot`)와 `tail`(`history` 뒤의 키들)을 주고
//! 가운데에 기록의 저장용 history를 끼운다.

use crate::json_text::{event_from_file, event_to_file, parse_encoded};
use crate::scan::{scan_document, split_array, Scanned};
use crate::SessionRecord;
use bstudio_guard::js_json::JsValue;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 세션 상태 폴더 안의 저장 위치
const FILE: [&str; 3] = [".git", "b-studio", "session.json"];

/// 세션 폴더의 저장 파일(`sessionFile`)
pub fn session_file(state_dir: &Path) -> PathBuf {
    FILE.iter().fold(state_dir.to_path_buf(), |path, part| path.join(part))
}

/// 임시 파일 이름의 끝. 비동기 쓰기는 호출마다 다른 무작위 8자, 종료 신호 처리의 동기 쓰기는 `exit`(진행 중인 비동기 쓰기와 같은 임시 파일을 쓰지 않는다)
#[derive(Clone, Copy)]
pub enum TempName {
    Random,
    Exit,
}

fn random_suffix() -> String {
    use std::hash::{BuildHasher, Hasher};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    // RandomState는 프로세스마다·인스턴스마다 다른 키를 쓴다. 호출 순번을 섞어 한 프로세스 안에서 겹치지 않게 한다
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    format!("{:08x}", hasher.finish() & 0xffff_ffff)
}

fn temp_path(file: &Path, name: TempName) -> PathBuf {
    let mut text = file.as_os_str().to_owned();
    text.push(format!(".{}.{}.tmp", std::process::id(), match name {
        TempName::Random => random_suffix(),
        TempName::Exit => "exit".to_owned(),
    }));
    PathBuf::from(text)
}

/// 폴더를 만들고 임시 파일에 쓴 뒤 이름을 바꾼다. 실패하면 우리가 만든 임시 파일만 지운다(그 이름은 이번 호출이 새로 만든 일반 파일이다)
pub fn write_file_atomic(file: &Path, bytes: &[u8], mode: Option<u32>, name: TempName) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("폴더를 만들지 못했습니다({}): {error}", dir.display()))?;
    }
    let mut attempt = 0;
    let (temp, mut handle) = loop {
        let temp = temp_path(file, name);
        let mut options = fs::OpenOptions::new();
        options.write(true);
        // 동시 쓰기의 이름이 우연히 겹치면(8자) 남의 임시 파일을 덮지 않고 새 이름을 고른다. 종료용 이름은 고정이라 이전 종료 때 남은 파일을 덮는다
        match name {
            TempName::Random => options.create_new(true),
            TempName::Exit => options.create(true).truncate(true),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode.unwrap_or(0o666));
        }
        #[cfg(not(unix))]
        let _ = mode;
        match options.open(&temp) {
            Ok(handle) => break (temp, handle),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 8 => attempt += 1,
            Err(error) => return Err(format!("임시 파일을 만들지 못했습니다({}): {error}", temp.display())),
        }
    };
    let written = handle.write_all(bytes).and_then(|()| handle.flush());
    drop(handle);
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(format!("임시 파일에 쓰지 못했습니다({}): {error}", temp.display()));
    }
    if let Err(error) = fs::rename(&temp, file) {
        let _ = fs::remove_file(&temp);
        return Err(format!("임시 파일의 이름을 바꾸지 못했습니다({}): {error}", file.display()));
    }
    Ok(())
}

fn is_object_text(text: &str) -> bool {
    text.starts_with('{') && text.ends_with('}')
}

/// 저장 파일의 바이트를 만든다: `head`의 끝 `}`를 떼고 `,"history":[...],` 뒤에 `tail`의 앞 `{`를 뗀 것을 잇는다.
/// `trimmed`가 참이면 저장용 history(`trimHistory`)를, 거짓이면 기록 전체를 쓴다. `head`·`tail`이 객체 글자가 아니면 쓰지 않고 알린다
pub fn build_session_bytes(record: &SessionRecord, head: &str, tail: &str, trimmed: bool) -> Result<Vec<u8>, String> {
    if !is_object_text(head) || head.len() < 2 {
        return Err("저장할 상태의 앞부분(head)이 JSON 객체 글자가 아닙니다".to_owned());
    }
    if !is_object_text(tail) || tail.len() < 2 {
        return Err("저장할 상태의 뒷부분(tail)이 JSON 객체 글자가 아닙니다".to_owned());
    }
    let events = if trimmed { record.trimmed_history() } else { record.history() };
    let mut out = String::with_capacity(head.len() + tail.len() + events.iter().map(|event| event.len() + 1).sum::<usize>() + 16);
    out.push_str(&head[..head.len() - 1]);
    // 객체가 비어 있으면(`{}`) 앞에 쉼표를 붙이지 않는다(`JSON.stringify`는 빈 객체에 쉼표를 쓰지 않는다)
    out.push_str(if head.len() == 2 { "\"history\":[" } else { ",\"history\":[" });
    for (at, event) in events.iter().enumerate() {
        if at > 0 {
            out.push(',');
        }
        out.push_str(&event_to_file(event)?);
    }
    out.push(']');
    // tail이 `{}`면 history 다음에 키가 없다
    if tail.len() > 2 {
        out.push(',');
        out.push_str(&tail[1..]);
    } else {
        out.push('}');
    }
    Ok(out.into_bytes())
}

pub struct StoredSession {
    /// `history`를 뺀 나머지 JSON 객체 글자(멤버의 원문을 그대로 잇는다)
    pub rest: String,
    /// 파일의 history를 올린 기록(logs 없음). `history_error`가 있으면 비어 있다
    pub record: SessionRecord,
    /// history를 기록에 올리지 못한 이유(없거나 배열이 아니거나, 원소가 JSON 문법 밖이거나 너무 깊다). 그 세션만 건너뛰어야 한다
    pub history_error: Option<String>,
}

/// Node의 문자열 길이 상한(`buffer.constants.MAX_STRING_LENGTH`). 이보다 큰 파일은 `readFile(…, 'utf8')`가 던져 옛 구현도 건너뛴다
const MAX_FILE_BYTES: u64 = 0x1fff_ffe8;

fn truthy_member(value: Option<&JsValue>) -> bool {
    value.is_some_and(JsValue::truthy)
}

/// `Number.isInteger`
fn is_integer(value: Option<&JsValue>) -> bool {
    matches!(value, Some(JsValue::Num(n)) if n.is_finite() && n.fract() == 0.0)
}

/// 옛 `readSessions`의 형식 검사: `data?.version === 1 && data.snapshot?.id && data.snapshot.workDir && data.sandbox?.id && Number.isInteger(data.owner?.pid)`.
/// JS의 참·거짓과 같다(빈 글자·0·`false`·`null`은 거짓, 수 `1.0`·`1e0`은 1). 읽지 못한 멤버(너무 깊다)는 통과가 아니라 형식이 다른 것으로 본다
fn format_ok(text: &str, members: &[crate::scan::Member]) -> bool {
    // 같은 키가 여러 번이면 마지막 값이다(`JSON.parse`)
    let last = |name: &str| members.iter().rfind(|member| member.key == name).map(|member| &text[member.value.clone()]);
    let read = |name: &str| last(name).and_then(|value| parse_encoded(value).ok());
    let version = read("version");
    if !matches!(version, Some(JsValue::Num(n)) if n == 1.0) {
        return false;
    }
    let snapshot = read("snapshot");
    let sandbox = read("sandbox");
    let owner = read("owner");
    truthy_member(snapshot.as_ref().and_then(|value| value.prop("id")))
        && truthy_member(snapshot.as_ref().and_then(|value| value.prop("workDir")))
        && truthy_member(sandbox.as_ref().and_then(|value| value.prop("id")))
        && is_integer(owner.as_ref().and_then(|value| value.prop("pid")))
}

/// 파일 글자 하나를 읽는다. 형식이 다르거나 JSON이 아니면 없다
fn read_session_text(text: &str) -> Option<StoredSession> {
    let Scanned::Object(members) = scan_document(text) else { return None };
    if !format_ok(text, &members) {
        return None;
    }
    let mut rest = String::from("{");
    let mut first = true;
    for member in members.iter().filter(|member| member.key != "history") {
        if !first {
            rest.push(',');
        }
        first = false;
        rest.push_str(&text[member.text.clone()]);
    }
    rest.push('}');

    let mut record = SessionRecord::new(false);
    let history_error = match load_history(text, &members) {
        Ok(events) => record.replace_history(events).err(),
        Err(error) => Some(error),
    };
    Some(StoredSession { rest, record, history_error })
}

fn load_history(text: &str, members: &[crate::scan::Member]) -> Result<Vec<String>, String> {
    let Some(member) = members.iter().rfind(|member| member.key == "history") else { return Err("저장 파일에 history가 없습니다".to_owned()) };
    let Some(items) = split_array(text, member.value.clone()) else { return Err("저장 파일의 history가 배열이 아닙니다".to_owned()) };
    items.into_iter().map(|range| event_from_file(&text[range])).collect()
}

/// 세션 폴더들에서 저장된 세션을 읽는다(옛 `readSessions`). 폴더 이름의 바이트 순서로 읽는다(Node `readdir`는 이름순으로 돌려준다).
/// 폴더가 아닌 항목(링크 포함), 읽을 수 없는 파일, JSON이 아니거나 형식이 다른 파일은 건너뛴다
pub fn read_sessions(root: &Path) -> Vec<StoredSession> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut names: Vec<std::ffi::OsString> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name())
        .collect();
    sort_names(&mut names);
    let mut sessions = Vec::new();
    for name in names {
        let file = session_file(&root.join(&name));
        let Ok(meta) = fs::metadata(&file) else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&file) else { continue };
        // Node의 `readFile(…, 'utf8')`처럼 틀린 바이트는 U+FFFD로 읽는다. BOM은 떼지 않는다(`JSON.parse`가 거절한다)
        let text = String::from_utf8_lossy(&bytes);
        if let Some(session) = read_session_text(&text) {
            sessions.push(session);
        }
    }
    sessions
}

#[cfg(unix)]
fn sort_names(names: &mut [std::ffi::OsString]) {
    use std::os::unix::ffi::OsStrExt;
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
}

#[cfg(not(unix))]
fn sort_names(names: &mut [std::ffi::OsString]) {
    names.sort();
}

#[cfg(test)]
mod tests;
