//! 호스트에 가상 터미널(PTY)을 열어 셸/CLI를 띄우고 **양방향**으로 다룬다(ADR-193, 2c-4a).
//! TS `packages/sandbox/src/host-terminal.ts`의 node-pty(`@lydell/node-pty`)를 portable-pty로 대체한다.
//!
//! PTY는 blocking I/O다(reader `read`·`child.wait`가 블록). 그래서 2c의 다른 조각과 달리 tokio가 아니라
//! **`std::thread`로 blocking을 격리**한다: reader 스레드가 출력을 읽어 `on_data`로, wait 스레드가 종료를
//! 기다려 `on_exit`로 역류한다. napi 런타임 컨텍스트에 기대지 않아 4단계 Rust 서버도 그대로 재사용한다.
//!
//! napi를 모른다 — `on_data`·`on_exit`는 추상 콜백이고, napi 층이 `ThreadsafeFunction`을 감싼다(2c-3a와 같은 방식).

use std::io::{Error, ErrorKind, Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// 출력(bytes)마다 불리는 콜백. napi 층이 `ThreadsafeFunction`을 감싼다. bytes는 UTF-8 경계가 조각에서 잘릴 수 있어
/// 터미널(xterm.js)이 재조립한다 — 그래서 문자열이 아니라 raw bytes로 넘긴다(node-pty도 화면에는 bytes가 간다).
pub type OnData = Arc<dyn Fn(Vec<u8>) + Send + Sync>;
/// 자식이 끝나면 종료 코드로 한 번 불리는 콜백.
pub type OnExit = Arc<dyn Fn(i32) + Send + Sync>;

/// 열려 있는 PTY. `write`/`resize`/`kill`은 동기다(portable-pty가 blocking I/O).
pub struct HostPty {
    // MasterPty는 Send지만 Sync가 아니라 resize(&self)를 공유하려면 Mutex로 감싼다.
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
}

impl HostPty {
    /// 자식 pid(감시가 이 아래에서 뜬 CLI를 찾는 데 쓴다). 플랫폼이 못 주면 None.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// PTY에 입력을 쓴다(키 입력·붙여넣기).
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        let mut writer = self.writer.lock().expect("writer 잠금");
        writer.write_all(data)?;
        writer.flush()
    }

    /// 터미널 크기를 바꾼다 — 커널이 자식에게 SIGWINCH를 보내 다시 그리게 한다.
    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        let master = self.master.lock().expect("master 잠금");
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| Error::other(error.to_string()))
    }

    /// 자식을 죽인다(node-pty의 `kill('SIGHUP')`에 대응 — 셸과 그 안의 CLI가 함께 끝난다).
    pub fn kill(&self) -> std::io::Result<()> {
        self.killer.lock().expect("killer 잠금").kill()
    }
}

/// PTY를 열어 `file args`를 띄우고, 출력·종료를 `std::thread`로 역류시킨다.
/// `name`은 `TERM`(예: `xterm-256color`). `env`는 상속 없이 통째로 치환한다(node-pty의 `env`와 같다).
pub fn open_host_pty(
    file: &str,
    args: &[String],
    name: &str,
    cols: u16,
    rows: u16,
    cwd: &str,
    env: &[(String, String)],
    on_data: OnData,
    on_exit: OnExit,
) -> std::io::Result<HostPty> {
    // cwd가 실제 디렉터리가 아니면 거절한다(fail-closed). portable-pty도 node-pty도(둘 다 실측) 없는 cwd를 조용히 무시하고
    // 부모 프로세스의 디렉터리에서 자식을 띄우는데, 그러면 "세션의 작업 복사본에서 연다"는 계약이 깨진다.
    // metadata는 링크를 따라가므로(stat) cwd가 링크면 그 대상이 디렉터리인지 본다.
    if !std::fs::metadata(cwd).map(|meta| meta.is_dir()).unwrap_or(false) {
        return Err(Error::new(ErrorKind::NotFound, format!("작업 폴더가 없거나 폴더가 아닙니다: {cwd}")));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|error| Error::other(error.to_string()))?;

    let mut cmd = CommandBuilder::new(file);
    cmd.args(args);
    cmd.env_clear();
    // node-pty는 `name`을 TERM으로 넘긴다. env에 TERM이 또 있으면 그쪽이 이긴다(뒤에 넣으므로).
    cmd.env("TERM", name);
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.cwd(cwd);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|error| Error::other(error.to_string()))?;
    // wait 스레드로 child를 넘기기 전에 pid와 killer를 꺼낸다(killer는 wait가 블록 중이어도 독립적으로 죽인다).
    let pid = child.process_id();
    let killer = child.clone_killer();

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| Error::other(error.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| Error::other(error.to_string()))?;

    // slave를 drop해야 자식이 죽을 때 master reader가 EOF를 받는다(slave fd가 남으면 reader가 영영 안 닫힌다).
    drop(pair.slave);

    // 출력 읽기 스레드(blocking read). EOF(0)나 오류면 끝난다.
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => on_data(buf[..n].to_vec()),
                Err(_) => break,
            }
        }
    });

    // 종료 기다리기 스레드(blocking wait). 종료 코드를 on_exit로 한 번 보낸다.
    std::thread::spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => 1,
        };
        on_exit(code);
    });

    Ok(HostPty {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        pid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    /// node-pty처럼 env를 통째로 치환하므로 PATH를 넣어 줘야 실행 파일을 찾는다(host-terminal도 PATH를 넘긴다).
    fn env_with_path(extra: &[(&str, &str)]) -> Vec<(String, String)> {
        let mut pairs = vec![("PATH".to_string(), "/usr/bin:/bin:/usr/local/bin".to_string())];
        for (key, value) in extra {
            pairs.push(((*key).to_string(), (*value).to_string()));
        }
        pairs
    }

    /// 출력을 모으는 on_data와 종료를 알리는 on_exit, 그리고 종료를 기다리는 수신기를 만든다.
    fn sinks() -> (OnData, OnExit, Arc<Mutex<Vec<u8>>>, mpsc::Receiver<i32>) {
        let data = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = data.clone();
        let on_data: OnData = Arc::new(move |bytes| sink.lock().unwrap().extend(bytes));
        let (tx, rx) = mpsc::channel::<i32>();
        let on_exit: OnExit = Arc::new(move |code| {
            let _ = tx.send(code);
        });
        (on_data, on_exit, data, rx)
    }

    #[test]
    fn streams_output_and_reports_exit_code() {
        let (on_data, on_exit, data, rx) = sinks();
        let pty = open_host_pty(
            "sh",
            &args(&["-c", "echo hi; exit 7"]),
            "xterm-256color",
            24,
            80,
            "/",
            &env_with_path(&[]),
            on_data,
            on_exit,
        )
        .unwrap();
        assert!(pty.pid().is_some(), "pid가 있어야 한다");
        let code = rx.recv_timeout(Duration::from_secs(5)).expect("5초 안에 종료해야 한다");
        assert_eq!(code, 7);
        let text = String::from_utf8_lossy(&data.lock().unwrap()).to_string();
        assert!(text.contains("hi"), "출력에 echo한 hi가 있어야 한다: {text:?}");
    }

    #[test]
    fn write_is_echoed_back() {
        // cat은 입력을 되돌려 준다. PTY는 입력도 echo하므로 쓴 줄이 출력에 나온다.
        let (on_data, on_exit, data, rx) = sinks();
        let pty = open_host_pty("cat", &[], "xterm-256color", 24, 80, "/", &env_with_path(&[]), on_data, on_exit).unwrap();
        pty.write(b"hello\n").unwrap();
        // cat에 EOF(^D)를 보내 끝낸다.
        pty.write(&[4]).unwrap();
        rx.recv_timeout(Duration::from_secs(5)).expect("cat이 끝나야 한다");
        let text = String::from_utf8_lossy(&data.lock().unwrap()).to_string();
        assert!(text.contains("hello"), "쓴 입력이 출력에 보여야 한다: {text:?}");
    }

    #[test]
    fn runs_in_cwd_with_env() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "x").unwrap();
        let (on_data, on_exit, data, rx) = sinks();
        let pty = open_host_pty(
            "sh",
            &args(&["-c", "ls; printf '%s\\n' \"$MARKER\""]),
            "xterm-256color",
            24,
            80,
            dir.path().to_str().unwrap(),
            &env_with_path(&[("MARKER", "from-env")]),
            on_data,
            on_exit,
        )
        .unwrap();
        rx.recv_timeout(Duration::from_secs(5)).expect("끝나야 한다");
        let text = String::from_utf8_lossy(&data.lock().unwrap()).to_string();
        assert!(text.contains("marker.txt"), "cwd의 파일이 보여야 한다: {text:?}");
        assert!(text.contains("from-env"), "env가 적용돼야 한다: {text:?}");
        let _ = pty;
    }

    #[test]
    fn resize_does_not_error() {
        let (on_data, on_exit, _data, rx) = sinks();
        // 잠깐 도는 셸. resize는 에러 없이 되어야 한다(크기 전달은 stty로 따로 본다 — 여기선 호출만).
        let pty = open_host_pty("sh", &args(&["-c", "sleep 0.3"]), "xterm-256color", 24, 80, "/", &env_with_path(&[]), on_data, on_exit).unwrap();
        pty.resize(100, 40).expect("resize가 되어야 한다");
        rx.recv_timeout(Duration::from_secs(5)).expect("끝나야 한다");
    }

    #[test]
    fn kill_ends_the_child() {
        let (on_data, on_exit, _data, rx) = sinks();
        // 오래 도는 셸을 kill하면 on_exit가 온다.
        let pty = open_host_pty("sh", &args(&["-c", "sleep 30"]), "xterm-256color", 24, 80, "/", &env_with_path(&[]), on_data, on_exit).unwrap();
        pty.kill().expect("kill이 되어야 한다");
        rx.recv_timeout(Duration::from_secs(5)).expect("kill 뒤 종료해야 한다");
    }

    #[test]
    fn missing_cwd_is_rejected() {
        // 없는 cwd면 생성이 실패해야 한다(fail-closed). portable-pty는 조용히 부모 디렉터리에서 띄우므로 사전에 막는다.
        let (on_data, on_exit, _data, _rx) = sinks();
        let result = open_host_pty(
            "sh",
            &args(&["-c", "echo hi"]),
            "xterm-256color",
            24,
            80,
            "/no/such/directory/xyz-does-not-exist",
            &env_with_path(&[]),
            on_data,
            on_exit,
        );
        assert!(result.is_err(), "없는 cwd는 거절해야 한다");
    }
}
