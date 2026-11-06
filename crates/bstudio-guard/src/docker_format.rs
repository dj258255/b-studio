//! `docker`·`docker compose`가 낸 출력과 edge 감사 로그를 읽는다(옛 TS: `packages/sandbox/src/docker/format.ts`의 해석 함수).
//! `buildOverride`·`composeUpArgs`는 보안 결정을 담은 계획 함수라 옮기지 않았다(2b-2).
//!
//! 날짜(`new Date(...)`)는 JS가 읽어야 해서 문자열로 돌려주고 TS가 `Date`로 바꾼다.

use regex::Regex;
use std::sync::LazyLock;

use crate::js::{self, cmp_utf16, number_to_string, relative_start, to_number};
use crate::js_json::{self, object, JsValue};
use crate::usage::CONTAINER_STATES;

/// JS `stripAnsi`의 정규식: OSC(`ESC ]` … BEL 또는 `ESC \`), CSI(`ESC [` 또는 `\u009b`), 두 글자 이스케이프
static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))|(?:(?:\x1b\[|\x{9b})[0-?]*[ -/]*[@-~])|(?:\x1b[@-Z\\-_0-9=>c])").expect("ANSI 정규식")
});

pub fn strip_ansi(text: &str) -> String {
    ANSI.replace_all(text, "").into_owned()
}

const EGRESS_PREFIX: &str = "{\"edge\":\"egress\"";

/// edge 감사 로그 한 줄: `{"edge":"egress","decision":"deny","host":"example.com","port":443,"reason":"...","at":"..."}`.
/// `at`은 문자열 그대로 돌려준다(TS가 `new Date`로 바꾼다)
pub fn parse_egress_denial(text: &str) -> Option<JsValue> {
    if !text.starts_with(EGRESS_PREFIX) {
        return None;
    }
    let entry = js_json::parse(text).ok()?;
    let is = |k: &str, want: &str| matches!(entry.prop(k), Some(JsValue::Str(s)) if s == want);
    let (host, at) = (entry.prop("host"), entry.prop("at"));
    if !is("decision", "deny")
        || !matches!(host, Some(JsValue::Str(_)))
        || !matches!(at, Some(JsValue::Str(_)))
    {
        return None;
    }
    let string = |k: &str| {
        entry
            .prop(k)
            .filter(|v| matches!(v, JsValue::Str(_)))
            .cloned()
    };
    Some(object(vec![
        ("host", host.cloned()),
        (
            "port",
            entry
                .prop("port")
                .filter(|v| matches!(v, JsValue::Num(_)))
                .cloned(),
        ),
        ("method", string("method")),
        ("path", string("path")),
        (
            "reason",
            Some(string("reason").unwrap_or_else(|| JsValue::str(""))),
        ),
        ("at", at.cloned()),
    ]))
}

/// 레인 세션 기동 실패를 진단할 때 덧붙일 edge 감사 로그 최근 줄. 거부(deny)와 상류 장애(error)를 "<host>: <이유>"로 줄인다
pub fn egress_audit_excerpt(lines: &[String], max: f64) -> Vec<String> {
    let mut picked = Vec::new();
    for line in lines {
        if !line.starts_with(EGRESS_PREFIX) {
            continue;
        }
        let Ok(entry) = js_json::parse(line) else {
            continue;
        };
        let decision = match entry.prop("decision") {
            Some(JsValue::Str(s)) if s == "deny" || s == "error" => s.clone(),
            _ => continue,
        };
        let Some(JsValue::Str(host)) = entry.prop("host") else {
            continue;
        };
        let reason = match entry.prop("reason") {
            Some(JsValue::Str(r)) => r.clone(),
            _ => decision,
        };
        picked.push(format!("{host}: {reason}"));
    }
    // picked.slice(-max)
    let start = relative_start(picked.len(), -max);
    picked.split_off(start)
}

/// `docker info --format '{{json .Runtimes}}'` 출력에서 등록된 런타임 이름을 읽는다
pub fn parse_runtimes(stdout: &str) -> Vec<String> {
    let text = js::trim(stdout);
    let Ok(runtimes) = js_json::parse(if text.is_empty() { "{}" } else { text }) else {
        return Vec::new();
    };
    let mut keys: Vec<String> = match &runtimes {
        JsValue::Obj(o) => o.entries().iter().map(|(k, _)| k.clone()).collect(),
        JsValue::Arr(items) => (0..items.len()).map(|i| i.to_string()).collect(),
        _ => return Vec::new(),
    };
    keys.sort_by(|a, b| cmp_utf16(a, b));
    keys
}

/// `docker compose port <service> <port>` 출력에서 호스트 포트를 읽는다
pub fn parse_host_port(stdout: &str) -> Result<f64, String> {
    let last = js::trim(stdout).split('\n').next_back().unwrap_or("");
    let port = js::trailing_colon_digits(last).map_or(0.0, to_number);
    if port == 0.0 || port.is_nan() {
        return Err(format!(
            "공개된 호스트 포트를 찾을 수 없습니다: {}",
            js::json_quote(stdout)
        ));
    }
    Ok(port)
}

fn valid_state(row: &JsValue) -> Option<(String, String)> {
    match (row.prop("Service"), row.prop("State")) {
        (Some(JsValue::Str(service)), Some(JsValue::Str(state)))
            if CONTAINER_STATES.contains(&state.as_str()) =>
        {
            Some((service.clone(), state.clone()))
        }
        _ => None,
    }
}

fn container_rows(text: &str, skip_blank: bool) -> Result<Vec<JsValue>, String> {
    if text.starts_with('[') {
        return match js_json::parse(text)? {
            JsValue::Arr(rows) => Ok(rows),
            _ => unreachable!("[로 시작하는 JSON은 배열이다"),
        };
    }
    text.split('\n')
        .filter(|line| !(skip_blank && line.is_empty()))
        .map(js_json::parse)
        .collect()
}

/// `docker compose ps --format json <서비스 여럿>` 출력에서 서비스 이름 → 컨테이너 상태를 읽는다. 처음 나온 순서를 지키고 같은 이름은 나중 값이 이긴다
pub fn parse_container_states(stdout: &str) -> Result<Vec<(String, String)>, String> {
    let text = js::trim(stdout);
    let mut states: Vec<(String, String)> = Vec::new();
    if text.is_empty() {
        return Ok(states);
    }
    for row in container_rows(text, true)? {
        if let Some((service, state)) = valid_state(&row) {
            match states.iter_mut().find(|(s, _)| *s == service) {
                Some(slot) => slot.1 = state,
                None => states.push((service, state)),
            }
        }
    }
    Ok(states)
}

/// `docker compose ps --format json` 출력은 버전에 따라 줄 단위 JSON 또는 배열이다
pub fn parse_container_state(stdout: &str) -> Result<String, String> {
    let text = js::trim(stdout);
    if text.is_empty() {
        return Ok("unknown".into());
    }
    let rows = container_rows(text, false)?;
    let state = rows.first().and_then(|r| r.prop("State"));
    Ok(match state {
        Some(JsValue::Str(s)) if CONTAINER_STATES.contains(&s.as_str()) => s.clone(),
        _ => "unknown".into(),
    })
}

/// 동기화 확인 스크립트 출력: 파일마다 `<sha256|MISSING|UNREADABLE> <경로>` 한 줄. 경로에 공백이 있을 수 있으므로 첫 공백에서만 나눈다.
/// 같은 경로는 나중 값이 이기고 자리는 처음 것을 지킨다
pub fn parse_sync_output(stdout: &str) -> Vec<(String, String)> {
    let mut seen: Vec<(String, String)> = Vec::new();
    for line in stdout.split('\n') {
        let Some(space) = line.find(' ').filter(|s| *s > 0) else {
            continue;
        };
        let (hash, path) = (&line[..space], &line[space + 1..]);
        match seen.iter_mut().find(|(p, _)| p == path) {
            Some(slot) => slot.1 = hash.to_owned(),
            None => seen.push((path.to_owned(), hash.to_owned())),
        }
    }
    seen
}

/// 파일 반영을 기다리는 동안 파일마다 컨테이너 쪽에서 본 값을 모아 두었다가, 시간 초과 때 "늦는 것"과 "기다려도 안 되는 것"을 갈라 말한다
#[derive(Default)]
pub struct SyncObservations {
    /// 파일 → 기다리는 동안 본 값들(처음 본 순서)
    seen: Vec<(String, Vec<String>)>,
}

impl SyncObservations {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, file: &str, value: Option<&str>) {
        let value = value.unwrap_or("UNSEEN").to_owned();
        let slot = match self.seen.iter().position(|(f, _)| f == file) {
            Some(i) => &mut self.seen[i].1,
            None => {
                self.seen.push((file.to_owned(), Vec::new()));
                &mut self.seen.last_mut().expect("방금 넣음").1
            }
        };
        if !slot.contains(&value) {
            slot.push(value);
        }
    }

    /// 시간 초과 문구. `expected_missing`은 지워져야 하는(기대값이 "MISSING"인) 파일이다
    pub fn describe_timeout(
        &self,
        pending: &[String],
        expected_missing: &[String],
        timeout_ms: f64,
    ) -> String {
        let seconds = number_to_string(js::math_round(timeout_ms / 1_000.0));
        let (mut invisible, mut stale, mut undeleted, mut changing) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for file in pending {
            let values: &[String] = self
                .seen
                .iter()
                .find(|(f, _)| f == file)
                .map_or(&[], |(_, v)| v);
            let absent = values.iter().all(|v| v == "MISSING" || v == "UNSEEN");
            if values.len() > 1 && !absent {
                changing.push(file.as_str());
            } else if expected_missing.contains(file) {
                undeleted.push(file.as_str());
            } else if absent {
                invisible.push(file.as_str());
            } else {
                stale.push(file.as_str());
            }
        }
        let mut notes: Vec<String> = Vec::new();
        if !invisible.is_empty() {
            notes.push(format!(
                "{}: {seconds}초 내내 컨테이너에서 보이지 않았습니다",
                invisible.join(", ")
            ));
        }
        if !stale.is_empty() {
            notes.push(format!(
                "{}: {seconds}초 내내 이전 내용 그대로였습니다",
                stale.join(", ")
            ));
        }
        if !undeleted.is_empty() {
            notes.push(format!(
                "{}: 지운 파일이 {seconds}초 내내 컨테이너에 남아 있었습니다",
                undeleted.join(", ")
            ));
        }
        if invisible.len() + stale.len() + undeleted.len() > 0 {
            notes.push("한 번도 바뀌지 않았으므로 기다리거나 같은 내용을 다시 써도 달라지지 않을 가능성이 큽니다. 파일 이름·경로와 서비스의 소스 마운트를 확인하세요".into());
        }
        if !changing.is_empty() {
            notes.push(format!(
                "{}: 반영되는 중이었지만 시간 안에 끝나지 않았습니다(다시 시도하면 될 수 있습니다)",
                changing.join(", ")
            ));
        }
        let tail = if notes.is_empty() {
            String::new()
        } else {
            format!(" — {}", notes.join(". "))
        };
        format!(
            "{seconds}초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: {}{tail}",
            pending.join(", ")
        )
    }
}

// 로그 줄 정규식. JS의 `\S`·`\s`·`\d`·`.`를 같은 글자 집합으로 풀어 쓴다(Rust의 것은 Unicode 기준이라 다르다)
static LOG_LINE: LazyLock<Regex> = LazyLock::new(|| {
    let (ws, dot) = (js::WS_CLASS, js::LINE_TERMINATORS);
    Regex::new(&format!(r"^([^{ws}]+)-[0-9]+[{ws}]+\|[{ws}]([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}T[^{ws}]+)[{ws}]?([^{dot}]*)$")).expect("로그 줄 정규식")
});
static STATUS_LINE: LazyLock<Regex> = LazyLock::new(|| {
    let (ws, dot) = (js::WS_CLASS, js::LINE_TERMINATORS);
    Regex::new(&format!(
        r"^([a-z0-9][a-z0-9_.-]*)-[0-9]+[{ws}]+([^|{ws}][^{dot}]*)$"
    ))
    .expect("상태 줄 정규식")
});
static NANOS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\.[0-9]{3})[0-9]+").expect("나노초 정규식"));

/// `docker compose logs --timestamps` 한 줄: `api-1  | 2026-09-10T11:48:35.123456789Z 메시지`.
/// 내용이 없는 줄은 `None`. `at`은 시각 문자열(밀리초까지)이거나, 상태 줄처럼 시각이 없으면 `null`(지금)
pub fn parse_log_line(raw: &str) -> Option<JsValue> {
    // --no-color를 줘도 상태 줄 앞에는 줄 지우기(ESC [K) 같은 제어 코드가 붙는다
    let line = strip_ansi(raw);
    if js::trim(&line).is_empty() {
        return None;
    }
    if let Some(caps) = LOG_LINE.captures(&line) {
        // 나노초 정밀도는 Date가 다루지 못하므로 밀리초까지만 남긴다
        let at = NANOS.replace(&caps[2], "$1").into_owned();
        return Some(object(vec![
            ("service", Some(JsValue::str(&caps[1]))),
            ("text", Some(JsValue::str(&caps[3]))),
            ("at", Some(JsValue::Str(at))),
        ]));
    }
    if let Some(caps) = STATUS_LINE.captures(&line) {
        return Some(object(vec![
            ("service", Some(JsValue::str(&caps[1]))),
            ("text", Some(JsValue::str(&caps[2]))),
            ("at", Some(JsValue::Null)),
        ]));
    }
    Some(object(vec![
        ("service", Some(JsValue::str("unknown"))),
        ("text", Some(JsValue::Str(line))),
        ("at", Some(JsValue::Null)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 제어_코드를_지운다() {
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m \u{1b}[2K\u{1b}]8;;http://x\u{7}link\u{1b}]8;;\u{1b}\\ \u{9b}1mq\u{1b}7z"), "red link qz");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn 거부_줄만_읽고_날짜는_문자열로_돌려준다() {
        let line = r#"{"edge":"egress","decision":"deny","host":"x.com","port":443,"method":"GET","reason":"no","at":"2026-01-01T00:00:00Z"}"#;
        let v = parse_egress_denial(line).unwrap();
        assert_eq!(v.prop("port"), Some(&JsValue::Num(443.0)));
        assert_eq!(v.prop("at"), Some(&JsValue::str("2026-01-01T00:00:00Z")));
        assert!(
            parse_egress_denial(r#"{"edge":"egress","decision":"allow","host":"x","at":"y"}"#)
                .is_none()
        );
        assert!(parse_egress_denial(r#"{"edge":"egress","decision":"deny","host":"x"}"#).is_none());
        assert!(
            parse_egress_denial(r#"{"edge":"egress","decision":"deny","host":"x","at":"y""#)
                .is_none()
        );
        assert!(
            parse_egress_denial(r#"{"edge": "egress","decision":"deny","host":"x","at":"y"}"#)
                .is_none()
        );
        let no_reason = parse_egress_denial(
            r#"{"edge":"egress","decision":"deny","host":"x","at":"y","reason":5}"#,
        )
        .unwrap();
        assert_eq!(no_reason.prop("reason"), Some(&JsValue::str("")));
    }

    #[test]
    fn 감사_줄_발췌는_뒤에서_max개다() {
        let lines: Vec<String> = (0..8)
            .map(|i| format!(r#"{{"edge":"egress","decision":"deny","host":"h{i}","reason":"r"}}"#))
            .collect();
        assert_eq!(egress_audit_excerpt(&lines, 5.0).len(), 5);
        assert_eq!(egress_audit_excerpt(&lines, 5.0)[0], "h3: r");
        // slice(-0)은 slice(0)이라 전부다
        assert_eq!(egress_audit_excerpt(&lines, 0.0).len(), 8);
        assert_eq!(egress_audit_excerpt(&lines, f64::NAN).len(), 8);
        assert_eq!(egress_audit_excerpt(&lines, -2.0).len(), 6);
        let errs = vec![
            r#"{"edge":"egress","decision":"error","host":"h"}"#.to_owned(),
            r#"{"edge":"egress","decision":"allow","host":"h"}"#.to_owned(),
        ];
        assert_eq!(egress_audit_excerpt(&errs, 5.0), vec!["h: error"]);
    }

    #[test]
    fn 런타임_이름은_utf16_순서로_정렬한다() {
        assert_eq!(
            parse_runtimes(r#"{"runsc":{},"runc":{},"～":{},"😀":{}}"#),
            vec!["runc", "runsc", "😀", "\u{ff5e}"]
        );
        assert_eq!(parse_runtimes("[1,2]"), vec!["0", "1"]);
        assert!(parse_runtimes("null").is_empty());
        assert!(parse_runtimes("{").is_empty());
        assert!(parse_runtimes("").is_empty());
        assert!(parse_runtimes("5").is_empty());
    }

    #[test]
    fn 호스트_포트는_마지막_줄_끝의_숫자다() {
        assert_eq!(
            parse_host_port("0.0.0.0:3000\n[::]:3001\n").unwrap(),
            3001.0
        );
        assert!(parse_host_port("nothing").is_err());
        assert!(parse_host_port("0.0.0.0:0").is_err());
        assert!(parse_host_port("0.0.0.0:000").is_err());
        assert_eq!(parse_host_port("x:007").unwrap(), 7.0);
        assert_eq!(parse_host_port("x:80\r\nx:81").unwrap(), 81.0);
        assert_eq!(
            parse_host_port("a\u{0}b").unwrap_err(),
            "공개된 호스트 포트를 찾을 수 없습니다: \"a\\u0000b\""
        );
    }

    #[test]
    fn compose_ps는_배열도_줄_단위도_읽는다() {
        let lines = "{\"Service\":\"a\",\"State\":\"running\"}\n\n{\"Service\":\"b\",\"State\":\"weird\"}\n{\"Service\":\"a\",\"State\":\"exited\"}\r\nnull";
        assert_eq!(
            parse_container_states(lines).unwrap(),
            vec![("a".to_owned(), "exited".to_owned())]
        );
        assert_eq!(
            parse_container_states("[{\"Service\":\"a\",\"State\":\"dead\"}, 5]")
                .unwrap()
                .len(),
            1
        );
        assert!(parse_container_states("{bad").is_err());
        assert!(parse_container_states("").unwrap().is_empty());
        // 단일 상태는 가운데 빈 줄도 파싱을 시도해 던진다
        assert!(parse_container_state("{\"State\":\"running\"}\n\n{\"State\":\"x\"}").is_err());
        assert_eq!(
            parse_container_state("{\"State\":\"running\"}\n{\"State\":\"x\"}").unwrap(),
            "running"
        );
        assert_eq!(parse_container_state("[]").unwrap(), "unknown");
        assert_eq!(parse_container_state("").unwrap(), "unknown");
    }

    #[test]
    fn 동기화_출력은_첫_공백에서만_나눈다() {
        let out = "abc dir/a b.txt\nMISSING x\n bad\nnospace\nabc dir/a b.txt2\nUNREADABLE x";
        assert_eq!(
            parse_sync_output(out),
            vec![
                ("dir/a b.txt".to_owned(), "abc".to_owned()),
                ("x".to_owned(), "UNREADABLE".to_owned()),
                ("dir/a b.txt2".to_owned(), "abc".to_owned())
            ]
        );
    }

    #[test]
    fn 시간_초과_문구는_늦는_것과_안_되는_것을_가른다() {
        let mut obs = SyncObservations::new();
        obs.record("a", Some("MISSING"));
        obs.record("a", None);
        obs.record("b", Some("h1"));
        obs.record("c", Some("h1"));
        obs.record("c", Some("h2"));
        obs.record("d", Some("h9"));
        let pending: Vec<String> = ["a", "b", "c", "d", "e"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let text = obs.describe_timeout(&pending, &["d".to_owned()], 60_000.0);
        assert!(
            text.starts_with(
                "60초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a, b, c, d, e — "
            ),
            "{text}"
        );
        assert!(text.contains("a, e: 60초 내내 컨테이너에서 보이지 않았습니다"));
        assert!(text.contains("b: 60초 내내 이전 내용 그대로였습니다"));
        assert!(text.contains("d: 지운 파일이 60초 내내"));
        assert!(text.contains("c: 반영되는 중이었지만"));
    }

    #[test]
    fn 로그_줄은_세_갈래로_읽는다() {
        let l = parse_log_line("api-1  | 2026-09-10T11:48:35.123456789Z 메시지 하나").unwrap();
        assert_eq!(l.prop("service"), Some(&JsValue::str("api")));
        assert_eq!(l.prop("text"), Some(&JsValue::str("메시지 하나")));
        assert_eq!(
            l.prop("at"),
            Some(&JsValue::str("2026-09-10T11:48:35.123Z"))
        );
        let s = parse_log_line("\u{1b}[Kweb-1 exited with code 143").unwrap();
        assert_eq!(s.prop("service"), Some(&JsValue::str("web")));
        assert_eq!(s.prop("text"), Some(&JsValue::str("exited with code 143")));
        assert_eq!(s.prop("at"), Some(&JsValue::Null));
        let u = parse_log_line("뭔가 이상한 줄").unwrap();
        assert_eq!(u.prop("service"), Some(&JsValue::str("unknown")));
        assert!(parse_log_line("  \u{feff} ").is_none());
        // 공백이 없는 컨테이너 이름만 \S+로 잡히고, 시각 뒤 공백은 하나만 먹는다
        let two = parse_log_line("a-b-2 | 2026-01-01T00:00:00Z  x").unwrap();
        assert_eq!(two.prop("service"), Some(&JsValue::str("a-b")));
        assert_eq!(two.prop("text"), Some(&JsValue::str(" x")));
    }
}
