import { describe, expect, it } from 'vitest';
import type { LoadedProject } from './load';
import { defaultServiceSelection, dependencyClosure, dependentsOf, missingDependencies, newlyAddedServices } from './service-selection';

describe('dependencyClosure', () => {
  it('뿌리에서 기대는 서비스를 따라가며 닫힘을 모은다', () => {
    const graph = { web: ['api'], api: ['db', 'cache'], db: [], cache: [] };
    expect(dependencyClosure(['web'], graph)).toEqual(new Set(['web', 'api', 'db', 'cache']));
  });

  it('아무도 기대지 않는 서비스는 뿌리에 없으면 빠진다', () => {
    const graph = { web: ['db'], db: [], kafka: [] };
    expect(dependencyClosure(['web'], graph)).toEqual(new Set(['web', 'db']));
  });

  it('순환 의존도 무한 루프 없이 끝난다', () => {
    const graph = { a: ['b'], b: ['a'] };
    expect(dependencyClosure(['a'], graph)).toEqual(new Set(['a', 'b']));
  });
});

describe('defaultServiceSelection', () => {
  it('managed 서비스 + 기대는 서비스의 닫힘이 기본값이고, 아무도 기대지 않는 부가 서비스(예: 가져온 kafka)는 빠진다', () => {
    const project = {
      managed: [['web', {}], ['api', {}]],
      dependsOn: { web: ['api'], api: ['db'], db: [], kafka: [] },
    } as unknown as Pick<LoadedProject, 'managed' | 'dependsOn'>;
    expect(defaultServiceSelection(project)).toEqual(['api', 'db', 'web']);
  });
});

describe('missingDependencies', () => {
  it('고른 서비스 중 기대는 서비스가 선택에서 빠진 쌍을 모은다', () => {
    const graph = { api: ['db'], web: ['api'] };
    expect(missingDependencies(new Set(['api', 'web']), graph)).toEqual([{ service: 'api', dependsOn: 'db' }]);
  });

  it('선택에 기대는 서비스도 들어 있으면 빈 배열이다', () => {
    const graph = { api: ['db'], db: [] };
    expect(missingDependencies(new Set(['api', 'db']), graph)).toEqual([]);
  });
});

describe('dependentsOf', () => {
  it('끄려는 서비스에 기대는, 지금 선택된 서비스 이름을 이름 순으로 돌려준다', () => {
    const graph = { commerce: ['mysql'], worker: ['mysql'], web: [] };
    expect(dependentsOf('mysql', new Set(['commerce', 'worker', 'web']), graph)).toEqual(['commerce', 'worker']);
  });

  it('선택에서 빠진 서비스는 세지 않는다', () => {
    const graph = { commerce: ['mysql'], worker: ['mysql'] };
    expect(dependentsOf('mysql', new Set(['worker']), graph)).toEqual(['worker']);
  });
});

describe('newlyAddedServices(도그푸딩 마찰 138, ADR-146)', () => {
  it('known에 없는 compose 서비스 이름만 돌려준다', () => {
    expect(newlyAddedServices(new Set(['commerce', 'mysql']), ['commerce', 'mysql', 'mediamtx'])).toEqual(['mediamtx']);
  });

  it('새로 생긴 서비스가 없으면 빈 배열이다', () => {
    expect(newlyAddedServices(new Set(['commerce', 'mysql']), ['commerce', 'mysql'])).toEqual([]);
  });

  it('known이 없으면(이 비교 기준이 생기기 전 저장) 빈 배열이다 — 가릴 기준이 없을 때는 아무것도 새로 켜지 않는다', () => {
    expect(newlyAddedServices(undefined, ['commerce', 'mysql', 'mediamtx'])).toEqual([]);
  });
});
