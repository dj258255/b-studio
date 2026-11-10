//! 동적 경로(`app/orders/[id]/page.tsx`)에 채운 값이 같은 주소 자리의 고정 경로와 겹치는지의 판정(ADR-159 결정 11, ADR-191 3단계 3aa).
//! 옛 TS: `packages/agent/src/next-static-shadow-legacy.ts`. 막는 판정이다: 겹침과 "모름"은 값을 받지 않는다.
//!
//! 폴더 읽기(`readdir`·`lstat`)는 TS 껍데기가 한다. 경계는 **한 번에 하나씩 되묻는 단계 함수**다: `step`은 지금까지 읽은 것(`Known`)으로
//! 옛 구현과 같은 순서로 판정을 돌리다가, 아직 읽지 않은 폴더나 경로를 만나면 그것 하나를 `Need`로 돌려준다. 껍데기가 읽어 `Known`에 더하고
//! 다시 부른다. 읽는 폴더와 순서가 옛 구현과 같고(만나기 전에는 읽지 않는다), 살펴볼 폴더 상한은 읽기 전에 본다(매 호출이 처음부터 다시
//! 세므로 읽은 수가 아니라 걸어 본 폴더 수다). 읽지 못한 폴더·확인하지 못한 경로는 `Known`에 오류로 들어오고, 그 폴더를 실제로 걸을 때만 "모름"이 된다.
//!
//! 경로는 프로젝트 루트 기준 상대 경로 문자열이다(루트 자체는 나오지 않는다: 모든 경로는 한 조각 이상이다). 서비스 폴더 조각이나 채운 값이
//! 빈 조각·`.`·`..`이거나(채운 값은 `/`를 품어도) 경로를 어긋나게 읽을 수 있는 꼴이면 `path.join`의 줄이기를 흉내 내지 않고 "모름"으로 처리한다
//! (옛 구현은 줄여서 읽었다. 더 막는 쪽의 의도한 차이).
//!
//! 이름 견주기(거부 목록: 틀려도 더 막을 뿐): 옛 접기(`%` 인코딩 풀기·첫 점 앞·소문자) **또는** `path_policy::fold_name`으로 넓게 접은 꼴이 같으면 겹친다.
//! 그룹 `(x)`는 이름에 줄 끝 글자가 있거나 안이 비어도(`()`) 그룹으로 본다(옛 구현의 `.+`는 못 먹었다). 옛 구현이 일반 이름으로 읽던 길도 그대로 함께 본다.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};

use crate::js::is_js_line_terminator;
use crate::path_policy::fold_name;

/// 살펴볼 폴더 수 상한 기본값
pub const DEFAULT_MAX_FOLDERS: f64 = 2_000.0;
/// 주소를 받는 폴더들(서비스 폴더 기준). 프로젝트가 어느 쪽을 쓰는지 가리지 않고 모두 본다
const ROUTER_ROOTS: [&str; 4] = ["app", "src/app", "pages", "src/pages"];
const PAGE_EXTENSIONS: [&str; 5] = ["tsx", "jsx", "ts", "js", "mdx"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub service_path: String,
    pub page_file: String,
    /// 동적 세그먼트 이름 → 채운 값
    pub values: HashMap<String, String>,
    /// 확인할 동적 세그먼트 이름
    pub check: Vec<String>,
    pub max_folders: Option<f64>,
}

/// 껍데기가 읽은 것. `lstat`: 경로 → `missing`(ENOENT·ENOTDIR)·`error`·`link`·`dir`·`other`.
/// `readdir`: 폴더 → 읽지 못했으면 null, 아니면 `[이름, l(링크)|d(폴더)|f(그 밖)]`을 읽은 순서대로. 모르는 글자는 링크로 읽는다(걸린 쪽)
#[derive(Deserialize, Default)]
pub struct Known {
    #[serde(default)]
    pub lstat: HashMap<String, String>,
    #[serde(default)]
    pub readdir: HashMap<String, Option<Vec<(String, String)>>>,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Need {
    Lstat(String),
    Readdir(String),
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Shadow {
    pub name: String,
    pub place: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Need(Need),
    Shadows(Vec<Shadow>),
    /// `StaticShadowUnknownError`의 메시지
    Unknown(String),
}

enum Stop {
    Need(Need),
    Unknown(String),
}
type R<T> = Result<T, Stop>;

fn unknown<T>(message: String) -> R<T> {
    Err(Stop::Unknown(message))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Link,
    Dir,
    Other,
}

/// 프로젝트 기준 경로 표기. 옛 `normalize`: 역슬래시를 `/`로, 앞의 `./` 하나, 겹친 `/`, 끝의 `/` 하나
fn normalize(value: &str) -> String {
    let replaced = value.replace('\\', "/");
    let stripped = replaced.strip_prefix("./").unwrap_or(&replaced);
    let mut collapsed = String::with_capacity(stripped.len());
    let mut previous_slash = false;
    for c in stripped.chars() {
        if c == '/' {
            if previous_slash {
                continue;
            }
            previous_slash = true;
        } else {
            previous_slash = false;
        }
        collapsed.push(c);
    }
    if collapsed.ends_with('/') {
        collapsed.pop();
    }
    collapsed
}

/// `^(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$`. 맞지 않으면 None, 맞으면 묶음 1(없으면 None)
fn page_group(relative: &str) -> Option<Option<String>> {
    let rest = relative.strip_prefix("src/").unwrap_or(relative).strip_prefix("app/")?;
    if PAGE_EXTENSIONS.iter().any(|ext| rest.strip_prefix("page.") == Some(ext)) {
        return Some(None);
    }
    for ext in PAGE_EXTENSIONS {
        let suffix = format!("/page.{ext}");
        if let Some(group) = rest.strip_suffix(suffix.as_str()) {
            // 묶음의 `.`은 줄 끝 글자를 먹지 못한다
            if group.chars().any(is_js_line_terminator) {
                return None;
            }
            return Some(Some(group.to_owned()));
        }
    }
    None
}

/// `^\[([^[\]]+)\]$`의 묶음
fn dynamic_name(name: &str) -> Option<&str> {
    let inner = name.strip_prefix('[')?.strip_suffix(']')?;
    (!inner.is_empty() && !inner.contains(['[', ']'])).then_some(inner)
}

/// `^\(\.{1,3}\)`: 인터셉트 라우트 `(.)x`·`(..)x`·`(...)x`
fn is_intercept(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('(') else { return false };
    let dots = rest.chars().take_while(|c| *c == '.').count();
    (1..=3).contains(&dots) && rest[dots..].starts_with(')')
}

/// `^\(.+\)$`. `lenient`면 안의 줄 끝 글자와 빈 안(`()`)도 허용한다(옛 `.+`는 못 먹었다. Next.js는 `(`로 시작해 `)`로 끝나면 그룹이다)
fn is_group(name: &str, lenient: bool) -> bool {
    let Some(inner) = name.strip_prefix('(').and_then(|rest| rest.strip_suffix(')')) else { return false };
    lenient || (!inner.is_empty() && !inner.chars().any(is_js_line_terminator))
}

/// 옛 판정: 주소에 나타나지 않는 폴더(라우트 그룹·병렬 라우트 슬롯)
fn is_transparent_old(name: &str) -> bool {
    name.starts_with('@') || (is_group(name, false) && !is_intercept(name))
}

fn is_transparent_wide(name: &str) -> bool {
    is_group(name, true) && !is_intercept(name)
}

fn hex_byte(bytes: &[u8], at: usize) -> Option<u8> {
    if bytes.len() < at + 3 {
        return None;
    }
    let digit = |b: u8| (b as char).to_digit(16);
    Some((digit(bytes[at + 1])? * 16 + digit(bytes[at + 2])?) as u8)
}

/// JS `decodeURIComponent`. 풀 수 없으면 None(JS는 URIError)
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'%' {
            let c = text[at..].chars().next()?;
            out.push(c);
            at += c.len_utf8();
            continue;
        }
        let first = hex_byte(bytes, at)?;
        at += 3;
        if first < 0x80 {
            out.push(first as char);
            continue;
        }
        let count = if first & 0xE0 == 0xC0 {
            2
        } else if first & 0xF0 == 0xE0 {
            3
        } else if first & 0xF8 == 0xF0 {
            4
        } else {
            return None;
        };
        let mut octets = vec![first];
        for _ in 1..count {
            if at >= bytes.len() || bytes[at] != b'%' {
                return None;
            }
            octets.push(hex_byte(bytes, at)?);
            at += 3;
        }
        out.push_str(std::str::from_utf8(&octets).ok()?);
    }
    Some(out)
}

fn decoded(name: &str) -> String {
    decode_uri_component(name).unwrap_or_else(|| name.to_owned())
}

/// 옛 견줄 이름: 인코딩을 풀고 첫 점 앞까지만, 소문자로
fn old_key(name: &str) -> String {
    decoded(name).split('.').next().unwrap_or("").to_lowercase()
}

/// 넓게 접은 이름: 전체를 접고, 첫 점 앞까지만 보고, 다시 접는다(끝의 점·공백, 결합·서식 문자, 호환 문자, 대소문자)
fn wide_key(name: &str) -> String {
    let folded = fold_name(&decoded(name));
    fold_name(folded.split('.').next().unwrap_or(""))
}

struct Keys {
    old: String,
    wide: String,
}

impl Keys {
    fn of(name: &str) -> Keys {
        Keys { old: old_key(name), wide: wide_key(name) }
    }
    /// 거부 목록 견주기: 어느 쪽 접기로든 같으면 겹친다
    fn overlaps(&self, name: &str) -> bool {
        old_key(name) == self.old || wide_key(name) == self.wide
    }
}

struct Segment {
    text: String,
    dynamic: Option<String>,
}

struct Walker<'a> {
    known: &'a Known,
    budget: f64,
}

fn linked(path: &str) -> String {
    format!("{}이(가) 심볼릭 링크라 그 너머의 경로를 확인할 수 없습니다", normalize(path))
}

fn join(dir: &str, name: &str) -> String {
    format!("{dir}/{name}")
}

impl<'a> Walker<'a> {
    /// parts를 따라 내려가 무엇이 있는지 본다. 길에 링크가 있으면 "모름". 없으면 None, 있으면 그 경로와 폴더인지 여부
    fn locate(&self, parts: &[String]) -> R<Option<(String, bool)>> {
        let mut path = String::new();
        let mut directory = true;
        for part in parts {
            path = if path.is_empty() { part.clone() } else { join(&path, part) };
            match self.known.lstat.get(&path).map(String::as_str) {
                None => return Err(Stop::Need(Need::Lstat(path))),
                Some("missing") => return Ok(None),
                Some("dir") => directory = true,
                Some("other") => directory = false,
                Some("link") => return unknown(linked(&path)),
                // `error`와 모르는 글자: 확인하지 못했다
                Some(_) => return unknown(format!("{}을(를) 확인하지 못했습니다", normalize(&path))),
            }
        }
        Ok(Some((path, directory)))
    }

    fn entries(&self, dir: &str) -> R<&'a [(String, String)]> {
        let known: &'a Known = self.known;
        match known.readdir.get(dir) {
            None => Err(Stop::Need(Need::Readdir(dir.to_owned()))),
            Some(None) => unknown(format!("{} 폴더를 읽지 못했습니다", normalize(dir))),
            Some(Some(entries)) => Ok(entries),
        }
    }

    /// dir 아래에서 target 주소(마지막 조각이 확인할 값)와 같은 자리에 오는 고정 이름을 찾는다. depth는 지금까지 맞춘 주소 조각 수
    fn walk(&mut self, dir: &str, target: &[String], depth: usize) -> R<Option<String>> {
        self.budget -= 1.0;
        if self.budget < 0.0 {
            return unknown("살펴볼 폴더가 너무 많습니다".to_owned());
        }
        let entries = self.entries(dir)?;
        let last = depth == target.len() - 1;
        let want = Keys::of(&target[depth]);
        for (name, kind) in entries {
            let child = join(dir, name);
            let kind = match kind.as_str() {
                "d" => Kind::Dir,
                "f" => Kind::Other,
                _ => Kind::Link,
            };
            if is_transparent_old(name) {
                // 그룹·슬롯은 주소에 없으니 그 안을 같은 깊이로 본다. 링크면 그 안을 알 수 없다
                if kind == Kind::Link {
                    return unknown(linked(&child));
                }
                if kind == Kind::Dir {
                    if let Some(found) = self.walk(&child, target, depth)? {
                        return Ok(Some(found));
                    }
                }
                continue;
            }
            if is_transparent_wide(name) {
                // 옛 구현이 일반 이름으로 읽던 그룹(줄 끝 글자가 든 이름): 그룹으로도 보고, 아래에서 일반 이름으로도 본다
                if kind == Kind::Link {
                    return unknown(linked(&child));
                }
                if kind == Kind::Dir {
                    if let Some(found) = self.walk(&child, target, depth)? {
                        return Ok(Some(found));
                    }
                }
            }
            if is_intercept(name) {
                continue;
            }
            let dynamic = dynamic_name(name).is_some();
            if last {
                // 같은 자리의 동적 폴더는 이 화면 자신이거나 다른 동적 경로다 — 고정 경로가 아니다
                if !dynamic && want.overlaps(name) {
                    return Ok(Some(normalize(&child)));
                }
                continue;
            }
            if dynamic || want.overlaps(name) {
                if kind == Kind::Link {
                    return unknown(linked(&child));
                }
                if kind == Kind::Dir {
                    if let Some(found) = self.walk(&child, target, depth + 1)? {
                        return Ok(Some(found));
                    }
                }
            }
        }
        Ok(None)
    }
}

fn run(input: &Input, known: &Known) -> R<Vec<Shadow>> {
    let prefix = normalize(&input.service_path);
    let in_service = prefix.is_empty() || prefix == ".";
    let file = normalize(&input.page_file);
    let relative = if in_service {
        Some(file.as_str())
    } else {
        file.strip_prefix(&format!("{prefix}/"))
    };
    let Some(group) = relative.and_then(page_group) else {
        return unknown(format!("page 파일 경로를 알아볼 수 없습니다: {}", input.page_file));
    };
    let service_parts: Vec<String> = if in_service { Vec::new() } else { prefix.split('/').map(str::to_owned).collect() };
    if service_parts.iter().any(|part| part.is_empty() || part == "." || part == "..") {
        return unknown(format!("서비스 폴더 경로를 알아볼 수 없습니다: {}", input.service_path));
    }

    // 주소 조각: 그룹·슬롯은 빼고, 동적 세그먼트는 채운 값으로 바꾼다
    let mut url: Vec<Segment> = Vec::new();
    for folder in group.as_deref().unwrap_or("").split('/').filter(|part| !part.is_empty()) {
        if is_transparent_old(folder) {
            continue;
        }
        let Some(dynamic) = dynamic_name(folder) else {
            url.push(Segment { text: folder.to_owned(), dynamic: None });
            continue;
        };
        match input.values.get(dynamic) {
            Some(value) if !value.is_empty() => url.push(Segment { text: value.clone(), dynamic: Some(dynamic.to_owned()) }),
            _ => return unknown(format!("동적 세그먼트 '{dynamic}'에 채운 값을 알 수 없습니다")),
        }
    }

    let mut walker = Walker { known, budget: input.max_folders.unwrap_or(DEFAULT_MAX_FOLDERS) };
    let check: HashSet<&str> = input.check.iter().map(String::as_str).collect();
    let checked = |segment: &Segment| segment.dynamic.as_deref().is_some_and(|name| check.contains(name));

    let mut roots: Vec<String> = Vec::new();
    for router in ROUTER_ROOTS {
        let parts: Vec<String> = service_parts.iter().cloned().chain(router.split('/').map(str::to_owned)).collect();
        if let Some((path, true)) = walker.locate(&parts)? {
            roots.push(path);
        }
    }

    let mut shadows: Vec<Shadow> = Vec::new();
    let names: Vec<&Segment> = url.iter().filter(|segment| checked(segment)).collect();
    for (index, segment) in url.iter().enumerate() {
        if !checked(segment) {
            continue;
        }
        let target: Vec<String> = url[..=index].iter().map(|part| part.text.clone()).collect();
        for root in &roots {
            if let Some(place) = walker.walk(root, &target, 0)? {
                shadows.push(Shadow { name: segment.dynamic.clone().unwrap_or_default(), place });
                break;
            }
        }
    }

    // public의 정적 파일은 채운 주소 전체와 같을 때만 겹친다. 어느 값 때문인지 가릴 수 없으므로 확인 대상 값 모두를 겹친 것으로 본다
    if !url.is_empty() && !names.is_empty() {
        if url.iter().any(|part| part.text == "." || part.text == ".." || part.text.contains('/')) {
            return unknown("채운 값이 경로 조각이 아니라 정적 파일을 확인할 수 없습니다".to_owned());
        }
        let parts: Vec<String> = service_parts.iter().cloned().chain(std::iter::once("public".to_owned())).chain(url.iter().map(|part| part.text.clone())).collect();
        if let Some((path, _)) = walker.locate(&parts)? {
            for segment in names {
                let name = segment.dynamic.clone().unwrap_or_default();
                if !shadows.iter().any(|shadow| shadow.name == name) {
                    shadows.push(Shadow { name, place: normalize(&path) });
                }
            }
        }
    }
    Ok(shadows)
}

/// 지금까지 읽은 것으로 판정을 돌린다. 더 읽어야 하면 읽을 것 하나를 돌려준다
pub fn step(input: &Input, known: &Known) -> Step {
    match run(input, known) {
        Ok(shadows) => Step::Shadows(shadows),
        Err(Stop::Need(need)) => Step::Need(need),
        Err(Stop::Unknown(message)) => Step::Unknown(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_like_decode_uri_component() {
        assert_eq!(decode_uri_component("%5Fnew").as_deref(), Some("_new"));
        assert_eq!(decode_uri_component("%E2%82%AC").as_deref(), Some("\u{20AC}"));
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%E2%82"), None);
        assert_eq!(decode_uri_component("%C0%80"), None);
        assert_eq!(decode_uri_component("%80"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("a%2Eb").as_deref(), Some("a.b"));
    }

    #[test]
    fn page_group_reads_the_page_path() {
        assert_eq!(page_group("app/page.tsx"), Some(None));
        assert_eq!(page_group("src/app/a/b/page.mdx"), Some(Some("a/b".to_owned())));
        assert_eq!(page_group("app/page.tsx/page.js"), Some(Some("page.tsx".to_owned())));
        assert_eq!(page_group("app/a\nb/page.tsx"), None);
        assert_eq!(page_group("web/app/page.tsx"), None);
        assert_eq!(page_group("app/a/page.css"), None);
    }

    #[test]
    fn step_asks_for_the_first_unread_path() {
        let input: Input = serde_json::from_str(r#"{"servicePath":"web","pageFile":"web/app/o/[id]/page.tsx","values":{"id":"new"},"check":["id"]}"#).unwrap();
        assert_eq!(step(&input, &Known::default()), Step::Need(Need::Lstat("web".to_owned())));
    }
}
