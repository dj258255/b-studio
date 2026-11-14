//! 게이트의 순수 보조 판정(ADR-191 3단계 3r). 옛 `packages/agent/src/gate.ts`의 `nextErrorMarker`(`NEXT_ERROR_MARKERS`·`NEXT_NOT_FOUND_MARKER`)·`autoPageCheck`·
//! `containsApiValue`·`missingApiValue`·`viewportProblemText`·`viewportProblems`·`missingAllText`·`missingAnyText`·`dynamicProbeDataHint`·`dynamicNames`(구간 번호)·
//! `acceptedNotes`·`usesInRunValue`·`sampledValues`·`stripHtml`·`formatFailedChecks`·`compareDetail`·`describeConcurrencyExpect`.
//!
//! 실행 흐름(샌드박스·브라우저 호출)과 `withoutInRunValues`(JS 객체의 펼침·`delete`·키 순서로 설정을 다시 만든다)는 TS에 남는다.
//! `readJsonPath`는 `read_json_path`로 옮겼다(ADR-195 4f A5b-2). 동시 요청 확인의 `then` 판정이 Rust 안에서 돌기 때문이다. 화면 확인의 `expectFromApi`는 아직 TS의 `readJsonPath`를 쓴다.
//!
//! JS와 같게 읽는 곳:
//! - `containsApiValue`의 숫자: `String(value)`는 `js::number_to_string`, `value.toLocaleString('en-US')`는 `to_locale_string_en_us`(ICU의 en-US 기본값:
//!   소수 3자리까지 반올림(가운데는 올림), 천 단위 쉼표, 음수 0은 `-0`, `NaN`·`∞`). 반올림은 JS가 아는 가장 짧은 10진 자릿수에서 한다.
//! - `stripHtml`의 `/gi`는 u 없는 규칙이라 ASCII만 대소문자를 접는다. 게으른 `[\s\S]*?`는 "처음 닫는 글자까지"다.
//! - `viewportProblemText`의 템플릿 글자: 없는 값은 `undefined`.
//!
//! 의도한 차이:
//! - 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(다른 조각과 같다). 통과로 이어지는 같음·포함 판정 두 곳(`containsApiValue`의 글자 값, `viewportProblems`의
//!   글자 짝짓기)은 TS 껍데기가 견줄 두 글자를 `encodeLoneSurrogates`로 바꿔 보내 이 차이가 판정을 바꾸지 않는다(트러블슈팅 165). 나머지는 화면에 보이는 문구뿐이다.
//! - `sampledValues`·`acceptedNotes`는 `sampleParams`의 자기 속성만 읽는다(옛 구현은 `[constructor]`·`[toString]` 같은 이름에서 `Object.prototype`의 함수를 값으로 읽어
//!   `constructor=function Object() { [native code] }`를 적었다). 문구뿐이고 판정은 같다(`sampled`는 안내 글자에만 쓴다).
//! - `viewportProblemText`는 `problem.kind`가 옛 타입 밖의 값이면 던진다(옛 구현은 `undefined`를 문제 목록에 넣었다). 어느 쪽이든 문제가 하나 생긴 것이라 실패다.

use crate::js;
use crate::js_json::JsValue;

/// Next.js가 오류 화면을 대신 그릴 때 나오는 문구
pub const NEXT_ERROR_MARKERS: [&str; 2] = ["Application error: a server-side exception has occurred", "Unhandled Runtime Error"];
/// Next.js 기본 404 화면
pub const NEXT_NOT_FOUND_MARKER: &str = "This page could not be found";

/// 자동으로 연 페이지의 본문에서 찾은 오류 표지. 없으면 `None`. 표지는 모두 ASCII라 본문의 짝 없는 서로게이트가 U+FFFD가 되어도 결과가 같다
pub fn next_error_marker(text: &str, expect_status: f64) -> Option<&'static str> {
    if let Some(found) = NEXT_ERROR_MARKERS.iter().find(|marker| text.contains(**marker)) {
        return Some(found);
    }
    if expect_status != 404.0 && text.contains(NEXT_NOT_FOUND_MARKER) {
        return Some(NEXT_NOT_FOUND_MARKER);
    }
    None
}

/// React가 스트리밍 도중 서버 렌더링이 실패한 Suspense 경계를 클라이언트 렌더링으로 넘길 때 부르는 함수의 호출 머리(`$RX("<경계 id>","<digest>",…)`). 정의(`$RX=function`)와는 겹치지 않는다
const REACT_CLIENT_RENDER_CALL: &str = "$RX(\"";
/// Next.js RSC 데이터의 오류 조각 머리. 데이터는 `<script>` 안 JS 글자라 따옴표가 `\"`로 들어 있다(`…:E{\"digest\":\"<digest>\",…`)
const RSC_ERROR_CHUNK: &str = "E{\\\"digest\\\":\\\"";
/// `redirect()`가 같은 통로로 보내는 digest 머리. 오류가 아니라 의도한 넘기기다
const NEXT_REDIRECT_DIGEST: &str = "NEXT_REDIRECT;";
/// `notFound()`의 digest. 기대 상태가 404일 때만 오류로 보지 않는다(`next_error_marker`와 같은 규칙)
const NEXT_NOT_FOUND_DIGEST: &str = "NEXT_HTTP_ERROR_FALLBACK;404";
/// 실패 글에 싣는 digest의 최대 글자 수
const DIGEST_MAX_CHARS: usize = 80;

/// HTTP 확인 원문(HTML)에서 찾은 서버 렌더링 오류 신호의 digest(#1207). 없으면 `None`.
/// 셸을 보낸 뒤(상태 코드가 이미 나간 뒤) Suspense 안에서 난 서버 오류는 화면 글자에 표지를 남기지 않고, React의 `$RX(…)` 호출과 RSC 오류 조각으로만 드러난다.
/// 신호가 있는데 digest를 읽지 못하면 빈 글자로 돌려준다(오류로 본다). `NEXT_REDIRECT;`로 시작하는 digest와 기대가 404일 때의 `notFound()`만 뺀다
pub fn next_render_error_digest(html: &str, expect_status: f64) -> Option<String> {
    let mut digests: Vec<String> = Vec::new();
    let mut at = 0;
    while let Some(found) = html[at..].find(REACT_CLIENT_RENDER_CALL) {
        at += found + REACT_CLIENT_RENDER_CALL.len();
        let rest = &html[at..];
        let digest = rest
            .find('"')
            .and_then(|end| rest[end + 1..].strip_prefix(",\""))
            .map(|tail| tail[..tail.find(['"', '\\']).unwrap_or(tail.len())].to_owned());
        digests.push(digest.unwrap_or_default());
    }
    let mut at = 0;
    while let Some(found) = html[at..].find(RSC_ERROR_CHUNK) {
        at += found + RSC_ERROR_CHUNK.len();
        let tail = &html[at..];
        digests.push(tail[..tail.find(['"', '\\']).unwrap_or(tail.len())].to_owned());
    }
    digests
        .into_iter()
        .find(|digest| !digest.starts_with(NEXT_REDIRECT_DIGEST) && !(expect_status == 404.0 && digest == NEXT_NOT_FOUND_DIGEST))
        .map(|digest| digest.chars().take(DIGEST_MAX_CHARS).collect())
}

/// `{ service, mode, expectStatus, viewport? }` → 선언형 pageChecks와 같은 모양. 설정에 없는 값은 pageChecks의 기본값과 같게 둔다(콘솔 오류·가로 스크롤은 허용하지 않는다)
pub fn auto_page_check(config: &JsValue, route_path: &str) -> JsValue {
    let viewport = config.prop("viewport").filter(|v| v.truthy()).cloned();
    crate::js_json::object(vec![
        ("service", config.prop("service").cloned()),
        ("path", Some(JsValue::str(route_path))),
        ("mode", config.prop("mode").cloned()),
        ("expectStatus", config.prop("expectStatus").cloned()),
        ("allowConsoleErrors", Some(JsValue::Bool(false))),
        ("noHorizontalScroll", Some(JsValue::Bool(false))),
        ("viewport", viewport),
    ])
}

/// api 값(글자)이 화면 글자에 있는지. 부르는 쪽이 두 글자를 `encodeLoneSurrogates`로 바꿔 보낸다
pub fn contains_api_text(text: &str, value: &str) -> bool {
    text.contains(value)
}

/// api 값(숫자)이 화면 글자에 있는지. 원문(`String(value)`)과 천 단위 구분(`toLocaleString('en-US')`) 표기를 둘 다 인정한다
pub fn contains_api_number(text: &str, value: f64) -> bool {
    text.contains(&js::number_to_string(value)) || text.contains(&to_locale_string_en_us(value))
}

/// `Number.prototype.toLocaleString('en-US')`: 소수 최대 3자리(가운데는 0에서 먼 쪽), 천 단위 쉼표
pub fn to_locale_string_en_us(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "∞" } else { "-∞" }.to_owned();
    }
    let negative = x.is_sign_negative();
    let a = x.abs();
    let (mut int, mut frac) = if a == 0.0 {
        ("0".to_owned(), String::new())
    } else {
        let (digits, exp) = js::shortest_digits(a);
        let k = digits.len() as i64;
        if exp >= 0 {
            let n = exp + 1;
            if k <= i64::from(n) {
                (format!("{digits}{}", "0".repeat((i64::from(n) - k) as usize)), String::new())
            } else {
                (digits[..n as usize].to_owned(), digits[n as usize..].to_owned())
            }
        } else {
            ("0".to_owned(), format!("{}{digits}", "0".repeat((-exp - 1) as usize)))
        }
    };
    if frac.len() > 3 {
        let round_up = frac.as_bytes()[3] >= b'5';
        frac.truncate(3);
        if round_up {
            let mut all: Vec<u8> = int.bytes().chain(frac.bytes()).collect();
            let mut i = all.len();
            loop {
                if i == 0 {
                    all.insert(0, b'1');
                    break;
                }
                i -= 1;
                if all[i] == b'9' {
                    all[i] = b'0';
                } else {
                    all[i] += 1;
                    break;
                }
            }
            let int_len = all.len() - 3;
            int = String::from_utf8(all[..int_len].to_vec()).expect("ascii");
            frac = String::from_utf8(all[int_len..].to_vec()).expect("ascii");
        }
    }
    while frac.ends_with('0') {
        frac.pop();
    }
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.push_str(&grouped);
    if !frac.is_empty() {
        out.push('.');
        out.push_str(&frac);
    }
    out
}

/// api 값이 화면에 없을 때의 문구. `value_text`는 `String(api.value)`(숫자는 Rust가 만든다: `value_number`)
pub fn missing_api_value(service: &str, json_path: &str, value_text: Option<&str>, value_number: Option<f64>, page_path: &str) -> String {
    let value = match (value_text, value_number) {
        (Some(text), _) => text.to_owned(),
        (None, Some(n)) => js::number_to_string(n),
        (None, None) => "undefined".to_owned(),
    };
    format!("{service}의 {json_path} 값 '{value}'이 {page_path} 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다")
}

/// 템플릿 글자 `${value}`: 없으면 `undefined`
fn show(value: Option<&JsValue>) -> String {
    value.map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
}

/// `Array.prototype.join`에 들어가는 원소: `undefined`·`null`은 빈 글자
fn join_item(value: &JsValue) -> String {
    if matches!(value, JsValue::Null) {
        String::new()
    } else {
        value.to_js_string()
    }
}

/// expectInViewport 실패 한 건의 문구. `width`·`height`는 `${…}`로 적을 글자
fn viewport_problem_text(finding: &JsValue, width: &str, height: &str) -> Result<String, String> {
    let size = format!("(창 {width}x{height})");
    let problem = finding.prop("problem").filter(|p| p.truthy());
    let head = format!("'{}'이 첫 화면에 다 보이지 않습니다 — ", show(finding.prop("text")));
    let Some(problem) = problem else {
        return Ok(format!("{head}보이지 않는 이유를 알 수 없습니다{size}"));
    };
    let kind = match problem.prop("kind") {
        Some(JsValue::Str(kind)) => kind.as_str(),
        _ => "",
    };
    let by = || show(problem.prop("by"));
    let px = || show(problem.prop("px"));
    Ok(match kind {
        "absent" => format!("{head}화면에 없습니다{size}"),
        "hidden" => format!("{head}숨겨져 있습니다(display:none·visibility:hidden, 투명하거나 크기가 거의 없음){size}"),
        "covered" => format!("{head}{}에 덮여 있습니다{size}", by()),
        "scrolled" => format!("{head}잴 때 창이 {}px 스크롤돼 있어 첫 화면이 아닙니다. 화면을 내리는 steps 없이 재세요{size}", px()),
        "clipped" => {
            let side = match problem.prop("side").map(JsValue::to_js_string).as_deref() {
                Some("bottom") => "아래로",
                Some("top") => "위로",
                Some("right") => "오른쪽으로",
                Some("left") => "왼쪽으로",
                _ => "undefined",
            };
            format!("{head}{} 안에서 {side} {}px 잘렸습니다{size}", by(), px())
        }
        "below" => format!("{head}창 아래로 {}px 넘칩니다{size}", px()),
        "above" => format!("{head}창 위로 {}px 넘칩니다{size}", px()),
        "right" => format!("{head}창 오른쪽으로 {}px 넘칩니다{size}", px()),
        "left" => format!("{head}창 왼쪽으로 {}px 넘칩니다{size}", px()),
        other => return Err(format!("알 수 없는 viewport 문제 종류입니다: {other}")),
    })
}

/// `viewportProblemText(finding, width, height)`의 napi용 입구: 창 크기는 수
pub fn viewport_problem_text_for(finding: &JsValue, width: f64, height: f64) -> Result<String, String> {
    viewport_problem_text(finding, &js::number_to_string(width), &js::number_to_string(height))
}

/// expectInViewport 판정. `{ expected: [{ key, text }], report: null | { width, height, findings: [{ key, text, visible, problem? }] } }`.
/// `key`는 `text`를 `encodeLoneSurrogates`한 글자이고 짝짓기는 `key`로 한다(짝 없는 서로게이트가 U+FFFD로 모두 같아져 다른 글자를 "찾았다"고 읽지 않게).
/// 러너가 재지 못했거나 일부 글자의 결과가 빠졌으면 통과로 보지 않는다
pub fn viewport_problems(input: &JsValue) -> Result<Vec<String>, String> {
    let expected = match input.prop("expected") {
        Some(JsValue::Arr(items)) => items,
        _ => return Err("expected는 배열이어야 합니다".to_owned()),
    };
    let quoted = |item: &JsValue| format!("'{}'", show(item.prop("text")));
    let report = match input.prop("report") {
        None | Some(JsValue::Null) => {
            let list = expected.iter().map(quoted).collect::<Vec<_>>().join(", ");
            return Ok(vec![format!("{list}가 첫 화면에 보이는지 재지 못했습니다")]);
        }
        Some(report) => report,
    };
    let findings = match report.prop("findings") {
        Some(JsValue::Arr(items)) => items,
        _ => return Err("report.findings는 배열이어야 합니다".to_owned()),
    };
    let (width, height) = (show(report.prop("width")), show(report.prop("height")));
    let mut problems = Vec::new();
    for item in expected {
        let key = item.prop("key");
        let finding = findings.iter().find(|entry| matches!((entry.prop("key"), key), (Some(a), Some(b)) if a.strict_equals(b)));
        match finding {
            None => problems.push(format!("{}이 첫 화면에 보이는지 재지 못했습니다", quoted(item))),
            Some(finding) if finding.prop("visible").is_some_and(JsValue::truthy) => {}
            Some(finding) => problems.push(viewport_problem_text(finding, &width, &height)?),
        }
    }
    Ok(problems)
}

/// expectAllText 실패 문구
pub fn missing_all_text(values: &[String]) -> String {
    format!("화면에 {}가 없습니다", values.iter().map(|v| format!("'{v}'")).collect::<Vec<_>>().join(", "))
}

/// expectAnyText 실패 문구
pub fn missing_any_text(values: &[String]) -> String {
    format!("화면에 {} 중 어느 것도 없습니다", values.iter().map(|v| format!("'{v}'")).collect::<Vec<_>>().join(", "))
}

/// 추정한 id로 연 화면이 실패했을 때 붙이는 안내
pub fn dynamic_probe_data_hint(probed_id: &str) -> String {
    format!(
        "이 화면은 추정한 id({probed_id})로 열었습니다 — 그 id의 데이터가 없어서 생긴 실패일 수 있습니다. 실제로 있는 값을 studio.yaml의 autoPageChecks.sampleParams(예: {{ id: \"...\" }})나 sampleIdFrom으로 알려주면 그 값으로 엽니다"
    )
}

/// `[이름]` 꼴(폴더 이름 전체가 대괄호 하나, 안에 `[`·`]`가 없는 한 글자 이상) 세그먼트인가. `/^\[([^[\]]+)\]$/`
fn dynamic_name(segment: &str) -> Option<&str> {
    let inner = segment.strip_prefix('[')?.strip_suffix(']')?;
    if inner.is_empty() || inner.contains(['[', ']']) {
        None
    } else {
        Some(inner)
    }
}

/// page 파일 경로(`/`로 가른 세그먼트)에서 단순 동적 세그먼트 `[id]`인 것의 번호. 부르는 쪽이 같은 `split('/')`로 이름을 잘라 쓴다(이름의 짝 없는 서로게이트를 지키려고)
pub fn dynamic_segments(page_file: &str) -> Vec<usize> {
    page_file.split('/').enumerate().filter(|(_, segment)| dynamic_name(segment).is_some()).map(|(i, _)| i).collect()
}

/// 자기 속성만 읽는 `sampleParams[key]`
fn own<'a>(entries: &'a [(String, String)], key: &str) -> Option<&'a str> {
    entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// 받아들인 값을 알리는 문구. `in_run_keys`는 이번 실행에서 받아들인 sampleParams 키(넣은 순서), `sample_from`은 `(service, path)`
pub fn accepted_notes(spec_file: &str, in_run_keys: &[String], sample_params: &[(String, String)], in_run_sample_id_from: bool, sample_from: Option<(&str, &str)>) -> Vec<String> {
    let mut notes = Vec::new();
    let params: Vec<String> = in_run_keys.iter().map(|key| format!("{key}={}", own(sample_params, key).unwrap_or("undefined"))).collect();
    if !params.is_empty() {
        notes.push(format!("{spec_file}의 autoPageChecks.sampleParams({})를 이번 실행에서 바로 반영했습니다", params.join(", ")));
    }
    if let (true, Some((service, path))) = (in_run_sample_id_from, sample_from) {
        notes.push(format!("{spec_file}의 autoPageChecks.sampleIdFrom({service} {path})을 이번 실행에서 바로 반영했습니다"));
    }
    notes
}

/// 이 경로가 실행 중에 받아들인 값으로 채워졌는지: 동적 세그먼트가 그 키를 쓰거나, 추정 id가 실행 중에 들어온 sampleIdFrom에서 왔을 때.
/// 부르는 쪽이 page 파일과 키를 같이 `encodeLoneSurrogates`해서 보낸다
pub fn uses_in_run_value(page_file: &str, in_run_keys: &[String], in_run_sample_id_from: bool, used_fallback_count: usize) -> bool {
    if page_file.split('/').filter_map(dynamic_name).any(|name| in_run_keys.iter().any(|key| key == name)) {
        return true;
    }
    in_run_sample_id_from && used_fallback_count > 0
}

/// `\[(?:\.\.\.)?([A-Za-z0-9_-]+)\]`로 찾은 이름들(겹치지 않게 왼쪽부터)
fn bracket_names(page_file: &str) -> Vec<&str> {
    let bytes = page_file.as_bytes();
    let mut names = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        let mut start = i + 1;
        if bytes[start..].starts_with(b"...") {
            start += 3;
        }
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'-') {
            end += 1;
        }
        if end > start && end < bytes.len() && bytes[end] == b']' {
            names.push(&page_file[start..end]);
            i = end + 1;
        } else {
            i += 1;
        }
    }
    names
}

/// sampleParams로 알려 준 값으로 연 화면의 `이름=값` 목록. 쓴 값이 없으면 `None`. 값이 빈 글자면 쓰지 않은 것이다
pub fn sampled_values(page_file: &str, sample_params: &[(String, String)]) -> Option<String> {
    let used: Vec<String> = bracket_names(page_file)
        .into_iter()
        .filter_map(|name| own(sample_params, name).filter(|value| !value.is_empty()).map(|value| format!("{name}={value}")))
        .collect();
    if used.is_empty() {
        None
    } else {
        Some(used.join(", "))
    }
}

/// ASCII만 대소문자를 접어 `<open` … `</close>`를 가장 짧게 찾아 한 칸으로 바꾼다. `/<script[\s\S]*?<\/script>/gi`
fn replace_blocks(text: &str, open: &str, close: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(found) = lower[at..].find(open) {
        let start = at + found;
        match lower[start + open.len()..].find(close) {
            Some(end) => {
                out.push_str(&text[at..start]);
                out.push(' ');
                at = start + open.len() + end + close.len();
            }
            None => break,
        }
    }
    out.push_str(&text[at..]);
    out
}

/// HTTP 확인 응답 본문(HTML)에서 태그를 걷어내 로딩 문구 판정에 쓸 평문을 만든다. 자바스크립트는 실행하지 않는다
pub fn strip_html(html: &str) -> String {
    let no_script = replace_blocks(html, "<script", "</script>");
    let no_style = replace_blocks(&no_script, "<style", "</style>");
    let mut tagless = String::new();
    let mut at = 0;
    while let Some(found) = no_style[at..].find('<') {
        let start = at + found;
        match no_style[start + 1..].find('>') {
            Some(end) => {
                tagless.push_str(&no_style[at..start]);
                tagless.push('\n');
                at = start + 1 + end + 1;
            }
            None => break,
        }
    }
    tagless.push_str(&no_style[at..]);
    let mut collapsed = String::new();
    let mut in_run = false;
    for c in tagless.chars() {
        if c == ' ' || c == '\t' {
            if !in_run {
                collapsed.push(' ');
                in_run = true;
            }
        } else {
            collapsed.push(c);
            in_run = false;
        }
    }
    js::trim(&collapsed).to_owned()
}

/// `[{ stage, name, attempts, detail? }]` → 실패한 워크플로 검사 목록 문구. 비면 빈 글자
pub fn format_failed_checks(checks: &JsValue) -> Result<String, String> {
    let JsValue::Arr(checks) = checks else {
        return Err("checks는 배열이어야 합니다".to_owned());
    };
    if checks.is_empty() {
        return Ok(String::new());
    }
    let lines: Vec<String> = checks
        .iter()
        .map(|check| {
            let detail = check.prop("detail").filter(|d| d.truthy());
            format!("- [{}] {} (시도 {}회){}", show(check.prop("stage")), show(check.prop("name")), show(check.prop("attempts")), detail.map_or_else(String::new, |d| format!("\n{}", d.to_js_string())))
        })
        .collect();
    Ok(format!("\n\n워크플로 검사 실패:\n{}", lines.join("\n")))
}

/// 디자인 비교 실패 문구. 비율과 허용치, 비교한 크기를 함께 적는다
pub fn compare_detail(ratio: f64, max: f64, width: f64, height: f64) -> String {
    format!("디자인 차이 {}% (허용 {}%, 비교 {}×{})", js::to_fixed(ratio * 100.0, 1), js::to_fixed(max * 100.0, 1), js::number_to_string(width), js::number_to_string(height))
}

/// 동시 요청 확인의 기대를 사람이 읽는 한 줄로. `{ successCount?: { exactly?, atMost? }, allStatusIn?: number[] }`
pub fn describe_concurrency_expect(expect: &JsValue) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    let count = expect.prop("successCount");
    if let Some(exactly) = count.and_then(|c| c.prop("exactly")) {
        parts.push(format!("정확히 {}", exactly.to_js_string()));
    } else if let Some(at_most) = count.and_then(|c| c.prop("atMost")) {
        parts.push(format!("최대 {}", at_most.to_js_string()));
    }
    if let Some(all) = expect.prop("allStatusIn").filter(|v| v.truthy()) {
        let JsValue::Arr(items) = all else {
            return Err("allStatusIn은 배열이어야 합니다".to_owned());
        };
        parts.push(format!("상태 {}", items.iter().map(join_item).collect::<Vec<_>>().join("/")));
    }
    Ok(parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json::{self, JsObject};

    fn obj(pairs: Vec<(&str, JsValue)>) -> JsValue {
        let mut o = JsObject::new();
        for (k, v) in pairs {
            o.set(k, v);
        }
        JsValue::Obj(o)
    }

    #[test]
    fn 오류_표지는_상태가_404일_때만_없는_화면을_봐준다() {
        assert_eq!(next_error_marker("<h1>This page could not be found</h1>", 200.0), Some(NEXT_NOT_FOUND_MARKER));
        assert_eq!(next_error_marker("<h1>This page could not be found</h1>", 404.0), None);
        assert_eq!(next_error_marker("Unhandled Runtime Error", 404.0), Some("Unhandled Runtime Error"));
        assert_eq!(next_error_marker("This page could not be foun", 200.0), None);
        assert_eq!(next_error_marker("", f64::NAN), None);
        assert_eq!(next_error_marker("This page could not be found", f64::NAN), Some(NEXT_NOT_FOUND_MARKER));
    }

    /// Next.js 16.4.3에서 실제로 받은 응답(`tests/vectors/next16/README.md`)
    macro_rules! next16 {
        ($name:literal) => {
            (
                include_str!(concat!("../tests/vectors/next16/dev-", $name, ".html")),
                include_str!(concat!("../tests/vectors/next16/prod-", $name, ".html")),
            )
        };
    }

    #[test]
    fn next16_정상_응답은_스크립트_안에만_not_found_글자가_있어_화면_글자에서는_표지가_없다() {
        for (dev, prod) in [next16!("home"), next16!("ok"), next16!("order-1"), next16!("dyn"), next16!("sp"), next16!("cerr"), next16!("rd")] {
            for html in [dev, prod] {
                assert_eq!(next_error_marker(html, 200.0), Some(NEXT_NOT_FOUND_MARKER), "원문에는 있다(#1207의 오탐)");
                assert_eq!(next_error_marker(&strip_html(html), 200.0), None);
                assert_eq!(next_render_error_digest(html, 200.0), None);
            }
        }
    }

    #[test]
    fn next16_스트리밍_도중의_서버_오류는_digest로_잡는다() {
        let (dev, prod) = next16!("errs");
        assert_eq!(next_error_marker(&strip_html(dev), 200.0), None, "화면 글자에는 표지가 없다");
        assert_eq!(next_render_error_digest(dev, 200.0).as_deref(), Some("3772761063"));
        assert_eq!(next_render_error_digest(prod, 200.0).as_deref(), Some("3873002581"));
        let (dev, prod) = next16!("nfs");
        for html in [dev, prod] {
            assert_eq!(next_render_error_digest(html, 200.0).as_deref(), Some(NEXT_NOT_FOUND_DIGEST));
            assert_eq!(next_render_error_digest(html, 404.0), None);
        }
        // 상태 코드로 먼저 막히는 응답에도 신호는 있다
        for (dev, prod) in [next16!("err"), next16!("nf")] {
            assert!(next_render_error_digest(dev, 200.0).is_some());
            assert!(next_render_error_digest(prod, 200.0).is_some());
        }
    }

    #[test]
    fn next16_기본_404_화면은_화면_글자에서_표지를_찾는다() {
        let (dev, prod) = next16!("nope");
        for html in [dev, prod] {
            assert_eq!(next_error_marker(&strip_html(html), 200.0), Some(NEXT_NOT_FOUND_MARKER));
            assert_eq!(next_error_marker(&strip_html(html), 404.0), None);
        }
    }

    #[test]
    fn 렌더링_오류_digest_읽기의_경계() {
        // 넘기기는 오류가 아니다. 넘기기와 오류가 함께 있으면 오류를 돌려준다
        assert_eq!(next_render_error_digest(r#"$RX("B:0","NEXT_REDIRECT;replace;/ok;307;","x")"#, 200.0), None);
        assert_eq!(next_render_error_digest(r#"$RX("B:0","NEXT_REDIRECT;push;/a;307;")$RX("B:1","42")"#, 200.0).as_deref(), Some("42"));
        // digest를 읽지 못하면 빈 글자(오류로 본다)
        assert_eq!(next_render_error_digest(r#"$RX("B:0")"#, 200.0).as_deref(), Some(""));
        assert_eq!(next_render_error_digest(r#"$RX("B:0",null,"m")"#, 200.0).as_deref(), Some(""));
        assert_eq!(next_render_error_digest(r#"$RX("B:0"#, 200.0).as_deref(), Some(""));
        assert_eq!(next_render_error_digest(r#"$RX("B:0",""#, 200.0).as_deref(), Some(""));
        // 정의만 있으면 신호가 아니다
        assert_eq!(next_render_error_digest("$RX=function(b,c,d,e,f){}", 200.0), None);
        // RSC 오류 조각(스크립트 안 JS 글자)
        assert_eq!(next_render_error_digest(r#"push([1,"3c:E{\"digest\":\"99\",\"name\":\"Error\"}"])"#, 200.0).as_deref(), Some("99"));
        assert_eq!(next_render_error_digest(r#"E{\"digest\":\""#, 200.0).as_deref(), Some(""));
        assert_eq!(next_render_error_digest(r#"E{\"digest\":\"NEXT_HTTP_ERROR_FALLBACK;403\""#, 404.0).as_deref(), Some("NEXT_HTTP_ERROR_FALLBACK;403"));
        // 기대가 404가 아니면 notFound()는 오류다. NaN도 404가 아니다
        assert_eq!(next_render_error_digest(r#"$RX("B:0","NEXT_HTTP_ERROR_FALLBACK;404")"#, f64::NAN).as_deref(), Some(NEXT_NOT_FOUND_DIGEST));
        // 긴 digest는 80글자로 자른다(글자 단위)
        let long = format!(r#"$RX("B:0","{}")"#, "가".repeat(200));
        assert_eq!(next_render_error_digest(&long, 200.0).map(|d| d.chars().count()), Some(80));
        assert_eq!(next_render_error_digest("", 200.0), None);
    }

    #[test]
    fn 숫자는_원문과_천_단위_표기를_둘_다_인정한다() {
        assert!(contains_api_number("합계 12,000원", 12000.0));
        assert!(contains_api_number("합계 12000원", 12000.0));
        assert!(!contains_api_number("합계 12 000원", 12000.0));
        assert!(contains_api_number("1,234.568", 1234.5675));
        assert!(contains_api_number("-0", -0.0));
        assert!(!contains_api_number("x", f64::NAN) || "x".contains("NaN"));
        assert_eq!(to_locale_string_en_us(1e21), "1,000,000,000,000,000,000,000");
        assert_eq!(to_locale_string_en_us(-0.0001), "-0");
        assert_eq!(to_locale_string_en_us(0.0), "0");
        assert_eq!(to_locale_string_en_us(1.0005), "1.001");
        assert_eq!(to_locale_string_en_us(999.9995), "1,000");
        assert_eq!(to_locale_string_en_us(f64::NEG_INFINITY), "-∞");
    }

    #[test]
    fn 글자_값은_통째로_포함해야_한다() {
        assert!(contains_api_text("가격 1000원", "1000"));
        assert!(!contains_api_text("가격 1,000원", "1000"));
        assert!(!contains_api_text("abc", "ABC"));
    }

    #[test]
    fn 값이_없을_때의_문구는_숫자를_js_표기로_적는다() {
        assert_eq!(missing_api_value("api", "$.price", None, Some(1e21), "/p"), "api의 $.price 값 '1e+21'이 /p 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다");
        assert!(missing_api_value("api", "$.x", Some("a"), None, "/p").contains("값 'a'이"));
    }

    #[test]
    fn 보이지_않는_이유마다_문구가_다르다() {
        let find = |problem: Option<JsValue>| {
            let mut pairs = vec![("text", JsValue::str("확인"))];
            if let Some(p) = problem {
                pairs.push(("problem", p));
            }
            obj(pairs)
        };
        let kind = |k: &str| obj(vec![("kind", JsValue::str(k))]);
        assert!(viewport_problem_text_for(&find(None), 1280.0, 800.0).unwrap().ends_with("보이지 않는 이유를 알 수 없습니다(창 1280x800)"));
        assert!(viewport_problem_text_for(&find(Some(kind("absent"))), 1.0, 2.0).unwrap().contains("화면에 없습니다(창 1x2)"));
        let below = obj(vec![("kind", JsValue::str("below")), ("px", JsValue::Num(12.5))]);
        assert!(viewport_problem_text_for(&find(Some(below)), 1.0, 2.0).unwrap().contains("창 아래로 12.5px 넘칩니다"));
        assert!(viewport_problem_text_for(&find(Some(kind("nope"))), 1.0, 2.0).is_err());
    }

    #[test]
    fn 글자_짝짓기는_key로_한다() {
        let input = js_json::parse(r#"{"expected":[{"key":"a","text":"A"},{"key":"b","text":"B"},{"key":"c","text":"C"}],"report":{"width":1,"height":2,"findings":[{"key":"a","text":"A","visible":true},{"key":"b","text":"B","visible":false,"problem":{"kind":"hidden"}}]}}"#).unwrap();
        let out = viewport_problems(&input).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("숨겨져 있습니다"));
        assert_eq!(out[1], "'C'이 첫 화면에 보이는지 재지 못했습니다");
        let none = js_json::parse(r#"{"expected":[{"key":"a","text":"A"},{"key":"b","text":"B"}],"report":null}"#).unwrap();
        assert_eq!(viewport_problems(&none).unwrap(), vec!["'A', 'B'가 첫 화면에 보이는지 재지 못했습니다".to_owned()]);
    }

    #[test]
    fn 동적_세그먼트는_폴더_이름_전체가_대괄호_하나일_때만이다() {
        assert_eq!(dynamic_segments("app/orders/[id]/page.tsx"), vec![2]);
        assert_eq!(dynamic_segments("app/[a]/[b]/page.tsx"), vec![1, 2]);
        for not in ["[...slug]x", "[[id]]", "[]", "x[id]", "[id]x", "[a[b]", "[a]]"] {
            assert!(dynamic_segments(not).is_empty(), "{not}");
        }
        assert_eq!(dynamic_segments("[...slug]"), vec![0]);
    }

    #[test]
    fn 받아들인_값_문구와_사용_판정() {
        let params = vec![("id".to_owned(), "7".to_owned())];
        let keys = vec!["id".to_owned(), "x".to_owned()];
        let notes = accepted_notes("studio.yaml", &keys, &params, true, Some(("api", "/list")));
        assert_eq!(notes[0], "studio.yaml의 autoPageChecks.sampleParams(id=7, x=undefined)를 이번 실행에서 바로 반영했습니다");
        assert_eq!(notes[1], "studio.yaml의 autoPageChecks.sampleIdFrom(api /list)을 이번 실행에서 바로 반영했습니다");
        assert!(accepted_notes("s", &[], &params, true, None).is_empty());
        assert!(uses_in_run_value("app/[id]/page.tsx", &["id".to_owned()], false, 0));
        assert!(!uses_in_run_value("app/[id]/page.tsx", &["ID".to_owned()], false, 0));
        assert!(uses_in_run_value("app/page.tsx", &[], true, 1));
        assert!(!uses_in_run_value("app/page.tsx", &[], true, 0));
    }

    #[test]
    fn 쓴_값_목록은_이름마다_센다() {
        let params = vec![("id".to_owned(), "7".to_owned()), ("empty".to_owned(), String::new())];
        assert_eq!(sampled_values("app/[id]/[...id]/[empty]/page.tsx", &params).as_deref(), Some("id=7, id=7"));
        assert_eq!(sampled_values("app/[other]/page.tsx", &params), None);
        assert_eq!(sampled_values("app/[constructor]/page.tsx", &params), None);
        assert_eq!(sampled_values("app/[[id]]/page.tsx", &params).as_deref(), Some("id=7"));
    }

    #[test]
    fn html에서_태그와_스크립트를_걷어낸다() {
        assert_eq!(strip_html("<div>안녕</div>  <b>x</b>"), "안녕\n \nx");
        assert_eq!(strip_html("a<SCRIPT>if (a<b) {}</ScRiPt>b"), "a b");
        assert_eq!(strip_html("a<script>never closed"), "a\nnever closed");
        assert_eq!(strip_html("a<style>x</style>b<STYLE>y</style >"), "a b\ny");
        assert_eq!(strip_html("1 < 2"), "1 < 2");
        assert_eq!(strip_html("\u{FEFF} x \t\t y \u{FEFF}"), "x y");
    }

    #[test]
    fn 실패한_검사_목록과_비교_문구() {
        let checks = js_json::parse(r#"[{"stage":"test","name":"단위","attempts":2,"detail":"실패"},{"stage":"review","name":"리뷰","attempts":1}]"#).unwrap();
        assert_eq!(format_failed_checks(&checks).unwrap(), "\n\n워크플로 검사 실패:\n- [test] 단위 (시도 2회)\n실패\n- [review] 리뷰 (시도 1회)");
        assert_eq!(format_failed_checks(&JsValue::Arr(vec![])).unwrap(), "");
        assert_eq!(compare_detail(0.1234, 0.05, 1280.0, 800.0), "디자인 차이 12.3% (허용 5.0%, 비교 1280×800)");
    }

    #[test]
    fn 동시_요청_기대_문구() {
        let expect = js_json::parse(r#"{"successCount":{"exactly":1},"allStatusIn":[200,409]}"#).unwrap();
        assert_eq!(describe_concurrency_expect(&expect).unwrap(), "정확히 1, 상태 200/409");
        let expect = js_json::parse(r#"{"successCount":{"atMost":0},"allStatusIn":[]}"#).unwrap();
        assert_eq!(describe_concurrency_expect(&expect).unwrap(), "최대 0, 상태 ");
        assert_eq!(describe_concurrency_expect(&js_json::parse("{}").unwrap()).unwrap(), "");
    }
}

// ── readJsonPath(ADR-195 4f A5b-2) ─────────────────────────────────────────

/// `readJsonPath`가 읽은 값. JS는 객체·배열에 없는 키를 읽으면 `Object.prototype`·`Array.prototype`에서 상속한 값을 돌려준다.
/// 상속한 것 가운데 함수는 `JSON.stringify`가 `undefined`로 쓰고 `typeof`가 `'function'`이라 다음 걸음이 모두 `undefined`다(여기서는 `Undefined`와 같다).
/// 함수가 아닌 것은 `__proto__`뿐이다: 객체에서는 `Object.prototype`(`{}`), 배열에서는 `Array.prototype`(`[]`), `Object.prototype.__proto__`는 `null`, `Array.prototype`의 `length`는 0이다.
#[derive(Clone, Debug, PartialEq)]
pub enum PathValue {
    Undefined,
    Value(JsValue),
    ObjectProto,
    ArrayProto,
}

/// JSON이 이 읽기가 지원하는 깊이를 넘었다(JS는 읽는다: 모른다는 뜻이다)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TooDeep;

impl PathValue {
    /// `JSON.stringify(actual)`, `undefined`면 `undefined`라는 글자(템플릿 문자열의 `${…}`). 짝 없는 서로게이트는 JS처럼 `\udXXX`로 쓴다.
    /// 글자는 `encodeLoneSurrogates`한 꼴로 받고 돌려준다(예약 글자는 그대로 두고, 짝 없는 서로게이트만 ASCII 이스케이프가 된다)
    pub fn display(&self) -> String {
        match self {
            PathValue::Undefined => "undefined".to_owned(),
            PathValue::Value(value) => json_text(value),
            PathValue::ObjectProto => "{}".to_owned(),
            PathValue::ArrayProto => "[]".to_owned(),
        }
    }

    /// `actual === expected`. 객체·배열·`undefined`는 어떤 기대와도 다르다
    pub fn strict_equals(&self, expected: &JsValue) -> bool {
        matches!(self, PathValue::Value(value) if value.strict_equals(expected))
    }
}

/// `JSON.stringify(value)`: `js_json::stringify`에 짝 없는 서로게이트 이스케이프(`\ud800`, 소문자 16진)를 더한다
pub fn json_text(value: &JsValue) -> String {
    let encoded = crate::js_json::stringify(value);
    let chars: Vec<char> = encoded.chars().collect();
    let mut out = String::with_capacity(encoded.len());
    let mut i = 0;
    while i < chars.len() {
        match js::read_lone_escape(&chars, i) {
            Some((Err(unit), used)) => {
                out.push_str(&format!("\\u{unit:04x}"));
                i += used;
            }
            Some((Ok(_), used)) => {
                out.extend(&chars[i..i + used]);
                i += used;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

static NULL: JsValue = JsValue::Null;

#[derive(Clone, Copy)]
enum Cur<'a> {
    Json(&'a JsValue),
    Len(usize),
    ObjectProto,
    ArrayProto,
    Undefined,
}

/// `value[key]`(`typeof value === 'object'`이고 null이 아닐 때만 부른다)
fn read_key<'a>(cur: Cur<'a>, key: &str) -> Cur<'a> {
    match cur {
        Cur::Json(JsValue::Obj(object)) => match object.get(key) {
            Some(value) => Cur::Json(value),
            None if key == "__proto__" => Cur::ObjectProto,
            None => Cur::Undefined,
        },
        Cur::Json(JsValue::Arr(items)) => match crate::js_json::array_index(key) {
            Some(index) => items.get(index as usize).map_or(Cur::Undefined, Cur::Json),
            None if key == "length" => Cur::Len(items.len()),
            None if key == "__proto__" => Cur::ArrayProto,
            None => Cur::Undefined,
        },
        Cur::ObjectProto if key == "__proto__" => Cur::Json(&NULL),
        Cur::ArrayProto if key == "length" => Cur::Len(0),
        Cur::ArrayProto if key == "__proto__" => Cur::ObjectProto,
        _ => Cur::Undefined,
    }
}

/// `typeof value === 'object' && value !== null`
fn is_object(cur: Cur) -> bool {
    matches!(cur, Cur::Json(JsValue::Obj(_)) | Cur::Json(JsValue::Arr(_)) | Cur::ObjectProto | Cur::ArrayProto)
}

/// `^([^[\]]*)((?:\[\d+\])*)$`: 키와 대괄호 숫자들. 안 맞으면 `None`
fn split_segment(segment: &str) -> Option<(&str, Vec<&str>)> {
    let at = segment.find(['[', ']']).unwrap_or(segment.len());
    let (key, mut rest) = segment.split_at(at);
    let mut indexes = Vec::new();
    while !rest.is_empty() {
        let inner = rest.strip_prefix('[')?;
        let digits = inner.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let after = inner[digits..].strip_prefix(']')?;
        indexes.push(&inner[..digits]);
        rest = after;
    }
    Some((key, indexes))
}

/// 응답 JSON에서 값을 꺼낸다(옛 `readJsonPath`, `gate.ts`). `$.a.b`와 `$[0].a`, `$.items[0].qty` 정도만 지원하고 그 밖은 `Undefined`다.
/// JSON.parse가 던지면 `Undefined`다. 글자는 `encodeLoneSurrogates`한 꼴이다.
///
/// 의도한 차이: 중첩이 `js_json`이 읽는 깊이를 넘으면 `Err(TooDeep)`이다(JS는 읽는다). 부르는 쪽은 통과로 세지 않는다.
pub fn read_json_path(text: &str, json_path: &str) -> Result<PathValue, TooDeep> {
    let document = match crate::js_json::parse_lone_encoded(text) {
        Ok(value) => value,
        Err(crate::js_json::LoneParseError::Invalid) => return Ok(PathValue::Undefined),
        Err(crate::js_json::LoneParseError::TooDeep) => return Err(TooDeep),
    };
    // `jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean)`
    let stripped = json_path.strip_prefix('$').map_or(json_path, |rest| rest.strip_prefix('.').unwrap_or(rest));
    let mut cur = Cur::Json(&document);
    for segment in stripped.split('.').filter(|segment| !segment.is_empty()) {
        let Some((key, indexes)) = split_segment(segment) else { return Ok(PathValue::Undefined) };
        if !key.is_empty() {
            if !is_object(cur) {
                return Ok(PathValue::Undefined);
            }
            cur = read_key(cur, key);
        }
        for digits in indexes {
            // `Array.isArray(value)`: 배열과 `Array.prototype`. `value[Number(digits)]`
            cur = match cur {
                Cur::Json(JsValue::Arr(items)) => {
                    let index: f64 = digits.parse().unwrap_or(f64::INFINITY);
                    if index < items.len() as f64 { items.get(index as usize).map_or(Cur::Undefined, Cur::Json) } else { Cur::Undefined }
                }
                _ => Cur::Undefined,
            };
        }
    }
    Ok(match cur {
        Cur::Json(value) => PathValue::Value(value.clone()),
        Cur::Len(len) => PathValue::Value(JsValue::Num(len as f64)),
        Cur::ObjectProto => PathValue::ObjectProto,
        Cur::ArrayProto => PathValue::ArrayProto,
        Cur::Undefined => PathValue::Undefined,
    })
}

#[cfg(test)]
mod json_path_tests {
    use super::*;

    fn read(text: &str, path: &str) -> String {
        read_json_path(text, path).expect("깊이 안").display()
    }

    #[test]
    fn 경로를_js처럼_읽는다() {
        assert_eq!(read(r#"{"a":{"b":[10,{"c":"d"}]}}"#, "$.a.b[1].c"), r#""d""#);
        assert_eq!(read(r#"{"items":[5,6,7]}"#, "$.items.length"), "3");
        assert_eq!(read(r#"{"items":[5,6,7]}"#, "$.items.1"), "6");
        assert_eq!(read(r#"{"items":[5,6,7]}"#, "$.items.01"), "undefined");
        assert_eq!(read(r#"[10,20]"#, "$[1]"), "20");
        assert_eq!(read(r#"{"a":1}"#, "a"), "1");
        assert_eq!(read(r#"{"a":1}"#, "$"), r#"{"a":1}"#);
        assert_eq!(read(r#"{"a":1,"a":2}"#, "$.a"), "2");
        assert_eq!(read(r#"{"a":-0}"#, "$.a"), "0");
        assert_eq!(read(r#"{"a":9007199254740993}"#, "$.a"), "9007199254740992");
        assert_eq!(read("not json", "$"), "undefined");
        assert_eq!(read(r#"{"a":[1]}"#, "$.a[99999999999999999999]"), "undefined");
        assert_eq!(read(r#"{"a":[1]}"#, "$.a[0]x"), "undefined");
    }

    #[test]
    fn 없는_키는_prototype에서_상속한_값으로_읽는다() {
        assert_eq!(read(r#"{"a":{}}"#, "$.a.constructor"), "undefined");
        assert_eq!(read(r#"{"a":{}}"#, "$.a.__proto__"), "{}");
        assert_eq!(read(r#"{"a":{}}"#, "$.a.__proto__.__proto__"), "null");
        assert_eq!(read(r#"{"a":{}}"#, "$.a.__proto__.__proto__.x"), "undefined");
        assert_eq!(read(r#"{"a":[]}"#, "$.a.__proto__"), "[]");
        assert_eq!(read(r#"{"a":[]}"#, "$.a.__proto__.length"), "0");
        assert_eq!(read(r#"{"a":{"__proto__":7}}"#, "$.a.__proto__"), "7");
        assert_eq!(read(r#"{"a":{"constructor":6}}"#, "$.a.constructor"), "6");
    }

    #[test]
    fn 값이_같은지는_엄격하게_본다() {
        let value = read_json_path(r#"{"a":0,"b":"0","c":[1]}"#, "$.a").unwrap();
        assert!(value.strict_equals(&JsValue::Num(0.0)) && value.strict_equals(&JsValue::Num(-0.0)));
        assert!(!value.strict_equals(&JsValue::Str("0".into())));
        assert!(!read_json_path(r#"{"a":[1]}"#, "$.a").unwrap().strict_equals(&JsValue::Num(1.0)));
        assert!(!read_json_path(r#"{"a":1}"#, "$.b").unwrap().strict_equals(&JsValue::Num(1.0)));
    }

    #[test]
    fn 짝_없는_서로게이트는_ascii_이스케이프로_쓴다() {
        // U+D800 = 0xD000 | (8 << 8) | (0 << 4) | 0
        assert_eq!(json_text(&JsValue::Str("\u{E010}\u{E008}\u{E000}\u{E000}".into())), "\"\\ud800\"");
        assert_eq!(json_text(&JsValue::Str("\u{E011}\u{E000}\u{E001}".into())), "\"\u{E011}\u{E000}\u{E001}\"");
    }

    #[test]
    fn 너무_깊은_json은_모른다고_답한다() {
        let deep = format!("{}1{}", "[".repeat(2500), "]".repeat(2500));
        assert_eq!(read_json_path(&deep, "$"), Err(TooDeep));
    }
}
