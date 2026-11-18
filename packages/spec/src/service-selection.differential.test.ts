import { describe, expect, it } from 'vitest';
import type { LoadedProject } from './load';
import * as legacy from './service-selection-legacy';
import * as current from './service-selection';

/**
 * 서비스 선택 판정은 Rust(`crates/bstudio-guard/src/service_selection.rs`)로 옮겼다(ADR-195 4e 뒤 3단계 (a)).
 * 옛 TS(`service-selection-legacy.ts`)와 같은 입력에 같은 결과(순서 포함)를 내는지 견준다.
 */

function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const NAMES = ['web', 'api', 'db', 'cache', 'a-b', 'x1', '2', '10', '01', '', '한글', 'Z', 'z', 'worker', 'mediamtx'];

describe('서비스 선택: legacy TS와 Rust가 같다', () => {
  it('무작위 의존 그래프 3000개에서 닫힘·기본 선택·의존자·새 서비스가 같다', () => {
    const rand = makeRandom(20_261_118);
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;
    for (let i = 0; i < 3000; i += 1) {
      const graph: Record<string, string[]> = {};
      for (const name of NAMES) {
        if (rand() < 0.15) continue;
        const value = rand() < 0.1 ? null : Array.from({ length: int(5) }, () => pick(NAMES));
        (graph as Record<string, unknown>)[name] = value;
      }
      const roots = Array.from({ length: int(5) }, () => pick(NAMES));
      const selected = new Set(Array.from({ length: int(6) }, () => pick(NAMES)));
      const known = rand() < 0.2 ? undefined : new Set(Array.from({ length: int(5) }, () => pick(NAMES)));
      const compose = Array.from({ length: int(6) }, () => pick(NAMES));
      const label = JSON.stringify({ graph, roots, selected: [...selected], known: known && [...known], compose });
      expect([...current.dependencyClosure(roots, graph)], label).toEqual([...legacy.dependencyClosure(roots, graph)]);
      expect(current.defaultServiceSelection({ managed: roots.map((name) => [name, {}]), dependsOn: graph } as unknown as Pick<LoadedProject, 'managed' | 'dependsOn'>), label).toEqual(
        legacy.defaultServiceSelection({ managed: roots.map((name) => [name, {}]), dependsOn: graph } as unknown as Pick<LoadedProject, 'managed' | 'dependsOn'>),
      );
      const name = pick(NAMES);
      expect(current.dependentsOf(name, selected, graph), label).toEqual(legacy.dependentsOf(name, selected, graph));
      expect(current.newlyAddedServices(known, compose), label).toEqual(legacy.newlyAddedServices(known, compose));
    }
  });

  it('경계값: 빈 입력, 중복 뿌리, 순환, 없는 키, 문자열 그래프 값', () => {
    const cases: Array<{ graph: Record<string, unknown>; roots: string[]; selected: string[] }> = [
      { graph: {}, roots: [], selected: [] },
      { graph: {}, roots: ['x', 'x', 'x'], selected: ['x'] },
      { graph: { a: ['b'], b: ['a'] }, roots: ['a'], selected: ['a', 'b'] },
      { graph: { a: null, b: undefined }, roots: ['a', 'b', 'c'], selected: ['a', 'c'] },
      { graph: { a: 'bc' }, roots: ['a'], selected: ['a'] },
      { graph: { '': [''] }, roots: [''], selected: [''] },
      { graph: { '한글': ['z'] }, roots: ['한글'], selected: ['한글', 'z'] },
    ];
    for (const { graph, roots, selected } of cases) {
      const label = JSON.stringify({ graph, roots, selected });
      const g = graph as Record<string, string[]>;
      expect([...current.dependencyClosure(roots, g)], label).toEqual([...legacy.dependencyClosure(roots, g)]);
      expect(current.dependentsOf(roots[0] ?? '', new Set(selected), g), label).toEqual(legacy.dependentsOf(roots[0] ?? '', new Set(selected), g));
      expect(current.newlyAddedServices(undefined, roots), label).toEqual(legacy.newlyAddedServices(undefined, roots));
    }
  });

  it('그래프 값이 순회할 수 없는 값이면 둘 다 던진다', () => {
    const graph = { a: 1 } as unknown as Record<string, string[]>;
    expect(() => legacy.dependencyClosure(['a'], graph)).toThrow();
    expect(() => current.dependencyClosure(['a'], graph)).toThrow();
  });
});
