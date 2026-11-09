//! 도구 결과 자르기·HTML 벗기기·반복 결과 문구(ADR-191 3단계 3f). 옛 `packages/agent/src/tool-output.ts`의 판정.
//!
//! 길이와 자르기는 JS와 같이 UTF-16 코드 단위다. 서로게이트 쌍을 가르는 자리는 U+FFFD가 된다(Node 경계 규칙, 의도한 차이).
//! 정규식은 손으로 풀었다: `\b`·`\w`는 ASCII, `\s`는 JS 공백(`js::is_js_whitespace`), `/i`는 ASCII만 접는다
//! (JS의 비유니코드 `/i`는 ASCII 밖의 글자를 ASCII와 같다고 보지 않는다. Rust의 `(?i)`는 켈빈 기호 같은 글자까지 접어 달라서 쓰지 않는다).

use crate::js;

/// 반복 결과 대체 문구의 접두어
pub const REPEAT_NOTE_PREFIX: &str = "(앞의 ";
const REPEAT_NOTE_SUFFIX: &str = "번째 호출 결과와 같습니다)";

fn clip_note(total: usize, omitted: f64, hint: Option<&str>) -> String {
    let hint = hint.filter(|h| !h.is_empty());
    format!(
        "[... 전체 {total}자 중 {}자 생략{} ...]",
        js::number_to_string(omitted),
        hint.map(|h| format!(". {h}")).unwrap_or_default()
    )
}

/// `text.slice(start, end)`(UTF-16 코드 단위). `end`가 None이면 끝까지. 소수·음수·NaN은 JS 규칙
fn slice_units(units: &[u16], start: f64, end: Option<f64>) -> String {
    let len = units.len();
    let from = js::relative_start(len, start);
    let to = end.map_or(len, |e| js::relative_start(len, e));
    if to <= from {
        return String::new();
    }
    String::from_utf16_lossy(&units[from..to])
}

fn clip(text: &str, budget: f64, head_ratio: f64, hint: Option<&str>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let len = units.len();
    if (len as f64) <= budget {
        return text.to_owned();
    }
    let head = (budget * head_ratio).floor();
    let tail = budget - head;
    format!(
        "{}\n{}\n{}",
        slice_units(&units, 0.0, Some(head)),
        clip_note(len, len as f64 - budget, hint),
        slice_units(&units, -tail, None)
    )
}

/// 명령 출력은 뒤쪽 위주로 남긴다(앞 25%·뒤 75%)
pub fn clip_command_output(text: &str, budget: f64) -> String {
    clip(
        text,
        budget,
        0.25,
        Some("필요하면 grep·tail로 좁혀 다시 실행"),
    )
}

/// 일반 글은 앞쪽 위주로 남긴다(앞 80%·뒤 20%). 빈 `hint`는 없는 것과 같다
pub fn clip_text(text: &str, budget: f64, hint: Option<&str>) -> String {
    clip(text, budget, 0.8, hint)
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `<!--[\s\S]*?-->` → 공백 하나
fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(p) = s[i..].find("<!--") {
        let start = i + p;
        // 닫는 표시가 여기 없으면 뒤의 `<!--`에도 없다
        let Some(q) = s[start + 4..].find("-->") else {
            break;
        };
        out.push_str(&s[i..start]);
        out.push(' ');
        i = start + 4 + q + 3;
    }
    out.push_str(&s[i..]);
    out
}

const RAW_TAGS: [&str; 3] = ["script", "style", "noscript"];

fn match_raw_tag(b: &[u8], at: usize) -> Option<usize> {
    RAW_TAGS.iter().position(|name| {
        b.len() >= at + name.len() && b[at..at + name.len()].eq_ignore_ascii_case(name.as_bytes())
    })
}

/// `</이름\s*>`가 처음 나오는 자리 뒤(`>` 다음)의 위치
fn find_close(s: &str, name: &str, from: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut j = from;
    while let Some(p) = s[j..].find("</") {
        let at = j + p + 2;
        if b.len() >= at + name.len()
            && b[at..at + name.len()].eq_ignore_ascii_case(name.as_bytes())
        {
            let mut k = at + name.len();
            for c in s[k..].chars() {
                if js::is_js_whitespace(c) {
                    k += c.len_utf8();
                } else {
                    break;
                }
            }
            if b.get(k) == Some(&b'>') {
                return Some(k + 1);
            }
        }
        j += p + 1;
    }
    None
}

/// `<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>`(/gi) → 공백 하나
fn strip_raw_blocks(s: &str) -> String {
    let b = s.as_bytes();
    let n = b.len();
    let mut out = String::with_capacity(n);
    let (mut i, mut last) = (0, 0);
    // 한 번 못 찾은 자리 뒤에서는 다시 찾지 않는다(찾는 범위가 줄기만 하므로 결과는 같다)
    let mut no_gt_from: Option<usize> = None;
    let mut no_close_from: [Option<usize>; 3] = [None; 3];
    while i < n {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let Some(k) = match_raw_tag(b, i + 1) else {
            i += 1;
            continue;
        };
        let name = RAW_TAGS[k];
        let after = i + 1 + name.len();
        if after < n && is_word(b[after]) {
            i += 1;
            continue;
        }
        let gt = if no_gt_from.is_some_and(|m| m <= after) {
            None
        } else {
            s[after..].find('>').map(|p| after + p)
        };
        let Some(gt) = gt else {
            no_gt_from = Some(no_gt_from.map_or(after, |m| m.min(after)));
            i += 1;
            continue;
        };
        let tag_end = gt + 1;
        if no_close_from[k].is_some_and(|m| m <= tag_end) {
            i += 1;
            continue;
        }
        match find_close(s, name, tag_end) {
            Some(end) => {
                out.push_str(&s[last..i]);
                out.push(' ');
                i = end;
                last = end;
            }
            None => {
                no_close_from[k] = Some(tag_end);
                i += 1;
            }
        }
    }
    out.push_str(&s[last..]);
    out
}

/// `<[^>]*>` → 공백 하나
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(p) = s[i..].find('<') {
        let lt = i + p;
        let Some(q) = s[lt..].find('>') else { break };
        out.push_str(&s[i..lt]);
        out.push(' ');
        i = lt + q + 1;
    }
    out.push_str(&s[i..]);
    out
}

/// ASCII 대소문자를 가리지 않고 `patterns` 중 하나를 `rep`로 바꾼다(왼쪽부터, 겹치지 않게)
fn replace_ci(s: &str, patterns: &[&str], rep: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let (mut i, mut last) = (0, 0);
    while i < b.len() {
        if b[i] == b'&' {
            if let Some(p) = patterns.iter().find(|p| {
                b.len() >= i + p.len() && b[i..i + p.len()].eq_ignore_ascii_case(p.as_bytes())
            }) {
                out.push_str(&s[last..i]);
                out.push_str(rep);
                i += p.len();
                last = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&s[last..]);
    out
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if js::is_js_whitespace(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// HTML에서 보이는 글자만 남긴다
pub fn visible_html(html: &str) -> String {
    let s = strip_comments(html);
    let s = strip_raw_blocks(&s);
    let s = strip_tags(&s);
    let s = replace_ci(&s, &["&nbsp;"], " ");
    let s = replace_ci(&s, &["&lt;"], "<");
    let s = replace_ci(&s, &["&gt;"], ">");
    let s = replace_ci(&s, &["&quot;"], "\"");
    let s = replace_ci(&s, &["&#39;", "&apos;"], "'");
    // &amp;는 마지막에 푼다. 먼저 풀면 &amp;lt;가 <로 잘못 풀린다
    let s = replace_ci(&s, &["&amp;"], "&");
    js::trim(&collapse_whitespace(&s)).to_owned()
}

/// HTML인지 판별한다. content-type이 우선이고, 없으면 문서 시작으로 본다. 빈 content-type은 없는 것과 같다
pub fn is_html_content(content_type: Option<&str>, text: &str) -> bool {
    if let Some(ct) = content_type.filter(|c| !c.is_empty()) {
        let lower = ct.to_ascii_lowercase();
        if lower.contains("text/html") || lower.contains("application/xhtml+xml") {
            return true;
        }
    }
    let rest = text.trim_start_matches(js::is_js_whitespace);
    let b = rest.as_bytes();
    let starts = |p: &str| b.len() >= p.len() && b[..p.len()].eq_ignore_ascii_case(p.as_bytes());
    if starts("<!doctype html") {
        return true;
    }
    starts("<html")
        && rest[5..]
            .chars()
            .next()
            .is_some_and(|c| c == '>' || js::is_js_whitespace(c))
}

/// 앞선 같은 호출의 결과와 같을 때 본문 대신 돌려주는 문구
pub fn repeat_note(call: f64) -> String {
    format!(
        "{REPEAT_NOTE_PREFIX}{}{REPEAT_NOTE_SUFFIX}",
        js::number_to_string(call)
    )
}

pub fn is_repeat_note(text: &str) -> bool {
    text.starts_with(REPEAT_NOTE_PREFIX) && text.ends_with(REPEAT_NOTE_SUFFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips() {
        assert_eq!(clip_command_output("short", 6000.0), "short");
        let t = format!("{}FAIL", "a".repeat(10_000));
        let c = clip_command_output(&t, 1000.0);
        assert!(c.contains("전체 10004자 중 9004자 생략"));
        assert!(c.ends_with("FAIL"));
        assert_eq!(
            clip_text("abc", 2.0, Some("")),
            "a\n[... 전체 3자 중 1자 생략 ...]\nc"
        );
    }

    #[test]
    fn html() {
        assert_eq!(
            visible_html("<p>a &amp;lt; b</p><script>x<1</script>  <!-- c -->z"),
            "a &lt; b z"
        );
        assert!(is_html_content(None, " \u{FEFF}<HTML lang=x>"));
        assert!(!is_html_content(None, "<htmlx>"));
        assert!(is_repeat_note(&repeat_note(3.0)));
    }
}
