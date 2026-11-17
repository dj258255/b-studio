//! 세션 터미널 실행의 닫기와 열린 실행 판정(ADR-210, 4f B4a). 옛 구현은 `sessions.ts`의 `abandonTerminalRun`·`settleTerminalRun`·`announceTerminalRun`·`terminalCliEnded`·
//! `terminalViolation`·`openTerminalRun`이었다(`session-terminal-close-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다.
//! 되돌리기·알림·끝 글 조립·정체 감시 멈춤 같은 부수 효과는 TS 콜백이 하고, 여기는 **언제 닫고, 무엇을 하고, 어떤 순서로 풀며, 지금 열린 실행인가**만 정한다.
//!
//! **닫기 판정은 순수 함수다**(`decide_close`). 입력은 사실(멈추는 중, 끝 상태, 샌드박스·도커 쪽 실패, 내 폴더 세션, 상태 `ready`, 샌드박스를 켠 적 있음, 사유 글이 있는가)이고
//! 출력은 할 일(`outcome::Action`을 그대로 쓴다: 같은 이름이 같은 뜻이다)과 끝 상태·글의 종류다. 대화 창의 `decide_exception`과 다른 규칙이라 함수는 따로 둔다:
//! 터미널은 취소·오류를 가르지 않고 끝 상태를 부른 쪽이 정하고, 샌드박스 쪽 실패를 상태보다 먼저 보며, `ready`가 아닌 세션에서 켠 적이 없으면 변경이 있는지 읽지 않고
//! 곧바로 작업 복사본만 되돌린다(`decide_exception`은 이 칸에서 변경이 있는지 읽고 없으면 아무것도 하지 않는다).
//!
//! **열린 실행은 하나다.** 옛 `openTerminalRun`은 `session.run && !settled && !cancel.aborted`를 봤다. 이제 코어가 같은 뜻을 한 자물쇠 아래에서 답한다:
//! 점유가 이 실행의 표이고 터미널의 실행이며 단계가 `진행`(취소 중·저장 중이 아니다)이고 닫기를 시작하지 않았다. 닫기를 시작하면(`begin_terminal_close`) 그 순간부터 열린 실행이 아니다.
//!
//! **닫기는 한 번만 한다.** `begin_terminal_close`가 처음 부른 쪽에만 `Some`을 준다. 닫는 순서(`run_terminal_close`)는 되돌리기·알림 → 끝 글 조립 → 떼기 → **표로 점유 풀기** → 끝 알림이다.
//! 풀기는 앞 단계가 실패하거나(콜백은 던지지 않고 부른 쪽이 삼킨다) 기다리다 버려져도 한다(`Drop`). 옛 코드는 `settled`를 먼저 세운 뒤 알리기 전에 던지면 점유가 남았다.
//!
//! 의도한 차이(옛 코드와 다른 칸. 나머지는 사실 조합 전체가 같다):
//! - CLI 종료를 검사 중에 받아 미뤘다면(`mark`) 검사가 재시도(피드백)로 끝나는 자리에서 피드백 대신 실패로 닫는다(`retry_or_close`). 옛 코드는 받을 CLI가 없는데 실행이 열린 채 남았다
//! - 저장 중에 한도 중단 신호가 올랐다가 다시 열린 실행은 옛 판정은 닫힌 것(신호가 올라 있다)으로, 이 판정은 열린 것(단계가 `진행`)으로 본다. 다시 열린 실행은 게이트 앞에서 신호를 보고 취소로 닫는다
//! - 닫기가 시작되면 TS가 그 실행의 중단 신호를 끊는다(코어 밖). 옛 닫기는 신호를 끊지 않아 기다리던 훅이 닫힌 실행에서 허용을 돌려줬다

pub mod classify;
pub mod prompt;
pub mod turn_end;
pub mod usage;

use crate::claim::{Holder, Phase, Slot, Ticket};
use crate::outcome::{Action, FinishedStatus};
use crate::status::{Inner, SessionState};
use std::collections::HashMap;
use std::future::Future;

/// 닫기의 단계 이름. 순서는 `CLOSE_STEPS`다(분기 단계는 그 자리에 끼어 있다). 시험이 고정한다
pub const REVERT_RUN: &str = "revert_run";
pub const REVERT_HOST_ONLY: &str = "revert_host_only";
pub const NOTICE_PLATFORM: &str = "notice_platform";
pub const BUILD_SUMMARY: &str = "build_summary";
pub const DETACH_RUN: &str = "detach_run";
pub const ANNOUNCE_RUN: &str = "announce_run";

pub const CLOSE_STEPS: [&str; 6] = [REVERT_RUN, REVERT_HOST_ONLY, NOTICE_PLATFORM, BUILD_SUMMARY, DETACH_RUN, ANNOUNCE_RUN];

/// 통과하지 못한 채 끝나는 실행의 끝 상태(`abandonTerminalRun`의 `status`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndStatus {
    Failed,
    Cancelled,
    Error,
}

impl EndStatus {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "error" => Self::Error,
            _ => return None,
        })
    }
}

impl From<EndStatus> for FinishedStatus {
    fn from(status: EndStatus) -> Self {
        match status {
            EndStatus::Failed => Self::Failed,
            EndStatus::Cancelled => Self::Cancelled,
            EndStatus::Error => Self::Error,
        }
    }
}

/// 끝 글(요약)의 종류. 글 조립은 TS가 한다(실행·한도·되돌린 파일 같은 TS 값에 기대고, 종류가 같으면 글이 같다)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseText {
    /// 세션을 멈추는 중이다. 끝 글은 "세션을 멈췄습니다."이고 부른 쪽에는 사유 글을 그대로 돌려준다
    Stopped,
    /// 샌드박스·도커 쪽 문제로 검증하지 못해 되돌리지 않았다
    PlatformKept,
    /// 샌드박스가 켜지는 중이거나 켜지지 못해 되돌리지 못했다
    Kept,
    /// 되돌렸다(되돌리지 못했으면 그렇게 쓴다). 사유 글 뒤에 결과를 붙인다
    Reverted,
    /// 사유 없이 취소해 되돌렸다. 취소·한도 글에 되돌린 결과를 쓴다
    CancelledReport,
    /// 통과했거나 바꾼 것 없이 끝났다(부른 쪽이 정한 글)
    Settled,
}

impl CloseText {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::PlatformKept => "platform_kept",
            Self::Kept => "kept",
            Self::Reverted => "reverted",
            Self::CancelledReport => "cancelled_report",
            Self::Settled => "settled",
        }
    }
}

/// 닫을 때의 사실. 부른 쪽이 닫기를 시작하는 순간에 읽는다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseFacts {
    pub status: EndStatus,
    /// 세션이 멈추는 중이다(멈춤 신호)
    pub stopping: bool,
    /// 샌드박스·도커 쪽 문제로 검증하지 못했다는 글이 있다(`platformFailure`)
    pub platform_failure: bool,
    /// 내 폴더 세션이다
    pub local: bool,
    /// 세션 상태가 `ready`다
    pub ready: bool,
    /// 샌드박스를 켠 적 있다(`bootPromise`)
    pub booted: bool,
    /// 사유 글이 있다(빈 글은 없는 것이다)
    pub has_reason: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseDecision {
    pub action: Action,
    pub status: FinishedStatus,
    pub text: CloseText,
}

/// 통과하지 못한 채 닫을 때의 판정(옛 `abandonTerminalRun`의 분기 순서를 그대로 따른다)
pub fn decide_close(facts: &CloseFacts) -> CloseDecision {
    // 멈추는 중이면 되돌리지 않는다. 멈추기가 상태를 정리한다. 끝 상태는 취소다
    if facts.stopping {
        return CloseDecision { action: Action::None, status: FinishedStatus::Cancelled, text: CloseText::Stopped };
    }
    // 샌드박스·도커 쪽 문제는 바꾼 코드의 문제가 아니다(트러블슈팅 117). 내 폴더 세션은 다음 요청이 직접 수정으로 커밋하므로 이 칸이 아니다
    if facts.platform_failure && !facts.local {
        return CloseDecision { action: Action::NoticePlatform, status: facts.status.into(), text: CloseText::PlatformKept };
    }
    // 켜는 중이거나 켜지 못한 세션은 되돌리지 않는다. 되돌리는 동안 컨테이너가 같은 파일을 보며 뜰 수 있다
    if !facts.ready && facts.booted {
        return CloseDecision { action: Action::NoticeKept, status: facts.status.into(), text: CloseText::Kept };
    }
    // 켠 적 없는 세션은 컨테이너가 없어 DB 복원과 서비스 재시작 없이 작업 복사본만 되돌린다(트러블슈팅 185)
    let action = if facts.booted { Action::Revert } else { Action::RevertHostOnly };
    let text = if facts.status == EndStatus::Cancelled && !facts.has_reason { CloseText::CancelledReport } else { CloseText::Reverted };
    CloseDecision { action, status: facts.status.into(), text }
}

/// CLI가 끝났다는 알림(SessionEnd)의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CliEndedFacts {
    /// 열린 실행이 있다
    pub open: bool,
    /// 턴 끝 검사가 도는 중이다
    pub checking: bool,
    /// 마지막으로 에이전트에게 돌려준 검증 결과가 있다
    pub has_feedback: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliEnded {
    /// 열린 실행이 없다. 할 일이 없다
    Nothing,
    /// 검사가 도는 중이다. 그 검사가 닫는다(재시도로 끝나면 `retry_or_close`가 닫는다)
    Defer,
    /// 열린 실행을 이 끝 상태로 닫는다(피드백이 있었으면 실패, 없으면 취소)
    Close(EndStatus),
}

pub fn on_cli_ended(facts: &CliEndedFacts) -> CliEnded {
    if !facts.open {
        return CliEnded::Nothing;
    }
    if facts.checking {
        return CliEnded::Defer;
    }
    CliEnded::Close(if facts.has_feedback { EndStatus::Failed } else { EndStatus::Cancelled })
}

/// 턴이 API 오류(사용 한도·인증·과부하 등)로 끝났다는 알림(StopFailure)의 사실. 오류의 종류는 판정에 쓰지 않는다(모르는 종류도 같다)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TurnFailedFacts {
    /// 열린 실행이 있다
    pub open: bool,
    /// 턴 끝 검사가 도는 중이다
    pub checking: bool,
}

/// 오류로 끊긴 턴은 일을 마친 것이 아니다. 검사를 돌려 통과시키지 않고 늘 실패로 닫는다(피드백이 있었는지와 상관없다)
pub fn on_turn_failed(facts: &TurnFailedFacts) -> CliEnded {
    if !facts.open {
        return CliEnded::Nothing;
    }
    if facts.checking {
        return CliEnded::Defer;
    }
    CliEnded::Close(EndStatus::Failed)
}

/// 감시가 찾은 위반의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViolationFacts {
    /// 세션이 살아 있다(멈추는 중이거나 멈췄으면 거짓)
    pub alive: bool,
    /// 열린 실행이 있다
    pub open: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViolationRoute {
    /// 멈추는 중이거나 멈춘 세션이다. 아무것도 남기지 않는다(담아 둘 다음 턴이 없다)
    Ignore,
    /// 열린 실행에 표시하고 줄을 세워 실패로 닫는다
    CloseOpenRun,
    /// 열린 실행이 없거나 이미 닫혔다. 그 뒤 처음 턴의 끝을 맞는 실행의 것으로 담아 둔다
    Defer,
}

pub fn route_violation(facts: &ViolationFacts) -> ViolationRoute {
    if !facts.alive {
        return ViolationRoute::Ignore;
    }
    if facts.open {
        ViolationRoute::CloseOpenRun
    } else {
        ViolationRoute::Defer
    }
}

/// 검사가 재시도(피드백)로 끝났을 때의 갈 곳
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retry {
    /// 피드백을 에이전트에게 돌려주고 실행을 연 채 둔다
    Feedback,
    /// 받을 CLI가 없다. 피드백 대신 실패로 닫는다
    CloseFailed,
}

pub fn on_retry(cli_ended: bool) -> Retry {
    if cli_ended {
        Retry::CloseFailed
    } else {
        Retry::Feedback
    }
}

/// 닫는 종류
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseKind {
    /// 통과하지 못한 채 닫는다. `decide_close`가 할 일을 정한다
    Abandon(CloseFacts),
    /// 통과했거나 바꾼 것 없이 끝났다(또는 세션을 멈추며 닫는다). 되돌릴 것이 없다
    Settle(FinishedStatus),
}

#[derive(Default)]
struct Flags {
    /// 닫기를 시작했다(옛 `settled`)
    closed: bool,
    /// CLI가 끝났다는 알림을 검사 중에 받아 미뤘다
    cli_ended: bool,
    /// 닫기를 시작해 정한 할 일. `run_terminal_close`가 가져간다
    plan: Option<CloseDecision>,
}

/// 터미널 실행마다의 표시. 실행은 세션에 하나씩만 열리므로 새 실행이 열릴 때 앞 실행의 표시는 버린다
/// (버린 실행을 뒤늦게 닫으려는 호출은 "이미 닫혔다"로 본다: 표시가 없으면 닫힌 것이다)
#[derive(Default)]
pub(crate) struct Runs {
    runs: HashMap<Ticket, Flags>,
}

impl Runs {
    pub(crate) fn begin(&mut self, ticket: Ticket) {
        self.runs.clear();
        self.runs.insert(ticket, Flags::default());
    }
}

fn is_open(inner: &Inner, ticket: Ticket) -> bool {
    let held = matches!(&inner.claims.slot, Some(Slot { ticket: held, holder: Holder::Run { terminal: true, phase: Phase::Running, .. } }) if *held == ticket);
    held && inner.claims.terminal.runs.get(&ticket).is_some_and(|flags| !flags.closed)
}

/// 기다리다 버려지거나 중간에 멈춰도 표로 점유를 푼다
struct ReleaseOnDrop<'a> {
    state: &'a SessionState,
    ticket: Ticket,
    armed: bool,
}

impl ReleaseOnDrop<'_> {
    fn release(&mut self) {
        if self.armed {
            self.armed = false;
            self.state.release(self.ticket);
        }
    }
}

impl Drop for ReleaseOnDrop<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

impl SessionState {
    /// 지금 열린 터미널 실행인가. 옛 `openTerminalRun`의 `session.run && !settled && !cancel.aborted`와 같은 뜻이다
    pub fn terminal_run_open(&self, ticket: Ticket) -> bool {
        is_open(&self.lock(), ticket)
    }

    /// 닫기를 시작한 실행인가(옛 `settled`). 표시가 없는 실행(앞 실행이거나 모르는 표)도 닫힌 것이다
    pub fn terminal_run_closed(&self, ticket: Ticket) -> bool {
        self.lock().claims.terminal.runs.get(&ticket).is_none_or(|flags| flags.closed)
    }

    /// 닫기를 시작한다. 처음 부른 호출에만 할 일(`decide_close`)을 돌려주고, 그 순간부터 열린 실행이 아니다.
    /// 이미 닫기를 시작했거나 모르는 표면 `None`이다(아무것도 하지 않는다)
    pub fn begin_terminal_close(&self, ticket: Ticket, kind: CloseKind) -> Option<CloseDecision> {
        let mut inner = self.lock();
        let flags = inner.claims.terminal.runs.get_mut(&ticket)?;
        if flags.closed {
            return None;
        }
        let decision = match kind {
            CloseKind::Abandon(facts) => decide_close(&facts),
            CloseKind::Settle(status) => CloseDecision { action: Action::None, status, text: CloseText::Settled },
        };
        flags.closed = true;
        flags.plan = Some(decision);
        Some(decision)
    }

    /// `begin_terminal_close`가 `Some`을 준 호출이 곧바로 부른다. 단계마다 `call(단계 이름, 한 마디)`가 부수 효과를 하고 돌아온다(던지지 않는다. 실패는 부른 쪽이 삼킨다).
    /// 순서: 되돌리기·알림 → 끝 글 조립 → 떼기 → 표로 점유 풀기 → 끝 알림. 앞 단계가 실패하거나 이 호출이 버려져도 점유는 풀린다
    pub async fn run_terminal_close<F, Fut>(&self, ticket: Ticket, mut call: F)
    where
        F: FnMut(&'static str, &'static str) -> Fut,
        Fut: Future<Output = ()>,
    {
        let plan = self.lock().claims.terminal.runs.get_mut(&ticket).and_then(|flags| flags.plan.take());
        let Some(plan) = plan else { return };
        let mut guard = ReleaseOnDrop { state: self, ticket, armed: true };
        let cancelled = plan.status == FinishedStatus::Cancelled;
        match plan.action {
            Action::Revert => call(REVERT_RUN, if cancelled { "cancelled" } else { "" }).await,
            Action::RevertHostOnly => call(REVERT_HOST_ONLY, if cancelled { "cancelled" } else { "" }).await,
            Action::NoticePlatform => call(NOTICE_PLATFORM, "").await,
            // 켜는 중이라 되돌리지 못한 것은 알림이 따로 없다(끝 글이 말한다)
            Action::NoticeKept | Action::None | Action::Save => {}
        }
        if plan.text != CloseText::Settled {
            call(BUILD_SUMMARY, plan.text.as_str()).await;
        }
        call(DETACH_RUN, "").await;
        guard.release();
        call(ANNOUNCE_RUN, plan.status.as_str()).await;
    }

    /// CLI가 끝났다(SessionEnd). `ticket`은 세션에 걸린 터미널 실행의 표(없으면 0)다. 검사 중이면 미룬다는 표시를 실행에 남기고 `Defer`를 돌려준다
    pub fn terminal_cli_ended(&self, ticket: Ticket, checking: bool, has_feedback: bool) -> CliEnded {
        let mut inner = self.lock();
        let open = is_open(&inner, ticket);
        let decision = on_cli_ended(&CliEndedFacts { open, checking, has_feedback });
        if decision == CliEnded::Defer {
            if let Some(flags) = inner.claims.terminal.runs.get_mut(&ticket) {
                flags.cli_ended = true;
            }
        }
        decision
    }

    /// 턴이 API 오류로 끝났다(StopFailure). `ticket`은 세션에 걸린 터미널 실행의 표(없으면 0)다. 열린 실행이 없으면 `Nothing`,
    /// 검사 중이면 미룬다는 표시를 남기고 `Defer`(검사가 재시도로 끝나면 실패로 닫는다), 아니면 `Close(Failed)`
    pub fn terminal_turn_failed(&self, ticket: Ticket, checking: bool) -> CliEnded {
        let mut inner = self.lock();
        let open = is_open(&inner, ticket);
        let decision = on_turn_failed(&TurnFailedFacts { open, checking });
        if decision == CliEnded::Defer {
            if let Some(flags) = inner.claims.terminal.runs.get_mut(&ticket) {
                flags.cli_ended = true;
            }
        }
        decision
    }

    /// 검사가 재시도로 끝났다. CLI 종료를 미뤄 둔 실행이면 피드백 대신 실패로 닫는다
    pub fn terminal_retry(&self, ticket: Ticket) -> Retry {
        on_retry(self.lock().claims.terminal.runs.get(&ticket).is_some_and(|flags| flags.cli_ended))
    }

    /// 감시가 위반을 찾았다. `ticket`은 세션에 걸린 터미널 실행의 표(없으면 0), `alive`는 세션이 살아 있는가다
    pub fn terminal_violation_route(&self, ticket: Ticket, alive: bool) -> ViolationRoute {
        let inner = self.lock();
        route_violation(&ViolationFacts { alive, open: is_open(&inner, ticket) })
    }
}

#[cfg(test)]
mod tests;
