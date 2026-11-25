use super::*;

const SETTINGS: &str = "/home/kim/.cache/b-studio/agent-gateway/studio-a/settings.json";
const CLI: &str = "/home/kim/.local/bin/claude";

fn marker() -> String {
    format!("--settings {SETTINGS}")
}

fn p(pid: i64, ppid: i64, args: &str) -> Process {
    Process { pid, ppid, args: args.to_owned() }
}

fn find(root: i64, processes: &[Process]) -> Option<Vec<i64>> {
    find_unhooked_cli(root, processes, CliKind::Claude, CLI, &marker())
}

// ── find_unhooked_cli ──

#[test]
fn hooked_cli_passes_and_unhooked_is_found() {
    let processes = [
        p(1, 0, "/sbin/launchd"),
        p(100, 1, "/bin/zsh -l -i"),
        p(101, 100, &format!("{CLI} --settings {SETTINGS} --mcp-config /x/mcp.json")),
        p(102, 100, &format!("{CLI} --resume")),
        p(103, 100, "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
        p(104, 100, "/bin/sh /g/bin/claude --settings x"),
        p(105, 100, "/usr/bin/vim notes.txt"),
    ];
    assert_eq!(find(100, &processes), Some(vec![102, 103]));
}

#[test]
fn grandchildren_are_walked_in_preorder() {
    let processes = [p(100, 1, "/bin/zsh"), p(110, 100, "/bin/bash"), p(111, 110, CLI), p(120, 100, CLI)];
    assert_eq!(find(100, &processes), Some(vec![111, 120]));
}

#[test]
fn root_pid_below_two_is_unavailable_not_everything() {
    let processes = [p(1, 0, "/sbin/launchd"), p(200, 1, CLI)];
    assert_eq!(find(0, &processes), None);
    assert_eq!(find(1, &processes), None);
    assert_eq!(find(-5, &processes), None);
    // 아래에 아무것도 없으면 빈 목록이다(할 수 없음과 다르다)
    assert_eq!(find(2, &processes), Some(vec![]));
}

#[test]
fn deep_chains_and_cycles_terminate() {
    let mut processes: Vec<Process> = (0..50_000).map(|i| p(100 + i, 99 + i, "/bin/sh")).collect();
    processes.push(p(60_000, 100 + 49_999, CLI));
    assert_eq!(find(99, &processes), Some(vec![60_000]));
    // 서로를 부모로 가리키는 쌍은 한 번씩만 본다
    let cyc = [p(10, 11, CLI), p(11, 10, CLI), p(5, 10, "/bin/sh")];
    assert_eq!(find(10, &cyc), Some(vec![11, 5].into_iter().filter(|pid| *pid == 11).collect()));
}

#[test]
fn marker_must_sit_on_word_boundaries() {
    // 다른 파일이 같은 글로 시작한다
    let prefix = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} --settings {SETTINGS}x"))];
    assert_eq!(find(100, &prefix), Some(vec![101]));
    let deeper = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} --settings {SETTINGS}/evil.json"))];
    assert_eq!(find(100, &deeper), Some(vec![101]));
    // 앞에 붙은 글자
    let glued = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} x--settings {SETTINGS}"))];
    assert_eq!(find(100, &glued), Some(vec![101]));
}

#[test]
fn a_second_settings_option_voids_the_marker() {
    // 뒤의 값이 앞의 값을 덮을 수 있다
    let after = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} --settings {SETTINGS} --settings /evil.json"))];
    assert_eq!(find(100, &after), Some(vec![101]));
    let before = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} --settings=/evil.json --settings {SETTINGS}"))];
    assert_eq!(find(100, &before), Some(vec![101]));
    // 표식이 하나뿐이고 다른 --settings가 없으면 붙은 것이다
    let ok = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} --mcp-config /m --settings {SETTINGS} -p hi"))];
    assert_eq!(find(100, &ok), Some(vec![]));
}

#[test]
fn spaced_paths_match_as_a_whole() {
    let spaced = "/home/kim/My Folder/.cache/b-studio/g/settings.json";
    let marker = format!("--settings {spaced}");
    let processes = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} --settings {spaced} --mcp-config /x")), p(102, 100, &format!("{CLI} --resume"))];
    assert_eq!(find_unhooked_cli(100, &processes, CliKind::Claude, CLI, &marker), Some(vec![102]));
    // 경로의 앞부분만 있는 것은 붙은 것이 아니다
    let cut = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} --settings /home/kim/My"))];
    assert_eq!(find_unhooked_cli(100, &cut, CliKind::Claude, CLI, &marker), Some(vec![101]));
}

#[test]
fn a_known_limit_the_marker_text_as_one_argument_passes() {
    // ps의 한 줄은 따옴표를 잃어 `-p "--settings <경로>"`와 진짜 `--settings <경로>`를 가르지 못한다(모듈 문서의 한계)
    let fake = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} -p --settings {SETTINGS}"))];
    assert_eq!(find(100, &fake), Some(vec![]));
}

#[test]
fn codex_keeps_the_old_substring_rule() {
    let hook = "/g/b-studio-codex-hook.mjs";
    let processes = [
        p(100, 1, "/bin/zsh"),
        p(101, 100, &format!("/opt/bin/codex -c hooks.PreToolUse=node {hook} pre-tool")),
        p(102, 100, "/opt/bin/codex"),
        p(103, 100, &format!("/opt/bin/codex -c x={hook}x")),
    ];
    // 옛 규칙: 글자가 들어 있으면 붙은 것으로 본다(103도 통과). codex는 실험이라 그대로 둔다
    assert_eq!(find_unhooked_cli(100, &processes, CliKind::Codex, "/opt/bin/codex", hook), Some(vec![102]));
}

#[test]
fn looks_like_cli_rules() {
    let k = CliKind::Claude;
    assert!(looks_like_agent_cli("claude --resume", CLI, k));
    assert!(looks_like_agent_cli("/usr/local/bin/claude/ ", CLI, k));
    assert!(looks_like_agent_cli(CLI, CLI, k));
    assert!(looks_like_agent_cli("node /x/node_modules/@anthropic-ai/claude-code/cli.js", CLI, k));
    assert!(!looks_like_agent_cli("/bin/sh /g/bin/claude", CLI, k));
    assert!(!looks_like_agent_cli("/usr/bin/claudex", CLI, k));
    assert!(!looks_like_agent_cli("", CLI, k));
    // 좀비의 ps 줄(macOS `<defunct>`, Linux `[claude] <defunct>`, BSD `(claude)`)은 후보가 아니다: argv를 읽지 않는다
    assert!(!looks_like_agent_cli("<defunct>", CLI, k));
    assert!(!looks_like_agent_cli("[claude] <defunct>", CLI, k));
    assert!(!looks_like_agent_cli("(claude)", CLI, k));
    // 빈 cliPath와 빈 인자(옛 규칙 그대로)
    assert!(looks_like_agent_cli("", "", k));
    // 맨 앞 공백(JS 공백 포함)은 걷는다
    assert!(looks_like_agent_cli("\u{feff} claude", CLI, k));
}

// ── watch_round ──

fn round(state: &WatchState, file: FileCheck, ps: PsCheck) -> (WatchState, Vec<String>) {
    watch_round(state, &file, &ps)
}

#[test]
fn fresh_state_is_unknown_and_unhealthy() {
    let state = WatchState::new(CliKind::Claude);
    assert_eq!(health_problems(&state).len(), 2);
    assert!(live_violations(&state).is_empty());
}

#[test]
fn a_clean_round_makes_the_watch_healthy() {
    let (state, reports) = round(&WatchState::new(CliKind::Claude), FileCheck::Clean, PsCheck::Listed(vec![]));
    assert!(reports.is_empty());
    assert!(health_problems(&state).is_empty());
    assert!(live_violations(&state).is_empty());
}

#[test]
fn failures_report_at_the_third_and_stay_unhealthy_from_the_first() {
    let mut state = WatchState::new(CliKind::Claude);
    let mut all = Vec::new();
    for _ in 0..4 {
        let (next, reports) = round(&state, FileCheck::Failed, PsCheck::Failed);
        state = next;
        all.push(reports);
    }
    assert!(all[0].is_empty() && all[1].is_empty());
    assert_eq!(all[2], vec![FILE_UNCHECKED.to_owned(), PS_UNCHECKED.to_owned()]);
    assert!(all[3].is_empty());
    assert_eq!(health_problems(&state), vec![FILE_UNCHECKED.to_owned(), PS_UNCHECKED.to_owned()]);
    // 세 번을 넘으면 새 실행에 다시 적는다
    assert_eq!(live_violations(&state), vec![FILE_UNCHECKED.to_owned(), PS_UNCHECKED.to_owned()]);
}

#[test]
fn one_failure_is_unhealthy_but_not_a_live_violation() {
    let (ok, _) = round(&WatchState::new(CliKind::Claude), FileCheck::Clean, PsCheck::Listed(vec![]));
    let (state, reports) = round(&ok, FileCheck::Clean, PsCheck::Failed);
    assert!(reports.is_empty());
    assert_eq!(health_problems(&state), vec![PS_UNCHECKED.to_owned()]);
    assert!(live_violations(&state).is_empty());
    // 성공하면 건강으로 돌아온다
    let (state, _) = round(&state, FileCheck::Clean, PsCheck::Listed(vec![]));
    assert!(health_problems(&state).is_empty());
}

#[test]
fn reported_flags_clear_on_success_so_a_later_streak_reports_again() {
    let mut state = WatchState::new(CliKind::Claude);
    for _ in 0..3 {
        state = round(&state, FileCheck::Failed, PsCheck::Listed(vec![])).0;
    }
    assert!(state.file_reported);
    state = round(&state, FileCheck::Clean, PsCheck::Listed(vec![])).0;
    assert!(!state.file_reported);
    let mut again = Vec::new();
    for _ in 0..3 {
        let (next, reports) = round(&state, FileCheck::Failed, PsCheck::Listed(vec![]));
        state = next;
        again.extend(reports);
    }
    assert_eq!(again, vec![FILE_UNCHECKED.to_owned()]);
}

#[test]
fn changed_files_are_reported_and_unrestored_ones_stay_live() {
    let names = vec!["settings.json".to_owned(), "mcp.json".to_owned()];
    let (restored, reports) = round(&WatchState::new(CliKind::Claude), FileCheck::Changed { names: names.clone(), restore_error: None }, PsCheck::Listed(vec![]));
    assert_eq!(reports, vec!["관문 파일이 바뀌어 되돌렸습니다: settings.json, mcp.json".to_owned()]);
    assert!(live_violations(&restored).is_empty());
    assert!(health_problems(&restored).is_empty());

    let (stuck, reports) = round(&restored, FileCheck::Changed { names, restore_error: Some("EACCES".to_owned()) }, PsCheck::Listed(vec![]));
    assert_eq!(reports, vec!["관문 파일이 바뀌었는데 되돌리지 못했습니다: settings.json, mcp.json (EACCES)".to_owned()]);
    assert_eq!(live_violations(&stuck), reports);
    assert_eq!(health_problems(&stuck), reports);
    // 다음 검사가 깨끗하면 풀린다
    let (clean, _) = round(&stuck, FileCheck::Clean, PsCheck::Listed(vec![]));
    assert!(live_violations(&clean).is_empty());
}

#[test]
fn an_unhooked_cli_is_reported_once_and_stays_live_until_gone() {
    let (a, reports) = round(&WatchState::new(CliKind::Claude), FileCheck::Clean, PsCheck::Listed(vec![102]));
    assert_eq!(reports.len(), 1);
    assert!(reports[0].contains("pid 102"));
    assert_eq!(live_violations(&a).len(), 1);
    // 같은 pid는 다시 알리지 않지만 계속 살아 있는 위반이다
    let (b, reports) = round(&a, FileCheck::Clean, PsCheck::Listed(vec![102]));
    assert!(reports.is_empty());
    assert_eq!(live_violations(&b).len(), 1);
    // 사라지면 위반이 풀리고, 같은 번호가 다시 나타나면 새로 알린다
    let (gone, _) = round(&b, FileCheck::Clean, PsCheck::Listed(vec![]));
    assert!(live_violations(&gone).is_empty());
    assert!(gone.warned.is_empty());
    let (back, reports) = round(&gone, FileCheck::Clean, PsCheck::Listed(vec![102]));
    assert_eq!(reports.len(), 1);
    assert_eq!(live_violations(&back).len(), 1);
}

#[test]
fn a_failed_scan_keeps_the_live_set() {
    let (a, _) = round(&WatchState::new(CliKind::Claude), FileCheck::Clean, PsCheck::Listed(vec![7]));
    let (b, reports) = round(&a, FileCheck::Clean, PsCheck::Failed);
    assert!(reports.is_empty());
    assert_eq!(b.live, vec![7]);
    assert_eq!(b.warned, vec![7]);
}

#[test]
fn unavailable_root_is_reported_once_and_never_healthy() {
    let (a, reports) = round(&WatchState::new(CliKind::Claude), FileCheck::Clean, PsCheck::Unavailable);
    assert_eq!(reports, vec![PS_NO_ROOT.to_owned()]);
    let (b, reports) = round(&a, FileCheck::Clean, PsCheck::Unavailable);
    assert!(reports.is_empty());
    assert_eq!(health_problems(&b), vec![PS_NO_ROOT.to_owned()]);
}

#[test]
fn unknown_state_names_read_as_failed() {
    assert_eq!(FileState::parse("???"), FileState::Failed);
    assert_eq!(PsState::parse("???"), PsState::Failed);
    for state in [FileState::Unknown, FileState::Ok, FileState::Failed, FileState::Unrestored] {
        assert_eq!(FileState::parse(state.as_str()), state);
    }
    for state in [PsState::Unknown, PsState::Ok, PsState::Failed, PsState::Unavailable] {
        assert_eq!(PsState::parse(state.as_str()), state);
    }
}

// ── hook_body_kind ──

#[test]
fn hook_body_kinds() {
    assert_eq!(hook_body_kind(b""), HookBodyKind::Empty);
    assert_eq!(hook_body_kind(b"{}"), HookBodyKind::Object);
    assert_eq!(hook_body_kind(br#"{"tool_name":"Write","tool_input":{"file_path":"a"}}"#), HookBodyKind::Object);
    assert_eq!(hook_body_kind(b" \n{\"a\":1}\n"), HookBodyKind::Object);
    assert_eq!(hook_body_kind(b"[]"), HookBodyKind::NotObject);
    assert_eq!(hook_body_kind(b"null"), HookBodyKind::NotObject);
    assert_eq!(hook_body_kind(b"\"x\""), HookBodyKind::NotObject);
    assert_eq!(hook_body_kind(b"12"), HookBodyKind::NotObject);
    assert_eq!(hook_body_kind(b"{"), HookBodyKind::Invalid);
    assert_eq!(hook_body_kind(b"not json"), HookBodyKind::Invalid);
    assert_eq!(hook_body_kind(b" "), HookBodyKind::Invalid);
    assert_eq!(hook_body_kind(b"\xef\xbb\xbf{}"), HookBodyKind::Invalid);
    assert_eq!(hook_body_kind(b"{} x"), HookBodyKind::Invalid);
}

#[test]
fn hook_body_reads_broken_utf8_like_node() {
    // 깨진 바이트는 U+FFFD로 읽혀 문자열 안에 있으면 그대로 객체다
    assert_eq!(hook_body_kind(b"{\"a\":\"\xff\xfe\"}"), HookBodyKind::Object);
    // 문자열 밖의 깨진 바이트는 문법 밖이다
    assert_eq!(hook_body_kind(b"{\xff}"), HookBodyKind::Invalid);
    // 짝 없는 서로게이트 이스케이프는 JSON.parse가 받는다
    assert_eq!(hook_body_kind(br#"{"a":"\ud800"}"#), HookBodyKind::Object);
}

#[test]
fn first_request_text_in_the_args_can_sway_the_marker_check() {
    // 세션 CLI의 실행 인자에는 첫 요청 글이 실린다. 요청 글이 표식을 그대로 담으면 ps의 한 줄로는 진짜 인자와 가르지 못한다(알려진 한계).
    // 훅 없는 CLI가 요청 글 자리에 표식만 받으면 붙은 것으로 보인다(여는 쪽의 한계)
    let bypass = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} {}", marker()))];
    assert_eq!(find(100, &bypass), Some(vec![]));
    // 붙은 CLI의 요청 글이 `--settings`를 담으면 둘로 세어 붙지 않은 것으로 본다(닫는 쪽의 오탐. 요청 글에 이 낱말을 쓰면 그 실행은 실패로 닫힌다)
    let mention = [p(100, 1, "/bin/zsh"), p(101, 100, &format!("{CLI} --mcp-config /m --settings {SETTINGS} explain the --settings flag"))];
    assert_eq!(find(100, &mention), Some(vec![101]));
}

// ── 진짜 argv ──

const MCP: &str = "/home/kim/.cache/b-studio/agent-gateway/studio-a/mcp.json";
const SCRIPT: &str = "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js";

fn argv(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn hooked_a(items: &[&str]) -> bool {
    hooked_argv(&argv(items), SETTINGS, MCP)
}

#[test]
fn hooked_argv_wrapper_launch_with_request_text() {
    // 감싸개가 `exec <cli> --mcp-config M --settings S "$@"`로 부른다. 요청 글은 한 요소다
    assert!(hooked_a(&[CLI, "--mcp-config", MCP, "--settings", SETTINGS]));
    assert!(hooked_a(&[CLI, "--mcp-config", MCP, "--settings", SETTINGS, "explain the --settings flag"]));
    // 요청 글 요소가 표식 전체를 담아도 요소 하나라서 세지 않는다
    let marker_text = format!("--settings {SETTINGS}");
    assert!(hooked_a(&[CLI, "--mcp-config", MCP, "--settings", SETTINGS, &marker_text]));
    // node가 CLI 스크립트를 띄운 꼴(자리 2)
    assert!(hooked_a(&["node", SCRIPT, "--mcp-config", MCP, "--settings", SETTINGS, "-p", "hi"]));
    assert!(hooked_a(&[SCRIPT, "--mcp-config", MCP, "--settings", SETTINGS]));
}

#[test]
fn hooked_argv_requires_the_exact_wrapper_slot() {
    // `--` 뒤는 요청 글이다
    assert!(!hooked_a(&[CLI, "--", "--settings", SETTINGS]));
    assert!(!hooked_a(&[CLI, "--", "--mcp-config", MCP, "--settings", SETTINGS]));
    // 값을 받는 옵션이 `--settings`를 값으로 먹는다
    assert!(!hooked_a(&[CLI, "--model", "--settings", SETTINGS]));
    assert!(!hooked_a(&[CLI, "--model", "--mcp-config", MCP, "--settings", SETTINGS]));
    // 자리 3 이상
    assert!(!hooked_a(&[CLI, "-p", "hi", "--mcp-config", MCP, "--settings", SETTINGS]));
    assert!(!hooked_a(&["node", SCRIPT, "-p", "--mcp-config", MCP, "--settings", SETTINGS]));
    // 자리 2인데 argv[1]이 CLI 스크립트가 아니다
    assert!(!hooked_a(&[CLI, "-p", "--mcp-config", MCP, "--settings", SETTINGS]));
    assert!(!hooked_a(&["node", "/tmp/evil.js", "--mcp-config", MCP, "--settings", SETTINGS]));
    // 처음 나온 --mcp-config가 아닌 뒤의 것은 보지 않는다
    assert!(!hooked_a(&[CLI, "--mcp-config", "/evil/mcp.json", "--mcp-config", MCP, "--settings", SETTINGS]));
    // 네 요소가 다 있어야 한다
    assert!(!hooked_a(&[CLI, "--mcp-config", MCP, "--settings"]));
    assert!(!hooked_a(&[CLI, "--mcp-config", MCP]));
}

#[test]
fn hooked_argv_checks_the_mcp_file() {
    assert!(!hooked_a(&[CLI, "--mcp-config", "/evil/mcp.json", "--settings", SETTINGS]));
    assert!(!hooked_a(&[CLI, "--mcp-config", "", "--settings", SETTINGS]));
}

#[test]
fn hooked_argv_rejects_other_files_extra_options_and_the_equals_form() {
    assert!(!hooked_a(&[CLI, "--mcp-config", MCP, "--settings", &format!("{SETTINGS}x")]));
    assert!(!hooked_a(&[CLI, "--mcp-config", MCP, "--settings", &format!("{SETTINGS}/evil.json")]));
    // 사용자가 덧붙인 --settings(뒤든 앞이든)
    assert!(!hooked_a(&[CLI, "--mcp-config", MCP, "--settings", SETTINGS, "--settings", "/evil.json"]));
    assert!(!hooked_a(&[CLI, "--settings", "/evil.json", "--mcp-config", MCP, "--settings", SETTINGS]));
    assert!(!hooked_a(&[CLI, "--mcp-config", MCP, "--settings", SETTINGS, "--settings=/evil.json"]));
    // 감싸개가 쓰지 않는 `--settings=<S>` 꼴
    assert!(!hooked_a(&[CLI, "--mcp-config", MCP, &format!("--settings={SETTINGS}")]));
    assert!(!hooked_a(&[CLI, &format!("--settings={SETTINGS}")]));
    assert!(!hooked_a(&[CLI, "--resume"]));
    // 빈 argv
    assert!(!hooked_a(&[]));
}

#[test]
fn hooked_argv_does_not_count_substrings_inside_an_element() {
    // 요소 안에 표식만 있고 진짜 --settings가 없는 것은 붙지 않았다
    assert!(!hooked_a(&[CLI, &format!("--settings {SETTINGS}")]));
    assert!(!hooked_a(&[CLI, "--mcp-config", MCP, &format!("--settings {SETTINGS}")]));
}

#[test]
fn cli_candidates_use_the_wide_ps_rule_and_unknown_root() {
    let processes = [
        p(100, 1, "/bin/zsh"),
        p(101, 100, &format!("{CLI} --mcp-config /m --settings {SETTINGS} explain --settings x")),
        p(102, 100, "/usr/bin/vim"),
        p(103, 100, "node /x/node_modules/@anthropic-ai/claude-code/cli.js"),
    ];
    assert_eq!(cli_candidates(100, &processes, CliKind::Claude, CLI), Some(vec![101, 103]));
    assert_eq!(cli_candidates(0, &processes, CliKind::Claude, CLI), None);
}

#[test]
fn self_agent_launcher_is_recognized_and_hook_is_checked() {
    let dir = "/home/kim/.cache/b-studio/agent-gateway/studio-a";
    let launcher = format!("{dir}/agent-tty");
    let settings = format!("{dir}/settings.json");
    let marker = format!("--settings {settings}");
    let tail = "--import /x/loader.mjs /x/agent-tty.ts";
    let hooked = format!("{launcher} {tail} --mcp-config {dir}/mcp.json --settings {settings}");
    let bare = format!("{launcher} {tail}");
    assert!(looks_like_agent_cli(&hooked, &launcher, CliKind::Claude));
    assert!(looks_like_agent_cli(&bare, &launcher, CliKind::Claude));
    let processes = [p(100, 1, "/bin/zsh"), p(101, 100, &hooked)];
    assert_eq!(find_unhooked_cli(100, &processes, CliKind::Claude, &launcher, &marker), Some(vec![]));
    let processes = [p(100, 1, "/bin/zsh"), p(101, 100, &bare)];
    assert_eq!(find_unhooked_cli(100, &processes, CliKind::Claude, &launcher, &marker), Some(vec![101]));
}
