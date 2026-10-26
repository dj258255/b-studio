/**
 * 빠른 전환 목록(#922, 앞글쇠 다음 Space). 모든 세션을 급한 순(손댈 것 > 오류 > 안 본 끝남 > 작업 중 > 쉼)으로 보이고,
 * 친 글자로 제목·스페이스·AI 이름을 거른다. 연 동안 순서는 연 때의 순서로 고정한다(커서 밑 줄이 움직이지 않게).
 * 키를 받아 다음 상태와 고른 세션을 돌려주는 순수 함수다. 고른 세션을 칸에 여는 일은 keys.ts가 한다
 */
import { fit, fitAnsi, stringWidth, type Rect } from './screen';
import { agentStatus, backendLabel, byUrgency, deskSessions } from './sidebar';
import { fg, RESET, type Theme } from './theme';
import type { DeskItem } from './types';
import { statusMark } from './widgets';

export interface SwitcherState {
  query: string;
  /** 거른 목록에서 고른 줄 */
  index: number;
  /** 연 때의 세션 차례(id) */
  order: string[];
}

/** 목록이 보는 desk 상태(keys.ts의 DeskState 가운데) */
export interface SwitcherSource {
  items: DeskItem[];
  switcher?: SwitcherState;
  flagged?: string[];
  unseenDone?: string[];
}

const ESC = '\x1b';

export function openSwitcher(source: Omit<SwitcherSource, 'switcher'>): SwitcherState {
  const order = byUrgency(deskSessions(source.items), new Set(source.unseenDone ?? [])).map((item) => item.id);
  return { query: '', index: 0, order };
}

/** 거른 목록. 연 뒤에 생긴 세션은 끝에 둔다. 거르기는 빈칸으로 나눈 낱말이 모두 들어 있어야 한다(대소문자 무시) */
export function switcherEntries(source: SwitcherSource): DeskItem[] {
  const switcher = source.switcher;
  if (!switcher) return [];
  const sessions = deskSessions(source.items);
  const at = new Map(switcher.order.map((id, index) => [id, index]));
  const ordered = sessions
    .map((item, index) => ({ item, at: at.get(item.id) ?? switcher.order.length + index }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.item);
  const words = switcher.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ordered;
  return ordered.filter((item) => {
    const text = `${item.title} ${item.projectName} ${backendLabel(item.backend)} ${item.backend ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** 키 하나. 닫으면 state가 없고, Enter로 고르면 chosen이 그 세션 id다 */
export function switcherKey(source: SwitcherSource, key: string): { state?: SwitcherState; chosen?: string } {
  const switcher = source.switcher!;
  const entries = switcherEntries(source);
  const move = (by: number) => ({ state: { ...switcher, index: Math.max(0, Math.min(entries.length - 1, switcher.index + by)) } });
  if (key === ESC || key === '\x03') return {};
  if (key === '\r' || key === '\n') {
    const chosen = entries[Math.min(switcher.index, entries.length - 1)];
    return chosen ? { chosen: chosen.id } : { state: switcher };
  }
  if (key === '\x1b[A' || key === '\x1bOA' || key === '\x10') return move(-1);
  if (key === '\x1b[B' || key === '\x1bOB' || key === '\x0e' || key === '\t') return move(1);
  if (key === '\x7f' || key === '\b') return { state: { ...switcher, query: [...switcher.query].slice(0, -1).join(''), index: 0 } };
  if (key.startsWith(ESC) || key.codePointAt(0)! < 32) return { state: switcher };
  return { state: { ...switcher, query: switcher.query + key, index: 0 } };
}

/** 붙여 넣은 글은 한 줄로 거르기에 더한다 */
export function switcherPaste(switcher: SwitcherState, content: string): SwitcherState {
  const clean = content.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
  return { ...switcher, query: switcher.query + clean, index: 0 };
}

export const SWITCHER_HINT = ' 빠른 전환 · 글자로 거르기 · ↑↓ 고르기 · Enter 칸에 열기 · Esc 닫기';

/** 본문 자리에 그리는 줄(정확히 rect.h줄, 줄마다 rect.w칸)과 거르기 칸의 커서 자리 */
export function renderSwitcher(source: SwitcherSource, rect: Pick<Rect, 'w' | 'h'>, theme: Theme): { lines: string[]; cursor: { x: number; y: number } } {
  const switcher = source.switcher!;
  const entries = switcherEntries(source);
  const muted = fg(theme, 'muted');
  const flagged = new Set(source.flagged ?? []);
  const unseen = new Set(source.unseenDone ?? []);
  const lines: string[] = [];
  const prompt = ` 찾기 › ${switcher.query}`;
  lines.push(fit(prompt, rect.w));
  lines.push(fitAnsi(`${muted} ${entries.length}개 · 급한 순${RESET}`, rect.w));
  const room = Math.max(0, rect.h - lines.length);
  const index = Math.min(switcher.index, Math.max(0, entries.length - 1));
  const offset = Math.max(0, Math.min(index - room + 1, entries.length - room));
  if (entries.length === 0) lines.push(fitAnsi(`${muted}   맞는 세션이 없습니다${RESET}`, rect.w));
  for (const [at, item] of entries.slice(offset, offset + room).entries()) {
    const status = agentStatus(item, { unseen: unseen.has(item.id) });
    const chosen = offset + at === index;
    const mark = flagged.has(item.id) ? `${fg(theme, 'yellow')}!${RESET}` : ' ';
    const head = chosen ? `${fg(theme, 'accent')}›${RESET}` : ' ';
    const text = ` ${head}${mark}${statusMark(status, theme)} ${status.label.padEnd(5, ' ')} ${chosen ? '\x1b[1m' : ''}${item.title}${RESET} ${muted}· ${item.projectName} · ${backendLabel(item.backend)}${RESET}`;
    lines.push(fitAnsi(text, rect.w));
  }
  while (lines.length < rect.h) lines.push(' '.repeat(rect.w));
  return { lines: lines.slice(0, rect.h), cursor: { x: Math.min(rect.w - 1, stringWidth(prompt)), y: 0 } };
}
