//! 게이트의 선언한 검사 실행(옛 TS: `packages/agent/src/gate.ts`의 `VerificationGate.#runDeclaredChecks`·`#runLoadChecks`·`#clearTestReports`·`#runTest`·
//! `#reviveIfOomKilled`·`#runConcurrencyCheck`와 `task-graph.ts`의 `runTaskGraph`·`executeNode`)(ADR-195 4f A5b-2).
//!
//! **통과를 정하는 코드다.** 옛 코드의 순서와 분기를 그대로 따르고, 아래 규칙으로 통과 쪽이 열리는 자리를 닫는다.
//! - 콜백이 응답하지 않거나(`None`) 알아볼 수 없는 모양이면 통과가 아니라 `Fail::Hook`이다. 새로 삼키는 자리를 만들지 않는다.
//!   삼키는 자리는 옛 코드와 같은 셋뿐이다: 테스트 보고서 비우기 실패, OOM 되살리기의 `stats`·`restart` 실패, 근거(`evidenceOrNone`)를 만들다 난 실패(근거 없이 통과로 남는다 — 판정은 이미 났다).
//! - 한 노드가 던진 실패(`run`이 거절한 것)는 옛 `executeNode`처럼 `failed`로 돌려주고 재시도한다. 콜백의 `{ ok: false, error: { message } }`가 그 거절이다.
//!   `{ fatal: true }`(TS가 오류를 저장했다)는 그 노드의 실패가 아니라 이 검사 전체의 중단이다. 옛 코드에서 `run` 밖으로 던지던 것(취소, `TaskGraphError`, 이벤트 처리기의 오류)이다.
//! - 동시 요청 확인의 출처 제한은 TS가 `new URL(path, endpoint.url)`로 푼 `{ href, sameOrigin }`을 그대로 쓴다. 요청은 그 `href`로 보낸다 —
//!   확인하는 해석과 요청하는 해석이 같은 값에서 나온다(Rust에서 URL을 다시 풀지 않는다).
//! - 재지 못한 부하 확인(러너 없음·판정 못 함·예외)은 `ok: false`다. 근거는 통과한 확인에만 붙인다.
//!
//! 작업 그래프(`run_graph`)는 `runTaskGraph`와 같은 동작이다: 동시 실행 상한, 의존 실패 건너뛰기, `maxAttempts` 재시도, 결과는 노드 순서, 맨 앞 `throwIfAborted`.
//! 시작 순서는 한 태스크 안에서 노드를 차례로 폴링해 지킨다(`tokio::spawn`은 시작 순서를 보장하지 않는다). `executeNode`는 `run`의 예외를 — 취소로 난 것까지 — 잡아 `failed`로 돌려주고,
//! 바깥 반복의 맨 앞 `throwIfAborted`에서야 던진다. 마지막 작업이 끝나 `results.size === nodes.length`면 반복을 나와 던지지 않는다.
//!
//! 문자열: TS가 `encodeLoneSurrogates`한 글자를 그대로 주고받는다. 옛 코드가 napi 경계(`encodeNative`)를 거치던 판정(`judgeLoad`·`loadRequestFor`·`testEvidence`·`finishEvidence`·
//! `describeConcurrencyExpect`)에 넣는 값만 `well_formed_from_encoded`로 같은 꼴(짝 없는 서로게이트는 U+FFFD)로 만들고, 그 출력은 예약 글자를 `encode_reserved`로 다시 인코딩한다.
//!
//! 의도한 차이(옛 코드와 다르게 한 것):
//! - 응답 JSON이 `js_json`이 읽는 깊이(2000)를 넘으면 `then` 값을 읽지 못한 것으로 보고 실패다(JS는 읽는다). 통과로 열리지 않는다.
//! - 동시 요청의 상태 코드가 수가 아니면 `Fail::Hook`이다(옛 코드는 형 변환으로 견줬다). 진짜 `fetch`의 응답은 늘 수다.
//! - 작업의 시간 상한(`TEST_TIMEOUT_MS`)은 `exec` 콜백이 연 신호로 둔다. 시작 시각은 콜백을 부르는 때다(옛 코드는 부르기 직전의 같은 순간).
//! - 서로 다른 노드가 동시에 도는 동안 각자 부르는 콜백이 끼어드는 **순서**는 TS와 같지 않을 수 있다(시작 순서만 같다). 콜백 하나가 스레드를 건너오는 시간이 있기 때문이다.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Instant;

use bstudio_guard::check_evidence;
use bstudio_guard::checkpoint_git as cg;
use bstudio_guard::gate_helpers;
use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::load_check;
use bstudio_guard::review_input::template;
use bstudio_guard::task_graph;
use bstudio_guard::usage;

use crate::verify_io::{call, call_done, req, s, string_list, strings, Answer, Fail, Hook, Res};

/// 동시에 돌리는 확인 수(`CHECK_CONCURRENCY`)
const CHECK_CONCURRENCY: usize = 2;
/// 테스트 실패 출력에서 남기는 줄 수(`OUTPUT_TAIL_LINES`)
const OUTPUT_TAIL_LINES: usize = 30;

/// 선언한 검사를 돌린 결과. `load_failure`는 부하 확인을 b-studio 쪽 문제로 재지 못한 사유(`loadPlatformFailure`)다
pub(crate) struct Declared {
    pub checks: Vec<JsValue>,
    pub load_failure: Option<String>,
}

fn obj(pairs: Vec<(&str, Option<JsValue>)>) -> JsValue {
    js_json::object(pairs)
}

/// 이 크레이트가 만든 글자(옛 코드에서 napi가 돌려주던 글자)를 TS 경계의 꼴로 만든다
fn enc(plain: &str) -> String {
    cg::encode_reserved(plain)
}

/// TS가 보낸 글자를 옛 napi 경계가 받던 꼴(짝 없는 서로게이트는 U+FFFD)로 만든다
fn lossy_str(encoded: &str) -> String {
    js::well_formed_from_encoded(encoded)
}

fn lossy(value: &JsValue) -> JsValue {
    crate::gate_check::lossy(value)
}

/// 값 안의 모든 글자를 경계의 꼴로 만든다(키는 바꾸지 않는다. TS의 `encodeStrings`와 같다)
fn enc_value(value: &JsValue) -> JsValue {
    match value {
        JsValue::Str(text) => JsValue::Str(enc(text)),
        JsValue::Arr(items) => JsValue::Arr(items.iter().map(enc_value).collect()),
        JsValue::Obj(object) => {
            let mut out = js_json::JsObject::new();
            for (key, item) in object.entries() {
                out.set(key, enc_value(item));
            }
            JsValue::Obj(out)
        }
        other => other.clone(),
    }
}

async fn stage(hook: &Hook, name: &str) -> Res<()> {
    let event = obj(vec![("type", Some(s("stage"))), ("stage", Some(s(name))), ("source", Some(s("platform")))]);
    call_done(hook, req("emit", vec![("event", event)])).await.map(|_| ())
}

/// 취소됐으면 TS가 던진다(`signal?.throwIfAborted()`)
async fn throw_if_aborted(hook: &Hook) -> Res<()> {
    call_done(hook, req("throwIfAborted", vec![])).await.map(|_| ())
}

/// `new TaskGraphError(message)`를 TS가 던지게 한다. 던진 오류는 TS가 저장해 두고 `Fail::Hook`으로 되돌아온다
async fn graph_error<T>(hook: &Hook, message: String) -> Res<T> {
    call(hook, req("declaredThrowGraphError", vec![("message", s(message))])).await?;
    Err(Fail::Hook)
}

fn text_field(value: &JsValue, key: &str) -> Res<String> {
    value.prop(key).and_then(JsValue::as_str).map(str::to_owned).ok_or(Fail::Hook)
}

// ── 계획 ─────────────────────────────────────────────────────────────────

struct TestCase {
    name: String,
    service: String,
    command: Vec<String>,
}

/// TS가 읽어 준 선언과 자동 페이지. 화면 확인 본체(`#checkPage`·`#autoPages`)는 TS가 든다
struct Plan {
    pages: Vec<JsValue>,
    tests: Vec<TestCase>,
    test_values: Vec<JsValue>,
    concurrency: Vec<JsValue>,
    loads: Vec<JsValue>,
    auto_names: Vec<String>,
    auto_skipped: Vec<JsValue>,
}

fn list_of<'a>(value: &'a JsValue, key: &str) -> Res<&'a [JsValue]> {
    match value.prop(key) {
        Some(JsValue::Arr(items)) => Ok(items),
        _ => Err(Fail::Hook),
    }
}

fn read_plan(begin: &JsValue) -> Res<Plan> {
    let tests_raw = list_of(begin, "tests")?;
    let mut tests = Vec::new();
    for test in tests_raw {
        tests.push(TestCase { name: template(test.prop("name")), service: template(test.prop("service")), command: string_list(test.prop("command"))? });
    }
    let auto_names = list_of(begin, "autoNames")?.iter().map(|name| name.as_str().map(str::to_owned).ok_or(Fail::Hook)).collect::<Res<Vec<_>>>()?;
    let auto_skipped = list_of(begin, "autoSkipped")?.to_vec();
    for check in &auto_skipped {
        if !is_check(check) {
            return Err(Fail::Hook);
        }
    }
    Ok(Plan {
        pages: list_of(begin, "pages")?.to_vec(),
        tests,
        test_values: tests_raw.to_vec(),
        concurrency: list_of(begin, "concurrency")?.to_vec(),
        loads: list_of(begin, "loads")?.to_vec(),
        auto_names,
        auto_skipped,
    })
}

/// 검사 하나의 모양(`stage`·`name` 글자, `ok` 불리언)
fn is_check(check: &JsValue) -> bool {
    matches!(check, JsValue::Obj(_)) && matches!(check.prop("stage"), Some(JsValue::Str(_))) && matches!(check.prop("name"), Some(JsValue::Str(_))) && matches!(check.prop("ok"), Some(JsValue::Bool(_)))
}

// ── 작업 그래프 ──────────────────────────────────────────────────────────

#[derive(Clone)]
enum Kind {
    /// 화면 확인. `auto`면 자동 페이지의 `index`번째, 아니면 선언한 pageChecks의 `index`번째
    Page { auto: bool, index: usize },
    Test(usize),
    Concurrency(usize),
}

#[derive(Clone)]
struct NodeSpec {
    id: String,
    /// 결과 check의 이름(작업 id와 달리 `page:`·`test:` 접두사가 없다)
    name: String,
    stage: &'static str,
    kind: Kind,
    /// `Math.max(1, Math.floor(maxAttempts ?? 1))`. NaN이면 NaN
    max_attempts: f64,
}

#[derive(Clone)]
struct NodeResult {
    /// `succeeded` · `failed` · `skipped`
    status: &'static str,
    attempts: f64,
    value: Option<Vec<String>>,
    error: Option<String>,
}

struct Ctx {
    hook: Hook,
    plan: Plan,
    /// 동시 요청 확인 이름 → 통과했을 때의 요약. 옛 `#concurrencyNotes`(이름으로 모으므로 같은 이름이면 마지막 것)
    notes: Mutex<HashMap<String, String>>,
}

type NodeFuture = Pin<Box<dyn Future<Output = Res<NodeResult>> + Send>>;

/// 한 번의 시도. `Ok(Err(message))`가 `run`이 던진 오류다(`executeNode`가 잡아 message로 바꾼다)
async fn run_once(ctx: &Arc<Ctx>, node: &NodeSpec) -> Res<Result<Option<Vec<String>>, String>> {
    match &node.kind {
        Kind::Page { auto, index } => run_page(ctx, node, *auto, *index).await,
        Kind::Test(index) => run_test(ctx, *index).await,
        Kind::Concurrency(index) => run_concurrency(ctx, node, *index).await,
    }
}

/// 옛 `executeNode`. `maxAttempts`까지 시도한다. 맨 앞 `throwIfAborted`는 `try` 밖이라 취소는 던진다
async fn execute_node(ctx: Arc<Ctx>, node: NodeSpec) -> Res<NodeResult> {
    let mut attempt = 1.0_f64;
    while attempt <= node.max_attempts {
        throw_if_aborted(&ctx.hook).await?;
        match run_once(&ctx, &node).await? {
            Ok(value) => return Ok(NodeResult { status: "succeeded", attempts: attempt, value, error: None }),
            Err(message) => {
                let retrying = attempt < node.max_attempts;
                if !retrying {
                    return Ok(NodeResult { status: "failed", attempts: attempt, value: None, error: Some(message) });
                }
            }
        }
        attempt += 1.0;
    }
    graph_error(&ctx.hook, format!("{}: 실행 결과가 없습니다", node.id)).await
}

/// 먼저 끝난 노드 하나. 노드를 시작한 순서대로 폴링하므로 같이 끝난 것은 앞선 노드가 먼저다
async fn race(running: &mut [(usize, NodeFuture)]) -> (usize, Res<NodeResult>) {
    std::future::poll_fn(|cx| {
        for (position, (_, future)) in running.iter_mut().enumerate() {
            if let Poll::Ready(result) = future.as_mut().poll(cx) {
                return Poll::Ready((position, result));
            }
        }
        Poll::Pending
    })
    .await
}

/// 옛 `runTaskGraph`. `depends_on`은 노드 인덱스가 아니라 id다(게이트는 쓰지 않지만 같은 동작을 지킨다)
async fn run_graph(ctx: &Arc<Ctx>, nodes: &[NodeSpec], depends_on: &[Vec<String>], limit: usize) -> Res<Vec<NodeResult>> {
    let hook = &ctx.hook;
    let graph: Vec<task_graph::Node> = nodes.iter().zip(depends_on).map(|(node, deps)| task_graph::Node { id: node.id.clone(), depends_on: deps.clone() }).collect();
    if let Some(message) = task_graph::validate(&graph) {
        return graph_error(hook, message).await;
    }
    let position: HashMap<&str, usize> = nodes.iter().enumerate().map(|(index, node)| (node.id.as_str(), index)).collect();
    let limit = limit.max(1);
    let mut results: Vec<Option<NodeResult>> = vec![None; nodes.len()];
    let mut done = 0;
    let mut running: Vec<(usize, NodeFuture)> = Vec::new();

    while done < nodes.len() {
        throw_if_aborted(hook).await?;
        // 실패한 의존성을 가진 작업은 실행하지 않고 명시적으로 남긴다
        for index in 0..nodes.len() {
            if results[index].is_some() || running.iter().any(|(at, _)| *at == index) {
                continue;
            }
            let blocked = depends_on[index].iter().any(|id| matches!(position.get(id.as_str()).and_then(|at| results[*at].as_ref()).map(|result| result.status), Some("failed") | Some("skipped")));
            if blocked {
                results[index] = Some(NodeResult { status: "skipped", attempts: 0.0, value: None, error: Some("의존 작업이 실패해 건너뛰었습니다".to_owned()) });
                done += 1;
            }
        }
        for index in 0..nodes.len() {
            if running.len() >= limit || results[index].is_some() || running.iter().any(|(at, _)| *at == index) {
                continue;
            }
            let ready = depends_on[index].iter().all(|id| matches!(position.get(id.as_str()).and_then(|at| results[*at].as_ref()).map(|result| result.status), Some("succeeded")));
            if !ready {
                continue;
            }
            running.push((index, Box::pin(execute_node(ctx.clone(), nodes[index].clone()))));
        }
        if running.is_empty() {
            if done == nodes.len() {
                break;
            }
            return graph_error(hook, "실행 가능한 작업이 없습니다".to_owned()).await;
        }
        let (at, result) = race(&mut running).await;
        let (index, _) = running.remove(at);
        results[index] = Some(result?);
        done += 1;
    }
    Ok(results.into_iter().map(|result| result.expect("모든 노드가 끝났다")).collect())
}

// ── 화면 확인 ────────────────────────────────────────────────────────────

async fn run_page(ctx: &Arc<Ctx>, node: &NodeSpec, auto: bool, index: usize) -> Res<Result<Option<Vec<String>>, String>> {
    let request = req("declaredCheckPage", vec![("auto", JsValue::Bool(auto)), ("index", JsValue::Num(index as f64)), ("name", s(node.name.clone()))]);
    match call(&ctx.hook, request).await? {
        Answer::Done(value) => Ok(Ok(Some(string_list(value.prop("evidence"))?))),
        Answer::Failed { message, .. } => Ok(Err(message)),
    }
}

// ── 테스트 ───────────────────────────────────────────────────────────────

/// 옛 `evidenceOrNone(() => finishEvidence(lines, redact))`. 줄마다 가리고(콜백), 가린 뒤에 자른다. 만드는 중 실패하면 근거 없이(빈 목록) 돌려준다 —
/// 판정은 이미 났고 근거는 사람이 보는 표시일 뿐이다. 콜백이 `fatal`이면 그것은 삼키지 않는다
async fn evidence_or_none(hook: &Hook, lines: Vec<String>) -> Res<Vec<String>> {
    let mut out = Vec::new();
    for line in check_evidence::cap_evidence_lines(&lines) {
        let answer = call(hook, req("declaredRedact", vec![("text", s(enc(&line))), ("rethrow", JsValue::Bool(false))])).await?;
        let Answer::Done(value) = answer else { return Ok(Vec::new()) };
        let Some(JsValue::Str(redacted)) = value.prop("text") else { return Ok(Vec::new()) };
        out.push(enc(&check_evidence::clamp_evidence_line(lossy_str(redacted))));
    }
    Ok(out)
}

/// `#reviveIfOomKilled`. 메모리 한도로 컨테이너째 죽었으면 서비스를 되살리고 그 설명을 돌려준다. `stats`·`restart`의 실패는 삼킨다(옛 그대로)
async fn revive_if_oom_killed(hook: &Hook, service: &str) -> Res<Option<String>> {
    let usage_list = match call(hook, req("declaredStats", vec![])).await? {
        Answer::Done(value) => match value.prop("usage") {
            Some(JsValue::Arr(items)) => items.clone(),
            _ => return Err(Fail::Hook),
        },
        Answer::Failed { .. } => Vec::new(),
    };
    let Some(found) = usage_list.iter().find(|candidate| matches!(candidate.prop("service"), Some(JsValue::Str(name)) if name == service)) else { return Ok(None) };
    if !found.prop("oomKilled").is_some_and(JsValue::truthy) {
        return Ok(None);
    }
    // 되살리기 자체가 실패해도 원래 실패를 가리지 않도록 삼킨다. 다음 시도가 어차피 그 실패를 다시 드러낸다
    call(hook, req("declaredRestart", vec![("service", s(service))])).await?;
    let limit = match found.prop("memoryLimitBytes") {
        Some(value) if value.truthy() => match value {
            JsValue::Num(bytes) => format!(" ({})", usage::format_bytes(Some(*bytes))),
            _ => return Err(Fail::Hook),
        },
        _ => String::new(),
    };
    Ok(Some(format!("메모리 한도{limit}를 넘어")))
}

async fn run_test(ctx: &Arc<Ctx>, index: usize) -> Res<Result<Option<Vec<String>>, String>> {
    let hook = &ctx.hook;
    let test = &ctx.plan.tests[index];
    let started_at = Instant::now();
    let request = req("declaredExec", vec![("service", s(test.service.clone())), ("command", strings(&test.command))]);
    let result = match call(hook, request).await? {
        Answer::Done(value) => value,
        Answer::Failed { message, .. } => return Ok(Err(message)),
    };
    if !matches!(result.prop("exitCode"), Some(JsValue::Num(code)) if *code == 0.0) {
        let revived = revive_if_oom_killed(hook, &test.service).await?;
        let joined = format!("{}\n{}", template(result.prop("stdout")), template(result.prop("stderr")));
        let lines: Vec<&str> = js::trim(&joined).split('\n').collect();
        let output = lines[lines.len().saturating_sub(OUTPUT_TAIL_LINES)..].join("\n");
        let environment = revived.map_or_else(String::new, |why| {
            format!("\n환경 문제: {} 컨테이너가 {why} 종료됐습니다. 코드 문제가 아닐 수 있습니다 — 서비스를 다시 띄웠습니다(다음 시도에서 이어집니다)", test.service)
        });
        return Ok(Err(format!("종료 코드 {}{environment}\n{output}", template(result.prop("exitCode")))));
    }
    let elapsed_ms = started_at.elapsed().as_secs_f64() * 1000.0;
    let command: Vec<String> = test.command.iter().map(|part| lossy_str(part)).collect();
    let lines = check_evidence::test_evidence(&lossy_str(&test.service), &command, elapsed_ms);
    Ok(Ok(Some(evidence_or_none(hook, lines).await?)))
}

// ── 동시 요청 ────────────────────────────────────────────────────────────

enum Stop {
    /// 콜백의 실패: 이 검사 전체를 멈춘다
    Fail(Fail),
    /// `Promise.all`이 거절한 오류의 글
    Message(String),
}

type RequestFuture<'a> = Pin<Box<dyn Future<Output = Result<(f64, String), Stop>> + Send + 'a>>;

/// `Promise.all`: 모두 먼저 시작하고(같은 폴링 안에서 앞에서부터), 먼저 거절된 것을 바로 올린다. 나머지는 떨어뜨린다
async fn all_requests(mut futures: Vec<RequestFuture<'_>>) -> Result<Vec<(f64, String)>, Stop> {
    let mut results: Vec<Option<(f64, String)>> = vec![None; futures.len()];
    let mut pending = futures.len();
    std::future::poll_fn(|cx| {
        // 아직 끝나지 않은 것을 모두 폴링한 뒤(옛 `Promise.all`은 요청을 모두 먼저 보낸다) 먼저 거절된 것을 올린다
        let mut stopped = None;
        for (index, future) in futures.iter_mut().enumerate() {
            if results[index].is_some() {
                continue;
            }
            match future.as_mut().poll(cx) {
                Poll::Ready(Ok(response)) => {
                    results[index] = Some(response);
                    pending -= 1;
                }
                Poll::Ready(Err(stop)) => {
                    stopped.get_or_insert(stop);
                    results[index] = Some((f64::NAN, String::new()));
                    pending -= 1;
                }
                Poll::Pending => {}
            }
        }
        match stopped {
            Some(stop) => Poll::Ready(Err(stop)),
            None if pending == 0 => Poll::Ready(Ok(())),
            None => Poll::Pending,
        }
    })
    .await?;
    Ok(results.into_iter().map(|response| response.expect("모두 끝났다")).collect())
}

/// 콜백 하나를 부르되 실패 응답은 `Stop::Message`로 바꾼다
async fn request_op(hook: &Hook, request: JsValue) -> Result<JsValue, Stop> {
    match call(hook, request).await {
        Ok(Answer::Done(value)) => Ok(value),
        Ok(Answer::Failed { message, .. }) => Err(Stop::Message(message)),
        Err(fail) => Err(Stop::Fail(fail)),
    }
}

/// 요청 하나. 돌려주는 값은 (상태 코드, 본문). 상태 코드가 수가 아니면 알아볼 수 없는 응답이다
fn response_of(value: &JsValue) -> Result<(f64, String), Stop> {
    match value.prop("status") {
        Some(JsValue::Num(status)) => Ok((*status, template(value.prop("text")))),
        _ => Err(Stop::Fail(Fail::Hook)),
    }
}

fn stopped<T>(stop: Stop) -> Res<Result<T, String>> {
    match stop {
        Stop::Fail(fail) => Err(fail),
        Stop::Message(message) => Ok(Err(message)),
    }
}

/// 가린 글을 돌려준다. `wire`는 이미 경계의 꼴(TS가 보낸 글자를 이은 것이거나 `enc`한 것)이다. 가리는 함수가 던지면 그 오류의 글이다(옛 `new Error(sandbox.redact(...))`가 던지던 것)
async fn redact_soft(hook: &Hook, wire: &str) -> Res<Result<String, (String, bool)>> {
    match call(hook, req("declaredRedact", vec![("text", s(wire)), ("rethrow", JsValue::Bool(false))])).await? {
        Answer::Done(value) => match value.prop("text") {
            Some(JsValue::Str(text)) => Ok(Ok(text.clone())),
            _ => Err(Fail::Hook),
        },
        Answer::Failed { message, platform, .. } => Ok(Err((message, platform))),
    }
}

/// 상태 코드를 JS처럼 글자로(`${status}`)
fn num(value: f64) -> String {
    js::number_to_string(value)
}

async fn run_concurrency(ctx: &Arc<Ctx>, node: &NodeSpec, index: usize) -> Res<Result<Option<Vec<String>>, String>> {
    let hook = &ctx.hook;
    let check = &ctx.plan.concurrency[index];
    let service = text_field(check, "service")?;
    let url = match request_op(hook, req("declaredEndpoint", vec![("service", s(service))])).await {
        Ok(value) => text_field(&value, "url")?,
        Err(stop) => return stopped(stop),
    };
    let path = template(check.prop("path"));
    // 출처 제한. 같은 해석에서 나온 href를 그대로 요청한다
    let resolve = |path: String| req("declaredResolveUrl", vec![("base", s(url.clone())), ("path", s(path))]);
    let (href, same) = match request_op(hook, resolve(path)).await {
        Ok(value) => (text_field(&value, "href")?, matches!(value.prop("sameOrigin"), Some(JsValue::Bool(true)))),
        Err(stop) => return stopped(stop),
    };
    if !same {
        return Ok(Err("path must stay on the service host".to_owned()));
    }

    let method = template(check.prop("method"));
    let concurrent = match check.prop("concurrent") {
        Some(JsValue::Num(n)) if *n >= 0.0 && n.fract() == 0.0 => *n as usize,
        _ => return Err(Fail::Hook),
    };
    let headers = check.prop("headers").filter(|value| value.truthy()).cloned();
    let body = if method != "GET" { check.prop("body").cloned() } else { None };
    let futures: Vec<RequestFuture<'_>> = (0..concurrent)
        .map(|_| {
            let mut fields = vec![("href", s(href.clone())), ("method", s(method.clone()))];
            if let Some(headers) = &headers {
                fields.push(("headers", headers.clone()));
            }
            if let Some(body) = &body {
                fields.push(("body", body.clone()));
            }
            let request = req("declaredRequest", fields);
            Box::pin(async move { response_of(&request_op(hook, request).await?) }) as RequestFuture<'_>
        })
        .collect();
    let responses = match all_requests(futures).await {
        Ok(responses) => responses,
        Err(stop) => return stopped(stop),
    };

    let success_count = responses.iter().filter(|(status, _)| *status >= 200.0 && *status < 300.0).count() as f64;
    let mut counts: Vec<(f64, usize)> = Vec::new();
    for (status, _) in &responses {
        match counts.iter_mut().find(|(seen, _)| js::same_value_zero(*seen, *status)) {
            Some(entry) => entry.1 += 1,
            None => counts.push((*status, 1)),
        }
    }
    counts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let status_detail = counts.iter().map(|(status, count)| format!("{}:{count}", num(*status))).collect::<Vec<_>>().join(", ");

    let expect = check.prop("expect").ok_or(Fail::Hook)?;
    let count_expect = expect.prop("successCount").filter(|value| value.truthy());
    let expect_summary = obj(vec![
        ("successCount", count_expect.map(|c| obj(vec![("exactly", c.prop("exactly").cloned()), ("atMost", c.prop("atMost").cloned())]))),
        ("allStatusIn", expect.prop("allStatusIn").cloned()),
    ]);
    let described = gate_helpers::describe_concurrency_expect(&lossy(&expect_summary)).map_err(|_| Fail::Hook)?;
    let total = template(check.prop("concurrent"));
    let mut parts = vec![format!("성공 {}/{total} (기대: {described})", num(success_count)), format!("상태 {status_detail}")];
    let mut problems: Vec<String> = Vec::new();
    if let Some(exactly) = count_expect.and_then(|c| c.prop("exactly")) {
        if !JsValue::Num(success_count).strict_equals(exactly) {
            problems.push(format!("성공 {}/{total} (기대: 정확히 {})", num(success_count), exactly.to_js_string()));
        }
    }
    if let Some(at_most) = count_expect.and_then(|c| c.prop("atMost")) {
        if success_count > at_most.to_number() {
            problems.push(format!("성공 {}/{total} (기대: 최대 {})", num(success_count), at_most.to_js_string()));
        }
    }
    if let Some(all) = expect.prop("allStatusIn").filter(|value| value.truthy()) {
        let JsValue::Arr(allowed) = all else { return Err(Fail::Hook) };
        let includes = |status: f64| allowed.iter().any(|item| matches!(item, JsValue::Num(n) if js::same_value_zero(*n, status)));
        if !responses.iter().all(|(status, _)| includes(*status)) {
            let mut outside: Vec<f64> = Vec::new();
            for (status, _) in &responses {
                if !includes(*status) && !outside.iter().any(|seen| js::same_value_zero(*seen, *status)) {
                    outside.push(*status);
                }
            }
            let outside = outside.iter().map(|status| num(*status)).collect::<Vec<_>>().join(", ");
            let expected = allowed.iter().map(|item| if matches!(item, JsValue::Null) { String::new() } else { item.to_js_string() }).collect::<Vec<_>>().join(", ");
            problems.push(format!("기대 밖 상태 코드: {outside} (기대: {expected})"));
        }
    }
    if let Some(then) = expect.prop("then").filter(|value| value.truthy()) {
        let then_path = template(then.prop("path"));
        let (then_href, then_same) = match request_op(hook, resolve(then_path)).await {
            Ok(value) => (text_field(&value, "href")?, matches!(value.prop("sameOrigin"), Some(JsValue::Bool(true)))),
            Err(stop) => return stopped(stop),
        };
        if !then_same {
            return Ok(Err("path must stay on the service host".to_owned()));
        }
        let response = match request_op(hook, req("declaredRequest", vec![("href", s(then_href)), ("method", s("GET"))])).await.and_then(|value| response_of(&value)) {
            Ok(response) => response,
            Err(stop) => return stopped(stop),
        };
        let json_path = template(then.prop("jsonPath"));
        let expected = then.prop("equals").cloned().unwrap_or(JsValue::Null);
        let Ok(actual) = gate_helpers::read_json_path(&response.1, &json_path) else {
            // JSON이 너무 깊어 읽지 못했다. 읽지 못한 값은 통과로 세지 않는다
            return Ok(Err(format!("{json_path} 값을 읽지 못했습니다: 응답 JSON이 너무 깊습니다")));
        };
        parts.push(format!("{json_path} = {}", actual.display()));
        if !actual.strict_equals(&expected) {
            problems.push(format!("{json_path} 값이 {} (기대: {})", actual.display(), gate_helpers::json_text(&expected)));
        }
    }

    // 원인을 추정하지 않고 숫자만 남긴다
    let note = parts.join(" · ");
    if !problems.is_empty() {
        let text = std::iter::once(note).chain(problems).collect::<Vec<_>>().join("\n");
        return match redact_soft(hook, &text).await? {
            Ok(redacted) => Ok(Err(redacted)),
            Err((message, _)) => Ok(Err(message)),
        };
    }
    ctx.notes.lock().expect("notes").insert(node.name.clone(), note);
    Ok(Ok(None))
}

// ── 테스트 보고서 비우기 ─────────────────────────────────────────────────

/// `#clearTestReports`. 서비스마다 한 번(처음 나온 순서), 모두 먼저 시작한다. 실패는 삼킨다 — 테스트 판정은 종료 코드로 하고 보고서는 근거로만 쓴다
async fn clear_test_reports(hook: &Hook, tests: &[TestCase]) -> Res<()> {
    let mut services: Vec<&str> = Vec::new();
    for test in tests {
        if !services.contains(&test.service.as_str()) {
            services.push(&test.service);
        }
    }
    type ClearFuture<'a> = Pin<Box<dyn Future<Output = Res<()>> + Send + 'a>>;
    let mut futures: Vec<ClearFuture<'_>> = services
        .iter()
        .map(|service| {
            let request = req("declaredClearReports", vec![("service", s(*service))]);
            Box::pin(async move { call(hook, request).await.map(|_| ()) }) as ClearFuture<'_>
        })
        .collect();
    let mut finished = vec![false; futures.len()];
    std::future::poll_fn(|cx| {
        let mut failed = None;
        for (index, future) in futures.iter_mut().enumerate() {
            if finished[index] {
                continue;
            }
            match future.as_mut().poll(cx) {
                Poll::Ready(Ok(())) => finished[index] = true,
                Poll::Ready(Err(fail)) => {
                    failed.get_or_insert(fail);
                    finished[index] = true;
                }
                Poll::Pending => {}
            }
        }
        match failed {
            Some(fail) => Poll::Ready(Err(fail)),
            None if finished.iter().all(|done| *done) => Poll::Ready(Ok(())),
            None => Poll::Pending,
        }
    })
    .await
}

// ── 부하 확인 ────────────────────────────────────────────────────────────

const LOAD_UNSUPPORTED: &str = "이 샌드박스 제공자는 부하 확인(workflow.loadChecks)을 지원하지 않습니다. 로컬 Docker 제공자에서만 잴 수 있습니다";

/// `try` 안에서 난 실패(옛 `catch (error)`). `platform`은 `error instanceof SandboxError && error.platform`
struct Caught {
    message: String,
    platform: bool,
}

/// 부하 하나를 재고 판정한다. 성공이면 check, `try` 안에서 실패했으면 `Caught`
async fn judge_one(hook: &Hook, check: &JsValue, entry: &[(&str, JsValue)]) -> Res<Result<JsValue, Caught>> {
    let plain = lossy(check);
    let request = match load_check::load_request_for(&plain) {
        Ok(request) => request,
        Err(message) => return Ok(Err(Caught { message: enc(&message), platform: false })),
    };
    let measured = match call(hook, req("declaredRunLoad", vec![("request", enc_value(&request))])).await? {
        Answer::Done(value) => value.prop("result").cloned().ok_or(Fail::Hook)?,
        Answer::Failed { message, platform, .. } => return Ok(Err(Caught { message, platform })),
    };
    let judged = match load_check::judge_load(&plain, &lossy(&measured)) {
        Ok(judged) => judged,
        Err(message) => return Ok(Err(Caught { message: enc(&message), platform: false })),
    };
    let ok = judged.problems.is_empty();
    let evidence = if ok { evidence_or_none(hook, judged.evidence.clone()).await? } else { Vec::new() };
    let detail_text = std::iter::once(judged.note.clone()).chain(judged.problems.iter().cloned()).collect::<Vec<_>>().join("\n");
    let detail = match redact_soft(hook, &enc(&detail_text)).await? {
        Ok(detail) => detail,
        Err((message, platform)) => return Ok(Err(Caught { message, platform })),
    };
    let mut fields: Vec<(&str, Option<JsValue>)> = entry.iter().map(|(key, value)| (*key, Some(value.clone()))).collect();
    fields.push(("ok", Some(JsValue::Bool(ok))));
    fields.push(("detail", Some(s(detail))));
    if !evidence.is_empty() {
        fields.push(("evidence", Some(strings(&evidence))));
    }
    Ok(Ok(obj(fields)))
}

/// `#runLoadChecks`. 하나씩 차례로 잰다. 재지 못한 것은 통과로 세지 않는다
async fn run_load_checks(hook: &Hook, loads: &[JsValue]) -> Res<(Vec<JsValue>, Option<String>)> {
    if loads.is_empty() {
        return Ok((Vec::new(), None));
    }
    stage(hook, "load_check").await?;
    let mut checks = Vec::new();
    let mut platform_failure: Option<String> = None;
    for check in loads {
        throw_if_aborted(hook).await?;
        let name = template(check.prop("name"));
        let entry = [("stage", s("load_check")), ("name", s(name.clone())), ("attempts", JsValue::Num(1.0))];
        let supported = matches!(call_done(hook, req("declaredLoadSupported", vec![])).await?.prop("supported"), Some(JsValue::Bool(true)));
        if !supported {
            platform_failure.get_or_insert_with(|| format!("부하 확인 '{name}': {LOAD_UNSUPPORTED}"));
            checks.push(obj(vec![("stage", Some(s("load_check"))), ("name", Some(s(name))), ("attempts", Some(JsValue::Num(1.0))), ("ok", Some(JsValue::Bool(false))), ("detail", Some(s(LOAD_UNSUPPORTED)))]));
            continue;
        }
        match judge_one(hook, check, &entry).await? {
            Ok(done) => checks.push(done),
            Err(caught) => {
                throw_if_aborted(hook).await?;
                // 가리는 함수가 여기서 던지면 그 오류가 게이트 밖으로 올라간다(옛 코드와 같다)
                let answer = call_done(hook, req("declaredRedact", vec![("text", s(caught.message.clone())), ("rethrow", JsValue::Bool(true))])).await?;
                let Some(JsValue::Str(detail)) = answer.prop("text") else { return Err(Fail::Hook) };
                if caught.platform {
                    platform_failure.get_or_insert_with(|| format!("부하 확인 '{name}': {detail}"));
                }
                checks.push(obj(vec![("stage", Some(s("load_check"))), ("name", Some(s(name))), ("attempts", Some(JsValue::Num(1.0))), ("ok", Some(JsValue::Bool(false))), ("detail", Some(s(detail.clone())))]));
            }
        }
    }
    Ok((checks, platform_failure))
}

// ── 입구 ─────────────────────────────────────────────────────────────────

/// `Math.max(1, Math.floor(maxAttempts ?? 1))`
fn max_attempts_of(value: Option<&JsValue>) -> f64 {
    let raw = match value {
        None | Some(JsValue::Null) => 1.0,
        Some(other) => other.to_number(),
    };
    let floored = raw.floor();
    if floored.is_nan() { floored } else { floored.max(1.0) }
}

/// 옛 `#runDeclaredChecks()`
pub(crate) async fn run(hook: &Hook) -> Res<Declared> {
    let begin = call_done(hook, req("declaredBegin", vec![])).await?;
    let plan = read_plan(&begin)?;
    if plan.pages.is_empty() && plan.tests.is_empty() && plan.concurrency.is_empty() && plan.loads.is_empty() && plan.auto_names.is_empty() && plan.auto_skipped.is_empty() {
        return Ok(Declared { checks: Vec::new(), load_failure: None });
    }

    let mut nodes: Vec<NodeSpec> = Vec::new();
    // 같은 화면을 다른 기대값·다른 단계로 두 번 확인하면 이름이 같아진다. 이름은 작업 id이자 스크린샷·경고·비교 결과를 모으는 열쇠라
    // 겹치면 게이트가 던지거나 두 확인의 결과가 섞인다(트러블슈팅 120). 둘째부터 번호를 붙여 구별한다
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut unique = |name: String| -> String {
        let count = seen.entry(name.clone()).or_insert(0);
        *count += 1;
        if *count == 1 { name } else { format!("{name} #{count}") }
    };
    for (index, page) in plan.pages.iter().enumerate() {
        let browser = match page.prop("viewport").filter(|value| value.truthy()) {
            Some(viewport) => format!("browser {}x{}", template(viewport.prop("width")), template(viewport.prop("height"))),
            None => "browser".to_owned(),
        };
        let step_count = page.prop("stepCount").map_or(0.0, JsValue::to_number);
        let steps = if step_count > 0.0 { format!(", 단계 {}개", js::number_to_string(step_count)) } else { String::new() };
        let is_browser = matches!(page.prop("mode"), Some(JsValue::Str(mode)) if mode == "browser");
        let name = unique(format!("{} {}{}", template(page.prop("service")), template(page.prop("path")), if is_browser { format!(" ({browser}{steps})") } else { String::new() }));
        nodes.push(NodeSpec { id: format!("page:{name}"), name, stage: "browser_check", kind: Kind::Page { auto: false, index }, max_attempts: 1.0 });
    }
    for (index, auto_name) in plan.auto_names.iter().enumerate() {
        let name = unique(auto_name.clone());
        nodes.push(NodeSpec { id: format!("page:{name}"), name, stage: "browser_check", kind: Kind::Page { auto: true, index }, max_attempts: 1.0 });
    }
    for (index, test) in plan.tests.iter().enumerate() {
        nodes.push(NodeSpec { id: format!("test:{}", test.name), name: test.name.clone(), stage: "test", kind: Kind::Test(index), max_attempts: max_attempts_of(plan.test_values[index].prop("maxAttempts")) });
    }
    for (index, check) in plan.concurrency.iter().enumerate() {
        let name = template(check.prop("name"));
        nodes.push(NodeSpec { id: format!("concurrency:{name}"), name, stage: "concurrency_check", kind: Kind::Concurrency(index), max_attempts: 1.0 });
    }
    // 건너뛴 자동 페이지만 있는 경우(상한 초과 등)에는 browser_check를 돌았다고 세지 않는다
    if !plan.pages.is_empty() || !plan.auto_names.is_empty() {
        stage(hook, "browser_check").await?;
    }
    if !plan.tests.is_empty() {
        stage(hook, "test").await?;
    }
    if !plan.concurrency.is_empty() {
        stage(hook, "concurrency_check").await?;
    }

    if !plan.tests.is_empty() {
        clear_test_reports(hook, &plan.tests).await?;
    }
    let ctx = Arc::new(Ctx { hook: hook.clone(), plan, notes: Mutex::new(HashMap::new()) });
    let no_dependencies = vec![Vec::new(); nodes.len()];
    let results = run_graph(&ctx, &nodes, &no_dependencies, CHECK_CONCURRENCY).await?;

    // 화면 확인이 이름별로 모은 부산물(단계·비교·로드 시간·막은 요청·참고 문구)
    let names: Vec<String> = nodes.iter().map(|node| node.name.clone()).collect();
    let page_data = call_done(hook, req("declaredPageData", vec![("names", strings(&names))])).await?;
    let items = list_of(&page_data, "items")?;
    if items.len() != nodes.len() {
        return Err(Fail::Hook);
    }
    let notes = ctx.notes.lock().expect("notes").clone();
    let mut checks = Vec::new();
    for ((node, result), data) in nodes.iter().zip(&results).zip(items) {
        let blocked = list_of(data, "blocked")?.len();
        let warnings = list_of(data, "warnings")?;
        // 동시 요청 확인은 통과해도 결과 요약을 남긴다. 실패 사유에 막은 요청 수를 한 줄 덧붙인다. 게이트를 막지 않는 참고 문구도 통과해도 남긴다
        let mut lines: Vec<String> = Vec::new();
        lines.extend(result.error.clone());
        lines.extend(notes.get(&node.name).cloned());
        if blocked > 0 {
            lines.push(format!("다른 출처 요청 {blocked}건을 막았습니다"));
        }
        lines.extend(warnings.iter().map(JsValue::to_js_string));
        let detail = lines.join("\n");
        let ok = result.status == "succeeded";
        // 근거는 통과한 확인에만 붙인다. 실패하면 사유(detail)가 그 자리를 맡는다
        let evidence = if ok { result.value.as_ref().filter(|lines| !lines.is_empty()) } else { None };
        checks.push(obj(vec![
            ("stage", Some(s(node.stage))),
            ("name", Some(s(node.name.clone()))),
            ("ok", Some(JsValue::Bool(ok))),
            ("attempts", Some(JsValue::Num(result.attempts))),
            ("detail", (!detail.is_empty()).then(|| s(detail))),
            ("evidence", evidence.map(|lines| strings(lines))),
            ("steps", data.prop("steps").filter(|value| value.truthy()).cloned()),
            ("compare", data.prop("compare").filter(|value| value.truthy()).cloned()),
            ("metrics", match data.prop("loadMs") {
                Some(JsValue::Num(load_ms)) => Some(obj(vec![("loadMs", Some(JsValue::Num(*load_ms)))])),
                _ => None,
            }),
        ]));
    }
    // 부하 확인은 다른 확인이 모두 끝난 뒤에 하나씩 돌린다. 화면 확인·테스트와 함께 돌리면 서로의 부하가 응답 시간에 섞인다
    let (load_checks, load_failure) = run_load_checks(hook, &ctx.plan.loads).await?;
    // 건너뛴 라우트도 check로 남긴다(ok). 조용히 사라지면 "확인했다"처럼 보인다
    checks.extend(load_checks);
    checks.extend(ctx.plan.auto_skipped.iter().cloned());
    Ok(Declared { checks, load_failure })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    type Reply = Box<dyn Fn(&str, &JsValue) -> Option<String> + Send + Sync>;

    struct Log {
        /// 콜백 요청을 부른 순서(op와 핵심 인자 하나)
        calls: Mutex<Vec<String>>,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
    }

    /// 요청을 `log`에 적고, `reply`가 글을 돌려주면 그것을(응답 지연 `delay_ms` 뒤), 아니면 응답 없음을 돌려주는 콜백. `exec`가 겹쳐 도는 정도를 센다
    fn hook(log: Arc<Log>, delay_ms: u64, reply: Reply) -> Hook {
        let reply = Arc::new(reply);
        Arc::new(move |request: String| {
            let parsed = js_json::parse_native(&request).expect("요청은 JSON");
            let op = parsed.prop("op").and_then(JsValue::as_str).unwrap_or("").to_owned();
            let arg = parsed.prop("command").map(|c| js_json::stringify(c)).or_else(|| parsed.prop("service").map(|v| v.to_js_string())).or_else(|| parsed.prop("name").map(|v| v.to_js_string())).unwrap_or_default();
            log.calls.lock().unwrap().push(format!("{op}:{arg}"));
            let answer = reply(&op, &parsed);
            let log = log.clone();
            let slow = op == "declaredExec";
            Box::pin(async move {
                if slow {
                    let now = log.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    log.max_in_flight.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    log.in_flight.fetch_sub(1, Ordering::SeqCst);
                }
                answer
            })
        })
    }

    fn fresh() -> Arc<Log> {
        Arc::new(Log { calls: Mutex::new(Vec::new()), in_flight: AtomicUsize::new(0), max_in_flight: AtomicUsize::new(0) })
    }

    fn plan(tests: &str, concurrency: &str, loads: &str, skipped: &str) -> String {
        format!(r#"{{"ok":true,"pages":[],"tests":[{tests}],"concurrency":[{concurrency}],"loads":[{loads}],"autoNames":[],"autoSkipped":[{skipped}]}}"#)
    }

    fn test_case(name: &str, max_attempts: Option<u32>) -> String {
        let attempts = max_attempts.map(|n| format!(r#","maxAttempts":{n}"#)).unwrap_or_default();
        format!(r#"{{"name":"{name}","service":"api","command":["run","{name}"]{attempts}}}"#)
    }

    /// 기본 응답: 계획은 `plan`, 테스트는 통과, 나머지는 성공
    fn basic(plan: String) -> Reply {
        Box::new(move |op, _| {
            Some(match op {
                "declaredBegin" => plan.clone(),
                "declaredPageData" => r#"{"ok":true,"items":[]}"#.to_owned(),
                "declaredExec" => r#"{"ok":true,"exitCode":0,"stdout":"","stderr":""}"#.to_owned(),
                "declaredRedact" => r#"{"ok":true,"text":"가림"}"#.to_owned(),
                "emit" | "throwIfAborted" | "declaredClearReports" => r#"{"ok":true}"#.to_owned(),
                _ => return None,
            })
        })
    }

    /// 항목마다 `declaredPageData`가 맞게 나오도록 응답을 덮어쓴다
    fn with_items(reply: Reply, count: usize) -> Reply {
        Box::new(move |op, request| {
            if op == "declaredPageData" {
                let items = vec![r#"{"blocked":[],"warnings":[]}"#; count].join(",");
                return Some(format!(r#"{{"ok":true,"items":[{items}]}}"#));
            }
            reply(op, request)
        })
    }

    fn run_sync(hook: Hook) -> Res<Declared> {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        runtime.block_on(async move { run(&hook).await })
    }

    fn names(declared: &Declared) -> Vec<String> {
        declared.checks.iter().map(|check| check.prop("name").and_then(JsValue::as_str).unwrap().to_owned()).collect()
    }

    fn calls(log: &Log) -> Vec<String> {
        log.calls.lock().unwrap().clone()
    }

    #[test]
    fn 선언이_하나도_없으면_다른_콜백을_부르지_않고_빈_목록이다() {
        let log = fresh();
        let declared = run_sync(hook(log.clone(), 0, basic(plan("", "", "", "")))).ok().unwrap();
        assert!(declared.checks.is_empty() && declared.load_failure.is_none());
        assert_eq!(calls(&log), ["declaredBegin:"]);
    }

    #[test]
    fn 동시에_둘까지만_돌고_노드_순서대로_시작하며_결과는_노드_순서다() {
        let log = fresh();
        let tests = ["t1", "t2", "t3", "t4", "t5"].map(|name| test_case(name, None)).join(",");
        let reply = with_items(basic(plan(&tests, "", "", "")), 5);
        let declared = run_sync(hook(log.clone(), 15, reply)).ok().unwrap();
        assert_eq!(names(&declared), ["t1", "t2", "t3", "t4", "t5"]);
        assert!(declared.checks.iter().all(|check| check.prop("ok") == Some(&JsValue::Bool(true))));
        assert!(log.max_in_flight.load(Ordering::SeqCst) <= 2);
        assert_eq!(log.max_in_flight.load(Ordering::SeqCst), 2);
        let started: Vec<String> = calls(&log).into_iter().filter(|call| call.starts_with("declaredExec:")).collect();
        assert_eq!(started.iter().map(|call| call.rsplit(',').next().unwrap().trim_matches(|c| c == '"' || c == ']').to_owned()).collect::<Vec<_>>(), ["t1", "t2", "t3", "t4", "t5"]);
    }

    #[test]
    fn 실패한_노드는_maxattempts까지_다시_하고_마지막_사유를_남긴다() {
        let log = fresh();
        let reply = with_items(
            Box::new({
                let base = basic(plan(&test_case("unit", Some(3)), "", "", ""));
                move |op, request| if op == "declaredExec" { Some(r#"{"ok":false,"error":{"message":"컨테이너가 없습니다"}}"#.to_owned()) } else { base(op, request) }
            }),
            1,
        );
        let declared = run_sync(hook(log.clone(), 0, reply)).ok().unwrap();
        let check = &declared.checks[0];
        assert_eq!(check.prop("ok"), Some(&JsValue::Bool(false)));
        assert_eq!(check.prop("attempts"), Some(&JsValue::Num(3.0)));
        assert_eq!(check.prop("detail").and_then(JsValue::as_str), Some("컨테이너가 없습니다"));
        assert!(check.prop("evidence").is_none());
        assert_eq!(calls(&log).iter().filter(|call| call.starts_with("declaredExec:")).count(), 3);
    }

    #[test]
    fn 종료_코드가_0이_아니거나_알아볼_수_없으면_통과가_아니다() {
        for exec in [r#"{"ok":true,"exitCode":1,"stdout":"a","stderr":"b"}"#, r#"{"ok":true,"stdout":"a"}"#, r#"{"ok":true,"exitCode":"0"}"#, r#"{"ok":true,"exitCode":null}"#] {
            let log = fresh();
            let base = basic(plan(&test_case("unit", None), "", "", ""));
            let reply = with_items(Box::new(move |op, request| if op == "declaredExec" { Some(exec.to_owned()) } else if op == "declaredStats" { Some(r#"{"ok":true,"usage":[]}"#.to_owned()) } else { base(op, request) }), 1);
            let declared = run_sync(hook(log, 0, reply)).ok().unwrap();
            assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)), "{exec}");
        }
    }

    #[test]
    fn 통과한_테스트에만_근거가_붙고_가리는_함수가_실패하면_근거_없이_통과로_남긴다() {
        let ok = with_items(basic(plan(&test_case("unit", None), "", "", "")), 1);
        let declared = run_sync(hook(fresh(), 0, ok)).ok().unwrap();
        let evidence = declared.checks[0].prop("evidence").expect("근거");
        assert_eq!(evidence, &JsValue::Arr(vec![s("가림"), s("가림")]));
        let base = basic(plan(&test_case("unit", None), "", "", ""));
        let broken = with_items(Box::new(move |op, request| if op == "declaredRedact" { Some(r#"{"ok":false,"error":{"message":"가리기 실패"}}"#.to_owned()) } else { base(op, request) }), 1);
        let declared = run_sync(hook(fresh(), 0, broken)).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(true)));
        assert!(declared.checks[0].prop("evidence").is_none());
    }

    #[test]
    fn 취소는_재시도_앞에서_던지고_마지막_작업이_끝난_뒤에는_던지지_않는다() {
        // 마지막(유일한) 작업이 실패로 끝나면 반복을 나와 던지지 않는다 — 맨 앞 취소 확인은 시작 때 한 번과 시도 앞 한 번뿐이다
        let log = fresh();
        let base = basic(plan(&test_case("unit", None), "", "", ""));
        let reply = with_items(Box::new(move |op, request| if op == "declaredExec" { Some(r#"{"ok":false,"error":{"message":"취소됨","aborted":true}}"#.to_owned()) } else { base(op, request) }), 1);
        let declared = run_sync(hook(log.clone(), 0, reply)).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)));
        assert_eq!(calls(&log).iter().filter(|call| call.starts_with("throwIfAborted")).count(), 2);

        // 재시도 앞에서 취소되면(둘째 취소 확인이 던진다) 그 노드의 실패로 끝나지 않고 검사 전체가 멈춘다
        let count = Arc::new(AtomicUsize::new(0));
        let base = basic(plan(&test_case("unit", Some(3)), "", "", ""));
        let reply = Box::new({
            let count = count.clone();
            move |op: &str, request: &JsValue| match op {
                "declaredExec" => Some(r#"{"ok":false,"error":{"message":"x"}}"#.to_owned()),
                "throwIfAborted" if count.fetch_add(1, Ordering::SeqCst) == 2 => Some(r#"{"fatal":true}"#.to_owned()),
                _ => base(op, request),
            }
        });
        assert_eq!(run_sync(hook(fresh(), 0, reply)).err(), Some(Fail::Hook));
    }

    #[test]
    fn 같은_작업_id가_겹치면_그래프_오류를_던지게_하고_실행하지_않는다() {
        let log = fresh();
        let tests = [test_case("same", None), test_case("same", None)].join(",");
        let base = basic(plan(&tests, "", "", ""));
        let reply = Box::new(move |op: &str, request: &JsValue| if op == "declaredThrowGraphError" { Some(r#"{"fatal":true}"#.to_owned()) } else { base(op, request) });
        assert_eq!(run_sync(hook(log.clone(), 0, reply)).err(), Some(Fail::Hook));
        let all = calls(&log);
        assert!(all.iter().any(|call| call.starts_with("declaredThrowGraphError")));
        assert!(!all.iter().any(|call| call.starts_with("declaredExec")));
    }

    #[test]
    fn 응답이_없거나_알아볼_수_없으면_통과가_아니라_hook_오류다() {
        // 계획 응답 없음, 모양 어긋남, 근거 줄이 글이 아님
        assert_eq!(run_sync(hook(fresh(), 0, Box::new(|_, _| None))).err(), Some(Fail::Hook));
        assert_eq!(run_sync(hook(fresh(), 0, Box::new(|_, _| Some(r#"{"ok":true}"#.to_owned())))).err(), Some(Fail::Hook));
        let base = basic(plan("", "", "", r#"{"stage":"browser_check","name":"x","ok":"true"}"#));
        assert_eq!(run_sync(hook(fresh(), 0, base)).err(), Some(Fail::Hook));
        // 테스트 실행 응답이 없으면(None) 그 노드의 실패가 아니라 검사 전체의 실패다
        let base = basic(plan(&test_case("unit", None), "", "", ""));
        let reply = Box::new(move |op: &str, request: &JsValue| if op == "declaredExec" { None } else { base(op, request) });
        assert_eq!(run_sync(hook(fresh(), 0, reply)).err(), Some(Fail::Hook));
    }

    #[test]
    fn 건너뛴_자동_페이지는_결과_맨_뒤에_그대로_남는다() {
        let skipped = r#"{"stage":"browser_check","name":"web /x (자동, 건너뜀)","ok":true,"attempts":1}"#;
        let declared = run_sync(hook(fresh(), 0, with_items(basic(plan(&test_case("unit", None), "", "", skipped)), 1))).ok().unwrap();
        assert_eq!(names(&declared), ["unit", "web /x (자동, 건너뜀)"]);
    }

    fn concurrency_case(extra: &str) -> String {
        format!(r#"{{"name":"stock","service":"api","method":"POST","path":"/p","concurrent":3,"expect":{{"successCount":{{"exactly":1}}{extra}}}}}"#)
    }

    fn concurrency_reply(source: &str, statuses: &'static [u32]) -> Reply {
        let base = with_items(basic(plan("", &concurrency_case(source), "", "")), 1);
        let index = Arc::new(AtomicUsize::new(0));
        Box::new(move |op, request| match op {
            "declaredEndpoint" => Some(r#"{"ok":true,"url":"http://127.0.0.1:1"}"#.to_owned()),
            "declaredResolveUrl" => Some(r#"{"ok":true,"href":"http://127.0.0.1:1/p","sameOrigin":true}"#.to_owned()),
            "declaredRequest" => Some(format!(r#"{{"ok":true,"status":{},"text":"{{\"stock\":0}}"}}"#, statuses[index.fetch_add(1, Ordering::SeqCst) % statuses.len()])),
            _ => base(op, request),
        })
    }

    #[test]
    fn 동시_요청은_출처_밖이면_요청하지_않고_안이면_같은_href로_n번_보낸다() {
        let log = fresh();
        let base = concurrency_reply("", &[201, 409, 409]);
        let outside = Box::new(move |op: &str, request: &JsValue| if op == "declaredResolveUrl" { Some(r#"{"ok":true,"href":"http://evil/p","sameOrigin":false}"#.to_owned()) } else { base(op, request) });
        let declared = run_sync(hook(log.clone(), 0, outside)).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)));
        assert_eq!(declared.checks[0].prop("detail").and_then(JsValue::as_str), Some("path must stay on the service host"));
        assert!(!calls(&log).iter().any(|call| call.starts_with("declaredRequest")));

        let log = fresh();
        let declared = run_sync(hook(log.clone(), 0, concurrency_reply("", &[201, 409, 409]))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(true)));
        assert_eq!(declared.checks[0].prop("detail").and_then(JsValue::as_str), Some("성공 1/3 (기대: 정확히 1) · 상태 201:1, 409:2"));
        assert_eq!(calls(&log).iter().filter(|call| call.starts_with("declaredRequest")).count(), 3);
    }

    #[test]
    fn 동시_요청의_판정은_하나라도_어긋나면_실패다() {
        let declared = run_sync(hook(fresh(), 0, concurrency_reply("", &[201, 201, 409]))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)));
        // then 값이 다르거나 읽지 못하면 실패, 같으면 통과
        let then = |equals: &str| format!(r#","then":{{"method":"GET","path":"/s","jsonPath":"$.stock","equals":{equals}}}"#);
        let declared = run_sync(hook(fresh(), 0, concurrency_reply(&then("0"), &[201, 409, 409]))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(true)));
        assert!(declared.checks[0].prop("detail").and_then(JsValue::as_str).unwrap().ends_with("$.stock = 0"));
        let declared = run_sync(hook(fresh(), 0, concurrency_reply(&then("1"), &[201, 409, 409]))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)));
        let declared = run_sync(hook(fresh(), 0, concurrency_reply(&then("\"0\""), &[201, 409, 409]))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)), "문자 \"0\"은 수 0과 다르다");
    }

    #[test]
    fn 상태_코드가_수가_아니면_알아볼_수_없는_응답이다() {
        let base = concurrency_reply("", &[201]);
        let reply = Box::new(move |op: &str, request: &JsValue| if op == "declaredRequest" { Some(r#"{"ok":true,"status":"201","text":"{}"}"#.to_owned()) } else { base(op, request) });
        assert_eq!(run_sync(hook(fresh(), 0, reply)).err(), Some(Fail::Hook));
    }

    fn load_case() -> String {
        r#"{"name":"orders-p95","service":"api","method":"POST","path":"/o","concurrent":10,"warmup":0,"expect":{"p95Ms":200,"latencyOf":[409]}}"#.to_owned()
    }

    fn load_reply(supported: bool, run: &'static str) -> Reply {
        let base = basic(plan("", "", &load_case(), ""));
        Box::new(move |op, request| match op {
            "declaredLoadSupported" => Some(format!(r#"{{"ok":true,"supported":{supported}}}"#)),
            "declaredRunLoad" => Some(run.to_owned()),
            "declaredPageData" => Some(r#"{"ok":true,"items":[]}"#.to_owned()),
            _ => base(op, request),
        })
    }

    #[test]
    fn 부하_확인을_재지_못하면_통과가_아니고_플랫폼_실패_사유를_남긴다() {
        let declared = run_sync(hook(fresh(), 0, load_reply(false, ""))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)));
        assert!(declared.load_failure.unwrap().starts_with("부하 확인 'orders-p95': 이 샌드박스 제공자는"));
        // 러너가 b-studio 쪽 실패(platform)로 던지면 사유를 남기고, 일반 실패는 check만 실패로 남긴다
        let declared = run_sync(hook(fresh(), 0, load_reply(true, r#"{"ok":false,"error":{"message":"러너 실패","platform":true}}"#))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)));
        assert_eq!(declared.load_failure.as_deref(), Some("부하 확인 'orders-p95': 가림"));
        let declared = run_sync(hook(fresh(), 0, load_reply(true, r#"{"ok":false,"error":{"message":"러너 오류"}}"#))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)));
        assert!(declared.load_failure.is_none());
        // 판정을 못 하는 결과(모양이 어긋남)는 통과가 아니라 실패 check다
        let declared = run_sync(hook(fresh(), 0, load_reply(true, r#"{"ok":true,"result":{"requests":1}}"#))).ok().unwrap();
        assert_eq!(declared.checks[0].prop("ok"), Some(&JsValue::Bool(false)));
    }

    #[test]
    fn 의존_작업이_실패하면_건너뛰고_실행하지_않는다() {
        let log = fresh();
        let tests = [test_case("a", None), test_case("b", None)].join(",");
        let base = with_items(basic(plan(&tests, "", "", "")), 2);
        let hook = hook(log.clone(), 0, Box::new(move |op, request| if op == "declaredExec" { Some(r#"{"ok":false,"error":{"message":"실패"}}"#.to_owned()) } else { base(op, request) }));
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let (results, started) = runtime.block_on(async {
            let declared_plan = read_plan(&js_json::parse_native(&plan(&tests, "", "", "")).unwrap()).unwrap();
            let ctx = Arc::new(Ctx { hook: hook.clone(), plan: declared_plan, notes: Mutex::new(HashMap::new()) });
            let nodes: Vec<NodeSpec> = (0..2).map(|index| NodeSpec { id: format!("test:{index}"), name: format!("{index}"), stage: "test", kind: Kind::Test(index), max_attempts: 1.0 }).collect();
            let deps = vec![vec![], vec!["test:0".to_owned()]];
            let results = run_graph(&ctx, &nodes, &deps, 2).await.ok().unwrap();
            (results, calls(&log).iter().filter(|call| call.starts_with("declaredExec")).count())
        });
        assert_eq!((results[0].status, results[1].status), ("failed", "skipped"));
        assert_eq!((results[1].attempts, results[1].error.as_deref()), (0.0, Some("의존 작업이 실패해 건너뛰었습니다")));
        assert_eq!(started, 1);
    }

    #[test]
    fn 그래프_반복_앞_취소_확인이_던지면_다음_작업을_시작하지_않는다() {
        // 확인 순서: 반복 앞(1) → a 시도 앞(2) → b 시도 앞(3) → 첫 작업이 끝난 뒤 반복 앞(4)에서 던진다. c는 시작하지 않는다
        let log = fresh();
        let count = Arc::new(AtomicUsize::new(0));
        let tests = ["a", "b", "c"].map(|name| test_case(name, None)).join(",");
        let base = with_items(basic(plan(&tests, "", "", "")), 3);
        let reply = Box::new({
            let count = count.clone();
            move |op: &str, request: &JsValue| if op == "throwIfAborted" && count.fetch_add(1, Ordering::SeqCst) == 3 { Some(r#"{"fatal":true}"#.to_owned()) } else { base(op, request) }
        });
        assert_eq!(run_sync(hook(log.clone(), 5, reply)).err(), Some(Fail::Hook));
        let started = calls(&log).iter().filter(|call| call.starts_with("declaredExec")).count();
        assert_eq!(started, 2);
    }
}
