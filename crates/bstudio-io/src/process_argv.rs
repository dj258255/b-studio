//! 프로세스의 진짜 argv 읽기(ADR-219 후속, B5e). `ps -o args`는 낱말마다 따옴표를 잃어 요청 글이 든 인자와 진짜 옵션을 가르지 못한다.
//! 감시가 훅이 붙었는지 보려면 인자 하나하나를 알아야 한다.
//!
//! - macOS: `sysctl([CTL_KERN, KERN_PROCARGS2, pid])`. 앞 4바이트가 argc, 그다음 실행 경로(NUL로 끝), 채움 NUL들, argv argc개(각각 NUL로 끝)
//! - Linux: `/proc/<pid>/cmdline`을 NUL로 자른다
//! - 그 밖의 OS는 읽을 수 없음(`Err`)이다
//!
//! 프로세스가 이미 끝났으면(`ESRCH`·`EINVAL`·파일 없음·빈 cmdline) `Ok(None)`이다. 그 밖의 실패는 `Err`다 — 부른 쪽은 읽지 못한 것을 통과로 읽지 않는다.
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

#[cfg(target_os = "linux")]
pub fn process_argv(pid: i64) -> io::Result<Option<Vec<String>>> {
    match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(buf) => Ok(parse_cmdline(&buf)),
        Err(error) if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
pub fn process_argv(pid: i64) -> io::Result<Option<Vec<String>>> {
    let pid: libc::c_int = pid.try_into().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid가 범위 밖입니다"))?;
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    // 크기를 먼저 묻는다. 그 사이 늘 수 있어 여유를 두고, 못 읽은 만큼은 parse가 Err로 알린다
    let mut size: libc::size_t = 0;
    // SAFETY: mib는 세 정수이고 널 포인터와 크기 0은 크기 질의다.
    let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) };
    if rc != 0 {
        return gone_or_err();
    }
    let mut buf = vec![0u8; size + 4096];
    let mut len: libc::size_t = buf.len();
    // SAFETY: buf는 len바이트를 가진 쓸 수 있는 버퍼다.
    let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    if rc != 0 {
        return gone_or_err();
    }
    buf.truncate(len);
    match parse_procargs2(&buf) {
        Ok(argv) => Ok(Some(argv)),
        Err(message) => Err(io::Error::new(io::ErrorKind::InvalidData, message)),
    }
}

#[cfg(target_os = "macos")]
fn gone_or_err() -> io::Result<Option<Vec<String>>> {
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        // 프로세스가 없거나 끝났다
        Some(libc::ESRCH) | Some(libc::EINVAL) => Ok(None),
        _ => Err(error),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn process_argv(_pid: i64) -> io::Result<Option<Vec<String>>> {
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
        // exec 직후에는 아직 부모의 모습일 수 있어 잠깐 기다린다
        let mut argv = None;
        for _ in 0..50 {
            argv = process_argv(pid).unwrap();
            if argv.as_deref() == Some(&["/bin/sleep".to_owned(), "5".to_owned()][..]) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(argv, Some(vec!["/bin/sleep".to_owned(), "5".to_owned()]));
        // 끝난 프로세스는 None이다
        assert_eq!(process_argv(pid).unwrap(), None);
    }
}
