/**
 * 지금 변경 화면(#924, 앞글쇠 다음 d): 마지막 체크포인트 뒤에 에이전트가 바꾼 것을 desk에서 보고, 줄마다 의견을 달아 한 번에 보낸다.
 *
 * 스튜디오(`GET /api/sessions/:id/changes`)가 파일마다의 diff를 주면 왼쪽 파일 목록과 오른쪽 diff로 그린다. diff 줄에서 c로 의견을 쓰고,
 * S를 누르면 해결하지 않은 의견을 "파일:줄 + 그 줄 + 의견"으로 묶어 그 세션의 칸 입력에 붙여 넣는다. 보내기(Enter)는 사람이 한다.
 * 보낸 의견은 지우지 않는다: x로 해결 표시를 할 때까지 다음 묶음에도 들어간다. 의견은 세션마다 desk 설정 폴더에 남는다(comments-store.ts).
 * 키(changesKey)는 화면 상태만 바꾸고 할 일(ChangesEffect)을 돌려준다. 스튜디오를 부르고 칸에 붙여 넣는 일은 desk.ts가 한다
 */
import { fit, fitAnsi, stringWidth } from './screen';
import { BOLD, bg, fg, RESET, type Theme } from './theme';
import { box } from './widgets';

/** 지금 변경의 파일 하나(스튜디오의 LiveChangeFile) */
export interface LiveChangeFileView {
  file: string;
  change: 'added' | 'modified' | 'deleted';
  patch?: string;
  binary?: true;
  unsupported?: true;
  truncated?: true;
  added: number;
  removed: number;
}

/** 지금 변경(스튜디오의 LiveChanges) */
export interface LiveChangesView {
  files: LiveChangeFileView[];
  truncated: boolean;
  head?: string;
  branch?: string;
  base?: string;
  behind?: number;
  ahead?: number;
}

/** diff 줄 하나에 단 의견. line은 side 쪽 파일의 줄 번호다(지운 줄이면 옛 파일) */
export interface DeskComment {
  id: string;
  file: string;
  line: number;
  side: 'new' | 'old';
  /** 의견을 단 줄의 글(파일이 바뀌어도 무엇에 단 의견인지 보이게) */
  code: string;
  text: string;
  resolved?: boolean;
  /** 마지막으로 묶어 보낸 때 */
  sentAt?: string;
  createdAt: string;
}

/** 그릴 diff 줄 */
export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  old?: number;
  new?: number;
}

export interface ChangesState {
  id: string;
  title: string;
  loading: boolean;
  error?: string;
  data?: LiveChangesView;
  /** 고른 파일(data.files 순서) */
  file: number;
  /** 고른 파일의 diff에서 고른 줄 */
  row: number;
  focus: 'files' | 'diff';
  comments: DeskComment[];
  /** 고른 줄에 쓰는 의견 */
  writing?: { text: string };
  /** 아래 줄에 잠깐 보이는 알림 */
  note?: string;
}

export type ChangesEffect =
  | { type: 'load'; id: string }
  /** 이 세션의 의견을 모두 저장한다 */
  | { type: 'save-comments'; id: string; comments: DeskComment[] }
  /** 묶은 의견을 그 세션의 칸 입력에 붙여 넣는다(보내지 않는다) */
  | { type: 'send'; id: string; text: string; count: number }
  | { type: 'close' };

const ESC = '\x1b';
const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j'];
const LEFT = ['\x1b[D', '\x1bOD'];
const RIGHT = ['\x1b[C', '\x1bOC'];
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const BACKSPACE = ['\x7f', '\b'];
const ENTER = ['\r', '\n'];
/** 화면에 그대로 내면 안 되는 제어 글자(탭·줄바꿈은 따로 다룬다). 파일 내용이 밖 터미널을 조작하지 못하게 한다 */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g;

export function openChanges(id: string, title: string, comments: readonly DeskComment[]): { state: ChangesState; effects: ChangesEffect[] } {
  return { state: { id, title, loading: true, file: 0, row: 0, focus: 'files', comments: [...comments] }, effects: [{ type: 'load', id }] };
}

/** 받은 변경을 넣는다. 고른 파일은 이름으로 따라가고, 사라졌으면 범위 안으로 옮긴다 */
export function changesLoaded(state: ChangesState, data: LiveChangesView): ChangesState {
  const before = state.data?.files[state.file]?.file;
  const at = before === undefined ? -1 : data.files.findIndex((entry) => entry.file === before);
  const file = at >= 0 ? at : Math.max(0, Math.min(state.file, data.files.length - 1));
  const row = at >= 0 ? Math.min(state.row, Math.max(0, rowsOf(data.files[file]).length - 1)) : 0;
  return { ...state, loading: false, error: undefined, data, file, row };
}

export function changesFailed(state: ChangesState, error: string): ChangesState {
  return { ...state, loading: false, error };
}

/** 글을 화면에 낼 꼴로: 탭은 빈칸 넷, 제어 글자는 · */
function clean(text: string): string {
  return text.replace(/\t/g, '    ').replace(CONTROL, '·');
}

/** diff를 그릴 줄로 나눈다. diff --git·index·---·+++ 같은 머리 줄은 뺀다 */
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 0;
  let next = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: clean(line) });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) rows.push({ kind: 'add', text: clean(line.slice(1)), new: next++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: clean(line.slice(1)), old: old++ });
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', text: clean(line.slice(1)), old: old++, new: next++ });
    else if (line.startsWith('\\')) rows.push({ kind: 'meta', text: clean(line) });
    else if (line.startsWith('[... ')) rows.push({ kind: 'meta', text: clean(line) });
    else if (line !== '') inHunk = false;
  }
  return rows;
}

function rowsOf(file: LiveChangeFileView | undefined): DiffRow[] {
  return file?.patch ? diffRows(file.patch) : [];
}

/** 이 줄에 의견을 달 때의 자리. 머리 줄에는 달지 않는다 */
function anchorOf(row: DiffRow | undefined): { line: number; side: 'new' | 'old' } | undefined {
  if (!row) return undefined;
  if (row.kind === 'del' && row.old !== undefined) return { line: row.old, side: 'old' };
  if ((row.kind === 'add' || row.kind === 'ctx') && row.new !== undefined) return { line: row.new, side: 'new' };
  return undefined;
}

/** 이 파일의 이 줄에 단 의견 */
function commentsAt(comments: readonly DeskComment[], file: string, row: DiffRow | undefined): DeskComment[] {
  const anchor = anchorOf(row);
  if (!anchor) return [];
  return comments.filter((comment) => comment.file === file && comment.line === anchor.line && comment.side === anchor.side);
}

/** 해결하지 않은 의견을 에이전트에게 보낼 글 하나로 묶는다. 끝에 줄바꿈을 두지 않는다(보내기는 사람이 한다) */
export function commentPrompt(comments: readonly DeskComment[]): string {
  const items = comments.map((comment, index) => {
    const where = `${comment.file}:${comment.line}${comment.side === 'old' ? '(지운 줄)' : ''}`;
    const code = comment.code.trim() ? `\n   > ${comment.code.trim()}` : '';
    return `${index + 1}. ${where}${code}\n   ${comment.text}`;
  });
  return `지금 변경을 보고 단 의견입니다. 하나씩 반영해 주세요.\n\n${items.join('\n\n')}`;
}

function newId(comments: readonly DeskComment[], now: string): string {
  let id = `c${Date.parse(now) || 0}`;
  while (comments.some((comment) => comment.id === id)) id += 'x';
  return id;
}

/** 키 하나. state가 undefined면 화면을 닫았다. now는 의견에 남길 시각이다(테스트가 정한다) */
export function changesKey(state: ChangesState, key: string, now: () => string = () => new Date().toISOString()): { state: ChangesState | undefined; effects: ChangesEffect[] } {
  const effects: ChangesEffect[] = [];
  const base: ChangesState = state.note ? { ...state, note: undefined } : state;
  const files = state.data?.files ?? [];
  const current = files[state.file];
  const rows = rowsOf(current);

  if (state.writing) {
    const writing = state.writing;
    if (key === ESC || key === '\x03') return { state: { ...base, writing: undefined }, effects };
    if (ENTER.includes(key)) {
      const text = writing.text.trim();
      const anchor = anchorOf(rows[state.row]);
      if (!text || !anchor || !current) return { state: { ...base, writing: undefined }, effects };
      const at = now();
      const comment: DeskComment = { id: newId(state.comments, at), file: current.file, ...anchor, code: rows[state.row]!.text, text, createdAt: at };
      const comments = [...state.comments, comment];
      effects.push({ type: 'save-comments', id: state.id, comments });
      return { state: { ...base, writing: undefined, comments }, effects };
    }
    if (BACKSPACE.includes(key)) return { state: { ...base, writing: { text: Array.from(writing.text).slice(0, -1).join('') } }, effects };
    if (key === '\x15') return { state: { ...base, writing: { text: '' } }, effects };
    if (key.startsWith(ESC) || /[\u0000-\u001f\u007f]/.test(key)) return { state: base, effects };
    return { state: { ...base, writing: { text: writing.text + key } }, effects };
  }

  if (key === ESC || key === '\x03' || key === 'q') {
    effects.push({ type: 'close' });
    return { state: undefined, effects };
  }
  if (key === 'r') {
    effects.push({ type: 'load', id: state.id });
    return { state: { ...base, loading: true }, effects };
  }
  if (key === 'S') {
    const open = state.comments.filter((comment) => !comment.resolved);
    if (open.length === 0) return { state: { ...base, note: '보낼 의견이 없습니다(해결하지 않은 의견만 보냅니다). diff 줄에서 c로 의견을 씁니다' }, effects };
    const at = now();
    const ids = new Set(open.map((comment) => comment.id));
    const comments = state.comments.map((comment) => (ids.has(comment.id) ? { ...comment, sentAt: at } : comment));
    effects.push({ type: 'save-comments', id: state.id, comments });
    effects.push({ type: 'send', id: state.id, text: commentPrompt(open), count: open.length });
    return { state: { ...base, comments }, effects };
  }
  const pickFile = (index: number): ChangesState => ({ ...base, file: Math.max(0, Math.min(files.length - 1, index)), row: 0 });
  if (key === ']') return { state: pickFile(state.file + 1), effects };
  if (key === '[') return { state: pickFile(state.file - 1), effects };
  if (key === '\t' || LEFT.includes(key) || RIGHT.includes(key)) {
    const focus = key === '\t' ? (state.focus === 'files' ? 'diff' : 'files') : LEFT.includes(key) ? 'files' : 'diff';
    return { state: { ...base, focus }, effects };
  }

  if (state.focus === 'files') {
    if (UP.includes(key)) return { state: pickFile(state.file - 1), effects };
    if (DOWN.includes(key)) return { state: pickFile(state.file + 1), effects };
    if (ENTER.includes(key)) return { state: current ? { ...base, focus: 'diff' } : base, effects };
    return { state: base, effects };
  }

  const moveRow = (by: number): ChangesState => ({ ...base, row: Math.max(0, Math.min(rows.length - 1, state.row + by)) });
  if (UP.includes(key)) return { state: moveRow(-1), effects };
  if (DOWN.includes(key)) return { state: moveRow(1), effects };
  if (key === PAGE_UP) return { state: moveRow(-10), effects };
  if (key === PAGE_DOWN || key === ' ') return { state: moveRow(10), effects };
  if (key === 'g') return { state: { ...base, row: 0 }, effects };
  if (key === 'G') return { state: { ...base, row: Math.max(0, rows.length - 1) }, effects };
  if (key === 'c') {
    if (!anchorOf(rows[state.row])) return { state: { ...base, note: '의견은 더하거나 지우거나 그대로 둔 줄에 답니다(@@ 머리 줄 말고)' }, effects };
    return { state: { ...base, writing: { text: '' } }, effects };
  }
  if (key === 'x' || key === 'D') {
    const here = current ? commentsAt(state.comments, current.file, rows[state.row]) : [];
    if (here.length === 0) return { state: { ...base, note: '이 줄에는 의견이 없습니다' }, effects };
    const ids = new Set(here.map((comment) => comment.id));
    // x: 이 줄의 의견이 모두 해결이면 풀고, 아니면 모두 해결로
    const resolve = here.some((comment) => !comment.resolved);
    const comments =
      key === 'D'
        ? state.comments.filter((comment) => !ids.has(comment.id))
        : state.comments.map((comment) => {
            if (!ids.has(comment.id)) return comment;
            const { resolved: _resolved, ...rest } = comment;
            return resolve ? { ...rest, resolved: true } : rest;
          });
    effects.push({ type: 'save-comments', id: state.id, comments });
    return { state: { ...base, comments }, effects };
  }
  return { state: base, effects };
}

/** 붙여 넣은 글: 의견을 쓰는 중에만 한 줄로 받는다 */
export function changesPaste(state: ChangesState, text: string): ChangesState {
  if (!state.writing) return state;
  const line = text.replace(/\r\n?|\n/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
  return { ...state, writing: { text: state.writing.text + line } };
}

const CHANGE_MARK: Record<LiveChangeFileView['change'], { mark: string; color: 'green' | 'yellow' | 'red' }> = {
  added: { mark: 'A', color: 'green' },
  modified: { mark: 'M', color: 'yellow' },
  deleted: { mark: 'D', color: 'red' },
};

function headerLine(state: ChangesState, width: number, theme: Theme): string {
  const muted = fg(theme, 'muted');
  const data = state.data;
  const parts: string[] = [];
  if (data?.branch) parts.push(`${fg(theme, 'text')}${data.branch}${RESET}`);
  if (data?.base && data.behind !== undefined) parts.push(`${data.behind > 0 ? fg(theme, 'yellow') : muted}${data.base}보다 ${data.behind} 뒤${data.ahead !== undefined ? ` · ${data.ahead} 앞` : ''}${RESET}`);
  if (data?.head) parts.push(`${muted}체크포인트 ${data.head} 뒤${RESET}`);
  if (data) {
    const added = data.files.reduce((sum, file) => sum + file.added, 0);
    const removed = data.files.reduce((sum, file) => sum + file.removed, 0);
    parts.push(`${muted}파일 ${data.files.length}${data.truncated ? '+' : ''}${RESET} ${fg(theme, 'green')}+${added}${RESET} ${fg(theme, 'red')}−${removed}${RESET}`);
  }
  const open = state.comments.filter((comment) => !comment.resolved).length;
  if (state.comments.length) parts.push(`${fg(theme, open ? 'accent' : 'muted')}의견 ${open}${state.comments.length > open ? `(해결 ${state.comments.length - open})` : ''}${RESET}`);
  return fitAnsi(` ${parts.join(`${muted} · ${RESET}`)}`, width);
}

function fileLines(state: ChangesState, width: number, height: number, theme: Theme): string[] {
  const files = state.data?.files ?? [];
  const offset = Math.max(0, Math.min(state.file - height + 1, files.length - height));
  const lines: string[] = [];
  for (const [index, file] of files.slice(offset, offset + height).entries()) {
    const at = offset + index;
    const selected = at === state.file;
    const { mark, color } = CHANGE_MARK[file.change];
    const count = file.binary ? '바이너리' : `+${file.added} −${file.removed}`;
    const notes = state.comments.filter((comment) => comment.file === file.file && !comment.resolved).length;
    const right = `${notes ? `의견 ${notes} ` : ''}${count}`;
    const nameWidth = Math.max(4, width - 4 - stringWidth(right) - 1);
    let name = file.file;
    // 긴 경로는 앞을 줄여 파일 이름이 보이게 한다
    while (stringWidth(name) > nameWidth && name.length > 1) name = `…${Array.from(name).slice(2).join('')}`;
    const cursor = selected ? (state.focus === 'files' ? `${fg(theme, 'accent')}▸${RESET}` : `${fg(theme, 'muted')}›${RESET}`) : ' ';
    const line = `${cursor}${fg(theme, color)}${mark}${RESET} ${selected ? BOLD : ''}${fit(name, nameWidth)}${RESET} ${fg(theme, 'muted')}${right}${RESET}`;
    lines.push(selected ? fitAnsi(line, width, bg(theme, 'active')) : fitAnsi(line, width));
  }
  return lines;
}

function diffLines(state: ChangesState, width: number, height: number, theme: Theme): string[] {
  const muted = fg(theme, 'muted');
  const file = state.data?.files[state.file];
  if (!file) return [];
  const head = fitAnsi(` ${BOLD}${file.file}${RESET}${file.truncated ? `${fg(theme, 'yellow')} · 길어서 앞부분만${RESET}` : ''}`, width);
  if (file.binary) return [head, '', fitAnsi(`${muted} 바이너리 파일이라 내용을 보이지 않습니다${RESET}`, width)];
  if (file.unsupported) return [head, '', fitAnsi(`${muted} 링크처럼 내용을 보일 수 없는 파일입니다${RESET}`, width)];
  const rows = rowsOf(file);
  if (rows.length === 0) return [head, '', fitAnsi(`${muted} ${file.change === 'added' ? '빈 새 파일입니다' : '보일 diff가 없습니다(모드만 바뀌었을 수 있습니다)'}${RESET}`, width)];
  // 줄마다 그 밑의 의견을 함께 그린다. 고른 줄이 보이게 내린다
  const blocks = rows.map((row, index) => {
    const selected = index === state.row && state.focus === 'diff';
    const number = row.kind === 'del' ? row.old : row.new;
    const gutter = row.kind === 'hunk' || row.kind === 'meta' ? '     ' : String(number ?? '').padStart(4) + ' ';
    const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
    const color = row.kind === 'add' ? fg(theme, 'green') : row.kind === 'del' ? fg(theme, 'red') : row.kind === 'hunk' ? fg(theme, 'accent') : row.kind === 'meta' ? muted : fg(theme, 'text');
    const cursor = selected ? `${fg(theme, 'accent')}▸${RESET}` : ' ';
    const text = `${cursor}${muted}${gutter}${RESET}${color}${sign}${row.text}${RESET}`;
    const lines = [selected ? fitAnsi(text, width, bg(theme, 'active')) : fitAnsi(text, width)];
    for (const comment of commentsAt(state.comments, file.file, row)) {
      const mark = comment.resolved ? `${muted}✓ ` : `${fg(theme, 'yellow')}● `;
      lines.push(fitAnsi(`       ${mark}${comment.text}${RESET}${comment.sentAt && !comment.resolved ? `${muted} · 보냄${RESET}` : ''}`, width));
    }
    if (selected && state.writing) lines.push(fitAnsi(`       ${fg(theme, 'accent')}의견> ${RESET}${state.writing.text}`, width));
    return lines;
  });
  const room = Math.max(1, height - 1);
  let start = 0;
  let used = 0;
  // 고른 줄의 묶음 끝까지가 보이도록 시작 줄을 정한다
  for (let index = 0; index <= state.row && index < blocks.length; index++) used += blocks[index]!.length;
  while (used > room && start < state.row) used -= blocks[start++]!.length;
  const lines = [head];
  for (const block of blocks.slice(start)) {
    for (const line of block) if (lines.length < height) lines.push(line);
  }
  return lines;
}

export function renderChanges(state: ChangesState, size: { w: number; h: number }, theme: Theme): { lines: string[]; cursor?: { x: number; y: number } } {
  const inner = { w: Math.max(0, size.w - 4), h: Math.max(0, size.h - 2) };
  const muted = fg(theme, 'muted');
  const body: string[] = [headerLine(state, inner.w, theme), ''];
  if (state.error) body.push(fitAnsi(`${fg(theme, 'red')} 지금 변경을 받지 못했습니다: ${state.error}${RESET}`, inner.w));
  else if (!state.data) body.push(fitAnsi(`${muted} 지금 변경을 받는 중…${RESET}`, inner.w));
  else if (state.data.files.length === 0) body.push(fitAnsi(`${muted} 마지막 체크포인트 뒤로 바뀐 파일이 없습니다. r로 다시 받습니다${RESET}`, inner.w));
  else {
    const height = Math.max(1, inner.h - body.length);
    // 넓으면 파일 목록과 diff를 나란히, 좁으면 고른 쪽만 보인다
    if (inner.w >= 90) {
      const left = Math.min(40, Math.floor(inner.w / 3));
      const right = inner.w - left - 1;
      const files = fileLines(state, left, height, theme);
      const diff = diffLines(state, right, height, theme);
      for (let y = 0; y < height; y++) body.push(`${fitAnsi(files[y] ?? '', left)}${fg(theme, 'border')}│${RESET}${fitAnsi(diff[y] ?? '', right)}`);
    } else {
      body.push(...(state.focus === 'files' ? fileLines(state, inner.w, height, theme) : diffLines(state, inner.w, height, theme)));
    }
  }
  if (state.loading && state.data) body[1] = fitAnsi(`${muted} 다시 받는 중…${RESET}`, inner.w);
  const rows = Array.from({ length: inner.h }, (_, y) => body[y] ?? '');
  const lines = box(rows, size.w, theme, { title: `지금 변경 · ${state.title}`, focused: true });
  while (lines.length < size.h) lines.push(' '.repeat(size.w));
  return { lines: lines.slice(0, size.h).map((line) => fitAnsi(line, size.w)) };
}

export function changesHint(state: ChangesState): string {
  if (state.note) return ` ${state.note}`;
  if (state.writing) return ' 의견 쓰기 · Enter 남기기 · Ctrl-u 지우기 · Esc 그만두기';
  if (state.focus === 'files') return ' 지금 변경 · ↑↓ 파일 · Enter·→ diff · S 의견 묶어 칸에 넣기 · r 다시 받기 · Esc 닫기';
  return ' 지금 변경 · ↑↓ 줄 · c 의견 · x 해결 표시 · D 의견 지우기 · [ ] 앞뒤 파일 · ← 파일 목록 · S 의견 묶어 칸에 넣기 · r 다시 받기 · Esc 닫기';
}
