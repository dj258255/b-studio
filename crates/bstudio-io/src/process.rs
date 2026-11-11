//! `bin args`를 한 번 실행하고 stdout·stderr를 문자열로 모은다(`run_command`).
//! TS `packages/sandbox/src/docker/compose-provider.ts`의 `#docker`(`child_process.execFile`)를 옮긴 것이다(ADR-193, 2c-2).
//!
//! `#docker`의 계약을 그대로 맞춘 자리(실측으로 확정, #1043):
//! - **던지지 않는다.** 비0 종료·취소·spawn 실패·maxBuffer 초과 모두 결과로 돌려준다
//!   (`execFileAsync`는 이들에서 거절하지만 `#docker`의 catch가 `isExecFailure`를 보고 결과로 바꾼다).
//! - 종료 코드: 정상/비0은 그 코드, 취소·spawn 실패·maxBuffer는 1(Node의 `code`가 문자열이라 `typeof === 'number' ? code : 1`).
//! - stdout·stderr는 양쪽을 **동시에** 읽어 모은다(한쪽만 읽으면 파이프가 막혀 자식이 멈춘다).
//! - 각 스트림 256MB 상한(Node `maxBuffer`). 넘기면 자식을 kill하고 그때까지의(잘린) 출력을 돌려준다.
//! - 취소: 작업 future를 떨어뜨리지 않고 자식을 kill한 뒤 그때까지 모은 부분 출력을 돌려준다.
//!   이래야 `stats()`의 timeout-cutoff가 유지된다(취소를 `signal.aborted`로 판단하고 `exitCode !== 0`만 본다).
//! - `env`를 주면 상속 없이 통째로 바꾼다(Node `execFile`의 `env` 옵션이 환경을 치환한다).
//!
//! 2c-1의 `stream_exec`와 다른 점: 거기는 취소 시 future를 떨어뜨려 거절하지만, 여기는 취소를
//! 내부에서 받아 부분 결과를 돌려준다. 그래서 취소 future를 인자로 받는다.

use std::future::Future;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::stream_exec::ExecOutput;

/// 각 스트림을 모으는 상한(바이트). TS `#docker`의 `maxBuffer: 256 * 1024 * 1024`와 같다.
const MAX_BUFFER: usize = 256 * 1024 * 1024;

/// `bin args`를 띄워 `input`을 stdin으로 넣고 stdout·stderr를 모은다.
/// `cancel`이 깨면 자식을 kill하고 그때까지의 출력을 돌려준다. 절대 던지지 않는다.
pub async fn run_command(
    bin: &str,
    args: &[String],
    input: Option<&str>,
    env: Option<&[(String, String)]>,
    cwd: Option<&str>,
    cancel: impl Future<Output = ()>,
) -> ExecOutput {
    run_command_capped(bin, args, input, env, cwd, cancel, MAX_BUFFER).await
}

/// `run_command`와 같되 스트림마다 `limit` 바이트에 닿으면 그 자리에서 자식을 kill한다(256MB보다 크게는 받지 않는다).
/// 상한을 다 읽은 뒤에 재지 않고 읽는 중에 멈춘다(2c-7 검토). 상한을 넘었는지는 호출자가 출력 길이로 판단한다
pub async fn run_command_with_limit(
    bin: &str,
    args: &[String],
    input: Option<&str>,
    env: Option<&[(String, String)]>,
    cwd: Option<&str>,
    cancel: impl Future<Output = ()>,
    limit: usize,
) -> ExecOutput {
    run_command_capped(bin, args, input, env, cwd, cancel, limit.min(MAX_BUFFER)).await
}

/// 상한만 바꿔 부른다. 테스트가 256MB를 내지 않고 상한-넘김 kill 경로를 보기 위한 자리.
async fn run_command_capped(
    bin: &str,
    args: &[String],
    input: Option<&str>,
    env: Option<&[(String, String)]>,
    cwd: Option<&str>,
    cancel: impl Future<Output = ()>,
    limit: usize,
) -> ExecOutput {
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    set_env(&mut command, env);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return spawn_failure(bin, &error),
    };

    let stdout = child.stdout.take().expect("stdout은 piped다");
    let stderr = child.stderr.take().expect("stderr은 piped다");
    let stdin = child.stdin.take();

    let out_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let err_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    // 어느 스트림이든 상한을 넘기면 이 Notify로 메인을 깨워 자식을 kill한다
    let overflow = Arc::new(Notify::new());

    let out_reader = tokio::spawn(read_into(stdout, out_buf.clone(), overflow.clone(), limit));
    let err_reader = tokio::spawn(read_into(stderr, err_buf.clone(), overflow.clone(), limit));

    // stdin은 따로 쓴다. 쓰기가 막혀도 메인의 select가 멈추지 않게 한다.
    // input이 없어도 stdin을 닫아 자식이 EOF를 보게 한다(Node는 `stdin?.end(input)`로 늘 닫는다).
    if let Some(mut stdin) = stdin {
        let input = input.map(|text| text.as_bytes().to_vec());
        tokio::spawn(async move {
            if let Some(input) = input {
                let _ = stdin.write_all(&input).await;
            }
            let _ = stdin.shutdown().await;
        });
    }

    let overflow_wait = overflow.notified();
    tokio::pin!(cancel, overflow_wait);

    let mut aborted = false;
    let mut overflowed = false;
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        _ = &mut cancel => {
            aborted = true;
            let _ = child.start_kill();
            None
        }
        _ = &mut overflow_wait => {
            overflowed = true;
            let _ = child.start_kill();
            None
        }
    };

    if aborted || overflowed {
        // kill한 자식(sh)이 죽어도 그 자식 프로세스(예: sleep)가 고아로 남아 stdout 파이프를 쥐고 있으면
        // 리더의 read가 EOF를 못 받아 영영 막힌다. 그래서 리더를 await하지 않고 task를 강제 중단한다.
        // 버퍼는 Arc<Mutex> 공유라 중단해도 그때까지 모은 출력은 남는다. 이어서 자식을 거둬 좀비를 막는다.
        out_reader.abort();
        err_reader.abort();
        let _ = out_reader.await;
        let _ = err_reader.await;
        let _ = child.wait().await;
    } else {
        // 정상 종료면 리더가 EOF로 자연히 끝난다
        let _ = out_reader.await;
        let _ = err_reader.await;
    }

    let exit_code = if aborted || overflowed {
        1
    } else {
        status.and_then(|status| status.code()).unwrap_or(1)
    };
    let stdout = decode(&out_buf.lock().expect("stdout 버퍼 잠금"));
    let mut stderr = decode(&err_buf.lock().expect("stderr 버퍼 잠금"));

    // stderr가 비면 Node는 error.message를 넣는다. 소비자(isDockerUnreachable)는 이 문자열에 걸리지 않지만,
    // 비어 던지는 경우의 메시지를 비우지 않도록 같은 문구를 채운다.
    if stderr.is_empty() {
        if overflowed {
            stderr = "stdout maxBuffer length exceeded".to_owned();
        } else if aborted {
            stderr = "The operation was aborted".to_owned();
        }
    }

    ExecOutput {
        exit_code,
        stdout,
        stderr,
    }
}

/// 스트림을 끝까지 읽어 공유 버퍼에 쌓는다. 256MB를 넘기면 거기서 잘라 담고 overflow를 한 번 알린다.
/// 넘겨도 계속 읽어(버려) 파이프가 막히지 않게 한다. kill되면 EOF로 끝난다.
pub(crate) async fn read_into<R: AsyncRead + Unpin>(
    mut reader: R,
    buf: Arc<Mutex<Vec<u8>>>,
    overflow: Arc<Notify>,
    limit: usize,
) {
    let mut chunk = [0u8; 65536];
    let mut signaled = false;
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let mut buffer = buf.lock().expect("읽기 버퍼 잠금");
        if buffer.len() >= limit {
            continue; // 이미 상한, 버린다
        }
        if buffer.len() + read > limit {
            let room = limit - buffer.len();
            buffer.extend_from_slice(&chunk[..room]);
            drop(buffer);
            if !signaled {
                overflow.notify_one();
                signaled = true;
            }
        } else {
            buffer.extend_from_slice(&chunk[..read]);
        }
    }
}

pub(crate) fn set_env(command: &mut Command, env: Option<&[(String, String)]>) {
    if let Some(env) = env {
        command.env_clear();
        for (name, value) in env {
            command.env(name, value);
        }
    }
}

/// spawn 자체가 실패했을 때(없는 바이너리 등) `#docker`가 돌려주는 모양.
fn spawn_failure(bin: &str, error: &std::io::Error) -> ExecOutput {
    let stderr = if error.kind() == std::io::ErrorKind::NotFound {
        format!("spawn {bin} ENOENT")
    } else {
        format!("spawn {bin} {error}")
    };
    ExecOutput {
        exit_code: 1,
        stdout: String::new(),
        stderr,
    }
}

fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::pending;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    /// 취소를 걸지 않을 때 쓰는, 영영 끝나지 않는 future
    fn never() -> impl Future<Output = ()> {
        pending::<()>()
    }

    #[tokio::test]
    async fn captures_stdout_and_stderr() {
        let result = run_command(
            "sh",
            &args(&["-c", "printf out; printf err 1>&2; exit 0"]),
            None,
            None,
            None,
            never(),
        )
        .await;
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "out");
        assert_eq!(result.stderr, "err");
    }

    #[tokio::test]
    async fn keeps_nonzero_exit_without_throwing() {
        let result = run_command(
            "sh",
            &args(&["-c", "printf oops 1>&2; exit 7"]),
            None,
            None,
            None,
            never(),
        )
        .await;
        assert_eq!(result.exit_code, 7);
        assert_eq!(result.stdout, "");
        assert_eq!(result.stderr, "oops");
    }

    #[tokio::test]
    async fn feeds_stdin() {
        let result = run_command("tr", &args(&["a-z", "A-Z"]), Some("abcABC\n"), None, None, never()).await;
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "ABCABC\n");
    }

    #[tokio::test]
    async fn closes_stdin_when_no_input() {
        // cat은 stdin EOF를 보면 끝난다. input이 없어도 stdin을 닫아야 멈추지 않는다.
        let result = run_command("cat", &args(&[]), None, None, None, never()).await;
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "");
    }

    #[tokio::test]
    async fn env_replaces_inherited() {
        std::env::set_var("BSTUDIO_PROC_PARENT", "should-not-leak");
        let env = vec![("BSTUDIO_PROC_CHILD".to_owned(), "set".to_owned())];
        let result = run_command(
            "sh",
            &args(&[
                "-c",
                "printf '%s:%s' \"${BSTUDIO_PROC_PARENT:-none}\" \"${BSTUDIO_PROC_CHILD:-none}\"",
            ]),
            None,
            Some(&env),
            None,
            never(),
        )
        .await;
        assert_eq!(result.stdout, "none:set");
    }

    #[tokio::test]
    async fn spawn_failure_returns_result_not_error() {
        let result = run_command(
            "definitely-not-a-real-binary-xyz",
            &args(&[]),
            None,
            None,
            None,
            never(),
        )
        .await;
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.stdout, "");
        assert!(result.stderr.contains("ENOENT"));
    }

    #[tokio::test]
    async fn cancel_returns_partial_output_and_exit_one() {
        // 출력을 조금 내고 오래 자는 명령을 중간에 취소한다
        let cancel = async {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        };
        let result = run_command(
            "sh",
            &args(&["-c", "printf early; sleep 30"]),
            None,
            None,
            None,
            cancel,
        )
        .await;
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.stdout, "early");
    }

    #[tokio::test]
    async fn cancel_before_output_fills_aborted_message() {
        let cancel = async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        let result = run_command("sh", &args(&["-c", "sleep 30"]), None, None, None, cancel).await;
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.stdout, "");
        assert_eq!(result.stderr, "The operation was aborted");
    }

    #[tokio::test]
    async fn runs_in_given_cwd() {
        let dir = std::env::temp_dir().join("bstudio-process-cwd-test");
        std::fs::create_dir_all(&dir).unwrap();
        let real = std::fs::canonicalize(&dir).unwrap();
        let result = run_command("pwd", &args(&["-P"]), None, None, dir.to_str(), never()).await;
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout.trim(), real.to_str().unwrap());
        let missing = run_command("pwd", &args(&[]), None, None, Some("/definitely/not/here"), never()).await;
        assert_eq!(missing.exit_code, 1);
        assert!(missing.stderr.contains("ENOENT"));
    }

    #[tokio::test]
    async fn under_limit_is_fully_captured() {
        // 상한(여기선 1KiB) 아래의 출력은 온전히 담기고 정상 종료한다
        let result =
            run_command_capped("sh", &args(&["-c", "printf abcdef"]), None, None, None, never(), 1024)
                .await;
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "abcdef");
    }

    #[tokio::test]
    async fn over_limit_kills_and_caps_output() {
        // 상한을 64바이트로 두고 그보다 큰 출력을 꾸준히 내는 명령을 띄운다.
        // 상한을 넘기면 overflow Notify가 자식을 kill하고 잘린 출력과 exit_code 1을 돌려줘야 한다.
        let result = run_command_capped(
            "sh",
            &args(&["-c", "while true; do printf xxxxxxxxxxxxxxxx; done"]),
            None,
            None,
            None,
            never(),
            64,
        )
        .await;
        assert_eq!(result.exit_code, 1);
        assert_eq!(result.stdout.len(), 64);
        assert!(result.stdout.chars().all(|c| c == 'x'));
    }
}
