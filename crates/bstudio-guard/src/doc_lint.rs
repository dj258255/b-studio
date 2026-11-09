//! 문서·PR 본문의 "모호한 표현" 린트(옛 TS: `packages/agent/src/doc-lint.ts`, ADR-191 3단계 3j).
//!
//! 줄 번호가 있는 자유 텍스트를 줄마다 점검한다: 약한 표현(`requirements`의 한국어·영어 목록), 수치 없는 성능·안정성 주장, 헷갈리는 용어 쌍.
//! 정규식 옮김 규칙은 `requirements` 모듈 머리말과 같다. `/i`는 ASCII만 접는다.
//! 의도한 차이: 짝 없는 서로게이트는 Node 경계에서 U+FFFD가 된다. 소문자 변환은 Rust 표준 라이브러리의 유니코드 버전을 따른다.

use regex::Regex;
use std::sync::LazyLock;

use crate::js_json::{object, JsValue};
use crate::requirements::{compile, weak_word_messages, S};

/// 같은 줄에 숫자+단위가 있으면 이미 측정값을 댄 것으로 본다. `\d+\s*(ms|밀리초|%|percent|초|배|건|회|[kmg]?b\b|rps|tps|qps|p\d\d|req\/s)` /i
static MEASUREMENT_EVIDENCE: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        "[0-9]+{S}*(?:(?i-u:ms)|밀리초|%|(?i-u:percent)|초|배|건|회|(?i-u:[kmg]?b\\b)|(?i-u:rps|tps|qps)|(?i-u:p[0-9][0-9])|(?i-u:req/s))"
    ))
});

static VAGUE_PERFORMANCE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        format!("성능{S}*(?:이|을|을이|가)?{S}*(?:개선|향상|좋아|나아)"),
        "(?:빨라|느려)(?:졌|지)".to_owned(),
        format!("반응{S}*(?:이|속도)?{S}*(?:빠르|느리)"),
        "안정적".to_owned(),
        format!("부하(?:가|를)?{S}*(?:크|높|많)"),
        format!("(?:처리량|속도|지연)(?:이|을|가)?{S}*(?:높|낮|많|적)"),
    ]
    .iter()
    .map(|p| compile(p))
    .collect()
});

static CONFUSABLE_TERMS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (compile("속도|빠르기"), "latency(지연)와 throughput(처리량) 중 무엇인지 적어 주세요"),
        (compile(&format!("동시{S}*(?:에|로)?{S}*(?:여러|많이)|많이{S}*접속")), "concurrency(동시성)와 parallelism(병렬성) 중 무엇인지 적어 주세요"),
        (compile("빈번히|자주"), "frequency(빈도)와 throughput(처리량) 중 무엇인지, 단위 시간당 몇 건인지 적어 주세요"),
    ]
});

/// `latency|throughput|concurrency|parallelism|지연\s*\(|처리량\s*\(|동시성\s*\(|병렬성\s*\(` /i
static PRECISE_TERMS: LazyLock<Regex> = LazyLock::new(|| compile(&format!("(?i-u:latency|throughput|concurrency|parallelism)|지연{S}*\\(|처리량{S}*\\(|동시성{S}*\\(|병렬성{S}*\\(")));

pub struct Finding {
    pub line: usize,
    pub code: &'static str,
    pub message: String,
}

impl Finding {
    pub fn to_value(&self) -> JsValue {
        object(vec![("line", Some(JsValue::Num(self.line as f64))), ("code", Some(JsValue::str(self.code))), ("message", Some(JsValue::Str(self.message.clone())))])
    }
}

/// `text.split(/\r?\n/)`
fn lines_of(text: &str) -> Vec<&str> {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    pieces.into_iter().enumerate().map(|(i, p)| if i < last { p.strip_suffix('\r').unwrap_or(p) } else { p }).collect()
}

fn find_vague_performance(line: &str) -> Vec<String> {
    if MEASUREMENT_EVIDENCE.is_match(line) {
        return Vec::new();
    }
    VAGUE_PERFORMANCE
        .iter()
        .filter_map(|pattern| pattern.find(line))
        .map(|m| format!("\"{}\"는 수치·단위(ms, %, p95, rps, MB 등) 없이 방향만 말합니다 — 무엇을 어떻게 재서 얼마나 달라졌는지 적어 주세요", m.as_str()))
        .collect()
}

fn find_confusable_terms(line: &str) -> Vec<String> {
    if PRECISE_TERMS.is_match(line) {
        return Vec::new();
    }
    CONFUSABLE_TERMS.iter().filter_map(|(pattern, hint)| pattern.find(line).map(|m| format!("\"{}\"는 뜻이 여러 가지로 읽힙니다 — {hint}", m.as_str()))).collect()
}

/// 자유 텍스트를 줄 단위로 점검한다. 줄마다 약한 표현, 수치 없는 성능 주장, 헷갈리는 용어 순서다
pub fn lint_text(text: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    for (index, line) in lines_of(text).into_iter().enumerate() {
        let line_number = index + 1;
        for message in weak_word_messages(line, &line.to_lowercase()) {
            findings.push(Finding { line: line_number, code: "weak-word", message });
        }
        for message in find_vague_performance(line) {
            findings.push(Finding { line: line_number, code: "vague-performance", message });
        }
        for message in find_confusable_terms(line) {
            findings.push(Finding { line: line_number, code: "confusable-term", message });
        }
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 줄마다_세_종류를_점검한다() {
        let findings = lint_text("속도가 빠르다\r\n성능이 좋아졌다\n p95 850ms로 개선\n안정적이다");
        let codes: Vec<(usize, &str)> = findings.iter().map(|f| (f.line, f.code)).collect();
        assert_eq!(codes, vec![(1, "confusable-term"), (2, "vague-performance"), (4, "vague-performance")]);
    }

    #[test]
    fn 정규식이_컴파일된다() {
        assert!(MEASUREMENT_EVIDENCE.is_match("3 ms"));
        assert!(MEASUREMENT_EVIDENCE.is_match("10MB"));
        assert!(!MEASUREMENT_EVIDENCE.is_match("10 mbx"));
        assert_eq!(VAGUE_PERFORMANCE.len() + CONFUSABLE_TERMS.len(), 9);
        assert!(PRECISE_TERMS.is_match("LATENCY"));
    }
}
