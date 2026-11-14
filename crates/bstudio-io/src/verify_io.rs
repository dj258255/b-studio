//! 게이트 검증의 조율(순서·재시도·결과 조립)(옛 TS: `packages/agent/src/verify.ts`의 `verifyChanges`·`restartServicesFor`·`restartOnce`·`ensureNewAddons`·
//! `captureBaselines`·`findSecretLeaks`·`deletedFiles`·`blockedEgressSince`)(ADR-195 4f A5a).
//!
//! 판정(`verify_ok`·`platform_failure_of`·`mentions_deleted_file`)은 `bstudio_guard::verify_judge`가 하고, 여기는 그 판정을 **어떤 순서로 부르는가**만 한다.
//! 샌드박스·프로젝트·계약은 TS가 든다. 순서 중간에 TS 값이 끼는 자리는 콜백(`Hook`) 하나로 부른다. 요청은 `{ op, ... }`, 응답은 셋 가운데 하나다.
//! - `{ ok: true, ... }`
//! - `{ ok: false, error: { message, platform?, aborted? }, ... }` : 옛 코드가 `catch`해서 값으로 읽던 실패. 삼킬지 값으로 쓸지는 **여기서** 정한다.
//! - `{ fatal: true }` : 옛 코드에서 그대로 던져 올라가던 실패(TS가 잡아 둔 오류를 그대로 다시 던진다). 이 뒤 단계를 하지 않는다.
//!
//! **통과를 정하는 코드다.** 콜백이 응답하지 않거나(`None`) 알아볼 수 없는 모양이면 통과가 아니라 `Fail::Hook`(검증을 끝내지 못함)이다. 옛 코드에서 삼키던 자리는
//! 옛 코드와 같은 값으로만 삼키고(아래 목록), 새로 삼키는 자리를 만들지 않는다.
//!
//! 삼키는 자리(옛 코드와 같다): `stats` 실패 → 빈 목록, `logs` 실패 → 그때까지 모은 줄, `egressDenials` 실패 → 빈 목록, 파일 읽기 실패(`findSecretLeaks`) → 시크릿 없음,
//! `loadProject` 실패 → `specError`(옛 project로 계속), `ensureInfra` 실패 → `addonError`(TS가 `{ ok: false, reason }`로 바꿔 돌려준다), 기준 계약 가져오기 실패 → 그 서비스는 기준 없음.
//! 옛 코드에도 있던 빈틈 하나를 그대로 둔다: 부가 서비스 실패 이유가 빈 글자면 `addonError`를 적지 않는다(`...(addons?.error ? ...)`가 빈 글자를 거짓으로 읽었다. `ok`에는 영향이 없다).
//!
//! 막는 쪽/여는 쪽: `verify_ok`는 거짓이 되는 쪽이 닫는 쪽이다(여기는 입력을 넘기기만 한다). `mentions_deleted_file`은 참이면 한 번 더 띄우는 쪽으로 열린다.
//! 비교하는 두 글자 모두 TS가 `encodeLoneSurrogates`로 보낸 같은 꼴이다(짝 없는 서로게이트가 U+FFFD로 합쳐져 다른 파일 이름이 같아지지 않게).
//!
//! 병렬(`Promise.all`)은 `JoinSet`이다. 하나가 실패하면 바로 그 실패를 돌려준다(옛 `Promise.all`처럼 먼저 거절된 것을 올린다). 나머지는 떨어뜨린다.
//! 취소: 재시작이 실패했는데 TS가 `signal.aborted`라고 알리면 로그를 모으지 않고 `Fail::Aborted`다(TS가 `signal.reason`을 그대로 던진다). 지운 파일 재시도의 sleep도 콜백이라 취소로 끊긴다.
//!
//! 문자열: TS가 `encodeLoneSurrogates`한 글자를 그대로 주고받는다. 이 크레이트가 파일에서 읽은 글자(시크릿 검사에 넘기는 내용)만 `encode_reserved`로 같은 꼴로 만든다.

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use bstudio_guard::checkpoint_git as cg;
use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::node_path;
use bstudio_guard::review_input;
use bstudio_guard::verify_judge;
use std::sync::Arc;

pub use crate::checkpoint_remote::Hook;

/// 실패의 갈래. TS가 옛 동작으로 바꾼다
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fail {
    /// 콜백이 실패했거나 응답을 알아볼 수 없다. TS가 잡아 둔 오류가 있으면 그것을, 없으면 일반 오류를 던진다
    Hook,
    /// 재시작이 취소 때문에 끊겼다. TS가 `signal.reason`을 그대로 던진다
    Aborted,
    /// 입력을 읽지 못했다
    Input(String),
}

type Res<T> = Result<T, Fail>;

fn input_error<T>(message: impl Into<String>) -> Res<T> {
    Err(Fail::Input(message.into()))
}

// ── 콜백 ────────────────────────────────────────────────────────────────

/// 콜백 응답. `Failed`는 옛 코드가 `catch`로 값으로 읽던 실패다(`value`는 응답 전체: 실패해도 함께 온 값을 읽는다. 예: 로그를 모으다 실패해도 그때까지의 줄)
enum Answer {
    Done(JsValue),
    Failed { message: String, platform: bool, aborted: bool, value: JsValue },
}

fn s(text: impl Into<String>) -> JsValue {
    JsValue::Str(text.into())
}

fn strings(items: &[String]) -> JsValue {
    JsValue::Arr(items.iter().map(|item| s(item.clone())).collect())
}

fn req(op: &str, fields: Vec<(&str, JsValue)>) -> JsValue {
    let mut pairs: Vec<(&str, Option<JsValue>)> = vec![("op", Some(s(op)))];
    pairs.extend(fields.into_iter().map(|(key, value)| (key, Some(value))));
    js_json::object(pairs)
}

async fn call(hook: &Hook, request: JsValue) -> Res<Answer> {
    let answer = hook(js_json::to_native(&request)).await.ok_or(Fail::Hook)?;
    let value = js_json::parse_native(&answer).map_err(|_| Fail::Hook)?;
    if !matches!(value, JsValue::Obj(_)) || matches!(value.prop("fatal"), Some(JsValue::Bool(true))) {
        return Err(Fail::Hook);
    }
    match value.prop("ok") {
        Some(JsValue::Bool(true)) => Ok(Answer::Done(value)),
        Some(JsValue::Bool(false)) => {
            let error = value.prop("error").ok_or(Fail::Hook)?;
            let message = error.prop("message").and_then(JsValue::as_str).ok_or(Fail::Hook)?.to_owned();
            let flag = |key: &str| matches!(error.prop(key), Some(JsValue::Bool(true)));
            Ok(Answer::Failed { message, platform: flag("platform"), aborted: flag("aborted"), value: value.clone() })
        }
        _ => Err(Fail::Hook),
    }
}

/// 성공해야 하는 콜백(옛 코드에서 실패하면 그대로 던지던 자리). 실패 응답은 알아볼 수 없는 응답이다
async fn call_done(hook: &Hook, request: JsValue) -> Res<JsValue> {
    match call(hook, request).await? {
        Answer::Done(value) => Ok(value),
        Answer::Failed { .. } => Err(Fail::Hook),
    }
}

/// 문자열 목록이어야 하는 필드. 없거나 모양이 다르면 `Fail::Hook`
fn string_list(value: Option<&JsValue>) -> Res<Vec<String>> {
    match value {
        Some(JsValue::Arr(items)) => items.iter().map(|item| item.as_str().map(str::to_owned).ok_or(Fail::Hook)).collect(),
        _ => Err(Fail::Hook),
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 목록을 UTF-16 순서(JS `sort()`)로 정렬한다
fn sort_utf16(mut items: Vec<String>) -> Vec<String> {
    items.sort_by(|a, b| js::cmp_utf16(a, b));
    items
}

/// `[...new Set(items)]`
fn unique(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

// ── 입력 ────────────────────────────────────────────────────────────────

/// 한 번의 실행이 다루는 것. TS가 든 값은 모두 콜백 뒤에 있고, 여기에는 순서를 정하는 데 쓰는 값만 있다
struct Ctx {
    hook: Hook,
    root: String,
    /// 사용자가 꺼 둔 서비스(`project.offServices`). 없으면 `None`
    off: Option<HashSet<String>>,
    /// `managed`의 `(이름, 계약 선언이 있는가)`
    managed: Vec<(String, bool)>,
    spec_file: String,
    compose_changed: bool,
    has_ensure_infra: bool,
    retry_delay_ms: f64,
}

fn read_input(input: &str) -> Res<(Ctx, JsValue)> {
    let value = js_json::parse_native(input).or_else(|_| input_error("검증 입력을 읽지 못했습니다"))?;
    let text = |key: &str| value.prop(key).and_then(JsValue::as_str).map(str::to_owned);
    let flag = |key: &str| matches!(value.prop(key), Some(JsValue::Bool(true)));
    let Some(root) = text("root") else { return input_error("검증 입력에 root가 없습니다") };
    let off = match value.prop("offServices") {
        Some(JsValue::Null) | None => None,
        other => Some(string_list(other).or_else(|_| input_error("offServices가 문자열 목록이 아닙니다"))?.into_iter().collect()),
    };
    let managed = match value.prop("managed") {
        Some(JsValue::Arr(items)) => items
            .iter()
            .map(|item| match (item.prop("name").and_then(JsValue::as_str), item.prop("hasContract")) {
                (Some(name), Some(JsValue::Bool(has))) => Ok((name.to_owned(), *has)),
                _ => input_error("managed의 모양이 어긋납니다"),
            })
            .collect::<Res<Vec<_>>>()?,
        _ => return input_error("managed가 목록이 아닙니다"),
    };
    let retry_delay_ms = match value.prop("retryDelayMs") {
        Some(JsValue::Num(n)) => *n,
        _ => 3_000.0,
    };
    let ctx = Ctx {
        hook: Arc::new(|_| Box::pin(async { None })),
        root,
        off,
        managed,
        spec_file: text("specFile").unwrap_or_default(),
        compose_changed: flag("composeChanged"),
        has_ensure_infra: flag("hasEnsureInfra"),
        retry_delay_ms,
    };
    Ok((ctx, value))
}

fn input_strings(value: &JsValue, key: &str) -> Res<Vec<String>> {
    string_list(value.prop(key)).or_else(|_| input_error(format!("{key}가 문자열 목록이 아닙니다")))
}

// ── 시크릿 ──────────────────────────────────────────────────────────────

pub struct SecretLeak {
    pub file: String,
    pub secrets: Vec<String>,
}

fn leak_value(leak: &SecretLeak) -> JsValue {
    js_json::object(vec![("file", Some(s(leak.file.clone()))), ("secrets", Some(strings(&leak.secrets)))])
}

/// 바뀐 파일에 시크릿 값이 들어갔는지. 파일을 읽지 못하면(없거나 폴더 등) 시크릿이 없는 것으로 본다(옛 `readFile(...).catch(() => undefined)`와 같다).
/// 파일마다 병렬이다(`Promise.all`)
async fn find_secret_leaks(ctx: &Arc<Ctx>, files: &[String]) -> Res<Vec<SecretLeak>> {
    let mut tasks = tokio::task::JoinSet::new();
    for (index, file) in files.iter().cloned().enumerate() {
        let ctx = ctx.clone();
        tasks.spawn(async move { (index, leak_of(&ctx, file).await) });
    }
    let mut slots: Vec<Option<Option<SecretLeak>>> = (0..files.len()).map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        let (index, leak) = joined.map_err(|_| Fail::Hook)?;
        slots[index] = Some(leak?);
    }
    slots.into_iter().map(|slot| slot.ok_or(Fail::Hook)).collect::<Res<Vec<_>>>().map(|all| all.into_iter().flatten().collect())
}

async fn leak_of(ctx: &Ctx, file: String) -> Res<Option<SecretLeak>> {
    let path = node_path::join(&[&js::well_formed_from_encoded(&ctx.root), &js::well_formed_from_encoded(&file)]);
    let Ok(bytes) = tokio::fs::read(&path).await else { return Ok(None) };
    let content = cg::encode_reserved(&String::from_utf8_lossy(&bytes));
    let answer = call_done(&ctx.hook, req("findSecrets", vec![("content", s(content))])).await?;
    let secrets = string_list(answer.prop("secrets"))?;
    Ok((!secrets.is_empty()).then_some(SecretLeak { file, secrets }))
}

// ── 재시작 ──────────────────────────────────────────────────────────────

#[derive(Default, Clone)]
struct Check {
    service: String,
    ready: bool,
    error: Option<String>,
    log_tail: Option<Vec<String>>,
    retried: bool,
    oom_killed: bool,
    blocked_egress: Vec<String>,
    platform: bool,
}

fn check_value(check: &Check) -> JsValue {
    let flag = |on: bool| on.then_some(JsValue::Bool(true));
    // 키 순서는 옛 TS가 만들던 객체와 같다(화면·기준 사진이 JSON 글을 그대로 쓴다): service, ready, error, logTail, oomKilled, blockedEgress, platform, retried
    js_json::object(vec![
        ("service", Some(s(check.service.clone()))),
        ("ready", Some(JsValue::Bool(check.ready))),
        ("error", check.error.clone().map(JsValue::Str)),
        ("logTail", check.log_tail.as_ref().map(|lines| strings(lines))),
        ("oomKilled", flag(check.oom_killed)),
        ("blockedEgress", (!check.blocked_egress.is_empty()).then(|| strings(&check.blocked_egress))),
        ("platform", flag(check.platform)),
        ("retried", flag(check.retried)),
    ])
}

enum SyncState {
    Done(JsValue),
    Failed { message: String, platform: bool },
}

struct Restarted {
    sync: SyncState,
    checks: Vec<Check>,
    unverified: Vec<String>,
    skipped_off: Vec<String>,
    spec_error: Option<String>,
    added: Vec<String>,
    addon_error: Option<String>,
}

fn sync_value(sync: &SyncState) -> JsValue {
    match sync {
        SyncState::Done(elapsed) => js_json::object(vec![("elapsedMs", Some(elapsed.clone()))]),
        SyncState::Failed { message, platform } => js_json::object(vec![("error", Some(s(message.clone()))), ("platform", platform.then_some(JsValue::Bool(true)))]),
    }
}

fn restarted_pairs(r: &Restarted) -> Vec<(&'static str, Option<JsValue>)> {
    vec![
        ("sync", Some(sync_value(&r.sync))),
        ("restarted", Some(JsValue::Arr(r.checks.iter().map(check_value).collect()))),
        ("unverifiedFiles", Some(strings(&r.unverified))),
        ("skippedOff", Some(strings(&r.skipped_off))),
        ("specError", r.spec_error.clone().map(JsValue::Str)),
        // 옛 코드: `...(addons?.added.length ? { addedAddons } : {})`, `...(addons?.error ? { addonError } : {})` (빈 글자 이유는 적지 않는다)
        ("addedAddons", (!r.added.is_empty()).then(|| strings(&r.added))),
        ("addonError", r.addon_error.clone().filter(|error| !error.is_empty()).map(JsValue::Str)),
    ]
}

/// 바뀐 파일이 샌드박스에 반영됐는지 확인한 뒤 그 파일이 속한 서비스를 다시 띄운다
async fn restart_services_for(ctx: &Arc<Ctx>, files: &[String], also_restart: &[String]) -> Res<Restarted> {
    let hook = &ctx.hook;
    // studio.yaml이나 compose 파일이 바뀌면 선언을 다시 읽는다. 스키마에 맞지 않으면 옛 project로 계속하고 오류는 specError로 돌려준다
    let spec_changed = files.iter().any(|file| *file == ctx.spec_file);
    let mut spec_error = None;
    if spec_changed || ctx.compose_changed {
        if let Answer::Failed { message, .. } = call(hook, req("loadProject", vec![])).await? {
            spec_error = Some(message);
        }
    }
    let owned = call_done(hook, req("servicesForFiles", vec![])).await?;
    let owned_services = string_list(owned.prop("services"))?;
    let unmatched = string_list(owned.prop("unmatched"))?;
    let wanted = unique(owned_services.into_iter().chain(also_restart.iter().cloned()).collect());
    // 사용자가 꺼 둔 서비스는 재시작하지 않고 건너뛴 사실만 남긴다
    let (services, skipped_off): (Vec<String>, Vec<String>) = match &ctx.off {
        Some(off) => (wanted.iter().filter(|service| !off.contains(*service)).cloned().collect(), wanted.iter().filter(|service| off.contains(*service)).cloned().collect()),
        None => (wanted.clone(), Vec::new()),
    };
    let deleted = deleted_files(&ctx.root, files).await;

    // Dockerfile의 systemPackages를 지금 선언과 맞춘다. 재시작이 빌드하기 전에 해야 한다. 실패하면 그대로 올린다
    call_done(hook, req("syncSystemPackages", vec![("services", strings(&services))])).await?;

    // 반영 확인이 먼저다. 실패하면 재시작하지 않고 돌아간다
    let sync = match call(hook, req("sync", vec![("files", strings(files))])).await? {
        Answer::Done(value) => SyncState::Done(value.prop("elapsedMs").cloned().unwrap_or(JsValue::Null)),
        Answer::Failed { message, platform, .. } => {
            return Ok(Restarted { sync: SyncState::Failed { message, platform }, checks: Vec::new(), unverified: unmatched, skipped_off, spec_error, added: Vec::new(), addon_error: None });
        }
    };

    let (added, addon_error) = if ctx.compose_changed { ensure_new_addons(ctx).await? } else { (Vec::new(), None) };

    let deleted = Arc::new(deleted);
    let mut tasks = tokio::task::JoinSet::new();
    for (index, service) in services.iter().cloned().enumerate() {
        let (ctx, deleted) = (ctx.clone(), deleted.clone());
        tasks.spawn(async move { (index, restart_with_retry(&ctx, &service, &deleted).await) });
    }
    let mut slots: Vec<Option<Check>> = (0..services.len()).map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        let (index, check) = joined.map_err(|_| Fail::Hook)?;
        slots[index] = Some(check?);
    }
    let checks = slots.into_iter().map(|slot| slot.ok_or(Fail::Hook)).collect::<Res<Vec<_>>>()?;

    Ok(Restarted { sync, checks, unverified: unmatched, skipped_off, spec_error, added, addon_error })
}

async fn restart_with_retry(ctx: &Ctx, service: &str, deleted: &[String]) -> Res<Check> {
    let first = restart_once(ctx, service).await?;
    if first.ready || !verify_judge::mentions_deleted_file(first.log_tail.as_deref().unwrap_or(&[]), deleted) {
        return Ok(first);
    }
    // 반영 확인이 끝났어도 새로 뜬 컨테이너 안의 목록에 지운 파일이 잠깐 남을 수 있다. 잠시 뒤 한 번만 다시 띄운다(트러블슈팅 13)
    call_done(&ctx.hook, req("sleep", vec![("ms", JsValue::Num(ctx.retry_delay_ms))])).await?;
    let mut second = restart_once(ctx, service).await?;
    second.retried = true;
    Ok(second)
}

async fn restart_once(ctx: &Ctx, service: &str) -> Res<Check> {
    let hook = &ctx.hook;
    let started_at = now_ms();
    let (message, platform) = match call(hook, req("restart", vec![("service", s(service))])).await? {
        Answer::Done(_) => return Ok(Check { service: service.to_owned(), ready: true, ..Check::default() }),
        // 요청 취소나 세션 중지로 끊긴 재시작은 서비스 실패가 아니다. 로그를 모으지 않고 올린다
        Answer::Failed { aborted: true, .. } => return Err(Fail::Aborted),
        Answer::Failed { message, platform, .. } => (message, platform),
    };
    // 메모리 부족으로 죽었는지 먼저 알려야 에이전트가 코드를 고치려 들지 않는다. 통계를 못 읽으면 없는 것으로 본다(옛 `.catch(() => [])`)
    let usage = match call(hook, req("stats", vec![])).await? {
        Answer::Done(value) => match value.prop("entries") {
            Some(JsValue::Arr(entries)) => entries.iter().find(|entry| entry.prop("service").and_then(JsValue::as_str) == Some(service)).cloned(),
            _ => return Err(Fail::Hook),
        },
        Answer::Failed { .. } => None,
    };
    let log_tail = recent_logs(hook, service).await?;
    let blocked_egress = blocked_egress_since(hook, started_at).await?;
    if let Some(usage) = usage.filter(|usage| usage.prop("oomKilled").is_some_and(JsValue::truthy)) {
        let limit = usage.prop("limit").and_then(JsValue::as_str).unwrap_or("");
        return Ok(Check {
            service: service.to_owned(),
            ready: false,
            error: Some(format!("메모리 한도{limit}를 넘어 종료됐습니다. {message}")),
            log_tail: Some(log_tail),
            oom_killed: true,
            blocked_egress,
            ..Check::default()
        });
    }
    Ok(Check { service: service.to_owned(), ready: false, error: Some(message), log_tail: Some(log_tail), blocked_egress, platform, ..Check::default() })
}

/// 마지막 로그 60줄. 가져오다 실패하면 그때까지 모은 줄을 쓴다(옛 `try { for await ... } catch {}`)
async fn recent_logs(hook: &Hook, service: &str) -> Res<Vec<String>> {
    match call(hook, req("logs", vec![("service", s(service))])).await? {
        Answer::Done(value) => string_list(value.prop("lines")),
        Answer::Failed { value, .. } => match value.prop("lines") {
            None => Ok(Vec::new()),
            lines => string_list(lines),
        },
    }
}

/// 막힌 외부 접속을 "호스트:포트 (이유)"로 중복 없이 모은다. 시계가 조금 어긋날 수 있어 5초 여유를 둔다
async fn blocked_egress_since(hook: &Hook, started_at_ms: i64) -> Res<Vec<String>> {
    let since = started_at_ms - 5_000;
    let denials = match call(hook, req("egressDenials", vec![("sinceMs", JsValue::Num(since as f64))])).await? {
        Answer::Done(value) => match value.prop("denials") {
            Some(JsValue::Arr(items)) => items.clone(),
            _ => return Err(Fail::Hook),
        },
        Answer::Failed { .. } => Vec::new(),
    };
    let mut lines = Vec::new();
    for denial in &denials {
        if !matches!(denial, JsValue::Obj(_)) {
            return Err(Fail::Hook);
        }
        let truthy = |key: &str| denial.prop(key).is_some_and(JsValue::truthy);
        let host = review_input::template(denial.prop("host"));
        let port = if truthy("port") { format!(":{}", review_input::template(denial.prop("port"))) } else { String::new() };
        let path = if js_json::nullish(denial.prop("path")) { String::new() } else { review_input::template(denial.prop("path")) };
        let method = if truthy("method") { format!("{} ", review_input::template(denial.prop("method"))) } else { String::new() };
        let line = format!("{method}{host}{port}{path} ({})", review_input::template(denial.prop("reason")));
        if !lines.contains(&line) {
            lines.push(line);
        }
    }
    Ok(lines)
}

/// compose 파일이 바뀐 재시작에서, 이 세션이 시작할 때 몰랐던 부가 서비스를 올린다. 제공자가 `ensureInfra`를 모르면(쿠버네티스 등) 건너뛴다
async fn ensure_new_addons(ctx: &Ctx) -> Res<(Vec<String>, Option<String>)> {
    if !ctx.has_ensure_infra {
        return Ok((Vec::new(), None));
    }
    let info = call_done(&ctx.hook, req("composeInfo", vec![])).await?;
    let compose_services = string_list(info.prop("composeServices"))?;
    let managed_names: HashSet<String> = string_list(info.prop("managedNames"))?.into_iter().collect();
    let addons = sort_utf16(compose_services.into_iter().filter(|name| !managed_names.contains(name) && !ctx.off.as_ref().is_some_and(|off| off.contains(name))).collect());
    if addons.is_empty() {
        return Ok((Vec::new(), None));
    }
    let answer = call_done(&ctx.hook, req("ensureInfra", vec![("addons", strings(&addons))])).await?;
    let result = answer.prop("result").ok_or(Fail::Hook)?;
    let added = string_list(result.prop("recovered"))?;
    let error = if result.prop("ok").is_some_and(JsValue::truthy) {
        None
    } else {
        // `result.reason ?? '알 수 없는 이유'`
        Some(if js_json::nullish(result.prop("reason")) { "알 수 없는 이유".to_owned() } else { review_input::template(result.prop("reason")) })
    };
    Ok((added, error))
}

/// 호스트에서 이미 사라진 파일. 확인하지 못하면(권한·경로 오류 포함) 사라진 것으로 본다(옛 `access(...)` 실패와 같다)
async fn deleted_files(root: &str, files: &[String]) -> Vec<String> {
    let mut deleted = Vec::new();
    for file in files {
        let path = node_path::join(&[&js::well_formed_from_encoded(root), &js::well_formed_from_encoded(file)]);
        if tokio::fs::metadata(&path).await.is_err() {
            deleted.push(file.clone());
        }
    }
    deleted
}

// ── 계약 ────────────────────────────────────────────────────────────────

struct ContractCheck {
    service: String,
    changes: Vec<JsValue>,
    error: Option<String>,
}

fn contract_value(check: &ContractCheck) -> JsValue {
    js_json::object(vec![("service", Some(s(check.service.clone()))), ("changes", Some(JsValue::Arr(check.changes.clone()))), ("error", check.error.clone().map(JsValue::Str))])
}

async fn contract_of(ctx: &Ctx, service: String) -> Res<ContractCheck> {
    match call(&ctx.hook, req("contract", vec![("service", s(service.clone()))])).await? {
        Answer::Done(value) => match value.prop("changes") {
            Some(JsValue::Arr(changes)) => Ok(ContractCheck { service, changes: changes.clone(), error: None }),
            _ => Err(Fail::Hook),
        },
        // 계약 추출 실패는 이유가 빈 글자여도 오류다(트러블슈팅 171)
        Answer::Failed { message, .. } => Ok(ContractCheck { service, changes: Vec::new(), error: Some(message) }),
    }
}

fn is_breaking(change: &JsValue) -> Res<bool> {
    if !matches!(change, JsValue::Obj(_)) {
        return Err(Fail::Hook);
    }
    Ok(change.prop("breaking").is_some_and(JsValue::truthy))
}

async fn verify_changes(ctx: &Arc<Ctx>, files: &[String], also_restart: &[String], allow_breaking: bool) -> Res<JsValue> {
    let leaks = find_secret_leaks(ctx, files).await?;
    let restarted = restart_services_for(ctx, files, also_restart).await?;

    let (sync_error, sync_platform) = match &restarted.sync {
        SyncState::Failed { message, platform } => (Some(message.as_str()), *platform),
        SyncState::Done(_) => (None, false),
    };
    let platform_failure = verify_judge::platform_failure_of(
        sync_error,
        sync_platform,
        &restarted.checks.iter().map(|check| check.service.clone()).collect::<Vec<_>>(),
        &restarted.checks.iter().map(|check| check.ready).collect::<Vec<_>>(),
        &restarted.checks.iter().map(|check| check.platform).collect::<Vec<_>>(),
        &restarted.checks.iter().map(|check| check.error.clone().unwrap_or_default()).collect::<Vec<_>>(),
    );

    let leak_values = JsValue::Arr(leaks.iter().map(leak_value).collect());
    let platform_failure = platform_failure.map(JsValue::Str);

    if sync_error.is_some() {
        return Ok(report_value(false, &restarted, JsValue::Arr(Vec::new()), JsValue::Arr(Vec::new()), leak_values, platform_failure));
    }

    // 재시작에 실패했거나 꺼 둬 건너뛴 서비스의 계약은 뽑을 수 없으므로 준비된 서비스만 비교한다
    let failed: HashSet<&str> = restarted.checks.iter().filter(|check| !check.ready).map(|check| check.service.as_str()).collect();
    let off: HashSet<&str> = restarted.skipped_off.iter().map(String::as_str).collect();
    let targets: Vec<String> = ctx.managed.iter().filter(|(name, has)| *has && !failed.contains(name.as_str()) && !off.contains(name.as_str())).map(|(name, _)| name.clone()).collect();

    let mut tasks = tokio::task::JoinSet::new();
    for (index, service) in targets.iter().cloned().enumerate() {
        let ctx = ctx.clone();
        tasks.spawn(async move { (index, contract_of(&ctx, service).await) });
    }
    let mut slots: Vec<Option<ContractCheck>> = (0..targets.len()).map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        let (index, check) = joined.map_err(|_| Fail::Hook)?;
        slots[index] = Some(check?);
    }
    let contracts = slots.into_iter().map(|slot| slot.ok_or(Fail::Hook)).collect::<Res<Vec<_>>>()?;

    let mut breaking = Vec::new();
    for check in &contracts {
        for change in &check.changes {
            breaking.push(is_breaking(change)?);
        }
    }
    let ok = verify_judge::verify_ok(
        &restarted.checks.iter().map(|check| check.ready).collect::<Vec<_>>(),
        &contracts.iter().map(|check| check.error.is_some()).collect::<Vec<_>>(),
        &breaking,
        allow_breaking,
        leaks.len(),
        restarted.spec_error.is_some(),
    );

    Ok(report_value(ok, &restarted, JsValue::Arr(restarted.checks.iter().map(check_value).collect()), JsValue::Arr(contracts.iter().map(contract_value).collect()), leak_values, platform_failure))
}

/// `VerificationReport`. 키 순서는 옛 TS가 만들던 객체와 같다: ok, sync, restarted, contracts, unverifiedFiles, secretLeaks, skippedOff, specError, addedAddons, addonError, platformFailure
fn report_value(ok: bool, r: &Restarted, restarted: JsValue, contracts: JsValue, leaks: JsValue, platform_failure: Option<JsValue>) -> JsValue {
    let mut pairs = restarted_pairs(r);
    let tail = pairs.split_off(2); // unverifiedFiles, skippedOff, specError, addedAddons, addonError
    let mut report = vec![("ok", Some(JsValue::Bool(ok))), ("sync", Some(sync_value(&r.sync))), ("restarted", Some(restarted)), ("contracts", Some(contracts))];
    let mut tail = tail.into_iter();
    report.push(tail.next().expect("unverifiedFiles"));
    report.push(("secretLeaks", Some(leaks)));
    report.extend(tail);
    report.push(("platformFailure", platform_failure));
    js_json::object(report)
}

/// 세션 시작 시점의 계약을 저장해 둔다(순서대로 하나씩). 실패한 서비스는 기준 없이 건너뛴다(옛 `catch {}`). 저장은 콜백(TS가 든다)이 하고, 저장한 서비스 이름을 돌려준다
async fn capture_baselines(ctx: &Ctx) -> Res<Vec<String>> {
    let mut captured = Vec::new();
    for (name, has_contract) in &ctx.managed {
        if !has_contract || ctx.off.as_ref().is_some_and(|off| off.contains(name)) {
            continue;
        }
        if let Answer::Done(_) = call(&ctx.hook, req("baseline", vec![("service", s(name.clone()))])).await? {
            captured.push(name.clone());
        }
    }
    Ok(captured)
}

// ── 입구 ────────────────────────────────────────────────────────────────

/// napi가 부르는 한 입구. `op`: `verifyChanges` · `restartServicesFor` · `findSecretLeaks` · `captureBaselines`.
/// 입력: `{ root, files, alsoRestart?, offServices, managed: [{ name, hasContract }], composeChanged, specFile, hasEnsureInfra, retryDelayMs?, allowBreaking? }`.
/// 출력: `{ ok: true, value }` 또는 `{ ok: false, kind: hook | aborted | input, message? }`
pub async fn run(op: &str, input: &str, hook: Option<Hook>) -> String {
    let outcome = dispatch(op, input, hook).await;
    let out = match outcome {
        Ok(value) => js_json::object(vec![("ok", Some(JsValue::Bool(true))), ("value", Some(value))]),
        Err(Fail::Hook) => js_json::object(vec![("ok", Some(JsValue::Bool(false))), ("kind", Some(s("hook")))]),
        Err(Fail::Aborted) => js_json::object(vec![("ok", Some(JsValue::Bool(false))), ("kind", Some(s("aborted")))]),
        Err(Fail::Input(message)) => js_json::object(vec![("ok", Some(JsValue::Bool(false))), ("kind", Some(s("input"))), ("message", Some(s(message)))]),
    };
    js_json::to_native(&out)
}

async fn dispatch(op: &str, input: &str, hook: Option<Hook>) -> Res<JsValue> {
    let (mut ctx, value) = read_input(input)?;
    ctx.hook = hook.ok_or(Fail::Hook)?;
    let ctx = Arc::new(ctx);
    let files = input_strings(&value, "files")?;
    let also_restart = if value.prop("alsoRestart").is_none() { Vec::new() } else { input_strings(&value, "alsoRestart")? };
    match op {
        "verifyChanges" => verify_changes(&ctx, &files, &also_restart, matches!(value.prop("allowBreaking"), Some(JsValue::Bool(true)))).await,
        "restartServicesFor" => {
            let restarted = restart_services_for(&ctx, &files, &also_restart).await?;
            Ok(js_json::object(restarted_pairs(&restarted)))
        }
        "findSecretLeaks" => Ok(JsValue::Arr(find_secret_leaks(&ctx, &files).await?.iter().map(leak_value).collect())),
        "captureBaselines" => Ok(strings(&capture_baselines(&ctx).await?)),
        other => input_error(format!("알 수 없는 검증 연산입니다: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 요청의 op를 `ops`에 적고, `answer(op, 요청)`이 준 JSON 글을 돌려주는 콜백. `None`이면 콜백이 응답하지 못한 것이다
    fn scripted(ops: Arc<Mutex<Vec<String>>>, answer: impl Fn(&str, &JsValue) -> Option<String> + Send + Sync + 'static) -> Hook {
        Arc::new(move |request: String| {
            let parsed = js_json::parse_native(&request).expect("요청은 JSON");
            let op = parsed.prop("op").and_then(JsValue::as_str).unwrap_or("").to_owned();
            ops.lock().unwrap().push(op.clone());
            let reply = answer(&op, &parsed);
            Box::pin(async move { reply })
        })
    }

    fn base_input(root: &str, files: &str, managed: &str, extra: &str) -> String {
        format!(r#"{{"root":{root:?},"files":{files},"offServices":null,"managed":{managed},"specFile":"studio.yaml","composeChanged":false,"hasEnsureInfra":false{extra}}}"#)
    }

    fn defaults(op: &str) -> Option<String> {
        Some(
            match op {
                "servicesForFiles" => r#"{"ok":true,"services":["api"],"unmatched":[]}"#,
                "syncSystemPackages" | "restart" | "sleep" => r#"{"ok":true}"#,
                "sync" => r#"{"ok":true,"elapsedMs":5}"#,
                "stats" => r#"{"ok":true,"entries":[]}"#,
                "logs" => r#"{"ok":true,"lines":["로그"]}"#,
                "egressDenials" => r#"{"ok":true,"denials":[]}"#,
                "contract" => r#"{"ok":true,"changes":[]}"#,
                _ => return None,
            }
            .to_owned(),
        )
    }

    fn run_sync(op: &str, input: &str, hook: Hook) -> JsValue {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let text = runtime.block_on(run(op, input, Some(hook)));
        js_json::parse_native(&text).expect("결과는 JSON")
    }

    fn ops_of(ops: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        ops.lock().unwrap().clone()
    }

    #[test]
    fn 정상은_정해진_순서로_콜백을_부른다() {
        let ops = Arc::new(Mutex::new(Vec::new()));
        let input = base_input("/nonexistent-root", r#"["api/a.java"]"#, r#"[{"name":"api","hasContract":true}]"#, "");
        let result = run_sync("verifyChanges", &input, scripted(ops.clone(), |op, _| defaults(op)));
        assert_eq!(result.prop("ok"), Some(&JsValue::Bool(true)));
        assert_eq!(result.prop("value").and_then(|v| v.prop("ok")), Some(&JsValue::Bool(true)));
        // 파일은 없는 경로라 시크릿 검사 콜백은 부르지 않는다(읽지 못하면 시크릿 없음)
        assert_eq!(ops_of(&ops), ["servicesForFiles", "syncSystemPackages", "sync", "restart", "contract"]);
    }

    #[test]
    fn 반영_확인이_실패하면_재시작과_계약을_부르지_않고_실패로_돌아간다() {
        let ops = Arc::new(Mutex::new(Vec::new()));
        let input = base_input("/nonexistent-root", r#"["api/a.java"]"#, r#"[{"name":"api","hasContract":true}]"#, "");
        let hook = scripted(ops.clone(), |op, _| if op == "sync" { Some(r#"{"ok":false,"error":{"message":"반영 안 됨\n둘째 줄","platform":true}}"#.into()) } else { defaults(op) });
        let report = run_sync("verifyChanges", &input, hook);
        let value = report.prop("value").unwrap();
        assert_eq!(value.prop("ok"), Some(&JsValue::Bool(false)));
        assert_eq!(value.prop("platformFailure").and_then(JsValue::as_str), Some("반영 안 됨"));
        assert_eq!(ops_of(&ops), ["servicesForFiles", "syncSystemPackages", "sync"]);
    }

    #[test]
    fn 취소로_끊긴_재시작은_로그를_모으지_않고_취소로_돌아간다() {
        let ops = Arc::new(Mutex::new(Vec::new()));
        let input = base_input("/nonexistent-root", r#"["api/a.java"]"#, "[]", "");
        let hook = scripted(ops.clone(), |op, _| if op == "restart" { Some(r#"{"ok":false,"error":{"message":"끊김","aborted":true}}"#.into()) } else { defaults(op) });
        let result = run_sync("restartServicesFor", &input, hook);
        assert_eq!(result.prop("kind").and_then(JsValue::as_str), Some("aborted"));
        assert_eq!(ops_of(&ops), ["servicesForFiles", "syncSystemPackages", "sync", "restart"]);
    }

    #[test]
    fn 계약_오류는_이유가_빈_글자여도_실패다() {
        let ops = Arc::new(Mutex::new(Vec::new()));
        let input = base_input("/nonexistent-root", r#"[]"#, r#"[{"name":"api","hasContract":true}]"#, r#","alsoRestart":["api"]"#);
        let hook = scripted(ops.clone(), |op, _| if op == "contract" { Some(r#"{"ok":false,"error":{"message":""}}"#.into()) } else { defaults(op) });
        let result = run_sync("verifyChanges", &input, hook);
        let value = result.prop("value").unwrap();
        assert_eq!(value.prop("ok"), Some(&JsValue::Bool(false)));
        let contracts = value.prop("contracts").unwrap();
        assert_eq!(contracts, &JsValue::Arr(vec![js_json::object(vec![("service", Some(s("api"))), ("changes", Some(JsValue::Arr(vec![]))), ("error", Some(s("")))])]));
    }

    #[test]
    fn 계약의_breaking은_허용했을_때만_통과한다() {
        let input = |allow: &str| base_input("/nonexistent-root", r#"[]"#, r#"[{"name":"api","hasContract":true}]"#, &format!(r#","alsoRestart":["api"],"allowBreaking":{allow}"#));
        let hook = || scripted(Arc::new(Mutex::new(Vec::new())), |op, _| if op == "contract" { Some(r#"{"ok":true,"changes":[{"kind":"operation-removed","target":"GET /x","breaking":true}]}"#.into()) } else { defaults(op) });
        let denied = run_sync("verifyChanges", &input("false"), hook());
        assert_eq!(denied.prop("value").and_then(|v| v.prop("ok")), Some(&JsValue::Bool(false)));
        let allowed = run_sync("verifyChanges", &input("true"), hook());
        assert_eq!(allowed.prop("value").and_then(|v| v.prop("ok")), Some(&JsValue::Bool(true)));
    }

    #[test]
    fn 콜백이_응답하지_않거나_알아볼_수_없으면_통과가_아니라_hook_오류다() {
        let input = base_input("/nonexistent-root", r#"["a.txt"]"#, "[]", "");
        for answer in [None, Some("not json".to_owned()), Some(r#"{"ok":"yes"}"#.to_owned()), Some("[]".to_owned()), Some(r#"{"fatal":true}"#.to_owned()), Some(r#"{"ok":false}"#.to_owned())] {
            let result = run_sync("restartServicesFor", &input, scripted(Arc::new(Mutex::new(Vec::new())), move |_, _| answer.clone()));
            assert_eq!(result.prop("ok"), Some(&JsValue::Bool(false)), "{result:?}");
            assert_eq!(result.prop("kind").and_then(JsValue::as_str), Some("hook"));
        }
    }

    #[test]
    fn 콜백이_없거나_입력이_어긋나면_오류다() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let text = runtime.block_on(run("verifyChanges", &base_input("/", "[]", "[]", ""), None));
        assert!(text.contains("\"kind\":\"hook\""));
        let text = runtime.block_on(run("verifyChanges", "{", Some(scripted(Arc::new(Mutex::new(Vec::new())), |_, _| None))));
        assert!(text.contains("\"kind\":\"input\""));
        let text = runtime.block_on(run("verifyChanges", r#"{"root":"/","managed":[]}"#, Some(scripted(Arc::new(Mutex::new(Vec::new())), |_, _| None))));
        assert!(text.contains("\"kind\":\"input\""), "files가 없으면 입력 오류: {text}");
        let text = runtime.block_on(run("없는연산", &base_input("/", "[]", "[]", ""), Some(scripted(Arc::new(Mutex::new(Vec::new())), |_, _| None))));
        assert!(text.contains("\"kind\":\"input\""));
    }

    #[test]
    fn 막힌_접속_글은_메서드_호스트_포트_경로_이유_순서로_중복_없이_만든다() {
        let hook = scripted(Arc::new(Mutex::new(Vec::new())), |op, _| {
            if op == "egressDenials" {
                Some(r#"{"ok":true,"denials":[{"host":"a","port":443,"method":"GET","path":"/p","reason":"r"},{"host":"a","port":443,"method":"GET","path":"/p","reason":"r"},{"host":"b","port":0,"reason":"z"}]}"#.into())
            } else {
                None
            }
        });
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let lines = runtime.block_on(blocked_egress_since(&hook, 100_000)).unwrap();
        assert_eq!(lines, ["GET a:443/p (r)", "b (z)"]);
    }

    #[test]
    fn 정렬은_utf16_순서다() {
        assert_eq!(sort_utf16(vec!["b".into(), "\u{1F600}".into(), "\u{FF5E}".into(), "a".into()]), ["a", "b", "\u{1F600}", "\u{FF5E}"]);
    }

    #[test]
    fn 기준_계약은_순서대로_가져오고_실패한_서비스는_저장한_것으로_세지_않는다() {
        let ops = Arc::new(Mutex::new(Vec::new()));
        let hook = scripted(ops.clone(), |op, request| {
            let service = request.prop("service").and_then(JsValue::as_str).unwrap_or("");
            (op == "baseline").then(|| if service == "b" { r#"{"ok":false,"error":{"message":"실패"}}"#.to_owned() } else { r#"{"ok":true}"#.to_owned() })
        });
        let input = base_input("/", "[]", r#"[{"name":"a","hasContract":true},{"name":"b","hasContract":true},{"name":"c","hasContract":false},{"name":"d","hasContract":true}]"#, "").replace(r#""offServices":null"#, r#""offServices":["d"]"#);
        let result = run_sync("captureBaselines", &input, hook);
        assert_eq!(result.prop("value"), Some(&JsValue::Arr(vec![s("a")])));
        assert_eq!(ops_of(&ops), ["baseline", "baseline"]);
    }
}
