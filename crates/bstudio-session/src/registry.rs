//! 세션 맵 수준의 상태(ADR-205, 4f B2b): 이어받는 중인 세션(`resuming`)과 내 폴더 세션의 **폴더 점유**. 옛 구현은 `sessions.ts`의 `resuming`·`claimedFolders`·`claimFolder`였다.
//!
//! **폴더 점유는 막는 검사다(거부 목록).** 내 폴더 세션 둘이 같은 폴더를 건드리면 한쪽의 되돌리기가 다른 쪽의 변경을 지운다. 옛 검사는 폴더 경로를 글자로만 비교해
//! 링크로 만든 별칭·끝의 `/`·대소문자만 다른 경로(대소문자를 구분하지 않는 볼륨)로 비켜 갈 수 있었다. 이 모듈은 글자가 같거나 **폴더의 정체**(`stat`의 장치 번호와 inode)가 같으면 같은 폴더로 본다.
//!
//! 정체를 읽지 못할 때(거부 목록이라 모르면 점유된 것으로 본다): 없는 폴더(`NotFound`)는 어떤 폴더의 별칭도 될 수 없으므로 글자 비교만으로 다르다고 본다
//! (시작 자체가 그 폴더를 요구하므로 없는 폴더의 오류는 뒤 단계가 옛 글로 낸다). 그 밖의 읽기 실패(권한 등)는 같은 폴더가 아니라고 증명할 수 없으므로 시작을 거절한다(새 오류 글).

use crate::status::{SessionState, SessionStatus};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// 판정이 거절한 이유. `status`는 HTTP 상태(옛 `StudioError`의 값)다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fail {
    pub status: u16,
    pub message: String,
}

impl Fail {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

/// 폴더의 정체
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Identity {
    Known { dev: u64, ino: u64 },
    /// 없는 폴더다
    Missing,
    /// 읽지 못했다(이유)
    Unknown(String),
}

#[cfg(unix)]
pub fn identity_of(path: &str) -> Identity {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(meta) => Identity::Known { dev: meta.dev(), ino: meta.ino() },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Identity::Missing,
        Err(error) => Identity::Unknown(error.to_string()),
    }
}

#[cfg(not(unix))]
pub fn identity_of(_path: &str) -> Identity {
    Identity::Unknown("이 운영체제에서는 폴더의 정체를 읽지 않습니다".to_owned())
}

#[derive(Debug, PartialEq, Eq)]
enum Same {
    Yes,
    No,
    /// 같은 폴더가 아니라고 증명하지 못했다(이유)
    Unknown(String),
}

/// 폴더 둘이 같은가. 글자가 같거나 정체가 같으면 같다
fn same_folder(a: &str, a_id: &Identity, b: &str, b_id: &Identity) -> Same {
    if a == b {
        return Same::Yes;
    }
    match (a_id, b_id) {
        (Identity::Known { dev: da, ino: ia }, Identity::Known { dev: db, ino: ib }) => {
            if da == db && ia == ib {
                Same::Yes
            } else {
                Same::No
            }
        }
        (Identity::Missing, _) | (_, Identity::Missing) => Same::No,
        (Identity::Unknown(reason), _) | (_, Identity::Unknown(reason)) => Same::Unknown(reason.clone()),
    }
}

struct Entry {
    state: Arc<SessionState>,
    local: bool,
    work_dir: String,
}

struct Claim {
    root: String,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Entry>,
    resuming: HashSet<String>,
    claims: HashMap<u64, Claim>,
    next_claim: u64,
}

#[derive(Default)]
pub struct Registry {
    inner: Mutex<Inner>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 실행 중인 세션(세션 맵에 든 것)을 올린다. 같은 id가 있으면 바꾼다(이어받기가 새 세션으로 바꾼다)
    pub fn register(&self, id: &str, state: Arc<SessionState>, local: bool, work_dir: &str) {
        self.lock().sessions.insert(id.to_owned(), Entry { state, local, work_dir: work_dir.to_owned() });
    }

    pub fn unregister(&self, id: &str) {
        self.lock().sessions.remove(id);
    }

    /// 이어받기를 시작한다(옛 `resumeSession` 머리의 판정). 세션이 실행 중으로도 보관으로도 없으면 404, 실행 중인데 멈추지 않았으면 409, 이미 이어받는 중이면 409.
    /// 통과하면 `resuming`에 넣는다. 끝나면(성공이든 실패든) `end_resume`을 부른다
    pub fn begin_resume(&self, id: &str, archived: bool) -> Result<(), Fail> {
        let mut inner = self.lock();
        let live = inner.sessions.get(id);
        if live.is_none() && !archived {
            return Err(Fail::new(404, "세션을 찾을 수 없습니다"));
        }
        if let Some(entry) = live {
            if entry.state.status() != SessionStatus::Stopped {
                return Err(Fail::new(409, "샌드박스를 중지한 세션만 이어서 작업할 수 있습니다"));
            }
        }
        if inner.resuming.contains(id) {
            return Err(Fail::new(409, "이미 이어서 작업할 준비를 하는 중입니다"));
        }
        inner.resuming.insert(id.to_owned());
        Ok(())
    }

    pub fn end_resume(&self, id: &str) {
        self.lock().resuming.remove(id);
    }

    pub fn resuming(&self, id: &str) -> bool {
        self.lock().resuming.contains(id)
    }

    /// 내 폴더 세션이 쓸 폴더를 잡는다. 두 세션이 같은 폴더를 바꾸면 한쪽의 되돌리기가 다른 쪽의 변경을 지우므로 거부한다(옛 `claimFolder`).
    /// `session_id`는 이어받는 세션 자신이다. 돌려준 번호로 `release_claim`한다. 거부 목록이라 같은 폴더인지 알 수 없으면 거절한다(위 모듈 문서)
    pub fn claim_folder(&self, root: &str, session_id: Option<&str>) -> Result<u64, Fail> {
        let mut inner = self.lock();
        let root_id = identity_of(root);
        let mut unknown: Option<String> = None;
        let mut busy: Option<&str> = None;
        let mut candidates: Vec<(&String, &Entry)> = inner.sessions.iter().filter(|(id, entry)| entry.local && entry.state.status() != SessionStatus::Stopped && Some(id.as_str()) != session_id).collect();
        // 같은 입력에 같은 오류가 나도록 id 순으로 본다
        candidates.sort_by(|a, b| a.0.cmp(b.0));
        for (id, entry) in candidates {
            match same_folder(root, &root_id, &entry.work_dir, &identity_of(&entry.work_dir)) {
                Same::Yes => {
                    busy = Some(id.as_str());
                    break;
                }
                Same::No => {}
                Same::Unknown(reason) => unknown = unknown.or(Some(reason)),
            }
        }
        if let Some(id) = busy {
            return Err(Fail::new(409, format!("이 폴더는 세션 {id}에서 작업하고 있습니다. 그 세션의 샌드박스를 중지한 뒤 시작하세요")));
        }
        for claim in inner.claims.values() {
            match same_folder(root, &root_id, &claim.root, &identity_of(&claim.root)) {
                Same::Yes => return Err(Fail::new(409, "이 폴더로 다른 세션을 시작하는 중입니다. 끝난 뒤 다시 시도하세요")),
                Same::No => {}
                Same::Unknown(reason) => unknown = unknown.or(Some(reason)),
            }
        }
        if let Some(reason) = unknown {
            return Err(Fail::new(409, format!("이 폴더를 다른 세션이 쓰고 있는지 확인하지 못해 시작하지 않았습니다: {root} ({reason})")));
        }
        inner.next_claim += 1;
        let token = inner.next_claim;
        inner.claims.insert(token, Claim { root: root.to_owned() });
        Ok(token)
    }

    pub fn release_claim(&self, token: u64) {
        self.lock().claims.remove(&token);
    }

    pub fn claimed(&self) -> usize {
        self.lock().claims.len()
    }
}

#[cfg(test)]
mod tests;
