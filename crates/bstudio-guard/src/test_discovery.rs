//! 테스트 탭(ADR-084)의 발견 단계: 테스트 파일의 내용에서 스위트(클래스·describe)와 테스트(메서드·it/test·def test_)를
//! 줄 번호와 함께 트리로 읽는다(옛 TS: `packages/agent/src/test-discovery.ts`). 순수 함수만 있다.
//!
//! JS 정규식과 같게 읽는 곳:
//! - `\b`·`\w`·`\d`는 ASCII다. `\s`는 JS 공백 집합(`js::WS_CLASS`), `.`은 줄 끝 글자(`\n` `\r` U+2028 U+2029)를 뺀다.
//! - `JS_DESCRIBE`·`JS_TEST`는 `(?!\2)`와 역참조를 쓴다. Rust `regex`는 지원하지 않아 앞부분(`describe(` 까지)만 정규식으로
//!   찾고, 따옴표 문자열은 `quoted_end`가 손으로 읽는다. 이 정규식은 **되돌아가며** 맞춘다: `\\.`로 건너뛴 뒤에서 닫는 따옴표를
//!   못 찾으면 백슬래시 하나만 먹고 다시 시도한다(`test('a\')`는 제목 `a\`로 맞는다). `quoted_end`는 이 우선순위를 그대로 따른다.
//! - 정규식은 줄의 첫 맞음(왼쪽 시작부터, 안 맞으면 다음 시작 위치)을 찾는다. 앞부분이 맞았는데 따옴표가 안 맞으면
//!   다음 시작 위치에서 다시 찾는다.
//! - UTF-16 코드 단위와 글자의 차이는 결과에 나타나지 않는다: 비교하는 글자는 모두 BMP이고, 서로게이트 쌍은 한 글자로 읽어도
//!   (`\\.`가 상위 절반만 먹고 하위 절반은 다음 반복이 먹는 JS와) 같은 결과다. 들여쓰기 길이는 `\s`(모두 BMP) 개수다.
//! - `split(/\r?\n/)`은 `\n`으로 나눠 끝의 `\r` 하나를 떼는 것과 같다.

use regex::{Captures, Regex};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::js::{self, is_js_line_terminator, LINE_TERMINATORS, WS_CLASS};

const ANNOTATION_ARGUMENT_MAX_LINES: usize = 20;

fn re(pattern: String) -> Regex {
    Regex::new(&pattern).expect("정규식")
}

// ── 정규식. `\w`=[A-Za-z0-9_], `\d`=[0-9], `\b`=(?-u:\b), `\s`=WS_CLASS, `.`=줄 끝을 뺀 모임
static REQUIREMENT_ID: LazyLock<Regex> = LazyLock::new(|| re(r"(?-u:\b)R[0-9]+(?:\.[0-9]+)?(?-u:\b)".to_owned()));
static JUNIT_ANNOTATION: LazyLock<Regex> = LazyLock::new(|| {
    re(format!(
        r#"@(Test|ParameterizedTest|RepeatedTest|Nested|Disabled|DisplayName|Tag)(?-u:\b)(?:\(([{WS_CLASS}]*"(?:\\[^{LINE_TERMINATORS}]|[^"\\])*"[{WS_CLASS}]*|[^)]*)\))?"#
    ))
});
static JUNIT_CLASS: LazyLock<Regex> = LazyLock::new(|| re(format!(r"(?-u:\b)class[{WS_CLASS}]+([A-Za-z0-9_]+)")));
static JUNIT_METHOD: LazyLock<Regex> = LazyLock::new(|| re(format!(r"(?:^|[{WS_CLASS}])(?:fun|void|[A-Za-z0-9_<>\[\],.]+)[{WS_CLASS}]+([A-Za-z0-9_]+)[{WS_CLASS}]*\(")));
static JUNIT_TESTCONTAINERS: LazyLock<Regex> = LazyLock::new(|| re(r"@Testcontainers(?-u:\b)".to_owned()));
static JUNIT_CONDITIONAL: LazyLock<Regex> = LazyLock::new(|| re(r"@((?:Enabled|Disabled)[A-Za-z]+)(?-u:\b)".to_owned()));
static STRING_LITERAL: LazyLock<Regex> = LazyLock::new(|| re(format!(r#""((?:\\[^{LINE_TERMINATORS}]|[^"\\])*)""#)));
/// `JS_DESCRIBE`의 따옴표 앞까지. 1: 수식어, 2: 여는 따옴표
static JS_DESCRIBE_HEAD: LazyLock<Regex> =
    LazyLock::new(|| re(format!(r##"(?-u:\b)(?:test\.)?describe(?:\.(skip|only|todo))?(?:\.each\([^)]*\))?[{WS_CLASS}]*\([{WS_CLASS}]*(['"`])"##)));
/// `JS_TEST`의 따옴표 앞까지. 1: it|test, 2: 수식어, 3: 여는 따옴표
static JS_TEST_HEAD: LazyLock<Regex> =
    LazyLock::new(|| re(format!(r##"(?-u:\b)(it|test)(?:\.(skip|only|todo))?(?:\.each\([^)]*\))?[{WS_CLASS}]*\([{WS_CLASS}]*(['"`])"##)));
static PLAYWRIGHT_IMPORT: LazyLock<Regex> = LazyLock::new(|| re(format!(r#"from[{WS_CLASS}]+['"]@playwright/test['"]"#)));
static PLAYWRIGHT_DESCRIBE: LazyLock<Regex> = LazyLock::new(|| re(format!(r"(?-u:\b)test\.describe[{WS_CLASS}]*\(")));
static VITEST_IMPORT: LazyLock<Regex> = LazyLock::new(|| re(format!(r#"from[{WS_CLASS}]+['"]vitest['"]"#)));
static PYTEST_CLASS: LazyLock<Regex> = LazyLock::new(|| re(format!(r"^([{WS_CLASS}]*)class[{WS_CLASS}]+(Test[A-Za-z0-9_]*)(?-u:\b)")));
static PYTEST_DEF: LazyLock<Regex> = LazyLock::new(|| re(format!(r"^([{WS_CLASS}]*)(?:async[{WS_CLASS}]+)?def[{WS_CLASS}]+(test_[A-Za-z0-9_]+)[{WS_CLASS}]*\(")));
static PYTEST_SKIP_MARK: LazyLock<Regex> = LazyLock::new(|| re(r"@pytest\.mark\.(?:skip|skipif)(?-u:\b)".to_owned()));
static PYTEST_PARAMETRIZE: LazyLock<Regex> = LazyLock::new(|| re(r"@pytest\.mark\.parametrize(?-u:\b)".to_owned()));
static PYTEST_MARK: LazyLock<Regex> = LazyLock::new(|| re(r"@pytest\.mark\.([A-Za-z0-9_]+)".to_owned()));
const PYTEST_NON_ENV_MARKS: [&str; 7] = ["parametrize", "skip", "skipif", "usefixtures", "asyncio", "xfail", "filterwarnings"];
static JUNIT_FILE_PATTERN: LazyLock<Regex> = LazyLock::new(|| re(r"(Test|Tests|IT)\.(java|kt)$".to_owned()));
static JS_TEST_FILE_PATTERN: LazyLock<Regex> = LazyLock::new(|| re(r"\.(test|spec)\.[cm]?[jt]sx?$".to_owned()));
static PYTEST_FILE_PATTERN: LazyLock<Regex> = LazyLock::new(|| re(r"(^|/)(test_[A-Za-z0-9_]+\.py|[A-Za-z0-9_]+_test\.py)$".to_owned()));

// ── 결과 모양. 키 순서·선택 필드 생략은 옛 TS의 객체 리터럴과 같다
#[derive(Clone, Debug, PartialEq)]
pub struct TestCase {
    pub name: String,
    pub display_name: String,
    pub line: usize,
    pub skipped: bool,
    pub requirement_ids: Vec<String>,
    /// 없으면 키가 없다(빈 배열을 넣지 않는다)
    pub env_conditional_reasons: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct SuiteNode {
    name: String,
    display_name: String,
    line: usize,
    skipped: bool,
    children: Vec<usize>,
    tests: Vec<TestCase>,
    env_conditional_reasons: Option<Vec<String>>,
}

/// 발견 결과. 스위트 트리는 깊이에 상관없이 안전하게 읽고 쓰도록 평평한 목록(`nodes`)과 인덱스로 둔다
#[derive(Clone, Debug, PartialEq)]
pub struct DiscoveredFile {
    pub path: String,
    pub framework: String,
    roots: Vec<usize>,
    nodes: Vec<SuiteNode>,
    pub tests: Vec<TestCase>,
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).expect("문자열")
}

fn json_strings(items: &[String]) -> String {
    let parts: Vec<String> = items.iter().map(|s| json_str(s)).collect();
    format!("[{}]", parts.join(","))
}

impl TestCase {
    fn write_json(&self, out: &mut String) {
        out.push_str(&format!(
            r#"{{"name":{},"displayName":{},"line":{},"skipped":{},"requirementIds":{}"#,
            json_str(&self.name),
            json_str(&self.display_name),
            self.line,
            self.skipped,
            json_strings(&self.requirement_ids)
        ));
        if let Some(reasons) = &self.env_conditional_reasons {
            out.push_str(&format!(r#","envConditionalReasons":{}"#, json_strings(reasons)));
        }
        out.push('}');
    }
}

fn tests_json(tests: &[TestCase]) -> String {
    let mut out = String::from("[");
    for (i, test) in tests.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        test.write_json(&mut out);
    }
    out.push(']');
    out
}

enum Work {
    Text(String),
    Suite(usize),
}

impl DiscoveredFile {
    fn new(path: &str, framework: &str) -> Self {
        Self { path: path.to_owned(), framework: framework.to_owned(), roots: Vec::new(), nodes: Vec::new(), tests: Vec::new() }
    }

    /// 스위트를 만들어 `parent`(없으면 최상위) 아래 단다
    fn add_suite(&mut self, parent: Option<usize>, node: SuiteNode) -> usize {
        let index = self.nodes.len();
        self.nodes.push(node);
        match parent {
            Some(p) => self.nodes[p].children.push(index),
            None => self.roots.push(index),
        }
        index
    }

    /// 옛 TS의 `JSON.stringify` 결과와 같은 글자(키 순서 포함). 재귀 없이 쓴다 — 깊게 중첩한 입력이 호출 스택을 넘기지 않는다
    pub fn to_json(&self) -> String {
        let mut out = format!(r#"{{"path":{},"framework":{},"suites":["#, json_str(&self.path), json_str(&self.framework));
        let mut stack: Vec<Work> = Vec::new();
        stack.push(Work::Text(format!(r#"],"tests":{}}}"#, tests_json(&self.tests))));
        for (j, &root) in self.roots.iter().enumerate().rev() {
            stack.push(Work::Suite(root));
            if j > 0 {
                stack.push(Work::Text(",".to_owned()));
            }
        }
        while let Some(work) = stack.pop() {
            match work {
                Work::Text(text) => out.push_str(&text),
                Work::Suite(index) => {
                    let node = &self.nodes[index];
                    out.push_str(&format!(
                        r#"{{"name":{},"displayName":{},"line":{},"skipped":{},"suites":["#,
                        json_str(&node.name),
                        json_str(&node.display_name),
                        node.line,
                        node.skipped
                    ));
                    let mut trailer = format!(r#"],"tests":{}"#, tests_json(&node.tests));
                    if let Some(reasons) = &node.env_conditional_reasons {
                        trailer.push_str(&format!(r#","envConditionalReasons":{}"#, json_strings(reasons)));
                    }
                    trailer.push('}');
                    stack.push(Work::Text(trailer));
                    for (j, &child) in node.children.iter().enumerate().rev() {
                        stack.push(Work::Suite(child));
                        if j > 0 {
                            stack.push(Work::Text(",".to_owned()));
                        }
                    }
                }
            }
        }
        out
    }

    /// 최상위 스위트의 개수(시험용)
    pub fn root_count(&self) -> usize {
        self.roots.len()
    }
}

// ── 요구사항 id
/// `matchAll(/\bR\d+(?:\.\d+)?\b/g)`의 맞음을 처음 나온 순서로, 중복 없이
pub fn extract_requirement_ids(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for m in REQUIREMENT_ID.find_iter(text) {
        if seen.insert(m.as_str()) {
            found.push(m.as_str().to_owned());
        }
    }
    found
}

/// 테스트 자신의 제목 id가 앞, 묶음 id가 바깥에서 안쪽 순서로 뒤따른다. 같은 id는 한 번만
pub fn extract_requirement_ids_with_suites(suite_path: &[String], title: &str) -> Vec<String> {
    let mut out = extract_requirement_ids(title);
    for suite in suite_path {
        out.extend(extract_requirement_ids(suite));
    }
    dedupe(out)
}

fn dedupe(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|s| seen.insert(s.clone())).collect()
}

/// `line.match(/\{/g).length - line.match(/\}/g).length`
fn count_brace_delta(line: &str) -> i64 {
    line.bytes().map(|b| i64::from(b == b'{') - i64::from(b == b'}')).sum()
}

/// `split(/\r?\n/)`
fn split_lines(content: &str) -> Vec<&str> {
    content.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

// ── JUnit
/// `@DisplayName(`·`@Tag(` 뒤 인자를 닫는 괄호까지 읽는다. 문자열 안의 괄호는 세지 않는다. `(텍스트, 끝 줄)`.
/// `open_index`는 `lines[start_line]` 안의 바이트 위치다
fn read_annotation_argument(lines: &[&str], start_line: usize, open_index: usize) -> Option<(String, usize)> {
    let mut depth: i64 = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut text = String::new();
    let last_line = (lines.len() - 1).min(start_line + ANNOTATION_ARGUMENT_MAX_LINES);
    for line_index in start_line..=last_line {
        let line = lines[line_index];
        let from = if line_index == start_line { open_index } else { 0 };
        for ch in line[from..].chars() {
            if in_string {
                text.push(ch);
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    in_string = false;
                }
                continue;
            }
            if ch == '"' {
                in_string = true;
                text.push(ch);
            } else if ch == '(' {
                if depth > 0 {
                    text.push(ch);
                }
                depth += 1;
            } else if ch == ')' {
                depth -= 1;
                if depth == 0 {
                    return Some((text, line_index));
                }
                text.push(ch);
            } else if depth > 0 {
                text.push(ch);
            }
        }
        text.push('\n');
    }
    None
}

/// 인자 안의 문자열 조각을 모두 이어 붙인다. 조각이 없으면 None
fn join_string_literals(argument: &str) -> Option<String> {
    let parts: Vec<&str> = STRING_LITERAL.captures_iter(argument).map(|c| c.get(1).map_or("", |m| m.as_str())).collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.concat())
    }
}

struct Frame {
    suite: usize,
    close_at_depth: i64,
}

fn pop_closed(stack: &mut Vec<Frame>, depth: i64) {
    while stack.last().is_some_and(|f| depth < f.close_at_depth) {
        stack.pop();
    }
}

fn unique_or_none(reasons: &[String]) -> Option<Vec<String>> {
    if reasons.is_empty() {
        None
    } else {
        Some(dedupe(reasons.to_vec()))
    }
}

/// JUnit 4/5 테스트 파일(Java·Kotlin)에서 클래스(@Nested 포함)·테스트 메서드를 찾는다
pub fn discover_junit_file(file_path: &str, content: &str) -> DiscoveredFile {
    let lines = split_lines(content);
    let mut file = DiscoveredFile::new(file_path, "junit");
    let mut stack: Vec<Frame> = Vec::new();
    let mut depth: i64 = 0;
    let mut pending_display_name: Option<String> = None;
    let mut pending_disabled = false;
    let mut pending_is_test = false;
    let mut pending_env: Vec<String> = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let line_no = i + 1;

        let mut argument_end_line: Option<usize> = None;
        for caps in JUNIT_ANNOTATION.captures_iter(line) {
            let whole = caps.get(0).expect("전체");
            let name = &caps[1];
            match name {
                "Test" | "ParameterizedTest" | "RepeatedTest" => pending_is_test = true,
                "Disabled" => pending_disabled = true,
                "DisplayName" | "Tag" => {
                    // `match[0].indexOf(name)`은 `@` 바로 뒤라서 맞음 시작 + 1이다. 괄호는 그 뒤 줄 안의 첫 `(`다(맞음 안에 없을 수도 있다)
                    let from = whole.start() + 1;
                    let open_index = line[from..].find('(').map(|at| from + at);
                    let argument = open_index.and_then(|open| read_annotation_argument(&lines, i, open));
                    let text = argument.as_ref().and_then(|(text, _)| join_string_literals(text));
                    if name == "DisplayName" {
                        if let Some(text) = text {
                            pending_display_name = Some(text);
                        }
                        if let Some((_, end)) = &argument {
                            if *end > i {
                                argument_end_line = Some(*end);
                            }
                        }
                    } else {
                        if let Some(text) = text {
                            pending_env.push(format!("@Tag(\"{text}\")"));
                        }
                        if let Some((_, end)) = &argument {
                            if *end > i && argument_end_line.is_none_or(|current| *end > current) {
                                argument_end_line = Some(*end);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if JUNIT_TESTCONTAINERS.is_match(line) {
            pending_env.push("@Testcontainers".to_owned());
        }
        for caps in JUNIT_CONDITIONAL.captures_iter(line) {
            pending_env.push(format!("@{}", &caps[1]));
        }
        if let Some(end) = argument_end_line {
            i = end + 1;
            continue;
        }

        let class_match = JUNIT_CLASS.captures(line);
        let method_match = if class_match.is_none() && pending_is_test { JUNIT_METHOD.captures(line) } else { None };

        if let Some(caps) = class_match {
            let name = caps[1].to_owned();
            let env = unique_or_none(&pending_env);
            let parent = stack.last().map(|f| f.suite);
            let suite = file.add_suite(
                parent,
                SuiteNode {
                    display_name: pending_display_name.clone().unwrap_or_else(|| name.clone()),
                    name,
                    line: line_no,
                    skipped: pending_disabled,
                    env_conditional_reasons: env,
                    ..SuiteNode::default()
                },
            );
            depth += count_brace_delta(line);
            stack.push(Frame { suite, close_at_depth: depth });
            pending_display_name = None;
            pending_disabled = false;
            pending_is_test = false;
            pending_env.clear();
            i += 1;
            continue;
        }

        if let Some(caps) = method_match {
            let name = caps[1].to_owned();
            let display_name = pending_display_name.clone().unwrap_or_else(|| name.clone());
            let env = unique_or_none(&pending_env);
            let test = TestCase {
                requirement_ids: extract_requirement_ids(&format!("{display_name} {name}")),
                name,
                display_name,
                line: line_no,
                skipped: pending_disabled,
                env_conditional_reasons: env,
            };
            if let Some(parent) = stack.last() {
                file.nodes[parent.suite].tests.push(test);
            }
            pending_display_name = None;
            pending_env.clear();
            pending_disabled = false;
            pending_is_test = false;
            depth += count_brace_delta(line);
            pop_closed(&mut stack, depth);
            i += 1;
            continue;
        }

        depth += count_brace_delta(line);
        pop_closed(&mut stack, depth);
        i += 1;
    }
    file
}

// ── Vitest / Jest / Playwright
/// 여는 따옴표(`begin` 바로 앞) 다음부터 닫는 따옴표의 위치. `((?:\\.|(?!q)[\s\S])*?)q`와 같다.
/// 앞에서부터 한 걸음씩: 따옴표를 만나면 끝(비탐욕). 백슬래시 다음 글자가 줄 끝 글자가 아니고 그 뒤에 따옴표가 아직 남아 있으면
/// 두 글자를 건너뛴다(`\\.`). 남아 있지 않으면 되돌아가 백슬래시 하나만 먹는다 — 정규식의 선택 순서와 같다.
/// `last_quote`는 뒤에 따옴표가 있는지 알려 주어 되돌아감을 선형으로 만든다
fn quoted_end(line: &str, begin: usize, quote: u8) -> Option<usize> {
    let bytes = line.as_bytes();
    let last_quote = begin + bytes[begin..].iter().rposition(|&b| b == quote)?;
    let mut p = begin;
    while p < bytes.len() {
        if bytes[p] == quote {
            return Some(p);
        }
        if bytes[p] == b'\\' {
            if let Some(next) = line[p + 1..].chars().next() {
                let after = p + 1 + next.len_utf8();
                if !is_js_line_terminator(next) && last_quote >= after {
                    p = after;
                    continue;
                }
            }
        }
        // 바이트 단위로 가도 안전하다: 다중 바이트 글자의 이어지는 바이트는 따옴표도 백슬래시도 아니다
        p += 1;
    }
    None
}

/// `head`로 줄의 첫 맞음을 찾는다. 앞부분이 맞아도 따옴표 문자열이 안 맞으면 다음 시작 위치에서 다시 찾는다.
/// `quote_group`은 여는 따옴표의 캡처 번호. 돌려주는 값: `(앞부분 캡처, 제목 원문)`
fn find_quoted<'a>(head: &Regex, line: &'a str, quote_group: usize) -> Option<(Captures<'a>, &'a str)> {
    let mut at = 0;
    while at <= line.len() {
        let caps = head.captures_at(line, at)?;
        let whole = caps.get(0).expect("전체");
        let quote = caps.get(quote_group).expect("따옴표");
        if let Some(end) = quoted_end(line, quote.end(), quote.as_str().as_bytes()[0]) {
            return Some((caps, &line[quote.end()..end]));
        }
        let next = line[whole.start()..].chars().next().map_or(1, char::len_utf8);
        at = whole.start() + next;
    }
    None
}

/// `raw.replace(/\\(.)/g, '$1')`. `.`은 줄 끝 글자를 뺀다(백슬래시+개행은 그대로)
fn unescape_js_string(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if !is_js_line_terminator(next) {
                    out.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// 파일 내용에서 프레임워크를 짐작한다
pub fn detect_js_framework(content: &str) -> &'static str {
    if PLAYWRIGHT_IMPORT.is_match(content) || PLAYWRIGHT_DESCRIBE.is_match(content) {
        "playwright"
    } else if VITEST_IMPORT.is_match(content) {
        "vitest"
    } else {
        "jest"
    }
}

/// Vitest/Jest/Playwright 테스트 파일에서 describe·it/test를 찾는다. `framework`가 없으면 내용으로 짐작한다
pub fn discover_js_file(file_path: &str, content: &str, framework: Option<&str>) -> DiscoveredFile {
    let framework = framework.unwrap_or_else(|| detect_js_framework(content));
    let lines = split_lines(content);
    let mut file = DiscoveredFile::new(file_path, framework);
    let mut stack: Vec<Frame> = Vec::new();
    let mut depth: i64 = 0;

    for (i, line) in lines.iter().enumerate() {
        let line_no = i + 1;
        if let Some((caps, raw)) = find_quoted(&JS_DESCRIBE_HEAD, line, 2) {
            let modifier = caps.get(1).map(|m| m.as_str());
            let title = unescape_js_string(raw);
            let parent = stack.last().map(|f| f.suite);
            let suite = file.add_suite(
                parent,
                SuiteNode {
                    name: title.clone(),
                    display_name: title,
                    line: line_no,
                    skipped: matches!(modifier, Some("skip" | "todo")),
                    ..SuiteNode::default()
                },
            );
            depth += count_brace_delta(line);
            stack.push(Frame { suite, close_at_depth: depth });
            continue;
        }
        if let Some((caps, raw)) = find_quoted(&JS_TEST_HEAD, line, 3) {
            let modifier = caps.get(2).map(|m| m.as_str());
            let title = unescape_js_string(raw);
            let test = TestCase {
                requirement_ids: extract_requirement_ids(&title),
                name: title.clone(),
                display_name: title,
                line: line_no,
                skipped: matches!(modifier, Some("skip" | "todo")),
                env_conditional_reasons: None,
            };
            match stack.last() {
                Some(frame) => file.nodes[frame.suite].tests.push(test),
                None => file.tests.push(test),
            }
            depth += count_brace_delta(line);
            pop_closed(&mut stack, depth);
            continue;
        }
        depth += count_brace_delta(line);
        pop_closed(&mut stack, depth);
    }
    file
}

// ── pytest
/// pytest 테스트 파일에서 class Test*와 def test_*를 찾는다. 들여쓰기로 중첩을 판단한다
pub fn discover_pytest_file(file_path: &str, content: &str) -> DiscoveredFile {
    let lines = split_lines(content);
    let mut file = DiscoveredFile::new(file_path, "pytest");
    // 들여쓰기 길이는 `\s`(모두 BMP) 개수다
    let mut stack: Vec<(usize, usize)> = Vec::new(); // (스위트, 들여쓰기)
    let mut pending_skip = false;
    let mut pending_parametrized = false;
    let mut pending_env: Vec<String> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        let line_no = i + 1;
        if PYTEST_SKIP_MARK.is_match(line) {
            pending_skip = true;
        }
        if PYTEST_PARAMETRIZE.is_match(line) {
            pending_parametrized = true;
        }
        for caps in PYTEST_MARK.captures_iter(line) {
            let mark = &caps[1];
            if !PYTEST_NON_ENV_MARKS.contains(&mark) {
                pending_env.push(format!("@pytest.mark.{mark}"));
            }
        }

        let class_match = PYTEST_CLASS.captures(line);
        let def_match = if class_match.is_none() { PYTEST_DEF.captures(line) } else { None };

        if let Some(caps) = class_match {
            let indent = caps[1].chars().count();
            while stack.last().is_some_and(|&(_, top)| top >= indent) {
                stack.pop();
            }
            let name = caps[2].to_owned();
            let parent = stack.last().map(|&(suite, _)| suite);
            let suite = file.add_suite(
                parent,
                SuiteNode {
                    display_name: name.clone(),
                    name,
                    line: line_no,
                    skipped: pending_skip,
                    env_conditional_reasons: unique_or_none(&pending_env),
                    ..SuiteNode::default()
                },
            );
            stack.push((suite, indent));
            pending_skip = false;
            pending_parametrized = false;
            pending_env.clear();
            continue;
        }

        if let Some(caps) = def_match {
            let indent = caps[1].chars().count();
            while stack.last().is_some_and(|&(_, top)| top >= indent) {
                stack.pop();
            }
            let name = caps[2].to_owned();
            let display_name = if pending_parametrized { format!("{name} (매개변수화됨)") } else { name.clone() };
            let test = TestCase {
                requirement_ids: extract_requirement_ids(&name),
                name,
                display_name,
                line: line_no,
                skipped: pending_skip,
                env_conditional_reasons: unique_or_none(&pending_env),
            };
            match stack.last() {
                Some(&(suite, _)) => file.nodes[suite].tests.push(test),
                None => file.tests.push(test),
            }
            pending_skip = false;
            pending_parametrized = false;
            pending_env.clear();
            continue;
        }

        let trimmed = js::trim(line);
        if !trimmed.is_empty() && !trimmed.starts_with('#') && !trimmed.starts_with('@') {
            pending_skip = false;
            pending_parametrized = false;
            pending_env.clear();
        }
    }
    file
}

// ── 파일 선택·디스패치
pub fn is_test_file_path(file_path: &str) -> bool {
    JUNIT_FILE_PATTERN.is_match(file_path) || JS_TEST_FILE_PATTERN.is_match(file_path) || PYTEST_FILE_PATTERN.is_match(file_path)
}

/// 경로·내용을 보고 알맞은 파서로 테스트를 찾는다. 테스트 파일로 보이지 않으면 None
pub fn discover_tests_in_file(file_path: &str, content: &str) -> Option<DiscoveredFile> {
    if JUNIT_FILE_PATTERN.is_match(file_path) {
        Some(discover_junit_file(file_path, content))
    } else if JS_TEST_FILE_PATTERN.is_match(file_path) {
        Some(discover_js_file(file_path, content, None))
    } else if PYTEST_FILE_PATTERN.is_match(file_path) {
        Some(discover_pytest_file(file_path, content))
    } else {
        None
    }
}

// ── 평탄화
fn string_array(value: &Value, what: &str) -> Result<Vec<String>, String> {
    let items = value.as_array().ok_or_else(|| format!("{what}이(가) 배열이 아닙니다"))?;
    items.iter().map(|v| v.as_str().map(str::to_owned).ok_or_else(|| format!("{what}에 문자열이 아닌 값이 있습니다"))).collect()
}

/// 선택 필드: 없거나 null이면 None(JS의 `?? undefined`·`group ?? []`)
fn optional_string_array(map: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>, String> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => string_array(value, key).map(Some),
    }
}

fn to_value_array(items: &[String]) -> Value {
    Value::Array(items.iter().map(|s| Value::String(s.clone())).collect())
}

/// 부모 스위트의 표시와 테스트 자신의 표시를 합친다(순서·중복 없이). 둘 다 없으면 None
fn merge_env(groups: &[Option<&Vec<String>>]) -> Option<Vec<String>> {
    let merged = dedupe(groups.iter().flat_map(|g| g.iter().flat_map(|v| v.iter().cloned())).collect());
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value.as_object().ok_or_else(|| format!("{what}이(가) 객체가 아닙니다"))
}

fn array<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, String> {
    map.get(key).and_then(Value::as_array).ok_or_else(|| format!("{key}이(가) 배열이 아닙니다"))
}

fn walk_suite(
    suite: &Value,
    path: &[String],
    ancestor_skipped: bool,
    ancestor_env: Option<&Vec<String>>,
    file_path: &Value,
    rows: &mut Vec<Value>,
) -> Result<(), String> {
    let suite = object(suite, "스위트")?;
    let own_skipped = suite.get("skipped").and_then(Value::as_bool).ok_or("스위트의 skipped가 불리언이 아닙니다")?;
    let suite_skipped = ancestor_skipped || own_skipped;
    let own_env = optional_string_array(suite, "envConditionalReasons")?;
    let suite_env = merge_env(&[ancestor_env, own_env.as_ref()]);
    let display_name = suite.get("displayName").and_then(Value::as_str).ok_or("스위트의 displayName이 문자열이 아닙니다")?;
    let mut next_path = path.to_vec();
    next_path.push(display_name.to_owned());
    for test in array(suite, "tests")? {
        let test = object(test, "테스트")?;
        let own = optional_string_array(test, "envConditionalReasons")?;
        let env = merge_env(&[suite_env.as_ref(), own.as_ref()]);
        let ids = string_array(test.get("requirementIds").unwrap_or(&Value::Null), "requirementIds")?;
        let mut merged_ids = ids;
        merged_ids.extend(extract_requirement_ids_with_suites(&next_path, ""));
        let merged_ids = dedupe(merged_ids);
        // 객체 펼침과 같다: 이미 있는 키는 제자리에서 값만 바뀌고 새 키는 뒤에 붙는다
        let mut row = test.clone();
        row.insert("requirementIds".to_owned(), to_value_array(&merged_ids));
        row.insert("file".to_owned(), file_path.clone());
        row.insert("suitePath".to_owned(), to_value_array(&next_path));
        row.insert("suiteSkipped".to_owned(), Value::Bool(suite_skipped));
        if let Some(env) = env {
            row.insert("envConditionalReasons".to_owned(), to_value_array(&env));
        }
        rows.push(Value::Object(row));
    }
    for child in array(suite, "suites")? {
        walk_suite(child, &next_path, suite_skipped, suite_env.as_ref(), file_path, rows)?;
    }
    Ok(())
}

/// `DiscoveredFile`의 JSON을 읽어 평평한 목록(JSON)으로 편다. 테스트 객체의 다른 필드는 그대로 따라간다.
/// 모양이 어긋난 입력은 오류다. serde_json의 재귀 한도(128단계)를 넘는 중첩(스위트 약 60단계)도 오류다
pub fn flatten_discovered_file(json: &str) -> Result<String, String> {
    let root: Value = serde_json::from_str(json).map_err(|e| format!("발견 결과를 읽지 못했습니다: {e}"))?;
    let file = object(&root, "발견 결과")?;
    let file_path = file.get("path").filter(|v| v.is_string()).ok_or("path가 문자열이 아닙니다")?;
    let mut rows: Vec<Value> = Vec::new();
    for test in array(file, "tests")? {
        let mut row = object(test, "테스트")?.clone();
        row.insert("file".to_owned(), file_path.clone());
        row.insert("suitePath".to_owned(), Value::Array(Vec::new()));
        row.insert("suiteSkipped".to_owned(), Value::Bool(false));
        rows.push(Value::Object(row));
    }
    for suite in array(file, "suites")? {
        walk_suite(suite, &[], false, None, file_path, &mut rows)?;
    }
    Ok(Value::Array(rows).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 따옴표는_되돌아가며_맞춘다() {
        // test('a\') : \\. 로 `\'`를 건너뛰면 닫는 따옴표가 없어 백슬래시 하나만 먹는다
        let file = discover_js_file("a.test.ts", "test('a\\')", None);
        assert!(file.to_json().contains(r#""name":"a\\""#), "{}", file.to_json());
        // 닫는 따옴표가 뒤에 더 있으면 이스케이프를 건너뛴다
        let file = discover_js_file("a.test.ts", "test('a\\'b')", None);
        assert!(file.to_json().contains(r#""name":"a'b""#), "{}", file.to_json());
    }

    #[test]
    fn 줄_끝_글자_앞의_백슬래시는_건너뛰지_않는다() {
        assert_eq!(unescape_js_string("a\\\u{2028}b\\n"), "a\\\u{2028}bn");
    }

    #[test]
    fn 평탄화는_제자리에서_키를_덮는다() {
        let file = discover_junit_file("AT.java", "@Tag(\"x\")\nclass A {\n @Test void t() {}\n}\n");
        let flat = flatten_discovered_file(&file.to_json()).unwrap();
        assert!(flat.starts_with(r#"[{"name":"t","displayName":"t","line":3,"skipped":false,"requirementIds":[],"file":"AT.java","suitePath":["A"],"suiteSkipped":false,"envConditionalReasons":["@Tag(\"x\")"]}"#), "{flat}");
    }

    #[test]
    fn 깊은_중첩도_쓸_수_있다() {
        let content = "class A {\n".repeat(50_000);
        let file = discover_junit_file("AT.java", &content);
        assert!(file.to_json().len() > 1000);
        assert!(flatten_discovered_file(&file.to_json()).is_err());
    }
}
