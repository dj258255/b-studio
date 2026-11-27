//! OpenAPI 문서로 만드는 속성 시험(알림 전용, ADR-240). 문서의 GET 연산에 스키마가 허용하는 입력을 시드 기반으로 만들고,
//! 응답이 문서와 어긋나는지 본다. **판정(통과·실패)을 바꾸지 않는다** — 돌려주는 것은 알림 글뿐이다.
//!
//! 이 모듈은 순수 함수만 둔다(요청 보내기는 `bstudio-io`의 `gate_declared`가 한다).
//! - `plan`: 문서 → 보낼 요청 목록과 건너뛴 연산(이유 포함). 같은 문서·같은 시드면 같은 요청이다.
//! - `Tally::record`: 응답 하나를 문서의 해당 상태 코드 응답 스키마와 견주어 알림을 모은다.
//! - `Tally::report`: 알림 글. 건너뛴 연산과 상한에 걸려 보지 못한 것의 개수를 반드시 적는다(조용히 건너뛰지 않는다).
//!
//! 막는 검사가 아니라 "더 보는" 쪽이다. 그래도 모르는 입력은 **건너뜀(이유)** 이나 **확인하지 못함**으로 세고 통과처럼 쓰지 않는다.
//! 요청 대상은 늘 `/`로 시작하는 한 줄 경로(+쿼리)다. 점 구간(`.`·`..`)·`//`·역슬래시가 있으면 그 연산을 건너뛴다.

use crate::js_json::{self, JsObject, JsValue};
use regex::Regex;

pub const DEFAULT_MAX_OPERATIONS: usize = 20;
pub const MAX_OPERATIONS: usize = 100;
pub const DEFAULT_MAX_REQUESTS: usize = 50;
pub const MAX_REQUESTS: usize = 500;
/// 연산 하나에 만드는 요청 수(서로 다른 것만)
pub const REQUESTS_PER_OPERATION: usize = 3;
/// 시드를 적지 않았을 때 쓰는 값. 정해 두어야 두 번 돌려도 같은 요청이다
pub const DEFAULT_SEED: u64 = 1;

const MAX_REF_HOPS: usize = 8;
const MAX_GEN_DEPTH: usize = 4;
const MAX_VALIDATE_DEPTH: usize = 8;
const MAX_ARRAY_CHECK: usize = 20;
const MAX_LISTED: usize = 10;
/// 이보다 큰 응답 본문은 읽지 않고 "확인하지 못함"으로 센다
const MAX_BODY_BYTES: usize = 1_000_000;

pub struct Limits {
    pub max_operations: usize,
    pub max_requests: usize,
    pub seed: u64,
}

pub struct PlannedRequest {
    /// 알림에 적는 이름(`GET /pets/{id}`)
    pub label: String,
    /// 문서의 `paths` 키(응답 스키마를 찾는 열쇠)
    pub path_key: String,
    /// 서비스 위의 경로와 쿼리(`/pets/12?limit=3`)
    pub target: String,
}

pub struct Skip {
    pub label: String,
    pub reason: String,
}

#[derive(Default)]
pub struct Planned {
    pub requests: Vec<PlannedRequest>,
    pub skipped: Vec<Skip>,
    /// 문서에서 읽은 GET 연산 수 / 그중 이번에 본(상한 안) 수
    pub operations_total: usize,
    pub operations_seen: usize,
    /// 요청 수 상한에 걸려 요청을 만들지 못한 연산 수
    pub cut_by_requests: usize,
    /// 문서 전체를 다룰 수 없는 이유(Swagger 2.0, paths 없음 등)
    pub unsupported: Option<String>,
}

// ── PRNG ────────────────────────────────────────────────────────────────

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
    fn range_i(&mut self, lo: i64, hi: i64) -> i64 {
        let span = (hi as i128 - lo as i128 + 1).max(1) as u128;
        (lo as i128 + (self.next() as u128 % span) as i128) as i64
    }
    fn chance(&mut self, one_in: u64) -> bool {
        self.below(one_in) == 0
    }
}

fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

// ── $ref ────────────────────────────────────────────────────────────────

fn lookup<'a>(doc: &'a JsValue, reference: &str) -> Result<&'a JsValue, String> {
    let Some(pointer) = reference.strip_prefix("#/") else { return Err("문서 밖 $ref".to_owned()) };
    let mut node = doc;
    for raw in pointer.split('/') {
        let key = raw.replace("~1", "/").replace("~0", "~");
        node = match node {
            JsValue::Obj(object) => object.get(&key),
            JsValue::Arr(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
            _ => None,
        }
        .ok_or_else(|| format!("$ref 대상 없음({reference})"))?;
    }
    Ok(node)
}

fn resolve<'a>(doc: &'a JsValue, mut node: &'a JsValue) -> Result<&'a JsValue, String> {
    for _ in 0..MAX_REF_HOPS {
        match node.prop("$ref") {
            Some(JsValue::Str(reference)) => node = lookup(doc, reference)?,
            _ => return Ok(node),
        }
    }
    Err("$ref가 순환하거나 너무 깁니다".to_owned())
}

fn truthy_prop(node: &JsValue, key: &str) -> bool {
    matches!(node.prop(key), Some(JsValue::Bool(true)))
}

/// `allOf`를 한 겹 합친 스키마(뒤의 것이 앞을 덮는다). 속성·required는 합친다
fn merged(doc: &JsValue, schema: &JsValue) -> Result<JsValue, String> {
    let Some(JsValue::Arr(parts)) = schema.prop("allOf") else { return Ok(schema.clone()) };
    let mut out = JsObject::new();
    let mut properties = JsObject::new();
    let mut required: Vec<JsValue> = Vec::new();
    let mut sources: Vec<JsValue> = Vec::new();
    for part in parts {
        sources.push(resolve(doc, part)?.clone());
    }
    sources.push(schema.clone());
    for source in &sources {
        let JsValue::Obj(object) = source else { continue };
        for (key, value) in object.entries() {
            match key.as_str() {
                "allOf" => {}
                "properties" => {
                    if let JsValue::Obj(props) = value {
                        for (name, prop) in props.entries() {
                            properties.set(name, prop.clone());
                        }
                    }
                }
                "required" => {
                    if let JsValue::Arr(names) = value {
                        required.extend(names.iter().cloned());
                    }
                }
                _ => out.set(key, value.clone()),
            }
        }
    }
    if !properties.entries().is_empty() {
        out.set("properties", JsValue::Obj(properties));
    }
    if !required.is_empty() {
        out.set("required", JsValue::Arr(required));
    }
    Ok(JsValue::Obj(out))
}

// ── 값 만들기 ───────────────────────────────────────────────────────────

const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

fn number_bound(schema: &JsValue, key: &str) -> Option<f64> {
    match schema.prop(key) {
        Some(JsValue::Num(n)) => Some(*n),
        _ => None,
    }
}

/// 스키마 한 겹을 읽은 타입. `type`이 배열이면 null이 아닌 첫 항목
fn schema_type(schema: &JsValue) -> Option<String> {
    match schema.prop("type") {
        Some(JsValue::Str(name)) => Some(name.clone()),
        Some(JsValue::Arr(names)) => names.iter().filter_map(JsValue::as_str).find(|name| *name != "null").map(str::to_owned),
        _ => {
            if schema.prop("properties").is_some() {
                Some("object".to_owned())
            } else if schema.prop("items").is_some() {
                Some("array".to_owned())
            } else if schema.prop("minimum").is_some() || schema.prop("maximum").is_some() {
                Some("number".to_owned())
            } else if schema.prop("minLength").is_some() || schema.prop("maxLength").is_some() || schema.prop("pattern").is_some() || schema.prop("format").is_some() {
                Some("string".to_owned())
            } else {
                None
            }
        }
    }
}

fn scalar_text(value: &JsValue) -> Option<String> {
    match value {
        JsValue::Str(text) => Some(text.clone()),
        JsValue::Num(_) | JsValue::Bool(_) => Some(value.to_js_string()),
        _ => None,
    }
}

fn random_text(rng: &mut Rng, len: usize) -> String {
    (0..len).map(|_| ALPHABET[rng.below(ALPHABET.len() as u64) as usize] as char).collect()
}

fn gen_scalar(doc: &JsValue, raw: &JsValue, rng: &mut Rng, depth: usize, min_len_floor: usize) -> Result<String, String> {
    if depth > MAX_GEN_DEPTH {
        return Err("스키마가 너무 깊습니다".to_owned());
    }
    let resolved = resolve(doc, raw)?;
    let schema = merged(doc, resolved)?;
    if schema.prop("not").is_some() {
        return Err("not 스키마".to_owned());
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(JsValue::Arr(options)) = schema.prop(key) {
            if depth >= 2 {
                return Err("깊은 oneOf/anyOf".to_owned());
            }
            if options.is_empty() {
                return Err("빈 oneOf/anyOf".to_owned());
            }
            let chosen = resolve(doc, &options[rng.below(options.len() as u64) as usize])?;
            if chosen.prop("oneOf").is_some() || chosen.prop("anyOf").is_some() {
                return Err("깊은 oneOf/anyOf".to_owned());
            }
            return gen_scalar(doc, chosen, rng, depth + 1, min_len_floor);
        }
    }
    if let Some(constant) = schema.prop("const") {
        return scalar_text(constant).ok_or_else(|| "const가 스칼라가 아닙니다".to_owned());
    }
    if let Some(JsValue::Arr(values)) = schema.prop("enum") {
        if values.is_empty() {
            return Err("빈 enum".to_owned());
        }
        return scalar_text(&values[rng.below(values.len() as u64) as usize]).ok_or_else(|| "enum 값이 스칼라가 아닙니다".to_owned());
    }
    match schema_type(&schema).as_deref() {
        Some("boolean") => Ok(if rng.chance(2) { "true" } else { "false" }.to_owned()),
        Some("integer") => {
            let mut lo = number_bound(&schema, "minimum").map(|n| n.ceil());
            let mut hi = number_bound(&schema, "maximum").map(|n| n.floor());
            match schema.prop("exclusiveMinimum") {
                Some(JsValue::Num(n)) => lo = Some(lo.map_or(n.floor() + 1.0, |l| l.max(n.floor() + 1.0))),
                Some(JsValue::Bool(true)) => lo = lo.map(|l| l + 1.0),
                _ => {}
            }
            match schema.prop("exclusiveMaximum") {
                Some(JsValue::Num(n)) => hi = Some(hi.map_or(n.ceil() - 1.0, |h| h.min(n.ceil() - 1.0))),
                Some(JsValue::Bool(true)) => hi = hi.map(|h| h - 1.0),
                _ => {}
            }
            let (lo, hi) = match (lo, hi) {
                (Some(l), Some(h)) => (l, h),
                (Some(l), None) => (l, l + 10_000.0),
                (None, Some(h)) => ((h - 10_000.0).max(0.0).min(h), h),
                (None, None) => (0.0, 10_000.0),
            };
            if lo > hi || lo.abs() > 1e15 || hi.abs() > 1e15 {
                return Err("정수 범위를 만들 수 없습니다".to_owned());
            }
            let (lo, hi) = (lo as i64, hi as i64);
            // 경계 값을 자주 시험한다
            let value = match rng.below(4) {
                0 => lo,
                1 => hi,
                _ => rng.range_i(lo, hi),
            };
            Ok(value.to_string())
        }
        Some("number") => {
            let mut lo = number_bound(&schema, "minimum");
            let mut hi = number_bound(&schema, "maximum");
            if let Some(JsValue::Num(n)) = schema.prop("exclusiveMinimum") {
                lo = Some(n + 0.01);
            }
            if let Some(JsValue::Num(n)) = schema.prop("exclusiveMaximum") {
                hi = Some(n - 0.01);
            }
            let (lo, hi) = match (lo, hi) {
                (Some(l), Some(h)) => (l, h),
                (Some(l), None) => (l, l + 1000.0),
                (None, Some(h)) => (h - 1000.0, h),
                (None, None) => (0.0, 1000.0),
            };
            if lo > hi || !lo.is_finite() || !hi.is_finite() {
                return Err("숫자 범위를 만들 수 없습니다".to_owned());
            }
            let value = match rng.below(4) {
                0 => lo,
                1 => hi,
                _ => lo + (rng.next() as f64 / u64::MAX as f64) * (hi - lo),
            };
            let value = (value * 100.0).round() / 100.0;
            let value = value.clamp(lo, hi);
            Ok(js_json::JsValue::Num(value).to_js_string())
        }
        Some("string") => gen_string(&schema, rng, min_len_floor),
        Some("object") => Err("객체 값".to_owned()),
        Some("array") => Err("중첩 배열".to_owned()),
        Some(other) => Err(format!("지원하지 않는 type({other})")),
        None => Err("type을 알 수 없습니다".to_owned()),
    }
}

fn gen_string(schema: &JsValue, rng: &mut Rng, min_len_floor: usize) -> Result<String, String> {
    let min = number_bound(schema, "minLength").map_or(0, |n| n.max(0.0) as usize).max(min_len_floor);
    // format이 있으면 그 꼴의 길이(uuid 36자 등)를 받도록 기본 상한을 넓힌다
    let default_max = if schema.prop("format").is_some() { (min + 12).max(40) } else { min + 12 };
    let max = number_bound(schema, "maxLength").map_or(default_max, |n| n.max(0.0) as usize).min(64);
    if min > max {
        return Err("문자열 길이 범위를 만들 수 없습니다".to_owned());
    }
    if let Some(JsValue::Str(pattern)) = schema.prop("pattern") {
        let text = gen_pattern(pattern, rng, max)?;
        let length = text.chars().count();
        if length < min || length > max {
            return Err("pattern과 길이 제한을 함께 맞출 수 없습니다".to_owned());
        }
        return Ok(text);
    }
    if let Some(JsValue::Str(format)) = schema.prop("format") {
        let text = match format.as_str() {
            "date" => Some(random_date(rng)),
            "date-time" => Some(format!("{}T{:02}:{:02}:{:02}Z", random_date(rng), rng.below(24), rng.below(60), rng.below(60))),
            "uuid" => {
                let (a, b) = (rng.next(), rng.next());
                Some(format!("{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}", (a >> 32) as u32, (a >> 16) as u16, (a & 0xfff) as u16, (b >> 52) as u16 & 0xfff, b & 0xffff_ffff_ffff))
            }
            "email" => Some(format!("user{}@example.com", rng.below(1000))),
            "uri" | "url" => Some(format!("https://example.com/p{}", rng.below(1000))),
            "hostname" => Some(format!("host{}.example.com", rng.below(1000))),
            "ipv4" => Some(format!("10.{}.{}.{}", rng.below(256), rng.below(256), rng.below(256))),
            _ => None,
        };
        if let Some(text) = text {
            let length = text.chars().count();
            if length < min || length > max {
                return Err(format!("format({format})과 길이 제한을 함께 맞출 수 없습니다"));
            }
            return Ok(text);
        }
    }
    let length = min + rng.below((max - min + 1) as u64) as usize;
    Ok(random_text(rng, length))
}

fn random_date(rng: &mut Rng) -> String {
    format!("{:04}-{:02}-{:02}", 2000 + rng.below(31), 1 + rng.below(12), 1 + rng.below(28))
}

/// 단순한 pattern만 만든다: `^`·`$`(선택) + (문자 집합·`\d`·`\w`·글자 하나) + 수량자(`+`·`*`·`?`·`{n}`·`{n,m}`)의 연속
fn gen_pattern(pattern: &str, rng: &mut Rng, max_len: usize) -> Result<String, String> {
    let unsupported = || "단순하지 않은 pattern".to_owned();
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    if chars.first() == Some(&'^') {
        index = 1;
    }
    let mut end = chars.len();
    if end > index && chars[end - 1] == '$' && !(end >= 2 && chars[end - 2] == '\\') {
        end -= 1;
    }
    let digits: Vec<char> = ('0'..='9').collect();
    let word: Vec<char> = ('a'..='z').chain('A'..='Z').chain('0'..='9').chain(['_']).collect();
    let mut out = String::new();
    let mut tokens = 0;
    while index < end {
        tokens += 1;
        if tokens > 16 {
            return Err(unsupported());
        }
        let set: Vec<char> = match chars[index] {
            '[' => {
                let close = chars[index..end].iter().position(|c| *c == ']').ok_or_else(unsupported)? + index;
                let body = &chars[index + 1..close];
                if body.first() == Some(&'^') || body.is_empty() {
                    return Err(unsupported());
                }
                let mut set = Vec::new();
                let mut i = 0;
                while i < body.len() {
                    let mut c = body[i];
                    if c == '\\' {
                        i += 1;
                        c = *body.get(i).ok_or_else(unsupported)?;
                        match c {
                            'd' => set.extend(digits.iter().copied()),
                            'w' => set.extend(word.iter().copied()),
                            '.' | '-' | '_' | '/' | '\\' | '[' | ']' => set.push(c),
                            _ => return Err(unsupported()),
                        }
                        i += 1;
                        continue;
                    }
                    if i + 2 < body.len() && body[i + 1] == '-' {
                        let (from, to) = (c, body[i + 2]);
                        if from > to || !from.is_ascii() || !to.is_ascii() {
                            return Err(unsupported());
                        }
                        set.extend(from..=to);
                        i += 3;
                    } else {
                        if !c.is_ascii() {
                            return Err(unsupported());
                        }
                        set.push(c);
                        i += 1;
                    }
                }
                index = close + 1;
                set
            }
            '\\' => {
                let escaped = *chars.get(index + 1).filter(|_| index + 1 < end).ok_or_else(unsupported)?;
                index += 2;
                match escaped {
                    'd' => digits.clone(),
                    'w' => word.clone(),
                    '.' | '-' | '/' | '_' => vec![escaped],
                    _ => return Err(unsupported()),
                }
            }
            c if c.is_ascii_alphanumeric() || c == '_' || c == '-' => {
                index += 1;
                vec![c]
            }
            _ => return Err(unsupported()),
        };
        let (mut lo, mut hi) = (1usize, 1usize);
        if index < end {
            match chars[index] {
                '+' => (lo, hi, index) = (1, 8, index + 1),
                '*' => (lo, hi, index) = (0, 8, index + 1),
                '?' => (lo, hi, index) = (0, 1, index + 1),
                '{' => {
                    let close = chars[index..end].iter().position(|c| *c == '}').ok_or_else(unsupported)? + index;
                    let body: String = chars[index + 1..close].iter().collect();
                    let mut parts = body.splitn(2, ',');
                    let first: usize = parts.next().unwrap_or("").trim().parse().map_err(|_| unsupported())?;
                    lo = first;
                    hi = match parts.next() {
                        None => first,
                        Some(second) if second.trim().is_empty() => first + 8,
                        Some(second) => second.trim().parse().map_err(|_| unsupported())?,
                    };
                    if hi < lo || hi > 64 {
                        return Err(unsupported());
                    }
                    index = close + 1;
                }
                _ => {}
            }
        }
        let hi = hi.min(max_len.max(lo));
        let count = lo + rng.below((hi - lo + 1) as u64) as usize;
        for _ in 0..count {
            out.push(set[rng.below(set.len() as u64) as usize]);
        }
    }
    // 만든 값이 pattern에 맞는지 다시 본다. 맞지 않으면 만들지 못한 것이다
    match Regex::new(pattern) {
        Ok(re) if re.is_match(&out) => Ok(out),
        _ => Err(unsupported()),
    }
}

fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ── 연산 → 요청 ─────────────────────────────────────────────────────────

struct Param<'a> {
    name: String,
    location: String,
    required: bool,
    node: &'a JsValue,
}

fn collect_params<'a>(doc: &'a JsValue, path_item: &'a JsValue, operation: &'a JsValue) -> Result<Vec<Param<'a>>, String> {
    let mut params: Vec<Param<'a>> = Vec::new();
    for source in [path_item, operation] {
        let Some(JsValue::Arr(items)) = source.prop("parameters") else { continue };
        for item in items {
            let node = resolve(doc, item)?;
            let (Some(JsValue::Str(name)), Some(JsValue::Str(location))) = (node.prop("name"), node.prop("in")) else { return Err("알아볼 수 없는 매개변수".to_owned()) };
            let param = Param { name: name.clone(), location: location.clone(), required: truthy_prop(node, "required") || location == "path", node };
            match params.iter_mut().find(|existing| existing.name == param.name && existing.location == param.location) {
                Some(slot) => *slot = param,
                None => params.push(param),
            }
        }
    }
    Ok(params)
}

fn requires_auth(doc: &JsValue, operation: &JsValue) -> bool {
    match operation.prop("security").or_else(|| doc.prop("security")) {
        Some(JsValue::Arr(requirements)) => {
            !requirements.is_empty() && requirements.iter().all(|requirement| matches!(requirement, JsValue::Obj(object) if !object.entries().is_empty()))
        }
        _ => false,
    }
}

fn base_path(doc: &JsValue) -> String {
    // 서버 주소가 `/api` 같은 상대 경로일 때만 앞에 붙인다. 절대 주소의 호스트로는 가지 않는다
    if let Some(JsValue::Arr(servers)) = doc.prop("servers") {
        if let Some(JsValue::Str(url)) = servers.first().and_then(|server| server.prop("url")) {
            if url.starts_with('/') && !url.starts_with("//") && !url.contains('\\') && !url.contains("{") {
                return url.trim_end_matches('/').to_owned();
            }
        }
    }
    String::new()
}

fn safe_target(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains('\\')
        && !path.contains("%2e")
        && !path.contains("%2E")
        && !path.split(['?', '#']).next().unwrap_or("").split('/').any(|segment| segment == "." || segment == "..")
}

fn build_target(doc: &JsValue, path_key: &str, params: &[Param<'_>], rng: &mut Rng) -> Result<String, String> {
    let mut path = String::new();
    let mut rest = path_key;
    while let Some(open) = rest.find('{') {
        path.push_str(&rest[..open]);
        let close = rest[open..].find('}').ok_or("경로 템플릿이 닫히지 않았습니다")? + open;
        let name = &rest[open + 1..close];
        let param = params.iter().find(|p| p.location == "path" && p.name == name).ok_or_else(|| format!("경로 매개변수 {name}의 선언이 없습니다"))?;
        let schema = param.node.prop("schema").ok_or("content 매개변수")?;
        if let Some(style) = param.node.prop("style").and_then(JsValue::as_str) {
            if style != "simple" {
                return Err(format!("경로 매개변수 style({style})"));
            }
        }
        let value = gen_scalar(doc, schema, rng, 0, 1)?;
        if value.chars().all(|c| c == '.') {
            return Err("점 경로를 뜻하는 경로 값".to_owned());
        }
        path.push_str(&percent_encode(&value));
        rest = &rest[close + 1..];
    }
    path.push_str(rest);
    let mut query: Vec<String> = Vec::new();
    for param in params.iter().filter(|p| p.location == "query") {
        if !param.required && rng.chance(2) {
            continue;
        }
        let schema = param.node.prop("schema").ok_or("content 매개변수")?;
        let resolved = resolve(doc, schema)?;
        let name = percent_encode(&param.name);
        if schema_type(resolved).as_deref() == Some("array") {
            if let Some(style) = param.node.prop("style").and_then(JsValue::as_str) {
                if style != "form" {
                    return Err(format!("쿼리 배열 style({style})"));
                }
            }
            let items = resolved.prop("items").ok_or("items 없는 배열")?;
            let min = number_bound(resolved, "minItems").map_or(0, |n| n.max(0.0) as usize);
            let max = number_bound(resolved, "maxItems").map_or(min.max(3), |n| n.max(0.0) as usize).min(5);
            if min > max {
                return Err("배열 길이 범위를 만들 수 없습니다".to_owned());
            }
            let count = min + rng.below((max - min + 1) as u64) as usize;
            let mut values = Vec::new();
            for _ in 0..count {
                values.push(gen_scalar(doc, items, rng, 1, 0)?);
            }
            let explode = !matches!(param.node.prop("explode"), Some(JsValue::Bool(false)));
            if explode {
                query.extend(values.iter().map(|value| format!("{name}={}", percent_encode(value))));
            } else if !values.is_empty() {
                query.push(format!("{name}={}", values.iter().map(|value| percent_encode(value)).collect::<Vec<_>>().join(",")));
            }
        } else {
            query.push(format!("{name}={}", percent_encode(&gen_scalar(doc, schema, rng, 0, 0)?)));
        }
    }
    let target = if query.is_empty() { path } else { format!("{path}?{}", query.join("&")) };
    let target = format!("{}{target}", base_path(doc));
    if safe_target(&target) { Ok(target) } else { Err("안전하지 않은 경로".to_owned()) }
}

fn plan_operation(doc: &JsValue, path_key: &str, path_item: &JsValue, operation: &JsValue, seed: u64, want: usize) -> Result<Vec<String>, String> {
    if requires_auth(doc, operation) {
        return Err("보안 요구(인증)".to_owned());
    }
    if let Some(body) = operation.prop("requestBody") {
        if truthy_prop(resolve(doc, body)?, "required") {
            return Err("GET이 요청 본문을 요구".to_owned());
        }
    }
    if path_key.split('/').any(|segment| segment == "." || segment == "..") {
        return Err("경로에 점 구간".to_owned());
    }
    let params = collect_params(doc, path_item, operation)?;
    for param in &params {
        match param.location.as_str() {
            "path" | "query" => {}
            "header" | "cookie" => {
                if param.required {
                    return Err(format!("필수 {} 매개변수", if param.location == "header" { "헤더" } else { "쿠키" }));
                }
            }
            _ => return Err("알 수 없는 매개변수 위치".to_owned()),
        }
    }
    let mut rng = Rng(seed ^ fnv1a(&format!("GET {path_key}")));
    let mut targets: Vec<String> = Vec::new();
    for _ in 0..want {
        let target = build_target(doc, path_key, &params, &mut rng)?;
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    Ok(targets)
}

pub fn plan(doc: &JsValue, limits: &Limits) -> Planned {
    let mut planned = Planned::default();
    match doc.prop("openapi") {
        Some(JsValue::Str(version)) if version.starts_with("3.") => {}
        _ => {
            planned.unsupported = Some("OpenAPI 3.x 문서가 아닙니다(Swagger 2.0 등은 다루지 않습니다)".to_owned());
            return planned;
        }
    }
    let Some(JsValue::Obj(paths)) = doc.prop("paths") else {
        planned.unsupported = Some("문서에 paths가 없습니다".to_owned());
        return planned;
    };
    let operations: Vec<(&String, &JsValue, &JsValue)> = paths
        .entries()
        .iter()
        .filter_map(|(key, item)| {
            let item = resolve(doc, item).ok()?;
            item.prop("get").map(|operation| (key, item, operation))
        })
        .collect();
    planned.operations_total = operations.len();
    let eligible_budget = limits.max_requests;
    for (key, item, operation) in operations.into_iter().take(limits.max_operations) {
        planned.operations_seen += 1;
        let label = format!("GET {key}");
        if planned.requests.len() >= eligible_budget {
            planned.cut_by_requests += 1;
            continue;
        }
        let operation = match resolve(doc, operation) {
            Ok(operation) => operation,
            Err(reason) => {
                planned.skipped.push(Skip { label, reason });
                continue;
            }
        };
        match plan_operation(doc, key, item, operation, limits.seed, REQUESTS_PER_OPERATION) {
            Ok(targets) => {
                for target in targets {
                    if planned.requests.len() >= eligible_budget {
                        planned.cut_by_requests += 1;
                        break;
                    }
                    planned.requests.push(PlannedRequest { label: label.clone(), path_key: key.clone(), target });
                }
            }
            Err(reason) => planned.skipped.push(Skip { label, reason }),
        }
    }
    planned
}

// ── 응답 견주기 ─────────────────────────────────────────────────────────

fn kind_of(value: &JsValue) -> &'static str {
    match value {
        JsValue::Null => "null",
        JsValue::Bool(_) => "boolean",
        JsValue::Num(_) => "number",
        JsValue::Str(_) => "string",
        JsValue::Arr(_) => "array",
        JsValue::Obj(_) => "object",
    }
}

enum Mismatch {
    Differs(String),
    Unchecked(String),
}

fn type_matches(name: &str, value: &JsValue) -> bool {
    match name {
        "null" => matches!(value, JsValue::Null),
        "boolean" => matches!(value, JsValue::Bool(_)),
        "string" => matches!(value, JsValue::Str(_)),
        "number" => matches!(value, JsValue::Num(_)),
        "integer" => matches!(value, JsValue::Num(n) if n.fract() == 0.0),
        "array" => matches!(value, JsValue::Arr(_)),
        "object" => matches!(value, JsValue::Obj(_)),
        _ => false,
    }
}

fn validate(doc: &JsValue, raw: &JsValue, value: &JsValue, depth: usize, at: &str) -> Result<(), Mismatch> {
    if depth > MAX_VALIDATE_DEPTH {
        return Err(Mismatch::Unchecked("깊이 상한".to_owned()));
    }
    let resolved = resolve(doc, raw).map_err(Mismatch::Unchecked)?;
    let schema = merged(doc, resolved).map_err(Mismatch::Unchecked)?;
    for key in ["oneOf", "anyOf"] {
        if let Some(JsValue::Arr(options)) = schema.prop(key) {
            let mut unchecked: Option<String> = None;
            for option in options {
                match validate(doc, option, value, depth + 1, at) {
                    Ok(()) => return Ok(()),
                    Err(Mismatch::Unchecked(reason)) => unchecked = Some(reason),
                    Err(Mismatch::Differs(_)) => {}
                }
            }
            return Err(match unchecked {
                Some(reason) => Mismatch::Unchecked(reason),
                None => Mismatch::Differs(format!("{at}: {key}의 어느 선택지와도 맞지 않습니다")),
            });
        }
    }
    if matches!(value, JsValue::Null) && truthy_prop(&schema, "nullable") {
        return Ok(());
    }
    if let Some(JsValue::Arr(allowed)) = schema.prop("enum") {
        if !allowed.iter().any(|item| item == value) {
            return Err(Mismatch::Differs(format!("{at}: 값이 enum에 없습니다")));
        }
    }
    let types: Vec<&str> = match schema.prop("type") {
        Some(JsValue::Str(name)) => vec![name.as_str()],
        Some(JsValue::Arr(names)) => names.iter().filter_map(JsValue::as_str).collect(),
        _ => Vec::new(),
    };
    if !types.is_empty() && !types.iter().any(|name| type_matches(name, value)) {
        return Err(Mismatch::Differs(format!("{at}: {}이어야 하는데 {}입니다", types.join(" 또는 "), kind_of(value))));
    }
    if let JsValue::Obj(object) = value {
        if let Some(JsValue::Arr(required)) = schema.prop("required") {
            for name in required.iter().filter_map(JsValue::as_str) {
                if !object.contains_key(name) {
                    return Err(Mismatch::Differs(format!("{at}: 필수 속성 {name}이 없습니다")));
                }
            }
        }
        if let Some(JsValue::Obj(properties)) = schema.prop("properties") {
            for (name, property) in properties.entries() {
                if let Some(item) = object.get(name) {
                    validate(doc, property, item, depth + 1, &format!("{at}.{name}"))?;
                }
            }
        }
    }
    if let (JsValue::Arr(items), Some(item_schema)) = (value, schema.prop("items")) {
        for (index, item) in items.iter().take(MAX_ARRAY_CHECK).enumerate() {
            validate(doc, item_schema, item, depth + 1, &format!("{at}[{index}]"))?;
        }
    }
    Ok(())
}

#[derive(Default)]
pub struct Tally {
    pub sent: usize,
    server_errors: Vec<String>,
    mismatches: Vec<String>,
    undocumented: Vec<String>,
    undocumented_client: usize,
    unchecked: Vec<(String, usize)>,
    failures: Vec<String>,
}

fn bump(list: &mut Vec<(String, usize)>, reason: &str) {
    match list.iter_mut().find(|(seen, _)| seen == reason) {
        Some(entry) => entry.1 += 1,
        None => list.push((reason.to_owned(), 1)),
    }
}

fn response_entry<'a>(doc: &'a JsValue, path_key: &str, status: u16) -> Option<Result<&'a JsValue, String>> {
    let responses = doc.prop("paths")?.prop(path_key)?.prop("get")?.prop("responses")?;
    let responses = resolve(doc, responses).ok()?;
    let exact = status.to_string();
    let range = format!("{}XX", status / 100);
    let entry = responses.prop(&exact).or_else(|| responses.prop(&range)).or_else(|| responses.prop(&range.to_lowercase())).or_else(|| responses.prop("default"))?;
    Some(resolve(doc, entry))
}

impl Tally {
    /// 응답 하나를 기록한다. 5xx는 알림이고, 문서의 응답 스키마(application/json)와 형이 다르면 알림이다.
    /// 문서에 없는 4xx는 서버가 입력을 검증한 것일 수 있어 알림이 아니라 개수만 센다
    pub fn record(&mut self, doc: &JsValue, request: &PlannedRequest, status: f64, body: &str) {
        self.sent += 1;
        let at = format!("{} → {} ({})", request.label, js_json::JsValue::Num(status).to_js_string(), request.target);
        if !(100.0..600.0).contains(&status) || status.fract() != 0.0 {
            self.mismatches.push(format!("{at}: 상태 코드가 HTTP 범위 밖입니다"));
            return;
        }
        let status = status as u16;
        if status >= 500 {
            self.server_errors.push(at);
            return;
        }
        let entry = match response_entry(doc, &request.path_key, status) {
            None => {
                if (400..500).contains(&status) {
                    self.undocumented_client += 1;
                } else {
                    self.undocumented.push(at);
                }
                return;
            }
            Some(Err(reason)) => {
                bump(&mut self.unchecked, &reason);
                return;
            }
            Some(Ok(entry)) => entry,
        };
        let Some(JsValue::Obj(content)) = entry.prop("content") else { return };
        let Some((_, media)) = content.entries().iter().find(|(name, _)| {
            let lower = name.to_ascii_lowercase();
            lower.starts_with("application/json") || lower.ends_with("+json")
        }) else {
            return;
        };
        let Some(schema) = media.prop("schema") else { return };
        if body.len() > MAX_BODY_BYTES {
            bump(&mut self.unchecked, "본문이 너무 큼");
            return;
        }
        if body.trim().is_empty() {
            if status == 204 || status == 205 {
                return;
            }
            self.mismatches.push(format!("{at}: 본문이 비어 있습니다(문서는 JSON 본문을 적었습니다)"));
            return;
        }
        let value = match js_json::parse(body) {
            Ok(value) => value,
            Err(_) => {
                self.mismatches.push(format!("{at}: 본문이 JSON이 아닙니다"));
                return;
            }
        };
        match validate(doc, schema, &value, 0, "$") {
            Ok(()) => {}
            Err(Mismatch::Differs(text)) => self.mismatches.push(format!("{at}: {text}")),
            Err(Mismatch::Unchecked(reason)) => bump(&mut self.unchecked, &reason),
        }
    }

    /// 요청을 보내지 못했다. 서버가 죽은 것일 수도 있어 알림에 적는다
    pub fn record_failure(&mut self, request: &PlannedRequest, message: &str) {
        self.sent += 1;
        self.failures.push(format!("{} ({}): 요청 실패 — {}", request.label, request.target, message.lines().next().unwrap_or("")));
    }

    pub fn alert_count(&self) -> usize {
        self.server_errors.len() + self.mismatches.len() + self.undocumented.len() + self.failures.len()
    }

    pub fn failure_count(&self) -> usize {
        self.failures.len()
    }

    /// 알림 글. `stopped`는 시간·연속 실패로 멈춘 이유다
    pub fn report(&self, planned: &Planned, limits: &Limits, stopped: Option<&str>) -> String {
        let mut lines: Vec<String> = Vec::new();
        if let Some(reason) = &planned.unsupported {
            lines.push(format!("속성 시험(알림): 확인하지 못함 — {reason}"));
            return lines.join("\n");
        }
        lines.push(format!(
            "속성 시험(알림, 통과·실패 판정에 영향 없음): 연산 {}/{}개에서 요청 {}건을 보냈고 알림은 {}건입니다(시드 {}).",
            planned.operations_seen.saturating_sub(planned.skipped.len()).saturating_sub(planned.cut_by_requests),
            planned.operations_total,
            self.sent,
            self.alert_count(),
            limits.seed
        ));
        let groups: [(&str, &Vec<String>); 4] = [("5xx 응답", &self.server_errors), ("응답 형이 문서와 다름", &self.mismatches), ("문서에 없는 상태 코드", &self.undocumented), ("요청 실패", &self.failures)];
        for (title, items) in groups {
            for item in items.iter().take(MAX_LISTED) {
                lines.push(format!("- {title}: {item}"));
            }
            if items.len() > MAX_LISTED {
                lines.push(format!("- {title}: 외 {}건", items.len() - MAX_LISTED));
            }
        }
        if self.undocumented_client > 0 {
            lines.push(format!("(참고) 문서에 없는 4xx 응답 {}건은 서버가 입력을 검증한 것일 수 있어 알림으로 세지 않았습니다", self.undocumented_client));
        }
        if !self.unchecked.is_empty() {
            let parts: Vec<String> = self.unchecked.iter().map(|(reason, count)| format!("{reason} {count}")).collect();
            lines.push(format!("응답 형을 확인하지 못한 응답: {}", parts.join(", ")));
        }
        if !planned.skipped.is_empty() {
            let mut by_reason: Vec<(String, usize)> = Vec::new();
            for skip in &planned.skipped {
                bump(&mut by_reason, &skip.reason);
            }
            let parts: Vec<String> = by_reason.iter().map(|(reason, count)| format!("{reason} {count}")).collect();
            lines.push(format!("건너뜀 {}개 연산(이유): {}", planned.skipped.len(), parts.join(", ")));
            for skip in planned.skipped.iter().take(MAX_LISTED) {
                lines.push(format!("  · {} — {}", skip.label, skip.reason));
            }
            if planned.skipped.len() > MAX_LISTED {
                lines.push(format!("  · 외 {}개", planned.skipped.len() - MAX_LISTED));
            }
        }
        let mut incomplete: Vec<String> = Vec::new();
        if planned.operations_total > planned.operations_seen {
            incomplete.push(format!("연산 수 상한 {}개(문서의 GET 연산 {}개 중 {}개를 보지 못함)", limits.max_operations, planned.operations_total, planned.operations_total - planned.operations_seen));
        }
        if planned.cut_by_requests > 0 {
            incomplete.push(format!("요청 수 상한 {}건(요청을 만들지 못한 연산 {}개)", limits.max_requests, planned.cut_by_requests));
        }
        if let Some(reason) = stopped {
            incomplete.push(reason.to_owned());
        }
        if !incomplete.is_empty() {
            lines.push(format!("끝까지 보지 못함(상한): {}", incomplete.join("; ")));
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str) -> JsValue {
        js_json::parse(text).expect("json")
    }

    fn limits() -> Limits {
        Limits { max_operations: DEFAULT_MAX_OPERATIONS, max_requests: DEFAULT_MAX_REQUESTS, seed: 7 }
    }

    const PETS: &str = r##"{
      "openapi": "3.0.3",
      "paths": {
        "/pets/{id}": {
          "get": {
            "parameters": [
              {"name": "id", "in": "path", "required": true, "schema": {"type": "integer", "minimum": 5, "maximum": 9}},
              {"name": "kind", "in": "query", "required": true, "schema": {"type": "string", "enum": ["cat", "dog"]}}
            ],
            "responses": {
              "200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}},
              "404": {"description": "없음"}
            }
          }
        }
      },
      "components": {"schemas": {"Pet": {"type": "object", "required": ["id", "name"], "properties": {"id": {"type": "integer"}, "name": {"type": "string"}, "tag": {"type": "string", "enum": ["a", "b"]}}}}}
    }"##;

    fn targets(planned: &Planned) -> Vec<String> {
        planned.requests.iter().map(|request| request.target.clone()).collect()
    }

    #[test]
    fn 스키마에_맞는_경로와_쿼리_값을_만든다() {
        let planned = plan(&doc(PETS), &limits());
        assert!(!planned.requests.is_empty());
        for target in targets(&planned) {
            let (path, query) = target.split_once('?').expect("query");
            let id: i64 = path.strip_prefix("/pets/").unwrap().parse().unwrap();
            assert!((5..=9).contains(&id), "{target}");
            assert!(query == "kind=cat" || query == "kind=dog", "{target}");
        }
        assert_eq!(planned.operations_total, 1);
        assert!(planned.skipped.is_empty());
    }

    #[test]
    fn 같은_시드면_같은_요청이고_시드가_다르면_달라질_수_있다() {
        let big = r##"{"openapi":"3.0.0","paths":{"/a":{"get":{"parameters":[{"name":"q","in":"query","required":true,"schema":{"type":"string","minLength":6,"maxLength":12}}],"responses":{"200":{"description":"ok"}}}}}}"##;
        let first = targets(&plan(&doc(big), &limits()));
        let again = targets(&plan(&doc(big), &limits()));
        assert_eq!(first, again);
        let other = targets(&plan(&doc(big), &Limits { seed: 8, ..limits() }));
        assert_ne!(first, other);
    }

    #[test]
    fn get만_다루고_상태를_바꾸는_메서드는_보내지_않는다() {
        let text = r##"{"openapi":"3.0.0","paths":{"/a":{"post":{"responses":{"200":{"description":"ok"}}},"delete":{"responses":{"200":{"description":"ok"}}},"get":{"responses":{"200":{"description":"ok"}}}},"/only-write":{"post":{"responses":{"200":{"description":"ok"}}},"put":{"responses":{"200":{"description":"ok"}}},"patch":{"responses":{"200":{"description":"ok"}}}}}}"##;
        let planned = plan(&doc(text), &limits());
        assert_eq!(planned.operations_total, 1);
        assert_eq!(targets(&planned), vec!["/a".to_owned()]);
    }

    #[test]
    fn 다룰_수_없는_연산은_이유와_함께_건너뛴다() {
        let text = r##"{"openapi":"3.0.0","security":[{"key":[]}],"components":{"schemas":{}},"paths":{
          "/secure":{"get":{"responses":{"200":{"description":"ok"}}}},
          "/open":{"get":{"security":[],"parameters":[{"name":"X-Token","in":"header","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"ok"}}}},
          "/body":{"get":{"security":[],"requestBody":{"required":true,"content":{}},"responses":{"200":{"description":"ok"}}}},
          "/ext":{"get":{"security":[],"parameters":[{"name":"q","in":"query","required":true,"schema":{"$ref":"other.json#/X"}}],"responses":{"200":{"description":"ok"}}}},
          "/cookie":{"get":{"security":[],"parameters":[{"name":"s","in":"cookie","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"ok"}}}},
          "/fine":{"get":{"security":[],"responses":{"200":{"description":"ok"}}}}
        }}"##;
        let planned = plan(&doc(text), &limits());
        let reasons: Vec<(&str, &str)> = planned.skipped.iter().map(|skip| (skip.label.as_str(), skip.reason.as_str())).collect();
        assert_eq!(
            reasons,
            vec![
                ("GET /secure", "보안 요구(인증)"),
                ("GET /open", "필수 헤더 매개변수"),
                ("GET /body", "GET이 요청 본문을 요구"),
                ("GET /ext", "문서 밖 $ref"),
                ("GET /cookie", "필수 쿠키 매개변수"),
            ]
        );
        assert_eq!(targets(&planned), vec!["/fine".to_owned()]);
        let report = plan_report(&planned, 0);
        assert!(report.contains("건너뜀 5개 연산"), "{report}");
    }

    fn plan_report(planned: &Planned, _sent: usize) -> String {
        Tally::default().report(planned, &limits(), None)
    }

    #[test]
    fn 순환_ref는_상한으로_끊고_건너뛴다() {
        let text = r##"{"openapi":"3.0.0","components":{"schemas":{"A":{"$ref":"#/components/schemas/B"},"B":{"$ref":"#/components/schemas/A"}}},"paths":{"/loop":{"get":{"parameters":[{"name":"q","in":"query","required":true,"schema":{"$ref":"#/components/schemas/A"}}],"responses":{"200":{"description":"ok"}}}}}}"##;
        let planned = plan(&doc(text), &limits());
        assert!(planned.requests.is_empty());
        assert_eq!(planned.skipped.len(), 1);
        assert!(planned.skipped[0].reason.contains("순환"), "{}", planned.skipped[0].reason);
    }

    #[test]
    fn 경로_값은_인코딩하고_점_구간이나_다른_호스트로_나가는_경로는_만들지_않는다() {
        let text = r##"{"openapi":"3.0.0","paths":{
          "/f/{name}":{"get":{"parameters":[{"name":"name","in":"path","required":true,"schema":{"type":"string","enum":["a b/c?d#e"]}}],"responses":{"200":{"description":"ok"}}}},
          "/g/{name}":{"get":{"parameters":[{"name":"name","in":"path","required":true,"schema":{"type":"string","enum":[".."]}}],"responses":{"200":{"description":"ok"}}}},
          "/../x":{"get":{"responses":{"200":{"description":"ok"}}}},
          "//evil.example/x":{"get":{"responses":{"200":{"description":"ok"}}}}
        }}"##;
        let planned = plan(&doc(text), &limits());
        assert_eq!(targets(&planned), vec!["/f/a%20b%2Fc%3Fd%23e".to_owned()]);
        let reasons: Vec<&str> = planned.skipped.iter().map(|skip| skip.reason.as_str()).collect();
        assert_eq!(reasons, vec!["점 경로를 뜻하는 경로 값", "경로에 점 구간", "안전하지 않은 경로"]);
    }

    #[test]
    fn 연산_수_상한과_요청_수_상한은_개수를_알린다() {
        let mut paths = String::new();
        for index in 0..30 {
            if index > 0 {
                paths.push(',');
            }
            paths.push_str(&format!(r#""/p{index}":{{"get":{{"parameters":[{{"name":"n","in":"query","required":true,"schema":{{"type":"integer","minimum":0,"maximum":1000}}}}],"responses":{{"200":{{"description":"ok"}}}}}}}}"#));
        }
        let text = format!(r#"{{"openapi":"3.0.0","paths":{{{paths}}}}}"#);
        let document = doc(&text);
        let by_ops = plan(&document, &Limits { max_operations: 5, max_requests: 500, seed: 1 });
        assert_eq!(by_ops.operations_seen, 5);
        assert_eq!(by_ops.operations_total, 30);
        let report = Tally::default().report(&by_ops, &Limits { max_operations: 5, max_requests: 500, seed: 1 }, None);
        assert!(report.contains("끝까지 보지 못함(상한): 연산 수 상한 5개"), "{report}");
        let by_requests = plan(&document, &Limits { max_operations: 30, max_requests: 4, seed: 1 });
        assert_eq!(by_requests.requests.len(), 4);
        assert!(by_requests.cut_by_requests > 0);
        let report = Tally::default().report(&by_requests, &Limits { max_operations: 30, max_requests: 4, seed: 1 }, None);
        assert!(report.contains("요청 수 상한 4건"), "{report}");
    }

    #[test]
    fn 문자열_제약과_단순한_pattern을_지킨다() {
        let text = r##"{"openapi":"3.0.0","paths":{
          "/s":{"get":{"parameters":[
            {"name":"a","in":"query","required":true,"schema":{"type":"string","minLength":3,"maxLength":3}},
            {"name":"b","in":"query","required":true,"schema":{"type":"string","pattern":"^[A-Z]{2}[0-9]{3}$"}},
            {"name":"c","in":"query","required":true,"schema":{"type":"string","format":"uuid"}},
            {"name":"d","in":"query","required":true,"schema":{"type":"integer","exclusiveMinimum":true,"minimum":10,"maximum":12}}
          ],"responses":{"200":{"description":"ok"}}}},
          "/hard":{"get":{"parameters":[{"name":"p","in":"query","required":true,"schema":{"type":"string","pattern":"^(a|b)+\\d$"}}],"responses":{"200":{"description":"ok"}}}}
        }}"##;
        let planned = plan(&doc(text), &limits());
        assert!(!planned.requests.is_empty(), "{:?}", planned.skipped.iter().map(|s| (&s.label, &s.reason)).collect::<Vec<_>>());
        let re_b = Regex::new(r"^[A-Z]{2}[0-9]{3}$").unwrap();
        for target in targets(&planned) {
            let query: Vec<(String, String)> = target.split_once('?').unwrap().1.split('&').map(|pair| pair.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())).unwrap()).collect();
            let get = |name: &str| query.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()).unwrap();
            assert_eq!(get("a").len(), 3);
            assert!(re_b.is_match(&get("b")), "{target}");
            assert_eq!(get("c").len(), 36);
            assert!(matches!(get("d").as_str(), "11" | "12"), "{target}");
        }
        assert_eq!(planned.skipped.len(), 1);
        assert_eq!(planned.skipped[0].reason, "단순하지 않은 pattern");
    }

    fn request(path_key: &str) -> PlannedRequest {
        PlannedRequest { label: format!("GET {path_key}"), path_key: path_key.to_owned(), target: "/pets/7?kind=cat".to_owned() }
    }

    fn lines_of(tally: &Tally) -> String {
        tally.report(&Planned { operations_seen: 1, operations_total: 1, ..Planned::default() }, &limits(), None)
    }

    #[test]
    fn 정상_응답은_알림이_없다() {
        let document = doc(PETS);
        let mut tally = Tally::default();
        tally.record(&document, &request("/pets/{id}"), 200.0, r#"{"id": 7, "name": "tom", "tag": "a"}"#);
        tally.record(&document, &request("/pets/{id}"), 404.0, "no");
        assert_eq!(tally.alert_count(), 0, "{}", lines_of(&tally));
    }

    #[test]
    fn 오백대_응답은_알림이다() {
        let document = doc(PETS);
        let mut tally = Tally::default();
        tally.record(&document, &request("/pets/{id}"), 500.0, "boom");
        tally.record(&document, &request("/pets/{id}"), 503.0, "");
        assert_eq!(tally.alert_count(), 2);
        let text = lines_of(&tally);
        assert!(text.contains("- 5xx 응답: GET /pets/{id} → 500 (/pets/7?kind=cat)"), "{text}");
    }

    #[test]
    fn 응답_형이_문서와_다르면_알림이다() {
        let document = doc(PETS);
        let cases = [
            (r#"{"id": "7", "name": "tom"}"#, "$.id: integer이어야 하는데 string입니다"),
            (r#"{"id": 7}"#, "$: 필수 속성 name이 없습니다"),
            (r#"{"id": 7, "name": "x", "tag": "zzz"}"#, "$.tag: 값이 enum에 없습니다"),
            (r#"[1]"#, "$: object이어야 하는데 array입니다"),
            ("<html>", "본문이 JSON이 아닙니다"),
            ("", "본문이 비어 있습니다"),
        ];
        for (body, expected) in cases {
            let mut tally = Tally::default();
            tally.record(&document, &request("/pets/{id}"), 200.0, body);
            let text = lines_of(&tally);
            assert_eq!(tally.alert_count(), 1, "{body}: {text}");
            assert!(text.contains(expected), "{body}: {text}");
        }
    }

    #[test]
    fn 문서에_없는_사백대는_알림이_아니고_개수만_적는다_없는_이백대는_알림이다() {
        let document = doc(PETS);
        let mut tally = Tally::default();
        tally.record(&document, &request("/pets/{id}"), 422.0, "{}");
        tally.record(&document, &request("/pets/{id}"), 400.0, "{}");
        assert_eq!(tally.alert_count(), 0);
        assert!(lines_of(&tally).contains("문서에 없는 4xx 응답 2건"));
        tally.record(&document, &request("/pets/{id}"), 201.0, "{}");
        assert_eq!(tally.alert_count(), 1);
        assert!(lines_of(&tally).contains("문서에 없는 상태 코드"));
    }

    #[test]
    fn 확인하지_못한_응답은_개수로_적는다() {
        let text = r##"{"openapi":"3.0.0","paths":{"/x":{"get":{"responses":{"200":{"content":{"application/json":{"schema":{"$ref":"other.json#/Y"}}}}}}}}}"##;
        let document = doc(text);
        let mut tally = Tally::default();
        tally.record(&document, &request("/x"), 200.0, "{}");
        assert_eq!(tally.alert_count(), 0);
        assert!(lines_of(&tally).contains("응답 형을 확인하지 못한 응답: 문서 밖 $ref 1"), "{}", lines_of(&tally));
    }

    #[test]
    fn 범위_상태_코드와_default_응답도_찾고_nullable_oneof_allof를_다룬다() {
        let text = r##"{"openapi":"3.0.0","paths":{"/x":{"get":{"responses":{
          "2XX":{"content":{"application/json":{"schema":{"allOf":[{"type":"object","required":["a"],"properties":{"a":{"type":"integer"}}},{"required":["b"],"properties":{"b":{"type":"string","nullable":true}}}]}}}},
          "default":{"content":{"application/json":{"schema":{"oneOf":[{"type":"string"},{"type":"integer"}]}}}}
        }}}}}"##;
        let document = doc(text);
        let mut tally = Tally::default();
        tally.record(&document, &request("/x"), 201.0, r#"{"a":1,"b":null}"#);
        tally.record(&document, &request("/x"), 302.0, "5");
        assert_eq!(tally.alert_count(), 0, "{}", lines_of(&tally));
        tally.record(&document, &request("/x"), 200.0, r#"{"a":1}"#);
        tally.record(&document, &request("/x"), 302.0, "true");
        assert_eq!(tally.alert_count(), 2, "{}", lines_of(&tally));
    }

    #[test]
    fn 너무_큰_본문은_읽지_않고_확인하지_못함으로_센다() {
        let document = doc(PETS);
        let mut tally = Tally::default();
        tally.record(&document, &request("/pets/{id}"), 200.0, &"x".repeat(MAX_BODY_BYTES + 1));
        assert_eq!(tally.alert_count(), 0);
        assert!(lines_of(&tally).contains("본문이 너무 큼 1"));
    }

    #[test]
    fn 요청_실패와_멈춘_이유를_알림에_적는다() {
        let mut tally = Tally::default();
        tally.record_failure(&request("/pets/{id}"), "connect ECONNREFUSED\n자세히");
        let text = tally.report(&Planned { operations_seen: 1, operations_total: 1, ..Planned::default() }, &limits(), Some("시간 상한 30000ms"));
        assert!(text.contains("요청 실패: GET /pets/{id} (/pets/7?kind=cat): 요청 실패 — connect ECONNREFUSED"), "{text}");
        assert!(text.contains("끝까지 보지 못함(상한): 시간 상한 30000ms"), "{text}");
    }

    #[test]
    fn 스웨거_2나_paths_없는_문서는_확인하지_못함이다() {
        let planned = plan(&doc(r#"{"swagger":"2.0","paths":{}}"#), &limits());
        assert!(planned.unsupported.is_some());
        assert!(Tally::default().report(&planned, &limits(), None).contains("확인하지 못함"));
    }

    #[test]
    fn 서버_기본_경로가_상대_경로면_앞에_붙이고_절대_주소면_붙이지_않는다() {
        let relative = r##"{"openapi":"3.0.0","servers":[{"url":"/api/v1/"}],"paths":{"/a":{"get":{"responses":{"200":{"description":"ok"}}}}}}"##;
        assert_eq!(targets(&plan(&doc(relative), &limits())), vec!["/api/v1/a".to_owned()]);
        let absolute = r##"{"openapi":"3.0.0","servers":[{"url":"https://evil.example/x"}],"paths":{"/a":{"get":{"responses":{"200":{"description":"ok"}}}}}}"##;
        assert_eq!(targets(&plan(&doc(absolute), &limits())), vec!["/a".to_owned()]);
    }
}
