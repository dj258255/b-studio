//! `packages/spec`의 YAML 읽기(ADR-197). JS `yaml@2.9.0`의 `parse(source)`·`parse(source, { merge: true })`와 같은 값을 만든다.
//!
//! 구조는 `saphyr-parser`의 이벤트로 읽고, 값으로 바꾸는 규칙은 `yaml`의 core 스키마를 따라 직접 구현한다
//! (DOM·serde 크레이트는 YAML 1.1 불리언·`-0`·큰 정수·merge 순서에서 JS와 달랐다, ADR-197의 측정).
//!
//! 결과는 셋 중 하나다: 값(JSON 글자) / 문법 오류 / **지원하지 않는 꼴**. JS와 다르게 읽을 수 있는 입력은 값을 만들지 않고 지원하지 않는 꼴로 거절한다.
//! 거절 규칙은 글자가 아니라 이벤트·토큰 단위로 판단한다(첫 줄의 `---`, 따옴표·주석 안의 탭은 통과).
//!
//! 값의 JSON은 JS가 `JSON.parse`로 그대로 읽는다: 정수 꼴 키가 앞서는 객체 순서와 `__proto__` 자기 속성은 `JSON.parse`가 JS 객체 규칙대로 만든다.
//! `NaN`·`Infinity`·`-0`은 `js_json::NONFINITE_KEY` 표시 객체로 쓴다(`encodeNative`·`decodeNative`와 같은 규칙).

use crate::js_json::NONFINITE_KEY;
use saphyr_parser::{Event, Parser, ScalarStyle};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// 이벤트 중첩이 이 깊이를 넘으면 지원하지 않는다. JS는 약 700~1000(스택 크기에 따라 다름)에서 실패하고 파서의 한도는 256이라, 어느 쪽이든 겹치지 않게 낮게 잡는다
pub const MAX_DEPTH: usize = 64;
/// JS `yaml`의 `maxAliasCount`
const MAX_ALIAS_COUNT: usize = 100;
/// 별칭·merge를 펼친 값의 노드 수 상한. JS의 별칭 개수 규칙은 merge 자리의 별칭을 세지 않으므로 이 예산이 따로 막는다(merge 자리도 무게대로 센다)
const MAX_EXPANDED_NODES: usize = 2_000_000;
/// 읽는 글자의 상한(바이트). spec의 파일 읽기(`readProjectText`)가 같은 값으로 읽기 전에 막는다
pub const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
/// 펼친 스칼라 글자(키 포함)의 바이트 합 상한: 입력 크기의 32배, 다만 1MiB 이상 32MiB 이하. 큰 스칼라를 별칭·merge로 여러 번 펼쳐 메모리를 쓰게 하는 것을 막는다
fn expanded_byte_limit(input_len: usize) -> usize {
    input_len.saturating_mul(32).clamp(1 << 20, 32 << 20)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// JSON 글자(`JSON.parse` + `decodeNative`로 읽는다)
    Value(String),
    /// YAML 문법이 올바르지 않거나 JS `yaml`도 실패하는 입력(중복 키, 별칭 오류, 문서가 둘 이상 등). 줄·칸은 1부터, 모르면 0
    Syntax { message: String, line: usize, col: usize },
    /// JS와 다르게 읽을 수 있어 읽지 않는 꼴
    Unsupported { reason: String, line: usize, col: usize },
}

type Pos = (usize, usize);

#[derive(Debug)]
enum Fail {
    Syntax(String, Pos),
    Unsupported(String, Pos),
}

fn syntax<T>(message: &str, pos: Pos) -> Result<T, Fail> {
    Err(Fail::Syntax(message.to_owned(), pos))
}
fn unsupported<T>(reason: &str, pos: Pos) -> Result<T, Fail> {
    Err(Fail::Unsupported(reason.to_owned(), pos))
}

pub fn parse(text: &str, merge: bool) -> Outcome {
    match run(text, merge) {
        Ok(json) => Outcome::Value(json),
        Err(Fail::Syntax(message, (line, col))) => Outcome::Syntax { message, line, col },
        Err(Fail::Unsupported(reason, (line, col))) => Outcome::Unsupported { reason, line, col },
    }
}

fn run(text: &str, merge: bool) -> Result<String, Fail> {
    if text.len() > MAX_INPUT_BYTES {
        return unsupported("글이 너무 큽니다", (0, 0));
    }
    let built = build_events(text, merge)?;
    scan_text(text, &built.block_lines, &built.multiline, &built.quoted_multiline)?;
    let value = match built.docs.len() {
        0 => V::Null,
        1 => n_to_v(&built.docs[0], merge, text.len())?,
        _ => return syntax("문서가 둘 이상입니다", built.docs[1].pos),
    };
    let mut out = String::new();
    emit(&value, &mut out, 0)?;
    Ok(out)
}

// ───────────────────────── 값 ─────────────────────────

#[derive(Clone, Debug)]
enum V {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Seq(Vec<V>),
    Map(Vec<(V, V)>),
}

fn num_text(f: f64) -> String {
    if f.is_nan() || f.is_infinite() || (f == 0.0 && f.is_sign_negative()) {
        let label = if f.is_nan() { "NaN" } else if f.is_infinite() { if f > 0.0 { "Infinity" } else { "-Infinity" } } else { "-0" };
        return format!("{{\"{NONFINITE_KEY}\":\"{label}\"}}").replace('\u{0}', "\\u0000");
    }
    if f == f.trunc() && f.abs() < 1e15 {
        return format!("{}", f as i64);
    }
    serde_json::to_string(&f).unwrap_or_else(|_| "null".to_owned())
}

/// JS 객체 키가 되는 글자. 컬렉션 키는 JS가 YAML 글자로 바꾸는 규칙이라 흉내 내지 않는다
fn key_string(v: &V) -> Option<String> {
    match v {
        V::Null => Some(String::new()),
        V::Bool(b) => Some(b.to_string()),
        V::Num(f) => Some(js_num_string(*f)),
        V::Str(s) => Some(s.clone()),
        _ => None,
    }
}

/// JS `String(number)`
fn js_num_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return "0".into();
    }
    let a = f.abs();
    if !(1e-6..1e21).contains(&a) {
        let s = format!("{f:e}");
        if let Some(i) = s.find('e') {
            let (m, e) = s.split_at(i);
            let e = &e[1..];
            return if e.starts_with('-') { format!("{m}e{e}") } else { format!("{m}e+{e}") };
        }
        return s;
    }
    format!("{f}")
}

fn emit(v: &V, out: &mut String, depth: usize) -> Result<(), Fail> {
    // 펼친 값의 깊이는 n_to_v가 MAX_DEPTH로 막지만, 여기서도 같은 상한을 보아 재귀가 스택을 넘지 않게 한다
    if depth > MAX_DEPTH {
        return unsupported("너무 깊은 중첩", (0, 0));
    }
    match v {
        V::Null => out.push_str("null"),
        V::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        V::Num(f) => out.push_str(&num_text(*f)),
        V::Str(s) => out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned())),
        V::Seq(a) => {
            out.push('[');
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                emit(e, out, depth + 1)?;
            }
            out.push(']');
        }
        V::Map(m) => {
            // JS 객체: 같은 키는 첫 자리에서 값만 바뀐다. 키 순서(정수 꼴이 앞)는 JS의 JSON.parse가 정한다
            let mut seen: Vec<(String, &V)> = Vec::new();
            let mut index: HashMap<String, usize> = HashMap::new();
            for (k, e) in m {
                let Some(key) = key_string(k) else { return unsupported("컬렉션을 키로 쓴 매핑", (0, 0)) };
                // NUL로 시작하는 키는 표시 객체와 겹칠 수 있어 받지 않는다(encodeNative와 같은 규칙)
                if key.starts_with('\u{0}') {
                    return unsupported("NUL로 시작하는 키", (0, 0));
                }
                match index.get(&key) {
                    Some(&i) => seen[i].1 = e,
                    None => {
                        index.insert(key.clone(), seen.len());
                        seen.push((key, e));
                    }
                }
            }
            out.push('{');
            for (i, (k, e)) in seen.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_else(|_| "\"\"".to_owned()));
                out.push(':');
                emit(e, out, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

// ───────────────────────── 이벤트 → 노드 ─────────────────────────

struct N {
    kind: Kind,
    pos: Pos,
    /// 별칭을 따라 펼쳤을 때의 컬렉션 중첩(글자 위의 중첩이 아니다). 상한을 넘는 노드는 만들지 않는다: 깊은 별칭 사슬은 값으로 바꿀 때뿐 아니라 해제할 때도 재귀가 스택을 넘기기 때문이다
    depth: usize,
}

impl N {
    fn new(kind: Kind, pos: Pos) -> Result<Rc<N>, Fail> {
        let depth = match &kind {
            Kind::Scalar(..) => 0,
            Kind::Alias(t) => t.depth,
            Kind::Seq(v) => 1 + v.iter().map(|e| e.depth).max().unwrap_or(0),
            Kind::Map(m) => 1 + m.iter().map(|(k, v)| k.depth.max(v.depth)).max().unwrap_or(0),
        };
        if depth > MAX_DEPTH {
            return unsupported("펼친 값의 중첩이 너무 깊습니다", pos);
        }
        Ok(Rc::new(N { kind, pos, depth }))
    }
}
enum Kind {
    Alias(Rc<N>),
    Scalar(String, ScalarStyle),
    Seq(Vec<Rc<N>>),
    Map(Vec<(Rc<N>, Rc<N>)>),
}

struct Built {
    docs: Vec<Rc<N>>,
    /// 블록 스칼라 본문의 줄 번호 범위(1부터, 끝 포함)
    block_lines: Vec<(usize, usize)>,
    /// 여러 줄에 걸친 흐름 컬렉션·따옴표 글자의 줄 번호 범위(1부터, 끝 포함)
    multiline: Vec<(usize, usize)>,
    /// 여러 줄 따옴표 글자의 (시작 줄, 끝 줄, 시작 칸(0부터)). 이 줄들은 따옴표 안이라 줄 단위 글자 검사를 따로 한다
    quoted_multiline: Vec<(usize, usize, usize)>,
}

enum Frame {
    Seq(Vec<Rc<N>>, usize, Pos, Option<(usize, usize)>),
    Map(Vec<(Rc<N>, Rc<N>)>, Option<Rc<N>>, usize, Pos, Option<(usize, usize)>),
}

fn is_merge_key_node(n: &N) -> bool {
    matches!(&n.kind, Kind::Scalar(s, ScalarStyle::Plain) if s == "<<")
}

fn alias_weight(n: &Rc<N>, meta: &HashMap<usize, (usize, usize, bool)>, ids: &HashMap<*const N, usize>) -> usize {
    match &n.kind {
        Kind::Alias(target) => ids.get(&Rc::as_ptr(target)).and_then(|id| meta.get(id)).map(|(c, a, _)| c * a).unwrap_or(0),
        Kind::Scalar(..) => 1,
        Kind::Seq(v) => v.iter().map(|e| alias_weight(e, meta, ids)).max().unwrap_or(0),
        Kind::Map(m) => m.iter().map(|(k, v)| alias_weight(k, meta, ids).max(alias_weight(v, meta, ids))).max().unwrap_or(0),
    }
}

fn build_events(src: &str, merge: bool) -> Result<Built, Fail> {
    let chars: Vec<char> = src.chars().collect();
    let parser = Parser::new_from_str(src);
    let mut docs: Vec<Rc<N>> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut anchors: HashMap<usize, Option<Rc<N>>> = HashMap::new();
    // 별칭 개수 규칙(JS maxAliasCount): 앵커마다 (참조 횟수, 가중치). 앵커 노드의 주소로 앵커를 찾는다
    let mut meta: HashMap<usize, (usize, usize, bool)> = HashMap::new();
    let mut ids: HashMap<*const N, usize> = HashMap::new();
    let mut root: Option<Rc<N>> = None;
    let mut block_lines: Vec<(usize, usize)> = Vec::new();
    let mut multiline: Vec<(usize, usize)> = Vec::new();
    let mut quoted_multiline: Vec<(usize, usize, usize)> = Vec::new();

    fn put(stack: &mut [Frame], root: &mut Option<Rc<N>>, n: Rc<N>) -> Result<(), Fail> {
        match stack.last_mut() {
            None => *root = Some(n),
            Some(Frame::Seq(v, ..)) => v.push(n),
            Some(Frame::Map(v, pending, ..)) => match pending.take() {
                None => {
                    // 키 자리의 빈 plain 스칼라는 키가 없는 `: 값`이다. JS는 대부분 거절한다
                    if matches!(&n.kind, Kind::Scalar(s, ScalarStyle::Plain) if s.is_empty()) {
                        return unsupported("키가 없는 매핑 항목", n.pos);
                    }
                    *pending = Some(n)
                }
                Some(k) => v.push((k, n)),
            },
        }
        Ok(())
    }
    let pos_of = |sp: &saphyr_parser::Span| (sp.start.line(), sp.start.col() + 1);
    let flow_start = |sp: &saphyr_parser::Span| matches!(chars.get(sp.start.index()), Some('[') | Some('{'));

    for item in parser {
        let (ev, sp) = match item {
            Ok(x) => x,
            Err(e) => {
                let m = e.marker();
                // 파서의 글 하나(`unexpected character`)는 문제 글자를 담는다. 읽으면 안 되는 파일의 내용이 오류 글로 새지 않게 글자를 뺀다
                let info = if e.info().starts_with("unexpected character") { "예상하지 못한 글자가 있습니다" } else { e.info() };
                return Err(Fail::Syntax(info.to_owned(), (m.line(), m.col() + 1)));
            }
        };
        let pos = pos_of(&sp);
        match ev {
            Event::Nothing | Event::StreamStart | Event::StreamEnd => {}
            Event::DocumentStart(_) => {
                root = None;
                anchors.clear();
                meta.clear();
                ids.clear();
            }
            Event::DocumentEnd => {
                let node = match root.take() {
                    Some(n) => n,
                    None => N::new(Kind::Scalar(String::new(), ScalarStyle::Plain), pos)?,
                };
                docs.push(node);
            }
            Event::Alias(id) => {
                let target = match anchors.get(&id) {
                    Some(Some(n)) => n.clone(),
                    Some(None) => return unsupported("자기 자신을 품는 별칭", pos),
                    None => return syntax("정의되지 않은 앵커의 별칭입니다", pos),
                };
                // merge 키 값의 별칭은 세지 않는다(JS는 merge 원본을 별칭 해석으로 풀 뿐 toJSON을 부르지 않는다)
                let is_merge_ctx = merge && {
                    let key_is_merge = |f: &Frame| matches!(f, Frame::Map(_, Some(k), ..) if is_merge_key_node(k));
                    match stack.last() {
                        Some(f) if key_is_merge(f) => true,
                        Some(Frame::Seq(..)) if stack.len() >= 2 && key_is_merge(&stack[stack.len() - 2]) => true,
                        _ => false,
                    }
                };
                if !is_merge_ctx {
                    let anchor_id = *ids.get(&Rc::as_ptr(&target)).unwrap_or(&id);
                    let e = meta.entry(anchor_id).or_insert((1, 0, false));
                    e.0 += 1;
                    // 무게가 0이어도 한 번 계산한 값을 쓴다(JS는 0이면 다시 계산하지만 0은 늘지 않는다). 다시 계산하면 별칭마다 대상 전체를 훑는다
                    if !e.2 {
                        let w = alias_weight(&target, &meta, &ids);
                        let e = meta.get_mut(&anchor_id).unwrap();
                        e.1 = w;
                        e.2 = true;
                    }
                    let (c, a, _) = meta[&anchor_id];
                    if c * a > MAX_ALIAS_COUNT {
                        return syntax("별칭이 너무 많이 펼쳐집니다(JS yaml의 maxAliasCount)", pos);
                    }
                }
                put(&mut stack, &mut root, N::new(Kind::Alias(target), pos)?)?;
            }
            Event::Scalar(text, style, anchor, tag) => {
                // 지역 태그(`!이름`)만 읽는다: JS는 알 수 없는 태그를 경고만 하고 글자 그대로의 문자열로 둔다. `!!str` 같은 core 태그와 `!!binary`·`!!set` 등 JS가 값을 바꾸는 태그, 태그 지시문이 필요한 꼴은 지원하지 않는다
                let tagged = match &tag {
                    None => false,
                    Some(t) if t.handle == "!" => true,
                    Some(_) => return unsupported("지역 태그(!이름)가 아닌 태그", pos),
                };
                if tagged && style == ScalarStyle::Plain && text.is_empty() {
                    return unsupported("내용 없이 태그만 있는 글자", pos);
                }
                if style == ScalarStyle::Plain && (text.starts_with('|') || text.starts_with('>')) {
                    return unsupported("흐름 안에서 |, >로 시작하는 글자", pos);
                }
                if matches!(style, ScalarStyle::SingleQuoted | ScalarStyle::DoubleQuoted) && sp.start.line() != sp.end.line() {
                    multiline.push((sp.start.line(), sp.end.line()));
                    quoted_multiline.push((sp.start.line(), sp.end.line(), sp.start.col()));
                }
                if matches!(style, ScalarStyle::Literal | ScalarStyle::Folded) {
                    let last = if sp.end.col() == 0 && sp.end.line() > sp.start.line() { sp.end.line() - 1 } else { sp.end.line() };
                    block_lines.push((sp.start.line(), last.max(sp.start.line())));
                }
                // 태그가 붙은 스칼라는 해석하지 않고 문자열로 둔다
                let n = N::new(Kind::Scalar(text.to_string(), if tagged { ScalarStyle::SingleQuoted } else { style }), pos)?;
                if anchor > 0 {
                    anchors.insert(anchor, Some(n.clone()));
                    ids.insert(Rc::as_ptr(&n), anchor);
                    meta.insert(anchor, (1, 0, false));
                }
                put(&mut stack, &mut root, n)?;
            }
            Event::SequenceStart(anchor, tag) => {
                if tag.as_ref().is_some_and(|t| t.handle != "!") {
                    return unsupported("지역 태그(!이름)가 아닌 태그", pos);
                }
                if stack.len() >= MAX_DEPTH {
                    return unsupported("너무 깊은 중첩", pos);
                }
                if anchor > 0 {
                    anchors.insert(anchor, None);
                }
                stack.push(Frame::Seq(Vec::new(), anchor, pos, flow_start(&sp).then_some((sp.start.line(), 0))));
            }
            Event::MappingStart(anchor, tag) => {
                if tag.as_ref().is_some_and(|t| t.handle != "!") {
                    return unsupported("지역 태그(!이름)가 아닌 태그", pos);
                }
                if stack.len() >= MAX_DEPTH {
                    return unsupported("너무 깊은 중첩", pos);
                }
                if anchor > 0 {
                    anchors.insert(anchor, None);
                }
                stack.push(Frame::Map(Vec::new(), None, anchor, pos, flow_start(&sp).then_some((sp.start.line(), 0))));
            }
            Event::SequenceEnd => {
                if let Some(Frame::Seq(v, anchor, start, flow)) = stack.pop() {
                    if let Some((line, _)) = flow.filter(|(line, _)| *line != sp.start.line()) {
                        multiline.push((line, sp.start.line()));
                    }
                    let n = N::new(Kind::Seq(v), start)?;
                    if anchor > 0 {
                        anchors.insert(anchor, Some(n.clone()));
                        ids.insert(Rc::as_ptr(&n), anchor);
                        meta.insert(anchor, (1, 0, false));
                    }
                    put(&mut stack, &mut root, n)?;
                }
            }
            Event::MappingEnd => {
                if let Some(Frame::Map(v, pending, anchor, start, flow)) = stack.pop() {
                    if pending.is_some() {
                        return syntax("매핑의 키에 값이 없습니다", start);
                    }
                    if let Some((line, _)) = flow.filter(|(line, _)| *line != sp.start.line()) {
                        multiline.push((line, sp.start.line()));
                    }
                    let n = N::new(Kind::Map(v), start)?;
                    if anchor > 0 {
                        anchors.insert(anchor, Some(n.clone()));
                        ids.insert(Rc::as_ptr(&n), anchor);
                        meta.insert(anchor, (1, 0, false));
                    }
                    put(&mut stack, &mut root, n)?;
                }
            }
        }
    }
    Ok(Built { docs, block_lines, multiline, quoted_multiline })
}

// ───────────────────────── 노드 → 값 (yaml 2.9 core 스키마) ─────────────────────────

fn resolve_plain(s: &str) -> V {
    // null, bool, intOct, int, intHex, floatNaN, floatExp, float 순서(yaml 2.9 core 스키마)
    if s.is_empty() || s == "~" || s == "null" || s == "Null" || s == "NULL" {
        return V::Null;
    }
    if matches!(s, "true" | "True" | "TRUE") {
        return V::Bool(true);
    }
    if matches!(s, "false" | "False" | "FALSE") {
        return V::Bool(false);
    }
    let b = s.as_bytes();
    let all = |t: &[u8], f: fn(&u8) -> bool| !t.is_empty() && t.iter().all(f);
    if let Some(r) = s.strip_prefix("0o") {
        if all(r.as_bytes(), |c| (b'0'..=b'7').contains(c)) {
            return V::Num(radix(r, 8));
        }
    }
    {
        let t = if b[0] == b'-' || b[0] == b'+' { &b[1..] } else { b };
        if all(t, |c| c.is_ascii_digit()) {
            return V::Num(signed_zero(s, s.trim_start_matches('+').parse().unwrap_or(f64::NAN)));
        }
    }
    if let Some(r) = s.strip_prefix("0x") {
        if all(r.as_bytes(), |c| c.is_ascii_hexdigit()) {
            return V::Num(radix(r, 16));
        }
    }
    if matches!(s, ".nan" | ".NaN" | ".NAN") {
        return V::Num(f64::NAN);
    }
    if matches!(s, ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF") {
        return V::Num(f64::INFINITY);
    }
    if matches!(s, "-.inf" | "-.Inf" | "-.INF") {
        return V::Num(f64::NEG_INFINITY);
    }
    // floatExp: ^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$   float: ^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$
    let t = if b[0] == b'-' || b[0] == b'+' { &s[1..] } else { s };
    let (mant, exp) = match t.find(['e', 'E']) {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let mb = mant.as_bytes();
    let digits = |x: &[u8]| !x.is_empty() && x.iter().all(u8::is_ascii_digit);
    let mant_ok = if let Some(r) = mant.strip_prefix('.') {
        digits(r.as_bytes())
    } else {
        match mant.find('.') {
            Some(i) => digits(&mb[..i]) && mb[i + 1..].iter().all(u8::is_ascii_digit),
            None => exp.is_some() && digits(mb),
        }
    };
    let exp_ok = match exp {
        None => true,
        Some(e) => {
            let body = e.strip_prefix(['-', '+']).unwrap_or(e);
            digits(body.as_bytes())
        }
    };
    if mant_ok && exp_ok {
        return V::Num(signed_zero(s, s.trim_start_matches('+').parse().unwrap_or(f64::NAN)));
    }
    V::Str(s.to_owned())
}

/// `parseInt("-0")`·`parseFloat("-0.0")`은 -0이다
fn signed_zero(s: &str, f: f64) -> f64 {
    if s.starts_with('-') && f == 0.0 {
        -0.0
    } else {
        f
    }
}

fn radix(t: &str, r: u32) -> f64 {
    if let Ok(v) = u128::from_str_radix(t, r) {
        return v as f64;
    }
    t.chars().fold(0.0, |a, c| a * r as f64 + c.to_digit(r).unwrap_or(0) as f64)
}

fn deref(n: &Rc<N>) -> &Rc<N> {
    let mut c = n;
    while let Kind::Alias(t) = &c.kind {
        c = t;
    }
    c
}

/// 키를 견주는 값. 대상 객체는 키를 글자로 바꿔 견주고(`1`과 `"1"`이 같다), 병합 원본은 타입을 지킨다. 해시로 찾아 한 번 넣는 데 드는 일을 상수로 둔다
#[derive(PartialEq, Eq, Hash)]
enum KeyId {
    Null,
    Bool(bool),
    Num(u64),
    Str(String),
}

fn key_id(v: &V, typed: bool) -> Option<KeyId> {
    if !typed {
        return key_string(v).map(KeyId::Str);
    }
    Some(match v {
        V::Null => KeyId::Null,
        V::Bool(b) => KeyId::Bool(*b),
        // SameValueZero: NaN은 NaN과 같고 0은 -0과 같다
        V::Num(f) => KeyId::Num(if f.is_nan() { 0x7ff8_0000_0000_0000 } else if *f == 0.0 { 0 } else { f.to_bits() }),
        V::Str(s) => KeyId::Str(s.clone()),
        _ => return None,
    })
}

/// 순서를 지키는 쌍 목록과 그 키 색인
struct Pairs {
    typed: bool,
    list: Vec<(V, V)>,
    index: HashMap<KeyId, usize>,
}

impl Pairs {
    fn new(typed: bool) -> Self {
        Pairs { typed, list: Vec::new(), index: HashMap::new() }
    }

    /// JS 객체·Map의 대입: 같은 키가 있으면 첫 자리에서 값만 바뀐다
    fn put(&mut self, k: V, v: V) {
        match key_id(&k, self.typed) {
            Some(id) => match self.index.get(&id) {
                Some(&p) => self.list[p].1 = v,
                None => {
                    self.index.insert(id, self.list.len());
                    self.list.push((k, v));
                }
            },
            None => self.list.push((k, v)),
        }
    }

    /// 병합: 이미 있는 키는 건드리지 않는다
    fn merge_in(&mut self, k: V, v: V) {
        // 대상 객체에 들어갈 때 키가 글자가 된다: null은 "null"(보통의 null 키는 "")
        let k = if !self.typed && matches!(k, V::Null) { V::Str("null".into()) } else { k };
        if let Some(id) = key_id(&k, self.typed) {
            if self.index.contains_key(&id) {
                return;
            }
            self.index.insert(id, self.list.len());
        }
        self.list.push((k, v));
    }
}

struct Budget {
    nodes: usize,
    bytes: usize,
    byte_limit: usize,
}

impl Budget {
    /// 방문 하나를 센다. 값을 만들든 합쳐서 버리든 같다
    fn visit(&mut self, pos: Pos) -> Result<(), Fail> {
        self.nodes += 1;
        if self.nodes > MAX_EXPANDED_NODES {
            return unsupported("별칭·병합이 너무 크게 펼쳐집니다", pos);
        }
        Ok(())
    }
}

fn n_to_v(n: &Rc<N>, merge: bool, input_len: usize) -> Result<V, Fail> {
    let mut budget = Budget { nodes: 0, bytes: 0, byte_limit: expanded_byte_limit(input_len) };
    n_to_v_inner(n, merge, &mut budget, 0)
}

/// `depth`는 펼친 값의 컬렉션 중첩이다. 별칭이 깊은 노드를 가리키고 그 안에서 다시 별칭을 쓰면 글자의 깊이보다 크게 불어나므로 여기서 막는다
fn n_to_v_inner(n: &Rc<N>, merge: bool, budget: &mut Budget, depth: usize) -> Result<V, Fail> {
    budget.visit(n.pos)?;
    if depth > MAX_DEPTH {
        return unsupported("펼친 값의 중첩이 너무 깊습니다", n.pos);
    }
    Ok(match &n.kind {
        Kind::Alias(t) => return n_to_v_inner(t, merge, budget, depth),
        Kind::Scalar(s, style) => {
            budget.bytes = budget.bytes.saturating_add(s.len());
            if budget.bytes > budget.byte_limit {
                return unsupported("별칭이 글자를 너무 크게 펼칩니다", n.pos);
            }
            if *style == ScalarStyle::Plain {
                resolve_plain(s)
            } else {
                V::Str(s.clone())
            }
        }
        Kind::Seq(v) => V::Seq(v.iter().map(|e| n_to_v_inner(e, merge, budget, depth + 1)).collect::<Result<_, _>>()?),
        Kind::Map(m) => V::Map(map_pairs(m, merge, false, budget, depth + 1)?),
    })
}

fn map_pairs(m: &[(Rc<N>, Rc<N>)], merge: bool, typed: bool, budget: &mut Budget, depth: usize) -> Result<Vec<(V, V)>, Fail> {
    let first = m.first().map(|(k, _)| k.pos).unwrap_or((0, 0));
    // 방문 수를 센다(결과 크기가 아니다): merge가 앞 단계를 여러 번 겹쳐 병합하면 결과는 작아도 방문이 지수로 늘 수 있다
    budget.visit(first)?;
    if depth > MAX_DEPTH {
        return unsupported("펼친 값의 중첩이 너무 깊습니다", first);
    }
    let mut out = Pairs::new(typed);
    // 중복 키: 해석된 스칼라 값이 같으면 중복(merge 키는 제외, 별칭 키는 검사하지 않는다, NaN은 서로 같지 않다)
    let mut seen: HashSet<KeyId> = HashSet::new();
    for (k, val) in m {
        budget.visit(k.pos)?;
        if merge && is_merge_key_node(k) {
            let srcs: Vec<&Rc<N>> = match &deref(val).kind {
                Kind::Seq(v) => v.iter().collect(),
                _ => vec![val],
            };
            for s in srcs {
                budget.visit(s.pos)?;
                match &deref(s).kind {
                    Kind::Map(sm) => {
                        for (sk, sv) in map_pairs(sm, merge, true, budget, depth + 1)? {
                            budget.visit(s.pos)?;
                            out.merge_in(sk, sv);
                        }
                    }
                    _ => return syntax("병합(<<)의 원본은 매핑이어야 합니다", s.pos),
                }
            }
            continue;
        }
        let kv = n_to_v_inner(k, merge, budget, depth)?;
        if matches!(&k.kind, Kind::Scalar(..)) {
            if let Some(id) = key_id(&kv, true) {
                if !matches!(&kv, V::Num(f) if f.is_nan()) && !seen.insert(id) {
                    return syntax("매핑의 키가 중복됩니다", k.pos);
                }
            }
        }
        let vv = n_to_v_inner(val, merge, budget, depth)?;
        out.put(kv, vv);
    }
    Ok(out.list)
}

// ───────────────────────── 글자 단위 거절 규칙 ─────────────────────────

fn is_special(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' | '\u{fffe}' | '\u{ffff}')
}

fn is_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}')
}

fn is_blank_or_comment(line: &str) -> bool {
    let t = line.trim_start_matches(' ');
    t.is_empty() || t.starts_with('#')
}

/// 이벤트만으로는 알 수 없는 것을 줄 단위로 본다. 따옴표 안·주석 안·블록 스칼라 본문 안의 글자는 구조가 아니므로 더 너그럽게 본다.
/// 모르는 입력은 거절한다(닫는 쪽)
fn scan_text(text: &str, block_lines: &[(usize, usize)], multiline: &[(usize, usize)], quoted: &[(usize, usize, usize)]) -> Result<(), Fail> {
    // JS yaml은 줄바꿈 없는 `\r`을 줄 끝으로 읽지 않는다(내용이다). 파서는 줄 끝으로 읽는다
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\r' && bytes.get(i + 1) != Some(&b'\n') {
            let line = text[..i].matches('\n').count() + 1;
            return unsupported("줄바꿈이 \\r 하나인 줄", (line, 0));
        }
    }
    // JS `yaml`은 BOM을 문서 맨 앞에서도 자리에 따라 다르게 읽는다(`\ufeffa: 1`은 읽고 `\ufeff- a`는 실패한다). 모두 거절한다
    if let Some(i) = text.find('\u{feff}') {
        let line = text[..i].matches('\n').count() + 1;
        return unsupported("BOM(U+FEFF)", (line, 0));
    }
    // 마지막 줄이 공백뿐이고 줄바꿈 없이 끝나면 블록 스칼라 끝 처리가 달라질 수 있다
    if let Some(i) = text.rfind('\n') {
        let tail = &text[i + 1..];
        if !tail.is_empty() && tail.chars().all(|c| c == ' ') {
            return unsupported("줄바꿈 없이 공백으로 끝나는 마지막 줄", (text.matches('\n').count() + 1, 1));
        }
    }
    check_multiline(text, multiline)?;
    // 줄마다 범위 목록을 훑으면 줄 수 × 범위 수가 된다(블록 스칼라가 많은 큰 입력). 줄 번호로 바로 찾는 표를 만든다
    let line_count = text.matches('\n').count() + 2;
    let mut body_line = vec![false; line_count + 1];
    for &(a, b) in block_lines {
        for slot in body_line.iter_mut().take(b.min(line_count) + 1).skip(a) {
            *slot = true;
        }
    }
    let mut quoted_at: Vec<Option<(usize, usize)>> = vec![None; line_count + 1];
    for &(a, b, col) in quoted {
        for slot in quoted_at.iter_mut().take(b.min(line_count) + 1).skip(a) {
            *slot = Some((a, col));
        }
    }
    let in_block = |line: usize| body_line.get(line).copied().unwrap_or(false);
    let mut seen_content = false;
    let mut seen_start = false;
    let mut ended: Option<usize> = None;
    for (idx, raw) in text.split('\n').enumerate() {
        let line_no = idx + 1;
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let body = in_block(line_no);
        if ended.is_some() && !is_blank_or_comment(line) {
            return unsupported("문서 끝 표시(...) 뒤의 내용", (line_no, 1));
        }
        if body {
            // 본문 안의 문서 표시는 블록 스칼라를 끝내는 표시인데 파서는 본문으로 읽는다
            if ["---", "..."].iter().any(|m| line.starts_with(m) && line[3..].chars().next().is_none_or(|c| c == ' ' || c == '\t')) {
                return unsupported("블록 스칼라 안의 문서 표시", (line_no, 1));
            }
            // 본문은 글자 그대로의 내용이다. 줄 맨 앞의 탭만 JS가 거절하는 자리가 있다
            if line.trim_start_matches(' ').starts_with('\t') {
                return unsupported("들여쓰기의 탭", (line_no, 1));
            }
            if let Some(c) = line.chars().find(|c| is_special(*c)) {
                let _ = c;
                return unsupported("제어·특수 문자", (line_no, 1));
            }
            seen_content = true;
            continue;
        }
        // 줄 맨 앞(0칸)의 문서 표시·지시문
        let marker = |m: &str| line.starts_with(m) && line[m.len()..].chars().next().is_none_or(|c| c == ' ' || c == '\t');
        if marker("---") {
            let rest = line[3..].trim_start_matches(' ');
            if seen_content || seen_start || !(rest.is_empty() || rest.starts_with('#')) {
                return unsupported("문서 시작 표시(---)는 첫 줄에 한 번만 쓸 수 있습니다", (line_no, 1));
            }
            seen_start = true;
            continue;
        }
        if marker("...") {
            let rest = line[3..].trim_start_matches(' ');
            if !(rest.is_empty() || rest.starts_with('#')) {
                return unsupported("문서 끝 표시(...) 뒤의 내용", (line_no, 1));
            }
            ended = Some(line_no);
            continue;
        }
        if line.starts_with('%') {
            return unsupported("지시문(%)", (line_no, 1));
        }
        if !is_blank_or_comment(line) {
            seen_content = true;
        }
        // 여러 줄 따옴표 글자: 시작 줄은 따옴표 앞까지만 구조로 보고, 따옴표 안의 줄은 글자 검사만 한다
        if let Some((start, col)) = quoted_at.get(line_no).copied().flatten() {
            if let Some(c) = line.chars().find(|c| is_special(*c)) {
                let _ = c;
                return unsupported("제어·특수 문자", (line_no, 1));
            }
            if line_no == start {
                scan_line(&line.chars().take(col).collect::<String>(), line_no)?;
            } else if line.trim_start_matches(' ').starts_with('\t') {
                return unsupported("들여쓰기의 탭", (line_no, 1));
            }
            continue;
        }
        scan_line(line, line_no)?;
    }
    Ok(())
}

fn scan_line(line: &str, line_no: usize) -> Result<(), Fail> {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() && chars[i] == ' ' {
        i += 1;
    }
    if chars.get(i) == Some(&'\t') {
        return unsupported("들여쓰기의 탭", (line_no, i + 1));
    }
    let (mut in_single, mut in_double) = (false, false);
    let mut prev = ' ';
    let opens = |p: char| p == ' ' || matches!(p, '[' | '{' | ',');
    while i < chars.len() {
        let c = chars[i];
        let col = i + 1;
        if in_double {
            if is_special(c) {
                return unsupported("제어·특수 문자", (line_no, col));
            }
            if c == '\\' {
                i += 1;
            } else if c == '"' {
                in_double = false;
            }
        } else if in_single {
            if is_special(c) {
                return unsupported("제어·특수 문자", (line_no, col));
            }
            if c == '\'' {
                if chars.get(i + 1) == Some(&'\'') {
                    i += 1;
                } else {
                    in_single = false;
                }
            }
        } else {
            if c == '#' && opens_comment(prev) {
                // 주석: 제어 문자(탭 제외)만 거절한다. 다른 유니코드는 구조가 아니다
                if let Some(bad) = chars[i..].iter().position(|ch| is_control(*ch)) {
                    return unsupported("주석 안의 제어 문자", (line_no, i + bad + 1));
                }
                return Ok(());
            }
            if is_special(c) {
                return unsupported("제어·특수 문자", (line_no, col));
            }
            match c {
                '\t' => return unsupported("구조 자리의 탭", (line_no, col)),
                '"' if opens(prev) => in_double = true,
                '\'' if opens(prev) => in_single = true,
                '!' if opens(prev) => {
                    // JS는 태그 이름에 ':'를 넣어 읽는다(`!x: 값`의 태그는 `!x:`). 파서는 ':' 앞에서 끊는다
                    let name: String = chars[i + 1..].iter().take_while(|ch| !matches!(ch, ' ' | ',' | '[' | ']' | '{' | '}')).collect();
                    if name.contains(':') {
                        return unsupported("콜론이 들어간 태그 이름", (line_no, col));
                    }
                }
                '&' if opens(prev) => {
                    let name: String = chars[i + 1..].iter().take_while(|ch| !matches!(ch, ' ' | ',' | '[' | ']' | '{' | '}')).collect();
                    if name.contains(':') {
                        return unsupported("콜론이 들어간 앵커 이름", (line_no, col));
                    }
                }
                _ => {}
            }
        }
        prev = chars.get(i).copied().unwrap_or(' ');
        i += 1;
    }
    if in_single || in_double {
        return unsupported("닫히지 않은 따옴표", (line_no, 1));
    }
    Ok(())
}

fn opens_comment(prev: char) -> bool {
    prev == ' ' || prev == '\t'
}

/// 여러 줄에 걸친 흐름 컬렉션·따옴표 글자의 이어지는 줄은 부모 항목보다 더 들여써야 한다. JS는 부모 블록의 들여쓰기 이하이면 실패하고 파서는 읽는다.
/// 부모 항목의 시작 칸(첫 줄에서 `- `를 뗀 뒤의 칸)보다 깊을 때만 읽는다. JS의 기준(부모 블록의 들여쓰기)보다 같거나 엄격하다
fn check_multiline(text: &str, multiline: &[(usize, usize)]) -> Result<(), Fail> {
    if multiline.is_empty() {
        return Ok(());
    }
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let mut spans = multiline.to_vec();
    spans.sort();
    let mut covered_until = 0;
    for (start, end) in spans {
        if start <= covered_until {
            continue; // 바깥 범위 안에 든 것은 바깥이 본다
        }
        covered_until = end;
        let first = lines.get(start - 1).copied().unwrap_or("");
        let mut col = first.len() - first.trim_start_matches(' ').len();
        let mut rest = &first[col..];
        while let Some(r) = rest.strip_prefix("- ") {
            let trimmed = r.trim_start_matches(' ');
            col += 2 + (r.len() - trimmed.len());
            rest = trimmed;
        }
        for line_no in start + 1..=end {
            let line = lines.get(line_no - 1).copied().unwrap_or("");
            if line.trim_start_matches(' ').is_empty() {
                continue;
            }
            let indent = line.len() - line.trim_start_matches(' ').len();
            if indent <= col {
                return unsupported("여러 줄 글자·흐름 컬렉션의 이어지는 줄이 부모 항목보다 깊지 않습니다", (line_no, 1));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str, merge: bool) -> String {
        match parse(text, merge) {
            Outcome::Value(json) => json,
            other => panic!("값이어야 합니다: {text:?} → {other:?}"),
        }
    }
    fn unsupported_reason(text: &str) -> String {
        match parse(text, false) {
            Outcome::Unsupported { reason, .. } => reason,
            other => panic!("지원하지 않는 꼴이어야 합니다: {text:?} → {other:?}"),
        }
    }
    fn syntax_message(text: &str, merge: bool) -> String {
        match parse(text, merge) {
            Outcome::Syntax { message, .. } => message,
            other => panic!("문법 오류여야 합니다: {text:?} → {other:?}"),
        }
    }

    #[test]
    fn core_schema_scalars() {
        assert_eq!(value("[yes, no, on, off, y, n, True, TRUE, false, ~, null, Null, NULL, tRue]", false), r#"["yes","no","on","off","y","n",true,true,false,null,null,null,null,"tRue"]"#);
        assert_eq!(value("[0x1F, 0o17, 017, 1e3, .5, 5., +1, -1, 1_000, 0b1, 1:30]", false), r#"[31,15,17,1000,0.5,5,1,-1,"1_000","0b1","1:30"]"#);
        assert_eq!(value("a: -0", false), r#"{"a":{"\u0000nf":"-0"}}"#);
        assert_eq!(value("[.inf, -.inf, .nan, .NaN]", false), r#"[{"\u0000nf":"Infinity"},{"\u0000nf":"-Infinity"},{"\u0000nf":"NaN"},{"\u0000nf":"NaN"}]"#);
        assert_eq!(value("a: 12345678901234567890", false), r#"{"a":1.2345678901234567e+19}"#);
        assert_eq!(value("", false), "null");
        assert_eq!(value("# 주석만\n", false), "null");
    }

    #[test]
    fn quoted_and_block_scalars_stay_strings() {
        assert_eq!(value("[\"yes\", 'null', \"1\"]", false), r#"["yes","null","1"]"#);
        assert_eq!(value("a: |\n  x\n  y\nb: >-\n  p\n  q\n", false), r#"{"a":"x\ny\n","b":"p q"}"#);
    }

    #[test]
    fn duplicate_keys_follow_resolved_scalars() {
        assert!(syntax_message("a: 1\na: 2\n", false).contains("중복"));
        assert!(syntax_message("1: a\n1.0: b\n", false).contains("중복"));
        assert!(syntax_message("a: 1\n\"a\": 2\n", false).contains("중복"));
        // 1과 "1"은 해석한 값이 달라 중복이 아니다(객체에서는 뒤의 것이 이긴다)
        assert_eq!(value("1: a\n\"1\": b\n", false), r#"{"1":"b"}"#);
        // merge 키는 중복으로 세지 않는다
        assert_eq!(value("x: &x {p: 1}\ny: &y {q: 2}\nz:\n  <<: *x\n  <<: *y\n", true), r#"{"x":{"p":1},"y":{"q":2},"z":{"p":1,"q":2}}"#);
    }

    #[test]
    fn merge_only_in_merge_mode_with_js_object_rules() {
        let text = "a: &a {p: 1, q: 2}\nb:\n  q: 9\n  <<: *a\n";
        assert_eq!(value(text, false), r#"{"a":{"p":1,"q":2},"b":{"q":9,"<<":{"p":1,"q":2}}}"#);
        assert_eq!(value(text, true), r#"{"a":{"p":1,"q":2},"b":{"q":9,"p":1}}"#);
        // 병합된 null 키는 "null"이 되고 보통의 null 키는 ""이다
        assert_eq!(value("a: &a {~: 1}\nb:\n  <<: *a\nc: {~: 2}\n", true), r#"{"a":{"":1},"b":{"null":1},"c":{"":2}}"#);
        assert!(syntax_message("b:\n  <<: 1\n", true).contains("병합"));
        // 원본의 앞선 항목이 뒤의 항목을 이긴다
        assert_eq!(value("a: &a {p: 1}\nb: &b {p: 2, r: 3}\nc:\n  <<: [*a, *b]\n", true), r#"{"a":{"p":1},"b":{"p":2,"r":3},"c":{"p":1,"r":3}}"#);
    }

    #[test]
    fn alias_count_follows_js_rule() {
        let refs = |n: usize| format!("a: &a 1\nl: [{}]\n", vec!["*a"; n].join(", "));
        assert!(matches!(parse(&refs(99), false), Outcome::Value(_)));
        assert!(syntax_message(&refs(100), false).contains("별칭"));
        // merge 키의 별칭은 세지 않는다
        let merges: String = "a: &a {p: 1}\n".to_owned() + &(0..150).map(|i| format!("m{i}:\n  <<: *a\n")).collect::<String>();
        assert!(matches!(parse(&merges, true), Outcome::Value(_)));
        assert!(syntax_message(&merges, false).contains("별칭"));
        assert!(matches!(parse("b: *x\n", false), Outcome::Syntax { .. }));
    }

    #[test]
    fn depth_limit() {
        assert!(matches!(parse(&format!("{}{}\n", "[".repeat(60), "]".repeat(60)), false), Outcome::Value(_)));
        assert!(unsupported_reason(&format!("{}{}\n", "[".repeat(70), "]".repeat(70))).contains("깊은"));
    }

    #[test]
    fn common_real_file_shapes_are_read() {
        // 첫 줄의 ---, 끝의 ..., CRLF, 따옴표·주석 안의 탭·!·|·>·유니코드
        assert_eq!(value("---\na: 1\n", false), r#"{"a":1}"#);
        assert_eq!(value("# 머리말\n---\na: 1\n...\n", false), r#"{"a":1}"#);
        assert_eq!(value("a: 1\r\nb: [x, y]\r\n", false), r#"{"a":1,"b":["x","y"]}"#);
        assert_eq!(value("a: \"x\ty!|>\"\nb: 'p\tq'  # 탭\t과 ! | > 그리고 \u{2028}\u{85}\n", false), "{\"a\":\"x\\ty!|>\",\"b\":\"p\\tq\"}");
        assert_eq!(value("a: x!y|z>w\n", false), r#"{"a":"x!y|z>w"}"#);
        assert_eq!(value("a: [\n    1,\n    2\n  ]\n", false), r#"{"a":[1,2]}"#);
        assert_eq!(value("a: \"긴 글\n    이어짐\"\n", false), r#"{"a":"긴 글 이어짐"}"#);
        assert_eq!(value("cmd: !reset [a]\nname: !override x\n", false), r#"{"cmd":["a"],"name":"x"}"#);
        assert_eq!(value("a: |\n  # 본문의 #은 주석이 아니다\n  x\ty\n", false), "{\"a\":\"# 본문의 #은 주석이 아니다\\nx\\ty\\n\"}");
    }

    #[test]
    fn unsupported_shapes_are_rejected() {
        assert!(unsupported_reason("\ta: 1\n").contains("탭"));
        assert!(unsupported_reason("a: [1,\t2]\n").contains("탭"));
        assert!(unsupported_reason("a: 1\rb: 2\r").contains("\\r"));
        assert!(unsupported_reason("\u{feff}a: 1\n").contains("BOM"));
        assert!(unsupported_reason("a: \u{85}\n").contains("특수"));
        assert!(unsupported_reason("a: !!str 1\n").contains("태그"));
        assert!(unsupported_reason("a: !!binary x\n").contains("태그"));
        assert!(unsupported_reason("a: !x: 1\n").contains("태그"));
        assert!(unsupported_reason("a: 1\n---\nb: 2\n").contains("문서 시작"));
        assert!(unsupported_reason("%YAML 1.2\n---\na: 1\n").contains("지시문"));
        assert!(unsupported_reason("a: 1\n...\nb: 2\n").contains("문서 끝"));
        assert!(unsupported_reason("a: {b: >x}\n").contains("흐름"));
        assert!(unsupported_reason("k:\n  x: [1,\n  {}]\n").contains("이어지는 줄"));
        assert!(unsupported_reason("a: |\n  x\n  \ty\n").contains("탭"));
        assert!(unsupported_reason(": a\n").contains("키가 없는"));
        assert!(unsupported_reason("&x:\n").contains("앵커"));
        assert!(matches!(parse("a: \"x\n", false), Outcome::Syntax { .. }));
        assert!(unsupported_reason("a: |\n  x\n---\n").contains("문서"));
        assert!(unsupported_reason("a: &x [*x]\n").contains("자기 자신"));
        assert!(unsupported_reason("\"\\u0000\": 1\n").contains("NUL"));
        assert!(unsupported_reason("a: \"x\n  \u{85}y\"\n").contains("특수"));
        // 컬렉션을 키로 쓴 매핑은 값을 만들 때 거절한다
        assert!(unsupported_reason("? [a]\n: b\n").contains("컬렉션"));
    }

    #[test]
    fn syntax_errors_carry_position_without_source_text() {
        match parse("secret: [1,\nb: {\n", false) {
            Outcome::Syntax { line, message, .. } => {
                assert!(line >= 1);
                assert!(!message.contains("secret"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn js_object_order_is_left_to_json_parse() {
        // 키 순서(정수 꼴이 앞)는 JSON.parse가 정한다. 같은 키(1과 "1")는 첫 자리에서 값만 바뀐다
        assert_eq!(value("b: 1\n2: x\n1: y\n__proto__: z\n", false), r#"{"b":1,"2":"x","1":"y","__proto__":"z"}"#);
    }

    /// 믿을 수 없는 입력(studio.yaml은 남의 저장소에서 올 수 있다): 별칭·merge로 펼친 값의 깊이·크기는 상한 안에서 닫는다. 상한이 없으면 스택이 넘쳐 프로세스가 죽거나 메모리를 다 쓴다
    #[test]
    fn expansion_is_bounded_in_depth_bytes_and_input_size() {
        // 깊이: 앵커를 단계마다 별칭으로 겹친다. 글자 위의 중첩은 얕지만 펼친 깊이는 수만이 된다(merge 자리의 별칭은 JS 별칭 개수에 세지 않아 그 규칙이 먼저 막지 못한다)
        let levels = 20_000;
        let mut deep = String::from("l0: &l0 {x: 1}\n");
        for i in 1..levels {
            deep.push_str(&format!("l{i}: &l{i}\n  k:\n    <<: *l{}\n", i - 1));
        }
        match parse(&deep, true) {
            Outcome::Unsupported { reason, .. } => assert!(reason.contains("깊"), "{reason}"),
            other => panic!("깊이 상한이 막아야 합니다: {:?}", &format!("{other:?}")[..80]),
        }
        // 바이트: 1MB 글자를 merge로 수백 번 펼친다
        let big = "x".repeat(1 << 20);
        let mut wide = format!("big: &big \"{big}\"\nsrc: &src {{k: *big}}\n");
        for i in 0..400 {
            wide.push_str(&format!("m{i}:\n  <<: *src\n"));
        }
        match parse(&wide, true) {
            Outcome::Unsupported { reason, .. } => assert!(reason.contains("글자"), "{reason}"),
            other => panic!("펼친 바이트 상한이 막아야 합니다: {:?}", &format!("{other:?}")[..80]),
        }
        // 입력 크기: 읽기 전에 막는다
        match parse(&format!("a: {}\n", "y".repeat(MAX_INPUT_BYTES)), false) {
            Outcome::Unsupported { reason, .. } => assert!(reason.contains("너무 큽니다")),
            other => panic!("{:?}", &format!("{other:?}")[..80]),
        }
        // 상한 안의 평범한 재사용은 그대로 읽는다
        assert!(matches!(parse("a: &a {p: 1}\nb:\n  <<: *a\n", true), Outcome::Value(_)));
    }

    /// 정해진 시간 안에 끝나는지 본다(끝나지 않으면 시험이 실패한다: 상한이 없으면 CPU를 다 쓰는 입력이다)
    fn parse_within(text: String, merge: bool, seconds: u64) -> Outcome {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new().stack_size(64 << 20).spawn(move || drop(tx.send(parse(&text, merge)))).unwrap();
        rx.recv_timeout(std::time::Duration::from_secs(seconds)).expect("제한 시간 안에 끝나지 않았습니다")
    }

    /// 병합이 앞 단계를 여러 번 겹쳐 병합하면 결과는 작아도(여기서는 빈 매핑) 방문이 지수로 늘어난다. 방문 수를 세지 않으면 끝나지 않는다
    #[test]
    fn merge_fan_out_is_bounded_by_visits() {
        let mut text = String::from("p0: &p0 {}\n");
        for i in 1..=25 {
            text.push_str(&format!("p{i}: &p{i}\n  <<: [{}]\n", vec![format!("*p{}", i - 1); 10].join(", ")));
        }
        match parse_within(text, true, 20) {
            Outcome::Unsupported { reason, .. } => assert!(reason.contains("병합") || reason.contains("별칭"), "{reason}"),
            other => panic!("방문 상한이 막아야 합니다: {:?}", &format!("{other:?}")[..80]),
        }
        // 큰 매핑도 제곱으로 느려지지 않는다(키 색인)
        let big: String = (0..150_000).map(|i| format!("k{i}: {i}\n")).collect();
        assert!(matches!(parse_within(big, false, 20), Outcome::Value(_)));
    }
}
