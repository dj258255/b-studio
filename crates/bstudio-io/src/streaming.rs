//! `bin args`를 한 번 실행하되 출력을 **줄 단위로 역류**시키고(`on_line`) 결과도 돌려준다(`run_command_streaming`).
//! TS `packages/sandbox/src/docker/deploy.ts`의 자체 `#docker`(`spawn` + `data` 이벤트)를 옮긴 것이다(ADR-193, 2c-3a).
//!
//! `deploy.ts` `#docker`의 계약을 그대로 맞춘 자리(#1045):
//! - `on_line`은 stdout·stderr 양쪽을 개행으로 나눠, `trim`이 비지 않은 완성된 줄마다 호출한다.
//!   마지막 조각(개행 없이 끝난 부분)은 보류했다가 스트림이 끝날 때 한 번 호출한다(TS는 `lines.pop()` + `close`에서 flush).
//! - 모으는 출력(결과의 stdout·stderr)은 **뒤쪽 200K(UTF-16 코드 단위)**만 유지한다(TS `slice(-OUTPUT_LIMIT)`).
//!   2c-2의 앞쪽 바이트 cap과 반대다 — 빌드 로그는 최근이 중요하다.
//! - 던지지 않는다(2c-2와 같음): 비0·취소·spawn 실패를 결과로 돌려준다. 취소 시 자식을 kill하고 부분 결과를 준다.
//! - `cwd`를 받는다(`tmpdir()`로 부르는 자리가 있다).
//!
//! napi를 모른다: `on_line`은 추상 콜백(`Arc<dyn Fn(String)>`)이고, napi 층이 `ThreadsafeFunction`을 감싼
//! 클로저를 넣는다. 4단계 Rust 서버는 자기 콜백을 넣어 같은 함수를 쓴다.

use std::future::Future;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use bstudio_guard::js::utf16_len;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::stream_exec::ExecOutput;

/// 모으는 출력의 뒤쪽 상한(UTF-16 코드 단위). TS `deploy.ts`의 `OUTPUT_LIMIT = 200_000`과 같다.
const OUTPUT_LIMIT: usize = 200_000;

/// 줄마다 호출되는 콜백. napi 층이 `ThreadsafeFunction`을 감싸 넣는다.
pub type OnLine = Arc<dyn Fn(String) + Send + Sync>;

/// `bin args`를 띄워 `input`을 stdin으로 넣고, 출력을 줄 단위로 `on_line`에 흘리며, 뒤쪽 200K를 모아 돌려준다.
/// `cancel`이 깨면 자식을 kill하고 그때까지 모은 출력을 돌려준다. 절대 던지지 않는다.
pub async fn run_command_streaming(
    bin: &str,
    args: &[String],
    input: Option<&str>,
    env: Option<&[(String, String)]>,
    cwd: Option<&str>,
    on_line: OnLine,
    cancel: impl Future<Output = ()>,
) -> ExecOutput {
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let stderr = if error.kind() == std::io::ErrorKind::NotFound {
                format!("spawn {bin} ENOENT")
            } else {
                format!("spawn {bin} {error}")
            };
            return ExecOutput { exit_code: 1, stdout: String::new(), stderr };
        }
    };

    let stdout = child.stdout.take().expect("stdout은 piped다");
    let stderr = child.stderr.take().expect("stderr은 piped다");
    let stdin = child.stdin.take();

    let out_buf = Arc::new(Mutex::new(String::new()));
    let err_buf = Arc::new(Mutex::new(String::new()));

    let out_reader = tokio::spawn(stream_lines(stdout, out_buf.clone(), on_line.clone()));
    let err_reader = tokio::spawn(stream_lines(stderr, err_buf.clone(), on_line.clone()));

    if let Some(mut stdin) = stdin {
        let input = input.map(|text| text.as_bytes().to_vec());
        tokio::spawn(async move {
            if let Some(input) = input {
                let _ = stdin.write_all(&input).await;
            }
            let _ = stdin.shutdown().await;
        });
    }

    tokio::pin!(cancel);
    let mut aborted = false;
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        _ = &mut cancel => {
            aborted = true;
            let _ = child.start_kill();
            None
        }
    };

    if aborted {
        // 고아가 된 자식 프로세스가 파이프를 쥐면 리더가 EOF를 못 받으므로 task를 중단한다(2c-2와 같은 이유).
        // 중단하면 끝 조각(pending) flush는 못 하지만, 취소 시 호출부가 따로 던져 잔여 로그 한 줄은 중요치 않다.
        out_reader.abort();
        err_reader.abort();
        let _ = out_reader.await;
        let _ = err_reader.await;
        let _ = child.wait().await;
    } else {
        // 정상 종료면 리더가 EOF까지 읽고 끝 조각을 flush한 뒤 끝난다
        let _ = out_reader.await;
        let _ = err_reader.await;
    }

    let exit_code = if aborted {
        1
    } else {
        status.and_then(|status| status.code()).unwrap_or(1)
    };
    let stdout = out_buf.lock().expect("stdout 버퍼 잠금").clone();
    let stderr = err_buf.lock().expect("stderr 버퍼 잠금").clone();
    ExecOutput {
        exit_code,
        stdout,
        stderr,
    }
}

/// 스트림을 끝까지 읽어 (1) 완성된 줄마다 `on_line`을 부르고 (2) 뒤쪽 200K만 `buf`에 모은다.
async fn stream_lines<R: AsyncRead + Unpin>(mut reader: R, buf: Arc<Mutex<String>>, on_line: OnLine) {
    let mut pending = String::new();
    let mut chunk = [0u8; 65536];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let text = String::from_utf8_lossy(&chunk[..read]);

        // 결과용: 뒤쪽 OUTPUT_LIMIT(UTF-16)만 유지한다(TS `(output + text).slice(-OUTPUT_LIMIT)`).
        {
            let mut out = buf.lock().expect("줄 버퍼 잠금");
            out.push_str(&text);
            keep_last_utf16(&mut out, OUTPUT_LIMIT);
        }

        // 줄 단위 역류: 개행으로 나눠 완성된 줄마다(비지 않으면) on_line. 마지막 조각은 보류한다.
        pending.push_str(&text);
        while let Some(idx) = pending.find('\n') {
            let line: String = pending[..idx].to_string();
            pending.drain(..=idx);
            if !line.trim().is_empty() {
                on_line(line);
            }
        }
    }
    // 끝: 개행 없이 남은 조각도 비지 않으면 한 번 흘린다(TS `close`의 flush)
    if !pending.trim().is_empty() {
        on_line(pending);
    }
}

/// `s`의 UTF-16 길이가 `limit`을 넘으면 뒤쪽 `limit` 코드 단위만 남긴다(JS `slice(-limit)`).
/// 문자 경계에서 자른다 — surrogate pair 중간을 가르지 않는다(빌드 로그는 ASCII 위주라 차이가 없다).
fn keep_last_utf16(s: &mut String, limit: usize) {
    let total = utf16_len(s);
    if total <= limit {
        return;
    }
    let skip = total - limit; // 앞에서 버릴 UTF-16 코드 단위 수
    let mut counted = 0;
    let mut cut = s.len();
    for (index, ch) in s.char_indices() {
        if counted >= skip {
            cut = index;
            break;
        }
        counted += ch.len_utf16();
    }
    s.drain(..cut);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::pending;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    fn never() -> impl Future<Output = ()> {
        pending::<()>()
    }

    /// 줄을 모으는 on_line과, 모은 줄을 돌려주는 핸들
    fn collector() -> (OnLine, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let on_line: OnLine = Arc::new(move |line: String| sink.lock().unwrap().push(line));
        (on_line, lines)
    }

    #[tokio::test]
    async fn streams_completed_lines_and_flushes_tail() {
        let (on_line, lines) = collector();
        // 개행으로 끝나지 않는 마지막 조각(tail)도 흘려야 한다
        let result = run_command_streaming(
            "sh",
            &args(&["-c", "printf 'a\\nb\\ntail'"]),
            None,
            None,
            None,
            on_line,
            never(),
        )
        .await;
        assert_eq!(result.exit_code, 0);
        assert_eq!(*lines.lock().unwrap(), vec!["a", "b", "tail"]);
    }

    #[tokio::test]
    async fn skips_blank_lines_and_keeps_stdout() {
        let (on_line, lines) = collector();
        let result = run_command_streaming(
            "sh",
            &args(&["-c", "printf 'x\\n\\n   \\ny\\n'"]),
            None,
            None,
            None,
            on_line,
            never(),
        )
        .await;
        // 빈 줄·공백만인 줄은 on_line을 부르지 않는다. 결과 stdout에는 그대로 남는다.
        assert_eq!(*lines.lock().unwrap(), vec!["x", "y"]);
        assert_eq!(result.stdout, "x\n\n   \ny\n");
    }

    #[tokio::test]
    async fn streams_stderr_too() {
        let (on_line, lines) = collector();
        let result = run_command_streaming(
            "sh",
            &args(&["-c", "printf 'err\\n' 1>&2; exit 2"]),
            None,
            None,
            None,
            on_line,
            never(),
        )
        .await;
        assert_eq!(result.exit_code, 2);
        assert_eq!(*lines.lock().unwrap(), vec!["err"]);
        assert_eq!(result.stderr, "err\n");
    }

    #[tokio::test]
    async fn feeds_stdin_and_runs_in_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "hi").unwrap();
        let (on_line, lines) = collector();
        // cwd에서 돌면 marker.txt가 보인다. stdin도 넣는다(cat).
        let result = run_command_streaming(
            "sh",
            &args(&["-c", "ls; cat"]),
            Some("from-stdin"),
            None,
            Some(dir.path().to_str().unwrap()),
            on_line,
            never(),
        )
        .await;
        assert_eq!(result.exit_code, 0);
        let got = lines.lock().unwrap();
        assert!(got.iter().any(|l| l == "marker.txt"), "cwd의 파일이 보여야 한다: {got:?}");
        assert!(got.iter().any(|l| l == "from-stdin"), "stdin이 cat으로 나와야 한다: {got:?}");
    }

    #[tokio::test]
    async fn cancel_returns_partial_and_exit_one() {
        let (on_line, lines) = collector();
        let cancel = async {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        };
        let result = run_command_streaming(
            "sh",
            &args(&["-c", "printf 'early\\n'; sleep 30"]),
            None,
            None,
            None,
            on_line,
            cancel,
        )
        .await;
        assert_eq!(result.exit_code, 1);
        // 취소 전에 완성된 줄은 흘렀다
        assert_eq!(*lines.lock().unwrap(), vec!["early"]);
    }

    #[test]
    fn keep_last_utf16_trims_front() {
        let mut s = "abcdef".to_string();
        keep_last_utf16(&mut s, 4);
        assert_eq!(s, "cdef");
        let mut short = "ab".to_string();
        keep_last_utf16(&mut short, 4);
        assert_eq!(short, "ab");
    }
}
