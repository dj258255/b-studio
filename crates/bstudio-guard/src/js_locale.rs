//! `Number.prototype.toLocaleString()`(ko-KR·en-US 기본 설정)과 `String.prototype.localeCompare`(ICU 기본 정렬)의 ASCII 범위.
//!
//! 토큰 예산·모델 선택 판정(ADR-191 3f)이 안내 글에 숫자를 천 단위로 끊어 쓰고(`1,234`), 같은 점수의 모델을 id로 정렬한다.
//! 의도한 차이: 정수만 다룬다(소수는 소수 셋째 자리까지 반올림해 끊는 근사). 프로세스의 로캘이 천 단위를 쉼표로 끊지 않는 곳(de-DE 등)이어도
//! 늘 쉼표다. `locale_compare`는 ASCII 글자만 ICU 기본(root) 정렬과 같고, 그 밖의 글자는 코드 포인트 순서로 뒤에 둔다(검증된 id는 ASCII뿐이다).

use crate::js;

/// 정수를 `1,234,567`로 끊는다. NaN은 `NaN`, 무한대는 `∞`·`-∞`, `-0`은 `-0`(ICU가 그렇게 쓴다)
pub fn to_locale_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "∞" } else { "-∞" }.into();
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0" } else { "0" }.into();
    }
    let neg = x < 0.0;
    let abs = x.abs();
    let (int_digits, frac) = if abs.fract() == 0.0 {
        (integer_digits(abs), String::new())
    } else {
        let fixed = js::to_fixed(abs, 3);
        let (i, f) = fixed.split_once('.').unwrap_or((fixed.as_str(), ""));
        (i.to_owned(), f.trim_end_matches('0').to_owned())
    };
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    let len = int_digits.len();
    for (i, ch) in int_digits.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if !frac.is_empty() {
        out.push('.');
        out.push_str(&frac);
    }
    out
}

/// 정수 값의 10진 자릿수(가장 짧게 되읽히는 자릿수 뒤는 0으로 채운다. ICU도 같다)
fn integer_digits(abs: f64) -> String {
    let sci = format!("{abs:e}");
    let (mantissa, exp) = sci.split_once('e').expect("지수 표기");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let n = exp.parse::<i32>().expect("지수") + 1;
    let k = digits.len() as i32;
    if k <= n {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else {
        digits[..n as usize].to_owned()
    }
}

/// ICU root 정렬의 ASCII 1차 순서. 공백 글자 → 문장부호 → 기호 → 숫자 → 글자. 대소문자는 1차에서 같다
const PUNCT_ORDER: &str = "\t\n\x0B\x0C\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// (1차 가중치, 대문자 여부). 무시되는 글자(제어 문자)는 None
fn collation_element(c: char) -> Option<(u32, bool)> {
    let cp = c as u32;
    if cp < 0x80 {
        if let Some(pos) = PUNCT_ORDER.find(c) {
            return Some((1 + pos as u32, false));
        }
        return match c {
            '0'..='9' => Some((100 + (cp - 0x30), false)),
            'a'..='z' => Some((200 + (cp - 0x61), false)),
            'A'..='Z' => Some((200 + (cp - 0x41), true)),
            _ => None, // 0-8, 14-31, 127
        };
    }
    Some((1000 + cp, false))
}

/// `a.localeCompare(b)`(-1·0·1)
pub fn locale_compare(a: &str, b: &str) -> f64 {
    let ea: Vec<(u32, bool)> = a.chars().filter_map(collation_element).collect();
    let eb: Vec<(u32, bool)> = b.chars().filter_map(collation_element).collect();
    for (x, y) in ea.iter().zip(eb.iter()) {
        if x.0 != y.0 {
            return if x.0 < y.0 { -1.0 } else { 1.0 };
        }
    }
    if ea.len() != eb.len() {
        return if ea.len() < eb.len() { -1.0 } else { 1.0 };
    }
    // 3차: 소문자가 대문자보다 앞
    for (x, y) in ea.iter().zip(eb.iter()) {
        if x.1 != y.1 {
            return if !x.1 { -1.0 } else { 1.0 };
        }
    }
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_string() {
        assert_eq!(to_locale_string(1234567.0), "1,234,567");
        assert_eq!(to_locale_string(999.0), "999");
        assert_eq!(to_locale_string(-1234.0), "-1,234");
        assert_eq!(to_locale_string(1e21), "1,000,000,000,000,000,000,000");
        assert_eq!(to_locale_string(-0.0), "-0");
        assert_eq!(to_locale_string(f64::INFINITY), "∞");
        assert_eq!(to_locale_string(1234.5), "1,234.5");
    }

    #[test]
    fn collation() {
        assert_eq!(locale_compare("a", "A"), -1.0);
        assert_eq!(locale_compare("a-b", "ab"), -1.0);
        assert_eq!(locale_compare("A", "b"), -1.0);
        assert_eq!(locale_compare("a\u{1}b", "ab"), 0.0);
        assert_eq!(locale_compare("a_", "a-"), -1.0);
    }
}
