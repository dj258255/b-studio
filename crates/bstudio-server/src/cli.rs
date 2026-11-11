use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    pub hostname: String,
    /// 소켓을 둘 폴더(권한 0700)
    pub run_dir: PathBuf,
    /// Node가 /api/health에 200을 줄 때까지 기다리는 한도
    pub ready_timeout: Duration,
    /// 시험용: Node를 띄우지 않고 이미 듣고 있는 이 소켓에 붙는다
    pub upstream_socket: Option<PathBuf>,
    /// Node를 띄우는 명령(`--` 뒤). 앞단이 `--socket <경로>`를 덧붙인다
    pub node_command: Vec<String>,
}

/// 인자 → 환경 변수(PORT·HOSTNAME) → 3000·127.0.0.1 차례다(apps/studio/server/main.ts의 serverAddress와 같다).
/// `--` 뒤는 Node를 띄우는 명령이다
pub fn parse(args: &[String], env: &dyn Fn(&str) -> Option<String>) -> Result<Config, String> {
    let (own, node_command) = match args.iter().position(|a| a == "--") {
        Some(at) => (&args[..at], args[at + 1..].to_vec()),
        None => (args, Vec::new()),
    };
    let mut port: Option<String> = None;
    let mut hostname: Option<String> = None;
    let mut run_dir: Option<PathBuf> = None;
    let mut ready_secs: Option<String> = None;
    let mut upstream_socket: Option<PathBuf> = None;
    let mut iter = own.iter();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| iter.next().cloned().ok_or_else(|| format!("{name} 값이 없습니다"));
        match arg.as_str() {
            "--port" | "-p" => port = Some(value(arg)?),
            "--hostname" | "-H" => hostname = Some(value(arg)?),
            "--run-dir" => run_dir = Some(PathBuf::from(value(arg)?)),
            "--ready-timeout-secs" => ready_secs = Some(value(arg)?),
            "--upstream-socket" => upstream_socket = Some(PathBuf::from(value(arg)?)),
            other => return Err(format!("알 수 없는 인자입니다: {other}")),
        }
    }

    let raw_port = port.or_else(|| env("PORT")).unwrap_or_else(|| "3000".to_string());
    let port: u16 = raw_port.parse().map_err(|_| format!("포트 값이 올바르지 않습니다: {raw_port}"))?;
    let hostname = hostname.or_else(|| env("HOSTNAME")).unwrap_or_else(|| "127.0.0.1".to_string());
    let ready_timeout = match ready_secs {
        None => Duration::from_secs(80),
        Some(raw) => Duration::from_secs(raw.parse().map_err(|_| format!("--ready-timeout-secs 값이 올바르지 않습니다: {raw}"))?),
    };
    let run_dir = match run_dir {
        Some(dir) => dir,
        None => {
            match env("HOME").filter(|h| !h.is_empty()) {
                Some(home) => PathBuf::from(home).join(".cache/b-studio/launch/run"),
                // 시험용 붙이기 모드는 소켓 폴더를 쓰지 않는다
                None if upstream_socket.is_some() => PathBuf::new(),
                None => return Err("소켓 폴더를 정할 수 없습니다: --run-dir도 HOME도 없습니다".to_string()),
            }
        }
    };
    if node_command.is_empty() && upstream_socket.is_none() {
        return Err("Node를 띄울 명령이 없습니다: `-- <명령> [인자...]`로 적으세요".to_string());
    }
    Ok(Config { port, hostname, run_dir, ready_timeout, upstream_socket, node_command })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn 기본값은_3000과_127_0_0_1() {
        let c = parse(&args(&["--", "node", "main.js"]), &|k| (k == "HOME").then(|| "/home/u".to_string())).unwrap();
        assert_eq!((c.port, c.hostname.as_str()), (3000, "127.0.0.1"));
        assert_eq!(c.run_dir, PathBuf::from("/home/u/.cache/b-studio/launch/run"));
        assert_eq!(c.node_command, vec!["node", "main.js"]);
    }

    #[test]
    fn 인자가_환경_변수보다_앞선다() {
        let env = |k: &str| match k {
            "PORT" => Some("4000".to_string()),
            "HOSTNAME" => Some("envhost".to_string()),
            "HOME" => Some("/h".to_string()),
            _ => None,
        };
        let c = parse(&args(&["--port", "5000", "-H", "argshost", "--", "n"]), &env).unwrap();
        assert_eq!((c.port, c.hostname.as_str()), (5000, "argshost"));
        let c = parse(&args(&["--", "n"]), &env).unwrap();
        assert_eq!((c.port, c.hostname.as_str()), (4000, "envhost"));
    }

    #[test]
    fn 잘못된_포트와_빠진_명령은_거절한다() {
        assert!(parse(&args(&["--port", "70000", "--", "n"]), &no_env).is_err());
        assert!(parse(&args(&["--port", "abc", "--", "n"]), &no_env).is_err());
        // Node 명령도 시험용 소켓도 없으면 띄울 것이 없다
        assert!(parse(&args(&["--run-dir", "/r"]), &no_env).is_err());
        assert!(parse(&args(&["--run-dir", "/r", "--upstream-socket", "/s"]), &no_env).is_ok());
        // 알 수 없는 인자는 조용히 넘기지 않는다
        assert!(parse(&args(&["--nope", "--", "n"]), &no_env).is_err());
    }

    #[test]
    fn 폴더_안_정하면_홈이_없을_때_거절한다() {
        assert!(parse(&args(&["--", "n"]), &no_env).is_err());
        assert!(parse(&args(&["--run-dir", "/r", "--", "n"]), &no_env).is_ok());
        assert!(parse(&args(&["--upstream-socket", "/s"]), &no_env).is_ok());
    }
}
