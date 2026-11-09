//! 두 OpenAPI 문서의 비교(ADR-191 3단계 3e). `packages/agent/src/contract-diff.ts`에서 옮겼다.
//!
//! 에이전트가 "필드 추가"를 요청받고 필드를 지우거나 타입을 바꾸면 검증 단계에서 드러나게 하는 판정이다. 객체는 JS 순서(정수 꼴 키가
//! 먼저)로 훑고, 변경 목록은 (호환 깨짐 먼저, 대상 이름의 UTF-16 순서)로 안정 정렬한다.
//!
//! 옛 TS는 객체를 `obj[name]`·`name in obj`로 읽어 `constructor`·`toString`·`__proto__` 같은 `Object.prototype`의 이름을 이미 있는
//! 항목으로 봤다(예: 이름이 `toString`인 스키마를 지워도 `schema-removed`가 아니라 속성별 변경으로 나온다). 같은 결과를 내려고 그 이름들을
//! 같게 읽는다(`PROTOTYPE_MEMBERS`). `$ref`는 풀지 않고 마지막 `/` 뒤 이름만 쓴다.
//!
//! 의도한 차이(모두 던지는 쪽): 객체여야 할 자리(`paths`·`schemas`·`properties`)에 문자열·배열·수가 있거나 `required`가 배열이 아니거나
//! `$ref`·`type`이 문자열이(배열이) 아니면 던진다(JS는 글자 단위로 펼치거나 `TypeError`다). 짝 없는 서로게이트가 있는 이름은 던진다.
//! 중첩이 2,000단계를 넘는 문서는 읽지 않는다(`js_json`).

use crate::js::{cmp_utf16, stable_sort_by};
use crate::js_json::{self, JsObject, JsValue};
use crate::review_input::{nullish_array, nullish_object, opt_prop, prop};
use std::collections::{HashMap, HashSet};

const HTTP_METHODS: [&str; 8] = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/// `Object.prototype`에서 상속되는 이름. 자기 속성이 아니어도 `obj[name]`은 값(함수)이고 `name in obj`는 참이다
const PROTOTYPE_MEMBERS: [&str; 12] = [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
];

#[derive(Debug, Clone, PartialEq)]
pub struct ContractChange {
    pub kind: &'static str,
    pub target: String,
    pub breaking: bool,
    pub detail: Option<String>,
}

impl ContractChange {
    fn new(kind: &'static str, target: String, breaking: bool, detail: Option<String>) -> Self {
        Self { kind, target, breaking, detail }
    }

    pub fn to_value(&self) -> JsValue {
        js_json::object(vec![
            ("kind", Some(JsValue::str(self.kind))),
            ("target", Some(JsValue::str(self.target.as_str()))),
            ("breaking", Some(JsValue::Bool(self.breaking))),
            ("detail", self.detail.as_deref().map(JsValue::str)),
        ])
    }
}

/// `obj[key]`: 자기 속성이거나 `Object.prototype`에서 상속된 이름이면 있다
enum Slot<'a> {
    Own(&'a JsValue),
    /// 상속된 함수(또는 `Object.prototype`). 속성을 읽으면 모두 `undefined`다
    Inherited,
}

struct Index<'a> {
    object: &'a JsObject,
    by_key: HashMap<&'a str, &'a JsValue>,
}

impl<'a> Index<'a> {
    fn new(object: &'a JsObject) -> Self {
        // 같은 키는 파서가 이미 하나로 합쳤다
        Self { object, by_key: object.entries().iter().map(|(k, v)| (k.as_str(), v)).collect() }
    }

    fn get(&self, key: &str) -> Option<Slot<'a>> {
        match self.by_key.get(key) {
            Some(v) => Some(Slot::Own(v)),
            None if PROTOTYPE_MEMBERS.contains(&key) => Some(Slot::Inherited),
            None => None,
        }
    }

    /// `key in obj`
    fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// `Object.keys` / `Object.entries`
    fn entries(&self) -> Vec<(&'a str, &'a JsValue)> {
        self.object.entries_js_order()
    }
}

/// `schema.$ref.split('/').at(-1)`와 `type`·`items`·`format`으로 읽는 한 줄 이름
fn describe_type(schema: Option<&JsValue>) -> Result<String, String> {
    // `schema.$ref`: null이면 던진다. 객체가 아닌 값은 `undefined`
    let schema = match schema {
        None | Some(JsValue::Null) => return Err("스키마가 비어 있어 타입을 읽을 수 없습니다".into()),
        Some(s) => s,
    };
    if let Some(reference) = schema.prop("$ref").filter(|v| v.truthy()) {
        let JsValue::Str(reference) = reference else {
            return Err("$ref가 문자열이 아닙니다".into());
        };
        return Ok(reference.rsplit('/').next().unwrap_or(reference).to_owned());
    }
    let type_text = match schema.prop("type") {
        Some(JsValue::Arr(items)) => items.iter().filter(|t| !matches!(t, JsValue::Str(s) if s == "null")).map(|t| if matches!(t, JsValue::Null) { String::new() } else { t.to_js_string() }).collect::<Vec<_>>().join("|"),
        None | Some(JsValue::Null) => "any".to_owned(),
        Some(JsValue::Str(s)) => s.clone(),
        Some(_) => return Err("type이 문자열이나 배열이 아닙니다".into()),
    };
    if type_text == "array" {
        if let Some(items) = schema.prop("items").filter(|v| v.truthy()) {
            return Ok(format!("{}[]", describe_type(Some(items))?));
        }
    }
    Ok(match schema.prop("format").filter(|v| v.truthy()) {
        Some(format) => format!("{type_text}({})", format.to_js_string()),
        None => type_text,
    })
}

/// `Object.keys(item)`가 HTTP 메서드인 항목. 메서드 이름은 대소문자를 가리지 않는다(`toLowerCase()`가 ASCII가 되는 글자는 ASCII뿐이다)
fn operations(document: Option<&JsValue>) -> Result<Vec<String>, String> {
    let empty = JsObject::new();
    let paths = nullish_object(opt_prop(document, "paths"), "paths", &empty)?;
    let mut found: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (route, item) in paths.entries_js_order() {
        match item {
            JsValue::Null => return Err("경로 항목이 비어 있습니다".into()),
            // 문자열·배열의 키는 인덱스, 수·불리언은 키가 없다: 메서드와 맞는 것이 없다
            JsValue::Obj(item) => {
                for (method, _) in item.entries_js_order() {
                    if HTTP_METHODS.iter().any(|m| m.eq_ignore_ascii_case(method)) {
                        let op = format!("{} {route}", method.to_ascii_uppercase());
                        if seen.insert(op.clone()) {
                            found.push(op);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(found)
}

/// `new Set(value ?? [])`에 문자열을 `has`로 묻는 쪽만 쓴다
fn string_set(value: Option<&JsValue>, what: &str) -> Result<HashSet<String>, String> {
    Ok(nullish_array(value, what)?.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
}

fn diff_properties(schema: &str, previous: &JsValue, next: Option<&Slot>) -> Result<Vec<ContractChange>, String> {
    let empty = JsObject::new();
    let mut changes = Vec::new();
    // `previous.properties`: previous가 null이면 던진다
    if matches!(previous, JsValue::Null) {
        return Err("스키마가 비어 있습니다".into());
    }
    let next_value = match next {
        Some(Slot::Own(v)) => {
            if matches!(v, JsValue::Null) {
                return Err("스키마가 비어 있습니다".into());
            }
            Some(*v)
        }
        _ => None,
    };
    let before_props = Index::new(nullish_object(previous.prop("properties"), "properties", &empty)?);
    let after_props = Index::new(nullish_object(next_value.and_then(|n| n.prop("properties")), "properties", &empty)?);
    let before_required = string_set(previous.prop("required"), "required")?;
    let after_required = string_set(next_value.and_then(|n| n.prop("required")), "required")?;

    for (prop_name, definition) in after_props.entries() {
        let target = format!("{schema}.{prop_name}");
        let old = before_props.get(prop_name).filter(|slot| match slot {
            Slot::Own(v) => v.truthy(),
            Slot::Inherited => true,
        });
        let Some(old) = old else {
            // 새 필드가 처음부터 필수면 기존 요청 본문이 거부될 수 있다
            let required = after_required.contains(prop_name);
            changes.push(ContractChange::new("property-added", target, required, Some(describe_type(Some(definition))? + if required { ", required" } else { "" })));
            continue;
        };
        let old_type = match old {
            Slot::Own(v) => describe_type(Some(v))?,
            Slot::Inherited => "any".to_owned(),
        };
        let new_type = describe_type(Some(definition))?;
        if old_type != new_type {
            changes.push(ContractChange::new("property-type-changed", target.clone(), true, Some(format!("{old_type} → {new_type}"))));
        }
        if !before_required.contains(prop_name) && after_required.contains(prop_name) {
            changes.push(ContractChange::new("property-became-required", target, true, None));
        }
    }
    for (prop_name, _) in before_props.entries() {
        if !after_props.contains(prop_name) {
            changes.push(ContractChange::new("property-removed", format!("{schema}.{prop_name}"), true, None));
        }
    }
    Ok(changes)
}

fn schemas_of<'a>(document: Option<&'a JsValue>, empty: &'a JsObject) -> Result<&'a JsObject, String> {
    let components = opt_prop(document, "components");
    nullish_object(opt_prop(components, "schemas"), "schemas", empty)
}

/// 실행 중인 서버에서 추출한 두 OpenAPI 문서를 비교한다. `before`가 없으면 모든 것이 새로 생긴 것이다
pub fn diff_contracts(before: Option<&JsValue>, after: &JsValue) -> Result<Vec<ContractChange>, String> {
    if matches!(after, JsValue::Null) {
        return Err("비교할 문서가 비어 있습니다".into());
    }
    let mut changes: Vec<ContractChange> = Vec::new();

    let before_ops = operations(before)?;
    let after_ops = operations(Some(after))?;
    for op in &after_ops {
        if !before_ops.contains(op) {
            changes.push(ContractChange::new("operation-added", op.clone(), false, None));
        }
    }
    for op in &before_ops {
        if !after_ops.contains(op) {
            changes.push(ContractChange::new("operation-removed", op.clone(), true, None));
        }
    }

    let empty = JsObject::new();
    let before_schemas = Index::new(schemas_of(before, &empty)?);
    let after_schemas = Index::new(schemas_of(Some(after), &empty)?);

    for (name, _) in after_schemas.entries() {
        if !before_schemas.contains(name) {
            changes.push(ContractChange::new("schema-added", name.to_owned(), false, None));
        }
    }
    for (name, previous) in before_schemas.entries() {
        let next = after_schemas.get(name);
        let present = match &next {
            Some(Slot::Own(v)) => v.truthy(),
            Some(Slot::Inherited) => true,
            None => false,
        };
        if !present {
            changes.push(ContractChange::new("schema-removed", name.to_owned(), true, None));
            continue;
        }
        changes.extend(diff_properties(name, previous, next.as_ref())?);
    }

    // 로케일에 따라 순서가 바뀌지 않도록 UTF-16 코드 단위 순으로 정렬한다(안정 정렬)
    Ok(stable_sort_by(changes, &|a, b| {
        let by_breaking = f64::from(u8::from(b.breaking)) - f64::from(u8::from(a.breaking));
        if by_breaking != 0.0 {
            by_breaking
        } else {
            match cmp_utf16(&a.target, &b.target) {
                std::cmp::Ordering::Less => -1.0,
                std::cmp::Ordering::Greater => 1.0,
                std::cmp::Ordering::Equal => 0.0,
            }
        }
    }))
}

/// 에이전트에게 보여줄 계약 요약. 원본 JSON보다 훨씬 짧다
pub fn summarize_contract(document: &JsValue) -> Result<String, String> {
    if matches!(document, JsValue::Null) {
        return Err("요약할 문서가 비어 있습니다".into());
    }
    let mut ops = operations(Some(document))?;
    ops.sort_by(|a, b| cmp_utf16(a, b));
    let empty = JsObject::new();
    let mut schemas: Vec<String> = Vec::new();
    for (name, schema) in schemas_of(Some(document), &empty)?.entries_js_order() {
        if matches!(schema, JsValue::Null) {
            return Err("스키마가 비어 있습니다".into());
        }
        let required = string_set(schema.prop("required"), "required")?;
        let mut props: Vec<String> = Vec::new();
        for (prop_name, definition) in nullish_object(schema.prop("properties"), "properties", &empty)?.entries_js_order() {
            props.push(format!("{prop_name}{}: {}", if required.contains(prop_name) { "" } else { "?" }, describe_type(Some(definition))?));
        }
        schemas.push(format!("{name} {{ {} }}", props.join(", ")));
    }
    let mut lines = vec!["operations:".to_owned()];
    lines.extend(ops.iter().map(|op| format!("  {op}")));
    lines.push("schemas:".to_owned());
    lines.extend(schemas.iter().map(|line| format!("  {line}")));
    Ok(lines.join("\n"))
}

/// 변경 목록을 한 줄씩. 비었으면 "계약 변경 없음"
pub fn format_contract_changes(changes: &JsValue) -> Result<String, String> {
    let JsValue::Arr(changes) = changes else {
        return Err("변경 목록이 배열이 아닙니다".into());
    };
    if changes.is_empty() {
        return Ok("계약 변경 없음".into());
    }
    let mut lines = Vec::new();
    for change in changes {
        let get = |key: &str| prop(Some(change), key);
        let mark = if get("breaking")?.is_some_and(JsValue::truthy) { "⚠️ 호환 깨짐" } else { "＋" };
        let detail = match get("detail")?.filter(|v| v.truthy()) {
            Some(d) => format!(" ({})", d.to_js_string()),
            None => String::new(),
        };
        lines.push(format!("{mark} {} {}{detail}", crate::review_input::template(get("kind")?), crate::review_input::template(get("target")?)));
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(json: &str) -> JsValue {
        js_json::parse(json).unwrap()
    }

    #[test]
    fn 필드를_지우고_타입을_바꾸면_호환이_깨진다() {
        let before = v(r#"{"paths":{"/o":{"get":{}}},"components":{"schemas":{"Order":{"properties":{"id":{"type":"integer","format":"int64"},"memo":{"type":"string"}},"required":["id"]}}}}"#);
        let after = v(r#"{"paths":{"/o":{"get":{},"post":{}}},"components":{"schemas":{"Order":{"properties":{"id":{"type":"string"},"note":{"type":"string"}},"required":["id","note"]}}}}"#);
        let changes = diff_contracts(Some(&before), &after).unwrap();
        let text: Vec<_> = changes.iter().map(|c| format!("{} {} {}", c.kind, c.target, c.breaking)).collect();
        assert_eq!(
            text,
            [
                "property-type-changed Order.id true",
                "property-removed Order.memo true",
                "property-added Order.note true",
                "operation-added POST /o false"
            ]
        );
    }

    #[test]
    fn 상속된_이름은_이미_있는_것으로_읽는다() {
        let before = v(r#"{"components":{"schemas":{"toString":{"properties":{"a":{"type":"string"}}}}}}"#);
        let after = v(r#"{"components":{"schemas":{}}}"#);
        let changes = diff_contracts(Some(&before), &after).unwrap();
        // 옛 TS: schema-removed가 아니라 속성별 변경
        assert_eq!(changes.iter().map(|c| c.kind).collect::<Vec<_>>(), ["property-removed"]);
    }

    #[test]
    fn 모양이_어긋나면_던진다() {
        assert!(diff_contracts(None, &v(r#"{"paths":"x"}"#)).is_err());
        let bad = v(r#"{"components":{"schemas":{"A":{"required":"a"}}}}"#);
        assert!(diff_contracts(Some(&bad), &bad).is_err());
        assert!(diff_contracts(None, &v(r#"{"paths":{"/a":null}}"#)).is_err());
    }
}
