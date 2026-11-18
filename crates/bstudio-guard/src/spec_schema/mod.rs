//! `packages/spec/src/schema.ts`의 Zod 검증을 Rust로 옮긴 것(ADR-195 4e 뒤 3단계 (b)).
//!
//! 결과는 `{ ok, issues: [{ path, message }], value }`다. Zod 4.6.7의 `safeParse`와 같은 경로·문구·순서·기본값·
//! transform·모르는 키 버리기를 낸다. 판정 규칙은 `schema.ts`의 선언 순서를 그대로 따른다.
//!
//! Zod의 몇 가지 동작을 그대로 옮겼다:
//! - `invalid_type`·`invalid_value`(enum/literal)·`invalid_union`·`invalid_key`는 fatal(다음 검사를 막는다).
//!   `invalid_format`·`too_small`·`too_big`·`custom`은 non-fatal이라 뒤 검사와 `superRefine`이 계속 돈다.
//! - 문자열·배열 길이 검사는 `when`(값에 `.length`가 있음)이 참이면 타입 오류 뒤에도 돈다.
//! - `z.union`은 성공 분기가 없을 때 fatal이 아닌 분기가 하나뿐이면 그 분기의 오류를, 아니면 `Invalid input` 하나를 낸다.
//! - `z.record`의 키 오류 문구는 언제나 `Invalid key in record`이고, 키가 틀린 값은 검사하지 않는다.
//! - 모르는 키는 오류 없이 버린다(`strict` 없음).

mod project;
mod workflow;

use crate::js;
use crate::js_json::{JsObject, JsValue};

pub use project::validate;

/// 스키마 이름으로 검증한다(없는 입력은 `None` = JS `undefined`)
pub fn validate_optional(name: &str, input: Option<&JsValue>) -> Outcome {
    project::validate(name, input)
}

/// `load.ts`의 compose 스키마(내보내지 않는 스키마)
pub fn validate_compose(input: &JsValue) -> Outcome {
    project::compose(Some(input))
}

#[derive(Clone, Debug, PartialEq)]
pub enum Seg {
    Key(String),
    Index(usize),
}

impl Seg {
    pub fn into_value(self) -> JsValue {
        match self {
            Seg::Key(key) => JsValue::Str(key),
            Seg::Index(index) => JsValue::Num(index as f64),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Issue {
    pub path: Vec<Seg>,
    pub message: String,
    /// Zod에서 `continue`가 없는(또는 `false`인) 오류. 뒤 검사를 막고 union 분기 선택에 쓰인다
    pub fatal: bool,
}

#[derive(Clone, Debug)]
pub struct Outcome {
    pub value: Option<JsValue>,
    pub issues: Vec<Issue>,
}

impl Outcome {
    pub fn ok(value: JsValue) -> Self {
        Self { value: Some(value), issues: Vec::new() }
    }

    pub fn ok_none() -> Self {
        Self { value: None, issues: Vec::new() }
    }

    pub fn failed(value: Option<JsValue>, issue: Issue) -> Self {
        Self { value, issues: vec![issue] }
    }

    pub fn has_fatal(&self) -> bool {
        self.issues.iter().any(|issue| issue.fatal)
    }

    pub fn failed_any(&self) -> bool {
        !self.issues.is_empty()
    }
}

/// `out`에 `result`를 합친다. `prefix`가 있으면 오류 경로 앞에 붙인다
pub fn add(prefixed: Option<Seg>, result: Outcome, issues: &mut Vec<Issue>, set: &mut dyn FnMut(JsValue)) {
    for mut issue in result.issues {
        if let Some(prefix) = prefixed.clone() {
            issue.path.insert(0, prefix);
        }
        issues.push(issue);
    }
    if let Some(value) = result.value {
        set(value);
    }
}

pub fn push_at(issues: &mut Vec<Issue>, seg: Seg, mut issue: Issue) {
    issue.path.insert(0, seg);
    issues.push(issue);
}

pub fn issue(path: Vec<Seg>, message: impl Into<String>, fatal: bool) -> Issue {
    Issue { path, message: message.into(), fatal }
}

// ───────────────────────── JS 값 읽기 ─────────────────────────

pub fn js_ws_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r')
        || c == ' '
        || c == '\u{00a0}'
        || c == '\u{1680}'
        || ('\u{2000}'..='\u{200a}').contains(&c)
        || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(js_ws_char)
}

/// `String(value)`
pub fn text(value: &JsValue) -> String {
    value.to_js_string()
}

pub fn number_text(value: f64) -> String {
    js::number_to_string(value)
}

/// Zod `parsedType` + 영어 로케일의 `getTypeName`: NaN·Infinity는 글자로, 나머지는 타입 이름
pub fn type_name(value: Option<&JsValue>) -> String {
    match value {
        None => "undefined".into(),
        Some(JsValue::Null) => "null".into(),
        Some(JsValue::Bool(_)) => "boolean".into(),
        Some(JsValue::Str(_)) => "string".into(),
        Some(JsValue::Arr(_)) => "array".into(),
        Some(JsValue::Obj(_)) => "object".into(),
        Some(JsValue::Num(number)) => {
            if number.is_nan() {
                "NaN".into()
            } else if !number.is_finite() {
                number_text(*number)
            } else {
                "number".into()
            }
        }
    }
}

pub fn invalid_type(input: Option<&JsValue>, expected: &str) -> Issue {
    issue(Vec::new(), format!("Invalid input: expected {expected}, received {}", type_name(input)), true)
}

pub fn stringify_primitive(value: &JsValue) -> String {
    match value {
        JsValue::Str(text) => format!("\"{text}\""),
        JsValue::Num(number) => number_text(*number),
        JsValue::Bool(flag) => flag.to_string(),
        JsValue::Null => "null".into(),
        other => text(other),
    }
}

pub fn invalid_value(input: Option<&JsValue>, values: &[JsValue]) -> Issue {
    let message = if values.len() == 1 {
        format!("Invalid input: expected {}", stringify_primitive(&values[0]))
    } else {
        let list: Vec<String> = values.iter().map(stringify_primitive).collect();
        format!("Invalid option: expected one of {}", list.join("|"))
    };
    let _ = input;
    issue(Vec::new(), message, true)
}

// ───────────────────────── 기본 타입 ─────────────────────────

/// 문자열 길이 검사. Zod `$ZodCheckMinLength`/`MaxLength`: 값에 `.length`가 있으면 타입 오류 뒤에도 돈다
#[derive(Clone, Copy)]
pub enum LengthCheck {
    Min(usize, Option<&'static str>),
    Max(usize, Option<&'static str>),
}

/// JS `input.length`(UTF-16 단위)와 코드 포인트 길이를 내는 값
enum LengthOf<'a> {
    Str(&'a str),
    Array(usize),
    Object(f64),
}

fn length_of(value: Option<&JsValue>) -> Option<LengthOf<'_>> {
    match value? {
        JsValue::Str(text) => Some(LengthOf::Str(text)),
        JsValue::Arr(items) => Some(LengthOf::Array(items.len())),
        JsValue::Obj(o) => o.get("length").filter(|v| !matches!(v, JsValue::Null)).map(|v| LengthOf::Object(v.to_number())),
        _ => None,
    }
}

fn length_origin(value: Option<&JsValue>) -> &'static str {
    match value {
        Some(JsValue::Arr(_)) => "array",
        Some(JsValue::Str(_)) => "string",
        _ => "unknown",
    }
}

fn length_units(length: &LengthOf<'_>) -> f64 {
    match length {
        LengthOf::Str(text) => text.encode_utf16().count() as f64,
        LengthOf::Array(count) => *count as f64,
        LengthOf::Object(number) => *number,
    }
}

fn code_point_length(text: &str) -> usize {
    text.chars().count()
}

fn length_check(value: Option<&JsValue>, check: LengthCheck, limit: usize, issues: &mut Vec<Issue>) {
    let Some(length) = length_of(value) else { return };
    let units = length_units(&length);
    let (failed, message) = match check {
        LengthCheck::Min(minimum, custom) => {
            let exact = match &length {
                // JS yaml/Zod: 문자열은 코드 포인트로 센다. UTF-16 단위가 2*min 이상이면 확실히 통과한다
                LengthOf::Str(text) if units >= minimum as f64 && units < (minimum * 2) as f64 => code_point_length(text) as f64,
                _ => units,
            };
            if exact >= minimum as f64 {
                return;
            }
            let origin = length_origin(value);
            let size = if origin == "string" { "characters" } else if origin == "array" { "items" } else { "" };
            let default = if size.is_empty() {
                format!("Too small: expected {origin} to be >={minimum}")
            } else {
                format!("Too small: expected {origin} to have >={minimum} {size}")
            };
            (true, custom.map(str::to_owned).unwrap_or(default))
        }
        LengthCheck::Max(maximum, custom) => {
            let exact = match &length {
                LengthOf::Str(text) if units > maximum as f64 => code_point_length(text) as f64,
                _ => units,
            };
            if exact <= maximum as f64 {
                return;
            }
            let origin = length_origin(value);
            let size = if origin == "string" { "characters" } else if origin == "array" { "items" } else { "" };
            let default = if size.is_empty() {
                format!("Too big: expected {origin} to be <={maximum}")
            } else {
                format!("Too big: expected {origin} to have <={maximum} {size}")
            };
            (true, custom.map(str::to_owned).unwrap_or(default))
        }
    };
    let _ = limit;
    if failed {
        issues.push(issue(Vec::new(), message, false));
    }
}

#[derive(Clone, Copy)]
pub enum NumberCheck {
    Int,
    Min(f64, bool),
    Max(f64, bool),
    /// 사용자 문구를 붙인 상한(예: `maxPages는 최대 10개까지 쓸 수 있습니다`)
    MaxMessage(f64, &'static str),
    Positive,
}

pub fn validate_number(input: Option<&JsValue>, checks: &[NumberCheck]) -> Outcome {
    let Some(JsValue::Num(number)) = input else {
        return Outcome::failed(None, invalid_type(input, "number"));
    };
    if !number.is_finite() {
        return Outcome::failed(None, invalid_type(input, "number"));
    }
    let mut value = Some(JsValue::Num(*number));
    let mut issues = Vec::new();
    for check in checks {
        match check {
            NumberCheck::Int => {
                if number.fract() != 0.0 {
                    issues.push(invalid_type(input, "int"));
                    return Outcome { value, issues };
                }
                if number.abs() > 9_007_199_254_740_991.0 {
                    let (message, fatal) = if *number > 0.0 {
                        (format!("Too big: expected int to be <={}", number_text(9_007_199_254_740_991.0)), false)
                    } else {
                        (format!("Too small: expected int to be >={}", number_text(-9_007_199_254_740_991.0)), false)
                    };
                    issues.push(issue(Vec::new(), message, fatal));
                }
            }
            NumberCheck::Min(minimum, inclusive) => {
                if if *inclusive { number < minimum } else { number <= minimum } {
                    let op = if *inclusive { ">=" } else { ">" };
                    issues.push(issue(Vec::new(), format!("Too small: expected number to be {op}{}", number_text(*minimum)), false));
                }
            }
            NumberCheck::Max(maximum, inclusive) => {
                if if *inclusive { number > maximum } else { number >= maximum } {
                    let op = if *inclusive { "<=" } else { "<" };
                    issues.push(issue(Vec::new(), format!("Too big: expected number to be {op}{}", number_text(*maximum)), false));
                }
            }
            NumberCheck::MaxMessage(maximum, message) => {
                if number > maximum {
                    issues.push(issue(Vec::new(), (*message).to_owned(), false));
                }
            }
            NumberCheck::Positive => {
                if *number <= 0.0 {
                    issues.push(issue(Vec::new(), "Too small: expected number to be >0".to_owned(), false));
                }
            }
        }
    }
    value = Some(JsValue::Num(*number));
    Outcome { value, issues }
}

/// 문자열 기본 타입 + 길이/형식/refine 검사. `checks`는 Zod가 붙인 순서대로 부른다
pub fn validate_string(input: Option<&JsValue>, lengths: &[LengthCheck], checks: &mut dyn FnMut(Option<&JsValue>, &mut Vec<Issue>)) -> Outcome {
    let mut issues = Vec::new();
    if !matches!(input, Some(JsValue::Str(_))) {
        issues.push(invalid_type(input, "string"));
    }
    // 길이 검사는 when(값에 length가 있음)이 참이면 타입 오류 뒤에도 돈다
    for check in lengths {
        let (limit, length_check_kind) = match check {
            LengthCheck::Min(limit, custom) => (*limit, LengthCheck::Min(*limit, *custom)),
            LengthCheck::Max(limit, custom) => (*limit, LengthCheck::Max(*limit, *custom)),
        };
        length_check(input, length_check_kind, limit, &mut issues);
    }
    if issues.iter().all(|issue| !issue.fatal) {
        let value = input.cloned();
        checks(input, &mut issues);
        let value = value.or_else(|| input.cloned());
        return Outcome { value, issues };
    }
    Outcome { value: input.cloned(), issues }
}

pub fn string_format(input: Option<&JsValue>, test: impl Fn(&str) -> bool, message: String, pattern: Option<String>) -> Outcome {
    let mut issues = Vec::new();
    let Some(JsValue::Str(value)) = input else {
        return Outcome::failed(None, invalid_type(input, "string"));
    };
    if !test(value) {
        let text = match pattern {
            Some(pattern) => format!("Invalid string: must match pattern {pattern}"),
            None => message,
        };
        issues.push(issue(Vec::new(), text, false));
    }
    Outcome { value: Some(JsValue::Str(value.clone())), issues }
}

pub fn validate_enum(input: Option<&JsValue>, values: &[&str]) -> Outcome {
    if let Some(JsValue::Str(text)) = input {
        if values.contains(&text.as_str()) {
            return Outcome::ok(JsValue::Str(text.clone()));
        }
    }
    let values: Vec<JsValue> = values.iter().map(|v| JsValue::Str((*v).to_owned())).collect();
    Outcome::failed(input.cloned(), invalid_value(input, &values))
}

pub fn validate_literal(input: Option<&JsValue>, value: JsValue) -> Outcome {
    let same = match (input, &value) {
        (Some(JsValue::Str(a)), JsValue::Str(b)) => a == b,
        (Some(JsValue::Num(a)), JsValue::Num(b)) => a == b,
        (Some(JsValue::Bool(a)), JsValue::Bool(b)) => a == b,
        (Some(JsValue::Null), JsValue::Null) => true,
        _ => false,
    };
    if same {
        Outcome::ok(value)
    } else {
        Outcome::failed(input.cloned(), invalid_value(input, std::slice::from_ref(&value)))
    }
}

pub fn optional(input: Option<&JsValue>, inner: impl FnOnce(Option<&JsValue>) -> Outcome) -> Outcome {
    match input {
        None => Outcome::ok_none(),
        Some(value) => inner(Some(value)),
    }
}

pub fn defaulted(input: Option<&JsValue>, default: impl FnOnce() -> JsValue, inner: impl FnOnce(Option<&JsValue>) -> Outcome) -> Outcome {
    match input {
        None => Outcome::ok(default()),
        Some(value) => inner(Some(value)),
    }
}

pub fn nullable(input: Option<&JsValue>, inner: impl FnOnce(Option<&JsValue>) -> Outcome) -> Outcome {
    match input {
        Some(JsValue::Null) => Outcome::ok(JsValue::Null),
        _ => inner(input),
    }
}

/// 배열. 항목 오류 뒤에 길이 검사를 붙인다
pub fn validate_array(input: Option<&JsValue>, element: impl Fn(Option<&JsValue>) -> Outcome, lengths: &[LengthCheck]) -> Outcome {
    let mut issues = Vec::new();
    let mut out = Vec::new();
    if let Some(JsValue::Arr(items)) = input {
        for (index, item) in items.iter().enumerate() {
            let result = element(Some(item));
            for mut issue in result.issues {
                issue.path.insert(0, Seg::Index(index));
                issues.push(issue);
            }
            out.push(result.value.unwrap_or(JsValue::Null));
        }
        for check in lengths {
            match check {
                LengthCheck::Min(limit, custom) => length_check(Some(input.unwrap()), LengthCheck::Min(*limit, *custom), *limit, &mut issues),
                LengthCheck::Max(limit, custom) => length_check(Some(input.unwrap()), LengthCheck::Max(*limit, *custom), *limit, &mut issues),
            }
        }
        return Outcome { value: Some(JsValue::Arr(out)), issues };
    }
    issues.push(invalid_type(input, "array"));
    // 길이 검사는 when(문자열·배열 등 length가 있는 값)이 참이면 타입 오류 뒤에도 돈다
    for check in lengths {
        match check {
            LengthCheck::Min(limit, custom) => length_check(input, LengthCheck::Min(*limit, *custom), *limit, &mut issues),
            LengthCheck::Max(limit, custom) => length_check(input, LengthCheck::Max(*limit, *custom), *limit, &mut issues),
        }
    }
    let _ = &mut out;
    Outcome { value: input.cloned(), issues }
}

// ───────────────────────── 객체·record ─────────────────────────

pub struct ObjectInput<'a> {
    pub input: &'a JsValue,
    pub out: JsObject,
    pub issues: Vec<Issue>,
}

pub fn object_start(input: Option<&JsValue>) -> Result<ObjectInput<'_>, Outcome> {
    match input {
        Some(value @ JsValue::Obj(_)) => Ok(ObjectInput { input: value, out: JsObject::new(), issues: Vec::new() }),
        _ => Err(Outcome::failed(input.cloned(), invalid_type(input, "object"))),
    }
}

impl<'a> ObjectInput<'a> {
    pub fn field(&self, key: &str) -> Option<&'a JsValue> {
        self.input.prop(key)
    }

    pub fn set(&mut self, key: &str, result: Outcome) {
        for mut issue in result.issues {
            issue.path.insert(0, Seg::Key(key.to_owned()));
            self.issues.push(issue);
        }
        if let Some(value) = result.value {
            self.out.set(key, value);
        }
    }

    /// 검사(superRefine 등)는 fatal 오류가 없을 때만 돈다
    pub fn run_checks(&mut self, checks: &mut dyn FnMut(&JsObject, &mut Vec<Issue>)) {
        if self.issues.iter().any(|issue| issue.fatal) {
            return;
        }
        checks(&self.out, &mut self.issues);
    }

    pub fn finish(self) -> Outcome {
        Outcome { value: Some(JsValue::Obj(self.out)), issues: self.issues }
    }

    pub fn finish_with(self, transform: impl FnOnce(JsObject) -> JsValue) -> Outcome {
        if self.issues.is_empty() {
            Outcome::ok(transform(self.out))
        } else {
            Outcome { value: Some(JsValue::Obj(self.out)), issues: self.issues }
        }
    }
}

/// `z.record(키 스키마, 값 스키마)`. 키가 틀린 값은 검사하지 않고, `__proto__` 키는 버린다
pub fn validate_record(
    input: Option<&JsValue>,
    key_ok: impl Fn(&str) -> bool,
    value: impl Fn(Option<&JsValue>) -> Outcome,
) -> Outcome {
    let Some(JsValue::Obj(object)) = input else {
        return Outcome::failed(input.cloned(), invalid_type(input, "record"));
    };
    let mut out = JsObject::new();
    let mut issues = Vec::new();
    for (key, item) in object.entries_js_order() {
        if key == "__proto__" {
            continue;
        }
        if !key_ok(key) {
            issues.push(issue(vec![Seg::Key(key.to_owned())], "Invalid key in record".to_owned(), true));
            continue;
        }
        let result = value(Some(item));
        for mut issue in result.issues {
            issue.path.insert(0, Seg::Key(key.to_owned()));
            issues.push(issue);
        }
        if let Some(value) = result.value {
            out.set(key, value);
        }
    }
    Outcome { value: Some(JsValue::Obj(out)), issues }
}

pub fn validate_union(input: Option<&JsValue>, branches: &[fn(Option<&JsValue>) -> Outcome]) -> Outcome {
    let mut results = Vec::new();
    for branch in branches {
        let result = branch(input);
        if result.issues.is_empty() {
            return result;
        }
        results.push(result);
    }
    let nonaborted: Vec<&Outcome> = results.iter().filter(|result| !result.has_fatal()).collect();
    if nonaborted.len() == 1 {
        return nonaborted[0].clone();
    }
    Outcome::failed(input.cloned(), issue(Vec::new(), "Invalid input", true))
}

// ───────────────────────── 정규식 (JS 의미) ─────────────────────────

pub fn regex_ascii_i(pattern: &str) -> regex::Regex {
    regex::Regex::new(&format!("(?i-u:{pattern})")).expect("정규식")
}

pub fn regex_plain(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).expect("정규식")
}

pub fn default_regex_pattern(source: &str, flags: &str) -> String {
    format!("/{source}/{flags}")
}

