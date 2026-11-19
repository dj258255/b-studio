//! 워크플로·화면 확인·동시 요청·부하 확인 스키마.

use super::*;
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

pub fn validate(name: &str, input: Option<&JsValue>) -> Outcome {
    match name {
        "WorkflowStageSchema" => validate_enum(
            input,
            &["plan", "implement", "run", "browser_check", "contract_check", "test", "concurrency_check", "load_check", "review", "checkpoint"],
        ),
        "WorkflowTestSchema" => workflow_test(input),
        "ConcurrencyExpectSchema" => concurrency_expect(input),
        "WorkflowConcurrencyCheckSchema" => concurrency_check(input),
        "LoadExpectSchema" => load_expect(input),
        "WorkflowLoadCheckSchema" => load_check(input),
        "WorkflowPageStepSchema" => page_step(input),
        "CompareMaskSchema" => compare_mask(input),
        "WorkflowPageCompareSchema" => page_compare(input),
        "WorkflowPageExpectFromApiSchema" => expect_from_api(input),
        "WorkflowPageCheckSchema" => page_check(input),
        "AutoPageChecksSchema" => auto_page_checks(input),
        "WorkflowSchema" => workflow(input),
        other => Outcome::failed(input.cloned(), issue(Vec::new(), format!("알 수 없는 스키마입니다: {other}"), true)),
    }
}

fn name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[a-z][a-z0-9-]*$"))
}
fn safe_segment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[A-Za-z0-9_-]{1,64}$"))
}
fn ascii_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[\\x21-\\x7e]+$"))
}
fn ascii_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[\\x20-\\x7e]+$"))
}

fn name_string(input: Option<&JsValue>) -> Outcome {
    string(input, |value, issues| {
        if !name_re().is_match(value) {
            issues.push(issue(Vec::new(), "Invalid string: must match pattern /^[a-z][a-z0-9-]*$/", false));
        }
    })
}

fn plain_string(input: Option<&JsValue>) -> Outcome {
    match input {
        Some(JsValue::Str(value)) => Outcome::ok(JsValue::Str(value.clone())),
        _ => Outcome::failed(None, invalid_type(input, "string")),
    }
}

fn string(input: Option<&JsValue>, mut check: impl FnMut(&str, &mut Vec<Issue>)) -> Outcome {
    validate_string(input, &[], &mut |input, issues| {
        if let Some(JsValue::Str(value)) = input {
            check(value, issues);
        }
    })
}

fn service_path(input: Option<&JsValue>) -> Outcome {
    string(input, |value, issues| {
        if !value.starts_with('/') || value.starts_with("//") {
            issues.push(issue(Vec::new(), "\"/\"로 시작하고 \"//\"로 시작하지 않는 경로여야 합니다", false));
        }
    })
}

fn relative_path(input: Option<&JsValue>) -> Outcome {
    validate_string(input, &[LengthCheck::Min(1, None)], &mut |input, issues| {
        if let Some(JsValue::Str(value)) = input {
            let bytes = value.as_bytes();
            let drive_absolute = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'/' || bytes[2] == b'\\');
            if drive_absolute || value.starts_with('/') || value.starts_with('\\') || value.split(['/', '\\']).any(|segment| segment == "..") {
                issues.push(issue(Vec::new(), "서비스 폴더 안의 상대 경로여야 합니다", false));
            }
        }
    })
}

fn boolean(input: Option<&JsValue>) -> Outcome {
    match input {
        Some(JsValue::Bool(value)) => Outcome::ok(JsValue::Bool(*value)),
        _ => Outcome::failed(input.cloned(), invalid_type(input, "boolean")),
    }
}

fn int_min_max(input: Option<&JsValue>, min: f64, max: f64) -> Outcome {
    validate_number(input, &[NumberCheck::Int, NumberCheck::Min(min, true), NumberCheck::Max(max, true)])
}

fn int_min(input: Option<&JsValue>, min: f64) -> Outcome {
    validate_number(input, &[NumberCheck::Int, NumberCheck::Min(min, true)])
}

fn int_positive(input: Option<&JsValue>) -> Outcome {
    validate_number(input, &[NumberCheck::Int, NumberCheck::Positive])
}

// ───────────────────────── 워크플로 ─────────────────────────

pub fn workflow_test(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("name", name_string(obj.field("name")));
    obj.set("service", name_string(obj.field("service")));
    obj.set("command", validate_array(obj.field("command"), |item| validate_string(item, &[LengthCheck::Min(1, None)], &mut |_, _| {}), &[LengthCheck::Min(1, None)]));
    obj.set("maxAttempts", defaulted(obj.field("maxAttempts"), || JsValue::Num(1.0), |value| int_min_max(value, 1.0, 3.0)));
    obj.finish()
}

fn success_count(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    if obj.field("exactly").is_some() {
        let value = obj.field("exactly").cloned();
        obj.set("exactly", int_min(value.as_ref(), 0.0));
    }
    if obj.field("atMost").is_some() {
        let value = obj.field("atMost").cloned();
        obj.set("atMost", int_min(value.as_ref(), 0.0));
    }
    obj.run_checks(&mut |parsed, issues| {
        if parsed.get("exactly").is_none() && parsed.get("atMost").is_none() {
            issues.push(issue(Vec::new(), "successCount에는 exactly나 atMost 중 하나가 필요합니다", false));
        }
    });
    obj.finish()
}

pub fn concurrency_expect(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    if obj.field("successCount").is_some() {
        let value = obj.field("successCount").cloned();
        obj.set("successCount", success_count(value.as_ref()));
    }
    if obj.field("allStatusIn").is_some() {
        let value = obj.field("allStatusIn").cloned();
        obj.set("allStatusIn", validate_array(value.as_ref(), |item| int_min_max(item, 100.0, 599.0), &[LengthCheck::Min(1, None)]));
    }
    if obj.field("then").is_some() {
        let value = obj.field("then").cloned();
        obj.set("then", then_schema(value.as_ref()));
    }
    obj.run_checks(&mut |parsed, issues| {
        if parsed.get("successCount").is_none() && parsed.get("allStatusIn").is_none() && parsed.get("then").is_none() {
            issues.push(issue(Vec::new(), "expect에는 successCount·allStatusIn·then 중 하나가 필요합니다", false));
        }
    });
    obj.finish()
}

fn then_schema(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("method", validate_literal(obj.field("method"), JsValue::Str("GET".into())));
    obj.set("path", service_path(obj.field("path")));
    obj.set("jsonPath", validate_string(obj.field("jsonPath"), &[LengthCheck::Min(1, None)], &mut |_, _| {}));
    obj.set("equals", validate_union(obj.field("equals"), &[number_plain, plain_string]));
    obj.finish()
}

fn number_plain(input: Option<&JsValue>) -> Outcome {
    match input {
        Some(JsValue::Num(value)) if value.is_finite() => Outcome::ok(JsValue::Num(*value)),
        _ => Outcome::failed(None, invalid_type(input, "number")),
    }
}

fn header_record(input: Option<&JsValue>) -> Outcome {
    validate_record(input, |key| header_name().is_match(key), |item| validate_string(item, &[LengthCheck::Min(1, None)], &mut |_, _| {}))
}

fn header_name() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[A-Za-z0-9-]+$"))
}

fn check_headers(record: &JsValue, issues: &mut Vec<Issue>, ascii_values: bool) {
    let JsValue::Obj(object) = record else { return };
    if object.entries().len() > 5 {
        issues.push(issue(Vec::new(), "headers는 최대 5개까지 쓸 수 있습니다", false));
    }
    let credential_headers = ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"];
    if object.entries().iter().any(|(name, _)| credential_headers.contains(&name.to_lowercase().as_str())) {
        issues.push(issue(
            Vec::new(),
            "비밀 값을 담는 인증 헤더는 쓸 수 없습니다. 인증이 필요하면 서비스가 secrets의 환경 변수를 읽게 하세요",
            false,
        ));
    }
    if ascii_values
        && object
            .entries()
            .iter()
            .any(|(_, value)| !matches!(value, JsValue::Str(text) if ascii_header_re().is_match(text)))
    {
        issues.push(issue(Vec::new(), "headers 값에는 줄바꿈·제어 문자·비ASCII 문자를 쓸 수 없습니다", false));
    }
}

pub fn concurrency_check(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("name", name_string(obj.field("name")));
    obj.set("service", name_string(obj.field("service")));
    obj.set("method", validate_enum(obj.field("method"), &["POST", "PUT", "PATCH", "DELETE", "GET"]));
    obj.set("path", service_path(obj.field("path")));
    if obj.field("body").is_some() {
        let value = obj.field("body").cloned();
        obj.set("body", validate_string(value.as_ref(), &[LengthCheck::Max(8192, Some("body는 8192자 이하여야 합니다"))], &mut |_, _| {}));
    }
    if obj.field("headers").is_some() {
        let value = obj.field("headers").cloned();
        let mut result = header_record(value.as_ref());
        if !result.has_fatal() {
            if let Some(record) = &result.value {
                check_headers(record, &mut result.issues, false);
            }
        }
        obj.set("headers", result);
    }
    obj.set("concurrent", int_min_max(obj.field("concurrent"), 2.0, 20.0));
    obj.set("expect", concurrency_expect(obj.field("expect")));
    obj.finish()
}

pub fn load_expect(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    for key in ["p50Ms", "p95Ms", "p99Ms", "maxMs"] {
        if obj.field(key).is_some() {
            let value = obj.field(key).cloned();
            obj.set(key, validate_number(value.as_ref(), &[NumberCheck::Positive]));
        }
    }
    if obj.field("latencyOf").is_some() {
        let value = obj.field("latencyOf").cloned();
        obj.set("latencyOf", validate_array(value.as_ref(), |item| int_min_max(item, 100.0, 599.0), &[LengthCheck::Min(1, None)]));
    }
    if obj.field("successCount").is_some() {
        let value = obj.field("successCount").cloned();
        obj.set("successCount", success_count(value.as_ref()));
    }
    if obj.field("allStatusIn").is_some() {
        let value = obj.field("allStatusIn").cloned();
        obj.set("allStatusIn", validate_array(value.as_ref(), |item| int_min_max(item, 100.0, 599.0), &[LengthCheck::Min(1, None)]));
    }
    obj.run_checks(&mut |parsed, issues| {
        if parsed.get("p50Ms").is_none() && parsed.get("p95Ms").is_none() && parsed.get("p99Ms").is_none() && parsed.get("maxMs").is_none() {
            issues.push(issue(
                Vec::new(),
                "expect에는 응답 시간 기준(p50Ms·p95Ms·p99Ms·maxMs) 중 하나가 필요합니다. 건수만 볼 것이면 concurrencyChecks를 쓰세요",
                false,
            ));
        }
    });
    obj.finish()
}

pub fn load_check(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("name", name_string(obj.field("name")));
    obj.set("service", name_string(obj.field("service")));
    obj.set("method", validate_enum(obj.field("method"), &["POST", "PUT", "PATCH", "DELETE", "GET"]));
    obj.set("path", service_path(obj.field("path")));
    if obj.field("body").is_some() {
        let value = obj.field("body").cloned();
        obj.set("body", validate_string(value.as_ref(), &[LengthCheck::Max(8192, Some("body는 8192자 이하여야 합니다"))], &mut |_, _| {}));
    }
    if obj.field("headers").is_some() {
        let value = obj.field("headers").cloned();
        let mut result = header_record(value.as_ref());
        if !result.has_fatal() {
            if let Some(record) = &result.value {
                check_headers(record, &mut result.issues, true);
            }
        }
        obj.set("headers", result);
    }
    obj.set("concurrent", int_min_max(obj.field("concurrent"), 1.0, 1000.0));
    if obj.field("requests").is_some() {
        let value = obj.field("requests").cloned();
        obj.set("requests", int_min_max(value.as_ref(), 1.0, 10000.0));
    }
    obj.set("warmup", defaulted(obj.field("warmup"), || JsValue::Num(0.0), |value| int_min_max(value, 0.0, 1000.0)));
    obj.set("expect", load_expect(obj.field("expect")));
    obj.run_checks(&mut |parsed, issues| {
        if let (Some(JsValue::Num(requests)), Some(JsValue::Num(concurrent))) = (parsed.get("requests"), parsed.get("concurrent")) {
            if requests < concurrent {
                issues.push(issue(vec![Seg::Key("requests".into())], "requests는 concurrent 이상이어야 합니다", false));
            }
        }
        if let Some(JsValue::Str(path)) = parsed.get("path") {
            if !ascii_path_re().is_match(path) {
                issues.push(issue(
                    vec![Seg::Key("path".into())],
                    "path에는 공백·줄바꿈·비ASCII 문자를 쓸 수 없습니다(퍼센트 인코딩해서 적으세요)",
                    false,
                ));
            }
        }
    });
    obj.finish()
}

pub fn page_step(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    if obj.field("click").is_some() {
        let value = obj.field("click").cloned();
        obj.set("click", validate_string(value.as_ref(), &[LengthCheck::Min(1, None)], &mut |_, _| {}));
    }
    if obj.field("fill").is_some() {
        let value = obj.field("fill").cloned();
        obj.set("fill", fill_schema(value.as_ref()));
    }
    if obj.field("press").is_some() {
        let value = obj.field("press").cloned();
        obj.set("press", validate_string(value.as_ref(), &[LengthCheck::Min(1, None)], &mut |_, _| {}));
    }
    if obj.field("waitFor").is_some() {
        let value = obj.field("waitFor").cloned();
        obj.set("waitFor", validate_string(value.as_ref(), &[LengthCheck::Min(1, None)], &mut |_, _| {}));
    }
    obj.run_checks(&mut |parsed, issues| {
        let count = ["click", "fill", "press", "waitFor"].iter().filter(|key| parsed.get(key).is_some()).count();
        if count != 1 {
            issues.push(issue(Vec::new(), "단계에는 click, fill, press, waitFor 중 정확히 하나를 적어야 합니다", false));
        }
    });
    obj.finish()
}

fn fill_schema(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("selector", validate_string(obj.field("selector"), &[LengthCheck::Min(1, None)], &mut |_, _| {}));
    obj.set("text", validate_string(obj.field("text"), &[], &mut |_, _| {}));
    obj.finish()
}

pub fn compare_mask(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("x", int_min(obj.field("x"), 0.0));
    obj.set("y", int_min(obj.field("y"), 0.0));
    obj.set("width", int_min(obj.field("width"), 1.0));
    obj.set("height", int_min(obj.field("height"), 1.0));
    obj.finish()
}

pub fn page_compare(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("reference", relative_path(obj.field("reference")));
    obj.set("maxDiffRatio", validate_number(obj.field("maxDiffRatio"), &[NumberCheck::Min(0.0, true), NumberCheck::Max(1.0, true)]));
    if obj.field("masks").is_some() {
        let value = obj.field("masks").cloned();
        obj.set(
            "masks",
            validate_array(value.as_ref(), |item| compare_mask(item), &[LengthCheck::Max(20, Some("masks는 최대 20개까지 쓸 수 있습니다"))]),
        );
    }
    obj.set("threshold", defaulted(obj.field("threshold"), || JsValue::Num(0.1), |value| validate_number(value, &[NumberCheck::Min(0.0, true), NumberCheck::Max(1.0, true)])));
    // reference가 .png인지 확인하는 refine은 상대 경로 검사 뒤에 붙는다
    obj.run_checks(&mut |parsed, issues| {
        if let Some(JsValue::Str(reference)) = parsed.get("reference") {
            if !reference.to_lowercase().ends_with(".png") {
                issues.push(issue(vec![Seg::Key("reference".into())], "reference는 .png 파일이어야 합니다", false));
            }
        }
    });
    obj.finish()
}

pub fn expect_from_api(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("service", name_string(obj.field("service")));
    obj.set("path", service_path(obj.field("path")));
    obj.set("jsonPath", validate_string(obj.field("jsonPath"), &[LengthCheck::Min(1, None)], &mut |_, _| {}));
    obj.finish()
}

fn presets(value: &str) -> Option<(f64, f64)> {
    match value {
        "mobile" => Some((375.0, 812.0)),
        "tablet" => Some((768.0, 1024.0)),
        "desktop" => Some((1280.0, 800.0)),
        _ => None,
    }
}

fn viewport_preset(input: Option<&JsValue>) -> Outcome {
    validate_enum(input, &["mobile", "tablet", "desktop"])
}

fn viewport_object(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("width", int_min_max(obj.field("width"), 240.0, 3840.0));
    obj.set("height", int_min_max(obj.field("height"), 240.0, 3840.0));
    obj.finish()
}

fn viewport(input: Option<&JsValue>) -> Outcome {
    let result = validate_union(input, &[viewport_preset, viewport_object]);
    if !result.issues.is_empty() {
        return result;
    }
    match &result.value {
        Some(JsValue::Str(name)) => match presets(name) {
            Some((width, height)) => {
                let mut out = JsObject::new();
                out.set("width", JsValue::Num(width));
                out.set("height", JsValue::Num(height));
                Outcome::ok(JsValue::Obj(out))
            }
            None => result,
        },
        _ => result,
    }
}

pub fn page_check(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("service", name_string(obj.field("service")));
    obj.set("path", service_path(obj.field("path")));
    obj.set("mode", defaulted(obj.field("mode"), || JsValue::Str("http".into()), |value| validate_enum(value, &["http", "browser"])));
    obj.set("expectStatus", defaulted(obj.field("expectStatus"), || JsValue::Num(200.0), |value| int_min_max(value, 100.0, 599.0)));
    if obj.field("expectText").is_some() {
        let value = obj.field("expectText").cloned();
        obj.set("expectText", validate_string(value.as_ref(), &[LengthCheck::Min(1, None)], &mut |_, _| {}));
    }
    for key in ["expectAnyText", "expectAllText", "expectInViewport"] {
        if obj.field(key).is_some() {
            let value = obj.field(key).cloned();
            let custom = match key {
                "expectAnyText" => "expectAnyText는 최대 5개까지 쓸 수 있습니다",
                "expectAllText" => "expectAllText는 최대 5개까지 쓸 수 있습니다",
                _ => "expectInViewport는 최대 5개까지 쓸 수 있습니다",
            };
            obj.set(
                key,
                validate_array(
                    value.as_ref(),
                    |item| validate_string(item, &[LengthCheck::Min(1, None)], &mut |_, _| {}),
                    &[LengthCheck::Min(1, None), LengthCheck::Max(5, Some(custom))],
                ),
            );
        }
    }
    if obj.field("expectFromApi").is_some() {
        let value = obj.field("expectFromApi").cloned();
        obj.set("expectFromApi", expect_from_api(value.as_ref()));
    }
    if obj.field("steps").is_some() {
        let value = obj.field("steps").cloned();
        obj.set("steps", validate_array(value.as_ref(), |item| page_step(item), &[LengthCheck::Max(10, Some("단계는 최대 10개까지 쓸 수 있습니다"))]));
    }
    if obj.field("viewport").is_some() {
        let value = obj.field("viewport").cloned();
        obj.set("viewport", viewport(value.as_ref()));
    }
    obj.set("allowConsoleErrors", defaulted(obj.field("allowConsoleErrors"), || JsValue::Bool(false), |value| boolean(value)));
    obj.set("noHorizontalScroll", defaulted(obj.field("noHorizontalScroll"), || JsValue::Bool(false), |value| boolean(value)));
    if obj.field("maxLoadMs").is_some() {
        let value = obj.field("maxLoadMs").cloned();
        obj.set("maxLoadMs", int_positive(value.as_ref()));
    }
    if obj.field("compare").is_some() {
        let value = obj.field("compare").cloned();
        obj.set("compare", page_compare(value.as_ref()));
    }
    if obj.field("allowLoadingPlaceholder").is_some() {
        let value = obj.field("allowLoadingPlaceholder").cloned();
        obj.set("allowLoadingPlaceholder", boolean(value.as_ref()));
    }
    if obj.field("fallbackProbe").is_some() {
        let value = obj.field("fallbackProbe").cloned();
        obj.set("fallbackProbe", fallback_probe(value.as_ref()));
    }
    obj.run_checks(&mut |parsed, issues| {
        if matches!(parsed.get("mode"), Some(JsValue::Str(mode)) if mode == "browser") {
            return;
        }
        for key in ["steps", "viewport", "expectInViewport"] {
            if parsed.get(key).is_some() {
                issues.push(issue(vec![Seg::Key(key.into())], format!("{key}는 mode: browser에서만 쓸 수 있습니다"), false));
            }
        }
        if matches!(parsed.get("noHorizontalScroll"), Some(JsValue::Bool(true))) {
            issues.push(issue(vec![Seg::Key("noHorizontalScroll".into())], "noHorizontalScroll은 mode: browser에서만 쓸 수 있습니다", false));
        }
        if matches!(parsed.get("allowConsoleErrors"), Some(JsValue::Bool(true))) {
            issues.push(issue(vec![Seg::Key("allowConsoleErrors".into())], "allowConsoleErrors는 mode: browser에서만 쓸 수 있습니다", false));
        }
        if parsed.get("maxLoadMs").is_some() {
            issues.push(issue(vec![Seg::Key("maxLoadMs".into())], "maxLoadMs는 mode: browser에서만 쓸 수 있습니다", false));
        }
        if parsed.get("compare").is_some() {
            issues.push(issue(vec![Seg::Key("compare".into())], "compare는 mode: browser에서만 쓸 수 있습니다", false));
        }
        if parsed.get("allowLoadingPlaceholder").is_some() {
            issues.push(issue(vec![Seg::Key("allowLoadingPlaceholder".into())], "allowLoadingPlaceholder는 mode: browser에서만 쓸 수 있습니다", false));
        }
        if parsed.get("fallbackProbe").is_some() {
            issues.push(issue(vec![Seg::Key("fallbackProbe".into())], "fallbackProbe는 mode: browser에서만 쓸 수 있습니다", false));
        }
    });
    obj.finish()
}

fn fallback_probe(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("service", name_string(obj.field("service")));
    obj.set("path", service_path(obj.field("path")));
    obj.finish()
}

pub fn auto_page_checks(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("service", name_string(obj.field("service")));
    obj.set("mode", defaulted(obj.field("mode"), || JsValue::Str("http".into()), |value| validate_enum(value, &["http", "browser"])));
    obj.set("expectStatus", defaulted(obj.field("expectStatus"), || JsValue::Num(200.0), |value| int_min_max(value, 100.0, 599.0)));
    obj.set(
        "maxPages",
        defaulted(obj.field("maxPages"), || JsValue::Num(5.0), |value| {
            validate_number(value, &[NumberCheck::Int, NumberCheck::Min(1.0, true), NumberCheck::MaxMessage(10.0, "maxPages는 최대 10개까지 쓸 수 있습니다")])
        }),
    );
    if obj.field("sampleParams").is_some() {
        let value = obj.field("sampleParams").cloned();
        obj.set(
            "sampleParams",
            validate_record(value.as_ref(), |_| true, |item| {
                string(item, |value, issues| {
                    if !safe_segment_re().is_match(value) {
                        issues.push(issue(Vec::new(), "경로 조각으로 안전한 문자(영문·숫자·_·-)만 쓸 수 있습니다", false));
                    }
                })
            }),
        );
    }
    if obj.field("viewport").is_some() {
        let value = obj.field("viewport").cloned();
        obj.set("viewport", viewport(value.as_ref()));
    }
    if obj.field("dynamicRouteProbe").is_some() {
        let value = obj.field("dynamicRouteProbe").cloned();
        obj.set("dynamicRouteProbe", boolean(value.as_ref()));
    }
    if obj.field("sampleIdFrom").is_some() {
        let value = obj.field("sampleIdFrom").cloned();
        obj.set("sampleIdFrom", expect_from_api(value.as_ref()));
    }
    if obj.field("followImports").is_some() {
        let value = obj.field("followImports").cloned();
        obj.set("followImports", boolean(value.as_ref()));
    }
    obj.run_checks(&mut |parsed, issues| {
        let browser = matches!(parsed.get("mode"), Some(JsValue::Str(mode)) if mode == "browser");
        if !browser && parsed.get("viewport").is_some() {
            issues.push(issue(vec![Seg::Key("viewport".into())], "viewport는 mode: browser에서만 쓸 수 있습니다", false));
        }
        if let Some(JsValue::Obj(params)) = parsed.get("sampleParams") {
            for (name, _) in params.entries_js_order() {
                if !safe_segment_re().is_match(name) {
                    issues.push(issue(vec![Seg::Key("sampleParams".into()), Seg::Key(name.to_owned())], "세그먼트 이름은 영문·숫자·_·-만 쓸 수 있습니다", false));
                }
            }
        }
        if parsed.get("sampleIdFrom").is_some() && matches!(parsed.get("dynamicRouteProbe"), Some(JsValue::Bool(false))) {
            issues.push(issue(vec![Seg::Key("sampleIdFrom".into())], "sampleIdFrom은 dynamicRouteProbe를 끄면 쓰이지 않습니다", false));
        }
    });
    obj.finish()
}

const RELEASE_REQUIRES_REMOVED: &str = "`workflow.releaseRequires`는 더는 지원하지 않습니다. 이 항목을 지우세요";

pub fn workflow(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    let stages = ["plan", "implement", "run", "browser_check", "contract_check", "test", "concurrency_check", "load_check", "review", "checkpoint"];
    if obj.field("required").is_some() {
        let value = obj.field("required").cloned();
        obj.set("required", validate_array(value.as_ref(), |item| validate_enum(item, &stages), &[LengthCheck::Min(1, None)]));
    }
    if obj.field("tests").is_some() {
        let value = obj.field("tests").cloned();
        obj.set("tests", validate_array(value.as_ref(), |item| workflow_test(item), &[]));
    }
    if obj.field("pageChecks").is_some() {
        let value = obj.field("pageChecks").cloned();
        obj.set("pageChecks", validate_array(value.as_ref(), |item| page_check(item), &[]));
    }
    if obj.field("concurrencyChecks").is_some() {
        let value = obj.field("concurrencyChecks").cloned();
        obj.set(
            "concurrencyChecks",
            validate_array(value.as_ref(), |item| concurrency_check(item), &[LengthCheck::Max(10, Some("concurrencyChecks는 최대 10개까지 쓸 수 있습니다"))]),
        );
    }
    if obj.field("loadChecks").is_some() {
        let value = obj.field("loadChecks").cloned();
        obj.set("loadChecks", validate_array(value.as_ref(), |item| load_check(item), &[LengthCheck::Max(5, Some("loadChecks는 최대 5개까지 쓸 수 있습니다"))]));
    }
    if obj.field("autoPageChecks").is_some() {
        let value = obj.field("autoPageChecks").cloned();
        obj.set("autoPageChecks", auto_page_checks(value.as_ref()));
    }
    if obj.field("maxChangedFiles").is_some() {
        let value = obj.field("maxChangedFiles").cloned();
        obj.set("maxChangedFiles", int_min(value.as_ref(), 1.0));
    }
    if obj.field("maxTurns").is_some() {
        let value = obj.field("maxTurns").cloned();
        obj.set("maxTurns", int_min_max(value.as_ref(), 1.0, 300.0));
    }
    if obj.field("allowedTools").is_some() {
        let value = obj.field("allowedTools").cloned();
        obj.set(
            "allowedTools",
            validate_array(value.as_ref(), |item| validate_string(item, &[LengthCheck::Min(1, None)], &mut |_, _| {}), &[LengthCheck::Min(1, None)]),
        );
    }
    for key in ["deniedCommands", "requireApprovalFor"] {
        if obj.field(key).is_some() {
            let value = obj.field(key).cloned();
            obj.set(key, validate_array(value.as_ref(), |item| validate_string(item, &[LengthCheck::Min(1, None)], &mut |_, _| {}), &[]));
        }
    }
    for key in ["protectedPaths", "evaluationAssets"] {
        if obj.field(key).is_some() {
            let value = obj.field(key).cloned();
            obj.set(key, validate_array(value.as_ref(), |item| relative_path(item), &[]));
        }
    }
    if obj.field("releaseRequires").is_some() {
        obj.issues.push(issue(vec![Seg::Key("releaseRequires".to_owned())], RELEASE_REQUIRES_REMOVED.to_owned(), false));
    }
    obj.run_checks(&mut |parsed, issues| workflow_refinements(parsed, issues));
    obj.finish_with(workflow_transform)
}

fn array_len(parsed: &JsObject, key: &str) -> usize {
    match parsed.get(key) {
        Some(JsValue::Arr(items)) => items.len(),
        _ => 0,
    }
}

fn required_set(parsed: &JsObject) -> HashSet<String> {
    match parsed.get("required") {
        Some(JsValue::Arr(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        _ => HashSet::new(),
    }
}

fn workflow_refinements(parsed: &JsObject, issues: &mut Vec<Issue>) {
    let required = required_set(parsed);
    let checks: [(&str, &str, &str, &str); 4] = [
        ("test", "tests", "required에 test가 있으면 실행할 tests가 최소 1개 필요합니다", "tests"),
        ("browser_check", "pageChecks", "required에 browser_check가 있으면 확인할 pageChecks가 최소 1개 필요합니다", "pageChecks"),
        ("concurrency_check", "concurrencyChecks", "required에 concurrency_check가 있으면 실행할 concurrencyChecks가 최소 1개 필요합니다", "concurrencyChecks"),
        ("load_check", "loadChecks", "required에 load_check가 있으면 실행할 loadChecks가 최소 1개 필요합니다", "loadChecks"),
    ];
    for (stage, key, message, path) in checks {
        if required.contains(stage) && array_len(parsed, key) == 0 {
            issues.push(issue(vec![Seg::Key(path.into())], message, false));
        }
    }
    let mut names: HashSet<String> = HashSet::new();
    if let Some(JsValue::Arr(tests)) = parsed.get("tests") {
        for (index, test) in tests.iter().enumerate() {
            if let Some(name) = test.prop("name").and_then(JsValue::as_str) {
                if !names.insert(name.to_owned()) {
                    issues.push(issue(
                        vec![Seg::Key("tests".into()), Seg::Index(index), Seg::Key("name".into())],
                        format!("테스트 이름 '{name}'이 중복됩니다"),
                        false,
                    ));
                }
            }
        }
    }
    if let Some(JsValue::Arr(checks)) = parsed.get("concurrencyChecks") {
        for (index, check) in checks.iter().enumerate() {
            if let Some(name) = check.prop("name").and_then(JsValue::as_str) {
                if !names.insert(name.to_owned()) {
                    issues.push(issue(
                        vec![Seg::Key("concurrencyChecks".into()), Seg::Index(index), Seg::Key("name".into())],
                        format!("동시 요청 확인 이름 '{name}'이 중복됩니다"),
                        false,
                    ));
                }
            }
        }
    }
    if let Some(JsValue::Arr(checks)) = parsed.get("loadChecks") {
        for (index, check) in checks.iter().enumerate() {
            if let Some(name) = check.prop("name").and_then(JsValue::as_str) {
                if !names.insert(name.to_owned()) {
                    issues.push(issue(
                        vec![Seg::Key("loadChecks".into()), Seg::Index(index), Seg::Key("name".into())],
                        format!("부하 확인 이름 '{name}'이 중복됩니다"),
                        false,
                    ));
                }
            }
        }
    }
}

fn workflow_transform(mut out: JsObject) -> JsValue {
    let references: Vec<String> = match out.get("pageChecks") {
        Some(JsValue::Arr(checks)) => checks
            .iter()
            .filter_map(|check| check.prop("compare").and_then(|compare| compare.prop("reference")).and_then(JsValue::as_str).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    if references.is_empty() {
        return JsValue::Obj(out);
    }
    let mut merged: Vec<String> = match out.get("evaluationAssets") {
        Some(JsValue::Arr(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        _ => Vec::new(),
    };
    let mut seen: HashSet<String> = merged.iter().cloned().collect();
    for reference in references {
        if seen.insert(reference.clone()) {
            merged.push(reference);
        }
    }
    out.set("evaluationAssets", JsValue::Arr(merged.into_iter().map(JsValue::Str).collect()));
    JsValue::Obj(out)
}
