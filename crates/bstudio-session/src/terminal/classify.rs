//! 세션 터미널의 요청·도구 입력 분류(ADR-215, 4f B5a). 옛 구현은 `@b-studio/sandbox`의 `isReadOnlyPrompt`·`unwrapPastedPrompt`와 `sessions.ts`의 `/` 명령 판정·`AGENT_READ_TOOLS` 대조였다
//! (옛 구현 `session-terminal-classify-legacy.ts`는 #1347에서 지웠다). Node를 모른다. 순수 함수다: 글을 받아 분류만 돌려준다.
//!
//! **막는 검사다. 읽기만을 놓치는 쪽이 여는 쪽이다**(읽기만 요청의 쓰기가 허용된다). 그래서 의심스러우면 읽기만으로 읽는다:
//! - 붙여 넣은 요청의 감싸개 표시는 **더 벗길 것이 없을 때까지** 벗기고, 벗기는 단계마다 읽기만인지 본다. 하나라도 읽기만이면 읽기만이다.
//!   옛 서버는 두 번, 컨테이너 안의 훅 스크립트는 한 번 벗겼다. 이어 붙은 표시(`<pasted_content<pasted_content>>`)는 벗기면 새 표시가 생겨 단계마다 결과가 달랐다.
//! - 벗기기가 끝나지 않으면(단계 상한을 넘으면) 알아보지 못한 입력이라 읽기만이다.
//!
//! **JS와 같은 규칙으로 읽는다.** 옛 코드는 JS 정규식·`trim`·`normalize`였다. Rust의 `char::is_whitespace`는 JS의 `\s`·`trim`과 집합이 다르다(U+0085 NEL은 Rust만, U+FEFF BOM은 JS만 빈칸이다).
//! 그래서 빈칸 집합을 손으로 적는다(`is_js_space`). 감싸개 표시 맞추기는 정규식 없이 같은 문법을 손으로 옮겼다(시험이 벡터로 견준다).
//!
//! 의도한 차이(옛 코드와 다른 칸. 나머지는 같다):
//! - 읽기만: 감싸개를 끝까지 벗긴 단계 중 어느 하나라도 표시로 시작하면 읽기만이다(옛 서버는 2단계까지, 훅 스크립트는 1단계만 봤다)
//! - `/` 명령과 요청 글(`unwrapped`)은 옛 서버와 같이 감싸개를 한 번만 벗기고 JS `trim`으로 자른 글로 본다(`/` 판정은 막는 쪽이 아니라 "CLI 안에서 끝나는 명령"을 가르는 것이다)
//!
//! 고정한 칸(셋이 같게 읽고, 그래서 읽기만이 **아닌** 것으로 둔다. 시험이 목록으로 고정한다): 전각 대괄호(`［읽기만］`)·표시 안의 공백·영문 표시·대소문자 변형·`/` 앞의 보이지 않는 글자.

use unicode_normalization::UnicodeNormalization;

/// 읽기만 요청의 표시. 요청 글이 이것으로 시작하면 그 실행에서는 파일을 바꾸거나 명령을 돌리는 도구를 모두 거절한다(이슈 #689)
pub const READ_ONLY_MARK: &str = "[읽기만]";

/// 감싸개 벗기기의 단계 상한. 한 단계는 표시를 하나 이상 지우므로 정상 입력은 몇 단계 안에 끝난다
const UNWRAP_STEP_LIMIT: usize = 64;

/// 요청 글의 분류
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptClass {
    /// 읽기만 요청이다
    pub read_only: bool,
    /// 요청이 `/`로 시작한다(CLI 안에서 끝나는 명령). 감싸개를 한 번 벗기고 자른 글로 본다
    pub slash_command: bool,
    /// 감싸개 표시를 한 번 벗기고 앞뒤 빈칸을 자른 글(요청의 이름·세션 기록에 쓴다)
    pub unwrapped: String,
}

/// JS의 `\s`(와 `String.prototype.trim`)가 빈칸으로 보는 글자: 탭·VT·FF·공백·NBSP·BOM·유니코드 공백(Zs)·줄 끝(LF·CR·LS·PS)
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// 읽기만 표시 앞에 있어도 되는 글자: 빈칸과 눈에 보이지 않는 글자(폭 없는 빈칸 U+200B~200F, 단어 결합자 U+2060, BOM U+FEFF, 방향 제어 U+202A~202E·U+2066~2069). 옛 정규식의 문자 집합과 같다
fn is_leading_skip(c: char) -> bool {
    is_js_space(c) || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// JS `trim`과 같다
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

const PASTED: &[char] = &['<', 'p', 'a', 's', 't', 'e', 'd', '_', 'c', 'o', 'n', 't', 'e', 'n', 't'];

fn starts_with_at(chars: &[char], at: usize, pattern: &[char]) -> bool {
    chars.len() >= at + pattern.len() && &chars[at..at + pattern.len()] == pattern
}

/// `\s+id="[^"]*"` 를 `at`에서 맞춘다. 맞으면 닫는 따옴표 다음 위치. `\s+` 뒤는 `i`여야 하므로 빈칸을 덜 먹어 보는 되돌림은 필요 없다
fn id_group(chars: &[char], at: usize) -> Option<usize> {
    let mut j = at;
    while j < chars.len() && is_js_space(chars[j]) {
        j += 1;
    }
    if j == at || !starts_with_at(chars, j, &['i', 'd', '=', '"']) {
        return None;
    }
    let mut k = j + 4;
    while k < chars.len() && chars[k] != '"' {
        k += 1;
    }
    if k >= chars.len() {
        return None;
    }
    Some(k + 1)
}

/// `(?:\s+id="[^"]*")?>` 를 `at`에서 맞춘다. 맞으면 `>` 다음 위치. 선택 묶음을 먼저 시도하고 안 되면 묶음 없이 `>`를 본다(정규식의 되돌림과 같다)
fn tag_tail(chars: &[char], at: usize) -> Option<usize> {
    if let Some(after) = id_group(chars, at) {
        if chars.get(after) == Some(&'>') {
            return Some(after + 1);
        }
    }
    if chars.get(at) == Some(&'>') {
        return Some(at + 1);
    }
    None
}

/// 한 단계: 여는 표시(`<pasted_content(?:\s+id="[^"]*")?>\r?\n?`)를 모두 지우고, 그 결과에서 닫는 표시(`\r?\n?</pasted_content(?:\s+id="[^"]*")?>`)를 모두 지운다.
/// 정규식의 전역 바꾸기와 같다: 왼쪽부터 겹치지 않게 맞춘다
fn unwrap_once(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut opened = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if starts_with_at(&chars, i, PASTED) {
            if let Some(mut end) = tag_tail(&chars, i + PASTED.len()) {
                if end < chars.len() && chars[end] == '\r' {
                    end += 1;
                }
                if end < chars.len() && chars[end] == '\n' {
                    end += 1;
                }
                i = end;
                continue;
            }
        }
        opened.push(chars[i]);
        i += 1;
    }
    let chars: Vec<char> = opened.chars().collect();
    let close: Vec<char> = "</pasted_content".chars().collect();
    let mut out = String::with_capacity(opened.len());
    let mut i = 0;
    while i < chars.len() {
        let mut j = i;
        if j < chars.len() && chars[j] == '\r' {
            j += 1;
        }
        if j < chars.len() && chars[j] == '\n' {
            j += 1;
        }
        if starts_with_at(&chars, j, &close) {
            if let Some(end) = tag_tail(&chars, j + close.len()) {
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 붙여 넣은 요청의 감싸개 표시만 한 번 지우고 안의 글은 남긴다(옛 `unwrapPastedPrompt`)
pub fn unwrap_pasted(text: &str) -> String {
    unwrap_once(text)
}

/// 글이 읽기만 표시로 시작하는가: NFC로 맞추고 앞의 빈칸·보이지 않는 글자를 건너뛴다(옛 `isReadOnlyPrompt`에서 감싸개 벗기기를 뺀 것)
fn starts_with_mark(text: &str) -> bool {
    let composed: String = text.nfc().collect();
    composed.trim_start_matches(is_leading_skip).starts_with(READ_ONLY_MARK)
}

/// 읽기만 요청인가. 감싸개를 끝까지 벗기며 단계마다 본다: 하나라도 표시로 시작하면 읽기만이다. 벗기기가 끝나지 않으면 읽기만이다(막는 쪽)
pub fn is_read_only_prompt(text: &str) -> bool {
    let mut current = text.to_owned();
    for _ in 0..UNWRAP_STEP_LIMIT {
        let next = unwrap_once(&current);
        if starts_with_mark(&next) {
            return true;
        }
        if next == current {
            return false;
        }
        current = next;
    }
    true
}

/// 요청 글을 분류한다
pub fn classify_prompt(text: &str) -> PromptClass {
    let unwrapped = js_trim(&unwrap_once(text)).to_owned();
    PromptClass { read_only: is_read_only_prompt(text), slash_command: unwrapped.starts_with('/'), unwrapped }
}

/// Claude Code의 읽기 도구(`AGENT_READ_TOOLS`). 쓰기 직전 훅이 기다리지 않고 통과시킨다. 표를 바꾸면 훅 설정의 matcher(`AGENT_WRITE_TOOL_MATCHER`)와 어긋난다(ADR-211)
pub const AGENT_READ_TOOLS: [&str; 10] = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "AskUserQuestion", "Agent", "Task"];

/// Codex의 읽기 도구(`CODEX_READ_TOOLS`). 실험 경로의 표이지만 옛 판정이 두 표를 함께 봤으므로 그대로 둔다
pub const CODEX_READ_TOOLS: [&str; 11] = [
    "view_image",
    "web_search",
    "tool_search",
    "request_user_input",
    "update_plan",
    "get_goal",
    "create_goal",
    "update_goal",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
];

/// 읽기 도구인가: 두 표의 이름과 정확히 일치할 때만이다(대소문자·빈칸·접두사는 다른 도구다). 열린 것은 이 칸뿐이다. 모르는 이름은 바꾸는 도구로 본다
pub fn is_read_tool(name: &str) -> bool {
    AGENT_READ_TOOLS.contains(&name) || CODEX_READ_TOOLS.contains(&name)
}

/// 읽기만이 앞선 변경이 있는 실행에 이어 켜질 때 턴 끝이 읽기만 지름길을 타지 않게 표시하는가(S6, ADR-212).
/// 이미 읽기만이던 실행은 표시하지 않는다. 앞선 변경은 쓰기 훅을 지나 검증 상태가 세워진 것(`verification_started`)이거나 작업 복사본에 이미 바뀐 파일이 있는 것(`changed_before`)이다.
/// 변경 목록을 읽지 못했으면(`None`) 있는 것으로 본다(지름길 대신 게이트로 간다, 막는 쪽)
pub fn read_only_after_work(already_read_only: bool, verification_started: bool, changed_before: Option<bool>) -> bool {
    if already_read_only {
        return false;
    }
    verification_started || changed_before.unwrap_or(true)
}

#[cfg(test)]
#[path = "classify_tests.rs"]
mod tests;
