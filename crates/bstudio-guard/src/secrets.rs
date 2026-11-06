//! 시크릿 파일 읽기와 출력 가림.
//!
//! 옮기기 전 TS의 `parseDotenv`·`Redactor`와 같은 입력에 같은 결과를 낸다. 정규식을 그대로 옮기지 않고 손으로 짠 까닭:
//! Rust `regex`에는 역참조(`\1`)가 없고, JS의 `\s`·`.`·`trim`이 보는 글자 집합이 Rust와 다르다(`js` 모듈).

use crate::js;

/// `KEY=VALUE` 줄을 읽는다. 빈 줄과 `#` 주석은 건너뛰고, 값을 감싼 따옴표 한 쌍은 벗긴다.
/// 쌍을 나온 순서대로 모두 돌려준다(같은 키가 다시 나오면 받는 쪽에서 나중 것이 이긴다 — JS `Object.fromEntries`와 같다)
pub fn parse_dotenv(text: &str) -> Vec<(String, String)> {
    let mut values = Vec::new();
    // `/\r?\n/`로 나눈다: `\n` 바로 앞의 `\r` 하나만 줄 끝으로 본다
    let mut pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    for piece in pieces.iter_mut().take(last) {
        *piece = piece.strip_suffix('\r').unwrap_or(piece);
    }
    for raw in pieces {
        let line = js::trim(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = match_line(line) else {
            continue;
        };
        values.push((key.to_owned(), unquote(value).to_owned()));
    }
    values
}

/// `/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/`. 선택 그룹이 맞아도 나머지가 맞지 않으면 그룹 없이 다시 본다(정규식의 되돌아가기)
fn match_line(line: &str) -> Option<(&str, &str)> {
    if let Some(rest) = line.strip_prefix("export") {
        let after = rest.trim_start_matches(js::is_js_whitespace);
        if after.len() < rest.len() {
            if let Some(found) = match_assignment(after) {
                return Some(found);
            }
        }
    }
    match_assignment(line)
}

/// `([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$`. 이름 다음 글자는 이름 글자가 아니어야 하므로 이름은 탐욕적으로 잡아도 된다.
/// `.`은 줄 끝 글자(`\n \r    `)와 맞지 않아, 값에 그 글자가 있으면 줄 전체가 맞지 않는다
fn match_assignment(s: &str) -> Option<(&str, &str)> {
    let bytes = s.as_bytes();
    if !bytes
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
    {
        return None;
    }
    let key_len = bytes
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
        .count();
    let (key, rest) = s.split_at(key_len);
    let rest = rest
        .trim_start_matches(js::is_js_whitespace)
        .strip_prefix('=')?;
    let value = rest.trim_start_matches(js::is_js_whitespace);
    if value.chars().any(js::is_js_line_terminator) {
        return None;
    }
    Some((key, value))
}

/// `/^(["']).*\1$/`이면 앞뒤 한 글자씩 뗀다. 첫 글자와 마지막 글자가 서로 다른 자리여야 한다(`"` 한 글자는 그대로)
fn unquote(value: &str) -> &str {
    let mut chars = value.chars();
    match (chars.next(), chars.next_back()) {
        (Some(first @ ('"' | '\'')), Some(last)) if first == last => &value[1..value.len() - 1],
        _ => value,
    }
}

struct Pattern {
    name: String,
    /// 정렬 기준(원래 값의 UTF-16 길이)
    order: usize,
    forms: Vec<String>,
}

/// 샌드박스에서 나오는 텍스트(로그, 명령 출력, HTTP 응답, 파일 내용)에서 시크릿 값을 찾고 가린다
pub struct Redactor {
    patterns: Vec<Pattern>,
}

impl Redactor {
    /// `entries`는 (이름, 값)을 JS `Object.entries`의 순서대로 받는다. 같은 길이의 값끼리는 그 순서를 지킨다
    pub fn new(entries: Vec<(String, String)>) -> Self {
        let mut patterns: Vec<Pattern> = entries
            .into_iter()
            .map(|(name, value)| {
                // URL 쿼리·폼 본문에 들어간 값, base64로 인코딩한 출력(`| base64`, Basic 인증 헤더)도 가린다
                let mut forms: Vec<String> = Vec::new();
                for form in [value.clone(), js::encode_uri_component(&value)]
                    .into_iter()
                    .chain(base64_cores(&value))
                {
                    // 빈 문자열은 패턴에서 뺀다. 옛 TS는 `replaceAll('', …)`로 글자 사이마다 끼워 넣었다(의도한 차이).
                    // 시크릿 값은 resolveSecrets가 8자 미만을 거절하므로 실제로는 생기지 않는다
                    if !form.is_empty() && !forms.contains(&form) {
                        forms.push(form);
                    }
                }
                Pattern {
                    order: js::utf16_len(&value),
                    name,
                    forms,
                }
            })
            .collect();
        // 한 값이 다른 값을 포함하면 긴 값부터 가려야 가린 자리에 맞는 이름이 남는다. 길이는 JS와 같게 UTF-16 기준, 안정 정렬
        patterns.sort_by_key(|p| std::cmp::Reverse(p.order));
        Self { patterns }
    }

    pub fn redact(&self, text: &str) -> String {
        let mut result = text.to_owned();
        for pattern in &self.patterns {
            let mark = format!("[{} 가림]", pattern.name);
            for form in &pattern.forms {
                if result.contains(form.as_str()) {
                    result = result.replace(form.as_str(), &mark);
                }
            }
        }
        result
    }

    /// 텍스트에 값이 들어 있는 시크릿 이름(JS 기본 정렬과 같은 UTF-16 순서)
    pub fn find(&self, text: &str) -> Vec<String> {
        let mut names: Vec<String> = self
            .patterns
            .iter()
            .filter(|p| p.forms.iter().any(|form| text.contains(form.as_str())))
            .map(|p| p.name.clone())
            .collect();
        names.sort_by(|a, b| js::cmp_utf16(a, b));
        names
    }
}

/// base64는 3바이트씩 묶어 인코딩하므로 같은 값도 앞에 몇 바이트가 붙느냐(0~2)에 따라 다른 문자열이 된다.
/// 각 경우에 앞뒤 바이트와 섞이지 않고 값만으로 정해지는 구간을 돌려준다. 경계의 1~2글자는 남지만 값을 복원할 수 없다
fn base64_cores(value: &str) -> [String; 3] {
    let bytes = value.as_bytes();
    [0usize, 1, 2].map(|offset| {
        let mut padded = vec![0u8; offset];
        padded.extend_from_slice(bytes);
        let encoded = js::base64(&padded);
        // 앞 바이트의 비트가 섞인 글자를 건너뛰고, 뒤에 올 바이트와 섞일 마지막 글자와 패딩은 뺀다
        let start = [0, 2, 3][offset];
        let end = (offset + bytes.len()) * 8 / 6;
        js::slice_ascii(&encoded, start, end).to_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn 주석과_빈_줄을_건너뛰고_따옴표_한_쌍만_벗긴다() {
        let parsed =
            parse_dotenv("\n# c\nA=1\nB = \"two words\"\nC='x=y'\nD=\"unterminated\nnot a line\n");
        assert_eq!(
            parsed,
            pairs(&[
                ("A", "1"),
                ("B", "two words"),
                ("C", "x=y"),
                ("D", "\"unterminated")
            ])
        );
    }

    #[test]
    fn export_그룹은_되돌아가기를_따른다() {
        assert_eq!(parse_dotenv("export FOO=1"), pairs(&[("FOO", "1")]));
        assert_eq!(parse_dotenv("export=1"), pairs(&[("export", "1")]));
        assert_eq!(parse_dotenv("export =1"), pairs(&[("export", "1")]));
        assert_eq!(parse_dotenv("exportFOO=1"), pairs(&[("exportFOO", "1")]));
        assert_eq!(parse_dotenv("export FOO"), pairs(&[]));
        assert_eq!(parse_dotenv("export\u{3000}FOO=2"), pairs(&[("FOO", "2")]));
    }

    #[test]
    fn js와_다르게_읽기_쉬운_자리() {
        // BOM은 JS trim이 지운다
        assert_eq!(parse_dotenv("\u{FEFF}A=1"), pairs(&[("A", "1")]));
        // \r만 있는 줄 끝은 나누지 않고, 값의 \r은 `.`과 맞지 않아 줄 전체가 버려진다
        assert_eq!(parse_dotenv("A=1\rB=2"), pairs(&[]));
        assert_eq!(
            parse_dotenv("A=1\r\nB=2\r\n"),
            pairs(&[("A", "1"), ("B", "2")])
        );
        assert_eq!(parse_dotenv("A=x\u{2028}y"), pairs(&[]));
        // U+0085는 JS 공백이 아니다
        assert_eq!(parse_dotenv("A=\u{0085}x"), pairs(&[("A", "\u{0085}x")]));
        assert_eq!(parse_dotenv("A=\""), pairs(&[("A", "\"")]));
        assert_eq!(parse_dotenv("A=\"\""), pairs(&[("A", "")]));
        assert_eq!(parse_dotenv("A='a\""), pairs(&[("A", "'a\"")]));
        assert_eq!(parse_dotenv("A=1\nA=2"), pairs(&[("A", "1"), ("A", "2")]));
        assert_eq!(parse_dotenv("가=1\n_x9=2\n9x=3"), pairs(&[("_x9", "2")]));
    }

    #[test]
    fn 원래_값과_url_인코딩된_값을_이름으로_가린다() {
        let r = Redactor::new(pairs(&[
            ("PAYMENT_API_KEY", "sk_test/abc+123"),
            ("DB_PASSWORD", "correct horse battery"),
        ]));
        assert_eq!(
            r.redact("key=sk_test/abc+123 url=/pay?key=sk_test%2Fabc%2B123"),
            "key=[PAYMENT_API_KEY 가림] url=/pay?key=[PAYMENT_API_KEY 가림]"
        );
        assert_eq!(
            r.find("password: correct horse battery"),
            vec!["DB_PASSWORD"]
        );
        assert!(r.find("nothing here").is_empty());
    }

    #[test]
    fn base64_출력도_가린다() {
        let r = Redactor::new(pairs(&[("PAYMENT_API_KEY", "sk_test_b_studio_4f9a2c71")]));
        assert_eq!(
            r.redact("c2tfdGVzdF9iX3N0dWRpb180ZjlhMmM3MQo="),
            "[PAYMENT_API_KEY 가림]Qo="
        );
    }

    #[test]
    fn 긴_값부터_utf16_길이로_가린다() {
        let r = Redactor::new(pairs(&[
            ("SHORT_TOKEN", "abcdefgh"),
            ("LONG_TOKEN", "abcdefgh-12345678"),
        ]));
        assert_eq!(
            r.redact("abcdefgh-12345678 / abcdefgh"),
            "[LONG_TOKEN 가림] / [SHORT_TOKEN 가림]"
        );
        // "가나다라마바사아"는 UTF-16으로 8, 바이트로 24다. 9글자 ASCII 값이 먼저 와야 한다
        // 두 값이 `9`에서 겹친다. 바이트 길이(K 22 > A 9)로 정렬하면 K가 먼저 가려져 결과가 달라진다
        let r = Redactor::new(pairs(&[("K", "9가나다라마바사"), ("A", "123456789")]));
        assert_eq!(
            r.redact("123456789가나다라마바사"),
            "[A 가림]가나다라마바사"
        );
    }

    #[test]
    fn 빈_form은_패턴에서_뺀다_의도한_차이() {
        let r = Redactor::new(pairs(&[("X", "a")]));
        assert!(r.patterns[0].forms.iter().all(|f| !f.is_empty()));
        assert_eq!(r.redact("bcd"), "bcd");
    }
}
