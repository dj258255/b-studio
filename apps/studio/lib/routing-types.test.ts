import { describe, expect, it } from 'vitest';
import { kindRecords, type RoutingStatsRow } from './routing-types';

/** 미리보기 옆의 같은 작업 종류 기록(#827). 표의 줄(백엔드 × 모델 × 종류)을 백엔드별로 모은다 */
function row(backend: string, model: string, kind: RoutingStatsRow['kind'], counts: Partial<Pick<RoutingStatsRow, 'passed' | 'failed' | 'errors' | 'platformFailures' | 'noChange' | 'needsReview'>>): RoutingStatsRow {
  const filled = { passed: 0, failed: 0, errors: 0, platformFailures: 0, noChange: 0, needsReview: 0, ...counts };
  return { backend, model, kind, runs: Object.values(filled).reduce((a, b) => a + b, 0), ...filled };
}

const normal = { complexity: 'normal', risk: 'normal' } as const;

describe('kindRecords', () => {
  it('같은 종류의 줄만 백엔드별로 모으고, 판정 난 실행이 3회 이상인 백엔드만 통과율 높은 순으로 돌려준다', () => {
    const rows = [
      row('codex', 'gpt-5.5', normal, { passed: 2, failed: 1 }),
      row('codex', 'gpt-5.5-mini', normal, { passed: 2, platformFailures: 4, noChange: 2 }),
      row('claude-code', 'opus', normal, { passed: 1, errors: 2 }),
      row('claude-code', 'opus', { complexity: 'normal', risk: 'high' }, { passed: 9 }),
      row('commandcode', 'x', normal, { passed: 2 }),
      row('gemini', 'g', 'unknown', { passed: 5 }),
    ];
    expect(kindRecords(rows, normal)).toEqual([
      { backend: 'codex', passed: 4, judged: 5 },
      { backend: 'claude-code', passed: 1, judged: 3 },
    ]);
  });

  it('기록이 모자라면 빈 목록이다', () => {
    expect(kindRecords([row('codex', 'm', normal, { passed: 1, failed: 1 })], normal)).toEqual([]);
  });
});
