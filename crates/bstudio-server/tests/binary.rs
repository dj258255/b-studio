//! 실행 파일 시험: 앞단이 Node를 띄우고, 준비를 기다리고, 끝을 맞추는지(ADR-195 결정 1)
mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_bstudio-server");

fn fake_node() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake_node.mjs")
}

struct Front {
    child: Child,
    lines: mpsc::Receiver<String>,
    seen: Vec<String>,
}

fn start(run_dir: &Path, mode: &str, pid_file: &Path, extra: &[&str]) -> Front {
    let mut command = Command::new(BIN);
    command
        .args(["--port", "0", "--hostname", "127.0.0.1", "--run-dir"])
        .arg(run_dir)
        .args(extra)
        .args(["--", "node"])
        .arg(fake_node())
        .env("FAKE_NODE_MODE", mode)
        .env("FAKE_NODE_PID_FILE", pid_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let (tx, lines) = mpsc::channel();
    for pipe in [Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>, Box::new(child.stderr.take().unwrap())] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    Front { child, lines, seen: Vec::new() }
}

impl Front {
    /// 조건에 맞는 줄이 나올 때까지 기다린다
    fn wait_line(&mut self, within: Duration, mut matches: impl FnMut(&str) -> bool) -> Option<String> {
        let deadline = Instant::now() + within;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(left) {
                Ok(line) => {
                    self.seen.push(line.clone());
                    if matches(&line) {
                        return Some(line);
                    }
                }
                Err(_) => return None,
            }
        }
        None
    }

    fn port(&mut self) -> u16 {
        let line = self.wait_line(Duration::from_secs(20), |l| l.starts_with("b-studio 서버가 떴습니다: http://")).unwrap_or_else(|| panic!("준비 줄이 없다: {:?}", self.seen));
        line.rsplit(':').next().unwrap().trim().parse().unwrap()
    }

    fn wait_exit(&mut self, within: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + within;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return Some(status);
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Front {
    fn drop(&mut self) {
        // 자기가 띄운 것만 정리한다
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn http_get(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").unwrap();
    let mut out = String::new();
    let _ = stream.read_to_string(&mut out);
    out
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn node를_띄우고_준비된_뒤에_포트를_열고_종료_신호를_넘긴다() {
    let dir = common::short_dir();
    let run = dir.path().join("run");
    let pid_file = dir.path().join("node.pid");
    let mut front = start(&run, "ok", &pid_file, &[]);
    let port = front.port();

    // 소켓 폴더는 0700, 그 안에 소켓
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    assert_eq!(std::fs::metadata(&run).unwrap().permissions().mode() & 0o777, 0o700);
    let sockets: Vec<_> = std::fs::read_dir(&run).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(sockets.len(), 1, "{sockets:?}");
    assert!(std::fs::symlink_metadata(&sockets[0]).unwrap().file_type().is_socket());

    let response = http_get(port, "/api/health");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("\"app\":\"b-studio\""));

    let node_pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    assert!(alive(node_pid));
    unsafe { libc::kill(front.child.id() as i32, libc::SIGTERM) };
    let status = front.wait_exit(Duration::from_secs(10)).expect("SIGTERM 뒤 앞단이 끝나지 않았다");
    assert!(status.success(), "신호로 닫을 때는 0으로 끝난다: {status:?}");
    std::thread::sleep(Duration::from_millis(200));
    assert!(!alive(node_pid), "Node가 남았다");
    assert!(!sockets[0].exists(), "소켓 파일이 남았다");
}

#[test]
fn node가_바로_끝나면_앞단은_포트를_열지_않고_0이_아닌_코드로_끝난다() {
    let dir = common::short_dir();
    let mut front = start(&dir.path().join("run"), "exit-early", &dir.path().join("node.pid"), &[]);
    let status = front.wait_exit(Duration::from_secs(20)).expect("앞단이 끝나지 않았다");
    assert!(!status.success());
    assert!(front.wait_line(Duration::from_millis(100), |l| l.contains("서버가 떴습니다")).is_none());
}

#[test]
fn 준비된_뒤_node가_끝나면_앞단도_0이_아닌_코드로_끝난다() {
    let dir = common::short_dir();
    let mut front = start(&dir.path().join("run"), "die-after-ready", &dir.path().join("node.pid"), &[]);
    let _ = front.port();
    let status = front.wait_exit(Duration::from_secs(10)).expect("Node가 끝났는데 앞단이 남았다");
    assert_eq!(status.code(), Some(7), "Node의 종료 코드를 그대로 낸다: {status:?}");
}

#[test]
fn 준비가_한도_안에_안_되면_node를_정리하고_0이_아닌_코드로_끝난다() {
    let dir = common::short_dir();
    let pid_file = dir.path().join("node.pid");
    let mut front = start(&dir.path().join("run"), "never-ready", &pid_file, &["--ready-timeout-secs", "1"]);
    let status = front.wait_exit(Duration::from_secs(20)).expect("앞단이 끝나지 않았다");
    assert!(!status.success());
    assert!(front.wait_line(Duration::from_millis(100), |l| l.contains("서버가 떴습니다")).is_none());
    let node_pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!alive(node_pid), "Node가 남았다");
}

/// 규칙(결정 1): 소켓 경로가 OS 상한을 넘으면 Node를 띄우지 않고 이유를 찍고 0이 아닌 코드로 끝난다
#[test]
fn 소켓_경로가_너무_길면_node를_띄우지_않는다() {
    let dir = common::short_dir();
    let pid_file = dir.path().join("node.pid");
    let long = dir.path().join("a".repeat(120)).join("run");
    let mut front = start(&long, "ok", &pid_file, &[]);
    let status = front.wait_exit(Duration::from_secs(10)).expect("앞단이 끝나지 않았다");
    assert!(!status.success());
    assert!(front.wait_line(Duration::from_secs(1), |l| l.contains("너무 깁니다")).is_some() || front.seen.iter().any(|l| l.contains("너무 깁니다")), "{:?}", front.seen);
    assert!(!pid_file.exists(), "Node를 띄웠다");
    assert!(!long.exists(), "긴 경로의 폴더를 만들었다");
}

/// 결정 1: 소켓 폴더가 0700이 아니면 멈춘다(이 컴퓨터의 다른 사용자가 Node에 닿을 수 있다)
#[test]
fn 소켓_폴더가_0700이_아니면_node를_띄우지_않는다() {
    use std::os::unix::fs::PermissionsExt;
    let dir = common::short_dir();
    let run = dir.path().join("run");
    std::fs::create_dir(&run).unwrap();
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755)).unwrap();
    let pid_file = dir.path().join("node.pid");
    let mut front = start(&run, "ok", &pid_file, &[]);
    let status = front.wait_exit(Duration::from_secs(10)).expect("앞단이 끝나지 않았다");
    assert!(!status.success());
    assert!(!pid_file.exists(), "Node를 띄웠다");
    assert_eq!(std::fs::metadata(&run).unwrap().permissions().mode() & 0o777, 0o755, "권한을 몰래 고치지 않는다");
}
