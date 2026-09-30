import type { LoadedProject } from './load';

/**
 * 세션이 띄울 서비스를 고르는 순수 계산(ADR-083). b-studio는 예전에 프로젝트의 compose에 있는 모든 서비스를
 * (managed 서비스든, 폴더를 열 때 가져온 카프카·레디스 같은 부가 서비스든) 강제로 다 띄웠다. 실제로 개발하는
 * 서비스만 고를 수 있게, 기본값은 "managed 서비스 + 그 서비스가 기대는(depends_on) 서비스의 닫힘"이다 —
 * app이 쓰지 않는 부가 서비스는 기본으로 뜨지 않는다.
 */

/** roots에서 시작해 graph(서비스 → 기대는 서비스 이름)를 따라가며 닿는 모든 이름의 닫힘(자기 자신 포함) */
export function dependencyClosure(roots: readonly string[], graph: Readonly<Record<string, readonly string[]>>): Set<string> {
  const closure = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (closure.has(name)) continue;
    closure.add(name);
    for (const dependency of graph[name] ?? []) if (!closure.has(dependency)) stack.push(dependency);
  }
  return closure;
}

/** 기본 서비스 선택: managed 서비스 전부 + 그 서비스들이 기대는(depends_on) 서비스의 닫힘. 이름 순으로 정렬해 돌려준다 */
export function defaultServiceSelection(project: Pick<LoadedProject, 'managed' | 'dependsOn'>): string[] {
  const roots = project.managed.map(([name]) => name);
  return [...dependencyClosure(roots, project.dependsOn)].sort();
}

/** service → dependsOn: 고른 서비스 중 기대는 서비스가 선택에서 빠진 쌍. compose up에 --no-deps가 필요한지, 화면 경고에 쓴다 */
export interface MissingDependency {
  service: string;
  dependsOn: string;
}

export function missingDependencies(selected: ReadonlySet<string>, graph: Readonly<Record<string, readonly string[]>>): MissingDependency[] {
  const missing: MissingDependency[] = [];
  for (const service of [...selected].sort()) {
    for (const dependency of graph[service] ?? []) {
      if (!selected.has(dependency)) missing.push({ service, dependsOn: dependency });
    }
  }
  return missing;
}

/** 이 서비스를 끄면 기댈 곳을 잃는, 지금 선택된 서비스 이름(경고 문구에 쓴다). 이름 순으로 정렬해 돌려준다 */
export function dependentsOf(name: string, selected: ReadonlySet<string>, graph: Readonly<Record<string, readonly string[]>>): string[] {
  return [...selected].filter((service) => service !== name && (graph[service] ?? []).includes(name)).sort();
}
