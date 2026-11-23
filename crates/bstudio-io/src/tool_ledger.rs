//! 도구 순서 장부(ADR-202, 4f A8b). TS `packages/agent/src/claude-code-runner.ts`의 `serialQueue`·`noteToolUses`·`awaitToolUse`·`closeTools`·`runTool` 앞부분이 하던 일을 옮긴 것이다
//! (옛 구현 `claude-code-runner-loop-legacy.ts`는 #1347에서 지웠다). 트러블슈팅 206.
//!
//! 왜 필요한가: 진짜 CLI는 assistant 메시지(`tool_use`)를 표준 출력에 먼저 쓰고 나서 MCP 요청을 보낸다. 그런데 MCP 서버는 다른 스레드에서 요청을 읽으므로
//! 러너가 요청을 그 표준 출력 줄보다 먼저 처리할 수 있다. 턴 세기와 턴 상한(넘으면 도구를 닫는다)은 표준 출력 쪽에 있어서, 그대로 두면 상한을 넘긴 턴의 도구가
//! 닫히기 전에 실행된다. 그래서 도구 이름마다 표준 출력에서 본 `tool_use` 수와 받은 요청 수를 세고, 요청이 앞서면 그 메시지를 기다린다.
//!
//! 같은 실행의 러너 코어(`cli_runner.rs`)와 MCP 서버(`loopback_server.rs`의 `McpConfig`를 쓰는 napi 층)가 이 객체 하나를 나눠 쥔다.
//! MCP 서버의 `tools/call`은 TS의 도구 실행 콜백을 부르기 **전에** [`ToolLedger::run`]을 지난다. 옛 `runTool`의
//! `serial(async () => { await awaitToolUse(name); throwIfAborted; if (toolsClosed) throw ...; ... })`와 같은 뜻이다:
//! - 도착 순서대로 하나씩 실행한다(FIFO 잠금. 실행이 끝날 때까지 쥔다)
//! - 그 도구의 `tool_use`를 본 뒤에 실행하고, 대기 상한을 넘기면 그대로 실행한다(메시지가 끝내 오지 않아도 도구가 영영 멈추지 않게)
//! - 취소됐거나 닫혔으면 콜백을 부르지 않고 거절한다(취소 이유 글, [`CLOSED_MESSAGE`])
//!
//! 호출부마다 막는 쪽인지 여는 쪽인지: `run`은 **막는 쪽**이다(닫힘·취소는 실행을 거절한다. 모르는 상태는 없다: 닫힘·취소 두 값뿐이다).
//! `note_tool_uses`는 기다리던 요청을 **여는** 쪽이다 — 그래서 `tool_use` 블록이 맞는 꼴일 때만 센다(`type`이 `tool_use`이고 `name`이 글자인 블록만.
//! 같은 `id`가 다시 와도 한 번만). 닫히면 기다리던 요청을 깨워 바로 거절되게 한다.
//!
//! 옛 구현과 다른 것: 도착 순서의 기준이 JS 콜백이 실행되는 때가 아니라 Rust가 요청을 받은 때다(더 이르다). 도구 이름은 `encodeLoneSurrogates`한 꼴끼리 견준다.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use bstudio_guard::js_json::JsValue;
use tokio::sync::Notify;
use tokio::time::Instant;

/// 닫힌 뒤 도착한 도구 호출의 거절 글(옛 `runTool`이 던지던 오류의 글)
pub const CLOSED_MESSAGE: &str = "이 실행은 이미 끝나 도구를 쓸 수 없습니다";
/// 도구 요청이 그 호출이 든 assistant 메시지보다 먼저 처리됐을 때 그 메시지를 기다리는 상한(옛 `TOOL_USE_WAIT_MS`)
pub const DEFAULT_WAIT: Duration = Duration::from_millis(2_000);

#[derive(Default)]
struct State {
    /// 도구 이름 → 표준 출력에서 본 `tool_use` 수
    seen: HashMap<String, u64>,
    /// 센 `tool_use`의 id(같은 블록이 다시 와도 한 번만)
    ids: HashSet<String>,
    /// 도구 이름 → 순서가 돌아와 확인한 요청 수
    received: HashMap<String, u64>,
    closed: bool,
    /// 취소 이유 글(`describe(signal.reason)`). 있으면 취소됐다
    aborted: Option<String>,
}

pub struct ToolLedger {
    /// MCP 요청의 도구 이름 앞에 붙는 말(`mcp__<서버>__`). 표준 출력의 `tool_use` 이름과 같은 꼴로 맞춘다
    prefix: String,
    wait: Duration,
    state: Mutex<State>,
    wake: Notify,
    /// 도구를 하나씩 실행하는 잠금. tokio의 Mutex는 기다린 순서대로 준다(FIFO)
    serial: tokio::sync::Mutex<()>,
}

impl ToolLedger {
    pub fn new(prefix: impl Into<String>, wait: Duration) -> Self {
        Self { prefix: prefix.into(), wait, state: Mutex::new(State::default()), wake: Notify::new(), serial: tokio::sync::Mutex::new(()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// assistant 메시지의 `content`에서 `tool_use` 블록을 센다(하위 에이전트 메시지의 것도 센다: 그 요청도 이 서버로 오므로 기다리지 않게). 센 뒤 기다리던 요청을 깨운다.
    /// 배열이 아니면 아무것도 하지 않는다(깨우지도 않는다)
    pub fn note_tool_uses(&self, content: Option<&JsValue>) {
        let Some(JsValue::Arr(blocks)) = content else { return };
        {
            let mut state = self.lock();
            for block in blocks {
                // 객체가 아닌 블록(null·글자·수)은 건너뛴다. 배열도 `type`이 없어 건너뛴다
                if !matches!(block, JsValue::Obj(_)) {
                    continue;
                }
                let (Some(JsValue::Str(kind)), Some(JsValue::Str(name))) = (block.prop("type"), block.prop("name")) else { continue };
                if kind != "tool_use" {
                    continue;
                }
                // 같은 블록이 다시 와도(재전송) 한 번만 센다
                if let Some(JsValue::Str(id)) = block.prop("id") {
                    if !state.ids.insert(id.clone()) {
                        continue;
                    }
                }
                *state.seen.entry(name.clone()).or_insert(0) += 1;
            }
        }
        self.wake.notify_waiters();
    }

    /// 이제부터 오는 도구 호출은 거절한다. 메시지를 기다리던 요청도 깨워 바로 거절되게 한다
    pub fn close(&self) {
        self.lock().closed = true;
        self.wake.notify_waiters();
    }

    /// 취소했다. 이유 글은 거절 글로 쓴다(처음 온 것만 남긴다: `AbortSignal`은 한 번만 취소된다). 기다리던 요청을 깨운다
    pub fn abort(&self, reason: &str) {
        {
            let mut state = self.lock();
            if state.aborted.is_none() {
                state.aborted = Some(reason.to_owned());
            }
        }
        self.wake.notify_waiters();
    }

    pub fn is_closed(&self) -> bool {
        self.lock().closed
    }

    /// 지금까지 도착한 도구 호출이 모두 끝나기를 기다린다(옛 `serial.idle()`). 잠금의 FIFO 순서를 이용한다: 앞서 기다린 것이 다 끝난 뒤에 잠금을 얻는다
    pub async fn idle(&self) {
        let _turn = self.serial.lock().await;
    }

    /// 요청 하나를 순서대로 실행한다. 닫혔거나 취소됐으면 `run`을 부르지 않고 거절 글을 돌려준다
    pub async fn run<T, F, Fut>(&self, name: &str, run: F) -> Result<T, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let _turn = self.serial.lock().await;
        self.await_tool_use(&format!("{}{}", self.prefix, name)).await;
        {
            let state = self.lock();
            // 취소하거나 끝낸 뒤 대기열에 남은 호출은 파일을 건드리지 않고 끝낸다(취소를 먼저 본다: 옛 `throwIfAborted`가 먼저였다)
            if let Some(reason) = &state.aborted {
                return Err(reason.clone());
            }
            if state.closed {
                return Err(CLOSED_MESSAGE.to_owned());
            }
        }
        Ok(run().await)
    }

    /// 이 도구의 `tool_use`를 본 뒤까지 기다린다. 닫히거나 취소되거나 상한을 넘기면 기다리지 않는다
    async fn await_tool_use(&self, name: &str) {
        let wanted = {
            let mut state = self.lock();
            let received = state.received.entry(name.to_owned()).or_insert(0);
            *received += 1;
            *received
        };
        let deadline = Instant::now() + self.wait;
        loop {
            // 알림을 먼저 걸어 두고 상태를 본다(보는 사이에 온 알림을 놓치지 않는다)
            let woken = self.wake.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            {
                let state = self.lock();
                if state.seen.get(name).copied().unwrap_or(0) >= wanted || state.closed || state.aborted.is_some() {
                    return;
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            tokio::select! {
                _ = &mut woken => {}
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bstudio_guard::js_json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn blocks(text: &str) -> JsValue {
        js_json::parse(text).unwrap()
    }

    fn ledger(wait_ms: u64) -> Arc<ToolLedger> {
        Arc::new(ToolLedger::new("mcp__s__", Duration::from_millis(wait_ms)))
    }

    #[tokio::test]
    async fn runs_after_the_tool_use_was_seen() {
        let ledger = ledger(5_000);
        let started = Arc::new(AtomicUsize::new(0));
        let task = {
            let (ledger, started) = (ledger.clone(), started.clone());
            tokio::spawn(async move { ledger.run("read", || async move { started.fetch_add(1, Ordering::SeqCst) }).await })
        };
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(started.load(Ordering::SeqCst), 0, "tool_use를 보기 전에는 실행하지 않는다");
        ledger.note_tool_uses(Some(&blocks(r#"[{"type":"tool_use","id":"a","name":"mcp__s__read"}]"#)));
        assert!(task.await.unwrap().is_ok());
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn runs_after_the_wait_cap_when_the_message_never_comes() {
        let ledger = ledger(60);
        let began = std::time::Instant::now();
        assert!(ledger.run("read", || async {}).await.is_ok());
        assert!(began.elapsed() >= Duration::from_millis(55));
    }

    #[tokio::test]
    async fn counts_only_tool_use_blocks_with_a_string_name() {
        let ledger = ledger(200);
        // text 블록·이름 없는 블록·글자가 아닌 이름·객체가 아닌 값은 세지 않는다
        ledger.note_tool_uses(Some(&blocks(r#"[{"type":"text","name":"mcp__s__read"},{"type":"tool_use"},{"type":"tool_use","name":5},null,"x",[1]]"#)));
        let began = std::time::Instant::now();
        assert!(ledger.run("read", || async {}).await.is_ok());
        assert!(began.elapsed() >= Duration::from_millis(180), "세지 않았으니 상한까지 기다린다");
    }

    #[tokio::test]
    async fn same_block_id_counts_once() {
        let ledger = ledger(150);
        let again = blocks(r#"[{"type":"tool_use","id":"a","name":"mcp__s__read"}]"#);
        ledger.note_tool_uses(Some(&again));
        ledger.note_tool_uses(Some(&again));
        assert!(ledger.run("read", || async {}).await.is_ok());
        // 둘째 요청은 센 것이 하나뿐이라 기다린다(재전송을 둘로 세면 바로 실행된다)
        let began = std::time::Instant::now();
        assert!(ledger.run("read", || async {}).await.is_ok());
        assert!(began.elapsed() >= Duration::from_millis(130));
    }

    #[tokio::test]
    async fn closed_rejects_without_running_and_wakes_waiters() {
        let ledger = ledger(5_000);
        let ran = Arc::new(AtomicUsize::new(0));
        let waiter = {
            let (ledger, ran) = (ledger.clone(), ran.clone());
            tokio::spawn(async move { ledger.run("read", || async move { ran.fetch_add(1, Ordering::SeqCst) }).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let began = std::time::Instant::now();
        ledger.close();
        assert_eq!(waiter.await.unwrap().unwrap_err(), CLOSED_MESSAGE);
        assert!(began.elapsed() < Duration::from_millis(1_000), "대기 상한까지 붙잡지 않는다");
        assert_eq!(ran.load(Ordering::SeqCst), 0);
        assert_eq!(ledger.run("read", || async {}).await.unwrap_err(), CLOSED_MESSAGE);
    }

    #[tokio::test]
    async fn abort_rejects_with_the_reason_before_closed() {
        let ledger = ledger(5_000);
        ledger.abort("취소 이유");
        ledger.close();
        assert_eq!(ledger.run("read", || async {}).await.unwrap_err(), "취소 이유");
    }

    #[tokio::test]
    async fn runs_one_at_a_time_in_arrival_order() {
        let ledger = ledger(50);
        ledger.note_tool_uses(Some(&blocks(r#"[{"type":"tool_use","id":"1","name":"mcp__s__a"},{"type":"tool_use","id":"2","name":"mcp__s__a"},{"type":"tool_use","id":"3","name":"mcp__s__a"}]"#)));
        let order = Arc::new(Mutex::new(Vec::new()));
        let running = Arc::new(AtomicUsize::new(0));
        let max_running = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for n in 0..3 {
            let (ledger, order, running, max_running) = (ledger.clone(), order.clone(), running.clone(), max_running.clone());
            tasks.push(tokio::spawn(async move {
                ledger
                    .run("a", || async move {
                        let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                        max_running.fetch_max(now, Ordering::SeqCst);
                        order.lock().unwrap().push(n);
                        // 앞의 것이 길수록 뒤의 것이 먼저 끝나려는 유혹이 크다
                        tokio::time::sleep(Duration::from_millis(60 - n * 20)).await;
                        running.fetch_sub(1, Ordering::SeqCst);
                    })
                    .await
            }));
            // 도착 순서를 고정한다
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
        assert_eq!(max_running.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn idle_waits_for_running_calls() {
        let ledger = ledger(50);
        ledger.note_tool_uses(Some(&blocks(r#"[{"type":"tool_use","id":"1","name":"mcp__s__a"}]"#)));
        let finished = Arc::new(AtomicUsize::new(0));
        let task = {
            let (ledger, finished) = (ledger.clone(), finished.clone());
            tokio::spawn(async move {
                let _ = ledger.run("a", || async move { tokio::time::sleep(Duration::from_millis(120)).await; finished.fetch_add(1, Ordering::SeqCst) }).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        ledger.idle().await;
        assert_eq!(finished.load(Ordering::SeqCst), 1, "실행 중이던 호출이 끝난 뒤에 돌아온다");
        task.await.unwrap();
    }
}
