use super::*;

fn ev(ty: &str, n: usize) -> String {
    format!(r#"{{"type":"{ty}","n":{n}}}"#)
}

fn run(request: &str) -> String {
    format!(r#"{{"type":"run_started","runId":"r","request":{request},"at":"a"}}"#)
}

fn push(record: &mut SessionRecord, json: String) -> PushOutcome {
    record.push(json).unwrap()
}

#[test]
fn 기록하지_않는_이벤트는_쌓지_않고_저장을_예약하지_않는다() {
    let mut record = SessionRecord::new(true);
    for ty in ["usage", "sandbox_link", "files_changed", "tests_changed", "deploy_log", "label"] {
        assert_eq!(push(&mut record, ev(ty, 0)), PushOutcome { recorded: false, schedule: false }, "{ty}");
    }
    assert_eq!((record.history_len(), record.logs_len()), (0, 0));
}

#[test]
fn log는_logs에만_쌓고_저장을_예약하지_않는다() {
    let mut record = SessionRecord::new(true);
    assert_eq!(push(&mut record, ev("log", 0)), PushOutcome { recorded: true, schedule: false });
    assert_eq!((record.history_len(), record.logs_len()), (0, 1));
    assert_eq!(push(&mut record, ev("notice", 0)), PushOutcome { recorded: true, schedule: true });
    assert_eq!((record.history_len(), record.logs_len()), (1, 1));
}

#[test]
fn log가_아닌_기록_이벤트는_history에_쌓고_저장을_예약한다() {
    let mut record = SessionRecord::new(true);
    for ty in ["notice", "status", "run_started", "service", "snapshot"] {
        assert_eq!(push(&mut record, ev(ty, 0)), PushOutcome { recorded: true, schedule: true }, "{ty}");
    }
    assert_eq!(record.logs_len(), 0);
}

#[test]
fn history와_logs_상한은_각각_앞에서_자른다() {
    let mut record = SessionRecord::with_limits(true, 5, 3);
    for n in 0..8 {
        push(&mut record, ev("notice", n));
        push(&mut record, ev("log", n));
    }
    assert_eq!(record.history(), (3..8).map(|n| ev("notice", n)).collect::<Vec<_>>());
    assert_eq!(record.logs(), (5..8).map(|n| ev("log", n)).collect::<Vec<_>>());
}

#[test]
fn 기본_상한은_5000과_1000이다() {
    let mut record = SessionRecord::new(true);
    for n in 0..5_003 {
        push(&mut record, ev("notice", n));
    }
    for n in 0..1_002 {
        push(&mut record, ev("log", n));
    }
    assert_eq!((record.history_len(), record.logs_len()), (5_000, 1_000));
    assert_eq!(record.history()[0], ev("notice", 3));
    assert_eq!(record.logs()[0], ev("log", 2));
}

#[test]
fn 상한_경계에서_자르는_개수가_맞다() {
    for (limit, count) in [(5usize, 4usize), (5, 5), (5, 6), (5, 7)] {
        let mut record = SessionRecord::with_limits(true, limit, 3);
        for n in 0..count {
            push(&mut record, ev("notice", n));
        }
        assert_eq!(record.history_len(), count.min(limit), "{count}개");
    }
}

#[test]
fn 마지막_run_started는_첫_것이_아니다() {
    let mut record = SessionRecord::new(true);
    push(&mut record, run(r#""첫""#));
    push(&mut record, ev("notice", 1));
    push(&mut record, run(r#""둘째""#));
    push(&mut record, ev("notice", 2));
    assert_eq!(record.last_run_started(), Some(run(r#""둘째""#).as_str()));
}

#[test]
fn 마지막_run_started가_상한에_밀려_나가면_없다() {
    let mut record = SessionRecord::with_limits(true, 4, 3);
    push(&mut record, run(r#""r""#));
    for n in 0..3 {
        push(&mut record, ev("notice", n));
        assert!(record.last_run_started().is_some(), "{n}");
    }
    push(&mut record, ev("notice", 9));
    assert_eq!(record.last_run_started(), None);
}

#[test]
fn log나_기록하지_않는_이벤트의_run_started는_history의_것이_아니다() {
    let mut record = SessionRecord::new(true);
    push(&mut record, run(r#""r""#));
    push(&mut record, r#"{"type":"log","service":"s","text":"run_started"}"#.to_owned());
    push(&mut record, r#"{"type":"usage","note":"run_started"}"#.to_owned());
    assert_eq!(record.last_run_started(), Some(run(r#""r""#).as_str()));
}

#[test]
fn tail은_끝_n개이고_n이_길이_이상이면_전부다() {
    let mut record = SessionRecord::new(true);
    for n in 0..5 {
        push(&mut record, ev("notice", n));
    }
    assert_eq!(record.tail(2), vec![ev("notice", 3), ev("notice", 4)]);
    assert_eq!(record.tail(5).len(), 5);
    assert_eq!(record.tail(40).len(), 5);
    assert!(record.tail(0).is_empty());
}

#[test]
fn 저장용_history는_저장하지_않는_종류를_빼고_끝_2000개다() {
    let mut record = SessionRecord::new(true);
    // replace_history는 상한을 걸지 않으므로 push의 5,000개 상한과 무관하게 본다
    record.replace_history((0..2_500).flat_map(|n| ["notice", "status", "service", "snapshot"].map(|ty| ev(ty, n))).collect()).unwrap();
    let trimmed = record.trimmed_history();
    assert_eq!(trimmed.len(), 2_000);
    assert_eq!(trimmed[0], ev("notice", 500));
    assert!(trimmed.iter().all(|json| json.contains("notice")));
}

#[test]
fn 저장용_history는_log와_usage와_deploy_log도_뺀다() {
    let mut record = SessionRecord::new(true);
    record.replace_history(["log", "usage", "deploy_log", "service", "status", "snapshot", "label", "notice", "run_started"].iter().map(|ty| ev(ty, 0)).collect()).unwrap();
    assert_eq!(record.trimmed_history(), vec![ev("label", 0), ev("notice", 0), ev("run_started", 0)]);
}

#[test]
fn replace_history는_상한도_걸러_내기도_하지_않는다() {
    let mut record = SessionRecord::new(true);
    record.replace_history((0..5_010).map(|n| ev("usage", n)).collect()).unwrap();
    assert_eq!(record.history_len(), 5_010);
    push(&mut record, ev("notice", 0));
    assert_eq!(record.history_len(), 5_000);
}

#[test]
fn replace_history는_앞의_기록과_마지막_요청을_버린다() {
    let mut record = SessionRecord::new(true);
    push(&mut record, run(r#""옛""#));
    record.replace_history(vec![ev("notice", 1)]).unwrap();
    assert_eq!(record.last_run_started(), None);
    assert_eq!(record.history(), vec![ev("notice", 1)]);
    record.replace_history(vec![run(r#""새""#), ev("notice", 2)]).unwrap();
    assert_eq!(record.last_run_started(), Some(run(r#""새""#).as_str()));
}

#[test]
fn replace_history는_하나라도_틀리면_아무것도_바꾸지_않는다() {
    let mut record = SessionRecord::new(true);
    push(&mut record, ev("notice", 1));
    assert!(record.replace_history(vec![ev("notice", 2), "{".to_owned()]).is_err());
    assert_eq!(record.history(), vec![ev("notice", 1)]);
}

#[test]
fn append는_상한과_걸러_내기_없이_덧붙이고_마지막_요청을_갱신한다() {
    let mut record = SessionRecord::with_limits(true, 2, 2);
    for n in 0..3 {
        record.append(ev("usage", n)).unwrap();
    }
    assert_eq!(record.history_len(), 3);
    record.append(run(r#""r""#)).unwrap();
    assert_eq!(record.last_run_started(), Some(run(r#""r""#).as_str()));
    assert!(record.append("nope".to_owned()).is_err());
    assert_eq!(record.history_len(), 4);
}

#[test]
fn 보관_세션의_기록은_logs가_없고_로그를_쌓지_않는다() {
    let mut record = SessionRecord::new(false);
    assert!(!record.has_logs());
    assert_eq!(push(&mut record, ev("log", 0)), PushOutcome { recorded: false, schedule: false });
    assert!(record.logs().is_empty());
    assert_eq!(push(&mut record, ev("notice", 0)), PushOutcome { recorded: true, schedule: true });
    assert_eq!(record.history_len(), 1);
    assert!(SessionRecord::new(true).has_logs());
}

#[test]
fn type이_글자가_아니거나_없으면_보통_이벤트다() {
    let mut record = SessionRecord::new(true);
    for json in [r#"{"type":5}"#, r#"{"type":null}"#, "{}", "[]", r#""log""#, "5", "null", r#"{"type":["log"]}"#, r#"{"type":{"x":"log"}}"#] {
        assert_eq!(push(&mut record, json.to_owned()), PushOutcome { recorded: true, schedule: true }, "{json}");
    }
    assert_eq!(record.logs_len(), 0);
    assert_eq!(record.last_run_started(), None);
}

#[test]
fn type을_json_parse처럼_읽는다() {
    let mut record = SessionRecord::new(true);
    // 이스케이프한 키·값, 공백, 같은 키가 두 번(뒤가 이긴다)
    assert!(!push(&mut record, r#"{ "type" : "log" }"#.to_owned()).schedule);
    assert_eq!(record.logs_len(), 1);
    assert!(!push(&mut record, r#"{"type":"notice","type":"usage"}"#.to_owned()).recorded);
    assert!(push(&mut record, r#"{"type":"usage","type":"notice"}"#.to_owned()).recorded);
    push(&mut record, r#"{"type":"run_started"}"#.to_owned());
    assert_eq!(record.last_run_started(), Some(r#"{"type":"run_started"}"#));
}

#[test]
fn 대소문자나_앞뒤_공백이_다른_type은_다른_종류다() {
    let mut record = SessionRecord::new(true);
    for ty in ["Log", "log ", " log", "login", "logs", "USAGE", "usage2", "users", "labels", "Run_Started", "run_start", "run_started2", "xrun_started", "run_finished"] {
        assert_eq!(push(&mut record, ev(ty, 0)), PushOutcome { recorded: true, schedule: true }, "{ty}");
    }
    assert_eq!(record.logs_len(), 0);
    assert_eq!(record.last_run_started(), None);
}

#[test]
fn json이_아니면_오류이고_아무것도_쌓지_않는다() {
    let mut record = SessionRecord::new(true);
    for bad in ["", "{", "{\"type\":\"log\"", "nope", "{\"a\":1} x", "{'type':'log'}"] {
        assert!(record.push(bad.to_owned()).is_err(), "{bad:?}");
    }
    assert_eq!((record.history_len(), record.logs_len()), (0, 0));
}

#[test]
fn 너무_깊은_이벤트는_보통_이벤트로_쌓는다() {
    let mut record = SessionRecord::new(true);
    let deep = format!(r#"{{"type":"log","d":{}{}}}"#, "[".repeat(3_000), "]".repeat(3_000));
    // type을 읽지 못하니 log로 알아보지 못한다(문서의 의도한 차이)
    assert_eq!(push(&mut record, deep.clone()), PushOutcome { recorded: true, schedule: true });
    assert_eq!(record.history(), vec![deep.as_str()]);
}

#[test]
fn 이벤트는_글자_그대로_돌려준다() {
    let mut record = SessionRecord::new(true);
    let raw = r#"{"type":"notice","text":"\ud83d 짝 없는 \ude00  \u0000","n":-0,"m":{"\u0000nf":"NaN"}}"#.to_owned();
    push(&mut record, raw.clone());
    assert_eq!(record.history(), vec![raw.as_str()]);
}

#[test]
fn logs가_섞여도_마지막_요청을_찾는다() {
    let mut record = SessionRecord::with_limits(true, 4, 3);
    push(&mut record, run(r#""r""#));
    for n in 0..10 {
        push(&mut record, ev("log", n));
    }
    push(&mut record, ev("notice", 1));
    push(&mut record, ev("log", 11));
    assert_eq!(record.last_run_started(), Some(run(r#""r""#).as_str()));
}

#[test]
fn run_started_앞에_로그가_끼어도_마지막_요청을_찾는다() {
    // history의 순번에 로그가 끼면 순번 뺄셈이 어긋난다
    let mut record = SessionRecord::new(true);
    push(&mut record, ev("notice", 0));
    for n in 0..3 {
        push(&mut record, ev("log", n));
    }
    push(&mut record, run(r#""r""#));
    push(&mut record, ev("notice", 1));
    assert_eq!(record.last_run_started(), Some(run(r#""r""#).as_str()));
}
