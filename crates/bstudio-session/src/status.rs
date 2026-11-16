//! 세션 하나의 상태 전이와 멈추기의 순서(ADR-205, 4f B2b). 옛 구현은 `sessions.ts`의 `setStatus`·`ensureBooted`·`startBoot`·`boot`·`stopSession`이었다
//! (`session-status-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다. 샌드박스·터미널·관문·감시·저장 같은 부수 효과는 TS가 쥐고, 여기는 **언제 무엇을 해도 되는가**만 정한다.
//!
//! 상태 다섯 가지(`idle`·`starting`·`ready`·`failed`·`stopped`)는 이 값만 쥔다. TS의 `snapshot.status`는 이 값의 거울이다(바뀔 때마다 이 모듈이 돌려주는 `Change`를 TS가 옮긴다).
//!
//! 켜기에는 **세대 번호**가 있다. 켜기를 시작할 때(`request_boot`의 "시작") 올리고, 멈추기를 시작할 때(`begin_stop`)도 올린다. 켜기가 끝났다고 알릴 때(`boot_finished`)
//! 자기 세대를 함께 알리고, 지금 세대가 아니거나 멈추는 중이면 **늦은 결과**라 상태를 바꾸지 않는다. 옛 코드는 켜기가 `ready`를 내기 직전에 멈추기가 시작됐어도 `ready`를 내고
//! 로그·사용량·파일 감시를 다시 켰다(트러블슈팅 213).
//!
//! 멈추기의 순서(`STOP_STEPS`)도 여기서 정한다. 단계마다 TS 콜백을 하나씩 차례로 부르고, 실패를 삼키던 단계(`Failure::Swallow`)는 삼키고 던지던 단계(`Failure::Throw`)는 거기서 멈춘다.
//! 던져서 멈춘 뒤에는 "멈추는 중"을 풀어 다시 멈출 수 있게 한다(상태는 옛 코드처럼 그대로 남고, 켜기 세대는 이미 올라가 있어 늦은 결과는 계속 무시된다).

use std::future::Future;
use std::sync::{Mutex, MutexGuard, PoisonError};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionStatus {
    Idle,
    Starting,
    Ready,
    Failed,
    Stopped,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "idle" => Self::Idle,
            "starting" => Self::Starting,
            "ready" => Self::Ready,
            "failed" => Self::Failed,
            "stopped" => Self::Stopped,
            _ => return None,
        })
    }
}

/// 상태가 바뀌었다는 알림. TS가 `snapshot.status`·`error`를 고치고 `status` 이벤트를 낸다
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub status: SessionStatus,
    pub error: Option<String>,
}

/// `request_boot`의 결과(옛 `ensureBooted`의 분기)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BootRequest {
    /// 이미 켜져 있다
    Ready,
    /// 중지된 세션이다(409). 멈추는 중이어도 같다: 곧 중지되므로 새로 켜지 않는다
    Stopped,
    /// 이미 켜는 중이고 실패하지 않았다. 그 켜기가 끝나기를 기다린다
    Wait,
    /// 켜기를 시작한다. `change`는 `starting`이 아니었다가 `starting`으로 바뀐 것이다
    Start { generation: u64, change: Option<Change> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BootOutcome {
    Ready,
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BeginStop {
    /// 이미 멈췄다(할 일이 없다)
    AlreadyStopped,
    /// 다른 호출이 멈추는 중이다. `join_stop`으로 그 끝을 기다린다
    Joined,
    /// 이 호출이 멈춘다. `run_stop`을 부른다
    Started,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// 실패해도 다음 단계로 간다(옛 `.catch(() => {})`)
    Swallow,
    /// 실패하면 거기서 멈추고 오류를 돌려준다(옛 코드는 던졌다)
    Throw,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
    pub name: &'static str,
    pub failure: Failure,
}

/// 이 단계 **앞에서** 상태를 `stopped`로 바꾼다. 단계는 TS가 `snapshot.status`와 `status` 이벤트를 옮기는 일이다
pub const APPLY_STATUS: &str = "apply_status";

/// 옛 `stopSession`의 부수 효과 순서. (첫 줄의 `session.stop.abort()`는 단계가 아니다: 멈추기를 시작한 호출이 바로 올린다. 호출이 돌아오기 전에 신호가 올라가 있어야 해서다)
pub const STOP_STEPS: [Step; 14] = [
    Step { name: "clear_violation", failure: Failure::Throw },
    Step { name: "clear_terminal_attention", failure: Failure::Throw },
    Step { name: "settle_terminal_run", failure: Failure::Throw },
    Step { name: "abort_log_follower", failure: Failure::Throw },
    Step { name: "clear_usage_timer", failure: Failure::Throw },
    Step { name: "stop_stall_watch", failure: Failure::Throw },
    Step { name: "close_file_watcher", failure: Failure::Throw },
    Step { name: "dispose_terminal", failure: Failure::Throw },
    Step { name: "close_gateway", failure: Failure::Swallow },
    Step { name: "destroy_sandbox", failure: Failure::Swallow },
    Step { name: "close_preview_proxies", failure: Failure::Swallow },
    Step { name: "mark_services_stopped", failure: Failure::Throw },
    Step { name: APPLY_STATUS, failure: Failure::Throw },
    Step { name: "clear_sandbox_link", failure: Failure::Throw },
];

/// 마지막 단계(상태를 바꾼 뒤 저장을 기다린다). 던지면 던진다
pub const FLUSH_STEP: Step = Step { name: "flush_persist", failure: Failure::Throw };

/// 멈추기가 던져서 끝났다
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StopFailure {
    pub step: String,
    pub message: String,
}

pub type StopOutcome = Result<(), StopFailure>;

pub(crate) struct Inner {
    pub(crate) status: SessionStatus,
    error: Option<String>,
    pub(crate) stopping: bool,
    generation: u64,
    /// 켜기를 한 번이라도 시작했다(옛 `bootPromise`가 있다)
    booted: bool,
    /// 세션이 바쁜 이유와 그 표(ADR-207). 상태·멈추는 중과 한 자물쇠 아래에 있어 "확인하고 잡기"가 한 번에 된다
    pub(crate) claims: crate::claim::Claims,
}

pub struct SessionState {
    inner: Mutex<Inner>,
    done: watch::Sender<Option<StopOutcome>>,
}

impl SessionState {
    /// `initial`은 `idle`(지연 기동) 또는 `starting`이다. `starting`이면 켜기가 아직 없다: 만든 쪽이 바로 `request_boot`를 불러 켜기를 시작한다
    pub fn new(initial: SessionStatus) -> Option<Self> {
        if !matches!(initial, SessionStatus::Idle | SessionStatus::Starting) {
            return None;
        }
        let (done, _) = watch::channel(None);
        Some(Self { inner: Mutex::new(Inner { status: initial, error: None, stopping: false, generation: 0, booted: false, claims: crate::claim::Claims::default() }), done })
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn status(&self) -> SessionStatus {
        self.lock().status
    }

    pub fn error(&self) -> Option<String> {
        self.lock().error.clone()
    }

    pub fn current(&self) -> Change {
        let inner = self.lock();
        Change { status: inner.status, error: inner.error.clone() }
    }

    pub fn stopping(&self) -> bool {
        self.lock().stopping
    }

    pub fn generation(&self) -> u64 {
        self.lock().generation
    }

    /// 켜기 `generation`이 지금도 이 세션의 켜기인가(멈추는 중이거나 세대가 지났거나 멈췄으면 거짓)
    pub fn live(&self, generation: u64) -> bool {
        let inner = self.lock();
        !inner.stopping && inner.generation == generation && inner.status != SessionStatus::Stopped
    }

    /// 샌드박스를 켜야 하는가. 옛 `ensureBooted`의 분기: 켜져 있으면 `Ready`, 중지(또는 멈추는 중)면 `Stopped`, 켜기가 없거나 실패한 뒤면 `Start`, 켜는 중이면 `Wait`
    pub fn request_boot(&self) -> BootRequest {
        let mut inner = self.lock();
        if inner.status == SessionStatus::Ready {
            return BootRequest::Ready;
        }
        if inner.status == SessionStatus::Stopped || inner.stopping {
            return BootRequest::Stopped;
        }
        if !inner.booted || inner.status == SessionStatus::Failed {
            inner.booted = true;
            inner.generation += 1;
            let change = (inner.status != SessionStatus::Starting).then(|| {
                inner.status = SessionStatus::Starting;
                inner.error = None;
                Change { status: SessionStatus::Starting, error: None }
            });
            return BootRequest::Start { generation: inner.generation, change };
        }
        BootRequest::Wait
    }

    /// 켜기가 끝났다. 지금 세대의 켜기이고 멈추는 중이 아닐 때만 상태를 바꾼다(`ready`·`failed`). 아니면 늦은 결과라 `None`이다
    pub fn boot_finished(&self, generation: u64, outcome: BootOutcome) -> Option<Change> {
        let mut inner = self.lock();
        if inner.stopping || inner.generation != generation || inner.status == SessionStatus::Stopped {
            return None;
        }
        let (status, error) = match outcome {
            BootOutcome::Ready => (SessionStatus::Ready, None),
            BootOutcome::Failed(message) => (SessionStatus::Failed, Some(message)),
        };
        inner.status = status;
        inner.error = error.clone();
        Some(Change { status, error })
    }

    /// 멈추기를 시작한다. 시작한 호출은 `Started`를 받고 곧바로 `run_stop`을 부른다. 이 순간부터 지금 켜기의 결과는 모두 늦은 결과다
    pub fn begin_stop(&self) -> BeginStop {
        let mut inner = self.lock();
        if inner.status == SessionStatus::Stopped {
            return BeginStop::AlreadyStopped;
        }
        if inner.stopping {
            return BeginStop::Joined;
        }
        inner.stopping = true;
        inner.generation += 1;
        self.done.send_replace(None);
        BeginStop::Started
    }

    fn finish_stop(&self) -> Change {
        let mut inner = self.lock();
        inner.status = SessionStatus::Stopped;
        inner.error = None;
        // 멈춘 세션에는 실행·보조 작업의 점유가 없다. 늦게 끝나는 작업은 자기 표로 풀려 하지만 표가 이미 무효라 아무것도 하지 않는다(ADR-207).
        // 원격 올리기(`exporting`)는 멈추기와 무관해 그대로 둔다(옛 코드도 멈추기가 `exporting`을 건드리지 않았다)
        inner.claims.clear_slot();
        Change { status: SessionStatus::Stopped, error: None }
    }

    fn end_stop(&self, outcome: StopOutcome) {
        self.lock().stopping = false;
        self.done.send_replace(Some(outcome));
    }

    /// `begin_stop`이 `Started`를 돌려준 호출이 부른다. `call(단계 이름)`이 그 단계의 부수 효과를 하고 실패하면 이유를 돌려준다.
    /// 단계는 `STOP_STEPS` 순서이고 `APPLY_STATUS` 앞에서 상태가 `stopped`로 바뀐다. 마지막에 `FLUSH_STEP`을 부른다
    pub async fn run_stop<F, Fut>(&self, mut call: F) -> StopOutcome
    where
        F: FnMut(&'static str) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        let outcome = self.steps(&mut call).await;
        self.end_stop(outcome.clone());
        outcome
    }

    async fn steps<F, Fut>(&self, call: &mut F) -> StopOutcome
    where
        F: FnMut(&'static str) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        for step in STOP_STEPS.iter().chain(std::iter::once(&FLUSH_STEP)) {
            if step.name == APPLY_STATUS {
                self.finish_stop();
            }
            if let Err(message) = call(step.name).await {
                if step.failure == Failure::Throw {
                    return Err(StopFailure { step: step.name.to_owned(), message });
                }
            }
        }
        Ok(())
    }

    /// `begin_stop`이 `Joined`를 돌려준 호출이 부른다. 멈추는 중인 호출이 끝나기를 기다려 그 결과를 돌려준다
    pub async fn join_stop(&self) -> StopOutcome {
        let mut receiver = self.done.subscribe();
        let outcome = match receiver.wait_for(Option::is_some).await {
            Ok(value) => value.clone().unwrap_or(Ok(())),
            Err(_) => Ok(()),
        };
        outcome
    }
}

#[cfg(test)]
mod tests;
