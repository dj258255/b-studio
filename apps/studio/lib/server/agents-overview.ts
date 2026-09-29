/**
 * 관제 화면(#101)의 집계.
 *
 * 세션·작업 분해 레인·플릿 구성원을 한 목록으로 모으고, "지금 사람이 봐야 할 것"(개입 필요)을 먼저 세운다.
 * GitHub Copilot Mission Control·VS Code Agent Sessions의 "개입 필요" 인박스처럼, 전체 나열이 아니라 볼 것을 먼저 보여 주는 것이 목적이다.
 *
 * 판정 규칙(state·attention)은 순수 함수로 두고 테스트한다. 수집기는 기존 목록 함수가 돌려주는 것만 쓴다 —
 * 권한 규칙을 새로 만들지 않는다(로그인한 사람이 볼 수 있는 것은 그대로).
 */
import type { AgentEvent, AgentUsage } from '@b-studio/agent';
import type { FleetView } from '@/lib/fleet-types';
import type { SessionMode, SessionSnapshot, StudioEvent } from '@/lib/studio-events';
import type { TaskPlanView } from '@/lib/task-plan-types';
import { listFleets } from './fleets';
import { overviewSessions, sessionBackend } from './sessions';
import { listTaskPlans } from './task-plans';

export type AgentKind = 'session' | 'lane' | 'fleet';
export type AgentState = 'working' | 'idle' | 'booting' | 'stopped' | 'error';
/** 개입이 필요한 이유. 여러 개면 우선순위가 높은 것 하나만 남긴다 */
export type AgentAttention = 'question' | 'approval' | 'gate_failed' | 'error' | 'budget';

/** 개입 필요 우선순위(앞일수록 먼저) */
export const ATTENTION_PRIORITY: readonly AgentAttention[] = ['question', 'approval', 'gate_failed', 'error', 'budget'];
/** 제목은 요청 앞 이 글자 수로 줄인다 */
export const TITLE_CHARS = 80;

export interface AgentItem {
  kind: AgentKind;
  /** 세션 id(레인·플릿은 그 구성원의 세션 id). 계획 승인 대기는 `plan:<id>` */
  id: string;
  title: string;
  projectName: string;
  /** 누르면 이동할 곳(세션 화면·작업 분해 화면) */
  href: string;
  owner?: string;
  state: AgentState;
  attention?: AgentAttention;
  /** 이 항목이 실제로 쓰는 백엔드(레인은 그 레인이 고른 backend). 알 수 없으면 없다 */
  backend?: SessionMode;
  lastActivityAt: string;
  /** 실행 중일 때 요청 시작부터 지난 시간 */
  runningForMs?: number;
  tokens?: AgentUsage;
  /** 실행 중일 때 마지막 에이전트 이벤트 한 줄 */
  activity?: string;
}

export interface AgentTotals {
  total: number;
  attention: number;
  working: number;
  /** 개입 필요·작업 여부와 상관없이 목록에 있는 항목의 세션 토큰 합 */
  tokens: AgentUsage;
}

/** 관제 화면이 쓰는 세션 원자료(수집기 `overviewSessions`가 만든다) */
export interface SessionOverviewSource {
  snapshot: SessionSnapshot;
  /** 마지막 실행 결과·활동을 판단할 최근 이벤트만 */
  recent: readonly StudioEvent[];
  updatedAt: string;
  /** 실행 중이면 요청 시작 시각 */
  runningSince?: string;
  /** 마지막 요청(제목) */
  lastRequest?: string;
}

export interface AgentOverviewInput {
  sessions: readonly SessionOverviewSource[];
  plans: readonly TaskPlanView[];
  fleets: readonly FleetView[];
  /** 진행 시간 계산 기준 시각. 테스트가 고정한다 */
  now?: number;
}

interface AgentRow {
  kind: AgentKind;
  id: string;
  href: string;
  title: string;
  projectName: string;
  owner?: string;
  snapshot?: SessionSnapshot;
  recent?: readonly StudioEvent[];
  updatedAt: string;
  runningSince?: string;
  /** 스냅샷이 없을 때의 상태(레인·플릿 구성원의 세션이 사라졌을 때) */
  fallbackState?: AgentState;
  /** 스냅샷이 없을 때의 개입 사유 */
  fallbackAttention?: AgentAttention;
  /** 계획 승인 대기(세션 밖 사실) */
  approval?: boolean;
  /** 이 항목이 쓰는 백엔드 */
  backend?: SessionMode;
  /** 스냅샷이 없을 때의 토큰 */
  tokens?: AgentUsage;
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * 세션·레인·플릿을 한 목록으로 모은다. 같은 세션이 레인·플릿에 속하면 그 종류로 한 번만 올린다(중복 방지).
 * 정렬: 개입 필요 먼저, 그다음 작업 중, 그다음 최근 활동 순.
 */
export function buildAgentOverview(input: AgentOverviewInput): { items: AgentItem[]; totals: AgentTotals } {
  const now = input.now ?? Date.now();
  const byId = new Map(input.sessions.map((source) => [source.snapshot.id, source]));
  const consumed = new Set<string>();
  const rows: AgentRow[] = [];

  // 작업 분해: 승인 대기 중이면 레인 세션이 아직 없다. 계획 하나를 항목으로 올려 승인을 기다린다고 알린다
  for (const plan of input.plans) {
    if (plan.status === 'awaiting_approval') {
      rows.push({
        kind: 'lane',
        id: `plan:${plan.id}`,
        href: '/task-plans',
        title: plan.request,
        projectName: plan.projectId,
        owner: plan.owner,
        updatedAt: plan.createdAt,
        approval: true,
        fallbackState: 'idle',
        tokens: plan.planning?.usage,
      });
      continue;
    }
    for (const lane of plan.lanes) {
      if (!lane.sessionId) continue;
      const source = byId.get(lane.sessionId);
      if (source) consumed.add(lane.sessionId);
      rows.push({
        kind: 'lane',
        id: lane.sessionId,
        href: `/sessions/${lane.sessionId}`,
        title: plan.request,
        projectName: plan.projectId,
        owner: plan.owner,
        ...(source
          ? { snapshot: source.snapshot, recent: source.recent, updatedAt: source.updatedAt, ...(source.runningSince ? { runningSince: source.runningSince } : {}) }
          : { updatedAt: lane.finishedAt ?? lane.startedAt ?? plan.createdAt, fallbackState: laneState(lane.status), fallbackAttention: laneAttention(lane) }),
        // 레인은 그 레인이 고른 백엔드(세션이 있으면 스냅샷)를 보여 준다
        backend: source ? sessionBackend(source.snapshot) : lane.backend,
      });
    }
  }

  // 플릿 구성원
  for (const fleet of input.fleets) {
    for (const member of fleet.members) {
      const source = byId.get(member.sessionId);
      if (source) consumed.add(member.sessionId);
      rows.push({
        kind: 'fleet',
        id: member.sessionId,
        href: `/sessions/${member.sessionId}`,
        title: fleet.request,
        projectName: fleet.projectName,
        owner: fleet.owner,
        ...(source
          ? { snapshot: source.snapshot, recent: source.recent, updatedAt: source.updatedAt, ...(source.runningSince ? { runningSince: source.runningSince } : {}) }
          : { updatedAt: member.finishedAt ?? member.startedAt ?? fleet.createdAt, fallbackState: fleetMemberState(member.status), fallbackAttention: fleetMemberAttention(member.status) }),
        backend: source ? sessionBackend(source.snapshot) : undefined,
        tokens: source?.snapshot.tokens ?? member.usage,
      });
    }
  }

  // 나머지 단일 세션
  for (const source of input.sessions) {
    if (consumed.has(source.snapshot.id)) continue;
    rows.push({
      kind: 'session',
      id: source.snapshot.id,
      href: `/sessions/${source.snapshot.id}`,
      title: source.lastRequest?.trim() || source.snapshot.projectName,
      projectName: source.snapshot.projectName,
      owner: source.snapshot.owner,
      snapshot: source.snapshot,
      recent: source.recent,
      updatedAt: source.updatedAt,
      backend: sessionBackend(source.snapshot),
      ...(source.runningSince ? { runningSince: source.runningSince } : {}),
    });
  }

  const items = rows.map((row) => evaluate(row, now)).sort(compareItems);
  return { items, totals: totalsOf(items) };
}

/** 라우트가 쓰는 수집기. 기존 목록 함수가 돌려주는 것만 모은다(권한 규칙을 새로 만들지 않는다) */
export async function listAgentOverview(user: string): Promise<{ items: AgentItem[]; totals: AgentTotals }> {
  const sessions = await overviewSessions();
  return buildAgentOverview({ sessions, plans: listTaskPlans(user), fleets: listFleets(user) });
}

/** 한 항목의 상태·개입 사유·활동을 판정한다 */
function evaluate(row: AgentRow, now: number): AgentItem {
  const state = stateOf(row);
  const attention = attentionOf(row);
  const tokens = row.tokens ?? row.snapshot?.tokens;
  const runningForMs = state === 'working' && row.runningSince ? Math.max(0, now - Date.parse(row.runningSince)) : undefined;
  return {
    kind: row.kind,
    id: row.id,
    title: truncateTitle(row.title),
    projectName: row.projectName,
    href: row.href,
    ...(row.owner ? { owner: row.owner } : {}),
    state,
    ...(attention ? { attention } : {}),
    ...(row.backend ? { backend: row.backend } : {}),
    lastActivityAt: row.updatedAt,
    ...(runningForMs !== undefined ? { runningForMs } : {}),
    ...(tokens ? { tokens } : {}),
    ...(state === 'working' ? { activity: activityOf(row.recent ?? []) } : {}),
  };
}

function stateOf(row: AgentRow): AgentState {
  const snapshot = row.snapshot;
  if (!snapshot) return row.fallbackState ?? 'stopped';
  if (snapshot.status === 'failed') return 'error';
  if (snapshot.status === 'starting') return 'booting';
  if (snapshot.status === 'stopped') return 'stopped';
  return snapshot.running ? 'working' : 'idle';
}

/**
 * 개입 사유 하나를 고른다(우선순위: question > approval > gate_failed > error > budget).
 * question은 스냅샷의 `pendingQuestion`(되묻기 대기, ADR-056)으로 본다.
 */
function attentionOf(row: AgentRow): AgentAttention | undefined {
  const snapshot = row.snapshot;
  const recent = row.recent ?? [];
  const finished = lastFinishedRun(recent);
  const candidates: AgentAttention[] = [];
  if (hasPendingQuestion(snapshot)) candidates.push('question');
  if (row.approval) candidates.push('approval');
  if (finished?.status === 'failed') candidates.push('gate_failed');
  if (snapshot && (snapshot.status === 'failed' || snapshot.error)) candidates.push('error');
  if (!snapshot && row.fallbackAttention) candidates.push(row.fallbackAttention);
  if (finished?.status === 'cancelled' && cancelledByBudget(recent, finished.runId)) candidates.push('budget');
  return ATTENTION_PRIORITY.find((attention) => candidates.includes(attention));
}

function hasPendingQuestion(snapshot: SessionSnapshot | undefined): boolean {
  return snapshot?.pendingQuestion !== undefined;
}

function lastFinishedRun(recent: readonly StudioEvent[]): { runId: string; status: string } | undefined {
  const event = recent.findLast((candidate) => candidate.type === 'run_finished');
  return event?.type === 'run_finished' ? { runId: event.runId, status: event.status } : undefined;
}

function cancelledByBudget(recent: readonly StudioEvent[], runId: string): boolean {
  return recent.some((event) => event.type === 'run_cancelling' && event.runId === runId && event.reason === 'budget');
}

/** 실행 중일 때 마지막 에이전트 이벤트를 한 줄로. 없으면 "모델 응답 대기" */
export function activityOf(recent: readonly StudioEvent[]): string {
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const event = recent[index]!;
    if (event.type !== 'agent') continue;
    const described = describeActivity(event.event);
    if (described) return described;
  }
  return '모델 응답 대기';
}

const STAGE_LABEL: Record<string, string> = {
  plan: '계획',
  implement: '구현',
  run: '실행',
  browser_check: '화면 확인',
  contract_check: '계약 확인',
  test: '테스트',
  review: '리뷰',
  checkpoint: '체크포인트',
};

/** 에이전트 이벤트를 활동 한 줄로. 설명할 것이 없으면 undefined */
function describeActivity(event: Exclude<AgentEvent, { type: 'tokens' }>): string | undefined {
  switch (event.type) {
    case 'tool_call':
      return `도구 ${event.name}`;
    case 'stage':
      return `단계: ${STAGE_LABEL[event.stage] ?? event.stage}`;
    case 'workflow_check':
      return `게이트: ${event.check.name}`;
    case 'verify_start':
      return `검증 준비: 파일 ${event.files.length}개`;
    case 'verify_result':
      return event.report.ok ? '검증 통과' : '검증 실패';
    case 'policy':
      return event.decision === 'deny' ? `정책 차단: ${event.tool}` : undefined;
    case 'route':
      return '모델 선택';
    case 'text':
      return '모델 응답';
    default:
      return undefined;
  }
}

function laneState(status: TaskPlanView['lanes'][number]['status']): AgentState {
  if (status === 'running') return 'working';
  if (status === 'booting') return 'booting';
  if (status === 'failed') return 'error';
  return 'stopped';
}

function laneAttention(lane: TaskPlanView['lanes'][number]): AgentAttention | undefined {
  if (lane.status === 'failed') return lane.error?.includes('게이트') || lane.error?.includes('검증') ? 'gate_failed' : 'error';
  return undefined;
}

function fleetMemberState(status: FleetView['members'][number]['status']): AgentState {
  if (status === 'running') return 'working';
  if (status === 'booting') return 'booting';
  if (status === 'failed' || status === 'error') return 'error';
  return 'stopped';
}

function fleetMemberAttention(status: FleetView['members'][number]['status']): AgentAttention | undefined {
  if (status === 'failed') return 'gate_failed';
  if (status === 'error') return 'error';
  return undefined;
}

/** 개입 필요 먼저, 그다음 작업 중, 그다음 최근 활동 순 */
function compareItems(a: AgentItem, b: AgentItem): number {
  const rank = (item: AgentItem) => (item.attention ? 0 : item.state === 'working' ? 1 : 2);
  return rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt);
}

function totalsOf(items: readonly AgentItem[]): AgentTotals {
  const tokens = emptyUsage();
  let attention = 0;
  let working = 0;
  for (const item of items) {
    if (item.attention) attention += 1;
    if (item.state === 'working') working += 1;
    if (!item.tokens) continue;
    tokens.inputTokens += item.tokens.inputTokens;
    tokens.outputTokens += item.tokens.outputTokens;
    tokens.cacheReadTokens += item.tokens.cacheReadTokens;
    tokens.cacheWriteTokens += item.tokens.cacheWriteTokens;
  }
  return { total: items.length, attention, working, tokens };
}

function truncateTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > TITLE_CHARS ? `${trimmed.slice(0, TITLE_CHARS)}…` : trimmed;
}
