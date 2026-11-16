use super::*;
use crate::status::{BeginStop, BootOutcome, BootRequest, SessionStatus};
use std::sync::{Arc, Mutex};

fn ready() -> SessionState {
    let state = SessionState::new(SessionStatus::Idle).unwrap();
    let BootRequest::Start { generation, .. } = state.request_boot() else { panic!("켜기를 시작해야 합니다") };
    state.boot_finished(generation, BootOutcome::Ready);
    state
}

fn facts(status: EndStatus) -> CloseFacts {
    CloseFacts { status, stopping: false, platform_failure: false, local: false, ready: true, booted: true, has_reason: true }
}

#[test]
fn step_names_and_order_are_fixed() {
    assert_eq!(CLOSE_STEPS, ["revert_run", "revert_host_only", "notice_platform", "build_summary", "detach_run", "announce_run"]);
}

#[test]
fn close_table() {
    use Action::*;
    use CloseText as T;
    use FinishedStatus as F;
    let ok = facts(EndStatus::Failed);
    let cases: Vec<(CloseFacts, Action, FinishedStatus, CloseText)> = vec![
        // 켠 ready 세션은 되돌린다. 사유가 있으면 그 글에 결과를 붙이고, 사유 없는 취소는 취소 글에 결과를 쓴다
        (ok, Revert, F::Failed, T::Reverted),
        (facts(EndStatus::Error), Revert, F::Error, T::Reverted),
        (facts(EndStatus::Cancelled), Revert, F::Cancelled, T::Reverted),
        (CloseFacts { has_reason: false, ..facts(EndStatus::Cancelled) }, Revert, F::Cancelled, T::CancelledReport),
        // 사유가 없어도 취소가 아니면 결과 글이다
        (CloseFacts { has_reason: false, ..ok }, Revert, F::Failed, T::Reverted),
        // 멈추는 중이면 되돌리지 않고 취소로 끝낸다. 다른 사실은 보지 않는다
        (CloseFacts { stopping: true, ..ok }, None, F::Cancelled, T::Stopped),
        (CloseFacts { stopping: true, platform_failure: true, ready: false, booted: false, ..ok }, None, F::Cancelled, T::Stopped),
        // 샌드박스 쪽 실패는 되돌리지 않고 알린다. 상태보다 먼저 본다(켜지 못한 세션이어도 이 칸이다)
        (CloseFacts { platform_failure: true, ..ok }, NoticePlatform, F::Failed, T::PlatformKept),
        (CloseFacts { platform_failure: true, ready: false, booted: true, ..ok }, NoticePlatform, F::Failed, T::PlatformKept),
        (CloseFacts { platform_failure: true, ready: false, booted: false, ..ok }, NoticePlatform, F::Failed, T::PlatformKept),
        // 내 폴더 세션은 샌드박스 쪽 실패도 되돌린다(다음 요청이 직접 수정으로 커밋한다)
        (CloseFacts { platform_failure: true, local: true, ..ok }, Revert, F::Failed, T::Reverted),
        (CloseFacts { platform_failure: true, local: true, ready: false, booted: true, ..ok }, NoticeKept, F::Failed, T::Kept),
        // 켜는 중이거나 켜지 못한 세션은 되돌리지 않는다
        (CloseFacts { ready: false, ..ok }, NoticeKept, F::Failed, T::Kept),
        (CloseFacts { ready: false, ..facts(EndStatus::Cancelled) }, NoticeKept, F::Cancelled, T::Kept),
        // 켠 적 없는 세션은 작업 복사본만 되돌린다(상태가 idle이어도 ready로 읽혀도)
        (CloseFacts { ready: false, booted: false, ..ok }, RevertHostOnly, F::Failed, T::Reverted),
        (CloseFacts { booted: false, ..ok }, RevertHostOnly, F::Failed, T::Reverted),
        (CloseFacts { booted: false, has_reason: false, ..facts(EndStatus::Cancelled) }, RevertHostOnly, F::Cancelled, T::CancelledReport),
    ];
    for (input, action, status, text) in cases {
        let got = decide_close(&input);
        assert_eq!((got.action, got.status, got.text), (action, status, text), "{input:?}");
    }
}

#[test]
fn close_decision_is_total_and_never_saves() {
    for status in [EndStatus::Failed, EndStatus::Cancelled, EndStatus::Error] {
        for bits in 0..64u32 {
            let input = CloseFacts { status, stopping: bits & 1 != 0, platform_failure: bits & 2 != 0, local: bits & 4 != 0, ready: bits & 8 != 0, booted: bits & 16 != 0, has_reason: bits & 32 != 0 };
            let got = decide_close(&input);
            assert_ne!(got.action, Action::Save, "{input:?}");
            // 멈추는 중이 아니면 끝 상태는 부른 쪽이 정한 그대로다
            if !input.stopping {
                assert_eq!(got.status, FinishedStatus::from(input.status), "{input:?}");
            }
            // 되돌리는 칸은 멈추는 중이 아니고, 켜는 중·켜지 못한 세션이 아니며, 샌드박스 쪽 실패(내 폴더가 아닌)가 아니다
            if matches!(got.action, Action::Revert | Action::RevertHostOnly) {
                assert!(!input.stopping && !(input.platform_failure && !input.local) && (input.ready || !input.booted), "{input:?}");
                assert_eq!(got.action == Action::RevertHostOnly, !input.booted, "{input:?}");
            }
        }
    }
}

#[test]
fn cli_ended_table() {
    let none = CliEndedFacts { open: false, checking: false, has_feedback: false };
    assert_eq!(on_cli_ended(&none), CliEnded::Nothing);
    assert_eq!(on_cli_ended(&CliEndedFacts { checking: true, has_feedback: true, ..none }), CliEnded::Nothing);
    let open = CliEndedFacts { open: true, ..none };
    assert_eq!(on_cli_ended(&open), CliEnded::Close(EndStatus::Cancelled));
    assert_eq!(on_cli_ended(&CliEndedFacts { has_feedback: true, ..open }), CliEnded::Close(EndStatus::Failed));
    // 검사 중이면 미룬다. 피드백이 있었어도 같다
    assert_eq!(on_cli_ended(&CliEndedFacts { checking: true, ..open }), CliEnded::Defer);
    assert_eq!(on_cli_ended(&CliEndedFacts { checking: true, has_feedback: true, ..open }), CliEnded::Defer);
}

#[test]
fn violation_route_table() {
    assert_eq!(route_violation(&ViolationFacts { alive: false, open: true }), ViolationRoute::Ignore);
    assert_eq!(route_violation(&ViolationFacts { alive: false, open: false }), ViolationRoute::Ignore);
    assert_eq!(route_violation(&ViolationFacts { alive: true, open: true }), ViolationRoute::CloseOpenRun);
    assert_eq!(route_violation(&ViolationFacts { alive: true, open: false }), ViolationRoute::Defer);
}

#[test]
fn retry_goes_to_feedback_unless_the_cli_already_ended() {
    assert_eq!(on_retry(false), Retry::Feedback);
    assert_eq!(on_retry(true), Retry::CloseFailed);
}

#[test]
fn a_run_is_open_only_while_running_and_not_closing() {
    let state = ready();
    // 대화 창의 요청은 터미널의 열린 실행이 아니다
    let chat = state.begin_run("c").unwrap();
    assert!(!state.terminal_run_open(chat));
    state.release(chat);

    let ticket = state.begin_terminal_run("t").unwrap();
    assert!(state.terminal_run_open(ticket));
    assert!(!state.terminal_run_open(ticket + 1));
    assert!(!state.terminal_run_open(0));
    // 취소 중이거나 저장 중이면 열린 실행이 아니다(옛 `cancel.aborted`와 떼어 낸 `session.run`)
    assert!(state.set_phase(ticket, Phase::Cancelling));
    assert!(!state.terminal_run_open(ticket));
    assert!(state.set_phase(ticket, Phase::Saving));
    assert!(!state.terminal_run_open(ticket));
    // 저장 중이던 실행을 다시 연다
    assert!(state.set_phase(ticket, Phase::Running));
    assert!(state.terminal_run_open(ticket));
    // 점유가 풀리면 열린 실행이 아니다
    assert!(state.release(ticket));
    assert!(!state.terminal_run_open(ticket));
}

#[test]
fn closing_closes_once_and_the_run_stops_being_open_at_once() {
    let state = ready();
    let ticket = state.begin_terminal_run("t").unwrap();
    assert!(!state.terminal_run_closed(ticket));
    let first = state.begin_terminal_close(ticket, CloseKind::Abandon(facts(EndStatus::Failed)));
    assert_eq!(first.map(|d| d.action), Some(Action::Revert));
    // 닫기를 시작한 순간부터 열린 실행이 아니다. 점유는 아직 이 실행이 쥐고 있다(되돌리는 동안 다른 요청이 끼어들지 못한다)
    assert!(!state.terminal_run_open(ticket));
    assert!(state.terminal_run_closed(ticket));
    assert!(state.busy());
    // 두 번째 닫기는 아무것도 하지 않는다. 종류가 달라도 같다
    assert_eq!(state.begin_terminal_close(ticket, CloseKind::Abandon(facts(EndStatus::Cancelled))), None);
    assert_eq!(state.begin_terminal_close(ticket, CloseKind::Settle(FinishedStatus::Done)), None);
}

#[test]
fn unknown_and_older_runs_count_as_closed() {
    let state = ready();
    let first = state.begin_terminal_run("t1").unwrap();
    assert!(state.release(first));
    let second = state.begin_terminal_run("t2").unwrap();
    // 앞 실행의 늦은 닫기는 새 실행에 영향을 주지 않는다
    assert!(state.terminal_run_closed(first));
    assert_eq!(state.begin_terminal_close(first, CloseKind::Settle(FinishedStatus::Done)), None);
    assert!(state.terminal_run_open(second));
    assert_eq!(state.begin_terminal_close(0, CloseKind::Settle(FinishedStatus::Done)), None);
    assert!(state.terminal_run_open(second));
}

#[test]
fn a_detached_run_can_still_be_closed_even_after_the_slot_was_cleared_by_stop() {
    // 저장 중이던 실행: 열린 실행은 아니지만 닫을 수 있다. 멈추기가 점유를 비운 뒤에도 한 번만 닫는다
    let state = ready();
    let ticket = state.begin_terminal_run("t").unwrap();
    assert!(state.set_phase(ticket, Phase::Saving));
    assert!(!state.terminal_run_open(ticket));
    assert_eq!(state.begin_stop(), BeginStop::Started);
    state.lock().claims.clear_slot();
    assert!(!state.busy());
    assert!(state.begin_terminal_close(ticket, CloseKind::Settle(FinishedStatus::Cancelled)).is_some());
    assert_eq!(state.begin_terminal_close(ticket, CloseKind::Settle(FinishedStatus::Cancelled)), None);
}

type Trace = Arc<Mutex<Vec<String>>>;

async fn close(state: &SessionState, ticket: Ticket, trace: &Trace) {
    let recorder = trace.clone();
    state
        .run_terminal_close(ticket, |name, arg| {
            let phase = state.claim_view().phase.map(Phase::as_str).unwrap_or("-");
            recorder.lock().unwrap().push(format!("{name}({arg})[{phase},busy={}]", state.busy()));
            async {}
        })
        .await;
}

fn trace_of(trace: &Trace) -> Vec<String> {
    trace.lock().unwrap().clone()
}

#[tokio::test]
async fn closing_runs_the_action_then_text_then_detach_then_releases_then_announces() {
    let state = ready();
    let trace: Trace = Arc::new(Mutex::new(Vec::new()));

    // 되돌림: 되돌리는 동안 점유는 그대로이고, 끝 알림 때는 풀려 있다
    let ticket = state.begin_terminal_run("t").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Abandon(facts(EndStatus::Cancelled))).unwrap();
    close(&state, ticket, &trace).await;
    assert_eq!(
        trace_of(&trace),
        ["revert_run(cancelled)[running,busy=true]", "build_summary(reverted)[running,busy=true]", "detach_run()[running,busy=true]", "announce_run(cancelled)[-,busy=false]"]
    );
    assert!(!state.busy());

    // 켠 적 없는 세션
    trace.lock().unwrap().clear();
    let ticket = state.begin_terminal_run("t2").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Abandon(CloseFacts { booted: false, ..facts(EndStatus::Failed) })).unwrap();
    close(&state, ticket, &trace).await;
    assert_eq!(trace_of(&trace)[0], "revert_host_only()[running,busy=true]");

    // 샌드박스 쪽 실패는 알림 뒤 글
    trace.lock().unwrap().clear();
    let ticket = state.begin_terminal_run("t3").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Abandon(CloseFacts { platform_failure: true, ..facts(EndStatus::Error) })).unwrap();
    close(&state, ticket, &trace).await;
    assert_eq!(
        trace_of(&trace),
        ["notice_platform()[running,busy=true]", "build_summary(platform_kept)[running,busy=true]", "detach_run()[running,busy=true]", "announce_run(error)[-,busy=false]"]
    );

    // 켜는 중이라 남김: 알림 단계가 없고 글만 있다
    trace.lock().unwrap().clear();
    let ticket = state.begin_terminal_run("t4").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Abandon(CloseFacts { ready: false, ..facts(EndStatus::Failed) })).unwrap();
    close(&state, ticket, &trace).await;
    assert_eq!(trace_of(&trace), ["build_summary(kept)[running,busy=true]", "detach_run()[running,busy=true]", "announce_run(failed)[-,busy=false]"]);

    // 멈추는 중
    trace.lock().unwrap().clear();
    let ticket = state.begin_terminal_run("t5").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Abandon(CloseFacts { stopping: true, ..facts(EndStatus::Failed) })).unwrap();
    close(&state, ticket, &trace).await;
    assert_eq!(trace_of(&trace), ["build_summary(stopped)[running,busy=true]", "detach_run()[running,busy=true]", "announce_run(cancelled)[-,busy=false]"]);

    // 통과: 글 조립 단계가 없다
    trace.lock().unwrap().clear();
    let ticket = state.begin_terminal_run("t6").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Settle(FinishedStatus::Done)).unwrap();
    close(&state, ticket, &trace).await;
    assert_eq!(trace_of(&trace), ["detach_run()[running,busy=true]", "announce_run(done)[-,busy=false]"]);
    assert!(!state.busy());
}

#[tokio::test]
async fn closing_without_a_plan_does_nothing() {
    let state = ready();
    let ticket = state.begin_terminal_run("t").unwrap();
    let trace: Trace = Arc::new(Mutex::new(Vec::new()));
    // 닫기를 시작하지 않았다
    close(&state, ticket, &trace).await;
    assert!(trace_of(&trace).is_empty());
    assert!(state.busy());
    // 계획은 한 번만 가져간다
    state.begin_terminal_close(ticket, CloseKind::Settle(FinishedStatus::Done)).unwrap();
    close(&state, ticket, &trace).await;
    let steps = trace_of(&trace).len();
    close(&state, ticket, &trace).await;
    assert_eq!(trace_of(&trace).len(), steps);
}

#[tokio::test]
async fn the_claim_is_released_even_if_the_close_is_dropped_midway() {
    // 되돌리는 도중 이 호출이 버려진다(끝나지 않는 콜백을 기다리다 시간이 다 됐다)
    let state = ready();
    let ticket = state.begin_terminal_run("t").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Abandon(facts(EndStatus::Failed))).unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_millis(30), state.run_terminal_close(ticket, |_, _| std::future::pending::<()>())).await;
    assert!(outcome.is_err());
    assert!(!state.busy());
    // 다음 요청을 받는다
    assert!(state.begin_terminal_run("t2").is_ok());
}

#[tokio::test]
async fn the_claim_is_released_even_if_a_step_panics() {
    let state = Arc::new(ready());
    let ticket = state.begin_terminal_run("t").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Abandon(facts(EndStatus::Failed))).unwrap();
    let task = {
        let state = state.clone();
        tokio::spawn(async move {
            state
                .run_terminal_close(ticket, |name, _| async move {
                    if name == BUILD_SUMMARY {
                        panic!("끝 글을 만들다 던졌습니다");
                    }
                })
                .await;
        })
    };
    assert!(task.await.unwrap_err().is_panic());
    assert!(!state.busy());
    assert!(state.begin_terminal_run("t2").is_ok());
}

#[tokio::test]
async fn a_stale_release_never_frees_a_newer_claim() {
    // 닫기가 풀기 전에 멈추기가 점유를 비웠고 새 점유가 잡혔다. 이 닫기의 풀기는 새 점유를 풀지 못한다
    let state = ready();
    let ticket = state.begin_terminal_run("t").unwrap();
    state.begin_terminal_close(ticket, CloseKind::Abandon(facts(EndStatus::Failed))).unwrap();
    state.lock().claims.clear_slot();
    let task = state.begin_task(crate::claim::TaskKind::Reverify);
    // 멈추기가 비웠지만 이 시험은 상태를 바꾸지 않았으므로 새 점유가 잡힌다
    let newer = task.unwrap();
    let trace: Trace = Arc::new(Mutex::new(Vec::new()));
    close(&state, ticket, &trace).await;
    assert!(state.holds(newer));
    assert!(state.busy());
}

#[test]
fn cli_ended_marks_the_deferred_close_only_on_an_open_run() {
    let state = ready();
    let ticket = state.begin_terminal_run("t").unwrap();
    assert_eq!(state.terminal_retry(ticket), Retry::Feedback);
    // 열린 실행이 없는 표(0)는 아무것도 하지 않는다
    assert_eq!(state.terminal_cli_ended(0, true, true), CliEnded::Nothing);
    assert_eq!(state.terminal_retry(ticket), Retry::Feedback);
    // 검사 중이 아니면 바로 닫는다. 미룬다는 표시를 남기지 않는다
    assert_eq!(state.terminal_cli_ended(ticket, false, false), CliEnded::Close(EndStatus::Cancelled));
    assert_eq!(state.terminal_cli_ended(ticket, false, true), CliEnded::Close(EndStatus::Failed));
    assert_eq!(state.terminal_retry(ticket), Retry::Feedback);
    // 검사 중이면 미루고 표시를 남긴다. 검사가 재시도로 끝나면 닫는다
    assert_eq!(state.terminal_cli_ended(ticket, true, true), CliEnded::Defer);
    assert_eq!(state.terminal_retry(ticket), Retry::CloseFailed);
    // 닫힌 실행에는 더 하지 않는다
    state.begin_terminal_close(ticket, CloseKind::Settle(FinishedStatus::Done)).unwrap();
    assert_eq!(state.terminal_cli_ended(ticket, true, true), CliEnded::Nothing);
}

#[test]
fn violation_routing_follows_the_open_run() {
    let state = ready();
    let ticket = state.begin_terminal_run("t").unwrap();
    assert_eq!(state.terminal_violation_route(ticket, true), ViolationRoute::CloseOpenRun);
    assert_eq!(state.terminal_violation_route(ticket, false), ViolationRoute::Ignore);
    assert_eq!(state.terminal_violation_route(0, true), ViolationRoute::Defer);
    // 닫는 중인 실행에 온 위반은 닫는 중인 실행에 붙이지 않고 그 뒤 처음 끝나는 실행의 것으로 담아 둔다
    state.begin_terminal_close(ticket, CloseKind::Abandon(facts(EndStatus::Failed))).unwrap();
    assert_eq!(state.terminal_violation_route(ticket, true), ViolationRoute::Defer);
}
