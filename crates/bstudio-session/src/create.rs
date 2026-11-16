//! 세션을 만드는 순서와, 만들다 실패했을 때 만든 것을 치우는 순서(ADR-206, 4f B2c). 옛 구현은 `sessions.ts`의 `startSession`이었다
//! (`session-create-legacy.ts`가 차등 시험의 기준으로 남아 있다). Node를 모른다. 복제·프로젝트 읽기·로그인 확인·샌드박스 만들기 같은 부수 효과는 TS가 쥐고,
//! 여기는 **언제 무엇을 하고 실패하면 무엇을 되돌리는가**만 정한다.
//!
//! 옛 `startSession`은 세션 폴더를 만든 뒤 어느 단계가 실패해도 그 폴더를 치우지 않았다(저장 파일이 쓰이기 전이라 복구 목록에도 오르지 않는다). 샌드박스를 만든 뒤에 실패하면
//! 샌드박스도, 세션을 맵에 넣은 뒤에 실패하면 반쯤 만든 세션도 남았다(트러블슈팅 215).
//!
//! **이 호출이 만든 것만 치운다.** 지우는 코드라 이것이 가장 중요하다:
//! - 세션 폴더는 이 모듈이 **배타적으로** 만든다(`create_dir`, 이미 있으면 실패). 이미 있던 폴더는 만들지 못한 것이므로 `done`에 들지 않고, 실패해도 지우지 않는다.
//!   id가 겹쳐 다른 세션의 폴더가 이미 있어도 마찬가지다(옛 코드는 `cp`가 그 폴더에 섞어 넣거나 `git clone`이 비어 있지 않다며 실패하고 폴더를 그대로 두었다)
//! - 지우기는 B2a의 `remove_session_home`으로만 한다(루트 바로 아래의 `<프로젝트>-<id>` 폴더인지, 링크가 아닌지, 내 폴더 세션이면 사용자 폴더가 그 안이 아닌지 지우기 직전에 다시 본다).
//!   직접 `remove_dir_all`을 부르지 않는다. 확인하지 못하면 지우지 않고 `undo_errors`로 알린다
//! - 치우기는 **끝낸 단계만** 거꾸로 한다. 실패한 단계는 부수 효과를 남기지 않는다고 본다(`undo_if_failed`가 참인 단계만 예외다: 일부만 하고 던질 수 있는 단계)
//! - 치우기가 실패해도 원래 오류를 돌려주고 치우기 오류는 `undo_errors`에 모은다

use crate::lifecycle::{check_home, remove_session_home, Home};
use std::fs;
use std::future::Future;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreateStep {
    pub name: &'static str,
    /// 이 단계를 끝낸 뒤 만들기가 실패하면 부르는 치우기 콜백 이름. 없으면 치울 것이 없다(읽기만 했다)
    pub undo: Option<&'static str>,
    /// 이 단계 **자신**이 실패해도 치우기를 부른다(일부만 하고 던질 수 있는 단계). 치우기는 빈틈없이 여러 번 불러도 같아야 한다
    pub undo_if_failed: bool,
}

/// 이 모듈이 직접 하는 단계(세션 폴더를 배타적으로 만든다). 치우기는 `remove_session_home`이다
pub const MAKE_HOME: &str = "make_home";

const fn step(name: &'static str) -> CreateStep {
    CreateStep { name, undo: None, undo_if_failed: false }
}

/// 옛 `startSession`의 순서. 단계 이름 목록과 순서는 시험으로 고정한다
pub const CREATE_STEPS: [CreateStep; 13] = [
    // 승격 모델 확인, 같은 id의 세션이 이미 있는지(아무것도 만들기 전에 본다)
    step("validate_start"),
    CreateStep { name: MAKE_HOME, undo: None, undo_if_failed: false },
    // 작업 복사본 복제·복사·`init`, 내 폴더 세션이면 상태 폴더의 체크포인트 git
    step("prepare_workdir"),
    step("load_project"),
    step("check_backend_ready"),
    step("describe_repository"),
    step("select_services"),
    step("prepare_evaluation_assets"),
    CreateStep { name: "create_sandbox", undo: Some("destroy_sandbox"), undo_if_failed: false },
    // 세션 객체를 만들고 맵·레지스트리에 넣는다. 일부만 넣고 던질 수 있어 자신이 실패해도 치운다
    CreateStep { name: "register_session", undo: Some("unregister_session"), undo_if_failed: true },
    step("remember_git"),
    step("start_gateway"),
    // 처음 저장을 예약하고, 즉시 기동이면 켠다(`request_boot`의 세대 규칙은 B2b 그대로)
    step("begin_boot"),
];

/// 만들기에 쓰는 폴더들. `user_dir`은 내 폴더 세션의 사용자 폴더다(없으면 작업 복사본 세션)
pub struct CreateInput<'a> {
    pub root: &'a str,
    pub home: &'a str,
    pub session_id: &'a str,
    pub user_dir: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateFailure {
    /// 실패한 단계 이름
    pub step: String,
    pub message: String,
    /// 치우다 실패한 것(원래 오류는 `message`다). 치우기 콜백 이름 또는 `remove_home`과 그 이유
    pub undo_errors: Vec<(String, String)>,
}

pub const REMOVE_HOME: &str = "remove_home";

fn exists_message(home: &str) -> String {
    format!("세션 폴더가 이미 있어 새로 만들지 않았습니다(다른 세션의 폴더일 수 있어 건드리지 않았습니다): {home}")
}

/// 세션 폴더를 **배타적으로** 만든다. 지울 수 없는 경로면 만들지 않는다(만든 것은 반드시 치울 수 있어야 한다). 이미 있으면 만들지 않고 실패한다
fn make_home(input: &CreateInput) -> Result<(), String> {
    match check_home(input.root, input.home, input.session_id, input.user_dir) {
        Err(reason) => return Err(format!("세션 폴더를 만들 수 없는 경로입니다: {reason}")),
        Ok(Home::Folder) => return Err(exists_message(input.home)),
        Ok(Home::Missing) => {}
    }
    // 세션 저장소는 없으면 만든다(옛 `mkdir(dirname, { recursive: true })`). 저장소는 이 호출이 만든 것이 아니라 실패해도 지우지 않는다
    fs::create_dir_all(input.root).map_err(|error| format!("세션 저장소를 만들지 못했습니다({}): {error}", input.root))?;
    // 세션 폴더는 `recursive` 없이 만든다: 그 사이에 누가 만들었으면 `AlreadyExists`
    match fs::create_dir(input.home) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(exists_message(input.home)),
        Err(error) => Err(format!("세션 폴더를 만들지 못했습니다({}): {error}", input.home)),
    }
}

/// 만들기를 `CREATE_STEPS` 순서로 돈다. `call(이름)`은 그 단계(또는 치우기)의 부수 효과를 하고 실패하면 이유를 돌려준다.
/// 실패하면 끝낸 단계를 거꾸로 치우고(세션 폴더는 `remove_session_home`) 실패한 단계와 원래 이유를 돌려준다
pub async fn run_create<F, Fut>(input: &CreateInput<'_>, mut call: F) -> Result<(), CreateFailure>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let mut done: Vec<&CreateStep> = Vec::new();
    for current in &CREATE_STEPS {
        let result = if current.name == MAKE_HOME {
            let (root, home, id, user) = (input.root.to_owned(), input.home.to_owned(), input.session_id.to_owned(), input.user_dir.map(str::to_owned));
            tokio::task::spawn_blocking(move || make_home(&CreateInput { root: &root, home: &home, session_id: &id, user_dir: user.as_deref() }))
                .await
                .unwrap_or_else(|error| Err(format!("세션 폴더 만들기가 중단됐습니다: {error}")))
        } else {
            call(current.name).await
        };
        match result {
            Ok(()) => done.push(current),
            Err(message) => {
                let mut undo_errors = Vec::new();
                // 실패한 단계 자신의 치우기(일부만 하고 던졌을 수 있다)
                if current.undo_if_failed {
                    if let Some(undo) = current.undo {
                        if let Err(reason) = call(undo).await {
                            undo_errors.push((undo.to_owned(), reason));
                        }
                    }
                }
                for finished in done.iter().rev() {
                    if finished.name == MAKE_HOME {
                        let (root, home, id, user) = (input.root.to_owned(), input.home.to_owned(), input.session_id.to_owned(), input.user_dir.map(str::to_owned));
                        let removed = tokio::task::spawn_blocking(move || remove_session_home(&root, &home, &id, user.as_deref()))
                            .await
                            .map_err(|error| format!("세션 폴더 지우기가 중단됐습니다: {error}"))
                            .and_then(|result| result.map_err(|fail| fail.message));
                        if let Err(reason) = removed {
                            undo_errors.push((REMOVE_HOME.to_owned(), reason));
                        }
                    } else if let Some(undo) = finished.undo {
                        if let Err(reason) = call(undo).await {
                            undo_errors.push((undo.to_owned(), reason));
                        }
                    }
                }
                return Err(CreateFailure { step: current.name.to_owned(), message, undo_errors });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
