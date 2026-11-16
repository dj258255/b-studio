use super::*;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

struct Fixture {
    _tmp: tempfile::TempDir,
    base: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    Fixture { _tmp: tmp, base }
}

impl Fixture {
    fn dir(&self, name: &str) -> String {
        let path = self.base.join(name);
        fs::create_dir_all(&path).unwrap();
        s(&path)
    }
}

fn s(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn active(registry: &Registry, id: &str, work_dir: &str) -> Arc<SessionState> {
    let state = Arc::new(SessionState::new(SessionStatus::Idle).unwrap());
    registry.register(id, state.clone(), true, work_dir);
    state
}

/// 이 기기의 파일 시스템이 대소문자를 구분하지 않는가(시험의 기대값을 기기가 아니라 `stat`으로 정한다)
fn same_by_stat(a: &str, b: &str) -> bool {
    matches!((identity_of(a), identity_of(b)), (Identity::Known { dev: da, ino: ia }, Identity::Known { dev: db, ino: ib }) if da == db && ia == ib)
}

#[test]
fn resume_gate_matches_old_order_and_messages() {
    let registry = Registry::new();
    assert_eq!(registry.begin_resume("a", false).unwrap_err(), Fail { status: 404, message: "세션을 찾을 수 없습니다".into() });
    // 보관 세션은 멈춘 것으로 본다
    registry.begin_resume("a", true).unwrap();
    assert!(registry.resuming("a"));
    assert_eq!(registry.begin_resume("a", true).unwrap_err(), Fail { status: 409, message: "이미 이어서 작업할 준비를 하는 중입니다".into() });
    registry.end_resume("a");
    assert!(!registry.resuming("a"));
    registry.begin_resume("a", true).unwrap();
}

#[test]
fn resume_gate_refuses_a_live_session_that_is_not_stopped() {
    let registry = Registry::new();
    let state = Arc::new(SessionState::new(SessionStatus::Idle).unwrap());
    registry.register("a", state.clone(), false, "/x");
    assert_eq!(registry.begin_resume("a", false).unwrap_err(), Fail { status: 409, message: "샌드박스를 중지한 세션만 이어서 작업할 수 있습니다".into() });
    assert!(!registry.resuming("a"));
    state.begin_stop();
    futures_block(state.run_stop(|_| async { Ok(()) })).unwrap();
    registry.begin_resume("a", false).unwrap();
    // 세션을 내리면(지우기) 404다
    registry.end_resume("a");
    registry.unregister("a");
    assert_eq!(registry.begin_resume("a", false).unwrap_err().status, 404);
}

fn futures_block<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

#[test]
fn claim_refuses_the_same_string_while_a_session_works_there() {
    let fx = fixture();
    let user = fx.dir("user");
    let registry = Registry::new();
    active(&registry, "aaaa", &user);
    let fail = registry.claim_folder(&user, None).unwrap_err();
    assert_eq!(fail, Fail { status: 409, message: "이 폴더는 세션 aaaa에서 작업하고 있습니다. 그 세션의 샌드박스를 중지한 뒤 시작하세요".into() });
}

#[test]
fn claim_allows_the_session_itself_a_stopped_session_and_a_copy_session() {
    let fx = fixture();
    let user = fx.dir("user");
    let registry = Registry::new();
    let state = active(&registry, "aaaa", &user);
    // 자기 자신의 이어받기
    let token = registry.claim_folder(&user, Some("aaaa")).unwrap();
    registry.release_claim(token);
    // 작업 복사본 세션은 폴더를 나누지 않는다
    let copy = Arc::new(SessionState::new(SessionStatus::Idle).unwrap());
    let copies = Registry::new();
    copies.register("bbbb", copy, false, &user);
    assert!(copies.claim_folder(&user, None).is_ok());
    // 멈춘 세션
    assert!(registry.claim_folder(&user, None).is_err());
    state.begin_stop();
    futures_block(state.run_stop(|_| async { Ok(()) })).unwrap();
    assert!(registry.claim_folder(&user, None).is_ok());
}

#[test]
fn claim_refuses_while_another_start_holds_the_folder_and_frees_it_on_release() {
    let fx = fixture();
    let user = fx.dir("user");
    let registry = Registry::new();
    let token = registry.claim_folder(&user, None).unwrap();
    assert_eq!(registry.claim_folder(&user, None).unwrap_err(), Fail { status: 409, message: "이 폴더로 다른 세션을 시작하는 중입니다. 끝난 뒤 다시 시도하세요".into() });
    registry.release_claim(token);
    assert_eq!(registry.claimed(), 0);
    registry.claim_folder(&user, None).unwrap();
    // 번호가 맞지 않는 해제는 다른 점유를 풀지 않는다
    registry.release_claim(999);
    assert_eq!(registry.claimed(), 1);
}

#[test]
fn alias_link_trailing_slash_and_dot_segments_are_the_same_folder() {
    let fx = fixture();
    let user = fx.dir("user");
    let link = fx.base.join("alias");
    symlink(&user, &link).unwrap();
    let registry = Registry::new();
    active(&registry, "aaaa", &user);
    for alias in [s(&link), format!("{user}/"), format!("{user}/."), format!("{}/../user", fx.dir("other")), format!("{user}//")] {
        let fail = registry.claim_folder(&alias, None).unwrap_err();
        assert_eq!(fail.status, 409, "{alias}");
        assert!(fail.message.contains("세션 aaaa에서 작업하고 있습니다"), "{alias}: {}", fail.message);
    }
}

#[test]
fn alias_of_a_claimed_folder_is_refused_too() {
    let fx = fixture();
    let user = fx.dir("user");
    let link = fx.base.join("alias");
    symlink(&user, &link).unwrap();
    let registry = Registry::new();
    registry.claim_folder(&user, None).unwrap();
    assert_eq!(registry.claim_folder(&s(&link), None).unwrap_err().message, "이 폴더로 다른 세션을 시작하는 중입니다. 끝난 뒤 다시 시도하세요");
    // 반대로 별칭을 먼저 잡아도 원래 경로가 막힌다
    let registry = Registry::new();
    registry.claim_folder(&s(&link), None).unwrap();
    assert!(registry.claim_folder(&user, None).is_err());
}

#[test]
fn case_only_difference_is_refused_exactly_when_stat_says_same_folder() {
    let fx = fixture();
    let user = fx.dir("UserDir");
    let lower = s(&fx.base.join("userdir"));
    let registry = Registry::new();
    active(&registry, "aaaa", &user);
    let result = registry.claim_folder(&lower, None);
    // 기대값은 이 기기의 파일 시스템이 아니라 stat이 같은 폴더라고 하는지로 정한다
    assert_eq!(result.is_err(), same_by_stat(&user, &lower), "{result:?}");
}

#[test]
fn different_folders_are_not_blocked_even_with_a_shared_prefix() {
    let fx = fixture();
    let user = fx.dir("user");
    let other = fx.dir("user2");
    let nested = fx.dir("user/inner");
    let registry = Registry::new();
    active(&registry, "aaaa", &user);
    assert!(registry.claim_folder(&other, None).is_ok());
    assert!(registry.claim_folder(&nested, None).is_ok());
}

#[test]
fn a_missing_folder_is_compared_by_string_only() {
    let fx = fixture();
    let user = fx.dir("user");
    let missing = s(&fx.base.join("gone"));
    let registry = Registry::new();
    active(&registry, "aaaa", &user);
    // 없는 폴더는 다른 폴더의 별칭이 될 수 없다: 막지 않는다(시작이 뒤 단계에서 옛 오류를 낸다)
    assert!(registry.claim_folder(&missing, None).is_ok());
    // 같은 글자의 없는 폴더는 막는다
    let registry = Registry::new();
    active(&registry, "bbbb", &missing);
    assert!(registry.claim_folder(&missing, None).is_err());
    // 작업 중인 세션의 폴더가 지워졌어도 다른 폴더를 막지 않는다
    assert!(registry.claim_folder(&user, None).is_ok());
}

#[test]
fn an_unreadable_folder_is_refused_when_there_is_something_to_compare_with() {
    let fx = fixture();
    let user = fx.dir("user");
    let locked = fx.dir("locked");
    let hidden = format!("{locked}/inner");
    fs::create_dir_all(&hidden).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let registry = Registry::new();
    active(&registry, "aaaa", &user);
    let result = registry.claim_folder(&hidden, None);
    // 비교 대상이 없으면 막을 이유가 없다
    let alone = Registry::new().claim_folder(&hidden, None);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    let fail = result.expect_err("정체를 읽지 못하면 같은 폴더가 아니라고 증명할 수 없다");
    assert_eq!(fail.status, 409);
    assert!(fail.message.contains("확인하지 못해 시작하지 않았습니다"), "{}", fail.message);
    assert!(alone.is_ok());
}

#[test]
fn unregistering_a_session_frees_its_folder() {
    let fx = fixture();
    let user = fx.dir("user");
    let registry = Registry::new();
    active(&registry, "aaaa", &user);
    assert!(registry.claim_folder(&user, None).is_err());
    registry.unregister("aaaa");
    assert!(registry.claim_folder(&user, None).is_ok());
}
