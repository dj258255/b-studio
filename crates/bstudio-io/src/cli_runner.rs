//! 지원 러너(claude-code)의 메시지 루프와 실행 상태(ADR-202, 4f A8b). 옮기기 전 TS는 `packages/agent/src/claude-code-runner.ts`의 `runClaudeCodeAgent`가
//! 들고 있던 변수와 `runQuery`의 메시지 루프였다(옛 구현은 `claude-code-runner-loop-legacy.ts`, 차등 시험의 기준).
//!
//! 이 코어가 CLI 프로세스(`cli_process.rs`, A8a)를 **직접** 쥔다: 줄은 TS를 거치지 않고 여기로 온다. 도구 순서 장부(`tool_ledger.rs`)는 MCP 서버와 나눠 쥔다.
//!
//! **Rust가 쥐는 것**: 메시지 루프 전부(session_id 갱신·init의 `session` 이벤트·`mcpSetupFailure`·요약 상태·턴 세기·`turn`·`turn_usage`·최대 문맥·`text`·마지막 글·턴 상한),
//! result 처리(도구 서버 미확인 실패·사용량·`tokens`·modelMs·`describeResultFailure`·`error_max_turns` 재확인·네트워크 재시도·되묻기 멈춤·게이트 판정 분기·승격),
//! 프로세스 다시 띄우기(`reopen`)·프로세스마다의 사용량 base 누적·`lastExit`·결과 없음 실패, 예외 처리 규칙(결과가 있으면 삼킨다, 트러블슈팅 131).
//! **TS 콜백으로 남는 것**: 게이트(확인·턴 상한 재확인·서명·재시도 예산)·결과 조립·도구 실행·CLI 인자 만들기·진행 중 지시·이벤트 전달·네트워크 대기.
//! 콜백(`Hook`) 요청은 `{ op, ... }`, 응답은 `{ ok: true, ... }`다(실패하면 TS가 오류를 보관하고 `{ fatal: true }`: 이 뒤 단계를 하지 않고 [`Stop::Hook`]으로 끝낸다).
//!
//! 이벤트는 옛 `onEvent`를 부르던 **그 자리**에서 `event` 콜백으로 낸다(이 크레이트는 순서를 정한다). 콜백 하나가 끝나야 다음 일을 한다.
//!
//! JSON: 줄은 `js_json::parse_lone_encoded`로 읽는다(`JSON.parse`와 같은 문법: 숫자는 JS number와 같게, `-0`, 큰 정수, 중복 키는 뒤 값, 짝 없는 서로게이트 보존).
//! JSON이 아니거나 객체가 아닌 줄은 건너뛴다(옛 구현과 같다). 글자는 `encodeLoneSurrogates`한 꼴로 TS와 오간다.
//!
//! **통과를 정하는 코드다.** 옛 구현의 순서와 분기를 그대로 따르고, 통과 쪽으로 열리는 자리는 아래 규칙으로 닫는다.
//! - 막는 쪽(모르는 입력은 막는다): 도구 서버 확인(`connected`로 확인한 init이 있어야 result를 믿는다), result 실패 설명(`describe_result_failure`는 성공이 확실할 때만 `None`),
//!   게이트 응답(`pass`·`retry`·`exhausted` 말고는 `Stop::Hook`), 턴 상한(넘으면 도구를 닫고 게이트를 한 번 더 본다)
//! - 여는 쪽(다시 시도·이어받기): 네트워크 재시도(근거 있는 패턴만, 상한 있음), 승격(한 번만, 게이트 서명이 정한다). 통과로 이어지지 않는다
//! - 건너뛰는 자리: JSON이 아니거나 객체가 아닌 줄(옛 구현과 같다). **너무 깊어 읽지 못한 줄은 건너뛰지 않고 실행을 실패로 끝낸다**(JS는 읽는다: 건너뛰면 턴 수를 덜 세어 상한을 넘기므로 닫는다)
//!
//! 옛 구현과 다른 것(의도한 차이)
//! - 중첩이 `MAX_DEPTH`를 넘는 줄: 위 설명. 옛 구현은 읽고 처리했다
//! - 모델 이름이 `__proto__`·`constructor` 같은 `Object.prototype` 속성이면 옛 구현은 사용량이 사라지거나 `Object`를 오염시켰다. 여기서는 보통 키로 센다(`runner_judge`와 같다)
//! - 준비 단계(CLI 인자 만들기·지시 연결)가 던져도 프로세스를 끝내고 정리한 뒤 던진다(옛 구현은 이미 띄운 프로세스를 남겼다)
//! - 한 프로세스를 일찍 닫을 때(승격·재시도·오류) 남은 줄을 소비해 비운다(옛 구현은 소비하지 않아 자식이 쓰기에서 멈출 수 있었다)

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bstudio_guard::escalation;
use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsObject, JsValue, LoneParseError};
use bstudio_guard::runner_judge::{self, Usage};
use tokio::sync::mpsc;

use crate::cli_process::{self, CliConfig, CliEvent, CliExit, CliHandle, CliSpawnError, OnCliEvent, StopMode};
use crate::gate_declared::{enc, lossy, lossy_str};
use crate::mcp_server::decode_encoded;
use crate::tool_ledger::ToolLedger;
use crate::verify_io::{call_done, s, Fail};

pub use crate::checkpoint_remote::Hook;

/// 같은 실패 서명 집합이 연속 몇 번 나오면 승격할지의 기본값(TS `DEFAULT_SAME_SIGNATURE_TIMES`)
pub const DEFAULT_SAME_SIGNATURE_TIMES: f64 = 2.0;
/// 승격 뒤 게이트 재시도를 새로 주는 횟수의 기본값(TS `DEFAULT_ESCALATION_RETRY_BUDGET`)
pub const DEFAULT_ESCALATION_RETRY_BUDGET: f64 = 2.0;
/// 이어받을 대화가 없는 첫 호출이 끊겼을 때 말고, 세션이 있을 때 재시도로 이어받으며 보내는 안내(TS `NETWORK_RESUME_PROMPT`는 입력으로 받는다)
const TOO_DEEP: &str = "Claude Code가 읽을 수 없을 만큼 깊게 중첩된 줄을 보냈습니다";

// ───────────────────────── 이어받을 대화 id ─────────────────────────

/// 이어받을 대화의 id는 CLI가 준 값(UUID)만 받는다(TS `SESSION_ID`: `/^[0-9a-f]{8}-…-[0-9a-f]{12}$/i`, 유니코드 플래그 없는 `i`는 ASCII만 접는다)
pub fn is_session_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(at, byte)| if matches!(at, 8 | 13 | 18 | 23) { *byte == b'-' } else { byte.is_ascii_hexdigit() })
}

/// CLI가 낸 줄(글자 그대로)을 `parse_lone_encoded`가 읽는 꼴로 바꾼다: 글자 그대로의 예약 글자(U+E000..U+E01F)를 인코딩해 짝 없는 서로게이트의 인코딩과 섞이지 않게 한다
/// (`mcp_server::decode_body_text`와 같은 규칙). 안 바꾸면 줄에 든 예약 글자가 서로게이트로 읽힌다
pub fn encode_line(line: &str) -> std::borrow::Cow<'_, str> {
    if line.chars().any(|c| ('\u{E000}'..='\u{E01F}').contains(&c)) {
        std::borrow::Cow::Owned(line.chars().map(js::encode_reserved_char).collect())
    } else {
        std::borrow::Cow::Borrowed(line)
    }
}

/// 사용자 메시지 한 줄(`JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })`). 글자는 `encodeLoneSurrogates`한 꼴이고
/// 짝 없는 서로게이트는 `\ud800` 이스케이프로 쓴다(`JSON.stringify`가 쓰는 꼴)
pub fn user_line(text: &str) -> String {
    decode_encoded(&format!(r#"{{"type":"user","message":{{"role":"user","content":{}}},"parent_tool_use_id":null}}"#, js::json_quote(text)))
}

// ───────────────────────── 손잡이: 취소·지시 보내기 ─────────────────────────

#[derive(Default)]
struct SharedInner {
    aborted: bool,
    /// 지금 떠 있는 프로세스(순번, 손잡이)
    proc: Option<(u32, Arc<CliHandle>)>,
}

/// 러너 코어와 TS 껍데기가 나눠 쥐는 손잡이. 모두 동기라 JS 메인 스레드에서 바로 부를 수 있다
pub struct CoreShared {
    inner: Mutex<SharedInner>,
    ledger: Arc<ToolLedger>,
}

impl CoreShared {
    pub fn new(ledger: Arc<ToolLedger>) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(SharedInner::default()), ledger })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SharedInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 취소했다(`signal`의 `abort`). 도구 장부에 이유를 알리고(기다리던 도구 요청이 그 이유로 거절된다) 떠 있는 프로세스에 입력 닫기 + 바로 SIGTERM을 보낸다
    pub fn abort(&self, reason: &str) {
        let handle = {
            let mut inner = self.lock();
            inner.aborted = true;
            inner.proc.as_ref().map(|(_, handle)| handle.clone())
        };
        self.ledger.abort(reason);
        if let Some(handle) = handle {
            handle.stop(StopMode::Now);
        }
    }

    pub fn aborted(&self) -> bool {
        self.lock().aborted
    }

    /// `seq`번 프로세스의 표준 입력에 사용자 메시지 한 줄을 보낸다(그 프로세스가 지금 것이 아니면 버린다: 닫힌 프로세스의 입력이다)
    pub fn send(&self, seq: u32, text: &str) {
        let handle = self.lock().proc.as_ref().filter(|(current, _)| *current == seq).map(|(_, handle)| handle.clone());
        if let Some(handle) = handle {
            handle.write_line(user_line(text));
        }
    }

    /// 새 프로세스를 올린다. 이미 취소했으면 true(부른 쪽이 바로 끝낸다)
    fn install(&self, seq: u32, handle: Arc<CliHandle>) -> bool {
        let mut inner = self.lock();
        inner.proc = Some((seq, handle));
        inner.aborted
    }

    fn clear(&self, seq: u32) {
        let mut inner = self.lock();
        if inner.proc.as_ref().is_some_and(|(current, _)| *current == seq) {
            inner.proc = None;
        }
    }
}

// ───────────────────────── 실패 ─────────────────────────

/// 실행이 끝나지 못한 이유. TS가 옛 동작으로 바꾼다
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// 콜백이 실패했거나 응답을 알아볼 수 없다. TS가 보관한 오류가 있으면 그것을, 없으면 일반 오류를 던진다
    Hook,
    /// 입력을 읽지 못했다
    Input(String),
    /// 옛 코드가 던지던 오류(`kind`: `type` → `TypeError`, `error` → `Error`)
    Thrown { kind: &'static str, message: String },
}

impl From<Fail> for Stop {
    fn from(fail: Fail) -> Self {
        match fail {
            Fail::Hook | Fail::Aborted => Stop::Hook,
            Fail::Input(message) => Stop::Input(message),
        }
    }
}

type R<T> = Result<T, Stop>;

/// 끝난 모양. `Done`: 결과가 만들어졌다. `NoResult`: 결과 없이 끝났다(메시지는 `no_result_message`). `Aborted`: 취소됐다(TS가 `signal.reason`을 던진다)
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Done,
    NoResult(String),
    Aborted,
}

// ───────────────────────── 입력 ─────────────────────────

struct EscalationPolicy {
    to: String,
    same_signature_times: Option<f64>,
    after_failures: Option<f64>,
    retry_budget: Option<f64>,
}

struct Config {
    max_turns: f64,
    server: String,
    backend: String,
    auth: Option<String>,
    effort: String,
    network_max_attempts: f64,
    network_max_wait_ms: f64,
    network_base_delay_ms: f64,
    network_resume_prompt: String,
    escalation: Option<EscalationPolicy>,
}

fn input_error<T>(message: impl Into<String>) -> R<T> {
    Err(Stop::Input(message.into()))
}

fn read_config(value: &JsValue) -> R<(Config, Option<String>, Option<String>, String)> {
    let number = |key: &str| match value.prop(key) {
        Some(JsValue::Num(n)) => Ok(*n),
        _ => input_error(format!("러너 입력의 {key}가 수가 아닙니다")),
    };
    let text = |key: &str| match value.prop(key) {
        Some(JsValue::Str(t)) => Ok(t.clone()),
        _ => input_error(format!("러너 입력의 {key}가 글자가 아닙니다")),
    };
    let opt_text = |key: &str| match value.prop(key) {
        None | Some(JsValue::Null) => Ok(None),
        Some(JsValue::Str(t)) => Ok(Some(t.clone())),
        _ => input_error(format!("러너 입력의 {key}가 글자가 아닙니다")),
    };
    let opt_number = |object: &JsValue, key: &str| match object.prop(key) {
        None | Some(JsValue::Null) => Ok(None),
        Some(JsValue::Num(n)) => Ok(Some(*n)),
        _ => input_error(format!("러너 입력의 {key}가 수가 아닙니다")),
    };
    let escalation = match value.prop("escalation") {
        None | Some(JsValue::Null) => None,
        Some(policy @ JsValue::Obj(_)) => Some(EscalationPolicy {
            to: match policy.prop("to") {
                Some(JsValue::Str(to)) => to.clone(),
                _ => return input_error("러너 입력의 escalation.to가 글자가 아닙니다"),
            },
            same_signature_times: opt_number(policy, "sameSignatureTimes")?,
            after_failures: opt_number(policy, "afterFailures")?,
            retry_budget: opt_number(policy, "retryBudget")?,
        }),
        Some(_) => return input_error("러너 입력의 escalation이 객체가 아닙니다"),
    };
    let network = value.prop("network").ok_or_else(|| Stop::Input("러너 입력에 network가 없습니다".into()))?;
    let network_number = |key: &str| match network.prop(key) {
        Some(JsValue::Num(n)) => Ok(*n),
        _ => input_error(format!("러너 입력의 network.{key}가 수가 아닙니다")),
    };
    let config = Config {
        max_turns: number("maxTurns")?,
        server: text("server")?,
        backend: text("backend")?,
        auth: opt_text("auth")?,
        effort: text("effort")?,
        network_max_attempts: network_number("maxAttempts")?,
        network_max_wait_ms: network_number("maxWaitMs")?,
        network_base_delay_ms: network_number("baseDelayMs")?,
        network_resume_prompt: text("networkResumePrompt")?,
        escalation,
    };
    Ok((config, opt_text("model")?, opt_text("resume")?, text("pendingPrompt")?))
}

// ───────────────────────── 값 도우미 ─────────────────────────

fn obj(pairs: Vec<(&str, Option<JsValue>)>) -> JsValue {
    js_json::object(pairs)
}

fn num(n: f64) -> Option<JsValue> {
    Some(JsValue::Num(n))
}

fn txt(text: impl Into<String>) -> Option<JsValue> {
    Some(s(text))
}

/// `value ?? 0`
fn or_zero(value: Option<&JsValue>) -> JsValue {
    match value {
        None | Some(JsValue::Null) => JsValue::Num(0.0),
        Some(other) => other.clone(),
    }
}

/// JS의 `a + b`(문자열·배열·객체가 끼면 글자를 잇는다)
fn js_plus(a: &JsValue, b: &JsValue) -> JsValue {
    let stringy = |value: &JsValue| matches!(value, JsValue::Str(_) | JsValue::Arr(_) | JsValue::Obj(_));
    if stringy(a) || stringy(b) {
        JsValue::Str(a.to_js_string() + &b.to_js_string())
    } else {
        JsValue::Num(a.to_number() + b.to_number())
    }
}

/// `Math.max(a, b)`: NaN이 끼면 NaN
fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Set.has`가 같다고 볼 값의 열쇠(SameValueZero). 객체·배열은 줄마다 새로 읽은 값이라 서로 다르다(`fresh`로 새 번호를 준다)
fn id_key(id: &JsValue, fresh: &mut u64) -> String {
    match id {
        JsValue::Str(text) => format!("s{text}"),
        JsValue::Num(n) => format!("n{}", js::number_to_string(if *n == 0.0 { 0.0 } else { *n })),
        JsValue::Bool(on) => format!("b{on}"),
        JsValue::Null | JsValue::Arr(_) | JsValue::Obj(_) => {
            *fresh += 1;
            format!("o{fresh}")
        }
    }
}

fn usage_value(usage: Usage) -> JsValue {
    usage.to_value()
}

/// 마지막으로 끝난 프로세스의 종료 상태(결과 없이 끝났을 때 실패 메시지에 쓴다)
struct LastExit {
    code: Option<i32>,
    signal: Option<String>,
    error_message: Option<String>,
    stderr: String,
}

// ───────────────────────── 러너 ─────────────────────────

struct Runner {
    hook: Hook,
    ledger: Arc<ToolLedger>,
    shared: Arc<CoreShared>,
    cfg: Config,

    session_id: Option<String>,
    last_text: String,
    announced: bool,
    /// 결과를 만들었다(옛 `result`가 있다). 이 뒤의 예외는 삼키고 판정을 지킨다
    result_set: bool,
    reopen: bool,
    last_exit: Option<LastExit>,
    proc_seq: u32,

    message_ids: HashSet<String>,
    fresh_id: u64,
    max_context_tokens: f64,
    gate_ms: f64,

    usage: Usage,
    base_usage: Usage,
    query_usage: Usage,
    query_by_model: JsValue,
    usage_by_model_base: JsValue,
    metrics_usage_by_model: Option<JsValue>,
    model_ms_base: f64,
    query_model_ms: Option<f64>,
    metrics_model_ms: Option<f64>,
    escalated_at: Option<f64>,

    escalation_history: Vec<String>,
    escalated: bool,
    last_feedback: Option<String>,
    model_for_query: Option<String>,
    resume_for_query: Option<String>,
    pending_prompt: String,

    network_attempts: f64,
    network_waited_ms: f64,
}

/// 프로세스 하나의 상태(옛 `runQuery`의 지역 변수)
struct Proc {
    seq: u32,
    handle: Option<Arc<CliHandle>>,
    events: mpsc::UnboundedReceiver<CliEvent>,
    exit: Option<CliExit>,
    detached: bool,
    /// 요약 중 상태를 한 번만 알리기 위한 표시(compact_boundary에서 푼다)
    compacting: bool,
    /// 이 프로세스의 init이 도구 서버를 connected로 알렸는가. 확인하지 못한 채 결과가 오면 통과시키지 않는다
    tool_server_confirmed: bool,
}

impl Proc {
    fn stop(&self, mode: StopMode) {
        if let Some(handle) = &self.handle {
            handle.stop(mode);
        }
    }

    fn close_input(&self) {
        if let Some(handle) = &self.handle {
            handle.close_input();
        }
    }

    fn send(&self, text: &str) {
        if let Some(handle) = &self.handle {
            handle.write_line(user_line(text));
        }
    }

    fn consumed(&self, n: usize) {
        if let Some(handle) = &self.handle {
            handle.consumed(n);
        }
    }
}

impl Runner {
    // ── 콜백 ──

    async fn call(&self, op: &str, fields: Vec<(&str, Option<JsValue>)>) -> R<JsValue> {
        let mut pairs: Vec<(&str, Option<JsValue>)> = vec![("op", txt(op))];
        pairs.extend(fields);
        Ok(call_done(&self.hook, obj(pairs)).await?)
    }

    /// 옛 `onEvent(event)`
    async fn emit(&self, event: JsValue) -> R<()> {
        self.call("event", vec![("event", Some(event))]).await.map(|_| ())
    }

    async fn warn(&self, message: impl Into<String>) -> R<()> {
        self.emit(obj(vec![("type", txt("warning")), ("message", txt(message))])).await
    }

    fn elapsed_ms(started: Instant) -> f64 {
        js::math_round(started.elapsed().as_secs_f64() * 1000.0)
    }

    // ── 끝내기 ──

    /// 옛 `finish`: 결과 조립(TS) → 도구 닫기 → `done`·`failed` 이벤트(TS) → 입력을 닫아 CLI가 끝나게 한다
    async fn finish(&mut self, proc: &Proc, status: &str, summary: Option<String>, use_asked: bool, failure_reason: Option<&str>) -> R<()> {
        let part = obj(vec![
            ("modelCalls", num(self.message_ids.len() as f64)),
            ("maxContextTokens", num(self.max_context_tokens)),
            ("gateMs", num(self.gate_ms)),
            ("usage", Some(usage_value(self.usage))),
            ("usageByModel", self.metrics_usage_by_model.clone()),
            ("modelMs", self.metrics_model_ms.map(JsValue::Num)),
            ("escalatedAt", self.escalated_at.map(JsValue::Num)),
            ("turns", num(self.message_ids.len() as f64)),
            ("sessionId", self.session_id.clone().map(JsValue::Str)),
        ]);
        // 결과를 만들다 던지면 옛 구현도 결과가 없었다(`result`는 만든 뒤에 대입했다)
        self.call(
            "finish",
            vec![("status", txt(status)), ("summary", summary.map(JsValue::Str)), ("useAsked", Some(JsValue::Bool(use_asked))), ("failureReason", failure_reason.map(s)), ("part", Some(part))],
        )
        .await?;
        self.result_set = true;
        self.ledger.close();
        self.call("finishEmit", vec![]).await?;
        // 입력을 닫으면 CLI가 남은 기록을 쓰고 스스로 끝난다. 끝나지 않으면 정해진 시간 뒤 SIGTERM, SIGKILL
        proc.stop(StopMode::Graceful);
        Ok(())
    }

    async fn detach_steering(&self, proc: &mut Proc) -> R<()> {
        if proc.detached {
            return Ok(());
        }
        proc.detached = true;
        self.call("steerDetach", vec![("proc", num(f64::from(proc.seq)))]).await.map(|_| ())
    }

    /// 턴 상한에 걸렸을 때 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131). 통과하면 `done`, 아니면 `failed`(`max_turns`)
    async fn finish_on_max_turns(&mut self, proc: &Proc) -> R<()> {
        let started = Instant::now();
        let answer = self.call("gateRecheck", vec![]).await?;
        self.gate_ms += Self::elapsed_ms(started);
        let pass = matches!(answer.prop("pass"), Some(JsValue::Bool(true)));
        let summary = match answer.prop("summary") {
            Some(JsValue::Str(summary)) => summary.clone(),
            _ => return Err(Stop::Hook),
        };
        if pass {
            self.finish(proc, "done", Some(summary), false, None).await
        } else {
            self.finish(proc, "failed", Some(summary), false, Some("max_turns")).await
        }
    }

    // ── 네트워크 재시도 ──

    /// 일시적 네트워크 오류(ADR-142)에서 재시도할지 정한다. 지수 백오프로 기다린 뒤 true면 같은 세션을 이어받은 새 프로세스를 띄운다.
    /// 상한(횟수·총 대기 시간 중 먼저 걸리는 쪽)을 넘었으면 false. 이어받을 세션이 아직 없으면 원래 요청을 그대로 다시 보낸다
    async fn retry_after_network_failure(&mut self) -> R<bool> {
        if self.network_attempts >= self.cfg.network_max_attempts {
            return Ok(false);
        }
        if self.network_waited_ms >= self.cfg.network_max_wait_ms {
            return Ok(false);
        }
        let delay = (self.cfg.network_base_delay_ms * 2f64.powf(self.network_attempts)).min(self.cfg.network_max_wait_ms - self.network_waited_ms);
        self.network_attempts += 1.0;
        self.network_waited_ms += delay;
        // 대기와 그 뒤의 취소 확인(`signal.throwIfAborted()`)은 TS가 한다. 취소면 던진다(Stop::Hook)
        self.call("wait", vec![("ms", num(delay))]).await?;
        self.warn(format!(
            "네트워크 연결이 끊겨 {}초 기다린 뒤 하던 작업을 이어서 진행합니다 ({}/{}번째 재시도)",
            js::number_to_string(js::math_round(delay / 1000.0)),
            js::number_to_string(self.network_attempts),
            js::number_to_string(self.cfg.network_max_attempts)
        ))
        .await?;
        if let Some(session) = self.session_id.clone() {
            self.resume_for_query = Some(session);
            self.pending_prompt = self.cfg.network_resume_prompt.clone();
        }
        Ok(true)
    }

    // ── 메시지 하나 ──

    async fn handle_line(&mut self, proc: &mut Proc, line: &str) -> R<()> {
        if js::trim(line).is_empty() {
            return Ok(());
        }
        let message = match js_json::parse_lone_encoded(&encode_line(line)) {
            Ok(message @ JsValue::Obj(_)) => message,
            Ok(_) | Err(LoneParseError::Invalid) => return Ok(()),
            Err(LoneParseError::TooDeep) => return Err(Stop::Thrown { kind: "error", message: TOO_DEEP.to_owned() }),
        };
        if let Some(JsValue::Str(session)) = message.prop("session_id") {
            if !session.is_empty() {
                self.session_id = Some(session.clone());
            }
        }
        if self.result_set {
            // 결과를 만든 뒤에는 세션 id만 갱신한다(TS가 끝에 받는다)
            return Ok(());
        }
        match message.prop("type") {
            Some(JsValue::Str(kind)) if kind == "system" => self.on_system(proc, &message).await,
            Some(JsValue::Str(kind)) if kind == "assistant" => {
                let content = message.prop("message").and_then(|inner| inner.prop("content"));
                let body = self.on_assistant(proc, &message).await;
                // 기다리는 도구 요청을 깨우는 것은 턴 세기·턴 상한 확인·이벤트가 끝난 **뒤**다(옛 구현은 같은 동기 구간 안에서 센 뒤 깨어난 요청이 마이크로태스크에서 돌았다).
                // 턴 상한을 넘겼으면 이미 닫았으므로 깨어난 요청은 거절된다. 하위 에이전트 메시지의 tool_use도 센다
                self.ledger.note_tool_uses(content);
                body
            }
            Some(JsValue::Str(kind)) if kind == "result" => self.on_result(proc, &message).await,
            _ => Ok(()),
        }
    }

    async fn on_system(&mut self, proc: &mut Proc, message: &JsValue) -> R<()> {
        let subtype = message.prop("subtype");
        let is = |name: &str| matches!(subtype, Some(JsValue::Str(kind)) if kind == name);
        // init은 턴마다 다시 올 수 있으므로 실행마다 한 번만 알린다
        if is("init") && !self.announced {
            self.announced = true;
            let version = match message.prop("claude_code_version") {
                None | Some(JsValue::Null) => "?".to_owned(),
                Some(value) => value.to_js_string(),
            };
            let model = match message.prop("model") {
                None | Some(JsValue::Null) => match &self.model_for_query {
                    Some(model) => Some(s(model.clone())),
                    None => txt("기본 모델"),
                },
                Some(value) => Some(value.clone()),
            };
            self.emit(obj(vec![
                ("type", txt("session")),
                ("backend", txt(format!("{} (CLI {})", self.cfg.backend, version))),
                ("model", model),
                ("auth", self.cfg.auth.clone().map(JsValue::Str)),
                ("effort", txt(self.cfg.effort.clone())),
            ]))
            .await?;
        }
        // 도구 서버에 붙지 못한 채로 돌면 모델이 도구 없이 "끝났다"고 하고, 변경이 없어 게이트가 통과해 버린다.
        // init의 mcp_servers·mcp_server_errors로 알아채면 통과시키지 않고 실패로 끝낸다
        if is("init") {
            // 옛 구현은 이 두 필드를 napi 경계(`encodeNative`)로 넘겨 짝 없는 서로게이트가 U+FFFD가 되었다
            if let Some(broken) = runner_judge::mcp_setup_failure(&lossy(message), &self.cfg.server) {
                proc.stop(StopMode::Now);
                return self.finish(proc, "failed", Some(enc(&broken)), false, None).await;
            }
            proc.tool_server_confirmed = true;
        }
        // 요약이 시작됐다. CLI는 같은 상태를 되풀이해 보낼 수 있어 요약 한 번에 한 번만 알린다
        if is("status") && matches!(message.prop("status"), Some(JsValue::Str(status)) if status == "compacting") && !proc.compacting {
            proc.compacting = true;
            self.emit(obj(vec![("type", txt("context_compacting"))])).await?;
        }
        if is("compact_boundary") {
            if let Some(meta) = message.prop("compact_metadata").filter(|meta| meta.truthy()) {
                proc.compacting = false;
                self.emit(obj(vec![
                    ("type", txt("context_compacted")),
                    ("trigger", meta.prop("trigger").cloned()),
                    ("preTokens", meta.prop("pre_tokens").cloned()),
                    ("postTokens", meta.prop("post_tokens").cloned()),
                    ("durationMs", meta.prop("duration_ms").cloned()),
                ]))
                .await?;
            }
        }
        Ok(())
    }

    async fn on_assistant(&mut self, proc: &mut Proc, message: &JsValue) -> R<()> {
        // 하위 에이전트 메시지는 없어야 하지만, 섞여 와도 본 대화로 세지 않는다
        if message.prop("parent_tool_use_id").is_some_and(JsValue::truthy) {
            return Ok(());
        }
        let Some(inner) = message.prop("message") else { return Ok(()) };
        let Some(id) = inner.prop("id").filter(|id| id.truthy()) else { return Ok(()) };
        // 한 호출의 입력 크기 = input + cache_read + cache_creation. 같은 id가 여러 번 와도 최댓값은 같다
        let usage = inner.prop("usage").filter(|usage| usage.truthy());
        let turn_context = match usage {
            Some(usage) => js_plus(&js_plus(&or_zero(usage.prop("input_tokens")), &or_zero(usage.prop("cache_read_input_tokens"))), &or_zero(usage.prop("cache_creation_input_tokens"))),
            None => JsValue::Num(0.0),
        };
        if usage.is_some() {
            self.max_context_tokens = math_max(self.max_context_tokens, turn_context.to_number());
        }
        let key = id_key(id, &mut self.fresh_id);
        if self.message_ids.insert(key) {
            let turn = self.message_ids.len() as f64;
            self.emit(obj(vec![("type", txt("turn")), ("turn", num(turn))])).await?;
            // 턴 하나의 사용량. 같은 메시지 id가 여러 번 와도 한 번만 남긴다(누적값 tokens와 다르다)
            if let Some(usage) = usage {
                self.emit(obj(vec![
                    ("type", txt("turn_usage")),
                    ("turn", num(turn)),
                    ("inputTokens", Some(or_zero(usage.prop("input_tokens")))),
                    ("outputTokens", Some(or_zero(usage.prop("output_tokens")))),
                    ("cacheReadTokens", Some(or_zero(usage.prop("cache_read_input_tokens")))),
                    ("cacheWriteTokens", Some(or_zero(usage.prop("cache_creation_input_tokens")))),
                    ("contextTokens", Some(turn_context.clone())),
                ]))
                .await?;
            }
            if turn > self.cfg.max_turns {
                // 진행 중인 턴을 끝까지 기다리지 않는다: 입력을 닫고 바로 SIGTERM. 이미 보낸 도구 호출이 더 닿아도 파일을 건드리지 않게 닫는다.
                self.ledger.close();
                proc.stop(StopMode::Now);
                // 하던 도구 호출이 있으면 끝나기를 기다린 뒤 게이트를 본다
                self.ledger.idle().await;
                // 턴 상한에 걸렸다. 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
                return self.finish_on_max_turns(proc).await;
            }
        }
        let blocks: &[JsValue] = match inner.prop("content") {
            Some(JsValue::Arr(items)) => items,
            _ => &[],
        };
        let mut texts: Vec<&str> = Vec::new();
        for block in blocks {
            // `block.type`: null이면 JS가 던진다(옛 구현도 TypeError로 끝났다). 다른 값은 `undefined`로 읽는다
            if matches!(block, JsValue::Null) {
                return Err(Stop::Thrown { kind: "type", message: "Cannot read properties of null (reading 'type')".to_owned() });
            }
            if matches!(block.prop("type"), Some(JsValue::Str(kind)) if kind == "text") {
                if let Some(JsValue::Str(text)) = block.prop("text") {
                    texts.push(text);
                }
            }
        }
        let text = js::trim(&texts.join("\n")).to_owned();
        if !text.is_empty() {
            self.emit(obj(vec![("type", txt("text")), ("text", txt(text.clone()))])).await?;
            self.last_text = text;
        }
        Ok(())
    }

    async fn on_result(&mut self, proc: &mut Proc, message: &JsValue) -> R<()> {
        // init으로 도구 서버 연결을 확인하지 못했다(init이 없었다). 도구 없이 돈 턴일 수 있어 결과를 통과로 쓰지 않는다
        if !proc.tool_server_confirmed {
            let text = format!("Claude Code가 {} 도구 서버에 연결됐는지 확인하지 못했습니다(시작 정보가 오지 않음)", self.cfg.server);
            return self.finish(proc, "failed", Some(text), false, None).await;
        }
        // modelUsage는 이 프로세스의 누적값이다. 끝난 프로세스들의 사용량(base)과 더해 실행 전체를 만든다
        let (total, by_model) = runner_judge::usage_of(message.prop("modelUsage")).map_err(|reason| Stop::Thrown { kind: "error", message: reason })?;
        self.query_usage = total;
        self.usage = self.base_usage.add(self.query_usage);
        self.query_by_model = runner_judge::by_model_value(&by_model);
        self.metrics_usage_by_model = Some(runner_judge::merge_usage_by_model(&self.usage_by_model_base, &self.query_by_model));
        if let Some(api_ms) = runner_judge::api_duration_of(message.prop("duration_api_ms")) {
            // 누적값이라 줄어들 수 없다. 줄어든 값이 오면(형식이 바뀐 경우) 이미 잰 것을 깎지 않는다
            let query_ms = math_max(self.query_model_ms.unwrap_or(0.0), api_ms);
            self.query_model_ms = Some(query_ms);
            self.metrics_model_ms = Some(self.model_ms_base + query_ms);
        }
        self.emit(obj(vec![("type", txt("tokens")), ("usage", Some(usage_value(self.usage)))])).await?;
        // 옛 구현은 이 판정의 입력을 napi 경계(`encodeNative`)로 넘겨 짝 없는 서로게이트가 U+FFFD가 되었다
        if let Some(failure) = runner_judge::describe_result_failure(&lossy(message)) {
            // Claude Code 자신이 턴 상한(error_max_turns)으로 끝냈어도, 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
            if matches!(message.prop("subtype"), Some(JsValue::Str(subtype)) if subtype == "error_max_turns") {
                return self.finish_on_max_turns(proc).await;
            }
            // 일시적 네트워크 오류(ENOTFOUND 등, ADR-142)면 바로 실패로 끝내지 않고 기다렸다 같은 세션을 이어받는다.
            // 승격처럼 이 프로세스는 여기서 닫고 새로 띄운다(reopen). 상한을 넘으면 실패로 끝나되 사유를 남긴다
            if runner_judge::is_transient_network_failure(&failure) {
                self.detach_steering(proc).await?;
                if self.retry_after_network_failure().await? {
                    proc.stop(StopMode::Graceful);
                    self.reopen = true;
                    return Ok(());
                }
                return self.finish(proc, "failed", Some(format!("네트워크 연결이 끊겨 재시도했지만 복구되지 않았습니다: {}", enc(&failure))), false, Some("network")).await;
            }
            return self.finish(proc, "failed", Some(enc(&failure)), false, None).await;
        }
        // 되묻고 멈추기: ask_user가 질문을 남겼으면 입력을 닫아 CLI가 끝나게 하고 실행을 끝낸다.
        // 이미 결과(턴의 끝)를 받았으므로 진행 중인 턴이 없어 신호로 끊을 필요가 없다. 질문 전에 파일을 바꿨다면 그 변경도 게이트를 돌린다(변경이 없으면 돌리지 않는다)
        let asked = self.call("asked", vec![]).await?;
        if matches!(asked.prop("asked"), Some(JsValue::Bool(true))) {
            proc.close_input();
            let started = Instant::now();
            let checked = self.call("gateAskedCheck", vec![]).await?;
            if matches!(checked.prop("ran"), Some(JsValue::Bool(true))) {
                self.gate_ms += Self::elapsed_ms(started);
            }
            return self.finish(proc, "awaiting_input", None, true, None).await;
        }
        // 모델이 턴을 끝냈다 → 만들기면 검증 게이트. 지연 기동 세션이 아무것도 바꾸지 않았으면 게이트가 없다 → 샌드박스 없이 끝난다
        let started = Instant::now();
        let checked = self.call("gateCheck", vec![]).await?;
        if !matches!(checked.prop("gate"), Some(JsValue::Bool(true))) {
            let text = self.last_text.clone();
            return self.finish(proc, "done", Some(text), false, None).await;
        }
        self.gate_ms += Self::elapsed_ms(started);
        let kind = match checked.prop("kind") {
            Some(JsValue::Str(kind)) => kind.clone(),
            _ => return Err(Stop::Hook),
        };
        let attempts = checked.prop("attempts").map(JsValue::to_number);
        let text_field = |key: &str| match checked.prop(key) {
            Some(JsValue::Str(text)) => Ok(text.clone()),
            _ => Err(Stop::Hook),
        };
        match kind.as_str() {
            "pass" => {
                if matches!(checked.prop("verified"), Some(JsValue::Bool(true))) {
                    self.emit(obj(vec![("type", txt("stage")), ("stage", txt("checkpoint")), ("source", txt("platform"))])).await?;
                }
                let text = self.last_text.clone();
                return self.finish(proc, "done", Some(text), false, None).await;
            }
            "retry" | "exhausted" => {}
            _ => return Err(Stop::Hook),
        }
        let (feedback, summary) = if kind == "retry" { (Some(text_field("feedback")?), None) } else { (None, Some(text_field("summary")?)) };
        if kind == "retry" {
            self.last_text = String::new();
        }
        // 승격: 같은 서명이 반복되거나, 설정이 있으면 실패 N번이 계기가 된다. 한 실행에 한 번만 올린다
        if self.cfg.escalation.is_some() && !self.escalated {
            let key = match self.call("signature", vec![]).await?.prop("key") {
                Some(JsValue::Str(key)) => key.clone(),
                _ => return Err(Stop::Hook),
            };
            self.escalation_history.push(key.clone());
            let (to, same, after, budget) = {
                let policy = self.cfg.escalation.as_ref().expect("위에서 확인했다");
                (policy.to.clone(), policy.same_signature_times, policy.after_failures, policy.retry_budget)
            };
            if escalation::should_promote(same, DEFAULT_SAME_SIGNATURE_TIMES, after, &self.escalation_history) {
                // 올라간 모델에게 게이트 재시도를 새로 준다(기존 남은 횟수 대신)
                let granted = self.call("grantBudget", vec![("budget", num(escalation::retry_budget_for(budget, DEFAULT_ESCALATION_RETRY_BUDGET)))]).await?;
                let extended = matches!(granted.prop("extended"), Some(JsValue::Bool(true)));
                let promoted_attempts = granted.prop("attempts").map(JsValue::to_number).or(attempts);
                // 상한이 이미 소진됐는데 예산도 못 받았으면 올려도 시도할 기회가 없다 — 아래에서 실패로 끝난다
                if kind == "retry" || extended {
                    self.escalated = true;
                    self.escalated_at = promoted_attempts;
                    // 닫히는 입력으로 지시가 들어가 사라지지 않게, 닫기 전에 이 프로세스의 지시 연결을 끊는다.
                    // 그 뒤 들어온 지시는 큐에 남아 새 프로세스가 연결할 때 flush로 가져간다
                    self.detach_steering(proc).await?;
                    self.emit(obj(vec![
                        ("type", txt("model_escalated")),
                        ("from", txt(self.model_for_query.clone().unwrap_or_else(|| "기본 모델".to_owned()))),
                        ("to", txt(to.clone())),
                        ("attempt", promoted_attempts.map(JsValue::Num)),
                        ("signature", txt(key)),
                        ("sameSignatureTimes", num(same.unwrap_or(DEFAULT_SAME_SIGNATURE_TIMES))),
                    ]))
                    .await?;
                    self.model_for_query = Some(to);
                    self.resume_for_query = self.session_id.clone();
                    // 상한을 새로 받은 경우에는 마지막 실패 안내를 다시 보낸다(올라간 모델이 무엇을 고칠지 알게)
                    self.pending_prompt = match &feedback {
                        Some(feedback) => feedback.clone(),
                        None => escalation::escalation_prompt(summary.as_deref().unwrap_or(""), self.last_feedback.as_deref()),
                    };
                    proc.stop(StopMode::Graceful);
                    // 같은 대화를 이어받아 모델만 바꾸려면 새 프로세스가 필요하다. 이 프로세스는 여기서 닫는다
                    self.reopen = true;
                    return Ok(());
                }
            }
        }
        match feedback {
            None => self.finish(proc, "failed", summary, false, None).await,
            Some(feedback) => {
                self.last_feedback = Some(feedback.clone());
                proc.send(&feedback);
                Ok(())
            }
        }
    }

    // ── 프로세스 하나 ──

    async fn pump_messages(&mut self, proc: &mut Proc) -> R<()> {
        loop {
            match proc.events.recv().await {
                None => return Ok(()),
                Some(CliEvent::Exit(exit)) => {
                    proc.exit = Some(exit);
                    return Ok(());
                }
                Some(CliEvent::Lines(lines)) => {
                    for line in lines {
                        self.handle_line(proc, &line).await?;
                        proc.consumed(1);
                        if self.reopen {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    /// 프로세스가 끝날 때까지 남은 줄을 소비해 비우고 끝 상태를 받는다
    async fn drain(proc: &mut Proc) {
        while proc.exit.is_none() {
            match proc.events.recv().await {
                Some(CliEvent::Exit(exit)) => proc.exit = Some(exit),
                Some(CliEvent::Lines(lines)) => proc.consumed(lines.len()),
                None => break,
            }
        }
    }

    /// CLI 프로세스 하나를 끝까지 돈다. 승격·네트워크 재시도면 `reopen`이 서고 부른 쪽이 새 프로세스를 띄운다
    async fn run_query(&mut self) -> R<()> {
        // 이 프로세스의 사용량. result의 modelUsage는 프로세스 누적값이라 result마다 덮어쓴다
        self.query_usage = Usage::default();
        self.query_by_model = JsValue::Obj(JsObject::new());
        if let Some(resume) = &self.resume_for_query {
            if !is_session_id(resume) {
                self.warn("이어받을 대화의 id가 올바르지 않아 새 대화로 시작합니다").await?;
                self.resume_for_query = None;
            }
        }
        let spawn = self
            .call("args", vec![("model", self.model_for_query.clone().map(JsValue::Str)), ("resume", self.resume_for_query.clone().map(JsValue::Str))])
            .await?;
        self.proc_seq += 1;
        let seq = self.proc_seq;
        let (events_tx, events) = mpsc::unbounded_channel::<CliEvent>();
        let mut proc = Proc { seq, handle: None, events, exit: None, detached: false, compacting: false, tool_server_confirmed: false };
        let mut stderr = String::new();
        match spawn.prop("spawnError") {
            // 실행 파일을 찾지 못했다: 메시지 없이 곧바로 끝나고 끝 상태에 오류를 싣는다(옛 `failedProcess`와 같은 흐름)
            Some(JsValue::Str(message)) => {
                let message = lossy_str(message);
                let _ = events_tx.send(CliEvent::Exit(CliExit { code: None, signal: None, error: Some(CliSpawnError { code: "ENOENT".to_owned(), errno: 0, message }) }));
            }
            _ => {
                let config = read_spawn(&spawn)?;
                let callback: OnCliEvent = Arc::new(move |event| {
                    let _ = events_tx.send(event);
                });
                let (handle, pump) = cli_process::spawn_cli(config, callback);
                tokio::spawn(pump);
                let handle = Arc::new(handle);
                // 준비하는 동안 취소가 먼저 왔으면 리스너가 이 프로세스를 모른다
                if self.shared.install(seq, handle.clone()) {
                    handle.stop(StopMode::Now);
                }
                proc.handle = Some(handle);
            }
        }
        // 입력 쪽은 사용자 메시지 한 줄씩. finish와 승격이 이 입력을 닫는다
        proc.send(&self.pending_prompt);
        // 진행 중 지시는 표준 입력에 사용자 메시지로 넣는다. 승격으로 새 프로세스를 띄워도 이 연결을 다시 건다(TS가 지시 큐를 든다)
        let mut failed: Option<Stop> = match self.call("steerAttach", vec![("proc", num(f64::from(seq)))]).await {
            Ok(_) => None,
            Err(error) => Some(error),
        };
        if failed.is_none() {
            if let Err(error) = self.pump_messages(&mut proc).await {
                failed = Some(error);
            }
        }
        // 결과 처리 중 난 예외다. 프로세스를 바로 끝낸다. 이미 결과로 끝낸 실행이면 그 판정을 지킨다.
        // 던지게 두면 호출자가 오류로 보고, 턴 상한에서 게이트를 통과해 남기기로 한 변경까지 되돌린다(ADR-131, 트러블슈팅 131)
        let mut error: Option<Stop> = None;
        if let Some(thrown) = failed {
            proc.stop(StopMode::Now);
            if !self.result_set {
                error = Some(thrown);
            }
        }
        // finally: 어떤 경로로 나왔든 지시 연결을 끊고 프로세스를 끝낸다(이미 끝났거나 닫는 중이면 무시). 끝나기를 기다려 다음 프로세스와 겹치지 않게 한다
        if let Err(thrown) = self.detach_steering(&mut proc).await {
            error.get_or_insert(thrown);
        }
        proc.stop(StopMode::Graceful);
        Self::drain(&mut proc).await;
        if let Some(handle) = &proc.handle {
            stderr = String::from_utf16_lossy(&handle.stderr_tail());
        }
        self.shared.clear(seq);
        // 이 프로세스의 사용량을 실행 전체 누적에 더한다. 승격이 없으면 여기서 한 번만 더해 결과가 지금과 같다
        self.base_usage = self.base_usage.add(self.query_usage);
        if let JsValue::Obj(by_model) = &self.query_by_model {
            let mut base = match &self.usage_by_model_base {
                JsValue::Obj(object) => object.clone(),
                _ => JsObject::new(),
            };
            for (model, usage) in by_model.entries_js_order() {
                let merged = match base.get(model) {
                    Some(existing) => Usage::from_agent(existing).add(Usage::from_agent(usage)),
                    None => Usage::default().add(Usage::from_agent(usage)),
                };
                base.set(model, merged.to_value());
            }
            self.usage_by_model_base = JsValue::Obj(base);
        }
        self.model_ms_base += self.query_model_ms.unwrap_or(0.0);
        self.query_model_ms = None;
        let exit = proc.exit.take().unwrap_or(CliExit { code: None, signal: None, error: None });
        self.last_exit = Some(LastExit { code: exit.code, signal: exit.signal, error_message: exit.error.map(|error| error.message), stderr });
        match error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// 승격이 일어나면 같은 세션을 이어받은 새 프로세스를 모델만 바꿔 다시 띄운다. 그 밖에는 한 프로세스로 끝까지 돈다
    async fn run(&mut self) -> R<Outcome> {
        loop {
            self.reopen = false;
            self.run_query().await?;
            if self.result_set {
                return Ok(Outcome::Done);
            }
            // 취소했으면 결과 없음이 아니라 취소다
            if self.shared.aborted() {
                return Ok(Outcome::Aborted);
            }
            if !self.reopen {
                return Ok(Outcome::NoResult(self.no_result_message()));
            }
        }
    }

    /// 프로세스가 결과 없이 끝났다는 실패 메시지. 종료 코드와 표준 오류의 끝부분을 담는다
    fn no_result_message(&self) -> String {
        match &self.last_exit {
            None => runner_judge::no_result_message(false, None, None, None, ""),
            Some(exit) => runner_judge::no_result_message(true, exit.error_message.as_deref(), exit.signal.as_deref(), exit.code.map(f64::from), &exit.stderr),
        }
    }
}

/// `args` 콜백이 돌려준 띄우기 설정. 글자는 napi 경계를 거치던 옛 구현과 같게 짝 없는 서로게이트를 U+FFFD로 바꿔 읽는다
fn read_spawn(spawn: &JsValue) -> R<CliConfig> {
    let text = |key: &str| match spawn.prop(key) {
        Some(JsValue::Str(value)) => Ok(lossy_str(value)),
        _ => input_error(format!("args 응답의 {key}가 글자가 아닙니다")),
    };
    let millis = |key: &str| match spawn.prop(key) {
        Some(JsValue::Num(ms)) if ms.is_finite() && *ms > 0.0 => Ok(std::time::Duration::from_secs_f64(ms / 1000.0)),
        Some(JsValue::Num(_)) => Ok(std::time::Duration::from_millis(1)),
        _ => input_error(format!("args 응답의 {key}가 수가 아닙니다")),
    };
    let args = match spawn.prop("args") {
        Some(JsValue::Arr(items)) => items.iter().map(|item| item.as_str().map(lossy_str).ok_or_else(|| Stop::Input("args 응답의 args에 글자가 아닌 항목이 있습니다".into()))).collect::<R<Vec<_>>>()?,
        _ => return input_error("args 응답의 args가 목록이 아닙니다"),
    };
    let env = match spawn.prop("env") {
        Some(JsValue::Obj(object)) => object
            .entries()
            .iter()
            .map(|(name, value)| value.as_str().map(|value| (lossy_str(name), lossy_str(value))).ok_or_else(|| Stop::Input("args 응답의 env에 글자가 아닌 값이 있습니다".into())))
            .collect::<R<Vec<_>>>()?,
        _ => return input_error("args 응답의 env가 객체가 아닙니다"),
    };
    Ok(CliConfig { bin: text("bin")?, args, env, cwd: Some(text("cwd")?), term_after: millis("termAfterMs")?, kill_after: millis("killAfterMs")?, line_high: cli_process::LINE_HIGH, line_low: cli_process::LINE_LOW })
}

/// 러너 코어를 돈다. `input`은 JSON(`encodeNative`·`encodeLoneSurrogates`한 꼴), 결과도 JSON이다.
/// `{ ok: true, outcome: "done" | "noResult" | "aborted", sessionId?, message? }`(`message`는 글자 그대로의 실패 메시지) 또는 `{ ok: false, kind: "hook" | "input" | "thrown", message?, errorKind? }`.
pub async fn run(input: &str, hook: Hook, shared: Arc<CoreShared>, ledger: Arc<ToolLedger>) -> String {
    let result = run_inner(input, hook, shared, ledger).await;
    match result {
        Ok((outcome, session_id)) => {
            let (kind, message) = match outcome {
                Outcome::Done => ("done", None),
                Outcome::NoResult(message) => ("noResult", Some(message)),
                Outcome::Aborted => ("aborted", None),
            };
            js_json::to_native(&obj(vec![("ok", Some(JsValue::Bool(true))), ("outcome", txt(kind)), ("sessionId", session_id.map(JsValue::Str)), ("message", message.map(JsValue::Str))]))
        }
        Err(Stop::Hook) => js_json::to_native(&obj(vec![("ok", Some(JsValue::Bool(false))), ("kind", txt("hook"))])),
        Err(Stop::Input(message)) => js_json::to_native(&obj(vec![("ok", Some(JsValue::Bool(false))), ("kind", txt("input")), ("message", txt(message))])),
        Err(Stop::Thrown { kind, message }) => js_json::to_native(&obj(vec![("ok", Some(JsValue::Bool(false))), ("kind", txt("thrown")), ("errorKind", txt(kind)), ("message", txt(message))])),
    }
}

async fn run_inner(input: &str, hook: Hook, shared: Arc<CoreShared>, ledger: Arc<ToolLedger>) -> R<(Outcome, Option<String>)> {
    let value = js_json::parse_native(input).or_else(|_| input_error("러너 입력을 읽지 못했습니다"))?;
    let (cfg, model, resume, pending_prompt) = read_config(&value)?;
    let mut runner = Runner {
        hook,
        ledger,
        shared,
        cfg,
        session_id: None,
        last_text: String::new(),
        announced: false,
        result_set: false,
        reopen: false,
        last_exit: None,
        proc_seq: 0,
        message_ids: HashSet::new(),
        fresh_id: 0,
        max_context_tokens: 0.0,
        gate_ms: 0.0,
        usage: Usage::default(),
        base_usage: Usage::default(),
        query_usage: Usage::default(),
        query_by_model: JsValue::Obj(JsObject::new()),
        usage_by_model_base: JsValue::Obj(JsObject::new()),
        metrics_usage_by_model: None,
        model_ms_base: 0.0,
        query_model_ms: None,
        metrics_model_ms: None,
        escalated_at: None,
        escalation_history: Vec::new(),
        escalated: false,
        last_feedback: None,
        model_for_query: model,
        resume_for_query: resume,
        pending_prompt,
        network_attempts: 0.0,
        network_waited_ms: 0.0,
    };
    let outcome = runner.run().await?;
    Ok((outcome, runner.session_id.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    #[test]
    fn session_id_accepts_only_uuid_shape() {
        assert!(is_session_id("00000000-0000-4000-8000-000000000001"));
        assert!(is_session_id("ABCDEF01-0000-4000-8000-00000000000a"));
        assert!(!is_session_id("00000000-0000-4000-8000-00000000000"));
        assert!(!is_session_id("00000000-0000-4000-8000-0000000000012"));
        assert!(!is_session_id("0000000g-0000-4000-8000-000000000001"));
        assert!(!is_session_id("00000000-0000-4000-8000-000000000001\n"));
        assert!(!is_session_id("００００００００-0000-4000-8000-000000000001"));
        assert!(!is_session_id(""));
    }

    #[test]
    fn user_line_matches_json_stringify() {
        assert_eq!(user_line("안녕 \"x\"\n"), r#"{"type":"user","message":{"role":"user","content":"안녕 \"x\"\n"},"parent_tool_use_id":null}"#);
        // 짝 없는 서로게이트는 `\ud800` 이스케이프(JSON.stringify의 well-formed 꼴)
        let text = format!("a{}b", js::encode_lone_unit(0xD800));
        assert_eq!(user_line(&text), r#"{"type":"user","message":{"role":"user","content":"a\ud800b"},"parent_tool_use_id":null}"#);
    }

    #[test]
    fn js_plus_follows_javascript() {
        assert_eq!(js_plus(&JsValue::Num(1.0), &JsValue::Num(2.0)), JsValue::Num(3.0));
        assert_eq!(js_plus(&JsValue::Str("5".into()), &JsValue::Num(0.0)), JsValue::Str("50".into()));
        assert_eq!(js_plus(&JsValue::Bool(true), &JsValue::Num(1.0)), JsValue::Num(2.0));
    }

    // ── 가짜 콜백과 `sh` 가짜 CLI로 코어를 끝까지 돈다 ──

    #[derive(Default)]
    struct Script {
        gate: Vec<&'static str>,
        events: Vec<JsValue>,
        ops: Vec<String>,
        finished: Option<(String, Option<String>)>,
    }

    fn hook_for(script: Arc<StdMutex<Script>>, shell: String) -> Hook {
        Arc::new(move |request: String| {
            let script = script.clone();
            let shell = shell.clone();
            Box::pin(async move {
                let value = js_json::parse_native(&request).unwrap();
                let op = value.prop("op").and_then(JsValue::as_str).unwrap().to_owned();
                let mut state = script.lock().unwrap();
                state.ops.push(op.clone());
                let reply = match op.as_str() {
                    "event" => {
                        state.events.push(value.prop("event").cloned().unwrap());
                        r#"{"ok":true}"#.to_owned()
                    }
                    "args" => js_json::to_native(&obj(vec![
                        ("ok", Some(JsValue::Bool(true))),
                        ("bin", txt("/bin/sh")),
                        ("args", Some(JsValue::Arr(vec![s("-c"), s(shell.clone())]))),
                        ("env", Some(obj(vec![("PATH", txt("/usr/bin:/bin"))]))),
                        ("cwd", txt("/")),
                        ("termAfterMs", num(200.0)),
                        ("killAfterMs", num(200.0)),
                    ])),
                    "asked" => r#"{"ok":true,"asked":false}"#.to_owned(),
                    "gateCheck" => match state.gate.first().copied() {
                        None => r#"{"ok":true,"gate":false}"#.to_owned(),
                        Some(kind) => {
                            let kind = kind.to_owned();
                            state.gate.remove(0);
                            match kind.as_str() {
                                "retry" => r#"{"ok":true,"gate":true,"kind":"retry","feedback":"고치세요","verified":false,"attempts":1}"#.to_owned(),
                                _ => r#"{"ok":true,"gate":true,"kind":"pass","verified":true,"attempts":1}"#.to_owned(),
                            }
                        }
                    },
                    "gateRecheck" => r#"{"ok":true,"pass":false,"summary":"최대 턴 수를 넘었습니다"}"#.to_owned(),
                    "finish" => {
                        let status = value.prop("status").and_then(JsValue::as_str).unwrap().to_owned();
                        let summary = value.prop("summary").and_then(JsValue::as_str).map(str::to_owned);
                        state.finished = Some((status, summary));
                        r#"{"ok":true}"#.to_owned()
                    }
                    _ => r#"{"ok":true}"#.to_owned(),
                };
                Some(reply)
            })
        })
    }

    fn input(max_turns: f64) -> String {
        js_json::to_native(&obj(vec![
            ("maxTurns", num(max_turns)),
            ("server", txt("b-studio")),
            ("backend", txt("로컬")),
            ("effort", txt("high")),
            ("network", Some(obj(vec![("maxAttempts", num(0.0)), ("maxWaitMs", num(0.0)), ("baseDelayMs", num(1.0))]))),
            ("networkResumePrompt", txt("이어서")),
            ("pendingPrompt", txt("요청")),
        ]))
    }

    async fn drive(shell: &str, script: Arc<StdMutex<Script>>, max_turns: f64) -> (String, Arc<ToolLedger>) {
        let ledger = Arc::new(ToolLedger::new("mcp__b-studio__", Duration::from_millis(100)));
        let shared = CoreShared::new(ledger.clone());
        let hook = hook_for(script, shell.to_owned());
        let answer = tokio::time::timeout(Duration::from_secs(20), run(&input(max_turns), hook, shared, ledger.clone())).await.expect("코어가 끝나지 않았다");
        (answer, ledger)
    }

    const INIT: &str = r#"{"type":"system","subtype":"init","session_id":"s1","mcp_servers":[{"name":"b-studio","status":"connected"}]}"#;

    #[tokio::test]
    async fn passes_when_the_gate_passes() {
        let script = Arc::new(StdMutex::new(Script { gate: vec!["pass"], ..Default::default() }));
        let shell = format!(
            r#"echo '{INIT}'; echo '{{"type":"assistant","message":{{"id":"m1","content":[{{"type":"text","text":" 끝 "}}]}},"session_id":"s1"}}'; echo '{{"type":"result","subtype":"success","is_error":false,"result":"x","modelUsage":{{"m":{{"inputTokens":3,"outputTokens":2}}}},"session_id":"s2"}}'; sleep 0.3"#
        );
        let (answer, _) = drive(&shell, script.clone(), 60.0).await;
        let answer = js_json::parse_native(&answer).unwrap();
        assert_eq!(answer.prop("ok"), Some(&JsValue::Bool(true)));
        assert_eq!(answer.prop("outcome").and_then(JsValue::as_str), Some("done"));
        assert_eq!(answer.prop("sessionId").and_then(JsValue::as_str), Some("s2"));
        let state = script.lock().unwrap();
        assert_eq!(state.finished, Some(("done".to_owned(), Some("끝".to_owned()))));
        let kinds: Vec<_> = state.events.iter().filter_map(|event| event.prop("type").and_then(JsValue::as_str)).collect();
        assert_eq!(kinds, vec!["session", "turn", "text", "tokens", "stage"]);
    }

    #[tokio::test]
    async fn result_without_init_never_passes() {
        let script = Arc::new(StdMutex::new(Script { gate: vec!["pass"], ..Default::default() }));
        let shell = r#"echo '{"type":"result","subtype":"success","is_error":false,"result":"x","modelUsage":{}}'; sleep 0.3"#;
        let (_, _) = drive(shell, script.clone(), 60.0).await;
        let state = script.lock().unwrap();
        assert_eq!(state.finished.as_ref().map(|(status, _)| status.as_str()), Some("failed"));
        assert!(!state.ops.iter().any(|op| op == "gateCheck"), "게이트를 돌리지 않는다");
    }

    #[tokio::test]
    async fn mcp_setup_failure_fails_without_gate() {
        let script = Arc::new(StdMutex::new(Script::default()));
        let shell = r#"echo '{"type":"system","subtype":"init","session_id":"s1","mcp_servers":[{"name":"b-studio","status":"failed"}]}'; sleep 0.3"#;
        let (_, _) = drive(shell, script.clone(), 60.0).await;
        let state = script.lock().unwrap();
        assert_eq!(state.finished.as_ref().map(|(status, _)| status.as_str()), Some("failed"));
    }

    #[tokio::test]
    async fn turn_limit_closes_tools_and_rechecks_gate() {
        let script = Arc::new(StdMutex::new(Script::default()));
        let shell = format!(
            r#"echo '{INIT}'; echo '{{"type":"assistant","message":{{"id":"m1","content":[]}}}}'; echo '{{"type":"assistant","message":{{"id":"m2","content":[]}}}}'; sleep 0.3"#
        );
        let (_, ledger) = drive(&shell, script.clone(), 1.0).await;
        assert!(ledger.is_closed());
        let state = script.lock().unwrap();
        assert!(state.ops.iter().any(|op| op == "gateRecheck"));
        assert_eq!(state.finished.as_ref().map(|(status, _)| status.as_str()), Some("failed"));
    }

    #[tokio::test]
    async fn turn_limit_is_strictly_greater() {
        // 턴이 상한과 같으면(1 > 1이 아니다) 넘지 않았다
        let script = Arc::new(StdMutex::new(Script { gate: vec!["pass"], ..Default::default() }));
        let shell = format!(
            r#"echo '{INIT}'; echo '{{"type":"assistant","message":{{"id":"m1","content":[]}}}}'; echo '{{"type":"result","subtype":"success","is_error":false,"result":"","modelUsage":{{}}}}'; sleep 0.3"#
        );
        let (_, _) = drive(&shell, script.clone(), 1.0).await;
        let state = script.lock().unwrap();
        assert!(!state.ops.iter().any(|op| op == "gateRecheck"));
        assert_eq!(state.finished.as_ref().map(|(status, _)| status.as_str()), Some("done"));
    }

    #[tokio::test]
    async fn process_without_result_is_no_result() {
        let script = Arc::new(StdMutex::new(Script::default()));
        let shell = format!(r#"echo '{INIT}'; echo boom >&2; sleep 0.2; exit 3"#);
        let (answer, _) = drive(&shell, script.clone(), 60.0).await;
        let answer = js_json::parse_native(&answer).unwrap();
        assert_eq!(answer.prop("outcome").and_then(JsValue::as_str), Some("noResult"));
        let message = answer.prop("message").and_then(JsValue::as_str).unwrap();
        assert!(message.contains("종료 코드 3") && message.contains("boom"), "{message}");
    }

    #[tokio::test]
    async fn gate_retry_sends_feedback_on_stdin() {
        // 게이트가 한 번 실패하면 결과를 다음 사용자 메시지로 넣고, 두 번째 result에서 통과한다
        let script = Arc::new(StdMutex::new(Script { gate: vec!["retry", "pass"], ..Default::default() }));
        let seen = tempfile::NamedTempFile::new().unwrap();
        let path = seen.path().to_str().unwrap().to_owned();
        let shell = format!(
            r#"echo '{INIT}'; read first; echo '{{"type":"result","subtype":"success","is_error":false,"result":"","modelUsage":{{}}}}'; read second; echo "$second" > {path}; echo '{{"type":"result","subtype":"success","is_error":false,"result":"","modelUsage":{{}}}}'; sleep 0.3"#
        );
        let (_, _) = drive(&shell, script.clone(), 60.0).await;
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("고치세요"), "{written}");
        assert_eq!(script.lock().unwrap().finished.as_ref().map(|(status, _)| status.as_str()), Some("done"));
    }

    #[tokio::test]
    async fn too_deep_line_fails_closed() {
        let script = Arc::new(StdMutex::new(Script::default()));
        let deep = format!("{{\"a\":{}1{}}}", "[".repeat(3000), "]".repeat(3000));
        let shell = format!("echo '{INIT}'; echo '{deep}'; sleep 0.3");
        let (answer, _) = drive(&shell, script.clone(), 60.0).await;
        let answer = js_json::parse_native(&answer).unwrap();
        assert_eq!(answer.prop("kind").and_then(JsValue::as_str), Some("thrown"));
    }
}
