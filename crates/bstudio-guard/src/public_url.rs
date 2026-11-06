//! 런타임 공개 URL 자리 표시자(ADR-191 2단계 2b-2a). `@b-studio/spec`의 `public-url.ts`와 같은 규칙을 한 벌 더 둔다.
//!
//! `@b-studio/spec`은 sandbox의 네이티브 모듈을 부를 수 없다(sandbox가 spec에 의존한다). 그래서 compose override를 만드는 쪽(Rust)이
//! 같은 문법을 직접 읽는다. 두 구현이 같은 입력을 같게 읽는지는 `packages/sandbox/src/docker/public-url-differential.test.ts`가
//! 무작위 입력으로 묶는다. 문법: `${b-studio:services.<서비스>.publicUrl}`, 서비스 이름은 `[a-z][a-z0-9-]*`(ASCII만).

use regex::Regex;
use std::sync::OnceLock;

fn pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\$\{b-studio:services\.([a-z][a-z0-9-]*)\.publicUrl\}")
            .expect("자리 표시자 정규식")
    })
}

/// 자리 표시자를 만든다
pub fn placeholder(service: &str) -> String {
    format!("${{b-studio:services.{service}.publicUrl}}")
}

/// 값 안의 모든 자리 표시자를 `resolve`가 돌려주는 주소로 바꾼다. 돌려준 글자는 그대로 쓴다(`$`를 해석하지 않는다)
pub fn resolve(value: &str, resolve: &mut dyn FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last = 0;
    for caps in pattern().captures_iter(value) {
        let whole = caps.get(0).expect("전체 일치");
        out.push_str(&value[last..whole.start()]);
        out.push_str(&resolve(&caps[1]));
        last = whole.end();
    }
    out.push_str(&value[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 자리_표시자를_만들고_채운다() {
        assert_eq!(
            placeholder("backend"),
            "${b-studio:services.backend.publicUrl}"
        );
        assert_eq!(
            resolve("${b-studio:services.backend.publicUrl}/api", &mut |_| {
                "http://127.0.0.1:1".into()
            }),
            "http://127.0.0.1:1/api"
        );
        assert_eq!(
            resolve("http://backend:8080", &mut |_| "x".into()),
            "http://backend:8080"
        );
    }

    #[test]
    fn 여럿이면_서비스별로_채우고_돌려준_글자의_달러는_해석하지_않는다() {
        let mut seen = vec![];
        let out = resolve(
            "${b-studio:services.a.publicUrl} ${b-studio:services.b-1.publicUrl}",
            &mut |s| {
                seen.push(s.to_owned());
                "$&$1".into()
            },
        );
        assert_eq!(out, "$&$1 $&$1");
        assert_eq!(seen, ["a", "b-1"]);
    }

    #[test]
    fn 문법에_맞지_않으면_건드리지_않는다() {
        for v in [
            "${b-studio:services.Backend.publicUrl}",
            "${b-studio:services.1a.publicUrl}",
            "${b-studio:services..publicUrl}",
            "${BACKEND_PORT:-8080}",
            "${b-studio:services.é.publicUrl}",
        ] {
            assert_eq!(resolve(v, &mut |_| "X".into()), v);
        }
    }
}
