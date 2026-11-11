//! 워크플로 판정(옛 TS: `packages/agent/src/workflow.ts`와 `checkpoints.ts`의 트레일러 확인 둘, ADR-191 3단계 3v).
//!
//! 이 판정은 릴리스를 막고(`release_blockers`), 게이트가 빠뜨린 검증 단계를 알리고(`missing_verification_stages`),
//! 문서만 바꿨다는 주장으로 게이트를 건너뛸 수 있는지 정한다(`is_doc_checkpoint_path`·`has_docs_verify_trailer`). 그래서 **옛 막음이 새 통과로 뒤집히는 차이**가 없어야 한다.
//!
//! 짝 없는 서로게이트(트러블슈팅 166): napi·JSON 경계에서 U+FFFD로 합쳐진다. 통과·허용으로 이어지는 같음 비교(`passed.has(stage)`, 시험이 이 서비스를 다루는지,
//! 선언한 화면 경로가 이 경로인지)는 껍데기가 양쪽을 `encodeLoneSurrogates`(단사)로 바꿔 보내고 여기서도 그 꼴로 견준다. 보호 경로(거부 목록)는 파일 시스템 꼴(U+FFFD)로 견준다.
//! 표시용 글(`detail`)은 인코딩을 풀어 U+FFFD로 적는다(`decode_display`).
//!
//! 의도한 차이(전부 막는 쪽으로만 달라진다):
//! 1. `Workflow-Passed` 값을 읽을 때 공백은 git이 트레일러에서 지우는 ASCII 공백(` \t\n\v\f\r`)뿐이다. 옛 코드는 NBSP·BOM·U+2028 같은 JS 공백도 지워 단계 이름으로 읽었다(그래서 더 많은 단계를 통과로 읽었다).
//! 2. 마지막 `Workflow-Passed` 값이 비어 있으면(앞에 비지 않은 값이 있어도) 통과한 단계가 없는 것으로 읽는다. git은 마지막 값을 읽는데 옛 코드는 빈 값을 건너뛰고 앞의 값을 읽었다.
//! 3. 커밋에 넘길 트레일러에 `Workflow-Passed: none`이 하나라도 있으면 막는다(옛 코드는 첫 줄만 봤다). 문서 예외(`Workflow-Verify: docs`)는 마지막 `Workflow-Verify` 줄이 docs일 때만 인정하고, 키·값은 ASCII 대소문자만 무시한다(옛 코드는 아무 줄이나 하나, 유니코드 소문자화).
//!
//! `Workflow-Verify`·`Workflow-Incomplete` 값은 옛 코드와 같이 JS `trim`으로 읽는다. 알아보는 값이 늘수록 막는 쪽(`light`·`docs`·`unverified`는 게이트 증거로 세지 않는다)이라 넓게 읽는 것이 안전하다.

use crate::js;
use crate::js_json::{self, JsObject, JsValue};
use crate::{next_routes, path_policy, services};

pub const WORKFLOW_TRAILER: &str = "Workflow-Passed";
pub const WORKFLOW_VERIFY_TRAILER: &str = "Workflow-Verify";
pub const WORKFLOW_INCOMPLETE_TRAILER: &str = "Workflow-Incomplete";
pub const COVERAGE_GAP_PREFIX: &str = "coverage-gap";

pub const VERIFICATION_STAGES: [&str; 7] = ["run", "browser_check", "contract_check", "test", "concurrency_check", "load_check", "review"];
pub const DEFAULT_WORKFLOW: [&str; 6] = ["plan", "implement", "run", "contract_check", "review", "checkpoint"];

fn is_known_stage(stage: &str) -> bool {
    VERIFICATION_STAGES.contains(&stage) || matches!(stage, "plan" | "implement" | "checkpoint")
}

// ── 트레일러 만들기·읽기 ───────────────────────────────────────────────

pub fn format_workflow_trailer(stages: &[String]) -> String {
    format!("{WORKFLOW_TRAILER}: {}", if stages.is_empty() { "none".to_owned() } else { stages.join(", ") })
}

pub fn format_verify_trailer(mode: &str) -> String {
    format!("{WORKFLOW_VERIFY_TRAILER}: {mode}")
}

pub fn format_incomplete_trailer(reason: &str) -> String {
    format!("{WORKFLOW_INCOMPLETE_TRAILER}: {reason}")
}

/// git이 트레일러 값에서 지우는 공백(`isspace`)
fn is_git_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r')
}

fn trim_git(text: &str) -> &str {
    text.trim_matches(is_git_space)
}

/// 마지막 `Workflow-Passed` 값(git이 읽은 값 목록). 없으면 None(스튜디오 밖에서 바꾼 파일이나 이전 버전의 체크포인트)
pub fn parse_workflow_trailer_values(values: &[String]) -> Option<Vec<String>> {
    let trimmed: Vec<&str> = values.iter().map(|value| trim_git(value)).collect();
    let value = *trimmed.iter().rev().find(|value| !value.is_empty())?;
    // 의도한 차이 2: 마지막 값이 비면 통과한 단계가 없다
    if trimmed.last().is_some_and(|last| last.is_empty()) {
        return Some(Vec::new());
    }
    if value == "none" {
        return Some(Vec::new());
    }
    // 의도한 차이 1: 조각의 공백은 ASCII 공백뿐이다
    Some(value.split(',').map(trim_git).filter(|stage| is_known_stage(stage)).map(str::to_owned).collect())
}

fn last_trimmed_lower(values: &[String]) -> Option<String> {
    values.iter().map(|value| js::trim(value)).filter(|value| !value.is_empty()).last().map(str::to_lowercase)
}

/// `'light'`·`'docs'`·`'unverified'`가 아니면 None(전체 검증 실행)
pub fn parse_verify_trailer_values(values: &[String]) -> Option<&'static str> {
    match last_trimmed_lower(values)?.as_str() {
        "light" => Some("light"),
        "docs" => Some("docs"),
        "unverified" => Some("unverified"),
        _ => None,
    }
}

pub fn parse_incomplete_trailer_values(values: &[String]) -> Option<&'static str> {
    (last_trimmed_lower(values)? == "max_turns").then_some("max_turns")
}

/// `^(docs\/.+|[^/]+\.md|\.github\/pull_request_template\.md)$`(`.`은 줄 끝 글자 넷을 맞추지 않는다). 여는 쪽(문서 예외)이라 정확히 같은 모양만 인정한다
pub fn is_doc_checkpoint_path(file: &str) -> bool {
    if file == ".github/pull_request_template.md" {
        return true;
    }
    if let Some(rest) = file.strip_prefix("docs/") {
        if !rest.is_empty() && !rest.chars().any(js::is_js_line_terminator) {
            return true;
        }
    }
    !file.contains('/') && file.ends_with(".md") && file.len() > ".md".len()
}

fn entry_lower(entry: &str) -> String {
    js::trim(entry).to_lowercase()
}

/// 커밋에 넘길 트레일러에 통과한 단계가 없다는 기록(`Workflow-Passed: none`)이 있는지. 막는 쪽이라 하나라도 있으면 참이다(의도한 차이 3)
pub fn has_empty_passed_trailer(trailers: &[String]) -> bool {
    let prefix = format!("{}:", WORKFLOW_TRAILER.to_lowercase());
    trailers.iter().any(|entry| {
        let lower = entry_lower(entry);
        lower.strip_prefix(&prefix).is_some_and(|value| js::trim(value) == "none")
    })
}

/// 커밋에 넘길 트레일러가 문서 체크포인트 예외(`Workflow-Verify: docs`)를 주장하는지. 여는 쪽이라 마지막 `Workflow-Verify` 줄이 정확히 docs일 때만 참이다(의도한 차이 3)
pub fn has_docs_verify_trailer(trailers: &[String]) -> bool {
    let prefix = format!("{}:", WORKFLOW_VERIFY_TRAILER.to_lowercase());
    let expected = format_verify_trailer("docs");
    match trailers.iter().rev().find(|entry| entry_lower(entry).starts_with(&prefix)) {
        Some(entry) => js::trim(entry).eq_ignore_ascii_case(&expected),
        None => false,
    }
}

// ── 단계 ───────────────────────────────────────────────────────────────

/// `required`가 있으면 그대로(빈 배열도). 없으면 기본 단계에 선언한 확인을 끼운다
pub fn workflow_stages(required: Option<&[String]>, page_checks: usize, tests: usize, concurrency_checks: usize, load_checks: usize) -> Vec<String> {
    if let Some(required) = required {
        return required.to_vec();
    }
    let mut stages: Vec<String> = DEFAULT_WORKFLOW.iter().map(|stage| (*stage).to_owned()).collect();
    let mut insert_before = |stage: &str, before: &str| {
        let at = stages.iter().position(|s| s == before).unwrap_or(stages.len());
        stages.insert(at, stage.to_owned());
    };
    if page_checks > 0 {
        insert_before("browser_check", "contract_check");
    }
    if tests > 0 {
        insert_before("test", "review");
    }
    if concurrency_checks > 0 {
        insert_before("concurrency_check", "review");
    }
    if load_checks > 0 {
        insert_before("load_check", "review");
    }
    stages
}

pub fn workflow_release_requirements(release_requires: Option<&[String]>) -> Vec<String> {
    release_requires.map_or_else(|| vec!["checkpoint".to_owned()], <[String]>::to_vec)
}

/// 배포 전에 빠진 단계의 위치(요구 목록 기준). `None`이면 `releaseRequires`가 없을 때의 `['checkpoint']`다. 모든 입력은 껍데기가 `encodeLoneSurrogates`로 바꿔 보낸다
#[derive(Debug, PartialEq, Eq)]
pub enum Blockers {
    /// 게이트를 거치지 않은 직접 수정 체크포인트(#772)라 `checkpoint`가 빠졌다
    Checkpoint,
    /// 요구 목록에서 빠진 단계의 위치
    Missing(Vec<usize>),
}

pub fn release_blockers(requires: Option<&[String]>, declared: bool, passed: Option<&[String]>, verify: Option<&str>) -> Blockers {
    if verify == Some("unverified") && !declared {
        return Blockers::Checkpoint;
    }
    let default = ["checkpoint".to_owned()];
    let requires = requires.unwrap_or(&default);
    let passed = passed.unwrap_or(&[]);
    Blockers::Missing(
        requires
            .iter()
            .enumerate()
            .filter(|(_, stage)| stage.as_str() != "checkpoint" && !passed.contains(stage))
            .map(|(index, _)| index)
            .collect(),
    )
}

/// 게이트가 통과시킨 단계와 필수 단계를 비교해 빠진 검증 단계의 위치(`stages` 기준)
pub fn missing_verification_stages(stages: &[String], passed: &[String]) -> Vec<usize> {
    stages
        .iter()
        .enumerate()
        .filter(|(_, stage)| VERIFICATION_STAGES.contains(&stage.as_str()) && !passed.contains(stage))
        .map(|(index, _)| index)
        .collect()
}

pub fn protected_paths_for(protected: &[String], evaluation_assets: &[String]) -> Vec<String> {
    protected.iter().chain(evaluation_assets).cloned().collect()
}

// ── 인코딩 풀기(표시용) ────────────────────────────────────────────────

fn nibble(c: char) -> Option<u32> {
    let n = (c as u32).checked_sub(0xe000)?;
    (n < 16).then_some(n)
}

/// `encodeLoneSurrogates`가 만든 글을 표시용으로 푼다: 짝 없는 서로게이트는 U+FFFD, 글자 그대로의 예약 글자는 원래 글자
pub fn decode_display(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\u{e010}' && i + 3 < chars.len() && (1..=3).all(|k| nibble(chars[i + k]).is_some()) {
            out.push('\u{fffd}');
            i += 4;
        } else if c == '\u{e011}' && i + 2 < chars.len() && (1..=2).all(|k| nibble(chars[i + k]).is_some()) {
            let value = 0xe000 + (nibble(chars[i + 1]).unwrap() << 4 | nibble(chars[i + 2]).unwrap());
            out.push(char::from_u32(value).unwrap_or('\u{fffd}'));
            i += 3;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

// ── 검토 ───────────────────────────────────────────────────────────────

fn is_test_signal(file: &str) -> bool {
    for kind in ["test", "spec"] {
        for prefix in ["", "c", "m"] {
            for ext in ["js", "jsx", "ts", "tsx"] {
                if file.ends_with(&format!(".{kind}.{prefix}{ext}")) {
                    return true;
                }
            }
        }
    }
    for name in ["vitest", "jest", "playwright"] {
        for prefix in ["", "c", "m"] {
            for ext in ["js", "ts"] {
                let base = format!("{name}.config.{prefix}{ext}");
                if file == base || file.ends_with(&format!("/{base}")) {
                    return true;
                }
            }
        }
    }
    file.starts_with("__tests__/") || file.contains("/__tests__/")
}

#[derive(Debug, Clone, PartialEq)]
pub struct ManagedEntry {
    pub name: String,
    pub path: String,
    pub includes: Vec<String>,
    pub template: String,
}

/// 인코딩한 꼴(`encodeLoneSurrogates`)로 받는다
#[derive(Debug, Clone, Default)]
pub struct CoverInput {
    pub managed: Vec<ManagedEntry>,
    pub root: String,
    pub compose_path: String,
    pub cwd: String,
    pub files: Vec<String>,
    pub tested_services: Vec<String>,
    pub auto_page_service: Option<String>,
    pub page_checks: Vec<(String, String)>,
    pub auto_page_max: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: Option<String>,
}

impl Check {
    fn to_value(&self) -> JsValue {
        js_json::object(vec![
            ("stage", Some(JsValue::str("review"))),
            ("name", Some(JsValue::str(&self.name))),
            ("ok", Some(JsValue::Bool(self.ok))),
            ("attempts", Some(JsValue::Num(1.0))),
            ("detail", self.detail.as_ref().map(JsValue::str)),
        ])
    }
}

pub fn uncovered_change_warnings(input: &CoverInput) -> Vec<Check> {
    if input.managed.is_empty() {
        return Vec::new();
    }
    let svc: Vec<services::ManagedService> = input.managed.iter().map(|m| services::ManagedService { name: m.name.clone(), path: m.path.clone(), includes: m.includes.clone() }).collect();
    let mapping = services::services_for_files(&svc, &input.root, &input.compose_path, &input.cwd, &input.files);
    let mut warnings = Vec::new();
    for index in mapping.services {
        let name = &input.managed[index].name;
        let Some(entry) = input.managed.iter().find(|m| &m.name == name) else { continue };
        let shown = decode_display(name);

        if !input.tested_services.contains(name) && input.files.iter().any(|file| services::owns_file(&entry.path, &entry.includes, file) && is_test_signal(file)) {
            warnings.push(Check {
                name: format!("{COVERAGE_GAP_PREFIX}: {shown} 테스트"),
                ok: true,
                detail: Some(format!("{shown}에 테스트 파일·설정이 새로 생겼지만 workflow.tests에 '{shown}' 서비스를 다루는 항목이 없어 게이트의 test 단계가 돌리지 않았습니다. 돌려야 한다면 studio.yaml의 workflow.tests에 추가하세요.")),
            });
        }

        if entry.template == "nextjs" && input.auto_page_service.as_deref() != Some(name.as_str()) {
            let routes = next_routes::routes_from_changed_files(&input.files, &entry.path, &JsObject::new(), input.auto_page_max, input.auto_page_max, None).routes;
            let uncovered: Vec<String> = routes
                .iter()
                .filter(|route| !input.page_checks.iter().any(|(service, path)| service == name && path == &route.path))
                .map(|route| decode_display(&route.path))
                .collect();
            if !uncovered.is_empty() {
                warnings.push(Check {
                    name: format!("{COVERAGE_GAP_PREFIX}: {shown} 화면"),
                    ok: true,
                    detail: Some(format!("{shown}에 화면 경로가 바뀌었지만({}) workflow.pageChecks·autoPageChecks가 이 경로를 확인하지 않아 게이트가 열어 보지 않았습니다. studio.yaml에 pageChecks를 추가하거나 autoPageChecks를 켜세요.", uncovered.join(", "))),
                });
            }
        }
    }
    warnings
}

/// 보호 경로(거부 목록)와 파일은 파일 시스템 꼴(짝 없는 서로게이트는 U+FFFD)로 견준다
pub fn protected_path_check(files: &[String], rules: &[String], backslash_sep: bool) -> Check {
    protected_path_check_except(files, rules, backslash_sep, &[])
}

/// `protected_path_check`에서 `restored`의 자리(`files`의 위치)에 있는 파일만 뺀다. 이슈 #992.
/// 이 목록은 "쓰기 직전에 고정한 내용과 지금 바이트까지 같다"고 TS가 읽어 확인한 파일의 자리다 — 막는 검사를 **여는** 쪽의 입력이다.
/// 그래서 이름이 아니라 위치로 받는다(짝 없는 서로게이트가 경계에서 합쳐져 다른 파일이 같은 이름이 되어도 다른 파일이 빠지지 않는다).
/// 목록 밖의 위치는 무시하지 않고 호출부(`review_changes_json`)가 던진다
pub fn protected_path_check_except(files: &[String], rules: &[String], backslash_sep: bool, restored: &[usize]) -> Check {
    let touched: Vec<String> = rules
        .iter()
        .flat_map(|rule| {
            files
                .iter()
                .enumerate()
                .filter(move |(position, file)| !restored.contains(position) && path_policy::is_protected_path(file, rule, backslash_sep))
                .map(move |(_, file)| format!("{file} (보호 경로 {rule})"))
        })
        .collect();
    Check {
        name: "protected-paths".to_owned(),
        ok: touched.is_empty(),
        detail: (!touched.is_empty()).then(|| format!("보호 경로가 바뀌었습니다. 되돌리거나 사람 승인 흐름으로 요청하세요: {}", touched.join(", "))),
    }
}

pub fn change_size_check(changed: usize, max: f64) -> Check {
    let over = changed as f64 > max;
    Check {
        name: "change-size".to_owned(),
        ok: !over,
        detail: over.then(|| format!("한 요청에서 파일 {changed}개를 바꿨습니다(상한 {}). 필요 없는 변경을 되돌리세요", js::number_to_string(max))),
    }
}

// ── 체크포인트 본문에 남길 확인 요약 ───────────────────────────────────

pub struct CoverageCheck {
    pub stage: Option<String>,
    pub name: String,
    pub ok: bool,
    pub detail: Option<String>,
}

/// `detail`은 `declared`(확인 선언 변경 줄)를 고를 때 JS 진릿값(빈 글자는 거짓)으로, 틈 목록에서는 `detail ?? name`으로 쓴다
pub fn format_checked_coverage(checks: &[CoverageCheck], declared_check_name: &str) -> String {
    if checks.is_empty() {
        return String::new();
    }
    let gap_prefix = format!("{COVERAGE_GAP_PREFIX}:");
    let gaps: Vec<&CoverageCheck> = checks.iter().filter(|check| check.name.starts_with(&gap_prefix)).collect();
    let covered: Vec<&CoverageCheck> = checks
        .iter()
        .filter(|check| matches!(check.stage.as_deref(), Some("browser_check" | "test" | "concurrency_check" | "load_check")))
        .collect();
    let mut lines: Vec<String> = Vec::new();
    if !covered.is_empty() {
        let items: Vec<String> = covered
            .iter()
            .map(|check| format!("[{}] {}({})", check.stage.as_deref().unwrap_or(""), check.name, if check.ok { "통과" } else { "실패" }))
            .collect();
        lines.push(format!("게이트가 확인함: {}", items.join(", ")));
    }
    if !gaps.is_empty() {
        let items: Vec<String> = gaps.iter().map(|check| format!("- {}", check.detail.as_deref().unwrap_or(&check.name))).collect();
        lines.push(format!("확인 안 됨:\n{}", items.join("\n")));
    }
    let declared = checks
        .iter()
        .find(|check| check.stage.as_deref() == Some("review") && check.name == declared_check_name && check.ok && check.detail.as_deref().is_some_and(|detail| !detail.is_empty()));
    if let Some(check) = declared {
        lines.push(format!("확인 선언 변경: {}", check.detail.as_deref().unwrap_or("")));
    }
    lines.join("\n")
}

// ── JSON 경계 ──────────────────────────────────────────────────────────

fn string_field(value: &JsValue, key: &str, what: &str) -> Result<String, String> {
    match value.prop(key) {
        Some(JsValue::Str(text)) => Ok(text.clone()),
        _ => Err(format!("{what}.{key}는 문자열이어야 합니다")),
    }
}

fn optional_string(value: &JsValue, key: &str, what: &str) -> Result<Option<String>, String> {
    match value.prop(key) {
        None | Some(JsValue::Null) => Ok(None),
        Some(JsValue::Str(text)) => Ok(Some(text.clone())),
        Some(_) => Err(format!("{what}.{key}는 문자열이어야 합니다")),
    }
}

fn string_list(value: Option<&JsValue>, what: &str) -> Result<Vec<String>, String> {
    match value {
        None | Some(JsValue::Null) => Ok(Vec::new()),
        Some(JsValue::Arr(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::Str(text) => Ok(text.clone()),
                _ => Err(format!("{what}의 항목은 문자열이어야 합니다")),
            })
            .collect(),
        Some(_) => Err(format!("{what}는 배열이어야 합니다")),
    }
}

fn parse_input(json: &str) -> Result<JsValue, String> {
    js_json::parse_native(json).map_err(|e| format!("입력을 읽지 못했습니다: {e}"))
}

fn cover_input(input: &JsValue) -> Result<CoverInput, String> {
    let managed = match input.prop("managed") {
        None | Some(JsValue::Null) => Vec::new(),
        Some(JsValue::Arr(items)) => items
            .iter()
            .map(|item| {
                Ok(ManagedEntry {
                    name: string_field(item, "name", "managed")?,
                    path: string_field(item, "path", "managed")?,
                    includes: string_list(item.prop("includes"), "managed.includes")?,
                    template: string_field(item, "template", "managed")?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
        Some(_) => return Err("managed는 배열이어야 합니다".to_owned()),
    };
    let page_checks = match input.prop("pageChecks") {
        None | Some(JsValue::Null) => Vec::new(),
        Some(JsValue::Arr(items)) => items.iter().map(|item| Ok((string_field(item, "service", "pageChecks")?, string_field(item, "path", "pageChecks")?))).collect::<Result<Vec<_>, String>>()?,
        Some(_) => return Err("pageChecks는 배열이어야 합니다".to_owned()),
    };
    let auto_page_max = match input.prop("autoPageMax") {
        Some(JsValue::Num(n)) => *n,
        _ => return Err("autoPageMax는 수여야 합니다".to_owned()),
    };
    Ok(CoverInput {
        managed,
        root: string_field(input, "root", "input")?,
        compose_path: string_field(input, "composePath", "input")?,
        cwd: string_field(input, "cwd", "input")?,
        files: string_list(input.prop("filesEnc"), "filesEnc")?,
        tested_services: string_list(input.prop("testedServices"), "testedServices")?,
        auto_page_service: optional_string(input, "autoPageService", "input")?,
        page_checks,
        auto_page_max,
    })
}

fn checks_value(checks: &[Check]) -> JsValue {
    JsValue::Arr(checks.iter().map(Check::to_value).collect())
}

/// 입력: `{managed, root, composePath, cwd, filesEnc, testedServices, autoPageService?, pageChecks, autoPageMax}`(모두 인코딩한 꼴). 출력: 확인 목록 JSON
pub fn uncovered_change_warnings_json(input_json: &str) -> Result<String, String> {
    let input = cover_input(&parse_input(input_json)?)?;
    Ok(js_json::to_native(&checks_value(&uncovered_change_warnings(&input))))
}

/// 쓰기 직전 고정값과 같아 보호 경로 확인에서 빼 줄 파일의 위치들. 정수이고 `0..len`이어야 한다(열린 쪽 입력이라 어긋나면 받지 않는다)
fn restored_positions(value: Option<&JsValue>, len: usize) -> Result<Vec<usize>, String> {
    match value {
        None | Some(JsValue::Null) => Ok(Vec::new()),
        Some(JsValue::Arr(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::Num(n) if n.fract() == 0.0 && *n >= 0.0 && *n < len as f64 => Ok(*n as usize),
                _ => Err("restoredPositions의 항목은 files 안의 위치(정수)여야 합니다".to_owned()),
            })
            .collect(),
        Some(_) => Err("restoredPositions는 배열이어야 합니다".to_owned()),
    }
}

/// 입력: 위 입력에 `{files, protectedPaths, backslashSep, maxChangedFiles?, restoredPositions?}`(`files`·`protectedPaths`는 원래 글자)를 더한 것.
/// `restoredPositions`는 보호 경로 확인에서만 빼 준다(파일 수 상한·덮이지 않은 변경 경고는 모든 파일을 센다)
pub fn review_changes_json(input_json: &str) -> Result<String, String> {
    let value = parse_input(input_json)?;
    let files = string_list(value.prop("files"), "files")?;
    let rules = string_list(value.prop("protectedPaths"), "protectedPaths")?;
    let backslash_sep = matches!(value.prop("backslashSep"), Some(JsValue::Bool(true)));
    let restored = restored_positions(value.prop("restoredPositions"), files.len())?;
    let mut checks = vec![protected_path_check_except(&files, &rules, backslash_sep, &restored)];
    match value.prop("maxChangedFiles") {
        None => {}
        Some(JsValue::Num(max)) => checks.push(change_size_check(files.len(), *max)),
        Some(_) => return Err("maxChangedFiles는 수여야 합니다".to_owned()),
    }
    checks.extend(uncovered_change_warnings(&cover_input(&value)?));
    Ok(js_json::to_native(&checks_value(&checks)))
}

/// 입력: `[{stage?, name, ok, detail?}]`
pub fn format_checked_coverage_json(checks_json: &str, declared_check_name: &str) -> Result<String, String> {
    let value = parse_input(checks_json)?;
    let JsValue::Arr(items) = value else { return Err("checks는 배열이어야 합니다".to_owned()) };
    let checks = items
        .iter()
        .map(|item| {
            Ok(CoverageCheck {
                stage: optional_string(item, "stage", "check")?,
                name: string_field(item, "name", "check")?,
                ok: item.prop("ok").is_some_and(JsValue::truthy),
                detail: match item.prop("detail") {
                    None | Some(JsValue::Null) => None,
                    Some(other) => Some(other.to_js_string()),
                },
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format_checked_coverage(&checks, declared_check_name))
}

/// 입력 `{override?, maxTurns?}`. `override ?? maxTurns`. 출력: 고른 값 JSON(둘 다 없으면 `null`)
pub fn max_turns_json(input_json: &str) -> Result<String, String> {
    let value = parse_input(input_json)?;
    let chosen = [value.prop("override"), value.prop("maxTurns")].into_iter().flatten().find(|v| !matches!(v, JsValue::Null));
    Ok(chosen.map_or_else(|| "null".to_owned(), js_json::to_native))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn 트레일러를_만든다() {
        assert_eq!(format_workflow_trailer(&[]), "Workflow-Passed: none");
        assert_eq!(format_workflow_trailer(&v(&["run", "review"])), "Workflow-Passed: run, review");
        assert_eq!(format_verify_trailer("docs"), "Workflow-Verify: docs");
        assert_eq!(format_incomplete_trailer("max_turns"), "Workflow-Incomplete: max_turns");
    }

    #[test]
    fn passed_값은_마지막_비지_않은_값이다() {
        assert_eq!(parse_workflow_trailer_values(&v(&[])), None);
        assert_eq!(parse_workflow_trailer_values(&v(&["", "  "])), None);
        assert_eq!(parse_workflow_trailer_values(&v(&["none"])), Some(v(&[])));
        assert_eq!(parse_workflow_trailer_values(&v(&["None"])), Some(v(&[])));
        assert_eq!(parse_workflow_trailer_values(&v(&["run", "test"])), Some(v(&["test"])));
        assert_eq!(parse_workflow_trailer_values(&v(&["", "run"])), Some(v(&["run"])));
        assert_eq!(parse_workflow_trailer_values(&v(&["run , test,,review"])), Some(v(&["run", "test", "review"])));
        assert_eq!(parse_workflow_trailer_values(&v(&["Run", "runx", "xrun", "run test"])), Some(v(&[])));
        assert_eq!(parse_workflow_trailer_values(&v(&["run\r"])), Some(v(&["run"])));
    }

    #[test]
    fn 의도한_차이_마지막_값이_비면_통과한_단계가_없다() {
        assert_eq!(parse_workflow_trailer_values(&v(&["run", ""])), Some(v(&[])));
        assert_eq!(parse_workflow_trailer_values(&v(&["run", " \t"])), Some(v(&[])));
    }

    #[test]
    fn 의도한_차이_공백은_git이_지우는_ascii_공백뿐이다() {
        assert_eq!(parse_workflow_trailer_values(&v(&["\u{a0}run"])), Some(v(&[])));
        assert_eq!(parse_workflow_trailer_values(&v(&["run,\u{a0}test"])), Some(v(&["run"])));
        assert_eq!(parse_workflow_trailer_values(&v(&["run\u{2028}"])), Some(v(&[])));
        assert_eq!(parse_workflow_trailer_values(&v(&["\u{feff}"])), Some(v(&[])));
    }

    #[test]
    fn verify와_incomplete_값은_js_trim으로_읽는다() {
        assert_eq!(parse_verify_trailer_values(&v(&["LIGHT"])), Some("light"));
        assert_eq!(parse_verify_trailer_values(&v(&["\u{a0}docs\u{2028}"])), Some("docs"));
        assert_eq!(parse_verify_trailer_values(&v(&["light", ""])), Some("light"));
        assert_eq!(parse_verify_trailer_values(&v(&["light", "full"])), None);
        assert_eq!(parse_verify_trailer_values(&v(&["l\u{131}ght", "L\u{130}GHT"])), None);
        assert_eq!(parse_verify_trailer_values(&v(&["lights"])), None);
        assert_eq!(parse_incomplete_trailer_values(&v(&["Max_Turns"])), Some("max_turns"));
        assert_eq!(parse_incomplete_trailer_values(&v(&["max_turn"])), None);
        assert_eq!(parse_incomplete_trailer_values(&v(&["max_turns", "x"])), None);
    }

    #[test]
    fn 문서_경로는_정확히_세_모양이다() {
        for yes in ["docs/a", "docs/a/b.json", "README.md", "a.md", "..md", "a\nb.md", ".github/pull_request_template.md", "docs/ "] {
            assert!(is_doc_checkpoint_path(yes), "{yes:?}");
        }
        for no in ["", "docs", "docs/", "Docs/a", "docs/\n", "docs/a\u{2028}", ".md", "a.MD", "a.md ", "a/b.md", ".github/Pull_Request_Template.md", ".github/pull_request_template.md/", "xdocs/a"] {
            assert!(!is_doc_checkpoint_path(no), "{no:?}");
        }
    }

    #[test]
    fn 커밋_전_트레일러_확인() {
        assert!(has_empty_passed_trailer(&v(&["Workflow-Passed: none"])));
        assert!(has_empty_passed_trailer(&v(&["  workflow-passed:NONE\r"])));
        assert!(has_empty_passed_trailer(&v(&["Workflow-Passed: test", "Workflow-Passed: none"])));
        assert!(!has_empty_passed_trailer(&v(&["Workflow-Passed: none x", "Workflow-Passed:", "Workflow-Verify: none"])));
        assert!(has_docs_verify_trailer(&v(&["Workflow-Passed: none", "Workflow-Verify: docs"])));
        assert!(has_docs_verify_trailer(&v(&[" WORKFLOW-VERIFY: DOCS "])));
        assert!(!has_docs_verify_trailer(&v(&["Workflow-Verify:docs"])));
        assert!(!has_docs_verify_trailer(&v(&["Workflow-Verify: docs", "Workflow-Verify: unverified"])));
        assert!(!has_docs_verify_trailer(&v(&["Workflow-Verify: docs", "Workflow-Verify:"])));
        assert!(!has_docs_verify_trailer(&v(&["Wor\u{212a}flow-Verify: docs"])));
        assert!(!has_docs_verify_trailer(&v(&[])));
    }

    #[test]
    fn 단계는_선언한_확인을_끼운다() {
        assert_eq!(workflow_stages(None, 0, 0, 0, 0), v(&DEFAULT_WORKFLOW));
        assert_eq!(workflow_stages(Some(&v(&[])), 1, 1, 1, 1), v(&[]));
        assert_eq!(
            workflow_stages(None, 1, 1, 1, 1),
            v(&["plan", "implement", "run", "browser_check", "contract_check", "test", "concurrency_check", "load_check", "review", "checkpoint"])
        );
        assert_eq!(workflow_release_requirements(None), v(&["checkpoint"]));
        assert_eq!(workflow_release_requirements(Some(&v(&[]))), v(&[]));
    }

    #[test]
    fn 배포_막음은_통과한_단계를_글자_그대로_견준다() {
        let requires = v(&["checkpoint", "test", "review"]);
        assert_eq!(release_blockers(Some(&requires), true, Some(&v(&["test"])), None), Blockers::Missing(vec![2]));
        assert_eq!(release_blockers(Some(&requires), true, None, None), Blockers::Missing(vec![1, 2]));
        assert_eq!(release_blockers(Some(&requires), true, Some(&v(&["Test", "test ", "tests"])), None), Blockers::Missing(vec![1, 2]));
        assert_eq!(release_blockers(None, false, None, Some("unverified")), Blockers::Checkpoint);
        assert_eq!(release_blockers(None, false, None, Some("light")), Blockers::Missing(vec![]));
        assert_eq!(release_blockers(Some(&requires), true, None, Some("unverified")), Blockers::Missing(vec![1, 2]));
        assert_eq!(release_blockers(Some(&v(&[])), true, None, Some("unverified")), Blockers::Missing(vec![]));
    }

    #[test]
    fn 빠진_검증_단계는_검증_단계만_센다() {
        let stages = v(&["plan", "run", "deploy", "test", "checkpoint"]);
        assert_eq!(missing_verification_stages(&stages, &v(&["run"])), vec![3]);
        assert_eq!(missing_verification_stages(&stages, &v(&[])), vec![1, 3]);
        assert_eq!(missing_verification_stages(&stages, &v(&["RUN", "Test"])), vec![1, 3]);
    }

    #[test]
    fn 인코딩을_표시용으로_푼다() {
        assert_eq!(decode_display("a\u{e010}\u{e00d}\u{e008}\u{e000}b"), "a\u{fffd}b");
        assert_eq!(decode_display("\u{e011}\u{e001}\u{e002}"), "\u{e012}");
        assert_eq!(decode_display("\u{e010}\u{e00d}"), "\u{e010}\u{e00d}");
        assert_eq!(decode_display("평범한 글"), "평범한 글");
    }

    #[test]
    fn 테스트_파일_모양() {
        for yes in ["a.test.ts", "a.spec.tsx", "a.test.cjsx", "a.test.mtsx", ".test.ts", "x/vitest.config.mts", "jest.config.js", "playwright.config.cts", "__tests__/a", "a/__tests__/b"] {
            assert!(is_test_signal(yes), "{yes}");
        }
        for no in ["a.test.json", "a.tests.ts", "a.Test.ts", "a.test.ts.bak", "xvitest.config.ts", "vitest.config.json", "a__tests__/b", "__tests__", "src/__test__/a", "a.test"] {
            assert!(!is_test_signal(no), "{no}");
        }
    }

    fn entry(name: &str, path: &str, template: &str) -> ManagedEntry {
        ManagedEntry { name: name.into(), path: path.into(), includes: vec![], template: template.into() }
    }

    fn cover(managed: Vec<ManagedEntry>, files: &[&str]) -> CoverInput {
        CoverInput { managed, cwd: "/w".into(), files: v(files), auto_page_max: 10.0, ..Default::default() }
    }

    #[test]
    fn 커버리지_경고() {
        let mut input = cover(vec![entry("web", "apps/web", "nextjs")], &["apps/web/app/shorts/page.tsx", "apps/web/a.test.ts"]);
        let names: Vec<String> = uncovered_change_warnings(&input).into_iter().map(|c| c.name).collect();
        assert_eq!(names, v(&["coverage-gap: web 테스트", "coverage-gap: web 화면"]));
        input.tested_services = v(&["web"]);
        input.page_checks = vec![("web".into(), "/shorts".into())];
        assert!(uncovered_change_warnings(&input).is_empty());
        input.page_checks = vec![("web".into(), "/shorts/".into())];
        assert_eq!(uncovered_change_warnings(&input).len(), 1);
        input.page_checks.clear();
        input.auto_page_service = Some("web".into());
        assert!(uncovered_change_warnings(&input).is_empty());
        assert!(uncovered_change_warnings(&cover(vec![], &["a.test.ts"])).is_empty());
    }

    #[test]
    fn 변경_크기와_보호_경로() {
        assert!(change_size_check(2, 2.0).ok);
        let over = change_size_check(3, 2.0);
        assert!(!over.ok);
        assert_eq!(over.detail.as_deref(), Some("한 요청에서 파일 3개를 바꿨습니다(상한 2). 필요 없는 변경을 되돌리세요"));
        assert!(change_size_check(1, f64::NAN).ok);
        let blocked = protected_path_check(&v(&["infra/a", "src/b"]), &v(&["infra"]), false);
        assert!(!blocked.ok);
        assert!(blocked.detail.unwrap().ends_with("infra/a (보호 경로 infra)"));
        assert!(protected_path_check(&v(&["infrastructure/a"]), &v(&["infra"]), false).ok);
        // 파일 이름의 역슬래시: Windows에서는 구분자라 `src\\a`는 `other` 밖이고, POSIX에서는 꼴을 맞출 수 없어 막는다
        assert!(protected_path_check(&v(&["src\\a"]), &v(&["other"]), true).ok);
        assert!(!protected_path_check(&v(&["src\\a"]), &v(&["other"]), false).ok);
    }

    #[test]
    fn 되돌린_파일은_위치로만_보호_경로_확인에서_빠진다() {
        let files = v(&["infra/a", "infra/b", "src/c"]);
        let rules = v(&["infra"]);
        // 빼지 않으면 둘 다 걸린다
        assert_eq!(protected_path_check_except(&files, &rules, false, &[]).detail.unwrap().matches("보호 경로 infra").count(), 2);
        // 한 곳만 빼면 나머지는 그대로 걸린다
        let one = protected_path_check_except(&files, &rules, false, &[0]);
        assert!(!one.ok);
        assert!(one.detail.as_deref().unwrap().ends_with("infra/b (보호 경로 infra)"));
        assert!(!one.detail.unwrap().contains("infra/a"));
        // 걸린 것을 모두 빼면 통과한다
        assert!(protected_path_check_except(&files, &rules, false, &[0, 1]).ok);
        // 빼는 위치가 보호 경로가 아닌 파일이어도 다른 파일은 빠지지 않는다
        assert!(!protected_path_check_except(&files, &rules, false, &[2]).ok);
    }

    #[test]
    fn json의_빼는_위치는_파일_수와_함께_다른_검사에_영향을_주지_않는다() {
        let base = "\"protectedPaths\":[\"infra\"],\"autoPageMax\":10,\"root\":\"\",\"composePath\":\"\",\"cwd\":\"/\"";
        let with = |files: &str, restored: &str, max: &str| format!("{{\"files\":{files},{base}{restored}{max}}}");
        // 위치를 주지 않으면 지금과 같다
        assert!(review_changes_json(&with("[\"infra/a\"]", "", "")).unwrap().contains("\"ok\":false"));
        // 위치를 주면 보호 경로 확인만 통과하고, 파일 수 상한은 그 파일도 센다
        let out = review_changes_json(&with("[\"infra/a\",\"x\"]", ",\"restoredPositions\":[0]", ",\"maxChangedFiles\":1")).unwrap();
        assert!(out.contains("\"name\":\"protected-paths\",\"ok\":true"));
        assert!(out.contains("\"name\":\"change-size\",\"ok\":false"));
        // 어긋난 위치는 던진다: 범위 밖, 음수, 소수, 문자열, 배열이 아님
        for bad in ["[1]", "[-1]", "[0.5]", "[\"0\"]", "0", "{}"] {
            assert!(review_changes_json(&with("[\"infra/a\"]", &format!(",\"restoredPositions\":{bad}"), "")).is_err(), "{bad}");
        }
    }

    #[test]
    fn json_입력은_모양이_어긋나면_던진다() {
        assert!(review_changes_json("{}").is_err());
        assert!(review_changes_json("{\"files\":[],\"protectedPaths\":[],\"autoPageMax\":10,\"root\":\"\",\"composePath\":\"\",\"cwd\":\"/\",\"maxChangedFiles\":\"3\"}").is_err());
        assert!(format_checked_coverage_json("{}", "x").is_err());
        assert!(format_checked_coverage_json("[{\"stage\":\"test\",\"name\":1,\"ok\":true}]", "x").is_err());
        let out = review_changes_json("{\"files\":[\"a\"],\"protectedPaths\":[],\"autoPageMax\":10,\"root\":\"\",\"composePath\":\"\",\"cwd\":\"/\"}").unwrap();
        assert_eq!(out, "[{\"stage\":\"review\",\"name\":\"protected-paths\",\"ok\":true,\"attempts\":1}]");
    }

    #[test]
    fn 확인_요약() {
        let c = |stage: &str, name: &str, ok: bool, detail: Option<&str>| CoverageCheck { stage: Some(stage.into()), name: name.into(), ok, detail: detail.map(str::to_owned) };
        assert_eq!(format_checked_coverage(&[], "d"), "");
        assert_eq!(format_checked_coverage(&[c("test", "unit", true, None), c("run", "x", true, None)], "d"), "게이트가 확인함: [test] unit(통과)");
        assert_eq!(format_checked_coverage(&[c("review", "coverage-gap: a", true, None)], "d"), "확인 안 됨:\n- coverage-gap: a");
        assert_eq!(format_checked_coverage(&[c("review", "coverage-gap: a", true, Some(""))], "d"), "확인 안 됨:\n- ");
        assert_eq!(format_checked_coverage(&[c("review", "d", true, Some("바뀜"))], "d"), "확인 선언 변경: 바뀜");
        assert_eq!(format_checked_coverage(&[c("review", "d", true, Some(""))], "d"), "");
        assert_eq!(format_checked_coverage(&[c("review", "d", false, Some("바뀜"))], "d"), "");
    }

    #[test]
    fn 턴_상한은_앞의_값이_우선이다() {
        assert_eq!(max_turns_json("{\"override\":5,\"maxTurns\":10}").unwrap(), "5");
        assert_eq!(max_turns_json("{\"maxTurns\":10}").unwrap(), "10");
        assert_eq!(max_turns_json("{\"override\":0,\"maxTurns\":10}").unwrap(), "0");
        assert_eq!(max_turns_json("{}").unwrap(), "null");
        assert_eq!(max_turns_json("{\"override\":null,\"maxTurns\":3}").unwrap(), "3");
    }
}
