//! Node `path.posix`와 같은 결과를 내는 경로 함수(ADR-191).
//!
//! 막는 검사는 경로를 비교한다. Rust `std::path`는 `..`를 풀지 않고(`components()`), 끝의 `/`·빈 요소를 Node와 다르게 다룬다.
//! 옮기기 전 TS가 쓰던 `path.resolve`·`relative`·`join`·`dirname`·`normalize`의 알고리즘(Node `lib/path.js`의 posix 판)을
//! 그대로 옮긴다. `/`만 구분자다(역슬래시는 POSIX에서 보통 글자). macOS·Linux만 지원한다(Windows 경로 규칙은 다루지 않는다).
//! 비교는 바이트로 하지만 구분자가 ASCII라 Node의 UTF-16 코드 단위 비교와 결과가 같다.

/// Node의 `normalizeString`: `.`·`..`·빈 요소를 푼다. `allow_above_root`면 맨 앞의 `..`를 남긴다
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let mut res = String::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    let bytes = path.as_bytes();
    let mut code = 0u8;
    for i in 0..=bytes.len() {
        if i < bytes.len() {
            code = bytes[i];
        } else if code == b'/' {
            break;
        } else {
            code = b'/';
        }
        if code == b'/' {
            let i = i as isize;
            if last_slash == i - 1 || dots == 1 {
                // 빈 요소나 `.`
            } else if dots == 2 {
                let ends_with_dots = res.len() >= 2 && res.ends_with("..");
                if res.len() < 2 || last_segment_length != 2 || !ends_with_dots {
                    if res.len() > 2 {
                        match res.rfind('/') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(index) => {
                                res.truncate(index);
                                // Node: lastSegmentLength = res.length - 1 - res.lastIndexOf('/') (없으면 -1이라 res.length)
                                last_segment_length = match res.rfind('/') {
                                    Some(p) => res.len() - 1 - p,
                                    None => res.len(),
                                };
                            }
                        }
                        last_slash = i;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    res.push_str(if res.is_empty() { ".." } else { "/.." });
                    last_segment_length = 2;
                }
            } else {
                let start = (last_slash + 1) as usize;
                let segment = &path[start..i as usize];
                if res.is_empty() {
                    res.push_str(segment);
                } else {
                    res.push('/');
                    res.push_str(segment);
                }
                last_segment_length = (i - last_slash - 1) as usize;
            }
            last_slash = i;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

pub fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
}

/// `path.posix.normalize`
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = is_absolute(path);
    let trailing = path.ends_with('/');
    let mut out = normalize_string(path, !absolute);
    if out.is_empty() {
        if absolute {
            return "/".to_owned();
        }
        return if trailing { "./".to_owned() } else { ".".to_owned() };
    }
    if trailing {
        out.push('/');
    }
    if absolute {
        format!("/{out}")
    } else {
        out
    }
}

/// `path.posix.join`
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".to_owned();
    }
    normalize(&joined.join("/"))
}

/// `path.posix.resolve`. Node는 프로세스의 현재 폴더를 쓰므로 `cwd`로 받는다(TS가 `process.cwd()`를 넘긴다)
pub fn resolve(cwd: &str, parts: &[&str]) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    for part in parts.iter().rev().copied().chain(std::iter::once(cwd)) {
        if absolute {
            break;
        }
        if part.is_empty() {
            continue;
        }
        resolved = if resolved.is_empty() { part.to_owned() } else { format!("{part}/{resolved}") };
        absolute = is_absolute(part);
    }
    let normalized = normalize_string(&resolved, !absolute);
    if absolute {
        format!("/{normalized}")
    } else if normalized.is_empty() {
        ".".to_owned()
    } else {
        normalized
    }
}

/// `path.posix.relative`
pub fn relative(cwd: &str, from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from = resolve(cwd, &[from]);
    let to = resolve(cwd, &[to]);
    if from == to {
        return String::new();
    }
    let (f, t) = (from.as_bytes(), to.as_bytes());
    let from_start = 1usize;
    let from_end = f.len();
    let from_len = from_end - from_start;
    let to_start = 1usize;
    let to_len = t.len() - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let from_code = f[from_start + i];
        if from_code != t[to_start + i] {
            break;
        }
        if from_code == b'/' {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i == length {
        if to_len > length {
            if t[to_start + i] == b'/' {
                return to[to_start + i + 1..].to_owned();
            }
            if i == 0 {
                return to[to_start + i..].to_owned();
            }
        } else if from_len > length {
            if f[from_start + i] == b'/' {
                last_common_sep = i as isize;
            } else if i == 0 {
                last_common_sep = 0;
            }
        }
    }
    let mut out = String::new();
    let mut j = (from_start as isize + last_common_sep + 1) as usize;
    while j <= from_end {
        if j == from_end || f[j] == b'/' {
            out.push_str(if out.is_empty() { ".." } else { "/.." });
        }
        j += 1;
    }
    let rest_start = (to_start as isize + last_common_sep) as usize;
    format!("{out}{}", &to[rest_start..])
}

/// `path.posix.basename(path)`(확장자 인자 없음): 끝의 `/`를 뗀 뒤 마지막 `/` 다음. `/`뿐이거나 빈 글자면 빈 글자
pub fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(index) => trimmed[index + 1..].to_owned(),
        None => trimmed.to_owned(),
    }
}

/// `path.posix.dirname`
pub fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let bytes = path.as_bytes();
    let has_root = bytes[0] == b'/';
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = bytes.len() as isize - 1;
    while i >= 1 {
        if bytes[i as usize] == b'/' {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { "/".to_owned() } else { ".".to_owned() };
    }
    if has_root && end == 1 {
        return "//".to_owned();
    }
    path[..end as usize].to_owned()
}

/// `target`이 `parent` 자신이거나 그 안쪽인지. `relative(parent, target)`의 **첫 요소**가 `..`이면 바깥이다.
///
/// 옛 TS는 `relative.startsWith('..')`로 봐서 `..proj`처럼 `..`로 시작하는 이름도 바깥으로 읽었다. 그 탓에 모노레포 루트(`/m`)를
/// 마운트하고 프로젝트 폴더 이름이 `..proj`이면 `.git`을 가리지 않았다(ADR-191 2단계에서 찾아 고침, 트러블슈팅에 적음)
pub fn is_inside(cwd: &str, parent: &str, target: &str) -> bool {
    let rel = relative(cwd, parent, target);
    rel.is_empty() || (rel != ".." && !rel.starts_with("../") && !is_absolute(&rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CWD: &str = "/work/dir";

    #[test]
    fn normalize는_node와_같다() {
        for (input, expected) in [
            ("", "."),
            ("/", "/"),
            ("//", "/"),
            ("/a//b/./c/..", "/a/b"),
            ("/a/b/", "/a/b/"),
            ("a/../..", ".."),
            ("a/../../b", "../b"),
            ("./", "./"),
            (".", "."),
            ("/..", "/"),
            ("/../a", "/a"),
            ("a\\b/../c", "c"),
            ("/a/...", "/a/..."),
            ("/a/..b/..", "/a"),
            ("/..a/../b", "/b"),
        ] {
            assert_eq!(normalize(input), expected, "{input:?}");
        }
    }

    #[test]
    fn join과_resolve는_node와_같다() {
        assert_eq!(join(&["/a", "b", "../c"]), "/a/c");
        assert_eq!(join(&["", ""]), ".");
        assert_eq!(join(&["a", "", "b/"]), "a/b/");
        assert_eq!(resolve(CWD, &["x"]), "/work/dir/x");
        assert_eq!(resolve(CWD, &["/a", "b", "/c", "d"]), "/c/d");
        assert_eq!(resolve(CWD, &["/a/b/"]), "/a/b");
        assert_eq!(resolve(CWD, &["../.."]), "/");
        assert_eq!(resolve(CWD, &[""]), "/work/dir");
        assert_eq!(resolve(CWD, &["/a", ""]), "/a");
    }

    #[test]
    fn relative는_node와_같다() {
        for (from, to, expected) in [
            ("/a/b", "/a/b", ""),
            ("/a/b", "/a/b/c/d", "c/d"),
            ("/a/b/c", "/a/b", ".."),
            ("/a/b/c", "/a/x/y", "../../x/y"),
            ("/", "/a", "a"),
            ("/a", "/", ".."),
            ("/a/bc", "/a/b", "../b"),
            ("/a/b", "/a/bc", "../bc"),
            ("/a", "/a/..b", "..b"),
            ("/a/", "/a/b/", "b"),
            ("x", "/work/dir/x/y", "y"),
        ] {
            assert_eq!(relative(CWD, from, to), expected, "{from:?} → {to:?}");
        }
    }

    #[test]
    fn dirname은_node와_같다() {
        for (input, expected) in [("", "."), ("/", "/"), ("//", "/"), ("/a", "/"), ("/a/b/", "/a"), ("a", "."), ("a/b", "a"), ("//a", "//"), ("/a//b", "/a/")] {
            assert_eq!(dirname(input), expected, "{input:?}");
        }
    }

    #[test]
    fn is_inside는_첫_요소가_dot_dot일_때만_바깥이다() {
        assert!(is_inside(CWD, "/a", "/a"));
        assert!(is_inside(CWD, "/a", "/a/b"));
        assert!(!is_inside(CWD, "/a/b", "/a"));
        assert!(!is_inside(CWD, "/a", "/ab"));
        assert!(!is_inside(CWD, "/a/b", "/a/c"));
        // 옛 TS는 이것을 바깥으로 봤다
        assert!(is_inside(CWD, "/a", "/a/..b"));
        assert!(is_inside(CWD, "/a", "/a/..."));
        assert!(is_inside(CWD, "/", "/p"));
    }
}
