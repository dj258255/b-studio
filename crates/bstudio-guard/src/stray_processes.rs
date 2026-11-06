//! 서비스 컨테이너 안에서 PID 1과 세션이 다른 프로세스를 읽고 견준다(옛 TS: `packages/sandbox/src/docker/stray-processes.ts`).
//! 찾기 스크립트의 실행(`scanProcesses`)은 TS에 남는다.

use regex::Regex;
use std::sync::LazyLock;

use crate::js::{self, number_to_string, to_number};
use crate::js_json::{object, JsValue};

#[derive(Clone, Debug, PartialEq)]
pub struct ScannedProcess {
    pub pid: f64,
    /// 부팅 뒤 클록 틱. pid와 함께 프로세스를 가린다
    pub start: String,
    pub command: String,
}

impl ScannedProcess {
    pub fn to_value(&self) -> JsValue {
        object(vec![
            ("pid", Some(JsValue::Num(self.pid))),
            ("start", Some(JsValue::str(self.start.clone()))),
            ("command", Some(JsValue::str(self.command.clone()))),
        ])
    }
}

static SCAN_LINE: LazyLock<Regex> = LazyLock::new(|| {
    let dot = js::LINE_TERMINATORS;
    Regex::new(&format!(r"^([0-9]+) ([0-9]+) ?([^{dot}]*)$")).expect("프로세스 줄 정규식")
});

/// 찾기 스크립트 출력 한 줄에 "pid 시작시각 명령". 맞지 않는 줄은 건너뛰고 pid 순서로 돌려준다
pub fn parse_process_scan(stdout: &str) -> Vec<ScannedProcess> {
    let rows: Vec<ScannedProcess> = stdout
        .split('\n')
        .map(js::trim_end)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let caps = SCAN_LINE.captures(line)?;
            Some(ScannedProcess {
                pid: to_number(&caps[1]),
                start: caps[2].to_owned(),
                command: js::trim(&caps[3]).to_owned(),
            })
        })
        .collect();
    js::stable_sort_by(rows, &|a, b| a.pid - b.pid)
}

/// 기준선(서비스가 준비됐을 때의 목록)에 없던 프로세스의 인덱스. 기준선이 없으면 모두 모르는 것으로 본다
pub fn foreign_processes(now: &[(f64, String)], baseline: Option<&[(f64, String)]>) -> Vec<usize> {
    let key = |pid: f64, start: &str| format!("{}:{start}", number_to_string(pid));
    let known: Vec<String> = baseline
        .unwrap_or(&[])
        .iter()
        .map(|(pid, start)| key(*pid, start))
        .collect();
    now.iter()
        .enumerate()
        .filter(|(_, (pid, start))| !known.contains(&key(*pid, start)))
        .map(|(i, _)| i)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 찾기_출력을_pid_순서로_읽는다() {
        let out = "20 500 sleep 100  \n3 40\n  7 1 x\nnoise\n9 8 a\rb\n5 6 \n";
        let rows = parse_process_scan(out);
        assert_eq!(
            rows.iter().map(|r| r.pid).collect::<Vec<_>>(),
            vec![3.0, 5.0, 20.0]
        );
        assert_eq!(rows[2].command, "sleep 100");
        assert_eq!(rows[0].command, "");
        // 줄 가운데의 \r은 `.`이 받지 못해 그 줄은 버려진다
        assert!(rows.iter().all(|r| r.pid != 9.0));
    }

    #[test]
    fn 같은_pid라도_시작_시각이_다르면_모르는_프로세스다() {
        let now = vec![
            (1.0, "10".to_owned()),
            (2.0, "20".to_owned()),
            (2.0, "21".to_owned()),
        ];
        let base = vec![(1.0, "10".to_owned()), (2.0, "20".to_owned())];
        assert_eq!(foreign_processes(&now, Some(&base)), vec![2]);
        assert_eq!(foreign_processes(&now, None), vec![0, 1, 2]);
    }
}
