//! 체크포인트 커밋 제목 만들기(ADR-080). 모델을 부르지 않고 경로·낱말만 본다(옛 TS: `packages/agent/src/commit-message.ts`).
//!
//! JS와 같게 읽는 곳:
//! - 정규식은 TS의 글자를 그대로 `pr_review::js_regex`에 넣는다(`\s`는 JS 공백 집합, `.`는 줄 끝 글자를 뺀 모임, `\b`·`\w`·`\d`는 ASCII).
//! - `/i` 정규식: JS는 ASCII 글자를 비ASCII 글자와 같게 보지 않는데 Rust의 `(?i)`는 `ſ`(U+017F)를 `s`로, 켈빈 기호(U+212A)를 `k`로 본다.
//!   `fold_safe`가 그 두 글자를 같은 UTF-8·UTF-16 길이의 다른 글자로 바꾼 뒤 견준다(위치가 그대로라 자르는 자리가 어긋나지 않는다).
//! - `이미\s*.{0,25}있었`의 `.{0,25}`는 UTF-16 코드 단위를 센다(글자 수가 아니다). 정규식으로 못 옮겨 `contains_progress_phrase`가 손으로 읽는다.
//! - 글자 수(`.length`)는 UTF-16 코드 단위(`js::utf16_len`), 자르기는 `slice_head`(서로게이트 쌍을 가르면 U+FFFD).
//! - 숫자 읽기·글자 만들기는 `js::to_number`·`js::number_to_string`.

use regex::Regex;
use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::js;
use crate::pr_review::{extract_pr_review_fix_titles, js_regex, slice_head};
use crate::test_discovery::extract_requirement_ids;

const MAX_SUBJECT_CHARS: usize = 72;

fn fold_safe(s: &str) -> Cow<'_, str> {
    if s.contains(['\u{017F}', '\u{212A}']) {
        Cow::Owned(s.chars().map(|c| match c {
            '\u{017F}' => '\u{00A7}',
            '\u{212A}' => '\u{2603}',
            other => other,
        }).collect())
    } else {
        Cow::Borrowed(s)
    }
}

/// `/…/i` 정규식 하나
struct CiRegex(Regex);

impl CiRegex {
    fn new(pattern: &str) -> Self {
        Self(js_regex(pattern, true))
    }
    fn test(&self, text: &str) -> bool {
        self.0.is_match(&fold_safe(text))
    }
}

fn rx(pattern: &str) -> Regex {
    js_regex(pattern, false)
}

/// 제목 맨 앞에 붙는 conventional commit 타입
pub type CommitType = &'static str;

/// 바뀐 파일 하나. `change`는 `added`·`modified`·`deleted`
pub struct Change<'a> {
    pub file: &'a str,
    pub change: &'a str,
}

static TEST_FILE: LazyLock<CiRegex> = LazyLock::new(|| {
    CiRegex::new(r"(^|\/)(__tests__)\/.+|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)src\/test\/(java|kotlin)\/.+\.(java|kt)$|(^|\/)tests?\/.+\.py$|(^|\/)test_[^/]+\.py$|_test\.py$")
});
static DOC_FILE: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"(^|\/)docs\/.+\.mdx?$|(^|\/)readme(\.[a-z]+)?\.md$|(^|\/)changelog\.md$"));
static REFACTOR_WORDS: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"리팩터|리팩토링|구조\s*정리|구조\s*변경|정리한다|옮기|옮겨|옮긴|refactor"));
static CHORE_WORDS: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"의존성|dependency|devdependency|버전\s*올리기|업그레이드|설정\s*변경|chore"));
static FIX_WORDS: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"고치|고쳐|버그|오류|에러|안\s*(돼|되|나와|보여)|깨지|실패하|수정해|fix|bug|error"));
static FEAT_WORDS: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"만들|만든|추가|더해|더하|구현|새로|add|implement|create"));
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| rx(r"\s+"));
static FIRST_SENTENCE: LazyLock<Regex> = LazyLock::new(|| rx(r"^(.+?[.!?])\s+\S"));

/// `request.split('\n')[0].replace(/\s+/g, ' ').trim()`
fn first_line_collapsed(request: &str) -> String {
    let first = request.split('\n').next().unwrap_or("");
    js::trim(&WS_RUN.replace_all(first, " ")).to_owned()
}

/// 한 줄에서 첫 문장만 자른다. 마침표·물음표·느낌표 뒤에 공백과 글자가 이어질 때만 문장 경계다
fn first_sentence(line: &str) -> &str {
    match FIRST_SENTENCE.captures(line) {
        Some(c) => c.get(1).map_or(line, |m| m.as_str()),
        None => line,
    }
}

/// 요청 글과 바뀐 파일에서 conventional commit 타입을 고른다. 테스트 파일만이면 test, 문서 파일만이면 docs, 새 파일뿐이면 feat,
/// 그 외에는 요청 첫 문장에서 fix·feat·refactor 낱말을 먼저 찾고, 없으면 요청 글 전체의 낱말로 fix·refactor·chore, 그래도 없으면 feat
pub fn classify_commit(request: &str, changes: &[Change]) -> CommitType {
    if !changes.is_empty() && changes.iter().all(|c| TEST_FILE.test(c.file)) {
        return "test";
    }
    if !changes.is_empty() && changes.iter().all(|c| DOC_FILE.test(c.file)) {
        return "docs";
    }
    if !changes.is_empty() && changes.iter().all(|c| c.change == "added") {
        return "feat";
    }
    let line = first_line_collapsed(request);
    let intent = first_sentence(&line);
    if FIX_WORDS.test(intent) {
        return "fix";
    }
    if FEAT_WORDS.test(intent) {
        return "feat";
    }
    if REFACTOR_WORDS.test(intent) {
        return "refactor";
    }
    if FIX_WORDS.test(request) {
        return "fix";
    }
    if REFACTOR_WORDS.test(request) {
        return "refactor";
    }
    if CHORE_WORDS.test(request) {
        return "chore";
    }
    "feat"
}

static TRAILING_REQUEST_PHRASING: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(해\s*(줘|주세요|주십시오)|부탁(?:드립니다|드려요|해요|합니다)?|주시기\s*바랍니다|바랍니다)\s*[.!?。]*$"));
static SITUATIONAL_WORDS: LazyLock<CiRegex> = LazyLock::new(|| {
    CiRegex::new(r"(앞|이전|지난|직전|방금)\s*(실행|시도|요청|작업)|네트워크|연결이?\s*끊|세션이?\s*끊|턴\s*상한|최대\s*턴\s*수|토큰\s*상한|되돌려지|롤백되|rate\s*limit|레이트\s*리밋|타임아웃|timeout")
});
static STATE_DESCRIPTION_ENDING: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(없|않|있|죽)습니다$|(입|아닙|됩|깨집|나옵|보입|걸립|실패합|멈춥|막힙|끊깁)니다$|(없어|않아|있어|안\s*돼|안\s*나와|안\s*보여)요$"));
static REQUEST_NARRATION_ENDING: LazyLock<Regex> = LazyLock::new(|| rx(r"(었|았|였|했|렸|웠|겼|졌|줬|봤|뒀)습니다$"));
static TRAILING_PUNCT: LazyLock<Regex> = LazyLock::new(|| rx(r"[.!?。]+$"));
static PAREN_TAIL_SPACED: LazyLock<Regex> = LazyLock::new(|| rx(r"\s*\([^()]*\)$"));
/// 앞부분(이미…있었)을 뺀 나머지 경과 보고 낱말
static PROGRESS_REPORT_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    rx(r"검토\s*결과|확인\s*결과|확인해\s*보니|돌아보니|살펴보니|추가로\s*(만들|할|고칠)\s*것(이|가)?\s*없|보고(합니다|드립니다|드려요)|결과를\s*(알려|보고)|완료\s*요약")
});
static BARE_ID_OR_PRONOUN_FRAGMENT: LazyLock<Regex> = LazyLock::new(|| rx(r"^(R\d+(?:\.\d+)?|이것|그것|저것|이거|그거|저거|이걸|그걸|저걸|이|그|저)(은|는|이|가|을|를|도|만|에|에서|로|으로)?$"));
static DANGLING_OBJECT_PARTICLE: LazyLock<Regex> = LazyLock::new(|| rx(r"\S(을|를)$"));
static QUESTION_END: LazyLock<Regex> = LazyLock::new(|| rx(r"[?？]\s*$"));
static VERB_OR_NOUN_END: LazyLock<Regex> = LazyLock::new(|| rx(r"(다|함|기)$"));
static HANGUL: LazyLock<Regex> = LazyLock::new(|| rx(r"[가-힣]"));

/// `이미\s*.{0,25}있었`. 점은 UTF-16 코드 단위 하나라 25는 글자 수가 아니다. "이미" 뒤 글자에서 앞쪽 공백을 모두 떼고 남은 것이
/// 줄 끝 글자 없이 25 코드 단위 이하인 곳이 있으면 맞는다(공백도 점이 먹을 수 있으므로 앞쪽 공백을 다 먹는 것이 가장 짧다)
fn contains_progress_phrase(text: &str) -> bool {
    let after_imi: Vec<usize> = text.match_indices("이미").map(|(i, m)| i + m.len()).collect();
    if after_imi.is_empty() {
        return false;
    }
    let isseot: Vec<usize> = text.match_indices("있었").map(|(i, _)| i).collect();
    for &start in &after_imi {
        for &end in isseot.iter().filter(|&&e| e >= start) {
            let between = &text[start..end];
            let rest = between.trim_start_matches(js::is_js_whitespace);
            if !rest.chars().any(js::is_js_line_terminator) && js::utf16_len(rest) <= 25 {
                return true;
            }
        }
    }
    false
}

fn is_progress_report(text: &str) -> bool {
    PROGRESS_REPORT_WORDS.is_match(text) || contains_progress_phrase(text)
}

/// 요청 글 첫 문장이 과거형 서술로 끝나면 사람이 이미 한 일이나 앞 상황을 알려 주는 맥락이다
fn is_request_narration(sentence: &str) -> bool {
    let no_punct = TRAILING_PUNCT.replace(sentence, "");
    let trimmed = js::trim(&no_punct);
    let no_tail = PAREN_TAIL_SPACED.replace(trimmed, "");
    REQUEST_NARRATION_ENDING.is_match(js::trim(&no_tail))
}

/// 한 줄이 "무엇이 바뀌었는지" 분명히 말하는 서술문인지 본다
fn is_clear_change_sentence(line: &str) -> bool {
    let trimmed = js::trim(line);
    if js::utf16_len(trimmed) < 4 {
        return false;
    }
    if QUESTION_END.is_match(trimmed) {
        return false;
    }
    if SITUATIONAL_WORDS.test(trimmed) {
        return false;
    }
    if is_progress_report(trimmed) {
        return false;
    }
    let (text, generic) = to_commit_mood_detailed(trimmed);
    let converted = js::trim(&text);
    if generic && !VERB_OR_NOUN_END.is_match(converted) {
        return false;
    }
    if js::utf16_len(converted) < 2 {
        return false;
    }
    if BARE_ID_OR_PRONOUN_FRAGMENT.is_match(converted) {
        return false;
    }
    if STATE_DESCRIPTION_ENDING.is_match(converted) {
        return false;
    }
    if DANGLING_OBJECT_PARTICLE.is_match(converted) {
        return false;
    }
    !TRAILING_REQUEST_PHRASING.is_match(converted)
}

static ENV_EXAMPLE_NAME: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"^\.env\.(example|sample)$"));
static README_BASE: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"^readme$"));
static CHANGELOG_BASE: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"^changelog$"));
static EXTENSION: LazyLock<Regex> = LazyLock::new(|| rx(r"\.[^./]+$"));

/// 파일 경로에서 커밋 제목에 쓸 사람이 읽는 영역 이름을 뽑는다
fn file_area_label(file: &str) -> String {
    let name = file.rsplit('/').next().unwrap_or(file);
    if ENV_EXAMPLE_NAME.test(name) {
        return "환경 변수 예시".to_owned();
    }
    let base = EXTENSION.replace(name, "").into_owned();
    if README_BASE.test(&base) {
        return "README".to_owned();
    }
    if CHANGELOG_BASE.test(&base) {
        return "CHANGELOG".to_owned();
    }
    if base.is_empty() {
        name.to_owned()
    } else {
        base
    }
}

/// 바뀐 파일이 전부 added면 "더한다", 전부 deleted면 "지운다", 섞여 있으면 "고친다"
fn describe_verb(changes: &[Change]) -> &'static str {
    let all_added = changes.iter().all(|c| c.change == "added");
    let all_deleted = changes.iter().all(|c| c.change == "deleted");
    if all_deleted {
        "지운다"
    } else if all_added {
        "더한다"
    } else {
        "고친다"
    }
}

fn unique(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|s| seen.insert(s.clone())).collect()
}

/// 요청 글도 에이전트 요약도 분명하지 않을 때 쓰는 마지막 대체 경로: 바뀐 파일 이름에서 영역을 뽑아 최대 2개를 묶는다
fn describe_change_from_files(changes: &[Change]) -> String {
    if changes.is_empty() {
        return "파일을 정리한다".to_owned();
    }
    let labels = unique(changes.iter().map(|c| file_area_label(c.file)).collect());
    let area = if labels.len() > 2 { format!("{} 외 {}개", labels[..2].join("·"), labels.len() - 2) } else { labels.join("·") };
    format!("{area}를 {}", describe_verb(changes))
}

static GENERIC_PATH_SEGMENTS: LazyLock<CiRegex> = LazyLock::new(|| {
    CiRegex::new(r"^(src|main|test|tests|__tests__|spec|specs|java|kotlin|scala|com|org|io|net|app|apps|lib|libs|pkg|packages|internal|migrations?|resources|scripts|dist|build|out|public|assets|config|node_modules|web|api|server|client|components|pages)$")
});

/// 바뀐 파일 경로에서 공통 모듈 이름을 뽑는다. 파일마다 흔한 폴더 이름을 거르고 남은 가장 안쪽 조각을 그 파일의 모듈로 보고,
/// 바뀐 파일 절반 이상에서 같으면 공통 모듈이다
fn common_module_label(changes: &[Change]) -> Option<String> {
    let per_file: Vec<String> = changes
        .iter()
        .filter_map(|c| {
            let mut segments: Vec<&str> = c.file.split('/').collect();
            segments.pop();
            segments.into_iter().rfind(|s| !s.is_empty() && !GENERIC_PATH_SEGMENTS.test(s)).map(str::to_owned)
        })
        .collect();
    if per_file.is_empty() {
        return None;
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for segment in per_file {
        match counts.iter_mut().find(|(s, _)| *s == segment) {
            Some(entry) => entry.1 += 1,
            None => counts.push((segment, 1)),
        }
    }
    let mut best: Option<&(String, usize)> = None;
    for entry in &counts {
        if best.is_none_or(|b| entry.1 > b.1) {
            best = Some(entry);
        }
    }
    let need = changes.len().div_ceil(2);
    best.filter(|b| b.1 >= need).map(|b| b.0.clone())
}

/// 요청 글에서 요구사항 id(R22 등)를 찾고, 바뀐 파일에서 공통 모듈 이름을 찾아 "[R22] shorts 모듈을 고친다" 같은 제목 후보를 만든다
fn requirement_module_candidate(request: &str, changes: &[Change]) -> Option<String> {
    let ids = extract_requirement_ids(request);
    if ids.is_empty() {
        return None;
    }
    let module = common_module_label(changes)?;
    Some(format!("[{}] {module} 모듈을 {}", requirement_id_label(&ids), describe_verb(changes)))
}

static REQUIREMENT_NUMBER: LazyLock<Regex> = LazyLock::new(|| rx(r"^R(\d+)"));

/// 제목에 넣을 요구사항 id 묶음. 시나리오 id(R1.2)는 부모 요구사항(R1)으로 접고 중복을 없앤 뒤 번호순으로 늘어놓고, 셋 이상 이어지는 번호는 범위(R1~R3)로 줄인다
fn requirement_id_label(ids: &[String]) -> String {
    let mut numbers: Vec<f64> = Vec::new();
    for id in ids {
        let n = js::to_number(REQUIREMENT_NUMBER.captures(id).map_or("", |c| c.get(1).map_or("", |m| m.as_str())));
        if n.is_finite() && !numbers.iter().any(|x| x.to_bits() == n.to_bits()) {
            numbers.push(n);
        }
    }
    numbers.sort_by(|a, b| a.partial_cmp(b).expect("유한한 수"));
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < numbers.len() {
        let mut j = i;
        while j + 1 < numbers.len() && numbers[j + 1] == numbers[j] + 1.0 {
            j += 1;
        }
        if j - i >= 2 {
            parts.push(format!("R{}~R{}", js::number_to_string(numbers[i]), js::number_to_string(numbers[j])));
        } else {
            for n in &numbers[i..=j] {
                parts.push(format!("R{}", js::number_to_string(*n)));
            }
        }
        i = j + 1;
    }
    parts.join(", ")
}

/// 후보 글을 남은 글자 수에 맞춰 자른다. 단어 경계에서 끊고, 비어 있으면 "체크포인트"로 대신한다. `max_chars`는 아무 수나 받는다
pub fn summarize(text: &str, max_chars: f64) -> String {
    let trimmed = js::trim(text);
    if trimmed.is_empty() {
        return "체크포인트".to_owned();
    }
    if js::utf16_len(trimmed) as f64 <= max_chars {
        return trimmed.to_owned();
    }
    let cut = slice_head(trimmed, max_chars);
    let units: Vec<u16> = cut.encode_utf16().collect();
    let last_space = units.iter().rposition(|&u| u == 0x20);
    let chosen = match last_space {
        Some(i) if i as f64 > max_chars * 0.5 => String::from_utf16_lossy(&units[..i]),
        _ => cut,
    };
    js::trim(&chosen).to_owned()
}

/// AI 리뷰 고침 요청이면 지적 제목들을 모아 커밋 제목 후보를 만든다
fn review_fix_candidate(request: &str) -> Option<String> {
    extract_pr_review_fix_titles(request).map(|titles| format!("리뷰 지적 {}건 반영 — {}", titles.len(), titles.join(", ")))
}

static SUMMARY_HEADING: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"^#{1,6}\s*(완료\s*)?(요약|summary|변경\s*(내용|사항)|한\s*일)\s*$"));
static HEADING_LINE: LazyLock<Regex> = LazyLock::new(|| rx(r"^#{1,6}\s"));
static BOLD_ONLY_LINE: LazyLock<Regex> = LazyLock::new(|| rx(r"^\*\*[^*]+\*\*\s*(\([^()]*\))?\s*[:：]?$"));
static LIST_MARKER: LazyLock<Regex> = LazyLock::new(|| rx(r"^[-*]\s+"));
static PROBLEM_LINE: LazyLock<Regex> = LazyLock::new(|| rx(r"^(찾은\s*)?(결함|원인|문제|현상|참고|배경|결론|요약|현재\s*상태)\s*[:：]"));
static SCOPE_LINE: LazyLock<CiRegex> = LazyLock::new(|| CiRegex::new(r"^(범위|scope)\s*[:：]"));
static SCOPE_PREFIX: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^(범위|scope)\s*[:：]\s*", true));

/// 에이전트 요약에서 제목 후보로 쓸 한 줄을 고른다. "범위:" 줄이 있으면 그 줄(접두사는 뗀다)을 첫 줄보다 우선한다.
/// "## 요약" 같은 머리글이 있으면 그 뒤의 줄만 본다. 요청이 한국어이면 한글이 없는 줄은 건너뛴다
fn summary_title_line(agent_summary: Option<&str>, prefer_hangul: bool) -> Option<String> {
    let summary = agent_summary.filter(|s| !s.is_empty())?;
    let all: Vec<&str> = summary.split('\n').map(js::trim).collect();
    let heading = all.iter().position(|l| SUMMARY_HEADING.test(l));
    let body: &[&str] = match heading {
        Some(h) => &all[h + 1..],
        None => &all,
    };
    let lines: Vec<String> = body
        .iter()
        .filter(|l| !l.is_empty() && !HEADING_LINE.is_match(l) && !BOLD_ONLY_LINE.is_match(l))
        .map(|l| {
            let no_marker = LIST_MARKER.replace(l, "");
            let no_bold = no_marker.replace("**", "");
            js::trim(&no_bold.replace('`', "")).to_owned()
        })
        .filter(|l| !l.is_empty() && !PROBLEM_LINE.is_match(l))
        .filter(|l| !prefer_hangul || HANGUL.is_match(l))
        .collect();
    match lines.iter().find(|l| SCOPE_LINE.test(l)) {
        Some(scope) => Some(scope_without_prefix(scope)),
        None => lines.into_iter().next(),
    }
}

/// `scope.replace(/^(범위|scope)\s*[:：]\s*/i, '').trim()`. 접두사는 비ASCII 글자를 안 가지므로 바꾼 글에서 찾은 길이만큼 원문을 뗀다
fn scope_without_prefix(scope: &str) -> String {
    let folded = fold_safe(scope);
    let cut = SCOPE_PREFIX.find(&folded).map_or(0, |m| m.end());
    js::trim(&scope[cut..]).to_owned()
}

static SECTION_LABEL: LazyLock<Regex> = LazyLock::new(|| rx(r"^\*\*([^*]+)\*\*\s*(\([^()]*\))?\s*[:：]?$"));
static REPORT_SECTION_LABEL: LazyLock<CiRegex> = LazyLock::new(|| {
    CiRegex::new(r"^(고친|바꾼|수정한|변경한)?\s*(내용|사항|파일|것)$|요약|범위|검증|확인|테스트|결과|한계|남은|다음|결정|주의|배경|원인|참고|summary|verification|notes?$")
});

/// 에이전트 요약이 바뀐 영역마다 굵은 글씨 절 제목을 달았으면 그 제목들을 묶어 제목 후보로 쓴다. 둘 이상이고 예산 안일 때만
fn section_labels_candidate(agent_summary: Option<&str>, budget: f64, prefer_hangul: bool) -> Option<String> {
    let summary = agent_summary.filter(|s| !s.is_empty())?;
    let labels: Vec<String> = summary
        .split('\n')
        .filter_map(|line| {
            let trimmed = js::trim(line);
            let no_marker = LIST_MARKER.replace(trimmed, "");
            SECTION_LABEL.captures(&no_marker).and_then(|c| c.get(1)).map(|m| js::trim(m.as_str()).to_owned())
        })
        .filter(|l| !l.is_empty() && !REPORT_SECTION_LABEL.test(l))
        .filter(|l| !prefer_hangul || HANGUL.is_match(l))
        .collect();
    let labels = unique(labels);
    if labels.len() < 2 {
        return None;
    }
    let joined = labels.join(", ");
    if js::utf16_len(&joined) as f64 <= budget {
        Some(joined)
    } else {
        None
    }
}

static PATH_RUN: LazyLock<Regex> = LazyLock::new(|| rx(r"(?:[\w.@-]+\/){2,}([\w.@-]+)"));

/// 폴더가 두 단계 이상인 파일 경로를 마지막 이름만 남긴다. 제목이 예산을 넘을 때만 쓴다
fn shorten_paths(text: &str) -> String {
    PATH_RUN.replace_all(text, "${1}").into_owned()
}

/// 부탁하는 말투를 커밋 문체로 바꾸는 규칙. 앞에서부터 처음 맞는 것 하나만 쓴다. 마지막은 부탁 어미만 지우는 대체 규칙이다
static MOOD_ENDINGS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let verb = |stem: &str, to: &'static str| (rx(&format!(r"{stem}\s*(줘|주세요|주십시오)$")), to);
    vec![
        verb("만들어", "만든다"),
        verb("고쳐", "고친다"),
        verb("바꿔", "바꾼다"),
        verb("써", "쓴다"),
        verb("넣어", "넣는다"),
        verb("보여", "보여 준다"),
        verb("없애", "없앤다"),
        verb("지워", "지운다"),
        verb("옮겨", "옮긴다"),
        verb("나눠", "나눈다"),
        verb("붙여", "붙인다"),
        verb("맞춰", "맞춘다"),
        verb("줄여", "줄인다"),
        verb("늘려", "늘린다"),
        verb("올려", "올린다"),
        verb("남겨", "남긴다"),
        verb("돌려", "돌린다"),
        verb("적어", "적는다"),
        verb("막아", "막는다"),
        (rx(r"(\S+)해\s*(줘|주세요|주십시오)$"), "${1}한다"),
        (rx(r"게\s+해\s*(줘|주세요|주십시오)$"), "게 한다"),
        (rx(r"([^\s을를은는걸])\s+해\s*(줘|주세요|주십시오)$"), "${1}한다"),
        (rx(r"\s*(해\s*)?(줘|주세요|주십시오)$"), ""),
    ]
});
static PAREN_TAIL: LazyLock<Regex> = LazyLock::new(|| rx(r"\s*(\([^()]*\))$"));

/// 부탁하는 말투("만들어 줘.")를 커밋 문체("만든다")로 바꾼다. 흔한 끝맺음만 바꾸고, 모르는 끝맺음은 그대로 둔다
pub fn to_commit_mood(text: &str) -> String {
    to_commit_mood_detailed(text).0
}

/// `to_commit_mood`와 같지만 마지막 대체 규칙(부탁 어미만 지움)만 맞았는지도 돌려준다
fn to_commit_mood_detailed(text: &str) -> (String, bool) {
    let stripped = TRAILING_PUNCT.replace(text, "");
    let mut result = js::trim(&stripped).to_owned();
    let mut generic = false;
    // "옮겨 주세요(R32)"처럼 끝에 괄호 꼬리가 붙으면 어미 규칙이 끝($)을 못 찾는다. 꼬리를 떼고 어미를 바꾼 뒤 다시 붙인다
    let tail = PAREN_TAIL.captures(&result).map(|c| (c.get(0).map_or(0, |m| m.start()), c[1].to_owned()));
    if let Some((index, _)) = &tail {
        result = js::trim(&result[..*index]).to_owned();
    }
    let last = MOOD_ENDINGS.len() - 1;
    for (i, (pattern, replacement)) in MOOD_ENDINGS.iter().enumerate() {
        if pattern.is_match(&result) {
            generic = i == last;
            result = js::trim(&pattern.replace(&result, *replacement)).to_owned();
            break;
        }
    }
    match tail {
        Some((_, paren)) => (format!("{result}{paren}"), generic),
        None => (result, generic),
    }
}

/// 요청 글과 바뀐 파일, (있으면) 에이전트 요약에서 체크포인트 커밋 제목을 만든다. "타입: 한국어 요약" 형식이고 72자를 넘지 않는다.
/// 0. AI 리뷰 고침 요청이면 지적 제목들로. 1. 요청 글 첫 문장이 분명하면 그것. 2. 아니면 에이전트 요약에서 고른 줄. 3. 요구사항 id와 공통 모듈.
/// 4. 요약의 절 제목들, 없으면 바뀐 파일 이름. 5. 요청 글이 비었으면 "체크포인트"
pub fn generate_commit_subject(request: &str, changes: &[Change], agent_summary: Option<&str>, request_is_answer: bool) -> String {
    let kind = classify_commit(request, changes);
    let budget = (MAX_SUBJECT_CHARS - kind.len() - 2) as f64;

    let request_first_line = first_line_collapsed(request);
    let summary_line = summary_title_line(agent_summary, HANGUL.is_match(request)).filter(|l| !l.is_empty());

    let candidate = if let Some(review_fix) = review_fix_candidate(request) {
        review_fix
    } else if !request_is_answer
        && !request_first_line.is_empty()
        && !is_request_narration(first_sentence(&request_first_line))
        && is_clear_change_sentence(first_sentence(&request_first_line))
    {
        to_commit_mood(first_sentence(&request_first_line))
    } else if let Some(line) = summary_line
        .as_deref()
        .filter(|l| is_clear_change_sentence(first_sentence(l)) && js::utf16_len(&shorten_paths(&to_commit_mood(first_sentence(l)))) as f64 <= budget)
    {
        // 요약 줄은 예산 안에 들어갈 때만 쓴다. 잘린 요약은 동사가 사라져 바뀐 파일로 만든 제목보다 못하다
        to_commit_mood(first_sentence(line))
    } else if !request_first_line.is_empty() {
        requirement_module_candidate(request, changes)
            .or_else(|| section_labels_candidate(agent_summary, budget, HANGUL.is_match(request)))
            .unwrap_or_else(|| describe_change_from_files(changes))
    } else {
        "체크포인트".to_owned()
    };

    let fitted = if js::utf16_len(&candidate) as f64 > budget { shorten_paths(&candidate) } else { candidate };
    format!("{kind}: {}", summarize(&fitted, budget))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modified(files: &[&'static str]) -> Vec<Change<'static>> {
        files.iter().map(|file| Change { file, change: "modified" }).collect()
    }

    #[test]
    fn 정규식_대소문자는_ascii만_접는다() {
        // 켈빈 기호와 긴 s는 JS(/i)가 k·s로 보지 않는다
        assert_eq!(classify_commit("x", &modified(&["a/src/test/\u{212A}otlin/A.kt"])), "feat");
        assert_eq!(classify_commit("x", &modified(&["A/TESTS/x.PY"])), "test");
        assert_eq!(classify_commit("x", &modified(&["a/\u{017F}rc/test/java/A.java"])), "feat");
        assert_eq!(classify_commit("\u{212A}ix", &[]), "feat");
        assert_eq!(classify_commit("FIX", &[]), "fix");
    }

    #[test]
    fn 이미_있었_규칙은_utf16_단위_25개까지다() {
        assert!(contains_progress_phrase(&format!("이미 {}있었", "가".repeat(25))));
        assert!(!contains_progress_phrase(&format!("이미 {}있었", "가".repeat(26))));
        assert!(contains_progress_phrase(&format!("이미 {}있었", "\u{1F600}".repeat(12))));
        assert!(!contains_progress_phrase(&format!("이미 {}있었", "\u{1F600}".repeat(13))));
        assert!(contains_progress_phrase(&format!("이미 {}있었", " ".repeat(40))));
        assert!(!contains_progress_phrase("이미 가\n나 있었"));
        assert!(!contains_progress_phrase("있었 이미"));
    }

    #[test]
    fn 제목은_타입과_한국어_요약이고_예산을_넘지_않는다() {
        assert_eq!(generate_commit_subject("로그인 기능을 만들어 주세요.", &modified(&["a.ts"]), None, false), "feat: 로그인 기능을 만든다");
        assert_eq!(generate_commit_subject("", &[], None, false), "feat: 체크포인트");
        let long = generate_commit_subject(&format!("{} 만들어 주세요", "가".repeat(80)), &modified(&["a.ts"]), None, false);
        assert!(js::utf16_len(&long) <= 72);
    }

    #[test]
    fn 요구사항_번호는_셋_이상_이어지면_범위로_줄인다() {
        let ids = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(requirement_id_label(&ids(&["R1", "R2"])), "R1, R2");
        assert_eq!(requirement_id_label(&ids(&["R3", "R1", "R2", "R1.2"])), "R1~R3");
        assert_eq!(requirement_id_label(&ids(&["R1", "R3", "R5"])), "R1, R3, R5");
        assert_eq!(requirement_id_label(&ids(&["R007"])), "R7");
    }

    #[test]
    fn 요약은_단어_경계에서_끊고_상한과_같으면_그대로_둔다() {
        assert_eq!(summarize("abc def ghi", 11.0), "abc def ghi");
        assert_eq!(summarize("abc def ghi", 10.0), "abc def");
        assert_eq!(summarize("abcdefg hij", 10.0), "abcdefg");
        assert_eq!(summarize("a bcdefghij", 10.0), "a bcdefghi");
        assert_eq!(summarize("   ", 10.0), "체크포인트");
    }

    #[test]
    fn 말투는_커밋_문체로_바꾸고_괄호_꼬리는_다시_붙인다() {
        assert_eq!(to_commit_mood("로그인 만들어 줘."), "로그인 만든다");
        assert_eq!(to_commit_mood("옮겨 주세요(R32)"), "옮긴다(R32)");
        assert_eq!(to_commit_mood("재생되게 해 주세요"), "재생되게 한다");
        assert_eq!(to_commit_mood("R25를 해 주세요"), "R25를");
    }
}
