//! 요구사항 추적표 판정과 그 근거인 시험 파일 훑기(옛 TS: `packages/agent/src/requirements.ts`, ADR-191 3단계 3z).
//!
//! 추적표는 "시험·체크포인트·게이트·수동 기록이 이 요구사항을 다룬다"를 근거로 검증 상태를 올리는 **여는 쪽**이다. 그래서
//! 모르는 입력은 근거 없음으로 처리하고(던진다), 옛 TS가 열린 쪽으로 틀린 자리는 닫았다(아래 의도한 차이 2·3).
//!
//! 시험 파일 하나에서 뽑는 것(`FileIndex`)과 그것을 id로 견주는 일을 나눴다. 파일 내용은 한 번만 읽고(`file_index`) 요구사항마다
//! 다시 읽지 않는다(트러블슈팅 122). TS 껍데기가 파일 객체별로 이 값을 들고 있는다.
//!
//! 의도한 차이:
//! 1. 짝 없는 서로게이트는 Node 경계에서 U+FFFD가 된다. 시험 이름·파일 경로는 TS가 `encodeLoneSurrogates`로 보내 서로 다른 이름이
//!    합쳐지지 않게 하고(이름을 같다고 보면 시험 결과가 엉뚱한 시험에 붙는다) 결과에서 되돌린다. 요구사항·시나리오 id는 U+FFFD가 든
//!    것을 같다고 보지 않는다(`ids_equal`, 닫는 쪽으로).
//! 2. 메서드 이름에서 id를 찾을 때 옛 TS는 소문자로 바꿔 `indexOf`만 했다. 그래서 `calculatesOrder2Total`이 R2를, `testServer3`이 R3을
//!    다룬다고 읽혔다(낱말 가운데의 `r2`). 여기서는 찾은 자리가 낱말의 시작일 때만 센다: 대문자 `R`은 앞 글자가 대문자가 아닐 때,
//!    소문자 `r`은 앞 글자가 알파벳이 아닐 때(맨 앞·`_`·숫자 뒤). 처음 나온 자리만 보는 것과 뒤에 숫자가 이어지면 다른 id로 보는 것은
//!    옛 TS 그대로다(그래서 이 변경은 옛 결과를 줄이기만 하고 늘리지 않는다).
//! 3. id가 `R`+숫자 꼴이 아니면(빈 글자 포함) 메서드 이름은 아무것도 다루지 않는다. 옛 TS는 빈 id가 모든 메서드를 다룬다고 읽었다.
//! 4. 입력이 타입 선언과 다른 모양이면(옛 TS는 TypeError 또는 조용히 읽음) 이유가 담긴 오류로 던진다.
//! 5. `toLowerCase`는 Node의 ICU와 Rust 표준 라이브러리의 유니코드 버전이 다를 수 있다. 메서드 이름은 ASCII뿐이라 id가 ASCII로 소문자가
//!    되는 글자(`K` 켈빈 기호)만 영향을 주는데, 이는 `R`+숫자 꼴 검사(3)에서 걸러진다.
//! 6. 시험 이름에 짝 없는 서로게이트가 있으면 묶음 제목의 id를 받지 않는다(옛 TS와 같다. 아래 `mentioned_ids_of_test`).

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::js;
use crate::js_json::{js_less, nullish, object, JsValue};
use crate::requirements::{
    array, compile, compute_requirement_status, find_checkpoint_mention_indexes, find_gate_check_mention_indexes, find_mentioned_ids, is_likely_test_file, is_str,
    matrix_verification_badge, member, mention_matches, obj_of, opt_member, string, tpl, truthy, without_key, Res, S, STATUS_VERIFIED,
};
use crate::test_discovery::{discover_tests_in_file, flatten_discovered_file};

/// `\b(?:it|test)(?:\.\w+)?\s*\(\s*(['"`])` — 닫는 따옴표까지는 `quoted_end`가 손으로 읽는다(역참조를 못 쓴다)
static TEST_CALL_HEAD: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r#"(?-u:\b)(?:it|test)(?:\.[A-Za-z0-9_]+)?{S}*\({S}*(['"`])"#)));
/// `@DisplayName\s*\(\s*"`
static DISPLAY_NAME_HEAD: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r#"@DisplayName{S}*\({S}*""#)));
/// `\b(?:void|public|private|protected)\s+[\w<>[\],\s]*?\b(\w*[Rr]\d+\w*)\s*\(`
static METHOD_WITH_ID: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"(?-u:\b)(?:void|public|private|protected){S}+(?:[A-Za-z0-9_<>\[\],]|{S})*?(?-u:\b)([A-Za-z0-9_]*[Rr][0-9]+[A-Za-z0-9_]*){S}*\("
    ))
});

// ---------------------------------------------------------------------------
// 시험 파일 하나에서 뽑는 것
// ---------------------------------------------------------------------------

/// 시험 파일 하나에서 뽑아 둔 것. 어느 id를 찾든 같으므로 파일마다 한 번만 만든다
#[derive(Clone, Debug, PartialEq)]
pub struct FileIndex {
    /// 선언된 시험 이름과, 그 이름이 가리키는 id 전부(자기 이름에 단 것 + 감싼 묶음 제목에 단 것)
    pub names: Vec<(String, Vec<String>)>,
    /// id처럼 보이는 조각(R3 등)이 든 메서드 이름. 선언 순서대로, 중복 포함
    pub methods: Vec<String>,
}

/// 경로와 그 파일에서 뽑은 것. 시험 파일이 아니면 `index`가 없다
#[derive(Clone, Debug, PartialEq)]
pub struct IndexedFile {
    pub path: String,
    pub index: Option<FileIndex>,
}

/// 따옴표 문자열의 끝(닫는 따옴표의 바이트 위치). 앞에서부터 한 걸음씩: 따옴표를 만나면 끝(비탐욕·탐욕 모두 첫 따옴표에서 멈춘다).
/// 백슬래시 다음 글자를 건너뛰는 것(`\\.` 또는 `\\[\s\S]`)은 그 뒤에 따옴표가 아직 남아 있을 때만 한다 — 남아 있지 않으면 정규식이 되돌아가
/// 백슬래시 하나만 먹는다. 다음 글자가 줄 끝 글자일 때 `.`(@DisplayName)이 건너뛰지 않는 것은 결과에 차이가 없다(줄 끝 글자는 따옴표가 아니므로
/// 한 글자씩 가도 같은 자리에서 끝난다).
fn quoted_end(text: &str, begin: usize, quote: u8) -> Option<usize> {
    let bytes = text.as_bytes();
    let last_quote = begin + bytes[begin..].iter().rposition(|&b| b == quote)?;
    let mut p = begin;
    while p < bytes.len() {
        if bytes[p] == quote {
            return Some(p);
        }
        if bytes[p] == b'\\' {
            if let Some(next) = text[p + 1..].chars().next() {
                let after = p + 1 + next.len_utf8();
                if last_quote >= after {
                    p = after;
                    continue;
                }
            }
        }
        p += 1;
    }
    None
}

/// `head`가 맞는 곳마다 따옴표 문자열을 읽어 원문(이스케이프를 풀지 않은 글자)을 돌려준다. 앞부분이 맞아도 따옴표가 안 닫히면 다음 시작 위치에서 다시 찾는다
fn quoted_strings<'a>(head: &Regex, text: &'a str, quote_group: Option<usize>) -> Vec<&'a str> {
    let mut found = Vec::new();
    let mut at = 0;
    while at <= text.len() {
        let Some(caps) = head.captures_at(text, at) else { break };
        let whole = caps.get(0).expect("전체");
        let quote = match quote_group {
            Some(group) => caps.get(group).expect("따옴표"),
            None => whole,
        };
        let quote_byte = quote.as_str().as_bytes()[quote.as_str().len() - 1];
        match quoted_end(text, quote.end(), quote_byte) {
            Some(end) => {
                found.push(&text[quote.end()..end]);
                at = end + 1;
            }
            None => at = whole.start() + text[whole.start()..].chars().next().map_or(1, char::len_utf8),
        }
    }
    found
}

/// 파일 하나에서 it/test 호출 문자열과 @DisplayName 문자열을 모두 뽑는다(중복 없이)
fn declared_test_names(content: &str) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut names = Vec::new();
    let raw = quoted_strings(&TEST_CALL_HEAD, content, Some(1)).into_iter().chain(quoted_strings(&DISPLAY_NAME_HEAD, content, None));
    for name in raw {
        let trimmed = js::trim(name);
        if !trimmed.is_empty() && seen.insert(trimmed.to_owned()) {
            names.push(trimmed.to_owned());
        }
    }
    names
}

/// 시험 이름마다 그 시험을 감싼 묶음(describe·클래스) 제목에 단 id를 모은다. 발견기가 못 읽는 모양이면 비어 있다.
/// 같은 이름의 시험이 다른 묶음에 있으면 id를 합친다
fn suite_ids_by_test_name(path: &str, content: &str) -> Res<HashMap<String, Vec<String>>> {
    let Some(discovered) = discover_tests_in_file(path, content) else { return Ok(HashMap::new()) };
    let flat = flatten_discovered_file(&discovered.to_json())?;
    let rows: serde_json::Value = serde_json::from_str(&flat).map_err(|e| format!("평탄화한 발견 결과를 읽지 못했습니다: {e}"))?;
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows.as_array().ok_or("평탄화한 발견 결과가 배열이 아닙니다")? {
        let suite_path = row.get("suitePath").and_then(|v| v.as_array()).ok_or("suitePath가 배열이 아닙니다")?;
        if suite_path.is_empty() {
            continue;
        }
        let display_name = row.get("displayName").and_then(|v| v.as_str()).ok_or("displayName이 문자열이 아닙니다")?;
        let ids = by_name.entry(js::trim(display_name).to_owned()).or_default();
        for title in suite_path {
            for id in find_mentioned_ids(title.as_str().ok_or("묶음 제목이 문자열이 아닙니다")?) {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    Ok(by_name)
}

/// 시험 이름 하나가 가리키는 id 전부: 자기 이름에 단 것 + 감싼 묶음 제목에 단 것(중복 없이).
/// 이름에 짝 없는 서로게이트(껍데기가 U+E010으로 시작하는 글자로 바꿔 보낸 것)가 있으면 묶음 제목의 id를 받지 않는다 — 옛 TS는 발견기가 그 글자를
/// U+FFFD로 읽어 이름이 어긋났고 묶음 id를 못 받았다. 그 모양을 그대로 둔다(여는 쪽을 넓히지 않는다, 의도한 차이 6). 파일 내용은 UTF-8이라 실제로는 나타나지 않는다
fn mentioned_ids_of_test(name: &str, suite_ids: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let from_suites = if name.contains('\u{E010}') { None } else { suite_ids.get(name) };
    for id in find_mentioned_ids(name).into_iter().chain(from_suites.into_iter().flatten().cloned()) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// 시험 파일이면 파일에서 뽑은 것을 만든다. 시험 파일로 보이지 않으면 `None`. 발견기가 파일을 평탄화하지 못하면(너무 깊은 중첩) 오류다
pub fn file_index(path: &str, content: &str) -> Res<Option<FileIndex>> {
    if !is_likely_test_file(path) {
        return Ok(None);
    }
    let suite_ids = suite_ids_by_test_name(path, content)?;
    let names = declared_test_names(content).into_iter().map(|name| {
        let ids = mentioned_ids_of_test(&name, &suite_ids);
        (name, ids)
    });
    let methods = METHOD_WITH_ID.captures_iter(content).map(|c| c[1].to_owned()).collect();
    Ok(Some(FileIndex { names: names.collect(), methods }))
}

impl FileIndex {
    pub fn to_value(&self) -> JsValue {
        let names = self
            .names
            .iter()
            .map(|(name, ids)| object(vec![("name", Some(JsValue::str(name.as_str()))), ("ids", Some(JsValue::Arr(ids.iter().map(|id| JsValue::str(id.as_str())).collect())))]))
            .collect();
        object(vec![("names", Some(JsValue::Arr(names))), ("methods", Some(JsValue::Arr(self.methods.iter().map(|m| JsValue::str(m.as_str())).collect())))])
    }

    pub fn from_value(value: &JsValue) -> Res<FileIndex> {
        let strings = |v: Option<&JsValue>, what: &str| -> Res<Vec<String>> { array(v, what)?.iter().map(|s| string(Some(s), what).map(str::to_owned)).collect() };
        let mut names = Vec::new();
        for entry in array(member(Some(value), "names")?, "index.names")? {
            names.push((string(member(Some(entry), "name")?, "index.names[].name")?.to_owned(), strings(member(Some(entry), "ids")?, "index.names[].ids")?));
        }
        Ok(FileIndex { names, methods: strings(member(Some(value), "methods")?, "index.methods")? })
    }
}

/// `[{ path, index }]`. `index`가 null이면 시험 파일이 아니다
pub fn indexed_files(value: Option<&JsValue>) -> Res<Vec<IndexedFile>> {
    array(value, "testFiles")?
        .iter()
        .map(|file| {
            let path = string(member(Some(file), "path")?, "testFiles[].path")?.to_owned();
            let index = match member(Some(file), "index")? {
                None | Some(JsValue::Null) => None,
                Some(index) => Some(FileIndex::from_value(index)?),
            };
            Ok(IndexedFile { path, index })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// id로 견주기
// ---------------------------------------------------------------------------

/// 메서드 이름(ASCII)이 id를 다루는가. 옛 TS는 `identifier.toLowerCase().indexOf(id.toLowerCase())`로 처음 나온 자리만 보고, 그 뒤에 숫자가
/// 바로 이어지면(R31 등) 다른 id로 봤다. 여기에 "찾은 자리가 낱말의 시작일 것"을 더한다(의도한 차이 2·3): 낱말 가운데의 `r2`(`order2`)는 R2가 아니다.
fn identifier_mentions_id(identifier: &str, id: &str) -> bool {
    let wanted = id.to_lowercase();
    let wanted_bytes = wanted.as_bytes();
    if wanted_bytes.len() < 2 || wanted_bytes[0] != b'r' || !wanted_bytes[1..].iter().all(u8::is_ascii_digit) {
        return false;
    }
    let lowered = identifier.to_ascii_lowercase();
    let Some(index) = lowered.find(&wanted) else { return false };
    let bytes = identifier.as_bytes();
    if bytes.get(index + wanted_bytes.len()).is_some_and(u8::is_ascii_digit) {
        return false;
    }
    match index.checked_sub(1).map(|before| bytes[before]) {
        None => true,
        Some(before) if bytes[index] == b'R' => !before.is_ascii_uppercase(),
        Some(before) => !before.is_ascii_alphabetic(),
    }
}

/// 같은 id인가. 짝 없는 서로게이트가 U+FFFD로 합쳐진 글자는 같다고 보지 않는다(여는 쪽 비교라 닫는 쪽으로)
fn ids_equal(a: &str, b: &str) -> bool {
    a == b && !a.contains('\u{FFFD}')
}

/// 찾은 시험: `(파일 자리, 이름)`
pub type Found = Vec<(usize, String)>;

/// 작업 복사본의 시험 파일에서 id를 언급하는 시험 이름을 찾는다(요구사항 id가 시나리오 언급 R3.1도 포함한다)
pub fn scan_for_requirement_id(files: &[IndexedFile], id: &str) -> Found {
    let mut matches = Vec::new();
    for (position, file) in files.iter().enumerate() {
        let Some(index) = &file.index else { continue };
        let mut seen: HashSet<&str> = HashSet::new();
        for (name, ids) in &index.names {
            if ids.iter().any(|mention| mention_matches(mention, id)) && seen.insert(name) {
                matches.push((position, name.clone()));
            }
        }
        for method in &index.methods {
            if identifier_mentions_id(method, id) && seen.insert(method) {
                matches.push((position, method.clone()));
            }
        }
    }
    matches
}

/// 시나리오 id(R4.1 등)를 정확히 언급하는 시험 이름을 찾는다
pub fn scan_for_scenario_id(files: &[IndexedFile], scenario_id: &str) -> Found {
    let mut matches = Vec::new();
    for (position, file) in files.iter().enumerate() {
        let Some(index) = &file.index else { continue };
        for (name, ids) in &index.names {
            if ids.iter().any(|mention| ids_equal(mention, scenario_id)) {
                matches.push((position, name.clone()));
            }
        }
    }
    matches
}

/// 어떤 요구사항·시나리오 id도 언급하지 않은 시험("주인 없는 시험")
pub fn scan_for_orphans(files: &[IndexedFile]) -> Found {
    let mut matches = Vec::new();
    for (position, file) in files.iter().enumerate() {
        let Some(index) = &file.index else { continue };
        for (name, ids) in &index.names {
            if ids.is_empty() {
                matches.push((position, name.clone()));
            }
        }
    }
    matches
}

fn tests_value(files: &[IndexedFile], found: &Found) -> JsValue {
    JsValue::Arr(found.iter().map(|(position, name)| object(vec![("file", Some(JsValue::str(files[*position].path.as_str()))), ("name", Some(JsValue::str(name.as_str())))])).collect())
}

// ---------------------------------------------------------------------------
// 증거
// ---------------------------------------------------------------------------

fn pick_by_index(items: &[JsValue], indexes: &[usize]) -> JsValue {
    JsValue::Arr(indexes.iter().map(|&i| items[i].clone()).collect())
}

fn text_of(items: &[JsValue], key: &str, what: &str) -> Res<Vec<String>> {
    items.iter().map(|item| string(member(Some(item), key)?, what).map(str::to_owned)).collect()
}

fn checkpoints_mentioning(checkpoints: &[JsValue], id: &str) -> Res<JsValue> {
    let messages = text_of(checkpoints, "message", "체크포인트의 message")?;
    Ok(pick_by_index(checkpoints, &find_checkpoint_mention_indexes(&messages, id)))
}

fn gate_checks_mentioning(gate_checks: &[JsValue], id: &str) -> Res<JsValue> {
    let names = text_of(gate_checks, "name", "게이트 확인의 name")?;
    Ok(pick_by_index(gate_checks, &find_gate_check_mention_indexes(&names, id)))
}

/// 이 id가 붙은 테스트 탭 실행 행
fn runs_of<'a>(run_rows: &'a [JsValue], id: &str) -> Res<Vec<&'a JsValue>> {
    let mut matched = Vec::new();
    for row in run_rows {
        if let Some(JsValue::Str(row_id)) = member(Some(row), "id")? {
            if ids_equal(row_id, id) {
                matched.push(row);
            }
        }
    }
    Ok(matched)
}

/// 시나리오 하나의 증거. 체크포인트·시험·게이트는 시나리오 id로만 좁히고, 테스트 탭 실행은 이 시나리오 id가 붙은 시험만 따로 모아 다시 센다.
/// 문서 확인은 부모가 "전부 만족"일 때만 물려받는다
pub fn build_scenario_evidence(
    scenario_id: &str,
    checkpoints: &[JsValue],
    files: &[IndexedFile],
    gate_checks: &[JsValue],
    run_rows: &[JsValue],
    parent_evidence: Option<&JsValue>,
) -> Res<JsValue> {
    let matched = runs_of(run_rows, scenario_id)?;
    let count = |status: &str| -> Res<usize> {
        let mut n = 0;
        for row in &matched {
            if is_str(member(Some(row), "status")?, status) {
                n += 1;
            }
        }
        Ok(n)
    };
    let (passed, failed) = (count("pass")?, count("fail")?);
    let test_run = if passed + failed > 0 {
        let first = matched[0];
        let mut latest = member(Some(first), "at")?;
        for row in &matched {
            let at = member(Some(row), "at")?;
            if let (Some(candidate), Some(current)) = (at, latest) {
                if js_less(current, candidate) {
                    latest = Some(candidate);
                }
            }
        }
        Some(object(vec![
            ("at", latest.cloned()),
            ("sha", member(Some(first), "sha")?.cloned()),
            ("shortSha", member(Some(first), "shortSha")?.cloned()),
            ("passed", Some(JsValue::Num(passed as f64))),
            ("failed", Some(JsValue::Num(failed as f64))),
        ]))
    } else {
        None
    };
    let doc_evidence = opt_member(parent_evidence, "docEvidence").filter(|doc| truthy(opt_member(Some(doc), "satisfied"))).cloned();
    Ok(object(vec![
        ("checkpoints", Some(checkpoints_mentioning(checkpoints, scenario_id)?)),
        ("tests", Some(tests_value(files, &scan_for_scenario_id(files, scenario_id)))),
        ("gateChecks", Some(gate_checks_mentioning(gate_checks, scenario_id)?)),
        ("testRun", test_run),
        ("docEvidence", doc_evidence),
    ]))
}

/// 요구사항에 시나리오가 있는데, 그 시나리오 id로는 아직 `compute_requirement_status`가 "검증됨"을 주지 않는 시나리오 id만 모은다.
/// 사람 확인(요구사항 전체에 대한 것)과 문서 확인은 시나리오 상태를 전부 검증됨으로 만들어 버리므로 시나리오 평가에서 뺀다
pub fn find_unverified_scenario_ids(
    requirement: &JsValue,
    checkpoints: &[JsValue],
    files: &[IndexedFile],
    gate_checks: &[JsValue],
    run_rows: &[JsValue],
    parent_evidence: &JsValue,
) -> Res<Vec<JsValue>> {
    let scenarios: &[JsValue] = match member(Some(requirement), "scenarios")? {
        None | Some(JsValue::Null) => &[],
        scenarios => array(scenarios, "requirement.scenarios")?,
    };
    if scenarios.is_empty() {
        return Ok(Vec::new());
    }
    let automatic_requirement = JsValue::Obj(without_key(obj_of(requirement, "요구사항")?, "manualVerification"));
    let automatic_parent = JsValue::Obj(without_key(obj_of(parent_evidence, "부모 증거")?, "docEvidence"));
    let mut unverified = Vec::new();
    for scenario in scenarios {
        let id = member(Some(scenario), "id")?;
        let scenario_id = string(id, "시나리오 id")?;
        let evidence = build_scenario_evidence(scenario_id, checkpoints, files, gate_checks, run_rows, Some(&automatic_parent))?;
        if compute_requirement_status(&evidence, Some(&automatic_requirement))? != STATUS_VERIFIED {
            unverified.push(JsValue::str(scenario_id));
        }
    }
    Ok(unverified)
}

// ---------------------------------------------------------------------------
// 추적표
// ---------------------------------------------------------------------------

/// 매트릭스 시험 열 — 훑어 찾은 시험에, 지금 체크포인트에서 돈 실행 결과가 있으면 이름으로 맞춰 붙인다. 실행에만 있는 시험도 빠뜨리지 않는다.
/// skip은 "안 돌림"으로 합친다
fn merge_test_matches_with_run_rows(scanned: &[JsValue], run_rows: &[JsValue], id: &str) -> Res<JsValue> {
    let result_of = |status: Option<&JsValue>| -> Res<String> {
        let status = string(status, "테스트 실행 행의 status")?;
        Ok(if status == "skip" { "not-run".to_owned() } else { status.to_owned() })
    };
    let matched = runs_of(run_rows, id)?;
    let mut result_by_name: HashMap<&str, String> = HashMap::new();
    for row in &matched {
        result_by_name.insert(string(member(Some(row), "name")?, "테스트 실행 행의 name")?, result_of(member(Some(row), "status")?)?);
    }
    let mut merged: Vec<(String, JsValue)> = Vec::new();
    let mut position: HashMap<String, usize> = HashMap::new();
    for test in scanned {
        let name = string(member(Some(test), "name")?, "테스트의 name")?;
        let mut entry = obj_of(test, "테스트")?.clone();
        if let Some(result) = result_by_name.get(name) {
            entry.set("result", JsValue::str(result.as_str()));
        }
        match position.get(name) {
            Some(&at) => merged[at].1 = JsValue::Obj(entry),
            None => {
                position.insert(name.to_owned(), merged.len());
                merged.push((name.to_owned(), JsValue::Obj(entry)));
            }
        }
    }
    for row in &matched {
        let name = string(member(Some(row), "name")?, "테스트 실행 행의 name")?;
        if position.contains_key(name) {
            continue;
        }
        position.insert(name.to_owned(), merged.len());
        let entry = object(vec![("file", member(Some(row), "file")?.cloned()), ("name", Some(JsValue::str(name))), ("result", Some(JsValue::str(result_of(member(Some(row), "status")?)?)))]);
        merged.push((name.to_owned(), entry));
    }
    Ok(JsValue::Arr(merged.into_iter().map(|(_, entry)| entry).collect()))
}

struct RowParams<'a> {
    kind: &'static str,
    id: Option<&'a JsValue>,
    parent_id: Option<&'a JsValue>,
    title: Option<JsValue>,
    requirement: &'a JsValue,
    evidence: &'a JsValue,
    status: &'a str,
    run_rows: &'a [JsValue],
}

/// 증거·상태가 다 정해진 행 하나를 마무리한다(요구사항 행·시나리오 행이 공통)
fn finalize_matrix_row(p: &RowParams) -> Res<JsValue> {
    let id = string(p.id, "행의 id")?;
    let rev = match member(Some(p.requirement), "rev")? {
        Some(rev) if !nullish(Some(rev)) => rev.clone(),
        _ => JsValue::Num(1.0),
    };
    let trace = opt_member(Some(p.requirement), "trace");
    let tests = merge_test_matches_with_run_rows(array(member(Some(p.evidence), "tests")?, "evidence.tests")?, p.run_rows, id)?;
    Ok(object(vec![
        ("kind", Some(JsValue::str(p.kind))),
        ("id", Some(JsValue::str(id))),
        ("parentId", p.parent_id.filter(|parent| truthy(Some(parent))).cloned()),
        ("title", p.title.clone()),
        ("rev", Some(rev)),
        ("priority", member(Some(p.requirement), "priority")?.cloned()),
        ("issue", opt_member(trace, "issue").cloned()),
        ("checkpoints", member(Some(p.evidence), "checkpoints")?.cloned()),
        ("tests", Some(tests)),
        ("gateChecks", member(Some(p.evidence), "gateChecks")?.cloned()),
        ("status", Some(JsValue::str(p.status))),
        ("verifiedBy", Some(JsValue::str(matrix_verification_badge(p.status, p.evidence, Some(p.requirement))?))),
    ]))
}

/// 요구사항·시나리오마다 추적 행을 만들고, 주인 없는 시험·시험 없는 필수 요구사항을 모은다. 요구사항 행의 증거·상태는
/// `evaluationByRequirementId`가 있으면 그대로 쓰고(목록과 똑같다), 없으면 체크포인트·시험·게이트만으로 계산한다
pub fn build_traceability_matrix(input: &JsValue) -> Res<JsValue> {
    let requirements = array(member(Some(input), "requirements")?, "requirements")?;
    let checkpoints = array(member(Some(input), "checkpoints")?, "checkpoints")?;
    let gate_checks = array(member(Some(input), "gateChecks")?, "gateChecks")?;
    let files = indexed_files(member(Some(input), "testFiles")?)?;
    let evaluations = opt_member(Some(input), "evaluationByRequirementId");
    let run_rows: &[JsValue] = match member(Some(input), "testRunRows")? {
        None | Some(JsValue::Null) => &[],
        rows => array(rows, "testRunRows")?,
    };

    let mut rows = Vec::new();
    let mut must_haves_without_tests = Vec::new();
    let mut must_haves_verified_without_tests = Vec::new();

    for requirement in requirements {
        let requirement_id = member(Some(requirement), "id")?;
        let id = string(requirement_id, "요구사항 id")?;
        let evaluation = evaluations.and_then(|map| opt_member(Some(map), id)).filter(|evaluation| truthy(Some(evaluation)));
        let fallback;
        let (evidence, status): (&JsValue, String) = match evaluation {
            Some(evaluation) => {
                let evidence = member(Some(evaluation), "evidence")?.ok_or("평가에 evidence가 없습니다")?;
                (evidence, string(member(Some(evaluation), "status")?, "평가의 status")?.to_owned())
            }
            None => {
                let base = object(vec![
                    ("checkpoints", Some(checkpoints_mentioning(checkpoints, id)?)),
                    ("tests", Some(tests_value(&files, &scan_for_requirement_id(&files, id)))),
                    ("gateChecks", Some(gate_checks_mentioning(gate_checks, id)?)),
                ]);
                let missing = find_unverified_scenario_ids(requirement, checkpoints, &files, gate_checks, run_rows, &base)?;
                fallback = if missing.is_empty() {
                    base
                } else {
                    let mut with_missing = obj_of(&base, "증거")?.clone();
                    with_missing.set("missingScenarios", JsValue::Arr(missing));
                    JsValue::Obj(with_missing)
                };
                let status = compute_requirement_status(&fallback, Some(requirement))?.to_owned();
                (&fallback, status)
            }
        };
        rows.push(finalize_matrix_row(&RowParams {
            kind: "requirement",
            id: requirement_id,
            parent_id: None,
            title: member(Some(requirement), "title")?.cloned(),
            requirement,
            evidence,
            status: &status,
            run_rows,
        })?);

        let mut scenario_test_count = 0;
        let scenarios: &[JsValue] = match member(Some(requirement), "scenarios")? {
            None | Some(JsValue::Null) => &[],
            scenarios => array(scenarios, "requirement.scenarios")?,
        };
        for scenario in scenarios {
            let scenario_id = member(Some(scenario), "id")?;
            let scenario_evidence = build_scenario_evidence(string(scenario_id, "시나리오 id")?, checkpoints, &files, gate_checks, run_rows, Some(evidence))?;
            scenario_test_count += array(member(Some(&scenario_evidence), "tests")?, "evidence.tests")?.len();
            let title = format!(
                "(Given) {} (When) {} (Then) {}",
                tpl(member(Some(scenario), "given")?),
                tpl(member(Some(scenario), "when")?),
                tpl(member(Some(scenario), "then")?)
            );
            let scenario_status = compute_requirement_status(&scenario_evidence, Some(requirement))?;
            rows.push(finalize_matrix_row(&RowParams {
                kind: "scenario",
                id: scenario_id,
                parent_id: requirement_id,
                title: Some(JsValue::str(title)),
                requirement,
                evidence: &scenario_evidence,
                status: scenario_status,
                run_rows,
            })?);
        }

        let tests_len = array(member(Some(evidence), "tests")?, "evidence.tests")?.len();
        if is_str(member(Some(requirement), "priority")?, "must") && tests_len == 0 && scenario_test_count == 0 {
            if status == STATUS_VERIFIED {
                must_haves_verified_without_tests.push(requirement.clone());
            } else {
                must_haves_without_tests.push(requirement.clone());
            }
        }
    }

    Ok(object(vec![
        ("rows", Some(JsValue::Arr(rows))),
        ("orphanTests", Some(tests_value(&files, &scan_for_orphans(&files)))),
        ("mustHavesWithoutTests", Some(JsValue::Arr(must_haves_without_tests))),
        ("mustHavesVerifiedWithoutTests", Some(JsValue::Arr(must_haves_verified_without_tests))),
    ]))
}

/// napi 경계용: `[[파일 자리, 이름]]`
pub fn found_value(found: &Found) -> JsValue {
    JsValue::Arr(found.iter().map(|(position, name)| JsValue::Arr(vec![JsValue::Num(*position as f64), JsValue::str(name.as_str())])).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(path: &str, content: &str) -> IndexedFile {
        IndexedFile { path: path.to_owned(), index: file_index(path, content).unwrap() }
    }

    #[test]
    fn 메서드_이름은_낱말_시작에서만_id를_다룬다() {
        assert!(identifier_mentions_id("testR1Login", "R1"));
        assert!(identifier_mentions_id("r1_login", "R1"));
        assert!(identifier_mentions_id("test_r1_login", "R1"));
        assert!(identifier_mentions_id("validateOrderR2Total", "R2"));
        assert!(!identifier_mentions_id("calculatesOrder2Total", "R2"));
        assert!(!identifier_mentions_id("testServer3", "R3"));
        assert!(!identifier_mentions_id("checkERROR3", "R3"));
        assert!(!identifier_mentions_id("testR10Login", "R1"));
        assert!(!identifier_mentions_id("testR31ThenR3", "R3"));
        assert!(!identifier_mentions_id("testR1Login", ""));
        assert!(!identifier_mentions_id("testR1Login", "R"));
        assert!(!identifier_mentions_id("testR1Login", "R1.1"));
    }

    #[test]
    fn 따옴표_끝은_뒤에_따옴표가_있을_때만_이스케이프를_건너뛴다() {
        assert_eq!(quoted_end("a\\'b'", 0, b'\''), Some(4));
        assert_eq!(quoted_end("a\\'", 0, b'\''), Some(2));
        assert_eq!(quoted_end("abc", 0, b'\''), None);
        assert_eq!(quoted_end("a\\\n\"b\"", 0, b'"'), Some(3));
        assert_eq!(quoted_end("a\\\"\"", 0, b'"'), Some(3));
    }

    #[test]
    fn 시험_이름과_묶음_id를_한_번에_뽑는다() {
        let file = index("a.test.ts", "describe('R1 로그인', () => {\n  it('works', () => {});\n});\nit('R2 x', () => {});\nit('plain', () => {});\n");
        let files = [file];
        assert_eq!(scan_for_requirement_id(&files, "R1"), vec![(0, "works".to_owned())]);
        assert_eq!(scan_for_requirement_id(&files, "R2"), vec![(0, "R2 x".to_owned())]);
        assert_eq!(scan_for_orphans(&files), vec![(0, "plain".to_owned())]);
        assert!(scan_for_scenario_id(&files, "R1.1").is_empty());
    }

    #[test]
    fn 시험_파일이_아니면_색인이_없다() {
        assert!(file_index("a.ts", "it('R1 x', () => {});").unwrap().is_none());
    }

    #[test]
    fn 이름에_짝_없는_서로게이트가_있으면_묶음_id를_받지_않는다() {
        let encoded = "\u{E010}\u{E00D}\u{E008}\u{E000}";
        let content = format!("describe('R1', () => {{\n  it('works{encoded}', () => {{}});\n}});\n");
        let files = [index("a.test.ts", &content)];
        assert!(scan_for_requirement_id(&files, "R1").is_empty());
    }

    #[test]
    fn 같은_id라도_u_fffd가_든_것은_같다고_보지_않는다() {
        assert!(ids_equal("R1", "R1"));
        assert!(!ids_equal("R1\u{FFFD}", "R1\u{FFFD}"));
        assert!(!ids_equal("R1", "R10"));
    }

    #[test]
    fn 색인은_값으로_왕복한다() {
        let file = index("OrderTest.java", "class OrderTest {\n  @DisplayName(\"R3 주문\")\n  @Test void testR3Login() {}\n}\n");
        let back = FileIndex::from_value(&file.index.as_ref().unwrap().to_value()).unwrap();
        assert_eq!(Some(back), file.index);
    }

    #[test]
    fn 추적표는_모양이_어긋난_입력을_던진다() {
        let bad = crate::js_json::parse(r#"{"requirements":[{"id":"R1"}],"checkpoints":[],"gateChecks":[],"testFiles":[]}"#).unwrap();
        // 요구사항에 우선순위·제목이 없어도 던지지 않는다(옛 TS는 undefined로 읽는다)
        assert!(build_traceability_matrix(&bad).is_ok());
        let worse = crate::js_json::parse(r#"{"requirements":[{"id":"R1"}],"checkpoints":[{"createdAt":"x"}],"gateChecks":[],"testFiles":[]}"#).unwrap();
        assert!(build_traceability_matrix(&worse).is_err());
        let no_files = crate::js_json::parse(r#"{"requirements":[],"checkpoints":[],"gateChecks":[]}"#).unwrap();
        assert!(build_traceability_matrix(&no_files).is_err());
    }
}
