/**
 * desk 화면 그리기. 상태와 칸마다의 터미널 줄을 받아 화면 한 장(줄 배열)과 커서 자리를 돌려주는 순수 함수다.
 * 줄마다 보이는 폭은 정확히 화면 폭이다(색 제어 문자는 폭에 넣지 않는다). 그리는 쪽은 바뀐 줄만 다시 쓴다
 */
import type { DeskState } from './keys';
import { charWidth, fit, placePanes, stringWidth, type Rect } from './screen';
import { agentStatus, backendLabel, deskSessions, gateStatus, sidebarRows, type SidebarRow, type Tone } from './sidebar';
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
  /** 칸 안 CLI가 벨을 울렸고 아직 이 칸을 고르지 않았다(#864) */
  bell?: boolean;
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

export const KEY_HINT = ' Ctrl-b › 숫자·o 칸 · ↑↓ 고르기 · Enter 열기 · n 새 요청 · [ 복사 · z 크게 · l 칸 수 · s 사이드바 · x 비우기 · p 멈추기 · r 이어서 · , 이름 · ? 도움말 · q 나가기';
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
  ['p', '사이드바에서 고른 세션 멈추기(한 번 묻습니다. 기록과 작업 복사본은 남습니다)'],
  ['r', '멈춘 세션 이어서 작업(한 번 묻습니다. 켜지면 칸을 다시 엽니다)'],
  [',', '고른 세션 이름 바꾸기(비우면 이름을 지웁니다)'],
  ['q', 'desk 나가기(세션과 CLI는 계속 돕니다)'],
  ['Ctrl-b', 'Ctrl-b 글자를 CLI로 보내기'],
  ['?', '이 도움말'],
];
/** 마우스로 하는 것(#874) */
const MOUSE_HELP: ReadonlyArray<readonly [string, string]> = [
  ['칸 누르기', '그 칸 고르기(CLI가 마우스를 켰으면 고른 칸 안의 마우스는 CLI로 갑니다)'],
  ['사이드바 누르기', '세션 고르기(Enter나 한 번 더 누르면 고른 칸에 엽니다)'],
  ['휠', '그 칸의 지난 출력 올려 보기(맨 아래로 내리면 복사 모드를 나옵니다)'],
  ['Shift + 끌기', '터미널의 글 고르기(desk가 마우스를 받는 동안 대부분의 터미널에서)'],
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
    ' 마우스',
    '',
    ...MOUSE_HELP.map(row),
    '',
    ' 그 밖의 키와 붙여 넣은 글은 고른 칸의 CLI로 갑니다.',
    ' 세션이 손댈 상태가 되거나 검증이 끝나면 사이드바에 !를 붙이고 벨과 OS 알림을 냅니다(studio desk --no-notify로 끕니다).',
    ' 앞글쇠·알림·마우스·색은 ~/.config/b-studio/desk.json으로 바꿉니다. 칸 배치는 나갈 때 기억해 다음에 되살립니다.',
  ].map((line) => fit(line, width));
}

/**
 * 사이드바에 보이는 줄과 내려간 만큼(offset). 고른 항목의 줄(머리·상태·펼친 내역)이 모두 보이게 내린다. 높이보다 길면 머리부터 보인다.
 * 마우스로 누른 줄을 가릴 때도 같은 셈을 쓴다(#874)
 */
export function sidebarView(state: DeskState, size: { cols: number; rows: number }): { rows: SidebarRow[]; offset: number; rect: Rect } {
  const layout = placePanes(size.cols, size.rows, state);
  const slotOf = new Map<string, number>();
  state.slots.forEach((id, slot) => {
    if (id && slot < state.layout) slotOf.set(id, slot + 1);
  });
  const side = state.sidebarHidden ? [] : sidebarRows(state.items, state.selected, slotOf, layout.sidebar.w, new Set(state.flagged ?? []));
  const first = side.findIndex((row) => row.item === state.selected);
  const last = side.reduce((at, row, index) => (row.item === state.selected ? index : at), -1);
  const offset = first < 0 ? 0 : Math.max(0, Math.min(first, side.length - layout.sidebar.h, last + 1 - layout.sidebar.h));
  return { rows: side, offset, rect: layout.sidebar };
}

/** 앞글쇠를 바꿨으면 안내 글의 Ctrl-b를 그 이름으로 바꾼다(이름은 늘 Ctrl-x 꼴이라 폭이 같다). 칸 안 CLI의 글에는 쓰지 않는다 */
function relabel(state: DeskState, text: string): string {
  const label = state.prefixLabel;
  return label && label !== 'Ctrl-b' ? text.replaceAll('Ctrl-b', label) : text;
}

export function renderScreen(state: DeskState, size: { cols: number; rows: number }, panes: readonly PaneView[]): { lines: string[]; cursor?: { x: number; y: number } } {
  const { cols, rows } = size;
  const layout = placePanes(cols, rows, state);
  const hidden = state.sidebarHidden === true;
  const sessions = deskSessions(state.items);

  const lines: string[] = [];
  lines.push(`${BOLD}${fit(` b-studio desk · 칸 ${state.layout}${state.zoom ? '(크게 보기)' : ''} · 세션 ${sessions.length}`, cols)}${RESET}`);

  if (state.help) {
    lines.push(...helpLines(cols).map((line) => relabel(state, line)).slice(0, Math.max(0, rows - 2)));
    while (lines.length < rows - 1) lines.push(' '.repeat(cols));
    lines.push(fit(' 아무 키나 누르면 닫습니다', cols));
    return { lines };
  }

  // 사이드바: 고른 항목이 보이게 내린다
  const { rows: side, offset } = sidebarView(state, size);
  const sideLine = (row: number): string => {
    const entry = side[offset + row];
    if (!entry) return ' '.repeat(layout.sidebar.w);
    if (entry.selected) return `${INVERSE}${entry.text}${RESET}`;
    let text = relabel(state, entry.text);
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
  } else if (state.rename) {
    // 이름 입력 줄: 길면 끝부분을 보인다(커서가 화면 밖으로 나가지 않게)
    const head = ' 세션 이름(Enter 저장 · 비우면 지움 · Esc 그만둠)> ';
    let text = state.rename.text;
    while (text && stringWidth(head + text) > cols - 1) text = [...text].slice(1).join('');
    lines.push(fit(head + text, cols));
    cursor = { x: stringWidth(head + text), y: rows - 1 };
  } else if (state.confirm) {
    const confirm = state.confirm;
    lines.push(
      fit(
        confirm.action === 'stop'
          ? ` ‹${confirm.title}› 세션을 멈출까요? CLI와 샌드박스를 내립니다(기록과 작업 복사본은 남습니다) · y 멈추기 · 다른 키 그만두기`
          : ` ‹${confirm.title}› 세션을 이어서 작업할까요? 샌드박스를 다시 띄웁니다 · y 이어서 작업 · 다른 키 그만두기`,
        cols,
      ),
    );
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
    lines.push(fit(relabel(state, hint), cols));
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
    if (view?.bell) title += ' · 벨';
    // 세션 제목(사람이 쓴 요청)은 그대로 두고 desk가 붙인 안내만 앞글쇠 이름을 바꾼다
    if (view?.note) title += ` · ${relabel(state, view.note)}`;
    const text = fit(title, rect.w);
    return focused ? `${INVERSE}${text}${RESET}` : `${BOLD}${text}${RESET}`;
  }
  if (!id) {
    const middle = Math.floor((rect.h - 1) / 2);
    return fit(row === middle ? relabel(state, '  Ctrl-b Enter 로 사이드바에서 고른 세션을 엽니다') : '', rect.w);
  }
  const line = view?.lines[row - 1];
  if (line === undefined) return ' '.repeat(rect.w);
  // 칸 해석기가 이미 칸 폭에 맞춘 줄이다. 폭을 다시 재면 해석기와 셈이 달라 줄이 잘리거나 밀린다(#860)
  return view?.cols === rect.w ? line : fitAnsi(line, rect.w);
}
