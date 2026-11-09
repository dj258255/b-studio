//! claude-code 자동 모델 선택의 규칙표(ADR-191 3단계 3f). 옛 `packages/agent/src/cli-router.ts`의 판정.
//! 복잡도·위험도 분류는 `model_router`의 것을 그대로 쓴다.

use crate::js;
use crate::js_json::{self, JsValue};
use crate::model_router::{classify_complexity, classify_risk, estimate_tokens};

/// 자동 선택이 고를 수 있는 단계. 낮은 인덱스가 더 싸고 빠르다
pub const CLI_TIERS: [&str; 3] = ["haiku", "sonnet", "opus"];

/// `CLI_TIERS.indexOf(tier)`. 모르는 값은 -1
fn tier_index(tier: &str) -> i32 {
    CLI_TIERS
        .iter()
        .position(|t| *t == tier)
        .map_or(-1, |i| i as i32)
}

pub fn tier_label(tier: &str) -> Option<&'static str> {
    match tier {
        "haiku" => Some("Haiku"),
        "sonnet" => Some("Sonnet 5"),
        "opus" => Some("Opus"),
        _ => None,
    }
}

/// tier보다 한 단계 위. 이미 최고 단계면 None. 모르는 값은 `indexOf`가 -1이라 첫 단계가 된다(옛 구현 그대로)
pub fn next_cli_tier(tier: &str) -> Option<&'static str> {
    let next = tier_index(tier) + 1;
    CLI_TIERS.get(next as usize).copied()
}

/// 두 단계 중 더 높은 쪽. `a`가 없거나 빈 문자열이면 `b`
pub fn higher_cli_tier<'a>(a: Option<&'a str>, b: &'a str) -> &'a str {
    match a.filter(|a| !a.is_empty()) {
        None => b,
        Some(a) => {
            if tier_index(a) >= tier_index(b) {
                a
            } else {
                b
            }
        }
    }
}

/// `routeCliTier`. 결과는 `{tier, reason, complexity, risk, stuckTo}` JSON
pub fn route_cli_tier(
    prompt: &str,
    intent: &str,
    sticky_tier: Option<&str>,
) -> Result<String, String> {
    let prompt = js::trim(prompt);
    if prompt.is_empty() {
        return Err("라우팅할 요청을 입력하세요".into());
    }
    let input_tokens = estimate_tokens(prompt);
    let complexity = classify_complexity(prompt, input_tokens);
    let risk = classify_risk(prompt);
    let decision = |tier: &str, reason: String, stuck: bool| {
        js_json::to_native(&js_json::object(vec![
            ("tier", Some(JsValue::str(tier))),
            ("reason", Some(JsValue::str(reason))),
            ("complexity", Some(JsValue::str(complexity))),
            ("risk", Some(JsValue::str(risk))),
            ("stuckTo", Some(JsValue::Bool(stuck))),
        ]))
    };

    if intent == "ask" {
        return Ok(decision(
            "haiku",
            "읽기만 하는 질문이라 가장 가벼운 모델로 답합니다".into(),
            false,
        ));
    }

    let escalated = risk == "high" || complexity == "complex";
    let natural = if escalated { "opus" } else { "sonnet" };
    let natural_reason = if risk == "high" {
        "인증·결제·마이그레이션 등 위험 신호가 있어"
    } else if complexity == "complex" {
        "요청이 복잡해"
    } else {
        "단순한 만들기 요청이라"
    };
    let label = |t: &str| tier_label(t).unwrap_or("");

    if let Some(sticky) = sticky_tier.filter(|s| !s.is_empty()) {
        if tier_index(sticky) > tier_index(natural) {
            return Ok(decision(
                sticky,
                format!("이 세션에서 이미 {}로 성공했어 그대로 유지합니다(모델을 바꾸면 캐시가 새로 생겨 비용이 늘어납니다)", label(sticky)),
                true,
            ));
        }
    }
    Ok(decision(
        natural,
        format!("{natural_reason} {}을 선택합니다", label(natural)),
        false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers() {
        assert_eq!(next_cli_tier("haiku"), Some("sonnet"));
        assert_eq!(next_cli_tier("opus"), None);
        assert_eq!(next_cli_tier("fable"), Some("haiku"));
        assert_eq!(higher_cli_tier(None, "sonnet"), "sonnet");
        assert_eq!(higher_cli_tier(Some("opus"), "sonnet"), "opus");
        assert_eq!(higher_cli_tier(Some("sonnet"), "sonnet"), "sonnet");
    }

    #[test]
    fn routes() {
        let out = route_cli_tier("로그인 인증 만들기", "build", Some("opus")).unwrap();
        assert!(out.contains(r#""tier":"opus""#) && out.contains(r#""stuckTo":false"#));
        assert!(route_cli_tier("  ", "build", None).is_err());
        let out = route_cli_tier("간단한 버튼", "build", Some("opus")).unwrap();
        assert!(out.contains(r#""stuckTo":true"#));
    }
}
