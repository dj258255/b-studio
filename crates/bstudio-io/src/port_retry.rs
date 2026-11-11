//! `compose up`의 포트 바인드 충돌 재시도(옛 TS: `LocalDockerSandbox.#composeUpWithPortRetry`·`#regeneratePorts`, ADR-195 4f A4c-2).
//!
//! `findFreeHostPort`는 호스트에서 포트가 비었는지 확인하지만 실제 바인드는 Docker VM 안에서 일어나므로, VM 안의 다른 컨테이너가 이미 그 포트를 쓰고
//! 있으면 확인을 통과했어도 `up`이 실패한다. 그때 충돌난 포트 하나만 바꾸지 않고 **미리 고른 호스트 포트를 전부 다시 뽑아** override를 다시 쓰고,
//! 일부만 뜬 컨테이너와 거기 붙은 익명 볼륨만 지운(`compose rm --stop --force --volumes`, 이름 있는 볼륨은 지우지 않는다. 트러블슈팅 #777) 뒤 다시 한다.
//! **재시도 반복 전체가 함수 하나다.** 시도마다 A4c-1의 `up_with_git_mask`를 직접 부르고, 시도가 끝날 때마다 그 시도가 마지막으로 쓴 마스크를 다음
//! 시도와 override 다시 쓰기에 넘긴다(override에 쓰는 마스크 = 방금 확인한 마스크). 부르는 쪽은 돌려받은 마스크·포트로 자기 상태를 맞춘다(실패해도).
//!
//! 막는 쪽/여는 쪽: 충돌이라고 읽으면 **다시 시도한다**(여는 쪽에 가깝다). 그래서 충돌 판정(`is_port_bind_conflict`)이 보는 대상을 옛 TS와 글자까지 같게 한다 —
//! 옛 코드는 던져진 `SandboxError.detail`을 봤다. `compose up`이 비0으로 끝난 경우 그 detail은 `describeDockerFailure(redact(stderr))`이고, 그 밖의 실패
//! (확인 실패·compose 설정 읽기 실패 등)는 각자의 `detail`이다(`failure_detail`). 모르는 결과·detail이 없는 결과는 충돌이 아니다(바로 실패).
//! 충돌이 아닌 실패는 다시 시도하지 않고 그 결과를 그대로 돌려준다. 마지막 시도도 충돌이면 `Exhausted`다.

use bstudio_guard::compose_helpers::{describe_docker_failure, is_port_bind_conflict};
use bstudio_guard::js;
use bstudio_guard::js_json::{JsObject, JsValue};
use bstudio_guard::secrets::Redactor;
use bstudio_guard::up_loop::Mask;

use crate::container_verify::{Cancel, FailureKind};
use crate::up_loop::{compose_command, docker, up_with_git_mask, UpInput, UpOutcome, WriteProblem};

pub struct RetryInput {
    /// 첫 시도의 입력. `args`는 `up --detach --remove-orphans …` 전체다
    pub up: UpInput,
    /// 다시 뽑을 호스트 포트의 대상 서비스(`publicUrlRefs`의 `targetService`, 중복 없이 처음 나온 순서). 처음 고를 때와 같은 집합이다
    pub public_url_targets: Vec<String>,
    /// 가리기 위한 시크릿 (이름, 값)(JS `Object.entries` 순서)
    pub secrets: Vec<(String, String)>,
    /// 최초 시도를 포함한 시도 횟수
    pub attempts: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RetryOutcome {
    /// 성공(`Done`, `exit_code == 0`)이거나 충돌이 아닌 실패. 부르는 쪽이 옛 글 그대로의 오류로 바꾼다
    Up(UpOutcome),
    /// 마지막 시도까지 충돌이었다. 값은 마지막 시도의 결과다
    Exhausted(UpOutcome),
    /// 포트를 다시 뽑지 못했다(미리 정한 포트는 그대로다)
    PortAlloc(String),
    /// 다시 뽑은 포트로 override를 쓰지 못했다(포트는 이미 새 값이다)
    Regenerate(WriteProblem),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RetryResult {
    /// override 파일에 마지막으로 **쓴** 마스크. 실패해도 돌려준다
    pub mask: Mask,
    /// 포트를 다시 뽑았으면 마지막으로 배정한 `(서비스, 포트)`. 한 번도 다시 뽑지 않았으면 `None`
    pub host_ports: Option<Vec<(String, u16)>>,
    pub outcome: RetryOutcome,
}

/// 옛 TS가 던진 오류의 `detail`(재시도 판정의 대상). 성공이면 `None`
fn failure_detail(outcome: &UpOutcome, redactor: &Redactor) -> Option<String> {
    let redact_stderr = |stderr: &str| redactor.redact(if js::trim(stderr).is_empty() { "docker 실행 실패" } else { stderr });
    Some(match outcome {
        UpOutcome::Done(output) if output.exit_code == 0 => return None,
        // `#composeOrThrow`: describeDockerFailure(redact(stderr))
        UpOutcome::Done(output) => describe_docker_failure(&redactor.redact(&output.stderr)),
        UpOutcome::Aborted | UpOutcome::NotStable => String::new(),
        UpOutcome::Load(problem) => match problem {
            crate::up_loop::LoadProblem::ConfigFailed(stderr) => redact_stderr(stderr),
            crate::up_loop::LoadProblem::ConfigUnparsed => String::new(),
            crate::up_loop::LoadProblem::Mask(error) => error.detail.clone().unwrap_or_default(),
        },
        UpOutcome::Override(WriteProblem::Build(_)) => String::new(),
        UpOutcome::Override(WriteProblem::Write(message)) => message.clone(),
        UpOutcome::Verify { failure, .. } => match failure.kind {
            FailureKind::ListFailed | FailureKind::InspectFailed | FailureKind::VolumeFailed => redactor.redact(failure.stderr.as_deref().unwrap_or("")),
            FailureKind::VolumePartial | FailureKind::Policy | FailureKind::Mask => failure.detail.clone().unwrap_or_default(),
            FailureKind::NoContainers | FailureKind::InspectUnparsed | FailureKind::InspectPartial | FailureKind::VolumeUnparsed => String::new(),
        },
        UpOutcome::Missing(missing) => missing.join(", "),
        UpOutcome::Deps(crate::up_loop::DepsProblem::Failed(stderr)) => redact_stderr(stderr),
        UpOutcome::Deps(crate::up_loop::DepsProblem::Unparsed) => String::new(),
    })
}

fn host_ports_value(ports: &[(String, u16)]) -> JsValue {
    let mut object = JsObject::new();
    for (service, port) in ports {
        object.set(service, JsValue::Num(f64::from(*port)));
    }
    JsValue::Obj(object)
}

pub async fn up_with_port_retry(input: RetryInput, cancel: &Cancel) -> RetryResult {
    up_with_port_retry_using(input, cancel, &mut crate::host_port::find_free_host_port).await
}

/// 빈 포트를 고르는 쪽을 받는 판(시험이 가짜를 넣는다)
pub async fn up_with_port_retry_using(input: RetryInput, cancel: &Cancel, allocate: &mut (dyn FnMut() -> std::io::Result<u16> + Send)) -> RetryResult {
    let RetryInput { mut up, public_url_targets, secrets, attempts } = input;
    let redactor = Redactor::new(secrets);
    let mut host_ports: Option<Vec<(String, u16)>> = None;
    let mut attempt = 1;
    loop {
        let result = up_with_git_mask(&up, cancel).await;
        // 다음 시도와 override 다시 쓰기에는 이 시도가 마지막으로 쓴 마스크를 쓴다
        up.mask = result.mask;
        let Some(detail) = failure_detail(&result.outcome, &redactor) else {
            return RetryResult { mask: up.mask, host_ports, outcome: RetryOutcome::Up(result.outcome) };
        };
        if !is_port_bind_conflict(&detail) {
            return RetryResult { mask: up.mask, host_ports, outcome: RetryOutcome::Up(result.outcome) };
        }
        if attempt >= attempts {
            return RetryResult { mask: up.mask, host_ports, outcome: RetryOutcome::Exhausted(result.outcome) };
        }
        // 미리 고른 포트를 전부 다시 뽑는다. 대상은 처음 고를 때와 같은 서비스 집합이다(부르는 쪽이 `publicUrlRefs`에서 만든다)
        let mut ports: Vec<(String, u16)> = Vec::with_capacity(public_url_targets.len());
        for service in &public_url_targets {
            match allocate() {
                Ok(port) => ports.push((service.clone(), port)),
                Err(error) => return RetryResult { mask: up.mask, host_ports, outcome: RetryOutcome::PortAlloc(format!("빈 포트를 찾지 못했습니다: {error}")) },
            }
        }
        // 객체가 아니면 새 포트를 얹지 못한다. 건너뛰고 다시 쓰면 부르는 쪽의 포트와 파일이 어긋나므로 실패한다
        // (실제로는 첫 시도의 override 만들기가 먼저 실패해 여기까지 오지 않는다)
        let JsValue::Obj(object) = &mut up.override_input else {
            return RetryResult { mask: up.mask, host_ports, outcome: RetryOutcome::Regenerate(WriteProblem::Build("override 입력이 객체가 아닙니다".to_owned())) };
        };
        object.set("hostPorts", host_ports_value(&ports));
        host_ports = Some(ports);
        if let Err(problem) = crate::up_loop::write_override(&up.override_path, &up.override_input, &up.mask).await {
            return RetryResult { mask: up.mask, host_ports, outcome: RetryOutcome::Regenerate(problem) };
        }
        // 일부만 뜬 컨테이너와 거기 붙은 익명 볼륨만 지운다. 이름 있는 볼륨까지 지우면 방금 스냅숏으로 채운 볼륨과 다시 여는 세션의 DB 데이터가
        // 사라진다(#777). 정리가 실패해도 다음 up은 --remove-orphans로 이어간다(결과를 보지 않는다)
        let rest: Vec<String> = ["rm", "--stop", "--force", "--volumes"].iter().map(|part| (*part).to_owned()).collect();
        let _ = docker(&up.compose, &compose_command(&up.compose, &up.override_path, &rest), Some(cancel)).await;
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_docker::Fake;
    use crate::stream_exec::ExecOutput;
    use crate::up_loop::tests::{input, prepared, Project, BY_ID};
    use bstudio_guard::js_json;
    use serde_json::Value;
    use std::fs;

    const UP: [&str; 3] = ["up", "--detach", "--remove-orphans"];
    const CONFLICT: &str = "Bind for 0.0.0.0:41000 failed: port is already allocated";

    fn retry(fake: &Fake, project: &Project, args: &[&str], targets: &[&str], attempts: u32) -> RetryInput {
        let mut up = input(fake, project, Vec::new(), Vec::new(), args);
        up.override_input = js_json::parse(r#"{"name":"p","managed":[],"services":[],"sandboxId":"studio-p","edgeScript":"","hostPorts":{"api":40000}}"#).unwrap();
        RetryInput { up, public_url_targets: targets.iter().map(|t| (*t).to_owned()).collect(), secrets: Vec::new(), attempts }
    }

    fn counter() -> impl FnMut() -> std::io::Result<u16> {
        let mut next = 41_000u16;
        move || {
            next += 1;
            Ok(next)
        }
    }

    async fn run(retry: RetryInput, allocate: &mut (dyn FnMut() -> std::io::Result<u16> + Send)) -> RetryResult {
        up_with_port_retry_using(retry, &Cancel::default(), allocate).await
    }

    fn written_ports(project: &Project) -> Value {
        let text = fs::read_to_string(&project.override_path).unwrap();
        let parsed: Value = serde_json::from_str(&text).unwrap();
        parsed
    }

    #[tokio::test]
    async fn 첫_시도가_성공하면_포트도_override도_건드리지_않는다() {
        let (fake, project) = prepared();
        let result = run(retry(&fake, &project, &BY_ID, &["api"], 3), &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Up(UpOutcome::Done(ref out)) if out.exit_code == 0), "{:?}", result.outcome);
        assert_eq!(result.host_ports, None);
        assert!(!fake.verbs().iter().any(|verb| verb == "compose rm"));
    }

    #[tokio::test]
    async fn 충돌이면_포트를_전부_다시_뽑고_override를_다시_쓰고_익명_볼륨만_지운_뒤_다시_한다() {
        let (fake, project) = prepared();
        // 첫 시작(compose start)만 충돌이다
        fake.fail("start.1", 1, CONFLICT);
        let result = run(retry(&fake, &project, &UP, &["api", "web"], 3), &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Up(UpOutcome::Done(ref out)) if out.exit_code == 0), "{:?}", result.outcome);
        assert_eq!(result.host_ports, Some(vec![("api".into(), 41_001), ("web".into(), 41_002)]));
        // 포트가 둘 다 새 값으로 override에 쓰였고, 마스크도 그대로 들어 있다
        let written = written_ports(&project);
        assert_eq!(written["services"]["api"]["volumes"], serde_json::to_value(&result.mask[0].1).unwrap());
        // 호출 순서: (config up config ps start-fail) → rm → (config up config ps start ps)
        let verbs = fake.verbs();
        let rm = verbs.iter().position(|v| v == "compose rm").expect("rm");
        assert_eq!(verbs.iter().filter(|v| *v == "compose up").count(), 2);
        assert!(verbs[..rm].iter().filter(|v| *v == "compose up").count() == 1, "{verbs:?}");
        let rm_call = fake.calls().into_iter().find(|call| call.contains(" rm ")).unwrap();
        assert!(rm_call.ends_with("rm --stop --force --volumes"), "{rm_call}");
        assert!(!rm_call.contains("down"), "{rm_call}");
    }

    #[tokio::test]
    async fn 다시_뽑은_포트가_다시_쓴_override에_들어_있고_옛_포트는_남지_않는다() {
        let (fake, project) = prepared();
        fake.fail("start.1", 1, CONFLICT);
        fake.hook("composerm", 1, &format!("cp '{}' \"$D/snapshot\"\n", project.override_path));
        let mut input = retry(&fake, &project, &UP, &["api"], 3);
        // managed 서비스의 호스트 포트는 edge가 `127.0.0.1:<호스트 포트>:<edge 포트>`로 공개한다
        input.up.override_input = js_json::parse(r#"{"managed":[["api",3000]],"composeServices":["api"],"sandboxId":"studio-p","edgeScript":"","hostPorts":{"api":40000}}"#).unwrap();
        // 처음 쓴 override에는 옛 포트가 들어 있다
        let result = run(input, &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Up(_)), "{:?}", result.outcome);
        let snapshot = fs::read_to_string(fake.dir.path().join("snapshot")).unwrap();
        assert!(snapshot.contains("127.0.0.1:41001:"), "{snapshot}");
        assert!(!snapshot.contains("40000"), "{snapshot}");
    }

    #[test]
    fn 호스트_포트_값은_서비스_순서_그대로의_객체다() {
        assert_eq!(js_json::stringify(&host_ports_value(&[("b".into(), 41_002), ("a".into(), 41_001)])), r#"{"b":41002,"a":41001}"#);
        assert_eq!(js_json::stringify(&host_ports_value(&[])), "{}");
    }

    #[tokio::test]
    async fn 충돌이_아닌_실패는_다시_시도하지_않고_그대로_돌려준다() {
        let (fake, project) = prepared();
        fake.fail("start", 1, "no space left on device");
        let result = run(retry(&fake, &project, &UP, &["api"], 3), &mut counter()).await;
        match result.outcome {
            RetryOutcome::Up(UpOutcome::Done(ExecOutput { exit_code, stderr, .. })) => {
                assert_eq!(exit_code, 1);
                assert_eq!(stderr, "no space left on device");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(result.host_ports, None);
        assert_eq!(fake.verbs().iter().filter(|v| *v == "compose up").count(), 1);
        assert!(!fake.verbs().iter().any(|verb| verb == "compose rm"));
    }

    #[tokio::test]
    async fn 마지막_시도까지_충돌이면_다시_뽑지_않고_포기한다() {
        let (fake, project) = prepared();
        fake.fail("start", 1, CONFLICT);
        let result = run(retry(&fake, &project, &UP, &["api"], 3), &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Exhausted(UpOutcome::Done(ref out)) if out.exit_code == 1), "{:?}", result.outcome);
        // 시도 3번, 다시 뽑기·정리는 시도 사이에만(2번)
        assert_eq!(fake.verbs().iter().filter(|v| *v == "compose up").count(), 3);
        assert_eq!(fake.verbs().iter().filter(|v| *v == "compose rm").count(), 2);
        assert_eq!(result.host_ports, Some(vec![("api".into(), 41_002)]));
    }

    #[tokio::test]
    async fn 시도_한_번이면_충돌이어도_다시_뽑지_않는다() {
        let (fake, project) = prepared();
        fake.fail("start", 1, CONFLICT);
        let result = run(retry(&fake, &project, &UP, &["api"], 1), &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Exhausted(_)));
        assert_eq!(result.host_ports, None);
        assert!(!fake.verbs().iter().any(|verb| verb == "compose rm"));
    }

    #[tokio::test]
    async fn 대상이_없으면_빈_포트_목록으로_다시_쓴다() {
        let (fake, project) = prepared();
        fake.fail("start.1", 1, CONFLICT);
        let result = run(retry(&fake, &project, &UP, &[], 3), &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Up(_)));
        assert_eq!(result.host_ports, Some(Vec::new()));
    }

    #[tokio::test]
    async fn 포트를_다시_뽑지_못하면_멈추고_옛_포트를_그대로_둔다() {
        let (fake, project) = prepared();
        fake.fail("start", 1, CONFLICT);
        let mut failing = || -> std::io::Result<u16> { Err(std::io::Error::other("no ports")) };
        let result = run(retry(&fake, &project, &UP, &["api"], 3), &mut failing).await;
        assert_eq!(result.outcome, RetryOutcome::PortAlloc("빈 포트를 찾지 못했습니다: no ports".into()));
        assert_eq!(result.host_ports, None);
        assert!(!fake.verbs().iter().any(|verb| verb == "compose rm"));
    }

    #[tokio::test]
    async fn override_입력이_객체가_아니면_재시도까지_가지_않고_실패한다() {
        let (fake, project) = prepared();
        fake.fail("start.1", 1, CONFLICT);
        let mut input = retry(&fake, &project, &UP, &["api"], 3);
        input.up.override_input = js_json::parse("[]").unwrap();
        let result = run(input, &mut counter()).await;
        // 첫 시도의 override 만들기가 먼저 실패한다. 만들지도, 포트를 다시 뽑지도, 지우지도 않는다
        assert!(matches!(result.outcome, RetryOutcome::Up(UpOutcome::Override(WriteProblem::Build(_)))), "{:?}", result.outcome);
        assert_eq!(result.host_ports, None);
        assert!(!fake.verbs().iter().any(|verb| verb == "compose rm" || verb == "compose up"), "{:?}", fake.verbs());
    }

    #[tokio::test]
    async fn override를_다시_쓰지_못하면_포트는_새_값이고_정리하지_않는다() {
        let (fake, project) = prepared();
        fake.fail("start", 1, CONFLICT);
        // 첫 시작이 끝나기 전에 override 자리를 비어 있지 않은 폴더로 바꿔 둔다(다시 쓰는 rename이 실패한다)
        fake.hook("start", 1, &format!("rm -f '{p}'; mkdir -p '{p}/inner'\n", p = project.override_path));
        let result = run(retry(&fake, &project, &UP, &["api"], 3), &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Regenerate(WriteProblem::Write(_))), "{:?}", result.outcome);
        assert_eq!(result.host_ports, Some(vec![("api".into(), 41_001)]));
        assert!(!fake.verbs().iter().any(|verb| verb == "compose rm"));
        assert_eq!(fake.verbs().iter().filter(|v| *v == "compose up").count(), 1);
    }

    #[tokio::test]
    async fn 다시_쓰는_override의_마스크는_직전_시도가_쓴_값이다() {
        // 첫 시도가 계산해 쓴 마스크(비어 있지 않다)가 **다시 쓴 직후**의 override에도 들어 있어야 한다. 처음 마스크(비어 있음)를 쓰면 `.git` 가림이 빠진다.
        // 다시 쓴 직후는 정리(`compose rm`) 호출 때이므로 그때 override를 복사해 둔다
        let (fake, project) = prepared();
        fake.fail("start.1", 1, CONFLICT);
        fake.hook("composerm", 1, &format!("cp '{}' \"$D/snapshot\"\n", project.override_path));
        let result = run(retry(&fake, &project, &UP, &["api"], 3), &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Up(_)), "{:?}", result.outcome);
        assert!(!result.mask.is_empty());
        let snapshot: Value = serde_json::from_str(&fs::read_to_string(fake.dir.path().join("snapshot")).unwrap()).unwrap();
        assert_eq!(snapshot["services"]["api"]["volumes"], serde_json::to_value(&result.mask[0].1).unwrap());
    }

    #[tokio::test]
    async fn 충돌_판정은_가린_뒤의_글을_본다() {
        // 시크릿 값이 충돌 문구와 겹치면 가려져 충돌로 읽지 않는다(옛 TS는 가린 detail을 봤다)
        let (fake, project) = prepared();
        fake.fail("start", 1, CONFLICT);
        let mut input = retry(&fake, &project, &UP, &["api"], 3);
        input.secrets = vec![("T".into(), "port is already allocated".into())];
        let result = run(input, &mut counter()).await;
        assert!(matches!(result.outcome, RetryOutcome::Up(UpOutcome::Done(ref out)) if out.exit_code == 1), "{:?}", result.outcome);
        assert_eq!(fake.verbs().iter().filter(|v| *v == "compose up").count(), 1);
    }

    #[test]
    fn 실패의_detail은_옛_오류가_싣던_글이다() {
        let redactor = Redactor::new(vec![("T".into(), "SECRETSECRET".into())]);
        let done = |code, stderr: &str| UpOutcome::Done(ExecOutput { exit_code: code, stdout: String::new(), stderr: stderr.into() });
        assert_eq!(failure_detail(&done(0, "ignored"), &redactor), None);
        assert_eq!(failure_detail(&done(1, "no space left on device"), &redactor).unwrap(), format!("no space left on device\n{}", bstudio_guard::compose_helpers::DOCKER_OUT_OF_SPACE));
        assert_eq!(failure_detail(&done(1, "x SECRETSECRET"), &redactor).unwrap(), "x [T 가림]");
        assert_eq!(failure_detail(&UpOutcome::Load(crate::up_loop::LoadProblem::ConfigFailed("  ".into())), &redactor).unwrap(), "docker 실행 실패");
        assert_eq!(failure_detail(&UpOutcome::Missing(vec!["a".into(), "b".into()]), &redactor).unwrap(), "a, b");
        assert_eq!(failure_detail(&UpOutcome::Aborted, &redactor).unwrap(), "");
        assert_eq!(failure_detail(&UpOutcome::NotStable, &redactor).unwrap(), "");
        assert_eq!(failure_detail(&UpOutcome::Override(WriteProblem::Write("boom".into())), &redactor).unwrap(), "boom");
        // 확인 실패: 명령이 실패한 종류는 가린 stderr, 사유가 있는 종류는 detail, 나머지는 비어 있다
        let verify = |kind: FailureKind| UpOutcome::Verify {
            failure: crate::container_verify::VerifyFailure { kind, stderr: Some("err SECRETSECRET".into()), detail: Some("why".into()), removal_failed: false },
            phase: crate::up_loop::Phase::Created,
        };
        for kind in [FailureKind::ListFailed, FailureKind::InspectFailed, FailureKind::VolumeFailed] {
            assert_eq!(failure_detail(&verify(kind), &redactor).unwrap(), "err [T 가림]", "{kind:?}");
        }
        for kind in [FailureKind::VolumePartial, FailureKind::Policy, FailureKind::Mask] {
            assert_eq!(failure_detail(&verify(kind), &redactor).unwrap(), "why", "{kind:?}");
        }
        for kind in [FailureKind::NoContainers, FailureKind::InspectUnparsed, FailureKind::InspectPartial, FailureKind::VolumeUnparsed] {
            assert_eq!(failure_detail(&verify(kind), &redactor).unwrap(), "", "{kind:?}");
        }
    }
}
