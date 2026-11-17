use super::*;

const NOW: i64 = 1_750_000_000_000;

fn attr(key: &str, value: &str) -> String {
    format!(r#"{{"key":"{key}","value":{value}}}"#)
}

fn complete_attrs() -> Vec<String> {
    vec![
        attr("event.name", r#"{"stringValue":"claude_code.api_request"}"#),
        attr("model", r#"{"stringValue":"claude-sonnet-5"}"#),
        attr("input_tokens", r#"{"intValue":"1000"}"#),
        attr("output_tokens", r#"{"intValue":200}"#),
        attr("cache_read_tokens", r#"{"doubleValue":3000}"#),
        attr("cache_creation_tokens", r#"{"intValue":"50"}"#),
        attr("cost_usd", r#"{"doubleValue":0.0123}"#),
        attr("duration_ms", r#"{"intValue":1234}"#),
        attr("request_id", r#"{"stringValue":"req-1"}"#),
    ]
}

fn record(attrs: &[String], extra: &str) -> String {
    format!(r#"{{"timeUnixNano":"1750000000000000000"{extra},"attributes":[{}]}}"#, attrs.join(","))
}

fn body(records: &[String]) -> String {
    format!(r#"{{"resourceLogs":[{{"scopeLogs":[{{"logRecords":[{}]}}]}}]}}"#, records.join(","))
}

fn without(key: &str) -> Vec<String> {
    complete_attrs().into_iter().filter(|entry| !entry.contains(&format!(r#""key":"{key}""#))).collect()
}

#[test]
fn complete_record_is_read_as_a_model_call() {
    let result = parse_model_calls(&body(&[record(&complete_attrs(), "")]), NOW);
    assert_eq!(result.defects, 0);
    let [call] = &result.calls[..] else { panic!("한 건이어야 한다") };
    assert_eq!(call.at_ms, 1_750_000_000_000);
    assert_eq!(call.time_source, TimeSource::Cli);
    assert_eq!((call.input_tokens, call.output_tokens, call.cache_read_tokens, call.cache_write_tokens), (1000.0, 200.0, 3000.0, 50.0));
    assert!(call.tokens_complete);
    assert_eq!(call.model, "claude-sonnet-5");
    assert_eq!((call.cost_usd, call.duration_ms), (Some(0.0123), Some(1234.0)));
    assert_eq!(call.request_id.as_deref(), Some("req-1"));
}

#[test]
fn a_record_missing_a_required_attribute_still_counts_as_a_call() {
    for key in ["model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"] {
        let result = parse_model_calls(&body(&[record(&without(key), "")]), NOW);
        assert_eq!(result.calls.len(), 1, "{key}");
        assert_eq!(result.calls[0].tokens_complete, key == "model", "{key}");
    }
    // 읽은 토큰은 그대로 더한다(내려잡은 값)
    let call = &parse_model_calls(&body(&[record(&without("cache_creation_tokens"), "")]), NOW).calls[0];
    assert_eq!((call.input_tokens, call.output_tokens, call.cache_write_tokens), (1000.0, 200.0, 0.0));
    assert_eq!(parse_model_calls(&body(&[record(&without("model"), "")]), NOW).calls[0].model, UNKNOWN_MODEL);
}

#[test]
fn bad_values_count_as_calls_with_unknown_tokens() {
    for bad in [r#"{"intValue":-1}"#, r#"{"intValue":"x"}"#, r#"{"doubleValue":2000000000}"#, "null", r#""str""#, "[]", r#"{"boolValue":true}"#] {
        let mut attrs = without("input_tokens");
        attrs.push(attr("input_tokens", bad));
        let result = parse_model_calls(&body(&[record(&attrs, "")]), NOW);
        assert_eq!(result.calls.len(), 1, "{bad}");
        assert!(!result.calls[0].tokens_complete, "{bad}");
        assert_eq!(result.calls[0].input_tokens, 0.0, "{bad}");
    }
    // 비용이 이상해도 토큰이 멀쩡하면 완전하다. 비용만 싣지 않는다
    let mut attrs = without("cost_usd");
    attrs.push(attr("cost_usd", r#"{"doubleValue":-5}"#));
    let call = &parse_model_calls(&body(&[record(&attrs, "")]), NOW).calls[0];
    assert!(call.tokens_complete);
    assert_eq!(call.cost_usd, None);
}

#[test]
fn string_numbers_follow_js_number_rules() {
    for (text, expected) in [("0x10", Some(16.0)), (" 12 ", Some(12.0)), ("1e3", Some(1000.0)), (".5", Some(0.5)), ("1_0", None), ("Infinity", None), ("", None)] {
        let mut attrs = without("output_tokens");
        attrs.push(attr("output_tokens", &format!(r#"{{"intValue":"{text}"}}"#)));
        let call = &parse_model_calls(&body(&[record(&attrs, "")]), NOW).calls[0];
        assert_eq!(call.tokens_complete, expected.is_some(), "{text:?}");
        assert_eq!(call.output_tokens, expected.unwrap_or(0.0), "{text:?}");
    }
}

#[test]
fn event_name_is_found_in_attribute_or_body_and_other_events_are_skipped() {
    let other = record(&[attr("event.name", r#"{"stringValue":"claude_code.tool_result"}"#)], "");
    assert!(parse_model_calls(&body(&[other]), NOW).calls.is_empty());
    let mut attrs = without("event.name");
    attrs.retain(|entry| !entry.contains("event.name"));
    let by_body = record(&attrs, r#","body":{"stringValue":"claude_code.api_request"}"#);
    assert_eq!(parse_model_calls(&body(&[by_body]), NOW).calls.len(), 1);
    let plain = record(&attrs, r#","body":{"stringValue":"something"}"#);
    assert!(parse_model_calls(&body(&[plain]), NOW).calls.is_empty());
}

#[test]
fn no_cap_on_the_number_of_calls() {
    let many: Vec<String> = (0..1500).map(|_| record(&complete_attrs(), "")).collect();
    assert_eq!(parse_model_calls(&body(&many), NOW).calls.len(), 1500);
}

#[test]
fn structural_defects_are_counted_not_silently_skipped() {
    for (text, defects) in [
        ("[]", 1),
        ("null", 1),
        ("\"x\"", 1),
        ("not json", 1),
        ("{}", 0),
        (r#"{"resourceLogs":[]}"#, 0),
        (r#"{"resourceLogs":"x"}"#, 1),
        (r#"{"resourceLogs":[null,7]}"#, 2),
        (r#"{"resourceLogs":[{}]}"#, 0),
        (r#"{"resourceLogs":[{"scopeLogs":"x"}]}"#, 1),
        (r#"{"resourceLogs":[{"scopeLogs":[{"logRecords":"x"},3]}]}"#, 2),
        (r#"{"resourceLogs":[{"scopeLogs":[{"logRecords":[1,"a",null]}]}]}"#, 3),
    ] {
        let result = parse_model_calls(text, NOW);
        assert_eq!(result.defects, defects, "{text}");
        assert!(result.calls.is_empty(), "{text}");
    }
    // 멀쩡한 호출은 결함 옆에서도 센다
    let mixed = format!(r#"{{"resourceLogs":[null,{{"scopeLogs":[{{"logRecords":[1,{}]}}]}}]}}"#, record(&complete_attrs(), ""));
    let result = parse_model_calls(&mixed, NOW);
    assert_eq!((result.calls.len(), result.defects), (1, 2));
}

#[test]
fn time_rules() {
    let at = |extra: &str, time: &str| {
        let text = format!(r#"{{"resourceLogs":[{{"scopeLogs":[{{"logRecords":[{{{time}"attributes":[{}]{extra}}}]}}]}}]}}"#, complete_attrs().join(","));
        let call = parse_model_calls(&text, NOW).calls.remove(0);
        (call.at_ms, call.time_source)
    };
    assert_eq!(at("", r#""timeUnixNano":"1750000000000000000","#), (NOW, TimeSource::Cli));
    // 0이면 observed, 그것도 없으면 받은 시각
    assert_eq!(at("", r#""timeUnixNano":"0","observedTimeUnixNano":"1750000000500000000","#), (NOW + 500, TimeSource::Observed));
    assert_eq!(at("", r#""timeUnixNano":0,"observedTimeUnixNano":"1750000000500000000","#), (NOW + 500, TimeSource::Observed));
    assert_eq!(at("", ""), (NOW, TimeSource::Received));
    // 숫자로 온 시각
    assert_eq!(at("", r#""timeUnixNano":1750000000000000000,"#), (NOW, TimeSource::Cli));
    // 범위 안의 가장자리는 CLI 시각, 밖은 받은 시각
    assert_eq!(at("", r#""timeUnixNano":"1749999940000000000","#), (NOW - 60_000, TimeSource::Cli));
    assert_eq!(at("", r#""timeUnixNano":"1749999939999000000","#), (NOW, TimeSource::ReceivedOffClock));
    assert_eq!(at("", r#""timeUnixNano":"1750000060001000000","#), (NOW, TimeSource::ReceivedOffClock));
    // 엉뚱한 시각: 아주 오래전, 아주 먼 미래, 자리수가 너무 큼
    assert_eq!(at("", r#""timeUnixNano":"1","#), (NOW, TimeSource::ReceivedOffClock));
    assert_eq!(at("", r#""timeUnixNano":"99999999999999999999999999999999999999","#), (NOW, TimeSource::ReceivedOffClock));
    assert_eq!(at("", r#""timeUnixNano":"999999999999999999999999999999999999999999","#), (NOW, TimeSource::ReceivedOffClock));
    // 읽을 수 없는 꼴은 건너뛴다
    assert_eq!(at("", r#""timeUnixNano":"abc","#), (NOW, TimeSource::Received));
    assert_eq!(at("", r#""timeUnixNano":-5,"observedTimeUnixNano":"1750000000000000000","#), (NOW, TimeSource::Observed));
}

#[test]
fn codex_completed_keeps_the_old_rules() {
    let codex = |over: &[(&str, &str)]| {
        let mut attrs: Vec<(String, String)> = [
            ("event.name", r#"{"stringValue":"codex.sse_event"}"#),
            ("event.kind", r#"{"stringValue":"response.completed"}"#),
            ("input_token_count", r#"{"stringValue":"100"}"#),
            ("output_token_count", r#"{"stringValue":"20"}"#),
            ("cached_token_count", r#"{"stringValue":"80"}"#),
            ("cache_write_token_count", r#"{"stringValue":"0"}"#),
            ("event.timestamp", r#"{"stringValue":"2026-10-22T03:02:15.381Z"}"#),
            ("conversation.id", r#"{"stringValue":"conv-1"}"#),
            ("model", r#"{"stringValue":"gpt-5.5"}"#),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        for (key, value) in over {
            attrs.retain(|(k, _)| k != key);
            attrs.push(((*key).to_owned(), (*value).to_owned()));
        }
        let rendered: Vec<String> = attrs.iter().map(|(k, v)| attr(k, v)).collect();
        let text = body(&[format!(r#"{{"timeUnixNano":"0","observedTimeUnixNano":"1750000000000000000","attributes":[{}]}}"#, rendered.join(","))]);
        parse_model_calls(&text, NOW).calls
    };
    let [call] = &codex(&[])[..] else { panic!() };
    assert_eq!((call.input_tokens, call.output_tokens, call.cache_read_tokens), (20.0, 20.0, 80.0));
    assert_eq!(call.request_id.as_deref(), Some("conv-1:2026-10-22T03:02:15.381Z"));
    assert_eq!(call.conversation_id.as_deref(), Some("conv-1"));
    assert_eq!(call.time_source, TimeSource::Observed);
    // 캐시 읽기가 입력보다 크거나 값이 이상하면 버린다(Codex는 옛 규칙 그대로다)
    assert!(codex(&[("cached_token_count", r#"{"stringValue":"101"}"#)]).is_empty());
    assert!(codex(&[("output_token_count", r#"{"stringValue":"-1"}"#)]).is_empty());
}

#[test]
fn agent_label_comes_from_name_or_query_source() {
    let mut attrs = complete_attrs();
    attrs.push(attr("agent.name", r#"{"stringValue":"  Explore  "}"#));
    assert_eq!(parse_model_calls(&body(&[record(&attrs, "")]), NOW).calls[0].agent.as_deref(), Some("Explore"));
    let mut attrs = complete_attrs();
    attrs.push(attr("query_source", r#"{"stringValue":"agent:custom:my:agent"}"#));
    assert_eq!(parse_model_calls(&body(&[record(&attrs, "")]), NOW).calls[0].agent.as_deref(), Some("my:agent"));
    let mut attrs = complete_attrs();
    attrs.push(attr("query_source", r#"{"stringValue":"repl_main_thread"}"#));
    assert_eq!(parse_model_calls(&body(&[record(&attrs, "")]), NOW).calls[0].agent, None);
}

#[test]
fn later_duplicate_attribute_wins_even_when_it_has_no_value() {
    let mut attrs = complete_attrs();
    attrs.push(r#"{"key":"input_tokens"}"#.to_owned());
    let call = &parse_model_calls(&body(&[record(&attrs, "")]), NOW).calls[0];
    assert!(!call.tokens_complete);
}
