//! compose override를 만든다(ADR-191 2단계 2b-2a). 옛 `packages/sandbox/src/docker/format.ts`의 `buildOverride`·`composeUpArgs`.
//!
//! 이 파일이 샌드박스 격리를 정한다. 사용자의 compose 파일은 건드리지 않고 덧씌울 설정이다:
//!  - 모든 서비스를 외부로 나갈 수 없는 internal 네트워크에만 붙인다(운영 DB, 사내망, 인터넷 차단)
//!  - internal 네트워크의 컨테이너는 포트를 공개할 수 없으므로 edge가 루프백(127.0.0.1)의 빈 포트로 대신 공개해 넘긴다
//!  - HTTP(S) 도구는 edge 프록시를 거쳐 허용한 호스트로만 나간다
//!  - 시크릿 값은 override에 쓰지 않는다. 값 자리를 `null`로 비워 두면 compose가 자기 프로세스 환경에서 채운다
//!  - 프로젝트 폴더를 마운트한 서비스는 `.git`을 읽기 전용으로 덮는다(`git_mask`가 만든 볼륨을 사용자 마운트 위에 얹는다)
//!  - 다른 서비스의 공개 주소를 참조하는 환경 변수(`publicUrlRefs`)는 `hostPorts`로 미리 정한 포트의 실제 주소로 채운다
//!
//! 결과는 YAML로 쓰이므로 **객체 키 순서가 글자를 정한다**. JS 객체의 순서(정수 꼴 키가 먼저, 스프레드로 덮어써도 처음 자리)를 지킨다.
//!
//! 모양이 어긋난 입력(문자열이 아닌 서비스 이름, 정수가 아닌 호스트 포트 등)은 JS처럼 이어 붙이지 않고 오류로 멈춘다.
//! 오류는 샌드박스를 만들지 않는 쪽이다. `hostPorts`의 키는 자기 속성만 본다(JS의 `in`은 `constructor` 같은 상속된 이름도 있다고 읽었다).

use crate::edge_config::{
    self, External, EDGE_IMAGE, EDGE_PROXY_PORT, EDGE_SERVICE, EGRESS_NETWORK, SANDBOX_NETWORK,
};
use crate::js;
use crate::js_json::{JsObject, JsValue};
use crate::public_url;

/// `docker compose up`에 붙일 서비스 인자(ADR-083). `explicit`이 없으면 빈 목록(compose 파일의 모든 서비스를 띄운다).
/// 있으면 `--no-deps`와, 그 서비스들과 edge를 이름 순(UTF-16 코드 단위 순서)으로 중복 없이 적는다.
/// `--no-deps`는 목록에 없는 의존 서비스를 compose가 몰래 따라 띄우지 않게 한다 — 사용자가 의존 서비스를 명시적으로 뺐을 수 있다
pub fn compose_up_args(explicit: Option<&[String]>, edge_service: &str) -> Vec<String> {
    let Some(explicit) = explicit else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for name in explicit
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(edge_service))
    {
        if !names.iter().any(|n| n == name) {
            names.push(name.to_owned());
        }
    }
    names.sort_by(|a, b| js::cmp_utf16(a, b));
    std::iter::once("--no-deps".to_owned())
        .chain(names)
        .collect()
}

fn str_of(v: Option<&JsValue>, what: &str) -> Result<String, String> {
    match v {
        Some(JsValue::Str(s)) => Ok(s.clone()),
        _ => Err(format!("{what}은(는) 문자열이어야 합니다")),
    }
}

fn arr_of<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a [JsValue], String> {
    match v {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(format!("{what}은(는) 배열이어야 합니다")),
    }
}

/// 값이 없거나 null이면 None(`??`)
fn optional(v: Option<&JsValue>) -> Option<&JsValue> {
    v.filter(|x| !matches!(x, JsValue::Null))
}

fn strs_of(v: Option<&JsValue>, what: &str) -> Result<Vec<String>, String> {
    arr_of(v, what)?
        .iter()
        .map(|item| str_of(Some(item), what))
        .collect()
}

fn obj_of<'a>(v: Option<&'a JsValue>, what: &str) -> Result<&'a JsObject, String> {
    match v {
        Some(JsValue::Obj(o)) => Ok(o),
        _ => Err(format!("{what}은(는) 객체여야 합니다")),
    }
}

fn object(pairs: Vec<(&str, JsValue)>) -> JsObject {
    let mut o = JsObject::new();
    for (k, v) in pairs {
        o.set(k, v);
    }
    o
}

/// 스프레드 `{...base, key: value}`. 같은 키가 이미 있으면 값만 바꾸고 자리는 처음 것을 지킨다
fn spread_set(base: Option<&JsValue>, key: &str, value: JsValue) -> JsValue {
    let mut o = match base {
        Some(JsValue::Obj(o)) => o.clone(),
        _ => JsObject::new(),
    };
    o.set(key, value);
    JsValue::Obj(o)
}

fn strs_value(items: &[String]) -> JsValue {
    JsValue::Arr(items.iter().map(|s| JsValue::str(s.clone())).collect())
}

/// 중첩된 모든 객체를 JS 순서(정수 꼴 키가 먼저 오름차순)로 바꾼다. JS 객체는 넣은 순서와 관계없이 이 순서로 나온다
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

/// compose는 environment·command 안의 `$`도 변수로 치환하므로 `$$`로 적는다
fn escape_dollar(text: &str) -> String {
    text.replace('$', "$$")
}

/// 호스트 포트는 0~65535의 정수만 받는다(JS는 `${port}`로 아무 수나 이어 붙였다)
fn port_text(v: &JsValue, what: &str) -> Result<String, String> {
    match v {
        JsValue::Num(n) if n.fract() == 0.0 && (0.0..=65535.0).contains(n) => {
            Ok(js::number_to_string(*n))
        }
        _ => Err(format!("{what}은(는) 0~65535의 정수여야 합니다")),
    }
}

struct Parsed {
    managed: Vec<(String, JsValue)>,
    managed_names: Vec<String>,
    compose_services: Vec<String>,
    secrets: Vec<(String, Vec<String>)>,
    externals: Vec<External>,
    /// 사내 API마다 인증 시크릿 이름(없으면 None). `externals`와 같은 순서
    external_auth: Vec<Option<String>>,
    egress: Vec<JsValue>,
}

fn parse_project(input: &JsValue) -> Result<Parsed, String> {
    let managed_items = arr_of(input.prop("managed"), "managed")?;
    let mut managed = Vec::new();
    for item in managed_items {
        let pair = arr_of(Some(item), "managed 항목")?;
        let name = str_of(pair.first(), "managed 서비스 이름")?;
        match pair.get(1) {
            Some(port @ JsValue::Num(_)) => managed.push((name, port.clone())),
            _ => return Err("managed 서비스의 포트는 수여야 합니다".to_owned()),
        }
    }
    let managed_names: Vec<String> = managed.iter().map(|(n, _)| n.clone()).collect();
    let compose_services = match optional(input.prop("composeServices")) {
        Some(v) => strs_of(Some(v), "composeServices")?,
        None => managed_names.clone(),
    };
    let mut secrets = Vec::new();
    if let Some(list) = optional(input.prop("secrets")) {
        for item in arr_of(Some(list), "secrets")? {
            let pair = arr_of(Some(item), "secrets 항목")?;
            secrets.push((
                str_of(pair.first(), "시크릿 이름")?,
                strs_of(pair.get(1), "시크릿을 받을 서비스 목록")?,
            ));
        }
    }
    let mut externals = Vec::new();
    let mut external_auth = Vec::new();
    if let Some(list) = optional(input.prop("external")) {
        for item in arr_of(Some(list), "external")? {
            let pair = arr_of(Some(item), "external 항목")?;
            let name = str_of(pair.first(), "사내 API 이름")?;
            let service = obj_of(pair.get(1), "사내 API 설정")?;
            let policy = obj_of(service.get("policy"), "사내 API 정책")?;
            let auth = match policy.get("auth") {
                Some(a) if a.truthy() => Some(str_of(
                    obj_of(Some(a), "사내 API 인증 설정")?.get("secret"),
                    "사내 API 인증 시크릿 이름",
                )?),
                _ => None,
            };
            external_auth.push(auth);
            externals.push(External {
                name,
                base_url: service.get("baseUrl").cloned(),
                policy: service.get("policy").cloned(),
            });
        }
    }
    let egress = match optional(input.prop("egress")) {
        Some(v) => arr_of(Some(v), "egress")?.to_vec(),
        None => Vec::new(),
    };
    Ok(Parsed {
        managed,
        managed_names,
        compose_services,
        secrets,
        externals,
        external_auth,
        egress,
    })
}

/// `edgeEnvironment(project, services)`의 입력을 읽어 만든다. `services`는 `composeServices`
pub fn edge_environment_from(input: &JsValue) -> Result<JsValue, String> {
    let p = parse_project(input)?;
    let services = match optional(input.prop("services")) {
        Some(v) => strs_of(Some(v), "services")?,
        None => p.compose_services.clone(),
    };
    Ok(edge_config::pairs_to_object(
        &edge_config::edge_environment(&p.managed, &services, &p.egress, &p.externals),
    ))
}

pub fn build_override(input: &JsValue) -> Result<JsValue, String> {
    let p = parse_project(input)?;
    let sandbox_id = str_of(input.prop("sandboxId"), "sandboxId")?;
    let edge_script = match optional(input.prop("edgeScript")) {
        Some(v) => str_of(Some(v), "edgeScript")?,
        None => String::new(),
    };
    // `runtime ? {runtime} : {}`: 빈 문자열은 건다고 보지 않는다
    let runtime = match optional(input.prop("runtime")) {
        Some(JsValue::Str(s)) if !s.is_empty() => Some(s.clone()),
        Some(JsValue::Str(_)) | None => None,
        Some(_) => return Err("runtime은(는) 문자열이어야 합니다".to_owned()),
    };
    let host_ports = match optional(input.prop("hostPorts")) {
        Some(v) => obj_of(Some(v), "hostPorts")?.clone(),
        None => JsObject::new(),
    };
    for (name, port) in host_ports.entries() {
        port_text(port, &format!("hostPorts.{name}"))?;
    }
    let git_mask = match optional(input.prop("gitMask")) {
        Some(v) => obj_of(Some(v), "gitMask")?.clone(),
        None => JsObject::new(),
    };

    // 등록한 사내 API 이름은 edge의 별칭이므로 HTTP 프록시(3128)를 거치지 않고 바로 부른다
    let external_names: Vec<String> = p.externals.iter().map(|e| e.name.clone()).collect();
    let direct = edge_config::direct_hosts(&p.compose_services, &external_names);
    let environment = edge_config::pairs_to_object(&edge_config::proxy_environment(&direct));

    // 프록시가 듣기 전에 서비스가 뜨면 첫 다운로드가 연결 거부로 실패하고 컨테이너가 끝난다
    let wait_for_edge = JsValue::Obj(object(vec![(
        EDGE_SERVICE,
        JsValue::Obj(object(vec![("condition", JsValue::str("service_healthy"))])),
    )]));
    let isolate = |o: &mut JsObject| {
        // gVisor(runsc) 같은 런타임은 에이전트 코드가 도는 서비스와 샌드박스 네트워크에 노출된 edge에 모두 건다
        if let Some(rt) = &runtime {
            o.set("runtime", JsValue::str(rt.clone()));
        }
    };

    let mut services = JsObject::new();
    for name in &p.compose_services {
        let mut service = object(vec![
            ("networks", strs_value(&[SANDBOX_NETWORK.to_owned()])),
            ("environment", environment.clone()),
            ("depends_on", wait_for_edge.clone()),
        ]);
        isolate(&mut service);
        services.set(name, JsValue::Obj(service));
    }
    for (name, _) in &p.managed {
        let labels = JsValue::Obj(object(vec![
            ("b-studio.sandbox", JsValue::str(sandbox_id.clone())),
            ("b-studio.service", JsValue::str(name.clone())),
        ]));
        let next = spread_set(services.get(name), "labels", labels);
        services.set(name, next);
    }

    // 같은 target의 마운트는 compose가 override 쪽으로 합치므로 사용자의 마운트 위에 `.git` 마운트가 겹친다
    for (name, volumes) in git_mask.entries_js_order() {
        let volumes = arr_of(Some(volumes), &format!("gitMask.{name}"))?;
        if !volumes.is_empty() {
            let next = spread_set(
                services.get(name),
                "volumes",
                JsValue::Arr(volumes.to_vec()),
            );
            services.set(name, next);
        }
    }

    // 시크릿 값은 override 파일에 쓰지 않는다. 값 자리를 비워 두면 compose가 자기 프로세스 환경에서 채운다
    for (name, receivers) in &p.secrets {
        for service in receivers {
            let current = services.get(service);
            let next = spread_set(
                current,
                "environment",
                spread_set(
                    current.and_then(|c| c.prop("environment")),
                    name,
                    JsValue::Null,
                ),
            );
            services.set(service, next);
        }
    }

    // 런타임 공개 URL 주입: hostPorts로 미리 정한 포트만 실제 주소로 바꿀 수 있다. 없는 이름의 자리 표시자는 바뀌지 않은 채 남는다
    if let Some(refs) = optional(input.prop("publicUrlRefs")) {
        for item in arr_of(Some(refs), "publicUrlRefs")? {
            let target = str_of(item.prop("targetService"), "publicUrlRefs.targetService")?;
            let service = str_of(item.prop("service"), "publicUrlRefs.service")?;
            let env_key = str_of(item.prop("envKey"), "publicUrlRefs.envKey")?;
            let template = str_of(item.prop("template"), "publicUrlRefs.template")?;
            if host_ports.get(&target).is_none() {
                continue;
            }
            let resolved = public_url::resolve(&template, &mut |svc| match host_ports.get(svc) {
                // 위에서 모든 값이 정수인 것을 확인했다
                Some(port) => format!(
                    "http://127.0.0.1:{}",
                    port_text(port, "hostPorts").expect("검사한 포트")
                ),
                None => public_url::placeholder(svc),
            });
            let current = services.get(&service);
            let next = spread_set(
                current,
                "environment",
                spread_set(
                    current.and_then(|c| c.prop("environment")),
                    &env_key,
                    JsValue::str(resolved),
                ),
            );
            services.set(&service, next);
        }
    }

    // edge. 사내 API 인증 시크릿은 edge에만 넣는다(값 자리를 비워 compose 프로세스 환경에서 채운다)
    let mut edge_env = JsObject::new();
    for (key, value) in
        edge_config::edge_environment(&p.managed, &p.compose_services, &p.egress, &p.externals)
    {
        edge_env.set(&key, JsValue::str(escape_dollar(&value)));
    }
    for secret in p.external_auth.iter().flatten() {
        // edge가 이미 쓰는 이름이면 그 설정을 null로 비우게 되고 compose가 시크릿 값으로 채운다. 목록을 따로 두지 않고
        // 방금 만든 edge 환경과 견준다(이름 규칙은 spec 스키마가 먼저 막는다, #1018)
        if edge_env.contains_key(secret) {
            return Err(format!(
                "사내 API 인증 시크릿 이름 '{secret}'이 edge 설정 이름과 겹칩니다"
            ));
        }
        edge_env.set(secret, JsValue::Null);
    }
    let mut edge = JsObject::new();
    edge.set("image", JsValue::str(EDGE_IMAGE));
    isolate(&mut edge);
    edge.set(
        "command",
        strs_value(&[
            "node".to_owned(),
            "--input-type=module".to_owned(),
            "-e".to_owned(),
            escape_dollar(&edge_script),
        ]),
    );
    edge.set("environment", JsValue::Obj(edge_env));
    // 등록한 사내 API 이름을 internal 네트워크의 별칭으로 가져, 서비스가 http://<이름>/으로 부르면 edge로 온다
    edge.set(
        "networks",
        JsValue::Obj(object(vec![
            (
                SANDBOX_NETWORK,
                JsValue::Obj(object(vec![("aliases", strs_value(&external_names))])),
            ),
            (EGRESS_NETWORK, JsValue::Obj(JsObject::new())),
        ])),
    );
    // 사내 API가 Docker 호스트에서 돌 때도 edge가 찾아갈 수 있게 한다
    if !p.externals.is_empty() {
        edge.set(
            "extra_hosts",
            strs_value(&["host.docker.internal:host-gateway".to_owned()]),
        );
    }
    edge.set(
        "healthcheck",
        JsValue::Obj(object(vec![
            (
                "test",
                strs_value(&[
                    "CMD".to_owned(),
                    "node".to_owned(),
                    "-e".to_owned(),
                    format!("require('node:net').connect({EDGE_PROXY_PORT}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"),
                ]),
            ),
            ("interval", JsValue::str("1s")),
            ("timeout", JsValue::str("2s")),
            ("retries", JsValue::Num(30.0)),
            ("start_interval", JsValue::str("200ms")),
            ("start_period", JsValue::str("10s")),
        ])),
    );
    // 루프백의 빈 포트에만 공개해서 같은 네트워크의 다른 PC에서 접근하지 못하게 한다. hostPorts에 미리 정한 포트가 있는 서비스는
    // 그 포트를 그대로 공개한다(그래야 `up`보다 먼저 쓴 환경 변수의 주소가 실제 포트와 어긋나지 않는다). 없으면 자동 배정한다
    let mut ports = Vec::new();
    for (name, _) in &p.managed {
        let edge_port = edge_config::edge_port_for(&p.managed_names, name)?;
        ports.push(match host_ports.get(name) {
            None => format!("127.0.0.1::{edge_port}"),
            Some(port) => format!(
                "127.0.0.1:{}:{edge_port}",
                port_text(port, "hostPorts").expect("검사한 포트")
            ),
        });
    }
    edge.set("ports", strs_value(&ports));
    edge.set(
        "labels",
        JsValue::Obj(object(vec![
            ("b-studio.sandbox", JsValue::str(sandbox_id)),
            ("b-studio.service", JsValue::str(EDGE_SERVICE)),
        ])),
    );
    edge.set(
        "deploy",
        JsValue::Obj(object(vec![(
            "resources",
            JsValue::Obj(object(vec![(
                "limits",
                JsValue::Obj(object(vec![
                    ("memory", JsValue::str("128m")),
                    ("cpus", JsValue::str("0.5")),
                ])),
            )])),
        )])),
    );
    services.set(EDGE_SERVICE, JsValue::Obj(edge));

    // 서비스 단위 cpus는 compose가 deploy.resources.limits와 섞어 쓰지 못하게 하므로 deploy 형식으로만 건다
    if let Some(resources) = optional(input.prop("resources")) {
        for (name, limit) in obj_of(Some(resources), "resources")?.entries_js_order() {
            let limit = obj_of(Some(limit), &format!("resources.{name}"))?;
            let mut limits = JsObject::new();
            if let Some(memory) = limit.get("memory").filter(|m| m.truthy()) {
                limits.set(
                    "memory",
                    JsValue::str(str_of(Some(memory), "resources memory")?),
                );
            }
            if let Some(cpus) = limit.get("cpus").filter(|c| c.truthy()) {
                match cpus {
                    JsValue::Num(n) => limits.set("cpus", JsValue::str(js::number_to_string(*n))),
                    _ => return Err("resources cpus는 수여야 합니다".to_owned()),
                }
            }
            let deploy = JsValue::Obj(object(vec![(
                "resources",
                JsValue::Obj(object(vec![("limits", JsValue::Obj(limits))])),
            )]));
            let next = spread_set(services.get(name), "deploy", deploy);
            services.set(name, next);
        }
    }

    let networks = JsValue::Obj(object(vec![
        (
            SANDBOX_NETWORK,
            JsValue::Obj(object(vec![("internal", JsValue::Bool(true))])),
        ),
        (EGRESS_NETWORK, JsValue::Obj(JsObject::new())),
    ]));
    // 객체를 JS의 순서로 바꾸고 내보낸다
    Ok(js_ordered(&JsValue::Obj(object(vec![
        ("networks", networks),
        ("services", JsValue::Obj(services)),
    ]))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_json;

    fn build(json: &str) -> Result<JsValue, String> {
        build_override(&js_json::parse(json).unwrap())
    }

    fn text(v: &JsValue) -> String {
        js_json::stringify(v)
    }

    const MIN: &str = r#"{"managed":[["web",3000],["api",8080]],"composeServices":["web","api","db"],"sandboxId":"s1"}"#;

    #[test]
    fn 인증_시크릿_이름이_edge가_이미_쓰는_환경_이름과_겹치면_만들지_않는다() {
        // 겹치면 edge의 그 설정(송신 허용 목록 등)이 null로 비워져 compose가 시크릿 값으로 채운다(#1018)
        for name in [
            "EDGE_EGRESS",
            "EDGE_MAIN",
            "EDGE_EXTERNALS",
            "EDGE_FORWARDS",
            "EDGE_CALLERS",
        ] {
            let input = format!(
                r#"{{"managed":[["web",3000]],"composeServices":["web"],"sandboxId":"s1","external":[["users",{{"baseUrl":"https://u.example.com","policy":{{"auth":{{"header":"X","secret":"{name}"}}}}}}]]}}"#
            );
            let err = build(&input).expect_err(name);
            assert!(
                err.contains(name) && err.contains("겹칩니다"),
                "{name}: {err}"
            );
        }
        let ok = r#"{"managed":[["web",3000]],"composeServices":["web"],"sandboxId":"s1","external":[["users",{"baseUrl":"https://u.example.com","policy":{"auth":{"header":"X","secret":"USERS_TOKEN"}}}]]}"#;
        let out = build(ok).unwrap();
        assert!(matches!(
            out.prop("services")
                .unwrap()
                .prop("b-studio-edge")
                .unwrap()
                .prop("environment")
                .unwrap()
                .prop("USERS_TOKEN"),
            Some(JsValue::Null)
        ));
    }

    #[test]
    fn 모든_서비스는_internal_네트워크에만_붙고_포트는_edge가_루프백으로만_공개한다() {
        let out = build(MIN).unwrap();
        assert_eq!(
            text(out.prop("networks").unwrap()),
            r#"{"b-studio-sandbox":{"internal":true},"b-studio-egress":{}}"#
        );
        let services = out.prop("services").unwrap();
        for name in ["web", "api", "db"] {
            let s = services.prop(name).unwrap();
            assert_eq!(text(s.prop("networks").unwrap()), r#"["b-studio-sandbox"]"#);
            assert!(s.prop("ports").is_none());
        }
        assert_eq!(
            text(
                services
                    .prop("b-studio-edge")
                    .unwrap()
                    .prop("ports")
                    .unwrap()
            ),
            r#"["127.0.0.1::20000","127.0.0.1::20001"]"#
        );
    }

    #[test]
    fn 시크릿은_null로_비우고_정한_포트는_고정_공개한다() {
        let json = r#"{"managed":[["web",3000],["api",8080]],"composeServices":["web","api"],"sandboxId":"s1","secrets":[["K",["api"]]],"hostPorts":{"api":54321},"edgeScript":"a $ b"}"#;
        let out = build(json).unwrap();
        let services = out.prop("services").unwrap();
        assert_eq!(
            text(
                services
                    .prop("api")
                    .unwrap()
                    .prop("environment")
                    .unwrap()
                    .prop("K")
                    .unwrap()
            ),
            "null"
        );
        assert!(services
            .prop("web")
            .unwrap()
            .prop("environment")
            .unwrap()
            .prop("K")
            .is_none());
        let edge = services.prop("b-studio-edge").unwrap();
        assert_eq!(
            text(edge.prop("ports").unwrap()),
            r#"["127.0.0.1::20000","127.0.0.1:54321:20001"]"#
        );
        assert!(text(edge.prop("command").unwrap()).ends_with(r#""a $$ b"]"#));
    }

    #[test]
    fn 정수_꼴_서비스_이름은_앞으로_나온다() {
        let json = r#"{"managed":[],"composeServices":["web","10","2"],"sandboxId":"s"}"#;
        let out = build(json).unwrap();
        let keys: Vec<&str> = match out.prop("services").unwrap() {
            JsValue::Obj(o) => o.entries().iter().map(|(k, _)| k.as_str()).collect(),
            _ => unreachable!(),
        };
        assert_eq!(keys, ["2", "10", "web", "b-studio-edge"]);
    }

    #[test]
    fn 모양이_어긋난_입력과_범위_밖의_포트는_던진다() {
        assert!(build(r#"{"managed":[],"composeServices":[1],"sandboxId":"s"}"#).is_err());
        assert!(build(r#"{"managed":[["a",1]],"sandboxId":"s","hostPorts":{"a":1.5}}"#).is_err());
        assert!(build(r#"{"managed":[["a",1]],"sandboxId":"s","hostPorts":{"a":65536}}"#).is_err());
        assert!(build(r#"{"managed":[["a",1]],"sandboxId":"s","runtime":5}"#).is_err());
        assert!(build(r#"{"managed":[]}"#).is_err());
    }

    #[test]
    fn compose_up_인자는_no_deps와_이름_순_중복_없는_목록이다() {
        let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        assert!(compose_up_args(None, "e").is_empty());
        assert_eq!(compose_up_args(Some(&[]), "e"), ["--no-deps", "e"]);
        assert_eq!(
            compose_up_args(Some(&s(&["web", "db", "web", "e"])), "e"),
            ["--no-deps", "db", "e", "web"]
        );
        assert_eq!(
            compose_up_args(Some(&s(&["😀", "\u{ffff}", "B", "a"])), "z"),
            ["--no-deps", "B", "a", "z", "😀", "\u{ffff}"]
        );
    }
}
