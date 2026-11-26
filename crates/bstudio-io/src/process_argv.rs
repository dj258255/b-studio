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
    split_procargs2(buf).map(|(argv, _)| argv)
}

/// argv와, argv가 끝난 자리(envp가 시작하는 자리)
fn split_procargs2(buf: &[u8]) -> Result<(Vec<String>, usize), String> {
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
    Ok((argv, at))
}

/// 환경 변수 한 줄(`NAME=값`)을 나눈다. `=`가 없거나 이름이 비면 변수가 아니라 건너뛴다(그런 줄은 어떤 이름과도 맞지 않는다)
fn split_env_entry(entry: &[u8]) -> Option<(String, String)> {
    let eq = entry.iter().position(|b| *b == b'=')?;
    if eq == 0 {
        return None;
    }
    Some((String::from_utf8_lossy(&entry[..eq]).into_owned(), String::from_utf8_lossy(&entry[eq + 1..]).into_owned()))
}

/// macOS `KERN_PROCARGS2` 버퍼에서 argv 뒤의 envp를 읽는다. 같은 이름이 둘 이상 있어도 모두 순서대로 돌려준다(어느 쪽이 이기는지는 프로그램마다 달라 부른 쪽이 모두 본다).
/// 모양이 틀리거나(argv를 다 읽지 못함) 마지막 줄이 NUL로 끝나지 않았으면 `Err`다. 읽다 만 환경을 빈 환경으로 믿지 않는다. argv 뒤에 아무것도 없으면 환경이 빈 것이다
pub fn parse_procargs2_env(buf: &[u8]) -> Result<Vec<(String, String)>, String> {
    let (_, mut at) = split_procargs2(buf)?;
    let mut env = Vec::new();
    while at < buf.len() {
        let start = at;
        while at < buf.len() && buf[at] != 0 {
            at += 1;
        }
        if at >= buf.len() {
            return Err("마지막 환경 변수가 NUL로 끝나지 않았습니다".to_owned());
        }
        // 빈 줄은 envp의 끝이다(그 뒤는 커널이 붙인 apple[] 등이라 환경이 아니다)
        if at == start {
            break;
        }
        if let Some(pair) = split_env_entry(&buf[start..at]) {
            env.push(pair);
        }
        at += 1;
    }
    Ok(env)
}

/// `/proc/<pid>/environ`을 읽는다. NUL로 구분하고 끝의 NUL 하나는 구분자다. 마지막 줄이 NUL로 끝나지 않아도 읽는다(커널이 끝에 NUL을 붙이지 않는 경우가 있다)
pub fn parse_environ(buf: &[u8]) -> Vec<(String, String)> {
    let body = buf.strip_suffix(&[0]).unwrap_or(buf);
    if body.is_empty() {
        return Vec::new();
    }
    body.split(|b| *b == 0).filter_map(split_env_entry).collect()
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

/// 프로세스의 환경(`NAME=값` 쌍, 프로세스가 뜰 때의 것). **같은 계정의 프로세스만** 읽는다: root로 도는 중이면 남의 환경을 읽지 않고 `Err`다.
/// 읽지 못한 모든 경우(권한·지원하지 않는 OS·모양이 틀림·살아 있는데 읽지 못함)는 `Err`이고 빈 환경(`Ok(Some(vec![]))`)으로 돌려주지 않는다 — 부른 쪽은 "모른다"로 읽는다.
/// 이미 끝났다고 확인되면 `Ok(None)`이다
pub fn process_env(pid: i64) -> io::Result<Option<Vec<(String, String)>>> {
    process_env_with(pid, &read_env_checked, &process_exists)
}

pub type EnvRead = io::Result<Option<Vec<(String, String)>>>;

/// 읽기와 존재 확인을 받아 판정한다(시험이 실패를 주입한다). 읽은 환경이 비었으면 오류다(아래). 읽기가 `None`(읽을 것이 없다)이면 프로세스가 **없다고 확인될 때만** `None`이다
pub fn process_env_with(pid: i64, read: &dyn Fn(i64) -> EnvRead, exists: &dyn Fn(i64) -> io::Result<bool>) -> EnvRead {
    match read(pid)? {
        // macOS는 SIP가 지키는 프로그램(/bin/sh 등)의 환경을 빈 칸으로 가려 주고 오류를 내지 않는다. 읽은 환경이 비었으면 가려진 것인지 진짜 빈 것인지 가를 수 없어 "모른다"다
        Some(env) if env.is_empty() => Err(io::Error::other(format!("프로세스 {pid}의 환경이 비어 있습니다(가려졌는지 진짜 비었는지 구별할 수 없습니다)"))),
        Some(env) => Ok(Some(env)),
        None => {
            if exists(pid)? {
                Err(io::Error::other(format!("프로세스 {pid}의 환경을 읽지 못했는데 프로세스는 살아 있습니다")))
            } else {
                Ok(None)
            }
        }
    }
}

#[cfg(unix)]
fn read_env_checked(pid: i64) -> EnvRead {
    // SAFETY: geteuid는 인자가 없고 실패하지 않는다.
    if unsafe { libc::geteuid() } == 0 {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "root로는 다른 프로세스의 환경을 읽지 않습니다(같은 계정의 프로세스만 읽습니다)"));
    }
    read_env(pid)
}

#[cfg(not(unix))]
fn read_env_checked(_pid: i64) -> EnvRead {
    Err(io::Error::new(io::ErrorKind::Unsupported, "이 OS에서는 프로세스의 환경을 읽을 수 없습니다"))
}

#[cfg(target_os = "linux")]
fn read_env(pid: i64) -> EnvRead {
    match std::fs::read(format!("/proc/{pid}/environ")) {
        Ok(buf) => Ok(Some(parse_environ(&buf))),
        Err(error) if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
fn read_env(pid: i64) -> EnvRead {
    match read_procargs2(pid)? {
        None => Ok(None),
        Some(buf) => parse_procargs2_env(&buf).map(Some).map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message)),
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn read_env(_pid: i64) -> EnvRead {
    Err(io::Error::new(io::ErrorKind::Unsupported, "이 OS에서는 프로세스의 환경을 읽을 수 없습니다"))
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
    match read_procargs2(pid)? {
        None => Ok(Read::Missing),
        Some(buf) => parse_procargs2(&buf).map(Read::Argv).map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message)),
    }
}

/// `KERN_PROCARGS2` 버퍼. 읽을 것이 없다고 하면(`ESRCH`·`EINVAL`) `None`
#[cfg(target_os = "macos")]
fn read_procargs2(pid: i64) -> io::Result<Option<Vec<u8>>> {
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
    Ok(Some(buf))
}

#[cfg(target_os = "macos")]
fn missing_or_err() -> io::Result<Option<Vec<u8>>> {
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        // 프로세스가 없거나 읽을 수 없다(EINVAL은 살아 있는 다른 계정의 프로세스에도 난다). 끝났는지는 부른 쪽이 `kill(pid, 0)`로 가린다
        Some(libc::ESRCH) | Some(libc::EINVAL) => Ok(None),
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

    // ── 환경 읽기 ──

    fn procargs_env(argc: i32, argv: &[&str], env: &[&str]) -> Vec<u8> {
        let mut buf = argc.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"/bin/x\0\0\0");
        for arg in argv {
            buf.extend_from_slice(arg.as_bytes());
            buf.push(0);
        }
        for entry in env {
            buf.extend_from_slice(entry.as_bytes());
            buf.push(0);
        }
        buf
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn procargs2_env_reads_envp_after_argv() {
        let buf = procargs_env(2, &["x", "--a"], &["OPENCODE_CONFIG=/g/opencode.json", "A=b=c", "EMPTY="]);
        assert_eq!(parse_procargs2_env(&buf).unwrap(), pairs(&[("OPENCODE_CONFIG", "/g/opencode.json"), ("A", "b=c"), ("EMPTY", "")]));
        // argv의 `NAME=값` 꼴 인자는 환경이 아니다
        let buf = procargs_env(2, &["x", "OPENCODE_CONFIG=/evil"], &["HOME=/h"]);
        assert_eq!(parse_procargs2_env(&buf).unwrap(), pairs(&[("HOME", "/h")]));
        // 같은 이름이 둘이면 둘 다 순서대로 돌려준다
        let buf = procargs_env(1, &["x"], &["K=1", "K=2"]);
        assert_eq!(parse_procargs2_env(&buf).unwrap(), pairs(&[("K", "1"), ("K", "2")]));
        // 빈 줄 뒤(envp의 끝)는 환경이 아니다
        let mut buf = procargs_env(1, &["x"], &["K=1"]);
        buf.extend_from_slice(b"\0/exec/path\0");
        assert_eq!(parse_procargs2_env(&buf).unwrap(), pairs(&[("K", "1")]));
        // `=`가 없거나 이름이 빈 줄은 건너뛴다
        let buf = procargs_env(1, &["x"], &["NOEQ", "=v", "K=1"]);
        assert_eq!(parse_procargs2_env(&buf).unwrap(), pairs(&[("K", "1")]));
        // argv 뒤에 아무것도 없으면 환경이 빈 것이다
        assert_eq!(parse_procargs2_env(&procargs_env(1, &["x"], &[])).unwrap(), Vec::new());
    }

    #[test]
    fn procargs2_env_truncated_or_malformed_is_an_error() {
        // 마지막 환경 변수가 NUL로 끝나지 않았다: 잘렸을 수 있다
        let mut buf = procargs_env(1, &["x"], &["A=1"]);
        buf.extend_from_slice(b"B=2");
        assert!(parse_procargs2_env(&buf).is_err());
        // argv를 다 읽지 못했다
        assert!(parse_procargs2_env(&procargs_env(3, &["x"], &["A=1"])).is_err());
        assert!(parse_procargs2_env(&[1, 0]).is_err());
        assert!(parse_procargs2_env(&(-1i32).to_ne_bytes()).is_err());
    }

    #[test]
    fn environ_splits_on_nul_and_keeps_the_empty_environment_distinct() {
        assert_eq!(parse_environ(b"A=1\0B=x=y\0"), pairs(&[("A", "1"), ("B", "x=y")]));
        assert_eq!(parse_environ(b"A=1\0B=2"), pairs(&[("A", "1"), ("B", "2")]));
        assert_eq!(parse_environ(b"K=1\0K=2\0"), pairs(&[("K", "1"), ("K", "2")]));
        assert_eq!(parse_environ(b""), Vec::new());
        assert_eq!(parse_environ(b"NOEQ\0=v\0A=\0"), pairs(&[("A", "")]));
    }

    #[test]
    fn env_unreadable_is_never_an_empty_environment() {
        let none = |_: i64| Ok(None);
        // 끝났다고 확인될 때만 None
        assert_eq!(process_env_with(7, &none, &|_| Ok(false)).unwrap(), None);
        // 살아 있는데 읽지 못했다·있는지 모른다·읽기 실패: 모두 오류(빈 환경이 아니다)
        assert!(process_env_with(7, &none, &|_| Ok(true)).is_err());
        assert!(process_env_with(7, &none, &|_| Err(io::Error::other("kill 실패"))).is_err());
        assert!(process_env_with(7, &|_| Err(io::Error::other("권한")), &|_| Ok(false)).is_err());
        // 읽었는데 비었다: 가려진 것(macOS의 SIP 프로그램)과 진짜 빈 환경을 가를 수 없어 오류
        assert!(process_env_with(7, &|_| Ok(Some(Vec::new())), &|_| Ok(false)).is_err());
        // 읽었으면 존재 확인은 부르지 않는다
        let read = |_: i64| Ok(Some(pairs(&[("A", "1")])));
        assert_eq!(process_env_with(7, &read, &|_| panic!("부르면 안 된다")).unwrap(), Some(pairs(&[("A", "1")])));
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_environment_of_the_current_process() {
        // 같은 계정의 프로세스(자기 자신)의 환경에서 cargo가 시험을 띄울 때 정한 변수를 읽는다. root로 돌면 읽지 않는 것이 맞다
        let me = i64::from(std::process::id());
        // SAFETY: geteuid는 실패하지 않는다.
        if unsafe { libc::geteuid() } == 0 {
            assert!(process_env(me).is_err());
            return;
        }
        let env = process_env(me).unwrap().expect("자기 자신은 살아 있다");
        let expected = std::env::var("CARGO_PKG_NAME").unwrap();
        assert!(env.iter().any(|(k, v)| k == "CARGO_PKG_NAME" && *v == expected), "{} 개 중에 없다", env.len());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn reads_the_environment_of_a_child_we_started() {
        // /bin/sleep은 macOS에서 SIP가 환경을 가린다. 복사한 실행 파일은 가려지지 않는다
        let dir = std::env::temp_dir().join(format!("bstudio-procenv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("sleepcopy");
        std::fs::copy("/bin/sleep", &exe).unwrap();
        let mut child = std::process::Command::new(&exe).arg("5").env_clear().env("B_STUDIO_PROCENV_TEST", "a b=c").spawn().unwrap();
        let pid = i64::from(child.id());
        // exec 직후에는 아직 부모의 환경일 수 있어 잠깐 기다린다
        let mut found = false;
        for _ in 0..50 {
            if let Ok(Some(env)) = process_env(pid) {
                if env == pairs(&[("B_STUDIO_PROCENV_TEST", "a b=c")]) {
                    found = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        // SAFETY: geteuid는 실패하지 않는다.
        if unsafe { libc::geteuid() } != 0 {
            assert!(found);
        }
        // 거둔 프로세스는 None이다
        assert_eq!(process_env(pid).ok().flatten(), None);
    }
}
