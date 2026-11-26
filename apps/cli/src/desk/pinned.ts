/**
 * 칸에 고정한 활동 기록(#1411): 칸 하나가 터미널 대신 에이전트 하나(메인이나 서브에이전트)의 활동 기록을 보인다.
 * 칸 id는 `pin:세션:에이전트`(셸 칸의 `shell:`처럼 세션 id와 섞이지 않는다). 그림은 깊이 2와 같은 activityPanel이다.
 * 이 칸은 입력을 터미널로 보내지 않는다(키는 굴리기뿐, 붙여넣기는 버린다). 기록은 메모리에만 있어 desk를 다시 열면 되살리지 않는다.
 * 받는 일은 desk.ts가 한다(세션마다 요청 하나를 에이전트 안 화면과 나눠 쓴다). 키와 그림은 순수 함수다
 */
import { activityLines, activityPanel, cardName, insideCards, logKeyOf, normalizeActivity, safeLine, type InsideCard } from './inside';
import type { DeskState } from './keys';
import { fitAnsi, stringWidth } from './screen';
import { DEFAULT_THEME, fg, RESET, type Theme } from './theme';
import type { ActivityLogView, AgentActivityLogView, DeskItem } from './types';

export const PIN_ID = 'pin:';
const PAGE = 10;
const UP = ['\x1b[A', '\x1bOA', 'k', '\x10'];
const DOWN = ['\x1b[B', '\x1bOB', 'j', '\x0e'];
const HOME = ['\x1b[H', '\x1b[1~', 'g'];
const END = ['\x1b[F', '\x1b[4~', 'G'];

export function isPinId(id: string | undefined): id is string {
  return id !== undefined && id.startsWith(PIN_ID);
}

/** 칸 id. 세션 id와 에이전트 id의 `:`는 가려 둬 서로 섞이지 않는다 */
export function pinId(session: string, agent: string): string {
  return `${PIN_ID}${encodeURIComponent(session)}:${encodeURIComponent(agent)}`;
}

export function parsePin(id: string): { session: string; agent: string } | undefined {
  if (!isPinId(id)) return undefined;
  const parts = id.slice(PIN_ID.length).split(':');
  if (parts.length !== 2) return undefined;
  try {
    return { session: decodeURIComponent(parts[0]!), agent: decodeURIComponent(parts[1]!) };
  } catch {
    return undefined;
  }
}

export interface PinState {
  session: string;
  /** 기록의 에이전트 id(메인은 'main') */
  agent: string;
  /** 맨 아래에서 위로 올라간 줄 수. 0이면 맨 아래를 따라간다 */
  up: number;
  /** 마지막으로 받은 이 에이전트의 기록 */
  log?: AgentActivityLogView;
  /** 서버가 이 에이전트의 기록을 더 주지 않는다(끝나서 지워졌다). log는 마지막으로 받은 것이다 */
  ended?: true;
  loading: boolean;
  /** 마지막 받기가 실패한 까닭. 기록은 마지막으로 받은 것을 그대로 둔다 */
  error?: string;
  /** 스튜디오가 이 API를 모른다(옛 판) */
  gone?: true;
}

function findLog(data: ActivityLogView, agent: string): AgentActivityLogView | undefined {
  return data.agents.find((log) => log.id === agent || (agent === 'main' && log.main === true));
}

function lineCount(log: AgentActivityLogView | undefined): number {
  return log ? activityLines(log, DEFAULT_THEME, 0).length : 0;
}

/** 칸에 고정할 때의 처음 상태. data(에이전트 안 화면이 이미 받은 것)가 있으면 바로 채운다 */
export function openPin(session: string, agent: string, data?: unknown): PinState {
  const pin: PinState = { session, agent, up: 0, loading: true };
  return data === undefined ? pin : pinLoaded(pin, data);
}

/** 받은 자료를 넣는다. 위로 읽는 중이면 새 항목이 와도 보던 자리를 지킨다. 이 에이전트가 목록에서 사라졌으면 마지막 기록을 두고 끝난 것으로 본다 */
export function pinLoaded(pin: PinState, raw: unknown): PinState {
  const found = findLog(normalizeActivity(raw), pin.agent);
  const log = found ?? pin.log;
  const grown = pin.up > 0 ? lineCount(log) - lineCount(pin.log) : 0;
  return { ...pin, log, loading: false, error: undefined, gone: undefined, ...(found ? { ended: undefined } : pin.log ? { ended: true as const } : {}), up: Math.max(0, pin.up + grown) };
}

export function pinFailed(pin: PinState, failure: { status?: number; message: string; old?: boolean }): PinState {
  const message = safeLine(failure.message, 200) || '알 수 없는 오류';
  return { ...pin, loading: false, error: message, ...(failure.old ? { gone: true as const } : {}) };
}

/** 위로 by줄 굴린다(음수면 아래로). 맨 아래(0)와 맨 위(전체 줄 수) 사이로 막는다 */
export function scrollPin(pin: PinState, by: number): PinState {
  const total = lineCount(pin.log);
  return { ...pin, up: Math.max(0, Math.min(Math.max(0, total - 1), pin.up + by)) };
}

/** 굴리는 키. 굴리는 키가 아니어도 이 칸은 키를 터미널로 보내지 않으니 부르는 쪽이 버린다 */
export function pinKey(pin: PinState, key: string): PinState {
  if (UP.includes(key)) return scrollPin(pin, 1);
  if (DOWN.includes(key)) return scrollPin(pin, -1);
  if (key === '\x1b[5~') return scrollPin(pin, PAGE);
  if (key === '\x1b[6~') return scrollPin(pin, -PAGE);
  if (HOME.includes(key)) return scrollPin(pin, lineCount(pin.log));
  if (END.includes(key)) return scrollPin(pin, -pin.up);
  return pin;
}

export const PIN_HINT = ' 활동 기록 칸 · ↑↓ PgUp PgDn 굴리기 · g G 처음과 맨 아래 · Ctrl-b x 칸 비우기 · ? 모든 키';

/** 알림 글 한 줄에 쓰는 줄 수의 상한(알림이 여럿이어도 합쳐서) */
const NOTE_MAX = 4;

/** 한 가지 색으로 칠한 글을 폭에 맞게 나눈다(글자 단위, 넓은 글자는 두 칸). 색은 줄마다 다시 건다 */
function wrapColored(colored: string, width: number): string[] {
  // 알림은 `색 + 글 + RESET` 꼴이다
  const start = /^(\x1b\[[0-9;:]*m)/.exec(colored)?.[1] ?? '';
  const plain = colored.replace(/\x1b\[[0-9;:]*m/g, '');
  const lines: string[] = [];
  let line = '';
  for (const char of plain) {
    if (stringWidth(line + char) > width && line) {
      lines.push(`${start}${line}${RESET}`);
      line = '';
    }
    line += char;
  }
  if (line) lines.push(`${start}${line}${RESET}`);
  return lines;
}

function cardOf(item: DeskItem, pin: PinState): InsideCard | undefined {
  return insideCards(item, pin.log ? { agents: [pin.log] } : undefined).find((card) => logKeyOf(card) === pin.agent);
}

/** 칸 머리에 적는 글 */
export function pinTitle(state: Pick<DeskState, 'items'> & Partial<Pick<DeskState, 'pins'>>, id: string): string {
  const pin = state.pins?.[id];
  const parsed = parsePin(id);
  if (!pin || !parsed) return '활동 기록';
  const item = state.items.find((entry) => entry.id === pin.session);
  const card = item ? cardOf(item, pin) : undefined;
  const name = item && card ? cardName(card, item) : item ? '서브에이전트' : '세션 없음';
  const status = pin.ended ? '끝남' : card?.agent ? (card.agent.state === 'working' ? '작업 중' : card.agent.state === 'done' ? '끝남' : '대기') : pin.log?.state === 'done' ? '끝남' : '';
  return `활동 기록 · ${name}${status ? ` · ${status}` : ''}`;
}

/** 칸 안에 그릴 줄: 정확히 size.rows줄, 줄마다 size.cols칸. 알림은 맨 아래에 까닭 한 줄씩이고 사람이 칸을 닫는다(자동으로 닫지 않는다) */
export function renderPin(state: Pick<DeskState, 'items'> & Partial<Pick<DeskState, 'pins' | 'theme'>>, id: string, size: { cols: number; rows: number }, now = Date.now()): string[] {
  const theme: Theme = state.theme ?? DEFAULT_THEME;
  const muted = (text: string) => `${fg(theme, 'muted')}${text}${RESET}`;
  const warn = (text: string) => `${fg(theme, 'yellow')}${text}${RESET}`;
  const pin = state.pins?.[id];
  const finish = (lines: string[]) => {
    const out = lines.slice(0, size.rows).map((line) => fitAnsi(line, size.cols));
    while (out.length < size.rows) out.push(' '.repeat(size.cols));
    return out;
  };
  if (!pin) return finish([muted('  이 활동 기록을 찾지 못했습니다. Ctrl-b x로 칸을 비웁니다')]);
  const item = state.items.find((entry) => entry.id === pin.session);
  const card = item ? cardOf(item, pin) : undefined;
  const notes: string[] = [];
  if (!item) notes.push(warn('⚠ 이 세션이 없습니다(지워졌거나 목록에서 빠졌습니다). 마지막으로 받은 기록입니다 · Ctrl-b x로 칸을 비웁니다'));
  else if (item.state === 'stopped') notes.push(warn('⚠ 세션이 멈췄습니다. 마지막으로 받은 기록입니다 · Ctrl-b x로 칸을 비웁니다'));
  if (pin.gone) notes.push(muted('이 스튜디오는 활동 기록을 보내지 않습니다. 스튜디오를 새로 띄우면 보입니다'));
  else if (pin.error) notes.push(warn(`⚠ 활동 기록을 받지 못했습니다: ${pin.error}${pin.log ? '(마지막으로 받은 자료를 보입니다)' : ''}`));
  if (pin.ended) notes.push(muted('끝난 서브에이전트입니다(마지막으로 받은 기록)'));
  const name = item && card ? cardName(card, item) : '활동 기록';
  const empty = pin.gone ? '이 스튜디오는 활동 기록을 보내지 않습니다' : pin.loading && !pin.log ? '활동 기록을 받는 중…' : '아직 기록된 활동이 없습니다';
  // 알림은 칸 폭에 맞춰 나누고(좁은 칸에서 잘리지 않게), 칸이 낮으면 기록 자리를 먼저 지키려고 몇 줄까지만 둔다
  const wrapped = notes.flatMap((note) => wrapColored(note, Math.max(1, size.cols - 2)));
  const limit = Math.max(0, Math.min(wrapped.length, NOTE_MAX, size.rows - 3));
  return finish(activityPanel({ name, log: pin.log, up: pin.up, rows: size.rows, notes: wrapped.slice(0, limit), empty, theme, now, bare: true }));
}
