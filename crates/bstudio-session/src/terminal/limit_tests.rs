use super::*;

fn facts() -> LimitFacts {
    LimitFacts { reason: LimitReason::None, max_turns: Some(3.0), model_calls: 0, aborted: false }
}

#[test]
fn under_the_cap_nothing_changes_and_budget_is_checked() {
    let step = decide_limit(&LimitFacts { model_calls: 2, ..facts() });
    assert_eq!(step, LimitStep { reason: LimitReason::None, check_budget: true });
}

#[test]
fn reaching_the_cap_sets_max_turns() {
    assert_eq!(decide_limit(&LimitFacts { model_calls: 3, ..facts() }).reason, LimitReason::MaxTurns);
    assert_eq!(decide_limit(&LimitFacts { model_calls: 9, ..facts() }).reason, LimitReason::MaxTurns);
}

#[test]
fn without_a_cap_turns_are_not_looked_at() {
    let step = decide_limit(&LimitFacts { max_turns: None, model_calls: 1_000_000, ..facts() });
    assert_eq!(step, LimitStep { reason: LimitReason::None, check_budget: true });
}

#[test]
fn budget_is_never_replaced_by_turns_and_is_not_checked_again() {
    let step = decide_limit(&LimitFacts { reason: LimitReason::Budget, model_calls: 99, ..facts() });
    assert_eq!(step, LimitStep { reason: LimitReason::Budget, check_budget: false });
}

#[test]
fn max_turns_is_never_released() {
    // 상한이 올라가거나 없어지거나 호출 수가 줄어도 닿은 채다
    for max_turns in [Some(100.0), None, Some(f64::NAN)] {
        let step = decide_limit(&LimitFacts { reason: LimitReason::MaxTurns, max_turns, model_calls: 0, aborted: false });
        assert_eq!(step.reason, LimitReason::MaxTurns, "{max_turns:?}");
        assert!(step.check_budget);
    }
}

#[test]
fn aborting_run_skips_the_budget_check_but_still_records_turns() {
    let step = decide_limit(&LimitFacts { model_calls: 3, aborted: true, ..facts() });
    assert_eq!(step, LimitStep { reason: LimitReason::MaxTurns, check_budget: false });
}

#[test]
fn zero_cap_trips_on_the_first_check_and_nan_cap_never_does() {
    assert_eq!(decide_limit(&LimitFacts { max_turns: Some(0.0), model_calls: 0, ..facts() }).reason, LimitReason::MaxTurns);
    assert_eq!(decide_limit(&LimitFacts { max_turns: Some(f64::NAN), model_calls: 9, ..facts() }).reason, LimitReason::None);
}

#[test]
fn unknown_reason_text_reads_as_max_turns() {
    assert_eq!(LimitReason::parse("none"), LimitReason::None);
    assert_eq!(LimitReason::parse("budget"), LimitReason::Budget);
    assert_eq!(LimitReason::parse("max_turns"), LimitReason::MaxTurns);
    assert_eq!(LimitReason::parse("???"), LimitReason::MaxTurns);
}

#[test]
fn unverifiable_usage_table() {
    // silent는 한도의 종류와 상관없이 확인할 수 없다. 읽지 못한 호출은 토큰 한도가 있을 때만
    for silent in [false, true] {
        for incomplete in [false, true] {
            for limited in [false, true] {
                assert_eq!(usage_unverifiable(silent, incomplete, limited), silent || (incomplete && limited), "{silent} {incomplete} {limited}");
            }
        }
    }
}
