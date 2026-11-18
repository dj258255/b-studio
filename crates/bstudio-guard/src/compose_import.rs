//! compose 파일에서 부가 서비스를 가져오고 앱 환경을 배선하는 순수 계산(`packages/spec/src/compose-import.ts`, ADR-073·083·095·137·139·146).
//!
//! Node를 모르는 판정이다. 입력은 `js_json` 값(JSON 문자열에서 읽은 것)이고, YAML 글자를 받는 세 함수는
//! `crate::yaml`로 직접 읽는다(옛 TS도 `readYaml`을 거쳐 같은 Rust 읽기를 썼고, 실패하면 빈 결과·undefined였다).
//!
//! 옛 JS 정규식과 같은 범위를 쓰려고 `\s`·`\S`는 명시적 클래스로, `\w`·`\d`·`\b`는 ASCII로 적는다.
//! `(?i)`는 ASCII만 접는 `(?i-u)`를 쓴다(JS `/i`는 `ſ`를 `s`로 접지 않는다).

use crate::js;
use crate::js_json::{JsObject, JsValue};
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

/// JS `\s` 집합
const JS_WS: &str = "\\t\\n\\x0B\\x0C\\r \\u{00a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}\\u{feff}";
/// JS `.`(줄바꿈 제외): `\n`·`\r`·U+2028·U+2029만 빠진다
const JS_DOT: &str = "[^\\n\\r\\u{2028}\\u{2029}]";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|error| panic!("정규식 {pattern:?}: {error}"))
}

fn once<'a>(slot: &'a OnceLock<Regex>, pattern: fn() -> String) -> &'a Regex {
    slot.get_or_init(|| re(&pattern()))
}

fn js_ws_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r')
        || c == ' '
        || c == '\u{00a0}'
        || c == '\u{1680}'
        || ('\u{2000}'..='\u{200a}').contains(&c)
        || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(js_ws_char)
}

/// `Object.entries` 순서(정수 꼴 키가 먼저). 배열은 인덱스 이름의 객체로 읽는다
fn entry_list(value: &JsValue) -> Vec<(String, &JsValue)> {
    match value {
        JsValue::Obj(o) => o.entries_js_order().into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
        JsValue::Arr(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Vec::new(),
    }
}

/// JS `typeof value === 'object' && value !== null`
fn object_like(value: &JsValue) -> bool {
    matches!(value, JsValue::Obj(_) | JsValue::Arr(_))
}

fn truthy(value: Option<&JsValue>) -> bool {
    value.is_some_and(JsValue::truthy)
}

fn str_field<'a>(value: &'a JsValue, key: &str) -> Option<&'a str> {
    value.prop(key).and_then(JsValue::as_str)
}

/// `String(value)`
fn text(value: &JsValue) -> String {
    value.to_js_string()
}

fn obj_value(pairs: Vec<(&str, JsValue)>) -> JsValue {
    let mut o = JsObject::new();
    for (k, v) in pairs {
        o.set(k, v);
    }
    JsValue::Obj(o)
}

fn strings(items: Vec<String>) -> JsValue {
    JsValue::Arr(items.into_iter().map(JsValue::Str).collect())
}

fn yaml_value(source: &str) -> Option<JsValue> {
    match crate::yaml::parse(source, false) {
        crate::yaml::Outcome::Value(json) => crate::js_json::parse_native(&json).ok(),
        _ => None,
    }
}

// ───────────────────────── 이미지·파일 이름 ─────────────────────────

const BASENAMES: &[(&str, &str)] = &[
    ("postgres", "postgres"),
    ("postgis", "postgres"),
    ("pgvector", "postgres"),
    ("timescaledb", "postgres"),
    ("mysql", "mysql"),
    ("mariadb", "mariadb"),
    ("redis", "redis"),
    ("valkey", "valkey"),
    ("kafka", "kafka"),
    ("cp-kafka", "kafka"),
    ("zookeeper", "zookeeper"),
    ("cp-zookeeper", "zookeeper"),
    ("rabbitmq", "rabbitmq"),
    ("mongo", "mongodb"),
    ("mongodb", "mongodb"),
    ("elasticsearch", "elasticsearch"),
    ("opensearch", "opensearch"),
    ("minio", "minio"),
    ("mailhog", "mailpit"),
    ("mailpit", "mailpit"),
    ("localstack", "localstack"),
];

fn engine_default_port(engine: &str) -> Option<f64> {
    Some(match engine {
        "postgres" => 5432.0,
        "mysql" | "mariadb" => 3306.0,
        "redis" | "valkey" => 6379.0,
        "kafka" => 9092.0,
        "zookeeper" => 2181.0,
        "rabbitmq" => 5672.0,
        "mongodb" => 27017.0,
        "elasticsearch" | "opensearch" => 9200.0,
        "minio" => 9000.0,
        "mailpit" => 1025.0,
        "localstack" => 4566.0,
        _ => return None,
    })
}

pub fn engine_of_image(image: &str) -> Option<&'static str> {
    let without_digest = image.split('@').next().unwrap_or("");
    let last_segment = without_digest.split('/').filter(|part| !part.is_empty()).next_back().unwrap_or("");
    let basename = last_segment.split(':').next().unwrap_or(last_segment).to_lowercase();
    BASENAMES.iter().find(|(name, _)| *name == basename).map(|(_, engine)| *engine)
}

fn prod_file() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "(?i-u)(^|[._-])prod(uction)?([._-]|$)".to_owned())
}

pub fn is_prod_compose_file(file_name: &str) -> bool {
    prod_file().is_match(file_name)
}

// ───────────────────────── compose 가져오기 ─────────────────────────

fn normalize_environment(value: Option<&JsValue>) -> JsObject {
    let mut out = JsObject::new();
    match value {
        Some(JsValue::Arr(items)) => {
            for item in items {
                if let JsValue::Str(entry) = item {
                    if let Some(eq) = entry.find('=') {
                        out.set(&entry[..eq], JsValue::Str(entry[eq + 1..].to_owned()));
                    }
                }
            }
        }
        Some(JsValue::Obj(o)) => {
            for (key, value) in o.entries_js_order() {
                out.set(key, JsValue::Str(text(value)));
            }
        }
        _ => {}
    }
    out
}

fn depends_on_names(value: Option<&JsValue>) -> Vec<String> {
    match value {
        Some(JsValue::Arr(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        Some(JsValue::Obj(o)) => o.entries_js_order().into_iter().map(|(key, _)| key.to_owned()).collect(),
        _ => Vec::new(),
    }
}

fn env_file_names(value: Option<&JsValue>) -> Vec<String> {
    fn name_of(entry: &JsValue) -> Option<String> {
        match entry {
            JsValue::Str(s) => Some(s.clone()),
            JsValue::Obj(o) => o.get("path").and_then(JsValue::as_str).map(str::to_owned),
            _ => None,
        }
    }
    match value {
        Some(JsValue::Arr(items)) => items.iter().filter_map(name_of).collect(),
        Some(other) => name_of(other).into_iter().collect(),
        None => Vec::new(),
    }
}

fn parse_short_volume(mount: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = mount.split(':').collect();
    if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
        return None;
    }
    Some((parts[0].to_owned(), parts[1].to_owned()))
}

fn parse_long_volume(mount: &JsValue) -> Option<(String, String)> {
    let JsValue::Obj(o) = mount else { return None };
    Some((o.get("source")?.as_str()?.to_owned(), o.get("target")?.as_str()?.to_owned()))
}

fn is_bind_mount(source: &str) -> bool {
    source.starts_with('.') || source.starts_with('/') || source.starts_with('~')
}

fn named_volumes_for(service_name: &str, value: Option<&JsValue>) -> JsObject {
    let mut out = JsObject::new();
    let Some(JsValue::Arr(mounts)) = value else { return out };
    let mut fallback = 0usize;
    for mount in mounts {
        let parsed = match mount {
            JsValue::Str(mount) => parse_short_volume(mount),
            other => parse_long_volume(other),
        };
        let Some((source, target)) = parsed else { continue };
        if is_bind_mount(&source) {
            continue;
        }
        let label = target.split('/').filter(|part| !part.is_empty()).next_back().map(str::to_owned).unwrap_or_else(|| {
            fallback += 1;
            format!("data{}", fallback - 1)
        });
        out.set(&format!("{service_name}-{label}"), JsValue::Str(target));
    }
    out
}

pub fn import_supporting_services(compose_text: &str, source_file: &str) -> JsValue {
    let skipped = |name: &str, reason: &str| obj_value(vec![("name", JsValue::Str(name.to_owned())), ("reason", JsValue::Str(reason.to_owned()))]);
    let empty = || obj_value(vec![("services", JsValue::Arr(Vec::new())), ("skipped", JsValue::Arr(Vec::new()))]);
    let Some(doc) = yaml_value(compose_text) else { return empty() };
    let Some(services_raw) = doc.prop("services") else { return empty() };
    if !object_like(services_raw) {
        return empty();
    }

    let mut skipped_out: Vec<JsValue> = Vec::new();
    struct Matched<'a> {
        name: String,
        def: &'a JsValue,
        engine: &'static str,
        image: String,
    }
    let mut matched: Vec<Matched> = Vec::new();
    for (name, raw) in entry_list(services_raw) {
        if !object_like(raw) {
            continue;
        }
        let def = raw;
        if def.prop("build").is_some() {
            skipped_out.push(skipped(&name, "이미지를 pull하지 않고 build하는 서비스라 앱 서비스로 보고 뺐습니다"));
            continue;
        }
        if def.prop("profiles").is_some() {
            skipped_out.push(skipped(&name, "profiles가 있어 기본 기동에 포함되지 않는 서비스라 뺐습니다"));
            continue;
        }
        let Some(image) = def.prop("image").and_then(JsValue::as_str) else {
            skipped_out.push(skipped(&name, "image가 없어 무엇인지 알 수 없습니다"));
            continue;
        };
        let Some(engine) = engine_of_image(image) else {
            skipped_out.push(skipped(&name, &format!("{image}은(는) 알려진 인프라 이미지가 아닙니다")));
            continue;
        };
        matched.push(Matched { name, def, engine, image: image.to_owned() });
    }

    let matched_names: HashSet<String> = matched.iter().map(|m| m.name.clone()).collect();
    let mut services_out: Vec<JsValue> = Vec::new();
    for Matched { name, def, engine, image } in matched {
        let mut o = JsObject::new();
        o.set("name", JsValue::Str(name.clone()));
        o.set("engine", JsValue::Str(engine.to_owned()));
        o.set("image", JsValue::Str(image));
        o.set("environment", JsValue::Obj(normalize_environment(def.prop("environment"))));
        if let Some(command) = def.prop("command") {
            o.set("command", command.clone());
        }
        if let Some(healthcheck) = def.prop("healthcheck") {
            o.set("healthcheck", healthcheck.clone());
        }
        o.set(
            "dependsOn",
            strings(depends_on_names(def.prop("depends_on")).into_iter().filter(|dep| matched_names.contains(dep.as_str())).collect()),
        );
        o.set("volumes", JsValue::Obj(named_volumes_for(&name, def.prop("volumes"))));
        o.set("envFiles", strings(env_file_names(def.prop("env_file"))));
        o.set("notes", JsValue::Arr(Vec::new()));
        o.set("sourceFile", JsValue::Str(source_file.to_owned()));
        services_out.push(JsValue::Obj(o));
    }

    obj_value(vec![("services", JsValue::Arr(services_out)), ("skipped", JsValue::Arr(skipped_out))])
}

fn not_alpha() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "[^a-z0-9-]+".to_owned())
}
fn leading_not_alpha() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "^[^a-z]+".to_owned())
}
fn trailing_dash() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "-+$".to_owned())
}
fn double_dash() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "-{2,}".to_owned())
}
fn not_sql() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "[^a-z0-9_]+".to_owned())
}
fn leading_not_sql() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "^[^a-z_]+".to_owned())
}

pub fn sanitize_service_name(value: &str) -> String {
    let cleaned = value.to_lowercase();
    let cleaned = not_alpha().replace_all(&cleaned, "-");
    let cleaned = leading_not_alpha().replace(&cleaned, "");
    let cleaned = trailing_dash().replace_all(&cleaned, "");
    let cleaned = double_dash().replace_all(&cleaned, "-");
    if cleaned.is_empty() {
        "db".to_owned()
    } else {
        cleaned.into_owned()
    }
}

pub fn sanitize_sql_identifier(value: &str) -> String {
    let cleaned = value.to_lowercase();
    let cleaned = not_sql().replace_all(&cleaned, "_");
    let cleaned = leading_not_sql().replace(&cleaned, "");
    if cleaned.is_empty() {
        "app".to_owned()
    } else {
        cleaned.into_owned()
    }
}

pub fn propose_postgres_service(database: &str, reason: &str, service_name: &str) -> JsValue {
    let db = sanitize_sql_identifier(database);
    let name = sanitize_service_name(service_name);
    let mut environment = JsObject::new();
    environment.set("POSTGRES_DB", JsValue::Str(db.clone()));
    environment.set("POSTGRES_USER", JsValue::Str(db.clone()));
    environment.set("POSTGRES_PASSWORD", JsValue::Str(db.clone()));
    let healthcheck = obj_value(vec![
        ("test", JsValue::Arr(vec![JsValue::Str("CMD-SHELL".into()), JsValue::Str(format!("pg_isready -U {db} -d {db}"))])),
        ("interval", JsValue::Str("2s".into())),
        ("timeout", JsValue::Str("3s".into())),
        ("retries", JsValue::Num(30.0)),
    ]);
    let mut volumes = JsObject::new();
    volumes.set(&format!("{name}-data"), JsValue::Str("/var/lib/postgresql/data".into()));
    obj_value(vec![
        ("name", JsValue::Str(name)),
        ("engine", JsValue::Str("postgres".into())),
        ("image", JsValue::Str("postgres:17-alpine".into())),
        ("environment", JsValue::Obj(environment)),
        ("healthcheck", healthcheck),
        ("dependsOn", JsValue::Arr(Vec::new())),
        ("volumes", JsValue::Obj(volumes)),
        ("envFiles", JsValue::Arr(Vec::new())),
        ("notes", JsValue::Arr(Vec::new())),
        ("proposed", JsValue::Bool(true)),
        ("reason", JsValue::Str(reason.to_owned())),
    ])
}

fn jpa_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "spring-boot-starter-data-jpa".to_owned())
}
fn postgresql_i() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "(?i-u:postgresql)".to_owned())
}
fn psycopg_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "(?i-u:psycopg2?)(?:$|[^A-Za-z0-9_])".to_owned())
}
fn sqlalchemy_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "(?i-u:sqlalchemy)".to_owned())
}
fn postgres_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "(?i-u:postgres)".to_owned())
}

pub fn suggests_postgres_need(template: &str, dependency_text: &str) -> bool {
    if template == "spring-boot" {
        return jpa_re().is_match(dependency_text) && postgresql_i().is_match(dependency_text);
    }
    psycopg_re().is_match(dependency_text) || (sqlalchemy_re().is_match(dependency_text) && postgres_re().is_match(dependency_text))
}

fn env_ref_postgres() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"(?i-u:jdbc:postgresql|postgresql://|org\.postgresql)|(?i-u:psycopg2?)(?:$|[^A-Za-z0-9_])".to_owned())
}

fn env_ref_mysql() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "(?i-u:jdbc:mysql|mysql://|pymysql|mysqlclient|mysql-connector)".to_owned())
}
fn env_ref_redis() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"(?i-u:spring\.(data\.)?redis|REDIS_(HOST|URL|PORT)|redis://)|(?:^|[^A-Za-z0-9_])(?i-u:redis)(?:$|[^A-Za-z0-9_])".to_owned())
}
fn env_ref_kafka() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || {
        r"(?i-u:spring\.kafka|KAFKA_BOOTSTRAP|kafka://|bootstrap[-._]?servers)|(?:^|[^A-Za-z0-9_])(?i-u:kafka)(?:$|[^A-Za-z0-9_])".to_owned()
    })
}

pub fn detect_env_references(config_text: &str) -> JsValue {
    obj_value(vec![
        ("postgres", JsValue::Bool(env_ref_postgres().is_match(config_text))),
        ("mysql", JsValue::Bool(env_ref_mysql().is_match(config_text))),
        ("redis", JsValue::Bool(env_ref_redis().is_match(config_text))),
        ("kafka", JsValue::Bool(env_ref_kafka().is_match(config_text))),
    ])
}

// ───────────────────────── 접속 정보 ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct DbCredentials {
    pub database: String,
    pub user: String,
    pub password: Option<String>,
}

pub fn credentials_value(credentials: &DbCredentials) -> JsValue {
    let mut o = JsObject::new();
    o.set("database", JsValue::Str(credentials.database.clone()));
    o.set("user", JsValue::Str(credentials.user.clone()));
    if let Some(password) = &credentials.password {
        o.set("password", JsValue::Str(password.clone()));
    }
    JsValue::Obj(o)
}

fn with_default_env() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || format!(r"^\$\{{[A-Za-z_][A-Za-z0-9_]*:-({JS_DOT}*)\}}$"))
}
fn plain_env_var() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$".to_owned())
}

/// `${VAR:-기본값}`은 기본값 글자를, `${VAR}`은 `undefined`를, 그 밖은 원래 값을 돌려준다.
/// 값의 타입을 지킨다(`firstDefined`가 JS 진릿값으로 거르고, `withDevDefaultCredentials`는 `undefined`만 채운다)
fn resolve_compose_var(raw: Option<&JsValue>) -> Option<JsValue> {
    let raw = raw?;
    let value = text(raw);
    if let Some(caps) = with_default_env().captures(&value) {
        return Some(JsValue::Str(caps[1].to_owned()));
    }
    if plain_env_var().is_match(&value) {
        return None;
    }
    Some(raw.clone())
}

fn first_defined(environment: &JsObject, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = resolve_compose_var(environment.get(key)) {
            if value.truthy() {
                return Some(text(&value));
            }
        }
    }
    None
}

fn mysql_like_credentials(environment: &JsObject) -> Option<DbCredentials> {
    let database = first_defined(environment, &["MYSQL_DATABASE", "MARIADB_DATABASE"])?;
    let user = first_defined(environment, &["MYSQL_USER", "MARIADB_USER"]);
    let password = first_defined(environment, &["MYSQL_PASSWORD", "MARIADB_PASSWORD"]);
    if let Some(user) = user {
        return Some(DbCredentials { database, user, password });
    }
    let root_password = first_defined(environment, &["MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD"])?;
    Some(DbCredentials { database, user: "root".to_owned(), password: Some(root_password) })
}

fn postgres_credentials(environment: &JsObject) -> DbCredentials {
    let user = first_defined(environment, &["POSTGRES_USER"]).unwrap_or_else(|| "postgres".to_owned());
    let database = first_defined(environment, &["POSTGRES_DB"]).unwrap_or_else(|| user.clone());
    let password = first_defined(environment, &["POSTGRES_PASSWORD"]);
    DbCredentials { database, user, password }
}

pub fn database_credentials_for(engine: &str, environment: &JsObject) -> Option<DbCredentials> {
    match engine {
        "postgres" => Some(postgres_credentials(environment)),
        "mysql" | "mariadb" => mysql_like_credentials(environment),
        _ => None,
    }
}

fn credentialed_engine(engine: &str) -> bool {
    matches!(engine, "postgres" | "mysql" | "mariadb")
}

fn environment_of(service: &JsValue) -> JsObject {
    match service.prop("environment") {
        Some(JsValue::Obj(o)) => o.clone(),
        _ => JsObject::new(),
    }
}

fn engine_of(service: &JsValue) -> String {
    str_field(service, "engine").unwrap_or("").to_owned()
}

/// 템플릿 글자에 넣을 필드 값. 없는 필드는 JS처럼 `undefined` 글자가 된다
fn field_text(service: &JsValue, key: &str) -> String {
    service.prop(key).map(text).unwrap_or_else(|| "undefined".to_owned())
}

pub fn needs_dev_default_credentials(engine: &str, environment: &JsObject) -> bool {
    if !credentialed_engine(engine) {
        return false;
    }
    match database_credentials_for(engine, environment) {
        None => true,
        Some(credentials) => credentials.password.is_none(),
    }
}

fn default_credentials(engine: &str) -> &'static [(&'static str, &'static str)] {
    match engine {
        "postgres" => &[("POSTGRES_DB", "app"), ("POSTGRES_USER", "app"), ("POSTGRES_PASSWORD", "app")],
        "mysql" | "mariadb" => &[
            ("MYSQL_DATABASE", "app"),
            ("MYSQL_USER", "app"),
            ("MYSQL_PASSWORD", "app"),
            ("MYSQL_ROOT_PASSWORD", "root"),
        ],
        _ => &[],
    }
}

pub fn with_dev_default_credentials(service: &JsValue, note: &str) -> Result<JsValue, String> {
    let JsValue::Obj(source) = service else { return Err("서비스가 객체가 아닙니다".to_owned()) };
    let engine = engine_of(service);
    if !credentialed_engine(&engine) {
        return Ok(service.clone());
    }
    let mut environment = environment_of(service);
    for (key, value) in default_credentials(&engine) {
        if resolve_compose_var(environment.get(key)).is_none() {
            environment.set(key, JsValue::Str((*value).to_owned()));
        }
    }
    // 옛 코드는 `[...service.notes, note]`였다: 없는 notes는 던지고, 문자열은 글자 단위로 펼친다
    let mut notes: Vec<JsValue> = match source.get("notes") {
        Some(JsValue::Arr(items)) => items.clone(),
        Some(JsValue::Str(text)) => text.chars().map(|c| JsValue::Str(c.to_string())).collect(),
        None | Some(JsValue::Null) => return Err("서비스에 notes가 없습니다".to_owned()),
        Some(_) => return Err("서비스의 notes가 배열이 아닙니다".to_owned()),
    };
    notes.push(JsValue::Str(note.to_owned()));
    let mut result = source.clone();
    result.set("environment", JsValue::Obj(environment));
    result.set("notes", JsValue::Arr(notes));
    Ok(JsValue::Obj(result))
}

fn healthcheck_value(engine: &str, environment: &JsObject) -> Option<JsValue> {
    match engine {
        "postgres" => {
            let credentials = postgres_credentials(environment);
            Some(obj_value(vec![
                (
                    "test",
                    JsValue::Arr(vec![
                        JsValue::Str("CMD-SHELL".into()),
                        JsValue::Str(format!("pg_isready -U {} -d {}", credentials.user, credentials.database)),
                    ]),
                ),
                ("interval", JsValue::Str("2s".into())),
                ("timeout", JsValue::Str("3s".into())),
                ("retries", JsValue::Num(30.0)),
            ]))
        }
        "mysql" | "mariadb" => {
            let credentials = mysql_like_credentials(environment)?;
            let password = credentials.password?;
            Some(obj_value(vec![
                (
                    "test",
                    JsValue::Arr(vec![
                        JsValue::Str("CMD".into()),
                        JsValue::Str("mysqladmin".into()),
                        JsValue::Str("ping".into()),
                        JsValue::Str("-h".into()),
                        JsValue::Str("localhost".into()),
                        JsValue::Str(format!("-u{}", credentials.user)),
                        JsValue::Str(format!("-p{}", password)),
                    ]),
                ),
                ("interval", JsValue::Str("5s".into())),
                ("timeout", JsValue::Str("3s".into())),
                ("retries", JsValue::Num(10.0)),
            ]))
        }
        "redis" | "valkey" => Some(obj_value(vec![
            ("test", JsValue::Arr(vec![JsValue::Str("CMD".into()), JsValue::Str("redis-cli".into()), JsValue::Str("ping".into())])),
            ("interval", JsValue::Str("2s".into())),
            ("timeout", JsValue::Str("3s".into())),
            ("retries", JsValue::Num(10.0)),
        ])),
        _ => None,
    }
}

pub fn with_default_healthcheck(service: &JsValue) -> Result<JsValue, String> {
    if truthy(service.prop("healthcheck")) {
        return Ok(service.clone());
    }
    let healthcheck = healthcheck_value(&engine_of(service), &environment_of(service));
    let Some(healthcheck) = healthcheck else { return Ok(service.clone()) };
    let JsValue::Obj(mut result) = service.clone() else { return Err("서비스가 객체가 아닙니다".to_owned()) };
    result.set("healthcheck", healthcheck);
    Ok(JsValue::Obj(result))
}

// ───────────────────────── 앱 환경 배선 ─────────────────────────

fn custom_port_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"^(?:--port|-p)=([0-9]+)$".to_owned())
}
fn digits_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"^[0-9]+$".to_owned())
}
fn ws_split_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || format!("[{JS_WS}]+"))
}

fn custom_port_from(command: Option<&JsValue>) -> Result<Option<f64>, String> {
    let Some(command) = command else { return Ok(None) };
    let tokens: Vec<String> = match command {
        JsValue::Arr(items) => items.iter().map(text).collect(),
        JsValue::Str(value) => ws_split_re().split(value).map(str::to_owned).collect(),
        // 옛 코드는 `command.split`을 불러 TypeError를 냈다
        _ => return Err("command가 문자열이나 배열이 아닙니다".to_owned()),
    };
    for index in 0..tokens.len() {
        let token = &tokens[index];
        if let Some(caps) = custom_port_re().captures(token) {
            return Ok(Some(js::to_number(&caps[1])));
        }
        if (token == "--port" || token == "-p") && tokens.get(index + 1).is_some_and(|next| digits_re().is_match(next)) {
            return Ok(Some(js::to_number(&tokens[index + 1])));
        }
    }
    Ok(None)
}

fn listener_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"^[A-Za-z0-9_]+://([^:,]+):([0-9]+)$".to_owned())
}

fn kafka_bootstrap_for(service_name: &str, environment: &JsObject) -> Result<(String, bool), String> {
    let raw = environment.get("KAFKA_ADVERTISED_LISTENERS").or_else(|| environment.get("KAFKA_CFG_ADVERTISED_LISTENERS"));
    let listeners: Vec<String> = match raw {
        None | Some(JsValue::Null) => Vec::new(),
        Some(JsValue::Str(raw)) => raw.split(',').map(str::to_owned).collect(),
        Some(_) => return Err("Kafka 광고 리스너가 문자열이 아닙니다".to_owned()),
    };
    for listener in listeners {
        if let Some(caps) = listener_re().captures(js_trim(&listener)) {
            if &caps[1] == service_name {
                return Ok((format!("{}:{}", &caps[1], &caps[2]), false));
            }
        }
    }
    Ok((format!("{service_name}:{}", engine_default_port("kafka").unwrap_or(9092.0) as i64), true))
}

fn infra_by_engine<'a>(infra: &'a [JsValue], engine: &str) -> Option<&'a JsValue> {
    infra.iter().find(|service| engine_of(service) == engine)
}

fn notes_len(service: &JsValue) -> usize {
    // 옛 코드는 `db.notes?.length ?? 0`이었다(문자열이면 글자 수)
    match service.prop("notes") {
        Some(JsValue::Arr(items)) => items.len(),
        Some(JsValue::Str(text)) => text.encode_utf16().count(),
        _ => 0,
    }
}

pub fn wire_app_environment(template: &str, refs: &JsValue, infra: &JsValue) -> Result<JsValue, String> {
    let empty: Vec<JsValue> = Vec::new();
    let infra_items: &[JsValue] = match infra {
        JsValue::Arr(items) => items,
        JsValue::Null => &empty,
        _ => return Err("인프라 목록이 배열이 아닙니다".to_owned()),
    };
    let mut environment = JsObject::new();
    let mut notes: Vec<String> = Vec::new();
    let mut depends_on: Vec<String> = Vec::new();
    let spring = template == "spring-boot";

    if truthy(refs.prop("postgres")) || truthy(refs.prop("mysql")) {
        let db = if truthy(refs.prop("postgres")) {
            infra_by_engine(infra_items, "postgres")
        } else {
            infra_by_engine(infra_items, "mysql").or_else(|| infra_by_engine(infra_items, "mariadb"))
        };
        if let Some(db) = db {
            let name = field_text(db, "name");
            depends_on.push(name.clone());
            let scheme = if engine_of(db) == "postgres" { "postgresql" } else { "mysql" };
            let port = custom_port_from(db.prop("command"))?.or_else(|| engine_default_port(&engine_of(db)));
            let port_text = port.map(js::number_to_string).unwrap_or_else(|| "undefined".to_owned());
            let credentials = database_credentials_for(&engine_of(db), &environment_of(db));
            if let Some(credentials) = credentials {
                let auth = match &credentials.password {
                    Some(password) => format!("{}:{}", credentials.user, password),
                    None => credentials.user.clone(),
                };
                if spring {
                    environment.set("SPRING_DATASOURCE_URL", JsValue::Str(format!("jdbc:{scheme}://{name}:{port_text}/{}", credentials.database)));
                    environment.set("SPRING_DATASOURCE_USERNAME", JsValue::Str(credentials.user.clone()));
                    if let Some(password) = &credentials.password {
                        environment.set("SPRING_DATASOURCE_PASSWORD", JsValue::Str(password.clone()));
                    }
                } else {
                    environment.set("DATABASE_URL", JsValue::Str(format!("{scheme}://{auth}@{name}:{port_text}/{}", credentials.database)));
                }
                notes.push(if credentials.password.is_none() {
                    format!("{name}에서 비밀번호를 찾지 못했습니다(신뢰 인증이거나 compose 밖에서 설정). 필요하면 직접 채우세요")
                } else if notes_len(db) > 0 {
                    format!("{name}은(는) 개발용 기본값을 쓰고 있습니다(부가 서비스 목록의 메모를 보세요). 운영 배포 전에 반드시 바꾸세요")
                } else {
                    format!("데이터베이스 접속 정보는 {name}의 환경 변수에서 그대로 가져왔습니다. 값이 바뀌면 함께 고치세요")
                });
            } else {
                notes.push(format!("{name}의 데이터베이스·계정 정보를 compose 환경 변수에서 찾지 못해 접속 정보를 채우지 못했습니다. 직접 확인하세요"));
            }
        }
    }
    if truthy(refs.prop("redis")) {
        let redis = infra_by_engine(infra_items, "redis").or_else(|| infra_by_engine(infra_items, "valkey"));
        if let Some(redis) = redis {
            let name = field_text(redis, "name");
            depends_on.push(name.clone());
            let port = custom_port_from(redis.prop("command"))?.or_else(|| engine_default_port(&engine_of(redis)));
            let port_text = port.map(js::number_to_string).unwrap_or_else(|| "undefined".to_owned());
            if spring {
                environment.set("SPRING_DATA_REDIS_HOST", JsValue::Str(name));
            } else {
                environment.set("REDIS_HOST", JsValue::Str(name.clone()));
                environment.set("REDIS_URL", JsValue::Str(format!("redis://{name}:{port_text}")));
            }
            notes.push("Redis 연결 환경 변수 이름은 추측입니다(REDIS_HOST/REDIS_URL). 코드가 읽는 이름과 맞는지 확인하세요".to_owned());
        }
    }
    if truthy(refs.prop("kafka")) {
        if let Some(kafka) = infra_by_engine(infra_items, "kafka") {
            let name = field_text(kafka, "name");
            depends_on.push(name.clone());
            let (bootstrap, guessed) = kafka_bootstrap_for(&name, &environment_of(kafka))?;
            if spring {
                environment.set("SPRING_KAFKA_BOOTSTRAP_SERVERS", JsValue::Str(bootstrap.clone()));
            } else {
                environment.set("KAFKA_BOOTSTRAP_SERVERS", JsValue::Str(bootstrap.clone()));
            }
            notes.push(if guessed {
                "Kafka 부트스트랩 주소는 기본 포트(9092)로 추측했습니다. compose의 리스너 설정이 다르면 고치세요".to_owned()
            } else {
                format!("Kafka 부트스트랩 주소는 {name}의 KAFKA_ADVERTISED_LISTENERS에서 컨테이너 사이 리스너({bootstrap})를 찾아 채웠습니다")
            });
        }
    }

    let mut unique: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for name in depends_on {
        if seen.insert(name.clone()) {
            unique.push(name);
        }
    }
    Ok(obj_value(vec![
        ("environment", JsValue::Obj(environment)),
        ("notes", strings(notes)),
        ("dependsOn", strings(unique)),
    ]))
}

fn sql_identifier() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "^[A-Za-z_][A-Za-z0-9_]{0,62}$".to_owned())
}

pub fn database_spec_for(engine: &str, environment: &JsObject) -> Option<JsValue> {
    if engine != "postgres" {
        return None;
    }
    let database = environment.get("POSTGRES_DB").map(text).filter(|value| !value.is_empty())?;
    let user = environment.get("POSTGRES_USER").map(text).filter(|value| !value.is_empty())?;
    if sql_identifier().is_match(&database) && sql_identifier().is_match(&user) {
        return Some(obj_value(vec![("database", JsValue::Str(database)), ("user", JsValue::Str(user))]));
    }
    None
}

// ───────────────────────── 프론트엔드↔백엔드 주소 ─────────────────────────

fn suffix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || format!("[0-9]+\\}}*(\\/[^}}$\\\"'{}]*)", JS_WS))
}

pub fn suffix_from_url_value(value: &str) -> String {
    let mut suffix = String::new();
    for caps in suffix_re().captures_iter(value) {
        suffix = caps[1].to_owned();
    }
    suffix
}

fn frontend_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"(?i-u)^(NEXT_PUBLIC|VITE|REACT_APP)_[A-Za-z0-9_]*(API|BACKEND|SERVER|BASE_URL)[A-Za-z0-9_]*$".to_owned())
}

pub fn frontend_backend_env_name(name: &str) -> bool {
    frontend_name_re().is_match(name)
}

fn backend_url_value(env_key: &str, value: &str) -> JsValue {
    backend_url_value_from_suffix(env_key, &suffix_from_url_value(value))
}

fn backend_url_value_from_suffix(env_key: &str, suffix: &str) -> JsValue {
    obj_value(vec![("envKey", JsValue::Str(env_key.to_owned())), ("suffix", JsValue::Str(suffix.to_owned()))])
}

pub fn detect_backend_url_env_from_environment(environment: &JsObject) -> Result<Option<JsValue>, String> {
    for (key, value) in environment.entries_js_order() {
        if frontend_backend_env_name(key) {
            let JsValue::Str(value) = value else {
                // 옛 TS는 `value.matchAll`을 불러 TypeError를 냈다. 문자열이 아닌 값을 조용히 바꾸지 않는다
                return Err(format!("'{key}' 환경 변수 값이 문자열이 아닙니다"));
            };
            return Ok(Some(backend_url_value(key, value)));
        }
    }
    Ok(None)
}

fn env_access_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"process\.env\.([A-Za-z_][A-Za-z0-9_]*)".to_owned())
}
fn string_literal_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r#"["'`](https?://[^"'`]+)["'`]"#.to_owned())
}

pub fn detect_backend_url_env_from_code(source_text: &str) -> Option<JsValue> {
    for line in source_text.split('\n') {
        let Some(access) = env_access_re().captures(line) else { continue };
        let name = &access[1];
        if !frontend_backend_env_name(name) {
            continue;
        }
        let suffix = string_literal_re().captures(line).map(|literal| suffix_from_url_value(&literal[1])).unwrap_or_default();
        return Some(backend_url_value_from_suffix(name, &suffix));
    }
    None
}

fn server_fragments() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| ["API", "BACKEND", "SERVER", "SPRING", "URL", "HOST", "BASE"].into_iter().collect())
}

fn looks_like_server_backend_env_name(name: &str) -> bool {
    name.split('_').any(|token| server_fragments().contains(token.to_ascii_uppercase().as_str()))
}

fn port_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r":([0-9]+)(?:[^0-9]|$)".to_owned())
}

fn port_from_url_value(value: &str) -> Option<f64> {
    port_re().captures(value).map(|caps| js::to_number(&caps[1]))
}

fn server_backend_url_value(env_key: &str, literal_value: &str) -> JsValue {
    let mut o = JsObject::new();
    o.set("envKey", JsValue::Str(env_key.to_owned()));
    o.set("suffix", JsValue::Str(suffix_from_url_value(literal_value)));
    if let Some(port) = port_from_url_value(literal_value) {
        o.set("port", JsValue::Num(port));
    }
    JsValue::Obj(o)
}

pub fn detect_server_backend_url_env_from_code(source_text: &str) -> Option<JsValue> {
    for line in source_text.split('\n') {
        let Some(access) = env_access_re().captures(line) else { continue };
        let name = &access[1];
        if frontend_backend_env_name(name) || !looks_like_server_backend_env_name(name) {
            continue;
        }
        let Some(literal) = string_literal_re().captures(line) else { continue };
        return Some(server_backend_url_value(name, &literal[1]));
    }
    None
}

fn assignment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || format!(r#"(?:^|[\n\r\u{{2028}}\u{{2029}}"'{JS_WS}])([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^{JS_WS}]+)"#))
}

fn strip_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && (bytes[0] == b'"' || bytes[0] == b'\'') && bytes[bytes.len() - 1] == bytes[0] {
        let inner = &value[1..value.len() - 1];
        if !inner.chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
            return inner;
        }
    }
    value
}

fn http_scheme_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || r"^https?://".to_owned())
}

pub fn detect_backend_url_env_from_assignments(source_text: &str) -> Option<JsValue> {
    for caps in assignment_re().captures_iter(source_text) {
        let name = &caps[1];
        let value = strip_quotes(&caps[2]);
        if !http_scheme_re().is_match(value) {
            continue;
        }
        let mut public = false;
        if frontend_backend_env_name(name) {
            public = true;
        } else if !looks_like_server_backend_env_name(name) {
            continue;
        }
        let mut o = JsObject::new();
        o.set("envKey", JsValue::Str(name.to_owned()));
        o.set("suffix", JsValue::Str(suffix_from_url_value(value)));
        if let Some(port) = port_from_url_value(value) {
            o.set("port", JsValue::Num(port));
        }
        o.set("public", JsValue::Bool(public));
        return Some(JsValue::Obj(o));
    }
    None
}

// ───────────────────────── compose 텍스트 읽기 ─────────────────────────

fn services_of<'a>(doc: &'a JsValue) -> Option<&'a JsValue> {
    doc.prop("services").filter(|services| object_like(services))
}

fn service_of<'a>(services: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match services {
        JsValue::Obj(o) => o.get(name),
        JsValue::Arr(items) => crate::js_json::array_index(name).and_then(|index| items.get(index as usize)),
        _ => None,
    }
}

fn environment_value_from_doc(doc: &JsValue, service_name: &str) -> Option<JsValue> {
    let services = services_of(doc)?;
    let service = service_of(services, service_name)?;
    if !object_like(service) {
        return None;
    }
    let environment = normalize_environment(service.prop("environment"));
    if environment.entries().is_empty() {
        None
    } else {
        Some(JsValue::Obj(environment))
    }
}

pub fn environment_from_compose_text(compose_text: &str, service_name: &str) -> Option<JsValue> {
    let doc = yaml_value(compose_text)?;
    environment_value_from_doc(&doc, service_name)
}

fn normalize_context(context: Option<&str>) -> String {
    let value = context.unwrap_or(".");
    let value = value.strip_prefix("./").unwrap_or(value);
    let value = value.trim_end_matches('/');
    if value.is_empty() {
        ".".to_owned()
    } else {
        value.to_owned()
    }
}

fn build_context(build: Option<&JsValue>) -> Option<String> {
    match build {
        Some(JsValue::Str(s)) => Some(s.clone()),
        Some(JsValue::Obj(o)) => o.get("context").and_then(JsValue::as_str).map(str::to_owned),
        _ => None,
    }
}

pub fn original_compose_service_for(compose_text: &str, service_path: &str, service_name: &str) -> Option<JsValue> {
    let doc = yaml_value(compose_text)?;
    let services = services_of(&doc)?;
    let normalized_path = normalize_context(Some(service_path));
    for (name, raw) in entry_list(services) {
        if !object_like(raw) {
            continue;
        }
        if normalize_context(build_context(raw.prop("build")).as_deref()) == normalized_path {
            let environment = environment_value_from_doc(&doc, &name).unwrap_or_else(|| JsValue::Obj(JsObject::new()));
            return Some(obj_value(vec![("name", JsValue::Str(name)), ("environment", environment)]));
        }
    }
    let by_name = service_of(services, service_name)?;
    if !object_like(by_name) {
        return None;
    }
    let environment = environment_value_from_doc(&doc, service_name).unwrap_or_else(|| JsValue::Obj(JsObject::new()));
    Some(obj_value(vec![("name", JsValue::Str(service_name.to_owned())), ("environment", environment)]))
}

fn cors_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    once(&RE, || "(?i-u)cors".to_owned())
}

pub fn cors_environment_from(environment: &JsObject) -> JsValue {
    let mut out = JsObject::new();
    for (key, value) in environment.entries_js_order() {
        if cors_re().is_match(key) {
            out.set(key, value.clone());
        }
    }
    JsValue::Obj(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(json: &str) -> JsObject {
        match crate::js_json::parse_native(json).unwrap() {
            JsValue::Obj(o) => o,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn 이미지에서_엔진을_찾는다() {
        assert_eq!(engine_of_image("postgres:17-alpine"), Some("postgres"));
        assert_eq!(engine_of_image("apache/kafka:3.8.0"), Some("kafka"));
        assert_eq!(engine_of_image("quay.io/minio/minio:RELEASE"), Some("minio"));
        assert_eq!(engine_of_image("localhost:5000/postgres:16"), Some("postgres"));
        assert_eq!(engine_of_image("mcr.microsoft.com/mssql/server:2022"), None);
    }

    #[test]
    fn 부가_서비스를_가져오고_뺀_이유를_남긴다() {
        let text = "services:\n  mysql:\n    image: mysql:8.4\n    environment:\n      MYSQL_DATABASE: becommerce\n  app:\n    build: .\n  mon:\n    image: prom/prometheus\n    profiles: [monitoring]\n  odd:\n    environment: {}\n";
        let result = import_supporting_services(text, "compose.yaml");
        let services = result.prop("services").unwrap();
        let JsValue::Arr(services) = services else { panic!() };
        assert_eq!(services.len(), 1);
        assert_eq!(services[0].prop("name").and_then(JsValue::as_str), Some("mysql"));
        let skipped = result.prop("skipped").unwrap();
        let JsValue::Arr(skipped) = skipped else { panic!() };
        assert_eq!(skipped.len(), 3);
    }

    #[test]
    fn 접속_정보는_값을_지어내지_않는다() {
        let env = obj(r#"{"MYSQL_DATABASE":"app"}"#);
        assert_eq!(database_credentials_for("mysql", &env), None);
        let env = obj(r#"{"MYSQL_DATABASE":"app","MYSQL_ROOT_PASSWORD":"root"}"#);
        assert_eq!(database_credentials_for("mysql", &env).unwrap().user, "root");
        let env = obj(r#"{"POSTGRES_PASSWORD":"${PW:-dev}"}"#);
        assert_eq!(database_credentials_for("postgres", &env).unwrap().password.as_deref(), Some("dev"));
        assert_eq!(database_credentials_for("postgres", &obj("{}")).unwrap().database, "postgres");
    }

    #[test]
    fn 앱_환경_배선은_실제_값을_쓴다() {
        let refs = obj(r#"{"postgres":true,"mysql":false,"redis":true,"kafka":true}"#);
        let infra = crate::js_json::parse_native(
            r#"[{"name":"db","engine":"postgres","environment":{"POSTGRES_DB":"orders","POSTGRES_USER":"orders","POSTGRES_PASSWORD":"secret"}},{"name":"cache","engine":"redis","environment":{}},{"name":"broker","engine":"kafka","environment":{"KAFKA_ADVERTISED_LISTENERS":"PLAINTEXT://localhost:9092,INTERNAL://broker:29092"}}]"#,
        )
        .unwrap();
        let result = wire_app_environment("spring-boot", &JsValue::Obj(refs), &infra).unwrap();
        let environment = result.prop("environment").unwrap();
        assert_eq!(environment.prop("SPRING_DATASOURCE_URL").and_then(JsValue::as_str), Some("jdbc:postgresql://db:5432/orders"));
        assert_eq!(environment.prop("SPRING_KAFKA_BOOTSTRAP_SERVERS").and_then(JsValue::as_str), Some("broker:29092"));
    }

    #[test]
    fn 설정_문구에서_인프라를_짐작한다() {
        let refs = detect_env_references("spring.datasource.url=jdbc:postgresql://localhost:5432/app\nspring.data.redis.host=localhost\nspring.kafka.bootstrap-servers=localhost:9092");
        assert!(refs.prop("postgres").unwrap().truthy());
        assert!(refs.prop("redis").unwrap().truthy());
        assert!(refs.prop("kafka").unwrap().truthy());
        assert!(!refs.prop("mysql").unwrap().truthy());
        // JS \b는 ASCII 기준이라 한글 뒤에서도 경계다
        assert!(detect_env_references("redis한").prop("redis").unwrap().truthy());
    }

    #[test]
    fn 주소_접미사와_환경_변수_감지는_js와_같다() {
        assert_eq!(suffix_from_url_value("http://localhost:${P:-8080}/api"), "/api");
        assert_eq!(suffix_from_url_value("http://localhost:8080"), "");
        assert!(frontend_backend_env_name("NEXT_PUBLIC_API_BASE_URL"));
        assert!(!frontend_backend_env_name("NEXT_PUBLIC_SITE_NAME"));
        assert_eq!(
            detect_backend_url_env_from_assignments("API_MODE=real SPRING_API=http://localhost:8080 npm run dev")
                .unwrap()
                .prop("envKey")
                .and_then(JsValue::as_str),
            Some("SPRING_API")
        );
    }
}
