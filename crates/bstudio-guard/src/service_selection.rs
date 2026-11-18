//! 서비스 선택의 순수 계산(`packages/spec/src/service-selection.ts`, ADR-083). Node를 모르는 판정이다.
//!
//! 옛 TS와 같은 입력에 같은 결과를 낸다. 그래프 값이 배열이 아니면 옛 코드도 `for...of`에서 던지므로,
//! 문자열(JS는 글자 단위로 순회한다) 말고는 오류로 돌려준다. 그래프에 없는 이름은 빈 목록이다(`?? []`).

use crate::js;
use crate::js_json::JsValue;

/// `graph[name] ?? []`. JS는 문자열을 글자 단위로 순회하고, 그 밖의 값은 던진다
fn dependencies(graph: &crate::js_json::JsObject, name: &str) -> Result<Vec<String>, String> {
    match graph.get(name) {
        None | Some(JsValue::Null) => Ok(Vec::new()),
        Some(JsValue::Arr(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::Str(s) => Ok(s.clone()),
                _ => Err(format!("그래프의 '{name}' 값에 문자열이 아닌 항목이 있습니다")),
            })
            .collect(),
        Some(JsValue::Str(s)) => Ok(s.chars().map(|c| c.to_string()).collect()),
        Some(_) => Err(format!("그래프의 '{name}' 값은 배열이 아닙니다")),
    }
}

/// `graph[name] ?? []).includes(target)` — 배열은 값 포함, 문자열은 부분 문자열
fn depends_on(graph: &crate::js_json::JsObject, name: &str, target: &str) -> Result<bool, String> {
    match graph.get(name) {
        None | Some(JsValue::Null) => Ok(false),
        Some(JsValue::Arr(items)) => Ok(items.iter().any(|item| matches!(item, JsValue::Str(s) if s == target))),
        Some(JsValue::Str(s)) => Ok(s.contains(target)),
        Some(_) => Err(format!("그래프의 '{name}' 값은 배열이 아닙니다")),
    }
}

/// roots에서 시작해 graph를 따라가며 닿는 모든 이름의 닫힘(자기 자신 포함). 삽입 순서는 옛 DFS와 같다
pub fn dependency_closure(roots: &[String], graph: &crate::js_json::JsObject) -> Result<Vec<String>, String> {
    let mut closure: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<String> = roots.to_vec();
    while let Some(name) = stack.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        closure.push(name.clone());
        for dependency in dependencies(graph, &name)? {
            if !seen.contains(&dependency) {
                stack.push(dependency);
            }
        }
    }
    Ok(closure)
}

/// managed 서비스 전부 + 기대는 서비스의 닫힘. 이름 순(UTF-16 코드 단위)으로 정렬한다
pub fn default_selection(roots: &[String], graph: &crate::js_json::JsObject) -> Result<Vec<String>, String> {
    let mut names = dependency_closure(roots, graph)?;
    names.sort_by(|a, b| js::cmp_utf16(a, b));
    Ok(names)
}

/// 이 서비스를 끄면 기댈 곳을 잃는, 지금 선택된 서비스 이름. 이름 순으로 정렬한다
pub fn dependents_of(name: &str, selected: &[String], graph: &crate::js_json::JsObject) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for service in selected {
        if service == name {
            continue;
        }
        if depends_on(graph, service, name)? {
            out.push(service.clone());
        }
    }
    out.sort_by(|a, b| js::cmp_utf16(a, b));
    Ok(out)
}

/// `known`에 없던 compose 서비스 이름. 입력 순서를 지킨다
pub fn newly_added(known: &[String], compose_services: &[String]) -> Vec<String> {
    let known: std::collections::HashSet<&str> = known.iter().map(String::as_str).collect();
    compose_services.iter().filter(|name| !known.contains(name.as_str())).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json::parse_native;

    fn graph(json: &str) -> crate::js_json::JsObject {
        match parse_native(json).unwrap() {
            JsValue::Obj(o) => o,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 닫힘은_뿌리에서_기대는_서비스를_따라간다() {
        let g = graph(r#"{"web":["api"],"api":["db","cache"],"db":[],"cache":[]}"#);
        let roots = vec!["web".to_owned()];
        let mut got = dependency_closure(&roots, &g).unwrap();
        got.sort();
        assert_eq!(got, ["api", "cache", "db", "web"]);
        assert_eq!(default_selection(&roots, &g).unwrap(), ["api", "cache", "db", "web"]);
    }

    #[test]
    fn 순환과_없는_키를_견딘다() {
        let g = graph(r#"{"a":["b"],"b":["a"]}"#);
        let roots = vec!["a".to_owned(), "missing".to_owned()];
        let got = dependency_closure(&roots, &g).unwrap();
        assert_eq!(got, ["missing", "a", "b"]);
        assert_eq!(dependents_of("a", &["b".to_owned()], &g).unwrap(), ["b"]);
        assert!(dependents_of("missing", &["a".to_owned()], &g).unwrap().is_empty());
    }

    #[test]
    fn 알려진_이름에_없는_것만_새로_센다() {
        let known = vec!["commerce".to_owned(), "mysql".to_owned()];
        let compose = vec!["commerce".to_owned(), "mysql".to_owned(), "mediamtx".to_owned()];
        assert_eq!(newly_added(&known, &compose), ["mediamtx"]);
        assert!(newly_added(&[], &compose).len() == 3);
    }

    #[test]
    fn 문자열_그래프는_js처럼_글자_단위로_본다() {
        let g = graph(r#"{"a":"bc"}"#);
        assert_eq!(dependency_closure(&["a".to_owned()], &g).unwrap(), ["a", "c", "b"]);
    }
}
