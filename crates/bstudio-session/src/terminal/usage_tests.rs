use super::*;

fn facts() -> UsageFacts {
    UsageFacts { has_request_id: true, counted: false, attached: false, open_run: false, in_open_window: false, in_early_slack: false, opened_by_tool: false, in_closed_run: false, in_closed_late: false }
}

#[test]
fn fresh_request_in_open_window_counts_and_attaches_open() {
    let step = decide_usage(&UsageFacts { open_run: true, in_open_window: true, ..facts() });
    assert_eq!(step, UsageStep { count: true, target: RunTarget::Open, count_turn: true, check_limits: true });
}

#[test]
fn counted_request_is_not_counted_again_but_can_still_attach() {
    let step = decide_usage(&UsageFacts { counted: true, open_run: true, in_open_window: true, ..facts() });
    assert_eq!(step, UsageStep { count: false, target: RunTarget::Open, count_turn: true, check_limits: false });
}

#[test]
fn attached_request_is_not_attached_again() {
    let step = decide_usage(&UsageFacts { attached: true, open_run: true, in_open_window: true, ..facts() });
    assert_eq!(step.target, RunTarget::None);
    assert!(!step.count_turn);
    assert!(step.count);
}

#[test]
fn request_without_id_always_counts_and_attaches() {
    let step = decide_usage(&UsageFacts { has_request_id: false, counted: true, attached: true, open_run: true, in_open_window: true, ..facts() });
    assert!(step.count);
    assert_eq!(step.target, RunTarget::Open);
}

#[test]
fn open_window_wins_over_closed_window() {
    let step = decide_usage(&UsageFacts { open_run: true, in_open_window: true, in_closed_run: true, in_closed_late: true, ..facts() });
    assert_eq!(step.target, RunTarget::Open);
}

#[test]
fn closed_window_when_no_open_run_or_before_open() {
    assert_eq!(decide_usage(&UsageFacts { in_closed_run: true, ..facts() }).target, RunTarget::Closed);
    assert_eq!(decide_usage(&UsageFacts { in_closed_late: true, ..facts() }).target, RunTarget::Closed);
    let before_open = decide_usage(&UsageFacts { open_run: true, in_closed_late: true, ..facts() });
    assert_eq!(before_open.target, RunTarget::Closed);
    assert!(!before_open.count_turn);
}

#[test]
fn outside_every_window_nothing_attaches_but_it_counts() {
    let step = decide_usage(&facts());
    assert_eq!(step, UsageStep { count: true, target: RunTarget::None, count_turn: false, check_limits: true });
}

#[test]
fn early_slack_attaches_only_to_a_tool_opened_run() {
    let tool = UsageFacts { open_run: true, in_early_slack: true, opened_by_tool: true, ..facts() };
    assert_eq!(decide_usage(&tool).target, RunTarget::Open);
    assert!(decide_usage(&tool).count_turn);
    // 요청 훅이 연 실행에는 시작 앞의 요청이 붙지 않는다
    assert_eq!(decide_usage(&UsageFacts { opened_by_tool: false, ..tool }).target, RunTarget::None);
    // 앞서 닫힌 실행의 시간 안에 드는 요청은 그쪽 몫이다
    assert_eq!(decide_usage(&UsageFacts { in_closed_run: true, ..tool }).target, RunTarget::Closed);
    // 열린 실행이 없으면 붙일 곳이 없다
    assert_eq!(decide_usage(&UsageFacts { open_run: false, ..tool }).target, RunTarget::None);
}

#[test]
fn stall_table() {
    let open = StallFacts { open_run: true, notified: false, idle_ms: 10_000, stall_ms: 8_000, nudge_max: 0, nudges_sent: 0, human_turn: false, cli_at_input: false };
    assert_eq!(decide_stall(&StallFacts { open_run: false, ..open }), StallStep::Stop);
    assert_eq!(decide_stall(&StallFacts { notified: true, ..open }), StallStep::Nothing);
    assert_eq!(decide_stall(&StallFacts { idle_ms: 7_999, ..open }), StallStep::Nothing);
    assert_eq!(decide_stall(&StallFacts { idle_ms: 8_000, ..open }), StallStep::Notify);
    assert_eq!(decide_stall(&open), StallStep::Notify);
    // 시계가 거꾸로 갔으면 알리지 않는다(알리기만 하는 판정이라 모르면 조용히 둔다)
    assert_eq!(decide_stall(&StallFacts { idle_ms: -5, ..open }), StallStep::Nothing);
    // 열린 실행이 없으면 이미 알렸어도 멈춘다
    assert_eq!(decide_stall(&StallFacts { open_run: false, notified: true, ..open }), StallStep::Stop);
}

#[test]
fn stall_interval_is_a_quarter_with_one_second_floor() {
    assert_eq!(stall_interval_ms(120_000), 30_000);
    assert_eq!(stall_interval_ms(8_000), 2_000);
    assert_eq!(stall_interval_ms(1_000), 1_000);
    assert_eq!(stall_interval_ms(3_000), 1_000);
    assert_eq!(stall_interval_ms(0), 1_000);
}

#[test]
fn silence_table() {
    let silent = SilenceFacts { cli_sends_usage: true, telemetry_seen: false, write_hooks: 11, elapsed_ms: 30_000, silent_before: false };
    assert_eq!(decide_silence(&silent), Silence::Silent);
    assert_eq!(decide_silence(&SilenceFacts { telemetry_seen: true, ..silent }), Silence::Fine);
    assert_eq!(decide_silence(&SilenceFacts { cli_sends_usage: false, ..silent }), Silence::Fine);
    assert_eq!(decide_silence(&SilenceFacts { write_hooks: 10, ..silent }), Silence::Fine);
    assert_eq!(decide_silence(&SilenceFacts { elapsed_ms: 29_999, ..silent }), Silence::Fine);
    // 시간을 알 수 없으면 시간 조건은 지난 것으로 본다
    assert_eq!(decide_silence(&SilenceFacts { elapsed_ms: -1, ..silent }), Silence::Silent);
    assert_eq!(decide_silence(&SilenceFacts { elapsed_ms: -1, write_hooks: 10, ..silent }), Silence::Fine);
    // 앞서 끊김을 본 세션: 새 실행의 첫 쓰기부터 막는다. 소식을 받았거나 보내지 않는 CLI면 막지 않는다
    let fresh = SilenceFacts { write_hooks: 1, elapsed_ms: 0, silent_before: true, ..silent };
    assert_eq!(decide_silence(&fresh), Silence::Silent);
    assert_eq!(decide_silence(&SilenceFacts { telemetry_seen: true, ..fresh }), Silence::Fine);
    assert_eq!(decide_silence(&SilenceFacts { cli_sends_usage: false, ..fresh }), Silence::Fine);
}

#[test]
fn every_fact_combination_follows_the_documented_order() {
    // 사실 조합 전체(2^9)에서 결정이 표의 규칙과 같다
    for bits in 0..(1u32 << 9) {
        let b = |i: u32| bits & (1 << i) != 0;
        let f = UsageFacts { has_request_id: b(0), counted: b(1), attached: b(2), open_run: b(3), in_open_window: b(4), in_early_slack: b(5), opened_by_tool: b(6), in_closed_run: b(7), in_closed_late: b(8) };
        let step = decide_usage(&f);
        assert_eq!(step.count, !f.has_request_id || !f.counted);
        assert_eq!(step.check_limits, step.count);
        assert_eq!(step.count_turn, step.target == RunTarget::Open);
        if step.target != RunTarget::None {
            assert!(!(f.has_request_id && f.attached));
        }
        if f.open_run && f.in_open_window && !(f.has_request_id && f.attached) {
            assert_eq!(step.target, RunTarget::Open);
        }
    }
}

#[test]
fn only_a_request_attached_to_the_open_run_marks_telemetry_seen() {
    // 열린 실행에 붙은 것만 소식으로 센다. 닫힌 실행의 늦은 사용량·창 밖·중복은 새 실행의 끊김 판정을 끄지 않는다
    assert!(decide_usage(&UsageFacts { open_run: true, in_open_window: true, ..facts() }).marks_telemetry_seen());
    assert!(!decide_usage(&UsageFacts { open_run: true, in_closed_late: true, ..facts() }).marks_telemetry_seen());
    assert!(!decide_usage(&UsageFacts { open_run: true, ..facts() }).marks_telemetry_seen());
    assert!(!decide_usage(&UsageFacts { open_run: true, in_open_window: true, attached: true, ..facts() }).marks_telemetry_seen());
    assert!(!decide_usage(&facts()).marks_telemetry_seen());
}

#[test]
fn stall_nudge_table() {
    let on = StallFacts { open_run: true, notified: false, idle_ms: 10_000, stall_ms: 8_000, nudge_max: 1, nudges_sent: 0, human_turn: false, cli_at_input: true };
    // 꺼짐(상한 0)이 기본: 정체해도 알리기만 한다
    assert_eq!(decide_stall(&StallFacts { nudge_max: 0, ..on }), StallStep::Notify);
    // 켜면 정체 시간에 닿았을 때 한 번 재촉한다
    assert_eq!(decide_stall(&on), StallStep::Nudge);
    assert_eq!(decide_stall(&StallFacts { idle_ms: 7_999, ..on }), StallStep::Nothing);
    assert_eq!(decide_stall(&StallFacts { idle_ms: -5, ..on }), StallStep::Nothing);
    // 상한에 닿았으면 알리기만 한다(그래도 멈춰 있으면 지금처럼)
    assert_eq!(decide_stall(&StallFacts { nudges_sent: 1, ..on }), StallStep::Notify);
    assert_eq!(decide_stall(&StallFacts { nudge_max: 3, nudges_sent: 2, ..on }), StallStep::Nudge);
    assert_eq!(decide_stall(&StallFacts { nudge_max: 3, nudges_sent: 3, ..on }), StallStep::Notify);
    assert_eq!(decide_stall(&StallFacts { nudge_max: 3, nudges_sent: 9, ..on }), StallStep::Notify);
    // 사람 차례(권한 요청·질문·입력 대기)에는 보내지 않고 알리기만 한다
    assert_eq!(decide_stall(&StallFacts { human_turn: true, ..on }), StallStep::Notify);
    // 입력창에 있다는 긍정 신호가 없으면(도구 실행 중·권한 창·모름) 보내지 않고 알리기만 한다
    assert_eq!(decide_stall(&StallFacts { cli_at_input: false, ..on }), StallStep::Notify);
    // 열린 실행이 없으면 보내지 않고 감시를 멈춘다
    assert_eq!(decide_stall(&StallFacts { open_run: false, ..on }), StallStep::Stop);
    // 이미 알렸으면 더 하지 않는다
    assert_eq!(decide_stall(&StallFacts { notified: true, ..on }), StallStep::Nothing);
}
