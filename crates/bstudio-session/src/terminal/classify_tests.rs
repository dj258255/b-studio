use super::*;

const MARK: &str = READ_ONLY_MARK;

fn tag(inner: &str) -> String {
    format!("<pasted_content>\n{inner}\n</pasted_content>")
}

fn tag_id(inner: &str, id: &str) -> String {
    format!("<pasted_content id=\"{id}\">\n{inner}\n</pasted_content id=\"{id}\">")
}

#[test]
fn read_only_table() {
    let cases: Vec<(String, bool)> = vec![
        (MARK.to_owned(), true),
        (format!("{MARK} 주문 구조를 설명해줘"), true),
        ("주문 구조를 설명해줘".to_owned(), false),
        (String::new(), false),
        // 앞의 빈칸·보이지 않는 글자는 건너뛴다
        (format!("  \t{MARK} x"), true),
        (format!("\n\r\n{MARK} x"), true),
        (format!("\u{a0}\u{3000}{MARK} x"), true),
        (format!("\u{feff}{MARK} x"), true),
        (format!("\u{200b}\u{200f}{MARK} x"), true),
        (format!("\u{202e}\u{2066}{MARK} x"), true),
        (format!("\u{2060}{MARK} x"), true),
        (format!("\u{2028}{MARK} x"), true),
        // 건너뛰는 글자가 아닌 것: 앞에 글자가 있으면 읽기만이 아니다(옛 규칙과 같다)
        (format!("\u{85}{MARK} x"), false),
        (format!("\u{180e}{MARK} x"), false),
        (format!("\u{ad}{MARK} x"), false),
        (format!("\u{fe0f}{MARK} x"), false),
        (format!("a{MARK} x"), false),
        (format!("설명 {MARK}"), false),
        // 표시가 다른 꼴이면 읽기만이 아니다(셋이 같게 읽는다)
        ("［읽기만］ x".to_owned(), false),
        ("[읽기만］ x".to_owned(), false),
        ("[ 읽기만 ] x".to_owned(), false),
        ("[read-only] x".to_owned(), false),
        ("[읽기만".to_owned(), false),
        // 조합형(NFD) 한글도 같은 글로 본다
        (format!("{} x", "[읽기만]".nfd().collect::<String>()), true),
        // 붙여 넣은 요청
        (tag(&format!("{MARK} x")), true),
        (tag_id(&format!("{MARK} x"), "p1"), true),
        (tag_id(&format!("{MARK} x"), ""), true),
        ("<pasted_content\n  id=\"p1\">\n[읽기만] x\n</pasted_content>".to_owned(), true),
        ("<pasted_content id=\"a>b\">\n[읽기만] x\n</pasted_content id=\"a>b\">".to_owned(), true),
        ("<pasted_content>\r\n[읽기만] x\r\n</pasted_content>".to_owned(), true),
        ("<pasted_content>\r[읽기만] x\r</pasted_content>".to_owned(), true),
        (tag(&tag(&format!("{MARK} x"))), true),
        (tag(&tag(&tag(&format!("{MARK} x")))), true),
        (format!("{}{}", tag(&format!("{MARK} x")), tag("둘째")), true),
        (format!("  {}", tag(&format!("{MARK} x"))), true),
        // 표시를 벗겨도 글이 앞에 남으면 읽기만이 아니다
        (format!("먼저 {}", tag(&format!("{MARK} x"))), false),
        (format!("{}{}", tag("첫째"), tag(&format!("{MARK} x"))), false),
        (format!("{}\n{MARK} x", tag("첫째")), false),
        // 다른 꼴의 표시는 벗기지 않는다
        (format!("<PASTED_CONTENT>\n{MARK} x\n</PASTED_CONTENT>"), false),
        (format!("<pasted_content name=\"x\">\n{MARK} x\n</pasted_content>"), false),
        (format!("<pasted_content id='p1'>\n{MARK} x\n</pasted_content>"), false),
        (format!("<pasted_contentid=\"p1\">\n{MARK} x\n</pasted_content>"), false),
        // 이어 붙은 표시는 벗기면 새 표시가 생긴다: 끝까지 벗긴다(옛 서버는 두 번, 훅 스크립트는 한 번)
        (format!("<pasted_content<pasted_content>>\n{MARK} x"), true),
        (format!("<pasted_content<pasted_content<pasted_content>>>{MARK} x"), true),
        (format!("<pasted_content <pasted_content>id=\"a\">{MARK} x"), true),
        // 슬래시와 섞인 것: 읽기만 판정은 `/`를 보지 않는다
        (format!("/model {MARK}"), false),
        (format!("{MARK} /model"), true),
        (format!("/clear\n{MARK} x"), false),
    ];
    for (text, want) in cases {
        assert_eq!(is_read_only_prompt(&text), want, "{text:?}");
    }
}

#[test]
fn unwrap_depth_is_bounded_and_unknown_is_read_only() {
    // 한 단계에 안쪽 표시 하나씩만 벗겨지는 입력(`<pasted_content` N개 뒤에 `>` N개). 단계 상한을 넘으면 알아보지 못한 입력이라 읽기만이다
    let nested = |depth: usize, tail: &str| format!("{}{}{tail}", "<pasted_content".repeat(depth), ">".repeat(depth));
    assert!(is_read_only_prompt(&nested(200, "그냥 글")));
    // 깊이가 얕으면 정상 판정이다: 끝까지 벗겨 표시가 없으면 읽기만이 아니고, 있으면 읽기만이다
    assert!(!is_read_only_prompt(&nested(10, "그냥 글")));
    assert!(is_read_only_prompt(&nested(10, MARK)));
    assert!(!is_read_only_prompt(&tag(&tag("그냥"))));
}

#[test]
fn unwrap_pasted_matches_the_old_regex() {
    let cases: Vec<(&str, &str)> = vec![
        ("<pasted_content>\nabc\n</pasted_content>", "abc"),
        ("<pasted_content id=\"x\">\nabc\n</pasted_content id=\"x\">", "abc"),
        ("a<pasted_content>b</pasted_content>c", "abc"),
        // 닫는 표시 앞의 줄바꿈은 하나만 지운다
        ("<pasted_content>\n\nabc\n\n</pasted_content>", "\nabc\n"),
        ("<pasted_content>\r\nabc\r\n</pasted_content>", "abc"),
        ("<pasted_content>\rabc\r</pasted_content>", "abc"),
        // 짝이 안 맞아도 각각 지운다
        ("<pasted_content>\nabc", "abc"),
        ("abc\n</pasted_content>", "abc"),
        // 알아보지 못하는 꼴은 그대로
        ("<pasted_content name=\"x\">abc</pasted_content>", "<pasted_content name=\"x\">abc"),
        ("<pasted_content id=\"x>abc", "<pasted_content id=\"x>abc"),
        ("<pasted_content id=\"x\"", "<pasted_content id=\"x\""),
        // 이어 붙은 표시는 한 번에 안쪽만 지운다
        ("<pasted_content<pasted_content>>x", "<pasted_content>x"),
    ];
    for (text, want) in cases {
        assert_eq!(unwrap_pasted(text), want, "{text:?}");
    }
}

#[test]
fn classify_prompt_slash_and_unwrapped() {
    let slash = classify_prompt("/model");
    assert_eq!(slash, PromptClass { read_only: false, slash_command: true, unwrapped: "/model".to_owned() });
    // 앞뒤 빈칸은 JS trim으로 자른다: BOM은 자르고 NEL은 자르지 않는다
    assert!(classify_prompt("  \u{feff}/model  ").slash_command);
    assert!(!classify_prompt("\u{85}/model").slash_command);
    // 보이지 않는 글자는 `/` 앞에 있으면 명령이 아니다(옛 서버와 같다)
    assert!(!classify_prompt("\u{200b}/model").slash_command);
    // 감싸개 안의 `/`도 한 번 벗긴 글로 본다
    assert!(classify_prompt(&tag("/model")).slash_command);
    // 읽기만과 `/`는 함께 참일 수 없다(읽기만은 표시로 시작한다)
    let mixed = classify_prompt(&format!("/ {MARK}"));
    assert!(mixed.slash_command && !mixed.read_only);
    let read = classify_prompt(&format!("{MARK} /model"));
    assert!(read.read_only && !read.slash_command);
    // 요청 글은 한 번만 벗긴다(이어 붙은 표시는 안쪽만 벗겨진다)
    assert_eq!(classify_prompt(&tag(&tag("글"))).unwrapped, "글");
    assert_eq!(classify_prompt("<pasted_content<pasted_content>>x").unwrapped, "<pasted_content>x");
}

#[test]
fn read_tool_table_is_exact() {
    for name in AGENT_READ_TOOLS.iter().chain(CODEX_READ_TOOLS.iter()) {
        assert!(is_read_tool(CliKind::Claude, name), "{name}");
        assert!(is_read_tool(CliKind::Codex, name), "{name}");
    }
    // 바꾸는 도구와 모르는 이름은 읽기 도구가 아니다. 대소문자·빈칸·접두사도 다른 이름이다
    for name in ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell", "mcp__b-studio__run_in_service", "mcp__b-studio__read_file", "", "read", "READ", "Read ", " Read", "Read\u{200b}", "ReadFile", "Rea", "web_fetch", "exec_command", "apply_patch", "Glob\n"] {
        assert!(!is_read_tool(CliKind::Claude, name), "{name:?}");
        assert!(!is_read_tool(CliKind::Codex, name), "{name:?}");
    }
    // 두 표는 겹치지 않고 중복도 없다
    let mut all: Vec<&str> = AGENT_READ_TOOLS.iter().chain(CODEX_READ_TOOLS.iter()).copied().collect();
    let before = all.len();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), before);
}

#[test]
fn read_only_after_work_table() {
    // (이미 읽기만, 검증 상태 있음, 바뀐 파일 있는가) → 표시
    let cases: Vec<(bool, bool, Option<bool>, bool)> = vec![
        (false, false, Some(false), false),
        (false, true, Some(false), true),
        (false, false, Some(true), true),
        (false, true, Some(true), true),
        // 변경 목록을 읽지 못하면 있는 것으로 본다
        (false, false, None, true),
        (false, true, None, true),
        // 이미 읽기만인 실행은 표시하지 않는다
        (true, true, Some(true), false),
        (true, false, None, false),
    ];
    for (already, verification, changed, want) in cases {
        assert_eq!(read_only_after_work(already, verification, changed), want, "{already} {verification} {changed:?}");
    }
}

#[test]
fn read_tool_tables_do_not_leak_across_kinds() {
    let new_kinds = [CliKind::CommandCode, CliKind::OpenCode, CliKind::Gemini];
    // 새 갈래는 자기 표만 읽는다. claude·codex의 읽기 도구는 새 갈래에서 읽기 도구가 아니다
    for name in AGENT_READ_TOOLS.iter().chain(CODEX_READ_TOOLS.iter()) {
        for kind in new_kinds {
            assert!(!is_read_tool(kind, name) || own_table(kind).contains(name), "{kind:?} {name}");
        }
    }
    for kind in new_kinds {
        for name in own_table(kind) {
            assert!(is_read_tool(kind, name), "{kind:?} {name}");
            // 한 갈래의 읽기 도구는 다른 갈래에서 읽기 도구가 아니다(claude·codex 포함)
            for other in new_kinds.into_iter().chain([CliKind::Claude, CliKind::Codex]) {
                if other != kind && !own_table_or_legacy(other).contains(name) {
                    assert!(!is_read_tool(other, name), "{name}는 {kind:?}의 읽기 도구인데 {other:?}에서도 읽기 도구다");
                }
            }
        }
        // 정확히 일치할 때만이다
        for name in own_table(kind) {
            assert!(!is_read_tool(kind, &name.to_uppercase()) || own_table(kind).contains(&name.to_uppercase().as_str()), "{name}");
            assert!(!is_read_tool(kind, &format!("{name} ")), "{name}");
            assert!(!is_read_tool(kind, &format!("mcp__x__{name}")), "{name}");
        }
    }
    // 서브에이전트 도구는 새 갈래에서 쓰기 도구다(Claude의 `Agent`·`Task`는 읽기 도구로 남는다)
    for name in ["agent", "task", "Agent", "Task", "subagent", "delegate_to_agent", "invoke_agent"] {
        for kind in new_kinds {
            assert!(!is_read_tool(kind, name), "{kind:?} {name}");
        }
    }
    assert!(is_read_tool(CliKind::Claude, "Agent") && is_read_tool(CliKind::Claude, "Task"));
    // 바꾸는 도구와 모르는 이름
    for name in ["write", "edit", "bash", "patch", "apply_patch", "write_file", "replace", "run_shell_command", "shell", "", "webfetch "] {
        for kind in new_kinds {
            assert!(!is_read_tool(kind, name), "{kind:?} {name:?}");
        }
    }
}

fn own_table(kind: CliKind) -> &'static [&'static str] {
    match kind {
        CliKind::CommandCode => COMMAND_CODE_READ_TOOLS.as_slice(),
        CliKind::OpenCode => OPENCODE_READ_TOOLS.as_slice(),
        CliKind::Gemini => GEMINI_READ_TOOLS.as_slice(),
        CliKind::Claude | CliKind::Codex => &[],
    }
}

fn own_table_or_legacy(kind: CliKind) -> Vec<&'static str> {
    match kind {
        CliKind::Claude | CliKind::Codex => AGENT_READ_TOOLS.iter().chain(CODEX_READ_TOOLS.iter()).copied().collect(),
        other => own_table(other).to_vec(),
    }
}
