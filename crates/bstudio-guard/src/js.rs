//! JS가 문자열을 읽는 규칙을 그대로 따르는 도우미.
//!
//! 옮기기 전의 TS 판정과 같은 입력에 같은 결과를 내야 한다(ADR-191 결정 3·4). Rust 표준 함수는 몇 군데서 JS와 다르게 읽는다:
//! `str::trim`은 BOM(U+FEFF)을 지우지 않고 U+0085를 지운다, `str::len`은 UTF-16이 아니라 바이트 수다, `String`의 비교는
//! UTF-16 코드 단위 순서와 다르다. 그 차이를 여기 한곳에 모은다.

/// JS 정규식의 `\s`, `String.prototype.trim`이 공백으로 보는 글자(WhiteSpace + LineTerminator).
/// Rust의 `char::is_whitespace`(Unicode White_Space)와 다르다: U+FEFF는 JS만, U+0085는 Rust만 공백으로 본다.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{FEFF}' // WhiteSpace(Zs 밖)
            | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' // Zs
            | '\u{000A}' | '\u{000D}' | '\u{2028}' | '\u{2029}' // LineTerminator
    )
}

/// JS 정규식의 `.`(s 플래그 없음)이 맞지 않는 글자
pub fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String.prototype.trim`
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// JS 문자열의 `length`(UTF-16 코드 단위 수)
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `Array.prototype.sort()`의 기본 비교(UTF-16 코드 단위 순서)
pub fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `encodeURIComponent`. 그대로 두는 글자는 `A-Z a-z 0-9 - _ . ! ~ * ' ( )`뿐이고, 나머지는 UTF-8 바이트마다 `%XX`(대문자)
pub fn encode_uri_component(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len());
    for &byte in s.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0F) as usize] as char);
        }
    }
    out
}

/// `Buffer.prototype.toString('base64')`: 표준 알파벳(`+/`)과 `=` 패딩
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// ASCII 문자열에 쓰는 `String.prototype.slice(start, end)`(음수 없음). 범위를 넘으면 잘라 맞추고, 끝이 시작보다 앞이면 빈 문자열
pub fn slice_ascii(s: &str, start: usize, end: usize) -> &str {
    debug_assert!(s.is_ascii());
    let len = s.len();
    let (start, end) = (start.min(len), end.min(len));
    if end <= start {
        ""
    } else {
        &s[start..end]
    }
}

/// JS `s.slice(0, n)`: 앞에서 UTF-16 코드 단위 `n`개. 서로게이트 쌍을 자르면 U+FFFD가 된다(Node 경계 규칙과 같다, js_json 참고)
pub fn truncate_utf16(s: &str, n: usize) -> String {
    if utf16_len(s) <= n {
        return s.to_owned();
    }
    String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<u16>>())
}


/// `String.prototype.trimEnd`
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// JS 정규식의 `\s`를 정규식 글자 모임 안에 쓸 꼴(`[` `]` 없이). Rust `regex`의 `\s`는 U+0085를 포함하고 U+FEFF를 빼서 쓰지 않는다
pub const WS_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
/// JS 정규식의 `.`(s 플래그 없음)에 해당하는 글자 모임(`[` `]` 없이 쓰는 부정 모임의 안쪽)
pub const LINE_TERMINATORS: &str = r"\n\r\x{2028}\x{2029}";

/// `line.trim().split(/\s+/)`. 빈 줄은 `['']`가 된다(JS 그대로)
pub fn split_ws(line: &str) -> Vec<&str> {
    let t = trim(line);
    if t.is_empty() {
        return vec![""];
    }
    t.split(is_js_whitespace).filter(|p| !p.is_empty()).collect()
}

/// `/:(\d+)$/.exec(s)?.[1]`: 끝이 `:숫자`인 자리의 숫자들. 숫자는 ASCII 0-9뿐이다(JS `\d`)
pub fn trailing_colon_digits(s: &str) -> Option<&str> {
    let idx = s.rfind(':')?;
    let digits = &s[idx + 1..];
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        Some(digits)
    } else {
        None
    }
}

/// 안정 정렬. `cmp(a, b)`가 양수면 a가 b보다 뒤다(JS 비교 함수의 부호). NaN은 0으로 본다(`Array.prototype.sort`의 SortCompare)
pub fn stable_sort_by<T: Clone>(items: Vec<T>, cmp: &dyn Fn(&T, &T) -> f64) -> Vec<T> {
    if items.len() <= 1 {
        return items;
    }
    let mid = items.len() / 2;
    let right = stable_sort_by(items[mid..].to_vec(), cmp);
    let left = stable_sort_by(items[..mid].to_vec(), cmp);
    let mut out = Vec::with_capacity(left.len() + right.len());
    let (mut i, mut j) = (0, 0);
    while i < left.len() && j < right.len() {
        let c = cmp(&left[i], &right[j]);
        if c > 0.0 {
            out.push(right[j].clone());
            j += 1;
        } else {
            out.push(left[i].clone());
            i += 1;
        }
    }
    out.extend_from_slice(&left[i..]);
    out.extend_from_slice(&right[j..]);
    out
}

/// `Array.prototype.slice(start)`의 시작 위치. 음수는 끝에서부터, NaN은 0, 소수는 0쪽으로 버린다
pub fn relative_start(len: usize, start: f64) -> usize {
    let n = if start.is_nan() { 0.0 } else { start.trunc() };
    if n < 0.0 {
        let from_end = len as f64 + n;
        if from_end < 0.0 {
            0
        } else {
            from_end as usize
        }
    } else if n > len as f64 {
        len
    } else {
        n as usize
    }
}

/// 양의 유한한 수의 가장 짧게 되읽히는 10진 자릿수와 첫 자리의 10의 지수(`1.2345e-7` → ("12345", -7)).
/// 같은 길이의 후보가 둘이고 x가 정확히 그 가운데이면 ECMAScript는 끝자리가 짝수인 쪽을 고른다(Rust `{:e}`는 위쪽을 고를 때가 있다:
/// 623525043763220.25는 JS가 `…220.2`, Rust 표준 출력은 `…220.3`)
pub fn shortest_digits(x: f64) -> (String, i32) {
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').expect("지수 표기");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp = exp.parse::<i32>().expect("지수");
    // 가운데가 되려면 정확한 값이 k+1자리여야 하고, 같은 길이 후보가 둘 다 되읽히는 것은 k가 16 이상일 때뿐이다
    let k = digits.len();
    if k >= 16 {
        let exact = format!("{x:.1100}");
        let (int_part, frac_part) = exact.split_once('.').expect("소수점");
        let all = format!("{int_part}{}", frac_part.trim_end_matches('0'));
        let sig = all.trim_start_matches('0');
        if sig.len() == k + 1 && sig.ends_with('5') {
            // 정확한 값은 `F(k자리) + 5`: 후보는 F와 F+1이고, ECMAScript는 끝자리가 짝수인 쪽을 고른다
            let mut chosen = sig.as_bytes()[..k].to_vec();
            if (chosen[k - 1] - b'0') % 2 == 1 && chosen[k - 1] < b'9' {
                chosen[k - 1] += 1;
            }
            if (chosen[k - 1] - b'0') % 2 == 0 {
                let text = String::from_utf8(chosen).expect("ascii");
                // 2의 거듭제곱 바로 위아래는 간격이 비대칭이라 한쪽 후보는 되읽히지 않을 수 있다: 되읽히는 후보만 쓴다
                if format!("{}.{}e{exp}", &text[..1], &text[1..]).parse::<f64>() == Ok(x) {
                    return (text, exp);
                }
            }
        }
    }
    (digits, exp)
}

/// JS `Number::toString()`(10진). 가장 짧게 되읽히는 자릿수를 쓰고, 지수가 21 이상이거나 -7 이하이면 `e` 표기
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    let (digits, exp) = shortest_digits(x);
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

/// `Number.prototype.toFixed(f)`. 정확한 값을 반올림하고 가운데는 큰 쪽(0에서 먼 쪽)으로 한다. Rust `{:.N}`은 가운데를 짝수로 보내 다르다
pub fn to_fixed(x: f64, f: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 {
        return number_to_string(x);
    }
    let neg = x < 0.0;
    // 이중 정밀도의 정확한 10진 전개는 소수 1074자리 안에 끝난다
    let exact = format!("{:.1100}", x.abs());
    let (int_part, frac_part) = exact.split_once('.').expect("소수점");
    let mut digits: Vec<u8> = int_part.bytes().chain(frac_part.bytes().take(f)).collect();
    if frac_part.as_bytes().get(f).is_some_and(|d| *d >= b'5') {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let int_len = digits.len() - f;
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(std::str::from_utf8(&digits[..int_len]).expect("ascii"));
    if f > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(&digits[int_len..]).expect("ascii"));
    }
    out
}

/// `Math.round`: 가운데는 +무한대 쪽으로 간다(Rust `f64::round`는 0에서 먼 쪽이라 음수에서 다르다)
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Number.parseInt(s, 10)`: 앞 공백을 건너뛰고 부호와 10진수 앞부분만 읽는다. 읽을 숫자가 없으면 NaN
pub fn parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_whitespace);
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let len = rest.bytes().take_while(u8::is_ascii_digit).count();
    if len == 0 {
        return f64::NAN;
    }
    let value: f64 = rest[..len].parse().expect("10진 숫자");
    if neg {
        -value
    } else {
        value
    }
}

/// `Number.parseFloat(s)`: 앞 공백을 건너뛰고 10진 실수 표기의 앞부분만 읽는다(`Infinity` 포함, 16진수 아님). 읽을 것이 없으면 NaN
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_whitespace);
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let signed = |v: f64| if neg { -v } else { v };
    if rest.starts_with("Infinity") {
        return signed(f64::INFINITY);
    }
    match decimal_prefix_len(rest) {
        Some(len) => signed(rest[..len].parse().expect("10진 실수")),
        None => f64::NAN,
    }
}

/// 문자열 앞에서 `Digits [. Digits?] | . Digits` 와 선택적 지수를 읽은 바이트 길이
fn decimal_prefix_len(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int_len = digits(0);
    let mut end = int_len;
    if end < b.len() && b[end] == b'.' {
        let frac = digits(end + 1);
        if int_len == 0 && frac == 0 {
            return None;
        }
        end += 1 + frac;
    } else if int_len == 0 {
        return None;
    }
    if end < b.len() && (b[end] == b'e' || b[end] == b'E') {
        let mut e = end + 1;
        if e < b.len() && (b[e] == b'+' || b[e] == b'-') {
            e += 1;
        }
        let exp_digits = digits(e);
        if exp_digits > 0 {
            end = e + exp_digits;
        }
    }
    Some(end)
}

/// `Number(string)`: 앞뒤 공백 무시, 빈 문자열은 0, `0x`·`0o`·`0b`와 `Infinity`와 지수 표기를 받고, 그 밖은 NaN
pub fn to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix_body = |prefix: &[&str], radix: u32| -> Option<f64> {
        let rest = prefix.iter().find_map(|p| t.strip_prefix(p))?;
        if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
            return Some(f64::NAN);
        }
        Some(match u128::from_str_radix(rest, radix) {
            Ok(v) => v as f64,
            Err(_) => rest.chars().fold(0.0, |acc, c| acc * f64::from(radix) + f64::from(c.to_digit(radix).expect("자리"))),
        })
    };
    if let Some(v) = radix_body(&["0x", "0X"], 16).or_else(|| radix_body(&["0o", "0O"], 8)).or_else(|| radix_body(&["0b", "0B"], 2)) {
        return v;
    }
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let signed = |v: f64| if neg { -v } else { v };
    if rest == "Infinity" {
        return signed(f64::INFINITY);
    }
    match decimal_prefix_len(rest) {
        Some(len) if len == rest.len() => signed(rest.parse().expect("10진 실수")),
        _ => f64::NAN,
    }
}

/// `JSON.stringify(문자열)`: 따옴표, 역슬래시, 제어 문자만 이스케이프한다(U+2028·2029는 그대로)
pub fn json_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
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
    }
    out.push('"');
    out
}

// ── 짝 없는 서로게이트의 단사 인코딩(`@b-studio/sandbox`의 `encodeLoneSurrogates`)을 읽고 쓰는 도우미 ──
// 짝 없는 서로게이트 단위 u는 U+E010 + 니블 셋(u>>8·u>>4·u 각 하위 4비트를 U+E000+n으로), 글자 그대로의 예약 글자(U+E000..U+E01F) r은
// U+E011 + 니블 둘(r-0xE000의 상·하위 4비트)로 쓴다.

fn nibble_char(n: u32) -> char {
    char::from_u32(0xE000 + n).unwrap_or('\u{FFFD}')
}

fn nibble_value(c: char) -> Option<u32> {
    let u = c as u32;
    (0xE000..=0xE00F).contains(&u).then(|| u - 0xE000)
}

/// 짝 없는 서로게이트 단위(0xD800..=0xDFFF)의 인코딩
pub fn encode_lone_unit(unit: u32) -> String {
    [char::from_u32(0xE010).unwrap_or('\u{FFFD}'), nibble_char((unit >> 8) & 0xF), nibble_char((unit >> 4) & 0xF), nibble_char(unit & 0xF)].iter().collect()
}

/// 예약 글자(U+E000..=U+E01F) 하나의 인코딩. 예약 글자가 아니면 그대로
pub fn encode_reserved_char(c: char) -> String {
    let u = c as u32;
    if (0xE000..=0xE01F).contains(&u) {
        let r = u - 0xE000;
        [char::from_u32(0xE011).unwrap_or('\u{FFFD}'), nibble_char(r >> 4), nibble_char(r & 0xF)].iter().collect()
    } else {
        c.to_string()
    }
}

/// `chars[at..]`가 인코딩 이스케이프로 시작하면 (풀어 쓴 값, 먹은 글자 수). 짝 없는 서로게이트 단위는 `Err(단위)`, 예약 글자는 `Ok(글자)`
pub fn read_lone_escape(chars: &[char], at: usize) -> Option<(Result<char, u32>, usize)> {
    match chars.get(at).copied()? as u32 {
        0xE010 => {
            let (a, b, c) = (nibble_value(*chars.get(at + 1)?)?, nibble_value(*chars.get(at + 2)?)?, nibble_value(*chars.get(at + 3)?)?);
            Some((Err(0xD000 | (a << 8) | (b << 4) | c), 4))
        }
        0xE011 => {
            let (a, b) = (nibble_value(*chars.get(at + 1)?)?, nibble_value(*chars.get(at + 2)?)?);
            Some((Ok(char::from_u32(0xE000 + ((a << 4) | b))?), 3))
        }
        _ => None,
    }
}

/// 인코딩한 글자를 `toWellFormed`한 원래 글자로 되돌린다: 짝 없는 서로게이트는 U+FFFD, 예약 글자는 그대로의 글자.
/// (napi 경계에서 원래 글자가 받았을 꼴이다. 거부 목록 판정이 파일 시스템이 실제로 쓰는 이름으로 견줄 때 쓴다)
pub fn well_formed_from_encoded(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        match read_lone_escape(&chars, i) {
            Some((Ok(c), used)) => {
                out.push(c);
                i += used;
            }
            Some((Err(_), used)) => {
                out.push('\u{FFFD}');
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

/// 숫자의 `SameValueZero`(`Set.has`·`Map` 키): NaN끼리 같고 +0과 -0도 같다
pub fn same_value_zero(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim은_bom을_지우고_u0085는_남긴다() {
        assert_eq!(trim("\u{FEFF} A=1 \u{2028}"), "A=1");
        assert_eq!(trim("\u{0085}A=1"), "\u{0085}A=1");
        assert_eq!(trim("\u{3000}\t\u{000B}x\u{00A0}"), "x");
    }

    #[test]
    fn utf16_길이는_바이트가_아니다() {
        assert_eq!(utf16_len("가가가"), 3);
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(utf16_len("abc"), 3);
    }

    #[test]
    fn utf16_순서는_코드_포인트_순서와_다르다() {
        // U+FF5E(전각 물결)는 코드 포인트로 U+1F600보다 작지만, UTF-16에서는 0xFF5E > 0xD83D라 뒤에 온다
        assert_eq!("\u{FF5E}".cmp("😀"), std::cmp::Ordering::Less);
        assert_eq!(cmp_utf16("\u{FF5E}", "😀"), std::cmp::Ordering::Greater);
    }

    #[test]
    fn encode_uri_component는_js와_같다() {
        assert_eq!(encode_uri_component("A-z_0.!~*'()"), "A-z_0.!~*'()");
        assert_eq!(encode_uri_component("sk_test/abc+123"), "sk_test%2Fabc%2B123");
        assert_eq!(encode_uri_component(" #$&+,/:;=?@[]"), "%20%23%24%26%2B%2C%2F%3A%3B%3D%3F%40%5B%5D");
        assert_eq!(encode_uri_component("가😀"), "%EA%B0%80%F0%9F%98%80");
    }

    #[test]
    fn base64는_buffer와_같다() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn slice_ascii는_범위를_잘라_맞춘다() {
        assert_eq!(slice_ascii("abcdef", 2, 4), "cd");
        assert_eq!(slice_ascii("abc", 2, 10), "c");
        assert_eq!(slice_ascii("abc", 3, 1), "");
    }

    #[test]
    fn number_to_string은_js_표기를_따른다() {
        assert_eq!(number_to_string(0.1 * 3.0), "0.30000000000000004");
        assert_eq!(number_to_string(1.1 * 100.0), "110.00000000000001");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(1e20), "100000000000000000000");
        assert_eq!(number_to_string(1.5e-7), "1.5e-7");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(123.456), "123.456");
        assert_eq!(number_to_string(f64::NAN), "NaN");
        assert_eq!(number_to_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(number_to_string(2.5e25), "2.5e+25");
    }

    #[test]
    fn to_fixed는_가운데를_큰_쪽으로_보낸다() {
        // Rust format!("{:.2}", 0.125)는 "0.12"(짝수), JS (0.125).toFixed(2)는 "0.13"
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(1.005, 2), "1.00"); // 1.005는 실제로 1.00499999...
        assert_eq!(to_fixed(0.0, 2), "0.00");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(9.995, 2), "9.99"); // 실제 값 9.9949999...
        assert_eq!(to_fixed(99.95, 1), "100.0");
        assert_eq!(to_fixed(123456.789, 1), "123456.8");
        assert_eq!(to_fixed(1e21, 2), "1e+21");
        assert_eq!(to_fixed(f64::INFINITY, 1), "Infinity");
        assert_eq!(to_fixed(0.05, 1), "0.1"); // 0.05는 실제로 0.05000000000000000277
        assert_eq!(to_fixed(999.99, 1), "1000.0");
    }

    #[test]
    fn math_round는_가운데를_양의_무한대_쪽으로_보낸다() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(-0.5), 0.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
        assert_eq!(math_round(1.5), 2.0);
        assert!(math_round(f64::NAN).is_nan());
    }

    #[test]
    fn parse_int는_앞부분만_읽는다() {
        assert_eq!(parse_int("  42abc"), 42.0);
        assert_eq!(parse_int("-7"), -7.0);
        assert_eq!(parse_int("+3.9"), 3.0);
        assert_eq!(parse_int("0x10"), 0.0);
        assert!(parse_int("abc").is_nan());
        assert!(parse_int("").is_nan());
        assert!(parse_int("-").is_nan());
        assert_eq!(parse_int("\u{FEFF}12"), 12.0);
        assert_eq!(parse_int(&"9".repeat(400)), f64::INFINITY);
    }

    #[test]
    fn parse_float는_앞부분만_읽는다() {
        assert_eq!(parse_float("12.5%"), 12.5);
        assert_eq!(parse_float(".5x"), 0.5);
        assert_eq!(parse_float("5."), 5.0);
        assert_eq!(parse_float("1e3"), 1000.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert_eq!(parse_float("1e+"), 1.0);
        assert_eq!(parse_float("1.2.3"), 1.2);
        assert_eq!(parse_float("Infinity%"), f64::INFINITY);
        assert_eq!(parse_float("-Infinityx"), f64::NEG_INFINITY);
        assert!(parse_float("inf").is_nan());
        assert!(parse_float("0x10") == 0.0);
        assert!(parse_float(".").is_nan());
        assert!(parse_float("--1").is_nan());
        assert!(parse_float("NaN").is_nan());
        assert_eq!(parse_float("1_000"), 1.0);
    }

    #[test]
    fn to_number는_문자열_전체를_읽는다() {
        assert_eq!(to_number("  12  "), 12.0);
        assert_eq!(to_number(""), 0.0);
        assert_eq!(to_number("   "), 0.0);
        assert_eq!(to_number("0x1F"), 31.0);
        assert_eq!(to_number("0b101"), 5.0);
        assert_eq!(to_number("0o17"), 15.0);
        assert_eq!(to_number("1e3"), 1000.0);
        assert_eq!(to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(to_number(".5"), 0.5);
        assert_eq!(to_number("5."), 5.0);
        assert!(to_number("12px").is_nan());
        assert!(to_number("1 2").is_nan());
        assert!(to_number("inf").is_nan());
        assert!(to_number("-0x10").is_nan());
        assert!(to_number("0x").is_nan());
        assert!(to_number("1_0").is_nan());
        assert!(to_number("+").is_nan());
        assert_eq!(to_number("\u{FEFF}7\u{2028}"), 7.0);
    }

    #[test]
    fn json_quote는_js_json_stringify와_같다() {
        assert_eq!(json_quote("a\"b\\c\n\u{1f}\u{7f}\u{2028}"), "\"a\\\"b\\\\c\\n\\u001f\u{7f}\u{2028}\"");
    }

    #[test]
    fn split_ws는_빈_줄에_빈_문자열_하나를_준다() {
        assert_eq!(split_ws("  a \t b\u{3000}c  "), vec!["a", "b", "c"]);
        assert_eq!(split_ws("   "), vec![""]);
        assert_eq!(split_ws("\u{0085}x"), vec!["\u{0085}x"]);
    }

    #[test]
    fn 끝의_콜론_숫자는_마지막_콜론만_본다() {
        assert_eq!(trailing_colon_digits("*:80"), Some("80"));
        assert_eq!(trailing_colon_digits("[::1]:5432"), Some("5432"));
        assert_eq!(trailing_colon_digits("*:80:"), None);
        assert_eq!(trailing_colon_digits("*:8a"), None);
        assert_eq!(trailing_colon_digits("a:"), None);
    }

    #[test]
    fn 안정_정렬은_같은_값의_순서를_지키고_nan은_같다고_본다() {
        let items = vec![(1, 'a'), (0, 'b'), (1, 'c'), (0, 'd')];
        let sorted = stable_sort_by(items, &|x, y| f64::from(x.0) - f64::from(y.0));
        assert_eq!(sorted, vec![(0, 'b'), (0, 'd'), (1, 'a'), (1, 'c')]);
        let same = stable_sort_by(vec![3, 1, 2], &|_, _| f64::NAN);
        assert_eq!(same, vec![3, 1, 2]);
    }

    #[test]
    fn relative_start는_slice의_시작_규칙이다() {
        assert_eq!(relative_start(5, 2.0), 2);
        assert_eq!(relative_start(5, -2.0), 3);
        assert_eq!(relative_start(5, -9.0), 0);
        assert_eq!(relative_start(5, f64::NAN), 0);
        assert_eq!(relative_start(5, f64::INFINITY), 5);
        assert_eq!(relative_start(5, 2.9), 2);
        assert_eq!(relative_start(5, -0.0), 0);
    }
}

#[cfg(test)]
mod shortest_tests {
    use super::*;

    #[test]
    fn 같은_거리의_후보가_둘이면_끝자리가_짝수인_쪽을_쓴다() {
        // Node: String(623525043763220.25) === "623525043763220.2"
        assert_eq!(number_to_string(623_525_043_763_220.25), "623525043763220.2");
        assert_eq!(number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_to_string(5e-324), "5e-324");
        assert_eq!(number_to_string(1.7976931348623157e308), "1.7976931348623157e+308");
        assert_eq!(number_to_string(123_456_789.123_456_79), "123456789.12345679");
    }
}
