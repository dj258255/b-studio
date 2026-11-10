//! 탐색 QA의 판정·변환·프롬프트 글자(ADR-191 3단계 3p). 옛 `packages/agent/src/explore-qa.ts`의 `judge`·`toPageCheckSteps`·`isInspectionGoal`·
//! `buildQaSystemPrompt`·`buildQaUserPrompt`·`buildWrapUpPrompt`(`STOP_REASON_TEXT` 포함)·`normalizeRef`·`matchScore`·`formatSnapshot`(`formatElement`)·
//! `describeScrollPosition`·`diagnosticsCount`.
//!
//! 브라우저·모델 호출, 브라우저에서 돌리는 글자(`collectElementsScript`), 도구 스키마(`buildQaTools`), URL 해석(`assertSameOrigin`)은 TS에 남는다.
//! 값이 있을 수도 없을 수도 있는 필드(undefined)는 템플릿 글자처럼 `undefined`로 적고, `join`에 들어가는 자리는 빈 글자로 둔다(JS 규칙).
//!
//! JS와 같게 읽는 곳: `isInspectionGoal`의 `/…/i`는 u 없는 규칙이라 ASCII만 대소문자를 접는다(`ſ`·`K`(켈빈)는 접히지 않는다).
//! `normalizeRef`의 `[\s"'`]`의 `\s`는 JS 공백(`js::is_js_whitespace`). `matchScore`의 `toLowerCase`는 Rust `to_lowercase`와 같다
//! (끝 시그마 `ς`, `İ`→`i̇` 모두 같은 규칙. 유니코드 버전이 다른 새 글자만 어긋날 수 있다).
//!
//! 의도한 차이: 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(다른 조각과 같다).

use crate::js;
use crate::js_json::{JsObject, JsValue};

/// `STOP_REASON_TEXT[reason]`. 모르는 값은 `undefined`(JS 객체 조회가 없는 키에서 내는 값)
fn stop_reason_text(reason: &str) -> &'static str {
    match reason {
        "finish" => "qa_finish로 마침",
        "max_actions" => "행동 횟수 한도에 도달함",
        "max_time" => "시간 한도에 도달함",
        "repeated_screen" => "같은 화면에서 같은 조작이 되풀이됨",
        "no_tool_call" => "도구를 부르지 않고 글만 냄",
        _ => "undefined",
    }
}

/// 템플릿 글자 `${value}`: 없으면 `undefined`
fn show(value: Option<&JsValue>) -> String {
    value.map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
}

/// `Array.prototype.join`에 들어가는 원소: `undefined`·`null`은 빈 글자
fn join_item(value: Option<&JsValue>) -> String {
    match value {
        None | Some(JsValue::Null) => String::new(),
        Some(v) => v.to_js_string(),
    }
}

fn truthy(value: Option<&JsValue>) -> bool {
    value.is_some_and(JsValue::truthy)
}

fn is_str(value: Option<&JsValue>, expected: &str) -> bool {
    matches!(value, Some(JsValue::Str(s)) if s == expected)
}

/// 진단 신호 개수의 합. 가로 넘침은 1px을 넘어야 1건으로 센다(NaN은 세지 않는다)
pub fn diagnostics_count(console_errors: f64, page_errors: f64, failed_requests: f64, accessibility_violations: f64, horizontal_overflow_px: f64) -> f64 {
    console_errors + page_errors + failed_requests + accessibility_violations + if horizontal_overflow_px > 1.0 { 1.0 } else { 0.0 }
}

/// 요소 찾기 점수. needle은 부르는 쪽이 이미 소문자로 만든 값이다. 빈 needle은 0
pub fn match_score(name: &str, text: &str, role: &str, test_id: Option<&str>, tag: &str, needle: &str) -> f64 {
    if needle.is_empty() {
        return 0.0;
    }
    let name = name.to_lowercase();
    let text = text.to_lowercase();
    let role = role.to_lowercase();
    let test_id = test_id.unwrap_or("").to_lowercase();
    if name == needle || text == needle || test_id == needle {
        return 100.0;
    }
    if name.starts_with(needle) || text.starts_with(needle) {
        return 80.0;
    }
    if name.contains(needle) || text.contains(needle) || test_id.contains(needle) {
        return 60.0;
    }
    if role.contains(needle) || tag.to_lowercase() == needle {
        return 20.0;
    }
    0.0
}

/// `qa_scroll` 뒤의 문서 스크롤 위치 설명
pub fn describe_scroll_position(y: f64, max: f64, at_bottom: bool, at_top: bool) -> String {
    if max <= 0.0 {
        return "문서 자체는 스크롤되지 않습니다(화면 안쪽의 스크롤 영역이 따로 있을 수 있습니다).".to_owned();
    }
    let place = format!("현재 y={} / 최대 {}", js::number_to_string(y), js::number_to_string(max));
    if at_bottom {
        return format!("{place}, 맨 아래에 닿았습니다.");
    }
    format!("{place}, 맨 아래가 아닙니다{}.", if at_top { "(맨 위)" } else { "" })
}

/// `[ref, role, name || '(이름 없음)', testid=…].join('\t')`
pub fn format_element(element: &JsValue) -> String {
    let name = element.prop("name");
    let mut parts = vec![
        join_item(element.prop("ref")),
        join_item(element.prop("role")),
        if truthy(name) { join_item(name) } else { "(이름 없음)".to_owned() },
    ];
    let test_id = element.prop("testId");
    if truthy(test_id) {
        parts.push(format!("testid={}", show(test_id)));
    }
    parts.join("\t")
}

/// `{ url, title, elements: [{ ref, role, name, testId? }], truncated }`. 모양이 어긋나면 던진다
pub fn format_snapshot(result: &JsValue, max_elements: f64) -> Result<String, String> {
    let elements = match result.prop("elements") {
        Some(JsValue::Arr(items)) => items,
        _ => return Err("스냅샷의 elements는 배열이어야 합니다".to_owned()),
    };
    let header = format!("{} — {}", show(result.prop("url")), show(result.prop("title")));
    let body = if elements.is_empty() { "(인터랙티브 요소가 없습니다)".to_owned() } else { elements.iter().map(format_element).collect::<Vec<_>>().join("\n") };
    let footer = if truthy(result.prop("truncated")) {
        format!("\n(요소가 많아 처음 {}개만 보여줍니다. qa_find로 특정 요소를 찾으세요)", js::number_to_string(max_elements))
    } else {
        String::new()
    };
    Ok(format!("{header}\n{body}{footer}"))
}

/// ref 자리의 "없음" 표현(빈 글자·공백·따옴표만 있는 값)은 `None`, 따옴표·공백으로 감싸인 값은 벗겨서 돌려준다.
/// `value.replace(/^[\s"'`]+|[\s"'`]+$/g, '')`
pub fn normalize_ref(value: &str) -> Option<String> {
    let strip = |c: char| js::is_js_whitespace(c) || matches!(c, '"' | '\'' | '`');
    let ref_ = value.trim_matches(strip);
    if ref_.is_empty() {
        None
    } else {
        Some(ref_.to_owned())
    }
}

/// 점검형 목표인가. `/점검|검사|…|inspect|review|audit|layout/i`(u 없음: ASCII만 대소문자를 접는다)
pub fn is_inspection_goal(goal_text: &str) -> bool {
    const WORDS: [&str; 19] = [
        "점검", "검사", "살펴", "찾아", "문제", "잘리", "잘려", "겹치", "겹쳐", "넘치", "어색", "읽기 어려", "깨지", "이상한", "리뷰", "검토", "inspect", "review", "audit",
    ];
    let lower = goal_text.to_ascii_lowercase();
    WORDS.iter().any(|word| lower.contains(word)) || lower.contains("layout")
}

/// `goal_text`가 없으면(목표 없이 부른 경우) 점검 요령을 더하지 않는다
pub fn build_qa_system_prompt(goal_text: Option<&str>) -> String {
    let mut lines: Vec<&str> = vec![
        "당신은 웹 애플리케이션의 UI/UX를 사람처럼 눈으로 보고 손으로 조작하며 시험하는 QA 에이전트입니다.",
        "주어진 목표를 화면에서 직접 수행하세요. qa_snapshot으로 화면의 인터랙티브 요소를 관찰하고, 필요한 ref를 골라 행동하세요.",
        "화면이 어떻게 보이는지는 접근성 트리로 알 수 없습니다. 잘림·겹침·넘침·대비·여백·정렬처럼 눈으로 봐야 하는 것은 qa_screenshot으로 직접 확인하세요(이미지가 돌아옵니다).",
        "페이지를 내릴 때는 qa_scroll에 ref를 넣지 말고 direction만 주세요. 결과에 맨 아래에 닿았는지가 나옵니다.",
        "화면에서 문제를 보면 그 자리에서 qa_report_issue로 보고하세요. 본 것만 적고(추측 금지), 어느 요소가 어떻게 잘못됐는지 구체적으로 쓰세요. 문제를 찾았어도 점검을 계속할 수 있습니다.",
        "목표를 끝까지 수행했거나 더 진행할 수 없으면 qa_finish를 부르세요. 성공을 선언해도 플랫폼이 진단 신호·확인 문구·보고된 문제를 따로 확인하니 솔직하게 판단하세요. 문제가 없으면 없다고 적으면 됩니다.",
        "일부러 거절될 조작(로그인 없이 주문, 빈 값 제출 등)을 하기 전에는 누를 요소를 먼저 찾아 둔 뒤 조작 바로 앞에서 qa_expect_rejection으로 알리세요(선언과 조작 사이에 다른 도구를 부르면 선언이 사라집니다). 알리지 않은 조작에서 서버가 거절하면 실패한 요청으로 세어 문제로 판정합니다. 화면이 데이터를 읽다 받은 오류와 서버 오류(5xx)는 선언해도 실패입니다.",
        "화면을 바꾸지 않는 관찰은 필요한 만큼 해도 되지만, 같은 화면에서 같은 조작을 되풀이하지 말고 막히면 다른 요소를 시도하거나 qa_finish(success: false)로 알리세요.",
    ];
    if goal_text.is_some_and(is_inspection_goal) {
        lines.push("이 목표는 화면을 점검하는 일입니다. 다음 순서로 하세요.");
        lines.push("1) 시작 화면을 qa_screenshot으로 봅니다. 2) qa_scroll로 한 화면씩 내려가며 위치마다 qa_screenshot을 찍어 맨 아래에 닿을 때까지 확인합니다(한 화면만 보고 끝내지 마세요). 3) 각 화면에서 잘리거나 겹치거나 화면 밖으로 나간 요소, 읽기 어려운 글자(크기·대비), 정렬이 어긋나거나 한쪽으로 쏠린 배치, 큰 빈 여백을 찾습니다. 4) 눌러 볼 만한 요소(탭·열기 버튼)가 있으면 눌러 숨은 화면도 봅니다. 5) 본 문제는 모두 qa_report_issue로 보고하고 qa_finish로 마칩니다.");
    }
    lines.join("\n")
}

/// `{ goal, startPath, confirmText? }`
pub fn build_qa_user_prompt(goal: &JsValue) -> String {
    let mut lines = vec![format!("목표: {}", show(goal.prop("goal"))), format!("시작 화면: {}", show(goal.prop("startPath")))];
    let confirm = goal.prop("confirmText");
    if truthy(confirm) {
        lines.push(format!("끝났을 때 화면에 '{}' 문구가 있어야 합니다.", show(confirm)));
    }
    lines.join("\n")
}

/// 한도·반복·도구 없음으로 끝날 때 모델에게 마지막 보고를 요청하는 문장
pub fn build_wrap_up_prompt(reason: &str) -> String {
    [
        format!("점검이 곧 끝납니다({}). 더 이상 화면을 조작할 수 없습니다.", stop_reason_text(reason)),
        "지금까지 본 것으로 마지막 보고를 하세요. 아직 보고하지 않은 문제가 있으면 qa_report_issue로 하나씩 보고하고(이미 보고한 것은 다시 하지 마세요), 마지막으로 qa_finish를 부르세요.".to_owned(),
        "문제를 보지 못했다면 qa_finish의 summary에 문제를 보지 못했다고 적으세요. 목표나 점검을 끝까지 하지 못했다면 success: false로 알리세요.".to_owned(),
    ]
    .join("\n")
}

fn count_of(value: Option<&JsValue>) -> f64 {
    match value {
        Some(JsValue::Num(n)) => *n,
        _ => 0.0,
    }
}

/// 플랫폼의 최종 판정. `(status, reason)`.
/// 입력: `{ confirmText?, consoleErrors, pageErrors, failedRequests, accessibilityViolations (건수), horizontalOverflowPx,
/// review?: { findings: [{ severity, summary }], declared?: { success, summary }, stoppedBy, expectedRejections?, unmetRejections? } }`.
/// review.findings가 배열이 아니면 던진다(옛 구현도 `.filter`에서 던진다)
pub fn judge(input: &JsValue, page_text: &str) -> Result<(String, String), String> {
    let mut problems: Vec<String> = Vec::new();
    let console_errors = count_of(input.prop("consoleErrors"));
    let page_errors = count_of(input.prop("pageErrors"));
    let failed_requests = count_of(input.prop("failedRequests"));
    let a11y = count_of(input.prop("accessibilityViolations"));
    if console_errors > 0.0 {
        problems.push(format!("console.error {}건", js::number_to_string(console_errors)));
    }
    if page_errors > 0.0 {
        problems.push(format!("스크립트 예외 {}건", js::number_to_string(page_errors)));
    }
    if failed_requests > 0.0 {
        problems.push(format!("실패한 요청 {}건", js::number_to_string(failed_requests)));
    }
    if a11y > 0.0 {
        problems.push(format!("접근성 위반 {}건", js::number_to_string(a11y)));
    }
    let overflow = count_of(input.prop("horizontalOverflowPx"));
    if overflow > 1.0 {
        problems.push(format!("가로로 {}px 넘칩니다", js::number_to_string(overflow)));
    }
    let confirm = input.prop("confirmText");
    let confirm_text = if truthy(confirm) { Some(show(confirm)) } else { None };
    let confirm_missing = confirm_text.as_deref().is_some_and(|text| !page_text.contains(text));
    if confirm_missing {
        problems.push(format!("확인 문구 '{}'를 화면에서 찾지 못했습니다", confirm_text.as_deref().unwrap_or_default()));
    }

    let review = match input.prop("review") {
        Some(JsValue::Null) | None => None,
        Some(r) => Some(r),
    };
    let mut minor_count = 0usize;
    if let Some(review) = review {
        let findings = match review.prop("findings") {
            Some(JsValue::Arr(items)) => items,
            _ => return Err("review.findings는 배열이어야 합니다".to_owned()),
        };
        let serious: Vec<&JsValue> = findings.iter().filter(|f| !is_str(f.prop("severity"), "minor")).collect();
        minor_count = findings.len() - serious.len();
        if !serious.is_empty() {
            let blockers = serious.iter().filter(|f| is_str(f.prop("severity"), "blocker")).count();
            let mut counts: Vec<String> = Vec::new();
            if blockers > 0 {
                counts.push(format!("blocker {blockers}건"));
            }
            if serious.len() - blockers > 0 {
                counts.push(format!("major {}건", serious.len() - blockers));
            }
            let shown: Vec<String> = serious.iter().take(3).map(|f| format!("[{}] {}", show(f.prop("severity")), show(f.prop("summary")))).collect();
            let more = if serious.len() > shown.len() { format!(" 외 {}건", serious.len() - shown.len()) } else { String::new() };
            problems.push(format!("모델이 화면에서 본 문제 {} — {}{}", counts.join("·"), shown.join(" / "), more));
        }
        if let Some(declared) = review.prop("declared") {
            if declared.truthy() && !truthy(declared.prop("success")) {
                let summary = declared.prop("summary");
                let tail = if truthy(summary) { format!(": {}", show(summary)) } else { String::new() };
                problems.push(format!("모델이 목표를 끝내지 못했다고 보고했습니다{tail}"));
            }
        }
    }
    let mut rejection_notes: Vec<String> = Vec::new();
    if let Some(review) = review {
        let expected = review.prop("expectedRejections");
        if truthy(expected) {
            rejection_notes.push(format!("예상된 거절 {}건은 목록 참고", show(expected)));
        }
        let unmet = review.prop("unmetRejections");
        if truthy(unmet) {
            rejection_notes.push(format!("거절될 것으로 선언했지만 거절 응답이 없던 조작 {}건은 목록 참고", show(unmet)));
        }
    }
    let notes_joined = rejection_notes.join(", ");
    if !problems.is_empty() {
        let tail = if rejection_notes.is_empty() { String::new() } else { format!(" ({notes_joined})") };
        return Ok(("fail".to_owned(), format!("{}{}", problems.join(" / "), tail)));
    }

    if let Some(review) = review {
        if !truthy(review.prop("declared")) {
            let confirmed = confirm_text.is_some() && !confirm_missing;
            if !confirmed {
                let minor = if minor_count > 0 { format!(" 보고된 minor {minor_count}건은 목록에 있습니다.") } else { String::new() };
                let rejections = if rejection_notes.is_empty() { String::new() } else { format!(" ({notes_joined})") };
                let stopped = stop_reason_text(&show(review.prop("stoppedBy")));
                return Ok((
                    "inconclusive".to_owned(),
                    format!("점검을 마치지 못했습니다 — {stopped}, 모델의 마지막 보고(qa_finish)도 받지 못했습니다.{minor}{rejections}"),
                ));
            }
        }
    }
    let mut notes: Vec<String> = Vec::new();
    if minor_count > 0 {
        notes.push(format!("minor {minor_count}건은 목록 참고"));
    }
    notes.extend(rejection_notes);
    let tail = if notes.is_empty() { String::new() } else { format!("({})", notes.join(", ")) };
    Ok(("pass".to_owned(), format!("진단 신호가 없고 확인 조건을 만족합니다{tail}")))
}

fn skipped_row(action: &JsValue, reason: &str) -> JsValue {
    crate::js_json::object(vec![
        ("index", action.prop("index").cloned()),
        ("tool", action.prop("tool").cloned()),
        ("reason", Some(JsValue::str(reason))),
    ])
}

/// 탐색 행동 기록을 pageChecks steps로 바꾼다. 입력은 `[{ index, tool, ok, stableSelector?, text?, key?, forText? }]`
/// (text·key는 TS가 `String(input.x ?? '')`로 미리 글자로 바꿔 넘기고, forText는 글자일 때만 넘긴다). 결과 `{ steps, skipped }`.
/// 모양이 어긋나면(배열이 아님) 던진다
pub fn to_page_check_steps(actions: &JsValue) -> Result<JsValue, String> {
    let actions = match actions {
        JsValue::Arr(items) => items,
        _ => return Err("행동 기록은 배열이어야 합니다".to_owned()),
    };
    const UNSTABLE: &str = "안정적인 선택자(role+name·data-testid·고유 텍스트)가 없어 저장하지 않습니다";
    let mut steps: Vec<JsValue> = Vec::new();
    let mut skipped: Vec<JsValue> = Vec::new();
    for action in actions {
        if !truthy(action.prop("ok")) {
            skipped.push(skipped_row(action, "실패한 행동이라 저장하지 않습니다"));
            continue;
        }
        let selector = action.prop("stableSelector");
        match action.prop("tool") {
            Some(JsValue::Str(tool)) if tool == "qa_click" => {
                if truthy(selector) {
                    steps.push(crate::js_json::object(vec![("click", Some(JsValue::str(show(selector))))]));
                } else {
                    skipped.push(skipped_row(action, UNSTABLE));
                }
            }
            Some(JsValue::Str(tool)) if tool == "qa_fill" || tool == "qa_type" => {
                if truthy(selector) {
                    let fill = crate::js_json::object(vec![("selector", Some(JsValue::str(show(selector)))), ("text", Some(JsValue::str(join_item(action.prop("text")))))]);
                    steps.push(crate::js_json::object(vec![("fill", Some(fill))]));
                } else {
                    skipped.push(skipped_row(action, UNSTABLE));
                }
            }
            Some(JsValue::Str(tool)) if tool == "qa_press" => {
                steps.push(crate::js_json::object(vec![("press", Some(JsValue::str(join_item(action.prop("key")))))]));
            }
            Some(JsValue::Str(tool)) if tool == "qa_wait" => {
                let for_text = match action.prop("forText") {
                    Some(JsValue::Str(s)) if !s.is_empty() => Some(s.as_str()),
                    _ => None,
                };
                match for_text {
                    Some(text) => steps.push(crate::js_json::object(vec![("waitFor", Some(JsValue::str(format!("text={text}"))))])),
                    None => skipped.push(skipped_row(action, "시간만 기다린 행동은 저장하지 않습니다(화면 신호가 아니라서 재현성이 없습니다)")),
                }
            }
            _ => skipped.push(skipped_row(action, "이 행동은 click/fill/press/waitFor로 표현할 수 없어 저장하지 않습니다")),
        }
    }
    let mut out = JsObject::new();
    out.set("steps", JsValue::Arr(steps));
    out.set("skipped", JsValue::Arr(skipped));
    Ok(JsValue::Obj(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json;

    fn judged(input: &str, page: &str) -> (String, String) {
        judge(&js_json::parse(input).unwrap(), page).unwrap()
    }

    #[test]
    fn 거짓인_선언은_선언이_없는_것과_같다() {
        // TS 껍데기는 거짓인 선언을 보내지 않지만, JS의 `!review.declared`는 null·false·0·''도 "선언 없음"으로 본다
        for declared in ["null", "false", "0", "\"\""] {
            let input = format!(r#"{{"review":{{"findings":[],"stoppedBy":"max_time","declared":{declared}}}}}"#);
            let (status, reason) = judged(&input, "");
            assert_eq!(status, "inconclusive", "{declared}");
            assert!(reason.contains("시간 한도에 도달함"), "{declared}");
        }
    }

    #[test]
    fn 확인_문구가_화면에_있으면_선언이_없어도_통과한다() {
        let (status, _) = judged(r#"{"confirmText":"완료","review":{"findings":[],"stoppedBy":"finish"}}"#, "주문 완료");
        assert_eq!(status, "pass");
        let (status, _) = judged(r#"{"confirmText":"완료","review":{"findings":[],"stoppedBy":"finish"}}"#, "주문 완 료");
        assert_eq!(status, "fail");
    }

    #[test]
    fn findings가_배열이_아니면_던진다() {
        assert!(judge(&js_json::parse(r#"{"review":{"stoppedBy":"finish"}}"#).unwrap(), "").is_err());
    }

    #[test]
    fn 배열이_아닌_행동_기록은_던진다() {
        assert!(to_page_check_steps(&js_json::parse("{}").unwrap()).is_err());
        assert!(format_snapshot(&js_json::parse(r#"{"url":"u"}"#).unwrap(), 40.0).is_err());
    }

    #[test]
    fn 정규식_대소문자_접기는_ascii만이다() {
        assert!(is_inspection_goal("LAYOUT"));
        assert!(!is_inspection_goal("inſpect"));
        assert!(!is_inspection_goal("ınspect"));
    }
}
