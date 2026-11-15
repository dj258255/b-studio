//! MCP 도구 서버의 프로토콜(ADR-201, 4f A7b). `packages/agent/src/mcp-http-server.ts`가 쓰던 `@modelcontextprotocol/sdk`의
//! stateless streamable HTTP 서버가 하던 일 가운데 b-studio가 쓰는 만큼을 직접 구현한다. 전송(리스너·연결·SSE 쓰기)은 `loopback_server.rs`가 하고,
//! 여기는 소켓을 모르는 판정과 JSON-RPC 처리만 담는다.
//!
//! 기준은 옛 서버(SDK 1.32.1 + hono, `mcp-http-server-legacy.ts`)다. 차등 시험(`mcp-http-server-differential.test.ts`)이 같은 요청에 같은 상태·본문인지 견준다.
//!
//! 맡는 것: POST 본문 검사(Accept·Content-Type·JSON·JSON-RPC 꼴·배치 상한·프로토콜 버전), `initialize`·`ping`·`tools/list`·`tools/call` 분배,
//! 도구 인자 검사(`zodShape` 규칙: 모르는 키를 지우고, 정수는 JS 안전 정수만 받고, enum은 대소문자를 가린다), 도구 목록의 JSON Schema.
//! 맡지 않는 것: 도구 목록을 얻는 일과 도구 실행(TS 콜백).
//!
//! JSON은 `bstudio_guard::js_json::parse_lone_encoded`로 읽는다(serde_json은 `JSON.parse`와 받는 입력이 다르다: 짝 없는 서로게이트, 중복 키, 큰 수).
//! 글자는 `encodeLoneSurrogates`한 꼴(짝 없는 서로게이트 = U+E010 + 니블 셋, 글자 그대로의 예약 글자 = U+E011 + 니블 둘)로 다루고,
//! 응답을 쓰는 자리(`decode_encoded`)에서만 `\ud800` 이스케이프와 원래 글자로 되돌린다. 그래서 값이 경계에서 합쳐지지 않는다.
//!
//! 호출부마다 막는 쪽인지 여는 쪽인지: 여기 판정은 모두 막는 쪽이다(모르는 꼴은 거절). 단 `initialize` 검사는 SDK가 느슨한 것(capabilities 안쪽)을 같이 느슨하게 둔다.
//!
//! 의도한 차이(모두 거절 쪽이거나 같은 거절의 글만 다르다)
//! - `capabilities` 안쪽의 값 형식은 알려진 키가 객체인지만 본다(SDK는 안쪽 필드까지 zod로 검사한다)
//! - 너무 깊은 JSON(`MAX_DEPTH`를 넘는)은 `Parse error: Invalid JSON-RPC message`로 거절한다(JS는 읽는다. 깊은 `params`를 가진 맞는 메시지만 옛 서버는 받았다)
//! - 같은 id의 요청이 한 배치에 둘이면 옛 서버처럼 첫 응답만 쓰고 스트림을 닫는다(SDK는 응답을 id로 묶는다). 둘째 요청의 도구 실행은 옛 서버처럼 일어난다
//! - 도구 목록을 얻지 못하면(콜백 오류) 500이다(옛 서버는 처리되지 않은 거절로 프로세스가 죽을 수 있었다)

use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsObject, JsValue};

pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
/// 배치 하나에 받는 메시지 수의 상한(SDK의 `MAX_BATCH_SIZE`)
pub const MAX_BATCH_SIZE: usize = 100;
/// JS의 안전한 정수 상한(zod 4 `.int()`)
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
/// `Object.prototype`의 속성 이름. SDK는 도구를 `{}`에서 `[이름]`으로 찾아서 이 이름들은 "없다"가 아니라 "꺼져 있다"로 거절한다
const OBJECT_PROTOTYPE_NAMES: [&str; 12] =
    ["constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString"];

// ───────────────────────── 글자 ─────────────────────────

/// 요청 본문 바이트를 JS 문자열처럼 읽는다: `TextDecoder('utf-8')`(앞의 BOM을 지우고 잘못된 바이트는 U+FFFD)로 풀고,
/// 글자 그대로의 예약 글자(U+E000..U+E01F)는 인코딩해서 짝 없는 서로게이트의 인코딩과 섞이지 않게 한다
pub fn decode_body_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let text = String::from_utf8_lossy(bytes);
    if !text.chars().any(|c| ('\u{E000}'..='\u{E01F}').contains(&c)) {
        return text.into_owned();
    }
    text.chars().map(js::encode_reserved_char).collect()
}

/// 인코딩한 글자를 쓸 글자로 되돌린다: 짝 없는 서로게이트는 JSON 이스케이프(`\ud800`, 소문자 16진)로, 글자 그대로의 예약 글자는 그 글자로.
/// JSON 문서 전체에 쓴다(이스케이프는 문자열 안에서만 나온다: 인코딩한 글자는 문자열의 내용에서만 왔다)
pub fn decode_encoded(text: &str) -> String {
    if !text.contains(['\u{E010}', '\u{E011}']) {
        return text.to_owned();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        match js::read_lone_escape(&chars, i) {
            Some((Err(unit), used)) => {
                out.push_str(&format!("\\u{unit:04x}"));
                i += used;
            }
            Some((Ok(c), used)) => {
                out.push(c);
                i += used;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// `JSON.stringify(문자열)`. 인코딩한 글자는 그대로 두고(`decode_encoded`가 되돌린다)
fn quote(text: &str) -> String {
    js::json_quote(text)
}

// ───────────────────────── 오류 메시지 ─────────────────────────

/// `createJsonErrorResponse`의 본문. 응답 상태는 부르는 쪽이 정한다
pub fn http_error_body(code: i32, message: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","error":{{"code":{code},"message":{}}},"id":null}}"#, quote(message))
}

pub const NOT_ACCEPTABLE_POST: &str = "Not Acceptable: Client must accept both application/json and text/event-stream";
pub const NOT_ACCEPTABLE_GET: &str = "Not Acceptable: Client must accept text/event-stream";
pub const UNSUPPORTED_MEDIA_TYPE: &str = "Unsupported Media Type: Content-Type must be application/json";
pub const METHOD_NOT_ALLOWED: &str = "Method not allowed.";
pub const PARSE_ERROR_JSON: &str = "Parse error: Invalid JSON";
pub const PARSE_ERROR_MESSAGE: &str = "Parse error: Invalid JSON-RPC message";

pub fn payload_too_large(max: usize) -> String {
    format!("Payload Too Large: Request body must not exceed {max} bytes")
}

/// `mcp-protocol-version` 헤더가 있는데 지원하는 버전이 아니면 거절 글
pub fn protocol_version_error(header: Option<&str>) -> Option<String> {
    let version = header?;
    if SUPPORTED_PROTOCOL_VERSIONS.contains(&version) {
        return None;
    }
    Some(format!("Bad Request: Unsupported protocol version: {version} (supported versions: {})", SUPPORTED_PROTOCOL_VERSIONS.join(", ")))
}

// ───────────────────────── Accept·Content-Type ─────────────────────────

/// `acceptHeader.includes(...)`. 대소문자를 가리고 부분 문자열로 본다(SDK가 그렇다)
pub fn accepts(header: Option<&str>, needles: &[&str]) -> bool {
    header.is_some_and(|value| needles.iter().all(|needle| value.contains(needle)))
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "!#$%&'*+.^_`|~-".contains(c)
}

/// `content-type` 패키지(1.0.5)의 `parse`가 던지지 않는가. 헤더는 latin1로 읽은 글이다
fn content_type_parses(header: &str) -> bool {
    let chars: Vec<char> = header.chars().collect();
    let semi = chars.iter().position(|c| *c == ';');
    let type_part: String = chars[..semi.unwrap_or(chars.len())].iter().collect();
    let type_text = js::trim(&type_part);
    let Some((kind, subtype)) = type_text.split_once('/') else { return false };
    if kind.is_empty() || subtype.is_empty() || !kind.chars().all(is_token_char) || !subtype.chars().all(is_token_char) {
        return false;
    }
    let Some(mut at) = semi else { return true };
    while at < chars.len() {
        match param_end(&chars, at) {
            Some(end) => at = end,
            None => return false,
        }
    }
    true
}

/// `; *토큰 *= *(따옴표 문자열|토큰) *`을 `at`에서 읽고 끝 자리를 돌려준다
fn param_end(chars: &[char], at: usize) -> Option<usize> {
    let mut i = at;
    if chars.get(i) != Some(&';') {
        return None;
    }
    i += 1;
    let spaces = |mut i: usize| {
        while chars.get(i) == Some(&' ') {
            i += 1;
        }
        i
    };
    i = spaces(i);
    let key_start = i;
    while chars.get(i).is_some_and(|c| is_token_char(*c)) {
        i += 1;
    }
    if i == key_start {
        return None;
    }
    i = spaces(i);
    if chars.get(i) != Some(&'=') {
        return None;
    }
    i = spaces(i + 1);
    if chars.get(i) == Some(&'"') {
        i += 1;
        loop {
            match chars.get(i).copied() {
                Some('"') => {
                    i += 1;
                    break;
                }
                Some('\\') => {
                    let next = chars.get(i + 1).copied()?;
                    if next != '\u{b}' && !('\u{20}'..='\u{ff}').contains(&next) {
                        return None;
                    }
                    i += 2;
                }
                Some(c) if c == '\u{b}' || c == '\u{20}' || c == '\u{21}' || ('\u{23}'..='\u{5b}').contains(&c) || ('\u{5d}'..='\u{7e}').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c) => i += 1,
                _ => return None,
            }
        }
    } else {
        let value_start = i;
        while chars.get(i).is_some_and(|c| is_token_char(*c)) {
            i += 1;
        }
        if i == value_start {
            return None;
        }
    }
    Some(spaces(i))
}

/// SDK의 `isJsonContentType`: `application/json`(대소문자 무시, 매개변수는 있어도 된다). 값이 둘 이상 이어 붙은 모호한 꼴은 맞지 않는다
pub fn is_json_content_type(header: Option<&str>) -> bool {
    let Some(header) = header else { return false };
    if header == "application/json" {
        return true;
    }
    if header.is_empty() {
        return false;
    }
    let before = header.split(';').next().unwrap_or("");
    let essence = js::trim(before).to_ascii_lowercase();
    if essence != "application/json" {
        return false;
    }
    if content_type_parses(header) {
        return true;
    }
    // 파싱이 던지면 SDK는 `;` 앞의 글자로 판단하되 `essence.length` 뒤 꼬리에 쉼표가 있으면(헤더가 이어 붙은 흔적) 맞지 않는다고 본다
    !header.chars().skip(essence.chars().count()).any(|c| c == ',')
}

// ───────────────────────── JSON-RPC 메시지 ─────────────────────────

fn is_safe_int(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE
}

fn is_request_id(value: &JsValue) -> bool {
    match value {
        JsValue::Str(_) => true,
        JsValue::Num(n) => is_safe_int(*n),
        _ => false,
    }
}

const RELATED_TASK_KEY: &str = "io.modelcontextprotocol/related-task";

/// `_meta`: 객체이고, `progressToken`은 문자열이나 정수, 관련 작업 메타는 `taskId`가 문자열인 객체
fn meta_valid(meta: &JsValue) -> bool {
    let JsValue::Obj(object) = meta else { return false };
    if let Some(token) = object.get("progressToken") {
        if !is_request_id(token) {
            return false;
        }
    }
    match object.get(RELATED_TASK_KEY) {
        None => true,
        Some(JsValue::Obj(task)) => matches!(task.get("taskId"), Some(JsValue::Str(_))),
        Some(_) => false,
    }
}

/// 요청·알림의 `params`: 없거나, `_meta`가 맞는 객체
fn params_valid(params: Option<&JsValue>) -> bool {
    match params {
        None => true,
        Some(JsValue::Obj(object)) => object.get("_meta").is_none_or(meta_valid),
        Some(_) => false,
    }
}

fn keys_within(object: &JsObject, allowed: &[&str]) -> bool {
    object.entries().iter().all(|(key, _)| allowed.contains(&key.as_str()))
}

#[derive(Debug, Clone, PartialEq)]
pub enum MessageKind {
    Request,
    Notification,
    Response,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub kind: MessageKind,
    pub id: Option<JsValue>,
    pub method: Option<String>,
    pub params: Option<JsValue>,
}

/// SDK의 `JSONRPCMessageSchema`(요청·알림·성공 응답·오류 응답의 합집합, 모두 strict). 맞지 않으면 `None`
pub fn parse_message(value: &JsValue) -> Option<Message> {
    let JsValue::Obj(object) = value else { return None };
    if object.get("jsonrpc") != Some(&JsValue::Str("2.0".to_owned())) {
        return None;
    }
    let method = match object.get("method") {
        Some(JsValue::Str(method)) => Some(method.clone()),
        Some(_) => return None,
        None => None,
    };
    if let Some(method) = method {
        let params = object.get("params");
        if !params_valid(params) {
            return None;
        }
        return match object.get("id") {
            Some(id) if is_request_id(id) && keys_within(object, &["jsonrpc", "id", "method", "params"]) => {
                Some(Message { kind: MessageKind::Request, id: Some(id.clone()), method: Some(method), params: params.cloned() })
            }
            None if keys_within(object, &["jsonrpc", "method", "params"]) => Some(Message { kind: MessageKind::Notification, id: None, method: Some(method), params: params.cloned() }),
            _ => None,
        };
    }
    if let Some(result) = object.get("result") {
        let ok = is_request_id(object.get("id")?) && keys_within(object, &["jsonrpc", "id", "result"]) && matches!(result, JsValue::Obj(r) if r.get("_meta").is_none_or(meta_valid));
        return ok.then(|| Message { kind: MessageKind::Response, id: object.get("id").cloned(), method: None, params: None });
    }
    if let Some(JsValue::Obj(error)) = object.get("error") {
        let id_ok = object.get("id").is_none_or(is_request_id);
        let error_ok = matches!(error.get("code"), Some(JsValue::Num(n)) if is_safe_int(*n)) && matches!(error.get("message"), Some(JsValue::Str(_)));
        return (id_ok && error_ok && keys_within(object, &["jsonrpc", "id", "error"])).then(|| Message { kind: MessageKind::Response, id: object.get("id").cloned(), method: None, params: None });
    }
    None
}

// ───────────────────────── zod 이슈 ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Seg {
    Key(String),
    Index(usize),
}

/// zod 4의 이슈 하나(여기서는 글만 쓴다). `expected`는 `invalid_type`일 때만 있다
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub expected: Option<&'static str>,
    pub path: Vec<Seg>,
    pub message: String,
}

/// zod의 `parsedType`
fn received(value: Option<&JsValue>) -> &'static str {
    match value {
        None => "undefined",
        Some(JsValue::Null) => "null",
        Some(JsValue::Bool(_)) => "boolean",
        Some(JsValue::Num(n)) if n.is_nan() => "nan",
        Some(JsValue::Num(_)) => "number",
        Some(JsValue::Str(_)) => "string",
        Some(JsValue::Arr(_)) => "array",
        Some(JsValue::Obj(_)) => "object",
    }
}

fn invalid_type(expected: &'static str, got: Option<&JsValue>, path: Vec<Seg>) -> Issue {
    Issue { expected: Some(expected), path, message: format!("Invalid input: expected {expected}, received {}", received(got)) }
}

fn key(name: &str) -> Seg {
    Seg::Key(name.to_owned())
}

/// `JSON.stringify(issues, null, 2)`. 요청 단계 이슈는 모두 `invalid_type`이다(`expected`·`code`·`path`·`message` 차례)
pub fn zod_error_message(issues: &[Issue]) -> String {
    let mut out = String::from("[\n");
    for (n, issue) in issues.iter().enumerate() {
        if n > 0 {
            out.push_str(",\n");
        }
        out.push_str("  {\n");
        out.push_str(&format!("    \"expected\": {},\n", quote(issue.expected.unwrap_or(""))));
        out.push_str("    \"code\": \"invalid_type\",\n");
        if issue.path.is_empty() {
            out.push_str("    \"path\": [],\n");
        } else {
            out.push_str("    \"path\": [\n");
            let segs: Vec<String> = issue
                .path
                .iter()
                .map(|seg| match seg {
                    Seg::Key(name) => format!("      {}", quote(name)),
                    Seg::Index(i) => format!("      {i}"),
                })
                .collect();
            out.push_str(&segs.join(",\n"));
            out.push_str("\n    ],\n");
        }
        out.push_str(&format!("    \"message\": {}\n", quote(&issue.message)));
        out.push_str("  }");
    }
    out.push_str("\n]");
    out
}

fn params_object<'a>(params: Option<&'a JsValue>, issues: &mut Vec<Issue>) -> Option<&'a JsObject> {
    match params {
        Some(JsValue::Obj(object)) => Some(object),
        other => {
            issues.push(invalid_type("object", other, vec![key("params")]));
            None
        }
    }
}

/// `InitializeRequestSchema`의 `params`: `protocolVersion` 문자열, `capabilities` 객체, `clientInfo`(`name`·`version` 문자열). capabilities 안쪽은 알려진 키가 객체인지만 본다
fn initialize_issues(params: Option<&JsValue>) -> Vec<Issue> {
    let mut issues = Vec::new();
    let Some(object) = params_object(params, &mut issues) else { return issues };
    let field = |name: &str| object.get(name);
    if !matches!(field("protocolVersion"), Some(JsValue::Str(_))) {
        issues.push(invalid_type("string", field("protocolVersion"), vec![key("params"), key("protocolVersion")]));
    }
    match field("capabilities") {
        Some(JsValue::Obj(capabilities)) => {
            for name in ["experimental", "sampling", "elicitation", "roots", "tasks"] {
                if let Some(inner) = capabilities.get(name) {
                    if !matches!(inner, JsValue::Obj(_)) {
                        issues.push(invalid_type("object", Some(inner), vec![key("params"), key("capabilities"), key(name)]));
                    }
                }
            }
        }
        other => issues.push(invalid_type("object", other, vec![key("params"), key("capabilities")])),
    }
    match field("clientInfo") {
        Some(JsValue::Obj(info)) => {
            for name in ["name", "version"] {
                if !matches!(info.get(name), Some(JsValue::Str(_))) {
                    issues.push(invalid_type("string", info.get(name), vec![key("params"), key("clientInfo"), key(name)]));
                }
            }
        }
        other => issues.push(invalid_type("object", other, vec![key("params"), key("clientInfo")])),
    }
    issues
}

/// SDK의 `isInitializeRequest`: 메서드가 `initialize`이고 `params`가 맞다(요청이든 알림이든)
fn is_initialize(message: &Message) -> bool {
    message.method.as_deref() == Some("initialize") && initialize_issues(message.params.as_ref()).is_empty()
}

// ───────────────────────── POST 본문 → 처리할 요청 ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct RpcRequest {
    pub id: JsValue,
    pub method: String,
    pub params: Option<JsValue>,
}

#[derive(Debug, PartialEq)]
pub enum PostPlan {
    /// 이 상태와 JSON-RPC 오류 본문으로 거절한다
    Reject { status: u16, code: i32, message: String },
    /// 요청이 없다(알림·응답만): 202, 본문 없음
    Accepted,
    /// 이 요청들에 SSE로 답한다
    Requests(Vec<RpcRequest>),
}

fn reject(status: u16, code: i32, message: &str) -> PostPlan {
    PostPlan::Reject { status, code, message: message.to_owned() }
}

/// 본문 바이트(상한 안)를 읽어 처리 계획을 세운다. SDK `handlePostRequest`의 본문 이후 순서와 같다:
/// JSON → 배치 상한 → 메시지 꼴 → 초기화 요청 확인 → 프로토콜 버전 → 요청 유무
pub fn plan_post(body: &[u8], protocol_version: Option<&str>) -> PostPlan {
    let text = decode_body_text(body);
    let raw = match js_json::parse_lone_encoded(&text) {
        Ok(raw) => raw,
        // 읽을 수 있는 깊이를 넘은 JSON은 JS는 읽는다. 그런 문서의 맨 위는 거의 모두 JSON-RPC 메시지가 아니라서 옛 서버가 내던 글로 거절한다
        // (깊은 `params`를 가진 맞는 메시지는 옛 서버가 받았고 여기서는 거절한다: 거절 쪽 차이)
        Err(js_json::LoneParseError::TooDeep) => return reject(400, -32700, PARSE_ERROR_MESSAGE),
        Err(js_json::LoneParseError::Invalid) => return reject(400, -32700, PARSE_ERROR_JSON),
    };
    let items: Vec<&JsValue> = match &raw {
        JsValue::Arr(items) => {
            if items.len() > MAX_BATCH_SIZE {
                return reject(400, -32600, &format!("Invalid Request: Batch must not exceed {MAX_BATCH_SIZE} messages"));
            }
            items.iter().collect()
        }
        other => vec![other],
    };
    let mut messages = Vec::with_capacity(items.len());
    for item in items {
        match parse_message(item) {
            Some(message) => messages.push(message),
            None => return reject(400, -32700, PARSE_ERROR_MESSAGE),
        }
    }
    let initializing = messages.iter().any(is_initialize);
    if initializing {
        if messages.len() > 1 {
            return reject(400, -32600, "Invalid Request: Only one initialization request is allowed");
        }
    } else if let Some(message) = protocol_version_error(protocol_version) {
        return reject(400, -32000, &message);
    }
    let requests: Vec<RpcRequest> = messages
        .into_iter()
        .filter(|message| message.kind == MessageKind::Request)
        .filter_map(|message| Some(RpcRequest { id: message.id?, method: message.method?, params: message.params }))
        .collect();
    if requests.is_empty() {
        PostPlan::Accepted
    } else {
        PostPlan::Requests(requests)
    }
}

// ───────────────────────── 응답 메시지 ─────────────────────────

fn id_json(id: &JsValue) -> String {
    js_json::stringify(id)
}

/// 응답을 요청에 묶는 열쇠. SDK는 요청 id를 `Map`의 열쇠로 쓴다(`1`과 `1.0`과 `-0`·`0`은 같고 `1`과 `"1"`은 다르다)
pub fn id_key(id: &JsValue) -> String {
    id_json(id)
}

fn result_message(id: &str, result: &str) -> String {
    format!(r#"{{"result":{result},"jsonrpc":"2.0","id":{id}}}"#)
}

fn error_message(id: &str, code: i32, message: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":{}}}}}"#, quote(message))
}

/// SSE 이벤트 하나(`event: message`). 인코딩한 글자는 `decode_encoded`로 되돌려 쓴다
pub fn sse_event(message: &str) -> String {
    format!("event: message\ndata: {}\n\n", decode_encoded(message))
}

// ───────────────────────── 도구 ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum FieldKind {
    Str,
    Enum(Vec<String>),
    Int,
    Bool,
    StrList,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub key: String,
    pub kind: FieldKind,
    pub description: Option<String>,
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: Option<String>,
    pub fields: Vec<Field>,
}

/// `z.enum(값들)`이 쓰는 값: 중복을 빼고, 정수 꼴 이름이 먼저 오름차순이다(`Object.values`의 순서)
fn enum_values(values: Vec<String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for value in values {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    let mut ints: Vec<(u32, String)> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    for value in unique {
        match js_json::array_index(&value) {
            Some(index) => ints.push((index, value)),
            None => rest.push(value),
        }
    }
    ints.sort_by_key(|(index, _)| *index);
    ints.into_iter().map(|(_, value)| value).chain(rest).collect()
}

/// TS가 `JSON.stringify`한 도구 목록(`[{name, description?, input_schema}]`)을 `zodShape`와 같은 규칙으로 읽는다.
/// 지원하지 않는 형식이면 이유를 돌려준다(TS가 먼저 `zodShape`로 걸러서 보통 닿지 않는다)
pub fn parse_tools(text: &str, honor_required: bool) -> Result<Vec<Tool>, String> {
    let value = js_json::parse_lone_encoded(text).map_err(|_| "도구 목록을 읽지 못했습니다".to_owned())?;
    let JsValue::Arr(items) = value else { return Err("도구 목록이 배열이 아닙니다".to_owned()) };
    let mut tools = Vec::with_capacity(items.len());
    for item in &items {
        let name = item.prop("name").and_then(JsValue::as_str).ok_or("도구 이름이 없습니다")?.to_owned();
        let description = item.prop("description").and_then(JsValue::as_str).map(str::to_owned);
        let schema = item.prop("input_schema");
        let required: Option<Vec<String>> = match schema.and_then(|s| s.prop("required")) {
            Some(JsValue::Arr(list)) => Some(list.iter().map(JsValue::to_js_string).collect()),
            _ => None,
        };
        let mut fields = Vec::new();
        if let Some(JsValue::Obj(properties)) = schema.and_then(|s| s.prop("properties")) {
            for (key, spec) in properties.entries_js_order() {
                let kind_name = spec.prop("type").and_then(JsValue::as_str);
                let enum_list = match spec.prop("enum") {
                    Some(JsValue::Arr(list)) if !list.is_empty() => Some(list),
                    _ => None,
                };
                let kind = match (kind_name, enum_list) {
                    (Some("string"), Some(list)) => FieldKind::Enum(enum_values(list.iter().map(JsValue::to_js_string).collect())),
                    (Some("string"), None) => FieldKind::Str,
                    (Some("integer"), _) => FieldKind::Int,
                    (Some("boolean"), _) => FieldKind::Bool,
                    (Some("array"), _) if spec.prop("items").and_then(|items| items.prop("type")).and_then(JsValue::as_str) == Some("string") => FieldKind::StrList,
                    _ => return Err(format!("지원하지 않는 도구 입력 형식입니다: {key}")),
                };
                let description = spec.prop("description").and_then(JsValue::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
                let optional = honor_required && required.as_ref().is_some_and(|required| !required.iter().any(|name| name == key));
                fields.push(Field { key: key.to_owned(), kind, description, optional });
            }
        }
        tools.push(Tool { name, description, fields });
    }
    Ok(tools)
}

fn field_schema(field: &Field) -> String {
    let inner = match &field.kind {
        FieldKind::Str => r#""type":"string""#.to_owned(),
        FieldKind::Enum(values) => format!(r#""type":"string","enum":[{}]"#, values.iter().map(|value| quote(value)).collect::<Vec<_>>().join(",")),
        FieldKind::Int => format!(r#""type":"integer","minimum":-{0},"maximum":{0}"#, MAX_SAFE as u64),
        FieldKind::Bool => r#""type":"boolean""#.to_owned(),
        FieldKind::StrList => r#""type":"array","items":{"type":"string"}"#.to_owned(),
    };
    match (&field.description, field.optional) {
        // `.optional().describe(...)`의 설명은 감싼 쪽에 붙어 안쪽 앞에 온다. `.describe(...)`만이면 뒤에 온다
        (Some(description), true) => format!(r#"{{"description":{},{inner}}}"#, quote(description)),
        (Some(description), false) => format!(r#"{{{inner},"description":{}}}"#, quote(description)),
        (None, _) => format!("{{{inner}}}"),
    }
}

fn tool_json(tool: &Tool) -> String {
    let properties: Vec<String> = tool.fields.iter().map(|field| format!("{}:{}", quote(&field.key), field_schema(field))).collect();
    let required: Vec<String> = tool.fields.iter().filter(|field| !field.optional).map(|field| quote(&field.key)).collect();
    let required = if required.is_empty() { String::new() } else { format!(r#","required":[{}]"#, required.join(",")) };
    let description = tool.description.as_ref().map_or(String::new(), |text| format!(r#","description":{}"#, quote(text)));
    format!(
        r#"{{"name":{}{description},"inputSchema":{{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{{{}}}{required}}},"execution":{{"taskSupport":"forbidden"}}}}"#,
        quote(&tool.name),
        properties.join(",")
    )
}

/// `tools/list`의 결과
pub fn tools_list_result(tools: &[Tool]) -> String {
    format!(r#"{{"tools":[{}]}}"#, tools.iter().map(tool_json).collect::<Vec<_>>().join(","))
}

fn dot_path(path: &[Seg]) -> String {
    let mut out = String::new();
    for (n, seg) in path.iter().enumerate() {
        match seg {
            Seg::Key(name) if n == 0 => out.push_str(name),
            Seg::Key(name) => {
                out.push('.');
                out.push_str(name);
            }
            Seg::Index(i) if n == 0 => out.push_str(&i.to_string()),
            Seg::Index(i) => out.push_str(&format!("[{i}]")),
        }
    }
    out
}

/// 도구 인자를 `zodShape`의 객체 스키마로 검사한다. 통과하면 모르는 키를 지운 값(스키마 순서의 키만, 없는 선택 인자는 빠진다)을,
/// 아니면 SDK와 같은 글의 이슈 목록을 돌려준다. `args`가 없으면(`undefined`·`null` 처리는 SDK가 `?? {}`) 빈 객체다
pub fn validate_args(tool: &Tool, args: Option<&JsObject>) -> Result<JsObject, Vec<Issue>> {
    let mut issues = Vec::new();
    let mut kept = JsObject::new();
    for field in &tool.fields {
        let value = args.and_then(|args| args.get(&field.key));
        let path = || vec![Seg::Key(field.key.clone())];
        let Some(value) = value else {
            if !field.optional {
                issues.push(match &field.kind {
                    FieldKind::Str => invalid_type("string", None, path()),
                    // 열거형이 빠졌을 때 SDK의 글은 "Invalid option: ..."이다(값이 없는 것도 목록에 없는 값이다)
                    FieldKind::Enum(values) => Issue { expected: None, path: path(), message: enum_message(values) },
                    FieldKind::Int => invalid_type("number", None, path()),
                    FieldKind::Bool => invalid_type("boolean", None, path()),
                    FieldKind::StrList => invalid_type("array", None, path()),
                });
            }
            continue;
        };
        let before = issues.len();
        match &field.kind {
            FieldKind::Str => {
                if !matches!(value, JsValue::Str(_)) {
                    issues.push(invalid_type("string", Some(value), path()));
                }
            }
            FieldKind::Enum(values) => {
                if !matches!(value, JsValue::Str(text) if values.contains(text)) {
                    issues.push(Issue { expected: None, path: path(), message: enum_message(values) });
                }
            }
            FieldKind::Bool => {
                if !matches!(value, JsValue::Bool(_)) {
                    issues.push(invalid_type("boolean", Some(value), path()));
                }
            }
            FieldKind::Int => match value {
                JsValue::Num(n) if n.is_finite() => {
                    if n.fract() != 0.0 {
                        issues.push(Issue { expected: Some("int"), path: path(), message: "Invalid input: expected int, received number".to_owned() });
                    } else if *n > MAX_SAFE {
                        issues.push(Issue { expected: None, path: path(), message: format!("Too big: expected int to be <={}", MAX_SAFE as u64) });
                    } else if *n < -MAX_SAFE {
                        issues.push(Issue { expected: None, path: path(), message: format!("Too small: expected int to be >=-{}", MAX_SAFE as u64) });
                    }
                }
                // 무한대는 zod의 number가 받지 않는다(글에 "Infinity"·"-Infinity"로 적는다)
                JsValue::Num(n) => issues.push(Issue { expected: Some("number"), path: path(), message: format!("Invalid input: expected number, received {}", if *n > 0.0 { "Infinity" } else { "-Infinity" }) }),
                other => issues.push(invalid_type("number", Some(other), path())),
            },
            FieldKind::StrList => match value {
                JsValue::Arr(items) => {
                    for (index, item) in items.iter().enumerate() {
                        if !matches!(item, JsValue::Str(_)) {
                            issues.push(invalid_type("string", Some(item), vec![Seg::Key(field.key.clone()), Seg::Index(index)]));
                        }
                    }
                }
                other => issues.push(invalid_type("array", Some(other), path())),
            },
        }
        if issues.len() == before {
            kept.set(&field.key, value.clone());
        }
    }
    if issues.is_empty() {
        Ok(kept)
    } else {
        Err(issues)
    }
}

fn enum_message(values: &[String]) -> String {
    format!("Invalid option: expected one of {}", values.iter().map(|value| quote(value)).collect::<Vec<_>>().join("|"))
}

/// `getParseErrorMessage`: 이슈마다 `글 at 경로`, 줄바꿈으로 잇는다
pub fn issues_message(issues: &[Issue]) -> String {
    issues.iter().map(|issue| if issue.path.is_empty() { issue.message.clone() } else { format!("{} at {}", issue.message, dot_path(&issue.path)) }).collect::<Vec<_>>().join("\n")
}

// ───────────────────────── 요청 분배 ─────────────────────────

pub struct ServerInfo<'a> {
    pub name: &'a str,
}

/// 한 요청의 처리 단계. `Call`은 TS 콜백을 기다려야 하는 도구 실행이다
pub enum Step {
    Done(String),
    Call { id: String, name: String, args: String },
}

fn is_tools_method(method: &str) -> bool {
    matches!(method, "tools/list" | "tools/call")
}

/// 이 요청들이 도구 목록을 필요로 하는가(`initialize`는 capabilities가 도구 유무에 따른다)
pub fn needs_tools(requests: &[RpcRequest]) -> bool {
    requests.iter().any(|request| request.method == "initialize" || is_tools_method(&request.method))
}

/// 요청 하나를 한 단계 처리한다. `tools`는 이 HTTP 요청에서 한 번 읽은 목록(필요 없는 요청이면 `None`일 수 있다)
pub fn handle_request(request: &RpcRequest, tools: Option<&[Tool]>, server: &ServerInfo) -> Step {
    let id = id_json(&request.id);
    let tools = tools.unwrap_or(&[]);
    // McpServer는 도구를 등록해야 tools 핸들러와 capabilities를 단다
    let has_tools = !tools.is_empty();
    match request.method.as_str() {
        "ping" => Step::Done(result_message(&id, "{}")),
        "initialize" => {
            let issues = initialize_issues(request.params.as_ref());
            if !issues.is_empty() {
                return Step::Done(error_message(&id, -32603, &zod_error_message(&issues)));
            }
            let requested = request.params.as_ref().and_then(|params| params.prop("protocolVersion")).and_then(JsValue::as_str).unwrap_or("");
            let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) { requested } else { LATEST_PROTOCOL_VERSION };
            let capabilities = if has_tools { r#"{"tools":{"listChanged":true}}"# } else { "{}" };
            Step::Done(result_message(&id, &format!(r#"{{"protocolVersion":"{version}","capabilities":{capabilities},"serverInfo":{{"name":{},"version":"0.0.0"}}}}"#, quote(server.name))))
        }
        "tools/list" if has_tools => {
            if let Some(JsValue::Obj(params)) = &request.params {
                if let Some(cursor) = params.get("cursor") {
                    if !matches!(cursor, JsValue::Str(_)) {
                        let issue = invalid_type("string", Some(cursor), vec![key("params"), key("cursor")]);
                        return Step::Done(error_message(&id, -32603, &zod_error_message(&[issue])));
                    }
                }
            }
            Step::Done(result_message(&id, &tools_list_result(tools)))
        }
        "tools/call" if has_tools => call_tool(&id, request.params.as_ref(), tools),
        _ => Step::Done(error_message(&id, -32601, "Method not found")),
    }
}

fn call_tool(id: &str, params: Option<&JsValue>, tools: &[Tool]) -> Step {
    // `params.task`가 맞는 꼴이면 SDK는 스키마 검사보다 먼저 작업 생성 지원 여부를 묻고 거절한다
    if let Some(JsValue::Obj(object)) = params {
        if let Some(JsValue::Obj(task)) = object.get("task") {
            if task.get("ttl").is_none_or(|ttl| matches!(ttl, JsValue::Num(n) if n.is_finite())) {
                return Step::Done(error_message(id, -32603, "Server does not support task creation (required for tools/call)"));
            }
        }
    }
    let mut issues = Vec::new();
    let Some(object) = params_object(params, &mut issues) else { return Step::Done(error_message(id, -32603, &zod_error_message(&issues))) };
    match object.get("task") {
        None => {}
        // 맞는 꼴(ttl이 없거나 수)이면 위에서 이미 답했다. 여기까지 왔으면 ttl이 수가 아니다
        Some(JsValue::Obj(task)) => {
            if let Some(ttl) = task.get("ttl") {
                issues.push(invalid_type("number", Some(ttl), vec![key("params"), key("task"), key("ttl")]));
            }
        }
        Some(other) => issues.push(invalid_type("object", Some(other), vec![key("params"), key("task")])),
    }
    let name = match object.get("name") {
        Some(JsValue::Str(name)) => Some(name.as_str()),
        other => {
            issues.push(invalid_type("string", other, vec![key("params"), key("name")]));
            None
        }
    };
    let arguments = match object.get("arguments") {
        None => None,
        Some(JsValue::Obj(arguments)) => Some(arguments),
        Some(other) => {
            issues.push(invalid_type("record", Some(other), vec![key("params"), key("arguments")]));
            None
        }
    };
    let Some(name) = name.filter(|_| issues.is_empty()) else { return Step::Done(error_message(id, -32603, &zod_error_message(&issues))) };

    let tool_error = |text: String| Step::Done(result_message(id, &tool_error_result(&text)));
    let Some(tool) = tools.iter().find(|tool| tool.name == name) else {
        // SDK는 도구를 `{}`에서 `[이름]`으로 찾는다: `Object.prototype`의 이름은 "없다"가 아니라 "꺼져 있다"가 된다
        let reason = if OBJECT_PROTOTYPE_NAMES.contains(&name) { "disabled" } else { "not found" };
        return tool_error(format!("MCP error -32602: Tool {name} {reason}"));
    };
    match validate_args(tool, arguments) {
        Ok(kept) => Step::Call { id: id.to_owned(), name: name.to_owned(), args: js_json::to_native(&JsValue::Obj(kept)) },
        Err(issues) => tool_error(format!("MCP error -32602: Input validation error: Invalid arguments for tool {name}: {}", issues_message(&issues))),
    }
}

fn tool_error_result(text: &str) -> String {
    format!(r#"{{"content":[{{"type":"text","text":{}}}],"isError":true}}"#, quote(text))
}

/// TS 콜백이 돌려준 도구 결과
pub struct ToolReply {
    pub ok: bool,
    pub content: String,
    pub images: Vec<(String, String)>,
}

/// `tools/call`의 결과 메시지: `content: [{type:'text', text}, ...이미지]`, `isError: !ok`
pub fn call_result_message(id: &str, reply: &ToolReply) -> String {
    let mut content = format!(r#"{{"type":"text","text":{}}}"#, quote(&reply.content));
    for (data, mime_type) in &reply.images {
        content.push_str(&format!(r#",{{"type":"image","data":{},"mimeType":{}}}"#, quote(data), quote(mime_type)));
    }
    result_message(id, &format!(r#"{{"content":[{content}],"isError":{}}}"#, !reply.ok))
}

/// 도구 목록을 얻지 못했을 때 HTTP 500의 본문
pub fn internal_error_body(message: &str) -> String {
    http_error_body(-32603, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools(honor: bool) -> Vec<Tool> {
        parse_tools(
            r#"[{"name":"a_tool","description":"Desc A","input_schema":{"type":"object","properties":{"path":{"type":"string","description":"p"},"n":{"type":"integer"},"mode":{"type":"string","enum":["x","y"],"description":"m"},"flag":{"type":"boolean"},"list":{"type":"array","items":{"type":"string"}},"opt":{"type":"string"}},"required":["path","n"]}}]"#,
            honor,
        )
        .unwrap()
    }

    fn args(text: &str) -> JsObject {
        match js_json::parse_lone_encoded(text).unwrap() {
            JsValue::Obj(object) => object,
            other => panic!("객체가 아닙니다: {other:?}"),
        }
    }

    fn message_of(result: Result<JsObject, Vec<Issue>>) -> String {
        issues_message(&result.unwrap_err())
    }

    #[test]
    fn 도구_목록의_스키마는_sdk가_낸_json과_같다() {
        // 옛 서버(SDK 1.32.1)에서 실제로 받은 글(honorRequired를 껐을 때와 켰을 때)
        let off = r#"{"tools":[{"name":"a_tool","description":"Desc A","inputSchema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"path":{"type":"string","description":"p"},"n":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"mode":{"type":"string","enum":["x","y"],"description":"m"},"flag":{"type":"boolean"},"list":{"type":"array","items":{"type":"string"}},"opt":{"type":"string"}},"required":["path","n","mode","flag","list","opt"]},"execution":{"taskSupport":"forbidden"}}]}"#;
        assert_eq!(tools_list_result(&tools(false)), off);
        let on = tools_list_result(&tools(true));
        assert!(on.contains(r#""mode":{"description":"m","type":"string","enum":["x","y"]}"#), "{on}");
        assert!(on.contains(r#""required":["path","n"]}"#), "{on}");
    }

    #[test]
    fn 인자_검사는_타입과_필수와_enum_대소문자와_정수_범위를_본다() {
        let tool = &tools(true)[0];
        assert_eq!(message_of(validate_args(tool, Some(&args("{}")))), "Invalid input: expected string, received undefined at path\nInvalid input: expected number, received undefined at n");
        assert_eq!(
            message_of(validate_args(tool, Some(&args(r#"{"path":1,"n":"a","mode":"z","flag":"no","list":[1],"opt":null}"#)))),
            "Invalid input: expected string, received number at path\nInvalid input: expected number, received string at n\nInvalid option: expected one of \"x\"|\"y\" at mode\nInvalid input: expected boolean, received string at flag\nInvalid input: expected string, received number at list[0]\nInvalid input: expected string, received null at opt"
        );
        assert_eq!(message_of(validate_args(tool, Some(&args(r#"{"path":"p","n":1.5}"#)))), "Invalid input: expected int, received number at n");
        assert_eq!(message_of(validate_args(tool, Some(&args(r#"{"path":"p","n":9007199254740992}"#)))), "Too big: expected int to be <=9007199254740991 at n");
        assert_eq!(message_of(validate_args(tool, Some(&args(r#"{"path":"p","n":-9007199254740992}"#)))), "Too small: expected int to be >=-9007199254740991 at n");
        assert_eq!(message_of(validate_args(tool, Some(&args(r#"{"path":"p","n":1,"mode":"X"}"#)))), "Invalid option: expected one of \"x\"|\"y\" at mode");
        // 경계 값과 1.0, -0은 정수다
        for n in ["9007199254740991", "-9007199254740991", "1.0", "-0", "1e2"] {
            assert!(validate_args(tool, Some(&args(&format!(r#"{{"path":"p","n":{n}}}"#)))).is_ok(), "{n}");
        }
        // 문자열 "1"·1e300은 거절이다
        for n in [r#""1""#, "1e300", "1e999"] {
            assert!(validate_args(tool, Some(&args(&format!(r#"{{"path":"p","n":{n}}}"#)))).is_err(), "{n}");
        }
    }

    #[test]
    fn 검사를_통과한_인자는_모르는_키를_지운다() {
        let tool = &tools(true)[0];
        let kept = validate_args(tool, Some(&args(r#"{"extra":1,"path":"p","n":1,"mode":"x","zzz":[1]}"#))).unwrap();
        assert_eq!(js_json::to_native(&JsValue::Obj(kept)), r#"{"path":"p","n":1,"mode":"x"}"#);
        // 선택 인자가 빠지면 키도 없다(honorRequired)
        assert!(validate_args(&tools(true)[0], Some(&args(r#"{"path":"p","n":1}"#))).unwrap().get("opt").is_none());
        // 켜지 않으면 모든 인자가 필수다
        assert!(validate_args(&tools(false)[0], Some(&args(r#"{"path":"p","n":1}"#))).is_err());
    }

    #[test]
    fn 중복_키는_뒤_값이_이긴다() {
        let tool = &tools(true)[0];
        let kept = validate_args(tool, Some(&args(r#"{"path":1,"path":"p","n":1}"#))).unwrap();
        assert_eq!(kept.get("path"), Some(&JsValue::Str("p".into())));
    }

    #[test]
    fn content_type은_sdk처럼_읽는다() {
        for yes in ["application/json", "Application/JSON", "application/json; charset=utf-8", "application/json;charset=utf-8", " application/json ", "application/json; charset", "application/json;", r#"application/json; a="b,c""#] {
            assert!(is_json_content_type(Some(yes)), "{yes}");
        }
        for no in ["", "text/plain", "application/jsonx", "application/json, text/plain", "application/json; a=b, c=d", "application/json, application/json", "application/ json"] {
            assert!(!is_json_content_type(Some(no)), "{no}");
        }
        assert!(!is_json_content_type(None));
    }

    #[test]
    fn 본문은_json_꼴과_배치_상한과_프로토콜_버전을_차례로_본다() {
        let plan = |body: &str, version: Option<&str>| plan_post(body.as_bytes(), version);
        assert_eq!(plan("{", None), reject(400, -32700, PARSE_ERROR_JSON));
        assert_eq!(plan("", None), reject(400, -32700, PARSE_ERROR_JSON));
        assert_eq!(plan(r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#, None), reject(400, -32700, PARSE_ERROR_MESSAGE));
        assert_eq!(plan(r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#, None), reject(400, -32700, PARSE_ERROR_MESSAGE));
        assert_eq!(plan(r#"{"jsonrpc":"2.0","id":1,"method":"ping","x":1}"#, None), reject(400, -32700, PARSE_ERROR_MESSAGE));
        assert_eq!(plan(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, None), PostPlan::Accepted);
        assert_eq!(plan("[]", None), PostPlan::Accepted);
        assert!(matches!(plan(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, None), PostPlan::Requests(_)));
        // 지원하지 않는 버전은 초기화 요청이 아니면 거절이다
        assert!(matches!(plan(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, Some("1999")), PostPlan::Reject { status: 400, code: -32000, .. }));
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}"#;
        assert!(matches!(plan(init, Some("1999")), PostPlan::Requests(_)));
        let batch: Vec<String> = (0..101).map(|id| format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"ping"}}"#)).collect();
        assert!(matches!(plan(&format!("[{}]", batch.join(",")), None), PostPlan::Reject { status: 400, code: -32600, .. }));
        assert!(matches!(plan(&format!("[{}]", batch[..100].join(",")), None), PostPlan::Requests(r) if r.len() == 100));
        assert!(matches!(plan(&format!("[{init},{}]", batch[0]), None), PostPlan::Reject { status: 400, code: -32600, .. }));
    }

    #[test]
    fn 본문_글자는_bom을_지우고_잘못된_바이트는_u_fffd로_읽는다() {
        assert_eq!(decode_body_text(b"\xEF\xBB\xBF{}"), "{}");
        assert_eq!(decode_body_text(b"a\xffb"), "a\u{FFFD}b");
        assert!(matches!(plan_post(b"\xEF\xBB\xBF{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}", None), PostPlan::Requests(_)));
    }

    #[test]
    fn 짝_없는_서로게이트와_예약_글자는_합쳐지지_않고_원래대로_돌아온다() {
        // 본문의 `\ud800` 이스케이프는 인코딩으로 읽히고, 응답을 쓸 때 다시 이스케이프가 된다
        let plan = plan_post(br#"{"jsonrpc":"2.0","id":"\ud800","method":"ping"}"#, None);
        let PostPlan::Requests(requests) = plan else { panic!("요청이어야 합니다") };
        let Step::Done(message) = handle_request(&requests[0], None, &ServerInfo { name: "n" }) else { panic!("끝나야 합니다") };
        assert_eq!(sse_event(&message), "event: message\ndata: {\"result\":{},\"jsonrpc\":\"2.0\",\"id\":\"\\ud800\"}\n\n");
        // 글자 그대로의 U+E010은 인코딩한 서로게이트와 다르다
        let literal = decode_body_text("\u{E010}\u{E008}\u{E000}\u{E000}".as_bytes());
        assert_ne!(literal, "\u{E010}\u{E008}\u{E000}\u{E000}");
        assert_eq!(decode_encoded(&literal), "\u{E010}\u{E008}\u{E000}\u{E000}");
    }

    #[test]
    fn 모르는_도구와_검사_실패는_iserror_결과이고_prototype_이름은_꺼져_있다고_답한다() {
        let list = tools(true);
        let request = |params: &str| RpcRequest { id: JsValue::Num(1.0), method: "tools/call".into(), params: Some(js_json::parse_lone_encoded(params).unwrap()) };
        let text = |step: Step| match step {
            Step::Done(message) => message,
            Step::Call { .. } => "CALL".to_owned(),
        };
        let server = ServerInfo { name: "n" };
        let unknown = text(handle_request(&request(r#"{"name":"nope","arguments":{}}"#), Some(&list), &server));
        assert_eq!(unknown, r#"{"result":{"content":[{"type":"text","text":"MCP error -32602: Tool nope not found"}],"isError":true},"jsonrpc":"2.0","id":1}"#);
        assert!(text(handle_request(&request(r#"{"name":"__proto__","arguments":{}}"#), Some(&list), &server)).contains("Tool __proto__ disabled"));
        assert!(text(handle_request(&request(r#"{"name":"a_tool","arguments":{}}"#), Some(&list), &server)).contains("Input validation error: Invalid arguments for tool a_tool: "));
        assert_eq!(text(handle_request(&request(r#"{"name":"a_tool","arguments":{"path":"p","n":1,"x":2}}"#), Some(&list), &server)), "CALL");
        // arguments가 객체가 아니면 JSON-RPC 오류(-32603)다
        assert!(text(handle_request(&request(r#"{"name":"a_tool","arguments":null}"#), Some(&list), &server)).contains(r#""code":-32603"#));
        assert!(text(handle_request(&request(r#"{"name":"a_tool","arguments":[1]}"#), Some(&list), &server)).contains("expected record, received array"));
    }

    #[test]
    fn 도구_이름과_enum_값의_근접값은_맞지_않는다() {
        let list = tools(true);
        let server = ServerInfo { name: "n" };
        let step = |params: String| match handle_request(&RpcRequest { id: JsValue::Num(1.0), method: "tools/call".into(), params: Some(js_json::parse_lone_encoded(&params).unwrap()) }, Some(&list), &server) {
            Step::Done(message) => message,
            Step::Call { .. } => "CALL".to_owned(),
        };
        // 도구 이름은 글자 그대로 같아야 한다(대소문자·앞뒤 공백·전각·접두·접미)
        for name in ["A_TOOL", "a_Tool", " a_tool", "a_tool ", "ａ_tool", "a_too", "a_tool_x"] {
            let message = step(format!(r#"{{"name":{},"arguments":{{"path":"p","n":1}}}}"#, quote(name)));
            assert!(message.contains("not found") && message.contains(r#""isError":true"#), "{name}: {message}");
        }
        // enum 값도 글자 그대로 같아야 한다
        for value in ["X", " x", "x ", "ｘ", "x\u{0}", "xy", ""] {
            let message = step(format!(r#"{{"name":"a_tool","arguments":{{"path":"p","n":1,"mode":{}}}}}"#, quote(value)));
            assert!(message.contains("Invalid option") && message.contains(r#""isError":true"#), "{value:?}: {message}");
        }
        assert_eq!(step(r#"{"name":"a_tool","arguments":{"path":"p","n":1,"mode":"x"}}"#.to_owned()), "CALL");
    }

    #[test]
    fn 알려진_메서드와_모르는_메서드() {
        let server = ServerInfo { name: "b-studio" };
        let run = |method: &str, tools: Option<&[Tool]>| match handle_request(&RpcRequest { id: JsValue::Str("x".into()), method: method.into(), params: None }, tools, &server) {
            Step::Done(message) => message,
            Step::Call { .. } => "CALL".into(),
        };
        assert_eq!(run("ping", None), r#"{"result":{},"jsonrpc":"2.0","id":"x"}"#);
        assert_eq!(run("foo/bar", None), r#"{"jsonrpc":"2.0","id":"x","error":{"code":-32601,"message":"Method not found"}}"#);
        // 도구가 없으면 tools/list도 모르는 메서드다(McpServer가 도구를 등록해야 핸들러를 단다)
        assert!(run("tools/list", Some(&[])).contains("Method not found"));
        assert!(run("tools/list", Some(&tools(true))).starts_with(r#"{"result":{"tools":["#));
    }

    #[test]
    fn initialize는_프로토콜_버전을_협상하고_서버_정보를_준다() {
        let server = ServerInfo { name: "b-studio" };
        let init = |version: &str, tools: Option<&[Tool]>| {
            let params = js_json::parse_lone_encoded(&format!(r#"{{"protocolVersion":"{version}","capabilities":{{}},"clientInfo":{{"name":"c","version":"1"}}}}"#)).unwrap();
            match handle_request(&RpcRequest { id: JsValue::Num(1.0), method: "initialize".into(), params: Some(params) }, tools, &server) {
                Step::Done(message) => message,
                Step::Call { .. } => unreachable!(),
            }
        };
        assert_eq!(init("2025-03-26", Some(&tools(true))), r#"{"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"b-studio","version":"0.0.0"}},"jsonrpc":"2.0","id":1}"#);
        assert!(init("1999", Some(&tools(true))).contains(r#""protocolVersion":"2025-11-25""#));
        assert!(init("2025-03-26", Some(&[])).contains(r#""capabilities":{}"#));
    }

    #[test]
    fn 도구_결과는_text와_image_콘텐츠와_iserror로_쓴다() {
        let reply = ToolReply { ok: false, content: "글".into(), images: vec![("QUJD".into(), "image/png".into())] };
        assert_eq!(call_result_message("1", &reply), r#"{"result":{"content":[{"type":"text","text":"글"},{"type":"image","data":"QUJD","mimeType":"image/png"}],"isError":true},"jsonrpc":"2.0","id":1}"#);
    }

    #[test]
    fn enum_값은_중복을_빼고_정수_꼴_이름을_앞에_둔다() {
        assert_eq!(enum_values(vec!["b".into(), "2".into(), "1".into(), "b".into(), "a".into()]), vec!["1", "2", "b", "a"]);
    }

    #[test]
    fn 무한대와_너무_깊은_json은_옛_서버가_내던_글로_거절한다() {
        let tool = &tools(true)[0];
        assert_eq!(message_of(validate_args(tool, Some(&args(r#"{"path":"p","n":1e999}"#)))), "Invalid input: expected number, received Infinity at n");
        assert_eq!(message_of(validate_args(tool, Some(&args(r#"{"path":"p","n":-1e999}"#)))), "Invalid input: expected number, received -Infinity at n");
        let deep = format!("{}{}", "[".repeat(5000), "]".repeat(5000));
        assert_eq!(plan_post(deep.as_bytes(), None), reject(400, -32700, PARSE_ERROR_MESSAGE));
    }

    #[test]
    fn 요청_id는_js_안전_정수만_받는다() {
        let plan = |id: &str| plan_post(format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"ping"}}"#).as_bytes(), None);
        for ok in ["9007199254740991", "-9007199254740991", "0", "-0", "1.0", "1e2", r#""x""#] {
            assert!(matches!(plan(ok), PostPlan::Requests(_)), "{ok}");
        }
        for bad in ["9007199254740992", "-9007199254740992", "1.5", "1e999", "null", "true", "[1]", "{}"] {
            assert_eq!(plan(bad), reject(400, -32700, PARSE_ERROR_MESSAGE), "{bad}");
        }
    }
}
