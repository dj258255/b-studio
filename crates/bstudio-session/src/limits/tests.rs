use super::*;

fn share(limit: f64, file_total: f64, saved: f64, accum: f64) -> Option<UserShare> {
    Some(UserShare { limit, file_total, saved, accum })
}

fn verdict(session_total: f64, session_limit: Option<f64>, user: Option<UserShare>) -> Verdict {
    judge(&Input { session_total, session_limit, user })
}

#[test]
fn no_limits_never_stop() {
    assert_eq!(verdict(1e12, None, None), Verdict::Within);
}

#[test]
fn session_limit_is_inclusive_and_checked_first() {
    assert_eq!(verdict(99.0, Some(100.0), None), Verdict::Within);
    assert_eq!(verdict(100.0, Some(100.0), None), Verdict::Session);
    assert_eq!(verdict(101.0, Some(100.0), None), Verdict::Session);
    // 둘 다 넘으면 세션 한도가 먼저다(옛 `limitKind = overSession ? 'session' : 'user'`)
    assert_eq!(verdict(100.0, Some(100.0), share(10.0, 50.0, 0.0, 0.0)), Verdict::Session);
}

#[test]
fn user_share_counts_each_token_once() {
    // 저장한 몫(400)이 파일에 들어 있다: 실제 합계는 파일 800(다른 세션 400 + 이 실행 400)이고 이 실행 누적은 400이다
    assert_eq!(user_total(&share(1000.0, 800.0, 400.0, 400.0).unwrap()), Some(800.0));
    assert_eq!(verdict(0.0, None, share(1000.0, 800.0, 400.0, 400.0)), Verdict::Within);
    assert_eq!(verdict(0.0, None, share(1000.0, 1000.0, 400.0, 400.0)), Verdict::User);
    // 저장하지 못한 증가분(누적 400, 저장 0)은 파일에 없으므로 더해서 센다
    assert_eq!(user_total(&share(1000.0, 600.0, 0.0, 400.0).unwrap()), Some(1000.0));
    assert_eq!(verdict(0.0, None, share(1000.0, 600.0, 0.0, 400.0)), Verdict::User);
    assert_eq!(verdict(0.0, None, share(1000.0, 599.0, 0.0, 400.0)), Verdict::Within);
}

#[test]
fn request_start_reads_only_the_file() {
    assert_eq!(verdict(0.0, None, share(1000.0, 999.0, 0.0, 0.0)), Verdict::Within);
    assert_eq!(verdict(0.0, None, share(1000.0, 1000.0, 0.0, 0.0)), Verdict::User);
}

#[test]
fn saved_beyond_the_file_total_does_not_go_negative() {
    // 기간이 바뀌어 새 기간 파일(0)에는 저장 몫이 없다. 이 실행 누적만 센다(옛 판정: 파일 합계 + 이 실행 누적)
    assert_eq!(user_total(&share(1000.0, 0.0, 500.0, 700.0).unwrap()), Some(700.0));
}

#[test]
fn unknown_inputs_count_as_reached() {
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
        assert_eq!(verdict(bad, Some(100.0), None), Verdict::Session, "세션 합계 {bad}");
        assert_eq!(verdict(0.0, None, share(1000.0, bad, 0.0, 0.0)), Verdict::User, "파일 합계 {bad}");
        assert_eq!(verdict(0.0, None, share(1000.0, 0.0, bad, 0.0)), Verdict::User, "저장 몫 {bad}");
        assert_eq!(verdict(0.0, None, share(1000.0, 0.0, 0.0, bad)), Verdict::User, "누적 {bad}");
    }
    for bad in [f64::NAN, 0.0, -5.0, f64::INFINITY] {
        assert_eq!(verdict(0.0, Some(bad), None), Verdict::Session, "세션 한도 {bad}");
        assert_eq!(verdict(0.0, None, share(bad, 0.0, 0.0, 0.0)), Verdict::User, "사람 한도 {bad}");
    }
    // 한도가 없으면 그 쪽 입력은 보지 않는다
    assert_eq!(verdict(f64::NAN, None, None), Verdict::Within);
}
