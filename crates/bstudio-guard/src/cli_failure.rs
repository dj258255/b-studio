//! CLI 사전 확인 실패의 설명 글(옛 TS: `packages/agent/src/cli-failure.ts`, ADR-191 3단계 3l).
//!
//! 오류 값을 글자로 만드는 일(`error instanceof Error ? error.message : String(error)`)은 JS 객체 판정이라 TS에 남는다.
//! 여기는 그 글자를 화면에 옮길 수 있게 다듬는 일(터미널 제어 코드 지우기, 앞뒤 공백 자르기)과 요약·설명을 한 줄로 잇는 일만 한다.

use crate::docker_format::strip_ansi;
use crate::js;

/// `stripAnsi(raw).trim()`
pub fn describe_cli_text(raw: &str) -> String {
    js::trim(&strip_ansi(raw)).to_owned()
}

/// `detail ? `${summary} (${detail})` : summary`
pub fn failure_reason(summary: &str, detail: &str) -> String {
    if detail.is_empty() {
        summary.to_owned()
    } else {
        format!("{summary} ({detail})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 제어_코드를_지우고_공백을_자른다() {
        assert_eq!(describe_cli_text("\u{1b}[31m✖\u{1b}[39m Not authenticated\n"), "✖ Not authenticated");
        assert_eq!(describe_cli_text("\u{feff}\u{a0}x\u{2028}"), "x");
        assert_eq!(describe_cli_text("\u{85}x"), "\u{85}x");
        assert_eq!(describe_cli_text(" \u{1b}[2K "), "");
    }

    #[test]
    fn 설명이_없으면_요약만_쓴다() {
        assert_eq!(failure_reason("s", ""), "s");
        assert_eq!(failure_reason("s", "d"), "s (d)");
    }
}
