//! Playwright의 `FrameManager`·`Frame` 가운데 이 러너가 쓰는 부분의 옮김(ADR-199): 프레임 트리, 문서 이동의 결과, 생명주기 이벤트,
//! 그리고 networkidle(진행 중인 요청 0개가 500ms 이어진 상태).
//!
//! 근거는 `playwright-core/lib/coreBundle.js`의 `FrameManager`(`frameAttached`·`frameCommittedNewDocumentNavigation`·`frameAbortedNavigation`·
//! `requestStarted`·`requestFailed`·`reportRequestFinished`)와 `Frame`(`_onClearLifecycle`·`_recalculateNetworkIdle`·
//! `_startNetworkIdleTimer`·`_inflightRequests`)다. 한 번 든 networkidle은 새 요청이 시작돼도 다음 `_recalculateNetworkIdle`까지 남고,
//! 남아 있는 동안에는 타이머를 새로 걸지 않는다 — 이 비대칭까지 그대로 옮겼다(옛 러너와 같은 시점에 "잠잠"이 되도록).
//!
//! 시간은 밖에서 [`FrameManager::advance`]로 넣는다. 타이머는 실제 타이머 대신 마감 시각을 들고 있다가 `advance`가 만료된 것을
//! 마감 순서대로 터뜨린다. 이벤트를 처리하기 전에 항상 `advance(지금)`을 부른다.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

pub type RequestKey = u64;

const NETWORK_IDLE_QUIET: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocRef {
    pub document_id: Option<String>,
    pub request: Option<RequestKey>,
}

#[derive(Debug, Clone)]
pub struct NavAbort {
    pub document_id: Option<String>,
    pub text: String,
}

/// 문서 이동 결과 하나(Playwright `InternalNavigation` 이벤트). `new_document`가 있고 `error`가 없으면 커밋, 있으면 중단이다
#[derive(Debug, Clone)]
pub struct NavEvent {
    pub frame_id: String,
    pub url: String,
    pub new_document: Option<DocRef>,
    pub error: Option<NavAbort>,
    /// 이 이벤트가 생겼을 때 생명주기 기록의 길이(그 뒤에 생긴 `load`만 이 이동의 것이다)
    pub lifecycle_pos: usize,
}

struct Frame {
    parent: Option<String>,
    children: Vec<String>,
    url: String,
    inflight: HashSet<RequestKey>,
    fired: HashSet<String>,
    fired_self: bool,
    idle_deadline: Option<Instant>,
    current: DocRef,
    pending: Option<DocRef>,
    detached: bool,
}

pub struct FrameManager {
    frames: HashMap<String, Frame>,
    main: Option<String>,
    now: Instant,
    pub nav_events: Vec<NavEvent>,
    /// 생명주기 이벤트가 새로 일어난 기록 `(메인 프레임인가, 이름)`. 이벤트가 일어났다가 다음 이동에 지워져도 기다리는 쪽이 놓치지 않게 한다
    pub lifecycle_log: Vec<(bool, String)>,
}

impl FrameManager {
    pub fn new(now: Instant) -> Self {
        Self { frames: HashMap::new(), main: None, now, nav_events: Vec::new(), lifecycle_log: Vec::new() }
    }

    pub fn main_frame_id(&self) -> Option<&str> {
        self.main.as_deref()
    }

    pub fn has_frame(&self, id: &str) -> bool {
        self.frames.contains_key(id)
    }

    pub fn frame_url(&self, id: &str) -> Option<&str> {
        self.frames.get(id).map(|frame| frame.url.as_str())
    }

    /// 메인 프레임에서 `name` 생명주기가 지금 들어 있거나, 기록 `from` 이후에 일어난 적이 있는가
    pub fn main_has_lifecycle(&self, name: &str, from: usize) -> bool {
        let fired = self.main.as_ref().and_then(|id| self.frames.get(id)).is_some_and(|frame| frame.fired.contains(name));
        fired || self.lifecycle_log.get(from..).is_some_and(|tail| tail.iter().any(|(is_main, event)| *is_main && event == name))
    }

    /// 가장 이른 networkidle 타이머 마감(기다리는 쪽이 그 시각에 깨어난다)
    pub fn next_deadline(&self) -> Option<Instant> {
        self.frames.values().filter_map(|frame| frame.idle_deadline).min()
    }

    /// 시각을 앞으로 보내고, 마감이 지난 타이머를 마감 순서대로 터뜨린다
    pub fn advance(&mut self, now: Instant) {
        if now > self.now {
            self.now = now;
        }
        loop {
            let due = self.frames.iter().filter_map(|(id, frame)| frame.idle_deadline.filter(|deadline| *deadline <= self.now).map(|deadline| (deadline, id.clone()))).min();
            let Some((_, id)) = due else { break };
            if let Some(frame) = self.frames.get_mut(&id) {
                frame.idle_deadline = None;
                frame.fired_self = true;
            }
            self.recalculate_network_idle_main(None);
        }
    }

    pub fn frame_attached(&mut self, frame_id: &str, parent_id: Option<&str>) {
        let parent = parent_id.filter(|parent| self.frames.contains_key(*parent));
        match parent {
            None => {
                if let Some(old) = self.main.clone() {
                    // 메인 프레임이 바뀐다(프로세스를 옮긴 이동): 같은 객체의 id만 바꾼다
                    if old != frame_id {
                        if let Some(frame) = self.frames.remove(&old) {
                            self.frames.insert(frame_id.to_owned(), frame);
                        }
                        self.main = Some(frame_id.to_owned());
                    }
                } else {
                    self.insert_frame(frame_id, None);
                    self.main = Some(frame_id.to_owned());
                }
            }
            Some(parent) => {
                if self.frames.contains_key(frame_id) {
                    return;
                }
                self.insert_frame(frame_id, Some(parent.to_owned()));
                if let Some(parent_frame) = self.frames.get_mut(parent) {
                    parent_frame.children.push(frame_id.to_owned());
                }
            }
        }
    }

    fn insert_frame(&mut self, id: &str, parent: Option<String>) {
        let mut fired = HashSet::new();
        fired.insert("commit".to_owned());
        self.frames.insert(
            id.to_owned(),
            Frame { parent, children: Vec::new(), url: String::new(), inflight: HashSet::new(), fired, fired_self: false, idle_deadline: None, current: DocRef::default(), pending: None, detached: false },
        );
        self.start_network_idle_timer(id);
    }

    fn start_network_idle_timer(&mut self, id: &str) {
        let now = self.now;
        if let Some(frame) = self.frames.get_mut(id) {
            if frame.fired.contains("networkidle") || frame.detached {
                return;
            }
            frame.idle_deadline = Some(now + NETWORK_IDLE_QUIET);
        }
    }

    fn stop_network_idle_timer(&mut self, id: &str) {
        if let Some(frame) = self.frames.get_mut(id) {
            frame.idle_deadline = None;
            frame.fired_self = false;
        }
    }

    fn recalculate_network_idle_main(&mut self, allows_removing: Option<&str>) {
        if let Some(main) = self.main.clone() {
            self.recalculate_network_idle(&main, allows_removing);
        }
    }

    fn recalculate_network_idle(&mut self, id: &str, allows_removing: Option<&str>) {
        let Some(frame) = self.frames.get(id) else { return };
        let mut idle = frame.fired_self;
        for child in frame.children.clone() {
            self.recalculate_network_idle(&child, allows_removing);
            if !self.frames.get(&child).is_some_and(|child_frame| child_frame.fired.contains("networkidle")) {
                idle = false;
            }
        }
        let is_main = self.main.as_deref() == Some(id);
        let Some(frame) = self.frames.get_mut(id) else { return };
        if idle && !frame.fired.contains("networkidle") {
            frame.fired.insert("networkidle".to_owned());
            self.lifecycle_log.push((is_main, "networkidle".to_owned()));
        }
        let Some(frame) = self.frames.get_mut(id) else { return };
        if allows_removing != Some(id) && frame.fired.contains("networkidle") && !idle {
            frame.fired.remove("networkidle");
        }
    }

    pub fn lifecycle_event(&mut self, frame_id: &str, name: &str) {
        let is_main = self.main.as_deref() == Some(frame_id);
        let Some(frame) = self.frames.get_mut(frame_id) else { return };
        if !frame.fired.insert(name.to_owned()) {
            return;
        }
        self.lifecycle_log.push((is_main, name.to_owned()));
        self.recalculate_network_idle_main(None);
    }

    fn clear_lifecycle(&mut self, id: &str) {
        let Some(frame) = self.frames.get_mut(id) else { return };
        frame.fired.clear();
        let current = frame.current.request;
        frame.inflight.retain(|request| Some(*request) == current);
        self.stop_network_idle_timer(id);
        if self.frames.get(id).is_some_and(|frame| frame.inflight.is_empty()) {
            self.start_network_idle_timer(id);
        }
        self.recalculate_network_idle_main(Some(id));
        self.lifecycle_event(id, "commit");
    }

    fn remove_children(&mut self, id: &str) {
        let children = self.frames.get(id).map(|frame| frame.children.clone()).unwrap_or_default();
        for child in children {
            self.remove_recursively(&child);
        }
    }

    fn remove_recursively(&mut self, id: &str) {
        self.remove_children(id);
        if let Some(parent) = self.frames.get(id).and_then(|frame| frame.parent.clone()) {
            if let Some(parent_frame) = self.frames.get_mut(&parent) {
                parent_frame.children.retain(|child| child != id);
            }
        }
        // 떼어 낸 프레임은 타이머를 멈춘다(`_onDetached`)
        if let Some(frame) = self.frames.get_mut(id) {
            frame.detached = true;
            frame.idle_deadline = None;
        }
        self.frames.remove(id);
    }

    pub fn frame_detached(&mut self, id: &str) {
        if self.frames.contains_key(id) {
            self.remove_recursively(id);
            self.recalculate_network_idle_main(None);
        }
    }

    pub fn frame_requested_navigation(&mut self, id: &str) {
        let Some(frame) = self.frames.get_mut(id) else { return };
        // documentId 없이 요청한 이동: 이미 같은(없는) documentId의 대기 문서가 있으면 그대로 둔다
        if frame.pending.as_ref().is_some_and(|pending| pending.document_id.is_none()) {
            return;
        }
        frame.pending = Some(DocRef::default());
    }

    pub fn frame_committed_new_document(&mut self, id: &str, url: &str, document_id: &str) {
        if !self.frames.contains_key(id) {
            return;
        }
        self.remove_children(id);
        let pending = self.frames.get(id).and_then(|frame| frame.pending.clone());
        let mut keep_pending = None;
        let current;
        match pending {
            Some(mut pending) => {
                if pending.document_id.is_none() {
                    pending.document_id = Some(document_id.to_owned());
                }
                if pending.document_id.as_deref() == Some(document_id) {
                    current = pending;
                } else {
                    keep_pending = Some(pending);
                    current = DocRef { document_id: Some(document_id.to_owned()), request: None };
                }
            }
            None => current = DocRef { document_id: Some(document_id.to_owned()), request: None },
        }
        if let Some(frame) = self.frames.get_mut(id) {
            frame.url = url.to_owned();
            frame.current = current.clone();
            frame.pending = None;
        }
        self.clear_lifecycle(id);
        let lifecycle_pos = self.lifecycle_log.len();
        self.nav_events.push(NavEvent { frame_id: id.to_owned(), url: url.to_owned(), new_document: Some(current), error: None, lifecycle_pos });
        if let Some(frame) = self.frames.get_mut(id) {
            frame.pending = keep_pending;
        }
    }

    pub fn frame_committed_same_document(&mut self, id: &str, url: &str) {
        let Some(frame) = self.frames.get_mut(id) else { return };
        if frame.pending.as_ref().is_some_and(|pending| pending.document_id.is_none() && pending.request.is_none()) {
            frame.pending = None;
        }
        frame.url = url.to_owned();
        let lifecycle_pos = self.lifecycle_log.len();
        self.nav_events.push(NavEvent { frame_id: id.to_owned(), url: url.to_owned(), new_document: None, error: None, lifecycle_pos });
    }

    pub fn frame_aborted_navigation(&mut self, id: &str, error_text: &str, document_id: Option<&str>) {
        let Some(frame) = self.frames.get_mut(id) else { return };
        let Some(pending) = frame.pending.clone() else { return };
        if document_id.is_some() && pending.document_id.as_deref() != document_id {
            return;
        }
        let url = frame.url.clone();
        frame.pending = None;
        let lifecycle_pos = self.lifecycle_log.len();
        self.nav_events.push(NavEvent {
            frame_id: id.to_owned(),
            url,
            new_document: Some(pending),
            error: Some(NavAbort { document_id: document_id.map(str::to_owned), text: error_text.to_owned() }),
            lifecycle_pos,
        });
    }

    /// `requestStarted`: networkidle에서 빼는 요청(파비콘·이벤트 스트림)이 아니면 진행 중으로 센다. 문서 요청이면 대기 문서를 정한다
    pub fn request_started(&mut self, request: RequestKey, frame_id: &str, document_id: Option<&str>, excluded_from_idle: bool) {
        if !excluded_from_idle {
            let mut first = false;
            if let Some(frame) = self.frames.get_mut(frame_id) {
                frame.inflight.insert(request);
                first = frame.inflight.len() == 1;
            }
            if first {
                self.stop_network_idle_timer(frame_id);
            }
        }
        if let (Some(frame), Some(document_id)) = (self.frames.get_mut(frame_id), document_id) {
            frame.pending = Some(DocRef { document_id: Some(document_id.to_owned()), request: Some(request) });
        }
    }

    /// `reportRequestFinished`·`requestFailed`의 공통: 진행 중에서 뺀다. 비면 타이머를 건다
    pub fn request_finished(&mut self, request: RequestKey, frame_id: &str, excluded_from_idle: bool) {
        if excluded_from_idle {
            return;
        }
        let Some(frame) = self.frames.get_mut(frame_id) else { return };
        if !frame.inflight.remove(&request) {
            return;
        }
        if frame.inflight.is_empty() {
            self.start_network_idle_timer(frame_id);
        }
    }

    /// `requestFailed`: 진행 중에서 빼고, 이 요청이 대기 문서의 요청이었으면 이동을 중단으로 알린다
    pub fn request_failed(&mut self, request: RequestKey, frame_id: &str, excluded_from_idle: bool, error_text: &str, canceled: bool) {
        self.request_finished(request, frame_id, excluded_from_idle);
        let pending = self.frames.get(frame_id).and_then(|frame| frame.pending.clone());
        if let Some(pending) = pending {
            if pending.request == Some(request) {
                let text = if canceled { format!("{error_text}; maybe frame was detached?") } else { error_text.to_owned() };
                self.frame_aborted_navigation(frame_id, &text, pending.document_id.as_deref());
            }
        }
    }

    pub fn inflight_count(&self, frame_id: &str) -> usize {
        self.frames.get(frame_id).map_or(0, |frame| frame.inflight.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(base: Instant, millis: u64) -> Instant {
        base + Duration::from_millis(millis)
    }

    /// 메인 프레임 하나를 만들고 문서를 하나 커밋한 상태
    fn started() -> (FrameManager, Instant) {
        let base = Instant::now();
        let mut frames = FrameManager::new(base);
        frames.frame_attached("main", None);
        (frames, base)
    }

    #[test]
    fn network_idle_fires_500ms_after_the_last_request_finishes() {
        let (mut frames, base) = started();
        frames.frame_committed_new_document("main", "http://x/", "doc1");
        frames.request_started(1, "main", Some("doc1"), false);
        frames.advance(ms(base, 100));
        assert!(!frames.main_has_lifecycle("networkidle", 0));
        frames.request_finished(1, "main", false);
        frames.advance(ms(base, 599));
        assert!(!frames.main_has_lifecycle("networkidle", 0), "마지막 요청이 끝나고 500ms가 지나기 전");
        frames.advance(ms(base, 601));
        assert!(frames.main_has_lifecycle("networkidle", 0));
    }

    #[test]
    fn a_new_request_resets_the_quiet_period() {
        let (mut frames, base) = started();
        frames.request_started(1, "main", None, false);
        frames.advance(ms(base, 0));
        frames.request_finished(1, "main", false);
        frames.advance(ms(base, 400));
        frames.request_started(2, "main", None, false);
        frames.advance(ms(base, 900));
        assert!(!frames.main_has_lifecycle("networkidle", 0), "요청이 떠 있는 동안은 잠잠하지 않다");
        frames.request_finished(2, "main", false);
        frames.advance(ms(base, 1300));
        assert!(!frames.main_has_lifecycle("networkidle", 0));
        frames.advance(ms(base, 1401));
        assert!(frames.main_has_lifecycle("networkidle", 0));
    }

    #[test]
    fn excluded_requests_do_not_count() {
        let (mut frames, base) = started();
        // 파비콘·이벤트 스트림은 센 적도 없다
        frames.request_started(9, "main", None, true);
        assert_eq!(frames.inflight_count("main"), 0);
        frames.advance(ms(base, 501));
        assert!(frames.main_has_lifecycle("networkidle", 0));
    }

    #[test]
    fn once_fired_networkidle_stays_until_a_recalculation_and_skips_the_new_timer() {
        // Playwright의 비대칭: 한 번 든 networkidle은 새 요청이 시작돼도 다음 재계산까지 남는다
        let (mut frames, base) = started();
        frames.advance(ms(base, 501));
        assert!(frames.main_has_lifecycle("networkidle", 0));
        frames.request_started(1, "main", None, false);
        assert!(frames.main_has_lifecycle("networkidle", 0), "새 요청이 시작됐어도 아직 남아 있다");
        // 다른 생명주기 이벤트가 재계산을 부르면 지워진다
        frames.lifecycle_event("main", "load");
        assert!(!frames.main.as_ref().map(|id| frames.frames[id].fired.contains("networkidle")).unwrap());
    }

    #[test]
    fn a_new_document_clears_lifecycle_and_keeps_only_its_own_request_in_flight() {
        let (mut frames, base) = started();
        frames.frame_committed_new_document("main", "http://x/a", "doc1");
        frames.lifecycle_event("main", "load");
        frames.request_started(1, "main", Some("doc2"), false);
        frames.request_started(2, "main", None, false);
        // 이동 요청(1)이 대기 문서의 요청이다. 커밋하면 그 요청만 진행 중으로 남는다
        frames.frame_committed_new_document("main", "http://x/b", "doc2");
        assert_eq!(frames.inflight_count("main"), 1);
        assert!(!frames.main_has_lifecycle("load", frames.lifecycle_log.len()));
        frames.advance(ms(base, 5000));
        assert!(!frames.main_has_lifecycle("networkidle", frames.lifecycle_log.len()), "문서 요청이 아직 떠 있다");
        frames.request_finished(1, "main", false);
        frames.advance(ms(base, 5600));
        assert!(frames.main_has_lifecycle("networkidle", 0));
    }

    #[test]
    fn a_failed_document_request_aborts_the_pending_navigation() {
        let (mut frames, _base) = started();
        frames.request_started(1, "main", Some("doc1"), false);
        frames.request_failed(1, "main", false, "net::ERR_CONNECTION_REFUSED", false);
        let event = frames.nav_events.last().unwrap();
        assert_eq!(event.error.as_ref().unwrap().text, "net::ERR_CONNECTION_REFUSED");
        assert_eq!(event.new_document.as_ref().unwrap().document_id.as_deref(), Some("doc1"));
        // 취소된 요청에는 꼬리말이 붙는다
        frames.request_started(2, "main", Some("doc2"), false);
        frames.request_failed(2, "main", false, "net::ERR_ABORTED", true);
        assert_eq!(frames.nav_events.last().unwrap().error.as_ref().unwrap().text, "net::ERR_ABORTED; maybe frame was detached?");
    }

    #[test]
    fn a_redirect_hop_replaces_the_pending_document_request() {
        let (mut frames, _base) = started();
        frames.request_started(1, "main", Some("doc1"), false);
        // 리다이렉트: 앞 홉이 끝나고 같은 문서 id의 새 요청이 선다
        frames.request_finished(1, "main", false);
        frames.request_started(2, "main", Some("doc1"), false);
        frames.frame_committed_new_document("main", "http://x/final", "doc1");
        let event = frames.nav_events.last().unwrap();
        assert_eq!(event.new_document.as_ref().unwrap().request, Some(2));
    }

    #[test]
    fn child_frames_must_be_idle_too() {
        let (mut frames, base) = started();
        frames.frame_attached("child", Some("main"));
        frames.request_started(1, "child", None, false);
        frames.advance(ms(base, 800));
        assert!(!frames.main_has_lifecycle("networkidle", 0), "자식 프레임의 요청이 떠 있다");
        frames.request_finished(1, "child", false);
        frames.advance(ms(base, 1401));
        assert!(frames.main_has_lifecycle("networkidle", 0));
    }

    #[test]
    fn lifecycle_log_lets_a_waiter_see_an_event_that_was_cleared_since() {
        let (mut frames, _base) = started();
        frames.frame_committed_new_document("main", "http://x/", "doc1");
        let pos = frames.nav_events.last().unwrap().lifecycle_pos;
        frames.lifecycle_event("main", "load");
        frames.frame_committed_new_document("main", "http://x/other", "doc2");
        assert!(frames.main_has_lifecycle("load", pos));
        assert!(!frames.main_has_lifecycle("load", frames.lifecycle_log.len()));
    }
}
