import { describe, expect, it } from 'vitest';
import type { TaskPlanMetrics } from '../../lib/task-plan-metrics';
import { summarize, type BenchRow } from './summary';

function metrics(over: Partial<TaskPlanMetrics> = {}): TaskPlanMetrics {
  return {
    endToEndMs: 1_000,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    modelCalls: 0,
    maxContextTokens: 0,
    bootMsTotal: 0,
    bootMsMax: 0,
    modelMs: 0,
    toolMs: 0,
    gateMs: 0,
    sessions: 1,
    ...over,
  };
}

function row(over: Partial<BenchRow>): BenchRow {
  return {
    order: 0,
    repeat: 1,
    taskId: 'orders-list',
    coupled: true,
    strategy: 'S0',
    model: 'm',
    startedAt: '',
    finishedAt: '',
    planStatus: 'done',
    lanes: [],
    success: true,
    category: 'none',
    detail: '',
    proxy: { forwardedCalls: 0, requestBytes: 0, responseBytes: 0, plannerCalls: 0, upstreamErrors: 0 },
    leftoverContainers: [],
    estimatedCostUsd: 0,
    ...over,
  };
}

const rows: BenchRow[] = [
  row({
    taskId: 'orders-list',
    strategy: 'S0',
    success: true,
    metrics: metrics({ endToEndMs: 30_000, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, modelCalls: 5, maxContextTokens: 1_000, bootMsTotal: 5_000 }),
  }),
  row({ taskId: 'orders-list', strategy: 'S0', success: false, category: 'lane_gate', metrics: undefined }),
  row({
    taskId: 'orders-list',
    strategy: 'S1',
    success: true,
    metrics: metrics({ endToEndMs: 20_000, usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, modelCalls: 4, maxContextTokens: 900, bootMsTotal: 4_000 }),
  }),
  row({
    taskId: 'independent',
    coupled: false,
    strategy: 'S0',
    success: true,
    metrics: metrics({ endToEndMs: 10_000, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, modelCalls: 3, maxContextTokens: 500, bootMsTotal: 2_000 }),
  }),
  row({ taskId: 'independent', coupled: false, strategy: 'S1', success: true, metrics: undefined }),
  row({ taskId: 'independent', coupled: false, strategy: 'S1', success: true, metrics: undefined }),
];

describe('summarize', () => {
  it('과제·전략별 성공 건수와 중앙값을 낸다', () => {
    const markdown = summarize(rows);

    // orders-list S0: 2회 중 1회 성공, 값이 있는 실행만으로 중앙값을 낸다
    expect(markdown).toContain('| orders-list | O | S0 | 1/2 | 30.0 | 100 | 10 | 5 | 1,000 | 5.0 |');
    expect(markdown).toContain('| orders-list | O | S1 | 1/1 | 20.0 | 200 | 20 | 4 | 900 | 4.0 |');
    expect(markdown).toContain('| independent | X | S0 | 1/1 | 10.0 | 50 | 5 | 3 | 500 | 2.0 |');
  });

  it('값이 하나도 없으면 —로 둔다', () => {
    const markdown = summarize(rows);
    // independent S1의 두 실행 모두 metrics가 없다
    expect(markdown).toContain('| independent | X | S1 | 2/2 | — | — | — | — | — | — |');
  });

  it('전략별 실패 원인을 건수로 센다', () => {
    const markdown = summarize(rows);
    // S0: none 2 (orders-list, independent), lane_gate 1
    expect(markdown).toContain('| S0 | 2 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |');
    // S1: none 3
    expect(markdown).toContain('| S1 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
  });

  it('한계 문구를 표 아래에 넣는다', () => {
    expect(summarize(rows)).toContain('반복 수가 적어 비율 대신 건수로 적습니다. 이 결과는 이 저장소·이 모델·이 과제에 한정됩니다.');
  });

  it('행이 없으면 표 머리만 낸다', () => {
    const markdown = summarize([]);
    expect(markdown).toContain('| 과제 | 엮임 | 전략 | 성공 |');
    expect(markdown).not.toContain('orders-list');
  });
});
