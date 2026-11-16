//! 세션 터미널의 요청 시작(UserPromptSubmit)·쓰기 직전(PreToolUse)·b-studio 도구(MCP) 판정(ADR-211, 4f B4b). 옛 구현은 `sessions.ts`의 `terminalPromptSubmitted`·`terminalToolDecision`·
//! `runTerminalTool`이었다(`session-terminal-prompt-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다. 글 조립과 사실 읽기는 TS가 하고, 여기는 **사실 조합 → 결정**만 정한다.
//!
//! **순서가 판정이다**: 먼저 맞는 칸이 이긴다. 옛 코드의 `if`가 놓인 순서를 그대로 옮겼다(시험이 칸마다 고정한다).
//!
//! **기다림 앞과 뒤에서 같은 판정을 부른다**(`decide_pre_tool`). 쓰기 직전 훅과 MCP는 샌드박스 켜기(`terminalVerification`)와 보호 경로 고정(`pinBeforeWrite`)을 기다린다.
//! 기다리는 사이 같은 실행에 `[읽기만]` 요청이 이어 오거나 텔레메트리로 턴 상한에 닿거나 실행이 닫힐 수 있다. 앞의 판정은 샌드박스를 켤지 말지(일찍 거절)에만 쓰고,
//! 기다림 뒤에 그 순간의 사실로 다시 부른 판정이 **최종**이다. 옛 코드는 앞에서만 보고 닫힘만 뒤에서 봤다.
//!
//! 막는 검사다. 모르는 값은 거절이다: 한도 종류를 알아보지 못하면 `Deny(Unknown)`이다.
//!
//! 의도한 차이(옛 코드와 다른 칸. 나머지는 사실 조합 전체가 같다):
//! - 기다림 뒤에 부르면 읽기만·한도·세션 토큰 한도·카드 범위가 바뀌었을 때 거절한다(옛 코드는 닫힘만 거절했다). 시험은 `sessions-terminal-prompt.test.ts`의 P1
//! - 닫힌 실행은 읽기만·한도보다 먼저 `Closed`로 거절한다(옛 코드는 닫힌 실행을 앞에서 만나지 않아 칸이 없었다. 뒤에서는 닫힘만 봤으므로 같은 거절이다)

/// 한도에 닿은 실행의 종류(`TerminalRunState.limitReason`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    /// 한도 없음
    None,
    /// 턴 상한. 실행은 열린 채 쓰기 도구만 막는다
    MaxTurns,
    /// 세션·사람 토큰 한도. 실행을 멈추고 되돌린다
    Budget,
    /// 알아보지 못한 종류. 막는 검사라 한도에 닿은 것으로 본다
    Unknown,
}

impl Limit {
    pub fn parse(text: &str) -> Self {
        match text {
            "" | "none" => Self::None,
            "max_turns" => Self::MaxTurns,
            "budget" => Self::Budget,
            _ => Self::Unknown,
        }
    }
}

/// 요청 시작 판정의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PromptFacts {
    /// 열린 터미널 실행이 있다(세션에 걸려 있고 닫기를 시작하지 않았다)
    pub open_run: bool,
    /// 그 실행이 읽기만이다
    pub run_read_only: bool,
    /// 이번 요청이 읽기만이다(`[읽기만]`으로 시작한다)
    pub prompt_read_only: bool,
    /// 지금 터미널의 요청을 받을 수 없다는 글이 있다(`terminalBusy`)
    pub busy: bool,
    /// 요청이 `/`로 시작한다(CLI 안에서 끝나는 명령)
    pub slash: bool,
    /// 세션·사람 토큰 한도를 이미 넘었다는 글이 있다(`terminalBudgetMessage`)
    pub budget: bool,
}

/// 요청을 거절하는 까닭의 종류. 글은 TS가 가진 글을 쓴다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptBlock {
    Busy,
    Budget,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptDecision {
    /// 열린 실행에 이어 붙인다. `mark_read_only`면 이 실행에 읽기만을 켠다(한번 켜면 풀리지 않는다). `read_only`는 이어 붙은 뒤 실행이 읽기만인가(CLI에 읽기만 글을 알린다)
    Attach { mark_read_only: bool, read_only: bool },
    /// 요청을 막는다
    Block(PromptBlock),
    /// 아무것도 하지 않는다(`/` 명령은 실행을 열지 않는다)
    Nothing,
    /// 새 실행을 연다
    Open,
}

/// 옛 `terminalPromptSubmitted`의 순서: 열린 실행에 이어 붙임 → 바쁨 → `/` 명령 → 토큰 한도 → 새 실행
pub fn decide_prompt(facts: &PromptFacts) -> PromptDecision {
    if facts.open_run {
        return PromptDecision::Attach { mark_read_only: facts.prompt_read_only, read_only: facts.run_read_only || facts.prompt_read_only };
    }
    if facts.busy {
        return PromptDecision::Block(PromptBlock::Busy);
    }
    if facts.slash {
        return PromptDecision::Nothing;
    }
    if facts.budget {
        return PromptDecision::Block(PromptBlock::Budget);
    }
    PromptDecision::Open
}

/// 도구가 속할 실행을 얻었는가(`terminalRunForWork`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunAccess {
    /// 열린 실행이 있거나 새로 열었다
    Got,
    /// 바쁘다(다른 실행·저장 중·멈추는 중 등). 실행을 얻지 못했다
    Busy,
}

/// 쓰기 직전·MCP 판정의 사실. 기다림 앞과 뒤에서 그 순간의 사실로 다시 읽는다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreToolFacts {
    /// 파일을 바꾸지 않는 도구다(읽기 도구). MCP는 늘 거짓이다
    pub read_tool: bool,
    /// 세션·사람 토큰 한도를 이미 넘었다는 글이 있다
    pub budget: bool,
    pub access: RunAccess,
    /// 실행이 읽기만이다
    pub read_only: bool,
    /// 실행이 한도에 닿았다
    pub limit: Limit,
    /// 카드 실행 맥락이 있고 도구가 쓸 경로가 쓰기 범위 밖이거나 범위를 확인하지 못했다. MCP는 늘 거짓이다
    pub out_of_scope: bool,
    /// 실행이 닫혔거나 중단 신호가 올랐다(기다리는 사이 위반·취소·CLI 종료·세션 멈춤). 기다림 앞에서는 거짓이다
    pub closed: bool,
}

/// 거절하는 까닭의 종류. 글은 TS가 조립한다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenyKind {
    /// 토큰 한도를 이미 넘었다
    Budget,
    /// 실행을 얻지 못했다(바쁨)
    Busy,
    /// 읽기만 요청이다
    ReadOnly,
    /// 턴 상한에 닿았다
    MaxTurns,
    /// 토큰 한도에 닿은 실행이다
    RunBudget,
    /// 카드 쓰기 범위 밖이다
    OutOfScope,
    /// 실행이 닫혔다
    Closed,
    /// 한도 종류를 알아보지 못했다
    Unknown,
}

impl DenyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Budget => "budget",
            Self::Busy => "busy",
            Self::ReadOnly => "read_only",
            Self::MaxTurns => "max_turns",
            Self::RunBudget => "run_budget",
            Self::OutOfScope => "out_of_scope",
            Self::Closed => "closed",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreToolDecision {
    Allow,
    Deny(DenyKind),
}

/// 옛 `terminalToolDecision`의 순서: 읽기 도구 → 토큰 한도 → 바쁨 → (닫힘) → 읽기만 → 실행 한도 → 카드 범위. 모두 지나면 허용
pub fn decide_pre_tool(facts: &PreToolFacts) -> PreToolDecision {
    use PreToolDecision::{Allow, Deny};
    if facts.read_tool {
        return Allow;
    }
    if facts.budget {
        return Deny(DenyKind::Budget);
    }
    if facts.access == RunAccess::Busy {
        return Deny(DenyKind::Busy);
    }
    // 닫힌 실행은 읽기만·한도 글보다 먼저 거절한다. 기다리는 사이 닫힌 실행의 쓰기는 되돌린 뒤에 파일을 바꾸는 쓰기다
    if facts.closed {
        return Deny(DenyKind::Closed);
    }
    if facts.read_only {
        return Deny(DenyKind::ReadOnly);
    }
    match facts.limit {
        Limit::None => {}
        Limit::MaxTurns => return Deny(DenyKind::MaxTurns),
        Limit::Budget => return Deny(DenyKind::RunBudget),
        Limit::Unknown => return Deny(DenyKind::Unknown),
    }
    if facts.out_of_scope {
        return Deny(DenyKind::OutOfScope);
    }
    Allow
}

/// 다음 요청에 켜 둔 확인 선언 변경 허용을 이 실행이 가져가는가(ADR-164). 사람의 요청이 연 만들기 실행만 가져간다.
/// 요청 훅 없이 도구 호출이 연 실행(에이전트가 이어 가던 낡은 턴)은 가져가지 않고, 읽기만은 게이트를 돌리지 않으므로 남겨 둔다
pub fn takes_check_changes(opened_by_prompt: bool, read_only: bool, allowed_next: bool) -> bool {
    opened_by_prompt && !read_only && allowed_next
}

#[cfg(test)]
#[path = "prompt_tests.rs"]
mod tests;
