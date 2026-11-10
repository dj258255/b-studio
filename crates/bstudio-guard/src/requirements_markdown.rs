//! 요구사항 문서(docs/requirements.md)의 읽기·쓰기 규칙(옛 TS: `packages/agent/src/requirements.ts`의 마크다운 구간, ADR-191 3단계 3ab).
//!
//! 옮긴 것: 헤딩·종류/우선순위/개정·EARS·시나리오·인수 조건·NFR·추적·확인 줄 읽기, `## 가정`·`## 사람이 할 일` 절 읽기, 끝의 JSON 블록 찾기,
//! 몸통과 JSON 블록 값을 합치는 규칙(`mergeExtendedFieldsFromJsonBlock`), 요구사항 목록을 마크다운으로 쓰기(`serializeRequirementsMarkdown`).
//! 남긴 것: zod 스키마 검증(`RequirementSchema`·`JSON_BLOCK_SHAPE`·`LEGACY_JSON_BLOCK`)과 그 결과로 가르는 갈래. 이 모듈은 "초안"(검증 전 값)과 JSON 블록의 **글자**를 TS에 돌려주고,
//! TS가 그 글자를 `JSON.parse`·zod로 검증한 값을 `merge_stored`에 다시 건네 합친다. 3x(`requirement_integrity.rs`)의 기록 읽기와 같은 정규식·줄 나누기·JSON 블록 찾기를 이 모듈에서 가져다 쓴다
//! (규칙이 두 곳에 있으면 한쪽만 고쳐져 같은 문서를 다르게 읽게 된다).
//!
//! 막는 쪽/여는 쪽: 이 모듈 자체는 판정하지 않는다. 읽은 값(사람 확인 기록·시나리오 id·개정 번호)이 상태 판정(여는 쪽)의 입력이므로, 3x가 막는 쪽에서 같은 문서를 읽는다.
//! 읽는 규칙이 다를 수 있는 자리는 두 곳이고(요구사항 헤딩 밖에서 만난 `## ` 절 뒤의 "- 확인:" 줄, 몸통 검증이 하나라도 실패해 JSON 블록으로 되돌아가는 경우) 둘 다 3x가 더 넓게(위조로) 세는 닫는 쪽이다.
//! 글자는 부르는 쪽이 `encodeLoneSurrogates`한 것을 받고, 결과 글자도 같은 인코딩이다(부르는 쪽이 `decodeLoneSurrogates`로 푼다).
//!
//! 의도한 차이:
//! 1. 입력이 타입 선언과 다른 모양이면(`serialize`의 인수 조건이 배열이 아님 등) JS는 TypeError, 여기는 이유가 담긴 오류로 던진다.
//! 2. `statusById[id]`는 JS가 프로토타입 체인까지 읽는다(`id`가 `constructor`면 함수). 여기는 자기 키만 읽는다. 요구사항 id는 `R숫자`로 검증되어 닿지 않는다.
//! 3. 합친 요구사항에서 값이 `undefined`인 키는 JSON 경계에서 사라진다. 키 순서는 `{...요구사항, rev, ears, …}`와 같게 쓴다.

use regex::Regex;
use std::sync::LazyLock;

use crate::js;
use crate::js_json::{JsObject, JsValue};
use crate::requirements::{compile, DOT, S};

type Res<T> = Result<T, String>;

pub(crate) const NS: &str = r"[^\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

macro_rules! re {
    ($name:ident, $($arg:tt)*) => {
        pub(crate) static $name: LazyLock<Regex> = LazyLock::new(|| compile(&format!($($arg)*)));
    };
}

re!(JSON_BLOCK_RE, r"<!--{S}*b-studio-requirements{S}*((?s:.)*?)-->");
re!(HEADING_RE, r"^##{S}+(R[1-9][0-9]*)\.{S}*({DOT}+?){S}*$");
re!(HASH2_SPACE_RE, r"^##{S}");
re!(
    MANUAL_LINE_RE,
    r"^-{S}*확인:{S}*({DOT}+?){S}*·{S}*([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}){S}*·{S}*체크포인트{S}+({NS}+){S}*·{S}*메모{S}+({DOT}+?){S}*$"
);
re!(KIND_PRIORITY_RE, r"^-{S}*종류:{S}*({NS}+){S}*·{S}*우선순위:{S}*({NS}+)(?:{S}*·{S}*개정:{S}*([0-9]+))?{S}*$");
re!(EARS_RE, r"^-{S}*EARS\((ubiquitous|event|state|unwanted|optional)\):{S}*({DOT}+?){S}*$");
re!(SCENARIOS_HEADER_RE, r"^-{S}*시나리오:{S}*$");
re!(
    SCENARIO_ITEM_RE,
    r"^{S}+-{S}+(R[1-9][0-9]*\.[1-9][0-9]*):{S}*\(Given\){S}*({DOT}+?){S}*\(When\){S}*({DOT}+?){S}*\(Then\){S}*({DOT}+?){S}*$"
);
re!(ACCEPTANCE_HEADER_RE, r"^-{S}*인수{S}*조건:{S}*$");
re!(ACCEPTANCE_ITEM_RE, r"^{S}+-{S}+({DOT}+?){S}*$");
re!(NFR_RE, r"^-{S}*NFR:{S}*지표{S}+({DOT}+?){S}*·{S}*임계값{S}+({DOT}+?){S}*·{S}*조건{S}+({DOT}+?){S}*·{S}*측정{S}+({DOT}+?){S}*$");
re!(TRACE_RE, r"^-{S}*추적:{S}*({DOT}+?){S}*$");
re!(TRACE_ISSUE_RE, r"이슈{S}*#([0-9]+)");
re!(TRACE_SUPERSEDES_RE, r"대체{S}+(R[1-9][0-9]*)");
re!(ASSUMPTIONS_HEADING_RE, r"^##{S}*가정{S}*$");
re!(ASSUMPTION_ITEM_RE, r"^-{S}+({DOT}+?){S}*$");
re!(MANUAL_STEPS_HEADING_RE, r"^##{S}*사람이{S}*할{S}*일");

/// `text.split(/\r?\n/)`
pub(crate) fn split_lines(text: &str) -> Vec<&str> {
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
pub(crate) fn without_json_block(raw: &str) -> String {
    match JSON_BLOCK_RE.find(raw) {
        Some(m) => format!("{}{}", &raw[..m.start()], &raw[m.end()..]),
        None => raw.to_owned(),
    }
}

/// 첫 JSON 블록 주석 안의 글(`JSON_BLOCK.exec(raw)?.[1]`)
pub fn json_block_text(raw: &str) -> Option<String> {
    JSON_BLOCK_RE.captures(raw).map(|c| c[1].to_owned())
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Draft {
    id: String,
    title: String,
    kind: Option<String>,
    priority: Option<String>,
    acceptance: Vec<String>,
    rev: Option<f64>,
    ears: Option<(String, String)>,
    scenarios: Option<Vec<[String; 4]>>,
    nfr: Option<[String; 4]>,
    trace: Option<TraceDraft>,
    manual_verification: Option<[String; 4]>,
}

#[derive(Default)]
struct TraceDraft {
    issue: Option<f64>,
    depends_on: Option<Vec<String>>,
    supersedes: Option<String>,
}

fn strs(items: &[String]) -> JsValue {
    JsValue::Arr(items.iter().map(|s| JsValue::Str(s.clone())).collect())
}

fn obj(pairs: Vec<(&str, JsValue)>) -> JsValue {
    let mut o = JsObject::new();
    for (k, v) in pairs {
        o.set(k, v);
    }
    JsValue::Obj(o)
}

impl Draft {
    fn to_value(&self) -> JsValue {
        let mut o = JsObject::new();
        o.set("id", JsValue::Str(self.id.clone()));
        o.set("title", JsValue::Str(self.title.clone()));
        if let Some(kind) = &self.kind {
            o.set("kind", JsValue::Str(kind.clone()));
        }
        if let Some(priority) = &self.priority {
            o.set("priority", JsValue::Str(priority.clone()));
        }
        o.set("acceptance", strs(&self.acceptance));
        if let Some(rev) = self.rev {
            o.set("rev", JsValue::Num(rev));
        }
        if let Some((pattern, statement)) = &self.ears {
            o.set("ears", obj(vec![("pattern", JsValue::Str(pattern.clone())), ("statement", JsValue::Str(statement.clone()))]));
        }
        if let Some(scenarios) = &self.scenarios {
            let items = scenarios
                .iter()
                .map(|s| obj(vec![("id", JsValue::Str(s[0].clone())), ("given", JsValue::Str(s[1].clone())), ("when", JsValue::Str(s[2].clone())), ("then", JsValue::Str(s[3].clone()))]))
                .collect();
            o.set("scenarios", JsValue::Arr(items));
        }
        if let Some(nfr) = &self.nfr {
            o.set(
                "nfr",
                obj(vec![("metric", JsValue::Str(nfr[0].clone())), ("threshold", JsValue::Str(nfr[1].clone())), ("condition", JsValue::Str(nfr[2].clone())), ("method", JsValue::Str(nfr[3].clone()))]),
            );
        }
        if let Some(trace) = &self.trace {
            let mut t = JsObject::new();
            if let Some(issue) = trace.issue {
                t.set("issue", JsValue::Num(issue));
            }
            if let Some(depends) = &trace.depends_on {
                t.set("dependsOn", strs(depends));
            }
            if let Some(supersedes) = &trace.supersedes {
                t.set("supersedes", JsValue::Str(supersedes.clone()));
            }
            o.set("trace", JsValue::Obj(t));
        }
        if let Some(m) = &self.manual_verification {
            o.set(
                "manualVerification",
                obj(vec![("by", JsValue::Str(m[0].clone())), ("at", JsValue::Str(m[1].clone())), ("sha", JsValue::Str(m[2].clone())), ("note", JsValue::Str(m[3].clone()))]),
            );
        }
        JsValue::Obj(o)
    }
}

/// `/의존\s+([R0-9.,\s]+?)(?=\s*·|$)/`(되돌아감과 뒤보기가 든 정규식이라 손으로 옮겼다). 첫 "의존" 위치에서 `\s+`는 긴 쪽부터 줄여 보고,
/// 그룹은 짧은 쪽부터 늘리며 뒤보기(`\s*·` 또는 글자 끝)를 본다
fn depends_group(content: &str) -> Option<String> {
    let chars: Vec<char> = content.chars().collect();
    let n = chars.len();
    let in_class = |c: char| c == 'R' || c.is_ascii_digit() || c == '.' || c == ',' || js::is_js_whitespace(c);
    let lookahead = |q: usize| {
        if q == n {
            return true;
        }
        let mut r = q;
        while r < n && js::is_js_whitespace(chars[r]) {
            r += 1;
        }
        r < n && chars[r] == '·'
    };
    let mut p = 0;
    while p + 1 < n {
        if chars[p] == '의' && chars[p + 1] == '존' {
            let a = p + 2;
            let mut run = 0;
            while a + run < n && js::is_js_whitespace(chars[a + run]) {
                run += 1;
            }
            for k in (1..=run).rev() {
                let start = a + k;
                let mut q = start;
                while q < n && in_class(chars[q]) {
                    q += 1;
                    if lookahead(q) {
                        return Some(chars[start..q].iter().collect());
                    }
                }
            }
        }
        p += 1;
    }
    None
}

/// `parseTraceLine`: "- 추적: 이슈 #12 · 의존 R2, R3 · 대체 R1" 줄의 본문. 알아볼 조각이 없으면 `None`
fn parse_trace_line(content: &str) -> Option<TraceDraft> {
    let mut trace = TraceDraft::default();
    let mut any = false;
    if let Some(m) = TRACE_ISSUE_RE.captures(content) {
        // `Number(digits)`: 너무 길면 Infinity다(JSON 경계에서 null이 되어 zod가 거절한다. JS도 Infinity를 거절한다)
        trace.issue = Some(m[1].parse::<f64>().unwrap_or(f64::INFINITY));
        any = true;
    }
    if let Some(group) = depends_group(content) {
        let ids: Vec<String> = group.split(',').map(|item| js::trim(item).to_owned()).filter(|item| !item.is_empty()).collect();
        if !ids.is_empty() {
            trace.depends_on = Some(ids);
            any = true;
        }
    }
    if let Some(m) = TRACE_SUPERSEDES_RE.captures(content) {
        trace.supersedes = Some(m[1].to_owned());
        any = true;
    }
    any.then_some(trace)
}

/// `## 가정`·`## 사람이 할 일` 절 바로 아래의 글머리 기호 줄만 모은다. 다음 "##" 헤딩을 만나면 멈춘다
fn extract_section(lines: &[&str], heading: &Regex) -> Vec<String> {
    let mut items = Vec::new();
    let mut collecting = false;
    for line in lines {
        if heading.is_match(line) {
            collecting = true;
            continue;
        }
        if !collecting {
            continue;
        }
        if HASH2_SPACE_RE.is_match(line) {
            collecting = false;
            continue;
        }
        if let Some(item) = ASSUMPTION_ITEM_RE.captures(line) {
            items.push(item[1].to_owned());
        }
    }
    items
}

/// 몸통에서 읽은 것: 검증 전 초안들, 첫 JSON 블록의 글자, 두 절의 글머리 기호
pub struct BodyParse {
    drafts: Vec<Draft>,
    json_block: Option<String>,
    assumptions: Vec<String>,
    manual_steps: Vec<String>,
}

impl BodyParse {
    pub fn to_value(&self) -> JsValue {
        obj(vec![
            ("drafts", JsValue::Arr(self.drafts.iter().map(Draft::to_value).collect())),
            ("jsonBlock", self.json_block.as_ref().map_or(JsValue::Null, |text| JsValue::Str(text.clone()))),
            ("assumptions", strs(&self.assumptions)),
            ("manualSteps", strs(&self.manual_steps)),
        ])
    }
}

/// `parseRequirementsMarkdown`에서 zod 검증 앞의 몫. 던지지 않는다
pub fn parse_body(raw: &str) -> BodyParse {
    let body = without_json_block(raw);
    let lines = split_lines(&body);
    let mut drafts: Vec<Draft> = Vec::new();
    let mut current: Option<Draft> = None;
    let mut collecting_acceptance = false;
    let mut collecting_scenarios = false;

    for line in &lines {
        let line = *line;
        if let Some(heading) = HEADING_RE.captures(line) {
            if let Some(done) = current.take() {
                drafts.push(done);
            }
            current = Some(Draft { id: heading[1].to_owned(), title: heading[2].to_owned(), ..Draft::default() });
            collecting_acceptance = false;
            collecting_scenarios = false;
            continue;
        }
        let Some(cur) = current.as_mut() else {
            continue;
        };

        if let Some(m) = KIND_PRIORITY_RE.captures(line) {
            cur.kind = Some(m[1].to_owned());
            cur.priority = Some(m[2].to_owned());
            if let Some(rev) = m.get(3) {
                cur.rev = Some(rev.as_str().parse::<f64>().unwrap_or(f64::INFINITY));
            }
            collecting_acceptance = false;
            collecting_scenarios = false;
            continue;
        }
        if let Some(m) = EARS_RE.captures(line) {
            cur.ears = Some((m[1].to_owned(), m[2].to_owned()));
            collecting_acceptance = false;
            collecting_scenarios = false;
            continue;
        }
        if SCENARIOS_HEADER_RE.is_match(line) {
            collecting_scenarios = true;
            collecting_acceptance = false;
            continue;
        }
        if collecting_scenarios {
            if let Some(m) = SCENARIO_ITEM_RE.captures(line) {
                cur.scenarios.get_or_insert_with(Vec::new).push([m[1].to_owned(), m[2].to_owned(), m[3].to_owned(), m[4].to_owned()]);
                continue;
            }
            collecting_scenarios = false;
            // 시나리오 절 바로 다음 줄(보통 "인수 조건:")도 이어서 검사한다
        }
        if ACCEPTANCE_HEADER_RE.is_match(line) {
            collecting_acceptance = true;
            continue;
        }
        if collecting_acceptance {
            if let Some(m) = ACCEPTANCE_ITEM_RE.captures(line) {
                cur.acceptance.push(m[1].to_owned());
                continue;
            }
            collecting_acceptance = false;
        }
        if let Some(m) = NFR_RE.captures(line) {
            cur.nfr = Some([m[1].to_owned(), m[2].to_owned(), m[3].to_owned(), m[4].to_owned()]);
            continue;
        }
        if let Some(m) = TRACE_RE.captures(line) {
            if let Some(trace) = parse_trace_line(&m[1]) {
                cur.trace = Some(trace);
            }
            continue;
        }
        if let Some(m) = MANUAL_LINE_RE.captures(line) {
            cur.manual_verification = Some([m[1].to_owned(), m[2].to_owned(), m[3].to_owned(), m[4].to_owned()]);
        }
    }
    if let Some(done) = current.take() {
        drafts.push(done);
    }

    BodyParse {
        drafts,
        json_block: json_block_text(raw),
        assumptions: extract_section(&lines, &ASSUMPTIONS_HEADING_RE),
        manual_steps: extract_section(&lines, &MANUAL_STEPS_HEADING_RE),
    }
}

/// `mergeExtendedFieldsFromJsonBlock`의 합치기. `requirements`는 몸통에서 읽어 zod가 검증한 목록, `stored`는 JSON 블록에서 zod가 검증한 요구사항 목록(블록이 없거나 깨졌으면 빈 목록).
/// 같은 id가 여럿이면 뒤의 것이 이긴다(`new Map`). hash·revisedAt은 늘 블록 값이고, 나머지는 몸통 값을 우선한다
pub fn merge_stored(requirements: &JsValue, stored: &JsValue) -> Res<JsValue> {
    let JsValue::Arr(requirements) = requirements else {
        return Err("요구사항 목록은 배열이어야 합니다".to_owned());
    };
    let JsValue::Arr(stored) = stored else {
        return Err("JSON 블록의 요구사항 목록은 배열이어야 합니다".to_owned());
    };
    let mut by_id: Vec<(&str, &JsObject)> = Vec::new();
    for item in stored {
        if let JsValue::Obj(o) = item {
            if let Some(JsValue::Str(id)) = o.get("id") {
                match by_id.iter_mut().find(|(known, _)| known == id) {
                    Some(slot) => slot.1 = o,
                    None => by_id.push((id, o)),
                }
            }
        }
    }
    let mut out = Vec::new();
    for item in requirements {
        let JsValue::Obj(req) = item else {
            return Err("요구사항은 객체여야 합니다".to_owned());
        };
        let Some(JsValue::Str(id)) = req.get("id") else {
            out.push(item.clone());
            continue;
        };
        let Some((_, stored)) = by_id.iter().find(|(known, _)| known == id) else {
            out.push(item.clone());
            continue;
        };
        let mut merged = req.clone();
        // 몸통 값 우선: `requirement.x ?? stored.x`
        for key in ["rev", "ears", "scenarios", "nfr", "trace"] {
            let value = match req.get(key) {
                Some(v) if !matches!(v, JsValue::Null) => Some(v),
                _ => stored.get(key),
            };
            if let Some(v) = value {
                merged.set(key, v.clone());
            }
        }
        // hash·revisedAt은 몸통에 없는 값이라 늘 블록 값(`stored.hash`)이다
        for key in ["hash", "revisedAt"] {
            if let Some(v) = stored.get(key) {
                merged.set(key, v.clone());
            }
        }
        let value = match req.get("manualVerification") {
            Some(v) if !matches!(v, JsValue::Null) => Some(v),
            _ => stored.get("manualVerification"),
        };
        if let Some(v) = value {
            merged.set("manualVerification", v.clone());
        }
        out.push(JsValue::Obj(merged));
    }
    Ok(JsValue::Arr(out))
}

// ---------------------------------------------------------------------------
// 쓰기
// ---------------------------------------------------------------------------

/// 템플릿 문자열 안의 `${값}`: 없으면 "undefined"
fn tpl(v: Option<&JsValue>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(v) => v.to_js_string(),
    }
}

fn truthy(v: Option<&JsValue>) -> bool {
    v.is_some_and(JsValue::truthy)
}

fn array<'a>(v: Option<&'a JsValue>, what: &str) -> Res<&'a [JsValue]> {
    match v {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{what}은(는) 배열이어야 합니다")),
    }
}

fn object<'a>(v: &'a JsValue, what: &str) -> Res<&'a JsObject> {
    match v {
        JsValue::Obj(o) => Ok(o),
        _ => Err(format!("{what}은(는) 객체여야 합니다")),
    }
}

/// `requirementBodyLines`: 헤딩·상태 줄을 뺀 몸통
fn body_lines(requirement: &JsObject) -> Res<String> {
    let acceptance = array(requirement.get("acceptance"), "인수 조건")?.iter().map(|item| format!("  - {}", item.to_js_string())).collect::<Vec<_>>().join("\n");
    let rev_part = match requirement.get("rev") {
        Some(rev) => format!(" · 개정: {}", rev.to_js_string()),
        None => String::new(),
    };
    let mut lines = vec![format!("- 종류: {} · 우선순위: {}{}", tpl(requirement.get("kind")), tpl(requirement.get("priority")), rev_part)];
    if truthy(requirement.get("ears")) {
        let ears = object(requirement.get("ears").expect("있음"), "EARS")?;
        lines.push(format!("- EARS({}): {}", tpl(ears.get("pattern")), tpl(ears.get("statement"))));
    }
    if truthy(requirement.get("scenarios")) {
        let scenarios = array(requirement.get("scenarios"), "시나리오")?;
        if !scenarios.is_empty() {
            lines.push("- 시나리오:".to_owned());
            for scenario in scenarios {
                let s = object(scenario, "시나리오")?;
                lines.push(format!("  - {}: (Given) {} (When) {} (Then) {}", tpl(s.get("id")), tpl(s.get("given")), tpl(s.get("when")), tpl(s.get("then"))));
            }
        }
    }
    lines.push(format!("- 인수 조건:\n{acceptance}"));
    if truthy(requirement.get("nfr")) {
        let nfr = object(requirement.get("nfr").expect("있음"), "NFR")?;
        lines.push(format!("- NFR: 지표 {} · 임계값 {} · 조건 {} · 측정 {}", tpl(nfr.get("metric")), tpl(nfr.get("threshold")), tpl(nfr.get("condition")), tpl(nfr.get("method"))));
    }
    if truthy(requirement.get("trace")) {
        let trace = object(requirement.get("trace").expect("있음"), "추적")?;
        let mut bits: Vec<String> = Vec::new();
        if let Some(issue) = trace.get("issue") {
            bits.push(format!("이슈 #{}", issue.to_js_string()));
        }
        if truthy(trace.get("dependsOn")) {
            let depends = array(trace.get("dependsOn"), "의존")?;
            if !depends.is_empty() {
                bits.push(format!("의존 {}", depends.iter().map(|d| if matches!(d, JsValue::Null) { String::new() } else { d.to_js_string() }).collect::<Vec<_>>().join(", ")));
            }
        }
        if truthy(trace.get("supersedes")) {
            bits.push(format!("대체 {}", tpl(trace.get("supersedes"))));
        }
        if !bits.is_empty() {
            lines.push(format!("- 추적: {}", bits.join(" · ")));
        }
    }
    if truthy(requirement.get("manualVerification")) {
        let m = object(requirement.get("manualVerification").expect("있음"), "사람 확인")?;
        lines.push(format!("- 확인: {} · {} · 체크포인트 {} · 메모 {}", tpl(m.get("by")), tpl(m.get("at")), tpl(m.get("sha")), tpl(m.get("note"))));
    }
    Ok(lines.join("\n"))
}

/// 끝의 JSON 블록에 쓰는 요구사항 한 개(고른 필드만, 정해진 순서)
fn block_requirement(requirement: &JsObject) -> JsValue {
    let mut o = JsObject::new();
    for key in ["id", "title", "kind", "priority", "acceptance"] {
        if let Some(v) = requirement.get(key) {
            o.set(key, v.clone());
        }
    }
    if let Some(rev) = requirement.get("rev") {
        o.set("rev", rev.clone());
    }
    for key in ["ears", "scenarios", "nfr", "trace"] {
        if truthy(requirement.get(key)) {
            o.set(key, requirement.get(key).expect("있음").clone());
        }
    }
    for key in ["hash", "revisedAt"] {
        if let Some(v) = requirement.get(key) {
            o.set(key, v.clone());
        }
    }
    if truthy(requirement.get("manualVerification")) {
        o.set("manualVerification", requirement.get("manualVerification").expect("있음").clone());
    }
    JsValue::Obj(o)
}

/// `serializeRequirementsMarkdown`. `input`은 `{requirements, statusById, assumptions, manualSteps}`(글자는 인코딩한 것)다
pub fn serialize(input: &JsValue) -> Res<String> {
    let JsValue::Obj(input) = input else {
        return Err("입력은 객체여야 합니다".to_owned());
    };
    let requirements = array(input.get("requirements"), "요구사항 목록")?;
    let status_by_id = match input.get("statusById") {
        Some(JsValue::Obj(o)) => Some(o),
        None => None,
        _ => return Err("상태 표는 객체여야 합니다".to_owned()),
    };
    let assumptions = array(input.get("assumptions"), "가정")?;
    let manual_steps = array(input.get("manualSteps"), "사람이 할 일")?;

    let mut blocks = Vec::new();
    let mut block_items = Vec::new();
    for requirement in requirements {
        let requirement = object(requirement, "요구사항")?;
        let status = match status_by_id.and_then(|table| table.get(&tpl(requirement.get("id")))) {
            None | Some(JsValue::Null) => "미착수".to_owned(),
            Some(value) => value.to_js_string(),
        };
        blocks.push(format!("## {}. {}\n{}\n- 상태: {}", tpl(requirement.get("id")), tpl(requirement.get("title")), body_lines(requirement)?, status));
        block_items.push(block_requirement(requirement));
    }
    let list = |items: &[JsValue]| items.iter().map(|item| format!("- {}", item.to_js_string())).collect::<Vec<_>>().join("\n");
    let assumptions_block = if assumptions.is_empty() { String::new() } else { format!("\n\n## 가정\n{}", list(assumptions)) };
    let manual_steps_block = if manual_steps.is_empty() { String::new() } else { format!("\n\n## 사람이 할 일 (에이전트 금지)\n{}", list(manual_steps)) };
    let json = crate::requirement_integrity::pretty(&obj(vec![
        ("requirements", JsValue::Arr(block_items)),
        ("assumptions", JsValue::Arr(assumptions.to_vec())),
        ("manualSteps", JsValue::Arr(manual_steps.to_vec())),
    ]));
    Ok(format!("# 요구사항\n\n{}{}{}\n\n<!-- b-studio-requirements\n{}\n-->\n", blocks.join("\n\n"), assumptions_block, manual_steps_block, json))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_json(raw: &str) -> String {
        crate::js_json::stringify(&parse_body(raw).to_value())
    }

    #[test]
    fn 의존_정규식은_뒤보기와_되돌아감을_옮긴다() {
        assert_eq!(depends_group("이슈 #1 · 의존 R2, R3 · 대체 R1").as_deref(), Some("R2, R3"));
        assert_eq!(depends_group("의존 R2, R3").as_deref(), Some("R2, R3"));
        // 그룹이 뒤보기 앞에서 가장 짧게 끊긴다(R2 뒤에 공백이 있고 · 가 이어진다)
        assert_eq!(depends_group("의존 R2  · x").as_deref(), Some("R2"));
        // \s+가 한 칸만 먹고 그룹이 공백으로 시작하는 되돌아감
        assert_eq!(depends_group("의존   ").as_deref(), Some(" "));
        assert_eq!(depends_group("의존 ·"), None);
        assert_eq!(depends_group("의존R2"), None);
        assert_eq!(depends_group("의존 R2 가"), None);
    }

    #[test]
    fn 몸통을_읽는다() {
        let raw = "# 요구사항\n\n## R1. 로그인\n- 종류: api · 우선순위: must · 개정: 3\n- 인수 조건:\n  - a\n  - b\n- 추적: 이슈 #12 · 의존 R2, R3\n- 상태: 미착수\n\n## 가정\n- x\n";
        let out = parse_json(raw);
        assert!(out.contains(r#""id":"R1""#));
        assert!(out.contains(r#""rev":3"#));
        assert!(out.contains(r#""acceptance":["a","b"]"#));
        assert!(out.contains(r#""issue":12"#));
        assert!(out.contains(r#""dependsOn":["R2","R3"]"#));
        assert!(out.contains(r#""assumptions":["x"]"#));
    }

    #[test]
    fn 쓰고_읽으면_같다() {
        let input = crate::js_json::parse(r#"{"requirements":[{"id":"R1","title":"로그인","kind":"api","priority":"must","acceptance":["a"],"rev":2,"hash":"h"}],"statusById":{"R1":"검증됨"},"assumptions":["가"],"manualSteps":[]}"#).unwrap();
        let text = serialize(&input).unwrap();
        assert!(text.starts_with("# 요구사항\n\n## R1. 로그인\n- 종류: api · 우선순위: must · 개정: 2\n- 인수 조건:\n  - a\n- 상태: 검증됨\n\n## 가정\n- 가\n\n<!-- b-studio-requirements\n{\n"));
        let parsed = parse_body(&text);
        assert_eq!(parsed.drafts.len(), 1);
        assert_eq!(parsed.assumptions, vec!["가".to_owned()]);
        assert!(parsed.json_block.is_some());
    }
}
