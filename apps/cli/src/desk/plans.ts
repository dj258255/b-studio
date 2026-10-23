/**
 * desk의 작업 나누기 화면(#893, 앞글쇠 다음 t). 웹의 작업 분해 화면(task-plans)을 터미널로 옮긴다(ADR-186).
 *
 * 세 모드: 계획 목록, 새 계획(프로젝트·요청 → 스튜디오가 레인으로 나눈다), 계획 보기(레인을 의존 순서대로 단계로 묶은 카드와 통합).
 * 계획 보기에서는 고른 레인의 세션을 칸에 열고(Enter), 세션이 있는 레인을 칸 1·2·4개에 나란히 연다(g).
 * 승인 대기 중에는 레인마다 AI·계정을 바꾸고(b), 승인(a, 이슈로 올리기는 i)·거부(x)한다. 재시작으로 멈춘 계획은 통합을 다시 시작한다(e).
 * 여기는 상태와 받은 키로 다음 상태와 할 일(effects)을 돌려주는 순수 함수와 그리기뿐이다. 스튜디오 API는 desk.ts가 부른다
 */
import type { DeskState } from './keys';
import { fit, fitAnsi, osc8, stringWidth, type Rect } from './screen';
import { backendLabel, compactTokens, gateStatus, totalTokens, type StatusBadge } from './sidebar';
import { bg, BOLD, DEFAULT_THEME, fg, RESET, type Theme } from './theme';
import type { DeskAccount, DeskItem, DeskProject, DeskUsage } from './types';
import { box, spread, statusMark, statusText } from './widgets';

export type DeskPlanStatus = 'planning' | 'awaiting_approval' | 'running' | 'integrating' | 'interrupted' | 'done' | 'failed' | 'rejected';
export type DeskPlanStepStatus = 'queued' | 'booting' | 'running' | 'done' | 'failed' | 'skipped';

/** 스튜디오 TaskPlanView에서 desk가 쓰는 것(task-plan-types.ts와 같은 꼴, 필요한 필드만) */
export interface DeskPlanTask {
  id: string;
  title: string;
  dependsOn: string[];
  status: DeskPlanStepStatus;
  run?: { usage?: DeskUsage; costUsd?: number };
}

export interface DeskPlanLane {
  id: string;
  sessionId?: string;
  backend?: string;
  model?: string;
  /** 레인을 띄울 AI 계정(#893). 없으면 그 CLI의 기본 계정이다 */
  accountId?: string;
  paths: string[];
  status: DeskPlanStepStatus;
  tasks: DeskPlanTask[];
  waiting?: string;
  error?: string;
  changedFiles?: string[];
}

export interface DeskPlanIntegration {
  sessionId?: string;
  status: DeskPlanStepStatus;
  files: string[];
  deleted: string[];
  checkpoint?: { shortSha: string };
  error?: string;
}

export interface DeskPlan {
  id: string;
  projectId: string;
  request: string;
  status: DeskPlanStatus;
  createdAt: string;
  finishedAt?: string;
  rejectedReason?: string;
  lanes: DeskPlanLane[];
  integration?: DeskPlanIntegration;
  issues?: { tracking?: { number: number; url: string }; error?: string };
  metrics?: { usage: DeskUsage };
  error?: string;
}

/** 레인에 고를 수 있는 AI(·계정). backend가 빈 글이면 "세션과 같음"(계획 기본)이다 */
export interface LaneChoice {
  backend: string;
  accountId?: string;
  label: string;
}

export type PlansConfirm = { kind: 'approve' | 'reject' | 'delete' | 'resume'; planId: string; title: string };

export interface PlansForm {
  step: 'project' | 'request';
  projects: DeskProject[];
  projectIndex: number;
  text: string;
  sending?: boolean;
}

export interface PlansState {
  mode: 'list' | 'detail' | 'new';
  /** 목록·계획을 처음 받는 중 */
  loading?: boolean;
  list?: DeskPlan[];
  /** 목록에서 고른 줄 */
  row: number;
  detail?: DeskPlan;
  /** 계획 보기에서 고른 것(laneTargets 순서) */
  lane: number;
  form?: PlansForm;
  confirm?: PlansConfirm;
  /** 레인 AI·계정 고르기 */
  picker?: { laneId: string; index: number };
  /** 레인에 고를 수 있는 AI·계정. desk가 받아 채운다. 없으면 아직 받지 않았다 */
  choices?: LaneChoice[];
  /** 계정 이름을 찾는 데 쓴다 */
  accounts?: DeskAccount[];
  /** 아래 줄 알림(다음 키에서 지운다) */
  note?: string;
  /** 마지막으로 받지 못한 까닭 */
  error?: string;
}

export type PlansEffect =
  | { type: 'close' }
  | { type: 'list' }
  | { type: 'detail'; id: string }
  | { type: 'projects' }
  | { type: 'create'; projectId: string; request: string }
  | { type: 'approve'; id: string; publishIssues: boolean }
  | { type: 'reject'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'lane-choices' }
  | { type: 'lane'; id: string; laneId: string; backend: string; accountId?: string }
  | { type: 'open'; sessionId: string }
  | { type: 'grid'; sessionIds: string[] }
  | { type: 'open-url'; url: string };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j'];
const LEFT = ['\x1b[D', '\x1bOD', 'h'];
const RIGHT = ['\x1b[C', '\x1bOC', 'l'];
const ENTER = ['\r', '\n'];
const BACKSPACE = ['\x7f', '\b'];
/** 칸에 나란히 여는 레인의 상한(4칸 배치) */
const GRID_MAX = 4;
/** 레인 카드 폭의 하한. 이보다 좁으면 한 줄에 카드 하나 */
const LANE_MIN = 34;

export function openPlans(): PlansState {
  return { mode: 'list', loading: true, row: 0, lane: 0 };
}

const PLAN_STATUS: Record<DeskPlanStatus, StatusBadge> = {
  planning: { label: '계획 짜는 중', tone: 'busy' },
  awaiting_approval: { label: '승인 대기', tone: 'warn' },
  running: { label: '실행 중', tone: 'busy' },
  integrating: { label: '통합 중', tone: 'busy' },
  interrupted: { label: '멈춤', tone: 'warn' },
  done: { label: '끝남', tone: 'ok' },
  failed: { label: '실패', tone: 'fail' },
  rejected: { label: '거부', tone: 'muted' },
};

const STEP_STATUS: Record<DeskPlanStepStatus, StatusBadge> = {
  queued: { label: '기다림', tone: 'muted' },
  booting: { label: '띄우는 중', tone: 'busy' },
  running: { label: '작업 중', tone: 'busy' },
  done: { label: '끝남', tone: 'ok' },
  failed: { label: '실패', tone: 'fail' },
  skipped: { label: '건너뜀', tone: 'muted' },
};

export function planStatus(status: DeskPlanStatus): StatusBadge {
  return PLAN_STATUS[status] ?? { label: status, tone: 'muted' };
}

export function stepStatus(status: DeskPlanStepStatus): StatusBadge {
  return STEP_STATUS[status] ?? { label: status, tone: 'muted' };
}

/**
 * 레인을 단계로 묶는다: 다른 레인의 작업에 기대는(dependsOn) 레인은 기대는 레인들보다 뒤 단계다.
 * 단계는 가장 긴 의존 길이이고, 같은 단계 안은 계획의 레인 순서다. 순환이 있으면(있어서는 안 된다) 거기서 끊는다
 */
export function planStages(plan: DeskPlan): DeskPlanLane[][] {
  const owner = new Map<string, string>();
  for (const lane of plan.lanes) for (const task of lane.tasks) owner.set(task.id, lane.id);
  const needs = new Map<string, Set<string>>();
  for (const lane of plan.lanes) {
    const set = new Set<string>();
    for (const task of lane.tasks) for (const dep of task.dependsOn) {
      const from = owner.get(dep);
      if (from && from !== lane.id) set.add(from);
    }
    needs.set(lane.id, set);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const dep of needs.get(id) ?? []) value = Math.max(value, depthOf(dep) + 1);
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  const stages: DeskPlanLane[][] = [];
  for (const lane of plan.lanes) (stages[depthOf(lane.id)] ??= []).push(lane);
  return stages.filter((stage) => stage !== undefined);
}

export type LaneTarget = { kind: 'lane'; lane: DeskPlanLane } | { kind: 'integration'; integration: DeskPlanIntegration };

/** 계획 보기에서 고르는 차례: 단계 차례의 레인, 그리고 통합(있으면) */
export function laneTargets(plan: DeskPlan): LaneTarget[] {
  const targets: LaneTarget[] = planStages(plan).flat().map((lane) => ({ kind: 'lane', lane }));
  if (plan.integration) targets.push({ kind: 'integration', integration: plan.integration });
  return targets;
}

function clampRow(index: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index));
}

function oneLine(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
}

/** 붙여 넣은 글: 새 계획 요청에 한 줄로 넣는다. 그 밖에는 버린다 */
export function plansPaste(state: PlansState, text: string): PlansState {
  const form = state.form;
  if (state.mode !== 'new' || !form || form.step !== 'request' || form.sending) return state;
  return { ...state, form: { ...form, text: form.text + oneLine(text) } };
}

export function plansKey(start: PlansState, key: string): { state: PlansState | undefined; effects: PlansEffect[] } {
  const effects: PlansEffect[] = [];
  const state: PlansState = start.note ? { ...start, note: undefined } : start;
  if (state.confirm) return { state: confirmKey(state, key, effects), effects };
  if (state.mode === 'new') return { state: formKey(state, key, effects), effects };
  if (state.mode === 'detail') return { state: detailKey(state, key, effects), effects };
  return listKey(state, key, effects);
}

function listKey(state: PlansState, key: string, effects: PlansEffect[]): { state: PlansState | undefined; effects: PlansEffect[] } {
  const list = state.list ?? [];
  const current = list[clampRow(state.row, list.length)];
  if (key === ESC || key === 'q') {
    effects.push({ type: 'close' });
    return { state: undefined, effects };
  }
  if (UP.includes(key) || LEFT.includes(key)) return { state: { ...state, row: clampRow(state.row - 1, list.length) }, effects };
  if (DOWN.includes(key) || RIGHT.includes(key)) return { state: { ...state, row: clampRow(state.row + 1, list.length) }, effects };
  if (ENTER.includes(key)) {
    if (!current) return { state, effects };
    effects.push({ type: 'detail', id: current.id });
    return { state: { ...state, mode: 'detail', detail: current, lane: 0, picker: undefined }, effects };
  }
  if (key === 'n') {
    effects.push({ type: 'projects' });
    return { state: { ...state, mode: 'new', form: { step: 'project', projects: [], projectIndex: 0, text: '' } }, effects };
  }
  if (key === 'r') {
    effects.push({ type: 'list' });
    return { state, effects };
  }
  if (key === 'd') {
    if (!current) return { state, effects };
    return { state: { ...state, confirm: { kind: 'delete', planId: current.id, title: current.request } }, effects };
  }
  return { state, effects };
}

function formKey(state: PlansState, key: string, effects: PlansEffect[]): PlansState {
  const form = state.form;
  if (!form) return { ...state, mode: 'list' };
  if (key === ESC || key === '\x03') {
    effects.push({ type: 'list' });
    return { ...state, mode: 'list', form: undefined };
  }
  if (form.sending) return state;
  if (form.step === 'project') {
    if (UP.includes(key)) return { ...state, form: { ...form, projectIndex: clampRow(form.projectIndex - 1, form.projects.length) } };
    if (DOWN.includes(key)) return { ...state, form: { ...form, projectIndex: clampRow(form.projectIndex + 1, form.projects.length) } };
    if (ENTER.includes(key) && form.projects[form.projectIndex]) return { ...state, form: { ...form, step: 'request' } };
    return state;
  }
  if (key === '\r') {
    const request = form.text.trim();
    const project = form.projects[form.projectIndex];
    if (!request || !project) return state;
    effects.push({ type: 'create', projectId: project.id, request });
    return { ...state, form: { ...form, sending: true } };
  }
  if (BACKSPACE.includes(key)) return { ...state, form: { ...form, text: [...form.text].slice(0, -1).join('') } };
  if (key === '\x15') return { ...state, form: { ...form, text: '' } };
  if (key.startsWith(ESC)) return state;
  const char = key === '\n' ? ' ' : key;
  if (char.codePointAt(0)! < 32) return state;
  return { ...state, form: { ...form, text: form.text + char } };
}

function detailKey(state: PlansState, key: string, effects: PlansEffect[]): PlansState {
  const plan = state.detail;
  if (!plan) return { ...state, mode: 'list' };
  if (state.picker) return pickerKey(state, plan, key, effects);
  const targets = laneTargets(plan);
  const target = targets[clampRow(state.lane, targets.length)];
  if (key === ESC || key === 'q') {
    effects.push({ type: 'list' });
    return { ...state, mode: 'list', picker: undefined };
  }
  if (UP.includes(key) || LEFT.includes(key)) return { ...state, lane: clampRow(state.lane - 1, targets.length) };
  if (DOWN.includes(key) || RIGHT.includes(key)) return { ...state, lane: clampRow(state.lane + 1, targets.length) };
  if (ENTER.includes(key)) {
    const sessionId = target?.kind === 'lane' ? target.lane.sessionId : target?.integration.sessionId;
    if (!sessionId) return { ...state, note: '이 레인의 세션은 아직 없습니다. 승인한 뒤 레인이 시작되면 열 수 있습니다' };
    effects.push({ type: 'open', sessionId });
    return state;
  }
  if (key === 'r') {
    effects.push({ type: 'detail', id: plan.id });
    return state;
  }
  if (key === 'g') {
    const sessionIds = plan.lanes.map((lane) => lane.sessionId).filter((id): id is string => id !== undefined).slice(0, GRID_MAX);
    if (sessionIds.length === 0) return { ...state, note: '세션이 있는 레인이 없습니다. 승인한 뒤 레인이 시작되면 나란히 열 수 있습니다' };
    effects.push({ type: 'grid', sessionIds });
    return state;
  }
  if (key === 'b') {
    if (plan.status !== 'awaiting_approval') return { ...state, note: '레인 AI·계정은 승인 대기 중에만 바꿉니다' };
    if (target?.kind !== 'lane') return { ...state, note: '레인을 고른 뒤 바꿉니다' };
    const current = currentChoice(state.choices ?? [], target.lane);
    if (!state.choices) effects.push({ type: 'lane-choices' });
    return { ...state, picker: { laneId: target.lane.id, index: current } };
  }
  if (key === 'a' || key === 'x') {
    if (plan.status !== 'awaiting_approval') return { ...state, note: '승인을 기다리는 계획이 아닙니다' };
    return { ...state, confirm: { kind: key === 'a' ? 'approve' : 'reject', planId: plan.id, title: plan.request } };
  }
  if (key === 'e') {
    if (plan.status !== 'interrupted') return { ...state, note: '재시작으로 멈춘 계획만 통합을 다시 시작합니다' };
    return { ...state, confirm: { kind: 'resume', planId: plan.id, title: plan.request } };
  }
  if (key === 'd') return { ...state, confirm: { kind: 'delete', planId: plan.id, title: plan.request } };
  if (key === 'o') {
    const url = plan.issues?.tracking?.url;
    if (!url) return { ...state, note: '올린 이슈가 없습니다(승인할 때 i로 이슈로 올립니다)' };
    effects.push({ type: 'open-url', url });
    return state;
  }
  return state;
}

/** 레인의 지금 AI·계정에 맞는 선택지 자리. 없으면 0 */
function currentChoice(choices: readonly LaneChoice[], lane: DeskPlanLane): number {
  const at = choices.findIndex((choice) => choice.backend === (lane.backend ?? '') && (choice.accountId ?? '') === (lane.accountId ?? ''));
  return at >= 0 ? at : 0;
}

function pickerKey(state: PlansState, plan: DeskPlan, key: string, effects: PlansEffect[]): PlansState {
  const picker = state.picker!;
  const choices = state.choices ?? [];
  if (key === ESC || key === 'q') return { ...state, picker: undefined };
  if (UP.includes(key)) return { ...state, picker: { ...picker, index: clampRow(picker.index - 1, choices.length) } };
  if (DOWN.includes(key)) return { ...state, picker: { ...picker, index: clampRow(picker.index + 1, choices.length) } };
  if (ENTER.includes(key)) {
    const choice = choices[picker.index];
    if (!choice) return state;
    effects.push({ type: 'lane', id: plan.id, laneId: picker.laneId, backend: choice.backend, ...(choice.accountId ? { accountId: choice.accountId } : {}) });
    return { ...state, picker: undefined };
  }
  return state;
}

function confirmKey(state: PlansState, key: string, effects: PlansEffect[]): PlansState {
  const confirm = state.confirm!;
  const done = { ...state, confirm: undefined };
  const yes = key === 'y' || key === 'Y' || key === '\r';
  if (confirm.kind === 'approve' && (yes || key === 'i')) {
    effects.push({ type: 'approve', id: confirm.planId, publishIssues: key === 'i' });
    return done;
  }
  if (yes) {
    if (confirm.kind === 'approve') return done;
    effects.push({ type: confirm.kind, id: confirm.planId });
    // 지운 계획은 보고 있던 곳에서 빼고 목록으로 돌아간다
    if (confirm.kind === 'delete') return { ...done, mode: 'list', detail: undefined, list: (state.list ?? []).filter((plan) => plan.id !== confirm.planId) };
    return done;
  }
  return { ...done, note: '그만두었습니다' };
}

/** 아래 줄 안내 */
export function plansHint(state: PlansState): string {
  if (state.note) return ` ${state.note}`;
  const confirm = state.confirm;
  if (confirm) {
    const title = `‹${confirm.title}›`;
    if (confirm.kind === 'approve') return ` ${title} 계획을 승인할까요? 레인 세션이 뜨고 작업이 시작됩니다 · y 승인 · i 승인하고 이슈로 올리기 · 다른 키 그만두기`;
    if (confirm.kind === 'reject') return ` ${title} 계획을 거부할까요? 세션을 만들지 않고 멈춥니다 · y 거부 · 다른 키 그만두기`;
    if (confirm.kind === 'resume') return ` ${title} 계획의 통합을 다시 시작할까요? 레인은 다시 돌리지 않습니다 · y 다시 시작 · 다른 키 그만두기`;
    return ` ${title} 계획을 지울까요? 레인·통합 세션의 기록도 함께 지웁니다(되돌릴 수 없습니다) · y 지우기 · 다른 키 그만두기`;
  }
  if (state.mode === 'new') {
    return state.form?.step === 'request' ? ' 새 계획 · Enter 만들기(스튜디오가 레인으로 나눕니다) · Esc 목록' : ' 새 계획 · ↑↓ 프로젝트 고르기 · Enter 다음 · Esc 목록';
  }
  if (state.mode === 'detail') {
    if (state.picker) return ' 레인 AI·계정 · ↑↓ 고르기 · Enter 바꾸기 · Esc 그만두기';
    const approval = state.detail?.status === 'awaiting_approval' ? ' · b AI·계정 · a 승인 · x 거부' : '';
    const resume = state.detail?.status === 'interrupted' ? ' · e 통합 다시 시작' : '';
    return ` 작업 나누기 · ↑↓ 레인 고르기 · Enter 칸에 열기 · g 칸에 나란히${approval}${resume} · o 이슈 · d 지우기 · Esc 목록`;
  }
  return ' 작업 나누기 · ↑↓ 고르기 · Enter 보기 · n 새 계획 · r 다시 읽기 · d 지우기 · Esc 닫기';
}

// ─── 그리기 ───

function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function laneTitle(lane: DeskPlanLane): string {
  const titles = lane.tasks.map((task) => task.title);
  if (titles.length === 0) return lane.id;
  return titles.length === 1 ? titles[0]! : `${titles[0]} 외 ${titles.length - 1}`;
}

function accountName(id: string | undefined, accounts: readonly DeskAccount[] | undefined): string | undefined {
  if (!id) return undefined;
  return accounts?.find((account) => account.id === id)?.name ?? id;
}

/** 레인의 AI·계정·모델 한 줄. AI를 고르지 않은 레인은 계획 기본(세션과 같음)이다 */
export function laneAgentLabel(lane: DeskPlanLane, item: DeskItem | undefined, accounts?: readonly DeskAccount[]): string {
  const backend = lane.backend ?? item?.backend;
  const account = accountName(lane.accountId ?? item?.accountId, accounts);
  const parts = [backend ? backendLabel(backend) : '세션과 같음', ...(account ? [account] : []), ...(lane.model ? [lane.model] : [])];
  return parts.join(' · ');
}

function sumUsage(lane: DeskPlanLane): number {
  return lane.tasks.reduce((sum, task) => sum + (task.run?.usage ? totalTokens(task.run.usage) : 0), 0);
}

function laneCard(lane: DeskPlanLane, item: DeskItem | undefined, width: number, theme: Theme, selected: boolean, accounts?: readonly DeskAccount[]): string[] {
  const muted = fg(theme, 'muted');
  const inner = width - 4;
  const status = stepStatus(lane.status);
  const head = spread(`${statusMark(status, theme)} ${BOLD}${fg(theme, 'text')}${laneTitle(lane)}${RESET}`, statusText(status, theme), inner, stringWidth(status.label) + 2);
  const agent = `${muted}${lane.id} · ${laneAgentLabel(lane, item, accounts)}${RESET}`;
  const now = lane.error
    ? `${fg(theme, 'red')}${oneLine(lane.error)}${RESET}`
    : lane.waiting
      ? `${fg(theme, 'yellow')}${oneLine(lane.waiting)}${RESET}`
      : `${muted}작업 ${lane.tasks.length}: ${lane.tasks.map((task) => task.title).join(', ')}${RESET}`;
  const gate = item ? gateStatus(item) : undefined;
  const tokens = item?.tokens ? totalTokens(item.tokens) : sumUsage(lane);
  const facts = [
    ...(gate ? [`검증 ${fg(theme, gate.tone === 'ok' ? 'green' : gate.tone === 'fail' ? 'red' : gate.tone === 'warn' ? 'yellow' : 'accent')}${gate.label}${RESET}${muted}`] : []),
    ...(tokens > 0 ? [`토큰 ${compactTokens(tokens)}`] : []),
    ...(lane.changedFiles?.length ? [`파일 ${lane.changedFiles.length}`] : []),
    lane.sessionId ? '세션 있음' : '세션 없음',
  ];
  return box([head, agent, now, `${muted}${facts.join(' · ')}${RESET}`], width, theme, { focused: selected });
}

function integrationCard(plan: DeskPlan, integration: DeskPlanIntegration, width: number, theme: Theme, selected: boolean): string[] {
  const muted = fg(theme, 'muted');
  const inner = width - 4;
  const status = stepStatus(integration.status);
  const head = spread(`${statusMark(status, theme)} ${BOLD}${fg(theme, 'text')}통합${RESET} ${muted}레인 결과를 한 작업 복사본으로 합친다${RESET}`, statusText(status, theme), inner, stringWidth(status.label) + 2);
  const facts = [`파일 ${integration.files.length}`, ...(integration.deleted.length ? [`지움 ${integration.deleted.length}`] : []), ...(integration.checkpoint ? [`체크포인트 ${integration.checkpoint.shortSha}`] : []), integration.sessionId ? '세션 있음' : '세션 없음'];
  const lines = [head, `${muted}${facts.join(' · ')}${RESET}`];
  if (integration.error) lines.push(`${fg(theme, 'red')}${oneLine(integration.error)}${RESET}`);
  else if (plan.status === 'done') lines.push(`${fg(theme, 'teal')}✓ 계획이 끝났습니다${RESET}`);
  return box(lines, width, theme, { focused: selected });
}

/** 카드 여러 장을 가로로 잇는다. 높이가 다르면 짧은 카드 아래를 빈칸으로 채운다 */
function sideBySide(cards: string[][], widths: number[], gap: number): string[] {
  const height = Math.max(...cards.map((card) => card.length));
  const rows: string[] = [];
  for (let row = 0; row < height; row++) rows.push(cards.map((card, index) => card[row] ?? ' '.repeat(widths[index]!)).join(' '.repeat(gap)));
  return rows;
}

function planHeader(plan: DeskPlan, theme: Theme, now: number): string {
  const muted = fg(theme, 'muted');
  const tokens = plan.metrics?.usage ? totalTokens(plan.metrics.usage) : 0;
  const facts = [plan.projectId, `레인 ${plan.lanes.length}`, ...(tokens > 0 ? [`토큰 ${compactTokens(tokens)}`] : []), ago(plan.createdAt, now), ...(plan.issues?.tracking ? [`이슈 ${osc8(plan.issues.tracking.url, `#${plan.issues.tracking.number}`)}`] : [])].filter(Boolean);
  return `  ${statusText(planStatus(plan.status), theme)}  ${BOLD}${fg(theme, 'text')}${oneLine(plan.request)}${RESET}  ${muted}${facts.join(' · ')}${RESET}`;
}

function listScreen(plans: PlansState, rect: Rect, theme: Theme, now: number): string[] {
  const muted = fg(theme, 'muted');
  const list = plans.list ?? [];
  const lines: string[] = [fitAnsi(`  ${BOLD}${fg(theme, 'text')}작업 나누기${RESET}  ${muted}계획 ${list.length} · 요청 하나를 레인 여럿으로 나눠 나란히 돌린다${RESET}`, rect.w)];
  if (plans.error) lines.push(fitAnsi(`  ${fg(theme, 'yellow')}${plans.error}${RESET}`, rect.w));
  lines.push(' '.repeat(rect.w));
  if (list.length === 0) {
    lines.push(fit(plans.loading ? '  계획을 읽는 중…' : '  계획이 없습니다. n으로 새 계획을 만듭니다', rect.w));
    return lines;
  }
  const selected = clampRow(plans.row, list.length);
  const room = Math.max(1, rect.h - lines.length);
  const first = Math.max(0, Math.min(selected - Math.floor(room / 2), list.length - room));
  for (const [index, plan] of list.slice(first, first + room).entries()) {
    const status = planStatus(plan.status);
    const right = `${plan.projectId} · 레인 ${plan.lanes.length} · ${ago(plan.createdAt, now)}`;
    const row = spread(`  ${statusText(status, theme)}${' '.repeat(Math.max(1, 14 - stringWidth(status.label)))}${fg(theme, 'text')}${oneLine(plan.request)}${RESET}`, `${muted}${right}${RESET} `, rect.w, stringWidth(right) + 1);
    lines.push(first + index === selected ? `${bg(theme, 'active')}${fitAnsi(row.replaceAll(RESET, `${RESET}${bg(theme, 'active')}`), rect.w)}${RESET}` : row);
  }
  return lines;
}

function formScreen(plans: PlansState, rect: Rect, theme: Theme): string[] {
  const muted = fg(theme, 'muted');
  const form = plans.form;
  const lines: string[] = [fitAnsi(`  ${BOLD}${fg(theme, 'text')}새 계획${RESET}  ${muted}스튜디오가 요청을 레인으로 나누고, 승인하면 레인마다 세션이 뜹니다${RESET}`, rect.w), ' '.repeat(rect.w)];
  if (!form) return lines;
  if (form.projects.length === 0) {
    lines.push(fit('  프로젝트를 읽는 중…', rect.w));
    return lines;
  }
  lines.push(fit('  프로젝트', rect.w));
  for (const [index, project] of form.projects.entries()) {
    const chosen = index === form.projectIndex;
    const text = `   ${chosen ? '›' : ' '} ${project.name}`;
    lines.push(chosen && form.step === 'project' ? `${bg(theme, 'active')}${fit(text, rect.w)}${RESET}` : fit(text, rect.w));
  }
  lines.push(' '.repeat(rect.w));
  if (form.step === 'request') {
    const head = '  요청> ';
    let text = form.text;
    while (text && stringWidth(head + text) > rect.w - 2) text = [...text].slice(1).join('');
    lines.push(fitAnsi(`${head}${fg(theme, 'text')}${text}${RESET}${form.sending ? '' : `${fg(theme, 'accent')}▏${RESET}`}`, rect.w));
    if (form.sending) lines.push(fit('  계획을 만드는 중… 스튜디오가 레인을 나누면 이 화면에 보입니다', rect.w));
  }
  return lines;
}

function pickerLines(plans: PlansState, width: number, theme: Theme): string[] {
  const choices = plans.choices;
  const picker = plans.picker!;
  if (!choices) return box(['고를 수 있는 AI·계정을 읽는 중…'], width, theme, { title: `${picker.laneId} AI·계정`, focused: true });
  if (choices.length === 0) return box(['고를 수 있는 AI가 없습니다'], width, theme, { title: `${picker.laneId} AI·계정`, focused: true });
  const rows = choices.map((choice, index) => (index === picker.index ? `${bg(theme, 'active')}› ${choice.label}${RESET}` : `  ${choice.label}`));
  return box(rows, width, theme, { title: `${picker.laneId} AI·계정`, focused: true });
}

function detailScreen(state: DeskState, plans: PlansState, rect: Rect, theme: Theme, now: number): string[] {
  const plan = plans.detail!;
  const muted = fg(theme, 'muted');
  const header = [fitAnsi(planHeader(plan, theme, now), rect.w)];
  const problem = plan.error ?? (plan.rejectedReason ? `거부한 까닭: ${plan.rejectedReason}` : undefined) ?? plan.issues?.error;
  if (problem) header.push(fitAnsi(`  ${fg(theme, plan.error ? 'red' : 'yellow')}${oneLine(problem)}${RESET}`, rect.w));
  if (plans.error) header.push(fitAnsi(`  ${fg(theme, 'yellow')}${plans.error}${RESET}`, rect.w));
  header.push(' '.repeat(rect.w));
  if (plan.lanes.length === 0) {
    header.push(fit(plan.status === 'planning' ? '  스튜디오가 요청을 레인으로 나누는 중…' : '  레인이 없습니다', rect.w));
    return header;
  }

  const targets = laneTargets(plan);
  const selected = clampRow(plans.lane, targets.length);
  const selectedLane = targets[selected]?.kind === 'lane' ? (targets[selected] as { lane: DeskPlanLane }).lane.id : undefined;
  const items = new Map(state.items.map((item) => [item.id, item]));
  const body: string[] = [];
  let selectedTop = 0;
  let selectedBottom = 0;
  const usable = Math.max(LANE_MIN, rect.w - 2);
  for (const [index, stage] of planStages(plan).entries()) {
    body.push(fitAnsi(`  ${muted}${index + 1}단계${index > 0 ? ' · 앞 단계의 작업에 기대는 레인' : ''}${RESET}`, rect.w));
    const perRow = Math.max(1, Math.min(stage.length, Math.floor((usable + 1) / (LANE_MIN + 1))));
    for (let at = 0; at < stage.length; at += perRow) {
      const row = stage.slice(at, at + perRow);
      const width = Math.floor((usable - (perRow - 1)) / perRow);
      const cards = row.map((lane) => laneCard(lane, lane.sessionId ? items.get(lane.sessionId) : undefined, width, theme, lane.id === selectedLane, plans.accounts));
      if (row.some((lane) => lane.id === selectedLane)) {
        selectedTop = body.length;
        selectedBottom = body.length + cards[0]!.length;
      }
      for (const line of sideBySide(cards, row.map(() => width), 1)) body.push(fitAnsi(` ${line}`, rect.w));
    }
  }
  if (plan.integration) {
    body.push(fitAnsi(`  ${muted}마지막 · 통합${RESET}`, rect.w));
    const card = integrationCard(plan, plan.integration, usable, theme, targets[selected]?.kind === 'integration');
    if (targets[selected]?.kind === 'integration') {
      selectedTop = body.length;
      selectedBottom = body.length + card.length;
    }
    for (const line of card) body.push(fitAnsi(` ${line}`, rect.w));
  }
  if (plans.picker) {
    // 고르는 창은 고른 레인 카드 바로 아래에 끼운다
    const picker = pickerLines(plans, Math.min(usable, 48), theme).map((line) => fitAnsi(`   ${line}`, rect.w));
    body.splice(selectedBottom, 0, ...picker);
    selectedBottom += picker.length;
  }
  const room = Math.max(1, rect.h - header.length);
  let first = 0;
  if (selectedBottom > room) first = Math.min(selectedTop, selectedBottom - room);
  return [...header, ...body.slice(first, first + room)];
}

/** 작업 나누기 화면. rect는 본문 자리(칸들이 놓이던 곳)다 */
export function plansScreen(state: DeskState, rect: Rect, now = Date.now()): { lines: string[] } {
  const theme = state.theme ?? DEFAULT_THEME;
  const plans = state.plans;
  const blank = ' '.repeat(rect.w);
  let lines: string[] = [];
  if (plans?.mode === 'new') lines = formScreen(plans, rect, theme);
  else if (plans?.mode === 'detail' && plans.detail) lines = detailScreen(state, plans, rect, theme, now);
  else if (plans) lines = listScreen(plans, rect, theme, now);
  const shown = lines.slice(0, rect.h).map((line) => fitAnsi(line, rect.w));
  while (shown.length < rect.h) shown.push(blank);
  return { lines: shown };
}
