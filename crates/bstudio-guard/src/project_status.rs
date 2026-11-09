//! "현황" 탭(ADR-098)의 순수 집계(옛 TS: `packages/agent/src/project-status.ts`). 이미 있는 데이터를 화면 모양으로 재배열할 뿐이다.
//!
//! JS와 같게 읽는 곳:
//! - 입력은 `JSON.stringify`한 값이다. 템플릿 글자(`${x}`)는 `String(x)`(`to_js_string`), `if (x)`는 JS 진릿값(`truthy`),
//!   `x !== undefined`는 키가 있는지(`null`도 "있음"), `x ?? 0`은 없음·`null`일 때만 0이다.
//! - `Record<string, number>`(상태별 개수)는 JS 객체 순서(정수 꼴 키가 먼저 오름차순)로 나간다(`js_json::stringify` 규칙).
//! - 결과 키 순서와 조건부 펼침(`...(x ? {k} : {})`)의 생략은 옛 객체 리터럴과 같다. 그대로 넘기는 값(`checkpoints`·`links`)은 읽은 값 그대로 돌려준다.
//! - 모양이 어긋난 입력(배열이어야 할 곳이 아닌 값, 객체가 아닌 요구사항 등)은 JS가 던지는 자리에서 이유를 돌려준다.
//!
//! 의도한 차이: 상태 글자가 `__proto__`·`constructor`·`toString`처럼 `Object.prototype`의 이름이면 옛 TS는 그 속성(함수·객체)에 1을 더한
//! 글자를 개수로 썼다(`byStatus[status] ?? 0`이 상속 속성을 읽는다). 여기서는 다른 상태와 똑같이 센다.

use crate::js;
use crate::js_json::{self, JsObject, JsValue};

fn prop<'a>(v: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    v.prop(key)
}

fn text(v: Option<&JsValue>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(v) => v.to_js_string(),
    }
}

fn array<'a>(v: &'a JsValue, key: &str) -> Result<&'a [JsValue], String> {
    match prop(v, key) {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{key}가 배열이 아닙니다")),
    }
}

/// `x ?? []`
fn array_or_empty<'a>(v: &'a JsValue, key: &str) -> Result<&'a [JsValue], String> {
    match prop(v, key) {
        None | Some(JsValue::Null) => Ok(&[]),
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{key}가 배열이 아닙니다")),
    }
}

fn objects<'a>(items: &'a [JsValue], what: &str) -> Result<&'a [JsValue], String> {
    if items.iter().all(|i| matches!(i, JsValue::Obj(_))) {
        Ok(items)
    } else {
        Err(format!("{what}에 객체가 아닌 항목이 있습니다"))
    }
}

/// `array.join(', ')`(null은 빈 글자)
fn join_comma_space(items: &[JsValue]) -> String {
    items.iter().map(|v| if matches!(v, JsValue::Null) { String::new() } else { v.to_js_string() }).collect::<Vec<_>>().join(", ")
}

fn build_current_work(input: &JsValue) -> Result<JsValue, String> {
    let lanes = objects(array_or_empty(input, "lanes")?, "lanes")?;
    let items: Vec<JsValue> = lanes
        .iter()
        .map(|lane| JsValue::str(format!("레인 {}({}): {}", text(prop(lane, "id")), text(prop(lane, "label")), text(prop(lane, "status")))))
        .collect();
    let has_items = !items.is_empty();
    let summary = if prop(input, "running").is_some_and(JsValue::truthy) {
        let given = match prop(input, "currentRequestSummary") {
            None | Some(JsValue::Null) => String::new(),
            Some(JsValue::Str(s)) => js::trim(s).to_owned(),
            Some(_) => return Err("currentRequestSummary가 문자열이 아닙니다".into()),
        };
        if given.is_empty() { "요청을 처리하는 중입니다".to_owned() } else { given }
    } else if has_items {
        "작업 분해 레인이 진행 중입니다".to_owned()
    } else {
        "지금 처리 중인 요청이 없습니다".to_owned()
    };
    Ok(js_json::object(vec![("summary", Some(JsValue::Str(summary))), ("items", Some(JsValue::Arr(items)))]))
}

fn build_purpose(requirements: &[JsValue]) -> JsValue {
    let items = requirements
        .iter()
        .filter(|r| matches!(prop(r, "priority"), Some(JsValue::Str(p)) if p == "must" || p == "should"))
        .map(|r| js_json::object(vec![("id", prop(r, "id").cloned()), ("title", prop(r, "title").cloned()), ("issue", prop(r, "issue").cloned())]))
        .collect();
    js_json::object(vec![("items", Some(JsValue::Arr(items)))])
}

/// 수 하나(`estimateMinutes ?? 0`). `null`이면 0
fn number_of(v: &JsValue) -> Result<f64, String> {
    match v {
        JsValue::Num(n) => Ok(*n),
        JsValue::Null => Ok(0.0),
        _ => Err("예상·실제 시간이 수가 아닙니다".into()),
    }
}

fn build_eta(estimates: &[JsValue]) -> Result<JsValue, String> {
    let with_estimate: Vec<&JsValue> = estimates.iter().filter(|e| prop(e, "estimateMinutes").is_some()).collect();
    if with_estimate.is_empty() {
        return Ok(js_json::object(vec![
            ("hasEstimate", Some(JsValue::Bool(false))),
            ("summary", Some(JsValue::str("추정 없음 — 작업마다 예상 시간을 적어 주세요"))),
        ]));
    }
    let mut total = 0.0;
    for estimate in &with_estimate {
        total += number_of(prop(estimate, "estimateMinutes").expect("있음"))?;
    }
    Ok(js_json::object(vec![
        ("hasEstimate", Some(JsValue::Bool(true))),
        ("summary", Some(JsValue::str(format!("작업 {}개에 예상 시간이 있습니다. 합계 {}분", with_estimate.len(), js::number_to_string(total))))),
    ]))
}

/// 상태별 개수. 요구사항이 없으면 빈 객체
fn tally_by_status(requirements: &[JsValue]) -> JsObject {
    let mut by_status = JsObject::new();
    for requirement in requirements {
        let key = text(prop(requirement, "status"));
        let current = match by_status.get(&key) {
            Some(JsValue::Num(n)) => *n,
            _ => 0.0,
        };
        by_status.set(&key, JsValue::Num(current + 1.0));
    }
    by_status
}

fn build_verification(requirements: &[JsValue]) -> JsValue {
    let by_status = tally_by_status(requirements);
    let summary = if requirements.is_empty() {
        "저장된 요구사항이 없어 검증 기록을 집계할 수 없습니다".to_owned()
    } else {
        let verified = match by_status.get("검증됨") {
            Some(JsValue::Num(n)) => *n,
            _ => 0.0,
        };
        format!("{}개 중 {}개 검증됨", requirements.len(), js::number_to_string(verified))
    };
    js_json::object(vec![("summary", Some(JsValue::Str(summary))), ("byStatus", Some(JsValue::Obj(by_status)))])
}

fn requirement_list(items: &[&JsValue]) -> String {
    items.iter().map(|r| format!("[{}] {}", text(prop(r, "id")), text(prop(r, "title")))).collect::<Vec<_>>().join(", ")
}

fn build_risks(input: &JsValue, requirements: &[JsValue]) -> Result<Vec<JsValue>, String> {
    let mut risks: Vec<String> = Vec::new();
    if let Some(question) = prop(input, "openQuestion").filter(|q| q.truthy()) {
        risks.push(format!("되묻는 질문이 멈춰 있습니다: {}", question.to_js_string()));
    }
    let with_status = |name: &str| -> Vec<&JsValue> { requirements.iter().filter(|r| matches!(prop(r, "status"), Some(JsValue::Str(s)) if s == name)).collect() };
    let needs_recheck = with_status("재확인 필요");
    if !needs_recheck.is_empty() {
        risks.push(format!("재확인 필요 {}개: {}", needs_recheck.len(), requirement_list(&needs_recheck)));
    }
    let failed = with_status("실패");
    if !failed.is_empty() {
        risks.push(format!("실패 {}개: {}", failed.len(), requirement_list(&failed)));
    }
    let manual_steps = array(input, "manualSteps")?;
    if !manual_steps.is_empty() {
        risks.push(format!("사람이 할 일이 {}개 남아 있습니다(에이전트가 하지 않습니다)", manual_steps.len()));
    }
    let failed_services = array(input, "failedServices")?;
    if !failed_services.is_empty() {
        risks.push(format!("서비스 실패: {}", join_comma_space(failed_services)));
    }
    let review = prop(input, "reviewState");
    let state = review.and_then(|r| prop(r, "state"));
    match state {
        Some(JsValue::Str(s)) if s == "stopped" => risks.push("PR 자동 리뷰가 멈췄습니다 — 확인이 필요합니다".to_owned()),
        Some(JsValue::Str(s)) if s == "capped" => {
            risks.push(format!("PR 자동 리뷰가 라운드 상한({})에 도달했습니다", text(review.and_then(|r| prop(r, "rounds")))));
        }
        _ => {}
    }
    Ok(risks.into_iter().map(JsValue::Str).collect())
}

fn build_estimate_vs_actual(estimates: &[JsValue]) -> Result<JsValue, String> {
    let mut out = Vec::with_capacity(estimates.len());
    for estimate in estimates {
        let est = prop(estimate, "estimateMinutes");
        let act = prop(estimate, "actualMinutes");
        let delta = match (act, est) {
            (Some(a), Some(e)) => Some(JsValue::Num(number_of(a)? - number_of(e)?)),
            _ => None,
        };
        out.push(js_json::object(vec![
            ("id", prop(estimate, "id").cloned()),
            ("label", prop(estimate, "label").cloned()),
            ("estimateMinutes", est.cloned()),
            ("actualMinutes", act.cloned()),
            ("deltaMinutes", delta),
            ("note", prop(estimate, "note").filter(|n| n.truthy()).cloned()),
        ]));
    }
    Ok(JsValue::Arr(out))
}

/// 세션·요구사항·체크포인트·레인 데이터를 "현황" 화면 모양으로 모은다(`buildProjectStatus`)
pub fn build_project_status(input: &JsValue) -> Result<JsValue, String> {
    if !matches!(input, JsValue::Obj(_)) {
        return Err("입력이 객체가 아닙니다".into());
    }
    let requirements = objects(array(input, "requirements")?, "requirements")?;
    let estimates = objects(array_or_empty(input, "estimates")?, "estimates")?;
    let current_work = build_current_work(input)?;
    let purpose = build_purpose(requirements);
    let eta = build_eta(estimates)?;
    let deliverables = js_json::object(vec![
        ("checkpoints", prop(input, "checkpoints").cloned()),
        ("pullRequestUrl", prop(input, "pullRequestUrl").filter(|u| u.truthy()).cloned()),
    ]);
    let risks = js_json::object(vec![("items", Some(JsValue::Arr(build_risks(input, requirements)?)))]);
    let verification = build_verification(requirements);
    let estimate_vs_actual = build_estimate_vs_actual(estimates)?;
    Ok(js_json::object(vec![
        ("currentWork", Some(current_work)),
        ("purpose", Some(purpose)),
        ("eta", Some(eta)),
        ("deliverables", Some(deliverables)),
        ("risks", Some(risks)),
        ("verification", Some(verification)),
        ("estimateVsActual", Some(estimate_vs_actual)),
        ("links", prop(input, "links").cloned()),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> JsValue {
        js_json::parse(text).expect("json")
    }

    fn base() -> &'static str {
        r#"{"projectName":"p","running":false,"requirements":[],"manualSteps":[],"checkpoints":[],"failedServices":[],"links":{"roadmap":"r","changelog":"c","docsIndex":"d"}}"#
    }

    #[test]
    fn empty_input_matches_old_shape() {
        let view = build_project_status(&parse(base())).unwrap();
        assert_eq!(
            js_json::stringify(&view),
            r#"{"currentWork":{"summary":"지금 처리 중인 요청이 없습니다","items":[]},"purpose":{"items":[]},"eta":{"hasEstimate":false,"summary":"추정 없음 — 작업마다 예상 시간을 적어 주세요"},"deliverables":{"checkpoints":[]},"risks":{"items":[]},"verification":{"summary":"저장된 요구사항이 없어 검증 기록을 집계할 수 없습니다","byStatus":{}},"estimateVsActual":[],"links":{"roadmap":"r","changelog":"c","docsIndex":"d"}}"#
        );
    }

    #[test]
    fn non_array_requirements_is_rejected() {
        assert!(build_project_status(&parse(r#"{"requirements":5}"#)).is_err());
    }
}
