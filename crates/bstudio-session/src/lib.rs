//! 세션 하나의 이벤트 기록(ADR-203, 4f B1a). Node를 모르는 순수 크레이트다.
//!
//! 옛 구현은 `apps/studio/lib/server/sessions.ts`의 `history`·`logs` 배열과 `emit`의 버퍼 처리였다(`session-record-legacy.ts`가 차등 시험의 기준으로 남아 있다).
//! 같은 입력에 같은 결과를 낸다:
//! - `push`: 기록하지 않는 이벤트(`usage`·`sandbox_link`·`files_changed`·`tests_changed`·`deploy_log`·`label`)는 쌓지 않는다. `log`는 logs(상한 1,000)에,
//!   나머지는 history(상한 5,000)에 쌓고 넘치면 앞에서 자른다. 돌려주는 값은 "`updatedAt`을 바꾸고 저장을 예약할 것인가"(기록했고 `log`가 아닐 때 참)다
//! - 질의: 마지막 `run_started` 이벤트, 끝 n개, 전체 history·logs, 저장용으로 줄인 history(`trimHistory`와 같다)
//!
//! 이벤트는 TS가 `JSON.stringify`한 글자로 받아 **글자 그대로** 든다. `JSON.stringify`는 짝 없는 서로게이트를 `\ud800` 이스케이프로 쓰므로 글자 그대로 들고 있으면
//! 어떤 글자도 잃지 않는다(Rust `String`은 짝 없는 서로게이트를 담지 못해 값으로 파싱해 들면 U+FFFD로 바뀐다). 값으로 읽는 것은 `type`뿐이고,
//! 그 읽기는 `js_json`(`JSON.parse`의 문법)이 한다. 구독자·SSE·저장 스케줄러는 여기에 없다(TS 세션이 쥔다).
//!
//! 의도한 차이:
//! - 이벤트는 JSON 경계를 지난다. `undefined` 속성은 사라지고 `Date` 같은 값은 글자가 된다(저장·SSE도 같은 경계라 화면에 보이는 값은 같다). 유한하지 않은 수와 -0은 TS가 표시 객체로 보냈다가 되받을 때 되돌린다
//! - `tail(0)`은 빈 목록이다(옛 `slice(-0)`은 전체였다. 0을 넘기는 곳이 없다)
//! - 중첩이 `js_json`이 읽는 깊이를 넘는 이벤트는 `type`을 알 수 없어 보통 이벤트로 쌓는다. 그 안에 든 값은 그대로다

use bstudio_guard::js_json::{self, JsValue};
use std::collections::VecDeque;

mod close;
pub mod create;
mod json_text;
pub mod lifecycle;
pub mod persister;
pub mod registry;
mod scan;
pub mod status;
pub mod store;

pub const HISTORY_LIMIT: usize = 5_000;
pub const LOG_LIMIT: usize = 1_000;
/// 저장하는 history의 상한(`session-store.ts`의 `PERSISTED_HISTORY_LIMIT`)
pub const PERSISTED_HISTORY_LIMIT: usize = 2_000;

/// 자주 오거나 스냅샷이 최신 값을 들고 있어 기록에 쌓지 않는 이벤트
const TRANSIENT: [&str; 6] = ["usage", "sandbox_link", "files_changed", "tests_changed", "deploy_log", "label"];
/// 저장하지 않는 이벤트(`trimHistory`): 로그·사용량·서비스 상태는 샌드박스와 함께 사라지고 세션 상태는 스냅샷이 들고 있다
const NOT_PERSISTED: [&str; 6] = ["log", "usage", "service", "status", "snapshot", "deploy_log"];

struct Stored {
    json: String,
    run_started: bool,
    persisted: bool,
    /// history에 쌓은 순번(빈틈 없이 이어진다. logs의 것은 쓰지 않는다). 앞에서 잘려도 뒤의 순번은 그대로라 `last_run`이 어디 있는지 순번 뺄셈으로 찾는다
    seq: u64,
}

/// 이벤트 하나를 읽은 결과(`type`만 본다)
struct Class {
    transient: bool,
    log: bool,
    run_started: bool,
    persisted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PushOutcome {
    /// history나 logs에 쌓았다
    pub recorded: bool,
    /// `updatedAt`을 바꾸고 저장을 예약해야 한다(쌓았고 `log`가 아니다)
    pub schedule: bool,
}

pub struct SessionRecord {
    history: VecDeque<Stored>,
    /// 보관 세션(`ArchivedSession`)은 logs가 없다. 되감기에서도 logs를 보내지 않는다
    logs: Option<VecDeque<Stored>>,
    next_seq: u64,
    /// history 안의 마지막 `run_started`의 순번. 앞에서 잘려 나갔으면 `last_run_started`가 걸러 낸다
    last_run: Option<u64>,
    history_limit: usize,
    log_limit: usize,
}

fn classify(json: &str) -> Result<Class, String> {
    let value = match js_json::parse_lone_encoded(json) {
        Ok(value) => Some(value),
        Err(js_json::LoneParseError::TooDeep) => None,
        Err(js_json::LoneParseError::Invalid) => return Err("이벤트가 JSON이 아닙니다".to_owned()),
    };
    // `event.type`이 글자가 아니면 어느 목록에도 맞지 않는다(JS의 `===`)
    let ty = match &value {
        Some(JsValue::Obj(object)) => match object.get("type") {
            Some(JsValue::Str(text)) => Some(text.as_str()),
            _ => None,
        },
        _ => None,
    };
    Ok(Class {
        transient: ty.is_some_and(|t| TRANSIENT.contains(&t)),
        log: ty == Some("log"),
        run_started: ty == Some("run_started"),
        persisted: !ty.is_some_and(|t| NOT_PERSISTED.contains(&t)),
    })
}

impl SessionRecord {
    /// `with_logs`가 거짓이면 보관 세션의 기록이다(logs 없음)
    pub fn new(with_logs: bool) -> Self {
        Self::with_limits(with_logs, HISTORY_LIMIT, LOG_LIMIT)
    }

    /// 시험용으로 상한을 바꾼다
    pub fn with_limits(with_logs: bool, history_limit: usize, log_limit: usize) -> Self {
        Self { history: VecDeque::new(), logs: with_logs.then(VecDeque::new), next_seq: 0, last_run: None, history_limit, log_limit }
    }

    pub fn has_logs(&self) -> bool {
        self.logs.is_some()
    }

    /// history에 들어갈 항목(순번을 하나 쓴다)
    fn stored(&mut self, json: String, class: &Class) -> Stored {
        let seq = self.next_seq;
        self.next_seq += 1;
        Stored { json, run_started: class.run_started, persisted: class.persisted, seq }
    }

    /// `emit`의 버퍼 처리. JSON이 아니면 아무것도 쌓지 않고 오류를 돌려준다
    pub fn push(&mut self, json: String) -> Result<PushOutcome, String> {
        let class = classify(&json)?;
        if class.transient {
            return Ok(PushOutcome { recorded: false, schedule: false });
        }
        if class.log {
            // logs가 없는 기록(보관 세션)에는 로그가 오지 않는다. 오더라도 어디에도 쌓지 않는다
            if self.logs.is_none() {
                return Ok(PushOutcome { recorded: false, schedule: false });
            }
            // logs의 항목은 순번을 쓰지 않는다(history의 순번이 빈틈 없이 이어져야 `last_run_started`의 뺄셈이 맞다)
            let stored = Stored { json, run_started: false, persisted: false, seq: 0 };
            let limit = self.log_limit;
            if let Some(logs) = &mut self.logs {
                logs.push_back(stored);
                while logs.len() > limit {
                    logs.pop_front();
                }
            }
            return Ok(PushOutcome { recorded: true, schedule: false });
        }
        let stored = self.stored(json, &class);
        if stored.run_started {
            self.last_run = Some(stored.seq);
        }
        self.history.push_back(stored);
        while self.history.len() > self.history_limit {
            self.history.pop_front();
        }
        Ok(PushOutcome { recorded: true, schedule: true })
    }

    /// 상한을 적용하지 않고 history 끝에 덧붙인다(이어받기의 `[...history, event]`). 기록하지 않는 이벤트를 걸러 내지도 않는다
    pub fn append(&mut self, json: String) -> Result<(), String> {
        let class = classify(&json)?;
        let stored = self.stored(json, &class);
        if stored.run_started {
            self.last_run = Some(stored.seq);
        }
        self.history.push_back(stored);
        Ok(())
    }

    /// history를 통째로 바꾼다(이어받기·복구에서 저장한 기록을 올린다). 상한도 걸러 내기도 하지 않는다. 하나라도 JSON이 아니면 아무것도 바꾸지 않는다
    pub fn replace_history(&mut self, events: Vec<String>) -> Result<(), String> {
        let classes: Vec<Class> = events.iter().map(|json| classify(json)).collect::<Result<_, _>>()?;
        self.history.clear();
        self.last_run = None;
        for (json, class) in events.into_iter().zip(classes) {
            let stored = self.stored(json, &class);
            if stored.run_started {
                self.last_run = Some(stored.seq);
            }
            self.history.push_back(stored);
        }
        Ok(())
    }

    /// history에서 마지막 `run_started` 이벤트(글자 그대로). `findLast(e => e.type === 'run_started')`
    pub fn last_run_started(&self) -> Option<&str> {
        let front = self.history.front()?.seq;
        let seq = self.last_run?;
        // 앞에서 잘려 나갔으면 없다
        if seq < front {
            return None;
        }
        self.history.get((seq - front) as usize).map(|stored| stored.json.as_str())
    }

    /// 끝 n개. `n`이 길이 이상이면 전부
    pub fn tail(&self, n: usize) -> Vec<&str> {
        let skip = self.history.len().saturating_sub(n);
        self.history.iter().skip(skip).map(|stored| stored.json.as_str()).collect()
    }

    pub fn history(&self) -> Vec<&str> {
        self.history.iter().map(|stored| stored.json.as_str()).collect()
    }

    /// logs가 없는 기록이면 빈 목록
    pub fn logs(&self) -> Vec<&str> {
        self.logs.iter().flatten().map(|stored| stored.json.as_str()).collect()
    }

    /// `trimHistory`와 같다: 저장하지 않는 종류를 빼고 끝 `PERSISTED_HISTORY_LIMIT`개
    pub fn trimmed_history(&self) -> Vec<&str> {
        let kept: Vec<&str> = self.history.iter().filter(|stored| stored.persisted).map(|stored| stored.json.as_str()).collect();
        kept[kept.len().saturating_sub(PERSISTED_HISTORY_LIMIT)..].to_vec()
    }

    pub fn history_len(&self) -> usize {
        self.history.len()
    }

    pub fn logs_len(&self) -> usize {
        self.logs.as_ref().map_or(0, VecDeque::len)
    }
}

#[cfg(test)]
mod tests;
