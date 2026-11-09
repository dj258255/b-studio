//! 요구사항 → 이슈 발행의 문안과 판정(옛 TS: `packages/agent/src/requirement-issues.ts`, ADR-191 3단계 3c).
//!
//! 순수 함수만 있다(파일·네트워크 없음). 입력은 TS가 `JSON.stringify`로 넘긴 값(`JsValue`)이고 JS가 읽던 규칙대로 읽는다:
//! 없는 필드는 템플릿 문자열에서 `undefined`로, `a ?? b`·`a && b`는 `nullish`·`truthy`로 옮겼다.
//! 정규식의 `\s`·`.`·`\S`는 JS의 글자 집합(`js::WS_CLASS`, 줄 끝 글자 네 개)으로 풀어 썼고 `\d`는 ASCII다.
//!
//! JS의 `/m` 정규식은 `^`·`$`가 `\n` 말고 `\r`·U+2028·U+2029 앞뒤에서도 맞는다. Rust `(?m)`은 `\n`만 본다.
//! 이 파일의 `/m` 정규식은 줄 끝 글자를 `\s`·`.`·`\S`로만 쓰고 잡은 값에도 줄 끝 글자가 들어가지 않으므로,
//! 줄 끝 글자 셋을 `\n`으로 바꾼 글에 돌려도 잡은 글자가 같다(`normalize_lines`).
//! 뒤보기(lookahead)가 든 두 정규식(`extractFormField`, `REGION_ACCEPTANCE`)은 손으로 옮겼다(`section_after_heading`).
//!
//! 의도한 차이: (1) 짝 없는 서로게이트는 Node 경계에서 U+FFFD가 된다(js_json 참고). (2) `managedRequirementToRequirement`가
//! 돌려주는 `acceptance` 등은 입력과 같은 배열 참조가 아니라 복사본이다(JSON 경계). (3) 입력이 타입 선언과 다른 모양이면
//! (예: `acceptance`가 배열이 아님) JS는 TypeError, 여기는 이유가 담긴 오류로 던진다.

use regex::{Regex, RegexBuilder};
use std::sync::LazyLock;

use crate::js::{self, number_to_string};
use crate::js_json::{nullish, object, opt_strict_equals, JsValue};
use crate::snapshots::{hex, Sha256};

pub const REQUIREMENT_LABEL: &str = "b-studio:req";

const S: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const NS: &str = r"[^\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

fn compile(pattern: &str) -> Regex {
    RegexBuilder::new(pattern)
        .size_limit(1 << 30)
        .build()
        .expect("정규식")
}

static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"<!--{S}*b-studio:req{S}+id=({NS}+){S}+rev=([0-9]+){S}+hash=({NS}+?){S}*-->"
    ))
});
static FOOTER: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"<!--{S}*/b-studio:req{S}*-->")));
static ID_FROM_TITLE: LazyLock<Regex> = LazyLock::new(|| compile(r"^\[(R[1-9][0-9]*)\]"));
static MENTION: LazyLock<Regex> = LazyLock::new(|| compile(r"\[(R[1-9][0-9]*)\]"));
static STATUS_ANY: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"<!--{S}*b-studio:req-status{S}+id={NS}+{S}*-->")));
static BARE_TITLE: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"^\[R(?:[1-9][0-9]*|\?)\]{S}*")));
static BULLET: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"^{S}*[-*]{S}+({DOT}+)$")));
static REGION_KIND_PRIORITY: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"(?m)^-{S}*종류:{S}*({NS}+){S}*·{S}*우선순위:{S}*({NS}+){S}*$"
    ))
});
static REGION_EARS: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"(?m)^-{S}*EARS\((ubiquitous|event|state|unwanted|optional)\):{S}*({DOT}+?){S}*$"
    ))
});
static REGION_NFR: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"(?m)^-{S}*NFR:{S}*지표{S}+({DOT}+?){S}*·{S}*임계값{S}+({DOT}+?){S}*·{S}*조건{S}+({DOT}+?){S}*·{S}*측정{S}+({DOT}+?){S}*$"
    ))
});
static REGION_SCENARIO_ROW: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"(?m)^\|{S}*(R[1-9][0-9]*\.[1-9][0-9]*){S}*\|{S}*({DOT}+?){S}*\|{S}*({DOT}+?){S}*\|{S}*({DOT}+?){S}*\|{S}*$"
    ))
});
static TRACKING_ROW_ISSUE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"(?m)^\|{S}*R[1-9][0-9]*{S}*\|{DOT}*\|{S}*#([0-9]+){S}*\|{S}*$"
    ))
});
static ALLOWED_ENDPOINTS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^/repos/[^/]+/[^/]+/issues$",
        r"^/repos/[^/]+/[^/]+/issues/[0-9]+$",
        r"^/repos/[^/]+/[^/]+/issues/[0-9]+/comments$",
        r"^/repos/[^/]+/[^/]+/issues/comments/[0-9]+$",
        r"^/repos/[^/]+/[^/]+/issues/[0-9]+/sub_issues$",
        r"^/repos/[^/]+/[^/]+/labels$",
    ]
    .iter()
    .map(|p| compile(p))
    .collect()
});

// ---------------------------------------------------------------------------
// JS 읽기 도우미
// ---------------------------------------------------------------------------

/// 템플릿 문자열 `${value}`: 없으면 `undefined`
fn tpl(v: Option<&JsValue>) -> String {
    v.map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
}

fn truthy(v: Option<&JsValue>) -> bool {
    v.is_some_and(JsValue::truthy)
}

fn is_str(v: Option<&JsValue>, expected: &str) -> bool {
    matches!(v, Some(JsValue::Str(s)) if s == expected)
}

fn array<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a [JsValue], String> {
    match v {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{what}은(는) 배열이어야 합니다")),
    }
}

fn object_of<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a JsValue, String> {
    match v {
        Some(o @ JsValue::Obj(_)) => Ok(o),
        _ => Err(format!("{what}은(는) 객체여야 합니다")),
    }
}

/// `\r`·U+2028·U+2029를 `\n`으로 바꾼다(글자 수는 그대로). `/m` 정규식의 `^`·`$`가 JS처럼 줄 끝 글자 넷에서 맞게 한다
fn normalize_lines(s: &str) -> String {
    s.chars()
        .map(|c| {
            if matches!(c, '\r' | '\u{2028}' | '\u{2029}') {
                '\n'
            } else {
                c
            }
        })
        .collect()
}

/// `text.split(/\r?\n/)`
fn split_crlf(text: &str) -> Vec<&str> {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    pieces
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            if i < last {
                p.strip_suffix('\r').unwrap_or(p)
            } else {
                p
            }
        })
        .collect()
}

fn skip_ws(text: &str, pos: usize) -> usize {
    let rest = &text[pos..];
    pos + (rest.len() - rest.trim_start_matches(js::is_js_whitespace).len())
}

/// `###\s*<parts를 \s*로 이은 글>\s*\n+([\s\S]*?)(?=<stops 중 하나>|$)`의 잡은 부분(뒤보기가 있어 정규식 대신 손으로 옮겼다).
/// 앞에서부터 `###`가 나오는 자리마다(겹쳐도) 시도해 처음 맞는 곳을 돌려준다. 맞으면 끝까지 맞는다 — 느긋한 `[\s\S]*?`는
/// 멈출 곳이 없으면 글 끝(`$`)까지 가기 때문이다. `\s*\n+`는 탐욕이라 `\s*`가 글자를 돌려주다 처음 만나는 `\n`, 곧 공백 덩어리의 마지막 `\n`에서 멈추고
/// 잡은 부분은 그 다음 글자에서 시작한다
fn section_after_heading<'a>(body: &'a str, parts: &[&str], stops: &[&str]) -> Option<&'a str> {
    let mut from = 0;
    while let Some(offset) = body[from..].find("###") {
        let start = from + offset;
        from = start + 1;
        let mut pos = start + 3;
        let mut matched = true;
        for part in parts {
            pos = skip_ws(body, pos);
            if !body[pos..].starts_with(part) {
                matched = false;
                break;
            }
            pos += part.len();
        }
        if !matched {
            continue;
        }
        let ws_end = skip_ws(body, pos);
        let Some(last_newline) = body[pos..ws_end].rfind('\n') else {
            continue;
        };
        let capture_start = pos + last_newline + 1;
        let mut capture_end = body.len();
        let mut scan = capture_start;
        while let Some(o) = body[scan..].find('\n') {
            let at = scan + o;
            if stops.iter().any(|stop| body[at..].starts_with(stop)) {
                capture_end = at;
                break;
            }
            scan = at + 1;
        }
        return Some(&body[capture_start..capture_end]);
    }
    None
}

// ---------------------------------------------------------------------------
// 해시·관리형 영역
// ---------------------------------------------------------------------------

/// `createHash('sha256').update(text.trim()).digest('hex').slice(0, 12)`
pub fn content_hash(text: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(js::trim(text).as_bytes());
    hex(&hash.finish())[..12].to_owned()
}

pub fn build_region_content(requirement: &JsValue) -> Result<String, String> {
    let acceptance = array(requirement.prop("acceptance"), "acceptance")?
        .iter()
        .map(|item| format!("- {}", item.to_js_string()))
        .collect::<Vec<_>>()
        .join("\n");
    let mut sections: Vec<String> = vec![format!(
        "- 종류: {} · 우선순위: {}",
        tpl(requirement.prop("kind")),
        tpl(requirement.prop("priority"))
    )];
    let ears = requirement.prop("ears");
    if truthy(ears) {
        let ears = ears.expect("있다");
        sections.push(String::new());
        sections.push("### 기능 요구사항".to_owned());
        sections.push(format!(
            "- EARS({}): {}",
            tpl(ears.prop("pattern")),
            tpl(ears.prop("statement"))
        ));
    }
    if truthy(requirement.prop("scenarios")) {
        let scenarios = array(requirement.prop("scenarios"), "scenarios")?;
        if !scenarios.is_empty() {
            sections.push(String::new());
            sections.push("### 시나리오".to_owned());
            sections.push("| id | Given | When | Then |".to_owned());
            sections.push("| --- | --- | --- | --- |".to_owned());
            for s in scenarios {
                sections.push(format!(
                    "| {} | {} | {} | {} |",
                    tpl(s.prop("id")),
                    tpl(s.prop("given")),
                    tpl(s.prop("when")),
                    tpl(s.prop("then"))
                ));
            }
        }
    }
    let nfr = requirement.prop("nfr");
    if truthy(nfr) {
        let nfr = nfr.expect("있다");
        sections.push(String::new());
        sections.push("### 비기능 요구사항".to_owned());
        sections.push(format!(
            "- NFR: 지표 {} · 임계값 {} · 조건 {} · 측정 {}",
            tpl(nfr.prop("metric")),
            tpl(nfr.prop("threshold")),
            tpl(nfr.prop("condition")),
            tpl(nfr.prop("method"))
        ));
    }
    sections.push(String::new());
    sections.push("### 인수 조건".to_owned());
    sections.push(acceptance);
    sections.push(String::new());
    sections.push("---".to_owned());
    sections.push(format!(
        "이 내용은 `docs/requirements.md`({})에서 자동으로 만들어졌습니다. **파일이 원본입니다** — 이 본문을 직접 고치지 말고 파일을 고친 뒤 다시 발행하세요. 발행 도구가 내용이 달라진 것을 감지하면 덮어쓰지 않고 충돌로 표시합니다.",
        tpl(requirement.prop("id"))
    ));
    Ok(sections.join("\n"))
}

pub fn requirement_content_hash(requirement: &JsValue) -> Result<String, String> {
    Ok(content_hash(&build_region_content(requirement)?))
}

pub fn build_managed_region(requirement: &JsValue, rev: f64) -> Result<String, String> {
    let content = build_region_content(requirement)?;
    let hash = content_hash(&content);
    Ok([
        format!(
            "<!-- b-studio:req id={} rev={} hash={} -->",
            tpl(requirement.prop("id")),
            number_to_string(rev),
            hash
        ),
        String::new(),
        content,
        String::new(),
        "<!-- /b-studio:req -->".to_owned(),
    ]
    .join("\n"))
}

pub struct ManagedRegion {
    pub id: String,
    pub rev: f64,
    pub hash: String,
    pub content: String,
}

/// 마커가 없거나 짝이 안 맞으면 `None`
pub fn parse_managed_region(body: &str) -> Option<ManagedRegion> {
    let header = HEADER.captures(body)?;
    let whole = header.get(0).expect("전체");
    let content_start = whole.end();
    let footer = FOOTER.find(&body[content_start..])?;
    let content_end = content_start + footer.start();
    Some(ManagedRegion {
        id: header[1].to_owned(),
        rev: js::to_number(&header[2]),
        hash: header[3].to_owned(),
        content: js::trim(&body[content_start..content_end]).to_owned(),
    })
}

pub fn managed_region_value(region: &ManagedRegion) -> JsValue {
    object(vec![
        ("id", Some(JsValue::str(&region.id))),
        ("rev", Some(JsValue::Num(region.rev))),
        ("hash", Some(JsValue::str(&region.hash))),
        ("content", Some(JsValue::str(&region.content))),
    ])
}

// ---------------------------------------------------------------------------
// 제목·라벨
// ---------------------------------------------------------------------------

pub fn sub_issue_title(requirement: &JsValue) -> String {
    format!(
        "[{}] {}",
        tpl(requirement.prop("id")),
        tpl(requirement.prop("title"))
    )
}

pub fn requirement_id_from_issue_title(title: &str) -> Option<String> {
    ID_FROM_TITLE
        .captures(js::trim(title))
        .map(|c| c[1].to_owned())
}

pub fn tracking_issue_title(project: &str) -> String {
    format!("요구사항: {project}")
}

/// 열린 것을 먼저, 그중 번호가 작은 것. `{ issue, url? }`
pub fn find_tracking_issue(
    issues: &JsValue,
    project_name: &str,
) -> Result<Option<JsValue>, String> {
    let JsValue::Arr(items) = issues else {
        return Err("issues는 배열이어야 합니다".to_owned());
    };
    let title = tracking_issue_title(project_name);
    let mut candidates: Vec<&JsValue> = Vec::new();
    for issue in items {
        let labels = array(issue.prop("labels"), "labels")?;
        if labels
            .iter()
            .any(|l| matches!(l, JsValue::Str(s) if s == REQUIREMENT_LABEL))
            && matches!(issue.prop("title"), Some(JsValue::Str(t)) if js::trim(t) == title)
        {
            candidates.push(issue);
        }
    }
    let sorted = js::stable_sort_by(candidates, &|a, b| {
        if opt_strict_equals(a.prop("state"), b.prop("state")) {
            tpl_number(a.prop("number")) - tpl_number(b.prop("number"))
        } else if is_str(a.prop("state"), "open") {
            -1.0
        } else {
            1.0
        }
    });
    Ok(sorted.first().map(|found| {
        let url = found.prop("url");
        object(vec![
            ("issue", found.prop("number").cloned()),
            ("url", if truthy(url) { url.cloned() } else { None }),
        ])
    }))
}

/// 뺄셈의 피연산자 `Number(value)`(없으면 NaN)
fn tpl_number(v: Option<&JsValue>) -> f64 {
    v.map_or(f64::NAN, JsValue::to_number)
}

pub fn requirement_label_set(requirement: &JsValue, status: &str) -> Vec<String> {
    vec![
        REQUIREMENT_LABEL.to_owned(),
        format!("kind:{}", tpl(requirement.prop("kind"))),
        format!("priority:{}", tpl(requirement.prop("priority"))),
        format!("status:{status}"),
    ]
}

// ---------------------------------------------------------------------------
// 하위 이슈 본문 · 추적 이슈 본문
// ---------------------------------------------------------------------------

pub fn build_tracking_issue_body(
    project_name: &str,
    rows: &JsValue,
    updated_at: Option<&str>,
) -> Result<String, String> {
    let rows = array(Some(rows), "rows")?;
    let mut table_rows: Vec<String> = Vec::new();
    let mut checklist: Vec<String> = Vec::new();
    for row in rows {
        let requirement = object_of(row.prop("requirement"), "requirement")?;
        if !truthy(row.prop("checklistOnly")) {
            let issue = row
                .prop("issue")
                .map_or_else(|| "-".to_owned(), |n| format!("#{}", n.to_js_string()));
            table_rows.push(format!(
                "| {} | {} | {} | {} | {} | {} |",
                tpl(requirement.prop("id")),
                tpl(requirement.prop("title")),
                tpl(requirement.prop("kind")),
                tpl(requirement.prop("priority")),
                tpl(row.prop("status")),
                issue
            ));
        } else {
            checklist.push(format!(
                "- [{}] {}. {}",
                if is_str(row.prop("status"), "검증됨") {
                    "x"
                } else {
                    " "
                },
                tpl(requirement.prop("id")),
                tpl(requirement.prop("title"))
            ));
        }
    }
    let updated_note = match updated_at {
        Some(at) if !at.is_empty() => format!(" 마지막 갱신: {at}."),
        _ => String::new(),
    };
    let mut lines: Vec<String> = vec![
        format!("`{project_name}`의 `docs/requirements.md`에서 자동으로 만든 요구사항 추적 이슈입니다. **파일이 원본입니다** — 이슈를 발행하거나 PR을 만들 때 상태를 다시 씁니다.{updated_note}"),
        String::new(),
        "| id | 제목 | 종류 | 우선순위 | 상태 | 하위 이슈 |".to_owned(),
        "| --- | --- | --- | --- | --- | --- |".to_owned(),
    ];
    lines.extend(table_rows);
    if !checklist.is_empty() {
        lines.push(String::new());
        lines.push("### 체크리스트 전용(could·docs — 하위 이슈를 만들지 않습니다)".to_owned());
        lines.extend(checklist);
    }
    Ok(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// 발행 계획
// ---------------------------------------------------------------------------

/// `trace.issue`가 있으면 그 번호로, 없으면 관리형 영역의 id 마커로 찾는다. 찾은 자리(없으면 `None`)
pub fn find_existing_remote_issue(
    requirement: &JsValue,
    remote_issues: &[JsValue],
) -> Option<usize> {
    let traced = requirement.prop("trace").and_then(|t| t.prop("issue"));
    if let Some(issue) = traced {
        return remote_issues
            .iter()
            .position(|r| opt_strict_equals(r.prop("number"), Some(issue)));
    }
    let id = requirement.prop("id");
    remote_issues.iter().position(|r| {
        parse_managed_region(&tpl(r.prop("body")))
            .is_some_and(|region| opt_strict_equals(Some(&JsValue::Str(region.id)), id))
    })
}

fn plan_entry(
    id: Option<&JsValue>,
    action: &str,
    issue: Option<JsValue>,
    local_hash: &str,
    remote_hash: Option<&str>,
    checklist_only: bool,
    note: String,
) -> JsValue {
    object(vec![
        ("id", id.cloned()),
        ("action", Some(JsValue::str(action))),
        ("issue", issue),
        ("localHash", Some(JsValue::str(local_hash))),
        ("remoteHash", remote_hash.map(JsValue::str)),
        ("checklistOnly", Some(JsValue::Bool(checklist_only))),
        ("note", Some(JsValue::Str(note))),
    ])
}

pub fn plan_requirement_publish(
    inputs: &JsValue,
    remote_issues: &JsValue,
) -> Result<JsValue, String> {
    let inputs = array(Some(inputs), "inputs")?;
    let remote = array(Some(remote_issues), "remoteIssues")?;
    let mut entries: Vec<JsValue> = Vec::new();
    for input in inputs {
        let requirement = object_of(input.prop("requirement"), "requirement")?;
        let status = input.prop("status");
        let local_hash = requirement_content_hash(requirement)?;
        let checklist_only = is_str(requirement.prop("priority"), "could")
            || is_str(requirement.prop("kind"), "docs");
        let id = requirement.prop("id");
        let Some(position) = find_existing_remote_issue(requirement, remote) else {
            let note = if checklist_only {
                "체크리스트 항목으로만 추적 이슈에 남습니다(하위 이슈를 만들지 않습니다)"
            } else {
                "하위 이슈를 새로 만듭니다"
            };
            entries.push(plan_entry(
                id,
                "create",
                None,
                &local_hash,
                None,
                checklist_only,
                note.to_owned(),
            ));
            continue;
        };
        let existing = &remote[position];
        let number = existing.prop("number");
        let issue = || number.cloned();
        let n = tpl(number);
        let remote_region = parse_managed_region(&tpl(existing.prop("body")));
        let remote_hash = remote_region.as_ref().map(|r| content_hash(&r.content));
        let last_published = requirement.prop("published").and_then(|p| p.prop("hash"));
        let remote_hash_value = remote_hash.as_deref().map(JsValue::str);
        let closed = is_str(existing.prop("state"), "closed");

        if let (Some(rh), Some(lp)) = (&remote_hash_value, last_published) {
            if !rh.strict_equals(lp) {
                entries.push(plan_entry(id, "conflict", issue(), &local_hash, remote_hash.as_deref(), checklist_only, format!("이슈 #{n}의 내용이 GitHub에서 직접 바뀌었습니다 — 가져오기·덮어쓰기·무시 중 골라 주세요")));
                continue;
            }
        }
        if opt_strict_equals(Some(&JsValue::str(&local_hash)), last_published) {
            if closed && !is_str(status, "검증됨") {
                entries.push(plan_entry(
                    id,
                    "closed_but_requirement_exists",
                    issue(),
                    &local_hash,
                    remote_hash.as_deref(),
                    checklist_only,
                    format!("이슈 #{n}는 닫혀 있지만 이 요구사항은 아직 검증되지 않았습니다"),
                ));
            } else {
                entries.push(plan_entry(
                    id,
                    "unchanged",
                    issue(),
                    &local_hash,
                    remote_hash.as_deref(),
                    checklist_only,
                    "바뀐 내용이 없습니다".to_owned(),
                ));
            }
            continue;
        }
        if closed {
            entries.push(plan_entry(
                id,
                "reverify",
                issue(),
                &local_hash,
                remote_hash.as_deref(),
                checklist_only,
                format!("내용이 바뀌어 이슈 #{n}를 다시 열고 \"재확인 필요\"로 표시합니다"),
            ));
        } else {
            entries.push(plan_entry(
                id,
                "update",
                issue(),
                &local_hash,
                remote_hash.as_deref(),
                checklist_only,
                format!("이슈 #{n} 본문을 갱신합니다"),
            ));
        }
    }
    Ok(JsValue::Arr(entries))
}

pub fn summarize_requirement_plan(entries: &JsValue) -> Result<JsValue, String> {
    let entries = array(Some(entries), "entries")?;
    let count = |action: &str| {
        entries
            .iter()
            .filter(|e| is_str(e.prop("action"), action))
            .count() as f64
    };
    let create = entries
        .iter()
        .filter(|e| is_str(e.prop("action"), "create") && !truthy(e.prop("checklistOnly")))
        .count() as f64;
    let checklist_only = entries
        .iter()
        .filter(|e| truthy(e.prop("checklistOnly")))
        .count() as f64;
    Ok(object(vec![
        ("total", Some(JsValue::Num(entries.len() as f64))),
        ("create", Some(JsValue::Num(create))),
        ("update", Some(JsValue::Num(count("update")))),
        ("unchanged", Some(JsValue::Num(count("unchanged")))),
        ("conflict", Some(JsValue::Num(count("conflict")))),
        ("reverify", Some(JsValue::Num(count("reverify")))),
        (
            "closedButRequirementExists",
            Some(JsValue::Num(count("closed_but_requirement_exists"))),
        ),
        ("checklistOnly", Some(JsValue::Num(checklist_only))),
    ]))
}

// ---------------------------------------------------------------------------
// 상태 댓글
// ---------------------------------------------------------------------------

pub fn build_status_comment(
    requirement_id: &str,
    status: &str,
    rows: &JsValue,
) -> Result<String, String> {
    let rows = array(Some(rows), "rows")?;
    let or_dash = |v: Option<&JsValue>| if nullish(v) { "-".to_owned() } else { tpl(v) };
    let body: Vec<String> = if rows.is_empty() {
        vec!["| (근거 없음) | - | - | - | - |".to_owned()]
    } else {
        rows.iter()
            .map(|row| {
                format!(
                    "| {} | {} | {} | {} | {} |",
                    tpl(row.prop("scenario")),
                    or_dash(row.prop("test")),
                    tpl(row.prop("result")),
                    or_dash(row.prop("commit")),
                    or_dash(row.prop("gate"))
                )
            })
            .collect()
    };
    let mut lines = vec![
        format!("<!-- b-studio:req-status id={requirement_id} -->"),
        format!("**상태: {status}**"),
        String::new(),
        "| 시나리오 | 테스트 | 결과 | 커밋 | 게이트 |".to_owned(),
        "| --- | --- | --- | --- | --- |".to_owned(),
    ];
    lines.extend(body);
    lines.push(String::new());
    lines.push("이 댓글은 b-studio가 자동으로 갱신합니다(새 댓글을 남기지 않고 이 댓글만 고칩니다). 직접 고치지 마세요.".to_owned());
    lines.push("<!-- /b-studio:req-status -->".to_owned());
    Ok(lines.join("\n"))
}

/// 요구사항 id를 주면(빈 문자열이 아니면) 그 요구사항 것인지까지
pub fn is_status_comment(body: &str, requirement_id: Option<&str>) -> bool {
    match requirement_id {
        Some(id) if !id.is_empty() => compile(&format!(
            r"<!--{S}*b-studio:req-status{S}+id={}{S}*-->",
            regex::escape(id)
        ))
        .is_match(body),
        _ => STATUS_ANY.is_match(body),
    }
}

/// 처음 맞는 댓글의 자리(없으면 -1)
pub fn find_pinned_status_comment(bodies: &[String], requirement_id: &str) -> i32 {
    bodies
        .iter()
        .position(|b| is_status_comment(b, Some(requirement_id)))
        .map_or(-1, |i| i as i32)
}

// ---------------------------------------------------------------------------
// PR 본문
// ---------------------------------------------------------------------------

pub fn implements_trailer(reference: &JsValue) -> String {
    match reference.prop("rev") {
        Some(rev) => format!(
            "Implements: {}@rev{}",
            tpl(reference.prop("id")),
            rev.to_js_string()
        ),
        None => format!("Implements: {}", tpl(reference.prop("id"))),
    }
}

pub fn extract_requirement_mentions(texts: &[String]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for text in texts {
        for m in MENTION.captures_iter(text) {
            let id = m[1].to_owned();
            if !found.contains(&id) {
                found.push(id);
            }
        }
    }
    found
}

pub fn build_requirements_addendum(refs: &JsValue, include_closes: bool) -> Result<String, String> {
    let refs = array(Some(refs), "refs")?;
    if refs.is_empty() {
        return Ok(String::new());
    }
    let closes: Vec<String> = if include_closes {
        refs.iter()
            .filter(|r| r.prop("issue").is_some() && is_str(r.prop("status"), "검증됨"))
            .map(|r| format!("Closes #{}", tpl(r.prop("issue"))))
            .collect()
    } else {
        Vec::new()
    };
    let note = if closes.is_empty() {
        ""
    } else {
        "\n\n(`Closes #n`은 이 PR이 기본 브랜치로 열릴 때만 이슈를 자동으로 닫습니다.)"
    };
    let mut lines = closes;
    lines.extend(refs.iter().map(implements_trailer));
    Ok(format!("\n\n{}{note}", lines.join("\n")))
}

pub fn build_review_requirements_context(entries: &JsValue) -> Result<String, String> {
    let entries = array(Some(entries), "entries")?;
    if entries.is_empty() {
        return Ok(String::new());
    }
    let mut lines: Vec<String> = Vec::new();
    for entry in entries {
        let scenarios = match entry.prop("scenarios") {
            Some(s) if !matches!(s, JsValue::Null) => array(Some(s), "scenarios")?
                .iter()
                .map(|s| {
                    format!(
                        "Given {} When {} Then {}",
                        tpl(s.prop("given")),
                        tpl(s.prop("when")),
                        tpl(s.prop("then"))
                    )
                })
                .collect::<Vec<_>>()
                .join(" / "),
            _ => String::new(),
        };
        let tail = if scenarios.is_empty() {
            String::new()
        } else {
            format!(" — {scenarios}")
        };
        lines.push(format!(
            "- {}. {}{tail}",
            tpl(entry.prop("id")),
            tpl(entry.prop("title"))
        ));
    }
    Ok(format!("[이 PR이 구현하는 요구사항]\n{}", lines.join("\n")))
}

// ---------------------------------------------------------------------------
// 이슈 폼
// ---------------------------------------------------------------------------

pub fn build_requirement_issue_form_yaml() -> String {
    [
        "name: 요구사항",
        "description: docs/requirements.md에 없는 요구사항을 제안합니다(b-studio가 나중에 가져올 수 있습니다)",
        "title: \"[R?] \"",
        "labels: [\"b-studio:req\"]",
        "body:",
        "  - type: input",
        "    id: title",
        "    attributes:",
        "      label: 제목",
        "    validations:",
        "      required: true",
        "  - type: dropdown",
        "    id: kind",
        "    attributes:",
        "      label: 종류",
        "      options:",
        "        - api",
        "        - ui",
        "        - data",
        "        - nonfunctional",
        "        - docs",
        "    validations:",
        "      required: true",
        "  - type: dropdown",
        "    id: priority",
        "    attributes:",
        "      label: 우선순위",
        "      options:",
        "        - must",
        "        - should",
        "        - could",
        "    validations:",
        "      required: true",
        "  - type: textarea",
        "    id: acceptance",
        "    attributes:",
        "      label: 인수 조건",
        "      description: 한 줄에 하나씩 적어 주세요",
        "    validations:",
        "      required: true",
        "",
    ]
    .join("\n")
}

/// GitHub 이슈 폼이 렌더링한 "### 레이블\n값" 구획 하나(값이 없으면 "_No response_")
fn extract_form_field(body: &str, label: &str) -> Option<String> {
    let value = js::trim(section_after_heading(body, &[label], &["\n###"])?);
    if !value.is_empty() && value != "_No response_" {
        Some(value.to_owned())
    } else {
        None
    }
}

/// `^\s*[-*]\s*`를 떼고 다듬는다
fn bullet_text(line: &str) -> &str {
    let start = skip_ws(line, 0);
    let rest = &line[start..];
    if rest.starts_with(['-', '*']) {
        js::trim(&line[skip_ws(line, start + 1)..])
    } else {
        js::trim(line)
    }
}

fn acceptance_lines(raw: Option<&str>, fallback: &str) -> Vec<String> {
    let lines: Vec<String> = split_crlf(raw.unwrap_or(""))
        .into_iter()
        .map(bullet_text)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    if lines.is_empty() {
        vec![fallback.to_owned()]
    } else {
        lines
    }
}

fn strings(items: &[String]) -> JsValue {
    JsValue::Arr(items.iter().map(JsValue::str).collect())
}

/// `[R4] ` 접두어나 이슈 폼 제목 기본값(`[R?] `)을 뗀다
fn bare_title(title: &str) -> String {
    let replaced = BARE_TITLE.replace(title, "");
    let stripped = js::trim(&replaced);
    if stripped.is_empty() {
        title.to_owned()
    } else {
        stripped.to_owned()
    }
}

fn draft_value(
    title: &str,
    kind: &str,
    priority: &str,
    acceptance: &[String],
    guessed: bool,
) -> JsValue {
    object(vec![
        ("title", Some(JsValue::str(title))),
        ("kind", Some(JsValue::str(kind))),
        ("priority", Some(JsValue::str(priority))),
        ("acceptance", Some(strings(acceptance))),
        ("guessed", Some(JsValue::Bool(guessed))),
    ])
}

pub fn parse_requirement_issue_form(title: &str, body: &str) -> Option<JsValue> {
    let first =
        |a: &str, b: &str| extract_form_field(body, a).or_else(|| extract_form_field(body, b));
    let form_title = first("제목", "Title");
    let kind = first("종류", "Kind");
    let priority = first("우선순위", "Priority");
    let acceptance_raw = first("인수 조건", "Acceptance Criteria");
    if form_title.is_none() && kind.is_none() && priority.is_none() && acceptance_raw.is_none() {
        return None;
    }
    let acceptance = acceptance_lines(
        acceptance_raw.as_deref(),
        form_title.as_deref().unwrap_or(title),
    );
    Some(draft_value(
        &form_title.clone().unwrap_or_else(|| bare_title(title)),
        kind.as_deref().unwrap_or("api"),
        priority.as_deref().unwrap_or("must"),
        &acceptance,
        kind.is_none() || priority.is_none() || acceptance_raw.is_none(),
    ))
}

/// 관리형 영역 본문에서 되읽는 값들(줄 끝 글자를 `\n`으로 맞춘 글에서 찾는다. 모듈 설명 참고)
struct RegionReads {
    kind: Option<String>,
    priority: Option<String>,
    acceptance: Vec<String>,
}

fn read_region(content: &str, title: &str) -> (RegionReads, String) {
    let normalized = normalize_lines(content);
    let kind_priority = REGION_KIND_PRIORITY.captures(&normalized);
    let accept_raw = section_after_heading(content, &["인수", "조건"], &["\n###", "\n---"]);
    let reads = RegionReads {
        kind: kind_priority.as_ref().map(|c| c[1].to_owned()),
        priority: kind_priority.as_ref().map(|c| c[2].to_owned()),
        acceptance: acceptance_lines(accept_raw, &bare_title(title)),
    };
    (reads, normalized)
}

pub fn draft_requirement_from_issue(title: &str, body: &str) -> JsValue {
    if let Some(managed) = parse_managed_region(body) {
        let (reads, _) = read_region(&managed.content, title);
        return draft_value(
            &bare_title(title),
            reads.kind.as_deref().unwrap_or("api"),
            reads.priority.as_deref().unwrap_or("must"),
            &reads.acceptance,
            reads.kind.is_none(),
        );
    }
    if let Some(form) = parse_requirement_issue_form(title, body) {
        return form;
    }
    let bullets: Vec<String> = split_crlf(body)
        .into_iter()
        .filter_map(|line| BULLET.captures(line).map(|c| js::trim(&c[1]).to_owned()))
        .filter(|l| !l.is_empty())
        .collect();
    let acceptance = if bullets.is_empty() {
        let head = js::truncate_utf16(js::trim(body), 500);
        vec![if head.is_empty() {
            title.to_owned()
        } else {
            head
        }]
    } else {
        bullets
    };
    draft_value(title, "api", "must", &acceptance, true)
}

pub fn draft_managed_requirement(title: &str, body: &str) -> Option<JsValue> {
    let managed = parse_managed_region(body)?;
    let (reads, normalized) = read_region(&managed.content, title);
    let ears = REGION_EARS.captures(&normalized).map(|c| {
        object(vec![
            ("pattern", Some(JsValue::str(&c[1]))),
            ("statement", Some(JsValue::str(&c[2]))),
        ])
    });
    let nfr = REGION_NFR.captures(&normalized).map(|c| {
        object(vec![
            ("metric", Some(JsValue::str(&c[1]))),
            ("threshold", Some(JsValue::str(&c[2]))),
            ("condition", Some(JsValue::str(&c[3]))),
            ("method", Some(JsValue::str(&c[4]))),
        ])
    });
    let scenarios: Vec<JsValue> = REGION_SCENARIO_ROW
        .captures_iter(&normalized)
        .map(|c| {
            object(vec![
                ("id", Some(JsValue::str(&c[1]))),
                ("given", Some(JsValue::str(&c[2]))),
                ("when", Some(JsValue::str(&c[3]))),
                ("then", Some(JsValue::str(&c[4]))),
            ])
        })
        .collect();
    Some(object(vec![
        ("id", Some(JsValue::str(&managed.id))),
        ("rev", Some(JsValue::Num(managed.rev))),
        ("title", Some(JsValue::Str(bare_title(title)))),
        (
            "kind",
            Some(JsValue::str(reads.kind.as_deref().unwrap_or("api"))),
        ),
        (
            "priority",
            Some(JsValue::str(reads.priority.as_deref().unwrap_or("must"))),
        ),
        ("acceptance", Some(strings(&reads.acceptance))),
        ("ears", ears),
        (
            "scenarios",
            if scenarios.is_empty() {
                None
            } else {
                Some(JsValue::Arr(scenarios))
            },
        ),
        ("nfr", nfr),
    ]))
}

/// 추적 이슈 본문 표의 `#N` 링크를 순서대로, 중복 없이
pub fn extract_tracking_sub_issue_numbers(body: &str) -> Vec<f64> {
    let normalized = normalize_lines(body);
    let mut numbers: Vec<f64> = Vec::new();
    for m in TRACKING_ROW_ISSUE_LINK.captures_iter(&normalized) {
        let n = js::to_number(&m[1]);
        if !numbers.iter().any(|x| js::same_value_zero(*x, n)) {
            numbers.push(n);
        }
    }
    numbers
}

pub fn managed_requirement_to_requirement(draft: &JsValue) -> JsValue {
    let kept = |key: &str| {
        if truthy(draft.prop(key)) {
            draft.prop(key).cloned()
        } else {
            None
        }
    };
    object(vec![
        ("id", draft.prop("id").cloned()),
        ("rev", draft.prop("rev").cloned()),
        ("title", draft.prop("title").cloned()),
        ("kind", draft.prop("kind").cloned()),
        ("priority", draft.prop("priority").cloned()),
        ("acceptance", draft.prop("acceptance").cloned()),
        ("ears", kept("ears")),
        ("scenarios", kept("scenarios")),
        ("nfr", kept("nfr")),
    ])
}

// ---------------------------------------------------------------------------
// API 경로 화이트리스트
// ---------------------------------------------------------------------------

pub fn is_allowed_requirement_endpoint(pathname: &str) -> bool {
    ALLOWED_ENDPOINTS.iter().any(|p| p.is_match(pathname))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json::parse;

    fn v(text: &str) -> JsValue {
        parse(text).expect("JSON")
    }

    #[test]
    fn 해시는_다듬은_글의_sha256_앞_12자다() {
        assert_eq!(content_hash("abc"), "ba7816bf8f01");
        assert_eq!(content_hash("\u{feff} abc\u{a0}\n"), "ba7816bf8f01");
        assert_eq!(content_hash("\u{85}abc"), content_hash("\u{85}abc"));
        assert_ne!(content_hash("\u{85}abc"), "ba7816bf8f01");
    }

    #[test]
    fn 관리형_영역을_쓰고_다시_읽는다() {
        let requirement =
            v(r#"{"id":"R1","title":"t","kind":"api","priority":"must","acceptance":["a","b"]}"#);
        let region = build_managed_region(&requirement, 3.0).unwrap();
        let parsed = parse_managed_region(&region).unwrap();
        assert_eq!((parsed.id.as_str(), parsed.rev), ("R1", 3.0));
        assert_eq!(parsed.content, build_region_content(&requirement).unwrap());
        assert_eq!(parsed.hash, requirement_content_hash(&requirement).unwrap());
    }

    #[test]
    fn 이슈_폼_구획은_마지막_개행_뒤에서_잡는다() {
        let body = "### 제목\n\nx\n\n### 종류\n\napi\n\n### 인수 조건\n\n- a\n- b";
        assert_eq!(extract_form_field(body, "제목").as_deref(), Some("x"));
        assert_eq!(extract_form_field(body, "종류").as_deref(), Some("api"));
        assert_eq!(
            extract_form_field(body, "인수 조건").as_deref(),
            Some("- a\n- b")
        );
        assert_eq!(extract_form_field("###제목 x", "제목"), None);
    }

    #[test]
    fn 줄_끝_글자는_m_정규식에서_줄_경계다() {
        let body = "<!-- b-studio:req id=R1 rev=1 hash=x -->\n- 종류: api\u{2028}·\r우선순위: must\n<!-- /b-studio:req -->";
        let draft = draft_managed_requirement("[R1] t", body).unwrap();
        assert!(js_json_text(&draft).contains("\"kind\":\"api\""));
    }

    fn js_json_text(value: &JsValue) -> String {
        crate::js_json::stringify(value)
    }

    #[test]
    fn 허용_경로() {
        assert!(is_allowed_requirement_endpoint(
            "/repos/a/b/issues/42/comments"
        ));
        assert!(!is_allowed_requirement_endpoint(
            "/repos/a/b/issues/42/comments/extra"
        ));
        assert!(!is_allowed_requirement_endpoint("/repos/a/b/issues\n"));
    }
}
