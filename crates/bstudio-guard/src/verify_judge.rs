//! 검증 통과 판정(ADR-191 3단계 3u). 옛 `packages/agent/src/verify.ts`의 `verifyChanges` 안 `ok` 계산, `platformFailureOf`,
//! `mentionsDeletedFile`, `formatVerificationReport`. 실행 흐름(재시작, 계약 추출, 샌드박스 호출)은 TS에 남는다.
//!
//! **`verify_ok`는 검증 통과를 직접 정한다.** 거짓이 되는 쪽이 닫는 쪽이다. 새 구현은 옛 구현보다 통과시키는 입력이 없다.
//!
//! 옛 TS와 같은 입력에 같은 결과를 낸다. 다른 곳은 모두 더 막는 쪽이다.
//!  1. 계약 추출 실패의 이유가 빈 글자(`''`)일 때 옛 `ok`는 `!check.error`(빈 글자는 거짓)로 "오류 없음"으로 보아 통과시켰고 보고서는 "계약 변경 없음"을 적었다
//!     (트러블슈팅 171). 새 구현은 껍데기가 `error !== undefined`로 넘기므로 실패로 본다. 보고서도 이유가 있으면(빈 글자여도) "계약 추출 실패"를 적는다.
//!     `specError`가 빈 글자일 때 보고서가 안내 줄을 적지 않던 것도 같은 꼴이라 적는다(`ok`는 옛것도 `=== undefined`라 실패였다).
//!  2. 보고서 `ok`가 참인 값이 아니라 참 같은 값(`1`, `"x"`)이면 옛 구현은 "검증 통과"를 적었고, 새 구현은 JSON `true`일 때만 적는다.
//!  3. 보고서의 모양이 어긋나면(필드 없음, 배열이 아닌 목록) 옛 구현은 던졌다. 새 구현은 던지지 않고 "검증 실패"로 시작하는 글을 돌려준다(통과 글이 나오지 않는다).
//!
//! `mentions_deleted_file`은 참이면 실패한 서비스를 한 번 더 띄운다(통과 쪽으로 열린다). 껍데기가 비교하는 두 글자를 단사로 바꿔 보낸다
//! (짝 없는 서로게이트가 U+FFFD로 합쳐져 다른 파일 이름이 같아지지 않게).

use crate::js_json::{self, JsValue};
use crate::{contract_diff, js, node_path, review_input};

/// 검증 통과(`ok`). 모든 재시작한 서비스가 준비됐고, 계약 추출이 실패한 서비스가 없고, breaking 변경이 없거나 허용됐고, 시크릿이 파일에 들어가지 않았고,
/// studio.yaml 오류가 없을 때만 참이다. 빈 목록은 "모두"에 해당한다(옛 `every`와 같다: 재시작할 서비스가 없으면 준비 조건은 참이다)
pub fn verify_ok(restarted_ready: &[bool], contract_errored: &[bool], change_breaking: &[bool], allow_breaking: bool, secret_leaks: usize, spec_error: bool) -> bool {
    restarted_ready.iter().all(|ready| *ready)
        && contract_errored.iter().all(|errored| !*errored)
        && (allow_breaking || !change_breaking.iter().any(|breaking| *breaking))
        && secret_leaks == 0
        && !spec_error
}

/// 반영 확인이나 재시작이 샌드박스·도커 쪽 문제로 실패했으면 그 사유의 첫 줄. 이 값이 참 같으면 게이트가 재시도로 세지 않는다(열린 쪽)이므로
/// 모르는 입력은 `None`(코드 실패로 센다)이다
pub fn platform_failure_of(sync_error: Option<&str>, sync_platform: bool, services: &[String], ready: &[bool], platform: &[bool], errors: &[String]) -> Option<String> {
    if let Some(error) = sync_error {
        if sync_platform {
            return Some(first_line(error).to_owned());
        }
    }
    if services.len() != ready.len() || services.len() != platform.len() || services.len() != errors.len() {
        return None;
    }
    let failed = (0..services.len()).find(|&i| !ready[i] && platform[i])?;
    Some(format!("{}: {}", services[failed], first_line(&errors[failed])))
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("")
}

/// 로그에 지운 파일이 "없다"는 오류로 나오는지. 이름은 파일의 `path.posix.basename`이고, 빈 이름은 어느 줄에나 들어 있다(옛 `includes('')`와 같다)
pub fn mentions_deleted_file(log_tail: &[String], deleted: &[String]) -> bool {
    deleted.iter().any(|file| {
        let name = node_path::basename(file);
        log_tail.iter().any(|line| line.contains(&name) && says_no_such_file(line))
    })
}

/// `/NoSuchFile|No such file/i`. 대소문자 접기는 ASCII만이다(비ASCII 글자의 대문자가 ASCII가 되어도 접지 않는다)
fn says_no_such_file(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("nosuchfile") || lower.contains("no such file")
}

/// 검증 보고서 글. `report_json`은 `encodeNative`한 `VerificationReport`. 읽을 수 없으면 던지지 않고 실패 글을 돌려준다
pub fn format_verification_report(report_json: &str, allow_breaking: bool, spec_file: &str) -> String {
    match format_inner(report_json, allow_breaking, spec_file) {
        Ok(text) => text,
        Err(why) => format!("검증 실패\n- 검증 보고서의 모양이 어긋나 내용을 적을 수 없습니다: {why}"),
    }
}

/// `value.length > 0`로 읽는 목록(`?.length`면 없거나 null도 비어 있는 것). 목록이 아니면 오류
fn list<'a>(value: Option<&'a JsValue>, what: &str, optional: bool) -> Result<&'a [JsValue], String> {
    match value {
        Some(JsValue::Arr(items)) => Ok(items),
        None | Some(JsValue::Null) if optional => Ok(&[]),
        _ => Err(format!("{what}이(가) 배열이 아닙니다")),
    }
}

fn present(value: Option<&JsValue>) -> Option<&JsValue> {
    value.filter(|v| !matches!(v, JsValue::Null))
}

fn truthy(value: Option<&JsValue>) -> bool {
    value.is_some_and(JsValue::truthy)
}

fn format_inner(report_json: &str, allow_breaking: bool, spec_file: &str) -> Result<String, String> {
    let report = js_json::parse_native(report_json)?;
    if !matches!(report, JsValue::Obj(_)) {
        return Err("보고서가 객체가 아닙니다".into());
    }
    let get = |key: &str| report.prop(key);
    let mut lines: Vec<String> = vec![if matches!(get("ok"), Some(JsValue::Bool(true))) { "검증 통과" } else { "검증 실패" }.to_owned()];
    if truthy(get("platformFailure")) {
        lines.push(format!(
            "- b-studio 쪽(샌드박스·도커) 문제로 검증을 끝내지 못했습니다. 바꾼 코드의 문제가 아니므로 코드를 고쳐서 풀려고 하지 마세요: {}",
            review_input::template(get("platformFailure"))
        ));
    }
    if let Some(spec_error) = present(get("specError")) {
        lines.push(format!("- {spec_file} 형식이 올바르지 않아 이전 설정으로 재시작했습니다:"));
        lines.extend(spec_error.to_js_string().split('\n').map(|line| format!("    {line}")));
    }

    let sync = get("sync").ok_or("sync가 없습니다")?;
    let JsValue::Obj(sync_object) = sync else {
        return Err("sync가 객체가 아닙니다".into());
    };
    if sync_object.contains_key("error") {
        lines.push(format!("- 샌드박스 파일 반영 확인 실패: {}", review_input::template(sync.prop("error"))));
        return Ok(lines.join("\n"));
    }
    let elapsed = sync.prop("elapsedMs").map_or(f64::NAN, JsValue::to_number) / 1_000.0;
    lines.push(format!("- 샌드박스 파일 반영 확인: {}초", js::to_fixed(elapsed, 1)));

    let restarted = list(get("restarted"), "restarted", false)?;
    if restarted.is_empty() {
        lines.push("- 재시작한 서비스 없음".into());
    }
    for check in restarted {
        if !matches!(check, JsValue::Obj(_)) {
            return Err("재시작 결과가 객체가 아닙니다".into());
        }
        let retried = if truthy(check.prop("retried")) { " (지운 파일 반영을 기다려 한 번 더 재시작)" } else { "" };
        let service = review_input::template(check.prop("service"));
        if truthy(check.prop("ready")) {
            lines.push(format!("- {service}: 재시작 후 준비 완료{retried}"));
        } else {
            lines.push(format!("- {service}: 준비 실패{retried} — {}", review_input::template(check.prop("error"))));
        }
        let blocked = list(check.prop("blockedEgress"), "blockedEgress", true)?;
        if !blocked.is_empty() {
            lines.push(format!("  막힌 외부 접속 (studio.yaml network.egress에 없는 호스트): {}", review_input::join(blocked, ", ")));
        }
        let log_tail = list(check.prop("logTail"), "logTail", true)?;
        if !log_tail.is_empty() {
            lines.push("  마지막 로그:".into());
            lines.extend(log_tail.iter().map(|line| format!("    {}", line.to_js_string())));
        }
    }

    for check in list(get("contracts"), "contracts", false)? {
        if !matches!(check, JsValue::Obj(_)) {
            return Err("계약 결과가 객체가 아닙니다".into());
        }
        let service = review_input::template(check.prop("service"));
        // 이유가 있으면(빈 글자여도) 추출 실패다. 옛 구현은 빈 글자를 "없음"으로 읽었다(트러블슈팅 171)
        if let Some(error) = present(check.prop("error")) {
            lines.push(format!("- {service} 계약 추출 실패: {}", error.to_js_string()));
            continue;
        }
        let changes = check.prop("changes").ok_or("changes가 없습니다")?;
        lines.push(format!("- {service} 계약:"));
        lines.extend(contract_diff::format_contract_changes(changes)?.split('\n').map(|line| format!("    {line}")));
        let breaking = list(Some(changes), "changes", false)?.iter().any(|change| truthy(change.prop("breaking")));
        if !allow_breaking && breaking {
            lines.push("    이 요청은 호환을 깨는 변경을 허용하지 않았습니다(허용은 사람이 요청할 때 켭니다). 의도하지 않은 변경이면 되돌리고, 사람이 요청한 변경이면 되돌리지 말고 그 사실을 알리세요.".into());
        }
    }

    let unverified = list(get("unverifiedFiles"), "unverifiedFiles", false)?;
    if !unverified.is_empty() {
        lines.push(format!("- 재시작으로 확인하지 못한 파일: {}", review_input::join(unverified, ", ")));
    }
    let skipped = list(get("skippedOff"), "skippedOff", false)?;
    if !skipped.is_empty() {
        lines.push(format!("- 꺼 둔 서비스라 확인을 건너뜀(검증에 포함되지 않음): {}", review_input::join(skipped, ", ")));
    }
    let added = list(get("addedAddons"), "addedAddons", true)?;
    if !added.is_empty() {
        lines.push(format!("- compose에 새로 생긴 부가 서비스를 켰습니다(끄려면 서비스 메뉴에서): {}", review_input::join(added, ", ")));
    }
    if truthy(get("addonError")) {
        lines.push(format!("- 새로 생긴 부가 서비스를 올리지 못했습니다: {}", review_input::template(get("addonError"))));
    }
    for leak in list(get("secretLeaks"), "secretLeaks", false)? {
        if !matches!(leak, JsValue::Obj(_)) {
            return Err("시크릿 기록이 객체가 아닙니다".into());
        }
        let secrets = list(leak.prop("secrets"), "secrets", false)?;
        lines.push(format!(
            "- 시크릿 값이 파일에 들어갔습니다: {} ({}). 값은 코드에서 환경 변수로 읽고 파일에 쓰지 마세요",
            review_input::template(leak.prop("file")),
            review_input::join(secrets, ", ")
        ));
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok는_다섯_조건이_모두_맞을_때만_참이다() {
        assert!(verify_ok(&[true, true], &[false], &[false, false], false, 0, false));
        assert!(verify_ok(&[], &[], &[], false, 0, false));
        assert!(!verify_ok(&[true, false], &[false], &[], false, 0, false));
        assert!(!verify_ok(&[true], &[false, true], &[], false, 0, false));
        assert!(!verify_ok(&[true], &[], &[true], false, 0, false));
        assert!(verify_ok(&[true], &[], &[true], true, 0, false));
        assert!(!verify_ok(&[true], &[], &[], true, 1, false));
        assert!(!verify_ok(&[true], &[], &[], true, 0, true));
    }

    #[test]
    fn 플랫폼_실패는_첫_줄만_돌려준다() {
        let s = |t: &str| t.to_owned();
        assert_eq!(platform_failure_of(Some("a\nb"), true, &[], &[], &[], &[]), Some(s("a")));
        assert_eq!(platform_failure_of(Some("a\nb"), false, &[], &[], &[], &[]), None);
        assert_eq!(platform_failure_of(None, false, &[s("api"), s("web")], &[false, false], &[false, true], &[s("x"), s("y\nz")]), Some(s("web: y")));
        // 길이가 어긋난 입력은 코드 실패로 센다
        assert_eq!(platform_failure_of(None, false, &[s("api")], &[false], &[], &[s("x")]), None);
    }

    #[test]
    fn 지운_파일_이름이_없다는_오류와_함께_나올_때만_참이다() {
        let l = |t: &str| vec![t.to_owned()];
        let deleted = vec!["db/V2__memo.sql".to_owned()];
        assert!(mentions_deleted_file(&l("java.nio.file.NoSuchFileException: /app/V2__memo.sql"), &deleted));
        assert!(mentions_deleted_file(&l("stat: can't stat 'V2__memo.sql': No such file or directory"), &deleted));
        assert!(mentions_deleted_file(&l("V2__memo.sql: NO SUCH FILE"), &deleted));
        assert!(!mentions_deleted_file(&l("Flyway migrated V2__memo.sql"), &deleted));
        assert!(!mentions_deleted_file(&l("NoSuchFile: other.sql"), &deleted));
        assert!(!mentions_deleted_file(&l("v2__memo.sql: no such file"), &deleted));
        assert!(!mentions_deleted_file(&l("V2__memo.sql: no such\tfile"), &deleted));
    }
}
