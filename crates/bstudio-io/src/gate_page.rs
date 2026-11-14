//! 게이트의 화면 확인 판정(옛 TS: `packages/agent/src/gate.ts`의 `VerificationGate.#checkPage`·`#checkFallbackProbe`·`#apiValue`)(ADR-195 4f A5c-1).
//!
//! **통과를 정하는 코드다.** 옛 코드의 순서와 분기를 그대로 따르고, 아래 규칙으로 통과 쪽이 열리는 자리를 닫는다.
//! - 콜백이 응답하지 않거나(`None`) 알아볼 수 없는 모양이면 통과가 아니라 `Fail::Hook`이다. 새로 삼키는 자리를 만들지 않는다.
//!   삼키는 자리는 옛 코드와 같은 하나뿐이다: 근거(`evidenceOrNone`)를 만들다 난 실패(근거 없이 통과로 남는다 — 판정은 이미 났다).
//! - 한 확인이 던진 실패(러너·요청·비교·가림 함수가 던진 것)는 그 확인의 실패 글이다(`Ok(Err(message))`). 콜백의 `{ ok: false, error: { message } }`가 그 던짐이다.
//!   `{ fatal: true }`(TS가 오류를 저장했다)는 그 확인의 실패가 아니라 검사 전체의 중단이다(`Fail::Hook`).
//! - 재지 못한 것은 통과가 아니다: 로드 예산을 적었는데 `loadMs`가 없으면 실패, 첫 화면 글자의 결과가 빠지면 실패(`viewportProblems`), 디자인 비교의 스크린샷이 없으면 실패(TS의 `compareDesign`).
//! - 출처 제한은 TS가 `new URL(path, endpoint.url)`로 푼 `{ href, sameOrigin }`을 그대로 쓴다. 러너와 요청은 그 `href`를 받는다 — 확인하는 해석과 여는 해석이 같은 값에서 나온다(Rust에서 URL을 다시 풀지 않는다).
//! - 브라우저를 못 띄운 오류(`BrowserUnavailableError`)만 `fallbackProbe`로 간다. TS가 응답에 `kind: "unavailable"`을 실어 알린다. 그 밖의 러너 오류는 실패다.
//!
//! 문자열: TS가 `encodeLoneSurrogates`한 글자를 그대로 주고받는다. 옛 코드가 JS 글자 그대로 견주던 것(`text.includes`)은 UTF-16 코드 단위로 푼 글자에서 견주고
//! (쌍의 반쪽을 찾는 `'\ud83d'`도 JS처럼 찾는다), 옛 코드가 napi 경계(`native.…`)를 거치던 판정(`nextErrorMarker`·`detectStuckLoading`·`viewportProblems`·`missing*Text`·`missingApiValue`·
//! `dynamicProbeDataHint`·근거)에 넣는 값만 `lossy_str`로 같은 꼴(짝 없는 서로게이트는 U+FFFD)로 만들고 그 출력은 `enc`로 다시 인코딩한다.
//! 응답 앞부분 200자는 가린 뒤 UTF-16 단위로 자른다(JS `slice`: 쌍이 반으로 잘릴 수 있다).
//!
//! 의도한 차이(옛 코드와 다르게 한 것):
//! - 응답 JSON이 `js_json`이 읽는 깊이를 넘으면 api 값을 읽지 못한 것으로 보고 실패다(JS는 읽는다). 통과로 열리지 않는다.
//! - 모양이 어긋난 러너 결과(문자열이어야 할 `text`가 아니거나 배열이어야 할 `pageErrors`가 아닌 것)는 확인의 실패가 아니라 `Fail::Hook`이다(옛 코드는 `TypeError`를 던졌다). 통과로 열리지 않는다.
//! - 근거 한 줄이 서로게이트 쌍의 가운데에서 잘리면 U+FFFD가 된다(`check_evidence`와 같다).

use std::cell::{Cell, RefCell};

use bstudio_guard::check_evidence::{self, to_locale_ko};
use bstudio_guard::gate_helpers::{self, PathValue};
use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::review_input::template;
use bstudio_guard::stuck_loading;

use crate::gate_declared::{enc, evidence_or_none, lossy, lossy_str, redact_soft, request_op, response_of, stopped, text_field, Stop};
use crate::verify_io::{call, call_done, req, s, Answer, Fail, Hook, Res};

/// 한 화면 확인의 결과. `Ok(Some(근거))`가 통과, `Err(글)`이 실패다(`executeNode`가 잡아 `failed`로 돌려주는 그 글)
pub(crate) type Verdict = Result<Option<Vec<String>>, String>;

/// 화면 확인 하나를 부르는 값. `auto`·`index`는 TS가 계획에서 꺼낼 번호다
pub(crate) struct PageRun<'a> {
    pub auto: bool,
    pub index: usize,
    pub name: &'a str,
    pub probed_id: Option<&'a str>,
    pub sampled: Option<&'a str>,
}

struct Cx<'a> {
    hook: &'a Hook,
    page: &'a JsValue,
    run: &'a PageRun<'a>,
}

impl Cx<'_> {
    /// 옛 `fail(message)`: 자동 페이지면 경로를 앞에 붙이고 가린 뒤의 글. 가림 함수가 던지면 그 오류의 글이다
    async fn fail(&self, message: &str) -> Res<String> {
        let text = if self.run.auto { format!("자동 페이지 {}: {message}", template(self.page.prop("path"))) } else { message.to_owned() };
        redact_text(self.hook, &text).await
    }

    /// 옛 `#addWarning`
    async fn warn(&self, message: String) -> Res<()> {
        call_done(self.hook, req("declaredWarn", vec![("name", s(self.run.name)), ("message", s(message))])).await.map(|_| ())
    }
}

/// 가린 글. 가림 함수가 던지면 그 오류의 글을 돌려준다(옛 `new Error(sandbox.redact(...))`가 던지던 것)
async fn redact_text(hook: &Hook, wire: &str) -> Res<String> {
    match redact_soft(hook, wire).await? {
        Ok(redacted) => Ok(redacted),
        Err((message, _)) => Ok(message),
    }
}

// ── 글자 ─────────────────────────────────────────────────────────────────

fn has_escape(text: &str) -> bool {
    text.chars().any(|c| c == '\u{E010}' || c == '\u{E011}')
}

/// 인코딩한 글자를 원래 JS 글자의 UTF-16 코드 단위로 푼다(짝 없는 서로게이트는 그 단위 그대로)
fn units(wire: &str) -> Vec<u16> {
    let chars: Vec<char> = wire.chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    let mut buffer = [0u16; 2];
    while at < chars.len() {
        match js::read_lone_escape(&chars, at) {
            Some((Err(unit), used)) => {
                out.push(unit as u16);
                at += used;
            }
            Some((Ok(c), used)) => {
                out.extend_from_slice(c.encode_utf16(&mut buffer));
                at += used;
            }
            None => {
                out.extend_from_slice(chars[at].encode_utf16(&mut buffer));
                at += 1;
            }
        }
    }
    out
}

/// UTF-16 코드 단위를 인코딩한 글자로(짝 없는 서로게이트와 예약 글자는 이스케이프)
fn wire_from_units(units: &[u16]) -> String {
    let mut out = String::new();
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => out.push_str(&js::encode_reserved_char(c)),
            Err(error) => out.push_str(&js::encode_lone_unit(u32::from(error.unpaired_surrogate()))),
        }
    }
    out
}

/// JS `text.includes(needle)`. 둘 다 인코딩한 글자다. 쌍의 반쪽을 찾는 기대도 JS처럼 찾는다
fn includes(text: &str, needle: &str) -> bool {
    if !has_escape(text) && !has_escape(needle) {
        return text.contains(needle);
    }
    let (haystack, wanted) = (units(text), units(needle));
    wanted.is_empty() || haystack.windows(wanted.len()).any(|window| window == wanted.as_slice())
}

/// `string.slice(0, n)`(UTF-16 코드 단위). 인코딩한 글자로 돌려준다
fn slice_units(wire: &str, n: usize) -> String {
    let all = units(wire);
    wire_from_units(&all[..all.len().min(n)])
}

fn js_num(value: f64) -> String {
    js::number_to_string(value)
}

/// 문자열 배열 필드. 없으면 `None`, 배열이 아니거나 글자가 아닌 원소가 있으면 알아볼 수 없는 입력이다
fn strings_of(value: Option<&JsValue>) -> Res<Option<Vec<String>>> {
    match value {
        None | Some(JsValue::Null) => Ok(None),
        Some(JsValue::Arr(items)) => items.iter().map(|item| item.as_str().map(str::to_owned).ok_or(Fail::Hook)).collect::<Res<Vec<_>>>().map(Some),
        Some(_) => Err(Fail::Hook),
    }
}

/// 문자열 배열이어야 하는 결과 필드(`pageErrors`·`consoleErrors`…)
fn required_strings(result: &JsValue, key: &str) -> Res<Vec<String>> {
    strings_of(result.prop(key))?.ok_or(Fail::Hook)
}

fn truthy(page: &JsValue, key: &str) -> bool {
    page.prop(key).is_some_and(JsValue::truthy)
}

/// 옛 `slice(0, 3).join(' | ')`
fn first_three(items: &[String]) -> String {
    items.iter().take(3).cloned().collect::<Vec<_>>().join(" | ")
}

// ── 콜백 ─────────────────────────────────────────────────────────────────

async fn endpoint(hook: &Hook, service: &str) -> Result<String, Stop> {
    let value = request_op(hook, req("declaredEndpoint", vec![("service", s(service))])).await?;
    text_field(&value, "url").map_err(Stop::Fail)
}

/// TS가 `new URL(path, base)`로 푼 `{ href, sameOrigin }`
async fn resolve(hook: &Hook, base: &str, path: &str) -> Result<(String, bool), Stop> {
    let value = request_op(hook, req("declaredResolveUrl", vec![("base", s(base)), ("path", s(path))])).await?;
    Ok((text_field(&value, "href").map_err(Stop::Fail)?, matches!(value.prop("sameOrigin"), Some(JsValue::Bool(true)))))
}

async fn fetch(hook: &Hook, href: &str) -> Result<(f64, String), Stop> {
    response_of(&request_op(hook, req("declaredPageFetch", vec![("href", s(href))])).await?)
}

// ── api 값 ───────────────────────────────────────────────────────────────

enum ApiValue {
    Text(String),
    Num(f64),
}

struct Api {
    service: String,
    json_path: String,
    value: ApiValue,
}

impl Api {
    fn context(&self) -> JsValue {
        js_json::object(vec![
            ("service", Some(s(self.service.clone()))),
            ("jsonPath", Some(s(self.json_path.clone()))),
            ("value", Some(match &self.value {
                ApiValue::Text(text) => s(text.clone()),
                ApiValue::Num(n) => JsValue::Num(*n),
            })),
        ])
    }

    /// 옛 `containsApiValue`. 숫자의 견줄 글자는 ASCII(와 ∞)뿐이라 본문이 U+FFFD로 바뀌어도 같고, 글자 값은 두 글자를 인코딩한 채 견준다
    fn found_in(&self, text: &str) -> bool {
        match &self.value {
            ApiValue::Num(n) => gate_helpers::contains_api_number(&lossy_str(text), *n),
            ApiValue::Text(value) => gate_helpers::contains_api_text(text, value),
        }
    }

    /// 옛 `missingApiValue(api, page.path)`
    fn missing(&self, page_path: &str) -> String {
        let (text, number) = match &self.value {
            ApiValue::Text(value) => (Some(lossy_str(value)), None),
            ApiValue::Num(n) => (None, Some(*n)),
        };
        enc(&gate_helpers::missing_api_value(&lossy_str(&self.service), &lossy_str(&self.json_path), text.as_deref(), number, &lossy_str(page_path)))
    }
}

/// 옛 `#apiValue`. `expectFromApi`가 있으면 api를 불러 jsonPath 값(문자열·숫자)을 꺼낸다. 없으면 `None`
async fn api_value(cx: &Cx<'_>) -> Res<Result<Option<Api>, String>> {
    let Some(expect) = cx.page.prop("expectFromApi").filter(|value| value.truthy()) else { return Ok(Ok(None)) };
    let hook = cx.hook;
    let (service, path, json_path) = (text_field(expect, "service")?, text_field(expect, "path")?, text_field(expect, "jsonPath")?);
    let base = match endpoint(hook, &service).await {
        Ok(url) => url,
        Err(stop) => return stopped(stop),
    };
    let (href, same) = match resolve(hook, &base, &path).await {
        Ok(resolved) => resolved,
        Err(stop) => return stopped(stop),
    };
    if !same {
        return Ok(Err("path must stay on the service host".to_owned()));
    }
    let (status, text) = match fetch(hook, &href).await {
        Ok(response) => response,
        Err(stop) => return stopped(stop),
    };
    if !(200.0..300.0).contains(&status) {
        return Ok(Err(redact_text(hook, &format!("{service} GET {path}가 HTTP {}을 돌려줬습니다", js_num(status))).await?));
    }
    let value = match gate_helpers::read_json_path(&text, &json_path) {
        Ok(value) => value,
        // JSON이 너무 깊어 읽지 못했다. 읽지 못한 값은 통과로 세지 않는다
        Err(_) => return Ok(Err(format!("{json_path} 값을 읽지 못했습니다: 응답 JSON이 너무 깊습니다"))),
    };
    let kind_error = |what: &str| format!("{json_path}는 {what}입니다. 화면에 그려질 문자열·숫자 값을 가리키세요");
    let value = match value {
        PathValue::Undefined | PathValue::Value(JsValue::Null) => {
            // 자르기 전에 가린다. 200자 경계에 걸친 시크릿의 앞부분이 남지 않게 한다(#751)
            let redacted = match redact_soft(hook, &text).await? {
                Ok(redacted) => redacted,
                // 안쪽 가림 함수가 던지면 그 오류가 실패 글이다(옛 코드는 바깥 글을 만들기 전에 던진다)
                Err((message, _)) => return Ok(Err(message)),
            };
            let message = format!("{service} 응답에 {json_path}이 없습니다. 응답 앞부분: {}", slice_units(&redacted, 200));
            return Ok(Err(redact_text(hook, &message).await?));
        }
        PathValue::ObjectProto | PathValue::Value(JsValue::Obj(_)) => return Ok(Err(kind_error("객체"))),
        PathValue::ArrayProto | PathValue::Value(JsValue::Arr(_)) => return Ok(Err(kind_error("배열"))),
        PathValue::Value(JsValue::Bool(_)) => return Ok(Err(kind_error("boolean"))),
        PathValue::Value(JsValue::Num(n)) => ApiValue::Num(n),
        PathValue::Value(JsValue::Str(value)) => {
            if js::trim(&value).is_empty() {
                return Ok(Err(format!("{json_path} 값이 빈 문자열입니다. 화면에 그려질 문자열·숫자 값을 가리키세요")));
            }
            ApiValue::Text(value)
        }
    };
    Ok(Ok(Some(Api { service, json_path, value })))
}

// ── 근거 ─────────────────────────────────────────────────────────────────

/// 옛 `evidenceOrNone(() => finishEvidence(browserPageEvidence(page, result, context), redact))`.
/// 근거의 값은 만드는 중에 가림 함수를 부른다(가린 뒤에 자른다). 가림은 비동기 콜백이라 두 번에 나눠 만든다: 먼저 값만 모으며 지은 뒤(가림 함수는 그대로 돌려준다) 그 값을 **옛 코드가 부르던 순서대로**
/// 콜백으로 가려 받고, 가린 값으로 다시 짓는다. 근거를 짓는 길은 가림 결과에 따라 갈라지지 않으므로 두 번의 부름 순서가 같다. 만들다 던지면(모양 오류·가림 함수의 던짐) 근거 없이 돌려준다
async fn page_evidence(hook: &Hook, build: impl for<'a> Fn(check_evidence::Redact<'a>) -> Result<Vec<String>, String>) -> Res<Vec<String>> {
    let recorded = RefCell::new(Vec::<String>::new());
    let first = build(&|text| {
        recorded.borrow_mut().push(text.to_owned());
        Ok(text.to_owned())
    });
    let recorded = recorded.into_inner();
    let mut answers = Vec::with_capacity(recorded.len());
    for text in &recorded {
        match call(hook, req("declaredRedact", vec![("text", s(enc(text))), ("rethrow", JsValue::Bool(false))])).await? {
            Answer::Done(value) => match value.prop("text") {
                Some(JsValue::Str(redacted)) => answers.push(lossy_str(redacted)),
                _ => return Err(Fail::Hook),
            },
            // 가림 함수가 던졌다: 옛 코드는 거기서 멈추고 근거를 비운다
            Answer::Failed { .. } => return Ok(Vec::new()),
        }
    }
    if first.is_err() {
        return Ok(Vec::new());
    }
    let next = Cell::new(0usize);
    let second = build(&|text| {
        let at = next.get();
        next.set(at + 1);
        match (recorded.get(at), answers.get(at)) {
            (Some(asked), Some(answer)) if asked == text => Ok(answer.clone()),
            _ => Err("근거를 짓는 길이 두 번 달랐습니다".to_owned()),
        }
    });
    match second {
        Ok(lines) => evidence_or_none(hook, lines).await,
        Err(_) => Ok(Vec::new()),
    }
}

fn evidence_context(run: &PageRun<'_>, api: Option<&Api>) -> JsValue {
    js_json::object(vec![
        ("auto", run.auto.then_some(JsValue::Bool(true))),
        ("probedId", run.probed_id.map(s)),
        ("api", api.map(Api::context)),
    ])
}

// ── 판정 ─────────────────────────────────────────────────────────────────

fn sampled_value_hint(sampled: &str) -> String {
    format!("이 화면은 studio.yaml의 autoPageChecks.sampleParams로 알려 준 값({sampled})으로 열었습니다 — 그 값의 데이터가 실제로 없으면 같은 실패가 납니다. 앱이 실제로 가진 값으로 sampleParams를 고치세요(이 값은 같은 실행에서 바로 반영됩니다)")
}

/// `status`는 `HTTP ${status}`로 적는다(`null`이면 `null`)
fn dynamic_probe_status_problem(probed_id: &str, status: Option<f64>) -> String {
    let shown = status.map_or_else(|| "null".to_owned(), js_num);
    format!("동적 경로를 추정한 id({probed_id})로 열었더니 HTTP {shown}을 돌려줬습니다 — id가 실제로 없을 수 있습니다. autoPageChecks.sampleParams나 sampleIdFrom으로 실제 값을 알려주면 더 정확히 확인합니다")
}

fn is_dynamic_probe_failure(status: Option<f64>) -> bool {
    status == Some(404.0) || status.is_some_and(|code| code >= 500.0)
}

/// 옛 `nextErrorMarker(text, page.expectStatus)`. 표지는 ASCII라 본문의 짝 없는 서로게이트가 U+FFFD가 되어도 결과가 같다
fn next_error_marker(text: &str, expect_status: f64) -> Option<&'static str> {
    gate_helpers::next_error_marker(&lossy_str(text), expect_status)
}

/// 옛 `detectStuckLoading(text, evidence?)`. `plain`은 경계를 거쳐 온 꼴(짝 없는 서로게이트는 U+FFFD)의 글이다
fn detect_stuck(plain: &str, evidence: Option<&JsValue>) -> Option<String> {
    stuck_loading::detect_stuck_loading(plain, evidence).map(|reason| enc(&reason))
}

/// 적은 글자(`expectText`·`expectAnyText`·`expectAllText`)의 판정. `place`는 문구에 들어가지 않는다 — 브라우저는 `렌더링된 화면`, HTTP는 `응답 본문`이 `expectText` 문구에만 다르다
fn text_problems(page: &JsValue, text: &str, expect_text_place: &str) -> Res<Vec<String>> {
    let mut problems = Vec::new();
    if let Some(expect) = page.prop("expectText").filter(|value| value.truthy()) {
        let wanted = expect.to_js_string();
        if !includes(text, &wanted) {
            problems.push(format!("{expect_text_place}에 '{wanted}'가 없습니다"));
        }
    }
    // expectAnyText는 적은 문구 중 하나라도 있으면 통과한다(숫자 표기가 갈릴 때)
    if let Some(any) = page.prop("expectAnyText").filter(|value| value.truthy()) {
        let Some(candidates) = strings_of(Some(any))? else { return Err(Fail::Hook) };
        if !candidates.iter().any(|candidate| includes(text, candidate)) {
            problems.push(missing_any(&candidates));
        }
    }
    // expectAllText는 적은 문구가 모두 있어야 통과한다. 빠진 것만 알린다
    if let Some(candidates) = strings_of(page.prop("expectAllText"))? {
        let missing: Vec<String> = candidates.into_iter().filter(|candidate| !includes(text, candidate)).collect();
        if !missing.is_empty() {
            problems.push(missing_all(&missing));
        }
    }
    Ok(problems)
}

fn lossy_all(values: &[String]) -> Vec<String> {
    values.iter().map(|value| lossy_str(value)).collect()
}

fn missing_any(values: &[String]) -> String {
    enc(&gate_helpers::missing_any_text(&lossy_all(values)))
}

fn missing_all(values: &[String]) -> String {
    enc(&gate_helpers::missing_all_text(&lossy_all(values)))
}

/// 옛 `viewportProblems(page.expectInViewport, result.viewportTexts)`. 글자 짝짓기는 인코딩한 글자(`key`)로 한다 —
/// 짝 없는 서로게이트가 U+FFFD로 모두 같아져 다른 글자를 "찾았다"고 읽지 않게(트러블슈팅 165)
fn viewport_problems(expected: &[String], report: Option<&JsValue>) -> Res<Vec<String>> {
    let keyed = |wire: &str| js_json::object(vec![("key", Some(s(wire))), ("text", Some(s(lossy_str(wire))))]);
    let report = match report {
        None | Some(JsValue::Null) => JsValue::Null,
        Some(report @ JsValue::Obj(_)) => {
            let Some(JsValue::Arr(findings)) = report.prop("findings") else { return Err(Fail::Hook) };
            let mut keyed_findings = Vec::new();
            for finding in findings {
                let Some(JsValue::Str(wire)) = finding.prop("text") else { return Err(Fail::Hook) };
                let JsValue::Obj(mut copy) = lossy(finding) else { return Err(Fail::Hook) };
                copy.set("key", s(wire.clone()));
                keyed_findings.push(JsValue::Obj(copy));
            }
            js_json::object(vec![("width", report.prop("width").cloned()), ("height", report.prop("height").cloned()), ("findings", Some(JsValue::Arr(keyed_findings)))])
        }
        Some(_) => return Err(Fail::Hook),
    };
    let input = js_json::object(vec![("expected", Some(JsValue::Arr(expected.iter().map(|wire| keyed(wire)).collect()))), ("report", Some(report))]);
    gate_helpers::viewport_problems(&input).map(|lines| lines.iter().map(|line| enc(line)).collect()).map_err(|_| Fail::Hook)
}

fn opt_number(value: Option<&JsValue>) -> Res<Option<f64>> {
    match value {
        None => Ok(None),
        Some(JsValue::Num(n)) => Ok(Some(*n)),
        Some(_) => Err(Fail::Hook),
    }
}

/// 브라우저 결과의 모든 판정을 옛 순서로. 문제 글 목록을 돌려준다(비면 통과)
fn browser_problems(page: &JsValue, result: &JsValue, run: &PageRun<'_>, api: Option<&Api>, expect_status: f64) -> Res<Vec<String>> {
    let text = match result.prop("text") {
        Some(JsValue::Str(text)) => text.as_str(),
        _ => return Err(Fail::Hook),
    };
    // 첫 문서 응답의 상태 코드. `null`·`undefined`는 응답을 받지 못한 것이다
    let status = match result.prop("status") {
        None | Some(JsValue::Null) => None,
        Some(JsValue::Num(n)) => Some(*n),
        Some(_) => return Err(Fail::Hook),
    };
    let mut problems: Vec<String> = Vec::new();
    if let Some(probed) = run.probed_id {
        // 추정한 id로 연 동적 경로(ADR-078): id가 실제로 없을 수도 있어 404·500만 실패로 본다
        if is_dynamic_probe_failure(status) {
            problems.push(dynamic_probe_status_problem(probed, status));
        }
    } else if status != Some(expect_status) {
        problems.push(format!("HTTP {} (기대 {})", status.map_or_else(|| "응답 없음".to_owned(), js_num), js_num(expect_status)));
    }
    problems.extend(text_problems(page, text, "렌더링된 화면")?);
    // expectInViewport: 글자가 DOM에 있는 것만이 아니라 첫 화면에 온전히 보이는지(ADR-161). 재지 못했으면 통과로 보지 않는다
    if let Some(expected) = page.prop("expectInViewport").filter(|value| value.truthy()) {
        let Some(expected) = strings_of(Some(expected))? else { return Err(Fail::Hook) };
        problems.extend(viewport_problems(&expected, result.prop("viewportTexts"))?);
    }
    // api에서 꺼낸 값이 렌더링된 글자에 있는지. expectText와 같은 위치에서 본다
    if let Some(api) = api {
        if !api.found_in(text) {
            problems.push(api.missing(&text_field(page, "path")?));
        }
    }
    let page_errors = required_strings(result, "pageErrors")?;
    let console_errors = required_strings(result, "consoleErrors")?;
    let failed_requests = required_strings(result, "failedRequests")?;
    let media_errors = required_strings(result, "mediaErrors")?;
    if !page_errors.is_empty() {
        problems.push(format!("스크립트 예외: {}", first_three(&page_errors)));
    }
    let allow_console = truthy(page, "allowConsoleErrors");
    if !allow_console && !console_errors.is_empty() {
        problems.push(format!("console.error: {}", first_three(&console_errors)));
    }
    if !allow_console && !failed_requests.is_empty() {
        problems.push(format!("실패한 요청: {}", first_three(&failed_requests)));
    }
    // <video>/<audio>/<img>의 로드·재생 실패(트러블슈팅 83)
    if !allow_console && !media_errors.is_empty() {
        problems.push(format!("미디어 오류: {}", first_three(&media_errors)));
    }
    // 데이터를 못 받아 로딩 상태에서 멈춘 화면(ADR-078). 실패한 요청·콘솔 오류·스크립트 예외를 증거로 함께 본다
    if !truthy(page, "allowLoadingPlaceholder") {
        let evidence = js_json::object(vec![
            ("failedRequests", Some(JsValue::Num(failed_requests.len() as f64))),
            ("consoleErrors", Some(JsValue::Num(console_errors.len() as f64))),
            ("pageErrors", Some(JsValue::Num(page_errors.len() as f64))),
        ]);
        problems.extend(detect_stuck(&lossy_str(text), Some(&evidence)));
    }
    if truthy(page, "noHorizontalScroll") {
        let overflow = match result.prop("horizontalOverflowPx") {
            // `undefined > 1`·`null > 1`은 거짓이다. 수가 아닌 그 밖의 값은 알아볼 수 없다
            None | Some(JsValue::Null) => None,
            Some(JsValue::Num(n)) => Some(*n),
            Some(_) => return Err(Fail::Hook),
        };
        if let Some(px) = overflow.filter(|px| *px > 1.0) {
            problems.push(format!("가로로 {}px 넘칩니다", js_num(px)));
        }
    }
    let load_ms = opt_number(result.prop("loadMs"))?;
    if let Some(budget) = opt_number(page.prop("maxLoadMs"))? {
        // 예산을 적었는데 재지 못했으면 "검사 안 함"이 통과로 보이지 않도록 실패로 본다
        match load_ms {
            None => problems.push(format!("로드 시간을 재지 못했습니다 (예산 {}ms)", to_locale_ko(budget))),
            Some(load) if load > budget => problems.push(format!("로드 {}ms (예산 {}ms)", to_locale_ko(load), to_locale_ko(budget))),
            Some(_) => {}
        }
    }
    if run.auto {
        // 상태 코드가 200이어도 본문이 Next.js 오류 화면이면 실패다(새로 만든 페이지가 500을 내는 것을 잡는 자리)
        if let Some(marker) = next_error_marker(text, expect_status) {
            problems.push(format!("Next.js 오류 화면: '{marker}'"));
        }
    }
    // 추정한 id로 연 화면이 실패했으면, 그 id의 데이터가 없어서일 수 있다는 것과 실제 id를 알려 주는 방법을 붙인다(상태 코드 문제는 이미 같은 안내를 담고 있다)
    if let Some(probed) = run.probed_id {
        if !problems.is_empty() && !problems.iter().any(|problem| problem.contains("추정한 id(")) {
            problems.push(enc(&gate_helpers::dynamic_probe_data_hint(&lossy_str(probed))));
        }
    }
    if let Some(sampled) = run.sampled {
        if !problems.is_empty() {
            problems.push(sampled_value_hint(sampled));
        }
    }
    Ok(problems)
}

// ── 화면 확인 ────────────────────────────────────────────────────────────

fn is_browser(page: &JsValue) -> bool {
    matches!(page.prop("mode"), Some(JsValue::Str(mode)) if mode == "browser")
}

/// 옛 `#checkPage`
pub(crate) async fn check_page(hook: &Hook, page: &JsValue, run: &PageRun<'_>) -> Res<Verdict> {
    let cx = Cx { hook, page, run };
    // ① api를 불러 값을 꺼내 둔다. 여기서 실패하면 화면을 열지 않고 멈춘다(렌더링을 낭비하지 않는다)
    let api = match api_value(&cx).await? {
        Ok(api) => api,
        Err(message) => return Ok(Err(message)),
    };
    let base = match endpoint(hook, &text_field(page, "service")?).await {
        Ok(url) => url,
        Err(stop) => return stopped(stop),
    };
    let (href, same) = match resolve(hook, &base, &text_field(page, "path")?).await {
        Ok(resolved) => resolved,
        Err(stop) => return stopped(stop),
    };
    if !same {
        return Ok(Err("path must stay on the service host".to_owned()));
    }
    let expect_status = match page.prop("expectStatus") {
        Some(JsValue::Num(n)) => *n,
        _ => return Err(Fail::Hook),
    };
    if is_browser(page) {
        browser_mode(&cx, &href, api.as_ref(), expect_status).await
    } else {
        http_mode(&cx, &href, api.as_ref(), expect_status).await
    }
}

async fn browser_mode(cx: &Cx<'_>, href: &str, api: Option<&Api>, expect_status: f64) -> Res<Verdict> {
    let (hook, page, run) = (cx.hook, cx.page, cx.run);
    let request = req("declaredBrowserRun", vec![("auto", JsValue::Bool(run.auto)), ("index", JsValue::Num(run.index as f64)), ("name", s(run.name)), ("href", s(href))]);
    let result = match call(hook, request).await? {
        Answer::Done(value) => match value.prop("result") {
            Some(result @ JsValue::Obj(_)) => result.clone(),
            _ => return Err(Fail::Hook),
        },
        Answer::Failed { message, value, .. } => {
            // 헤드리스 브라우저를 못 띄우면(ADR-050은 원래 그대로 실패시킨다) fallbackProbe가 있는 확인만 대신 HTTP로 확인한다. 그 밖의 오류는 그대로 실패다
            let unavailable = matches!(value.prop("kind"), Some(JsValue::Str(kind)) if kind == "unavailable");
            if unavailable && truthy(page, "fallbackProbe") {
                return fallback_probe(cx, &message).await;
            }
            return Ok(Err(message));
        }
    };
    let problems = browser_problems(page, &result, run, api, expect_status)?;
    if !problems.is_empty() {
        return Ok(Err(cx.fail(&problems.join("\n")).await?));
    }
    // 문제가 없을 때만 디자인 비교를 한다(기준 이미지 읽기·비교·저장은 TS)
    if truthy(page, "compare") {
        let request = req("declaredCompare", vec![("auto", JsValue::Bool(run.auto)), ("index", JsValue::Num(run.index as f64)), ("name", s(run.name))]);
        if let Answer::Failed { message, .. } = call(hook, request).await? {
            return Ok(Err(message));
        }
    }
    let (lossy_page, lossy_result, context) = (lossy(page), lossy(&result), lossy(&evidence_context(run, api)));
    let lines = page_evidence(hook, |redact| check_evidence::browser_page_evidence(&lossy_page, &lossy_result, Some(&context), redact)).await?;
    Ok(Ok(Some(lines)))
}

async fn http_mode(cx: &Cx<'_>, href: &str, api: Option<&Api>, expect_status: f64) -> Res<Verdict> {
    let (hook, page, run) = (cx.hook, cx.page, cx.run);
    let (status, text) = match fetch(hook, href).await {
        Ok(response) => response,
        Err(stop) => return stopped(stop),
    };
    if let Some(probed) = run.probed_id {
        // 추정한 id로 연 동적 경로(ADR-078): id가 실제로 없을 수도 있어 404·500만 실패로 본다
        if is_dynamic_probe_failure(Some(status)) {
            return Ok(Err(cx.fail(&dynamic_probe_status_problem(probed, Some(status))).await?));
        }
    } else if status != expect_status {
        let hint = run.sampled.map_or_else(String::new, |sampled| format!("\n{}", sampled_value_hint(sampled)));
        return Ok(Err(cx.fail(&format!("HTTP {} (기대 {}){hint}", js_num(status), js_num(expect_status))).await?));
    }
    if run.auto {
        // 표지는 화면에 보이는 글자(스크립트·스타일을 걷어낸 글자)에서 찾는다. Next.js 16은 정상 응답의 RSC 데이터(스크립트 안)에도 기본 not-found 화면 글자를 싣는다(#1207)
        let visible = gate_helpers::strip_html(&lossy_str(&text));
        if let Some(marker) = next_error_marker(&visible, expect_status) {
            return Ok(Err(cx.fail(&format!("Next.js 오류 화면: '{marker}'")).await?));
        }
        // 셸을 보낸 뒤 난 서버 오류는 화면 글자에 표지가 없고 원문의 신호로만 드러난다
        if let Some(digest) = gate_helpers::next_render_error_digest(&lossy_str(&text), expect_status) {
            let shown = if digest.is_empty() { "digest 없음".to_owned() } else { format!("digest '{digest}'") };
            let problem = format!("Next.js 오류 화면: 서버 렌더링이 도중에 실패했습니다({shown}). 상태 코드는 {}이지만 화면 일부를 서버에서 그리지 못했습니다", js_num(status));
            return Ok(Err(cx.fail(&problem).await?));
        }
        // HTTP 확인은 자바스크립트를 실행하지 않아 클라이언트 fetch가 실패했는지 확정할 수 없다. 보수적으로 경고만 남긴다(ADR-078)
        if let Some(stuck) = detect_stuck(&visible, None) {
            cx.warn(format!("[참고] {stuck} — HTTP 확인은 자바스크립트를 실행하지 않아 확정할 수 없습니다. 확실히 판정하려면 autoPageChecks.mode: browser를 쓰세요")).await?;
        }
    }
    // 글자는 첫 어긋남에서 멈춘다(expectText → expectAnyText → expectAllText → api 값)
    if let Some(first) = http_text_problem(page, &text, api)? {
        return Ok(Err(cx.fail(&first).await?));
    }
    let (lossy_page, context) = (lossy(page), lossy(&evidence_context(run, api)));
    let response = lossy(&js_json::object(vec![("status", Some(JsValue::Num(status))), ("text", Some(s(text.clone())))]));
    let lines = page_evidence(hook, |redact| check_evidence::http_page_evidence(&lossy_page, &response, Some(&context), redact)).await?;
    Ok(Ok(Some(lines)))
}

/// HTTP 모드의 글자 판정. 옛 코드는 어긋나는 대로 던졌으므로 첫 문제 하나다
fn http_text_problem(page: &JsValue, text: &str, api: Option<&Api>) -> Res<Option<String>> {
    if let Some(first) = text_problems(page, text, "응답 본문")?.into_iter().next() {
        return Ok(Some(first));
    }
    if let Some(api) = api {
        if !api.found_in(text) {
            return Ok(Some(api.missing(&text_field(page, "path")?)));
        }
    }
    Ok(None)
}

/// 옛 `#checkFallbackProbe`. 헤드리스 브라우저를 못 띄울 때 `fallbackProbe`가 가리키는 서비스·경로로 평범한 HTTP 요청을 한 번 보낸다.
/// 응답을 받으면(상태 코드와 무관하게) 그 주소가 살아 있다는 뜻이라 통과시키되, 화면 단위 문제는 보지 못했다는 참고 문구를 남긴다. 연결 자체가 안 되면 실패다
async fn fallback_probe(cx: &Cx<'_>, browser_message: &str) -> Res<Verdict> {
    let hook = cx.hook;
    let Some(probe) = cx.page.prop("fallbackProbe") else { return Err(Fail::Hook) };
    let (service, path) = (text_field(probe, "service")?, text_field(probe, "path")?);
    let base = match endpoint(hook, &service).await {
        Ok(url) => url,
        Err(stop) => return stopped(stop),
    };
    // 서비스 밖으로 풀리는 경로는 요청하지 않고 실패다(#1187). 바깥 호스트의 응답으로 화면 확인을 통과시키지 않는다
    let href = match request_op(hook, req("declaredServiceUrl", vec![("base", s(base)), ("path", s(path.clone()))])).await {
        Ok(value) => text_field(&value, "href")?,
        Err(Stop::Message(message)) => return Ok(Err(cx.fail(&format!("헤드리스 브라우저를 쓸 수 없어 {service}{path}로 대신 확인하려 했지만 {message}")).await?)),
        Err(Stop::Fail(fail)) => return Err(fail),
    };
    let status = match fetch(hook, &href).await {
        Ok((status, _)) => status,
        Err(Stop::Message(message)) => return Ok(Err(cx.fail(&format!("헤드리스 브라우저를 쓸 수 없어 {service}{path}로 대신 확인했는데 연결하지 못했습니다: {message}")).await?)),
        Err(Stop::Fail(fail)) => return Err(fail),
    };
    cx.warn(format!(
        "[참고] 헤드리스 브라우저를 쓸 수 없어({browser_message}) 화면 확인 대신 {service}{path}로 HTTP 확인만 했습니다(응답 {}). 콘솔 오류·실패한 요청·화면에 보이는 오류 문구는 확인하지 못했습니다",
        js_num(status)
    ))
    .await?;
    if let Some(expected) = strings_of(cx.page.prop("expectInViewport").filter(|value| value.truthy()))? {
        let quoted = expected.iter().map(|value| format!("'{value}'")).collect::<Vec<_>>().join(", ");
        cx.warn(format!("[참고] expectInViewport({quoted})가 첫 화면에 보이는지는 확인하지 못했습니다 — 헤드리스 브라우저가 필요합니다")).await?;
    }
    let line = format!("헤드리스 브라우저 없이 {service}{path}의 HTTP 응답({})만 확인했습니다 — 화면은 열지 않았습니다", js_num(status));
    Ok(Ok(Some(evidence_or_none(hook, vec![lossy_str(&line)]).await?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes는_js처럼_코드_단위로_찾는다() {
        let lone_high = js::encode_lone_unit(0xD83D);
        let lone_low = js::encode_lone_unit(0xDE00);
        // 쌍의 반쪽을 찾는 기대는 JS가 찾는다
        assert!(includes("a😀b", &lone_high));
        assert!(includes("a😀b", &lone_low));
        // 짝 없는 두 글자가 이어져 있어도 서로 다른 글자는 합쳐 읽지 않는다
        assert!(!includes(&format!("a{lone_low}b"), &lone_high));
        assert!(includes(&format!("a{lone_high}b"), &lone_high));
        // 짝 없는 서로게이트가 나란히 놓여도(상위 뒤 하위) 쌍이 되므로 이모지다
        assert!(includes(&format!("{lone_high}{lone_low}"), "😀"));
        // 예약 글자가 그대로 있는 본문
        assert!(includes("x\u{E010}\u{E000}", "\u{E010}"));
        assert!(includes("abc", ""));
    }

    #[test]
    fn 단위로_풀었다_되돌리면_같다() {
        let text = format!("가😀{}{}x{}", js::encode_lone_unit(0xD800), js::encode_reserved_char('\u{E011}'), js::encode_lone_unit(0xDC00));
        assert_eq!(wire_from_units(&units(&text)), text);
        let reserved = js::encode_reserved_char('\u{E010}');
        assert_eq!(units(&reserved), vec![0xE010]);
    }

    #[test]
    fn 앞_200단위로_자르면_쌍이_반으로_잘린다() {
        let text = format!("{}😀tail", "a".repeat(199));
        let cut = slice_units(&text, 200);
        assert_eq!(units(&cut).len(), 200);
        assert!(cut.ends_with(&js::encode_lone_unit(0xD83D)));
        assert_eq!(slice_units("가나다", 200), "가나다");
    }

    #[test]
    fn 추정_id_실패는_404와_500_이상이다() {
        assert!(is_dynamic_probe_failure(Some(404.0)));
        assert!(is_dynamic_probe_failure(Some(500.0)));
        assert!(is_dynamic_probe_failure(Some(599.0)));
        assert!(!is_dynamic_probe_failure(Some(499.0)));
        assert!(!is_dynamic_probe_failure(Some(200.0)));
        assert!(!is_dynamic_probe_failure(None));
    }

    fn page(json: &str) -> JsValue {
        js_json::parse(json).expect("JSON")
    }

    fn result(json: &str) -> JsValue {
        js_json::parse(json).expect("JSON")
    }

    const RENDERED: &str = r#"{"status":200,"text":"주문 목록","pageErrors":[],"consoleErrors":[],"failedRequests":[],"mediaErrors":[],"horizontalOverflowPx":0}"#;

    fn run(auto: bool) -> PageRun<'static> {
        PageRun { auto, index: 0, name: "n", probed_id: None, sampled: None }
    }

    fn problems(page_json: &str, result_json: &str) -> Res<Vec<String>> {
        browser_problems(&page(page_json), &result(result_json), &run(false), None, 200.0)
    }

    const BASE: &str = r#""service":"api","path":"/orders","mode":"browser","expectStatus":200"#;

    #[test]
    fn 판정은_옛_순서로_모두_이어_적는다() {
        let all = r#"{"status":500,"text":"x","pageErrors":["p"],"consoleErrors":["c"],"failedRequests":["f"],"mediaErrors":["m"],"horizontalOverflowPx":9}"#;
        let found = problems(&format!(r#"{{{BASE},"expectText":"없음","noHorizontalScroll":true}}"#), all).unwrap();
        let heads: Vec<&str> = found.iter().map(|line| line.split(':').next().unwrap()).collect();
        assert_eq!(found[0], "HTTP 500 (기대 200)");
        assert_eq!(found[1], "렌더링된 화면에 '없음'가 없습니다");
        assert_eq!(&heads[2..], ["스크립트 예외", "console.error", "실패한 요청", "미디어 오류", "가로로 9px 넘칩니다"]);
    }

    #[test]
    fn 로드_예산은_재지_못하면_실패다() {
        let page_json = format!(r#"{{{BASE},"maxLoadMs":1000}}"#);
        assert_eq!(problems(&page_json, RENDERED).unwrap(), vec!["로드 시간을 재지 못했습니다 (예산 1,000ms)"]);
        let with_load = |load: &str| RENDERED.replace(r#""status""#, &format!(r#""loadMs":{load},"status""#));
        assert!(problems(&page_json, &with_load("1000")).unwrap().is_empty());
        assert_eq!(problems(&page_json, &with_load("12345.6789")).unwrap(), vec!["로드 12,345.679ms (예산 1,000ms)"]);
        // 예산이 없으면 재지 못해도 통과다
        assert!(problems(&format!("{{{BASE}}}"), RENDERED).unwrap().is_empty());
    }

    #[test]
    fn 가로_넘침은_1을_넘어야_실패다() {
        let page_json = format!(r#"{{{BASE},"noHorizontalScroll":true}}"#);
        let overflow = |px: &str| RENDERED.replace(r#""horizontalOverflowPx":0"#, &format!(r#""horizontalOverflowPx":{px}"#));
        assert!(problems(&page_json, &overflow("1")).unwrap().is_empty());
        assert_eq!(problems(&page_json, &overflow("1.5")).unwrap(), vec!["가로로 1.5px 넘칩니다"]);
        // 끄면 넘쳐도 통과다
        assert!(problems(&format!("{{{BASE}}}"), &overflow("99")).unwrap().is_empty());
    }

    #[test]
    fn expectAnyText는_하나라도_있으면_통과하고_빈_배열은_실패다() {
        let any = |list: &str| problems(&format!(r#"{{{BASE},"expectAnyText":{list}}}"#), RENDERED).unwrap();
        assert!(any(r#"["없음","주문"]"#).is_empty());
        assert_eq!(any(r#"["없음","또"]"#), vec!["화면에 '없음', '또' 중 어느 것도 없습니다"]);
        assert_eq!(any("[]"), vec!["화면에  중 어느 것도 없습니다"]);
    }

    #[test]
    fn 결과_모양이_어긋나면_통과가_아니라_알아볼_수_없는_응답이다() {
        for broken in [r#"{"status":200,"pageErrors":[],"consoleErrors":[],"failedRequests":[],"mediaErrors":[]}"#, r#"{"status":"200","text":"x","pageErrors":[],"consoleErrors":[],"failedRequests":[],"mediaErrors":[]}"#, r#"{"status":200,"text":"x","pageErrors":"e","consoleErrors":[],"failedRequests":[],"mediaErrors":[]}"#] {
            assert!(matches!(problems(&format!("{{{BASE}}}"), broken), Err(Fail::Hook)), "{broken}");
        }
    }

    #[test]
    fn 첫_화면_글자는_결과가_없으면_실패다() {
        let found = problems(&format!(r#"{{{BASE},"expectInViewport":["주문","목록"]}}"#), RENDERED).unwrap();
        assert_eq!(found, vec!["'주문', '목록'가 첫 화면에 보이는지 재지 못했습니다"]);
        let seen = RENDERED.replace(r#""horizontalOverflowPx":0"#, r#""horizontalOverflowPx":0,"viewportTexts":{"width":1,"height":2,"findings":[{"text":"주문","visible":true}]}"#);
        assert_eq!(problems(&format!(r#"{{{BASE},"expectInViewport":["주문","목록"]}}"#), &seen).unwrap(), vec!["'목록'이 첫 화면에 보이는지 재지 못했습니다"]);
    }

    #[test]
    fn 자동_페이지는_오류_표지를_본다() {
        let marker = RENDERED.replace("주문 목록", "Unhandled Runtime Error");
        let found = browser_problems(&page(&format!("{{{BASE}}}")), &result(&marker), &run(true), None, 200.0).unwrap();
        assert_eq!(found, vec!["Next.js 오류 화면: 'Unhandled Runtime Error'"]);
        assert!(browser_problems(&page(&format!("{{{BASE}}}")), &result(&marker), &run(false), None, 200.0).unwrap().is_empty());
    }

    #[test]
    fn 추정한_id는_404와_500만_실패이고_안내는_한_번만_붙는다() {
        let probed = PageRun { auto: true, index: 0, name: "n", probed_id: Some("1"), sampled: None };
        let bad = RENDERED.replace(r#""status":200"#, r#""status":500"#);
        let found = browser_problems(&page(&format!("{{{BASE}}}")), &result(&bad), &probed, None, 200.0).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("동적 경로를 추정한 id(1)로 열었더니 HTTP 500을 돌려줬습니다"));
        let failed = RENDERED.replace(r#""failedRequests":[]"#, r#""failedRequests":["GET /a 404"]"#);
        let found = browser_problems(&page(&format!("{{{BASE}}}")), &result(&failed), &probed, None, 200.0).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found[1].starts_with("이 화면은 추정한 id(1)로 열었습니다"));
        let ok_status = RENDERED.replace(r#""status":200"#, r#""status":null"#);
        assert!(browser_problems(&page(&format!("{{{BASE}}}")), &result(&ok_status), &probed, None, 200.0).unwrap().is_empty());
    }

    #[test]
    fn sampled_안내는_문제가_있을_때만_붙는다() {
        let sampled = PageRun { auto: true, index: 0, name: "n", probed_id: None, sampled: Some("id=7") };
        assert!(browser_problems(&page(&format!("{{{BASE}}}")), &result(RENDERED), &sampled, None, 200.0).unwrap().is_empty());
        let bad = RENDERED.replace(r#""status":200"#, r#""status":404"#);
        let found = browser_problems(&page(&format!("{{{BASE}}}")), &result(&bad), &sampled, None, 200.0).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found[1].contains("sampleParams로 알려 준 값(id=7)"));
    }

    #[test]
    fn 응답이_없는_상태는_기대와_다르다() {
        let none = RENDERED.replace(r#""status":200"#, r#""status":null"#);
        assert_eq!(problems(&format!("{{{BASE}}}"), &none).unwrap(), vec!["HTTP 응답 없음 (기대 200)"]);
        let absent = RENDERED.replace(r#""status":200,"#, "");
        assert_eq!(problems(&format!("{{{BASE}}}"), &absent).unwrap(), vec!["HTTP 응답 없음 (기대 200)"]);
    }
}
