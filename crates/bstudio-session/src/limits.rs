//! 토큰 한도 판정(ADR-209, 4f B3c). 세 자리(요청 시작·대화 실행 중·터미널 실행 중)가 **같은 함수** 하나를 부른다.
//! 옛 구현은 `sessions.ts`에 셋으로 흩어져 있었다(`session-limits-legacy.ts`는 #1347에서 지웠다):
//! - 요청 시작과 터미널 실행 중: 세션 합계 >= 세션 한도, 파일의 사람 합계 >= 사람 한도
//! - 대화 실행 중: 같은 세션 판정 + `파일의 사람 합계 + 이 실행 누적 >= 사람 한도`. 파일에는 이 실행이 이미 저장한 몫이 들어 있어 그 몫을 두 번 세고 일찍 멈췄다
//!
//! 사람 몫 = 파일 합계 − 이 실행이 저장을 마친 몫 + 이 실행 누적. 저장을 마친 몫은 쓰기가 성공한 뒤에만 늘어나므로, 저장이 끝나지 않았거나 실패한
//! 증가분은 누적에만 있고 몫에서 빠지지 않아 한도에 센다(파일 합계만 보던 옛 터미널 판정은 그만큼 늦게 멈췄다). 요청 시작은 이 실행 누적이 0이라
//! 옛 판정과 같다. 순서(세션 한도가 먼저)와 경계(`>=`)도 옛 판정과 같다.
//!
//! 막는 검사이므로 **모르는 입력은 넘은 것으로** 본다: 수가 아니거나(NaN) 무한하거나 음수인 값, 0 이하인 한도는 판정할 수 없어 한도에 닿은 것으로 처리한다
//! (조용히 "넘지 않음"이 되지 않는다). 파일 합계에서 저장 몫을 뺀 값이 음수가 되는 것(기간이 바뀌어 새 기간 파일에는 저장 몫이 없다)은 0으로 둔다.
//! 이때 사람 몫은 이 실행 누적만큼으로 세므로 옛 판정(파일 합계 + 이 실행 누적)과 같다.

/// 판정 결과
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// 어느 한도도 넘지 않았다
    Within,
    /// 세션 한도에 닿았다(세션 한도가 사람 한도보다 먼저다)
    Session,
    /// 사람 한도에 닿았다
    User,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Within => "ok",
            Self::Session => "session",
            Self::User => "user",
        }
    }
}

/// 사람 한도가 있을 때의 입력
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UserShare {
    pub limit: f64,
    /// 그 기간 파일의 사람 합계
    pub file_total: f64,
    /// 이 실행이 저장을 마친 몫(쓰기가 성공한 것만)
    pub saved: f64,
    /// 이 실행 누적(저장 여부와 상관없이 이 실행이 쓴 양). 요청 시작이면 0
    pub accum: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Input {
    /// 세션 합계(이 실행을 반영한 값)
    pub session_total: f64,
    pub session_limit: Option<f64>,
    /// 사람 한도를 정하지 않았거나 누가 보냈는지 모르면 없다
    pub user: Option<UserShare>,
}

/// 세는 값으로 쓸 수 있는가(수이고 유한하고 0 이상)
fn countable(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

/// 한도로 쓸 수 있는가(수이고 유한하고 0보다 크다. 설정은 양의 정수로만 받는다)
fn usable_limit(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

/// `used`가 `limit`에 닿았는가. 읽을 수 없는 입력은 닿은 것으로 본다
fn reached(used: f64, limit: f64) -> bool {
    !countable(used) || !usable_limit(limit) || used >= limit
}

/// 사람 몫. 읽을 수 없는 입력이 하나라도 있으면 `None`(닿은 것으로 처리한다)
pub fn user_total(share: &UserShare) -> Option<f64> {
    if !countable(share.file_total) || !countable(share.saved) || !countable(share.accum) {
        return None;
    }
    Some((share.file_total - share.saved).max(0.0) + share.accum)
}

pub fn judge(input: &Input) -> Verdict {
    if let Some(limit) = input.session_limit {
        if reached(input.session_total, limit) {
            return Verdict::Session;
        }
    }
    if let Some(share) = &input.user {
        match user_total(share) {
            Some(total) if !reached(total, share.limit) => {}
            _ => return Verdict::User,
        }
    }
    Verdict::Within
}

#[cfg(test)]
mod tests;
