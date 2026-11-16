use super::*;

fn facts() -> TurnEndFacts {
    TurnEndFacts {
        closed: false,
        pending_violation: false,
        violation: false,
        read_only: false,
        read_only_after_work: false,
        git: GitCheck::Aligned,
        fingerprint: Fingerprint::Same,
        verification: false,
        unchanged: Unchanged::No,
        done_tests: false,
        has_card: false,
        card: CardScope::Inside,
        unsettled_attempts: 0,
        gate_attempts: 0,
        max_attempts: 3,
    }
}

fn gate() -> GateFacts {
    GateFacts { path: GatePath::Gate, outcome: GateKind::Pass, cancelled: false, max_turns_limit: false, violation: false, unsettled_attempts: 0, gate_attempts: 0, max_attempts: 3 }
}

#[test]
fn turn_end_table() {
    use TurnEndStep::*;
    let cases: Vec<(&str, TurnEndFacts, TurnEndStep)> = vec![
        ("기본은 게이트", facts(), RunGate),
        ("닫힌 실행은 아무것도 하지 않는다(다른 사실을 보지 않는다)", TurnEndFacts { closed: true, pending_violation: true, violation: true, ..facts() }, Nothing),
        ("미룬 위반은 위반보다 먼저", TurnEndFacts { pending_violation: true, violation: true, ..facts() }, FailPendingViolation),
        ("위반은 Git 맞추기보다 먼저(읽지 않는다)", TurnEndFacts { violation: true, git: GitCheck::Unread, ..facts() }, FailViolation),
        ("Git을 읽지 않았으면 읽는다(만들기는 풀 수 있다)", TurnEndFacts { git: GitCheck::Unread, ..facts() }, NeedGit { allow_unwind: true }),
        ("읽기만은 풀지 않는다", TurnEndFacts { git: GitCheck::Unread, read_only: true, ..facts() }, NeedGit { allow_unwind: false }),
        ("앞선 변경이 있는 읽기만도 풀지 않는다(읽기만은 Git을 바꾸지 않는다)", TurnEndFacts { git: GitCheck::Unread, read_only: true, read_only_after_work: true, ..facts() }, NeedGit { allow_unwind: false }),
        ("Git 맞추기가 실행을 닫았다", TurnEndFacts { git: GitCheck::Failed, ..facts() }, GitFailed),
        ("읽기만: 지문을 읽지 않았으면 읽는다", TurnEndFacts { read_only: true, fingerprint: Fingerprint::Unread, ..facts() }, NeedFingerprint),
        ("읽기만: 지문이 같으면 done", TurnEndFacts { read_only: true, ..facts() }, ReadOnlyDone),
        ("읽기만: 지문이 다르면 실패", TurnEndFacts { read_only: true, fingerprint: Fingerprint::Different, ..facts() }, ReadOnlyFail { unverified: false }),
        ("읽기만: 재지 못한 지문은 통과가 아니다", TurnEndFacts { read_only: true, fingerprint: Fingerprint::Unknown, ..facts() }, ReadOnlyFail { unverified: true }),
        ("읽기만은 바뀐 것 없음·완료 검사·카드를 보지 않는다", TurnEndFacts { read_only: true, unchanged: Unchanged::Unread, has_card: true, card: CardScope::Outside, ..facts() }, ReadOnlyDone),
        ("앞선 변경이 있는 읽기만: 지문을 읽지 않았으면 읽는다", TurnEndFacts { read_only: true, read_only_after_work: true, verification: true, fingerprint: Fingerprint::Unread, ..facts() }, NeedFingerprint),
        ("앞선 변경이 있는 읽기만: 지문이 같으면 일반 칸으로 가서 앞선 변경이 게이트를 지난다(S6)", TurnEndFacts { read_only: true, read_only_after_work: true, verification: true, fingerprint: Fingerprint::Same, ..facts() }, RunGate),
        ("앞선 변경이 있는 읽기만: 읽기만이 켜진 뒤 바뀌었으면 실패", TurnEndFacts { read_only: true, read_only_after_work: true, verification: true, fingerprint: Fingerprint::Different, ..facts() }, ReadOnlyFail { unverified: false }),
        ("앞선 변경이 있는 읽기만: 재지 못한 지문은 통과가 아니다", TurnEndFacts { read_only: true, read_only_after_work: true, verification: true, fingerprint: Fingerprint::Unknown, ..facts() }, ReadOnlyFail { unverified: true }),
        ("앞선 변경이 있는 읽기만도 위반은 먼저 본다", TurnEndFacts { read_only: true, read_only_after_work: true, violation: true, ..facts() }, FailViolation),
        ("바뀐 것을 읽지 않았으면 읽는다", TurnEndFacts { unchanged: Unchanged::Unread, ..facts() }, NeedUnchanged),
        ("바뀐 것 없음 + 기준 없음 + 완료 검사 없음", TurnEndFacts { unchanged: Unchanged::Yes, ..facts() }, SettleUnchanged),
        ("바뀐 것 없음 + 기준 없음 + 완료 검사 있음", TurnEndFacts { unchanged: Unchanged::Yes, done_tests: true, ..facts() }, RunDoneTests),
        ("바뀐 것 없어도 기준이 있으면 지름길이 아니다", TurnEndFacts { unchanged: Unchanged::Yes, verification: true, done_tests: true, ..facts() }, RunGate),
        ("바뀐 것을 읽지 못했으면 바뀐 것 없음으로 보지 않는다", TurnEndFacts { unchanged: Unchanged::Unknown, ..facts() }, RunGate),
        ("카드 범위를 읽지 않았으면 읽는다", TurnEndFacts { has_card: true, card: CardScope::Unread, ..facts() }, NeedCardScope),
        ("카드가 없으면 범위를 읽지 않는다", TurnEndFacts { has_card: false, card: CardScope::Unread, ..facts() }, RunGate),
        ("카드 범위 밖이면 돌려보낸다", TurnEndFacts { has_card: true, card: CardScope::Outside, ..facts() }, CardRetry),
        ("카드 범위 밖 + 이번이 상한", TurnEndFacts { has_card: true, card: CardScope::Outside, unsettled_attempts: 2, ..facts() }, CardExhausted),
        ("카드 범위 밖 + 게이트가 센 횟수를 합쳐 상한(S12)", TurnEndFacts { has_card: true, card: CardScope::Outside, unsettled_attempts: 1, gate_attempts: 1, ..facts() }, CardExhausted),
        ("카드 범위 안", TurnEndFacts { has_card: true, ..facts() }, RunGate),
    ];
    for (name, facts, want) in cases {
        assert_eq!(decide_turn_end(&facts), want, "{name}: {facts:?}");
    }
}

#[test]
fn unknown_text_is_the_closed_value() {
    assert_eq!(GitCheck::parse("bogus"), GitCheck::Failed);
    assert_eq!(GitCheck::parse(""), GitCheck::Failed);
    assert_eq!(Fingerprint::parse("bogus"), Fingerprint::Unknown);
    assert_eq!(Unchanged::parse("bogus"), Unchanged::Unknown);
    assert_eq!(CardScope::parse("bogus"), CardScope::Outside);
    assert_eq!(GateKind::parse("bogus"), GateKind::Unknown);
    assert_eq!(GatePath::parse("bogus"), GatePath::Gate);
}

#[test]
fn gate_outcome_table() {
    use GateStep::*;
    let retry = GateFacts { outcome: GateKind::Retry, ..gate() };
    let cases: Vec<(&str, GateFacts, GateStep)> = vec![
        ("통과", gate(), Pass),
        ("통과 + 위반", GateFacts { violation: true, ..gate() }, FailViolation),
        ("취소는 무엇보다 먼저", GateFacts { cancelled: true, violation: true, max_turns_limit: true, outcome: GateKind::Retry, ..gate() }, ThrowCancel),
        ("재시도", retry, Retry),
        ("재시도 + 위반은 위반을 보지 않는다(옛 순서)", GateFacts { violation: true, ..retry }, Retry),
        ("재시도 + 턴 상한은 소진", GateFacts { max_turns_limit: true, ..retry }, Exhaust { max_turns: true, attempts: false }),
        ("통과 + 턴 상한은 그대로 통과", GateFacts { max_turns_limit: true, ..gate() }, Pass),
        ("소진은 소진", GateFacts { outcome: GateKind::Exhausted, ..gate() }, Exhaust { max_turns: false, attempts: false }),
        ("게이트 밖 사유로 센 횟수가 상한", GateFacts { unsettled_attempts: 3, ..retry }, Exhaust { max_turns: false, attempts: true }),
        ("게이트 횟수와 합쳐 상한(S12)", GateFacts { unsettled_attempts: 1, gate_attempts: 2, ..retry }, Exhaust { max_turns: false, attempts: true }),
        ("합쳐도 상한 전이면 재시도", GateFacts { unsettled_attempts: 1, gate_attempts: 1, ..retry }, Retry),
        ("알아보지 못한 결과는 닫는다", GateFacts { outcome: GateKind::Unknown, ..gate() }, Unknown),
        ("완료 검사 길: 통과", GateFacts { path: GatePath::DoneTests, ..gate() }, Pass),
        ("완료 검사 길: 위반은 결과와 무관하게 먼저", GateFacts { path: GatePath::DoneTests, violation: true, outcome: GateKind::Retry, ..gate() }, FailViolation),
        ("완료 검사 길: 취소·턴 상한을 보지 않는다", GateFacts { path: GatePath::DoneTests, cancelled: true, max_turns_limit: true, outcome: GateKind::Retry, ..gate() }, Retry),
        ("완료 검사 길: 알아보지 못한 결과는 닫는다", GateFacts { path: GatePath::DoneTests, outcome: GateKind::Unknown, ..gate() }, Unknown),
        ("완료 검사 길: 소진은 소진", GateFacts { path: GatePath::DoneTests, outcome: GateKind::Exhausted, ..gate() }, Exhaust { max_turns: false, attempts: false }),
        ("완료 검사 길: 상한", GateFacts { path: GatePath::DoneTests, outcome: GateKind::Retry, unsettled_attempts: 3, ..gate() }, Exhaust { max_turns: false, attempts: true }),
    ];
    for (name, facts, want) in cases {
        assert_eq!(decide_gate_outcome(&facts), want, "{name}: {facts:?}");
    }
}

#[test]
fn after_checkpoint() {
    assert_eq!(decide_after_checkpoint(false), SavedStep::Settle);
    assert_eq!(decide_after_checkpoint(true), SavedStep::FailViolation);
}
