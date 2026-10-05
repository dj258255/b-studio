import type { ServiceUsage } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { supportingContainers } from './header-services';

const service = (partial: Partial<ServiceUsage> & { service: string }): ServiceUsage => ({
  state: 'running',
  oomKilled: false,
  ...partial,
});

describe('supportingContainers', () => {
  it('관리형 서비스 이름이 아닌 컨테이너만 뽑는다', () => {
    const result = supportingContainers(
      new Set(['web', 'api']),
      [service({ service: 'web', role: 'managed' }), service({ service: 'api', role: 'managed' }), service({ service: 'db', role: 'supporting' }), service({ service: 'b-studio-edge', role: 'platform' })],
    );

    expect(result).toEqual([
      { service: 'db', role: 'supporting', state: 'running', health: undefined },
      { service: 'b-studio-edge', role: 'platform', state: 'running', health: undefined },
    ]);
  });

  it('role이 없는 컨테이너는 부가 서비스로 본다(resource-history의 groupByRole과 같은 규칙)', () => {
    const result = supportingContainers(new Set(['web']), [service({ service: 'legacy' })]);
    expect(result).toEqual([{ service: 'legacy', role: 'supporting', state: 'running', health: undefined }]);
  });

  it('usage가 없으면(샌드박스가 꺼졌거나 아직 못 쟀으면) 빈 배열이다', () => {
    expect(supportingContainers(new Set(['web']), undefined)).toEqual([]);
  });

  it('health가 있으면 함께 돌려준다', () => {
    const result = supportingContainers(new Set([]), [service({ service: 'db', role: 'supporting', health: 'healthy' })]);
    expect(result).toEqual([{ service: 'db', role: 'supporting', state: 'running', health: 'healthy' }]);
  });
});
