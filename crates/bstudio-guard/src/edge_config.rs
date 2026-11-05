//! 샌드박스 네트워크의 유일한 출입구(edge 프록시)의 설정(ADR-191 2단계 2b-2a). 옛 `packages/sandbox/src/edge-config.ts`.
//!
//! Docker와 Kubernetes 제공자가 같은 설정을 쓴다. 값은 JS가 만들던 글자와 같아야 한다(compose YAML과 매니페스트에 그대로 들어간다).
//! 이름·포트를 모르는 입력(managed가 아닌 서비스)은 만들지 않고 오류로 멈춘다.

use crate::js_json::{self, JsObject, JsValue};

/// 샌드박스 네트워크의 유일한 출입구(packages/sandbox/edge/edge.mjs)
pub const EDGE_SERVICE: &str = "b-studio-edge";
pub const EDGE_PROXY_PORT: u32 = 3128;
pub const EDGE_IMAGE: &str = "node:22-bookworm-slim";
/// 외부로 나갈 수 없는 네트워크. 모든 서비스가 여기에만 붙는다
pub const SANDBOX_NETWORK: &str = "b-studio-sandbox";
/// edge만 붙는 네트워크. 허용한 외부 호스트로 나갈 때 쓴다
pub const EGRESS_NETWORK: &str = "b-studio-egress";
const EDGE_FIRST_PORT: u32 = 20_000;

/// 기본으로 허용하는 외부 호스트: 템플릿이 의존성을 받는 패키지 저장소와 Next 템플릿의 next/font/google
pub const DEFAULT_EGRESS_ALLOW: [&str; 15] = [
    "registry.npmjs.org",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "repo.maven.apache.org",
    "repo1.maven.org",
    // Google이 운영하는 Maven Central 공식 미러. Spring Boot 템플릿이 먼저 쓴다(docs/troubleshooting.md 45)
    "maven-central.storage-download.googleapis.com",
    "plugins.gradle.org",
    "plugins-artifacts.gradle.org",
    "services.gradle.org",
    "downloads.gradle.org",
    // Gradle 래퍼의 배포판(services.gradle.org/distributions/…)은 GitHub 릴리스로 넘겨 준다(307 → github.com → 302 → release-assets).
    // HTTPS는 CONNECT 터널이라 경로로 좁힐 수 없어 호스트로 연다(ADR 참고). npm·Go 의존성도 GitHub에서 받는 일이 많다
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "pypi.org",
    "files.pythonhosted.org",
];

/// managed 서비스가 edge에서 공개되는 포트. 서비스 순서로 정해 여러 서비스가 같은 컨테이너 포트를 써도 겹치지 않는다.
/// 같은 이름이 둘이면 처음 것의 자리를 쓴다(JS `findIndex`)
pub fn edge_port_for(managed: &[String], service: &str) -> Result<u32, String> {
    match managed.iter().position(|name| name == service) {
        Some(index) => Ok(EDGE_FIRST_PORT + index as u32),
        None => Err(format!("'{service}'은(는) managed 서비스가 아닙니다")),
    }
}

/// 프록시를 거치지 않고 부를 이름: 로컬, 샌드박스 서비스, edge가 받는 등록한 사내 API
pub fn direct_hosts(services: &[String], externals: &[String]) -> Vec<String> {
    ["localhost", "127.0.0.1"].iter().map(|s| (*s).to_owned()).chain(services.iter().cloned()).chain(externals.iter().cloned()).collect()
}

/// 서비스가 밖으로 나가는 HTTP(S)를 edge 프록시로 보내게 하는 환경 변수. 키 순서가 YAML 글자를 정한다
pub fn proxy_environment(direct: &[String]) -> Vec<(String, String)> {
    let proxy = format!("http://{EDGE_SERVICE}:{EDGE_PROXY_PORT}");
    let comma = direct.join(",");
    let pairs: Vec<(&str, String)> = vec![
        ("HTTP_PROXY", proxy.clone()),
        ("HTTPS_PROXY", proxy.clone()),
        ("ALL_PROXY", proxy.clone()),
        ("http_proxy", proxy.clone()),
        ("https_proxy", proxy.clone()),
        ("all_proxy", proxy),
        ("NO_PROXY", comma.clone()),
        ("no_proxy", comma),
        // Node 22.21+ 의 기본 fetch는 이 값이 있어야 HTTP(S)_PROXY를 따른다. corepack 0.36(2026-09 베이스 이미지)이
        // 자체 프록시 처리를 없애 이 값이 없으면 격리 네트워크에서 pnpm을 받지 못한다(#69). 이 값을 모르는 옛 Node는 무시하므로 해가 없다
        ("NODE_USE_ENV_PROXY", "1".to_owned()),
        // JVM(Gradle, 앱)은 프록시 환경 변수를 읽지 않으므로 시스템 속성으로 넘긴다
        (
            "JAVA_TOOL_OPTIONS",
            [
                format!("-Dhttp.proxyHost={EDGE_SERVICE}"),
                format!("-Dhttp.proxyPort={EDGE_PROXY_PORT}"),
                format!("-Dhttps.proxyHost={EDGE_SERVICE}"),
                format!("-Dhttps.proxyPort={EDGE_PROXY_PORT}"),
                format!("-Dhttp.nonProxyHosts={}", direct.join("|")),
            ]
            .join(" "),
        ),
    ];
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// 등록한 사내 API 한 개. `base_url`·`policy`는 `undefined`일 수 있어 `Option`이다(JSON에서 키가 빠진다)
#[derive(Clone, Debug)]
pub struct External {
    pub name: String,
    pub base_url: Option<JsValue>,
    pub policy: Option<JsValue>,
}

/// edge 프로세스 설정. 값을 그대로 담는다(compose override는 `$`를 따로 적는다).
/// `managed`는 (이름, 컨테이너 포트) 목록, `egress`는 studio.yaml의 허용 규칙(문자열이나 객체)
pub fn edge_environment(managed: &[(String, JsValue)], services: &[String], egress: &[JsValue], externals: &[External]) -> Vec<(String, String)> {
    let names: Vec<String> = managed.iter().map(|(name, _)| name.clone()).collect();
    let rules = JsValue::Arr(DEFAULT_EGRESS_ALLOW.iter().map(|s| JsValue::str(*s)).chain(egress.iter().cloned()).collect());
    let forwards = managed
        .iter()
        .map(|(name, port)| {
            let edge = edge_port_for(&names, name).expect("managed 목록에서 가져온 이름");
            format!("{edge}={name}:{}", port.to_js_string())
        })
        .collect::<Vec<_>>()
        .join(",");
    let ext = JsValue::Arr(
        externals
            .iter()
            .map(|e| js_json::object(vec![("name", Some(JsValue::str(e.name.clone()))), ("baseUrl", e.base_url.clone()), ("policy", e.policy.clone())]))
            .collect(),
    );
    vec![
        ("EDGE_MAIN".to_owned(), "1".to_owned()),
        ("EDGE_FORWARDS".to_owned(), forwards),
        ("EDGE_EGRESS".to_owned(), js_json::stringify(&rules)),
        ("EDGE_CALLERS".to_owned(), services.join(",")),
        ("EDGE_EXTERNALS".to_owned(), js_json::stringify(&ext)),
    ]
}

/// 순서가 있는 문자열 쌍을 JS 객체로(같은 키가 다시 나오면 값만 바꾸고 자리는 처음 것, 정수 꼴 키는 먼저)
pub fn pairs_to_object(pairs: &[(String, String)]) -> JsValue {
    let mut o = JsObject::new();
    for (k, v) in pairs {
        o.set(k, JsValue::str(v.clone()));
    }
    JsValue::Obj(o)
}

/// 경계로 건네는 상수: 서비스 이름, 프록시 포트, 이미지, 두 네트워크 이름, 기본 허용 호스트. TS는 이 값을 읽어 쓰고 따로 적지 않는다
pub fn constants() -> JsValue {
    js_json::object(vec![
        ("edgeService", Some(JsValue::str(EDGE_SERVICE))),
        ("edgeProxyPort", Some(JsValue::Num(f64::from(EDGE_PROXY_PORT)))),
        ("edgeImage", Some(JsValue::str(EDGE_IMAGE))),
        ("sandboxNetwork", Some(JsValue::str(SANDBOX_NETWORK))),
        ("egressNetwork", Some(JsValue::str(EGRESS_NETWORK))),
        ("defaultEgressAllow", Some(JsValue::Arr(DEFAULT_EGRESS_ALLOW.iter().map(|s| JsValue::str(*s)).collect()))),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn 포트는_서비스_순서로_정하고_같은_이름은_처음_자리다() {
        let names = s(&["a", "b", "a"]);
        assert_eq!(edge_port_for(&names, "a"), Ok(20000));
        assert_eq!(edge_port_for(&names, "b"), Ok(20001));
        assert_eq!(edge_port_for(&names, "c"), Err("'c'은(는) managed 서비스가 아닙니다".to_owned()));
    }

    #[test]
    fn 프록시_환경은_키_순서와_직접_부를_이름을_지킨다() {
        let env = proxy_environment(&s(&["localhost", "web"]));
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY", "JAVA_TOOL_OPTIONS"]);
        assert_eq!(env[6].1, "localhost,web");
        assert!(env[9].1.ends_with("-Dhttp.nonProxyHosts=localhost|web"));
        assert_eq!(direct_hosts(&s(&["web"]), &s(&["x"])), ["localhost", "127.0.0.1", "web", "x"]);
    }

    #[test]
    fn edge_환경은_기본_허용_호스트_뒤에_규칙을_잇는다() {
        let env = edge_environment(&[("web".into(), JsValue::Num(3000.0))], &s(&["web"]), &[JsValue::str("a.com")], &[]);
        assert_eq!(env[1], ("EDGE_FORWARDS".to_owned(), "20000=web:3000".to_owned()));
        assert!(env[2].1.starts_with("[\"registry.npmjs.org\"") && env[2].1.ends_with(",\"a.com\"]"));
        assert_eq!(env[4].1, "[]");
    }
}
