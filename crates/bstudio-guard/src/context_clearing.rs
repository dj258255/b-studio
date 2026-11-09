//! 컨텍스트가 커지면 오래된 도구 결과를 묶어서 비우는 판정(ADR-191 3단계 3f). 옛 `packages/agent/src/context-clearing.ts`의 판정.
//!
//! 메시지 배열(Anthropic 메시지 모양)은 JSON으로 읽기만 하고 고치지 않는다. 무엇을 어떤 문구로 바꿀지만 계획으로 돌려주고,
//! 바꾸는 일(`{...block, content}`)은 TS 껍데기가 원본 객체 위에서 한다. 그래서 `cache_control` 같은 모르는 필드와
//! 바꾸지 않은 메시지의 참조가 그대로 남는다.

use crate::js;
use crate::js_json::{self, JsValue};
use crate::js_locale::to_locale_string;

/// 비운 자리에 남기는 표시의 접두어. 이 문구로 시작하면 이미 비운 것으로 본다
pub const CLEARED_TOOL_RESULT_PREFIX: &str = "[이전 도구 결과 생략: ";

pub fn cleared_tool_result_note(chars: f64) -> String {
    format!(
        "{CLEARED_TOOL_RESULT_PREFIX}{}자. 필요하면 같은 도구를 다시 부르세요]",
        to_locale_string(chars)
    )
}

pub fn is_cleared_tool_result(text: &str) -> bool {
    text.starts_with(CLEARED_TOOL_RESULT_PREFIX)
}

/// 도구 결과 본문의 글자 수(UTF-16). 문자열이거나 텍스트 블록 배열
fn content_chars(content: Option<&JsValue>) -> f64 {
    match content {
        Some(JsValue::Str(s)) => js::utf16_len(s) as f64,
        Some(JsValue::Arr(blocks)) => blocks.iter().fold(0.0, |sum, block| {
            sum + block
                .prop("text")
                .and_then(JsValue::as_str)
                .map_or(0.0, |t| js::utf16_len(t) as f64)
        }),
        _ => 0.0,
    }
}

struct Target {
    message: usize,
    block: usize,
    chars: f64,
}

/// `Math.max(0, x)`. NaN은 NaN으로 남는다(`f64::max`는 NaN을 버린다)
fn js_max0(x: f64) -> f64 {
    if x.is_nan() {
        x
    } else if x > 0.0 {
        x
    } else {
        0.0
    }
}

/// 비울 자리의 계획을 JSON으로 돌려준다: `{"clearedCount","clearedChars","edits":[{"message","block","note"}]}`.
/// 비울 것이 없으면 `edits`가 빈 배열이고 두 수는 0이다
pub fn plan_clear_old_tool_results(
    messages_json: &str,
    keep_recent: f64,
    clear_at_least_chars: f64,
) -> Result<String, String> {
    // 메시지의 모르는 필드(도구 입력 등)는 어떤 키든 올 수 있어 표시 객체를 해석하지 않는 `parse`로 읽는다
    let messages = js_json::parse(messages_json)?;
    let JsValue::Arr(messages) = messages else {
        return Err("messages는 배열이어야 합니다".into());
    };

    let mut targets: Vec<Target> = Vec::new();
    for (mi, message) in messages.iter().enumerate() {
        if message.prop("role").and_then(JsValue::as_str) != Some("user") {
            continue;
        }
        let Some(JsValue::Arr(blocks)) = message.prop("content") else {
            continue;
        };
        for (bi, block) in blocks.iter().enumerate() {
            if block.prop("type").and_then(JsValue::as_str) != Some("tool_result") {
                continue;
            }
            let content = block.prop("content");
            let chars = content_chars(content);
            // 이미 비운 자리는 후보에서도 최근 N개에도 넣지 않는다
            if let Some(JsValue::Str(text)) = content {
                if is_cleared_tool_result(text) {
                    continue;
                }
            }
            targets.push(Target {
                message: mi,
                block: bi,
                chars,
            });
        }
    }

    let take = js_max0(targets.len() as f64 - keep_recent);
    let count = js::relative_start(targets.len(), take);
    let candidates = &targets[..count];
    let cleared_chars = candidates.iter().fold(0.0, |sum, t| sum + t.chars);
    let none = candidates.is_empty() || cleared_chars < clear_at_least_chars;

    let edits: Vec<JsValue> = if none {
        Vec::new()
    } else {
        candidates
            .iter()
            .map(|t| {
                js_json::object(vec![
                    ("message", Some(JsValue::Num(t.message as f64))),
                    ("block", Some(JsValue::Num(t.block as f64))),
                    (
                        "note",
                        Some(JsValue::str(cleared_tool_result_note(t.chars))),
                    ),
                ])
            })
            .collect()
    };
    let out = js_json::object(vec![
        (
            "clearedCount",
            Some(JsValue::Num(if none { 0.0 } else { count as f64 })),
        ),
        (
            "clearedChars",
            Some(JsValue::Num(if none { 0.0 } else { cleared_chars })),
        ),
        ("edits", Some(JsValue::Arr(edits))),
    ]);
    Ok(js_json::to_native(&out))
}

/// `B_STUDIO_CONTEXT_CLEARING` 값이 켜짐(`on`, 앞뒤 공백·대소문자 무시)인지
pub fn is_context_clearing_on(value: Option<&str>) -> bool {
    value.is_some_and(|v| js::trim(v).to_lowercase() == "on")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans() {
        let big = "가".repeat(30);
        let msgs = format!(
            r#"[{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"a","content":"{big}"}},{{"type":"tool_result","tool_use_id":"b","content":"{big}"}}]}},{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"c","content":"{big}"}}]}}]"#
        );
        let out = plan_clear_old_tool_results(&msgs, 1.0, 10.0).unwrap();
        assert!(out.contains(r#""clearedCount":2"#) && out.contains(r#""clearedChars":60"#));
        let out = plan_clear_old_tool_results(&msgs, 1.0, 100.0).unwrap();
        assert!(out.contains(r#""clearedCount":0"#) && out.contains(r#""edits":[]"#));
        assert!(is_context_clearing_on(Some(" ON ")));
        assert!(!is_context_clearing_on(Some("onn")));
    }
}
