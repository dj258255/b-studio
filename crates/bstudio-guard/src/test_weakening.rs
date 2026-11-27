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
//! 이슈 #1451에서 넓힌 네 길: (1) 시험 설정 파일(vitest·jest·playwright 설정, pytest 설정·conftest.py, pom.xml, build.gradle)의 더해진 줄에서 시험을 빼는 표시,
//! (2) `package.json`의 `scripts.test`·`test:*`를 비우거나 `|| true`·`--passWithNoTests`·echo만 남기게 바꾼 것(전후 JSON을 견준다), (3) 스냅샷 파일 삭제(시험 삭제와 같게),
//! (4) 시험 파일에서 지운 단언 수가 더한 단언 수보다 많은 것(바꾸는 것은 통과).
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
    /// 더해진 줄 각각의 (바뀐 뒤 파일에서의) 1부터 센 줄 번호. 시험 설정 파일의 배열 안 줄을 알아보는 데 쓴다
    pub added_at: Option<Vec<usize>>,
    /// (더해진 단언 수, 지운 단언 수). 지운 단언이 있을 때만 받는다
    pub assertions: Option<(usize, usize)>,
    /// 시험 설정 파일의 바뀐 뒤 내용(배열 안 줄 확인, `package.json` 스크립트 읽기)과 `package.json`의 바뀌기 전 내용
    pub after: Option<String>,
    pub before: Option<String>,
}

impl Change {
    /// 줄·내용을 받지 못한 변경
    pub fn bare(status: char, path: &str) -> Change {
        Change { status, path: path.to_owned(), from: None, added: None, added_at: None, assertions: None, after: None, before: None }
    }
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
    is_reviewed_test_path(path) || extension(path) == "rs" || config_kind(path).is_some()
}

/// 건너뛰기 표시를 찾는 경로: 시험 파일, Rust 파일, 시험 설정을 담는 `conftest.py`
fn scans_skip_markers(path: &str) -> bool {
    is_reviewed_test_path(path) || extension(path) == "rs" || config_kind(path) == Some(ConfigKind::Python) && file_name(path).eq_ignore_ascii_case("conftest.py")
}

/// 스냅샷 파일(거부 목록 쪽 맞춤: 넓게 맞는다): `.snap`·`.ambr` 파일이거나 `__snapshots__` 폴더 아래의 파일. 대소문자를 접고 구분자는 `/`와 `\` 모두 본다
pub fn is_snapshot_path(path: &str) -> bool {
    let lower = path.to_lowercase().replace('\\', "/");
    let mut segments: Vec<&str> = lower.split('/').collect();
    let name = segments.pop().unwrap_or("");
    name.ends_with(".snap") || name.ends_with(".ambr") || segments.contains(&"__snapshots__")
}

// ── 시험 설정 파일 ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigKind {
    /// vitest·jest·playwright·vite 설정
    Js,
    /// pytest.ini·pyproject.toml·setup.cfg·tox.ini·conftest.py
    Python,
    Maven,
    Gradle,
    Package,
}

impl ConfigKind {
    pub fn name(self) -> &'static str {
        match self {
            ConfigKind::Js => "js",
            ConfigKind::Python => "python",
            ConfigKind::Maven => "maven",
            ConfigKind::Gradle => "gradle",
            ConfigKind::Package => "package",
        }
    }

    /// 바뀐 뒤의 파일 내용이 있어야 읽을 수 있는 종류(배열 안의 줄, `package.json`의 스크립트)
    pub fn needs_after(self) -> bool {
        matches!(self, ConfigKind::Js | ConfigKind::Python | ConfigKind::Package)
    }
}

static JS_CONFIG_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:(?:vitest|jest|playwright|vite)(?:\.[a-z0-9_-]+)*\.(?:config|workspace)\.(?:[cm]?[jt]s|json)|\.?jestrc(?:\.json|\.js)?)$").expect("정규식"));

/// 시험을 고르는 설정을 담는 파일. 이름만 본다(대소문자를 접고 `\`도 구분자로 본다)
pub fn config_kind(path: &str) -> Option<ConfigKind> {
    let name = file_name(path).to_lowercase();
    match name.as_str() {
        "package.json" => Some(ConfigKind::Package),
        "pytest.ini" | "pyproject.toml" | "setup.cfg" | "tox.ini" | "conftest.py" => Some(ConfigKind::Python),
        "pom.xml" => Some(ConfigKind::Maven),
        "build.gradle" | "build.gradle.kts" => Some(ConfigKind::Gradle),
        _ if JS_CONFIG_NAME.is_match(&name) => Some(ConfigKind::Js),
        _ => None,
    }
}

// ── 건너뛰기 표시 ────────────────────────────────────────────────────

struct Marker {
    label: &'static str,
    pattern: Regex,
    /// 이 모양이면 표시가 아니다(예: Gradle 의존성의 `exclude group:`)
    unless: Option<Regex>,
}

impl Marker {
    /// `unless`가 있으면 줄 끝의 `//` 주석을 떼고, 패턴이 맞는 자리마다 그 자리부터가 `unless` 모양(줄머리 고정)인지 본다.
    /// 예외가 아닌 자리가 하나라도 있으면 표시다: 같은 줄에 의존성 모양을 덧붙여 시험 제외를 가리는 길을 막는다
    fn matches(&self, line: &str) -> bool {
        let Some(unless) = &self.unless else { return self.pattern.is_match(line) };
        // 주석을 뗀 줄과 원래 줄 둘 다 본다: 따옴표 안의 ` //`가 뒤를 잘라 표시를 가리는 길을 막는다(어느 한쪽이라도 의존성이 아닌 exclude가 있으면 표시)
        let code = strip_line_comment(line);
        [code, line].iter().any(|text| self.pattern.find_iter(text).any(|found| !unless.is_match(&text[found.start()..])))
    }
}

/// 줄 끝의 `//` 주석(앞이 공백이거나 줄 머리인 것)을 뗀다
fn strip_line_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    for index in 0..bytes.len().saturating_sub(1) {
        if bytes[index] == b'/' && bytes[index + 1] == b'/' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
            return &line[..index];
        }
    }
    line
}

fn markers(list: &[(&'static str, &str)]) -> Vec<Marker> {
    list.iter().map(|(label, pattern)| Marker { label, pattern: Regex::new(pattern).expect("정규식"), unless: None }).collect()
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
            if !found.contains(&marker.label) && marker.matches(line) {
                found.push(marker.label);
            }
        }
    }
    found
}

// ── 시험 설정 표시 ────────────────────────────────────────────────────

static JS_CONFIG_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[
        ("exclude", r"(?-u:\b)exclude[\x22']?[ \t]*[:=]"),
        ("testPathIgnorePatterns", r"(?-u:\b)testPathIgnorePatterns(?-u:\b)"),
        ("modulePathIgnorePatterns", r"(?-u:\b)modulePathIgnorePatterns(?-u:\b)"),
        ("testIgnore", r"(?-u:\b)testIgnore(?-u:\b)"),
        ("grepInvert", r"(?-u:\b)grepInvert(?-u:\b)"),
        ("passWithNoTests", r"(?-u:\b)passWithNoTests(?-u:\b)"),
    ])
});
static PACKAGE_CONFIG_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[
        ("testPathIgnorePatterns", r"(?-u:\b)testPathIgnorePatterns(?-u:\b)"),
        ("modulePathIgnorePatterns", r"(?-u:\b)modulePathIgnorePatterns(?-u:\b)"),
    ])
});
static PY_CONFIG_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[
        ("--ignore", r"--ignore(?:-glob)?(?-u:\b)"),
        ("--deselect", r"--deselect(?-u:\b)"),
        ("-k \"not …\"", r"(?:^|[ \t=\x22'])-k[ \t=]*[\x22']?[ \t]*not(?-u:\b)"),
        ("collect_ignore", r"(?-u:\b)collect_ignore(?:_glob)?(?-u:\b)"),
        ("pytest_deselected", r"(?-u:\b)pytest_deselected(?-u:\b)"),
        ("items 비우기", r"(?-u:\b)items[ \t]*\[[ \t]*:[ \t]*\][ \t]*=|(?-u:\b)items\.(?:remove|clear|pop)[ \t]*\(|(?-u:\b)del[ \t]+items(?-u:\b)"),
    ])
});
static MAVEN_CONFIG_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[
        ("<exclude>", r"<exclude(?-u:\b)"),
        ("<excludedGroups>", r"<excludedGroups(?-u:\b)"),
        ("<skipTests>", r"<skipTests(?-u:\b)|<skipITs(?-u:\b)|<skipExec(?-u:\b)"),
        ("<skip>true", r"<skip>[ \t]*true"),
        ("<testFailureIgnore>", r"<testFailureIgnore>[ \t]*true|maven\.test\.failure\.ignore|maven\.test\.skip"),
        ("-DskipTests", r"-Dskip(?:Tests|ITs)(?-u:\b)"),
    ])
});
static GRADLE_CONFIG_MARKERS: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    let mut list = markers(&[
        ("enabled = false", r"(?-u:\b)enabled[ \t]*=?[ \t]*false(?-u:\b)"),
        ("excludeTestsMatching", r"(?-u:\b)excludeTestsMatching(?-u:\b)"),
        ("ignoreFailures", r"(?-u:\b)ignoreFailures[ \t]*=?[ \t]*true"),
        ("onlyIf { false }", r"(?-u:\b)onlyIf[ \t]*\{[ \t]*false"),
        ("-x test", r"(?:^|[ \t])-x[ \t]+test(?-u:\b)"),
    ]);
    list.push(Marker {
        label: "exclude",
        pattern: Regex::new(r"(?-u:\b)exclude(?-u:\b)").expect("정규식"),
        // 의존성의 exclude(`exclude group: 'x'`, `exclude(group = "x")`, `exclude module:`)는 시험을 빼는 것이 아니다
        unless: Some(Regex::new(r"^exclude[ \t]*\(?[ \t]*(?:group|module)[ \t]*[:=]").expect("정규식")),
    });
    list
});
static ADDOPTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[ \t]*addopts[ \t]*[=:]").expect("정규식"));

/// 이 줄이 ini 꼴 `addopts =` 값에 이어진 줄(들여쓴 줄, 사이의 빈 줄 허용)인지
fn continues_addopts(lines: &[&str], index: usize) -> bool {
    if !lines[index].starts_with([' ', '\t']) {
        return false;
    }
    for line in lines[..index].iter().rev() {
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            return ADDOPTS.is_match(line);
        }
    }
    false
}

static MODIFYITEMS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)pytest_collection_modifyitems(?-u:\b)").expect("정규식"));
static MODIFYITEMS_DROP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)skip|deselect|\.remove[ \t]*\(|(?-u:\b)del(?-u:\b)|\.clear[ \t]*\(|\.pop[ \t]*\(|items[ \t]*\[").expect("정규식"));

fn config_marker_set(kind: ConfigKind) -> &'static [Marker] {
    match kind {
        ConfigKind::Js => &JS_CONFIG_MARKERS,
        ConfigKind::Package => &PACKAGE_CONFIG_MARKERS,
        ConfigKind::Python => &PY_CONFIG_MARKERS,
        ConfigKind::Maven => &MAVEN_CONFIG_MARKERS,
        ConfigKind::Gradle => &GRADLE_CONFIG_MARKERS,
    }
}

fn push_label(found: &mut Vec<&'static str>, label: &'static str) {
    if !found.contains(&label) {
        found.push(label);
    }
}

/// 바뀐 뒤 파일의 줄마다, 그 줄을 감싸는 `[`·`{`·`(`가 열린 줄의 번호(0부터)를 구한다. 한 번 훑는다.
/// 따옴표·주석은 가리지 않는다(괄호가 맞지 않게 세면 감싸는 줄을 놓칠 수 있다)
fn enclosing_openers(after: &str, targets: &[usize]) -> Result<std::collections::HashMap<usize, Vec<usize>>, String> {
    let wanted: std::collections::HashSet<usize> = targets.iter().copied().collect();
    let mut stack: Vec<usize> = Vec::new();
    let mut result = std::collections::HashMap::new();
    for (index, line) in after.split('\n').enumerate() {
        if wanted.contains(&(index + 1)) {
            result.insert(index + 1, stack.clone());
        }
        for ch in line.chars() {
            match ch {
                '[' | '{' | '(' => stack.push(index),
                ']' | '}' | ')' => {
                    stack.pop();
                }
                _ => {}
            }
        }
    }
    if let Some(missing) = targets.iter().find(|target| !result.contains_key(target)) {
        return Err(format!("변경 내용의 줄 번호 {missing}가 바뀐 뒤 파일에 없습니다"));
    }
    Ok(result)
}

/// 시험 설정 파일의 더해진 줄에서 시험을 빼는 표시를 찾는다(중복 없이, 찾은 순서).
/// 줄 자체에 표시가 없어도 표시가 붙은 배열·블록(`exclude: [`) 안에 더해진 줄이면 같게 센다. 그러려면 바뀐 뒤 파일(`after`)과 줄 번호가 있어야 한다.
/// 줄 번호가 파일과 맞지 않으면 던진다(모르면 통과가 아니다)
pub fn config_markers_in(kind: ConfigKind, added: &[String], at: Option<&[usize]>, after: Option<&str>) -> Result<Vec<&'static str>, String> {
    let set = config_marker_set(kind);
    let mut found: Vec<&'static str> = Vec::new();
    let mut inside: Vec<usize> = Vec::new();
    for (position, line) in added.iter().enumerate() {
        let mut hit = false;
        // 인자를 따옴표·쉼표로 나눠 쓴 배열(`["-k", "not slow"]`)도 찾도록 Python 설정은 구분 글자를 공백으로 바꾼 줄도 본다
        let spread: String = if kind == ConfigKind::Python { line.chars().map(|c| if matches!(c, '"' | '\'' | ',' | '[' | ']') { ' ' } else { c }).collect() } else { String::new() };
        for marker in set {
            if marker.matches(line) || (kind == ConfigKind::Python && marker.matches(&spread)) {
                push_label(&mut found, marker.label);
                hit = true;
            }
        }
        if !hit && matches!(kind, ConfigKind::Js | ConfigKind::Package | ConfigKind::Python) {
            inside.push(position);
        }
    }
    if kind == ConfigKind::Python && added.iter().any(|line| MODIFYITEMS.is_match(line)) && added.iter().any(|line| MODIFYITEMS_DROP.is_match(line)) {
        push_label(&mut found, "pytest_collection_modifyitems");
    }
    if inside.is_empty() {
        return Ok(found);
    }
    let (Some(at), Some(after)) = (at, after) else { return Err("배열 안의 줄인지 확인할 바뀐 뒤 파일이나 줄 번호가 없습니다".to_owned()) };
    if at.len() != added.len() {
        return Err("더해진 줄과 줄 번호의 개수가 다릅니다".to_owned());
    }
    let lines: Vec<&str> = after.split('\n').collect();
    let targets: Vec<usize> = inside.iter().map(|position| at[*position]).collect();
    let openers = enclosing_openers(after, &targets)?;
    for position in inside {
        let number = at[position];
        // 패치의 줄과 바뀐 뒤 파일의 줄이 같은지 본다(어긋나면 줄 번호를 믿을 수 없다)
        if lines.get(number - 1).map(|line| line.trim_end_matches('\r')) != Some(added[position].as_str()) {
            return Err(format!("변경 내용의 줄 {number}가 바뀐 뒤 파일과 맞지 않습니다"));
        }
        for opener in &openers[&number] {
            for marker in set {
                if marker.matches(lines[*opener]) {
                    push_label(&mut found, marker.label);
                }
            }
            // `addopts = [` 배열 안에 더한 줄은 모두 검토 대상이다(인자를 줄마다 나눠 쓸 수 있다)
            if kind == ConfigKind::Python && ADDOPTS.is_match(lines[*opener]) {
                push_label(&mut found, "addopts 안의 줄");
            }
        }
        // ini의 `addopts =` 뒤에 이어진(들여쓴) 줄도 같다
        if kind == ConfigKind::Python && continues_addopts(&lines, number - 1) {
            push_label(&mut found, "addopts 안의 줄");
        }
    }
    Ok(found)
}

// ── package.json의 test 스크립트 ───────────────────────────────────────

static SCRIPT_RULES: LazyLock<Vec<Marker>> = LazyLock::new(|| {
    markers(&[
        ("|| true 꼴(실패를 삼킴)", r"\|\|[ \t]*(?:true(?-u:\b)|:|exit[ \t]+0(?-u:\b)|echo(?-u:\b))"),
        ("; exit 0 꼴(실패를 삼킴)", r";[ \t]*(?:exit[ \t]+0(?-u:\b)|true(?-u:\b)|:[ \t]*$)"),
        ("시험이 없어도 통과(--passWithNoTests)", r"--(?:passWithNoTests|pass-with-no-tests|allow-no-tests)(?-u:\b)"),
        ("시험 제외 옵션", r"(?:^|[ \t])--(?:exclude|testPathIgnorePatterns|modulePathIgnorePatterns|ignore|ignore-glob|ignore-pattern|deselect|grep-invert|no-run)(?-u:\b)"),
        ("-k \"not …\"", r"(?:^|[ \t])-k[ \t=]*[\x22']?[ \t]*not(?-u:\b)"),
        ("시험 건너뛰기 옵션", r"-Dskip(?:Tests|ITs)(?-u:\b)|-Dmaven\.test\.skip|(?:^|[ \t])-x[ \t]+test(?-u:\b)"),
    ])
});

/// 따옴표 밖의 `&&`·`||`·`;`·`|`로 나눈 명령 조각
fn command_segments(script: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = script.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if let Some(open) = quote {
            current.push(ch);
            if ch == open {
                quote = None;
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
        } else if matches!(ch, ';' | '|' | '&') {
            segments.push(std::mem::take(&mut current));
            // `&&`·`||`는 두 글자를 한 구분자로 읽는다
            if matches!(ch, '|' | '&') && chars.get(index + 1) == Some(&ch) {
                index += 1;
            }
        } else {
            current.push(ch);
        }
        index += 1;
    }
    segments.push(current);
    segments.into_iter().map(|segment| segment.trim().to_owned()).filter(|segment| !segment.is_empty()).collect()
}

/// 아무것도 돌리지 않고 끝나는 명령 조각(`echo …`, `true`, `:`, `exit`·`exit 0`)
fn is_noop_segment(segment: &str) -> bool {
    let mut words = segment.split_whitespace();
    match words.next() {
        Some("echo" | "printf" | "true" | ":") => true,
        Some("exit") => matches!(words.next(), None | Some("0")),
        _ => false,
    }
}

/// 시험 스크립트 한 줄이 약해 보이는 모양(찾은 모양의 이름들)
pub fn weak_script_labels(script: &str) -> Vec<&'static str> {
    let mut found = Vec::new();
    let segments = command_segments(script);
    if segments.is_empty() {
        found.push("비어 있음");
    } else if segments.iter().all(|segment| is_noop_segment(segment)) {
        found.push("아무것도 돌리지 않음");
    }
    for rule in SCRIPT_RULES.iter() {
        if rule.matches(script) {
            found.push(rule.label);
        }
    }
    found
}

fn is_test_script_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "test" || lower.starts_with("test:")
}

/// `scripts`에서 이름이 `test`·`test:*`인 것(문자열이 아닌 값은 빈 스크립트와 같이 다룬다)
fn test_scripts(root: &JsValue) -> Vec<(String, Option<String>)> {
    match root.prop("scripts") {
        Some(JsValue::Obj(scripts)) => scripts
            .entries()
            .iter()
            .filter(|(name, _)| is_test_script_name(name))
            .map(|(name, value)| (name.clone(), value.as_str().map(str::to_owned)))
            .collect(),
        _ => Vec::new(),
    }
}

/// `package.json`의 바뀌기 전·후 내용을 견줘 시험 스크립트가 약해졌는지 본다(줄 단위가 아니라 JSON을 읽어 견준다: 한 줄로 이어 쓴 파일이나 줄 순서가 바뀐 파일에서도 같다).
/// 새로 생긴 약한 모양(바뀌기 전 스크립트에 없던 것)과 지워진 test 스크립트를 돌려준다. 원래 약했고 그대로인 스크립트는 세지 않는다.
/// 바뀐 뒤 내용을 읽지 못하면 던진다(모르면 통과가 아니다). 바뀌기 전 내용을 읽지 못하면 기준이 없는 것으로 본다
pub fn weak_test_scripts(before: Option<&str>, after: &str) -> Result<Vec<String>, String> {
    let after_value = js_json::parse(after).map_err(|error| format!("package.json을 읽지 못했습니다({error})"))?;
    if !matches!(after_value, JsValue::Obj(_)) {
        return Err("package.json의 최상위가 객체가 아닙니다".to_owned());
    }
    let before_scripts = before.and_then(|text| js_json::parse(text).ok()).map(|value| test_scripts(&value)).unwrap_or_default();
    let after_scripts = test_scripts(&after_value);
    let mut found = Vec::new();
    for (name, old) in &before_scripts {
        if old.is_some() && !after_scripts.iter().any(|(candidate, _)| candidate == name) {
            found.push(format!("scripts.{name}(지움)"));
        }
    }
    for (name, new) in &after_scripts {
        let old_labels = before_scripts.iter().find(|(candidate, _)| candidate == name).and_then(|(_, old)| old.as_deref()).map(weak_script_labels).unwrap_or_default();
        let new_labels = weak_script_labels(new.as_deref().unwrap_or(""));
        let added: Vec<&str> = new_labels.into_iter().filter(|label| !old_labels.contains(label)).collect();
        if !added.is_empty() {
            found.push(format!("scripts.{name}({})", added.join(", ")));
        }
    }
    Ok(found)
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
            changes.push(Change { status: letter, path: second.to_owned(), from: Some(first.to_owned()), ..Change::bare(letter, second) });
        } else {
            changes.push(Change::bare(letter, first));
        }
    }
    Ok(changes)
}

/// 패치에서 읽은 파일 하나: 더해진 줄과 그 줄 번호, 그리고 단언 수(주석 줄은 세지 않는다)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FilePatch {
    pub added: Vec<String>,
    pub at: Vec<usize>,
    pub assertions_added: usize,
    pub assertions_removed: usize,
}

static ASSERTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u:\b)(?:expect\w*[ \t]*\(|assert\w*[ \t]*[(!]|require\.\w+[ \t]*\(|t\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)[ \t]*\(|pytest\.raises[ \t]*\()|^[ \t]*assert[ \t]+",
    )
    .expect("정규식")
});

/// 한 줄의 단언 수. 주석으로 시작하는 줄은 세지 않는다(단언을 주석으로 바꿔 둔 것을 "더했다"로 세지 않으려는 것이다)
pub fn assertions_in(line: &str) -> usize {
    let trimmed = line.trim_start();
    if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') || trimmed.starts_with('#') {
        return 0;
    }
    ASSERTION.find_iter(line).count()
}

/// `@@ -a,b +c,d @@`에서 c(바뀐 뒤 파일의 시작 줄)
fn hunk_new_start(header: &str) -> Option<usize> {
    let plus = header.split(' ').find(|token| token.starts_with('+'))?;
    plus[1..].split(',').next()?.parse().ok()
}

/// `git diff -U0`의 출력을 파일별로 나눠 더해진 줄(과 줄 번호), 단언 수를 돌려준다. 파일 머리는 줄 맨 앞의 `diff --git `이다
/// (내용 줄은 항상 ` `·`+`·`-`·`\`로 시작하므로 맨 앞의 이 글자 모양은 머리뿐이다). 첫 `@@` 앞은 머리라서 `+++ `를 줄로 세지 않는다.
/// 파일 수가 기대와 다르면 던진다(어느 파일의 줄인지 모르면 통과가 아니다)
pub fn patches_by_file(patch: &str, expected: usize) -> Result<Vec<FilePatch>, String> {
    let mut files: Vec<FilePatch> = Vec::new();
    let mut in_hunk = false;
    let mut next_new = 0usize;
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            files.push(FilePatch::default());
            in_hunk = false;
            continue;
        }
        let Some(current) = files.last_mut() else { continue };
        if line.starts_with("@@") {
            in_hunk = true;
            next_new = hunk_new_start(line).ok_or_else(|| format!("변경 내용의 구간 머리를 읽지 못했습니다: {line}"))?;
            continue;
        }
        if in_hunk {
            if let Some(content) = line.strip_prefix('+') {
                let content = content.trim_end_matches('\r');
                current.assertions_added += assertions_in(content);
                current.added.push(content.to_owned());
                current.at.push(next_new);
                next_new += 1;
            } else if let Some(content) = line.strip_prefix('-') {
                current.assertions_removed += assertions_in(content.trim_end_matches('\r'));
            } else if line.starts_with(' ') {
                next_new += 1;
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
                "시험을 약하게 만든 변경(시험 파일·스냅샷 삭제, 건너뛰기 표시, 시험 설정, test 스크립트, 단언 삭제)이 있는지 끝까지 확인하지 못했습니다({}). 확인하지 못한 변경은 통과로 보지 않습니다. 다시 턴을 끝내 보세요.",
                shown(reason)
            )),
        });
    }
    let mut found = Findings::default();
    for change in changes {
        review_change(change, &mut found);
    }
    if allowed {
        if found.is_clean() {
            return None;
        }
        return Some(Check { name: CHECK_NAME.to_owned(), ok: true, detail: Some(format!("사용자가 허용해 시험을 약하게 만든 변경을 받아들였습니다: {}", summary(&found, false))) });
    }
    if found.is_clean() && found.unknown.is_empty() {
        return None;
    }
    Some(Check {
        name: CHECK_NAME.to_owned(),
        ok: false,
        detail: Some(format!(
            "시험을 약하게 만드는 변경이 있습니다: {}. 되돌리세요. 바꾸는 것이 사용자의 요청이면 되묻기 도구(ask_user)로 '확인 선언 변경 허용'을 켜고 답해 달라고 알리세요(그 허용은 시험 파일의 삭제·건너뛰기 표시, 시험 설정·test 스크립트·단언의 변경도 받아들입니다).",
            summary(&found, true)
        )),
    })
}

#[derive(Default)]
struct Findings {
    deleted: Vec<String>,
    snapshots: Vec<String>,
    configs: Vec<String>,
    skipped: Vec<String>,
    excluded: Vec<String>,
    scripts: Vec<String>,
    assertions: Vec<String>,
    unknown: Vec<String>,
}

impl Findings {
    fn is_clean(&self) -> bool {
        self.deleted.is_empty() && self.snapshots.is_empty() && self.configs.is_empty() && self.skipped.is_empty() && self.excluded.is_empty() && self.scripts.is_empty() && self.assertions.is_empty()
    }
}

fn review_change(change: &Change, found: &mut Findings) {
    let from_reviewed = change.from.as_deref().is_some_and(is_reviewed_test_path);
    let from_snapshot = change.from.as_deref().is_some_and(is_snapshot_path);
    match change.status {
        'D' => {
            if is_reviewed_test_path(&change.path) {
                found.deleted.push(shown(&change.path));
            }
            if is_snapshot_path(&change.path) {
                found.snapshots.push(shown(&change.path));
            }
            // 시험 설정 파일을 지우면 `package.json`의 test 스크립트·설정의 시험 선택이 함께 사라진다(바뀐 뒤를 빈 집합으로 본 것과 같다)
            if config_kind(&change.path).is_some() {
                found.configs.push(shown(&change.path));
            }
        }
        // 일반 파일이던 시험이 링크 등으로 바뀌었다: 시험으로 돌아가는 파일이 아니다
        'T' => {
            if is_reviewed_test_path(&change.path) {
                found.deleted.push(format!("{} (파일 종류가 바뀜)", shown(&change.path)));
            }
            if is_snapshot_path(&change.path) {
                found.snapshots.push(format!("{} (파일 종류가 바뀜)", shown(&change.path)));
            }
            if config_kind(&change.path).is_some() {
                found.configs.push(format!("{} (파일 종류가 바뀜)", shown(&change.path)));
            }
        }
        'A' | 'M' | 'C' | 'R' => {
            // 옮긴 곳이 실행기가 집는 시험 파일이 아니면 지운 것이다(도착지는 좁은 판정, 출발지는 넓은 판정)
            if change.status == 'R' && from_reviewed && !is_runner_test_path(&change.path) {
                found.deleted.push(format!("{} → {}", shown(change.from.as_deref().unwrap_or("")), shown(&change.path)));
            }
            // 스냅샷은 스냅샷 이름으로만 옮길 수 있다. 다른 이름으로 옮기면 더는 읽히지 않는다
            if change.status == 'R' && from_snapshot && !is_snapshot_path(&change.path) {
                found.snapshots.push(format!("{} → {}", shown(change.from.as_deref().unwrap_or("")), shown(&change.path)));
            }
            // 설정 파일은 어디로 옮기든 원래 프로젝트에 더는 적용되지 않는다(같은 종류의 이름이나 대소문자만 바뀐 이름도 건다. 옮긴 곳의 내용은 따로 본다)
            if change.status == 'R' {
                let from_kind = change.from.as_deref().and_then(config_kind);
                if from_kind.is_some() {
                    found.configs.push(format!("{} → {}", shown(change.from.as_deref().unwrap_or("")), shown(&change.path)));
                }
            }
            let reviewed = is_reviewed_test_path(&change.path);
            if needs_added_lines(&change.path) {
                match &change.added {
                    None => found.unknown.push(shown(&change.path)),
                    Some(lines) => {
                        if scans_skip_markers(&change.path) {
                            let markers = skip_markers_in(&change.path, lines);
                            if !markers.is_empty() {
                                found.skipped.push(format!("{}({})", shown(&change.path), markers.join(", ")));
                            }
                        }
                        if let Some(kind) = config_kind(&change.path) {
                            review_config(change, kind, lines, found);
                        }
                    }
                }
            }
            if reviewed {
                if let Some((added, removed)) = change.assertions {
                    if removed > added {
                        found.assertions.push(format!("{}(지움 {removed} · 더함 {added})", shown(&change.path)));
                    }
                }
            }
        }
        // 합치지 못한 변경이나 모르는 상태: 시험 파일이면 읽지 못한 것이다
        _ => {
            if is_reviewed_test_path(&change.path) || from_reviewed || is_snapshot_path(&change.path) || from_snapshot || config_kind(&change.path).is_some() {
                found.unknown.push(shown(&change.path));
            }
        }
    }
}

fn review_config(change: &Change, kind: ConfigKind, lines: &[String], found: &mut Findings) {
    let name = shown(&change.path);
    match config_markers_in(kind, lines, change.added_at.as_deref(), change.after.as_deref()) {
        Ok(labels) if !labels.is_empty() => found.excluded.push(format!("{name}({})", labels.join(", "))),
        Ok(_) => {}
        Err(reason) => found.unknown.push(format!("{name}: {}", shown(&reason))),
    }
    if kind == ConfigKind::Package {
        match change.after.as_deref() {
            None => found.unknown.push(format!("{name}: 바뀐 뒤 내용을 받지 못했습니다")),
            Some(after) => match weak_test_scripts(change.before.as_deref(), after) {
                Ok(weak) if !weak.is_empty() => found.scripts.push(format!("{name}({})", weak.join(", "))),
                Ok(_) => {}
                Err(reason) => found.unknown.push(format!("{name}: {}", shown(&reason))),
            },
        }
    }
}

fn summary(found: &Findings, with_unknown: bool) -> String {
    let mut parts = Vec::new();
    if !found.deleted.is_empty() {
        parts.push(format!("지운 시험 파일: {}", listed(&found.deleted)));
    }
    if !found.snapshots.is_empty() {
        parts.push(format!("지운 스냅샷 파일: {}", listed(&found.snapshots)));
    }
    if !found.configs.is_empty() {
        parts.push(format!("지운 시험 설정 파일: {}", listed(&found.configs)));
    }
    if !found.skipped.is_empty() {
        parts.push(format!("새로 더한 건너뛰기 표시: {}", listed(&found.skipped)));
    }
    if !found.excluded.is_empty() {
        parts.push(format!("시험 설정에 더한 시험 제외 표시: {}", listed(&found.excluded)));
    }
    if !found.scripts.is_empty() {
        parts.push(format!("약하게 바꾼 test 스크립트: {}", listed(&found.scripts)));
    }
    if !found.assertions.is_empty() {
        parts.push(format!("지운 단언이 더한 단언보다 많은 시험 파일: {}", listed(&found.assertions)));
    }
    if with_unknown && !found.unknown.is_empty() {
        parts.push(format!("변경 내용을 읽지 못해 확인하지 못함: {}", listed(&found.unknown)));
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
        let added_at = match item.prop("addedAt") {
            None | Some(JsValue::Null) => None,
            Some(JsValue::Arr(numbers)) => Some(
                numbers
                    .iter()
                    .map(|number| match number {
                        JsValue::Num(n) if n.fract() == 0.0 && *n >= 1.0 => Ok(*n as usize),
                        _ => Err("testChanges의 addedAt 항목은 1 이상의 정수여야 합니다".to_owned()),
                    })
                    .collect::<Result<Vec<_>, String>>()?,
            ),
            Some(_) => return Err("testChanges의 addedAt은 배열이어야 합니다".to_owned()),
        };
        let assertions = match item.prop("assertions") {
            None | Some(JsValue::Null) => None,
            Some(counts) => match (counts.prop("added"), counts.prop("removed")) {
                (Some(JsValue::Num(added)), Some(JsValue::Num(removed))) if added.fract() == 0.0 && removed.fract() == 0.0 && *added >= 0.0 && *removed >= 0.0 => Some((*added as usize, *removed as usize)),
                _ => return Err("testChanges의 assertions는 {added, removed}(0 이상의 정수)여야 합니다".to_owned()),
            },
        };
        let text = |key: &str| -> Result<Option<String>, String> {
            match item.prop(key) {
                None | Some(JsValue::Null) => Ok(None),
                Some(JsValue::Str(text)) => Ok(Some(text.clone())),
                Some(_) => Err(format!("testChanges의 {key}는 문자열이어야 합니다")),
            }
        };
        changes.push(Change { status: letter, path: string_of(item, "path")?, from, added, added_at, assertions, after: text("after")?, before: text("before")? });
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
            // 설정 파일은 종류를 함께 알린다: 바뀐 뒤 내용(`package.json`은 바뀌기 전 내용도)을 읽어야 하는 종류가 있다
            let kind = if scan { config_kind(&change.path) } else { None };
            js_json::object(vec![
                ("status", Some(JsValue::str(change.status.to_string()))),
                ("path", Some(JsValue::str(&change.path))),
                ("from", change.from.as_ref().map(JsValue::str)),
                ("scan", Some(JsValue::Bool(scan))),
                ("config", kind.map(|kind| JsValue::str(kind.name()))),
                ("needsAfter", Some(JsValue::Bool(kind.is_some_and(ConfigKind::needs_after)))),
                ("needsBefore", Some(JsValue::Bool(kind == Some(ConfigKind::Package)))),
            ])
        })
        .collect();
    Ok(js_json::to_native(&js_json::object(vec![("entries", Some(JsValue::Arr(entries)))])))
}

/// 패치 출력 → 파일별 `{added: string[], at: number[], assertionsAdded, assertionsRemoved}`
pub fn added_lines_json(patch: &str, expected: usize) -> Result<String, String> {
    let files = patches_by_file(patch, expected)?;
    let value = JsValue::Arr(
        files
            .into_iter()
            .map(|file| {
                js_json::object(vec![
                    ("added", Some(JsValue::Arr(file.added.into_iter().map(JsValue::Str).collect()))),
                    ("at", Some(JsValue::Arr(file.at.into_iter().map(|line| JsValue::Num(line as f64)).collect()))),
                    ("assertionsAdded", Some(JsValue::Num(file.assertions_added as f64))),
                    ("assertionsRemoved", Some(JsValue::Num(file.assertions_removed as f64))),
                ])
            })
            .collect(),
    );
    Ok(js_json::to_native(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(status: char, path: &str, from: Option<&str>, added: Option<&[&str]>) -> Change {
        Change { from: from.map(str::to_owned), added: added.map(|lines| lines.iter().map(|l| (*l).to_owned()).collect()), ..Change::bare(status, path) }
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
        let files = patches_by_file(patch, 3).unwrap();
        // 내용이 `++ two`인 줄(패치에는 `+++ two`)도 더해진 줄이다
        assert_eq!(files[0].added, vec!["one".to_owned(), "++ two".to_owned()]);
        assert_eq!(files[0].at, vec![2, 3]);
        assert!(files[1].added.is_empty());
        assert_eq!(files[2].added, vec!["it.skip('x')".to_owned()]);
        assert_eq!(files[2].at, vec![1]);
        assert!(patches_by_file(patch, 2).is_err());
        assert!(patches_by_file(patch, 4).is_err());
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

    // ── 이슈 #1451: 설정·스크립트·스냅샷·단언 ───────────────────────────────

    fn config_hits(path: &str, line: &str) -> Vec<&'static str> {
        let kind = config_kind(path).unwrap_or_else(|| panic!("설정 파일이 아님: {path}"));
        config_markers_in(kind, &lines(&[line]), None, None).unwrap_or_default()
    }

    #[test]
    fn 시험_설정_파일의_이름을_알아본다() {
        for (path, kind) in [
            ("vitest.config.ts", ConfigKind::Js),
            ("web/vitest.workspace.mts", ConfigKind::Js),
            ("jest.config.cjs", ConfigKind::Js),
            ("JEST.CONFIG.JS", ConfigKind::Js),
            ("jest.e2e.config.json", ConfigKind::Js),
            ("playwright.config.ts", ConfigKind::Js),
            ("vite.config.mjs", ConfigKind::Js),
            ("package.json", ConfigKind::Package),
            ("web\\package.json", ConfigKind::Package),
            ("pytest.ini", ConfigKind::Python),
            ("pyproject.toml", ConfigKind::Python),
            ("setup.cfg", ConfigKind::Python),
            ("tox.ini", ConfigKind::Python),
            ("tests/conftest.py", ConfigKind::Python),
            ("pom.xml", ConfigKind::Maven),
            ("build.gradle", ConfigKind::Gradle),
            ("app/build.gradle.kts", ConfigKind::Gradle),
        ] {
            assert_eq!(config_kind(path), Some(kind), "{path}");
        }
        for path in ["tsconfig.json", "package-lock.json", "src/config.ts", "vitest.config.ts.bak", "settings.gradle", "notes.md", "pom.xml.orig", "x-package.json"] {
            assert_eq!(config_kind(path), None, "{path}");
        }
    }

    #[test]
    fn 시험_설정의_표시는_줄마다_걸리는_줄과_안_걸리는_줄이_있다() {
        let hits: [(&str, &str); 30] = [
            ("vitest.config.ts", "    exclude: ['src/a.test.ts'],"),
            ("vitest.config.ts", "  exclude: ["),
            ("vitest.config.ts", "config.test.exclude = ['a']"),
            ("vitest.config.ts", "\"exclude\": [\"a\"]"),
            ("jest.config.js", "  testPathIgnorePatterns: ['/cart/'],"),
            ("jest.config.js", "  modulePathIgnorePatterns: ['<rootDir>/x'],"),
            ("playwright.config.ts", "  testIgnore: '**/cart.spec.ts',"),
            ("playwright.config.ts", "  grepInvert: /@slow/,"),
            ("vitest.config.ts", "    passWithNoTests: true,"),
            ("package.json", "  \"testPathIgnorePatterns\": [\"/cart/\"]"),
            ("package.json", "    \"modulePathIgnorePatterns\": []"),
            ("pytest.ini", "addopts = -q --ignore=tests/test_a.py"),
            ("pytest.ini", "addopts = --ignore-glob=tests/slow*"),
            ("pytest.ini", "addopts = --deselect tests/test_a.py::t"),
            ("tox.ini", "commands = pytest -k \"not cart\""),
            ("tox.ini", "commands = pytest -k 'not cart'"),
            ("setup.cfg", "addopts = -knot cart"),
            ("conftest.py", "collect_ignore = ['a.py']"),
            ("conftest.py", "collect_ignore_glob = ['x*']"),
            ("conftest.py", "    items[:] = [i for i in items if ok(i)]"),
            ("conftest.py", "    items.remove(item)"),
            ("pom.xml", "<exclude>**/Cart*</exclude>"),
            ("pom.xml", "<skipTests>true</skipTests>"),
            ("pom.xml", "<skip>true</skip>"),
            ("pom.xml", "<testFailureIgnore>true</testFailureIgnore>"),
            ("pom.xml", "mvn test -DskipTests"),
            ("build.gradle", "    exclude '**/Cart*'"),
            ("build.gradle.kts", "    exclude(\"**/Cart*\")"),
            ("build.gradle", "    enabled = false"),
            ("build.gradle.kts", "    filter { excludeTestsMatching(\"CartTest\") }"),
        ];
        for (path, line) in hits {
            assert!(!config_hits(path, line).is_empty(), "{path}: {line}");
        }
        let misses: [(&str, &str); 14] = [
            ("vitest.config.ts", "  resolve: { alias: { '@': '/src' } },"),
            ("vitest.config.ts", "  plugins: [react()],"),
            ("vitest.config.ts", "    environment: 'jsdom',"),
            ("jest.config.js", "  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },"),
            ("package.json", "  \"exclude\": [\"dist\"]"),
            ("package.json", "  \"lint\": \"eslint --ignore-pattern dist\""),
            ("pytest.ini", "addopts = -q --maxfail=2"),
            ("pytest.ini", "addopts = --keep-duplicates"),
            ("tox.ini", "commands = pytest -x -k smoke"),
            ("conftest.py", "@pytest.fixture"),
            ("pom.xml", "<excludes>"),
            ("pom.xml", "<dependency><artifactId>junit</artifactId></dependency>"),
            ("build.gradle", "    implementation('x:y:1') { exclude group: 'org.slf4j' }"),
            ("build.gradle.kts", "    implementation(\"x:y:1\") { exclude(group = \"org.slf4j\", module = \"a\") }"),
        ];
        for (path, line) in misses {
            assert!(config_hits(path, line).is_empty(), "{path}: {line}");
        }
    }

    #[test]
    fn pytest_collection_modifyitems는_건너뛰기와_함께_올_때만_센다() {
        // 파일 전체를 더한 것으로 둔다(줄 번호와 바뀐 뒤 파일이 맞는다)
        let hits = |items: &[&str]| {
            let added = lines(items);
            let at: Vec<usize> = (1..=added.len()).collect();
            config_markers_in(ConfigKind::Python, &added, Some(&at), Some(&items.join("\n"))).unwrap()
        };
        assert!(hits(&["def pytest_collection_modifyitems(config, items):", "    for item in items:", "        item.add_marker(skip)"]).contains(&"pytest_collection_modifyitems"));
        assert!(!hits(&["def pytest_collection_modifyitems(items):", "    config.hook.pytest_deselected(items=drop)"]).is_empty());
        assert!(hits(&["def pytest_collection_modifyitems(items):", "    items.sort(key=lambda i: i.name)"]).is_empty());
        // 건너뛰기만 있고 훅이 없으면 설정 표시로는 세지 않는다(conftest.py의 건너뛰기 표시는 따로 센다)
        assert!(hits(&["    pytest.skip('x')"]).is_empty());
        assert!(!skip_markers_in("conftest.py", &lines(&["    pytest.skip('x')"])).is_empty());
    }

    #[test]
    fn 표시가_붙은_배열_안에_더해진_줄도_센다() {
        let after = "export default {\n  test: {\n    exclude: [\n      'node_modules',\n      'src/cart.test.ts',\n    ],\n    setupFiles: [\n      'a.ts',\n    ],\n  },\n};\n";
        // 5번째 줄만 더했다(exclude 배열 안)
        let hit = config_markers_in(ConfigKind::Js, &lines(&["      'src/cart.test.ts',"]), Some(&[5]), Some(after)).unwrap();
        assert_eq!(hit, vec!["exclude"]);
        // 8번째 줄(setupFiles 배열 안)은 걸리지 않는다
        assert!(config_markers_in(ConfigKind::Js, &lines(&["      'a.ts',"]), Some(&[8]), Some(after)).unwrap().is_empty());
        // 파일과 줄 번호가 맞지 않으면 통과가 아니라 던진다
        assert!(config_markers_in(ConfigKind::Js, &lines(&["      'zzz',"]), Some(&[5]), Some(after)).is_err());
        assert!(config_markers_in(ConfigKind::Js, &lines(&["      'a.ts',"]), Some(&[99]), Some(after)).is_err());
        // 바뀐 뒤 파일이나 줄 번호가 없으면 던진다
        assert!(config_markers_in(ConfigKind::Js, &lines(&["      'a.ts',"]), None, None).is_err());
        // TOML·conftest의 배열
        let toml = "[tool.pytest.ini_options]\naddopts = \"-q\"\n[tool.x]\ncollect_ignore = [\n  \"a.py\",\n  \"b.py\",\n]\n";
        assert_eq!(config_markers_in(ConfigKind::Python, &lines(&["  \"b.py\","]), Some(&[6]), Some(toml)).unwrap(), vec!["collect_ignore"]);
        // CRLF 파일
        let crlf = "a: {\r\n  exclude: [\r\n    'x',\r\n  ],\r\n}\r\n";
        assert_eq!(config_markers_in(ConfigKind::Js, &lines(&["    'x',"]), Some(&[3]), Some(crlf)).unwrap(), vec!["exclude"]);
    }

    #[test]
    fn 스크립트의_약한_모양을_가른다() {
        for script in [
            "",
            "   ",
            "vitest run || true",
            "vitest run ||true",
            "jest || exit 0",
            "jest || :",
            "jest || echo ok",
            "vitest run; exit 0",
            "vitest run ; true",
            "vitest run --passWithNoTests",
            "jest --pass-with-no-tests",
            "echo \"skipped\"",
            "echo skipped && exit 0",
            "true",
            ":",
            "exit 0",
            "echo \"a && b\"",
            "vitest run --exclude src/a.test.ts",
            "jest --testPathIgnorePatterns cart",
            "pytest --ignore=tests/a",
            "pytest --deselect tests/a::t",
            "pytest -k \"not cart\"",
            "mvn test -DskipTests",
            "cargo test --no-run",
        ] {
            assert!(!weak_script_labels(script).is_empty(), "{script:?}");
        }
        for script in [
            "vitest run",
            "vitest run --coverage",
            "echo \"Error: no test specified\" && exit 1",
            "echo x; exit 1",
            "jest --ci && echo done",
            "node scripts/check.js || exit 1",
            "pytest -k smoke",
            "pytest -x --maxfail=2",
            "turbo run test",
            "vitest run && echo true",
        ] {
            assert!(weak_script_labels(script).is_empty(), "{script:?}: {:?}", weak_script_labels(script));
        }
    }

    #[test]
    fn package_json은_전후를_견줘_새로_약해진_것만_센다() {
        let before = r#"{"name":"x","scripts":{"test":"vitest run","test:e2e":"playwright test","lint":"eslint ."}}"#;
        // 새로 약해짐
        assert_eq!(weak_test_scripts(Some(before), r#"{"scripts":{"test":"vitest run || true","test:e2e":"playwright test","lint":"eslint ."}}"#).unwrap(), vec!["scripts.test(|| true 꼴(실패를 삼킴))"]);
        // 한 줄로 이어 쓴 파일, 줄 순서가 바뀐 파일도 같다
        assert!(!weak_test_scripts(Some(before), r#"{"scripts":{"lint":"eslint .","test:e2e":"playwright test","test":""}}"#).unwrap().is_empty());
        // 지움
        assert_eq!(weak_test_scripts(Some(before), r#"{"scripts":{"test":"vitest run","lint":"eslint ."}}"#).unwrap(), vec!["scripts.test:e2e(지움)"]);
        assert_eq!(weak_test_scripts(Some(before), r#"{"name":"x"}"#).unwrap().len(), 2);
        // 새 파일의 약한 스크립트(기준 없음)
        assert!(!weak_test_scripts(None, r#"{"scripts":{"test":"echo ok"}}"#).unwrap().is_empty());
        // 원래 약했고 그대로: 세지 않는다. 다른 약한 모양을 더하면 센다
        let weak = r#"{"scripts":{"test":"vitest run --passWithNoTests"}}"#;
        assert!(weak_test_scripts(Some(weak), weak).unwrap().is_empty());
        assert!(weak_test_scripts(Some(weak), r#"{"scripts":{"test":"vitest run --passWithNoTests || true"}}"#).unwrap().len() == 1);
        // test가 아닌 스크립트나 scripts 밖의 변경은 보지 않는다
        assert!(weak_test_scripts(Some(before), r#"{"scripts":{"test":"vitest run","test:e2e":"playwright test","lint":"eslint . || true"},"version":"2"}"#).unwrap().is_empty());
        // 읽지 못하면 던진다. 바뀌기 전을 읽지 못하면 기준이 없는 것이다
        assert!(weak_test_scripts(Some(before), "{ \"scripts\": ").is_err());
        assert!(weak_test_scripts(Some(before), "[1]").is_err());
        assert!(!weak_test_scripts(Some("{broken"), r#"{"scripts":{"test":"true"}}"#).unwrap().is_empty());
    }

    #[test]
    fn 스냅샷_파일_모양을_넓게_맞춘다() {
        for path in ["a.test.ts.snap", "src/__snapshots__/a.test.ts.snap", "src/__snapshots__/anything.txt", "tests/__snapshots__/test_a.ambr", "SRC/__SNAPSHOTS__/A.SNAP", "x\\__snapshots__\\a.txt", "a.ambr"] {
            assert!(is_snapshot_path(path), "{path}");
        }
        for path in ["src/a.test.ts", "snapshots/a.txt", "src/__snapshot__/a.txt", "notes/snap.md", "a.snapshot"] {
            assert!(!is_snapshot_path(path), "{path}");
        }
    }

    #[test]
    fn 스냅샷을_지우거나_다른_이름으로_옮기면_걸린다() {
        let deleted = review_test_changes(&[change('D', "src/__snapshots__/a.test.ts.snap", None, None)], false, None).unwrap();
        assert!(!deleted.ok);
        assert!(deleted.detail.unwrap().contains("지운 스냅샷 파일: src/__snapshots__/a.test.ts.snap"));
        let moved_away = review_test_changes(&[change('R', "a.bak", Some("src/__snapshots__/a.snap"), None)], false, None).unwrap();
        assert!(!moved_away.ok);
        // 스냅샷 이름 사이의 이동, 고치기, 새로 만들기는 통과
        assert!(review_test_changes(&[change('R', "src/__snapshots__/old/a.snap", Some("src/__snapshots__/a.snap"), None)], false, None).is_none());
        assert!(review_test_changes(&[change('M', "src/__snapshots__/a.snap", None, None), change('A', "b.snap", None, None)], false, None).is_none());
        // 허용이 있으면 통과하고 남긴다
        let allowed = review_test_changes(&[change('D', "a.snap", None, None)], true, None).unwrap();
        assert!(allowed.ok && allowed.detail.unwrap().contains("a.snap"));
    }

    #[test]
    fn 단언_수를_센다() {
        for (line, count) in [
            ("expect(a).toBe(1);", 1),
            ("expect(a).toBe(1); expect(b).toBe(2);", 2),
            ("  assert a == 1", 1),
            ("self.assertEqual(a, 1)", 1),
            ("assertEquals(1, a);", 1),
            ("assertThat(a).isEqualTo(1);", 1),
            ("Assertions.assertTrue(x);", 1),
            ("t.Errorf(\"x\")", 1),
            ("require.Equal(t, 1, a)", 1),
            ("assert_eq!(a, 1);", 1),
            ("assert!(ok);", 1),
            ("with pytest.raises(ValueError):", 1),
            ("const x = 1;", 0),
            ("// expect(a).toBe(1);", 0),
            ("  /* expect(a) */", 0),
            ("  * assertEquals(1, 1)", 0),
            ("# assert x", 0),
            ("const inspect = a;", 0),
        ] {
            assert_eq!(assertions_in(line), count, "{line}");
        }
    }

    #[test]
    fn 지운_단언이_더한_단언보다_많은_시험_파일만_걸린다() {
        let mut fewer = change('M', "a.test.ts", None, Some(&[]));
        fewer.assertions = Some((1, 3));
        let check = review_test_changes(&[fewer.clone()], false, None).unwrap();
        assert!(!check.ok);
        assert!(check.detail.unwrap().contains("지운 단언이 더한 단언보다 많은 시험 파일: a.test.ts(지움 3 · 더함 1)"));
        // 같거나 더 많이 더했으면(바꾸기) 통과
        for counts in [(3, 3), (1, 1), (5, 3), (0, 0)] {
            let mut same = fewer.clone();
            same.assertions = Some(counts);
            assert!(review_test_changes(&[same], false, None).is_none(), "{counts:?}");
        }
        // 지운 단언이 없으면 수를 받지 않는다(None)
        assert!(review_test_changes(&[change('M', "a.test.ts", None, Some(&[]))], false, None).is_none());
        // 시험 파일이 아니면 보지 않는다. Rust 소스 파일도 시험 파일 모양이 아니면 보지 않는다
        for path in ["src/app.ts", "src/lib.rs"] {
            let mut other = change('M', path, None, Some(&[]));
            other.assertions = Some((0, 5));
            assert!(review_test_changes(&[other], false, None).is_none(), "{path}");
        }
        // 이름 바꾸기 도중의 줄임도 센다
        let mut renamed = change('R', "b.test.ts", Some("a.test.ts"), Some(&[]));
        renamed.assertions = Some((0, 2));
        assert!(review_test_changes(&[renamed], false, None).is_some());
        // 허용이 있으면 통과하고 남긴다
        let allowed = review_test_changes(&[fewer], true, None).unwrap();
        assert!(allowed.ok && allowed.detail.unwrap().contains("a.test.ts"));
    }

    #[test]
    fn 패치에서_단언_수와_줄_번호를_읽는다() {
        let patch = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -3,2 +3,1 @@\n-  expect(a).toBe(1);\n-  expect(b).toBe(2);\n+  expect(c).toBe(3);\n@@ -9 +8,2 @@\n-  assert x\n+  // expect(x)\n+  y = 1\n";
        let file = &patches_by_file(patch, 1).unwrap()[0];
        assert_eq!((file.assertions_removed, file.assertions_added), (3, 1));
        assert_eq!(file.at, vec![3, 8, 9]);
        assert!(patches_by_file("diff --git a/a b/a\n@@ garbage @@\n+x\n", 1).is_err());
    }

    #[test]
    fn 설정_파일은_읽지_못했으면_확인하지_못함이다() {
        // 줄을 받지 못함
        let check = review_test_changes(&[change('M', "vitest.config.ts", None, None)], false, None).unwrap();
        assert!(!check.ok && check.detail.unwrap().contains("확인하지 못함: vitest.config.ts"));
        // 줄은 있지만 바뀐 뒤 파일이 없어 배열 안의 줄인지 모른다
        let check = review_test_changes(&[change('M', "vitest.config.ts", None, Some(&["  alias: 1,"]))], false, None).unwrap();
        assert!(!check.ok && check.detail.unwrap().contains("확인하지 못함: vitest.config.ts"));
        // package.json은 바뀐 뒤 내용이 있어야 한다
        let check = review_test_changes(&[change('M', "package.json", None, Some(&[]))], false, None).unwrap();
        assert!(!check.ok && check.detail.unwrap().contains("바뀐 뒤 내용을 받지 못했습니다"));
        // 깨진 package.json
        let mut broken = change('M', "package.json", None, Some(&[]));
        broken.after = Some("{ \"scripts\": ".to_owned());
        broken.added_at = Some(vec![]);
        let check = review_test_changes(&[broken], false, None).unwrap();
        assert!(!check.ok && check.detail.unwrap().contains("package.json을 읽지 못했습니다"));
        // 허용이 있으면 읽지 못한 것은 막지 않는다
        assert!(review_test_changes(&[change('M', "vitest.config.ts", None, None)], true, None).is_none());
        // Maven·Gradle은 바뀐 뒤 파일 없이 줄만으로 본다
        let maven = review_test_changes(&[change('M', "pom.xml", None, Some(&["<skipTests>true</skipTests>"]))], false, None).unwrap();
        assert!(!maven.ok && maven.detail.unwrap().contains("pom.xml(<skipTests>)"));
    }

    #[test]
    fn 설정_변경의_json_입력을_읽는다() {
        let input = js_json::parse_native(
            "{\"entries\":[{\"status\":\"M\",\"path\":\"package.json\",\"added\":[\"  \\\"test\\\": \\\"x || true\\\"\"],\"addedAt\":[3],\"after\":\"{\\n\\\"scripts\\\":{\\n  \\\"test\\\": \\\"x || true\\\"\\n}}\",\"before\":\"{\\\"scripts\\\":{\\\"test\\\":\\\"x\\\"}}\"}]}",
        )
        .unwrap();
        let check = review_from_value(&input).unwrap().unwrap();
        assert!(!check.ok && check.detail.unwrap().contains("약하게 바꾼 test 스크립트: package.json(scripts.test("));
        for bad in [
            "{\"entries\":[{\"status\":\"M\",\"path\":\"a\",\"addedAt\":[0]}]}",
            "{\"entries\":[{\"status\":\"M\",\"path\":\"a\",\"addedAt\":{}}]}",
            "{\"entries\":[{\"status\":\"M\",\"path\":\"a\",\"assertions\":{\"added\":1}}]}",
            "{\"entries\":[{\"status\":\"M\",\"path\":\"a\",\"after\":3}]}",
        ] {
            assert!(review_from_value(&js_json::parse_native(bad).unwrap()).is_err(), "{bad}");
        }
    }

    // ── 커밋 보안 검토 지적 ──────────────────────────────────────────────

    #[test]
    fn gradle의_의존성_예외는_줄_전체가_의존성_exclude_문일_때만_적용한다() {
        for line in [
            "    exclude '**/ //x/*Test*'",
            "    exclude group: 'a'; label = ' //'; exclude '**/Slow*'",
            "    exclude(group = \"a\"); println(\"x //\"); exclude(\"**/Slow*\")",
            "    exclude \"a\" // 설명 exclude group: 'x'",
            "    exclude '**/ //Slow*'; exclude group: 'a'",
            "    exclude '**/OrderTest*'  // exclude group: 'x'",
            "test { exclude '**/Slow*' }; exclude(group = \"a\")",
            "    exclude '**/Slow*'; exclude group: 'a'",
            "    exclude(\"**/Slow*\") /* exclude group: 'x' */ ; exclude module: 'y'",
        ] {
            assert!(!config_hits("build.gradle", line).is_empty(), "{line}");
        }
        // 주석 안에 따로 `exclude '…'`가 있으면 원래 줄에서 걸린다(넓은 쪽: 주석인지 문자열인지 따옴표를 추적하지 않는다)
        assert!(!config_hits("build.gradle", "    exclude group: 'a'  // exclude 'x' 설명").is_empty());
        for line in [
            "    exclude group: 'org.slf4j'",
            "    implementation('x:y:1') { exclude group: 'org.slf4j' }",
            "    implementation(\"x:y:1\") { exclude(group = \"a\", module = \"b\") }  // 설명",
        ] {
            assert!(config_hits("build.gradle.kts", line).is_empty(), "{line}");
        }
    }

    fn py_hits_in(path: &str, after: &str, numbers: &[usize]) -> Vec<&'static str> {
        let all: Vec<&str> = after.split('\n').collect();
        let added: Vec<String> = numbers.iter().map(|n| all[n - 1].to_owned()).collect();
        config_markers_in(config_kind(path).unwrap(), &added, Some(numbers), Some(after)).unwrap()
    }

    #[test]
    fn pytest_addopts의_나눠_쓴_인자도_걸린다() {
        // pyproject의 배열: 인자를 다른 줄에 둔다
        let toml = "[tool.pytest.ini_options]\naddopts = [\n  \"-q\",\n  \"-k\",\n  \"not slow\",\n]\n";
        assert!(!py_hits_in("pyproject.toml", toml, &[4, 5]).is_empty());
        assert!(!py_hits_in("pyproject.toml", toml, &[5]).is_empty());
        // 들여쓰지 않은 배열 항목(이어진 줄 규칙이 아니라 배열 안의 줄 규칙으로 걸린다)
        let flat = "[tool.pytest.ini_options]\naddopts = [\n\"-q\",\n\"-k\",\n\"not slow\",\n]\n";
        assert!(!py_hits_in("pyproject.toml", flat, &[4]).is_empty());
        // 한 줄 배열
        assert!(!py_hits_in("pyproject.toml", "addopts = [\"-k\", \"not slow\"]\n", &[1]).is_empty());
        assert!(!py_hits_in("pyproject.toml", "addopts = [\"--deselect\", \"tests/a.py::t\"]\n", &[1]).is_empty());
        // ini의 이어진 줄
        let ini = "[pytest]\naddopts =\n    -q\n    --deselect\n    tests/a.py::t\n";
        assert!(!py_hits_in("pytest.ini", ini, &[5]).is_empty());
        let cfg = "[tool:pytest]\naddopts = -q\n    -k\n    not slow\n[other]\nx = 1\n    y\n";
        assert!(!py_hits_in("setup.cfg", cfg, &[4]).is_empty());
        // addopts가 아닌 이어진 줄이나 다른 절의 줄은 걸리지 않는다
        assert!(py_hits_in("setup.cfg", cfg, &[7]).is_empty());
        assert!(py_hits_in("pyproject.toml", "[tool.x]\nitems = [\n  \"-q\",\n]\n", &[3]).is_empty());
    }

    #[test]
    fn 시험_설정_파일을_지우거나_종류를_바꾸거나_설정이_아닌_이름으로_옮기면_걸린다() {
        for path in ["package.json", "pytest.ini", "conftest.py", "jest.config.ts", "pom.xml", "build.gradle", "web/vitest.config.mts"] {
            let check = review_test_changes(&[change('D', path, None, None)], false, None).unwrap();
            assert!(!check.ok, "{path}");
            assert!(check.detail.unwrap().contains(&format!("지운 시험 설정 파일: {path}")));
            assert!(review_test_changes(&[change('T', path, None, None)], false, None).is_some(), "T {path}");
        }
        let moved = review_test_changes(&[change('R', "package.json.bak", Some("package.json"), Some(&[]))], false, None).unwrap();
        assert!(!moved.ok && moved.detail.unwrap().contains("package.json → package.json.bak"));
        assert!(review_test_changes(&[change('R', "x/old.ini", Some("pytest.ini"), Some(&[]))], false, None).is_some());
        // 설정 파일을 어디로 옮기든(같은 종류의 이름, 다른 폴더, 대소문자만 다른 이름) 원래 프로젝트에는 더는 적용되지 않는다
        for (to, from) in [("pyproject.toml", "pytest.ini"), ("sub/pytest.ini", "pytest.ini"), ("web/jest.config.js", "jest.config.js"), ("PYTEST.INI", "pytest.ini")] {
            let check = review_test_changes(&[change('R', to, Some(from), Some(&[]))], false, None).unwrap();
            assert!(check.detail.unwrap().contains(&format!("{from} → {to}")), "{from} → {to}");
        }
        // 설정이 아닌 파일의 삭제, 허용이 있는 삭제
        assert!(review_test_changes(&[change('D', "src/app.ts", None, None)], false, None).is_none());
        let allowed = review_test_changes(&[change('D', "package.json", None, None)], true, None).unwrap();
        assert!(allowed.ok && allowed.detail.unwrap().contains("package.json"));
    }
}
