//! 단계(`click`·`fill`·`press`·`waitFor`)와 스크린샷, 단계 뒤 요청 기다리기(ADR-199 A6b). 옛 러너(`page.click`·`page.fill`·
//! `page.keyboard.press`·`page.waitForSelector`·`page.screenshot`)와 같은 뜻으로 돈다.
//!
//! 근거는 `playwright-core@1.63.0`의 `lib/coreBundle.js`다.
//! - `click`: `Frame.click` → `_retryWithProgressIfNotConnected` → `ElementHandle._click` → `_retryPointerAction` → `_performPointerAction`
//!   (보임·활성·안정 → 화면 안으로 스크롤 → 클릭 지점 → 그 지점의 요소가 대상인지 → 마우스 이동·누름·뗌 → 대상 확인 해제 → 이동 기다림)
//! - `fill`: `ElementHandle._fill`(보임·활성·편집 가능을 확인하고 주입 스크립트의 `fill`, 필요하면 `Input.insertText`·`Delete`)
//! - `waitFor`: `Frame.waitForSelector`(state `visible`)
//! - 재시도 일정: 선택자를 다시 찾는 바깥 고리는 `retryWithProgressAndBackoff`(`[20, 50, 100, 100, 500]`, 마감/5보다 큰 뒤쪽은 뺀다, 앞에 0),
//!   요소 동작의 안쪽 고리는 `_retryAction`(`[0, 20, 100, 100, 500]`, 다섯 번째 이후는 500). 스크롤 방식은 시도마다 돌려 쓴다
//!   (`undefined`, 끝, 가운데, 처음)
//! - 이동: 클릭이 요청한 이동(`Page.frameRequestedNavigation`)은 커밋·중단될 때까지 기다리고(`SignalBarrier`), 동작 전에는 대기 중인
//!   문서가 있으면 그 이동을 기다린다(`performActionPreChecks`)
//! - `press`: `Keyboard.press`([`super::super::keyboard`]). 마감이 없다(옛 러너와 같다)
//!
//! 모르면 실패다: 예상하지 못한 결과 모양, 끊긴 연결, 이벤트를 끝까지 받지 못한 경우를 단계 성공으로 바꾸지 않는다.

use super::utility::{self, UtilityHandle};
use super::{send_ok_raw, Shared, StepError, WaitError};
use crate::browser::keyboard::Keyboard;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 단계 하나의 상한(`click`·`fill`·`waitFor`). 옛 러너의 `STEP_TIMEOUT_MS`
pub(super) const STEP_TIMEOUT: Duration = Duration::from_secs(5);
/// 마감이 없는 `press`가 브라우저 응답을 기다리는 안전 상한. 응답이 오지 않는 브라우저를 영원히 기다리지 않는다(옛 러너는 마감 없이 기다린다)
const PRESS_SAFETY_TIMEOUT: Duration = Duration::from_secs(60);
/// 스크린샷 하나의 상한(Playwright 기본 30초)
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(30);

/// 단계 뒤 요청 기다리기(`pending-requests.ts`의 `waitForIdle`): 핸들러가 요청을 내보낼 시간, 떠 있는 요청이 없는 채로 이어져야 하는 시간, 상한
pub(super) const IDLE_GRACE: Duration = Duration::from_millis(100);
pub(super) const IDLE_QUIET: Duration = Duration::from_millis(500);
pub(super) const IDLE_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_POLL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepAction {
    Click(String),
    Fill { selector: String, text: String },
    Press(String),
    WaitFor(String),
    /// 선언한 네 동작이 하나도 없는 단계(타입을 통과한 잘못된 입력). 단계 실패가 아니라 입력 오류다
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepInput {
    /// 사람이 알아볼 이름(`describeStep`). TS가 만든다
    pub label: String,
    pub action: StepAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepRecord {
    pub label: String,
    pub ok: bool,
    pub detail: Option<String>,
    pub screenshot: Option<Vec<u8>>,
}

// ── 순수한 규칙(브라우저 없이 시험한다) ────────────────────────────────────────────────────────────

/// 선택자를 다시 찾는 바깥 고리의 기다림 일정(`retryWithProgressAndBackoff`). 마감/5보다 큰 뒤쪽 값은 빼고, 앞에 0을 둔다
pub(super) fn backoff_schedule(timeout: Duration) -> Vec<Duration> {
    let mut scale: Vec<u64> = vec![20, 50, 100, 100, 500];
    while scale.last().is_some_and(|last| Duration::from_millis(*last) > timeout / 5) {
        scale.pop();
    }
    std::iter::once(0).chain(scale).map(Duration::from_millis).collect()
}

/// 바깥 고리의 `index`번째(0부터) 기다림. 일정을 넘으면 마지막 값을 되풀이한다
pub(super) fn backoff_at(schedule: &[Duration], index: usize) -> Duration {
    schedule[index.min(schedule.len() - 1)]
}

/// 요소 동작의 안쪽 고리(`_retryAction`)의 다시 시도 앞의 기다림. `retry`는 몇 번째 다시 시도인가(1부터). 0이면 첫 시도라 기다리지 않는다
pub(super) fn retry_wait(retry: u32) -> Duration {
    const WAIT_MS: [u64; 5] = [0, 20, 100, 100, 500];
    if retry == 0 {
        return Duration::ZERO;
    }
    Duration::from_millis(WAIT_MS[(retry as usize - 1).min(WAIT_MS.len() - 1)])
}

/// 시도마다 돌려 쓰는 스크롤 방식(`_retryPointerAction`의 `scrollOptions`). 첫 시도는 프로토콜의 기본 스크롤이다
pub(super) fn scroll_option(retry: u32) -> Option<Value> {
    match retry % 4 {
        0 => None,
        1 => Some(json!({ "block": "end", "inline": "end" })),
        2 => Some(json!({ "block": "center", "inline": "center" })),
        _ => Some(json!({ "block": "start", "inline": "start" })),
    }
}

type Quad = [(f64, f64); 4];

pub(super) fn quads_from(raw: &[Vec<f64>]) -> Vec<Quad> {
    raw.iter().filter(|quad| quad.len() >= 8).map(|quad| [(quad[0], quad[1]), (quad[2], quad[3]), (quad[4], quad[5]), (quad[6], quad[7])]).collect()
}

fn quad_area(quad: &Quad) -> f64 {
    let mut area = 0.0;
    for i in 0..4 {
        let (x1, y1) = quad[i];
        let (x2, y2) = quad[(i + 1) % 4];
        area += (x1 * y2 - x2 * y1) / 2.0;
    }
    area.abs()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum PointError {
    /// 모양이 없다(`error:notvisible`)
    NotVisible,
    /// 보이는 부분이 창 밖이다(`error:notinviewport`)
    NotInViewport,
}

/// `_clickablePoint`: 사각형들을 창에 맞춰 자르고 넓이가 0.99 넘는 첫 것의 가운데를 소수점 둘째 자리까지 자른 값
pub(super) fn clickable_point(quads: &[Quad], viewport: (f64, f64)) -> Result<(f64, f64), PointError> {
    if quads.is_empty() {
        return Err(PointError::NotVisible);
    }
    let clamped: Vec<Quad> = quads.iter().map(|quad| quad.map(|(x, y)| (x.clamp(0.0, viewport.0), y.clamp(0.0, viewport.1)))).collect();
    let quad = clamped.iter().find(|quad| quad_area(quad) > 0.99).ok_or(PointError::NotInViewport)?;
    let (mut x, mut y) = (0.0, 0.0);
    for (px, py) in quad {
        x += px / 4.0;
        y += py / 4.0;
    }
    Ok((truncate2(x), truncate2(y)))
}

/// `roundPoint`: `(v * 100 | 0) / 100`(0 쪽으로 자른다)
fn truncate2(value: f64) -> f64 {
    ((value * 100.0) as i32 as f64) / 100.0
}

/// 클릭이 요청한 이동이 모두 끝났는가(`SignalBarrier`): 요청마다 그 뒤에 메인 프레임의 이동 결과(커밋·중단)가 하나 있어야 한다.
/// `requests`는 요청 당시의 이동 결과 기록 길이, `events`는 이동 결과가 난 프레임의 기록이다
pub(super) fn navigations_settled(requests: &[usize], event_frames: &[String], main: &str) -> bool {
    requests.iter().all(|position| event_frames.get(*position..).is_some_and(|tail| tail.iter().any(|frame| frame == main)))
}

/// 단계가 실패했을 때 첫 줄에 붙는 글(`error.message.split('\n')[0]`)
pub(super) fn failure_reason(api: &str, error: &StepError) -> Option<String> {
    match error {
        StepError::Timeout => Some(format!("{api}: Timeout {}ms exceeded.", STEP_TIMEOUT.as_millis())),
        StepError::NonRetriable(message) => Some(format!("{api}: {}", message.lines().next().unwrap_or(""))),
        StepError::Fatal(_) | StepError::ContextGone => None,
    }
}

// ── 브라우저와 말하는 쪽 ──────────────────────────────────────────────────────────────────────────

/// 단계 하나를 도는 동안 쓰는 연결·세션·마감
pub(super) struct Ctx<'a> {
    shared: &'a Arc<Shared>,
    session: &'a str,
    deadline: Instant,
}

enum Attempt {
    Done,
    /// 요소가 안 보임·창 밖·클릭 대상이 다름·상태가 안 맞음. 기다렸다 다시 한다
    Retry,
    /// 요소가 문서에서 떨어졌다. 선택자를 다시 찾는다
    NotConnected,
}

enum StateCheck {
    Ok,
    Missing,
    NotConnected,
}

fn tokio_instant(instant: Instant) -> tokio::time::Instant {
    tokio::time::Instant::from_std(instant)
}

impl<'a> Ctx<'a> {
    pub(super) fn new(shared: &'a Arc<Shared>, session: &'a str, timeout: Duration) -> Self {
        Self { shared, session, deadline: Instant::now() + timeout }
    }

    async fn send(&self, method: &str, params: Value) -> Result<Value, StepError> {
        send_ok_raw(self.shared, Some(self.session), method, params, self.deadline).await
    }

    /// 마감까지만 기다린다. 마감을 넘기면 시간 초과다. 연결이 끊겼거나 페이지가 충돌했으면 깨어난 뒤 오류다
    async fn sleep(&self, wait: Duration) -> Result<(), StepError> {
        let now = Instant::now();
        if wait > Duration::ZERO {
            let until = (now + wait).min(self.deadline);
            tokio::time::sleep_until(tokio_instant(until)).await;
        }
        if let Some(reason) = self.shared.state.lock().unwrap().fatal() {
            return Err(StepError::Fatal(reason));
        }
        if Instant::now() >= self.deadline {
            return Err(StepError::Timeout);
        }
        Ok(())
    }

    fn wait_error(error: WaitError) -> StepError {
        match error {
            WaitError::Timeout => StepError::Timeout,
            WaitError::Failed(reason) => StepError::Fatal(reason),
        }
    }

    /// 주입 스크립트 객체에서 함수를 부른다(`Runtime.callFunctionOn`). 반환 값은 `result`(RemoteObject)다.
    /// 평가 중 던진 오류는 다시 시도하지 않는 오류다(첫 줄만, `Error: …` 꼴 그대로). 실행 환경이 사라진 오류는 다시 시도한다
    async fn call(&self, function: &str, args: Vec<Value>, by_value: bool) -> Result<Value, StepError> {
        let handle = utility::ensure(self.shared, self.session, self.deadline).await?;
        self.call_on(&handle.injected, function, args, by_value).await
    }

    async fn call_on(&self, object_id: &str, function: &str, args: Vec<Value>, by_value: bool) -> Result<Value, StepError> {
        let reply = self
            .send("Runtime.callFunctionOn", json!({ "objectId": object_id, "functionDeclaration": function, "arguments": args, "returnByValue": by_value, "awaitPromise": true, "userGesture": true }))
            .await?;
        if let Some(details) = reply.get("exceptionDetails") {
            let description = details.pointer("/exception/description").and_then(Value::as_str).or_else(|| details.get("text").and_then(Value::as_str)).unwrap_or("");
            let first = description.lines().next().unwrap_or("").to_owned();
            if utility::is_context_gone(&first) {
                self.shared.state.lock().unwrap().utility.invalidate();
                return Err(StepError::ContextGone);
            }
            return Err(StepError::NonRetriable(first));
        }
        reply.get("result").cloned().ok_or_else(|| StepError::NonRetriable("평가 결과를 받지 못했습니다".to_owned()))
    }

    fn release(&self, object_id: &str) {
        self.shared.cdp().fire(Some(self.session), "Runtime.releaseObject", json!({ "objectId": object_id }));
    }

    /// 동작을 하기 전에 대기 중인 문서 이동이 있으면 그 이동이 끝나길 기다린다(`performActionPreChecks`는 이것을 두 번 한다)
    async fn pre_checks(&self) -> Result<(), StepError> {
        for _ in 0..2 {
            let from = {
                let mut state = self.shared.state.lock().unwrap();
                let main = state.frames().main_frame_id().unwrap_or_default().to_owned();
                if !state.frames().has_pending_document(&main) {
                    continue;
                }
                state.frames().nav_events.len()
            };
            super::wait_until(self.shared, self.deadline, |state| {
                let main = state.frames().main_frame_id().unwrap_or_default().to_owned();
                state.frames().nav_events.get(from..).is_some_and(|tail| tail.iter().any(|event| event.frame_id == main)).then_some(())
            })
            .await
            .map_err(Self::wait_error)?;
        }
        Ok(())
    }

    /// 선택자를 해석한다. 틀린 선택자·모르는 엔진은 기다리지 않고 바로 실패한다(Playwright는 서버에서 먼저 해석한다)
    async fn parse_selector(&self, selector: &str) -> Result<Value, StepError> {
        loop {
            let result = self
                .call("function(selector) { try { return { parsed: this.parseSelector(selector) }; } catch (e) { return { invalid: String((e && e.message) || e) }; } }", vec![json!({ "value": selector })], true)
                .await;
            match result {
                Ok(result) => {
                    let value = result.get("value").cloned().unwrap_or(Value::Null);
                    if let Some(invalid) = value.get("invalid").and_then(Value::as_str) {
                        return Err(StepError::NonRetriable(invalid.to_owned()));
                    }
                    return value.get("parsed").cloned().ok_or_else(|| StepError::NonRetriable("선택자를 해석한 결과를 받지 못했습니다".to_owned()));
                }
                Err(StepError::ContextGone) => self.sleep(Duration::from_millis(20)).await?,
                Err(error) => return Err(error),
            }
        }
    }

    /// 해석한 선택자와 맞는 첫 요소(없으면 `None`). 반환한 객체 id는 쓴 뒤 `release`한다
    async fn query_first(&self, parsed: &Value) -> Result<Option<String>, StepError> {
        let result = self.call("function(parsed) { const elements = this.querySelectorAll(parsed, document); return elements[0] || null; }", vec![json!({ "value": parsed })], false).await?;
        Ok(result.get("objectId").and_then(Value::as_str).map(str::to_owned))
    }

    async fn check_states(&self, element: &str, states: &[&str]) -> Result<StateCheck, StepError> {
        let result = self
            .call("async function(node, states) { return await this.checkElementStates(node, states); }", vec![json!({ "objectId": element }), json!({ "value": states })], true)
            .await?;
        classify_state_result(&result)
    }

    /// `ElementHandle._scrollRectIntoViewIfNeeded`/`scrollIntoView(옵션)`
    async fn scroll(&self, element: &str, retry: u32) -> Result<Attempt, StepError> {
        match scroll_option(retry) {
            Some(options) => {
                self.call_on(element, "function(options) { if (this.nodeType === 1) this.scrollIntoView(options); return 'done'; }", vec![json!({ "value": options })], true).await?;
                Ok(Attempt::Done)
            }
            None => match self.send("DOM.scrollIntoViewIfNeeded", json!({ "objectId": element })).await {
                Ok(_) => Ok(Attempt::Done),
                Err(StepError::NonRetriable(message)) if message.contains("Node does not have a layout object") => Ok(Attempt::Retry),
                Err(StepError::NonRetriable(message)) if message.contains("Node is detached from document") => Ok(Attempt::NotConnected),
                Err(error) => Err(error),
            },
        }
    }

    async fn viewport(&self) -> Result<(f64, f64), StepError> {
        let handle = utility::ensure(self.shared, self.session, self.deadline).await?;
        let reply = self.send("Runtime.evaluate", json!({ "expression": "({ width: innerWidth, height: innerHeight })", "contextId": handle.context_id, "returnByValue": true })).await?;
        let width = reply.pointer("/result/value/width").and_then(Value::as_f64);
        let height = reply.pointer("/result/value/height").and_then(Value::as_f64);
        match (width, height) {
            (Some(width), Some(height)) => Ok((width, height)),
            _ => Err(StepError::NonRetriable("창 크기를 읽지 못했습니다".to_owned())),
        }
    }

    /// 요소가 클릭 가능한 지점을 구한다. 안 보이면 `Retry`
    async fn clickable_point(&self, element: &str) -> Result<Result<(f64, f64), Attempt>, StepError> {
        let quads = match self.send("DOM.getContentQuads", json!({ "objectId": element })).await {
            Ok(reply) => reply.get("quads").and_then(Value::as_array).map(|quads| quads.iter().map(|quad| quad.as_array().map(|numbers| numbers.iter().filter_map(Value::as_f64).collect::<Vec<f64>>()).unwrap_or_default()).collect::<Vec<_>>()),
            // 모양을 구하지 못하면(문서에서 떨어졌거나 레이아웃이 없다) 보이지 않는 것이다. 연결이 끊긴 것은 오류다
            Err(StepError::NonRetriable(_)) => None,
            Err(error) => return Err(error),
        };
        let Some(quads) = quads else { return Ok(Err(Attempt::Retry)) };
        let viewport = self.viewport().await?;
        Ok(clickable_point(&quads_from(&quads), viewport).map_err(|_| Attempt::Retry))
    }

    /// 마우스 이동·누름·뗌(Playwright `Mouse.click`와 같은 매개변수)
    async fn mouse_click(&self, x: f64, y: f64) -> Result<(), StepError> {
        let commands = vec![
            ("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "button": "none", "buttons": 0, "x": x, "y": y, "modifiers": 0, "force": 0 })),
            ("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "button": "left", "buttons": 1, "x": x, "y": y, "modifiers": 0, "clickCount": 1, "force": 0.5 })),
            ("Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "button": "left", "buttons": 0, "x": x, "y": y, "modifiers": 0, "clickCount": 1 })),
        ];
        let cdp = self.shared.cdp();
        let results = match tokio::time::timeout_at(tokio_instant(self.deadline), cdp.send_batch(Some(self.session), commands)).await {
            Err(_) => return Err(StepError::Timeout),
            Ok(results) => results,
        };
        for result in results {
            result.map_err(|error| self.after_cdp_error("Input.dispatchMouseEvent", &error.message))?;
        }
        Ok(())
    }

    fn after_cdp_error(&self, method: &str, message: &str) -> StepError {
        if let Some(reason) = self.shared.state.lock().unwrap().fatal() {
            return StepError::Fatal(reason);
        }
        if utility::is_context_gone(message) {
            self.shared.state.lock().unwrap().utility.invalidate();
            return StepError::ContextGone;
        }
        StepError::NonRetriable(format!("{method}: {message}"))
    }

    /// `_performPointerAction`과 `_retryPointerAction`의 한 번의 시도(`retry`번째)
    async fn pointer_attempt(&self, element: &str, retry: u32) -> Result<Attempt, StepError> {
        // 보임·활성·안정
        match self.check_states(element, &["visible", "enabled", "stable"]).await? {
            StateCheck::Ok => {}
            StateCheck::Missing => return Ok(Attempt::Retry),
            StateCheck::NotConnected => return Ok(Attempt::NotConnected),
        }
        // 화면 안으로 스크롤
        match self.scroll(element, retry).await? {
            Attempt::Done => {}
            other => return Ok(other),
        }
        // 클릭 지점
        let (x, y) = match self.clickable_point(element).await? {
            Ok(point) => point,
            Err(attempt) => return Ok(attempt),
        };
        // 그 지점의 맨 위 요소가 대상(또는 그 자손)인지. 아니면 대상 확인 객체 대신 설명 글이 돌아온다
        let interceptor = self
            .call("function(node, point) { return this.setupHitTargetInterceptor(node, 'mouse', point, false); }", vec![json!({ "objectId": element }), json!({ "value": { "x": x, "y": y } })], false)
            .await?;
        let Some(interceptor_id) = interceptor.get("objectId").and_then(Value::as_str).map(str::to_owned) else {
            return match interceptor.get("value").and_then(Value::as_str) {
                Some("error:notconnected") => Ok(Attempt::NotConnected),
                // 다른 요소가 클릭을 받는다(설명 글). 다시 시도한다
                Some(_) => Ok(Attempt::Retry),
                None => Err(StepError::NonRetriable("클릭 대상 확인의 결과를 알 수 없습니다".to_owned())),
            };
        };
        let outcome = self.click_with_barrier(&interceptor_id, x, y).await;
        // 어느 길로 끝나든 대상 확인을 풀어 둔다(그 뒤의 무관한 동작에 남지 않게)
        self.stop_interceptor(&interceptor_id).await;
        self.release(&interceptor_id);
        outcome
    }

    /// 클릭하고(`waitForSignalsCreatedBy`) 클릭이 요청한 이동이 끝나길 기다린다. 대상 확인이 어긋났으면 `Retry`
    async fn click_with_barrier(&self, interceptor: &str, x: f64, y: f64) -> Result<Attempt, StepError> {
        let (events_from, requests_from) = {
            let mut state = self.shared.state.lock().unwrap();
            let frames = state.frames();
            (frames.nav_events.len(), frames.nav_requests.len())
        };
        self.mouse_click(x, y).await?;
        let hit = self.stop_result(interceptor).await?;
        if hit != HitResult::Done {
            return Ok(Attempt::Retry);
        }
        // 이벤트 처리가 눌림·뗌의 응답 뒤에 오는 것을 놓치지 않게 한 번 더 왕복한다(Playwright `inputActionEpilogue`)
        let _ = self.send("Page.enable", json!({})).await;
        super::wait_until(self.shared, self.deadline, |state| {
            let main = state.frames().main_frame_id().unwrap_or_default().to_owned();
            let frames = state.frames();
            let requests: Vec<usize> = frames.nav_requests[requests_from..].iter().copied().collect();
            let event_frames: Vec<String> = frames.nav_events[events_from..].iter().map(|event| event.frame_id.clone()).collect();
            // 요청 당시의 기록 길이는 처음부터의 길이라 `events_from`을 뺀다
            let relative: Vec<usize> = requests.iter().map(|position| position.saturating_sub(events_from)).collect();
            navigations_settled(&relative, &event_frames, &main).then_some(())
        })
        .await
        .map_err(Self::wait_error)?;
        Ok(Attempt::Done)
    }

    /// `h.stop()`의 결과. 평가가 던지면(클릭이 문서를 바꿔 실행 환경이 사라짐) Playwright처럼 "끝남"으로 본다. 연결이 끊긴 것은 오류다
    async fn stop_result(&self, interceptor: &str) -> Result<HitResult, StepError> {
        match self.call_on(interceptor, "function() { return this.stop(); }", vec![], true).await {
            Ok(result) => Ok(HitResult::from_value(result.get("value"))),
            Err(StepError::Fatal(reason)) => Err(StepError::Fatal(reason)),
            Err(StepError::Timeout) => Err(StepError::Timeout),
            Err(_) => Ok(HitResult::Done),
        }
    }

    async fn stop_interceptor(&self, interceptor: &str) {
        let _ = self.call_on(interceptor, "function() { return this.stop(); }", vec![], true).await;
    }

    /// `ElementHandle._retryAction`의 고리: 시도마다 `attempt`(0부터의 다시 시도 번호)를 해 보고, `Retry`면 일정대로 기다렸다 다시 한다
    async fn retry_action<F, Fut>(&self, mut attempt: F) -> Result<Attempt, StepError>
    where
        F: FnMut(u32) -> Fut,
        Fut: std::future::Future<Output = Result<Attempt, StepError>>,
    {
        let mut retry: u32 = 0;
        loop {
            self.sleep(retry_wait(retry)).await?;
            self.pre_checks().await?;
            let result = attempt(retry).await?;
            retry += 1;
            match result {
                Attempt::Retry => continue,
                done_or_disconnected => return Ok(done_or_disconnected),
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum HitResult {
    Done,
    /// 대상 확인이 어긋났다(설명 글을 담은 객체 또는 모르는 모양). 클릭이 막혔을 수 있어 다시 시도한다
    Mismatch,
}

impl HitResult {
    fn from_value(value: Option<&Value>) -> Self {
        // `stop()`은 대상이 맞으면 "done", 아니면 `{ hitTargetDescription }`을 돌려준다. 모르는 모양은 맞는 것으로 치지 않는다
        match value.and_then(Value::as_str) {
            Some("done") => HitResult::Done,
            _ => HitResult::Mismatch,
        }
    }
}

/// `checkElementStates`의 결과를 읽는다: 없음(`undefined`) = 모두 맞음, `{ missingState }`, `"error:notconnected"`. 그 밖은 모르는 모양이라 오류다
fn classify_state_result(result: &Value) -> Result<StateCheck, StepError> {
    if result.get("type").and_then(Value::as_str) == Some("undefined") {
        return Ok(StateCheck::Ok);
    }
    let value = result.get("value");
    if value.and_then(Value::as_str) == Some("error:notconnected") {
        return Ok(StateCheck::NotConnected);
    }
    if value.and_then(|value| value.get("missingState")).and_then(Value::as_str).is_some() {
        return Ok(StateCheck::Missing);
    }
    Err(StepError::NonRetriable(format!("요소 상태 확인의 결과를 알 수 없습니다: {result}")))
}

// ── 단계 ──────────────────────────────────────────────────────────────────────────────────────

/// `page.click(selector, { timeout: 5000 })`
pub(super) async fn click(shared: &Arc<Shared>, session: &str, selector: &str) -> Result<(), StepError> {
    let ctx = Ctx::new(shared, session, STEP_TIMEOUT);
    let parsed = ctx.parse_selector(selector).await?;
    let schedule = backoff_schedule(STEP_TIMEOUT);
    let mut index = 0;
    loop {
        ctx.sleep(backoff_at(&schedule, index)).await?;
        index += 1;
        match click_once(&ctx, &parsed).await {
            Ok(PollOutcome::Done) => return Ok(()),
            Ok(PollOutcome::Again) | Err(StepError::ContextGone) => continue,
            Err(error) => return Err(error),
        }
    }
}

enum PollOutcome {
    Done,
    /// 요소를 못 찾았거나 문서에서 떨어졌다. 선택자를 다시 찾는다
    Again,
}

/// 선택자를 다시 찾아 한 번 누른다(`_retryWithProgressIfNotConnected`의 한 번). 요소 동작은 안쪽 고리가 마감까지 다시 시도한다
async fn click_once(ctx: &Ctx<'_>, parsed: &Value) -> Result<PollOutcome, StepError> {
    ctx.pre_checks().await?;
    let Some(element) = ctx.query_first(parsed).await? else { return Ok(PollOutcome::Again) };
    let outcome = ctx.retry_action(|retry| ctx.pointer_attempt(&element, retry)).await;
    ctx.release(&element);
    Ok(match outcome? {
        Attempt::Done => PollOutcome::Done,
        Attempt::NotConnected | Attempt::Retry => PollOutcome::Again,
    })
}

/// `page.fill(selector, text, { timeout: 5000 })`
pub(super) async fn fill(shared: &Arc<Shared>, session: &str, selector: &str, text: &str) -> Result<(), StepError> {
    let ctx = Ctx::new(shared, session, STEP_TIMEOUT);
    let parsed = ctx.parse_selector(selector).await?;
    let schedule = backoff_schedule(STEP_TIMEOUT);
    let mut index = 0;
    loop {
        ctx.sleep(backoff_at(&schedule, index)).await?;
        index += 1;
        match fill_once(&ctx, &parsed, text).await {
            Ok(PollOutcome::Done) => return Ok(()),
            Ok(PollOutcome::Again) | Err(StepError::ContextGone) => continue,
            Err(error) => return Err(error),
        }
    }
}

async fn fill_once(ctx: &Ctx<'_>, parsed: &Value, text: &str) -> Result<PollOutcome, StepError> {
    ctx.pre_checks().await?;
    let Some(element) = ctx.query_first(parsed).await? else { return Ok(PollOutcome::Again) };
    let outcome = fill_element(ctx, &element, text).await;
    ctx.release(&element);
    Ok(match outcome? {
        Attempt::Done => PollOutcome::Done,
        Attempt::NotConnected | Attempt::Retry => PollOutcome::Again,
    })
}

/// `ElementHandle._fill`
async fn fill_element(ctx: &Ctx<'_>, element: &str, text: &str) -> Result<Attempt, StepError> {
    ctx.retry_action(|_retry| async move {
        // 보임·활성·편집 가능을 확인하고, 맞으면 주입 스크립트가 채운다(`needsinput`이면 글자는 키 입력으로 넣는다)
        let result = ctx
            .call(
                "async function(node, value) { const check = await this.checkElementStates(node, ['visible', 'enabled', 'editable']); if (check) return check; return this.fill(node, value); }",
                vec![json!({ "objectId": element }), json!({ "value": text })],
                true,
            )
            .await?;
        let value = result.get("value");
        match value.and_then(Value::as_str) {
            Some("needsinput") => {
                if text.is_empty() {
                    press_keys(ctx.shared, ctx.session, "Delete", ctx.deadline).await.map_err(|error| match error {
                        PressError::Step(error) => error,
                        PressError::Key(message) => StepError::NonRetriable(message),
                    })?;
                } else {
                    ctx.send("Input.insertText", json!({ "text": text })).await?;
                }
                Ok(Attempt::Done)
            }
            Some("done") => Ok(Attempt::Done),
            Some("error:notconnected") => Ok(Attempt::NotConnected),
            _ if value.and_then(|value| value.get("missingState")).and_then(Value::as_str).is_some() => Ok(Attempt::Retry),
            _ => Err(StepError::NonRetriable(format!("채우기의 결과를 알 수 없습니다: {result}"))),
        }
    })
    .await
}

/// `page.waitForSelector(selector, { timeout: 5000 })`(상태 `visible`)
pub(super) async fn wait_for(shared: &Arc<Shared>, session: &str, selector: &str) -> Result<(), StepError> {
    let ctx = Ctx::new(shared, session, STEP_TIMEOUT);
    let parsed = ctx.parse_selector(selector).await?;
    let schedule = backoff_schedule(STEP_TIMEOUT);
    let mut index = 0;
    loop {
        ctx.sleep(backoff_at(&schedule, index)).await?;
        index += 1;
        match visible_once(&ctx, &parsed).await {
            Ok(true) => return Ok(()),
            Ok(false) | Err(StepError::ContextGone) => continue,
            Err(error) => return Err(error),
        }
    }
}

async fn visible_once(ctx: &Ctx<'_>, parsed: &Value) -> Result<bool, StepError> {
    ctx.pre_checks().await?;
    let result = ctx
        .call("function(parsed) { const element = this.querySelectorAll(parsed, document)[0]; return element ? this.utils.isElementVisible(element) : false; }", vec![json!({ "value": parsed })], true)
        .await?;
    match result.get("value").and_then(Value::as_bool) {
        Some(visible) => Ok(visible),
        None => Err(StepError::NonRetriable(format!("보임 확인의 결과를 알 수 없습니다: {result}"))),
    }
}

pub(super) enum PressError {
    /// 마감·연결 문제
    Step(StepError),
    /// 알 수 없는 키(Playwright `Keyboard.press`가 던지는 오류 글)
    Key(String),
}

/// `Keyboard.press`: 이벤트를 하나씩 보내고(앞서 보낸 것은 오류가 나도 이미 나간 것이다), 글이 없는 키는 오류로 끝낸다
pub(super) async fn press_keys(shared: &Arc<Shared>, session: &str, key: &str, deadline: Instant) -> Result<(), PressError> {
    let (events, error) = Keyboard::new().press(key);
    for event in events {
        send_ok_raw(shared, Some(session), "Input.dispatchKeyEvent", event, deadline).await.map_err(PressError::Step)?;
    }
    match error {
        Some(message) => Err(PressError::Key(message)),
        None => Ok(()),
    }
}

/// `page.keyboard.press(key)`. 마감이 없어 안전 상한(60초)만 둔다
pub(super) async fn press(shared: &Arc<Shared>, session: &str, key: &str) -> Result<(), StepFailure> {
    let deadline = Instant::now() + PRESS_SAFETY_TIMEOUT;
    match press_keys(shared, session, key, deadline).await {
        Ok(()) => Ok(()),
        Err(PressError::Key(message)) => Err(StepFailure::Reason(format!("keyboard.press: {message}"))),
        Err(PressError::Step(StepError::Timeout)) => Err(StepFailure::Reason(format!("keyboard.press: Timeout {}ms exceeded.", PRESS_SAFETY_TIMEOUT.as_millis()))),
        Err(PressError::Step(StepError::NonRetriable(message))) => Err(StepFailure::Reason(format!("keyboard.press: {}", message.lines().next().unwrap_or("")))),
        Err(PressError::Step(StepError::Fatal(reason))) => Err(StepFailure::Fatal(reason)),
        Err(PressError::Step(StepError::ContextGone)) => Err(StepFailure::Reason("keyboard.press: 대상이 사라졌습니다".to_owned())),
    }
}

/// 단계 실패의 두 종류: 앱·입력의 실패(오류 글을 단계 실패에 담는다)와 확인하지 못한 것(연결 끊김·충돌)
pub(super) enum StepFailure {
    Reason(String),
    Fatal(String),
}

/// 단계 함수의 오류를 `page.click: Timeout 5000ms exceeded.` 꼴의 첫 줄로 바꾼다
pub(super) fn to_failure(api: &str, error: StepError) -> StepFailure {
    match error {
        StepError::Fatal(reason) => StepFailure::Fatal(reason),
        other => StepFailure::Reason(failure_reason(api, &other).unwrap_or_else(|| format!("{api}: 대상이 사라졌습니다"))),
    }
}

// ── 단계 뒤 요청 기다리기(#684) ─────────────────────────────────────────────────────────────────

/// 떠 있는 요청이 없어질 때까지 기다린다(`pending-requests.ts`의 `waitForIdle`과 같은 뜻). 핸들러가 요청을 내보낼 시간(`grace`)은 무조건 기다리고,
/// 떠 있는 요청이 없는 상태가 `quiet` 이어지면 끝낸다. 상한(`timeout`)을 넘겨도 오류가 아니다(끝나지 않는 요청이 있어도 멈추지 않는다).
/// 연결이 끊겼거나 페이지가 충돌했으면 오류다(결과를 돌려주지 않는다)
pub(super) async fn wait_for_idle(shared: &Arc<Shared>, grace: Duration, quiet: Duration, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout.max(grace);
    tokio::time::sleep(grace).await;
    let mut quiet_since: Option<Instant> = None;
    loop {
        let (pending, fatal) = {
            let state = shared.state.lock().unwrap();
            (state.pending_requests.len(), state.fatal())
        };
        if let Some(reason) = fatal {
            return Err(reason);
        }
        let now = Instant::now();
        if pending == 0 {
            let since = *quiet_since.get_or_insert(now);
            if now.duration_since(since) >= quiet {
                return Ok(());
            }
        } else {
            quiet_since = None;
        }
        if now >= deadline {
            return Ok(());
        }
        tokio::time::sleep(IDLE_POLL).await;
    }
}

// ── 스크린샷 ───────────────────────────────────────────────────────────────────────────────────

/// 캐럿을 숨기는 준비 함수(`page.screenshot`이 부르는 `inPagePrepareForScreenshots`, Playwright 1.63.0)
const PREPARE_FOR_SCREENSHOTS: &str = include_str!("../third_party/playwright/prepare_for_screenshots.js");

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// `page.screenshot({ type: 'png' })`: 창 크기의 PNG. 글꼴이 준비되길 기다리고 캐럿을 숨겼다 되돌린다.
/// 실패하면 `None`이다. 옛 러너는 스크린샷 실패를 삼키고 그 단계를 스크린샷 없이 남긴다(단계 결과는 그대로)
pub(super) async fn capture(shared: &Arc<Shared>, session: &str, viewport: (u32, u32)) -> Option<Vec<u8>> {
    let deadline = Instant::now() + SCREENSHOT_TIMEOUT;
    let result = capture_inner(shared, session, viewport, deadline).await;
    result.ok()
}

async fn capture_inner(shared: &Arc<Shared>, session: &str, viewport: (u32, u32), deadline: Instant) -> Result<Vec<u8>, StepError> {
    let handle: UtilityHandle = utility::ensure(shared, session, deadline).await?;
    let evaluate = |expression: String, await_promise: bool| {
        let handle = handle.clone();
        async move { send_ok_raw(shared, Some(session), "Runtime.evaluate", json!({ "expression": expression, "contextId": handle.context_id, "returnByValue": true, "awaitPromise": await_promise, "userGesture": true }), deadline).await }
    };
    evaluate(format!("{PREPARE_FOR_SCREENSHOTS}(undefined, true, false, false)"), false).await?;
    let shot = async {
        // 글꼴이 준비되기를 기다린다(실패해도 찍는다)
        let _ = evaluate("document.fonts.ready".to_owned(), true).await;
        let metrics = send_ok_raw(shared, Some(session), "Page.getLayoutMetrics", json!({}), deadline).await?;
        let visual = metrics.get("visualViewport").cloned().unwrap_or(Value::Null);
        let scale = visual.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
        let clip = json!({
            "x": visual.get("pageX").and_then(Value::as_f64).unwrap_or(0.0),
            "y": visual.get("pageY").and_then(Value::as_f64).unwrap_or(0.0),
            "width": (f64::from(viewport.0) / scale + 1e-3).floor(),
            "height": (f64::from(viewport.1) / scale + 1e-3).floor(),
            "scale": scale,
        });
        let reply = send_ok_raw(shared, Some(session), "Page.captureScreenshot", json!({ "format": "png", "clip": clip, "captureBeyondViewport": false }), deadline).await?;
        let data = reply.get("data").and_then(Value::as_str).and_then(base64_decode).ok_or_else(|| StepError::NonRetriable("스크린샷 데이터를 읽지 못했습니다".to_owned()))?;
        Ok::<Vec<u8>, StepError>(data)
    }
    .await;
    // 캐럿을 되돌린다(찍기가 실패했어도)
    let _ = evaluate("window.__pwCleanupScreenshot && window.__pwCleanupScreenshot()".to_owned(), false).await;
    shot
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(values: &[u64]) -> Vec<Duration> {
        values.iter().map(|value| Duration::from_millis(*value)).collect()
    }

    #[test]
    fn the_outer_backoff_is_zero_then_twenty_fifty_hundred_hundred_fivehundred_for_five_seconds() {
        // 5초 상한이면 마감/5 = 1000ms라 500이 남는다
        assert_eq!(backoff_schedule(Duration::from_secs(5)), ms(&[0, 20, 50, 100, 100, 500]));
        // 마감이 짧으면 큰 뒤쪽 값을 뺀다(마감/5보다 큰 값)
        assert_eq!(backoff_schedule(Duration::from_millis(1000)), ms(&[0, 20, 50, 100, 100]));
        assert_eq!(backoff_schedule(Duration::from_millis(200)), ms(&[0, 20]));
        assert_eq!(backoff_schedule(Duration::from_millis(50)), ms(&[0]));
        // 일정을 넘으면 마지막 값을 되풀이한다
        let schedule = backoff_schedule(Duration::from_secs(5));
        assert_eq!(backoff_at(&schedule, 0), Duration::ZERO);
        assert_eq!(backoff_at(&schedule, 5), Duration::from_millis(500));
        assert_eq!(backoff_at(&schedule, 99), Duration::from_millis(500));
    }

    #[test]
    fn the_inner_retry_wait_is_0_20_100_100_then_500_forever() {
        let waits: Vec<u64> = (0..9).map(|retry| retry_wait(retry).as_millis() as u64).collect();
        assert_eq!(waits, vec![0, 0, 20, 100, 100, 500, 500, 500, 500]);
    }

    #[test]
    fn scroll_options_rotate_default_end_center_start() {
        assert_eq!(scroll_option(0), None);
        assert_eq!(scroll_option(1), Some(json!({ "block": "end", "inline": "end" })));
        assert_eq!(scroll_option(2), Some(json!({ "block": "center", "inline": "center" })));
        assert_eq!(scroll_option(3), Some(json!({ "block": "start", "inline": "start" })));
        assert_eq!(scroll_option(4), None);
    }

    #[test]
    fn the_click_point_is_the_middle_of_the_first_quad_that_shows_in_the_viewport_cut_to_two_decimals() {
        let quad: Quad = [(50.0, 100.0), (170.0, 100.0), (170.0, 140.0), (50.0, 140.0)];
        assert_eq!(clickable_point(&[quad], (1280.0, 800.0)), Ok((110.0, 120.0)));
        // 창 밖으로 걸친 사각형은 창에 맞춰 자른 뒤의 가운데다
        let wide: Quad = [(-100.0, 0.0), (100.0, 0.0), (100.0, 40.0), (-100.0, 40.0)];
        assert_eq!(clickable_point(&[wide], (1280.0, 800.0)), Ok((50.0, 20.0)));
        // 소수점 둘째 자리까지 자른다(반올림이 아니다)
        let odd: Quad = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let third: Quad = odd.map(|(x, y)| (x / 3.0, y / 3.0));
        assert_eq!(clickable_point(&[third], (100.0, 100.0)), Ok((1.66, 1.66)));
    }

    #[test]
    fn a_tiny_or_off_screen_quad_is_not_clickable() {
        let tiny: Quad = [(10.0, 10.0), (10.9, 10.0), (10.9, 10.9), (10.0, 10.9)];
        assert_eq!(clickable_point(&[tiny], (100.0, 100.0)), Err(PointError::NotInViewport));
        let off: Quad = [(500.0, 500.0), (600.0, 500.0), (600.0, 540.0), (500.0, 540.0)];
        assert_eq!(clickable_point(&[off], (100.0, 100.0)), Err(PointError::NotInViewport));
        assert_eq!(clickable_point(&[], (100.0, 100.0)), Err(PointError::NotVisible));
        // 첫 사각형이 작아도 다음 사각형이 보이면 그것의 가운데다
        let visible: Quad = [(20.0, 20.0), (60.0, 20.0), (60.0, 40.0), (20.0, 40.0)];
        assert_eq!(clickable_point(&[tiny, visible], (100.0, 100.0)), Ok((40.0, 30.0)));
    }

    #[test]
    fn a_requested_navigation_is_settled_only_by_a_later_result_of_the_main_frame() {
        // 요청이 없으면 기다릴 것이 없다
        assert!(navigations_settled(&[], &[], "M"));
        // 요청 당시 기록이 비어 있었고 그 뒤에 메인 프레임의 이동 결과가 없으면 아직이다
        assert!(!navigations_settled(&[0], &[], "M"));
        // 다른 프레임의 결과는 세지 않는다
        assert!(!navigations_settled(&[0], &["child".to_owned()], "M"));
        assert!(navigations_settled(&[0], &["child".to_owned(), "M".to_owned()], "M"));
        // 요청 앞에 있던 결과는 이 요청의 것이 아니다
        assert!(!navigations_settled(&[1], &["M".to_owned()], "M"));
        // 요청이 둘이면 둘 모두 뒤따르는 결과가 있어야 한다(위치 0, 1 → 결과 두 개)
        assert!(navigations_settled(&[0, 1], &["M".to_owned(), "M".to_owned()], "M"));
        assert!(!navigations_settled(&[0, 1], &["M".to_owned()], "M"));
    }

    #[test]
    fn failure_text_is_the_first_line_prefixed_by_the_playwright_api_name() {
        assert_eq!(failure_reason("page.click", &StepError::Timeout).as_deref(), Some("page.click: Timeout 5000ms exceeded."));
        assert_eq!(failure_reason("page.fill", &StepError::NonRetriable("Error: Input of type \"checkbox\" cannot be filled\n    at x".to_owned())).as_deref(), Some("page.fill: Error: Input of type \"checkbox\" cannot be filled"));
        // 끊긴 연결·사라진 실행 환경은 단계 실패의 글이 아니다
        assert_eq!(failure_reason("page.click", &StepError::Fatal("x".to_owned())), None);
        assert_eq!(failure_reason("page.click", &StepError::ContextGone), None);
    }

    #[test]
    fn state_results_are_read_strictly_and_unknown_shapes_are_errors() {
        assert!(matches!(classify_state_result(&json!({ "type": "undefined" })), Ok(StateCheck::Ok)));
        assert!(matches!(classify_state_result(&json!({ "type": "string", "value": "error:notconnected" })), Ok(StateCheck::NotConnected)));
        assert!(matches!(classify_state_result(&json!({ "type": "object", "value": { "missingState": "stable" } })), Ok(StateCheck::Missing)));
        // 모르는 모양은 통과가 아니다
        assert!(classify_state_result(&json!({ "type": "boolean", "value": true })).is_err());
        assert!(classify_state_result(&json!({})).is_err());
    }

    #[test]
    fn a_hit_target_result_other_than_done_is_a_mismatch() {
        assert_eq!(HitResult::from_value(Some(&json!("done"))), HitResult::Done);
        assert_eq!(HitResult::from_value(Some(&json!({ "hitTargetDescription": "<div> intercepts pointer events" }))), HitResult::Mismatch);
        assert_eq!(HitResult::from_value(Some(&json!("error:notconnected"))), HitResult::Mismatch);
        assert_eq!(HitResult::from_value(None), HitResult::Mismatch);
    }

    #[test]
    fn base64_png_data_decodes() {
        assert_eq!(base64_decode("iVBORw0K").unwrap(), vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
        assert!(base64_decode("***").is_none());
    }
}
