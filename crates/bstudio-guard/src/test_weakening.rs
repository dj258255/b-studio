//! 시험을 약하게 만드는 변경 판정(이슈 #1436): 이번 변경에서 **지워진 시험 파일**과, 시험 파일에 **새로 더해진 건너뛰기 표시**를 찾는다.
//! 평가 자산(`workflow.evaluationAssets`)은 지문으로 지키지만, 선언하지 않은 일반 시험 파일은 따로 지키지 않았다. 턴 끝 게이트의 리뷰 단계가 이 판정을 부른다.
//!
//! 막는 검사(거부 목록)다. 넓게 맞춰도 더 막을 뿐이므로 오탐 쪽으로 기울여 있다.
//! - 시험 파일 모양(`is_reviewed_test_path`)은 `test_discovery::is_test_file_path`에 더해 `_test.go`, 소문자로 접은 `.test.ts` 꼴, `test`·`tests`·`__tests__`·`spec` 폴더 아래의 코드 파일까지 본다.
//! - 건너뛰기 표시는 **더해진 줄**에서만 센다(원래 있던 표시는 세지 않는다). 주석이나 문자열 안의 표시도 걸린다(오탐).
//! - 이름 바꾸기는 git이 알려 준 것(`R`)만 믿는다. 옮긴 대상도 시험 파일이면 지운 것으로 세지 않고, 시험 파일이 아닌 이름으로 옮겼으면(`a.test.ts` → `a.ts.bak`) 지운 것으로 센다.
//!   이름끼리 같음을 견주는 곳은 없다(옮긴 짝은 git이 내용으로 찾는다). 그래서 대소문자·유니코드 정규화가 다른 볼륨에서도 비켜 갈 길이 생기지 않는다.
//! - 끝까지 읽지 못했거나(`incomplete`) 줄을 받지 못한 변경은 통과가 아니라 "확인하지 못함"이다.
//! - 사람이 이번 요청에 확인 변경을 허용했으면(`allowed`) 통과로 바뀐다(성공한 검사로 무엇을 받아들였는지만 남긴다).
//!
//! 잡지 못하는 것: 아래 표시 말고 다른 언어·다른 꼴(Ruby·PHP·C#·Swift의 건너뛰기, 줄을 나눠 쓴 `it\n.skip(`, 대괄호 접근 `it['skip']`),
//! 단언을 비우거나 약하게 바꾸는 것(이슈의 "하지 않는 것"), 시험이 아닌 이름으로 둔 시험.

use crate::js_json::{self, JsValue};
use crate::test_discovery;
use crate::workflow::Check;
use regex::Regex;
use std::sync::LazyLock;

pub const CHECK_NAME: &str = "test-weakening";

/// 분류 한 줄. `status`는 git `--name-status`의 첫 글자(`A M D R C T U X B`)
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub status: char,
    pub path: String,
    pub from: Option<String>,
    /// 이번 변경에서 더해진 줄. 줄을 받지 못했으면 `None`
    pub added: Option<Vec<String>>,
}

/// 줄 내용을 읽어야 하는 코드 파일 확장자(폴더 이름으로 시험 파일을 알아볼 때도 이 확장자만 본다)
const CODE_EXTENSIONS: [&str; 14] = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "py", "java", "kt", "kts", "go", "rs"];
const TEST_DIRECTORIES: [&str; 5] = ["test", "tests", "__tests__", "spec", "specs"];

static JS_TEST_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(test|spec)\.[cm]?[jt]sx?$").expect("정규식"));
static JS_TEST_NAME_EXACT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.(test|spec)\.[cm]?[jt]sx?$").expect("정규식"));
static PY_TEST_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|/)(test_[^/]+|[^/]+_test)\.py$").expect("정규식"));

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn extension(path: &str) -> String {
    let name = file_name(path).to_lowercase();
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_owned(),
        _ => String::new(),
    }
}

/// 시험 파일로 보는 경로(거부 목록 쪽 맞춤: 넓게 맞는다). 구분자는 `/`와 `\` 모두 본다
pub fn is_reviewed_test_path(path: &str) -> bool {
    if test_discovery::is_test_file_path(path) {
        return true;
    }
    let lower = path.to_lowercase().replace('\\', "/");
    if JS_TEST_NAME.is_match(&lower) || PY_TEST_NAME.is_match(&lower) || lower.ends_with("_test.go") {
        return true;
    }
    let ext = extension(&lower);
    if !CODE_EXTENSIONS.contains(&ext.as_str()) {
        return false;
    }
    let segments: Vec<&str> = lower.split('/').collect();
    segments[..segments.len() - 1].iter().any(|segment| TEST_DIRECTORIES.contains(segment))
}

/// 시험 실행기가 **이름으로** 시험 파일로 집어 드는 경로(좁게 맞춘다): 옮긴 곳이 아직 시험인지 보는 데 쓴다.
/// 이름 바꾸기의 도착지 확인은 막는 검사를 **여는** 쪽이다(여기서 시험이면 지운 것으로 세지 않는다). 그래서 넓은 `is_reviewed_test_path`를 쓰지 않는다:
/// `tests/helper.ts`나 `A.TEST.TS`로 옮기면 실행기가 더는 돌리지 않는데도 시험 파일로 읽혀 통과하게 된다. 대소문자도 접지 않는다(실행기의 이름 규칙은 대소문자를 구분한다)
pub fn is_runner_test_path(path: &str) -> bool {
    if test_discovery::is_test_file_path(path) || JS_TEST_NAME_EXACT.is_match(path) || path.ends_with("_test.go") {
        return true;
    }
    // cargo는 `tests/` 바로 아래의 `.rs`를 통합 시험으로 집는다
    path.ends_with(".rs") && path.split('/').rev().skip(1).any(|segment| segment == "tests")
}

/// 더해진 줄을 읽어야 하는 경로: 시험 파일, 그리고 시험이 같은 파일 안에 있는 Rust 파일(`#[ignore]`)
pub fn needs_added_lines(path: &str) -> bool {
    is_reviewed_test_path(path) || extension(path) == "rs"
}

// ── 건너뛰기 표시 ────────────────────────────────────────────────────

struct Marker {
    label: &'static str,
    pattern: Regex,
}

fn markers(list: &[(&'static str, &str)]) -> Vec<Marker> {
    list.iter().map(|(label, pattern)| Marker { label, pattern: Regex::new(pattern).expect("정규식") }).collect()
}

static JS_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[
        ("it.skip/test.skip/describe.skip(·todo·fixme·skipIf)", r"(?-u:\b)(?:it|test|describe|context|suite|specify|bench)[ \t]*\.[ \t]*(?:skip|todo|fixme)"),
        ("xit(·xtest(·xdescribe(", r"(?-u:\b)(?:xit|xtest|xdescribe|xcontext|xspecify)[ \t]*\("),
        ("this.skip(", r"(?-u:\b)this\.skip[ \t]*\("),
        ("skip: 옵션", r"(?-u:\b)(?:skip|todo)[ \t]*:[ \t]*(?:true|'|\x22|`)"),
    ])
});
static PY_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[
        ("pytest.mark.skip·skipif·xfail", r"(?-u:\b)pytest\.mark\.(?:skip|skipif|xfail)"),
        ("pytest.skip(·xfail(·importorskip(", r"(?-u:\b)pytest\.(?:skip|xfail|importorskip)[ \t]*\("),
        ("unittest.skip", r"(?-u:\b)unittest\.(?:skip|skipIf|skipUnless|expectedFailure)"),
        ("@skip", r"^[ \t]*@(?:skip|skipIf|skipUnless)(?-u:\b)"),
        ("self.skipTest(", r"(?-u:\b)self\.skipTest[ \t]*\("),
    ])
});
static JVM_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[
        ("@Disabled", r"@Disabled[A-Za-z0-9_]*"),
        ("@Ignore", r"@Ignore(?-u:\b)"),
        ("enabled = false", r"(?-u:\b)enabled[ \t]*=[ \t]*false(?-u:\b)"),
    ])
});
static RS_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[("#[ignore]", r"#\[[ \t]*ignore(?-u:\b)"), ("#[cfg_attr(…, ignore)]", r"cfg_attr[ \t]*\([^\]]*(?-u:\b)ignore(?-u:\b)")])
});
static GO_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| markers(&[("t.Skip(", r"\.Skip(?:f|Now)?[ \t]*\(")]));

fn marker_set(path: &str) -> Option<&'static [Marker]> {
    match extension(path).as_str() {
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" => Some(&JS_MARKERS),
        "py" => Some(&PY_MARKERS),
        "java" | "kt" | "kts" => Some(&JVM_MARKERS),
        "rs" => Some(&RS_MARKERS),
        "go" => Some(&GO_MARKERS),
        _ => None,
    }
}

/// 더해진 줄에서 찾은 건너뛰기 표시(중복 없이, 찾은 순서). 줄은 한 줄씩 본다
pub fn skip_markers_in(path: &str, added: &[String]) -> Vec<&'static str> {
    let Some(set) = marker_set(path) else { return Vec::new() };
    let mut found: Vec<&'static str> = Vec::new();
    for line in added {
        for marker in set {
            if !found.contains(&marker.label) && marker.pattern.is_match(line) {
                found.push(marker.label);
            }
        }
    }
    found
}

// ── git 출력 읽기 ─────────────────────────────────────────────────────

/// `git diff --name-status -z -M`의 출력. 이름 바꾸기·복사(`R`·`C`)는 상태 뒤에 경로 둘, 나머지는 하나다.
/// 어긋난 출력은 통과로 읽지 않고 던진다(모르면 통과가 아니다)
pub fn parse_name_status(output: &str) -> Result<Vec<Change>, String> {
    let mut tokens = output.split('\0').collect::<Vec<_>>();
    if tokens.last() == Some(&"") {
        tokens.pop();
    }
    let mut changes = Vec::new();
    let mut iter = tokens.into_iter();
    while let Some(status) = iter.next() {
        let letter = status.chars().next().ok_or_else(|| "변경 목록의 상태가 비어 있습니다".to_owned())?;
        if !letter.is_ascii_uppercase() {
            return Err(format!("변경 목록의 상태를 읽지 못했습니다: {status}"));
        }
        let first = iter.next().ok_or_else(|| "변경 목록이 경로 없이 끝났습니다".to_owned())?;
        if letter == 'R' || letter == 'C' {
            let second = iter.next().ok_or_else(|| "변경 목록이 이름 바꾸기의 새 경로 없이 끝났습니다".to_owned())?;
            changes.push(Change { status: letter, path: second.to_owned(), from: Some(first.to_owned()), added: None });
        } else {
            changes.push(Change { status: letter, path: first.to_owned(), from: None, added: None });
        }
    }
    Ok(changes)
}

/// `git diff -U0`의 출력을 파일별로 나눠 더해진 줄을 돌려준다. 파일 머리는 줄 맨 앞의 `diff --git `이다
/// (내용 줄은 항상 ` `·`+`·`-`·`\`로 시작하므로 맨 앞의 이 글자 모양은 머리뿐이다). 첫 `@@` 앞은 머리라서 `+++ `를 줄로 세지 않는다.
/// 파일 수가 기대와 다르면 던진다(어느 파일의 줄인지 모르면 통과가 아니다)
pub fn added_lines_by_file(patch: &str, expected: usize) -> Result<Vec<Vec<String>>, String> {
    let mut files: Vec<Vec<String>> = Vec::new();
    let mut in_hunk = false;
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            files.push(Vec::new());
            in_hunk = false;
            continue;
        }
        let Some(current) = files.last_mut() else { continue };
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if in_hunk {
            if let Some(content) = line.strip_prefix('+') {
                current.push(content.trim_end_matches('\r').to_owned());
            }
        }
    }
    if files.len() != expected {
        return Err(format!("바뀐 파일 {expected}개를 기대했지만 변경 내용에서 {}개를 읽었습니다", files.len()));
    }
    Ok(files)
}

// ── 판정 ──────────────────────────────────────────────────────────────

/// 모델에게 돌아가는 글에 쓰는 이름. 줄 바꿈·제어 문자는 물음표로 바꾼다
fn shown(path: &str) -> String {
    path.chars().map(|c| if c.is_control() { '?' } else { c }).collect()
}

const LISTED: usize = 8;

fn listed(items: &[String]) -> String {
    if items.len() <= LISTED {
        items.join(", ")
    } else {
        format!("{} 외 {}개", items[..LISTED].join(", "), items.len() - LISTED)
    }
}

/// 이번 변경에서 시험을 약하게 만든 것이 있는지 본다. 없으면 `None`. 허용이 있으면 받아들인 내용을 성공한 검사로 남긴다
pub fn review_test_changes(changes: &[Change], allowed: bool, incomplete: Option<&str>) -> Option<Check> {
    if let Some(reason) = incomplete {
        if allowed {
            return None;
        }
        return Some(Check {
            name: CHECK_NAME.to_owned(),
            ok: false,
            detail: Some(format!(
                "시험 파일이 지워졌거나 건너뛰기 표시가 더해졌는지 끝까지 확인하지 못했습니다({}). 확인하지 못한 변경은 통과로 보지 않습니다. 다시 턴을 끝내 보세요.",
                shown(reason)
            )),
        });
    }
    let mut deleted: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();
    for change in changes {
        let from_reviewed = change.from.as_deref().is_some_and(is_reviewed_test_path);
        match change.status {
            'D' => {
                if is_reviewed_test_path(&change.path) {
                    deleted.push(shown(&change.path));
                }
            }
            // 일반 파일이던 시험이 링크 등으로 바뀌었다: 시험으로 돌아가는 파일이 아니다
            'T' => {
                if is_reviewed_test_path(&change.path) {
                    deleted.push(format!("{} (파일 종류가 바뀜)", shown(&change.path)));
                }
            }
            'A' | 'M' | 'C' | 'R' => {
                // 옮긴 곳이 실행기가 집는 시험 파일이 아니면 지운 것이다(도착지는 좁은 판정, 출발지는 넓은 판정)
                if change.status == 'R' && from_reviewed && !is_runner_test_path(&change.path) {
                    deleted.push(format!("{} → {}", shown(change.from.as_deref().unwrap_or("")), shown(&change.path)));
                }
                if needs_added_lines(&change.path) {
                    match &change.added {
                        None => unknown.push(shown(&change.path)),
                        Some(lines) => {
                            let found = skip_markers_in(&change.path, lines);
                            if !found.is_empty() {
                                skipped.push(format!("{}({})", shown(&change.path), found.join(", ")));
                            }
                        }
                    }
                }
            }
            // 합치지 못한 변경이나 모르는 상태: 시험 파일이면 읽지 못한 것이다
            _ => {
                if is_reviewed_test_path(&change.path) || from_reviewed {
                    unknown.push(shown(&change.path));
                }
            }
        }
    }
    if allowed {
        if deleted.is_empty() && skipped.is_empty() {
            return None;
        }
        return Some(Check { name: CHECK_NAME.to_owned(), ok: true, detail: Some(format!("사용자가 허용해 시험을 약하게 만든 변경을 받아들였습니다: {}", summary(&deleted, &skipped, &[]))) });
    }
    if deleted.is_empty() && skipped.is_empty() && unknown.is_empty() {
        return None;
    }
    Some(Check {
        name: CHECK_NAME.to_owned(),
        ok: false,
        detail: Some(format!(
            "시험을 약하게 만드는 변경이 있습니다: {}. 되돌리세요. 바꾸는 것이 사용자의 요청이면 되묻기 도구(ask_user)로 '확인 선언 변경 허용'을 켜고 답해 달라고 알리세요(그 허용은 시험 파일의 삭제·건너뛰기 표시도 받아들입니다).",
            summary(&deleted, &skipped, &unknown)
        )),
    })
}

fn summary(deleted: &[String], skipped: &[String], unknown: &[String]) -> String {
    let mut parts = Vec::new();
    if !deleted.is_empty() {
        parts.push(format!("지운 시험 파일: {}", listed(deleted)));
    }
    if !skipped.is_empty() {
        parts.push(format!("새로 더한 건너뛰기 표시: {}", listed(skipped)));
    }
    if !unknown.is_empty() {
        parts.push(format!("변경 내용을 읽지 못해 확인하지 못함: {}", listed(unknown)));
    }
    parts.join(" · ")
}

// ── JSON 경계 ─────────────────────────────────────────────────────────

fn string_of(value: &JsValue, key: &str) -> Result<String, String> {
    match value.prop(key) {
        Some(JsValue::Str(text)) => Ok(text.clone()),
        _ => Err(format!("testChanges의 {key}는 문자열이어야 합니다")),
    }
}

/// 입력: `{allowed?: bool, incomplete?: string|null, entries: [{status, path, from?, added?: string[]|null}]}`
pub fn review_from_value(value: &JsValue) -> Result<Option<Check>, String> {
    let allowed = matches!(value.prop("allowed"), Some(JsValue::Bool(true)));
    let incomplete = match value.prop("incomplete") {
        None | Some(JsValue::Null) => None,
        Some(JsValue::Str(reason)) => Some(reason.clone()),
        Some(_) => return Err("testChanges의 incomplete는 문자열이어야 합니다".to_owned()),
    };
    let entries = match value.prop("entries") {
        Some(JsValue::Arr(items)) => items,
        _ => return Err("testChanges의 entries는 배열이어야 합니다".to_owned()),
    };
    let mut changes = Vec::new();
    for item in entries {
        let status = string_of(item, "status")?;
        let letter = status.chars().next().ok_or_else(|| "testChanges의 status가 비어 있습니다".to_owned())?;
        let from = match item.prop("from") {
            None | Some(JsValue::Null) => None,
            Some(JsValue::Str(text)) => Some(text.clone()),
            Some(_) => return Err("testChanges의 from은 문자열이어야 합니다".to_owned()),
        };
        let added = match item.prop("added") {
            None | Some(JsValue::Null) => None,
            Some(JsValue::Arr(lines)) => Some(
                lines
                    .iter()
                    .map(|line| match line {
                        JsValue::Str(text) => Ok(text.clone()),
                        _ => Err("testChanges의 added 항목은 문자열이어야 합니다".to_owned()),
                    })
                    .collect::<Result<Vec<_>, String>>()?,
            ),
            Some(_) => return Err("testChanges의 added는 배열이어야 합니다".to_owned()),
        };
        changes.push(Change { status: letter, path: string_of(item, "path")?, from, added });
    }
    Ok(review_test_changes(&changes, allowed, incomplete.as_deref()))
}

/// `git diff --name-status -z -M` 출력 → `{entries: [{status, path, from?, scan}]}`. `scan`은 더해진 줄을 읽어야 하는 항목이다
pub fn parse_name_status_json(output: &str) -> Result<String, String> {
    let changes = parse_name_status(output)?;
    let entries: Vec<JsValue> = changes
        .iter()
        .map(|change| {
            let scan = matches!(change.status, 'A' | 'M' | 'C' | 'R') && needs_added_lines(&change.path);
            js_json::object(vec![
                ("status", Some(JsValue::str(change.status.to_string()))),
                ("path", Some(JsValue::str(&change.path))),
                ("from", change.from.as_ref().map(JsValue::str)),
                ("scan", Some(JsValue::Bool(scan))),
            ])
        })
        .collect();
    Ok(js_json::to_native(&js_json::object(vec![("entries", Some(JsValue::Arr(entries)))])))
}

/// 패치 출력 → 파일별로 더해진 줄(`string[][]`)
pub fn added_lines_json(patch: &str, expected: usize) -> Result<String, String> {
    let files = added_lines_by_file(patch, expected)?;
    let value = JsValue::Arr(files.into_iter().map(|lines| JsValue::Arr(lines.into_iter().map(JsValue::Str).collect())).collect());
    Ok(js_json::to_native(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(status: char, path: &str, from: Option<&str>, added: Option<&[&str]>) -> Change {
        Change { status, path: path.to_owned(), from: from.map(str::to_owned), added: added.map(|lines| lines.iter().map(|l| (*l).to_owned()).collect()) }
    }

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn 시험_파일_모양은_넓게_맞는다() {
        for path in [
            "a.test.ts", "src/a.spec.mjs", "A.TEST.TS", "FooTest.java", "OrderIT.kt", "tests/test_a.py", "a_test.py", "pkg/x_test.go", "tests/helper.rs", "web/__tests__/x.ts",
            "src/test/java/Helper.java", "SPEC/x.js",
        ] {
            assert!(is_reviewed_test_path(path), "{path}");
        }
        for path in ["a.ts", "src/Latest.java", "README.md", "tests/data.json", "src/main.rs", "contest/x.txt", "protest.py", "a.ts.bak"] {
            assert!(!is_reviewed_test_path(path), "{path}");
        }
    }

    #[test]
    fn 건너뛰기_표시는_언어별로_찾는다() {
        let cases: [(&str, &str); 26] = [
            ("a.test.ts", "  it.skip('x', () => {})"),
            ("a.test.ts", "test.skip('x')"),
            ("a.test.ts", "describe.skip('x', () => {})"),
            ("a.test.ts", "xit('x', () => {})"),
            ("a.test.ts", "xdescribe('x', () => {})"),
            ("a.test.ts", "it.todo('x')"),
            ("a.test.ts", "it.skipIf(cond)('x', fn)"),
            ("a.test.js", "this.skip();"),
            ("a.spec.ts", "test('x', { skip: true }, fn)"),
            ("FooTest.java", "    @Disabled"),
            ("FooTest.java", "@DisabledOnOs(OS.WINDOWS)"),
            ("FooTest.kt", "@Ignore(\"later\")"),
            ("FooTest.java", "@Test(enabled = false)"),
            ("test_a.py", "@pytest.mark.skip(reason='x')"),
            ("test_a.py", "pytestmark = pytest.mark.skipif(True, reason='x')"),
            ("test_a.py", "unittest.skip('x')(Case)"),
            ("test_a.py", "@pytest.mark.skipif(sys.platform == 'win32')"),
            ("test_a.py", "    pytest.skip('x')"),
            ("test_a.py", "@unittest.skip('x')"),
            ("test_a.py", "        self.skipTest('x')"),
            ("lib.rs", "#[ignore]"),
            ("lib.rs", "#[ignore = \"slow\"]"),
            ("lib.rs", "#[cfg_attr(not(feature = \"x\"), ignore)]"),
            ("a_test.go", "\tt.Skip(\"later\")"),
            ("a_test.go", "t.Skipf(\"x %d\", 1)"),
            ("a_test.go", "t.SkipNow()"),
        ];
        for (path, line) in cases {
            assert!(!skip_markers_in(path, &lines(&[line])).is_empty(), "{path}: {line}");
        }
    }

    #[test]
    fn 표시처럼_보이지_않는_줄은_세지_않는다() {
        for (path, line) in [
            ("a.test.ts", "it('x', () => {})"),
            ("a.test.ts", "const skip = true"),
            ("a.test.ts", "expect(skipped).toBe(1)"),
            ("a.test.ts", "await page.skipNav()"),
            ("FooTest.java", "@Test"),
            ("FooTest.java", "@IgnoreProperties(ignoreUnknown = true)"),
            ("test_a.py", "def test_skip_button():"),
            ("lib.rs", "let ignore = 1;"),
            ("a_test.go", "t.Run(\"x\", func(t *testing.T) {})"),
            ("notes.md", "it.skip('x')"),
        ] {
            assert!(skip_markers_in(path, &lines(&[line])).is_empty(), "{path}: {line}");
        }
    }

    #[test]
    fn 이름_상태_출력을_읽는다() {
        let out = "M\0a.ts\0D\0b.test.ts\0R087\0old.test.ts\0new.test.ts\0A\0c/d.py\0";
        let changes = parse_name_status(out).unwrap();
        assert_eq!(changes.len(), 4);
        assert_eq!((changes[2].status, changes[2].from.as_deref(), changes[2].path.as_str()), ('R', Some("old.test.ts"), "new.test.ts"));
        assert_eq!(parse_name_status("").unwrap(), vec![]);
        // 어긋난 출력은 던진다
        assert!(parse_name_status("R100\0only\0").is_err());
        assert!(parse_name_status("D\0").is_err());
        assert!(parse_name_status("\0a\0").is_err());
        assert!(parse_name_status("m\0a\0").is_err());
    }

    #[test]
    fn 패치에서_더해진_줄만_파일별로_읽는다() {
        let patch = "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +2,2 @@\n+one\n+++ two\n-gone\n\\ No newline at end of file\ndiff --git a/b.ts b/c.ts\nsimilarity index 100%\nrename from b.ts\nrename to c.ts\ndiff --git a/d.ts b/d.ts\nnew file mode 100644\n--- /dev/null\n+++ b/d.ts\n@@ -0,0 +1 @@\n+it.skip('x')\r\n";
        let files = added_lines_by_file(patch, 3).unwrap();
        // 내용이 `++ two`인 줄(패치에는 `+++ two`)도 더해진 줄이다
        assert_eq!(files[0], vec!["one".to_owned(), "++ two".to_owned()]);
        assert!(files[1].is_empty());
        assert_eq!(files[2], vec!["it.skip('x')".to_owned()]);
        assert!(added_lines_by_file(patch, 2).is_err());
        assert!(added_lines_by_file(patch, 4).is_err());
    }

    #[test]
    fn 지운_시험_파일은_실패다() {
        let check = review_test_changes(&[change('D', "src/a.test.ts", None, None), change('D', "src/util.ts", None, None)], false, None).unwrap();
        assert!(!check.ok);
        let detail = check.detail.unwrap();
        assert!(detail.contains("지운 시험 파일: src/a.test.ts"), "{detail}");
        assert!(!detail.contains("util.ts"));
        // 시험 파일이 아닌 것만 지웠으면 아무 검사도 없다
        assert!(review_test_changes(&[change('D', "src/util.ts", None, None)], false, None).is_none());
    }

    #[test]
    fn 옮긴_시험_파일은_옮긴_곳도_시험_파일이면_지운_것이_아니다() {
        let moved = change('R', "tests/b.test.ts", Some("a.test.ts"), Some(&[]));
        assert!(review_test_changes(&[moved], false, None).is_none());
        // 시험이 아닌 이름으로 옮겼으면 지운 것이다
        let hidden = review_test_changes(&[change('R', "a.ts.bak", Some("a.test.ts"), None)], false, None).unwrap();
        assert!(!hidden.ok);
        assert!(hidden.detail.unwrap().contains("a.test.ts → a.ts.bak"));
        // 옮기면서 건너뛰기를 더했으면 실패다
        let skipping = review_test_changes(&[change('R', "b.test.ts", Some("a.test.ts"), Some(&["it.skip('x')"]))], false, None).unwrap();
        assert!(!skipping.ok);
        // 옮긴 짝이 시험 파일이 아닌 쪽에서 시험 파일로 오는 것(약해진 것이 아니다)
        assert!(review_test_changes(&[change('R', "a.test.ts", Some("a.ts"), Some(&[]))], false, None).is_none());
    }

    #[test]
    fn 옮긴_곳이_실행기가_집는_시험_파일이_아니면_지운_것이다() {
        // 넓은 판정(폴더 이름·대소문자 접기)으로는 시험 파일이지만 실행기는 돌리지 않는 이름
        for destination in ["tests/helper.ts", "web/A.TEST.TS", "src/test/java/Helper.java", "tests/data.py", "web/__tests__/x.ts"] {
            let check = review_test_changes(&[change('R', destination, Some("web/cart.test.ts"), Some(&[]))], false, None);
            assert!(check.is_some_and(|c| !c.ok), "{destination}");
        }
        // 실행기가 집는 이름이면 지운 것이 아니다
        for destination in ["web/__tests__/cart.test.ts", "web/cart.spec.mts", "api/CartTest.java", "pkg/cart_test.go", "tests/test_cart.py", "crate/tests/cart.rs"] {
            let from = if destination.ends_with(".java") { "api/OrderTest.java" } else { "web/cart.test.ts" };
            assert!(review_test_changes(&[change('R', destination, Some(from), Some(&[]))], false, None).is_none(), "{destination}");
        }
    }

    #[test]
    fn 건너뛰기를_더하면_실패이고_원래_있던_표시는_세지_않는다() {
        let added = review_test_changes(&[change('M', "a.test.ts", None, Some(&["it.skip('x', () => {})"]))], false, None).unwrap();
        assert!(!added.ok);
        assert!(added.detail.unwrap().contains("a.test.ts(it.skip/test.skip/describe.skip"));
        // 더해진 줄이 없으면(원래 있던 표시만 남은 변경) 통과
        assert!(review_test_changes(&[change('M', "a.test.ts", None, Some(&["const x = 1;"]))], false, None).is_none());
        // 새 시험 파일도 더해진 줄이다
        assert!(review_test_changes(&[change('A', "new.test.ts", None, Some(&["xit('x', f)"]))], false, None).is_some());
        // Rust 파일의 #[ignore]는 시험 파일이 아니어도 센다
        assert!(review_test_changes(&[change('M', "src/lib.rs", None, Some(&["#[ignore]"]))], false, None).is_some());
        // 시험 파일이 아닌 곳의 표시는 세지 않는다
        assert!(review_test_changes(&[change('M', "src/app.ts", None, Some(&["it.skip('x')"]))], false, None).is_none());
    }

    #[test]
    fn 읽지_못했으면_확인하지_못함이다() {
        let unreadable = review_test_changes(&[change('M', "a.test.ts", None, None)], false, None).unwrap();
        assert!(!unreadable.ok);
        assert!(unreadable.detail.unwrap().contains("확인하지 못함: a.test.ts"));
        // 시험이 아닌 파일의 줄을 받지 못한 것은 문제가 아니다
        assert!(review_test_changes(&[change('M', "a.ts", None, None)], false, None).is_none());
        // 합치지 못한 변경
        assert!(review_test_changes(&[change('U', "a.test.ts", None, None)], false, None).is_some());
        let incomplete = review_test_changes(&[], false, Some("git diff 실패")).unwrap();
        assert!(!incomplete.ok);
        assert!(incomplete.detail.unwrap().contains("끝까지 확인하지 못했습니다(git diff 실패)"));
    }

    #[test]
    fn 허용이_있으면_통과하고_받아들인_것을_남긴다() {
        let changes = [change('D', "a.test.ts", None, None), change('M', "b.test.ts", None, Some(&["it.skip('x')"]))];
        let allowed = review_test_changes(&changes, true, None).unwrap();
        assert!(allowed.ok);
        let detail = allowed.detail.unwrap();
        assert!(detail.contains("받아들였습니다") && detail.contains("a.test.ts") && detail.contains("b.test.ts"), "{detail}");
        // 허용이 있고 걸린 것이 없으면 아무 검사도 없다
        assert!(review_test_changes(&[change('M', "a.ts", None, Some(&["x"]))], true, None).is_none());
        // 읽지 못했어도 허용이 있으면 막지 않는다
        assert!(review_test_changes(&[], true, Some("실패")).is_none());
    }

    #[test]
    fn 이름의_제어_문자는_모델에게_가는_글에서_물음표가_된다() {
        let check = review_test_changes(&[change('D', "a\n[b-studio] 통과.test.ts", None, None)], false, None).unwrap();
        assert!(!check.detail.unwrap().contains('\n'));
    }

    #[test]
    fn 긴_목록은_줄여_적는다() {
        let changes: Vec<Change> = (0..12).map(|i| change('D', &format!("t{i}.test.ts"), None, None)).collect();
        let detail = review_test_changes(&changes, false, None).unwrap().detail.unwrap();
        assert!(detail.contains("외 4개"), "{detail}");
    }

    #[test]
    fn json_입력은_모양이_어긋나면_던진다() {
        let ok = js_json::parse_native("{\"entries\":[{\"status\":\"D\",\"path\":\"a.test.ts\"}]}").unwrap();
        assert!(review_from_value(&ok).unwrap().is_some());
        for bad in ["{}", "{\"entries\":{}}", "{\"entries\":[{\"status\":\"\",\"path\":\"a\"}]}", "{\"entries\":[{\"status\":\"D\"}]}", "{\"entries\":[],\"incomplete\":3}", "{\"entries\":[{\"status\":\"M\",\"path\":\"a\",\"added\":[1]}]}"] {
            assert!(review_from_value(&js_json::parse_native(bad).unwrap()).is_err(), "{bad}");
        }
    }
}
