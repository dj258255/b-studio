//! JS가 JSON을 읽고 값을 다루는 규칙을 그대로 따르는 값 모양(ADR-191 2단계 2b-1).
//!
//! 출력 해석 함수(`docker inspect`·`docker stats` 출력 등)는 `JSON.parse`한 값을 모양 검사 없이 읽는다. 값의 종류가 어긋나면 JS는
//! 조용히 `undefined`로 읽거나(`null?.x`), 던지거나(`null.x`, 문자열이 아닌 값의 `.split`), 형을 바꿔 읽는다(`parseFloat(5)`).
//! 이 모듈은 그 읽는 규칙을 한곳에 모은다:
//! - `parse`: `JSON.parse`의 문법. 범위를 넘는 수(`1e999`)는 `Infinity`, 같은 키가 다시 나오면 값만 바꾸고 자리는 처음 것을 지킨다
//! - `JsObject::entries_js_order`: JS 객체의 순서. 정수 꼴 키가 먼저 오름차순, 나머지는 넣은 순서
//! - `truthy`·`to_js_string`·`to_number`·`strict_equals`: JS의 형 변환과 `===`
//!
//! Node와의 경계에서 `NaN`·`Infinity`·`-0`은 JSON으로 쓸 수 없어(`JSON.stringify`는 `null`·`0`으로 바꾼다) 한 키짜리 객체
//! `{"\u0000nf": "Infinity"}`로 주고받는다. 이 키로 시작하는 진짜 키(NUL로 시작하는 키)는 받지 않는다.
//!
//! 의도한 차이: 중첩이 `MAX_DEPTH`를 넘으면 읽지 않는다(JS는 훨씬 깊어도 읽는다). 짝 없는 서로게이트 이스케이프(`\ud800`)는
//! U+FFFD로 읽는다(Rust 문자열은 짝 없는 서로게이트를 담지 못하고, Node로 넘어올 때 어차피 U+FFFD가 된다).

use crate::js;

const MAX_DEPTH: usize = 2000;
/// `NaN`·`Infinity`를 Node와 주고받는 키
pub const NONFINITE_KEY: &str = "\u{0}nf";

#[derive(Clone, Debug, PartialEq, Default)]
pub struct JsObject {
    entries: Vec<(String, JsValue)>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum JsValue {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsValue>),
    Obj(JsObject),
}

impl JsObject {
    pub fn new() -> Self {
        Self::default()
    }

    /// 같은 키가 있으면 값만 바꾸고 자리를 지킨다(JS 객체의 대입)
    pub fn set(&mut self, key: &str, value: JsValue) {
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
        } else {
            self.entries.push((key.to_owned(), value));
        }
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// 넣은 순서
    pub fn entries(&self) -> &[(String, JsValue)] {
        &self.entries
    }

    /// `Object.entries` 순서: 정수 꼴 키(0 이상 2^32-2 이하, 앞에 0이 없는 것)가 먼저 오름차순, 그다음 나머지가 넣은 순서
    pub fn entries_js_order(&self) -> Vec<(&str, &JsValue)> {
        let mut ints: Vec<(u32, &str, &JsValue)> = Vec::new();
        let mut rest: Vec<(&str, &JsValue)> = Vec::new();
        for (k, v) in &self.entries {
            match array_index(k) {
                Some(i) => ints.push((i, k, v)),
                None => rest.push((k, v)),
            }
        }
        ints.sort_by_key(|(i, _, _)| *i);
        ints.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
    }
}

/// 배열 인덱스 꼴(정규 10진, 0..=2^32-2)이면 그 값
fn array_index(key: &str) -> Option<u32> {
    let b = key.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) || (b[0] == b'0' && b.len() > 1) {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n < u64::from(u32::MAX) {
        Some(n as u32)
    } else {
        None
    }
}

/// 객체를 키-값 목록으로 만든다. 값이 `None`인 키는 넣지 않는다(JS에서 `undefined`로 두는 속성은 JSON에 나가지 않는다)
pub fn object(pairs: Vec<(&str, Option<JsValue>)>) -> JsValue {
    let mut o = JsObject::new();
    for (k, v) in pairs {
        if let Some(v) = v {
            o.set(k, v);
        }
    }
    JsValue::Obj(o)
}

impl JsValue {
    pub fn str(s: impl Into<String>) -> JsValue {
        JsValue::Str(s.into())
    }

    /// 점 접근(`value.key`). 객체가 아닌 값은 `undefined`(null 검사는 부르는 쪽: `null.key`는 던지고 `null?.key`는 `undefined`)
    pub fn prop(&self, key: &str) -> Option<&JsValue> {
        match self {
            JsValue::Obj(o) => o.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsValue::Str(s) => Some(s),
            _ => None,
        }
    }

    /// JS 진릿값: `0`, `NaN`, `''`, `null`, `false`만 거짓
    pub fn truthy(&self) -> bool {
        match self {
            JsValue::Null => false,
            JsValue::Bool(b) => *b,
            JsValue::Num(n) => !(*n == 0.0 || n.is_nan()),
            JsValue::Str(s) => !s.is_empty(),
            JsValue::Arr(_) | JsValue::Obj(_) => true,
        }
    }

    /// `String(value)`. 배열은 `join(',')`(null은 빈 문자열), 객체는 `[object Object]`
    pub fn to_js_string(&self) -> String {
        match self {
            JsValue::Null => "null".into(),
            JsValue::Bool(b) => b.to_string(),
            JsValue::Num(n) => js::number_to_string(*n),
            JsValue::Str(s) => s.clone(),
            JsValue::Arr(items) => items.iter().map(|v| if matches!(v, JsValue::Null) { String::new() } else { v.to_js_string() }).collect::<Vec<_>>().join(","),
            JsValue::Obj(_) => "[object Object]".into(),
        }
    }

    /// `Number(value)`
    pub fn to_number(&self) -> f64 {
        match self {
            JsValue::Null => 0.0,
            JsValue::Bool(b) => f64::from(u8::from(*b)),
            JsValue::Num(n) => *n,
            JsValue::Str(s) => js::to_number(s),
            JsValue::Arr(_) | JsValue::Obj(_) => js::to_number(&self.to_js_string()),
        }
    }

    /// `a === b`(객체와 배열은 같은 참조일 때만 같은데, 여기서는 서로 다른 값끼리만 견주므로 늘 다르다)
    pub fn strict_equals(&self, other: &JsValue) -> bool {
        match (self, other) {
            (JsValue::Null, JsValue::Null) => true,
            (JsValue::Bool(a), JsValue::Bool(b)) => a == b,
            (JsValue::Num(a), JsValue::Num(b)) => a == b,
            (JsValue::Str(a), JsValue::Str(b)) => a == b,
            _ => false,
        }
    }
}

/// `a === b`(둘 다 `undefined`면 같다)
pub fn opt_strict_equals(a: Option<&JsValue>, b: Option<&JsValue>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.strict_equals(b),
        _ => false,
    }
}

/// `a ?? b`의 앞 조건: `undefined`나 `null`
pub fn nullish(v: Option<&JsValue>) -> bool {
    matches!(v, None | Some(JsValue::Null))
}

/// 추상 관계 비교 `a < b`. 둘 다 문자열이면 UTF-16 순서, 아니면 수로 견준다(NaN이 끼면 거짓)
pub fn js_less(a: &JsValue, b: &JsValue) -> bool {
    let prim = |v: &JsValue| match v {
        JsValue::Arr(_) | JsValue::Obj(_) => JsValue::Str(v.to_js_string()),
        other => other.clone(),
    };
    let (a, b) = (prim(a), prim(b));
    if let (JsValue::Str(x), JsValue::Str(y)) = (&a, &b) {
        return js::cmp_utf16(x, y) == std::cmp::Ordering::Less;
    }
    a.to_number() < b.to_number()
}

/// `JSON.parse`. 문법 밖이면 이유를 돌려준다
pub fn parse(text: &str) -> Result<JsValue, String> {
    let mut p = Parser { s: text.as_bytes(), text, i: 0, native: false };
    p.document()
}

/// Node와 주고받은 값(`encode`한 것)을 읽는다. `parse`와 같되 `NaN`·`Infinity` 표시 객체를 수로 바꾼다
pub fn parse_native(text: &str) -> Result<JsValue, String> {
    let mut p = Parser { s: text.as_bytes(), text, i: 0, native: true };
    p.document()
}

/// Node로 보낸다: `JSON.stringify`와 같고, 유한하지 않은 수만 표시 객체로 쓴다
pub fn to_native(value: &JsValue) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// `JSON.stringify(값)`(들여쓰기 없음). 유한하지 않은 수는 `null`, `-0`은 `0`, 객체는 JS 순서(정수 꼴 키가 먼저)로 쓴다.
/// `to_native`와 달리 Node로 건네는 경계 표기가 아니라 결과 문자열 그 자체다(edge 설정처럼 JS가 `JSON.stringify`로 만들던 글자)
pub fn stringify(value: &JsValue) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &JsValue, out: &mut String) {
    match value {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Num(n) if n.is_finite() => out.push_str(&js::number_to_string(*n)),
        JsValue::Num(_) => out.push_str("null"),
        JsValue::Str(s) => out.push_str(&js::json_quote(s)),
        JsValue::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        JsValue::Obj(o) => {
            out.push('{');
            for (i, (k, v)) in o.entries_js_order().into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&js::json_quote(k));
                out.push(':');
                write_json(v, out);
            }
            out.push('}');
        }
    }
}

fn write(value: &JsValue, out: &mut String) {
    match value {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Num(n) if n.is_finite() && !(*n == 0.0 && n.is_sign_negative()) => out.push_str(&js::number_to_string(*n)),
        JsValue::Num(n) => {
            // NaN·Infinity와 -0은 JSON 수로 쓸 수 없다(`JSON.stringify(-0)`은 "0")
            let text = if *n == 0.0 { "-0".to_owned() } else { js::number_to_string(*n) };
            out.push('{');
            out.push_str(&js::json_quote(NONFINITE_KEY));
            out.push(':');
            out.push_str(&js::json_quote(&text));
            out.push('}');
        }
        JsValue::Str(s) => out.push_str(&js::json_quote(s)),
        JsValue::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        JsValue::Obj(o) => {
            out.push('{');
            for (i, (k, v)) in o.entries().iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&js::json_quote(k));
                out.push(':');
                write(v, out);
            }
            out.push('}');
        }
    }
}

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
    native: bool,
}

impl Parser<'_> {
    fn err<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("JSON을 읽지 못했습니다({what}, 위치 {})", self.i))
    }

    fn ws(&mut self) {
        while matches!(self.s.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn document(&mut self) -> Result<JsValue, String> {
        self.ws();
        let v = self.value(0)?;
        self.ws();
        if self.i != self.s.len() {
            return self.err("끝에 남은 글자");
        }
        Ok(v)
    }

    fn value(&mut self, depth: usize) -> Result<JsValue, String> {
        if depth > MAX_DEPTH {
            return self.err("너무 깊은 중첩");
        }
        match self.s.get(self.i) {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(JsValue::Str(self.string()?)),
            Some(b't') => self.literal("true", JsValue::Bool(true)),
            Some(b'f') => self.literal("false", JsValue::Bool(false)),
            Some(b'n') => self.literal("null", JsValue::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.err("값이 아닌 글자"),
        }
    }

    fn literal(&mut self, word: &str, value: JsValue) -> Result<JsValue, String> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(value)
        } else {
            self.err("알 수 없는 낱말")
        }
    }

    fn number(&mut self) -> Result<JsValue, String> {
        let start = self.i;
        if self.s.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return self.err("숫자"),
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            if !self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                return self.err("소수점 뒤 숫자");
            }
            self.digits();
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                return self.err("지수");
            }
            self.digits();
        }
        let n: f64 = self.text[start..self.i].parse().map_err(|_| "숫자를 읽지 못했습니다".to_owned())?;
        Ok(JsValue::Num(n))
    }

    fn digits(&mut self) {
        while self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
            self.i += 1;
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let slice = self.s.get(self.i..self.i + 4).ok_or("\\u 이스케이프가 짧습니다")?;
        let mut n = 0;
        for &b in slice {
            n = n * 16 + (b as char).to_digit(16).ok_or("\\u 이스케이프가 올바르지 않습니다")?;
        }
        self.i += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1; // 여는 따옴표
        let mut out = String::new();
        loop {
            let run_start = self.i;
            while let Some(&b) = self.s.get(self.i) {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.i += 1;
            }
            out.push_str(&self.text[run_start..self.i]);
            match self.s.get(self.i) {
                None => return self.err("닫히지 않은 문자열"),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = *self.s.get(self.i).ok_or("이스케이프가 끝났습니다")?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            if (0xD800..0xDC00).contains(&first) && self.s[self.i..].starts_with(b"\\u") {
                                let save = self.i;
                                self.i += 2;
                                let second = self.hex4()?;
                                if (0xDC00..0xE000).contains(&second) {
                                    let cp = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
                                    out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                                } else {
                                    out.push('\u{FFFD}');
                                    self.i = save;
                                }
                            } else {
                                out.push(char::from_u32(first).unwrap_or('\u{FFFD}'));
                            }
                        }
                        _ => return self.err("알 수 없는 이스케이프"),
                    }
                }
                Some(_) => return self.err("문자열 안의 제어 문자"),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<JsValue, String> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(JsValue::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(JsValue::Arr(items));
                }
                _ => return self.err("배열의 쉼표나 닫는 괄호"),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<JsValue, String> {
        self.i += 1;
        let mut obj = JsObject::new();
        self.ws();
        if self.s.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(JsValue::Obj(obj));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return self.err("객체의 키");
            }
            let key = self.string()?;
            if key.starts_with('\u{0}') && !(self.native && key == NONFINITE_KEY) {
                return self.err("NUL로 시작하는 키는 받지 않습니다");
            }
            self.ws();
            if self.s.get(self.i) != Some(&b':') {
                return self.err("콜론");
            }
            self.i += 1;
            self.ws();
            let value = self.value(depth + 1)?;
            obj.set(&key, value);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(self.finish_object(obj));
                }
                _ => return self.err("객체의 쉼표나 닫는 괄호"),
            }
        }
    }

    /// 받은 값에서 `NaN`·`Infinity` 표시 객체(NUL로 시작하는 키 하나)를 수로 바꾼다. 진짜 객체는 NUL 키를 갖지 못한다
    fn finish_object(&self, obj: JsObject) -> JsValue {
        if self.native {
            if let [(key, JsValue::Str(text))] = obj.entries() {
                if key == NONFINITE_KEY {
                    return match text.as_str() {
                        "-0" => JsValue::Num(-0.0),
                        "Infinity" => JsValue::Num(f64::INFINITY),
                        "-Infinity" => JsValue::Num(f64::NEG_INFINITY),
                        _ => JsValue::Num(f64::NAN),
                    };
                }
            }
        }
        JsValue::Obj(obj)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 범위를_넘는_수는_무한대로_읽는다() {
        assert_eq!(parse("1e999").unwrap(), JsValue::Num(f64::INFINITY));
        assert_eq!(parse("-1e999").unwrap(), JsValue::Num(f64::NEG_INFINITY));
        assert_eq!(parse("-0").unwrap(), JsValue::Num(-0.0));
    }

    #[test]
    fn js_json_문법만_받는다() {
        for bad in ["", " ", "{,}", "[1,]", "{\"a\":1,}", "01", "1.", ".5", "+1", "'a'", "[1 2]", "{\"a\" 1}", "nul", "\"\t\"", "\u{a0}1", "\u{feff}1", "1 2", "{\"a\":1}x", "NaN", "Infinity", "\"\\x41\"", "\"\\u12\""] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        for good in [" 1 ", "\t[ ]\n", "{\"a\" : [ 1 , 2 ] }", "\"\\u0041\\/\"", "true", "null", "-1.5e+3", "0e0"] {
            assert!(parse(good).is_ok(), "{good:?}");
        }
    }

    #[test]
    fn 짝_없는_서로게이트는_대체_문자로_읽는다() {
        assert_eq!(parse("\"\\ud800\"").unwrap(), JsValue::str("\u{FFFD}"));
        assert_eq!(parse("\"\\ud83d\\ude00\"").unwrap(), JsValue::str("😀"));
        assert_eq!(parse("\"\\ud800\\u0041\"").unwrap(), JsValue::str("\u{FFFD}A"));
        assert_eq!(parse("\"\\udc00\"").unwrap(), JsValue::str("\u{FFFD}"));
    }

    #[test]
    fn 같은_키가_다시_나오면_값만_바꾸고_자리를_지킨다() {
        let v = parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        let JsValue::Obj(o) = v else { panic!() };
        assert_eq!(o.entries().iter().map(|(k, v)| (k.as_str(), v.clone())).collect::<Vec<_>>(), vec![("a", JsValue::Num(3.0)), ("b", JsValue::Num(2.0))]);
    }

    #[test]
    fn 객체_순서는_정수_꼴_키가_먼저다() {
        let v = parse(r#"{"b":1,"10":2,"2":3,"a":4,"01":5,"4294967295":6,"4294967294":7}"#).unwrap();
        let JsValue::Obj(o) = v else { panic!() };
        let keys: Vec<&str> = o.entries_js_order().into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, vec!["2", "10", "4294967294", "b", "a", "01", "4294967295"]);
    }

    #[test]
    fn 너무_깊은_중첩은_읽지_않는다() {
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 5), "]".repeat(MAX_DEPTH + 5));
        assert!(parse(&deep).is_err());
        let ok = format!("{}{}", "[".repeat(100), "]".repeat(100));
        assert!(parse(&ok).is_ok());
    }

    #[test]
    fn nul로_시작하는_키는_받지_않는다() {
        assert!(parse("{\"\\u0000nf\":\"NaN\"}").is_err());
        assert!(parse("{\"a\\u0000\":1}").is_ok());
    }

    #[test]
    fn 유한하지_않은_수는_표시_객체로_오간다() {
        let v = JsValue::Arr(vec![JsValue::Num(f64::NAN), JsValue::Num(f64::INFINITY), JsValue::Num(-f64::INFINITY), JsValue::Num(1.5e300), JsValue::Num(-0.0), JsValue::Num(0.0)]);
        let text = to_native(&v);
        assert_eq!(text, "[{\"\\u0000nf\":\"NaN\"},{\"\\u0000nf\":\"Infinity\"},{\"\\u0000nf\":\"-Infinity\"},1.5e+300,{\"\\u0000nf\":\"-0\"},0]");
        match parse_native(&text).unwrap() {
            JsValue::Arr(items) => {
                assert!(matches!(items[0], JsValue::Num(n) if n.is_nan()));
                assert_eq!(items[1], JsValue::Num(f64::INFINITY));
                assert_eq!(items[2], JsValue::Num(f64::NEG_INFINITY));
                assert_eq!(items[3], JsValue::Num(1.5e300));
                assert!(matches!(items[4], JsValue::Num(n) if n == 0.0 && n.is_sign_negative()));
                assert!(matches!(items[5], JsValue::Num(n) if n == 0.0 && n.is_sign_positive()));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn js의_형_변환을_따른다() {
        let arr = parse(r#"[1,null,[2,3],"x"]"#).unwrap();
        assert_eq!(arr.to_js_string(), "1,,2,3,x");
        assert_eq!(parse("{}").unwrap().to_js_string(), "[object Object]");
        assert_eq!(JsValue::Null.to_js_string(), "null");
        assert!(JsValue::str("0").truthy());
        assert!(!JsValue::Num(f64::NAN).truthy());
        assert!(JsValue::Arr(vec![]).truthy());
        assert_eq!(parse("[5]").unwrap().to_number(), 5.0);
        assert_eq!(JsValue::str("0x10").to_number(), 16.0);
        assert!(js_less(&JsValue::str("a"), &JsValue::str("b")));
        assert!(!js_less(&JsValue::Num(f64::NAN), &JsValue::Num(1.0)));
        assert!(!js_less(&JsValue::str("10"), &JsValue::Num(9.0)));
    }
}

#[cfg(test)]
mod stringify_tests {
    use super::*;

    #[test]
    fn json_stringify처럼_쓴다() {
        let v = parse(r#"{"b":1,"2":[null,true,-0.0,1e21,1e-7,"a\"\\\n/ \u007f"],"1":{}}"#).unwrap();
        assert_eq!(stringify(&v), "{\"1\":{},\"2\":[null,true,0,1e+21,1e-7,\"a\\\"\\\\\\n/\u{2028}\u{7f}\"],\"b\":1}");
        assert_eq!(stringify(&JsValue::Arr(vec![JsValue::Num(f64::NAN), JsValue::Num(f64::INFINITY)])), "[null,null]");
    }
}
