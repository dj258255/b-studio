//! `docker compose logs`를 띄워 stdout을 **줄 단위로 당겨** 주는 스트림(ADR-193, 2c-3b).
//! TS `packages/sandbox/src/docker/compose-provider.ts`의 `logs()`(`spawn` + `readline`)를 옮긴 것이다.
//!
//! `logs()`의 계약을 그대로 맞춘 자리(#1047):
//! - stdout만 읽는다. stderr는 버린다(TS `stdio: ['ignore', 'pipe', 'ignore']`).
//! - 줄은 **개행으로 나눈 raw 그대로** 흘린다. `parseLogLine`(시각 분리)·`redact`(가림)·`Date` 변환은 TS가 한다.
//! - `--follow`면 끝없이 흐른다. 그래서 **당기기(pull) 모델**이다: 소비자가 다음 줄을 받을 때까지
//!   bounded 채널이 차서 docker 읽기가 막힌다(공짜 백프레셔). 밀어내기(push)+무한 큐와 달리 메모리가 안 터진다.
//! - 소비자가 그만두거나(채널 drop) `cancel`이 깨거나 EOF면 자식을 kill한다.
//!
//! napi를 모른다: 뒤에서 docker를 읽는 작업(`pump`)을 **spawn하지 않고 future로 돌려준다**.
//! napi 층은 `bindgen_prelude::spawn`(JS 메인 스레드에서 global 런타임에 올림)으로, 4단계 Rust 서버는
//! 자기 `tokio::spawn`으로 같은 future를 올린다.

use std::future::Future;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Notify};

/// 채널 용량. 소비가 멈추면 이만큼 차고 docker 읽기가 막힌다(백프레셔). 로그 한 줄은 작으므로 넉넉히 둔다.
const CHANNEL_CAPACITY: usize = 256;

/// 줄을 당겨 받는 스트림. `next_line().await`가 다음 줄을, 끝이면 `None`을 준다.
pub struct LogStream {
    rx: mpsc::Receiver<String>,
    cancel: Arc<Notify>,
}

impl LogStream {
    /// 다음 줄(개행 제외). 스트림이 끝나면 `None`.
    /// tokio mpsc는 채널이 닫히면 `recv`가 영구 `None`을 주므로, 한 번 끝나면 계속 끝이다.
    pub async fn next_line(&mut self) -> Option<String> {
        self.rx.recv().await
    }

    /// 구독을 끊는 손잡이. 깨우면 `pump`가 자식을 kill하고 끝난다.
    /// AbortSignal을 잇거나(취소) 소비자가 중간에 그만둘 때(JS `break`) 쓴다.
    pub fn cancel_handle(&self) -> Arc<Notify> {
        self.cancel.clone()
    }
}

/// `bin args`를 띄워 stdout을 줄 단위로 흘리는 스트림과, 그걸 돌리는 `pump` future를 돌려준다.
/// `pump`는 호출자가 런타임에 올려야 뒤에서 docker를 읽기 시작한다(이 함수는 아무것도 spawn하지 않는다).
pub fn run_command_log_stream(
    bin: &str,
    args: &[String],
    env: Option<&[(String, String)]>,
    cwd: Option<&str>,
) -> (LogStream, impl Future<Output = ()> + Send) {
    let (tx, rx) = mpsc::channel::<String>(CHANNEL_CAPACITY);
    let cancel = Arc::new(Notify::new());
    let cancel_pump = cancel.clone();

    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
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
            // spawn 실패면 tx를 drop해 채널이 즉시 닫힌다 → 스트림이 빈 로그로 끝난다.
            // logs()는 던지지 않고 "로그 없음"으로 흐르는 쪽이 옛 동작과 맞다(child.on('error') 무시).
            Err(_) => return,
        };
        let stdout = child.stdout.take().expect("stdout은 piped다");
        let mut lines = BufReader::new(stdout).lines();
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        // 수신자가 drop됐으면(소비자 종료) 보낼 곳이 없다 → 끝. 보내면 백프레셔로 막힐 수 있다.
                        if tx.send(line).await.is_err() {
                            break;
                        }
                    }
                    // EOF(Ok(None)) 또는 읽기 오류 → 끝.
                    _ => break,
                },
                _ = cancel_pump.notified() => break,
                // 소비자가 스트림을 버리면(rx drop) docker 입력을 기다리는 동안에도 즉시 끝낸다.
                // 이게 없으면 `next_line()`이 블록된 사이 수신자 drop을 다음 send 전까지 모른다.
                _ = tx.closed() => break,
            }
        }
        // 자식을 kill하고 reap한다(좀비 방지). kill_on_drop도 있지만 명시적으로 기다려 확실히 거둔다.
        let _ = child.start_kill();
        let _ = child.wait().await;
    };

    (LogStream { rx, cancel }, pump)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    /// pump를 런타임에 올리고 끝까지 당겨 모은다.
    async fn drain(mut stream: LogStream, pump: impl Future<Output = ()> + Send + 'static) -> Vec<String> {
        tokio::spawn(pump);
        let mut lines = Vec::new();
        while let Some(line) = stream.next_line().await {
            lines.push(line);
        }
        lines
    }

    #[tokio::test]
    async fn streams_lines_in_order_then_ends() {
        let (stream, pump) = run_command_log_stream("sh", &args(&["-c", "printf 'a\\nb\\nc\\n'"]), None, None);
        let lines = drain(stream, pump).await;
        assert_eq!(lines, vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn drops_stderr() {
        // stderr로 보낸 것은 스트림에 안 나온다(stdout만 읽는다).
        let (stream, pump) =
            run_command_log_stream("sh", &args(&["-c", "printf 'out\\n'; printf 'err\\n' 1>&2"]), None, None);
        let lines = drain(stream, pump).await;
        assert_eq!(lines, vec!["out"]);
    }

    #[tokio::test]
    async fn cancel_stops_stream_and_kills_child() {
        // 한 줄 흘린 뒤 계속 도는 프로세스. cancel하면 스트림이 끝나고 자식이 죽는다.
        let (mut stream, pump) =
            run_command_log_stream("sh", &args(&["-c", "printf 'first\\n'; sleep 30"]), None, None);
        let cancel = stream.cancel_handle();
        tokio::spawn(pump);
        assert_eq!(stream.next_line().await, Some("first".to_string()));
        cancel.notify_one();
        // cancel 뒤에는 더 이상 줄이 없다(채널이 닫힌다).
        let rest = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next_line())
            .await
            .expect("cancel 뒤 스트림이 5초 안에 끝나야 한다");
        assert_eq!(rest, None);
    }

    #[tokio::test]
    async fn consumer_stop_kills_child() {
        // 소비자가 스트림을 drop하면(수신자 drop) pump가 send 실패로 끝나고 자식을 kill한다.
        let (stream, pump) =
            run_command_log_stream("sh", &args(&["-c", "printf 'x\\n'; sleep 30"]), None, None);
        let handle = tokio::spawn(pump);
        // 한 줄만 받고 스트림을 버린다.
        {
            let mut stream = stream;
            assert_eq!(stream.next_line().await, Some("x".to_string()));
        }
        // pump가 5초 안에 끝나야 한다(send 실패 → kill).
        tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("소비자 종료 뒤 pump가 끝나야 한다")
            .expect("pump가 패닉 없이 끝나야 한다");
    }

    #[tokio::test]
    async fn runs_in_cwd_with_env() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "hi").unwrap();
        let (stream, pump) = run_command_log_stream(
            "sh",
            &args(&["-c", "ls; printf '%s\\n' \"$MARKER\""]),
            Some(&[("MARKER".to_string(), "from-env".to_string())]),
            Some(dir.path().to_str().unwrap()),
        );
        let lines = drain(stream, pump).await;
        assert!(lines.iter().any(|l| l == "marker.txt"), "cwd의 파일이 보여야 한다: {lines:?}");
        assert!(lines.iter().any(|l| l == "from-env"), "env가 적용돼야 한다: {lines:?}");
    }

    #[tokio::test]
    async fn spawn_failure_ends_empty() {
        // 없는 바이너리는 던지지 않고 빈 스트림으로 끝난다(옛 child.on('error') 무시와 맞다).
        let (stream, pump) = run_command_log_stream("this-binary-does-not-exist-xyz", &args(&["--help"]), None, None);
        let lines = drain(stream, pump).await;
        assert!(lines.is_empty(), "spawn 실패는 빈 로그여야 한다: {lines:?}");
    }
}
