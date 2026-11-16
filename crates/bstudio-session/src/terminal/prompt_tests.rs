use super::*;

fn prompt() -> PromptFacts {
    PromptFacts { open_run: false, run_read_only: false, prompt_read_only: false, busy: false, slash: false, budget: false }
}

fn tool() -> PreToolFacts {
    PreToolFacts { read_tool: false, budget: false, access: RunAccess::Got, read_only: false, limit: Limit::None, out_of_scope: false, closed: false }
}

#[test]
fn prompt_table() {
    use PromptBlock::*;
    use PromptDecision::*;
    let cases: Vec<(PromptFacts, PromptDecision)> = vec![
        (prompt(), Open),
        // 열린 실행이 있으면 다른 사실은 보지 않고 이어 붙는다(바쁨·한도·`/`도)
        (PromptFacts { open_run: true, ..prompt() }, Attach { mark_read_only: false, read_only: false }),
        (PromptFacts { open_run: true, busy: true, slash: true, budget: true, ..prompt() }, Attach { mark_read_only: false, read_only: false }),
        // 이어 붙는 실행이 읽기만이면 풀리지 않는다. 표시 없는 요청이 이어 와도 읽기만이다
        (PromptFacts { open_run: true, run_read_only: true, ..prompt() }, Attach { mark_read_only: false, read_only: true }),
        // 읽기만 요청이 이어 오면 그 실행에 읽기만을 켠다
        (PromptFacts { open_run: true, prompt_read_only: true, ..prompt() }, Attach { mark_read_only: true, read_only: true }),
        (PromptFacts { open_run: true, run_read_only: true, prompt_read_only: true, ..prompt() }, Attach { mark_read_only: true, read_only: true }),
        // 열린 실행이 없을 때: 바쁨 → `/` → 한도 → 열기
        (PromptFacts { busy: true, ..prompt() }, Block(Busy)),
        (PromptFacts { busy: true, slash: true, budget: true, ..prompt() }, Block(Busy)),
        (PromptFacts { slash: true, ..prompt() }, Nothing),
        (PromptFacts { slash: true, budget: true, ..prompt() }, Nothing),
        (PromptFacts { budget: true, ..prompt() }, Block(Budget)),
        // 열린 실행이 없으면 읽기만 사실은 쓰이지 않는다(새 실행이 요청 글로 정한다)
        (PromptFacts { run_read_only: true, prompt_read_only: true, ..prompt() }, Open),
    ];
    for (facts, want) in cases {
        assert_eq!(decide_prompt(&facts), want, "{facts:?}");
    }
}

#[test]
fn pre_tool_table() {
    use DenyKind::*;
    use PreToolDecision::*;
    let cases: Vec<(PreToolFacts, PreToolDecision)> = vec![
        (tool(), Allow),
        // 읽기 도구는 다른 사실을 보지 않고 허용한다
        (PreToolFacts { read_tool: true, budget: true, access: RunAccess::Busy, read_only: true, limit: Limit::Budget, out_of_scope: true, closed: true }, Allow),
        (PreToolFacts { budget: true, ..tool() }, Deny(Budget)),
        (PreToolFacts { access: RunAccess::Busy, ..tool() }, Deny(Busy)),
        (PreToolFacts { read_only: true, ..tool() }, Deny(ReadOnly)),
        (PreToolFacts { limit: Limit::MaxTurns, ..tool() }, Deny(MaxTurns)),
        (PreToolFacts { limit: Limit::Budget, ..tool() }, Deny(RunBudget)),
        (PreToolFacts { limit: Limit::Unknown, ..tool() }, Deny(Unknown)),
        (PreToolFacts { out_of_scope: true, ..tool() }, Deny(OutOfScope)),
        (PreToolFacts { closed: true, ..tool() }, Deny(Closed)),
    ];
    for (facts, want) in cases {
        assert_eq!(decide_pre_tool(&facts), want, "{facts:?}");
    }
}

#[test]
fn pre_tool_order_first_match_wins() {
    use DenyKind::*;
    use PreToolDecision::Deny;
    let all = PreToolFacts { read_tool: false, budget: true, access: RunAccess::Busy, read_only: true, limit: Limit::MaxTurns, out_of_scope: true, closed: true };
    // 칸을 하나씩 빼며 다음 칸이 이기는지 본다
    let steps: Vec<(fn(&mut PreToolFacts), DenyKind)> = vec![
        (|f| f.budget = false, Busy),
        (|f| f.access = RunAccess::Got, Closed),
        (|f| f.closed = false, ReadOnly),
        (|f| f.read_only = false, MaxTurns),
        (|f| f.limit = Limit::None, OutOfScope),
    ];
    let mut facts = all;
    assert_eq!(decide_pre_tool(&facts), Deny(Budget));
    for (clear, want) in steps {
        clear(&mut facts);
        assert_eq!(decide_pre_tool(&facts), Deny(want), "{facts:?}");
    }
    facts.out_of_scope = false;
    assert_eq!(decide_pre_tool(&facts), PreToolDecision::Allow);
}

#[test]
fn pre_tool_allows_only_when_every_fact_is_clear() {
    // 거절 사실 여섯 칸의 모든 조합(2^6)을 돌려, 읽기 도구가 아니면 하나라도 켜진 조합은 거절이고 모두 꺼진 조합만 허용이다
    for bits in 0u32..64 {
        let facts = PreToolFacts {
            read_tool: false,
            budget: bits & 1 != 0,
            access: if bits & 2 != 0 { RunAccess::Busy } else { RunAccess::Got },
            read_only: bits & 4 != 0,
            limit: if bits & 8 != 0 { Limit::MaxTurns } else { Limit::None },
            out_of_scope: bits & 16 != 0,
            closed: bits & 32 != 0,
        };
        let allowed = decide_pre_tool(&facts) == PreToolDecision::Allow;
        assert_eq!(allowed, bits == 0, "{facts:?}");
    }
}

#[test]
fn limit_parse_denies_unknown() {
    assert_eq!(Limit::parse(""), Limit::None);
    assert_eq!(Limit::parse("none"), Limit::None);
    assert_eq!(Limit::parse("max_turns"), Limit::MaxTurns);
    assert_eq!(Limit::parse("budget"), Limit::Budget);
    for unknown in ["MAX_TURNS", "max_turns ", "turns", "0", "null", "undefined"] {
        assert_eq!(Limit::parse(unknown), Limit::Unknown, "{unknown:?}");
        assert_eq!(decide_pre_tool(&PreToolFacts { limit: Limit::parse(unknown), ..tool() }), PreToolDecision::Deny(DenyKind::Unknown));
    }
}

#[test]
fn check_changes_only_for_prompt_opened_build_runs() {
    assert!(takes_check_changes(true, false, true));
    // 도구 호출이 연 실행은 가져가지 않는다
    assert!(!takes_check_changes(false, false, true));
    // 읽기만은 남겨 둔다
    assert!(!takes_check_changes(true, true, true));
    // 켜 두지 않았으면 가져갈 것이 없다
    assert!(!takes_check_changes(true, false, false));
}

#[test]
fn deny_kind_names_are_distinct() {
    use DenyKind::*;
    let names: Vec<&str> = [Budget, Busy, ReadOnly, MaxTurns, RunBudget, OutOfScope, Closed, Unknown].iter().map(|kind| kind.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), names.len());
}
