/**
 * AI별 결과표(#821): 세션 기록에서 만들기 요청을 백엔드 × 시작 모델 × 작업 종류로 묶어 게이트가 판정한 결과를 센다.
 *
 * 프로젝트 토큰 보고서와 같이 읽는 쪽은 얇게 두고(listSessions·sessionHistory), 계산은 순수 함수(buildRoutingStats)가 한다.
 * 판정은 기록에 남은 사실로만 한다.
 *  - 통과: 실행이 done으로 끝났고 그 실행의 체크포인트가 있다.
 *  - 바꾼 것 없음: done인데 체크포인트가 없다. 판정할 변경이 없으므로 통과율에 넣지 않는다.
 *  - 플랫폼 실패: failed인데 마지막 검증 결과에 platformFailure가 있다(#599), 또는 실행 끝(run_finished)에 실렸다(#943, 샌드박스를 켜지 못함). AI의 성적에 넣지 않는다.
 *  - 실패: 그 밖의 failed. 오류: error.
 *  - 질문(intent ask)과 취소·되묻기·진행 중인 실행은 표에 넣지 않고 수만 알린다.
 *
 * 모델별 묶음(byModel, #1439)은 같은 실행을 백엔드 × 모델 × 노력으로 다시 묶는다. 모델은 run_started의 것, 없으면 실행 끝(run_finished.model,
 * 터미널 CLI가 알린 값), 없으면 "(모름)"이다. 이 줄에서는 모델 사용량(usageByModel)으로 모델을 짐작하지 않는다 — 서브에이전트가 쓴 모델이 섞인다.
 * 노력은 그 실행의 session 이벤트에서 읽고, 알리지 않았으면 없다. 읽기만 하는 집계라 판정·게이트는 바뀌지 않는다.
 */
import type { AgentUsage } from '@b-studio/agent';
import { UNKNOWN_KIND, UNKNOWN_MODEL_LABEL, type RoutingAccountRow, type RoutingFailure, type RoutingModelRow, type RoutingStats, type RoutingStatsRow, type TaskKindKey } from '../routing-types';
import type { StudioEvent } from '../studio-events';
import { listSessions, sessionHistory } from './sessions';
import { buildTokenReports, tokenPricing, type TokenPricing } from './token-report';

export interface RoutingSessionEvents {
  sessionId: string;
  /** 세션의 백엔드. 실행 기록에 백엔드가 없는 옛 기록은 이 값으로 본다 */
  backend: string;
  /** 세션이 쓴 AI 계정(#885). 없으면 그 CLI의 기본 계정이다 */
  accountId?: string;
  events: readonly StudioEvent[];
}

type Outcome = 'passed' | 'failed' | 'errors' | 'platformFailures' | 'noChange' | 'needsReview';

interface DraftRun {
  backend: string;
  model?: string;
  kind: TaskKindKey;
  ask: boolean;
  request: string;
  at?: string;
  tokens?: number;
  status?: Extract<StudioEvent, { type: 'run_finished' }>['status'];
  checkpointed: boolean;
  platformFailure: boolean;
  /** 에이전트가 요청과 확인의 어긋남을 알렸다(#666) */
  mismatch: boolean;
  durationMs?: number;
  usageByModel?: Record<string, AgentUsage>;
  /** 실행 끝에 CLI가 알린 모델(#1439) */
  finishedModel?: string;
  effort?: string;
  /** 게이트가 실패한 회차 수(플랫폼 쪽 실패는 세지 않는다) */
  gateFailures: number;
  /** 변경이 되돌려졌다 */
  reverted: boolean;
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
        request: event.request,
        ...(event.at ? { at: event.at } : {}),
        checkpointed: false,
        platformFailure: false,
        mismatch: false,
        gateFailures: 0,
        reverted: false,
      });
      continue;
    }
    if (!('runId' in event) || typeof event.runId !== 'string') continue;
    const run = runs.get(event.runId);
    if (!run) continue;
    if (event.type === 'run_finished') {
      run.status = event.status;
      run.mismatch = Boolean(event.mismatches?.length);
      // 실행 끝에 실린 플랫폼 실패(#943, 검증 전에 샌드박스를 켜지 못함)도 같다
      if (event.platformFailure) run.platformFailure = true;
      if (event.durationMs !== undefined) run.durationMs = event.durationMs;
      if (event.usage) run.tokens = event.usage.inputTokens + event.usage.outputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens;
      if (event.metrics?.usageByModel) run.usageByModel = event.metrics.usageByModel;
      if (event.model) run.finishedModel = event.model;
    } else if (event.type === 'checkpoint') {
      run.checkpointed = true;
    } else if (event.type === 'reverted') {
      run.reverted = true;
    } else if (event.type === 'agent' && event.event.type === 'session') {
      if (event.event.effort) run.effort = event.event.effort;
    } else if (event.type === 'agent' && event.event.type === 'verify_result') {
      // 마지막 회차의 판정이 실행의 결과다. 앞 회차의 플랫폼 실패를 뒤 회차가 고쳤으면 지운다
      run.platformFailure = !event.event.report.ok && Boolean(event.event.report.platformFailure);
      // 플랫폼 쪽 문제로 판정하지 못한 회차는 에이전트의 재시도가 아니다
      if (!event.event.report.ok && !event.event.report.platformFailure) run.gateFailures += 1;
    }
  }
  return runs;
}

function outcomeOf(run: DraftRun): Outcome | undefined {
  // 어긋남을 알린 통과는 맞았는지 사람이 봐야 한다. 통과로 세면 틀린 쪽을 고른 실행이 그 AI의 통과율을 올린다(ADR-182)
  if (run.status === 'done') return run.checkpointed ? (run.mismatch ? 'needsReview' : 'passed') : 'noChange';
  if (run.status === 'failed') return run.platformFailure ? 'platformFailures' : 'failed';
  if (run.status === 'error') return run.platformFailure ? 'platformFailures' : 'errors';
  return undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 기록 화면에 보일 최근 실패 수 */
const RECENT_FAILURES = 5;

function kindKey(kind: TaskKindKey): string {
  return kind === UNKNOWN_KIND ? UNKNOWN_KIND : `${kind.complexity}/${kind.risk}`;
}

export function buildRoutingStats(input: { sessions: readonly RoutingSessionEvents[]; pricing?: TokenPricing }): RoutingStats {
  const rows = new Map<string, RoutingStatsRow & { costs: number[]; durations: number[] }>();
  const excluded = { asks: 0, unfinished: 0 };
  const accounts = new Map<string, RoutingAccountRow & { tokens: number[]; costs: number[] }>();
  const failures: RoutingFailure[] = [];
  const models = new Map<string, RoutingModelRow>();

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

      const modelName = run.model ?? run.finishedModel ?? UNKNOWN_MODEL_LABEL;
      const modelKey = `${run.backend}\u0000${modelName}\u0000${run.effort ?? ''}`;
      let modelRow = models.get(modelKey);
      if (!modelRow) {
        modelRow = { backend: run.backend, model: modelName, ...(run.effort ? { effort: run.effort } : {}), runs: 0, oneShot: 0, passed: 0, failed: 0, reverted: 0, judged: 0, retries: 0 };
        models.set(modelKey, modelRow);
      }
      modelRow.runs += 1;
      if (outcome === 'passed') {
        modelRow.passed += 1;
        if (run.gateFailures === 0 && !run.reverted) modelRow.oneShot += 1;
      }
      if (outcome === 'failed' || outcome === 'errors') modelRow.failed += 1;
      if (run.reverted) modelRow.reverted += 1;
      // 게이트를 거친 실행만 평균 재시도의 분모에 넣는다(바꾼 것 없음·플랫폼 실패는 재시도를 말하지 않는다)
      if (outcome === 'passed' || outcome === 'failed' || outcome === 'errors' || outcome === 'needsReview') {
        modelRow.judged += 1;
        modelRow.retries += run.gateFailures;
      }

      const accountKey = `${run.backend}\u0000${session.accountId ?? ''}`;
      let account = accounts.get(accountKey);
      if (!account) {
        account = { backend: run.backend, ...(session.accountId ? { accountId: session.accountId } : {}), runs: 0, passed: 0, failed: 0, errors: 0, tokens: [], costs: [] };
        accounts.set(accountKey, account);
      }
      account.runs += 1;
      if (outcome === 'passed' || outcome === 'failed' || outcome === 'errors') account[outcome] += 1;
      if (run.tokens !== undefined) account.tokens.push(run.tokens);
      if (cost !== undefined) account.costs.push(cost);
      if (outcome === 'failed' || outcome === 'errors') {
        failures.push({ sessionId: session.sessionId, backend: run.backend, ...(session.accountId ? { accountId: session.accountId } : {}), request: run.request, ...(run.at ? { at: run.at } : {}), outcome });
      }
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
    byModel: [...models.values()]
      .map((row): RoutingModelRow => (row.judged > 0 ? { ...row, averageRetries: row.retries / row.judged } : row))
      .sort((a, b) => b.runs - a.runs || a.backend.localeCompare(b.backend) || a.model.localeCompare(b.model) || (a.effort ?? '').localeCompare(b.effort ?? '')),
    byAccount: [...accounts.values()]
      .map(({ tokens, costs, ...row }): RoutingAccountRow => {
        const judged = row.passed + row.failed + row.errors;
        return {
          ...row,
          ...(judged > 0 ? { passRate: row.passed / judged } : {}),
          ...(tokens.length ? { averageTokens: Math.round(average(tokens)) } : {}),
          ...(costs.length ? { averageCostUsd: average(costs) } : {}),
        };
      })
      .sort((a, b) => b.runs - a.runs || a.backend.localeCompare(b.backend) || (a.accountId ?? '').localeCompare(b.accountId ?? '')),
    // 시각을 모르는 옛 기록은 뒤로 보낸다
    recentFailures: failures.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, RECENT_FAILURES),
  };
}

/** 얇은 읽기: 모든 세션(projectId를 주면 그 프로젝트만)의 기록으로 결과표를 만든다. 세션 기록을 바꾸지 않는다 */
export async function routingStats(options: { projectId?: string } = {}): Promise<RoutingStats> {
  const sessions = (await listSessions()).filter((session) => !options.projectId || session.projectId === options.projectId);
  return buildRoutingStats({
    sessions: sessions.map((session) => ({ sessionId: session.id, backend: session.backend ?? session.mode, ...(session.accountId ? { accountId: session.accountId } : {}), events: sessionHistory(session.id) })),
    pricing: tokenPricing(process.env),
  });
}
