/**
 * JSONL 한 줄(BenchRow)을 요약표(마크다운)로 바꾼다.
 *
 * 반복이 적어 비율을 쓰지 않고 건수로 적는다. 중앙값은 값이 있는 실행만으로 계산하고, 값이 하나도 없으면 '—'로 둔다.
 */
import type { TaskPlanMetrics } from '../../lib/task-plan-metrics';
import type { TaskPlanRunMetricsView } from '../../lib/task-plan-types';
import type { AcceptanceResult } from './acceptance';
import type { FailureCategory } from './classify';
import type { Strategy } from './tasks';
import type { LaneTrace } from './trace';

export interface BenchLaneRow {
  id: string;
  /** 레인 세션 id. 세션을 만들기 전에 실패하면 없다 */
  sessionId?: string;
  status: string;
  bootMs?: number;
  error?: string;
  tasks: Array<{ id: string; status: string; run?: TaskPlanRunMetricsView }>;
}

export interface BenchIntegrationRow {
  status: string;
  bootMs?: number;
  run?: TaskPlanRunMetricsView;
  error?: string;
}

export interface BenchProxyStats {
  forwardedCalls: number;
  requestBytes: number;
  responseBytes: number;
  plannerCalls: number;
  upstreamErrors: number;
}

export interface BenchRow {
  order: number;
  /** 사용 한도로 다시 시도한 실행이면 원래 실행의 order */
  retryOf?: number;
  repeat: number;
  taskId: string;
  coupled: boolean;
  strategy: Strategy;
  model: string;
  /** 세션 이벤트에서 읽은 실제 모델 이름 (중복 제거) */
  observedModels: string[];
  startedAt: string;
  finishedAt: string;
  planId?: string;
  planStatus: string;
  planError?: string;
  lanes: BenchLaneRow[];
  integration?: BenchIntegrationRow;
  /** 레인 세션 순서대로 모은 탐색·실패 흔적 */
  traces: LaneTrace[];
  /** 통합 세션의 흔적. 탐색 합계에서는 뺀다 */
  integrationTrace?: LaneTrace;
  /** 레인 합계만 센 탐색량 */
  explore: { filesReadTotal: number; filesReadUnionAcrossLanes: number; readCallsTotal: number };
  /** 검증기가 낸 실패 서명 합계 */
  failures: { signaturesTotal: number; distinctSignatures: number; repeatedFailures: number };
  metrics?: TaskPlanMetrics;
  acceptance?: AcceptanceResult[];
  success: boolean;
  category: FailureCategory;
  detail: string;
  /** 프록시를 쓰지 않는 백엔드(claude-code)에서는 없다 */
  proxy?: BenchProxyStats;
  leftoverContainers: string[];
  estimatedCostUsd: number;
}

export interface SummaryMeta {
  backend: string;
  requestedModel: string;
}

const CATEGORIES: FailureCategory[] = ['none', 'plan_rejected', 'scope_violation', 'lane_gate', 'integration_gate', 'acceptance', 'rate_limited', 'environment', 'timeout', 'unknown'];

export function summarize(rows: BenchRow[], meta: SummaryMeta): string {
  const observed = [...new Set(rows.flatMap((row) => row.observedModels))];
  const groups = new Map<string, BenchRow[]>();
  for (const row of rows) {
    const key = `${row.taskId}|${row.strategy}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const taskHeaders = [
    '과제',
    '엮임',
    '전략',
    '성공',
    '종단 시간 중앙값(s)',
    '입력 토큰 중앙값',
    '출력 토큰 중앙값',
    '모델 호출 중앙값',
    '최대 컨텍스트 중앙값',
    '기동 시간 합 중앙값(s)',
    '읽은 파일 수 중앙값',
    '실패 서명 중앙값',
    '반복 실패 중앙값',
  ];
  const taskTable = [`| ${taskHeaders.join(' | ')} |`, `|${taskHeaders.map(() => '---').join('|')}|`];
  for (const group of groups.values()) {
    const head = group[0]!;
    const ok = group.filter((row) => row.success).length;
    taskTable.push(
      [
        '|',
        head.taskId,
        '|',
        head.coupled ? 'O' : 'X',
        '|',
        head.strategy,
        '|',
        `${ok}/${group.length}`,
        '|',
        seconds(medianValue(group, (row) => row.metrics?.endToEndMs)),
        '|',
        count(medianValue(group, (row) => row.metrics?.usage.inputTokens)),
        '|',
        count(medianValue(group, (row) => row.metrics?.usage.outputTokens)),
        '|',
        count(medianValue(group, (row) => row.metrics?.modelCalls)),
        '|',
        count(medianValue(group, (row) => row.metrics?.maxContextTokens)),
        '|',
        seconds(medianValue(group, (row) => row.metrics?.bootMsTotal)),
        '|',
        count(medianValue(group, (row) => withLaneSessions(row, row.explore.filesReadTotal))),
        '|',
        count(medianValue(group, (row) => withLaneSessions(row, row.failures.signaturesTotal))),
        '|',
        count(medianValue(group, (row) => withLaneSessions(row, row.failures.repeatedFailures))),
        '|',
      ].join(' '),
    );
  }

  const strategies = [...new Set(rows.map((row) => row.strategy))];
  const failureTable = [`| 전략 | ${CATEGORIES.join(' | ')} |`, `|---|${CATEGORIES.map(() => '---').join('|')}|`];
  for (const strategy of strategies) {
    const of = rows.filter((row) => row.strategy === strategy);
    failureTable.push(`| ${strategy} | ${CATEGORIES.map((category) => of.filter((row) => row.category === category).length).join(' | ')} |`);
  }

  return [
    '# 협업 벤치마크 요약',
    '',
    `백엔드 ${meta.backend} · 요청한 모델 ${meta.requestedModel} · 관측한 모델 ${observed.length > 0 ? observed.join(', ') : '없음'} · 실행 ${rows.length}회`,
    '',
    '## 과제 × 전략',
    '',
    ...taskTable,
    '',
    '## 전략별 실패 원인',
    '',
    ...failureTable,
    '',
    ...(meta.backend === 'claude-code'
      ? ['로컬 CLI 러너는 모델 응답 대기 시간을 재지 못해 `modelMs`가 0입니다. 비용은 청구가 없고, 단가를 주면 API 단가 환산 추정치만 계산합니다.', '']
      : []),
    '반복 수가 적어 비율 대신 건수로 적습니다. 이 결과는 이 저장소·이 모델·이 과제에 한정됩니다.',
    '',
  ].join('\n');
}

/**
 * 탐색·실패 열은 레인 세션을 하나라도 만든 실행만 센다. 세션을 만들기 전에 실패한 실행은
 * 탐색도 실패 서명도 없어서 0으로 섞이면 중앙값을 낮춘다.
 */
function withLaneSessions(row: BenchRow, value: number): number | undefined {
  return row.lanes.some((lane) => lane.sessionId) ? value : undefined;
}

function medianValue(rows: BenchRow[], pick: (row: BenchRow) => number | undefined): number | undefined {
  const values = rows.map(pick).filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function count(value: number | undefined): string {
  return value === undefined ? '—' : Math.round(value).toLocaleString('ko-KR');
}

function seconds(milliseconds: number | undefined): string {
  return milliseconds === undefined ? '—' : (milliseconds / 1_000).toFixed(1);
}
