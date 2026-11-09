//! 소스의 import를 거꾸로 따라가 "이 파일을 쓰는 page 파일"을 찾는 판정(ADR-191 3단계 3b). `packages/agent/src/import-graph.ts`의 순수 코어다.
//! 파일 목록·읽기와 시간·개수 상한(`collectImportGraph`)은 TS에 남아 있다.
//!
//! JS 문자열은 UTF-16 코드 단위의 나열이라, 토큰 분해·JSONC 걷기·별칭 맞추기는 `Vec<u16>`로 같은 인덱스 규칙을 따른다(서로게이트 쌍은
//! 단위 둘이다: 토큰 수 상한 400개와 앞 토큰 확인이 달라지지 않게 `tokenize`가 쌍 하나에 `P` 둘을 낸다). 정규식은 모두 손으로 읽는다
//! (`\s`는 JS 공백, `.`은 줄 끝 글자를 뺀 것).
//!
//! 의도한 차이:
//! - `trace_pages`의 마지막 정렬이 `localeCompare`(ICU)에서 UTF-16 코드 단위 순서(`js::cmp_utf16`)가 됐다. 같은 거리·같은 tie끼리의 순서만 바뀐다.
//! - JSON은 `js_json`의 규칙을 따른다: 중첩 2,000단계를 넘으면 읽지 않는다(`parseRaw`가 `undefined`), 짝 없는 서로게이트는 U+FFFD.
//! - 짝 없는 서로게이트가 든 소스는 napi 경계에서 U+FFFD가 된다(토큰 수는 같고 문자열 값만 다르다).

use crate::js;
use crate::js_json::{self, JsValue};
use std::collections::{HashMap, HashSet};

const SOURCE_EXTENSIONS: [&str; 6] = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".mdx"];
const PAGE_EXTENSIONS: [&str; 5] = ["tsx", "jsx", "ts", "js", "mdx"];
const ROUTE_WRAPPER_NAMES: [&str; 7] = [
    "layout",
    "template",
    "loading",
    "error",
    "global-error",
    "not-found",
    "default",
];
const REGEX_AFTER_WORD: [&str; 13] = [
    "return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do",
    "yield", "await",
];
const EXPORT_DECLARATION_WORDS: [&str; 12] = [
    "function",
    "class",
    "const",
    "let",
    "var",
    "default",
    "async",
    "interface",
    "enum",
    "namespace",
    "declare",
    "abstract",
];
const SCAN_LIMIT: i64 = 400;

fn has_line_terminator(s: &str) -> bool {
    s.chars().any(js::is_js_line_terminator)
}

/// `/^(?:src\/)?app\/(?:.*\/)?page\.(?:tsx|jsx|ts|js|mdx)$/`
pub fn is_page_file_in_service(relative: &str) -> bool {
    let rest = relative.strip_prefix("src/").unwrap_or(relative);
    let Some(rest) = rest.strip_prefix("app/") else {
        return false;
    };
    PAGE_EXTENSIONS.iter().any(|ext| {
        let tail = format!("page.{ext}");
        match rest.strip_suffix(tail.as_str()) {
            Some(prefix) => {
                prefix.is_empty() || (prefix.ends_with('/') && !has_line_terminator(prefix))
            }
            None => false,
        }
    })
}

/// `/^((?:src\/)?app(?:\/.*)?)\/(?:layout|template|loading|error|global-error|not-found|default)\.(?:tsx|jsx|ts|js|mdx)$/`의 첫 묶음
pub fn route_wrapper_folder(relative: &str) -> Option<String> {
    let last = relative.rfind('/')?;
    let (folder, name) = (&relative[..last], &relative[last + 1..]);
    let wrapper = ROUTE_WRAPPER_NAMES.iter().any(|n| {
        PAGE_EXTENSIONS
            .iter()
            .any(|ext| name == format!("{n}.{ext}"))
    });
    if !wrapper {
        return None;
    }
    let after_app = folder
        .strip_prefix("src/")
        .unwrap_or(folder)
        .strip_prefix("app")?;
    if after_app.is_empty() || (after_app.starts_with('/') && !has_line_terminator(after_app)) {
        Some(folder.to_owned())
    } else {
        None
    }
}

/// 소스 파일 하나를 읽을 때 쓰는 확장자 판정. `.d.ts`와 테스트·스토리 파일은 뺀다
pub fn is_graph_source_file(relative: &str) -> bool {
    is_source_file(relative) && !relative.ends_with(".d.ts") && !is_non_runtime_file(relative)
}

fn is_source_file(path: &str) -> bool {
    SOURCE_EXTENSIONS.iter().any(|ext| path.ends_with(ext))
}

/// `/\.(?:test|spec|stories)\.[a-z]+$/`
fn is_non_runtime_file(path: &str) -> bool {
    let Some(dot) = path.rfind('.') else {
        return false;
    };
    let ext = &path[dot + 1..];
    if ext.is_empty() || !ext.bytes().all(|b| b.is_ascii_lowercase()) {
        return false;
    }
    let stem = &path[..dot];
    stem.ends_with(".test") || stem.ends_with(".spec") || stem.ends_with(".stories")
}

// ───────────────────────── import 추출 ─────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum Token {
    Str {
        value: String,
        template: bool,
    },
    Word(String),
    /// 구두점·그 밖의 글자 하나(UTF-16 코드 단위)
    P(u16),
    /// 정규식 리터럴 하나(옛 TS의 `{ t: 'p', v: '/re/' }`). 어떤 한 글자 구두점과도 같지 않다
    Re,
}

fn u(c: char) -> u16 {
    c as u16
}

fn is_word_unit(c: u16) -> bool {
    c < 128 && ((c as u8).is_ascii_alphanumeric() || c == u('_') || c == u('$'))
}

fn index_of(s: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from > s.len() || needle.is_empty() {
        return None;
    }
    s[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn string_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// 소스를 토큰으로 자른다. 주석은 버리고 문자열은 통째로 하나의 토큰이다
pub fn tokenize(source: &str) -> Vec<Token> {
    let s: Vec<u16> = source.encode_utf16().collect();
    let length = s.len();
    let mut tokens: Vec<Token> = Vec::new();
    let mut i = 0usize;
    while i < length {
        let ch = s[i];
        let next = s.get(i + 1).copied();
        if ch == 0x0A || ch == 0x20 || ch == 0x09 || ch == 0x0D {
            i += 1;
            continue;
        }
        if ch == u('/') && next == Some(u('/')) {
            i = index_of(&s, &[0x0A], i).map_or(length, |end| end + 1);
            continue;
        }
        if ch == u('/') && next == Some(u('*')) {
            i = index_of(&s, &[u('*'), u('/')], i + 2).map_or(length, |end| end + 2);
            continue;
        }
        if ch == u('\'') || ch == u('"') {
            let mut j = i + 1;
            let mut value: Vec<u16> = Vec::new();
            let mut closed = false;
            while j < length {
                let c = s[j];
                if c == u('\\') {
                    if let Some(&escaped) = s.get(j + 1) {
                        value.push(escaped);
                    }
                    j += 2;
                    continue;
                }
                if c == 0x0A {
                    break;
                }
                if c == ch {
                    closed = true;
                    break;
                }
                value.push(c);
                j += 1;
            }
            if closed {
                tokens.push(Token::Str {
                    value: string_of(&value),
                    template: false,
                });
                i = j + 1;
            } else {
                i += 1; // 닫히지 않은 따옴표: 하나만 버리고 다음 글자부터 다시 읽는다
            }
            continue;
        }
        if ch == u('`') {
            let mut j = i + 1;
            let mut value: Vec<u16> = Vec::new();
            while j < length && s[j] != u('`') {
                if s[j] == u('\\') {
                    if let Some(&escaped) = s.get(j + 1) {
                        value.push(escaped);
                    }
                    j += 2;
                    continue;
                }
                value.push(s[j]);
                j += 1;
            }
            tokens.push(Token::Str {
                value: string_of(&value),
                template: true,
            });
            i = j + 1;
            continue;
        }
        if ch == u('/') {
            let regex_allowed = match tokens.last() {
                None => true,
                Some(Token::P(c)) => ![u(')'), u(']'), u('}'), u('<')].contains(c),
                Some(Token::Re) => true,
                Some(Token::Word(w)) => REGEX_AFTER_WORD.contains(&w.as_str()),
                Some(Token::Str { .. }) => false,
            };
            if regex_allowed {
                let mut j = i + 1;
                let mut in_class = false;
                let mut closed = false;
                while j < length && s[j] != 0x0A {
                    let c = s[j];
                    if c == u('\\') {
                        j += 2;
                        continue;
                    }
                    if c == u('[') {
                        in_class = true;
                    } else if c == u(']') {
                        in_class = false;
                    } else if c == u('/') && !in_class {
                        closed = true;
                        break;
                    }
                    j += 1;
                }
                if closed {
                    tokens.push(Token::Re);
                    i = j + 1;
                    while i < length && (u('a')..=u('z')).contains(&s[i]) {
                        i += 1; // 플래그
                    }
                    continue;
                }
            }
            tokens.push(Token::P(u('/')));
            i += 1;
            continue;
        }
        if is_word_unit(ch) {
            let mut j = i + 1;
            while j < length && is_word_unit(s[j]) {
                j += 1;
            }
            tokens.push(Token::Word(string_of(&s[i..j])));
            i = j;
            continue;
        }
        tokens.push(Token::P(ch));
        i += 1;
    }
    tokens
}

fn is_p(token: Option<&Token>, c: char) -> bool {
    matches!(token, Some(Token::P(x)) if *x == u(c))
}

/// `from '…'`에 닿을 때까지 import/export 절을 훑는다. 재수출·import가 아닌 문장이면 `None`
fn specifier_after_clause(tokens: &[Token], start: usize, export: bool) -> Option<String> {
    let mut depth: usize = 0;
    let end = (tokens.len() as i64 - 1).min(start as i64 + SCAN_LIMIT);
    let mut j = start as i64;
    while j <= end {
        let index = j as usize;
        match &tokens[index] {
            Token::P(c) => {
                if *c == u('{') {
                    depth += 1;
                } else if *c == u('}') {
                    depth = depth.saturating_sub(1);
                } else if depth == 0 && [u(';'), u('('), u('='), u('.')].contains(c) {
                    return None;
                }
            }
            Token::Re => {}
            Token::Str { .. } => {
                if depth == 0 {
                    return None; // from 없이 문자열이 나오면 이 절이 아니다
                }
            }
            Token::Word(w) => {
                if depth == 0 {
                    if w == "from" {
                        return match tokens.get(index + 1) {
                            Some(Token::Str {
                                value,
                                template: false,
                            }) => Some(value.clone()),
                            _ => None,
                        };
                    }
                    if w == "import" || w == "export" {
                        return None;
                    }
                    if export && EXPORT_DECLARATION_WORDS.contains(&w.as_str()) {
                        return None;
                    }
                }
            }
        }
        j += 1;
    }
    None
}

/// 소스에서 import한 모듈 지정자를 모두 뽑는다
pub fn extract_import_specifiers(source: &str) -> Vec<String> {
    let tokens = tokenize(source);
    let mut found = Vec::new();
    for i in 0..tokens.len() {
        let Token::Word(word) = &tokens[i] else {
            continue;
        };
        // `a.import(...)`·`obj.require(...)` 같은 속성 접근은 건너뛴다
        if i > 0 && is_p(tokens.get(i - 1), '.') {
            continue;
        }
        let next = tokens.get(i + 1);
        if word == "import" || word == "require" {
            if let (Some(Token::Str { value, template }), true) = (next, word == "import") {
                if !template {
                    found.push(value.clone()); // import '…' (부수 효과만)
                }
                continue;
            }
            if is_p(next, '(') {
                if let (Some(Token::Str { value, template }), Some(Token::P(close))) =
                    (tokens.get(i + 2), tokens.get(i + 3))
                {
                    if !(*template && value.contains("${"))
                        && (*close == u(')') || *close == u(','))
                    {
                        found.push(value.clone());
                    }
                }
                continue;
            }
            if word == "import" {
                if let Some(specifier) = specifier_after_clause(&tokens, i + 1, false) {
                    found.push(specifier);
                }
            }
            continue;
        }
        if word == "export" {
            let wanted = is_p(next, '*')
                || is_p(next, '{')
                || matches!(next, Some(Token::Word(w)) if w == "type");
            if wanted {
                if let Some(specifier) = specifier_after_clause(&tokens, i + 1, true) {
                    found.push(specifier);
                }
            }
        }
    }
    found
}

// ───────────────────────── 경로 풀기 ─────────────────────────

#[derive(Clone, Debug, PartialEq, Default)]
pub struct AliasPath {
    pub pattern: String,
    pub targets: Vec<String>,
}

/// tsconfig/jsconfig에서 읽은 경로 별칭 설정. 모든 경로는 서비스 폴더 기준 상대 경로다
#[derive(Clone, Debug, PartialEq, Default)]
pub struct AliasConfig {
    pub base_url: Option<String>,
    pub paths: Vec<AliasPath>,
}

/// 서비스 기준 경로를 정규화한다(`a/./b/../c` → `a/c`). 서비스 밖으로 나가면 `None`
pub fn normalize_service_path(value: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    let replaced = value.replace('\\', "/");
    for part in replaced.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            out.pop()?;
            continue;
        }
        out.push(part);
    }
    Some(out.join("/"))
}

pub fn dir_of(file: &str) -> String {
    match file.rfind('/') {
        Some(slash) => file[..slash].to_owned(),
        None => String::new(),
    }
}

fn join_dir(dir: &str, rest: &str) -> String {
    if dir.is_empty() {
        rest.to_owned()
    } else {
        format!("{dir}/{rest}")
    }
}

/// JSON에서 주석과 꼬리 쉼표를 걷어낸다(tsconfig는 JSONC다). 문자열 안은 주석으로 보지 않는다.
/// 꼬리 쉼표 걷기(`/,(\s*[}\]])/g`)는 옛 TS처럼 문자열 안의 `,}`도 걷는다
pub fn strip_jsonc(text: &str) -> String {
    let t: Vec<u16> = text.encode_utf16().collect();
    let len = t.len();
    let mut out: Vec<u16> = Vec::with_capacity(len);
    let mut i = 0usize;
    while i < len {
        let ch = t[i];
        if ch == u('"') {
            let mut j = i + 1;
            while j < len && t[j] != u('"') {
                j += if t[j] == u('\\') { 2 } else { 1 };
            }
            out.extend_from_slice(&t[i..(j + 1).min(len)]);
            i = j + 1;
        } else if ch == u('/') && t.get(i + 1) == Some(&u('/')) {
            i = index_of(&t, &[0x0A], i).unwrap_or(len);
        } else if ch == u('/') && t.get(i + 1) == Some(&u('*')) {
            i = index_of(&t, &[u('*'), u('/')], i + 2).map_or(len, |end| end + 2);
        } else {
            out.push(ch);
            i += 1;
        }
    }
    let mut result: Vec<u16> = Vec::with_capacity(out.len());
    let mut k = 0usize;
    while k < out.len() {
        if out[k] == u(',') {
            let mut m = k + 1;
            while m < out.len()
                && char::from_u32(u32::from(out[m])).is_some_and(js::is_js_whitespace)
            {
                m += 1;
            }
            if m < out.len() && (out[m] == u('}') || out[m] == u(']')) {
                result.extend_from_slice(&out[k + 1..=m]);
                k = m + 1;
                continue;
            }
        }
        result.push(out[k]);
        k += 1;
    }
    string_of(&result)
}

/// `JSON.parse(stripJsonc(text))`가 객체·배열이면 그 값, 아니면(읽지 못함·null·원시값) `None`
fn parse_raw(text: &str) -> Option<JsValue> {
    match js_json::parse(&strip_jsonc(text)) {
        Ok(value @ (JsValue::Obj(_) | JsValue::Arr(_))) => Some(value),
        _ => None,
    }
}

/// extends 값이 서비스 안의 상대 경로 파일이면 그 서비스 기준 경로
pub fn tsconfig_extends_path(text: &str, config_dir: &str) -> Option<String> {
    let raw = parse_raw(text)?;
    let value = raw.prop("extends")?.as_str()?;
    if !value.starts_with('.') {
        return None;
    }
    let joined = normalize_service_path(&join_dir(config_dir, value))?;
    Some(if joined.ends_with(".json") {
        joined
    } else {
        format!("{joined}.json")
    })
}

/// `Object.entries`
fn entries_of(value: &JsValue) -> Vec<(String, &JsValue)> {
    match value {
        JsValue::Obj(o) => o
            .entries_js_order()
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
        JsValue::Arr(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    }
}

/// tsconfig.json·jsconfig.json 본문에서 `baseUrl`과 `paths`를 읽는다. `base`는 extends로 물려받은 설정이다.
/// 두 번째 값은 결과 객체에서 `baseUrl` 키가 `paths`보다 앞에 오는지다(base에 baseUrl이 있었을 때만; JSON 글자의 키 순서)
pub fn parse_alias_config(
    text: &str,
    config_dir: &str,
    base: Option<&AliasConfig>,
) -> (AliasConfig, bool) {
    let mut result = AliasConfig {
        base_url: base.and_then(|b| b.base_url.clone()),
        paths: base.map(|b| b.paths.clone()).unwrap_or_default(),
    };
    let base_url_first = result.base_url.is_some();
    let Some(raw) = parse_raw(text) else {
        return (result, base_url_first);
    };
    let Some(options) = raw.prop("compilerOptions") else {
        return (result, base_url_first);
    };
    if !options.truthy() {
        return (result, base_url_first);
    }
    if let Some(base_url) = options.prop("baseUrl").and_then(JsValue::as_str) {
        if let Some(root) = normalize_service_path(&join_dir(config_dir, base_url)) {
            result.base_url = Some(root);
        }
    }
    if let Some(paths @ (JsValue::Obj(_) | JsValue::Arr(_))) = options.prop("paths") {
        // paths는 baseUrl 기준이고, baseUrl이 없으면 설정 파일 폴더 기준이다
        let root = result
            .base_url
            .clone()
            .unwrap_or_else(|| config_dir.to_owned());
        let mut own = Vec::new();
        for (pattern, targets) in entries_of(paths) {
            let JsValue::Arr(targets) = targets else {
                continue;
            };
            let resolved: Vec<String> = targets
                .iter()
                .filter_map(JsValue::as_str)
                .filter_map(|target| normalize_service_path(&join_dir(&root, target)))
                .collect();
            if !resolved.is_empty() {
                own.push(AliasPath {
                    pattern,
                    targets: resolved,
                });
            }
        }
        result.paths = own;
    }
    (result, base_url_first)
}

/// 확장자 없는 경로 하나에서 실제 소스 파일을 찾는다: 그대로 → 확장자 붙이기 → index 파일. `./x.js`로 쓴 TS ESM 지정자도 `.ts(x)`로 푼다
fn find_source_file(base: &str, files: &HashSet<String>) -> Option<String> {
    let mut bases = vec![base.to_owned()];
    for suffix in [".mjs", ".jsx", ".js"] {
        if let Some(stem) = base.strip_suffix(suffix) {
            bases.push(stem.to_owned());
            break;
        }
    }
    for candidate in &bases {
        if is_source_file(candidate) && files.contains(candidate) {
            return Some(candidate.clone());
        }
        for ext in SOURCE_EXTENSIONS {
            let path = format!("{candidate}{ext}");
            if files.contains(&path) {
                return Some(path);
            }
        }
        for ext in SOURCE_EXTENSIONS {
            let index = if candidate.is_empty() {
                format!("index{ext}")
            } else {
                format!("{candidate}/index{ext}")
            };
            if files.contains(&index) {
                return Some(index);
            }
        }
    }
    None
}

/// `/^[a-z][a-z0-9+.-]*:/i`(ASCII만 접는다)
fn has_scheme(specifier: &str) -> bool {
    let bytes = specifier.as_bytes();
    if bytes.first().is_none_or(|b| !b.is_ascii_alphabetic()) {
        return false;
    }
    for &b in &bytes[1..] {
        if b == b':' {
            return true;
        }
        if !(b.is_ascii_alphanumeric() || b == b'+' || b == b'.' || b == b'-') {
            return false;
        }
    }
    false
}

/// `String.prototype.replace('*', captured)`: 바꿀 글자의 `$$`·`$&`·`` $` ``·`$'`도 JS처럼 읽는다(`$1` 같은 것은 그대로)
fn replace_first_star(target: &str, captured: &str) -> String {
    let Some(star) = target.find('*') else {
        return target.to_owned();
    };
    let (before, after) = (&target[..star], &target[star + 1..]);
    let mut replacement = String::new();
    let chars: Vec<char> = captured.chars().collect();
    let mut k = 0;
    while k < chars.len() {
        if chars[k] == '$' {
            match chars.get(k + 1) {
                Some('$') => {
                    replacement.push('$');
                    k += 2;
                    continue;
                }
                Some('&') => {
                    replacement.push('*');
                    k += 2;
                    continue;
                }
                Some('`') => {
                    replacement.push_str(before);
                    k += 2;
                    continue;
                }
                Some('\'') => {
                    replacement.push_str(after);
                    k += 2;
                    continue;
                }
                _ => {}
            }
        }
        replacement.push(chars[k]);
        k += 1;
    }
    format!("{before}{replacement}{after}")
}

/// import 지정자 하나를 서비스 안의 소스 파일로 푼다. 못 풀거나(패키지 import, 없는 파일) 서비스 밖이면 `None`.
/// 순서: 상대 경로 → tsconfig paths(가장 긴 접두사 먼저) → baseUrl → 설정이 없을 때의 `@/`·`~/` 추정
pub fn resolve_import(
    specifier: &str,
    from_file: &str,
    files: &HashSet<String>,
    alias: &AliasConfig,
) -> Option<String> {
    if specifier.is_empty() || has_scheme(specifier) {
        return None;
    }
    if specifier.starts_with("./")
        || specifier.starts_with("../")
        || specifier == "."
        || specifier == ".."
    {
        let joined = normalize_service_path(&join_dir(&dir_of(from_file), specifier))?;
        return find_source_file(&joined, files);
    }
    if specifier.starts_with('/') {
        return None;
    }

    let spec16: Vec<u16> = specifier.encode_utf16().collect();
    let mut matches: Vec<(&AliasPath, String, usize)> = Vec::new();
    for entry in &alias.paths {
        let pattern: Vec<u16> = entry.pattern.encode_utf16().collect();
        match pattern.iter().position(|&c| c == u('*')) {
            None => {
                if pattern == spec16 {
                    matches.push((entry, String::new(), pattern.len()));
                }
            }
            Some(star) => {
                let (prefix, suffix) = (&pattern[..star], &pattern[star + 1..]);
                if spec16.len() < prefix.len() + suffix.len()
                    || !spec16.starts_with(prefix)
                    || !spec16.ends_with(suffix)
                {
                    continue;
                }
                matches.push((
                    entry,
                    string_of(&spec16[prefix.len()..spec16.len() - suffix.len()]),
                    prefix.len(),
                ));
            }
        }
    }
    matches.sort_by_key(|m| std::cmp::Reverse(m.2)); // 안정 정렬
    for (entry, captured, _) in &matches {
        for target in &entry.targets {
            if let Some(found) = normalize_service_path(&replace_first_star(target, captured))
                .and_then(|joined| find_source_file(&joined, files))
            {
                return Some(found);
            }
        }
    }
    if let Some(base_url) = &alias.base_url {
        if let Some(found) = normalize_service_path(&join_dir(base_url, specifier))
            .and_then(|joined| find_source_file(&joined, files))
        {
            return Some(found);
        }
    }
    // 설정에서 못 풀었고 `@/`·`~/`로 시작하면 Next.js의 흔한 관례대로 서비스 루트와 src/를 시도한다(`/^[@~]\/(.*)$/`: `.`은 줄 끝 글자를 뺀다)
    if let Some(rest) = specifier
        .strip_prefix("@/")
        .or_else(|| specifier.strip_prefix("~/"))
    {
        if !has_line_terminator(rest) {
            for root in ["", "src"] {
                if let Some(found) = normalize_service_path(&join_dir(root, rest))
                    .and_then(|joined| find_source_file(&joined, files))
                {
                    return Some(found);
                }
            }
        }
    }
    None
}

// ───────────────────────── 그래프 ─────────────────────────

/// 파일 → 그 파일을 import하는 파일들. 넣은 순서를 지킨다(JS `Map<string, Set<string>>`)
pub type ReverseGraph = Vec<(String, Vec<String>)>;

/// 읽은 소스(서비스 기준 경로 → 내용, 넣은 순서)로 역방향 import 그래프를 만든다. 자기 자신을 import하는 줄은 뺀다
pub fn build_reverse_graph(
    sources: &[(String, String)],
    files: &HashSet<String>,
    alias: &AliasConfig,
) -> ReverseGraph {
    let mut order: Vec<String> = Vec::new();
    let mut importers: HashMap<String, Vec<String>> = HashMap::new();
    for (file, source) in sources {
        for specifier in extract_import_specifiers(source) {
            let Some(target) = resolve_import(&specifier, file, files, alias) else {
                continue;
            };
            if &target == file {
                continue;
            }
            let list = importers.entry(target.clone()).or_insert_with(|| {
                order.push(target.clone());
                Vec::new()
            });
            // 같은 파일의 줄만 연달아 들어오므로 마지막 것만 보면 Set의 중복 제거와 같다
            if list.last() != Some(file) {
                list.push(file.clone());
            }
        }
    }
    order
        .into_iter()
        .map(|target| {
            let list = importers.remove(&target).unwrap_or_default();
            (target, list)
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageCandidate {
    pub page: String,
    pub cause: String,
    pub distance: u32,
    pub tie: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TruncatedTrace {
    pub cause: String,
    pub stopped_at: String,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct TraceResult {
    pub candidates: Vec<PageCandidate>,
    pub truncated: Vec<TruncatedTrace>,
}

fn sorted_utf16(mut items: Vec<String>) -> Vec<String> {
    items.sort_by(|a, b| js::cmp_utf16(a, b));
    items
}

fn segment_count(path: &str) -> u32 {
    path.split('/').count() as u32
}

/// 바뀐 파일에서 출발해 import를 거꾸로 따라가며 page를 찾는다(너비 우선, 순환은 방문 표시로 끊는다)
pub fn trace_pages(
    changed: &[String],
    reverse: &ReverseGraph,
    files: &[String],
    max_depth: f64,
) -> TraceResult {
    let importers: HashMap<&str, &Vec<String>> =
        reverse.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let pages = sorted_utf16(
        files
            .iter()
            .filter(|f| is_page_file_in_service(f))
            .cloned()
            .collect(),
    );
    struct Info {
        cause: String,
        distance: u32,
        tie: u32,
    }
    let mut visited: HashMap<String, Info> = HashMap::new();
    let mut frontier: Vec<String> = Vec::new();
    let unique: HashSet<&String> = changed.iter().collect();
    for file in sorted_utf16(unique.into_iter().cloned().collect()) {
        if visited.contains_key(&file) {
            continue;
        }
        visited.insert(
            file.clone(),
            Info {
                cause: file.clone(),
                distance: 0,
                tie: 0,
            },
        );
        frontier.push(file);
    }

    let neighbors_of = |file: &str| -> Vec<(String, u32)> {
        let mut result: Vec<(String, u32)> = Vec::new();
        if let Some(list) = importers.get(file) {
            for importer in sorted_utf16((*list).clone()) {
                result.push((importer, 0));
            }
        }
        if let Some(folder) = route_wrapper_folder(file) {
            let prefix = format!("{folder}/");
            for page in &pages {
                if page.starts_with(&prefix) {
                    result.push((
                        page.clone(),
                        segment_count(&dir_of(page)) - segment_count(&folder),
                    ));
                }
            }
        }
        result
    };

    let mut truncated: Vec<TruncatedTrace> = Vec::new();
    let mut distance: u32 = 0;
    while !frontier.is_empty() {
        let mut next_frontier: Vec<String> = Vec::new();
        for file in &frontier {
            let cause = visited[file].cause.clone();
            for (neighbor, tie) in neighbors_of(file) {
                if visited.contains_key(&neighbor) {
                    continue;
                }
                if f64::from(distance) >= max_depth {
                    // 더 따라갈 수 있었지만 깊이 상한이라 멈췄다 — 조용히 포기하지 않고 호출자가 알리게 한다
                    if !truncated
                        .iter()
                        .any(|t| t.cause == cause && &t.stopped_at == file)
                    {
                        truncated.push(TruncatedTrace {
                            cause: cause.clone(),
                            stopped_at: file.clone(),
                        });
                    }
                    break;
                }
                visited.insert(
                    neighbor.clone(),
                    Info {
                        cause: cause.clone(),
                        distance: distance + 1,
                        tie,
                    },
                );
                next_frontier.push(neighbor);
            }
        }
        frontier = next_frontier;
        distance += 1;
    }

    let mut candidates: Vec<PageCandidate> = visited
        .into_iter()
        .filter(|(file, _)| is_page_file_in_service(file))
        .map(|(page, info)| PageCandidate {
            page,
            cause: info.cause,
            distance: info.distance,
            tie: info.tie,
        })
        .collect();
    // 의도한 차이: 같은 거리·같은 tie끼리는 UTF-16 코드 단위 순서(옛 TS는 localeCompare)
    candidates.sort_by(|a, b| {
        a.distance
            .cmp(&b.distance)
            .then(a.tie.cmp(&b.tie))
            .then_with(|| js::cmp_utf16(&a.page, &b.page))
    });
    TraceResult {
        candidates,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn page_and_wrapper_names() {
        assert!(is_page_file_in_service("app/page.tsx"));
        assert!(is_page_file_in_service("src/app/a/[id]/page.mdx"));
        assert!(!is_page_file_in_service("app/xpage.tsx"));
        assert!(!is_page_file_in_service("app/a\nb/page.tsx"));
        assert!(!is_page_file_in_service("lib/app/page.tsx"));
        assert_eq!(
            route_wrapper_folder("src/app/a/layout.tsx").as_deref(),
            Some("src/app/a")
        );
        assert_eq!(
            route_wrapper_folder("app/not-found.js").as_deref(),
            Some("app")
        );
        assert_eq!(route_wrapper_folder("application/layout.tsx"), None);
        assert!(
            is_graph_source_file("a/b.tsx")
                && !is_graph_source_file("a/b.d.ts")
                && !is_graph_source_file("a/b.test.ts")
                && !is_graph_source_file("b.css")
        );
    }

    #[test]
    fn tokenizer_and_specifiers() {
        let source = "import A from 'a'; export * from \"b\"; const x = require('c'); import('d'); /* import 'no' */ // import 'no2'\nconst r = /['\"]x/g; import './e';";
        assert_eq!(
            extract_import_specifiers(source),
            vec!["a", "b", "c", "d", "./e"]
        );
        // 서로게이트 쌍은 토큰 둘이다
        assert_eq!(tokenize("😀").len(), 2);
    }

    #[test]
    fn jsonc_and_alias() {
        assert_eq!(
            strip_jsonc("{ // c\n \"a\": [1, 2,], /* x */ }"),
            "{ \n \"a\": [1, 2]  }"
        );
        let (alias, first) = parse_alias_config(
            "{ \"compilerOptions\": { \"baseUrl\": \"src\", \"paths\": { \"@/*\": [\"*\"] } } }",
            "",
            None,
        );
        assert_eq!(alias.base_url.as_deref(), Some("src"));
        assert_eq!(
            alias.paths,
            vec![AliasPath {
                pattern: "@/*".into(),
                targets: vec!["src/*".into()]
            }]
        );
        assert!(!first);
        let set = files(&["src/lib/x.ts"]);
        assert_eq!(
            resolve_import("@/lib/x", "app/page.tsx", &set, &alias).as_deref(),
            Some("src/lib/x.ts")
        );
    }

    #[test]
    fn dollar_replacement_in_captured() {
        assert_eq!(replace_first_star("a/*/b", "$&"), "a/*/b");
        assert_eq!(replace_first_star("a/*/b", "$$x"), "a/$x/b");
        assert_eq!(replace_first_star("a/*/b", "$1"), "a/$1/b");
        assert_eq!(replace_first_star("a/*/b", "$`"), "a/a//b");
    }

    #[test]
    fn trace_order_and_depth() {
        let set: Vec<String> = [
            "app/page.tsx",
            "app/layout.tsx",
            "app/z/page.tsx",
            "lib/a.ts",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let reverse: ReverseGraph = vec![("lib/a.ts".into(), vec!["app/z/page.tsx".into()])];
        let r = trace_pages(
            &["lib/a.ts".into(), "app/layout.tsx".into()],
            &reverse,
            &set,
            5.0,
        );
        let pages: Vec<(&str, u32, u32)> = r
            .candidates
            .iter()
            .map(|c| (c.page.as_str(), c.distance, c.tie))
            .collect();
        assert_eq!(
            pages,
            vec![("app/page.tsx", 1, 0), ("app/z/page.tsx", 1, 1)]
        );
        let cut = trace_pages(&["lib/a.ts".into()], &reverse, &set, 0.0);
        assert!(cut.candidates.is_empty());
        assert_eq!(
            cut.truncated,
            vec![TruncatedTrace {
                cause: "lib/a.ts".into(),
                stopped_at: "lib/a.ts".into()
            }]
        );
    }

    #[test]
    fn reverse_graph_dedupes_importers_and_keeps_insertion_order() {
        let sources = vec![
            ("c.ts".to_owned(), "import './z'; import './z'".to_owned()),
            (
                "a.ts".to_owned(),
                "import './y'; import './z'; import './z'".to_owned(),
            ),
        ];
        let graph = build_reverse_graph(
            &sources,
            &files(&["a.ts", "c.ts", "y.ts", "z.ts"]),
            &AliasConfig::default(),
        );
        assert_eq!(
            graph,
            vec![
                (
                    "z.ts".to_owned(),
                    vec!["c.ts".to_owned(), "a.ts".to_owned()]
                ),
                ("y.ts".to_owned(), vec!["a.ts".to_owned()])
            ]
        );
    }
}
