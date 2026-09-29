import type { ServiceUsage } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { appendUsageSample, groupByRole, sparklinePath, type ResourceHistory } from './resource-history';

const service = (partial: Partial<ServiceUsage> & { service: string }): ServiceUsage => ({
  state: 'running',
  oomKilled: false,
  ...partial,
});

describe('groupByRole', () => {
  it('managed/supporting/platform 순서로 묶고, 비어 있는 갈래는 뺀다', () => {
    const groups = groupByRole([
      service({ service: 'db', role: 'supporting' }),
      service({ service: 'api', role: 'managed' }),
      service({ service: 'b-studio-edge', role: 'platform' }),
      service({ service: 'web', role: 'managed' }),
      // role이 없는 컨테이너(옛 제공자·픽스처)는 부가 서비스로 묶인다
      service({ service: 'legacy' }),
    ]);

    expect(groups.map((group) => group.role)).toEqual(['managed', 'supporting', 'platform']);
    expect(groups[0]).toMatchObject({ label: '서비스', services: [{ service: 'api' }, { service: 'web' }] });
    expect(groups[1]).toMatchObject({ label: '부가 서비스', services: [{ service: 'db' }, { service: 'legacy' }] });
    expect(groups[2]).toMatchObject({ label: '플랫폼', services: [{ service: 'b-studio-edge' }] });
  });

  it('컨테이너가 없으면 빈 배열', () => {
    expect(groupByRole([])).toEqual([]);
  });
});

describe('appendUsageSample', () => {
  it('샘플을 이어붙이고, maxSamples를 넘으면 오래된 것부터 버린다', () => {
    const first = appendUsageSample({}, [{ service: 'api', cpuPercent: 10, memoryBytes: 100 }], 1_000);
    expect(first).toEqual({ api: [{ at: 1_000, cpuPercent: 10, memoryBytes: 100 }] });

    const second = appendUsageSample(
      first,
      [
        { service: 'api', cpuPercent: 20, memoryBytes: 200 },
        { service: 'db', cpuPercent: 5, memoryBytes: 50 },
      ],
      2_000,
      2,
    );
    expect(second).toEqual({
      api: [
        { at: 1_000, cpuPercent: 10, memoryBytes: 100 },
        { at: 2_000, cpuPercent: 20, memoryBytes: 200 },
      ],
      db: [{ at: 2_000, cpuPercent: 5, memoryBytes: 50 }],
    });

    // db가 이번엔 없다 -> 완전히 사라진 컨테이너의 이력은 버린다. api는 2개를 넘겨 가장 오래된 것을 버린다
    const third = appendUsageSample(second, [{ service: 'api', cpuPercent: 30, memoryBytes: 300 }], 3_000, 2);
    expect(third).toEqual({
      api: [
        { at: 2_000, cpuPercent: 20, memoryBytes: 200 },
        { at: 3_000, cpuPercent: 30, memoryBytes: 300 },
      ],
    });
  });

  it('컨테이너가 다 사라지면 빈 이력이 된다', () => {
    const history: ResourceHistory = { api: [{ at: 1, cpuPercent: 1 }] };
    expect(appendUsageSample(history, [], 2)).toEqual({});
  });
});

describe('sparklinePath', () => {
  it('값이 하나도 없으면 빈 문자열', () => {
    expect(sparklinePath([])).toBe('');
    expect(sparklinePath([undefined, undefined])).toBe('');
  });

  it('값이 하나뿐이면 점(길이 0인 선)을 그린다', () => {
    expect(sparklinePath([5])).toBe('M0.0,18.0 L0.0,18.0');
  });

  it('오르는 값 두 개는 왼쪽 아래에서 오른쪽 위로 잇는다', () => {
    expect(sparklinePath([0, 10])).toBe('M0.0,18.0 L64.0,2.0');
  });

  it('값이 없는 자리(undefined)에서 선을 끊는다', () => {
    expect(sparklinePath([1, undefined, 3])).toBe('M0.0,18.0 L0.0,18.0 M64.0,2.0 L64.0,2.0');
  });

  it('너비·높이를 바꿀 수 있다', () => {
    expect(sparklinePath([0, 1], { width: 10, height: 10, padding: 0 })).toBe('M0.0,10.0 L10.0,0.0');
  });
});
