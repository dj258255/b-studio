use super::*;
use crate::claim::Phase;
use crate::status::{BootOutcome, BootRequest, SessionState};
use std::sync::{Arc, Mutex};

fn state(ready: bool) -> SessionState {
    let state = SessionState::new(SessionStatus::Idle).unwrap();
    if ready {
        let BootRequest::Start { generation, .. } = state.request_boot() else { panic!("켜기를 시작해야 합니다") };
        state.boot_finished(generation, BootOutcome::Ready);
    }
    state
}

/// 실행 도중 켜다 실패해 `failed`가 된다
fn fail_boot(state: &SessionState) {
    let BootRequest::Start { generation, .. } = state.request_boot() else { panic!("켜기를 시작해야 합니다") };
    state.boot_finished(generation, BootOutcome::Failed("실패".to_owned()));
    assert_eq!(state.status(), SessionStatus::Failed);
}

fn facts(result: ResultStatus, status: SessionStatus, booted: bool) -> NormalFacts {
    NormalFacts { ask: false, result, question_gate_passed: false, platform_failure: false, booted, status, local: false, stopped: false }
}

#[test]
fn step_names_and_order_are_fixed() {
    assert_eq!(
        RUN_STEPS,
        [
            "prepare_edits",
            "announce_edits",
            "plan_brief",
            "run_plan",
            "detach_run",
            "tally_run",
            "note_question",
            "probe_pending",
            "save_checkpoint",
            "after_save",
            "revert_after_mismatch",
            "revert_run",
            "revert_host_only",
            "notice_platform",
            "notice_kept",
            "build_finished",
            "settle",
            "announce_finished"
        ]
    );
}

#[test]
fn normal_table() {
    use Action::*;
    use ResultStatus::*;
    use SessionStatus::{Failed as SFailed, Idle, Ready, Starting};
    let cases: Vec<(NormalFacts, bool, Action, FinishedStatus, Summary)> = vec![
        // 질문은 아무것도 하지 않는다
        (NormalFacts { ask: true, ..facts(Done, Ready, true) }, false, None, FinishedStatus::Done, Summary::Result),
        // 켠 세션의 done은 저장한다(상태가 ready가 아니어도)
        (facts(Done, Ready, true), false, Save, FinishedStatus::Done, Summary::Result),
        (facts(Done, SFailed, true), false, Save, FinishedStatus::Done, Summary::Result),
        // 되묻고 멈췄고 그 전에 쓴 파일이 게이트를 통과했으면 저장한다. 아니면 그대로 둔다
        (NormalFacts { question_gate_passed: true, ..facts(AwaitingInput, Ready, true) }, false, Save, FinishedStatus::AwaitingInput, Summary::Result),
        (facts(AwaitingInput, Ready, true), false, None, FinishedStatus::AwaitingInput, Summary::Result),
        // failed는 되돌린다. 샌드박스 쪽 실패는 되돌리지 않고 알린다(내 폴더 세션은 되돌린다)
        (facts(Failed, Ready, true), false, Revert, FinishedStatus::Failed, Summary::Result),
        (NormalFacts { platform_failure: true, ..facts(Failed, Ready, true) }, false, NoticePlatform, FinishedStatus::Failed, Summary::Result),
        (NormalFacts { platform_failure: true, local: true, ..facts(Failed, Ready, true) }, false, Revert, FinishedStatus::Failed, Summary::Result),
        // 샌드박스 쪽 실패 표시는 done에는 뜻이 없다
        (NormalFacts { platform_failure: true, ..facts(Done, Ready, true) }, false, Save, FinishedStatus::Done, Summary::Result),
        // 결함 1: 켜지 않은 세션. 바뀐 파일이 없으면 아무것도 하지 않고, 있으면 되돌리고 done이라도 오류로 끝낸다
        (facts(Done, Idle, false), false, None, FinishedStatus::Done, Summary::Result),
        (facts(Done, Idle, false), true, RevertHostOnly, FinishedStatus::Error, Summary::Unverified),
        (facts(Failed, Idle, false), true, RevertHostOnly, FinishedStatus::Failed, Summary::Result),
        (facts(AwaitingInput, Idle, false), true, None, FinishedStatus::AwaitingInput, Summary::Result),
        // 결함 2: 켰지만 ready가 아닌 세션. 되돌리지 않고(ADR-131) 남아 있다고 알린다
        (facts(Failed, SFailed, true), false, None, FinishedStatus::Failed, Summary::Result),
        (facts(Failed, SFailed, true), true, NoticeKept, FinishedStatus::Failed, Summary::Result),
        (facts(Failed, Starting, true), true, NoticeKept, FinishedStatus::Failed, Summary::Result),
        // 결함 3: 멈춘 세션에는 새 체크포인트를 남기지 않는다
        (NormalFacts { stopped: true, ..facts(Done, Ready, true) }, false, None, FinishedStatus::Done, Summary::Result),
        (NormalFacts { stopped: true, question_gate_passed: true, ..facts(AwaitingInput, Ready, true) }, false, None, FinishedStatus::AwaitingInput, Summary::Result),
    ];
    for (input, pending, action, status, summary) in cases {
        let (got_action, got) = decide_normal(&input, pending);
        assert_eq!((got_action, got.status, got.summary), (action, status, summary), "{input:?} pending={pending}");
    }
}

#[test]
fn probe_is_needed_only_where_the_old_code_did_nothing() {
    use ResultStatus::{AwaitingInput, Done, Failed};
    use SessionStatus::{Failed as SFailed, Idle, Ready};
    assert!(needs_probe_normal(&facts(Done, Idle, false)));
    assert!(needs_probe_normal(&facts(Failed, SFailed, true)));
    assert!(!needs_probe_normal(&facts(Done, Ready, true)));
    assert!(!needs_probe_normal(&facts(Failed, Ready, true)));
    assert!(!needs_probe_normal(&facts(AwaitingInput, Idle, false)));
    assert!(!needs_probe_normal(&NormalFacts { ask: true, ..facts(Done, Idle, false) }));
    // 켠 세션의 done은 저장 칸이라 볼 필요가 없다
    assert!(!needs_probe_normal(&facts(Done, SFailed, true)));
}

#[test]
fn exception_table() {
    use Action::*;
    use SessionStatus::{Failed as SFailed, Idle, Ready, Starting};
    let base = ExceptionFacts { ask: false, cancelled: false, stopped: false, booted: true, status: Ready };
    let cases: Vec<(ExceptionFacts, bool, Action, FinishedStatus, Summary)> = vec![
        (base, false, Revert, FinishedStatus::Error, Summary::Error),
        (ExceptionFacts { cancelled: true, ..base }, false, Revert, FinishedStatus::Cancelled, Summary::Cancelled),
        // 취소를 오류로 쓰지 않는다. 질문 취소는 되돌릴 것이 없다
        (ExceptionFacts { ask: true, cancelled: true, ..base }, false, None, FinishedStatus::Cancelled, Summary::CancelledQuestion),
        (ExceptionFacts { ask: true, ..base }, false, None, FinishedStatus::Error, Summary::Error),
        // 멈추는 중에는 되돌리지 않는다
        (ExceptionFacts { stopped: true, ..base }, false, None, FinishedStatus::Error, Summary::Error),
        // 결함 2·4
        (ExceptionFacts { status: SFailed, ..base }, false, None, FinishedStatus::Error, Summary::Error),
        (ExceptionFacts { status: SFailed, ..base }, true, NoticeKept, FinishedStatus::Error, Summary::Error),
        (ExceptionFacts { status: Starting, cancelled: true, ..base }, true, NoticeKept, FinishedStatus::Cancelled, Summary::CancelledKept),
        (ExceptionFacts { status: Idle, booted: false, cancelled: true, ..base }, false, None, FinishedStatus::Cancelled, Summary::Cancelled),
        (ExceptionFacts { status: Idle, booted: false, cancelled: true, ..base }, true, RevertHostOnly, FinishedStatus::Cancelled, Summary::Cancelled),
        (ExceptionFacts { status: Idle, booted: false, ..base }, true, RevertHostOnly, FinishedStatus::Error, Summary::Error),
    ];
    for (input, pending, action, status, summary) in cases {
        let (got_action, got) = decide_exception(&input, pending);
        assert_eq!((got_action, got.status, got.summary), (action, status, summary), "{input:?} pending={pending}");
    }
    assert!(needs_probe_exception(&ExceptionFacts { status: SFailed, ..base }));
    assert!(!needs_probe_exception(&base));
    assert!(!needs_probe_exception(&ExceptionFacts { ask: true, status: SFailed, ..base }));
    assert!(!needs_probe_exception(&ExceptionFacts { stopped: true, status: SFailed, ..base }));
}

type Trace = Arc<Mutex<Vec<String>>>;

/// 콜백 순서를 적는 가짜. `script(이름, 인자)`가 답을 정한다
async fn drive(state: &SessionState, ask: bool, script: impl Fn(&'static str, &'static str) -> Reply) -> Vec<String> {
    drive_with(state, ask, |_| {}, script).await
}

/// `after_begin`은 요청을 연 뒤 실행 도중에 일어나는 일을 흉내 낸다(예: 켜기 실패)
async fn drive_with(state: &SessionState, ask: bool, after_begin: impl FnOnce(&SessionState), script: impl Fn(&'static str, &'static str) -> Reply) -> Vec<String> {
    let ticket = state.begin_run("r1").unwrap();
    after_begin(state);
    let trace: Trace = Arc::new(Mutex::new(Vec::new()));
    let recorder = trace.clone();
    state
        .run_request(ticket, ask, |name, arg| {
            let reply = script(name, arg);
            let phase = state.claim_view().phase.map(Phase::as_str).unwrap_or("-");
            let busy = state.busy();
            recorder.lock().unwrap().push(if arg.is_empty() { format!("{name}[{phase}]") } else { format!("{name}({arg})[{phase}]") });
            if name == ANNOUNCE_FINISHED {
                recorder.lock().unwrap().push(format!("busy={busy}"));
            }
            async move { reply }
        })
        .await;
    let out = trace.lock().unwrap().clone();
    out
}

fn ran(result: ResultStatus, booted: bool) -> Reply {
    Reply { ok: true, result: Some(result), booted, ..Reply::default() }
}

fn live(booted: bool) -> Reply {
    Reply { ok: true, booted, ..Reply::default() }
}

fn names(trace: &[String]) -> Vec<&str> {
    trace.iter().map(|line| line.split(['[', '(']).next().unwrap()).collect()
}

#[tokio::test]
async fn success_saves_then_releases_after_phase_change() {
    let state = state(true);
    let trace = drive(&state, false, |name, _| if name == RUN_PLAN { ran(ResultStatus::Done, true) } else { live(true) }).await;
    assert_eq!(
        trace,
        [
            "prepare_edits[running]",
            "announce_edits[running]",
            "plan_brief[running]",
            "run_plan[running]",
            // 에이전트가 끝나면 점유의 단계가 저장 중이 된 뒤에 떼는 콜백을 부른다
            "detach_run[saving]",
            "tally_run[saving]",
            "note_question[saving]",
            "save_checkpoint[saving]",
            "after_save[saving]",
            "build_finished(result)[saving]",
            "settle(done)[saving]",
            // 점유는 끝 알림 전에 풀린다
            "announce_finished(announce)[-]",
            "busy=false",
        ]
    );
    assert!(!state.busy());
}

#[tokio::test]
async fn mismatch_reverts_and_ends_with_error() {
    let state = state(true);
    let trace = drive(&state, false, |name, _| match name {
        RUN_PLAN => ran(ResultStatus::Done, true),
        SAVE_CHECKPOINT => Reply { mismatch: true, ..live(true) },
        _ => live(true),
    })
    .await;
    assert_eq!(
        names(&trace),
        ["prepare_edits", "announce_edits", "plan_brief", "run_plan", "detach_run", "tally_run", "note_question", "save_checkpoint", "revert_after_mismatch", "build_finished", "settle", "announce_finished", "busy=false"]
    );
    assert!(trace.contains(&"build_finished(mismatch)[saving]".to_owned()));
    assert!(trace.contains(&"settle(error)[saving]".to_owned()));
}

#[tokio::test]
async fn local_edits_failure_ends_without_reverting() {
    let state = state(true);
    let trace = drive(&state, false, |name, _| if name == PREPARE { Reply::failed(true) } else { live(true) }).await;
    assert_eq!(trace, ["prepare_edits[running]", "detach_run[saving]", "build_finished(local_edits)[saving]", "settle(error)[saving]", "announce_finished(announce)[-]", "busy=false"]);
}

#[tokio::test]
async fn cancel_after_runner_returned_is_a_cancel_and_keeps_the_cancelling_phase() {
    let state = state(true);
    let trace = drive(&state, false, |name, _| if name == RUN_PLAN { Reply { cancel_requested: true, cancel_aborted: true, ..live(true) } } else { live(true) }).await;
    // 취소를 받았으면 점유의 단계를 저장 중으로 바꾸지 않고 되돌린 뒤 취소 글로 끝난다
    assert_eq!(
        trace,
        ["prepare_edits[running]", "announce_edits[running]", "plan_brief[running]", "run_plan[running]", "revert_run(cancelled)[running]", "build_finished(cancelled)[running]", "settle(cancelled)[running]", "announce_finished(announce)[-]", "busy=false"]
    );
}

#[tokio::test]
async fn exception_reverts_and_is_an_error_without_the_cancel_signal() {
    let state = state(true);
    let trace = drive(&state, false, |name, _| if name == RUN_PLAN { Reply::failed(false) } else { live(true) }).await;
    assert_eq!(
        trace,
        ["prepare_edits[running]", "announce_edits[running]", "plan_brief[running]", "run_plan[running]", "detach_run[saving]", "revert_run[saving]", "build_finished(error)[saving]", "settle(error)[saving]", "announce_finished(announce)[-]", "busy=false"]
    );
}

#[tokio::test]
async fn stopped_session_ends_silently_and_never_saves() {
    let state = state(true);
    let trace = drive(&state, false, |name, _| {
        let mut reply = if name == RUN_PLAN { ran(ResultStatus::Done, true) } else { live(true) };
        reply.stop_aborted = true;
        reply
    })
    .await;
    assert!(!trace.iter().any(|line| line.starts_with("save_checkpoint")), "{trace:?}");
    assert!(trace.contains(&"announce_finished(silent)[-]".to_owned()), "{trace:?}");
}

#[tokio::test]
async fn unbooted_done_with_changes_reverts_host_only() {
    let state = state(false);
    let trace = drive(&state, false, |name, _| match name {
        RUN_PLAN => ran(ResultStatus::Done, false),
        PROBE_PENDING => Reply { pending: true, ..live(false) },
        REVERT_HOST_ONLY => Reply { reverted: true, ..live(false) },
        _ => live(false),
    })
    .await;
    assert_eq!(
        names(&trace),
        ["prepare_edits", "announce_edits", "plan_brief", "run_plan", "detach_run", "tally_run", "note_question", "probe_pending", "revert_host_only", "build_finished", "settle", "announce_finished", "busy=false"]
    );
    assert!(trace.contains(&"build_finished(unverified)[saving]".to_owned()));
    // 바뀐 것이 없으면 읽기만 하고 아무것도 하지 않는다
    let state = self::state(false);
    let trace = drive(&state, false, |name, _| if name == RUN_PLAN { ran(ResultStatus::Done, false) } else { live(false) }).await;
    assert!(trace.contains(&"probe_pending[saving]".to_owned()));
    assert!(!trace.iter().any(|line| line.starts_with("revert")));
    assert!(trace.contains(&"build_finished(result)[saving]".to_owned()));
}

#[tokio::test]
async fn failed_boot_keeps_changes_and_says_so() {
    let state = state(false);
    let trace = drive_with(&state, false, fail_boot, |name, _| match name {
        RUN_PLAN => ran(ResultStatus::Failed, true),
        PROBE_PENDING => Reply { pending: true, ..live(true) },
        _ => live(true),
    })
    .await;
    assert!(trace.contains(&"notice_kept[saving]".to_owned()), "{trace:?}");
    assert!(!trace.iter().any(|line| line.starts_with("revert")), "{trace:?}");
}

#[tokio::test]
async fn preflight_error_stops_after_detach() {
    let state = state(true);
    let trace = drive(&state, false, |name, _| if name == RUN_PLAN { Reply { preflight: true, ..live(true) } } else { live(true) }).await;
    assert_eq!(
        trace,
        ["prepare_edits[running]", "announce_edits[running]", "plan_brief[running]", "run_plan[running]", "detach_run[saving]", "build_finished(preflight)[saving]", "settle(error)[saving]", "announce_finished(announce)[-]", "busy=false"]
    );
}

#[tokio::test]
async fn a_stale_ticket_does_not_release_a_newer_claim() {
    // 멈추기가 점유를 비우고 다른 점유가 잡혔다면 늦게 끝난 실행은 그 점유를 풀지 못한다
    let state = state(true);
    let ticket = state.begin_run("old").unwrap();
    state.release(ticket);
    let newer = state.begin_task(crate::claim::TaskKind::Restore).unwrap();
    state.run_request(ticket, true, |name, _| async move { if name == RUN_PLAN { ran(ResultStatus::Done, true) } else { live(true) } }).await;
    assert!(state.holds(newer));
    assert!(state.busy());
}
