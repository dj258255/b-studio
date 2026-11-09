//! 테스트 탭의 실행 단계 판정(ADR-191 3단계 3d). 옛 `packages/agent/src/test-run.ts`와 같은 입력에 같은 글자를 낸다.
//!
//! 템플릿·실행기에 맞는 테스트 명령, 보고서를 모아 오는 `sh -c` 명령, 모은 출력을 파일별로 나누는 규칙, 실행기 판별을 담는다.
//! 순수 함수만 있다(샌드박스 호출 없음). 명령 글자(셸 인용 포함)는 옛 TS와 한 글자도 다르면 안 된다.
//!
//! 의도한 차이(모두 던지거나 자기 값만 보는 쪽):
//! - 알 수 없는 실행기 이름은 던진다(옛 TS는 `undefined`를 돌려줬다. 타입이 다섯 값으로 좁힌다).
//! - 문자열이 아닌 값(`extraReportRoots`의 수 등)은 던진다(옛 TS는 문자열로 바꿔 이어 붙였다).
//! - 짝 없는 서로게이트는 U+FFFD로 읽는다(Node 경계 규칙, js_json 참고).

use crate::js;
use crate::js_json::{self, JsValue};

/// 컨테이너 안 임시 보고서 경로. 서비스 소스 트리 밖(/tmp)이라 다른 파일과 부딪히지 않는다
pub const JEST_LIKE_REPORT_PATH: &str = "/tmp/b-studio-test-report.json";
pub const PYTEST_REPORT_PATH: &str = "/tmp/b-studio-test-report.xml";
/// 서비스 컨테이너 안에서 프로젝트 루트를 마운트한 자리. studio의 `CONTAINER_WORKSPACE_ROOT`와 같아야 한다
pub const CONTAINER_PROJECT_ROOT: &str = "/workspace";
const GRADLE_REPORT_GLOB: &str = "build/test-results/test/*.xml";
const MAVEN_REPORT_GLOB: &str = "target/surefire-reports/*.xml";
/// 여러 보고서 파일을 한 번의 exec로 모아올 때 경계로 쓰는 표지
const REPORT_BOUNDARY: &str = "@@@b-studio-test-report@@@";

pub struct TestRunPlan {
    pub command: Vec<String>,
    pub collect: Vec<String>,
    pub format: &'static str,
}

impl TestRunPlan {
    /// `JSON.stringify`한 글자(키 순서: command, collect, format)
    pub fn to_json(&self) -> String {
        let strings = |items: &[String]| JsValue::Arr(items.iter().map(|s| JsValue::str(s.clone())).collect());
        js_json::stringify(&js_json::object(vec![
            ("command", Some(strings(&self.command))),
            ("collect", Some(strings(&self.collect))),
            ("format", Some(JsValue::str(self.format))),
        ]))
    }
}

/// glob 여러 개를 한 번의 exec로 모두 모은다
fn collect_glob_command(glob_exprs: &[String]) -> Vec<String> {
    let body = glob_exprs
        .iter()
        .map(|glob| format!("for f in {glob}; do [ -f \"$f\" ] && {{ echo '{REPORT_BOUNDARY}'\"$f\"; cat \"$f\"; echo; }}; done"))
        .collect::<Vec<_>>()
        .join("; ");
    vec!["sh".to_owned(), "-c".to_owned(), body]
}

/// `extraReportRoots`(studio.yaml의 includes)는 모델이 고칠 수 있는 값이라 `sh -c` 문자열에 그대로 넣으면 임의 명령 통로가 된다.
/// 영문·숫자·`.`·`_`·`-`·`/`만 받는다(집합에 `'`가 없어 따옴표를 깨고 나올 수 없다). 집합 밖 문자가 섞인 값은 조용히 버린다.
/// 막는 쪽이다: 모르는 입력은 버린다(허용 목록이라 넓게 맞추지 않는다 — 글자 하나하나를 ASCII로만 본다)
fn is_safe_report_root(root: &str) -> bool {
    !root.is_empty() && root.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

/// pattern(상수 glob)과, 있으면 extraReportRoots 각각을 작은따옴표로 감싼 glob 식 목록
fn report_glob_exprs(pattern: &str, extra_report_roots: &[String]) -> Vec<String> {
    let mut out = vec![pattern.to_owned()];
    out.extend(extra_report_roots.iter().filter(|root| is_safe_report_root(root)).map(|root| format!("'{root}'/{pattern}")));
    out
}

/// 빈 문자열은 없는 것과 같다(`if (target?.className)`)
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// runner·대상에 맞는 테스트 실행 명령과 보고서 수거 명령. `wrapper`는 서비스 폴더에 Gradle·Maven 래퍼가 있는지다
pub fn build_test_run_plan(
    runner: &str,
    file: Option<&str>,
    class_name: Option<&str>,
    test_name: Option<&str>,
    wrapper: Option<bool>,
    extra_report_roots: &[String],
) -> Result<TestRunPlan, String> {
    let (file, class_name, test_name) = (non_empty(file), non_empty(class_name), non_empty(test_name));
    let s = |text: &str| text.to_owned();
    match runner {
        "gradle" => {
            let mut command = vec![s(if wrapper == Some(false) { "gradle" } else { "./gradlew" }), s("test"), s("--no-daemon"), s("--console=plain")];
            if let Some(class_name) = class_name {
                command.push(s("--tests"));
                command.push(match test_name {
                    Some(test_name) => format!("{class_name}.{test_name}"),
                    None => s(class_name),
                });
            }
            Ok(TestRunPlan { command, collect: collect_glob_command(&report_glob_exprs(GRADLE_REPORT_GLOB, extra_report_roots)), format: "junit-xml" })
        }
        "maven" => {
            let mut command = vec![s(if wrapper == Some(true) { "./mvnw" } else { "mvn" }), s("-q"), s("test")];
            if let Some(class_name) = class_name {
                command.push(match test_name {
                    Some(test_name) => format!("-Dtest={class_name}#{test_name}"),
                    None => format!("-Dtest={class_name}"),
                });
            }
            Ok(TestRunPlan { command, collect: collect_glob_command(&report_glob_exprs(MAVEN_REPORT_GLOB, extra_report_roots)), format: "junit-xml" })
        }
        "vitest" | "jest" => {
            let mut command = if runner == "vitest" {
                vec![s("npx"), s("vitest"), s("run"), s("--reporter=json"), format!("--outputFile={JEST_LIKE_REPORT_PATH}")]
            } else {
                vec![s("npx"), s("jest"), s("--json"), format!("--outputFile={JEST_LIKE_REPORT_PATH}")]
            };
            if let Some(file) = file {
                command.push(s(file));
            }
            if let Some(test_name) = test_name {
                command.push(s("-t"));
                command.push(s(test_name));
            }
            Ok(TestRunPlan { command, collect: vec![s("cat"), s(JEST_LIKE_REPORT_PATH)], format: "jest-json" })
        }
        "pytest" => {
            let mut command = vec![s("pytest"), format!("--junitxml={PYTEST_REPORT_PATH}")];
            if let Some(file) = file {
                command.push(match test_name {
                    Some(test_name) => match class_name {
                        Some(class_name) => format!("{file}::{class_name}::{test_name}"),
                        None => format!("{file}::{test_name}"),
                    },
                    None => s(file),
                });
            }
            Ok(TestRunPlan { command, collect: vec![s("cat"), s(PYTEST_REPORT_PATH)], format: "junit-xml" })
        }
        other => Err(format!("알 수 없는 실행기입니다: {other}")),
    }
}

/// 서비스의 `includes`를 컨테이너 안 보고서 경로의 뿌리로 바꾼다
pub fn report_roots_for_includes(includes: &[String], root: &str) -> Vec<String> {
    includes.iter().map(|include| format!("{root}/{include}")).collect()
}

/// `collect`가 읽는 보고서 자리를 실행기와 상관없이 모두 지우는 명령(#756)
pub fn clear_test_reports_command(extra_report_roots: &[String]) -> Vec<String> {
    let globs: Vec<String> = [GRADLE_REPORT_GLOB, MAVEN_REPORT_GLOB].iter().flat_map(|pattern| report_glob_exprs(pattern, extra_report_roots)).collect();
    let targets: Vec<String> = [JEST_LIKE_REPORT_PATH.to_owned(), PYTEST_REPORT_PATH.to_owned()].into_iter().chain(globs).collect();
    vec!["sh".to_owned(), "-c".to_owned(), format!("rm -f {}", targets.join(" "))]
}

/// `collectGlobCommand`의 stdout을 파일별로 나눈다. 경계 표지가 없으면(단일 cat 결과) 파일 하나로 본다.
///
/// 옛 정규식은 `표지(.*)\n`(g)였다. `.`는 줄 끝 글자를 맞추지 않으므로 표지 뒤 첫 줄 끝 글자가 `\n`일 때만 맞는다
/// (`\r`·U+2028·U+2029가 먼저 오거나 줄 끝이 없으면 그 표지는 맞지 않고, 다음 표지는 한 글자 뒤부터 다시 찾는다)
pub fn split_collected_reports(stdout: &str, single_file_label: &str) -> Vec<(String, String)> {
    if !stdout.contains(REPORT_BOUNDARY) {
        let trimmed = js::trim(stdout);
        return if trimmed.is_empty() { Vec::new() } else { vec![(single_file_label.to_owned(), trimmed.to_owned())] };
    }
    // (표지 시작, 맞음 끝, 표지 뒤 글자)
    let mut found: Vec<(usize, usize, &str)> = Vec::new();
    let mut from = 0;
    while let Some(offset) = stdout[from..].find(REPORT_BOUNDARY) {
        let start = from + offset;
        let after = start + REPORT_BOUNDARY.len();
        match stdout[after..].find(js::is_js_line_terminator) {
            Some(rel) if stdout.as_bytes()[after + rel] == b'\n' => {
                found.push((start, after + rel + 1, &stdout[after..after + rel]));
                from = after + rel + 1;
            }
            _ => from = start + 1,
        }
    }
    let mut parts = Vec::with_capacity(found.len());
    for (i, (_, end_of_match, label)) in found.iter().enumerate() {
        let end = found.get(i + 1).map_or(stdout.len(), |next| next.0);
        parts.push((js::trim(label).to_owned(), js::trim(&stdout[*end_of_match..end]).to_owned()));
    }
    parts
}

/// 보고서 분리 결과를 `JSON.stringify`한 글자(`[{file, content}]`)로
pub fn reports_to_json(parts: &[(String, String)]) -> String {
    js_json::stringify(&JsValue::Arr(
        parts.iter().map(|(file, content)| js_json::object(vec![("file", Some(JsValue::str(file.clone()))), ("content", Some(JsValue::str(content.clone())))])).collect(),
    ))
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// JS `/\bword\b/.test(text)`(`\b`의 단어 글자는 ASCII 영문·숫자·`_`뿐이다)
fn has_word(text: &str, word: &str) -> bool {
    let bytes = text.as_bytes();
    text.match_indices(word).any(|(i, _)| {
        let before_ok = i == 0 || !is_word_byte(bytes[i - 1]);
        let after = i + word.len();
        before_ok && (after >= bytes.len() || !is_word_byte(bytes[after]))
    })
}

/// `{...dependencies, ...devDependencies}[name]`의 진릿값. 객체가 아닌 값은 펼쳐도 그 이름의 키를 만들지 못하고,
/// 뒤의 `devDependencies`에 그 키가 있으면(값이 거짓이어도) 앞의 값을 덮는다
fn dependency_truthy(package_json: Option<&JsValue>, name: &str) -> bool {
    let own = |field: &str| match package_json.and_then(|p| p.prop(field)) {
        Some(JsValue::Obj(o)) => o.get(name),
        _ => None,
    };
    match own("devDependencies").or_else(|| own("dependencies")) {
        Some(value) => value.truthy(),
        None => false,
    }
}

/// studio.yaml의 template과 서비스 폴더 힌트(package.json, pom.xml 유무)로 실행기를 고른다. 판별 못 하면 None.
/// `package_json`은 `JSON.parse`한 값이다(모양이 어긋나도 읽는다: 객체가 아니면 없는 것과 같다)
pub fn detect_runner(template: &str, has_pom_xml: bool, package_json: Option<&JsValue>) -> Option<&'static str> {
    let template = template.to_lowercase();
    if template.contains("spring") {
        return Some(if has_pom_xml { "maven" } else { "gradle" });
    }
    if ["fastapi", "python", "django", "flask"].iter().any(|word| template.contains(word)) {
        return Some("pytest");
    }
    if ["next", "vite", "react", "node"].iter().any(|word| template.contains(word)) {
        if dependency_truthy(package_json, "vitest") {
            return Some("vitest");
        }
        if dependency_truthy(package_json, "jest") {
            return Some("jest");
        }
        let test_script = match package_json.and_then(|p| p.prop("scripts")) {
            Some(JsValue::Obj(scripts)) => match scripts.get("test") {
                Some(JsValue::Null) | None => String::new(),
                Some(value) => value.to_js_string(),
            },
            _ => String::new(),
        };
        if has_word(&test_script, "vitest") {
            return Some("vitest");
        }
        if has_word(&test_script, "jest") {
            return Some("jest");
        }
        return None;
    }
    None
}

pub fn runner_label(runner: &str) -> Result<&'static str, String> {
    match runner {
        "gradle" => Ok("Gradle (JUnit)"),
        "maven" => Ok("Maven (JUnit)"),
        "vitest" => Ok("Vitest"),
        "jest" => Ok("Jest"),
        "pytest" => Ok("pytest"),
        other => Err(format!("알 수 없는 실행기입니다: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(runner: &str, file: Option<&str>, class: Option<&str>, name: Option<&str>, wrapper: Option<bool>, roots: &[&str]) -> TestRunPlan {
        let roots: Vec<String> = roots.iter().map(|r| (*r).to_owned()).collect();
        build_test_run_plan(runner, file, class, name, wrapper, &roots).unwrap()
    }

    #[test]
    fn gradle_명령과_수거_명령() {
        let p = plan("gradle", None, Some("com.example.A"), Some("m"), None, &[]);
        assert_eq!(p.command, ["./gradlew", "test", "--no-daemon", "--console=plain", "--tests", "com.example.A.m"]);
        assert_eq!(p.collect[0], "sh");
        assert_eq!(p.collect[2], "for f in build/test-results/test/*.xml; do [ -f \"$f\" ] && { echo '@@@b-studio-test-report@@@'\"$f\"; cat \"$f\"; echo; }; done");
        assert_eq!(plan("gradle", None, None, None, Some(false), &[]).command[0], "gradle");
        assert_eq!(plan("gradle", None, None, None, Some(true), &[]).command[0], "./gradlew");
    }

    #[test]
    fn 허용_문자_밖의_보고서_뿌리는_버리고_나머지는_따옴표로_감싼다() {
        let p = plan("maven", None, Some("T"), None, Some(true), &["a/b", "x; rm -rf /", "k'k", "", "한글", "a b", "a\n"]);
        assert_eq!(p.command, ["./mvnw", "-q", "test", "-Dtest=T"]);
        assert_eq!(p.collect[2].matches("for f in").count(), 2);
        assert!(p.collect[2].contains("for f in 'a/b'/target/surefire-reports/*.xml;"));
        assert!(!p.collect[2].contains("rm -rf"));
    }

    #[test]
    fn 지우는_명령() {
        let cmd = clear_test_reports_command(&["m".to_owned(), "m;x".to_owned()]);
        assert_eq!(cmd[2], "rm -f /tmp/b-studio-test-report.json /tmp/b-studio-test-report.xml build/test-results/test/*.xml 'm'/build/test-results/test/*.xml target/surefire-reports/*.xml 'm'/target/surefire-reports/*.xml");
    }

    #[test]
    fn 표지_뒤_첫_줄_끝이_줄바꿈일_때만_맞는다() {
        let b = REPORT_BOUNDARY;
        let one = split_collected_reports(&format!("{b}a.xml\n<x/>\n\n{b}b.xml\n<y/>\n"), "report");
        assert_eq!(one, vec![("a.xml".to_owned(), "<x/>".to_owned()), ("b.xml".to_owned(), "<y/>".to_owned())]);
        // \r이 먼저 오면 그 표지는 맞지 않는다
        assert_eq!(split_collected_reports(&format!("{b}a.xml\r\nbody\n"), "report"), Vec::<(String, String)>::new());
        // 표지 바로 뒤에 표지가 오면 앞 표지의 "표지 뒤 글자"에 들어간다(정규식은 맞은 끝에서 다시 찾는다)
        assert_eq!(split_collected_reports(&format!("{b}{b}z\nq"), "report"), vec![(format!("{b}z"), "q".to_owned())]);
        assert_eq!(split_collected_reports("  \u{feff} ", "report"), Vec::<(String, String)>::new());
        assert_eq!(split_collected_reports(" x ", "L"), vec![("L".to_owned(), "x".to_owned())]);
    }

    #[test]
    fn 실행기_판별() {
        let pj = |text: &str| js_json::parse(text).unwrap();
        assert_eq!(detect_runner("Spring-Boot", true, None), Some("maven"));
        assert_eq!(detect_runner("spring", false, None), Some("gradle"));
        assert_eq!(detect_runner("FastAPI", false, None), Some("pytest"));
        assert_eq!(detect_runner("nextjs", false, None), None);
        assert_eq!(detect_runner("go", false, None), None);
        assert_eq!(detect_runner("nextjs", false, Some(&pj(r#"{"dependencies":{"vitest":"1"}}"#))), Some("vitest"));
        // devDependencies가 같은 키를 덮는다(값이 거짓이어도)
        assert_eq!(detect_runner("nextjs", false, Some(&pj(r#"{"dependencies":{"vitest":"1"},"devDependencies":{"vitest":""}}"#))), None);
        assert_eq!(detect_runner("vite", false, Some(&pj(r#"{"devDependencies":{"jest":"29"}}"#))), Some("jest"));
        assert_eq!(detect_runner("vite", false, Some(&pj(r#"{"scripts":{"test":"npx vitest run"}}"#))), Some("vitest"));
        assert_eq!(detect_runner("vite", false, Some(&pj(r#"{"scripts":{"test":"xjest jestx"}}"#))), None);
        assert_eq!(detect_runner("vite", false, Some(&pj(r#"{"scripts":{"test":["a","jest"]}}"#))), Some("jest"));
        assert_eq!(detect_runner("vite", false, Some(&pj(r#"{"scripts":"vitest"}"#))), None);
    }
}
