use super::*;
use std::sync::Arc;

fn state(initial: SessionStatus) -> SessionState {
    SessionState::new(initial).unwrap()
}

fn start_generation(request: BootRequest) -> u64 {
    match request {
        BootRequest::Start { generation, .. } => generation,
        other => panic!("켜기를 시작해야 합니다: {other:?}"),
    }
}

#[test]
fn stop_steps_are_pinned_to_the_old_stop_session_order() {
    // 옛 `stopSession`의 부수 효과 순서와 실패 처리(글자 그대로 적는다. 상수에서 만들면 상수를 바꿔도 시험이 따라 바뀐다)
    let expected: [(&str, Failure); 15] = [
        ("clear_violation", Failure::Throw),
        ("clear_terminal_attention", Failure::Throw),
        ("settle_terminal_run", Failure::Throw),
        ("abort_log_follower", Failure::Throw),
        ("clear_usage_timer", Failure::Throw),
        ("stop_stall_watch", Failure::Throw),
        ("close_file_watcher", Failure::Throw),
        ("dispose_terminal", Failure::Throw),
        ("close_gateway", Failure::Swallow),
        ("destroy_sandbox", Failure::Swallow),
        ("close_preview_proxies", Failure::Swallow),
        ("mark_services_stopped", Failure::Throw),
        ("apply_status", Failure::Throw),
        ("clear_sandbox_link", Failure::Throw),
        ("flush_persist", Failure::Throw),
    ];
    let actual: Vec<(&str, Failure)> = STOP_STEPS.iter().chain([&FLUSH_STEP]).map(|step| (step.name, step.failure)).collect();
    assert_eq!(actual, expected);
}

#[test]
fn only_idle_and_starting_are_initial_states() {
    assert!(SessionState::new(SessionStatus::Ready).is_none());
    assert!(SessionState::new(SessionStatus::Failed).is_none());
    assert!(SessionState::new(SessionStatus::Stopped).is_none());
    assert_eq!(state(SessionStatus::Idle).status(), SessionStatus::Idle);
    assert_eq!(state(SessionStatus::Starting).status(), SessionStatus::Starting);
}

#[test]
fn parse_and_as_str_round_trip() {
    for status in [SessionStatus::Idle, SessionStatus::Starting, SessionStatus::Ready, SessionStatus::Failed, SessionStatus::Stopped] {
        assert_eq!(SessionStatus::parse(status.as_str()), Some(status));
    }
    assert_eq!(SessionStatus::parse("Idle"), None);
    assert_eq!(SessionStatus::parse(""), None);
}

#[test]
fn request_boot_branches_match_ensure_booted() {
    // idle: 시작하고 starting으로 바뀐다
    let idle = state(SessionStatus::Idle);
    assert_eq!(idle.request_boot(), BootRequest::Start { generation: 1, change: Some(Change { status: SessionStatus::Starting, error: None }) });
    assert_eq!(idle.status(), SessionStatus::Starting);
    // 켜는 중: 기다린다
    assert_eq!(idle.request_boot(), BootRequest::Wait);
    // 즉시 기동 세션(starting인데 켜기가 없다): 시작하지만 상태는 그대로라 알리지 않는다
    let eager = state(SessionStatus::Starting);
    assert_eq!(eager.request_boot(), BootRequest::Start { generation: 1, change: None });
    assert_eq!(eager.request_boot(), BootRequest::Wait);
}

#[test]
fn failed_boot_is_retried_with_a_new_generation_and_clears_the_error() {
    let session = state(SessionStatus::Idle);
    let first = start_generation(session.request_boot());
    assert_eq!(session.boot_finished(first, BootOutcome::Failed("이미지 빌드 실패".into())), Some(Change { status: SessionStatus::Failed, error: Some("이미지 빌드 실패".into()) }));
    assert_eq!(session.error().as_deref(), Some("이미지 빌드 실패"));
    let second = session.request_boot();
    assert_eq!(second, BootRequest::Start { generation: first + 1, change: Some(Change { status: SessionStatus::Starting, error: None }) });
    assert_eq!(session.error(), None);
}

#[test]
fn ready_and_stopped_do_not_start() {
    let session = state(SessionStatus::Idle);
    let generation = start_generation(session.request_boot());
    session.boot_finished(generation, BootOutcome::Ready).unwrap();
    assert_eq!(session.request_boot(), BootRequest::Ready);
    assert_eq!(session.begin_stop(), BeginStop::Started);
    // 멈추는 중이어도 켜져 있으면 켜져 있다고 답한다(옛과 같다)
    assert_eq!(session.request_boot(), BootRequest::Ready);
}

#[test]
fn boot_finished_applies_only_to_the_current_generation() {
    let session = state(SessionStatus::Idle);
    let generation = start_generation(session.request_boot());
    assert_eq!(session.boot_finished(generation + 1, BootOutcome::Ready), None);
    assert_eq!(session.boot_finished(generation.wrapping_sub(1), BootOutcome::Ready), None);
    assert_eq!(session.status(), SessionStatus::Starting);
    assert_eq!(session.boot_finished(generation, BootOutcome::Ready), Some(Change { status: SessionStatus::Ready, error: None }));
}

#[test]
fn stopping_alone_makes_a_matching_generation_late() {
    // 멈추기를 시작하면 세대도 올라가 둘 중 하나만으로도 늦은 결과가 된다. 확인이 각각 서 있는지 보려고 한쪽만 맞춰 둔다
    for outcome in [BootOutcome::Ready, BootOutcome::Failed("x".into())] {
        let session = state(SessionStatus::Idle);
        let generation = start_generation(session.request_boot());
        session.lock().stopping = true;
        assert_eq!(session.generation(), generation);
        assert_eq!(session.boot_finished(generation, outcome), None);
        assert_eq!(session.status(), SessionStatus::Starting);
        assert!(!session.live(generation));
    }
}

#[test]
fn a_stopped_session_ignores_a_matching_generation() {
    let session = state(SessionStatus::Idle);
    let generation = start_generation(session.request_boot());
    session.lock().status = SessionStatus::Stopped;
    assert_eq!(session.boot_finished(generation, BootOutcome::Ready), None);
    assert_eq!(session.status(), SessionStatus::Stopped);
    assert!(!session.live(generation));
}

#[test]
fn boot_finished_after_stop_began_is_ignored_for_both_outcomes() {
    for outcome in [BootOutcome::Ready, BootOutcome::Failed("x".into())] {
        let session = state(SessionStatus::Idle);
        let generation = start_generation(session.request_boot());
        assert_eq!(session.begin_stop(), BeginStop::Started);
        assert_eq!(session.boot_finished(generation, outcome), None);
        assert_eq!(session.status(), SessionStatus::Starting);
        assert!(!session.live(generation));
    }
}

#[test]
fn request_boot_while_stopping_is_refused_unless_ready() {
    for initial in [SessionStatus::Idle, SessionStatus::Starting] {
        let session = state(initial);
        assert_eq!(session.begin_stop(), BeginStop::Started);
        assert_eq!(session.request_boot(), BootRequest::Stopped);
        assert_eq!(session.status(), initial);
    }
}

#[test]
fn begin_stop_branches() {
    let session = state(SessionStatus::Idle);
    assert_eq!(session.begin_stop(), BeginStop::Started);
    assert!(session.stopping());
    assert_eq!(session.begin_stop(), BeginStop::Joined);
}

async fn run(session: &SessionState, fail_on: &[&'static str]) -> (Vec<&'static str>, StopOutcome) {
    let mut seen = Vec::new();
    let outcome = session
        .run_stop(|name| {
            seen.push(name);
            let fail = fail_on.contains(&name);
            async move { if fail { Err(format!("{name} 실패")) } else { Ok(()) } }
        })
        .await;
    (seen, outcome)
}

#[tokio::test]
async fn stop_steps_run_in_the_documented_order_and_finish_stopped() {
    let session = state(SessionStatus::Idle);
    assert_eq!(session.begin_stop(), BeginStop::Started);
    let (seen, outcome) = run(&session, &[]).await;
    let expected: Vec<&str> = STOP_STEPS.iter().map(|step| step.name).chain([FLUSH_STEP.name]).collect();
    assert_eq!(seen, expected);
    assert_eq!(outcome, Ok(()));
    assert_eq!(session.status(), SessionStatus::Stopped);
    assert!(!session.stopping());
    assert_eq!(session.begin_stop(), BeginStop::AlreadyStopped);
}

#[tokio::test]
async fn status_is_stopped_exactly_when_apply_status_is_called() {
    let session = Arc::new(state(SessionStatus::Idle));
    session.begin_stop();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let probe = session.clone();
    let log = seen.clone();
    session
        .run_stop(move |name| {
            log.lock().unwrap().push((name, probe.status()));
            async { Ok(()) }
        })
        .await
        .unwrap();
    for (name, status) in seen.lock().unwrap().iter() {
        let expected = if STOP_STEPS.iter().position(|s| s.name == *name).map_or(true, |at| at >= STOP_STEPS.iter().position(|s| s.name == APPLY_STATUS).unwrap()) {
            SessionStatus::Stopped
        } else {
            SessionStatus::Idle
        };
        assert_eq!(*status, expected, "{name}");
    }
}

#[tokio::test]
async fn swallowed_steps_do_not_stop_the_sequence() {
    for step in STOP_STEPS.iter().filter(|step| step.failure == Failure::Swallow) {
        let session = state(SessionStatus::Idle);
        session.begin_stop();
        let (seen, outcome) = run(&session, &[step.name]).await;
        assert_eq!(outcome, Ok(()), "{}", step.name);
        assert_eq!(seen.len(), STOP_STEPS.len() + 1, "{}", step.name);
        assert_eq!(session.status(), SessionStatus::Stopped);
    }
}

#[tokio::test]
async fn throwing_steps_stop_there_and_release_the_stopping_mark() {
    for (at, step) in STOP_STEPS.iter().chain([&FLUSH_STEP]).enumerate().filter(|(_, step)| step.failure == Failure::Throw) {
        let session = state(SessionStatus::Idle);
        let generation = start_generation(session.request_boot());
        session.begin_stop();
        let (seen, outcome) = run(&session, &[step.name]).await;
        assert_eq!(outcome, Err(StopFailure { step: step.name.to_owned(), message: format!("{} 실패", step.name) }));
        assert_eq!(seen.len(), at + 1, "{}: 던진 단계 뒤는 부르지 않는다", step.name);
        assert!(!session.stopping(), "{}: 멈추는 중으로 남지 않는다", step.name);
        // 상태는 옛 코드처럼 그대로다(상태를 바꾸는 단계 앞에서 던졌으면 이전 상태, 뒤였으면 stopped)
        let applied = STOP_STEPS.iter().position(|s| s.name == APPLY_STATUS).unwrap();
        let expected = if at >= applied { SessionStatus::Stopped } else { SessionStatus::Starting };
        assert_eq!(session.status(), expected, "{}", step.name);
        // 늦은 켜기 결과는 계속 무시한다
        assert_eq!(session.boot_finished(generation, BootOutcome::Ready), None, "{}", step.name);
        // 다시 멈출 수 있다(이미 멈췄으면 할 일이 없다)
        let again = session.begin_stop();
        assert_eq!(again, if expected == SessionStatus::Stopped { BeginStop::AlreadyStopped } else { BeginStop::Started }, "{}", step.name);
    }
}

#[tokio::test]
async fn joined_callers_get_the_same_outcome() {
    let session = Arc::new(state(SessionStatus::Idle));
    assert_eq!(session.begin_stop(), BeginStop::Started);
    assert_eq!(session.begin_stop(), BeginStop::Joined);
    let joiner = {
        let session = session.clone();
        tokio::spawn(async move { session.join_stop().await })
    };
    let (_, outcome) = run(&session, &["dispose_terminal"]).await;
    assert!(outcome.is_err());
    assert_eq!(joiner.await.unwrap(), outcome);
    // 끝난 뒤에 기다려도 같은 결과를 받는다
    assert_eq!(session.join_stop().await, outcome);
}

#[tokio::test]
async fn a_new_stop_attempt_resets_the_previous_outcome() {
    let session = state(SessionStatus::Idle);
    session.begin_stop();
    let (_, failed) = run(&session, &["clear_violation"]).await;
    assert!(failed.is_err());
    assert_eq!(session.begin_stop(), BeginStop::Started);
    let (_, outcome) = run(&session, &[]).await;
    assert_eq!(outcome, Ok(()));
    assert_eq!(session.join_stop().await, Ok(()));
}
