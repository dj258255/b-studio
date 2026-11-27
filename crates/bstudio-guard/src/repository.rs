//! 저장소 연동(`packages/agent/src/repository.ts`)의 순수 판정(ADR-191 3단계 3n).
//!
//! 원격 주소 해석(호스트 종류), 비교 주소, PR 생성 가능 여부, PR 번호·체크리스트·닫기 문구 해석, PR 본문의 관리 구간 갱신,
//! PR 제목·본문 만들기를 옮겼다. REST 호출과 `new URL`·`decodeURIComponent`는 TS에 남고, 껍데기가 그 결과 조각
//! (protocol·host·hostname·디코드한 pathname)을 값으로 넘긴다(확인하는 쪽과 쓰는 쪽이 같은 URL 해석을 쓰도록).
//!
//! JS와 같게 읽는 규칙:
//! - `\s`는 `js::is_js_whitespace`, `\d`·`\w`·`\b`는 ASCII, `.`은 줄 끝 글자 넷을 뺀 글자. `i` 플래그는 u 없는 JS 규칙이라 ASCII만 접는다.
//! - 글자 수(`.length`)는 UTF-16 코드 단위, 자르기는 `js::truncate_utf16`(서로게이트 쌍을 가르면 U+FFFD — Node 경계 규칙과 같다).
//! - 정규식은 쓰지 않고 손으로 옮겼다. 되돌아감(backtracking)이 결과를 바꾸는 자리는 각 함수 주석에 적었다.
//!
//! 의도한 차이: 짝 없는 서로게이트는 Node 경계에서 U+FFFD가 된다(`encodeRef`의 `encodeURIComponent`는 옛 코드가 던졌으나 이제 던지지 않는다).

use crate::commit_message::summarize;
use crate::js::{self, is_js_line_terminator, is_js_whitespace};
use crate::js_json::{self, object, JsValue};

pub const PR_MANAGED_BODY_BEGIN: &str = "<!-- b-studio:begin -->";
pub const PR_MANAGED_BODY_END: &str = "<!-- b-studio:end -->";
const TRUNCATED_BODY_NOTICE: &str = "(본문이 길어 뒷부분을 생략했습니다)";
/// GitHub PR 본문 한도(65,536자)보다 여유 있게 자른다
const MAX_PULL_REQUEST_BODY: i64 = 60_000;
/// 사람이 쓴 글이 한도를 거의 다 채웠을 때, 이보다 작은 자리에는 관리 영역을 넣지 않는다
const MIN_MANAGED_BODY_CHARS: i64 = 2_000;
const MAX_FILE_PATCH_CHARS: f64 = 20_000.0;
const MAX_TOTAL_PATCH_CHARS: f64 = 200_000.0;
const PR_TITLE_PREFIX: &str = "[b-studio] ";
const PR_TITLE_MAX: f64 = 72.0;

fn len16(s: &str) -> i64 {
    js::utf16_len(s) as i64
}

/// 관리 영역을 감싸는 마커 둘과 줄바꿈의 길이
fn managed_marker_chars() -> i64 {
    len16(PR_MANAGED_BODY_BEGIN) + len16(PR_MANAGED_BODY_END) + 2
}

/// JS 문자열 `indexOf`의 UTF-16 위치(마커는 ASCII라 바이트 순서와 같은 순서다)
fn index_of16(text: &str, pattern: &str) -> Option<i64> {
    text.find(pattern).map(|byte| len16(&text[..byte]))
}

// ---------------------------------------------------------------------------
// 원격 주소
// ---------------------------------------------------------------------------

/// `/^[a-z][a-z0-9+.-]*:\/\//i`(스킴이 있는 주소). 클래스에 ':'가 없어 되돌아갈 자리가 없다. `i`는 ASCII만 접는다
pub fn remote_needs_url(trimmed: &str) -> bool {
    let mut chars = trimmed.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let rest = chars.as_str().trim_start_matches(|c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    rest.starts_with("://")
}

/// scp 꼴의 뒷부분 `([^:/\s]+):(?!\/)(.+)$`. 호스트 클래스에 ':'가 없어 되돌아갈 자리가 없다
fn scp_tail(text: &str) -> Option<(&str, &str)> {
    let host_len = text.find(|c: char| c == ':' || c == '/' || is_js_whitespace(c)).unwrap_or(text.len());
    if host_len == 0 || !text[host_len..].starts_with(':') {
        return None;
    }
    let rest = &text[host_len + 1..];
    // (?!\/) 뒤의 .+ — 한 글자 이상, 줄 끝 글자 없음
    if rest.is_empty() || rest.starts_with('/') || rest.chars().any(is_js_line_terminator) {
        return None;
    }
    Some((&text[..host_len], rest))
}

/// `/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/`. 앞의 사용자 부분을 먼저 시도하고, 안 맞으면 없는 것으로 되돌아가 다시 읽는다
/// (`a@:x`는 사용자 `a`에 빈 호스트로 실패한 뒤, 호스트 `a@`로 맞는다)
fn scp_match(text: &str) -> Option<(&str, &str)> {
    if let Some(at) = text.find('@') {
        let user = &text[..at];
        if !user.is_empty() && !user.chars().any(|c| c == '/' || is_js_whitespace(c)) {
            if let Some(found) = scp_tail(&text[at + 1..]) {
                return Some(found);
            }
        }
    }
    scp_tail(text)
}

/// `new URL(...)`의 결과 조각(껍데기가 넘긴다). `pathname`은 `decodeURIComponent`를 거친 값이다
pub struct ParsedUrl<'a> {
    pub protocol: &'a str,
    pub host: &'a str,
    pub hostname: &'a str,
    pub pathname: &'a str,
}

pub struct RemoteLocation {
    pub kind: &'static str,
    pub display: String,
    pub host: Option<String>,
    pub path: Option<String>,
    pub web_url: Option<String>,
}

impl RemoteLocation {
    fn local(display: &str) -> Self {
        Self { kind: "local", display: display.to_owned(), host: None, path: None, web_url: None }
    }

    /// `{kind, display, host?, path?, webUrl?}` — 옛 객체와 같은 키 순서
    pub fn to_value(&self) -> JsValue {
        object(vec![
            ("kind", Some(JsValue::str(self.kind))),
            ("display", Some(JsValue::str(self.display.clone()))),
            ("host", self.host.clone().map(JsValue::Str)),
            ("path", self.path.clone().map(JsValue::Str)),
            ("webUrl", self.web_url.clone().map(JsValue::Str)),
        ])
    }
}

/// `host.replace(/:\d+$/, '')`
fn strip_port(host: &str) -> &str {
    let digits = host.len() - host.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    let head = &host[..host.len() - digits];
    if digits > 0 && head.ends_with(':') {
        &head[..head.len() - 1]
    } else {
        host
    }
}

/// git 원격 주소를 해석한다. `parsed`가 있으면 스킴 꼴(껍데기가 `new URL`로 읽은 조각), 없으면 scp 꼴·로컬 경로다.
/// `provider`는 `B_STUDIO_GIT_PROVIDER` 값 그대로다(앞뒤 공백·대소문자를 따지지 않는다 — 정확히 `github`·`gitlab`·`gitea`만)
pub fn parse_remote(url: &str, parsed: Option<&ParsedUrl>, provider: Option<&str>) -> RemoteLocation {
    let trimmed = js::trim(url);
    let (host, repo_path, scheme) = if let Some(parsed) = parsed {
        if parsed.protocol == "file:" {
            return RemoteLocation::local(parsed.pathname);
        }
        // ssh 포트는 웹 주소의 포트가 아니다
        let host = if parsed.protocol == "http:" || parsed.protocol == "https:" { parsed.host } else { parsed.hostname };
        (host.to_owned(), parsed.pathname.to_owned(), if parsed.protocol == "http:" { "http" } else { "https" })
    } else {
        // "C:\repo" 같은 윈도우 경로는 한 글자 호스트처럼 보인다
        match scp_match(trimmed) {
            Some((host, rest)) if js::utf16_len(host) != 1 => (host.to_owned(), rest.to_owned(), "https"),
            _ => return RemoteLocation::local(trimmed),
        }
    };
    let clean = repo_path.trim_start_matches('/').trim_end_matches('/');
    let clean = clean.strip_suffix(".git").unwrap_or(clean).to_owned();
    let hostname = strip_port(&host);
    let kind = match provider {
        Some("github") => "github",
        Some("gitlab") => "gitlab",
        Some("gitea") => "gitea",
        _ if hostname == "github.com" => "github",
        _ if hostname == "gitlab.com" => "gitlab",
        _ => "other",
    };
    RemoteLocation { kind, display: format!("{host}/{clean}"), web_url: Some(format!("{scheme}://{host}/{clean}")), host: Some(host), path: Some(clean) }
}

/// `ref.split('/').map(encodeURIComponent).join('/')`
fn encode_ref(reference: &str) -> String {
    reference.split('/').map(js::encode_uri_component).collect::<Vec<_>>().join("/")
}

/// `URLSearchParams` 값 직렬화(application/x-www-form-urlencoded): `*-._`와 영숫자만 그대로, 공백은 `+`, 나머지는 바이트마다 `%XX`
fn form_encode(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        match byte {
            b' ' => out.push('+'),
            b'*' | b'-' | b'.' | b'_' => out.push(byte as char),
            _ if byte.is_ascii_alphanumeric() => out.push(byte as char),
            _ => {
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0F) as usize] as char);
            }
        }
    }
    out
}

/// 토큰이 없어도 사람이 직접 PR을 만들 수 있게 작성 페이지 주소를 만든다. `web_url`이 없거나 빈 글자면 없다
pub fn compare_url(kind: &str, web_url: Option<&str>, base: &str, branch: &str) -> Option<String> {
    let web_url = web_url.filter(|url| !url.is_empty())?;
    match kind {
        "github" => Some(format!("{web_url}/compare/{}...{}?expand=1", encode_ref(base), encode_ref(branch))),
        "gitea" => Some(format!("{web_url}/compare/{}...{}", encode_ref(base), encode_ref(branch))),
        "gitlab" => Some(format!(
            "{web_url}/-/merge_requests/new?merge_request%5Bsource_branch%5D={}&merge_request%5Btarget_branch%5D={}",
            form_encode(branch),
            form_encode(base)
        )),
        _ => None,
    }
}

/// `kind`가 `other`·`local`이 아니고, 토큰이 있다(`token ?? envToken`의 글자가 비지 않았다 — `token`이 빈 글자여도 환경 변수로 되돌아가지 않는다)
pub fn can_create_pull_request(kind: &str, token: Option<&str>, env_token: Option<&str>) -> bool {
    kind != "other" && kind != "local" && token.or(env_token).is_some_and(|value| !value.is_empty())
}

/// `/\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/`. 숫자는 가장 길게 읽고(줄이면 다음 글자가 숫자라 맞지 않는다), 안 맞으면 다음 '/'에서 다시 찾는다
pub fn parse_pull_request_number(url: &str) -> Option<f64> {
    for (at, _) in url.match_indices('/') {
        let rest = &url[at + 1..];
        let after = ["pull", "pulls", "merge_requests"].iter().find_map(|word| {
            // "pull"이 "pulls"의 앞부분이라, 뒤에 '/'가 오는 쪽을 고른다(정규식의 대안 되돌아감)
            rest.strip_prefix(word).and_then(|tail| tail.strip_prefix('/'))
        });
        let Some(tail) = after else { continue };
        let digits = tail.len() - tail.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 {
            continue;
        }
        let next = &tail[digits..];
        if next.is_empty() || next.starts_with(['/', '?', '#']) {
            return Some(js::to_number(&tail[..digits]));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 체크리스트·닫기 문구
// ---------------------------------------------------------------------------

/// `/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/`(한 줄). 마지막 `\s+(.+)$`는 공백을 최대한 먹은 뒤 남은 글이 비면 공백 하나를 돌려주고 되돌아간다:
/// 뒤가 공백뿐이고 둘 이상이면 마지막 공백 한 글자가 `(.+)`가 된다(그 글자가 줄 끝 글자면 안 된다). 남은 글에 줄 끝 글자가 있으면(`\r` 등) 맞지 않는다
fn match_task_item(line: &str) -> Option<(bool, String)> {
    let line = line.trim_start_matches(is_js_whitespace);
    let mut chars = line.chars();
    if !matches!(chars.next(), Some('-' | '*')) {
        return None;
    }
    let after_marker = chars.as_str();
    let rest = after_marker.trim_start_matches(is_js_whitespace);
    if rest.len() == after_marker.len() {
        return None;
    }
    let rest = rest.strip_prefix('[')?;
    let mut chars = rest.chars();
    let mark = chars.next()?;
    if !matches!(mark, ' ' | 'x' | 'X') {
        return None;
    }
    let rest = chars.as_str().strip_prefix(']')?;
    let ws_len = rest.chars().take_while(|&c| is_js_whitespace(c)).count();
    if ws_len == 0 {
        return None;
    }
    let text = rest.trim_start_matches(is_js_whitespace);
    let text = if text.is_empty() {
        let last = rest.chars().last()?;
        if ws_len < 2 || is_js_line_terminator(last) {
            return None;
        }
        last.to_string()
    } else if text.chars().any(is_js_line_terminator) {
        return None;
    } else {
        text.to_owned()
    };
    Some((mark == 'x' || mark == 'X', js::trim(&text).to_owned()))
}

/// 이슈·PR 본문에서 "- [ ] 할 일"·"- [x] 한 일" 체크리스트를 뽑는다. `{total, checked, items:[{checked, text}]}`
pub fn parse_task_list(body: Option<&str>) -> JsValue {
    let items: Vec<(bool, String)> = body.unwrap_or("").split('\n').filter_map(match_task_item).collect();
    let checked = items.iter().filter(|(done, _)| *done).count();
    object(vec![
        ("total", Some(JsValue::Num(items.len() as f64))),
        ("checked", Some(JsValue::Num(checked as f64))),
        (
            "items",
            Some(JsValue::Arr(
                items.into_iter().map(|(done, text)| object(vec![("checked", Some(JsValue::Bool(done))), ("text", Some(JsValue::Str(text)))])).collect(),
            )),
        ),
    ])
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// 글자 `chars[at..]`가 `word`로 시작한다(ASCII만 대소문자를 접는다)
fn starts_with_ci(chars: &[char], at: usize, word: &str) -> bool {
    let wanted: Vec<char> = word.chars().collect();
    chars.len() >= at + wanted.len() && wanted.iter().enumerate().all(|(i, &w)| chars[at + i].to_ascii_lowercase() == w)
}

fn is_s_or_d(chars: &[char], at: usize) -> bool {
    chars.get(at).is_some_and(|c| matches!(c.to_ascii_lowercase(), 's' | 'd'))
}

/// 키워드의 길이: `close[sd]?`, `fix(?:e[sd])?`, `resolve[sd]?`. 선택 부분을 줄여도 다음 글자가 s·d·e라 뒤 패턴(공백·':'·'#')과 맞을 수 없어 되돌아감이 결과를 바꾸지 않는다
fn keyword_len(chars: &[char], at: usize) -> Option<usize> {
    if starts_with_ci(chars, at, "close") {
        Some(5 + usize::from(is_s_or_d(chars, at + 5)))
    } else if starts_with_ci(chars, at, "fix") {
        Some(if starts_with_ci(chars, at + 3, "e") && is_s_or_d(chars, at + 4) { 5 } else { 3 })
    } else if starts_with_ci(chars, at, "resolve") {
        Some(7 + usize::from(is_s_or_d(chars, at + 7)))
    } else {
        None
    }
}

/// `\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)`가 `at`에서 맞으면 (끝 위치, 번호)
fn closing_match_at(chars: &[char], at: usize) -> Option<(usize, f64)> {
    let before = at > 0 && is_word(chars[at - 1]);
    if before == is_word(chars[at]) {
        return None;
    }
    let mut i = at + keyword_len(chars, at)?;
    let skip_ws = |mut i: usize| {
        while chars.get(i).is_some_and(|&c| is_js_whitespace(c)) {
            i += 1;
        }
        i
    };
    i = skip_ws(i);
    if chars.get(i) == Some(&':') {
        i += 1;
    }
    i = skip_ws(i);
    if chars.get(i) != Some(&'#') {
        return None;
    }
    i += 1;
    let start = i;
    while chars.get(i).is_some_and(char::is_ascii_digit) {
        i += 1;
    }
    if i == start {
        return None;
    }
    let digits: String = chars[start..i].iter().collect();
    Some((i, js::to_number(&digits)))
}

/// "Closes #12", "fixes #7" 같은 닫기 문구에서 참조한 번호를 뽑는다(중복 없이, 나온 순서대로). `matchAll`처럼 맞은 곳의 끝에서 이어 찾는다
pub fn parse_closing_references(text: Option<&str>) -> Vec<f64> {
    let chars: Vec<char> = text.unwrap_or("").chars().collect();
    let mut numbers: Vec<f64> = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        match closing_match_at(&chars, at) {
            Some((end, number)) => {
                if !numbers.contains(&number) {
                    numbers.push(number);
                }
                at = end;
            }
            None => at += 1,
        }
    }
    numbers
}

// ---------------------------------------------------------------------------
// 리뷰 상태·patch·체크
// ---------------------------------------------------------------------------

/// GitHub·Gitea 리뷰 상태 문구를 화면이 쓰는 값으로 바꾼다. `raw.toUpperCase()`는 `ı`→`I`·`ſ`→`S`처럼 ASCII로 접히는 글자도 읽는다(Rust `to_uppercase`도 같다)
pub fn map_review_state(raw: &str) -> &'static str {
    match raw.to_uppercase().as_str() {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" | "REQUEST_CHANGES" => "changes_requested",
        "COMMENTED" | "COMMENT" => "commented",
        "DISMISSED" => "dismissed",
        "PENDING" => "pending",
        _ => "unknown",
    }
}

/// patch를 파일·전체 한도에 맞춰 자른다. `running_total`은 지금까지 쓴 글자 수. `{patch?, truncated}`
pub fn cap_patch(patch: Option<&str>, running_total: f64) -> JsValue {
    let Some(patch) = patch else {
        return object(vec![("truncated", Some(JsValue::Bool(false)))]);
    };
    if running_total >= MAX_TOTAL_PATCH_CHARS {
        return object(vec![("truncated", Some(JsValue::Bool(true)))]);
    }
    // Math.min은 NaN이 끼면 NaN이다
    let remaining = MAX_TOTAL_PATCH_CHARS - running_total;
    let budget = if remaining.is_nan() { f64::NAN } else { MAX_FILE_PATCH_CHARS.min(remaining) };
    if js::utf16_len(patch) as f64 <= budget {
        return object(vec![("patch", Some(JsValue::str(patch))), ("truncated", Some(JsValue::Bool(false)))]);
    }
    // slice(0, budget): NaN은 0, 소수는 버린다(budget은 0보다 크거나 NaN이다)
    let cut = if budget.is_nan() { 0 } else { budget.trunc() as usize };
    let text = format!("{}\n\n(patch가 길어 뒷부분을 생략했습니다)", js::truncate_utf16(patch, cut));
    object(vec![("patch", Some(JsValue::Str(text))), ("truncated", Some(JsValue::Bool(true)))])
}

/// 체크가 하나라도 안 끝났으면 pending, 끝났는데 실패·취소·조치 필요가 있으면 failure, 아니면 success. `completed[i]`는 `status === 'completed'`,
/// `conclusions[i]`는 글자일 때의 `conclusion`(그 밖의 값은 없는 것과 같다 — 실패 집합에 들 수 없다)
pub fn combine_check_status(completed: &[bool], conclusions: &[Option<&str>]) -> &'static str {
    if completed.is_empty() {
        return "unknown";
    }
    if completed.iter().any(|done| !done) {
        return "pending";
    }
    let failing = |value: &str| matches!(value, "failure" | "timed_out" | "cancelled" | "action_required");
    if conclusions.iter().any(|c| c.is_some_and(|value| !value.is_empty() && failing(value))) {
        return "failure";
    }
    "success"
}

// ---------------------------------------------------------------------------
// PR 본문의 관리 구간
// ---------------------------------------------------------------------------

/// buildPullRequest가 만든 옛 본문(마커를 넣기 전)의 신호. 한도에서 끝이 잘린 본문은 앞쪽 절과 줄였다는 안내로 알아본다
fn looks_like_legacy_managed_body(body: &str) -> bool {
    if !body.contains("## 요청") {
        return false;
    }
    body.contains("## 검증") || js::trim_end(body).ends_with(TRUNCATED_BODY_NOTICE)
}

/// 마커 밖의 글(before·after)을 지키면서 관리 영역을 한도 안에 넣는다. 넘치면 관리 영역의 끝만 줄이고 닫는 마커는 남긴다
fn wrap_managed_body(before: &str, managed_body: &str, after: &str) -> String {
    let room = MAX_PULL_REQUEST_BODY - len16(before) - len16(after) - managed_marker_chars();
    let managed = if len16(managed_body) <= room {
        managed_body.to_owned()
    } else {
        let keep = (room - len16(TRUNCATED_BODY_NOTICE) - 2).max(0) as usize;
        format!("{}\n\n{TRUNCATED_BODY_NOTICE}", js::truncate_utf16(managed_body, keep))
    };
    format!("{before}{PR_MANAGED_BODY_BEGIN}\n{managed}\n{PR_MANAGED_BODY_END}{after}")
}

/// PR 본문 중 b-studio가 관리하는 영역만 지금 초안으로 바꾼다. 마커 밖의 글은 그대로 둔다
pub fn merge_managed_pull_request_body(existing_body: Option<&str>, managed_body: &str) -> String {
    let current = existing_body.unwrap_or("");
    if let Some(begin) = current.find(PR_MANAGED_BODY_BEGIN) {
        let before = &current[..begin];
        let after = match current.find(PR_MANAGED_BODY_END) {
            Some(end) if end > begin => &current[end + PR_MANAGED_BODY_END.len()..],
            _ => "",
        };
        return wrap_managed_body(before, managed_body, after);
    }
    if js::trim(current).is_empty() || looks_like_legacy_managed_body(current) {
        return wrap_managed_body("", managed_body, "");
    }
    wrap_managed_body(&format!("{}\n\n", js::trim_end(current)), managed_body, "")
}

/// 마커 밖의 글이 한도를 거의 채워 관리 영역이 제 구실을 못 할 만큼 줄었는가
pub fn managed_body_squeezed_out(body: &str, managed_body: &str) -> bool {
    if len16(body) > MAX_PULL_REQUEST_BODY {
        return true;
    }
    let begin = index_of16(body, PR_MANAGED_BODY_BEGIN).unwrap_or(-1);
    let end = index_of16(body, PR_MANAGED_BODY_END).unwrap_or(-1);
    let kept = end - begin - len16(PR_MANAGED_BODY_BEGIN) - 2;
    kept < len16(managed_body).min(MIN_MANAGED_BODY_CHARS)
}

/// 한도를 넘는 본문의 끝을 줄인다
pub fn cap_body(body: &str) -> String {
    if len16(body) <= MAX_PULL_REQUEST_BODY {
        body.to_owned()
    } else {
        format!("{}\n\n{TRUNCATED_BODY_NOTICE}", js::truncate_utf16(body, MAX_PULL_REQUEST_BODY as usize))
    }
}

// ---------------------------------------------------------------------------
// PR 제목·본문
// ---------------------------------------------------------------------------

struct Commit {
    short_sha: String,
    subject: String,
    body: String,
    files: Vec<String>,
    stat: Option<(f64, f64)>,
    passed_stages: Vec<String>,
    docs_exempt: bool,
    max_turns: bool,
    /// 스튜디오가 게이트를 거쳐 남긴 체크포인트인가(Workflow-Passed 트레일러가 있다). 아니면 본문은 사람이 쓴 글이라 게이트 기록으로 읽지 않는다
    gate_recorded: bool,
}

struct PullRequestInput {
    project_name: String,
    base: String,
    missing_base: Option<String>,
    branch: String,
    commits: Vec<Commit>,
    issue: Option<f64>,
    issues: Vec<f64>,
    requirement_ids: Vec<String>,
    required_stages: Vec<String>,
    appendix: String,
    /// 있으면 "영향 범위"·"중점 리뷰 항목" 절을 더한다. 없으면(옛 호출) 두 절이 없다
    impact: Option<Impact>,
}

/// 커밋만으로는 알 수 없는, 프로젝트 선언에서 온 사실(껍데기가 넘긴다)
struct Impact {
    /// 바뀐 파일이 속한 managed 서비스. `None`이면 판정하지 못한 것이다(빈 목록은 "속한 서비스 없음")
    services: Option<Vec<String>>,
    unmatched_files: Option<f64>,
    protected_paths: Vec<String>,
    backslash_sep: bool,
}

/// 체크포인트 커밋 제목에서 "요청: " 접두사를 뺀 사람이 읽는 이름(`/^요청:\s*/`)
fn request_name(subject: &str) -> String {
    match subject.strip_prefix("요청:") {
        Some(rest) => rest.trim_start_matches(is_js_whitespace).to_owned(),
        None => subject.to_owned(),
    }
}

/// "R2~R23"처럼 요구사항 id들의 수 범위. 숫자 id가 하나도 없으면 없다(`/^R(\d+)/`)
fn requirement_id_range(ids: &[String]) -> Option<String> {
    let numbers: Vec<f64> = ids
        .iter()
        .filter_map(|id| {
            let rest = id.strip_prefix('R')?;
            let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            (digits > 0).then(|| js::to_number(&rest[..digits]))
        })
        .collect();
    if numbers.is_empty() {
        return None;
    }
    let min = numbers.iter().copied().fold(f64::INFINITY, f64::min);
    let max = numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    Some(if min == max { format!("R{}", js::number_to_string(min)) } else { format!("R{}~R{}", js::number_to_string(min), js::number_to_string(max)) })
}

/// 줄 수(없으면 파일 수) 기준의 무게. `(stat ? 삽입+삭제 : 0) || files.length`
fn weight(commit: &Commit) -> f64 {
    let sum = commit.stat.map_or(0.0, |(insertions, deletions)| insertions + deletions);
    if sum == 0.0 || sum.is_nan() {
        commit.files.len() as f64
    } else {
        sum
    }
}

fn most_significant_commit(commits: &[Commit]) -> &Commit {
    commits.iter().skip(1).fold(&commits[0], |best, commit| if weight(commit) > weight(best) { commit } else { best })
}

fn build_pull_request_title(project_name: &str, commits: &[Commit], requirement_ids: &[String]) -> String {
    let budget = PR_TITLE_MAX - js::utf16_len(PR_TITLE_PREFIX) as f64;
    if !requirement_ids.is_empty() {
        if requirement_ids.len() == 1 && commits.len() == 1 {
            return format!("{PR_TITLE_PREFIX}{}", summarize(&request_name(&commits[0].subject), budget));
        }
        let range = requirement_id_range(requirement_ids).map(|range| format!(" ({range})")).unwrap_or_default();
        let summary = format!("feat: 요구사항 {}개 구현과 검증{range}", requirement_ids.len());
        return format!("{PR_TITLE_PREFIX}{}", summarize(&summary, budget));
    }
    let candidate = if commits.is_empty() { format!("{project_name} 세션 변경") } else { request_name(&most_significant_commit(commits).subject) };
    format!("{PR_TITLE_PREFIX}{}", summarize(&candidate, budget))
}

/// 요청 하나의 절. `with_details`가 거짓이면 접어 둔 상세(게이트 결과·에이전트 요약)를 뺀다
fn section(commit: &Commit, request: &str, index: usize, with_details: bool) -> String {
    let shown: Vec<String> = commit.files.iter().take(10).map(|file| format!("`{file}`")).collect();
    let more = if commit.files.len() > shown.len() { format!(" 외 {}개", commit.files.len() - shown.len()) } else { String::new() };
    let mut lines = vec![
        format!("### {}. {request}", index + 1),
        String::new(),
        format!("커밋 `{}`, 파일 {}개: {}{more}", commit.short_sha, commit.files.len(), shown.join(", ")),
    ];
    if !commit.body.is_empty() && with_details {
        for line in ["", "<details>", "<summary>검증 게이트 결과와 에이전트 요약</summary>", "", "~~~text"] {
            lines.push(line.to_owned());
        }
        lines.push(commit.body.clone());
        for line in ["~~~", "", "</details>"] {
            lines.push(line.to_owned());
        }
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// 영향 범위·중점 리뷰 항목(모델을 부르지 않고 파일 목록과 커밋 본문 기록에서 기계적으로 만든다)
// ---------------------------------------------------------------------------

/// 체크포인트 본문(`checkpoint_body`)에서 검증 보고서·확인 범위 절은 맨 앞에, 에이전트 요약은 맨 뒤에 온다.
/// 요약은 모델이 쓴 글이라 기록처럼 보이는 줄을 흉내 낼 수 있으므로, 이 표지 줄 앞까지만 기록으로 읽는다
const AGENT_SUMMARY_MARK: &str = "에이전트 요약:";
const CONTRACT_HEADER_SUFFIX: &str = " 계약:";
const CONTRACT_EXTRACT_FAILED: &str = " 계약 추출 실패: ";
const DECLARED_CHANGE_PREFIX: &str = "확인 선언 변경: ";
const CONTRACT_KINDS: [&str; 8] = [
    "operation-added",
    "operation-removed",
    "schema-added",
    "schema-removed",
    "property-added",
    "property-removed",
    "property-type-changed",
    "property-became-required",
];
const IMPACT_FILE_LIST_MAX: usize = 8;
const IMPACT_ITEM_MAX: usize = 5;
const DECLARED_CHANGE_DETAIL_MAX: usize = 200;

struct ContractLine {
    kind: String,
    target: String,
    breaking: bool,
}

/// 커밋 하나의 본문에서 읽은 계약 비교 기록
#[derive(Default)]
struct ContractRecord {
    /// `- 서비스 계약:` 머리와 그 아래 변경 줄(또는 "계약 변경 없음")을 읽었다
    recorded: bool,
    /// 계약 추출 실패 줄이 있거나, 계약 머리 아래에 모르는 모양의 줄이 있어 읽지 못했다
    failed: bool,
    changes: Vec<ContractLine>,
}

/// 기록으로 읽을 줄들(에이전트 요약 앞까지)
fn record_lines(body: &str) -> impl Iterator<Item = &str> {
    body.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).take_while(|line| *line != AGENT_SUMMARY_MARK)
}

/// `verify_judge::format_verification_report`가 쓴 계약 절(`- 서비스 계약:` 아래 네 칸 들여 쓴 `＋ 종류 대상` 또는 `⚠️ 호환 깨짐 종류 대상`)을 읽는다.
/// 모양이 다른 줄은 "읽지 못함"(failed)이다: 0건으로 세지 않는다
fn parse_contract_record(body: &str) -> ContractRecord {
    let mut record = ContractRecord::default();
    let mut in_contract = false;
    for line in record_lines(body) {
        if let Some(rest) = line.strip_prefix("- ") {
            in_contract = false;
            if rest.len() > CONTRACT_HEADER_SUFFIX.len() && rest.ends_with(CONTRACT_HEADER_SUFFIX) {
                in_contract = true;
                record.recorded = true;
            } else if rest.contains(CONTRACT_EXTRACT_FAILED) {
                record.failed = true;
            }
            continue;
        }
        if !in_contract {
            continue;
        }
        let Some(item) = line.strip_prefix("    ") else {
            in_contract = false;
            continue;
        };
        if item == "계약 변경 없음" {
            continue;
        }
        if item.starts_with("이 요청은 호환을 깨는 변경을 허용하지 않았습니다") {
            continue;
        }
        let (breaking, rest) = if let Some(rest) = item.strip_prefix("⚠️ 호환 깨짐 ") {
            (true, rest)
        } else if let Some(rest) = item.strip_prefix("＋ ") {
            (false, rest)
        } else {
            record.failed = true;
            continue;
        };
        let (kind, tail) = rest.split_once(' ').unwrap_or((rest, ""));
        let target = tail.split_once(" (").map_or(tail, |(target, _)| target);
        if !CONTRACT_KINDS.contains(&kind) || target.is_empty() {
            record.failed = true;
            continue;
        }
        record.changes.push(ContractLine { kind: kind.to_owned(), target: target.to_owned(), breaking });
    }
    record
}

/// 게이트가 사람이 허용한 확인 선언 변경으로 검증했다고 남긴 줄(`확인 선언 변경: …`)의 내용. 없으면 `None`
fn parse_declared_change(body: &str) -> Option<String> {
    let detail = record_lines(body).find_map(|line| line.strip_prefix(DECLARED_CHANGE_PREFIX))?;
    let detail = js::trim(detail);
    if detail.is_empty() {
        return None;
    }
    let chars: Vec<char> = detail.chars().collect();
    Some(if chars.len() > DECLARED_CHANGE_DETAIL_MAX { format!("{}…", chars[..DECLARED_CHANGE_DETAIL_MAX].iter().collect::<String>()) } else { detail.to_owned() })
}

/// DB 마이그레이션으로 "보이는" 파일. 이름만 보는 추정이고 리뷰어에게 알리는 데만 쓴다(막는 검사가 아니다)
fn looks_like_migration(file: &str) -> bool {
    let lower = file.to_lowercase();
    let segments: Vec<&str> = lower.split('/').collect();
    let Some((name, dirs)) = segments.split_last() else { return false };
    if dirs.iter().any(|dir| matches!(*dir, "migrations" | "migration" | "migrate")) {
        return true;
    }
    if dirs.windows(2).any(|pair| pair[0] == "alembic" && pair[1] == "versions") {
        return true;
    }
    // Flyway: V2__add_memo.sql, U2__undo.sql, R__views.sql
    let bytes = name.as_bytes();
    name.ends_with(".sql") && name.contains("__") && ((matches!(bytes.first(), Some(b'v' | b'u')) && bytes.get(1).is_some_and(u8::is_ascii_digit)) || name.starts_with("r__"))
}

fn file_list(files: &[&String]) -> String {
    let shown: Vec<String> = files.iter().take(IMPACT_FILE_LIST_MAX).map(|file| format!("`{file}`")).collect();
    let more = if files.len() > shown.len() { format!(" 외 {}개", files.len() - shown.len()) } else { String::new() };
    format!("{}{more}", shown.join(", "))
}

fn sha_list(commits: &[&Commit]) -> String {
    let shown: Vec<String> = commits.iter().take(IMPACT_ITEM_MAX).map(|commit| format!("`{}`", commit.short_sha)).collect();
    let more = if commits.len() > shown.len() { format!(" 외 {}건", commits.len() - shown.len()) } else { String::new() };
    format!("{}{more}", shown.join(", "))
}

/// "영향 범위"와 "중점 리뷰 항목" 절(제목 줄 포함). 근거를 얻지 못한 항목은 지어내지 않고 "확인하지 못함"으로 적는다
fn impact_section_lines(commits: &[Commit], impact: &Impact) -> Vec<String> {
    let mut files: Vec<&String> = Vec::new();
    for commit in commits {
        for file in &commit.files {
            if !files.contains(&file) {
                files.push(file);
            }
        }
    }

    let mut lines: Vec<String> = vec!["## 영향 범위".to_owned(), String::new()];
    lines.push(format!("- 바뀐 파일: {}개 (요청 {}건)", files.len(), commits.len()));
    match &impact.services {
        None => lines.push("- 바뀐 서비스: 확인하지 못함(서비스 선언으로 파일이 속한 서비스를 판정하지 못했습니다)".to_owned()),
        Some(services) if services.is_empty() => lines.push("- 바뀐 서비스: 없음(서비스에 속한 파일이 바뀌지 않았습니다)".to_owned()),
        Some(services) => {
            let names: Vec<String> = services.iter().map(|service| format!("`{service}`")).collect();
            let outside = match impact.unmatched_files {
                Some(count) if count > 0.0 => format!(" · 서비스에 속하지 않은 파일 {}개", js::number_to_string(count)),
                _ => String::new(),
            };
            lines.push(format!("- 바뀐 서비스: {}{outside}", names.join(", ")));
        }
    }

    // 계약 차이: 요청마다 커밋 본문에 남은 게이트 기록을 읽는다. 기록이 없으면 0건이 아니라 "확인하지 못함"이다
    let checked: Vec<&Commit> = commits.iter().filter(|commit| !commit.docs_exempt).collect();
    if !checked.is_empty() {
        let records: Vec<(&Commit, ContractRecord)> = checked.iter().map(|commit| (*commit, if commit.gate_recorded { parse_contract_record(&commit.body) } else { ContractRecord::default() })).collect();
        let recorded: Vec<&(&Commit, ContractRecord)> = records.iter().filter(|(_, record)| record.recorded).collect();
        let unknown: Vec<&Commit> = records.iter().filter(|(_, record)| !record.recorded && !record.failed).map(|(commit, _)| *commit).collect();
        let failed: Vec<&Commit> = records.iter().filter(|(_, record)| record.failed).map(|(commit, _)| *commit).collect();
        if recorded.is_empty() {
            lines.push("- API 계약 차이: 확인하지 못함(커밋 본문에 계약 비교 기록이 없습니다. 계약을 선언한 서비스가 없거나 게이트 기록이 남지 않은 요청입니다)".to_owned());
        } else {
            let all: Vec<(&Commit, &ContractLine)> = recorded.iter().flat_map(|(commit, record)| record.changes.iter().map(move |change| (*commit, change))).collect();
            let added = all.iter().filter(|(_, change)| change.kind.ends_with("-added")).count();
            let removed = all.iter().filter(|(_, change)| change.kind.ends_with("-removed")).count();
            let changed = all.len() - added - removed;
            let breaking: Vec<&(&Commit, &ContractLine)> = all.iter().filter(|(_, change)| change.breaking).collect();
            if all.is_empty() {
                lines.push(format!("- API 계약 차이: 변경 없음 — 계약 비교 기록이 있는 요청 {}건", recorded.len()));
            } else {
                lines.push(format!("- API 계약 차이: 추가 {added} · 삭제 {removed} · 변경 {changed} (그중 호환 깨짐 {}) — 계약 비교 기록이 있는 요청 {}건", breaking.len(), recorded.len()));
            }
            for (commit, change) in breaking.iter().take(IMPACT_ITEM_MAX).map(|pair| **pair) {
                lines.push(format!("  - 호환 깨짐: `{} {}` (`{}`)", change.kind, change.target, commit.short_sha));
            }
            if breaking.len() > IMPACT_ITEM_MAX {
                lines.push(format!("  - 호환 깨짐 {}건이 더 있습니다", breaking.len() - IMPACT_ITEM_MAX));
            }
            if !unknown.is_empty() {
                lines.push(format!("  - 계약 비교 기록이 없어 확인하지 못한 요청 {}건: {}", unknown.len(), sha_list(&unknown)));
            }
            lines.push("  - 요청마다 그 요청을 시작할 때의 계약과 견준 기록을 합친 값입니다. 세션 전체를 한 번에 견준 값이 아닙니다".to_owned());
        }
        if !failed.is_empty() {
            lines.push(format!("  - 계약 추출에 실패했거나 기록을 읽지 못한 요청 {}건: {}", failed.len(), sha_list(&failed)));
        }
    }

    lines.push(String::new());
    lines.push("## 중점 리뷰 항목".to_owned());
    lines.push(String::new());
    let mut focus: Vec<String> = Vec::new();
    // 보호 경로 규칙은 거부 목록이라 넓게 맞춘다(꼴을 맞출 수 없으면 걸린 것으로 본다). 여기서는 리뷰어에게 알리는 데만 쓴다
    let protected: Vec<&String> = files
        .iter()
        .copied()
        .filter(|file| impact.protected_paths.iter().any(|rule| crate::path_policy::is_protected_path(file, rule, impact.backslash_sep)))
        .collect();
    if !protected.is_empty() {
        focus.push(format!("- 보호 경로를 건드린 파일: {}", file_list(&protected)));
    }
    let spec_files: Vec<&String> =
        files.iter().copied().filter(|file| crate::path_policy::canonical_project_path(file, false, impact.backslash_sep).as_deref() == Some(crate::services::SPEC_FILE)).collect();
    if !spec_files.is_empty() {
        focus.push(format!("- 확인 선언 파일 변경: {}이 바뀌었습니다. 확인 선언(workflow)이 바뀌었는지는 diff로 확인하세요", file_list(&spec_files)));
    }
    let tests: Vec<&String> = files.iter().copied().filter(|file| crate::test_discovery::is_test_file_path(file)).collect();
    if !tests.is_empty() {
        focus.push(format!("- 시험 파일 변경: {}", file_list(&tests)));
    }
    let allowed: Vec<(&Commit, String)> = checked.iter().filter(|commit| commit.gate_recorded).filter_map(|commit| parse_declared_change(&commit.body).map(|detail| (*commit, detail))).collect();
    for (commit, detail) in allowed.iter().take(IMPACT_ITEM_MAX) {
        focus.push(format!("- 사람이 허용한 확인 선언 변경: `{}` — {detail}", commit.short_sha));
    }
    if allowed.len() > IMPACT_ITEM_MAX {
        focus.push(format!("- 사람이 허용한 확인 선언 변경이 {}건 더 있습니다", allowed.len() - IMPACT_ITEM_MAX));
    }
    let migrations: Vec<&String> = files.iter().copied().filter(|file| looks_like_migration(file)).collect();
    if !migrations.is_empty() {
        focus.push(format!("- DB 마이그레이션으로 보이는 파일: {}", file_list(&migrations)));
    }
    if focus.is_empty() {
        focus.push("- 해당하는 항목이 없습니다(보호 경로·확인 선언 파일·시험 파일·마이그레이션으로 보이는 파일을 건드리지 않았고, 사람이 허용한 확인 선언 변경 기록도 없습니다)".to_owned());
    }
    lines.extend(focus);
    lines
}

/// 세션 커밋만으로 PR 제목과 본문을 만든다. `{title, body, missing:[{shortSha, subject, stages}]}`
fn build_pull_request_draft(input: &PullRequestInput) -> JsValue {
    let commits = &input.commits;
    let requests: Vec<String> = commits.iter().map(|commit| request_name(&commit.subject)).collect();
    let title = build_pull_request_title(&input.project_name, commits, &input.requirement_ids);

    let missing: Vec<(&Commit, &String, Vec<&String>)> = commits
        .iter()
        .zip(&requests)
        .filter_map(|(commit, request)| {
            if commit.docs_exempt {
                return None;
            }
            let unmet: Vec<&String> = input.required_stages.iter().filter(|stage| !commit.passed_stages.contains(stage)).collect();
            (!unmet.is_empty()).then_some((commit, request, unmet))
        })
        .collect();

    let verification: Vec<String> = commits
        .iter()
        .zip(&requests)
        .map(|(commit, request)| {
            if commit.docs_exempt {
                return format!("- `{}` {request} — 문서 체크포인트(게이트 대상 아님)", commit.short_sha);
            }
            let incomplete = if commit.max_turns { " · 턴 상한에서 멈춘 실행(요청이 끝나지 않았을 수 있음)" } else { "" };
            let passed = if commit.passed_stages.is_empty() { "기록 없음".to_owned() } else { commit.passed_stages.join(", ") };
            format!("- `{}` {request} — 통과: {passed}{incomplete}", commit.short_sha)
        })
        .collect();
    let docs_notes = commits.iter().zip(&requests).filter(|(commit, _)| commit.docs_exempt).map(|(commit, request)| format!("- `{}` {request} — 문서만 바뀜(게이트 대상 아님)", commit.short_sha));
    let missing_notes = missing.iter().map(|(commit, request, stages)| {
        let names: Vec<&str> = stages.iter().map(|stage| stage.as_str()).collect();
        format!("- `{}` {request} — 기록 없음: {}", commit.short_sha, names.join(", "))
    });
    let mut unverified: Vec<String> = docs_notes.chain(missing_notes).collect();
    if unverified.is_empty() {
        unverified.push("모든 커밋이 필수 단계를 통과했습니다".to_owned());
    }

    // 영향 범위·중점 리뷰 항목(껍데기가 선언에서 온 사실을 넘겼을 때만)
    let impact_lines: Vec<String> = input.impact.as_ref().map(|impact| impact_section_lines(commits, impact)).unwrap_or_default();

    // 연결할 이슈 번호(SameValueZero로 중복을 없앤다)
    let mut linked: Vec<f64> = Vec::new();
    for number in input.issue.iter().chain(input.issues.iter()) {
        if !linked.iter().any(|seen| js::same_value_zero(*seen, *number)) {
            linked.push(*number);
        }
    }

    let render = |omitted: usize| -> String {
        let mut lines: Vec<String> = Vec::new();
        if !linked.is_empty() {
            for number in &linked {
                lines.push(format!("Closes #{}", js::number_to_string(*number)));
            }
            lines.push("(`Closes #n`은 이 PR이 기본 브랜치로 열릴 때만 이슈를 자동으로 닫습니다.)".to_owned());
            lines.push(String::new());
        }
        lines.push(format!("`{}` 프로젝트의 b-studio 세션에서 처리한 요청 {}건입니다.", input.project_name, commits.len()));
        lines.push("요청마다 스튜디오가 바뀐 서비스를 재시작하고 준비 상태와 API 계약을 확인했고, **검증 게이트를 통과한 변경만** 커밋했습니다.".to_owned());
        lines.push(String::new());
        lines.push(format!("- 기준 브랜치: `{}`", input.base));
        if let Some(missing_base) = input.missing_base.as_ref().filter(|missing_base| **missing_base != input.base) {
            lines.push(format!(
                "  - 세션은 `{missing_base}`에서 갈라져 나왔지만 그 브랜치가 원격에 없어 원격의 기본 브랜치를 대상으로 했습니다. `{missing_base}`에만 있던 커밋도 이 PR에 들어 있습니다."
            ));
        }
        lines.push(format!("- 세션 브랜치: `{}`", input.branch));
        lines.push(String::new());
        lines.push("## 요청".to_owned());
        lines.push(String::new());
        if omitted > 0 {
            lines.push(format!("본문 길이 한도 때문에 앞의 {omitted}건은 게이트 결과와 에이전트 요약을 싣지 않았습니다. 각 커밋의 본문에 그대로 있습니다."));
            lines.push(String::new());
        }
        lines.push(commits.iter().zip(&requests).enumerate().map(|(index, (commit, request))| section(commit, request, index, index >= omitted)).collect::<Vec<_>>().join("\n\n"));
        lines.push(String::new());
        lines.push("## 검증".to_owned());
        lines.push(String::new());
        lines.push(verification.join("\n"));
        lines.push(String::new());
        lines.push("## 돌리지 않은 검증".to_owned());
        lines.push(String::new());
        lines.push(unverified.join("\n"));
        if !impact_lines.is_empty() {
            lines.push(String::new());
            lines.extend(impact_lines.iter().cloned());
        }
        format!("{}{}", lines.join("\n"), input.appendix)
    };

    // 한도를 넘으면 끝을 자르지 않고 오래된 요청의 상세부터 뺀다. 상세가 없는 요청은 빼도 길이가 그대로라 다시 만들지 않는다
    let budget = MAX_PULL_REQUEST_BODY - managed_marker_chars();
    let mut omitted = 0;
    let mut body = render(0);
    while len16(&body) > budget && omitted < commits.len() {
        omitted += 1;
        if !commits[omitted - 1].body.is_empty() {
            body = render(omitted);
        }
    }
    if len16(&body) > budget {
        let keep = (budget - len16(TRUNCATED_BODY_NOTICE) - 2).max(0) as usize;
        body = format!("{}\n\n{TRUNCATED_BODY_NOTICE}", js::truncate_utf16(&body, keep));
    }

    let missing_value = missing
        .iter()
        .map(|(commit, request, stages)| {
            object(vec![
                ("shortSha", Some(JsValue::str(commit.short_sha.clone()))),
                ("subject", Some(JsValue::str((*request).clone()))),
                ("stages", Some(JsValue::Arr(stages.iter().map(|stage| JsValue::str((*stage).clone())).collect()))),
            ])
        })
        .collect();
    object(vec![("title", Some(JsValue::Str(title))), ("body", Some(JsValue::Str(body))), ("missing", Some(JsValue::Arr(missing_value)))])
}

fn string_field(object: &js_json::JsObject, name: &str, what: &str) -> Result<String, String> {
    match object.get(name) {
        Some(JsValue::Str(s)) => Ok(s.clone()),
        _ => Err(format!("{what}의 {name}은 글자여야 합니다")),
    }
}

fn optional_string_field(object: &js_json::JsObject, name: &str, what: &str) -> Result<Option<String>, String> {
    match object.get(name) {
        None | Some(JsValue::Null) => Ok(None),
        Some(JsValue::Str(s)) => Ok(Some(s.clone())),
        _ => Err(format!("{what}의 {name}은 글자여야 합니다")),
    }
}

fn string_list(object: &js_json::JsObject, name: &str, what: &str) -> Result<Vec<String>, String> {
    let Some(JsValue::Arr(items)) = object.get(name) else {
        return Err(format!("{what}의 {name}은 배열이어야 합니다"));
    };
    items
        .iter()
        .map(|item| match item {
            JsValue::Str(s) => Ok(s.clone()),
            _ => Err(format!("{what}의 {name}은 글자 목록이어야 합니다")),
        })
        .collect()
}

fn number_of(value: Option<&JsValue>) -> f64 {
    match value {
        Some(JsValue::Num(n)) => *n,
        _ => f64::NAN,
    }
}

fn parse_commit(value: &JsValue) -> Result<Commit, String> {
    let JsValue::Obj(object) = value else {
        return Err("커밋은 객체여야 합니다".to_owned());
    };
    let flag = |name: &str| match object.get(name) {
        Some(JsValue::Bool(b)) => Ok(*b),
        _ => Err(format!("커밋의 {name}은 참·거짓이어야 합니다")),
    };
    let stat = match object.get("stat") {
        Some(JsValue::Obj(stat)) => Some((number_of(stat.get("insertions")), number_of(stat.get("deletions")))),
        None | Some(JsValue::Null) => None,
        _ => return Err("커밋의 stat은 객체여야 합니다".to_owned()),
    };
    Ok(Commit {
        short_sha: string_field(object, "shortSha", "커밋")?,
        subject: string_field(object, "subject", "커밋")?,
        body: string_field(object, "body", "커밋")?,
        files: string_list(object, "files", "커밋")?,
        stat,
        passed_stages: string_list(object, "passedStages", "커밋")?,
        docs_exempt: flag("docsExempt")?,
        max_turns: flag("maxTurns")?,
        // 옛 호출에는 없다. 없으면 기록으로 읽지 않는 쪽이다
        gate_recorded: match object.get("gateRecorded") {
            None | Some(JsValue::Null) => false,
            Some(JsValue::Bool(b)) => *b,
            _ => return Err("커밋의 gateRecorded는 참·거짓이어야 합니다".to_owned()),
        },
    })
}

fn parse_input(json: &str) -> Result<PullRequestInput, String> {
    let JsValue::Obj(object) = js_json::parse_native(json)? else {
        return Err("PR 입력은 객체여야 합니다".to_owned());
    };
    let Some(JsValue::Arr(commit_values)) = object.get("commits") else {
        return Err("PR 입력의 commits는 배열이어야 합니다".to_owned());
    };
    let number_list = |name: &str| -> Result<Vec<f64>, String> {
        let Some(JsValue::Arr(items)) = object.get(name) else {
            return Err(format!("PR 입력의 {name}은 배열이어야 합니다"));
        };
        items
            .iter()
            .map(|item| match item {
                JsValue::Num(n) => Ok(*n),
                _ => Err(format!("PR 입력의 {name}은 수 목록이어야 합니다")),
            })
            .collect()
    };
    let issue = match object.get("issue") {
        None | Some(JsValue::Null) => None,
        Some(JsValue::Num(n)) => Some(*n),
        _ => return Err("PR 입력의 issue는 수여야 합니다".to_owned()),
    };
    Ok(PullRequestInput {
        project_name: string_field(&object, "projectName", "PR 입력")?,
        base: string_field(&object, "base", "PR 입력")?,
        missing_base: optional_string_field(&object, "missingBase", "PR 입력")?,
        branch: string_field(&object, "branch", "PR 입력")?,
        commits: commit_values.iter().map(parse_commit).collect::<Result<_, _>>()?,
        issue,
        issues: number_list("issues")?,
        requirement_ids: string_list(&object, "requirementIds", "PR 입력")?,
        required_stages: string_list(&object, "requiredStages", "PR 입력")?,
        appendix: string_field(&object, "appendix", "PR 입력")?,
        impact: parse_impact(object.get("impact"))?,
    })
}

fn parse_impact(value: Option<&JsValue>) -> Result<Option<Impact>, String> {
    let object = match value {
        None | Some(JsValue::Null) => return Ok(None),
        Some(JsValue::Obj(object)) => object,
        _ => return Err("PR 입력의 impact는 객체여야 합니다".to_owned()),
    };
    let services = match object.get("services") {
        Some(JsValue::Null) => None,
        Some(JsValue::Arr(_)) => Some(string_list(object, "services", "impact")?),
        _ => return Err("impact의 services는 글자 목록이거나 null이어야 합니다".to_owned()),
    };
    let unmatched_files = match object.get("unmatchedFiles") {
        Some(JsValue::Null) => None,
        Some(JsValue::Num(n)) => Some(*n),
        _ => return Err("impact의 unmatchedFiles는 수이거나 null이어야 합니다".to_owned()),
    };
    let backslash_sep = match object.get("backslashSep") {
        Some(JsValue::Bool(b)) => *b,
        _ => return Err("impact의 backslashSep은 참·거짓이어야 합니다".to_owned()),
    };
    Ok(Some(Impact { services, unmatched_files, protected_paths: string_list(object, "protectedPaths", "impact")?, backslash_sep }))
}

/// 입력은 껍데기가 미리 계산한 값(문서 체크포인트 여부·검증 단계만 남긴 필수 단계)을 담은 JSON이다. 모양이 어긋나면 던진다
pub fn build_pull_request(input_json: &str) -> Result<JsValue, String> {
    Ok(build_pull_request_draft(&parse_input(input_json)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed<'a>(protocol: &'a str, host: &'a str, hostname: &'a str, pathname: &'a str) -> ParsedUrl<'a> {
        ParsedUrl { protocol, host, hostname, pathname }
    }

    #[test]
    fn 원격_주소_종류() {
        let r = parse_remote("https://github.com/o/r.git", Some(&parsed("https:", "github.com", "github.com", "/o/r.git")), None);
        assert_eq!((r.kind, r.display.as_str(), r.web_url.as_deref()), ("github", "github.com/o/r", Some("https://github.com/o/r")));
        // 포트는 `:숫자`만 뗀다(`/:\d+$/`). 숫자 없는 끝 콜론이나 숫자 아닌 꼬리를 떼면 github로 넓어진다 — 실제 입력(new URL·scp 꼴)은 닿지 않지만 규칙을 고정한다
        for host in ["github.com.evil.com", "evil.github.com", "github.com.", "GitHub.com", "github.com:", "github.com:x", "github.com:1a"] {
            let r = parse_remote("x", Some(&parsed("https:", host, host, "/o/r")), None);
            assert_eq!(r.kind, "other", "{host}");
        }
        let r = parse_remote("https://github.com:443/o/r", Some(&parsed("https:", "github.com:443", "github.com", "/o/r")), None);
        assert_eq!((r.kind, r.display.as_str()), ("github", "github.com:443/o/r"));
        let r = parse_remote("ssh://git@github.com:22/o/r", Some(&parsed("ssh:", "github.com:22", "github.com", "/o/r")), None);
        assert_eq!((r.kind, r.web_url.as_deref()), ("github", Some("https://github.com/o/r")));
        let r = parse_remote("git@github.com:o/r", None, None);
        assert_eq!((r.kind, r.path.as_deref()), ("github", Some("o/r")));
        assert_eq!(parse_remote("C:\\repo", None, None).kind, "local");
        assert_eq!(parse_remote("file:///x", Some(&parsed("file:", "", "", "/x")), None).display, "/x");
        assert_eq!(parse_remote("git@host:/abs", None, None).kind, "local");
        // 제공자 지정은 정확히 같을 때만
        assert_eq!(parse_remote("git@evil.com:o/r", None, Some("gitlab")).kind, "gitlab");
        for provider in ["GitLab", " gitlab", "gitlab ", ""] {
            assert_eq!(parse_remote("git@evil.com:o/r", None, Some(provider)).kind, "other", "{provider:?}");
        }
    }

    #[test]
    fn scp_되돌아감() {
        assert_eq!(scp_match("a@:x"), Some(("a@", "x")));
        assert_eq!(scp_match("a@b:c"), Some(("b", "c")));
        assert_eq!(scp_match("a b:c"), None);
        assert_eq!(scp_match("host:"), None);
        assert_eq!(scp_match("host:\nx"), None);
    }

    #[test]
    fn 비교_주소() {
        assert_eq!(compare_url("github", Some("https://h/o/r"), "main", "feat/a b").as_deref(), Some("https://h/o/r/compare/main...feat/a%20b?expand=1"));
        assert_eq!(
            compare_url("gitlab", Some("https://h/o/r"), "main", "a b&c").as_deref(),
            Some("https://h/o/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=a+b%26c&merge_request%5Btarget_branch%5D=main")
        );
        assert_eq!(compare_url("other", Some("https://h/o/r"), "a", "b"), None);
        assert_eq!(compare_url("github", Some(""), "a", "b"), None);
    }

    #[test]
    fn 토큰() {
        assert!(can_create_pull_request("github", Some("t"), None));
        assert!(!can_create_pull_request("github", Some(""), Some("env")));
        assert!(can_create_pull_request("github", None, Some("env")));
        assert!(!can_create_pull_request("local", Some("t"), Some("t")));
    }

    #[test]
    fn pr_번호() {
        assert_eq!(parse_pull_request_number("https://github.com/o/r/pull/12"), Some(12.0));
        assert_eq!(parse_pull_request_number("x/pulls/7?a=1"), Some(7.0));
        assert_eq!(parse_pull_request_number("x/-/merge_requests/3#n"), Some(3.0));
        assert_eq!(parse_pull_request_number("x/pull/12a"), None);
        assert_eq!(parse_pull_request_number("x/pull/"), None);
        assert_eq!(parse_pull_request_number("x/pull/1x/pull/2"), Some(2.0));
    }

    #[test]
    fn 체크리스트() {
        let items = |body: &str| body.split('\n').filter_map(match_task_item).collect::<Vec<_>>();
        assert_eq!(items("- [ ] a\n* [X] b"), vec![(false, "a".to_owned()), (true, "b".to_owned())]);
        assert_eq!(items("- [x] a\r"), vec![]);
        assert_eq!(items("- [ ]  "), vec![(false, String::new())]);
        assert_eq!(items("- [ ] "), vec![]);
        assert_eq!(items("-[ ] a"), vec![]);
        assert_eq!(items("- [y] a"), vec![]);
    }

    #[test]
    fn 닫기_문구() {
        assert_eq!(parse_closing_references(Some("Closes #12, fixes: #7\nresolved   #12")), vec![12.0, 7.0]);
        assert_eq!(parse_closing_references(Some("unfixes #1 prefix#1 closes#2")), vec![2.0]);
        assert_eq!(parse_closing_references(Some("closes:#1 FIXED #03")), vec![1.0, 3.0]);
        assert_eq!(parse_closing_references(Some("fixe #1 close #4")), vec![4.0]);
    }

    #[test]
    fn 본문_합치기() {
        let merged = merge_managed_pull_request_body(Some("사람 글"), "관리");
        assert_eq!(merged, format!("사람 글\n\n{PR_MANAGED_BODY_BEGIN}\n관리\n{PR_MANAGED_BODY_END}"));
        assert_eq!(merge_managed_pull_request_body(Some(&merged), "새 글"), format!("사람 글\n\n{PR_MANAGED_BODY_BEGIN}\n새 글\n{PR_MANAGED_BODY_END}"));
        assert!(merge_managed_pull_request_body(None, &"가".repeat(70_000)).ends_with(PR_MANAGED_BODY_END));
    }

    #[test]
    fn 계약_기록은_요약_앞의_보고서_줄만_읽는다() {
        let body = "검증 통과\n- api 계약:\n    ＋ operation-added GET /api/orders/{id}\n    ⚠️ 호환 깨짐 property-removed Order.total (기존 필드 삭제)\n- web: 재시작 후 준비 완료\n\n에이전트 요약:\n- api 계약:\n    ⚠️ 호환 깨짐 property-removed X.y";
        let record = parse_contract_record(body);
        assert!(record.recorded && !record.failed);
        let seen: Vec<(&str, &str, bool)> = record.changes.iter().map(|c| (c.kind.as_str(), c.target.as_str(), c.breaking)).collect();
        assert_eq!(seen, vec![("operation-added", "GET /api/orders/{id}", false), ("property-removed", "Order.total", true)]);
    }

    #[test]
    fn 모르는_모양의_계약_줄과_추출_실패는_모름이다() {
        let unknown_kind = parse_contract_record("- api 계약:\n    ＋ 처음_보는_종류 Order.x");
        assert!(unknown_kind.recorded && unknown_kind.failed && unknown_kind.changes.is_empty());
        let free_text = parse_contract_record("- api 계약:\n    뭔가 바뀜");
        assert!(free_text.failed);
        let extract_failed = parse_contract_record("- api 계약 추출 실패: 연결 거부");
        assert!(!extract_failed.recorded && extract_failed.failed);
        let none = parse_contract_record("- api: 재시작 후 준비 완료\n    마지막 로그");
        assert!(!none.recorded && !none.failed);
        let clean = parse_contract_record("- api 계약:\n    계약 변경 없음\n- web 계약:\n    계약 변경 없음");
        assert!(clean.recorded && !clean.failed && clean.changes.is_empty());
    }

    #[test]
    fn 허용한_확인_선언_변경_줄은_요약_앞에서만_읽고_길이를_자른다() {
        assert_eq!(parse_declared_change("확인 선언 변경: 삭제: tests.slow\n\n에이전트 요약:\n확인 선언 변경: 가짜").as_deref(), Some("삭제: tests.slow"));
        assert_eq!(parse_declared_change("에이전트 요약:\n확인 선언 변경: 가짜"), None);
        assert_eq!(parse_declared_change("확인 선언 변경:   "), None);
        let long = parse_declared_change(&format!("확인 선언 변경: {}", "가".repeat(300))).unwrap();
        assert_eq!(long.chars().count(), DECLARED_CHANGE_DETAIL_MAX + 1);
    }

    #[test]
    fn 마이그레이션으로_보이는_파일() {
        for file in ["api/src/main/resources/db/migration/V2__memo.sql", "prisma/migrations/2024_init/migration.sql", "db/migrate/20240101_add.rb", "alembic/versions/ab12_add.py", "sql/V10__x.sql", "sql/R__views.sql", "DB/Migrations/x.cs"] {
            assert!(looks_like_migration(file), "{file}");
        }
        for file in ["api/src/Order.java", "db/schema.sql", "docs/migration-guide.md", "src/versions/x.py", "sql/Vx__y.sql", "sql/report.sql"] {
            assert!(!looks_like_migration(file), "{file}");
        }
    }
}
