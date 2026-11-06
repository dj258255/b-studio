//! 서비스 준비 판정(ADR-191 2단계 2b-2b, #1034).
//!
//! 확인 기록(probe)을 보고 서비스가 준비됐는지(ready)·기다릴지(waiting)·실패인지(failed) 정하고, 죽은 컨테이너 로그에서 원인
//! 줄을 고르며, 일시 오류면 한 번 더 띄워 볼지 정한다. HTTP 확인과 타이머(`waitForReady`·`probeOnce`)는 TS(`readiness.ts`)에
//! 남기고 여기는 판정만 한다.
//!
//! 정규식은 옛 TS와 같은 뜻으로 옮겼다(대소문자 무시는 `(?i)`, `\b`·`\s`는 그대로). `crashLogExcerpt`의 300자 자르기는 JS와 같게
//! UTF-16 코드 단위 기준이다(`js::truncate_utf16`).

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::js;

static TRANSIENT_BOOT_ERROR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bETXTBSY\b|\bEBUSY\b").expect("정규식"));
/// 오류를 알려 주는 줄. 스택 프레임과 평범한 INFO 줄은 빼고 원인이 적힌 줄을 고른다(옛 TS와 같은 패턴, 대소문자 무시)
static CRASH_SIGNAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)exception|error|fail|fatal|denied|forbidden|refused|not found|no such|cannot|unable|panic|traceback|killed|out of memory|\b[45]\d\d\b").expect("정규식")
});
static STACK_FRAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*(at |\.\.\. \d+ more|File ".*", line \d+)"#).expect("정규식")
});

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub ok: bool,
    #[serde(default)]
    pub status: Option<f64>,
    #[serde(default)]
    pub error: Option<String>,
    pub container_state: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessPolicy {
    pub success_threshold: f64,
    pub timeout_ms: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadinessDecision {
    Ready,
    Waiting,
    Failed { reason: String },
}

/// 확인 하나를 사람이 읽을 문구로. `error ?? "HTTP <status>"`, 그리고 컨테이너 상태. status가 없으면 JS처럼 "HTTP undefined"
fn describe_probe(probe: &Probe) -> String {
    let http = match &probe.error {
        Some(error) => error.clone(),
        None => format!(
            "HTTP {}",
            probe
                .status
                .map(js::number_to_string)
                .unwrap_or_else(|| "undefined".to_owned())
        ),
    };
    format!("{http}, 컨테이너 {}", probe.container_state)
}

/// 지금까지의 확인 기록(오래된 것부터)을 보고 준비 여부를 판단한다. 기록은 비어 있을 수 있다
pub fn decide_readiness(
    history: &[Probe],
    policy: &ReadinessPolicy,
    elapsed_ms: f64,
) -> ReadinessDecision {
    let Some(latest) = history.last() else {
        return ReadinessDecision::Waiting;
    };

    // 프로세스가 죽었으면 타임아웃까지 기다리지 않는다
    if latest.container_state == "exited" || latest.container_state == "dead" {
        return ReadinessDecision::Failed {
            reason: format!(
                "앱이 켜지다가 종료됐습니다 (컨테이너 {})",
                latest.container_state
            ),
        };
    }

    // 기동 직후 잠깐 성공했다 흔들리는 것을 거르려고 연속 성공만 센다
    let streak = history.iter().rev().take_while(|probe| probe.ok).count();
    if streak as f64 >= policy.success_threshold {
        return ReadinessDecision::Ready;
    }

    if elapsed_ms >= policy.timeout_ms {
        let seconds = js::math_round(policy.timeout_ms / 1000.0);
        return ReadinessDecision::Failed {
            reason: format!(
                "{}초 안에 준비되지 않았습니다 (마지막 확인: {})",
                js::number_to_string(seconds),
                describe_probe(latest)
            ),
        };
    }

    ReadinessDecision::Waiting
}

/// 죽은 컨테이너의 마지막 로그 줄에 알려진 일시 오류(ETXTBSY·EBUSY)가 있는지
pub fn is_transient_boot_error(lines: &[String]) -> bool {
    lines.iter().any(|line| TRANSIENT_BOOT_ERROR.is_match(line))
}

/// 이번 기동에서 한 번 더 띄워 볼지. 1번째 시도가 일시 오류로 죽었을 때만 재시도한다(무한 재시도 금지, 트러블슈팅 #90)
pub fn should_retry_transient_crash(attempt: i64, excerpt: &[String]) -> bool {
    attempt == 1 && is_transient_boot_error(excerpt)
}

/// 죽은 컨테이너의 마지막 로그에서 원인을 보여 줄 줄을 고른다(최대 `max`줄, 오래된 것부터). 오류다운 줄이 없으면 끝 몇 줄을 쓴다
pub fn crash_log_excerpt(lines: &[String], max: usize) -> Vec<String> {
    let cleaned: Vec<&str> = lines
        .iter()
        .map(|line| line.trim_end())
        .filter(|line| !line.trim().is_empty())
        .collect();
    let signals: Vec<&str> = cleaned
        .iter()
        .copied()
        .filter(|line| !STACK_FRAME.is_match(line) && CRASH_SIGNAL.is_match(line))
        .collect();
    let source = if signals.is_empty() {
        &cleaned
    } else {
        &signals
    };
    let start = source.len().saturating_sub(max);
    source[start..]
        .iter()
        .map(|line| {
            if js::utf16_len(line) > 300 {
                format!("{}…", js::truncate_utf16(line, 300))
            } else {
                (*line).to_owned()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn probe(ok: bool, state: &str, status: Option<f64>, error: Option<&str>) -> Probe {
        Probe {
            ok,
            status,
            error: error.map(Into::into),
            container_state: state.into(),
        }
    }
    const POLICY: ReadinessPolicy = ReadinessPolicy {
        success_threshold: 2.0,
        timeout_ms: 180_000.0,
    };
    fn decide(history: &[Probe], elapsed: f64) -> serde_json::Value {
        serde_json::to_value(decide_readiness(history, &POLICY, elapsed)).unwrap()
    }
    fn lines(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn 기록이_없으면_대기() {
        assert_eq!(decide(&[], 0.0), json!({ "kind": "waiting" }));
    }

    #[test]
    fn 연속_성공이_문턱에_닿으면_준비() {
        assert_eq!(
            decide(
                &[
                    probe(false, "running", None, Some("ECONNREFUSED")),
                    probe(true, "running", Some(200.0), None),
                    probe(true, "running", Some(200.0), None)
                ],
                1000.0
            ),
            json!({ "kind": "ready" })
        );
    }

    #[test]
    fn 연속이_끊기면_아직_준비_아님() {
        assert_eq!(
            decide(
                &[
                    probe(true, "running", Some(200.0), None),
                    probe(false, "running", Some(503.0), None),
                    probe(true, "running", Some(200.0), None)
                ],
                1000.0
            ),
            json!({ "kind": "waiting" })
        );
    }

    #[test]
    fn 컨테이너가_죽으면_즉시_실패() {
        assert_eq!(
            decide(&[probe(false, "exited", None, Some("x"))], 1000.0),
            json!({ "kind": "failed", "reason": "앱이 켜지다가 종료됐습니다 (컨테이너 exited)" })
        );
        assert_eq!(
            decide(&[probe(false, "dead", None, None)], 1000.0)["reason"],
            json!("앱이 켜지다가 종료됐습니다 (컨테이너 dead)")
        );
    }

    #[test]
    fn 타임아웃이면_마지막_확인을_적어_실패() {
        assert_eq!(
            decide(&[probe(false, "running", Some(503.0), None)], 180_000.0),
            json!({ "kind": "failed", "reason": "180초 안에 준비되지 않았습니다 (마지막 확인: HTTP 503, 컨테이너 running)" })
        );
        // error가 있으면 그 문구를, status가 없으면 HTTP undefined
        assert_eq!(
            decide(&[probe(false, "running", None, Some("TIMEOUT"))], 200_000.0)["reason"],
            json!("180초 안에 준비되지 않았습니다 (마지막 확인: TIMEOUT, 컨테이너 running)")
        );
        assert_eq!(
            decide(&[probe(false, "running", None, None)], 200_000.0)["reason"],
            json!("180초 안에 준비되지 않았습니다 (마지막 확인: HTTP undefined, 컨테이너 running)")
        );
    }

    #[test]
    fn 죽기_직전이_아니면_타임아웃_전까지_대기() {
        assert_eq!(
            decide(&[probe(false, "running", Some(503.0), None)], 1000.0),
            json!({ "kind": "waiting" })
        );
    }

    #[test]
    fn 일시_오류_판정과_재시도() {
        assert!(is_transient_boot_error(&lines(&[
            "Error: ETXTBSY: text file busy"
        ])));
        assert!(is_transient_boot_error(&lines(&["spawn EBUSY"])));
        assert!(!is_transient_boot_error(&lines(&["ETXTBSYX", "EBUSYNESS"]))); // \b 경계
        assert!(should_retry_transient_crash(1, &lines(&["ETXTBSY"])));
        assert!(!should_retry_transient_crash(2, &lines(&["ETXTBSY"])));
        assert!(!should_retry_transient_crash(1, &lines(&["ok"])));
    }

    #[test]
    fn 원인_줄을_고르고_스택_프레임은_뺀다() {
        let input = lines(&[
            "[info] starting",
            "  at Module._compile (node:internal)",
            "TypeError: cannot read x",
            "   ",
            "... 5 more",
        ]);
        assert_eq!(
            crash_log_excerpt(&input, 6),
            lines(&["TypeError: cannot read x"])
        );
    }

    #[test]
    fn 원인_줄이_없으면_끝_몇_줄을_쓴다() {
        let input = lines(&["line1", "line2", "line3", "line4"]);
        assert_eq!(crash_log_excerpt(&input, 2), lines(&["line3", "line4"]));
    }

    #[test]
    fn 스택_프레임은_오류_단어를_담아도_뺀다() {
        // "at ...(error.js)"는 CRASH_SIGNAL(error)에 걸리지만 STACK_FRAME이라 원인 줄에서 빠진다
        let input = lines(&["  at handler (error.js:10)", "RuntimeError: boom"]);
        assert_eq!(crash_log_excerpt(&input, 6), lines(&["RuntimeError: boom"]));
    }

    #[test]
    fn 끝_공백은_떼고_빈_줄은_센에서_뺀다() {
        let input = lines(&["keep1", "   ", "keep2   "]);
        assert_eq!(crash_log_excerpt(&input, 2), lines(&["keep1", "keep2"]));
    }

    #[test]
    fn 긴_줄은_utf16_300자로_자른다() {
        let long = "x".repeat(400);
        let out = crash_log_excerpt(&[format!("error: {long}")], 6);
        assert_eq!(js::utf16_len(&out[0]), 301); // 300자 + '…'
        assert!(out[0].ends_with('…'));
    }
}
