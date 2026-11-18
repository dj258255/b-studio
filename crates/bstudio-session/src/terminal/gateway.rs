//! 이 컴퓨터 방식 터미널의 관문 글 생성(ADR-173, ADR-219, 4f C1 5단계). 옛 구현은 `packages/sandbox/src/host-terminal.ts`의
//! `shellQuote`·`firstPromptArg`·`resumeConversationArg`·`cliModelArg`·`hostTerminalEnv`·`hostGatewaySettings`·`hostCliWrapper`·
//! `hostZshFiles`·`hostBashRc`·`hostTerminalCommand`·`hostFallbackCommand`이고, 관문의 훅 답 꼴은
//! `apps/studio/lib/server/terminal-gateway.ts`의 `hookRoutes`다(`host-terminal-legacy.ts`·`terminal-gateway-legacy.ts`가 차등 시험의 기준이다).
//! Node를 모른다. 파일을 쓰고 지우는 일은 `bstudio_io::host_gateway`가 한다.
//!
//! **셸 주입·옵션 주입을 막는 자리다.** 따옴표·작은따옴표·`$`·백틱·줄바꿈·NUL·`-`로 시작하는 글·유니코드를 넣어 옛 구현과 견준다.
//! - `shell_quote`: 작은따옴표로 감싸고 안의 작은따옴표만 `'\''`로 끊는다. 셸이 다른 뜻으로 읽는 글자가 없다
//! - `first_prompt_arg`: 옵션(`-`)이나 하위 명령(빈칸 없는 한 낱말)으로 읽히지 않게 앞말을 붙인다. NUL은 환경 변수로 넘길 수 없어 거절한다
//! - `resume_conversation_arg`·`cli_model_arg`: 인자로 그대로 가므로 꼴을 좁게 맞춘다(여는 쪽이라 좁게)
//!
//! **감싸개 인자 순서를 바꾸지 않는다.** 감시 판정(`terminal::watch::hooked_argv`)이 `<cli> --mcp-config <M> --settings <S>`라는
//! 정확한 자리를 본다(ADR-219). 순서를 바꾸면 판정도 같이 바꿔야 한다.
//!
//! 글은 옛 TS와 바이트까지 같게 만든다. 화면·셸·파일에 그대로 들어가고, `check_gateway_config`가 쓴 그대로인지 견주기 때문이다.
//! JSON은 `bstudio_guard::js_json`이 `JSON.stringify(..., null, 2)`와 같은 꼴로 쓴다.

use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsObject, JsValue};
use std::path::Path;

/** 이 컴퓨터 방식 CLI. 실험 갈래(codex)도 글 생성 규칙은 같다 */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliKind {
    Claude,
    Codex,
}

impl CliKind {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

/// 옛 `SandboxError`가 화면에 내던 글. `title`과 `detail`을 나눠 두어 TS가 같은 꼴로 다시 만든다
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayError {
    pub title: String,
    pub detail: Option<String>,
}

impl GatewayError {
    fn new(title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            detail: Some(detail.into()),
        }
    }
}

pub const SETTINGS_FILE: &str = "settings.json";
pub const MCP_FILE: &str = "mcp.json";
pub const WRAPPER_DIR: &str = "bin";
pub const HOOK_SCRIPT_NAME: &str = "b-studio-hook.mjs";
pub const FIRST_PROMPT_ENV: &str = "B_STUDIO_FIRST_PROMPT";
pub const RESUME_CONVERSATION_ENV: &str = "B_STUDIO_RESUME_ID";
pub const CLI_MODEL_ENV: &str = "B_STUDIO_CLI_MODEL";
pub const SHELL_STARTED_VAR: &str = "BSTUDIO_TERMINAL_STARTED";
pub const ACCOUNT_DIR_ENV_CLAUDE: &str = "CLAUDE_CONFIG_DIR";
pub const ACCOUNT_DIR_ENV_CODEX: &str = "CODEX_HOME";

const FIRST_PROMPT_VAR: &str = "BSTUDIO_FIRST_PROMPT_VALUE";
const RESUME_CONVERSATION_VAR: &str = "BSTUDIO_RESUME_ID_VALUE";
const CLI_MODEL_VAR: &str = "BSTUDIO_CLI_MODEL_VALUE";
/** 첫 요청 글의 길이 상한. 화면의 붙여 넣기 상한(8천 자)에 앞말이 붙어도 넘지 않게 잡는다 */
const FIRST_PROMPT_MAX: usize = 10_000;

/** 셸 명령에 넣을 글을 작은따옴표로 감싼다. 경로에 빈칸이나 따옴표가 있어도 한 덩어리로 읽힌다 */
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/** JS `String.prototype.length`(UTF-16 코드 단위) */
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn has_js_whitespace(text: &str) -> bool {
    text.chars().any(js::is_js_whitespace)
}

/**
 * CLI 실행 인자로 넘길 첫 요청 글. 옵션(`-`로 시작)이나 하위 명령(`update`처럼 빈칸 없는 한 낱말)으로 읽히지 않게 앞에 "요청: "을 붙인다.
 * `--`로 옵션을 끝내는 길은 쓰지 않는다: claude(commander)는 `--` 뒤의 첫 낱말도 하위 명령으로 맞춰 본다
 */
pub fn first_prompt_arg(text: &str) -> Result<String, GatewayError> {
    let body = js::trim(text);
    if body.is_empty() {
        return Err(GatewayError::new(
            "첫 요청 글이 비어 있습니다",
            "빈 글은 CLI에 넘기지 않습니다",
        ));
    }
    if body.contains('\0') {
        return Err(GatewayError::new(
            "첫 요청 글에 NUL 문자가 있습니다",
            "환경 변수로 넘길 수 없습니다",
        ));
    }
    if js_length(body) > FIRST_PROMPT_MAX {
        return Err(GatewayError::new(
            "첫 요청 글이 너무 깁니다",
            format!("{FIRST_PROMPT_MAX}자까지 넘깁니다"),
        ));
    }
    if body.starts_with('-') || !has_js_whitespace(body) {
        Ok(format!("요청: {body}"))
    } else {
        Ok(body.to_owned())
    }
}

/** 이어 붙일 수 있는 꼴의 대화 id인가. 훅으로 온 값을 기억하기 전에 본다 */
pub fn is_resumable_conversation(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    let allowed = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    bytes[0].is_ascii_alphanumeric() && bytes[1..].iter().all(|b| allowed(*b))
}

/** CLI 실행 인자로 넘길 대화 id. 꼴이 맞지 않으면 거절한다(훅으로 온 값이라 바깥에서 온 값이다) */
pub fn resume_conversation_arg(id: &str) -> Result<String, GatewayError> {
    if !is_resumable_conversation(id) {
        return Err(GatewayError::new(
            "이어 붙일 대화 id의 꼴이 맞지 않습니다",
            "영문·숫자·밑줄·붙임표로 된 128자 이하의 id만 넘깁니다",
        ));
    }
    Ok(id.to_owned())
}

fn is_model_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'[' | b']' | b'-')
}

/** CLI 실행 인자로 넘길 모델 id. 꼴이 맞지 않으면 거절한다 */
pub fn cli_model_arg(model: &str) -> Result<String, GatewayError> {
    let bytes = model.as_bytes();
    let ok = !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|b| is_model_char(*b));
    if !ok {
        return Err(GatewayError::new(
            "CLI에 넘길 모델 id의 꼴이 맞지 않습니다",
            "영문·숫자로 시작하고 . _ : / [ ] - 만 쓴 128자 이하의 id만 넘깁니다",
        ));
    }
    Ok(model.to_owned())
}

/** 터미널로 그대로 넘기는 이름. 나머지(PATH의 실제 내용, 버전 관리자, 프록시 등)는 사용자의 로그인 셸이 시작 파일로 만든다 */
const TERMINAL_ENV_NAMES: [&str; 12] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TMPDIR",
    "TZ",
    "SSH_AUTH_SOCK",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "__CF_USER_TEXT_ENCODING",
];
/** 앞머리로 넘기는 이름 */
const TERMINAL_ENV_PREFIXES: [&str; 2] = ["LC_", "XDG_"];
/** 터미널의 PATH. 감싸개 폴더가 있으면 그 앞에 두고, 스튜디오 프로세스의 PATH는 넘기지 않는다 */
const TERMINAL_PATH: [&str; 5] = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/** B_STUDIO_TERMINAL_ENV: 터미널에 더 넘길 환경 변수 이름. 쉼표로 구분하고, 빈 것은 건너뛰고, 틀린 이름은 거절한다 */
fn extra_terminal_env_names(env: &[(String, String)]) -> Result<Vec<String>, GatewayError> {
    let Some((_, raw)) = env.iter().find(|(key, _)| key == "B_STUDIO_TERMINAL_ENV") else {
        return Ok(Vec::new());
    };
    let raw = js::trim(raw);
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for piece in raw.split(',') {
        let name = js::trim(piece);
        if name.is_empty() {
            continue;
        }
        if !valid_env_name(name) || name.starts_with("B_STUDIO_") {
            return Err(GatewayError::new(
                "B_STUDIO_TERMINAL_ENV에 쓸 수 없는 환경 변수 이름이 있습니다",
                format!(
                    "{name} — 영문·숫자·밑줄로 된 이름이어야 하고 B_STUDIO_로 시작할 수 없습니다"
                ),
            ));
        }
        names.push(name.to_owned());
    }
    Ok(names)
}

/**
 * 터미널에 넘길 환경. 스튜디오 프로세스의 환경을 그대로 내려보내지 않고 **허용한 이름만** 넘긴다.
 * 스튜디오를 에이전트 CLI 안에서 띄우면 `CLAUDECODE`·`CLAUDE_CODE_*` 표식이 터미널의 CLI까지 내려가 안쪽 세션으로 오해되고,
 * pnpm이 끼운 PATH(`node_modules/.bin`)와 `NODE_ENV` 등도 함께 내려간다. 나머지는 사용자의 로그인 셸이 시작 파일로 만든다
 */
pub fn host_terminal_env(
    gateway_dir: Option<&str>,
    env: &[(String, String)],
) -> Result<Vec<(String, String)>, GatewayError> {
    let extra = extra_terminal_env_names(env)?;
    let wanted: std::collections::HashSet<&str> = TERMINAL_ENV_NAMES
        .iter()
        .copied()
        .chain(extra.iter().map(String::as_str))
        .collect();
    let mut result: Vec<(String, String)> = Vec::new();
    let set = |key: &str, value: &str, result: &mut Vec<(String, String)>| {
        if let Some(slot) = result.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value.to_owned();
        } else {
            result.push((key.to_owned(), value.to_owned()));
        }
    };
    for (key, value) in env {
        if wanted.contains(key.as_str())
            || TERMINAL_ENV_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix))
        {
            result.push((key.clone(), value.clone()));
        }
    }
    set("TERM", "xterm-256color", &mut result);
    set("COLORTERM", "truecolor", &mut result);
    let path = match gateway_dir.filter(|dir| !dir.is_empty()) {
        Some(dir) => {
            let mut parts = vec![Path::new(dir)
                .join(WRAPPER_DIR)
                .to_string_lossy()
                .into_owned()];
            parts.extend(TERMINAL_PATH.iter().map(|part| (*part).to_owned()));
            parts.join(":")
        }
        None => TERMINAL_PATH.join(":"),
    };
    set("PATH", &path, &mut result);
    Ok(result)
}

fn obj(pairs: Vec<(&str, JsValue)>) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in pairs {
        object.set(key, value);
    }
    JsValue::Obj(object)
}

fn string(text: impl Into<String>) -> JsValue {
    JsValue::Str(text.into())
}

fn array(items: Vec<JsValue>) -> JsValue {
    JsValue::Arr(items)
}

fn hook_object(command: &str, timeout: u32, observe: bool) -> JsValue {
    let mut object = JsObject::new();
    object.set("type", string("command"));
    object.set("command", string(command));
    object.set("timeout", JsValue::Num(f64::from(timeout)));
    if observe {
        object.set("async", JsValue::Bool(true));
    }
    JsValue::Obj(object)
}

fn hook_settings(hook_command: &dyn Fn(&str) -> String) -> JsValue {
    let hook = |event: &str| hook_object(&hook_command(event), hook_timeout(event), false);
    let observe = |event: &str| hook_object(&hook_command(event), hook_timeout(event), true);
    obj(vec![
        (
            "SessionStart",
            array(vec![obj(vec![(
                "hooks",
                array(vec![hook("session-start")]),
            )])]),
        ),
        (
            "UserPromptSubmit",
            array(vec![obj(vec![("hooks", array(vec![hook("prompt")]))])]),
        ),
        (
            "PreToolUse",
            array(vec![
                obj(vec![
                    ("matcher", string(AGENT_WRITE_TOOL_MATCHER)),
                    ("hooks", array(vec![hook("pre-tool")])),
                ]),
                // 읽기 도구는 기다리지 않고 지켜보기만 한다(#920). 화면의 "지금 하는 일"과 할 일 목록(TodoWrite)에 쓴다
                obj(vec![
                    ("matcher", string(AGENT_READ_TOOL_MATCHER)),
                    ("hooks", array(vec![observe("activity")])),
                ]),
            ]),
        ),
        (
            "Stop",
            array(vec![obj(vec![("hooks", array(vec![hook("stop")]))])]),
        ),
        (
            "SessionEnd",
            array(vec![obj(vec![("hooks", array(vec![hook("session-end")]))])]),
        ),
        // API 오류로 턴이 끝나면 Stop 대신 온다(#1284). 없으면 실행이 열린 채 남아 다음 요청을 삼킨다
        (
            "StopFailure",
            array(vec![obj(vec![(
                "hooks",
                array(vec![hook("stop-failure")]),
            )])]),
        ),
        // 사람을 기다리는 창이 뜨면 알린다(B7). matcher는 입력의 notification_type을 본다
        (
            "Notification",
            array(vec![obj(vec![
                ("matcher", string(AGENT_NOTIFICATION_MATCHER)),
                ("hooks", array(vec![hook("notification")])),
            ])]),
        ),
        // 권한 확인 창이 뜨는 그 순간 알린다(#920). Notification의 permission_prompt는 몇 초 늦게 온다. 답은 주지 않는다
        (
            "PermissionRequest",
            array(vec![obj(vec![(
                "hooks",
                array(vec![observe("notification")]),
            )])]),
        ),
        // 지켜보기만 하는 훅(#920): 도구의 끝, 서브에이전트, 할 일
        (
            "PostToolUse",
            array(vec![obj(vec![("hooks", array(vec![observe("activity")]))])]),
        ),
        (
            "PostToolUseFailure",
            array(vec![obj(vec![("hooks", array(vec![observe("activity")]))])]),
        ),
        (
            "SubagentStart",
            array(vec![obj(vec![("hooks", array(vec![observe("activity")]))])]),
        ),
        (
            "SubagentStop",
            array(vec![obj(vec![("hooks", array(vec![observe("activity")]))])]),
        ),
        (
            "TaskCreated",
            array(vec![obj(vec![("hooks", array(vec![observe("activity")]))])]),
        ),
        (
            "TaskCompleted",
            array(vec![obj(vec![("hooks", array(vec![observe("activity")]))])]),
        ),
    ])
}

fn agent_telemetry_env(hook_url: &str, hook_token: &str) -> JsValue {
    obj(vec![
        ("CLAUDE_CODE_ENABLE_TELEMETRY", string("1")),
        ("OTEL_LOGS_EXPORTER", string("otlp")),
        ("OTEL_METRICS_EXPORTER", string("none")),
        ("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", string("http/json")),
        (
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            string(format!("{hook_url}/v1/logs")),
        ),
        (
            "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
            string(format!("Authorization=Bearer {hook_token}")),
        ),
        ("OTEL_LOGS_EXPORT_INTERVAL", string("1000")),
    ])
}

/** 훅의 종류 → 기다리는 시간(초). `agent-terminal.ts`의 AGENT_HOOK_EVENTS와 같아야 한다 */
fn hook_timeout(event: &str) -> u32 {
    match event {
        "session-start" => 15,
        "prompt" => 60,
        "pre-tool" => 1800,
        "stop" => 3600,
        "session-end" => 10,
        "stop-failure" => 120,
        "notification" => 15,
        "activity" => 5,
        "statusline" => 3,
        _ => 0,
    }
}

const AGENT_NOTIFICATION_MATCHER: &str =
    "permission_prompt|elicitation_dialog|agent_needs_input|idle_prompt";
/** 쓰기 직전의 훅을 거는 도구 이름의 패턴: 읽기 도구가 아닌 모든 것 */
const AGENT_WRITE_TOOL_MATCHER: &str = concat!(
    "^(?!(?:",
    "Read|Glob|Grep|WebFetch|WebSearch|TodoWrite|ToolSearch|AskUserQuestion|Agent|Task",
    ")$).+"
);
/** 읽기 도구에만 거는 패턴(#920). 쓰기 직전의 훅과 겹치지 않는다 — 한 도구에는 둘 중 하나만 걸린다 */
const AGENT_READ_TOOL_MATCHER: &str = concat!(
    "^(?:",
    "Read|Glob|Grep|WebFetch|WebSearch|TodoWrite|ToolSearch|AskUserQuestion|Agent|Task",
    ")$"
);

/// 이 컴퓨터용 CLI 설정 JSON(`settings.json`의 내용). `JSON.stringify(settings, null, 2)`와 같은 글자다(끝의 줄바꿈은 부르는 쪽이 붙인다)
pub fn host_gateway_settings_json(
    dir: &str,
    node_path: &str,
    hook_url: &str,
    hook_token: &str,
) -> String {
    let script = Path::new(dir)
        .join(HOOK_SCRIPT_NAME)
        .to_string_lossy()
        .into_owned();
    let hook_command = |event: &str| {
        format!(
            "{} {} {event}",
            shell_quote(node_path),
            shell_quote(&script)
        )
    };
    let value = obj(vec![
        // b-studio 도구는 서비스 컨테이너 안에서 돌고 b-studio의 실행 정책을 거친다. 호출마다 묻지 않게 한다
        (
            "permissions",
            obj(vec![("allow", array(vec![string("mcp__b-studio")]))]),
        ),
        // 훅을 통째로 끄지 못하게 여기서 값을 정해 둔다. 이 컴퓨터 방식에서는 작업 복사본의 프로젝트 설정이 에이전트가 쓸 수 있는 자리다
        ("disableAllHooks", JsValue::Bool(false)),
        ("env", agent_telemetry_env(hook_url, hook_token)),
        ("hooks", hook_settings(&hook_command)),
        // 문맥 창을 아는 곳은 상태 줄의 입력뿐이다(#920). 훅 스크립트가 받아 관문에 알리고, 사용자의 원래 상태 줄이 있으면 이어 부른다
        (
            "statusLine",
            obj(vec![
                ("type", string("command")),
                ("command", string(hook_command("statusline"))),
            ]),
        ),
    ]);
    js_json::stringify_indent(&value, 2, &|s: &str| js::json_quote(s))
}

fn account_export(kind: CliKind, config_dir: Option<&str>) -> Vec<String> {
    match config_dir {
        Some(dir) => {
            let name = match kind {
                CliKind::Claude => ACCOUNT_DIR_ENV_CLAUDE,
                CliKind::Codex => ACCOUNT_DIR_ENV_CODEX,
            };
            vec![format!("export {name}={}", shell_quote(dir))]
        }
        None => Vec::new(),
    }
}

/**
 * 인자를 붙여 CLI를 부르는 claude 감싸개. 터미널의 PATH 맨 앞에 놓여, 터미널에서 `claude`를 어떻게 띄우든(다시 띄우거나 `--resume`을 주거나)
 * 훅과 b-studio 도구가 붙는다. 사용자가 준 인자는 그대로 넘긴다.
 * `--mcp-config`는 값을 여러 개 받는다(`<configs...>`). 첫 낱말(요청 글)을 설정 파일로 먹지 않게 `--settings`를 뒤에 둔다(#836).
 * 감시가 이 정확한 자리(`<cli> --mcp-config M --settings S`)로 붙었는지 판정한다(ADR-219). 순서를 바꾸지 않는다
 */
pub fn host_cli_wrapper(dir: &str, claude_path: &str, config_dir: Option<&str>) -> String {
    let mcp = Path::new(dir).join(MCP_FILE).to_string_lossy().into_owned();
    let settings = Path::new(dir)
        .join(SETTINGS_FILE)
        .to_string_lossy()
        .into_owned();
    let mut lines = vec![
        "#!/bin/sh".to_owned(),
        "# b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.".to_owned(),
    ];
    // 세션의 계정(#885). 사용자의 시작 파일이 같은 변수를 정해도 이 세션의 CLI는 고른 계정으로 뜬다
    lines.extend(account_export(CliKind::Claude, config_dir));
    lines.push(format!(
        "exec {} --mcp-config {} --settings {} \"$@\"",
        shell_quote(claude_path),
        shell_quote(&mcp),
        shell_quote(&settings)
    ));
    lines.push(String::new());
    lines.join("\n")
}

fn shell_started_notice(kind: CliKind) -> String {
    format!(
        "[b-studio] {}에서 나왔습니다. 다시 띄우려면 {} 를 입력하세요.",
        kind.as_str(),
        kind.as_str()
    )
}

fn resume_failed_notice(kind: CliKind) -> String {
    format!(
        "[b-studio] 지난 대화를 이어 붙이지 못했습니다. '{}'를 치면 새 대화로 시작합니다.",
        kind.as_str()
    )
}

/** 받은 첫 요청과 대화 id와 모델을 셸 변수로 옮기고 환경에서 지운다. 사용자의 시작 파일보다 먼저 돈다 */
fn first_prompt_capture() -> Vec<String> {
    let capture = |env: &str, var: &str| {
        vec![
            format!("if [ -n \"${{{env}+x}}\" ]; then"),
            format!("  {var}=\"${env}\""),
            format!("  unset {env}"),
            "fi".to_owned(),
        ]
    };
    [
        capture(FIRST_PROMPT_ENV, FIRST_PROMPT_VAR),
        capture(RESUME_CONVERSATION_ENV, RESUME_CONVERSATION_VAR),
        capture(CLI_MODEL_ENV, CLI_MODEL_VAR),
    ]
    .concat()
}

fn cli_model_expression() -> String {
    format!("${{{CLI_MODEL_VAR}:+\"--model=${CLI_MODEL_VAR}\"}}")
}

fn first_launch(command: &str, kind: CliKind, indent: &str) -> Vec<String> {
    let model = cli_model_expression();
    let resume = match kind {
        CliKind::Codex => format!("{command} resume {model} \"${RESUME_CONVERSATION_VAR}\""),
        CliKind::Claude => format!("{command} {model} --resume \"${RESUME_CONVERSATION_VAR}\""),
    };
    let lines = vec![
        format!("if [ -n \"${{{FIRST_PROMPT_VAR}+x}}\" ]; then"),
        format!("  {command} {model} \"${FIRST_PROMPT_VAR}\""),
        format!("elif [ -n \"${{{RESUME_CONVERSATION_VAR}+x}}\" ]; then"),
        format!(
            "  {resume} || printf '%s\\n' {}",
            shell_quote(&resume_failed_notice(kind))
        ),
        "else".to_owned(),
        format!("  {command} {model}"),
        "fi".to_owned(),
        format!("unset {FIRST_PROMPT_VAR} {RESUME_CONVERSATION_VAR} {CLI_MODEL_VAR}"),
    ];
    lines
        .into_iter()
        .map(|line| format!("{indent}{line}"))
        .collect()
}

fn zsh_start_file(name: &str, before: &[String], after: &[String]) -> String {
    let mut lines = vec![
        "# b-studio가 만든 파일입니다. 사용자의 시작 파일을 그대로 읽은 뒤 b-studio의 몇 줄을 더합니다.".to_owned(),
        "BSTUDIO_ZDOTDIR=\"$ZDOTDIR\"".to_owned(),
        "ZDOTDIR=\"${BSTUDIO_USER_ZDOTDIR:-$HOME}\"".to_owned(),
    ];
    lines.extend(before.iter().cloned());
    lines.push(format!(
        "[ -r \"$ZDOTDIR/{name}\" ] && . \"$ZDOTDIR/{name}\""
    ));
    lines.push("# 사용자의 파일이 ZDOTDIR을 바꿨으면 그 값을 사용자의 것으로 기억한다".to_owned());
    lines.push("export BSTUDIO_USER_ZDOTDIR=\"$ZDOTDIR\"".to_owned());
    lines.push("ZDOTDIR=\"$BSTUDIO_ZDOTDIR\"".to_owned());
    lines.push("unset BSTUDIO_ZDOTDIR".to_owned());
    lines.extend(after.iter().cloned());
    lines.push(String::new());
    lines.join("\n")
}

fn wrapper_path(dir: &str, kind: CliKind) -> String {
    Path::new(dir)
        .join(WRAPPER_DIR)
        .join(kind.as_str())
        .to_string_lossy()
        .into_owned()
}

/** zsh의 관문 폴더에 둘 네 파일 → 내용 */
pub fn host_zsh_files(dir: &str, kind: CliKind) -> Vec<(String, String)> {
    let wrapper = shell_quote(&wrapper_path(dir, kind));
    let mut zlogin_after = vec![
        format!("if [[ -o interactive && -z \"${SHELL_STARTED_VAR}\" ]]; then"),
        format!("  export {SHELL_STARTED_VAR}=1"),
    ];
    zlogin_after.extend(first_launch(kind.as_str(), kind, "  "));
    zlogin_after.push(format!(
        "  print -r -- {}",
        shell_quote(&shell_started_notice(kind))
    ));
    zlogin_after.push("fi".to_owned());
    vec![
        // 첫 요청은 사용자의 .zshenv보다 먼저 환경에서 지운다(#836)
        (
            ".zshenv".to_owned(),
            zsh_start_file(".zshenv", &first_prompt_capture(), &[]),
        ),
        (
            ".zprofile".to_owned(),
            zsh_start_file(".zprofile", &[], &[]),
        ),
        (
            ".zshrc".to_owned(),
            zsh_start_file(
                ".zshrc",
                // macOS의 /etc/zshrc가 HISTFILE을 $ZDOTDIR 아래로 잡는다. 그대로 두면 명령 기록이 관문 폴더에 쌓였다가 지워진다
                &["HISTFILE=\"${BSTUDIO_USER_ZDOTDIR:-$HOME}/.zsh_history\"".to_owned()],
                // 별칭은 함수보다 먼저 풀린다. 사용자의 `alias claude=…`를 지우고 함수를 정의한다(PATH 순서와 무관하다)
                &[
                    format!("unalias {} 2>/dev/null", kind.as_str()),
                    format!("function {} {{ {wrapper} \"$@\"; }}", kind.as_str()),
                ],
            ),
        ),
        (
            ".zlogin".to_owned(),
            zsh_start_file(".zlogin", &[], &zlogin_after),
        ),
    ]
}

/** bash의 관문 폴더에 둘 시작 파일. 로그인 셸의 순서(/etc/profile, 그다음 사용자 파일 하나)를 흉내 낸다 */
pub fn host_bash_rc(dir: &str, kind: CliKind) -> String {
    let wrapper = shell_quote(&wrapper_path(dir, kind));
    let mut lines = vec![
        "# b-studio가 만든 파일입니다. 로그인 셸의 순서를 흉내 낸 뒤 b-studio의 몇 줄을 더합니다."
            .to_owned(),
    ];
    // 첫 요청은 시작 파일보다 먼저 환경에서 지운다(#836)
    lines.extend(first_prompt_capture());
    lines.extend([
        "[ -r /etc/profile ] && . /etc/profile".to_owned(),
        "if [ -r \"$HOME/.bash_profile\" ]; then . \"$HOME/.bash_profile\"".to_owned(),
        "elif [ -r \"$HOME/.bash_login\" ]; then . \"$HOME/.bash_login\"".to_owned(),
        "elif [ -r \"$HOME/.profile\" ]; then . \"$HOME/.profile\"".to_owned(),
        "fi".to_owned(),
        // 별칭은 함수보다 먼저 풀린다. 사용자의 `alias claude=…`를 지우고 함수를 정의한다(PATH 순서와 무관하다)
        format!("unalias {} 2>/dev/null", kind.as_str()),
        format!("function {} {{ {wrapper} \"$@\"; }}", kind.as_str()),
        format!("if [ -z \"${SHELL_STARTED_VAR}\" ]; then"),
        format!("  export {SHELL_STARTED_VAR}=1"),
    ]);
    lines.extend(first_launch(kind.as_str(), kind, "  "));
    lines.push(format!(
        "  printf '%s\\n' {}",
        shell_quote(&shell_started_notice(kind))
    ));
    lines.push("fi".to_owned());
    lines.push(String::new());
    lines.join("\n")
}

/** 터미널을 열면 도는 명령. CLI를 띄우고, CLI에서 나오면 이 컴퓨터의 셸로 남는다 */
pub fn host_terminal_command(kind: CliKind) -> String {
    let mut lines = vec![
        // Ctrl-C는 앞에서 도는 프로그램(CLI)과 이 셸에 함께 간다. 셸이 죽으면 터미널이 통째로 끝나므로 받아서 넘긴다
        "trap : INT".to_owned(),
    ];
    lines.extend(first_prompt_capture());
    lines.extend(first_launch(kind.as_str(), kind, ""));
    lines.push(format!(
        "printf \"%s\\n\" {}",
        js::json_quote(&shell_started_notice(kind))
    ));
    lines.push("exec \"${SHELL:-/bin/sh}\"".to_owned());
    lines.join("\n")
}

/** 셸 함수를 정의할 자리가 없는 셸(fish 등)의 대체 명령. 감싸개 절대 경로로 띄우고, 다시 띄울 때도 그 경로를 쓰라고 알린다 */
pub fn host_fallback_command(dir: &str, kind: CliKind) -> String {
    let safe = format!(
        "[b-studio] 이 셸에서는 {}를 다시 띄울 때 검증이 붙지 않을 수 있습니다. '{}'로 띄우세요.",
        kind.as_str(),
        wrapper_path(dir, kind)
    );
    let mut lines = vec![
        // Ctrl-C는 앞에서 도는 프로그램(CLI)과 이 셸에 함께 간다. 셸이 죽으면 터미널이 통째로 끝나므로 받아서 넘긴다
        "trap : INT".to_owned(),
    ];
    lines.extend(first_prompt_capture());
    lines.extend(first_launch(
        &shell_quote(&wrapper_path(dir, kind)),
        kind,
        "",
    ));
    lines.push(format!(
        "printf \"%s\\n\" {}",
        shell_quote(&shell_started_notice(kind))
    ));
    lines.push(format!("printf \"%s\\n\" {}", shell_quote(&safe)));
    lines.push("exec \"${SHELL:-/bin/sh}\"".to_owned());
    lines.join("\n")
}

// ── 관문의 훅 답 꼴 ──

/**
 * 훅 종류에 따른 CLI 답의 꼴. `kind`:
 * - `none` → `{}`
 * - `message` → `{systemMessage}`(빈 글은 `{}`). 사용자에게만 보이는 한 줄이다
 * - `block` → `{decision:'block', reason}`. 요청 시작·턴의 끝을 막는다
 * - `session_start` → SessionStart의 `additionalContext`
 * - `prompt_note` → UserPromptSubmit의 `additionalContext`
 * - `pre_tool_deny` → PreToolUse의 `permissionDecision:'deny'`
 *
 * 옛 `say`와 `hookRoutes`가 손으로 만들던 꼴 그대로다(키 순서 포함, `JSON.stringify`와 같은 글자)
 */
pub fn hook_response(kind: &str, text: Option<&str>) -> String {
    let text = text.unwrap_or("");
    let empty = || text.is_empty();
    let value = match kind {
        "message" => {
            if empty() {
                obj(vec![])
            } else {
                obj(vec![("systemMessage", string(text))])
            }
        }
        "block" => {
            if empty() {
                obj(vec![])
            } else {
                obj(vec![
                    ("decision", string("block")),
                    ("reason", string(text)),
                ])
            }
        }
        "session_start" => {
            if empty() {
                obj(vec![])
            } else {
                obj(vec![(
                    "hookSpecificOutput",
                    obj(vec![
                        ("hookEventName", string("SessionStart")),
                        ("additionalContext", string(text)),
                    ]),
                )])
            }
        }
        "prompt_note" => {
            if empty() {
                obj(vec![])
            } else {
                obj(vec![(
                    "hookSpecificOutput",
                    obj(vec![
                        ("hookEventName", string("UserPromptSubmit")),
                        ("additionalContext", string(text)),
                    ]),
                )])
            }
        }
        "pre_tool_deny" => {
            if empty() {
                obj(vec![])
            } else {
                obj(vec![(
                    "hookSpecificOutput",
                    obj(vec![
                        ("hookEventName", string("PreToolUse")),
                        ("permissionDecision", string("deny")),
                        ("permissionDecisionReason", string(text)),
                    ]),
                )])
            }
        }
        _ => obj(vec![]),
    };
    js_json::stringify(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_breaks_single_quotes() {
        assert_eq!(shell_quote("a b'c"), "'a b'\\''c'");
    }

    #[test]
    fn first_prompt_adds_prefix_only_when_needed() {
        assert_eq!(first_prompt_arg("고쳐 줘").unwrap(), "고쳐 줘");
        assert_eq!(first_prompt_arg("update").unwrap(), "요청: update");
        assert_eq!(first_prompt_arg("--x y").unwrap(), "요청: --x y");
        assert!(first_prompt_arg("   ").is_err());
        assert!(first_prompt_arg("a\0b c").is_err());
    }

    #[test]
    fn hook_response_matches_cli_shape() {
        assert_eq!(hook_response("none", None), "{}");
        assert_eq!(
            hook_response("message", Some("x")),
            "{\"systemMessage\":\"x\"}"
        );
        assert_eq!(
            hook_response("block", Some("x")),
            "{\"decision\":\"block\",\"reason\":\"x\"}"
        );
    }
}
