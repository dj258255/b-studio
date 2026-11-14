//! Chrome DevTools Protocol를 `--remote-debugging-pipe`(NUL로 끝나는 JSON 틀)로 말한다(ADR-199).
//!
//! 디버깅 포트를 열지 않으므로 같은 기계의 다른 프로세스가 붙을 수 없다. 읽기 작업이 틀을 **순서대로** 처리한다: 이벤트는
//! 처리기를 부른 뒤에 다음 틀을 읽고, 응답은 그 자리에서 기다리는 쪽에 넘긴다. 그래서 어떤 응답을 받았을 때 그 앞의 이벤트는
//! 모두 처리기를 지난 뒤다(결과를 읽는 쪽이 이 순서에 기댄다).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

/// 틀 하나의 크기 상한. 읽기 전에 본다: 넘으면 더 모으지 않고 연결을 오류로 닫는다(페이지가 거대한 console 글을 남겨 호스트 메모리를 쓰지 못하게)
pub const MAX_FRAME_BYTES: usize = 256 * 1024 * 1024;

/// NUL로 끝나는 틀을 잘라 낸다. 조각 경계가 틀 가운데에 와도, 한 조각에 틀이 여럿이어도 된다
#[derive(Default)]
pub struct FrameSplitter {
    buffer: Vec<u8>,
}

impl FrameSplitter {
    /// 새 조각을 넣고 완성된 틀(NUL 앞의 바이트)을 순서대로 돌려준다. 빈 틀은 건너뛴다
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let scan_from = self.buffer.len();
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut consumed = 0;
        let mut cursor = scan_from;
        while let Some(offset) = self.buffer[cursor..].iter().position(|byte| *byte == 0) {
            let end = cursor + offset;
            if end > consumed {
                frames.push(self.buffer[consumed..end].to_vec());
            }
            consumed = end + 1;
            cursor = consumed;
        }
        self.buffer.drain(..consumed);
        frames
    }

    /// 아직 NUL을 받지 못한 바이트 수. 연결이 끝났는데 0이 아니면 틀이 잘린 것이다
    pub fn pending(&self) -> usize {
        self.buffer.len()
    }
}

/// 명령이 오류로 끝난 것(`error` 필드) 또는 연결이 끊긴 것
#[derive(Debug, Clone)]
pub struct CdpError {
    pub message: String,
}

impl std::fmt::Display for CdpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// 브라우저가 보낸 이벤트. `session_id`가 없으면 브라우저 수준이다
#[derive(Debug, Clone)]
pub struct Event {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>;

struct Inner {
    sender: mpsc::UnboundedSender<Vec<u8>>,
    pending: Pending,
    next_id: AtomicU64,
    closed: AtomicBool,
    close_reason: Mutex<Option<String>>,
    tasks: Mutex<Vec<AbortHandle>>,
}

/// 파이프 위의 CDP 연결. 복제해서 여러 곳에서 쓴다
#[derive(Clone)]
pub struct Cdp {
    inner: Arc<Inner>,
}

impl Cdp {
    /// 읽기·쓰기 작업을 띄운다. `on_event`는 읽기 작업 안에서 틀 순서대로 불린다(막히면 안 된다).
    /// `on_close`는 연결이 끊기면 한 번 불린다(이유 포함). 끊기면 기다리던 명령은 모두 오류로 끝난다
    pub fn start<R, W>(
        reader: R,
        writer: W,
        mut on_event: impl FnMut(Event) + Send + 'static,
        on_close: impl FnOnce(String) + Send + 'static,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start_with_limit(reader, writer, on_event, on_close, MAX_FRAME_BYTES)
    }

    /// `start`와 같고 틀 크기 상한을 정한다(시험이 작은 상한으로 확인한다)
    pub fn start_with_limit<R, W>(
        reader: R,
        mut writer: W,
        mut on_event: impl FnMut(Event) + Send + 'static,
        on_close: impl FnOnce(String) + Send + 'static,
        max_frame_bytes: usize,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Vec<u8>>();
        let inner = Arc::new(Inner {
            sender,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            close_reason: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
        });

        let write_task = tokio::spawn({
            let inner = inner.clone();
            async move {
                while let Some(mut frame) = receiver.recv().await {
                    frame.push(0);
                    if let Err(error) = writer.write_all(&frame).await {
                        inner.close(format!("브라우저 연결에 쓰지 못했습니다: {error}"));
                        return;
                    }
                }
            }
        });

        let read_task = tokio::spawn({
            let inner = inner.clone();
            async move {
                let mut reader = reader;
                let mut splitter = FrameSplitter::default();
                let mut chunk = vec![0u8; 64 * 1024];
                let reason = loop {
                    let read = match reader.read(&mut chunk).await {
                        Ok(0) => {
                            break if splitter.pending() > 0 {
                                format!("브라우저 연결이 끊겼습니다(틀이 잘렸습니다: {} 바이트)", splitter.pending())
                            } else {
                                "브라우저 연결이 끊겼습니다".to_owned()
                            }
                        }
                        Ok(read) => read,
                        Err(error) => break format!("브라우저 연결을 읽지 못했습니다: {error}"),
                    };
                    // 상한은 모으기 전에 본다(이 조각을 붙이면 아직 NUL이 없는 틀이 상한을 넘는가)
                    if splitter.pending() + read > max_frame_bytes && !chunk[..read].contains(&0) {
                        break format!("브라우저가 {max_frame_bytes}바이트를 넘는 틀을 보냈습니다");
                    }
                    let mut failed = None;
                    for frame in splitter.push(&chunk[..read]) {
                        match serde_json::from_slice::<Value>(&frame) {
                            Ok(message) => inner.dispatch(message, &mut on_event),
                            Err(error) => {
                                failed = Some(format!("브라우저가 JSON이 아닌 틀을 보냈습니다: {error}"));
                                break;
                            }
                        }
                    }
                    if let Some(reason) = failed {
                        break reason;
                    }
                };
                inner.close(reason.clone());
                on_close(reason);
            }
        });
        inner.tasks.lock().unwrap().extend([write_task.abort_handle(), read_task.abort_handle()]);
        Self { inner }
    }

    /// 명령을 보내고 응답을 기다린다. `session_id`가 없으면 브라우저 수준이다
    pub async fn send(&self, session_id: Option<&str>, method: &str, params: Value) -> Result<Value, CdpError> {
        let (id, receiver) = self.register();
        self.write(id, session_id, method, params)?;
        match receiver.await {
            Ok(result) => result,
            Err(_) => Err(CdpError { message: self.inner.reason() }),
        }
    }

    /// 응답을 기다리지 않는다. 처리기 안(동기)에서 쓴다. 응답이 오류여도 알 수 없으므로 실패해도 되는 명령에만 쓴다
    pub fn fire(&self, session_id: Option<&str>, method: &str, params: Value) {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let _ = self.write(id, session_id, method, params);
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// 읽기·쓰기 작업을 멈춘다
    pub fn shutdown(&self) {
        self.inner.close("연결을 닫았습니다".to_owned());
        for task in self.inner.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }

    fn register(&self) -> (u64, oneshot::Receiver<Result<Value, CdpError>>) {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id, sender);
        (id, receiver)
    }

    fn write(&self, id: u64, session_id: Option<&str>, method: &str, params: Value) -> Result<(), CdpError> {
        if self.is_closed() {
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(CdpError { message: self.inner.reason() });
        }
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            message["sessionId"] = Value::String(session_id.to_owned());
        }
        let bytes = serde_json::to_vec(&message).map_err(|error| CdpError { message: error.to_string() })?;
        self.inner.sender.send(bytes).map_err(|_| {
            self.inner.pending.lock().unwrap().remove(&id);
            CdpError { message: self.inner.reason() }
        })
    }
}

impl Inner {
    fn reason(&self) -> String {
        self.close_reason.lock().unwrap().clone().unwrap_or_else(|| "브라우저 연결이 끊겼습니다".to_owned())
    }

    fn close(&self, reason: String) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        *self.close_reason.lock().unwrap() = Some(reason.clone());
        let waiting: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, sender) in waiting {
            let _ = sender.send(Err(CdpError { message: reason.clone() }));
        }
    }

    fn dispatch(&self, message: Value, on_event: &mut impl FnMut(Event)) {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            let sender = self.pending.lock().unwrap().remove(&id);
            let Some(sender) = sender else { return };
            let result = match message.get("error") {
                Some(error) => Err(CdpError { message: error.get("message").and_then(Value::as_str).unwrap_or("알 수 없는 오류").to_owned() }),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = sender.send(result);
            return;
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else { return };
        on_event(Event {
            method: method.to_owned(),
            params: message.get("params").cloned().unwrap_or(Value::Null),
            session_id: message.get("sessionId").and_then(Value::as_str).map(str::to_owned),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[test]
    fn splits_frames_on_nul_across_chunk_boundaries() {
        let mut splitter = FrameSplitter::default();
        assert!(splitter.push(b"{\"id\":1").is_empty());
        assert_eq!(splitter.pending(), 7);
        let frames = splitter.push(b"}\0{\"id\":2}\0{\"id\"");
        assert_eq!(frames, vec![b"{\"id\":1}".to_vec(), b"{\"id\":2}".to_vec()]);
        assert_eq!(splitter.pending(), 5);
        assert_eq!(splitter.push(b":3}\0"), vec![b"{\"id\":3}".to_vec()]);
        assert_eq!(splitter.pending(), 0);
    }

    #[test]
    fn skips_empty_frames_and_reports_truncated_tail() {
        let mut splitter = FrameSplitter::default();
        assert_eq!(splitter.push(b"\0\0a\0\0"), vec![b"a".to_vec()]);
        splitter.push(b"half");
        assert_eq!(splitter.pending(), 4);
    }

    #[test]
    fn handles_a_large_message_split_in_many_small_chunks() {
        let big = vec![b'x'; 10 * 1024 * 1024];
        let mut message = big.clone();
        message.push(0);
        let mut splitter = FrameSplitter::default();
        let mut frames = Vec::new();
        for chunk in message.chunks(7919) {
            frames.extend(splitter.push(chunk));
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], big);
        assert_eq!(splitter.pending(), 0);
    }

    #[tokio::test]
    async fn routes_responses_and_events_in_order_and_fails_pending_on_close() {
        let (client, mut server) = duplex(1 << 20);
        let (reader, writer) = tokio::io::split(client);
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let closed = Arc::new(Mutex::new(None::<String>));
        let cdp = Cdp::start(
            reader,
            writer,
            {
                let events = events.clone();
                move |event| events.lock().unwrap().push(event.method)
            },
            {
                let closed = closed.clone();
                move |reason| *closed.lock().unwrap() = Some(reason)
            },
        );
        let waiting = tokio::spawn({
            let cdp = cdp.clone();
            async move { cdp.send(Some("s1"), "Page.enable", json!({})).await }
        });
        let mut request = vec![0u8; 4096];
        let read = server.read(&mut request).await.unwrap();
        let sent: Value = serde_json::from_slice(&request[..read - 1]).unwrap();
        assert_eq!(sent["method"], "Page.enable");
        assert_eq!(sent["sessionId"], "s1");
        // 이벤트가 응답보다 앞이면 응답을 받은 시점에 이벤트는 이미 처리돼 있다
        server.write_all(b"{\"method\":\"A.first\",\"params\":{}}\0").await.unwrap();
        server.write_all(format!("{{\"id\":{},\"result\":{{\"ok\":1}}}}\0", sent["id"]).as_bytes()).await.unwrap();
        let result = waiting.await.unwrap().unwrap();
        assert_eq!(result["ok"], 1);
        assert_eq!(*events.lock().unwrap(), vec!["A.first".to_owned()]);

        let pending = tokio::spawn({
            let cdp = cdp.clone();
            async move { cdp.send(None, "Never.answered", json!({})).await }
        });
        let _ = server.read(&mut request).await.unwrap();
        drop(server);
        let error = pending.await.unwrap().unwrap_err();
        assert!(error.message.contains("끊겼"), "{error}");
        assert!(cdp.is_closed());
        assert!(cdp.send(None, "After.close", json!({})).await.is_err());
        for _ in 0..50 {
            if closed.lock().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(closed.lock().unwrap().is_some());
    }

    #[tokio::test]
    async fn a_truncated_tail_at_eof_is_reported_not_swallowed() {
        let (client, mut server) = duplex(1 << 16);
        let (reader, writer) = tokio::io::split(client);
        let reason = Arc::new(Mutex::new(None::<String>));
        let _cdp = Cdp::start(reader, writer, |_| {}, {
            let reason = reason.clone();
            move |why| *reason.lock().unwrap() = Some(why)
        });
        server.write_all(b"{\"method\":\"X\",\"par").await.unwrap();
        drop(server);
        for _ in 0..50 {
            if reason.lock().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(reason.lock().unwrap().as_deref().unwrap().contains("잘렸"));
    }

    #[tokio::test]
    async fn a_frame_over_the_limit_closes_the_connection_instead_of_growing_without_bound() {
        let (client, mut server) = duplex(1 << 20);
        let (reader, writer) = tokio::io::split(client);
        let reason = Arc::new(Mutex::new(None::<String>));
        let cdp = Cdp::start_with_limit(reader, writer, |_| {}, {
            let reason = reason.clone();
            move |why| *reason.lock().unwrap() = Some(why)
        }, 1000);
        // NUL 없이 상한을 넘게 보낸다
        server.write_all(&vec![b'x'; 2000]).await.unwrap();
        for _ in 0..100 {
            if reason.lock().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(reason.lock().unwrap().as_deref().unwrap_or("").contains("넘는 틀"));
        assert!(cdp.is_closed());
    }

    #[tokio::test]
    async fn a_response_with_an_error_field_is_an_error() {
        let (client, mut server) = duplex(1 << 16);
        let (reader, writer) = tokio::io::split(client);
        let cdp = Cdp::start(reader, writer, |_| {}, |_| {});
        let waiting = tokio::spawn({
            let cdp = cdp.clone();
            async move { cdp.send(None, "Bad.call", json!({})).await }
        });
        let mut request = vec![0u8; 4096];
        let read = server.read(&mut request).await.unwrap();
        let sent: Value = serde_json::from_slice(&request[..read - 1]).unwrap();
        server.write_all(format!("{{\"id\":{},\"error\":{{\"code\":-32601,\"message\":\"'Bad.call' wasn't found\"}}}}\0", sent["id"]).as_bytes()).await.unwrap();
        let error = waiting.await.unwrap().unwrap_err();
        assert!(error.message.contains("wasn't found"));
    }
}
