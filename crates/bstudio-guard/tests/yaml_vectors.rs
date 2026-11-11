//! spec의 YAML 읽기 벡터 시험(ADR-197). 기대값은 JS `yaml@2.9.0`이 만든 것이다(tests/vectors/gen-yaml-vectors.mjs).
//! 읽은 값은 JS가 읽은 값과 키 순서·`-0`·`NaN`·`Infinity`까지 같아야 하고, JS가 던지는 입력은 값으로 읽으면 안 된다.
//! 읽기 상태(값·거절·문법 오류)도 벡터에 고정한다: 거절 규칙이 달라지면 이 시험이 실패한다.

use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::yaml::{self, Outcome};
use serde_json::Value;

/// JS 객체 순서(정수 꼴 키가 앞, 나머지는 넣은 순서)로 풀어 쓴 글. 수는 비트로 견준다
fn canon(v: &JsValue, out: &mut String) {
    match v {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Num(n) => out.push_str(&format!("#{:016x}", if n.is_nan() { 0x7ff8_0000_0000_0000 } else { n.to_bits() })),
        JsValue::Str(s) => out.push_str(&format!("{s:?}")),
        JsValue::Arr(a) => {
            out.push('[');
            for e in a {
                canon(e, out);
                out.push(',');
            }
            out.push(']');
        }
        JsValue::Obj(o) => {
            out.push('{');
            for (k, e) in o.entries_js_order() {
                out.push_str(&format!("{k:?}:"));
                canon(e, out);
                out.push(',');
            }
            out.push('}');
        }
    }
}

fn canonical(json: &str) -> String {
    let value = js_json::parse_native(json).unwrap_or_else(|e| panic!("JSON을 읽지 못했습니다: {e}\n{json}"));
    let mut out = String::new();
    canon(&value, &mut out);
    out
}

fn status(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::Value(_) => "v",
        Outcome::Unsupported { .. } => "u",
        Outcome::Syntax { .. } => "s",
    }
}

#[test]
fn matches_js_yaml_on_all_vectors() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("vectors/yaml-vectors.json")).expect("벡터 파일");
    assert!(cases.len() > 5000, "벡터가 너무 적습니다: {}", cases.len());
    let (mut compared, mut js_failed_not_read, mut rejected) = (0usize, 0usize, 0usize);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let text = case["text"].as_str().unwrap();
        for (mode, merge) in [("plain", false), ("merge", true)] {
            let entry = &case[mode];
            let expected_status = entry["rust"].as_str().unwrap();
            // merge 모드의 기대값 "="은 기본 모드와 같다는 뜻이다
            let js = if entry["js"].as_str() == Some("=") { &case["plain"]["js"] } else { &entry["js"] };
            let outcome = yaml::parse(text, merge);
            assert_eq!(status(&outcome), expected_status, "읽기 상태가 벡터와 다릅니다 [{name} / {mode}]\n{text:?}\n{outcome:?}");
            match (js.as_str(), &outcome) {
                (None, Outcome::Value(json)) => panic!("JS가 던지는 입력을 값으로 읽었습니다 [{name} / {mode}]\n{text:?}\n{json}"),
                (None, _) => js_failed_not_read += 1,
                (Some("lone-surrogate"), Outcome::Value(json)) => panic!("짝 없는 서로게이트가 든 값을 읽었습니다 [{name} / {mode}]\n{text:?}\n{json}"),
                (Some("lone-surrogate"), _) => rejected += 1,
                (Some(expected), Outcome::Value(actual)) => {
                    assert_eq!(canonical(actual), canonical(expected), "값이 JS와 다릅니다 [{name} / {mode}]\n{text:?}");
                    compared += 1;
                }
                (Some(_), _) => rejected += 1,
            }
        }
    }
    // 시험이 비어 통과하지 않게: 값 비교와 거절 갈래가 모두 충분히 지났는지 확인한다
    assert!(compared > 4000, "값을 비교한 사례가 너무 적습니다: {compared}");
    assert!(js_failed_not_read > 5000, "JS 실패 사례가 너무 적습니다: {js_failed_not_read}");
    assert!(rejected > 500, "거절 사례가 너무 적습니다: {rejected}");
}
