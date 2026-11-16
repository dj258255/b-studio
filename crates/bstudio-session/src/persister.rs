//! 세션 하나의 저장을 쥔다(ADR-203, 4f B1b): 저장 예약(500ms 모으기)과 쓰기를 차례로 잇는 줄. 옛 `sessions.ts`의 `schedulePersist`·`flushPersist`와 같다.
//!
//! - `schedule()`: 이미 예약돼 있으면 아무것도 하지 않는다. 예약한 지 `DELAY`가 지나면 쓴다. 타이머는 런타임의 작업이라 프로세스를 붙잡지 않는다(옛 `unref`)
//! - `flush()`: 예약을 지우고 쓰기를 줄에 잇는다. 앞의 쓰기가 끝난 뒤에 다음 쓰기를 시작하고, 쓸 상태는 **쓰기를 시작할 때** `source`에 묻는다
//!   (옛 `chain.then(() => writeSession(toPersisted(session)))`). 돌려주는 값은 이번 쓰기가 끝날 때 풀리고 실패하면 이유가 들어 있다. 던지지 않는다
//! - `flush_sync(file, head, tail)`: 종료 신호 처리용. 호출한 스레드에서 쓴다
//!
//! 쓸 상태를 건네는 것은 `source`다. 부르는 쪽 스레드(Node 메인 스레드)에서 상태를 읽고 `build_session_bytes`로 바이트를 만들어 돌려준다.
//! 그래서 history와 나머지 상태가 같은 시점의 것이다(옛 `toPersisted`가 한 번에 만들던 것과 같다).

use crate::store::{build_session_bytes, write_file_atomic, TempName};
use crate::SessionRecord;
use std::collections::VecDeque;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::oneshot;

/// 쓸 파일과 바이트
pub struct Prepared {
    pub file: PathBuf,
    pub bytes: Vec<u8>,
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// 쓰기를 시작할 때 쓸 상태를 만든다. 기록을 받는다. 실패하면 이유(쓰지 않는다)
pub type Source = Arc<dyn Fn(Arc<Mutex<SessionRecord>>) -> BoxFuture<Result<Prepared, String>> + Send + Sync>;
/// 약속이 없는 쓰기(예약한 쓰기)의 실패를 알린다
pub type Report = Arc<dyn Fn(String) + Send + Sync>;
/// 런타임에 작업을 올린다
pub type Spawn = Arc<dyn Fn(BoxFuture<()>) + Send + Sync>;

/// 저장을 모으는 시간(`PERSIST_DELAY_MS`)
pub const DELAY: Duration = Duration::from_millis(500);

enum Job {
    /// 쓰기. 약속이 있으면 거기에 결과를 보내고, 없으면(예약한 쓰기) `report`로 알린다
    Write(Option<oneshot::Sender<Option<String>>>),
    /// 앞의 쓰기가 모두 끝났음을 알린다
    Barrier(oneshot::Sender<()>),
}

#[derive(Default)]
struct State {
    scheduled: bool,
    /// 예약을 지울 때마다 늘린다. 지운 예약의 타이머가 깨어나도 아무것도 하지 않는다
    generation: u64,
    queue: VecDeque<Job>,
    running: bool,
}

struct Shared {
    record: Arc<Mutex<SessionRecord>>,
    state: Mutex<State>,
    source: Source,
    report: Report,
    spawn: Spawn,
    delay: Duration,
}

#[derive(Clone)]
pub struct Persister {
    shared: Arc<Shared>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Persister {
    pub fn new(record: Arc<Mutex<SessionRecord>>, source: Source, report: Report, spawn: Spawn) -> Self {
        Self::with_delay(record, source, report, spawn, DELAY)
    }

    /// 시험용으로 모으는 시간을 바꾼다
    pub fn with_delay(record: Arc<Mutex<SessionRecord>>, source: Source, report: Report, spawn: Spawn, delay: Duration) -> Self {
        Self { shared: Arc::new(Shared { record, state: Mutex::new(State::default()), source, report, spawn, delay }) }
    }

    pub fn record(&self) -> &Arc<Mutex<SessionRecord>> {
        &self.shared.record
    }

    /// 저장을 예약한다. 이미 예약돼 있으면 아무것도 하지 않는다
    pub fn schedule(&self) {
        let generation = {
            let mut state = lock(&self.shared.state);
            if state.scheduled {
                return;
            }
            state.scheduled = true;
            state.generation += 1;
            state.generation
        };
        let shared = self.shared.clone();
        (self.shared.spawn)(Box::pin(async move {
            tokio::time::sleep(shared.delay).await;
            let mut state = lock(&shared.state);
            if !state.scheduled || state.generation != generation {
                return;
            }
            state.scheduled = false;
            state.queue.push_back(Job::Write(None));
            kick(&shared, &mut state);
        }));
    }

    /// 예약을 지운다(쓰지 않는다). 이미 줄에 선 쓰기는 그대로다
    pub fn cancel(&self) {
        let mut state = lock(&self.shared.state);
        state.scheduled = false;
        state.generation += 1;
    }

    /// 예약을 지우고 쓰기를 줄에 잇는다. 약속은 이번 쓰기가 끝날 때 풀리고, 실패하면 이유를 담는다
    pub fn flush(&self) -> oneshot::Receiver<Option<String>> {
        let (done, result) = oneshot::channel();
        let mut state = lock(&self.shared.state);
        state.scheduled = false;
        state.generation += 1;
        state.queue.push_back(Job::Write(Some(done)));
        kick(&self.shared, &mut state);
        result
    }

    /// 지금까지 줄에 선 쓰기가 모두 끝나면 풀린다(예약해 둔 쓰기는 기다리지 않는다)
    pub fn idle(&self) -> oneshot::Receiver<()> {
        let (done, result) = oneshot::channel();
        let mut state = lock(&self.shared.state);
        state.queue.push_back(Job::Barrier(done));
        kick(&self.shared, &mut state);
        result
    }

    /// 종료 신호 처리처럼 기다릴 수 없는 곳에서 이 스레드에서 쓴다. 진행 중일 수 있는 비동기 쓰기와 같은 임시 파일을 쓰지 않도록 이름을 달리한다
    pub fn flush_sync(&self, file: &Path, head: &str, tail: &str) -> Result<(), String> {
        let bytes = build_session_bytes(&lock(&self.shared.record), head, tail, true)?;
        write_file_atomic(file, &bytes, None, TempName::Exit)
    }
}

/// 줄에 일이 있고 일꾼이 없으면 일꾼을 올린다(`state`의 잠금을 쥐고 부른다)
fn kick(shared: &Arc<Shared>, state: &mut State) {
    if state.running || state.queue.is_empty() {
        return;
    }
    state.running = true;
    let shared = shared.clone();
    (shared.spawn.clone())(Box::pin(async move {
        loop {
            let job = {
                let mut state = lock(&shared.state);
                match state.queue.pop_front() {
                    Some(job) => job,
                    None => {
                        state.running = false;
                        return;
                    }
                }
            };
            match job {
                Job::Write(done) => {
                    let failure = write_once(&shared).await;
                    match done {
                        Some(done) => {
                            // 받는 쪽이 사라졌으면 이유를 잃지 않게 알린다
                            if let Err(Some(message)) = done.send(failure) {
                                (shared.report)(message);
                            }
                        }
                        None => {
                            if let Some(message) = failure {
                                (shared.report)(message);
                            }
                        }
                    }
                }
                Job::Barrier(done) => {
                    let _ = done.send(());
                }
            }
        }
    }));
}

/// 쓰기 한 번. 실패하면 이유
async fn write_once(shared: &Shared) -> Option<String> {
    let prepared = match (shared.source)(shared.record.clone()).await {
        Ok(prepared) => prepared,
        Err(message) => return Some(message),
    };
    match tokio::task::spawn_blocking(move || write_file_atomic(&prepared.file, &prepared.bytes, None, TempName::Random)).await {
        Ok(Ok(())) => None,
        Ok(Err(message)) => Some(message),
        Err(error) => Some(format!("저장 작업이 중단됐습니다: {error}")),
    }
}

#[cfg(test)]
mod tests;
