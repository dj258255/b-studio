/**
 * desk 화면 그리기. 상태와 칸마다의 터미널 줄을 받아 화면 한 장(줄 배열)과 커서 자리를 돌려주는 순수 함수다.
 * 줄마다 보이는 폭은 정확히 화면 폭이다(색 제어 문자는 폭에 넣지 않는다). 그리는 쪽은 바뀐 줄만 다시 쓴다
 */
import type { DeskState } from './keys';
import { charWidth, fit, placePanes, stringWidth, type Rect } from './screen';
import { agentStatus, backendLabel, deskSessions, gateStatus, sidebarRows, type Tone } from './sidebar';
import type { DeskPreview } from './types';

/** 칸 하나에 그릴 것. lines는 칸의 터미널 크기에 맞춘 줄(색 포함), note는 칸 머리에 붙일 알림(닫힘·오류) */
export interface PaneView {
  lines: string[];
  /** lines가 이 폭에 정확히 맞춰져 있다(칸 해석기가 낸 줄). 칸 폭과 같으면 다시 재지 않는다 */
  cols?: number;
  cursor?: { x: number; y: number };
  note?: string;
  /** 칸 머리에 붙일 지금 모드(복사 모드의 자리) */
  mode?: string;
}

const RESET = '\x1b[0m';
const INVERSE = '\x1b[7m';
const BOLD = '\x1b[1m';
const TONE: Record<Tone, string> = { warn: '\x1b[33m', busy: '\x1b[36m', ok: '\x1b[32m', fail: '\x1b[31m', muted: '\x1b[2m' };
const SGR = /\x1b\[[0-9;:?]*[A-Za-z]/y;

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '');
}

/** 색이 섞인 줄을 정확히 width칸으로 맞춘다(넘치면 자르고 모자라면 빈칸). 끝에서 색을 되돌린다 */
export function fitAnsi(line: string, width: number): string {
  let out = '';
  let used = 0;
  let at = 0;
  while (at < line.length) {
    SGR.lastIndex = at;
    const match = SGR.exec(line);
    if (match) {
      out += match[0];
      at += match[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(at)!);
    const w = charWidth(char.codePointAt(0)!);
    if (used + w > width) break;
    out += char;
    used += w;
    at += char.length;
  }
  return `${out}${RESET}${' '.repeat(Math.max(0, width - used))}`;
}

const CHOICE_LABEL = (choice: string): string => (choice === 'rules' ? '규칙대로' : backendLabel(choice));

/** 미리보기 한 줄: 어느 AI로, 왜, 같은 종류의 일에서 AI별로 게이트를 몇 번 통과했나(웹 새 요청 칸과 같은 내용) */
export function previewLine(preview: DeskPreview): string {
  const target = `${backendLabel(preview.backend)}${preview.model ? ` (${preview.model})` : ''}`;
  const why =
    preview.rule === 'default'
      ? '맞는 규칙이 없어 서버 기본 AI'
      : preview.rule === 'fallback'
        ? '맞는 규칙이 없어 기본값'
        : preview.rule === 'direct'
          ? '직접 고름'
          : `규칙 ${preview.rule + 1}(${preview.matched})`;
  const records = preview.records?.length ? ` · 같은 종류 기록: ${preview.records.map((record) => `${backendLabel(record.backend)} 통과 ${record.passed}/${record.judged}`).join(' · ')}` : '';
  return `${target}로 보냅니다 · ${why}${records}`;
}

export const KEY_HINT = ' Ctrl-b › 숫자·o 칸 · ↑↓ 고르기 · Enter 열기 · n 새 요청 · [ 복사 · z 크게 · l 칸 수 · s 사이드바 · x 비우기 · ? 도움말 · q 나가기';
const IDLE_HINT = ' Ctrl-b 다음 키로 조작합니다(Ctrl-b n 새 요청 · Ctrl-b Enter 세션 열기 · Ctrl-b ? 도움말 · Ctrl-b q 나가기). 그 밖의 키는 고른 칸으로 갑니다';
export const COPY_HINT = ' 복사 모드 · ↑↓ k j 옮기기 · b f 쪽 · g G 처음과 끝 · v 고르기 · y 복사하고 나가기 · / 위로 찾기 · n 다음 · q 나가기';

/** 도움말 화면(Ctrl-b ?)의 키 표 */
export const HELP: ReadonlyArray<readonly [string, string]> = [
  ['1 2 3 4', '그 칸 고르기'],
  ['o', '다음 칸'],
  ['↑ ↓', '사이드바에서 세션 고르기(이어서 ↑↓, Enter)'],
  ['Enter', '고른 세션을 고른 칸에 열기(끝난 터미널은 다시 열기)'],
  ['n', '새 요청(규칙대로 AI를 골라 터미널로 보내기)'],
  ['l', '칸 수 1 · 2 · 4'],
  ['z', '고른 칸 크게 보기 켜고 끄기'],
  ['s', '사이드바 숨기고 보이기'],
  ['[', '복사 모드: 지난 출력 올려 보기와 복사'],
  ['x', '칸 비우기(세션과 CLI는 계속 돕니다)'],
  ['q', 'desk 나가기(세션과 CLI는 계속 돕니다)'],
  ['Ctrl-b', 'Ctrl-b 글자를 CLI로 보내기'],
  ['?', '이 도움말'],
];
const COPY_HELP: ReadonlyArray<readonly [string, string]> = [
  ['↑ ↓ · k j', '한 줄 옮기기'],
  ['b f · PgUp PgDn', '한 쪽 옮기기'],
  ['g G', '맨 처음, 맨 끝'],
  ['v', '여기서부터 고르기(다시 누르면 풀기)'],
  ['y · Enter', '고른 줄을 클립보드에 넣고 나가기(터미널이 OSC 52를 받아야 합니다)'],
  ['/ · n', '위로 찾기, 같은 글 더 찾기'],
  ['q · Esc', '나가기'],
];

/** 도움말 화면의 줄(머리와 아래 줄 사이에 놓는다) */
function helpLines(width: number): string[] {
  const row = ([key, text]: readonly [string, string]) => `   ${key}${' '.repeat(Math.max(1, 18 - stringWidth(key)))}${text}`;
  return [
    ' desk 도움말: 앞글쇠 Ctrl-b 다음에 누르는 키',
    '',
    ...HELP.map(row),
    '',
    ' 복사 모드(Ctrl-b [) 안의 키',
    '',
    ...COPY_HELP.map(row),
    '',
    ' 그 밖의 키와 붙여 넣은 글은 고른 칸의 CLI로 갑니다.',
  ].map((line) => fit(line, width));
}

export function renderScreen(state: DeskState, size: { cols: number; rows: number }, panes: readonly PaneView[]): { lines: string[]; cursor?: { x: number; y: number } } {
  const { cols, rows } = size;
  const layout = placePanes(cols, rows, state);
  const hidden = state.sidebarHidden === true;
  const sessions = deskSessions(state.items);
  const slotOf = new Map<string, number>();
  state.slots.forEach((id, slot) => {
    if (id && slot < state.layout) slotOf.set(id, slot + 1);
  });

  const lines: string[] = [];
  lines.push(`${BOLD}${fit(` b-studio desk · 칸 ${state.layout}${state.zoom ? '(크게 보기)' : ''} · 세션 ${sessions.length}`, cols)}${RESET}`);

  if (state.help) {
    lines.push(...helpLines(cols).slice(0, Math.max(0, rows - 2)));
    while (lines.length < rows - 1) lines.push(' '.repeat(cols));
    lines.push(fit(' 아무 키나 누르면 닫습니다', cols));
    return { lines };
  }

  // 사이드바: 고른 항목이 보이게 내린다
  const side = hidden ? [] : sidebarRows(state.items, state.selected, slotOf, layout.sidebar.w);
  // 고른 항목의 줄(머리·상태·펼친 내역)이 모두 보이게 내린다. 높이보다 길면 머리부터 보인다
  const first = side.findIndex((row) => row.item === state.selected);
  const last = side.reduce((at, row, index) => (row.item === state.selected ? index : at), -1);
  const offset = first < 0 ? 0 : Math.max(0, Math.min(first, side.length - layout.sidebar.h, last + 1 - layout.sidebar.h));
  const sideLine = (row: number): string => {
    const entry = side[offset + row];
    if (!entry) return ' '.repeat(layout.sidebar.w);
    if (entry.selected) return `${INVERSE}${entry.text}${RESET}`;
    let text = entry.text;
    for (const tone of entry.tones ?? []) text = text.replace(tone.text, `${TONE[tone.tone]}${tone.text}${RESET}`);
    return text;
  };

  const placed = layout.panes;
  for (let y = 1; y < rows - 1; y++) {
    let line = hidden ? '' : sideLine(y - 1) + '│';
    const covering = placed.filter(({ rect }) => y >= rect.y && y < rect.y + rect.h);
    if (covering.length === 0) {
      // 4칸의 가운데 가로 구분선
      const [left, right] = placed.map((entry) => entry.rect);
      line += '─'.repeat(left?.w ?? 0) + (right ? `┼${'─'.repeat(right.w)}` : '');
    } else {
      covering.sort((a, b) => a.rect.x - b.rect.x);
      line += covering.map(({ rect, slot }) => paneLine(state, slot, rect, y - rect.y, panes[slot])).join('│');
    }
    lines.push(line);
  }

  let cursor: { x: number; y: number } | undefined;
  if (state.prompt) {
    const prompt = state.prompt;
    const project = prompt.projects[prompt.projectIndex];
    const choice = prompt.choices[prompt.choice] ?? 'rules';
    // 직접 고른 AI면 규칙 미리보기를 보이지 않는다(그 AI로 바로 간다)
    const preview = prompt.sending
      ? '보내는 중…'
      : choice !== 'rules'
        ? `${backendLabel(choice)}로 바로 보냅니다(규칙을 건너뜀)`
        : (prompt.preview ?? '요청을 쓰면 어느 AI로 갈지 여기 보입니다');
    lines[rows - 2] = fit(` AI: ${CHOICE_LABEL(choice)} (Tab 바꾸기) · ${preview}`, cols);
    if (prompt.step === 'project') {
      lines[rows - 1] = fit(` 새 요청 · 프로젝트: ‹${project?.name ?? '없음'}› (↑↓ 고르기 · Enter 다음 · Esc 닫기)`, cols);
    } else {
      const head = ` ${project?.name ?? ''} 요청> `;
      // 길면 끝부분을 보인다(커서가 화면 밖으로 나가지 않게)
      let text = prompt.text;
      while (text && stringWidth(head + text) > cols - 1) text = [...text].slice(1).join('');
      lines[rows - 1] = fit(head + text, cols);
      cursor = { x: stringWidth(head + text), y: rows - 1 };
    }
  } else {
    const hint = state.copy
      ? state.copy.search !== undefined
        ? ` 위로 찾기> ${state.copy.search}`
        : state.message
          ? ` ${state.message}`
          : COPY_HINT
      : state.prefix
        ? KEY_HINT
        : state.message
          ? ` ${state.message}`
          : IDLE_HINT;
    lines.push(fit(hint, cols));
    const rect = placed.find((entry) => entry.slot === state.focus)?.rect;
    const view = panes[state.focus];
    if (rect && view?.cursor && state.slots[state.focus]) {
      cursor = { x: rect.x + Math.min(view.cursor.x, rect.w - 1), y: rect.y + 1 + Math.min(view.cursor.y, rect.h - 2) };
    }
  }
  while (lines.length < rows) lines.push(' '.repeat(cols));
  return { lines: lines.slice(0, rows), ...(cursor ? { cursor } : {}) };
}

function paneLine(state: DeskState, slot: number, rect: Rect, row: number, view: PaneView | undefined): string {
  const id = state.slots[slot];
  const focused = slot === state.focus;
  if (row === 0) {
    const item = id ? state.items.find((candidate) => candidate.id === id) : undefined;
    let title = ` ${slot + 1} `;
    if (!id) title += '(비어 있음)';
    else if (item) {
      const gate = gateStatus(item);
      title += [backendLabel(item.backend), item.title, agentStatus(item).label, ...(gate ? [gate.label] : [])].join(' · ');
    } else title += id;
    if (view?.mode) title += ` · ${view.mode}`;
    if (view?.note) title += ` · ${view.note}`;
    const text = fit(title, rect.w);
    return focused ? `${INVERSE}${text}${RESET}` : `${BOLD}${text}${RESET}`;
  }
  if (!id) {
    const middle = Math.floor((rect.h - 1) / 2);
    return fit(row === middle ? '  Ctrl-b Enter 로 사이드바에서 고른 세션을 엽니다' : '', rect.w);
  }
  const line = view?.lines[row - 1];
  if (line === undefined) return ' '.repeat(rect.w);
  // 칸 해석기가 이미 칸 폭에 맞춘 줄이다. 폭을 다시 재면 해석기와 셈이 달라 줄이 잘리거나 밀린다(#860)
  return view?.cols === rect.w ? line : fitAnsi(line, rect.w);
}
