//! "내 환경" 관찰 탭이 쓸 수 있는 docker 하위 명령 허용 목록.
//!
//! docker 소켓·CLI 접근은 사실상 호스트 root급 권한과 같으므로 읽기만 하는 하위 명령만 허용하고, 그 밖은(run, exec, rm,
//! restart, stop 등) 거부한다. `events`는 지금 부르지 않지만 실시간 갱신에 쓸 수 있도록 남겨 둔다.

/// 허용하는 하위 명령
pub const SUBCOMMANDS: [&str; 5] = ["ps", "inspect", "logs", "stats", "events"];

/// 인자가 허용 목록을 지키면 `None`, 어기면 그 이유. 허용 목록이므로 모르는 입력은 거부한다.
/// `stats`는 `--no-stream`이 없으면 연결을 계속 붙잡을 수 있어 한 번 읽고 끝나는 호출만 허용한다
pub fn violation<S: AsRef<str>>(args: &[S]) -> Option<String> {
    let sub = args.first().map(AsRef::as_ref).unwrap_or("");
    if sub.is_empty() || !SUBCOMMANDS.contains(&sub) {
        return Some(format!(
            "읽기 전용 docker 래퍼는 '{sub}' 명령을 허용하지 않습니다"
        ));
    }
    if sub == "stats" && !args.iter().any(|arg| arg.as_ref() == "--no-stream") {
        return Some("'docker stats'는 --no-stream과 함께만 허용합니다".to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 읽기_명령만_통과한다() {
        assert_eq!(violation(&["ps", "-a"]), None);
        assert_eq!(violation(&["inspect", "x"]), None);
        assert_eq!(violation(&["stats", "--no-stream"]), None);
        assert_eq!(
            violation(&["rm", "-f", "x"]).unwrap(),
            "읽기 전용 docker 래퍼는 'rm' 명령을 허용하지 않습니다"
        );
        assert_eq!(
            violation::<&str>(&[]).unwrap(),
            "읽기 전용 docker 래퍼는 '' 명령을 허용하지 않습니다"
        );
        assert_eq!(
            violation(&[""]).unwrap(),
            "읽기 전용 docker 래퍼는 '' 명령을 허용하지 않습니다"
        );
        assert_eq!(
            violation(&["stats"]).unwrap(),
            "'docker stats'는 --no-stream과 함께만 허용합니다"
        );
    }

    #[test]
    fn 이름은_정확히_같아야_한다() {
        for sub in ["PS", "ps ", " ps", "Ps", "inspect\0"] {
            assert!(violation(&[sub]).is_some(), "{sub:?}");
        }
    }
}
