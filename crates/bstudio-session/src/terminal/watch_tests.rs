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
    hooked_argv(&argv(items), SETTINGS, MCP, None)
}

const SELF_LOADER: &str = "/repo/node_modules/tsx/dist/loader.mjs";
const SELF_ENTRY: &str = "/repo/apps/cli/src/agent-tty.ts";

fn hooked_self(items: &[&str]) -> bool {
    hooked_argv(&argv(items), SETTINGS, MCP, Some((SELF_LOADER, SELF_ENTRY)))
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

#[test]
fn hooked_argv_accepts_the_self_agent_launcher_slot_only() {
    let launcher = "/home/kim/.cache/b-studio/agent-gateway/studio-a/agent-tty";
    let (loader, entry) = (SELF_LOADER, SELF_ENTRY);
    assert!(hooked_self(&[launcher, "--import", loader, entry, "--mcp-config", MCP, "--settings", SETTINGS]));
    assert!(hooked_self(&[launcher, "--import", loader, entry, "--mcp-config", MCP, "--settings", SETTINGS, "요청 글"]));
    // 자체 CLI 세션이 아니면(claude 세션) 같은 꼴이어도 자리 4를 인정하지 않는다
    assert!(!hooked_a(&[launcher, "--import", loader, entry, "--mcp-config", MCP, "--settings", SETTINGS]));
    // 끝 글자만 같은 다른 로더·진입점(아무 폴더에 만든 `…/tsx/dist/loader.mjs`)은 인정하지 않는다
    assert!(!hooked_self(&[launcher, "--import", "/tmp/x/node_modules/tsx/dist/loader.mjs", entry, "--mcp-config", MCP, "--settings", SETTINGS]));
    assert!(!hooked_self(&[launcher, "--import", loader, "/tmp/x/apps/cli/src/agent-tty.ts", "--mcp-config", MCP, "--settings", SETTINGS]));
    assert!(!hooked_self(&[launcher, "--require", loader, entry, "--mcp-config", MCP, "--settings", SETTINGS]));
    // 자리 5 이상, 설정 덮어쓰기, 다른 설정 파일
    assert!(!hooked_self(&[launcher, "--import", loader, entry, "-p", "--mcp-config", MCP, "--settings", SETTINGS]));
    assert!(!hooked_self(&[launcher, "--import", loader, entry, "--mcp-config", MCP, "--settings", SETTINGS, "--settings", "/evil.json"]));
    assert!(!hooked_self(&[launcher, "--import", loader, entry, "--mcp-config", MCP, "--settings", "/evil.json"]));
    // 설정 없이 띄운 자체 CLI는 붙지 않은 것이다
    assert!(!hooked_self(&[launcher, "--import", loader, entry]));
    // 자체 CLI 세션이어도 claude의 원래 자리는 그대로다
    assert!(hooked_self(&["claude", "--mcp-config", MCP, "--settings", SETTINGS]));
}

// ── 새 갈래(Command Code·OpenCode·Gemini)의 hooked_launch ──
// 여는 쪽(허용 목록)이라 좁게 맞춘다: 모르는 것은 붙지 않은 것이다

const MOD: &str = "/home/kim/.cache/b-studio/agent-gateway/studio-a/b-studio-mod.ts";
const OPENCODE_CONFIG: &str = "/home/kim/.cache/b-studio/agent-gateway/studio-a/opencode.json";
const GEMINI_SETTINGS: &str = "/home/kim/.cache/b-studio/agent-gateway/studio-a/gemini-home";

fn env_of(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

fn launch_cc(items: &[&str]) -> bool {
    hooked_launch(CliKind::CommandCode, &argv(items), None, MOD)
}

fn launch_oc(items: &[&str], env: Option<&[(&str, &str)]>) -> bool {
    let env = env.map(env_of);
    hooked_launch(CliKind::OpenCode, &argv(items), env.as_deref(), OPENCODE_CONFIG)
}

fn launch_gm(items: &[&str], env: Option<&[(&str, &str)]>) -> bool {
    let env = env.map(env_of);
    hooked_launch(CliKind::Gemini, &argv(items), env.as_deref(), GEMINI_SETTINGS)
}

#[test]
fn command_code_needs_exactly_one_mod_in_the_wrapper_slot() {
    let cc = "/usr/local/bin/commandcode";
    assert!(launch_cc(&[cc, "--mod", MOD]));
    assert!(launch_cc(&[cc, "--mod", MOD, "요청 글"]));
    assert!(launch_cc(&["/usr/bin/node", "/x/node_modules/command-code/dist/index.js", "--mod", MOD, "--resume", "abc"]));
    // 경로가 다르다: 대소문자·끝 슬래시·겹친 슬래시·점·링크처럼 보이는 글
    for other in [
        MOD.to_uppercase(),
        format!("{MOD}/"),
        format!("{MOD} "),
        MOD.replace("/studio-a/", "//studio-a/"),
        MOD.replace("/studio-a/", "/./studio-a/"),
        MOD.replace("/studio-a/", "/studio-a/../studio-a/"),
        "/tmp/link-to/b-studio-mod.ts".to_owned(),
        String::new(),
    ] {
        assert!(!launch_cc(&[cc, "--mod", &other]), "{other:?}");
    }
    // `--mod=값` 꼴은 감싸개가 쓰지 않는다
    assert!(!launch_cc(&[cc, &format!("--mod={MOD}")]));
    // `--mod`가 둘이면(뒤가 앞을 덮을 수 있다) 붙지 않았다
    assert!(!launch_cc(&[cc, "--mod", MOD, "--mod", "/evil.ts"]));
    assert!(!launch_cc(&[cc, "--mod", "/evil.ts", "--mod", MOD]));
    assert!(!launch_cc(&[cc, "--mod", MOD, "--mod=/evil.ts"]));
    // `--safe-mode`가 있으면 붙지 않았다
    assert!(!launch_cc(&[cc, "--mod", MOD, "--safe-mode"]));
    assert!(!launch_cc(&[cc, "--safe-mode", "--mod", MOD]));
    assert!(!launch_cc(&[cc, "--mod", MOD, "--safe-mode=true"]));
    // 자리가 맞지 않다: 앞에 다른 인자, CLI 스크립트가 아닌 파일 뒤, 값이 없다
    assert!(!launch_cc(&[cc, "-m", "x", "--mod", MOD]));
    assert!(!launch_cc(&["/usr/bin/node", "/tmp/evil.js", "--mod", MOD]));
    assert!(!launch_cc(&[cc, "--mod"]));
    assert!(!launch_cc(&[cc]));
    assert!(!launch_cc(&[]));
    // 요청 글 한 요소 안의 글은 옵션이 아니다
    assert!(launch_cc(&[cc, "--mod", MOD, "--safe-mode를 설명해 줘"]));
}

#[test]
fn opencode_needs_the_config_env_and_no_pure() {
    let oc = "/usr/local/bin/opencode";
    let good: &[(&str, &str)] = &[("HOME", "/h"), ("OPENCODE_CONFIG", OPENCODE_CONFIG)];
    assert!(launch_oc(&[oc], Some(good)));
    assert!(launch_oc(&[oc, "--prompt", "요청"], Some(good)));
    // 환경을 읽지 못했다: 붙지 않은 것
    assert!(!launch_oc(&[oc], None));
    // 환경에 없다·경로가 다르다
    assert!(!launch_oc(&[oc], Some(&[("HOME", "/h")])));
    assert!(!launch_oc(&[oc], Some(&[])));
    for other in [OPENCODE_CONFIG.to_uppercase(), format!("{OPENCODE_CONFIG}/"), format!("{OPENCODE_CONFIG} "), OPENCODE_CONFIG.replace("/studio-a/", "//studio-a/"), "/tmp/link/opencode.json".to_owned(), String::new()] {
        assert!(!launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", &other)])), "{other:?}");
    }
    // 이름의 대소문자·앞뒤 글이 다른 변수는 다른 변수다
    assert!(!launch_oc(&[oc], Some(&[("opencode_config", OPENCODE_CONFIG)])));
    assert!(!launch_oc(&[oc], Some(&[("OPENCODE_CONFIG_DIR", OPENCODE_CONFIG)])));
    // 같은 이름이 둘이고 하나라도 다르면(어느 쪽이 이기는지 모른다) 붙지 않았다
    assert!(!launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("OPENCODE_CONFIG", "/evil.json")])));
    assert!(!launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", "/evil.json"), ("OPENCODE_CONFIG", OPENCODE_CONFIG)])));
    assert!(launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("OPENCODE_CONFIG", OPENCODE_CONFIG)])));
    // OPENCODE_PURE(값이 비었어도 있으면)와 --pure는 플러그인을 끈다
    assert!(!launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("OPENCODE_PURE", "1")])));
    assert!(!launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("OPENCODE_PURE", "")])));
    assert!(!launch_oc(&[oc, "--pure"], Some(good)));
    assert!(!launch_oc(&[oc, "--prompt", "x", "--pure"], Some(good)));
    assert!(!launch_oc(&[oc, "--pure=true"], Some(good)));
    // 요청 글 한 요소 안의 글은 옵션이 아니다(첫 요청은 앞에 "요청: "이 붙어 `-`로 시작하지 않는다). `-`로 시작하는 값은 다음 옵션으로 읽힐 수 있어 받지 않는다
    assert!(launch_oc(&[oc, "--prompt", "요청: --pure를 설명해 줘"], Some(good)));
    assert!(!launch_oc(&[oc, "--prompt", "--pure를 설명해 줘"], Some(good)));
}

#[test]
fn opencode_rejects_envs_that_add_plugins_and_the_attach_client() {
    let oc = "/usr/local/bin/opencode";
    let good: &[(&str, &str)] = &[("OPENCODE_CONFIG", OPENCODE_CONFIG)];
    assert!(launch_oc(&[oc], Some(good)));
    // 설정을 더하는 환경 변수는 하나라도 있으면(값이 비었어도) 붙지 않은 것이다: 마지막에 합쳐지는 설정·자동으로 불러오는 폴더·TUI 설정
    for name in ["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_TUI_CONFIG"] {
        assert!(!launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG), (name, "x")])), "{name}");
        assert!(!launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG), (name, "")])), "{name} 빈 값");
    }
    // 플러그인을 건드리지 않는 변수는 상관없다
    assert!(launch_oc(&[oc], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("OPENCODE_DISABLE_PROJECT_CONFIG", "1")])));
    // 실행 중인 서버에 붙는 클라이언트(attach)는 도구가 다른 프로세스에서 돈다: 이 프로세스의 플러그인은 소용이 없다
    assert!(!launch_oc(&[oc, "attach", "http://localhost:4096"], Some(good)));
    assert!(!launch_oc(&[oc, "--log-level", "DEBUG", "attach", "http://localhost:4096"], Some(good)));
    assert!(!launch_oc(&[oc, "--print-logs", "attach"], Some(good)));
    // 첫 요청·대화 id 같은 옵션 값이 낱말 attach여도 서브명령이 아니다
    assert!(launch_oc(&[oc, "--prompt", "attach"], Some(good)));
    assert!(launch_oc(&[oc, "--session", "attach"], Some(good)));
    assert!(launch_oc(&[oc, "--prompt", "요청", "--log-level", "INFO"], Some(good)));
    // 프로젝트 경로 자리의 낱말 attach는 서브명령이다(모르면 막는 쪽)
    assert!(!launch_oc(&[oc, "attach"], Some(good)));
}

#[test]
fn gemini_needs_the_home_env_and_no_settings_overrides() {
    let gm = "/usr/local/bin/gemini";
    let good: &[(&str, &str)] = &[("GEMINI_CLI_HOME", GEMINI_SETTINGS)];
    assert!(launch_gm(&[gm], Some(good)));
    assert!(launch_gm(&["/usr/bin/node", "/x/node_modules/@google/gemini-cli/bundle/gemini.js", "-i", "요청"], Some(good)));
    // 환경을 읽지 못했다: 붙지 않은 것
    assert!(!launch_gm(&[gm], None));
    assert!(!launch_gm(&[gm], Some(&[])));
    for other in [GEMINI_SETTINGS.to_uppercase(), format!("{GEMINI_SETTINGS}/"), GEMINI_SETTINGS.replace("/studio-a/", "/studio-a/./"), "/tmp/link/gemini-home".to_owned(), String::new()] {
        assert!(!launch_gm(&[gm], Some(&[("GEMINI_CLI_HOME", &other)])), "{other:?}");
    }
    // 같은 이름이 여럿이면 하나라도 다를 때 붙지 않은 것
    assert!(!launch_gm(&[gm], Some(&[("GEMINI_CLI_HOME", GEMINI_SETTINGS), ("GEMINI_CLI_HOME", "/evil")])));
    // 예전 증거(시스템 설정 경로)로는 붙었다고 보지 않는다: 시스템 설정은 root 소유여야 읽혀 우리 파일이 붙지 않는다
    assert!(!launch_gm(&[gm], Some(&[("GEMINI_CLI_SYSTEM_SETTINGS_PATH", GEMINI_SETTINGS)])));
    // 시스템 설정 자리·믿음을 바꾸는 변수는 하나라도 있으면(값이 비었어도) 붙지 않은 것이다: 훅을 끄거나 더할 수 있다
    for name in [
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
        "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
        "GEMINI_RESTRICTED_MODE",
        "GEMINI_CLI_TRUST_WORKSPACE",
        // 샌드박스를 켜거나 꾸미는 변수(0.71.1): CLI를 다른 프로세스에서 다시 띄운다
        "GEMINI_SANDBOX",
        "SANDBOX",
        "GEMINI_SANDBOX_IMAGE",
        "GEMINI_SANDBOX_PROXY_COMMAND",
        "SANDBOX_ENV",
        "SANDBOX_FLAGS",
        "SANDBOX_MOUNTS",
        "SANDBOX_PORTS",
        "SANDBOX_SET_UID_GID",
        "SEATBELT_PROFILE",
    ] {
        assert!(!launch_gm(&[gm], Some(&[("GEMINI_CLI_HOME", GEMINI_SETTINGS), (name, "x")])), "{name}");
        assert!(!launch_gm(&[gm], Some(&[("GEMINI_CLI_HOME", GEMINI_SETTINGS), (name, "")])), "{name} 빈 값");
    }
    // 샌드박스 인자는 CLI를 다른 프로세스에서 다시 띄운다: 붙었는지 알 수 없다
    for flag in ["-s", "--sandbox", "--sandbox=true", "--sandbox-image"] {
        assert!(!launch_gm(&[gm, flag], Some(good)), "{flag}");
    }
    // 첫 요청 글은 앞에 "요청: "이 붙어 `-`로 시작하지 않는다. `-`로 시작하는 값은 다음 옵션으로 읽힐 수 있어 붙지 않은 것이다
    assert!(launch_gm(&[gm, "-i", "요청: --sandbox를 설명해 줘"], Some(good)));
    assert!(!launch_gm(&[gm, "-i", "--sandbox를 설명해 줘"], Some(good)));
}

#[test]
fn opencode_accepts_only_known_args() {
    let oc = "/usr/local/bin/opencode";
    let env: &[(&str, &str)] = &[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("PWD", "/work/a")];
    let ok = |args: &[&str]| launch_oc(args, Some(env));
    // 우리가 쓰는 꼴과 사용자가 흔히 치는 옵션
    assert!(ok(&[oc]));
    assert!(ok(&[oc, "--model=anthropic/x", "--prompt", "요청: 고쳐 줘"]));
    assert!(ok(&[oc, "--session", "ses_1"]));
    assert!(ok(&[oc, "-m", "p/m", "-c", "--fork", "--agent", "build", "--log-level", "INFO", "--print-logs"]));
    assert!(ok(&[oc, "--prompt=요청"]));
    // 프로젝트 경로: `.`만(작업 폴더는 cwd가 정한다). 환경(PWD)은 상대가 정할 수 있는 값이라 예외의 근거로 쓰지 않는다
    assert!(ok(&[oc, "."]));
    assert!(!ok(&[oc, "/work/a"]));
    assert!(!ok(&[oc, "/work/b"]));
    assert!(!ok(&[oc, "src"]));
    assert!(!ok(&[oc, ".", "."]));
    // 서버에 붙거나 다른 설정·서버로 뜨는 길: 하위 명령(1.18.33의 yargs 정의)과 옵션은 모두 붙지 않은 것
    for command in ["attach", "run", "serve", "web", "acp", "mcp", "plugin", "plug", "auth", "providers", "models", "export", "import", "github", "pr", "session", "stats", "db", "debug", "agent", "upgrade", "uninstall", "completion", "console", "generate"] {
        assert!(!ok(&[oc, command]), "{command}");
        assert!(!ok(&[oc, command, "http://localhost:4096"]), "{command} url");
        assert!(!ok(&[oc, "--log-level", "DEBUG", command]), "{command} 옵션 뒤");
    }
    for flag in ["--attach", "--attach=http://localhost:4096", "--port", "--hostname", "--mdns", "--cors", "--dir", "--cwd", "--mini", "--auto", "--yolo", "--dangerously-skip-permissions", "--pure", "--pure=true", "-p", "-u", "--password", "--username", "--url", "--demo", "--replay", "--no-replay", "--config", "-x"] {
        assert!(!ok(&[oc, flag]), "{flag}");
        assert!(!ok(&[oc, flag, "x"]), "{flag} x");
    }
    // 값 자리에 옵션이 오면 값이 아니라 다음 옵션이다(`--prompt --attach url`은 --prompt가 비고 --attach가 붙는다)
    assert!(!ok(&[oc, "--prompt", "--attach", "http://localhost:4096"]));
    assert!(!ok(&[oc, "--session", "-c"]));
    assert!(!ok(&[oc, "--prompt"]));
    // `--` 뒤는 모두 위치 인자
    assert!(!ok(&[oc, "--", "attach"]));
    // PWD가 무엇이든 위치 인자는 `.`만 받는다: `PWD=serve opencode serve`처럼 하위 명령 이름을 PWD에 두어도 소용없다
    assert!(launch_oc(&[oc, "."], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG)])));
    assert!(!launch_oc(&[oc, "/work/a"], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG)])));
    for command in ["serve", "attach", "run", "web", "acp", "mcp", "plug", "auth", "/work", "src"] {
        let pwd: &[(&str, &str)] = &[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("PWD", command)];
        assert!(!launch_oc(&[oc, command], Some(pwd)), "PWD={command}");
        assert!(!launch_oc(&[oc, "--prompt", "x", command], Some(pwd)), "PWD={command} 뒤");
    }
    // 같은 PWD가 둘이어도 마찬가지다
    assert!(!launch_oc(&[oc, "serve"], Some(&[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("PWD", "serve"), ("PWD", "serve")])));
}

#[test]
fn gemini_accepts_only_known_args() {
    let gm = "/usr/local/bin/gemini";
    let good: &[(&str, &str)] = &[("GEMINI_CLI_HOME", GEMINI_SETTINGS)];
    let ok = |args: &[&str]| launch_gm(args, Some(good));
    assert!(ok(&[gm]));
    assert!(ok(&[gm, "-i", "요청: 고쳐 줘"]));
    assert!(ok(&[gm, "--prompt-interactive=요청", "-m", "gemini-x", "--model=y", "--screen-reader"]));
    assert!(ok(&[gm, "-r", "latest"]));
    assert!(ok(&[gm, "--resume"]));
    assert!(ok(&[gm, "고쳐", "줘"]));
    // 하위 명령은 에이전트를 띄우지 않는다(0.71.1의 mcp·extensions·skills·hooks·gemma·models와 별칭): 붙지 않은 것
    for command in ["mcp", "extensions", "extension", "skills", "skill", "hooks", "hook", "gemma", "models"] {
        assert!(!ok(&[gm, command]), "{command}");
        assert!(!ok(&[gm, "-m", "x", command, "list"]), "{command} 옵션 뒤");
    }
    // 허용 목록 밖의 옵션: 샌드박스·다른 방식으로 뜨는 길·설정을 바꾸는 길
    for flag in ["-s", "--sandbox", "--sandbox=true", "--sandbox-image", "-p", "--prompt", "-y", "--yolo", "--approval-mode", "--policy", "--admin-policy", "--acp", "--experimental-acp", "-e", "--extensions", "-l", "--list-extensions", "--list-models", "--list-sessions", "--delete-session", "--skip-trust", "-w", "--worktree", "--include-directories", "--session-file", "--session-id", "-o", "--output-format", "--fake-responses", "--record-responses", "--allowed-tools", "--allowed-mcp-server-names", "-x"] {
        assert!(!ok(&[gm, flag]), "{flag}");
        assert!(!ok(&[gm, "-i", "요청", flag, "x"]), "{flag} 뒤");
    }
    // 환경으로 정하는 예외는 없다: PWD·다른 변수가 하위 명령 이름이어도 거절은 그대로다
    let tricky: &[(&str, &str)] = &[("GEMINI_CLI_HOME", GEMINI_SETTINGS), ("PWD", "mcp"), ("OLDPWD", "mcp")];
    assert!(!launch_gm(&[gm, "mcp"], Some(tricky)));
    assert!(!ok(&[gm, "-i", "--sandbox"]));
    assert!(!ok(&[gm, "-i"]));
    assert!(!ok(&[gm, "--", "x"]));
}

#[test]
fn hooked_launch_never_crosses_kinds() {
    // 다른 갈래의 증거로는 붙었다고 보지 않는다
    let oc_env: &[(&str, &str)] = &[("OPENCODE_CONFIG", OPENCODE_CONFIG), ("GEMINI_CLI_HOME", GEMINI_SETTINGS)];
    assert!(!launch_gm(&["gemini"], Some(&[("OPENCODE_CONFIG", GEMINI_SETTINGS)])));
    assert!(!launch_oc(&["opencode"], Some(&[("GEMINI_CLI_HOME", OPENCODE_CONFIG)])));
    assert!(!launch_cc(&["commandcode", "--settings", SETTINGS]));
    // claude·codex는 이 함수로 붙었다고 보지 않는다(claude는 hooked_argv, codex는 ps 한 줄)
    for kind in [CliKind::Claude, CliKind::Codex] {
        let env = env_of(oc_env);
        assert!(!hooked_launch(kind, &argv(&["claude", "--mod", MOD]), Some(&env), MOD));
        assert!(!hooked_launch(kind, &argv(&["claude", "--mcp-config", MCP, "--settings", SETTINGS]), Some(&env), SETTINGS));
    }
    // ps 한 줄 판정(`hooked`)도 새 갈래를 붙었다고 보지 않는다
    for kind in [CliKind::CommandCode, CliKind::OpenCode, CliKind::Gemini] {
        assert!(!hooked(&format!("{} --mod {MOD}", kind.as_str()), MOD, kind));
    }
}

#[test]
fn new_kinds_are_recognized_by_name_and_package() {
    for (kind, name, package) in [
        (CliKind::CommandCode, "commandcode", "/x/node_modules/command-code/dist/index.js"),
        (CliKind::OpenCode, "opencode", "/x/node_modules/opencode-ai/bin/opencode.js"),
        (CliKind::Gemini, "gemini", "/x/node_modules/@google/gemini-cli/dist/index.js"),
    ] {
        assert_eq!(CliKind::parse(name), Some(kind));
        assert_eq!(kind.as_str(), name);
        assert!(looks_like_agent_cli(&format!("/usr/local/bin/{name} --x"), "/other", kind));
        assert!(looks_like_agent_cli(&format!("node {package}"), "/other", kind));
        assert!(!looks_like_agent_cli("/usr/bin/vim notes.txt", "/other", kind));
    }
    // 패키지 자리는 갈래마다 다르다
    assert!(!looks_like_agent_cli("node /x/node_modules/@google/gemini-cli/dist/index.js", "/other", CliKind::OpenCode));
    assert!(!looks_like_agent_cli("node /x/node_modules/command-code/dist/index.js", "/other", CliKind::Claude));
}
