use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

fn spawn_on(handle: tokio::runtime::Handle) -> Spawn {
    Arc::new(move |future| {
        handle.spawn(future);
    })
}

struct Rig {
    persister: Persister,
    calls: Arc<AtomicUsize>,
    errors: Arc<Mutex<Vec<String>>>,
    file: PathBuf,
    _dir: tempfile::TempDir,
}

fn rig(delay: Duration, head: impl Fn(usize) -> String + Send + Sync + 'static) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(".git").join("s.json");
    let calls = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::new(Mutex::new(SessionRecord::new(true)));
    let (c, f) = (calls.clone(), file.clone());
    let source: Source = Arc::new(move |record| {
        let n = c.fetch_add(1, Ordering::SeqCst) + 1;
        let (file, head) = (f.clone(), head(n));
        Box::pin(async move {
            let bytes = build_session_bytes(&record.lock().unwrap(), &head, "{}", true)?;
            Ok(Prepared { file, bytes })
        })
    });
    let e = errors.clone();
    let report: Report = Arc::new(move |message| e.lock().unwrap().push(message));
    let persister = Persister::with_delay(record, source, report, spawn_on(tokio::runtime::Handle::current()), delay);
    Rig { persister, calls, errors, file, _dir: dir }
}

#[tokio::test(flavor = "multi_thread")]
async fn 예약이_겹쳐도_한_번만_쓰고_처음_예약한_때부터_센다() {
    let r = rig(Duration::from_millis(80), |n| format!("{{\"n\":{n}}}"));
    for _ in 0..20 {
        r.persister.schedule();
    }
    assert!(!r.file.exists());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(r.calls.load(Ordering::SeqCst), 1);
    // 예약을 계속해도 처음 예약한 때부터 센다
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(400) {
        r.persister.schedule();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(r.calls.load(Ordering::SeqCst) >= 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn flush는_예약을_지우고_cancel은_쓰지_않는다() {
    let r = rig(Duration::from_millis(60), |n| format!("{{\"n\":{n}}}"));
    r.persister.schedule();
    assert_eq!(r.persister.flush().await.unwrap(), None);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(r.calls.load(Ordering::SeqCst), 1);
    r.persister.schedule();
    r.persister.cancel();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(r.calls.load(Ordering::SeqCst), 1);
    r.persister.schedule();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(r.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn 앞의_쓰기가_끝난_뒤에_다음_상태를_읽는다() {
    let dir_file = Arc::new(Mutex::new(PathBuf::new()));
    let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let r = {
        let (dir_file, seen) = (dir_file.clone(), seen.clone());
        rig(Duration::from_secs(60), move |n| {
            let file = dir_file.lock().unwrap().clone();
            seen.lock().unwrap().push(std::fs::read_to_string(file).ok());
            format!("{{\"n\":{n}}}")
        })
    };
    *dir_file.lock().unwrap() = r.file.clone();
    let results: Vec<_> = (0..6).map(|_| r.persister.flush()).collect();
    for result in results {
        assert_eq!(result.await.unwrap(), None);
    }
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen[0], None);
    for n in 1..6 {
        assert_eq!(seen[n].as_deref(), Some(format!("{{\"n\":{n},\"history\":[]}}").as_str()), "{n}번째");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 상태를_못_만들거나_쓰기가_실패하면_이유를_알리고_다음은_계속한다() {
    let r = rig(Duration::from_secs(60), |n| if n == 1 { "[1]".to_owned() } else { format!("{{\"n\":{n}}}") });
    let first = r.persister.flush().await.unwrap();
    assert!(first.unwrap().contains("head"));
    assert!(!r.file.exists());
    assert_eq!(r.persister.flush().await.unwrap(), None);
    assert!(r.file.exists());
    // 쓰기 실패: 파일 자리에 폴더
    std::fs::remove_file(&r.file).unwrap();
    std::fs::create_dir(&r.file).unwrap();
    assert!(r.persister.flush().await.unwrap().is_some());
    std::fs::remove_dir(&r.file).unwrap();
    assert_eq!(r.persister.flush().await.unwrap(), None);
    assert!(r.errors.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn 예약한_쓰기의_실패는_report로_알린다() {
    let r = rig(Duration::from_millis(30), |_| "[1]".to_owned());
    r.persister.schedule();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(r.errors.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn idle은_줄에_선_쓰기가_끝난_뒤에_풀린다() {
    let r = rig(Duration::from_secs(60), |n| format!("{{\"n\":{n}}}"));
    let _a = r.persister.flush();
    let _b = r.persister.flush();
    r.persister.idle().await.unwrap();
    assert_eq!(r.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn flush_sync는_exit_임시_파일을_쓴다() {
    let r = rig(Duration::from_secs(60), |n| format!("{{\"n\":{n}}}"));
    let exit = format!("{}.{}.exit.tmp", r.file.display(), std::process::id());
    std::fs::create_dir_all(&exit).unwrap();
    assert!(r.persister.flush_sync(&r.file, "{}", "{}").unwrap_err().contains("exit.tmp"));
    std::fs::remove_dir(&exit).unwrap();
    r.persister.flush_sync(&r.file, "{\"a\":1}", "{}").unwrap();
    assert_eq!(std::fs::read_to_string(&r.file).unwrap(), "{\"a\":1,\"history\":[]}");
}
