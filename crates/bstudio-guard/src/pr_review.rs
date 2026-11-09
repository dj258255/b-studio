//! PR 자동 리뷰 라운드(ADR-074)의 순수 판정과 글 만들기(옛 TS: `packages/agent/src/pr-review.ts`).
//!
//! 모델 호출(`requestPrReview`), 응답 스키마(zod)와 응답 해석(`parsePrReviewReply`), 시스템 프롬프트는 TS에 남는다.
//!
//! JS와 같게 읽는 곳:
//! - 글자 수·자르기는 UTF-16 코드 단위다(`js::utf16_len`, `slice_head`). 서로게이트 쌍을 가르는 자리는 U+FFFD가 된다(napi 경계 규칙).
//! - 정규식은 TS의 글자를 그대로 `js_regex`에 넣어 옮긴다: `\s`는 `js::WS_CLASS`, `.`는 줄 끝 글자를 뺀 모임, `\b`·`\w`·`\d`는 ASCII.
//! - 지적(finding)은 JSON(`JsValue`)으로 받는다. 값의 종류가 어긋나면 JS가 하는 대로 읽는다(없는 값은 `undefined`, 거짓인 값은 생략)
//!   하되 JS가 던지는 자리(`.replace`가 없는 값, `null.file` 등)는 `Err`다.
//! - 숫자를 글자로(`${round}`)는 `JsValue::to_js_string`(JS `Number::toString`).

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::js::{self, LINE_TERMINATORS, WS_CLASS};
use crate::js_json::{self, JsValue};

/// 고침 요청 글의 맨 앞에 붙는 표시. `extract_pr_review_fix_titles`가 이 표시로 AI 리뷰 고침 요청을 알아본다
pub const FIX_MARKER: &str = "[b-studio AI 리뷰]";

// ── JS 정규식 옮기기
/// JS 정규식 글자(`/.../`의 안쪽)를 Rust `regex`로 바꾼다. 바꾸는 규칙: `\s`·`\S`는 JS 공백 집합, `.`는 줄 끝 글자(`\n` `\r` U+2028 U+2029)를 뺀 모임,
/// `\b`는 ASCII 경계, `\w`·`\d`는 ASCII, `\/`는 `/`. `[...]` 안에서는 `\s`·`\w`·`\d`를 펼쳐 쓰고 `.`는 그대로 점이다.
/// `.{n,m}`처럼 글자 수를 세는 점은 JS가 UTF-16 코드 단위로 세어 글자와 다르므로 받지 않는다(손으로 쓴다).
pub fn js_regex(pattern: &str, ignore_case: bool) -> Regex {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    if ignore_case {
        out.push_str("(?i)");
    }
    let mut in_class = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let next = *chars.get(i + 1).expect("끝의 역슬래시");
            i += 2;
            match (next, in_class) {
                ('s', false) => out.push_str(&format!("[{WS_CLASS}]")),
                ('s', true) => out.push_str(WS_CLASS),
                ('S', false) => out.push_str(&format!("[^{WS_CLASS}]")),
                ('S', true) => panic!("클래스 안의 \\S는 옮기지 않는다"),
                ('w', false) => out.push_str("[A-Za-z0-9_]"),
                ('w', true) => out.push_str("A-Za-z0-9_"),
                ('d', false) => out.push_str("[0-9]"),
                ('d', true) => out.push_str("0-9"),
                ('b', false) => out.push_str("(?-u:\\b)"),
                ('/', _) => out.push('/'),
                (other, _) => {
                    out.push('\\');
                    out.push(other);
                }
            }
            continue;
        }
        if in_class {
            if c == ']' {
                in_class = false;
            }
            out.push(c);
        } else {
            match c {
                '[' => {
                    in_class = true;
                    out.push('[');
                    if chars.get(i + 1) == Some(&'^') {
                        out.push('^');
                        i += 1;
                    }
                }
                '.' => {
                    assert!(chars.get(i + 1) != Some(&'{'), "글자 수를 세는 점은 옮기지 않는다");
                    out.push_str(&format!("[^{LINE_TERMINATORS}]"));
                }
                _ => out.push(c),
            }
        }
        i += 1;
    }
    Regex::new(&out).unwrap_or_else(|e| panic!("정규식 {pattern}: {e}"))
}

// ── 글 길이·자르기·숫자 꼴
/// JS `s.slice(0, end)`. `end`는 아무 수나 받는다(NaN은 0, 소수는 0쪽으로 버림, 음수는 끝에서부터). UTF-16 코드 단위로 자르고
/// 서로게이트 쌍을 가르면 U+FFFD가 된다
pub fn slice_head(s: &str, end: f64) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let len = units.len() as f64;
    let n = if end.is_nan() { 0.0 } else { end.trunc() };
    let stop = if n < 0.0 { (len + n).max(0.0) } else { n.min(len) } as usize;
    String::from_utf16_lossy(&units[..stop])
}

/// `Number.prototype.toLocaleString()`(ko·en 공통: 천 단위 쉼표). 정수만 받는다. 소수·NaN·무한대는 로케일마다 꼴이 달라 `Err`
pub fn locale_integer(x: f64) -> Result<String, String> {
    if !x.is_finite() || x.fract() != 0.0 || x.abs() >= 1e21 {
        return Err(format!("{}은(는) 쉼표로 묶어 쓰지 못하는 수입니다(정수만 받습니다)", js::number_to_string(x)));
    }
    if x == 0.0 {
        return Ok(if x.is_sign_negative() { "-0" } else { "0" }.into());
    }
    let digits = format!("{:.0}", x.abs());
    let mut grouped = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    Ok(if x < 0.0 { format!("-{grouped}") } else { grouped })
}

fn group_usize(n: usize) -> String {
    locale_integer(n as f64).expect("정수")
}

/// 템플릿 리터럴의 `${값}`. 없으면 `undefined`
fn tpl(v: Option<&JsValue>) -> String {
    v.map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
}

fn truthy(v: Option<&JsValue>) -> bool {
    v.is_some_and(JsValue::truthy)
}

/// 문자열이어야 하는 자리(`.replace`·`.slice`를 부르는 값). 아니면 JS는 TypeError를 던진다
fn need_str<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a str, String> {
    match v {
        Some(JsValue::Str(s)) => Ok(s),
        _ => Err(format!("{what}이(가) 문자열이 아닙니다")),
    }
}

/// `array.join(sep)`. `null`·`undefined` 항목은 빈 글자
fn join_js(items: &[JsValue], sep: &str) -> String {
    items.iter().map(|v| if matches!(v, JsValue::Null) { String::new() } else { v.to_js_string() }).collect::<Vec<_>>().join(sep)
}

fn need_array<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a [JsValue], String> {
    match v {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{what}이(가) 배열이 아닙니다")),
    }
}

// ── 심각도·차단 판정
/// 차단 사유로 보는 심각도(차단·주요). 스타일 지적은 이 등급으로 두지 못한다
pub fn is_blocking_severity(severity: &str) -> bool {
    matches!(severity, "blocker" | "major")
}

pub fn has_blocking_findings(severities: &[String]) -> bool {
    severities.iter().any(|s| is_blocking_severity(s))
}

/// `[blocker, major, minor, nit]`. 모르는 심각도는 세지 않는다(옛 TS는 그 이름의 키를 NaN으로 만들었다 — 의도한 차이)
pub fn severity_counts(severities: &[String]) -> [u32; 4] {
    let mut counts = [0u32; 4];
    for s in severities {
        match s.as_str() {
            "blocker" => counts[0] += 1,
            "major" => counts[1] += 1,
            "minor" => counts[2] += 1,
            "nit" => counts[3] += 1,
            _ => {}
        }
    }
    counts
}

/// 이번 라운드 뒤 무엇을 할지(`pass`·`cap`·`fix`). pass: 차단·주요 지적이 없다. cap: 있지만 라운드 상한에 이르렀다.
/// fix: 있고 라운드가 남았다. `round`·`maxRounds`는 아무 수나 받는다(NaN이면 `>=`가 거짓이라 fix)
pub fn next_pr_review_step(severities: &[String], round: f64, max_rounds: f64) -> &'static str {
    if !has_blocking_findings(severities) {
        return "pass";
    }
    if round >= max_rounds {
        return "cap";
    }
    "fix"
}

fn severity_label(severity: Option<&JsValue>) -> &'static str {
    match severity.and_then(JsValue::as_str) {
        Some("blocker") => "차단",
        Some("major") => "주요",
        Some("minor") => "경미",
        Some("nit") => "사소",
        _ => "undefined",
    }
}

fn is_blocking_value(severity: Option<&JsValue>) -> bool {
    severity.and_then(JsValue::as_str).is_some_and(is_blocking_severity)
}

// ── diff
struct DiffSection {
    path: String,
    text: String,
}

static DIFF_HEADER: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^diff --git a\/(.+?) b\/(.+)$", false));

fn diff_header_path(line: &str) -> String {
    match DIFF_HEADER.captures(line) {
        Some(c) => c[2].to_owned(),
        None => line["diff --git ".len()..].to_owned(),
    }
}

/// unified diff를 `diff --git a/x b/y` 줄 기준으로 파일 구간으로 나눈다. 첫 머리 줄 앞의 글자는 경로가 빈 구간이 된다
fn split_diff_files(diff: &str) -> Vec<DiffSection> {
    let mut sections = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    let mut path = String::new();
    for line in diff.split('\n') {
        if line.starts_with("diff --git ") {
            if let Some(lines) = current.take() {
                sections.push(DiffSection { path: path.clone(), text: lines.join("\n") });
            }
            current = Some(vec![line]);
            path = diff_header_path(line);
        } else {
            current.get_or_insert_with(Vec::new).push(line);
        }
    }
    if let Some(lines) = current.take() {
        sections.push(DiffSection { path, text: lines.join("\n") });
    }
    sections
}

pub struct TruncatedDiff {
    pub diff: String,
    pub truncated: bool,
    pub omitted_files: Vec<String>,
}

impl TruncatedDiff {
    /// 옛 TS의 `{ diff, truncated, omittedFiles }`(키 순서 그대로)
    pub fn to_json(&self) -> String {
        js_json::stringify(&js_json::object(vec![
            ("diff", Some(JsValue::str(&self.diff))),
            ("truncated", Some(JsValue::Bool(self.truncated))),
            ("omittedFiles", Some(JsValue::Arr(self.omitted_files.iter().map(JsValue::str).collect()))),
        ]))
    }
}

/// diff가 상한을 넘으면 가장 큰 파일부터 본문을 생략 노트로 바꿔 상한 아래로 줄인다. `diff --git` 구분이 없으면 통째로 잘라 노트를 붙인다.
/// 그 노트에 상한을 쉼표로 묶어 적으므로 이 갈래에서만 `max_chars`는 정수여야 한다
pub fn truncate_diff(diff: &str, max_chars: f64) -> Result<TruncatedDiff, String> {
    let len = js::utf16_len(diff) as f64;
    if len <= max_chars {
        return Ok(TruncatedDiff { diff: diff.to_owned(), truncated: false, omitted_files: Vec::new() });
    }

    if !diff.contains("diff --git ") {
        return Ok(TruncatedDiff {
            diff: format!("{}\n\n<!-- 크기 제한({}자)으로 diff 뒷부분을 생략했습니다 -->\n", slice_head(diff, max_chars), locale_integer(max_chars)?),
            truncated: true,
            omitted_files: Vec::new(),
        });
    }

    let sections = split_diff_files(diff);
    let mut kept: Vec<String> = sections.iter().map(|s| s.text.clone()).collect();
    let mut omitted = Vec::new();
    let mut total: f64 = kept.iter().map(|t| (js::utf16_len(t) + 1) as f64).sum();
    let mut by_size: Vec<(usize, usize)> = sections.iter().enumerate().map(|(i, s)| (i, js::utf16_len(&s.text))).collect();
    by_size.sort_by_key(|entry| std::cmp::Reverse(entry.1)); // 안정 정렬: 크기가 같으면 앞 파일이 먼저
    for (index, size) in by_size {
        if total <= max_chars {
            break;
        }
        let path = &sections[index].path;
        let note = format!("diff --git a/{path} b/{path}\n<!-- 파일이 커서 생략했습니다 ({}자) -->", group_usize(size));
        total += js::utf16_len(&note) as f64 - js::utf16_len(&kept[index]) as f64;
        kept[index] = note;
        omitted.push(path.clone());
    }
    let truncated = !omitted.is_empty() || len > max_chars;
    Ok(TruncatedDiff { diff: kept.join("\n"), truncated, omitted_files: omitted })
}

/// diff에 실제로 들어 있는 파일 경로들
pub fn diff_file_paths(diff: &str) -> Vec<String> {
    split_diff_files(diff).into_iter().map(|s| s.path).collect()
}

static RELATIVE_IMPORT: LazyLock<Regex> = LazyLock::new(|| js_regex(r#"\bfrom\s+['"](\.[^'"]+)['"]"#, false));
static REQUIRE_IMPORT: LazyLock<Regex> = LazyLock::new(|| js_regex(r#"\brequire\(\s*['"](\.[^'"]+)['"]\s*\)"#, false));
static PYTHON_IMPORT: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^\s*from\s+[\w.]+\s+import\s+(\w+)", false));
static DOTTED_IMPORT: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^\s*import\s+(?:static\s+)?([\w.]+)\s*;?\s*$", false));
static PASCAL_IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\b[A-Z][a-zA-Z0-9]{2,40}\b", false));

/// 전부 대문자인 식별자(SQL, API, URL 등 흔한 약어)는 클래스 이름 후보에서 뺀다
fn looks_like_acronym(identifier: &str) -> bool {
    !identifier.bytes().any(|b| b.is_ascii_lowercase())
}

/// diff의 추가된 줄에서 "이 PR이 가리키지만 diff에는 없는" 파일 이름 후보를 뽑는다. 지운 줄은 보지 않는다
pub fn extract_diff_referenced_names(diff: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |name: &str| {
        if seen.insert(name.to_owned()) {
            names.push(name.to_owned());
        }
    };
    for line in diff.split('\n') {
        if !line.starts_with('+') || line.starts_with("+++") {
            continue;
        }
        let body = &line[1..];

        if let Some(c) = RELATIVE_IMPORT.captures(body).or_else(|| REQUIRE_IMPORT.captures(body)) {
            let last = c[1].rsplit('/').next().unwrap_or("");
            let base = [".tsx", ".ts", ".jsx", ".js"].iter().find_map(|ext| last.strip_suffix(ext)).unwrap_or(last);
            if !base.is_empty() {
                add(base);
            }
        }

        if let Some(c) = PYTHON_IMPORT.captures(body).or_else(|| DOTTED_IMPORT.captures(body)) {
            let whole = &c[1];
            let last = if whole.contains('.') { whole.rsplit('.').next().unwrap_or("") } else { whole };
            if !last.is_empty() && last != "*" {
                add(last);
            }
        }

        for m in PASCAL_IDENTIFIER.find_iter(body) {
            if !looks_like_acronym(m.as_str()) {
                add(m.as_str());
            }
        }
    }
    names
}

// ── 바깥 파일 미리보기
/// diff 밖 파일의 짧은 미리보기를 리뷰어 프롬프트에 붙일 섹션으로 만든다. 상한을 넘으면 앞에서부터 채우고 자른다.
/// `max_chars`는 아무 수나 받는다(NaN이면 견줌이 거짓이라 다 담는다)
pub fn build_pr_review_external_context(paths: &[String], excerpts: &[String], max_chars: f64) -> String {
    if paths.is_empty() {
        return String::new();
    }
    let header = "[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 \"없다\"고 단정하지 마세요]";
    let mut used = js::utf16_len(header) as f64;
    let mut blocks: Vec<String> = vec![header.to_owned()];
    for (path, excerpt) in paths.iter().zip(excerpts) {
        let block = format!("--- {path} ---\n{excerpt}");
        let size = js::utf16_len(&block) as f64;
        if used + size + 1.0 > max_chars {
            break;
        }
        blocks.push(block);
        used += size + 1.0;
    }
    blocks.join("\n\n")
}

// ── 프롬프트·코멘트
/// `requirementsContext?.trim()`: 없으면(undefined·null) 빈 글자, 문자열이면 앞뒤 공백을 뗀 것, 그 밖은 JS가 던진다
fn trimmed_context(v: Option<&JsValue>, what: &str) -> Result<String, String> {
    match v {
        None | Some(JsValue::Null) => Ok(String::new()),
        Some(JsValue::Str(s)) => Ok(js::trim(s).to_owned()),
        _ => Err(format!("{what}이(가) 문자열이 아닙니다")),
    }
}

/// 리뷰어에게 주는 요청별 사용자 메시지. `input`은 `{ diff, requests, round, omittedFiles?, requirementsContext?, externalContext?, resolvedContext? }`
pub fn build_pr_review_user_prompt(input: &JsValue) -> Result<String, String> {
    let diff = tpl(input.prop("diff"));
    let requests = need_array(input.prop("requests"), "requests")?;
    let round = tpl(input.prop("round"));
    let omitted: &[JsValue] = match input.prop("omittedFiles") {
        None => &[],
        other => need_array(other, "omittedFiles")?,
    };
    let request_list = if requests.is_empty() {
        "(기록 없음)".to_owned()
    } else {
        requests.iter().enumerate().map(|(i, r)| format!("{}. {}", i + 1, r.to_js_string())).collect::<Vec<_>>().join("\n")
    };
    let omitted_note = if omitted.is_empty() { String::new() } else { format!("\n(크기 제한으로 다음 파일은 diff에서 생략했습니다: {})\n", join_js(omitted, ", ")) };
    let note = |v: Option<&JsValue>, what: &str| -> Result<String, String> {
        let t = trimmed_context(v, what)?;
        Ok(if t.is_empty() { t } else { format!("\n{t}\n") })
    };
    let requirements_note = note(input.prop("requirementsContext"), "requirementsContext")?;
    let external_note = note(input.prop("externalContext"), "externalContext")?;
    let resolved_note = note(input.prop("resolvedContext"), "resolvedContext")?;
    Ok(format!(
        "Review round {round}.\n\nUser's original requests for this session, in order:\n{request_list}\n{omitted_note}{requirements_note}{resolved_note}\nDiff (base...head):\n```diff\n{diff}\n```\n{external_note}"
    ))
}

/// 코멘트마다 붙이는 숨은 표시
pub fn pr_review_marker(round: f64) -> String {
    format!("<!-- b-studio-review round={} -->", js::number_to_string(round))
}

/// 표 칸 하나: `|`를 이스케이프하고 줄바꿈을 공백으로 바꾼 뒤 500자(UTF-16)까지만
fn escape_cell(text: &str) -> String {
    let piped = text.replace('|', "\\|");
    let flat = piped.replace("\r\n", " ").replace('\n', " ");
    slice_head(&flat, 500.0)
}

fn finding_object<'a>(v: &'a JsValue, what: &str) -> Result<&'a JsValue, String> {
    match v {
        JsValue::Null => Err(format!("{what}이(가) null입니다")),
        other => Ok(other),
    }
}

/// `${file}${line ? `:${line}` : ''}`
fn finding_location(finding: &JsValue) -> String {
    let line = finding.prop("line");
    format!("{}{}", tpl(finding.prop("file")), if truthy(line) { format!(":{}", tpl(line)) } else { String::new() })
}

/// PR 코멘트 본문(한국어 표 + 숨은 표시).
/// `input`은 `{ round, maxRounds, findings, outcome, omittedFiles?, commitRange? }`
pub fn build_pr_review_comment(input: &JsValue) -> Result<String, String> {
    let round = tpl(input.prop("round"));
    let max_rounds = tpl(input.prop("maxRounds"));
    let findings = need_array(input.prop("findings"), "findings")?;
    let omitted: &[JsValue] = match input.prop("omittedFiles") {
        None => &[],
        other => need_array(other, "omittedFiles")?,
    };

    let mut severities = Vec::new();
    for finding in findings {
        let f = finding_object(finding, "지적")?;
        severities.push(f.prop("severity").and_then(JsValue::as_str).unwrap_or("").to_owned());
    }
    let counts = severity_counts(&severities);
    let summary = format!("차단 {} · 주요 {} · 경미 {} · 사소 {}", counts[0], counts[1], counts[2], counts[3]);

    let range_note = match input.prop("commitRange") {
        None | Some(JsValue::Null) => String::new(),
        Some(range) => {
            let since = range.prop("since");
            if truthy(since) {
                let since = need_str(since, "commitRange.since")?;
                let head = need_str(range.prop("head"), "commitRange.head")?;
                format!("\n\n커밋 범위: `{}`..`{}`", slice_head(since, 7.0), slice_head(head, 7.0))
            } else {
                String::new()
            }
        }
    };
    let header = format!("## 🤖 AI 리뷰 — 라운드 {round}/{max_rounds}{range_note}\n\n{summary}");

    let table = if findings.is_empty() {
        "지적할 내용이 없습니다.".to_owned()
    } else {
        let mut rows = vec!["| 심각도 | 위치 | 제목 | 설명 |".to_owned(), "|---|---|---|---|".to_owned()];
        for finding in findings {
            let f = finding_object(finding, "지적")?;
            let location = finding_location(f);
            let suggestion = f.prop("suggestion");
            let detail = if truthy(suggestion) {
                format!("{} (제안: {})", tpl(f.prop("detail")), tpl(suggestion))
            } else {
                need_str(f.prop("detail"), "detail")?.to_owned()
            };
            let title = need_str(f.prop("title"), "title")?;
            rows.push(format!("| {} | `{}` | {} | {} |", severity_label(f.prop("severity")), escape_cell(&location), escape_cell(title), escape_cell(&detail)));
        }
        rows.join("\n")
    };

    let footer = match input.prop("outcome").and_then(JsValue::as_str) {
        Some("pass") => "차단·주요 지적이 없어 사람 검토를 기다립니다.".to_owned(),
        Some("cap") => format!("라운드 상한({max_rounds})에 도달해 남은 지적은 사람이 검토합니다."),
        _ => "차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.".to_owned(),
    };
    let omitted_note = if omitted.is_empty() { String::new() } else { format!("\n\n(참고: 크기 제한으로 다음 파일은 생략하고 리뷰했습니다: {})", join_js(omitted, ", ")) };
    let marker = format!("<!-- b-studio-review round={round} -->");
    Ok(format!("{header}\n\n{table}\n\n{footer}{omitted_note}\n\n{marker}"))
}

/// 이전 라운드에서 사람이 오탐으로 닫은 지적들을 리뷰어 문맥에 "이미 확인했다"고 알리는 섹션으로 만든다. 없으면 빈 글자.
/// `resolved`는 `{ severity, file, line?, title, reason }`의 배열
pub fn build_pr_review_resolved_context(resolved: &JsValue) -> Result<String, String> {
    let items = need_array(Some(resolved), "resolved")?;
    if items.is_empty() {
        return Ok(String::new());
    }
    let mut lines = Vec::new();
    for item in items {
        let f = finding_object(item, "지적")?;
        lines.push(format!(
            "- [{}] `{}` — {}: 사람이 오탐으로 닫았습니다({})",
            severity_label(f.prop("severity")),
            finding_location(f),
            tpl(f.prop("title")),
            tpl(f.prop("reason"))
        ));
    }
    Ok(format!("[이미 사람이 확인한 지적 — 새 근거 없이 되풀이하지 마세요]\n{}", lines.join("\n")))
}

/// 사람이 지적 하나를 오탐으로 닫을 때 PR에 답글처럼 남기는 코멘트. `reason`은 `${reason}` 템플릿
pub fn build_review_resolution_comment(finding: &JsValue, reason: Option<&JsValue>) -> Result<String, String> {
    let f = finding_object(finding, "지적")?;
    Ok(format!(
        "## 🙋 사람이 리뷰 지적을 확인했습니다\n\n> [{}] `{}` — {}\n\n오탐으로 닫습니다: {}",
        severity_label(f.prop("severity")),
        finding_location(f),
        tpl(f.prop("title")),
        tpl(reason)
    ))
}

/// 지적을 고쳐 달라는 후속 요청 문구. 차단·주요 지적만 담고 제목은 **굵게** 감싼다
pub fn build_pr_review_fix_request(findings: &JsValue) -> Result<String, String> {
    let all = need_array(Some(findings), "findings")?;
    let mut items = Vec::new();
    for finding in all {
        let f = finding_object(finding, "지적")?;
        if !is_blocking_value(f.prop("severity")) {
            continue;
        }
        let suggestion = f.prop("suggestion");
        let suggestion_text = if truthy(suggestion) { format!(" 제안: {}", tpl(suggestion)) } else { String::new() };
        items.push(format!(
            "{}. [{}] `{}` — **{}**: {}{}",
            items.len() + 1,
            severity_label(f.prop("severity")),
            finding_location(f),
            tpl(f.prop("title")),
            tpl(f.prop("detail")),
            suggestion_text
        ));
    }
    Ok(format!("{FIX_MARKER} 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\n\n{}", items.join("\n")))
}

static BOLD_TITLE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\*\*(.+?)\*\*", false));

/// `build_pr_review_fix_request`가 만든 고침 요청 글에서 지적 제목들만 뽑는다. 표시로 시작하지 않거나 제목이 없으면 `None`
pub fn extract_pr_review_fix_titles(request: &str) -> Option<Vec<String>> {
    if !request.starts_with(FIX_MARKER) {
        return None;
    }
    let titles: Vec<String> = BOLD_TITLE.captures_iter(request).map(|c| js::trim(&c[1]).to_owned()).filter(|t| !t.is_empty()).collect();
    if titles.is_empty() {
        None
    } else {
        Some(titles)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sev(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn 차단_판정은_차단과_주요뿐이다() {
        assert!(has_blocking_findings(&sev(&["nit", "major"])));
        assert!(has_blocking_findings(&sev(&["blocker"])));
        assert!(!has_blocking_findings(&sev(&["minor", "nit", "urgent", ""])));
        assert!(!has_blocking_findings(&[]));
    }

    #[test]
    fn 라운드_판정은_차단이_없으면_pass_있으면_상한에서_cap() {
        let blocking = sev(&["major"]);
        assert_eq!(next_pr_review_step(&sev(&["nit"]), 99.0, 1.0), "pass");
        assert_eq!(next_pr_review_step(&blocking, 1.0, 2.0), "fix");
        assert_eq!(next_pr_review_step(&blocking, 2.0, 2.0), "cap");
        assert_eq!(next_pr_review_step(&blocking, 3.0, 2.0), "cap");
        assert_eq!(next_pr_review_step(&blocking, f64::NAN, 2.0), "fix");
    }

    #[test]
    fn 심각도_수는_모르는_값을_세지_않는다() {
        assert_eq!(severity_counts(&sev(&["blocker", "nit", "nit", "urgent"])), [1, 0, 0, 2]);
    }

    #[test]
    fn 쉼표_묶음은_정수만_받는다() {
        assert_eq!(locale_integer(60000.0).unwrap(), "60,000");
        assert_eq!(locale_integer(999.0).unwrap(), "999");
        assert_eq!(locale_integer(1000.0).unwrap(), "1,000");
        assert_eq!(locale_integer(-1234567.0).unwrap(), "-1,234,567");
        assert_eq!(locale_integer(-0.0).unwrap(), "-0");
        assert!(locale_integer(1.5).is_err());
        assert!(locale_integer(f64::NAN).is_err());
        assert!(locale_integer(f64::INFINITY).is_err());
    }

    #[test]
    fn 앞쪽_자르기는_utf16_단위이고_범위를_JS처럼_바로잡는다() {
        assert_eq!(slice_head("abcdef", 3.0), "abc");
        assert_eq!(slice_head("abcdef", 99.0), "abcdef");
        assert_eq!(slice_head("abcdef", -2.0), "abcd");
        assert_eq!(slice_head("abcdef", -99.0), "");
        assert_eq!(slice_head("abcdef", f64::NAN), "");
        assert_eq!(slice_head("abcdef", 2.9), "ab");
        assert_eq!(slice_head("가🙂나", 3.0), "가🙂");
        assert_eq!(slice_head("가🙂나", 2.0), "가\u{FFFD}");
    }

    #[test]
    fn js_정규식_옮기기는_점과_공백과_경계를_JS처럼_읽는다() {
        let dot = js_regex(r"^a.b$", false);
        assert!(dot.is_match("axb"));
        assert!(!dot.is_match("a\u{2028}b"));
        assert!(!dot.is_match("a\rb"));
        let space = js_regex(r"a\sb", false);
        assert!(space.is_match("a\u{FEFF}b"));
        assert!(!space.is_match("a\u{85}b"));
        let word = js_regex(r"\bR\d+\b", false);
        assert!(word.is_match("R25를"));
        assert!(!word.is_match("xR25"));
        assert!(!js_regex(r"^\d$", false).is_match("\u{0663}"));
        let ci = js_regex(r"^fix$", true);
        assert!(ci.is_match("FIX"));
    }

    #[test]
    #[should_panic]
    fn 글자_수를_세는_점은_옮기지_않는다() {
        let _ = js_regex(r"a.{0,25}b", false);
    }

    #[test]
    fn 머리_줄은_첫_b_슬래시에서_나눈다() {
        assert_eq!(diff_file_paths("diff --git a/x y b/p q\n+1"), vec!["p q"]);
        assert_eq!(diff_file_paths("diff --git a/a b/b b/c"), vec!["b b/c"]);
        assert_eq!(diff_file_paths("diff --git a/x b/y\r"), vec!["a/x b/y\r"]);
        assert_eq!(diff_file_paths("앞\ndiff --git a/x b/y"), vec!["", "y"]);
        assert_eq!(diff_file_paths(""), vec![""]);
    }

    #[test]
    fn diff_자르기는_상한과_같으면_자르지_않고_큰_파일부터_생략한다() {
        let diff = format!("diff --git a/s b/s\n+s\ndiff --git a/big b/big\n+{}", "b".repeat(200));
        let len = js::utf16_len(&diff) as f64;
        assert!(!truncate_diff(&diff, len).unwrap().truncated);
        let cut = truncate_diff(&diff, len - 1.0).unwrap();
        assert!(cut.truncated);
        assert_eq!(cut.omitted_files, vec!["big"]);
        assert!(cut.diff.contains("<!-- 파일이 커서 생략했습니다 (224자) -->"));
        assert!(cut.diff.starts_with("diff --git a/s b/s\n+s\n"));
    }

    #[test]
    fn 이름_뽑기는_지운_줄과_머리_줄을_보지_않는다() {
        let names = extract_diff_referenced_names("+++ b/Skip.ts\n+import x from './Local.tsx'\n-OldName\n+SeedLoader HTTP\n+from pkg import Thing");
        assert_eq!(names, vec!["Local", "SeedLoader", "Thing"]);
    }

    #[test]
    fn 고침_제목은_표시로_시작할_때만_뽑는다() {
        assert_eq!(extract_pr_review_fix_titles("[b-studio AI 리뷰] **a** x ** b **").unwrap(), vec!["a", "b"]);
        assert!(extract_pr_review_fix_titles("**a**").is_none());
        assert!(extract_pr_review_fix_titles("[b-studio AI 리뷰] ** **").is_none());
    }

    #[test]
    fn 코멘트는_지적_종류에_따라_표를_만든다() {
        let input = js_json::parse(r#"{"round":1,"maxRounds":2,"outcome":"cap","findings":[{"severity":"major","file":"a|b.ts","line":3,"title":"t","detail":"d","suggestion":"s"}],"commitRange":{"since":"abcdef0123","head":"1234567890"}}"#).unwrap();
        let text = build_pr_review_comment(&input).unwrap();
        assert!(text.contains("라운드 1/2\n"));
        assert!(text.contains("커밋 범위: `abcdef0`..`1234567`"));
        assert!(text.contains("| 주요 | `a\\|b.ts:3` | t | d (제안: s) |"));
        assert!(text.contains("라운드 상한(2)에 도달해"));
        assert!(text.ends_with("<!-- b-studio-review round=1 -->"));
    }
}
