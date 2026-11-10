//! 설계 파이프라인(ADR-100)의 순수 판정(ADR-191 3단계 3o). 옛 `packages/agent/src/design-pipeline.ts`: 설계 문서 번호·경로,
//! "작업 묶음" 표 읽기, 요청 프롬프트·빈 틀, 설계 승인 확인(`check_design_approval`), 검토 독립성, 완료·성공 판정.
//! zod 스키마·타입·상수(경로 폴더, 안내 글자)는 TS에 남는다.
//!
//! 정규식은 모두 손으로 옮겼다(JS 되돌아감 우선순위를 따라): `^docs\/design\/(\d{2,})-.+\.md$`는 `docs::numbered_path`를 쓴다,
//! 표 머리 `\|\s*묶음\s*\|…[^|]*\|…`(어디서든 맞으면 된다, 글자 사이 `\s*`는 되돌아갈 일이 없다), `^(B\d+)\s*(.*)$`, `(\d+)\s*[-~]\s*(\d+)`.
//! `\s`는 JS 공백(`js::is_js_whitespace`), `\d`는 ASCII 숫자, `.`은 줄 끝 글자 넷(`\n \r U+2028 U+2029`)을 빼고 읽는다.
//!
//! 막는 검사: `check_design_approval`은 구현 시작을 막는다. 같음 비교만 쓴다(접두·대소문자 무시·포함으로 넓히지 않는다):
//! 상태는 정확히 `approved`일 때만 승인, 요구사항 id는 글자가 정확히 같을 때만 겹친다. 모르는 입력(글자가 아닌 상태)은 승인이 아니다.
//!
//! 의도한 차이: 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다. 그 밖에 옛 구현과 다른 입력은 없다(모양이 어긋난 설계 기록은
//! 옛 구현도 `.some`에서 던졌고 새 구현도 던진다. 승인된 기록은 요구사항 목록을 읽지 않는 점까지 같다).

use crate::docs::{next_number, numbered_path, pad, slugify_title, split_lines};
use crate::js::{self, is_js_whitespace};
use crate::js_json::{self, JsValue};
use std::collections::HashSet;

pub const DESIGN_PIPELINE_DIR: &str = "docs/design";
const DOC_PREFIX: &str = "docs/design/";

/// 기존 설계 파이프라인 문서 경로들에서 다음 번호(비어 있으면 1)
pub fn next_design_pipeline_doc_number(existing: &[String]) -> f64 {
    next_number(existing, DOC_PREFIX, 2)
}

/// `docs/design/NN-제목.md`
pub fn design_pipeline_doc_path(number: f64, title: &str) -> String {
    format!("{DESIGN_PIPELINE_DIR}/{}-{}.md", pad(number), slugify_title(title))
}

/// `docPath.replace(/\.md$/, '.meta.json')`: 끝이 `.md`일 때만 그 끝을 바꾼다
pub fn design_pipeline_sidecar_path(doc_path: &str) -> String {
    match doc_path.strip_suffix(".md") {
        Some(stem) => format!("{stem}.meta.json"),
        None => doc_path.to_owned(),
    }
}

pub fn is_design_pipeline_doc_path(file: &str) -> bool {
    numbered_path(file, DOC_PREFIX, 2).is_some()
}

// ---------------------------------------------------------------------------
// 작업 묶음 표
// ---------------------------------------------------------------------------

/// `/\|\s*묶음\s*\|\s*완료\s*조건\s*\|\s*예상\s*시간[^|]*\|\s*결과물\s*\|\s*쓰기\s*범위\s*\|/.test(line)`
enum Tok {
    Pipe,
    Lit(&'static str),
    Ws,
    NotPipe,
}

const HEADER: [Tok; 27] = [
    Tok::Pipe,
    Tok::Ws,
    Tok::Lit("묶음"),
    Tok::Ws,
    Tok::Pipe,
    Tok::Ws,
    Tok::Lit("완료"),
    Tok::Ws,
    Tok::Lit("조건"),
    Tok::Ws,
    Tok::Pipe,
    Tok::Ws,
    Tok::Lit("예상"),
    Tok::Ws,
    Tok::Lit("시간"),
    Tok::NotPipe,
    Tok::Pipe,
    Tok::Ws,
    Tok::Lit("결과물"),
    Tok::Ws,
    Tok::Pipe,
    Tok::Ws,
    Tok::Lit("쓰기"),
    Tok::Ws,
    Tok::Lit("범위"),
    Tok::Ws,
    Tok::Pipe,
];

/// 한 시작 위치에서 맞는지. `\s*`·`[^|]*` 바로 뒤는 늘 그 글자 묶음에 들지 않는 글자(`|`·한글)라 욕심껏 먹어도 되돌아갈 일이 없다
fn header_at(chars: &[char], start: usize) -> bool {
    let mut i = start;
    for tok in &HEADER {
        match tok {
            Tok::Pipe => {
                if chars.get(i) != Some(&'|') {
                    return false;
                }
                i += 1;
            }
            Tok::Lit(text) => {
                for c in text.chars() {
                    if chars.get(i) != Some(&c) {
                        return false;
                    }
                    i += 1;
                }
            }
            Tok::Ws => {
                while chars.get(i).is_some_and(|c| is_js_whitespace(*c)) {
                    i += 1;
                }
            }
            Tok::NotPipe => {
                while chars.get(i).is_some_and(|c| *c != '|') {
                    i += 1;
                }
            }
        }
    }
    true
}

fn is_bundle_table_header(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    (0..chars.len()).any(|start| chars[start] == '|' && header_at(&chars, start))
}

/// `line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(trim)`
fn split_table_row(line: &str) -> Vec<String> {
    let trimmed = js::trim(line);
    let no_head = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let no_tail = no_head.strip_suffix('|').unwrap_or(no_head);
    no_tail.split('|').map(|cell| js::trim(cell).to_owned()).collect()
}

/// `Number(ASCII 숫자 묶음)`. 아주 길면 Infinity(JS도 같다)
fn digits_to_number(digits: &str) -> f64 {
    digits.parse::<f64>().unwrap_or(f64::INFINITY)
}

fn digit_run_end(chars: &[char], from: usize) -> usize {
    let mut i = from;
    while chars.get(i).is_some_and(char::is_ascii_digit) {
        i += 1;
    }
    i
}

fn skip_ws(chars: &[char], from: usize) -> usize {
    let mut i = from;
    while chars.get(i).is_some_and(|c| is_js_whitespace(*c)) {
        i += 1;
    }
    i
}

/// "30-60", "30~60", "45"에서 분 단위 [최소, 최대]. 읽을 수 없으면 [0, 0]
/// `(\d+)\s*[-~]\s*(\d+)`는 왼쪽부터 처음 맞는 곳(숫자 묶음의 첫 글자에서만 시작할 수 있다), 없으면 `(\d+)` 첫 묶음
fn parse_estimate_range(text: &str) -> (f64, f64) {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut first_run: Option<(usize, usize)> = None;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let end = digit_run_end(&chars, i);
        first_run.get_or_insert((i, end));
        let after_ws = skip_ws(&chars, end);
        if matches!(chars.get(after_ws), Some('-' | '~')) {
            let second_start = skip_ws(&chars, after_ws + 1);
            let second_end = digit_run_end(&chars, second_start);
            if second_end > second_start {
                let min: String = chars[i..end].iter().collect();
                let max: String = chars[second_start..second_end].iter().collect();
                return (digits_to_number(&min), digits_to_number(&max));
            }
        }
        i = end;
    }
    match first_run {
        Some((start, end)) => {
            let n: String = chars[start..end].iter().collect();
            let value = digits_to_number(&n);
            (value, value)
        }
        None => (0.0, 0.0),
    }
}

/// `/^(B\d+)\s*(.*)$/.exec(cell)`: (id, 나머지). `.`이 줄 끝 글자를 못 먹으므로, 공백을 욕심껏 먹은 뒤 나머지에 줄 끝 글자가 없어야 맞는다
fn bundle_id_match(cell: &str) -> Option<(String, String)> {
    let rest = cell.strip_prefix('B')?;
    let digit_len = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digit_len == 0 {
        return None;
    }
    let tail = rest[digit_len..].trim_start_matches(is_js_whitespace);
    if tail.chars().any(js::is_js_line_terminator) {
        return None;
    }
    Some((format!("B{}", &rest[..digit_len]), tail.to_owned()))
}

struct Bundle {
    id: String,
    title: String,
    done_condition: String,
    estimate_min: f64,
    estimate_max: f64,
    deliverable: String,
    writable_scope: Vec<String>,
}

fn bundle_json(bundle: &Bundle) -> JsValue {
    js_json::object(vec![
        ("id", Some(JsValue::str(&bundle.id))),
        ("title", Some(JsValue::str(&bundle.title))),
        ("doneCondition", Some(JsValue::str(&bundle.done_condition))),
        ("estimateMinMinutes", Some(JsValue::Num(bundle.estimate_min))),
        ("estimateMaxMinutes", Some(JsValue::Num(bundle.estimate_max))),
        ("deliverable", Some(JsValue::str(&bundle.deliverable))),
        ("writableScope", Some(JsValue::Arr(bundle.writable_scope.iter().map(JsValue::str).collect()))),
    ])
}

/// 설계 문서 본문의 "작업 묶음" 표를 JSON 배열 글자로. 표를 못 찾으면 `[]`(막지 않는다)
pub fn parse_design_bundles_table(markdown: &str) -> String {
    let lines = split_lines(markdown);
    let Some(header_index) = lines.iter().position(|line| is_bundle_table_header(line)) else {
        return "[]".to_owned();
    };
    let mut bundles: Vec<Bundle> = Vec::new();
    // header_index + 1은 구분선 행이라 건너뛴다
    for line in lines.iter().skip(header_index + 2) {
        let line = js::trim(line);
        if !line.starts_with('|') {
            break;
        }
        let cells = split_table_row(line);
        if cells.len() < 5 {
            continue;
        }
        let (bundle_cell, done_condition, estimate_cell, deliverable, scope_cell) = (&cells[0], &cells[1], &cells[2], &cells[3], &cells[4]);
        let dashes = bundle_cell.replace(' ', "");
        if !dashes.is_empty() && dashes.bytes().all(|b| b == b'-') {
            continue; // 혹시 구분선이 두 번 들어와도 건너뛴다
        }
        let matched = bundle_id_match(bundle_cell);
        let id = match &matched {
            Some((id, _)) => id.clone(),
            None => format!("B{}", bundles.len() + 1),
        };
        let title_source = match &matched {
            Some((_, rest)) => rest.as_str(),
            None => bundle_cell.as_str(),
        };
        let title = js::trim(title_source);
        let title = if title.is_empty() { id.clone() } else { title.to_owned() };
        let (estimate_min, estimate_max) = parse_estimate_range(estimate_cell);
        let writable_scope = scope_cell.split(',').map(|entry| js::trim(entry).to_owned()).filter(|entry| !entry.is_empty()).collect();
        bundles.push(Bundle {
            id,
            title,
            done_condition: js::trim(done_condition).to_owned(),
            estimate_min,
            estimate_max,
            deliverable: js::trim(deliverable).to_owned(),
            writable_scope,
        });
    }
    js_json::to_native(&JsValue::Arr(bundles.iter().map(bundle_json).collect()))
}

// ---------------------------------------------------------------------------
// 요청 프롬프트 · 템플릿
// ---------------------------------------------------------------------------

fn join_ids(ids: &[String], empty: &str) -> String {
    if ids.is_empty() {
        empty.to_owned()
    } else {
        ids.join(", ")
    }
}

/// 설계 문서를 받을 때 쓰는 "조사"(읽기만) 모드 질문. `detail`은 앞뒤 공백을 뗀 글이 비어 있지 않을 때만 붙는다
pub fn build_design_pipeline_request_prompt(title: &str, requirement_ids: &[String], detail: Option<&str>) -> String {
    let ids = join_ids(requirement_ids, "(해당 없음)");
    let detail = match detail.map(js::trim) {
        Some(text) if !text.is_empty() => format!("\n\n{text}"),
        _ => String::new(),
    };
    format!(
        r#""{title}" 설계 문서를 써 주세요. 대상 요구사항: {ids}.{detail}

지금은 파일을 바꾸지 말고 읽기만 하세요. 실제 코드를 확인한 사실만 쓰고, 모르면 "불확실"이라고 적으세요.
아래 항목을 마크다운으로, 이 순서대로 답하세요:

## 대상 요구사항
(이 설계가 다루는 요구사항 id와 한 줄 설명)

## 접근
(전체 구현 방향)

## 데이터·API 계약 변경
(바뀌는 스키마·엔드포인트·타입. 없으면 "없음")

## 작업 묶음

| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |
| --- | --- | --- | --- | --- |
| B1 (묶음 제목) | (무엇이 되면 끝인지) | 30-60 | (어떤 파일·화면이 나오는지) | (쓸 경로, 쉼표로 구분) |

표 형식을 그대로 지키세요(다른 열을 추가하거나 빼지 마세요) — 플랫폼이 이 표로 예상 시간을 기록합니다.

## 위험·불확실성
(불확실한 점, 검증이 필요한 가정)

## 검증 방법
(각 작업 묶음을 어떻게 확인할지 — 게이트·테스트·화면 확인 등)"#
    )
}

/// 모델에게 묻지 않고 빈 틀로 바로 만들 때 쓰는 기본 틀
pub fn build_design_pipeline_doc_template(number: f64, title: &str, requirement_ids: &[String]) -> String {
    let ids = join_ids(requirement_ids, "(대상 요구사항을 적습니다)");
    let number = pad(number);
    format!(
        r#"# {number}. {title}

{title}에 관한 설계 문서입니다.

## 대상 요구사항

{ids}

## 접근

(전체 구현 방향을 적습니다)

## 데이터·API 계약 변경

(바뀌는 스키마·엔드포인트·타입을 적습니다. 없으면 "없음")

## 작업 묶음

| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |
| --- | --- | --- | --- | --- |

## 위험·불확실성

(불확실한 점, 검증이 필요한 가정을 적습니다)

## 검증 방법

(각 작업 묶음을 어떻게 확인할지 적습니다)
"#
    )
}

// ---------------------------------------------------------------------------
// 승인 게이트(서버 강제)
// ---------------------------------------------------------------------------

/// 요청 글에 언급된 요구사항 id가, 아직 승인되지 않은 설계 문서가 다루는 범위에 걸리는 기록의 순번들(오름차순).
/// 막는 검사다: 같음 비교(글자가 정확히 같을 때만)이고, 상태는 정확히 `approved`일 때만 승인이다.
/// `docs_json`은 `[{status, requirementIds}]`. 요청 id가 비면 기록은 읽지 않고 `[]`(옛 구현이 그 앞에서 돌려줬다).
/// 승인되지 않은 기록의 `requirementIds`가 배열이 아니면 던진다(옛 구현의 `.some`도 던졌다). 배열 안의 글자가 아닌 값은 어느 id와도 같지 않다.
pub fn check_design_approval(requirement_ids_in_request: &[String], docs_json: &str) -> Result<Vec<usize>, String> {
    if requirement_ids_in_request.is_empty() {
        return Ok(Vec::new());
    }
    let mentioned: HashSet<&str> = requirement_ids_in_request.iter().map(String::as_str).collect();
    let JsValue::Arr(docs) = js_json::parse_native(docs_json)? else {
        return Err("설계 문서 목록은 배열이어야 합니다".to_owned());
    };
    let mut blocking = Vec::new();
    for (index, doc) in docs.iter().enumerate() {
        let JsValue::Obj(object) = doc else {
            return Err("설계 문서 기록은 객체여야 합니다".to_owned());
        };
        if matches!(object.get("status"), Some(JsValue::Str(status)) if status == "approved") {
            continue;
        }
        let Some(JsValue::Arr(ids)) = object.get("requirementIds") else {
            return Err("설계 문서의 requirementIds는 배열이어야 합니다".to_owned());
        };
        if ids.iter().any(|id| matches!(id, JsValue::Str(s) if mentioned.contains(s.as_str()))) {
            blocking.push(index);
        }
    }
    Ok(blocking)
}

// ---------------------------------------------------------------------------
// 리뷰어 독립성 · 단계 판정
// ---------------------------------------------------------------------------

pub const SAME_FAMILY_REVIEW_LABEL: &str = "같은 계열 검토(독립성 낮음)";
pub const REVIEW_NOT_RUN_LABEL: &str = "검토 못 함";

/// 구현·검토가 같은 계열이면 `same-family`, 둘 중 하나라도 `unknown`이면 `unknown`, 다르면 `independent`
pub fn review_independence(implementer: &str, reviewer: &str) -> &'static str {
    if implementer == "unknown" || reviewer == "unknown" {
        "unknown"
    } else if implementer == reviewer {
        "same-family"
    } else {
        "independent"
    }
}

pub struct ReviewInput<'a> {
    pub ran: bool,
    pub passed: bool,
    pub independence: &'a str,
}

pub struct VerificationInput {
    pub ran: bool,
    pub ok: bool,
    pub tests_rerun: bool,
}

pub struct PipelineResult {
    pub design_approved: bool,
    pub completed: bool,
    pub succeeded: bool,
    pub reasons: Vec<String>,
}

/// "완료"(구현 체크포인트가 있다)와 "성공"(완료 + 승인 + 독립 검토 통과 + 검증 재실행 통과)을 나눠 판정한다.
/// 검토를 못 돌렸거나 같은 계열·계열을 모르면 성공이 아니고 이유를 남긴다. 성공이면 이유는 빈 목록
pub fn derive_design_pipeline_result(
    design_status: &str,
    checkpoint_exists: bool,
    review: Option<&ReviewInput>,
    verification: Option<&VerificationInput>,
) -> PipelineResult {
    let design_approved = design_status == "approved";
    let completed = checkpoint_exists;
    let mut reasons: Vec<String> = Vec::new();
    if !design_approved {
        reasons.push("설계가 승인되지 않았습니다".to_owned());
    }
    if !completed {
        reasons.push("구현 체크포인트가 없습니다".to_owned());
    }

    let mut review_ok = false;
    match review {
        Some(review) if review.ran => {
            if !review.passed {
                reasons.push("검토를 통과하지 못했습니다".to_owned());
            }
            if review.independence == "same-family" {
                reasons.push(SAME_FAMILY_REVIEW_LABEL.to_owned());
            } else if review.independence == "unknown" {
                reasons.push("검토자 계열을 확인할 수 없습니다".to_owned());
            }
            review_ok = review.passed && review.independence == "independent";
        }
        _ => reasons.push(REVIEW_NOT_RUN_LABEL.to_owned()),
    }

    let mut verification_ok = false;
    match verification {
        Some(verification) if verification.ran => {
            if !verification.ok {
                reasons.push("검증이 통과하지 못했습니다".to_owned());
            }
            if !verification.tests_rerun {
                reasons.push("테스트를 다시 돌리지 않았습니다".to_owned());
            }
            verification_ok = verification.ok && verification.tests_rerun;
        }
        _ => reasons.push("검증을 다시 돌리지 못했습니다".to_owned()),
    }

    let succeeded = design_approved && completed && review_ok && verification_ok;
    PipelineResult { design_approved, completed, succeeded, reasons: if succeeded { Vec::new() } else { reasons } }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn paths() {
        assert_eq!(next_design_pipeline_doc_number(&[]), 1.0);
        assert_eq!(next_design_pipeline_doc_number(&strs(&["docs/design/01-a.md", "docs/design/03-b.md", "docs/02-x.md"])), 4.0);
        assert!(is_design_pipeline_doc_path("docs/design/02-제목.md"));
        assert!(!is_design_pipeline_doc_path("docs/02-제목.md"));
        assert!(!is_design_pipeline_doc_path("Docs/design/02-제목.md"));
        assert!(!is_design_pipeline_doc_path("docs/design/2-제목.md"));
        assert_eq!(design_pipeline_doc_path(1.0, "채팅 입력 설계"), "docs/design/01-채팅-입력-설계.md");
        assert_eq!(design_pipeline_sidecar_path("docs/design/01-a.md"), "docs/design/01-a.meta.json");
        assert_eq!(design_pipeline_sidecar_path("docs/design/01-a.MD"), "docs/design/01-a.MD");
    }

    #[test]
    fn estimate() {
        assert_eq!(parse_estimate_range("30-60"), (30.0, 60.0));
        assert_eq!(parse_estimate_range("30 ~ 60분"), (30.0, 60.0));
        assert_eq!(parse_estimate_range("45"), (45.0, 45.0));
        assert_eq!(parse_estimate_range("약 5 - x 3-4"), (3.0, 4.0));
        assert_eq!(parse_estimate_range("없음"), (0.0, 0.0));
        assert_eq!(parse_estimate_range("5-"), (5.0, 5.0));
    }

    #[test]
    fn header_and_rows() {
        let md = "# t\n\n| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |\n| --- | --- | --- | --- | --- |\n| B1 로그인 | 통과 | 30-60 | 화면 | src/a, src/b |\n| 설명만 | x | 10 | y | |\n";
        let out = parse_design_bundles_table(md);
        assert!(out.contains(r#""id":"B1","title":"로그인""#), "{out}");
        assert!(out.contains(r#""id":"B2","title":"설명만""#), "{out}");
        assert_eq!(parse_design_bundles_table("| 묶음 | 완료 조건 |\n"), "[]");
    }

    #[test]
    fn approval() {
        let ids = strs(&["R-1"]);
        let docs = r#"[{"status":"draft","requirementIds":["R-10","r-1"," R-1","R-1 "]},{"status":"Approved","requirementIds":["R-1"]},{"status":"approved","requirementIds":["R-1"]},{"status":"approved","requirementIds":5}]"#;
        assert_eq!(check_design_approval(&ids, docs).unwrap(), vec![1]);
        assert!(check_design_approval(&[], "not json").unwrap().is_empty());
        assert!(check_design_approval(&ids, r#"[{"status":"draft","requirementIds":5}]"#).is_err());
        // 기록이 객체가 아니면 던진다(옛 구현은 `.some`에서 던졌다). 껍데기가 늘 객체로 만들어 넘기므로 이 가지는 Rust 시험으로만 닿는다
        assert!(check_design_approval(&ids, "[5]").is_err());
        assert!(check_design_approval(&ids, "[null]").is_err());
        assert!(check_design_approval(&ids, r#"{"status":"draft"}"#).is_err());
    }

    #[test]
    fn independence_and_result() {
        assert_eq!(review_independence("unknown", "claude"), "unknown");
        assert_eq!(review_independence("claude", "claude"), "same-family");
        assert_eq!(review_independence("claude", "openai"), "independent");
        let ok = derive_design_pipeline_result(
            "approved",
            true,
            Some(&ReviewInput { ran: true, passed: true, independence: "independent" }),
            Some(&VerificationInput { ran: true, ok: true, tests_rerun: true }),
        );
        assert!(ok.succeeded && ok.reasons.is_empty());
        let none = derive_design_pipeline_result("draft", false, None, None);
        assert_eq!(none.reasons.len(), 4);
    }
}
