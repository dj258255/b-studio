//! 세션 터미널의 감시(관문 파일 변조와 훅 없이 뜬 CLI를 찾는 일)의 판정(ADR-219, 4f B5e). 옛 구현은 `session-terminal.ts`의 `HOST_BACKEND.watch`(상태 변수들)와
//! `packages/sandbox/src/host-terminal.ts`의 `findUnhookedCli`·`looksLikeAgentCli`, `packages/agent/src/hook-server.ts`의 본문 읽기였다
//! (`session-terminal-watch-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다. `ps`·파일 읽기·`fs.watch`·타이머는 TS가 하고, 여기는 **무엇을 알리고, 지금 무엇이 살아 있고,
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

    fn package_mark(self) -> &'static str {
        match self {
            Self::Claude => CLAUDE_PACKAGE_MARK,
            Self::Codex => CODEX_PACKAGE_MARK,
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
    }
}

/// root(PTY의 pid) 아래에서 도는 에이전트 CLI 중 우리 설정이 붙지 않은 것의 pid(트리를 앞 순서로 훑은 차례).
/// root를 모르면(2보다 작다: 0은 모든 프로세스의 부모 자리이고 1은 init이다) `None`이다 — 찾을 수 없다는 뜻이다. 빈 목록(찾아 보니 없다)과 다르다
pub fn find_unhooked_cli(root: i64, processes: &[Process], kind: CliKind, cli_path: &str, marker: &str) -> Option<Vec<i64>> {
    if root < 2 {
        return None;
    }
    let mut children: HashMap<i64, Vec<&Process>> = HashMap::new();
    for process in processes {
        children.entry(process.ppid).or_default().push(process);
    }
    let mut found = Vec::new();
    let mut seen: BTreeSet<i64> = BTreeSet::from([root]);
    // 직계 자식뿐 아니라 손자(셸 → 셸 → claude)까지 본다. 같은 pid를 두 번 보지 않는다. 깊이가 깊어도 넘치지 않게 스택을 직접 둔다
    let mut stack: Vec<(i64, usize)> = vec![(root, 0)];
    while let Some((pid, next)) = stack.pop() {
        let Some(list) = children.get(&pid) else { continue };
        let Some(child) = list.get(next) else { continue };
        stack.push((pid, next + 1));
        if !seen.insert(child.pid) {
            continue;
        }
        if looks_like_agent_cli(&child.args, cli_path, kind) && !hooked(&child.args, marker, kind) {
            found.push(child.pid);
        }
        stack.push((child.pid, 0));
    }
    Some(found)
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
