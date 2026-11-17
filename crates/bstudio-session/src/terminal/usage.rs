//! 세션 터미널의 사용량 귀속·정체 판정(ADR-213, 4f B4d). 옛 구현은 `sessions.ts`의 `countTerminalUsageOnce`·`attributeRunUsage`의 분기·`checkTerminalStall`이었다
//! (`session-terminal-usage-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다. 기억(Set), 저장, 알림, 글 조립은 TS가 하고, 여기는 **요청 하나를 어떻게 처리할지**만 정한다.
//!
//! **막는 검사다. 덜 세는 쪽이 여는 쪽이다.** 사용량은 턴 상한과 토큰 한도의 입력이므로, 덜 세면 한도가 늦게 걸린다. 모르는 값은 센다:
//! 요청 번호가 없으면 중복을 가릴 수 없어 그대로 센다. 순서는 옛 코드 그대로다(먼저 맞는 칸이 이긴다).
//!
//! - `decide_usage`: 셀지(한도 계산용 중복), 어느 실행에 붙일지(열린 실행 → 막 닫힌 실행 → 없음), 중복 붙임 거르기, 턴을 셀지, 한도를 볼지
//! - `decide_stall`: 열린 실행이 없으면 멈춤, 이미 알렸으면 아무것도 하지 않음, 정체 시간을 넘겼으면 알림
//! - `stall_interval_ms`: 감시 주기. 정체 시간의 1/4(최소 1초)라 알림이 정체 시간의 1.25배 안에 간다
//! - `decide_silence`: 열린 실행이 사용량 소식(텔레메트리)을 한 번도 받지 못한 채 쓰기 훅만 이어지는가
//!
//! 의도한 차이(옛 코드와 다른 칸. 나머지는 사실 조합 전체가 같다):
//! - 도구 호출이 연 실행(요청 훅 없이 열렸다)에는 열린 시각보다 `EARLY_USAGE_MS` 안에 앞선 요청도 붙는다. 그 도구를 정한 모델 요청은 도구 훅(실행을 여는 것)보다 먼저 끝나므로,
//!   옛 코드는 그 턴을 세지 않았다(U5). 앞서 닫힌 실행의 시간 안에 드는 요청은 그쪽 몫이라 그대로 닫힌 실행에 붙는다
//! - 정체 감시 주기가 정체 시간의 1/4(최소 1초)다. 옛 주기는 정체 시간과 같아 알림이 최대 두 배 늦었다(U6)
//! - `decide_silence`는 새 판정이다(옛 코드에는 칸이 없었다, U2)

/// 도구 호출이 연 실행에 붙이는, 열린 시각 앞의 시간(ms). 모델 요청의 끝 시각이 그 요청이 정한 도구 훅보다 앞서기 때문이다
pub const EARLY_USAGE_MS: i64 = 5_000;
/// 실행이 닫힌 뒤 늦게 닿는 텔레메트리를 그 실행의 몫으로 보는 시간(ms, #726)
pub const LATE_USAGE_MS: i64 = 5_000;
/// 텔레메트리 없이 이만큼(개) 넘게 쓰기 훅이 오고
pub const SILENT_WRITE_HOOKS: u32 = 10;
/// 실행이 열린 지 이만큼(ms) 지나면 사용량 소식이 끊긴 것으로 본다(내보내기 주기는 1초다)
pub const SILENT_AFTER_MS: i64 = 30_000;

/// 요청 하나를 처리하기 전의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsageFacts {
    /// 요청 번호가 있다
    pub has_request_id: bool,
    /// 한도 계산용으로 이 번호를 이미 셌다
    pub counted: bool,
    /// 실행 귀속용으로 이 번호를 이미 붙였다
    pub attached: bool,
    /// 열린 터미널 실행이 있다
    pub open_run: bool,
    /// 요청 시각이 열린 실행의 시작 이후다
    pub in_open_window: bool,
    /// 요청 시각이 열린 실행의 시작보다 `EARLY_USAGE_MS` 안에 앞선다
    pub in_early_slack: bool,
    /// 열린 실행이 요청 훅이 아니라 도구 호출이 열었다
    pub opened_by_tool: bool,
    /// 요청 시각이 가장 최근에 닫힌 실행의 시작과 끝 사이다
    pub in_closed_run: bool,
    /// 요청 시각이 그 실행의 끝보다 뒤이고 `LATE_USAGE_MS` 안이다
    pub in_closed_late: bool,
}

/// 붙일 실행
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunTarget {
    /// 어느 실행에도 붙이지 않는다(세션 합계에는 더한다)
    None,
    /// 지금 열린 실행
    Open,
    /// 막 닫힌 실행
    Closed,
}

impl RunTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Open => "open",
            Self::Closed => "closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsageStep {
    /// 세션 합계·에이전트 내역·사용량 화면·사람 몫에 더한다
    pub count: bool,
    pub target: RunTarget,
    /// 열린 실행의 합계와 턴(모델 호출 수)에 센다
    pub count_turn: bool,
    /// 더한 뒤 한도를 본다(열린 실행이 아직 있을 때만, 그 확인은 TS가 한다)
    pub check_limits: bool,
}

impl UsageStep {
    /// 이 요청이 붙은 열린 실행에 "사용량 소식이 왔다"(U2)를 세운다. 요청이 실제로 붙은 실행에만 세운다 —
    /// 앞 실행의 늦은 사용량이 새 실행의 끊김 판정을 꺼 버리지 않게 한다(ADR-216, N5). 붙지 않은 요청과 닫힌 실행에 붙은 요청은 세우지 않는다
    pub fn marks_telemetry_seen(&self) -> bool {
        self.target == RunTarget::Open
    }
}

/// 옛 `attributeRunUsage`의 순서: 한도용 중복 → (열린 실행의 창 → 막 닫힌 실행의 창) → 귀속용 중복 → 턴 → 한도
pub fn decide_usage(facts: &UsageFacts) -> UsageStep {
    // 요청 번호가 없으면 중복을 가릴 수 없다. 모르면 센다
    let count = !facts.has_request_id || !facts.counted;
    let mut target = if facts.open_run && facts.in_open_window {
        RunTarget::Open
    } else if facts.open_run && facts.opened_by_tool && facts.in_early_slack && !facts.in_closed_run {
        RunTarget::Open
    } else if facts.in_closed_run || facts.in_closed_late {
        RunTarget::Closed
    } else {
        RunTarget::None
    };
    // 같은 번호를 이미 붙였으면 다시 붙이지 않는다. 실행 밖으로 버린 것은 기억하지 않으므로(TS) 나중에 맞는 창에서 와도 놓치지 않는다
    if target != RunTarget::None && facts.has_request_id && facts.attached {
        target = RunTarget::None;
    }
    UsageStep { count, target, count_turn: target == RunTarget::Open, check_limits: count }
}

/// 정체 감시 한 회차의 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StallFacts {
    pub open_run: bool,
    /// 이 실행에서 정체 경고를 이미 보냈다
    pub notified: bool,
    /// 마지막 활동 뒤 흐른 시간(ms). 시계가 거꾸로 갔으면 음수다
    pub idle_ms: i64,
    pub stall_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StallStep {
    /// 열린 실행이 없다: 감시를 멈춘다
    Stop,
    Nothing,
    /// 정체 경고를 보낸다
    Notify,
}

/// 옛 `checkTerminalStall`의 순서: 열린 실행 없음 → 이미 알림 → 정체 시간 미만 → 알림. 알리기만 하는 판정이라 막지 않는다
pub fn decide_stall(facts: &StallFacts) -> StallStep {
    if !facts.open_run {
        return StallStep::Stop;
    }
    if facts.notified {
        return StallStep::Nothing;
    }
    if facts.idle_ms < 0 || (facts.idle_ms as u64) < facts.stall_ms {
        return StallStep::Nothing;
    }
    StallStep::Notify
}

/// 정체 감시 주기(ms): 정체 시간의 1/4, 최소 1초. 알림이 마지막 활동 뒤 정체 시간의 1.25배 안에 간다
pub fn stall_interval_ms(stall_ms: u64) -> u64 {
    (stall_ms / 4).max(1_000)
}

/// 사용량 소식이 끊겼는지 보는 사실
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SilenceFacts {
    /// 이 CLI가 모델 요청마다 사용량을 보낸다고 알려져 있다(아니면 소식이 없어도 이상한 것이 아니다)
    pub cli_sends_usage: bool,
    /// 이 실행이 열린 뒤 사용량 소식을 한 번이라도 받았다
    pub telemetry_seen: bool,
    /// 이 실행이 열린 뒤 온 쓰기 도구 훅의 수
    pub write_hooks: u32,
    /// 이 실행이 열린 지 흐른 시간(ms). 시계가 거꾸로 갔으면 음수다
    pub elapsed_ms: i64,
    /// 이 세션이 앞선 실행에서 이미 끊김으로 판정됐고, 그 뒤 사용량 소식을 한 번도 받지 못했다.
    /// 실행마다 셈을 새로 하면 실행마다 쓰기 `SILENT_WRITE_HOOKS`번·`SILENT_AFTER_MS`를 셈 없이 다시 준다
    pub silent_before: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Silence {
    Fine,
    /// 한도를 볼 수 없다: 쓰기 도구를 막는다
    Silent,
}

/// 소식을 받은 적이 있으면 정상이다. 없으면 쓰기 훅이 `SILENT_WRITE_HOOKS`개를 넘고 열린 지 `SILENT_AFTER_MS`가 지났을 때만 끊긴 것으로 본다.
/// 흐른 시간을 알 수 없으면(음수) 시간 조건은 지난 것으로 본다(막는 검사라 모르면 막는 쪽이다)
pub fn decide_silence(facts: &SilenceFacts) -> Silence {
    if !facts.cli_sends_usage || facts.telemetry_seen {
        return Silence::Fine;
    }
    // 이미 끊김을 본 세션은 여유를 다시 주지 않는다(소식이 오면 부른 쪽이 표시를 지운다)
    if facts.silent_before {
        return Silence::Silent;
    }
    let late = facts.elapsed_ms < 0 || facts.elapsed_ms >= SILENT_AFTER_MS;
    if facts.write_hooks > SILENT_WRITE_HOOKS && late {
        Silence::Silent
    } else {
        Silence::Fine
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
