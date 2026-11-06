//! 무중단 배포 계획의 판정(ADR-191 2단계 2b-2b 셋째 묶음, #1036). 옛 `packages/sandbox/src/docker/deploy-plan.ts`.
//!
//! 무엇을 어떻게 띄울지 정한다: 기반 스택(DB 등)과 릴리스 스택의 compose 내용, 운영 이미지의 빌드 인자, 빌드 출력에서 원인 줄
//! 고르기, 프록시 설정, 정리할 릴리스·남길 기록. 빌드·`compose up`·전환·정리(`deploy.ts`)는 TS에 남는다.
//!
//! compose 내용은 YAML로 쓰이므로 객체 키 순서와 `$`→`$$` 이스케이프가 글자를 정한다. JS 객체의 순서(정수 꼴 키가 먼저, 덮어써도
//! 처음 자리)와 같게 만든다. TS는 결과를 `JSON.parse`로 받아 JS가 순서를 다시 정하지만, Rust 단독 시험이 이 순서를 고정한다.
//!
//! 읽는 규칙은 옛 TS와 같다: `??`는 없거나 null일 때만, `x ? a : b`는 JS 진릿값, `` `${v}` ``는 `String(v)`.
//! 의도한 차이(모두 던지는 쪽이거나 자기 속성만 보는 쪽):
//!  - 모양이 어긋난 입력(객체가 아닌 서비스, 배열이 아닌 `volumes`, 객체가 아닌 `environment`·`depends_on`, 문자열이 아닌 프로젝트
//!    이름, 수도 문자열도 아닌 managed 포트 등)은 던진다. 옛 TS는 문자열을 글자 단위로 펼치거나 `undefined`를 이어 붙이거나 `TypeError`였다.
//!  - `images`·`resources`·`config.volumes`는 자기 속성만 본다. 옛 TS는 서비스 이름이 `constructor`·`toString`이면 상속된 함수를 읽었다.
//!  - 데이터베이스 엔진의 데이터 폴더도 자기 항목만 본다(`constructor` 같은 엔진 이름은 폴더가 없다).
//!  - `trimRecords`는 문자열이 아닌 `id`를 `active`와 같다고 보지 않는다(옛 TS는 `active`가 `undefined`일 때 `id`가 없는 항목과 같다고 읽었다).
//!
//! `__proto__` 키: JS의 `obj['__proto__'] = v`는 자기 속성이 없으면 속성을 만들지 않고 프로토타입을 바꾼다. 그래서 결과에 나타나지
//! 않는다. `assign`이 그 규칙을 따른다(자기 속성이 이미 있으면 값만 바꾼다). null을 넣어 프로토타입을 없애는 경우만 `assign_null`이 따로 센다.

use crate::js;
use crate::js_json::{JsObject, JsValue};

/// 운영 주소를 고정하는 프록시 컨테이너 안에서 서비스마다 듣는 포트의 시작 번호
const PROXY_LISTEN_BASE: f64 = 10_000.0;
/// 기록에 남기는 릴리스 수
const MAX_RECORDS: usize = 20;
/// 데이터베이스 엔진별 데이터 폴더(이름 붙인 볼륨으로 배포 사이에 남긴다)
const POSTGRES_DATA_DIRECTORY: &str = "/var/lib/postgresql/data";

// ── 이름

pub fn empty_deploy_state(project: &str) -> JsValue {
    let mut o = JsObject::new();
    o.set("version", JsValue::Num(1.0));
    o.set("project", JsValue::str(project));
    o.set("ports", JsValue::Obj(JsObject::new()));
    o.set("releases", JsValue::Arr(Vec::new()));
    o.set("history", JsValue::Arr(Vec::new()));
    JsValue::Obj(o)
}

pub fn base_name(project: &str) -> String {
    format!("bsd-{project}-base")
}

pub fn release_name(project: &str, id: &str) -> String {
    format!("bsd-{project}-{id}")
}

pub fn proxy_name(project: &str) -> String {
    format!("bsd-{project}-proxy")
}

pub fn image_name(project: &str, service: &str, id: &str) -> String {
    format!("b-studio-deploy/{project}-{service}:{id}")
}

pub fn container_name(compose_project: &str, service: &str) -> String {
    format!("{compose_project}-{service}-1")
}

/// 초 단위까지의 UTC 시각(`r20260912001507`). `ms`는 `Date.getTime()`. 시각이 아닌 값(`Invalid Date`의 NaN)은 JS처럼 `NaN`이 들어간다.
/// 연도는 자릿수를 채우지 않는다(JS `getUTCFullYear()` 그대로)
pub fn new_release_id(ms: f64) -> String {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return format!("r{}", "NaN".repeat(6));
    }
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (
        in_day / 3_600_000,
        in_day % 3_600_000 / 60_000,
        in_day % 60_000 / 1000,
    );
    format!("r{year}{month:02}{day:02}{hour:02}{minute:02}{second:02}")
}

/// 1970-01-01로부터의 날짜 수 → (연, 월, 일). 양력 그대로 늘린 달력(JS `Date`와 같다)
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

pub fn proxy_listen_port(index: f64) -> f64 {
    PROXY_LISTEN_BASE + index
}

// ── JS 값을 읽는 도우미

fn obj_of<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a JsObject, String> {
    match v {
        Some(JsValue::Obj(o)) => Ok(o),
        _ => Err(format!("{what}은(는) 객체여야 합니다")),
    }
}

fn arr_of<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a [JsValue], String> {
    match v {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{what}은(는) 배열이어야 합니다")),
    }
}

fn str_of<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a str, String> {
    match v {
        Some(JsValue::Str(s)) => Ok(s),
        _ => Err(format!("{what}은(는) 문자열이어야 합니다")),
    }
}

/// 값이 없거나 null이면 None(`??`)
fn optional(v: Option<&JsValue>) -> Option<&JsValue> {
    v.filter(|x| !matches!(x, JsValue::Null))
}

fn truthy(v: Option<&JsValue>) -> bool {
    v.is_some_and(JsValue::truthy)
}

fn object(pairs: Vec<(&str, JsValue)>) -> JsObject {
    let mut o = JsObject::new();
    for (k, v) in pairs {
        o.set(k, v);
    }
    o
}

/// `obj[key] = value`. 자기 속성이 없는 `__proto__`는 속성을 만들지 않는다(프로토타입을 바꿀 뿐이다)
fn assign(o: &mut JsObject, key: &str, value: JsValue) {
    if key == "__proto__" && !o.contains_key(key) {
        return;
    }
    o.set(key, value);
}

/// `obj[key] = null`. 자기 속성이 없는 `__proto__`에 처음 null을 넣으면 프로토타입이 null이 되어(`detached`) 속성은 생기지 않는다.
/// 프로토타입이 없어진 객체에는 `__proto__` 설정자가 없으므로 그다음 대입은 보통 속성이 된다(JS 그대로)
fn assign_null(o: &mut JsObject, key: &str, detached: &mut bool) {
    if key == "__proto__" && !o.contains_key(key) && !*detached {
        *detached = true;
        return;
    }
    o.set(key, JsValue::Null);
}

/// 중첩된 모든 객체를 JS 순서(정수 꼴 키가 먼저 오름차순)로 바꾼다
fn js_ordered(value: &JsValue) -> JsValue {
    match value {
        JsValue::Arr(items) => JsValue::Arr(items.iter().map(js_ordered).collect()),
        JsValue::Obj(o) => {
            let mut out = JsObject::new();
            for (k, v) in o.entries_js_order() {
                out.set(k, js_ordered(v));
            }
            JsValue::Obj(out)
        }
        other => other.clone(),
    }
}

/// compose는 파일을 읽을 때 `$`를 다시 치환하므로, 이미 해석한 값의 `$`는 `$$`로 적는다(`escapeDollars`)
pub fn escape_dollars(value: &JsValue) -> JsValue {
    match value {
        JsValue::Str(s) => JsValue::Str(s.replace('$', "$$")),
        JsValue::Arr(items) => JsValue::Arr(items.iter().map(escape_dollars).collect()),
        JsValue::Obj(o) => {
            let mut out = JsObject::new();
            for (k, v) in o.entries_js_order() {
                out.set(k, escape_dollars(v));
            }
            JsValue::Obj(out)
        }
        other => other.clone(),
    }
}

/// `{...source.environment ?? {}}`: 객체의 속성을 JS 순서로 복사한다
fn spread_object(v: Option<&JsValue>, what: &str) -> Result<JsObject, String> {
    match optional(v) {
        None => Ok(JsObject::new()),
        Some(JsValue::Obj(o)) => {
            let mut out = JsObject::new();
            for (k, v) in o.entries_js_order() {
                out.set(k, v.clone());
            }
            Ok(out)
        }
        Some(_) => Err(format!("{what}은(는) 객체여야 합니다")),
    }
}

/// 프로젝트 이름. 없거나 null이면 `project`(`projectName`)
fn project_name(project: &JsValue) -> Result<String, String> {
    match optional(project.prop("name")) {
        None => Ok("project".to_owned()),
        Some(JsValue::Str(s)) => Ok(s.clone()),
        Some(_) => Err("프로젝트 이름은 문자열이어야 합니다".to_owned()),
    }
}

// ── 기반 스택

/// 부가 서비스(DB 등)만 담은 기반 스택. 릴리스를 바꿔도 내리지 않고, 데이터 폴더는 이름 붙인 볼륨에 둔다.
/// `project`는 `{ name?, managed: [이름], databases: [[이름, 엔진]] }`(`engine`만 꺼내 보낸다). 부가 서비스가 없으면 None
pub fn plan_base_compose(config: &JsValue, project: &JsValue) -> Result<Option<JsValue>, String> {
    let managed: Vec<&str> = arr_of(project.prop("managed"), "managed")?
        .iter()
        .map(|n| str_of(Some(n), "managed 서비스 이름"))
        .collect::<Result<_, _>>()?;
    let compose_services = obj_of(config.prop("services"), "compose services")?;
    let mut names: Vec<&str> = compose_services
        .entries()
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|name| !managed.contains(name))
        .collect();
    names.sort_by(|a, b| js::cmp_utf16(a, b));
    if names.is_empty() {
        return Ok(None);
    }
    let label_name = project_name(project)?;
    let databases = optional(project.prop("databases"));

    let mut volumes = JsObject::new();
    let mut services = JsObject::new();
    for name in names {
        let source = obj_of(
            compose_services.get(name),
            &format!("compose 서비스 {name}"),
        )?;
        let mut mounts: Vec<JsValue> = match optional(source.get("volumes")) {
            None => Vec::new(),
            Some(JsValue::Arr(items)) => items.clone(),
            Some(_) => return Err(format!("{name}의 volumes는 배열이어야 합니다")),
        };
        for mount in &mounts {
            if matches!(mount, JsValue::Null) {
                return Err(format!("{name}의 volumes 항목이 null입니다"));
            }
            if !matches!(mount.prop("type"), Some(JsValue::Str(t)) if t == "volume")
                || !truthy(mount.prop("source"))
            {
                continue;
            }
            let source_value = mount.prop("source").expect("진릿값을 확인했다");
            let key = source_value.to_js_string();
            let declared = match optional(config.prop("volumes")) {
                Some(JsValue::Obj(all)) => all.get(&key),
                _ => None,
            };
            let entry = if declared.is_some_and(|d| truthy(d.prop("external"))) {
                let declared = declared.expect("확인했다");
                let name_value = optional(declared.prop("name"))
                    .unwrap_or(source_value)
                    .clone();
                JsValue::Obj(object(vec![
                    ("external", JsValue::Bool(true)),
                    ("name", name_value),
                ]))
            } else {
                JsValue::Obj(JsObject::new())
            };
            assign(&mut volumes, &key, entry);
        }
        let engine = find_engine(databases, name)?;
        if engine.as_deref() == Some("postgres") && !mounts.iter().any(|m| matches!(m.prop("target"), Some(JsValue::Str(t)) if t == POSTGRES_DATA_DIRECTORY)) {
            let data_volume = format!("{name}-data");
            mounts.push(JsValue::Obj(object(vec![
                ("type", JsValue::str("volume")),
                ("source", JsValue::str(data_volume.clone())),
                ("target", JsValue::str(POSTGRES_DATA_DIRECTORY)),
            ])));
            assign(&mut volumes, &data_volume, JsValue::Obj(JsObject::new()));
        }
        // 부가 서비스가 managed 서비스를 기다리면 기반 스택만으로는 뜨지 못하므로 뺀다
        let mut depends_on = JsObject::new();
        match optional(source.get("depends_on")) {
            None => {}
            Some(JsValue::Obj(all)) => {
                for (dependency, value) in all.entries_js_order() {
                    if !managed.contains(&dependency) {
                        depends_on.set(dependency, value.clone());
                    }
                }
            }
            Some(_) => return Err(format!("{name}의 depends_on은 객체여야 합니다")),
        }
        let mut service = JsObject::new();
        for key in [
            "image",
            "build",
            "command",
            "entrypoint",
            "working_dir",
            "environment",
        ] {
            if truthy(source.get(key)) {
                service.set(key, source.get(key).expect("확인했다").clone());
            }
        }
        if !mounts.is_empty() {
            service.set("volumes", JsValue::Arr(mounts));
        }
        if truthy(source.get("healthcheck")) {
            service.set(
                "healthcheck",
                source.get("healthcheck").expect("확인했다").clone(),
            );
        }
        if !depends_on.entries().is_empty() {
            service.set("depends_on", JsValue::Obj(depends_on));
        }
        service.set("restart", JsValue::str("unless-stopped"));
        service.set(
            "labels",
            JsValue::Obj(object(vec![
                ("b-studio.deploy", JsValue::str(label_name.clone())),
                ("b-studio.service", JsValue::str(name)),
            ])),
        );
        services.set(name, escape_dollars(&JsValue::Obj(service)));
    }
    let mut plan = object(vec![("services", JsValue::Obj(services))]);
    if !volumes.entries().is_empty() {
        plan.set("volumes", JsValue::Obj(volumes));
    }
    Ok(Some(js_ordered(&JsValue::Obj(plan))))
}

/// `project.databases.find(([database]) => database === name)?.[1].engine`. 각 항목은 `[이름, 엔진]`(TS가 `engine`만 꺼내 보낸다)
fn find_engine(databases: Option<&JsValue>, name: &str) -> Result<Option<String>, String> {
    let Some(databases) = databases else {
        return Ok(None);
    };
    for item in arr_of(Some(databases), "databases")? {
        let JsValue::Arr(pair) = item else {
            return Err("databases 항목은 [이름, 엔진]이어야 합니다".to_owned());
        };
        if matches!(pair.first(), Some(JsValue::Str(n)) if n == name) {
            return Ok(pair.get(1).and_then(JsValue::as_str).map(str::to_owned));
        }
    }
    Ok(None)
}

// ── 릴리스 스택

/// 릴리스 스택. managed 서비스를 운영 이미지로 띄우고, 준비 확인용으로 루프백의 빈 포트에 공개한다. 개발용 소스 마운트와 명령은
/// 가져오지 않는다. `project`는 `{ name, managed: [[이름, 포트]], secrets: [[이름, 받을 서비스 목록]], resources }`
pub fn plan_release_compose(
    config: &JsValue,
    project: &JsValue,
    release_id: &str,
    images: &JsValue,
) -> Result<JsValue, String> {
    let managed_items = arr_of(project.prop("managed"), "managed")?;
    let mut managed: Vec<(&str, &JsValue)> = Vec::new();
    for item in managed_items {
        let pair = arr_of(Some(item), "managed 항목")?;
        let name = str_of(pair.first(), "managed 서비스 이름")?;
        match pair.get(1) {
            Some(port @ (JsValue::Num(_) | JsValue::Str(_))) => managed.push((name, port)),
            _ => return Err("managed 서비스의 포트는 수나 문자열이어야 합니다".to_owned()),
        }
    }
    let managed_names: Vec<&str> = managed.iter().map(|(n, _)| *n).collect();
    let mut services = JsObject::new();
    for (name, port) in &managed {
        let compose_services = obj_of(config.prop("services"), "compose services")?;
        let source = match compose_services.get(name) {
            None | Some(JsValue::Null) => JsObject::new(),
            Some(JsValue::Obj(o)) => o.clone(),
            Some(_) => return Err(format!("compose 서비스 {name}은(는) 객체여야 합니다")),
        };
        let mut environment = match escape_dollars(&JsValue::Obj(spread_object(
            source.get("environment"),
            &format!("{name}의 environment"),
        )?)) {
            JsValue::Obj(o) => o,
            _ => unreachable!("객체를 넘겼다"),
        };
        // 시크릿 값은 파일에 쓰지 않는다. 값 자리를 비워 두면 compose가 자기 프로세스 환경에서 채운다
        let mut proto_detached = false;
        for item in arr_of(project.prop("secrets"), "secrets")? {
            let pair = arr_of(Some(item), "secrets 항목")?;
            let secret = pair
                .first()
                .ok_or_else(|| "시크릿 이름이 없습니다".to_owned())?;
            let receivers = arr_of(pair.get(1), "시크릿을 받을 서비스 목록")?;
            if receivers
                .iter()
                .any(|r| matches!(r, JsValue::Str(s) if s == name))
            {
                assign_null(
                    &mut environment,
                    &secret.to_js_string(),
                    &mut proto_detached,
                );
            }
        }
        let depends_on: Vec<JsValue> = match optional(source.get("depends_on")) {
            None => Vec::new(),
            Some(JsValue::Obj(all)) => all
                .entries_js_order()
                .into_iter()
                .filter(|(dependency, _)| managed_names.contains(dependency))
                .map(|(dependency, _)| JsValue::str(dependency))
                .collect(),
            Some(_) => return Err(format!("{name}의 depends_on은 객체여야 합니다")),
        };
        let limit = obj_of(project.prop("resources"), "resources")?
            .get(name)
            .filter(|l| l.truthy());
        let limits = limit.map(|limit| {
            let mut limits = JsObject::new();
            if truthy(limit.prop("memory")) {
                limits.set("memory", limit.prop("memory").expect("확인했다").clone());
            }
            if truthy(limit.prop("cpus")) {
                limits.set(
                    "cpus",
                    JsValue::str(limit.prop("cpus").expect("확인했다").to_js_string()),
                );
            }
            limits
        });
        let image = match images {
            JsValue::Obj(o) => o.get(name).filter(|i| i.truthy()),
            _ => return Err("images은(는) 객체여야 합니다".to_owned()),
        };
        let Some(image) = image else {
            return Err(format!("{name} 서비스의 운영 이미지가 없습니다"));
        };
        let mut service = object(vec![
            ("image", image.clone()),
            ("environment", JsValue::Obj(environment)),
            (
                "ports",
                JsValue::Arr(vec![JsValue::str(format!(
                    "127.0.0.1::{}",
                    port.to_js_string()
                ))]),
            ),
            ("restart", JsValue::str("unless-stopped")),
            (
                "labels",
                JsValue::Obj(object(vec![
                    (
                        "b-studio.deploy",
                        JsValue::str(str_of(project.prop("name"), "프로젝트 이름")?),
                    ),
                    ("b-studio.release", JsValue::str(release_id)),
                    ("b-studio.service", JsValue::str(*name)),
                ])),
            ),
        ]);
        if !depends_on.is_empty() {
            service.set("depends_on", JsValue::Arr(depends_on));
        }
        if let Some(limits) = limits {
            let resources = object(vec![("limits", JsValue::Obj(limits))]);
            service.set(
                "deploy",
                JsValue::Obj(object(vec![("resources", JsValue::Obj(resources))])),
            );
        }
        services.set(name, JsValue::Obj(service));
    }
    Ok(js_ordered(&JsValue::Obj(object(vec![(
        "services",
        JsValue::Obj(services),
    )]))))
}

// ── 운영 이미지의 빌드 인자

/// Dockerfile이 `ARG`로 선언한 이름. 옛 정규식 `/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)/gim`을 글자 그대로 읽는다:
/// `^`는 줄 끝 문자(`\n`·`\r`·U+2028·U+2029) 다음 자리, `\s`는 JS 공백(줄바꿈 포함, 그래서 `ARG`와 이름 사이에 줄이 바뀌어도 된다),
/// 대소문자 무시는 ASCII뿐이다. 정규식 크레이트의 `(?i)`는 유니코드 접기(`ſ`→`s`, 켈빈 기호→`k`)를 해 식별자 글자 모임이 달라져 쓰지 않았다
fn declared_args(dockerfile: &str) -> Vec<String> {
    let chars: Vec<char> = dockerfile.chars().collect();
    let line_start = |i: usize| i == 0 || js::is_js_line_terminator(chars[i - 1]);
    let mut declared = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !line_start(i) {
            i += 1;
            continue;
        }
        match match_arg(&chars, i) {
            Some((end, name)) => {
                declared.push(name);
                i = end;
            }
            None => i += 1,
        }
    }
    declared
}

/// `i`에서 `\s*ARG\s+이름`이 맞으면 (끝 위치, 이름)
fn match_arg(chars: &[char], mut i: usize) -> Option<(usize, String)> {
    while i < chars.len() && js::is_js_whitespace(chars[i]) {
        i += 1;
    }
    for expected in ['a', 'r', 'g'] {
        if !chars.get(i)?.eq_ignore_ascii_case(&expected) {
            return None;
        }
        i += 1;
    }
    let space_start = i;
    while i < chars.len() && js::is_js_whitespace(chars[i]) {
        i += 1;
    }
    if i == space_start
        || !chars
            .get(i)
            .is_some_and(|c| c.is_ascii_alphabetic() || *c == '_')
    {
        return None;
    }
    let start = i;
    while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
        i += 1;
    }
    Some((i, chars[start..i].iter().collect()))
}

/// 운영 이미지의 빌드 인자. compose build.args에 더해, Dockerfile이 ARG로 선언한 이름 중 compose environment에 값이 있는 것만 넘긴다.
/// 값이 비어 있는(null) 항목은 넘기지 않는다. `build`는 `{ args? }`, `environment`는 이름 → 값
pub fn build_args_for(
    dockerfile: &str,
    build: Option<&JsValue>,
    environment: Option<&JsValue>,
) -> Result<JsValue, String> {
    let declared = declared_args(dockerfile);
    let mut args = JsObject::new();
    let environment = match optional(environment) {
        None => JsObject::new(),
        Some(JsValue::Obj(o)) => o.clone(),
        Some(_) => return Err("environment은(는) 객체여야 합니다".to_owned()),
    };
    for (name, value) in environment.entries_js_order() {
        if declared.iter().any(|d| d == name) && !matches!(value, JsValue::Null) {
            assign(&mut args, name, value.clone());
        }
    }
    let build_args = match optional(build).and_then(|b| optional(b.prop("args"))) {
        None => JsObject::new(),
        Some(JsValue::Obj(o)) => o.clone(),
        Some(_) => return Err("build.args은(는) 객체여야 합니다".to_owned()),
    };
    for (name, value) in build_args.entries_js_order() {
        if !matches!(value, JsValue::Null) {
            assign(&mut args, name, value.clone());
        }
    }
    Ok(js_ordered(&JsValue::Obj(args)))
}

// ── 빌드 출력 요약

/// `line.replace(/^#\d+\s+[\d.]+\s+/, '')`: BuildKit이 줄 앞에 붙이는 `#13 12.40 `을 뗀다
fn strip_build_step(line: &str) -> &str {
    let rest = || -> Option<&str> {
        let rest = line.strip_prefix('#')?;
        let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
        let after_digits = line.len() - rest.len();
        if after_digits < 2 {
            return None;
        }
        let rest = skip_ws(rest)?;
        let after_ws = rest.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.');
        if after_ws.len() == rest.len() {
            return None;
        }
        skip_ws(after_ws)
    };
    rest().unwrap_or(line)
}

/// 공백이 하나 이상 있으면 그것을 건너뛴 나머지
fn skip_ws(s: &str) -> Option<&str> {
    let rest = s.trim_start_matches(js::is_js_whitespace);
    (rest.len() != s.len()).then_some(rest)
}

/// 에러를 뜻하는 줄. 옛 정규식 `/\berror\b|ERROR|FAILED|FAILURE|failed to|Failed to compile|Type error/i`는 대소문자를 무시하므로
/// "error"(`\berror\b`·`ERROR`·`Type error`), "failed"(`FAILED`·`failed to`·`Failed to compile`), "failure" 중 하나를 포함하는 줄이다.
/// 대소문자 무시는 ASCII뿐이다(JS `i`는 ASCII 밖 글자를 ASCII와 같게 보지 않는다)
fn is_error_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("error") || lower.contains("failed") || lower.contains("failure")
}

/// `/^\s*#\d+ (DONE|CACHED)/`
fn is_step_done(line: &str) -> bool {
    let rest = line.trim_start_matches(js::is_js_whitespace);
    let Some(rest) = rest.strip_prefix('#') else {
        return false;
    };
    let digits_trimmed = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    if digits_trimmed.len() == rest.len() {
        return false;
    }
    digits_trimmed
        .strip_prefix(' ')
        .is_some_and(|tail| tail.starts_with("DONE") || tail.starts_with("CACHED"))
}

/// 빌드 출력에서 원인을 찾을 줄만 고른다. 에러를 뜻하는 줄이 없으면 끝부분을 돌려준다. `max_lines`는 `slice(-maxLines)`처럼 읽는다
/// (0·NaN은 전부, 음수는 앞의 줄을 건너뛴다)
pub fn summarize_build_output(output: &str, max_lines: f64) -> String {
    let lines: Vec<&str> = output
        .split('\n')
        .map(|line| js::trim_end(strip_build_step(line)))
        .filter(|line| !js::trim(line).is_empty())
        .collect();
    let mut important: Vec<&str> = Vec::new();
    for line in lines
        .iter()
        .copied()
        .filter(|line| is_error_line(line) && !is_step_done(line))
    {
        if !important.contains(&line) {
            important.push(line);
        }
    }
    let chosen = if important.is_empty() {
        &lines
    } else {
        &important
    };
    chosen[js::relative_start(chosen.len(), -max_lines)..].join("\n")
}

// ── 프록시와 기록

/// 운영 프록시 설정. `routes`는 `[{ listen, upstream }]`. 값은 `` `${v}` ``처럼 글자로 바꿔 이어 붙인다
pub fn build_caddyfile(routes: &JsValue) -> Result<String, String> {
    let mut sites = Vec::new();
    for route in arr_of(Some(routes), "routes")? {
        if matches!(route, JsValue::Null) {
            return Err("routes 항목이 null입니다".to_owned());
        }
        let text = |key: &str| {
            route
                .prop(key)
                .map_or_else(|| "undefined".to_owned(), JsValue::to_js_string)
        };
        sites.push(format!(
            ":{} {{\n\treverse_proxy {}\n}}",
            text("listen"),
            text("upstream")
        ));
    }
    let mut parts = vec!["{\n\tauto_https off\n}".to_owned()];
    parts.extend(sites);
    Ok(parts.join("\n\n") + "\n")
}

/// 되돌릴 수 있게 남길 이전 릴리스를 고르고, 그보다 오래된 이전 릴리스의 자리(목록 안 위치)를 돌려준다. 기록은 최근 것부터 정렬돼 있다.
/// TS가 같은 객체를 돌려주도록 값이 아닌 위치를 낸다(부르는 쪽이 그 객체의 상태를 바꾼다)
pub fn releases_to_retire(statuses: &[JsValue], keep_previous: f64) -> Vec<usize> {
    let previous: Vec<usize> = statuses
        .iter()
        .enumerate()
        .filter(|(_, s)| matches!(s, JsValue::Str(s) if s == "previous"))
        .map(|(i, _)| i)
        .collect();
    previous[js::relative_start(previous.len(), keep_previous)..].to_vec()
}

/// 기록을 최근 것부터 정해진 수만큼만 남긴다. 운영 주소가 가리키는 릴리스는 오래됐어도 남긴다. 남길 항목의 자리를 돌려준다
pub fn trim_records(ids: &[JsValue], active: Option<&str>) -> Vec<usize> {
    let mut kept: Vec<usize> = (0..ids.len().min(MAX_RECORDS)).collect();
    let current = active.and_then(|active| {
        ids.iter()
            .position(|id| matches!(id, JsValue::Str(s) if s == active))
    });
    match current {
        Some(index) if !kept.contains(&index) => {
            kept.truncate(MAX_RECORDS - 1);
            kept.push(index);
            kept
        }
        _ => kept,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json::{parse, stringify};

    fn p(text: &str) -> JsValue {
        parse(text).expect("JSON")
    }

    fn config() -> JsValue {
        p(r#"{"services":{
          "web":{"build":{"context":"/p/orders/web","dockerfile":"Dockerfile.dev"},"environment":{"API_BASE_URL":"http://api:8080"},"volumes":[{"type":"bind","source":"/p/orders/web","target":"/app"},{"type":"volume","source":"web-node-modules","target":"/app/node_modules"}]},
          "api":{"build":{"context":"/p/orders/api"},"environment":{"DATABASE_URL":"jdbc:postgresql://db:5432/app","DATABASE_PASSWORD":"pa$$word"},"depends_on":{"db":{"condition":"service_healthy"}}},
          "db":{"image":"postgres:17-alpine","environment":{"POSTGRES_PASSWORD":"app"},"healthcheck":{"test":["CMD-SHELL","pg_isready -U app -d app"],"interval":"2s"}}},
          "volumes":{"web-node-modules":{"name":"orders_web-node-modules"},"pnpm-store":{"external":true,"name":"b-studio-cache-pnpm"}}}"#)
    }

    fn base_project() -> JsValue {
        p(r#"{"name":"orders","managed":["web","api"],"databases":[["db","postgres"]]}"#)
    }

    fn release_project() -> JsValue {
        p(
            r#"{"name":"orders","managed":[["web",3000],["api",8080]],"secrets":[["PAYMENT_API_KEY",["api"]]],"resources":{"api":{"memory":"1536m","cpus":2},"db":{"memory":"256m"}}}"#,
        )
    }

    #[test]
    fn base_stack_keeps_only_unmanaged_services_with_a_named_data_volume() {
        let plan = plan_base_compose(&config(), &base_project())
            .unwrap()
            .unwrap();
        assert_eq!(
            stringify(&plan),
            r#"{"services":{"db":{"image":"postgres:17-alpine","environment":{"POSTGRES_PASSWORD":"app"},"volumes":[{"type":"volume","source":"db-data","target":"/var/lib/postgresql/data"}],"healthcheck":{"test":["CMD-SHELL","pg_isready -U app -d app"],"interval":"2s"},"restart":"unless-stopped","labels":{"b-studio.deploy":"orders","b-studio.service":"db"}}},"volumes":{"db-data":{}}}"#
        );
        assert_eq!(
            plan_base_compose(&p(r#"{"services":{"web":{}}}"#), &base_project()).unwrap(),
            None
        );
    }

    #[test]
    fn base_stack_declares_volumes_and_drops_managed_dependencies() {
        let config = p(
            r#"{"services":{"b":{"image":"x","volumes":[{"type":"volume","source":"cache","target":"/c"},{"type":"volume","source":"7","target":"/d"},{"type":"volume","source":"__proto__","target":"/e"}],"depends_on":{"web":{"condition":"service_started"},"a":{"condition":"service_started"}},"environment":{"K":"a$b"}},"a":{"image":"y"}},"volumes":{"cache":{"external":true},"7":{"external":true,"name":"seven"}}}"#,
        );
        let project = p(r#"{"managed":["web"],"databases":[]}"#);
        let plan = plan_base_compose(&config, &project).unwrap().unwrap();
        assert_eq!(
            stringify(&plan),
            r#"{"services":{"a":{"image":"y","restart":"unless-stopped","labels":{"b-studio.deploy":"project","b-studio.service":"a"}},"b":{"image":"x","environment":{"K":"a$$b"},"volumes":[{"type":"volume","source":"cache","target":"/c"},{"type":"volume","source":"7","target":"/d"},{"type":"volume","source":"__proto__","target":"/e"}],"depends_on":{"a":{"condition":"service_started"}},"restart":"unless-stopped","labels":{"b-studio.deploy":"project","b-studio.service":"b"}}},"volumes":{"7":{"external":true,"name":"seven"},"cache":{"external":true,"name":"cache"}}}"#
        );
    }

    #[test]
    fn base_stack_keeps_a_user_mounted_data_directory() {
        let config = p(
            r#"{"services":{"db":{"image":"postgres","volumes":[{"type":"bind","source":"/x","target":"/var/lib/postgresql/data"}]}}}"#,
        );
        let project = p(r#"{"name":"o","managed":[],"databases":[["db","postgres"]]}"#);
        let text = stringify(&plan_base_compose(&config, &project).unwrap().unwrap());
        assert!(!text.contains("db-data"), "{text}");
    }

    #[test]
    fn release_stack_uses_images_blanks_secrets_and_escapes_environment() {
        let images =
            p(r#"{"web":"b-studio-deploy/orders-web:r1","api":"b-studio-deploy/orders-api:r1"}"#);
        let plan = plan_release_compose(&config(), &release_project(), "r20260912001500", &images)
            .unwrap();
        assert_eq!(
            stringify(&plan),
            r#"{"services":{"web":{"image":"b-studio-deploy/orders-web:r1","environment":{"API_BASE_URL":"http://api:8080"},"ports":["127.0.0.1::3000"],"restart":"unless-stopped","labels":{"b-studio.deploy":"orders","b-studio.release":"r20260912001500","b-studio.service":"web"}},"api":{"image":"b-studio-deploy/orders-api:r1","environment":{"DATABASE_URL":"jdbc:postgresql://db:5432/app","DATABASE_PASSWORD":"pa$$$$word","PAYMENT_API_KEY":null},"ports":["127.0.0.1::8080"],"restart":"unless-stopped","labels":{"b-studio.deploy":"orders","b-studio.release":"r20260912001500","b-studio.service":"api"},"deploy":{"resources":{"limits":{"memory":"1536m","cpus":"2"}}}}}}"#
        );
    }

    #[test]
    fn release_stack_waits_only_for_managed_dependencies_and_rejects_missing_images() {
        let config = p(
            r#"{"services":{"web":{"depends_on":{"api":{"condition":"service_started"},"db":{"condition":"service_healthy"}}},"api":{}}}"#,
        );
        let project =
            p(r#"{"name":"o","managed":[["web",1],["api",2]],"secrets":[],"resources":{}}"#);
        let images = p(r#"{"web":"w","api":"a"}"#);
        let text = stringify(&plan_release_compose(&config, &project, "r1", &images).unwrap());
        assert!(text.contains(r#""depends_on":["api"]"#), "{text}");
        assert!(!text.contains("deploy\":{"), "{text}");
        let err = plan_release_compose(&config, &project, "r1", &p(r#"{"web":"w"}"#)).unwrap_err();
        assert_eq!(err, "api 서비스의 운영 이미지가 없습니다");
        // 상속된 이름은 이미지가 없는 것이다(옛 TS는 상속된 함수를 이미지로 읽었다)
        let project =
            p(r#"{"name":"o","managed":[["constructor",1]],"secrets":[],"resources":{}}"#);
        assert!(plan_release_compose(&p(r#"{"services":{}}"#), &project, "r1", &p("{}")).is_err());
    }

    #[test]
    fn release_stack_ignores_a_secret_named_proto_unless_it_is_an_own_key() {
        let config = p(r#"{"services":{"a":{},"b":{"environment":{"x":"1"}}}}"#);
        let project = p(
            r#"{"name":"o","managed":[["a",1]],"secrets":[["__proto__",["a"]],["Z",["a"]]],"resources":{}}"#,
        );
        let text =
            stringify(&plan_release_compose(&config, &project, "r1", &p(r#"{"a":"i"}"#)).unwrap());
        assert!(text.contains(r#""environment":{"Z":null}"#), "{text}");
        // 프로토타입이 null이 된 뒤의 두 번째 `__proto__` 대입은 속성이 된다
        let twice = p(
            r#"{"name":"o","managed":[["a",1]],"secrets":[["__proto__",["a"]],["__proto__",["a"]]],"resources":{}}"#,
        );
        let text =
            stringify(&plan_release_compose(&config, &twice, "r1", &p(r#"{"a":"i"}"#)).unwrap());
        assert!(
            text.contains(r#""environment":{"__proto__":null}"#),
            "{text}"
        );
    }

    #[test]
    fn declared_args_follow_the_old_regex() {
        let dockerfile = "FROM node\nARG API_BASE_URL\n  arg NODE_OPTIONS=--max-old-space-size=512\nARG\n  SPLIT\nARGS x\nRUN echo ARG no\r\nArG _u1\u{2028}ARG\u{FEFF}Bom\nARG 9x\nARG ſ\nARG K";
        assert_eq!(
            declared_args(dockerfile),
            vec!["API_BASE_URL", "NODE_OPTIONS", "SPLIT", "_u1", "Bom", "K"]
        );
        assert_eq!(declared_args("ARG A ARG B"), vec!["A"]);
    }

    #[test]
    fn build_args_pass_declared_environment_and_build_args_but_not_nulls() {
        let dockerfile = "FROM node\nARG API_BASE_URL\n  arg NODE_OPTIONS=--max-old-space-size=512\nRUN pnpm build\n";
        let build = p(r#"{"args":{"BUILD_ID":"x","EMPTY":null,"__proto__":"p"}}"#);
        let environment = p(
            r#"{"API_BASE_URL":"http://api:8080","DATABASE_PASSWORD":"secret","NODE_OPTIONS":null}"#,
        );
        let args = build_args_for(dockerfile, Some(&build), Some(&environment)).unwrap();
        assert_eq!(
            stringify(&args),
            r#"{"API_BASE_URL":"http://api:8080","BUILD_ID":"x"}"#
        );
        assert_eq!(stringify(&build_args_for("", None, None).unwrap()), "{}");
    }

    #[test]
    fn summary_keeps_error_lines_deduplicated_and_otherwise_the_tail() {
        let output = [
            "#8 [build 3/7] COPY gradlew ./",
            "#8 CACHED",
            "#13 12.40 > Task :compileJava FAILED",
            "#13 12.41 /app/OrderController.java:21: error: ')' expected",
            "#13 12.60 FAILURE: Build failed with an exception.",
            "#13 ERROR: process \"/bin/sh -c ./gradlew bootJar\" did not complete successfully: exit code: 1",
            "#13 DONE 0.0s",
            "#13 12.60 FAILURE: Build failed with an exception.",
            "#14 ERROR: done",
            "#14 DONE 1 error",
        ]
        .join("\n");
        assert_eq!(
            summarize_build_output(&output, 15.0).split('\n').collect::<Vec<_>>(),
            vec![
                "> Task :compileJava FAILED",
                "/app/OrderController.java:21: error: ')' expected",
                "FAILURE: Build failed with an exception.",
                "#13 ERROR: process \"/bin/sh -c ./gradlew bootJar\" did not complete successfully: exit code: 1",
                "#14 ERROR: done",
            ]
        );
        assert_eq!(summarize_build_output("a\nb\nc", 2.0), "b\nc");
        assert_eq!(summarize_build_output("a\nb\nc", 0.0), "a\nb\nc");
        assert_eq!(summarize_build_output("a\nb\nc", f64::NAN), "a\nb\nc");
        assert_eq!(summarize_build_output("a\nb\nc", -1.0), "b\nc");
        assert_eq!(summarize_build_output("a  \n \n\nb\t", 15.0), "a\nb");
        // 대소문자를 무시하되 ASCII만: 켈빈 기호나 ſ는 맞지 않는다
        assert_eq!(
            summarize_build_output("fine\nTyPe ErRoR here\nplain", 15.0),
            "TyPe ErRoR here"
        );
        assert_eq!(
            summarize_build_output("x\nfaıled\n\u{212A}", 15.0),
            "x\nfaıled\n\u{212A}"
        );
    }

    #[test]
    fn build_step_prefix_is_stripped_only_when_complete() {
        assert_eq!(strip_build_step("#13 12.40 > Task"), "> Task");
        assert_eq!(strip_build_step("#13 12.40"), "#13 12.40");
        assert_eq!(strip_build_step("#13  .  x"), "x");
        assert_eq!(strip_build_step("#13x 1 y"), "#13x 1 y");
        assert_eq!(strip_build_step("# 1 2 y"), "# 1 2 y");
        assert_eq!(strip_build_step("#8 CACHED"), "#8 CACHED");
        assert_eq!(strip_build_step(" #13 1 y"), " #13 1 y");
    }

    #[test]
    fn caddyfile_and_release_id() {
        let routes = p(
            r#"[{"listen":10000,"upstream":"bsd-orders-r1-web-1:3000"},{"listen":10001,"upstream":"b:1"}]"#,
        );
        assert_eq!(
            build_caddyfile(&routes).unwrap(),
            "{\n\tauto_https off\n}\n\n:10000 {\n\treverse_proxy bsd-orders-r1-web-1:3000\n}\n\n:10001 {\n\treverse_proxy b:1\n}\n"
        );
        assert_eq!(
            build_caddyfile(&p("[]")).unwrap(),
            "{\n\tauto_https off\n}\n"
        );
        assert_eq!(
            build_caddyfile(&p(r#"[{"listen":null}]"#)).unwrap(),
            "{\n\tauto_https off\n}\n\n:null {\n\treverse_proxy undefined\n}\n"
        );
        assert_eq!(new_release_id(1_789_172_107_000.0), "r20260912001507");
        assert_eq!(new_release_id(0.0), "r19700101000000");
        assert_eq!(new_release_id(-1.0), "r19691231235959");
        assert_eq!(new_release_id(f64::NAN), "rNaNNaNNaNNaNNaNNaN");
        // 윤일과 자릿수가 다른 연도
        assert_eq!(new_release_id(951_782_400_000.0), "r20000229000000");
    }

    #[test]
    fn retire_and_trim_return_positions() {
        let statuses: Vec<JsValue> = ["active", "failed", "previous", "previous", "previous"]
            .iter()
            .map(|s| JsValue::str(*s))
            .collect();
        assert_eq!(releases_to_retire(&statuses, 2.0), vec![4]);
        assert_eq!(releases_to_retire(&statuses, 0.0), vec![2, 3, 4]);
        assert_eq!(releases_to_retire(&statuses, -1.0), vec![4]);
        assert_eq!(releases_to_retire(&statuses, f64::NAN), vec![2, 3, 4]);
        let ids: Vec<JsValue> = (0..25).map(|i| JsValue::str(format!("n{i}"))).collect();
        assert_eq!(trim_records(&ids, Some("n3")).len(), 20);
        let trimmed = trim_records(&ids, Some("n24"));
        assert_eq!((trimmed.len(), trimmed[19]), (20, 24));
        assert_eq!(trimmed[18], 18);
        assert_eq!(trim_records(&ids, None).len(), 20);
        assert_eq!(trim_records(&ids[..3], Some("zz")), vec![0, 1, 2]);
    }

    #[test]
    fn names_and_state() {
        assert_eq!(base_name("o"), "bsd-o-base");
        assert_eq!(
            container_name(&release_name("o", "r1"), "web"),
            "bsd-o-r1-web-1"
        );
        assert_eq!(image_name("o", "web", "r1"), "b-studio-deploy/o-web:r1");
        assert_eq!(
            stringify(&empty_deploy_state("o")),
            r#"{"version":1,"project":"o","ports":{},"releases":[],"history":[]}"#
        );
        assert_eq!(proxy_listen_port(2.0), 10_002.0);
        assert!(proxy_listen_port(f64::NAN).is_nan());
    }
}
