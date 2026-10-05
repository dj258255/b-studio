import { describe, expect, it } from 'vitest';
import { normalizeMessage, signatureKey } from './coordination/signature';
import { DEFAULT_ESCALATION_RETRY_BUDGET, escalationPrompt, retryBudgetFor, shouldEscalate, shouldPromote, signatureSetKey } from './escalation';
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

describe('shouldPromote', () => {
  it('같은 서명이 반복되면 올린다(기존 규칙)', () => {
    expect(shouldPromote({ to: 'sonnet' }, ['a', 'a'])).toBe(true);
    expect(shouldPromote({ to: 'sonnet' }, ['a', 'b'])).toBe(false);
    // 임계치를 바꾸면 그 값을 쓴다
    expect(shouldPromote({ to: 'sonnet', sameSignatureTimes: 3 }, ['a', 'a'])).toBe(false);
    expect(shouldPromote({ to: 'sonnet', sameSignatureTimes: 3 }, ['a', 'a', 'a'])).toBe(true);
  });

  it('서명이 매번 달라도 afterFailures번 실패하면 올린다', () => {
    // E4의 5회처럼 서명이 계속 달라지는 실행: 서명 규칙만으로는 계기가 없다
    expect(shouldPromote({ to: 'sonnet', afterFailures: 2 }, ['a', 'b'])).toBe(true);
    expect(shouldPromote({ to: 'sonnet', afterFailures: 3 }, ['a', 'b'])).toBe(false);
    expect(shouldPromote({ to: 'sonnet', afterFailures: 3 }, ['a', 'b', 'c'])).toBe(true);
    // 서명 규칙과 OR다 — 둘 중 하나만 걸려도 올린다
    expect(shouldPromote({ to: 'sonnet', afterFailures: 5, sameSignatureTimes: 2 }, ['a', 'a'])).toBe(true);
    // afterFailures를 주지 않으면 그 규칙은 없다
    expect(shouldPromote({ to: 'sonnet', sameSignatureTimes: 5 }, ['a', 'b', 'c'])).toBe(false);
  });
});

describe('retryBudgetFor', () => {
  it('정책에 없으면 기본값(2)을 쓴다', () => {
    expect(retryBudgetFor({ to: 'sonnet' })).toBe(DEFAULT_ESCALATION_RETRY_BUDGET);
    expect(retryBudgetFor({ to: 'sonnet', retryBudget: 4 })).toBe(4);
  });

  it('0 이하이거나 숫자가 아니면 예산 없음(0)으로 본다', () => {
    expect(retryBudgetFor({ to: 'sonnet', retryBudget: 0 })).toBe(0);
    expect(retryBudgetFor({ to: 'sonnet', retryBudget: -1 })).toBe(0);
    expect(retryBudgetFor({ to: 'sonnet', retryBudget: Number.NaN })).toBe(0);
  });
});

describe('escalationPrompt', () => {
  it('마지막 실패 안내가 있으면 함께 보낸다', () => {
    expect(escalationPrompt('검증 게이트를 2번 통과하지 못했습니다', undefined)).toBe('검증 게이트를 2번 통과하지 못했습니다');
    expect(escalationPrompt('게이트 상한 소진', '[b-studio 검증 게이트] 실패')).toBe(
      '게이트 상한 소진\n\n직전 검증 결과를 다시 보냅니다.\n\n[b-studio 검증 게이트] 실패',
    );
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
