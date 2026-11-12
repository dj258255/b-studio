//! 체크포인트의 원격 경로(올리기·가져오기·기준 브랜치 따라잡기·PR 대상)와 작업 복사본의 Git을 믿어도 되는지 보는 확인, 터미널이 어긋낸 기록을
//! 되돌리는 순서(옛 TS: `packages/agent/src/checkpoints.ts`의 `assertTrustedGit`·`#remoteGit`·`#assertSafeLocalGit`·`push`·`integrateRemote`·`acceptRemote`·
//! `baseStatus`·`#fetchBase`·`integrateBase`·`pullRequestTarget`·`recordPullRequest`·`repository`·`headState`·`remoteUrl`·`uncommitTo`·`restoreRememberedHead`)
//! (ADR-195 4f A2).
//!
//! 판정(`dangerous_local_config`·`info_attributes`·`remote_commits`·`pull_request_target`·`redact_credentials`·`is_index_lock_failure`·`subcommand`·`is_sha`)은
//! `bstudio_guard::checkpoint_git`이 하고, 여기는 git을 부르는 **순서**만 한다. 체크포인트 상태(메타는 저장소 설정 `b-studio.*`에 있다. 백업·제외 스냅샷·`CheckpointStore`의
//! 캐시)는 TS가 든다. 순서 중간에 TS 상태가 끼는 자리는 콜백(`Hook`)으로 부르고, 콜백이 실패하면 그 뒤 단계를 하지 않는다.
//!
//! **막는 검사다(원격에 닿는 명령).** `fetch`·`push`·`ls-remote`는 `remote_git` 한 함수로만 부른다. 이 함수는 먼저 `assert_trusted_git`(브랜치·HEAD·origin 주소·저장소 로컬 설정)를
//! 지난 뒤에만 git을 띄운다. 그 밖의 호출(`git`)은 원격에 닿는 하위 명령을 부르지 못한다(`network_command`가 막는다. 옆길을 만들지 않는 구조 보장).
//! 설정을 읽지 못하거나(git 실패) 형식을 알아보지 못하면 "위험한 값이 없다"가 아니라 오류다.
//!
//! 호출부별 막는 쪽/여는 쪽:
//! - `assert_trusted_git`·`assert_safe_local_git`·`dangerous_local_config`·`info_attributes`: 막는 쪽(거부 목록). 모르는 입력은 걸린 것으로(오류) 처리한다.
//! - `remote_git`: 막는 쪽(확인을 지나지 않으면 원격에 닿지 않는다).
//! - `is_ancestor`: 여는 쪽이 될 수 있다(실패를 거짓으로 읽는다. 옛 코드와 같다). 쓰는 자리: `push`의 `forced` 표시(거짓이면 강제로 표시 — 더 알리는 쪽), `integrate_remote`의
//!   "이미 들어 있음"(거짓이면 병합을 시도 — git이 막는다), "시작 커밋을 포함함"(거짓이면 가져오지 않음 — 막는 쪽), `integrate_base`의 "이미 들어 있음"(거짓이면 병합 시도),
//!   `accept_remote`(거짓이면 기록하지 않음 — 막는 쪽).
//! - `restore_remembered_head`의 `checkout -f`·`reset --hard`·`clean -fd`: 지우는 코드. 백업 콜백이 성공한 **뒤에만** 부른다(`Hook`이 실패하면 이 셋을 부르지 않는다).
//!   `clean`은 `-fd`(링크는 링크만 지우고 따라가지 않는다, 무시된 파일·중첩 저장소는 남긴다)이고 범위(`scope`)를 붙인다.
//!
//! 문자열: TS가 `encodeLoneSurrogates`로 보낸 값(짝 없는 서로게이트·예약 글자를 단사로 바꾼 글자)과 git이 낸 글자를 견주므로, git이 낸 글자는 `encode_reserved`로 같은 꼴로 만들고
//! git에 넘기는 인자는 `well_formed_from_encoded`(짝 없는 서로게이트는 U+FFFD, 예약 글자는 그대로의 글자 = Node가 인자로 넘기던 글자)로 되돌린다. 돌려주는 모든 글자는 인코딩한 꼴이고 TS가 푼다.
//!
//! `HARDENED`(옛 TS보다 더 막는 의도한 차이, 시험으로 고정):
//! ① `restore_remembered_head`는 `git add -A` 앞에서 `assert_safe_local_git`을 부른다(옛 코드는 부르지 않아 저장소 설정의 `filter.*.clean`이 호스트에서 실행됐다. 트러블슈팅 195).
//! ② `base_status`는 `baseFetchedAt`을 읽지 못하면(우리가 쓰는 꼴이 아니면) 오래된 것으로 보고 새로 가져온다(옛 JS는 `NaN`이 "오래되지 않음"으로 읽혀 영영 가져오지 않았다).
//! 의도한 차이: `repository()`의 `base`·`branch` 읽기는 동시가 아니라 순서대로이고, 목록의 정렬은 UTF-16 순서(JS `sort`)로 여기서 한다.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bstudio_guard::checkpoint_git as cg;
use bstudio_guard::js;
use bstudio_guard::js_json::{self, JsValue};
use bstudio_guard::node_path;
use serde_json::{json, Map, Value};

use crate::process_bytes::run_command_bytes;

/// 가져오기 전에 원격 세션 브랜치를 받아 두는 곳. origin/*는 원본 폴더의 브랜치를 가리킬 수 있어 쓰지 않는다
const REMOTE_REF: &str = "refs/b-studio/remote";
/// 기준 브랜치(main 등)를 받아 두는 곳(ADR-076)
const BASE_REF: &str = "refs/b-studio/base";
/// 기준 브랜치 확인(`base_status`)을 이 시간 안에 다시 부르면 새로 가져오지 않는다
const BASE_FETCH_THROTTLE_MS: i64 = 60_000;
const MAX_PATCH_CHARS: usize = 200_000;
const PUSH_TIMEOUT_MS: u64 = 120_000;
const GIT_MAX_BUFFER: usize = 64 * 1024 * 1024;
const INDEX_LOCK_RETRY_DELAYS_MS: [u64; 7] = [25, 50, 100, 200, 400, 800, 1400];
/// b-studio가 부르는 git은 저장소의 훅과 fsmonitor·전역 속성 파일을 쓰지 않는다(이슈 #699). 모든 호출의 맨 앞에 붙인다
const GIT_HARDENING: [&str; 6] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null"];

/// TS 콜백. 요청(JSON 글)을 받아 응답(JSON 글)을 돌려준다. 호출이 실패하면 `None`(TS가 던진 오류는 TS가 들고 있다)
pub type Hook = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> + Send + Sync>;

/// 실패의 갈래. TS가 옛 오류 클래스로 바꾼다
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fail {
    /// `CheckpointError(message)`
    Checkpoint(String),
    /// `RemoteConflictError(conflicts)`
    Conflict(Vec<String>),
    /// 콜백이 실패했다. TS가 콜백에서 잡은 오류를 그대로 던진다
    Hook,
}

type Res<T> = Result<T, Fail>;

fn fail<T>(message: impl Into<String>) -> Res<T> {
    Err(Fail::Checkpoint(message.into()))
}

macro_rules! g {
    ($($arg:expr),* $(,)?) => { vec![$(String::from($arg)),*] };
}

fn cat(parts: Vec<Vec<String>>) -> Vec<String> {
    parts.into_iter().flatten().collect()
}

/// TS가 기억한 Git 상태(`RememberedGit`). 글자는 모두 `encodeLoneSurrogates`한 꼴이다
#[derive(Debug, Clone)]
pub struct Remembered {
    pub branch: String,
    pub last_checkpoint: String,
    pub origin_url: Option<String>,
}

/// 저장소와 TS가 들고 있는 캐시(`#start`·`#subdirCache`). 캐시는 결과와 함께 돌려줘 TS가 갱신한다(콜드·웜에서 git 호출 순서가 옛 코드와 같다)
pub struct Repo {
    pub root: String,
    pub git_bin: String,
    pub git_dir: Option<String>,
    pub start: Option<String>,
    pub subdir: Option<String>,
    pub hook: Option<Hook>,
}

/// git이 낸 글자를 TS가 보낸 글자와 견줄 수 있게 인코딩한다
fn enc(text: &str) -> String {
    cg::encode_reserved(text)
}

/// git 인자로 넘길 글자(Node가 `execFile`에 넘기던 글자)
fn arg(text: &str) -> String {
    js::well_formed_from_encoded(text)
}

/// JS `text.slice(0, n)`(UTF-16 단위). 인코딩 이스케이프는 단위 하나로 센다
fn units_prefix(text: &str, n: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let (mut at, mut units) = (0, 0);
    while at < chars.len() && units < n {
        if let Some((_, used)) = js::read_lone_escape(&chars, at) {
            out.extend(&chars[at..at + used]);
            at += used;
            units += 1;
        } else {
            out.push(chars[at]);
            units += chars[at].len_utf16();
            at += 1;
        }
    }
    out
}

fn trim(text: &str) -> String {
    js::trim(text).to_owned()
}

fn non_empty(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

/// 원격에 닿거나 다른 프로그램을 불러올 수 있는 git 하위 명령. `remote_git`만 부를 수 있다
fn network_command(args: &[String]) -> bool {
    let Some(sub) = cg::subcommand(args) else { return false };
    match sub.as_str() {
        "fetch" | "push" | "pull" | "ls-remote" | "clone" | "fetch-pack" | "send-pack" | "submodule" | "remote-http" | "remote-https" | "remote-ftp" | "remote-ftps" | "http-fetch" | "http-push"
        | "upload-pack" | "receive-pack" | "daemon" | "imap-send" | "archive" => true,
        // `remote`는 주소를 읽는 `get-url`만 로컬이다(`update`·`add --fetch`·`prune` 등은 원격에 닿는다)
        "remote" => {
            let after = args.iter().skip_while(|a| a.as_str() != "remote").nth(1);
            after.map(String::as_str) != Some("get-url")
        }
        _ => false,
    }
}

fn git_env() -> Vec<(String, String)> {
    git_env_from(std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect())
}

/// `git_env`의 본체. 환경을 인자로 받는다(시험이 가짜 환경으로 돈다)
fn git_env_from(vars: Vec<(String, String)>) -> Vec<(String, String)> {
    let keys: Vec<String> = vars.iter().map(|(k, _)| k.clone()).collect();
    let keep = cg::git_env_keep(&keys);
    let ssh = vars.iter().rev().find(|(k, _)| k == "GIT_SSH_COMMAND").map(|(_, v)| v.clone()).unwrap_or_else(|| "ssh -o BatchMode=yes".to_owned());
    let mut env: Vec<(String, String)> = vars.into_iter().zip(keep).filter(|(_, keep)| *keep).map(|(pair, _)| pair).collect();
    let mut set = |name: &str, value: String| {
        env.retain(|(k, _)| k != name);
        env.push((name.to_owned(), value));
    };
    set("GIT_TERMINAL_PROMPT", "0".into());
    set("GIT_OPTIONAL_LOCKS", "0".into());
    set("GIT_ATTR_NOSYSTEM", "1".into());
    set("GIT_SSH_COMMAND", ssh);
    env
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// JS `new Date(ms).toISOString()`
fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// `toISOString`이 만드는 꼴(`YYYY-MM-DDTHH:mm:ss.sssZ`)만 읽는다. 그 밖은 `None`
fn parse_iso_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() != 24 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'.' || b[23] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = &text[from..to];
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok()).flatten()
    };
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second, milli) = (num(11, 13)?, num(14, 16)?, num(17, 19)?, num(20, 23)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + milli;
    // 날짜가 달력에 없으면(2월 30일) 되돌려 같은 글자가 안 나온다
    (iso_from_ms(ms) == text).then_some(ms)
}

/// 목록을 UTF-16 순서(JS `sort()`)로 정렬한다
fn sort_utf16(mut items: Vec<String>) -> Vec<String> {
    items.sort_by(|a, b| js::cmp_utf16(a, b));
    items
}

/// `JSON.stringify`로 나간 JS 수(NaN은 null)
fn number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        Value::Null
    }
}

impl Repo {
    // ── git 실행 ────────────────────────────────────────────────────────

    /// 로컬 git. 원격에 닿는 하위 명령은 부르지 못한다(`remote_git`만 부른다)
    async fn git(&self, args: Vec<String>) -> Res<String> {
        if network_command(&args) {
            return fail(format!("원격에 닿는 git 명령({})은 신뢰 확인을 지나는 함수로만 부를 수 있습니다", cg::subcommand(&args).unwrap_or_default()));
        }
        self.run_git(args, None).await
    }

    /// 인자 앞에 위치(`-C`·`--git-dir`)와 하드닝을 붙여 실행하고, 인덱스 잠금 충돌이면 다시 한다(옛 `runGit`·`runGitWithRetry`)
    async fn run_git(&self, args: Vec<String>, timeout_ms: Option<u64>) -> Res<String> {
        let mut hardened: Vec<String> = args.iter().map(|a| arg(a)).collect();
        // diff·show의 출력은 리뷰·화면·보관본으로 간다. 저장소 설정의 외부 diff와 textconv가 내용을 바꾸지 못하게 한다(이슈 #706)
        if matches!(hardened.first().map(String::as_str), Some("diff" | "show")) {
            hardened.splice(1..1, ["--no-ext-diff".to_owned(), "--no-textconv".to_owned()]);
        }
        let location: Vec<String> = match &self.git_dir {
            Some(dir) => g!["--git-dir", dir, "--work-tree", &self.root],
            None => Vec::new(),
        };
        let full: Vec<String> = cat(vec![g!["-C", &self.root], location, hardened]);
        let spawned: Vec<String> = cat(vec![GIT_HARDENING.iter().map(|a| (*a).to_owned()).collect(), full.clone()]);
        let env = git_env();
        let mut attempt = 0;
        loop {
            let timeout = timeout_ms;
            let cancel = async move {
                match timeout {
                    Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
                    None => std::future::pending::<()>().await,
                }
            };
            let out = run_command_bytes(&self.git_bin, &spawned, None, Some(&env), None, cancel, GIT_MAX_BUFFER + 1).await;
            let (killed, stderr): (bool, Vec<u8>) = if let Some(spawn) = out.spawn_error.clone() {
                (false, spawn.into_bytes())
            } else if out.stdout.len() > GIT_MAX_BUFFER || out.stderr.len() > GIT_MAX_BUFFER {
                (false, out.stderr.clone())
            } else if out.aborted {
                (true, out.stderr.clone())
            } else if out.exit_code != Some(0) {
                (false, out.stderr.clone())
            } else {
                return Ok(enc(&String::from_utf8_lossy(&out.stdout)));
            };
            let stderr_text = String::from_utf8_lossy(&stderr).into_owned();
            if let Some(delay) = INDEX_LOCK_RETRY_DELAYS_MS.get(attempt) {
                if !killed && cg::is_index_lock_failure(&stderr_text) {
                    tokio::time::sleep(Duration::from_millis(*delay)).await;
                    attempt += 1;
                    continue;
                }
            }
            let command = cg::subcommand(&full).unwrap_or_else(|| "undefined".to_owned());
            let trimmed = cg::redact_credentials(js::trim(&stderr_text));
            return fail(enc(&format!("git {command} 실패{}{}", if killed { " (시간 초과)" } else { "" }, if trimmed.is_empty() { String::new() } else { format!(": {trimmed}") })));
        }
    }

    /// **원격에 닿는 유일한 길.** 닿기 전에 지금 작업 복사본의 Git이 기억한 것과 같은지 먼저 본다(이슈 #699)
    async fn remote_git(&self, remembered: &Remembered, args: Vec<String>, timeout_ms: u64) -> Res<String> {
        self.assert_trusted_git(remembered).await?;
        self.run_git(args, Some(timeout_ms)).await
    }

    // ── 메타·캐시 ───────────────────────────────────────────────────────

    async fn get_meta(&self, key: &str) -> Option<String> {
        self.git(g!["config", "--get", format!("b-studio.{key}")]).await.ok().map(|out| trim(&out)).and_then(non_empty)
    }

    async fn set_meta(&self, key: &str, value: &str) -> Res<()> {
        self.git(g!["config", format!("b-studio.{key}"), value]).await.map(|_| ())
    }

    async fn subdir(&mut self) -> String {
        if self.subdir.is_none() {
            let loaded = self.get_meta("subdir").await.unwrap_or_default();
            self.subdir = Some(loaded);
        }
        self.subdir.clone().unwrap_or_default()
    }

    /// git 명령의 대상을 프로젝트 폴더로 한정한다
    async fn scope(&mut self) -> Vec<String> {
        let subdir = self.subdir().await;
        if subdir.is_empty() { Vec::new() } else { g!["--", subdir] }
    }

    /// diff 계열 출력의 경로를 프로젝트 폴더 기준으로 바꾸고 폴더 밖 변경은 뺀다
    async fn relative(&mut self) -> Vec<String> {
        let subdir = self.subdir().await;
        if subdir.is_empty() { Vec::new() } else { g![format!("--relative={subdir}")] }
    }

    async fn start_sha(&mut self) -> Res<String> {
        if self.start.is_none() {
            let loaded = match self.get_meta("start").await {
                Some(start) => start,
                None => trim(&self.git(g!["rev-list", "--max-parents=0", "HEAD"]).await?).split('\n').next().unwrap_or("").to_owned(),
            };
            self.start = Some(loaded);
        }
        Ok(self.start.clone().unwrap_or_default())
    }

    /// 실패를 거짓으로 읽는다(옛 `#isAncestor`와 같다)
    async fn is_ancestor(&self, ancestor: &str, descendant: &str) -> bool {
        self.git(g!["merge-base", "--is-ancestor", ancestor, descendant]).await.is_ok()
    }

    async fn resolve(&self, sha: &str) -> Res<String> {
        if !cg::is_sha(sha) {
            return fail("체크포인트 ID 형식이 올바르지 않습니다");
        }
        match self.git(g!["rev-parse", "--verify", "--quiet", format!("{sha}^{{commit}}")]).await {
            Ok(out) => Ok(trim(&out)),
            Err(_) => fail("체크포인트를 찾을 수 없습니다"),
        }
    }

    async fn hook(&self, request: Value) -> Res<Value> {
        let hook = self.hook.as_ref().ok_or(Fail::Hook)?;
        // TS가 든 캐시(`#start`·`#subdirCache`)를 콜백이 쓰기 전에 맞춘다(콜백 안의 git 호출 순서가 옛 코드와 같다)
        let mut request = request;
        if let Some(object) = request.as_object_mut() {
            object.insert("start".into(), json!(self.start));
            object.insert("subdir".into(), json!(self.subdir));
        }
        let answer = hook(request.to_string()).await.ok_or(Fail::Hook)?;
        let value: Value = serde_json::from_str(&answer).map_err(|_| Fail::Hook)?;
        if value.get("ok") != Some(&Value::Bool(true)) {
            return Err(Fail::Hook);
        }
        Ok(value)
    }

    /// TS `pendingFiles()`(중첩 저장소 검사 + `git status`)의 개수. TS가 든 순서라 콜백으로 부른다
    async fn pending_count(&self) -> Res<u64> {
        self.hook(json!({ "op": "pendingFiles" })).await?.get("count").and_then(Value::as_u64).ok_or(Fail::Hook)
    }

    // ── 확인 ────────────────────────────────────────────────────────────

    /// 지금 HEAD와 체크아웃된 브랜치. 분리된 HEAD면 branch가 없다(이슈 #699)
    async fn head_state(&self) -> Res<(String, Option<String>)> {
        let head = trim(&self.git(g!["rev-parse", "HEAD"]).await?);
        let branch = self.git(g!["symbolic-ref", "--quiet", "--short", "HEAD"]).await.ok().map(|out| trim(&out)).and_then(non_empty);
        Ok((head, branch))
    }

    async fn remote_url(&self) -> Option<String> {
        self.git(g!["remote", "get-url", "origin"]).await.ok().map(|out| trim(&out)).and_then(non_empty)
    }

    /// 지금 작업 복사본의 Git이 기억한 것과 같은지 본다. 다르면 던진다(올리기·가져오기·PR 전 확인, 이슈 #699)
    pub async fn assert_trusted_git(&self, remembered: &Remembered) -> Res<()> {
        let mut mismatches: Vec<String> = Vec::new();
        let (head, branch) = self.head_state().await?;
        if branch.as_deref() != Some(remembered.branch.as_str()) {
            mismatches.push(match &branch {
                None => format!("지금 HEAD가 브랜치가 아니라 커밋을 가리킵니다(기억한 세션 브랜치: {})", remembered.branch),
                Some(branch) => format!("지금 브랜치({branch})가 기억한 세션 브랜치({})와 다릅니다", remembered.branch),
            });
        }
        if head != remembered.last_checkpoint {
            mismatches.push(format!(
                "지금 HEAD({})가 b-studio가 마지막으로 남긴 체크포인트({})와 다릅니다",
                units_prefix(&head, 7),
                units_prefix(&remembered.last_checkpoint, 7)
            ));
        }
        if let Some(expected) = &remembered.origin_url {
            let origin_url = self.remote_url().await.unwrap_or_default();
            if &origin_url != expected {
                mismatches.push(format!("remote.origin.url이 기억한 주소와 다릅니다(지금: {})", if origin_url.is_empty() { "없음" } else { &origin_url }));
            }
        }
        mismatches.extend(self.dangerous_local_config().await?);
        if !mismatches.is_empty() {
            return fail(format!("작업 복사본의 Git 설정이 b-studio가 기억한 것과 달라 멈췄습니다:\n- {}\n사람이 직접 고친 것이면 되돌린 뒤 다시 시도하세요.", mismatches.join("\n- ")));
        }
        Ok(())
    }

    /// 저장소 설정에 원격 주소를 바꾸거나 자격 증명을 가로채거나 git이 프로그램을 부르게 하는 값이 있으면 그 설명들(이슈 #699·#706).
    /// 읽지 못하면 빈 목록이 아니라 던진다 — 확인하지 못한 것을 "위험한 값이 없다"로 보면 안 된다
    async fn dangerous_local_config(&self) -> Res<Vec<String>> {
        let output = self.git(g!["config", "--list", "--includes", "--show-scope", "--show-origin", "-z"]).await?;
        match cg::dangerous_local_config(&output, self.git_dir.is_some()) {
            Some(found) => Ok(found),
            None => fail("저장소 설정을 읽었지만 형식을 알아보지 못해 확인하지 못했습니다"),
        }
    }

    /// `.git/info/attributes`에 적힌 속성(이슈 #706). 읽지 못하면 던진다
    async fn info_attributes(&self) -> Res<Vec<String>> {
        let located = trim(&self.git(g!["rev-parse", "--git-path", "info/attributes"]).await?);
        let file = node_path::resolve(&self.root, &[&located]);
        let text = match tokio::fs::read(&file).await {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return fail(enc(&format!(".git/info/attributes를 읽지 못해 확인하지 못했습니다: {}", node_error_message(&error, &file)))),
        };
        Ok(cg::info_attributes(&text))
    }

    /// add·hash-object·commit·archive처럼 저장소 설정에 따라 프로그램을 부르거나 내용을 바꾸는 명령 앞에서 본다(이슈 #706)
    pub async fn assert_safe_local_git(&self) -> Res<()> {
        let mut found = self.dangerous_local_config().await?;
        found.extend(self.info_attributes().await?);
        if !found.is_empty() {
            return fail(format!("작업 복사본의 Git 설정이 b-studio가 커밋하거나 내보내는 내용을 바꿀 수 있어 멈췄습니다:\n- {}\n사람이 직접 고친 것이면 되돌린 뒤 다시 시도하세요.", found.join("\n- ")));
        }
        Ok(())
    }

    // ── 읽기 ────────────────────────────────────────────────────────────

    /// 원본 Git 저장소에서 시작한 세션만 원격 정보가 있다
    pub async fn repository(&mut self) -> Res<Value> {
        let base = self.get_meta("base").await;
        let branch = self.get_meta("branch").await;
        let (Some(base), Some(branch)) = (base, branch) else { return Ok(Value::Null) };
        let remote_url = trim(&self.git(g!["remote", "get-url", "origin"]).await?);
        let subdir = self.subdir().await;
        let mut info = Map::new();
        info.insert("remoteUrl".into(), json!(remote_url));
        info.insert("base".into(), json!(base));
        info.insert("branch".into(), json!(branch));
        if !subdir.is_empty() {
            info.insert("subdir".into(), json!(subdir));
        }
        for (key, meta) in [("pushedSha", "pushed"), ("remoteSha", "remote"), ("pullRequestUrl", "pullrequest"), ("pullRequestBase", "pullrequestBase")] {
            if let Some(value) = self.get_meta(meta).await {
                info.insert(key.into(), json!(value));
            }
        }
        Ok(Value::Object(info))
    }

    pub async fn head_state_value(&self) -> Res<Value> {
        let (head, branch) = self.head_state().await?;
        let mut state = Map::new();
        state.insert("head".into(), json!(head));
        if let Some(branch) = branch {
            state.insert("branch".into(), json!(branch));
        }
        Ok(Value::Object(state))
    }

    pub async fn remote_url_value(&self) -> Value {
        self.remote_url().await.map_or(Value::Null, |url| json!(url))
    }

    /// 지금 HEAD가 체크포인트 sha보다 앞서 있을 때 그 뒤의 커밋을 풀어 변경으로 되돌린다(`reset --soft`, 이슈 #699). 푼 커밋 수를 돌려준다
    pub async fn uncommit_to(&self, sha: &str) -> Res<Value> {
        let resolved = self.resolve(sha).await?;
        let count = js::to_number(&self.git(g!["rev-list", "--count", format!("{resolved}..HEAD")]).await?);
        if count == 0.0 {
            return Ok(json!(0));
        }
        self.git(g!["reset", "--soft", &resolved]).await?;
        Ok(number(count))
    }

    pub async fn record_pull_request(&self, url: &str) -> Res<Value> {
        self.set_meta("pullrequest", url).await?;
        Ok(Value::Null)
    }

    // ── 원격 ────────────────────────────────────────────────────────────

    /// PR을 어느 원격 브랜치로 열지 원격에 물어 정한다
    pub async fn pull_request_target(&mut self, remembered: &Remembered) -> Res<Value> {
        let info = self.repository().await?;
        let Some(base) = info.get("base").and_then(Value::as_str).map(str::to_owned) else { return fail("원격 저장소와 연결되지 않은 세션입니다") };
        let base_ref = format!("refs/heads/{base}");
        let listed = self.remote_git(remembered, g!["ls-remote", "--symref", "origin", "HEAD", &base_ref], PUSH_TIMEOUT_MS).await?;
        let target = cg::pull_request_target(&listed, &base_ref, &base);
        let resolved = target.prop("base").and_then(JsValue::as_str).unwrap_or_default().to_owned();
        self.set_meta("pullrequestBase", &resolved).await?;
        Ok(serde_json::from_str(&js_json::stringify(&target)).unwrap_or(Value::Null))
    }

    /// 세션 브랜치를 원격으로 올린다. 브랜치·원격 주소·HEAD를 바꿨으면 멈춘다. 올릴 브랜치는 config(`b-studio.branch`)가 아니라 기억한 값에서 읽는다
    pub async fn push(&mut self, remembered: &Remembered) -> Res<Value> {
        let info = self.repository().await?;
        if info.is_null() {
            return fail("원격 저장소와 연결되지 않은 세션입니다");
        }
        if self.pending_count().await? > 0 {
            return fail("체크포인트로 저장하지 않은 변경이 있어 올릴 수 없습니다");
        }
        let branch = remembered.branch.clone();
        let head = trim(&self.git(g!["rev-parse", "HEAD"]).await?);
        let start = self.start_sha().await?;
        let commits = js::to_number(&self.git(g!["rev-list", "--count", "--first-parent", format!("{start}..HEAD")]).await?);
        if commits == 0.0 {
            return fail("올릴 체크포인트가 없습니다. 요청이 검증 게이트를 통과하면 체크포인트가 생깁니다");
        }
        let reference = format!("refs/heads/{branch}");
        // 한 번도 올리거나 가져오지 않았으면 빈 값: 원격에 같은 이름의 브랜치가 없어야 한다
        let expected = info.get("remoteSha").or_else(|| info.get("pushedSha")).and_then(Value::as_str).unwrap_or("").to_owned();
        let pushed = self.remote_git(remembered, g!["push", format!("--force-with-lease={reference}:{expected}"), "origin", format!("HEAD:{reference}")], PUSH_TIMEOUT_MS).await;
        if let Err(Fail::Checkpoint(message)) = &pushed {
            if message.contains("stale info") {
                return fail(format!("원격의 {branch} 브랜치가 스튜디오가 마지막으로 확인한 상태와 달라 덮어쓰지 않았습니다. 다른 사람이 올린 커밋이면 원격 변경을 가져온 뒤 다시 올리세요."));
            }
        }
        pushed?;
        let forced = !expected.is_empty() && !self.is_ancestor(&expected, &head).await;
        self.set_meta("pushed", &head).await?;
        self.set_meta("remote", &head).await?;
        Ok(json!({ "sha": head, "commits": number(commits), "forced": forced }))
    }

    async fn remote_commits(&self, from: &str, remote: &str) -> Res<Vec<Value>> {
        let out = self.git(g!["log", "--reverse", "--format=%H%x00%h%x00%s%x00%an%x1e", format!("{from}..{remote}")]).await?;
        Ok(cg::remote_commits(&out).into_iter().map(|[sha, short_sha, subject, author]| json!({ "sha": sha, "shortSha": short_sha, "subject": subject, "author": author })).collect())
    }

    /// 병합·체리픽이 실패했을 때: 충돌한 파일을 읽고, 중단하고, 가져오기 전(`head`)으로 되돌린다. 충돌이 있으면 `Conflict`, 없으면 원래 오류를 그대로 던진다
    async fn undo_failed_merge(&mut self, error: Fail, abort: &str, head: &str) -> Res<Value> {
        let relative = self.relative().await;
        let conflicts = cg::split_nul(&self.git(cat(vec![g!["diff", "--name-only", "-z", "--diff-filter=U"], relative])).await?);
        let conflicts = sort_utf16(conflicts);
        let _ = self.git(g![abort, "--abort"]).await;
        self.git(g!["reset", "-q", "--hard", head]).await?;
        let scope = self.scope().await;
        self.git(cat(vec![g!["clean", "-q", "-fd"], scope])).await?;
        if !conflicts.is_empty() {
            return Err(Fail::Conflict(conflicts));
        }
        Err(error)
    }

    async fn commit_merged(&mut self, subject: &str, commits: &[Value]) -> Res<()> {
        let body = commits
            .iter()
            .map(|c| format!("- {} {} ({})", c["shortSha"].as_str().unwrap_or(""), c["subject"].as_str().unwrap_or(""), c["author"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join("\n");
        let mut args = g!["commit", "-q", "--allow-empty", "--cleanup=whitespace", "-m", subject];
        if !body.is_empty() {
            args.extend(g!["-m", cg::cap_text(&body, cg::MAX_BODY_CHARS)]);
        }
        self.git(args).await.map(|_| ())
    }

    async fn changed_files(&mut self, head: &str) -> Res<Vec<String>> {
        let relative = self.relative().await;
        let out = self.git(cat(vec![g!["diff", "--name-only", "-z"], relative, g![head, "HEAD"]])).await?;
        Ok(sort_utf16(cg::split_nul(&out)))
    }

    /// 원격 세션 브랜치에 다른 사람이 올린 커밋을 가져온다. 병합 커밋 하나로 가져오고, 충돌하면 가져오기 전 그대로 두고 충돌한 파일을 알린다.
    /// 결과의 체크포인트(`#checkpoint('HEAD')`)와 제외 스냅샷 물려주기는 TS가 이어서 한다
    pub async fn integrate_remote(&mut self, remembered: &Remembered) -> Res<Value> {
        let info = self.repository().await?;
        if info.is_null() {
            return fail("원격 저장소와 연결되지 않은 세션입니다");
        }
        if self.pending_count().await? > 0 {
            return fail("체크포인트로 저장하지 않은 변경이 있어 원격 변경을 가져올 수 없습니다");
        }
        let branch = remembered.branch.clone();
        let head = trim(&self.git(g!["rev-parse", "HEAD"]).await?);
        let reference = format!("refs/heads/{branch}");
        let listed = trim(&self.remote_git(remembered, g!["ls-remote", "--heads", "origin", &reference], PUSH_TIMEOUT_MS).await?);
        if listed.is_empty() {
            return Ok(json!({ "status": "up-to-date", "commits": [], "files": [], "previous": head }));
        }

        self.remote_git(remembered, g!["fetch", "--quiet", "--no-tags", "origin", format!("+{reference}:{REMOTE_REF}")], PUSH_TIMEOUT_MS).await?;
        let remote = trim(&self.git(g!["rev-parse", REMOTE_REF]).await?);
        let start = self.start_sha().await?;
        if !self.is_ancestor(&start, &remote).await {
            return fail(format!("원격의 {branch} 브랜치가 이 세션의 시작 커밋을 포함하지 않아 가져오지 않았습니다"));
        }
        if self.is_ancestor(&remote, &head).await {
            // 지금 기록이 원격을 모두 담고 있으므로 원격 상태로 기록해도 덮어쓸 커밋이 없다
            self.set_meta("remote", &remote).await?;
            return Ok(json!({ "status": "up-to-date", "remoteSha": remote, "commits": [], "files": [], "previous": head }));
        }

        // 원격에만 있는 커밋의 시작점: 마지막으로 확인한 원격 상태가 원격 기록에 남아 있으면 그곳, 아니면 두 기록이 갈라진 곳
        let known = info.get("remoteSha").or_else(|| info.get("pushedSha")).and_then(Value::as_str).map(str::to_owned);
        let from = match known {
            Some(known) if !known.is_empty() && self.is_ancestor(&known, &remote).await => known,
            _ => trim(&self.git(g!["merge-base", &head, &remote]).await?),
        };
        let commits = self.remote_commits(&from, &remote).await?;
        let picked = !self.is_ancestor(&from, &head).await;
        if picked && !trim(&self.git(g!["rev-list", "--merges", format!("{from}..{remote}")]).await?).is_empty() {
            return fail("원격에만 있는 커밋에 병합 커밋이 있어 옮겨 오지 못했습니다. PR에서 기록을 정리한 뒤 다시 가져오세요");
        }

        let merge = if picked { g!["cherry-pick", "--no-commit", format!("{from}..{remote}")] } else { g!["merge", "--no-ff", "--no-commit", &remote] };
        if let Err(error) = self.git(merge).await {
            return self.undo_failed_merge(error, if picked { "cherry-pick" } else { "merge" }, &head).await;
        }
        self.commit_merged(&format!("원격 커밋 {}개 가져오기", commits.len()), &commits).await?;
        // 모노레포에서는 프로젝트 밖 변경도 함께 들어오지만, 게이트가 확인할 파일은 프로젝트 폴더 안의 것뿐이다
        let files = self.changed_files(&head).await?;
        Ok(json!({ "status": if picked { "picked" } else { "merged" }, "remoteSha": remote, "commits": commits, "files": files, "previous": head }))
    }

    /// 가져온 변경이 검증을 통과했을 때 원격 상태로 기록한다. 가져온 체크포인트가 지금 기록에 없으면(되돌렸으면) 기록하지 않는다
    pub async fn accept_remote(&self, remote_sha: Option<&str>, checkpoint: Option<&str>) -> Res<Value> {
        let (Some(remote_sha), Some(checkpoint)) = (remote_sha.filter(|s| !s.is_empty()), checkpoint.filter(|s| !s.is_empty())) else { return Ok(Value::Null) };
        if !self.is_ancestor(checkpoint, "HEAD").await {
            return fail("가져온 체크포인트가 지금 기록에 없어 원격 상태로 기록하지 않았습니다");
        }
        self.set_meta("remote", remote_sha).await?;
        Ok(Value::Null)
    }

    async fn fetch_base(&self, remembered: &Remembered, base: &str) -> Res<()> {
        self.remote_git(remembered, g!["fetch", "--quiet", "--no-tags", "origin", format!("+refs/heads/{base}:{BASE_REF}")], PUSH_TIMEOUT_MS).await?;
        self.set_meta("baseFetchedAt", &iso_from_ms(now_ms())).await
    }

    /// 기준 브랜치(main 따라잡기, ADR-076)가 이 세션보다 얼마나 앞서 있는지 가볍게 확인한다. 마지막으로 가져온 지 1분 안이면 새로 가져오지 않고 받아 둔 상태로 센다
    pub async fn base_status(&mut self, remembered: &Remembered, force: bool) -> Res<Value> {
        let info = self.repository().await?;
        let Some(base) = info.get("base").and_then(Value::as_str).map(str::to_owned) else { return fail("원본 저장소와 연결되지 않은 세션입니다") };
        let last_fetched_at = self.get_meta("baseFetchedAt").await;
        // HARDENED: 읽지 못하는 값은 오래된 것으로 본다(옛 JS는 NaN이 "오래되지 않음"이라 영영 가져오지 않았다)
        let stale = force || last_fetched_at.as_deref().and_then(parse_iso_ms).map_or(true, |at| now_ms() - at >= BASE_FETCH_THROTTLE_MS);
        if stale {
            self.fetch_base(remembered, &base).await?;
        }
        let fetched_at = self.get_meta("baseFetchedAt").await.unwrap_or_else(|| iso_from_ms(now_ms()));
        let base_sha = self.git(g!["rev-parse", "--verify", "--quiet", BASE_REF]).await.ok().map(|out| trim(&out));
        let Some(base_sha) = base_sha.filter(|sha| !sha.is_empty()) else { return Ok(json!({ "base": base, "behind": 0, "lastFetchedAt": fetched_at })) };
        let head = trim(&self.git(g!["rev-parse", "HEAD"]).await?);
        let behind = js::to_number(&self.git(g!["rev-list", "--count", format!("{head}..{base_sha}")]).await?);
        let ahead = js::to_number(&self.git(g!["rev-list", "--count", format!("{base_sha}..{head}")]).await?);
        Ok(json!({ "base": base, "behind": number(behind), "aheadCommits": number(ahead), "lastFetchedAt": fetched_at }))
    }

    /// 세션 브랜치가 갈라져 나온 기준 브랜치(main 등, ADR-076)를 병합으로 따라잡는다. 충돌하면 병합을 시작하기 전 그대로 두고 충돌한 파일을 알린다
    pub async fn integrate_base(&mut self, remembered: &Remembered) -> Res<Value> {
        let info = self.repository().await?;
        let Some(base) = info.get("base").and_then(Value::as_str).map(str::to_owned) else { return fail("원본 저장소와 연결되지 않은 세션입니다") };
        if self.pending_count().await? > 0 {
            return fail("체크포인트로 저장하지 않은 변경이 있어 기준 브랜치를 따라잡을 수 없습니다");
        }
        let head = trim(&self.git(g!["rev-parse", "HEAD"]).await?);
        self.fetch_base(remembered, &base).await?;
        let base_sha = trim(&self.git(g!["rev-parse", BASE_REF]).await?);
        if self.is_ancestor(&base_sha, &head).await {
            return Ok(json!({ "status": "up-to-date", "commits": [], "files": [], "previous": head }));
        }
        let merge_base = trim(&self.git(g!["merge-base", &head, &base_sha]).await?);
        let commits = self.remote_commits(&merge_base, &base_sha).await?;
        if let Err(error) = self.git(g!["merge", "--no-ff", "--no-commit", &base_sha]).await {
            return self.undo_failed_merge(error, "merge", &head).await;
        }
        self.commit_merged(&format!("{} 따라잡는다 ({}커밋)", cg::with_object_particle(&base), commits.len()), &commits).await?;
        // 프로젝트 밖 변경도 함께 들어올 수 있지만(모노레포), 게이트가 확인할 파일은 프로젝트 폴더 안의 것뿐이다
        let files = self.changed_files(&head).await?;
        Ok(json!({ "status": "merged", "remoteSha": base_sha, "commits": commits, "files": files, "previous": head }))
    }

    // ── 되돌리기 ────────────────────────────────────────────────────────

    /// 터미널 실행이 작업 복사본의 Git 기록을 b-studio가 기억한 것과 다르게 만들었을 때 기억한 체크포인트로 되돌린다(이슈 #699).
    /// **지우는 코드다.** 순서(옛 코드 그대로): 체크포인트 확인 → 범위 읽기 → `before`(TS: 제외 스냅샷의 변경 계산) → [HARDENED: 안전 확인] → `add -A` → 바뀐 파일·패치 →
    /// `backup`(TS: 백업 쓰기) → `checkout -f` → `reset --hard` → `clean -fd` → `after`(TS: 제외 스냅샷 되돌리기). 백업 콜백이 실패하면 `checkout`·`reset`·`clean`을 부르지 않는다
    pub async fn restore_remembered_head(&mut self, remembered: &Remembered) -> Res<Value> {
        let checkpoint = self.resolve(&remembered.last_checkpoint).await?;
        let scope = self.scope().await;
        let relative = self.relative().await;
        self.hook(json!({ "op": "beforeRestore" })).await?;
        // HARDENED: `add -A`는 저장소 설정의 clean 필터를 부른다. commit·archive 앞과 같은 확인을 지난다
        self.assert_safe_local_git().await?;
        // 지금 작업 복사본 전체를 인덱스에 올린 뒤 기억한 체크포인트와 견준다. 브랜치를 바꿔 커밋한 경우에도 그 내용이 보관본에 담긴다
        self.git(cat(vec![g!["add", "-A"], scope.clone()])).await?;
        let files = cg::split_nul(&self.git(cat(vec![g!["diff", "--cached", "--name-only", "-z"], relative.clone(), g![&checkpoint]])).await?);
        let patch = if files.is_empty() { String::new() } else { self.git(cat(vec![g!["diff", "--cached", "--no-color"], relative, g![&checkpoint]])).await? };
        // 백업이 먼저다. 실패하면 되돌리지 않는다
        self.hook(json!({ "op": "backup", "files": files, "checkpoint": checkpoint })).await?;
        // 세션 브랜치로 강제로 옮긴 뒤 기억한 체크포인트로 되돌린다. 브랜치가 없어졌으면 그 체크포인트에서 다시 만든다
        if self.git(g!["checkout", "-f", &remembered.branch]).await.is_err() {
            self.git(g!["checkout", "-f", &checkpoint]).await?;
            self.git(g!["checkout", "-B", &remembered.branch]).await?;
        }
        self.git(g!["reset", "-q", "--hard", &checkpoint]).await?;
        self.git(cat(vec![g!["clean", "-q", "-fd"], scope])).await?;
        self.hook(json!({ "op": "afterRestore" })).await?;
        Ok(json!({ "files": files, "patch": cg::cap_text(&patch, MAX_PATCH_CHARS) }))
    }
}

/// Node의 `fs.readFile` 오류 글(`EISDIR: illegal operation on a directory, read` 꼴)과 같게 쓴다
fn node_error_message(error: &std::io::Error, file: &str) -> String {
    let (code, text) = match error.raw_os_error() {
        Some(21) => ("EISDIR", "illegal operation on a directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(20) => ("ENOTDIR", "not a directory"),
        Some(40) | Some(62) => ("ELOOP", "too many symbolic links encountered"),
        _ => return error.to_string(),
    };
    if code == "EISDIR" { format!("{code}: {text}, read") } else { format!("{code}: {text}, open '{file}'") }
}

fn str_field(input: &Value, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn remembered(input: &Value) -> Option<Remembered> {
    let value = input.get("remembered")?;
    Some(Remembered { branch: str_field(value, "branch")?, last_checkpoint: str_field(value, "lastCheckpoint")?, origin_url: str_field(value, "originUrl") })
}

/// napi가 부르는 한 입구. `op`에 따라 위 함수를 부르고 결과를 JSON으로 돌려준다.
/// 입력: `{ root, gitBin, gitDir?, start?, subdir?, remembered?, ... }`. 출력: `{ ok, value | kind·message·conflicts, cache: { start, subdir } }`
pub async fn run(op: &str, input: &str, hook: Option<Hook>) -> String {
    let Ok(input) = serde_json::from_str::<Value>(input) else {
        return json!({ "ok": false, "kind": "checkpoint", "message": "원격 경로 입력을 읽지 못했습니다", "cache": {} }).to_string();
    };
    let (Some(root), Some(git_bin)) = (str_field(&input, "root"), str_field(&input, "gitBin")) else {
        return json!({ "ok": false, "kind": "checkpoint", "message": "원격 경로 입력에 root·gitBin이 없습니다", "cache": {} }).to_string();
    };
    let mut repo = Repo { root, git_bin, git_dir: str_field(&input, "gitDir"), start: str_field(&input, "start"), subdir: str_field(&input, "subdir"), hook };
    let remembered = remembered(&input);
    let result = dispatch(&mut repo, op, &input, remembered.as_ref()).await;
    let mut out = Map::new();
    match result {
        Ok(value) => {
            out.insert("ok".into(), json!(true));
            out.insert("value".into(), value);
        }
        Err(Fail::Checkpoint(message)) => {
            out.insert("ok".into(), json!(false));
            out.insert("kind".into(), json!("checkpoint"));
            out.insert("message".into(), json!(message));
        }
        Err(Fail::Conflict(conflicts)) => {
            out.insert("ok".into(), json!(false));
            out.insert("kind".into(), json!("conflict"));
            out.insert("conflicts".into(), json!(conflicts));
        }
        Err(Fail::Hook) => {
            out.insert("ok".into(), json!(false));
            out.insert("kind".into(), json!("hook"));
        }
    }
    out.insert("cache".into(), json!({ "start": repo.start, "subdir": repo.subdir }));
    Value::Object(out).to_string()
}

async fn dispatch(repo: &mut Repo, op: &str, input: &Value, remembered: Option<&Remembered>) -> Res<Value> {
    // 기억한 Git 상태가 필요한 연산은 없으면 멈춘다(확인하지 못한 상태를 통과로 두지 않는다)
    let need = || remembered.ok_or_else(|| Fail::Checkpoint("기억한 Git 상태가 없어 확인하지 못했습니다".to_owned()));
    match op {
        "repository" => repo.repository().await,
        "headState" => repo.head_state_value().await,
        "remoteUrl" => Ok(repo.remote_url_value().await),
        "uncommitTo" => repo.uncommit_to(&str_field(input, "sha").unwrap_or_default()).await,
        "recordPullRequest" => repo.record_pull_request(&str_field(input, "url").unwrap_or_default()).await,
        "assertTrustedGit" => repo.assert_trusted_git(need()?).await.map(|()| Value::Null),
        "assertSafeLocalGit" => repo.assert_safe_local_git().await.map(|()| Value::Null),
        "pullRequestTarget" => repo.pull_request_target(need()?).await,
        "push" => repo.push(need()?).await,
        "integrateRemote" => repo.integrate_remote(need()?).await,
        "acceptRemote" => repo.accept_remote(str_field(input, "remoteSha").as_deref(), str_field(input, "checkpoint").as_deref()).await,
        "baseStatus" => repo.base_status(need()?, input.get("force").and_then(Value::as_bool).unwrap_or(false)).await,
        "integrateBase" => repo.integrate_base(need()?).await,
        "restoreRememberedHead" => repo.restore_remembered_head(need()?).await,
        other => fail(format!("알 수 없는 원격 경로 연산입니다: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@e"]).args(args).output().expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// 인자를 로그에 적고 실제 git을 부르는 껍데기. `body`는 그 앞에 끼워 넣는 셸 조각
    fn spy(_repo: &Path, body: &str) -> (String, std::path::PathBuf) {
        // 저장소 밖에 둔다(`clean`이 저장소 안의 추적되지 않은 파일을 지운다)
        let dir = tempfile::tempdir().unwrap().keep();
        let log = dir.join("calls.log");
        let file = dir.join("git-spy.sh");
        std::fs::write(&file, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n{body}exec git \"$@\"\n", log.display())).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        (file.to_string_lossy().into_owned(), log)
    }

    fn repo(dir: &Path, git_bin: &str, hook: Option<Hook>) -> Repo {
        Repo { root: dir.to_string_lossy().into_owned(), git_bin: git_bin.to_owned(), git_dir: None, start: None, subdir: None, hook }
    }

    fn init(dir: &Path) {
        sh(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        sh(dir, &["add", "-A"]);
        sh(dir, &["commit", "-q", "-m", "init"]);
    }

    fn hook_with(answer: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Hook {
        Arc::new(move |request: String| {
            let reply = answer(&request);
            Box::pin(async move { reply })
        })
    }

    #[tokio::test]
    async fn 원격에_닿는_명령은_신뢰_확인_함수_밖에서_부를_수_없다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let (bin, log) = spy(dir.path(), "");
        let repo = repo(dir.path(), &bin, None);
        for args in [g!["fetch", "origin"], g!["push", "origin"], g!["ls-remote", "origin"], g!["remote", "update"], g!["pull"], g!["clone", "x", "y"]] {
            let result = repo.git(args.clone()).await;
            assert!(matches!(&result, Err(Fail::Checkpoint(message)) if message.contains("신뢰 확인")), "{args:?}: {result:?}");
        }
        // 부르지 않았다(껍데기가 아무것도 적지 않았다)
        assert!(!log.exists());
        // 주소를 읽는 `remote get-url`은 로컬이다
        assert!(!network_command(&g!["remote", "get-url", "origin"]));
        assert!(network_command(&g!["-C", "/x", "-c", "a=b", "fetch"]));
    }

    #[tokio::test]
    async fn 저장소_설정을_읽지_못하면_원격_명령을_띄우지_않는다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let head = String::from_utf8(std::process::Command::new("git").arg("-C").arg(dir.path()).args(["rev-parse", "HEAD"]).output().unwrap().stdout).unwrap();
        let (bin, log) = spy(dir.path(), "case \"$*\" in *\"config --list\"*) echo bad >&2; exit 1;; esac\n");
        let repo = repo(dir.path(), &bin, None);
        let remembered = Remembered { branch: "main".into(), last_checkpoint: head.trim().into(), origin_url: None };
        let result = repo.remote_git(&remembered, g!["fetch", "origin"], 5_000).await;
        assert!(matches!(result, Err(Fail::Checkpoint(_))));
        let calls = std::fs::read_to_string(log).unwrap();
        assert!(!calls.contains(" fetch "), "{calls}");
    }

    #[tokio::test]
    async fn 신뢰_확인은_브랜치와_head와_위험한_설정을_모두_모아_알린다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        sh(dir.path(), &["config", "credential.helper", "!x"]);
        let (bin, _) = spy(dir.path(), "");
        let repo = repo(dir.path(), &bin, None);
        let remembered = Remembered { branch: "other".into(), last_checkpoint: "f".repeat(40), origin_url: None };
        let Err(Fail::Checkpoint(message)) = repo.assert_trusted_git(&remembered).await else { panic!("통과하면 안 된다") };
        assert!(message.contains("기억한 세션 브랜치(other)와 다릅니다"), "{message}");
        assert!(message.contains("마지막으로 남긴 체크포인트(fffffff)"), "{message}");
        assert!(message.contains("credential.helper"), "{message}");
    }

    #[tokio::test]
    async fn 백업_콜백이_실패하면_checkout_reset_clean을_부르지_않는다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let checkpoint = String::from_utf8(std::process::Command::new("git").arg("-C").arg(dir.path()).args(["rev-parse", "HEAD"]).output().unwrap().stdout).unwrap().trim().to_owned();
        std::fs::write(dir.path().join("a.txt"), "dirty\n").unwrap();
        std::fs::write(dir.path().join("stray.txt"), "stray\n").unwrap();
        let (bin, log) = spy(dir.path(), "");
        // 백업만 실패한다
        let hook = hook_with(|request| if request.contains("\"backup\"") { None } else { Some("{\"ok\":true}".into()) });
        let mut repo = repo(dir.path(), &bin, Some(hook));
        let remembered = Remembered { branch: "main".into(), last_checkpoint: checkpoint, origin_url: None };
        assert_eq!(repo.restore_remembered_head(&remembered).await, Err(Fail::Hook));
        let calls = std::fs::read_to_string(log).unwrap();
        for forbidden in [" checkout ", " reset ", " clean "] {
            assert!(!calls.contains(forbidden), "{forbidden}: {calls}");
        }
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "dirty\n");
        assert!(dir.path().join("stray.txt").exists());
    }

    #[tokio::test]
    async fn 되돌리기는_백업_뒤에_checkout_reset_clean_순서로_범위를_붙여_부른다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let checkpoint = String::from_utf8(std::process::Command::new("git").arg("-C").arg(dir.path()).args(["rev-parse", "HEAD"]).output().unwrap().stdout).unwrap().trim().to_owned();
        std::fs::write(dir.path().join("a.txt"), "dirty\n").unwrap();
        std::fs::write(dir.path().join("stray.txt"), "stray\n").unwrap();
        let (bin, log) = spy(dir.path(), "");
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen_in_hook = seen.clone();
        let log_in_hook = log.clone();
        let hook = hook_with(move |request| {
            // 백업 콜백이 불리는 순간까지 부른 git에 checkout·reset·clean이 없어야 한다
            if request.contains("\"backup\"") {
                let calls = std::fs::read_to_string(&log_in_hook).unwrap_or_default();
                seen_in_hook.lock().unwrap().push(calls);
            }
            Some("{\"ok\":true}".into())
        });
        let mut repo = repo(dir.path(), &bin, Some(hook));
        repo.subdir = Some(String::new());
        let remembered = Remembered { branch: "main".into(), last_checkpoint: checkpoint, origin_url: None };
        let done = repo.restore_remembered_head(&remembered).await.expect("되돌리기");
        assert_eq!(done["files"], json!(["a.txt", "stray.txt"]));
        let before_backup = seen.lock().unwrap()[0].clone();
        assert!(before_backup.contains(" add -A") && before_backup.contains("--cached --no-color"), "{before_backup}");
        for forbidden in [" checkout ", " reset ", " clean "] {
            assert!(!before_backup.contains(forbidden), "{forbidden}: {before_backup}");
        }
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "a\n");
        assert!(!dir.path().join("stray.txt").exists());
        let calls = std::fs::read_to_string(log).unwrap();
        let order: Vec<usize> = ["checkout -f main", "reset -q --hard", "clean -q -fd"].iter().map(|c| calls.find(c).unwrap_or_else(|| panic!("{c} 없음: {calls}"))).collect();
        assert!(order[0] < order[1] && order[1] < order[2], "{calls}");
    }

    #[tokio::test]
    async fn 되돌리기는_저장소_설정에_clean_필터가_있으면_add_앞에서_멈춘다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        let checkpoint = String::from_utf8(std::process::Command::new("git").arg("-C").arg(dir.path()).args(["rev-parse", "HEAD"]).output().unwrap().stdout).unwrap().trim().to_owned();
        sh(dir.path(), &["config", "filter.evil.clean", "cat"]);
        let (bin, log) = spy(dir.path(), "");
        let mut repo = repo(dir.path(), &bin, Some(hook_with(|_| Some("{\"ok\":true}".into()))));
        let remembered = Remembered { branch: "main".into(), last_checkpoint: checkpoint, origin_url: None };
        let Err(Fail::Checkpoint(message)) = repo.restore_remembered_head(&remembered).await else { panic!("멈춰야 한다") };
        assert!(message.contains("filter.evil.clean"), "{message}");
        assert!(!std::fs::read_to_string(log).unwrap().contains(" add "));
    }

    #[tokio::test]
    async fn info_attributes를_읽지_못하면_오류다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        std::fs::create_dir(dir.path().join(".git/info")).ok();
        std::fs::create_dir(dir.path().join(".git/info/attributes")).unwrap();
        let (bin, _) = spy(dir.path(), "");
        let repo = repo(dir.path(), &bin, None);
        let Err(Fail::Checkpoint(message)) = repo.assert_safe_local_git().await else { panic!("오류여야 한다") };
        assert!(message.contains(".git/info/attributes를 읽지 못해 확인하지 못했습니다: EISDIR"), "{message}");
    }

    #[test]
    fn 시각은_toisostring_꼴로_쓰고_우리가_쓴_꼴만_읽는다() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_782_000_123_456), "2026-06-21T00:02:03.456Z");
        for ms in [0, 951_782_400_000, 1_782_000_123_456, 4_102_444_800_999] {
            assert_eq!(parse_iso_ms(&iso_from_ms(ms)), Some(ms));
        }
        for text in ["garbage", "", "2026-02-30T00:00:00.000Z", "2026-06-21T00:42:03Z", "2026-06-21 00:42:03.456Z", "2026-13-01T00:00:00.000Z"] {
            assert_eq!(parse_iso_ms(text), None, "{text}");
        }
    }

    #[test]
    fn 글자는_앞_일곱_단위만_자르고_예약_글자는_단사로_넘긴다() {
        assert_eq!(units_prefix("0123456789", 7), "0123456");
        // 짝 없는 서로게이트 이스케이프(U+E010 + 니블 셋)는 단위 하나다
        let lone = "\u{E010}\u{E00D}\u{E008}\u{E000}abcdefghij";
        assert_eq!(units_prefix(lone, 3), "\u{E010}\u{E00D}\u{E008}\u{E000}ab");
        assert_eq!(arg("\u{E010}\u{E00D}\u{E008}\u{E000}x"), "\u{FFFD}x");
        assert_eq!(arg(&enc("\u{E005}")), "\u{E005}");
    }

    #[test]
    fn git_환경은_통과_목록_밖의_git_변수를_빼고_입력을_기다리지_않게_한다() {
        let env = git_env_from(vec![
            ("GIT_INDEX_FILE".into(), "/evil/index".into()),
            ("GIT_CONFIG_PARAMETERS".into(), "'core.x=y'".into()),
            ("GIT_AUTHOR_NAME".into(), "keep".into()),
            ("PATH".into(), "/usr/bin".into()),
        ]);
        let has = |name: &str| env.iter().any(|(k, _)| k == name);
        assert!(!has("GIT_INDEX_FILE") && !has("GIT_CONFIG_PARAMETERS") && has("PATH"));
        assert_eq!(env.iter().find(|(k, _)| k == "GIT_AUTHOR_NAME").map(|(_, v)| v.as_str()), Some("keep"));
        for (name, value) in [("GIT_TERMINAL_PROMPT", "0"), ("GIT_OPTIONAL_LOCKS", "0"), ("GIT_ATTR_NOSYSTEM", "1")] {
            assert_eq!(env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str()), Some(value), "{name}");
        }
    }

    #[tokio::test]
    async fn 시간을_넘기면_시간_초과로_알리고_인덱스_잠금_실패는_다시_한다() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        // 시간 초과: 느린 git
        let (slow, _) = spy(dir.path(), "case \"$*\" in *rev-parse*) sleep 5;; esac\n");
        let repo_slow = repo(dir.path(), &slow, None);
        let Err(Fail::Checkpoint(message)) = repo_slow.run_git(g!["rev-parse", "HEAD"], Some(300)).await else { panic!("시간 초과여야 한다") };
        assert!(message.starts_with("git rev-parse 실패 (시간 초과)"), "{message}");
        // 잠금 실패: 처음 한 번만 실패하고 다시 하면 된다
        let flag = tempfile::tempdir().unwrap().keep().join("lock-flag");
        let body = format!("if [ ! -e '{0}' ]; then : > '{0}'; echo \"fatal: Unable to create '/x/.git/index.lock': File exists.\" >&2; exit 128; fi\n", flag.display());
        let (flaky, log) = spy(dir.path(), &body);
        let repo_flaky = repo(dir.path(), &flaky, None);
        assert!(repo_flaky.git(g!["rev-parse", "HEAD"]).await.is_ok());
        assert_eq!(std::fs::read_to_string(log).unwrap().lines().count(), 2);
    }
}
