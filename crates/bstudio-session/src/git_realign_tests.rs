use super::*;

fn facts<'a>(head: &'a str, branch: Option<&'a str>, ancestor: Option<bool>, allow_unwind: bool) -> RealignFacts<'a> {
    RealignFacts { remembered_head: "r", remembered_branch: "main", head, branch, ancestor, allow_unwind }
}

#[test]
fn realign_table() {
    use Realign::*;
    use RealignStep::*;
    use Reason::*;
    let cases: Vec<(&str, RealignFacts, RealignStep)> = vec![
        ("같음", facts("r", Some("main"), None, true), Done(Same)),
        ("같음은 풀기 허용과 상관없다", facts("r", Some("main"), None, false), Done(Same)),
        ("분리된 HEAD", facts("r", None, None, true), Done(Restore(Detached))),
        ("분리된 HEAD는 다른 커밋이어도 같다", facts("x", None, Some(true), true), Done(Restore(Detached))),
        ("브랜치가 바뀜(HEAD는 같음)", facts("r", Some("other"), None, true), Done(Restore(BranchChanged))),
        ("브랜치가 바뀜(조상 위)", facts("x", Some("other"), Some(true), true), Done(Restore(BranchChanged))),
        ("같은 브랜치에서 HEAD만 다르면 조상을 읽는다", facts("x", Some("main"), None, true), NeedAncestor),
        ("조상 위의 커밋은 풀 수 있으면 푼다", facts("x", Some("main"), Some(true), true), Done(Unwind)),
        ("조상 위의 커밋도 풀 수 없으면 되돌린다", facts("x", Some("main"), Some(true), false), Done(Restore(ForeignCommits))),
        ("조상이 아니면 되감김", facts("x", Some("main"), Some(false), true), Done(Restore(Rewound))),
        ("조상이 아니면 풀기를 허용하지 않아도 같다", facts("x", Some("main"), Some(false), false), Done(Restore(Rewound))),
        ("머리를 읽지 못해 빈 글이면 되돌린다(같지 않다)", facts("", Some("main"), Some(false), true), Done(Restore(Rewound))),
    ];
    for (name, f, expected) in cases {
        assert_eq!(decide_realign(&f), expected, "{name}");
    }
}

#[test]
fn only_exact_match_is_same() {
    // 여는 쪽(기억을 믿는다)은 글자까지 같을 때만 선다
    for (head, branch) in [("R", Some("main")), ("r ", Some("main")), ("r", Some("Main")), ("r", Some("main/")), ("r", None), ("", Some("main"))] {
        assert!(!is_aligned("r", "main", head, branch), "{head:?} {branch:?}");
    }
    assert!(is_aligned("r", "main", "r", Some("main")));
}

#[test]
fn after_action_needs_a_successful_aligned_read() {
    assert_eq!(after_action("r", "main", Some(("r", Some("main")))), After::Aligned);
    assert_eq!(after_action("r", "main", Some(("r", Some("agent")))), After::Moved);
    assert_eq!(after_action("r", "main", Some(("x", Some("main")))), After::Moved);
    assert_eq!(after_action("r", "main", Some(("r", None))), After::Moved);
    // 읽지 못했으면 같다고 보지 않는다
    assert_eq!(after_action("r", "main", None), After::Moved);
}

#[test]
fn remember_prefers_created_and_needs_known_head_and_branch() {
    assert_eq!(decide_remember("h", Some("main"), None), Some(Memory { branch: "main".into(), last_checkpoint: "h".into() }));
    assert_eq!(decide_remember("h", Some("main"), Some("c")), Some(Memory { branch: "main".into(), last_checkpoint: "c".into() }));
    assert_eq!(decide_remember("h", None, Some("c")), None);
    assert_eq!(decide_remember("", Some("main"), Some("c")), None);
    assert_eq!(decide_remember("", Some("main"), None), None);
}

#[test]
fn initial_memory_needs_every_fact() {
    let some = |origin: Option<&str>| Some((Memory { branch: "main".into(), last_checkpoint: "h".into() }, origin.map(str::to_owned)));
    assert_eq!(decide_initial_memory("h", Some("main"), OriginRead::None), some(None));
    assert_eq!(decide_initial_memory("h", Some("main"), OriginRead::Url("git@x:y")), some(Some("git@x:y")));
    assert_eq!(decide_initial_memory("h", Some("main"), OriginRead::Url("")), some(None));
    // 원격 주소를 읽지 못하면 "원격 없음"으로 기억하지 않는다
    assert_eq!(decide_initial_memory("h", Some("main"), OriginRead::Failed), None);
    assert_eq!(decide_initial_memory("h", None, OriginRead::None), None);
    assert_eq!(decide_initial_memory("", Some("main"), OriginRead::None), None);
}

#[test]
fn revert_plan_table() {
    use Aligned::*;
    let plan = |aligned, read_only| plan_revert(&RevertFacts { aligned, read_only });
    assert_eq!(plan(Unrestorable, false), RevertPlan::Fail);
    assert_eq!(plan(Unrestorable, true), RevertPlan::Fail);
    assert_eq!(plan(Restored, false), RevertPlan::AlreadyRestored);
    assert_eq!(plan(Restored, true), RevertPlan::AlreadyRestored);
    assert_eq!(plan(Same, false), RevertPlan::Discard { protect_docs: true });
    assert_eq!(plan(Unwound, false), RevertPlan::Discard { protect_docs: true });
    // 읽기만 요청의 되돌리기는 문서를 지키지 않는다
    assert_eq!(plan(Same, true), RevertPlan::Discard { protect_docs: false });
    assert_eq!(plan(Unwound, true), RevertPlan::Discard { protect_docs: false });
}

#[test]
fn revert_misc_table() {
    assert!(revert_needs_realign(true, true));
    assert!(!revert_needs_realign(true, false));
    assert!(!revert_needs_realign(false, true));
    assert_eq!(remember_after_revert(true, true), RememberAfter::DocsCheckpoint);
    assert_eq!(remember_after_revert(true, false), RememberAfter::DocsCheckpoint);
    assert_eq!(remember_after_revert(false, false), RememberAfter::Reread);
    assert_eq!(remember_after_revert(false, true), RememberAfter::Keep);
    // DB 복원 기준점은 문서를 지키기 전의 체크포인트다
    assert_eq!(db_restore_base("before", Some("docs")), "before");
    assert_eq!(db_restore_base("before", None), "before");
    assert_eq!(revert_tail(true, false, true, false), RevertTail::Nothing);
    assert_eq!(revert_tail(true, false, true, true), RevertTail::Nothing);
    assert_eq!(revert_tail(false, false, true, true), RevertTail::HostOnlyReport);
    assert_eq!(revert_tail(true, true, true, true), RevertTail::HostOnlyReport);
    assert_eq!(revert_tail(true, false, false, false), RevertTail::RestartServices);
    assert_eq!(revert_tail(false, true, false, false), RevertTail::RestartServices);
}

fn v(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn split_without_kept_commits_everything() {
    let split = split_local_edits(&v(&["a.txt", "b/c.txt"]), &[]);
    assert_eq!(split.human, v(&["a.txt", "b/c.txt"]));
    assert!(split.agent.is_empty());
    assert!(split.kept.is_empty());
}

#[test]
fn split_keeps_agent_files_as_changes() {
    let split = split_local_edits(&v(&["a.txt", "human.txt"]), &v(&["a.txt"]));
    assert_eq!(split.human, v(&["human.txt"]));
    assert_eq!(split.agent, v(&["a.txt"]));
    assert_eq!(split.kept, v(&["a.txt"]));
}

#[test]
fn split_drops_entries_that_are_no_longer_pending() {
    let split = split_local_edits(&v(&["human.txt"]), &v(&["gone.txt"]));
    assert_eq!(split.human, v(&["human.txt"]));
    assert!(split.kept.is_empty());
}

#[test]
fn split_matches_names_widely() {
    // 대소문자, 유니코드 정규화(NFD로 적은 한글), 보이지 않는 문자, 끝의 점, 역슬래시, 겹친 구분자, 폴더 관계
    let kept = v(&["Api/Src/Order.java", "한글.txt"]);
    for pending in ["api/src/order.java", "api/src/Order.java.", "api/src/Order\u{200b}.java", "api\\src\\Order.java", "api//src/Order.java", "api/./src/Order.java"] {
        let split = split_local_edits(&v(&[pending]), &kept);
        assert_eq!(split.agent, v(&[pending]), "{pending}");
    }
    // NFD 한글
    let nfd: String = "한글.txt".chars().flat_map(|c| unicode_normalization::UnicodeNormalization::nfd(std::iter::once(c)).collect::<Vec<_>>()).collect();
    assert_eq!(split_local_edits(&[nfd.clone()], &kept).agent, vec![nfd]);
    // 폴더가 같은 파일로 바뀌거나 그 반대
    assert_eq!(split_local_edits(&v(&["x/y"]), &v(&["x"])).agent, v(&["x/y"]));
    assert_eq!(split_local_edits(&v(&["x"]), &v(&["x/y"])).agent, v(&["x"]));
    // 이름이 이어져 보이기만 하는 다른 파일은 맞지 않는다
    assert_eq!(split_local_edits(&v(&["xy"]), &v(&["x"])).human, v(&["xy"]));
}

#[test]
fn unknown_entry_matches_every_file() {
    let split = split_local_edits(&v(&["a", "b/c"]), &v(&[UNKNOWN_ENTRY]));
    assert!(split.human.is_empty());
    assert_eq!(split.agent, v(&["a", "b/c"]));
    assert_eq!(split.kept, v(&[UNKNOWN_ENTRY]));
    // 바뀐 파일이 없으면 항목도 지운다
    assert!(split_local_edits(&[], &v(&[UNKNOWN_ENTRY])).kept.is_empty());
    // 이름을 알아볼 수 없는 기억(절대 경로·빈 이름·NUL)도 모든 파일과 맞는다
    for odd in ["/etc/passwd", "", "a\0b", "../x"] {
        assert!(split_local_edits(&v(&["a"]), &v(&[odd])).human.is_empty(), "{odd:?}");
    }
}

#[test]
fn unreadable_pending_names_go_to_the_gate() {
    for odd in ["../x", "/abs", "a\0b"] {
        let split = split_local_edits(&v(&[odd]), &v(&["z"]));
        // 이름을 알아볼 수 없는 파일은 어느 항목과도 맞는 것으로 본다
        assert_eq!(split.agent, v(&[odd]), "{odd:?}");
    }
}

#[test]
fn merge_kept_dedups_and_sorts() {
    assert_eq!(merge_kept(&v(&["b", "a"]), &v(&["a", "c"])), v(&["a", "b", "c"]));
    assert!(merge_kept(&[], &[]).is_empty());
}
