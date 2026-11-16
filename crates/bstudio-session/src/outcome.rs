//! 요청 실행(`execute`)의 끝 결정과 단계 순서(ADR-208, 4f B3b). 옛 구현은 `sessions.ts`의 `execute`였다(`session-run-outcome-legacy.ts`가 차등 시험의 기준으로 남아 있다).
//! Node를 모른다. 체크포인트 저장·되돌리기·알림·러너 호출 같은 부수 효과는 TS 콜백이 하고, 여기는 **어떤 순서로 무엇을 하고, 결과가 나오면 무엇을 남기고 무엇을 되돌리는가**만 정한다.
//!
//! **끝 결정은 순수 판정이다**(`decide_normal`·`decide_exception`). 입력은 사실(질문 여부, 결과 상태, 켠 세션인지, 세션 상태, 질문 전 게이트 통과, 샌드박스 쪽 실패, 작업 공간,
//! 취소·멈춤 신호, 예외 종류, 작업 복사본에 검증하지 않은 변경이 있는지)이고 출력은 할 일(`Action`)과 끝 상태·글의 종류(`Finished`)다.
//!
//! 옛 `execute`는 "바뀌었으면 도구·게이트가 샌드박스를 켰다"고 가정해 켜지 않았거나 `ready`가 아닌 세션에서는 아무것도 하지 않았다. 그 칸에 **검증하지 않은 변경이 남는지**
//! 작업 복사본을 직접 본다(`needs_probe_*`가 참인 칸만, 읽기 전용 확인 한 번). 닫힌 쪽으로만 고친다:
//! - 켜지 않은 세션: 바뀐 파일이 있으면 되돌린다(`RevertHostOnly`. 컨테이너가 없으니 작업 복사본만. 보관본이 남는다. 터미널 실행의 `abandonTerminalRun`과 같은 규칙)
//! - 켰지만 `ready`가 아닌 세션(샌드박스 쪽 실패): 되돌리지 않는다(ADR-131). 대신 남아 있다는 것과 이유를 알린다(`NoticeKept`). 되돌리는 동안 컨테이너가 같은 파일을 보며 뜰 수 있다
//! - 멈춘 세션에는 새 체크포인트를 남기지 않는다(`Save` → `None`). 검증한 내용은 작업 복사본에 남고 다음 요청의 게이트가 다시 본다
//! - 취소했는데 되돌릴 것이 없어 되돌리기를 하지 않은 것을 "되돌리지 못했습니다"로 쓰지 않는다
//!
//! 단계 순서(`RUN_STEPS`)는 여기서 정한다. 점유 단계 바꾸기(`set_phase`)와 풀기(`release`)는 코어 안에서 순서대로 한다.
//! 어느 단계든 실패하면(`ok`가 거짓) 이후 단계를 하지 않고 예외 경로로 간다. 예외 경로도 끝(`finally`)까지 간다.

use crate::claim::{Phase, Ticket};
use crate::status::{SessionState, SessionStatus};
use std::future::Future;

/// 단계 이름. 순서는 성공 경로에서 처음 나오는 차례다(분기 단계는 그 자리에 끼어 있다). 시험이 고정한다
pub const PREPARE: &str = "prepare_edits";
pub const ANNOUNCE_EDITS: &str = "announce_edits";
pub const PLAN_BRIEF: &str = "plan_brief";
pub const RUN_PLAN: &str = "run_plan";
pub const DETACH_RUN: &str = "detach_run";
pub const TALLY_RUN: &str = "tally_run";
pub const NOTE_QUESTION: &str = "note_question";
pub const PROBE_PENDING: &str = "probe_pending";
pub const SAVE_CHECKPOINT: &str = "save_checkpoint";
pub const AFTER_SAVE: &str = "after_save";
pub const REVERT_AFTER_MISMATCH: &str = "revert_after_mismatch";
pub const REVERT_RUN: &str = "revert_run";
pub const REVERT_HOST_ONLY: &str = "revert_host_only";
pub const NOTICE_PLATFORM: &str = "notice_platform";
pub const NOTICE_KEPT: &str = "notice_kept";
pub const BUILD_FINISHED: &str = "build_finished";
pub const SETTLE: &str = "settle";
pub const ANNOUNCE_FINISHED: &str = "announce_finished";

pub const RUN_STEPS: [&str; 18] = [
    PREPARE,
    ANNOUNCE_EDITS,
    PLAN_BRIEF,
    RUN_PLAN,
    DETACH_RUN,
    TALLY_RUN,
    NOTE_QUESTION,
    PROBE_PENDING,
    SAVE_CHECKPOINT,
    AFTER_SAVE,
    REVERT_AFTER_MISMATCH,
    REVERT_RUN,
    REVERT_HOST_ONLY,
    NOTICE_PLATFORM,
    NOTICE_KEPT,
    BUILD_FINISHED,
    SETTLE,
    ANNOUNCE_FINISHED,
];

/// 러너 결과의 상태(`AgentResult.status`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultStatus {
    Done,
    Failed,
    AwaitingInput,
}

impl ResultStatus {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "done" => Self::Done,
            "failed" => Self::Failed,
            "awaiting_input" => Self::AwaitingInput,
            _ => return None,
        })
    }
}

/// `run_finished`의 상태
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinishedStatus {
    Done,
    Failed,
    AwaitingInput,
    Error,
    Cancelled,
}

impl FinishedStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Failed => "failed",
            Self::AwaitingInput => "awaiting_input",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

impl From<ResultStatus> for FinishedStatus {
    fn from(status: ResultStatus) -> Self {
        match status {
            ResultStatus::Done => Self::Done,
            ResultStatus::Failed => Self::Failed,
            ResultStatus::AwaitingInput => Self::AwaitingInput,
        }
    }
}

/// 끝 글(요약)의 종류. 글 조립은 TS가 한다(실행·한도·되돌린 파일 같은 TS 값에 기대고, 종류가 같으면 글이 같다)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Summary {
    /// 러너 결과의 요약과 값 그대로
    Result,
    /// 시작 전 확인(로그인·인프라)이 막았다. 글은 그 이유
    Preflight,
    /// 스튜디오 밖에서 바꾼 파일을 남기지 못해 요청을 시작하지 않았다
    LocalEdits,
    /// 검증한 뒤 커밋하기 전에 내용이 바뀌어 되돌렸다(되돌리지 못했으면 그렇게 쓴다)
    Mismatch,
    /// 예외의 메시지
    Error,
    /// 취소·한도로 멈췄다. 되돌린 결과를 글에 쓴다(되돌리기를 하지 않았으면 되돌릴 변경이 없었다고 쓴다)
    Cancelled,
    /// 질문을 취소했다
    CancelledQuestion,
    /// 취소·한도로 멈췄는데 샌드박스 쪽 문제로 되돌리지 못해 변경이 남았다
    CancelledKept,
    /// 켜지 않은 세션에서 검증하지 않은 변경을 되돌렸다(되돌리지 못했으면 그렇게 쓴다)
    Unverified,
}

impl Summary {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Result => "result",
            Self::Preflight => "preflight",
            Self::LocalEdits => "local_edits",
            Self::Mismatch => "mismatch",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
            Self::CancelledQuestion => "cancelled_question",
            Self::CancelledKept => "cancelled_kept",
            Self::Unverified => "unverified",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Finished {
    pub status: FinishedStatus,
    pub summary: Summary,
}

/// 결과가 나온 뒤에 할 일
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    /// 지문을 견줘 체크포인트를 저장한다(지문이 다르면 되돌린다)
    Save,
    /// 마지막 체크포인트로 되돌리고 서비스를 다시 띄운다
    Revert,
    /// 켜지 않은 세션: 작업 복사본만 되돌린다
    RevertHostOnly,
    /// 샌드박스 쪽 실패라 되돌리지 않고 체크포인트도 남기지 않았다는 알림(ADR-131)
    NoticePlatform,
    /// 샌드박스가 켜지지 않아 바뀐 파일이 그대로 남았다는 알림
    NoticeKept,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Save => "save",
            Self::Revert => "revert",
            Self::RevertHostOnly => "revert_host_only",
            Self::NoticePlatform => "notice_platform",
            Self::NoticeKept => "notice_kept",
        }
    }
}

/// 러너가 결과를 돌려준 뒤의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NormalFacts {
    pub ask: bool,
    pub result: ResultStatus,
    /// 되묻고 멈췄는데 그 전에 쓴 파일이 게이트를 통과했다(`questionRunPassedGate`)
    pub question_gate_passed: bool,
    /// 결과가 `failed`이고 보고서가 샌드박스 쪽 실패를 알렸다
    pub platform_failure: bool,
    /// 샌드박스를 켠 세션이다(`bootPromise`)
    pub booted: bool,
    pub status: SessionStatus,
    /// 내 폴더 세션이다
    pub local: bool,
    /// 세션이 멈추는 중이다(멈춤 신호)
    pub stopped: bool,
}

/// 결과 뒤의 판정. 작업 복사본의 검증하지 않은 변경을 봐야 하는 칸인지 먼저 묻고(`needs_probe_normal`), 봤으면 `pending`으로 넘긴다
pub fn needs_probe_normal(facts: &NormalFacts) -> bool {
    if facts.ask || facts.result == ResultStatus::AwaitingInput {
        return false;
    }
    let save_cell = facts.booted && facts.result == ResultStatus::Done;
    !save_cell && facts.status != SessionStatus::Ready
}

/// 결과 뒤의 판정(만들기 요청). 질문이면 아무것도 하지 않는다
pub fn decide_normal(facts: &NormalFacts, pending: bool) -> (Action, Finished) {
    let finished = Finished { status: facts.result.into(), summary: Summary::Result };
    if facts.ask {
        return (Action::None, finished);
    }
    let save_cell = facts.booted && (facts.result == ResultStatus::Done || (facts.result == ResultStatus::AwaitingInput && facts.question_gate_passed));
    if save_cell {
        // 멈춘 세션에는 새 체크포인트를 남기지 않는다. 검증한 내용은 작업 복사본에 남는다(다음 요청의 게이트가 다시 본다)
        return (if facts.stopped { Action::None } else { Action::Save }, finished);
    }
    if facts.status == SessionStatus::Ready && facts.result != ResultStatus::AwaitingInput {
        // 샌드박스 쪽 문제로 검증하지 못한 변경은 되돌리지 않는다(ADR-131). 내 폴더 세션은 다음 요청이 직접 수정으로 커밋하므로 되돌린다
        let action = if facts.result == ResultStatus::Failed && facts.platform_failure && !facts.local { Action::NoticePlatform } else { Action::Revert };
        return (action, finished);
    }
    // 답을 기다리는 실행이 남긴 미검증 변경은 되돌리지 않는다(다음 요청이 이어서 다룬다)
    if facts.result == ResultStatus::AwaitingInput || !pending {
        return (Action::None, finished);
    }
    if !facts.booted {
        // 켜지 않은 세션에서 바뀐 파일은 어떤 검증도 지나지 않았다
        let finished = if facts.result == ResultStatus::Done { Finished { status: FinishedStatus::Error, summary: Summary::Unverified } } else { finished };
        return (Action::RevertHostOnly, finished);
    }
    (Action::NoticeKept, finished)
}

/// 예외로 끝났을 때의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExceptionFacts {
    pub ask: bool,
    /// 사용자·한도의 취소 신호가 올랐고 멈춤 신호는 아니다
    pub cancelled: bool,
    pub stopped: bool,
    pub booted: bool,
    pub status: SessionStatus,
}

pub fn needs_probe_exception(facts: &ExceptionFacts) -> bool {
    !facts.stopped && !facts.ask && facts.status != SessionStatus::Ready
}

/// 예외 뒤의 판정. 취소 신호는 오류가 아니라 취소 글이다
pub fn decide_exception(facts: &ExceptionFacts, pending: bool) -> (Action, Finished) {
    let action = if facts.stopped || facts.ask {
        Action::None
    } else if facts.status == SessionStatus::Ready {
        // 취소하면 게이트나 도구가 다시 띄우던 서비스가 중간에 멈춰 있을 수 있어 준비되지 않은 서비스도 다시 띄운다(부른 쪽이 정한다)
        Action::Revert
    } else if !pending {
        Action::None
    } else if !facts.booted {
        Action::RevertHostOnly
    } else {
        Action::NoticeKept
    };
    let finished = if !facts.cancelled {
        Finished { status: FinishedStatus::Error, summary: Summary::Error }
    } else if facts.ask {
        Finished { status: FinishedStatus::Cancelled, summary: Summary::CancelledQuestion }
    } else if action == Action::NoticeKept {
        Finished { status: FinishedStatus::Cancelled, summary: Summary::CancelledKept }
    } else {
        Finished { status: FinishedStatus::Cancelled, summary: Summary::Cancelled }
    };
    (action, finished)
}

/// 콜백이 돌려주는 것. 실패하면 `ok`가 거짓이다(콜백은 던지지 않는다)
#[derive(Clone, Debug, Default)]
pub struct Reply {
    pub ok: bool,
    /// 실패가 `LocalEditsError`다(앞 단계 `prepare_edits`의 실패)
    pub local_edits: bool,
    pub result: Option<ResultStatus>,
    /// 시작 전 확인이 막았다(`preflightError`)
    pub preflight: bool,
    pub question_gate_passed: bool,
    pub platform_failure: bool,
    /// 러너가 돌아온 뒤 사용자·한도 취소 신호가 올라 있었다
    pub cancel_requested: bool,
    /// 지금의 신호·사실(콜백이 답을 만드는 순간에 읽는다)
    pub cancel_aborted: bool,
    pub stop_aborted: bool,
    pub booted: bool,
    pub local: bool,
    /// `probe_pending`: 작업 복사본에 검증하지 않은 변경이 있다(읽지 못했으면 참)
    pub pending: bool,
    /// `save_checkpoint`: 지문이 달라 저장하지 않았다
    pub mismatch: bool,
    /// `revert_host_only`: 되돌렸다
    pub reverted: bool,
}

impl Reply {
    pub fn ok() -> Self {
        Self { ok: true, ..Self::default() }
    }

    pub fn failed(local_edits: bool) -> Self {
        Self { ok: false, local_edits, ..Self::default() }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Signals {
    cancel_aborted: bool,
    stop_aborted: bool,
    booted: bool,
    local: bool,
}

impl Signals {
    fn of(reply: &Reply) -> Self {
        Self { cancel_aborted: reply.cancel_aborted, stop_aborted: reply.stop_aborted, booted: reply.booted, local: reply.local }
    }
}

struct Exc {
    local_edits: bool,
    signals: Signals,
}

impl SessionState {
    /// 요청 하나를 `RUN_STEPS` 순서로 끝까지 돈다. `call(단계 이름, 인자)`가 그 단계의 부수 효과를 하고 사실을 돌려준다.
    /// 끝에서 이 실행의 표로 점유를 푼다(이미 풀렸거나 다른 점유의 표면 아무것도 하지 않는다, ADR-207)
    pub async fn run_request<F, Fut>(&self, ticket: Ticket, ask: bool, mut call: F)
    where
        F: FnMut(&'static str, &'static str) -> Fut,
        Fut: Future<Output = Reply>,
    {
        let mut signals = Signals::default();
        let finished = match self.main_flow(ticket, ask, &mut call, &mut signals).await {
            Ok(finished) => finished,
            Err(exc) => {
                signals = exc.signals;
                self.exception_flow(ticket, ask, exc, &mut call, &mut signals).await
            }
        };
        call(BUILD_FINISHED, finished.summary.as_str()).await;
        let reply = call(SETTLE, finished.status.as_str()).await;
        signals = Signals::of(&reply);
        self.release(ticket);
        // 멈추는 중이면 끝났다는 알림만 건너뛴다(멈추기가 상태를 정리한다)
        call(ANNOUNCE_FINISHED, if signals.stop_aborted { "silent" } else { "announce" }).await;
    }

    async fn main_flow<F, Fut>(&self, ticket: Ticket, ask: bool, call: &mut F, signals: &mut Signals) -> Result<Finished, Exc>
    where
        F: FnMut(&'static str, &'static str) -> Fut,
        Fut: Future<Output = Reply>,
    {
        macro_rules! step {
            ($name:expr, $arg:expr, $local:expr) => {{
                let reply = call($name, $arg).await;
                *signals = Signals::of(&reply);
                if !reply.ok {
                    return Err(Exc { local_edits: $local && reply.local_edits, signals: *signals });
                }
                reply
            }};
        }
        step!(PREPARE, "", true);
        step!(ANNOUNCE_EDITS, "", false);
        step!(PLAN_BRIEF, "", false);
        let ran = step!(RUN_PLAN, "", false);
        // 취소를 받은 직후 에이전트가 먼저 끝났어도 사용자가 원한 대로 되돌린다
        if ran.cancel_requested {
            return Err(Exc { local_edits: false, signals: Signals { cancel_aborted: true, ..*signals } });
        }
        // 여기부터는 취소를 받지 않는다: 체크포인트를 저장하는 단계다
        self.set_phase(ticket, Phase::Saving);
        step!(DETACH_RUN, "", false);
        if ran.preflight {
            return Ok(Finished { status: FinishedStatus::Error, summary: Summary::Preflight });
        }
        step!(TALLY_RUN, "", false);
        step!(NOTE_QUESTION, "", false);
        let Some(result) = ran.result else { return Err(Exc { local_edits: false, signals: *signals }) };
        let mut facts = NormalFacts {
            ask,
            result,
            question_gate_passed: ran.question_gate_passed,
            platform_failure: ran.platform_failure,
            booted: signals.booted,
            status: self.status(),
            local: signals.local,
            stopped: signals.stop_aborted,
        };
        let pending = if needs_probe_normal(&facts) { step!(PROBE_PENDING, "", false).pending } else { false };
        // 읽는 사이 상태가 바뀌었을 수 있다. 판정은 읽은 뒤의 상태로 한다
        facts.status = self.status();
        facts.stopped = signals.stop_aborted;
        let (action, mut finished) = decide_normal(&facts, pending);
        match action {
            Action::None => {}
            Action::Save => {
                if step!(SAVE_CHECKPOINT, "", false).mismatch {
                    // 게이트가 통과시킨 뒤 커밋하기 전에 내용이 바뀌었다. 검증하지 않은 내용을 체크포인트로 남기지 않고 되돌린다
                    call(REVERT_AFTER_MISMATCH, "").await;
                    return Ok(Finished { status: FinishedStatus::Error, summary: Summary::Mismatch });
                }
                step!(AFTER_SAVE, "", false);
            }
            Action::Revert => {
                step!(REVERT_RUN, "", false);
            }
            Action::RevertHostOnly => {
                // 되돌리지 못해도 예외로 넘기지 않는다: 이 단계가 이유를 알린다
                let reply = call(REVERT_HOST_ONLY, "").await;
                *signals = Signals::of(&reply);
                if finished.summary == Summary::Unverified && !reply.reverted {
                    finished = Finished { status: FinishedStatus::Error, summary: Summary::Unverified };
                }
            }
            Action::NoticePlatform => {
                step!(NOTICE_PLATFORM, "", false);
            }
            Action::NoticeKept => {
                step!(NOTICE_KEPT, "", false);
            }
        }
        Ok(finished)
    }

    async fn exception_flow<F, Fut>(&self, ticket: Ticket, ask: bool, exc: Exc, call: &mut F, signals: &mut Signals) -> Finished
    where
        F: FnMut(&'static str, &'static str) -> Fut,
        Fut: Future<Output = Reply>,
    {
        if exc.local_edits {
            // 되돌리면 체크포인트로 남기지 못한 사람의 수정이 지워지므로 그대로 두고 끝낸다
            self.set_phase(ticket, Phase::Saving);
            call(DETACH_RUN, "").await;
            return Finished { status: FinishedStatus::Error, summary: Summary::LocalEdits };
        }
        let cancelled = exc.signals.cancel_aborted && !exc.signals.stop_aborted;
        // 취소해 되돌리는 동안 다시 누른 취소는 받아들인다. 오류로 되돌리는 중에는 취소를 받지 않는다
        if !cancelled {
            self.set_phase(ticket, Phase::Saving);
            call(DETACH_RUN, "").await;
        }
        let mut facts = ExceptionFacts { ask, cancelled, stopped: exc.signals.stop_aborted, booted: exc.signals.booted, status: self.status() };
        let reply_pending = if needs_probe_exception(&facts) {
            let reply = call(PROBE_PENDING, "").await;
            *signals = Signals::of(&reply);
            reply.pending
        } else {
            false
        };
        facts.status = self.status();
        let (action, finished) = decide_exception(&facts, reply_pending);
        match action {
            Action::Revert => {
                call(REVERT_RUN, if cancelled { "cancelled" } else { "" }).await;
            }
            Action::RevertHostOnly => {
                call(REVERT_HOST_ONLY, if cancelled { "cancelled" } else { "" }).await;
            }
            Action::NoticeKept => {
                call(NOTICE_KEPT, "").await;
            }
            _ => {}
        }
        finished
    }
}

#[cfg(test)]
mod tests;
