//! 게이트의 자동 화면 확인이 열어 볼 Next.js 페이지를 고른다(옛 TS: `packages/agent/src/next-routes.ts`). 순수 함수만 있다.
//!
//! JS와 같게 읽는 곳:
//! - `PAGE_FILE`(`/^(?:src\/)?app\/(.*\/)?page\.(?:tsx|jsx|ts|js|mdx)$/`)·세그먼트 분류 정규식은 손으로 읽는다. `.`은 줄 끝 글자
//!   (`\n` `\r` U+2028 U+2029)를 뺀다. `/i`는 ASCII 대소문자만 같게 본다(비ASCII 글자는 ASCII로 접히지 않는다).
//! - `limit = Math.max(1, Math.min(Math.floor(maxPages), cap))`: `NaN`이면 `NaN`이 그대로 남는다(`routes.length < NaN`은 거짓,
//!   `slice(NaN)`은 `slice(0)`, `slice(0, NaN)`은 빈 배열, 메시지에는 `NaN개`).
//! - 정렬 비교 `a.distance - b.distance || (a.tie ?? 0) - (b.tie ?? 0) || …`은 `NaN`이 거짓이라 다음 비교로 넘어간다. 안정 정렬은 `v8_sort`(63개 이하는 V8과 같은 순서, 그 이상은 `js::stable_sort_by`).
//! - 경로 정규화(`normalizePath`)는 옛 순서 그대로: `\`→`/`, 앞 `./` 하나, 겹친 `/`, 끝 `/` 하나.
//! - `Map`·`Set` 삽입 순서, 결과 키 순서(`path, file, usedFallbackParams, cause, distance`)와 조건부 펼침의 생략.
//!
//! 의도한 차이:
//! 1. 경로 이름 정렬(`routesFromChangedFiles`의 `a.path.localeCompare(b.path)`, `routesFromCandidates` 마지막 비교의 `a.page.localeCompare(b.page)`)은
//!    `js_locale::locale_compare`다. ASCII 글자만 있는 이름은 ICU 기본 정렬과 같고(대소문자·`_`·`-` 순서 포함), 비ASCII 글자(한글·é 등)는 코드 포인트 순서로
//!    뒤에 둔다. 상한(`maxPages`) 안에 드는 페이지가 정렬 순서에 달려 있으므로 ASCII 이름의 선택은 옛 동작을 지킨다.
//! 2. `sampleParams`는 자기 속성만 읽는다. 옛 TS는 `sampleParams['constructor']`처럼 `Object.prototype`의 속성도 읽어 `[constructor]`
//!    폴더가 함수 원문 글자로 채워졌다.

use crate::js::{self, is_js_line_terminator};
use crate::js_locale;
use crate::js_json::{self, JsObject, JsValue};
use std::collections::{HashMap, HashSet};

/// 상한 때문에 못 연 페이지를 한 줄로 남길 때 이름을 몇 개까지 적을지
const OVERFLOW_NAMES: usize = 8;
const PAGE_EXTENSIONS: [&str; 5] = ["tsx", "jsx", "ts", "js", "mdx"];

#[derive(Clone, Debug, PartialEq)]
pub struct NextRoute {
    pub path: String,
    pub file: String,
    pub used_fallback_params: Vec<String>,
    pub cause: Option<String>,
    pub distance: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkippedNextRoute {
    pub file: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct NextRoutes {
    pub routes: Vec<NextRoute>,
    pub skipped: Vec<SkippedNextRoute>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RouteCandidate {
    pub page: String,
    pub cause: String,
    /// `undefined`(없음)는 `NaN`처럼 읽는다(`undefined - x`는 `NaN`)
    pub distance: f64,
    pub tie: f64,
}

impl NextRoutes {
    pub fn to_value(&self) -> JsValue {
        let routes = self
            .routes
            .iter()
            .map(|r| {
                js_json::object(vec![
                    ("path", Some(JsValue::str(&r.path))),
                    ("file", Some(JsValue::str(&r.file))),
                    ("usedFallbackParams", (!r.used_fallback_params.is_empty()).then(|| JsValue::Arr(r.used_fallback_params.iter().map(JsValue::str).collect()))),
                    ("cause", r.cause.as_ref().map(JsValue::str)),
                    ("distance", r.distance.map(JsValue::Num)),
                ])
            })
            .collect();
        let skipped = self
            .skipped
            .iter()
            .map(|s| js_json::object(vec![("file", Some(JsValue::str(&s.file))), ("reason", Some(JsValue::str(&s.reason)))]))
            .collect();
        js_json::object(vec![("routes", Some(JsValue::Arr(routes))), ("skipped", Some(JsValue::Arr(skipped)))])
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.max(1, Math.min(Math.floor(maxPages), cap))`
fn page_limit(max_pages: f64, cap: f64) -> f64 {
    js_max(1.0, js_min(max_pages.floor(), cap))
}

/// `arr.slice(0, limit)`의 끝(limit은 1 이상이거나 NaN)
fn take_count(len: usize, limit: f64) -> usize {
    if limit.is_nan() {
        0
    } else {
        limit.trunc().min(len as f64) as usize
    }
}

/// 윈도 구분자와 `./`를 없애고 `a//b` 같은 중복 슬래시를 하나로 접는다. 옛 순서: `\`→`/`, 앞 `./` 하나, 겹친 `/`, 끝 `/` 하나
pub fn normalize_path(value: &str) -> String {
    let replaced = value.replace('\\', "/");
    let stripped = replaced.strip_prefix("./").unwrap_or(&replaced);
    let mut collapsed = String::with_capacity(stripped.len());
    let mut prev_slash = false;
    for c in stripped.chars() {
        if c == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        collapsed.push(c);
    }
    if collapsed.ends_with('/') {
        collapsed.pop();
    }
    collapsed
}

/// 세그먼트 이름이 id처럼 보이는지(ADR-078): `^id$`(/i), `[a-z0-9]Id$`, `[_-]id$`(/i)
pub fn is_id_like_segment(name: &str) -> bool {
    let chars: Vec<char> = name.chars().collect();
    let eq_ci = |c: char, lower: char| c.is_ascii() && c.to_ascii_lowercase() == lower;
    let n = chars.len();
    if n == 2 && eq_ci(chars[0], 'i') && eq_ci(chars[1], 'd') {
        return true;
    }
    if n >= 3 && chars[n - 2] == 'I' && chars[n - 1] == 'd' {
        let before = chars[n - 3];
        if before.is_ascii_lowercase() || before.is_ascii_digit() {
            return true;
        }
    }
    if n >= 3 && (chars[n - 3] == '_' || chars[n - 3] == '-') && eq_ci(chars[n - 2], 'i') && eq_ci(chars[n - 1], 'd') {
        return true;
    }
    false
}

enum Segment<'a> {
    Group,
    Static,
    Dynamic(&'a str),
    Skip(String),
}

/// `/^\[{1,2}\.\.\.[^\]]+\]{1,2}$/`
fn is_catch_all(segment: &str) -> bool {
    for brackets in [2usize, 1] {
        let open = "[".repeat(brackets);
        let Some(rest) = segment.strip_prefix(open.as_str()).and_then(|r| r.strip_prefix("...")) else { continue };
        let Some(close) = rest.find(']') else { continue };
        if close == 0 {
            continue;
        }
        let tail = &rest[close..];
        if tail == "]" || tail == "]]" {
            return true;
        }
    }
    false
}

fn classify(segment: &str) -> Segment<'_> {
    if segment.starts_with('@') {
        return Segment::Skip("병렬 라우트(@slot)는 경로를 하나로 정할 수 없어 열지 않습니다".to_owned());
    }
    // /^\(\.{1,2}\)+/
    if segment.starts_with("(.)") || segment.starts_with("(..)") {
        return Segment::Skip("인터셉트 라우트((.)·(..))는 화면 주소가 아니어서 열지 않습니다".to_owned());
    }
    if is_catch_all(segment) {
        return Segment::Skip("catch-all 라우트([...x])는 열어 볼 값을 정할 수 없어 열지 않습니다".to_owned());
    }
    // /^\[([^[\]]+)\]$/
    if let Some(inner) = segment.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        if !inner.is_empty() && !inner.contains(['[', ']']) {
            return Segment::Dynamic(inner);
        }
    }
    if segment.starts_with('[') {
        return Segment::Skip(format!("동적 세그먼트 형식을 알아볼 수 없어 열지 않습니다: {segment}"));
    }
    // /^\(.+\)$/
    if let Some(inner) = segment.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        if !inner.is_empty() && !inner.chars().any(is_js_line_terminator) {
            return Segment::Group;
        }
    }
    Segment::Static
}

/// `PAGE_FILE`에 맞으면 page 폴더(끝 `/` 하나를 뗀 것). 안 맞으면 None
fn page_folder(relative: &str) -> Option<&str> {
    let rest = relative.strip_prefix("src/").and_then(|r| r.strip_prefix("app/")).or_else(|| relative.strip_prefix("app/"))?;
    for ext in PAGE_EXTENSIONS {
        let page = format!("page.{ext}");
        let Some(head) = rest.strip_suffix(page.as_str()) else { continue };
        if head.is_empty() {
            return Some("");
        }
        if head.ends_with('/') && !head.chars().any(is_js_line_terminator) {
            return Some(&head[..head.len() - 1]);
        }
    }
    None
}

enum Built {
    NotPage,
    Skip(String),
    Route { path: String, used_fallback: Vec<String> },
}

fn route_from_page(relative: &str, sample_params: &JsObject, fallback_value: Option<&str>) -> Built {
    let Some(folder) = page_folder(relative) else { return Built::NotPage };
    let segments: Vec<&str> = if folder.is_empty() { Vec::new() } else { folder.split('/').collect() };
    let mut parts: Vec<String> = Vec::new();
    let mut used_fallback: Vec<String> = Vec::new();
    for segment in segments {
        match classify(segment) {
            Segment::Skip(reason) => return Built::Skip(reason),
            Segment::Group => continue,
            Segment::Dynamic(name) => {
                match sample_params.get(name) {
                    Some(value) if !matches!(value, JsValue::Str(s) if s.is_empty()) => {
                        parts.push(js::encode_uri_component(&value.to_js_string()));
                        continue;
                    }
                    _ => {}
                }
                if let Some(fallback) = fallback_value {
                    if is_id_like_segment(name) {
                        parts.push(js::encode_uri_component(fallback));
                        used_fallback.push(name.to_owned());
                        continue;
                    }
                }
                return Built::Skip(format!("동적 세그먼트 '{name}'의 값이 없습니다 — autoPageChecks.sampleParams에 넣으세요"));
            }
            Segment::Static => parts.push(segment.to_owned()),
        }
    }
    Built::Route { path: format!("/{}", parts.join("/")), used_fallback }
}

fn over_limit_reason(limit: f64) -> String {
    format!("한 번에 열어 보는 페이지 상한({}개)을 넘었습니다 — autoPageChecks.maxPages를 늘리세요", js::number_to_string(limit))
}

/// `Array.prototype.sort(비교 함수)`. 비교 함수가 일관되면 어떤 안정 정렬이든 결과가 같다(`js::stable_sort_by`). 그런데 후보의 비교는
/// `distance`나 `tie`가 `NaN`·`Infinity`(같은 무한끼리의 뺄셈)이면 일관되지 않아(`NaN`은 거짓이라 다음 기준으로 넘어간다) 결과가 정렬 알고리즘에 달려 있다.
/// V8은 63개 이하를 "처음 이어지는 오름차순·내림차순 구간 세기 + 이진 삽입 정렬"로 정렬하므로(array-sort.tq의 CountAndMakeRun·BinaryInsertionSort)
/// 그 순서를 그대로 따른다. 64개 이상은 TimSort 병합을 옮기지 않았다: 일관되지 않은 비교 함수에서만 V8과 다를 수 있다
fn v8_sort<T: Clone>(items: Vec<T>, cmp: &dyn Fn(&T, &T) -> f64) -> Vec<T> {
    let n = items.len();
    if n >= 64 {
        return js::stable_sort_by(items, cmp);
    }
    if n < 2 {
        return items;
    }
    let mut a = items;
    let c = |x: &T, y: &T| {
        let v = cmp(x, y);
        if v.is_nan() {
            0.0
        } else {
            v
        }
    };
    // CountAndMakeRun(0, n)
    let descending = c(&a[1], &a[0]) < 0.0;
    let mut run = 2;
    for idx in 2..n {
        let order = c(&a[idx], &a[idx - 1]);
        if descending {
            if order >= 0.0 {
                break;
            }
        } else if order < 0.0 {
            break;
        }
        run += 1;
    }
    if descending {
        a[..run].reverse();
    }
    // BinaryInsertionSort(0, run, n)
    for start in run..n {
        let pivot = a[start].clone();
        let (mut left, mut right) = (0usize, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if c(&pivot, &a[mid]) < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        for p in (left + 1..=start).rev() {
            a[p] = a[p - 1].clone();
        }
        a[left] = pivot;
    }
    a
}

/// 바뀐 파일에서 열어 볼 페이지를 고른다(`routesFromChangedFiles`)
pub fn routes_from_changed_files(files: &[String], service_path: &str, sample_params: &JsObject, max_pages: f64, max_pages_cap: f64, fallback_value: Option<&str>) -> NextRoutes {
    let prefix = normalize_path(service_path);
    let limit = page_limit(max_pages, max_pages_cap);
    let mut routes: Vec<NextRoute> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut skipped: Vec<SkippedNextRoute> = Vec::new();

    let mut normalized: Vec<String> = files.iter().map(|f| normalize_path(f)).collect();
    normalized.sort_by(|a, b| js::cmp_utf16(a, b));
    normalized.dedup();
    for file in normalized {
        let relative: Option<String> = if prefix.is_empty() || prefix == "." {
            Some(file.clone())
        } else {
            file.strip_prefix(&format!("{prefix}/")).map(str::to_owned)
        };
        let Some(relative) = relative else { continue };
        match route_from_page(&relative, sample_params, fallback_value) {
            Built::NotPage => continue,
            Built::Skip(reason) => skipped.push(SkippedNextRoute { file, reason }),
            Built::Route { path, used_fallback } => {
                if seen.insert(path.clone()) {
                    routes.push(NextRoute { path, file, used_fallback_params: used_fallback, cause: None, distance: None });
                }
            }
        }
    }

    // 의도한 차이 1: localeCompare는 ASCII 범위만 같고 나머지는 코드 포인트 순서(`js_locale::locale_compare`)
    routes.sort_by(|a, b| js_locale::locale_compare(&a.path, &b.path).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let start = js::relative_start(routes.len(), limit);
    for route in routes.iter().skip(start) {
        skipped.push(SkippedNextRoute { file: route.file.clone(), reason: over_limit_reason(limit) });
    }
    routes.truncate(take_count(routes.len(), limit));
    NextRoutes { routes, skipped }
}

/// import 역추적으로 모은 후보에서 열어 볼 페이지를 고른다(`routesFromCandidates`)
pub fn routes_from_candidates(candidates: &[RouteCandidate], service_path: &str, sample_params: &JsObject, max_pages: f64, max_pages_cap: f64, fallback_value: Option<&str>) -> NextRoutes {
    let prefix = normalize_path(service_path);
    let limit = page_limit(max_pages, max_pages_cap);
    let to_project = |in_service: &str| -> String {
        if prefix.is_empty() || prefix == "." {
            in_service.to_owned()
        } else {
            format!("{prefix}/{in_service}")
        }
    };
    let truthy = |v: f64| !(v == 0.0 || v.is_nan());
    let ordered = v8_sort(candidates.to_vec(), &|a: &RouteCandidate, b: &RouteCandidate| {
        let d = a.distance - b.distance;
        if truthy(d) {
            return d;
        }
        let t = a.tie - b.tie;
        if truthy(t) {
            return t;
        }
        // 의도한 차이 1(`localeCompare`)
        js_locale::locale_compare(&a.page, &b.page)
    });

    let mut routes: Vec<NextRoute> = Vec::new();
    let mut skipped: Vec<SkippedNextRoute> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut overflow: Vec<(String, Vec<String>)> = Vec::new();
    let mut overflow_index: HashMap<String, usize> = HashMap::new();
    for candidate in &ordered {
        let built = route_from_page(&candidate.page, sample_params, fallback_value);
        if matches!(built, Built::NotPage) {
            continue;
        }
        let file = to_project(&candidate.page);
        let cause = to_project(&candidate.cause);
        let (path, used_fallback) = match built {
            Built::NotPage => continue,
            Built::Skip(reason) => {
                let reason = if candidate.distance > 0.0 { format!("{reason} ({cause} 변경으로 찾은 페이지)") } else { reason };
                skipped.push(SkippedNextRoute { file, reason });
                continue;
            }
            Built::Route { path, used_fallback } => (path, used_fallback),
        };
        if !seen.insert(path.clone()) {
            continue;
        }
        if (routes.len() as f64) < limit {
            let nearer = candidate.distance > 0.0;
            routes.push(NextRoute {
                path,
                file,
                used_fallback_params: used_fallback,
                cause: nearer.then(|| cause),
                distance: nearer.then_some(candidate.distance),
            });
        } else if candidate.distance == 0.0 {
            skipped.push(SkippedNextRoute { file, reason: over_limit_reason(limit) });
        } else {
            let index = *overflow_index.entry(cause.clone()).or_insert_with(|| {
                overflow.push((cause.clone(), Vec::new()));
                overflow.len() - 1
            });
            overflow[index].1.push(path);
        }
    }
    for (cause, paths) in overflow {
        let shown = paths.iter().take(OVERFLOW_NAMES).cloned().collect::<Vec<_>>().join(", ");
        let rest = if paths.len() > OVERFLOW_NAMES { format!(" 외 {}개", paths.len() - OVERFLOW_NAMES) } else { String::new() };
        skipped.push(SkippedNextRoute {
            file: cause.clone(),
            reason: format!(
                "{cause} 변경을 쓰는 페이지 {}개를 한 번에 열어 보는 페이지 상한({}개) 때문에 열지 못했습니다: {shown}{rest} — autoPageChecks.maxPages를 늘리면 더 엽니다",
                paths.len(),
                js::number_to_string(limit)
            ),
        });
    }
    NextRoutes { routes, skipped }
}

/// 후보 목록(`RouteCandidate[]`을 `encodeNative`한 것)을 읽는다. 모양이 어긋나면 이유를 돌려준다
pub fn parse_candidates(value: &JsValue) -> Result<Vec<RouteCandidate>, String> {
    let JsValue::Arr(items) = value else { return Err("후보 목록이 배열이 아닙니다".into()) };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let JsValue::Obj(_) = item else { return Err("후보가 객체가 아닙니다".into()) };
        let text = |key: &str| match item.prop(key) {
            Some(JsValue::Str(s)) => Ok(s.clone()),
            _ => Err(format!("후보의 {key}가 문자열이 아닙니다")),
        };
        let num = |key: &str, missing: f64| match item.prop(key) {
            None | Some(JsValue::Null) => missing,
            Some(v) => v.to_number(),
        };
        // distance가 없으면 `undefined - x`는 NaN, tie가 없거나 null이면 `?? 0`
        let distance = match item.prop("distance") {
            None => f64::NAN,
            Some(v) => v.to_number(),
        };
        out.push(RouteCandidate { page: text("page")?, cause: text("cause")?, distance, tie: num("tie", 0.0) });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> JsObject {
        let mut o = JsObject::new();
        for (k, v) in pairs {
            o.set(k, JsValue::str(*v));
        }
        o
    }

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn normalize_follows_the_old_order() {
        assert_eq!(normalize_path(".\\a\\\\b/"), "a/b");
        assert_eq!(normalize_path(".//a"), "/a");
        assert_eq!(normalize_path("a/"), "a");
        assert_eq!(normalize_path("a//"), "a");
    }

    #[test]
    fn id_like_segments() {
        for yes in ["id", "ID", "iD", "orderId", "a1Id", "order_id", "order-ID"] {
            assert!(is_id_like_segment(yes), "{yes}");
        }
        for no in ["grid", "slug", "xId1", "ıd", "orderid", ""] {
            assert!(!is_id_like_segment(no), "{no}");
        }
    }

    #[test]
    fn classifies_next_segments() {
        assert!(matches!(classify("@modal"), Segment::Skip(_)));
        assert!(matches!(classify("(.)photo"), Segment::Skip(_)));
        assert!(matches!(classify("(..)(..)photo"), Segment::Skip(_)));
        assert!(matches!(classify("[...slug]"), Segment::Skip(_)));
        assert!(matches!(classify("[[...slug]]"), Segment::Skip(_)));
        assert!(matches!(classify("[id]"), Segment::Dynamic("id")));
        assert!(matches!(classify("[a[b]"), Segment::Skip(_)));
        assert!(matches!(classify("(group)"), Segment::Group));
        assert!(matches!(classify("()"), Segment::Static));
        assert!(matches!(classify("_private"), Segment::Static));
    }

    #[test]
    fn changed_files_pick_and_cap() {
        let list = files(&["app/b/page.tsx", "app/a/page.tsx", "app/(g)/c/page.tsx", "app/d/[id]/page.tsx", "README.md"]);
        let r = routes_from_changed_files(&list, "", &JsObject::new(), 2.0, 10.0, None);
        assert_eq!(r.routes.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["/a", "/b"]);
        assert_eq!(r.skipped.len(), 2);
        assert!(r.skipped[0].reason.contains("동적 세그먼트 'id'"));
        assert!(r.skipped[1].reason.contains("상한(2개)"));
        let r = routes_from_changed_files(&list, "", &params(&[("id", "7")]), 10.0, 10.0, None);
        assert_eq!(r.routes.len(), 4);
        assert_eq!(r.routes[3].path, "/d/7");
    }

    #[test]
    fn nan_limit_hides_everything_but_reports_it() {
        let list = files(&["app/a/page.tsx"]);
        let r = routes_from_changed_files(&list, "", &JsObject::new(), f64::NAN, 10.0, None);
        assert!(r.routes.is_empty());
        assert_eq!(r.skipped.len(), 1);
        assert!(r.skipped[0].reason.contains("상한(NaN개)"));
    }
}
