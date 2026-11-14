//! 화면 확인 러너(ADR-199): 브라우저를 띄워 페이지를 열고 결과를 모은다. 옛 `runInBrowser`(Playwright)와 같은 결과를 낸다.
//! 이번 조각은 단계(`steps`)가 빈 확인만 다룬다(단계·스크린샷은 A6b, 화면 중계는 A6c).
//!
//! 구조: 읽기 작업([`super::cdp`])이 CDP 틀을 순서대로 [`dispatch`]에 넘기고, 처리기는 공유 상태([`State`])만 고친다. 기다리는 쪽
//! ([`wait_until`])은 상태를 잠깐 잠그고 조건을 본 뒤 알림을 기다린다. 응답을 받은 시점에는 그 앞의 이벤트가 모두 상태에 들어가 있다.
//! 이벤트를 끝까지 받지 못했거나 연결이 끊기면 통과가 아니라 오류다(`fatal`).

use super::cdp::{Cdp, CdpError, Event};
use super::console_text::{console_text, exception_message};
use super::frames::{FrameManager, RequestKey};
use super::launch::{BrowserProcess, ProfileDir};
use super::origin::{is_allowed_url, tunnel_target};
use super::proxy::{OriginProxy, ProxyBlock};
use crate::container_verify::Cancel;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use url::Url;

const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(30);
/// 네트워크가 잠잠해질 때까지 기다리되, 끝나지 않는 요청(개발 서버의 HMR 연결 등) 때문에 멈추지 않게 둔 상한
const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const EVALUATE_TIMEOUT: Duration = Duration::from_secs(60);

/// 허용 출처를 넘겼을 때 옛 러너가 `serviceWorkers: 'block'`으로 넣는 init 스크립트(Playwright 1.63 `browserContext.js`와 같은 글)
const SERVICE_WORKER_BLOCK_SCRIPT: &str = "(() => {\n      \nif (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };\n\n    })();";
const MEDIA_BINDING: &str = "__bStudioMediaError__";

/// 시험에서 프록시 시작을 실패시킨다(프록시 없이 브라우저를 띄우지 않는지 확인한다)
#[cfg(test)]
static FAIL_PROXY_START: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct BrowserRunInput {
    /// 차례로 시도할 실행 파일(Playwright가 받은 Chromium, 설치된 Chrome). 모두 못 띄우면 `Unavailable`이다
    pub executables: Vec<String>,
    pub url: String,
    pub viewport: (u32, u32),
    /// `VIEWPORT_MEASURE_SCRIPT(texts)`로 만든 식. 글자를 넘기지 않았으면 없다
    pub viewport_script: Option<String>,
    /// 허용 출처. 있으면 출처 제한(요청 가로채기 + 프록시 + 서비스 워커 막기)을 켠다
    pub allowed_origins: Option<Vec<String>>,
    pub measure_load: bool,
    /// 모든 문서에 넣는 미디어 오류 수집 스크립트(`MEDIA_ERROR_INIT_SCRIPT`)
    pub media_error_script: String,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct BrowserRunOutput {
    pub status: Option<u16>,
    pub text: String,
    pub page_errors: Vec<String>,
    pub console_errors: Vec<String>,
    pub failed_requests: Vec<String>,
    pub media_errors: Vec<String>,
    pub blocked_requests: Vec<String>,
    pub horizontal_overflow_px: f64,
    /// `viewport_script`의 결과를 JSON 글로
    pub viewport_texts_json: Option<String>,
    pub load_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// 브라우저(또는 출처 제한 프록시)를 쓸 수 없다. 통과로 바꾸지 않고 "브라우저 없음"으로 알린다
    Unavailable(String),
    /// 이동·측정이 실패했다(첫 줄은 옛 러너의 오류 글과 같게 맞춘다)
    Failed(String),
    Aborted,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Unavailable(message) | RunError::Failed(message) => f.write_str(message),
            RunError::Aborted => f.write_str("취소되었습니다"),
        }
    }
}

#[derive(Default)]
struct OrderedSet {
    items: Vec<String>,
    seen: HashSet<String>,
}

impl OrderedSet {
    fn insert(&mut self, item: String) {
        if self.seen.insert(item.clone()) {
            self.items.push(item);
        }
    }
    fn contains(&self, item: &str) -> bool {
        self.seen.contains(item)
    }
    fn clear(&mut self) {
        self.items.clear();
        self.seen.clear();
    }
}

#[derive(Clone)]
enum Kind {
    Page,
    Iframe,
    Worker { parent_frame: String },
}

struct SessionInfo {
    kind: Kind,
    target_id: String,
}

struct Req {
    key: RequestKey,
    url: String,
    frame: String,
    is_favicon: bool,
    excluded_from_idle: bool,
}

#[derive(Clone, Copy)]
enum Resp {
    Status(u16),
    Failed,
}

#[derive(Default)]
struct State {
    frames: Option<FrameManager>,
    sessions: HashMap<String, SessionInfo>,
    page_session: Option<String>,
    requests: HashMap<String, Req>,
    responses: HashMap<RequestKey, Resp>,
    next_key: RequestKey,
    page_errors: Vec<String>,
    console_errors: Vec<String>,
    media_errors: Vec<String>,
    failed_requests: Vec<String>,
    failed_urls: HashSet<String>,
    /// 허용 출처 밖이라 막은 URL(경계에서 막은 것이라 앱의 실패로 세지 않는다)과 `CONNECT host:port`
    blocked_urls: OrderedSet,
    blocked_tunnels: HashSet<String>,
    /// 허용 출처 안을 막은 것: 서비스 워커 스크립트(`SERVICE-WORKER <url>`)와 낯선 모양의 요청. 실패 기록에서 빼는 목록과 섞지 않는다
    blocked_inside: OrderedSet,
    /// 페이지 쪽이 보낸 요청의 URL. 막은 기록에서 브라우저의 배경 요청을 거르는 데 쓴다
    seen_urls: HashSet<String>,
    /// 요청 가로채기가 한 번이라도 멈춘 네트워크 요청 id. 다시 멈추면 리다이렉트 홉이다
    paused_network_ids: HashSet<String>,
    disconnected: Option<String>,
    crashed: Option<String>,
}

impl State {
    fn frames(&mut self) -> &mut FrameManager {
        self.frames.as_mut().expect("프레임 관리자는 시작할 때 만든다")
    }

    fn fatal(&self) -> Option<String> {
        self.crashed.clone().or_else(|| self.disconnected.clone())
    }

    /// 워밍업 이동의 결과는 측정 대상이 아니므로 비운다(옛 러너와 같은 목록)
    fn reset_collected(&mut self) {
        self.page_errors.clear();
        self.console_errors.clear();
        self.failed_requests.clear();
        self.media_errors.clear();
        self.failed_urls.clear();
        self.blocked_urls.clear();
        self.blocked_tunnels.clear();
        self.seen_urls.clear();
        self.blocked_inside.clear();
        self.paused_network_ids.clear();
    }

    /// 실패한 요청 하나를 기록한다. 파비콘은 센 적도 없고, 같은 URL은 첫 기록만 남기며, 경계에서 막은 요청은 앱의 오류가 아니다
    fn record_failure(&mut self, url: &str, reason: &str) {
        let favicon = Url::parse(url).is_ok_and(|parsed| bstudio_guard::connection_judge::is_automatic_favicon_path(parsed.path()));
        let blocked_tunnel = !self.blocked_tunnels.is_empty() && tunnel_target(url).is_some_and(|target| self.blocked_tunnels.contains(&target));
        if favicon || self.failed_urls.contains(url) || self.blocked_urls.contains(url) || blocked_tunnel {
            return;
        }
        self.failed_urls.insert(url.to_owned());
        self.failed_requests.push(format!("{reason} {url}"));
    }

    /// 막은 요청 가운데 페이지 쪽(문서·프레임·워커·웹소켓)이 실제로 보낸 것만 돌려준다. 브라우저의 배경 요청(시간 동기화 등)도 프록시를
    /// 지나므로 함께 막지만 앱의 요청이 아니라 기록에서 뺀다. 막는 것은 그대로이고 기록만 거른다(ADR-198 결정 11)
    fn blocked_requests(&self) -> Vec<String> {
        let seen_tunnels: HashSet<String> = self.seen_urls.iter().filter_map(|url| tunnel_target(url)).collect();
        let mut result: Vec<String> = self
            .blocked_urls
            .items
            .iter()
            .filter(|entry| match entry.strip_prefix("CONNECT ") {
                Some(target) => seen_tunnels.contains(target),
                None => self.seen_urls.contains(entry.as_str()),
            })
            .cloned()
            .collect();
        result.extend(self.blocked_inside.items.iter().cloned());
        result
    }
}

struct Config {
    allowed: Option<Arc<Vec<String>>>,
    media_script: String,
    viewport: (u32, u32),
}

struct Shared {
    state: Mutex<State>,
    notify: Notify,
    /// 지금 시도 중인 브라우저의 연결. 실행 파일을 바꿔 다시 시도하면 새 연결로 바뀐다
    cdp: Mutex<Option<Cdp>>,
    /// 몇 번째 시도인가. 앞 시도의 늦은 이벤트·끊김 알림이 지금 시도의 상태를 건드리지 못하게 한다
    attempt: AtomicU64,
    config: Config,
}

impl Shared {
    fn cdp(&self) -> Cdp {
        self.cdp.lock().unwrap().clone().expect("연결은 처리기가 불리기 전에 만든다")
    }

    fn cdp_if_any(&self) -> Option<Cdp> {
        self.cdp.lock().unwrap().clone()
    }
}

enum WaitError {
    Timeout,
    Failed(String),
}

impl WaitError {
    fn into_run(self, timeout_message: &str) -> RunError {
        match self {
            WaitError::Timeout => RunError::Failed(timeout_message.to_owned()),
            WaitError::Failed(reason) => RunError::Failed(reason),
        }
    }
}

/// 조건이 될 때까지(또는 마감까지) 기다린다. 조건은 상태를 잠근 채 본다. 연결이 끊겼거나 페이지가 충돌했으면 `Failed`다
async fn wait_until<T>(shared: &Shared, deadline: Instant, mut check: impl FnMut(&mut State) -> Option<T>) -> Result<T, WaitError> {
    loop {
        let notified = shared.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let wake_at = {
            let mut state = shared.state.lock().unwrap();
            let now = Instant::now();
            state.frames().advance(now);
            if let Some(reason) = state.fatal() {
                return Err(WaitError::Failed(reason));
            }
            if let Some(value) = check(&mut state) {
                return Ok(value);
            }
            if now >= deadline {
                return Err(WaitError::Timeout);
            }
            state.frames().next_deadline().map_or(deadline, |timer| timer.min(deadline))
        };
        tokio::select! {
            _ = &mut notified => {}
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(wake_at)) => {}
        }
    }
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn handle_event(shared: &Arc<Shared>, event: Event) {
    {
        let mut state = shared.state.lock().unwrap();
        state.frames().advance(Instant::now());
        dispatch(shared, &mut state, event);
    }
    shared.notify.notify_waiters();
}

fn session_kind(state: &State, session_id: Option<&str>) -> Option<Kind> {
    session_id.and_then(|id| state.sessions.get(id)).map(|info| info.kind.clone())
}

fn dispatch(shared: &Arc<Shared>, state: &mut State, event: Event) {
    let params = &event.params;
    let session = event.session_id.as_deref();
    match event.method.as_str() {
        "Target.attachedToTarget" => on_attached(shared, state, session, params),
        "Target.detachedFromTarget" => {
            if let Some(child) = str_at(params, "/sessionId") {
                if let Some(info) = state.sessions.remove(child) {
                    if matches!(info.kind, Kind::Iframe) {
                        state.frames().frame_detached(&info.target_id);
                    }
                }
            }
        }
        "Inspector.targetCrashed" => state.crashed = Some("페이지가 충돌했습니다 (Page crashed)".to_owned()),
        // 아래는 페이지·프레임·워커 세션의 이벤트다. 모르는 세션(떼어 낸 것)의 이벤트는 버린다
        method => {
            let Some(kind) = session_kind(state, session) else { return };
            let session_id = session.unwrap_or_default();
            match method {
                "Page.frameAttached" => {
                    let frame = str_at(params, "/frameId").unwrap_or_default();
                    let parent = str_at(params, "/parentFrameId");
                    // 부모를 모르는 자식은 무시한다(Playwright와 같다)
                    if parent.is_none_or(|parent| state.frames().has_frame(parent)) {
                        state.frames().frame_attached(frame, parent);
                    }
                }
                "Page.frameDetached" => {
                    let frame = str_at(params, "/frameId").unwrap_or_default();
                    // 프로세스를 옮기는 교체(swap)는 프레임이 없어지는 것이 아니다
                    if str_at(params, "/reason") != Some("swap") {
                        state.frames().frame_detached(frame);
                    }
                }
                "Page.frameNavigated" => {
                    if let Some(frame) = params.get("frame") {
                        let url = format!("{}{}", str_at(frame, "/url").unwrap_or_default(), str_at(frame, "/urlFragment").unwrap_or_default());
                        state.frames().frame_committed_new_document(str_at(frame, "/id").unwrap_or_default(), &url, str_at(frame, "/loaderId").unwrap_or_default());
                    }
                }
                "Page.navigatedWithinDocument" => {
                    state.frames().frame_committed_same_document(str_at(params, "/frameId").unwrap_or_default(), str_at(params, "/url").unwrap_or_default());
                }
                "Page.frameRequestedNavigation" => {
                    if str_at(params, "/disposition") == Some("currentTab") {
                        state.frames().frame_requested_navigation(str_at(params, "/frameId").unwrap_or_default());
                    }
                }
                "Page.lifecycleEvent" => {
                    let frame = str_at(params, "/frameId").unwrap_or_default();
                    match str_at(params, "/name") {
                        Some("load") => state.frames().lifecycle_event(frame, "load"),
                        Some("DOMContentLoaded") => state.frames().lifecycle_event(frame, "domcontentloaded"),
                        _ => {}
                    }
                }
                // 대화상자가 떠 있으면 페이지가 멈춘다. 듣는 쪽이 없으면 beforeunload만 수락하고 나머지는 닫는다(Playwright와 같다)
                "Page.javascriptDialogOpening" => {
                    let accept = str_at(params, "/type") == Some("beforeunload");
                    shared.cdp().fire(Some(session_id), "Page.handleJavaScriptDialog", json!({ "accept": accept }));
                }
                "Runtime.consoleAPICalled" => {
                    // 실행 컨텍스트가 0이면 페이지가 남긴 것이 아니다
                    if !matches!(kind, Kind::Worker { .. }) && params.get("executionContextId").and_then(Value::as_i64) == Some(0) {
                        return;
                    }
                    if str_at(params, "/type") == Some("error") {
                        let args: Vec<Value> = params.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
                        let text = console_text(&args);
                        // 리소스 로드 실패는 브라우저가 URL 없이 남기는 문구라 원인을 알 수 없다. 요청 이벤트에서 URL과 함께 따로 모은다
                        if !text.starts_with("Failed to load resource") {
                            state.console_errors.push(text);
                        }
                    }
                }
                "Runtime.exceptionThrown" => {
                    if let Some(details) = params.get("exceptionDetails") {
                        state.page_errors.push(exception_message(details));
                    }
                }
                "Runtime.bindingCalled" => {
                    if str_at(params, "/name") == Some(MEDIA_BINDING) {
                        state.media_errors.push(str_at(params, "/payload").unwrap_or_default().to_owned());
                    }
                }
                // 브라우저가 스스로 남기는 콘솔 항목(콘텐츠 보안 정책 위반 등). 워커에서 온 것은 워커 세션이 따로 알린다
                "Log.entryAdded" => {
                    let entry = params.get("entry").cloned().unwrap_or(Value::Null);
                    if str_at(&entry, "/source") != Some("worker") && str_at(&entry, "/level") == Some("error") {
                        let text = str_at(&entry, "/text").unwrap_or_default();
                        if !text.starts_with("Failed to load resource") {
                            state.console_errors.push(text.to_owned());
                        }
                    }
                }
                "Network.requestWillBeSent" => on_request_will_be_sent(state, &kind, params),
                "Network.responseReceived" => on_response_received(state, params),
                "Network.loadingFinished" => {
                    if let Some(request) = str_at(params, "/requestId").and_then(|id| state.requests.remove(id)) {
                        let frame = request.frame.clone();
                        state.frames().request_finished(request.key, &frame, request.excluded_from_idle);
                    }
                }
                "Network.loadingFailed" => on_loading_failed(state, params),
                "Network.webSocketCreated" => {
                    if let Some(url) = str_at(params, "/url") {
                        state.seen_urls.insert(url.to_owned());
                    }
                }
                "Fetch.requestPaused" => on_request_paused(shared, state, session_id, params),
                _ => {}
            }
        }
    }
}

fn on_attached(shared: &Arc<Shared>, state: &mut State, parent_session: Option<&str>, params: &Value) {
    let Some(child) = str_at(params, "/sessionId").map(str::to_owned) else { return };
    let info = params.get("targetInfo").cloned().unwrap_or(Value::Null);
    let target_id = str_at(&info, "/targetId").unwrap_or_default().to_owned();
    let target_type = str_at(&info, "/type").unwrap_or_default();
    // 떼어 내는 명령은 그 대상을 붙인 쪽의 세션으로 보낸다(부모 세션이 붙인 자식은 부모 세션으로. 브라우저 수준으로 보내면 떼어지지 않아 멈춘 채 남는다)
    let detach = |shared: &Arc<Shared>, child: &str| shared.cdp().fire(parent_session, "Target.detachFromTarget", json!({ "sessionId": child }));
    match (parent_session, target_type) {
        // 브라우저 수준: 우리가 만든 페이지 하나만 쓴다. 팝업과 그 밖의 것은 떼어 낸다(떼면 멈춰 있던 대상이 이어서 돈다)
        (None, "page") if state.page_session.is_none() => {
            state.page_session = Some(child.clone());
            state.sessions.insert(child, SessionInfo { kind: Kind::Page, target_id });
        }
        // 서비스 워커 대상은 등록하는 도중(스크립트를 받기 전)에도 붙는다. 보지 않고 떼어 내 이어서 돌게 한다. 막는 것은 init 스크립트(`register`를 바꿈)와
        // 프록시(스크립트 요청 차단)이고, 이미 있을 수 있는 서비스 워커가 페이지 요청을 가로채지 못하게 `setBypassServiceWorker`를 켠다
        (None, "service_worker") => detach(shared, &child),
        (Some(_), "iframe") => {
            let parent_frame = str_at(&info, "/parentFrameId").map(str::to_owned);
            let parent_known = parent_frame.as_deref().is_none_or(|parent| state.frames().has_frame(parent));
            if !parent_known {
                detach(shared, &child);
                return;
            }
            state.frames().frame_attached(&target_id, parent_frame.as_deref());
            state.sessions.insert(child.clone(), SessionInfo { kind: Kind::Iframe, target_id });
            tokio::spawn(setup_child(shared.clone(), child, false));
        }
        (Some(parent), "worker") => {
            let parent_frame = str_at(&info, "/parentFrameId").map(str::to_owned).or_else(|| state.sessions.get(parent).map(|session| session.target_id.clone())).unwrap_or_default();
            state.sessions.insert(child.clone(), SessionInfo { kind: Kind::Worker { parent_frame }, target_id });
            tokio::spawn(setup_child(shared.clone(), child, true));
        }
        _ => detach(shared, &child),
    }
}

fn on_request_will_be_sent(state: &mut State, kind: &Kind, params: &Value) {
    let url = str_at(params, "/request/url").unwrap_or_default().to_owned();
    if url.starts_with("data:") {
        return;
    }
    let request_id = str_at(params, "/requestId").unwrap_or_default().to_owned();
    let mut redirected_from_favicon = false;
    if let Some(redirect) = params.get("redirectResponse") {
        // 리다이렉트: 앞 홉은 응답을 받고 끝난 것으로 센다(상태가 400 이상이면 실패 기록도 한다)
        if let Some(previous) = state.requests.remove(&request_id) {
            let status = redirect.get("status").and_then(Value::as_u64).unwrap_or(0) as u16;
            state.responses.insert(previous.key, Resp::Status(status));
            if !previous.is_favicon && status >= 400 {
                state.record_failure(&previous.url, &status.to_string());
            }
            let frame = previous.frame.clone();
            state.frames().request_finished(previous.key, &frame, previous.excluded_from_idle);
            redirected_from_favicon = previous.is_favicon;
        }
    }
    let frame_id = str_at(params, "/frameId");
    let frame = match (frame_id, kind) {
        (Some(id), _) if state.frames().has_frame(id) => Some(id.to_owned()),
        (None, Kind::Worker { parent_frame }) if state.frames().has_frame(parent_frame) => Some(parent_frame.clone()),
        _ => None,
    };
    // 어느 프레임의 요청인지 모르면 Playwright는 요청으로 세지 않는다
    let Some(frame) = frame else { return };
    let is_favicon = url.ends_with("/favicon.ico") || redirected_from_favicon;
    let loader_id = str_at(params, "/loaderId").unwrap_or_default();
    let document_id = (request_id == loader_id && str_at(params, "/type") == Some("Document")).then(|| loader_id.to_owned());
    let excluded = is_favicon || str_at(params, "/type") == Some("EventSource");
    state.next_key += 1;
    let key = state.next_key;
    state.frames().request_started(key, &frame, document_id.as_deref(), excluded);
    if !is_favicon {
        state.seen_urls.insert(url.clone());
    }
    state.requests.insert(request_id, Req { key, url, frame, is_favicon, excluded_from_idle: excluded });
}

fn on_response_received(state: &mut State, params: &Value) {
    let Some(request_id) = str_at(params, "/requestId") else { return };
    let status = params.pointer("/response/status").and_then(Value::as_u64).unwrap_or(0) as u16;
    let Some(request) = state.requests.get(request_id) else { return };
    let (key, url, favicon) = (request.key, request.url.clone(), request.is_favicon);
    state.responses.insert(key, Resp::Status(status));
    if !favicon && status >= 400 {
        state.record_failure(&url, &status.to_string());
    }
}

fn on_loading_failed(state: &mut State, params: &Value) {
    let Some(request) = str_at(params, "/requestId").and_then(|id| state.requests.remove(id)) else { return };
    // 오류 글: errorText || blockedReason || ""
    let text = [str_at(params, "/errorText"), str_at(params, "/blockedReason")].into_iter().flatten().find(|text| !text.is_empty()).unwrap_or("").to_owned();
    let canceled = params.get("canceled").and_then(Value::as_bool).unwrap_or(false);
    state.responses.entry(request.key).or_insert(Resp::Failed);
    let frame = request.frame.clone();
    state.frames().request_failed(request.key, &frame, request.excluded_from_idle, &text, canceled);
    if !request.is_favicon {
        state.record_failure(&request.url, &text);
    }
}

/// 요청 가로채기(첫 층). 허용 출처 안이면 보내고, 밖이면 막고 기록한다. 리다이렉트 홉도 같은 이벤트로 온다. 모르는 요청은 막는다.
/// 파비콘 요청은 Playwright처럼 판정 없이 중단한다(앱의 요청이 아니다)
fn on_request_paused(shared: &Arc<Shared>, state: &mut State, session_id: &str, params: &Value) {
    let Some(request_id) = str_at(params, "/requestId") else { return };
    let url = str_at(params, "/request/url").unwrap_or_default();
    // 리다이렉트 홉은 같은 `networkId`로 다시 멈춘다(실측: Chrome 153에서는 `redirectedRequestId` 없이 온다). 어느 쪽이든 홉으로 본다
    let first_for_network_id = str_at(params, "/networkId").is_none_or(|id| state.paused_network_ids.insert(id.to_owned()));
    let is_redirect_hop = !first_for_network_id || params.get("redirectedRequestId").is_some();
    let Some(allowed) = &shared.config.allowed else {
        shared.cdp().fire(Some(session_id), "Fetch.continueRequest", json!({ "requestId": request_id }));
        return;
    };
    if url.ends_with("/favicon.ico") {
        shared.cdp().fire(Some(session_id), "Fetch.failRequest", json!({ "requestId": request_id, "errorReason": "Aborted" }));
    } else if is_allowed_url(url, allowed) {
        shared.cdp().fire(Some(session_id), "Fetch.continueRequest", json!({ "requestId": request_id }));
    } else {
        // 옛 러너는 리다이렉트 홉을 Playwright의 라우트가 보지 못해 프록시가 막았고, https 홉은 URL을 모르는 터널(`CONNECT host:port`)로 남겼다.
        // 같은 글로 남기려고 https 리다이렉트 홉은 터널 꼴로 적는다(요청 자체는 이 층에서 URL을 보고 막는다)
        let tunnel = is_redirect_hop && Url::parse(url).is_ok_and(|parsed| parsed.scheme() == "https");
        match tunnel.then(|| tunnel_target(url)).flatten() {
            Some(target) => {
                state.blocked_urls.insert(format!("CONNECT {target}"));
                state.blocked_tunnels.insert(target);
            }
            None => state.blocked_urls.insert(url.to_owned()),
        }
        shared.cdp().fire(Some(session_id), "Fetch.failRequest", json!({ "requestId": request_id, "errorReason": "BlockedByClient" }));
    }
}

/// 프록시가 알린 막은 요청을 기록한다. 허용 출처 안의 주소를 막은 것(서비스 워커 스크립트, 낯선 모양)은 따로 모아 같은 주소의 진짜 실패를 가리지 않는다
fn on_proxy_blocked(shared: &Arc<Shared>, block: ProxyBlock) {
    {
        let mut state = shared.state.lock().unwrap();
        let allowed = shared.config.allowed.clone().unwrap_or_default();
        match block {
            ProxyBlock::Url(url) => {
                if is_allowed_url(&url, &allowed) {
                    state.blocked_inside.insert(url);
                } else {
                    state.blocked_urls.insert(url);
                }
            }
            ProxyBlock::ServiceWorker(url) => state.blocked_inside.insert(format!("SERVICE-WORKER {url}")),
            ProxyBlock::Tunnel(authority) => {
                // 터널(https·웹소켓)은 URL을 알 수 없어 접속하려던 host:port로 남긴다
                state.blocked_urls.insert(format!("CONNECT {authority}"));
                state.blocked_tunnels.insert(authority);
            }
        }
    }
    shared.notify.notify_waiters();
}

async fn send_ok(shared: &Shared, session: &str, method: &str, params: Value) -> Result<Value, RunError> {
    shared.cdp().send(Some(session), method, params).await.map_err(|error: CdpError| RunError::Failed(format!("{method}: {error}")))
}

/// 메인 페이지 세션을 준비한다(Playwright가 보내는 것과 같은 설정). 끝에서 멈춰 있던 대상을 깨운다
async fn setup_page(shared: &Arc<Shared>, session: &str) -> Result<(), RunError> {
    let (width, height) = shared.config.viewport;
    let window = shared.cdp().send(Some(session), "Browser.getWindowForTarget", json!({})).await.ok();
    send_ok(shared, session, "Page.enable", json!({})).await?;
    let tree = send_ok(shared, session, "Page.getFrameTree", json!({})).await?;
    {
        let mut state = shared.state.lock().unwrap();
        register_frame_tree(&mut state, tree.get("frameTree").unwrap_or(&Value::Null));
    }
    shared.notify.notify_waiters();
    send_ok(shared, session, "Log.enable", json!({})).await?;
    send_ok(shared, session, "Page.setLifecycleEventsEnabled", json!({ "enabled": true })).await?;
    send_ok(shared, session, "Runtime.enable", json!({})).await?;
    send_ok(shared, session, "Network.enable", json!({})).await?;
    send_ok(shared, session, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })).await?;
    send_ok(shared, session, "Emulation.setFocusEmulationEnabled", json!({ "enabled": true })).await?;
    if let Some(window_id) = window.as_ref().and_then(|value| value.get("windowId")).and_then(Value::as_i64) {
        let _ = shared.cdp().send(Some(session), "Browser.setWindowBounds", json!({ "windowId": window_id, "bounds": { "width": width, "height": height } })).await;
    }
    send_ok(
        shared,
        session,
        "Emulation.setDeviceMetricsOverride",
        json!({ "mobile": false, "width": width, "height": height, "screenWidth": width, "screenHeight": height, "deviceScaleFactor": 1, "screenOrientation": { "angle": 0, "type": "landscapePrimary" } }),
    )
    .await?;
    if let Some(fonts) = font_families() {
        send_ok(shared, session, "Page.setFontFamilies", fonts).await?;
    }
    send_ok(
        shared,
        session,
        "Emulation.setEmulatedMedia",
        json!({ "media": "", "features": [
            { "name": "prefers-color-scheme", "value": "light" },
            { "name": "prefers-reduced-motion", "value": "no-preference" },
            { "name": "forced-colors", "value": "none" },
            { "name": "prefers-contrast", "value": "no-preference" } ] }),
    )
    .await?;
    enable_interception_and_scripts(shared, session).await?;
    send_ok(shared, session, "Runtime.runIfWaitingForDebugger", json!({})).await?;
    Ok(())
}

/// 요청 가로채기·서비스 워커 막기·미디어 오류 수집을 건다. 페이지 세션과 OOPIF iframe 세션이 같다
async fn enable_interception_and_scripts(shared: &Arc<Shared>, session: &str) -> Result<(), RunError> {
    if shared.config.allowed.is_some() {
        // 서비스 워커를 막는다. init 스크립트(옛 러너와 같은 글)로 `register`를 바꾸고, 이미 있을 수 있는 서비스 워커가 요청을 가로채지 못하게 우회시킨다
        send_ok(shared, session, "Page.addScriptToEvaluateOnNewDocument", json!({ "source": SERVICE_WORKER_BLOCK_SCRIPT, "runImmediately": true })).await?;
        send_ok(shared, session, "Network.setBypassServiceWorker", json!({ "bypass": true })).await?;
        send_ok(shared, session, "Network.setCacheDisabled", json!({ "cacheDisabled": true })).await?;
        send_ok(shared, session, "Fetch.enable", json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] })).await?;
    }
    send_ok(shared, session, "Runtime.addBinding", json!({ "name": MEDIA_BINDING })).await?;
    send_ok(shared, session, "Page.addScriptToEvaluateOnNewDocument", json!({ "source": shared.config.media_script, "runImmediately": true })).await?;
    Ok(())
}

fn register_frame_tree(state: &mut State, tree: &Value) {
    let Some(frame) = tree.get("frame") else { return };
    let id = str_at(frame, "/id").unwrap_or_default();
    state.frames().frame_attached(id, str_at(frame, "/parentId"));
    let url = format!("{}{}", str_at(frame, "/url").unwrap_or_default(), str_at(frame, "/urlFragment").unwrap_or_default());
    state.frames().frame_committed_new_document(id, &url, str_at(frame, "/loaderId").unwrap_or_default());
    for child in tree.get("childFrames").and_then(Value::as_array).into_iter().flatten() {
        register_frame_tree(state, child);
    }
}

fn font_families() -> Option<Value> {
    let all: Value = serde_json::from_str(include_str!("font_families.json")).ok()?;
    let platform = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "windows") {
        "win"
    } else {
        "linux"
    };
    all.get(platform).cloned()
}

/// 새로 붙은 iframe·워커 세션을 준비한다. 실패해도 이 대상만의 일이다(프록시가 둘째 층으로 막는다). 끝에서 멈춰 있던 대상을 깨운다
async fn setup_child(shared: Arc<Shared>, session: String, is_worker: bool) {
    let cdp = shared.cdp();
    let send = |method: &'static str, params: Value| {
        let cdp = cdp.clone();
        let session = session.clone();
        async move { let _ = cdp.send(Some(&session), method, params).await; }
    };
    if is_worker {
        send("Runtime.enable", json!({})).await;
        send("Network.enable", json!({})).await;
        if shared.config.allowed.is_some() {
            // 워커에서 Fetch를 못 쓰는 브라우저도 있다. 그때는 프록시가 막는다
            send("Network.setCacheDisabled", json!({ "cacheDisabled": true })).await;
            send("Fetch.enable", json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] })).await;
        }
        send("Runtime.runIfWaitingForDebugger", json!({})).await;
        send("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })).await;
    } else {
        send("Page.enable", json!({})).await;
        send("Log.enable", json!({})).await;
        send("Page.setLifecycleEventsEnabled", json!({ "enabled": true })).await;
        send("Runtime.enable", json!({})).await;
        send("Network.enable", json!({})).await;
        send("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })).await;
        let _ = enable_interception_and_scripts(&shared, &session).await;
        send("Runtime.runIfWaitingForDebugger", json!({})).await;
    }
}

fn goto_timeout() -> RunError {
    RunError::Failed(format!("page.goto: Timeout {}ms exceeded.", NAVIGATION_TIMEOUT.as_millis()))
}

/// `page.goto(url, { waitUntil: 'load', timeout: 30000 })`. 최종 문서 응답의 상태 코드를 돌려준다(응답이 없으면 `None`)
async fn goto(shared: &Arc<Shared>, session: &str, url: &str) -> Result<Option<u16>, RunError> {
    let deadline = Instant::now() + NAVIGATION_TIMEOUT;
    let (main_frame, nav_from) = {
        let mut state = shared.state.lock().unwrap();
        (state.frames().main_frame_id().unwrap_or_default().to_owned(), state.frames().nav_events.len())
    };
    let cdp = shared.cdp();
    let navigate = cdp.send(Some(session), "Page.navigate", json!({ "url": url, "frameId": main_frame, "referrerPolicy": "unsafeUrl" }));
    let reply = match tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), navigate).await {
        Err(_) => return Err(goto_timeout()),
        Ok(Err(error)) => return Err(RunError::Failed(format!("page.goto: {error}"))),
        Ok(Ok(reply)) => reply,
    };
    if reply.get("isDownload").and_then(Value::as_bool) == Some(true) {
        return Err(RunError::Failed("page.goto: Download is starting".to_owned()));
    }
    if let Some(error_text) = str_at(&reply, "/errorText") {
        return Err(RunError::Failed(format!("page.goto: {error_text} at {url}")));
    }
    let loader = str_at(&reply, "/loaderId").map(str::to_owned);
    let event = wait_until(shared, deadline, |state| {
        state.frames().nav_events[nav_from..]
            .iter()
            .find(|event| match &loader {
                Some(loader) => event.new_document.as_ref().is_some_and(|doc| doc.document_id.as_deref() == Some(loader.as_str()) || event.error.is_none()),
                None => event.new_document.is_none(),
            })
            .cloned()
    })
    .await
    .map_err(|error| error.into_run(&format!("page.goto: Timeout {}ms exceeded.", NAVIGATION_TIMEOUT.as_millis())))?;
    if let (Some(loader), Some(doc)) = (&loader, &event.new_document) {
        if doc.document_id.as_deref() != Some(loader.as_str()) {
            return Err(RunError::Failed(format!("page.goto: Navigation to \"{url}\" is interrupted by another navigation to \"{}\"", event.url)));
        }
    }
    if let Some(error) = &event.error {
        return Err(RunError::Failed(format!("page.goto: {}", error.text)));
    }
    wait_until(shared, deadline, |state| state.frames().main_has_lifecycle("load", event.lifecycle_pos).then_some(()))
        .await
        .map_err(|error| error.into_run(&format!("page.goto: Timeout {}ms exceeded.", NAVIGATION_TIMEOUT.as_millis())))?;
    // 응답: 최종 요청의 응답(리다이렉트를 따라간 끝). 요청이 없는 문서(about:blank 등)는 null
    let Some(request) = event.new_document.as_ref().and_then(|doc| doc.request) else { return Ok(None) };
    let response = wait_until(shared, deadline, |state| state.responses.get(&request).copied())
        .await
        .map_err(|error| error.into_run(&format!("page.goto: Timeout {}ms exceeded.", NAVIGATION_TIMEOUT.as_millis())))?;
    Ok(match response {
        Resp::Status(status) => Some(status),
        Resp::Failed => None,
    })
}

/// 페이지 안에서 식을 평가해 값을 JSON으로 받는다
async fn evaluate(shared: &Arc<Shared>, session: &str, expression: &str) -> Result<Value, RunError> {
    let cdp = shared.cdp();
    let call = cdp.send(Some(session), "Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }));
    let reply = match tokio::time::timeout(EVALUATE_TIMEOUT, call).await {
        Err(_) => return Err(RunError::Failed("page.evaluate: Timeout".to_owned())),
        Ok(Err(error)) => return Err(RunError::Failed(format!("page.evaluate: {error}"))),
        Ok(Ok(reply)) => reply,
    };
    if let Some(details) = reply.get("exceptionDetails") {
        return Err(RunError::Failed(format!("page.evaluate: {}", exception_message(details).lines().next().unwrap_or(""))));
    }
    Ok(reply.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

struct Session {
    process: BrowserProcess,
    profile: ProfileDir,
}

/// 프록시 뒤에서 띄울 때의 실행 인자. loopback도 프록시를 지나게 한다(허용 출처가 바로 loopback이다. 빠지면 Chromium이 loopback을 프록시 없이 보내 프록시가 아무것도 보지 못한다).
/// WebRTC의 UDP는 HTTP 프록시를 지나지 않아 막는다. 인자 이름은 둘 다 넣는다: headless shell은 `--force-webrtc-ip-handling-policy`만,
/// 시스템 Google Chrome은 `--webrtc-ip-handling-policy`만 따른다(ADR-198 결정 7)
fn proxy_launch_args(server: &str) -> Vec<String> {
    vec![
        format!("--proxy-server={server}"),
        "--proxy-bypass-list=<-loopback>".to_owned(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_owned(),
        "--webrtc-ip-handling-policy=disable_non_proxied_udp".to_owned(),
    ]
}

/// `Target.createBrowserContext`의 매개변수. 프록시를 쓰면 컨텍스트도 같은 프록시와 `<-loopback>`으로 만든다
fn context_params(proxy_server: Option<&str>) -> Value {
    let mut params = json!({ "disposeOnDetach": true });
    if let Some(server) = proxy_server {
        params["proxyServer"] = json!(server);
        params["proxyBypassList"] = json!("<-loopback>");
    }
    params
}

async fn launch_one(shared: &Arc<Shared>, executable: &str, proxy_server: Option<&str>) -> Result<Session, String> {
    if !Path::new(executable).is_file() {
        return Err(format!("browserType.launch: Executable doesn't exist at {executable}"));
    }
    let profile = ProfileDir::create().map_err(|error| format!("browserType.launch: 임시 프로필 폴더를 만들 수 없습니다: {error}"))?;
    let args = proxy_server.map(proxy_launch_args).unwrap_or_default();
    #[cfg(unix)]
    {
        let (mut process, pipes) = match super::launch::spawn(Path::new(executable), &args, profile.path()) {
            Ok(spawned) => spawned,
            Err(error) => {
                let _ = profile.remove();
                return Err(format!("browserType.launch: {error}"));
            }
        };
        // 새 시도: 앞 시도가 남긴 상태를 비우고 번호를 올린다
        let attempt = shared.attempt.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut state = shared.state.lock().unwrap();
            state.disconnected = None;
            state.page_session = None;
            state.sessions.clear();
        }
        let cdp = {
            let handler_state = shared.clone();
            let close_state = shared.clone();
            Cdp::start(
                pipes.from_browser,
                pipes.to_browser,
                move |event| {
                    if handler_state.attempt.load(Ordering::SeqCst) == attempt {
                        handle_event(&handler_state, event);
                    }
                },
                move |reason| {
                    if close_state.attempt.load(Ordering::SeqCst) == attempt {
                        close_state.state.lock().unwrap().disconnected = Some(reason);
                        close_state.notify.notify_waiters();
                    }
                },
            )
        };
        *shared.cdp.lock().unwrap() = Some(cdp.clone());
        let handshake = tokio::time::timeout(LAUNCH_TIMEOUT, cdp.send(None, "Browser.getVersion", json!({}))).await;
        match handshake {
            Ok(Ok(_)) => Ok(Session { process, profile }),
            other => {
                let why = match other {
                    Ok(Err(error)) => error.message,
                    _ => format!("브라우저가 {}초 안에 응답하지 않았습니다", LAUNCH_TIMEOUT.as_secs()),
                };
                process.kill_now().await;
                cdp.shutdown();
                let tail = process.stderr_tail.lock().unwrap().lines().last().unwrap_or("").to_owned();
                let _ = profile.remove();
                Err(format!("browserType.launch: {why}{}", if tail.is_empty() { String::new() } else { format!(" ({tail})") }))
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (shared, args, profile);
        Err("browserType.launch: 이 운영체제에서는 화면 확인 러너를 지원하지 않습니다".to_owned())
    }
}

async fn drive(shared: &Arc<Shared>, input: &BrowserRunInput, session: &Session, proxy_server: Option<&str>) -> Result<BrowserRunOutput, RunError> {
    let cdp = shared.cdp();
    let browser = |method: &'static str, params: Value| {
        let cdp = cdp.clone();
        async move { cdp.send(None, method, params).await.map_err(|error| RunError::Failed(format!("{method}: {error}"))) }
    };
    browser("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })).await?;
    let context = browser("Target.createBrowserContext", context_params(proxy_server)).await?;
    let context_id = str_at(&context, "/browserContextId").unwrap_or_default().to_owned();
    let downloads = session.profile.path().join("downloads");
    browser("Browser.setDownloadBehavior", json!({ "behavior": "allowAndName", "browserContextId": context_id, "downloadPath": downloads.display().to_string(), "eventsEnabled": true })).await?;
    browser("Target.createTarget", json!({ "url": "about:blank", "browserContextId": context_id })).await?;
    let page = wait_until(shared, Instant::now() + LAUNCH_TIMEOUT, |state| state.page_session.clone())
        .await
        .map_err(|error| error.into_run("페이지를 만들지 못했습니다"))?;
    setup_page(shared, &page).await?;

    if input.measure_load {
        // 개발 서버 첫 컴파일(콜드 스타트)이 첫 로드를 튀게 한다. 한 번 워밍업 이동 뒤에 잰다. 워밍업의 오류·실패 요청은 측정 대상이 아니다
        goto(shared, &page, &input.url).await?;
        shared.state.lock().unwrap().reset_collected();
    }
    let status = goto(shared, &page, &input.url).await?;
    // 네트워크가 잠잠해질 때까지 상한까지 기다린다. 상한을 넘겨도 오류로 만들지 않는다. 연결이 끊겼으면 오류다
    let from = shared.state.lock().unwrap().frames().lifecycle_log.len();
    match wait_until(shared, Instant::now() + SETTLE_TIMEOUT, |state| state.frames().main_has_lifecycle("networkidle", from).then_some(())).await {
        Ok(()) | Err(WaitError::Timeout) => {}
        Err(WaitError::Failed(reason)) => return Err(RunError::Failed(reason)),
    }

    let measured = evaluate(shared, &page, "({ text: document.body ? document.body.innerText : '', overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) })").await?;
    let viewport_texts_json = match &input.viewport_script {
        Some(script) => Some(serde_json::to_string(&evaluate(shared, &page, script).await?).unwrap_or_default()),
        None => None,
    };
    let load_ms = if input.measure_load {
        evaluate(shared, &page, "(() => { const nav = performance.getEntriesByType('navigation')[0]; return nav ? Math.round(nav.loadEventEnd - nav.startTime) : null; })()").await?.as_f64()
    } else {
        None
    };
    // 평가 응답을 받은 시점에는 그 앞의 이벤트가 모두 상태에 들어 있다. 끊겼다면 결과를 돌려주지 않는다
    let state = shared.state.lock().unwrap();
    if let Some(reason) = state.fatal() {
        return Err(RunError::Failed(reason));
    }
    Ok(BrowserRunOutput {
        status,
        text: measured.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
        page_errors: state.page_errors.clone(),
        console_errors: state.console_errors.clone(),
        failed_requests: state.failed_requests.clone(),
        media_errors: state.media_errors.clone(),
        blocked_requests: state.blocked_requests(),
        horizontal_overflow_px: measured.get("overflow").and_then(Value::as_f64).unwrap_or(0.0),
        viewport_texts_json,
        load_ms,
    })
}

async fn shutdown(shared: &Arc<Shared>, session: Session) {
    let Session { mut process, profile } = session;
    if let Some(cdp) = shared.cdp_if_any() {
        let _ = tokio::time::timeout(Duration::from_secs(2), cdp.send(None, "Browser.close", json!({}))).await;
    }
    process.wait_or_kill(Duration::from_secs(5)).await;
    if let Some(cdp) = shared.cdp_if_any() {
        cdp.shutdown();
    }
    let _ = profile.remove();
}

/// 페이지를 열어 결과를 모은다. 취소되면 브라우저·프록시·임시 폴더를 정리한 뒤 `Aborted`로 끝난다
pub async fn run_in_browser(input: &BrowserRunInput, cancel: &Cancel) -> Result<BrowserRunOutput, RunError> {
    if cancel.is_cancelled() {
        return Err(RunError::Aborted);
    }
    let shared = Arc::new(Shared {
        state: Mutex::new(State { frames: Some(FrameManager::new(Instant::now())), ..State::default() }),
        notify: Notify::new(),
        cdp: Mutex::new(None),
        attempt: AtomicU64::new(0),
        config: Config { allowed: input.allowed_origins.clone().map(Arc::new), media_script: input.media_error_script.clone(), viewport: input.viewport },
    });
    // 허용 출처가 주어졌는데 프록시를 세우지 못하면 프록시 없이 브라우저를 띄우지 않는다(통과시키지 않고 "브라우저 없음"으로 알린다)
    let proxy = match &shared.config.allowed {
        Some(allowed) => {
            let judged = allowed.clone();
            let notify_shared = shared.clone();
            #[cfg(test)]
            let forced_failure = FAIL_PROXY_START.load(Ordering::SeqCst);
            #[cfg(not(test))]
            let forced_failure = false;
            let started = if forced_failure {
                Err(std::io::Error::other("시험이 프록시 시작을 실패시켰습니다"))
            } else {
                OriginProxy::start(Arc::new(move |url: &str| is_allowed_url(url, &judged)), Arc::new(move |block| on_proxy_blocked(&notify_shared, block))).await
            };
            match started {
                Ok(proxy) => Some(proxy),
                Err(error) => return Err(RunError::Unavailable(format!("출처 제한 프록시를 시작할 수 없습니다: {error}"))),
            }
        }
        None => None,
    };
    let proxy_server = proxy.as_ref().map(|proxy| proxy.server.clone());

    let mut failures = Vec::new();
    let mut launched = None;
    for executable in &input.executables {
        let attempt = tokio::select! {
            attempt = launch_one(&shared, executable, proxy_server.as_deref()) => attempt,
            _ = cancel.cancelled() => {
                if let Some(proxy) = &proxy { proxy.close(); }
                return Err(RunError::Aborted);
            }
        };
        match attempt {
            Ok(session) => {
                launched = Some(session);
                break;
            }
            Err(message) => failures.push(message),
        }
    }
    let Some(session) = launched else {
        if let Some(proxy) = &proxy {
            proxy.close();
        }
        return Err(RunError::Unavailable(format!("헤드리스 브라우저를 실행할 수 없습니다: {}", failures.join(" / "))));
    };

    let outcome = tokio::select! {
        outcome = drive(&shared, input, &session, proxy_server.as_deref()) => outcome,
        _ = cancel.cancelled() => Err(RunError::Aborted),
    };
    // 브라우저를 닫은 뒤에 프록시를 닫는다. 열려 있는 연결도 여기서 끊긴다
    shutdown(&shared, session).await;
    if let Some(proxy) = &proxy {
        proxy.close();
    }
    if cancel.is_cancelled() {
        return Err(RunError::Aborted);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        State { frames: Some(FrameManager::new(Instant::now())), ..State::default() }
    }

    #[test]
    fn failures_skip_favicons_duplicates_and_blocked_requests() {
        let mut state = state();
        state.record_failure("http://h/favicon.ico", "404");
        state.record_failure("http://h/a.js", "404");
        state.record_failure("http://h/a.js", "net::ERR_ABORTED");
        state.blocked_urls.insert("http://other/x".to_owned());
        state.record_failure("http://other/x", "net::ERR_BLOCKED_BY_CLIENT");
        state.blocked_tunnels.insert("127.0.0.1:9".to_owned());
        state.record_failure("https://127.0.0.1:9/tls", "net::ERR_TUNNEL_CONNECTION_FAILED");
        // 쿼리가 붙은 파비콘 경로도 경로가 `/favicon.ico`면 센 적이 없다
        state.record_failure("http://h/favicon.ico?x=1", "404");
        state.record_failure("http://h/dir/favicon.ico", "404");
        assert_eq!(state.failed_requests, vec!["404 http://h/a.js".to_owned(), "404 http://h/dir/favicon.ico".to_owned()]);
    }

    #[test]
    fn blocked_requests_keep_only_what_the_page_sent_and_always_the_inside_ones() {
        let mut state = state();
        state.blocked_urls.insert("http://other/page-sent".to_owned());
        state.blocked_urls.insert("http://other/background".to_owned());
        state.blocked_urls.insert("CONNECT 127.0.0.1:9".to_owned());
        state.blocked_urls.insert("CONNECT background.test:443".to_owned());
        state.blocked_inside.insert("SERVICE-WORKER http://127.0.0.1:1/sw.js".to_owned());
        state.seen_urls.insert("http://other/page-sent".to_owned());
        state.seen_urls.insert("wss://127.0.0.1:9/socket".to_owned());
        assert_eq!(
            state.blocked_requests(),
            vec!["http://other/page-sent".to_owned(), "CONNECT 127.0.0.1:9".to_owned(), "SERVICE-WORKER http://127.0.0.1:1/sw.js".to_owned()]
        );
    }

    #[test]
    fn reset_clears_everything_the_warmup_collected() {
        let mut state = state();
        state.page_errors.push("x".into());
        state.console_errors.push("x".into());
        state.media_errors.push("x".into());
        state.record_failure("http://h/a", "404");
        state.blocked_urls.insert("http://o/".into());
        state.blocked_tunnels.insert("h:1".into());
        state.blocked_inside.insert("SERVICE-WORKER x".into());
        state.seen_urls.insert("http://o/".into());
        state.reset_collected();
        assert!(state.page_errors.is_empty() && state.console_errors.is_empty() && state.media_errors.is_empty() && state.failed_requests.is_empty());
        assert!(state.blocked_requests().is_empty() && state.failed_urls.is_empty() && state.blocked_tunnels.is_empty());
        // 비운 뒤에는 같은 URL의 실패를 다시 기록한다
        state.record_failure("http://h/a", "404");
        assert_eq!(state.failed_requests.len(), 1);
    }

    use tokio::io::{AsyncReadExt, DuplexStream};

    /// 가짜 브라우저와 이어진 공유 상태. `dispatch`가 브라우저에 보내는 명령은 돌려주는 스트림에서 읽는다
    fn fake_shared(allowed: Option<Vec<&str>>) -> (Arc<Shared>, DuplexStream) {
        let (client, server) = tokio::io::duplex(1 << 20);
        let (reader, writer) = tokio::io::split(client);
        let cdp = Cdp::start(reader, writer, |_| {}, |_| {});
        let shared = Arc::new(Shared {
            state: Mutex::new(state()),
            notify: Notify::new(),
            cdp: Mutex::new(Some(cdp)),
            attempt: AtomicU64::new(1),
            config: Config { allowed: allowed.map(|list| Arc::new(list.into_iter().map(str::to_owned).collect())), media_script: String::new(), viewport: (1280, 800) },
        });
        (shared, server)
    }

    fn event(method: &str, session: Option<&str>, params: Value) -> Event {
        Event { method: method.to_owned(), params, session_id: session.map(str::to_owned) }
    }

    fn page_session(shared: &Arc<Shared>) {
        let mut state = shared.state.lock().unwrap();
        state.sessions.insert("S".to_owned(), SessionInfo { kind: Kind::Page, target_id: "MAIN".to_owned() });
        state.frames().frame_attached("MAIN", None);
    }

    fn send(shared: &Arc<Shared>, method: &str, params: Value) {
        let mut state = shared.state.lock().unwrap();
        dispatch(shared, &mut state, event(method, Some("S"), params));
    }

    /// 브라우저로 나간 명령들(메서드, 매개변수). 비동기 쓰기 작업이 보낼 시간을 잠깐 준다
    async fn sent_commands(server: &mut DuplexStream) -> Vec<(String, Value)> {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut buffer = vec![0u8; 1 << 16];
        let read = match tokio::time::timeout(Duration::from_millis(100), server.read(&mut buffer)).await {
            Ok(Ok(read)) => read,
            _ => 0,
        };
        buffer[..read]
            .split(|byte| *byte == 0)
            .filter(|frame| !frame.is_empty())
            .map(|frame| {
                let message: Value = serde_json::from_slice(frame).unwrap();
                (message["method"].as_str().unwrap().to_owned(), message["params"].clone())
            })
            .collect()
    }

    fn paused(id: &str, url: &str, network_id: &str) -> Value {
        json!({ "requestId": id, "request": { "url": url, "method": "GET" }, "networkId": network_id, "frameId": "MAIN", "resourceType": "XHR" })
    }

    #[tokio::test]
    async fn the_first_layer_continues_only_allowed_urls_and_fails_the_rest() {
        let (shared, mut server) = fake_shared(Some(vec!["http://127.0.0.1:5173"]));
        page_session(&shared);
        send(&shared, "Fetch.requestPaused", paused("j1", "http://127.0.0.1:5173/app.js", "n1"));
        send(&shared, "Fetch.requestPaused", paused("j2", "http://127.0.0.1:9/secret", "n2"));
        send(&shared, "Fetch.requestPaused", paused("j3", "data:text/plain,x", "n3"));
        send(&shared, "Fetch.requestPaused", paused("j4", "not a url", "n4"));
        let commands = sent_commands(&mut server).await;
        let summary: Vec<(&str, &str, Option<&str>)> = commands.iter().map(|(method, params)| (method.as_str(), params["requestId"].as_str().unwrap(), params["errorReason"].as_str())).collect();
        assert_eq!(
            summary,
            vec![("Fetch.continueRequest", "j1", None), ("Fetch.failRequest", "j2", Some("BlockedByClient")), ("Fetch.continueRequest", "j3", None), ("Fetch.failRequest", "j4", Some("BlockedByClient"))]
        );
        let blocked = shared.state.lock().unwrap().blocked_urls.items.clone();
        assert_eq!(blocked, vec!["http://127.0.0.1:9/secret".to_owned(), "not a url".to_owned()]);
    }

    #[tokio::test]
    async fn redirect_hops_stop_again_with_the_same_network_id_and_are_judged_too() {
        let (shared, mut server) = fake_shared(Some(vec!["http://127.0.0.1:5173"]));
        page_session(&shared);
        // 첫 홉은 허용 출처, 리다이렉트된 둘째 홉은 허용 밖(http), 셋째 요청의 둘째 홉은 허용 밖 https
        send(&shared, "Fetch.requestPaused", paused("a1", "http://127.0.0.1:5173/redir", "n1"));
        send(&shared, "Fetch.requestPaused", paused("a2", "http://127.0.0.1:9/hop-http", "n1"));
        send(&shared, "Fetch.requestPaused", paused("b1", "http://127.0.0.1:5173/redir2", "n2"));
        send(&shared, "Fetch.requestPaused", paused("b2", "https://127.0.0.1:9/hop-https", "n2"));
        // `redirectedRequestId`가 오는 브라우저도 홉으로 본다
        let mut explicit = paused("c2", "https://127.0.0.1:10/hop", "n3");
        explicit["redirectedRequestId"] = json!("c1");
        send(&shared, "Fetch.requestPaused", explicit);
        let commands = sent_commands(&mut server).await;
        let methods: Vec<&str> = commands.iter().map(|(method, _)| method.as_str()).collect();
        assert_eq!(methods, vec!["Fetch.continueRequest", "Fetch.failRequest", "Fetch.continueRequest", "Fetch.failRequest", "Fetch.failRequest"]);
        let state = shared.state.lock().unwrap();
        // http 홉은 URL로, https 홉은 옛 러너(프록시가 막은 CONNECT)와 같은 터널 꼴로 남는다
        assert_eq!(state.blocked_urls.items, vec!["http://127.0.0.1:9/hop-http".to_owned(), "CONNECT 127.0.0.1:9".to_owned(), "CONNECT 127.0.0.1:10".to_owned()]);
        assert!(state.blocked_tunnels.contains("127.0.0.1:9") && state.blocked_tunnels.contains("127.0.0.1:10"));
    }

    #[tokio::test]
    async fn favicon_requests_are_aborted_without_a_record_and_unrestricted_runs_continue_everything() {
        let (shared, mut server) = fake_shared(Some(vec!["http://127.0.0.1:5173"]));
        page_session(&shared);
        send(&shared, "Fetch.requestPaused", paused("f1", "http://127.0.0.1:9/favicon.ico", "n1"));
        let commands = sent_commands(&mut server).await;
        assert_eq!(commands[0].0, "Fetch.failRequest");
        assert_eq!(commands[0].1["errorReason"], "Aborted");
        assert!(shared.state.lock().unwrap().blocked_urls.items.is_empty());

        let (open, mut open_server) = fake_shared(None);
        page_session(&open);
        send(&open, "Fetch.requestPaused", paused("o1", "http://anywhere.example/x", "n1"));
        let commands = sent_commands(&mut open_server).await;
        assert_eq!(commands[0].0, "Fetch.continueRequest");
        assert!(open.state.lock().unwrap().blocked_urls.items.is_empty());
    }

    #[tokio::test]
    async fn proxy_blocks_inside_the_allowed_origin_are_kept_apart_from_boundary_blocks() {
        let (shared, _server) = fake_shared(Some(vec!["http://127.0.0.1:5173"]));
        on_proxy_blocked(&shared, ProxyBlock::Url("http://127.0.0.1:9/outside".to_owned()));
        on_proxy_blocked(&shared, ProxyBlock::Url("http://127.0.0.1:5173/odd-method".to_owned()));
        on_proxy_blocked(&shared, ProxyBlock::ServiceWorker("http://127.0.0.1:5173/sw.js".to_owned()));
        on_proxy_blocked(&shared, ProxyBlock::Tunnel("127.0.0.1:9".to_owned()));
        let state = shared.state.lock().unwrap();
        assert_eq!(state.blocked_urls.items, vec!["http://127.0.0.1:9/outside".to_owned(), "CONNECT 127.0.0.1:9".to_owned()]);
        assert_eq!(state.blocked_inside.items, vec!["http://127.0.0.1:5173/odd-method".to_owned(), "SERVICE-WORKER http://127.0.0.1:5173/sw.js".to_owned()]);
        assert!(state.blocked_tunnels.contains("127.0.0.1:9"));
    }

    #[tokio::test]
    async fn console_errors_exceptions_and_media_errors_are_collected_by_the_playwright_rules() {
        let (shared, _server) = fake_shared(None);
        page_session(&shared);
        let text = |value: &str| json!({ "type": "string", "value": value });
        send(&shared, "Runtime.consoleAPICalled", json!({ "type": "error", "args": [text("a"), { "type": "number", "value": 1 }], "executionContextId": 5 }));
        send(&shared, "Runtime.consoleAPICalled", json!({ "type": "warning", "args": [text("w")], "executionContextId": 5 }));
        send(&shared, "Runtime.consoleAPICalled", json!({ "type": "error", "args": [text("Failed to load resource: x")], "executionContextId": 5 }));
        send(&shared, "Runtime.consoleAPICalled", json!({ "type": "error", "args": [text("zero context")], "executionContextId": 0 }));
        send(&shared, "Log.entryAdded", json!({ "entry": { "source": "security", "level": "error", "text": "Refused to execute inline script" } }));
        send(&shared, "Log.entryAdded", json!({ "entry": { "source": "network", "level": "error", "text": "Failed to load resource: the server responded with a status of 404" } }));
        send(&shared, "Log.entryAdded", json!({ "entry": { "source": "worker", "level": "error", "text": "from worker" } }));
        send(&shared, "Log.entryAdded", json!({ "entry": { "source": "javascript", "level": "warning", "text": "warned" } }));
        send(&shared, "Runtime.exceptionThrown", json!({ "exceptionDetails": { "exception": { "type": "object", "description": "Error: boom\n    at x" } } }));
        send(&shared, "Runtime.bindingCalled", json!({ "name": "__bStudioMediaError__", "payload": "video MEDIA_ERR_NETWORK http://h/v.mp4" }));
        send(&shared, "Runtime.bindingCalled", json!({ "name": "other", "payload": "ignored" }));
        let state = shared.state.lock().unwrap();
        assert_eq!(state.console_errors, vec!["a 1".to_owned(), "Refused to execute inline script".to_owned()]);
        assert_eq!(state.page_errors, vec!["boom".to_owned()]);
        assert_eq!(state.media_errors, vec!["video MEDIA_ERR_NETWORK http://h/v.mp4".to_owned()]);
    }

    #[tokio::test]
    async fn requests_are_paired_with_responses_redirects_and_failures_like_playwright() {
        let (shared, _server) = fake_shared(None);
        page_session(&shared);
        let will_be_sent = |id: &str, url: &str, extra: Value| {
            let mut params = json!({ "requestId": id, "loaderId": "L", "request": { "url": url }, "frameId": "MAIN", "type": "Fetch" });
            for (key, value) in extra.as_object().unwrap() {
                params[key] = value.clone();
            }
            params
        };
        // 404 응답, 같은 URL의 뒤따르는 ERR_ABORTED(첫 기록만), 파비콘, 연결 거부
        send(&shared, "Network.requestWillBeSent", will_be_sent("r1", "http://h/a.js", json!({})));
        send(&shared, "Network.responseReceived", json!({ "requestId": "r1", "response": { "status": 404 } }));
        send(&shared, "Network.loadingFailed", json!({ "requestId": "r1", "errorText": "net::ERR_ABORTED", "canceled": true }));
        send(&shared, "Network.requestWillBeSent", will_be_sent("r2", "http://h/favicon.ico", json!({})));
        send(&shared, "Network.responseReceived", json!({ "requestId": "r2", "response": { "status": 404 } }));
        send(&shared, "Network.requestWillBeSent", will_be_sent("r3", "http://127.0.0.1:1/x", json!({})));
        send(&shared, "Network.loadingFailed", json!({ "requestId": "r3", "errorText": "net::ERR_CONNECTION_REFUSED" }));
        // 리다이렉트 홉: 앞 홉의 응답(302)은 실패가 아니고, 뒤 홉이 500이면 실패다
        send(&shared, "Network.requestWillBeSent", will_be_sent("r4", "http://h/redir", json!({})));
        send(&shared, "Network.requestWillBeSent", will_be_sent("r4", "http://h/final", json!({ "redirectResponse": { "status": 302 } })));
        send(&shared, "Network.responseReceived", json!({ "requestId": "r4", "response": { "status": 500 } }));
        send(&shared, "Network.loadingFinished", json!({ "requestId": "r4" }));
        // 알 수 없는 프레임의 요청은 세지 않는다
        send(&shared, "Network.requestWillBeSent", will_be_sent("r5", "http://h/orphan", json!({ "frameId": "UNKNOWN" })));
        send(&shared, "Network.responseReceived", json!({ "requestId": "r5", "response": { "status": 500 } }));
        let state = shared.state.lock().unwrap();
        assert_eq!(state.failed_requests, vec!["404 http://h/a.js".to_owned(), "net::ERR_CONNECTION_REFUSED http://127.0.0.1:1/x".to_owned(), "500 http://h/final".to_owned()]);
        // 페이지 쪽이 보낸 요청의 URL: 파비콘과 알 수 없는 프레임의 요청은 없다
        assert!(state.seen_urls.contains("http://h/a.js") && state.seen_urls.contains("http://h/final") && state.seen_urls.contains("http://h/redir"));
        assert!(!state.seen_urls.contains("http://h/favicon.ico") && !state.seen_urls.contains("http://h/orphan"));
    }

    #[test]
    fn a_proxied_browser_gets_loopback_through_the_proxy_and_both_webrtc_policy_names() {
        let args = proxy_launch_args("http://127.0.0.1:4000");
        assert_eq!(
            args,
            vec![
                "--proxy-server=http://127.0.0.1:4000".to_owned(),
                "--proxy-bypass-list=<-loopback>".to_owned(),
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_owned(),
                "--webrtc-ip-handling-policy=disable_non_proxied_udp".to_owned(),
            ]
        );
        let proxied = context_params(Some("http://127.0.0.1:4000"));
        assert_eq!(proxied["proxyServer"], "http://127.0.0.1:4000");
        assert_eq!(proxied["proxyBypassList"], "<-loopback>");
        // 프록시를 쓰지 않으면 컨텍스트에 프록시 설정이 없다
        assert_eq!(context_params(None), json!({ "disposeOnDetach": true }));
    }

    #[tokio::test]
    async fn a_proxy_that_cannot_start_means_unavailable_and_no_browser_is_launched_without_it() {
        FAIL_PROXY_START.store(true, Ordering::SeqCst);
        let input = BrowserRunInput {
            // 이 경로가 시도됐다면(프록시 없이 띄우려 했다면) 오류 글이 달라진다
            executables: vec!["/nonexistent/should-not-be-tried".to_owned()],
            url: "http://127.0.0.1:1/".to_owned(),
            viewport: (1280, 800),
            viewport_script: None,
            allowed_origins: Some(vec!["http://127.0.0.1:1".to_owned()]),
            measure_load: false,
            media_error_script: String::new(),
        };
        let outcome = run_in_browser(&input, &Cancel::default()).await;
        FAIL_PROXY_START.store(false, Ordering::SeqCst);
        match outcome {
            Err(RunError::Unavailable(message)) => assert!(message.contains("출처 제한 프록시를 시작할 수 없습니다"), "{message}"),
            other => panic!("프록시를 못 세우면 unavailable이어야 한다: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_missing_executable_is_unavailable_with_every_attempt_listed() {
        let input = BrowserRunInput {
            executables: vec!["/nonexistent/a".to_owned(), "/nonexistent/b".to_owned()],
            url: "http://127.0.0.1:1/".to_owned(),
            viewport: (1280, 800),
            viewport_script: None,
            allowed_origins: None,
            measure_load: false,
            media_error_script: String::new(),
        };
        match run_in_browser(&input, &Cancel::default()).await {
            Err(RunError::Unavailable(message)) => {
                assert!(message.starts_with("헤드리스 브라우저를 실행할 수 없습니다: "), "{message}");
                assert!(message.contains("/nonexistent/a") && message.contains(" / ") && message.contains("/nonexistent/b"), "{message}");
            }
            other => panic!("{other:?}"),
        }
        // 이미 취소된 신호는 아무것도 띄우지 않고 끝난다
        let cancel = Cancel::default();
        cancel.cancel();
        assert_eq!(run_in_browser(&input, &cancel).await, Err(RunError::Aborted));
    }
}
