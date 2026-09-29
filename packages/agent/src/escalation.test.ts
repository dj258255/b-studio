import { describe, expect, it } from 'vitest';
import { normalizeMessage, signatureKey } from './coordination/signature';
import { shouldEscalate, signatureSetKey } from './escalation';
import type { VerificationReport } from './verify';
import type { WorkflowCheck } from './workflow';

describe('shouldEscalate', () => {
  it('마지막 times번의 서명 집합이 모두 같으면 승격한다', () => {
    expect(shouldEscalate(['a', 'a'], 2)).toBe(true);
    expect(shouldEscalate(['a', 'b', 'b'], 2)).toBe(true);
    expect(shouldEscalate(['a', 'a', 'a'], 3)).toBe(true);
  });

  it('연속이 아니면 승격하지 않는다', () => {
    expect(shouldEscalate(['a', 'b'], 2)).toBe(false);
    expect(shouldEscalate(['a', 'b', 'c'], 2)).toBe(false);
    expect(shouldEscalate(['a', 'b', 'a'], 2)).toBe(false);
  });

  it('기록이 times보다 짧으면 아직 승격하지 않는다', () => {
    expect(shouldEscalate([], 2)).toBe(false);
    expect(shouldEscalate(['a'], 2)).toBe(false);
    expect(shouldEscalate(['a', 'a'], 3)).toBe(false);
  });

  it('times가 1 미만이면 승격하지 않는다', () => {
    expect(shouldEscalate(['a'], 0)).toBe(false);
  });
});

describe('signatureSetKey', () => {
  const report = {
    restarted: [{ service: 'api', ready: false, error: '컨테이너가 종료됐습니다' }],
    contracts: [],
    sync: {},
    secretLeaks: [],
  } as unknown as VerificationReport;
  const checks = [
    { stage: 'test', name: '주문 목록 테스트', ok: false, attempts: 1, detail: 'AssertionError' },
    { stage: 'review', name: '리뷰', ok: true, attempts: 1 },
  ] as unknown as WorkflowCheck[];

  it('게이트 보고서와 실패한 워크플로 확인의 서명 키를 정렬해 합친다', () => {
    const expected = [
      signatureKey({ stage: 'run', service: 'api', message: normalizeMessage('컨테이너가 종료됐습니다') }),
      signatureKey({ stage: 'test', message: normalizeMessage('AssertionError') }),
    ]
      .sort()
      .join('\n');

    expect(signatureSetKey(report, checks)).toBe(expected);
  });

  it('통과한 워크플로 확인은 넣지 않는다', () => {
    const onlyPassing = [{ stage: 'review', name: '리뷰', ok: true, attempts: 1 }] as unknown as WorkflowCheck[];
    expect(signatureSetKey(undefined, onlyPassing)).toBe('');
  });
});
