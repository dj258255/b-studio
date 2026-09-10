import { describe, expect, it } from 'vitest';
import { decideReadiness, type ReadinessPolicy } from './readiness';
import type { ProbeResult } from './types';

const policy: ReadinessPolicy = { successThreshold: 2, timeoutMs: 10_000, intervalMs: 1_000 };

const refused = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  at: 0,
  ok: false,
  error: 'ECONNREFUSED',
  containerState: 'running',
  ...overrides,
});
const healthy = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  at: 0,
  ok: true,
  status: 200,
  containerState: 'running',
  ...overrides,
});

describe('decideReadiness', () => {
  it('기동 중 연결 거부는 기다린다', () => {
    expect(decideReadiness([refused(), refused()], policy, 3_000)).toEqual({ kind: 'waiting' });
  });

  it('연속 성공 횟수를 채워야 준비로 본다', () => {
    expect(decideReadiness([refused(), healthy()], policy, 3_000)).toEqual({ kind: 'waiting' });
    expect(decideReadiness([refused(), healthy(), healthy()], policy, 3_000)).toEqual({ kind: 'ready' });
  });

  it('중간에 실패하면 연속 성공을 다시 센다', () => {
    expect(decideReadiness([healthy(), refused({ status: 503, error: undefined }), healthy()], policy, 3_000)).toEqual({
      kind: 'waiting',
    });
  });

  it('컨테이너가 죽으면 타임아웃 전이라도 바로 실패한다', () => {
    const decision = decideReadiness([refused(), refused({ containerState: 'exited' })], policy, 2_000);
    expect(decision).toMatchObject({ kind: 'failed' });
    expect(decision.kind === 'failed' && decision.reason).toContain('exited');
  });

  it('restarting은 다시 살아날 수 있으므로 기다린다', () => {
    expect(decideReadiness([refused({ containerState: 'restarting' })], policy, 2_000)).toEqual({ kind: 'waiting' });
  });

  it('타임아웃이 지나면 마지막 확인 결과를 담아 실패한다', () => {
    const decision = decideReadiness([refused({ status: 503, error: undefined })], policy, 10_000);
    expect(decision).toEqual({ kind: 'failed', reason: '10초 안에 준비되지 않았습니다 (마지막 확인: HTTP 503, 컨테이너 running)' });
  });
});
