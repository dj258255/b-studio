//! "문서" 탭(ADR-094)의 순수 판정(ADR-191 3단계 3k). 옛 `packages/agent/src/docs.ts`: 제목의 파일 이름 조각(slug), 다음 설계 문서·ADR 번호,
//! 문서 경로, 새 문서·기록 항목 템플릿, 기록 덧붙이기, 로드맵 진행 현황과 `docs/README.md` 색인 다시 만들기, 문서 요약 뽑기.
//!
//! 정규식은 모두 손으로 옮겼다(JS 되돌아감 우선순위를 따라): `^docs\/(\d{2,})-.+\.md$`, `^docs\/adr\/ADR-(\d{3,})-.+\.md$`, `^#\s+(.+?)\s*$`.
//! `\s`는 JS 공백(`js::is_js_whitespace`), `.`은 줄 끝 글자 넷(`\n \r U+2028 U+2029`)을 빼고 읽는다.
//!
//! 경로 안전: slug·경로는 옛 구현과 글자까지 같다(넓히지도 좁히지도 않는다). slug는 `\ / : * ? " < > |`를 지우고 공백을 `-`로 바꾸며,
//! 경로는 늘 `docs/NN-` 또는 `docs/adr/ADR-NNN-`로 시작하므로 slug가 `..`여도 폴더 밖을 가리키지 못한다.
//!
//! 의도한 차이:
//! - 색인 표의 정렬(`localeCompare`)은 `js_locale`의 근사다. ASCII는 ICU와 같고 그 밖의 글자는 코드 포인트 순서다
//!   (ICU는 Han이 Hangul 뒤, 악센트 글자는 밑글자와 같은 1차 가중치, 정규화가 다른 같은 글자를 같게 본다). 표 줄의 순서에만 영향이 있고 경로·내용은 같다.
//! - 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다.
//! - 색인 요약 목록(JSON)의 모양이 어긋나면(문자열이 아닌 path·title·paragraph) 던진다. 옛 구현은 `undefined`를 글자로 찍었다.

use crate::js;
use crate::js_json::{self, JsValue};
use crate::js_locale::locale_compare;

pub const ROADMAP_STATUS_START: &str = "<!-- b-studio:roadmap-status -->";
pub const ROADMAP_STATUS_END: &str = "<!-- /b-studio:roadmap-status -->";
pub const DOCS_INDEX_START: &str = "<!-- b-studio:docs-index -->";
pub const DOCS_INDEX_END: &str = "<!-- /b-studio:docs-index -->";
const TROUBLESHOOTING_LOG_PATH: &str = "docs/TROUBLESHOOTING-LOG.md";
const ROADMAP_TRADEOFFS_PATH: &str = "docs/ROADMAP-TRADEOFFS.md";

/// 번호를 두 자리 이상으로 0으로 채운다(`n < 10 ? "0"+n : n`). 소수·음수·NaN도 JS 글자 그대로
pub(crate) fn pad(n: f64) -> String {
    if n < 10.0 {
        format!("0{}", js::number_to_string(n))
    } else {
        js::number_to_string(n)
    }
}

/// ADR 번호는 세 자리 이상
fn pad_adr(n: f64) -> String {
    if n < 100.0 {
        format!("0{}", pad(n))
    } else {
        js::number_to_string(n)
    }
}

/// 제목을 파일 이름 조각으로: trim → `\ / : * ? " < > |` 지움 → 공백 묶음을 `-` → `-` 묶음을 `-` 하나 → 앞뒤 `-` 제거 → 비면 `제목-없음`
pub fn slugify_title(title: &str) -> String {
    let trimmed = js::trim(title);
    let mut dashed = String::new();
    let mut in_ws = false;
    for c in trimmed.chars() {
        if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            continue; // 지운 자리는 앞뒤 글자를 이어 붙인다(공백 묶음 판정도 이어진다: `a / b`는 `a  b`)
        }
        if js::is_js_whitespace(c) {
            if !in_ws {
                dashed.push('-');
                in_ws = true;
            }
        } else {
            dashed.push(c);
            in_ws = false;
        }
    }
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for c in dashed.chars() {
        if c == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    let slug = collapsed.trim_matches('-');
    if slug.is_empty() {
        "제목-없음".to_owned()
    } else {
        slug.to_owned()
    }
}

/// `^<prefix>(\d{min,})-.+\.md$`의 숫자 묶음. 숫자는 ASCII뿐, `.+`는 줄 끝 글자를 못 먹고, 끝은 `.md`(그 앞에 한 글자 이상)
pub(crate) fn numbered_path(path: &str, prefix: &str, min_digits: usize) -> Option<f64> {
    let rest = path.strip_prefix(prefix)?;
    let digit_len = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digit_len < min_digits {
        return None;
    }
    let after = rest[digit_len..].strip_prefix('-')?;
    let stem = after.strip_suffix(".md")?;
    if stem.is_empty() || after.chars().any(js::is_js_line_terminator) {
        return None;
    }
    // Number("099")=99, Number("9…9")(309자리 이상)=Infinity. Rust의 f64 파싱도 같은 값으로 반올림한다
    rest[..digit_len].parse::<f64>().ok()
}

pub(crate) fn next_number(existing: &[String], prefix: &str, min_digits: usize) -> f64 {
    let max = existing.iter().fold(0.0_f64, |acc, path| match numbered_path(path, prefix, min_digits) {
        Some(n) => acc.max(n),
        None => acc,
    });
    max + 1.0
}

/// 기존 문서 경로들에서 다음 번호 매긴 설계 문서 번호(비어 있으면 1)
pub fn next_design_doc_number(existing: &[String]) -> f64 {
    next_number(existing, "docs/", 2)
}

/// 기존 문서 경로들에서 다음 ADR 번호(비어 있으면 1)
pub fn next_adr_number(existing: &[String]) -> f64 {
    next_number(existing, "docs/adr/ADR-", 3)
}

/// `docs/NN-제목.md`
pub fn design_doc_file_path(number: f64, title: &str) -> String {
    format!("docs/{}-{}.md", pad(number), slugify_title(title))
}

/// `docs/adr/ADR-NNN-제목.md`
pub fn adr_file_path(number: f64, title: &str) -> String {
    format!("docs/adr/ADR-{}-{}.md", pad_adr(number), slugify_title(title))
}

const DECISION_DOC_BODY: &str = r#"## 문제

(무엇이 문제인지 적습니다)

## 왜 문제라고 판단했나

(관측한 사실·수치를 적습니다 — "느리다" 대신 "p95 850ms" 같이 측정 가능한 근거를 적습니다)

## 가설

(이 문제의 원인이나 해결 방향에 대한 반증 가능한 가설을 적습니다)

## 선택지

| 선택지 | 얻는 것 | 잃는 것 |
| --- | --- | --- |

## 판단 기준

(선택지 중 하나를 고를 때 무엇을 기준으로 판단했는지 적습니다)

## 결정

(최종 결정과 그 이유를 적습니다)

## 포기한 것

(이 결정으로 포기한 선택지와 그 이유, 아직 검증하지 못한 범위를 적습니다)

## 검증

(무엇을 어떤 조건에서 측정했는지, 결과가 무엇인지 적습니다)

## 예상과 실제

(결정할 때 예상한 것과 실제 결과가 어떻게 달랐는지 적습니다. 다르지 않았다면 그 사실도 적습니다)
"#;

/// 설계 문서 템플릿
pub fn build_design_doc_template(number: f64, title: &str) -> String {
    format!("# {}. {title}\n\n{title}에 관한 설계 문서입니다.\n\n{DECISION_DOC_BODY}", pad(number))
}

/// ADR 템플릿. `date`는 TS 껍데기가 `toISOString().slice(0, 10)`으로 만들어 넘긴다(잘못된 Date는 껍데기에서 던진다)
pub fn build_adr_template(number: f64, title: &str, date: &str, related: &[String]) -> String {
    let related_line = if related.is_empty() { "(관련 문서·이슈를 적습니다)".to_owned() } else { related.join(", ") };
    format!("# ADR-{}. {title}\n\n- 상태: 제안 (Proposed)\n- 날짜: {date}\n- 관련: {related_line}\n\n{DECISION_DOC_BODY}", pad_adr(number))
}

/// 거짓 값(빈 글자)이면 안내 문구
fn or_hint<'a>(value: &'a str, hint: &'a str) -> &'a str {
    if value.is_empty() {
        hint
    } else {
        value
    }
}

/// 기록 항목 하나. `kind`: troubleshooting(증상·원인·해결) | roadmap-tradeoff(후보·트레이드오프) | verification(여섯 칸) | experiment(가설·방법·결과·결론).
/// `fields`는 종류마다 정해진 순서(위 괄호), 모자라면 빈 글자
pub fn build_entry(kind: &str, title: &str, fields: &[String]) -> Result<String, String> {
    let f = |i: usize| fields.get(i).map(String::as_str).unwrap_or("");
    Ok(match kind {
        "troubleshooting" => format!(
            "### {title}\n\n- 증상: {}\n- 원인: {}\n- 해결: {}\n",
            or_hint(f(0), "(무엇이 어떻게 잘못됐는지 적습니다)"),
            or_hint(f(1), "(원인을 적습니다)"),
            or_hint(f(2), "(해결 방법이나 지금 상태를 적습니다)")
        ),
        "roadmap-tradeoff" => format!(
            "### {title}\n\n- 후보: {}\n- 트레이드오프: {}\n",
            or_hint(f(0), "(검토 중인 선택지를 적습니다)"),
            or_hint(f(1), "(얻는 것과 잃는 것을 적습니다)")
        ),
        "verification" => format!(
            "### {title}\n\n- 가설: {}\n- 조건: {}\n- 관측값: {}\n- 예상과 다른 점: {}\n- 배제한 원인: {}\n- 다음 확인: {}\n",
            or_hint(f(0), "(반증 가능한 한 문장을 적습니다)"),
            or_hint(f(1), "(무엇을 어떤 조건에서 측정했는지 적습니다 — 환경·반복 횟수·고정한 변수)"),
            or_hint(f(2), "(실제로 측정한 수치를 적습니다)"),
            or_hint(f(3), "(가설과 어긋난 관측이 있으면 적습니다. 없으면 \"없음\")"),
            or_hint(f(4), "(무엇을 확인해 배제했는지 적습니다)"),
            or_hint(f(5), "(남은 질문과 다음에 확인할 것을 적습니다)")
        ),
        "experiment" => format!(
            "### {title}\n\n- 가설: {}\n- 방법: {}\n- 결과: {}\n- 결론: {}\n",
            or_hint(f(0), "(반증 가능한 한 문장을 적습니다)"),
            or_hint(f(1), "(무엇을 어떻게 비교했는지 적습니다 — 과제·모델·반복 횟수·고정한 변수)"),
            or_hint(f(2), "(측정한 수치를 그대로 적습니다. 가설이 틀렸어도 결과로 남깁니다)"),
            or_hint(f(3), "(이 결과가 적용되는 범위를 한정해 적습니다)")
        ),
        other => return Err(format!("알 수 없는 기록 종류: {other}")),
    })
}

/// 기록 파일에 항목을 이어 붙인다. 파일이 없거나 공백뿐이면 그 종류의 제목을 먼저 만든다
pub fn append_entry(kind: &str, existing: Option<&str>, entry: &str) -> Result<String, String> {
    let header = match kind {
        "troubleshooting" => "# 트러블슈팅 기록\n\n이 문서는 지금 무엇이 열려 있고, 닫은 것은 어떻게 닫았는지를 한 곳에 모읍니다.",
        "roadmap-tradeoff" => "# 트레이드오프 후보 로드맵\n\n이 문서는 검토 중인 선택지와 그 트레이드오프를 모읍니다.",
        "verification" => "# 검증 기록\n\n이 문서는 \"구현되어 있음\"과 \"실제로 측정해 확인함\"을 구분합니다. 가설·조건·관측값을 남겨 다음에 같은 조건으로 다시 잴 수 있게 합니다.",
        "experiment" => "# 실험 기록\n\n이 문서는 검증할 가설과 그 결과를 날짜 순으로 모읍니다. 틀린 가설도 결과로 남깁니다.",
        other => return Err(format!("알 수 없는 기록 종류: {other}")),
    };
    let base = match existing {
        Some(text) if !js::trim(text).is_empty() => js::trim_end(text),
        _ => header,
    };
    Ok(format!("{base}\n\n{}\n", js::trim(entry)))
}

/// ROADMAP 템플릿
pub fn build_roadmap_template() -> String {
    format!(
        r#"# 로드맵

## 단계

- [ ] POC
- [ ] MVP
- [ ] Beta
- [ ] v1

(지금 어느 단계를 밟고 있는지 체크하고, 각 단계에서 끝내야 할 것을 적습니다)

## 마일스톤

(마일스톤과 예상 날짜를 적습니다. 예상이 틀렸으면 날짜를 고치지 말고 옆에 실제 날짜와 이유를 덧붙입니다)

## 현재 위치

(지금 무엇을 끝냈고 무엇이 남았는지 적습니다)

## 진행 현황

{ROADMAP_STATUS_START}
아직 집계하지 않았습니다. "ROADMAP 갱신"을 눌러 요구사항 상태를 반영하세요.
{ROADMAP_STATUS_END}
"#
    )
}

/// 진행 현황 몸통: 상태별 개수 표 + 필수·권장 진행 한 줄
fn build_roadmap_status_body(statuses: &[String], counts: &[f64], must: (f64, f64), should: (f64, f64)) -> String {
    if statuses.is_empty() {
        return "아직 저장된 요구사항이 없습니다. \"요구사항\" 탭에서 먼저 명세를 뽑아 저장하세요.".to_owned();
    }
    let rows: Vec<String> = statuses.iter().zip(counts.iter()).map(|(status, count)| format!("| {status} | {} |", js::number_to_string(*count))).collect();
    let table = format!("| 상태 | 개수 |\n| --- | --- |\n{}", rows.join("\n"));
    let progress = format!(
        "필수(must) 진행: {}/{} · 권장(should) 진행: {}/{}",
        js::number_to_string(must.1),
        js::number_to_string(must.0),
        js::number_to_string(should.1),
        js::number_to_string(should.0)
    );
    format!("{table}\n\n{progress}")
}

/// `docs/ROADMAP.md`의 진행 현황 구간만 다시 만든다. 표지가 없거나 끝 표지가 시작 표지보다 앞서면 글 끝에 새로 덧붙인다.
/// `must`·`should`는 (total, done). 표지는 처음 나온 자리만 본다(코드 블록 안인지 가리지 않는다. 옛 구현과 같다)
pub fn regenerate_roadmap_status(existing: Option<&str>, statuses: &[String], counts: &[f64], must: (f64, f64), should: (f64, f64)) -> String {
    let body = build_roadmap_status_body(statuses, counts, must, should);
    let managed = format!("{ROADMAP_STATUS_START}\n{body}\n{ROADMAP_STATUS_END}");
    let template;
    let base = match existing {
        Some(text) if !js::trim(text).is_empty() => text,
        _ => {
            template = build_roadmap_template();
            template.as_str()
        }
    };
    match (base.find(ROADMAP_STATUS_START), base.find(ROADMAP_STATUS_END)) {
        (Some(start), Some(end)) if end >= start => format!("{}{managed}{}", &base[..start], &base[end + ROADMAP_STATUS_END.len()..]),
        _ => format!("{}\n\n## 진행 현황\n\n{managed}\n", js::trim_end(base)),
    }
}

/// `/^#\s+(.+?)\s*$/.exec(line)?.[1]`. `line`에는 `\n`이 없다(`\r`·U+2028·U+2029는 있을 수 있다)
fn heading_title(line: &str) -> Option<String> {
    let rest = line.strip_prefix('#')?;
    let chars: Vec<char> = rest.chars().collect();
    let lead = chars.iter().take_while(|c| js::is_js_whitespace(**c)).count();
    if lead == 0 {
        return None;
    }
    if lead == chars.len() {
        // 공백뿐: `\s+`가 한 글자씩 물러나며, `.+?`가 줄 끝 글자가 아닌 글자 하나를 먹는 가장 큰 k(1 이상)를 찾는다
        let k = (1..lead).rev().find(|&k| !js::is_js_line_terminator(chars[k]))?;
        return Some(chars[k].to_string());
    }
    // `\s+`가 공백을 모두 먹고, `.+?`가 끝 공백을 뺀 나머지를 먹는다. 그 안에 줄 끝 글자가 있으면 어떤 물러남도 맞지 않는다
    let tail = &chars[lead..];
    let end = tail.iter().rposition(|c| !js::is_js_whitespace(*c)).map(|i| i + 1)?;
    let title = &tail[..end];
    if title.iter().any(|c| js::is_js_line_terminator(*c)) {
        return None;
    }
    Some(title.iter().collect())
}

/// `/^#{1,6}\s/`
fn starts_with_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&hashes) && line[hashes..].chars().next().is_some_and(js::is_js_whitespace)
}

/// `/^(<!--|\||-\s|\d+[.)]\s)/`
fn starts_block(line: &str) -> bool {
    if line.starts_with("<!--") || line.starts_with('|') {
        return true;
    }
    if let Some(rest) = line.strip_prefix('-') {
        return rest.chars().next().is_some_and(js::is_js_whitespace);
    }
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let mut after = line[digits..].chars();
    matches!(after.next(), Some('.') | Some(')')) && after.next().is_some_and(js::is_js_whitespace)
}

/// `markdown.split(/\r?\n/)`
pub(crate) fn split_lines(markdown: &str) -> Vec<&str> {
    let parts: Vec<&str> = markdown.split('\n').collect();
    let last = parts.len() - 1;
    parts.iter().enumerate().map(|(i, p)| if i < last { p.strip_suffix('\r').unwrap_or(p) } else { p }).collect()
}

/// 첫 H1과 그 뒤 첫 문단. H1이 없으면 둘 다 빈 글자
pub fn extract_doc_summary(markdown: &str) -> (String, String) {
    let lines = split_lines(markdown);
    let Some((title_index, title)) = lines.iter().enumerate().find_map(|(i, line)| heading_title(line).map(|t| (i, t))) else {
        return (String::new(), String::new());
    };
    let mut paragraph: Vec<&str> = Vec::new();
    for raw in &lines[title_index + 1..] {
        let line = js::trim(raw);
        if line.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if starts_with_heading(line) || starts_block(line) {
            break;
        }
        paragraph.push(line);
    }
    (title, paragraph.join(" "))
}

/// 문서 하나의 요약. 제목이 없으면 파일 이름(확장자 `.md`를 뺀 마지막 조각)
pub fn build_doc_summary(path: &str, markdown: &str) -> (String, String, String) {
    let (title, paragraph) = extract_doc_summary(markdown);
    let last = path.rsplit('/').next().unwrap_or(path);
    let fallback = last.strip_suffix(".md").unwrap_or(last);
    let title = if title.is_empty() { fallback.to_owned() } else { title };
    (path.to_owned(), title, paragraph)
}

/// 색인 정렬 키: 설계 문서(번호순) → ADR(번호순) → 트러블슈팅·트레이드오프 → 그 밖
fn sort_key(path: &str) -> (f64, f64) {
    if let Some(n) = numbered_path(path, "docs/", 2) {
        return (0.0, n);
    }
    if let Some(n) = numbered_path(path, "docs/adr/ADR-", 3) {
        return (1.0, n);
    }
    if path == TROUBLESHOOTING_LOG_PATH {
        return (2.0, 0.0);
    }
    if path == ROADMAP_TRADEOFFS_PATH {
        return (2.0, 1.0);
    }
    (3.0, 0.0)
}

#[derive(Clone)]
struct DocSummary {
    path: String,
    title: String,
    paragraph: String,
}

fn compare_docs(a: &DocSummary, b: &DocSummary) -> f64 {
    let (ka, kb) = (sort_key(&a.path), sort_key(&b.path));
    if ka.0 != kb.0 {
        return ka.0 - kb.0;
    }
    if ka.1 != kb.1 {
        return ka.1 - kb.1;
    }
    locale_compare(&a.path, &b.path)
}

fn build_index_table(docs: Vec<DocSummary>) -> String {
    if docs.is_empty() {
        return "아직 문서가 없습니다. \"새 문서\"로 설계 문서·ADR·트러블슈팅·로드맵을 만들어 보세요.".to_owned();
    }
    let sorted = js::stable_sort_by(docs, &compare_docs);
    let rows: Vec<String> = sorted
        .iter()
        .map(|doc| {
            let label = doc.path.strip_prefix("docs/").unwrap_or(&doc.path);
            let content = or_hint(&doc.paragraph, "(요약 없음)");
            format!("| [{}]({label}) | {content} |", doc.title)
        })
        .collect();
    format!("| 문서 | 확인할 내용 |\n| --- | --- |\n{}", rows.join("\n"))
}

fn parse_summaries(docs_json: &str) -> Result<Vec<DocSummary>, String> {
    let JsValue::Arr(items) = js_json::parse_native(docs_json)? else {
        return Err("문서 요약 목록은 배열이어야 합니다".to_owned());
    };
    items
        .iter()
        .map(|item| {
            let JsValue::Obj(object) = item else {
                return Err("문서 요약은 객체여야 합니다".to_owned());
            };
            let field = |name: &str| match object.get(name) {
                Some(JsValue::Str(s)) => Ok(s.clone()),
                _ => Err(format!("문서 요약의 {name}은 글자여야 합니다")),
            };
            Ok(DocSummary { path: field("path")?, title: field("title")?, paragraph: field("paragraph")? })
        })
        .collect()
}

/// `docs/README.md`의 색인 구간만 다시 만든다. README가 없거나 공백뿐이면 새 머리말과 구간만, 표지가 없거나 끝 표지가 앞서면 글 끝에 덧붙인다
pub fn regenerate_docs_readme(existing: Option<&str>, docs_json: &str) -> Result<String, String> {
    let table = build_index_table(parse_summaries(docs_json)?);
    let managed = format!("{DOCS_INDEX_START}\n{table}\n{DOCS_INDEX_END}");
    let Some(text) = existing.filter(|text| !js::trim(text).is_empty()) else {
        return Ok(format!("# 문서\n\n{managed}\n"));
    };
    Ok(match (text.find(DOCS_INDEX_START), text.find(DOCS_INDEX_END)) {
        (Some(start), Some(end)) if end >= start => format!("{}{managed}{}", &text[..start], &text[end + DOCS_INDEX_END.len()..]),
        _ => format!("{}\n\n{managed}\n", js::trim_end(text)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug() {
        assert_eq!(slugify_title("결제 도메인 핵심 개념"), "결제-도메인-핵심-개념");
        assert_eq!(slugify_title("질문: \"이게 맞나?\" / 확인"), "질문-이게-맞나-확인");
        assert_eq!(slugify_title("   "), "제목-없음");
        assert_eq!(slugify_title("../etc"), "..etc");
        assert_eq!(slugify_title("a\\b"), "ab");
    }

    #[test]
    fn numbers() {
        let paths = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(next_design_doc_number(&[]), 1.0);
        assert_eq!(next_design_doc_number(&paths(&["docs/09-a.md", "docs/10-b.md"])), 11.0);
        assert_eq!(next_adr_number(&paths(&["docs/adr/ADR-001-a.md", "docs/adr/ADR-010-b.md", "docs/09-not-adr.md"])), 11.0);
        assert_eq!(next_adr_number(&paths(&["docs/adr/ADR-99-a.md"])), 1.0);
        assert_eq!(design_doc_file_path(5.0, "x"), "docs/05-x.md");
        assert_eq!(adr_file_path(5.0, "x"), "docs/adr/ADR-005-x.md");
        assert_eq!(adr_file_path(100.0, "x"), "docs/adr/ADR-100-x.md");
    }

    #[test]
    fn heading_regex() {
        assert_eq!(heading_title("# 제목  "), Some("제목".into()));
        assert_eq!(heading_title("#제목"), None);
        assert_eq!(heading_title("#  "), Some(" ".into()));
        assert_eq!(heading_title("# "), None);
        assert_eq!(heading_title("# a\u{2028}b"), None);
    }

    #[test]
    fn roadmap_region() {
        let out = regenerate_roadmap_status(None, &[], &[], (0.0, 0.0), (0.0, 0.0));
        assert!(out.contains("아직 저장된 요구사항이 없습니다."));
        assert!(out.starts_with("# 로드맵\n"));
    }
}
