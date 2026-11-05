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
}
