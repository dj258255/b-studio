/**
 * desk의 요구사항·문서 화면(#894, 앞글쇠 다음 e, 스페이스 화면에서는 e만). 웹 세션 화면의 요구사항 묶음(명세·테스트·문서·현황)을 터미널로 옮긴다(ADR-186).
 *
 * 명세: 요구사항 목록(상태·우선순위·근거)과 고른 것의 인수 조건, "이 요구사항으로 작업"(스튜디오가 만든 글을 세션 CLI에 넣는다),
 * 사람 확인 남기기·지우기, 추출 결과 보기·저장, docs/requirements.md를 편집기로 고치기. 테스트: 서비스별 결과와 실패·테스트 없는 요구사항에서
 * 고치기·더하기 글 넣기. 문서: 목록과 터미널에 맞춘 마크다운 읽기, 편집기로 고치기. 현황: 지금 하는 일·목적·산출물·위험·검증.
 * 여기는 상태와 받은 키로 다음 상태와 할 일(effects)을 돌려주는 순수 함수와 그리기뿐이다. 스튜디오 API와 편집기는 desk.ts가 다룬다
 */
import { fit, fitAnsi, osc8, stringWidth } from './screen';
import { bg, BOLD, fg, RESET, type ColorToken, type Theme } from './theme';
import { box } from './widgets';
import type { DeskDocEntry, DeskProjectStatus, DeskRequirement, DeskRequirements, DeskRequirementStatus, DeskTestRow, DeskTests } from './types';

export type RequirementsTab = 'spec' | 'tests' | 'docs' | 'status';

export const REQUIREMENTS_TABS: ReadonlyArray<{ tab: RequirementsTab; label: string }> = [
  { tab: 'spec', label: '명세' },
  { tab: 'tests', label: '테스트' },
  { tab: 'docs', label: '문서' },
  { tab: 'status', label: '현황' },
];

/** 세션 작업 복사본의 요구사항 문서. 스튜디오가 이 파일을 읽어 요구사항과 근거를 만든다 */
export const REQUIREMENTS_FILE = 'docs/requirements.md';

/** 요구사항 문서가 아직 없을 때 편집기에 채우는 틀. 스튜디오의 요구사항 문서 꼴(## R1. 제목, 종류·우선순위 줄, 인수 조건 목록)이다 */
export const REQUIREMENTS_TEMPLATE = [
  '# 요구사항',
  '',
  '## R1. 첫 요구사항',
  '- 종류: api · 우선순위: must',
  '- 인수 조건:',
  '  - 무엇을 하면 무엇이 된다(확인할 수 있는 문장으로)',
  '',
  '## 가정',
  '- ',
  '',
].join('\n');

/** 사람 확인 메모의 상한(스튜디오와 같다) */
const NOTE_MAX = 500;

export interface ReaderState {
  path: string;
  content?: string;
  error?: string;
  scroll: number;
}

export interface RequirementsState {
  sessionId: string;
  /** 머리에 보일 세션 이름 */
  title: string;
  tab: RequirementsTab;
  /** 지금 탭에서 고른 줄(목록이 없는 탭은 내린 줄) */
  row: number;
  spec?: DeskRequirements;
  tests?: DeskTests;
  docs?: DeskDocEntry[];
  status?: DeskProjectStatus;
  /** 받는 중인 탭 */
  loading?: RequirementsTab[];
  errors?: Partial<Record<RequirementsTab, string>>;
  /** 문서 하나를 읽는 중 */
  reader?: ReaderState;
  /** 사람 확인 메모를 쓰는 중 */
  verify?: { requirementId: string; text: string; error?: string };
  confirm?: { kind: 'apply-draft' } | { kind: 'unverify'; requirementId: string };
  /** 추출 결과를 보는 중 */
  draft?: boolean;
  /** 아래 줄에 잠깐 보일 알림(다음 키에 지운다) */
  note?: string;
}

export type RequirementsEffect =
  | { type: 'load'; tab: RequirementsTab }
  | { type: 'doc'; path: string }
  /** 세션 CLI 입력 칸에 글을 넣는다(보내기는 사람이 Enter로) */
  | { type: 'work'; text: string }
  /** 이 문서를 편집기로 연다 */
  | { type: 'edit'; path: string }
  | { type: 'verify'; requirementId: string; note: string }
  | { type: 'unverify'; requirementId: string }
  | { type: 'apply-draft' };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j'];
const PAGE_UP = ['\x1b[5~', 'b'];
const PAGE_DOWN = ['\x1b[6~', ' ', 'f'];
const SHIFT_TAB = '\x1b[Z';
const BACKSPACE = ['\x7f', '\b'];
const ENTER = ['\r', '\n'];
const CTRL_U = '\x15';
/** 쪽 넘기기 한 번에 내리는 줄 */
const PAGE = 10;

export function openRequirements(input: { sessionId: string; title: string }): { state: RequirementsState; effects: RequirementsEffect[] } {
  return { state: { sessionId: input.sessionId, title: input.title, tab: 'spec', row: 0, loading: ['spec'] }, effects: [{ type: 'load', tab: 'spec' }] };
}

/** 탭을 받은 결과를 넣는다(desk.ts가 부른다) */
export function loaded(state: RequirementsState, tab: RequirementsTab, value: { spec?: DeskRequirements; tests?: DeskTests; docs?: DeskDocEntry[]; status?: DeskProjectStatus; error?: string }): RequirementsState {
  const loading = (state.loading ?? []).filter((entry) => entry !== tab);
  const errors = { ...state.errors };
  if (value.error) errors[tab] = value.error;
  else delete errors[tab];
  const next: RequirementsState = { ...state, loading, errors };
  if (value.spec) next.spec = value.spec;
  if (value.tests) next.tests = value.tests;
  if (value.docs) next.docs = value.docs;
  if (value.status) next.status = value.status;
  return { ...next, row: Math.min(next.row, Math.max(0, rowCount(next) - 1)) };
}

/** 테스트 탭의 줄: 서비스마다 실패를 먼저, 그다음 테스트가 없는 요구사항 */
export type TestEntry = { kind: 'test'; service: string; row: DeskTestRow } | { kind: 'missing'; id: string; title: string; prefill: string };

const TEST_ORDER: Record<DeskTestRow['status'], number> = { fail: 0, 'not-run': 1, skip: 2, pass: 3 };

export function testEntries(tests: DeskTests | undefined): TestEntry[] {
  if (!tests) return [];
  const entries: TestEntry[] = [];
  for (const service of tests.services) {
    const rows = [...service.rows].sort((a, b) => TEST_ORDER[a.status] - TEST_ORDER[b.status]);
    for (const row of rows) entries.push({ kind: 'test', service: service.service, row });
  }
  for (const missing of tests.requirementsWithoutTests) entries.push({ kind: 'missing', ...missing });
  return entries;
}

function rowCount(state: RequirementsState): number {
  if (state.tab === 'spec') return state.draft ? (state.spec?.draft?.requirements.length ?? 0) : (state.spec?.requirements.length ?? 0);
  if (state.tab === 'tests') return testEntries(state.tests).length;
  if (state.tab === 'docs') return state.docs?.length ?? 0;
  return 0;
}

function switchTab(state: RequirementsState, tab: RequirementsTab, effects: RequirementsEffect[]): RequirementsState {
  const next: RequirementsState = { ...state, tab, row: 0, draft: false, reader: undefined };
  const have = { spec: state.spec, tests: state.tests, docs: state.docs, status: state.status }[tab];
  if (have !== undefined || state.loading?.includes(tab)) return next;
  effects.push({ type: 'load', tab });
  return { ...next, loading: [...(state.loading ?? []), tab] };
}

function reload(state: RequirementsState, effects: RequirementsEffect[]): RequirementsState {
  effects.push({ type: 'load', tab: state.tab });
  return { ...state, loading: [...(state.loading ?? []).filter((tab) => tab !== state.tab), state.tab] };
}

/** 키 하나. 돌려준 state가 없으면 화면을 닫는다 */
export function requirementsKey(start: RequirementsState, key: string): { state: RequirementsState | undefined; effects: RequirementsEffect[] } {
  const effects: RequirementsEffect[] = [];
  const state: RequirementsState = start.note ? { ...start, note: undefined } : start;
  if (state.verify) return { state: verifyKey(state, state.verify, key, effects), effects };
  if (state.confirm) {
    const confirm = state.confirm;
    if (key === 'y' || ENTER.includes(key)) effects.push(confirm.kind === 'apply-draft' ? { type: 'apply-draft' } : { type: 'unverify', requirementId: confirm.requirementId });
    return { state: { ...state, confirm: undefined }, effects };
  }
  if (state.reader) return { state: readerKey(state, state.reader, key, effects), effects };

  const tabIndex = REQUIREMENTS_TABS.findIndex((entry) => entry.tab === state.tab);
  if (key === '\t') return { state: switchTab(state, REQUIREMENTS_TABS[(tabIndex + 1) % REQUIREMENTS_TABS.length]!.tab, effects), effects };
  if (key === SHIFT_TAB) return { state: switchTab(state, REQUIREMENTS_TABS[(tabIndex + REQUIREMENTS_TABS.length - 1) % REQUIREMENTS_TABS.length]!.tab, effects), effects };
  if (/^[1-4]$/.test(key)) return { state: switchTab(state, REQUIREMENTS_TABS[Number(key) - 1]!.tab, effects), effects };
  if (key === 'r') return { state: reload(state, effects), effects };
  if (key === ESC || key === 'q') {
    if (state.draft) return { state: { ...state, draft: false, row: 0 }, effects };
    return { state: undefined, effects };
  }

  const count = rowCount(state);
  if (UP.includes(key)) return { state: { ...state, row: Math.max(0, state.row - 1) }, effects };
  if (DOWN.includes(key)) return { state: { ...state, row: state.tab === 'status' ? state.row + 1 : Math.max(0, Math.min(count - 1, state.row + 1)) }, effects };
  if (PAGE_UP.includes(key)) return { state: { ...state, row: Math.max(0, state.row - PAGE) }, effects };
  if (PAGE_DOWN.includes(key)) return { state: { ...state, row: state.tab === 'status' ? state.row + PAGE : Math.max(0, Math.min(count - 1, state.row + PAGE)) }, effects };

  if (state.tab === 'spec') return { state: specKey(state, key, effects), effects };
  if (state.tab === 'tests') {
    if (ENTER.includes(key)) {
      const entry = testEntries(state.tests)[state.row];
      const text = entry?.kind === 'missing' ? entry.prefill : entry?.row.fixPrefill;
      if (text) effects.push({ type: 'work', text });
      else if (entry) return { state: { ...state, note: '실패한 테스트와 테스트 없는 요구사항에서 Enter로 작업 글을 넣습니다' }, effects };
    }
    return { state, effects };
  }
  if (state.tab === 'docs') {
    const doc = state.docs?.[state.row];
    if (doc && ENTER.includes(key)) {
      effects.push({ type: 'doc', path: doc.path });
      return { state: { ...state, reader: { path: doc.path, scroll: 0 } }, effects };
    }
    if (key === 'e') effects.push({ type: 'edit', path: doc?.path ?? REQUIREMENTS_FILE });
    return { state, effects };
  }
  return { state, effects };
}

function specKey(state: RequirementsState, key: string, effects: RequirementsEffect[]): RequirementsState {
  const spec = state.spec;
  if (key === 'e') {
    effects.push({ type: 'edit', path: REQUIREMENTS_FILE });
    return state;
  }
  if (key === 'd') {
    if (!spec?.draft) return { ...state, note: '추출 결과가 없습니다(웹이나 CLI로 명세를 뽑으면 생깁니다)' };
    return { ...state, draft: !state.draft, row: 0 };
  }
  if (state.draft) {
    if (key === 's') return { ...state, confirm: { kind: 'apply-draft' } };
    return state;
  }
  const requirement = spec?.requirements[state.row];
  if (ENTER.includes(key)) {
    if (requirement?.workPrefill) effects.push({ type: 'work', text: requirement.workPrefill });
    return state;
  }
  if (key === 'a') {
    if (spec?.allMustHavesPrefill) {
      effects.push({ type: 'work', text: spec.allMustHavesPrefill });
      return state;
    }
    return { ...state, note: '필수(must) 요구사항이 없어 전체 계획 글이 없습니다' };
  }
  if (key === 'v' && requirement) return { ...state, verify: { requirementId: requirement.id, text: '' } };
  if (key === 'V' && requirement) {
    if (!requirement.manualVerification) return { ...state, note: `${requirement.id}에는 사람 확인 기록이 없습니다` };
    return { ...state, confirm: { kind: 'unverify', requirementId: requirement.id } };
  }
  return state;
}

function verifyKey(state: RequirementsState, verify: NonNullable<RequirementsState['verify']>, key: string, effects: RequirementsEffect[]): RequirementsState {
  if (key === ESC) return { ...state, verify: undefined };
  if (ENTER.includes(key)) {
    const note = verify.text.trim();
    if (!note) return { ...state, verify: { ...verify, error: '무엇을 어떻게 확인했는지 적어 주세요' } };
    effects.push({ type: 'verify', requirementId: verify.requirementId, note });
    return { ...state, verify: undefined };
  }
  if (BACKSPACE.includes(key)) return { ...state, verify: { requirementId: verify.requirementId, text: [...verify.text].slice(0, -1).join('') } };
  if (key === CTRL_U) return { ...state, verify: { requirementId: verify.requirementId, text: '' } };
  if (key.startsWith(ESC) || /^[\x00-\x1f\x7f]$/.test(key)) return state;
  return { ...state, verify: { requirementId: verify.requirementId, text: clip(verify.text + key) } };
}

function readerKey(state: RequirementsState, reader: ReaderState, key: string, effects: RequirementsEffect[]): RequirementsState {
  const last = Math.max(0, (reader.content ?? '').split('\n').length - 1);
  const to = (scroll: number) => ({ ...state, reader: { ...reader, scroll: Math.max(0, Math.min(last, scroll)) } });
  if (key === ESC || key === 'q') return { ...state, reader: undefined };
  if (UP.includes(key)) return to(reader.scroll - 1);
  if (DOWN.includes(key)) return to(reader.scroll + 1);
  if (PAGE_UP.includes(key)) return to(reader.scroll - PAGE);
  if (PAGE_DOWN.includes(key)) return to(reader.scroll + PAGE);
  if (key === 'g') return to(0);
  if (key === 'G') return to(last);
  if (key === 'e') effects.push({ type: 'edit', path: reader.path });
  if (key === 'r') effects.push({ type: 'doc', path: reader.path });
  return state;
}

function clip(text: string): string {
  return [...text].slice(0, NOTE_MAX).join('');
}

/** 붙여 넣은 글: 메모를 쓰는 중이면 한 줄로 넣는다. 그 밖에는 버린다 */
export function requirementsPaste(state: RequirementsState, text: string): RequirementsState {
  if (!state.verify) return state;
  const clean = text.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
  return { ...state, verify: { requirementId: state.verify.requirementId, text: clip(state.verify.text + clean) } };
}

export function requirementsHint(state: RequirementsState): string {
  if (state.verify) return ' 무엇을 어떻게 확인했는지 적습니다 · Enter 남기기 · Esc 그만두기';
  if (state.confirm?.kind === 'apply-draft') return ' 추출 결과를 docs/requirements.md로 저장할까요? 지금 문서는 바뀝니다 · y 저장 · 다른 키 그만두기';
  if (state.confirm) return ` ${state.confirm.requirementId}의 사람 확인 기록을 지울까요? · y 지우기 · 다른 키 그만두기`;
  if (state.note) return ` ${state.note}`;
  if (state.reader) return ' ↑↓ jk 줄 · PgUp PgDn 쪽 · g G 처음과 끝 · e 편집기로 고치기 · r 다시 읽기 · Esc 목록';
  const common = 'Tab 탭 · r 다시 읽기 · Esc 닫기';
  if (state.tab === 'spec') {
    if (state.draft) return ` 추출 결과 · ↑↓ 고르기 · s docs/requirements.md로 저장 · d·Esc 목록으로 · ${common}`;
    return ` 요구사항 · Enter 이 요구사항으로 작업 · v 사람 확인 · e 편집기 · a 필수 전체 계획 · d 추출 결과 · V 확인 지우기 · Tab 탭 · Esc 닫기`;
  }
  if (state.tab === 'tests') return ` ↑↓ 고르기 · Enter 고치기·테스트 더하기 글 넣기 · ${common}`;
  if (state.tab === 'docs') return ` ↑↓ 고르기 · Enter 읽기 · e 편집기로 고치기 · ${common}`;
  return ` ↑↓ 내리기 · ${common}`;
}

// ─── 마크다운 ───

interface Run {
  text: string;
  style: string;
}

/** 한 줄 안의 꾸밈: **굵게**, `코드`, [글](주소) */
function inlineRuns(text: string, base: string, theme: Theme): Run[] {
  const runs: Run[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > at) runs.push({ text: text.slice(at, match.index), style: base });
    if (match[1] !== undefined) runs.push({ text: match[1], style: base + BOLD });
    else if (match[2] !== undefined) runs.push({ text: match[2], style: fg(theme, 'teal') });
    else runs.push({ text: match[3]!, style: base + fg(theme, 'accent') }, { text: ` (${match[4]})`, style: fg(theme, 'muted') });
    at = match.index! + match[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), style: base });
  return runs;
}

/** 꾸민 글 조각들을 폭에 맞춰 접는다. 띄어쓰기에서 끊고, 한 낱말이 폭보다 길면 글자로 끊는다. 이어지는 줄은 indent칸 들여 쓴다 */
function wrapRuns(runs: readonly Run[], width: number, first: string, rest: string): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  let line = first;
  let used = stringWidth(first);
  let fresh = true;
  const push = () => {
    lines.push(line);
    line = rest;
    used = stringWidth(rest);
    fresh = true;
  };
  for (const run of runs) {
    for (const word of run.text.split(/(\s+)/)) {
      if (!word) continue;
      const space = /^\s+$/.test(word);
      if (space) {
        if (fresh) continue;
        if (used + 1 > limit) {
          push();
          continue;
        }
        line += ' ';
        used += 1;
        continue;
      }
      const wordWidth = stringWidth(word);
      if (used + wordWidth > limit && !fresh) push();
      let piece = '';
      for (const char of word) {
        const charWidth = stringWidth(char);
        if (used + charWidth > limit) {
          if (piece) line += `${run.style}${piece}${RESET}`;
          piece = '';
          push();
        }
        piece += char;
        used += charWidth;
        fresh = false;
      }
      if (piece) line += `${run.style}${piece}${RESET}`;
    }
  }
  if (line !== rest || lines.length === 0) lines.push(line);
  return lines;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 마크다운을 터미널 줄로. 제목은 굵은 강조색, 목록은 •, 인용은 │, 코드 블록은 바탕을 칠하고 들여쓰기를 둔다. 표는 칸을 맞춘 글로 */
export function markdownLines(text: string, width: number, theme: Theme): string[] {
  const out: string[] = [];
  const source = text.replace(/\r\n?/g, '\n').split('\n');
  let fence = false;
  for (let index = 0; index < source.length; index++) {
    const line = source[index]!;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(`${bg(theme, 'active')}${fg(theme, 'text')}${fit(line.replace(/\t/g, '  '), width)}${RESET}`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // 표: 이어진 줄을 모아 칸마다 가장 넓은 폭에 맞춘다
      const rows: string[][] = [];
      let at = index;
      while (at < source.length && /^\s*\|.*\|\s*$/.test(source[at]!)) {
        if (!TABLE_SEPARATOR.test(source[at]!)) rows.push(tableCells(source[at]!));
        at++;
      }
      index = at - 1;
      const widths: number[] = [];
      for (const row of rows) row.forEach((cell, column) => (widths[column] = Math.max(widths[column] ?? 0, stringWidth(cell))));
      rows.forEach((row, rowIndex) => {
        const cells = row.map((cell, column) => (column === row.length - 1 ? cell : cell + ' '.repeat((widths[column] ?? 0) - stringWidth(cell))));
        const joined = cells.join('  ');
        out.push(rowIndex === 0 ? `${BOLD}${fit(joined, width)}${RESET}` : fit(joined, width));
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const style = level <= 2 ? BOLD + fg(theme, 'accent') : BOLD;
      out.push(...wrapRuns(inlineRuns(heading[2]!.replace(/\s+#+\s*$/, ''), style, theme), width, '', ''));
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(`${fg(theme, 'border')}${'─'.repeat(Math.max(0, width))}${RESET}`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const mark = `${fg(theme, 'border')}│${RESET} `;
      out.push(...wrapRuns(inlineRuns(quote[1]!, fg(theme, 'muted'), theme), width, mark, mark));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (bullet) {
      const indent = ' '.repeat(Math.min(8, bullet[1]!.length));
      const mark = bullet[2] !== undefined ? (bullet[2] === ' ' ? '☐ ' : '☑ ') : '• ';
      out.push(...wrapRuns(inlineRuns(bullet[3]!, '', theme), width, `${indent}${mark}`, `${indent}${' '.repeat(stringWidth(mark))}`));
      continue;
    }
    const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
    if (numbered) {
      const indent = ' '.repeat(Math.min(8, numbered[1]!.length));
      const mark = `${numbered[2]} `;
      out.push(...wrapRuns(inlineRuns(numbered[3]!, '', theme), width, `${indent}${mark}`, `${indent}${' '.repeat(stringWidth(mark))}`));
      continue;
    }
    if (!line.trim()) {
      out.push('');
      continue;
    }
    // 스튜디오가 숨겨 둔 주석 블록(요구사항 JSON 등)은 보이지 않는다
    if (/^\s*<!--/.test(line)) {
      let at = index;
      while (at < source.length && !source[at]!.includes('-->')) at++;
      index = at;
      continue;
    }
    out.push(...wrapRuns(inlineRuns(line.trim(), '', theme), width, '', ''));
  }
  return out.map((line) => fitAnsi(line, width));
}

// ─── 그리기 ───

const TAB_WIDTH = 10;

const STATUS_STYLE: Record<DeskRequirementStatus, { mark: string; color: ColorToken }> = {
  미착수: { mark: '○', color: 'muted' },
  '작업 중': { mark: '◐', color: 'accent' },
  검증됨: { mark: '✓', color: 'green' },
  '재확인 필요': { mark: '▲', color: 'yellow' },
  실패: { mark: '×', color: 'red' },
};

const TEST_STYLE: Record<DeskTestRow['status'], { mark: string; color: ColorToken; label: string }> = {
  pass: { mark: '✓', color: 'green', label: '통과' },
  fail: { mark: '×', color: 'red', label: '실패' },
  skip: { mark: '–', color: 'muted', label: '건너뜀' },
  'not-run': { mark: '○', color: 'muted', label: '안 돎' },
};

const VERIFIED_BY: Record<string, string> = { test: '테스트', docs: '문서', manual: '사람 확인' };

function rowLine(text: string, width: number, selected: boolean, theme: Theme): string {
  if (!selected) return fitAnsi(text, width);
  const back = bg(theme, 'active');
  return fitAnsi(back + text.replaceAll(RESET, RESET + back), width, back);
}

/** 목록에서 고른 줄이 보이게 내린 첫 줄 */
function windowStart(selected: number, count: number, rows: number): number {
  if (count <= rows) return 0;
  return Math.max(0, Math.min(selected - Math.floor(rows / 2), count - rows));
}

interface Pane {
  lines: string[];
  cursor?: { x: number; y: number };
}

function requirementLine(requirement: Pick<DeskRequirement, 'id' | 'title' | 'priority'> & { status?: DeskRequirementStatus; ready?: boolean; issue?: number }, selected: boolean, width: number, theme: Theme): string {
  const muted = fg(theme, 'muted');
  const style = requirement.status ? STATUS_STYLE[requirement.status] : undefined;
  const mark = style ? `${fg(theme, style.color)}${style.mark}${RESET}` : ' ';
  const status = requirement.status ? `${fg(theme, style!.color)}${fit(requirement.status, 11)}${RESET}` : '';
  const priority = `${requirement.priority === 'must' ? fg(theme, 'yellow') : muted}${fit(requirement.priority, 6)}${RESET}`;
  const flags = [requirement.ready === false ? `${fg(theme, 'yellow')}고칠 것${RESET}` : '', requirement.issue ? `${muted}#${requirement.issue}${RESET}` : ''].filter(Boolean).join(' ');
  const text = `${selected ? `${fg(theme, 'accent')}▸${RESET}` : ' '} ${mark} ${BOLD}${fit(requirement.id, 4)}${RESET} ${status} ${priority} ${requirement.title}${flags ? `  ${flags}` : ''}`;
  return rowLine(text, width, selected, theme);
}

function detailLines(requirement: DeskRequirement | DeskRequirementsDraftEntry, width: number, theme: Theme): string[] {
  const muted = fg(theme, 'muted');
  const lines: string[] = [`${muted}${'─'.repeat(Math.max(0, width))}${RESET}`, `${BOLD}${requirement.id}. ${requirement.title}${RESET} ${muted}· ${requirement.kind}${'rev' in requirement && requirement.rev ? ` · 개정 ${requirement.rev}` : ''}${RESET}`];
  lines.push(`${muted}인수 조건${RESET}`);
  for (const acceptance of requirement.acceptance) lines.push(...wrapRuns([{ text: acceptance, style: '' }], width, '  • ', '    '));
  for (const scenario of requirement.scenarios ?? []) lines.push(...wrapRuns([{ text: `(Given) ${scenario.given} (When) ${scenario.when} (Then) ${scenario.then}`, style: muted }], width, `  ${scenario.id} `, '    '));
  if ('status' in requirement) {
    const evidence = requirement.evidence;
    const by = requirement.verifiedBy && requirement.verifiedBy !== 'none' ? VERIFIED_BY[requirement.verifiedBy] : undefined;
    const facts = [
      by ? `근거 ${by}` : '',
      evidence?.tests?.length ? `테스트 ${evidence.tests.length}개` : '',
      evidence?.checkpoints?.length ? `체크포인트 ${evidence.checkpoints.map((checkpoint) => checkpoint.shortSha).join(' ')}` : '',
      evidence?.missingScenarios?.length ? `${fg(theme, 'yellow')}확인 안 된 시나리오 ${evidence.missingScenarios.join(' ')}${RESET}` : '',
    ].filter(Boolean);
    if (facts.length) lines.push(`${muted}근거${RESET} ${facts.join(`${muted} · ${RESET}`)}`);
    if (requirement.manualVerification) {
      const manual = requirement.manualVerification;
      lines.push(...wrapRuns([{ text: `${manual.by} · ${manual.at} · ${manual.sha} · ${manual.note}`, style: '' }], width, `${muted}사람 확인${RESET} `, '  '));
    }
    for (const warning of requirement.lint ?? []) lines.push(...wrapRuns([{ text: warning.message, style: fg(theme, warning.mustFix ? 'yellow' : 'muted') }], width, warning.mustFix ? '  ▲ ' : '  · ', '    '));
  }
  return lines;
}

type DeskRequirementsDraftEntry = NonNullable<DeskRequirements['draft']>['requirements'][number];

function specPane(state: RequirementsState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const spec = state.spec;
  const lines: string[] = [];
  if (state.errors?.spec) lines.push(`${fg(theme, 'red')}요구사항을 받지 못했습니다: ${state.errors.spec}${RESET}`);
  if (!spec) {
    lines.push(`${muted}${state.loading?.includes('spec') ? '불러오는 중…' : 'r로 다시 읽습니다'}${RESET}`);
    return { lines };
  }
  if (state.draft && spec.draft) {
    const draft = spec.draft;
    lines.push(`${BOLD}추출 결과${RESET} ${muted}· 요구사항 ${draft.requirements.length}개${draft.appliedAt ? ' · 저장한 적 있음' : ' · 아직 저장 안 함'} · s로 docs/requirements.md에 저장합니다${RESET}`);
    for (const question of draft.questions ?? []) lines.push(...wrapRuns([{ text: question, style: fg(theme, 'yellow') }], width, '  ? ', '    '));
    lines.push('');
    const listRows = Math.max(1, Math.min(draft.requirements.length, Math.floor((height - lines.length) / 2)));
    const first = windowStart(state.row, draft.requirements.length, listRows);
    draft.requirements.slice(first, first + listRows).forEach((entry, at) => lines.push(requirementLine(entry, first + at === state.row, width, theme)));
    const selected = draft.requirements[state.row];
    if (selected) lines.push(...detailLines(selected, width, theme));
    return { lines: lines.slice(0, height) };
  }
  if (!spec.exists) {
    lines.push(`${muted}${REQUIREMENTS_FILE}가 아직 없습니다.${RESET}`, '', `e로 편집기를 열면 틀을 채워 둡니다. 저장하면 이 세션의 작업 복사본에 들어가 체크포인트·PR에 실립니다.`);
    if (spec.draft) lines.push('', `${fg(theme, 'accent')}추출 결과가 있습니다(요구사항 ${spec.draft.requirements.length}개). d로 보고 s로 저장합니다${RESET}`);
    return { lines: lines.map((line) => fitAnsi(line, width)) };
  }
  const coverage = spec.coverage;
  const summary = [coverage?.text, coverage?.mustGapText ? `${fg(theme, 'yellow')}${coverage.mustGapText}${RESET}` : '', coverage?.needsRecheckText ? `${fg(theme, 'yellow')}${coverage.needsRecheckText}${RESET}` : '', spec.draft ? `${fg(theme, 'accent')}추출 결과 있음(d)${RESET}` : ''].filter(Boolean);
  lines.push(summary.join(`${muted} · ${RESET}`) || `${muted}요구사항 ${spec.requirements.length}개${RESET}`);
  if (spec.assumptions.length) lines.push(...wrapRuns([{ text: spec.assumptions.join(' · '), style: muted }], width, `${muted}가정${RESET} `, '  '));
  lines.push('');
  if (spec.requirements.length === 0) lines.push(`${muted}  ${REQUIREMENTS_FILE}에서 요구사항을 하나도 읽지 못했습니다. e로 고칩니다${RESET}`);
  const listRows = Math.max(1, Math.min(spec.requirements.length, Math.floor((height - lines.length) / 2)));
  const first = windowStart(state.row, spec.requirements.length, listRows);
  spec.requirements.slice(first, first + listRows).forEach((requirement, at) => lines.push(requirementLine(requirement, first + at === state.row, width, theme)));
  const selected = spec.requirements[state.row];
  if (selected) lines.push(...detailLines(selected, width, theme));
  let cursor: Pane['cursor'];
  if (state.verify) {
    const prompt = `${state.verify.requirementId} 확인 메모> `;
    let shown = state.verify.text;
    while (shown && stringWidth(prompt) + stringWidth(shown) > width - 1) shown = [...shown].slice(1).join('');
    const at = Math.min(lines.length, height - (state.verify.error ? 3 : 2));
    lines.length = Math.max(0, at);
    lines.push('', `${fg(theme, 'accent')}${prompt}${RESET}${shown}`);
    cursor = { x: stringWidth(prompt) + stringWidth(shown), y: lines.length - 1 };
    if (state.verify.error) lines.push(`${fg(theme, 'red')}${state.verify.error}${RESET}`);
  }
  return { lines: lines.slice(0, height), ...(cursor ? { cursor } : {}) };
}

function testsPane(state: RequirementsState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  const lines: string[] = [];
  if (state.errors?.tests) lines.push(`${fg(theme, 'red')}테스트를 받지 못했습니다: ${state.errors.tests}${RESET}`);
  const tests = state.tests;
  if (!tests) {
    lines.push(`${muted}${state.loading?.includes('tests') ? '불러오는 중…' : 'r로 다시 읽습니다'}${RESET}`);
    return { lines };
  }
  for (const service of tests.services) {
    const counts = service.counts;
    const parts = [`${fg(theme, 'green')}통과 ${counts.pass}${RESET}`, counts.fail ? `${fg(theme, 'red')}실패 ${counts.fail}${RESET}` : '', counts.skip ? `건너뜀 ${counts.skip}` : '', counts.notRun ? `${muted}안 돎 ${counts.notRun}${RESET}` : ''].filter(Boolean);
    lines.push(`${BOLD}${service.service}${RESET} ${muted}${service.runner ?? ''}${service.running ? ' · 도는 중' : ''}${service.lastRunAt ? ` · 마지막 ${service.lastRunAt.slice(0, 16).replace('T', ' ')}` : ''}${RESET}  ${parts.join(' ')}`);
    if (service.error) lines.push(`${fg(theme, 'yellow')}  ${service.error}${RESET}`);
    else if (service.notice) lines.push(`${muted}  ${service.notice}${RESET}`);
  }
  if (tests.services.length === 0) lines.push(`${muted}테스트가 있는 서비스가 없습니다${RESET}`);
  lines.push('');
  const entries = testEntries(tests);
  const detailRows = 4;
  const listRows = Math.max(1, Math.min(entries.length, height - lines.length - detailRows));
  const first = windowStart(state.row, entries.length, listRows);
  entries.slice(first, first + listRows).forEach((entry, at) => {
    const selected = first + at === state.row;
    const pointer = selected ? `${fg(theme, 'accent')}▸${RESET}` : ' ';
    if (entry.kind === 'missing') {
      lines.push(rowLine(`${pointer} ${fg(theme, 'yellow')}○${RESET} ${BOLD}${fit(entry.id, 4)}${RESET} ${muted}테스트 없음${RESET} ${entry.title}`, width, selected, theme));
      return;
    }
    const style = TEST_STYLE[entry.row.status];
    const ids = entry.row.requirementIds.length ? `${muted}[${entry.row.requirementIds.join(' ')}]${RESET} ` : '';
    lines.push(rowLine(`${pointer} ${fg(theme, style.color)}${style.mark}${RESET} ${ids}${entry.row.displayName}  ${muted}${entry.row.file}:${entry.row.line}${RESET}`, width, selected, theme));
  });
  if (entries.length === 0) lines.push(`${muted}  찾은 테스트가 없습니다${RESET}`);
  const selected = entries[state.row];
  if (selected?.kind === 'test' && selected.row.failureMessage) {
    lines.push(`${muted}${'─'.repeat(Math.max(0, width))}${RESET}`);
    lines.push(...wrapRuns([{ text: selected.row.failureMessage, style: fg(theme, 'red') }], width, '', '').slice(0, detailRows - 1));
  }
  return { lines: lines.slice(0, height) };
}

function docsPane(state: RequirementsState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  if (state.reader) {
    const reader = state.reader;
    const head = `${BOLD}${reader.path}${RESET}`;
    if (reader.error) return { lines: [head, '', `${fg(theme, 'red')}읽지 못했습니다: ${reader.error}${RESET}`] };
    if (reader.content === undefined) return { lines: [head, '', `${muted}불러오는 중…${RESET}`] };
    const body = markdownLines(reader.content, width, theme);
    const rows = Math.max(1, height - 2);
    const scroll = Math.max(0, Math.min(reader.scroll, Math.max(0, body.length - rows)));
    const position = body.length > rows ? `${muted} · ${scroll + 1}-${Math.min(body.length, scroll + rows)}/${body.length}줄${RESET}` : '';
    return { lines: [head + position, `${muted}${'─'.repeat(Math.max(0, width))}${RESET}`, ...body.slice(scroll, scroll + rows)] };
  }
  const lines: string[] = [];
  if (state.errors?.docs) lines.push(`${fg(theme, 'red')}문서 목록을 받지 못했습니다: ${state.errors.docs}${RESET}`);
  const docs = state.docs;
  if (!docs) {
    lines.push(`${muted}${state.loading?.includes('docs') ? '불러오는 중…' : 'r로 다시 읽습니다'}${RESET}`);
    return { lines };
  }
  lines.push(`${muted}문서 ${docs.length}개 · docs/ 아래 마크다운과 README·CHANGELOG·CONTRIBUTING${RESET}`, '');
  if (docs.length === 0) lines.push(`${muted}  문서가 없습니다. e로 ${REQUIREMENTS_FILE}부터 씁니다${RESET}`);
  const pathWidth = Math.min(36, Math.max(8, ...docs.map((doc) => stringWidth(doc.path))));
  const listRows = Math.max(1, height - lines.length);
  const first = windowStart(state.row, docs.length, listRows);
  docs.slice(first, first + listRows).forEach((doc, at) => {
    const selected = first + at === state.row;
    lines.push(rowLine(`${selected ? `${fg(theme, 'accent')}▸${RESET}` : ' '} ${fit(doc.path, pathWidth)}  ${doc.title === doc.path ? '' : doc.title}`, width, selected, theme));
  });
  return { lines: lines.slice(0, height) };
}

function statusLines(status: DeskProjectStatus, width: number, theme: Theme): string[] {
  const muted = fg(theme, 'muted');
  const section = (title: string) => ['', `${BOLD}${fg(theme, 'accent')}${title}${RESET}`];
  const bullets = (items: readonly string[], empty: string) => (items.length ? items.flatMap((item) => wrapRuns([{ text: item, style: '' }], width, '  • ', '    ')) : [`${muted}  ${empty}${RESET}`]);
  const lines: string[] = [];
  lines.push(`${BOLD}${fg(theme, 'accent')}지금 하는 일${RESET}`, ...wrapRuns([{ text: status.currentWork.summary, style: '' }], width, '  ', '  '), ...bullets(status.currentWork.items, ''));
  if (status.currentWork.items.length === 0) lines.pop();
  lines.push(...section('목적'), ...bullets(status.purpose.items.map((item) => `${item.id}. ${item.title}${item.issue ? ` (#${item.issue})` : ''}`), '저장된 must·should 요구사항이 없습니다'));
  lines.push(...section('예상'), ...wrapRuns([{ text: status.eta.summary, style: status.eta.hasEstimate ? '' : muted }], width, '  ', '  '));
  lines.push(...section('산출물'));
  if (status.deliverables.pullRequestUrl) lines.push(`  PR ${osc8(status.deliverables.pullRequestUrl, status.deliverables.pullRequestUrl)}`);
  lines.push(...bullets(status.deliverables.checkpoints.map((checkpoint) => `${checkpoint.shortSha} ${checkpoint.message.split('\n')[0]}`), '체크포인트가 없습니다'));
  lines.push(...section('위험'), ...bullets(status.risks.items, '알려진 위험이 없습니다'));
  const byStatus = Object.entries(status.verification.byStatus).map(([name, count]) => `${name} ${count}`).join(' · ');
  lines.push(...section('검증'), ...wrapRuns([{ text: status.verification.summary, style: '' }], width, '  ', '  '));
  if (byStatus) lines.push(`${muted}  ${byStatus}${RESET}`);
  if (status.estimateVsActual.length) {
    lines.push(...section('예상과 실제'));
    for (const entry of status.estimateVsActual) {
      const estimate = entry.estimateMinutes === undefined ? '추정 없음' : `예상 ${entry.estimateMinutes}분`;
      const actual = entry.actualMinutes === undefined ? '' : ` · 실제 ${entry.actualMinutes}분`;
      lines.push(fitAnsi(`  ${entry.label}  ${muted}${estimate}${actual}${entry.note ? ` · ${entry.note}` : ''}${RESET}`, width));
    }
  }
  lines.push(...section('문서'), `${muted}  ${status.links.roadmap} · ${status.links.changelog} · ${status.links.docsIndex}${RESET}`);
  return lines.map((line) => fitAnsi(line, width));
}

function statusPane(state: RequirementsState, width: number, height: number, theme: Theme): Pane {
  const muted = fg(theme, 'muted');
  if (!state.status) {
    const lines = state.errors?.status ? [`${fg(theme, 'red')}현황을 받지 못했습니다: ${state.errors.status}${RESET}`] : [];
    lines.push(`${muted}${state.loading?.includes('status') ? '불러오는 중…' : 'r로 다시 읽습니다'}${RESET}`);
    return { lines };
  }
  const all = statusLines(state.status, width, theme);
  const scroll = Math.max(0, Math.min(state.row, Math.max(0, all.length - height)));
  return { lines: all.slice(scroll, scroll + height) };
}

/** 요구사항 화면 본문(머리 줄과 아래 줄 사이). 둥근 테두리 안에 왼쪽 탭, 오른쪽 내용이다 */
export function renderRequirements(state: RequirementsState, size: { w: number; h: number }, theme: Theme): { lines: string[]; cursor?: { x: number; y: number } } {
  const inner = { w: Math.max(0, size.w - 4), h: Math.max(0, size.h - 2) };
  const contentWidth = Math.max(0, inner.w - TAB_WIDTH - 3);
  const muted = fg(theme, 'muted');
  let pane: Pane;
  if (state.tab === 'spec') pane = specPane(state, contentWidth, inner.h, theme);
  else if (state.tab === 'tests') pane = testsPane(state, contentWidth, inner.h, theme);
  else if (state.tab === 'docs') pane = docsPane(state, contentWidth, inner.h, theme);
  else pane = statusPane(state, contentWidth, inner.h, theme);

  const rows: string[] = [];
  for (let y = 0; y < inner.h; y++) {
    const tab = REQUIREMENTS_TABS[y - 1];
    let left = '';
    if (tab) {
      const current = tab.tab === state.tab;
      const loading = state.loading?.includes(tab.tab) ? '…' : '';
      left = current ? `${bg(theme, 'active')}${fg(theme, 'accent')}${BOLD}▸ ${tab.label}${loading}${RESET}` : `${muted}  ${tab.label}${loading}${RESET}`;
    }
    rows.push(`${fitAnsi(left, TAB_WIDTH)} ${fg(theme, 'border')}│${RESET} ${fitAnsi(pane.lines[y] ?? '', contentWidth)}`);
  }
  const lines = box(rows, size.w, theme, { title: `요구사항 · ${state.title}`, focused: true });
  while (lines.length < size.h) lines.push(' '.repeat(size.w));
  const cursor = pane.cursor && pane.cursor.y < inner.h ? { x: 2 + TAB_WIDTH + 3 + Math.min(pane.cursor.x, contentWidth - 1), y: 1 + pane.cursor.y } : undefined;
  return { lines: lines.slice(0, size.h).map((line) => fitAnsi(line, size.w)), ...(cursor ? { cursor } : {}) };
}
