/**
 * desk 화면 그리기. 상태와 칸마다의 터미널 줄을 받아 화면 한 장(줄 배열)과 커서 자리를 돌려주는 순수 함수다.
 * 줄마다 보이는 폭은 정확히 화면 폭이다(색 제어 문자는 폭에 넣지 않는다). 그리는 쪽은 바뀐 줄만 다시 쓴다
 */
import { spaceScreen } from './cards';
import { RECORDS_HINT, recordsLines } from './records';
import { sessionDetailLines } from './session-detail';
import { tightestLine, usageScreen } from './usage';
import { isShellId, type DeskState } from './keys';
import { computeLayout, fit, fitAnsi, placePanes, stringWidth, type Rect } from './screen';
import { renderRuntime, runtimeHint } from './runtime';
import { fleetsHint, renderFleets } from './fleets';
import { folderHint, renderFolder } from './folder';
import { plansHint, plansScreen } from './plans';
import { renderRequirements, requirementsHint } from './requirements';
import { renderSettings, settingsHint } from './settings';
import { agentStatus, backendLabel, deskSessions, gateStatus, sidebarRows, type SidebarRow } from './sidebar';
import { bg, BOLD, DEFAULT_THEME, fg, RESET } from './theme';
import type { DeskPreview } from './types';
import { statusMark } from './widgets';

export { fitAnsi, stripAnsi } from './screen';

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
  /** 세션 대신 칸 머리에 쓸 제목(셸 칸, #873) */
  title?: string;
}

/** 바탕색 위에 그린다: 줄 안의 색 되돌림 뒤에도 바탕색을 다시 걸고, 남은 칸도 그 바탕으로 채운다 */
function onBackground(text: string, background: string, width: number): string {
  return fitAnsi(background + text.replaceAll(RESET, RESET + background), width, background);
}

/** 사이드바 맨 아래 줄의 키 안내 */
const SIDEBAR_HINT = ' Ctrl-b w 카드 · a 폴더 · ? 키';
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

export const KEY_HINT = ' Ctrl-b › 숫자·o 칸 · ↑↓ 고르기 · Enter 열기 · w 카드 · u 사용량 · g 설정 · i 자세히 · h 기록 · e 요구사항 · t 작업 나누기 · f AI 비교 · v 실행 · a 폴더 열기 · n 새 요청 · c 셸 · [ 복사 · z 크게 · l 칸 수 · s 사이드바 · x 비우기 · p 멈추기 · r 이어서 · , 이름 · ? 도움말 · q 나가기';
const SPACE_HINT = ' 스페이스 화면 · ←→ 카드 고르기 · Enter 고른 칸에 열기 · i 자세히 · Tab 다음 스페이스 · Esc 칸 화면 · n 새 요청 · a 폴더 열기 · g 설정 · e 요구사항 · f AI 비교 · v 실행 · p 멈추기 · r 이어서 · , 이름 · ? 도움말';
const USAGE_HINT = ' 사용량 화면 · ↑↓ 계정 고르기 · r 다시 읽기 · w 카드 화면 · g 설정(계정·그림) · f AI 비교 · Esc 닫기 · ? 도움말';
const IDLE_HINT = ' Ctrl-b 다음 키로 조작합니다(Ctrl-b n 새 요청 · Ctrl-b Enter 세션 열기 · Ctrl-b ? 도움말 · Ctrl-b q 나가기). 그 밖의 키는 고른 칸으로 갑니다';
export const COPY_HINT = ' 복사 모드 · ↑↓ k j 옮기기 · b f 쪽 · g G 처음과 끝 · v 고르기 · y 복사하고 나가기 · / 위로 찾기 · n 다음 · q 나가기';

/** 도움말 화면(Ctrl-b ?)의 키 표 */
export const HELP: ReadonlyArray<readonly [string, string]> = [
  ['1 2 3 4', '그 칸 고르기'],
  ['o', '다음 칸'],
  ['↑ ↓', '사이드바에서 세션 고르기(이어서 ↑↓, Enter)'],
  ['Enter', '고른 세션을 고른 칸에 열기(끝난 터미널은 다시 열기)'],
  ['w', '스페이스 화면(세션 카드) 켜고 끄기. 그 안에서는 앞글쇠 없이 ←→ 고르기, Enter 고른 칸에 열기, Tab 다음 스페이스, Esc 칸 화면'],
  ['u', '사용량 화면(계정마다 5시간·주간 한도) 켜고 끄기. 그 안에서는 앞글쇠 없이 ↑↓ 고르기, r 다시 읽기, Esc 닫기'],
  ['n', '새 요청(규칙대로 AI를 골라 터미널로 보내기). 프로젝트 고르기 끝 줄의 "+ 폴더 열기"로 내 폴더를 바로 등록, Ctrl-t로 이 요청의 확인 선언 변경 허용'],
  ['a', '폴더 열기: 내 폴더를 프로젝트로 등록(경로 쓰기, Tab 채우기, ↑↓ 하위 폴더, Enter 살펴보고 y로 등록). 스페이스 화면에서는 a만'],
  ['i', '고른 세션 자세히: 체크포인트 diff·되돌리기·다시 검증, 확인 필요와 AI 리뷰 지적, PR 올리기, 세션 지우기(스페이스 화면에서는 앞글쇠 없이 i)'],
  ['h', '기록: AI·계정별 게이트 통과율과 최근 실패, 프로젝트 토큰 보고서'],
  ['g', '설정: 계정(더하기·로그인·그림), 라우팅 규칙, 화면, 키·알림. 스페이스·사용량 화면에서는 g만, Esc로 닫으면 연 화면으로'],
  ['f', '여러 AI 비교: 같은 요청을 2~4개 AI(계정·모델)에 보내 카드로 나란히 보고 승자를 고름. 참가자를 칸에 나란히 엶. 스페이스·사용량 화면에서는 f만'],
  ['t', '작업 나누기: 요청 하나를 레인 여럿으로 나눈 계획. 목록·새 계획(n)·계획 보기(단계별 레인 카드), Enter 레인 세션 열기, g 칸에 나란히, 승인 대기면 b AI·계정 · a 승인(i 이슈로 올리기) · x 거부'],
  ['e', '요구사항·문서: 명세(이 요구사항으로 작업, 사람 확인, 편집기로 고치기), 테스트, 문서 읽기, 현황. 고른 칸(카드 화면이면 고른 카드)의 세션, 카드 화면에서는 e만'],
  ['v', '실행 화면: 고른 세션의 서비스·자원, 로그(찾기), 운영 배포·되돌리기, 미리보기 주소(브라우저로 열기), 저장소(점검·이슈·PR). 스페이스 화면에서는 v만'],
  ['c', '고른 칸에 그냥 셸 열기(검증 밖입니다. x로 비우거나 desk를 나가면 끝나고, 칸 수를 줄이면 가려 둡니다)'],
  ['l', '칸 수 1 · 2 · 4'],
  ['z', '고른 칸 크게 보기 켜고 끄기'],
  ['s', '사이드바 숨기고 보이기'],
  ['[', '복사 모드: 지난 출력 올려 보기와 복사'],
  ['x', '칸 비우기(세션과 CLI는 계속 돕니다. 셸 칸은 한 번 묻고 셸을 끝냅니다)'],
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
  ['사이드바 누르기', '스페이스를 누르면 그 스페이스 화면, 세션을 누르면 고르기(Enter나 한 번 더 누르면 고른 칸에 엽니다)'],
  ['카드 누르기', '그 세션 고르기(한 번 더 누르면 고른 칸에 엽니다)'],
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
    ' 앞글쇠·알림·마우스·색·팔레트는 설정 화면(Ctrl-b g)이나 ~/.config/b-studio/desk.json으로 바꿉니다. 칸 배치는 나갈 때 기억해 다음에 되살립니다.',
    ' 카드 그림은 계정 그림(설정 화면에서 고름), 그림 폴더(~/.config/b-studio/sprites/)의 claude-code · codex · default 그림, 그 폴더에서 무작위 차례로 씁니다.',
    ' 사용량 화면의 계정 그림은 계정에 고른 그림, 없으면 그 폴더에서 계정마다 고른 그림입니다. 설정 화면에서 u·w는 설정을 닫고 사용량·카드 화면으로 갑니다.',
  ].map((line) => fit(line, width));
}

/**
 * 사이드바에 보이는 줄과 내려간 만큼(offset). 고른 세션이 든 스페이스의 줄부터 고른 세션의 줄까지 보이게 내린다.
 * 맨 아래 한 줄은 키 안내라 rect에서 뺀다. 마우스로 누른 줄을 가릴 때도 같은 셈을 쓴다(#874)
 */
export function sidebarView(state: DeskState, size: { cols: number; rows: number }): { rows: SidebarRow[]; offset: number; rect: Rect } {
  const layout = placePanes(size.cols, size.rows, state);
  // 맨 아래 키 안내 위에 가장 빠듯한 한도 한 줄(#925)을 두면 그만큼 더 뺀다
  const limitRow = sidebarLimitLine(state, layout.sidebar.w) ? 1 : 0;
  const rect = { ...layout.sidebar, h: Math.max(1, layout.sidebar.h - 1 - limitRow) };
  const slotOf = new Map<string, number>();
  state.slots.forEach((id, slot) => {
    if (id && slot < state.layout) slotOf.set(id, slot + 1);
  });
  const side = state.sidebarHidden ? [] : sidebarRows(state.items, state.selected, slotOf, rect.w, new Set(state.flagged ?? []), state.theme ?? DEFAULT_THEME);
  const space = deskSessions(state.items)[state.selected]?.projectName;
  const first = side.findIndex((row) => row.space !== undefined && row.space === space);
  const last = side.reduce((at, row, index) => (row.item === state.selected ? index : at), first);
  const offset = first < 0 ? 0 : Math.max(0, Math.min(first, side.length - rect.h, last + 1 - rect.h));
  return { rows: side, offset, rect };
}

/** 사이드바 맨 아래(키 안내 위)의 가장 빠듯한 한도 한 줄(#925). 사이드바가 낮거나 읽은 한도가 없으면 없다 */
function sidebarLimitLine(state: DeskState, width: number): string | undefined {
  if (state.sidebarHidden || !state.usage?.accounts.length) return undefined;
  return tightestLine(state.usage.accounts, width, state.theme ?? DEFAULT_THEME);
}

/** 스페이스 화면이 놓이는 본문 자리(칸들이 놓이던 곳 전체) */
export function spaceRect(state: DeskState, size: { cols: number; rows: number }): Rect {
  return computeLayout(size.cols, size.rows, 1, { sidebar: !state.sidebarHidden }).panes[0]!;
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

  const theme = state.theme ?? DEFAULT_THEME;
  const chrome = bg(theme, 'chrome');
  const border = fg(theme, 'border');
  const lines: string[] = [];
  const shells = state.slots.filter((id) => isShellId(id)).length;
  const hiddenShells = state.slots.filter((id, slot) => slot >= state.layout && isShellId(id)).length;
  const shellNote = shells ? ` · 셸 ${shells}(검증 밖${hiddenShells ? `, ${hiddenShells}개 가려짐 · Ctrl-b l로 칸 수를 늘리면 보입니다` : ''})` : '';
  const view = state.folder ? '폴더 열기' : state.plans ? '작업 나누기' : state.fleets ? '여러 AI 비교' : state.view === 'space' ? '스페이스 화면' : state.view === 'usage' ? '사용량' : `칸 ${state.layout}${state.zoom ? '(크게 보기)' : ''}`;
  const where = sessions[state.selected]?.projectName;
  lines.push(
    onBackground(
      ` ${BOLD}${fg(theme, 'accent')}b-studio desk${RESET} ${fg(theme, 'muted')}·${RESET} ${fg(theme, 'text')}${where ? `${where} · ` : ''}${view} · 세션 ${sessions.length}${shellNote}${RESET}`,
      chrome,
      cols,
    ),
  );

  // 기록 화면과 세션 자세히(#891)는 머리 줄 아래 전체를 쓴다
  if (state.records) {
    const titles = Object.fromEntries(state.items.map((entry) => [entry.id, entry.title]));
    lines.push(...recordsLines(state.records, { theme, width: cols, height: Math.max(0, rows - 2), now: Date.now(), names: state.records.names ?? {}, titles }));
    lines.push(fit(state.message ? ` ${state.message}` : RECORDS_HINT, cols));
    return { lines: lines.slice(0, rows) };
  }
  if (state.detail) {
    lines.push(...sessionDetailLines(state.detail, { theme, width: cols, height: Math.max(0, rows - 1), now: Date.now() }));
    return { lines: lines.slice(0, rows) };
  }

  if (state.help) {
    lines.push(...helpLines(cols).map((line) => relabel(state, line)).slice(0, Math.max(0, rows - 2)));
    while (lines.length < rows - 1) lines.push(' '.repeat(cols));
    lines.push(fit(' 아무 키나 누르면 닫습니다', cols));
    return { lines };
  }

  if (state.settings) {
    // 설정 화면(#890)은 사이드바 없이 본문 전체를 쓴다
    const body = renderSettings(state.settings, { w: cols, h: Math.max(0, rows - 2) }, theme);
    lines.push(...body.lines);
    while (lines.length < rows - 1) lines.push(' '.repeat(cols));
    lines.push(fit(relabel(state, settingsHint(state.settings)), cols));
    return { lines: lines.slice(0, rows), ...(body.cursor ? { cursor: { x: body.cursor.x, y: body.cursor.y + 1 } } : {}) };
  }

  if (state.folder) {
    // 폴더 열기(#916)도 사이드바 없이 본문 전체를 쓴다
    const body = renderFolder(state.folder, { w: cols, h: Math.max(0, rows - 2) }, theme);
    lines.push(...body.lines);
    while (lines.length < rows - 1) lines.push(' '.repeat(cols));
    lines.push(fit(relabel(state, folderHint(state.folder)), cols));
    return { lines: lines.slice(0, rows), ...(body.cursor ? { cursor: { x: body.cursor.x, y: body.cursor.y + 1 } } : {}) };
  }

  if (state.runtime) {
    // 실행 화면(#895)도 사이드바 없이 본문 전체를 쓴다
    const body = renderRuntime(state.runtime, { w: cols, h: Math.max(0, rows - 2) }, theme);
    lines.push(...body.lines);
    while (lines.length < rows - 1) lines.push(' '.repeat(cols));
    lines.push(fit(relabel(state, runtimeHint(state.runtime)), cols));
    return { lines: lines.slice(0, rows), ...(body.cursor ? { cursor: { x: body.cursor.x, y: body.cursor.y + 1 } } : {}) };
  }

  if (state.fleets) {
    // 여러 AI 비교 화면(#892)도 설정 화면처럼 사이드바 없이 본문 전체를 쓴다
    const context = { items: state.items, theme, sprites: state.sprites ?? {}, spriteClock: state.spriteClock ?? 0, ...(state.kitty ? { kitty: state.kitty } : {}) };
    const body = renderFleets(state.fleets, context, { w: cols, h: Math.max(0, rows - 2) });
    lines.push(...body.lines);
    while (lines.length < rows - 1) lines.push(' '.repeat(cols));
    lines.push(fit(relabel(state, fleetsHint(state.fleets)), cols));
    return { lines: lines.slice(0, rows), ...(body.cursor ? { cursor: { x: body.cursor.x, y: body.cursor.y + 1 } } : {}) };
  }

  if (state.requirements) {
    // 요구사항·문서 화면(#894)도 사이드바 없이 본문 전체를 쓴다
    const body = renderRequirements(state.requirements, { w: cols, h: Math.max(0, rows - 2) }, theme);
    lines.push(...body.lines);
    while (lines.length < rows - 1) lines.push(' '.repeat(cols));
    lines.push(fit(requirementsHint(state.requirements), cols));
    return { lines: lines.slice(0, rows), ...(body.cursor ? { cursor: { x: body.cursor.x, y: body.cursor.y + 1 } } : {}) };
  }

  // 사이드바: 고른 스페이스와 세션이 보이게 내린다. 맨 아래 줄은 키 안내
  const { rows: side, offset, rect: sideRect } = sidebarView(state, size);
  const limitLine = sidebarLimitLine(state, layout.sidebar.w);
  const sideLine = (row: number): string => {
    if (row === layout.sidebar.h - 1) return onBackground(`${fg(theme, 'muted')}${relabel(state, SIDEBAR_HINT)}${RESET}`, chrome, layout.sidebar.w);
    if (row === layout.sidebar.h - 2 && limitLine) return onBackground(limitLine, chrome, layout.sidebar.w);
    const entry = row < sideRect.h ? side[offset + row] : undefined;
    if (!entry) return onBackground('', chrome, layout.sidebar.w);
    return onBackground(relabel(state, entry.text), entry.selected ? bg(theme, 'active') : chrome, layout.sidebar.w);
  };

  // 작업 나누기 화면(#893)은 사이드바를 둔 채 본문 자리에 그린다
  const space = state.plans
    ? plansScreen(state, spaceRect(state, size))
    : state.view === 'space'
      ? spaceScreen(state, spaceRect(state, size))
      : state.view === 'usage'
        ? usageScreen(state, spaceRect(state, size))
        : undefined;
  const placed = layout.panes;
  for (let y = 1; y < rows - 1; y++) {
    let line = hidden ? '' : sideLine(y - 1) + `${border}│${RESET}`;
    if (space) {
      lines.push(line + space.lines[y - 1]!);
      continue;
    }
    const covering = placed.filter(({ rect }) => y >= rect.y && y < rect.y + rect.h);
    if (covering.length === 0) {
      // 4칸의 가운데 가로 구분선
      const [left, right] = placed.map((entry) => entry.rect);
      line += `${border}${'─'.repeat(left?.w ?? 0)}${right ? `┼${'─'.repeat(right.w)}` : ''}${RESET}`;
    } else {
      covering.sort((a, b) => a.rect.x - b.rect.x);
      line += covering.map(({ rect, slot }) => paneLine(state, slot, rect, y - rect.y, panes[slot])).join(`${border}│${RESET}`);
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
        ? `${prompt.labels?.[choice] ?? backendLabel(choice)}로 바로 보냅니다(규칙을 건너뜀)`
        : (prompt.preview ?? '요청을 쓰면 어느 AI로 갈지 여기 보입니다');
    const checks = prompt.allowCheckChanges ? ' · 확인 선언 변경 허용 켬(Ctrl-t 끄기)' : ' · Ctrl-t 확인 선언 변경 허용';
    lines[rows - 2] = fit(` AI: ${prompt.labels?.[choice] ?? CHOICE_LABEL(choice)} (Tab 바꾸기)${checks} · ${preview}`, cols);
    if (prompt.step === 'project') {
      // 끝 줄은 "+ 폴더 열기"다(#916)
      const picked = project ? `‹${project.name}›` : '‹+ 폴더 열기(내 폴더를 프로젝트로 등록)›';
      lines[rows - 1] = fit(` 새 요청 · 프로젝트: ${picked} (↑↓ 고르기 · Enter 다음 · Esc 닫기)`, cols);
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
        confirm.action === 'close'
          ? ` 이 칸의 셸을 끝낼까요? 셸에서 돌던 것도 함께 끝납니다 · y 끝내기 · 다른 키 그만두기`
          : confirm.action === 'quit'
          ? ` ${confirm.title}이 desk와 함께 끝납니다(세션 칸의 CLI는 계속 돕니다). 나갈까요? · y 나가기 · 다른 키 그만두기`
          : confirm.action === 'stop'
            ? ` ‹${confirm.title}› 세션을 멈출까요? CLI와 샌드박스를 내립니다(기록과 작업 복사본은 남습니다) · y 멈추기 · 다른 키 그만두기`
            : ` ‹${confirm.title}› 세션을 이어서 작업할까요? 샌드박스를 다시 띄웁니다 · y 이어서 작업 · 다른 키 그만두기`,
        cols,
      ),
    );
  } else {
    const hint = state.plans && !state.prefix
      ? plansHint(state.plans)
      : state.copy
      ? state.copy.search !== undefined
        ? ` 위로 찾기> ${state.copy.search}`
        : state.message
          ? ` ${state.message}`
          : COPY_HINT
      : state.prefix
        ? KEY_HINT
        : state.message
          ? ` ${state.message}`
          : state.view === 'space'
            ? SPACE_HINT
            : state.view === 'usage'
              ? USAGE_HINT
              : IDLE_HINT;
    lines.push(fit(relabel(state, hint), cols));
    const rect = placed.find((entry) => entry.slot === state.focus)?.rect;
    const view = panes[state.focus];
    if (!state.plans && rect && view?.cursor && state.slots[state.focus]) {
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
    const theme = state.theme ?? DEFAULT_THEME;
    const item = id ? state.items.find((candidate) => candidate.id === id) : undefined;
    // 고른 칸의 머리는 밝은 바탕에 굵은 글, 다른 칸은 어두운 바탕에 흐린 글. 칸 번호는 고른 칸만 강조색이다
    const head = focused ? `${bg(theme, 'active')}${fg(theme, 'text')}${BOLD}` : `${bg(theme, 'chrome')}${fg(theme, 'muted')}`;
    let title = `${focused ? fg(theme, 'accent') : ''} ${slot + 1} ${RESET}${head}`;
    if (!id) title += '(비어 있음)';
    else if (view?.title) title += view.title;
    else if (item) {
      const gate = gateStatus(item);
      title += `${statusMark(agentStatus(item), theme)}${head} ${[backendLabel(item.backend), item.title, agentStatus(item).label, ...(gate ? [gate.label] : [])].join(' · ')}`;
    } else title += id;
    if (view?.mode) title += ` · ${view.mode}`;
    if (view?.bell) title += ' · 벨';
    // 세션 제목(사람이 쓴 요청)은 그대로 두고 desk가 붙인 안내만 앞글쇠 이름을 바꾼다
    if (view?.note) title += ` · ${relabel(state, view.note)}`;
    return onBackground(title, head, rect.w);
  }
  if (!id) {
    const middle = Math.floor((rect.h - 1) / 2);
    return fit(row === middle ? relabel(state, '  Ctrl-b Enter 로 사이드바에서 고른 세션을, Ctrl-b c 로 그냥 셸을 엽니다') : '', rect.w);
  }
  const line = view?.lines[row - 1];
  if (line === undefined) return ' '.repeat(rect.w);
  // 칸 해석기가 이미 칸 폭에 맞춘 줄이다. 폭을 다시 재면 해석기와 셈이 달라 줄이 잘리거나 밀린다(#860)
  return view?.cols === rect.w ? line : fitAnsi(line, rect.w);
}
