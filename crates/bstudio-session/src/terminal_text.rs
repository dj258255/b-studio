//! 세션 조율 함수가 만드는 글(옛 TS: `apps/studio/lib/server/sessions.ts`, ADR-195 4f C1-6a/6b).
//!
//! `Session` 메모리 상태·git·파일·타이머는 TS가 쥐고, 여기는 **같은 값에 같은 글자**를 내는 순수 함수만 둔다.
//! 트레일러는 게이트 통과의 근거로 커밋과 검증 판정에 쓰이므로 바이트까지 옛 글자와 같아야 한다(`checkpoint_trailers`).
//! 글자를 만드는 데 쓰던 판정·형식화(`format_verification_report`, `format_checked_coverage`, 트레일러)는 `bstudio-guard`가 이미 한다.
//!
//! 숫자를 글자로 바꾸는 자리(검증 횟수·게이트 횟수·경과 초)는 호출자가 JS 표기로 만들어 넘긴다. 이 모듈이 받는 수는
//! 횟수처럼 정수인 값뿐이고, 그 밖의 수 표기(`1e+21`·`-0`)는 JS가 정한다.
//!
//! 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(옛 TS는 그대로 들고 있었다). 이 모듈로 넘어오는 이름·사유는
//! 파일에서 읽은 UTF-8 글자이거나 이미 napi 경계를 지난 값이라 같은 자리에서 같은 치환이 일어난다.

use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::{verify_judge, workflow};

use crate::terminal::turn_end_rest::{landed_state, HeadRead, Landed};

/// 이 컴퓨터 방식 터미널 실행의 체크포인트 본문에 남기는 한 줄(#850). 판정과는 상관없다
pub const UNGUARDED_WRITES_NOTE: &str =
    "검사 동안 다른 프로세스의 쓰기를 막지 않았습니다(이 컴퓨터 방식 터미널. 컨테이너 방식은 검사 동안 에이전트 컨테이너를 멈춥니다)";

/// `studio.yaml`(spec의 `SPEC_FILE`). 체크포인트 본문과 안내 글이 이 이름을 쓴다
pub const SPEC_FILE: &str = "studio.yaml";
/// 확인 선언 줄의 이름(`declared-checks`)
pub const DECLARED_CHECKS_CHECK: &str = "declared-checks";

/// 도구를 기다리는 사이 그 실행이 닫혔을 때(위반·취소·CLI 종료·세션 멈춤) 거절하는 말
pub const TERMINAL_RUN_CLOSED_DENY: &str = "[b-studio] 요청을 닫아 도구를 쓰지 않았습니다.";
/// 판정이 거절했지만 글을 알아보지 못할 때(막는 쪽으로 틀린다)
pub const TERMINAL_UNDECIDED_DENY: &str = "[b-studio] 요청을 받을 수 있는지 판정하지 못해 시작하지 않았습니다. 잠시 뒤 다시 시도하세요.";
/// 쓰기 직전 훅이 이 도구를 쓸 수 있는지 판정하지 못해 막는 글
pub const TERMINAL_UNDECIDED_TOOL_DENY: &str = "[b-studio] 이 도구를 쓸 수 있는지 판정하지 못해 막았습니다. 잠시 뒤 다시 시도하세요.";
/// 사용량 소식이 끊겨 한도를 볼 수 없어 막는 글(ADR-213, U2)
pub const TERMINAL_USAGE_SILENT_DENY: &str =
    "[b-studio] 터미널의 사용량(텔레메트리)이 오지 않아 턴·토큰 한도를 확인할 수 없어 파일을 바꾸거나 명령을 돌리는 도구를 막았습니다. CLI의 텔레메트리 설정을 확인하세요. 사용량이 다시 오면 풀립니다.";
/// 읽지 못한 사용량 기록이 있어 토큰 한도를 확인할 수 없어 막는 글(ADR-216)
pub const TERMINAL_USAGE_UNREADABLE_DENY: &str =
    "[b-studio] 터미널이 보낸 사용량 기록 일부를 읽지 못해 토큰 한도를 확인할 수 없어 파일을 바꾸거나 명령을 돌리는 도구를 막았습니다. 지금 하던 일을 정리하고 턴을 끝내세요.";
/// 읽기만 요청에서 에이전트에게 덧붙이는 말. 도구가 거절되는 까닭을 미리 알려 헛돌지 않게 한다
pub const TERMINAL_READ_ONLY_NOTE: &str =
    "[b-studio] 이 요청은 읽기만입니다. 파일을 바꾸거나 명령을 돌리는 도구(Write·Edit·Bash·b-studio 도구)는 거절됩니다. Read·Glob·Grep으로 읽고 답만 하세요.";

/// `reconcileTerminalGit`이 기억이 없을 때 실행을 닫는 사유(이슈 #699)
pub const GIT_MEMORY_MISSING_REASON: &str =
    "[b-studio] 작업 복사본의 Git 상태를 기억하지 못해 확인하지 못했습니다. 작업 복사본의 git 저장소를 확인한 뒤 다시 요청하세요";

/// 확인 선언 변경 허용을 가져간 실행의 CLI에 알리는 글. 모르면 "허용을 켜고 다시 요청해 달라"고 되묻는다
pub fn terminal_check_changes_note(spec_file: &str) -> String {
    format!(
        "[b-studio] 사용자가 이 요청에 '확인 선언 변경 허용'을 켰습니다. 이번 실행의 검증은 {spec_file}의 지금 확인 선언(tests·pageChecks·concurrencyChecks·loadChecks·autoPageChecks·required)으로 돕니다. 사용자가 요청한 선언만 바꾸고, 바꾼 것은 검증 결과의 declared-checks 줄에 남습니다."
    )
}

/// 읽기만 실행에서 쓰기 도구를 거절하는 말. `agent_read_only_mark`는 읽기만 요청 표시(`[읽기만]`)
pub fn terminal_read_only_deny(agent_read_only_mark: &str) -> String {
    format!(
        "[b-studio] 읽기만 요청이라 파일을 바꾸거나 명령을 돌리는 도구를 쓰지 않았습니다. 바꾸려면 이 요청이 끝난 뒤 \"{agent_read_only_mark}\" 없이 새로 요청하세요."
    )
}

/// TS가 직접 쓰는 글 묶음(JSON). `check_changes_note`만 `spec_file`을 받는다
pub fn terminal_texts(spec_file: &str) -> String {
    js_json::to_native(&js_json::object(vec![
        ("runClosedDeny", Some(JsValue::str(TERMINAL_RUN_CLOSED_DENY))),
        ("undecidedDeny", Some(JsValue::str(TERMINAL_UNDECIDED_DENY))),
        ("usageSilentDeny", Some(JsValue::str(TERMINAL_USAGE_SILENT_DENY))),
        ("usageUnreadableDeny", Some(JsValue::str(TERMINAL_USAGE_UNREADABLE_DENY))),
        ("readOnlyNote", Some(JsValue::str(TERMINAL_READ_ONLY_NOTE))),
        ("checkChangesNote", Some(JsValue::str(terminal_check_changes_note(spec_file)))),
        ("gitMissingReason", Some(JsValue::str(GIT_MEMORY_MISSING_REASON))),
    ]))
}

/// 코어가 거절한 까닭을 화면에 낼 글로 바꾼다. 글이 없으면(알아보지 못한 까닭) 막는 쪽의 일반 글이다
pub fn pretool_deny_text(kind: &str, texts_json: &str, agent_read_only_mark: &str) -> Result<String, String> {
    if kind == "read_only" {
        return Ok(terminal_read_only_deny(agent_read_only_mark));
    }
    if kind == "closed" {
        return Ok(TERMINAL_RUN_CLOSED_DENY.to_owned());
    }
    let texts = js_json::parse_native(texts_json)?;
    Ok(texts.prop(kind).and_then(JsValue::as_str).map(str::to_owned).unwrap_or_else(|| TERMINAL_UNDECIDED_TOOL_DENY.to_owned()))
}

/// 체크포인트 본문. `report_json`이 없으면 보고서 절을 빼고, `report_unserializable`이면 옛 `formatVerificationReport`가
/// 돌려주던 실패 글을 넣는다. `checks_json`은 `[{stage?, name, ok, detail?}]`
pub fn checkpoint_body(
    report_json: Option<&str>,
    report_unserializable: bool,
    allow_breaking: bool,
    checks_json: &str,
    verify_attempts: f64,
    summary: &str,
    unguarded_writes: bool,
) -> Result<String, String> {
    let mut sections: Vec<String> = Vec::new();
    if report_unserializable {
        sections.push("검증 실패\n- 검증 보고서를 글로 만들 수 없습니다".to_owned());
    } else if let Some(json) = report_json {
        sections.push(verify_judge::format_verification_report(json, allow_breaking, SPEC_FILE));
    }
    if unguarded_writes {
        sections.push(UNGUARDED_WRITES_NOTE.to_owned());
    }
    let coverage = workflow::format_checked_coverage_json(checks_json, DECLARED_CHECKS_CHECK)?;
    if !coverage.is_empty() {
        sections.push(coverage);
    }
    if verify_attempts > 0.0 {
        sections.push(format!("검증 게이트 재시도: {}회", count(verify_attempts)));
    }
    let summary = js::trim(summary);
    if !summary.is_empty() {
        let lines: Vec<&str> = summary.split('\n').take(30).collect();
        sections.push(format!("에이전트 요약:\n{}", lines.join("\n")));
    }
    Ok(sections.join("\n\n"))
}

/// 체크포인트에 남길 통과 단계. 게이트 기록이 없는 실행이면 트레일러를 남기지 않는다
pub fn checkpoint_trailers(passed_stages: Option<&[String]>, verify: Option<&str>, incomplete: Option<&str>) -> Vec<String> {
    let Some(stages) = passed_stages else { return Vec::new() };
    let mut trailers = vec![workflow::format_workflow_trailer(stages)];
    // 가볍게 확인한 체크포인트는 건너뛴 단계를 채우지 못한다. 화면이 안내를 바꾸도록 표시를 남긴다
    if verify == Some("light") {
        trailers.push(workflow::format_verify_trailer("light"));
    }
    // 턴 상한에서 게이트만 통과한 실행은 체크포인트로 남기되 하다 만 것으로 표시한다(ADR-131 덧붙임)
    if incomplete == Some("max_turns") {
        trailers.push(workflow::format_incomplete_trailer("max_turns"));
    }
    trailers
}

/// 영향 범위 기록에 싣는 변경 수의 상한과 글자 상한. 넘으면 `omitted`로 센다
const IMPACT_MAX_CHANGES: usize = 40;
const IMPACT_MAX_TEXT: usize = 160;

fn clip_chars(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > max {
        format!("{}…", chars[..max].iter().collect::<String>())
    } else {
        text.to_owned()
    }
}

/// 게이트가 본 사실(계약 차이, 사람이 허용한 확인 선언 변경)을 PR 초안이 읽을 한 줄 트레일러로 만든다.
/// 커밋 본문은 에이전트 요약·서비스 로그 같은 자유 글이 섞여 기록처럼 보이는 줄을 흉내 낼 수 있어서, PR 초안은 본문이 아니라 이 트레일러만 읽는다.
/// 값은 JSON이라 줄바꿈이 이스케이프된다(한 줄이 아니면 만들지 않는다). 기록할 것이 없으면 `None`
pub fn impact_trailer(report_json: Option<&str>, checks_json: &str) -> Result<Option<String>, String> {
    let mut contracts: Vec<JsValue> = Vec::new();
    let mut remaining = IMPACT_MAX_CHANGES;
    let mut omitted = 0usize;
    if let Some(json) = report_json {
        let report = js_json::parse_native(json)?;
        if let Some(JsValue::Arr(items)) = report.prop("contracts") {
            for item in items {
                let service = clip_chars(item.prop("service").and_then(JsValue::as_str).unwrap_or(""), IMPACT_MAX_TEXT);
                if item.prop("error").is_some_and(|error| !matches!(error, JsValue::Null)) {
                    contracts.push(js_json::object(vec![("service", Some(JsValue::str(service))), ("failed", Some(JsValue::Bool(true)))]));
                    continue;
                }
                let Some(JsValue::Arr(changes)) = item.prop("changes") else {
                    contracts.push(js_json::object(vec![("service", Some(JsValue::str(service))), ("failed", Some(JsValue::Bool(true)))]));
                    continue;
                };
                let mut kept: Vec<JsValue> = Vec::new();
                for change in changes {
                    if remaining == 0 {
                        omitted += 1;
                        continue;
                    }
                    remaining -= 1;
                    let text = |key: &str| clip_chars(change.prop(key).and_then(JsValue::as_str).unwrap_or(""), IMPACT_MAX_TEXT);
                    kept.push(js_json::object(vec![
                        ("kind", Some(JsValue::str(text("kind")))),
                        ("target", Some(JsValue::str(text("target")))),
                        ("breaking", Some(JsValue::Bool(change.prop("breaking").is_some_and(JsValue::truthy)))),
                    ]));
                }
                contracts.push(js_json::object(vec![("service", Some(JsValue::str(service))), ("changes", Some(JsValue::Arr(kept)))]));
            }
        }
    }
    let checks = js_json::parse_native(checks_json)?;
    let declared = match &checks {
        JsValue::Arr(items) => items
            .iter()
            .find(|check| {
                check.prop("stage").and_then(JsValue::as_str) == Some("review")
                    && check.prop("name").and_then(JsValue::as_str) == Some(DECLARED_CHECKS_CHECK)
                    && check.prop("ok").is_some_and(JsValue::truthy)
                    && check.prop("detail").and_then(JsValue::as_str).is_some_and(|detail| !js::trim(detail).is_empty())
            })
            .and_then(|check| check.prop("detail").and_then(JsValue::as_str))
            .map(|detail| clip_chars(js::trim(detail), 200)),
        _ => return Err("checks는 배열이어야 합니다".to_owned()),
    };
    if contracts.is_empty() && declared.is_none() {
        return Ok(None);
    }
    let mut fields: Vec<(&str, Option<JsValue>)> = vec![("v", Some(JsValue::Num(1.0)))];
    if !contracts.is_empty() {
        fields.push(("contracts", Some(JsValue::Arr(contracts))));
    }
    if omitted > 0 {
        fields.push(("omitted", Some(JsValue::Num(omitted as f64))));
    }
    if let Some(detail) = declared {
        fields.push(("declared", Some(JsValue::Str(detail))));
    }
    let json = js_json::to_native(&js_json::object(fields));
    if json.contains(['\n', '\r']) {
        return Ok(None);
    }
    Ok(Some(workflow::format_impact_trailer(&json)))
}

/// 게이트의 결과를 실행 결과의 꼴로 옮긴다. 입력(JSON)은 TS가 만든 사실이고, 출력은 `AgentResult`와 같은 키 순서의 JSON이다.
/// `report`·`usageByModel`은 없으면 키를 넣지 않는다(옛 객체의 `undefined` 속성과 같다)
pub fn terminal_result(input_json: &str) -> Result<String, String> {
    let value = js_json::parse_native(input_json).map_err(|error| format!("세션 결과 입력을 읽지 못했습니다: {error}"))?;
    let result = js_json::object(vec![
        ("status", Some(JsValue::str(required_str(&value, "status")?))),
        ("summary", Some(JsValue::str(required_str(&value, "summary")?))),
        ("changedFiles", Some(required(&value, "changedFiles")?)),
        // 옛 객체 리터럴은 `report` 키를 값이 undefined여도 두었다. 키의 자리를 지키려고 항상 쓰고(없으면 null),
        // 껍데기가 undefined로 되돌린다(JSON.stringify는 어느 쪽도 키를 쓰지 않는다)
        ("report", Some(value.prop("report").cloned().unwrap_or(JsValue::Null))),
        ("checks", Some(required(&value, "checks")?)),
        ("gateOutcome", Some(JsValue::str(required_str(&value, "gateOutcome")?))),
        ("passedStages", Some(required(&value, "passedStages")?)),
        ("verifyAttempts", Some(required(&value, "verifyAttempts")?)),
        ("turns", Some(JsValue::Num(0.0))),
        ("usage", Some(required(&value, "usage")?)),
        (
            "metrics",
            Some(js_json::object(vec![
                ("modelCalls", Some(required(&value, "modelCalls")?)),
                ("maxContextTokens", Some(JsValue::Num(0.0))),
                ("toolMs", Some(JsValue::Num(0.0))),
                ("gateMs", Some(required(&value, "gateMs")?)),
                ("usageByModel", value.prop("usageByModel").cloned()),
            ])),
        ),
    ]);
    Ok(js_json::to_native(&result))
}

/// 훅 답의 한 줄 알림. 사유 글이 이미 `[b-studio]`로 시작하면 다시 붙이지 않는다
pub fn hook_message(summary: &str) -> String {
    let mut line = String::with_capacity(summary.len());
    let mut after_newline = false;
    for ch in summary.chars() {
        if ch == '\n' {
            if !after_newline {
                line.push(' ');
            }
            after_newline = true;
        } else {
            line.push(ch);
            after_newline = false;
        }
    }
    if line.starts_with("[b-studio]") {
        line
    } else {
        format!("[b-studio] {line}")
    }
}

/// 완료 검사 실패를 게이트 실패와 같은 모양의 feedback으로 만든다. `failures_json`은 `[{name, detail}]`
pub fn done_tests_feedback(failures_json: &str) -> Result<String, String> {
    let value = js_json::parse_native(failures_json)?;
    let JsValue::Arr(failures) = value else { return Err("완료 검사 실패 목록이 배열이 아닙니다".to_owned()) };
    let mut lines = Vec::with_capacity(failures.len());
    for failure in &failures {
        let name = failure.prop("name").and_then(JsValue::as_str).ok_or_else(|| "완료 검사 실패에 name이 없습니다".to_owned())?;
        let detail = failure.prop("detail").and_then(JsValue::as_str).ok_or_else(|| "완료 검사 실패에 detail이 없습니다".to_owned())?;
        lines.push(format!("- {name}\n{detail}"));
    }
    Ok(format!(
        "[b-studio 검증 게이트] 완료 조건이 통과하지 못했습니다. 고친 뒤 턴을 끝내세요.\n\n{}",
        lines.join("\n")
    ))
}

/// 정체 알림 문구(#B5 수정 3). 설정한 시간으로 만든다 — 60초의 배수면 N분, 아니면 N초
pub fn terminal_stall_message(stall_ms: f64) -> String {
    let seconds = (stall_ms / 1000.0).round() as i64;
    let label = if seconds % 60 == 0 { format!("{}분", seconds / 60) } else { format!("{seconds}초") };
    format!("터미널 요청이 {label} 넘게 움직임이 없습니다. CLI가 확인을 기다리는지 터미널을 보세요")
}

/// 실행 중 한도 판정이 멈추라고 했을 때 중단 신호에 싣는 글
pub fn limit_abort_message(kind: &str) -> String {
    match kind {
        "session" => "세션 토큰 한도에 도달했습니다",
        "user" => "사람별 토큰 한도에 도달했습니다",
        _ => "사람별 토큰 사용량 기록을 읽지 못했습니다",
    }
    .to_owned()
}

/// 훅 입력의 오류 종류(`error`)를 사유에 적을 글로 바꾼다. 모르는 것(없거나 문자열이 아니거나 낯선 글자·긴 값)은 "알 수 없는 오류"다
pub fn api_error_kind(raw: Option<&str>) -> String {
    let kind = raw.map(js::trim).unwrap_or("");
    let fits = (1..=40).contains(&kind.chars().count()) && kind.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'));
    if fits {
        kind.to_owned()
    } else {
        "알 수 없는 오류".to_owned()
    }
}

/// 게이트 쪽 횟수와 게이트 밖 사유의 횟수를 합쳐 상한에 닿았을 때 쓰는 글(S12). `feedback_clipped`는 호출자가 UTF-16으로 자른 글이다
pub fn attempts_exhausted_summary(gate_attempts: f64, unsettled_attempts: f64, feedback_clipped: &str, max_attempts: f64) -> String {
    let base = format!(
        "검증 재시도 상한({}번)에 닿았습니다(게이트 {}번, 게이트 밖 사유 {}번)",
        count(max_attempts),
        count(gate_attempts),
        count(unsettled_attempts)
    );
    if feedback_clipped.is_empty() {
        base
    } else {
        format!("{base}: {feedback_clipped}")
    }
}

/// CLI가 끝났는데 마지막으로 돌려준 검증 결과가 있을 때 실패로 닫는 사유. `feedback_clipped`는 호출자가 UTF-16으로 자른 글이다
pub fn cli_ended_reason(feedback_clipped: &str) -> String {
    format!("검증을 통과하지 못한 채 CLI가 끝났습니다.\n\n{feedback_clipped}")
}

/// 턴 끝 검증의 시간 상한이 지났을 때 실행을 닫는 사유 글. 초는 호출자가 `Math.round`로 만든 글자다
pub fn deadline_reason(deadline_seconds: &str, hook_seconds: &str, elapsed_seconds: &str) -> String {
    format!(
        "검증이 시간 상한({deadline_seconds}초) 안에 끝나지 않아 통과시키지 않고 실패로 닫습니다. Stop 훅은 {hook_seconds}초에 CLI가 끊고 답을 버리므로 그보다 먼저 닫아, 상한을 넘겨 끝난 검사가 체크포인트를 남기지 않게 합니다(훅이 도착한 뒤 {elapsed_seconds}초)"
    )
}

/// 되돌린 변경이 보관본으로 남았는지 알리는 꼬리. 바뀐 파일이 없으면 빈 글
pub fn restore_backup_note(files_len: f64, backup_id: Option<&str>) -> String {
    if files_len <= 0.0 {
        return String::new();
    }
    let id = backup_id.map(|id| format!("(id: {id})")).unwrap_or_default();
    format!(" 바뀐 파일 {}개는 보관본으로 남겼습니다{id}.", count(files_len))
}

/// 기억한 체크포인트로 되돌리지 못했다(요청 사이 Git 검사)
pub fn git_realign_unrestorable_message(which: &str, error_text: &str) -> String {
    format!("작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라({which}) 되돌리려 했지만 되돌리지 못했습니다: {error_text}")
}

/// 되돌렸다는 알림(요청 사이 Git 검사)
pub fn git_realign_notice(which: &str, files_len: f64, backup_id: Option<&str>) -> String {
    format!(
        "[b-studio] 요청 사이에 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라져({which}) 마지막 체크포인트로 되돌렸습니다.{}",
        restore_backup_note(files_len, backup_id)
    )
}

/// 턴 끝 Git 검사에서 되돌리지 못해 실행을 실패로 닫는 사유
pub fn git_realign_failure_reason(which: &str, error_text: &str) -> String {
    format!(
        "[b-studio] 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라({which}) 마지막 체크포인트로 되돌리려 했지만 되돌리지 못했습니다: {error_text}"
    )
}

/// 턴 끝 Git 검사에서 되돌려 실행을 실패로 닫는 사유
pub fn git_realign_restored_reason(which: &str, files_len: f64, backup_id: Option<&str>) -> String {
    format!(
        "[b-studio] 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라({which}) 마지막 체크포인트로 되돌렸습니다.{}",
        restore_backup_note(files_len, backup_id)
    )
}

/// 저장이 남긴 체크포인트를 받아들일지. `listed`가 거짓이면 Git 목록을 읽지 못한 것이고, `latest`는 목록의 첫 체크포인트다.
/// 출력 JSON: `{"state":"yes"|"no"|"unknown","adopt":bool}`. `adopt`는 세션 목록을 이 체크포인트로 맞추고 알릴지다
pub fn landed_plan(committed: Option<&str>, listed: bool, latest: Option<&str>) -> String {
    let Some(committed) = committed else {
        return js_json::to_native(&js_json::object(vec![("state", Some(JsValue::str("no"))), ("adopt", Some(JsValue::Bool(false)))]));
    };
    let head = if !listed {
        HeadRead::Failed
    } else {
        match latest {
            Some(sha) => HeadRead::Sha(sha),
            None => HeadRead::Empty,
        }
    };
    let state = landed_state(Some(committed), head);
    let name = match state {
        Landed::Yes => "yes",
        Landed::No => "no",
        Landed::Unknown => "unknown",
    };
    let adopt = state == Landed::Yes && latest.is_some();
    js_json::to_native(&js_json::object(vec![("state", Some(JsValue::str(name))), ("adopt", Some(JsValue::Bool(adopt)))]))
}

/// 횟수처럼 정수인 수를 JS 표기로. 정수가 아닌 값은 Rust 표기로 떨어진다(이 자리의 값은 항상 횟수다)
fn count(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        format!("{}", value as i64)
    } else if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 {
            "Infinity".to_owned()
        } else {
            "-Infinity".to_owned()
        }
    } else {
        format!("{value}")
    }
}

fn required(value: &JsValue, key: &str) -> Result<JsValue, String> {
    value.prop(key).cloned().ok_or_else(|| format!("세션 결과 입력에 {key}가 없습니다"))
}

fn required_str(value: &JsValue, key: &str) -> Result<String, String> {
    match value.prop(key) {
        Some(JsValue::Str(text)) => Ok(text.clone()),
        _ => Err(format!("세션 결과 입력의 {key}가 글자가 아닙니다")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn native(json: &str) -> String {
        js_json::to_native(&js_json::parse_native(json).expect("입력"))
    }

    #[test]
    fn 체크포인트_본문은_절_사이를_빈_줄로_잇는다() {
        let got = checkpoint_body(None, false, false, "[]", 0.0, "  ", false).unwrap();
        assert_eq!(got, "");
        let got = checkpoint_body(None, false, false, "[]", 2.0, "요약\n둘째\n", true).unwrap();
        assert_eq!(got, format!("{UNGUARDED_WRITES_NOTE}\n\n검증 게이트 재시도: 2회\n\n에이전트 요약:\n요약\n둘째"));
        assert_eq!(checkpoint_body(None, true, false, "[]", 0.0, "", false).unwrap(), "검증 실패\n- 검증 보고서를 글로 만들 수 없습니다");
    }

    #[test]
    fn 체크포인트_본문의_요약은_앞_30줄만_남긴다() {
        let summary = (0..31).map(|i| format!("줄{i}")).collect::<Vec<_>>().join("\n");
        let got = checkpoint_body(None, false, false, "[]", 0.0, &summary, false).unwrap();
        let lines: Vec<&str> = got.split('\n').collect();
        assert_eq!(lines.len(), 31);
        assert_eq!(lines[0], "에이전트 요약:");
        assert_eq!(lines[1], "줄0");
        assert_eq!(lines[30], "줄29");
    }

    #[test]
    fn 트레일러는_바이트까지_같다() {
        assert_eq!(checkpoint_trailers(None, None, None), Vec::<String>::new());
        assert_eq!(checkpoint_trailers(Some(&[]), None, None), list(&["Workflow-Passed: none"]));
        let stages = list(&["implement", "run"]);
        assert_eq!(checkpoint_trailers(Some(&stages), None, None), list(&["Workflow-Passed: implement, run"]));
        assert_eq!(
            checkpoint_trailers(Some(&stages), Some("light"), Some("max_turns")),
            list(&["Workflow-Passed: implement, run", "Workflow-Verify: light", "Workflow-Incomplete: max_turns"])
        );
        // 알아보는 값이 아니면 덧붙이지 않는다(옛 코드의 === 비교)
        assert_eq!(checkpoint_trailers(Some(&stages), Some("docs"), Some("other")), list(&["Workflow-Passed: implement, run"]));
    }

    #[test]
    fn 세션_결과는_옛_키_순서로_만든다() {
        let input = native(
            r#"{"status":"done","summary":"끝","changedFiles":["a"],"checks":[],"gateOutcome":"pass","passedStages":["run"],"verifyAttempts":0,"usage":{"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4},"modelCalls":0,"gateMs":12}"#,
        );
        let got = terminal_result(&input).unwrap();
        assert_eq!(
            got,
            r#"{"status":"done","summary":"끝","changedFiles":["a"],"report":null,"checks":[],"gateOutcome":"pass","passedStages":["run"],"verifyAttempts":0,"turns":0,"usage":{"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4},"metrics":{"modelCalls":0,"maxContextTokens":0,"toolMs":0,"gateMs":12}}"#
        );
        let with_optional = native(
            r#"{"status":"failed","summary":"","changedFiles":[],"report":{"ok":true},"checks":[],"gateOutcome":"exhausted","passedStages":[],"verifyAttempts":1,"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"modelCalls":1,"usageByModel":{"m":{"inputTokens":1,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}},"gateMs":0}"#,
        );
        let got = terminal_result(&with_optional).unwrap();
        assert!(got.contains(r#""report":{"ok":true}"#));
        assert!(got.contains(r#""usageByModel":{"m":"#));
        assert!(got.find("\"report\"").unwrap() < got.find("\"checks\"").unwrap());
    }

    #[test]
    fn 거절_글의_갈래() {
        assert_eq!(pretool_deny_text("read_only", "{}", "[읽기만]").unwrap(), terminal_read_only_deny("[읽기만]"));
        assert_eq!(pretool_deny_text("closed", "{}", "x").unwrap(), TERMINAL_RUN_CLOSED_DENY);
        assert_eq!(pretool_deny_text("budget", &native(r#"{"budget":"[b-studio] 한도"}"#), "x").unwrap(), "[b-studio] 한도");
        assert_eq!(pretool_deny_text("busy", "{}", "x").unwrap(), TERMINAL_UNDECIDED_TOOL_DENY);
        assert_eq!(pretool_deny_text("알수없음", "{}", "x").unwrap(), TERMINAL_UNDECIDED_TOOL_DENY);
    }

    #[test]
    fn 한줄_알림과_완료_검사_피드백() {
        assert_eq!(hook_message("[b-studio] 검증 통과"), "[b-studio] 검증 통과");
        assert_eq!(hook_message("검증 통과"), "[b-studio] 검증 통과");
        assert_eq!(hook_message("a\n\nb\nc"), "[b-studio] a b c");
        assert_eq!(hook_message("a\r\nb"), "[b-studio] a\r b");
        let failures = native(r#"[{"name":"t1","detail":"실패\n자세히"},{"name":"t2","detail":"x"}]"#);
        assert_eq!(
            done_tests_feedback(&failures).unwrap(),
            "[b-studio 검증 게이트] 완료 조건이 통과하지 못했습니다. 고친 뒤 턴을 끝내세요.\n\n- t1\n실패\n자세히\n- t2\nx"
        );
        assert_eq!(
            done_tests_feedback("[]").unwrap(),
            "[b-studio 검증 게이트] 완료 조건이 통과하지 못했습니다. 고친 뒤 턴을 끝내세요.\n\n"
        );
    }

    #[test]
    fn 정체_한도_오류_글() {
        assert_eq!(terminal_stall_message(120_000.0), "터미널 요청이 2분 넘게 움직임이 없습니다. CLI가 확인을 기다리는지 터미널을 보세요");
        assert_eq!(terminal_stall_message(90_000.0), "터미널 요청이 90초 넘게 움직임이 없습니다. CLI가 확인을 기다리는지 터미널을 보세요");
        assert_eq!(limit_abort_message("session"), "세션 토큰 한도에 도달했습니다");
        assert_eq!(limit_abort_message("user"), "사람별 토큰 한도에 도달했습니다");
        assert_eq!(limit_abort_message("usage_unreadable"), "사람별 토큰 사용량 기록을 읽지 못했습니다");
        assert_eq!(limit_abort_message("그 밖"), "사람별 토큰 사용량 기록을 읽지 못했습니다");
        assert_eq!(api_error_kind(Some(" rate_limit ")), "rate_limit");
        assert_eq!(api_error_kind(Some("a".repeat(40).as_str())), "a".repeat(40));
        assert_eq!(api_error_kind(Some("a".repeat(41).as_str())), "알 수 없는 오류");
        assert_eq!(api_error_kind(Some("한글")), "알 수 없는 오류");
        assert_eq!(api_error_kind(None), "알 수 없는 오류");
        assert_eq!(
            attempts_exhausted_summary(2.0, 1.0, "피드백", 3.0),
            "검증 재시도 상한(3번)에 닿았습니다(게이트 2번, 게이트 밖 사유 1번): 피드백"
        );
        assert_eq!(attempts_exhausted_summary(2.0, 1.0, "", 3.0), "검증 재시도 상한(3번)에 닿았습니다(게이트 2번, 게이트 밖 사유 1번)");
        assert_eq!(cli_ended_reason("이유"), "검증을 통과하지 못한 채 CLI가 끝났습니다.\n\n이유");
        assert_eq!(
            deadline_reason("570", "600", "3"),
            "검증이 시간 상한(570초) 안에 끝나지 않아 통과시키지 않고 실패로 닫습니다. Stop 훅은 600초에 CLI가 끊고 답을 버리므로 그보다 먼저 닫아, 상한을 넘겨 끝난 검사가 체크포인트를 남기지 않게 합니다(훅이 도착한 뒤 3초)"
        );
    }

    #[test]
    fn 되돌리기_글() {
        assert_eq!(restore_backup_note(0.0, None), "");
        assert_eq!(restore_backup_note(2.0, None), " 바뀐 파일 2개는 보관본으로 남겼습니다.");
        assert_eq!(restore_backup_note(2.0, Some("b1")), " 바뀐 파일 2개는 보관본으로 남겼습니다(id: b1).");
        assert_eq!(
            git_realign_unrestorable_message("branch_changed", "오류"),
            "작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라(branch_changed) 되돌리려 했지만 되돌리지 못했습니다: 오류"
        );
        assert_eq!(
            git_realign_notice("rewound", 1.0, None),
            "[b-studio] 요청 사이에 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라져(rewound) 마지막 체크포인트로 되돌렸습니다. 바뀐 파일 1개는 보관본으로 남겼습니다."
        );
        assert_eq!(
            git_realign_failure_reason("detached", "오류"),
            "[b-studio] 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라(detached) 마지막 체크포인트로 되돌리려 했지만 되돌리지 못했습니다: 오류"
        );
        assert_eq!(
            git_realign_restored_reason("detached", 0.0, None),
            "[b-studio] 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라(detached) 마지막 체크포인트로 되돌렸습니다."
        );
    }

    #[test]
    fn 남은_체크포인트_판정() {
        assert_eq!(landed_plan(None, true, None), r#"{"state":"no","adopt":false}"#);
        assert_eq!(landed_plan(Some("a"), true, Some("a")), r#"{"state":"yes","adopt":true}"#);
        assert_eq!(landed_plan(Some("a"), true, Some("b")), r#"{"state":"no","adopt":false}"#);
        assert_eq!(landed_plan(Some("a"), true, None), r#"{"state":"no","adopt":false}"#);
        assert_eq!(landed_plan(Some("a"), false, None), r#"{"state":"unknown","adopt":false}"#);
        // 목록을 읽지 못했는데 마지막으로 본 값이 있어도 받아들이지 않는다
        assert_eq!(landed_plan(Some("a"), false, Some("a")), r#"{"state":"unknown","adopt":false}"#);
    }

    #[test]
    fn 영향_범위_트레일러는_줄바꿈을_이스케이프한_한_줄이다() {
        let report = r#"{"contracts":[{"service":"api\n- web 계약:","changes":[{"kind":"schema-added","target":"A\n    계약 변경 없음","breaking":false}]},{"service":"x","error":"실패"}]}"#;
        let line = impact_trailer(Some(report), "[]").unwrap().unwrap();
        assert!(line.starts_with("Workflow-Impact: {"));
        assert!(!line.contains('\n') && !line.contains('\r'));
        let value = js_json::parse_native(line.strip_prefix("Workflow-Impact: ").unwrap()).unwrap();
        assert_eq!(value.prop("contracts").and_then(|c| if let JsValue::Arr(a) = c { Some(a.len()) } else { None }), Some(2));
        assert_eq!(impact_trailer(None, "[]").unwrap(), None);
        assert_eq!(impact_trailer(Some(r#"{"contracts":[]}"#), "[]").unwrap(), None);
        assert!(impact_trailer(None, "{}").is_err());
    }
}
