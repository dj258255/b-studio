//! 체크포인트가 읽는 git 출력의 순수 판정(ADR-191 3단계 3s). git을 부르는 일과 파일 읽기는 TS에 남고, 이 모듈은 문자열만 본다
//! (옛 TS: `packages/agent/src/checkpoints.ts`).
//!
//! 막는 쪽인지 여는 쪽인지(호출부마다):
//! - `dangerous_local_config`: 막는 쪽(커밋·내보내기를 멈춘다). 거부 목록이라 넓게 맞춘다. 옛 정규식의 `.`은 `\r`·U+2028·U+2029를 맞추지 못해
//!   키의 가운데에 그 글자가 들어 있으면 빠져나갔다(의도한 차이: 이제 막는다). `core.worktree` 예외(여는 쪽)는 키 전체가 ASCII 대소문자만 무시하고 같을 때만 쓴다.
//!   `disabled` 값 읽기는 옛 TS 그대로 JS `trim` + ASCII 대소문자 무시이다.
//! - `info_attributes`: 막는 쪽. 옛 TS는 줄을 JS `trim`(NBSP·BOM·`\v`·`\f` 포함)으로 다듬어 주석을 가렸지만 git은 ` \t\r\n`만 건너뛰고 첫 글자가 `#`인지 본다
//!   (attr.c의 `blank`). 그래서 `\u00a0# * export-ignore` 같은 줄은 옛 코드에 주석, git에는 속성 줄이었다(의도한 차이: git이 읽는 규칙으로 읽는다).
//! - `staged_mismatch`: 막는 쪽(불일치면 커밋 중단). 비교하는 두 경로의 짝 없는 서로게이트가 경계에서 U+FFFD로 합쳐지면 다른 두 경로가 같아져 불일치를 놓친다
//!   (여는 쪽). TS가 기대값 쪽을 `encodeLoneSurrogates`(단사)로 바꿔 보내고, 여기서 git 쪽 경로의 예약 글자(U+E000..U+E01F)를 같은 규칙으로 막는다(`encode_reserved`).
//! - `author_is_ours`: 여는 쪽(참이면 트레일러를 통과 기록으로 믿는다). 같은 이유로 양쪽을 단사 변환해서 견준다.
//! - `git_env_keep`: 막는 쪽(GIT_* 차단). 키의 위치(인덱스)로 답해 U+FFFD로 합쳐진 키가 지워지지 않고 남는 일이 없다.
//! - `is_sha`·`is_backup_id`: 허용 목록(여는 쪽). ASCII 16진·영숫자 밖의 글자는 서로게이트 합쳐짐과 관계없이 모두 거부다.
//! - `is_dot_git`: 막는 쪽. ASCII 대소문자 무시(`.GIT`). 짝 없는 서로게이트가 든 이름은 어느 쪽에서도 `.git`이 아니다.
//! - 나머지(`status`·`numstat`·레코드 분리, 글자 다듬기, 자격 증명 가림, 잠금 실패 판정)는 git이 낸 문자열(유효한 UTF-8을 읽은 것)만 받는다.
//!
//! JS와 같게 읽는 곳: UTF-16 코드 단위로 자르는 자리(`entry.slice(3)`, `slice(0, 120)`, `slice(0, max)`, `slice(-1)`), `trim`·`\s`는 JS 공백 집합(`js`),
//! `Number(문자열)`은 `js::to_number`, `/…/i`는 ASCII만 대소문자를 무시한다(JS는 U+017F·U+212A를 ASCII 글자와 같게 보지 않는다).

use std::collections::HashMap;

use crate::js;
use crate::js_json::{object, JsValue};

pub const MAX_BODY_CHARS: usize = 8_000;
const ONE_LINE_MAX: usize = 120;

/// git의 환경 중 GIT_*로 시작해도 남기는 이름(이슈 #706). GIT_DIR·GIT_INDEX_FILE·GIT_CONFIG_PARAMETERS·GIT_CONFIG_COUNT 등은 스튜디오 프로세스에 우연히 들어 있어도 넘기지 않는다 — 저장소·인덱스·설정을 바꿔 b-studio가 본 것과 다른 것을 커밋하게 한다. PATH·HOME·프록시·인증서 변수는 GIT_로 시작하지 않아 그대로 둔다. 나머지 GIT_*는 넘기지 않는다. 대소문자를 구분한다
const PASSED_GIT_ENV: [&str; 14] = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_SSH_VARIANT",
    "GIT_ASKPASS",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
];

fn nibble(n: u32) -> char {
    char::from_u32(0xE000 + n).expect("예약 구간")
}

/// 예약 구간(U+E000..U+E01F)의 글자를 `@b-studio/sandbox`의 `encodeLoneSurrogates`가 쓰는 꼴(U+E011 + 니블 둘)로 바꾼다.
/// Rust 문자열에는 짝 없는 서로게이트가 없으므로 TS가 보낸 쪽(짝 없는 서로게이트는 U+E010 + 니블 셋)과 합쳐지지 않는다
pub fn encode_reserved(s: &str) -> String {
    if !s.chars().any(|c| ('\u{E000}'..='\u{E01F}').contains(&c)) {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let u = c as u32;
        if (0xE000..=0xE01F).contains(&u) {
            out.push('\u{E011}');
            out.push(nibble((u - 0xE000) >> 4));
            out.push(nibble((u - 0xE000) & 0xF));
        } else {
            out.push(c);
        }
    }
    out
}

/// `output.split('\0').filter(Boolean)`
pub fn split_nul(output: &str) -> Vec<String> {
    output.split('\0').filter(|part| !part.is_empty()).map(str::to_owned).collect()
}

// ── 위험한 로컬 설정(막는 검사) ─────────────────────────────────────────

fn eq_ci(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// 키 앞부분이 `prefix`와 ASCII 대소문자 무시로 같은가
fn starts_ci(key: &str, prefix: &str) -> bool {
    key.len() >= prefix.len() && key.is_char_boundary(prefix.len()) && eq_ci(&key[..prefix.len()], prefix)
}

/// 저장소 설정(로컬·worktree 범위, include로 끌어온 것 포함)에 없어야 하는 키(이슈 #699·#706, 대소문자 무시): 원격 주소를 바꾸거나 자격 증명을 가로채는 값, b-studio의 git이 프로그램을 부르게 하는 값(필터, diff·병합 드라이버, 서명 프로그램, 프록시), 작업 폴더를 옮기는 값. include는 펼쳐 읽지만 키 자체도 막는다. 옛 `DANGEROUS_LOCAL_CONFIG`. 정규식의 `.*`는 모든 글자(줄 끝 글자 포함)를 맞춘다
fn is_dangerous_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    let k = lower.as_str();
    let after = |prefix: &str| k.strip_prefix(prefix);
    k.starts_with("include.")
        || k.starts_with("includeif.")
        // `^url\..*\.insteadof$`: "url." 뒤에 `.insteadof`로 끝나는 나머지가 있어야 한다
        || after("url.").is_some_and(|rest| rest.ends_with(".insteadof") || rest.ends_with(".pushinsteadof"))
        || k.starts_with("credential.")
        || matches!(k, "core.sshcommand" | "core.gitproxy" | "core.askpass" | "core.worktree")
        // `^http\.(.*\.)?(extraheader|proxy|ssl|cookiefile)`(끝 앵커 없음): 바로 뒤, 또는 어느 `.` 바로 뒤
        || after("http.").is_some_and(|rest| {
            ["extraheader", "proxy", "ssl", "cookiefile"]
                .iter()
                .any(|alt| rest.starts_with(alt) || rest.contains(&format!(".{alt}")))
        })
        // `^remote\..*\.(pushurl|receivepack|uploadpack|proxy|vcs)`(끝 앵커 없음)
        || after("remote.").is_some_and(|rest| ["pushurl", "receivepack", "uploadpack", "proxy", "vcs"].iter().any(|alt| rest.contains(&format!(".{alt}"))))
        || k.starts_with("protocol.")
        || k.starts_with("filter.")
        || k == "diff.external"
        || after("diff.").is_some_and(|rest| rest.ends_with(".textconv") || rest.ends_with(".command"))
        || after("merge.").is_some_and(|rest| rest.ends_with(".driver"))
        || k.starts_with("gpg.")
}

/// 켜져 있으면 막는 키(옛 `DANGEROUS_WHEN_ENABLED`)
fn is_dangerous_when_enabled(key: &str) -> bool {
    eq_ci(key, "commit.gpgsign") || eq_ci(key, "tag.gpgsign")
}

/// `git config --list --includes --show-scope --show-origin -z` 출력에서 위험한 값의 설명. 항목마다 "범위\0출처\0키\n값\0"이다.
/// 형식이 맞지 않으면 `None`(부르는 쪽이 던진다 — 확인하지 못한 것을 "위험한 값이 없다"로 보지 않는다)
pub fn dangerous_local_config(output: &str, separate_git_dir: bool) -> Option<Vec<String>> {
    let mut fields: Vec<&str> = output.split('\0').collect();
    if fields.last() == Some(&"") {
        fields.pop();
    }
    if fields.len() % 3 != 0 {
        return None;
    }
    let mut found = Vec::new();
    for chunk in fields.chunks(3) {
        let scope = chunk[0];
        if scope != "local" && scope != "worktree" {
            continue;
        }
        let entry = chunk[2];
        let (key, value) = match entry.find('\n') {
            Some(newline) => (&entry[..newline], &entry[newline + 1..]),
            None => (entry, "true"),
        };
        let trimmed = js::trim(value);
        let disabled = ["false", "no", "off", "0"].iter().any(|word| eq_ci(trimmed, word));
        let enabled = !disabled;
        if eq_ci(key, "core.worktree") && separate_git_dir {
            continue;
        }
        if is_dangerous_key(key) || (enabled && is_dangerous_when_enabled(key)) {
            let note = if scope == "worktree" { "(config.worktree)" } else { "" };
            found.push(format!("저장소 설정에 {key}이(가) 있습니다{note}"));
        }
    }
    Some(found)
}

/// git이 속성 파일에서 건너뛰는 글자(attr.c의 `blank`)
const ATTR_BLANK: [char; 4] = [' ', '\t', '\r', '\n'];

/// `.git/info/attributes`의 내용에서 알릴 말(없으면 빈 목록). 주석과 빈 줄이 아닌 줄이 있으면 앞의 셋을 보인다.
/// 줄을 git이 읽는 규칙으로 읽는다: ` \t\r\n`만 건너뛴 뒤 비었거나 `#`으로 시작하면 건너뛴다
pub fn info_attributes(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.trim_matches(ATTR_BLANK))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let shown: Vec<&str> = lines.into_iter().take(3).collect();
    vec![format!(".git/info/attributes에 속성이 있습니다: {}", shown.join(" / "))]
}

// ── 스테이지 불일치(막는 검사) ───────────────────────────────────────────

/// 저장소 루트 기준 경로를 프로젝트 기준으로 바꾸고 프로젝트 밖은 뺀다(옛 `#fromRoot`)
fn from_root(file: &str, subdir: &str) -> Option<String> {
    if subdir.is_empty() {
        return Some(file.to_owned());
    }
    file.strip_prefix(subdir).and_then(|rest| rest.strip_prefix('/')).map(str::to_owned)
}

/// 스테이징된 변경(`diff --cached --name-only --no-renames -z`)과 인덱스(`ls-files --stage -z`)가 기대한 지문과 다른 파일들(정렬).
/// `expected_keys[i]`의 지문이 `expected_values[i]`다. 기대 쪽 글자는 TS가 `encodeLoneSurrogates`한 것이고, git 쪽 경로는 여기서 `encode_reserved`한다.
/// 결과의 경로는 같은 인코딩이라 TS가 되돌린다
pub fn staged_mismatch(ls_files: &str, staged_names: &str, subdir: &str, expected_keys: &[String], expected_values: &[String]) -> Vec<String> {
    let mut expected: HashMap<&str, &str> = HashMap::new();
    for (key, value) in expected_keys.iter().zip(expected_values) {
        expected.insert(key, value);
    }
    let staged: Vec<String> = split_nul(staged_names).iter().filter_map(|name| from_root(name, subdir)).map(|name| encode_reserved(&name)).collect();
    let mut index: HashMap<String, String> = HashMap::new();
    for entry in ls_files.split('\0').filter(|part| !part.is_empty()) {
        let (head, path) = match entry.find('\t') {
            Some(tab) => (&entry[..tab], &entry[tab + 1..]),
            // 탭이 없으면 JS의 `slice(0, -1)`·`slice(0)`과 같게 끝 글자 하나를 뺀 것과 전체로 읽는다
            None => (&entry[..entry.char_indices().last().map_or(0, |(at, _)| at)], entry),
        };
        let mut head_fields = head.split(' ');
        let mode = head_fields.next().unwrap_or("");
        let id = head_fields.next().unwrap_or("undefined");
        let Some(file) = from_root(path, subdir) else { continue };
        let print = match mode {
            "120000" => "link:".to_owned(),
            "160000" => "other".to_owned(),
            _ => format!("blob:{id}"),
        };
        index.insert(encode_reserved(&file), print);
    }
    let mut mismatched: Vec<String> = Vec::new();
    for file in &staged {
        let actual = index.get(file).map_or("missing", String::as_str);
        if expected.get(file.as_str()) != Some(&actual) {
            mismatched.push(file.clone());
        }
    }
    for key in expected_keys {
        if !staged.contains(key) {
            mismatched.push(key.clone());
        }
    }
    mismatched.sort_by(|a, b| js::cmp_utf16(a, b));
    mismatched.dedup();
    mismatched
}

// ── status --porcelain -z ───────────────────────────────────────────────

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn tail_from(units: &[u16], start: usize) -> String {
    String::from_utf16_lossy(&units[start.min(units.len())..])
}

/// `status --porcelain=v1 -z` 출력의 항목들. 이름 변경·복사(R·C)는 다음 항목이 원래 경로다. (항목 문자열, 원래 경로가 있으면 그것)
fn porcelain_entries(output: &str) -> Vec<(Vec<u16>, Option<String>)> {
    let entries = split_nul(output);
    let mut result = Vec::new();
    let mut i = 0;
    while i < entries.len() {
        let entry = units(&entries[i]);
        let renamed = matches!(entry.first(), Some(&u) if u == u16::from(b'R') || u == u16::from(b'C'));
        let original = if renamed {
            i += 1;
            entries.get(i).cloned()
        } else {
            None
        };
        result.push((entry, original));
        i += 1;
    }
    result
}

/// 바뀐 파일 목록(저장소 루트 기준 → 프로젝트 기준, 중복 제거, 나온 순서). 정렬은 부르는 쪽이 한다
pub fn pending_files(output: &str, subdir: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for (entry, original) in porcelain_entries(output) {
        files.push(tail_from(&entry, 3));
        if let Some(original) = original {
            files.push(original);
        }
    }
    let mut seen = std::collections::HashSet::new();
    files.retain(|file| seen.insert(file.clone()));
    files.iter().filter_map(|file| from_root(file, subdir)).collect()
}

/// 바뀐 파일과 바뀐 종류(`added`·`deleted`·`modified`). 나온 순서(같은 경로가 다시 나오면 값만 바꾸고 자리는 처음 것). 정렬은 부르는 쪽이 한다
pub fn pending_changes(output: &str, subdir: &str) -> Vec<(String, &'static str)> {
    let mut order: Vec<String> = Vec::new();
    let mut kinds: HashMap<String, &'static str> = HashMap::new();
    let mut set = |file: String, change: &'static str| {
        if kinds.insert(file.clone(), change).is_none() {
            order.push(file);
        }
    };
    for (entry, original) in porcelain_entries(output) {
        let code = &entry[..entry.len().min(2)];
        let file = tail_from(&entry, 3);
        let has = |letter: u8| code.contains(&u16::from(letter));
        if matches!(entry.first(), Some(&u) if u == u16::from(b'R') || u == u16::from(b'C')) {
            if let Some(original) = original {
                set(original, "deleted");
            }
            set(file, "added");
            continue;
        }
        let question = u16::from(b'?');
        let change = if code == [question, question] || has(b'A') {
            "added"
        } else if has(b'D') {
            "deleted"
        } else {
            "modified"
        };
        set(file, change);
    }
    order
        .into_iter()
        .filter_map(|file| {
            let change = kinds[&file];
            from_root(&file, subdir).map(|relative| (relative, change))
        })
        .collect()
}

// ── numstat · 레코드 ────────────────────────────────────────────────────

/// 줄 수 합(추가, 삭제). 이진 파일(`-\t-\t경로`)과 빈 칸은 건너뛴다. `Number(x) || 0`
pub fn commit_stat(output: &str) -> (f64, f64) {
    let count = |text: &str| {
        let n = js::to_number(text);
        if n.is_nan() || n == 0.0 {
            0.0
        } else {
            n
        }
    };
    let (mut insertions, mut deletions) = (0.0, 0.0);
    for line in output.split('\n') {
        let mut parts = line.split('\t');
        let (added, removed) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if !added.is_empty() && !removed.is_empty() && added != "-" && removed != "-" {
            insertions += count(added);
            deletions += count(removed);
        }
    }
    (insertions, deletions)
}

/// 레코드 구분자(\x1e)로 나눈다. 레코드 앞의 줄바꿈 하나를 지우고 빈 것은 버린다
fn split_records(output: &str) -> Vec<&str> {
    output
        .split('\u{1e}')
        .map(|record| record.strip_prefix('\n').unwrap_or(record))
        .filter(|record| !record.is_empty())
        .collect()
}

/// `log --reverse --format=%H%x00%h%x00%s%x00%an%x1e`의 레코드: [sha, shortSha, subject, author]
pub fn remote_commits(output: &str) -> Vec<[String; 4]> {
    split_records(output)
        .into_iter()
        .map(|record| {
            let mut fields = record.split('\0');
            let mut next = || fields.next().unwrap_or("").to_owned();
            [next(), next(), next(), next()]
        })
        .collect()
}

/// 작성자 이메일이 체크포인트를 만든 쪽(`our_email`)과 같은가. 통과 기록(트레일러)은 같을 때만 믿는다(여는 쪽).
/// `our_email`은 TS가 `encodeLoneSurrogates`한 글자, git이 낸 `git_email`은 여기서 예약 글자를 `encode_reserved`한다
pub fn author_is_ours(git_email: &str, our_email: &str) -> bool {
    js::trim(&encode_reserved(git_email)).to_lowercase() == js::trim(our_email).to_lowercase()
}

fn string_list(joined: &str) -> JsValue {
    JsValue::Arr(joined.split('\u{1f}').map(JsValue::str).collect())
}

/// `sessionCommits`의 레코드(`%H %h %s %b %ae 트레일러 셋 %x1e`)
pub fn session_records(output: &str, our_email: &str) -> JsValue {
    JsValue::Arr(
        split_records(output)
            .into_iter()
            .map(|record| {
                let mut fields = record.split('\0');
                let mut next = || fields.next().unwrap_or("");
                let (sha, short_sha, subject, body, author_email, trailers, verify, incomplete) = (next(), next(), next(), next(), next(), next(), next(), next());
                object(vec![
                    ("sha", Some(JsValue::str(sha))),
                    ("shortSha", Some(JsValue::str(short_sha))),
                    ("subject", Some(JsValue::str(subject))),
                    ("body", Some(JsValue::str(js::trim(body)))),
                    ("ours", Some(JsValue::Bool(author_is_ours(author_email, our_email)))),
                    ("trailers", Some(string_list(trailers))),
                    ("verifyTrailers", Some(string_list(verify))),
                    ("incompleteTrailers", Some(string_list(incomplete))),
                ])
            })
            .collect(),
    )
}

/// `#checkpoint`의 `show -s --format=%H %h %s %cI %ae 트레일러 셋`(NUL 구분, 앞뒤 공백은 지운다)
pub fn show_record(output: &str, our_email: &str) -> JsValue {
    let mut fields = js::trim(output).split('\0');
    let mut next = || fields.next().unwrap_or("");
    let (sha, short_sha, subject, created_at, author_email, trailers, verify, incomplete) = (next(), next(), next(), next(), next(), next(), next(), next());
    object(vec![
        ("sha", Some(JsValue::str(sha))),
        ("shortSha", Some(JsValue::str(short_sha))),
        ("subject", Some(JsValue::str(subject))),
        ("createdAt", Some(JsValue::str(created_at))),
        ("ours", Some(JsValue::Bool(author_is_ours(author_email, our_email)))),
        ("trailers", Some(string_list(trailers))),
        ("verifyTrailers", Some(string_list(verify))),
        ("incompleteTrailers", Some(string_list(incomplete))),
    ])
}

// ── 글자 다듬기 ─────────────────────────────────────────────────────────

/// 공백 덩어리를 한 칸으로 줄이고 앞뒤를 다듬어 120자(UTF-16)까지만 둔다. 비면 "체크포인트"
pub fn one_line(message: &str) -> String {
    let mut collapsed = String::with_capacity(message.len());
    let mut in_space = false;
    for c in message.chars() {
        if js::is_js_whitespace(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let cut = js::truncate_utf16(js::trim(&collapsed), ONE_LINE_MAX);
    if cut.is_empty() {
        "체크포인트".to_owned()
    } else {
        cut
    }
}

/// `max`(UTF-16 코드 단위)를 넘으면 자르고 생략한 수를 적는다
pub fn cap_text(text: &str, max: usize) -> String {
    let len = js::utf16_len(text);
    if len <= max {
        return text.to_owned();
    }
    format!("{}\n[... 길어서 {}자를 생략했습니다 ...]\n", js::truncate_utf16(text, max), len - max)
}

/// `git stripspace`(주석은 남긴다): 줄 끝 공백을 지우고, 빈 줄 여럿을 하나로 줄이고, 앞뒤의 빈 줄을 없앤다
pub fn strip_space(text: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim_end_matches([' ', '\t', '\r', '\u{b}', '\u{c}']);
        if line.is_empty() && lines.last().is_none_or(|last| last.is_empty()) {
            continue;
        }
        lines.push(line);
    }
    while lines.last().is_some_and(|last| last.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// 체크포인트 커밋 메시지(제목, 본문, 트레일러). 본문이 비어 있으면 넣지 않는다
pub fn commit_message(subject: &str, body: Option<&str>, trailers: &[String]) -> String {
    let mut paragraphs = vec![one_line(subject)];
    if let Some(body) = body.filter(|b| !b.is_empty()) {
        paragraphs.push(cap_text(body, MAX_BODY_CHARS));
    }
    if !trailers.is_empty() {
        paragraphs.push(trailers.iter().map(|t| one_line(t)).collect::<Vec<_>>().join("\n"));
    }
    strip_space(&paragraphs.join("\n\n"))
}

/// 오류 메시지에 넣을 git 하위 명령. 앞에 붙인 위치·설정 옵션(-C, --git-dir, --work-tree, -c)과 그 값은 건너뛴다
pub fn subcommand(args: &[String]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        if matches!(args[i].as_str(), "-C" | "--git-dir" | "--work-tree" | "-c") {
            i += 2;
        } else {
            return Some(args[i].clone());
        }
    }
    None
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_scheme_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')
}

/// 주소에 들어 있는 `스킴://토큰@`의 토큰을 `***`로 바꾼다. `/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi`를 손으로 옮겼다
/// (스킴 줄기와 토큰 줄기는 되돌아갈 자리가 없다: 스킴 글자에 ':'가 없고, 토큰 글자에 '@'·'/'·공백이 없다)
pub fn redact_credentials(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut p = 0;
    while p < chars.len() {
        if let Some(end) = credential_match(&chars, p) {
            let scheme_end = chars[p..].iter().position(|&c| c == ':').expect("스킴 뒤 ':'") + p;
            out.extend(&chars[p..scheme_end]);
            out.push_str("://***@");
            p = end;
        } else {
            out.push(chars[p]);
            p += 1;
        }
    }
    out
}

/// `p`에서 시작하는 일치가 있으면 끝 위치(`@` 다음)
fn credential_match(chars: &[char], p: usize) -> Option<usize> {
    if !chars[p].is_ascii_alphabetic() || (p > 0 && is_word(chars[p - 1])) {
        return None;
    }
    let mut i = p + 1;
    while i < chars.len() && is_scheme_char(chars[i]) {
        i += 1;
    }
    if chars.get(i..i + 3) != Some(&[':', '/', '/']) {
        return None;
    }
    i += 3;
    let token_start = i;
    while i < chars.len() && !js::is_js_whitespace(chars[i]) && chars[i] != '/' && chars[i] != '@' {
        i += 1;
    }
    if i > token_start && chars.get(i) == Some(&'@') {
        Some(i + 1)
    } else {
        None
    }
}

/// git이 인덱스 잠금을 얻지 못해 아무것도 하지 않고 끝났는가
pub fn is_index_lock_failure(stderr: &str) -> bool {
    if !stderr.contains("index.lock") {
        return false;
    }
    let lower = stderr.to_ascii_lowercase();
    ["file exists", "unable to create", "another git process"].iter().any(|phrase| lower.contains(phrase))
}

/// 한글 조사 '을/를'을 고른다. 마지막 글자(UTF-16 코드 단위 하나)의 소문자에 모음이 있으면 '를'
pub fn with_object_particle(word: &str) -> String {
    let trimmed = units(js::trim(word));
    let vowel = match trimmed.last() {
        Some(&unit) => char::from_u32(u32::from(unit)).is_some_and(|c| c.to_lowercase().any(|l| matches!(l, 'a' | 'e' | 'i' | 'o' | 'u'))),
        None => false,
    };
    format!("{word}{}", if vowel { "를" } else { "을" })
}

/// 폴더나 파일 이름이 git이 보는 `.git`인가(ASCII 대소문자 무시)
pub fn is_dot_git(name: &str) -> bool {
    eq_ci(name, ".git")
}

/// 체크포인트 ID(`/^[0-9a-f]{7,40}$/`)
pub fn is_sha(text: &str) -> bool {
    (7..=40).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 백업 ID(`/^[0-9A-Za-z-]{10,64}$/`)
pub fn is_backup_id(text: &str) -> bool {
    (10..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `ls-remote --symref origin HEAD refs/heads/<base>` 출력에서 풀 요청 기준 브랜치를 읽는다.
/// 기준 브랜치가 원격에 있으면 `base`만, 없으면 원격 HEAD가 가리키는 브랜치(읽지 못하면 `info_base`)와 `missingBase`
pub fn pull_request_target(listed: &str, base_ref: &str, info_base: &str) -> JsValue {
    let lines: Vec<&str> = listed.split('\n').map(js::trim).collect();
    let suffix = format!("\t{base_ref}");
    if lines.iter().any(|line| line.ends_with(&suffix)) {
        return object(vec![("base", Some(JsValue::str(info_base)))]);
    }
    let head = lines.iter().find(|line| line.starts_with("ref: ")).copied().unwrap_or("");
    // `^ref: refs\/heads\/(\S+)\tHEAD$`
    let branch = head.strip_prefix("ref: refs/heads/").and_then(|rest| {
        let end = rest.find(js::is_js_whitespace)?;
        (end > 0 && &rest[end..] == "\tHEAD").then(|| rest[..end].to_owned())
    });
    object(vec![("base", Some(JsValue::Str(branch.unwrap_or_else(|| info_base.to_owned())))), ("missingBase", Some(JsValue::str(info_base)))])
}

/// 환경 변수 이름마다 남길지(`true`)·뺄지(`false`). GIT_*(ASCII 대소문자 무시)는 `PASSED_GIT_ENV`(대소문자 구분)에 있을 때만 남긴다
pub fn git_env_keep(keys: &[String]) -> Vec<bool> {
    keys.iter().map(|key| !(starts_ci(key, "GIT_") && !PASSED_GIT_ENV.contains(&key.as_str()))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|x| (*x).to_owned()).collect()
    }

    fn config(entries: &[(&str, &str)]) -> String {
        entries.iter().map(|(scope, entry)| format!("{scope}\0file:.git/config\0{entry}\0")).collect()
    }

    #[test]
    fn 위험한_키를_잡는다() {
        for key in [
            "include.path",
            "includeIf.gitdir:/x.path",
            "url.https://a/.insteadOf",
            "url.x.pushInsteadOf",
            "credential.helper",
            "core.sshCommand",
            "core.worktree",
            "http.extraHeader",
            "http.https://x/.proxy",
            "http.sslVerify",
            "remote.origin.pushurl",
            "remote.origin.proxyfoo",
            "protocol.ext.allow",
            "filter.lfs.clean",
            "diff.external",
            "diff.x.textconv",
            "merge.x.driver",
            "gpg.program",
        ] {
            let out = config(&[("local", &format!("{key}\nvalue"))]);
            assert_eq!(dangerous_local_config(&out, false).expect("형식").len(), 1, "{key}");
        }
    }

    #[test]
    fn 줄_끝_글자가_키_가운데에_있어도_막는다() {
        // 의도한 차이: 옛 정규식의 `.`은 이 글자를 맞추지 못해 빠져나갔다
        for key in ["url.a\rb.insteadof", "url.a\u{2028}b.pushinsteadof", "remote.o\rrigin.pushurl", "diff.a\u{2029}b.textconv", "merge.a\rb.driver", "http.a\rb.proxy"] {
            let out = config(&[("local", &format!("{key}\nv"))]);
            assert_eq!(dangerous_local_config(&out, false).expect("형식").len(), 1, "{key:?}");
        }
    }

    #[test]
    fn 비슷하지만_다른_키는_통과한다() {
        for key in ["url.insteadof", "core.worktreex", "xcore.worktree", "user.name", "remote.origin.url", "remote.origin.fetch", "diff.textconv", "merge.driver", "commit.gpgsignx", "gpgx.program", "filterx.a"] {
            let out = config(&[("local", &format!("{key}\nvalue"))]);
            assert!(dangerous_local_config(&out, false).expect("형식").is_empty(), "{key}");
        }
    }

    #[test]
    fn 범위가_local_worktree가_아니면_보지_않는다() {
        let out = config(&[("global", "credential.helper\nx"), ("system", "include.path\nx"), ("command", "core.sshcommand\nx")]);
        assert!(dangerous_local_config(&out, false).expect("형식").is_empty());
        let out = config(&[("worktree", "core.hookspath\nx"), ("worktree", "credential.helper\nx")]);
        assert_eq!(dangerous_local_config(&out, false).expect("형식"), s(&["저장소 설정에 credential.helper이(가) 있습니다(config.worktree)"]));
    }

    #[test]
    fn 서명은_켜졌을_때만_막는다() {
        for (value, blocked) in [("true", true), ("", true), ("yes", true), ("false", false), (" FALSE ", false), ("No", false), ("off", false), ("0", false), ("00", true), ("fals", true)] {
            let out = config(&[("local", &format!("commit.gpgsign\n{value}"))]);
            assert_eq!(!dangerous_local_config(&out, false).expect("형식").is_empty(), blocked, "{value:?}");
        }
        // 값이 없는 키(`[commit] gpgsign`)는 켜진 것이다
        assert_eq!(dangerous_local_config(&config(&[("local", "tag.gpgsign")]), false).expect("형식").len(), 1);
    }

    #[test]
    fn 작업_폴더_밖_저장소의_core_worktree만_뺀다() {
        let out = config(&[("local", "core.worktree\n/x"), ("local", "Core.WorkTree\n/y"), ("local", "core.worktree.x\n/z")]);
        assert_eq!(dangerous_local_config(&out, true).expect("형식").len(), 0);
        assert_eq!(dangerous_local_config(&out, false).expect("형식").len(), 2);
    }

    #[test]
    fn 읽지_못하는_형식은_none() {
        assert!(dangerous_local_config("local\0file:x\0", false).is_none());
        assert!(dangerous_local_config("a\0b\0c\0d\0", false).is_none());
        assert_eq!(dangerous_local_config("", false), Some(vec![]));
    }

    #[test]
    fn 속성_파일은_git이_읽는_규칙으로_읽는다() {
        assert!(info_attributes("").is_empty());
        assert!(info_attributes("# 주석\n\n  \t\r\n   # 들여쓴 주석\r\n").is_empty());
        assert_eq!(info_attributes("* filter=x\r\n"), s(&[".git/info/attributes에 속성이 있습니다: * filter=x"]));
        assert_eq!(info_attributes("a\nb\nc\nd"), s(&[".git/info/attributes에 속성이 있습니다: a / b / c"]));
        // 의도한 차이: JS trim이 지우지만 git은 건너뛰지 않는 글자 뒤의 '#'은 주석이 아니다
        for lead in ["\u{a0}", "\u{feff}", "\u{b}", "\u{c}", "\u{2003}"] {
            assert_eq!(info_attributes(&format!("{lead}# * export-ignore")).len(), 1, "{lead:?}");
        }
        // 글자만 있는 줄도 git에는 속성 없는 패턴이지만 막는 쪽으로 넓게 센다
        assert_eq!(info_attributes("\u{a0}").len(), 1);
    }

    fn ls(entries: &[&str]) -> String {
        entries.iter().map(|e| format!("{e}\0")).collect()
    }

    #[test]
    fn 스테이지_불일치() {
        let ids = ls(&["100644 aaa 0\tsrc/a.ts", "120000 bbb 0\tsrc/l", "160000 ccc 0\tsrc/m", "100755 ddd 0\tsrc/x.sh"]);
        let names = ls(&["src/a.ts", "src/l", "src/m", "src/x.sh", "other/z"]);
        let keys = s(&["a.ts", "l", "m", "x.sh"]);
        let values = s(&["blob:aaa", "link:", "other", "blob:ddd"]);
        assert_eq!(staged_mismatch(&ids, &names, "src", &keys, &values), Vec::<String>::new());
        // 값이 다르다
        assert_eq!(staged_mismatch(&ids, &names, "src", &keys, &s(&["blob:aab", "link:", "other", "blob:ddd"])), s(&["a.ts"]));
        // 기대에 없는데 스테이징됨
        assert_eq!(staged_mismatch(&ids, &names, "src", &s(&["a.ts", "l", "m"]), &s(&["blob:aaa", "link:", "other"])), s(&["x.sh"]));
        // 기대에 있는데 스테이징 안 됨
        assert_eq!(staged_mismatch(&ids, &names, "src", &s(&["a.ts", "l", "m", "x.sh", "q"]), &s(&["blob:aaa", "link:", "other", "blob:ddd", "missing"])), s(&["q"]));
        // 삭제는 인덱스에 없어 missing
        assert_eq!(staged_mismatch(&ls(&[]), &ls(&["gone.ts"]), "", &s(&["gone.ts"]), &s(&["missing"])), Vec::<String>::new());
        assert_eq!(staged_mismatch(&ls(&[]), &ls(&["gone.ts"]), "", &s(&["gone.ts"]), &s(&["blob:1"])), s(&["gone.ts"]));
    }

    #[test]
    fn 예약_글자가_든_경로는_단사로_견준다() {
        // TS가 짝 없는 서로게이트 U+D800을 U+E010 + 니블 셋(0xd,0x8,0x0)으로 보낸 기대 키는, git이 낸 실제 이름 "\u{E010}\u{E00D}\u{E008}\u{E000}"와 같지 않다
        let encoded_lone = "a\u{E010}\u{E00D}\u{E008}\u{E000}".to_owned();
        let literal = "a\u{E010}\u{E00D}\u{E008}\u{E000}";
        let names = ls(&[literal]);
        let ids = ls(&[&format!("100644 aaa 0\t{literal}")]);
        let got = staged_mismatch(&ids, &names, "", &[encoded_lone.clone()], &s(&["blob:aaa"]));
        assert_eq!(got.len(), 2, "{got:?}");
    }

    #[test]
    fn porcelain_파일_목록() {
        let out = "?? new.ts\0 M mod.ts\0R  new-name.ts\0old-name.ts\0D  gone.ts\0C  copy.ts\0src.ts\0 M mod.ts\0";
        assert_eq!(pending_files(out, ""), s(&["new.ts", "mod.ts", "new-name.ts", "old-name.ts", "gone.ts", "copy.ts", "src.ts"]));
        assert_eq!(pending_files("?? p/a\0?? q/b\0", "p"), s(&["a"]));
        assert!(pending_files("", "").is_empty());
        // 끝의 R에 원래 경로가 없다
        assert_eq!(pending_files("R  x\0", ""), s(&["x"]));
    }

    #[test]
    fn porcelain_종류() {
        let out = "?? n.ts\0 M m.ts\0A  a.ts\0 D d.ts\0AD ad.ts\0R  to.ts\0from.ts\0MM mm.ts\0";
        let got: Vec<(String, &str)> = pending_changes(out, "");
        assert_eq!(
            got,
            vec![
                ("n.ts".into(), "added"),
                ("m.ts".into(), "modified"),
                ("a.ts".into(), "added"),
                ("d.ts".into(), "deleted"),
                ("ad.ts".into(), "added"),
                ("from.ts".into(), "deleted"),
                ("to.ts".into(), "added"),
                ("mm.ts".into(), "modified"),
            ]
        );
        // 같은 경로가 다시 나오면 값만 바뀐다
        assert_eq!(pending_changes("R  a\0b\0 D b\0", ""), vec![("b".into(), "deleted"), ("a".into(), "added")]);
        assert_eq!(pending_changes("?? s/x\0?? t/y\0", "s"), vec![("x".into(), "added")]);
    }

    #[test]
    fn numstat_합() {
        assert_eq!(commit_stat("1\t2\ta\n3\t4\tb\n-\t-\tbin\n\n"), (4.0, 6.0));
        assert_eq!(commit_stat("x\ty\tz\n 5 \t0x10\tq"), (5.0, 16.0));
        assert_eq!(commit_stat(""), (0.0, 0.0));
        assert_eq!(commit_stat("1\t\tp\n\t2\tp"), (0.0, 0.0));
        assert_eq!(commit_stat("Infinity\t1\tp").0, f64::INFINITY);
    }

    #[test]
    fn 레코드_분리() {
        let list = |out: &str| remote_commits(out).into_iter().map(|r| r.to_vec()).collect::<Vec<_>>();
        assert_eq!(list("a\0b\0c\0d\u{1e}\ne\0f\0g\0h\u{1e}\n"), vec![s(&["a", "b", "c", "d"]), s(&["e", "f", "g", "h"])]);
        assert_eq!(list("x\u{1e}"), vec![s(&["x", "", "", ""])]);
        assert!(list("\n\u{1e}\u{1e}").is_empty());
    }

    #[test]
    fn 작성자_비교() {
        assert!(author_is_ours(" Checkpoints@B-Studio.local ", "checkpoints@b-studio.local"));
        assert!(!author_is_ours("checkpoints@b-studio.local.evil", "checkpoints@b-studio.local"));
        assert!(!author_is_ours("xcheckpoints@b-studio.local", "checkpoints@b-studio.local"));
        assert!(!author_is_ours("", "checkpoints@b-studio.local"));
    }

    #[test]
    fn 커밋_메시지() {
        assert_eq!(commit_message("  제목  \n둘째 ", Some("본문\n\n\n  끝  "), &s(&["Workflow-Passed: a, b"])), "제목 둘째\n\n본문\n\n  끝\n\nWorkflow-Passed: a, b");
        assert_eq!(commit_message("", None, &[]), "체크포인트");
        assert_eq!(commit_message("x", Some(""), &[]), "x");
        assert_eq!(one_line(&"가".repeat(121)).chars().count(), 120);
        assert_eq!(strip_space("\n\na  \n\n\n\nb\t\n\n"), "a\n\nb");
    }

    #[test]
    fn 길이_자르기는_utf16() {
        assert_eq!(cap_text("abc", 3), "abc");
        assert_eq!(cap_text("abcd", 3), "abc\n[... 길어서 1자를 생략했습니다 ...]\n");
        // 이모지는 UTF-16으로 둘이다
        assert_eq!(cap_text("😀😀", 3), "😀\u{fffd}\n[... 길어서 1자를 생략했습니다 ...]\n");
    }

    #[test]
    fn 하위_명령() {
        assert_eq!(subcommand(&s(&["-C", "x", "-c", "a=b", "status"])), Some("status".into()));
        assert_eq!(subcommand(&s(&["--git-dir", "x"])), None);
        assert_eq!(subcommand(&s(&["-C"])), None);
        assert_eq!(subcommand(&s(&["--no-pager", "log"])), Some("--no-pager".into()));
    }

    #[test]
    fn 자격_증명_가림() {
        assert_eq!(redact_credentials("fatal: https://tok@github.com/x 실패"), "fatal: https://***@github.com/x 실패");
        assert_eq!(redact_credentials("'ssh://u:p@h/r' 와 git+ssh://a@b"), "'ssh://***@h/r' 와 git+ssh://***@b");
        assert_eq!(redact_credentials("https://github.com/x@y"), "https://github.com/x@y");
        assert_eq!(redact_credentials("https://@h"), "https://@h");
        assert_eq!(redact_credentials("9https://tok@h"), "9https://tok@h");
        assert_eq!(redact_credentials("x.https://t@h"), "x.https://***@h");
        assert_eq!(redact_credentials("a://b@c://d@e"), "a://***@c://***@e");
    }

    #[test]
    fn 잠금_실패() {
        assert!(is_index_lock_failure("fatal: Unable to create '/x/.git/index.lock': File exists."));
        assert!(is_index_lock_failure("index.lock another git process"));
        assert!(!is_index_lock_failure("Unable to create 'x'"));
        assert!(!is_index_lock_failure("INDEX.LOCK file exists"));
        assert!(!is_index_lock_failure("index.lock"));
    }

    #[test]
    fn 조사() {
        assert_eq!(with_object_particle("main"), "main을");
        assert_eq!(with_object_particle("release"), "release를");
        assert_eq!(with_object_particle(" dev "), " dev 을");
        assert_eq!(with_object_particle("가"), "가을");
        assert_eq!(with_object_particle("Ä"), "Ä을");
        assert_eq!(with_object_particle(""), "을");
    }

    #[test]
    fn 이름과_아이디_검사() {
        assert!(is_dot_git(".git") && is_dot_git(".GIT") && is_dot_git(".GiT"));
        assert!(!is_dot_git(".git ") && !is_dot_git("git") && !is_dot_git(".gıt") && !is_dot_git(".gİt"));
        assert!(is_sha("abcdef0") && is_sha(&"a".repeat(40)));
        assert!(!is_sha("abcdef") && !is_sha(&"a".repeat(41)) && !is_sha("ABCDEF0") && !is_sha("abcdef0\n") && !is_sha("abcdeg0"));
        assert!(is_backup_id(&"A".repeat(10)) && is_backup_id(&"a-".repeat(32)));
        assert!(!is_backup_id(&"a".repeat(9)) && !is_backup_id(&"a".repeat(65)) && !is_backup_id("aaaaaaaaa_") && !is_backup_id("aaaaaaaaa\n") && !is_backup_id("aaaaaaaaa.."));
    }

    #[test]
    fn 풀_요청_대상() {
        let found = pull_request_target("sha\trefs/heads/main\n", "refs/heads/main", "main");
        assert_eq!(crate::js_json::stringify(&found), r#"{"base":"main"}"#);
        let listed = "ref: refs/heads/trunk\tHEAD\nsha\tHEAD\n";
        assert_eq!(crate::js_json::stringify(&pull_request_target(listed, "refs/heads/main", "main")), r#"{"base":"trunk","missingBase":"main"}"#);
        assert_eq!(crate::js_json::stringify(&pull_request_target("sha\tHEAD\n", "refs/heads/main", "main")), r#"{"base":"main","missingBase":"main"}"#);
        // 접미가 맞지 않는 줄
        assert_eq!(crate::js_json::stringify(&pull_request_target("ref: refs/heads/a b\tHEAD", "refs/heads/m", "m")), r#"{"base":"m","missingBase":"m"}"#);
        assert_eq!(crate::js_json::stringify(&pull_request_target("ref: refs/heads/\tHEAD", "refs/heads/m", "m")), r#"{"base":"m","missingBase":"m"}"#);
        // 접두 "refs/heads/main2"는 base_ref와 같지 않다
        assert_eq!(crate::js_json::stringify(&pull_request_target("s\trefs/heads/main2", "refs/heads/main", "main")), r#"{"base":"main","missingBase":"main"}"#);
    }

    #[test]
    fn git_환경() {
        let keys = s(&["PATH", "GIT_DIR", "git_dir", "GIT_AUTHOR_NAME", "git_author_name", "GIT_SSH_COMMAND", "GIT_SSH_COMMAND2", "GITX", "GIT", "HOME", "Git_Index_File"]);
        assert_eq!(git_env_keep(&keys), vec![true, false, false, true, false, true, false, true, true, true, false]);
    }
}
