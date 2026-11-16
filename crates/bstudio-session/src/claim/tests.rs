use super::*;
use crate::status::{BeginStop, SessionStatus};

fn ready() -> SessionState {
    let state = SessionState::new(SessionStatus::Starting).unwrap();
    let crate::status::BootRequest::Start { generation, .. } = state.request_boot() else { panic!("켜기를 시작해야 합니다") };
    state.boot_finished(generation, crate::status::BootOutcome::Ready);
    assert_eq!(state.status(), SessionStatus::Ready);
    state
}

fn idle() -> SessionState {
    SessionState::new(SessionStatus::Idle).unwrap()
}

fn message(result: Result<impl std::fmt::Debug, Fail>) -> (u16, String) {
    let fail = result.unwrap_err();
    (fail.status, fail.message)
}

#[test]
fn a_ticket_releases_only_its_own_claim() {
    let state = ready();
    let first = state.begin_run("run1").unwrap();
    assert!(state.busy());
    // 다른 표(아직 나오지 않은 표, 0)로는 풀리지 않는다
    assert!(!state.release(first + 1));
    assert!(!state.release(0));
    assert!(state.busy());
    assert!(state.release(first));
    assert!(!state.busy());
    // 이미 푼 표로 다시 풀어도 아무것도 하지 않는다. 그 사이에 새로 잡힌 점유를 풀지 못한다
    let second = state.begin_task(TaskKind::Restore).unwrap();
    assert!(!state.release(first));
    assert!(state.busy());
    assert!(state.release(second));
    assert!(second > first);
}

#[test]
fn a_late_holder_cannot_release_a_newer_claim_of_another_kind() {
    let state = ready();
    let run = state.begin_run("run1").unwrap();
    assert!(state.release(run));
    let task = state.begin_task(TaskKind::Reverify).unwrap();
    // 끝난 실행의 늦은 `finally`
    assert!(!state.release(run));
    assert_eq!(state.claim_view().kind.as_deref(), Some("reverify"));
    assert!(state.release(task));
}

#[test]
fn phases_move_running_to_cancelling_to_saving_and_reject_other_moves() {
    let state = ready();
    let ticket = state.begin_run("r").unwrap();
    assert_eq!(state.claim_view().phase, Some(Phase::Running));
    assert!(state.set_phase(ticket, Phase::Cancelling));
    assert_eq!(state.claim_view().phase, Some(Phase::Cancelling));
    assert!(state.set_phase(ticket, Phase::Saving));
    assert_eq!(state.claim_view().phase, Some(Phase::Saving));
    // 저장 중에서 취소 중으로는 가지 않는다
    assert!(!state.set_phase(ticket, Phase::Cancelling));
    // 같은 단계로 "바꾸기"도 허용하지 않는다
    assert!(!state.set_phase(ticket, Phase::Saving));
    // 저장 중 → 진행(터미널 실행을 다시 여는 길)
    assert!(state.set_phase(ticket, Phase::Running));
    assert!(!state.set_phase(ticket + 1, Phase::Saving));
    // 보조 작업은 단계가 없다
    state.release(ticket);
    let task = state.begin_task(TaskKind::Restore).unwrap();
    assert!(!state.set_phase(task, Phase::Saving));
}

#[test]
fn cancel_follows_the_old_decisions() {
    let state = ready();
    // 실행 없음
    assert_eq!(message(state.cancel_run("r")), (409, "취소할 수 있는 요청이 없습니다. 이미 끝났거나 결과를 저장하는 중입니다".into()));
    let ticket = state.begin_run("r").unwrap();
    // 다른 runId
    assert_eq!(message(state.cancel_run("other")).0, 409);
    assert_eq!(state.cancel_run("r"), Ok(CancelOutcome::Started));
    // 이미 취소 중이면 조용히 돌아온다
    assert_eq!(state.cancel_run("r"), Ok(CancelOutcome::AlreadyCancelling));
    assert_eq!(state.claim_view().phase, Some(Phase::Cancelling));
    state.release(ticket);

    let ticket = state.begin_run("s").unwrap();
    assert!(state.set_phase(ticket, Phase::Saving));
    // 저장 중은 409
    assert_eq!(message(state.cancel_run("s")), (409, "취소할 수 있는 요청이 없습니다. 이미 끝났거나 결과를 저장하는 중입니다".into()));
    state.release(ticket);

    // 보조 작업은 취소할 실행이 아니다
    state.begin_task(TaskKind::Restore).unwrap();
    assert_eq!(message(state.cancel_run("r")).0, 409);
}

#[test]
fn steer_needs_an_open_run() {
    let state = ready();
    assert_eq!(message(state.steer_target()), (409, "실행 중이 아닙니다. 새 요청으로 보내세요".into()));
    let ticket = state.begin_run("r").unwrap();
    assert_eq!(state.steer_target(), Ok("r".into()));
    assert!(state.set_phase(ticket, Phase::Cancelling));
    assert_eq!(state.steer_target(), Ok("r".into()));
    assert!(state.set_phase(ticket, Phase::Saving));
    assert!(state.steer_target().is_err());
    state.release(ticket);
    state.begin_task(TaskKind::SyncRemote).unwrap();
    assert!(state.steer_target().is_err());
}

#[test]
fn run_check_keeps_the_old_order_and_texts() {
    let stopped = SessionState::new(SessionStatus::Starting).unwrap();
    assert_eq!(message(stopped.check_run()), (409, "샌드박스가 준비된 뒤에 요청할 수 있습니다".into()));
    let state = ready();
    state.begin_export().unwrap();
    assert_eq!(message(state.check_run()), (409, "원격 저장소에 올리는 중입니다".into()));
    let state = idle();
    state.begin_run("r").unwrap();
    // 바쁨이 올리는 중보다 먼저다
    assert_eq!(message(state.check_run()), (409, "이전 요청을 처리하는 중입니다".into()));
    assert_eq!(message(state.begin_run("r2")), (409, "이전 요청을 처리하는 중입니다".into()));
    // 올리기 안에서 따라잡기가 점유한 상태: 바쁨이 올리는 중보다 먼저다(옛 `running` 검사가 먼저였다)
    let state = idle();
    state.begin_export().unwrap();
    state.begin_catch_up().unwrap();
    assert_eq!(message(state.check_run()), (409, "이전 요청을 처리하는 중입니다".into()));
}

#[test]
fn holds_tells_whether_the_ticket_is_still_the_claim() {
    let state = ready();
    let run = state.begin_run("r").unwrap();
    assert!(state.holds(run));
    assert!(!state.holds(run + 1));
    state.release(run);
    assert!(!state.holds(run));
    let task = state.begin_task(TaskKind::Restore).unwrap();
    assert!(state.holds(task));
    assert!(!state.holds(run));
    // 멈추기가 비우면 이 표는 더는 점유가 아니다
    state.begin_stop();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(state.run_stop(|_| async { Ok(()) })).unwrap();
    assert!(!state.holds(task));
}

#[test]
fn a_stopping_session_takes_no_run_or_task_and_the_other_rejections_come_first() {
    let state = ready();
    assert_eq!(state.begin_stop(), BeginStop::Started);
    let expected = (409, STOPPING_MESSAGE.to_owned());
    assert_eq!(message(state.check_run()), expected);
    assert_eq!(message(state.begin_run("r")), expected);
    for kind in [TaskKind::Restore, TaskKind::RestoreBackup, TaskKind::SyncRemote, TaskKind::Reverify] {
        assert_eq!(message(state.check_task(kind)), expected);
        assert_eq!(message(state.begin_task(kind)), expected);
    }
    assert_eq!(state.begin_catch_up(), None);
    assert!(state.terminal_busy().is_some());
    assert!(state.begin_terminal_run("t").is_err());
    assert!(!state.busy());
}

#[test]
fn a_stopping_session_rejects_with_the_old_error_when_the_old_code_already_did() {
    // 멈추는 중이어도 먼저 나던 오류가 그대로 먼저 난다
    let state = ready();
    let ticket = state.begin_run("r").unwrap();
    state.begin_stop();
    assert_eq!(message(state.check_run()), (409, "이전 요청을 처리하는 중입니다".into()));
    assert_eq!(message(state.check_task(TaskKind::Restore)), (409, "다른 작업을 처리하는 중입니다".into()));
    assert!(state.release(ticket));
}

#[test]
fn task_checks_keep_the_old_texts_per_kind() {
    let state = SessionState::new(SessionStatus::Idle).unwrap();
    assert_eq!(message(state.check_task(TaskKind::Restore)).1, "샌드박스가 준비된 뒤에 되돌릴 수 있습니다");
    assert_eq!(message(state.check_task(TaskKind::RestoreBackup)).1, "샌드박스가 준비된 뒤에 되살릴 수 있습니다");
    assert_eq!(message(state.check_task(TaskKind::SyncRemote)).1, "샌드박스가 준비된 뒤에 가져올 수 있습니다");
    assert_eq!(message(state.check_task(TaskKind::Reverify)).1, "샌드박스가 준비된 뒤에 다시 검증할 수 있습니다");
    let state = ready();
    state.begin_run("r").unwrap();
    assert_eq!(message(state.check_task(TaskKind::Restore)).1, "다른 작업을 처리하는 중입니다");
    assert_eq!(message(state.check_task(TaskKind::Reverify)).1, "다른 작업을 처리하는 중입니다. 끝난 뒤 다시 검증하세요");
    let state = ready();
    state.begin_export().unwrap();
    assert_eq!(message(state.check_task(TaskKind::SyncRemote)).1, "다른 작업을 처리하는 중입니다");
}

#[test]
fn catch_up_skips_when_busy_but_ignores_export() {
    let state = idle();
    // 상태는 보지 않는다(옛 코드도 보지 않았다)
    let ticket = state.begin_catch_up().unwrap();
    assert_eq!(state.begin_catch_up(), None);
    assert!(state.release(ticket));
    let export = state.begin_export().unwrap();
    // 올리는 중에도 따라잡는다(올리기 안에서 부른다)
    assert!(state.begin_catch_up().is_some());
    assert!(state.release_export(export));
}

#[test]
fn busy_ops_use_the_old_texts() {
    let state = ready();
    assert!(state.reject_busy(BusyOp::SetModel).is_ok());
    state.begin_export().unwrap();
    // 올리는 중은 이 판정을 막지 않는다(옛 코드는 `running`만 봤다)
    assert!(state.reject_busy(BusyOp::SetModel).is_ok());
    state.begin_run("r").unwrap_err();
    let state = ready();
    state.begin_task(TaskKind::Restore).unwrap();
    assert_eq!(message(state.reject_busy(BusyOp::SetModel)).1, "요청을 처리하는 동안에는 모델을 바꿀 수 없습니다");
    assert_eq!(message(state.reject_busy(BusyOp::SaveRequirements)).1, "요청을 처리하는 동안에는 요구사항을 저장할 수 없습니다. 끝난 뒤에 저장해 주세요");
    assert_eq!(message(state.reject_busy(BusyOp::ManualVerify)).1, "요청을 처리하는 동안에는 사람 확인을 남길 수 없습니다. 끝난 뒤에 눌러 주세요");
    assert_eq!(message(state.reject_busy(BusyOp::ManualClear)).1, "요청을 처리하는 동안에는 사람 확인을 취소할 수 없습니다. 끝난 뒤에 눌러 주세요");
    assert_eq!(message(state.reject_busy(BusyOp::WriteRequirementsDoc)).1, "요청을 처리하는 동안에는 요구사항 문서를 저장할 수 없습니다. 끝난 뒤에 저장해 주세요");
}

#[test]
fn export_follows_the_old_order() {
    let state = ready();
    let task = state.begin_task(TaskKind::Restore).unwrap();
    assert_eq!(message(state.begin_export()), (409, "작업이 끝난 뒤에 올릴 수 있습니다".into()));
    state.release(task);
    let export = state.begin_export().unwrap();
    assert_eq!(message(state.begin_export()), (409, "이미 올리는 중입니다".into()));
    assert!(state.exporting());
    // 다른 표로는 풀리지 않는다
    assert!(!state.release_export(export + 1));
    assert!(state.exporting());
    assert!(state.release_export(export));
    assert!(!state.release_export(export));
    // 올리기의 표는 slot을 풀지 못한다
    let run = state.begin_run("r").unwrap();
    assert!(!state.release_export(run));
    assert!(state.busy());
}

#[test]
fn delete_is_refused_while_anything_holds_the_session_even_when_idle() {
    let state = idle();
    assert!(state.delete_busy().is_ok());
    let run = state.begin_run("r").unwrap();
    assert_eq!(message(state.delete_busy()), (409, "실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요".into()));
    state.release(run);
    let terminal = state.begin_terminal_run("t").unwrap();
    assert!(state.delete_busy().is_err());
    state.release(terminal);
    let task = state.begin_catch_up().unwrap();
    assert!(state.delete_busy().is_err());
    state.release(task);
    let export = state.begin_export().unwrap();
    assert!(state.delete_busy().is_err());
    state.release_export(export);
    assert!(state.delete_busy().is_ok());
}

#[test]
fn terminal_runs_share_the_slot_and_keep_the_old_texts() {
    let state = idle();
    let export = state.begin_export().unwrap();
    assert_eq!(state.terminal_busy().as_deref(), Some("[b-studio] 원격 저장소에 올리는 중입니다. 끝난 뒤 다시 보내세요."));
    state.release_export(export);
    let terminal = state.begin_terminal_run("t").unwrap();
    assert!(state.claim_view().terminal);
    assert_eq!(state.terminal_busy().as_deref(), Some("[b-studio] 앞선 요청을 처리하는 중입니다(대화 창에서 보낸 요청이거나 검증 결과를 저장하는 중). 끝난 뒤 다시 보내세요."));
    // 대화 창의 요청과 서로 막는다
    assert_eq!(message(state.begin_run("r")).1, "이전 요청을 처리하는 중입니다");
    assert!(state.begin_terminal_run("t2").is_err());
    // 취소·진행 중 지시도 같은 자리를 본다
    assert_eq!(state.cancel_run("t"), Ok(CancelOutcome::Started));
    state.release(terminal);
    assert_eq!(state.terminal_busy(), None);
}

#[test]
fn stopping_clears_the_slot_and_invalidates_its_tickets_but_not_the_export() {
    let state = ready();
    let run = state.begin_run("r").unwrap();
    let export = state.begin_export();
    assert!(export.is_err(), "바쁠 때는 올릴 수 없다");
    state.release(run);
    let export = state.begin_export().unwrap();
    let task = state.begin_catch_up().unwrap();

    assert_eq!(state.begin_stop(), BeginStop::Started);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(state.run_stop(|_| async { Ok(()) })).unwrap();
    assert_eq!(state.status(), SessionStatus::Stopped);
    assert!(!state.busy());
    // 늦게 끝난 보조 작업은 아무것도 하지 않는다
    assert!(!state.release(task));
    // 멈추기는 올리기를 건드리지 않는다
    assert!(state.exporting());
    assert!(state.release_export(export));
    // 멈춘 뒤에는 새 점유를 받지 않는다(상태가 거절한다)
    assert_eq!(message(state.begin_run("r2")).1, "샌드박스가 준비된 뒤에 요청할 수 있습니다");
    assert!(state.begin_terminal_run("t").is_err());
    assert_eq!(state.begin_catch_up(), None);
}

#[test]
fn a_failed_stop_that_never_reaches_stopped_keeps_the_claims_and_releases_the_stopping_flag() {
    let state = ready();
    let run = state.begin_run("r").unwrap();
    state.begin_stop();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    // 상태를 바꾸기 전 단계에서 던진다
    let outcome = runtime.block_on(state.run_stop(|name| async move { if name == "clear_violation" { Err("실패".to_owned()) } else { Ok(()) } }));
    assert!(outcome.is_err());
    assert_eq!(state.status(), SessionStatus::Ready);
    assert!(state.busy());
    assert!(state.release(run));
}

#[test]
fn tickets_never_repeat() {
    let state = ready();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..50 {
        let ticket = state.begin_task(TaskKind::Restore).unwrap();
        assert!(seen.insert(ticket));
        state.release(ticket);
        let export = state.begin_export().unwrap();
        assert!(seen.insert(export));
        state.release_export(export);
    }
}

#[test]
fn task_kind_names_round_trip() {
    for kind in [TaskKind::Restore, TaskKind::RestoreBackup, TaskKind::SyncRemote, TaskKind::Reverify, TaskKind::CatchUpBase] {
        assert_eq!(TaskKind::parse(kind.as_str()), Some(kind));
    }
    assert_eq!(TaskKind::parse("nope"), None);
}
