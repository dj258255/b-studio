//! 생성 Dockerfile에 `systemPackages` 설치 블록을 반영한다(`packages/spec/src/system-packages.ts`, 도그푸딩 마찰 113).
//! 순수 문자열 변환이며 Node를 모른다. 오류 글은 옛 TS와 바이트까지 같다.
//!
//! 옛 TS의 `/alpine/i`·`/^(node|...)(:|$)/i`는 ASCII만 보므로 `(?i-u)`로 같은 범위를 쓴다.
//! `\s`·`\S`는 JS와 Rust의 유니코드 집합이 달라서(JS는 U+FEFF, Rust는 U+0085) 명시적 클래스를 쓴다.

use regex::Regex;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageFamily {
    Apt,
    Apk,
}

impl PackageFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            PackageFamily::Apt => "apt",
            PackageFamily::Apk => "apk",
        }
    }
}

const MARKER_BEGIN: &str = "# b-studio: systemPackages(studio.yaml)가 설치를 선언한 패키지";
const MARKER_END: &str = "# b-studio: systemPackages 끝";

/// JS `\s` 집합(WhiteSpace + LineTerminator). Rust `\s`와 다르다
const JS_WS: &str = "\\t\\n\\x0B\\x0C\\r \\u{00a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}\\u{feff}";

fn js_ws_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r')
        || c == ' '
        || c == '\u{00a0}'
        || c == '\u{1680}'
        || ('\u{2000}'..='\u{200a}').contains(&c)
        || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(js_ws_char)
}

fn apk_image() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new("(?i-u)alpine").expect("APK 이미지 정규식"))
}

fn apt_image() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new("(?i-u)^(node|python|eclipse-temurin|gradle|maven|debian|ubuntu)(:|$)").expect("APT 이미지 정규식"))
}

fn package_name() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new("^[a-z0-9][a-z0-9.+-]{0,63}$").expect("패키지 이름 정규식"))
}

fn from_image_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!("(?m)^FROM[{JS_WS}]+([^{JS_WS}]+)")).expect("FROM 줄 정규식"))
}

fn from_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!("(?m)^FROM[{JS_WS}]+[^{JS_WS}]+")).expect("FROM 줄 정규식"))
}

/// FROM 줄의 이미지 이름으로 패키지 계열을 가린다. 모르는 계열이면 `None`
pub fn detect_package_family(image: &str) -> Option<PackageFamily> {
    let trimmed = js_trim(image);
    if apk_image().is_match(trimmed) {
        return Some(PackageFamily::Apk);
    }
    if apt_image().is_match(trimmed) {
        return Some(PackageFamily::Apt);
    }
    None
}

fn from_image(dockerfile: &str) -> Option<String> {
    from_image_re().captures(dockerfile).map(|caps| caps[1].to_owned())
}

fn install_command(family: PackageFamily, packages: &[String]) -> String {
    let joined = packages.join(" ");
    match family {
        PackageFamily::Apt => format!("RUN apt-get update && apt-get install -y --no-install-recommends {joined} && rm -rf /var/lib/apt/lists/*"),
        PackageFamily::Apk => format!("RUN apk add --no-cache {joined}"),
    }
}

/// 이전에 넣은 블록(마커 사이)을 지운다. 마커가 없거나 짝이 안 맞으면 그대로 둔다
fn strip_managed_block(dockerfile: &str) -> String {
    let mut lines: Vec<&str> = dockerfile.split('\n').collect();
    let Some(begin) = lines.iter().position(|line| *line == MARKER_BEGIN) else { return dockerfile.to_owned() };
    let Some(end_offset) = lines[begin..].iter().position(|line| *line == MARKER_END) else { return dockerfile.to_owned() };
    let end = begin + end_offset;
    let start = if begin > 0 && lines[begin - 1].is_empty() { begin - 1 } else { begin };
    lines.drain(start..=end);
    lines.join("\n")
}

/// Dockerfile 본문에 systemPackages 설치 블록을 반영한다(멱등). 실패 이유는 옛 TS와 같은 글자다
pub fn apply_system_packages(dockerfile: &str, packages: &[String]) -> Result<String, String> {
    let stripped = strip_managed_block(dockerfile);
    if packages.is_empty() {
        return Ok(stripped);
    }
    for name in packages {
        if !package_name().is_match(name) {
            return Err(format!(
                "'{name}'은(는) 올바른 패키지 이름이 아닙니다(영문 소문자·숫자로 시작, 그 뒤 영문 소문자·숫자·.·+·-만 허용)"
            ));
        }
    }
    let Some(image) = from_image(&stripped) else {
        return Err("Dockerfile에 FROM 줄이 없어 systemPackages를 설치할 자리를 찾지 못했습니다".to_owned());
    };
    let Some(family) = detect_package_family(&image) else {
        return Err(format!(
            "'{image}' 베이스 이미지의 패키지 계열(apt 또는 apk)을 알 수 없어 systemPackages를 설치할 수 없습니다. \
             Debian·Ubuntu(apt) 또는 Alpine(apk) 계열 이미지만 지원합니다 — 다른 계열이면 Dockerfile.b-studio를 직접 고치세요."
        ));
    };
    let mut lines: Vec<String> = stripped.split('\n').map(str::to_owned).collect();
    let Some(from_index) = lines.iter().position(|line| from_line_re().is_match(line)) else {
        // 위의 from_image가 같은 정규식으로 찾았으므로 닿지 않는다
        return Err("Dockerfile에 FROM 줄이 없어 systemPackages를 설치할 자리를 찾지 못했습니다".to_owned());
    };
    let block = ["".to_owned(), MARKER_BEGIN.to_owned(), install_command(family, packages), MARKER_END.to_owned()];
    lines.splice(from_index + 1..from_index + 1, block);
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(dockerfile: &str, packages: &[&str]) -> Result<String, String> {
        let packages: Vec<String> = packages.iter().map(|p| (*p).to_owned()).collect();
        apply_system_packages(dockerfile, &packages)
    }

    const NODE: &str = "# 만든 파일\nFROM node:22-bookworm-slim\n\nWORKDIR /workspace\n";

    #[test]
    fn 계열을_가리고_모르면_none이다() {
        assert_eq!(detect_package_family("node:22-bookworm-slim"), Some(PackageFamily::Apt));
        assert_eq!(detect_package_family("eclipse-temurin:21-jdk-alpine"), Some(PackageFamily::Apk));
        assert_eq!(detect_package_family("rust:1-slim"), None);
        assert_eq!(detect_package_family("  node:22-alpine  "), Some(PackageFamily::Apk));
    }

    #[test]
    fn from_뒤에_블록을_넣고_멱등이다() {
        let once = apply(NODE, &["ffmpeg"]).unwrap();
        assert!(once.contains("RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*"));
        let twice = apply(&once, &["ffmpeg"]).unwrap();
        assert_eq!(once, twice);
        assert_eq!(apply(&once, &[]).unwrap(), NODE);
        assert_eq!(apply("FROM node:22-alpine\n", &["ffmpeg"]).unwrap(), "FROM node:22-alpine\n\n# b-studio: systemPackages(studio.yaml)가 설치를 선언한 패키지\nRUN apk add --no-cache ffmpeg\n# b-studio: systemPackages 끝\n");
    }

    #[test]
    fn 오류_글은_옛_ts와_같다() {
        assert_eq!(apply("FROM rust:1-slim\n", &["ffmpeg"]).unwrap_err(), "'rust:1-slim' 베이스 이미지의 패키지 계열(apt 또는 apk)을 알 수 없어 systemPackages를 설치할 수 없습니다. Debian·Ubuntu(apt) 또는 Alpine(apk) 계열 이미지만 지원합니다 — 다른 계열이면 Dockerfile.b-studio를 직접 고치세요.");
        assert_eq!(apply("WORKDIR x\n", &["ffmpeg"]).unwrap_err(), "Dockerfile에 FROM 줄이 없어 systemPackages를 설치할 자리를 찾지 못했습니다");
        assert_eq!(apply(NODE, &["ffmpeg; rm -rf /"]).unwrap_err(), "'ffmpeg; rm -rf /'은(는) 올바른 패키지 이름이 아닙니다(영문 소문자·숫자로 시작, 그 뒤 영문 소문자·숫자·.·+·-만 허용)");
    }
}
