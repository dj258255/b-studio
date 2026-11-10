//! 작업 계획의 판정(옛 TS: `packages/agent/src/task-plan.ts`, ADR-191 3단계 3x).
//!
//! 순수 함수만 있다. zod 스키마(`TaskPlanSchema`)가 읽고 고친 값이 들어온다: 경로의 `\\`→`/`, 앞 `./`·뒤 `/` 떼기, id 꼴, 개수 상한(16)은 TS가 이미 했다.
//! 여기서 하는 것은 그 뒤의 판정이다: 상한(작업 수·레인 수), id 중복, 의존 대상, 연결 요소로 레인 나누기, 의존 순서, 한 레인의 backend·model 일치,
//! 병렬 레인의 쓰기 범위 겹침, 쓰기 범위(허용 목록) 안인지.
//!
//! 막는 쪽/여는 쪽:
//! - 계획 검증(`plan_lanes`)은 막는 쪽이다. 통과한 계획의 레인 범위(`paths`)가 이후 쓰기 허용 목록이 된다. 그래서 글자는 부르는 쪽이 `encodeLoneSurrogates`한 것을 받고,
//!   id·backend·model·경로의 같음·중복 판정은 그 단사 인코딩 글자로 한다(짝 없는 서로게이트가 U+FFFD로 합쳐져 서로 다른 범위가 하나가 되지 않게).
//!   겹침 판정만 거부 목록(넓게 맞출수록 더 막는다)이라 파일 시스템이 실제로 쓰는 이름(인코딩을 풀어 짝 없는 서로게이트를 U+FFFD로)으로 견준다.
//! - 쓰기 범위 판정(`is_in_scope`)은 여는 쪽(허용 목록)이다. `path_policy::is_within_scope`를 그대로 쓴다(좁게 맞춘다). 글자는 인코딩한 것을 받는다.
//! - 상한 읽기(`read_plan_limit`)는 상한이다. 모르는 값은 기본값으로 돌린다.
//!
//! 의도한 차이: (1) 레인 범위의 정렬은 인코딩한 글자의 UTF-16 순서다(짝 없는 서로게이트가 든 경로끼리만 옛 순서와 다를 수 있다. 허용 목록이라 순서는 뜻이 없다).
//! (2) 오류 글에 든 경로·id·모델은 인코딩한 글자라 부르는 쪽이 풀어 읽는다.

use std::collections::HashMap;

use crate::js::{self, number_to_string};
use crate::path_policy;

pub const MAX_PLAN_TASKS: u32 = 6;
pub const MAX_PLAN_LANES: u32 = 3;
pub const MAX_PLAN_LANES_CAP: u32 = 8;
pub const MAX_PLAN_TASKS_CAP: u32 = 16;

/// 값 하나를 읽는다. 비었으면 기본값, 정수가 아니거나 1~상한 밖이면 (기본값, 경고)
pub fn read_plan_limit(raw: Option<&str>, name: &str, fallback: u32, cap: u32) -> (u32, Option<String>) {
    let Some(value) = raw.map(js::trim) else {
        return (fallback, None);
    };
    if value.is_empty() {
        return (fallback, None);
    }
    let parsed = js::to_number(value);
    if !(parsed.is_finite() && parsed.fract() == 0.0 && parsed >= 1.0 && parsed <= f64::from(cap)) {
        let warning = format!("[b-studio] {name}={value}을(를) 쓸 수 없습니다. 1~{cap} 사이 정수여야 합니다. 기본값 {fallback}으로 진행합니다");
        return (fallback, Some(warning));
    }
    (parsed as u32, None)
}

/// (최대 레인 수, 최대 작업 수, 경고 목록)
pub fn plan_limits(max_lanes: Option<&str>, max_tasks: Option<&str>) -> (u32, u32, Vec<String>) {
    let (lanes, lanes_warning) = read_plan_limit(max_lanes, "B_STUDIO_MAX_LANES", MAX_PLAN_LANES, MAX_PLAN_LANES_CAP);
    let (tasks, tasks_warning) = read_plan_limit(max_tasks, "B_STUDIO_MAX_PLAN_TASKS", MAX_PLAN_TASKS, MAX_PLAN_TASKS_CAP);
    (lanes, tasks, lanes_warning.into_iter().chain(tasks_warning).collect())
}

/// zod가 읽은 작업 하나에서 판정에 쓰는 필드. 글자는 모두 `encodeLoneSurrogates`한 것이다
#[derive(Clone, Debug, PartialEq)]
pub struct PlanTask {
    pub id: String,
    pub depends_on: Vec<String>,
    pub backend: Option<String>,
    pub model: Option<String>,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Lane {
    pub id: String,
    /// 입력 작업 목록의 순번. 의존 순서대로
    pub tasks: Vec<usize>,
    /// 레인에 속한 작업들의 쓰기 범위 합(중복 없이, UTF-16 순서)
    pub paths: Vec<String>,
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// 한 레인(연결 요소)의 작업을 의존 순서대로. 순환이면 그 작업의 id로 만든 오류 글
fn topological_order(tasks: &[PlanTask], group: &[usize], by_id: &HashMap<&str, usize>) -> Result<Vec<usize>, String> {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Visiting,
        Done,
    }
    fn visit(i: usize, tasks: &[PlanTask], group: &[usize], by_id: &HashMap<&str, usize>, state: &mut HashMap<usize, State>, ordered: &mut Vec<usize>) -> Result<(), String> {
        match state.get(&i) {
            Some(State::Done) => return Ok(()),
            Some(State::Visiting) => return Err(format!("순환 의존성이 있습니다: {}", tasks[i].id)),
            None => {}
        }
        state.insert(i, State::Visiting);
        for dependency in &tasks[i].depends_on {
            // 그룹 안의 작업만 따라간다(같은 연결 요소라 늘 그룹 안이다)
            if let Some(&d) = by_id.get(dependency.as_str()) {
                if group.contains(&d) {
                    visit(d, tasks, group, by_id, state, ordered)?;
                }
            }
        }
        state.insert(i, State::Done);
        ordered.push(i);
        Ok(())
    }
    let mut state = HashMap::new();
    let mut ordered = Vec::new();
    for &i in group {
        visit(i, tasks, group, by_id, &mut state, &mut ordered)?;
    }
    Ok(ordered)
}

/// 계획을 검증하고 레인으로 묶는다. 틀리면 오류 글(옛 `TaskPlanError`의 메시지)
pub fn plan_lanes(tasks: &[PlanTask], max_tasks: f64, max_lanes: f64, backslash_sep: bool) -> Result<Vec<Lane>, String> {
    if tasks.len() as f64 > max_tasks {
        return Err(format!("작업은 {}개까지입니다 (계획: {}개)", number_to_string(max_tasks), tasks.len()));
    }
    // 같은 id가 여럿이면 뒤의 것이 이긴다(JS `Map`)
    let by_id: HashMap<&str, usize> = tasks.iter().enumerate().map(|(i, task)| (task.id.as_str(), i)).collect();
    if by_id.len() != tasks.len() {
        return Err("작업 id가 중복됩니다".to_owned());
    }
    for task in tasks {
        for dependency in &task.depends_on {
            if !by_id.contains_key(dependency.as_str()) {
                return Err(format!("{}: 없는 작업 '{}'에 의존합니다", task.id, dependency));
            }
            if *dependency == task.id {
                return Err(format!("{}: 자기 자신에게 의존할 수 없습니다", task.id));
            }
        }
    }

    // 의존 관계로 이어진 작업끼리 한 레인에 묶는다(방향 없는 연결 요소). 레인 순서는 각 요소의 첫 작업이 나온 순서다
    let mut parent: Vec<usize> = (0..tasks.len()).collect();
    for (i, task) in tasks.iter().enumerate() {
        for dependency in &task.depends_on {
            let d = by_id[dependency.as_str()];
            let (a, b) = (find(&mut parent, i), find(&mut parent, d));
            parent[a] = b;
        }
    }
    let mut group_order: Vec<usize> = Vec::new();
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..tasks.len() {
        let root = find(&mut parent, i);
        groups.entry(root).or_insert_with(|| {
            group_order.push(root);
            Vec::new()
        });
        groups.get_mut(&root).map(|g| g.push(i));
    }

    let mut lanes: Vec<Lane> = Vec::new();
    for (index, root) in group_order.iter().enumerate() {
        let ordered = topological_order(tasks, &groups[root], &by_id)?;
        // 한 레인의 작업은 한 세션에서 차례로 돈다. backend·model이 섞이면 실행 전에 막는다
        let head = &tasks[ordered[0]];
        for &i in &ordered {
            let task = &tasks[i];
            if task.backend != head.backend {
                return Err(format!(
                    "같은 레인의 작업은 backend가 같아야 합니다: {}({}) ↔ {}({})",
                    head.id,
                    head.backend.as_deref().unwrap_or("서버 기본"),
                    task.id,
                    task.backend.as_deref().unwrap_or("서버 기본")
                ));
            }
            if task.model != head.model {
                return Err(format!(
                    "같은 레인의 작업은 model이 같아야 합니다: {}({}) ↔ {}({})",
                    head.id,
                    head.model.as_deref().unwrap_or("기본"),
                    task.id,
                    task.model.as_deref().unwrap_or("기본")
                ));
            }
        }
        let mut paths: Vec<String> = Vec::new();
        for &i in &ordered {
            for path in &tasks[i].paths {
                if !paths.contains(path) {
                    paths.push(path.clone());
                }
            }
        }
        paths.sort_by(|a, b| js::cmp_utf16(a, b));
        lanes.push(Lane { id: format!("lane-{}", index + 1), tasks: ordered, paths });
    }
    if lanes.len() as f64 > max_lanes {
        return Err(format!("동시에 돌릴 레인은 {}개까지입니다 (계획: {}개)", number_to_string(max_lanes), lanes.len()));
    }

    // 병렬 레인의 쓰기 범위가 겹치면 합칠 때 어느 쪽 결과가 맞는지 정할 수 없다. 실행 전에 막는다.
    // 거부 목록 쪽이라 파일 시스템이 실제로 쓰는 이름(짝 없는 서로게이트 → U+FFFD)으로 견준다
    for a in 0..lanes.len() {
        for b in (a + 1)..lanes.len() {
            for left in &lanes[a].paths {
                let left_name = js::well_formed_from_encoded(left);
                let overlap = lanes[b].paths.iter().find(|right| {
                    let right_name = js::well_formed_from_encoded(right);
                    path_policy::is_protected_path(&left_name, &right_name, backslash_sep) || path_policy::is_protected_path(&right_name, &left_name, backslash_sep)
                });
                if let Some(overlap) = overlap {
                    return Err(format!("병렬 레인의 쓰기 범위가 겹칩니다: {} '{}' ↔ {} '{}'", lanes[a].id, left, lanes[b].id, overlap));
                }
            }
        }
    }
    Ok(lanes)
}

/// 파일이 그 작업(레인)의 쓰기 범위 안에 있는지(허용 목록). 글자는 `encodeLoneSurrogates`한 것이다
pub fn is_in_scope(file: &str, paths: &[String], backslash_sep: bool) -> bool {
    paths.iter().any(|scope| path_policy::is_within_scope(file, scope, backslash_sep))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, depends_on: &[&str], paths: &[&str]) -> PlanTask {
        PlanTask { id: id.to_owned(), depends_on: depends_on.iter().map(|d| (*d).to_owned()).collect(), backend: None, model: None, paths: paths.iter().map(|p| (*p).to_owned()).collect() }
    }

    #[test]
    fn 상한은_정수만_받고_모르면_기본값이다() {
        assert_eq!(read_plan_limit(None, "N", 3, 8), (3, None));
        assert_eq!(read_plan_limit(Some("  "), "N", 3, 8), (3, None));
        assert_eq!(read_plan_limit(Some(" 5 "), "N", 3, 8), (5, None));
        assert_eq!(read_plan_limit(Some("8"), "N", 3, 8).0, 8);
        assert_eq!(read_plan_limit(Some("0x4"), "N", 3, 8).0, 4);
        assert_eq!(read_plan_limit(Some("1e0"), "N", 3, 8).0, 1);
        for bad in ["9", "0", "-1", "2.5", "abc", "NaN", "Infinity", "1_0", "５"] {
            let (value, warning) = read_plan_limit(Some(bad), "N", 3, 8);
            assert_eq!(value, 3, "{bad}");
            assert_eq!(warning.unwrap(), format!("[b-studio] N={bad}을(를) 쓸 수 없습니다. 1~8 사이 정수여야 합니다. 기본값 3으로 진행합니다"));
        }
    }

    #[test]
    fn 의존으로_이어진_작업은_한_레인에_의존_순서로_묶인다() {
        let tasks = vec![task("b", &["a"], &["web"]), task("c", &[], &["api"]), task("a", &[], &["web/lib"])];
        let lanes = plan_lanes(&tasks, 6.0, 3.0, false).unwrap();
        assert_eq!(lanes.len(), 2);
        assert_eq!(lanes[0].id, "lane-1");
        assert_eq!(lanes[0].tasks, vec![2, 0]);
        assert_eq!(lanes[0].paths, vec!["web", "web/lib"]);
        assert_eq!(lanes[1].tasks, vec![1]);
    }

    #[test]
    fn 틀린_계획은_옛_메시지로_막는다() {
        assert_eq!(plan_lanes(&[task("a", &[], &["x"]), task("b", &[], &["y"])], 1.0, 3.0, false).unwrap_err(), "작업은 1개까지입니다 (계획: 2개)");
        assert_eq!(plan_lanes(&[task("a", &[], &["x"]), task("a", &[], &["y"])], 6.0, 3.0, false).unwrap_err(), "작업 id가 중복됩니다");
        assert_eq!(plan_lanes(&[task("a", &["z"], &["x"])], 6.0, 3.0, false).unwrap_err(), "a: 없는 작업 'z'에 의존합니다");
        assert_eq!(plan_lanes(&[task("a", &["a"], &["x"])], 6.0, 3.0, false).unwrap_err(), "a: 자기 자신에게 의존할 수 없습니다");
        assert_eq!(plan_lanes(&[task("a", &["b"], &["x"]), task("b", &["a"], &["x"])], 6.0, 3.0, false).unwrap_err(), "순환 의존성이 있습니다: a");
        assert_eq!(
            plan_lanes(&[task("a", &[], &["web"]), task("b", &[], &["web/lib"])], 6.0, 3.0, false).unwrap_err(),
            "병렬 레인의 쓰기 범위가 겹칩니다: lane-1 'web' ↔ lane-2 'web/lib'"
        );
        let mut a = task("a", &[], &["x"]);
        let mut b = task("b", &["a"], &["y"]);
        a.backend = Some("codex".to_owned());
        assert_eq!(plan_lanes(&[a.clone(), b.clone()], 6.0, 3.0, false).unwrap_err(), "같은 레인의 작업은 backend가 같아야 합니다: a(codex) ↔ b(서버 기본)");
        a.backend = None;
        b.model = Some("m".to_owned());
        assert_eq!(plan_lanes(&[a, b], 6.0, 3.0, false).unwrap_err(), "같은 레인의 작업은 model이 같아야 합니다: a(기본) ↔ b(m)");
        let four = vec![task("a", &[], &["a"]), task("b", &[], &["b"]), task("c", &[], &["c"]), task("d", &[], &["d"])];
        assert_eq!(plan_lanes(&four, 6.0, 3.0, false).unwrap_err(), "동시에 돌릴 레인은 3개까지입니다 (계획: 4개)");
    }

    #[test]
    fn 쓰기_범위는_이름을_글자_그대로_견준다() {
        let paths = vec!["web/app/orders".to_owned()];
        assert!(is_in_scope("web/app/orders/page.tsx", &paths, false));
        assert!(!is_in_scope("web/app/orders-old/page.tsx", &paths, false));
        assert!(!is_in_scope("web/app/ORDERS/page.tsx", &paths, false));
        assert!(!is_in_scope("web/app/orders/../../x", &paths, false));
        assert!(!is_in_scope("web/app/orders/page.tsx", &[], false));
    }
}
