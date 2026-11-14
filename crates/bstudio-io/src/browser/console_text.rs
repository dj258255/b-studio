//! console 인자와 잡히지 않은 예외를 Playwright(1.63)와 같은 글로 만든다(ADR-199).
//!
//! 근거는 `playwright-core/lib/coreBundle.js`의 `renderPreview`(→ `ConsoleMessage.text()`), `getExceptionMessage`·`exceptionToError`·
//! `splitErrorMessage`(→ `pageerror`의 `error.message`)다. 판정(`browser_problems`)이 이 글을 증거로 쓰므로 규칙을 그대로 옮긴다.

use serde_json::Value;

/// `console.*` 호출 하나의 글: 인자마다 JSHandle의 미리보기를 공백으로 잇는다(`%s` 같은 형식 지정자는 풀지 않는다)
pub fn console_text(args: &[Value]) -> String {
    args.iter().map(handle_preview).collect::<Vec<_>>().join(" ")
}

/// Playwright `createHandle` → `JSHandle`의 미리보기. 노드는 `JSHandle@node`, 객체(objectId가 있는 것)는 `renderPreview`(비면 `JSHandle@종류`),
/// 객체가 아닌 값은 `String(값)`이다. 값은 `unserializableValue`를 `parseUnserializableValue`로 읽은 것이 먼저다:
/// NaN·Infinity·-Infinity·-0만 알고, 그 밖(`10n` 같은 bigint)은 undefined가 된다
pub fn handle_preview(object: &Value) -> String {
    let subtype = object.get("subtype").and_then(Value::as_str).filter(|text| !text.is_empty());
    if subtype == Some("node") {
        return "JSHandle@node".to_owned();
    }
    let has_object_id = object.get("objectId").and_then(Value::as_str).is_some_and(|id| !id.is_empty());
    if has_object_id {
        let preview = render_preview(object);
        if !preview.is_empty() {
            return preview;
        }
        let kind = subtype.or_else(|| object.get("type").and_then(Value::as_str)).unwrap_or("undefined");
        return format!("JSHandle@{kind}");
    }
    match object.get("unserializableValue").and_then(Value::as_str).filter(|text| !text.is_empty()) {
        Some("NaN") => "NaN".to_owned(),
        Some("Infinity") => "Infinity".to_owned(),
        Some("-Infinity") => "-Infinity".to_owned(),
        Some("-0") => "0".to_owned(),
        Some(_) => "undefined".to_owned(),
        None => object.get("value").map(js_string).unwrap_or_else(|| "undefined".to_owned()),
    }
}

/// Playwright `renderPreview(remoteObject)`. `description`이 없으면 빈 글이다(`Array.join`이 undefined를 빈 글로 바꾼다)
pub fn render_preview(object: &Value) -> String {
    if object.get("type").and_then(Value::as_str) == Some("undefined") {
        return "undefined".to_owned();
    }
    if let Some(value) = object.get("value") {
        return js_string(value);
    }
    if let Some(unserializable) = object.get("unserializableValue") {
        return js_string(unserializable);
    }
    let description = object.get("description").and_then(Value::as_str);
    if description == Some("Object") {
        if let Some(preview) = object.get("preview") {
            let tokens: Vec<String> = properties(preview).iter().map(|property| format!("{}: {}", property_name(property), property_value(property))).collect();
            return format!("{{{}}}", tokens.join(", "));
        }
    }
    if object.get("subtype").and_then(Value::as_str) == Some("array") {
        if let Some(preview) = object.get("preview") {
            return sparse_array_to_string(&properties(preview));
        }
    }
    description.unwrap_or("").to_owned()
}

fn properties(preview: &Value) -> Vec<&Value> {
    preview.get("properties").and_then(Value::as_array).map(|list| list.iter().collect()).unwrap_or_default()
}

fn property_name(property: &Value) -> String {
    property.get("name").map(js_string).unwrap_or_else(|| "undefined".to_owned())
}

/// 속성 미리보기의 `value`. 없으면 템플릿 문자열이 `undefined`로 적는다
fn property_value(property: &Value) -> String {
    property.get("value").map(js_string).unwrap_or_else(|| "undefined".to_owned())
}

/// Playwright `sparseArrayToString`: 인덱스가 아닌 이름은 버리고, 빈 칸은 `empty` / `empty x N`으로 적는다
fn sparse_array_to_string(entries: &[&Value]) -> String {
    let mut indexed: Vec<(f64, String)> = Vec::new();
    for property in entries {
        let name = property_name(property);
        // JS `+name`: 숫자로 바꾸고, NaN이거나 음수면 건너뛴다
        let Some(index) = js_to_number(&name) else { continue };
        if index.is_nan() || index < 0.0 {
            continue;
        }
        indexed.push((index, property_value(property)));
    }
    indexed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut last = -1.0f64;
    let mut tokens: Vec<String> = Vec::new();
    for (index, value) in indexed {
        let empty = index - last - 1.0;
        if empty == 1.0 {
            tokens.push("empty".to_owned());
        } else if empty > 1.0 {
            tokens.push(format!("empty x {}", js_number_to_string(empty)));
        }
        tokens.push(value);
        last = index;
    }
    format!("[{}]", tokens.join(", "))
}

/// JS `+text`. 빈 글·공백만은 0, 숫자로 읽히지 않으면 None(NaN)
fn js_to_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return trimmed.parse::<f64>().ok();
    }
    trimmed.parse::<f64>().ok().filter(|number| number.is_finite())
}

/// JS `String(value)`(JSON으로 온 값)
pub fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_owned(),
        Value::Number(number) => number.as_f64().map(js_number_to_string).unwrap_or_else(|| number.to_string()),
        Value::Array(items) => items.iter().map(|item| if item.is_null() { String::new() } else { js_string(item) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// ECMAScript `Number::toString(10)`: 가장 짧게 되돌릴 수 있는 자릿수에 지수 표기 규칙(21자리·1e-6)을 얹는다
pub fn js_number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if number < 0.0 { "-" } else { "" };
    // `{:e}`는 가장 짧게 되돌릴 수 있는 자릿수를 `d.ddde±x`로 준다
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("지수 표기");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().expect("지수");
    let k = digits.len() as i32;
    // n: 소수점이 digits 앞에서 몇 칸 뒤에 오는가(ES 명세의 n)
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign_of_exponent = if n - 1 < 0 { "-" } else { "+" };
        let tail = (n - 1).abs();
        if k == 1 {
            format!("{digits}e{sign_of_exponent}{tail}")
        } else {
            format!("{}.{}e{sign_of_exponent}{tail}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// 잡히지 않은 예외의 `error.message`(Playwright `exceptionToError`가 만든 Error의 message)
pub fn exception_message(details: &Value) -> String {
    let with_stack = exception_text(details);
    let lines: Vec<&str> = with_stack.split('\n').collect();
    let first_stack_line = lines.iter().position(|line| line.starts_with("    at"));
    let with_name = match first_stack_line {
        None => with_stack.clone(),
        Some(index) => lines[..index].join("\n"),
    };
    split_error_message(&with_name).1
}

/// Playwright `getExceptionMessage`
fn exception_text(details: &Value) -> String {
    if let Some(exception) = details.get("exception") {
        // `exception.description || String(exception.value)`: 빈 글도 거짓이라 value로 넘어간다
        let description = exception.get("description").and_then(Value::as_str).unwrap_or("");
        if !description.is_empty() {
            return description.to_owned();
        }
        return exception.get("value").map(js_string).unwrap_or_else(|| "undefined".to_owned());
    }
    let mut message = details.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
    if let Some(frames) = details.get("stackTrace").and_then(|trace| trace.get("callFrames")).and_then(Value::as_array) {
        for frame in frames {
            let url = frame.get("url").and_then(Value::as_str).unwrap_or("");
            let line = frame.get("lineNumber").map(js_string).unwrap_or_else(|| "undefined".to_owned());
            let column = frame.get("columnNumber").map(js_string).unwrap_or_else(|| "undefined".to_owned());
            let function = frame.get("functionName").and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or("<anonymous>");
            message.push_str(&format!("\n    at {function} ({url}:{line}:{column})"));
        }
    }
    message
}

/// Playwright `splitErrorMessage`: 첫 `:` 앞이 name, 그 뒤 두 글자 건너뛴 곳부터가 message. `:`가 없거나 두 글자가 못 되면 통째로 message.
/// JS 문자열 길이는 UTF-16 단위라 길이 비교는 그 단위로 한다
pub fn split_error_message(message: &str) -> (String, String) {
    let Some(colon) = message.find(':') else { return (String::new(), message.to_owned()) };
    let colon_units = message[..colon].encode_utf16().count();
    let total_units = message.encode_utf16().count();
    if colon_units + 2 > total_units {
        return (message[..colon].to_owned(), message.to_owned());
    }
    // `substring(idx + 2)`: 콜론 다음 한 UTF-16 단위를 더 건너뛴다. 그 글자가 서로게이트 쌍이면 JS는 쌍을 쪼개지만 여기서는 글자째 건너뛴다
    let after_colon = &message[colon + 1..];
    let skipped = after_colon.chars().next().map(char::len_utf8).unwrap_or(0);
    (message[..colon].to_owned(), after_colon[skipped..].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_javascript() {
        let cases: [(f64, &str); 14] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-3.0, "-3"),
            (1.5, "1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.2345e-9, "1.2345e-9"),
            (100.0, "100"),
            (f64::MAX, "1.7976931348623157e+308"),
        ];
        for (number, expected) in cases {
            assert_eq!(js_number_to_string(number), expected, "{number:e}");
        }
        assert_eq!(js_number_to_string(f64::NAN), "NaN");
        assert_eq!(js_number_to_string(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn primitives_objects_and_arrays_render_like_playwright() {
        assert_eq!(console_text(&[json!({"type":"string","value":"a"}), json!({"type":"number","value":1,"description":"1"}), json!({"type":"boolean","value":true})]), "a 1 true");
        // 객체가 아닌 값은 `String(값)`: -0은 0, bigint는 undefined, 노드는 JSHandle@node, 설명이 없는 객체는 JSHandle@종류
        assert_eq!(handle_preview(&json!({"type":"number","unserializableValue":"-0","description":"-0"})), "0");
        assert_eq!(handle_preview(&json!({"type":"bigint","unserializableValue":"10n","description":"10n"})), "undefined");
        assert_eq!(handle_preview(&json!({"type":"number","unserializableValue":"Infinity"})), "Infinity");
        assert_eq!(handle_preview(&json!({"type":"undefined"})), "undefined");
        assert_eq!(handle_preview(&json!({"type":"object","subtype":"null","value":null})), "null");
        assert_eq!(handle_preview(&json!({"type":"object","subtype":"node","objectId":"1","description":"body"})), "JSHandle@node");
        assert_eq!(handle_preview(&json!({"type":"object","objectId":"2"})), "JSHandle@object");
        assert_eq!(handle_preview(&json!({"type":"object","subtype":"map","objectId":"3","description":"Map(1)"})), "Map(1)");
        assert_eq!(handle_preview(&json!({"type":"symbol","objectId":"4","description":"Symbol(s)"})), "Symbol(s)");
        assert_eq!(render_preview(&json!({"type":"undefined"})), "undefined");
        assert_eq!(render_preview(&json!({"type":"object","subtype":"null","value":null})), "null");
        assert_eq!(render_preview(&json!({"type":"number","unserializableValue":"NaN","description":"NaN"})), "NaN");
        assert_eq!(render_preview(&json!({"type":"bigint","unserializableValue":"10n","description":"10n"})), "10n");
        let object = json!({"type":"object","description":"Object","preview":{"properties":[{"name":"a","type":"number","value":"1"},{"name":"b","type":"string","value":"x"},{"name":"c","type":"object","value":"Array(2)"}]}});
        assert_eq!(render_preview(&object), "{a: 1, b: x, c: Array(2)}");
        let array = json!({"type":"object","subtype":"array","description":"Array(3)","preview":{"properties":[{"name":"0","value":"1"},{"name":"2","value":"3"}]}});
        assert_eq!(render_preview(&array), "[1, empty, 3]");
        let sparse = json!({"type":"object","subtype":"array","description":"Array(5)","preview":{"properties":[{"name":"0","value":"1"},{"name":"4","value":"5"},{"name":"length","value":"5"}]}});
        assert_eq!(render_preview(&sparse), "[1, empty x 3, 5]");
        assert_eq!(render_preview(&json!({"type":"object","subtype":"error","description":"Error: boom\n    at x"})), "Error: boom\n    at x");
        assert_eq!(render_preview(&json!({"type":"object"})), "");
        assert_eq!(render_preview(&json!({"type":"object","description":"Object","preview":{"properties":[{"name":"k"}]}})), "{k: undefined}");
    }

    #[test]
    fn exception_messages_follow_the_playwright_split() {
        let error = |description: &str| json!({"exception":{"type":"object","description":description}});
        assert_eq!(exception_message(&error("Error: boom\n    at foo (http://x/:1:2)")), "boom");
        assert_eq!(exception_message(&error("TypeError: Cannot read properties of undefined (reading 'call')\n    at http://x/:1:12")), "Cannot read properties of undefined (reading 'call')");
        assert_eq!(exception_message(&error("TypeError: multi\nline message\n    at x")), "multi\nline message");
        assert_eq!(exception_message(&error("MyErr: custom\n    at x")), "custom");
        assert_eq!(exception_message(&error("Error\n    at x")), "Error");
        assert_eq!(exception_message(&error("Error: \n    at x")), "");
        // throw "string", throw 42, throw null, throw {}
        assert_eq!(exception_message(&json!({"exception":{"type":"string","value":"string thrown"}})), "string thrown");
        assert_eq!(exception_message(&json!({"exception":{"type":"string","value":"a: b: c"}})), "b: c");
        assert_eq!(exception_message(&json!({"exception":{"type":"string","value":"colon at end:"}})), "colon at end:");
        assert_eq!(exception_message(&json!({"exception":{"type":"number","value":42,"description":"42"}})), "42");
        assert_eq!(exception_message(&json!({"exception":{"type":"object","subtype":"null","value":null}})), "null");
        assert_eq!(exception_message(&json!({"exception":{"type":"object","description":"Object"}})), "Object");
        assert_eq!(exception_message(&json!({"exception":{"type":"undefined"}})), "undefined");
        // exception이 없으면 text와 호출 스택
        assert_eq!(
            exception_message(&json!({"text":"Uncaught SyntaxError: x","stackTrace":{"callFrames":[{"url":"http://x/","lineNumber":1,"columnNumber":2,"functionName":""}]}})),
            // 첫 `:` 앞(`Uncaught SyntaxError`)은 name으로 떼어 내고 message만 남는다
            "x"
        );
        assert_eq!(exception_message(&json!({"text":"Uncaught"})), "Uncaught");
    }

    #[test]
    fn split_counts_utf16_units_for_the_length_rule() {
        assert_eq!(split_error_message("a: b"), ("a".to_owned(), "b".to_owned()));
        assert_eq!(split_error_message("no colon"), (String::new(), "no colon".to_owned()));
        assert_eq!(split_error_message("x:").1, "x:");
        // 콜론 뒤가 한 글자뿐이면 그 한 글자를 건너뛰어 빈 글이 된다(JS `"x:y".substring(3)`)
        assert_eq!(split_error_message("x:y").1, "");
    }
}
