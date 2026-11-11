//! 컨테이너 만들기 반복(`LocalDockerProvider.#upOnce`·`#refreshGitMask`·`#writeOverride`, ADR-195 4f A4c-1)의 판정 부분.
//! docker를 부르고 파일을 쓰는 순서는 `bstudio-io`의 `up_loop`가 하고, 여기는 그 사이의 판정만 한다. 파일 시스템도 읽지 않는다.
//!
//! 막는 검사다. 아래는 모두 **통과가 아니라 실패**로 읽는다.
//!  - `compose config --format json` 출력을 해석하지 못함, 최상위가 객체가 아님(옛 TS는 객체가 아닌 값을 "서비스 없음"으로 읽었다)
//!  - 마스크가 시도 안에서 계속 바뀜(부르는 쪽이 내리고 멈춘다)
//!
//! 막는 쪽/여는 쪽: 이 모듈의 함수는 모두 **막는 쪽**이다. `masks_equal`은 "같다"고 읽으면 다시 쓰지 않고 넘어가므로 넓게 맞추지 않는다
//! (서비스 순서만 무시한다: 순서는 override의 효과를 바꾸지 않는다. 마운트의 순서·내용은 하나라도 다르면 다르다).

use serde_json::{Map, Value};

use crate::git_mask::MaskVolume;
use crate::js_json::{self, JsValue};

/// compose 파일이 up과 겹쳐 계속 바뀔 때 `.git` 마스크를 맞춰 다시 올리는 최대 횟수
pub const GIT_MASK_ATTEMPTS: u32 = 3;

pub type Mask = Vec<(String, Vec<MaskVolume>)>;

/// `compose config --format json`의 출력에서 마운트를 읽는 데 쓰는 부분(`{ services, volumes? }`)만 뽑는다.
/// 옛 TS처럼 `services`가 없거나 `null`이면 빈 객체, `volumes`는 JS가 참으로 보는 값일 때만 남긴다.
/// 해석하지 못하면 `None`(= 모른다 = 실패). 최상위가 객체가 아닌 JSON도 모른다(옛 TS는 서비스 없음으로 읽었다)
pub fn config_from_stdout(stdout: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(stdout).ok()?;
    let Value::Object(map) = parsed else { return None };
    let mut config = Map::new();
    let services = match map.get("services") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(other) => other.clone(),
    };
    config.insert("services".to_owned(), services);
    if let Some(volumes) = map.get("volumes") {
        if js_truthy(volumes) {
            config.insert("volumes".to_owned(), volumes.clone());
        }
    }
    Some(Value::Object(config))
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// 두 마스크가 같은가. 서비스의 순서는 보지 않는다(이름으로 정렬해 견준다). 서비스 안의 마운트는 순서까지 견준다
pub fn masks_equal(a: &Mask, b: &Mask) -> bool {
    fn sorted(mask: &Mask) -> Vec<&(String, Vec<MaskVolume>)> {
        let mut items: Vec<&(String, Vec<MaskVolume>)> = mask.iter().collect();
        items.sort_by(|x, y| x.0.cmp(&y.0));
        items
    }
    let (a, b) = (sorted(a), sorted(b));
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.0 == y.0 && x.1 == y.1)
}

/// override 입력(`buildOverride`가 받는 값)에 마스크를 얹는다. 입력이 객체가 아니면 `None`
pub fn with_git_mask(input: &JsValue, mask: &Mask) -> Option<JsValue> {
    let JsValue::Obj(object) = input else { return None };
    let mut object = object.clone();
    let mask_value = js_json::parse(&crate::git_mask::record_to_json(mask).to_string()).ok()?;
    object.set("gitMask", mask_value);
    Some(JsValue::Obj(object))
}

/// `JSON.stringify` 결과를 YAML 파서가 같은 값으로 읽게 만든다. compose는 override를 YAML로 읽는다(YAML은 JSON을 포함하지만 글자 몇 개는 다르게 읽는다).
/// 문자열 안의 글자 가운데 YAML이 거부하거나(0x7F, 0x80~0x9F의 제어 문자, BOM, U+FFFE·FFFF) 줄바꿈으로 읽어 접어 버리는 것(U+0085, U+2028, U+2029)을
/// `\uXXXX`로 쓴다. 구조를 이루는 글자는 모두 ASCII 인쇄 문자라 이 치환은 문자열 밖을 건드리지 않는다
pub fn yaml_safe_json(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        match c as u32 {
            0x7f..=0x9f | 0x2028 | 0x2029 | 0xfeff | 0xfffe | 0xffff => out.push_str(&format!("\\u{:04x}", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_mask::BindOptions;

    fn volume(source: &str, target: &str) -> MaskVolume {
        MaskVolume { kind: "bind".into(), source: source.into(), target: target.into(), read_only: true, bind: BindOptions { create_host_path: false } }
    }

    #[test]
    fn config는_객체만_받고_services가_없으면_빈_객체다() {
        assert_eq!(config_from_stdout("{}").unwrap(), serde_json::json!({ "services": {} }));
        assert_eq!(config_from_stdout("{\"services\":null}").unwrap(), serde_json::json!({ "services": {} }));
        assert_eq!(config_from_stdout("{\"services\":{\"a\":{}},\"volumes\":{\"v\":null}}").unwrap(), serde_json::json!({ "services": { "a": {} }, "volumes": { "v": null } }));
    }

    #[test]
    fn volumes는_참으로_읽히는_값만_남긴다() {
        for falsy in ["null", "false", "0", "\"\""] {
            let config = config_from_stdout(&format!("{{\"services\":{{}},\"volumes\":{falsy}}}")).unwrap();
            assert!(config.get("volumes").is_none(), "{falsy}");
        }
        assert!(config_from_stdout("{\"services\":{},\"volumes\":[]}").unwrap().get("volumes").is_some());
    }

    #[test]
    fn 해석하지_못하거나_객체가_아니면_모른다() {
        for bad in ["", "not json", "null", "[]", "5", "\"x\"", "true", "{\"services\":", "{} trailing"] {
            assert!(config_from_stdout(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn 마스크_견주기는_서비스_순서를_보지_않고_마운트는_엄격하게_본다() {
        let a: Mask = vec![("api".into(), vec![volume("/s", "/a")]), ("db".into(), vec![])];
        let reordered: Mask = vec![("db".into(), vec![]), ("api".into(), vec![volume("/s", "/a")])];
        assert!(masks_equal(&a, &reordered));
        assert!(!masks_equal(&a, &vec![("api".into(), vec![volume("/s", "/b")]), ("db".into(), vec![])]));
        assert!(!masks_equal(&a, &vec![("api".into(), vec![volume("/s", "/a")])]));
        let mut twice = volume("/s", "/a");
        twice.read_only = false;
        assert!(!masks_equal(&a, &vec![("api".into(), vec![twice]), ("db".into(), vec![])]));
        assert!(!masks_equal(&vec![("api".into(), vec![volume("/s", "/a"), volume("/s", "/b")])], &vec![("api".into(), vec![volume("/s", "/b"), volume("/s", "/a")])]));
    }

    #[test]
    fn yaml_안전_json은_위험한_글자만_이스케이프하고_같은_값으로_읽힌다() {
        let text = "a\u{7f}b\u{85}c\u{2028}d\u{2029}e\u{feff}f\u{9f}g\u{a0}h\u{e9}i\u{1f600}";
        let json = js_json::stringify(&JsValue::Str(text.to_owned()));
        let safe = yaml_safe_json(&json);
        assert!(!safe.contains('\u{7f}') && !safe.contains('\u{85}') && !safe.contains('\u{2028}') && !safe.contains('\u{feff}'));
        assert!(safe.contains('\u{a0}') && safe.contains('\u{e9}') && safe.contains('\u{1f600}'));
        let back: String = serde_json::from_str(&safe).unwrap();
        assert_eq!(back, text);
    }

    #[test]
    fn override_입력에_마스크를_얹는다() {
        let input = js_json::parse("{\"sandboxId\":\"x\"}").unwrap();
        let with = with_git_mask(&input, &vec![("api".into(), vec![volume("/s", "/a")])]).unwrap();
        assert_eq!(with.prop("sandboxId").and_then(JsValue::as_str), Some("x"));
        assert!(with.prop("gitMask").and_then(|mask| mask.prop("api")).is_some());
        assert!(with_git_mask(&JsValue::Null, &Vec::new()).is_none());
    }
}
