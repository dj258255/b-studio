//! b-studio의 I/O를 Rust로 옮긴 크레이트(ADR-193).
//!
//! 판정(무엇이 안전한가, 무엇을 어디에 둘까)은 [`bstudio_guard`]가 하고, 여기는 그 판정이 정한 일을
//! 실제로 하는 syscall만 담는다: 자식 프로세스, 파일, 소켓, PTY. napi를 모른다 — napi 층(`bstudio-node`)이
//! 이 크레이트를 붙이고, 4단계(ADR-191·192)에서 Rust HTTP 서버가 같은 크레이트를 직접 쓴다.

pub mod checkpoint_remote;
pub mod cli_command;
pub mod container_verify;
pub mod deploy_io;
pub mod exec_stream;
#[cfg(test)]
mod fake_docker;
pub mod git_mask_fs;
pub mod host_port;
pub mod lifecycle_io;
pub mod log_stream;
pub mod process;
pub mod process_bytes;
pub mod port_retry;
pub mod pty;
pub mod readiness_io;
pub mod safe_fs;
pub mod snapshot_io;
pub mod stream_exec;
pub mod streaming;
pub mod sync_relay;
pub mod up_loop;
pub mod verify_io;
pub mod workspace_io;
