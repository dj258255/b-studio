//! 모델 승격 판정(ADR-191 3단계 3i). 옮기기 전 TS는 `packages/agent/src/escalation.ts`다.
//!
//! 승격 여부는 모델의 자기 평가가 아니라 게이트의 실패 서명이 정한다. 같은 서명 집합이 몇 번 이어졌는지, 실패가 몇 번인지를
//! 견주는 경계(`<`·`>=`)와 서명 글자가 하나라도 달라지면 승격 판정이 뒤집힌다. 기본값(2번·재시도 2번)은 TS가 정해 인자로 준다(한 곳이 정한다).
//!
//! 횟수는 JS의 수 그대로 읽는다: `NaN`은 어느 비교도 거짓이라 `shouldEscalate`가 참이 되고(`times < 1`도 `length < times`도
//! 거짓이고 반복문이 한 번도 돌지 않는다), 정수가 아닌 값은 `history[length - times]`가 `undefined`라 거짓이다.

use crate::coordination;
use crate::js;
use crate::js_json::JsValue;

/// 게이트 보고서와 실패한 워크플로 확인에서 이번 시도의 실패 서명 키 집합을 하나의 글자로 만든다(정렬·중복 제거 뒤 `\n`으로 잇는다).
/// 정렬은 `Array.prototype.sort()`의 기본(UTF-16 코드 단위 순서)이다
pub fn signature_set_key(report: Option<&JsValue>, checks: &JsValue) -> Result<String, String> {
    let mut keys: Vec<String> = Vec::new();
    if let Some(report) = report.filter(|r| r.truthy()) {
        for sig in coordination::signatures_from_report(report)? {
            keys.push(coordination::signature_key(&sig)?);
        }
    }
    for check in &coordination::iterate(Some(checks), "checks")? {
        if matches!(check, JsValue::Null) {
            return Err("워크플로 확인이 null입니다".to_owned());
        }
        if !check.prop("ok").is_some_and(JsValue::truthy) {
            keys.push(coordination::signature_key(&coordination::signature_from_check(check)?)?);
        }
    }
    keys.sort_by(|a, b| js::cmp_utf16(a, b));
    keys.dedup();
    Ok(keys.join("\n"))
}

/// 마지막 `times`번의 실패 서명 집합이 모두 같으면 true(같은 실패가 연속으로 반복)
pub fn should_escalate(history: &[String], times: f64) -> bool {
    let len = history.len() as f64;
    if times < 1.0 || len < times {
        return false;
    }
    // times가 NaN이면 위 비교가 모두 거짓이고, JS의 반복문(`index = length - NaN`)은 한 번도 돌지 않아 참이다
    if times.is_nan() {
        return true;
    }
    let start = len - times;
    // 정수가 아닌 인덱스의 `history[1.5]`는 undefined라 마지막 값과 다르다
    if start.fract() != 0.0 {
        return false;
    }
    let last = &history[history.len() - 1];
    history[start as usize..].iter().all(|item| item == last)
}

/// 이번 실패로 승격할지: 같은 서명 집합이 `same_signature_times`(없으면 `default_times`)번 반복됐거나, `after_failures`가 있고 실패 횟수가 거기에 이르렀다
pub fn should_promote(same_signature_times: Option<f64>, default_times: f64, after_failures: Option<f64>, history: &[String]) -> bool {
    if should_escalate(history, same_signature_times.unwrap_or(default_times)) {
        return true;
    }
    after_failures.is_some_and(|after| history.len() as f64 >= after)
}

/// 승격한 뒤 줄 재시도 횟수. 정책에 없으면 기본값을 쓰고, 0 이하이거나 유한하지 않으면 0(예산 없음)
pub fn retry_budget_for(retry_budget: Option<f64>, default_budget: f64) -> f64 {
    let budget = retry_budget.unwrap_or(default_budget);
    if budget.is_finite() && budget > 0.0 {
        budget.floor()
    } else {
        0.0
    }
}

/// 승격을 알린 뒤 모델에게 다시 보낼 말. 마지막 실패 안내가 비어 있지 않으면 함께 보낸다
pub fn escalation_prompt(summary: &str, last_feedback: Option<&str>) -> String {
    match last_feedback {
        Some(feedback) if !feedback.is_empty() => format!("{summary}\n\n직전 검증 결과를 다시 보냅니다.\n\n{feedback}"),
        _ => summary.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn 승격_경계() {
        assert!(should_escalate(&h(&["a", "a"]), 2.0));
        assert!(!should_escalate(&h(&["a"]), 2.0));
        assert!(!should_escalate(&h(&["a", "b"]), 2.0));
        assert!(!should_escalate(&h(&["a"]), 0.0));
        assert!(should_escalate(&h(&["a", "b", "b"]), 2.0));
        assert!(!should_escalate(&h(&["a", "a"]), 2.5));
        assert!(should_escalate(&[], f64::NAN));
        assert!(!should_escalate(&h(&["a", "a"]), f64::INFINITY));
    }

    #[test]
    fn 실패_횟수_경계() {
        assert!(should_promote(Some(5.0), 2.0, Some(2.0), &h(&["a", "b"])));
        assert!(!should_promote(Some(5.0), 2.0, Some(3.0), &h(&["a", "b"])));
        assert!(should_promote(None, 2.0, None, &h(&["a", "a"])));
    }

    #[test]
    fn 재시도_예산() {
        assert_eq!(retry_budget_for(None, 2.0), 2.0);
        assert_eq!(retry_budget_for(Some(2.9), 2.0), 2.0);
        assert_eq!(retry_budget_for(Some(0.5), 2.0), 0.0);
        assert_eq!(retry_budget_for(Some(f64::NAN), 2.0), 0.0);
    }
}
