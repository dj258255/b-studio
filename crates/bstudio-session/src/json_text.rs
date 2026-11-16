//! 기록의 글자와 저장 파일의 글자 사이를 바꾼다(ADR-203, 4f B1b).
//!
//! 기록의 이벤트 글자는 TS `encodeEvent`의 결과다: `JSON.stringify`와 같되 유한하지 않은 수와 -0은 한 키짜리 표시 객체(`{"\u0000nf":"NaN"}`),
//! NUL로 시작하는 키는 앞에 NUL이 하나 더 붙는다. 저장 파일은 옛 `JSON.stringify(toPersisted(session))`의 글자라 표시 객체가 없고 NUL 키는 그대로다.
//! - `event_to_file`: 기록 → 파일. `JSON.stringify(decodeEvents(글자))`와 같은 글자(표시 객체는 `null`·`0`, NUL 키는 NUL 하나를 뗀다)
//! - `event_from_file`: 파일 → 기록. `encodeEvent(JSON.parse(글자))`와 같은 글자
//! - `write_identity`: 값을 기록의 글자 그대로 다시 쓴다(`close_unfinished`가 이벤트 안의 값을 옮겨 쓴다)
//!
//! 짝 없는 서로게이트는 `js_json::parse_lone_encoded`의 단사 인코딩으로 읽고 쓸 때 `\ud800` 이스케이프로 되돌린다(`JSON.stringify`와 같다).
//! `\u0000`이 없는 글자는 읽지 않고 그대로 쓴다.

use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsObject, JsValue, LoneParseError, NONFINITE_KEY};
use std::borrow::Cow;

const NUL: char = '\u{0}';

/// 읽은 결과
pub(crate) enum ReadFail {
    /// JSON이 아니다
    Invalid,
    /// `js_json`이 읽는 깊이(2,000)를 넘었다(JS는 읽는다: 모른다는 뜻이다)
    TooDeep,
}

/// 글자 안의 예약 글자(U+E000..=U+E01F)를 단사 인코딩에 맞게 바꾼다. 인코딩 읽기는 이스케이프만 풀기 때문이다
pub(crate) fn pre_encode(text: &str) -> Cow<'_, str> {
    if !text.chars().any(|c| (0xE000..=0xE01F).contains(&(c as u32))) {
        return Cow::Borrowed(text);
    }
    Cow::Owned(text.chars().map(js::encode_reserved_char).collect())
}

pub(crate) fn parse_encoded(text: &str) -> Result<JsValue, ReadFail> {
    js_json::parse_lone_encoded(&pre_encode(text)).map_err(|error| match error {
        LoneParseError::Invalid => ReadFail::Invalid,
        LoneParseError::TooDeep => ReadFail::TooDeep,
    })
}

/// 표시 객체가 가리키는 수. 표시 객체가 아니면 없다(`revive`의 조건과 같다: 키가 `\u0000nf` 하나이고 값이 네 글자 중 하나)
pub(crate) fn marker_number(value: &JsValue) -> Option<f64> {
    let JsValue::Obj(object) = value else { return None };
    let [(key, JsValue::Str(mark))] = object.entries() else { return None };
    if key != NONFINITE_KEY {
        return None;
    }
    match mark.as_str() {
        "-0" => Some(-0.0),
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

/// 한 단계만 푼 값: 표시 객체는 수로 바꾼다(그 밖에는 그대로)
pub(crate) fn revive_shallow(value: JsValue) -> JsValue {
    match marker_number(&value) {
        Some(number) => JsValue::Num(number),
        None => value,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// 기록 → 기록: 수는 그대로 두고 유한하지 않은 수·-0은 표시 객체로 쓴다
    Identity,
    /// 기록 → 파일(`JSON.stringify(revive(...))`)
    ToFile,
    /// 파일 → 기록(`encodeEvent`)
    FromFile,
}

/// `JSON.stringify(문자열)`. 인코딩한 짝 없는 서로게이트는 `\ud800` 꼴로, 예약 글자는 글자 그대로 쓴다
fn write_str(text: &str, out: &mut String) {
    out.push('"');
    let chars: Vec<char> = text.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        if let Some((decoded, used)) = js::read_lone_escape(&chars, at) {
            match decoded {
                Ok(c) => out.push(c),
                Err(unit) => out.push_str(&format!("\\u{unit:04x}")),
            }
            at += used;
            continue;
        }
        match chars[at] {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
        at += 1;
    }
    out.push('"');
}

fn write_marker(n: f64, out: &mut String) {
    let text = if n == 0.0 { "-0".to_owned() } else { js::number_to_string(n) };
    out.push('{');
    write_str(NONFINITE_KEY, out);
    out.push(':');
    write_str(&text, out);
    out.push('}');
}

fn write_number(n: f64, mode: Mode, out: &mut String) {
    let negative_zero = n == 0.0 && n.is_sign_negative();
    match mode {
        Mode::ToFile if n.is_finite() && !negative_zero => out.push_str(&js::number_to_string(n)),
        Mode::ToFile => out.push_str(if negative_zero { "0" } else { "null" }),
        _ if !n.is_finite() || negative_zero => write_marker(n, out),
        _ => out.push_str(&js::number_to_string(n)),
    }
}

fn write_entries<'a>(entries: impl Iterator<Item = (Cow<'a, str>, &'a JsValue)>, mode: Mode, out: &mut String) {
    out.push('{');
    for (at, (key, value)) in entries.enumerate() {
        if at > 0 {
            out.push(',');
        }
        write_str(&key, out);
        out.push(':');
        write_value(value, mode, out);
    }
    out.push('}');
}

fn write_value(value: &JsValue, mode: Mode, out: &mut String) {
    match value {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(on) => out.push_str(if *on { "true" } else { "false" }),
        JsValue::Num(n) => write_number(*n, mode, out),
        JsValue::Str(text) => write_str(text, out),
        JsValue::Arr(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_value(item, mode, out);
            }
            out.push(']');
        }
        JsValue::Obj(object) => match mode {
            Mode::Identity => write_entries(object.entries_js_order().into_iter().map(|(key, item)| (Cow::Borrowed(key), item)), mode, out),
            // `escapeNulKeys`: NUL로 시작하는 키에 NUL을 하나 더 붙인다(단사라 같은 키가 둘이 되지 않는다)
            Mode::FromFile => write_entries(
                object.entries_js_order().into_iter().map(|(key, item)| (if key.starts_with(NUL) { Cow::Owned(format!("{NUL}{key}")) } else { Cow::Borrowed(key) }, item)),
                mode,
                out,
            ),
            Mode::ToFile => {
                // `revive`: 표시 객체는 수로, 그 밖에 NUL로 시작하는 키가 있으면 모든 NUL 키에서 NUL 하나를 뗀다(같은 키가 되면 값만 바뀌고 자리는 처음 것이다)
                if let Some(number) = marker_number(value) {
                    write_number(number, mode, out);
                } else if object.entries().iter().any(|(key, _)| key.starts_with(NUL)) {
                    let mut stripped = JsObject::new();
                    for (key, item) in object.entries_js_order() {
                        stripped.set(key.strip_prefix(NUL).unwrap_or(key), item.clone());
                    }
                    write_entries(stripped.entries_js_order().into_iter().map(|(key, item)| (Cow::Borrowed(key), item)), mode, out);
                } else {
                    write_entries(object.entries_js_order().into_iter().map(|(key, item)| (Cow::Borrowed(key), item)), mode, out);
                }
            }
        }
    }
}

/// 값 하나를 기록의 글자 그대로 쓴다
pub(crate) fn write_identity(value: &JsValue) -> String {
    let mut out = String::new();
    write_value(value, Mode::Identity, &mut out);
    out
}

/// NUL로 시작하는 키가 있을 수 있는 글자인가: `"\u0000` 바로 앞이 `{`나 `,`(공백을 건너뛴다)인 자리가 있다.
/// 거짓이면 표시 객체도 NUL 키도 없다. 참이면 배열 안의 NUL로 시작하는 글자 값일 수도 있다(그때는 읽어 보고 같은 글자가 나온다)
fn may_have_nul_key(json: &str) -> bool {
    const NEEDLE: &str = "\"\\u0000";
    let bytes = json.as_bytes();
    json.match_indices(NEEDLE).any(|(at, _)| {
        let mut back = at;
        while back > 0 && matches!(bytes[back - 1], b' ' | b'\t' | b'\n' | b'\r') {
            back -= 1;
        }
        back > 0 && matches!(bytes[back - 1], b'{' | b',')
    })
}

/// 기록의 이벤트 글자 → 저장 파일의 글자(`JSON.stringify(decodeEvents(글자))`)
pub(crate) fn event_to_file(json: &str) -> Result<Cow<'_, str>, String> {
    if !json.contains("\\u0000") || !may_have_nul_key(json) {
        return Ok(Cow::Borrowed(json));
    }
    match parse_encoded(json) {
        Ok(value) => {
            let mut out = String::with_capacity(json.len());
            write_value(&value, Mode::ToFile, &mut out);
            Ok(Cow::Owned(out))
        }
        Err(ReadFail::Invalid) => Err("기록의 이벤트가 JSON이 아닙니다".to_owned()),
        Err(ReadFail::TooDeep) => Err("NUL로 시작하는 키가 든 이벤트가 너무 깊어(2,000단계 초과) 저장 파일의 글자로 바꾸지 못했습니다".to_owned()),
    }
}

/// 저장 파일의 이벤트 글자 → 기록의 글자(`encodeEvent(JSON.parse(글자))`)
pub(crate) fn event_from_file(json: &str) -> Result<String, String> {
    match parse_encoded(json) {
        Ok(value) => {
            let mut out = String::with_capacity(json.len());
            write_value(&value, Mode::FromFile, &mut out);
            Ok(out)
        }
        Err(ReadFail::Invalid) => Err("저장 파일의 이벤트가 JSON이 아닙니다".to_owned()),
        Err(ReadFail::TooDeep) => Err("저장 파일의 이벤트가 너무 깊어(2,000단계 초과) 읽지 못했습니다".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nul이_없는_글자는_그대로_쓴다() {
        assert_eq!(event_to_file(r#"{"a":"x\u0000y","b":[1,2]}"#).unwrap(), r#"{"a":"x\u0000y","b":[1,2]}"#);
    }

    #[test]
    fn 표시_객체는_null과_0으로_쓰고_nul_키는_하나를_뗀다() {
        let text = r#"{"type":"agent","n":{"\u0000nf":"NaN"},"i":{"\u0000nf":"Infinity"},"m":{"\u0000nf":"-Infinity"},"z":{"\u0000nf":"-0"},"\u0000\u0000k":1,"s":"a\u0000b"}"#;
        assert_eq!(event_to_file(text).unwrap(), r#"{"type":"agent","n":null,"i":null,"m":null,"z":0,"\u0000k":1,"s":"a\u0000b"}"#);
    }

    #[test]
    fn 표시_객체가_아닌_한_키짜리는_키만_떼고_나머지_표시_객체는_수로_본다() {
        // 값이 알려진 네 글자가 아니면 표시 객체가 아니다: `\u0000nf` 키는 NUL 하나를 떼 `nf`가 된다
        assert_eq!(event_to_file(r#"{"\u0000nf":"x"}"#).unwrap(), r#"{"nf":"x"}"#);
        assert_eq!(event_to_file(r#"{"\u0000nf":["NaN"]}"#).unwrap(), r#"{"nf":["NaN"]}"#);
        assert_eq!(event_to_file(r#"{"\u0000nf":"NaN","a":1}"#).unwrap(), r#"{"nf":"NaN","a":1}"#);
    }

    #[test]
    fn 파일의_수와_키는_기록의_글자로_바꾼다() {
        let text = r#"{"a":1.0,"b":1e0,"c":-0,"d":1e999,"e":-1e999,"f":0.5e1,"g":-0.0,"\u0000k":1,"\u0000nf":2}"#;
        assert_eq!(
            event_from_file(text).unwrap(),
            r#"{"a":1,"b":1,"c":{"\u0000nf":"-0"},"d":{"\u0000nf":"Infinity"},"e":{"\u0000nf":"-Infinity"},"f":5,"g":{"\u0000nf":"-0"},"\u0000\u0000k":1,"\u0000\u0000nf":2}"#
        );
    }

    #[test]
    fn 짝_없는_서로게이트와_예약_글자를_잃지_않는다() {
        let text = "{\"a\":\"\\ud800x\\udc00\",\"b\":\"\u{e010}\u{e000}\",\"c\":\"\u{1F600}\"}";
        assert_eq!(event_from_file(text).unwrap(), text);
        let with_nul = "{\"\\u0000k\":\"\\ud800\\u0000\u{e011}\u{e000}\"}";
        assert_eq!(event_to_file(with_nul).unwrap(), "{\"k\":\"\\ud800\\u0000\u{e011}\u{e000}\"}");
    }

    #[test]
    fn 정수_꼴_키는_앞으로_온다() {
        assert_eq!(event_from_file(r#"{"b":1,"2":2,"1":3}"#).unwrap(), r#"{"1":3,"2":2,"b":1}"#);
        // NUL 키를 떼어 정수 꼴이 되면 자리가 바뀐다(`Object.fromEntries`와 `JSON.stringify`의 순서)
        assert_eq!(event_to_file(r#"{"b":1,"\u00005":2}"#).unwrap(), r#"{"5":2,"b":1}"#);
    }

    #[test]
    fn 깨진_글자와_너무_깊은_글자는_알린다() {
        assert!(event_from_file("{").is_err());
        assert!(event_to_file(&format!("{{\"\\u0000k\":{}", "[".repeat(10))).is_err());
        let deep = format!("{}1{}", "[".repeat(2_100), "]".repeat(2_100));
        assert!(event_from_file(&deep).unwrap_err().contains("너무 깊어"));
        // 키가 없는 깊은 글자는 읽지 않고 그대로 쓴다
        let nul_value_only = format!("{{\"a\":\"\\u0000\",\"b\":{}1{}}}", "[".repeat(2_100), "]".repeat(2_100));
        assert_eq!(event_to_file(&nul_value_only).unwrap(), nul_value_only);
    }

    #[test]
    fn 배열_안의_nul로_시작하는_글자_값은_바뀌지_않는다() {
        assert_eq!(event_to_file(r#"["x","\u0000y"]"#).unwrap(), r#"["x","\u0000y"]"#);
    }
}
