//! 요구사항 판정의 순수 코어(옛 TS: `packages/agent/src/requirements.ts`, ADR-191 3단계 3j).
//!
//! 순수 함수만 있다(파일·네트워크·모델 호출 없음). 입력은 TS가 `JSON.stringify`로 넘긴 값(`JsValue`)이고 JS가 읽던 규칙대로 읽는다:
//! `a ?? b`는 `nullish`, `if (a)`는 `truthy`, 문자열 비교 `a > b`는 `js_less`로 옮겼다. 없는 필드는 템플릿 문자열에서 `undefined`다.
//!
//! 정규식 옮김 규칙(3a·3c와 같다): `\s`·`.`·`\S`는 JS의 글자 집합(`S`·`DOT`·`NS`), `\d`는 `[0-9]`, `\w`는 ASCII다.
//! `\b`는 ASCII 단어 경계라 `(?-u:\b)`로, `/i`는 ASCII 글자만 접는 `(?i-u:…)`로 쓴다(JS는 비유니코드 `/i`에서 `ſ`·`K`(켈빈) 같은
//! 비ASCII 글자를 ASCII 글자와 같게 보지 않는다. Rust의 유니코드 `(?i)`는 같게 본다). 뒤보기가 든 정규식은 없다. 되돌아감이 든
//! 정규식은 `regex` 크레이트의 "왼쪽 우선(leftmost-first)" 의미가 JS의 되돌아감 우선순위와 같아 그대로 옮겼다(차등 시험이 확인한다).
//!
//! 의도한 차이:
//! 1. 짝 없는 서로게이트는 Node 경계에서 U+FFFD가 된다(js_json 참고). 서로게이트 쌍을 가르는 `slice`(200·500·600자)는 옛 TS가
//!    짝 없는 서로게이트를, 여기는 U+FFFD를 낸다.
//! 2. 입력이 타입 선언과 다른 모양이면(예: 배열 자리에 숫자) JS는 TypeError, 여기는 이유가 담긴 오류로 던진다.
//! 3. `undefined`로 둔 속성은 결과에 키가 없다(JSON 경계). 옛 TS의 `{...next, rev: undefined}`는 키가 있되 값이 `undefined`였다.
//!    `JSON.stringify`·zod·`toEqual`은 둘을 같게 본다.
//! 4. 시나리오 id 번호가 2^53 이상이고 겹치면 옛 TS는 `number += 1`이 값을 바꾸지 못해 영원히 돌았다. 여기는 던진다.
//! 5. 유니코드 소문자 변환(`toLowerCase`)은 Node의 ICU와 Rust 표준 라이브러리의 유니코드 버전이 다를 수 있다.

use regex::{Regex, RegexBuilder};
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::js::{self, number_to_string};
use crate::js_json::{js_less, nullish, object, stringify, JsObject, JsValue};
use crate::snapshots::{hex, Sha256};

pub type Res<T> = Result<T, String>;

pub const REQUIREMENTS_FILE: &str = "docs/requirements.md";
pub const MAX_REQUIREMENTS: usize = 60;
pub const MERGE_MATCH_THRESHOLD: f64 = 0.35;
pub const MERGE_SPLIT_HINT_THRESHOLD: f64 = 0.15;

pub const WEAK_WORDS_KO: [&str; 10] = ["빠르게", "적절히", "적당히", "사용자 친화적", "가능하면", "기타", "신속히", "효율적으로", "즉시", "충분히"];
pub const WEAK_WORDS_EN: [&str; 10] = ["fast", "user-friendly", "appropriate", "as needed", "tbd", "quickly", "efficient", "asap", "soon", "etc"];

pub(crate) const S: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
pub(crate) const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

pub(crate) fn compile(pattern: &str) -> Regex {
    RegexBuilder::new(pattern).size_limit(1 << 30).build().expect("정규식")
}

// ---------------------------------------------------------------------------
// JS 읽기 도우미
// ---------------------------------------------------------------------------

/// `v.key`: 없거나 null인 값에서 읽으면 TypeError다. 객체가 아닌 값(문자열·수)에서는 `undefined`다
fn member<'a>(v: Option<&'a JsValue>, key: &str) -> Res<Option<&'a JsValue>> {
    match v {
        None | Some(JsValue::Null) => Err(format!("없는 값에서 {key}을(를) 읽을 수 없습니다")),
        Some(JsValue::Obj(o)) => Ok(field(o, key)),
        Some(_) => Ok(None),
    }
}

/// 옛 TS의 `{...next, rev: undefined}`는 값이 `undefined`인 키 자리를 남겨 뒤에 같은 키를 넣을 때 그 자리를 썼다(키 순서). 그 자리를 이 표시 값으로 흉내 낸다.
/// 입력 JSON은 NUL로 시작하는 키를 받지 않으므로(js_json) 진짜 값과 섞이지 않고, 밖으로 내보내기 전에 `strip_undefined`가 지운다
const UNDEF_KEY: &str = "\u{0}undefined";

fn undef() -> JsValue {
    object(vec![(UNDEF_KEY, Some(JsValue::Null))])
}

fn is_undef(v: &JsValue) -> bool {
    matches!(v, JsValue::Obj(o) if o.contains_key(UNDEF_KEY))
}

fn field<'a>(o: &'a JsObject, key: &str) -> Option<&'a JsValue> {
    o.get(key).filter(|v| !is_undef(v))
}

/// 자리만 남긴 `undefined` 값을 모두 지운다
pub fn strip_undefined(value: JsValue) -> JsValue {
    match value {
        JsValue::Arr(items) => JsValue::Arr(items.into_iter().map(strip_undefined).collect()),
        JsValue::Obj(o) => {
            let mut out = JsObject::new();
            for (k, v) in o.entries() {
                if !is_undef(v) {
                    out.set(k, strip_undefined(v.clone()));
                }
            }
            JsValue::Obj(out)
        }
        other => other,
    }
}

/// `v?.key`
fn opt_member<'a>(v: Option<&'a JsValue>, key: &str) -> Option<&'a JsValue> {
    match v {
        Some(JsValue::Obj(o)) => field(o, key),
        _ => None,
    }
}

fn array<'a>(v: Option<&'a JsValue>, what: &str) -> Res<&'a [JsValue]> {
    match v {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{what}은(는) 배열이어야 합니다")),
    }
}

fn string<'a>(v: Option<&'a JsValue>, what: &str) -> Res<&'a str> {
    match v {
        Some(JsValue::Str(s)) => Ok(s),
        _ => Err(format!("{what}은(는) 문자열이어야 합니다")),
    }
}

fn truthy(v: Option<&JsValue>) -> bool {
    v.is_some_and(JsValue::truthy)
}

fn is_str(v: Option<&JsValue>, expected: &str) -> bool {
    matches!(v, Some(JsValue::Str(s)) if s == expected)
}

/// 템플릿 문자열 `${value}`
fn tpl(v: Option<&JsValue>) -> String {
    v.map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
}

/// `Array.prototype.join`의 한 원소: null·undefined는 빈 글자
fn join_item(v: Option<&JsValue>) -> String {
    match v {
        None | Some(JsValue::Null) => String::new(),
        Some(other) => other.to_js_string(),
    }
}

fn join_values(items: &[JsValue], sep: &str) -> String {
    items.iter().map(|item| join_item(Some(item))).collect::<Vec<_>>().join(sep)
}

/// `a > b`에서 a가 `undefined`일 수 있는 경우(NaN과 견주는 것이라 거짓)
fn greater(a: Option<&JsValue>, b: &JsValue) -> bool {
    a.is_some_and(|a| js_less(b, a))
}

fn num(v: Option<&JsValue>) -> f64 {
    v.map_or(f64::NAN, JsValue::to_number)
}

fn str_value(s: impl Into<String>) -> Option<JsValue> {
    Some(JsValue::Str(s.into()))
}

/// `text.replace(/\s+/g, ' ').trim()`
fn collapse_whitespace(text: &str) -> String {
    text.split(js::is_js_whitespace).filter(|piece| !piece.is_empty()).collect::<Vec<_>>().join(" ")
}

fn without_key(o: &JsObject, key: &str) -> JsObject {
    let mut out = JsObject::new();
    for (k, v) in o.entries() {
        if k != key {
            out.set(k, v.clone());
        }
    }
    out
}

/// `{...value, key: replacement}`(replacement가 `undefined`면 JSON에서 키가 사라진다)
fn with_key(value: &JsValue, key: &str, replacement: Option<JsValue>) -> Res<JsValue> {
    let JsValue::Obj(o) = value else { return Err("객체여야 합니다".to_owned()) };
    Ok(match replacement {
        Some(r) => {
            let mut out = o.clone();
            out.set(key, r);
            JsValue::Obj(out)
        }
        None => {
            let mut out = o.clone();
            out.set(key, undef());
            JsValue::Obj(out)
        }
    })
}

fn obj_of<'a>(v: &'a JsValue, what: &str) -> Res<&'a JsObject> {
    match v {
        JsValue::Obj(o) => Ok(o),
        _ => Err(format!("{what}은(는) 객체여야 합니다")),
    }
}

// ---------------------------------------------------------------------------
// 정규식
// ---------------------------------------------------------------------------

/// `\bR\d+(?:\.\d+)?\b`
static MENTION: LazyLock<Regex> = LazyLock::new(|| compile(r"(?-u:\b)R[0-9]+(?:\.[0-9]+)?(?-u:\b)"));
/// `\bR\d+(?:\.\d+)?\s*[-–—~]\s*R\d+(?:\.\d+)?\b`
static RANGE_MENTION: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"(?-u:\b)R[0-9]+(?:\.[0-9]+)?{S}*[-–—~]{S}*R[0-9]+(?:\.[0-9]+)?(?-u:\b)")));
/// `\bImplements:\s*(R\d+(?:\.\d+)?)(?:@rev(\d+))?` /gi
static IMPLEMENTS_TRAILER: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"(?i-u:\bImplements:){S}*((?i-u:R)[0-9]+(?:\.[0-9]+)?)(?:(?i-u:@rev)([0-9]+))?")));
/// `(\.(test|spec)\.[cm]?[jt]sx?$)|(Tests?\.java$)` /i
static TEST_FILE: LazyLock<Regex> = LazyLock::new(|| compile(r"(?i-u:(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:Tests?\.java$))"));
/// `[가-힣0-9]\s*등(?:[,.\s]|$)`
pub(crate) static WEAK_ETC: LazyLock<Regex> = LazyLock::new(|| compile(&format!("[가-힣0-9]{S}*등(?:[,.{}]|$)", js::WS_CLASS)));
static WEAK_KO: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    WEAK_WORDS_KO.iter().map(|word| compile(&format!("(?:^|[^가-힣A-Za-z0-9]){}(?:$|[^가-힣A-Za-z0-9])", regex::escape(word)))).collect()
});
static WEAK_EN: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    WEAK_WORDS_EN.iter().map(|word| compile(&format!("(?:^|[^a-z0-9-]){}(?:$|[^a-z0-9-])", regex::escape(word)))).collect()
});
static MUST_STATEMENT: LazyLock<Regex> = LazyLock::new(|| compile(&format!("해야{S}*한다")));
static MANUAL_STANDALONE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i-u:\bcollaborators?\b)".to_owned(),
        format!("(?i-u:branch){S}*(?i-u:protection)"),
        format!("(?i-u:deploy){S}*(?i-u:key)"),
        format!("메일(?:로)?{S}*제출|이메일(?:로)?{S}*제출|(?i-u:email){S}*(?:로)?{S}*제출"),
        format!("제출{S}*(?:방법|절차)"),
    ]
    .iter()
    .map(|p| compile(p))
    .collect()
});
static MANUAL_IN_REPO: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        format!("협업자|공동{S}*작업자"),
        r"(?i-u:\binvite(?:s|d)?\b)|초대".to_owned(),
        format!(r"(?i-u:\bvisibility\b)|공개{S}*범위|(?i-u:\bprivate\b|\bpublic\b)|비공개|공개로"),
        r"권한|(?i-u:\bpermission)".to_owned(),
        r"(?i-u:\bwebhook\b)|웹훅".to_owned(),
        r"(?i-u:\bsecrets?\b)|시크릿".to_owned(),
    ]
    .iter()
    .map(|p| compile(p))
    .collect()
});
static REPO_CONTEXT: LazyLock<Regex> =
    LazyLock::new(|| compile(&format!(r"저장소|레포|(?i-u:\brepo(?:sitory)?\b|github)|깃허브|(?i-u:gitlab|organization)|조직{S}*설정|계정{S}*설정")));
static HEADING_LINE: LazyLock<Regex> = LazyLock::new(|| compile(&format!("^#{{1,6}}{S}+({DOT}+?){S}*$")));
static NUMBERED_LINE: LazyLock<Regex> = LazyLock::new(|| compile(&format!("^{S}*([0-9]+)[.)]{S}+({DOT}+?){S}*$")));
static BULLET_LINE: LazyLock<Regex> = LazyLock::new(|| compile(&format!(r"^{S}*[-*]{S}+({DOT}+?){S}*$")));
static KIND_KEYWORDS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    vec![
        ("data", compile(r"(?i-u:\b(?:db|database|schema|migration)\b)|데이터베이스|스키마|마이그레이션|테이블")),
        ("nonfunctional", compile(&format!("(?i-u:performance|security|scalab|availability|latency)|성능|보안|가용성|확장성|동시성|응답{S}*시간|부하"))),
        ("ui", compile(r"(?i-u:\b(?:ui|component|page|layout|screen)\b)|화면|버튼|컴포넌트|페이지|레이아웃")),
        ("api", compile(r"(?i-u:\b(?:api|endpoint|rest|http)\b)|엔드포인트|응답|요청")),
        ("docs", compile(r"문서|(?i-u:readme|docs?\b)")),
    ]
});
static PRIORITY_COULD: LazyLock<Regex> = LazyLock::new(|| compile(&format!("선택{S}*사항|보너스|(?i-u:bonus|optional|nice[- ]to[- ]have)")));
static PRIORITY_SHOULD: LazyLock<Regex> = LazyLock::new(|| compile("권장|(?i-u:should)|추천"));
/// `\b(?:[\w.-]+\/)*[\w-]+\.(?:json|ya?ml|sql|md|csv|txt|env|proto|graphql)\b` /gi
static PATH_LIKE: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(?-u:\b)(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_-]+\.(?i-u:json|ya?ml|sql|md|csv|txt|env|proto|graphql)(?-u:\b)"));
/// `\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s—–,(]+)` /i
static API_SIGNATURE: LazyLock<Regex> = LazyLock::new(|| compile(&format!("(?i-u:\\b(GET|POST|PUT|PATCH|DELETE)){S}+(/[^{}—–,(]+)", js::WS_CLASS)));
static TRAILING_SCENARIO_NUMBER: LazyLock<Regex> = LazyLock::new(|| compile(r"\.([0-9]+)$"));

// ---------------------------------------------------------------------------
// 언급 id·트레일러·테스트 파일
// ---------------------------------------------------------------------------

/// `findMentionedIds`: `R1`·`R1.2` 토큰을 모두 뽑는다. `R1~R32` 같은 범위 표기 안의 양 끝 id는 뺀다
pub fn find_mentioned_ids(text: &str) -> Vec<String> {
    let ranges: Vec<(usize, usize)> = RANGE_MENTION.find_iter(text).map(|m| (m.start(), m.end())).collect();
    MENTION
        .find_iter(text)
        .filter(|m| !ranges.iter().any(|&(start, end)| m.start() >= start && m.start() < end))
        .map(|m| m.as_str().to_owned())
        .collect()
}

fn mention_matches(mention: &str, id: &str) -> bool {
    mention == id || (mention.starts_with(id) && mention[id.len()..].starts_with('.'))
}

pub fn mentions_requirement_id(text: &str, id: &str) -> bool {
    find_mentioned_ids(text).iter().any(|mention| mention_matches(mention, id))
}

/// `[(id, rev?)]`
pub fn extract_implements_trailers(text: &str) -> Vec<(String, Option<f64>)> {
    IMPLEMENTS_TRAILER
        .captures_iter(text)
        .map(|c| {
            let id = c[1].to_ascii_uppercase();
            let rev = c.get(2).map(|m| m.as_str().parse::<f64>().unwrap_or(f64::INFINITY));
            (id, rev)
        })
        .collect()
}

fn implements_trailer_mentions(text: &str, id: &str) -> bool {
    extract_implements_trailers(text).iter().any(|(trailer, _)| mention_matches(trailer, id))
}

/// `findCheckpointMentions`가 고른 체크포인트의 자리. 명시적 `Implements:` 트레일러가 있는 것이 하나라도 있으면 그것만, 없으면 자유 언급
pub fn find_checkpoint_mention_indexes(messages: &[String], id: &str) -> Vec<usize> {
    let via_trailer: Vec<usize> = messages.iter().enumerate().filter(|(_, m)| implements_trailer_mentions(m, id)).map(|(i, _)| i).collect();
    if !via_trailer.is_empty() {
        return via_trailer;
    }
    messages.iter().enumerate().filter(|(_, m)| mentions_requirement_id(m, id)).map(|(i, _)| i).collect()
}

pub fn find_gate_check_mention_indexes(names: &[String], id: &str) -> Vec<usize> {
    names.iter().enumerate().filter(|(_, name)| mentions_requirement_id(name, id)).map(|(i, _)| i).collect()
}

pub fn is_likely_test_file(path: &str) -> bool {
    TEST_FILE.is_match(path)
}

// ---------------------------------------------------------------------------
// 시나리오 id
// ---------------------------------------------------------------------------

/// `alignScenarioIds`가 시나리오에 새로 매길 id들. 바꿀 것이 없으면(이미 모두 `<id>.`로 시작) `None`
pub fn aligned_scenario_ids(requirement_id: &str, scenario_ids: &[String]) -> Res<Option<Vec<String>>> {
    if scenario_ids.is_empty() {
        return Ok(None);
    }
    let prefix = format!("{requirement_id}.");
    if scenario_ids.iter().all(|id| id.starts_with(&prefix)) {
        return Ok(None);
    }
    let mut used: Vec<f64> = Vec::new();
    let mut out = Vec::with_capacity(scenario_ids.len());
    for id in scenario_ids {
        let suffix = TRAILING_SCENARIO_NUMBER.captures(id).map_or(f64::NAN, |c| js::to_number(&c[1]));
        let mut number = if suffix.is_finite() && suffix.fract() == 0.0 && suffix > 0.0 && !used.contains(&suffix) { suffix } else { 1.0 };
        while used.contains(&number) {
            let next = number + 1.0;
            if next == number {
                return Err("시나리오 id 번호가 너무 커서 다음 빈 번호를 찾을 수 없습니다".to_owned());
            }
            number = next;
        }
        used.push(number);
        out.push(format!("{requirement_id}.{}", number_to_string(number)));
    }
    Ok(Some(out))
}

fn scenario_ids_of(requirement: &JsValue) -> Res<Option<(String, Vec<String>)>> {
    let scenarios = match opt_member(Some(requirement), "scenarios") {
        None | Some(JsValue::Null) => return Ok(None),
        Some(JsValue::Arr(items)) => items,
        Some(_) => return Err("scenarios는 배열이어야 합니다".to_owned()),
    };
    if scenarios.is_empty() {
        return Ok(None);
    }
    let id = tpl(opt_member(Some(requirement), "id"));
    let mut ids = Vec::with_capacity(scenarios.len());
    for scenario in scenarios {
        ids.push(string(member(Some(scenario), "id")?, "시나리오 id")?.to_owned());
    }
    Ok(Some((id, ids)))
}

/// `alignScenarioIds`(JsValue 판)
fn align_requirement(requirement: &JsValue) -> Res<JsValue> {
    let Some((id, ids)) = scenario_ids_of(requirement)? else { return Ok(requirement.clone()) };
    let Some(new_ids) = aligned_scenario_ids(&id, &ids)? else { return Ok(requirement.clone()) };
    let scenarios = array(opt_member(Some(requirement), "scenarios"), "scenarios")?;
    let mut mapped = Vec::with_capacity(scenarios.len());
    for (scenario, new_id) in scenarios.iter().zip(new_ids) {
        mapped.push(with_key(scenario, "id", Some(JsValue::Str(new_id)))?);
    }
    with_key(requirement, "scenarios", Some(JsValue::Arr(mapped)))
}

// ---------------------------------------------------------------------------
// 내용 해시·개정
// ---------------------------------------------------------------------------

fn nullish_or_null(v: Option<&JsValue>) -> JsValue {
    if nullish(v) {
        JsValue::Null
    } else {
        v.cloned().unwrap_or(JsValue::Null)
    }
}

/// `sha256(JSON.stringify({title, ears ?? null, scenarios ?? null, nfr ?? null}))`의 앞 16자
pub fn compute_requirement_hash(requirement: &JsValue) -> Res<String> {
    let title = member(Some(requirement), "title")?.cloned();
    let stable = object(vec![
        ("title", title),
        ("ears", Some(nullish_or_null(opt_member(Some(requirement), "ears")))),
        ("scenarios", Some(nullish_or_null(opt_member(Some(requirement), "scenarios")))),
        ("nfr", Some(nullish_or_null(opt_member(Some(requirement), "nfr")))),
    ]);
    let mut hash = Sha256::new();
    hash.update(stringify(&stable).as_bytes());
    Ok(hex(&hash.finish())[..16].to_owned())
}

pub fn requirement_content_drifted(requirement: &JsValue) -> Res<bool> {
    let stored = member(Some(requirement), "hash")?;
    if !truthy(stored) {
        return Ok(false);
    }
    Ok(!is_str(stored, &compute_requirement_hash(requirement)?))
}

fn rev_or_one(requirement: &JsValue) -> Res<f64> {
    match opt_member(Some(requirement), "rev") {
        None | Some(JsValue::Null) => Ok(1.0),
        Some(JsValue::Num(n)) => Ok(*n),
        Some(_) => Err("rev는 수여야 합니다".to_owned()),
    }
}

/// `reviseRequirementIfChanged`. 바뀐 것이 없으면 `None`(옛 TS는 같은 객체를 돌려줬다)
pub fn revise_requirement_if_changed(requirement: &JsValue, now: &str) -> Res<Option<JsValue>> {
    Ok(revise_raw(requirement, now)?.map(strip_undefined))
}

fn revise_raw(requirement: &JsValue, now: &str) -> Res<Option<JsValue>> {
    let hash = compute_requirement_hash(requirement)?;
    let stored = opt_member(Some(requirement), "hash");
    if stored.is_none() {
        let seeded = with_key(requirement, "rev", Some(JsValue::Num(rev_or_one(requirement)?)))?;
        return Ok(Some(with_key(&seeded, "hash", str_value(hash))?));
    }
    if is_str(stored, &hash) {
        return Ok(None);
    }
    let bumped = with_key(requirement, "rev", Some(JsValue::Num(rev_or_one(requirement)? + 1.0)))?;
    let hashed = with_key(&bumped, "hash", str_value(hash))?;
    Ok(Some(with_key(&hashed, "revisedAt", str_value(now))?))
}

/// `a ?? b`를 값으로(둘 다 `undefined`면 `None`)
fn coalesce(a: Option<&JsValue>, b: Option<&JsValue>) -> Option<JsValue> {
    if nullish(a) {
        b.cloned()
    } else {
        a.cloned()
    }
}

pub fn carry_forward_requirement_revision(next: &JsValue, previous: &JsValue) -> Res<JsValue> {
    Ok(strip_undefined(carry_forward_raw(next, previous)?))
}

fn carry_forward_raw(next: &JsValue, previous: &JsValue) -> Res<JsValue> {
    let mut out = next.clone();
    for key in ["rev", "hash", "revisedAt", "manualVerification"] {
        let merged = coalesce(opt_member(Some(next), key), opt_member(Some(previous), key));
        out = with_key(&out, key, merged)?;
    }
    Ok(out)
}

pub fn discard_revision(requirement: &JsValue) -> Res<JsValue> {
    let o = obj_of(requirement, "요구사항")?;
    let mut out = o.clone();
    for key in ["rev", "hash", "revisedAt"] {
        out = without_key(&out, key);
    }
    Ok(JsValue::Obj(out))
}

// ---------------------------------------------------------------------------
// 상태·검증 출처·확신
// ---------------------------------------------------------------------------

pub const STATUS_RECHECK: &str = "재확인 필요";
pub const STATUS_FAILED: &str = "실패";
pub const STATUS_VERIFIED: &str = "검증됨";
pub const STATUS_WORKING: &str = "작업 중";
pub const STATUS_NOT_STARTED: &str = "미착수";

fn requirement_of(requirement: Option<&JsValue>) -> Option<&JsValue> {
    match requirement {
        None | Some(JsValue::Null) => None,
        other => other,
    }
}

/// `evidence.<key>.length`(배열이어야 한다)
fn evidence_len(evidence: &JsValue, key: &str) -> Res<usize> {
    Ok(array(member(Some(evidence), key)?, &format!("evidence.{key}"))?.len())
}

/// `(evidence.missingScenarios?.length ?? 0) > 0`
fn scenarios_pending(evidence: &JsValue) -> Res<bool> {
    match member(Some(evidence), "missingScenarios")? {
        None | Some(JsValue::Null) => Ok(false),
        Some(JsValue::Arr(items)) => Ok(!items.is_empty()),
        Some(_) => Err("missingScenarios는 배열이어야 합니다".to_owned()),
    }
}

/// `evidence.docEvidence?.satisfied` 진릿값
fn doc_satisfied(evidence: &JsValue) -> Res<bool> {
    Ok(truthy(opt_member(member(Some(evidence), "docEvidence")?, "satisfied")))
}

pub fn compute_requirement_status(evidence: &JsValue, requirement: Option<&JsValue>) -> Res<&'static str> {
    let requirement = requirement_of(requirement);
    if let Some(r) = requirement {
        if requirement_content_drifted(r)? {
            return Ok(STATUS_RECHECK);
        }
    }
    if let Some(r) = requirement {
        let revised_at = member(Some(r), "revisedAt")?;
        if truthy(revised_at) {
            let revised_at = revised_at.expect("revisedAt");
            let mut fresh_checkpoint = false;
            for checkpoint in array(member(Some(evidence), "checkpoints")?, "evidence.checkpoints")? {
                let created_at = member(Some(checkpoint), "createdAt")?;
                if created_at.is_some() && greater(created_at, revised_at) {
                    fresh_checkpoint = true;
                    break;
                }
            }
            let fresh_test_run = match member(Some(evidence), "testRun")? {
                None => false,
                Some(test_run) => greater(member(Some(test_run), "at")?, revised_at),
            };
            let fresh_manual = match member(Some(r), "manualVerification")? {
                None => false,
                Some(manual) => greater(member(Some(manual), "at")?, revised_at),
            };
            let fresh_doc = matches!(opt_member(member(Some(evidence), "docEvidence")?, "satisfied"), Some(JsValue::Bool(true)));
            let has_fresh = fresh_checkpoint || evidence_len(evidence, "gateChecks")? > 0 || fresh_test_run || fresh_manual || fresh_doc;
            if !has_fresh {
                return Ok(STATUS_RECHECK);
            }
        }
    }
    let pending = scenarios_pending(evidence)?;
    if evidence_len(evidence, "gateChecks")? > 0 {
        for check in array(member(Some(evidence), "gateChecks")?, "evidence.gateChecks")? {
            if !truthy(member(Some(check), "ok")?) {
                return Ok(STATUS_FAILED);
            }
        }
        if !pending {
            return Ok(STATUS_VERIFIED);
        }
    }
    if truthy(member(Some(evidence), "testRun")?) {
        let test_run = member(Some(evidence), "testRun")?;
        if num(member(test_run, "failed")?) > 0.0 {
            return Ok(STATUS_FAILED);
        }
        if num(member(test_run, "passed")?) > 0.0 && !pending {
            return Ok(STATUS_VERIFIED);
        }
    }
    if doc_satisfied(evidence)? {
        return Ok(STATUS_VERIFIED);
    }
    if let Some(r) = requirement {
        if truthy(member(Some(r), "manualVerification")?) {
            return Ok(STATUS_VERIFIED);
        }
    }
    let test_run = member(Some(evidence), "testRun")?;
    let has_passing_run = match opt_member(test_run, "passed") {
        None | Some(JsValue::Null) => false,
        Some(passed) => passed.to_number() > 0.0,
    };
    let doc_matched = match member(Some(evidence), "docEvidence")? {
        None | Some(JsValue::Null) => false,
        doc => array(member(doc, "matched")?, "docEvidence.matched")?.len() > 0,
    };
    if evidence_len(evidence, "checkpoints")? > 0 || evidence_len(evidence, "tests")? > 0 || evidence_len(evidence, "gateChecks")? > 0 || has_passing_run || doc_matched {
        return Ok(STATUS_WORKING);
    }
    Ok(STATUS_NOT_STARTED)
}

/// 시나리오 중 자동 근거로 확인되지 않은 것이 남았는지
fn automatic_evidence_incomplete(evidence: &JsValue) -> Res<bool> {
    scenarios_pending(evidence)
}

/// 통과한 테스트 탭 실행이 있고 실패가 없는지(`testRun && passed > 0 && failed === 0`)
fn passing_test_run(evidence: &JsValue) -> Res<bool> {
    let test_run = member(Some(evidence), "testRun")?;
    if !truthy(test_run) {
        return Ok(false);
    }
    let failed_zero = matches!(member(test_run, "failed")?, Some(JsValue::Num(n)) if *n == 0.0);
    Ok(num(member(test_run, "passed")?) > 0.0 && failed_zero)
}

/// `'test' | 'docs' | 'manual' | 'none'`
pub fn requirement_verification_source(evidence: &JsValue, requirement: Option<&JsValue>) -> Res<&'static str> {
    if compute_requirement_status(evidence, requirement)? != STATUS_VERIFIED {
        return Ok("none");
    }
    if !automatic_evidence_incomplete(evidence)? {
        if evidence_len(evidence, "gateChecks")? > 0 {
            return Ok("test");
        }
        if passing_test_run(evidence)? {
            return Ok("test");
        }
    }
    if doc_satisfied(evidence)? {
        return Ok("docs");
    }
    if let Some(r) = requirement_of(requirement) {
        if truthy(member(Some(r), "manualVerification")?) {
            return Ok("manual");
        }
    }
    Ok("test")
}

pub fn matrix_verification_badge(status: &str, evidence: &JsValue, requirement: Option<&JsValue>) -> Res<&'static str> {
    if status != STATUS_VERIFIED {
        return Ok("none");
    }
    if !automatic_evidence_incomplete(evidence)? {
        if evidence_len(evidence, "gateChecks")? > 0 {
            return Ok("게이트");
        }
        if passing_test_run(evidence)? {
            return Ok("테스트 탭");
        }
    }
    if doc_satisfied(evidence)? {
        return Ok("문서 확인");
    }
    if let Some(r) = requirement_of(requirement) {
        if truthy(member(Some(r), "manualVerification")?) {
            return Ok("사람 확인");
        }
    }
    Ok("테스트 탭")
}

pub fn requirement_confidence(status: &str) -> &'static str {
    match status {
        STATUS_VERIFIED => "🟢",
        STATUS_WORKING | STATUS_RECHECK => "🟡",
        _ => "🔴",
    }
}

pub fn summarize_coverage(requirements: &JsValue, status_by_id: &JsValue) -> Res<JsValue> {
    let requirements = array(Some(requirements), "요구사항 목록")?;
    let statuses = obj_of(status_by_id, "상태 표")?;
    let status_is = |requirement: &JsValue, expected: &str| -> Res<bool> {
        let id = member(Some(requirement), "id")?;
        Ok(match id {
            Some(JsValue::Str(id)) => is_str(statuses.get(id), expected),
            _ => false,
        })
    };
    let total = requirements.len();
    let mut verified = 0usize;
    let mut must_total = 0usize;
    let mut must_verified = 0usize;
    let mut needs_recheck = 0usize;
    for requirement in requirements {
        let is_verified = status_is(requirement, STATUS_VERIFIED)?;
        if is_verified {
            verified += 1;
        }
        if is_str(member(Some(requirement), "priority")?, "must") {
            must_total += 1;
            if is_verified {
                must_verified += 1;
            }
        }
        if status_is(requirement, STATUS_RECHECK)? {
            needs_recheck += 1;
        }
    }
    let must_gap = must_total - must_verified;
    let n = |x: usize| Some(JsValue::Num(x as f64));
    Ok(object(vec![
        ("total", n(total)),
        ("verified", n(verified)),
        ("mustTotal", n(must_total)),
        ("mustVerified", n(must_verified)),
        ("text", str_value(format!("{total}개 중 {verified}개 검증됨"))),
        ("mustGapText", (must_gap > 0).then(|| JsValue::Str(format!("필수(must) 요구사항 {must_gap}개 미검증")))),
        ("needsRecheck", n(needs_recheck)),
        ("needsRecheckText", (needs_recheck > 0).then(|| JsValue::Str(format!("{needs_recheck}개 재확인 필요")))),
    ]))
}

// ---------------------------------------------------------------------------
// 요구사항 스멜 린트
// ---------------------------------------------------------------------------

pub struct LintWarning {
    pub code: &'static str,
    pub message: String,
    pub must_fix: bool,
}

impl LintWarning {
    pub fn to_value(&self) -> JsValue {
        object(vec![("code", str_value(self.code)), ("message", str_value(self.message.clone())), ("mustFix", Some(JsValue::Bool(self.must_fix)))])
    }
}

/// 약한 표현 하나를 찾았을 때의 안내(요구사항 린트와 문서 린트가 같이 쓴다)
pub fn weak_word_message(word: &str) -> String {
    format!("약한 표현 \"{word}\"이(가) 있습니다 — 수치·구체적 조건으로 바꿔 주세요")
}

pub const WEAK_ETC_MESSAGE: &str = "약한 표현 \"등\"이(가) 있습니다 — 목록을 모두 적어 주세요";

/// 약한 표현 안내를 한국어 목록 순서, `등`, 영어 목록 순서로. `lower`는 `text`의 소문자
pub fn weak_word_messages(text: &str, lower: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (word, pattern) in WEAK_WORDS_KO.iter().zip(WEAK_KO.iter()) {
        if pattern.is_match(text) {
            out.push(weak_word_message(word));
        }
    }
    if WEAK_ETC.is_match(text) {
        out.push(WEAK_ETC_MESSAGE.to_owned());
    }
    for (word, pattern) in WEAK_WORDS_EN.iter().zip(WEAK_EN.iter()) {
        if pattern.is_match(lower) {
            out.push(weak_word_message(word));
        }
    }
    out
}

/// 제목·EARS·시나리오·인수 조건을 공백으로 이은 글(`.filter(Boolean)`이 빈 값을 거른다)
fn collect_requirement_text(requirement: &JsValue) -> Res<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut push = |v: Option<&JsValue>| {
        if truthy(v) {
            parts.push(v.map(JsValue::to_js_string).unwrap_or_default());
        }
    };
    push(member(Some(requirement), "title")?);
    push(opt_member(opt_member(Some(requirement), "ears"), "statement"));
    for item in array(member(Some(requirement), "acceptance")?, "acceptance")? {
        push(Some(item));
    }
    match member(Some(requirement), "scenarios")? {
        None | Some(JsValue::Null) => {}
        Some(JsValue::Arr(scenarios)) => {
            for scenario in scenarios {
                for key in ["given", "when", "then"] {
                    push(member(Some(scenario), key)?);
                }
            }
        }
        Some(_) => return Err("scenarios는 배열이어야 합니다".to_owned()),
    }
    Ok(parts.join(" "))
}

pub fn lint_requirement(requirement: &JsValue) -> Res<Vec<LintWarning>> {
    let mut warnings = Vec::new();
    let text = collect_requirement_text(requirement)?;
    let lower = text.to_lowercase();
    for message in weak_word_messages(&text, &lower) {
        warnings.push(LintWarning { code: "weak-word", message, must_fix: true });
    }
    let no_scenarios = match member(Some(requirement), "scenarios")? {
        None | Some(JsValue::Null) => true,
        Some(JsValue::Arr(items)) => items.is_empty(),
        Some(_) => return Err("scenarios는 배열이어야 합니다".to_owned()),
    };
    if no_scenarios {
        warnings.push(LintWarning { code: "no-scenario", message: "시나리오(Given-When-Then)가 없습니다".to_owned(), must_fix: true });
    }
    if is_str(member(Some(requirement), "kind")?, "nonfunctional") && !truthy(member(Some(requirement), "nfr")?) {
        warnings.push(LintWarning { code: "nfr-missing", message: "비기능 요구사항인데 측정 가능한 지표·임계값(NFR)이 없습니다".to_owned(), must_fix: true });
    }
    let ears = member(Some(requirement), "ears")?;
    if truthy(ears) {
        let statement = string(member(ears, "statement")?, "ears.statement")?;
        let must_count = MUST_STATEMENT.find_iter(statement).count();
        if must_count > 1 {
            warnings.push(LintWarning {
                code: "multiple-must-statements",
                message: "한 EARS 문장에 \"해야 한다\"가 여러 번 있습니다 — 요구사항 하나에 한 문장만 쓰세요(요구사항을 쪼개야 할 수 있습니다)".to_owned(),
                must_fix: true,
            });
        } else if must_count == 0 {
            warnings.push(LintWarning { code: "not-ears-shaped", message: "EARS 문장이 \"…해야 한다\" 형태가 아닙니다".to_owned(), must_fix: false });
        }
    }
    Ok(warnings)
}

pub fn requirement_is_ready(requirement: &JsValue) -> Res<bool> {
    Ok(lint_requirement(requirement)?.iter().all(|warning| !warning.must_fix))
}

pub fn requirements_ready_badge(requirements: &JsValue) -> Res<bool> {
    let mut must_haves = Vec::new();
    for requirement in array(Some(requirements), "요구사항 목록")? {
        if is_str(member(Some(requirement), "priority")?, "must") {
            must_haves.push(requirement);
        }
    }
    if must_haves.is_empty() {
        return Ok(false);
    }
    for requirement in must_haves {
        if !requirement_is_ready(requirement)? {
            return Ok(false);
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// "사람이 할 일" 걸러내기
// ---------------------------------------------------------------------------

pub fn is_manual_step_text(text: &str) -> bool {
    if MANUAL_STANDALONE.iter().any(|pattern| pattern.is_match(text)) {
        return true;
    }
    REPO_CONTEXT.is_match(text) && MANUAL_IN_REPO.iter().any(|pattern| pattern.is_match(text))
}

/// `{ movedIndexes, manualSteps }`: 걷어낸 요구사항의 자리와, 넘겨받은 목록 뒤에 이어 붙인 "사람이 할 일"
pub fn partition_manual_steps(requirements: &JsValue, manual_steps: &[String]) -> Res<(Vec<usize>, Vec<String>)> {
    let mut moved_indexes = Vec::new();
    let mut moved: Vec<String> = manual_steps.to_vec();
    for (index, requirement) in array(Some(requirements), "요구사항 목록")?.iter().enumerate() {
        let title = member(Some(requirement), "title")?;
        let acceptance = array(member(Some(requirement), "acceptance")?, "acceptance")?;
        let mut parts = vec![join_item(title)];
        parts.extend(acceptance.iter().map(|item| join_item(Some(item))));
        if is_manual_step_text(&parts.join(" ")) {
            let detail = if acceptance.is_empty() { tpl(title) } else { format!("{} — {}", tpl(title), join_values(acceptance, "; ")) };
            moved.push(detail);
            moved_indexes.push(index);
        }
    }
    Ok((moved_indexes, moved))
}

// ---------------------------------------------------------------------------
// 결정론적 대체 파서(명세 글 → 요구사항 초안)
// ---------------------------------------------------------------------------

struct Draft {
    title: String,
    acceptance: Vec<String>,
}

/// `text.split(/\r?\n/)`
fn split_crlf(text: &str) -> Vec<&str> {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    pieces.into_iter().enumerate().map(|(i, p)| if i < last { p.strip_suffix('\r').unwrap_or(p) } else { p }).collect()
}

/// `text.split(/\n{2,}/)`
fn split_blank_runs(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let mut j = i;
            while j < bytes.len() && bytes[j] == b'\n' {
                j += 1;
            }
            if j - i >= 2 {
                pieces.push(&text[start..i]);
                start = j;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    pieces.push(&text[start..]);
    pieces
}

fn starts_with_ws(line: &str) -> bool {
    line.chars().next().is_some_and(js::is_js_whitespace)
}

/// `/^\s+\S/`
fn indented_text(line: &str) -> bool {
    let rest = line.trim_start_matches(js::is_js_whitespace);
    starts_with_ws(line) && !rest.is_empty()
}

fn draft_from_spec(spec_text: &str) -> Vec<Draft> {
    let mut drafts: Vec<Draft> = Vec::new();
    let mut current: Option<Draft> = None;
    let flush = |current: &mut Option<Draft>, drafts: &mut Vec<Draft>| {
        if let Some(draft) = current.take() {
            if !js::trim(&draft.title).is_empty() {
                drafts.push(draft);
            }
        }
    };
    for line in split_crlf(spec_text) {
        if let Some(heading) = HEADING_LINE.captures(line) {
            flush(&mut current, &mut drafts);
            current = Some(Draft { title: heading[1].to_owned(), acceptance: Vec::new() });
            continue;
        }
        if let Some(numbered) = NUMBERED_LINE.captures(line) {
            if !starts_with_ws(line) {
                flush(&mut current, &mut drafts);
                current = Some(Draft { title: numbered[2].to_owned(), acceptance: Vec::new() });
                continue;
            }
        }
        if let Some(bullet) = BULLET_LINE.captures(line) {
            if let Some(draft) = current.as_mut() {
                draft.acceptance.push(bullet[1].to_owned());
            }
            continue;
        }
        if indented_text(line) {
            if let Some(draft) = current.as_mut() {
                if let Some(indented) = NUMBERED_LINE.captures(js::trim(line)) {
                    draft.acceptance.push(indented[2].to_owned());
                }
            }
        }
    }
    flush(&mut current, &mut drafts);
    if drafts.is_empty() {
        return split_blank_runs(spec_text)
            .into_iter()
            .map(js::trim)
            .filter(|paragraph| !paragraph.is_empty())
            .take(MAX_REQUIREMENTS)
            .map(|paragraph| Draft { title: js::truncate_utf16(paragraph.split('\n').next().unwrap_or(""), 200), acceptance: vec![paragraph.to_owned()] })
            .collect();
    }
    drafts
}

fn guess_kind(text: &str) -> &'static str {
    KIND_KEYWORDS.iter().find(|(_, pattern)| pattern.is_match(text)).map_or("api", |(kind, _)| *kind)
}

fn guess_priority(text: &str) -> &'static str {
    if PRIORITY_COULD.is_match(text) {
        return "could";
    }
    if PRIORITY_SHOULD.is_match(text) {
        return "should";
    }
    "must"
}

pub fn extract_requirements_heuristically(spec_text: &str) -> JsValue {
    let drafts = draft_from_spec(spec_text);
    let requirements = drafts
        .iter()
        .take(MAX_REQUIREMENTS)
        .enumerate()
        .map(|(index, draft)| {
            let mut title = js::truncate_utf16(js::trim(&draft.title), 200);
            if title.is_empty() {
                title = format!("요구사항 {}", index + 1);
            }
            let acceptance: Vec<String> = if draft.acceptance.is_empty() {
                vec![format!("{title}대로 동작한다")]
            } else {
                draft.acceptance.iter().map(|line| js::truncate_utf16(line, 500)).collect()
            };
            let combined = format!("{title} {}", acceptance.join(" "));
            object(vec![
                ("id", str_value(format!("R{}", index + 1))),
                ("title", str_value(title)),
                ("kind", str_value(guess_kind(&combined))),
                ("acceptance", Some(JsValue::Arr(acceptance.into_iter().map(JsValue::Str).collect()))),
                ("priority", str_value(guess_priority(&combined))),
            ])
        })
        .collect();
    JsValue::Arr(requirements)
}

// ---------------------------------------------------------------------------
// 참조 파일
// ---------------------------------------------------------------------------

pub fn extract_path_references(spec_text: &str) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut results = Vec::new();
    for m in PATH_LIKE.find_iter(spec_text) {
        // 앞쪽 UTF-16 코드 단위 10개 안에 `://`가 있으면 URL의 일부다(서로게이트 쌍을 가르는 끝은 `://`를 만들 수 없다)
        let mut units = 0;
        let mut from = m.start();
        for (offset, ch) in spec_text[..m.start()].char_indices().rev() {
            if units >= 10 {
                break;
            }
            units += ch.len_utf16();
            from = offset;
        }
        if spec_text[from..m.start()].contains("://") {
            continue;
        }
        if seen.insert(m.as_str()) {
            results.push(m.as_str().to_owned());
        }
    }
    results
}

pub fn build_missing_reference_question(path: &str) -> String {
    format!("참조한 파일 {path}이(가) 작업 복사본에 없습니다. 어디서 가져와야 하나요, 아니면 새로 만들어야 하나요?")
}

pub fn build_referenced_files_context(files: &JsValue, max_chars: f64) -> Res<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut used = 0.0f64;
    for file in array(Some(files), "참조 파일 목록")? {
        let path = tpl(member(Some(file), "path")?);
        let line = if truthy(member(Some(file), "exists")?) {
            let size = member(Some(file), "sizeBytes")?;
            let size_text = if nullish(size) { "0".to_owned() } else { tpl(size) };
            let preview = member(Some(file), "preview")?;
            let preview_text = if nullish(preview) { String::new() } else { tpl(preview) };
            format!("- {path} ({size_text} bytes): {preview_text}")
        } else {
            format!("- {path}: 파일 없음")
        };
        let length = js::utf16_len(&line) as f64;
        if used + length + 1.0 > max_chars {
            break;
        }
        lines.push(line);
        used += length + 1.0;
    }
    Ok(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// 추천 인용·프롬프트 글
// ---------------------------------------------------------------------------

pub fn verify_spec_quote(spec_quote: &str, spec_text: &str) -> bool {
    let quote = collapse_whitespace(spec_quote);
    if quote.is_empty() {
        return false;
    }
    collapse_whitespace(spec_text).contains(&quote)
}

pub fn build_extraction_user_prompt(spec_text: &str, referenced_files_context: Option<&str>) -> String {
    let context = referenced_files_context.map(js::trim).unwrap_or("");
    let tail = if context.is_empty() { String::new() } else { format!("\n\n[참조 파일 요약]\n{context}") };
    format!("Product spec:\n\n{}{tail}", js::trim(spec_text))
}

pub fn build_recommendation_user_prompt(questions: &[String], spec_text: &str, stack_summary: Option<&str>) -> String {
    let list = questions.iter().enumerate().map(|(index, question)| format!("{}. {question}", index + 1)).collect::<Vec<_>>().join("\n");
    let stack = stack_summary.map(js::trim).unwrap_or("");
    let stack_line = if stack.is_empty() { String::new() } else { format!("\n\n[프로젝트 스택]\n{stack}") };
    format!("Product spec:\n\n{}{stack_line}\n\nOpen questions:\n{list}", js::trim(spec_text))
}

pub fn build_extraction_retry_note(reason: &str) -> String {
    [
        format!("[이전 답을 쓸 수 없었습니다] {}", js::truncate_utf16(reason, 600)),
        "같은 형식의 JSON 객체 하나만 다시 출력하세요. 문자열 안의 큰따옴표는 반드시 \\\" 로 이스케이프하거나 작은따옴표·백틱으로 바꾸고, 해당 사항이 없는 선택 항목(ears·scenarios·nfr)은 null 대신 아예 빼세요.".to_owned(),
    ]
    .join("\n")
}

// ---------------------------------------------------------------------------
// 에이전트 안내 요약·입력창 채우기
// ---------------------------------------------------------------------------

/// 줄을 앞에서부터 채우고 넘치면 "…외 N개 생략"으로 마무리한다(두 요약이 같은 규칙)
fn fill_lines(header: &str, lines_in: &[String], max_chars: f64) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut used = js::utf16_len(header) as f64;
    for (index, line) in lines_in.iter().enumerate() {
        let length = js::utf16_len(line) as f64;
        if used + 1.0 + length > max_chars {
            let omitted = format!("…외 {}개 생략", lines_in.len() - index);
            if used + 1.0 + js::utf16_len(&omitted) as f64 <= max_chars {
                lines.push(omitted);
            }
            break;
        }
        lines.push(line.clone());
        used += 1.0 + length;
    }
    format!("{header}\n{}", lines.join("\n"))
}

pub fn summarize_requirements_for_guide(requirements: &JsValue, max_chars: f64) -> Res<String> {
    let mut lines = Vec::new();
    for requirement in array(Some(requirements), "요구사항 목록")? {
        let priority = member(Some(requirement), "priority")?;
        if is_str(priority, "must") || is_str(priority, "should") {
            lines.push(format!("{}. {} ({})", tpl(member(Some(requirement), "id")?), tpl(member(Some(requirement), "title")?), tpl(priority)));
        }
    }
    if lines.is_empty() {
        return Ok(String::new());
    }
    Ok(fill_lines(&format!("[요구사항 목록({REQUIREMENTS_FILE}) — id. 제목 (우선순위)]"), &lines, max_chars))
}

pub fn summarize_manual_steps_for_guide(manual_steps: &[String], max_chars: f64) -> String {
    if manual_steps.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = manual_steps.iter().map(|step| format!("- {step}")).collect();
    fill_lines("[사람이 할 일 — 에이전트는 이 항목을 절대 하지 않는다(저장소 권한·협업자·공개 범위 변경, 이메일 제출 등)]", &lines, max_chars)
}

fn rev_text(requirement: &JsValue) -> String {
    let rev = opt_member(Some(requirement), "rev");
    if nullish(rev) {
        "1".to_owned()
    } else {
        tpl(rev)
    }
}

fn test_naming_guidance(requirement: &JsValue) -> Res<String> {
    let scenarios: &[JsValue] = match member(Some(requirement), "scenarios")? {
        None | Some(JsValue::Null) => &[],
        Some(JsValue::Arr(items)) => items,
        Some(_) => return Err("scenarios는 배열이어야 합니다".to_owned()),
    };
    let ids = if scenarios.is_empty() {
        tpl(member(Some(requirement), "id")?)
    } else {
        let mut parts = Vec::new();
        for scenario in scenarios {
            parts.push(join_item(member(Some(scenario), "id")?));
        }
        parts.join(", ")
    };
    Ok(format!("테스트 이름에 {ids}을(를) 넣어 시나리오·인수 조건을 검증하는 테스트를 함께 작성해 주세요."))
}

pub fn build_requirement_work_prefill(requirement: &JsValue) -> Res<String> {
    let acceptance = array(member(Some(requirement), "acceptance")?, "acceptance")?.iter().map(|item| format!("- {}", item.to_js_string())).collect::<Vec<_>>().join("\n");
    let ears = member(Some(requirement), "ears")?;
    let ears_line = if truthy(ears) { format!("\n\nEARS: {}", tpl(member(ears, "statement")?)) } else { String::new() };
    let id = tpl(member(Some(requirement), "id")?);
    let title = tpl(member(Some(requirement), "title")?);
    let trailer = format!("커밋·PR 본문에 \"Implements: {id}@rev{}\"을 남겨 주세요.", rev_text(requirement));
    Ok(format!("[{id}] {title}{ears_line}\n\n인수 조건:\n{acceptance}\n\n{} {trailer}", test_naming_guidance(requirement)?))
}

pub fn build_all_must_haves_prefill(requirements: &JsValue) -> Res<String> {
    let mut items = Vec::new();
    for requirement in array(Some(requirements), "요구사항 목록")? {
        if is_str(member(Some(requirement), "priority")?, "must") {
            items.push(format!("- [{}] {}", tpl(member(Some(requirement), "id")?), tpl(member(Some(requirement), "title")?)));
        }
    }
    Ok(format!("다음 필수(must) 요구사항을 모두 구현해 주세요. 서로 독립적인 부분이 있으면 레인을 나눠 계획을 세워도 됩니다. 요구사항마다 테스트 이름에 해당 id(시나리오가 있으면 R1.1처럼 시나리오 id, 없으면 R1)를 넣어 검증하는 테스트를 함께 작성하고, 커밋·PR 본문에 \"Implements: R1@rev1\" 같은 트레일러를 남겨 주세요.\n\n{}", items.join("\n")))
}

// ---------------------------------------------------------------------------
// 재추출 병합
// ---------------------------------------------------------------------------

fn char_bigrams(text: &str) -> HashSet<Vec<u16>> {
    let normalized = collapse_whitespace(&text.to_lowercase());
    let units: Vec<u16> = normalized.encode_utf16().collect();
    if units.len() < 2 {
        return if units.is_empty() { HashSet::new() } else { HashSet::from([units]) };
    }
    units.windows(2).map(<[u16]>::to_vec).collect()
}

pub fn text_similarity(a: &str, b: &str) -> f64 {
    let (set_a, set_b) = (char_bigrams(a), char_bigrams(b));
    if set_a.is_empty() && set_b.is_empty() {
        return 1.0;
    }
    if set_a.is_empty() || set_b.is_empty() {
        return 0.0;
    }
    let intersection = set_a.iter().filter(|gram| set_b.contains(*gram)).count();
    let union = set_a.len() + set_b.len() - intersection;
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

fn normalize_title(title: &str) -> String {
    let lowered = title.to_lowercase();
    let replaced: String = lowered.chars().map(|c| if "`'\"“”‘’()[]{}·,.:;!?—–-+/".contains(c) { ' ' } else { c }).collect();
    collapse_whitespace(&replaced)
}

pub fn api_signature(title: &str) -> Option<String> {
    let m = API_SIGNATURE.captures(title)?;
    Some(format!("{} {}", m[1].to_ascii_uppercase(), m[2].trim_end_matches('/')))
}

fn similarity_text(requirement: &JsValue) -> Res<String> {
    let title = tpl(member(Some(requirement), "title")?);
    let ears = member(Some(requirement), "ears")?;
    let statement = opt_member(ears, "statement");
    let tail = if nullish(statement) { join_values(array(member(Some(requirement), "acceptance")?, "acceptance")?, " ") } else { tpl(statement) };
    Ok(format!("{title} {tail}"))
}

pub fn requirement_similarity(a: &JsValue, b: &JsValue) -> Res<f64> {
    let title_a = string(member(Some(a), "title")?, "title")?;
    let title_b = string(member(Some(b), "title")?, "title")?;
    let (signature_a, signature_b) = (api_signature(title_a), api_signature(title_b));
    if let (Some(x), Some(y)) = (&signature_a, &signature_b) {
        return Ok(if x == y { 1.0 } else { 0.0 });
    }
    let title_score = text_similarity(&normalize_title(title_a), &normalize_title(title_b));
    let text_score = text_similarity(&similarity_text(a)?, &similarity_text(b)?);
    let kind_bonus = if crate::js_json::opt_strict_equals(member(Some(a), "kind")?, member(Some(b), "kind")?) { 0.15 } else { 0.0 };
    Ok((title_score.max(text_score) * 0.85 + kind_bonus).min(1.0))
}

fn requirement_id_number(requirement: &JsValue) -> Res<f64> {
    let id = string(member(Some(requirement), "id")?, "id")?;
    let mut chars = id.chars();
    chars.next();
    Ok(js::to_number(chars.as_str()))
}

struct DiffEntry {
    status: &'static str,
    id: JsValue,
    requirement: JsValue,
    previous: Option<JsValue>,
}

impl DiffEntry {
    fn to_value(&self) -> JsValue {
        object(vec![("status", str_value(self.status)), ("id", Some(self.id.clone())), ("requirement", Some(self.requirement.clone())), ("previous", self.previous.clone())])
    }
}

fn revised_or_same(requirement: JsValue, now: &str) -> Res<JsValue> {
    Ok(revise_raw(&requirement, now)?.unwrap_or(requirement))
}

/// `Math.max`(NaN이 끼면 NaN)
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `{ merged, diff }`. `now`는 호출하는 쪽이 정한 시각(ISO 8601)
pub fn merge_reextracted_requirements(incoming: &JsValue, existing: &JsValue, now: &str) -> Res<JsValue> {
    let incoming = array(Some(incoming), "새 요구사항 목록")?;
    let existing = array(Some(existing), "기존 요구사항 목록")?;
    let mut pairs: Vec<(usize, usize, f64)> = Vec::new();
    for (incoming_index, candidate) in incoming.iter().enumerate() {
        for (existing_index, stored) in existing.iter().enumerate() {
            let score = requirement_similarity(candidate, stored)?;
            if score >= MERGE_MATCH_THRESHOLD {
                pairs.push((incoming_index, existing_index, score));
            }
        }
    }
    let pairs = js::stable_sort_by(pairs, &|a, b| b.2 - a.2);
    let mut matched_incoming: Vec<Option<usize>> = vec![None; incoming.len()];
    let mut used_existing: HashSet<usize> = HashSet::new();
    for (incoming_index, existing_index, _) in pairs {
        if matched_incoming[incoming_index].is_some() || used_existing.contains(&existing_index) {
            continue;
        }
        matched_incoming[incoming_index] = Some(existing_index);
        used_existing.insert(existing_index);
    }
    let mut max_number = 0.0;
    for requirement in existing {
        max_number = js_max(max_number, requirement_id_number(requirement)?);
    }
    let mut next_id_number = 1.0 + max_number;
    let (mut added, mut changed, mut unchanged): (Vec<DiffEntry>, Vec<DiffEntry>, Vec<DiffEntry>) = (Vec::new(), Vec::new(), Vec::new());
    let mut merged: Vec<JsValue> = Vec::new();
    for (incoming_index, candidate) in incoming.iter().enumerate() {
        match matched_incoming[incoming_index] {
            None => {
                let id = format!("R{}", number_to_string(next_id_number));
                next_id_number += 1.0;
                let with_id = align_requirement(&with_key(candidate, "id", str_value(id))?)?;
                let revised = revised_or_same(with_id, now)?;
                merged.push(revised.clone());
                added.push(DiffEntry { status: "added", id: member(Some(&revised), "id")?.cloned().unwrap_or(JsValue::Null), requirement: revised, previous: None });
            }
            Some(existing_index) => {
                let prior = &existing[existing_index];
                let prior_id = member(Some(prior), "id")?.cloned();
                let aligned = align_requirement(&with_key(candidate, "id", prior_id)?)?;
                let with_id = carry_forward_raw(&aligned, prior)?;
                let revised = revised_or_same(with_id, now)?;
                merged.push(revised.clone());
                let id = member(Some(&revised), "id")?.cloned().unwrap_or(JsValue::Null);
                if crate::js_json::opt_strict_equals(member(Some(&revised), "hash")?, member(Some(prior), "hash")?) {
                    unchanged.push(DiffEntry { status: "unchanged", id, requirement: revised, previous: None });
                } else {
                    changed.push(DiffEntry { status: "changed", id, requirement: revised, previous: Some(prior.clone()) });
                }
            }
        }
    }
    let mut removed: Vec<DiffEntry> = Vec::new();
    for (existing_index, stored) in existing.iter().enumerate() {
        if used_existing.contains(&existing_index) {
            continue;
        }
        merged.push(stored.clone());
        removed.push(DiffEntry { status: "removed", id: member(Some(stored), "id")?.cloned().unwrap_or(JsValue::Null), requirement: stored.clone(), previous: Some(stored.clone()) });
    }
    for entry in &mut added {
        let mut best: Option<(JsValue, f64)> = None;
        for removed_entry in &removed {
            let same_kind = crate::js_json::opt_strict_equals(member(Some(&removed_entry.requirement), "kind")?, member(Some(&entry.requirement), "kind")?);
            if !same_kind {
                continue;
            }
            let score = requirement_similarity(&entry.requirement, &removed_entry.requirement)?;
            if score >= MERGE_SPLIT_HINT_THRESHOLD && best.as_ref().is_none_or(|(_, best_score)| score > *best_score) {
                best = Some((removed_entry.id.clone(), score));
            }
        }
        if let Some((best_id, _)) = best {
            let previous_trace = member(Some(&entry.requirement), "trace")?;
            let mut trace = match previous_trace {
                Some(JsValue::Obj(o)) => o.clone(),
                _ => JsObject::new(),
            };
            trace.set("supersedes", best_id);
            let with_supersedes = with_key(&entry.requirement, "trace", Some(JsValue::Obj(trace)))?;
            entry.requirement = with_supersedes.clone();
            let mut position = None;
            for (i, requirement) in merged.iter().enumerate() {
                if crate::js_json::opt_strict_equals(member(Some(requirement), "id")?, Some(&entry.id)) {
                    position = Some(i);
                    break;
                }
            }
            if let Some(i) = position {
                merged[i] = with_supersedes;
            }
        }
    }
    let mut keyed: Vec<(f64, JsValue)> = Vec::with_capacity(merged.len());
    for requirement in merged {
        keyed.push((requirement_id_number(&requirement)?, requirement));
    }
    let merged: Vec<JsValue> = js::stable_sort_by(keyed, &|a, b| a.0 - b.0).into_iter().map(|(_, requirement)| requirement).collect();
    let diff: Vec<JsValue> = added.iter().chain(&changed).chain(&unchanged).chain(&removed).map(DiffEntry::to_value).collect();
    Ok(strip_undefined(object(vec![("merged", Some(JsValue::Arr(merged))), ("diff", Some(JsValue::Arr(diff)))])))
}

// ---------------------------------------------------------------------------
// 추적 매트릭스 보조
// ---------------------------------------------------------------------------

/// `findUnexecutedTests`: `[{ file, name, reason? }]`
pub fn find_unexecuted_tests(requirement_id: &str, rows: &JsValue) -> Res<JsValue> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut result = Vec::new();
    for row in array(Some(rows), "테스트 실행 행")? {
        if !is_str(member(Some(row), "id")?, requirement_id) || !is_str(member(Some(row), "status")?, "not-run") {
            continue;
        }
        let file = member(Some(row), "file")?;
        let name = member(Some(row), "name")?;
        if !seen.insert(format!("{}\u{0}{}", tpl(file), tpl(name))) {
            continue;
        }
        let reason = member(Some(row), "reason")?;
        result.push(object(vec![("file", file.cloned()), ("name", name.cloned()), ("reason", if truthy(reason) { reason.cloned() } else { None })]));
    }
    Ok(JsValue::Arr(result))
}

fn csv_cell(value: &str) -> String {
    if value.contains(['"', ',', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn test_result_label(result: &JsValue) -> String {
    match result {
        JsValue::Str(s) if s == "pass" => "통과".to_owned(),
        JsValue::Str(s) if s == "fail" => "실패".to_owned(),
        JsValue::Str(s) if s == "not-run" => "안 돌림".to_owned(),
        _ => "undefined".to_owned(),
    }
}

/// 추적 매트릭스를 CSV(쉼표 구분, CRLF 줄바꿈)로 만든다
pub fn build_matrix_csv(matrix: &JsValue) -> Res<String> {
    let header = ["종류", "id", "상위 id", "제목", "개정", "우선순위", "이슈", "커밋", "테스트", "게이트", "검증 출처", "상태"];
    let mut lines = vec![header.iter().map(|cell| csv_cell(cell)).collect::<Vec<_>>().join(",")];
    for row in array(member(Some(matrix), "rows")?, "matrix.rows")? {
        let kind = if is_str(member(Some(row), "kind")?, "requirement") { "요구사항" } else { "시나리오" };
        let parent = member(Some(row), "parentId")?;
        let issue = member(Some(row), "issue")?;
        let mut checkpoints = Vec::new();
        for checkpoint in array(member(Some(row), "checkpoints")?, "checkpoints")? {
            checkpoints.push(tpl(member(Some(checkpoint), "shortSha")?));
        }
        let mut tests = Vec::new();
        for test in array(member(Some(row), "tests")?, "tests")? {
            let name = tpl(member(Some(test), "name")?);
            let result = member(Some(test), "result")?;
            tests.push(if truthy(result) { format!("{name}({})", test_result_label(result.expect("result"))) } else { name });
        }
        let mut gates = Vec::new();
        for check in array(member(Some(row), "gateChecks")?, "gateChecks")? {
            let ok = if truthy(member(Some(check), "ok")?) { "통과" } else { "실패" };
            gates.push(format!("{}:{ok}", tpl(member(Some(check), "name")?)));
        }
        let verified_by = member(Some(row), "verifiedBy")?;
        let cells = [
            kind.to_owned(),
            tpl(member(Some(row), "id")?),
            if nullish(parent) { String::new() } else { tpl(parent) },
            tpl(member(Some(row), "title")?),
            tpl(member(Some(row), "rev")?),
            tpl(member(Some(row), "priority")?),
            if issue.is_some() { format!("#{}", tpl(issue)) } else { String::new() },
            checkpoints.join(" "),
            tests.join(" | "),
            gates.join(" | "),
            if is_str(verified_by, "none") { String::new() } else { tpl(verified_by) },
            tpl(member(Some(row), "status")?),
        ];
        lines.push(cells.iter().map(|cell| csv_cell(cell)).collect::<Vec<_>>().join(","));
    }
    Ok(lines.join("\r\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json::parse;

    fn v(text: &str) -> JsValue {
        parse(text).expect("JSON")
    }

    #[test]
    fn 정규식이_컴파일된다() {
        for pattern in [&*MENTION, &*RANGE_MENTION, &*IMPLEMENTS_TRAILER, &*TEST_FILE, &*WEAK_ETC, &*MUST_STATEMENT, &*REPO_CONTEXT, &*HEADING_LINE, &*NUMBERED_LINE, &*BULLET_LINE, &*PATH_LIKE, &*API_SIGNATURE, &*TRAILING_SCENARIO_NUMBER] {
            let _ = pattern.is_match("");
        }
        assert_eq!(WEAK_KO.len() + WEAK_EN.len() + MANUAL_STANDALONE.len() + MANUAL_IN_REPO.len() + KIND_KEYWORDS.len(), 36);
    }

    #[test]
    fn 범위_표기_안의_id는_언급으로_세지_않는다() {
        assert_eq!(find_mentioned_ids("R1~R32 확인, R5 그리고 R32"), vec!["R5", "R32"]);
        assert_eq!(find_mentioned_ids("R1.2 R10 xR3 R4a"), vec!["R1.2", "R10"]);
    }

    #[test]
    fn 켈빈_기호와_긴_s는_ascii_글자로_접지_않는다() {
        assert!(is_manual_step_text("collaborator 추가"));
        assert!(!is_manual_step_text("COLLABORATOR".replace('O', "\u{212A}").as_str()));
        assert!(is_likely_test_file("a.TEST.TS"));
        assert!(!is_likely_test_file("a.te\u{17F}t.ts"));
    }

    #[test]
    fn 내용_해시는_옛_값과_같다() {
        let requirement = v(r#"{"id":"R1","title":"로그인","kind":"api","priority":"must","acceptance":["a"]}"#);
        assert_eq!(compute_requirement_hash(&requirement).unwrap().len(), 16);
        let bumped = revise_requirement_if_changed(&requirement, "now").unwrap().unwrap();
        assert!(revise_requirement_if_changed(&bumped, "later").unwrap().is_none());
    }

    #[test]
    fn 상태_규칙의_기본_갈래() {
        let none = v(r#"{"checkpoints":[],"tests":[],"gateChecks":[]}"#);
        assert_eq!(compute_requirement_status(&none, None).unwrap(), STATUS_NOT_STARTED);
        let failed = v(r#"{"checkpoints":[],"tests":[],"gateChecks":[{"name":"a","ok":true},{"name":"b","ok":false}]}"#);
        assert_eq!(compute_requirement_status(&failed, None).unwrap(), STATUS_FAILED);
    }
}
