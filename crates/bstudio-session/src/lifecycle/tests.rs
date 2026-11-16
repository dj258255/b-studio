use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

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
    fs::create_dir_all(&root).unwrap();
    Fixture { _tmp: tmp, base, root }
}

impl Fixture {
    fn s(&self, path: &Path) -> String {
        path.to_str().unwrap().to_owned()
    }
    /// `<root>/<name>`에 파일이 든 세션 폴더를 만든다
    fn session(&self, name: &str) -> PathBuf {
        let dir = self.root.join(name);
        fs::create_dir_all(dir.join(".git/b-studio")).unwrap();
        fs::write(dir.join("a.txt"), "a").unwrap();
        dir
    }
    /// 세션 저장소 밖에 있는 "지워지면 안 되는" 폴더
    fn precious(&self, name: &str) -> PathBuf {
        let dir = self.base.join(name);
        fs::create_dir_all(dir.join("inner")).unwrap();
        fs::write(dir.join("inner/marker.txt"), "keep").unwrap();
        fs::write(dir.join("top.txt"), "keep").unwrap();
        dir
    }
    fn remove(&self, home: &str, id: &str) -> Result<(), Fail> {
        remove_session_home(&self.s(&self.root), home, id, None)
    }
}

fn intact(dir: &Path) {
    assert_eq!(fs::read_to_string(dir.join("inner/marker.txt")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(dir.join("top.txt")).unwrap(), "keep");
}

#[test]
fn 정상_세션_폴더는_지운다() {
    let f = fixture();
    let home = f.session("proj-ab12cd34");
    f.remove(&f.s(&home), "ab12cd34").unwrap();
    assert!(!home.exists());
    assert!(f.root.exists());
}

#[test]
fn 이미_없는_폴더는_지울_것이_없어_성공이다() {
    let f = fixture();
    f.remove(&f.s(&f.root.join("proj-ab12cd34")), "ab12cd34").unwrap();
    // 그래도 꼴이 틀린 경로는 폴더가 없어도 거부한다(없는 척하며 통과시키지 않는다)
    assert!(f.remove(&f.s(&f.root.join("proj-other")), "ab12cd34").is_err());
}

#[test]
fn 부모가_세션_저장소가_아니면_지우지_않는다() {
    let f = fixture();
    // 이름은 맞지만 루트 바로 아래가 아니다(더 깊다, 루트의 형제다, 루트 자체와 부모다)
    let deeper = f.session("proj-ab12cd34").join("nested-ab12cd34");
    fs::create_dir_all(&deeper).unwrap();
    let sibling = f.base.join("elsewhere-ab12cd34");
    fs::create_dir_all(&sibling).unwrap();
    for home in [&deeper, &sibling, &f.root, &f.base] {
        assert!(f.remove(&f.s(home), "ab12cd34").is_err(), "{home:?}");
        assert!(home.exists(), "{home:?}");
    }
}

#[test]
fn 다른_세션의_폴더는_지우지_않는다() {
    let f = fixture();
    let other = f.session("proj-ffff0000");
    let err = f.remove(&f.s(&other), "ab12cd34").unwrap_err();
    assert_eq!(err.status, 500);
    assert!(other.join("a.txt").exists());
}

#[test]
fn 이름이_id_뒤에_붙은_꼴이_아니면_지우지_않는다() {
    let f = fixture();
    for name in ["-ab12cd34", "ab12cd34", "proj-ab12cd345", "proj-xab12cd34x", "proj_ab12cd34", "proj-AB12CD34", "proj-ab12cd34 ", "p\\-ab12cd34"] {
        let dir = f.root.join(name);
        fs::create_dir_all(&dir).unwrap();
        assert!(f.remove(&f.s(&dir), "ab12cd34").is_err(), "{name:?}");
        assert!(dir.exists(), "{name:?}");
    }
}

#[test]
fn 경로가_글자_그대로_구성_요소가_아니면_지우지_않는다() {
    let f = fixture();
    let other = f.session("proj-ffff0000");
    let own = f.session("proj-ab12cd34");
    let root = f.s(&f.root);
    let bad = [
        // `..`·`.`·겹친 구분자·끝의 `/`·상대 경로·빈 경로
        format!("{root}/proj-ab12cd34/../proj-ffff0000"),
        format!("{root}/../sessions/proj-ab12cd34"),
        format!("{root}/./proj-ab12cd34"),
        format!("{root}//proj-ab12cd34"),
        format!("{root}/proj-ab12cd34/"),
        format!("{root}/proj-ab12cd34/."),
        "proj-ab12cd34".to_owned(),
        String::new(),
        format!("{root}/proj-ab12cd34\0"),
    ];
    for home in &bad {
        assert!(f.remove(home, "ab12cd34").is_err(), "{home:?}");
    }
    // 루트도 같은 규칙이다
    for bad_root in [format!("{root}/"), format!("{root}//"), format!("{root}/."), format!("{root}/../sessions"), "/".to_owned(), String::new()] {
        assert!(remove_session_home(&bad_root, &f.s(&own), "ab12cd34", None).is_err(), "{bad_root:?}");
    }
    // 루트가 `/`이면 "바로 아래"가 뜻이 없다(없는 폴더라 지울 것도 없지만 통과시키지 않는다)
    assert!(remove_session_home("/", "/proj-ab12cd34", "ab12cd34", None).is_err());
    assert!(own.exists() && other.exists());
}

#[test]
fn 대소문자만_다른_루트는_파일_시스템과_상관없이_거부한다() {
    // 대소문자를 구분하지 않는 볼륨에서는 같은 폴더를 가리킨다. 구분하는 볼륨에서는 다른(없는) 폴더다. 어느 쪽에서도 지우지 않는다(허용 목록은 모르면 거부)
    let f = fixture();
    let home = f.session("proj-ab12cd34");
    let upper_root = f.s(&f.base.join("SESSIONS"));
    assert!(remove_session_home(&upper_root, &f.s(&home), "ab12cd34", None).is_err());
    let upper_home = f.s(&f.base.join("SESSIONS").join("proj-ab12cd34"));
    assert!(remove_session_home(&f.s(&f.root), &upper_home, "ab12cd34", None).is_err());
    let upper_name = f.s(&f.root.join("PROJ-AB12CD34"));
    assert!(remove_session_home(&f.s(&f.root), &upper_name, "ab12cd34", None).is_err());
    assert!(remove_session_home(&f.s(&f.root), &f.s(&f.root.join("proj-AB12CD34")), "ab12cd34", None).is_err());
    assert!(home.join("a.txt").exists());
}

#[test]
fn 세션_id가_폴더_이름에_쓸_수_없는_글자면_지우지_않는다() {
    let f = fixture();
    let home = f.session("proj-ab12cd34");
    for id in ["", "../x", "a/b", "ab12cd34/", "a\0b", "ab 12", &"a".repeat(65)] {
        assert!(f.remove(&f.s(&home), id).is_err(), "{id:?}");
    }
    assert!(home.exists());
    // 폴더 이름의 끝과 id가 글자로는 맞아도 id가 허용하는 글자(영문·숫자·`-`·`_`)가 아니면 지우지 않는다
    for id in ["", "a b", "é1", "a.b", &"a".repeat(65)] {
        let dir = f.root.join(format!("proj-{id}"));
        fs::create_dir_all(&dir).unwrap();
        assert!(f.remove(&f.s(&dir), id).is_err(), "{id:?}");
        assert!(dir.exists(), "{id:?}");
    }
}

#[test]
fn 링크인_세션_폴더는_지우지_않고_링크_너머도_남는다() {
    let f = fixture();
    let outside = f.precious("outside");
    let home = f.root.join("proj-ab12cd34");
    symlink(&outside, &home).unwrap();
    let err = f.remove(&f.s(&home), "ab12cd34").unwrap_err();
    assert_eq!(err.status, 500);
    intact(&outside);
    assert!(fs::symlink_metadata(&home).unwrap().file_type().is_symlink());
    // 파일이어도 지우지 않는다
    let file = f.root.join("proj-ffff0000");
    fs::write(&file, "x").unwrap();
    assert!(f.remove(&f.s(&file), "ffff0000").is_err());
    assert!(file.exists());
}

#[test]
fn 폴더_안의_링크는_링크만_지우고_너머는_남는다() {
    let f = fixture();
    let outside = f.precious("outside");
    let other = f.session("proj-ffff0000");
    let home = f.session("proj-ab12cd34");
    symlink(&outside, home.join("link-to-outside")).unwrap();
    symlink(outside.join("inner"), home.join("link-to-inner")).unwrap();
    symlink(&other, home.join(".git/b-studio/link-to-other")).unwrap();
    symlink(&f.root, home.join("link-to-root")).unwrap();
    symlink(f.base.join("missing"), home.join("dangling")).unwrap();
    f.remove(&f.s(&home), "ab12cd34").unwrap();
    assert!(!home.exists());
    intact(&outside);
    assert!(other.join("a.txt").exists());
    assert!(f.root.exists());
}

#[test]
fn 확인한_뒤_지우기_전에_폴더가_링크로_바뀌어도_링크만_지운다() {
    let f = fixture();
    let outside = f.precious("outside");
    let home = f.session("proj-ab12cd34");
    let swap = home.clone();
    let target = outside.clone();
    let result = remove_session_home_with(&f.s(&f.root), &f.s(&home), "ab12cd34", None, move || {
        // 확인(lstat)을 지난 직후 폴더를 지우고 같은 이름으로 바깥을 가리키는 링크를 놓는다
        fs::remove_dir_all(&swap).unwrap();
        symlink(&target, &swap).unwrap();
    });
    assert!(result.is_ok(), "{result:?}");
    intact(&outside);
    assert!(!home.exists() && fs::symlink_metadata(&home).is_err());
}

#[test]
fn 사용자_폴더가_세션_폴더이거나_그_안이면_지우지_않는다() {
    let f = fixture();
    let home = f.session("proj-ab12cd34");
    let root = f.s(&f.root);
    let inside = home.join("user-project");
    fs::create_dir_all(&inside).unwrap();
    fs::write(inside.join("mine.txt"), "keep").unwrap();
    // 같은 글자, 안의 폴더, 안의 폴더를 가리키는 바깥 링크, 세션 폴더를 가리키는 바깥 링크
    let alias_inside = f.base.join("alias-inside");
    symlink(&inside, &alias_inside).unwrap();
    let alias_home = f.base.join("alias-home");
    symlink(&home, &alias_home).unwrap();
    for user in [f.s(&home), f.s(&inside), f.s(&alias_inside), f.s(&alias_home), String::new()] {
        assert!(remove_session_home(&root, &f.s(&home), "ab12cd34", Some(&user)).is_err(), "{user:?}");
        assert!(inside.join("mine.txt").exists(), "{user:?}");
    }
    // 사용자 폴더가 따로 있거나 아직 없으면 지운다
    let user = f.precious("user-folder");
    remove_session_home(&root, &f.s(&home), "ab12cd34", Some(&f.s(&user))).unwrap();
    intact(&user);
    let home2 = f.session("proj-12345678");
    remove_session_home(&root, &f.s(&home2), "12345678", Some(&f.s(&f.base.join("no-such-folder")))).unwrap();
    assert!(!home2.exists());
}

#[test]
fn delete_check는_상태_다섯_가지와_작업_공간_두_가지를_옛_판정대로_가른다() {
    let f = fixture();
    let home = f.session("proj-ab12cd34");
    let (root, home_text) = (f.s(&f.root), f.s(&home));
    let user = f.s(&f.base.join("user"));
    for status in ["stopped", "idle", "ready", "starting", "failed", "running", ""] {
        for workspace in [None, Some("copy"), Some("local"), Some("weird")] {
            let local = workspace == Some("local");
            let input = DeleteInput {
                status,
                workspace,
                root: &root,
                home: &home_text,
                session_id: "ab12cd34",
                work_dir: if local { &user } else { &home_text },
                state_dir: local.then_some(home_text.as_str()),
            };
            let verdict = delete_check(&input);
            if status == "stopped" || status == "idle" {
                assert_eq!(verdict, Ok(()), "{status} {workspace:?}");
            } else {
                assert_eq!(verdict, Err(Fail::new(409, "실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요")), "{status} {workspace:?}");
            }
        }
    }
}

#[test]
fn delete_check는_저장_파일의_폴더가_home과_다르면_거부한다() {
    let f = fixture();
    let home = f.session("proj-ab12cd34");
    let other = f.session("proj-ffff0000");
    let outside = f.precious("outside");
    let (root, home_text) = (f.s(&f.root), f.s(&home));
    let base = |work_dir: &str, state_dir: Option<&str>, workspace: Option<&str>| {
        delete_check(&DeleteInput { status: "stopped", workspace, root: &root, home: &home_text, session_id: "ab12cd34", work_dir, state_dir })
    };
    let link = f.s(&home.join("link").join("inner"));
    for dir in [f.s(&other), f.s(&outside), f.s(&f.root), f.s(&f.base), link, format!("{home_text}/"), format!("{home_text}/../proj-ffff0000"), String::new()] {
        let err = base(&dir, None, None).unwrap_err();
        assert_eq!(err.status, 500, "{dir}");
        assert!(err.message.contains("세션 저장소 밖"), "{}", err.message);
        let err = base(&f.s(&outside), Some(&dir), Some("local")).unwrap_err();
        assert_eq!(err.status, 500, "{dir}");
    }
    // 내 폴더 세션의 상태 폴더가 없어 사용자 폴더와 같아지면 옛 오류 글이다
    let err = base(&f.s(&outside), None, Some("local")).unwrap_err();
    assert_eq!(err, Fail::new(500, "내 폴더 세션의 상태 폴더를 확인하지 못해 지우지 않았습니다"));
    let err = base(&f.s(&outside), Some(&f.s(&outside)), Some("local")).unwrap_err();
    assert_eq!(err.message, "내 폴더 세션의 상태 폴더를 확인하지 못해 지우지 않았습니다");
    // 내 폴더 세션의 사용자 폴더가 세션 폴더와 같으면(상태 폴더도 같다) 거부한다
    assert!(base(&home_text, Some(&home_text), Some("local")).is_err());
}

#[test]
fn resume_check는_저장_파일의_폴더가_home일_때만_통과한다() {
    let home = "/r/sessions/p-ab12cd34";
    // 작업 복사본: workDir(과 있으면 stateDir)이 home이다
    assert_eq!(resume_check(home, None, home, None), Ok(()));
    assert_eq!(resume_check(home, Some("copy"), home, Some(home)), Ok(()));
    // 내 폴더: stateDir이 home이고 사용자 폴더(workDir)는 home이 아니다
    assert_eq!(resume_check(home, Some("local"), "/u/project", Some(home)), Ok(()));
    for (workspace, work_dir, state_dir) in [
        (None, "/u/project", None),
        (None, "/r/sessions/p-ffff0000", None),
        (None, "/r/sessions/p-ab12cd34/link", None),
        (None, "/r/sessions/p-ab12cd34/", None),
        (None, "/r/sessions/p-ab12cd34/../p-ffff0000", None),
        (None, "/R/SESSIONS/P-AB12CD34", None),
        (None, "/r/sessions", None),
        (None, "", None),
        // 작업 복사본인데 stateDir이 있고 workDir이 다르다(workDir에서 git을 되돌리고 stateDir에만 쓰는 꼴)
        (None, "/u/project", Some(home)),
        (Some("copy"), home, Some("/u/project")),
        // 내 폴더인데 stateDir이 없다(workDir이 사용자 폴더면 home이 아니다)
        (Some("local"), "/u/project", None),
        (Some("local"), "/u/project", Some("/u/other")),
        (Some("local"), "/u/project", Some("/r/sessions/p-ab12cd34/link")),
        // 내 폴더의 사용자 폴더가 세션 폴더 자신이다
        (Some("local"), home, Some(home)),
    ] {
        let err = resume_check(home, workspace, work_dir, state_dir).unwrap_err();
        assert_eq!(err.status, 409, "{workspace:?} {work_dir:?} {state_dir:?}");
        assert!(err.message.contains("이 세션의 폴더와 달라"), "{}", err.message);
    }
}

#[test]
fn recover_plan은_주인_상태_터미널_정리_샌드박스_id를_옛_판정대로_가른다() {
    let id = "studio-web-abcdef";
    // 주인 프로세스: 이 프로세스가 아니고 살아 있으면 건너뛴다
    assert!(!recover_plan("stopped", 10.0, 10.0, true, id).skip);
    assert!(recover_plan("stopped", 11.0, 10.0, true, id).skip);
    assert!(!recover_plan("stopped", 11.0, 10.0, false, id).skip);
    // pid 0·음수: 살아 있는지는 부르는 쪽 결과를 따른다(kill(0, 0)은 살아 있다고 나온다)
    for pid in [0.0, -1.0, -999_999.0] {
        assert!(recover_plan("stopped", pid, 10.0, true, id).skip, "{pid}");
        assert!(!recover_plan("stopped", pid, 10.0, false, id).skip, "{pid}");
    }
    for (status, interrupted, terminal) in [("stopped", false, false), ("idle", false, true), ("ready", true, true), ("starting", true, true), ("failed", true, true), ("", true, true)] {
        let plan = recover_plan(status, 1.0, 2.0, false, id);
        assert_eq!((plan.interrupted, plan.cleanup_terminal), (interrupted, terminal), "{status}");
    }
}

#[test]
fn 샌드박스_id_꼴의_경계() {
    for ok in ["studio-a-abcdef", "studio-web-0123ab", "studio-my-app-2-ab12cd", "studio-a1-abcdef", "studio-a--abcdef", "studio-a-b-abcdef"] {
        assert!(is_sandbox_id(ok), "{ok}");
    }
    for bad in [
        "",
        "studio-",
        "studio--abcdef",
        "studio-a-abcde",
        "studio-a-abcdeff",
        "studio-a-ABCDEF",
        "studio-a-abcdeg",
        "studio-1a-abcdef",
        "studio-A-abcdef",
        "studio-a-abcdef\n",
        "studio-a-abcdef ",
        " studio-a-abcdef",
        "Studio-a-abcdef",
        "studio-a_b-abcdef",
        "studio-é-abcdef",
        "studio-a-abcdéf",
        "studio-a/../x-abcdef",
        "studio-a-abcdef-",
        "x-studio-a-abcdef",
    ] {
        assert!(!is_sandbox_id(bad), "{bad:?}");
    }
}
