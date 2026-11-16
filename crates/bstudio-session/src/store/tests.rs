use super::*;
use std::fs;

fn record_with(events: &[&str]) -> SessionRecord {
    let mut record = SessionRecord::new(true);
    for event in events {
        record.push((*event).to_owned()).unwrap();
    }
    record
}

#[test]
fn 저장_파일은_head_history_tail을_이어_쓴다() {
    let record = record_with(&[r#"{"type":"notice","text":"a"}"#, r#"{"type":"status"}"#, r#"{"type":"log"}"#]);
    let bytes = build_session_bytes(&record, r#"{"version":1}"#, r#"{"x":2}"#, true).unwrap();
    assert_eq!(String::from_utf8(bytes).unwrap(), r#"{"version":1,"history":[{"type":"notice","text":"a"}],"x":2}"#);
    let all = build_session_bytes(&record, r#"{"version":1}"#, r#"{"x":2}"#, false).unwrap();
    assert!(String::from_utf8(all).unwrap().contains(r#"{"type":"status"}"#));
    assert_eq!(String::from_utf8(build_session_bytes(&record_with(&[]), "{}", "{}", true).unwrap()).unwrap(), r#"{"history":[]}"#);
}

#[test]
fn head와_tail이_객체_글자가_아니면_쓰지_않는다() {
    let record = record_with(&[]);
    for (head, tail) in [("[1]", "{}"), ("{}", "[1]"), ("", "{}"), ("{}", ""), ("{", "{}"), ("\"x\"", "{}"), ("}", "{}"), (" {}", "{}"), ("{}", "{} ")] {
        assert!(build_session_bytes(&record, head, tail, true).is_err(), "{head:?} {tail:?}");
    }
}

#[test]
fn 표시_객체와_nul_키는_파일_글자로_바꿔_쓴다() {
    let record = record_with(&[r#"{"type":"agent","v":{"\u0000nf":"NaN"},"\u0000\u0000k":1}"#]);
    let text = String::from_utf8(build_session_bytes(&record, "{}", "{}", true).unwrap()).unwrap();
    assert_eq!(text, r#"{"history":[{"type":"agent","v":null,"\u0000k":1}]}"#);
}

#[test]
fn 원자적_쓰기는_폴더를_만들고_임시_파일을_남기지_않는다() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a").join("b").join("s.json");
    write_file_atomic(&file, b"one", None, TempName::Random).unwrap();
    write_file_atomic(&file, b"two", None, TempName::Exit).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "two");
    assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn 임시_파일_이름은_호출마다_다르고_종료용은_exit다() {
    let file = Path::new("/x/session.json");
    let a = temp_path(file, TempName::Random);
    let b = temp_path(file, TempName::Random);
    assert_ne!(a, b);
    let pid = std::process::id();
    assert!(a.to_string_lossy().starts_with(&format!("/x/session.json.{pid}.")) && a.to_string_lossy().ends_with(".tmp"));
    assert_eq!(temp_path(file, TempName::Exit), PathBuf::from(format!("/x/session.json.{pid}.exit.tmp")));
}

#[test]
fn 쓰기가_실패하면_이유를_돌려주고_우리_임시_파일만_지운다() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("f");
    fs::write(&blocked, "x").unwrap();
    assert!(write_file_atomic(&blocked.join("g").join("s.json"), b"x", None, TempName::Random).is_err());
    let file = dir.path().join("s.json");
    fs::create_dir(&file).unwrap();
    fs::write(dir.path().join("keep.tmp"), "남의 파일").unwrap();
    assert!(write_file_atomic(&file, b"x", None, TempName::Random).is_err());
    let mut names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["f", "keep.tmp", "s.json"]);
}

fn put(root: &Path, name: &str, text: &str) {
    let file = session_file(&root.join(name));
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, text).unwrap();
}

const OK: &str = r#"{"version":1,"owner":{"pid":7},"snapshot":{"id":"a","workDir":"/w"},"sandbox":{"id":"s"},"history":[{"type":"notice"}]}"#;

#[test]
fn 형식_검사는_js의_참_거짓과_같다() {
    let dir = tempfile::tempdir().unwrap();
    let mut accepted = 0;
    let variants: Vec<(String, bool)> = vec![
        (OK.to_owned(), true),
        (OK.replace(r#""version":1"#, r#""version":1.0"#), true),
        (OK.replace(r#""version":1"#, r#""version":1e0"#), true),
        (OK.replace(r#""version":1"#, r#""version":"1""#), false),
        (OK.replace(r#""version":1"#, r#""version":2"#), false),
        (OK.replace(r#""pid":7"#, r#""pid":7.5"#), false),
        (OK.replace(r#""pid":7"#, r#""pid":-7"#), true),
        (OK.replace(r#""pid":7"#, r#""pid":0"#), true),
        (OK.replace(r#""pid":7"#, r#""pid":1e300"#), true),
        (OK.replace(r#""pid":7"#, r#""pid":1e999"#), false),
        (OK.replace(r#""pid":7"#, r#""pid":"7""#), false),
        (OK.replace(r#""id":"a""#, r#""id":"""#), false),
        (OK.replace(r#""id":"a""#, r#""id":0"#), false),
        (OK.replace(r#""id":"a""#, r#""id":"0""#), true),
        (OK.replace(r#""id":"a""#, r#""id":[]"#), true),
        (OK.replace(r#""id":"a""#, r#""id":null"#), false),
        (OK.replace(r#""id":"s""#, r#""id":false"#), false),
        (OK.replace(r#""workDir":"/w""#, r#""workDir":-0"#), false),
        (OK.replace(r#""version":1,"#, ""), false),
        (OK.replace(r#""version":1"#, r#""version":2,"version":1"#), true),
        (OK.replace(r#""version":1"#, r#""version":1,"version":2"#), false),
        (format!("\u{feff}{OK}"), false),
        ("[]".to_owned(), false),
        ("null".to_owned(), false),
        ("{".to_owned(), false),
    ];
    for (at, (text, ok)) in variants.iter().enumerate() {
        put(dir.path(), &format!("c{at:02}"), text);
        accepted += usize::from(*ok);
    }
    let found = read_sessions(dir.path());
    assert_eq!(found.len(), accepted);
}

#[test]
fn 읽기는_history를_뺀_나머지와_기록을_돌려준다() {
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "a", r#" {"version":1, "history":[1e999, {"\u0000k":-0}], "owner":{"pid":7},"snapshot":{"id":"a","workDir":"/w"},"sandbox":{"id":"s"} } "#);
    let found = read_sessions(dir.path());
    assert_eq!(found[0].rest, r#"{"version":1,"owner":{"pid":7},"snapshot":{"id":"a","workDir":"/w"},"sandbox":{"id":"s"}}"#);
    assert_eq!(found[0].history_error, None);
    assert_eq!(found[0].record.history(), [r#"{"\u0000nf":"Infinity"}"#, r#"{"\u0000\u0000k":{"\u0000nf":"-0"}}"#]);
}

#[test]
fn 읽은_세션은_읽어_온_폴더를_home으로_든다() {
    // 저장 파일의 경로 글자(`workDir`)가 아니라 `<root>/<항목 이름>`이다(ADR-204)
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "proj-aaaa0001", &OK.replace(r#""workDir":"/w""#, r#""workDir":"/somewhere/else""#));
    put(dir.path(), "proj-aaaa0002", OK);
    let found = read_sessions(dir.path());
    assert_eq!(found.iter().map(|s| s.home.clone()).collect::<Vec<_>>(), [dir.path().join("proj-aaaa0001"), dir.path().join("proj-aaaa0002")]);
}

#[test]
fn history가_없거나_배열이_아니면_이유가_붙는다() {
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "a", &OK.replace(r#","history":[{"type":"notice"}]"#, ""));
    put(dir.path(), "b", &OK.replace(r#"[{"type":"notice"}]"#, "{}"));
    let found = read_sessions(dir.path());
    assert_eq!(found.len(), 2);
    assert!(found.iter().all(|s| s.history_error.is_some() && s.record.history().is_empty()));
}

#[test]
fn 폴더가_아닌_항목과_링크는_건너뛰고_이름순으로_읽는다() {
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "b", OK);
    put(dir.path(), "a", &OK.replace(r#""id":"a""#, r#""id":"a1""#));
    fs::write(dir.path().join("file"), OK).unwrap();
    let target = tempfile::tempdir().unwrap();
    put(target.path(), "t", OK);
    #[cfg(unix)]
    std::os::unix::fs::symlink(target.path().join("t"), dir.path().join("link")).unwrap();
    let found = read_sessions(dir.path());
    assert_eq!(found.len(), 2);
    assert!(found[0].rest.contains(r#""id":"a1""#));
    assert!(read_sessions(&dir.path().join("none")).is_empty());
}

#[test]
fn 동시에_쓰는_스레드들이_임시_파일을_나눠_쓰지_않는다() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s.json");
    let handles: Vec<_> = (0..16)
        .map(|n| {
            let file = file.clone();
            std::thread::spawn(move || (0..20).try_for_each(|i| write_file_atomic(&file, format!("{n}-{i}").as_bytes(), None, TempName::Random)))
        })
        .collect();
    for handle in handles {
        handle.join().unwrap().unwrap();
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn 이름은_바이트_순서로_정렬한다() {
    let mut names: Vec<std::ffi::OsString> = ["b", "a1", "Z", "a", "한글", "a-"].iter().map(Into::into).collect();
    sort_names(&mut names);
    let sorted: Vec<_> = names.iter().map(|n| n.to_string_lossy().into_owned()).collect();
    assert_eq!(sorted, ["Z", "a", "a-", "a1", "b", "한글"]);
}
