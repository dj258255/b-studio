use super::*;

fn err() -> ErrorFacts {
    ErrorFacts { stopped: false, landed: Landed::No, run_cancelled: false, deadline_exceeded: false, boot_platform_failure: false }
}

#[test]
fn landed_requires_the_commit_to_be_head() {
    assert_eq!(landed_state(None, HeadRead::Sha("a")), Landed::No);
    assert_eq!(landed_state(None, HeadRead::Failed), Landed::No);
    assert_eq!(landed_state(Some("a"), HeadRead::Sha("a")), Landed::Yes);
    assert_eq!(landed_state(Some("a"), HeadRead::Sha("b")), Landed::No);
    assert_eq!(landed_state(Some("a"), HeadRead::Empty), Landed::No);
    // 읽지 못하면 남았다고 보지 않는다(확인한 것만 받아들인다)
    assert_eq!(landed_state(Some("a"), HeadRead::Failed), Landed::Unknown);
}

#[test]
fn error_close_table() {
    use ErrorClose::*;
    let cases: Vec<(&str, ErrorFacts, ErrorClose)> = vec![
        ("기본은 오류", err(), Failure { landed_unknown: false }),
        ("멈춤이 먼저", ErrorFacts { stopped: true, landed: Landed::Yes, run_cancelled: true, deadline_exceeded: true, boot_platform_failure: true }, Stopped),
        ("남은 체크포인트가 취소보다 먼저", ErrorFacts { landed: Landed::Yes, run_cancelled: true, ..err() }, KeepLanded),
        ("남은 체크포인트가 플랫폼 실패보다 먼저", ErrorFacts { landed: Landed::Yes, boot_platform_failure: true, ..err() }, KeepLanded),
        ("취소가 시간 상한보다 먼저", ErrorFacts { run_cancelled: true, deadline_exceeded: true, ..err() }, Cancelled),
        ("취소가 플랫폼 실패보다 먼저", ErrorFacts { run_cancelled: true, boot_platform_failure: true, ..err() }, Cancelled),
        ("시간 상한이 플랫폼 실패보다 먼저", ErrorFacts { deadline_exceeded: true, boot_platform_failure: true, ..err() }, Deadline),
        ("플랫폼 실패", ErrorFacts { boot_platform_failure: true, ..err() }, Platform),
        ("남았는지 읽지 못하면 남았다고 보지 않는다", ErrorFacts { landed: Landed::Unknown, ..err() }, Failure { landed_unknown: true }),
        ("읽지 못해도 취소는 취소다", ErrorFacts { landed: Landed::Unknown, run_cancelled: true, ..err() }, Cancelled),
        ("읽지 못해도 플랫폼 실패는 플랫폼 실패다", ErrorFacts { landed: Landed::Unknown, boot_platform_failure: true, ..err() }, Platform),
    ];
    for (name, facts, expected) in cases {
        assert_eq!(decide_turn_end_error(&facts), expected, "{name}");
    }
}

#[test]
fn error_close_opens_only_for_confirmed_facts() {
    // 여는 칸(되돌리지 않는 칸)은 확인한 사실에서만 선다: 모든 조합에서 확인한 사실이 하나도 없으면 되돌리는 칸이다
    let bools = [false, true];
    for stopped in bools {
        for run_cancelled in bools {
            for deadline in bools {
                for platform in bools {
                    for landed in [Landed::No, Landed::Yes, Landed::Unknown] {
                        let facts = ErrorFacts { stopped, landed, run_cancelled, deadline_exceeded: deadline, boot_platform_failure: platform };
                        let close = decide_turn_end_error(&facts);
                        let keeps = matches!(close, ErrorClose::Stopped | ErrorClose::KeepLanded | ErrorClose::Platform);
                        let confirmed = stopped || landed == Landed::Yes || (platform && !run_cancelled && !deadline);
                        assert_eq!(keeps, confirmed, "{facts:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn saving_and_reattach_conditions() {
    for has in [false, true] {
        for attached in [false, true] {
            for closed in [false, true] {
                assert_eq!(saving_accepts(has, attached, closed), has && !attached && !closed);
            }
        }
    }
    for has in [false, true] {
        for closed in [false, true] {
            assert_eq!(should_reattach(has, closed), !has && !closed);
        }
    }
}

#[test]
fn save_failure_steps() {
    assert_eq!(decide_save_failure(SaveFailure::parse("head_moved")), SaveStep::ReconcileThenRethrow);
    assert_eq!(decide_save_failure(SaveFailure::parse("staged_mismatch")), SaveStep::RetryMoved);
    assert_eq!(decide_save_failure(SaveFailure::parse("other")), SaveStep::Rethrow);
    assert_eq!(decide_save_failure(SaveFailure::parse("")), SaveStep::Rethrow);
}

fn stage() -> GateStageFacts {
    GateStageFacts { deadline_exceeded: false, pause_failed: false, rejected: Probe::Clear, gate: GateRead::Pass, moved: Probe::Clear, done_tests: Probe::Clear }
}

#[test]
fn gate_stage_table() {
    use GateStageStep::*;
    let cases: Vec<(&str, GateStageFacts, GateStageStep)> = vec![
        ("전부 확인되면 통과", stage(), Final(StageFinal::Pass)),
        ("시간 상한이 모든 것보다 먼저", GateStageFacts { deadline_exceeded: true, pause_failed: true, rejected: Probe::Found, ..stage() }, Final(StageFinal::Deadline)),
        ("통과 결과가 있어도 상한 뒤면 통과가 아니다", GateStageFacts { deadline_exceeded: true, ..stage() }, Final(StageFinal::Deadline)),
        ("멈추지 못했으면 읽지 않고 돌려보낸다", GateStageFacts { pause_failed: true, rejected: Probe::Unread, ..stage() }, Final(StageFinal::Unsettled(Unsettled::PauseFailed))),
        ("거절된 경로를 읽지 않았으면 읽는다", GateStageFacts { rejected: Probe::Unread, gate: GateRead::Unread, ..stage() }, NeedRejected),
        ("거절된 경로가 있으면 게이트를 돌리지 않는다", GateStageFacts { rejected: Probe::Found, gate: GateRead::Unread, ..stage() }, Final(StageFinal::Unsettled(Unsettled::Rejected))),
        ("게이트를 돌리지 않았으면 돌린다", GateStageFacts { gate: GateRead::Unread, ..stage() }, NeedGate),
        ("게이트가 돌려보내면 그 결과", GateStageFacts { gate: GateRead::Retry, moved: Probe::Unread, ..stage() }, Final(StageFinal::Gate(GateRead::Retry))),
        ("게이트가 소진하면 그 결과", GateStageFacts { gate: GateRead::Exhausted, ..stage() }, Final(StageFinal::Gate(GateRead::Exhausted))),
        ("알아보지 못한 결과는 통과가 아니다", GateStageFacts { gate: GateRead::Unknown, ..stage() }, Final(StageFinal::Gate(GateRead::Unknown))),
        ("통과면 뒤 지문을 읽는다", GateStageFacts { moved: Probe::Unread, done_tests: Probe::Unread, ..stage() }, NeedMoved),
        ("통과 뒤 바뀐 것이 있으면 돌려보낸다", GateStageFacts { moved: Probe::Found, done_tests: Probe::Unread, ..stage() }, Final(StageFinal::Unsettled(Unsettled::Moved))),
        ("완료 검사를 읽지 않았으면 읽는다", GateStageFacts { done_tests: Probe::Unread, ..stage() }, NeedDoneTests),
        ("완료 검사가 실패하면 돌려보낸다", GateStageFacts { done_tests: Probe::Found, ..stage() }, Final(StageFinal::Unsettled(Unsettled::DoneTestsFailed))),
    ];
    for (name, facts, expected) in cases {
        assert_eq!(decide_gate_stage(&facts), expected, "{name}");
    }
}

#[test]
fn pass_needs_every_fact_confirmed() {
    let probes = [Probe::Unread, Probe::Clear, Probe::Found];
    let gates = [GateRead::Unread, GateRead::Pass, GateRead::Retry, GateRead::Exhausted, GateRead::Unknown];
    for deadline in [false, true] {
        for pause in [false, true] {
            for rejected in probes {
                for gate in gates {
                    for moved in probes {
                        for done in probes {
                            let facts = GateStageFacts { deadline_exceeded: deadline, pause_failed: pause, rejected, gate, moved, done_tests: done };
                            let passes = decide_gate_stage(&facts) == GateStageStep::Final(StageFinal::Pass);
                            let confirmed = !deadline && !pause && rejected == Probe::Clear && gate == GateRead::Pass && moved == Probe::Clear && done == Probe::Clear;
                            assert_eq!(passes, confirmed, "{facts:?}");
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn deadline_is_before_the_hook_limit() {
    assert_eq!(gate_deadline_ms(3600), 3300 * 1000);
    assert_eq!(gate_deadline_ms(301), 1000);
    // 훅 상한이 여유 이하이면 절반(0이 되지 않는다)
    assert_eq!(gate_deadline_ms(300), 150 * 1000);
    assert_eq!(gate_deadline_ms(1), 1000);
    assert_eq!(gate_deadline_ms(0), 1000);
    for hook in 0..5000 {
        assert!(gate_deadline_ms(hook) >= 1000);
        assert!(gate_deadline_ms(hook) <= u64::from(hook.max(1)) * 1000);
    }
}

#[test]
fn parse_unknown_text_is_closed() {
    assert_eq!(Probe::parse("bogus"), Probe::Found);
    assert_eq!(GateRead::parse("bogus"), GateRead::Unknown);
}
