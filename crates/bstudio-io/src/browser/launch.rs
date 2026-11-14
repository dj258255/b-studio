//! Chromium을 `--remote-debugging-pipe`로 띄운다(ADR-199). unix만 구현한다(fd 3·4). 그 밖의 OS는 부르는 쪽이 `unavailable`로 처리한다.
//!
//! 실행 인자는 Playwright 1.63이 쓰는 것과 같다(`lib/coreBundle.js`의 `chromiumSwitches`와 실측 로그의 첫 줄). 같은 브라우저 설정이어야
//! 같은 화면이 나온다.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// Playwright 1.63(headless shell)이 넘기는 인자(`--user-data-dir`·`--remote-debugging-pipe`·`--no-startup-window` 제외). 시스템 Google Chrome도 같은 인자로 돈다
pub const BASE_ARGS: &[&str] = &[
    "--disable-field-trial-config",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-back-forward-cache",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-edgeupdater",
    "--disable-extensions",
    "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion",
    "--enable-features=CDPScreenshotNewSurface",
    "--allow-pre-commit-input",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-updater-scheduler",
    "--force-color-profile=srgb",
    "--metrics-recording-only",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-service-autorun",
    "--export-tagged-pdf",
    "--disable-search-engine-choice-screen",
    "--unsafely-disable-devtools-self-xss-warnings",
    "--edge-skip-compat-layer-relaunch",
    "--disable-infobars",
    "--disable-search-engine-choice-screen",
    "--disable-sync",
    "--enable-unsafe-swiftshader",
    "--headless",
    "--hide-scrollbars",
    "--mute-audio",
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    "--no-sandbox",
];

/// 이 러너가 만든 임시 프로필 폴더. 지우기 전에 이 러너가 만든 폴더인지(임시 폴더 바로 아래, 이름 접두, 링크가 아닌 폴더) 확인한다
pub struct ProfileDir {
    path: PathBuf,
}

const PROFILE_PREFIX: &str = "b-studio-cdp-";
static COUNTER: AtomicU64 = AtomicU64::new(0);

impl ProfileDir {
    pub fn create() -> io::Result<Self> {
        let base = std::env::temp_dir();
        for _ in 0..32 {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.subsec_nanos()).unwrap_or(0);
            let name = format!("{PROFILE_PREFIX}{}-{nanos:08x}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst));
            let path = base.join(name);
            // 이미 있으면(다른 것이 같은 이름을 만들었으면) 쓰지 않고 다른 이름으로 다시 만든다
            match create_private_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(io::ErrorKind::AlreadyExists, "임시 프로필 폴더 이름을 정하지 못했습니다"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 지운다. 이 러너가 만든 임시 폴더가 아니면(링크로 바뀌었거나 위치·이름이 다르면) 지우지 않고 이유를 돌려준다. 여러 번 불려도 같은 결과다
    pub fn remove(&self) -> Result<(), String> {
        let expected_parent = std::env::temp_dir();
        let name_ok = self.path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(PROFILE_PREFIX));
        if self.path.parent() != Some(expected_parent.as_path()) || !name_ok {
            return Err(format!("임시 프로필 폴더가 아닙니다: {}", self.path.display()));
        }
        match std::fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
            Ok(metadata) if !metadata.file_type().is_dir() => return Err(format!("폴더가 아니라 지우지 않았습니다: {}", self.path.display())),
            Ok(_) => {}
        }
        // 브라우저가 막 끝나는 중이면 파일이 더 생길 수 있어 몇 번 다시 한다
        let mut last = String::new();
        for _ in 0..5 {
            match std::fs::remove_dir_all(&self.path) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => last = error.to_string(),
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(last)
    }
}

impl Drop for ProfileDir {
    /// 취소로 작업이 버려져도 이 러너가 만든 폴더는 남지 않게 한다. 명시적으로 지운 뒤에는 없는 폴더라 아무 일도 하지 않는다
    fn drop(&mut self) {
        let _ = self.remove();
    }
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir(path)
}

/// 띄운 브라우저. 버려지면(취소 포함) 프로세스 그룹째 죽인다
pub struct BrowserProcess {
    child: Child,
    pid: Option<u32>,
    reaped: bool,
    /// 브라우저가 stderr에 남긴 마지막 글(띄우지 못했을 때 이유를 알리는 데 쓴다)
    pub stderr_tail: Arc<Mutex<String>>,
}

#[cfg(unix)]
pub struct Pipes {
    /// 브라우저로 보내는 쪽(브라우저의 fd 3)
    pub to_browser: tokio::net::unix::pipe::Sender,
    /// 브라우저가 보내는 쪽(브라우저의 fd 4)
    pub from_browser: tokio::net::unix::pipe::Receiver,
}

#[cfg(unix)]
mod unix_impl {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    /// 파이프 한 쌍. 부모에 남는 끝도 자식 끝도 CLOEXEC이고, 번호는 10 이상이다(자식에서 3·4로 옮길 때 서로 덮지 않게)
    fn pipe_pair() -> io::Result<(OwnedFd, OwnedFd)> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: fds는 길이 2의 배열이다
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: pipe가 방금 연 fd를 우리가 소유한다
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        Ok((high_cloexec(&read)?, high_cloexec(&write)?))
    }

    fn high_cloexec(fd: &OwnedFd) -> io::Result<OwnedFd> {
        // SAFETY: 유효한 fd를 복제한다. 복제본은 CLOEXEC이고 번호가 10 이상이다
        let duplicated = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
        if duplicated < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: 방금 만든 fd를 우리가 소유한다
        Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
    }

    pub fn spawn(executable: &Path, extra_args: &[String], profile: &Path) -> io::Result<(BrowserProcess, Pipes)> {
        // 브라우저가 읽는 파이프(부모→자식)와 쓰는 파이프(자식→부모)
        let (child_reads, parent_writes) = pipe_pair()?;
        let (parent_reads, child_writes) = pipe_pair()?;
        let mut command = Command::new(executable);
        command
            .args(BASE_ARGS)
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("--remote-debugging-pipe")
            .arg("--no-startup-window")
            .args(extra_args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            // 브라우저와 그 자식(렌더러·GPU)을 한 프로세스 그룹으로 묶어 함께 정리한다. 이 그룹은 우리가 만든 것이다
            .process_group(0);
        let (read_fd, write_fd) = (child_reads.as_raw_fd(), child_writes.as_raw_fd());
        // SAFETY: pre_exec은 fork 뒤 exec 전의 자식에서 async-signal-safe한 호출(dup2)만 한다. 두 fd는 10 이상이라 3·4와 겹치지 않는다
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(read_fd, 3) < 0 || libc::dup2(write_fd, 4) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        // 부모에 남은 자식 쪽 끝을 닫아야 브라우저가 죽을 때 읽기 쪽이 끝(EOF)을 본다
        drop(child_reads);
        drop(child_writes);
        let pid = child.id();
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(mut stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut chunk = [0u8; 4096];
                while let Ok(read) = stderr.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    let mut tail = tail.lock().unwrap();
                    tail.push_str(&String::from_utf8_lossy(&chunk[..read]));
                    // 끝 4KB만 남긴다
                    if tail.len() > 4096 {
                        let mut cut = tail.len() - 4096;
                        while !tail.is_char_boundary(cut) {
                            cut += 1;
                        }
                        tail.drain(..cut);
                    }
                }
            });
        }
        let pipes = Pipes {
            to_browser: tokio::net::unix::pipe::Sender::from_owned_fd(parent_writes)?,
            from_browser: tokio::net::unix::pipe::Receiver::from_owned_fd(parent_reads)?,
        };
        Ok((BrowserProcess { child, pid, reaped: false, stderr_tail }, pipes))
    }

    pub fn kill_group(pid: u32) {
        // SAFETY: 우리가 process_group(0)으로 만든 그룹이다. 아직 거두지(wait) 않은 자식의 pid라 다른 그룹과 겹치지 않는다
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
pub use unix_impl::spawn;

impl BrowserProcess {
    /// 브라우저가 스스로 끝나길 기다린다(`Browser.close` 뒤). 시간이 지나면 프로세스 그룹째 죽인다. 거둔 뒤에는 다시 죽이지 않는다
    pub async fn wait_or_kill(&mut self, grace: Duration) {
        if self.reaped {
            return;
        }
        if tokio::time::timeout(grace, self.child.wait()).await.is_err() {
            #[cfg(unix)]
            if let Some(pid) = self.pid {
                unix_impl::kill_group(pid);
            }
            let _ = self.child.start_kill();
            let _ = self.child.wait().await;
        }
        self.reaped = true;
    }

    /// 거두지 않았다면 그룹째 즉시 죽인다(취소·오류 경로)
    pub async fn kill_now(&mut self) {
        if self.reaped {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unix_impl::kill_group(pid);
        }
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        self.reaped = true;
    }

    /// 이미 끝났는가(거두지는 않는다)
    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        // 취소로 작업이 버려진 경우. 아직 거두지 않았으니 그룹이 우리 것이다
        #[cfg(unix)]
        if let (Some(pid), Ok(None)) = (self.pid, self.child.try_wait()) {
            unix_impl::kill_group(pid);
        }
        let _ = self.child.start_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_dir_is_private_unique_and_removed_only_when_ours() {
        let first = ProfileDir::create().unwrap();
        let second = ProfileDir::create().unwrap();
        assert_ne!(first.path(), second.path());
        assert!(first.path().is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(first.path()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::write(first.path().join("Default"), b"x").unwrap();
        first.remove().unwrap();
        assert!(!first.path().exists());
        // 여러 번 불려도 같다
        first.remove().unwrap();
        second.remove().unwrap();
    }

    #[test]
    fn profile_dir_refuses_to_remove_a_swapped_in_link_or_file() {
        let ours = ProfileDir::create().unwrap();
        let target = ProfileDir::create().unwrap();
        std::fs::write(target.path().join("keep.txt"), b"keep").unwrap();
        // 폴더를 지우고 같은 이름의 링크로 바꿔 놓았다고 하자
        std::fs::remove_dir_all(ours.path()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target.path(), ours.path()).unwrap();
            assert!(ours.remove().is_err());
            assert!(target.path().join("keep.txt").exists(), "링크 너머의 폴더는 지워지면 안 된다");
            std::fs::remove_file(ours.path()).unwrap();
        }
        std::fs::write(ours.path(), b"file").unwrap();
        assert!(ours.remove().is_err());
        assert!(ours.path().exists());
        std::fs::remove_file(ours.path()).unwrap();
        target.remove().unwrap();
    }

    #[test]
    fn profile_dir_refuses_a_path_that_is_not_a_direct_child_of_temp() {
        let fake = ProfileDir { path: std::env::temp_dir().join("elsewhere").join("b-studio-cdp-x") };
        assert!(fake.remove().is_err());
        let wrong_name = ProfileDir { path: std::env::temp_dir().join("other-name") };
        assert!(wrong_name.remove().is_err());
    }
}
