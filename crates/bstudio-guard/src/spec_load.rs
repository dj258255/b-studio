//! `load.ts`의 교차 검증. 이미 스키마 검증을 마친 studio.yaml과 compose 값을 받아 `LoadedProject`를 만든다.
//! 파일 읽기와 YAML 읽기는 부르는 쪽(io/napi)이 한다. 판정과 글 조립만 여기서 한다.

use crate::js_json::{JsObject, JsValue};
use crate::public_url;

#[derive(Clone, Debug)]
pub struct SpecFailure {
    pub message: String,
    pub issues: Vec<String>,
}

impl SpecFailure {
    pub fn message(message: impl Into<String>) -> Self {
        Self { message: message.into(), issues: Vec::new() }
    }
    pub fn issues(message: impl Into<String>, issues: Vec<String>) -> Self {
        Self { message: message.into(), issues }
    }
}

pub const SPEC_FILE: &str = "studio.yaml";
const STUDIO_CALLER: &str = "studio";

fn entries(value: &JsValue) -> Vec<(String, JsValue)> {
    match value {
        JsValue::Obj(o) => o.entries_js_order().into_iter().map(|(k, v)| (k.to_owned(), v.clone())).collect(),
        _ => Vec::new(),
    }
}

fn str_prop<'a>(value: &'a JsValue, key: &str) -> Option<&'a str> {
    value.prop(key).and_then(JsValue::as_str)
}

fn array(value: Option<&JsValue>) -> &[JsValue] {
    match value {
        Some(JsValue::Arr(items)) => items,
        _ => &[],
    }
}

fn depends_on_names(service: Option<&JsValue>) -> Vec<String> {
    let Some(service) = service else { return Vec::new() };
    match service.prop("depends_on") {
        Some(JsValue::Arr(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        Some(JsValue::Obj(o)) => o.entries_js_order().into_iter().map(|(key, _)| key.to_owned()).collect(),
        _ => Vec::new(),
    }
}

fn mounts_volume(service: Option<&JsValue>, volume: &str) -> bool {
    let Some(service) = service else { return false };
    let Some(JsValue::Arr(mounts)) = service.prop("volumes") else { return false };
    mounts.iter().any(|mount| match mount {
        JsValue::Str(text) => text.split(':').next() == Some(volume),
        JsValue::Obj(o) => o.get("source").and_then(JsValue::as_str) == Some(volume),
        _ => false,
    })
}

fn pairs(name: &str, value: &JsValue) -> JsValue {
    JsValue::Arr(vec![JsValue::Str(name.to_owned()), value.clone()])
}

/// `loadProject`의 교차 검증과 `LoadedProject` 조립. `root`·`compose_path`는 이미 절대 경로다
pub fn build_project(root: &str, spec: &JsValue, compose: &JsValue, compose_path: &str) -> Result<JsValue, SpecFailure> {
    let compose_name = str_prop(spec, "compose").unwrap_or("compose.yaml").to_owned();
    let services = spec.prop("services").cloned().unwrap_or(JsValue::Obj(JsObject::new()));
    let compose_services = compose.prop("services").cloned().unwrap_or(JsValue::Obj(JsObject::new()));
    let compose_service_names: Vec<String> = entries(&compose_services).into_iter().map(|(name, _)| name).collect();
    let compose_service_set: std::collections::HashSet<&str> = compose_service_names.iter().map(String::as_str).collect();
    let compose_volumes = compose.prop("volumes").cloned().unwrap_or(JsValue::Obj(JsObject::new()));

    let mut managed: Vec<(String, JsValue)> = Vec::new();
    let mut external: Vec<(String, JsValue)> = Vec::new();
    let mut issues: Vec<String> = Vec::new();

    for (name, service) in entries(&services) {
        let in_compose = compose_service_set.contains(name.as_str());
        match str_prop(&service, "source") {
            Some("managed") => {
                if !in_compose {
                    issues.push(format!("services.{name}: managed 서비스는 {compose_name}에 같은 이름으로 정의돼야 합니다"));
                }
                if let Some(JsValue::Arr(snapshots)) = service.prop("snapshots") {
                    for (index, snapshot) in snapshots.iter().enumerate() {
                        let Some(volume) = str_prop(snapshot, "volume") else { continue };
                        let field = format!("services.{name}.snapshots.{index}.volume");
                        let volume_value = compose_volumes.prop(volume);
                        if volume_value.is_none() {
                            issues.push(format!("{field}: {compose_name}의 volumes에 '{volume}'이 없습니다"));
                        } else if matches!(volume_value.and_then(|v| v.prop("external")), Some(JsValue::Bool(true))) {
                            issues.push(format!("{field}: 샌드박스끼리 공유하는 external 볼륨은 스냅샷으로 만들 수 없습니다"));
                        } else if in_compose {
                            let compose_service = compose_services.prop(&name);
                            if !mounts_volume(compose_service, volume) {
                                issues.push(format!("{field}: {compose_name}의 {name} 서비스가 '{volume}' 볼륨을 마운트하지 않습니다"));
                            }
                        }
                    }
                }
                managed.push((name, service));
            }
            _ => {
                if in_compose {
                    issues.push(format!("services.{name}: external 서비스는 샌드박스에서 실행하지 않으므로 {compose_name}에 넣지 않습니다"));
                }
                if let Some(JsValue::Arr(rules)) = service.prop("policy").and_then(|policy| policy.prop("allow")) {
                    for (index, rule) in rules.iter().enumerate() {
                        for caller in array(rule.prop("callers")) {
                            let Some(caller) = caller.as_str() else { continue };
                            if caller != STUDIO_CALLER && !compose_service_set.contains(caller) {
                                issues.push(format!(
                                    "services.{name}.policy.allow.{index}.callers: '{caller}'은(는) {compose_name}의 서비스도 {STUDIO_CALLER}도 아닙니다"
                                ));
                            }
                        }
                    }
                }
                let secret = service.prop("policy").and_then(|policy| policy.prop("auth")).and_then(|auth| auth.prop("secret")).and_then(JsValue::as_str);
                if let Some(secret) = secret {
                    let declared = spec.prop("secrets").and_then(|secrets| secrets.prop(secret)).is_some();
                    if !declared {
                        issues.push(format!("services.{name}.policy.auth.secret: secrets에 '{secret}'이 없습니다"));
                    }
                }
                external.push((name, service));
            }
        }
    }

    let mut databases: Vec<(String, JsValue)> = Vec::new();
    for (name, database) in entries(&spec.prop("databases").cloned().unwrap_or(JsValue::Obj(JsObject::new()))) {
        if !compose_service_set.contains(name.as_str()) {
            issues.push(format!("databases.{name}: {compose_name}에 같은 이름의 서비스가 없습니다"));
            continue;
        }
        if services.prop(&name).is_some() {
            issues.push(format!("databases.{name}: services에 등록한 서비스는 데이터베이스로 등록할 수 없습니다"));
            continue;
        }
        let dependents: Vec<JsValue> = managed
            .iter()
            .filter(|(service, _)| depends_on_names(compose_services.prop(service)).iter().any(|dependency| dependency == &name))
            .map(|(service, _)| JsValue::Str(service.clone()))
            .collect();
        let mut record = match database {
            JsValue::Obj(o) => o,
            _ => JsObject::new(),
        };
        record.set("dependents", JsValue::Arr(dependents));
        databases.push((name, JsValue::Obj(record)));
    }

    for (name, _) in entries(&spec.prop("resources").cloned().unwrap_or(JsValue::Obj(JsObject::new()))) {
        if !compose_service_set.contains(name.as_str()) {
            issues.push(format!("resources.{name}: {compose_name}에 같은 이름의 서비스가 없습니다"));
        }
    }

    let managed_names: std::collections::HashSet<String> = managed.iter().map(|(name, _)| name.clone()).collect();
    let workflow = spec.prop("workflow");
    if let Some(JsValue::Arr(tests)) = workflow.and_then(|workflow| workflow.prop("tests")) {
        for (index, test) in tests.iter().enumerate() {
            if let Some(service) = str_prop(test, "service") {
                if !managed_names.contains(service) {
                    issues.push(format!("workflow.tests.{index}.service: '{service}'은(는) source: managed 서비스가 아닙니다"));
                }
            }
        }
    }
    if let Some(JsValue::Arr(checks)) = workflow.and_then(|workflow| workflow.prop("pageChecks")) {
        for (index, check) in checks.iter().enumerate() {
            if let Some(service) = str_prop(check, "service") {
                if !managed_names.contains(service) {
                    issues.push(format!("workflow.pageChecks.{index}.service: '{service}'은(는) source: managed 서비스가 아닙니다"));
                }
            }
            if let Some(service) = check.prop("expectFromApi").and_then(|api| api.prop("service")).and_then(JsValue::as_str) {
                if !managed_names.contains(service) {
                    issues.push(format!("workflow.pageChecks.{index}.expectFromApi.service: '{service}'은(는) source: managed 서비스가 아닙니다"));
                }
            }
            if let Some(service) = check.prop("fallbackProbe").and_then(|probe| probe.prop("service")).and_then(JsValue::as_str) {
                if !managed_names.contains(service) {
                    issues.push(format!("workflow.pageChecks.{index}.fallbackProbe.service: '{service}'은(는) source: managed 서비스가 아닙니다"));
                }
            }
        }
    }
    for key in ["concurrencyChecks", "loadChecks"] {
        if let Some(JsValue::Arr(checks)) = workflow.and_then(|workflow| workflow.prop(key)) {
            for (index, check) in checks.iter().enumerate() {
                if let Some(service) = str_prop(check, "service") {
                    if !managed_names.contains(service) {
                        issues.push(format!("workflow.{key}.{index}.service: '{service}'은(는) source: managed 서비스가 아닙니다"));
                    }
                }
            }
        }
    }

    let public_url_refs = public_url::find_refs(&compose_services).map_err(SpecFailure::message)?;
    for reference in &public_url_refs {
        if !managed_names.contains(&reference.target_service) {
            issues.push(format!(
                "{}.environment.{}: ${{b-studio:services.{}.publicUrl}}이 가리키는 '{}'이(가) source: managed 서비스가 아닙니다",
                reference.service, reference.env_key, reference.target_service, reference.target_service
            ));
        }
    }

    if let Some(auto) = workflow.and_then(|workflow| workflow.prop("autoPageChecks")) {
        if let Some(service) = str_prop(auto, "service") {
            match managed.iter().find(|(name, _)| name == service) {
                None => issues.push(format!("workflow.autoPageChecks.service: '{service}'은(는) source: managed 서비스가 아닙니다")),
                Some((_, spec)) => {
                    let template = str_prop(spec, "template").unwrap_or("undefined");
                    if template != "nextjs" {
                        issues.push(format!(
                            "workflow.autoPageChecks.service: '{service}'의 템플릿이 {template}입니다. app 라우터를 쓰는 Next.js(nextjs) 서비스에서만 자동 페이지 확인을 켤 수 있습니다"
                        ));
                    }
                }
            }
        }
    }

    let secrets_value = spec.prop("secrets").cloned().unwrap_or(JsValue::Obj(JsObject::new()));
    for (name, secret) in entries(&secrets_value) {
        for service in array(secret.prop("services")) {
            if let Some(service) = service.as_str() {
                if !compose_service_set.contains(service) {
                    issues.push(format!("secrets.{name}.services: {compose_name}에 '{service}' 서비스가 없습니다"));
                }
            }
        }
        let used_by_policy = external.iter().any(|(_, service)| {
            service.prop("policy").and_then(|policy| policy.prop("auth")).and_then(|auth| auth.prop("secret")).and_then(JsValue::as_str) == Some(name.as_str())
        });
        if array(secret.prop("services")).is_empty() && !used_by_policy {
            issues.push(format!("secrets.{name}: 받을 서비스(services)나 외부 API 인증(policy.auth)에 쓰이지 않습니다"));
        }
    }

    if !issues.is_empty() {
        return Err(SpecFailure::issues(format!("{SPEC_FILE}과 {compose_name}가 맞지 않습니다"), issues));
    }

    let shared_volumes: Vec<JsValue> = entries(&compose_volumes)
        .into_iter()
        .filter(|(_, volume)| matches!(volume.prop("external"), Some(JsValue::Bool(true))))
        .map(|(key, volume)| JsValue::Str(str_prop(&volume, "name").map(str::to_owned).unwrap_or(key)))
        .collect();

    let mut depends_on = JsObject::new();
    for name in &compose_service_names {
        let dependencies: Vec<JsValue> = depends_on_names(compose_services.prop(name))
            .into_iter()
            .filter(|dependency| compose_service_set.contains(dependency.as_str()))
            .map(JsValue::Str)
            .collect();
        depends_on.set(name, JsValue::Arr(dependencies));
    }

    let mut out = JsObject::new();
    out.set("root", JsValue::Str(root.to_owned()));
    out.set("spec", spec.clone());
    out.set("composePath", JsValue::Str(compose_path.to_owned()));
    out.set("managed", JsValue::Arr(managed.iter().map(|(name, service)| pairs(name, service)).collect()));
    out.set("sharedVolumes", JsValue::Arr(shared_volumes));
    out.set("databases", JsValue::Arr(databases.iter().map(|(name, database)| pairs(name, database)).collect()));
    out.set(
        "resources",
        spec.prop("resources").cloned().unwrap_or(JsValue::Obj(JsObject::new())),
    );
    out.set("composeServices", JsValue::Arr(compose_service_names.into_iter().map(JsValue::Str).collect()));
    out.set("dependsOn", JsValue::Obj(depends_on));
    out.set("egress", workflow_egress(spec));
    out.set("secrets", JsValue::Arr(entries(&secrets_value).into_iter().map(|(name, secret)| pairs(&name, &secret)).collect()));
    out.set("external", JsValue::Arr(external.iter().map(|(name, service)| pairs(name, service)).collect()));
    out.set(
        "publicUrlRefs",
        JsValue::Arr(
            public_url_refs
                .iter()
                .map(|reference| {
                    let mut item = JsObject::new();
                    item.set("service", JsValue::Str(reference.service.clone()));
                    item.set("envKey", JsValue::Str(reference.env_key.clone()));
                    item.set("template", JsValue::Str(reference.template.clone()));
                    item.set("targetService", JsValue::Str(reference.target_service.clone()));
                    JsValue::Obj(item)
                })
                .collect(),
        ),
    );
    Ok(JsValue::Obj(out))
}

fn workflow_egress(spec: &JsValue) -> JsValue {
    spec.prop("network").and_then(|network| network.prop("egress")).cloned().unwrap_or(JsValue::Arr(Vec::new()))
}
