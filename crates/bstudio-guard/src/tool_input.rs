//! 에이전트 도구의 입력 검사와 서비스 허용 목록(ADR-191 3단계 3u). 옛 `packages/agent/src/tools.ts`의 `asRecord`·`string`·`integer`·`boolean`·
//! `stringArray`·`optionalStringArray`·`clamp`, `serviceName`·`serviceOrAddonName`·`composeServiceNames`, `summarizeApproval`, `createMismatchLog`의 판정,
//! `httpRequest`의 경로·origin 확인. 도구 실행과 `executeTool`의 흐름은 TS에 남는다.
//!
//! **호출 자리마다 막는 쪽인지 여는 쪽인지가 다르다.**
//!  - 막는 쪽(입력 거부. 틀려도 더 막을 뿐): `input_error`(모든 종류), `http_path_ok`, `mismatch_addable`의 상한
//!  - 여는 쪽(넓히면 허용 밖이 허용 안이 된다): `service_allowed`·`service_or_addon_allowed`(서비스 허용 목록), `same_origin`(같은 호스트만)
//!  - 한계를 정하는 쪽: `clamp`(결과가 [min, max] 밖으로 나가면 상한이 풀린다)
//!
//! 여는 쪽의 같음 비교는 글자 그대로의 `==`다. 짝 없는 서로게이트는 napi 경계에서 U+FFFD로 합쳐지므로(서로 다른 두 이름이 같아진다) 껍데기가 비교하는 두 글자를
//! 모두 `encodeLoneSurrogates`(단사)로 바꿔 보낸다. 모르는 입력(해석할 수 없는 JSON, 알 수 없는 검사 종류)은 막는 쪽에서는 거부로, 여는 쪽에서는 허용 밖으로 본다.
//!
//! 옛 TS와 같은 입력에 같은 결과를 낸다. 다른 곳은 모두 더 막는 쪽이다.
//!  1. 구멍 난 배열(`[ , 'a']`, `new Array(3)`)을 옛 `every`는 건너뛰어 통과시켰다. 껍데기가 입력을 JSON으로 복사해(구멍은 `null`이 된다) 새 구현은 거부한다.
//!  2. 입력에 BigInt나 NUL로 시작하는 키가 있으면 옛 구현은 그 필드를 읽을 때만 걸렸고 새 구현은 입력 전체를 거부한다(JSON으로 복사할 수 없다).
//!  3. `same_origin`은 origin이 `"null"`(불투명 origin)이면 같다고 보지 않는다. 옛 구현은 두 `"null"`을 같다고 보았다.

use crate::js_json::{self, JsValue};
use crate::review_input::{js_max, js_min};

const NOT_AN_OBJECT: &str = "Tool input must be an object";

/// 입력 한 값의 검사. `kind`는 `record`·`string`·`integer`·`boolean`·`stringArray`·`optionalStringArray`.
/// `value_json`은 `encodeNative`한 값, 값이 없으면(`undefined`) `None`. 맞으면 `None`, 아니면 부르는 쪽이 던질 오류 글이다.
/// 알 수 없는 종류와 읽을 수 없는 JSON은 거부한다
pub fn input_error(kind: &str, key: &str, value_json: Option<&str>) -> Option<String> {
    let reject = || match kind {
        "record" => NOT_AN_OBJECT.to_owned(),
        "string" => format!("\"{key}\" must be a string"),
        "integer" => format!("\"{key}\" must be an integer"),
        "boolean" => format!("\"{key}\" must be a boolean"),
        "stringArray" => format!("\"{key}\" must be a non-empty array of strings"),
        "optionalStringArray" => format!("\"{key}\" must be an array of strings"),
        other => format!("알 수 없는 입력 검사입니다: {other}"),
    };
    let value = match value_json {
        None => None,
        Some(text) => match js_json::parse_native(text) {
            Ok(value) => Some(value),
            Err(_) => return Some(reject()),
        },
    };
    let valid = match (kind, value.as_ref()) {
        ("record", Some(JsValue::Obj(_))) => true,
        ("string", Some(JsValue::Str(_))) => true,
        // `Number.isInteger`: 유한하고 소수 부분이 없다(`-0`과 2^53 위의 큰 수도 정수다)
        ("integer", Some(JsValue::Num(n))) => n.is_finite() && n.fract() == 0.0,
        ("boolean", Some(JsValue::Bool(_))) => true,
        ("stringArray", Some(JsValue::Arr(items))) => !items.is_empty() && items.iter().all(|item| matches!(item, JsValue::Str(_))),
        ("optionalStringArray", None) => true,
        ("optionalStringArray", Some(JsValue::Arr(items))) => items.iter().all(|item| matches!(item, JsValue::Str(_))),
        _ => false,
    };
    if valid {
        None
    } else {
        Some(reject())
    }
}

/// `Math.min(max, Math.max(min, value))`. NaN·`-0`·무한대를 JS와 같게 다룬다
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    js_min(max, js_max(min, value))
}

/// 이 프로젝트 자신의 compose 서비스 이름 전체(부가 서비스 포함). compose 목록이 없으면(`undefined`) managed만으로 본다. 빈 목록은 빈 목록이다(`??`는 빈 배열을 건너뛰지 않는다)
pub fn compose_service_names(compose: Option<&[String]>, managed: &[String]) -> Vec<String> {
    compose.unwrap_or(managed).to_vec()
}

/// 여는 쪽. managed 서비스 이름과 글자 그대로 같을 때만 허용한다(비교하는 두 글자는 껍데기가 단사로 바꿔 보낸다)
pub fn service_allowed(name: &str, managed: &[String]) -> bool {
    managed.iter().any(|candidate| candidate == name)
}

/// 여는 쪽. 이 프로젝트 자신의 compose 서비스(managed 포함) 이름과 글자 그대로 같을 때만 허용한다
pub fn service_or_addon_allowed(name: &str, compose: Option<&[String]>, managed: &[String]) -> bool {
    compose.unwrap_or(managed).iter().any(|candidate| candidate == name)
}

/// 승인 요청에 보여 줄 안전한 요약. `input_json`은 `encodeNative`한 입력(해석할 수 없으면 `None`)이다. 객체(배열 포함)가 아니면 도구 이름만이다
pub fn summarize_approval(name: &str, input_json: Option<&str>) -> String {
    let input = input_json.and_then(|text| js_json::parse_native(text).ok());
    let Some(args) = input.filter(|value| matches!(value, JsValue::Obj(_) | JsValue::Arr(_))) else {
        return name.to_owned();
    };
    if name == "run_in_service" {
        let service = args.prop("service").and_then(JsValue::as_str).unwrap_or("unknown service");
        let command = match args.prop("command") {
            Some(JsValue::Arr(items)) => items.iter().filter_map(JsValue::as_str).collect::<Vec<_>>().join(" "),
            _ => String::new(),
        };
        return format!("run {command} in {service}");
    }
    if matches!(name, "write_file" | "edit_file" | "delete_file") {
        let file = args.prop("path").and_then(JsValue::as_str).unwrap_or("a file");
        return format!("{name} {file}");
    }
    name.to_owned()
}

/// 어긋남 기록(`report_mismatch`)을 남겨도 되는지. 이미 `max`개면 안 되고, 요청 값·확인 값·따른 쪽이 모두 같은 기록이 이미 있으면 안 된다.
/// 기록은 상태를 낮추기만 하고 올리지 않는다. 같음 비교의 두 글자는 껍데기가 단사로 바꿔 보낸다
pub fn mismatch_addable(max: usize, seen_requests: &[String], seen_checks: &[String], seen_followed: &[String], request: &str, check: &str, followed: &str) -> bool {
    let count = seen_requests.len();
    if count != seen_checks.len() || count != seen_followed.len() {
        return false;
    }
    if count >= max {
        return false;
    }
    !(0..count).any(|i| seen_requests[i] == request && seen_checks[i] == check && seen_followed[i] == followed)
}

/// 막는 쪽. `http_request`의 경로는 `/`로 시작해야 한다
pub fn http_path_ok(path: &str) -> bool {
    path.starts_with('/')
}

/// 여는 쪽. 요청 URL의 origin이 서비스의 origin과 같을 때만 같은 호스트다. 불투명 origin(`"null"`)은 같다고 보지 않는다
pub fn same_origin(request_origin: &str, service_origin: &str) -> bool {
    request_origin == service_origin && service_origin != "null"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(kind: &str, json: Option<&str>) -> bool {
        input_error(kind, "k", json).is_some()
    }

    #[test]
    fn 입력_종류마다_맞는_값만_받는다() {
        assert!(!err("record", Some(r#"{"a":1}"#)));
        assert!(err("record", Some("[]")));
        assert!(err("record", Some("null")));
        assert!(err("record", None));
        assert!(!err("string", Some(r#""""#)));
        assert!(err("string", Some("1")));
        assert!(!err("integer", Some("3")));
        assert!(!err("integer", Some("1e300")));
        assert!(!err("integer", Some(r#"{"\u0000nf":"-0"}"#)));
        assert!(err("integer", Some("1.5")));
        assert!(err("integer", Some(r#"{"\u0000nf":"NaN"}"#)));
        assert!(err("integer", Some(r#"{"\u0000nf":"Infinity"}"#)));
        assert!(err("integer", Some(r#""5""#)));
        assert!(!err("boolean", Some("false")));
        assert!(err("boolean", Some("0")));
        assert!(!err("stringArray", Some(r#"["a"]"#)));
        assert!(err("stringArray", Some("[]")));
        assert!(err("stringArray", Some(r#"["a",null]"#)));
        assert!(err("stringArray", None));
        assert!(!err("optionalStringArray", None));
        assert!(!err("optionalStringArray", Some("[]")));
        assert!(err("optionalStringArray", Some("null")));
        assert!(err("optionalStringArray", Some(r#"["a",1]"#)));
        assert!(err("모르는 종류", Some("1")));
        assert!(err("string", Some("{")));
    }

    #[test]
    fn 오류_글은_옛_글과_같다() {
        assert_eq!(input_error("string", "path", Some("1")).as_deref(), Some("\"path\" must be a string"));
        assert_eq!(input_error("stringArray", "terms", None).as_deref(), Some("\"terms\" must be a non-empty array of strings"));
        assert_eq!(input_error("record", "", None).as_deref(), Some("Tool input must be an object"));
    }

    #[test]
    fn clamp는_js_math와_같다() {
        assert_eq!(clamp(0.0, 1.0, 6.0), 1.0);
        assert_eq!(clamp(9.0, 1.0, 6.0), 6.0);
        assert!(clamp(f64::NAN, 1.0, 6.0).is_nan());
        assert_eq!(clamp(f64::INFINITY, 1.0, 6.0), 6.0);
        assert_eq!(clamp(f64::NEG_INFINITY, 1.0, 6.0), 1.0);
        assert!(clamp(-0.0, -0.0, 5.0).is_sign_negative());
        assert!(!clamp(-0.0, 0.0, 5.0).is_sign_negative());
    }

    #[test]
    fn 서비스_허용_목록은_글자_그대로만_받는다() {
        let managed = vec!["web".to_owned(), "api".to_owned()];
        let compose = vec!["web".to_owned(), "api".to_owned(), "db".to_owned()];
        assert!(service_allowed("api", &managed));
        assert!(!service_allowed("db", &managed));
        assert!(!service_allowed("ap", &managed));
        assert!(!service_allowed("API", &managed));
        assert!(!service_allowed("api ", &managed));
        assert!(!service_allowed("", &managed));
        assert!(service_or_addon_allowed("db", Some(&compose), &managed));
        assert!(!service_or_addon_allowed("db", None, &managed));
        assert!(service_or_addon_allowed("api", None, &managed));
        assert!(!service_or_addon_allowed("api", Some(&[]), &managed));
        assert_eq!(compose_service_names(None, &managed), managed);
        assert!(compose_service_names(Some(&[]), &managed).is_empty());
    }

    #[test]
    fn 승인_요약() {
        assert_eq!(summarize_approval("run_in_service", Some(r#"{"service":"api","command":["ls",1,"-la"]}"#)), "run ls -la in api");
        assert_eq!(summarize_approval("run_in_service", Some(r#"{"command":"ls"}"#)), "run  in unknown service");
        assert_eq!(summarize_approval("run_in_service", Some("[]")), "run  in unknown service");
        assert_eq!(summarize_approval("run_in_service", Some("1")), "run_in_service");
        assert_eq!(summarize_approval("run_in_service", None), "run_in_service");
        assert_eq!(summarize_approval("write_file", Some(r#"{"path":"a.txt"}"#)), "write_file a.txt");
        assert_eq!(summarize_approval("delete_file", Some(r#"{"path":1}"#)), "delete_file a file");
        assert_eq!(summarize_approval("read_file", Some(r#"{"path":"a"}"#)), "read_file");
    }

    #[test]
    fn 어긋남은_상한과_같은_기록에서_막힌다() {
        let v = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(mismatch_addable(5, &v(&["a"]), &v(&["b"]), &v(&["request"]), "a", "b", "check"));
        assert!(mismatch_addable(5, &v(&["a"]), &v(&["b"]), &v(&["request"]), "a2", "b", "request"));
        assert!(mismatch_addable(5, &v(&["a"]), &v(&["b"]), &v(&["request"]), "a", "b2", "request"));
        assert!(!mismatch_addable(5, &v(&["a"]), &v(&["b"]), &v(&["request"]), "a", "b", "request"));
        assert!(!mismatch_addable(1, &v(&["a"]), &v(&["b"]), &v(&["request"]), "x", "y", "neither"));
        assert!(mismatch_addable(2, &v(&["a"]), &v(&["b"]), &v(&["request"]), "x", "y", "neither"));
        assert!(!mismatch_addable(5, &v(&["a"]), &v(&[]), &v(&["request"]), "x", "y", "neither"));
    }

    #[test]
    fn 호스트는_origin이_같을_때만_같다() {
        assert!(http_path_ok("/a"));
        assert!(!http_path_ok(""));
        assert!(!http_path_ok("a"));
        assert!(same_origin("http://127.0.0.1:1", "http://127.0.0.1:1"));
        assert!(!same_origin("http://127.0.0.1:1", "http://127.0.0.1:2"));
        assert!(!same_origin("http://127.0.0.1:1", "http://127.0.0.1:1 "));
        assert!(!same_origin("null", "null"));
    }
}
