//! compose가 정규화한 설정(`docker compose config --format json`)에서 서비스 사이의 의존 관계를 읽고 시작 순서를 정한다
//! (옛 TS: `packages/sandbox/src/docker/compose-deps.ts`, ADR-195 4f A4a). docker를 부르는 `loadDependsOn`만 TS에 남는다.
//!
//! 읽는 규칙은 옛 TS와 같다: JS가 `JSON.parse`한 값을 모양 검사 없이 읽는다. 모양이 어긋난 값은 조용히 건너뛴다(던지지 않는다).
//! 의도한 차이 하나: 서비스 이름이 `__proto__`이면 옛 TS는 결과 객체에 키를 넣는 대신 그 객체의 프로토타입을 바꿔 버렸다
//! (`result['__proto__'] = ...`). 이 모듈은 그 서비스의 의존을 키로 두지 않고 버린다. 두 쪽 모두 `Object.entries`에는 나오지 않는다.

use crate::js_json::{JsObject, JsValue};
use std::collections::HashSet;

/// `Object.entries(value)`. 문자열은 글자마다 항목이 되지만 그 값(글자)에는 속성이 없으므로 여기서는 비운다
fn entries_of(value: &JsValue) -> Vec<(String, &JsValue)> {
    match value {
        JsValue::Obj(o) => o.entries_js_order().into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
        JsValue::Arr(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Vec::new(),
    }
}

/// 정규화한 설정(JSON)에서 depends_on만 뽑는다. 긴 형식(객체)과 짧은 형식(배열)을 모두 받는다
pub fn parse_depends_on(config: &JsValue) -> JsValue {
    let empty = JsValue::Obj(JsObject::new());
    let services = match config.prop("services") {
        None | Some(JsValue::Null) => &empty,
        Some(other) => other,
    };
    let mut result = JsObject::new();
    for (name, service) in entries_of(services) {
        let Some(raw) = service.prop("depends_on") else { continue };
        let deps = match raw {
            JsValue::Arr(items) => {
                let mut deps = JsObject::new();
                for dep in items.iter().filter_map(JsValue::as_str) {
                    let mut condition = JsObject::new();
                    condition.set("condition", JsValue::str("service_started"));
                    deps.set(dep, JsValue::Obj(condition));
                }
                deps
            }
            JsValue::Obj(_) => {
                let mut deps = JsObject::new();
                for (dep, value) in entries_of(raw) {
                    let mut item = JsObject::new();
                    // `value?.condition` — null·원시 값은 속성이 없다
                    if let Some(condition @ JsValue::Str(_)) = value.prop("condition") {
                        item.set("condition", condition.clone());
                    }
                    if let Some(required @ JsValue::Bool(_)) = value.prop("required") {
                        item.set("required", required.clone());
                    }
                    deps.set(&dep, JsValue::Obj(item));
                }
                deps
            }
            _ => continue,
        };
        if name != "__proto__" {
            result.set(&name, JsValue::Obj(deps));
        }
    }
    JsValue::Obj(result)
}

/// 서비스 하나가 거는 의존의 이름들(`Object.keys(dependsOn[service] ?? {})`)
fn dependency_names<'a>(depends_on: &'a JsValue, service: &str) -> Vec<&'a str> {
    match depends_on.prop(service) {
        Some(JsValue::Obj(o)) => o.entries().iter().map(|(k, _)| k.as_str()).collect(),
        _ => Vec::new(),
    }
}

/// 시작할 서비스를 의존 순서대로 묶는다. **목록 안의 의존만 본다** — 목록에 없는 의존 서비스는 무시한다
/// (`up --no-deps a b`와 같다: 사용자가 꺼 둔 의존 서비스를 따라 켜지 않는다).
/// 한 묶음의 서비스는 서로 의존하지 않으므로 함께 시작해도 된다. 의존이 돌고 돌면(순환) 남은 것을 한 묶음으로 둔다
pub fn start_waves(services: &[String], depends_on: &JsValue) -> Vec<Vec<String>> {
    // `new Set(services)` — 겹친 이름은 처음 자리에 한 번만
    let mut seen = HashSet::new();
    let mut pending: Vec<&str> = services.iter().map(String::as_str).filter(|s| seen.insert(*s)).collect();
    let mut waves = Vec::new();
    while !pending.is_empty() {
        let still: HashSet<&str> = pending.iter().copied().collect();
        let ready: Vec<&str> = pending.iter().copied().filter(|service| dependency_names(depends_on, service).iter().all(|dep| dep == service || !still.contains(dep))).collect();
        let wave = if ready.is_empty() { pending.clone() } else { ready };
        pending.retain(|service| !wave.contains(service));
        waves.push(wave.into_iter().map(str::to_owned).collect());
    }
    waves
}

/// 다음에 시작할 서비스들이 이 서비스에 거는 조건 중 기다려야 하는 것. 여럿이면 더 엄격한 쪽(healthy)을 고른다
pub fn awaited_condition(service: &str, later: &[String], depends_on: &JsValue) -> Option<&'static str> {
    let mut completed = false;
    for dependent in later {
        let condition = depends_on.prop(dependent).and_then(|deps| deps.prop(service)).and_then(|dep| dep.prop("condition"));
        match condition.and_then(JsValue::as_str) {
            Some("service_healthy") => return Some("service_healthy"),
            Some("service_completed_successfully") => completed = true,
            _ => {}
        }
    }
    completed.then_some("service_completed_successfully")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json;

    fn json(text: &str) -> JsValue {
        js_json::parse(text).unwrap()
    }
    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn 긴_형식과_짧은_형식을_읽는다() {
        let config = json(r#"{"services":{"web":{"depends_on":{"db":{"condition":"service_healthy","required":false},"cache":null,"x":{"condition":3}}},"worker":{"depends_on":["db","db",5]},"db":{}}}"#);
        let got = js_json::stringify(&parse_depends_on(&config));
        assert_eq!(got, r#"{"web":{"db":{"condition":"service_healthy","required":false},"cache":{},"x":{}},"worker":{"db":{"condition":"service_started"}}}"#);
    }

    #[test]
    fn 모양이_어긋난_설정은_빈_결과다() {
        for text in ["null", "5", r#""x""#, "[]", r#"{"services":null}"#, r#"{"services":5}"#, r#"{"services":"web"}"#, r#"{"services":{"a":null,"b":"x","c":{"depends_on":null}}}"#] {
            assert_eq!(js_json::stringify(&parse_depends_on(&json(text))), "{}", "{text}");
        }
    }

    #[test]
    fn proto_이름의_서비스는_의존을_버린다() {
        let config = json(r#"{"services":{"__proto__":{"depends_on":["db"]},"web":{"depends_on":["db"]}}}"#);
        assert_eq!(js_json::stringify(&parse_depends_on(&config)), r#"{"web":{"db":{"condition":"service_started"}}}"#);
    }

    #[test]
    fn 시작_묶음은_의존_순서다() {
        let deps = json(r#"{"web":{"api":{}},"api":{"db":{}},"db":{}}"#);
        assert_eq!(start_waves(&names(&["web", "api", "db"]), &deps), vec![names(&["db"]), names(&["api"]), names(&["web"])]);
    }

    #[test]
    fn 목록에_없는_의존과_자기_자신은_무시한다() {
        let deps = json(r#"{"web":{"db":{},"web":{}},"api":{}}"#);
        assert_eq!(start_waves(&names(&["web", "api"]), &deps), vec![names(&["web", "api"])]);
    }

    #[test]
    fn 순환은_남은_것을_한_묶음으로_둔다() {
        let deps = json(r#"{"a":{"b":{}},"b":{"a":{}},"c":{"a":{}}}"#);
        assert_eq!(start_waves(&names(&["a", "b", "c"]), &deps), vec![names(&["a", "b", "c"])]);
    }

    #[test]
    fn 겹친_이름은_한_번만_센다() {
        assert_eq!(start_waves(&names(&["a", "b", "a"]), &json("{}")), vec![names(&["a", "b"])]);
        assert!(start_waves(&[], &json("{}")).is_empty());
    }

    #[test]
    fn 기다릴_조건은_더_엄격한_쪽이다() {
        let deps = json(r#"{"a":{"db":{"condition":"service_completed_successfully"}},"b":{"db":{"condition":"service_healthy"}},"c":{"db":{"condition":"service_started"}}}"#);
        assert_eq!(awaited_condition("db", &names(&["a", "b"]), &deps), Some("service_healthy"));
        assert_eq!(awaited_condition("db", &names(&["a", "c"]), &deps), Some("service_completed_successfully"));
        assert_eq!(awaited_condition("db", &names(&["c", "zzz"]), &deps), None);
        assert_eq!(awaited_condition("db", &[], &deps), None);
    }
}
