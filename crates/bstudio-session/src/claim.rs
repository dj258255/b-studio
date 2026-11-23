//! 세션이 "바쁜지"를 정하는 점유(ADR-207, 4f B3a). 옛 구현은 `sessions.ts`의 `snapshot.running`(boolean)·`session.run`의 유무·`session.exporting`이었다
//! (옛 구현 `session-claim-legacy.ts`는 #1347에서 지웠다). Node를 모른다. 점유는 수명 코어(`SessionState`)의 같은 자물쇠 아래에 있어
//! 상태·멈추는 중 여부를 확인하고 잡는 일이 한 번에 된다.
//!
//! **점유는 자리 하나(`slot`)와 올리기 하나(`export`)다.**
//! - `slot`: 실행(대화 창의 요청이나 터미널의 실행. `run_id`와 단계 `진행`·`취소 중`·`체크포인트 저장 중`) 또는 보조 작업(되돌리기·백업 되살리기·원격 가져오기·다시 검증·기준 브랜치 따라잡기).
//!   옛 `running`이 참인 때와 같다. 둘이 한 자리를 나누므로 서로 겹치지 않는다
//! - `export`: 원격 저장소 올리기. 옛 `exporting`이다. 올리기가 도는 동안 기준 브랜치 따라잡기가 `slot`을 잡을 수 있어 둘은 따로다
//!
//! 잡으면 **표**(`Ticket`)를 돌려주고, 풀 때는 그 표를 낸다. 표가 지금 점유의 표가 아니면 아무것도 하지 않는다(`release`가 `false`).
//! 표는 늘기만 하고 다시 쓰지 않으므로 늦게 끝난 작업이 그 사이에 새로 잡힌 점유를 풀 수 없다. 옛 코드는 누가 잡았는지가 없어
//! 한 작업이 끝나며 다른 작업의 `running`을 풀 수 있었다.
//!
//! 판정(요청·취소·진행 중 지시·보조 작업·터미널 실행·모델 바꾸기 같은 `running` 409·올리기·지우기)도 여기서 한다. **오류 코드와 글, 검사 순서는 옛 코드와 같다**.
//! 다른 것은 결함을 고친 자리뿐이다:
//! - 지우기: 점유 중이면 상태가 `idle`이어도 거절한다(옛 코드는 상태만 봤다)
//! - 멈추는 중이면 요청·보조 작업·터미널 실행 시작을 거절한다(옛 코드는 통과했다). 이 검사는 다른 거절 뒤에 둔다: 같은 입력에서 옛 코드가 먼저 내던 오류는 그대로 먼저 난다
//! - 멈춘 세션에서 터미널 실행을 시작하지 않는다
//!
//! 멈추기가 끝나 상태가 `stopped`가 되면 코어가 `slot`을 비운다(`Claims::clear_slot`). 옛 `mark_services_stopped`가 하던 `running=false`와 같은 일을 점유 쪽에서 한다
//! (남의 점유를 지우지만 멈춘 세션은 새 점유를 받지 않고, 늦게 끝나는 작업은 무효가 된 표로 아무것도 하지 않는다).

use crate::lifecycle::Fail;
use crate::status::{SessionState, SessionStatus};

pub type Ticket = u64;

/// 멈추는 중이거나 멈춘 세션에 시작을 거절하는 글(B2b `ensureBooted`의 멈춤 글과 같다)
pub const STOPPING_MESSAGE: &str = "중지된 세션입니다. 이어서 작업하면 새 샌드박스를 띄웁니다";

/// 실행의 단계
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// 진행 중(`session.run`이 걸려 있고 취소하지 않았다)
    Running,
    /// 취소를 받았고 되돌리는 중이다(`session.run`은 그대로 걸려 있다)
    Cancelling,
    /// 에이전트가 끝났고 체크포인트를 저장하는 중이다(`session.run`은 풀렸지만 `running`은 켜져 있다)
    Saving,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Cancelling => "cancelling",
            Self::Saving => "saving",
        }
    }
}

/// 보조 작업의 종류
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskKind {
    Restore,
    RestoreBackup,
    SyncRemote,
    Reverify,
    CatchUpBase,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restore => "restore",
            Self::RestoreBackup => "restore_backup",
            Self::SyncRemote => "sync_remote",
            Self::Reverify => "reverify",
            Self::CatchUpBase => "catch_up_base",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "restore" => Self::Restore,
            "restore_backup" => Self::RestoreBackup,
            "sync_remote" => Self::SyncRemote,
            "reverify" => Self::Reverify,
            "catch_up_base" => Self::CatchUpBase,
            _ => return None,
        })
    }

    /// 샌드박스가 준비되지 않았을 때의 글(옛 코드의 글)
    fn not_ready(self) -> &'static str {
        match self {
            Self::Restore => "샌드박스가 준비된 뒤에 되돌릴 수 있습니다",
            Self::RestoreBackup => "샌드박스가 준비된 뒤에 되살릴 수 있습니다",
            Self::SyncRemote => "샌드박스가 준비된 뒤에 가져올 수 있습니다",
            Self::Reverify => "샌드박스가 준비된 뒤에 다시 검증할 수 있습니다",
            Self::CatchUpBase => "",
        }
    }

    /// 다른 작업이 점유 중일 때의 글(옛 코드의 글)
    fn busy(self) -> &'static str {
        match self {
            Self::Reverify => "다른 작업을 처리하는 중입니다. 끝난 뒤 다시 검증하세요",
            _ => "다른 작업을 처리하는 중입니다",
        }
    }
}

/// `running`을 보고 거절하던 곳(보조 작업이 아닌 것). 글은 옛 코드의 글이다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BusyOp {
    SetModel,
    SaveRequirements,
    ManualVerify,
    ManualClear,
    WriteRequirementsDoc,
}

impl BusyOp {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "set_model" => Self::SetModel,
            "save_requirements" => Self::SaveRequirements,
            "manual_verify" => Self::ManualVerify,
            "manual_clear" => Self::ManualClear,
            "write_requirements_doc" => Self::WriteRequirementsDoc,
            _ => return None,
        })
    }

    fn message(self) -> &'static str {
        match self {
            Self::SetModel => "요청을 처리하는 동안에는 모델을 바꿀 수 없습니다",
            Self::SaveRequirements => "요청을 처리하는 동안에는 요구사항을 저장할 수 없습니다. 끝난 뒤에 저장해 주세요",
            Self::ManualVerify => "요청을 처리하는 동안에는 사람 확인을 남길 수 없습니다. 끝난 뒤에 눌러 주세요",
            Self::ManualClear => "요청을 처리하는 동안에는 사람 확인을 취소할 수 없습니다. 끝난 뒤에 눌러 주세요",
            Self::WriteRequirementsDoc => "요청을 처리하는 동안에는 요구사항 문서를 저장할 수 없습니다. 끝난 뒤에 저장해 주세요",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Holder {
    Run { run_id: String, phase: Phase, terminal: bool },
    Task(TaskKind),
}

#[derive(Clone, Debug)]
pub(crate) struct Slot {
    pub(crate) ticket: Ticket,
    pub(crate) holder: Holder,
}

#[derive(Default)]
pub struct Claims {
    /// 마지막으로 낸 표. 늘기만 한다(점유를 비워도 줄지 않는다)
    last: Ticket,
    pub(crate) slot: Option<Slot>,
    export: Option<Ticket>,
    /// 터미널 실행마다의 닫힘·CLI 종료 표시(ADR-210). 점유와 한 자물쇠 아래에 있어 "열린 실행인가"가 한 번에 정해진다
    pub(crate) terminal: crate::terminal::Runs,
}

impl Claims {
    fn issue(&mut self) -> Ticket {
        self.last += 1;
        self.last
    }

    pub(crate) fn clear_slot(&mut self) {
        self.slot = None;
    }

    fn busy(&self) -> bool {
        self.slot.is_some()
    }
}

/// 취소 요청의 결과(`Err`가 아닌 것)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelOutcome {
    /// 단계를 `취소 중`으로 바꿨다. 부른 쪽이 중단 신호를 올린다
    Started,
    /// 이미 취소 중이다. 아무것도 하지 않고 돌아온다
    AlreadyCancelling,
}

/// 지금 점유의 모습(시험·진단용)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimView {
    /// `run` 또는 보조 작업의 이름. 비었으면 `None`
    pub kind: Option<String>,
    pub run_id: Option<String>,
    pub phase: Option<Phase>,
    pub terminal: bool,
    pub exporting: bool,
}

fn fail(message: &str) -> Fail {
    Fail { status: 409, message: message.to_owned() }
}

const TERMINAL_EXPORTING: &str = "[b-studio] 원격 저장소에 올리는 중입니다. 끝난 뒤 다시 보내세요.";
const TERMINAL_BUSY: &str = "[b-studio] 앞선 요청을 처리하는 중입니다(대화 창에서 보낸 요청이거나 검증 결과를 저장하는 중). 끝난 뒤 다시 보내세요.";
const TERMINAL_STOPPED: &str = "[b-studio] 중지하는 중이거나 중지된 세션이라 요청을 받지 않습니다.";
const DELETE_BUSY: &str = "실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요";

impl SessionState {
    /// 요청(대화 창)을 받을 수 있는가. 옛 `sendMessage`의 앞 세 검사와 같은 순서: 상태 → 바쁨 → 올리는 중. 그 뒤에 멈추는 중(새 검사)
    pub fn check_run(&self) -> Result<(), Fail> {
        run_check(&self.lock())
    }

    /// 요청 하나를 연다. `check_run`을 다시 하고 통과하면 `slot`을 잡아 표를 돌려준다
    pub fn begin_run(&self, run_id: &str) -> Result<Ticket, Fail> {
        let mut inner = self.lock();
        run_check(&inner)?;
        let ticket = inner.claims.issue();
        inner.claims.slot = Some(Slot { ticket, holder: Holder::Run { run_id: run_id.to_owned(), phase: Phase::Running, terminal: false } });
        Ok(ticket)
    }

    /// 터미널의 실행을 받을 수 없으면 그 이유(글)를 돌려준다. 순서는 옛 `terminalBusy`와 같다: 올리는 중 → 바쁨. 그 뒤에 멈추는 중·멈춘 세션(새 검사)
    pub fn terminal_busy(&self) -> Option<String> {
        terminal_check(&self.lock()).err()
    }

    /// 터미널의 실행 하나를 연다. 받을 수 없으면 그 이유(글)를 돌려준다
    pub fn begin_terminal_run(&self, run_id: &str) -> Result<Ticket, String> {
        let mut inner = self.lock();
        terminal_check(&inner)?;
        let ticket = inner.claims.issue();
        inner.claims.slot = Some(Slot { ticket, holder: Holder::Run { run_id: run_id.to_owned(), phase: Phase::Running, terminal: true } });
        inner.claims.terminal.begin(ticket);
        Ok(ticket)
    }

    /// 실행의 단계를 바꾼다. 허용하는 전이: 진행 → 취소 중, 진행 → 저장 중, 취소 중 → 저장 중, 저장 중 → 진행(터미널 실행을 다시 여는 길).
    /// 표가 지금 점유의 표가 아니거나 실행이 아니거나 허용하지 않는 전이면 바꾸지 않고 `false`다
    pub fn set_phase(&self, ticket: Ticket, to: Phase) -> bool {
        let mut inner = self.lock();
        let Some(Slot { ticket: held, holder: Holder::Run { phase, .. } }) = inner.claims.slot.as_mut() else { return false };
        if *held != ticket {
            return false;
        }
        let allowed = matches!((*phase, to), (Phase::Running, Phase::Cancelling) | (Phase::Running, Phase::Saving) | (Phase::Cancelling, Phase::Saving) | (Phase::Saving, Phase::Running));
        if allowed {
            *phase = to;
        }
        allowed
    }

    /// 사용자의 취소 요청. 옛 `cancelRun`의 순서: 실행 없음·다른 `run_id`·저장 중 → 409, 이미 취소 중이면 조용히 돌아온다
    pub fn cancel_run(&self, run_id: &str) -> Result<CancelOutcome, Fail> {
        let mut inner = self.lock();
        let Some(Slot { holder: Holder::Run { run_id: held, phase, .. }, .. }) = inner.claims.slot.as_mut() else { return Err(no_run_to_cancel()) };
        if held != run_id || *phase == Phase::Saving {
            return Err(no_run_to_cancel());
        }
        if *phase == Phase::Cancelling {
            return Ok(CancelOutcome::AlreadyCancelling);
        }
        *phase = Phase::Cancelling;
        Ok(CancelOutcome::Started)
    }

    /// 진행 중 지시를 받을 실행의 id. 열린 실행(진행·취소 중)이 없으면 옛 글의 409
    pub fn steer_target(&self) -> Result<String, Fail> {
        match &self.lock().claims.slot {
            Some(Slot { holder: Holder::Run { run_id, phase, .. }, .. }) if *phase != Phase::Saving => Ok(run_id.clone()),
            _ => Err(fail("실행 중이 아닙니다. 새 요청으로 보내세요")),
        }
    }

    /// 지금 열린 실행(진행·취소 중)의 id. 터미널의 `openTerminalRun`이 세션의 실행과 맞는지 볼 때 쓴다
    pub fn open_run(&self) -> Option<String> {
        self.steer_target().ok()
    }

    /// 보조 작업을 시작할 수 있는가(`CatchUpBase`는 `begin_catch_up`을 쓴다). 순서: 상태 → 바쁨·올리는 중 → 멈추는 중(새 검사)
    pub fn check_task(&self, kind: TaskKind) -> Result<(), Fail> {
        task_check(&self.lock(), kind)
    }

    /// 보조 작업 하나를 연다. `check_task`를 다시 하고 통과하면 `slot`을 잡아 표를 돌려준다
    pub fn begin_task(&self, kind: TaskKind) -> Result<Ticket, Fail> {
        let mut inner = self.lock();
        task_check(&inner, kind)?;
        let ticket = inner.claims.issue();
        inner.claims.slot = Some(Slot { ticket, holder: Holder::Task(kind) });
        Ok(ticket)
    }

    /// 기준 브랜치 따라잡기. 옛 `autoCatchUpBase`는 `running`이면 건너뛰었다(올리는 중은 보지 않았다). 멈추는 중·멈춘 세션도 건너뛴다.
    /// 건너뛰면 `None`이다(오류가 아니다)
    pub fn begin_catch_up(&self) -> Option<Ticket> {
        let mut inner = self.lock();
        if inner.claims.busy() || inner.stopping || inner.status == SessionStatus::Stopped {
            return None;
        }
        let ticket = inner.claims.issue();
        inner.claims.slot = Some(Slot { ticket, holder: Holder::Task(TaskKind::CatchUpBase) });
        Some(ticket)
    }

    /// 표로 `slot`을 푼다. 표가 지금 점유의 표일 때만 풀고 `true`다. 아니면(이미 풀렸거나 다른 점유의 표) 아무것도 하지 않는다
    pub fn release(&self, ticket: Ticket) -> bool {
        let mut inner = self.lock();
        if inner.claims.slot.as_ref().is_some_and(|slot| slot.ticket == ticket) {
            inner.claims.slot = None;
            return true;
        }
        false
    }

    /// 이 표가 지금 `slot`의 점유인가. 기다리는 사이(`await`)에 멈추기가 점유를 비웠는지 볼 때 쓴다
    pub fn holds(&self, ticket: Ticket) -> bool {
        self.lock().claims.slot.as_ref().is_some_and(|slot| slot.ticket == ticket)
    }

    /// 바쁜가(옛 `snapshot.running`). `snapshot.running`은 이 값의 거울이다
    pub fn busy(&self) -> bool {
        self.lock().claims.busy()
    }

    /// `running`을 보고 거절하던 곳의 판정. 바쁘면 옛 글의 409
    pub fn reject_busy(&self, op: BusyOp) -> Result<(), Fail> {
        if self.lock().claims.busy() {
            return Err(fail(op.message()));
        }
        Ok(())
    }

    /// 원격 올리기를 연다. 옛 `exportSession`의 순서: 바쁨 → 이미 올리는 중. 통과하면 표를 돌려준다
    pub fn begin_export(&self) -> Result<Ticket, Fail> {
        let mut inner = self.lock();
        if inner.claims.busy() {
            return Err(fail("작업이 끝난 뒤에 올릴 수 있습니다"));
        }
        if inner.claims.export.is_some() {
            return Err(fail("이미 올리는 중입니다"));
        }
        let ticket = inner.claims.issue();
        inner.claims.export = Some(ticket);
        Ok(ticket)
    }

    pub fn release_export(&self, ticket: Ticket) -> bool {
        let mut inner = self.lock();
        if inner.claims.export == Some(ticket) {
            inner.claims.export = None;
            return true;
        }
        false
    }

    pub fn exporting(&self) -> bool {
        self.lock().claims.export.is_some()
    }

    /// 지우기 전의 점유 판정. 실행·보조 작업·터미널 실행·올리기 중이면 상태가 `idle`이어도 거절한다(옛 글). 상태 판정은 `delete_check`가 한다
    pub fn delete_busy(&self) -> Result<(), Fail> {
        let inner = self.lock();
        if inner.claims.busy() || inner.claims.export.is_some() {
            return Err(fail(DELETE_BUSY));
        }
        Ok(())
    }

    pub fn claim_view(&self) -> ClaimView {
        let inner = self.lock();
        let (kind, run_id, phase, terminal) = match &inner.claims.slot {
            None => (None, None, None, false),
            Some(Slot { holder: Holder::Run { run_id, phase, terminal }, .. }) => (Some("run".to_owned()), Some(run_id.clone()), Some(*phase), *terminal),
            Some(Slot { holder: Holder::Task(kind), .. }) => (Some(kind.as_str().to_owned()), None, None, false),
        };
        ClaimView { kind, run_id, phase, terminal, exporting: inner.claims.export.is_some() }
    }
}

fn no_run_to_cancel() -> Fail {
    fail("취소할 수 있는 요청이 없습니다. 이미 끝났거나 결과를 저장하는 중입니다")
}

fn run_check(inner: &crate::status::Inner) -> Result<(), Fail> {
    if inner.status != SessionStatus::Ready && inner.status != SessionStatus::Idle {
        return Err(fail("샌드박스가 준비된 뒤에 요청할 수 있습니다"));
    }
    if inner.claims.busy() {
        return Err(fail("이전 요청을 처리하는 중입니다"));
    }
    if inner.claims.export.is_some() {
        return Err(fail("원격 저장소에 올리는 중입니다"));
    }
    if inner.stopping {
        return Err(fail(STOPPING_MESSAGE));
    }
    Ok(())
}

fn task_check(inner: &crate::status::Inner, kind: TaskKind) -> Result<(), Fail> {
    if kind == TaskKind::CatchUpBase {
        // 따라잡기는 `begin_catch_up`이 건너뛰기로 다룬다. 오류로 거절하는 길은 없다
        return Err(fail(kind.busy()));
    }
    if inner.status != SessionStatus::Ready {
        return Err(fail(kind.not_ready()));
    }
    if inner.claims.busy() || inner.claims.export.is_some() {
        return Err(fail(kind.busy()));
    }
    if inner.stopping {
        return Err(fail(STOPPING_MESSAGE));
    }
    Ok(())
}

fn terminal_check(inner: &crate::status::Inner) -> Result<(), String> {
    if inner.claims.export.is_some() {
        return Err(TERMINAL_EXPORTING.to_owned());
    }
    if inner.claims.busy() {
        return Err(TERMINAL_BUSY.to_owned());
    }
    if inner.stopping || inner.status == SessionStatus::Stopped {
        return Err(TERMINAL_STOPPED.to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
