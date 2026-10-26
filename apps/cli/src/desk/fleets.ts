/**
 * desk의 여러 AI 비교 화면(#892, 앞글쇠 다음 f). 웹의 Agent Fleet 화면을 터미널로 대신한다(ADR-186).
 *
 * 같은 요청을 2~4개 AI(계정·모델까지 고른다)에 보내고, 참가자마다 카드(그림·상태·검증·바뀐 파일·토큰)로 나란히 보고,
 * 검증을 통과한 참가자 가운데 승자를 고른다. 참가자의 작업 복사본은 desk의 칸에 나란히 열어 직접 들여다본다.
 * 여기는 상태와 받은 키로 다음 상태와 할 일(effects)을 돌려주는 순수 함수와 그리기뿐이다. 스튜디오 API는 desk.ts가 부른다
 */
import { artSize } from './cards';
import { isShellId } from './keys';
import type { KittyImages } from './kitty';
import { fit, fitAnsi, stringWidth } from './screen';
import type { PaneLayout } from './screen';
import { backendLabel, compactTokens, totalTokens, type StatusBadge } from './sidebar';
import { defaultSprite, frameAt, spriteLines, type Sprite } from './sprite';
import { bg, BOLD, fg, RESET, type Theme } from './theme';
import type { DeskAccount, DeskFleet, DeskFleetCandidate, DeskFleetMember, DeskItem } from './types';
import { badge, box, spread, statusMark, statusText, TONE_COLOR } from './widgets';

/** 비교 하나의 참가자 수(스튜디오 fleets.ts의 MAX_MEMBERS와 같다) */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 4;
/** 칸에 열 수 있는 AI: 세션 터미널이 CLI를 띄우는 것(desk.ts의 TERMINAL_BACKENDS와 같다) */
const TERMINAL_BACKENDS: readonly string[] = ['claude-code', 'codex'];
/** 카드 두 열을 놓는 카드 폭의 하한(cards.ts와 같다) */
const CARD_MIN = 52;
const CARD_MAX = 84;

/** 새 비교에서 고를 AI 하나: 백엔드와(계정이 둘 이상인 CLI면) 계정 */
export interface FleetOption {
  backend: string;
  accountId?: string;
  label: string;
}

export interface FleetMemberDraft extends DeskFleetCandidate {
  label: string;
}

export type FleetField = 'project' | 'request' | 'option' | 'model' | 'members' | 'send';
const FIELDS: readonly FleetField[] = ['project', 'request', 'option', 'model', 'members', 'send'];

export interface FleetForm {
  /** 프로젝트·AI 목록을 받는 중 */
  loading?: boolean;
  field: FleetField;
  projects: Array<{ id: string; name: string }>;
  projectIndex: number;
  request: string;
  options: FleetOption[];
  option: number;
  /** 다음에 더할 참가자의 모델(비우면 그 AI의 기본) */
  model: string;
  members: FleetMemberDraft[];
  selectedMember: number;
  sending?: boolean;
  error?: string;
}

export type FleetsConfirm = { kind: 'winner'; fleetId: string; sessionId: string; label: string } | { kind: 'delete'; fleetId: string; request: string };

export interface FleetsState {
  mode: 'list' | 'detail' | 'new';
  fleets: DeskFleet[];
  /** 목록을 받는 중 */
  loading?: boolean;
  /** 목록을 받지 못한 까닭 */
  error?: string;
  /** 목록에서 고른 비교 */
  row: number;
  /** 보는 비교의 id */
  detail?: string;
  /** 보기에서 고른 참가자 */
  member: number;
  form?: FleetForm;
  confirm?: FleetsConfirm;
  /** 아래 줄 알림(다음 키에서 지운다) */
  note?: string;
}

export type FleetsEffect =
  | { type: 'close' }
  /** 목록을 다시 받는다 */
  | { type: 'reload' }
  /** 비교 하나를 다시 받는다 */
  | { type: 'detail'; id: string }
  /** 새 비교 입력에 쓸 프로젝트·AI·계정을 받는다 */
  | { type: 'form' }
  | { type: 'create'; projectId: string; request: string; candidates: DeskFleetCandidate[] }
  | { type: 'winner'; id: string; sessionId: string }
  | { type: 'delete'; id: string }
  /** 참가자의 세션(작업 복사본)을 칸에 나란히 연다 */
  | { type: 'open'; sessionIds: string[] };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j'];
const LEFT = ['\x1b[D', '\x1bOD', 'h'];
const RIGHT = ['\x1b[C', '\x1bOC', 'l'];
const ARROW_UP = ['\x1b[A', '\x1bOA'];
const ARROW_DOWN = ['\x1b[B', '\x1bOB'];
const SHIFT_TAB = '\x1b[Z';
const BACKSPACE = ['\x7f', '\b'];
const ENTER = ['\r', '\n'];

export function openFleets(): FleetsState {
  return { mode: 'list', fleets: [], loading: true, row: 0, member: 0 };
}

/**
 * 새 비교에서 고를 AI. 스튜디오가 허용한 백엔드마다 하나이고, 계정이 둘 이상인 CLI는 계정마다 하나다(새 요청의 고르기와 같은 규칙, #885).
 * 기본 계정(id가 CLI 이름)은 계정 id를 싣지 않는다
 */
export function fleetOptions(backends: readonly string[], accounts: readonly DeskAccount[]): FleetOption[] {
  const options: FleetOption[] = [];
  for (const backend of backends) {
    const mine = accounts.filter((account) => account.backend === backend);
    if (mine.length <= 1) {
      options.push({ backend, label: backendLabel(backend) });
      continue;
    }
    for (const account of mine) {
      const builtin = account.builtin === true || account.id === backend;
      options.push({ backend, ...(builtin ? {} : { accountId: account.id }), label: `${backendLabel(backend)} · ${account.name}` });
    }
  }
  return options;
}

/** 칸에 열 수 있는 참가자: 세션을 만들었고(`failed-`가 아니고) 터미널로 CLI를 띄우는 AI */
export function openableMembers(fleet: DeskFleet): DeskFleetMember[] {
  return fleet.members.filter((member) => !member.sessionId.startsWith('failed-') && TERMINAL_BACKENDS.includes(member.backend));
}

/**
 * 참가자 세션을 칸에 나란히 놓는다. 참가자 수에 맞게 칸 수(1·2·4)를 늘리고, 셸 칸은 그 자리에 둔 채 나머지 칸에 놓는다.
 * 다른 세션 칸은 비운다(세션은 계속 돈다). 자리가 모자라면 까닭을 돌려준다
 */
export function placeMembers(desk: { layout: PaneLayout; focus: number; slots: ReadonlyArray<string | undefined> }, ids: readonly string[]): { layout: PaneLayout; focus: number; slots: Array<string | undefined> } | { error: string } {
  for (const layout of [1, 2, 4] as const) {
    const free = desk.slots.map((id, slot) => (slot < layout && !isShellId(id) ? slot : -1)).filter((slot) => slot >= 0);
    if (free.length < ids.length) continue;
    const slots = desk.slots.map((id) => (isShellId(id) ? id : undefined));
    ids.forEach((id, index) => {
      slots[free[index]!] = id;
    });
    return { layout, focus: free[0]!, slots };
  }
  return { error: '셸 칸이 칸을 차지하고 있어 참가자를 다 놓을 수 없습니다. Ctrl-b x로 셸 칸을 비운 뒤 다시 엽니다' };
}

/** 참가자의 상태 */
export function memberStatus(member: DeskFleetMember): StatusBadge {
  switch (member.status) {
    case 'done':
      return { label: '검증 통과', tone: 'ok' };
    case 'failed':
      return { label: '검증 실패', tone: 'fail' };
    case 'error':
      return { label: '오류', tone: 'fail' };
    case 'running':
      return { label: '작업 중', tone: 'busy' };
    case 'booting':
      return { label: '켜는 중', tone: 'busy' };
    case 'cancelled':
      return { label: '그만둠', tone: 'muted' };
    case 'awaiting_input':
      return { label: '답 기다림', tone: 'warn' };
  }
}

function within(value: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), value));
}

function selectedFleet(state: FleetsState): DeskFleet | undefined {
  return state.mode === 'detail' ? state.fleets.find((fleet) => fleet.id === state.detail) : state.fleets[state.row];
}

export function fleetsKey(start: FleetsState, key: string): { state: FleetsState | undefined; effects: FleetsEffect[] } {
  const effects: FleetsEffect[] = [];
  const state: FleetsState = start.note ? { ...start, note: undefined } : start;
  if (state.confirm) return { state: confirmKey(state, key, effects), effects };
  if (state.mode === 'new') return { state: formKey(state, key, effects), effects };
  if (state.mode === 'detail') return { state: detailKey(state, key, effects), effects };
  // 목록
  if (key === ESC || key === 'q') {
    effects.push({ type: 'close' });
    return { state: undefined, effects };
  }
  if (UP.includes(key)) return { state: { ...state, row: within(state.row - 1, state.fleets.length) }, effects };
  if (DOWN.includes(key)) return { state: { ...state, row: within(state.row + 1, state.fleets.length) }, effects };
  if (ENTER.includes(key)) {
    const fleet = state.fleets[state.row];
    if (!fleet) return { state, effects };
    effects.push({ type: 'detail', id: fleet.id });
    return { state: { ...state, mode: 'detail', detail: fleet.id, member: 0 }, effects };
  }
  if (key === 'n') {
    effects.push({ type: 'form' });
    return { state: { ...state, mode: 'new', form: { loading: true, field: 'project', projects: [], projectIndex: 0, request: '', options: [], option: 0, model: '', members: [], selectedMember: 0 } }, effects };
  }
  if (key === 'd' || key === 'x') {
    const fleet = state.fleets[state.row];
    return { state: fleet ? { ...state, confirm: { kind: 'delete', fleetId: fleet.id, request: fleet.request } } : state, effects };
  }
  if (key === 'r') {
    effects.push({ type: 'reload' });
    return { state: { ...state, note: '다시 읽는 중…' }, effects };
  }
  return { state, effects };
}

function confirmKey(state: FleetsState, key: string, effects: FleetsEffect[]): FleetsState {
  const confirm = state.confirm!;
  if (key === 'y' || key === 'Y' || ENTER.includes(key)) {
    if (confirm.kind === 'winner') effects.push({ type: 'winner', id: confirm.fleetId, sessionId: confirm.sessionId });
    else effects.push({ type: 'delete', id: confirm.fleetId });
    return { ...state, confirm: undefined, note: confirm.kind === 'winner' ? '승자를 고르는 중…' : '지우는 중…' };
  }
  return { ...state, confirm: undefined, note: '그만두었습니다' };
}

function detailKey(state: FleetsState, key: string, effects: FleetsEffect[]): FleetsState {
  const fleet = selectedFleet(state);
  if (key === ESC || key === 'q') return { ...state, mode: 'list', detail: undefined, member: 0 };
  if (!fleet) return state;
  const count = fleet.members.length;
  if (UP.includes(key) || LEFT.includes(key)) return { ...state, member: within(state.member - 1, count) };
  if (DOWN.includes(key) || RIGHT.includes(key)) return { ...state, member: within(state.member + 1, count) };
  const member = fleet.members[state.member];
  if (ENTER.includes(key) || key === 'o') {
    if (!member) return state;
    if (member.sessionId.startsWith('failed-')) return { ...state, note: '세션을 만들지 못한 참가자라 열 세션이 없습니다' };
    if (!TERMINAL_BACKENDS.includes(member.backend)) return { ...state, note: `${backendLabel(member.backend)} 참가자는 터미널 칸으로 열지 않습니다(띄울 CLI가 없습니다)` };
    effects.push({ type: 'open', sessionIds: [member.sessionId] });
    return state;
  }
  if (key === 'a') {
    const ids = openableMembers(fleet).map((entry) => entry.sessionId);
    if (ids.length === 0) return { ...state, note: '칸에 열 수 있는 참가자가 없습니다' };
    effects.push({ type: 'open', sessionIds: ids });
    return state;
  }
  if (key === 'w') {
    if (!member) return state;
    if (member.status !== 'done') return { ...state, note: '검증을 통과한 참가자만 승자로 고릅니다' };
    return { ...state, confirm: { kind: 'winner', fleetId: fleet.id, sessionId: member.sessionId, label: member.label } };
  }
  if (key === 'd' || key === 'x') return { ...state, confirm: { kind: 'delete', fleetId: fleet.id, request: fleet.request } };
  if (key === 'r') {
    effects.push({ type: 'detail', id: fleet.id });
    return state;
  }
  return state;
}

function formKey(state: FleetsState, key: string, effects: FleetsEffect[]): FleetsState {
  const form = state.form!;
  if (key === ESC || key === '\x03') return { ...state, mode: 'list', form: undefined, note: '새 비교를 닫았습니다' };
  if (form.loading || form.sending) return state;
  const at = FIELDS.indexOf(form.field);
  const go = (field: FleetField): FleetsState => ({ ...state, form: { ...form, field, error: undefined } });
  if (key === '\t') return go(FIELDS[(at + 1) % FIELDS.length]!);
  if (key === SHIFT_TAB) return go(FIELDS[(at + FIELDS.length - 1) % FIELDS.length]!);
  const set = (patch: Partial<FleetForm>): FleetsState => ({ ...state, form: { ...form, error: undefined, ...patch } });
  switch (form.field) {
    case 'project':
      if (ARROW_UP.includes(key)) return set({ projectIndex: within(form.projectIndex - 1, form.projects.length) });
      if (ARROW_DOWN.includes(key)) return set({ projectIndex: within(form.projectIndex + 1, form.projects.length) });
      if (ENTER.includes(key)) return go('request');
      return state;
    case 'request':
    case 'model': {
      const name = form.field;
      if (ENTER.includes(key)) return go(FIELDS[at + 1]!);
      if (BACKSPACE.includes(key)) return set({ [name]: [...form[name]].slice(0, -1).join('') });
      if (key.startsWith(ESC) || key.codePointAt(0)! < 32) return state;
      return set({ [name]: form[name] + key });
    }
    case 'option': {
      if (ARROW_UP.includes(key) || key === 'k') return set({ option: within(form.option - 1, form.options.length) });
      if (ARROW_DOWN.includes(key) || key === 'j') return set({ option: within(form.option + 1, form.options.length) });
      if (ENTER.includes(key) || key === ' ') {
        const option = form.options[form.option];
        if (!option) return state;
        if (form.members.length >= MAX_MEMBERS) return { ...state, form: { ...form, error: `참가자는 넷까지입니다(${MAX_MEMBERS}개)` } };
        const model = form.model.trim();
        const member: FleetMemberDraft = {
          backend: option.backend,
          ...(option.accountId ? { accountId: option.accountId } : {}),
          ...(model ? { model } : {}),
          label: model ? `${option.label} · ${model}` : option.label,
        };
        return set({ members: [...form.members, member], selectedMember: form.members.length });
      }
      return state;
    }
    case 'members':
      if (ARROW_UP.includes(key) || key === 'k') return set({ selectedMember: within(form.selectedMember - 1, form.members.length) });
      if (ARROW_DOWN.includes(key) || key === 'j') return set({ selectedMember: within(form.selectedMember + 1, form.members.length) });
      if (key === 'd' || key === 'x' || BACKSPACE.includes(key)) {
        if (form.members.length === 0) return state;
        const members = form.members.filter((_, index) => index !== form.selectedMember);
        return set({ members, selectedMember: within(form.selectedMember, members.length) });
      }
      return state;
    case 'send': {
      if (!ENTER.includes(key)) return state;
      const project = form.projects[form.projectIndex];
      const request = form.request.trim();
      if (!project) return { ...state, form: { ...form, error: '프로젝트가 없습니다' } };
      if (!request) return { ...state, form: { ...form, error: '요청을 쓰세요' } };
      if (form.members.length < MIN_MEMBERS) return { ...state, form: { ...form, error: `참가자를 ${MIN_MEMBERS}~${MAX_MEMBERS}개 더하세요(AI 칸에서 Enter)` } };
      const candidates = form.members.map(({ backend, accountId, model }) => ({ backend, ...(accountId ? { accountId } : {}), ...(model ? { model } : {}) }));
      effects.push({ type: 'create', projectId: project.id, request, candidates });
      return { ...state, form: { ...form, sending: true, error: undefined } };
    }
  }
}

/** 붙여 넣은 글: 새 비교의 요청·모델 칸이면 한 줄로 넣는다. 그 밖에는 버린다 */
export function fleetsPaste(state: FleetsState, text: string): FleetsState {
  const form = state.form;
  if (state.mode !== 'new' || !form || form.loading || form.sending || (form.field !== 'request' && form.field !== 'model')) return state;
  const clean = text.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
  return { ...state, form: { ...form, [form.field]: form[form.field] + clean } };
}

/** 아래 줄 안내 */
export function fleetsHint(state: FleetsState): string {
  if (state.confirm) {
    return state.confirm.kind === 'winner'
      ? ` ${state.confirm.label}을(를) 승자로 고를까요? · y 고르기 · 다른 키 그만두기`
      : ` 이 비교와 참가자 세션을 모두 지울까요? 되돌릴 수 없습니다 · y 지우기 · 다른 키 그만두기`;
  }
  if (state.note) return ` ${state.note}`;
  if (state.mode === 'new') return ' 새 비교 · Tab 다음 칸 · ↑↓ 고르기 · AI 칸에서 Enter 참가자 더하기 · 참가자 칸에서 d 빼기 · 보내기에서 Enter · Esc 닫기';
  if (state.mode === 'detail') return ' 비교 보기 · ←→ 참가자 · Enter 칸에 열기 · a 모두 나란히 · w 승자 고르기 · r 다시 읽기 · d 지우기 · Esc 목록';
  return ' 여러 AI 비교 · ↑↓ 고르기 · Enter 보기 · n 새 비교 · r 다시 읽기 · d 지우기 · Esc 닫기';
}

export interface FleetsContext {
  items: readonly DeskItem[];
  theme: Theme;
  /** 카드 그림(세션 id, AI 이름, default 차례로 찾는다) */
  sprites: Readonly<Record<string, Sprite>>;
  spriteClock: number;
  kitty?: KittyImages;
  now?: number;
}

/** 여러 AI 비교 화면. 줄마다 정확히 size.w칸이고 size.h줄이다 */
export function renderFleets(state: FleetsState, context: FleetsContext, size: { w: number; h: number }): { lines: string[]; cursor?: { x: number; y: number } } {
  const out = state.mode === 'new' ? formLines(state, context.theme, size.w) : state.mode === 'detail' ? { lines: detailLines(state, context, size) } : { lines: listLines(state, context.theme, size) };
  const lines = out.lines.slice(0, size.h).map((line) => fitAnsi(line, size.w));
  while (lines.length < size.h) lines.push(' '.repeat(size.w));
  const cursor = 'cursor' in out && out.cursor && out.cursor.y < size.h ? out.cursor : undefined;
  return { lines, ...(cursor ? { cursor } : {}) };
}

function heading(title: string, sub: string, theme: Theme): string {
  return `  ${BOLD}${fg(theme, 'text')}${title}${RESET}  ${fg(theme, 'muted')}${sub}${RESET}`;
}

function shortDate(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function listLines(state: FleetsState, theme: Theme, size: { w: number; h: number }): string[] {
  const muted = fg(theme, 'muted');
  const lines = [heading('여러 AI 비교', `${state.fleets.length}개 · 같은 요청을 여러 AI에 보내 나란히 보고 승자를 고릅니다`, theme), ''];
  if (state.loading) return [...lines, `  ${muted}비교 목록을 받는 중…${RESET}`];
  if (state.error) lines.push(`  ${fg(theme, 'red')}목록을 받지 못했습니다: ${state.error}${RESET}`, '');
  if (state.fleets.length === 0) return [...lines, `  ${muted}아직 비교가 없습니다. n으로 새 비교를 만듭니다${RESET}`];
  // 비교 하나에 두 줄. 고른 비교가 보이게 위를 건너뛴다
  const room = Math.max(2, size.h - lines.length);
  const per = 3;
  const first = Math.max(0, Math.min(state.row - Math.floor(room / per) + 1, state.fleets.length - Math.floor(room / per)));
  state.fleets.slice(first).forEach((fleet, offset) => {
    const selected = first + offset === state.row;
    const right = `${fleet.projectName} · ${shortDate(fleet.createdAt)}`;
    const marker = selected ? `${fg(theme, 'accent')}›${RESET}` : ' ';
    const top = spread(` ${marker} ${BOLD}${fg(theme, 'text')}${fleet.request.replace(/\s+/g, ' ')}${RESET}`, `${muted}${right}${RESET}`, size.w - 1, stringWidth(right));
    const members = fleet.members.map((member) => `${statusMark(memberStatus(member), theme)} ${backendLabel(member.backend)} ${member.label}`).join(`${muted} · ${RESET}`);
    const winner = fleet.members.find((member) => member.sessionId === fleet.winnerSessionId);
    const crown = winner ? `  ${fg(theme, 'yellow')}★ 승자 ${winner.label}${RESET}` : '';
    // 고른 비교는 두 줄 모두 줄 끝까지 바탕을 칠한다(색을 되돌리는 자리마다 바탕을 다시 건다)
    const paint = (text: string) => (selected ? fitAnsi(bg(theme, 'active') + text.replaceAll(RESET, RESET + bg(theme, 'active')), size.w, bg(theme, 'active')) : text);
    lines.push(paint(top), paint(`    ${members}${crown}`), '');
  });
  return lines;
}

/** 참가자 카드 안쪽의 글: 첫 줄(이름·AI·승자, 오른쪽에 상태)과 그 아래 줄들 */
function memberBody(member: DeskFleetMember, item: DeskItem | undefined, winner: boolean, theme: Theme, now: number, width: number): string[] {
  const muted = fg(theme, 'muted');
  const status = memberStatus(member);
  const crown = winner ? ` ${fg(theme, 'yellow')}★ 승자${RESET}` : '';
  const title = `${BOLD}${fg(theme, 'text')}${member.label}${RESET} ${badge(backendLabel(member.backend), theme)}${crown}`;
  const main = item?.agents?.find((agent) => agent.kind === 'main');
  const doing =
    member.status === 'running' && main?.activity
      ? `${muted}지금${RESET} ${main.activity}`
      : member.summary
        ? `${member.status === 'error' || member.status === 'failed' ? fg(theme, 'red') : muted}${member.summary.replace(/\s+/g, ' ')}${RESET}`
        : `${muted}${member.status === 'booting' ? '작업 복사본을 준비하는 중' : '기록 없음'}${RESET}`;
  const facts: string[] = [];
  if (member.checkpoint) facts.push(`${muted}바뀐 파일${RESET} ${member.checkpoint.files.length}`);
  if (member.usage && totalTokens(member.usage) > 0) facts.push(`${muted}토큰${RESET} ${compactTokens(totalTokens(member.usage))}`);
  if (member.costUsd !== undefined && member.costUsd > 0) facts.push(`$${member.costUsd.toFixed(2)}`);
  if (member.turns) facts.push(`${muted}턴${RESET} ${member.turns}`);
  const took = member.startedAt ? (Date.parse(member.finishedAt ?? new Date(now).toISOString()) - Date.parse(member.startedAt)) / 60_000 : undefined;
  if (took !== undefined && Number.isFinite(took) && took >= 0) facts.push(`${muted}${member.finishedAt ? '걸린 시간' : '지난 시간'}${RESET} ${took < 1 ? '1분 안' : `${Math.round(took)}분`}`);
  const files = member.checkpoint?.files.length ? `${muted}${member.checkpoint.files.join(', ')}${RESET}` : '';
  return [spread(title, statusText(status, theme), width, stringWidth(status.label) + 2), doing, facts.length ? facts.join(`${muted} · ${RESET}`) : `${muted}아직 결과 없음${RESET}`, files];
}

function detailLines(state: FleetsState, context: FleetsContext, size: { w: number; h: number }): string[] {
  const { theme } = context;
  const muted = fg(theme, 'muted');
  const fleet = selectedFleet(state);
  if (!fleet) return [heading('여러 AI 비교', '', theme), '', `  ${muted}비교를 받는 중…${RESET}`];
  const winner = fleet.members.find((member) => member.sessionId === fleet.winnerSessionId);
  const lines = [
    `  ${BOLD}${fg(theme, 'text')}${fleet.request.replace(/\s+/g, ' ')}${RESET}`,
    `  ${muted}${fleet.projectName} · 참가자 ${fleet.members.length} · ${shortDate(fleet.createdAt)}${RESET}${winner ? `  ${fg(theme, 'yellow')}★ 승자 ${winner.label}${RESET}` : ''}`,
    '',
  ];
  const now = context.now ?? Date.now();
  const columns = size.w - 2 >= CARD_MIN * 2 + 1 ? 2 : 1;
  const cardWidth = Math.min(CARD_MAX, Math.max(30, Math.floor((size.w - 2 - (columns - 1)) / columns)));
  const art = artSize(cardWidth);
  const textWidth = Math.max(1, cardWidth - 4 - art.cols - 2);
  const cards = fleet.members.map((member, index) => {
    const item = context.items.find((entry) => entry.id === member.sessionId);
    const sprite = context.sprites[member.sessionId] ?? context.sprites[member.backend] ?? context.sprites.default ?? defaultSprite(member.backend);
    const frame = frameAt(sprite, context.spriteClock);
    const picture = context.kitty ? context.kitty.art(sprite, frame, art.cols, art.rows) : spriteLines(sprite, art.cols, art.rows, theme, frame);
    const body = memberBody(member, item, member.sessionId === fleet.winnerSessionId, theme, now, textWidth);
    const rows = Math.max(art.rows, body.length);
    const inner: string[] = [];
    for (let row = 0; row < rows; row++) inner.push(`${picture[row] ?? ' '.repeat(art.cols)}  ${fitAnsi(body[row] ?? '', textWidth)}`);
    return box(inner, cardWidth, theme, { focused: index === state.member });
  });
  // 카드를 줄로 묶고, 고른 카드가 든 줄이 보이게 위 줄을 건너뛴다
  const gridRows: string[][][] = [];
  for (let at = 0; at < cards.length; at += columns) gridRows.push(cards.slice(at, at + columns));
  const heights = gridRows.map((row) => Math.max(...row.map((card) => card.length)));
  const target = Math.floor(state.member / columns);
  const room = size.h - lines.length;
  let first = 0;
  const span = (from: number, to: number) => heights.slice(from, to + 1).reduce((sum, height) => sum + height, 0);
  while (first < target && span(first, target) > room) first++;
  for (let row = first; row < gridRows.length; row++) {
    for (let y = 0; y < heights[row]!; y++) lines.push(` ${gridRows[row]!.map((card) => card[y] ?? ' '.repeat(cardWidth)).join(' ')}`);
  }
  return lines;
}

function formLines(state: FleetsState, theme: Theme, width: number): { lines: string[]; cursor?: { x: number; y: number } } {
  const form = state.form!;
  const muted = fg(theme, 'muted');
  const lines = [heading('새 비교', `같은 요청을 ${MIN_MEMBERS}~${MAX_MEMBERS}개 AI에 보내 나란히 봅니다`, theme), ''];
  if (form.loading) return { lines: [...lines, `  ${muted}프로젝트와 AI 목록을 받는 중…${RESET}`] };
  let cursor: { x: number; y: number } | undefined;
  const label = (field: FleetField, text: string) => {
    const on = form.field === field;
    return `${on ? `${fg(theme, 'accent')}›` : ' '} ${on ? BOLD : muted}${fit(text, 8)}${RESET} `;
  };
  const head = (field: FleetField, text: string) => `  ${label(field, text)}`;
  const project = form.projects[form.projectIndex];
  lines.push(head('project', '프로젝트') + (project ? `‹${project.name}›` : `${muted}프로젝트가 없습니다${RESET}`) + (form.field === 'project' ? `  ${muted}↑↓ 고르기${RESET}` : ''));
  const textRow = (field: 'request' | 'model', name: string, hint: string) => {
    const prefix = head(field, name);
    let value = form[field];
    const room = Math.max(1, width - stringWidth(prefix) - 1);
    while (value && stringWidth(value) > room) value = [...value].slice(1).join('');
    if (form.field === field) cursor = { x: stringWidth(prefix) + stringWidth(value), y: lines.length };
    lines.push(prefix + (value || (form.field === field ? '' : `${muted}${hint}${RESET}`)));
  };
  textRow('request', '요청', '여러 AI에 보낼 요청');
  const option = form.options[form.option];
  lines.push(head('option', 'AI') + (option ? `‹${option.label}›` : `${muted}고를 AI가 없습니다${RESET}`) + (form.field === 'option' ? `  ${muted}↑↓ 고르기 · Enter 참가자 더하기${RESET}` : ''));
  textRow('model', '모델', '비우면 그 AI의 기본 모델');
  lines.push(head('members', '참가자') + `${form.members.length}/${MAX_MEMBERS}`);
  form.members.forEach((member, index) => {
    const on = form.field === 'members' && index === form.selectedMember;
    lines.push(`             ${on ? `${bg(theme, 'active')}` : ''}${index + 1}. ${member.label}${RESET}`);
  });
  if (form.members.length === 0) lines.push(`             ${muted}AI 칸에서 Enter로 더합니다. 같은 AI를 두 번 넣으면 독립 시도 둘을 비교합니다${RESET}`);
  const repeated = new Set(form.members.map((member) => `${member.backend}@${member.accountId ?? ''}@${member.model ?? ''}`)).size < form.members.length;
  if (repeated) lines.push(`             ${muted}같은 참가자가 둘 이상이면 서로 독립된 시도입니다${RESET}`);
  lines.push('', `  ${label('send', '보내기')}${form.sending ? `${muted}보내는 중…${RESET}` : `${muted}Enter로 만듭니다(CLI 로그인을 먼저 확인합니다)${RESET}`}`);
  if (form.error) lines.push('', `  ${fg(theme, TONE_COLOR.fail)}${form.error}${RESET}`);
  return { lines, ...(cursor ? { cursor } : {}) };
}
