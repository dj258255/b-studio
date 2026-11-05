//! bstudio-guard를 Node에 붙이는 napi 층. 형 변환만 하고 판정은 하지 않는다.
//! TS 쪽 껍데기는 `packages/sandbox/src/native.ts`다.

use bstudio_guard::{container_policy, readonly_docker, secrets};
use napi::{Error, Result};
use napi_derive::napi;

/// 위반이면 이유, 아니면 null
#[napi]
pub fn assert_readonly_docker_args(args: Vec<String>) -> Option<String> {
    readonly_docker::violation(&args)
}

#[napi]
pub fn readonly_docker_subcommands() -> Vec<String> {
    readonly_docker::SUBCOMMANDS.iter().map(|s| (*s).to_owned()).collect()
}

/// `container_json`은 TS가 `JSON.stringify`로 만든 `docker inspect` 한 항목. 읽지 못하면 던진다(시작하지 않는 쪽)
#[napi]
pub fn find_policy_violations(
    container_json: String,
    project_name: String,
    sandbox_network: String,
    egress_network: String,
    edge_service: String,
    studio_caller: String,
) -> Result<Vec<String>> {
    let options = container_policy::PolicyOptions {
        project_name: &project_name,
        sandbox_network: &sandbox_network,
        egress_network: &egress_network,
        edge_service: &edge_service,
        studio_caller: &studio_caller,
    };
    container_policy::find_violations_json(&container_json, &options).map_err(Error::from_reason)
}

#[napi]
pub fn is_sensitive_host_path(source: String) -> bool {
    container_policy::is_sensitive_host_path(&source)
}

/// [이름, 값] 쌍을 나온 순서대로 돌려준다
#[napi]
pub fn parse_dotenv(text: String) -> Vec<Vec<String>> {
    secrets::parse_dotenv(&text).into_iter().map(|(k, v)| vec![k, v]).collect()
}

#[napi]
pub struct NativeRedactor {
    inner: secrets::Redactor,
}

#[napi]
impl NativeRedactor {
    /// `names[i]`와 `values[i]`가 한 쌍. JS `Object.entries`의 순서대로 받는다(같은 길이의 값끼리 그 순서를 지킨다)
    #[napi(constructor)]
    pub fn new(names: Vec<String>, values: Vec<String>) -> Result<Self> {
        if names.len() != values.len() {
            return Err(Error::from_reason("시크릿 이름과 값의 개수가 다릅니다"));
        }
        Ok(Self { inner: secrets::Redactor::new(names.into_iter().zip(values).collect()) })
    }

    #[napi]
    pub fn redact(&self, text: String) -> String {
        self.inner.redact(&text)
    }

    #[napi]
    pub fn find(&self, text: String) -> Vec<String> {
        self.inner.find(&text)
    }
}
