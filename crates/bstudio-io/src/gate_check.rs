//! 게이트 check의 상태 기계(순서·분기·결과 조립)(옛 TS: `packages/agent/src/gate.ts`의 `VerificationGate.#check`·`#failure`·`#strayServices`)(ADR-195 4f A5b-1).
//!
//! **통과를 정하는 코드다.** 옛 코드의 순서와 분기를 그대로 따르고, 판정이 통과 쪽으로 열리는 자리는 그대로 두지 않고 아래 규칙으로 닫는다.
//! - 최종 통과는 `report.ok && 실패 검사 0개 && (light || 필수 단계 누락 0)`다. 검사의 `ok`는 `true`(불리언)일 때만 통과로 센다. 그 밖의 값(없음·글자·숫자)은 실패다.
//! - 콜백이 응답하지 않거나(`None`) 알아볼 수 없는 모양이면 통과가 아니라 `Fail::Hook`이다. 새로 삼키는 자리를 만들지 않는다.
//!   삼키는 자리는 옛 코드와 같은 하나뿐이다: 서비스 안 남은 프로세스 조회가 실패하면 그 사유를 통과한 review 기록으로 남기고 managed 서비스를 모두 다시 띄운다(모르면 막는 쪽).
//! - 취소: 옛 `signal?.throwIfAborted()` 자리마다 콜백(`throwIfAborted`)을 부른다. 던지면(`{ fatal: true }`) 그 뒤 단계도 `gate_done`도 없다.
//!   남은 프로세스 조회가 취소로 끊기면 `Fail::Aborted`다(TS가 `signal.reason`을 그대로 던진다).
//!
//! 상태는 TS 게이트 객체가 든다. 옛 코드가 필드를 바꾸던 **그 자리**에서 `setState` 콜백으로 알린다(중간에 던져도 그때까지 바뀐 필드가 옛 코드와 같다).
//! 이벤트도 옛 코드가 `onEvent`를 부르던 그 자리에서 `emit` 콜백으로 낸다. 이 크레이트는 이벤트를 모으지 않는다.
//! 하위 단계(도구 밖 변경 동기화·선언 정하기·기록 검사·선언한 검사 실행·다시 견줌·리뷰·필수 단계 대조·바뀐 파일 목록)는 TS가 든 값(sandbox·workspace·project)을 쓰므로 콜백이다.
//! 서비스 확인(`verifyChanges`)은 같은 크레이트의 `verify_io`를 바로 부르고, 그 콜백(`sync`·`restart` 등)은 같은 훅으로 TS에 넘긴다. 부를 때마다 `verifyBegin`을 먼저 불러
//! TS가 그 실행의 처리기(재시작이 다시 읽은 선언을 든다)를 새로 만들게 한다(옛 코드가 `verifyChanges`를 부를 때마다 새로 만들던 것과 같다).
//!
//! 글(안내·사유)은 한 글자도 바꾸지 않는다. 실패한 검사 목록 글(`gate_helpers::format_failed_checks`)과 검증 보고서 글(`verify_judge::format_verification_report`)은
//! 옛 코드가 napi 경계(`encodeNative`)를 거치던 글이라 짝 없는 서로게이트가 U+FFFD로 바뀌어 있었다. 여기서도 그 두 함수에 넣는 값만 같은 꼴(`well_formed_from_encoded`)로 만든다.
//! 사유·사람 확인 기록의 첫 줄·선언 변경 요약은 옛 코드가 JS 글자 그대로 이었으므로 TS가 보낸 글자(`encodeLoneSurrogates`한 꼴)를 그대로 잇는다.

use std::collections::HashSet;
use std::sync::Arc;

use bstudio_guard::connection_judge;
use bstudio_guard::gate_helpers;
use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::verify_judge;

use crate::verify_io::{self, call, call_done, input_error, req, s, string_list, strings, Answer, Fail, Res};

pub use crate::checkpoint_remote::Hook;

/// 한 번의 check가 다루는 입력. 모두 TS가 시작할 때 읽어 넘긴다
struct Gate {
    hook: Hook,
    /// `options.recheck === true`
    recheck: bool,
    /// `options.verify === 'light'`
    light: bool,
    allow_breaking: bool,
    /// 플랫폼 실패 뒤 다시 하기 전에 기다리는 시간(ms). TS가 `options.platformRetryDelayMs ?? 1500`으로 정한다
    retry_delay_ms: f64,
    /// 지금까지 실패로 센 횟수와 상한
    attempts: f64,
    max_attempts: f64,
    spec_file: String,
    /// 사람 확인 기록을 위조해 막힌 검사의 이름(`MANUAL_VERIFICATION_CHECK`)
    manual_check: String,
}

fn read_input(input: &str, hook: Hook) -> Res<Gate> {
    let value = js_json::parse_native(input).or_else(|_| input_error("게이트 입력을 읽지 못했습니다"))?;
    let flag = |key: &str| match value.prop(key) {
        Some(JsValue::Bool(on)) => Ok(*on),
        _ => input_error(format!("게이트 입력의 {key}가 불리언이 아닙니다")),
    };
    let number = |key: &str| match value.prop(key) {
        Some(JsValue::Num(n)) => Ok(*n),
        _ => input_error(format!("게이트 입력의 {key}가 수가 아닙니다")),
    };
    let text = |key: &str| match value.prop(key) {
        Some(JsValue::Str(t)) => Ok(t.clone()),
        _ => input_error(format!("게이트 입력의 {key}가 글자가 아닙니다")),
    };
    Ok(Gate {
        hook,
        recheck: flag("recheck")?,
        light: flag("light")?,
        allow_breaking: flag("allowBreaking")?,
        retry_delay_ms: number("retryDelayMs")?,
        attempts: number("attempts")?,
        max_attempts: number("maxAttempts")?,
        spec_file: text("specFile")?,
        manual_check: text("manualVerificationCheck")?,
    })
}

// ── 값 도우미 ────────────────────────────────────────────────────────────

fn obj(pairs: Vec<(&str, Option<JsValue>)>) -> JsValue {
    js_json::object(pairs)
}

fn is_ok(check: &JsValue) -> bool {
    matches!(check.prop("ok"), Some(JsValue::Bool(true)))
}

/// 검사 목록. 각 검사는 `stage`·`name`(글자)과 `ok`(불리언)가 있는 객체여야 한다. 아니면 알아볼 수 없는 응답이다
fn checks_of(value: Option<&JsValue>) -> Res<Vec<JsValue>> {
    let Some(JsValue::Arr(items)) = value else { return Err(Fail::Hook) };
    for item in items {
        let well_formed = matches!(item, JsValue::Obj(_))
            && matches!(item.prop("stage"), Some(JsValue::Str(_)))
            && matches!(item.prop("name"), Some(JsValue::Str(_)))
            && matches!(item.prop("ok"), Some(JsValue::Bool(_)));
        if !well_formed {
            return Err(Fail::Hook);
        }
    }
    Ok(items.clone())
}

/// 옛 코드가 napi 경계(`encodeNative` → Rust)에서 글자를 바꾸던 꼴: 짝 없는 서로게이트는 U+FFFD, 예약 글자는 원래 글자
fn lossy(value: &JsValue) -> JsValue {
    match value {
        JsValue::Str(text) => JsValue::Str(js::well_formed_from_encoded(text)),
        JsValue::Arr(items) => JsValue::Arr(items.iter().map(lossy).collect()),
        JsValue::Obj(object) => {
            let mut out = js_json::JsObject::new();
            for (key, item) in object.entries() {
                out.set(key, lossy(item));
            }
            JsValue::Obj(out)
        }
        other => other.clone(),
    }
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("")
}

fn outcome_pass() -> JsValue {
    obj(vec![("kind", Some(s("pass")))])
}

fn outcome_exhausted(summary: String) -> JsValue {
    obj(vec![("kind", Some(s("exhausted"))), ("summary", Some(s(summary)))])
}

// ── 이벤트·상태 ──────────────────────────────────────────────────────────

impl Gate {
    async fn emit(&self, event: JsValue) -> Res<()> {
        call_done(&self.hook, req("emit", vec![("event", event)])).await.map(|_| ())
    }

    async fn stage(&self, stage: &str) -> Res<()> {
        self.emit(obj(vec![("type", Some(s("stage"))), ("stage", Some(s(stage))), ("source", Some(s("platform")))])).await
    }

    async fn workflow_checks(&self, checks: &[JsValue]) -> Res<()> {
        for check in checks {
            self.emit(obj(vec![("type", Some(s("workflow_check"))), ("check", Some(check.clone()))])).await?;
        }
        Ok(())
    }

    async fn set_state(&self, fields: Vec<(&str, JsValue)>) -> Res<()> {
        call_done(&self.hook, req("setState", fields)).await.map(|_| ())
    }

    /// 취소됐으면 TS가 던진다(`signal?.throwIfAborted()`)
    async fn throw_if_aborted(&self) -> Res<()> {
        call_done(&self.hook, req("throwIfAborted", vec![])).await.map(|_| ())
    }

    async fn checks_from(&self, op: &str, fields: Vec<(&str, JsValue)>) -> Res<Vec<JsValue>> {
        let answer = call_done(&self.hook, req(op, fields)).await?;
        checks_of(answer.prop("checks"))
    }

    /// `report.ok`일 때만 `gate_done`을 낸다(#1155). 도중에 던지면 부르지 않으므로 나가지 않는다
    async fn gate_done(&self, report_ok: bool, ok: bool) -> Res<()> {
        if report_ok {
            self.emit(obj(vec![("type", Some(s("gate_done"))), ("ok", Some(JsValue::Bool(ok)))])).await?;
        }
        Ok(())
    }

    /// 선언한 검사(테스트 등)를 돌린 뒤 필수 단계 가운데 돌지 않은 것
    async fn missing_stages(&self, passed: &[String]) -> Res<Vec<String>> {
        let answer = call_done(&self.hook, req("missingStages", vec![("passed", strings(passed))])).await?;
        string_list(answer.prop("missing"))
    }
}

// ── 남은 프로세스 ────────────────────────────────────────────────────────

struct Strays {
    services: Vec<String>,
    note: Option<JsValue>,
}

fn background_note(detail: String) -> JsValue {
    obj(vec![("stage", Some(s("review"))), ("name", Some(s("background-processes"))), ("ok", Some(JsValue::Bool(true))), ("attempts", Some(JsValue::Num(1.0))), ("detail", Some(s(detail)))])
}

/// `#strayServices`. 조회는 콜백이고, 글 모양과 "확인하지 못하면 managed 전부"는 여기서 정한다
async fn stray_services(g: &Gate) -> Res<Strays> {
    let (reports, failure) = match call(&g.hook, req("strayProcesses", vec![])).await? {
        Answer::Done(value) => {
            if matches!(value.prop("unsupported"), Some(JsValue::Bool(true))) {
                return Ok(Strays { services: Vec::new(), note: None });
            }
            match value.prop("reports") {
                Some(JsValue::Arr(items)) => (items.clone(), None),
                _ => return Err(Fail::Hook),
            }
        }
        Answer::Failed { message, aborted, value, .. } => {
            if aborted {
                return Err(Fail::Aborted);
            }
            (Vec::new(), Some((message, string_list(value.prop("managed"))?)))
        }
    };
    if let Some((message, all)) = failure {
        let note = background_note(format!("서비스 안의 백그라운드 프로세스를 확인하지 못해 서비스를 모두 다시 띄웠습니다: {message}"));
        return Ok(Strays { services: all, note: Some(note) });
    }
    if reports.is_empty() {
        return Ok(Strays { services: Vec::new(), note: None });
    }
    let mut lines = Vec::new();
    let mut services = Vec::new();
    for report in &reports {
        let Some(service) = report.prop("service").and_then(JsValue::as_str) else { return Err(Fail::Hook) };
        services.push(service.to_owned());
        if let Some(error) = report.prop("error") {
            lines.push(format!("{service}: {}", error.to_js_string()));
            continue;
        }
        let Some(JsValue::Arr(processes)) = report.prop("processes") else { return Err(Fail::Hook) };
        let mut shown = Vec::new();
        for process in processes.iter().take(3) {
            if !matches!(process, JsValue::Obj(_)) {
                return Err(Fail::Hook);
            }
            // `process.command || \`pid ${process.pid}\``
            match process.prop("command").filter(|command| command.truthy()) {
                Some(command) => shown.push(command.to_js_string()),
                None => shown.push(format!("pid {}", process.prop("pid").map_or_else(|| "undefined".to_owned(), JsValue::to_js_string))),
            }
        }
        let more = if processes.len() > 3 { format!(" 외 {}개", processes.len() - 3) } else { String::new() };
        lines.push(format!("{service}: {}{more}", shown.join(", ")));
    }
    let note = background_note(format!("검사 전에 서비스 안에 남은 백그라운드 프로세스가 있어 그 서비스를 다시 띄웠습니다(서비스 안 명령으로 오래 도는 프로세스를 남기지 마세요) — {}", lines.join(" / ")));
    Ok(Strays { services, note: Some(note) })
}

// ── 서비스 확인 ──────────────────────────────────────────────────────────

/// `verifyChanges`를 한 번 돈다. 입력의 바탕(`root`·`managed` 등)은 TS가 이번 실행의 선언으로 만들어 주고, 여기서 `alsoRestart`·`allowBreaking`을 더한다
async fn run_verify(g: &Gate, files: &[String], also_restart: &[String]) -> Res<JsValue> {
    let begin = call_done(&g.hook, req("verifyBegin", vec![("files", strings(files))])).await?;
    let Some(JsValue::Obj(base)) = begin.prop("input") else { return Err(Fail::Hook) };
    let mut input = base.clone();
    if !also_restart.is_empty() {
        input.set("alsoRestart", strings(also_restart));
    }
    input.set("allowBreaking", JsValue::Bool(g.allow_breaking));
    verify_io::dispatch("verifyChanges", &js_json::to_native(&JsValue::Obj(input)), Some(g.hook.clone())).await
}

fn report_text(g: &Gate, report: &JsValue) -> String {
    verify_judge::format_verification_report(&js_json::to_native(&lossy(report)), g.allow_breaking, &g.spec_file)
}

// ── 실패 ─────────────────────────────────────────────────────────────────

impl Gate {
    /// `#failure`. 시도 횟수를 세고, 남은 기회가 있으면 모델에게 돌려줄 안내를, 없으면 중단 사유를 돌려준다
    async fn failure(&self, report_text: &str, failed: &[JsValue], report_ok: bool, unadopted: Option<&str>) -> Res<JsValue> {
        let attempts = self.attempts + 1.0;
        self.set_state(vec![("attempts", JsValue::Num(attempts))]).await?;
        if attempts >= self.max_attempts {
            // 사람 확인 기록 위조로 막힌 것이면 사유를 요약에 남긴다
            let record = failed.iter().find(|check| check.prop("name").and_then(JsValue::as_str) == Some(self.manual_check.as_str()));
            let reason = match record.and_then(|check| check.prop("detail")).filter(|detail| detail.truthy()) {
                Some(JsValue::Str(detail)) => format!(" — {}", first_line(detail)),
                Some(_) => return Err(Fail::Hook),
                None => String::new(),
            };
            // 선언을 고치려던 요청이면 사용자가 다음에 할 일을 알 수 있게 한다
            let declared = unadopted.map_or_else(String::new, |change| format!(" — 확인의 선언을 바꾸려던 것이면 '확인 선언 변경 허용'을 켜고 다시 요청하세요(이번 실행에서 바뀐 선언: {change})"));
            return Ok(outcome_exhausted(format!("검증 게이트를 {}번 통과하지 못했습니다{reason}{declared}", js::number_to_string(attempts))));
        }
        // 실패를 앞에 쓴다. 서비스 확인이 통과했는데 뒤 검사가 실패한 경우 보고서가 "검증 통과"로 시작하면 첫 줄이 통과로 읽힌다(#1155)
        let listed = format_failed(failed)?;
        let failed_text = listed.trim_start_matches(js::is_js_whitespace);
        let body = if report_text.is_empty() {
            failed_text.to_owned()
        } else if report_ok {
            format!("{failed_text}\n\n[참고] 서비스 재시작·계약 확인은 통과했습니다.\n{report_text}")
        } else {
            format!("{report_text}{listed}")
        };
        // 선언을 고쳐도 이 실행의 검증에는 쓰이지 않는다는 것을 모델이 모르면 같은 수정을 되풀이하다 시도를 다 쓴다
        let declared = unadopted.map_or_else(String::new, |change| {
            format!(
                "\n\n[참고] 이번 실행에서 {}의 확인 선언을 바꿨지만({change}) 이 검증은 실행을 시작할 때의 선언으로 돌았습니다. 선언은 사용자가 허용한 요청에서만 그 실행의 검증에 쓰입니다. 선언을 바꾸는 것이 사용자의 요청이면 같은 수정을 되풀이하지 말고, 되묻기 도구(ask_user)로 사용자에게 \"'확인 선언 변경 허용'을 켜고 답해 달라\"고 알리세요.",
                self.spec_file
            )
        });
        Ok(obj(vec![
            ("kind", Some(s("retry"))),
            ("feedback", Some(s(format!("[b-studio 검증 게이트] 변경 사항이 검증을 통과하지 못했습니다. 아래 결과를 보고 고친 뒤 턴을 끝내세요.\n\n{body}{declared}")))),
        ]))
    }
}

/// `formatFailedChecks`. 옛 TS 껍데기가 `{stage, name, attempts, detail}`만 골라 napi로 넘겼다
fn format_failed(failed: &[JsValue]) -> Res<String> {
    let picked: Vec<JsValue> = failed
        .iter()
        .map(|check| {
            lossy(&obj(vec![
                ("stage", check.prop("stage").cloned()),
                ("name", check.prop("name").cloned()),
                ("attempts", check.prop("attempts").cloned()),
                ("detail", check.prop("detail").cloned()),
            ]))
        })
        .collect();
    gate_helpers::format_failed_checks(&JsValue::Arr(picked)).or_else(|message| input_error(message))
}

// ── check ────────────────────────────────────────────────────────────────

async fn check(g: &Gate) -> Res<JsValue> {
    let hook = &g.hook;
    // 도구 밖 변경을 작업 공간에 옮긴다. 바뀐 파일 수를 보기 전에 해야, 그것만 바뀐 턴도 "바뀐 파일 없음"으로 지나가지 않는다
    let rejected = string_list(call_done(hook, req("outsideSync", vec![])).await?.prop("rejected"))?;
    // 확인 선언을 먼저 정한다. 그 뒤의 모든 단계가 같은 선언을 본다
    let declared_answer = call_done(hook, req("reviewDeclared", vec![])).await?;
    let declared = checks_of(declared_answer.prop("checks"))?;
    let unadopted: Option<String> = match declared_answer.prop("unadoptedChange") {
        Some(JsValue::Str(change)) if !change.is_empty() => Some(change.clone()),
        Some(JsValue::Str(_)) | Some(JsValue::Null) | None => None,
        Some(_) => return Err(Fail::Hook),
    };
    // 바뀐 파일 목록에 의존하지 않는 검사들. 바뀐 파일이 0개인 턴에서도 돈다
    let mut record = g.checks_from("requirementRecords", vec![]).await?;
    record.extend(g.checks_from("evaluationAssets", vec![]).await?);
    record.extend(declared);
    if !rejected.is_empty() {
        let feedback = connection_judge::rejected_change_feedback(&rejected.iter().map(|file| js::well_formed_from_encoded(file)).collect::<Vec<_>>());
        record.push(obj(vec![
            ("stage", Some(s("review"))),
            ("name", Some(s("outside-tool-changes"))),
            ("ok", Some(JsValue::Bool(false))),
            ("attempts", Some(JsValue::Num(1.0))),
            ("detail", Some(s(feedback))),
        ]));
    }

    if !g.recheck {
        let answer = call_done(hook, req("changedCount", vec![])).await?;
        let Some(JsValue::Num(count)) = answer.prop("count") else { return Err(Fail::Hook) };
        if *count == 0.0 {
            if record.iter().all(is_ok) {
                return Ok(outcome_pass());
            }
            // 바뀐 파일로 추적되지 않은 경로(서비스 안 명령 등)로 검증 기록만 고쳤다: 다른 단계는 돌릴 것이 없다
            g.set_state(vec![("checks", JsValue::Arr(record.clone()))]).await?;
            g.workflow_checks(&record).await?;
            let failed: Vec<JsValue> = record.iter().filter(|check| !is_ok(check)).cloned().collect();
            return g.failure("", &failed, false, unadopted.as_deref()).await;
        }
    }

    // 다시 확인은 studio.yaml을 바뀐 파일로 넘겨 관리 서비스를 모두 다시 띄우고 선언을 다시 읽게 한다
    let files = if g.recheck { vec![g.spec_file.clone()] } else { string_list(call_done(hook, req("filesToVerify", vec![])).await?.prop("files"))? };
    g.stage("run").await?;
    g.emit(obj(vec![("type", Some(s("verify_start"))), ("files", Some(strings(&files)))])).await?;
    call_done(hook, req("markVersion", vec![])).await?;
    // 바뀌지 않은 서비스에 b-studio가 모르는 백그라운드 프로세스가 남았으면 그 서비스도 다시 띄운다(#765)
    let strays = stray_services(g).await?;
    if let Some(note) = strays.note {
        record.push(note);
    }
    let mut report = run_verify(g, &files, &strays.services).await?;
    // 샌드박스·도커 쪽 실패는 잠깐의 경합일 수 있다. 모델을 거치지 않고 한 번만 그대로 다시 해 본다
    if !report_ok(&report) && platform_failure(&report).is_some() {
        g.throw_if_aborted().await?;
        call_done(hook, req("retrySleep", vec![("ms", JsValue::Num(g.retry_delay_ms))])).await?;
        report = run_verify(g, &files, &strays.services).await?;
    }
    // 도중에 취소되면 계약 조회처럼 결과로 바뀐 중단까지 게이트 실패로 알리지 않는다
    g.throw_if_aborted().await?;
    g.stage("contract_check").await?;
    let report_ok = report_ok(&report);
    let failed_services = failed_services(&report)?;
    g.set_state(vec![
        ("report", report.clone()),
        ("failedServices", strings(&failed_services)),
        ("passedStages", JsValue::Arr(Vec::new())),
        ("checks", JsValue::Arr(record.clone())),
    ])
    .await?;
    let mut checks = record.clone();

    let text = report_text(g, &report);
    // report.ok면 이 뒤에 선언 검사·리뷰가 더 돈다(오래 걸릴 수 있다). 끝나면 gate_done을 낸다(#1155)
    g.emit(obj(vec![
        ("type", Some(s("verify_result"))),
        ("report", Some(report.clone())),
        ("text", Some(s(text.clone()))),
        ("moreChecks", report_ok.then_some(JsValue::Bool(true))),
    ]))
    .await?;
    // 세션이 시작할 때는 없던 부가 서비스를 새로 올렸으면 대화 화면에도 바로 알린다(도그푸딩 마찰 138)
    if let Some(JsValue::Arr(added)) = report.prop("addedAddons") {
        if !added.is_empty() {
            let names: Vec<String> = added.iter().map(JsValue::to_js_string).collect();
            g.emit(obj(vec![("type", Some(s("warning"))), ("message", Some(s(format!("compose에 새로 생긴 부가 서비스를 켰습니다(끄려면 서비스 메뉴에서): {}", names.join(", "))))) ])).await?;
        }
    }

    // 다시 해도 샌드박스·도커 쪽 문제면 여기서 멈춘다. 에이전트가 고칠 수 없는 실패라 재시도 횟수로 세지 않는다(트러블슈팅 117)
    if !report_ok {
        if let Some(failure) = platform_failure(&report) {
            g.set_state(vec![("platformFailure", s(failure.clone()))]).await?;
            return Ok(outcome_exhausted(format!("b-studio 쪽(샌드박스·도커) 문제로 검증을 끝내지 못했습니다. 바꾼 코드의 문제가 아닙니다 — {failure}")));
        }
    }
    g.set_state(vec![("platformFailure", JsValue::Null)]).await?;

    // 서비스가 뜨지 않았거나 계약이 깨졌으면 그 위에서 테스트나 화면 확인을 돌려도 의미가 없다
    let mut passed: Vec<String> = Vec::new();
    if report_ok {
        passed.push("run".to_owned());
        passed.push("contract_check".to_owned());
        g.set_state(vec![("passedStages", strings(&passed))]).await?;
        if g.light {
            // 가볍게 확인: 재시작·준비 판정·계약만 돌린다. 건너뛴 단계는 기록만 하고 실패로 보지 않는다
            let skipped = g.missing_stages(&passed).await?;
            g.set_state(vec![("skippedStages", strings(&skipped))]).await?;
            g.workflow_checks(&record).await?;
        } else {
            let answer = call_done(hook, req("runDeclared", vec![])).await?;
            let mut declared_checks = checks_of(answer.prop("checks"))?;
            let load_failure = match answer.prop("loadPlatformFailure") {
                Some(JsValue::Str(text)) if !text.is_empty() => Some(text.clone()),
                Some(JsValue::Str(_)) | Some(JsValue::Null) | None => None,
                Some(_) => return Err(Fail::Hook),
            };
            g.throw_if_aborted().await?;
            // 선언한 검사(테스트)를 돌리는 동안 평가 자산·도구 밖 파일이 바뀌었을 수 있다. 검사 뒤에 다시 견주고, 다르면 실패로 바꾼다(TOCTOU)
            record = g.checks_from("recheckEvaluationAssets", vec![("recordChecks", JsValue::Arr(record))]).await?;
            record = g.checks_from("recheckOutsideChanges", vec![("recordChecks", JsValue::Arr(record))]).await?;
            // 부하 확인을 재지 못한 것이 b-studio 쪽 문제면 여기서 멈춘다. 서비스 재시작의 플랫폼 실패와 같은 규칙이다(트러블슈팅 117)
            if let Some(failure) = load_failure {
                declared_checks.extend(record.iter().cloned());
                g.set_state(vec![("checks", JsValue::Arr(declared_checks.clone()))]).await?;
                g.workflow_checks(&declared_checks).await?;
                g.set_state(vec![("platformFailure", s(failure.clone()))]).await?;
                g.gate_done(report_ok, false).await?;
                return Ok(outcome_exhausted(format!("b-studio 쪽(샌드박스·도커) 문제로 검증을 끝내지 못했습니다. 바꾼 코드의 문제가 아닙니다 — {failure}")));
            }
            g.stage("review").await?;
            declared_checks.extend(g.checks_from("reviewChecks", vec![]).await?);
            declared_checks.extend(record.iter().cloned());
            checks = declared_checks;
            g.set_state(vec![("checks", JsValue::Arr(checks.clone()))]).await?;
            g.workflow_checks(&checks).await?;
            for stage in ["browser_check", "test", "concurrency_check", "load_check", "review"] {
                let of_stage: Vec<&JsValue> = checks.iter().filter(|check| check.prop("stage").and_then(JsValue::as_str) == Some(stage)).collect();
                if !of_stage.is_empty() && of_stage.iter().all(|check| is_ok(check)) {
                    passed.push(stage.to_owned());
                }
            }
            g.set_state(vec![("passedStages", strings(&passed))]).await?;
        }
    }

    let failed: Vec<JsValue> = checks.iter().filter(|check| !is_ok(check)).cloned().collect();
    if report_ok && failed.is_empty() {
        // light는 건너뛴 단계를 실패로 보지 않는다. 통과한 단계만 남겨 배포 조건(releaseRequires)이 자연히 막는다
        if g.light {
            g.set_state(vec![("verified", JsValue::Bool(true))]).await?;
            g.gate_done(report_ok, true).await?;
            return Ok(outcome_pass());
        }
        // 스키마가 실행 수단 없는 필수 단계를 막지만, 어떤 경로로든 단계가 돌지 않았다면 통과로 보지 않는다
        let missing = g.missing_stages(&passed).await?;
        if !missing.is_empty() {
            g.gate_done(report_ok, false).await?;
            return Ok(outcome_exhausted(format!("워크플로 필수 단계가 실행되지 않아 완료로 인정하지 않습니다: {}", missing.join(", "))));
        }
        g.set_state(vec![("verified", JsValue::Bool(true))]).await?;
        g.gate_done(report_ok, true).await?;
        return Ok(outcome_pass());
    }

    g.gate_done(report_ok, false).await?;
    g.failure(&text, &failed, report_ok, unadopted.as_deref()).await
}

fn report_ok(report: &JsValue) -> bool {
    matches!(report.prop("ok"), Some(JsValue::Bool(true)))
}

/// `report.platformFailure`가 비어 있지 않은 글이면 그 글(JS 진릿값)
fn platform_failure(report: &JsValue) -> Option<String> {
    report.prop("platformFailure").filter(|failure| failure.truthy()).map(JsValue::to_js_string)
}

/// 준비되지 않은 서비스(`!check.ready`)의 이름
fn failed_services(report: &JsValue) -> Res<Vec<String>> {
    let Some(JsValue::Arr(restarted)) = report.prop("restarted") else { return Err(Fail::Hook) };
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for check in restarted {
        let Some(service) = check.prop("service").and_then(JsValue::as_str) else { return Err(Fail::Hook) };
        if !matches!(check.prop("ready"), Some(JsValue::Bool(true))) && seen.insert(service.to_owned()) {
            names.push(service.to_owned());
        }
    }
    Ok(names)
}

// ── 입구 ─────────────────────────────────────────────────────────────────

/// napi가 부르는 한 입구. 입력: `{ recheck, light, allowBreaking, retryDelayMs, attempts, maxAttempts, specFile, manualVerificationCheck }`.
/// 출력: `{ ok: true, value: GateOutcome }` 또는 `{ ok: false, kind: hook | aborted | input, message? }`
pub async fn run(input: &str, hook: Option<Hook>) -> String {
    let outcome = match hook {
        None => Err(Fail::Hook),
        Some(hook) => match read_input(input, hook) {
            Ok(gate) => check(&Arc::new(gate)).await,
            Err(fail) => Err(fail),
        },
    };
    let out = match outcome {
        Ok(value) => obj(vec![("ok", Some(JsValue::Bool(true))), ("value", Some(value))]),
        Err(Fail::Hook) => obj(vec![("ok", Some(JsValue::Bool(false))), ("kind", Some(s("hook")))]),
        Err(Fail::Aborted) => obj(vec![("ok", Some(JsValue::Bool(false))), ("kind", Some(s("aborted")))]),
        Err(Fail::Input(message)) => obj(vec![("ok", Some(JsValue::Bool(false))), ("kind", Some(s("input"))), ("message", Some(s(message)))]),
    };
    js_json::to_native(&out)
}
