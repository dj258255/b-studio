use super::*;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 임시 폴더 안에 세션 저장소와 "지워지면 안 되는" 폴더를 만든다. 실제 세션 폴더나 홈 폴더는 건드리지 않는다
struct Fixture {
    _tmp: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    // macOS의 임시 폴더는 링크(`/var` → `/private/var`)를 지난다. 시험의 기대값이 그 링크에 기대지 않게 실제 경로를 쓴다
    let base = fs::canonicalize(tmp.path()).unwrap();
    let root = base.join("sessions");
    Fixture { _tmp: tmp, base, root }
}

impl Fixture {
    fn s(&self, path: &Path) -> String {
        path.to_str().unwrap().to_owned()
    }
    fn home(&self) -> PathBuf {
        self.root.join("proj-ab12cd34")
    }
    fn input<'a>(&'a self, root: &'a str, home: &'a str, user: Option<&'a str>) -> CreateInput<'a> {
        CreateInput { root, home, session_id: "ab12cd34", user_dir: user }
    }
    /// 세션 저장소 밖의 사용자 폴더
    fn user_dir(&self) -> PathBuf {
        let dir = self.base.join("user-project");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(dir.join("top.txt"), "keep").unwrap();
        dir
    }
}

type Log = Arc<Mutex<Vec<String>>>;

/// 단계를 기록하고, `fail`에 든 단계(또는 치우기) 이름이면 실패하는 콜백으로 만들기를 돈다. 단계가 불릴 때 세션 폴더가 있었는지도 기록한다
async fn run(f: &Fixture, home: &str, user: Option<&str>, fail: &[&str]) -> (Result<(), CreateFailure>, Vec<String>) {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let root = f.s(&f.root);
    let input = f.input(&root, home, user);
    let fail: Vec<String> = fail.iter().map(|name| (*name).to_owned()).collect();
    let recorder = log.clone();
    let result = run_create(&input, move |name| {
        recorder.lock().unwrap().push(name.to_owned());
        let failed = fail.iter().any(|candidate| candidate == name);
        async move { if failed { Err(format!("{name} 실패")) } else { Ok(()) } }
    })
    .await;
    let calls = log.lock().unwrap().clone();
    (result, calls)
}

fn names_without_home() -> Vec<&'static str> {
    CREATE_STEPS.iter().map(|s| s.name).filter(|name| *name != MAKE_HOME).collect()
}

#[test]
fn 단계_이름_목록과_순서를_고정한다() {
    let names: Vec<&str> = CREATE_STEPS.iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        [
            "validate_start",
            "make_home",
            "prepare_workdir",
            "load_project",
            "check_backend_ready",
            "describe_repository",
            "select_services",
            "prepare_evaluation_assets",
            "create_sandbox",
            "register_session",
            "remember_git",
            "start_gateway",
            "begin_boot",
        ]
    );
    let undos: Vec<(&str, &str, bool)> = CREATE_STEPS.iter().filter_map(|s| s.undo.map(|undo| (s.name, undo, s.undo_if_failed))).collect();
    assert_eq!(undos, [("create_sandbox", "destroy_sandbox", false), ("register_session", "unregister_session", true)]);
}

#[tokio::test]
async fn 성공하면_순서대로_부르고_세션_폴더가_남고_치우기는_부르지_않는다() {
    let f = fixture();
    let home = f.home();
    let (result, calls) = run(&f, &f.s(&home), None, &[]).await;
    assert_eq!(result, Ok(()));
    assert_eq!(calls, names_without_home());
    assert!(home.is_dir(), "만든 세션 폴더는 성공하면 남는다");
}

#[tokio::test]
async fn 세션_저장소가_없으면_만들고_실패해도_저장소는_남긴다() {
    let f = fixture();
    assert!(!f.root.exists());
    let (result, _) = run(&f, &f.s(&f.home()), None, &["prepare_workdir"]).await;
    assert!(result.is_err());
    assert!(f.root.is_dir(), "저장소는 이 호출이 지울 것이 아니다(다른 세션이 쓴다)");
    assert!(!f.home().exists());
}

#[tokio::test]
async fn 단계마다_실패하면_거기서_멈추고_끝낸_단계를_거꾸로_치우고_세션_폴더가_남지_않는다() {
    let steps = names_without_home();
    for (index, failing) in steps.iter().enumerate() {
        let f = fixture();
        let home = f.home();
        let (result, calls) = run(&f, &f.s(&home), None, &[failing]).await;
        let failure = result.unwrap_err();
        assert_eq!(failure.step, *failing);
        assert_eq!(failure.message, format!("{failing} 실패"), "원래 오류의 글");
        assert!(failure.undo_errors.is_empty(), "{failing}: 치우기는 모두 성공했다");
        assert!(!home.exists(), "{failing}: 실패한 만들기의 세션 폴더가 남았다");

        // 부른 것: 실패한 단계까지 앞에서부터, 그 뒤 치우기(끝낸 단계의 것만 거꾸로, 실패한 단계는 undo_if_failed일 때만 맨 앞)
        let mut expected: Vec<String> = steps[..=index].iter().map(|s| (*s).to_owned()).collect();
        let current = CREATE_STEPS.iter().find(|s| s.name == *failing).unwrap();
        if current.undo_if_failed {
            expected.push(current.undo.unwrap().to_owned());
        }
        let before: Vec<&CreateStep> = CREATE_STEPS.iter().filter(|s| s.name != MAKE_HOME).take(index).collect();
        for finished in before.into_iter().rev() {
            if let Some(undo) = finished.undo {
                expected.push(undo.to_owned());
            }
        }
        assert_eq!(calls, expected, "{failing}");
    }
}

#[tokio::test]
async fn 샌드박스를_만든_뒤_실패하면_샌드박스를_치우고_그_뒤에_폴더를_지운다() {
    // 폴더 지우기가 마지막(만든 것의 역순)임을 치우기 콜백이 불릴 때 폴더가 아직 있는지로 본다
    let f = fixture();
    let home = f.home();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let home_path = home.clone();
    let recorder = seen.clone();
    let root = f.s(&f.root);
    let home_text = f.s(&home);
    let input = f.input(&root, &home_text, None);
    let result = run_create(&input, move |name| {
        if name == "destroy_sandbox" || name == "unregister_session" {
            recorder.lock().unwrap().push((name, home_path.exists()));
        }
        async move { if name == "remember_git" { Err("git 실패".to_owned()) } else { Ok(()) } }
    })
    .await;
    assert_eq!(result.unwrap_err().step, "remember_git");
    assert_eq!(*seen.lock().unwrap(), vec![("unregister_session", true), ("destroy_sandbox", true)], "콜백 치우기는 폴더를 지우기 전에 끝난다");
    assert!(!home.exists());
}

#[tokio::test]
async fn 치우기가_실패해도_원래_오류를_돌려주고_나머지_치우기를_계속한다() {
    let f = fixture();
    let home = f.home();
    let (result, calls) = run(&f, &f.s(&home), None, &["begin_boot", "unregister_session"]).await;
    let failure = result.unwrap_err();
    assert_eq!(failure.step, "begin_boot");
    assert_eq!(failure.message, "begin_boot 실패", "치우기의 오류가 아니라 원래 오류");
    assert_eq!(failure.undo_errors, vec![("unregister_session".to_owned(), "unregister_session 실패".to_owned())]);
    assert!(calls.ends_with(&["unregister_session".to_owned(), "destroy_sandbox".to_owned()]), "샌드박스 치우기는 이어서 불렸다: {calls:?}");
    assert!(!home.exists(), "앞 치우기가 실패해도 폴더는 지운다");
}

#[tokio::test]
async fn 샌드박스_치우기가_실패해도_폴더는_지운다() {
    let f = fixture();
    let home = f.home();
    let (result, _) = run(&f, &f.s(&home), None, &["remember_git", "destroy_sandbox"]).await;
    let failure = result.unwrap_err();
    assert_eq!(failure.message, "remember_git 실패");
    assert_eq!(failure.undo_errors, vec![("destroy_sandbox".to_owned(), "destroy_sandbox 실패".to_owned())]);
    assert!(!home.exists());
}

#[tokio::test]
async fn 등록_단계가_일부만_하고_실패해도_자기_치우기를_먼저_부른다() {
    let f = fixture();
    let (result, calls) = run(&f, &f.s(&f.home()), None, &["register_session"]).await;
    assert_eq!(result.unwrap_err().step, "register_session");
    let tail: Vec<&str> = calls.iter().rev().take(2).map(String::as_str).collect::<Vec<_>>().into_iter().rev().collect();
    assert_eq!(tail, ["unregister_session", "destroy_sandbox"]);
}

// ── 경계: 이 호출이 만들지 않은 것은 지우지 않는다 ──

#[tokio::test]
async fn 이미_있는_세션_폴더는_만들지_않고_건드리지_않으며_뒤_단계로_가지_않는다() {
    let f = fixture();
    let home = f.home();
    fs::create_dir_all(home.join(".git/b-studio")).unwrap();
    fs::write(home.join("precious.txt"), "다른 세션의 파일").unwrap();
    fs::write(home.join(".git/b-studio/session.json"), "{}").unwrap();
    let (result, calls) = run(&f, &f.s(&home), None, &[]).await;
    let failure = result.unwrap_err();
    assert_eq!(failure.step, MAKE_HOME);
    assert!(failure.message.contains("이미 있어"), "{}", failure.message);
    assert_eq!(calls, ["validate_start"], "폴더를 만들지 못하면 뒤 단계는 부르지 않는다");
    assert!(failure.undo_errors.is_empty());
    assert_eq!(fs::read_to_string(home.join("precious.txt")).unwrap(), "다른 세션의 파일");
    assert_eq!(fs::read_to_string(home.join(".git/b-studio/session.json")).unwrap(), "{}");
}

#[tokio::test]
async fn 빈_폴더로_이미_있어도_만들지_않고_지우지_않는다() {
    let f = fixture();
    let home = f.home();
    fs::create_dir_all(&home).unwrap();
    let (result, calls) = run(&f, &f.s(&home), None, &[]).await;
    assert_eq!(result.unwrap_err().step, MAKE_HOME);
    assert_eq!(calls, ["validate_start"]);
    assert!(home.is_dir(), "이 호출이 만든 폴더가 아니므로 남는다");
}

#[tokio::test]
async fn 이미_있는_폴더가_링크여도_따라가지_않고_지우지_않는다() {
    let f = fixture();
    let precious = f.user_dir();
    fs::create_dir_all(&f.root).unwrap();
    symlink(&precious, f.home()).unwrap();
    let (result, _) = run(&f, &f.s(&f.home()), None, &[]).await;
    // 링크는 `check_home`이 링크라고 거부한다(만들지 못한 경로): 어느 쪽이든 만들지 않고 건드리지 않는다
    assert_eq!(result.unwrap_err().step, MAKE_HOME);
    assert!(fs::symlink_metadata(f.home()).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(precious.join("top.txt")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(precious.join("src/main.rs")).unwrap(), "fn main() {}");
}

#[tokio::test]
async fn 지울_수_없는_경로는_만들지_않는다() {
    let f = fixture();
    // 세션 저장소 바로 아래가 아니다 / 이름이 이 세션의 것이 아니다 / 상대 경로 / `..`
    for home in [f.base.join("elsewhere-ab12cd34"), f.root.join("sub").join("proj-ab12cd34"), f.root.join("proj-other999")] {
        let (result, calls) = run(&f, &f.s(&home), None, &[]).await;
        let failure = result.unwrap_err();
        assert_eq!(failure.step, MAKE_HOME, "{home:?}");
        assert!(failure.message.contains("만들 수 없는 경로"), "{}", failure.message);
        assert_eq!(calls, ["validate_start"]);
        assert!(!home.exists(), "{home:?}: 지울 수 없는 경로는 만들지도 않는다");
    }
    for home in ["relative/proj-ab12cd34".to_owned(), format!("{}/../sessions/proj-ab12cd34", f.s(&f.root))] {
        let (result, _) = run(&f, &home, None, &[]).await;
        assert_eq!(result.unwrap_err().step, MAKE_HOME, "{home}");
    }
}

// ── 내 폴더 세션: 사용자 폴더를 지우지 않는다 ──

#[tokio::test]
async fn 내_폴더_세션이_만들다_실패해도_사용자_폴더는_그대로이고_상태_폴더만_지운다() {
    let f = fixture();
    let user = f.user_dir();
    let user_text = f.s(&user);
    let home = f.home();
    let (result, _) = run(&f, &f.s(&home), Some(&user_text), &["create_sandbox"]).await;
    assert_eq!(result.unwrap_err().step, "create_sandbox");
    assert!(!home.exists());
    assert_eq!(fs::read_to_string(user.join("top.txt")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(user.join("src/main.rs")).unwrap(), "fn main() {}");
}

#[tokio::test]
async fn 사용자_폴더가_세션_폴더_안에_있으면_지우지_않고_치우기_오류로_알린다() {
    // `user_dir`을 넘겨 확인하게 하는 것이 사용자 폴더를 지키는 장치다. 사용자 폴더가 지울 폴더 안에 있으면 B2a 확인이 거부한다.
    // 이 시험은 단계 안에서 사용자 폴더를 세션 폴더 안에 만들어 그 확인이 지나가지 않는 것을 본다(만들 때는 사용자 폴더가 아직 없어 통과한다)
    let f = fixture();
    let home = f.home();
    let user = home.join("user-inside");
    let user_text = f.s(&user);
    let root = f.s(&f.root);
    let home_text = f.s(&home);
    let input = f.input(&root, &home_text, Some(&user_text));
    let user_for_call = user.clone();
    let result = run_create(&input, move |name| {
        if name == "prepare_workdir" {
            fs::create_dir_all(user_for_call.join("deep")).unwrap();
            fs::write(user_for_call.join("deep/file.txt"), "사용자 파일").unwrap();
        }
        async move { if name == "load_project" { Err("읽기 실패".to_owned()) } else { Ok(()) } }
    })
    .await;
    let failure = result.unwrap_err();
    assert_eq!(failure.message, "읽기 실패");
    assert_eq!(failure.undo_errors.len(), 1);
    assert_eq!(failure.undo_errors[0].0, REMOVE_HOME);
    assert!(failure.undo_errors[0].1.contains("지울 세션 폴더 안에 있습니다"), "{:?}", failure.undo_errors);
    assert_eq!(fs::read_to_string(user.join("deep/file.txt")).unwrap(), "사용자 파일");
}

// ── 세션 저장소가 링크 ──

#[tokio::test]
async fn 세션_저장소가_링크여도_만들고_실패하면_이_호출의_폴더만_지운다() {
    let f = fixture();
    let real = f.base.join("real-sessions");
    fs::create_dir_all(real.join("other-12345678")).unwrap();
    fs::write(real.join("other-12345678/keep.txt"), "keep").unwrap();
    symlink(&real, &f.root).unwrap();
    let home = f.home();
    let (result, _) = run(&f, &f.s(&home), None, &["load_project"]).await;
    assert_eq!(result.unwrap_err().step, "load_project");
    assert!(!real.join("proj-ab12cd34").exists(), "링크 너머에 만든 세션 폴더도 B2a 확인을 지나 지워진다");
    assert!(real.is_dir() && fs::symlink_metadata(&f.root).unwrap().file_type().is_symlink(), "저장소와 링크는 그대로");
    assert_eq!(fs::read_to_string(real.join("other-12345678/keep.txt")).unwrap(), "keep");
}

#[tokio::test]
async fn 폴더_만들기와_치우기_사이에_세션_폴더가_링크로_바뀌면_지우지_않고_알린다() {
    // 단계 안에서 세션 폴더를 링크로 바꿔친다(다른 프로세스의 짓). B2a 확인이 링크를 거부하므로 지우지 않고 알린다
    let f = fixture();
    let precious = f.user_dir();
    let home = f.home();
    let root = f.s(&f.root);
    let home_text = f.s(&home);
    let input = f.input(&root, &home_text, None);
    let (home_for_call, precious_for_call) = (home.clone(), precious.clone());
    let result = run_create(&input, move |name| {
        if name == "prepare_workdir" {
            fs::remove_dir(&home_for_call).unwrap();
            symlink(&precious_for_call, &home_for_call).unwrap();
        }
        async move { if name == "load_project" { Err("읽기 실패".to_owned()) } else { Ok(()) } }
    })
    .await;
    let failure = result.unwrap_err();
    assert_eq!(failure.message, "읽기 실패");
    assert_eq!(failure.undo_errors[0].0, REMOVE_HOME);
    assert_eq!(fs::read_to_string(precious.join("top.txt")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(precious.join("src/main.rs")).unwrap(), "fn main() {}");
}
