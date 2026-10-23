/**
 * 관제 화면(#101)의 집계.
 *
 * 세션·작업 분해 레인·플릿 구성원을 한 목록으로 모으고, "지금 사람이 봐야 할 것"(개입 필요)을 먼저 세운다.
 * GitHub Copilot Mission Control·VS Code Agent Sessions의 "개입 필요" 인박스처럼, 전체 나열이 아니라 볼 것을 먼저 보여 주는 것이 목적이다.
 *
 * 판정 규칙(state·attention)은 순수 함수로 두고 테스트한다. 수집기는 기존 목록 함수가 돌려주는 것만 쓴다 —
 * 권한 규칙을 새로 만들지 않는다(로그인한 사람이 볼 수 있는 것은 그대로).
 */
import type { AgentEvent, AgentUsage, RequestMismatch } from '@b-studio/agent';
import { stripAnsi } from '@b-studio/sandbox';
import type { FleetView } from '@/lib/fleet-types';
import { mismatchLine } from '@/lib/mismatch';
import type { SessionMode, SessionSnapshot, StudioEvent } from '@/lib/studio-events';
import type { TaskPlanView } from '@/lib/task-plan-types';
import { listFleets } from './fleets';
import { sessionTerminalPresence } from './session-terminal';
import type { AgentCapabilities, TerminalAgentRow } from './terminal-agents';
import { overviewSessions, sessionBackend, sessionCapabilities, sessionHistory, sessionTerminalAgents } from './sessions';
import { listTaskPlans } from './task-plans';
import { buildTokenReports, tokenPricing, type TokenPricing } from './token-report';

export type AgentKind = 'session' | 'lane' | 'fleet';
/** dormant: 샌드박스를 아직 켜지 않은 세션(지연 기동). idle: 켜져 있지만 요청을 처리하지 않는다 */
/** done: 작업 카드 계획이 끝나 자원을 돌려주려고 멈춘 레인(사람이 멈춘 stopped와 가른다, #868) */
export type AgentState = 'working' | 'idle' | 'booting' | 'dormant' | 'stopped' | 'done' | 'error';
/** 개입이 필요한 이유. 여러 개면 우선순위가 높은 것 하나만 남긴다 */
export type AgentAttention = 'question' | 'approval' | 'gate_failed' | 'needs_review' | 'error' | 'budget';

/** 개입 필요 우선순위(앞일수록 먼저) */
export const ATTENTION_PRIORITY: readonly AgentAttention[] = ['question', 'approval', 'gate_failed', 'needs_review', 'error', 'budget'];
/** 제목은 요청 앞 이 글자 수로 줄인다 */
export const TITLE_CHARS = 80;
/** 개입 사유 한 줄은 이 글자 수로 줄인다 */
export const REASON_CHARS = 120;

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
  /** 개입이 필요한 까닭 한 줄(세션 오류의 첫 줄, 검증 실패한 실행의 요약). 알 수 없으면 없다 */
  reason?: string;
  /** 이 항목이 실제로 쓰는 백엔드(레인은 그 레인이 고른 backend). 알 수 없으면 없다 */
  backend?: SessionMode;
  lastActivityAt: string;
  /** 실행 중일 때 요청 시작부터 지난 시간 */
  runningForMs?: number;
  tokens?: AgentUsage;
  /** 실행 중일 때 마지막 에이전트 이벤트 한 줄 */
  activity?: string;
  /** 여러 명 비교(fleet)·나눠서 병렬(plan)에 속한 항목이면 그 작업. 작업 화면이 이 값으로 한 줄로 묶는다 */
  group?: AgentGroup;
  /** 세션 터미널을 연 세션일 때만(#835): CLI가 떠 있는지, 권한 확인 창에서 사람을 기다리는지 */
  terminal?: AgentTerminalStatus;
  /** 게이트의 지금 상태와 게이트를 통과한 체크포인트 수(#835). 세션 스냅샷이 없으면 없다 */
  gate?: AgentGateStatus;
  /** 세션 기록의 실행 비용 합(추정, 가격표 기준). 모르면 없다 */
  costUsd?: number;
  /** 터미널 CLI의 메인·서브에이전트별 토큰·상태·하는 일(#843). 터미널 사용량을 받은 적이 없으면 없다 */
  agents?: AgentDetail[];
  /** 이 에이전트가 할 수 있는 범위(#843). 기억에 없는 세션이면 없다 */
  capabilities?: AgentCapabilities;
}

/** 에이전트 내역 한 행(#843). studio desk와 작업 화면이 그대로 그린다 */
export type AgentDetail = TerminalAgentRow;
export type { AgentCapabilities };

export interface AgentTerminalStatus {
  cli: 'up' | 'down';
  waiting?: 'permission';
}

/**
 * verifying: 지금 실행에서 검증이 시작됐고 아직 결과가 없다. passed·failed: 지금(또는 마지막) 실행의 마지막 검증 판정.
 * none: 이번 실행에 판정이 없다(질문, 바꾼 것 없음, 취소, 아직 검증 전)
 */
export interface AgentGateStatus {
  state: 'verifying' | 'passed' | 'failed' | 'none';
  checkpoints: number;
}

/** 항목이 속한 작업. href는 그 작업의 화면(비교·병렬 화면에서 그 작업을 연다) */
export interface AgentGroup {
  kind: 'fleet' | 'plan';
  id: string;
  href: string;
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
  /** 이 프로세스에서 세션 터미널을 연 적이 있으면 그 CLI가 떠 있는지(withDeskFacts가 붙인다) */
  terminal?: { cliAlive: boolean };
  /** 세션 기록 전체에서 계산한 실행 비용 합(withDeskFacts가 붙인다) */
  costUsd?: number;
  /** 에이전트 내역(withDeskFacts가 붙인다, #843) */
  agents?: readonly TerminalAgentRow[];
  /** 할 수 있는 범위(withDeskFacts가 붙인다, #843) */
  capabilities?: AgentCapabilities;
}

/** studio desk 사이드바의 사실을 모으는 곳. 테스트가 바꿔 끼운다 */
export interface DeskFactDeps {
  terminal: (sessionId: string) => { cliAlive: boolean } | undefined;
  costUsd: (sessionId: string) => number | undefined;
  /** 에이전트 내역(#843). 주지 않으면 붙이지 않는다 */
  agents?: (sessionId: string) => readonly TerminalAgentRow[] | undefined;
  /** 할 수 있는 범위(#843). 주지 않으면 붙이지 않는다 */
  capabilities?: (sessionId: string) => AgentCapabilities | undefined;
}

/** 수집한 세션에 터미널 CLI 상태와 비용을 붙인다(#835). 모르는 값은 붙이지 않는다 */
export function withDeskFacts(sessions: readonly SessionOverviewSource[], deps: DeskFactDeps): SessionOverviewSource[] {
  return sessions.map((source) => {
    const terminal = deps.terminal(source.snapshot.id);
    const costUsd = deps.costUsd(source.snapshot.id);
    const agents = deps.agents?.(source.snapshot.id);
    const capabilities = deps.capabilities?.(source.snapshot.id);
    return {
      ...source,
      ...(terminal ? { terminal } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(agents && agents.length > 0 ? { agents } : {}),
      ...(capabilities ? { capabilities } : {}),
    };
  });
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
  /** 스냅샷이 없을 때 개입 사유를 설명하는 원문(레인 오류) */
  fallbackReason?: string;
  /** 계획 승인 대기(세션 밖 사실) */
  approval?: boolean;
  /** 끝난 레인이다. 통합이 레인 세션을 멈춰 자원을 돌려주므로, 멈춘 세션을 중지 대신 끝남으로 본다(#868) */
  finishedLane?: boolean;
  /** 이 항목이 쓰는 백엔드 */
  backend?: SessionMode;
  /** 스냅샷이 없을 때의 토큰 */
  tokens?: AgentUsage;
  group?: AgentGroup;
  terminal?: { cliAlive: boolean };
  costUsd?: number;
  agents?: readonly TerminalAgentRow[];
  capabilities?: AgentCapabilities;
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
        href: `/task-plans?id=${encodeURIComponent(plan.id)}`,
        title: plan.request,
        projectName: plan.projectId,
        owner: plan.owner,
        updatedAt: plan.createdAt,
        approval: true,
        fallbackState: 'idle',
        tokens: plan.planning?.usage,
        group: planGroup(plan.id),
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
          ? { snapshot: source.snapshot, recent: source.recent, updatedAt: source.updatedAt, ...(source.runningSince ? { runningSince: source.runningSince } : {}), ...deskFactsOf(source), ...(lane.status === 'done' ? { finishedLane: true } : {}) }
          : { updatedAt: lane.finishedAt ?? lane.startedAt ?? plan.createdAt, fallbackState: laneState(lane.status), fallbackAttention: laneAttention(lane), ...(lane.error ? { fallbackReason: lane.error } : {}) }),
        // 레인은 그 레인이 고른 백엔드(세션이 있으면 스냅샷)를 보여 준다
        backend: source ? sessionBackend(source.snapshot) : lane.backend,
        group: planGroup(plan.id),
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
          ? { snapshot: source.snapshot, recent: source.recent, updatedAt: source.updatedAt, ...(source.runningSince ? { runningSince: source.runningSince } : {}), ...deskFactsOf(source) }
          : { updatedAt: member.finishedAt ?? member.startedAt ?? fleet.createdAt, fallbackState: fleetMemberState(member.status), fallbackAttention: fleetMemberAttention(member.status) }),
        backend: source ? sessionBackend(source.snapshot) : undefined,
        tokens: source?.snapshot.tokens ?? member.usage,
        group: { kind: 'fleet', id: fleet.id, href: `/fleets?id=${encodeURIComponent(fleet.id)}` },
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
      // 사람이 붙인 이름이 있으면 그것이 제목이다(#864)
      title: source.snapshot.label?.trim() || source.lastRequest?.trim() || source.snapshot.projectName,
      projectName: source.snapshot.projectName,
      owner: source.snapshot.owner,
      snapshot: source.snapshot,
      recent: source.recent,
      updatedAt: source.updatedAt,
      backend: sessionBackend(source.snapshot),
      ...(source.runningSince ? { runningSince: source.runningSince } : {}),
      ...deskFactsOf(source),
    });
  }

  const items = rows.map((row) => evaluate(row, now)).sort(compareItems);
  return { items, totals: totalsOf(items) };
}

function deskFactsOf(source: SessionOverviewSource): Pick<AgentRow, 'terminal' | 'costUsd' | 'agents' | 'capabilities'> {
  return {
    ...(source.terminal ? { terminal: source.terminal } : {}),
    ...(source.costUsd !== undefined ? { costUsd: source.costUsd } : {}),
    ...(source.agents ? { agents: source.agents } : {}),
    ...(source.capabilities ? { capabilities: source.capabilities } : {}),
  };
}

function planGroup(id: string): AgentGroup {
  return { kind: 'plan', id, href: `/task-plans?id=${encodeURIComponent(id)}` };
}

/** 라우트가 쓰는 수집기. 기존 목록 함수가 돌려주는 것만 모은다(권한 규칙을 새로 만들지 않는다) */
export async function listAgentOverview(user: string): Promise<{ items: AgentItem[]; totals: AgentTotals }> {
  const pricing = tokenPricing(process.env);
  const sessions = withDeskFacts(await overviewSessions(), {
    terminal: (id) => sessionTerminalPresence(id),
    // 기록을 읽지 못한 세션(사라진 보관 기록 등)은 비용을 모르는 것으로 둔다. 목록 전체를 실패시키지 않는다
    costUsd: (id) => {
      try {
        return sessionCostUsd(sessionHistory(id), pricing);
      } catch {
        return undefined;
      }
    },
    agents: (id) => sessionTerminalAgents(id, pricing),
    capabilities: (id) => sessionCapabilities(id),
  });
  return buildAgentOverview({ sessions, plans: listTaskPlans(user), fleets: listFleets(user) });
}

/** 세션 기록의 실행별 추정 비용 합. 비용을 아는 실행이 하나도 없으면 없다 */
export function sessionCostUsd(events: readonly StudioEvent[], pricing: TokenPricing): number | undefined {
  let total: number | undefined;
  for (const report of buildTokenReports(events, pricing)) {
    if (report.estimatedCostUsd !== undefined) total = (total ?? 0) + report.estimatedCostUsd;
  }
  return total;
}

/** 한 항목의 상태·개입 사유·활동을 판정한다 */
function evaluate(row: AgentRow, now: number): AgentItem {
  const state = stateOf(row);
  const attention = attentionOf(row);
  const reason = attention ? reasonOf(row, attention) : undefined;
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
    ...(reason ? { reason } : {}),
    ...(row.backend ? { backend: row.backend } : {}),
    lastActivityAt: row.updatedAt,
    ...(runningForMs !== undefined ? { runningForMs } : {}),
    ...(tokens ? { tokens } : {}),
    ...(state === 'working' ? { activity: activityOf(row.recent ?? []) } : {}),
    ...(row.group ? { group: row.group } : {}),
    ...(row.terminal ? { terminal: terminalStatusOf(row.terminal, row.snapshot) } : {}),
    ...(row.snapshot ? { gate: gateStatusOf(row.snapshot, row.recent ?? []) } : {}),
    ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
    // 메인 행의 상태는 이 항목의 실행 상태다. 장부는 실행 상태를 모른다
    ...(row.agents ? { agents: row.agents.map((agent) => (agent.kind === 'main' ? { ...agent, state: state === 'working' ? ('working' as const) : ('idle' as const) } : agent)) } : {}),
    ...(row.capabilities ? { capabilities: row.capabilities } : {}),
  };
}

/** 권한 확인 창(permission_prompt)만 권한 대기로 본다. 입력 대기·되묻기는 사이드바의 작업 상태가 보인다 */
export function terminalStatusOf(terminal: { cliAlive: boolean }, snapshot: SessionSnapshot | undefined): AgentTerminalStatus {
  const waiting = terminal.cliAlive && snapshot?.terminalAttention?.kind === 'permission_prompt';
  return { cli: terminal.cliAlive ? 'up' : 'down', ...(waiting ? { waiting: 'permission' as const } : {}) };
}

/**
 * 게이트 상태는 마지막 실행(마지막 run_started 뒤의 기록)만 본다 — 앞 실행의 판정을 새 실행에 들고 오지 않는다.
 * 그 실행의 마지막 검증 이벤트가 결과면 그 결과, 시작이고 실행이 아직 열려 있으면 verifying.
 * 검증 이벤트가 없으면(최근 기록에서 잘렸거나 결과 없이 끝남) 실행이 failed로 끝났을 때만 failed다.
 * 체크포인트는 게이트 통과 기록(Workflow-Passed)이 있는 것만 센다(세션 시작·검증 없이 남긴 체크포인트는 빼고)
 */
export function gateStatusOf(snapshot: SessionSnapshot, recent: readonly StudioEvent[]): AgentGateStatus {
  const checkpoints = snapshot.checkpoints.filter((checkpoint) => (checkpoint.passedStages?.length ?? 0) > 0).length;
  const startIndex = recent.findLastIndex((event) => event.type === 'run_started');
  const run = startIndex >= 0 ? recent.slice(startIndex + 1) : recent;
  const finished = run.findLast((event) => event.type === 'run_finished');
  let lastVerify: Extract<AgentEvent, { type: 'verify_start' | 'verify_result' }> | undefined;
  for (const event of run) {
    if (event.type === 'agent' && (event.event.type === 'verify_start' || event.event.type === 'verify_result')) lastVerify = event.event;
  }
  const state: AgentGateStatus['state'] =
    lastVerify?.type === 'verify_result'
      ? lastVerify.report.ok
        ? 'passed'
        : 'failed'
      : lastVerify?.type === 'verify_start' && !finished && snapshot.running
        ? 'verifying'
        : finished?.type === 'run_finished' && finished.status === 'failed'
          ? 'failed'
          : 'none';
  return { state, checkpoints };
}

function stateOf(row: AgentRow): AgentState {
  const snapshot = row.snapshot;
  if (!snapshot) return row.fallbackState ?? 'stopped';
  if (snapshot.status === 'failed') return 'error';
  if (snapshot.status === 'starting') return 'booting';
  if (snapshot.status === 'stopped') return row.finishedLane ? 'done' : 'stopped';
  // 샌드박스를 아직 켜지 않은 세션(지연 기동)은 "대기(샌드박스 꺼짐)"로 보여 준다
  if (snapshot.status === 'idle') return 'dormant';
  return snapshot.running ? 'working' : 'idle';
}

/**
 * 개입 사유 하나를 고른다(우선순위: question > approval > gate_failed > needs_review > error > budget).
 * needs_review는 마지막 실행이 done이지만 에이전트가 요청과 확인의 어긋남을 알렸다는 뜻이다(#666).
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
  if (finished?.status === 'done' && finished.mismatches?.length) candidates.push('needs_review');
  if (snapshot && (snapshot.status === 'failed' || snapshot.error)) candidates.push('error');
  if (!snapshot && row.fallbackAttention) candidates.push(row.fallbackAttention);
  if (finished?.status === 'cancelled' && cancelledByBudget(recent, finished.runId)) candidates.push('budget');
  return ATTENTION_PRIORITY.find((attention) => candidates.includes(attention));
}

/** 개입 사유를 설명하는 한 줄. 사유 이름(오류·검증 실패)만으로는 무엇을 할지 모르므로 원문의 첫 줄을 붙인다 */
function reasonOf(row: AgentRow, attention: AgentAttention): string | undefined {
  const snapshot = row.snapshot;
  if (!snapshot) return row.fallbackReason ? oneLine(row.fallbackReason) : undefined;
  if (attention === 'error' && snapshot.error) return oneLine(snapshot.error);
  if (attention === 'gate_failed') {
    const event = (row.recent ?? []).findLast((candidate) => candidate.type === 'run_finished');
    if (event?.type === 'run_finished' && event.summary) return oneLine(event.summary);
  }
  if (attention === 'needs_review') {
    const mismatch = lastFinishedRun(row.recent ?? [])?.mismatches?.[0];
    if (mismatch) return oneLine(mismatchLine(mismatch));
  }
  return undefined;
}

/** 색 코드를 지우고 비어 있지 않은 첫 줄만 남겨 REASON_CHARS로 자른다 */
function oneLine(text: string): string | undefined {
  const line = stripAnsi(text)
    .split('\n')
    .map((candidate) => candidate.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS).trimEnd()}…` : line;
}

function hasPendingQuestion(snapshot: SessionSnapshot | undefined): boolean {
  return snapshot?.pendingQuestion !== undefined;
}

function lastFinishedRun(recent: readonly StudioEvent[]): { runId: string; status: string; mismatches?: RequestMismatch[] } | undefined {
  const event = recent.findLast((candidate) => candidate.type === 'run_finished');
  return event?.type === 'run_finished' ? { runId: event.runId, status: event.status, ...(event.mismatches ? { mismatches: event.mismatches } : {}) } : undefined;
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
  concurrency_check: '동시 요청 확인',
  load_check: '부하 확인',
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
  if (status === 'done') return 'done';
  return 'stopped';
}

function laneAttention(lane: TaskPlanView['lanes'][number]): AgentAttention | undefined {
  if (lane.status === 'failed') return lane.error?.includes('게이트') || lane.error?.includes('검증') ? 'gate_failed' : 'error';
  // 작업 하나라도 요청과 확인의 어긋남을 알렸으면 끝난 레인도 확인이 필요하다(#666)
  if (lane.tasks.some((task) => task.mismatches?.length)) return 'needs_review';
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
