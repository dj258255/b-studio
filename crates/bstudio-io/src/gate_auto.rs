//! 게이트의 자동 화면 고르기(옛 TS: `packages/agent/src/gate.ts`의 `VerificationGate.#autoPages`·`#withLatestSampleValues`·`#shadowedByStaticRoute`·`#followImports`·`#dynamicRouteFallback`·
//! `#autoSkipCheck`와 `withoutInRunValues`)(ADR-195 4f A5c-2).
//!
//! **막는 규칙을 품은 코드다.** 실행 중에 에이전트가 알려 준 sample 값을 받아들이는 것은 **여는 쪽**이다. 모르면 받아들이지 않는다.
//! 세 장치(ADR-159 결정 11)를 하나도 빼지 않는다: ① 값이 다른 고정 경로와 겹치는지 보는 **가림 확인**(끝까지 확인하지 못하면 "가림 있음"), ② 실행 중 값 때문에 목록에서 빠진 화면을
//! 시작 때의 값으로 되살리는 `kept`, ③ 실행 중 값으로 채운 동적 경로는 선언한 pageChecks와 겹쳐도 건너뛰지 않는 **겹침 예외**. 건너뛴 화면·읽지 못한 것·상한은 조용히 사라지지 않고
//! 건너뜀 check(`ok: true`, `detail`에 사유)로 남는다.
//!
//! 호출 자리별로 막는 쪽/여는 쪽(함수 이름 옆의 표시):
//! - `safe_segment`: 키·값 모두에 쓴다. **여는 쪽**(맞으면 받아들인다)이라 정확히 JS `/^[A-Za-z0-9_-]{1,64}$/`만 맞춘다(ASCII만, 개행·전각 글자·유니코드 숫자·짝 없는 서로게이트의 인코딩은 거절).
//! - `with_latest`의 관리형 서비스 확인·`dynamicRouteProbe === false` 확인: **여는 쪽**의 조건. 하나라도 어긋나면 받지 않는다.
//! - `shadowed_by_static_route`: **막는 쪽**. 겹침이 있거나 끝까지 확인하지 못하면(`unknown`·`unreadable`) 그 값을 되돌린다.
//! - `without_in_run_values`: 막는 쪽의 결과를 적용한다. 되돌린 값은 시작 때의 값이다.
//! - `dynamic_route_fallback`: 열 값을 **정하는** 쪽이다. 받지 못한 값(출처 밖·HTTP 오류·값 없음·안전하지 않은 값·예외)은 모두 기본값이다(옛 코드가 삼키는 자리, 이 확인은 값을 하나라도 넣어 보려는 것이라
//!   실패를 게이트 실패로 만들지 않는다). 다만 콜백이 응답하지 않거나 알아볼 수 없는 모양이면 `Fail::Hook`이다.
//! - `follow_imports`: 열 화면을 **늘리는** 쪽이다. 그래프를 읽지 못하면 바뀐 page만으로 계속하고 그 사실을 건너뜀 check로 남긴다(옛 코드와 같다).
//! - 겹침 예외(`uses_in_run_value`): 막지 않는 쪽으로의 예외다 — 값을 골라 선언한 확인과 겹치게 만들어도 더 엄격한 자동 확인이 열린다.
//!
//! 콜백(TS가 하는 바깥 동작)의 응답이 알아볼 수 없는 모양이면 통과가 아니라 `Fail::Hook`이다. 새로 삼키는 자리를 만들지 않는다. 삼키는 자리는 옛 코드와 같은 둘뿐이다:
//! `#dynamicRouteFallback`의 모든 예외와 `#followImports`의 그래프 읽기 실패(바뀐 page만으로 계속).
//!
//! 문자열: TS가 `encodeLoneSurrogates`한 글자를 그대로 주고받는다. 옛 코드가 napi 경계(`routesFrom*`·`tracePages`·`accepted_notes`·`sampled_values`·`autoPageCheck`)를 거치던 값은 `lossy_str`로
//! 같은 꼴(짝 없는 서로게이트는 U+FFFD)로 만들고 그 출력은 `enc`로 다시 인코딩한다. 객체의 키는 경계에서 인코딩되지 않으므로 키가 중요한 값(sampleParams)은 `[키, 값]` 쌍 목록으로 주고받는다.
//!
//! 의도한 차이(옛 코드와 다르게 한 것):
//! - `sampleIdFrom`의 `service`·`path`·`jsonPath`가 글자가 아니면 알아볼 수 없는 응답(`Fail::Hook`)이다(옛 코드는 형 변환으로 견줬다). 스키마가 글자를 보장한다.
//! - 응답 JSON이 `js_json`이 읽는 깊이를 넘으면 api 값을 읽지 못한 것으로 보고 기본값이다(JS는 읽는다).

use std::collections::HashSet;

use bstudio_guard::gate_helpers::{self, PathValue};
use bstudio_guard::import_graph;
use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsObject, JsValue};
use bstudio_guard::next_routes::{self as nr, RouteCandidate};
use bstudio_guard::review_input::template;

use crate::gate_declared::{enc, enc_value, lossy, lossy_str, request_op, response_of, text_field, AutoEntry, Stop};
use crate::verify_io::{call, call_done, req, s, string_list, Answer, Fail, Hook, Res};

/// 자동 화면 고르기의 결과. `names`는 이름 짓기 전의 이름이다
pub(crate) struct AutoPlan {
    pub entries: Vec<AutoEntry>,
    pub names: Vec<String>,
    pub skipped: Vec<JsValue>,
}

impl AutoPlan {
    fn empty() -> Self {
        AutoPlan { entries: Vec::new(), names: Vec::new(), skipped: Vec::new() }
    }
}

// ── 입력 ─────────────────────────────────────────────────────────────────

/// TS 상수 사본: spec의 `AUTO_PAGE_DEFAULT`·`AUTO_PAGE_MAX`, `DEFAULT_DYNAMIC_ROUTE_FALLBACK`, `DEFAULT_TRACE_DEPTH`. 한 곳(TS)에서 읽어 온다
struct Constants {
    max_pages_default: f64,
    max_pages_cap: f64,
    default_fallback: String,
    trace_depth: f64,
    spec_file: String,
}

#[derive(Clone)]
struct SampleFrom {
    service: String,
    path: String,
    json_path: String,
    /// `JSON.stringify(sampleIdFrom)` — 옛 코드는 이 글자로 바뀌었는지 견준다(키 순서까지 본다)
    text: String,
}

/// `AutoPageChecks` 가운데 고르기가 읽는 값. 시작 때의 값 위에 실행 중 값 둘(`sampleParams`·`sampleIdFrom`)만 덮을 수 있다
#[derive(Clone)]
struct Config {
    service: String,
    mode: Option<JsValue>,
    expect_status: Option<JsValue>,
    viewport: Option<JsValue>,
    max_pages: f64,
    /// 키는 TS가 인코딩한 글자 그대로다. 옛 JS 객체와 같게 넣은 순서를 지키고, 읽을 때 `entries_js_order`로 정수 키를 앞세운다
    sample_params: Option<JsObject>,
    sample_id_from: Option<SampleFrom>,
    /// `dynamicRouteProbe === false`
    probe_off: bool,
    /// `followImports === false`
    follow_off: bool,
}

fn parse_sample_from(value: &JsValue) -> Res<SampleFrom> {
    if !matches!(value, JsValue::Obj(_)) {
        return Err(Fail::Hook);
    }
    Ok(SampleFrom { service: text_field(value, "service")?, path: text_field(value, "path")?, json_path: text_field(value, "jsonPath")?, text: js_json::stringify(value) })
}

/// `[[키, 값], …]`(`Object.entries` 순서)를 객체로 읽는다. 없거나 null이면 `None`
fn parse_entries(value: Option<&JsValue>) -> Res<Option<JsObject>> {
    match value {
        None | Some(JsValue::Null) => Ok(None),
        Some(JsValue::Arr(items)) => {
            let mut object = JsObject::new();
            for item in items {
                let JsValue::Arr(pair) = item else { return Err(Fail::Hook) };
                let (Some(JsValue::Str(key)), Some(value), 2) = (pair.first(), pair.get(1), pair.len()) else { return Err(Fail::Hook) };
                object.set(key, value.clone());
            }
            Ok(Some(object))
        }
        Some(_) => Err(Fail::Hook),
    }
}

fn parse_config(value: &JsValue, constants: &Constants) -> Res<Config> {
    let max_pages = match value.prop("maxPages") {
        Some(JsValue::Num(n)) => *n,
        None | Some(JsValue::Null) => constants.max_pages_default,
        Some(_) => return Err(Fail::Hook),
    };
    let sample_id_from = match value.prop("sampleIdFrom") {
        None | Some(JsValue::Null) => None,
        Some(from) => Some(parse_sample_from(from)?),
    };
    Ok(Config {
        service: text_field(value, "service")?,
        mode: value.prop("mode").cloned(),
        expect_status: value.prop("expectStatus").cloned(),
        viewport: value.prop("viewport").cloned(),
        max_pages,
        sample_params: parse_entries(value.prop("sampleParams"))?,
        sample_id_from,
        probe_off: matches!(value.prop("dynamicRouteProbe"), Some(JsValue::Bool(false))),
        follow_off: matches!(value.prop("followImports"), Some(JsValue::Bool(false))),
    })
}

/// 옛 `SAFE_SEGMENT`: `/^[A-Za-z0-9_-]{1,64}$/`. 여는 쪽의 조건이라 ASCII 글자만 맞춘다
pub(crate) fn safe_segment(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty() && bytes.len() <= 64 && bytes.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

// ── 경로 ─────────────────────────────────────────────────────────────────

/// 열 경로 하나. 글자는 모두 경계의 꼴(`enc`)이다. 크레이트 함수에 넘길 때는 `lossy_str`로 옛 napi 경계의 꼴로 만든다
#[derive(Clone)]
struct Route {
    path: String,
    file: String,
    used_fallback: Vec<String>,
    cause: Option<String>,
}

struct Found {
    routes: Vec<Route>,
    skipped: Vec<(String, String)>,
}

fn found_from(routes: nr::NextRoutes) -> Found {
    Found {
        routes: routes
            .routes
            .into_iter()
            .map(|route| Route { path: enc(&route.path), file: enc(&route.file), used_fallback: route.used_fallback_params.iter().map(|name| enc(name)).collect(), cause: route.cause.map(|cause| enc(&cause)) })
            .collect(),
        skipped: routes.skipped.into_iter().map(|entry| (enc(&entry.file), enc(&entry.reason))).collect(),
    }
}

/// 크레이트 함수(napi 경계를 거치던 것)에 넘기는 sampleParams: 키·값 모두 옛 경계의 꼴이다
fn lossy_params(params: &Option<JsObject>) -> JsObject {
    let mut out = JsObject::new();
    if let Some(params) = params {
        for (key, value) in params.entries_js_order() {
            out.set(&lossy_str(key), lossy(value));
        }
    }
    out
}

/// `Object.entries(sampleParams ?? {})` 가운데 글자 값만(알아볼 수 없는 값은 `Fail::Hook`). 옛 경계의 꼴로 만든다
fn lossy_pairs(params: &Option<JsObject>) -> Res<Vec<(String, String)>> {
    let mut out = Vec::new();
    if let Some(params) = params {
        for (key, value) in params.entries_js_order() {
            let Some(text) = value.as_str() else { return Err(Fail::Hook) };
            out.push((lossy_str(key), lossy_str(text)));
        }
    }
    Ok(out)
}

/// 옛 `dynamicNames(route.file)`: `[이름]` 세그먼트의 이름(경계의 꼴)
fn dynamic_names(file_wire: &str) -> Vec<String> {
    let segments: Vec<&str> = file_wire.split('/').collect();
    gate_helpers::dynamic_segments(&lossy_str(file_wire)).into_iter().filter_map(|index| segments.get(index)).map(|segment| segment[1..segment.len() - 1].to_owned()).collect()
}

struct Routing<'a> {
    followed: &'a Option<Followed>,
    changed: &'a [String],
    service_path: &'a str,
    constants: &'a Constants,
}

impl Routing<'_> {
    /// 옛 `build(config, fallback)`
    fn build(&self, config: &Config, fallback: Option<&str>) -> Found {
        let params = lossy_params(&config.sample_params);
        let fallback = fallback.map(lossy_str);
        let service_path = lossy_str(self.service_path);
        let routes = match self.followed {
            Some(followed) => nr::routes_from_candidates(&followed.candidates, &service_path, &params, config.max_pages, self.constants.max_pages_cap, fallback.as_deref()),
            None => {
                let files: Vec<String> = self.changed.iter().map(|file| lossy_str(file)).collect();
                nr::routes_from_changed_files(&files, &service_path, &params, config.max_pages, self.constants.max_pages_cap, fallback.as_deref())
            }
        };
        found_from(routes)
    }
}

// ── 건너뜀 check ─────────────────────────────────────────────────────────

/// 옛 `#autoSkipCheck`. `ok`로 두어 게이트를 막지 않되, 이유는 `detail`에 남긴다
fn skip_check(service: &str, file: &str, reason: &str) -> JsValue {
    js_json::object(vec![
        ("stage", Some(s("browser_check"))),
        ("name", Some(s(format!("{service} {file} (자동, 건너뜀)")))),
        ("ok", Some(JsValue::Bool(true))),
        ("attempts", Some(JsValue::Num(1.0))),
        ("detail", Some(s(reason))),
    ])
}

// ── 실행 중 sample 값 ────────────────────────────────────────────────────

/// 옛 `LatestSampleValues`
#[derive(Clone)]
struct Latest {
    config: Config,
    notes: Vec<String>,
    /// 이번 실행 중에 새로 받아들인 sampleParams의 키(받아들인 순서)
    in_run_keys: Vec<String>,
    /// 이번 실행 중에 새 sampleIdFrom을 받아들였는지(추정 id가 그 값에서 온다)
    in_run_sample_id_from: bool,
}

impl Latest {
    fn unchanged(started: &Config) -> Self {
        Latest { config: started.clone(), notes: Vec::new(), in_run_keys: Vec::new(), in_run_sample_id_from: false }
    }
}

/// 옛 `#withLatestSampleValues`. 실행 중에 바뀐 studio.yaml에서 sampleParams·sampleIdFrom만 받아들여 시작 때의 설정 위에 덮는다. 읽는 일(일반 파일 확인·다시 읽기·오류 구별과 가림)은 콜백이다
async fn with_latest(hook: &Hook, started: &Config, managed: &[(String, String)], constants: &Constants) -> Res<Latest> {
    let spec = &constants.spec_file;
    let answer = call_done(hook, req("autoLatest", vec![])).await?;
    let mut unchanged = Latest::unchanged(started);
    let state = answer.prop("state").and_then(JsValue::as_str).ok_or(Fail::Hook)?;
    let latest = match state {
        "unchanged" => return Ok(unchanged),
        "irregular" => {
            let reason = text_field(&answer, "reason")?;
            unchanged.notes = vec![format!("{spec}을(를) 일반 파일로 읽을 수 없어({reason}) 이번 검증은 실행을 시작할 때의 autoPageChecks로 진행했습니다")];
            return Ok(unchanged);
        }
        "failed" => {
            let detail = text_field(&answer, "detail")?;
            unchanged.notes = vec![format!("{spec}의 새 값을 읽지 못해 이번 검증은 실행을 시작할 때의 autoPageChecks로 진행했습니다(sampleParams·sampleIdFrom 변경 미반영){detail}")];
            return Ok(unchanged);
        }
        "loaded" => match answer.prop("latest") {
            None | Some(JsValue::Null) => return Ok(unchanged),
            Some(latest) => latest.clone(),
        },
        _ => return Err(Fail::Hook),
    };
    let latest_params = parse_entries(latest.prop("sampleParams"))?;
    let latest_from = match latest.prop("sampleIdFrom") {
        None | Some(JsValue::Null) => None,
        Some(from) => Some(parse_sample_from(from)?),
    };

    let mut notes: Vec<String> = Vec::new();
    let mut config = started.clone();
    let mut in_run_keys: Vec<String> = Vec::new();
    let mut in_run_sample_id_from = false;
    // 시작 때와 다른 값만(`started.sampleParams?.[key] !== value`)
    let changed: Vec<(&str, &JsValue)> = latest_params
        .as_ref()
        .map(|params| params.entries_js_order())
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, value)| !started.sample_params.as_ref().and_then(|params| params.get(key)).is_some_and(|before| before.strict_equals(value)))
        .collect();
    // 스키마가 이미 같은 제한을 걸지만, 경로 조각으로 쓰이는 값이라 여기서도 안전한 문자만 받는다(다른 문자는 경로를 바꿔 다른 화면을 열게 한다)
    let is_added = |key: &str, value: &JsValue| safe_segment(key) && value.as_str().is_some_and(safe_segment);
    let added: Vec<(&str, &JsValue)> = changed.iter().copied().filter(|(key, value)| is_added(key, value)).collect();
    let rejected: Vec<&str> = changed.iter().copied().filter(|(key, value)| !is_added(key, value)).map(|(key, _)| key).collect();
    if !rejected.is_empty() {
        notes.push(format!("{spec}의 autoPageChecks.sampleParams 중 {}은(는) 경로 조각으로 쓸 수 없는 값이라 반영하지 않았습니다(영문·숫자·_·-만)", rejected.join(", ")));
    }
    if !added.is_empty() {
        for (key, _) in &added {
            if !in_run_keys.iter().any(|existing| existing == key) {
                in_run_keys.push((*key).to_owned());
            }
        }
        let mut merged = started.sample_params.clone().unwrap_or_default();
        for (key, value) in &added {
            merged.set(key, (*value).clone());
        }
        config.sample_params = Some(merged);
    }
    if let Some(from) = latest_from {
        if started.sample_id_from.as_ref().map(|before| &before.text) != Some(&from.text) {
            // 세션의 관리형 서비스만 부른다(load.ts의 pageChecks.expectFromApi와 같은 규칙). 시작 때 추정을 껐으면 id 추정 자체가 없어 쓰이지 않는다
            if !managed.iter().any(|(name, _)| *name == from.service) {
                notes.push(format!("{spec}의 autoPageChecks.sampleIdFrom.service '{}'은(는) 이 프로젝트의 관리형 서비스가 아니라 반영하지 않았습니다", from.service));
            } else if started.probe_off {
                notes.push("autoPageChecks.dynamicRouteProbe가 실행을 시작할 때 꺼져 있어 sampleIdFrom은 반영하지 않았습니다(sampleParams는 반영됩니다)".to_owned());
            } else {
                config.sample_id_from = Some(from);
                in_run_sample_id_from = true;
            }
        }
    }
    Ok(Latest { config, notes, in_run_keys, in_run_sample_id_from })
}

// ── 고정 경로 가림 확인 ──────────────────────────────────────────────────

/// 옛 `ShadowedValue`: 실행 중에 받아들였다가 고정 경로와 겹쳐 되돌리는 값
struct Shadowed {
    name: String,
    value: String,
    via_sample_id_from: bool,
    reason: String,
}

/// 옛 `#shadowedByStaticRoute`(막는 쪽). `fallback_value`는 지금 쓰는 추정 id. 끝까지 확인하지 못하면 그 값은 받아들이지 않는다
async fn shadowed_by_static_route(hook: &Hook, routes: &[Route], service_path: &str, latest: &Latest, fallback_value: Option<&str>) -> Res<Vec<Shadowed>> {
    // `Map` 그대로: 같은 열쇠는 값만 바꾸고 자리를 지킨다
    let mut found: Vec<(String, Shadowed)> = Vec::new();
    let mut put = |key: String, entry: Shadowed| match found.iter_mut().find(|(existing, _)| *existing == key) {
        Some(slot) => slot.1 = entry,
        None => found.push((key, entry)),
    };
    for route in routes {
        let names = dynamic_names(&route.file);
        let via_fallback: Vec<&String> = if latest.in_run_sample_id_from { route.used_fallback.iter().collect() } else { Vec::new() };
        let mut check: Vec<String> = Vec::new();
        for name in &names {
            if (latest.in_run_keys.contains(name) || via_fallback.contains(&name)) && !check.contains(name) {
                check.push(name.clone());
            }
        }
        if check.is_empty() {
            continue;
        }
        // 이름 → 채운 값(같은 이름이 둘이면 뒤의 값이 앞을 덮는다)
        let mut values: Vec<(String, String)> = Vec::new();
        for name in &names {
            let value = if route.used_fallback.contains(name) {
                fallback_value.map(str::to_owned)
            } else {
                match latest.config.sample_params.as_ref().and_then(|params| params.get(name)) {
                    None => None,
                    Some(JsValue::Str(text)) => Some(text.clone()),
                    Some(_) => return Err(Fail::Hook),
                }
            };
            if let Some(value) = value {
                match values.iter_mut().find(|(existing, _)| existing == name) {
                    Some(slot) => slot.1 = value,
                    None => values.push((name.clone(), value)),
                }
            }
        }
        let value_of = |name: &str| values.iter().find(|(existing, _)| existing == name).map(|(_, value)| value.clone()).unwrap_or_default();
        let request = req(
            "autoShadows",
            vec![
                ("servicePath", s(service_path)),
                ("pageFile", s(route.file.clone())),
                ("values", JsValue::Arr(values.iter().map(|(name, value)| JsValue::Arr(vec![s(name.clone()), s(value.clone())])).collect())),
                ("check", JsValue::Arr(check.iter().map(|name| s(name.clone())).collect())),
            ],
        );
        let answer = call_done(hook, request).await?;
        let mut reject = |name: &str, reason: String| {
            let via = via_fallback.iter().any(|candidate| candidate.as_str() == name);
            put(if via { "sampleIdFrom".to_owned() } else { name.to_owned() }, Shadowed { name: name.to_owned(), value: value_of(name), via_sample_id_from: via, reason });
        };
        if let Some(JsValue::Arr(shadows)) = answer.prop("shadows") {
            for shadow in shadows {
                let name = text_field(shadow, "name")?;
                let place = text_field(shadow, "where")?;
                reject(&name, format!("같은 주소를 고정 경로({place})가 먼저 받아 그 화면이 대신 열립니다"));
            }
        } else {
            // 끝까지 확인하지 못했다: 가림이 있는 것으로 본다
            let why = if answer.prop("unknown").is_some() { text_field(&answer, "unknown")? } else if matches!(answer.prop("unreadable"), Some(JsValue::Bool(true))) { "폴더를 읽지 못했습니다".to_owned() } else { return Err(Fail::Hook) };
            for name in &check {
                reject(name, format!("같은 주소를 먼저 받는 고정 경로가 있는지 확인하지 못했습니다({why})"));
            }
        }
    }
    Ok(found.into_iter().map(|(_, entry)| entry).collect())
}

/// 옛 `withoutInRunValues`: 고정 경로와 겹친 값을 시작 때의 값으로 되돌린다(시작 때 없던 키는 지운다)
fn without_in_run_values(latest: &Latest, started: &Config, shadowed: &[Shadowed], spec: &str) -> Latest {
    let mut config = latest.config.clone();
    let mut sample_params = config.sample_params.clone().unwrap_or_default();
    let mut in_run_keys = latest.in_run_keys.clone();
    let mut in_run_sample_id_from = latest.in_run_sample_id_from;
    let mut notes = latest.notes.clone();
    for entry in shadowed {
        if entry.via_sample_id_from {
            in_run_sample_id_from = false;
            config.sample_id_from = started.sample_id_from.clone();
            notes.push(format!("{spec}의 autoPageChecks.sampleIdFrom으로 얻은 값({})은 반영하지 않았습니다 — {}", entry.value, entry.reason));
            continue;
        }
        in_run_keys.retain(|key| *key != entry.name);
        match started.sample_params.as_ref().and_then(|params| params.get(&entry.name)) {
            None => sample_params.remove(&entry.name),
            Some(before) => sample_params.set(&entry.name, before.clone()),
        }
        notes.push(format!("{spec}의 autoPageChecks.sampleParams.{}={}은(는) 반영하지 않았습니다 — {}. 그 동적 화면이 실제로 받는 값을 적으세요", entry.name, entry.value, entry.reason));
    }
    config.sample_params = if sample_params.entries().is_empty() { None } else { Some(sample_params) };
    Latest { config, notes, in_run_keys, in_run_sample_id_from }
}

// ── import 따라가기 ──────────────────────────────────────────────────────

/// 옛 `#followImports`의 결과. 후보는 크레이트 함수에 넘길 꼴(옛 경계의 꼴)이다
struct Followed {
    candidates: Vec<RouteCandidate>,
    /// `(file, reason)`: 경계의 꼴
    notes: Vec<(String, String)>,
}

fn candidate(page: String, cause: String, distance: f64, tie: f64) -> RouteCandidate {
    RouteCandidate { page, cause, distance, tie }
}

fn number_field(value: &JsValue, key: &str) -> Res<f64> {
    match value.prop(key) {
        Some(JsValue::Num(n)) => Ok(*n),
        _ => Err(Fail::Hook),
    }
}

/// 옛 `#followImports`. 바뀐 소스 파일을 쓰는 page를 찾는다. 그래프를 읽는 일(`collectImportGraph`)은 콜백이다
async fn follow_imports(hook: &Hook, changed_files: &[String], service_path: &str, constants: &Constants) -> Res<Option<Followed>> {
    let normalized = service_path.replace('\\', "/");
    let prefix = normalized.strip_prefix("./").unwrap_or(&normalized).trim_end_matches('/').to_owned();
    let bare = prefix.is_empty() || prefix == ".";
    let in_service = |file: &str| -> Option<String> {
        if bare {
            Some(file.to_owned())
        } else {
            file.strip_prefix(&format!("{prefix}/")).map(str::to_owned)
        }
    };
    let changed: Vec<String> = changed_files.iter().filter_map(|file| in_service(file)).filter(|file| import_graph::is_graph_source_file(&lossy_str(file))).collect();
    if changed.is_empty() {
        return Ok(None);
    }
    // 바뀐 소스가 전부 page 파일이면 import를 따라갈 이유가 없다 — 읽기 없이 예전 경로로 간다
    let is_page = |file: &String| import_graph::is_page_file_in_service(&lossy_str(file));
    if changed.iter().all(is_page) {
        return Ok(None);
    }
    let to_project = |file: &str| if bare { enc(file) } else { format!("{prefix}/{}", enc(file)) };
    let graph = match call(hook, req("autoImportGraph", vec![("servicePath", s(service_path))])).await? {
        Answer::Done(graph) => graph,
        Answer::Failed { message, .. } => {
            // 그래프를 만들지 못해도 바뀐 page 파일 확인은 계속한다. 다만 못 찾았다는 사실을 남긴다
            let own_pages = changed.iter().filter(|file| is_page(file)).map(|page| candidate(lossy_str(page), lossy_str(page), 0.0, 0.0)).collect();
            return Ok(Some(Followed { candidates: own_pages, notes: vec![("import 역추적".to_owned(), format!("import 역추적에 실패해 바뀐 파일을 쓰는 페이지를 찾지 못했습니다: {message}"))] }));
        }
    };
    let files: Vec<String> = string_list(graph.prop("files"))?.iter().map(|file| lossy_str(file)).collect();
    let mut reverse: import_graph::ReverseGraph = Vec::new();
    let Some(JsValue::Arr(rows)) = graph.prop("reverse") else { return Err(Fail::Hook) };
    for row in rows {
        let JsValue::Arr(pair) = row else { return Err(Fail::Hook) };
        let (Some(JsValue::Str(target)), Some(importers), 2) = (pair.first(), pair.get(1), pair.len()) else { return Err(Fail::Hook) };
        reverse.push((lossy_str(target), string_list(Some(importers))?.iter().map(|file| lossy_str(file)).collect()));
    }
    let incomplete = match graph.prop("incomplete") {
        None | Some(JsValue::Null) => None,
        Some(JsValue::Str(text)) if !text.is_empty() => Some(text.clone()),
        Some(JsValue::Str(_)) => None,
        Some(_) => return Err(Fail::Hook),
    };
    let read_count = number_field(&graph, "readCount")?;
    let elapsed_ms = number_field(&graph, "elapsedMs")?;
    let changed_lossy: Vec<String> = changed.iter().map(|file| lossy_str(file)).collect();
    let trace = import_graph::trace_pages(&changed_lossy, &reverse, &files, constants.trace_depth);
    let mut notes: Vec<(String, String)> = Vec::new();
    if let Some(incomplete) = incomplete {
        notes.push((
            "import 역추적".to_owned(),
            format!("{incomplete}(읽은 파일 {}개, {}ms) — 그래프가 일부만 만들어져 바뀐 파일을 쓰는 페이지를 모두 찾지 못했을 수 있습니다", js::number_to_string(read_count), js::number_to_string(elapsed_ms)),
        ));
    }
    for entry in &trace.truncated {
        notes.push((
            to_project(&entry.cause),
            format!("{}에서 import를 거꾸로 {}단계까지 따라갔고, {}를 쓰는 파일이 더 있지만 깊이 상한이라 멈췄습니다", to_project(&entry.cause), js::number_to_string(constants.trace_depth), to_project(&entry.stopped_at)),
        ));
    }
    let candidates = trace.candidates.into_iter().map(|c| candidate(c.page, c.cause, f64::from(c.distance), f64::from(c.tie))).collect();
    Ok(Some(Followed { candidates, notes }))
}

// ── 동적 경로의 기본값 ───────────────────────────────────────────────────

/// 콜백의 실패 응답(`Stop::Message`)은 기본값으로 물러나는 쪽이고, 응답을 알아볼 수 없는 것(`Stop::Fail`)은 오류다
fn swallowed<T>(stop: Stop) -> Res<Option<T>> {
    match stop {
        Stop::Fail(fail) => Err(fail),
        Stop::Message(_) => Ok(None),
    }
}

/// `sampleIdFrom`이 가리키는 api에서 값을 꺼낸다. 받지 못하면 `None`(호출한 쪽이 기본값으로 물러난다)
async fn sample_id_from_api(hook: &Hook, from: &SampleFrom) -> Res<Option<String>> {
    let base = match request_op(hook, req("declaredEndpoint", vec![("service", s(from.service.clone()))])).await {
        Ok(value) => text_field(&value, "url")?,
        Err(stop) => return swallowed(stop),
    };
    let resolved = match request_op(hook, req("declaredResolveUrl", vec![("base", s(base)), ("path", s(from.path.clone()))])).await {
        Ok(value) => value,
        Err(stop) => return swallowed(stop),
    };
    let href = text_field(&resolved, "href")?;
    if !matches!(resolved.prop("sameOrigin"), Some(JsValue::Bool(true))) {
        return Ok(None);
    }
    let (status, text) = match request_op(hook, req("declaredPageFetch", vec![("href", s(href))])).await.and_then(|value| response_of(&value)) {
        Ok(response) => response,
        Err(stop) => return swallowed(stop),
    };
    if !(200.0..300.0).contains(&status) {
        return Ok(None);
    }
    let candidate = match gate_helpers::read_json_path(&text, &from.json_path) {
        Ok(PathValue::Value(JsValue::Str(value))) => value,
        Ok(PathValue::Value(JsValue::Num(value))) => js::number_to_string(value),
        // 값 없음·객체·배열·불리언·null, JSON이 읽을 수 있는 깊이를 넘음: 받지 못한 것이다
        _ => return Ok(None),
    };
    Ok(safe_segment(&candidate).then_some(candidate))
}

/// 옛 `#dynamicRouteFallback`. 끔이면 `None`, `sampleIdFrom`이 없거나 받지 못하면 기본값
async fn dynamic_route_fallback(hook: &Hook, config: &Config, constants: &Constants) -> Res<Option<String>> {
    if config.probe_off {
        return Ok(None);
    }
    let Some(from) = &config.sample_id_from else { return Ok(Some(constants.default_fallback.clone())) };
    Ok(Some(sample_id_from_api(hook, from).await?.unwrap_or_else(|| constants.default_fallback.clone())))
}

// ── 본체 ─────────────────────────────────────────────────────────────────

fn constants_of(auto: &JsValue) -> Res<Constants> {
    Ok(Constants {
        max_pages_default: number_field(auto, "maxPagesDefault")?,
        max_pages_cap: number_field(auto, "maxPagesCap")?,
        default_fallback: text_field(auto, "defaultFallback")?,
        trace_depth: number_field(auto, "traceDepth")?,
        spec_file: text_field(auto, "specFile")?,
    })
}

/// 옛 `#autoPages`. `begin`은 `declaredBegin`의 응답이다(`auto`: 설정이 없으면 null)
pub(crate) async fn auto_pages(hook: &Hook, begin: &JsValue) -> Res<AutoPlan> {
    let auto = match begin.prop("auto") {
        Some(JsValue::Null) => return Ok(AutoPlan::empty()),
        Some(auto @ JsValue::Obj(_)) => auto,
        _ => return Err(Fail::Hook),
    };
    let constants = constants_of(auto)?;
    let started = parse_config(auto.prop("config").ok_or(Fail::Hook)?, &constants)?;
    let managed: Vec<(String, String)> = match auto.prop("managed") {
        Some(JsValue::Arr(items)) => items.iter().map(|item| Ok((text_field(item, "name")?, text_field(item, "path")?))).collect::<Res<Vec<_>>>()?,
        _ => return Err(Fail::Hook),
    };
    let declared_keys: HashSet<String> = match begin.prop("pages") {
        Some(JsValue::Arr(items)) => items.iter().map(|page| format!("{} {}", template(page.prop("service")), template(page.prop("path")))).collect(),
        _ => return Err(Fail::Hook),
    };
    let spec = constants.spec_file.clone();
    let Some((_, service_path)) = managed.iter().find(|(name, _)| *name == started.service) else {
        // 불러올 때 막지만(load.ts), 여기서도 조용히 넘어가지 않고 이유를 남긴다
        let reason = format!("autoPageChecks.service '{}'를 이 프로젝트의 관리형 서비스에서 찾지 못했습니다", started.service);
        return Ok(AutoPlan { entries: Vec::new(), names: Vec::new(), skipped: vec![skip_check(&started.service, &started.service, &reason)] });
    };
    let service_path = service_path.clone();
    let changed_files = string_list(call_done(hook, req("autoChangedFiles", vec![])).await?.prop("files"))?;

    // 실행 중에 에이전트가 알려 준 sample 값만 받아들인다. 나머지 설정은 시작 때의 것이다(ADR-159)
    let mut refreshed = with_latest(hook, &started, &managed, &constants).await?;
    let followed = if started.follow_off { None } else { follow_imports(hook, &changed_files, &service_path, &constants).await? };
    let routing = Routing { followed: &followed, changed: &changed_files, service_path: &service_path, constants: &constants };
    let mut fallback_value = dynamic_route_fallback(hook, &refreshed.config, &constants).await?;
    let mut found = routing.build(&refreshed.config, fallback_value.as_deref());
    // 시작 때의 값이었다면 열었을 화면인데 실행 중 값 때문에 목록에서 빠진 것. 시작 때의 값 그대로 되살려 연다(`kept`: 되살린 화면의 번호 → 그때 쓴 추정 id)
    let mut kept: Vec<(usize, Option<String>)> = Vec::new();
    if !refreshed.in_run_keys.is_empty() || refreshed.in_run_sample_id_from {
        // 값은 "어떤 id로 여는가"만 정해야 한다. 값이 "무엇을 여는가"를 바꾸는 두 경우를 막는다(ADR-159 결정 11)
        let started_fallback = if refreshed.in_run_sample_id_from { dynamic_route_fallback(hook, &started, &constants).await? } else { fallback_value.clone() };
        // ① 값을 채운 주소를 다른 고정 경로(app·pages 폴더, public 파일)가 먼저 받으면 그 화면이 대신 열린다 — 바뀐 동적 화면은 열리지 않는다
        let shadowed = shadowed_by_static_route(hook, &found.routes, &service_path, &refreshed, fallback_value.as_deref()).await?;
        if !shadowed.is_empty() {
            refreshed = without_in_run_values(&refreshed, &started, &shadowed, &spec);
            if !refreshed.in_run_sample_id_from {
                fallback_value = started_fallback.clone();
            }
            found = routing.build(&refreshed.config, fallback_value.as_deref());
        }
        // ② 값이 바뀌면 경로 이름순이 바뀌어 다른 화면이 maxPages 밖으로 밀리거나, 두 파일이 같은 경로가 돼 하나가 빠질 수 있다
        let have: HashSet<&str> = found.routes.iter().map(|route| route.file.as_str()).collect();
        let dropped: Vec<Route> = routing.build(&started, started_fallback.as_deref()).routes.into_iter().filter(|route| !have.contains(route.file.as_str())).collect();
        if !dropped.is_empty() {
            let files: HashSet<String> = dropped.iter().map(|route| route.file.clone()).collect();
            let base = found.routes.len();
            for index in 0..dropped.len() {
                kept.push((base + index, started_fallback.clone()));
            }
            found.routes.extend(dropped);
            found.skipped.retain(|(file, _)| !files.contains(file));
        }
    }
    let config = &refreshed.config;
    let mut skipped: Vec<JsValue> = Vec::new();
    let pairs = lossy_pairs(&config.sample_params)?;
    let from_lossy: Option<(String, String)> = config.sample_id_from.as_ref().map(|from| (lossy_str(&from.service), lossy_str(&from.path)));
    let accepted = gate_helpers::accepted_notes(
        &spec,
        &refreshed.in_run_keys.iter().map(|key| lossy_str(key)).collect::<Vec<_>>(),
        &pairs,
        refreshed.in_run_sample_id_from,
        from_lossy.as_ref().map(|(service, path)| (service.as_str(), path.as_str())),
    );
    for note in refreshed.notes.iter().cloned().chain(accepted.iter().map(|note| enc(note))) {
        skipped.push(skip_check(&config.service, &spec, &note));
    }
    for (file, reason) in followed.iter().flat_map(|followed| followed.notes.iter()) {
        skipped.push(skip_check(&config.service, file, reason));
    }
    for (file, reason) in &found.skipped {
        skipped.push(skip_check(&config.service, file, reason));
    }

    let mut entries: Vec<AutoEntry> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let started_pairs = lossy_pairs(&started.sample_params)?;
    for (index, route) in found.routes.iter().enumerate() {
        // 선언한 pageChecks와 같은 경로는 두 번 열지 않는다. 단, 실행 중에 받아들인 값으로 채운 동적 경로는 건너뛰지 않는다: 에이전트가
        // 값을 골라 경로를 선언된 확인과 겹치게 만들면, 엄격한 자동 확인이 더 느슨할 수 있는 선언된 확인(콘솔 오류 허용 등)으로 바뀐다.
        // 값과 무관한 정적 경로는 지금처럼 건너뛴다
        let kept_value = kept.iter().find(|(kept_index, _)| *kept_index == index).map(|(_, value)| value);
        let from_start = kept_value.is_some();
        let uses_in_run = gate_helpers::uses_in_run_value(&route.file, &refreshed.in_run_keys, refreshed.in_run_sample_id_from, route.used_fallback.len());
        if (from_start || !uses_in_run) && declared_keys.contains(&format!("{} {}", config.service, route.path)) {
            skipped.push(skip_check(&config.service, &route.file, &format!("{}은(는) 이미 선언한 pageChecks에 있어 두 번 열지 않았습니다", route.path)));
            continue;
        }
        // id를 추정해 채운 동적 경로는 이름에 표시하고, 404·500만 실패로 보도록 probedId를 남긴다
        let fallback: Option<&String> = match kept_value {
            Some(value) => value.as_ref(),
            None => fallback_value.as_ref(),
        };
        let probed = !route.used_fallback.is_empty() && fallback.is_some();
        // sampleParams로 알려 준 값으로 연 동적 경로는 추정이 아니므로 엄격하게 판정한다. 실패하면 어느 값으로 열었는지 사유에 붙인다
        let sampled = if probed { None } else { gate_helpers::sampled_values(&lossy_str(&route.file), if from_start { &started_pairs } else { &pairs }).map(|text| enc(&text)) };
        let cause = match &route.cause {
            Some(cause) if !cause.is_empty() => format!(" · {} 변경", cause.rsplit('/').next().unwrap_or(cause)),
            _ => String::new(),
        };
        let name = format!("{} {} (자동{}{cause})", config.service, route.path, if probed { ", id 추정" } else { "" });
        // `autoPageCheck(config, route.path)`: 옛 코드는 napi 경계를 거쳤다
        let base = js_json::object(vec![
            ("service", Some(s(config.service.clone()))),
            ("mode", config.mode.clone()),
            ("expectStatus", config.expect_status.clone()),
            ("viewport", config.viewport.clone()),
        ]);
        let page = enc_value(&gate_helpers::auto_page_check(&lossy(&base), &lossy_str(&route.path)));
        entries.push(AutoEntry { page, probed_id: if probed { fallback.cloned() } else { None }, sampled });
        names.push(name);
    }
    Ok(AutoPlan { entries, names, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn safe_segment는_js_정규식과_같은_글자만_받는다() {
        for ok in ["a", "Z", "0", "_", "-", "abc-DEF_123", &"a".repeat(64)] {
            assert!(safe_segment(ok), "{ok}");
        }
        for bad in ["", &"a".repeat(65), "a b", "a/b", "a.b", "abc\n", "\nabc", "é", "１２", "٣", "😀", "a\u{E010}", "..", "%2e", "a\0"] {
            assert!(!safe_segment(bad), "{bad:?}");
        }
    }

    #[test]
    fn 건너뜀_check는_옛_모양이다() {
        let check = skip_check("web", "app/x/page.tsx", "사유");
        assert_eq!(js_json::stringify(&check), r#"{"stage":"browser_check","name":"web app/x/page.tsx (자동, 건너뜀)","ok":true,"attempts":1,"detail":"사유"}"#);
    }

    #[test]
    fn 동적_이름은_대괄호_세그먼트만_뽑는다() {
        assert_eq!(dynamic_names("web/app/p/[slug]/[id]/page.tsx"), ["slug", "id"]);
        assert_eq!(dynamic_names("web/app/(g)/[...rest]/page.tsx"), ["...rest"]);
    }

    // ── 콜백이 응답하지 않거나 알아볼 수 없으면 통과가 아니라 오류다(차등 시험은 이 자리를 만들 수 없다) ──

    type Reply = Box<dyn Fn(&str, &JsValue) -> Option<String> + Send + Sync>;

    fn scripted(reply: Reply) -> Hook {
        Arc::new(move |request: String| {
            let parsed = js_json::parse_native(&request).expect("요청은 JSON");
            let op = parsed.prop("op").and_then(JsValue::as_str).unwrap_or("").to_owned();
            let answer = reply(&op, &parsed);
            Box::pin(async move { answer })
        })
    }

    fn begin(config: &str) -> JsValue {
        js_json::parse_native(&format!(
            r#"{{"pages":[],"auto":{{"config":{config},"managed":[{{"name":"web","path":"web"}},{{"name":"api","path":"api"}}],"specFile":"studio.yaml","maxPagesDefault":5,"maxPagesCap":10,"defaultFallback":"1","traceDepth":5}}}}"#
        ))
        .expect("begin은 JSON")
    }

    fn run_plan(begin: &JsValue, hook: Hook) -> Res<AutoPlan> {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        runtime.block_on(async { auto_pages(&hook, begin).await })
    }

    const OK: &str = r#"{"ok":true}"#;
    const WEB_CONFIG: &str = r#"{"service":"web","mode":"http","expectStatus":200,"maxPages":5}"#;

    /// 바뀐 파일 하나(`[id]` page)와 실행 중 sampleParams 하나를 정상으로 돌려주는 기본 응답. `extra`가 먼저 답한다
    fn dynamic_reply(extra: Reply) -> Reply {
        Box::new(move |op, request| {
            if let Some(answer) = extra(op, request) {
                return Some(answer);
            }
            Some(match op {
                "autoChangedFiles" => r#"{"ok":true,"files":["web/app/orders/[id]/page.tsx"]}"#.to_owned(),
                "autoLatest" => r#"{"ok":true,"state":"loaded","latest":{"sampleParams":[["id","555"]],"sampleIdFrom":null}}"#.to_owned(),
                "autoShadows" => r#"{"ok":true,"shadows":[]}"#.to_owned(),
                _ => return None,
            })
        })
    }

    fn none_reply() -> Reply {
        Box::new(|_, _| None)
    }

    #[test]
    fn 설정이_없으면_콜백을_부르지_않고_빈_계획이다() {
        let begin = js_json::parse_native(r#"{"pages":[],"auto":null}"#).unwrap();
        let plan = run_plan(&begin, scripted(Box::new(|_, _| panic!("부르면 안 된다")))).ok().unwrap();
        assert!(plan.entries.is_empty() && plan.names.is_empty() && plan.skipped.is_empty());
    }

    #[test]
    fn 정상이면_실행_중_값으로_연다() {
        let plan = run_plan(&begin(WEB_CONFIG), scripted(dynamic_reply(none_reply()))).ok().unwrap();
        assert_eq!(plan.names, ["web /orders/555 (자동)"]);
        assert_eq!(plan.skipped.len(), 1);
    }

    #[test]
    fn 응답이_없으면_모든_자리에서_hook_오류다() {
        for silent in ["autoChangedFiles", "autoLatest", "autoShadows"] {
            // `dynamic_reply`가 그 op에는 답하지 않게 막는다
            let hook = scripted(Box::new(move |op, request| if op == silent { None } else { dynamic_reply(none_reply())(op, request) }));
            assert_eq!(run_plan(&begin(WEB_CONFIG), hook).err(), Some(Fail::Hook), "{silent}");
        }
    }

    #[test]
    fn autolatest가_알아볼_수_없는_상태를_말하면_변경_없음으로_열지_않고_오류다() {
        let extra: Reply = Box::new(|op, _| (op == "autoLatest").then(|| r#"{"ok":true,"state":"maybe"}"#.to_owned()));
        assert_eq!(run_plan(&begin(WEB_CONFIG), scripted(dynamic_reply(extra))).err(), Some(Fail::Hook));
        for bad in [r#"{"ok":true}"#, r#"{"ok":true,"state":"irregular"}"#, r#"{"ok":true,"state":"loaded","latest":{"sampleParams":5}}"#, r#"{"ok":true,"state":"loaded","latest":{"sampleParams":[["id"]]}}"#, r#"{"ok":true,"state":"loaded","latest":{"sampleIdFrom":{"service":"api"}}}"#] {
            let extra: Reply = Box::new(move |op, _| (op == "autoLatest").then(|| bad.to_owned()));
            assert_eq!(run_plan(&begin(WEB_CONFIG), scripted(dynamic_reply(extra))).err(), Some(Fail::Hook), "{bad}");
        }
    }

    #[test]
    fn autoshadows가_알아볼_수_없는_응답이면_받아들이지_않고_오류다() {
        for bad in [r#"{"ok":true}"#, r#"{"ok":true,"unreadable":false}"#, r#"{"ok":true,"shadows":"x"}"#, r#"{"ok":true,"shadows":[{"name":"id"}]}"#] {
            let extra: Reply = Box::new(move |op, _| (op == "autoShadows").then(|| bad.to_owned()));
            assert_eq!(run_plan(&begin(WEB_CONFIG), scripted(dynamic_reply(extra))).err(), Some(Fail::Hook), "{bad}");
        }
    }

    #[test]
    fn 폴더를_읽지_못했거나_끝까지_확인하지_못하면_그_값을_받아들이지_않는다() {
        for (answer, why) in [(r#"{"ok":true,"unreadable":true}"#, "폴더를 읽지 못했습니다"), (r#"{"ok":true,"unknown":"폴더가 너무 많습니다"}"#, "폴더가 너무 많습니다")] {
            let extra: Reply = Box::new(move |op, _| (op == "autoShadows").then(|| answer.to_owned()));
            let plan = run_plan(&begin(WEB_CONFIG), scripted(dynamic_reply(extra))).ok().unwrap();
            // 받지 않고 시작 때의 값(기본값 1)으로 연다
            assert_eq!(plan.names, ["web /orders/1 (자동, id 추정)"], "{why}");
            let details: Vec<String> = plan.skipped.iter().filter_map(|check| check.prop("detail").and_then(JsValue::as_str).map(str::to_owned)).collect();
            assert!(details.iter().any(|detail| detail.contains(&format!("확인하지 못했습니다({why})"))), "{details:?}");
        }
    }

    #[test]
    fn 겹침이_보고되면_받지_않고_시작_때의_값으로_연다() {
        let extra: Reply = Box::new(|op, _| (op == "autoShadows").then(|| r#"{"ok":true,"shadows":[{"name":"id","where":"web/app/orders/new"}]}"#.to_owned()));
        let plan = run_plan(&begin(WEB_CONFIG), scripted(dynamic_reply(extra))).ok().unwrap();
        assert_eq!(plan.names, ["web /orders/1 (자동, id 추정)"]);
    }

    #[test]
    fn import_그래프_응답이_알아볼_수_없으면_바뀐_page만으로_계속하지_않고_오류다() {
        for bad in [
            r#"{"ok":true,"files":["a.tsx"],"reverse":"x","readCount":1,"elapsedMs":1}"#,
            r#"{"ok":true,"files":["a.tsx"],"reverse":[],"elapsedMs":1}"#,
            r#"{"ok":true,"files":"a.tsx","reverse":[],"readCount":1,"elapsedMs":1}"#,
            r#"{"ok":true,"files":["a.tsx"],"reverse":[["a.tsx"]],"readCount":1,"elapsedMs":1}"#,
            r#"{"ok":true,"files":["a.tsx"],"reverse":[],"readCount":1,"elapsedMs":1,"incomplete":5}"#,
        ] {
            let reply: Reply = Box::new(move |op, request| match op {
                "autoImportGraph" => Some(bad.to_owned()),
                "autoChangedFiles" => Some(r#"{"ok":true,"files":["web/components/List.tsx"]}"#.to_owned()),
                _ => dynamic_reply(none_reply())(op, request),
            });
            assert_eq!(run_plan(&begin(WEB_CONFIG), scripted(reply)).err(), Some(Fail::Hook), "{bad}");
        }
    }

    #[test]
    fn import_그래프를_읽지_못하면_바뀐_page만으로_계속하고_사유를_남긴다() {
        let reply: Reply = Box::new(|op, request| match op {
            "autoChangedFiles" => Some(r#"{"ok":true,"files":["web/components/List.tsx","web/app/orders/page.tsx"]}"#.to_owned()),
            "autoImportGraph" => Some(r#"{"ok":false,"error":{"message":"읽기 실패"}}"#.to_owned()),
            _ => dynamic_reply(none_reply())(op, request).filter(|_| op == "autoLatest").map(|_| r#"{"ok":true,"state":"unchanged"}"#.to_owned()),
        });
        let plan = run_plan(&begin(WEB_CONFIG), scripted(reply)).ok().unwrap();
        assert_eq!(plan.names.len(), 1);
        let details: Vec<String> = plan.skipped.iter().filter_map(|check| check.prop("detail").and_then(JsValue::as_str).map(str::to_owned)).collect();
        assert_eq!(details, ["import 역추적에 실패해 바뀐 파일을 쓰는 페이지를 찾지 못했습니다: 읽기 실패"]);
    }

    #[test]
    fn 동적_기본값은_받지_못하면_기본값이지만_알아볼_수_없는_응답은_오류다() {
        let from = r#"{"service":"web","mode":"http","expectStatus":200,"maxPages":5,"sampleIdFrom":{"service":"api","path":"/api/orders","jsonPath":"$.id"}}"#;
        let unchanged = |extra: Reply| -> Reply {
            Box::new(move |op, request| {
                extra(op, request).or_else(|| match op {
                    "autoChangedFiles" => Some(r#"{"ok":true,"files":["web/app/orders/[id]/page.tsx"]}"#.to_owned()),
                    "autoLatest" => Some(r#"{"ok":true,"state":"unchanged"}"#.to_owned()),
                    _ => None,
                })
            })
        };
        // 실패 응답(옛 코드의 예외)은 기본값
        let failing: Reply = Box::new(|op, _| (op == "declaredEndpoint").then(|| r#"{"ok":false,"error":{"message":"실패"}}"#.to_owned()));
        let plan = run_plan(&begin(from), scripted(unchanged(failing))).ok().unwrap();
        assert_eq!(plan.names, ["web /orders/1 (자동, id 추정)"]);
        // url이 없는 응답·상태 코드가 수가 아닌 응답은 알아볼 수 없는 응답
        let no_url: Reply = Box::new(|op, _| (op == "declaredEndpoint").then(|| OK.to_owned()));
        assert_eq!(run_plan(&begin(from), scripted(unchanged(no_url))).err(), Some(Fail::Hook));
        let bad_status: Reply = Box::new(|op, _| match op {
            "declaredEndpoint" => Some(r#"{"ok":true,"url":"http://127.0.0.1:1"}"#.to_owned()),
            "declaredResolveUrl" => Some(r#"{"ok":true,"href":"http://127.0.0.1:1/api/orders","sameOrigin":true}"#.to_owned()),
            "declaredPageFetch" => Some(r#"{"ok":true,"status":"200","text":"{}"}"#.to_owned()),
            _ => None,
        });
        assert_eq!(run_plan(&begin(from), scripted(unchanged(bad_status))).err(), Some(Fail::Hook));
        // 값을 받으면 그 값
        let good: Reply = Box::new(|op, _| match op {
            "declaredEndpoint" => Some(r#"{"ok":true,"url":"http://127.0.0.1:1"}"#.to_owned()),
            "declaredResolveUrl" => Some(r#"{"ok":true,"href":"http://127.0.0.1:1/api/orders","sameOrigin":true}"#.to_owned()),
            "declaredPageFetch" => Some(r#"{"ok":true,"status":200,"text":"{\"id\":\"live-7\"}"}"#.to_owned()),
            _ => None,
        });
        let plan = run_plan(&begin(from), scripted(unchanged(good))).ok().unwrap();
        assert_eq!(plan.names, ["web /orders/live-7 (자동, id 추정)"]);
    }

    #[test]
    fn 시작_때_sampleidfrom의_글자가_아닌_필드는_알아볼_수_없는_응답이다() {
        let config = r#"{"service":"web","mode":"http","expectStatus":200,"maxPages":5,"sampleIdFrom":{"service":"api","path":5,"jsonPath":"$.id"}}"#;
        assert_eq!(run_plan(&begin(config), scripted(dynamic_reply(none_reply()))).err(), Some(Fail::Hook));
    }

    #[test]
    fn 관리형_서비스를_못_찾으면_건너뜀_check_하나만_남고_콜백을_부르지_않는다() {
        let config = r#"{"service":"ghost","mode":"http","expectStatus":200,"maxPages":5}"#;
        let plan = run_plan(&begin(config), scripted(Box::new(|_, _| panic!("부르면 안 된다")))).ok().unwrap();
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].prop("name").and_then(JsValue::as_str), Some("ghost ghost (자동, 건너뜀)"));
    }
}
