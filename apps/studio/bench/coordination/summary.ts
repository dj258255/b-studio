/**
 * JSONL 한 줄(BenchRow)을 요약표(마크다운)로 바꾼다.
 *
 * 반복이 적어 비율을 쓰지 않고 건수로 적는다. 중앙값은 값이 있는 실행만으로 계산하고, 값이 하나도 없으면 '—'로 둔다.
 */
import type { TaskPlanCoordinationMetrics, TaskPlanMetrics } from '../../lib/task-plan-metrics';
import type { TaskPlanRunMetricsView } from '../../lib/task-plan-types';
import type { AcceptanceResult } from './acceptance';
import type { BenchVerify } from './backends';
import type { FailureCategory } from './classify';
import type { Strategy } from './tasks';
import type { LaneTrace } from './trace';
import type { TurnRecord } from './turns';

export interface BenchLaneRow {
  id: string;
  /** 레인 세션 id. 세션을 만들기 전에 실패하면 없다 */
  sessionId?: string;
  /** 레인 그룹(첫 쓰기 경로). 백엔드 요약에 쓴다 */
  group?: string;
  /** 이 레인이 고른 백엔드·모델(--lane-backend). 없으면 계획 기본(서버 모드) */
  backend?: string;
  model?: string;
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
  /** S4: 통합 게이트가 실패해 모델 수리를 요청했는지와 그 결과. 요청하지 않았으면 없다 */
  repair?: { attempted: boolean; status: string };
}

/** 한 실행의 승격 결과. 승격을 설정하지 않은 실행은 to가 없다 */
export interface BenchEscalation {
  /** --escalate-to. 없으면 승격을 설정하지 않은 실행 */
  to?: string;
  /** --escalate-after */
  after: number;
  /** --escalate-after-failures. 서명과 무관하게 실패 N번이면 올리는 규칙(설정하지 않으면 없다) */
  afterFailures?: number;
  /** --escalate-retry-budget. 승격 뒤 새로 주는 게이트 재시도 횟수(기본 2) */
  retryBudget: number;
  /** 이 실행에서 한 번이라도 승격이 일어났는지 */
  escalated: boolean;
  /** 승격이 일어난 뒤의 게이트 시도(실패) 횟수 */
  attempt?: number;
}

export interface BenchProxyStats {
  forwardedCalls: number;
  requestBytes: number;
  responseBytes: number;
  plannerCalls: number;
  upstreamErrors: number;
}

/** S2에서 쓴 계약. human=과제 정의에 사람이 써 둔 것, model=계획 모델이 쓴 것 */
export interface BenchContractsRow {
  source: 'human' | 'model';
  count: number;
  /** 계약 호출의 usage(모델 계약만). 사람 계약은 호출이 없어 없다 */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  durationMs?: number;
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
  /** P0(그냥 Claude Code)의 모델 호출별 기록. b-studio 전략은 traces[].turns에 있다 */
  plainTurns?: TurnRecord[];
  /** 레인 합계만 센 탐색량 */
  explore: { filesReadTotal: number; filesReadUnionAcrossLanes: number; readCallsTotal: number };
  /** 검증기가 낸 실패 서명 합계 */
  failures: { signaturesTotal: number; distinctSignatures: number; repeatedFailures: number };
  /** 오래된 도구 결과를 묶어서 비운 합계(레인·통합). 비우기를 끄면 0 */
  contextCleared: { count: number; chars: number };
  /** 통합 게이트에 api 값 확인을 덧붙였는지(--integration-checks). 기본 꺼짐이면 false */
  integrationChecks: boolean;
  /** 검증 범위(--verify). full은 지금과 같고, light는 레인·통합 게이트가 재시작·준비·계약만 확인한다 */
  verify: BenchVerify;
  /** 모델 승격 설정과 이 실행의 승격 결과 */
  escalation: BenchEscalation;
  metrics?: TaskPlanMetrics;
  /** S2에서 쓴 계약의 출처와 수(모델 계약이면 호출 usage). 계약을 쓰지 않는 전략이면 없다 */
  contracts?: BenchContractsRow;
  /** S2~S5의 게시판 지표. 공유 없음(S0·S1)이면 없다 */
  coordination?: TaskPlanCoordinationMetrics;
  acceptance?: AcceptanceResult[];
  success: boolean;
  category: FailureCategory;
  detail: string;
  /** 프록시를 쓰지 않는 백엔드(claude-code)에서는 없다 */
  proxy?: BenchProxyStats;
  leftoverContainers: string[];
  estimatedCostUsd: number;
  /** --prices가 있으면 모델별 사용량으로 계산한 API 환산 비용(달러). 단가가 없는 모델이 하나라도 있으면 없다 */
  costUsd?: number;
  /** costUsd를 쓰지 못한 사유(단가 없는 모델 등) */
  costNote?: string;
}

export interface SummaryMeta {
  backend: string;
  requestedModel: string;
  /** 오래된 도구 결과 비우기를 켰는지. 기본 off(ADR-055 보강) */
  contextClearing?: boolean;
  /** 레인 사이 계약(S2)의 출처. 기본 human */
  contracts?: 'human' | 'model';
  /** 검증 범위(--verify). 기본 full */
  verify?: BenchVerify;
}

const CATEGORIES: FailureCategory[] = ['none', 'plan_rejected', 'scope_violation', 'lane_gate', 'integration_gate', 'acceptance', 'rate_limited', 'provider_gate', 'environment', 'timeout', 'unknown'];

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
    '성공 1건당 토큰',
    '종단 시간 중앙값(s)',
    '입력 토큰 중앙값',
    '출력 토큰 중앙값',
    '모델 호출 중앙값',
    '최대 컨텍스트 중앙값',
    '기동 시간 합 중앙값(s)',
    '기동 수신(중앙값)',
    '읽은 파일 수 중앙값',
    '실패 서명 중앙값',
    '반복 실패 중앙값',
    '게시·읽기 바이트 중앙값',
    '비운 도구 결과 중앙값',
    '승격 건수',
    '수리(시도/성공)',
    'API 환산 비용($)',
    '레인 백엔드',
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
        tokensPerSuccess(group),
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
        bytes(medianValue(group, (row) => row.metrics?.bootRxBytesTotal)),
        '|',
        count(medianValue(group, (row) => withLaneSessions(row, row.explore.filesReadTotal))),
        '|',
        count(medianValue(group, (row) => withLaneSessions(row, row.failures.signaturesTotal))),
        '|',
        count(medianValue(group, (row) => withLaneSessions(row, row.failures.repeatedFailures))),
        '|',
        count(medianValue(group, (row) => row.coordination?.bytesRead)),
        '|',
        count(medianValue(group, (row) => withLaneSessions(row, row.contextCleared.count))),
        '|',
        String(group.filter((row) => row.escalation.escalated).length),
        '|',
        repairCell(group),
        '|',
        costCell(group),
        '|',
        laneBackendLabel(head),
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
    `백엔드 ${meta.backend} · 요청한 모델 ${meta.requestedModel} · 관측한 모델 ${observed.length > 0 ? observed.join(', ') : '없음'} · 실행 ${rows.length}회 · 검증 ${meta.verify === 'light' ? 'light(가볍게)' : 'full'} · 컨텍스트 비우기 ${meta.contextClearing ? 'on' : 'off'} · 계약 ${meta.contracts ?? 'human'}`,
    '',
    '## 과제 × 전략',
    '',
    ...taskTable,
    '',
    '## 전략별 실패 원인',
    '',
    ...failureTable,
    '',
    ...(meta.backend !== 'openai'
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

/** 레인별 백엔드 요약(예: `api:claude-code web:commandcode`). 고른 레인이 없으면 '—' */
function laneBackendLabel(row: BenchRow): string {
  const parts = row.lanes.filter((lane) => lane.backend).map((lane) => `${lane.group ?? lane.id}:${lane.backend}${lane.model ? `:${lane.model}` : ''}`);
  return parts.length > 0 ? parts.join(' ') : '—';
}

/** 그룹의 API 환산 비용을 "합계 / 중앙값"(달러)으로 적는다. costUsd가 있는 실행이 없으면 — */
function costCell(rows: BenchRow[]): string {
  const values = rows.map((row) => row.costUsd).filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return '—';
  const sum = values.reduce((total, value) => total + value, 0);
  return `${sum.toFixed(4)} / ${medianOf(values).toFixed(4)}`;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianValue(rows: BenchRow[], pick: (row: BenchRow) => number | undefined): number | undefined {
  const values = rows.map(pick).filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * 성공 1건당 토큰 = (입력 + 캐시읽기 + 캐시쓰기 + 출력) 합 ÷ 성공 수. 성공이 없으면 '—'.
 * 실패한 실행이 쓴 토큰도 분자에 넣는다 — 같은 성과를 내는 데 실제로 쓴 총량을 본다.
 * **계약 호출 토큰도 넣는다**(빼면 모델 계약이 공짜처럼 보인다). 벤치가 직접 부른 계약(--contracts model)은
 * 스튜디오 지표에 없어 `row.contracts.usage`로 더하고, 제품 경로에서 계획 모델이 쓴 계약은 이미
 * `metrics.usage`에 들어 있어 겹치지 않는다.
 */
function tokensPerSuccess(group: BenchRow[]): string {
  const ok = group.filter((row) => row.success).length;
  if (ok === 0) return '—';
  // 지표가 있는 실행만 더한다. 하나도 없으면 다른 열처럼 '—'다
  const withMetrics = group.filter((row) => row.metrics);
  if (withMetrics.length === 0) return '—';
  const total = group.reduce((sum, row) => sum + usageTokens(row.metrics?.usage) + usageTokens(row.contracts?.usage), 0);
  return count(total / ok);
}

function usageTokens(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

function count(value: number | undefined): string {
  return value === undefined ? '—' : Math.round(value).toLocaleString('ko-KR');
}

function seconds(milliseconds: number | undefined): string {
  return milliseconds === undefined ? '—' : (milliseconds / 1_000).toFixed(1);
}

/** 기동 수신 바이트를 사람이 읽는 크기로. 중앙값이라 소수 한 자리까지 둔다 */
function bytes(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1_024 ** 2) return `${(value / 1_024 ** 2).toFixed(1)}MiB`;
  return `${Math.round(value / 1_024)}KiB`;
}

/** S4 수리 칸: 수리를 요청한 실행 수 / 그중 수리 실행이 done으로 끝난 수. 수리가 없는 전략은 0/0 */
function repairCell(group: readonly BenchRow[]): string {
  const attempted = group.filter((row) => row.integration?.repair?.attempted);
  const repaired = attempted.filter((row) => row.integration?.repair?.status === 'done');
  return `${attempted.length}/${repaired.length}`;
}
