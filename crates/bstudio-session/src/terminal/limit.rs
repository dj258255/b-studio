//! 세션 터미널의 턴 상한 전이와 "사용량을 확인할 수 없음" 판정(ADR-216, 4f B5b). 옛 구현은 `sessions.ts`의 `checkTerminalLimits` 앞부분과
//! `terminalRunLimitDeny` 근처였다(`session-terminal-telemetry-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다.
//! 사용량 파일을 읽는 토큰 한도의 판정(`judgeRunLimits`)은 파일을 읽으므로 TS에 남고, 여기는 **그것을 언제 볼지와 턴 상한의 전이**만 정한다.
//!
//! **막는 검사다. 한도에 닿은 상태를 풀거나 건너뛰는 것이 여는 쪽이다.**
//! - `budget`이 선 뒤에는 턴을 보지 않는다(실행은 멈추는 중이다. 사유가 바뀌지 않는다)
//! - `max_turns`는 풀리지 않는다. 한 번 닿은 실행은 `studio.yaml`의 상한이 바뀌어도 닿은 채다
//! - 턴 상한이 없으면 턴을 보지 않는다
//! - 알아보지 못한 사유 글은 `max_turns`로 읽는다(쓰기를 막고 토큰 한도는 계속 본다)

/// 실행이 한도에 닿은 사유
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitReason {
    None,
    /// 턴 상한에 닿았다. 실행은 열린 채 두고 턴이 끝나기를 기다린다
    MaxTurns,
    /// 세션·사람 토큰 한도에 닿아 실행을 멈추고 되돌리는 중이다
    Budget,
}

impl LimitReason {
    pub fn parse(text: &str) -> Self {
        match text {
            "none" => Self::None,
            "budget" => Self::Budget,
            _ => Self::MaxTurns,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::MaxTurns => "max_turns",
            Self::Budget => "budget",
        }
    }
}

/// 사용량이 더해진 뒤 한도를 볼 때의 사실
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimitFacts {
    /// 지금까지 선 사유
    pub reason: LimitReason,
    /// 턴 상한(`studio.yaml`의 `workflow.maxTurns`). 없으면 턴을 보지 않는다
    pub max_turns: Option<f64>,
    /// 이 실행에 붙은 모델 호출 수
    pub model_calls: u32,
    /// 실행이 이미 멈추는 중이다(중단 신호가 올랐다)
    pub aborted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LimitStep {
    /// 턴 상한을 본 뒤의 사유
    pub reason: LimitReason,
    /// 토큰 한도를 이어서 본다(멈추는 중이거나 이미 토큰 한도로 멈춘 실행은 다시 보지 않는다)
    pub check_budget: bool,
}

pub fn decide_limit(facts: &LimitFacts) -> LimitStep {
    let mut reason = facts.reason;
    if reason != LimitReason::Budget {
        if let Some(max_turns) = facts.max_turns {
            if f64::from(facts.model_calls) >= max_turns {
                reason = LimitReason::MaxTurns;
            }
        }
    }
    LimitStep { reason, check_budget: !facts.aborted && reason != LimitReason::Budget }
}

/// 쓰기 직전 훅이 이 실행의 사용량을 확인할 수 없는가. 이미 한도에 닿은 실행은 부른 쪽이 먼저 거른다.
/// - 사용량 소식이 끊겼다(U2): 턴 상한도 토큰 한도도 볼 수 없다
/// - 읽지 못한 모델 호출이 있었다: 토큰 한도가 있을 때만 볼 수 없다(턴은 센다)
pub fn usage_unverifiable(silent: bool, incomplete: bool, token_limited: bool) -> bool {
    silent || (incomplete && token_limited)
}

#[cfg(test)]
#[path = "limit_tests.rs"]
mod tests;
