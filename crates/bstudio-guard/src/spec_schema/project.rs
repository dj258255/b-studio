//! 프로젝트 정의(studio.yaml)의 스키마. `schema.ts`의 선언 순서를 그대로 따른다.

use super::*;
use regex::Regex;
use std::sync::OnceLock;

pub fn validate(name: &str, input: Option<&JsValue>) -> Outcome {
    match name {
        "HttpProbeSchema" => http_probe(input),
        "PreviewKindSchema" => validate_enum(input, &["browser", "openapi", "logs"]),
        "HttpMethodSchema" => validate_enum(input, &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
        "SnapshotSchema" => snapshot(input),
        "ManagedServiceSchema" => managed_service(input),
        "PolicyRuleSchema" => policy_rule(input),
        "EgressRuleSchema" => egress_rule(input),
        "ExternalPolicySchema" => external_policy(input),
        "ExternalServiceSchema" => external_service(input),
        "ServiceSchema" => service(input),
        "ResourceLimitSchema" => resource_limit(input),
        "DatabaseSchema" => database(input),
        "SecretSchema" => secret(input),
        "ReviewSchema" => review(input),
        "GuideSchema" => guide(input),
        "ModelsSchema" => models(input),
        "CheckpointsSchema" => checkpoints(input),
        "StudioSpecSchema" => studio_spec(input),
        "WorkflowSchema" | "WorkflowTestSchema" | "ConcurrencyExpectSchema" | "WorkflowConcurrencyCheckSchema" | "LoadExpectSchema" | "WorkflowLoadCheckSchema"
        | "WorkflowPageStepSchema" | "WorkflowPageExpectFromApiSchema" | "WorkflowPageCheckSchema"
        | "AutoPageChecksSchema" | "WorkflowStageSchema" => super::workflow::validate(name, input),
        other => Outcome::failed(input.cloned(), issue(Vec::new(), format!("알 수 없는 스키마입니다: {other}"), true)),
    }
}

// ───────────────────────── 정규식 ─────────────────────────

fn name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[a-z][a-z0-9-]*$"))
}
fn volume_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[a-zA-Z0-9][a-zA-Z0-9_.-]*$"))
}
fn project_relative_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$"))
}
fn path_pattern_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^/[^\\t\\n\\x0B\\x0C\\r \\u{00a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}\\u{feff}]*$"))
}
fn egress_host_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_ascii_i(r"^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$"))
}
fn header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[A-Za-z0-9-]+$"))
}
fn env_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[A-Z][A-Z0-9_]*$"))
}
fn system_package_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[a-z0-9][a-z0-9.+-]{0,63}$"))
}
fn memory_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_ascii_i(r"^[0-9]+(\.[0-9]+)?[kmg]$"))
}
fn sql_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("^[A-Za-z_][A-Za-z0-9_]{0,62}$"))
}
fn reserved_edge_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex_plain(
            "^(EDGE_|NODE_|LD_|DYLD_)|^(PATH|HOME|HOSTNAME|SHELL|USER|PWD|TMPDIR|TZ|LANG|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|JAVA_TOOL_OPTIONS)$",
        )
    })
}
fn control_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| regex_plain("[\\\\\\u{0}-\\u{1f}\\u{7f}]"))
}

fn check_regex(value: &str, re: &Regex, custom: Option<&str>, pattern: Option<&str>, issues: &mut Vec<Issue>) {
    if re.is_match(value) {
        return;
    }
    let message = match custom {
        Some(message) => message.to_owned(),
        None => match pattern {
            Some(pattern) => format!("Invalid string: must match pattern {pattern}"),
            None => format!("Invalid string: must match pattern /{}/", re.as_str()),
        },
    };
    issues.push(issue(Vec::new(), message, false));
}

fn check_service_path(value: &str, issues: &mut Vec<Issue>) {
    if !value.starts_with('/') || value.starts_with("//") {
        issues.push(issue(Vec::new(), "\"/\"로 시작하고 \"//\"로 시작하지 않는 경로여야 합니다", false));
    }
}

fn check_relative_path(value: &str, issues: &mut Vec<Issue>) {
    let bytes = value.as_bytes();
    let drive_absolute = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'/' || bytes[2] == b'\\');
    let starts_absolute = value.starts_with('/') || value.starts_with('\\');
    let has_parent = value.split(['/', '\\']).any(|segment| segment == "..");
    if drive_absolute || starts_absolute || has_parent {
        issues.push(issue(Vec::new(), "서비스 폴더 안의 상대 경로여야 합니다", false));
    }
}

fn check_project_relative(value: &str, issues: &mut Vec<Issue>) {
    if !project_relative_re().is_match(value) {
        issues.push(issue(
            Vec::new(),
            "영문·숫자·.·_·-와 /만 쓰는 프로젝트 루트 기준 상대 경로여야 합니다(공백·셸 메타문자는 받지 않습니다)",
            false,
        ));
    }
    if value.split('/').any(|segment| segment == "..") {
        issues.push(issue(Vec::new(), "\"..\"은 쓸 수 없습니다", false));
    }
}

fn string_schema(input: Option<&JsValue>, lengths: &[LengthCheck], mut checks: impl FnMut(&str, &mut Vec<Issue>)) -> Outcome {
    validate_string(input, lengths, &mut |input, issues| {
        if let Some(JsValue::Str(value)) = input {
            checks(value, issues);
        }
    })
}

fn name_string(input: Option<&JsValue>) -> Outcome {
    string_schema(input, &[], |value, issues| check_regex(value, name_re(), None, Some("/^[a-z][a-z0-9-]*$/"), issues))
}

// ───────────────────────── 공통 조각 ─────────────────────────

fn ready_path(input: Option<&JsValue>) -> Outcome {
    string_schema(input, &[], |value, issues| {
        check_service_path(value, issues);
        if control_re().is_match(value) {
            issues.push(issue(Vec::new(), "역슬래시와 제어 문자(탭·줄바꿈 포함)는 쓸 수 없습니다. 퍼센트 인코딩해서 적으세요", false));
        }
    })
}

fn service_path(input: Option<&JsValue>) -> Outcome {
    string_schema(input, &[], check_service_path)
}

fn relative_path(input: Option<&JsValue>) -> Outcome {
    string_schema(input, &[LengthCheck::Min(1, None)], check_relative_path)
}

fn project_relative_path(input: Option<&JsValue>) -> Outcome {
    string_schema(input, &[LengthCheck::Min(1, None)], check_project_relative)
}

fn enum_array(input: Option<&JsValue>, values: &[&str]) -> Outcome {
    validate_array(input, |item| validate_enum(item, values), &[LengthCheck::Min(1, None)])
}

fn trim_c0_space(value: &str) -> &str {
    value.trim_matches(|c: char| c <= ' ')
}

fn special_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "ws" | "wss" | "ftp" | "file")
}

/// Node `URL.canParse`(WHATWG)와 같은 판정. `url` 크레이트가 받아들이는 것 중 Node가 거부하는 꼴을 닫는다
fn node_url_parse(raw: &str) -> Option<url::Url> {
    let parse_input = trim_c0_space(js_trim(raw));
    let cleaned = parse_input.replace(['\t', '\n', '\r'], "");
    let parsed = url::Url::parse(&cleaned).ok()?;
    if !parsed.cannot_be_a_base() {
        if let Some(colon) = cleaned.find(':') {
            if let Some(authority) = cleaned[colon + 1..].strip_prefix("//") {
                let end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
                let authority = &authority[..end];
                if !authority.is_empty() && parsed.host().is_none() {
                    return None;
                }
                if !special_scheme(parsed.scheme()) && authority.contains('\\') {
                    return None;
                }
            }
        }
    }
    Some(parsed)
}

fn url_value(input: Option<&JsValue>) -> Outcome {
    let mut issues = Vec::new();
    let Some(JsValue::Str(raw)) = input else {
        return Outcome::failed(None, invalid_type(input, "string"));
    };
    let trimmed = js_trim(raw);
    if node_url_parse(raw).is_none() {
        issues.push(issue(Vec::new(), "Invalid URL", false));
        return Outcome { value: Some(JsValue::Str(raw.clone())), issues };
    }
    let normalized = trimmed.replace(['\t', '\n', '\r'], "");
    Outcome { value: Some(JsValue::Str(normalized)), issues }
}

fn boolean(input: Option<&JsValue>) -> Outcome {
    match input {
        Some(JsValue::Bool(value)) => Outcome::ok(JsValue::Bool(*value)),
        _ => Outcome::failed(input.cloned(), invalid_type(input, "boolean")),
    }
}

// ───────────────────────── 스키마 ─────────────────────────

pub fn http_probe(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("path", ready_path(obj.field("path")));
    obj.set(
        "expectStatus",
        defaulted(obj.field("expectStatus"), || JsValue::Num(200.0), |value| validate_number(value, &[NumberCheck::Int, NumberCheck::Min(100.0, true), NumberCheck::Max(599.0, true)])),
    );
    if let Some(timeout) = obj.field("timeoutSeconds") {
        obj.set("timeoutSeconds", validate_number(Some(timeout), &[NumberCheck::Int, NumberCheck::Positive]));
    }
    obj.finish()
}

pub fn snapshot(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("volume", string_schema(obj.field("volume"), &[], |value, issues| check_regex(value, volume_re(), None, Some("/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/"), issues)));
    obj.set("key", validate_array(obj.field("key"), |item| relative_path(item), &[LengthCheck::Min(1, None)]));
    obj.finish()
}

pub fn managed_service(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("source", validate_literal(obj.field("source"), JsValue::Str("managed".into())));
    obj.set("template", string_schema(obj.field("template"), &[LengthCheck::Min(1, None)], |_, _| {}));
    obj.set("path", string_schema(obj.field("path"), &[LengthCheck::Min(1, None)], |_, _| {}));
    obj.set("port", validate_number(obj.field("port"), &[NumberCheck::Int, NumberCheck::Min(1.0, true), NumberCheck::Max(65535.0, true)]));
    obj.set("preview", validate_enum(obj.field("preview"), &["browser", "openapi", "logs"]));
    if let Some(value) = obj.field("ready") {
        obj.set("ready", http_probe(Some(value)));
    }
    if let Some(value) = obj.field("contract") {
        obj.set("contract", contract_schema(Some(value)));
    }
    if let Some(value) = obj.field("snapshots") {
        obj.set("snapshots", validate_array(Some(value), |item| snapshot(item), &[]));
    }
    if let Some(value) = obj.field("systemPackages") {
        obj.set(
            "systemPackages",
            validate_array(
                Some(value),
                |item| string_schema(item, &[], |value, issues| check_regex(value, system_package_re(), Some("apt·apk 패키지 이름(영문 소문자·숫자로 시작, 그 뒤 영문 소문자·숫자·.·+·-)이어야 합니다"), None, issues)),
                &[LengthCheck::Max(20, Some("systemPackages는 최대 20개까지 쓸 수 있습니다"))],
            ),
        );
    }
    if let Some(value) = obj.field("includes") {
        obj.set(
            "includes",
            validate_array(Some(value), |item| project_relative_path(item), &[LengthCheck::Max(20, Some("includes는 최대 20개까지 쓸 수 있습니다"))]),
        );
    }
    obj.finish()
}

fn contract_schema(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("extract", service_path(obj.field("extract")));
    obj.finish()
}

pub fn policy_rule(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("callers", validate_array(obj.field("callers"), |item| name_string(item), &[LengthCheck::Min(1, None)]));
    obj.set("methods", enum_array(obj.field("methods"), &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]));
    obj.set(
        "paths",
        defaulted(obj.field("paths"), || JsValue::Arr(vec![JsValue::Str("/**".into())]), |value| {
            validate_array(value, |item| string_schema(item, &[], |value, issues| check_regex(value, path_pattern_re(), Some("\"/\"로 시작하고 공백이 없는 경로 패턴이어야 합니다"), None, issues)), &[LengthCheck::Min(1, None)])
        }),
    );
    obj.finish()
}

fn egress_host(input: Option<&JsValue>) -> Outcome {
    string_schema(input, &[], |value, issues| check_regex(value, egress_host_re(), Some("example.com이나 *.example.com 같은 호스트 이름이어야 합니다"), None, issues))
}

fn egress_rule_object(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("host", egress_host(obj.field("host")));
    obj.set(
        "methods",
        defaulted(obj.field("methods"), || JsValue::Arr(vec![JsValue::Str("GET".into()), JsValue::Str("HEAD".into())]), |value| {
            enum_array(value, &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
        }),
    );
    obj.set(
        "paths",
        defaulted(obj.field("paths"), || JsValue::Arr(vec![JsValue::Str("/**".into())]), |value| {
            validate_array(value, |item| string_schema(item, &[], |value, issues| check_regex(value, path_pattern_re(), Some("\"/\"로 시작하고 공백이 없는 경로 패턴이어야 합니다"), None, issues)), &[LengthCheck::Min(1, None)])
        }),
    );
    obj.finish()
}

pub fn egress_rule(input: Option<&JsValue>) -> Outcome {
    validate_union(input, &[egress_host, egress_rule_object])
}

fn response_mask_patterns(input: Option<&JsValue>) -> Outcome {
    validate_array(input, |item| validate_enum(item, &["phone", "email", "residentNumber", "card"]), &[])
}

pub fn external_policy(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    if let Some(value) = obj.field("allow") {
        obj.set("allow", validate_array(Some(value), |item| policy_rule(item), &[]));
    }
    obj.set("mask", defaulted(obj.field("mask"), || JsValue::Arr(Vec::new()), |value| validate_array(value, |item| string_schema(item, &[LengthCheck::Min(1, None)], |_, _| {}), &[])));
    obj.set("maskPatterns", defaulted(obj.field("maskPatterns"), || JsValue::Arr(Vec::new()), |value| response_mask_patterns(value)));
    if let Some(value) = obj.field("auth") {
        obj.set("auth", auth_schema(Some(value)));
    }
    obj.finish()
}

fn auth_schema(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set(
        "header",
        string_schema(obj.field("header"), &[], |value, issues| check_regex(value, header_re(), Some("HTTP 헤더 이름이어야 합니다"), None, issues)),
    );
    obj.set(
        "secret",
        string_schema(obj.field("secret"), &[], |value, issues| {
            check_regex(value, env_name_re(), None, None, issues);
            if reserved_edge_re().is_match(value) {
                issues.push(issue(Vec::new(), format!("'{value}'은(는) edge 프록시가 쓰는 환경 변수 이름과 겹칩니다. 다른 이름을 쓰세요"), false));
            }
        }),
    );
    obj.set("prefix", defaulted(obj.field("prefix"), || JsValue::Str(String::new()), |value| string_schema(value, &[], |_, _| {})));
    obj.finish()
}

pub fn external_service(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("source", validate_literal(obj.field("source"), JsValue::Str("external".into())));
    obj.set("baseUrl", external_base_url(obj.field("baseUrl")));
    obj.set(
        "preview",
        defaulted(obj.field("preview"), || JsValue::Str("openapi".into()), |value| validate_enum(value, &["openapi", "logs"])),
    );
    if let Some(value) = obj.field("contract") {
        obj.set("contract", external_contract(Some(value)));
    }
    obj.set(
        "policy",
        defaulted(
            obj.field("policy"),
            || {
                let mut policy = JsObject::new();
                policy.set("mask", JsValue::Arr(Vec::new()));
                policy.set("maskPatterns", JsValue::Arr(Vec::new()));
                JsValue::Obj(policy)
            },
            |value| external_policy(value),
        ),
    );
    obj.finish()
}

fn external_base_url(input: Option<&JsValue>) -> Outcome {
    let mut result = url_value(input);
    if let Some(JsValue::Str(value)) = &result.value {
        if !value.starts_with("http://") && !value.starts_with("https://") {
            result.issues.push(issue(Vec::new(), "http나 https 주소여야 합니다", false));
        }
        match node_url_parse(value) {
            Some(parsed) if parsed.username().is_empty() && parsed.password().is_none() => {}
            _ => result.issues.push(issue(Vec::new(), "주소에 자격 증명을 넣지 말고 policy.auth와 secrets를 쓰세요", false)),
        }
    }
    result
}

fn external_contract(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("url", url_value(obj.field("url")));
    obj.finish()
}

fn managed_branch(input: Option<&JsValue>) -> Outcome {
    managed_service(input)
}
fn external_branch(input: Option<&JsValue>) -> Outcome {
    external_service(input)
}

pub fn service(input: Option<&JsValue>) -> Outcome {
    let Some(JsValue::Obj(object)) = input else {
        return Outcome::failed(input.cloned(), invalid_type(input, "object"));
    };
    let discriminator = object.get("source");
    let matched = match discriminator {
        Some(JsValue::Str(source)) if source == "managed" => Some(managed_branch as fn(Option<&JsValue>) -> Outcome),
        Some(JsValue::Str(source)) if source == "external" => Some(external_branch as fn(Option<&JsValue>) -> Outcome),
        _ => None,
    };
    if let Some(branch) = matched {
        return branch(input);
    }
    Outcome::failed(
        input.cloned(),
        issue(vec![Seg::Key("source".into())], "Invalid discriminator value. Expected 'managed' | 'external'", true),
    )
}

pub fn resource_limit(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    if let Some(value) = obj.field("memory") {
        obj.set(
            "memory",
            string_schema(Some(value), &[], |value, issues| check_regex(value, memory_re(), Some("512m, 1.5g 같은 docker 메모리 표기여야 합니다"), None, issues)),
        );
    }
    if let Some(value) = obj.field("cpus") {
        obj.set("cpus", validate_number(Some(value), &[NumberCheck::Positive, NumberCheck::Max(64.0, true)]));
    }
    obj.run_checks(&mut |parsed, issues| {
        if parsed.get("memory").is_none() && parsed.get("cpus").is_none() {
            issues.push(issue(Vec::new(), "memory나 cpus 중 하나는 적어야 합니다", false));
        }
    });
    obj.finish()
}

pub fn database(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("engine", validate_literal(obj.field("engine"), JsValue::Str("postgres".into())));
    obj.set("database", string_schema(obj.field("database"), &[], |value, issues| check_regex(value, sql_re(), Some("SQL 식별자(영문, 숫자, 밑줄)여야 합니다"), None, issues)));
    obj.set("user", string_schema(obj.field("user"), &[], |value, issues| check_regex(value, sql_re(), Some("SQL 식별자(영문, 숫자, 밑줄)여야 합니다"), None, issues)));
    obj.finish()
}

pub fn secret(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("services", defaulted(obj.field("services"), || JsValue::Arr(Vec::new()), |value| validate_array(value, |item| name_string(item), &[])));
    if let Some(value) = obj.field("description") {
        obj.set("description", string_schema(Some(value), &[], |_, _| {}));
    }
    obj.finish()
}

const DEPLOY_REMOVED: &str = "`deploy`는 더는 지원하지 않습니다. 이 항목을 지우세요";

pub fn review(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("auto", defaulted(obj.field("auto"), || JsValue::Bool(true), |value| boolean(value)));
    obj.set("maxRounds", defaulted(obj.field("maxRounds"), || JsValue::Num(2.0), |value| validate_number(value, &[NumberCheck::Int, NumberCheck::Min(1.0, true), NumberCheck::Max(3.0, true)])));
    obj.finish()
}

pub fn guide(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("file", defaulted(obj.field("file"), || JsValue::Str("AGENTS.md".into()), |value| string_schema(value, &[], |_, _| {})));
    obj.set("maxChars", defaulted(obj.field("maxChars"), || JsValue::Num(8000.0), |value| validate_number(value, &[NumberCheck::Int, NumberCheck::Positive])));
    obj.set("enabled", defaulted(obj.field("enabled"), || JsValue::Bool(true), |value| boolean(value)));
    obj.finish()
}

pub fn checkpoints(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("conventionalCommits", defaulted(obj.field("conventionalCommits"), || JsValue::Bool(true), |value| boolean(value)));
    obj.finish()
}

pub fn models(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    for key in ["plan", "execute"] {
        if let Some(value) = obj.field(key) {
            obj.set(key, string_schema(Some(value), &[LengthCheck::Min(1, None), LengthCheck::Max(120, None)], |_, _| {}));
        }
    }
    obj.finish()
}

fn repository(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("monorepo", defaulted(obj.field("monorepo"), || JsValue::Bool(false), |value| boolean(value)));
    obj.set("autoCatchUp", defaulted(obj.field("autoCatchUp"), || JsValue::Bool(true), |value| boolean(value)));
    obj.finish()
}

fn network(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set(
        "egress",
        defaulted(obj.field("egress"), || JsValue::Arr(Vec::new()), |value| validate_array(value, |item| egress_rule(item), &[])),
    );
    obj.finish()
}

fn services_record(input: Option<&JsValue>) -> Outcome {
    let mut result = validate_record(input, |key| name_re().is_match(key), |item| service(item));
    if !result.has_fatal() {
        if let Some(JsValue::Obj(services)) = &result.value {
            if services.entries().is_empty() {
                result.issues.push(issue(Vec::new(), "서비스가 최소 1개 필요합니다", false));
            }
        }
    }
    result
}

pub fn studio_spec(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("version", validate_literal(obj.field("version"), JsValue::Num(1.0)));
    obj.set("name", name_string(obj.field("name")));
    obj.set("compose", defaulted(obj.field("compose"), || JsValue::Str("compose.yaml".into()), |value| string_schema(value, &[], |_, _| {})));
    obj.set("services", services_record(obj.field("services")));
    if let Some(value) = obj.field("databases") {
        obj.set("databases", validate_record(Some(value), |key| name_re().is_match(key), |item| database(item)));
    }
    if let Some(value) = obj.field("resources") {
        obj.set("resources", validate_record(Some(value), |key| name_re().is_match(key), |item| resource_limit(item)));
    }
    if let Some(value) = obj.field("network") {
        obj.set("network", network(Some(value)));
    }
    if let Some(value) = obj.field("secrets") {
        obj.set("secrets", validate_record(Some(value), |key| env_name_re().is_match(key), |item| secret(item)));
    }
    if obj.field("deploy").is_some() {
        obj.issues.push(issue(vec![Seg::Key("deploy".to_owned())], DEPLOY_REMOVED.to_owned(), false));
    }
    if obj.field("design").is_some() {
        obj.issues.push(issue(vec![Seg::Key("design".into())], "`design`은 더는 지원하지 않습니다. 이 항목을 지우세요", false));
    }
    if let Some(value) = obj.field("workflow") {
        obj.set("workflow", super::workflow::workflow(Some(value)));
    }
    if let Some(value) = obj.field("repository") {
        obj.set("repository", repository(Some(value)));
    }
    obj.set("review", defaulted(obj.field("review"), review_default, |value| review(value)));
    obj.set("guide", defaulted(obj.field("guide"), guide_default, |value| guide(value)));
    if let Some(value) = obj.field("models") {
        obj.set("models", models(Some(value)));
    }
    obj.set("checkpoints", defaulted(obj.field("checkpoints"), checkpoints_default, |value| checkpoints(value)));
    obj.finish()
}

fn review_default() -> JsValue {
    let mut out = JsObject::new();
    out.set("auto", JsValue::Bool(true));
    out.set("maxRounds", JsValue::Num(2.0));
    JsValue::Obj(out)
}

fn guide_default() -> JsValue {
    let mut out = JsObject::new();
    out.set("file", JsValue::Str("AGENTS.md".into()));
    out.set("maxChars", JsValue::Num(8000.0));
    out.set("enabled", JsValue::Bool(true));
    JsValue::Obj(out)
}

fn checkpoints_default() -> JsValue {
    let mut out = JsObject::new();
    out.set("conventionalCommits", JsValue::Bool(true));
    JsValue::Obj(out)
}

// ───────────────────────── load.ts의 compose 스키마 ─────────────────────────

pub fn compose(input: Option<&JsValue>) -> Outcome {
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    obj.set("services", validate_record(obj.field("services"), |_| true, |item| Outcome::ok(item.cloned().unwrap_or(JsValue::Null))));
    if let Some(value) = obj.field("volumes") {
        obj.set("volumes", validate_record(Some(value), |_| true, |item| compose_volume(item)));
    }
    obj.finish()
}

fn compose_volume(input: Option<&JsValue>) -> Outcome {
    if matches!(input, Some(JsValue::Null)) {
        return Outcome::ok(JsValue::Null);
    }
    let Ok(mut obj) = object_start(input) else { return Outcome::failed(input.cloned(), invalid_type(input, "object")) };
    if let Some(value) = obj.field("external") {
        obj.set("external", boolean(Some(value)));
    }
    if let Some(value) = obj.field("name") {
        obj.set("name", string_schema(Some(value), &[], |_, _| {}));
    }
    obj.finish()
}

// `services` record의 값 스키마는 `z.unknown()`이라 아무 값이나 통과한다. 위 `validate_record`의 value는 그대로 clone한다.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json;

    fn issues(value: &str) -> Vec<(Vec<Seg>, String)> {
        studio_spec(Some(&js_json::parse(value).expect("JSON")))
            .issues
            .into_iter()
            .map(|issue| (issue.path, issue.message))
            .collect()
    }

    const BASE: &str = r#"{"version":1,"name":"orders","services":{"web":{"source":"managed","template":"nextjs","path":"web","port":3000,"preview":"browser"}}}"#;

    #[test]
    fn 지운_design_항목은_까닭과_함께_거절한다() {
        let with_design = r#"{"version":1,"name":"orders","services":{"web":{"source":"managed","template":"nextjs","path":"web","port":3000,"preview":"browser"}},"design":{"figma":{"fileUrl":"https://www.figma.com/design/abc/x"}}}"#;
        assert_eq!(issues(&with_design), vec![(vec![Seg::Key("design".into())], "`design`은 더는 지원하지 않습니다. 이 항목을 지우세요".to_owned())]);
        assert!(issues(BASE).is_empty());
    }
}
