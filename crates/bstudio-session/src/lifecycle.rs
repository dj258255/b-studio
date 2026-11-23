//! 세션을 지우고 복구하고 이어받는 판정(ADR-204, 4f B2a). 옛 구현은 `sessions.ts`의 `deleteSession`·`assertWithinSessionsRoot`·`recover`였다
//! (옛 구현 `session-lifecycle-legacy.ts`는 #1347에서 지웠다). Node를 모른다. 부수 효과(샌드박스·터미널 정리, 메모리 맵)는 TS가 쥔다.
//!
//! **세션의 `home`**: 세션을 실제로 만든 폴더(`<세션 저장소>/<프로젝트>-<id>`) 또는 읽어 온 폴더다. 저장 파일의 `workDir`·`stateDir` 글자로 정하지 않는다.
//! 옛 구현은 저장 파일의 경로를 글자로만 "저장소 안인가" 확인하고 그 경로를 `rm -rf`하거나 그 경로에서 `git clean`을 했다. 세션 폴더 안의 링크나 `..`는
//! 글자 검사를 지나 저장소 밖과 다른 세션의 폴더를 가리킬 수 있었다.
//!
//! 이 모듈의 검사는 모두 **허용 목록**이다(지워도 되는 것을 좁게 정한다). 확인하지 못하면 지우지 않고 오류다:
//! - 경로는 글자 그대로 구성 요소로 읽는다. 절대 경로이고, 빈 요소(겹친 구분자·끝의 `/`)·`.`·`..`가 있으면 거부한다(`Path::components`는 이것들을 조용히 지우므로 쓰지 않는다)
//! - 대소문자·유니코드 정규화는 접지 않는다. 대소문자를 구분하지 않는 볼륨(macOS 기본)에서는 같은 폴더인 경로도 글자가 다르면 거부한다(더 막을 뿐이다).
//!   `home`은 `readdir`가 돌려준 실제 이름이거나 만들 때 쓴 이름이라 정상 세션은 글자가 같다

use std::fs;

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

/// `packages/sandbox/src/sandbox-id.ts`의 `SANDBOX_ID`: `/^studio-[a-z][a-z0-9-]*-[0-9a-f]{6}$/`. JS의 `$`는 끝에서만 맞으므로(끝 줄바꿈 앞에서 맞지 않는다) 글자 전체를 본다
pub fn is_sandbox_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("studio-") else { return false };
    let bytes = rest.as_bytes();
    // 이름(`[a-z][a-z0-9-]*`, 한 글자 이상) + `-` + 16진수 6자리(소문자)
    if bytes.len() < 1 + 1 + 6 {
        return false;
    }
    let (name, tail) = bytes.split_at(bytes.len() - 7);
    if tail[0] != b'-' || !tail[1..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)) {
        return false;
    }
    name[0].is_ascii_lowercase() && name[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub struct DeleteInput<'a> {
    /// 저장 파일(또는 메모리)의 세션 상태
    pub status: &'a str,
    /// `snapshot.workspace`. 없으면 작업 복사본(`copy`)이다
    pub workspace: Option<&'a str>,
    pub root: &'a str,
    /// 세션을 만들거나 읽어 온 폴더
    pub home: &'a str,
    pub session_id: &'a str,
    /// 저장 파일의 `workDir`. 내 폴더 세션에서는 사용자 폴더다
    pub work_dir: &'a str,
    /// 저장 파일의 `stateDir`(내 폴더 세션만 있다)
    pub state_dir: Option<&'a str>,
}

/// 지우기 전의 판정(디스크를 바꾸지 않는다). 순서와 오류 글은 옛 `deleteSession`과 같다: 상태 → 내 폴더 세션의 상태 폴더 → 폴더.
/// 옛 "세션 저장소 안인가" 글자 검사는 "저장 파일의 폴더가 `home`과 같은가"로 바뀌었다(오류 글은 같은 말을 넓혔다). `home` 자체의 확인은 `check_home`이 한다
pub fn delete_check(input: &DeleteInput) -> Result<(), Fail> {
    // idle(지연 기동, 아직 켜지 않음)은 지울 샌드박스가 없어 그대로 지울 수 있다. 그 밖의 실행 중 상태는 먼저 멈춰야 한다
    if input.status != "stopped" && input.status != "idle" {
        return Err(Fail::new(409, "실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요"));
    }
    let local = input.workspace == Some("local");
    let dir = input.state_dir.unwrap_or(input.work_dir);
    // 내 폴더 세션은 사용자 폴더를 지우면 안 된다. stateDir이 없어 workDir과 같아지면(있어야 하는데 없으면) 안전하게 멈춘다
    if local && dir == input.work_dir {
        return Err(Fail::new(500, "내 폴더 세션의 상태 폴더를 확인하지 못해 지우지 않았습니다"));
    }
    if dir != input.home {
        return Err(Fail::new(500, format!("삭제할 폴더가 세션 저장소 밖에 있거나 이 세션의 폴더가 아닙니다: {dir}")));
    }
    check_home(input.root, input.home, input.session_id, local.then_some(input.work_dir)).map(|_| ()).map_err(home_fail)
}

fn home_fail(reason: String) -> Fail {
    Fail::new(500, format!("세션 폴더를 확인하지 못해 지우지 않았습니다: {reason}"))
}

/// 세션 폴더를 지운다. 지우기 **직전에** `check_home`을 다시 한다(판정과 지우기 사이에 폴더가 바뀔 수 있다). 하나라도 확인하지 못하면 지우지 않는다.
/// `user_dir`은 내 폴더 세션의 사용자 폴더다(없으면 작업 복사본 세션). 폴더가 이미 없으면 지울 것이 없으므로 성공이다(옛 `rm -f`와 같다)
pub fn remove_session_home(root: &str, home: &str, session_id: &str, user_dir: Option<&str>) -> Result<(), Fail> {
    remove_session_home_with(root, home, session_id, user_dir, || {})
}

/// 시험용 틈: `before_remove`는 확인을 마친 뒤 지우기 직전에 불린다(그 사이에 폴더를 바꾸는 경합을 재현한다)
pub(crate) fn remove_session_home_with(root: &str, home: &str, session_id: &str, user_dir: Option<&str>, before_remove: impl FnOnce()) -> Result<(), Fail> {
    match check_home(root, home, session_id, user_dir).map_err(home_fail)? {
        Home::Missing => Ok(()),
        Home::Folder => {
            before_remove();
            // `remove_dir_all`은 링크를 따라가지 않는다: `home`이 그 사이 링크로 바뀌었어도 링크만 지우고, 안의 링크는 링크만 지운다(시험으로 확인)
            fs::remove_dir_all(home).map_err(|error| Fail::new(500, format!("세션 폴더를 지우지 못했습니다({home}): {error}")))
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Home {
    Folder,
    /// 이미 없다
    Missing,
}

/// 글자 그대로의 경로 구성 요소. 절대 경로이고 빈 요소·`.`·`..`·NUL이 없을 때만 있다
fn strict_parts(path: &str) -> Option<Vec<&str>> {
    if cfg!(not(unix)) || !path.starts_with('/') || path.contains('\0') {
        return None;
    }
    if path == "/" {
        return Some(Vec::new());
    }
    let parts: Vec<&str> = path[1..].split('/').collect();
    parts.iter().all(|part| !part.is_empty() && *part != "." && *part != "..").then_some(parts)
}

/// 세션 id가 폴더 이름의 끝에 쓰일 수 있는 글자인가(`randomUUID().slice(0, 8)`). 저장 파일에서 온 값이라 좁게 정한다
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `home`이 지워도 되는 세션 폴더인가. 모두 만족해야 한다(허용 목록):
/// 1. `home`의 부모가 `root`와 같은 경로다(구성 요소 단위, 글자 그대로). `root`는 `/`가 아니다
/// 2. 이름이 `<프로젝트>-<id>` 꼴이다(`-<id>`로 끝나고 앞에 한 글자 이상). 다른 세션의 폴더는 id가 다르다
/// 3. `lstat`로 링크가 아닌 폴더다
/// 4. 내 폴더 세션이면 사용자 폴더(`user_dir`)가 `home`이거나 그 안에 있지 않다(사용자 폴더가 없으면 지울 것도 잃을 것도 없다)
pub fn check_home(root: &str, home: &str, session_id: &str, user_dir: Option<&str>) -> Result<Home, String> {
    let root_parts = strict_parts(root).filter(|parts| !parts.is_empty()).ok_or_else(|| format!("세션 저장소 경로를 글자 그대로 읽지 못했습니다: {root}"))?;
    let home_parts = strict_parts(home).ok_or_else(|| format!("세션 폴더 경로를 글자 그대로 읽지 못했습니다: {home}"))?;
    if home_parts.len() != root_parts.len() + 1 || home_parts[..root_parts.len()] != root_parts[..] {
        return Err(format!("세션 저장소({root}) 바로 아래의 폴더가 아닙니다: {home}"));
    }
    if !valid_session_id(session_id) {
        return Err(format!("세션 id의 꼴이 아닙니다: {session_id}"));
    }
    let name = home_parts[home_parts.len() - 1];
    let suffix = format!("-{session_id}");
    if name.len() <= suffix.len() || !name.ends_with(&suffix) || name.contains('\\') {
        return Err(format!("폴더 이름이 이 세션({session_id})의 것이 아닙니다: {name}"));
    }
    let meta = match fs::symlink_metadata(home) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Home::Missing),
        Err(error) => return Err(format!("폴더를 읽지 못했습니다({home}): {error}")),
    };
    if meta.file_type().is_symlink() {
        return Err(format!("세션 폴더가 링크입니다: {home}"));
    }
    if !meta.is_dir() {
        return Err(format!("세션 폴더가 폴더가 아닙니다: {home}"));
    }
    if let Some(user) = user_dir {
        if user.is_empty() {
            return Err("내 폴더 세션의 사용자 폴더 경로가 비어 있습니다".to_owned());
        }
        if user == home {
            return Err(format!("내 폴더 세션의 사용자 폴더가 세션 폴더와 같습니다: {home}"));
        }
        let home_real = fs::canonicalize(home).map_err(|error| format!("세션 폴더의 실제 경로를 읽지 못했습니다({home}): {error}"))?;
        match fs::canonicalize(user) {
            Ok(user_real) if user_real.starts_with(&home_real) => return Err(format!("내 폴더 세션의 사용자 폴더({user})가 지울 세션 폴더 안에 있습니다")),
            Ok(_) => {}
            // 없는 폴더는 지워져서 잃을 것이 없다
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("사용자 폴더의 실제 경로를 읽지 못했습니다({user}): {error}")),
        }
    }
    Ok(Home::Folder)
}

/// 이어받기 전에 저장 파일이 가리키는 폴더가 `home`과 같은지 본다. 작업 복사본 세션은 `workDir`(과 있으면 `stateDir`)이, 내 폴더 세션은 `stateDir`이 `home`이어야 한다.
/// 내 폴더 세션의 `workDir`(사용자 폴더)은 `home`이 아니어야 하고, 그 폴더를 열어도 되는지는 부르는 쪽(`assertLocalFolderAllowed`)이 본다
pub fn resume_check(home: &str, workspace: Option<&str>, work_dir: &str, state_dir: Option<&str>) -> Result<(), Fail> {
    let local = workspace == Some("local");
    let dir = state_dir.unwrap_or(work_dir);
    let bad = if local { dir != home || work_dir == home } else { dir != home || work_dir != home };
    if bad {
        return Err(Fail::new(409, format!("저장 파일이 가리키는 폴더가 이 세션의 폴더와 달라 이어서 작업하지 않았습니다. 저장 파일이 바뀌었거나 손상됐을 수 있습니다: {dir}")));
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub struct RecoverPlan {
    /// 같은 세션 폴더를 쓰는 다른 스튜디오 프로세스가 실행 중이라 건드리지 않는다
    pub skip: bool,
    /// 서버가 멈춰 끝나지 못한 세션(샌드박스를 정리하고 끝내지 못한 요청을 닫는다). idle은 샌드박스를 켠 적이 없다
    pub interrupted: bool,
    /// 세션 터미널 찌꺼기를 치운다(멈춘 세션은 멈출 때 이미 지웠다. idle에도 있을 수 있다)
    pub cleanup_terminal: bool,
    /// 저장한 샌드박스 id가 b-studio가 만든 id의 꼴이다(아니면 그 id로 컨테이너를 지우지 않는다)
    pub sandbox_id_ok: bool,
}

/// 복구할 때 세션 하나를 어떻게 할지(옛 `recover`의 판정). `owner_alive`는 `owner_pid`가 살아 있는지(TS `isProcessAlive`, 신호 0)다.
/// pid가 0·음수여도 호출 쪽이 같은 함수로 본 결과를 그대로 쓴다(`kill(0, 0)`은 자기 프로세스 그룹이라 살아 있다고 나온다)
pub fn recover_plan(status: &str, owner_pid: f64, self_pid: f64, owner_alive: bool, sandbox_id: &str) -> RecoverPlan {
    RecoverPlan {
        skip: owner_pid != self_pid && owner_alive,
        interrupted: status != "stopped" && status != "idle",
        cleanup_terminal: status != "stopped",
        sandbox_id_ok: is_sandbox_id(sandbox_id),
    }
}

#[cfg(test)]
mod tests;
