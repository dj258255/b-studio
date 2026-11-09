//! 게이트의 "확인 선언이 바뀌었는가" 판정(ADR-191 3단계 3e). `packages/agent/src/declared-checks.ts`에서 옮겼다.
//!
//! 게이트는 에이전트의 완료 선언을 믿지 않으므로, 실행 도중 확인 선언을 지우거나 느슨하게 고쳐 비켜 가는 것을 여기서 잡는다.
//! 선언 하나하나를 `JSON.stringify` 글자로 견주므로 JS와 같은 글자(키 순서, 수 표기)를 내야 한다(`js_json::stringify`).
//!
//! 의도한 차이(모두 던지는 쪽): 배열이어야 할 자리(`tests`·`protectedPaths` 등)나 객체여야 할 자리(`autoPageChecks`)에 다른 종류의 값이
//! 있으면 던진다(JS는 문자열을 글자 단위로 펼치거나 문자열의 `includes`로 읽는다). 이름에 짝 없는 서로게이트가 있으면 던진다.

use crate::js;
use crate::js_json::{self, JsObject, JsValue};
use crate::review_input::{nullish_array, opt_prop, prop, template};

/// 실행 중에 바뀐 값을 사용자가 허용했을 때만 받아들이는 확인 선언(ADR-164)
const DECLARED_FIELDS: [&str; 6] = ["required", "tests", "pageChecks", "concurrencyChecks", "loadChecks", "autoPageChecks"];

/// 약해졌는지 보는 실행 정책 목록과 사람이 읽는 이름
const POLICY_LISTS: [(&str, &str); 5] = [
    ("protectedPaths", "보호 경로"),
    ("evaluationAssets", "평가 자산"),
    ("deniedCommands", "금지 명령"),
    ("requireApprovalFor", "승인 대상 도구"),
    ("releaseRequires", "배포 조건 단계"),
];

#[derive(Debug, Default, PartialEq)]
pub struct DeclaredCheckChange {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
}

impl DeclaredCheckChange {
    pub fn to_value(&self) -> JsValue {
        let list = |v: &[String]| JsValue::Arr(v.iter().map(|s| JsValue::str(s.as_str())).collect());
        js_json::object(vec![("added", Some(list(&self.added))), ("removed", Some(list(&self.removed))), ("changed", Some(list(&self.changed)))])
    }
}

/// 선언 이름 → `JSON.stringify` 글자. 넣은 순서를 지킨다(`Map`)
struct Entries {
    keys: Vec<String>,
    values: Vec<String>,
}

impl Entries {
    fn has(&self, key: &str) -> bool {
        self.keys.iter().any(|k| k == key)
    }
    fn get(&self, key: &str) -> Option<&str> {
        self.keys.iter().position(|k| k == key).map(|i| self.values[i].as_str())
    }
    /// 같은 이름이 있으면 둘째부터 ` #번호`를 붙여 구별한다
    fn put(&mut self, label: &str, value: &JsValue) {
        let mut key = label.to_owned();
        let mut count = 2;
        while self.has(&key) {
            key = format!("{label} #{count}");
            count += 1;
        }
        self.keys.push(key);
        self.values.push(js_json::stringify(value));
    }
}

fn entries(workflow: Option<&JsValue>) -> Result<Entries, String> {
    let mut found = Entries { keys: Vec::new(), values: Vec::new() };
    // `for (const x of workflow?.list ?? [])`에서 x가 null이면 `x.name`이 던진다
    let each = |list: &str| -> Result<&[JsValue], String> { nullish_array(opt_prop(workflow, list), list) };
    for test in each("tests")? {
        let label = format!("테스트 {}", template(prop(Some(test), "name")?));
        found.put(&label, test);
    }
    for page in each("pageChecks")? {
        let label = format!("화면 {} {}", template(prop(Some(page), "service")?), template(prop(Some(page), "path")?));
        found.put(&label, page);
    }
    for check in each("concurrencyChecks")? {
        let label = format!("동시 요청 {}", template(prop(Some(check), "name")?));
        found.put(&label, check);
    }
    for check in each("loadChecks")? {
        let label = format!("부하 {}", template(prop(Some(check), "name")?));
        found.put(&label, check);
    }
    // sample 값(sampleParams·sampleIdFrom)은 허용 없이도 실행 중에 받아들이는 값이라(ADR-159) 선언의 변경으로 세지 않는다
    if let Some(auto) = opt_prop(workflow, "autoPageChecks").filter(|v| v.truthy()) {
        let JsValue::Obj(object) = auto else {
            return Err("autoPageChecks가 객체가 아닙니다".into());
        };
        let mut rest = JsObject::new();
        for (key, value) in object.entries_js_order() {
            if key != "sampleParams" && key != "sampleIdFrom" {
                rest.set(key, value.clone());
            }
        }
        found.put("바뀐 페이지 자동 확인", &JsValue::Obj(rest));
    }
    if let Some(required) = opt_prop(workflow, "required").filter(|v| v.truthy()) {
        found.put("필수 단계", required);
    }
    Ok(found)
}

/// 실행을 시작할 때의 선언과 지금 파일의 선언을 견준다. 실행 정책의 차이는 보지 않는다
pub fn diff_declared_checks(started: Option<&JsValue>, latest: Option<&JsValue>) -> Result<DeclaredCheckChange, String> {
    let before = entries(started)?;
    let after = entries(latest)?;
    let mut change = DeclaredCheckChange::default();
    for (i, key) in after.keys.iter().enumerate() {
        match before.get(key) {
            None => change.added.push(key.clone()),
            Some(old) if old != after.values[i] => change.changed.push(key.clone()),
            Some(_) => {}
        }
    }
    for key in &before.keys {
        if !after.has(key) {
            change.removed.push(key.clone());
        }
    }
    Ok(change)
}

pub fn has_declared_check_change(change: &DeclaredCheckChange) -> bool {
    change.added.len() + change.removed.len() + change.changed.len() > 0
}

/// `list.includes(item)`: SameValueZero. 객체·배열은 같은 참조일 때만 같은데 여기서는 복사본끼리라 늘 다르다(거부 쪽)
fn includes(list: &[JsValue], item: &JsValue) -> bool {
    list.iter().any(|v| match (v, item) {
        (JsValue::Num(a), JsValue::Num(b)) => js::same_value_zero(*a, *b),
        _ => v.strict_equals(item),
    })
}

/// 실행을 시작할 때보다 지금 선언이 약해진 항목을 사람이 읽는 목록으로 돌려준다(#767)
pub fn weakened_declarations(started: Option<&JsValue>, latest: Option<&JsValue>) -> Result<Vec<String>, String> {
    let mut weakened = Vec::new();
    let change = diff_declared_checks(started, latest)?;
    weakened.extend(change.removed.iter().map(|n| format!("삭제: {n}")));
    weakened.extend(change.changed.iter().map(|n| format!("변경: {n}")));
    for (field, label) in POLICY_LISTS {
        let after = nullish_array(opt_prop(latest, field), field)?;
        for item in nullish_array(opt_prop(started, field), field)? {
            if !includes(after, item) {
                weakened.push(format!("삭제: {label} {}", item.to_js_string()));
            }
        }
    }
    // 시작할 때 목록이 없었으면(모든 도구 허용) 지금 목록을 더 봐도 약해진 것이 아니다
    if let Some(started_tools) = opt_prop(started, "allowedTools").filter(|v| v.truthy()) {
        let JsValue::Arr(started_tools) = started_tools else {
            return Err("allowedTools가 배열이 아닙니다".into());
        };
        match opt_prop(latest, "allowedTools").filter(|v| v.truthy()) {
            None => weakened.push("삭제: 허용 도구(모든 도구 허용)".into()),
            Some(JsValue::Arr(latest_tools)) => {
                for tool in latest_tools {
                    if !includes(started_tools, tool) {
                        weakened.push(format!("추가: 허용 도구 {}", tool.to_js_string()));
                    }
                }
            }
            Some(_) => return Err("allowedTools가 배열이 아닙니다".into()),
        }
    }
    if let Some(before) = opt_prop(started, "maxChangedFiles") {
        match opt_prop(latest, "maxChangedFiles") {
            None => weakened.push("삭제: 변경 파일 수 상한".into()),
            // latest.maxChangedFiles > started.maxChangedFiles
            Some(now) if js_json::js_less(before, now) => weakened.push(format!("변경: 변경 파일 수 상한 {} → {}", before.to_js_string(), now.to_js_string())),
            Some(_) => {}
        }
    }
    Ok(weakened)
}

/// 예: "추가: 부하 orders-p95 · 삭제: 테스트 unit · 변경: 화면 web /cart"
pub fn describe_declared_check_change(change: &DeclaredCheckChange) -> String {
    let mut parts = Vec::new();
    for (label, names) in [("추가", &change.added), ("삭제", &change.removed), ("변경", &change.changed)] {
        if !names.is_empty() {
            parts.push(format!("{label}: {}", names.join(", ")));
        }
    }
    parts.join(" · ")
}

/// 실행 정책은 시작할 때의 것을 그대로 두고, 확인 선언만 지금 파일의 것으로 바꾼 workflow. 남은 것이 없으면 `None`
pub fn with_declared_checks(started: Option<&JsValue>, latest: Option<&JsValue>) -> Result<Option<JsValue>, String> {
    // `{ ...started }`: 자기 속성을 JS 순서로 복사한다. 문자열·배열을 펼치면 글자·원소가 속성이 되므로 받지 않는다
    let mut merged: Vec<(String, JsValue)> = match started {
        None | Some(JsValue::Null | JsValue::Num(_) | JsValue::Bool(_)) => Vec::new(),
        Some(JsValue::Obj(o)) => o.entries_js_order().into_iter().map(|(k, v)| (k.to_owned(), v.clone())).collect(),
        Some(_) => return Err("workflow가 객체가 아닙니다".into()),
    };
    for field in DECLARED_FIELDS {
        match opt_prop(latest, field) {
            None => merged.retain(|(k, _)| k != field),
            Some(value) => match merged.iter_mut().find(|(k, _)| k == field) {
                Some(slot) => slot.1 = value.clone(),
                None => merged.push((field.to_owned(), value.clone())),
            },
        }
    }
    if merged.is_empty() {
        return Ok(None);
    }
    let mut object = JsObject::new();
    for (k, v) in merged {
        object.set(&k, v);
    }
    Ok(Some(JsValue::Obj(object)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(json: &str) -> JsValue {
        js_json::parse(json).unwrap()
    }

    #[test]
    fn 더한_것_지운_것_바뀐_것을_선언의_이름으로_알린다() {
        let started = v(r#"{"tests":[{"name":"unit","command":["a"]}],"pageChecks":[{"service":"web","path":"/cart"}]}"#);
        let latest = v(r#"{"tests":[{"name":"unit","command":["b"]}],"loadChecks":[{"name":"x"}],"required":["run"]}"#);
        let change = diff_declared_checks(Some(&started), Some(&latest)).unwrap();
        assert_eq!(change.added, ["부하 x", "필수 단계"]);
        assert_eq!(change.removed, ["화면 web /cart"]);
        assert_eq!(change.changed, ["테스트 unit"]);
        assert_eq!(describe_declared_check_change(&change), "추가: 부하 x, 필수 단계 · 삭제: 화면 web /cart · 변경: 테스트 unit");
    }

    #[test]
    fn 이름이_같으면_둘째부터_번호를_붙인다() {
        let s = v(r#"{"pageChecks":[{"service":"web","path":"/a"},{"service":"web","path":"/a","x":1}]}"#);
        let change = diff_declared_checks(Some(&s), Some(&v("{}"))).unwrap();
        assert_eq!(change.removed, ["화면 web /a", "화면 web /a #2"]);
    }

    #[test]
    fn 모양이_어긋나면_던진다() {
        assert!(diff_declared_checks(Some(&v(r#"{"tests":"abc"}"#)), None).is_err());
        assert!(diff_declared_checks(Some(&v(r#"{"tests":[null]}"#)), None).is_err());
        assert!(diff_declared_checks(Some(&v(r#"{"autoPageChecks":"x"}"#)), None).is_err());
    }
}
