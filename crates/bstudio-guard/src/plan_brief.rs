//! 계획 요약·레인 계약의 프롬프트 글자와 판정(ADR-191 3단계 3m). 옛 `packages/agent/src/plan-brief.ts`의 `shouldPlanBrief`·`planWordLimit`·
//! `buildPlanBriefSystem`·`appendPlanToRequest`와 `lane-contracts.ts`의 `buildContractSystem`·`buildContractUser`.
//!
//! 모델 호출·zod 스키마·상수(단어·글자 상한, 계약 수 상한)는 TS에 남고, 상수는 인자로 받아 프롬프트에 그대로 쓴다(두 곳에서 따로 정하지 않는다).
//! `LoadedProject`·`TaskLane`은 통째로 받지 않고 읽는 필드만 JSON으로 받는다. 값이 없는 필드(undefined)는 템플릿 글자처럼 `undefined`로 적는다.
//!
//! 의도한 차이: 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(다른 조각과 같다).

use crate::js;
use crate::js_json::JsValue;
use crate::js_locale::to_locale_string;
use crate::model_router::{classify_complexity, estimate_tokens};

/// 계획 호출을 할 만큼 요청이 큰가. 빈 요청·공백뿐인 요청은 아니다
pub fn should_plan_brief(request: &str) -> bool {
    let prompt = js::trim(request);
    if prompt.is_empty() {
        return false;
    }
    classify_complexity(prompt, estimate_tokens(prompt)) != "simple"
}

/// `request.trim().split(/(?<=[.!?])\s+|\n+/).map(trim).filter(Boolean)`의 조각 수. 3개째를 찾으면 멈춘다(부르는 쪽은 2 이하만 가른다)
fn segment_count_capped(request: &str) -> usize {
    let chars: Vec<char> = js::trim(request).chars().collect();
    let mut count = 0;
    let mut start = 0;
    let mut q = 0;
    let push = |from: usize, to: usize, count: &mut usize| {
        let piece: String = chars[from..to].iter().collect();
        if !js::trim(&piece).is_empty() {
            *count += 1;
        }
    };
    while q < chars.len() {
        let after_punct = q > 0 && matches!(chars[q - 1], '.' | '!' | '?');
        let end = if after_punct && js::is_js_whitespace(chars[q]) {
            let mut e = q;
            while e < chars.len() && js::is_js_whitespace(chars[e]) {
                e += 1;
            }
            Some(e)
        } else if chars[q] == '\n' {
            let mut e = q;
            while e < chars.len() && chars[e] == '\n' {
                e += 1;
            }
            Some(e)
        } else {
            None
        };
        match end {
            Some(e) => {
                push(start, q, &mut count);
                start = e;
                q = e;
                if count > 2 {
                    return count;
                }
            }
            None => q += 1,
        }
    }
    push(start, chars.len(), &mut count);
    count
}

/// 요청 문장 수(종결 부호·줄바꿈으로 나눈 조각)가 2개 이하면 짧은 상한, 아니면 긴 상한
pub fn plan_word_limit(request: &str, short: f64, long: f64) -> f64 {
    if segment_count_capped(request) <= 2 {
        short
    } else {
        long
    }
}

/// 템플릿 글자 `${value}`: 없으면 `undefined`
fn show(value: Option<&JsValue>) -> String {
    value.map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
}

/// `project.managed.map(([name, service]) => `- ${name}: ${service.template}, 폴더 ${service.path}`).join('\n')`
fn services_text(project: &JsValue) -> Result<String, String> {
    let managed = match project.prop("managed") {
        Some(JsValue::Arr(items)) => items,
        _ => return Err("managed가 배열이 아닙니다".into()),
    };
    let mut lines = Vec::with_capacity(managed.len());
    for entry in managed {
        let (name, service) = match entry {
            JsValue::Arr(pair) if pair.len() >= 2 => (&pair[0], &pair[1]),
            _ => return Err("managed 항목이 [이름, 서비스] 쌍이 아닙니다".into()),
        };
        if !matches!(service, JsValue::Obj(_)) {
            return Err("managed 서비스가 객체가 아닙니다".into());
        }
        lines.push(format!("- {}: {}, 폴더 {}", name.to_js_string(), show(service.prop("template")), show(service.prop("path"))));
    }
    Ok(lines.join("\n"))
}

/// 계획 모델의 시스템 프롬프트. `project` = `{ name, managed: [[이름, { template, path }]] }`
pub fn build_plan_brief_system(project: &JsValue, request: &str, short: f64, long: f64) -> Result<String, String> {
    let services = services_text(project)?;
    let name = show(project.prop("name"));
    let word_limit = plan_word_limit(request, short, long);
    let line_limit = if word_limit == short { 10 } else { 25 };
    let word_limit_text = js::number_to_string(word_limit);
    let line_limit_text = line_limit.to_string();
    let mut out = String::new();
    out.push_str(r#"You are a senior engineer writing a short reference plan for project ""#);
    out.push_str(&name);
    out.push_str(r#"" that a smaller, cheaper coding agent will execute right after you.
Services:
"#);
    out.push_str(&services);
    out.push_str(r#"

Plan the MINIMAL change that satisfies the request — nothing more. Do not add files, layers (service/DTO/repository splits), tests, refactors, or verification/self-check steps the request doesn't explicitly ask for. Prefer editing existing files over creating new ones. Do not restate the request — go straight to the plan.

Write the plan in Korean, as plain text (no JSON, no code fences), at most about "#);
    out.push_str(&word_limit_text);
    out.push_str(r#" words (roughly "#);
    out.push_str(&line_limit_text);
    out.push_str(r#" lines). It is a list of decisions and pitfalls for the executor, not a step-by-step script. Cover only what applies:
1. 바꿀 파일(기존 파일 우선) — 새 파일은 요청이 명시적으로 요구할 때만
2. API·인터페이스 계약, 정확한 경로·이름, 환경 변수 같은 결정 사항(없으면 생략)
3. 놓치기 쉬운 함정
Do not write any code. Do not add a verification or testing step — the platform's gate checks the result after the turn ends (lean self-check, ADR-064), so the executor should not repeat that work. The executor will see this plan appended to the original request as reference notes, not as a message back to the user, and must not treat it as a bigger scope than the request."#);
    Ok(out)
}

/// 계획을 실행기에 넘길 요청 끝에 붙인다. 계획은 trim하고 `max_chars`(UTF-16 길이)를 넘으면 자른 표시와 함께 자른다
pub fn append_plan_to_request(request: &str, plan: &str, max_chars: f64) -> String {
    let trimmed = js::trim(plan);
    let length = js::utf16_len(trimmed) as f64;
    let body = if length > max_chars {
        // `slice(0, max)`: 소수는 버리고 음수는 뒤에서 센다
        let n = max_chars.trunc();
        let keep = if n.is_nan() {
            0.0
        } else if n < 0.0 {
            (length + n).max(0.0)
        } else {
            n
        };
        let cut = js::truncate_utf16(trimmed, if keep.is_finite() { keep as usize } else { usize::MAX });
        format!("{cut}\n…(계획이 상한 {}자를 넘어 여기서 잘랐습니다)", to_locale_string(max_chars))
    } else {
        trimmed.to_owned()
    };
    let mut out = String::new();
    out.push_str(request);
    out.push_str(r#"

---
[참고 계획(요청 범위를 넘는 일은 하지 않는다) — 다른(더 큰) 모델이 이 요청을 먼저 훑어봤습니다. 실행 중 알게 된 사실이 실제 코드와 다르면 실제 코드를 따르고, 완료 확인은 게이트가 합니다]
"#);
    out.push_str(&body);
    out.push_str(r#"
[계획 끝]
---"#);
    out
}

/// 레인 계약 시스템 프롬프트. `project`는 `build_plan_brief_system`과 같은 꼴
pub fn build_contract_system(project: &JsValue, max_contracts: f64) -> Result<String, String> {
    let services = services_text(project)?;
    let name = show(project.prop("name"));
    let max_text = js::number_to_string(max_contracts);
    let mut out = String::new();
    out.push_str(r#"You write the interface contracts between parallel coding agents for project ""#);
    out.push_str(&name);
    out.push_str(r#"".
Services:
"#);
    out.push_str(&services);
    out.push_str(r#"

The agents run at the same time in separate workspaces and cannot see each other's code. Write down ONLY the interfaces where two agents must agree: an endpoint one agent serves and another calls, the shape of that response, a field name both sides use.
Reply with ONLY a JSON object: {"contracts":[{"body":"...","refs":["..."]}]}
Rules:
- Each body is one interface, in exactly this shape: "GET /api/books/{id} → 200 JSON, 404 if missing. Fields: id(number), title(string), authors(array of {name(string)}), note(string|null)"
- Name every field exactly, with its type (string, number, boolean, array, object, null) and say whether a value is a list or a map (for example "countsByGenre(object map: genre→count)").
- Include the request (method, path, query or body fields) and the response status codes.
- Do not write anything only one agent uses: private helpers, internal state, styling, refactors.
- refs are the paths this interface belongs to (the api path, or a file both sides touch).
- If no two agents share an interface, reply {"contracts":[]}.
- At most "#);
    out.push_str(&max_text);
    out.push_str(r#" contracts. Do not invent interfaces the request does not imply."#);
    Ok(out)
}

/// 레인별 작업 요청과 쓰기 경로 요약. `lanes` = `[{ id, paths: [..], tasks: [{ id, title, request }] }]`
pub fn build_contract_user(request: &str, lanes: &JsValue) -> Result<String, String> {
    let lanes = match lanes {
        JsValue::Arr(items) => items,
        _ => return Err("레인 목록이 배열이 아닙니다".into()),
    };
    let mut lane_lines = Vec::with_capacity(lanes.len());
    for lane in lanes {
        let tasks = match lane.prop("tasks") {
            Some(JsValue::Arr(items)) => items,
            _ => return Err("레인의 tasks가 배열이 아닙니다".into()),
        };
        let paths = match lane.prop("paths") {
            Some(JsValue::Arr(items)) => items.iter().map(|p| if matches!(p, JsValue::Null) { String::new() } else { p.to_js_string() }).collect::<Vec<_>>().join(", "),
            _ => return Err("레인의 paths가 배열이 아닙니다".into()),
        };
        let task_lines: Vec<String> = tasks
            .iter()
            .map(|task| format!("  · {} ({}): {}", show(task.prop("id")), show(task.prop("title")), show(task.prop("request"))))
            .collect();
        lane_lines.push(format!("- {} · 쓰기 경로: {}\n{}", show(lane.prop("id")), paths, task_lines.join("\n")));
    }
    Ok(format!("전체 요청: {request}\n\n레인 (동시에 실행되고 서로의 코드를 보지 못합니다):\n{}", lane_lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json;

    fn parse(text: &str) -> JsValue {
        js_json::parse(text).unwrap()
    }

    #[test]
    fn 계획_여부는_복잡도가_simple이_아닐_때다() {
        assert!(!should_plan_brief(""));
        assert!(!should_plan_brief(" \n\t\u{feff}"));
        assert!(!should_plan_brief("버튼 색을 파란색으로 바꿔줘"));
        assert!(should_plan_brief("결제 서비스를 마이그레이션해줘 보안도"));
        assert!(!should_plan_brief(&"a".repeat(3196)));
        assert!(should_plan_brief(&"a".repeat(3197)));
        assert!(!should_plan_brief(&"가".repeat(1198)));
        assert!(should_plan_brief(&"가".repeat(1199)));
        assert!(!should_plan_brief(&format!("a{}b", "\n".repeat(11))));
        assert!(should_plan_brief(&format!("a{}b", "\n".repeat(12))));
    }

    #[test]
    fn 문장_수가_2이하면_짧은_상한이다() {
        assert_eq!(plan_word_limit("a. b.", 150.0, 400.0), 150.0);
        assert_eq!(plan_word_limit("a. b. c", 150.0, 400.0), 400.0);
        assert_eq!(plan_word_limit("a, b, c", 150.0, 400.0), 150.0);
        assert_eq!(plan_word_limit("a\n \nb", 150.0, 400.0), 150.0);
        assert_eq!(plan_word_limit("a\n\u{85}\nb", 150.0, 400.0), 400.0);
        assert_eq!(plan_word_limit("", 150.0, 400.0), 150.0);
    }

    #[test]
    fn 계획_글은_상한에서_자르고_표시한다() {
        let plan = "x".repeat(3001);
        let out = append_plan_to_request("요청", &plan, 3000.0);
        assert!(out.contains(&format!("{}\n…(계획이 상한 3,000자를 넘어 여기서 잘랐습니다)", "x".repeat(3000))));
        assert!(out.starts_with("요청\n\n---\n[참고 계획"));
        assert!(out.ends_with("[계획 끝]\n---"));
        assert!(!append_plan_to_request("요청", &"x".repeat(3000), 3000.0).contains("잘랐습니다"));
    }

    #[test]
    fn 값이_없는_필드는_undefined로_적는다() {
        let project = parse(r#"{"name":"p","managed":[["web",{"path":"web"}]]}"#);
        let out = build_contract_system(&project, 6.0).unwrap();
        assert!(out.contains("- web: undefined, 폴더 web"));
        assert!(out.contains("At most 6 contracts."));
        assert!(build_contract_system(&parse(r#"{"name":"p"}"#), 6.0).is_err());
    }

    #[test]
    fn 레인_요약은_경로와_작업을_줄로_적는다() {
        let lanes = parse(r#"[{"id":"api","paths":["a",null,"b"],"tasks":[{"id":"t1","title":"T","request":"R"}]}]"#);
        let out = build_contract_user("요청", &lanes).unwrap();
        assert!(out.ends_with("- api · 쓰기 경로: a, , b\n  · t1 (T): R"));
        assert!(build_contract_user("요청", &parse("[]")).unwrap().ends_with("보지 못합니다):\n"));
    }
}
