/**
 * 에이전트 안(#1411): 세션 하나 안을 깊이로 본다. 나무(m)는 길잡이, 카드는 내용, Enter로 들어가고 Esc로 나온다.
 *  - 깊이 1: 그 세션의 메인 카드 하나와 서브에이전트마다 카드 하나. 카드마다 그림·이름·상태·지금 하는 일과 코드 조각
 *    (가장 최근 항목이 고치기·쓰기면 파일 이름과 -/+ 줄, 실행이면 명령과 결과 끝 줄, 읽기·찾기면 최근 대상).
 *  - 깊이 2: 에이전트 하나의 활동 기록. 항목을 시간순으로(시각·도구·대상·상태·걸린 시간), 고치기·쓰기는 diff, 실행은 명령과 결과.
 * 스튜디오의 활동 기록(`GET /api/sessions/:id/agents/activity`)을 열려 있는 동안만 받는다(받는 일은 desk.ts가 한다).
 * 이 화면은 보기만 한다: 서브에이전트를 멈추거나 조종하지 않는다.
 *
 * 기록의 글은 모두 서버가 준 것(CLI가 훅으로 보낸 코드와 명령 결과)이라 그리기 전에 cleanText로 제어 글자와 ANSI를 지운다.
 * 그릴 줄 수에는 상한이 있다(항목 수, 항목마다의 변경·줄 수, 한 에이전트의 총 줄 수). 키와 그림은 순수 함수다
 */
import { agentQuiet, artSize, clipWords, compose, forText, nowLine, oneLine, spanText, spriteFor, subagentSpriteFor, subagentsOf, type Seg } from './cards';
import type { DeskState } from './keys';
import type { KittyImages } from './kitty';
import { fitAnsi, stringWidth, type Rect } from './screen';
import { backendLabel, headStatus, subagentName, toolLabel, toolLineLabel, type StatusBadge } from './sidebar';
import { frameAt, spriteLines } from './sprite';
import { BOLD, DEFAULT_THEME, fg, RESET, type ColorToken, type Theme } from './theme';
import type { ActivityChangeView, ActivityEntryView, ActivityLogView, ActivityWithheldView, AgentActivityLogView, DeskAgent, DeskItem } from './types';
import { box, statusText } from './widgets';

/** 한 에이전트에서 읽는 항목 수의 상한(뒤에서부터). 서버가 더 줘도 이만큼만 다룬다 */
export const MAX_ENTRIES = 200;
/** 받은 에이전트 수의 상한 */
const MAX_AGENTS = 40;
/** 카드로 그리는 에이전트 수의 상한 */
const MAX_CARDS = 24;
/** 항목 하나에서 그리는 변경(파일) 수의 상한 */
const MAX_CHANGES = 10;
/** 변경 하나에서 그리는 diff 줄 수의 상한 */
const MAX_DIFF_LINES = 60;
/** 실행 항목에서 그리는 명령·결과 줄 수의 상한 */
const MAX_COMMAND_LINES = 8;
const MAX_OUTPUT_LINES = 12;
/** 깊이 2에서 한 에이전트에 만드는 줄 수의 상한(넘으면 앞을 버린다) */
export const MAX_ACTIVITY_LINES = 2000;
/** 글 한 줄에서 쓰는 글자 수의 상한 */
const MAX_LINE_CHARS = 400;
/** 글 한 덩어리(diff 한쪽, 명령 결과)에서 읽는 글자 수의 상한 */
const MAX_BLOCK_CHARS = 24_000;
/** 카드 하나의 코드 조각 줄 수의 범위 */
const PREVIEW_MAX = 6;
const PREVIEW_MIN = 3;
/** 카드 폭의 하한·상한과 그림 자리 */
const CARD_MIN = 44;
const CARD_MAX = 84;
const ART = { cols: 12, rows: 5 } as const;
const ART_MIN_CARD = 36;
const PAGE = 10;

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA', 'k', '\x10'];
const DOWN = ['\x1b[B', '\x1bOB', 'j', '\x0e'];
const LEFT = ['\x1b[D', '\x1bOD', 'h'];
const RIGHT = ['\x1b[C', '\x1bOC', 'l'];
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const HOME = ['\x1b[H', '\x1b[1~', 'g'];
const END = ['\x1b[F', '\x1b[4~', 'G'];

export interface InsideState {
  /** 들어온 세션 */
  id: string;
  title: string;
  depth: 1 | 2;
  /** 깊이 1에서 고른 카드의 자리(agent가 목록에 없을 때의 대비) */
  cursor: number;
  /** 고른 카드의 에이전트 id(메인은 'main'). 깊이 2에서는 보는 에이전트 */
  agent?: string;
  /** 깊이 2에서 맨 아래에서 위로 올라간 줄 수. 0이면 맨 아래를 따라간다 */
  up: number;
  data?: ActivityLogView;
  loading: boolean;
  /** 마지막 받기가 실패한 까닭. 자료는 마지막으로 받은 것을 그대로 둔다 */
  error?: string;
  /** 스튜디오가 이 API를 모른다(옛 판) */
  gone?: true;
  /** 방금 한 일의 알림 한 줄(칸에 고정했다 등). 다음 키에 지운다 */
  note?: string;
}

/** 이 화면이 읽는 desk 상태 */
export type InsideSource = Pick<DeskState, 'items' | 'inside'> & Partial<Pick<DeskState, 'theme' | 'sprites' | 'spriteClock' | 'kitty'>>;

export function openInside(id: string, title: string, options: { depth?: 1 | 2; agent?: string } = {}): InsideState {
  return { id, title, depth: options.depth ?? 1, cursor: 0, agent: options.agent ?? 'main', up: 0, loading: true };
}

// ─── 서버 글 다루기 ───

/** 서버가 준 글에서 지울 것: OSC·CSI·그 밖의 ESC 열, 제어 글자(줄바꿈 제외), 보이지 않게 글을 꾸미는 문자 */
const UNSAFE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[@-Z\\-_]?|\x9b[0-?]*[ -/]*[@-~]?|[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** 서버가 준 글을 화면에 낼 꼴로: 탭은 빈칸 넷, 제어 글자·ANSI는 지운다(줄바꿈은 남는다) */
export function cleanText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\t/g, '    ').replace(UNSAFE, '');
}

/** 한 줄 글: 정리하고 길이를 자른다 */
export function safeLine(text: unknown, max = MAX_LINE_CHARS): string {
  const clean = cleanText(typeof text === 'string' ? text.slice(0, max * 4) : '').replace(/\n/g, ' ');
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : clean;
}

/** 여러 줄 글을 줄로 나눈다. 읽는 글자 수와 줄 길이에 상한을 둔다 */
function blockLines(text: unknown): string[] {
  if (typeof text !== 'string' || text === '') return [];
  return text.slice(0, MAX_BLOCK_CHARS).split('\n').map((line) => safeLine(line));
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 받은 자료를 다룰 만한 꼴로 거른다: 모르는 꼴은 버리고 수에 상한을 둔다 */
export function normalizeActivity(raw: unknown): ActivityLogView {
  const agents: AgentActivityLogView[] = [];
  for (const entry of list<Record<string, unknown>>((raw as { agents?: unknown } | undefined)?.agents).slice(0, MAX_AGENTS)) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
    const entries = list<ActivityEntryView>(entry.entries)
      .filter((item) => item && typeof item === 'object' && typeof item.tool === 'string' && typeof item.at === 'string')
      .slice(-MAX_ENTRIES);
    agents.push({
      id: entry.id,
      ...(entry.main === true ? { main: true as const } : {}),
      ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(entry.state === 'working' || entry.state === 'done' ? { state: entry.state } : {}),
      entries,
    });
  }
  return { agents };
}

// ─── 카드 모으기 ───

export interface InsideCard {
  /** 카드의 에이전트 id(메인은 'main', 서브에이전트는 목록의 id) */
  id: string;
  main?: true;
  agent?: DeskAgent;
  log?: AgentActivityLogView;
}

/** 목록의 서브에이전트 id에서 기록의 id로: 스튜디오가 `claude:agent:` 머리를 붙여 보낸다 */
export function logIdOf(agent: DeskAgent): string {
  return agent.id.startsWith('claude:agent:') ? agent.id.slice('claude:agent:'.length) : agent.id;
}

/** 카드 목록: 메인 하나, 서브에이전트마다 하나, 목록에는 없고 기록에만 있는 서브에이전트가 끝에 붙는다 */
export function insideCards(item: DeskItem, data: ActivityLogView | undefined): InsideCard[] {
  const logs = list<AgentActivityLogView>(data?.agents);
  const byId = new Map(logs.map((log) => [log.id, log]));
  const mainLog = logs.find((log) => log.main === true || log.id === 'main');
  const used = new Set<string>(mainLog ? [mainLog.id] : []);
  const cards: InsideCard[] = [{ id: 'main', main: true, ...(mainLog ? { log: mainLog } : {}) }];
  for (const agent of subagentsOf(item)) {
    const log = byId.get(logIdOf(agent));
    if (log) used.add(log.id);
    cards.push({ id: agent.id, agent, ...(log ? { log } : {}) });
  }
  for (const log of logs) if (!used.has(log.id)) cards.push({ id: log.id, log });
  return cards.slice(0, MAX_CARDS);
}

export function cardName(card: InsideCard, item: DeskItem): string {
  if (card.main) return safeLine(item.title);
  if (card.agent) return safeLine(subagentName(card.agent) || '서브에이전트');
  const log = card.log;
  return safeLine([log?.type ? toolLikeType(log.type) : '', log?.description].filter(Boolean).join(' ') || '서브에이전트');
}

function toolLikeType(type: string): string {
  return subagentName({ id: '', name: type, type, kind: 'subagent', state: 'idle', tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
}

function cardsOf(source: InsideSource): InsideCard[] {
  const inside = source.inside;
  const item = inside ? source.items.find((entry) => entry.id === inside.id) : undefined;
  return item ? insideCards(item, inside!.data) : [];
}

function cursorAt(inside: InsideState, cards: readonly InsideCard[]): number {
  if (cards.length === 0) return 0;
  const found = inside.agent === undefined ? -1 : cards.findIndex((card) => card.id === inside.agent);
  return found >= 0 ? found : Math.max(0, Math.min(cards.length - 1, inside.cursor));
}

// ─── 받은 자료 넣기 ───

/** 한 에이전트의 깊이 2 줄 수(맨 아래에서 올라간 줄 수를 새 항목이 와도 같은 자리에 두려고 센다) */
function activityCount(inside: InsideState, data: ActivityLogView | undefined): number {
  if (inside.depth !== 2) return 0;
  const log = logOf(inside, data);
  return log ? activityLines(log, DEFAULT_THEME, 0).length : 0;
}

function logOf(inside: InsideState, data: ActivityLogView | undefined): AgentActivityLogView | undefined {
  const id = inside.agent === 'main' ? 'main' : inside.agent;
  return list<AgentActivityLogView>(data?.agents).find((log) => log.id === id || (id !== undefined && `claude:agent:${log.id}` === id) || (id === 'main' && log.main === true));
}

/** 받은 자료를 넣는다. 위로 읽는 중이면 새 항목이 와도 보던 자리를 지킨다 */
export function insideLoaded(inside: InsideState, raw: unknown): InsideState {
  const data = normalizeActivity(raw);
  const grown = inside.up > 0 ? activityCount(inside, data) - activityCount(inside, inside.data) : 0;
  return { ...inside, data, loading: false, error: undefined, gone: undefined, up: Math.max(0, inside.up + grown) };
}

/** 받기에 실패했다. 마지막 자료는 그대로 두고 까닭만 남긴다. 처음부터 404면 옛 스튜디오로 본다 */
export function insideFailed(inside: InsideState, failure: { status?: number; message: string }): InsideState {
  const gone = failure.status === 404 && inside.data === undefined;
  return { ...inside, loading: false, error: safeLine(failure.message, 200) || '알 수 없는 오류', ...(gone ? { gone: true as const } : {}) };
}

// ─── 키 ───

/** 키 하나. 닫으면 state가 없다. terminal이면 메인 카드를 골라 Enter한 것이라 부르는 쪽이 그 세션의 터미널을 연다 */
export function insideKey(source: InsideSource, key: string): { state?: InsideState; terminal?: true; help?: true; pin?: string } {
  const inside = source.inside!;
  if (key === '\x03') return {};
  if (key === '?') return { state: inside, help: true };
  if (inside.depth === 2) return depthTwoKey(source, inside, key);
  if (key === ESC || key === 's') return {};
  const cards = cardsOf(source);
  const at = cursorAt(inside, cards);
  // 고른 카드의 활동 기록을 칸에 고정한다(부르는 쪽이 칸을 고른다)
  if (key === 'p') return cards[at] ? { state: inside, pin: logKeyOf(cards[at]!) } : { state: inside };
  const move = (to: number) => {
    const index = Math.max(0, Math.min(cards.length - 1, to));
    return { state: { ...inside, cursor: Math.max(0, index), ...(cards[index] ? { agent: cards[index]!.id } : {}) } };
  };
  if (UP.includes(key) || LEFT.includes(key)) return move(at - 1);
  if (DOWN.includes(key) || RIGHT.includes(key)) return move(at + 1);
  if (key === PAGE_UP) return move(at - 3);
  if (key === PAGE_DOWN) return move(at + 3);
  if (HOME.includes(key)) return move(0);
  if (END.includes(key)) return move(cards.length - 1);
  if (key === '\r' || key === '\n') {
    const card = cards[at];
    if (!card) return { state: inside };
    if (card.main) return { state: inside, terminal: true };
    return { state: { ...inside, depth: 2, agent: card.id, cursor: at, up: 0 } };
  }
  return { state: inside };
}

/** 카드의 기록 id: 메인은 'main', 서브에이전트는 `claude:agent:` 머리를 뗀 id */
export function logKeyOf(card: InsideCard): string {
  return card.main ? 'main' : card.agent ? logIdOf(card.agent) : card.id;
}

function depthTwoKey(source: InsideSource, inside: InsideState, key: string): { state?: InsideState; pin?: string } {
  if (key === ESC) return { state: { ...inside, depth: 1, up: 0 } };
  if (key === 'p') {
    const card = cardsOf(source).find((entry) => entry.id === inside.agent);
    return { state: inside, ...(card ? { pin: logKeyOf(card) } : {}) };
  }
  const log = logOf(inside, inside.data);
  const total = log ? activityLines(log, DEFAULT_THEME, 0).length : 0;
  const scroll = (to: number) => ({ state: { ...inside, up: Math.max(0, Math.min(Math.max(0, total - 1), to)) } });
  if (UP.includes(key)) return scroll(inside.up + 1);
  if (DOWN.includes(key)) return scroll(inside.up - 1);
  if (key === PAGE_UP) return scroll(inside.up + PAGE);
  if (key === PAGE_DOWN) return scroll(inside.up - PAGE);
  if (HOME.includes(key)) return scroll(total);
  if (END.includes(key)) return scroll(0);
  void source;
  return { state: inside };
}

export function insideHint(inside: InsideState): string {
  return inside.depth === 2
    ? ' 활동 기록 · ↑↓ PgUp PgDn 굴리기 · g G 처음과 맨 아래 · p 칸에 고정 · Esc 한 단계 위로 · ? 모든 키'
    : ' 에이전트 안 · ←→ 고르기 · Enter 열기 · p 칸에 고정 · Esc 닫기 · ? 모든 키';
}

// ─── 항목 → 줄 ───

const WITHHELD_TEXT: Record<ActivityWithheldView, string> = {
  secret: '비밀 파일이라 내용을 보이지 않습니다',
  large: '내용이 커서 보이지 않습니다',
  unknown: '내용을 읽지 못했습니다',
};

function withheldText(withheld: unknown): string {
  return typeof withheld === 'string' && Object.hasOwn(WITHHELD_TEXT, withheld) ? WITHHELD_TEXT[withheld as ActivityWithheldView] : WITHHELD_TEXT.unknown;
}

const c = (theme: Theme, color: ColorToken, text: string) => `${fg(theme, color)}${text}${RESET}`;

function kindOf(entry: ActivityEntryView): ActivityEntryView['kind'] {
  return entry.kind === 'read' || entry.kind === 'search' || entry.kind === 'edit' || entry.kind === 'write' || entry.kind === 'run' ? entry.kind : 'other';
}

/** 변경 하나의 -/+ 줄. apply_patch 본문이면 그 줄의 머리 글자로 색을 정한다. removed는 앞의 지운 줄 수(본문 형태에서만) */
function diffLines(change: ActivityChangeView, theme: Theme): { lines: string[]; removed: number; more: boolean } {
  const lines: string[] = [];
  let removed = 0;
  if (typeof change.patch === 'string' && change.patch) {
    for (const line of blockLines(change.patch)) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***') || line.startsWith('@@')) lines.push(c(theme, 'muted', line));
      else if (line.startsWith('+')) lines.push(c(theme, 'green', `+ ${line.slice(1)}`));
      else if (line.startsWith('-')) lines.push(c(theme, 'red', `- ${line.slice(1)}`));
      else lines.push(c(theme, 'muted', `  ${line.startsWith(' ') ? line.slice(1) : line}`));
    }
  } else {
    for (const line of blockLines(change.removed)) lines.push(c(theme, 'red', `- ${line}`));
    removed = lines.length;
    for (const line of blockLines(change.added)) lines.push(c(theme, 'green', `+ ${line}`));
  }
  return { lines, removed, more: change.truncated === true };
}

/** diff 줄을 cap줄로 줄인다. 넘치면 …를 남기고, 지운 줄과 쓴 줄을 절반씩 보여 둘 다 보이게 한다 */
function cutDiff(diff: { lines: string[]; removed: number }, cap: number, inline: boolean): { lines: string[]; cut: boolean } {
  if (diff.lines.length <= cap) return { lines: diff.lines, cut: false };
  // inline이면 …를 마지막 줄 끝에 붙이므로 줄을 아끼지 않는다
  const usable = Math.max(1, inline ? cap : cap - 1);
  const added = diff.lines.length - diff.removed;
  let removedShown = Math.min(diff.removed, Math.ceil(usable / 2));
  const addedShown = Math.min(added, usable - removedShown);
  removedShown = Math.min(diff.removed, usable - addedShown);
  return { lines: [...diff.lines.slice(0, removedShown), ...diff.lines.slice(diff.removed, diff.removed + addedShown)], cut: true };
}

/** 고치기·쓰기 항목의 조각: 파일 이름과 -/+ 줄. 조각을 남기지 않은 항목은 까닭 한 줄만 적는다(서버가 준 조각은 그리지 않는다) */
function codeBlock(entry: ActivityEntryView, theme: Theme, caps: { changes: number; lines: number; inline?: boolean }): string[] {
  const out: string[] = [];
  const changes = list<ActivityChangeView>(entry.changes).filter((change) => change && typeof change === 'object');
  if (changes.length === 0) {
    if (entry.target) out.push(c(theme, 'accent', `✎ ${safeLine(entry.target)}`));
  }
  for (const change of changes.slice(0, caps.changes)) {
    out.push(c(theme, 'accent', `✎ ${safeLine(change.file ?? entry.target ?? '')}`));
    if (entry.withheld) continue;
    const diff = diffLines(change, theme);
    const cut = cutDiff(diff, caps.lines, caps.inline === true);
    out.push(...cut.lines);
    if (cut.cut || diff.more) {
      if (caps.inline && out.length > 0) out[out.length - 1] += c(theme, 'muted', ' …');
      else out.push(c(theme, 'muted', '…'));
    }
  }
  if (changes.length > caps.changes) out.push(c(theme, 'muted', `… 파일 ${changes.length - caps.changes}개 더`));
  if (entry.withheld) out.push(c(theme, 'yellow', withheldText(entry.withheld)));
  else if (entry.truncated === true && changes.length === 0) out.push(c(theme, 'muted', '…'));
  return out;
}

/** 실행 항목의 조각: 명령 앞 줄과 결과 끝 줄 */
function runBlock(entry: ActivityEntryView, theme: Theme, caps: { command: number; output: number }): string[] {
  const out: string[] = [];
  const command = blockLines(entry.command);
  if (command.length > 0) {
    out.push(c(theme, 'accent', `$ ${command[0]}`));
    for (const line of command.slice(1, caps.command)) out.push(c(theme, 'accent', `  ${line}`));
    if (command.length > caps.command) out.push(c(theme, 'muted', '…'));
  } else if (entry.target) out.push(c(theme, 'accent', `$ ${safeLine(entry.target)}`));
  if (entry.withheld) {
    out.push(c(theme, 'yellow', withheldText(entry.withheld)));
    return out;
  }
  const output = blockLines(entry.output);
  while (output.length > 0 && output[output.length - 1]!.trim() === '') output.pop();
  if (output.length > caps.output) out.push(c(theme, 'muted', '…'));
  for (const line of output.slice(-caps.output)) out.push(c(theme, 'muted', line));
  return out;
}

/** 실패·거절한 항목의 까닭 한 줄(없으면 빈 배열) */
function problemLine(entry: ActivityEntryView, theme: Theme, prefix = ''): string[] {
  if (entry.state !== 'failed' && entry.state !== 'denied') return [];
  const why = safeLine(entry.error ?? '');
  return entry.state === 'denied' ? [c(theme, 'red', `${prefix}⊘ 거절됨${why ? `: ${why}` : ''}`)] : [c(theme, 'red', `${prefix}× 실패${why ? `: ${why}` : ''}`)];
}

/** 카드의 코드 조각: 가장 최근 항목이 무엇이냐에 따라 한 가지를 보인다. max줄을 넘기지 않는다 */
function cardPreview(log: AgentActivityLogView | undefined, theme: Theme, max: number): string[] {
  if (!log || max <= 0) return [];
  const entries = list<ActivityEntryView>(log.entries);
  const last = entries[entries.length - 1];
  if (!last) return [];
  const kind = kindOf(last);
  const problem = problemLine(last, theme);
  const room = max - problem.length;
  let lines: string[];
  if (kind === 'edit' || kind === 'write') lines = codeBlock(last, theme, { changes: 1, lines: Math.max(1, room - 1), inline: true });
  else if (kind === 'run') lines = runBlock(last, theme, { command: 1, output: 2 });
  else {
    // 읽기·찾기·그 밖: 끝에서부터 같은 종류가 이어진 만큼 최근 대상 몇 줄
    const recent: string[] = [];
    for (let at = entries.length - 1; at >= 0 && recent.length < 3; at--) {
      const entry = entries[at]!;
      const entryKind = kindOf(entry);
      if (entryKind === 'edit' || entryKind === 'write' || entryKind === 'run') break;
      recent.unshift(c(theme, 'muted', `${toolLabel(safeLine(entry.tool, 40))} ${safeLine(entry.target ?? '')}`.trimEnd()));
    }
    lines = recent;
  }
  if (lines.length > room) lines = room > 0 ? [...lines.slice(0, room - 1), c(theme, 'muted', '…')] : [];
  return [...lines, ...problem].slice(0, max);
}

/** 항목 하나의 시각 글: 시:분:초 */
function clockText(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '--:--:--';
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

function durationText(entry: ActivityEntryView, now: number): string {
  const start = Date.parse(entry.at);
  if (!Number.isFinite(start)) return '';
  if (entry.state === 'running') return forText(entry.at, now);
  const end = entry.endedAt ? Date.parse(entry.endedAt) : NaN;
  if (!Number.isFinite(end) || end < start) return '';
  const ms = end - start;
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}초` : spanText(ms);
}

const STATE_MARK: Record<ActivityEntryView['state'], { mark: string; color: ColorToken; label: string }> = {
  running: { mark: '◐', color: 'accent', label: '진행 중' },
  done: { mark: '✓', color: 'teal', label: '완료' },
  failed: { mark: '×', color: 'red', label: '실패' },
  denied: { mark: '⊘', color: 'red', label: '거절됨' },
  unknown: { mark: '?', color: 'muted', label: '끝 확인 못 함' },
};

/** 깊이 2의 줄(색이 섞인 글, 폭에 맞추지 않은 것). 항목마다 머리 줄 하나와 몸 줄들이다. 넘치면 앞을 버린다 */
export function activityLines(log: AgentActivityLogView, theme: Theme, now: number): string[] {
  const lines: string[] = [];
  for (const entry of list<ActivityEntryView>(log.entries).slice(-MAX_ENTRIES)) {
    const state = Object.hasOwn(STATE_MARK, entry.state) ? STATE_MARK[entry.state] : STATE_MARK.unknown;
    const duration = durationText(entry, now);
    const kind = kindOf(entry);
    const target = kind === 'run' ? '' : safeLine(entry.target ?? '');
    lines.push(
      `${c(theme, 'muted', clockText(entry.at))}  ${c(theme, state.color, state.mark)} ${BOLD}${toolLabel(safeLine(entry.tool, 40))}${RESET}${target ? ` ${target}` : ''} ${c(theme, 'muted', `· ${state.label}${duration ? ` · ${duration}` : ''}`)}`,
    );
    const body =
      kind === 'edit' || kind === 'write'
        ? codeBlock(entry, theme, { changes: MAX_CHANGES, lines: MAX_DIFF_LINES })
        : kind === 'run'
          ? runBlock(entry, theme, { command: MAX_COMMAND_LINES, output: MAX_OUTPUT_LINES })
          : [];
    for (const line of body) lines.push(`    ${line}`);
    for (const line of problemLine(entry, theme, '    ')) lines.push(line);
  }
  return lines.length > MAX_ACTIVITY_LINES ? lines.slice(-MAX_ACTIVITY_LINES) : lines;
}

// ─── 카드 그림 ───

function countsText(log: AgentActivityLogView | undefined): string {
  if (!log) return '';
  const counts = { read: 0, search: 0, edit: 0, run: 0, failed: 0 };
  for (const entry of list<ActivityEntryView>(log.entries).slice(-MAX_ENTRIES)) {
    const kind = kindOf(entry);
    if (kind === 'read') counts.read++;
    else if (kind === 'search') counts.search++;
    else if (kind === 'edit' || kind === 'write') counts.edit++;
    else if (kind === 'run') counts.run++;
    if (entry.state === 'failed' || entry.state === 'denied') counts.failed++;
  }
  return [
    counts.read ? `읽기 ${counts.read}` : '',
    counts.search ? `찾기 ${counts.search}` : '',
    counts.edit ? `고침 ${counts.edit}` : '',
    counts.run ? `실행 ${counts.run}` : '',
    counts.failed ? `실패·거절 ${counts.failed}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function agentBadge(agent: DeskAgent): StatusBadge {
  return agent.state === 'working' ? { label: '작업 중', tone: 'busy' } : agent.state === 'done' ? { label: '끝남', tone: 'ok' } : { label: '대기', tone: 'muted' };
}

/** 카드 몸의 줄들(그림 옆 글 네 줄 + 코드 조각). 폭 tw는 그림 옆 글, iw는 카드 안쪽 전체 폭 */
function cardBody(card: InsideCard, item: DeskItem, theme: Theme, now: number, tw: number, iw: number, preview: number): { text: string[]; code: string[] } {
  const muted = fg(theme, 'muted');
  const status = card.main ? headStatus(item) : card.agent ? agentBadge(card.agent) : card.log?.state === 'done' ? ({ label: '끝남', tone: 'ok' } as StatusBadge) : ({ label: '작업 중', tone: 'busy' } as StatusBadge);
  const right = statusText(status, theme);
  const rightWidth = stringWidth(status.label) + 2;
  const title = compose([{ text: cardName(card, item), color: 'text', bold: true, flex: true }, { text: card.main ? ` ${backendLabel(item.backend)}` : '', color: 'muted' }], Math.max(1, tw - rightWidth - 1), theme);
  const head = tw > rightWidth + 1 ? `${title} ${right}` : title;
  // 경과: 메인은 작업 시간, 서브에이전트는 시작부터(끝났으면 걸린 시간), 멈춘 듯하면 그것
  let elapsed: Seg;
  const quiet = card.agent ? agentQuiet(card.agent, now) : undefined;
  if (quiet !== undefined) elapsed = { text: `⚠ ${spanText(quiet)}째 소식 없음`, color: 'yellow' };
  else if (card.main) elapsed = { text: item.state === 'working' && item.workingSince ? `작업 ${forText(item.workingSince, now)}` : '', color: 'muted' };
  else if (card.agent?.state === 'working') elapsed = { text: card.agent.startedAt ? forText(card.agent.startedAt, now) : '', color: 'muted' };
  else if (card.agent?.state === 'done' && card.agent.startedAt && card.agent.lastAt) elapsed = { text: `${spanText(Math.max(0, Date.parse(card.agent.lastAt) - Date.parse(card.agent.startedAt)))} 걸림`, color: 'muted' };
  else elapsed = { text: '', color: 'muted' };
  let doing: string;
  if (card.main) doing = nowLine(item, tw, theme, now);
  else if (card.agent) {
    const agent = card.agent;
    const text = agent.state === 'working' ? (agent.tool ? toolLineLabel(safeLine(agent.tool)) : safeLine(agent.activity ?? '')) : agent.state === 'done' && agent.result ? `결과 ${safeLine(agent.result)}` : '';
    doing = compose([{ text: oneLine(text) || '지금 하는 일 없음', ...(text ? {} : { color: 'muted' as const }), flex: true }], tw, theme);
  } else doing = compose([{ text: '목록에 없는 서브에이전트', color: 'muted' }], tw, theme);
  const counts = countsText(card.log);
  const text = [head, compose([elapsed], tw, theme), doing, counts ? `${muted}${clipWords(counts, tw)}${RESET}` : ''];
  return { text, code: cardPreview(card.log, theme, preview).map((line) => fitAnsi(line, iw)) };
}

/** 카드 하나를 그리는 데 필요한 것: 그림 옆 글 줄들과 코드 조각 줄들 */
interface BuiltCard {
  card: InsideCard;
  text: string[];
  code: string[];
  tw: number;
}

function buildCard(card: InsideCard, item: DeskItem, theme: Theme, now: number, width: number, preview: number): BuiltCard {
  const iw = Math.max(1, width - 4);
  const art = width >= ART_MIN_CARD ? ART : { cols: 0, rows: 0 };
  const tw = Math.max(1, iw - (art.cols ? art.cols + 2 : 0));
  const body = cardBody(card, item, theme, now, tw, iw, preview);
  return { card, text: body.text, code: body.code, tw };
}

/** 카드 안쪽 줄 수: 그림 옆 글(그림 높이 이상)과 코드 조각 */
function innerRows(built: BuiltCard, width: number): number {
  return Math.max(width >= ART_MIN_CARD ? ART.rows : 0, built.text.length) + built.code.length;
}

/** 카드 하나의 줄(테두리 포함). 안쪽 줄 수는 rows로 맞춘다 */
function cardBox(built: BuiltCard, item: DeskItem, source: InsideSource, theme: Theme, width: number, selected: boolean, rows: number): string[] {
  const art = width >= ART_MIN_CARD ? ART : { cols: 0, rows: 0 };
  // 메인은 세션의 그림, 서브에이전트는 종류마다 색이 다른 도우미 그림(한눈에 가른다)
  const sprite = built.card.main ? spriteFor(item, source.sprites) : subagentSpriteFor(built.card.agent?.type ?? built.card.log?.type, source.sprites);
  const frame = frameAt(sprite, source.spriteClock ?? 0);
  const kitty: KittyImages | undefined = source.kitty;
  const picture = art.cols ? (kitty ? kitty.art(sprite, frame, art.cols, art.rows) : spriteLines(sprite, art.cols, art.rows, theme, frame)) : [];
  const top = Math.max(art.rows, built.text.length);
  const inner: string[] = [];
  for (let row = 0; row < top; row++) {
    const text = fitAnsi(built.text[row] ?? '', built.tw);
    inner.push(art.cols ? `${picture[row] ?? ' '.repeat(art.cols)}  ${text}` : text);
  }
  inner.push(...built.code);
  while (inner.length < rows) inner.push('');
  return box(inner.slice(0, Math.max(rows, 1)), width, theme, { focused: selected });
}

// ─── 화면 ───

/** 아래에 두는 알림 줄(까닭 한 줄씩) */
function noteLines(inside: InsideState, item: DeskItem, cards: readonly InsideCard[], theme: Theme): string[] {
  const notes: string[] = [];
  const muted = (text: string) => c(theme, 'muted', text);
  if (inside.gone) notes.push(muted('이 스튜디오는 활동 기록을 보내지 않습니다. 스튜디오를 새로 띄우면 코드 조각이 보입니다'));
  else if (inside.data === undefined && inside.loading) notes.push(muted('활동 기록을 받는 중…'));
  else if (inside.data !== undefined) {
    const missing = cards.some((card) => !card.main && (!card.log || card.log.entries.length === 0));
    if (missing) notes.push(muted(item.backend === 'codex' ? '이 CLI는 서브에이전트의 코드를 보내지 않습니다' : '기록이 아직 없는 서브에이전트는 한 줄만 보입니다'));
  }
  if (inside.error && !inside.gone) notes.push(c(theme, 'yellow', `⚠ 활동 기록을 받지 못했습니다: ${inside.error}${inside.data ? '(마지막으로 받은 자료를 보입니다)' : ''}`));
  if (inside.note) notes.push(c(theme, 'accent', safeLine(inside.note, 200)));
  return notes;
}

/** 본문 자리에 그리는 줄(정확히 rect.h줄, 줄마다 rect.w칸) */
export function renderInside(source: InsideSource, rect: Pick<Rect, 'w' | 'h'> & Partial<Pick<Rect, 'x' | 'y'>>, now = Date.now()): { lines: string[] } {
  const theme = source.theme ?? DEFAULT_THEME;
  const inside = source.inside!;
  const muted = fg(theme, 'muted');
  const item = source.items.find((entry) => entry.id === inside.id);
  const finish = (lines: string[]) => {
    const out = lines.slice(0, rect.h).map((line) => fitAnsi(line, rect.w));
    while (out.length < rect.h) out.push(' '.repeat(rect.w));
    return { lines: out };
  };
  if (!item) return finish([`${muted}  이 세션을 찾지 못했습니다. Esc로 돌아갑니다${RESET}`]);
  const cards = insideCards(item, inside.data);
  const notes = noteLines(inside, item, cards, theme);
  const subs = cards.filter((card) => !card.main).length;
  const working = cards.filter((card) => card.agent?.state === 'working').length;
  if (inside.depth === 2) return finish(renderActivity(inside, item, cards, notes, rect, theme, now));

  const header = ` ${BOLD}${fg(theme, 'text')}${safeLine(item.title)}${RESET} ${muted}에이전트 안 · 서브에이전트 ${subs}${working ? ` · 작업 중 ${working}` : ''}${RESET}`;
  const room = Math.max(0, rect.h - 1 - notes.length);
  const columns = Math.max(1, Math.min(3, Math.floor((rect.w - 2 + 1) / (CARD_MIN + 1))));
  const cardWidth = Math.max(4, Math.min(CARD_MAX, Math.floor((rect.w - 2 - (columns - 1)) / columns)));
  const at = cursorAt(inside, cards);
  // 코드 조각은 모든 카드가 한 화면에 들어가는 가장 큰 줄 수로, 안 들어가면 가장 작게 그리고 넘긴다
  const place = (preview: number) => {
    const built = cards.map((card) => buildCard(card, item, theme, now, cardWidth, preview));
    const gridRows: BuiltCard[][] = [];
    for (let from = 0; from < built.length; from += columns) gridRows.push(built.slice(from, from + columns));
    const heights = gridRows.map((row) => Math.max(...row.map((entry) => innerRows(entry, cardWidth))) + 2);
    return { gridRows, heights, total: heights.reduce((sum, height) => sum + height, 0) };
  };
  let layout = place(PREVIEW_MIN);
  for (let candidate = PREVIEW_MAX; candidate >= PREVIEW_MIN; candidate--) {
    const tried = place(candidate);
    if (tried.total <= room) {
      layout = tried;
      break;
    }
  }
  const { gridRows, heights } = layout;
  const overflow = layout.total > room;
  const gridRoom = Math.max(0, room - (overflow ? 1 : 0));
  const target = Math.floor(at / columns);
  // 고른 카드가 든 줄이 보이게 위 줄을 건너뛴다
  let first = 0;
  const span = (from: number, to: number) => heights.slice(from, to + 1).reduce((sum, height) => sum + height, 0);
  while (first < target && span(first, target) > gridRoom) first++;
  const lines: string[] = [fitAnsi(header, rect.w)];
  let drawn = 0;
  for (let row = first; row < gridRows.length; row++) {
    const used = lines.length - 1;
    if (drawn > 0 && used + heights[row]! > gridRoom) break;
    const inner = heights[row]! - 2;
    const parts = gridRows[row]!.map((built) => cardBox(built, item, source, theme, cardWidth, built.card.id === cards[at]?.id, inner));
    for (let y = 0; y < heights[row]!; y++) lines.push(fitAnsi(` ${parts.map((part) => part[y] ?? ' '.repeat(cardWidth)).join(' ')}`, rect.w));
    drawn++;
  }
  if (lines.length - 1 > gridRoom) lines.length = gridRoom + 1;
  while (lines.length - 1 < gridRoom) lines.push('');
  if (overflow) {
    const above = gridRows.slice(0, first).reduce((sum, row) => sum + row.length, 0);
    const below = gridRows.slice(first + drawn).reduce((sum, row) => sum + row.length, 0);
    const parts = [...(above ? [`↑ 위에 카드 ${above}장`] : []), ...(below ? [`↓ 카드 ${below}장 더`] : []), '←→ 고르기'];
    lines.push(`  ${muted}${parts.join(' · ')}${RESET}`);
  }
  lines.push(...notes.map((note) => ` ${note}`));
  return finish(lines);
}

function renderActivity(inside: InsideState, item: DeskItem, cards: readonly InsideCard[], notes: readonly string[], rect: Pick<Rect, 'w' | 'h'>, theme: Theme, now: number): string[] {
  const muted = fg(theme, 'muted');
  const card = cards.find((entry) => entry.id === inside.agent);
  if (!card) return [`${muted}  이 에이전트를 찾지 못했습니다. Esc로 돌아갑니다${RESET}`];
  const why = inside.gone ? '이 스튜디오는 활동 기록을 보내지 않습니다' : inside.data === undefined ? (inside.loading ? '활동 기록을 받는 중…' : '활동 기록이 없습니다') : card.main || item.backend !== 'codex' ? '아직 기록된 활동이 없습니다' : '이 CLI는 서브에이전트의 코드를 보내지 않습니다';
  return activityPanel({ name: cardName(card, item), log: card.log, up: inside.up, rows: rect.h, notes, empty: why, theme, now });
}

/**
 * 활동 기록 한 장(깊이 2와 칸에 고정한 기록이 함께 쓴다): 머리 한 줄, 항목 줄들(맨 아래에서 up줄 올라간 자리), 아래 알림.
 * 줄은 폭에 맞추지 않은 것이다(부르는 쪽이 맞춘다). 줄 수는 늘 rows다
 */
export function activityPanel(options: { name: string; log: AgentActivityLogView | undefined; up: number; rows: number; notes: readonly string[]; empty: string; theme: Theme; now: number; /** 이름은 칸 머리에 이미 있다: 머리 줄에 쓰지 않는다 */ bare?: boolean }): string[] {
  const { log, theme, now, notes } = options;
  const muted = fg(theme, 'muted');
  const all = log ? activityLines(log, theme, now) : [];
  const room = Math.max(0, options.rows - 1 - notes.length);
  const maxUp = Math.max(0, all.length - room);
  const up = Math.min(options.up, maxUp);
  const start = Math.max(0, all.length - room - up);
  const entries = log ? list(log.entries).length : 0;
  const follow = up === 0 ? (all.length > room ? '맨 아래를 따라가는 중' : '') : `위로 ${up}줄 · G 맨 아래로`;
  const head = `항목 ${entries}${follow ? ` · ${follow}` : ''}`;
  const lines = [options.bare ? ` ${muted}${head}${RESET}` : ` ${BOLD}${fg(theme, 'text')}${options.name}${RESET} ${muted}활동 기록 · ${head}${RESET}`];
  if (all.length === 0) lines.push(`${muted}  ${options.empty}${RESET}`);
  else for (const line of all.slice(start, start + room)) lines.push(` ${line}`);
  while (lines.length < 1 + room) lines.push('');
  lines.length = Math.min(lines.length, 1 + room);
  lines.push(...notes.map((note) => ` ${note}`));
  return lines;
}
