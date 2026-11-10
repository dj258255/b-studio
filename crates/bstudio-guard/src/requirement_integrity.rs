//! 요구사항 문서(docs/requirements.md)의 "검증 기록" 무결성 판정(옛 TS: `packages/agent/src/requirement-integrity.ts`, ADR-191 3단계 3x).
//!
//! 사람이 남긴 수동 검증 기록(본문의 "- 확인:" 줄, 끝의 JSON 블록의 `manualVerification`)과 재확인 판정에 쓰는 `hash`·`revisedAt`을
//! 에이전트가 쓰기 도구로 위조·삭제했는지, 실행 전 문서와 지금 문서를 견주어 잡는다.
//!
//! 이 모듈이 하지 않는 것: `parseRequirementsMarkdown`(zod 스키마로 읽는 요구사항 목록)은 TS에 남는다. 그 결과가 필요한 자리
//! (`effectiveVerifications`·`requirementIds`)는 TS가 읽어 id 목록으로 넘긴다.
//!
//! 막는 쪽/여는 쪽: 전부 막는 판정이다(위조를 찾는다). 찾는 쪽이 놓치면 열린다. 그래서
//! - 문서 글자는 부르는 쪽이 `encodeLoneSurrogates`한 것을 받는다. 기록의 id·값·hash 같음 비교는 그 단사 인코딩 글자로 한다(짝 없는 서로게이트가 U+FFFD로
//!   합쳐져 "같다"가 되지 않게). JSON 블록 안의 `\ud800` 이스케이프도 같은 인코딩으로 읽는다(`js_json::parse_lone_encoded`).
//! - JSON 블록을 읽지 못한 이유가 JS도 읽지 못하는 글자(문법 오류)면 JS처럼 "블록 없음"으로 본다. 이 구현이 지원하는 깊이를 넘어서 읽지 못했으면
//!   JS는 읽는 것이므로 모른다는 뜻이다: 위조로 센다(`UNREADABLE_JSON_RECORD`). 되돌릴 때는 그 블록을 없는 것으로 보고 실행 전 항목에서 다시 붙인다.
//! - NUL로 시작하는 키도 JS처럼 받는다.
//!
//! 의도한 차이: (1) 중첩이 2000을 넘는 JSON 블록은 위조로 센다(JS는 읽는다). 닫는 쪽 차이다.
//! (2) 결과의 글자는 인코딩한 것이라 부르는 쪽이 풀어 읽는다. 되돌린 문서의 JSON 블록은 짝 없는 서로게이트를 `\udXXX` 이스케이프로 쓴다(`JSON.stringify`와 같다).

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use crate::js::{self, json_quote};
use crate::js_json::{self, JsObject, JsValue, LoneParseError};

pub const OUTSIDE: &str = "(요구사항 밖)";
pub const MANUAL_VERIFICATION_CHECK: &str = "manual-verification";
pub const MANUAL_VERIFICATION_REMOVED_CHECK: &str = "manual-verification-removed";
/// JSON 블록을 지원하는 깊이를 넘어 읽지 못했을 때 위조로 세는 기록의 글
pub const UNREADABLE_JSON_RECORD: &str = "(JSON 블록이 너무 깊어 읽지 못했습니다)";
/// 배열의 `at`(`Array.prototype.at`)을 `String()`으로 바꾼 글. `manualVerification`이 배열이면 JS는 `entry.at`으로 이 글을 읽는다
const ARRAY_AT_SOURCE: &str = "function at() { [native code] }";

const S: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const NS: &str = r"[^\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

fn compile(pattern: &str) -> Regex {
    regex::RegexBuilder::new(pattern).size_limit(1 << 30).build().expect("정규식")
}

static JSON_BLOCK: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"<!--{S}*b-studio-requirements{S}*((?s:.)*?)-->")));
static HEADING: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"^##{S}+(R[1-9][0-9]*)\.{S}*({DOT}+?){S}*$")));
static HASH2_SPACE: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"^##{S}")));
static STATUS_LINE: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"^-{S}*상태:")));
static MANUAL_LINE: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r"^-{S}*확인:{S}*({DOT}+?){S}*·{S}*([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}){S}*·{S}*체크포인트{S}+({NS}+){S}*·{S}*메모{S}+({DOT}+?){S}*$"
    ))
});

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Source {
    #[serde(rename = "본문")]
    Body,
    #[serde(rename = "JSON 블록")]
    Json,
}

impl Source {
    fn label(&self) -> &'static str {
        match self {
            Source::Body => "본문",
            Source::Json => "JSON 블록",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgedKind {
    Added,
    Changed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Forged {
    pub id: String,
    pub source: Source,
    pub kind: ForgedKind,
    pub record: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Removed {
    pub id: String,
    #[serde(rename = "requirementRemoved")]
    pub requirement_removed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TamperField {
    Hash,
    RevisedAt,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TamperKind {
    Changed,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tampered {
    pub id: String,
    pub field: TamperField,
    pub kind: TamperKind,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Diff {
    pub forged: Vec<Forged>,
    pub removed: Vec<Removed>,
    pub tampered: Vec<Tampered>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Check {
    pub stage: &'static str,
    pub name: &'static str,
    pub ok: bool,
    pub attempts: u32,
    pub detail: String,
}

struct Scanned {
    id: String,
    source: Source,
    value: String,
}

fn canonical(by: &str, at: &str, sha: &str, note: &str) -> String {
    format!("{by} · {at} · 체크포인트 {sha} · 메모 {note}")
}

/// `text.split(/\r?\n/)`
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in lines.iter_mut().take(last) {
        if let Some(stripped) = line.strip_suffix('\r') {
            *line = stripped;
        }
    }
    lines
}

/// JSON 블록을 뺀 글(`raw.replace(JSON_BLOCK, '')`, 첫 블록만)
fn without_json_block(raw: &str) -> String {
    match JSON_BLOCK.find(raw) {
        Some(m) => format!("{}{}", &raw[..m.start()], &raw[m.end()..]),
        None => raw.to_owned(),
    }
}

/// JSON 블록의 요구사항 항목들과, 이 읽기로는 읽지 못했는지(너무 깊음)
fn json_items(raw: &str) -> (Vec<JsObject>, bool) {
    let Some(captures) = JSON_BLOCK.captures(raw) else {
        return (Vec::new(), false);
    };
    let parsed = match js_json::parse_lone_encoded(&captures[1]) {
        Ok(parsed) => parsed,
        Err(LoneParseError::Invalid) => return (Vec::new(), false),
        Err(LoneParseError::TooDeep) => return (Vec::new(), true),
    };
    let list = match &parsed {
        JsValue::Arr(items) => Some(items.as_slice()),
        JsValue::Obj(o) => match o.get("requirements") {
            Some(JsValue::Arr(items)) => Some(items.as_slice()),
            _ => None,
        },
        _ => None,
    };
    let items = list
        .unwrap_or(&[])
        .iter()
        .filter_map(|item| match item {
            JsValue::Obj(o) if matches!(o.get("id"), Some(JsValue::Str(_))) => Some(o.clone()),
            _ => None,
        })
        .collect();
    (items, false)
}

fn item_id(item: &JsObject) -> &str {
    match item.get("id") {
        Some(JsValue::Str(id)) => id,
        _ => "",
    }
}

/// `String(entry[key] ?? '')`
fn text_field(entry: &JsObject, key: &str) -> String {
    match entry.get(key) {
        None | Some(JsValue::Null) => String::new(),
        Some(value) => value.to_js_string(),
    }
}

fn json_record(item: &JsObject) -> Option<String> {
    match item.get("manualVerification") {
        None | Some(JsValue::Null) => None,
        Some(JsValue::Arr(_)) => Some(canonical("", ARRAY_AT_SOURCE, "", "")),
        Some(JsValue::Obj(entry)) => Some(canonical(&text_field(entry, "by"), &text_field(entry, "at"), &text_field(entry, "sha"), &text_field(entry, "note"))),
        Some(other) => Some(other.to_js_string()),
    }
}

/// 문서 안의 사람 확인 기록을 요구사항 구조와 상관없이 전부 모은다. 둘째 값은 JSON 블록을 읽지 못했는지(너무 깊음)
fn scan_records(raw: Option<&str>) -> (Vec<Scanned>, bool) {
    let Some(raw) = raw else {
        return (Vec::new(), false);
    };
    let mut records = Vec::new();
    let mut current_id = OUTSIDE.to_owned();
    for line in split_lines(&without_json_block(raw)) {
        if let Some(heading) = HEADING.captures(line) {
            current_id = heading[1].to_owned();
            continue;
        }
        if HASH2_SPACE.is_match(line) {
            current_id = OUTSIDE.to_owned();
        }
        if let Some(m) = MANUAL_LINE.captures(line) {
            records.push(Scanned { id: current_id.clone(), source: Source::Body, value: canonical(&m[1], &m[2], &m[3], &m[4]) });
        }
    }
    let (items, too_deep) = json_items(raw);
    for item in &items {
        if let Some(value) = json_record(item) {
            records.push(Scanned { id: item_id(item).to_owned(), source: Source::Json, value });
        }
    }
    (records, too_deep)
}

/// 실행 전(before)과 지금(after)의 요구사항 문서를 견주어 검증 기록의 변화를 돌려준다.
/// `before_effective`·`after_effective`는 각 문서에서 `parseRequirementsMarkdown`이 읽은 요구사항 중 사람 확인이 있는 것의 id(읽은 순서, 중복 없이),
/// `after_ids`는 지금 문서의 모든 요구사항 id다
pub fn diff_verification_records(before: Option<&str>, after: Option<&str>, before_effective: &[String], after_effective: &[String], after_ids: &[String]) -> Diff {
    let mut diff = Diff::default();
    let Some(after) = after else {
        // 문서를 지웠다: 있던 사람 확인이 조용히 사라지므로 지운 것으로 남긴다
        for id in before_effective {
            diff.removed.push(Removed { id: id.clone(), requirement_removed: true });
        }
        return diff;
    };

    let (before_records, before_too_deep) = scan_records(before);
    let (after_records, after_too_deep) = scan_records(Some(after));
    for record in &after_records {
        if before_records.iter().any(|entry| entry.id == record.id && entry.source == record.source && entry.value == record.value) {
            continue;
        }
        let kind = if before_records.iter().any(|entry| entry.id == record.id && entry.source == record.source) { ForgedKind::Changed } else { ForgedKind::Added };
        diff.forged.push(Forged { id: record.id.clone(), source: record.source.clone(), kind, record: record.value.clone() });
    }
    // 읽지 못한 JSON 블록 안의 기록은 볼 수 없다. 통과로 이어지므로 위조로 센다
    if before_too_deep || after_too_deep {
        diff.forged.push(Forged { id: OUTSIDE.to_owned(), source: Source::Json, kind: ForgedKind::Changed, record: UNREADABLE_JSON_RECORD.to_owned() });
    }

    for id in before_effective {
        if !after_effective.contains(id) {
            diff.removed.push(Removed { id: id.clone(), requirement_removed: !after_ids.contains(id) });
        }
    }

    // 뒤의 같은 id가 이긴다(JS `Map`)
    let (after_items, _) = json_items(after);
    let (before_items, _) = json_items(before.unwrap_or(""));
    for item in &before_items {
        let id = item_id(item);
        if !after_ids.iter().any(|known| known == id) {
            continue; // 요구사항째 지운 것은 기록 조작이 아니다
        }
        let next = after_items.iter().rev().find(|candidate| item_id(candidate) == id);
        for (field, name) in [(TamperField::Hash, "hash"), (TamperField::RevisedAt, "revisedAt")] {
            let Some(old) = item.get(name) else { continue };
            match next.and_then(|n| n.get(name)) {
                None => diff.tampered.push(Tampered { id: id.to_owned(), field, kind: TamperKind::Removed }),
                Some(new) if !new.strict_equals(old) => diff.tampered.push(Tampered { id: id.to_owned(), field, kind: TamperKind::Changed }),
                Some(_) => {}
            }
        }
    }
    diff
}

/// 위조나 기록 조작이 있으면 true
pub fn has_verification_tamper(diff: &Diff) -> bool {
    !diff.forged.is_empty() || !diff.tampered.is_empty()
}

fn unique(ids: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

/// 게이트 실패 안내에 쓰는 한 줄 설명들
pub fn describe_verification_tamper(diff: &Diff) -> Vec<String> {
    let mut lines = Vec::new();
    for entry in &diff.forged {
        let place = if entry.id == OUTSIDE { "요구사항 헤딩 밖" } else { entry.id.as_str() };
        let what = if entry.kind == ForgedKind::Added { "새로 넣었습니다" } else { "바꿨습니다" };
        lines.push(format!("{place}: 이번 실행이 사람 확인 기록을 {what}({}) — {}", entry.source.label(), entry.record));
    }
    for entry in &diff.tampered {
        let field = match entry.field {
            TamperField::Hash => "hash",
            TamperField::RevisedAt => "revisedAt",
        };
        let what = if entry.kind == TamperKind::Removed { "지웠습니다" } else { "바꿨습니다" };
        lines.push(format!("{}: 재확인 필요 판정에 쓰는 {field}을(를) {what}(JSON 블록)", entry.id));
    }
    lines
}

/// 지운 사람 확인 기록 설명
pub fn describe_removed_verifications(diff: &Diff) -> Vec<String> {
    diff.removed
        .iter()
        .map(|entry| format!("{}: {} 사람 확인 기록이 지워졌습니다", entry.id, if entry.requirement_removed { "요구사항과 함께" } else { "요구사항은 남기고" }))
        .collect()
}

/// 위조된 요구사항 id 목록(중복 없이)
pub fn tampered_requirement_ids(diff: &Diff) -> Vec<String> {
    unique(diff.forged.iter().map(|e| e.id.clone()).chain(diff.tampered.iter().map(|e| e.id.clone())))
}

/// 요구사항 id의 구역 안에서 "- 상태:" 줄 앞(없으면 구역 끝)에 줄을 넣을 위치
fn insertion_index(lines: &[String], id: &str) -> Option<usize> {
    let start = lines.iter().position(|line| HEADING.captures(line).is_some_and(|c| &c[1] == id))?;
    let mut end = lines.len();
    for index in (start + 1)..lines.len() {
        if HASH2_SPACE.is_match(&lines[index]) {
            end = index;
            break;
        }
    }
    for index in (start + 1)..end {
        if STATUS_LINE.is_match(&lines[index]) {
            return Some(index);
        }
    }
    let mut last = end;
    while last > start + 1 && js::trim(&lines[last - 1]).is_empty() {
        last -= 1;
    }
    Some(last)
}

/// `JSON.stringify`가 문자열을 쓰는 글. 인코딩한 짝 없는 서로게이트는 `\udXXX` 이스케이프로 쓴다(예약 글자의 인코딩은 그대로 둔다: 부르는 쪽이 한 번에 푼다)
fn quote_encoded(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::from("\"");
    let mut plain = String::new();
    let mut i = 0;
    let flush = |plain: &mut String, out: &mut String| {
        if !plain.is_empty() {
            let quoted = json_quote(plain);
            out.push_str(&quoted[1..quoted.len() - 1]);
            plain.clear();
        }
    };
    while i < chars.len() {
        match js::read_lone_escape(&chars, i) {
            Some((Err(unit), used)) => {
                flush(&mut plain, &mut out);
                out.push_str(&format!("\\u{unit:04x}"));
                i += used;
            }
            _ => {
                plain.push(chars[i]);
                i += 1;
            }
        }
    }
    flush(&mut plain, &mut out);
    out.push('"');
    out
}

fn pretty(value: &JsValue) -> String {
    js_json::stringify_indent(value, 2, &quote_encoded)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Restore {
    /// 되돌릴 것이 없다(`after` 그대로)
    Unchanged,
    /// 되돌리는 도중 이 글의 `requirementIds`가 필요하다. 그 목록을 `text_ids`로 주고 다시 부른다
    NeedsIds(String),
    Text(String),
}

/// 실행이 남긴 요구사항 문서에서 검증 기록만 실행 전 값으로 되돌려 적은 문서
pub fn restore_verification_records(before: Option<&str>, after: &str, before_effective: &[String], after_effective: &[String], after_ids: &[String], text_ids: Option<&[String]>) -> Restore {
    let diff = diff_verification_records(before, Some(after), before_effective, after_effective, after_ids);
    if !has_verification_tamper(&diff) {
        return Restore::Unchanged;
    }
    let mut text = after.to_owned();

    if diff.forged.iter().any(|entry| entry.source == Source::Body) {
        let mut kept: Vec<String> = split_lines(&text).into_iter().filter(|line| !MANUAL_LINE.is_match(line)).map(str::to_owned).collect();
        // 실행 전 본문 기록을 다시 넣는다(그 요구사항이 아직 문서에 있을 때만)
        for record in scan_records(before).0.into_iter().filter(|entry| entry.source == Source::Body && entry.id != OUTSIDE) {
            if let Some(at) = insertion_index(&kept, &record.id) {
                kept.insert(at, format!("- 확인: {}", record.value));
            }
        }
        text = kept.join("\n");
    }

    let json_touched = diff.forged.iter().any(|entry| entry.source == Source::Json) || !diff.tampered.is_empty();
    if json_touched {
        // 뒤의 같은 id가 이기고 자리는 처음 것을 지킨다(JS `Map`)
        let mut base_items: Vec<(String, JsObject)> = Vec::new();
        for item in json_items(before.unwrap_or("")).0 {
            let id = item_id(&item).to_owned();
            match base_items.iter_mut().find(|(known, _)| *known == id) {
                Some(slot) => slot.1 = item,
                None => base_items.push((id, item)),
            }
        }
        let mut block_present = JSON_BLOCK.is_match(&text);
        if block_present {
            let captured = JSON_BLOCK.captures(&text).map(|c| (c.get(0).map(|m| (m.start(), m.end())), c[1].to_owned()));
            if let Some((Some((start, end)), body)) = captured {
                match js_json::parse_lone_encoded(&body) {
                    Ok(mut parsed) => {
                        let list: Option<&mut Vec<JsValue>> = match &mut parsed {
                            JsValue::Arr(items) => Some(items),
                            JsValue::Obj(o) => match o.get_mut("requirements") {
                                Some(JsValue::Arr(items)) => Some(items),
                                _ => None,
                            },
                            _ => None,
                        };
                        if let Some(list) = list {
                            for item in list.iter_mut() {
                                let JsValue::Obj(item) = item else { continue };
                                let base = match item.get("id") {
                                    Some(JsValue::Str(id)) => base_items.iter().find(|(known, _)| known == id).map(|(_, base)| base),
                                    _ => None,
                                };
                                item.remove("manualVerification");
                                if let Some(value) = base.and_then(|b| b.get("manualVerification")) {
                                    item.set("manualVerification", value.clone());
                                }
                                if let Some(base) = base {
                                    for field in ["hash", "revisedAt"] {
                                        match base.get(field) {
                                            Some(value) => item.set(field, value.clone()),
                                            None => item.remove(field),
                                        }
                                    }
                                }
                            }
                            text = format!("{}<!-- b-studio-requirements\n{}\n-->{}", &text[..start], pretty(&parsed), &text[end..]);
                        }
                    }
                    // 읽을 수 없는 JSON 블록은 파서도 읽지 않으므로 되돌릴 기록이 없다
                    Err(LoneParseError::Invalid) => {}
                    // 이 구현이 읽지 못하는 깊이다(JS는 읽는다). 블록을 없는 것으로 보고 실행 전 항목에서 다시 붙인다
                    Err(LoneParseError::TooDeep) => {
                        text = format!("{}{}", &text[..start], &text[end..]);
                        block_present = false;
                    }
                }
            }
        }
        if !block_present && !base_items.is_empty() {
            // JSON 블록을 통째로 지웠다: 실행 전 블록에서 지금 문서에 남은 요구사항의 항목만 다시 붙인다
            let Some(ids) = text_ids else {
                return Restore::NeedsIds(text);
            };
            let restored: Vec<JsValue> = base_items.iter().filter(|(id, _)| ids.contains(id)).map(|(_, item)| JsValue::Obj(item.clone())).collect();
            if !restored.is_empty() {
                let mut wrapper = JsObject::new();
                wrapper.set("requirements", JsValue::Arr(restored));
                wrapper.set("assumptions", JsValue::Arr(Vec::new()));
                wrapper.set("manualSteps", JsValue::Arr(Vec::new()));
                let body = pretty(&JsValue::Obj(wrapper));
                text = format!("{}\n\n<!-- b-studio-requirements\n{body}\n-->\n", text.trim_end_matches(js::is_js_whitespace));
            }
        }
    }
    Restore::Text(text)
}

/// 게이트의 리뷰 단계 검사
pub fn review_requirement_records(before: Option<&str>, after: Option<&str>, before_effective: &[String], after_effective: &[String], after_ids: &[String]) -> Vec<Check> {
    let diff = diff_verification_records(before, after, before_effective, after_effective, after_ids);
    let mut checks = Vec::new();
    if has_verification_tamper(&diff) {
        let ids = tampered_requirement_ids(&diff).join(", ");
        let lines: Vec<String> = describe_verification_tamper(&diff).iter().map(|line| format!("  - {line}")).collect();
        checks.push(Check {
            stage: "review",
            name: MANUAL_VERIFICATION_CHECK,
            ok: false,
            attempts: 1,
            detail: format!("docs/requirements.md의 검증 기록이 이번 실행에서 바뀌었습니다({ids}). 사람 확인은 화면에서 사람만 남길 수 있습니다. 이 기록을 되돌리세요(요구사항 본문은 그대로 고쳐도 됩니다):\n{}", lines.join("\n")),
        });
    }
    if !diff.removed.is_empty() {
        let lines: Vec<String> = describe_removed_verifications(&diff).iter().map(|line| format!("  - {line}")).collect();
        checks.push(Check {
            stage: "review",
            name: MANUAL_VERIFICATION_REMOVED_CHECK,
            ok: true,
            attempts: 1,
            detail: format!("이번 실행에서 사람 확인 기록이 지워져 해당 요구사항은 검증됨에서 내려갑니다. 의도한 것이 아니면 되돌리세요:\n{}", lines.join("\n")),
        });
    }
    checks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    const LINE: &str = "- 확인: 범수 · 2026-10-01 · 체크포인트 abc1234 · 메모 화면에서 확인";

    fn doc(extra: &str) -> String {
        format!("# 요구사항\n\n## R1. 제목\n- 종류: api · 우선순위: must\n- 인수 조건:\n  - a\n{extra}- 상태: 미착수\n")
    }

    #[test]
    fn 본문_기록을_새로_넣으면_위조다() {
        let before = doc("");
        let after = doc(&format!("{LINE}\n"));
        let diff = diff_verification_records(Some(&before), Some(&after), &[], &ids(&["R1"]), &ids(&["R1"]));
        assert_eq!(diff.forged.len(), 1);
        assert_eq!(diff.forged[0].kind, ForgedKind::Added);
        assert_eq!(diff.forged[0].record, "범수 · 2026-10-01 · 체크포인트 abc1234 · 메모 화면에서 확인");
        assert!(has_verification_tamper(&diff));
    }

    #[test]
    fn 같은_기록이면_위조가_아니다() {
        let both = doc(&format!("{LINE}\n"));
        let diff = diff_verification_records(Some(&both), Some(&both), &ids(&["R1"]), &ids(&["R1"]), &ids(&["R1"]));
        assert_eq!(diff, Diff::default());
    }

    #[test]
    fn 기록을_지우면_삭제로_센다() {
        let before = doc(&format!("{LINE}\n"));
        let after = doc("");
        let diff = diff_verification_records(Some(&before), Some(&after), &ids(&["R1"]), &[], &ids(&["R1"]));
        assert_eq!(diff.removed, vec![Removed { id: "R1".to_owned(), requirement_removed: false }]);
        assert!(!has_verification_tamper(&diff));
        let gone = diff_verification_records(Some(&before), None, &ids(&["R1"]), &[], &[]);
        assert_eq!(gone.removed, vec![Removed { id: "R1".to_owned(), requirement_removed: true }]);
    }

    #[test]
    fn json_블록의_hash를_바꾸면_조작이다() {
        let json = |hash: &str| format!("# 요구사항\n\n<!-- b-studio-requirements\n{{\"requirements\":[{{\"id\":\"R1\",\"hash\":\"{hash}\",\"revisedAt\":\"t\"}}]}}\n-->\n");
        let diff = diff_verification_records(Some(&json("a")), Some(&json("b")), &[], &[], &ids(&["R1"]));
        assert_eq!(diff.tampered, vec![Tampered { id: "R1".to_owned(), field: TamperField::Hash, kind: TamperKind::Changed }]);
        let gone = diff_verification_records(Some(&json("a")), Some("# 요구사항\n"), &[], &[], &ids(&["R1"]));
        assert_eq!(gone.tampered.len(), 2);
        assert!(gone.tampered.iter().all(|t| t.kind == TamperKind::Removed));
    }

    #[test]
    fn 이스케이프한_짝_없는_서로게이트는_서로_다른_글자다() {
        let json = |hash: &str| format!("<!-- b-studio-requirements\n{{\"requirements\":[{{\"id\":\"R1\",\"hash\":\"{hash}\"}}]}}\n-->\n");
        let diff = diff_verification_records(Some(&json("\\ud800")), Some(&json("\\ud801")), &[], &[], &ids(&["R1"]));
        assert_eq!(diff.tampered.len(), 1);
        let same = diff_verification_records(Some(&json("\\ud800")), Some(&json("\\ud800")), &[], &[], &ids(&["R1"]));
        assert!(same.tampered.is_empty());
    }

    #[test]
    fn 너무_깊은_json_블록은_위조로_센다() {
        let deep = format!("<!-- b-studio-requirements\n{}{}\n-->\n", "[".repeat(2100), "]".repeat(2100));
        let diff = diff_verification_records(Some(""), Some(&deep), &[], &[], &[]);
        assert_eq!(diff.forged.len(), 1);
        assert_eq!(diff.forged[0].record, UNREADABLE_JSON_RECORD);
    }

    #[test]
    fn 위조한_본문_기록은_실행_전_값으로_되돌린다() {
        let before = doc(&format!("{LINE}\n"));
        let after = doc("- 확인: 에이전트 · 2026-10-02 · 체크포인트 ffff · 메모 위조\n");
        let restored = restore_verification_records(Some(&before), &after, &ids(&["R1"]), &ids(&["R1"]), &ids(&["R1"]), None);
        assert_eq!(restored, Restore::Text(before));
    }

    #[test]
    fn 되돌릴_것이_없으면_그대로다() {
        let same = doc("");
        assert_eq!(restore_verification_records(Some(&same), &same, &[], &[], &ids(&["R1"]), None), Restore::Unchanged);
    }

    #[test]
    fn json_블록을_지우면_글의_요구사항_id를_물어본다() {
        let before = "# 요구사항\n\n## R1. 제목\n\n<!-- b-studio-requirements\n{\"requirements\":[{\"id\":\"R1\",\"hash\":\"a\"}]}\n-->\n";
        let after = "# 요구사항\n\n## R1. 제목\n";
        let first = restore_verification_records(Some(before), after, &[], &[], &ids(&["R1"]), None);
        assert!(matches!(first, Restore::NeedsIds(_)), "{first:?}");
        let Restore::Text(text) = restore_verification_records(Some(before), after, &[], &[], &ids(&["R1"]), Some(&ids(&["R1"]))) else { panic!() };
        assert!(text.ends_with("-->\n"));
        assert!(text.contains("\"hash\": \"a\""));
    }

    #[test]
    fn 검사_결과의_글은_옛_문구와_같다() {
        let before = doc("");
        let after = doc(&format!("{LINE}\n"));
        let checks = review_requirement_records(Some(&before), Some(&after), &[], &ids(&["R1"]), &ids(&["R1"]));
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].name, "manual-verification");
        assert!(!checks[0].ok);
        assert_eq!(
            checks[0].detail,
            "docs/requirements.md의 검증 기록이 이번 실행에서 바뀌었습니다(R1). 사람 확인은 화면에서 사람만 남길 수 있습니다. 이 기록을 되돌리세요(요구사항 본문은 그대로 고쳐도 됩니다):\n  - R1: 이번 실행이 사람 확인 기록을 새로 넣었습니다(본문) — 범수 · 2026-10-01 · 체크포인트 abc1234 · 메모 화면에서 확인"
        );
    }
}
