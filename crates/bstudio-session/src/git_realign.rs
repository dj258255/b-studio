//! Git 맞추기·되돌리기 조합·직접 수정 가르기의 판정(ADR-218, 4f B5d). 옛 구현은 `sessions.ts`의 `realignGit`·`rememberGit`·`initialGitMemory`·`revertRunDetailed`·`commitLocalEdits`였다
//! (`session-git-realign-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다. Git 읽기·행동(`reset`·`checkout`·`commit`)과 알림·글 조립은 TS가 하고, 여기는 **사실 조합 → 할 일 하나**만 정한다.
//!
//! **판정을 부르는 자리마다 막는 쪽인가 여는 쪽인가**(AGENTS.md "막는 검사를 고칠 때"):
//! - `decide_realign`: 풀기(`Unwind`)는 에이전트가 얹은 커밋을 검증 대상으로 되돌리는 **막는 쪽**이다. 그러나 `Same`은 "기억을 믿는다"는 **여는 쪽**이라 HEAD·브랜치가 둘 다 기억과 글자까지 같을 때만 선다.
//!   모르는 모양(분리된 HEAD, 브랜치 이름이 다름, 조상이 아님)은 모두 `Restore`(보관본을 남기고 기억한 체크포인트로 되돌림)다
//! - `after_action`: 풀거나 되돌린 **뒤에 다시 읽은** 끝 상태가 기억과 같을 때만 받아들인다(N14). 읽지 못했으면 같지 않은 것이다
//! - `decide_remember`·`decide_initial_memory`: 기억에 넣는 자리는 **여는 쪽**이다(다음 맞추기가 이 값을 믿는다). 머리·브랜치·원격 주소 중 하나라도 읽지 못했으면 기억하지 않는다
//! - `plan_revert`: 되돌리는 쪽(막는 쪽)이다. 되돌리지 못하면(`Fail`) 닫는다. 문서를 지키는 칸(`protect_docs`)은 게이트 없이 문서를 커밋하는 **여는 쪽**이라 읽기만 요청의 위반에서는 열지 않는다(N13)
//! - `split_local_edits`: 직접 수정(게이트 없이 커밋)으로 남기는 칸은 **여는 쪽**이다. 남긴 에이전트 변경과 이름이 맞으면(넓게 맞춘다) 직접 수정이 아니라 변경으로 남긴다(N12). 이름을 알아볼 수 없는 항목은 모든 파일과 맞는다
//!
//! 의도한 차이(옛 코드와 다른 칸. 나머지는 사실 조합 전체가 같다):
//! - 풀거나 되돌린 뒤 끝 상태를 다시 읽는다(옛 코드는 부른 `git` 명령이 성공하면 믿었다)
//! - 복원(`restoreCheckpoint`) 뒤에는 다시 읽은 HEAD가 아니라 복원 대상을 기억한다(`decide_remember`의 `created`)
//! - 읽기만 요청의 되돌리기는 문서를 체크포인트로 지키지 않는다
//! - 원격 주소를 읽지 못하면 기억하지 않는다(옛 코드는 "원격 없음"으로 기억했다)
//! - 남긴 에이전트 변경은 직접 수정으로 커밋하지 않는다

use bstudio_guard::path_policy::canonical_project_path;

// ── 맞추기 ──────────────────────────────────────────────────────────────

/// 맞추기 판정의 사실. `ancestor`는 같은 브랜치에서 HEAD가 기억과 다를 때만 필요하다(`NeedAncestor`)
#[derive(Clone, Copy, Debug)]
pub struct RealignFacts<'a> {
    pub remembered_head: &'a str,
    pub remembered_branch: &'a str,
    pub head: &'a str,
    /// 분리된 HEAD면 없다
    pub branch: Option<&'a str>,
    /// 기억한 체크포인트가 지금 HEAD의 조상인가(읽지 않았으면 `None`)
    pub ancestor: Option<bool>,
    pub allow_unwind: bool,
}

/// 되돌리는 까닭
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// HEAD가 브랜치가 아니라 커밋을 가리킨다
    Detached,
    /// 브랜치가 다르다
    BranchChanged,
    /// 같은 브랜치의 기억한 체크포인트 위에 b-studio가 만들지 않은 커밋이 있다(풀 수 없는 때: 읽기만 등)
    ForeignCommits,
    /// 기억한 체크포인트가 HEAD의 조상이 아니다(되감거나 고쳤다)
    Rewound,
    /// 풀거나 되돌리는 동안 HEAD·브랜치가 또 바뀌었다(N14)
    MovedDuringAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Realign {
    Same,
    Unwind,
    Restore(Reason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RealignStep {
    /// 같은 브랜치에서 HEAD가 다르다. 기억한 체크포인트가 조상인지 읽어서 다시 부른다
    NeedAncestor,
    Done(Realign),
}

/// 지금 HEAD·브랜치가 기억과 같은가(글자까지)
pub fn is_aligned(remembered_head: &str, remembered_branch: &str, head: &str, branch: Option<&str>) -> bool {
    head == remembered_head && branch == Some(remembered_branch)
}

/// 맞추기 판정. 같음 → (조상 읽기) → 풀기 또는 되돌리기
pub fn decide_realign(f: &RealignFacts) -> RealignStep {
    if is_aligned(f.remembered_head, f.remembered_branch, f.head, f.branch) {
        return RealignStep::Done(Realign::Same);
    }
    let same_branch = f.branch == Some(f.remembered_branch);
    if !same_branch {
        let reason = if f.branch.is_none() { Reason::Detached } else { Reason::BranchChanged };
        return RealignStep::Done(Realign::Restore(reason));
    }
    // 같은 브랜치에서 HEAD만 다르다
    let Some(ahead) = f.ancestor else { return RealignStep::NeedAncestor };
    if ahead {
        if f.allow_unwind {
            RealignStep::Done(Realign::Unwind)
        } else {
            RealignStep::Done(Realign::Restore(Reason::ForeignCommits))
        }
    } else {
        RealignStep::Done(Realign::Restore(Reason::Rewound))
    }
}

/// 풀거나 되돌린 **뒤에 다시 읽은** 끝 상태의 판정(N14). 읽지 못했거나(`None`) 기억과 다르면 끼어든 변화가 있었다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum After {
    Aligned,
    Moved,
}

pub fn after_action(remembered_head: &str, remembered_branch: &str, read: Option<(&str, Option<&str>)>) -> After {
    match read {
        Some((head, branch)) if is_aligned(remembered_head, remembered_branch, head, branch) => After::Aligned,
        _ => After::Moved,
    }
}

// ── 기억 ────────────────────────────────────────────────────────────────

/// 기억에 넣을 값
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Memory {
    pub branch: String,
    pub last_checkpoint: String,
}

/// b-studio가 스스로 HEAD를 움직인 자리에서 기억할 값. 머리나 브랜치를 읽지 못했거나 분리된 HEAD면 건드리지 않는다(`None`).
/// `created`가 있으면 그 커밋(b-studio가 만든 것·복원 대상)을 기억한다. 지금 HEAD를 다시 읽은 값이 아니다
pub fn decide_remember(head: &str, branch: Option<&str>, created: Option<&str>) -> Option<Memory> {
    let branch = branch?;
    if head.is_empty() {
        return None;
    }
    Some(Memory { branch: branch.to_owned(), last_checkpoint: created.unwrap_or(head).to_owned() })
}

/// 원격 주소를 읽은 결과
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginRead<'a> {
    /// 읽었고 원격이 없다
    None,
    Url(&'a str),
    /// 읽지 못했다
    Failed,
}

/// 세션을 만들거나 이어받을 때 처음 기억할 값(원격 주소 포함). 머리·브랜치·원격 주소 중 모르는 것이 있으면 기억하지 않는다
pub fn decide_initial_memory(head: &str, branch: Option<&str>, origin: OriginRead) -> Option<(Memory, Option<String>)> {
    let memory = decide_remember(head, branch, None)?;
    match origin {
        OriginRead::Failed => None,
        OriginRead::None => Some((memory, None)),
        OriginRead::Url(url) if url.is_empty() => Some((memory, None)),
        OriginRead::Url(url) => Some((memory, Some(url.to_owned()))),
    }
}

// ── 되돌리기 조합 ───────────────────────────────────────────────────────

/// 되돌리기가 먼저 맞추기를 하는가: 이 컴퓨터 방식이고 기억이 있을 때
pub fn revert_needs_realign(untrusted_git: bool, has_memory: bool) -> bool {
    untrusted_git && has_memory
}

/// 맞춘 결과
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Aligned {
    Same,
    Unwound,
    Restored,
    Unrestorable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RevertFacts {
    pub aligned: Aligned,
    /// 읽기만 요청(앞선 변경이 없던 것)의 되돌리기다
    pub read_only: bool,
}

/// 되돌리기의 순서: 맞추기 → 문서 지키기 → 버리기
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevertPlan {
    /// 맞추지 못해 되돌리지 못했다. 던진다
    Fail,
    /// 맞추면서 이미 기억한 체크포인트로 되돌렸다. 문서도 버리기도 하지 않는다
    AlreadyRestored,
    /// 버리기. `protect_docs`가 참이면 그 앞에서 문서 경로를 체크포인트로 먼저 지킨다
    Discard { protect_docs: bool },
}

pub fn plan_revert(f: &RevertFacts) -> RevertPlan {
    match f.aligned {
        Aligned::Unrestorable => RevertPlan::Fail,
        Aligned::Restored => RevertPlan::AlreadyRestored,
        // 읽기만 요청은 아무것도 바꾸지 않는다는 약속이라, 바뀐 문서도 위반이다. 문서를 게이트 없이 커밋하지 않고 보관본만 남기고 버린다
        Aligned::Same | Aligned::Unwound => RevertPlan::Discard { protect_docs: !f.read_only },
    }
}

/// 되돌린 뒤 무엇을 기억하는가
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RememberAfter {
    /// 만든 문서 체크포인트를 기억한다
    DocsCheckpoint,
    /// 지금 HEAD를 다시 읽어 기억한다(컨테이너 방식: HEAD가 밖에서 움직이지 않는다)
    Reread,
    /// 건드리지 않는다(이 컴퓨터 방식: 끼어든 커밋이 들어가지 않게)
    Keep,
}

pub fn remember_after_revert(docs_checkpoint: bool, untrusted_git: bool) -> RememberAfter {
    if docs_checkpoint {
        RememberAfter::DocsCheckpoint
    } else if !untrusted_git {
        RememberAfter::Reread
    } else {
        RememberAfter::Keep
    }
}

/// DB 복원 기준점. 문서 체크포인트는 DB 덤프가 없으므로 **문서를 지키기 전**의 가장 최근 체크포인트로 고정한다(ADR-018·ADR-131)
pub fn db_restore_base<'a>(before_protect: &'a str, _after_protect: Option<&str>) -> &'a str {
    before_protect
}

/// 되돌린 뒤 남은 일
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevertTail {
    /// 되돌린 파일도, 바뀐 DB도, 다시 띄울 서비스도 없다
    Nothing,
    /// 켜지 않은 세션: 되돌렸다는 알림만 한다
    HostOnlyReport,
    /// 서비스를 다시 띄우고 알린다
    RestartServices,
}

pub fn revert_tail(files_empty: bool, database_touched: bool, also_restart_empty: bool, host_only: bool) -> RevertTail {
    if files_empty && !database_touched && also_restart_empty {
        RevertTail::Nothing
    } else if host_only {
        RevertTail::HostOnlyReport
    } else {
        RevertTail::RestartServices
    }
}

// ── 직접 수정 가르기 ────────────────────────────────────────────────────

/// 남긴 에이전트 변경 기억의 "모든 파일" 항목. 상위 경로라 이름을 맞출 수 없어 모든 파일과 맞는다(닫는 쪽)
pub const UNKNOWN_ENTRY: &str = "..";

/// 이름을 넓게 맞춘 꼴. `None`은 알아볼 수 없는 이름(모든 이름과 맞는다)
fn wide_key(file: &str) -> Option<String> {
    let key = canonical_project_path(file, true, true)?;
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// 두 이름이 같은 파일(이거나 한쪽이 다른 쪽의 폴더)로 읽힐 수 있는가. 거부 목록처럼 **넓게** 맞춘다: 대소문자·유니코드 정규화·보이지 않는 문자·끝의 점·역슬래시·`..`.
/// 알아볼 수 없는 이름은 맞는다. 넓게 맞출수록 직접 수정이 아니라 게이트로 가는 파일이 늘 뿐이다
fn names_may_match(a: &str, b: &str) -> bool {
    let (Some(a), Some(b)) = (wide_key(a), wide_key(b)) else { return true };
    a == b || a.strip_prefix(&b).is_some_and(|rest| rest.starts_with('/')) || b.strip_prefix(&a).is_some_and(|rest| rest.starts_with('/'))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalEditsSplit {
    /// 직접 수정으로 커밋할 파일(사람이 고친 것으로 볼 수 있는 파일)
    pub human: Vec<String>,
    /// 변경으로 남길 파일(남긴 에이전트 변경과 이름이 맞는다)
    pub agent: Vec<String>,
    /// 지금도 바뀌어 있는 남긴 에이전트 변경 기억(바뀌어 있지 않은 항목은 지웠다)
    pub kept: Vec<String>,
}

/// 바뀐 파일(`pending`)을 직접 수정으로 커밋할 것과 변경으로 남길 것으로 가른다. 사람이 남긴 에이전트 변경을 또 고쳤는지는 알 수 없다 — 이름이 맞으면 에이전트 변경으로 본다
pub fn split_local_edits(pending: &[String], kept: &[String]) -> LocalEditsSplit {
    let mut human = Vec::new();
    let mut agent = Vec::new();
    for file in pending {
        if kept.iter().any(|entry| names_may_match(file, entry)) {
            agent.push(file.clone());
        } else {
            human.push(file.clone());
        }
    }
    // 지금 바뀌어 있지 않은 항목은 지운다(게이트를 지나 체크포인트가 됐거나 되돌려졌다)
    let mut remaining: Vec<String> = kept.iter().filter(|entry| pending.iter().any(|file| names_may_match(file, entry))).cloned().collect();
    remaining.sort();
    remaining.dedup();
    LocalEditsSplit { human, agent, kept: remaining }
}

/// 남긴 에이전트 변경 기억에 파일을 더한다(중복 없이, 정렬)
pub fn merge_kept(existing: &[String], added: &[String]) -> Vec<String> {
    let mut merged: Vec<String> = existing.iter().chain(added.iter()).cloned().collect();
    merged.sort();
    merged.dedup();
    merged
}

#[cfg(test)]
#[path = "git_realign_tests.rs"]
mod tests;
