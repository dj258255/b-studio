//! 세션 터미널의 감시(관문 파일 변조와 훅 없이 뜬 CLI를 찾는 일)의 판정(ADR-219, 4f B5e). 옛 구현은 `session-terminal.ts`의 `HOST_BACKEND.watch`(상태 변수들)와
//! `packages/sandbox/src/host-terminal.ts`의 `findUnhookedCli`·`looksLikeAgentCli`, `packages/agent/src/hook-server.ts`의 본문 읽기였다
//! (옛 구현 `session-terminal-watch-legacy.ts`는 #1347에서 지웠다). Node를 모른다. `ps`·파일 읽기·`fs.watch`·타이머는 TS가 하고, 여기는 **무엇을 알리고, 지금 무엇이 살아 있고,
//! 감시가 믿을 만한가**만 정한다.
//!
//! **세 가지를 순수 함수로 둔다.**
//! - `watch_round`: 한 번의 검사 결과(관문 파일, 프로세스)를 상태에 넣어 새 상태와 알릴 글을 돌려준다. `live_violations`·`health_problems`는 그 상태에서 읽는다
//! - `find_unhooked_cli`: 프로세스 목록과 표식으로 훅이 붙지 않은 CLI의 pid를 찾는다
//! - `hook_body_kind`: 훅 요청 본문이 입력 객체로 읽히는가
//!
//! **막는 검사다.** 호출부마다 막는 쪽인지 여는 쪽인지:
//! - 위반을 찾는 쪽(거부 목록): `find_unhooked_cli`가 찾는 것이다. 넓게 맞출수록 더 찾고, 좁게 맞추면 놓친다. CLI로 보는 규칙(이름·경로·패키지 자리)은 넓을수록 막는 쪽이다
//! - 표식 대조(`hooked`)는 "붙었다"로 보는 쪽이라 **여는 쪽**이다. 넓게 맞추면 훅이 붙지 않은 CLI가 통과한다. 그래서 claude는 좁게 맞춘다:
//!   표식 뒤가 공백이나 끝이어야 하고(`settings.jsonx`·`settings.json/x`는 다른 파일이다), 인자에 `--settings`가 둘 이상이면(뒤 값이 앞 값을 덮을 수 있다) 붙었다고 보지 않는다
//! - 알려진 한계: `ps`의 인자 한 줄은 낱말마다 따옴표를 잃는다. 표식 글이 그대로 든 인자 하나(`claude -p "--settings <경로>"`)는 진짜 `--settings`와 구별할 수 없다. 구별하려면 프로세스의 argv가 필요하다
//! - 모르는 것은 통과가 아니다: 프로세스 검사를 한 번도 못 했거나 마지막 검사가 실패했거나 루트 pid를 모르면 `health_problems`가 비어 있지 않다(N17·N20)
//!
//! 한번 설정된 상태가 남는가: `warned`는 지금 살아 있는 pid만 남긴다(사라진 pid는 지운다. 번호를 다시 쓰는 새 CLI를 알린다). `file_reported`·`ps_reported`는 검사가 성공하면 지운다
//! (옛 판정은 터미널 수명 동안 남겨 두 번째 실패 연속은 알리지 않았다). `live`는 마지막으로 성공한 프로세스 검사의 결과이고, 검사가 실패하면 그대로 둔다(사라졌다고 믿을 근거가 없다).
//!
//! 의도한 차이(옛 판정과 다른 칸. 나머지는 입력 전체가 같다. 모두 닫는 쪽이다):
//! - `watch_round`: 위의 두 상태를 지워 더 알린다. 알릴 글의 앞부분은 같다
//! - `find_unhooked_cli`: claude의 표식 대조가 좁다(위). 루트 pid가 2보다 작으면 찾지 않고 "할 수 없음"이다(옛 코드는 0이 모든 프로세스를 훑었다). codex는 옛 규칙 그대로다(실험 기능, ADR-200)
//! - `hook_body_kind`: 읽지 못한 본문을 `{}`로 두지 않고 "읽지 못함"으로 알린다. 막는 판정이 쓰는 훅이 거절하게 하려는 것이다. 빈 본문은 `Empty`로 가려 알린다

use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsValue};
use std::collections::{BTreeSet, HashMap};

/// 관문 파일·프로세스 검사가 이만큼 연달아 실패하면 한 번 알린다
pub const FAILURES_BEFORE_REPORT: u32 = 3;

/// claude는 이 글이 인자에 있을 때(설치된 패키지 자리), codex는 이 글이 있을 때 CLI로 본다
pub const CLAUDE_PACKAGE_MARK: &str = "/@anthropic-ai/claude-code/";
pub const CODEX_PACKAGE_MARK: &str = "/@openai/codex";
/// 새 갈래(실험, 아직 세션 만들기에서 닿지 않는다)의 설치된 패키지 자리. 바이너리 이름(`commandcode`·`opencode`·`gemini`)은 `as_str`로 따로 본다
pub const COMMAND_CODE_PACKAGE_MARK: &str = "/command-code/dist/";
pub const OPENCODE_PACKAGE_MARK: &str = "/opencode-ai/";
pub const GEMINI_PACKAGE_MARK: &str = "/@google/gemini-cli/";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliKind {
    Claude,
    Codex,
    CommandCode,
    OpenCode,
    Gemini,
}

impl CliKind {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "commandcode" => Some(Self::CommandCode),
            "opencode" => Some(Self::OpenCode),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::CommandCode => "commandcode",
            Self::OpenCode => "opencode",
            Self::Gemini => "gemini",
        }
    }

    fn package_mark(self) -> &'static str {
        match self {
            Self::Claude => CLAUDE_PACKAGE_MARK,
            Self::Codex => CODEX_PACKAGE_MARK,
            Self::CommandCode => COMMAND_CODE_PACKAGE_MARK,
            Self::OpenCode => OPENCODE_PACKAGE_MARK,
            Self::Gemini => GEMINI_PACKAGE_MARK,
        }
    }
}

/// 프로세스 하나. `ps`가 준 pid·부모 pid·인자 한 줄
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Process {
    pub pid: i64,
    pub ppid: i64,
    pub args: String,
}

// ── 훅이 붙지 않은 CLI 찾기 ──

/// `path.basename`(posix): 끝의 `/`를 걷고 마지막 `/` 뒤. 전부 `/`면 빈 글
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(at) => &trimmed[at + 1..],
        None => trimmed,
    }
}

/// 인자 한 줄의 첫 낱말(`args.trim().split(/\s+/)[0] ?? ''`)
fn first_word(args: &str) -> &str {
    let trimmed = js::trim(args);
    match trimmed.find(js::is_js_whitespace) {
        Some(at) => &trimmed[..at],
        None => trimmed,
    }
}

/// 이 프로세스가 에이전트 CLI로 보이는가(거부 목록 쪽: 넓을수록 더 막는다). 첫 낱말의 파일 이름이 CLI 이름이거나, 첫 낱말이 cliPath와 같거나, 인자에 CLI 패키지 자리가 든 것
pub fn looks_like_agent_cli(args: &str, cli_path: &str, kind: CliKind) -> bool {
    let first = first_word(args);
    basename(first) == kind.as_str() || first == cli_path || args.contains(kind.package_mark())
}

/// 인자 낱말 중 `--settings`(`--settings=값` 포함)의 수
fn settings_option_count(args: &str) -> usize {
    args.split(js::is_js_whitespace).filter(|word| *word == "--settings" || word.starts_with("--settings=")).count()
}

/// `marker`가 인자에 낱말 경계로 들어 있는가: 앞이 시작이거나 공백이고, 뒤가 끝이거나 공백이다
fn contains_at_boundary(args: &str, marker: &str) -> bool {
    if marker.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(found) = args[from..].find(marker) {
        let start = from + found;
        let end = start + marker.len();
        let before_ok = args[..start].chars().next_back().is_none_or(js::is_js_whitespace);
        let after_ok = args[end..].chars().next().is_none_or(js::is_js_whitespace);
        if before_ok && after_ok {
            return true;
        }
        // 다음 후보는 다음 글자부터(겹쳐 맞는 표식도 본다)
        from = start + args[start..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// 우리 설정이 붙었다고 볼 수 있는가(여는 쪽이라 좁게 맞춘다). claude는 표식이 낱말 경계로 있고 `--settings`가 하나뿐이어야 한다. codex는 옛 규칙(표식 글 포함)이다
pub fn hooked(args: &str, marker: &str, kind: CliKind) -> bool {
    match kind {
        CliKind::Claude => contains_at_boundary(args, marker) && settings_option_count(args) == 1,
        CliKind::Codex => args.contains(marker),
        // 새 갈래는 ps 한 줄로 붙었다고 보지 않는다(환경이 줄에 없다). 붙었는지는 `hooked_launch`가 argv와 환경으로 본다
        CliKind::CommandCode | CliKind::OpenCode | CliKind::Gemini => false,
    }
}

/// 새 갈래(Command Code·OpenCode·Gemini)가 우리 설정으로 떴는가. **여는 쪽(허용 목록)이라 좁게 맞춘다. 모르는 것은 붙지 않은 것이다**:
/// - Command Code: 감싸개가 `<cli> --mod <M>`으로 부른다. `--mod`는 argv의 1번 자리(node가 띄운 꼴은 `/command-code/dist/`가 든 스크립트 뒤의 2번 자리)에 정확히 하나, 값은 `expected`와 **같은 글**이어야 하고
///   `--mod=…`·두 번째 `--mod`(뒤가 앞을 덮을 수 있다)·`--safe-mode`가 있으면 붙지 않았다
/// - OpenCode: 환경의 `OPENCODE_CONFIG`가 `expected`와 같은 글이고(같은 이름이 여럿이면 모두), `OPENCODE_PURE`와 플러그인을 더하는 변수(`OPENCODE_CONFIG_CONTENT`·`OPENCODE_CONFIG_DIR`·`OPENCODE_TUI_CONFIG`)가 없고(값이 비었어도 있으면 안 된다),
///   argv에 `--pure`가 없고 첫 위치 인자가 `attach`(다른 서버에 붙는 클라이언트)가 아니다. 환경을 읽지 못했으면(`None`) 붙지 않았다
/// - Gemini: 환경의 `GEMINI_CLI_HOME`(관문 폴더 안의 홈)이 `expected`와 같은 글이고(같은 이름이 여럿이면 모두), 시스템 설정 자리·믿음을 정하는 변수가 없고, 샌드박스 인자가 없다. 환경을 읽지 못했으면 붙지 않았다
///   (시스템 설정은 root 소유여야 읽혀서 사용자 폴더의 파일로는 훅을 붙일 수 없다 — ADR-242)
/// - claude·codex는 이 판정으로 붙었다고 보지 않는다(claude는 `hooked_argv`, codex는 `hooked`)
///
/// 경로는 글 그대로 견준다(대소문자·끝 슬래시·`.`·`..`·겹친 슬래시·링크처럼 보이는 글은 다른 글이다). 정규화해서 견주면 다른 파일이 같은 파일이 된다
pub fn hooked_launch(kind: CliKind, argv: &[String], env: Option<&[(String, String)]>, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    match kind {
        CliKind::Claude | CliKind::Codex => false,
        CliKind::CommandCode => {
            let is_mod = |element: &String| element == "--mod" || element.starts_with("--mod=");
            if argv.iter().filter(|element| is_mod(element)).count() != 1 {
                return false;
            }
            if argv.iter().any(|element| element == "--safe-mode" || element.starts_with("--safe-mode=")) {
                return false;
            }
            let Some(at) = argv.iter().position(|element| element == "--mod") else { return false };
            let slot_ok = at == 1 || (at == 2 && argv.get(1).is_some_and(|script| script.contains(COMMAND_CODE_PACKAGE_MARK)));
            slot_ok && argv.get(at + 1).is_some_and(|value| value == expected)
        }
        CliKind::OpenCode => {
            let Some(env) = env else { return false };
            if env.iter().any(|(name, _)| name == "OPENCODE_PURE") {
                return false;
            }
            // 설정을 더하는 환경 변수: 마지막에 합쳐지는 설정(`OPENCODE_CONFIG_CONTENT`)·자동으로 불러오는 폴더(`OPENCODE_CONFIG_DIR`)·TUI 설정(`OPENCODE_TUI_CONFIG`)이
            // 하나라도 있으면(값이 비었어도) 우리 플러그인 말고 다른 플러그인이 붙을 수 있다. 감싸개는 이 변수들을 지우고 띄운다
            if env.iter().any(|(name, _)| OPENCODE_PLUGIN_ENVS.contains(&name.as_str())) {
                return false;
            }
            if argv.iter().any(|element| element == "--pure" || element.starts_with("--pure=")) {
                return false;
            }
            // `attach`는 실행 중인 서버에 붙는 클라이언트다. 도구는 그 서버 프로세스에서 돌아 이 프로세스에 붙은 플러그인은 소용이 없다
            if opencode_first_positional(argv) == Some("attach") {
                return false;
            }
            env_all_equal(env, "OPENCODE_CONFIG", expected)
        }
        CliKind::Gemini => {
            let Some(env) = env else { return false };
            // 시스템 설정 자리·시스템 기본값·믿음을 정하는 변수는 하나라도 있으면(값이 비었어도) 붙지 않은 것이다: 훅을 끄거나 더할 수 있다(감싸개는 이 변수들을 지우고 띄운다)
            if env.iter().any(|(name, _)| GEMINI_SETTINGS_ENVS.contains(&name.as_str())) {
                return false;
            }
            if gemini_uses_sandbox(argv) {
                return false;
            }
            env_all_equal(env, "GEMINI_CLI_HOME", expected)
        }
    }
}

/// Gemini의 설정·믿음을 바꾸거나 샌드박스를 켜는 환경 변수(0.71.1 소스에서 읽은 것). 하나라도 있으면(값이 비었어도) 붙지 않은 것이다.
/// 샌드박스(`GEMINI_SANDBOX`·`SANDBOX`·이미지·프록시·마운트·포트·프로필)는 CLI를 다른 프로세스에서 다시 띄워 우리 훅이 붙었는지 알 수 없다.
/// 감싸개가 지우는 목록(`GEMINI_UNSET_ENVS`)과 같아야 한다(TS 시험이 두 목록을 견준다)
const GEMINI_SETTINGS_ENVS: [&str; 14] = [
    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
    "GEMINI_RESTRICTED_MODE",
    "GEMINI_CLI_TRUST_WORKSPACE",
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
];
/// 값을 따로 받는 Gemini의 옵션(0.71.1의 옵션 표). 값 자리의 글(첫 요청 등)이 옵션으로 읽히지 않게 건너뛴다. 모르는 옵션의 값은 옵션으로 읽혀 더 막을 뿐이다
const GEMINI_VALUE_OPTIONS: [&str; 24] = [
    "-m", "--model", "-p", "--prompt", "-i", "--prompt-interactive", "-w", "--worktree", "--approval-mode", "--policy", "--admin-policy", "--allowed-mcp-server-names",
    "--allowed-tools", "-e", "--extensions", "-r", "--resume", "--session-file", "--session-id", "--delete-session", "--include-directories", "-o", "--output-format", "--sandbox-image",
];

/// argv에 샌드박스를 켜는 옵션이 있는가(`-s`·`--sandbox`·`--sandbox-image`, 짧은 옵션 묶음의 `s` 포함). 샌드박스는 CLI를 다른 프로세스에서 다시 띄운다 — 우리 훅이 붙었는지 알 수 없다
fn gemini_uses_sandbox(argv: &[String]) -> bool {
    let mut skip_value = false;
    for element in argv.iter().skip(1) {
        if skip_value {
            skip_value = false;
            continue;
        }
        if element == "--" {
            return false;
        }
        if element.starts_with("--") {
            let name = element.split('=').next().unwrap_or(element);
            if name == "--sandbox" || name == "--sandbox-image" {
                return true;
            }
            if !element.contains('=') && GEMINI_VALUE_OPTIONS.contains(&element.as_str()) {
                skip_value = true;
            }
        } else if element.starts_with('-') && element.len() > 1 {
            if element.chars().skip(1).any(|c| c == 's') {
                return true;
            }
            if GEMINI_VALUE_OPTIONS.contains(&element.as_str()) {
                skip_value = true;
            }
        }
    }
    false
}

/// OpenCode의 설정에 플러그인을 더할 수 있는 환경 변수. 하나라도 있으면 붙지 않은 것이다
const OPENCODE_PLUGIN_ENVS: [&str; 3] = ["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_TUI_CONFIG"];
/// 값을 따로 받는 OpenCode의 옵션(설치된 1.18.33의 `--help`와 옵션 정의에서). 값 자리의 글이 서브명령으로 읽히지 않게 건너뛴다. 모르는 옵션의 값은 낱말로 읽혀 더 막을 뿐이다
const OPENCODE_VALUE_OPTIONS: [&str; 11] = ["--log-level", "--prompt", "--session", "-s", "--model", "-m", "--agent", "--port", "--hostname", "--cors", "--mdns-domain"];

/// argv[0] 뒤의 첫 위치 인자(서브명령이거나 프로젝트 경로). 옵션과 그 값은 건너뛴다
fn opencode_first_positional(argv: &[String]) -> Option<&str> {
    let mut skip_value = false;
    for element in argv.iter().skip(1) {
        if skip_value {
            skip_value = false;
            continue;
        }
        if element.starts_with('-') && element.len() > 1 {
            if !element.contains('=') && OPENCODE_VALUE_OPTIONS.contains(&element.as_str()) {
                skip_value = true;
            }
            continue;
        }
        return Some(element.as_str());
    }
    None
}

/// `name`이 환경에 있고 모든 줄의 값이 `expected`와 같은가(같은 이름이 여럿이면 프로그램마다 이기는 쪽이 달라 하나라도 다르면 거짓)
fn env_all_equal(env: &[(String, String)], name: &str, expected: &str) -> bool {
    let mut found = false;
    for (key, value) in env {
        if key == name {
            if value != expected {
                return false;
            }
            found = true;
        }
    }
    found
}

/// 진짜 argv로 본 "우리 설정이 붙었는가"(여는 쪽이라 좁게 맞춘다). 감싸개는 늘 `exec <cli> --mcp-config <M> --settings <S> "$@"`로 부르므로 그 **정확한 자리**만 인정한다:
/// - argv에서 `--mcp-config`가 처음 나오는 자리를 i라 할 때 `argv[i..i+4] == ["--mcp-config", M, "--settings", S]`(M은 관문 폴더의 mcp.json, S는 settings.json)
/// - i는 1이거나, 2이면서 argv[1]이 CLI 스크립트(`/@anthropic-ai/claude-code/`가 든 경로. node가 띄운 꼴)일 때뿐이다.
///   자체 CLI 세션(`self_agent`에 서버가 정한 로더·진입점의 절대 경로를 준다)이면 실행기가 띄운 꼴 `[실행기, "--import", <로더>, <진입점>, "--mcp-config", …]`의
///   i=4도 인정한다. 로더·진입점은 **정확히 같은 글**이어야 한다(끝 글자로 맞추면 아무 폴더의 `…/tsx/dist/loader.mjs`가 임의 코드를 "붙은 CLI"로 통과시킨다).
///   `self_agent`가 없으면(claude 세션) 이 자리는 열리지 않는다
/// - argv 전체에서 `--settings`·`--settings=…` 요소가 그 하나뿐이다(사용자가 덧붙인 덮어쓰기는 붙지 않은 것)
///
/// 요청 글처럼 한 요소 안에 섞인 `--settings`는 세지 않는다(ps 한 줄은 따옴표를 잃어 가르지 못했다). `--`(그 뒤는 요청 글)나 값을 받는 다른 옵션(`--model --settings S`)이 `--settings`를 값으로
/// 먹는 꼴은 자리가 맞지 않아 인정하지 않는다. `--settings=<S>` 꼴은 감싸개가 쓰지 않으므로 인정하지 않는다
pub fn hooked_argv(argv: &[String], settings_path: &str, mcp_path: &str, self_agent: Option<(&str, &str)>) -> bool {
    if argv.iter().filter(|element| *element == "--settings" || element.starts_with("--settings=")).count() != 1 {
        return false;
    }
    let Some(at) = argv.iter().position(|element| element == "--mcp-config") else { return false };
    let self_agent = self_agent.is_some_and(|(loader, entry)| {
        at == 4 && argv.get(1).is_some_and(|flag| flag == "--import") && argv.get(2).is_some_and(|given| given == loader) && argv.get(3).is_some_and(|given| given == entry)
    });
    let slot_ok = at == 1 || (at == 2 && argv.get(1).is_some_and(|script| script.contains(CLAUDE_PACKAGE_MARK))) || self_agent;
    slot_ok && argv.get(at..at + 4).is_some_and(|four| four[1] == mcp_path && four[2] == "--settings" && four[3] == settings_path)
}

/// 트리를 앞 순서로 훑어 `keep`이 참인 프로세스의 pid를 모은다. 같은 pid는 한 번만 본다. 깊이가 깊어도 넘치지 않게 스택을 직접 둔다
fn walk_tree(root: i64, processes: &[Process], keep: &dyn Fn(&Process) -> bool) -> Vec<i64> {
    let mut children: HashMap<i64, Vec<&Process>> = HashMap::new();
    for process in processes {
        children.entry(process.ppid).or_default().push(process);
    }
    let mut found = Vec::new();
    let mut seen: BTreeSet<i64> = BTreeSet::from([root]);
    let mut stack: Vec<(i64, usize)> = vec![(root, 0)];
    while let Some((pid, next)) = stack.pop() {
        let Some(list) = children.get(&pid) else { continue };
        let Some(child) = list.get(next) else { continue };
        stack.push((pid, next + 1));
        if !seen.insert(child.pid) {
            continue;
        }
        if keep(child) {
            found.push(child.pid);
        }
        stack.push((child.pid, 0));
    }
    found
}

/// root(PTY의 pid) 아래에서 도는 에이전트 CLI로 보이는 프로세스의 pid(ps 한 줄로, 넓게: 거부 목록 쪽). 감시는 이 후보마다 진짜 argv를 읽어 `hooked_argv`로 가른다.
/// root를 모르면(2보다 작다) `None`이다
pub fn cli_candidates(root: i64, processes: &[Process], kind: CliKind, cli_path: &str) -> Option<Vec<i64>> {
    if root < 2 {
        return None;
    }
    Some(walk_tree(root, processes, &|process| looks_like_agent_cli(&process.args, cli_path, kind)))
}

/// root(PTY의 pid) 아래에서 도는 에이전트 CLI 중 우리 설정이 붙지 않은 것의 pid(트리를 앞 순서로 훑은 차례)를 **ps 한 줄**로 판정한다.
/// 감시의 claude는 이 판정을 쓰지 않고 진짜 argv를 쓴다(`cli_candidates`·`hooked_argv`). 이 함수는 codex(실험, 옛 규칙)와 argv를 읽지 못하는 자리의 차등 기준이다.
/// root를 모르면(2보다 작다: 0은 모든 프로세스의 부모 자리이고 1은 init이다) `None`이다 — 찾을 수 없다는 뜻이다. 빈 목록(찾아 보니 없다)과 다르다
pub fn find_unhooked_cli(root: i64, processes: &[Process], kind: CliKind, cli_path: &str, marker: &str) -> Option<Vec<i64>> {
    if root < 2 {
        return None;
    }
    Some(walk_tree(root, processes, &|process| looks_like_agent_cli(&process.args, cli_path, kind) && !hooked(&process.args, marker, kind)))
}

// ── 감시 상태 전이 ──

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileState {
    /// 아직 한 번도 검사하지 않았다
    Unknown,
    /// 마지막 검사가 성공했고 관문 파일이 쓴 그대로이거나 되돌렸다
    Ok,
    /// 마지막 검사가 실패했다
    Failed,
    /// 바뀐 것을 찾았는데 되돌리지 못했다
    Unrestored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PsState {
    Unknown,
    Ok,
    Failed,
    /// 루트 pid를 몰라 검사할 수 없다
    Unavailable,
}

impl FileState {
    pub fn parse(text: &str) -> Self {
        match text {
            "unknown" => Self::Unknown,
            "ok" => Self::Ok,
            "unrestored" => Self::Unrestored,
            // 알아보지 못한 값은 실패로 읽는다(믿을 수 없다)
            _ => Self::Failed,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::Unrestored => "unrestored",
        }
    }
}

impl PsState {
    pub fn parse(text: &str) -> Self {
        match text {
            "unknown" => Self::Unknown,
            "ok" => Self::Ok,
            "unavailable" => Self::Unavailable,
            _ => Self::Failed,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchState {
    pub kind: CliKind,
    /// 이미 알린 pid(지금 살아 있는 것만 남긴다)
    pub warned: Vec<i64>,
    /// 마지막으로 성공한 프로세스 검사가 찾은 훅 없는 CLI
    pub live: Vec<i64>,
    pub file: FileState,
    pub file_failures: u32,
    pub file_reported: bool,
    /// `Unrestored`일 때 그 사유 글
    pub file_detail: String,
    pub ps: PsState,
    pub ps_failures: u32,
    pub ps_reported: bool,
}

impl WatchState {
    pub fn new(kind: CliKind) -> Self {
        Self {
            kind,
            warned: Vec::new(),
            live: Vec::new(),
            file: FileState::Unknown,
            file_failures: 0,
            file_reported: false,
            file_detail: String::new(),
            ps: PsState::Unknown,
            ps_failures: 0,
            ps_reported: false,
        }
    }
}

/// 관문 파일 검사의 결과
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileCheck {
    /// 검사가 던졌다
    Failed,
    /// 쓴 그대로다
    Clean,
    /// 바뀐 것을 찾았다. `restore_error`는 되돌리지 못했을 때의 사유다(되돌렸으면 `None`)
    Changed { names: Vec<String>, restore_error: Option<String> },
}

/// 프로세스 검사의 결과
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PsCheck {
    /// 루트 pid를 몰라 검사하지 않았다
    Unavailable,
    /// 목록을 읽지 못했다
    Failed,
    /// 읽었고 훅 없는 CLI가 이 pid들이다
    Listed(Vec<i64>),
}

pub const FILE_UNCHECKED: &str = "관문 파일을 확인하지 못했습니다";
pub const PS_UNCHECKED: &str = "터미널의 프로세스를 확인하지 못했습니다";
pub const PS_NO_ROOT: &str = "터미널의 프로세스 번호를 알 수 없어 훅 없이 뜬 CLI를 확인하지 못합니다";

fn changed_text(names: &[String]) -> String {
    format!("관문 파일이 바뀌어 되돌렸습니다: {}", names.join(", "))
}

fn unrestored_text(names: &[String], error: &str) -> String {
    format!("관문 파일이 바뀌었는데 되돌리지 못했습니다: {} ({})", names.join(", "), error)
}

fn unhooked_text(pid: i64, kind: CliKind) -> String {
    format!("검증이 붙지 않은 CLI가 터미널에서 돌고 있습니다(pid {pid}). 이 터미널의 {}는 b-studio가 붙여 주는 설정으로 띄워야 합니다", kind.as_str())
}

/// 한 번의 검사 결과를 상태에 넣는다. 돌려주는 것은 새 상태와 알릴 글(순서대로: 관문 파일, 프로세스)이다
pub fn watch_round(state: &WatchState, file: &FileCheck, ps: &PsCheck) -> (WatchState, Vec<String>) {
    let mut next = state.clone();
    let mut reports = Vec::new();
    match file {
        FileCheck::Failed => {
            next.file_failures += 1;
            next.file = FileState::Failed;
            next.file_detail.clear();
            if next.file_failures >= FAILURES_BEFORE_REPORT && !next.file_reported {
                next.file_reported = true;
                reports.push(FILE_UNCHECKED.to_owned());
            }
        }
        FileCheck::Clean => {
            next.file_failures = 0;
            next.file_reported = false;
            next.file = FileState::Ok;
            next.file_detail.clear();
        }
        FileCheck::Changed { names, restore_error } => {
            // 검사 자체는 돌았다. 연속 실패를 끊는다
            next.file_failures = 0;
            next.file_reported = false;
            match restore_error {
                None => {
                    next.file = FileState::Ok;
                    next.file_detail.clear();
                    reports.push(changed_text(names));
                }
                Some(error) => {
                    let text = unrestored_text(names, error);
                    next.file = FileState::Unrestored;
                    next.file_detail = text.clone();
                    reports.push(text);
                }
            }
        }
    }
    match ps {
        PsCheck::Unavailable => {
            // 한 번만 알린다(할 수 없음으로 들어올 때). 실패를 세는 표시와 섞지 않는다
            if next.ps != PsState::Unavailable {
                reports.push(PS_NO_ROOT.to_owned());
            }
            next.ps = PsState::Unavailable;
        }
        PsCheck::Failed => {
            next.ps_failures += 1;
            next.ps = PsState::Failed;
            if next.ps_failures >= FAILURES_BEFORE_REPORT && !next.ps_reported {
                next.ps_reported = true;
                reports.push(PS_UNCHECKED.to_owned());
            }
        }
        PsCheck::Listed(pids) => {
            next.ps_failures = 0;
            next.ps_reported = false;
            next.ps = PsState::Ok;
            // 사라진 pid는 알린 목록에서 지운다. 번호를 다시 쓰는 새 CLI를 알리게 한다
            next.warned.retain(|pid| pids.contains(pid));
            for pid in pids {
                if next.warned.contains(pid) {
                    continue;
                }
                next.warned.push(*pid);
                reports.push(unhooked_text(*pid, next.kind));
            }
            next.live = pids.clone();
        }
    }
    (next, reports)
}

/// 지금 살아 있는 위반: 새로 열리는 실행에 다시 적는다. 되돌리지 못한 관문 파일, 연달아 실패한 검사(이미 알렸다), 훅 없는 CLI
pub fn live_violations(state: &WatchState) -> Vec<String> {
    let mut out = Vec::new();
    if state.file == FileState::Unrestored {
        out.push(state.file_detail.clone());
    }
    if state.file_failures >= FAILURES_BEFORE_REPORT {
        out.push(FILE_UNCHECKED.to_owned());
    }
    if state.ps_failures >= FAILURES_BEFORE_REPORT {
        out.push(PS_UNCHECKED.to_owned());
    }
    for pid in &state.live {
        out.push(unhooked_text(*pid, state.kind));
    }
    out
}

/// 감시를 믿을 수 있는가: 비어 있으면 믿을 수 있다. 한 번도 검사하지 않았거나 마지막 검사가 실패했거나 루트 pid를 모르면 사유가 있다(모르면 통과가 아니다)
pub fn health_problems(state: &WatchState) -> Vec<String> {
    let mut out = Vec::new();
    match state.file {
        FileState::Ok => {}
        FileState::Unknown => out.push("관문 파일을 아직 확인하지 못했습니다".to_owned()),
        FileState::Failed => out.push(FILE_UNCHECKED.to_owned()),
        FileState::Unrestored => out.push(if state.file_detail.is_empty() { "관문 파일이 바뀌었는데 되돌리지 못했습니다".to_owned() } else { state.file_detail.clone() }),
    }
    match state.ps {
        PsState::Ok => {}
        PsState::Unknown => out.push("터미널의 프로세스를 아직 확인하지 못했습니다".to_owned()),
        PsState::Failed => out.push(PS_UNCHECKED.to_owned()),
        PsState::Unavailable => out.push(PS_NO_ROOT.to_owned()),
    }
    out
}

// ── 훅 본문 읽기 ──

/// 훅 요청 본문이 어떻게 읽히는가
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookBodyKind {
    /// 본문이 없다(옛 코드는 `{}`로 읽었다)
    Empty,
    /// JSON 객체다(배열이 아니다)
    Object,
    /// JSON이지만 객체가 아니다(배열·글·수·참거짓·null)
    NotObject,
    /// JSON이 아니다(깨진 글자·문법 밖·깊이 상한 밖)
    Invalid,
}

impl HookBodyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Object => "object",
            Self::NotObject => "not_object",
            Self::Invalid => "invalid",
        }
    }
}

/// 본문 바이트를 `Buffer.toString('utf8')`와 `JSON.parse`처럼 읽어 종류를 가른다. 깨진 UTF-8은 U+FFFD로 읽는다(Node와 같다).
/// JS가 읽는데 이 읽기가 읽지 못하는 입력(깊이 상한 밖)은 `Invalid`다 — 부른 쪽이 거절하는 쪽이다
pub fn hook_body_kind(bytes: &[u8]) -> HookBodyKind {
    let text = String::from_utf8_lossy(bytes);
    if text.is_empty() {
        return HookBodyKind::Empty;
    }
    match js_json::parse(&text) {
        Ok(JsValue::Obj(_)) => HookBodyKind::Object,
        Ok(_) => HookBodyKind::NotObject,
        Err(_) => HookBodyKind::Invalid,
    }
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
