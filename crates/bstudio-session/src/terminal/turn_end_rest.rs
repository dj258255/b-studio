//! 세션 터미널 턴 끝의 나머지(ADR-217, 4f B5c): 예외 경로 분류, 게이트 밖 사유, 남은 체크포인트·저장 중 실행·다시 붙이기의 조건, 게이트 시간 상한.
//! 옛 구현은 `sessions.ts`의 `finishTerminalTurn`의 `catch` 블록, `GateOutcome`을 짓던 `unsettled`·`moved` 클로저, `landedCheckpoint`, `savingTerminalRun`이었다
//! (`session-terminal-turn-end-rest-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다. 읽기(Git·지문·샌드박스)와 되돌리기·알림·글 조립은 TS가 하고, 여기는 **사실 조합 → 할 일 하나**만 정한다.
//!
//! **판정을 부르는 자리마다 막는 쪽인가 여는 쪽인가**(AGENTS.md):
//! - `decide_turn_end_error`: 되돌릴지를 정한다. **여는 쪽**은 `Stopped`·`KeepLanded`·`Platform`(바꾼 코드를 되돌리지 않고 남긴다)이고, 확인한 것만 받아들인다.
//!   모르는 값(남았는지 읽지 못함, 켜기 실패가 이 실행의 것인지 모름)은 여는 칸이 아니라 되돌리는 칸(`Cancelled`·`Failure`)으로 간다
//! - `landed_state`: 여는 쪽(되돌리기를 건너뛴다). 읽지 못하면 `Unknown`이고 `Unknown`은 남았다고 보지 않는다
//! - `saving_accepts`·`should_reattach`: 위반을 이 실행의 것으로 적는 조건과 실행을 다시 여는 조건. 닫기를 시작했으면 둘 다 거짓이다(닫는 쪽)
//! - `decide_gate_stage`: 통과를 내는 칸은 한 곳(`Pass`)뿐이고 앞의 모든 사실이 확인된 뒤에만 선다. 나머지는 돌려보내거나 닫는다
//! - `gate_deadline_ms`: 시간 상한. 넘으면 통과가 아니라 실패로 닫는다(막는 쪽)
//!
//! **순서가 판정이다.** 예외 경로: 멈춤 → 남은 체크포인트 → 취소 → 시간 상한 → 플랫폼 실패 → 오류.
//! 플랫폼 실패는 "이번 오류가 이번 실행에서 샌드박스를 켜지 못해 난 오류다"라는 사실로만 인정한다. 세션에 남은 표시(`status==='failed' && bootPlatformFailure`)는 앞선 켜기의 것일 수 있어 근거가 아니다.
//!
//! 의도한 차이(옛 코드와 다른 칸. 나머지는 사실 조합 전체가 같다):
//! - 플랫폼 실패의 근거가 세션 표시에서 "이번 오류가 켜기 실패"로 바뀌었다. 표시만 남은 세션의 코드 탓 오류는 플랫폼 실패가 아니라 오류다(되돌리는 쪽)
//! - 남은 체크포인트를 읽지 못한 칸(`Unknown`)을 옛 코드는 조용히 "없음"으로 닫았다. 같은 닫힘이지만 사유 글에 확인하지 못했다고 적는다
//! - 게이트 전체에 시간 상한이 생겼다. 옛 코드에는 없었다

/// 남은 체크포인트(`landedCheckpoint`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Landed {
    /// 이 저장이 남긴 커밋이 지금 HEAD다
    Yes,
    /// 저장이 커밋하지 않았거나 HEAD가 다른 커밋이다
    No,
    /// 저장이 커밋했는데 Git을 읽지 못했다. 남았다고 보지 않는다
    Unknown,
}

/// HEAD를 읽은 결과
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeadRead<'a> {
    /// 읽었고 체크포인트가 없다
    Empty,
    Sha(&'a str),
    Failed,
}

/// `committed`는 저장이 `commit()`을 통해 알려 준 커밋(없으면 커밋하지 않았다). 그 커밋이 지금 HEAD일 때만 남았다
pub fn landed_state(committed: Option<&str>, head: HeadRead<'_>) -> Landed {
    let Some(committed) = committed else { return Landed::No };
    match head {
        HeadRead::Failed => Landed::Unknown,
        HeadRead::Empty => Landed::No,
        HeadRead::Sha(sha) if sha == committed => Landed::Yes,
        HeadRead::Sha(_) => Landed::No,
    }
}

/// 예외 경로의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ErrorFacts {
    /// 세션을 멈추는 신호가 서 있다
    pub stopped: bool,
    pub landed: Landed,
    /// 이 실행의 취소 신호가 서 있다
    pub run_cancelled: bool,
    /// 게이트 시간 상한이 지났다
    pub deadline_exceeded: bool,
    /// 던져진 오류가 이번 실행에서 샌드박스를 켜지 못해 난 오류이고 그 켜기 실패가 플랫폼 쪽이었다
    pub boot_platform_failure: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorClose {
    /// 세션을 멈췄다: 취소로 닫고 되돌리지 않는다
    Stopped,
    /// 체크포인트가 이미 남았다: 되돌리지 않고 알리고 실행만 실패로 닫는다
    KeepLanded,
    /// 취소로 닫고 되돌린다
    Cancelled,
    /// 시간 상한: 실패로 닫고 되돌린다
    Deadline,
    /// 샌드박스·도커 쪽 문제: 되돌리지 않는다
    Platform,
    /// 오류로 닫고 되돌린다. `landed_unknown`이면 체크포인트가 남았는지 읽지 못했다는 말을 사유에 더한다
    Failure { landed_unknown: bool },
}

pub fn decide_turn_end_error(f: &ErrorFacts) -> ErrorClose {
    if f.stopped {
        return ErrorClose::Stopped;
    }
    if f.landed == Landed::Yes {
        return ErrorClose::KeepLanded;
    }
    if f.run_cancelled {
        return ErrorClose::Cancelled;
    }
    if f.deadline_exceeded {
        return ErrorClose::Deadline;
    }
    if f.boot_platform_failure {
        return ErrorClose::Platform;
    }
    ErrorClose::Failure { landed_unknown: f.landed == Landed::Unknown }
}

/// 체크포인트를 남기는 중인 실행(`savingTerminalRun`)을 위반을 적을 실행으로 받아들이는가: 있고, 세션의 열린 실행으로 붙어 있지 않으며, 닫기를 시작하지 않았다
pub fn saving_accepts(has_saving: bool, attached_as_session_run: bool, closed: bool) -> bool {
    has_saving && !attached_as_session_run && !closed
}

/// 저장 중이던 실행을 다시 여는가: 세션에 붙은 실행이 없고 닫기를 시작하지 않았다
pub fn should_reattach(session_has_run: bool, closed: bool) -> bool {
    !session_has_run && !closed
}

/// 체크포인트 저장이 던진 오류의 종류
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveFailure {
    /// 게이트가 도는 사이 HEAD가 움직였다
    HeadMoved,
    /// 통과시킨 뒤 커밋하기 전에 내용이 바뀌었다
    StagedMismatch,
    Other,
}

impl SaveFailure {
    pub fn parse(text: &str) -> Self {
        match text {
            "head_moved" => Self::HeadMoved,
            "staged_mismatch" => Self::StagedMismatch,
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveStep {
    /// 되돌리기(Git 맞추기)를 한 뒤 오류를 다시 던진다
    ReconcileThenRethrow,
    /// 게이트 밖 사유(내용이 바뀜)로 돌려보낸다
    RetryMoved,
    /// 그대로 다시 던진다(예외 경로가 분류한다)
    Rethrow,
}

pub fn decide_save_failure(kind: SaveFailure) -> SaveStep {
    match kind {
        SaveFailure::HeadMoved => SaveStep::ReconcileThenRethrow,
        SaveFailure::StagedMismatch => SaveStep::RetryMoved,
        SaveFailure::Other => SaveStep::Rethrow,
    }
}

/// 읽은 값. `Unread`는 아직 읽지 않았다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    Unread,
    /// 없다(통과·바뀐 것 없음)
    Clear,
    /// 있다(거절된 경로·바뀐 파일·실패한 완료 검사)
    Found,
}

impl Probe {
    /// 알아보지 못한 글은 있다(막는 쪽)
    pub fn parse(text: &str) -> Self {
        match text {
            "unread" => Self::Unread,
            "clear" => Self::Clear,
            _ => Self::Found,
        }
    }
}

/// 게이트가 낸 결과
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateRead {
    Unread,
    Pass,
    Retry,
    Exhausted,
    /// 알아보지 못한 결과
    Unknown,
}

impl GateRead {
    pub fn parse(text: &str) -> Self {
        match text {
            "unread" => Self::Unread,
            "pass" => Self::Pass,
            "retry" => Self::Retry,
            "exhausted" => Self::Exhausted,
            _ => Self::Unknown,
        }
    }
}

/// 게이트 단계(컨테이너 멈춤 → 지문 맞추기 → 게이트 → 통과면 지문 다시 맞추기 → 통과면 완료 검사)의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GateStageFacts {
    /// 시간 상한이 지났다
    pub deadline_exceeded: bool,
    /// 검증 동안 에이전트 컨테이너를 멈추지 못했다
    pub pause_failed: bool,
    /// 게이트가 다룰 수 없는 경로가 바뀌었는가(첫 지문 맞추기)
    pub rejected: Probe,
    pub gate: GateRead,
    /// 통과 뒤 지문 맞추기에서 바뀐 것(바뀐 파일·거절된 경로)이 있는가
    pub moved: Probe,
    /// 통과했는데 바뀐 파일이 없고 완료 검사가 있어 직접 돌린 결과(실패가 `Found`). 돌릴 필요가 없으면 TS가 `Clear`로 채운다
    pub done_tests: Probe,
}

/// 게이트 밖 사유
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsettled {
    PauseFailed,
    Rejected,
    Moved,
    DoneTestsFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageFinal {
    /// 모든 확인을 지나 통과했다
    Pass,
    /// 게이트가 돌려보내거나 소진했거나 알아보지 못한 결과를 냈다. 그 결과 그대로 쓴다
    Gate(GateRead),
    /// 게이트 밖 사유로 통과시키지 않았다(돌려보내는 횟수를 센다)
    Unsettled(Unsettled),
    /// 시간 상한을 넘겼다
    Deadline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateStageStep {
    NeedRejected,
    NeedGate,
    NeedMoved,
    NeedDoneTests,
    Final(StageFinal),
}

/// 순서: 시간 상한 → 멈추지 못함 → 거절된 경로 → 게이트 → (통과면) 통과 뒤 바뀜 → (통과면) 완료 검사.
/// 시간 상한은 어느 칸에서든 먼저 본다(상한 뒤에 끝난 결과는 통과로 세우지 않는다)
pub fn decide_gate_stage(f: &GateStageFacts) -> GateStageStep {
    use GateStageStep::*;
    if f.deadline_exceeded {
        return Final(StageFinal::Deadline);
    }
    if f.pause_failed {
        return Final(StageFinal::Unsettled(Unsettled::PauseFailed));
    }
    match f.rejected {
        Probe::Unread => return NeedRejected,
        Probe::Found => return Final(StageFinal::Unsettled(Unsettled::Rejected)),
        Probe::Clear => {}
    }
    match f.gate {
        GateRead::Unread => return NeedGate,
        GateRead::Pass => {}
        other => return Final(StageFinal::Gate(other)),
    }
    match f.moved {
        Probe::Unread => return NeedMoved,
        Probe::Found => return Final(StageFinal::Unsettled(Unsettled::Moved)),
        Probe::Clear => {}
    }
    match f.done_tests {
        Probe::Unread => NeedDoneTests,
        Probe::Found => Final(StageFinal::Unsettled(Unsettled::DoneTestsFailed)),
        Probe::Clear => Final(StageFinal::Pass),
    }
}

/// 상한을 훅 상한보다 앞서 닫는 여유(초). 상한 뒤에 되돌리고 알리는 시간이다
pub const DEADLINE_MARGIN_SECONDS: u32 = 300;

/// 게이트 시간 상한(ms). CLI가 Stop 훅을 끊는 시각(`hook_seconds`)보다 여유만큼 앞이다. 상한이 여유보다 짧으면 상한의 절반을 쓴다(0이 되지 않는다)
pub fn gate_deadline_ms(hook_seconds: u32) -> u64 {
    let seconds = if hook_seconds > DEADLINE_MARGIN_SECONDS { hook_seconds - DEADLINE_MARGIN_SECONDS } else { (hook_seconds / 2).max(1) };
    u64::from(seconds) * 1000
}

#[cfg(test)]
#[path = "turn_end_rest_tests.rs"]
mod tests;
