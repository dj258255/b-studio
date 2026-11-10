import { TaskGraphError, type TaskNode } from './task-graph';

/** 옮기기 전(ADR-191 3단계 3af 이전)의 task-graph.ts 검증 원본(runTaskGraph 앞부분과 assertAcyclic). 차등 시험의 기준으로만 쓴다 */
export function legacyValidateGraph<T>(nodes: readonly TaskNode<T>[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new TaskGraphError('task id가 중복됩니다');
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!byId.has(dependency)) throw new TaskGraphError(`${node.id}: 없는 의존성 '${dependency}'`);
    }
  }
  assertAcyclic(nodes);
}

function assertAcyclic<T>(nodes: readonly TaskNode<T>[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new TaskGraphError(`순환 의존성이 있습니다: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}
