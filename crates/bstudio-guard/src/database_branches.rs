//! 체크포인트마다 남기는 개발 DB 덤프의 작은 판정들(옛 TS: `packages/agent/src/database-branches.ts`, ADR-191 3단계 3af).
//! 파일 읽기 스트림·해시·`process.kill`·`rm`은 TS가 하고, 여기는 순수 판정만 둔다.
//!
//! - `DumpNormalizer`: 덤프를 줄 단위로 읽어 `\restrict`·`\unrestrict` 줄을 빼고 해시에 먹일 바이트를 만든다. **바뀌지 않음**을 정하는 판정이라
//!   열린 쪽(서로 다른 덤프가 같은 해시)이 틀린 쪽이다.
//! - `restore_database_name`: Postgres 식별자 상한(63자)에 맞춘 임시 DB 이름. JS `slice`는 UTF-16 단위라 같은 단위로 자른다.
//! - `stale_temp_pid`: 지울 임시 파일을 고르는 판정(**지우는 코드**). 모르는 이름은 지우지 않는다.
//!
//! 옛 TS와 다른 곳(모두 닫는 쪽 · 의도한 차이):
//! - 옛 TS는 `readline`이 줄을 끊어 줄 끝(`\r\n`·`\r`·`\n`)과 마지막 줄의 끝 개행 유무를 해시에서 잃었다. 값 안의 `\r`을 `\n`으로 바꾼 덤프나
//!   끝 개행만 지운 덤프가 같은 해시였다. 여기서는 줄 끝의 종류를 한 가지로만 읽히는 토큰으로 해시에 넣는다(`LF_TOKEN` 설명 참고).
//! - 옛 TS는 UTF-8로 풀어 읽어 잘못된 바이트가 모두 U+FFFD가 되어 서로 다른 덤프가 같았다. 여기서는 바이트 그대로 해시에 넣는다.
//! - 옛 TS는 pid 자리를 `Number()`로 읽어(`0x10`·`1e3`·앞뒤 공백·`+5`) 꼴이 다른 `.tmp` 파일도, pid를 못 읽은 `.tmp` 파일은 전부 "죽은 프로세스"로 보고
//!   지웠다. 여기서는 우리가 쓰는 이름 꼴(`<체크포인트 7~40 16진>.<save|changed|restore>.<pid>.<시각>.tmp`)이고 pid가 양의 정수(i32 범위)일 때만 pid를 돌려준다.

use crate::js;

/// 해시에 넣지 않을 줄을 가리는 데 필요한 앞부분 바이트 수. `\unrestrict`(11) + 뒤따르는 공백 글자(최대 4바이트) = 15
const HEAD_MAX: usize = 16;

/// `/^\\(un)?restrict\s/`를 줄의 앞부분 바이트로 판정한다. 줄이 `HEAD_MAX`보다 길면 앞 `HEAD_MAX` 바이트만 받는다.
/// `\s` 자리가 UTF-8로 읽히지 않으면(옛 TS는 U+FFFD로 읽어 공백이 아니었다) 맞지 않는다
pub fn is_restrict_head(head: &[u8]) -> bool {
    let rest = if let Some(r) = head.strip_prefix(b"\\restrict") {
        r
    } else if let Some(r) = head.strip_prefix(b"\\unrestrict") {
        r
    } else {
        return false;
    };
    first_char(rest).is_some_and(js::is_js_whitespace)
}

fn first_char(bytes: &[u8]) -> Option<char> {
    let take = &bytes[..bytes.len().min(4)];
    let valid = match std::str::from_utf8(take) {
        Ok(s) => s,
        // 네 바이트 가운데 뒤쪽이 다음 글자의 일부일 수 있다. 앞에서 읽히는 데까지만 본다
        Err(e) => std::str::from_utf8(&take[..e.valid_up_to()]).ok()?,
    };
    valid.chars().next()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// 줄의 앞부분을 모으는 중(`head`)
    Head,
    /// 이 줄을 해시에 넣는다
    Keep,
    /// 이 줄을 뺀다(줄 끝 글자까지)
    Skip,
}

/// 줄 끝을 해시에 넣는 꼴. 줄 안에는 `\r`·`\n`이 없으므로 `\r`·`\n`으로만 쓴 세 토큰(`\n`, `\r\r`, `\r\n`)은 어느 쪽으로도 한 가지로만 읽힌다
/// (`\r`은 늘 다음 글자와 함께 토큰이 된다). 줄 끝 글자를 그대로(`\r` 하나) 쓰면 `\restrict` 줄을 빼는 자리에서 `\r`과 다음 줄 끝 `\n`이 이어져
/// `\r\n`으로 읽혀, 빈 줄이 하나 더 있는 다른 덤프가 같은 해시가 된다(차등 시험이 잡았다)
const LF_TOKEN: &[u8] = b"\n";
const CR_TOKEN: &[u8] = b"\r\r";
const CRLF_TOKEN: &[u8] = b"\r\n";

/// 덤프 바이트를 조각으로 받아 해시에 먹일 바이트를 내놓는다. 줄 하나를 통째로 쥐지 않는다(앞 `HEAD_MAX` 바이트만 모은다).
/// 줄은 `\r\n`·`\n`·`\r`로 끊고(Node `readline`의 `crlfDelay: Infinity`와 같다), 남긴 줄은 줄 끝을 토큰(`LF_TOKEN`·`CR_TOKEN`·`CRLF_TOKEN`)으로 바꿔 내보낸다.
/// 마지막 줄이 줄 끝 없이 끝나면 그 줄만 줄 끝 없이 낸다
pub struct DumpNormalizer {
    mode: Mode,
    head: Vec<u8>,
    /// 방금 `\r`을 읽었다(줄 끝이 `\r`인지 `\r\n`인지 다음 바이트를 봐야 안다). 그 줄을 남기는지는 `cr_keep`
    pending_cr: bool,
    cr_keep: bool,
}

impl Default for DumpNormalizer {
    fn default() -> Self {
        Self::new()
    }
}

impl DumpNormalizer {
    pub fn new() -> Self {
        Self { mode: Mode::Head, head: Vec::new(), pending_cr: false, cr_keep: false }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(chunk.len());
        for &byte in chunk {
            self.byte(byte, &mut out);
        }
        out
    }

    /// 입력이 끝났다. 줄 끝 없이 끝난 마지막 줄을 마무리한다. 이 뒤로는 쓰지 않는다
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.pending_cr {
            if self.cr_keep {
                out.extend_from_slice(CR_TOKEN);
            }
            self.pending_cr = false;
        } else if self.mode == Mode::Head && !self.head.is_empty() {
            if !is_restrict_head(&self.head) {
                out.extend_from_slice(&self.head);
            }
        }
        self.head.clear();
        self.mode = Mode::Head;
        out
    }

    fn byte(&mut self, b: u8, out: &mut Vec<u8>) {
        if self.pending_cr {
            self.pending_cr = false;
            if b == b'\n' {
                if self.cr_keep {
                    out.extend_from_slice(CRLF_TOKEN);
                }
                return;
            }
            if self.cr_keep {
                out.extend_from_slice(CR_TOKEN);
            }
        }
        match b {
            b'\n' => self.end_line(LF_TOKEN, out),
            b'\r' => {
                // 줄 끝을 `\r`로 확정할지 `\r\n`으로 할지는 다음 바이트가 정한다
                let keep = self.settle_head(out);
                self.pending_cr = true;
                self.cr_keep = keep;
                self.mode = Mode::Head;
            }
            _ => match self.mode {
                Mode::Head => {
                    self.head.push(b);
                    if self.head.len() >= HEAD_MAX {
                        self.settle_head(out);
                    }
                }
                Mode::Keep => out.push(b),
                Mode::Skip => {}
            },
        }
    }

    /// 앞부분이 모였다(또는 줄이 끝났다). 이 줄을 남기는지 정하고, 남기면 모은 바이트를 내보낸다
    fn settle_head(&mut self, out: &mut Vec<u8>) -> bool {
        match self.mode {
            Mode::Head => {
                let keep = !is_restrict_head(&self.head);
                if keep {
                    out.extend_from_slice(&self.head);
                }
                self.head.clear();
                self.mode = if keep { Mode::Keep } else { Mode::Skip };
                keep
            }
            Mode::Keep => true,
            Mode::Skip => false,
        }
    }

    fn end_line(&mut self, terminator: &[u8], out: &mut Vec<u8>) {
        let keep = self.settle_head(out);
        if keep {
            out.extend_from_slice(terminator);
        }
        self.mode = Mode::Head;
    }
}

/// 덤프 바이트 전체를 한 번에(시험용). 스트림으로 먹인 것과 같아야 한다
pub fn normalize_all(bytes: &[u8]) -> Vec<u8> {
    let mut n = DumpNormalizer::new();
    let mut out = n.feed(bytes);
    out.extend(n.finish());
    out
}

const RESTORE_SUFFIX: &str = "__b_studio_restore";
const IDENTIFIER_MAX: usize = 63;

/// `name.slice(0, 63 - suffix.length) + suffix`. 인코딩한(`encodeLoneSurrogates`) 이름을 받아 UTF-16 코드 단위로 자르고 인코딩해 돌려준다.
/// 서로게이트 쌍의 가운데에서 자르면 짝 없는 서로게이트가 남는다(JS도 그렇다)
pub fn restore_database_name(encoded_name: &str) -> String {
    let keep = IDENTIFIER_MAX - RESTORE_SUFFIX.len();
    let units = encoded_units(encoded_name);
    let cut = &units[..units.len().min(keep)];
    let mut out = units_to_encoded(cut);
    out.push_str(RESTORE_SUFFIX);
    out
}

/// 인코딩한 글자를 UTF-16 코드 단위로 푼다
fn encoded_units(text: &str) -> Vec<u16> {
    let chars: Vec<char> = text.chars().collect();
    let mut units = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        match js::read_lone_escape(&chars, i) {
            Some((Err(unit), used)) => {
                units.push(unit as u16);
                i += used;
            }
            Some((Ok(c), used)) => {
                let mut buf = [0u16; 2];
                units.extend_from_slice(c.encode_utf16(&mut buf));
                i += used;
            }
            None => {
                let mut buf = [0u16; 2];
                units.extend_from_slice(chars[i].encode_utf16(&mut buf));
                i += 1;
            }
        }
    }
    units
}

fn units_to_encoded(units: &[u16]) -> String {
    let mut out = String::new();
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => out.push_str(&js::encode_reserved_char(c)),
            Err(e) => out.push_str(&js::encode_lone_unit(u32::from(e.unpaired_surrogate()))),
        }
    }
    out
}

const TEMP_REASONS: [&str; 3] = ["save", "changed", "restore"];

/// 덤프 임시 파일 이름 `<체크포인트>.<이유>.<pid>.<시각>.tmp`에서 만든 프로세스의 pid. 우리가 쓰는 꼴이 아니거나 pid가 양의 i32 정수가 아니면 `None`(지우지 않는다).
/// 이름은 `.`으로 나눠 정확히 다섯 조각이고 마지막이 소문자 `tmp`여야 한다(`.TMP`·끝 공백·보이지 않는 글자는 맞지 않는다)
pub fn stale_temp_pid(name: &str) -> Option<u32> {
    let parts: Vec<&str> = name.split('.').collect();
    let [sha, reason, pid, time, tmp] = parts.as_slice() else { return None };
    if *tmp != "tmp" || !TEMP_REASONS.contains(reason) {
        return None;
    }
    if !(7..=40).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    if time.is_empty() || !time.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if pid.is_empty() || pid.starts_with('0') || !pid.bytes().all(|b| b.is_ascii_digit()) || pid.len() > 10 {
        return None;
    }
    let value: u64 = pid.parse().ok()?;
    (value <= i32::MAX as u64).then_some(value as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(s: &[u8]) -> Vec<u8> {
        normalize_all(s)
    }

    fn lossy(b: Vec<u8>) -> String {
        String::from_utf8_lossy(&b).into_owned()
    }

    #[test]
    fn restrict_lines_are_dropped_only_when_followed_by_whitespace() {
        assert_eq!(lossy(norm(b"a\n\\restrict KEY\nb\n")), "a\nb\n");
        assert_eq!(lossy(norm(b"a\n\\unrestrict KEY\nb\n")), "a\nb\n");
        // 공백이 없거나 다른 글자가 이어지면 남긴다
        assert_eq!(lossy(norm(b"\\restrict\n")), "\\restrict\n");
        assert_eq!(lossy(norm(b"\\restricted x\n")), "\\restricted x\n");
        assert_eq!(lossy(norm(b" \\restrict x\n")), " \\restrict x\n");
        assert_eq!(lossy(norm(b"\\Restrict x\n")), "\\Restrict x\n");
        assert_eq!(lossy(norm(b"\\\\restrict x\n")), "\\\\restrict x\n");
        assert_eq!(lossy(norm(b"restrict x\n")), "restrict x\n");
    }

    #[test]
    fn js_whitespace_after_restrict_counts() {
        assert!(is_restrict_head("\\restrict\u{a0}k".as_bytes()));
        assert!(is_restrict_head("\\restrict\u{feff}k".as_bytes()));
        assert!(is_restrict_head("\\unrestrict\u{2028}".as_bytes()));
        assert!(is_restrict_head("\\unrestrict\u{3000}".as_bytes()));
        assert!(!is_restrict_head("\\restrict\u{85}k".as_bytes()));
        assert!(!is_restrict_head(b"\\restrict\xff"));
        assert!(!is_restrict_head(b"\\restrict\xc2"));
    }

    #[test]
    fn line_terminators_are_kept_so_dumps_differing_only_in_them_differ() {
        let all: Vec<Vec<u8>> = [&b"a\nb\n"[..], b"a\r\nb\r\n", b"a\rb\r", b"a\nb", b"a\nb\n\n"].iter().map(|s| norm(s)).collect();
        for i in 0..all.len() {
            for j in 0..i {
                assert_ne!(all[i], all[j], "{i} {j}");
            }
        }
    }

    #[test]
    fn dropping_a_restrict_line_never_merges_terminators_of_neighbours() {
        // 옛 구현의 `\r` 하나를 그대로 쓰면 둘 다 "x\r\n"이 된다. 앞은 빈 줄이 없고 뒤는 빈 줄이 하나 있다
        assert_ne!(norm(b"x\r\n"), norm(b"x\r\\restrict k\r\n\n"));
        assert_ne!(norm(b"x\r\n"), norm(b"x\r\\restrict k\n\n"));
        assert_ne!(norm(b"x\n\n"), norm(b"x\r\\restrict k\n\n"));
        // restrict 줄을 끼워 넣기만 한 덤프는 같다
        assert_eq!(norm(b"x\r\r"), norm(b"x\r\\restrict k\r\r"));
    }

    #[test]
    fn restrict_line_terminator_style_does_not_matter() {
        assert_eq!(norm(b"a\n\\restrict K\r\nb\n"), norm(b"a\n\\restrict ZZ\nb\n"));
        assert_eq!(norm(b"a\n\\restrict K\rb\n"), norm(b"a\nb\n"));
        // 마지막 줄이 줄 끝 없이 끝나는 restrict 줄
        assert_eq!(norm(b"a\n\\restrict K"), norm(b"a\n"));
    }

    #[test]
    fn chunking_does_not_change_the_output() {
        let src = b"x\r\n\\restrict KEY1\ny\r\\unrestrict K\rz\n\n\r\r\nlast\\restrict a";
        let whole = norm(src);
        for step in 1..=src.len() {
            let mut n = DumpNormalizer::new();
            let mut out = Vec::new();
            for c in src.chunks(step) {
                out.extend(n.feed(c));
            }
            out.extend(n.finish());
            assert_eq!(out, whole, "step {step}");
        }
    }

    #[test]
    fn long_lines_stream_without_buffering() {
        let mut src = vec![b'a'; 100_000];
        src.push(b'\n');
        assert_eq!(norm(&src), src);
        let mut n = DumpNormalizer::new();
        n.feed(&src[..50_000]);
        assert!(n.head.len() <= HEAD_MAX);
    }

    #[test]
    fn invalid_bytes_are_hashed_as_they_are() {
        assert_ne!(norm(b"a\xffb\n"), norm(b"a\xfeb\n"));
        assert_eq!(norm(b"a\xffb\n"), b"a\xffb\n");
    }

    #[test]
    fn restore_name_cuts_by_utf16_units() {
        assert_eq!(restore_database_name("app"), "app__b_studio_restore");
        let long = "x".repeat(60);
        assert_eq!(restore_database_name(&long), format!("{}__b_studio_restore", "x".repeat(45)));
        assert_eq!(restore_database_name(&"x".repeat(45)), format!("{}__b_studio_restore", "x".repeat(45)));
        assert_eq!(restore_database_name(&"x".repeat(46)), format!("{}__b_studio_restore", "x".repeat(45)));
        // 44개 뒤의 😀(UTF-16 두 단위)는 45번째 단위(상위 절반)까지만 남는다: 짝 없는 서로게이트
        let cut = restore_database_name(&format!("{}😀", "x".repeat(44)));
        assert_eq!(cut, format!("{}\u{e010}\u{e008}\u{e003}\u{e00d}__b_studio_restore", "x".repeat(44)));
        // 43개 뒤의 😀는 통째로 남는다
        assert_eq!(restore_database_name(&format!("{}😀", "x".repeat(43))), format!("{}😀__b_studio_restore", "x".repeat(43)));
        // 한글은 한 단위
        assert_eq!(restore_database_name(&"가".repeat(50)), format!("{}__b_studio_restore", "가".repeat(45)));
    }

    #[test]
    fn temp_pid_reads_only_our_names() {
        assert_eq!(stale_temp_pid("abcdef0.save.123.1700000000000.tmp"), Some(123));
        assert_eq!(stale_temp_pid("abcdef0.changed.2147483647.1.tmp"), Some(2147483647));
        assert_eq!(stale_temp_pid("abcdef0.restore.7.1.tmp"), Some(7));
        for bad in [
            "abcdef0.save.123.1.TMP",
            "abcdef0.save.123.1.tmp ",
            "abcdef0.save.123.1.tmp\u{200b}",
            "abcdef0.save.0x10.1.tmp",
            "abcdef0.save.1e3.1.tmp",
            "abcdef0.save. 12.1.tmp",
            "abcdef0.save.12 .1.tmp",
            "abcdef0.save.+5.1.tmp",
            "abcdef0.save.-5.1.tmp",
            "abcdef0.save.0.1.tmp",
            "abcdef0.save.007.1.tmp",
            "abcdef0.save..1.tmp",
            "abcdef0.save.2147483648.1.tmp",
            "abcdef0.save.99999999999999999999.1.tmp",
            "abcdef0.save.12.tmp",
            "x.tmp",
            "abcdef0.other.12.1.tmp",
            "abcdef0.SAVE.12.1.tmp",
            "ABCDEF0.save.12.1.tmp",
            "abcdef.save.12.1.tmp",
            "abcdef0.save.12.x.tmp",
            "abcdef0.save.12..tmp",
            "a.abcdef0.save.12.1.tmp",
            "abcdef0.save.١٢.1.tmp",
            "abcdef0.save.12.1.tmp.bak",
            "abcdef0.save.12.1",
        ] {
            assert_eq!(stale_temp_pid(bad), None, "{bad:?}");
        }
    }
}
