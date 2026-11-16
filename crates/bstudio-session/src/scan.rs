//! JSON 글자를 깊이 제한 없이 훑는다(ADR-203, 4f B1b). 값을 만들지 않고 최상위 객체의 멤버 자리만 돌려준다.
//!
//! 저장 파일과 기록의 이벤트는 `JSON.parse`가 읽는 글자다. `js_json`은 2,000단계까지만 읽지만(JS는 훨씬 깊어도 읽는다)
//! 여기서는 반복으로 훑어 깊이에 제한이 없다. 문법은 `JSON.parse`와 같다: 공백은 스페이스·탭·줄바꿈·캐리지 리턴뿐이고,
//! 끝의 쉼표·주석·앞의 BOM·`01` 같은 수·문자열 안의 제어 문자(U+0000..U+001F)는 틀린 글자다. 같은 키가 여러 번 나오는 것은 틀리지 않다.

use std::ops::Range;

pub(crate) struct Member {
    /// 키(짝 없는 서로게이트 이스케이프는 U+FFFD로 푼다. 이름을 견주는 데만 쓴다)
    pub key: String,
    /// 키의 따옴표부터 값의 끝까지(`"key": value`의 원문)
    pub text: Range<usize>,
    pub value: Range<usize>,
}

pub(crate) enum Scanned {
    /// JSON이 아니다
    Invalid,
    /// JSON이지만 객체가 아니다
    NotObject,
    Object(Vec<Member>),
}

fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while matches!(bytes.get(at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        at += 1;
    }
    at
}

/// `at`의 여는 따옴표부터 닫는 따옴표 다음까지. 풀어 쓴 글자는 `decoded`가 있으면 거기에 쌓는다
fn skip_string(text: &str, at: usize, mut decoded: Option<&mut String>) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = at + 1;
    loop {
        let run = i;
        while let Some(&b) = bytes.get(i) {
            if b == b'"' || b == b'\\' || b < 0x20 {
                break;
            }
            i += 1;
        }
        if let Some(out) = decoded.as_deref_mut() {
            out.push_str(&text[run..i]);
        }
        match bytes.get(i)? {
            b'"' => return Some(i + 1),
            b'\\' => {
                let escape = *bytes.get(i + 1)?;
                i += 2;
                let simple = match escape {
                    b'"' => Some('"'),
                    b'\\' => Some('\\'),
                    b'/' => Some('/'),
                    b'b' => Some('\u{8}'),
                    b'f' => Some('\u{c}'),
                    b'n' => Some('\n'),
                    b'r' => Some('\r'),
                    b't' => Some('\t'),
                    b'u' => None,
                    _ => return None,
                };
                match simple {
                    Some(c) => {
                        if let Some(out) = decoded.as_deref_mut() {
                            out.push(c);
                        }
                    }
                    None => {
                        let unit = hex4(bytes, i)?;
                        i += 4;
                        let mut c = char::from_u32(unit);
                        // 높은 서로게이트 다음에 낮은 서로게이트 이스케이프가 이어지면 한 글자다
                        if (0xD800..0xDC00).contains(&unit) && bytes.get(i) == Some(&b'\\') && bytes.get(i + 1) == Some(&b'u') {
                            if let Some(low) = hex4(bytes, i + 2) {
                                if (0xDC00..0xE000).contains(&low) {
                                    c = char::from_u32(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00));
                                    i += 6;
                                }
                            }
                        }
                        if let Some(out) = decoded.as_deref_mut() {
                            out.push(c.unwrap_or('\u{FFFD}'));
                        }
                    }
                }
            }
            _ => return None,
        }
    }
}

fn hex4(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    let mut n = 0;
    for &b in slice {
        n = n * 16 + (b as char).to_digit(16)?;
    }
    Some(n)
}

fn skip_number(bytes: &[u8], mut i: usize) -> Option<usize> {
    let digits = |mut at: usize| {
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        at
    };
    if bytes.get(i) == Some(&b'-') {
        i += 1;
    }
    match bytes.get(i)? {
        b'0' => i += 1,
        b'1'..=b'9' => i = digits(i),
        _ => return None,
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        if !bytes.get(i).is_some_and(u8::is_ascii_digit) {
            return None;
        }
        i = digits(i);
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if !bytes.get(i).is_some_and(u8::is_ascii_digit) {
            return None;
        }
        i = digits(i);
    }
    Some(i)
}

/// 객체의 키와 콜론을 읽고 값이 시작할 자리를 돌려준다
fn skip_key(text: &str, at: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let at = skip_ws(bytes, at);
    if bytes.get(at) != Some(&b'"') {
        return None;
    }
    let end = skip_string(text, at, None)?;
    let end = skip_ws(bytes, end);
    (bytes.get(end) == Some(&b':')).then_some(end + 1)
}

enum Open {
    Array,
    Object,
}

/// `at`에서 시작하는 값 하나(앞 공백은 건너뛴다)를 끝까지 훑어 끝 자리를 돌려준다. 값이 틀렸으면 없다
pub(crate) fn skip_value(text: &str, at: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut stack: Vec<Open> = Vec::new();
    let mut i = at;
    loop {
        // 값 하나가 시작한다
        i = skip_ws(bytes, i);
        match bytes.get(i)? {
            b'{' => {
                i = skip_ws(bytes, i + 1);
                if bytes.get(i) == Some(&b'}') {
                    i += 1;
                } else {
                    stack.push(Open::Object);
                    i = skip_key(text, i)?;
                    continue;
                }
            }
            b'[' => {
                i = skip_ws(bytes, i + 1);
                if bytes.get(i) == Some(&b']') {
                    i += 1;
                } else {
                    stack.push(Open::Array);
                    continue;
                }
            }
            b'"' => i = skip_string(text, i, None)?,
            b't' if bytes[i..].starts_with(b"true") => i += 4,
            b'f' if bytes[i..].starts_with(b"false") => i += 5,
            b'n' if bytes[i..].starts_with(b"null") => i += 4,
            b'-' | b'0'..=b'9' => i = skip_number(bytes, i)?,
            _ => return None,
        }
        // 값 하나가 끝났다: 닫는 괄호를 만나는 만큼 닫고, 쉼표를 만나면 다음 값으로
        loop {
            if stack.is_empty() {
                return Some(i);
            }
            i = skip_ws(bytes, i);
            match stack.last() {
                None => return Some(i),
                Some(Open::Array) => match bytes.get(i)? {
                    b',' => {
                        i += 1;
                        break;
                    }
                    b']' => {
                        i += 1;
                        stack.pop();
                    }
                    _ => return None,
                },
                Some(Open::Object) => match bytes.get(i)? {
                    b',' => {
                        i = skip_key(text, i + 1)?;
                        break;
                    }
                    b'}' => {
                        i += 1;
                        stack.pop();
                    }
                    _ => return None,
                },
            }
        }
    }
}

/// 글자 전체가 JSON 값 하나인지 훑는다. 최상위가 객체면 멤버를 돌려준다
pub(crate) fn scan_document(text: &str) -> Scanned {
    let bytes = text.as_bytes();
    let start = skip_ws(bytes, 0);
    if bytes.get(start) != Some(&b'{') {
        return match skip_value(text, start) {
            Some(end) if skip_ws(bytes, end) == bytes.len() => Scanned::NotObject,
            _ => Scanned::Invalid,
        };
    }
    let mut members = Vec::new();
    let mut i = skip_ws(bytes, start + 1);
    if bytes.get(i) == Some(&b'}') {
        return if skip_ws(bytes, i + 1) == bytes.len() { Scanned::Object(members) } else { Scanned::Invalid };
    }
    loop {
        i = skip_ws(bytes, i);
        if bytes.get(i) != Some(&b'"') {
            return Scanned::Invalid;
        }
        let key_start = i;
        let mut key = String::new();
        let Some(key_end) = skip_string(text, i, Some(&mut key)) else { return Scanned::Invalid };
        // 따옴표 두 개를 뗀 이스케이프 풀이는 `decoded`에 따옴표 없이 쌓인다
        let colon = skip_ws(bytes, key_end);
        if bytes.get(colon) != Some(&b':') {
            return Scanned::Invalid;
        }
        let value_start = skip_ws(bytes, colon + 1);
        let Some(value_end) = skip_value(text, value_start) else { return Scanned::Invalid };
        members.push(Member { key, text: key_start..value_end, value: value_start..value_end });
        i = skip_ws(bytes, value_end);
        match bytes.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => {
                return if skip_ws(bytes, i + 1) == bytes.len() { Scanned::Object(members) } else { Scanned::Invalid };
            }
            _ => return Scanned::Invalid,
        }
    }
}

/// 배열 값의 원소 자리들. 배열이 아니면 없다(`array`는 `[`부터 `]`까지의 자리)
pub(crate) fn split_array(text: &str, array: Range<usize>) -> Option<Vec<Range<usize>>> {
    let bytes = text.as_bytes();
    if bytes.get(array.start) != Some(&b'[') {
        return None;
    }
    let mut items = Vec::new();
    let mut i = skip_ws(bytes, array.start + 1);
    if bytes.get(i) == Some(&b']') {
        return Some(items);
    }
    loop {
        i = skip_ws(bytes, i);
        let end = skip_value(text, i)?;
        items.push(i..end);
        i = skip_ws(bytes, end);
        match bytes.get(i)? {
            b',' => i += 1,
            b']' => return Some(items),
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid(text: &str) -> bool {
        !matches!(scan_document(text), Scanned::Invalid)
    }

    #[test]
    fn json_parse와_같은_문법으로_받는다() {
        for ok in ["{}", " {\"a\":1} ", "[1,2]", "1", "\"x\"", "null", "true", "-0", "1e999", "{\"a\":{\"b\":[1,{\"c\":null}]},\"a\":2}", "\"\u{2028}\"", "{\"\\ud800\":1}"] {
            assert!(valid(ok), "{ok}");
        }
        for bad in ["", "{", "{\"a\":1,}", "[1,]", "01", "1.", ".5", "+1", "NaN", "'a'", "{a:1}", "\"\n\"", "\"\\x\"", "\"\\u12\"", "{\"a\" 1}", "[1 2]", "{}{}", "\u{feff}{}", "{\"a\":1}x", "nul", "\u{b}{}"] {
            assert!(!valid(bad), "{bad:?}");
        }
    }

    #[test]
    fn 깊이_제한이_없다() {
        let deep = format!("{{\"a\":{}1{}}}", "[".repeat(50_000), "]".repeat(50_000));
        assert!(valid(&deep));
        assert!(!valid(&format!("{{\"a\":{}1{}}}", "[".repeat(50_000), "]".repeat(49_999))));
    }

    #[test]
    fn 최상위_멤버의_자리를_돌려준다() {
        let text = " {\"a\" : 1 , \"h\\u0069story\":[1, {\"x\":2}] ,\"a\":\"z\"} ";
        let Scanned::Object(members) = scan_document(text) else { panic!("객체") };
        assert_eq!(members.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(), ["a", "history", "a"]);
        assert_eq!(&text[members[1].value.clone()], "[1, {\"x\":2}]");
        assert_eq!(&text[members[1].text.clone()], "\"h\\u0069story\":[1, {\"x\":2}]");
        assert_eq!(split_array(text, members[1].value.clone()).unwrap().iter().map(|r| &text[r.clone()]).collect::<Vec<_>>(), ["1", "{\"x\":2}"]);
        assert!(matches!(scan_document("[1]"), Scanned::NotObject));
        assert!(split_array("{}", 0..2).is_none());
        assert_eq!(split_array("[]", 0..2).unwrap().len(), 0);
    }
}
