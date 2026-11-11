//! 바이트 그대로 돌려주는 실행(`run_command_bytes`)과 `git archive | tar -x` 파이프(`run_archive_extract`).
//! 체크포인트(`packages/agent/src/checkpoints.ts`)의 `execFile`·`spawn`을 옮긴 것이다(ADR-195, 4f A1).
//!
//! `process::run_command`와 다른 점(옛 `execFile`과 맞추려고 달리했다):
//! - stdout·stderr는 문자열이 아니라 **바이트**다(`cat-file blob`은 UTF-8이 아닐 수 있다).
//! - 종료 코드는 `Option`이다. 신호로 죽으면 `None`(옛 `error.code`가 null). 1로 접으면 `check-ignore`의 "1은 정상"과 섞여 열린 쪽으로 틀린다.
//! - 띄우기 실패는 `spawn_error`로 따로 돌려준다(종료 코드와 섞지 않는다).
//! - 취소·상한 넘김은 SIGTERM을 먼저 보낸다(옛 `execFile`의 `timeout`·`maxBuffer`가 SIGTERM이다. git이 잠금 파일을 치우고 끝난다).
//!   `TERM_GRACE` 안에 안 죽으면 SIGKILL이다(옛 코드는 SIGTERM만 보내고 끝없이 기다렸다. 새 한계다).

use std::future::Future;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::Notify;

use crate::process::{read_into, set_env};

/// 스트림마다 받는 가장 큰 바이트(`run_command`와 같다)
const MAX_BUFFER: usize = 256 * 1024 * 1024;
/// SIGTERM 뒤 이 시간 안에 안 죽으면 SIGKILL
const TERM_GRACE: Duration = Duration::from_secs(5);
/// 파이프 해제의 stderr 상한(스트림마다). 옛 코드는 끝없이 모았다. 새 한계다
const PIPE_STDERR_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BytesOutput {
    /// 정상 종료 코드. 신호로 죽었거나 띄우지 못했으면 `None`
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// `cancel`이 깨서 죽였다
    pub aborted: bool,
    /// 어느 스트림이든 `limit` 바이트에 닿아 죽였다. 닿은 것과 넘은 것은 호출자가 길이로 가린다
    pub overflowed: bool,
    /// 띄우기 실패 메시지(`spawn <bin> ENOENT` 꼴)
    pub spawn_error: Option<String>,
}

fn spawn_message(bin: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!("spawn {bin} ENOENT")
    } else {
        format!("spawn {bin} {error}")
    }
}

fn empty_failure(message: String) -> BytesOutput {
    BytesOutput { exit_code: None, stdout: Vec::new(), stderr: Vec::new(), aborted: false, overflowed: false, spawn_error: Some(message) }
}


/// `bin`이 경로가 아니면(`/`가 없으면) 자식에게 줄 `env`의 `PATH`로 찾아 절대 경로로 바꾼다. `execvp`가 자식 환경의 PATH로 찾는 것과 같다(빈 항목은 현재 폴더).
/// 왜 하는가: 환경에 PATH를 넣고 경로가 아닌 이름을 주면 Rust 표준 라이브러리는 `posix_spawn`을 쓰지 못하고 `fork`로 되돌아간다.
/// 큰 Node 서버 프로세스에서 `fork`는 한 번에 17ms(중앙값)·90ms(p90)까지 걸려 git 호출이 많은 체크포인트 흐름이 눈에 띄게 느려졌다(F0 기준 사진의 시각 경쟁이 바뀔 만큼).
/// 못 찾거나 환경에 PATH가 없으면 그대로 돌려준다(띄우기 실패 문구는 같다).
#[cfg(not(unix))]
fn resolve_in_env_path(bin: &str, _env: Option<&[(String, String)]>) -> String {
    bin.to_owned()
}

#[cfg(unix)]
fn resolve_in_env_path(bin: &str, env: Option<&[(String, String)]>) -> String {
    use std::os::unix::fs::PermissionsExt;
    if bin.contains('/') {
        return bin.to_owned();
    }
    let Some(path) = env.and_then(|pairs| pairs.iter().rev().find(|(name, _)| name == "PATH")).map(|(_, value)| value) else {
        return bin.to_owned();
    };
    for dir in path.split(':') {
        let dir = if dir.is_empty() { "." } else { dir };
        let candidate = std::path::Path::new(dir).join(bin);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    bin.to_owned()
}

/// SIGTERM을 보내고 `TERM_GRACE`를 기다린 뒤에도 살아 있으면 SIGKILL로 거둔다
async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: 우리가 띄운 자식의 pid에 신호만 보낸다
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        if tokio::time::timeout(TERM_GRACE, child.wait()).await.is_ok() {
            return;
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// `bin args`를 띄워 `input`을 stdin으로 넣고(없어도 stdin은 닫는다) stdout·stderr를 바이트로 모은다.
/// `cancel`이 깨거나 스트림이 `limit`에 닿으면 SIGTERM으로 멈추고 그때까지의 출력을 돌려준다. 던지지 않는다.
pub async fn run_command_bytes(
    bin: &str,
    args: &[String],
    input: Option<&[u8]>,
    env: Option<&[(String, String)]>,
    cwd: Option<&str>,
    cancel: impl Future<Output = ()>,
    limit: usize,
) -> BytesOutput {
    let limit = limit.min(MAX_BUFFER);
    let mut command = Command::new(resolve_in_env_path(bin, env));
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    set_env(&mut command, env);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return empty_failure(spawn_message(bin, &error)),
    };
    let stdout = child.stdout.take().expect("stdout은 piped다");
    let stderr = child.stderr.take().expect("stderr은 piped다");
    let stdin = child.stdin.take();

    let out_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let err_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let overflow = Arc::new(Notify::new());
    let out_reader = tokio::spawn(read_into(stdout, out_buf.clone(), overflow.clone(), limit));
    let err_reader = tokio::spawn(read_into(stderr, err_buf.clone(), overflow.clone(), limit));

    if let Some(mut stdin) = stdin {
        let input = input.map(<[u8]>::to_vec);
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
            terminate(&mut child).await;
            None
        }
        _ = &mut overflow_wait => {
            overflowed = true;
            terminate(&mut child).await;
            None
        }
    };
    if aborted || overflowed {
        // 고아 손자가 파이프를 쥐고 있어도 막히지 않게 리더를 중단한다. 모은 버퍼는 남는다
        out_reader.abort();
        err_reader.abort();
    }
    let _ = out_reader.await;
    let _ = err_reader.await;
    let exit_code = if aborted || overflowed { None } else { status.and_then(|status| status.code()) };
    let stdout = out_buf.lock().expect("stdout 버퍼 잠금").clone();
    let stderr = err_buf.lock().expect("stderr 버퍼 잠금").clone();
    BytesOutput { exit_code, stdout, stderr, aborted, overflowed, spawn_error: None }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineOutput {
    pub git_code: Option<i32>,
    pub tar_code: Option<i32>,
    /// git의 stderr 뒤에 tar의 stderr
    pub stderr: Vec<u8>,
    pub spawn_error: Option<String>,
}

/// `git_bin git_args | tar -x --no-same-owner -C dest`. git의 stdout을 tar의 stdin으로 직접 잇는다(파이프, 메모리에 올리지 않는다).
/// git은 `git_env`로 환경을 통째로 바꾸고 stdin은 닫는다. tar는 환경을 상속한다(옛 코드와 같다).
/// 시간 제한이 없다(옛 코드와 같다). 던지지 않는다.
pub async fn run_archive_extract(git_bin: &str, git_args: &[String], git_env: Option<&[(String, String)]>, dest: &str) -> PipelineOutput {
    let failure = |message: String| PipelineOutput { git_code: None, tar_code: None, stderr: Vec::new(), spawn_error: Some(message) };
    let mut git_cmd = Command::new(resolve_in_env_path(git_bin, git_env));
    git_cmd.args(git_args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    set_env(&mut git_cmd, git_env);
    let mut git = match git_cmd.spawn() {
        Ok(child) => child,
        Err(error) => return failure(spawn_message(git_bin, &error)),
    };
    let git_stdout: Stdio = match git.stdout.take().expect("stdout은 piped다").try_into() {
        Ok(stdio) => stdio,
        Err(error) => {
            let _ = git.start_kill();
            let _ = git.wait().await;
            return failure(format!("git 출력을 tar에 잇지 못했습니다: {error}"));
        }
    };
    let mut tar_cmd = Command::new("tar");
    tar_cmd.args(["-x", "--no-same-owner", "-C", dest]).stdin(git_stdout).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut tar = match tar_cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = git.start_kill();
            let _ = git.wait().await;
            return failure(spawn_message("tar", &error));
        }
    };
    let git_err = Arc::new(Mutex::new(Vec::<u8>::new()));
    let tar_err = Arc::new(Mutex::new(Vec::<u8>::new()));
    let unused = Arc::new(Notify::new());
    let git_reader = tokio::spawn(read_into(git.stderr.take().expect("stderr은 piped다"), git_err.clone(), unused.clone(), PIPE_STDERR_LIMIT));
    let tar_reader = tokio::spawn(read_into(tar.stderr.take().expect("stderr은 piped다"), tar_err.clone(), unused, PIPE_STDERR_LIMIT));
    let (git_status, tar_status) = tokio::join!(git.wait(), tar.wait());
    let _ = git_reader.await;
    let _ = tar_reader.await;
    let mut stderr = git_err.lock().expect("잠금").clone();
    stderr.extend_from_slice(&tar_err.lock().expect("잠금"));
    PipelineOutput { git_code: git_status.ok().and_then(|s| s.code()), tar_code: tar_status.ok().and_then(|s| s.code()), stderr, spawn_error: None }
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

    const LIMIT: usize = 1024 * 1024;

    #[tokio::test]
    async fn keeps_binary_output_and_nul_bytes() {
        let out = run_command_bytes("sh", &args(&["-c", "printf '\\377\\000\\376a'; printf '\\200' 1>&2"]), None, None, None, never(), LIMIT).await;
        assert_eq!(out.exit_code, Some(0));
        assert_eq!(out.stdout, vec![0xff, 0x00, 0xfe, b'a']);
        assert_eq!(out.stderr, vec![0x80]);
    }

    #[tokio::test]
    async fn feeds_binary_stdin_and_closes_when_absent() {
        let piped = run_command_bytes("cat", &args(&[]), Some(b"a\0b\0\xff"), None, None, never(), LIMIT).await;
        assert_eq!(piped.stdout, b"a\0b\0\xff");
        let empty = run_command_bytes("cat", &args(&[]), None, None, None, never(), LIMIT).await;
        assert_eq!(empty.exit_code, Some(0));
        assert!(empty.stdout.is_empty());
    }

    #[tokio::test]
    async fn nonzero_exit_is_kept_and_signal_death_is_none() {
        let seven = run_command_bytes("sh", &args(&["-c", "exit 7"]), None, None, None, never(), LIMIT).await;
        assert_eq!(seven.exit_code, Some(7));
        let killed = run_command_bytes("sh", &args(&["-c", "kill -9 $$"]), None, None, None, never(), LIMIT).await;
        assert_eq!(killed.exit_code, None);
        assert!(!killed.aborted && !killed.overflowed);
    }

    #[tokio::test]
    async fn spawn_failure_is_reported_apart_from_exit_code() {
        let out = run_command_bytes("definitely-not-a-real-binary-xyz", &args(&[]), None, None, None, never(), LIMIT).await;
        assert_eq!(out.exit_code, None);
        assert_eq!(out.spawn_error.as_deref(), Some("spawn definitely-not-a-real-binary-xyz ENOENT"));
    }

    #[tokio::test]
    async fn overflow_stops_reading_with_sigterm() {
        let out = run_command_bytes("sh", &args(&["-c", "yes | head -c 50000000"]), None, None, None, never(), 1000).await;
        assert!(out.overflowed);
        assert!(out.stdout.len() <= 1000);
        assert_eq!(out.exit_code, None);
    }

    #[tokio::test]
    async fn cancel_sends_sigterm_first_so_cleanup_runs() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("got-term");
        let script = format!("trap 'echo term > {}; exit 0' TERM; echo started; while :; do sleep 0.05; done", marker.display());
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(400)).await;
        };
        let out = run_command_bytes("sh", &args(&["-c", &script]), None, None, None, cancel, LIMIT).await;
        assert!(out.aborted);
        assert!(String::from_utf8_lossy(&out.stdout).contains("started"));
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "term\n");
    }

    #[tokio::test]
    async fn archive_extract_pipes_git_into_tar_and_reports_both_codes() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        let script = format!("cd {} && printf hello > payload && tar -c payload", dir.path().display());
        let ok = run_archive_extract("sh", &args(&["-c", &script]), None, dest.to_str().unwrap()).await;
        assert_eq!((ok.git_code, ok.tar_code), (Some(0), Some(0)));
        assert_eq!(std::fs::read_to_string(dest.join("payload")).unwrap(), "hello");
        let bad = run_archive_extract("sh", &args(&["-c", "echo boom 1>&2; exit 9"]), None, dest.to_str().unwrap()).await;
        assert_eq!(bad.git_code, Some(9));
        assert!(String::from_utf8_lossy(&bad.stderr).contains("boom"));
        let missing = run_archive_extract("definitely-not-a-real-binary-xyz", &[], None, dest.to_str().unwrap()).await;
        assert!(missing.spawn_error.is_some());
    }

    #[tokio::test]
    async fn archive_extract_into_a_file_fails_in_tar() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, "x").unwrap();
        let script = format!("cd {} && printf hello > payload && tar -c payload", dir.path().display());
        let out = run_archive_extract("sh", &args(&["-c", &script]), None, file.join("sub").to_str().unwrap()).await;
        assert_eq!(out.git_code, Some(0));
        assert_ne!(out.tar_code, Some(0));
    }

    #[tokio::test]
    async fn env_replaces_inherited_and_cwd_applies() {
        std::env::set_var("BSTUDIO_BYTES_PARENT", "leak");
        let dir = tempfile::tempdir().unwrap();
        let env = vec![("BSTUDIO_BYTES_CHILD".to_owned(), "set".to_owned())];
        let out = run_command_bytes(
            "/bin/sh",
            &args(&["-c", "printf '%s:%s:' \"${BSTUDIO_BYTES_PARENT:-none}\" \"${BSTUDIO_BYTES_CHILD:-none}\"; pwd -P"]),
            None,
            Some(&env),
            dir.path().to_str(),
            never(),
            LIMIT,
        )
        .await;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        assert!(text.starts_with("none:set:"), "{text}");
        assert!(text.trim_end().ends_with(dir.path().canonicalize().unwrap().to_str().unwrap()), "{text}");
    }

    #[tokio::test]
    async fn archive_extract_gives_git_the_replaced_env_and_tar_the_inherited_one() {
        std::env::set_var("BSTUDIO_ARCHIVE_PARENT", "leak");
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest");
        std::fs::create_dir(&dest).unwrap();
        let env = vec![("PATH".to_owned(), std::env::var("PATH").unwrap()), ("BSTUDIO_ARCHIVE_CHILD".to_owned(), "set".to_owned())];
        let script = format!("cd {} && printf '%s:%s' \"${{BSTUDIO_ARCHIVE_PARENT:-none}}\" \"$BSTUDIO_ARCHIVE_CHILD\" > payload && tar -c payload", dir.path().display());
        let out = run_archive_extract("/bin/sh", &args(&["-c", &script]), Some(&env), dest.to_str().unwrap()).await;
        assert_eq!((out.git_code, out.tar_code), (Some(0), Some(0)));
        assert_eq!(std::fs::read_to_string(dest.join("payload")).unwrap(), "none:set");
    }

    #[tokio::test]
    async fn resolves_a_bare_name_with_the_child_env_path_not_the_parents() {
        // 부모 PATH에는 없고 자식 env의 PATH에만 있는 실행 파일을 찾는다(execvp와 같다)
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("only-in-child-path");
        std::fs::write(&bin, "#!/bin/sh\nprintf found\n").unwrap();
        std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let env = vec![("PATH".to_owned(), format!("{}:/usr/bin:/bin", dir.path().display()))];
        let out = run_command_bytes("only-in-child-path", &args(&[]), None, Some(&env), None, never(), LIMIT).await;
        assert_eq!(out.stdout, b"found");
        // 안 실행되는 파일은 건너뛰고 못 찾으면 띄우기 실패다
        let missing = run_command_bytes("not-anywhere-xyz", &args(&[]), None, Some(&env), None, never(), LIMIT).await;
        assert_eq!(missing.spawn_error.as_deref(), Some("spawn not-anywhere-xyz ENOENT"));
    }
}
