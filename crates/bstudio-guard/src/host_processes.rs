//! 호스트(도커 밖)에서 직접 뜬 프로세스를 읽는다: `lsof`·`ss`·`ps` 출력 해석과 Actuator 응답 분류
//! (옛 TS: `packages/sandbox/src/docker/host-processes.ts`). 네트워크 호출(`probeActuator`)은 TS에 남는다.

use regex::Regex;
use std::sync::LazyLock;

use crate::js::{self, parse_float, parse_int, split_ws, trailing_colon_digits};
use crate::js_json::{object, JsValue};

/// colima·Docker Desktop·VPN 등이 포트를 포워딩하느라 띄우는 프로세스. `/lima|ssh|vpnkit|com\.docker/i`는
/// ASCII 글자의 대소문자만 가리므로(JS `/i`는 비ASCII 글자를 ASCII로 접지 않는다) ASCII 소문자로 바꿔 찾는다
pub fn is_forwarder_process(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    ["lima", "ssh", "vpnkit", "com.docker"]
        .iter()
        .any(|word| lower.contains(word))
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListeningProcess {
    pub pid: f64,
    pub command: String,
    pub port: f64,
}

impl ListeningProcess {
    pub fn to_value(&self) -> JsValue {
        object(vec![
            ("pid", Some(JsValue::Num(self.pid))),
            ("command", Some(JsValue::str(self.command.clone()))),
            ("port", Some(JsValue::Num(self.port))),
        ])
    }
}

/// macOS `lsof -nP -iTCP -sTCP:LISTEN` 출력을 읽는다. 헤더 줄은 건너뛴다
pub fn parse_lsof_listening(output: &str) -> Vec<ListeningProcess> {
    let mut rows = Vec::new();
    for line in output.split('\n').skip(1) {
        let parts = split_ws(line);
        if parts.len() < 2 {
            continue;
        }
        let pid = parse_int(parts[1]);
        if !pid.is_finite() {
            continue;
        }
        let last = parts[parts.len() - 1];
        let name_field = if last == "(LISTEN)" {
            parts.len().checked_sub(2).map(|i| parts[i])
        } else {
            Some(last)
        };
        let port = parse_int(name_field.and_then(trailing_colon_digits).unwrap_or(""));
        if !port.is_finite() {
            continue;
        }
        rows.push(ListeningProcess {
            pid,
            command: parts[0].to_owned(),
            port,
        });
    }
    rows
}

/// `/pid=(\d+)/`의 첫 맞음
fn first_pid(rest: &str) -> Option<&str> {
    let mut from = 0;
    while let Some(at) = rest[from..].find("pid=") {
        let start = from + at + 4;
        let len = rest[start..].bytes().take_while(u8::is_ascii_digit).count();
        if len > 0 {
            return Some(&rest[start..start + len]);
        }
        from += at + 1;
    }
    None
}

/// `/\(\("([^"]+)"/`의 첫 맞음
fn first_command(rest: &str) -> Option<&str> {
    let mut from = 0;
    while let Some(at) = rest[from..].find("((\"") {
        let start = from + at + 3;
        let len = rest[start..].find('"').unwrap_or(rest.len() - start);
        if len > 0 && start + len < rest.len() {
            return Some(&rest[start..start + len]);
        }
        from += at + 1;
    }
    None
}

/// Linux `ss -ltnp` 출력을 읽는다. 형식: State Recv-Q Send-Q "Local Address:Port" "Peer Address:Port" Process
pub fn parse_ss_listening(output: &str) -> Vec<ListeningProcess> {
    let mut rows = Vec::new();
    for line in output.split('\n').skip(1) {
        let parts = split_ws(line);
        if parts.len() < 4 {
            continue;
        }
        let port = parse_int(trailing_colon_digits(parts[3]).unwrap_or(""));
        if !port.is_finite() {
            continue;
        }
        let rest = parts[4..].join(" ");
        let pid = parse_int(first_pid(&rest).unwrap_or(""));
        if !pid.is_finite() {
            continue;
        }
        let command = first_command(&rest).unwrap_or("").to_owned();
        rows.push(ListeningProcess { pid, command, port });
    }
    rows
}

/// 선언한 포트에서 듣는 프로세스만 남긴다(포워더·스튜디오 자신은 뺀다). 같은 포트는 먼저 나온 것만. 남길 행의 인덱스를 돌려준다
pub fn match_declared_ports(
    listening: &[ListeningProcess],
    declared_ports: &[f64],
    exclude_pids: &[f64],
) -> Vec<usize> {
    let has = |set: &[f64], x: f64| set.iter().any(|v| js::same_value_zero(*v, x));
    let mut seen: Vec<f64> = Vec::new();
    let mut result = Vec::new();
    for (i, row) in listening.iter().enumerate() {
        if !has(declared_ports, row.port)
            || has(exclude_pids, row.pid)
            || is_forwarder_process(&row.command)
            || has(&seen, row.port)
        {
            continue;
        }
        seen.push(row.port);
        result.push(i);
    }
    result
}

static PS_ROW: LazyLock<Regex> = LazyLock::new(|| {
    let (ws, dot) = (js::WS_CLASS, js::LINE_TERMINATORS);
    Regex::new(&format!(
        r"^[{ws}]*([0-9]+)[{ws}]+([0-9.]+)[{ws}]+([0-9]+)[{ws}]+([^{dot}]*)$"
    ))
    .expect("ps 정규식")
});

/// `ps -o pid,pcpu,rss,command= -p <pid>` 한 줄 출력을 읽는다(명령줄에 공백이 있어도 마지막 그룹으로 통째로 받는다)
pub fn parse_ps_row(output: &str) -> Option<JsValue> {
    let line = output.split('\n').find(|row| !js::trim(row).is_empty())?;
    let caps = PS_ROW.captures(line)?;
    Some(object(vec![
        ("pid", Some(JsValue::Num(parse_int(&caps[1])))),
        ("cpuPercent", Some(JsValue::Num(parse_float(&caps[2])))),
        ("rssKb", Some(JsValue::Num(parse_int(&caps[3])))),
        ("command", Some(JsValue::str(js::trim(&caps[4])))),
    ]))
}

const LOGFILE_GUIDANCE: &str =
    "Actuator는 연결됐지만 로그 파일이 없습니다. management.endpoints.web.exposure.include=health,logfile과 logging.file.name을 설정하면 최근 로그를 볼 수 있습니다";
const HEALTH_GUIDANCE: &str = "/actuator/health에 응답이 없습니다. 이 포트의 앱이 Spring Boot Actuator를 쓴다면 management.endpoints.web.exposure.include=health,logfile을 열어 두세요";

/// health·logfile 응답 상태만으로 보여 줄 문구를 정한다
pub fn classify_actuator_probe(health_ok: bool, logfile_status: Option<f64>) -> JsValue {
    if !health_ok {
        return object(vec![
            ("connected", Some(JsValue::Bool(false))),
            ("logfileAvailable", Some(JsValue::Bool(false))),
            ("guidance", Some(JsValue::str(HEALTH_GUIDANCE))),
        ]);
    }
    let available = logfile_status == Some(200.0) || logfile_status == Some(206.0);
    object(vec![
        ("connected", Some(JsValue::Bool(true))),
        ("logfileAvailable", Some(JsValue::Bool(available))),
        (
            "guidance",
            if available {
                None
            } else {
                Some(JsValue::str(LOGFILE_GUIDANCE))
            },
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 포워더는_ascii_대소문자만_가린다() {
        assert!(is_forwarder_process("SSH"));
        assert!(is_forwarder_process("Com.Docker.backend"));
        assert!(is_forwarder_process("colima-LIMA"));
        assert!(!is_forwarder_process("com_docker"));
        // 긴 s(ſ)와 켈빈 기호(K)는 JS /i에서 ASCII와 같지 않다
        assert!(!is_forwarder_process("\u{17F}\u{17F}h"));
        assert!(!is_forwarder_process(
            "lima".replace('l', "\u{FF2C}").as_str()
        ));
    }

    #[test]
    fn lsof_줄에서_pid와_포트를_읽는다() {
        let out = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 123 me 20u IPv6 0x1 0t0 TCP *:3000 (LISTEN)\nnode 124 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:8080\nbad x me 20u IPv4 0x1 0t0 TCP *:80 (LISTEN)\nshort\n\nnode 9 me TCP *:abc (LISTEN)\n(LISTEN)\nsolo (LISTEN)\n";
        let rows = parse_lsof_listening(out);
        assert_eq!(
            rows,
            vec![
                ListeningProcess {
                    pid: 123.0,
                    command: "node".into(),
                    port: 3000.0
                },
                ListeningProcess {
                    pid: 124.0,
                    command: "node".into(),
                    port: 8080.0
                },
            ]
        );
    }

    #[test]
    fn ss_줄에서_pid와_명령을_읽는다() {
        let out = "State Recv-Q Send-Q Local Peer Process\nLISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:((\"node\",pid=77,fd=19))\nLISTEN 0 128 [::]:80 [::]:* users:((\"x\",pid=pid=,fd=1),(\"y\",pid=5,fd=2))\nLISTEN 0 128 *:81 *:*\nLISTEN 0 128 *:82 *:* ((\"unterminated\n";
        let rows = parse_ss_listening(out);
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            ListeningProcess {
                pid: 77.0,
                command: "node".into(),
                port: 3000.0
            }
        );
        assert_eq!(rows[1].pid, 5.0);
        assert_eq!(rows[1].command, "x");
    }

    #[test]
    fn 선언한_포트만_남기고_같은_포트는_먼저_나온_것만() {
        let rows = vec![
            ListeningProcess {
                pid: 1.0,
                command: "ssh".into(),
                port: 80.0,
            },
            ListeningProcess {
                pid: 2.0,
                command: "node".into(),
                port: 80.0,
            },
            ListeningProcess {
                pid: 3.0,
                command: "node".into(),
                port: 80.0,
            },
            ListeningProcess {
                pid: 4.0,
                command: "node".into(),
                port: 81.0,
            },
            ListeningProcess {
                pid: 5.0,
                command: "node".into(),
                port: 82.0,
            },
        ];
        assert_eq!(match_declared_ports(&rows, &[80.0, 82.0], &[]), vec![1, 4]);
        assert_eq!(
            match_declared_ports(&rows, &[80.0, 82.0], &[2.0]),
            vec![2, 4]
        );
    }

    #[test]
    fn ps_줄은_줄_끝_글자에서_js_정규식처럼_끊긴다() {
        let row = parse_ps_row("\n  12  3.5  400 /usr/bin/node  server.js  \n").unwrap();
        assert_eq!(row.prop("pid"), Some(&JsValue::Num(12.0)));
        assert_eq!(row.prop("cpuPercent"), Some(&JsValue::Num(3.5)));
        assert_eq!(
            row.prop("command"),
            Some(&JsValue::str("/usr/bin/node  server.js"))
        );
        // 명령 안의 \r은 `.`이 받지 못해 줄 전체가 맞지 않는다
        assert!(parse_ps_row("1 2 3 cmd\rmore").is_none());
        // 끝의 \r은 공백(\s+)이 먹고 명령은 빈 문자열이 된다
        assert_eq!(
            parse_ps_row("1 2 3 \r").unwrap().prop("command"),
            Some(&JsValue::str(""))
        );
        assert!(parse_ps_row("1 2 3 cmd\r").is_none());
        assert!(parse_ps_row("   \n\n").is_none());
        assert!(parse_ps_row("x 2 3 c").is_none());
        let nan = parse_ps_row("1 . 3 c").unwrap();
        assert!(matches!(nan.prop("cpuPercent"), Some(JsValue::Num(n)) if n.is_nan()));
    }
}
