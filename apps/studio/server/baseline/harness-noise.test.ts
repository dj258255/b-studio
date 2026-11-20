import { describe, expect, it } from 'vitest';
import { withoutTimerUsage } from './harness';

// 기준 사진에서 시각에 따라 있고 없는 값을 뺀다(#1316)
describe('샌드박스 사용량(5초 타이머) 빼기', () => {
  it('at·services 꼴의 usage는 어느 깊이에 있어도 빼고, 토큰 사용량 usage는 남긴다', () => {
    const tokens = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const sandbox = { at: '2026-11-19T00:00:00Z', services: [{ service: 'app', cpuPercent: 0.5 }] };
    const input = {
      snapshot: { status: 'ready', network: [{ service: 'app' }], usage: sandbox },
      history: [{ type: 'run_finished', usage: tokens }],
      body: { usage: sandbox, other: 1 },
    };
    expect(withoutTimerUsage(input)).toEqual({
      snapshot: { status: 'ready', network: [{ service: 'app' }] },
      history: [{ type: 'run_finished', usage: tokens }],
      body: { other: 1 },
    });
  });

  it('타이머가 돌기 전(usage 없음)과 돈 뒤(usage 있음)의 사진이 같다', () => {
    const before = { snapshot: { status: 'stopped' } };
    const after = { snapshot: { status: 'stopped', usage: { at: 'x', services: [] } } };
    expect(withoutTimerUsage(after)).toEqual(withoutTimerUsage(before));
  });
});
