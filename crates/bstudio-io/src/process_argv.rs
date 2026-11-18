//! 프로세스의 진짜 argv 읽기(ADR-219 후속, B5e). `ps -o args`는 낱말마다 따옴표를 잃어 요청 글이 든 인자와 진짜 옵션을 가르지 못한다.
//! 감시가 훅이 붙었는지 보려면 인자 하나하나를 알아야 한다.
//!
//! - macOS: `sysctl([CTL_KERN, KERN_PROCARGS2, pid])`. 앞 4바이트가 argc, 그다음 실행 경로(NUL로 끝), 채움 NUL들, argv argc개(각각 NUL로 끝)
//! - Linux: `/proc/<pid>/cmdline`을 NUL로 자른다
//! - 그 밖의 OS는 읽을 수 없음(`Err`)이다
//!
//! 읽을 것이 없다고 해도(`ESRCH`·`EINVAL`·파일 없음·빈 cmdline) 곧바로 끝난 것으로 보지 않는다: `kill(pid, 0)`이 `ESRCH`일 때만 `Ok(None)`이다.
//! macOS의 `EINVAL`은 살아 있는 다른 계정의 프로세스에도 나고, Linux의 `hidepid`는 `/proc/<pid>`를 숨긴다. 살아 있는데 읽지 못했으면 `Err`다 — 부른 쪽은 읽지 못한 것을 통과로 읽지 않는다.
//! 좀비는 ps 줄이 `(claude)`·`[claude] <defunct>` 꼴이라 CLI 후보 규칙(첫 낱말의 파일 이름이 CLI 이름)에 걸리지 않아 여기까지 오지 않는다.
//! 인자는 UTF-8로 읽고 깨진 바이트는 U+FFFD로 바꾼다(글자 그대로 견주는 쪽에서 같지 않게 되니 닫는 쪽이다).

use std::io;

/// macOS `KERN_PROCARGS2` 버퍼를 argv로 자른다. 모양이 틀리거나 argc개를 다 읽지 못하면 `Err`(읽다 만 것을 완전한 argv로 믿지 않는다)
pub fn parse_procargs2(buf: &[u8]) -> Result<Vec<String>, String> {
    if buf.len() < 4 {
        return Err("KERN_PROCARGS2 버퍼가 4바이트보다 짧습니다".to_owned());
    }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc < 0 {
        return Err(format!("argc가 음수입니다: {argc}"));
    }
    let mut at = 4;
    // 실행 경로(NUL로 끝)
    while at < buf.len() && buf[at] != 0 {
        at += 1;
    }
    // 채움 NUL
    while at < buf.len() && buf[at] == 0 {
        at += 1;
    }
    let mut argv = Vec::new();
    while argv.len() < argc as usize {
        if at >= buf.len() {
            return Err(format!("argv {argc}개 가운데 {}개만 읽었습니다", argv.len()));
        }
        let start = at;
        while at < buf.len() && buf[at] != 0 {
            at += 1;
        }
        if at >= buf.len() {
            // NUL로 끝나지 않은 마지막 인자: 잘렸을 수 있다
            return Err("마지막 인자가 NUL로 끝나지 않았습니다".to_owned());
        }
        argv.push(String::from_utf8_lossy(&buf[start..at]).into_owned());
        at += 1;
    }
    Ok(argv)
}

/// `/proc/<pid>/cmdline`을 argv로 자른다. 끝의 NUL 하나는 구분자다. 빈 글은 argv가 없는 것(좀비·커널 스레드)이라 `None`이다
pub fn parse_cmdline(buf: &[u8]) -> Option<Vec<String>> {
    if buf.is_empty() {
        return None;
    }
    let body = buf.strip_suffix(&[0]).unwrap_or(buf);
    Some(body.split(|b| *b == 0).map(|part| String::from_utf8_lossy(part).into_owned()).collect())
}

/// 플랫폼의 읽기 결과
#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    Argv(Vec<String>),
    /// 읽을 것이 없다고 했다(`ESRCH`·`EINVAL`·파일 없음·빈 cmdline). 끝난 것일 수도, 읽을 수 없는 살아 있는 프로세스(다른 계정 소유, `hidepid`)일 수도 있다
    Missing,
}

/// 프로세스가 있는가: `kill(pid, 0)`이 0이거나 `EPERM`이면 있고(다른 계정의 프로세스), `ESRCH`일 때만 없다. 그 밖의 실패는 오류다
#[cfg(unix)]
pub fn process_exists(pid: i64) -> io::Result<bool> {
    let pid: libc::pid_t = pid.try_into().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid가 범위 밖입니다"))?;
    // SAFETY: 신호 0은 보내지 않고 존재만 확인한다.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(error),
    }
}

#[cfg(not(unix))]
pub fn process_exists(_pid: i64) -> io::Result<bool> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "이 OS에서는 프로세스가 있는지 확인할 수 없습니다"))
}

/// 읽기와 존재 확인을 받아 판정한다(시험이 실패를 주입한다). `Missing`이면 프로세스가 **없다고 확인될 때만** `None`이다 —
/// 있거나 확인하지 못했으면 오류다(읽지 못한 살아 있는 프로세스를 끝난 것으로 건너뛰면 훅 없는 CLI가 통과한다)
pub fn process_argv_with(pid: i64, read: &dyn Fn(i64) -> io::Result<Read>, exists: &dyn Fn(i64) -> io::Result<bool>) -> io::Result<Option<Vec<String>>> {
    match read(pid)? {
        Read::Argv(argv) => Ok(Some(argv)),
        Read::Missing => {
            if exists(pid)? {
                Err(io::Error::other(format!("프로세스 {pid}의 argv를 읽지 못했는데 프로세스는 살아 있습니다")))
            } else {
                Ok(None)
            }
        }
    }
}

pub fn process_argv(pid: i64) -> io::Result<Option<Vec<String>>> {
    process_argv_with(pid, &read_argv, &process_exists)
}

#[cfg(target_os = "linux")]
fn read_argv(pid: i64) -> io::Result<Read> {
    match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(buf) => Ok(parse_cmdline(&buf).map_or(Read::Missing, Read::Argv)),
        Err(error) if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH) => Ok(Read::Missing),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
fn read_argv(pid: i64) -> io::Result<Read> {
    let pid: libc::c_int = pid.try_into().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid가 범위 밖입니다"))?;
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    // 크기를 먼저 묻는다. 그 사이 늘 수 있어 여유를 두고, 못 읽은 만큼은 parse가 Err로 알린다
    let mut size: libc::size_t = 0;
    // SAFETY: mib는 세 정수이고 널 포인터와 크기 0은 크기 질의다.
    let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) };
    if rc != 0 {
        return missing_or_err();
    }
    let mut buf = vec![0u8; size + 4096];
    let mut len: libc::size_t = buf.len();
    // SAFETY: buf는 len바이트를 가진 쓸 수 있는 버퍼다.
    let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    if rc != 0 {
        return missing_or_err();
    }
    buf.truncate(len);
    parse_procargs2(&buf).map(Read::Argv).map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message))
}

#[cfg(target_os = "macos")]
fn missing_or_err() -> io::Result<Read> {
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        // 프로세스가 없거나 읽을 수 없다(EINVAL은 살아 있는 다른 계정의 프로세스에도 난다). 끝났는지는 부른 쪽이 `kill(pid, 0)`로 가린다
        Some(libc::ESRCH) | Some(libc::EINVAL) => Ok(Read::Missing),
        _ => Err(error),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_argv(_pid: i64) -> io::Result<Read> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "이 OS에서는 프로세스의 argv를 읽을 수 없습니다"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn procargs(argc: i32, exec: &str, argv: &[&str]) -> Vec<u8> {
        let mut buf = argc.to_ne_bytes().to_vec();
        buf.extend_from_slice(exec.as_bytes());
        buf.extend_from_slice(&[0, 0, 0]);
        for arg in argv {
            buf.extend_from_slice(arg.as_bytes());
            buf.push(0);
        }
        buf.extend_from_slice(b"HOME=/x\0");
        buf
    }

    #[test]
    fn procargs2_splits_argv_and_ignores_the_environment() {
        let buf = procargs(3, "/bin/claude", &["claude", "--settings", "a b/c.json"]);
        assert_eq!(parse_procargs2(&buf).unwrap(), vec!["claude", "--settings", "a b/c.json"]);
        // 빈 인자도 하나다
        let buf = procargs(3, "/x", &["x", "", "y"]);
        assert_eq!(parse_procargs2(&buf).unwrap(), vec!["x", "", "y"]);
    }

    #[test]
    fn procargs2_short_or_truncated_is_an_error() {
        assert!(parse_procargs2(&[1, 0]).is_err());
        assert!(parse_procargs2(&procargs(5, "/x", &["a", "b"])).is_ok() == false);
        let mut cut = 2i32.to_ne_bytes().to_vec();
        cut.extend_from_slice(b"/x\0\0a\0b");
        assert!(parse_procargs2(&cut).is_err());
        assert!(parse_procargs2(&(-1i32).to_ne_bytes()).is_err());
    }

    #[test]
    fn cmdline_splits_on_nul() {
        assert_eq!(parse_cmdline(b"claude\0--settings\0x y\0").unwrap(), vec!["claude", "--settings", "x y"]);
        assert_eq!(parse_cmdline(b"a\0\0b\0").unwrap(), vec!["a", "", "b"]);
        assert_eq!(parse_cmdline(b""), None);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn reads_the_real_argv_of_a_child_we_started() {
        let mut child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let pid = i64::from(child.id());
        // exec 직후에는 아직 부모의 모습일 수 있어 잠깐 기다린다. Linux는 exec 도중 cmdline이 잠깐 비어 "살아 있는데 못 읽음"(오류)이 될 수 있어 그 동안은 다시 묻는다
        let mut argv = None;
        for _ in 0..50 {
            argv = process_argv(pid).ok().flatten();
            if argv.as_deref() == Some(&["/bin/sleep".to_owned(), "5".to_owned()][..]) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(argv, Some(vec!["/bin/sleep".to_owned(), "5".to_owned()]));
        // 끝나 거둔 프로세스는 None이다(없다고 확인된다)
        assert_eq!(process_argv(pid).unwrap(), None);
    }

    #[test]
    fn missing_is_none_only_when_the_process_is_confirmed_gone() {
        let missing = |_: i64| Ok(Read::Missing);
        assert_eq!(process_argv_with(7, &missing, &|_| Ok(false)).unwrap(), None);
        // 살아 있는데 읽지 못했다: 오류(끝난 것으로 건너뛰지 않는다)
        assert!(process_argv_with(7, &missing, &|_| Ok(true)).is_err());
        // 있는지 확인하지 못했다: 오류
        assert!(process_argv_with(7, &missing, &|_| Err(io::Error::other("kill 실패"))).is_err());
        // 읽기 자체의 실패는 그대로 오류
        assert!(process_argv_with(7, &|_| Err(io::Error::other("권한")), &|_| Ok(false)).is_err());
        // 읽었으면 존재 확인은 부르지 않는다
        let read = |_: i64| Ok(Read::Argv(vec!["a".to_owned()]));
        assert_eq!(process_argv_with(7, &read, &|_| panic!("부르면 안 된다")).unwrap(), Some(vec!["a".to_owned()]));
    }

    #[cfg(unix)]
    #[test]
    fn process_exists_tells_live_from_gone() {
        assert!(process_exists(i64::from(std::process::id())).unwrap());
        let mut child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let pid = i64::from(child.id());
        assert!(process_exists(pid).unwrap());
        let _ = child.kill();
        let _ = child.wait();
        assert!(!process_exists(pid).unwrap());
    }
}
