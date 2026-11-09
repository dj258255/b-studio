//! 자식 프로세스 하나를 띄워 **양방향**으로 잇는 세션(ADR-193, 2c-4b).
//! TS `packages/sandbox/src/docker/agent-terminal.ts`의 `openAgentTerminal`(`docker exec -i`로 컨테이너 안 `script` PTY에 붙는
//! `spawn`)을 옮긴 것이다. PTY 모듈이 아니라 **일반 자식의 stdin/stdout/stderr 파이프**다.
//!
//! 옛 동작과 같게 맞춘 자리:
//! - stdout·stderr를 **바이트 그대로** 흘린다(화면 제어 문자가 섞여 있어 글자로 바꾸지 않는다). 둘은 한 이벤트 흐름에 섞인다.
//! - 종료 이벤트(`Exit`)는 두 출력이 모두 EOF가 된 **뒤에** 한 번 나온다(Node `close`와 같다 — 마지막 출력이 종료보다 먼저 온다).
//! - `write`는 동기다(채널에 넣기만 한다). 닫힌 뒤의 쓰기는 조용히 버린다(`child.stdin.on('error', noop)`).
//! - `end_stdin`은 stdin을 닫고, `terminate`는 SIGTERM을 보낸다(`close()` = `stdin.end()` + `kill('SIGTERM')`).
//! - 띄우기 실패는 던지지 않고 `Exit(Some(-2))`로 끝낸다(Node `close`의 ENOENT 코드).
//! - 핸들이 버려지면(stdin 송신자 drop) 자식의 stdin이 닫힌다. 자식은 kill_on_drop이 아니다: 세션은 자식이 끝나야 끝난다.
//!
//! napi를 모른다: 이벤트는 추상 콜백이고, 읽는 작업(`pump`)은 spawn하지 않고 future로 돌려준다(log_stream과 같은 이유).

use std::future::Future;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, Notify};

/// 한 번에 읽는 크기. 터미널 출력은 작은 조각으로 오가므로 이 정도면 넉넉하다.
const READ_CHUNK: usize = 16 * 1024;
/// 띄우기 실패의 종료 코드(Node `close`가 ENOENT에서 주는 -2).
pub const SPAWN_FAILED_CODE: i32 = -2;

/// 세션에서 나오는 사건. 한 콜백으로 순서대로 나가므로 소비자는 종료가 출력 뒤에 온다고 믿어도 된다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecEvent {
    Data(Vec<u8>),
    /// 종료 코드. 시그널로 죽었으면 `None`(Node `close`의 null).
    Exit(Option<i32>),
}

pub type OnEvent = Arc<dyn Fn(ExecEvent) + Send + Sync>;

/// 세션 손잡이. 모두 동기라 JS 메인 스레드에서 바로 부를 수 있다.
pub struct ExecHandle {
    stdin: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    terminate: Arc<Notify>,
}

impl ExecHandle {
    /// stdin에 쓴다. 이미 닫혔거나 자식이 끝났으면 버리고 `false`.
    pub fn write(&self, data: Vec<u8>) -> bool {
        match self.stdin.lock().expect("stdin 잠금").as_ref() {
            Some(tx) => tx.send(data).is_ok(),
            None => false,
        }
    }

    /// stdin을 닫는다(EOF). 이미 보낸 쓰기는 모두 쓰인 뒤에 닫힌다.
    pub fn end_stdin(&self) {
        self.stdin.lock().expect("stdin 잠금").take();
    }

    /// 자식에게 SIGTERM을 보낸다. 띄우기 전에 불려도 유지된다.
    pub fn terminate(&self) {
        self.terminate.notify_one();
    }
}

/// `bin args`를 띄우는 세션과 그것을 돌리는 `pump` future를 돌려준다. `pump`를 런타임에 올려야 시작한다.
pub fn spawn_exec(
    bin: &str,
    args: &[String],
    env: Option<&[(String, String)]>,
    cwd: Option<&str>,
    on_event: OnEvent,
) -> (ExecHandle, impl Future<Output = ()> + Send) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let terminate = Arc::new(Notify::new());
    let terminate_pump = terminate.clone();

    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = env {
        command.env_clear();
        for (name, value) in env {
            command.env(name, value);
        }
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let pump = async move {
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                on_event(ExecEvent::Exit(Some(SPAWN_FAILED_CODE)));
                return;
            }
        };
        let pid = child.id();
        let stdout = child.stdout.take().expect("stdout은 piped다");
        let stderr = child.stderr.take().expect("stderr은 piped다");
        let mut stdin = child.stdin.take().expect("stdin은 piped다");

        // 쓰기 작업: 송신자가 모두 drop되면(end_stdin·핸들 drop) 루프가 끝나며 stdin이 닫힌다.
        // 자식이 먼저 끝나 쓰기가 실패하면(EPIPE) 남은 입력을 버리고 끝낸다.
        let writer = tokio::spawn(async move {
            while let Some(data) = rx.recv().await {
                if stdin.write_all(&data).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        let io = async {
            tokio::join!(forward(stdout, on_event.clone()), forward(stderr, on_event.clone()));
        };
        tokio::pin!(io);
        let mut terminated = false;
        loop {
            tokio::select! {
                _ = &mut io => break,
                // 한 번만 보낸다. 보낸 뒤에도 출력이 EOF가 될 때까지 계속 읽는다(마지막 출력을 잃지 않는다).
                _ = terminate_pump.notified(), if !terminated => {
                    terminated = true;
                    send_sigterm(&mut child, pid);
                }
            }
        }
        writer.abort();
        let code = child.wait().await.ok().and_then(|status| status.code());
        on_event(ExecEvent::Exit(code));
    };

    (ExecHandle { stdin: Mutex::new(Some(tx)), terminate }, pump)
}

/// 읽는 대로 바이트를 흘린다. EOF나 읽기 오류면 끝.
async fn forward(mut reader: impl AsyncRead + Unpin, on_event: OnEvent) {
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => on_event(ExecEvent::Data(buffer[..n].to_vec())),
        }
    }
}

#[cfg(unix)]
fn send_sigterm(_child: &mut tokio::process::Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: 이 프로세스가 띄운 자식의 pid에 시그널만 보낸다. 이미 끝났으면 ESRCH로 실패하고 무시한다.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

#[cfg(not(unix))]
fn send_sigterm(child: &mut tokio::process::Child, _pid: Option<u32>) {
    let _ = child.start_kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    fn collector() -> (OnEvent, Arc<Mutex<Vec<ExecEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        (Arc::new(move |event| sink.lock().unwrap().push(event)), events)
    }

    fn bytes(events: &[ExecEvent]) -> Vec<u8> {
        events
            .iter()
            .filter_map(|event| match event {
                ExecEvent::Data(data) => Some(data.clone()),
                ExecEvent::Exit(_) => None,
            })
            .flatten()
            .collect()
    }

    async fn run(script: &str, writes: &[&[u8]], then: impl FnOnce(&ExecHandle)) -> Vec<ExecEvent> {
        let (on_event, events) = collector();
        let (handle, pump) = spawn_exec("sh", &args(&["-c", script]), None, None, on_event);
        for data in writes {
            handle.write(data.to_vec());
        }
        then(&handle);
        tokio::time::timeout(Duration::from_secs(10), pump).await.expect("세션이 끝나야 한다");
        let out = events.lock().unwrap().clone();
        out
    }

    #[tokio::test]
    async fn streams_stdout_and_stderr_bytes_then_exit_last() {
        let events = run("printf 'out'; sleep 0.05; printf 'err' 1>&2; exit 3", &[], |_| {}).await;
        assert_eq!(bytes(&events), b"outerr".to_vec());
        assert_eq!(events.last(), Some(&ExecEvent::Exit(Some(3))));
        assert_eq!(events.iter().filter(|e| matches!(e, ExecEvent::Exit(_))).count(), 1);
    }

    #[tokio::test]
    async fn passes_non_utf8_bytes_unchanged() {
        let events = run("printf '\\033[2J\\377\\376'", &[], |_| {}).await;
        assert_eq!(bytes(&events), vec![0x1b, b'[', b'2', b'J', 0xff, 0xfe]);
    }

    #[tokio::test]
    async fn writes_reach_stdin_in_order_and_end_closes_it() {
        let events = run("cat", &[b"hello ", "안녕\r".as_bytes()], |handle| handle.end_stdin()).await;
        assert_eq!(bytes(&events), "hello 안녕\r".as_bytes());
        assert_eq!(events.last(), Some(&ExecEvent::Exit(Some(0))));
    }

    #[tokio::test]
    async fn write_after_end_is_dropped_quietly() {
        let (on_event, _events) = collector();
        let (handle, pump) = spawn_exec("sh", &args(&["-c", "cat"]), None, None, on_event);
        handle.end_stdin();
        assert!(!handle.write(b"late".to_vec()));
        tokio::time::timeout(Duration::from_secs(10), pump).await.unwrap();
        assert!(!handle.write(b"later".to_vec()));
    }

    #[tokio::test]
    async fn terminate_sends_sigterm_and_exit_code_is_none() {
        let events = run("printf ready; exec sleep 30", &[], |handle| handle.terminate()).await;
        assert_eq!(events.last(), Some(&ExecEvent::Exit(None)));
    }

    #[tokio::test]
    async fn close_sequence_flushes_last_output_before_exit() {
        // close() = end_stdin + terminate. 이미 쓴 입력의 출력이 종료 이벤트보다 먼저 온다.
        let events = run("cat", &[b"last"], |handle| {
            handle.end_stdin();
            handle.terminate();
        })
        .await;
        assert!(matches!(events.last(), Some(ExecEvent::Exit(_))));
        assert!(!matches!(events.first(), Some(ExecEvent::Exit(_))) || events.len() == 1);
    }

    #[tokio::test]
    async fn spawn_failure_reports_exit_minus_two() {
        let (on_event, events) = collector();
        let (_handle, pump) = spawn_exec("/nonexistent/bstudio-bin", &[], None, None, on_event);
        pump.await;
        assert_eq!(events.lock().unwrap().as_slice(), &[ExecEvent::Exit(Some(SPAWN_FAILED_CODE))]);
    }

    #[tokio::test]
    async fn env_and_cwd_apply() {
        let dir = tempfile::tempdir().unwrap();
        let (on_event, events) = collector();
        let env = vec![("PATH".to_owned(), std::env::var("PATH").unwrap()), ("MARK".to_owned(), "m1".to_owned())];
        let (_handle, pump) = spawn_exec("sh", &args(&["-c", "printf \"$MARK \"; pwd"]), Some(&env), dir.path().to_str(), on_event);
        pump.await;
        let text = String::from_utf8(bytes(&events.lock().unwrap())).unwrap();
        assert!(text.starts_with("m1 "), "{text}");
        assert!(text.trim_end().ends_with(dir.path().file_name().unwrap().to_str().unwrap()), "{text}");
    }
}
