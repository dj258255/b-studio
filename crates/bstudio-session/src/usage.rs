//! 사람별 모델 토큰 사용량 파일 `tokens.json`의 주인(ADR-209, 4f B3c). 읽기·더하기·오래된 기간 정리·프로세스 사이 잠금을 이 모듈 하나가 한다.
//! 옛 구현은 `apps/studio/lib/server/usage-state.ts`였다(옛 구현 `usage-state-legacy.ts`는 #1347에서 지웠다). Node를 모른다.
//!
//! 파일 형식과 글자는 옛 `JSON.stringify({ version: 1, periods }, null, 2)`와 같다: `{version:1, periods: {기간: {사람: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}}}}`.
//! 값은 JS의 규칙(`bstudio_guard::js_json`)으로 읽고 써서, 건드리지 않은 사람·기간의 항목은 글자 그대로 남고 키 순서(정수 꼴 키가 먼저)도 JS와 같다.
//! 권한은 폴더 0700·파일 0600이다.
//!
//! - 읽기: 파일이 없으면 쓴 사람이 없다. 파일이 바뀌었을 때만(크기·수정 시각·inode·ctime) 다시 읽는다. 읽을 수 없으면(JSON이 아님·`periods`가 객체가 아님·
//!   쓰는 항목의 수가 아님·읽기 오류·상한 초과) 오류를 돌려준다 — 한도가 조용히 사라지지 않게 한다. 상한은 읽기 전에 파일 크기로 본다
//! - 더하기: 프로세스 안에서는 뮤텍스, 프로세스 사이에서는 `tokens.json.lock` 파일의 배타 잠금(운영체제 파일 잠금이라 프로세스가 죽으면 풀린다)으로 차례로 한다.
//!   잠금 안에서 **파일을 새로 읽고** 더해 임시 파일에 쓴 뒤 rename한다(옛 코드는 읽고-더하고-쓰기 사이에 잠금이 없어 프로세스 둘이 동시에 더하면 한쪽의 몫이 사라졌다).
//!   잠금을 얻지 못하면 기다리되 상한이 있고(`DEFAULT_LOCK_WAIT`), 넘으면 쓰지 않고 오류를 돌려준다(조용히 버리지 않는다). 파일이 읽을 수 없는 상태면 덮어쓰지 않는다
//! - 오래된 기간 정리: 기간 이름을 JS 문자열 순서(UTF-16)로 정렬해 끝 40개만 남긴다
//!
//! 의도한 차이(옛 코드는 조용히 넘어갔다):
//! - 쓰는 항목(사람의 사용량)의 네 값이 수가 아니거나 음수·무한이면 읽을 수 없는 파일로 본다(옛 코드는 NaN으로 계산해 한도 비교가 항상 거짓이 됐다). 값이 없거나 `null`이면 0이다(옛 `?? 0`)
//! - 사람 이름이 `__proto__`여도 그 이름의 사용량으로 센다(옛 구현은 JS 객체의 `__proto__` 대입이라 쓰지 못하고 읽으면 NaN이었다)

use crate::store::{write_file_atomic, TempName};
use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsObject, JsValue};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

pub const FILE: &str = "tokens.json";
pub const LOCK_FILE: &str = "tokens.json.lock";
/// 남겨 두는 기간 수. 지난 기간은 한도 판정에 쓰지 않지만 운영자가 확인할 수 있게 얼마간 둔다
pub const KEEP_PERIODS: usize = 40;
/// 읽는 파일 크기의 상한. 읽기 전에 크기로 본다
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// 잠금을 기다리는 시간의 상한. 파일 하나를 읽고 쓰는 일이라 잠금을 쥐는 시간은 밀리초 단위다
pub const DEFAULT_LOCK_WAIT: Duration = Duration::from_secs(3);

/// 한 사람의 한 기간 사용량(JS의 수와 같은 f64)
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Usage {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Usage {
    /// 화면에 보이는 네 값의 합(`totalTokens`)
    pub fn total(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    fn plus(&self, other: &Usage) -> Usage {
        Usage { input: self.input + other.input, output: self.output + other.output, cache_read: self.cache_read + other.cache_read, cache_write: self.cache_write + other.cache_write }
    }

    fn to_value(self) -> JsValue {
        let mut object = JsObject::new();
        object.set("inputTokens", JsValue::Num(self.input));
        object.set("outputTokens", JsValue::Num(self.output));
        object.set("cacheReadTokens", JsValue::Num(self.cache_read));
        object.set("cacheWriteTokens", JsValue::Num(self.cache_write));
        JsValue::Obj(object)
    }

    /// 더할 값. 수가 아니거나 음수·무한이면 거절한다
    pub fn checked(input: f64, output: f64, cache_read: f64, cache_write: f64) -> Result<Usage, String> {
        for (name, value) in [("inputTokens", input), ("outputTokens", output), ("cacheReadTokens", cache_read), ("cacheWriteTokens", cache_write)] {
            if !value.is_finite() || value < 0.0 {
                return Err(format!("더할 사용량의 {name}이(가) 0 이상의 수가 아닙니다"));
            }
        }
        Ok(Usage { input, output, cache_read, cache_write })
    }
}

/// 값 하나의 읽기. 없거나 `null`이면 0, 0 이상의 유한한 수면 그 값, 아니면 읽을 수 없다
fn field(object: &JsObject, name: &str) -> Result<f64, String> {
    match object.get(name) {
        None | Some(JsValue::Null) => Ok(0.0),
        Some(JsValue::Num(n)) if n.is_finite() && *n >= 0.0 => Ok(*n),
        Some(_) => Err(format!("{name}이(가) 0 이상의 수가 아닙니다")),
    }
}

fn entry_usage(value: &JsValue) -> Result<Usage, String> {
    let JsValue::Obj(object) = value else { return Err("사용량 항목이 객체가 아닙니다".to_owned()) };
    Ok(Usage { input: field(object, "inputTokens")?, output: field(object, "outputTokens")?, cache_read: field(object, "cacheReadTokens")?, cache_write: field(object, "cacheWriteTokens")? })
}

/// 파일이 바뀌었는지 가르는 표시. 열어 둔 파일에서 읽은 것이라 읽은 내용과 짝이 맞는다
#[derive(Clone, Debug, PartialEq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

fn stamp_of(meta: &fs::Metadata) -> Stamp {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Stamp { len: meta.len(), modified: meta.modified().ok(), identity: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()) }
    }
    #[cfg(not(unix))]
    {
        Stamp { len: meta.len(), modified: meta.modified().ok() }
    }
}

type Cache = HashMap<PathBuf, (Stamp, Arc<JsValue>)>;

/// 폴더마다 하나. 시험이 폴더를 많이 만들므로 수를 제한한다
fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const CACHE_LIMIT: usize = 16;

fn read_error(file: &Path, reason: impl std::fmt::Display) -> String {
    format!("{}을(를) 읽지 못했습니다: {reason}", file.display())
}

fn empty_record() -> JsValue {
    let mut root = JsObject::new();
    root.set("version", JsValue::Num(1.0));
    root.set("periods", JsValue::Obj(JsObject::new()));
    JsValue::Obj(root)
}

/// 파일을 읽어 `periods`가 객체인지까지 확인한다. 없으면 `None`
fn load(file: &Path) -> Result<Option<(Stamp, JsValue)>, String> {
    let mut handle = match File::open(file) {
        Ok(handle) => handle,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(read_error(file, error)),
    };
    let meta = handle.metadata().map_err(|error| read_error(file, error))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(read_error(file, format!("파일이 너무 큽니다({}바이트, 상한 {MAX_FILE_BYTES}바이트)", meta.len())));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // 크기를 본 뒤에도 파일이 자랐을 수 있으니 상한까지만 읽는다
    (&mut handle).take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|error| read_error(file, error))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(read_error(file, "파일이 너무 큽니다"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| read_error(file, "UTF-8이 아닙니다"))?;
    let value = js_json::parse(text).map_err(|_| read_error(file, "JSON이 아닙니다"))?;
    match &value {
        JsValue::Obj(root) if matches!(root.get("periods"), Some(JsValue::Obj(_))) => {}
        _ => return Err(read_error(file, "periods가 객체여야 합니다")),
    }
    Ok(Some((stamp_of(&meta), value)))
}

/// 바뀌었을 때만 다시 읽는다. 파일이 없으면 빈 기록이다
fn read_cached(dir: &Path) -> Result<Arc<JsValue>, String> {
    let file = dir.join(FILE);
    let current = match fs::metadata(&file) {
        Ok(meta) => Some(stamp_of(&meta)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(read_error(&file, error)),
    };
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(current) = current else {
        guard.remove(&file);
        return Ok(Arc::new(empty_record()));
    };
    if let Some((stamp, value)) = guard.get(&file) {
        if *stamp == current {
            return Ok(Arc::clone(value));
        }
    }
    // 읽는 동안 잠금을 쥐지 않는다(다른 폴더의 읽기를 막지 않는다)
    drop(guard);
    let loaded = load(&file)?;
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match loaded {
        None => {
            guard.remove(&file);
            Ok(Arc::new(empty_record()))
        }
        Some((stamp, value)) => {
            if guard.len() >= CACHE_LIMIT && !guard.contains_key(&file) {
                guard.clear();
            }
            let value = Arc::new(value);
            guard.insert(file, (stamp, Arc::clone(&value)));
            Ok(value)
        }
    }
}

fn periods_of(root: &JsValue) -> &JsObject {
    match root {
        JsValue::Obj(root) => match root.get("periods") {
            Some(JsValue::Obj(periods)) => periods,
            _ => unreachable!("load가 periods를 확인했다"),
        },
        _ => unreachable!("load가 객체를 확인했다"),
    }
}

/// 이 기간에 그 사람이 쓴 양. 쓴 사람이 없으면 `None`. 읽을 수 없으면 오류
pub fn user_usage(dir: &Path, period: &str, user: &str) -> Result<Option<Usage>, String> {
    let file = dir.join(FILE);
    let root = read_cached(dir)?;
    match periods_of(&root).get(period) {
        None | Some(JsValue::Null) => Ok(None),
        Some(JsValue::Obj(people)) => match people.get(user) {
            None | Some(JsValue::Null) => Ok(None),
            Some(entry) => entry_usage(entry).map(Some).map_err(|reason| read_error(&file, format!("{period}의 {user}: {reason}"))),
        },
        Some(_) => Err(read_error(&file, format!("{period}가 객체가 아닙니다"))),
    }
}

/// 기록 전체를 `{"version":1,"periods":{...}}` 글자로(`JSON.stringify`, 들여쓰기 없음). 없으면 빈 기록
pub fn read_json(dir: &Path) -> Result<String, String> {
    let root = read_cached(dir)?;
    let mut out = JsObject::new();
    out.set("version", JsValue::Num(1.0));
    out.set("periods", JsValue::Obj(periods_of(&root).clone()));
    Ok(js_json::stringify(&JsValue::Obj(out)))
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(|error| format!("폴더를 만들지 못했습니다({}): {error}", dir.display()))
}

/// 프로세스 사이의 잠금을 얻는다. 잠금은 돌려주는 파일을 닫을 때 풀린다
fn acquire(dir: &Path, wait: Duration) -> Result<File, String> {
    let path = dir.join(LOCK_FILE);
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let handle = options.open(&path).map_err(|error| format!("잠금 파일을 열지 못했습니다({}): {error}", path.display()))?;
    let deadline = Instant::now() + wait;
    let mut pause = Duration::from_millis(1);
    loop {
        match handle.try_lock() {
            Ok(()) => return Ok(handle),
            Err(TryLockError::WouldBlock) => {
                let now = Instant::now();
                if now >= deadline {
                    return Err(format!("사용량 파일의 잠금을 {}ms 안에 얻지 못했습니다({}). 쓰지 않았습니다", wait.as_millis(), path.display()));
                }
                std::thread::sleep(pause.min(deadline - now));
                pause = (pause * 2).min(Duration::from_millis(20));
            }
            Err(TryLockError::Error(error)) => return Err(format!("사용량 파일을 잠그지 못했습니다({}): {error}", path.display())),
        }
    }
}

/// 프로세스 안의 차례. 프로세스 사이의 잠금 앞에서 스레드끼리 헛돌지 않게 한다
fn in_process() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 쓴 만큼 더하고 더한 뒤의 그 사람 합계를 돌려준다. 읽을 수 없는 파일은 덮어쓰지 않고, 잠금을 얻지 못하면 쓰지 않는다. 둘 다 오류로 알린다
pub fn add(dir: &Path, period: &str, user: &str, usage: &Usage, wait: Duration) -> Result<Usage, String> {
    ensure_dir(dir)?;
    let _turn = in_process();
    let _lock = acquire(dir, wait)?;
    let file = dir.join(FILE);
    // 잠금 안에서 파일을 새로 읽는다(다른 프로세스가 방금 쓴 것을 놓치지 않는다)
    let root = match load(&file)? {
        Some((_, root)) => root,
        None => empty_record(),
    };
    let periods = periods_of(&root);
    let mut people = match periods.get(period) {
        None | Some(JsValue::Null) => JsObject::new(),
        Some(JsValue::Obj(people)) => people.clone(),
        Some(_) => return Err(read_error(&file, format!("{period}가 객체가 아닙니다"))),
    };
    let before = match people.get(user) {
        None | Some(JsValue::Null) => Usage::default(),
        Some(entry) => entry_usage(entry).map_err(|reason| read_error(&file, format!("{period}의 {user}: {reason}")))?,
    };
    let total = before.plus(usage);
    people.set(user, total.to_value());
    let mut merged = periods.clone();
    merged.set(period, JsValue::Obj(people));
    // 오래된 기간은 이름 순(JS 문자열 순서)으로 정리한다
    let mut names: Vec<&str> = merged.entries().iter().map(|(name, _)| name.as_str()).collect();
    names.sort_by(|a, b| js::cmp_utf16(a, b));
    let mut kept = JsObject::new();
    for name in &names[names.len().saturating_sub(KEEP_PERIODS)..] {
        if let Some(value) = merged.get(name) {
            kept.set(name, value.clone());
        }
    }
    let mut out = JsObject::new();
    out.set("version", JsValue::Num(1.0));
    out.set("periods", JsValue::Obj(kept));
    let text = js_json::stringify_indent(&JsValue::Obj(out), 2, &|s: &str| js::json_quote(s));
    write_file_atomic(&file, text.as_bytes(), Some(0o600), TempName::Random)?;
    Ok(total)
}

#[cfg(test)]
mod tests;
