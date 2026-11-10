//! 큰 JSON 참조 파일의 구조 요약(옛 TS: `packages/agent/src/json-summary.ts`의 `summarizeJsonStructure`·`summarizeJsonContent`, ADR-191 3단계 3af).
//! 파일 크기 상한 확인과 파일 읽기는 TS가 한다(상한은 읽기 전에 본다). 요약은 모델 문맥에 들어가는 안내 글이다(판정이 아니다).
//!
//! 의도한 차이: 중첩이 `js_json`의 읽기 깊이를 넘으면 요약하지 않는다(`None`, 옛 TS는 읽었다). 호출하는 쪽은 `None`이면 첫 줄 미리보기로 대신한다.
//! 글자는 `encodeLoneSurrogates`한 것을 받아 같은 인코딩으로 돌려준다(짝 없는 서로게이트 이스케이프 `\ud800`을 U+FFFD로 합치지 않는다).

use crate::js;
use crate::js_json::{self, JsValue};
use crate::js_locale;

fn describe_type(value: &JsValue) -> String {
    match value {
        JsValue::Null => "null".to_owned(),
        JsValue::Arr(items) => format!("배열({})", js_locale::to_locale_string(items.len() as f64)),
        JsValue::Bool(_) => "boolean".to_owned(),
        JsValue::Num(_) => "number".to_owned(),
        JsValue::Str(_) => "string".to_owned(),
        JsValue::Obj(_) => "object".to_owned(),
    }
}

/// 배열의 첫 항목이 객체면 "키: 타입" 나열, 원시값이거나 배열이면(빈 객체도) 보여 줄 필드가 없다
fn describe_first_item_fields(first: Option<&JsValue>) -> Option<String> {
    let JsValue::Obj(object) = first? else { return None };
    let entries: Vec<String> = object.entries_js_order().into_iter().map(|(key, value)| format!("{key}: {}", describe_type(value))).collect();
    (!entries.is_empty()).then(|| entries.join(", "))
}

pub fn summarize_json_structure(parsed: &JsValue) -> String {
    match parsed {
        JsValue::Arr(items) => {
            let base = format!("배열, {}개 항목", js_locale::to_locale_string(items.len() as f64));
            match describe_first_item_fields(items.first()) {
                Some(fields) => format!("{base} · 첫 항목 필드: {fields}"),
                None => base,
            }
        }
        JsValue::Obj(object) => {
            let entries: Vec<String> = object
                .entries_js_order()
                .into_iter()
                .map(|(key, value)| match value {
                    JsValue::Arr(items) => format!("{key} {}개", js_locale::to_locale_string(items.len() as f64)),
                    _ => key.to_owned(),
                })
                .collect();
            if entries.is_empty() {
                "(빈 객체)".to_owned()
            } else {
                entries.join(", ")
            }
        }
        JsValue::Null => "null".to_owned(),
        JsValue::Bool(b) => b.to_string(),
        JsValue::Num(n) => js::number_to_string(*n),
        JsValue::Str(s) => s.clone(),
    }
}

/// 글자를 JSON으로 풀어 구조를 요약한다. JSON이 아니거나(JS `JSON.parse`가 던지는 글자) 너무 깊으면 `None`
pub fn summarize_json_content(content: &str) -> Option<String> {
    let parsed = js_json::parse_lone_encoded(content).ok()?;
    Some(summarize_json_structure(&parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_like_the_old_ts() {
        assert_eq!(summarize_json_content("[1,2,3]").as_deref(), Some("배열, 3개 항목"));
        assert_eq!(summarize_json_content("[]").as_deref(), Some("배열, 0개 항목"));
        assert_eq!(summarize_json_content("[{}]").as_deref(), Some("배열, 1개 항목"));
        assert_eq!(summarize_json_content(r#"[{"id":1,"name":"a","tags":[1,2],"on":true,"d":null,"o":{}}, 2]"#).as_deref(), Some("배열, 2개 항목 · 첫 항목 필드: id: number, name: string, tags: 배열(2), on: boolean, d: null, o: object"));
        assert_eq!(summarize_json_content(r#"{"posts":[1],"meta":{},"c":[]}"#).as_deref(), Some("posts 1개, meta, c 0개"));
        assert_eq!(summarize_json_content("{}").as_deref(), Some("(빈 객체)"));
        assert_eq!(summarize_json_content("12").as_deref(), Some("12"));
        assert_eq!(summarize_json_content("1e999").as_deref(), Some("Infinity"));
        assert_eq!(summarize_json_content("-0").as_deref(), Some("0"));
        assert_eq!(summarize_json_content("null").as_deref(), Some("null"));
        assert_eq!(summarize_json_content("true").as_deref(), Some("true"));
        assert_eq!(summarize_json_content(r#""x y""#).as_deref(), Some("x y"));
        assert_eq!(summarize_json_content("nope"), None);
        assert_eq!(summarize_json_content(""), None);
    }

    #[test]
    fn object_keys_use_js_order_and_big_counts_group() {
        assert_eq!(summarize_json_content(r#"{"b":1,"2":1,"1":[1],"a":1}"#).as_deref(), Some("1 1개, 2, b, a"));
        let big = format!("[{}]", vec!["0"; 2076].join(","));
        assert_eq!(summarize_json_content(&big).as_deref(), Some("배열, 2,076개 항목"));
        assert_eq!(summarize_json_content(r#"{"a":1,"a":[1,2]}"#).as_deref(), Some("a 2개"));
    }
}
