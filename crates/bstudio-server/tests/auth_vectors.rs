//! 벡터 차등 시험(ADR-195 4c): 옛 TS(`apps/studio/lib/server/auth.ts`)가 진짜 `node:http` 서버 안에서 낸 판단(`tests/vectors/auth-vectors.json`,
//! 생성기는 `tests/vectors/gen-auth-vectors.ts`)과 Rust `auth::decide`의 판단을 견준다. 같은 날것의 입력(요청 줄, 헤더 바이트, 환경 변수, 무효화 파일)을 쓴다.
//!
//! 세는 것(더 막음·더 엶·넘김):
//!
//! - 더 막음: Node는 통과·허용인데 앞단은 거절한다(정상 요청이 거절된다. 가용성)
//! - 더 엶: Node는 거절인데 앞단은 통과·허용한다(Node가 다시 판단하므로 뚫리지는 않지만 앞단 판단이 틀린 것)
//! - 넘김: 앞단이 판단하지 않고 Node로 넘긴다(Node가 판단한다). 이유별로 센다
//!
//! 더 막음과 더 엶, 그 밖의 다름은 0이어야 한다.
use std::collections::BTreeMap;
use std::path::Path;

use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Uri};
use bstudio_server::auth::{self, Decision, Env};
use bstudio_server::proxy::request_view;
use serde_json::Value;

const VECTORS: &str = include_str!("vectors/auth-vectors.json");

/// 더 많은 벡터로 찾아볼 때: `AUTH_VECTORS_FILE=<경로>`가 있으면 그 파일을 쓴다(생성기의 `VECTOR_OUT`·`VECTOR_SEED`·`VECTOR_COUNT`)
fn vectors_text() -> String {
    match std::env::var("AUTH_VECTORS_FILE") {
        Ok(file) => std::fs::read_to_string(file).unwrap(),
        Err(_) => VECTORS.to_string(),
    }
}

/// 생성기가 만든 폴더 모양을 이 시험의 임시 폴더에 같은 모양으로 만든다
fn materialize(root: &Path, id: u64, rev: &Value) {
    let dir = root.join("rev").join(id.to_string());
    match rev["kind"].as_str().unwrap() {
        "absent" => {}
        "text" => {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("revocations.json"), rev["text"].as_str().unwrap()).unwrap();
        }
        "isdir" => std::fs::create_dir_all(dir.join("revocations.json")).unwrap(),
        "enotdir" => {
            std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
            std::fs::write(&dir, "file").unwrap();
        }
        other => panic!("모르는 무효화 기록 종류: {other}"),
    }
}

#[derive(Default)]
struct Tally {
    total: usize,
    compared: usize,
    node_parse_skipped: usize,
    hyper_rejects: usize,
    same: BTreeMap<String, usize>,
    more_blocking: Vec<String>,
    more_open: Vec<String>,
    other_mismatch: Vec<String>,
    deferred: BTreeMap<(String, String), usize>,
}

fn describe(decision: &Decision) -> String {
    format!("{decision:?}")
}

#[test]
fn 벡터_수천_개가_옛_ts와_같은_판단을_낸다() {
    let data: Value = serde_json::from_str(&vectors_text()).unwrap();
    let envs = data["envs"].as_array().unwrap();
    let now = data["now"].as_f64().unwrap();
    let root = tempfile::Builder::new().prefix("bsv").tempdir_in("/tmp").unwrap();
    let root_text = root.path().to_str().unwrap().to_string();
    let mut tally = Tally::default();

    for vector in data["vectors"].as_array().unwrap() {
        tally.total += 1;
        let id = vector["id"].as_u64().unwrap();
        let expected = &vector["expected"];
        let kind = expected["kind"].as_str().unwrap();
        if kind == "nodeparse" {
            // Node의 파서가 400으로 거절한 요청. 판단까지 오지 않는다
            tally.node_parse_skipped += 1;
            continue;
        }

        // 환경: 생성기의 환경에 이 시험의 상태 폴더를 더한다
        let mut pairs: Vec<(String, String)> = envs[vector["e"].as_u64().unwrap() as usize].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
        let dir = format!("{root_text}/rev/{id}");
        pairs.push(("B_STUDIO_AUTH_STATE_DIR".to_string(), dir.clone()));
        let env = Env::from_pairs(pairs);
        materialize(root.path(), id, &vector["rev"]);

        // hyper가 받는 요청의 꼴로 만든다(프록시가 실제로 보는 것)
        let method = Method::from_bytes(vector["method"].as_str().unwrap().as_bytes());
        let uri = vector["target"].as_str().unwrap().parse::<Uri>();
        let mut headers = HeaderMap::new();
        let mut buildable = method.is_ok() && uri.is_ok();
        for pair in vector["headers"].as_array().unwrap() {
            let name = HeaderName::from_bytes(pair[0].as_str().unwrap().as_bytes());
            let bytes: Vec<u8> = pair[1].as_str().unwrap().chars().map(|c| c as u32 as u8).collect();
            match (name, HeaderValue::from_bytes(&bytes)) {
                (Ok(name), Ok(value)) => {
                    headers.append(name, value);
                }
                _ => buildable = false,
            }
        }
        if !buildable {
            // hyper가 400으로 거절하는 요청(비ASCII 요청 줄 등)이라 판단까지 오지 않는다
            tally.hyper_rejects += 1;
            continue;
        }
        let view = request_view(&method.unwrap(), &uri.unwrap(), &headers);
        let mut loader = auth::file_loader(&env);
        let decision = auth::decide(&view, &env, now, &mut loader);
        tally.compared += 1;

        let fix = |text: &str| text.replace("{ROOT}", &root_text);
        let label = format!("#{id} {} {} headers={} env={} -> 앞단 {} / Node {}", view.method, view.target, vector["headers"], envs[vector["e"].as_u64().unwrap() as usize], describe(&decision), expected);
        match (&decision, kind) {
            (Decision::Defer(reason), _) => {
                *tally.deferred.entry(((*reason).to_string(), kind.to_string())).or_default() += 1;
            }
            (Decision::Pass, "pass") => *tally.same.entry("pass".into()).or_default() += 1,
            (Decision::Allow { user }, "allow") if user == expected["user"].as_str().unwrap() => *tally.same.entry("allow".into()).or_default() += 1,
            (Decision::Reject { status, message, api }, "reject") => {
                let status_same = u64::from(*status) == expected["status"].as_u64().unwrap() && *api == expected["api"].as_bool().unwrap();
                let expected_message = fix(expected["message"].as_str().unwrap());
                let rev_kind = vector["rev"]["kind"].as_str().unwrap();
                // 의도한 차이: 파일을 읽다 실패한 오류 글의 뒷부분(Node의 fs 오류 글)은 같게 만들 수 없다
                let read_failure = format!("{dir}/revocations.json을(를) 읽지 못했습니다: ");
                let message_same = *message == expected_message
                    || match rev_kind {
                        // 본문 읽기 실패: Node는 fs 오류 글만 던진다(파일 이름 앞머리 없음)
                        "isdir" => *status == 500 && expected_message.contains("EISDIR") && message.starts_with(&read_failure),
                        "enotdir" => *status == 500 && message.starts_with(&read_failure) && expected_message.starts_with(&read_failure),
                        _ => false,
                    };
                if status_same && message_same {
                    *tally.same.entry("reject".into()).or_default() += 1;
                } else {
                    tally.other_mismatch.push(label);
                }
            }
            (Decision::Reject { .. }, "pass" | "allow") => tally.more_blocking.push(label),
            (Decision::Pass | Decision::Allow { .. }, "reject") => tally.more_open.push(label),
            _ => tally.other_mismatch.push(label),
        }
    }

    eprintln!("벡터 {}개: 비교 {}, Node 파서 거절로 건너뜀 {}, hyper 거절로 건너뜀 {}", tally.total, tally.compared, tally.node_parse_skipped, tally.hyper_rejects);
    eprintln!("같음 {:?}", tally.same);
    eprintln!("넘김(이유, Node의 결과) {:#?}", tally.deferred);
    eprintln!("더 막음 {}, 더 엶 {}, 그 밖의 다름 {}", tally.more_blocking.len(), tally.more_open.len(), tally.other_mismatch.len());
    for label in tally.more_blocking.iter().chain(&tally.more_open).chain(&tally.other_mismatch).take(25) {
        eprintln!("  {label}");
    }
    assert_eq!((tally.more_blocking.len(), tally.more_open.len(), tally.other_mismatch.len()), (0, 0, 0));
    assert!(tally.compared >= 5000, "비교한 벡터가 너무 적다: {}", tally.compared);
    // 넘김이 판단을 비우지 않게: Node가 판단하는 입력 가운데 넘기는 것은 이유가 정해진 자리뿐이다
    for ((reason, node_kind), count) in &tally.deferred {
        let node_fails = reason.contains("Node가") && !reason.contains("작업 폴더") ;
        assert!(!node_fails || node_kind == "nodefail", "Node가 판단하는 입력을 넘겼다: {reason} / {node_kind} x{count}");
    }
}

#[test]
fn 상태_폴더는_path_resolve와_같다() {
    let data: Value = serde_json::from_str(&vectors_text()).unwrap();
    let cases = data["stateDirs"].as_array().unwrap();
    assert!(cases.len() > 40);
    for case in cases {
        let (input, cwd, expected) = (case["input"].as_str().unwrap(), case["cwd"].as_str().unwrap(), case["expected"].as_str().unwrap());
        assert_eq!(auth::path_resolve(input, cwd), expected, "{input:?} @ {cwd}");
    }
}
