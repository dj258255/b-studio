//! 작업 그래프 검증(옛 TS: `packages/agent/src/task-graph.ts`의 `runTaskGraph` 앞부분과 `assertAcyclic`, ADR-191 3단계 3af).
//! 실행·이벤트·AbortSignal은 TS가 한다. 여기는 그래프가 실행해도 되는 꼴인지만 정한다(통과시키면 작업이 돈다).
//!
//! 검사 순서와 메시지는 옛 TS와 같다: id 중복 → 없는 의존성(노드 순서, 의존성 순서) → 순환(노드 순서로 깊이 우선, 처음 되돌아온 id).
//! 의도한 차이: 옛 TS는 재귀라 의존 사슬이 만 단계쯤 되면 `RangeError`로 던졌다. 여기는 반복이라 깊이에 상관없이 판정한다.
//! id는 `encodeLoneSurrogates`한 글자로 받아 짝 없는 서로게이트가 합쳐지지 않는다(합쳐지면 다른 두 작업이 중복으로 보이는 쪽이라 닫는 쪽이지만 같게 둔다).

use std::collections::HashMap;

pub struct Node {
    pub id: String,
    pub depends_on: Vec<String>,
}

/// 그래프가 실행할 수 없는 꼴이면 `TaskGraphError`의 메시지(인코딩한 글자), 아니면 `None`
pub fn validate(nodes: &[Node]) -> Option<String> {
    let mut index: HashMap<&str, usize> = HashMap::with_capacity(nodes.len());
    for (i, node) in nodes.iter().enumerate() {
        index.insert(node.id.as_str(), i);
    }
    if index.len() != nodes.len() {
        return Some("task id가 중복됩니다".to_owned());
    }
    for node in nodes {
        for dependency in &node.depends_on {
            if !index.contains_key(dependency.as_str()) {
                return Some(format!("{}: 없는 의존성 '{}'", node.id, dependency));
            }
        }
    }
    if let Some(id) = find_cycle(nodes, &index) {
        return Some(format!("순환 의존성이 있습니다: {id}"));
    }
    None
}

/// 노드 순서로 깊이 우선 탐색하다 "방문 중"인 노드를 다시 만나면 그 id
fn find_cycle<'a>(nodes: &'a [Node], index: &HashMap<&str, usize>) -> Option<&'a str> {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        New,
        Visiting,
        Done,
    }
    let mut state = vec![State::New; nodes.len()];
    for start in 0..nodes.len() {
        match state[start] {
            State::Visiting => return Some(&nodes[start].id),
            State::Done => continue,
            State::New => {}
        }
        state[start] = State::Visiting;
        let mut stack: Vec<(usize, usize)> = vec![(start, 0)];
        while let Some(&(node, next)) = stack.last() {
            let deps = &nodes[node].depends_on;
            if next >= deps.len() {
                state[node] = State::Done;
                stack.pop();
                continue;
            }
            stack.last_mut().expect("방금 읽었다").1 += 1;
            let dependency = index[deps[next].as_str()];
            match state[dependency] {
                State::Visiting => return Some(&nodes[dependency].id),
                State::Done => {}
                State::New => {
                    state[dependency] = State::Visiting;
                    stack.push((dependency, 0));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(spec: &[(&str, &[&str])]) -> Vec<Node> {
        spec.iter().map(|(id, deps)| Node { id: (*id).to_owned(), depends_on: deps.iter().map(|d| (*d).to_owned()).collect() }).collect()
    }

    #[test]
    fn accepts_a_dag_and_the_empty_graph() {
        assert_eq!(validate(&g(&[])), None);
        assert_eq!(validate(&g(&[("a", &[]), ("b", &["a"]), ("c", &["a", "b"])])), None);
        assert_eq!(validate(&g(&[("c", &["a", "b"]), ("b", &["a"]), ("a", &[])])), None);
        // 같은 의존성을 두 번 적어도 순환이 아니다
        assert_eq!(validate(&g(&[("a", &[]), ("b", &["a", "a"])])), None);
    }

    #[test]
    fn rejects_duplicates_missing_and_cycles_with_the_old_messages() {
        assert_eq!(validate(&g(&[("a", &[]), ("a", &[])])).as_deref(), Some("task id가 중복됩니다"));
        assert_eq!(validate(&g(&[("a", &["x"])])).as_deref(), Some("a: 없는 의존성 'x'"));
        assert_eq!(validate(&g(&[("a", &["a"])])).as_deref(), Some("순환 의존성이 있습니다: a"));
        assert_eq!(validate(&g(&[("a", &["b"]), ("b", &["a"])])).as_deref(), Some("순환 의존성이 있습니다: a"));
        assert_eq!(validate(&g(&[("a", &[]), ("b", &["c"]), ("c", &["d"]), ("d", &["b"])])).as_deref(), Some("순환 의존성이 있습니다: b"));
        // 중복이 없는 쪽 검사보다 먼저, 없는 의존성이 순환보다 먼저
        assert_eq!(validate(&g(&[("a", &["b"]), ("b", &["a", "zz"])])).as_deref(), Some("b: 없는 의존성 'zz'"));
        assert_eq!(validate(&g(&[("a", &["a"]), ("a", &[])])).as_deref(), Some("task id가 중복됩니다"));
    }

    #[test]
    fn deep_chain_is_judged_without_recursion() {
        let n = 200_000;
        let mut nodes: Vec<Node> = (0..n).map(|i| Node { id: i.to_string(), depends_on: if i == 0 { vec![] } else { vec![(i - 1).to_string()] } }).collect();
        assert_eq!(validate(&nodes), None);
        nodes[0].depends_on = vec![(n - 1).to_string()];
        assert_eq!(validate(&nodes).as_deref(), Some("순환 의존성이 있습니다: 0"));
    }

    #[test]
    fn diamond_is_not_a_cycle() {
        assert_eq!(validate(&g(&[("a", &[]), ("b", &["a"]), ("c", &["a"]), ("d", &["b", "c"])])), None);
    }
}
