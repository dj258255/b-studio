//! 자식 프로세스의 출력을 파일로 흘리거나(`run_command_to_file`) 파일을 입력으로 넣는다(`run_command_from_file`).
//! TS `packages/sandbox/src/stream-exec.ts`를 그대로 옮긴 것이다(ADR-193, 2c-1).
//!
//! 동작을 옛 TS와 같게 맞춘 자리:
//! - 잡는 출력은 1MiB(UTF-16 코드 단위)까지, 넘치면 `\n... output truncated ...`를 붙인다. 넘어도 끝까지 읽어
//!   파이프가 막혀 프로세스가 멈추지 않게 한다(TS는 data 이벤트로 받아 버린다).
//! - 종료 코드는 신호로 죽으면(코드 없음) 1로 본다(TS `code ?? 1`).
//! - `env`를 주면 상속 없이 통째로 바꾼다(Node `spawn`의 `env` 옵션이 환경을 치환한다).
//! - 출력을 파일로 흘리다 파이프가 깨졌는데 프로세스는 0으로 끝났으면 오류로 던진다(TS와 같음).
//!   0이 아니면(명령 자체가 실패) 던지지 않는다 — stderr가 이유를 담는다.
//! - 취소: 자식을 `kill_on_drop(true)`로 띄운다. 호출을 멈추면(future가 떨어지면) 자식도 죽는다.
//!   napi 층이 JS `AbortSignal`을 받아 future를 떨어뜨린다.

use std::process::Stdio;

use bstudio_guard::js::{truncate_utf16, utf16_len};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

/// 잡는 출력의 상한(UTF-16 코드 단위). TS `CAPTURE_LIMIT`와 같다.
const CAPTURE_LIMIT: usize = 1024 * 1024;
/// 상한을 넘겼을 때 붙이는 표시. TS와 글자까지 같다.
const TRUNCATED_MARKER: &str = "\n... output truncated ...";

/// `run_command_*`의 결과. TS `ExecResult`와 같은 모양으로 napi 층이 바꾼다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// `bin args`를 띄워 stdout을 `output_file`로 흘리고 stderr만 잡는다. stdin은 닫는다.
pub async fn run_command_to_file(
    bin: &str,
    args: &[String],
    output_file: &str,
    env: Option<&[(String, String)]>,
) -> std::io::Result<ExecOutput> {
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    set_env(&mut command, env);
    let mut child = command.spawn()?;

    let mut stdout = child.stdout.take().expect("stdout은 piped다");
    let stderr = child.stderr.take().expect("stderr은 piped다");

    let output_file = output_file.to_owned();
    let copy = async move {
        let mut file = tokio::fs::File::create(&output_file).await?;
        tokio::io::copy(&mut stdout, &mut file).await?;
        file.flush().await?;
        Ok::<(), std::io::Error>(())
    };

    let (copy_result, stderr_text, status) = tokio::join!(copy, capture(stderr), child.wait());
    let exit_code = status?.code().unwrap_or(1);
    if let Err(error) = copy_result {
        if exit_code == 0 {
            return Err(error);
        }
    }
    Ok(ExecOutput {
        exit_code,
        stdout: String::new(),
        stderr: stderr_text,
    })
}

/// `bin args`를 띄워 `input_file`을 stdin으로 넣고 stdout·stderr를 잡는다.
pub async fn run_command_from_file(
    bin: &str,
    args: &[String],
    input_file: &str,
    env: Option<&[(String, String)]>,
) -> std::io::Result<ExecOutput> {
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    set_env(&mut command, env);
    let mut child = command.spawn()?;

    let stdin = child.stdin.take().expect("stdin은 piped다");
    let stdout = child.stdout.take().expect("stdout은 piped다");
    let stderr = child.stderr.take().expect("stderr은 piped다");

    let input_file = input_file.to_owned();
    let feed = async move {
        let mut stdin = stdin;
        let mut input = tokio::fs::File::open(&input_file).await?;
        tokio::io::copy(&mut input, &mut stdin).await?;
        // stdin을 닫아 자식이 EOF를 보게 한다
        stdin.shutdown().await.ok();
        drop(stdin);
        Ok::<(), std::io::Error>(())
    };

    let (feed_result, stdout_text, stderr_text, status) =
        tokio::join!(feed, capture(stdout), capture(stderr), child.wait());
    let exit_code = status?.code().unwrap_or(1);
    if let Err(error) = feed_result {
        if exit_code == 0 {
            return Err(error);
        }
    }
    Ok(ExecOutput {
        exit_code,
        stdout: stdout_text,
        stderr: stderr_text,
    })
}

fn set_env(command: &mut Command, env: Option<&[(String, String)]>) {
    if let Some(env) = env {
        command.env_clear();
        for (name, value) in env {
            command.env(name, value);
        }
    }
}

/// 스트림을 끝까지 읽어 UTF-8로 풀고, 1MiB(UTF-16 코드 단위)를 넘으면 잘라 표시를 붙인다.
/// 상한을 넘겨도 끝까지 읽어(버려) 파이프가 막히지 않게 한다. TS `capture`와 결과가 같다.
async fn capture<R: AsyncRead + Unpin>(mut stream: R) -> String {
    // UTF-16 한 단위는 UTF-8로 최대 3바이트(BMP 3바이트 글자)다. 상한만큼의 UTF-16을 담으려면
    // 3배 바이트면 충분하다. 넉넉히 4배까지 모으고 그 뒤는 버린다.
    const KEEP_BYTES: usize = CAPTURE_LIMIT * 4;
    let mut kept: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if kept.len() < KEEP_BYTES {
            let room = KEEP_BYTES - kept.len();
            kept.extend_from_slice(&chunk[..read.min(room)]);
        }
        // room을 넘긴 바이트와 KEEP_BYTES 뒤의 바이트는 버린다(읽기는 계속한다)
    }
    let text = String::from_utf8_lossy(&kept);
    if utf16_len(&text) > CAPTURE_LIMIT {
        format!(
            "{}{}",
            truncate_utf16(&text, CAPTURE_LIMIT),
            TRUNCATED_MARKER
        )
    } else {
        text.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    #[tokio::test]
    async fn to_file_writes_stdout_and_captures_stderr() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("out.txt");
        let result = run_command_to_file(
            "sh",
            &args(&["-c", "printf hello; printf oops 1>&2; exit 0"]),
            out.to_str().unwrap(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "");
        assert_eq!(result.stderr, "oops");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "hello");
    }

    #[tokio::test]
    async fn to_file_keeps_nonzero_exit() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("out.txt");
        let result = run_command_to_file(
            "sh",
            &args(&["-c", "printf bad 1>&2; exit 3"]),
            out.to_str().unwrap(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, 3);
        assert_eq!(result.stderr, "bad");
    }

    #[tokio::test]
    async fn from_file_feeds_stdin() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("in.txt");
        std::fs::write(&input, "abcABC\n").unwrap();
        let result =
            run_command_from_file("tr", &args(&["a-z", "A-Z"]), input.to_str().unwrap(), None)
                .await
                .unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "ABCABC\n");
        assert_eq!(result.stderr, "");
    }

    #[tokio::test]
    async fn env_replaces_inherited() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("out.txt");
        std::env::set_var("BSTUDIO_IO_PARENT", "should-not-leak");
        let env = vec![("BSTUDIO_IO_CHILD".to_owned(), "set".to_owned())];
        run_command_to_file(
            "sh",
            &args(&[
                "-c",
                "printf '%s:%s' \"${BSTUDIO_IO_PARENT:-none}\" \"${BSTUDIO_IO_CHILD:-none}\"",
            ]),
            out.to_str().unwrap(),
            Some(&env),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "none:set");
    }

    #[tokio::test]
    async fn spawn_error_is_err() {
        let result = run_command_to_file(
            "definitely-not-a-real-binary-xyz",
            &args(&[]),
            "/dev/null",
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn stderr_truncates_past_limit() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("out.txt");
        // 상한보다 큰 stderr를 낸다(yes를 head로 자른다)
        let bytes = CAPTURE_LIMIT + 100;
        let script = format!("head -c {bytes} /dev/zero | tr '\\0' 'x' 1>&2");
        let result =
            run_command_to_file("sh", &args(&["-c", &script]), out.to_str().unwrap(), None)
                .await
                .unwrap();
        assert!(result.stderr.ends_with(TRUNCATED_MARKER));
        assert_eq!(
            utf16_len(&result.stderr),
            CAPTURE_LIMIT + utf16_len(TRUNCATED_MARKER)
        );
    }

    #[tokio::test]
    async fn stderr_at_limit_not_truncated() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("out.txt");
        let script = format!("head -c {CAPTURE_LIMIT} /dev/zero | tr '\\0' 'x' 1>&2");
        let result =
            run_command_to_file("sh", &args(&["-c", &script]), out.to_str().unwrap(), None)
                .await
                .unwrap();
        assert!(!result.stderr.ends_with(TRUNCATED_MARKER));
        assert_eq!(utf16_len(&result.stderr), CAPTURE_LIMIT);
    }
}
