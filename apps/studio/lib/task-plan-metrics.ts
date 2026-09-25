import type { AgentUsage } from '@b-studio/agent';
import type { TaskPlanView } from './task-plan-types';

/**
 * 작업 계획 전체의 실행 지표. 전략을 비교하려면 실행마다 "모델을 몇 번 불렀고,
 * 한 번에 얼마나 큰 입력을 보냈고, 시간이 어디(샌드박스 기동 / 모델 / 도구 / 게이트)에 쓰였는지"가 남아야 한다.
 * 기록만 더한다. 값이 없는 실행(로컬 Claude Code 등)은 usage만 더하고 호출 수·시간은 0으로 둔다.
 */
export interface TaskPlanMetrics {
  /** 승인 시각부터 끝난 시각까지. 승인 전이거나 끝나지 않았으면 없음 */
  endToEndMs?: number;
  /** 계획 호출 + 모든 작업 실행 + 통합 실행의 합 */
  usage: AgentUsage;
  /** 계획 호출 1회를 포함한 모델 호출 수 */
  modelCalls: number;
  /** 모든 실행 중 한 호출의 최대 입력 크기 (계획 호출은 input+cacheRead+cacheWrite로 계산해 포함) */
  maxContextTokens: number;
  /** 레인 + 통합 기동 시간 합 */
  bootMsTotal: number;
  /** 레인 + 통합 기동 시간 중 최댓값 */
  bootMsMax: number;
  /** 모든 실행의 모델 호출 시간 합 */
  modelMs: number;
  /** 모든 실행의 도구 실행 시간 합 */
  toolMs: number;
  /** 모든 실행의 게이트 실행 시간 합 */
  gateMs: number;
  /** 통합 실행의 걸린 시간 (통합 run.durationMs) */
  integrationMs?: number;
  /** 만든 세션 수 (sessionId가 있는 레인 + 통합) */
  sessions: number;
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 계획 호출 한 번이 모델에 보낸 입력 크기. input_tokens는 캐시 분을 빼고 세므로 캐시를 더한다 */
function contextOf(usage: AgentUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** 계획 하나의 지표를 합계로 낸다. 입력을 바꾸지 않는다 */
export function summarizeTaskPlan(plan: TaskPlanView): TaskPlanMetrics {
  const usage = emptyUsage();
  let modelCalls = 0;
  let maxContextTokens = 0;
  let modelMs = 0;
  let toolMs = 0;
  let gateMs = 0;

  const addUsage = (value: AgentUsage | undefined): void => {
    if (!value) return;
    usage.inputTokens += value.inputTokens;
    usage.outputTokens += value.outputTokens;
    usage.cacheReadTokens += value.cacheReadTokens;
    usage.cacheWriteTokens += value.cacheWriteTokens;
  };
  const addRun = (
    run: { usage?: AgentUsage; metrics?: { modelCalls: number; maxContextTokens: number; modelMs: number; toolMs: number; gateMs: number } } | undefined,
    countModel = true,
  ): void => {
    if (!run) return;
    addUsage(run.usage);
    if (!run.metrics) return;
    toolMs += run.metrics.toolMs;
    gateMs += run.metrics.gateMs;
    if (!countModel) return;
    modelCalls += run.metrics.modelCalls;
    maxContextTokens = Math.max(maxContextTokens, run.metrics.maxContextTokens);
    modelMs += run.metrics.modelMs;
  };

  // 계획 호출은 실행 기록이 없으므로 호출 수 1과 입력 크기를 직접 더한다
  if (plan.planning) {
    addUsage(plan.planning.usage);
    modelCalls += 1;
    maxContextTokens = Math.max(maxContextTokens, contextOf(plan.planning.usage));
  }

  for (const lane of plan.lanes) for (const task of lane.tasks) addRun(task.run);
  // 통합은 모델 없이 레인 결과를 다시 적용하는 스크립트 턴이라 모델 호출로 세지 않는다
  addRun(plan.integration?.run, false);

  const boots = [...plan.lanes.map((lane) => lane.bootMs ?? 0), plan.integration?.bootMs ?? 0];
  const bootMsTotal = boots.reduce((sum, value) => sum + value, 0);
  const bootMsMax = boots.reduce((max, value) => Math.max(max, value), 0);

  const sessions = plan.lanes.filter((lane) => Boolean(lane.sessionId)).length + (plan.integration?.sessionId ? 1 : 0);

  const endToEndMs =
    plan.approvedAt && plan.finishedAt ? Math.round(Date.parse(plan.finishedAt) - Date.parse(plan.approvedAt)) : undefined;

  return {
    endToEndMs,
    usage,
    modelCalls,
    maxContextTokens,
    bootMsTotal,
    bootMsMax,
    modelMs,
    toolMs,
    gateMs,
    integrationMs: plan.integration?.run?.durationMs,
    sessions,
  };
}
