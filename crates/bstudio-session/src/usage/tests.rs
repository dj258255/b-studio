use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

fn usage(input: f64) -> Usage {
    Usage { input, output: 10.0, cache_read: 0.0, cache_write: 0.0 }
}

fn dir() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("usage");
    (root, dir)
}

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn a_missing_file_means_nobody_has_used_anything() {
    let (_root, dir) = dir();
    assert_eq!(user_usage(&dir, "2026-09-12", "alice").unwrap(), None);
    assert_eq!(read_json(&dir).unwrap(), r#"{"version":1,"periods":{}}"#);
}

#[test]
fn adding_writes_the_exact_old_text_and_permissions() {
    let (_root, dir) = dir();
    assert_eq!(add(&dir, "2026-09-12", "alice", &usage(100.0), WAIT).unwrap(), usage(100.0));
    assert_eq!(add(&dir, "2026-09-12", "alice", &usage(50.0), WAIT).unwrap(), Usage { input: 150.0, output: 20.0, cache_read: 0.0, cache_write: 0.0 });
    add(&dir, "2026-09-12", "bob", &usage(7.0), WAIT).unwrap();
    let text = fs::read_to_string(dir.join(FILE)).unwrap();
    // `JSON.stringify({version:1, periods}, null, 2)`와 같은 글자
    let expected = r#"{
  "version": 1,
  "periods": {
    "2026-09-12": {
      "alice": {
        "inputTokens": 150,
        "outputTokens": 20,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0
      },
      "bob": {
        "inputTokens": 7,
        "outputTokens": 10,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0
      }
    }
  }
}"#;
    assert_eq!(text, expected);
    assert_eq!(user_usage(&dir, "2026-09-12", "alice").unwrap().unwrap().total(), 170.0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(dir.join(LOCK_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // 임시 파일이 남지 않는다
    let names: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(names.iter().all(|name| !name.ends_with(".tmp")), "{names:?}");
}

#[test]
fn only_the_last_forty_periods_stay() {
    let (_root, dir) = dir();
    for day in 1..=45 {
        add(&dir, &format!("2026-08-{day:02}"), "alice", &usage(1.0), WAIT).unwrap();
    }
    let json = read_json(&dir).unwrap();
    assert!(!json.contains("2026-08-05\""), "가장 오래된 기간은 지운다");
    assert!(json.contains("2026-08-06\""));
    assert!(json.contains("2026-08-45\""));
    assert_eq!(json.matches("2026-08-").count(), 40);
    // 이미 있는 기간에 더해도 순서·개수가 같다
    add(&dir, "2026-08-06", "alice", &usage(1.0), WAIT).unwrap();
    assert_eq!(read_json(&dir).unwrap().matches("2026-08-").count(), 40);
}

#[test]
fn keys_follow_the_javascript_order() {
    let (_root, dir) = dir();
    for user in ["zed", "10", "9", "alice"] {
        add(&dir, "2026-09-12", user, &usage(1.0), WAIT).unwrap();
    }
    let text = fs::read_to_string(dir.join(FILE)).unwrap();
    let at = |name: &str| text.find(&format!("\"{name}\": {{")).unwrap();
    // 정수 꼴 이름(9, 10)이 먼저 오름차순, 나머지는 넣은 순서
    assert!(at("9") < at("10") && at("10") < at("zed") && at("zed") < at("alice"), "{text}");
}

#[test]
fn untouched_entries_stay_byte_for_byte() {
    let (_root, dir) = dir();
    fs::create_dir_all(&dir).unwrap();
    // 이전 판이 쓴 파일에 다른 기간·사람이 있고, 값이 비어 있는 항목도 있다
    let before = r#"{"version":1,"periods":{"2026-09-11":{"carol":{"inputTokens":5,"outputTokens":6,"cacheReadTokens":7,"cacheWriteTokens":8}},"2026-09-12":{"bob":{"inputTokens":3}}}}"#;
    fs::write(dir.join(FILE), before).unwrap();
    assert_eq!(add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).unwrap(), usage(1.0));
    let text = fs::read_to_string(dir.join(FILE)).unwrap();
    let parsed = js_json::parse(&text).unwrap();
    let again = js_json::parse(before).unwrap();
    let (JsValue::Obj(p), JsValue::Obj(a)) = (&parsed, &again) else { panic!() };
    let (Some(JsValue::Obj(pp)), Some(JsValue::Obj(ap))) = (p.get("periods"), a.get("periods")) else { panic!() };
    assert_eq!(pp.get("2026-09-11"), ap.get("2026-09-11"));
    let Some(JsValue::Obj(people)) = pp.get("2026-09-12") else { panic!() };
    assert_eq!(people.get("bob"), Some(&js_json::parse(r#"{"inputTokens":3}"#).unwrap()));
    // 빠진 필드는 0이다
    assert_eq!(user_usage(&dir, "2026-09-12", "bob").unwrap().unwrap().total(), 3.0);
}

#[test]
fn a_broken_file_is_an_error_and_never_overwritten() {
    for (content, reason) in [("{깨진", "JSON이 아닙니다"), ("[1]", "periods가 객체여야 합니다"), (r#"{"periods":3}"#, "periods가 객체여야 합니다"), ("null", "periods가 객체여야 합니다"), ("", "JSON이 아닙니다")] {
        let (_root, dir) = dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE), content).unwrap();
        let error = user_usage(&dir, "2026-09-12", "alice").unwrap_err();
        assert!(error.contains("tokens.json") && error.contains(reason), "{content}: {error}");
        assert!(read_json(&dir).is_err());
        let error = add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).unwrap_err();
        assert!(error.contains(reason), "{content}: {error}");
        // 덮어쓰지 않았다
        assert_eq!(fs::read_to_string(dir.join(FILE)).unwrap(), content);
    }
}

#[test]
fn entries_that_are_not_numbers_are_unreadable_not_zero() {
    for entry in [r#""abc""#, r#"{"inputTokens":"5"}"#, r#"{"inputTokens":-1}"#, r#"{"outputTokens":1e999}"#, "[]", "5"] {
        let (_root, dir) = dir();
        fs::create_dir_all(&dir).unwrap();
        let content = format!(r#"{{"version":1,"periods":{{"2026-09-12":{{"alice":{entry}}}}}}}"#);
        fs::write(dir.join(FILE), &content).unwrap();
        assert!(user_usage(&dir, "2026-09-12", "alice").is_err(), "{entry}");
        assert!(add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).is_err(), "{entry}");
        assert_eq!(fs::read_to_string(dir.join(FILE)).unwrap(), content);
        // 다른 사람은 읽을 수 있다
        assert_eq!(user_usage(&dir, "2026-09-12", "bob").unwrap(), None);
    }
    // 기간이 객체가 아니어도 그 기간을 읽을 때만 오류다
    let (_root, dir) = dir();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(FILE), r#"{"periods":{"2026-09-11":5}}"#).unwrap();
    assert_eq!(user_usage(&dir, "2026-09-12", "alice").unwrap(), None);
    assert!(user_usage(&dir, "2026-09-11", "alice").is_err());
}

#[test]
fn prototype_like_names_are_plain_users() {
    let (_root, dir) = dir();
    for name in ["__proto__", "constructor", "toString"] {
        assert_eq!(user_usage(&dir, "2026-09-12", name).unwrap(), None);
        add(&dir, "2026-09-12", name, &usage(5.0), WAIT).unwrap();
        assert_eq!(user_usage(&dir, "2026-09-12", name).unwrap().unwrap().input, 5.0);
    }
}

#[test]
fn rejects_unusable_amounts() {
    assert!(Usage::checked(f64::NAN, 0.0, 0.0, 0.0).is_err());
    assert!(Usage::checked(0.0, -1.0, 0.0, 0.0).is_err());
    assert!(Usage::checked(0.0, 0.0, f64::INFINITY, 0.0).is_err());
    assert!(Usage::checked(1.0, 2.0, 3.0, 4.0).is_ok());
}

#[test]
fn a_replaced_file_is_read_again() {
    let (_root, dir) = dir();
    add(&dir, "2026-09-12", "alice", &usage(5.0), WAIT).unwrap();
    assert_eq!(user_usage(&dir, "2026-09-12", "alice").unwrap().unwrap().input, 5.0);
    // 같은 길이의 다른 내용을 다른 파일로 바꿔 치운다(rename)
    let current = fs::read_to_string(dir.join(FILE)).unwrap();
    let replaced = current.replace("\"inputTokens\": 5,", "\"inputTokens\": 9,");
    assert_eq!(replaced.len(), current.len());
    let next = dir.join("next.tmp");
    fs::write(&next, &replaced).unwrap();
    fs::rename(&next, dir.join(FILE)).unwrap();
    assert_eq!(user_usage(&dir, "2026-09-12", "alice").unwrap().unwrap().input, 9.0);
    // 지우면 쓴 사람이 없다
    fs::remove_file(dir.join(FILE)).unwrap();
    assert_eq!(user_usage(&dir, "2026-09-12", "alice").unwrap(), None);
}

#[test]
fn a_huge_file_is_refused_before_reading() {
    let (_root, dir) = dir();
    fs::create_dir_all(&dir).unwrap();
    let file = File::create(dir.join(FILE)).unwrap();
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    let error = user_usage(&dir, "2026-09-12", "alice").unwrap_err();
    assert!(error.contains("너무 큽니다"), "{error}");
    assert!(add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).is_err());
}

#[test]
fn threads_adding_at_once_lose_nothing() {
    let (_root, dir) = dir();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let dir = dir.clone();
            std::thread::spawn(move || {
                for _ in 0..40 {
                    add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).unwrap();
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(user_usage(&dir, "2026-09-12", "alice").unwrap().unwrap().input, 320.0);
}

#[test]
fn a_lock_held_by_someone_else_times_out_without_writing() {
    let (_root, dir) = dir();
    add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).unwrap();
    let before = fs::read_to_string(dir.join(FILE)).unwrap();
    // 다른 프로세스가 잡은 것처럼 별도의 열린 파일로 잠근다(파일 잠금은 열린 파일 단위라 같은 프로세스의 다른 핸들도 막힌다)
    let holder = OpenOptions::new().write(true).open(dir.join(LOCK_FILE)).unwrap();
    holder.lock().unwrap();
    let started = Instant::now();
    let error = add(&dir, "2026-09-12", "alice", &usage(1.0), Duration::from_millis(80)).unwrap_err();
    assert!(started.elapsed() >= Duration::from_millis(80) && started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    assert!(error.contains("잠금") && error.contains("쓰지 않았습니다"), "{error}");
    assert_eq!(fs::read_to_string(dir.join(FILE)).unwrap(), before);
    // 읽기는 잠금과 상관없다
    assert!(user_usage(&dir, "2026-09-12", "alice").is_ok());
    // 놓으면 다시 쓸 수 있다
    drop(holder);
    assert_eq!(add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).unwrap().input, 2.0);
}

#[test]
fn waiting_for_a_lock_succeeds_when_it_is_released_in_time() {
    let (_root, dir) = dir();
    add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).unwrap();
    let holder = OpenOptions::new().write(true).open(dir.join(LOCK_FILE)).unwrap();
    holder.lock().unwrap();
    let released = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&released);
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        flag.store(true, Ordering::SeqCst);
        drop(holder);
    });
    assert_eq!(add(&dir, "2026-09-12", "alice", &usage(1.0), WAIT).unwrap().input, 2.0);
    assert!(released.load(Ordering::SeqCst), "잠금이 풀리기 전에는 쓰지 못한다");
    releaser.join().unwrap();
}
