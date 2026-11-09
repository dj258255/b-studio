//! 화면 확인이 "데이터를 못 받아 로딩 상태에서 멈춘 화면"을 잡는 순수 판정(옛 TS: `packages/agent/src/stuck-loading.ts`, ADR-078).
//!
//! JS와 같게 읽는 곳:
//! - 줄 패턴의 `/i`는 ASCII 대소문자만 같게 본다(JS 비유니코드 `/i`는 `ı`·`ſ`·켈빈 기호를 ASCII로 접지 않는다. Rust의 `(?i)`는 접으므로 쓰지 않는다).
//! - `\s`는 JS 공백 집합(`js::WS_CLASS`)이고 `trim()`도 같은 집합이다. `normalized.length`는 UTF-16 코드 단위 수, `slice(0, 60)`은 코드 단위 60개(서로게이트 쌍을 자르면 U+FFFD, `js::truncate_utf16`).
//! - 증거 합 `failedRequests + consoleErrors + pageErrors > 0`: 빠진 값은 `undefined`라 합이 `NaN`이 되고 `NaN > 0`은 거짓이다.

use crate::js::{self, WS_CLASS};
use crate::js_json::JsValue;
use regex::Regex;
use std::sync::LazyLock;

/// ASCII 글자마다 `[lL]` 꼴로 쓴 `/i` 패턴 조각
fn ci(word: &str) -> String {
    word.chars().map(|c| if c.is_ascii_alphabetic() { format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase()) } else { c.to_string() }).collect()
}

static LOADING_LINE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let ws = WS_CLASS;
    let dots = r"\.{0,3}$";
    [
        format!("^{}(?:[{ws}]*{})?{dots}", ci("loading"), ci("data")),
        format!("^{}[{ws}]+{}{dots}", ci("please"), ci("wait")),
        format!("^{}[{ws}]+{}(?:[{ws}]+{})?{dots}", ci("one"), ci("moment"), ci("please")),
        format!("^{}(?:[{ws}]*{})?{dots}", ci("fetching"), ci("data")),
        format!("^(?:데이터를?[{ws}]*)?불러오는[{ws}]*중(?:입니다)?{dots}"),
        format!("^로딩[{ws}]*중(?:입니다)?{dots}"),
        format!("^로딩{dots}"),
        format!("^잠시만[{ws}]*기다려[{ws}]*주세요{dots}"),
        format!("^잠시만[{ws}]*기다려[{ws}]*주십시오{dots}"),
    ]
    .iter()
    .map(|p| Regex::new(p).expect("정규식"))
    .collect()
});

/// 줄이 로딩 문구뿐인지. 앞뒤 공백·스피너 기호(•·) 정도는 지우고 비교한다
fn is_loading_line(line: &str) -> bool {
    let trimmed = js::trim(line.trim_matches(|c: char| c == '•' || c == '·' || js::is_js_whitespace(c)));
    if trimmed.is_empty() {
        return false;
    }
    LOADING_LINE_PATTERNS.iter().any(|p| p.is_match(trimmed))
}

/// 화면 확인이 함께 본 증거(`StuckLoadingEvidence`)를 읽은 값의 합. 값이 없으면 `NaN`
fn evidence_total(evidence: &JsValue) -> f64 {
    let n = |key: &str| evidence.prop(key).map_or(f64::NAN, JsValue::to_number);
    n("failedRequests") + n("consoleErrors") + n("pageErrors")
}

/// 본문 글자가 로딩 상태에서 멈춘 것으로 보이면 사람이 읽을 사유를, 아니면 None. `evidence`가 None이면 빈 화면 판정은 하지 않는다
pub fn detect_stuck_loading(text: &str, evidence: Option<&JsValue>) -> Option<String> {
    let normalized = js::trim(&text.replace("\r\n", "\n")).to_owned();
    let lines: Vec<&str> = normalized.split('\n').map(js::trim).filter(|l| !l.is_empty()).collect();

    if lines.is_empty() {
        let supporting = evidence.is_some_and(|e| evidence_total(e) > 0.0);
        if !supporting {
            return None;
        }
        return Some("화면에 표시된 내용이 없습니다(스켈레톤이거나 데이터를 못 받아 빈 상태로 멈췄을 수 있습니다) — 실패한 요청·콘솔 오류·스크립트 예외를 함께 보세요".to_owned());
    }

    if lines.iter().all(|l| is_loading_line(l)) {
        let shown = if js::utf16_len(&normalized) > 60 { format!("{}…", js::truncate_utf16(&normalized, 60)) } else { normalized.clone() };
        return Some(format!("화면이 로딩 문구만 보여 준 채 멈췄습니다: \"{shown}\""));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loading_only_is_stuck() {
        assert!(detect_stuck_loading("Loading...", None).is_some());
        assert!(detect_stuck_loading("LOADING DATA\n 불러오는 중입니다...", None).is_some());
        assert!(detect_stuck_loading("Loading Dock 안내", None).is_none());
        assert!(detect_stuck_loading("Loading....", None).is_none());
        assert!(detect_stuck_loading("loaſing", None).is_none());
    }

    #[test]
    fn empty_needs_evidence() {
        assert!(detect_stuck_loading("  \n ", None).is_none());
        let none = js_json_obj(&[("failedRequests", 0.0), ("consoleErrors", 0.0), ("pageErrors", 0.0)]);
        assert!(detect_stuck_loading("", Some(&none)).is_none());
        let one = js_json_obj(&[("failedRequests", 0.0), ("consoleErrors", 0.0), ("pageErrors", 1.0)]);
        assert!(detect_stuck_loading("", Some(&one)).is_some());
        let missing = js_json_obj(&[("failedRequests", 3.0)]);
        assert!(detect_stuck_loading("", Some(&missing)).is_none());
    }

    fn js_json_obj(pairs: &[(&str, f64)]) -> JsValue {
        let mut o = crate::js_json::JsObject::new();
        for (k, v) in pairs {
            o.set(k, JsValue::Num(*v));
        }
        JsValue::Obj(o)
    }
}
