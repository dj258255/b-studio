//! 게이트 리뷰 판정(선언 변경·부하 판정·계약 비교·근거 줄, ADR-191 3단계 3e)이 함께 쓰는 입력 읽기 규칙.
//!
//! 입력은 Node가 `encodeNative`로 만든 JSON이다. JS 코드는 `value.key`를 모양 검사 없이 읽는다: 값이 `null`이면 던지고,
//! 객체가 아닌 값이면 `undefined`로 읽는다. 여기서는 그 규칙을 따르되, 모양이 크게 어긋난 값(배열이어야 할 자리의 문자열 등)은
//! JS가 글자 단위로 펼치거나 조용히 넘어가는 대신 **던진다**(거부 쪽). 던진 판정은 게이트에서 실패로 처리된다.

use crate::js_json::{self, JsObject, JsValue};

/// JSON 문자열 안의 짝 없는 서로게이트 이스케이프(`\ud800`)가 있으면 거부한다.
/// Rust 문자열은 짝 없는 서로게이트를 담지 못해 읽는 쪽이 U+FFFD로 바꾸므로, 서로 다른 두 이름이 하나로 합쳐져
/// 선언이나 스키마의 변경이 사라질 수 있다(옛 TS는 둘을 다르게 봤다). `JSON.stringify`는 짝 없는 서로게이트만 이스케이프로 쓴다
pub fn reject_lone_surrogates(json: &str) -> Result<(), String> {
    let b = json.as_bytes();
    let hex4 = |at: usize| -> Option<u32> {
        let h = b.get(at..at + 4)?;
        u32::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()
    };
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        if b.get(i + 1) == Some(&b'u') {
            if let Some(cp) = hex4(i + 2) {
                if (0xD800..0xDC00).contains(&cp) {
                    let paired = b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex4(i + 8).is_some_and(|lo| (0xDC00..0xE000).contains(&lo));
                    if !paired {
                        return Err("짝 없는 서로게이트가 있는 글자는 판정에 쓸 수 없습니다".into());
                    }
                    i += 12;
                    continue;
                }
                if (0xDC00..0xE000).contains(&cp) {
                    return Err("짝 없는 서로게이트가 있는 글자는 판정에 쓸 수 없습니다".into());
                }
                i += 6;
                continue;
            }
        }
        i += 2;
    }
    Ok(())
}

/// 판정에 쓸 JSON을 읽는다. 짝 없는 서로게이트가 있거나 읽지 못하면 이유를 돌려준다
pub fn parse_checked(json: &str, what: &str) -> Result<JsValue, String> {
    reject_lone_surrogates(json).map_err(|e| format!("{what}: {e}"))?;
    js_json::parse_native(json).map_err(|e| format!("{what}을(를) 읽지 못했습니다: {e}"))
}

/// `value?.key`: `undefined`·`null`이면 `undefined`, 객체가 아닌 값도 `undefined`
pub fn opt_prop<'a>(value: Option<&'a JsValue>, key: &str) -> Option<&'a JsValue> {
    value.and_then(|v| v.prop(key))
}

/// `value.key`: `undefined`·`null`이면 던진다(`TypeError`), 객체가 아닌 값은 `undefined`
pub fn prop<'a>(value: Option<&'a JsValue>, key: &str) -> Result<Option<&'a JsValue>, String> {
    match value {
        None | Some(JsValue::Null) => Err(format!("비어 있는 값에서 {key}을(를) 읽을 수 없습니다")),
        Some(v) => Ok(v.prop(key)),
    }
}

/// 객체여야 하는 자리. 아니면 던진다
pub fn require_obj<'a>(value: Option<&'a JsValue>, what: &str) -> Result<&'a JsObject, String> {
    match value {
        Some(JsValue::Obj(o)) => Ok(o),
        _ => Err(format!("{what}이(가) 객체가 아닙니다")),
    }
}

/// `value ?? 기본값`으로 읽는 목록. `undefined`·`null`이면 빈 목록, 배열이 아니면 던진다(JS는 문자열을 글자 단위로 펼친다)
pub fn nullish_array<'a>(value: Option<&'a JsValue>, what: &str) -> Result<&'a [JsValue], String> {
    match value {
        None | Some(JsValue::Null) => Ok(&[]),
        Some(JsValue::Arr(items)) => Ok(items),
        Some(_) => Err(format!("{what}이(가) 배열이 아닙니다")),
    }
}

/// `value ?? {}`로 읽는 객체. `undefined`·`null`이면 빈 객체, 객체가 아니면 던진다
pub fn nullish_object<'a>(value: Option<&'a JsValue>, what: &str, empty: &'a JsObject) -> Result<&'a JsObject, String> {
    match value {
        None | Some(JsValue::Null) => Ok(empty),
        Some(JsValue::Obj(o)) => Ok(o),
        Some(_) => Err(format!("{what}이(가) 객체가 아닙니다")),
    }
}

/// 템플릿 문자열 `${value}`: `undefined`는 "undefined"
pub fn template(value: Option<&JsValue>) -> String {
    value.map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
}

/// `array.join(sep)`: `null`·`undefined` 요소는 빈 글자
pub fn join(items: &[JsValue], sep: &str) -> String {
    items.iter().map(|v| if matches!(v, JsValue::Null) { String::new() } else { v.to_js_string() }).collect::<Vec<_>>().join(sep)
}

/// 수여야 하는 자리. 수가 아니면 던진다(`NaN`·`Infinity`는 수다)
pub fn require_num(value: Option<&JsValue>, what: &str) -> Result<f64, String> {
    match value {
        Some(JsValue::Num(n)) => Ok(*n),
        _ => Err(format!("{what}이(가) 수가 아닙니다")),
    }
}

/// `Math.min(a, b)`: 하나라도 NaN이면 NaN, `-0`은 `+0`보다 작다
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: 하나라도 NaN이면 NaN, `+0`은 `-0`보다 크다
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { b } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 짝_없는_서로게이트_이스케이프는_거부하고_짝이_맞으면_받는다() {
        assert!(reject_lone_surrogates(r#"{"a":"\ud800"}"#).is_err());
        assert!(reject_lone_surrogates(r#"{"a":"\udc00x"}"#).is_err());
        assert!(reject_lone_surrogates(r#"{"a":"\ud800A"}"#).is_err());
        assert!(reject_lone_surrogates(r#"{"a":"😀"}"#).is_ok());
        // 이스케이프된 역슬래시 뒤의 글자는 이스케이프가 아니다
        assert!(reject_lone_surrogates(r#"{"a":"\\ud800"}"#).is_ok());
        assert!(reject_lone_surrogates(r#"{"a":"\\\ud800"}"#).is_err());
        assert!(reject_lone_surrogates(r#"{"a":"A\n"}"#).is_ok());
    }

    #[test]
    fn min_max는_nan을_퍼뜨리고_영의_부호를_본다() {
        assert!(js_min(f64::NAN, 1.0).is_nan());
        assert!(js_max(1.0, f64::NAN).is_nan());
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert_eq!(js_max(5.0, 7.0), 7.0);
        assert_eq!(js_min(5.0, 7.0), 5.0);
    }
}
