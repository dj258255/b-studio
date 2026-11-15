//! `claude` CLI 자식 프로세스의 입출력 층(ADR-195 4f A8a, ADR-201). TS `packages/agent/src/claude-cli-process.ts`의 `spawnClaudeCli`가
//! `node:child_process`·`node:readline` 위에서 하던 일을 옮긴 것이다(옛 구현은 `claude-cli-process-spawn-legacy.ts`, 차등 시험의 기준).
//!
//! 여기가 맡는 것: 자식 띄우기(인자 배열·env·cwd, 파이프 셋), 표준 입력 줄 쓰기·닫기, 표준 출력의 UTF-8 해석과 줄 나누기(Node `StringDecoder`·`readline`과
//! 같게), 표준 오류 끝 2,000자 보관(UTF-16 단위), 닫기 단계(입력 닫기 → SIGTERM → SIGKILL), 끝 상태(code·signal·띄우기 오류).
//! JSON 해석·빈 줄 건너뛰기는 하지 않는다(TS가 한다 — ADR-201의 경계). 실행 파일 고르기와 PATH 정리도 TS가 이미 Rust 판정으로 받은 값을 넘긴다.
//!
//! 옛 동작과 같게 맞춘 자리:
//! - 끝 사건(`Exit`)은 자식이 끝나고 **표준 출력·표준 오류가 모두 닫힌 뒤에** 한 번 온다(Node `close`). 줄 사건은 모두 그 앞이다.
//! - 줄 나누기는 Node `readline`(`crlfDelay: Infinity`)의 알고리즘을 그대로 옮겼다: `\r\n`·`\n`·홀로 선 `\r`이 줄 끝이고, 덩어리 끝의 `\r` 바로 뒤
//!   덩어리가 `\n`으로 시작하면 그 `\n`은 하나로 센다. 마지막 줄은 줄바꿈이 없어도 낸다. 입력 끝에 남은 미완성 UTF-8 바이트는 버린다(readline은 디코더를 비우지 않는다).
//! - 표준 오류는 `setEncoding('utf8')` 뒤 `(stderr + chunk).slice(-2000)`이다: UTF-16 단위로 자르므로 짝 없는 서로게이트가 남을 수 있다. 입력 끝에는 디코더를 비운다(U+FFFD).
//! - 닫기: `stop(Graceful)`은 입력을 닫고 `term_after` 뒤에도 살아 있으면 SIGTERM, 그 뒤 `kill_after` 뒤에도 살아 있으면 SIGKILL. `stop(Now)`는 입력을 닫고
//!   바로 SIGTERM(걸려 있던 graceful 타이머를 당긴다). 이미 SIGTERM을 보냈으면 다시 보내지 않는다.
//!   **신호는 자기가 띄운 프로세스의 pid에만, 아직 거두지 않은 동안에만** 보낸다(거둔 pid는 다른 프로세스가 쓸 수 있다). 거두기와 신호 보내기는 한 작업이 차례로 한다.
//! - 표준 출력 백프레셔: 소비하지 않은 줄(`consumed`로 알린 만큼 뺀다)이 `LINE_HIGH`에 닿으면 읽기를 멈춰 파이프가 차고 자식이 쓰기에서 멈춘다(옛 `readline` 비동기 반복자의
//!   `highWaterMark`와 같은 성질). `LINE_LOW` 이하로 내려가면 다시 읽는다. 자식이 끝나면(거두면) 한도를 풀고 남은 출력을 비운다(옛 Node의 `flushStdio`).
//! - 입력 쪽이 먼저 닫혀도(EPIPE) 죽지 않는다: 남은 쓰기를 버린다. 닫힌 뒤의 쓰기도 버린다.
//! - 띄우지 못하면(`spawn` 오류) 줄 없이 `Exit { code: None, signal: None, error }` 하나로 끝난다.
//!
//! napi를 모른다: 사건은 추상 콜백이고, 돌리는 작업(`pump`)은 spawn하지 않고 future로 돌려준다(exec_stream과 같은 이유).

use std::future::Future;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;

/// 표준 오류에서 남기는 끝부분(UTF-16 단위). 옛 `STDERR_KEEP`
pub const STDERR_KEEP: usize = 2_000;
const READ_CHUNK: usize = 64 * 1024;
/// 소비하지 않은 줄이 이만큼이면 표준 출력 읽기를 멈춘다. 옛 구현의 `readline` 비동기 반복자(`events.on`의 `highWaterMark: 1024`, Node 22.17에서 재서 확인)와 같다.
/// 한 번 읽은 덩어리 안의 줄은 나눠 멈추지 않으므로(옛 구현도 같다) 그만큼은 넘을 수 있다
pub const LINE_HIGH: usize = 1024;
/// 멈춘 뒤 소비하지 않은 줄이 이만큼 이하로 내려가면 다시 읽는다(옛 구현은 0이 되어야 다시 읽었다. 더 일찍 다시 읽어 쌓이는 양의 상한은 같다)
pub const LINE_LOW: usize = LINE_HIGH / 2;

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Node `StringDecoder('utf8')`와 같은 해석. 덩어리 끝의 미완성 글자는 쥐고 있다가 다음 덩어리와 잇고, 이어져야 할 자리에 연속 바이트가 아닌
/// 바이트가 오면 거기서 끊어 새 글자로 본다. 깨진 바이트는 U+FFFD다. 쥔 바이트와 본문은 따로 해석한다(Node `string_decoder.cc`의 `DecodeData`).
pub struct Utf8Decoder {
    pending: Vec<u8>,
    missing: usize,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self { pending: Vec::new(), missing: 0 }
    }

    pub fn write(&mut self, mut data: &[u8]) -> String {
        let mut prepend = String::new();
        if self.missing > 0 {
            for (i, byte) in data.iter().enumerate().take(self.missing) {
                if byte & 0xC0 != 0x80 {
                    // 연속 바이트여야 할 자리에 다른 바이트가 왔다: 모은 만큼으로 끊고, 이 바이트부터 새 글자
                    self.missing = 0;
                    self.pending.extend_from_slice(&data[..i]);
                    data = &data[i..];
                    break;
                }
            }
            let found = data.len().min(self.missing);
            self.pending.extend_from_slice(&data[..found]);
            data = &data[found..];
            self.missing -= found;
            if self.missing == 0 {
                prepend = lossy(&self.pending);
                self.pending.clear();
            }
        }
        if data.is_empty() {
            return prepend;
        }
        // 이 덩어리가 미완성 글자로 끝나는지 본다(마지막 바이트가 ASCII가 아닐 때만)
        let mut buffered = 0usize;
        if data[data.len() - 1] & 0x80 != 0 {
            let mut i = data.len() - 1;
            loop {
                buffered += 1;
                if data[i] & 0xC0 == 0x80 {
                    // 연속 바이트. 4개를 넘거나 앞에 시작 바이트가 없으면 깨진 것이라 해석기에 맡긴다
                    if buffered >= 4 || i == 0 {
                        buffered = 0;
                        break;
                    }
                } else {
                    let need = if data[i] & 0xE0 == 0xC0 {
                        2
                    } else if data[i] & 0xF0 == 0xE0 {
                        3
                    } else if data[i] & 0xF8 == 0xF0 {
                        4
                    } else {
                        buffered = 0;
                        break;
                    };
                    if buffered >= need {
                        buffered = 0;
                    } else {
                        self.missing = need - buffered;
                    }
                    break;
                }
                i -= 1;
            }
        }
        let body_len = data.len() - buffered;
        if buffered > 0 {
            self.pending.extend_from_slice(&data[body_len..]);
        }
        prepend + &lossy(&data[..body_len])
    }

    /// 입력이 끝났다. 쥐고 있던 미완성 바이트를 해석해 내보낸다(U+FFFD)
    pub fn end(&mut self) -> String {
        self.missing = 0;
        let rest = lossy(&self.pending);
        self.pending.clear();
        rest
    }
}

impl Default for Utf8Decoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Node `readline`(`crlfDelay: Infinity`)의 줄 나누기(`normalWrite`). 글자를 받아 줄을 낸다
pub struct LineSplitter {
    buffer: String,
    saw_return: bool,
}

/// `\r?\n|\r(?!\n)`의 첫 일치: (시작, 끝)
fn find_ending(text: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => return Some((i, i + 1)),
            b'\r' => return Some(if bytes.get(i + 1) == Some(&b'\n') { (i, i + 2) } else { (i, i + 1) }),
            _ => i += 1,
        }
    }
    None
}

impl LineSplitter {
    pub fn new() -> Self {
        Self { buffer: String::new(), saw_return: false }
    }

    pub fn write(&mut self, chunk: &str, out: &mut Vec<String>) {
        let mut text = chunk;
        // 앞 덩어리가 `\r`로 끝났으면 이 덩어리 맨 앞의 `\n`은 그 줄 끝의 일부다
        if self.saw_return {
            if text.starts_with('\n') {
                text = &text[1..];
            }
            self.saw_return = false;
        }
        if find_ending(text, 0).is_none() {
            self.buffer.push_str(text);
            return;
        }
        let joined;
        if !self.buffer.is_empty() {
            joined = std::mem::take(&mut self.buffer) + text;
            text = &joined;
        }
        self.saw_return = text.ends_with('\r');
        let mut start = 0;
        while let Some((at, end)) = find_ending(text, start) {
            out.push(text[start..at].to_owned());
            start = end;
        }
        self.buffer = text[start..].to_owned();
    }

    /// 입력이 끝났다. 줄바꿈 없이 남은 마지막 줄을 낸다
    pub fn finish(&mut self, out: &mut Vec<String>) {
        if !self.buffer.is_empty() {
            out.push(std::mem::take(&mut self.buffer));
        }
    }
}

impl Default for LineSplitter {
    fn default() -> Self {
        Self::new()
    }
}

/// 표준 출력 바이트 → 줄. 디코더와 줄 나누기를 잇는다
pub struct LineReader {
    decoder: Utf8Decoder,
    splitter: LineSplitter,
}

impl LineReader {
    pub fn new() -> Self {
        Self { decoder: Utf8Decoder::new(), splitter: LineSplitter::new() }
    }

    pub fn write(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        let text = self.decoder.write(bytes);
        self.splitter.write(&text, &mut lines);
        lines
    }

    /// 입력 끝. 마지막 줄을 낸다. 미완성 UTF-8 바이트는 버린다(readline은 디코더를 비우지 않는다)
    pub fn finish(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        self.splitter.finish(&mut lines);
        lines
    }
}

impl Default for LineReader {
    fn default() -> Self {
        Self::new()
    }
}

/// 표준 오류의 끝 `STDERR_KEEP` UTF-16 단위
pub struct StderrTail {
    decoder: Utf8Decoder,
    units: Vec<u16>,
}

impl StderrTail {
    pub fn new() -> Self {
        Self { decoder: Utf8Decoder::new(), units: Vec::new() }
    }

    fn push(&mut self, text: &str) {
        self.units.extend(text.encode_utf16());
        if self.units.len() > STDERR_KEEP {
            let cut = self.units.len() - STDERR_KEEP;
            self.units.drain(..cut);
        }
    }

    pub fn write(&mut self, bytes: &[u8]) {
        let text = self.decoder.write(bytes);
        self.push(&text);
    }

    /// 입력 끝: 디코더를 비운다(`setEncoding`을 건 스트림의 `end`)
    pub fn finish(&mut self) {
        let text = self.decoder.end();
        self.push(&text);
    }

    pub fn units(&self) -> Vec<u16> {
        self.units.clone()
    }
}

impl Default for StderrTail {
    fn default() -> Self {
        Self::new()
    }
}

// ── 프로세스 ──

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliSpawnError {
    /// Node의 오류 이름(`ENOENT` 등)
    pub code: String,
    pub errno: i32,
    /// Node와 같은 `spawn <실행 파일> <이름>`
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliExit {
    /// 신호로 죽었거나 띄우지 못했으면 `None`
    pub code: Option<i32>,
    /// Node의 신호 이름(`SIGTERM` 등). 신호로 죽지 않았으면 `None`
    pub signal: Option<String>,
    pub error: Option<CliSpawnError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliEvent {
    /// 표준 출력에서 나온 줄들(순서대로)
    Lines(Vec<String>),
    /// 끝. 한 번만, 모든 줄 사건 뒤에 온다
    Exit(CliExit),
}

pub type OnCliEvent = Arc<dyn Fn(CliEvent) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliSignal {
    Term,
    Kill,
}

/// 신호를 보내는 일. 시험이 보낸 신호를 기록하려고 바꿔 끼운다
pub type Signaler = Arc<dyn Fn(u32, CliSignal) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    Graceful,
    Now,
}

pub struct CliConfig {
    pub bin: String,
    pub args: Vec<String>,
    /// 자식의 환경 전부(비운 뒤 이것만 준다)
    pub env: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub term_after: Duration,
    pub kill_after: Duration,
    /// 소비하지 않은 줄이 이만큼이면 읽기를 멈춘다(`LINE_HIGH`)
    pub line_high: usize,
    /// 멈춘 뒤 이만큼 이하로 내려가면 다시 읽는다(`LINE_LOW`)
    pub line_low: usize,
}

/// 표준 출력 줄의 소비 현황. 읽는 쪽이 줄을 내보낼 때 더하고, 소비하는 쪽이 `consumed`로 뺀다
struct Backpressure {
    pending: AtomicUsize,
    released: AtomicBool,
    wake: Notify,
}

impl Backpressure {
    /// 소비하지 않은 줄이 `high` 미만이 될 때까지(한 번 멈췄으면 `low` 이하가 될 때까지) 기다린다. 자식이 끝나 풀렸으면 바로 돌아온다
    async fn wait_for_room(&self, high: usize, low: usize) {
        if self.pending.load(Ordering::Acquire) < high {
            return;
        }
        loop {
            let woken = self.wake.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            if self.released.load(Ordering::Acquire) || self.pending.load(Ordering::Acquire) <= low {
                return;
            }
            woken.await;
        }
    }
}

#[cfg(unix)]
pub fn os_signal(pid: u32, signal: CliSignal) {
    let signo = match signal {
        CliSignal::Term => libc::SIGTERM,
        CliSignal::Kill => libc::SIGKILL,
    };
    // SAFETY: 이 모듈이 띄우고 아직 거두지 않은 자식의 pid에만 부른다(호출하는 쪽이 try_wait로 확인한다). 이미 죽었으면 ESRCH로 실패하고 무시한다.
    unsafe {
        libc::kill(pid as libc::pid_t, signo);
    }
}

#[cfg(not(unix))]
pub fn os_signal(_pid: u32, _signal: CliSignal) {}

/// 세션 손잡이. 모두 동기라 JS 메인 스레드에서 바로 부를 수 있다
pub struct CliHandle {
    stdin: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    control: mpsc::UnboundedSender<(StopMode, Instant)>,
    stderr: Arc<Mutex<StderrTail>>,
    backpressure: Arc<Backpressure>,
}

impl CliHandle {
    /// 줄 `n`개를 소비했다고 알린다(읽기를 멈춰 둔 것을 풀 수 있다). 받은 것보다 많이 알려도 0에서 멈춘다
    pub fn consumed(&self, n: usize) {
        let _ = self.backpressure.pending.fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| Some(pending.saturating_sub(n)));
        self.backpressure.wake.notify_one();
    }

    /// 표준 입력에 한 줄(끝에 `\n`을 붙인다)을 쓴다. 닫힌 뒤나 자식이 끝난 뒤에는 버린다
    pub fn write_line(&self, line: String) {
        if let Some(tx) = self.stdin.lock().expect("stdin 잠금").as_ref() {
            let mut data = line.into_bytes();
            data.push(b'\n');
            let _ = tx.send(data);
        }
    }

    /// 표준 입력을 닫는다. 이미 보낸 쓰기는 모두 쓰인 뒤에 닫힌다
    pub fn close_input(&self) {
        self.stdin.lock().expect("stdin 잠금").take();
    }

    /// 끝내 달라고 한다(입력 닫기 + 단계). 타이머는 이 호출 시각부터 잰다
    pub fn stop(&self, mode: StopMode) {
        self.close_input();
        let _ = self.control.send((mode, Instant::now()));
    }

    /// 표준 오류의 끝부분(UTF-16 단위)
    pub fn stderr_tail(&self) -> Vec<u16> {
        self.stderr.lock().expect("stderr 잠금").units()
    }
}

#[cfg(unix)]
fn signal_name(signo: i32) -> String {
    let name = match signo {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        libc::SIGURG => "SIGURG",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGWINCH => "SIGWINCH",
        libc::SIGIO => "SIGIO",
        libc::SIGSYS => "SIGSYS",
        other => return format!("SIG{other}"),
    };
    name.to_owned()
}

#[cfg(unix)]
fn errno_name(errno: i32) -> String {
    let name = match errno {
        libc::ENOENT => "ENOENT",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::ENOTDIR => "ENOTDIR",
        libc::ENOEXEC => "ENOEXEC",
        libc::E2BIG => "E2BIG",
        libc::EAGAIN => "EAGAIN",
        libc::ENOMEM => "ENOMEM",
        libc::EMFILE => "EMFILE",
        libc::ENFILE => "ENFILE",
        libc::ELOOP => "ELOOP",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ETXTBSY => "ETXTBSY",
        libc::EISDIR => "EISDIR",
        libc::EIO => "EIO",
        other => return format!("E{other}"),
    };
    name.to_owned()
}

#[cfg(not(unix))]
fn errno_name(errno: i32) -> String {
    format!("E{errno}")
}

fn exit_of(status: std::io::Result<std::process::ExitStatus>) -> CliExit {
    let Ok(status) = status else {
        return CliExit { code: None, signal: None, error: None };
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signo) = status.signal() {
            return CliExit { code: None, signal: Some(signal_name(signo)), error: None };
        }
    }
    CliExit { code: status.code(), signal: None, error: None }
}

pub fn spawn_cli(config: CliConfig, on_event: OnCliEvent) -> (CliHandle, impl Future<Output = ()> + Send) {
    spawn_cli_with(config, on_event, Arc::new(os_signal))
}

/// `spawn_cli`. 신호 보내기를 바꿔 끼울 수 있다(시험)
pub fn spawn_cli_with(config: CliConfig, on_event: OnCliEvent, signaler: Signaler) -> (CliHandle, impl Future<Output = ()> + Send) {
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<(StopMode, Instant)>();
    let stderr_tail = Arc::new(Mutex::new(StderrTail::new()));
    let stderr_for_pump = stderr_tail.clone();
    let backpressure = Arc::new(Backpressure { pending: AtomicUsize::new(0), released: AtomicBool::new(false), wake: Notify::new() });
    let backpressure_for_pump = backpressure.clone();

    let mut command = Command::new(&config.bin);
    command.args(&config.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).env_clear();
    for (name, value) in &config.env {
        command.env(name, value);
    }
    if let Some(cwd) = &config.cwd {
        command.current_dir(cwd);
    }
    let bin = config.bin.clone();
    let (term_after, kill_after) = (config.term_after, config.kill_after);
    let (line_high, line_low) = (config.line_high, config.line_low);

    let pump = async move {
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let errno = error.raw_os_error().unwrap_or(0);
                let code = errno_name(errno);
                let message = format!("spawn {bin} {code}");
                on_event(CliEvent::Exit(CliExit { code: None, signal: None, error: Some(CliSpawnError { code, errno: -errno, message }) }));
                return;
            }
        };
        let pid = child.id().expect("방금 띄운 자식의 pid");
        let stdout = child.stdout.take().expect("stdout은 piped다");
        let stderr = child.stderr.take().expect("stderr은 piped다");
        let mut stdin = child.stdin.take().expect("stdin은 piped다");

        // 쓰기 작업: 송신자가 모두 drop되면(입력 닫기·핸들 drop) 남은 쓰기를 다 쓰고 끝나며 stdin이 닫힌다. 자식이 먼저 닫으면(EPIPE) 남은 입력을 버린다
        let writer = tokio::spawn(async move {
            while let Some(data) = stdin_rx.recv().await {
                if stdin.write_all(&data).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        let io = async {
            tokio::join!(read_lines(stdout, on_event.clone(), backpressure_for_pump.clone(), line_high, line_low), read_stderr(stderr, stderr_for_pump));
        };
        tokio::pin!(io);

        let mut status: Option<CliExit> = None;
        let mut io_done = false;
        let mut control_open = true;
        let mut term_at: Option<Instant> = None;
        let mut kill_at: Option<Instant> = None;
        let mut term_sent = false;

        // 거두지 않은 자식에게만 신호를 보낸다. try_wait가 이미 끝났다고 하면(거두었으면) 보내지 않고 그 상태를 받아 둔다.
        // 확인과 보내기 사이에 await가 없어 그 사이에 pid가 거두어질 수 없다
        macro_rules! send_to_live_child {
            ($signal:expr) => {
                match child.try_wait() {
                    Ok(None) => {
                        signaler(pid, $signal);
                        true
                    }
                    Ok(Some(done)) => {
                        status = Some(exit_of(Ok(done)));
                        false
                    }
                    Err(_) => false,
                }
            };
        }

        loop {
            if status.is_some() && io_done {
                break;
            }
            if status.is_some() && !backpressure_for_pump.released.swap(true, Ordering::AcqRel) {
                // 자식이 끝났다: 소비를 기다리지 않고 남은 출력을 비운다(Node의 flushStdio)
                backpressure_for_pump.wake.notify_one();
            }
            tokio::select! {
                // 먼저 거둔다: 끝난 자식이 있으면 타이머·명령보다 앞서 알아야 거둔 pid에 신호를 보내지 않는다
                biased;
                done = child.wait(), if status.is_none() => {
                    status = Some(exit_of(done));
                }
                _ = &mut io, if !io_done => {
                    io_done = true;
                }
                command = control_rx.recv(), if control_open => {
                    match command {
                        None => control_open = false,
                        Some((mode, at)) => {
                            if status.is_none() && !term_sent {
                                match mode {
                                    StopMode::Now => {
                                        term_at = None;
                                        term_sent = true;
                                        if send_to_live_child!(CliSignal::Term) {
                                            kill_at = Some(Instant::now() + kill_after);
                                        }
                                    }
                                    StopMode::Graceful => {
                                        term_at.get_or_insert(at + term_after);
                                    }
                                }
                            }
                        }
                    }
                }
                _ = tokio::time::sleep_until(term_at.unwrap_or_else(Instant::now)), if term_at.is_some() && !term_sent => {
                    term_at = None;
                    term_sent = true;
                    if status.is_none() && send_to_live_child!(CliSignal::Term) {
                        kill_at = Some(Instant::now() + kill_after);
                    }
                }
                _ = tokio::time::sleep_until(kill_at.unwrap_or_else(Instant::now)), if kill_at.is_some() => {
                    kill_at = None;
                    if status.is_none() {
                        send_to_live_child!(CliSignal::Kill);
                    }
                }
            }
        }
        writer.abort();
        on_event(CliEvent::Exit(status.unwrap_or(CliExit { code: None, signal: None, error: None })));
    };

    (CliHandle { stdin: Mutex::new(Some(stdin_tx)), control: control_tx, stderr: stderr_tail, backpressure }, pump)
}

/// 표준 출력을 읽어 줄을 낸다. 한 번 읽은 덩어리에서 나온 줄은 한 사건으로 묶는다
async fn read_lines(mut reader: impl AsyncRead + Unpin, on_event: OnCliEvent, backpressure: Arc<Backpressure>, high: usize, low: usize) {
    let mut lines = LineReader::new();
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        backpressure.wait_for_room(high, low).await;
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let found = lines.write(&buffer[..n]);
                if !found.is_empty() {
                    backpressure.pending.fetch_add(found.len(), Ordering::AcqRel);
                    on_event(CliEvent::Lines(found));
                }
            }
        }
    }
    let rest = lines.finish();
    if !rest.is_empty() {
        backpressure.pending.fetch_add(rest.len(), Ordering::AcqRel);
        on_event(CliEvent::Lines(rest));
    }
}

async fn read_stderr(mut reader: impl AsyncRead + Unpin, tail: Arc<Mutex<StderrTail>>) {
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => tail.lock().expect("stderr 잠금").write(&buffer[..n]),
        }
    }
    tail.lock().expect("stderr 잠금").finish();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // ── 순수 부분: UTF-8 디코더(Node StringDecoder), 줄 나누기(Node readline), 표준 오류 끝부분 ──

    fn decode_all(chunks: &[&[u8]]) -> String {
        let mut decoder = Utf8Decoder::new();
        chunks.iter().map(|chunk| decoder.write(chunk)).collect()
    }

    #[test]
    fn decoder_joins_multibyte_char_split_across_chunks() {
        let han = "한".as_bytes();
        assert_eq!(decode_all(&[&han[..1], &han[1..2], &han[2..]]), "한");
        let face = "😀".as_bytes();
        assert_eq!(decode_all(&[&face[..3], &face[3..]]), "😀");
    }

    #[test]
    fn decoder_replaces_broken_bytes_with_fffd() {
        assert_eq!(decode_all(&[&[0x61, 0xff, 0x62]]), "a\u{fffd}b");
        // 이어져야 할 자리에 연속 바이트가 아닌 바이트가 오면 끊고 그 바이트부터 새 글자로 본다
        assert_eq!(decode_all(&[&[0xe2, 0x82], &[0x41]]), "\u{fffd}A");
        // E0 뒤의 80은 허용 범위 밖이라 한 글자로 합쳐지지 않는다
        assert_eq!(decode_all(&[&[0xe0, 0x80, 0x80]]), "\u{fffd}\u{fffd}\u{fffd}");
    }

    #[test]
    fn decoder_holds_incomplete_tail_and_end_flushes_one_fffd() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.write(&[0x41, 0xe2, 0x82]), "A");
        assert_eq!(decoder.end(), "\u{fffd}");
        assert_eq!(decoder.end(), "");
    }

    fn split_all(chunks: &[&str]) -> Vec<String> {
        let mut splitter = LineSplitter::new();
        let mut lines = Vec::new();
        for chunk in chunks {
            splitter.write(chunk, &mut lines);
        }
        splitter.finish(&mut lines);
        lines
    }

    #[test]
    fn splitter_treats_crlf_lf_and_lone_cr_as_line_ends() {
        assert_eq!(split_all(&["a\r\nb\nc\rd\n"]), ["a", "b", "c", "d"]);
    }

    #[test]
    fn splitter_joins_cr_and_lf_across_chunks_into_one_end() {
        assert_eq!(split_all(&["a\r", "\nb\n"]), ["a", "b"]);
        assert_eq!(split_all(&["a\r", "\n\nb\n"]), ["a", "", "b"]);
        assert_eq!(split_all(&["a\r", "\r\nb"]), ["a", "", "b"]);
    }

    #[test]
    fn splitter_does_not_split_on_other_unicode_line_breaks() {
        // readline은 \r·\n만 줄 끝으로 본다(VT·FF·U+0085·U+2028·U+2029는 줄 안의 글자다)
        assert_eq!(split_all(&["a\u{b}b\u{c}c\u{85}d\u{2028}e\u{2029}f\n"]), ["a\u{b}b\u{c}c\u{85}d\u{2028}e\u{2029}f"]);
    }

    #[test]
    fn splitter_keeps_lone_cr_chunk_and_empty_lines() {
        assert_eq!(split_all(&["\r", "\r", "\n"]), ["", ""]);
        assert_eq!(split_all(&["\n\n"]), ["", ""]);
    }

    #[test]
    fn splitter_emits_last_line_without_newline_but_not_an_empty_rest() {
        assert_eq!(split_all(&["a\nb"]), ["a", "b"]);
        assert_eq!(split_all(&["a\n"]), ["a"]);
        assert_eq!(split_all(&["ab", "cd", "\nef"]), ["abcd", "ef"]);
    }

    #[test]
    fn line_reader_drops_incomplete_utf8_at_eof_like_readline() {
        let mut reader = LineReader::new();
        let mut lines = reader.write(&[b'a', b'\n', b'b', 0xe2, 0x82]);
        lines.extend(reader.finish());
        assert_eq!(lines, ["a", "b"]);
    }

    #[test]
    fn stderr_tail_keeps_last_2000_utf16_units_and_may_cut_a_pair() {
        let mut tail = StderrTail::new();
        tail.write("😀".as_bytes());
        tail.write("x".repeat(1998).as_bytes());
        let units = tail.units();
        assert_eq!(units.len(), 2000);
        assert_eq!(&units[..2], &[0xd83d, 0xde00]);
        tail.write(b"y");
        let units = tail.units();
        assert_eq!(units.len(), 2000);
        // 쌍이 2000 경계에 걸리면 짝 없는 뒤 절반이 맨 앞에 남는다(UTF-16 단위로 자르는 옛 동작)
        assert_eq!(units[0], 0xde00);
        assert_eq!(units[1999], u16::from(b'y'));
    }

    #[test]
    fn stderr_tail_flushes_incomplete_char_at_end() {
        let mut tail = StderrTail::new();
        tail.write(&[b'e', 0xe2, 0x82]);
        assert_eq!(tail.units(), vec![u16::from(b'e')]);
        tail.finish();
        assert_eq!(tail.units(), vec![u16::from(b'e'), 0xfffd]);
    }

    // ── 프로세스 ──

    #[derive(Default)]
    struct Recorder {
        lines: Vec<String>,
        exits: Vec<CliExit>,
        order: Vec<&'static str>,
    }

    fn collector() -> (OnCliEvent, Arc<Mutex<Recorder>>) {
        let recorder = Arc::new(Mutex::new(Recorder::default()));
        let sink = recorder.clone();
        let on_event: OnCliEvent = Arc::new(move |event| {
            let mut recorder = sink.lock().unwrap();
            match event {
                CliEvent::Lines(lines) => {
                    recorder.order.push("lines");
                    recorder.lines.extend(lines);
                }
                CliEvent::Exit(exit) => {
                    recorder.order.push("exit");
                    recorder.exits.push(exit);
                }
            }
        });
        (on_event, recorder)
    }

    fn config(script: &str) -> CliConfig {
        CliConfig {
            bin: "sh".to_owned(),
            args: vec!["-c".to_owned(), script.to_owned()],
            env: vec![("PATH".to_owned(), std::env::var("PATH").unwrap())],
            cwd: None,
            term_after: Duration::from_secs(30),
            kill_after: Duration::from_secs(30),
            line_high: LINE_HIGH,
            line_low: LINE_LOW,
        }
    }

    /// 신호를 기록하고 실제로도 보낸다
    #[derive(Default, Clone)]
    struct Signals(Arc<Mutex<Vec<(u32, CliSignal)>>>);
    impl Signals {
        fn signaler(&self) -> Signaler {
            let log = self.0.clone();
            Arc::new(move |pid, signal| {
                log.lock().unwrap().push((pid, signal));
                os_signal(pid, signal);
            })
        }
        fn log(&self) -> Vec<(u32, CliSignal)> {
            self.0.lock().unwrap().clone()
        }
    }

    async fn run(config: CliConfig, drive: impl FnOnce(&CliHandle)) -> (CliExit, Recorder) {
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli(config, on_event);
        drive(&handle);
        tokio::time::timeout(Duration::from_secs(20), pump).await.expect("프로세스가 끝나야 한다");
        let mut recorder = std::mem::take(&mut *recorder.lock().unwrap());
        let exit = recorder.exits.pop().expect("끝 사건이 한 번 온다");
        assert!(recorder.exits.is_empty());
        (exit, recorder)
    }

    #[tokio::test]
    async fn lines_come_in_order_and_exit_comes_last_once() {
        let (exit, recorder) = run(config("printf 'a\\r\\nb\\nc\\rd'; sleep 0.05; printf 'e\\n'; exit 3"), |_| {}).await;
        assert_eq!(recorder.lines, ["a", "b", "c", "de"]);
        assert_eq!(exit.code, Some(3));
        assert_eq!(exit.signal, None);
        assert!(exit.error.is_none());
        assert_eq!(recorder.order.last(), Some(&"exit"));
    }

    #[tokio::test]
    async fn stdin_lines_reach_child_in_order_and_close_input_ends_it() {
        let (exit, recorder) = run(config("cat"), |handle| {
            handle.write_line("첫째".to_owned());
            handle.write_line("둘째".to_owned());
            handle.close_input();
            handle.write_line("버림".to_owned());
        })
        .await;
        assert_eq!(recorder.lines, ["첫째", "둘째"]);
        assert_eq!(exit.code, Some(0));
    }

    #[tokio::test]
    async fn child_closing_stdin_first_does_not_break_us() {
        // 자식이 입력을 닫고 곧 끝난다. 그동안 큰 쓰기를 이어 한다(EPIPE)
        let (exit, _) = run(config("exec 0<&-; sleep 0.1; exit 0"), |handle| {
            for _ in 0..200 {
                handle.write_line("x".repeat(64 * 1024));
            }
        })
        .await;
        assert_eq!(exit.code, Some(0));
    }

    #[tokio::test]
    async fn signal_death_reports_name_and_no_code() {
        let (exit, _) = run(config("kill -TERM $$"), |_| {}).await;
        assert_eq!((exit.code, exit.signal), (None, Some("SIGTERM".to_owned())));
        let (exit, _) = run(config("kill -KILL $$"), |_| {}).await;
        assert_eq!(exit.signal, Some("SIGKILL".to_owned()));
    }

    #[tokio::test]
    async fn stderr_is_kept_and_readable_after_exit() {
        let (on_event, _) = collector();
        let (handle, pump) = spawn_cli(config("printf 'oops' 1>&2; exit 1"), on_event);
        pump.await;
        assert_eq!(handle.stderr_tail(), "oops".encode_utf16().collect::<Vec<u16>>());
    }

    #[tokio::test]
    async fn spawn_failure_reports_error_and_no_code_or_signal() {
        let mut bad = config("");
        bad.bin = "/nonexistent/bstudio-bin".to_owned();
        let (exit, recorder) = run(bad, |handle| {
            handle.write_line("버림".to_owned());
            handle.stop(StopMode::Now);
        })
        .await;
        assert_eq!((exit.code, exit.signal.clone()), (None, None));
        let error = exit.error.expect("띄우기 실패는 오류를 싣는다");
        assert_eq!(error.code, "ENOENT");
        assert_eq!(error.message, "spawn /nonexistent/bstudio-bin ENOENT");
        assert!(recorder.lines.is_empty());
    }

    #[tokio::test]
    async fn env_is_replaced_and_cwd_applies() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config("printf '%s\\n' \"$MARK\" \"${HOME-unset}\"; pwd");
        cfg.env.push(("MARK".to_owned(), "m1".to_owned()));
        cfg.cwd = Some(dir.path().to_str().unwrap().to_owned());
        let (_, recorder) = run(cfg, |_| {}).await;
        assert_eq!(&recorder.lines[..2], ["m1", "unset"]);
        assert!(recorder.lines[2].ends_with(dir.path().file_name().unwrap().to_str().unwrap()));
    }

    /// 돌리는 작업을 곧바로 런타임에 올린다(자식이 도는 동안 시험이 다른 일을 할 수 있게). 기다리면 끝난다
    fn start(pump: impl Future<Output = ()> + Send + 'static) -> impl Future<Output = ()> {
        let join = tokio::spawn(pump);
        async move { tokio::time::timeout(Duration::from_secs(10), join).await.expect("프로세스가 끝나야 한다").unwrap() }
    }

    // 신호를 무시하는 자식: SIGTERM을 받아도 계속 돈다
    // (시험이 실패해도 자식이 남지 않게 십 초쯤 뒤 스스로 끝난다)
    const STUBBORN: &str = "trap '' TERM; echo $$; i=0; while [ $i -lt 400 ]; do sleep 0.02; i=$((i+1)); done";

    async fn pid_of(recorder: &Mutex<Recorder>) -> u32 {
        for _ in 0..200 {
            if let Some(line) = recorder.lock().unwrap().lines.first() {
                return line.parse().unwrap();
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("자식이 pid를 내지 않았다");
    }

    #[tokio::test]
    async fn graceful_closes_input_then_term_then_kill_on_schedule() {
        let signals = Signals::default();
        let mut cfg = config(STUBBORN);
        cfg.term_after = Duration::from_millis(300);
        cfg.kill_after = Duration::from_millis(300);
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli_with(cfg, on_event, signals.signaler());
        let pump = start(pump);
        let pid = pid_of(&recorder).await;
        let started = Instant::now();
        handle.stop(StopMode::Graceful);
        assert!(signals.log().is_empty(), "termAfter 전에는 신호가 없다");
        pump.await;
        let elapsed = started.elapsed();
        let exit = recorder.lock().unwrap().exits.pop().unwrap();
        assert_eq!(exit.signal, Some("SIGKILL".to_owned()));
        assert_eq!(signals.log(), vec![(pid, CliSignal::Term), (pid, CliSignal::Kill)]);
        assert!(elapsed >= Duration::from_millis(600), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
    }

    #[tokio::test]
    async fn now_sends_term_immediately_and_kill_after_kill_after() {
        let signals = Signals::default();
        let mut cfg = config(STUBBORN);
        cfg.term_after = Duration::from_secs(60);
        cfg.kill_after = Duration::from_millis(300);
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli_with(cfg, on_event, signals.signaler());
        let pump = start(pump);
        let pid = pid_of(&recorder).await;
        let started = Instant::now();
        handle.stop(StopMode::Now);
        pump.await;
        let elapsed = started.elapsed();
        assert_eq!(signals.log(), vec![(pid, CliSignal::Term), (pid, CliSignal::Kill)]);
        assert!(elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(5), "{elapsed:?}");
    }

    #[tokio::test]
    async fn now_pulls_in_a_pending_graceful_timer() {
        let signals = Signals::default();
        let mut cfg = config("echo $$; exec sleep 20");
        cfg.term_after = Duration::from_secs(60);
        cfg.kill_after = Duration::from_secs(60);
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli_with(cfg, on_event, signals.signaler());
        let pump = start(pump);
        pid_of(&recorder).await;
        handle.stop(StopMode::Graceful);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(signals.log().is_empty());
        let started = Instant::now();
        handle.stop(StopMode::Now);
        pump.await;
        assert!(started.elapsed() < Duration::from_secs(5));
        let exit = recorder.lock().unwrap().exits.pop().unwrap();
        assert_eq!(exit.signal, Some("SIGTERM".to_owned()));
        assert_eq!(signals.log().iter().map(|(_, s)| *s).collect::<Vec<_>>(), vec![CliSignal::Term]);
    }

    #[tokio::test]
    async fn term_is_not_sent_twice_and_kill_timer_is_not_reset() {
        let signals = Signals::default();
        let mut cfg = config(STUBBORN);
        cfg.kill_after = Duration::from_millis(400);
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli_with(cfg, on_event, signals.signaler());
        let pump = start(pump);
        pid_of(&recorder).await;
        handle.stop(StopMode::Now);
        for _ in 0..5 {
            tokio::time::sleep(Duration::from_millis(30)).await;
            handle.stop(StopMode::Now);
            handle.stop(StopMode::Graceful);
        }
        pump.await;
        let log = signals.log();
        assert_eq!(log.iter().filter(|(_, s)| *s == CliSignal::Term).count(), 1, "{log:?}");
        assert_eq!(log.iter().filter(|(_, s)| *s == CliSignal::Kill).count(), 1, "{log:?}");
    }

    #[tokio::test]
    async fn graceful_for_a_child_that_ends_on_eof_sends_no_signal() {
        let signals = Signals::default();
        let mut cfg = config("cat");
        cfg.term_after = Duration::from_millis(500);
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli_with(cfg, on_event, signals.signaler());
        let pump = start(pump);
        handle.write_line("마지막".to_owned());
        handle.stop(StopMode::Graceful);
        pump.await;
        let recorder = recorder.lock().unwrap();
        assert_eq!(recorder.lines, ["마지막"]);
        assert_eq!(recorder.exits[0].code, Some(0));
        assert!(signals.log().is_empty());
    }

    #[tokio::test]
    async fn no_signal_after_the_child_is_reaped_even_while_pipes_stay_open() {
        // 자식은 손자(sleep)에게 출력 파이프를 물려 주고 먼저 끝난다: 자식은 거뒀지만 출력은 아직 열려 있다.
        // 이때 stop이 와도 신호를 보내지 않는다(PID 재사용). 신호는 자기가 띄운 프로세스의 pid에만 간다
        let signals = Signals::default();
        let mut cfg = config("sleep 20 & echo $!; exit 0");
        cfg.term_after = Duration::from_millis(100);
        cfg.kill_after = Duration::from_millis(100);
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli_with(cfg, on_event, signals.signaler());
        let pump = start(pump);
        let grandchild = pid_of(&recorder).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        handle.stop(StopMode::Now);
        handle.stop(StopMode::Graceful);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let sent = signals.log();
        // 시험이 띄운 손자는 시험이 직접 끈다(기록해 둔 pid만)
        os_signal(grandchild, CliSignal::Kill);
        pump.await;
        assert!(sent.is_empty(), "거둔 자식에게 신호를 보냈다: {sent:?}");
        assert_eq!(recorder.lock().unwrap().exits[0].code, Some(0));
    }

    #[tokio::test]
    async fn stop_after_exit_and_dropped_handle_are_harmless() {
        let signals = Signals::default();
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli_with(config("echo hi"), on_event, signals.signaler());
        let pump = start(pump);
        pump.await;
        handle.stop(StopMode::Now);
        handle.stop(StopMode::Graceful);
        handle.close_input();
        drop(handle);
        assert!(signals.log().is_empty());
        assert_eq!(recorder.lock().unwrap().lines, ["hi"]);
    }


    // ── 표준 출력 백프레셔: 소비하지 않은 줄이 상한을 넘으면 읽기를 멈춰 자식이 쓰기에서 멈춘다(옛 readline 비동기 반복자의 highWaterMark 1024와 같은 성질) ──

    fn temp_marker() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("written").to_str().unwrap().to_owned();
        (dir, marker)
    }

    /// 받은 줄 수만큼 소비를 알리는 소비자
    fn consume_all(handle: Arc<CliHandle>, recorder: Arc<Mutex<Recorder>>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut reported = 0;
            loop {
                let seen = recorder.lock().unwrap().lines.len();
                if seen > reported {
                    handle.consumed(seen - reported);
                    reported = seen;
                }
                if !recorder.lock().unwrap().exits.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
    }

    #[tokio::test]
    async fn child_blocks_while_lines_are_not_consumed_and_finishes_after_they_are() {
        let (_dir, marker) = temp_marker();
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli(config(&format!("seq 1 200000; echo done > {marker}")), on_event);
        let handle = Arc::new(handle);
        let pump = start(pump);
        // 소비하지 않는 동안 자식은 쓰기에서 막혀 있다
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(!std::path::Path::new(&marker).exists(), "소비하지 않았는데 자식이 다 썼다");
        let received = recorder.lock().unwrap().lines.len();
        assert!(received < 20_000, "상한 없이 읽었다: {received}줄");
        // 소비하면 끝까지 간다
        let consumer = consume_all(handle.clone(), recorder.clone());
        pump.await;
        consumer.await.unwrap();
        assert!(std::path::Path::new(&marker).exists());
        let recorder = recorder.lock().unwrap();
        assert_eq!(recorder.lines.len(), 200_000);
        assert!(recorder.lines.iter().enumerate().all(|(i, line)| *line == (i + 1).to_string()));
    }

    #[tokio::test]
    async fn read_pauses_at_high_and_resumes_below_low() {
        let (on_event, recorder) = collector();
        let mut cfg = config("seq 1 100000");
        cfg.line_high = 100;
        cfg.line_low = 10;
        let (handle, pump) = spawn_cli(cfg, on_event);
        let handle = Arc::new(handle);
        let pump = start(pump);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let first = recorder.lock().unwrap().lines.len();
        assert!((100..=20_000).contains(&first), "{first}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(recorder.lock().unwrap().lines.len(), first, "멈춘 동안 더 읽었다");
        // 상한 아래로 내려도 low 위면 다시 읽지 않는다
        handle.consumed(first - 50);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(recorder.lock().unwrap().lines.len(), first, "low 위에서 다시 읽었다");
        // low 아래로 내려가면 다시 읽는다
        handle.consumed(50);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(recorder.lock().unwrap().lines.len() > first);
        let consumer = consume_all(handle.clone(), recorder.clone());
        pump.await;
        consumer.await.unwrap();
        assert_eq!(recorder.lock().unwrap().lines.len(), 100_000);
    }

    #[tokio::test]
    async fn killed_child_does_not_wait_for_consumption_to_report_exit() {
        // 소비자가 없어 막힌 자식을 끝내도 끝 사건이 온다(옛 구현은 자식이 끝나면 남은 출력을 비워 close가 왔다)
        let signals = Signals::default();
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli_with(config("seq 1 2000000"), on_event, signals.signaler());
        let pump = start(pump);
        tokio::time::sleep(Duration::from_millis(500)).await;
        handle.stop(StopMode::Now);
        pump.await;
        let recorder = recorder.lock().unwrap();
        assert_eq!(recorder.exits.len(), 1);
        assert_eq!(recorder.exits[0].signal, Some("SIGTERM".to_owned()));
    }

    #[tokio::test]
    async fn one_huge_line_is_received_whole_even_above_the_limit() {
        let (on_event, recorder) = collector();
        let mut cfg = config("head -c 3000000 /dev/zero | tr '\\0' 'x'; echo; echo after");
        cfg.line_high = 1;
        cfg.line_low = 0;
        let (handle, pump) = spawn_cli(cfg, on_event);
        let handle = Arc::new(handle);
        let pump = start(pump);
        let consumer = consume_all(handle, recorder.clone());
        pump.await;
        consumer.await.unwrap();
        let recorder = recorder.lock().unwrap();
        assert_eq!(recorder.lines.len(), 2);
        assert_eq!(recorder.lines[0].len(), 3_000_000);
    }

    #[tokio::test]
    async fn very_long_line_and_many_lines_arrive_whole() {
        let (on_event, recorder) = collector();
        let (handle, pump) = spawn_cli(config("head -c 5000000 /dev/zero | tr '\\0' 'x'; echo; seq 1 30000"), on_event);
        let pump = start(pump);
        let consumer = consume_all(Arc::new(handle), recorder.clone());
        pump.await;
        consumer.await.unwrap();
        let recorder = recorder.lock().unwrap();
        assert_eq!(recorder.exits[0].code, Some(0));
        assert_eq!(recorder.lines.len(), 30001);
        assert_eq!(recorder.lines[0].len(), 5_000_000);
        assert_eq!(recorder.lines[30000], "30000");
    }
}
