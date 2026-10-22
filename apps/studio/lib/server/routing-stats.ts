/**
 * AI별 결과표(#821): 세션 기록에서 만들기 요청을 백엔드 × 시작 모델 × 작업 종류로 묶어 게이트가 판정한 결과를 센다.
 *
 * 프로젝트 토큰 보고서와 같이 읽는 쪽은 얇게 두고(listSessions·sessionHistory), 계산은 순수 함수(buildRoutingStats)가 한다.
 * 판정은 기록에 남은 사실로만 한다.
 *  - 통과: 실행이 done으로 끝났고 그 실행의 체크포인트가 있다.
 *  - 바꾼 것 없음: done인데 체크포인트가 없다. 판정할 변경이 없으므로 통과율에 넣지 않는다.
 *  - 플랫폼 실패: failed인데 마지막 검증 결과에 platformFailure가 있다(#599). AI의 성적에 넣지 않는다.
 *  - 실패: 그 밖의 failed. 오류: error.
 *  - 질문(intent ask)과 취소·되묻기·진행 중인 실행은 표에 넣지 않고 수만 알린다.
 */
import type { AgentUsage } from '@b-studio/agent';
import { UNKNOWN_KIND, UNKNOWN_MODEL_LABEL, type RoutingStats, type RoutingStatsRow, type TaskKindKey } from '../routing-types';
import type { StudioEvent } from '../studio-events';
import { listSessions, sessionHistory } from './sessions';
import { buildTokenReports, tokenPricing, type TokenPricing } from './token-report';

export interface RoutingSessionEvents {
  sessionId: string;
  /** 세션의 백엔드. 실행 기록에 백엔드가 없는 옛 기록은 이 값으로 본다 */
  backend: string;
  events: readonly StudioEvent[];
}

type Outcome = 'passed' | 'failed' | 'errors' | 'platformFailures' | 'noChange' | 'needsReview';

interface DraftRun {
  backend: string;
  model?: string;
  kind: TaskKindKey;
  ask: boolean;
  status?: Extract<StudioEvent, { type: 'run_finished' }>['status'];
  checkpointed: boolean;
  platformFailure: boolean;
  /** 에이전트가 요청과 확인의 어긋남을 알렸다(#666) */
  mismatch: boolean;
  durationMs?: number;
  usageByModel?: Record<string, AgentUsage>;
}

/** 계획 호출("계획: <모델>")을 뺀 모델별 사용량에서 가장 많이 쓴 모델. 옛 기록의 시작 모델을 대신한다 */
function largestModel(usageByModel: Record<string, AgentUsage> | undefined): string | undefined {
  let best: { model: string; total: number } | undefined;
  for (const [model, usage] of Object.entries(usageByModel ?? {})) {
    if (model.startsWith('계획: ')) continue;
    const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (!best || total > best.total) best = { model, total };
  }
  return best?.model;
}

function collectRuns(session: RoutingSessionEvents): Map<string, DraftRun> {
  const runs = new Map<string, DraftRun>();
  for (const event of session.events) {
    if (event.type === 'run_started') {
      runs.set(event.runId, {
        backend: event.backend ?? session.backend,
        ...(event.model ? { model: event.model } : {}),
        kind: event.taskKind ?? UNKNOWN_KIND,
        ask: event.intent === 'ask',
        checkpointed: false,
        platformFailure: false,
        mismatch: false,
      });
      continue;
    }
    if (!('runId' in event) || typeof event.runId !== 'string') continue;
    const run = runs.get(event.runId);
    if (!run) continue;
    if (event.type === 'run_finished') {
      run.status = event.status;
      run.mismatch = Boolean(event.mismatches?.length);
      if (event.durationMs !== undefined) run.durationMs = event.durationMs;
      if (event.metrics?.usageByModel) run.usageByModel = event.metrics.usageByModel;
    } else if (event.type === 'checkpoint') {
      run.checkpointed = true;
    } else if (event.type === 'agent' && event.event.type === 'verify_result') {
      // 마지막 회차의 판정이 실행의 결과다. 앞 회차의 플랫폼 실패를 뒤 회차가 고쳤으면 지운다
      run.platformFailure = !event.event.report.ok && Boolean(event.event.report.platformFailure);
    }
  }
  return runs;
}

function outcomeOf(run: DraftRun): Outcome | undefined {
  // 어긋남을 알린 통과는 맞았는지 사람이 봐야 한다. 통과로 세면 틀린 쪽을 고른 실행이 그 AI의 통과율을 올린다(ADR-182)
  if (run.status === 'done') return run.checkpointed ? (run.mismatch ? 'needsReview' : 'passed') : 'noChange';
  if (run.status === 'failed') return run.platformFailure ? 'platformFailures' : 'failed';
  if (run.status === 'error') return 'errors';
  return undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function kindKey(kind: TaskKindKey): string {
  return kind === UNKNOWN_KIND ? UNKNOWN_KIND : `${kind.complexity}/${kind.risk}`;
}

export function buildRoutingStats(input: { sessions: readonly RoutingSessionEvents[]; pricing?: TokenPricing }): RoutingStats {
  const rows = new Map<string, RoutingStatsRow & { costs: number[]; durations: number[] }>();
  const excluded = { asks: 0, unfinished: 0 };

  for (const session of input.sessions) {
    const runs = collectRuns(session);
    const costs = new Map(buildTokenReports(session.events, input.pricing ?? {}).map((report) => [report.runId, report.estimatedCostUsd]));
    for (const [runId, run] of runs) {
      if (run.ask) {
        excluded.asks += 1;
        continue;
      }
      const outcome = outcomeOf(run);
      if (!outcome) {
        excluded.unfinished += 1;
        continue;
      }
      const model = run.model ?? largestModel(run.usageByModel) ?? UNKNOWN_MODEL_LABEL;
      const key = `${run.backend}\u0000${model}\u0000${kindKey(run.kind)}`;
      let row = rows.get(key);
      if (!row) {
        row = { backend: run.backend, model, kind: run.kind, runs: 0, passed: 0, failed: 0, errors: 0, platformFailures: 0, noChange: 0, needsReview: 0, costs: [], durations: [] };
        rows.set(key, row);
      }
      row.runs += 1;
      row[outcome] += 1;
      const cost = costs.get(runId);
      if (cost !== undefined) row.costs.push(cost);
      if (run.durationMs !== undefined) row.durations.push(run.durationMs);
    }
  }

  return {
    rows: [...rows.values()]
      .map(({ costs, durations, ...row }): RoutingStatsRow => {
        const judged = row.passed + row.failed + row.errors;
        const cost = median(costs);
        const duration = median(durations);
        return {
          ...row,
          ...(judged > 0 ? { passRate: row.passed / judged } : {}),
          ...(cost === undefined ? {} : { medianCostUsd: cost }),
          ...(duration === undefined ? {} : { medianDurationMs: duration }),
        };
      })
      .sort((a, b) => b.runs - a.runs || a.backend.localeCompare(b.backend) || a.model.localeCompare(b.model)),
    excluded,
  };
}

/** 얇은 읽기: 모든 세션(projectId를 주면 그 프로젝트만)의 기록으로 결과표를 만든다. 세션 기록을 바꾸지 않는다 */
export async function routingStats(options: { projectId?: string } = {}): Promise<RoutingStats> {
  const sessions = (await listSessions()).filter((session) => !options.projectId || session.projectId === options.projectId);
  return buildRoutingStats({
    sessions: sessions.map((session) => ({ sessionId: session.id, backend: session.backend ?? session.mode, events: sessionHistory(session.id) })),
    pricing: tokenPricing(process.env),
  });
}
