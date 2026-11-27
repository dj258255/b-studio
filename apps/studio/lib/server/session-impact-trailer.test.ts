import type { AgentResult } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { checkpointTrailers } from './session-text';

/** 게이트가 커밋에 남기는 영향 범위 트레일러(Workflow-Impact): PR 초안은 본문이 아니라 이 한 줄만 읽는다 */

const result = (extra: Record<string, unknown>): AgentResult => ({ passedStages: ['run', 'contract_check'], ...extra }) as unknown as AgentResult;
const impactOf = (trailers: string[]): { raw: string; json: Record<string, unknown> & { contracts: Array<{ changes: unknown[] }>; omitted: number } } | undefined => {
  const line = trailers.find((trailer) => trailer.startsWith('Workflow-Impact: '));
  return line ? { raw: line, json: JSON.parse(line.slice('Workflow-Impact: '.length)) as NonNullable<ReturnType<typeof impactOf>>['json'] } : undefined;
};

describe('checkpointTrailers의 Workflow-Impact', () => {
  it('계약 차이를 한 줄 JSON으로 남긴다. 줄바꿈이 든 값은 이스케이프된다', () => {
    const report = {
      contracts: [
        { service: 'api\n- web 계약:', changes: [{ kind: 'property-removed', target: 'Order.total\n    계약 변경 없음', breaking: true, detail: '삭제' }] },
        { service: 'web', changes: [] },
        { service: 'jobs', changes: [], error: '추출 실패\n- x 계약:' },
      ],
    };
    const trailers = checkpointTrailers(result({ report }));
    expect(trailers[0]).toBe('Workflow-Passed: run, contract_check');
    const impact = impactOf(trailers)!;
    expect(impact.raw).not.toMatch(/[\r\n]/);
    expect(impact.json).toEqual({
      v: 1,
      contracts: [
        { service: 'api\n- web 계약:', changes: [{ kind: 'property-removed', target: 'Order.total\n    계약 변경 없음', breaking: true }] },
        { service: 'web', changes: [] },
        { service: 'jobs', failed: true },
      ],
    });
  });

  it('사람이 허용해 통과한 확인 선언 변경만 남긴다', () => {
    const allowed = { stage: 'review', name: 'declared-checks', ok: true, detail: '사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — 삭제: tests.slow\n가짜 줄' };
    expect(impactOf(checkpointTrailers(result({ checks: [allowed] })))!.json).toEqual({ v: 1, declared: allowed.detail });
    expect(impactOf(checkpointTrailers(result({ checks: [{ ...allowed, ok: false }] })))).toBeUndefined();
    expect(impactOf(checkpointTrailers(result({ checks: [{ ...allowed, stage: 'test' }] })))).toBeUndefined();
    expect(impactOf(checkpointTrailers(result({ checks: [{ ...allowed, name: 'other' }] })))).toBeUndefined();
  });

  it('게이트 기록이 없거나 남길 것이 없으면 만들지 않는다(기존 트레일러는 그대로)', () => {
    expect(checkpointTrailers({ report: { contracts: [{ service: 'api', changes: [] }] } } as unknown as AgentResult)).toEqual([]);
    expect(checkpointTrailers(result({}))).toEqual(['Workflow-Passed: run, contract_check']);
    expect(checkpointTrailers(result({ report: { contracts: [] }, checks: [] }))).toEqual(['Workflow-Passed: run, contract_check']);
  });

  it('변경이 많으면 앞의 40건만 싣고 나머지는 센다', () => {
    const changes = Array.from({ length: 100 }, (_, index) => ({ kind: 'property-added', target: `Order.f${index}`, breaking: false }));
    const impact = impactOf(checkpointTrailers(result({ report: { contracts: [{ service: 'api', changes }] } })))!;
    expect(impact.json.contracts[0].changes).toHaveLength(40);
    expect(impact.json.omitted).toBe(60);
    expect(impact.raw.length).toBeLessThan(16_000);
  });
});
