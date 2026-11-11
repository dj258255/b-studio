//! b-studio 앞단 실행 파일(ADR-195 4a). 공개 포트를 열고, Node 서버를 유닉스 소켓의 자식으로 띄워 모든 요청을 넘긴다
use std::path::{Path, PathBuf};
use std::process::{ExitCode, Stdio};
use std::time::{Duration, Instant};

use bstudio_server::{cli, proxy, runtime};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::signal::unix::{signal, SignalKind};

/// 앞단의 로그는 Node 로그와 같은 파일에 앞머리를 붙여 쓴다
fn log(message: &str) {
    eprintln!("[b-studio 앞단] {message}");
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(message) => {
            log(&message);
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<ExitCode, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = cli::parse(&args, &|key| std::env::var(key).ok())?;

    // 1. 소켓 준비(Node를 띄우기 전에 모두 확인한다). 경로 길이는 폴더를 만들기 전에 본다
    let mut node: Option<Child> = None;
    let socket: PathBuf = match &config.upstream_socket {
        Some(socket) => socket.clone(),
        None => {
            let socket = runtime::socket_path_in(&config.run_dir, &format!("studio-{}.sock", std::process::id())).map_err(|e| e.to_string())?;
            runtime::prepare_run_dir(&config.run_dir).map_err(|e| e.to_string())?;
            runtime::clear_stale_socket(&socket).map_err(|e| e.to_string())?;
            // 2. Node를 띄운다. 같은 프로세스 그룹에 두어 `studio stop`이 그룹에 보낸 신호가 함께 닿는다
            let (program, rest) = config.node_command.split_first().ok_or("Node를 띄울 명령이 없습니다")?;
            let child = Command::new(program)
                .args(rest)
                .arg("--socket")
                .arg(&socket)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .map_err(|error| format!("Node를 띄우지 못했습니다({program}): {error}"))?;
            node = Some(child);
            socket
        }
    };

    let mut sigterm = signal(SignalKind::terminate()).map_err(|e| format!("SIGTERM 처리를 켜지 못했습니다: {e}"))?;
    let mut sigint = signal(SignalKind::interrupt()).map_err(|e| format!("SIGINT 처리를 켜지 못했습니다: {e}"))?;

    // 3. Node가 /api/health에 200을 줄 때까지 기다린 뒤에야 공개 포트를 연다
    if let Err(message) = wait_ready(&socket, node.as_mut(), config.ready_timeout).await {
        if let Some(child) = node.as_mut() {
            stop_node(child).await;
        }
        cleanup_socket(&socket, node.is_some());
        return Err(message);
    }

    let listener = match TcpListener::bind((config.hostname.as_str(), config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            if let Some(child) = node.as_mut() {
                stop_node(child).await;
            }
            cleanup_socket(&socket, node.is_some());
            return Err(format!("공개 포트를 열지 못했습니다({}:{}): {error}", config.hostname, config.port));
        }
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // launch는 /api/health로 따로 보지만, main.ts처럼 주소 한 줄을 찍는다
    println!("b-studio 서버가 떴습니다: http://{}:{}", config.hostname, port);

    let (stop_serving, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(proxy::serve(listener, proxy::router(socket.clone()), async {
        let _ = stopped.await;
    }));

    // 4. 신호를 받으면 Node에 넘기고 기다렸다 끝낸다. Node가 먼저 끝나면 앞단도 0이 아닌 코드로 끝난다
    let code = tokio::select! {
        _ = sigterm.recv() => shutdown(&mut node, "SIGTERM").await,
        _ = sigint.recv() => shutdown(&mut node, "SIGINT").await,
        status = wait_node(&mut node) => {
            let code = status.and_then(|s| s.code()).filter(|c| *c != 0).unwrap_or(1);
            // 같은 그룹에 보낸 종료 신호로 Node가 먼저 끝났을 수 있다. 곧 신호가 오면 정상 종료로 본다
            let signaled = tokio::select! {
                _ = sigterm.recv() => true,
                _ = sigint.recv() => true,
                _ = tokio::time::sleep(Duration::from_millis(300)) => false,
            };
            if signaled {
                log("종료 신호를 받아 닫습니다(Node가 먼저 끝났습니다)");
                ExitCode::SUCCESS
            } else {
                log(&format!("Node 서버가 끝났습니다(코드 {code}). 앞단도 끝냅니다"));
                ExitCode::from(u8::try_from(code).unwrap_or(1))
            }
        }
    };
    let _ = stop_serving.send(());
    server.abort();
    cleanup_socket(&socket, config.upstream_socket.is_none());
    Ok(code)
}

async fn wait_node(node: &mut Option<Child>) -> Option<std::process::ExitStatus> {
    match node {
        Some(child) => child.wait().await.ok(),
        // 시험용 붙이기 모드: Node가 없으니 끝나지 않는다
        None => std::future::pending().await,
    }
}

async fn shutdown(node: &mut Option<Child>, signal_name: &str) -> ExitCode {
    log(&format!("{signal_name} 신호를 받아 Node 서버를 닫습니다"));
    if let Some(child) = node.as_mut() {
        stop_node(child).await;
    }
    ExitCode::SUCCESS
}

/// Node에 SIGTERM을 보내고 기다린다. 5초 안에 안 끝나면 강제로 끝낸다(자기가 띄운 자식만)
async fn stop_node(child: &mut Child) {
    if let Some(pid) = child.id() {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

fn cleanup_socket(socket: &Path, ours: bool) {
    if ours {
        // 내가 만든 소켓 이름이다. 소켓일 때만 지운다
        let _ = runtime::clear_stale_socket(socket);
    }
}

/// `/api/health`가 200이 될 때까지 기다린다. Node가 먼저 끝나거나 한도를 넘으면 오류
async fn wait_ready(socket: &Path, mut node: Option<&mut Child>, limit: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if let Some(child) = node.as_deref_mut() {
            if let Some(status) = child.try_wait().map_err(|e| format!("Node 상태를 보지 못했습니다: {e}"))? {
                return Err(format!("Node 서버가 준비되기 전에 끝났습니다({status})"));
            }
        }
        if probe_health(socket).await {
            return Ok(());
        }
        if started.elapsed() > limit {
            return Err(format!("Node 서버가 {}초 안에 /api/health에 200을 주지 않았습니다", limit.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn probe_health(socket: &Path) -> bool {
    let attempt = async {
        let stream = UnixStream::connect(socket).await.ok()?;
        let (mut sender, connection) = http1::handshake::<_, http_body_util::Empty<hyper::body::Bytes>>(TokioIo::new(stream)).await.ok()?;
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        let request = hyper::Request::get("/api/health").header("host", "localhost").body(http_body_util::Empty::new()).ok()?;
        let status = sender.send_request(request).await.ok().map(|response| response.status().as_u16());
        driver.abort();
        status
    };
    matches!(tokio::time::timeout(Duration::from_secs(2), attempt).await, Ok(Some(200)))
}
