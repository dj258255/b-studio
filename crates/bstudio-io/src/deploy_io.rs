//! 배포(`packages/sandbox/src/docker/deploy.ts`)의 개별 I/O 호출을 옮긴 것(ADR-193, 2c-5).
//! 빌드 스트림(`#docker`)은 2c-3a의 `streaming`이 하고, 여기는 나머지다: 배포 잠금, 빈 포트, 상태·compose 파일,
//! 운영 주소 확인용 HTTP 한 번. 단계 순서·재시도 루프는 TS 오케스트레이션이라 옮기지 않는다.

use std::io::{self, ErrorKind, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 잠금을 잡으려 한 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum LockOutcome {
    Acquired,
    /// 살아 있는 다른(또는 같은) 프로세스가 쥐고 있다. 값은 그 pid.
    Held(u32),
}

/// `127.0.0.1`의 빈 포트 하나. 닫은 뒤 돌려주므로 사용 전에 다른 프로세스가 가져갈 수 있다(TS freePort와 같다).
pub fn free_port() -> io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// 배포 잠금 파일을 `O_EXCL`로 만들고 이 프로세스의 pid를 적는다.
/// 이미 있으면 적힌 pid를 읽어 살아 있으면 `Held`, 아니면(죽었거나 읽을 수 없거나 pid가 아님) 지우고 한 번만 다시 시도한다.
/// 그 외 오류와 두 번째 `AlreadyExists`는 오류로 돌려준다. 부모 폴더가 없으면 만든다.
pub fn acquire_lock(lock: &Path) -> io::Result<LockOutcome> {
    ensure_parent(lock)?;
    for attempt in 0..2 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(lock) {
            Ok(mut file) => {
                file.write_all(std::process::id().to_string().as_bytes())?;
                return Ok(LockOutcome::Acquired);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists && attempt == 0 => {
                let owner = std::fs::read_to_string(lock).ok().and_then(|text| text.trim().parse::<u32>().ok()).filter(|pid| *pid > 0);
                if let Some(pid) = owner {
                    if is_alive(pid) {
                        return Ok(LockOutcome::Held(pid));
                    }
                }
                let _ = std::fs::remove_file(lock);
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("두 번째 시도는 위에서 반드시 반환한다")
}

/// 잠금 파일을 지운다. 이미 없거나 지우지 못해도 알리지 않는다(TS `unlink().catch(() => {})`와 같다).
pub fn release_lock(lock: &Path) {
    let _ = std::fs::remove_file(lock);
}

#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    if pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: 신호 0은 보내지 않고 존재만 확인한다.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn is_alive(_pid: u32) -> bool {
    // 확인할 수 없으면 살아 있다고 본다: 잠금을 가로채지 않는 쪽으로 틀린다.
    true
}

/// 파일을 문자열로 읽는다. 없거나 읽지 못하거나 UTF-8이 아니면 `None`(TS `readFile(...).catch(() => undefined)`).
pub fn read_text(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// 부모 폴더를 만들고 파일을 쓴다(덮어쓴다).
pub fn write_text(path: &Path, content: &str) -> io::Result<()> {
    ensure_parent(path)?;
    std::fs::write(path, content)
}

/// 부모 폴더를 만들고 `<path>.<pid>.tmp`에 쓴 뒤 `rename`으로 바꿔 넣는다. 쓰는 도중의 반쪽 파일이 보이지 않는다.
pub fn write_text_atomic(path: &Path, content: &str) -> io::Result<()> {
    ensure_parent(path)?;
    let mut temp = path.as_os_str().to_owned();
    temp.push(format!(".{}.tmp", std::process::id()));
    let temp = PathBuf::from(temp);
    if let Err(error) = std::fs::write(&temp, content).and_then(|_| std::fs::rename(&temp, path)) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

fn ensure_parent(path: &Path) -> io::Result<()> {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => std::fs::create_dir_all(parent),
        _ => Ok(()),
    }
}

/// `http://127.0.0.1:<port><path>`에 GET을 한 번 보내 상태 코드만 돌려준다(리다이렉트를 따르지 않고 본문을 읽지 않는다).
/// 연결부터 상태 줄까지 `timeout` 안에 끝나야 한다. 실패는 사람이 읽을 문장으로 돌려준다.
/// 경로는 `fetch`처럼 퍼센트 인코딩 집합 밖의 바이트(공백·제어·비ASCII 등)를 인코딩하고 `#` 뒤를 버린다.
/// `fetch`가 해 주던 `..` 정규화는 하지 않는다. 호스트는 `127.0.0.1`로 고정이라 요청이 다른 곳으로 나가지 않는다.
pub async fn probe_http_status(port: u16, path: &str, timeout: Duration) -> Result<u16, String> {
    let request = build_request(port, path);
    match tokio::time::timeout(timeout, async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| format!("연결하지 못했습니다: {e}"))?;
        stream.write_all(request.as_bytes()).await.map_err(|e| format!("요청을 보내지 못했습니다: {e}"))?;
        let mut head = Vec::with_capacity(256);
        let mut chunk = [0u8; 256];
        loop {
            if let Some(end) = head.iter().position(|b| *b == b'\n') {
                return parse_status(&head[..end]);
            }
            if head.len() > 8192 {
                return Err("응답 상태 줄이 너무 깁니다".to_string());
            }
            let read = stream.read(&mut chunk).await.map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?;
            if read == 0 {
                return Err("응답이 상태 줄 없이 끝났습니다".to_string());
            }
            head.extend_from_slice(&chunk[..read]);
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("시간이 지났습니다".to_string()),
    }
}

fn build_request(port: u16, path: &str) -> String {
    let path = path.split('#').next().unwrap_or("");
    let mut target = String::with_capacity(path.len() + 1);
    if !path.starts_with('/') {
        target.push('/');
    }
    for byte in path.bytes() {
        if byte <= 0x20 || byte >= 0x7f || matches!(byte, b'"' | b'<' | b'>' | b'`' | b'{' | b'}' | b'\\') {
            target.push_str(&format!("%{byte:02X}"));
        } else {
            target.push(byte as char);
        }
    }
    format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n")
}

fn parse_status(line: &[u8]) -> Result<u16, String> {
    let text = String::from_utf8_lossy(line);
    let mut parts = text.trim_end().splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let code = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/") || code.len() != 3 {
        return Err("HTTP 응답이 아닙니다".to_string());
    }
    code.parse::<u16>().map_err(|_| "HTTP 상태 코드를 읽지 못했습니다".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener as AsyncListener;

    #[test]
    fn 빈_포트는_바로_다시_묶을_수_있다() {
        let port = free_port().unwrap();
        assert!(port > 0);
        TcpListener::bind(("127.0.0.1", port)).unwrap();
    }

    #[test]
    fn 잠금은_한_번만_잡히고_이_프로세스가_쥐고_있다고_알린다() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("deploy.lock");
        assert_eq!(acquire_lock(&lock).unwrap(), LockOutcome::Acquired);
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), std::process::id().to_string());
        assert_eq!(acquire_lock(&lock).unwrap(), LockOutcome::Held(std::process::id()));
        release_lock(&lock);
        assert!(!lock.exists());
        assert_eq!(acquire_lock(&lock).unwrap(), LockOutcome::Acquired);
    }

    #[test]
    fn 죽은_프로세스의_잠금은_넘겨받는다() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("deploy.lock");
        // 끝난 자식의 pid는 더 이상 살아 있지 않다
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        std::fs::write(&lock, dead.to_string()).unwrap();
        assert_eq!(acquire_lock(&lock).unwrap(), LockOutcome::Acquired);
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), std::process::id().to_string());
    }

    #[test]
    fn 읽을_수_없는_잠금_내용은_넘겨받는다() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("deploy.lock");
        for content in ["", "abc", "0", "-5"] {
            std::fs::write(&lock, content).unwrap();
            assert_eq!(acquire_lock(&lock).unwrap(), LockOutcome::Acquired, "내용 {content:?}");
            release_lock(&lock);
        }
    }

    #[test]
    fn 잠금은_없는_부모_폴더를_만들고_폴더가_파일이면_오류다() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(acquire_lock(&dir.path().join("없음/deploy.lock")).unwrap(), LockOutcome::Acquired);
        std::fs::write(dir.path().join("파일"), "x").unwrap();
        assert!(acquire_lock(&dir.path().join("파일/deploy.lock")).is_err());
    }

    #[test]
    fn 읽기는_없으면_none이다() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_text(&dir.path().join("없음.json")), None);
        std::fs::write(dir.path().join("a.txt"), "안녕").unwrap();
        assert_eq!(read_text(&dir.path().join("a.txt")).as_deref(), Some("안녕"));
    }

    #[test]
    fn 쓰기는_부모를_만들고_덮어쓴다() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a/b/c.yaml");
        write_text(&file, "one").unwrap();
        write_text(&file, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
    }

    #[test]
    fn 원자적_쓰기는_임시_파일을_남기지_않는다() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x/state.json");
        write_text_atomic(&file, "{}\n").unwrap();
        write_text_atomic(&file, "{\"a\":1}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"a\":1}\n");
        let names: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("state.json")]);
    }

    #[test]
    fn 원자적_쓰기가_실패하면_임시_파일을_지운다() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("dest");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "x").unwrap();
        // 폴더 위로 rename은 실패한다
        assert!(write_text_atomic(&target, "z").is_err());
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("dest")]);
    }

    async fn serve_once(response: &'static [u8]) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = AsyncListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 2048];
            let read = socket.read(&mut buf).await.unwrap();
            socket.write_all(response).await.unwrap();
            String::from_utf8_lossy(&buf[..read]).to_string()
        });
        (port, handle)
    }

    #[tokio::test]
    async fn 상태_코드만_읽고_리다이렉트를_따르지_않는다() {
        let (port, handle) = serve_once(b"HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\n\r\n").await;
        assert_eq!(probe_http_status(port, "/health", Duration::from_secs(2)).await, Ok(302));
        let request = handle.await.unwrap();
        assert!(request.starts_with("GET /health HTTP/1.1\r\n"), "{request}");
        assert!(request.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
    }

    #[tokio::test]
    async fn 경로의_공백과_개행은_인코딩되어_요청_줄을_깨지_못한다() {
        let (port, handle) = serve_once(b"HTTP/1.1 200 OK\r\n\r\n").await;
        probe_http_status(port, "/a b\r\nX-Evil: 1#frag", Duration::from_secs(2)).await.unwrap();
        let request = handle.await.unwrap();
        assert!(request.starts_with("GET /a%20b%0D%0AX-Evil:%201 HTTP/1.1\r\n"), "{request}");
        assert!(!request.contains("\r\nX-Evil"));
    }

    #[tokio::test]
    async fn http가_아닌_응답과_닫힌_포트와_멈춘_서버는_오류다() {
        let (port, _h) = serve_once(b"garbage\r\n").await;
        assert!(probe_http_status(port, "/", Duration::from_secs(2)).await.is_err());
        let closed = free_port().unwrap();
        assert!(probe_http_status(closed, "/", Duration::from_secs(2)).await.is_err());
        let listener = AsyncListener::bind(("127.0.0.1", 0)).await.unwrap();
        let hang = listener.local_addr().unwrap().port();
        let _keep = tokio::spawn(async move {
            let _s = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let err = probe_http_status(hang, "/", Duration::from_millis(200)).await.unwrap_err();
        assert!(err.contains("시간"), "{err}");
    }
}
