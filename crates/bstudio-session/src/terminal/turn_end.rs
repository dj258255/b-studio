//! 세션 터미널의 턴 끝(Stop 훅) 판정(ADR-212, 4f B4c). 옛 구현은 `sessions.ts`의 `finishTerminalTurn`이었다(`session-terminal-turn-end-legacy.ts`가 차등 시험의 기준으로 남아 있다).
//! Node를 모른다. 되돌리기·저장·알림·글 조립과 사실 읽기는 TS가 하고, 여기는 **사실 조합 → 다음 할 일 하나**만 정한다.
//!
//! **순서가 판정이다**: 먼저 맞는 칸이 이긴다. 옛 코드의 `if`가 놓인 순서를 그대로 옮겼다(시험이 칸마다 고정한다).
//!
//! **읽기가 부수 효과인 사실은 `Unread`로 들어온다.** Git 맞추기(`reconcileTerminalGit`)는 실행을 닫을 수 있고, 지문·변경 목록 읽기는 기다린다. 판정이 그 사실이 필요한 칸에 닿았는데 `Unread`면
//! `Need*`를 돌려주고, TS는 그 사실을 읽어 채운 뒤 **닫힘·미룬 위반·위반을 포함한 모든 사실을 그 순간 값으로 다시 읽어** 같은 판정을 다시 부른다.
//! 그래서 기다림 사이에 실행이 닫히거나 위반이 오면 다음 부름이 먼저 본다(옛 코드는 닫힘·위반을 처음과 통과 직전에만 봤다).
//!
//! 막는 검사다. 모르는 값은 통과가 아니다: 재지 못한 지문(`Unknown`)은 읽기만 실패이고, 알아보지 못한 게이트 결과는 `Unknown`으로 닫는다.
//!
//! 의도한 차이(옛 코드와 다른 칸. 나머지는 사실 조합 전체가 같다):
//! - 읽기만이 **앞선 변경이 있는 실행에 이어 켜졌다면**(`read_only_after_work`) 읽기만 지름길(지문 견주기 → 바뀐 것 없음으로 done)을 타지 않고 일반 칸(게이트)으로 간다(S6)
//! - 위반·닫힘을 기다림 사이에도 다시 본다(Git 맞추기·지문·변경 목록을 읽은 뒤): 옛 코드는 처음과 통과 직전에만 봤다
//! - 게이트 밖 사유로 돌려보낸 횟수(`unsettled_attempts`)와 게이트가 센 횟수(`gate_attempts`)를 합쳐 상한(`max_attempts`)과 견준다(S12). 옛 코드는 둘을 따로 세어 최대 2배까지 돌려보냈다
//! - 알아보지 못한 게이트 결과는 `Unknown`(닫는 쪽)이다. 옛 코드는 빈 답 `{}`로 돌아와 실행이 열린 채 남았다

/// Git 맞추기(`reconcileTerminalGit`)의 결과
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitCheck {
    /// 아직 읽지 않았다
    Unread,
    /// 기억한 곳과 같거나 풀어서 검증에 넣었다
    Aligned,
    /// 되돌리고 실행을 실패로 닫았다(또는 기억이 없어 확인하지 못했다)
    Failed,
}

impl GitCheck {
    /// 알아보지 못한 글은 실패다(막는 쪽)
    pub fn parse(text: &str) -> Self {
        match text {
            "unread" => Self::Unread,
            "aligned" => Self::Aligned,
            _ => Self::Failed,
        }
    }
}

/// 읽기만 실행의 지문 견주기: 열릴 때 잡은 지문과 지금 지문
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fingerprint {
    Unread,
    Same,
    Different,
    /// 열릴 때 지문이 없거나 지금 지문을 재지 못했다. 확신할 수 없으므로 통과가 아니다
    Unknown,
}

impl Fingerprint {
    pub fn parse(text: &str) -> Self {
        match text {
            "unread" => Self::Unread,
            "same" => Self::Same,
            "different" => Self::Different,
            _ => Self::Unknown,
        }
    }
}

/// 작업 복사본에 바뀐 파일이 없는가(추적 파일과 생성 파일 모두)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unchanged {
    Unread,
    Yes,
    No,
    /// 읽지 못했다. 바뀐 것 없음으로 보지 않는다
    Unknown,
}

impl Unchanged {
    pub fn parse(text: &str) -> Self {
        match text {
            "unread" => Self::Unread,
            "yes" => Self::Yes,
            "no" => Self::No,
            _ => Self::Unknown,
        }
    }
}

/// 카드의 쓰기 범위 확인(`changesOutsideTools`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardScope {
    Unread,
    Inside,
    Outside,
}

impl CardScope {
    /// 알아보지 못한 글은 범위 밖이다(막는 쪽)
    pub fn parse(text: &str) -> Self {
        match text {
            "unread" => Self::Unread,
            "inside" => Self::Inside,
            _ => Self::Outside,
        }
    }
}

/// 게이트 앞 단계의 사실. `Unread`인 것은 TS가 그 칸에 닿았을 때 읽는다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TurnEndFacts {
    /// 실행이 닫혔다(닫기를 시작했다)
    pub closed: bool,
    /// 감시가 담아 둔 위반이 있다(열린 실행이 없을 때 받은 것)
    pub pending_violation: bool,
    /// 이 실행에 적힌 위반이 있다
    pub violation: bool,
    /// 이 실행이 읽기만이다
    pub read_only: bool,
    /// 읽기만이 앞선 변경이 있는 실행에 이어 켜졌다(검증 상태가 이미 세워져 있었다)
    pub read_only_after_work: bool,
    pub git: GitCheck,
    pub fingerprint: Fingerprint,
    /// 변경 전 기준(검증 상태)이 이미 세워져 있다
    pub verification: bool,
    pub unchanged: Unchanged,
    /// 카드에 완료 검사가 있다
    pub done_tests: bool,
    /// 카드 실행 맥락이 걸려 있다
    pub has_card: bool,
    pub card: CardScope,
    /// 게이트 밖 사유로 돌려보낸 횟수(이번 판정 앞까지)
    pub unsettled_attempts: u32,
    /// 게이트가 센 실패 횟수
    pub gate_attempts: u32,
    pub max_attempts: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnEndStep {
    /// 아무것도 하지 않는다(닫힌 실행)
    Nothing,
    /// 담아 둔 위반을 가져가 실행을 실패로 닫고 되돌린다
    FailPendingViolation,
    /// 이 실행의 위반으로 실패로 닫고 되돌린다
    FailViolation,
    /// Git 맞추기를 읽는다. `allow_unwind`는 직접 만든 커밋을 풀어 검증에 넣는가(읽기만은 풀지 않는다)
    NeedGit { allow_unwind: bool },
    /// Git 맞추기가 실행을 닫았다. 글은 그 결과에 있다
    GitFailed,
    NeedFingerprint,
    /// 읽기만 실행인데 바뀌었거나(`unverified` 거짓) 바뀌었는지 확인하지 못했다(`unverified` 참). 실패로 닫고 되돌린다
    ReadOnlyFail { unverified: bool },
    /// 읽기만 실행이 바꾼 것이 없다. 게이트 없이 done
    ReadOnlyDone,
    NeedUnchanged,
    /// 바뀐 것 없음, 완료 검사 없음. 샌드박스를 켜지 않고 done
    SettleUnchanged,
    /// 바뀐 것 없음, 완료 검사 있음. 완료 검사만 직접 돌린다
    RunDoneTests,
    NeedCardScope,
    /// 쓰기 범위 밖 변경. 상한 전이면 돌려보낸다
    CardRetry,
    /// 쓰기 범위 밖 변경. 상한에 닿아 실패로 닫는다
    CardExhausted,
    /// 게이트를 돌린다
    RunGate,
}

/// 옛 `finishTerminalTurn`의 앞 순서: 닫힘 → 미룬 위반 → 위반 → Git 맞추기 → (읽기만: 지문) → 바뀐 것 없음 → 카드 범위 → 게이트
pub fn decide_turn_end(f: &TurnEndFacts) -> TurnEndStep {
    use TurnEndStep::*;
    if f.closed {
        return Nothing;
    }
    if f.pending_violation {
        return FailPendingViolation;
    }
    if f.violation {
        return FailViolation;
    }
    // 읽기만 지름길은 앞선 변경이 없는 읽기만 실행만 탄다. 앞선 변경이 있으면 일반 칸으로 가서 그 변경이 게이트를 지난다
    let read_only = f.read_only && !f.read_only_after_work;
    match f.git {
        GitCheck::Unread => return NeedGit { allow_unwind: !read_only },
        GitCheck::Failed => return GitFailed,
        GitCheck::Aligned => {}
    }
    if read_only {
        return match f.fingerprint {
            Fingerprint::Unread => NeedFingerprint,
            Fingerprint::Same => ReadOnlyDone,
            Fingerprint::Different => ReadOnlyFail { unverified: false },
            Fingerprint::Unknown => ReadOnlyFail { unverified: true },
        };
    }
    match f.unchanged {
        Unchanged::Unread => return NeedUnchanged,
        Unchanged::Yes if !f.verification => return if f.done_tests { RunDoneTests } else { SettleUnchanged },
        _ => {}
    }
    if f.has_card {
        match f.card {
            CardScope::Unread => return NeedCardScope,
            CardScope::Outside => return if exhausted(f.unsettled_attempts.saturating_add(1), f.gate_attempts, f.max_attempts) { CardExhausted } else { CardRetry },
            CardScope::Inside => {}
        }
    }
    RunGate
}

/// 게이트 밖 사유와 게이트 쪽을 합친 횟수가 상한에 닿았는가. 상한이 0이면 첫 실패부터 닿는다
fn exhausted(unsettled: u32, gate: u32, max: u32) -> bool {
    unsettled.saturating_add(gate) >= max
}

/// 결과를 어느 길에서 얻었는가
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GatePath {
    /// 게이트를 돌렸다
    Gate,
    /// 게이트 없이 완료 검사만 직접 돌렸다(바뀐 것 없음 지름길)
    DoneTests,
}

impl GatePath {
    /// 알아보지 못한 글은 게이트다(취소·턴 상한을 보는 더 엄격한 길)
    pub fn parse(text: &str) -> Self {
        if text == "done_tests" {
            Self::DoneTests
        } else {
            Self::Gate
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateKind {
    Pass,
    Retry,
    Exhausted,
    /// 알아보지 못한 결과
    Unknown,
}

impl GateKind {
    pub fn parse(text: &str) -> Self {
        match text {
            "pass" => Self::Pass,
            "retry" => Self::Retry,
            "exhausted" => Self::Exhausted,
            _ => Self::Unknown,
        }
    }
}

/// 게이트(또는 완료 검사) 뒤의 사실. 결과를 낸 순간이 아니라 **판정을 부르는 이 순간** 값으로 읽는다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GateFacts {
    pub path: GatePath,
    pub outcome: GateKind,
    /// 실행이 취소됐거나 세션이 멈췄다
    pub cancelled: bool,
    /// 이 실행이 턴 상한에 닿았다
    pub max_turns_limit: bool,
    /// 이 실행에 위반이 적혀 있다
    pub violation: bool,
    /// 게이트 밖 사유로 돌려보낸 횟수(이번 것을 센 뒤)
    pub unsettled_attempts: u32,
    pub gate_attempts: u32,
    pub max_attempts: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateStep {
    /// 취소·멈춤을 던진다(catch가 닫는다)
    ThrowCancel,
    /// 통과. 게이트 길이면 체크포인트를 남기고, 완료 검사 길이면 바뀐 것 없이 done으로 닫는다
    Pass,
    /// 통과였지만 위반이 적혀 있다. 실패로 닫고 되돌린다
    FailViolation,
    /// 에이전트에게 돌려준다
    Retry,
    /// 실패로 닫고 되돌린다. `max_turns`는 턴 상한 때문이다
    Exhaust { max_turns: bool, attempts: bool },
    /// 알아보지 못한 결과라 실패로 닫는다
    Unknown,
}

/// 옛 순서. 게이트 길: 취소 → (턴 상한에 닿은 재시도는 소진) → 통과면 위반 확인 → 재시도·소진.
/// 완료 검사 길: 위반 → 통과 / 재시도·소진(취소·턴 상한을 보지 않는다)
pub fn decide_gate_outcome(f: &GateFacts) -> GateStep {
    use GateStep::*;
    if f.path == GatePath::DoneTests {
        if f.violation {
            return FailViolation;
        }
        return match f.outcome {
            GateKind::Pass => Pass,
            GateKind::Retry => retry_or_exhaust(f),
            GateKind::Exhausted => Exhaust { max_turns: false, attempts: false },
            GateKind::Unknown => Unknown,
        };
    }
    if f.cancelled {
        return ThrowCancel;
    }
    // 턴 상한에 닿은 실행은 재시도하지 않는다(ADR-131)
    if f.max_turns_limit && f.outcome == GateKind::Retry {
        return Exhaust { max_turns: true, attempts: false };
    }
    match f.outcome {
        GateKind::Pass => {
            if f.violation {
                FailViolation
            } else {
                Pass
            }
        }
        GateKind::Retry => retry_or_exhaust(f),
        GateKind::Exhausted => Exhaust { max_turns: false, attempts: false },
        GateKind::Unknown => Unknown,
    }
}

fn retry_or_exhaust(f: &GateFacts) -> GateStep {
    if exhausted(f.unsettled_attempts, f.gate_attempts, f.max_attempts) {
        GateStep::Exhaust { max_turns: false, attempts: true }
    } else {
        GateStep::Retry
    }
}

/// 체크포인트를 남긴 직후의 판정(S1). 남기는 동안 위반이 왔으면 통과로 닫지 않고 실패로 닫는다.
/// 체크포인트의 내용은 게이트가 본 내용과 같음을 저장이 확인했으므로 체크포인트는 그대로 두고, 작업 복사본의 그 뒤 변경만 방금 남긴 체크포인트로 되돌린다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SavedStep {
    Settle,
    FailViolation,
}

pub fn decide_after_checkpoint(violation: bool) -> SavedStep {
    if violation {
        SavedStep::FailViolation
    } else {
        SavedStep::Settle
    }
}

#[cfg(test)]
#[path = "turn_end_tests.rs"]
mod tests;
