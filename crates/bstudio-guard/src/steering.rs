//! 에이전트 루프의 진행 중 지시 판정(옛 TS: `packages/agent/src/loop.ts`의 `formatSteering`·`appendUserText`, ADR-191 3단계 3af).
//! 큐에서 꺼내는 `takeSteering`(외부 구현을 부르고 던지면 빈 목록)과 메시지 배열 변경은 TS가 한다.

/// 진행 중 지시를 대화에 넣을 때 붙이는 표시
pub const STEERING_MARKER: &str = "[진행 중 지시]";

/// 지시 여러 개를 한 사용자 메시지 글로 만든다. 여러 개면 줄바꿈으로 잇는다(비어 있으면 표시 뒤에 공백 하나)
pub fn format_steering(texts: &[String]) -> String {
    format!("{STEERING_MARKER} {}", texts.join("\n"))
}

/// 마지막 메시지에 사용자 글을 어떻게 넣을지
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppendPlan {
    /// 마지막 사용자 메시지의 글 뒤에 `\n\n`과 함께 이어 붙인다
    Concat,
    /// 마지막 사용자 메시지의 내용 배열에 텍스트 블록을 더한다
    Push,
    /// 새 사용자 메시지를 넣는다
    New,
}

impl AppendPlan {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Concat => "concat",
            Self::Push => "push",
            Self::New => "new",
        }
    }
}

/// `role`은 마지막 메시지의 role(없으면 `None`), `content_kind`는 그 내용의 종류(`string`·`array`·그 밖)
pub fn append_plan(role: Option<&str>, content_kind: &str) -> AppendPlan {
    if role != Some("user") {
        return AppendPlan::New;
    }
    match content_kind {
        "string" => AppendPlan::Concat,
        "array" => AppendPlan::Push,
        _ => AppendPlan::New,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_with_marker_and_newlines() {
        assert_eq!(format_steering(&["a".into()]), "[진행 중 지시] a");
        assert_eq!(format_steering(&["a".into(), "b".into()]), "[진행 중 지시] a\nb");
        assert_eq!(format_steering(&[]), "[진행 중 지시] ");
        assert_eq!(format_steering(&["".into(), "".into()]), "[진행 중 지시] \n");
    }

    #[test]
    fn plan_follows_role_and_content_kind() {
        assert_eq!(append_plan(Some("user"), "string"), AppendPlan::Concat);
        assert_eq!(append_plan(Some("user"), "array"), AppendPlan::Push);
        assert_eq!(append_plan(Some("user"), "other"), AppendPlan::New);
        assert_eq!(append_plan(Some("assistant"), "string"), AppendPlan::New);
        assert_eq!(append_plan(Some("assistant"), "array"), AppendPlan::New);
        assert_eq!(append_plan(Some("User"), "string"), AppendPlan::New);
        assert_eq!(append_plan(None, "string"), AppendPlan::New);
    }
}
