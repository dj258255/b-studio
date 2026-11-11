//! 벡터 차등 시험(ADR-195 4d): 옛 TS(`listAiAccounts`)가 만든 응답 본문(`tests/vectors/accounts-vectors.json`, 생성기 `gen-accounts-vectors.ts`)과
//! Rust `routes::ai_accounts::render`를 견준다. Node가 성공한 입력은 같은 본문이거나(같음) 넘김(None)이어야 하고, 다른 본문은 0이어야 한다.
//! Node가 던진 입력(500)은 반드시 넘김이어야 한다(Rust가 성공으로 답하면 안 된다).
//! 넘김이 허용되는 것은 ASCII가 아닌 그림 경로(서로게이트 쌍·대소문자 접기를 같다고 확신하지 않는다)와 짝 없는 서로게이트 이스케이프뿐이다. 그 밖의 넘김은 0이어야 한다.
use bstudio_server::routes::ai_accounts::render;
use serde_json::Value;

const VECTORS: &str = include_str!("vectors/accounts-vectors.json");

fn all_backends() -> [&'static str; 5] {
    ["claude-code", "codex", "commandcode", "opencode", "gemini"]
}

#[test]
fn 옛_ts와_같은_본문을_낸다() {
    let cases: Vec<Value> = serde_json::from_str(VECTORS).unwrap();
    let (mut same, mut deferred_ok, mut error_deferred, mut wrong_ok, mut diff, mut bad_defer) = (0, 0, 0, 0, Vec::new(), Vec::new());
    for case in &cases {
        let text = case["text"].as_str();
        let backends: Vec<&'static str> = all_backends().into_iter().filter(|b| case["backends"].as_array().unwrap().iter().any(|v| v == b)).collect();
        let got = render(text, &backends);
        match (case.get("ok").and_then(Value::as_str), got) {
            (Some(expected), Some(actual)) if expected == actual => same += 1,
            (Some(expected), Some(actual)) => diff.push(format!("{text:?}: Node {expected} / Rust {actual}")),
            (Some(_), None) => {
                // 허용하는 넘김: 파일에 ASCII가 아닌 그림 경로가 있다
                let non_ascii_sprite = serde_json::from_str::<Value>(text.unwrap_or("")).ok().and_then(|v| v["accounts"].as_array().cloned()).is_some_and(|list| list.iter().any(|e| e["sprite"].as_str().is_some_and(|s| !s.is_ascii())));
                // 또는 짝 없는 서로게이트 이스케이프(`\\ud800`)가 있어 serde_json이 받지 않는다
                if non_ascii_sprite || text.is_some_and(|t| t.contains("\\ud")) {
                    deferred_ok += 1;
                } else {
                    bad_defer.push(format!("{text:?}"));
                }
            }
            (None, None) => error_deferred += 1,
            (None, Some(actual)) => {
                wrong_ok += 1;
                diff.push(format!("{text:?}: Node 오류 / Rust {actual}"));
            }
        }
    }
    println!("전체 {} / 같음 {same} / 허용한 넘김 {deferred_ok} / 오류를 넘김 {error_deferred} / 오류인데 성공 {wrong_ok} / 다른 본문 {} / 까닭 없는 넘김 {}", cases.len(), diff.len(), bad_defer.len());
    assert!(diff.is_empty(), "{:#?}", &diff[..diff.len().min(5)]);
    assert!(bad_defer.is_empty(), "{:#?}", &bad_defer[..bad_defer.len().min(5)]);
    assert!(same > 1000 && error_deferred > 1000, "시험이 아무것도 보지 않는다");
}
