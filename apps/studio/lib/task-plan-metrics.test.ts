import type { AgentUsage, RunMetrics } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { summarizeTaskPlan } from './task-plan-metrics';
import type { TaskPlanRunMetricsView, TaskPlanTaskView, TaskPlanView } from './task-plan-types';

const usage = (inputTokens: number, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0): AgentUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

const run = (options: { durationMs?: number; usage?: AgentUsage; metrics?: RunMetrics } = {}): TaskPlanRunMetricsView => ({
  status: 'done',
  durationMs: options.durationMs,
  usage: options.usage,
  metrics: options.metrics,
});

const task = (id: string, runView?: TaskPlanRunMetricsView): TaskPlanTaskView => ({
  id,
  title: id,
  request: `${id} 작업`,
  paths: ['web/a'],
  dependsOn: [],
  status: 'done',
  run: runView,
});

/** 레인 2개(작업 3개) + 통합 + 계획 호출이 든 계획 */
function basePlan(): TaskPlanView {
  return {
    id: 'plan-1',
    owner: 'kim',
    projectId: 'orders',
    request: '요청',
    modelId: 'model-a',
    status: 'done',
    createdAt: '2026-09-24T00:00:00.000Z',
    approvedAt: '2026-09-24T00:00:10.000Z',
    finishedAt: '2026-09-24T00:00:40.000Z',
    planning: { usage: usage(100, 10, 1_000, 5), durationMs: 500 },
    lanes: [
      {
        id: 'lane-1',
        paths: ['web/a'],
        status: 'done',
        sessionId: 's1',
        bootMs: 100,
        tasks: [
          task('a1', run({ durationMs: 1_000, usage: usage(200, 20, 2_000), metrics: { modelCalls: 2, maxContextTokens: 2_200, modelMs: 100, toolMs: 10, gateMs: 50 } })),
          task('a2', run({ durationMs: 900, usage: usage(300, 30, 3_000), metrics: { modelCalls: 3, maxContextTokens: 3_300, modelMs: 150, toolMs: 20, gateMs: 60 } })),
        ],
      },
      {
        id: 'lane-2',
        paths: ['web/b'],
        status: 'done',
        sessionId: 's2',
        bootMs: 300,
        tasks: [
          task('b1', run({ durationMs: 800, usage: usage(400, 40, 4_000), metrics: { modelCalls: 1, maxContextTokens: 4_400, modelMs: 200, toolMs: 30, gateMs: 70 } })),
        ],
      },
    ],
    integration: {
      sessionId: 's3',
      status: 'done',
      files: [],
      deleted: [],
      bootMs: 200,
      run: run({ durationMs: 700, usage: usage(500, 50), metrics: { modelCalls: 1, maxContextTokens: 500, modelMs: 250, toolMs: 40, gateMs: 80 } }),
    },
  };
}

describe('summarizeTaskPlan', () => {
  it('계획 호출·모든 실행을 합쳐 지표를 내고 입력을 바꾸지 않는다', () => {
    const plan = basePlan();
    const before = structuredClone(plan);

    const summary = summarizeTaskPlan(plan);

    expect(plan).toEqual(before);
    // usage: 계획(100,10,1000,5) + a1(200,20,2000) + a2(300,30,3000) + b1(400,40,4000) + 통합(500,50)
    expect(summary.usage).toEqual({ inputTokens: 1_500, outputTokens: 150, cacheReadTokens: 10_000, cacheWriteTokens: 5 });
    // 계획 호출 1회 + 레인 작업 실행 2·3·1회. 통합(스크립트 턴)의 modelCalls 1은 세지 않는다
    expect(summary.modelCalls).toBe(7);
    // 계획 호출의 입력 크기 1105, 레인 실행들의 최댓값 4400. 통합의 500은 세지 않는다
    expect(summary.maxContextTokens).toBe(4_400);
    expect(summary.bootMsTotal).toBe(600);
    expect(summary.bootMsMax).toBe(300);
    // 레인 실행 modelMs 100+150+200. 통합의 250은 세지 않는다
    expect(summary.modelMs).toBe(450);
    // toolMs·gateMs는 통합도 더한다: 10+20+30+40, 50+60+70+80
    expect(summary.toolMs).toBe(100);
    expect(summary.gateMs).toBe(260);
    expect(summary.integrationMs).toBe(700);
    expect(summary.sessions).toBe(3);
    expect(summary.endToEndMs).toBe(30_000);
  });

  it('통합 실행에 모델 호출 지표가 있어도 합계의 모델 호출로 세지 않는다', () => {
    const base = basePlan();
    const plan: TaskPlanView = {
      ...base,
      lanes: base.lanes.map((lane) => ({ ...lane, tasks: lane.tasks.map((task) => ({ ...task, run: undefined })) })),
      planning: undefined,
    };

    // 통합에만 modelCalls가 있는 계획: 모델 호출 합계는 0이어야 한다
    const summary = summarizeTaskPlan(plan);

    expect(plan.integration?.run?.metrics?.modelCalls).toBe(1);
    expect(summary.modelCalls).toBe(0);
    expect(summary.modelMs).toBe(0);
    expect(summary.maxContextTokens).toBe(0);
    // 통합의 usage·toolMs·gateMs는 그대로 더한다
    expect(summary.usage).toEqual(usage(500, 50));
    expect(summary.toolMs).toBe(40);
    expect(summary.gateMs).toBe(80);
  });

  it('지표가 없는 실행은 usage만 더하고, 승인 전 계획은 endToEndMs가 없다', () => {
    const plan: TaskPlanView = {
      ...basePlan(),
      approvedAt: undefined,
      finishedAt: undefined,
      planning: undefined,
      integration: undefined,
      lanes: [{ id: 'lane-1', paths: ['web/a'], status: 'done', sessionId: 's1', tasks: [task('a1', run({ durationMs: 100, usage: usage(50, 5) }))] }],
    };

    const summary = summarizeTaskPlan(plan);

    expect(summary.usage).toEqual(usage(50, 5));
    expect(summary.modelCalls).toBe(0);
    expect(summary.maxContextTokens).toBe(0);
    expect(summary.modelMs).toBe(0);
    expect(summary.toolMs).toBe(0);
    expect(summary.gateMs).toBe(0);
    expect(summary.bootMsTotal).toBe(0);
    expect(summary.sessions).toBe(1);
    expect(summary.endToEndMs).toBeUndefined();
  });
});
