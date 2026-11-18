//! 평가 자산(테스트·채점 스크립트·기대값 파일) 지문의 **판정**(ADR-175). 옛 TS는 `packages/agent/src/gate.ts`의
//! `EvaluationAssetBaseline` 비교·`evaluationAssetFailure`·`describeEvaluationAssetChange`다.
//!
//! 게이트를 막는 판정이다: 지문을 견줄 수 없으면 통과가 아니라 실패다. 바뀐 파일이 하나라도 있으면 test(테스트를 선언했으면) 또는
//! review 단계의 실패다. 여기는 순수 비교만 하고, 파일을 훑는 일은 `bstudio_io::gate_assets`가 한다.

use crate::js;

/// 지문에 담을 수 있는 파일 수 상한. 넘으면 실패하고 선언을 좁히라고 알린다
pub const MAX_FILES: usize = 2_000;
/// 평가 자산이 바뀌었을 때 사유에 나열할 파일 수 상한
pub const MAX_LIST: usize = 20;
pub const CHECK_NAME: &str = "evaluation-assets";

/// 지문: 정상이면 경로→sha256, 읽을 수 없었으면 그 사유
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Baseline {
    Ok(Vec<(String, String)>),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub stage: &'static str,
    pub ok: bool,
    pub detail: Option<String>,
}

/// 평가 자산이 바뀌었을 때의 사유. 사람이 고치는 자산이라는 것과 되돌리는 방법을 알린다(최대 20개까지 나열)
pub fn describe_change(changed: &[String]) -> String {
    let shown = &changed[..changed.len().min(MAX_LIST)];
    let rest = changed.len() - shown.len();
    let list = if rest > 0 { format!("{} 외 {rest}개", shown.join(", ")) } else { shown.join(", ") };
    format!("평가 자산이 바뀌었습니다: {list}. 평가 자산은 사람이 고칩니다 — 되돌리고 구현을 고치세요. 평가 자산이 틀렸다고 판단하면 그 까닭을 답에 적어 사람에게 알리세요.")
}

fn failure(stage: &'static str, detail: String) -> Check {
    Check { stage, ok: false, detail: Some(detail) }
}

/// `#evaluationAssetChecks`의 판정. `has_assets`가 거짓이면 빈 목록(옛 코드가 일찍 반환한다)
pub fn checks(has_assets: bool, has_tests: bool, baseline: &Baseline, current: &Baseline) -> Vec<Check> {
    if !has_assets {
        return Vec::new();
    }
    let stage: &'static str = if has_tests { "test" } else { "review" };
    let current = match current {
        Baseline::Ok(digests) => digests,
        Baseline::Error(detail) => return vec![failure(stage, detail.clone())],
    };
    let baseline = match baseline {
        Baseline::Ok(digests) => digests,
        Baseline::Error(detail) => return vec![failure(stage, detail.clone())],
    };
    let mut files: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (file, _) in baseline.iter().chain(current.iter()) {
        if seen.insert(file.clone()) {
            files.push(file.clone());
        }
    }
    let mut changed: Vec<String> = files.into_iter().filter(|file| lookup(baseline, file) != lookup(current, file)).collect();
    changed.sort_by(|a, b| js::cmp_utf16(a, b));
    if changed.is_empty() {
        return vec![Check { stage, ok: true, detail: None }];
    }
    vec![failure(stage, describe_change(&changed))]
}

fn lookup<'a>(digests: &'a [(String, String)], file: &str) -> Option<&'a str> {
    digests.iter().find(|(name, _)| name == file).map(|(_, print)| print.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items.iter().map(|(file, print)| ((*file).to_owned(), (*print).to_owned())).collect()
    }

    #[test]
    fn 같으면_통과하고_바뀌면_목록을_정렬해_알린다() {
        let baseline = Baseline::Ok(pairs(&[("b.txt", "1"), ("a.txt", "2")]));
        let same = checks(true, true, &baseline, &baseline);
        assert_eq!(same, vec![Check { stage: "test", ok: true, detail: None }]);
        let current = Baseline::Ok(pairs(&[("b.txt", "9"), ("c.txt", "3")]));
        let changed = checks(true, false, &baseline, &current);
        assert_eq!(changed[0].stage, "review");
        assert!(changed[0].detail.as_deref().unwrap_or("").starts_with("평가 자산이 바뀌었습니다: a.txt, b.txt, c.txt."), "{:?}", changed[0].detail);
    }

    #[test]
    fn 견줄_수_없으면_실패다() {
        assert!(matches!(checks(true, true, &Baseline::Error("x".into()), &Baseline::Ok(vec![]))[0].detail.as_deref(), Some("x")));
        assert!(matches!(checks(true, true, &Baseline::Ok(vec![]), &Baseline::Error("y".into()))[0].detail.as_deref(), Some("y")));
        assert!(checks(false, true, &Baseline::Error("x".into()), &Baseline::Error("y".into())).is_empty());
    }

    #[test]
    fn 목록은_스무_개까지만_나열하고_나머지를_센다() {
        let changed: Vec<String> = (0..25).map(|index| format!("{index:02}.txt")).collect();
        let text = describe_change(&changed);
        assert!(text.contains("19.txt 외 5개"), "{text}");
    }
}
