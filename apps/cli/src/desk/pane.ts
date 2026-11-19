/**
 * desk 칸 하나의 터미널 해석. 스튜디오가 흘려 주는 CLI 출력(화면 제어 문자 포함)을 `@xterm/headless`로 해석해 두고,
 * 그릴 때 화면 줄(색은 SGR로)과 커서 자리를 꺼낸다. 브라우저의 터미널 격자(ADR-177)가 xterm으로 하는 일을 CLI 안에서 한다
 */
import { createRequire } from 'node:module';
import type { Unicode11Addon as Unicode11AddonType } from '@xterm/addon-unicode11';
import type { IBufferCell, IBufferLine, IMarker, Terminal as HeadlessTerminal } from '@xterm/headless';
import { stringWidth } from './screen';
import { rgbTo256 } from './theme';

// 패키지가 CommonJS 진입점만 실제로 싣고 있어(module 필드의 파일이 없다) require로 읽는다
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
// 이모지·풀어쓴 한글을 실제 터미널처럼 2칸으로 센다(기본 유니코드 6 폭은 이모지를 1칸으로 본다, #860)
const { Unicode11Addon } = require('@xterm/addon-unicode11') as { Unicode11Addon: typeof Unicode11AddonType };

const RESET = '\x1b[0m';
/** 칸 하나가 기억하는 지난 줄 수. 복사 모드에서 올려 본다(#863). Claude Code는 대화를 일반 화면에 쌓는다 */
const SCROLLBACK = 5_000;
const INVERSE = '\x1b[7m';
/** 터미널 전체 초기화(RIS). 쓰기 줄 순서대로 처리돼, 앞서 쌓인 출력을 지운 뒤에 다시 받은 출력이 그려진다 */
const FULL_RESET = '\x1bc';

interface CellStyle {
  fg: string;
  bg: string;
  flags: string;
}

function colorCode(cell: IBufferCell, ground: 'fg' | 'bg', truecolor: boolean): string {
  const base = ground === 'fg' ? 30 : 40;
  if (ground === 'fg' ? cell.isFgDefault() : cell.isBgDefault()) return '';
  const color = ground === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (ground === 'fg' ? cell.isFgRGB() : cell.isBgRGB()) {
    const [r, g, b] = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
    // 24비트 색을 알리지 않는 밖 터미널(옛 판 macOS 터미널 등)에는 256색 근사로 낮춘다(#874)
    return truecolor ? `${base + 8};2;${r};${g};${b}` : `${base + 8};5;${rgbTo256(r, g, b)}`;
  }
  if (color < 8) return String(base + color);
  if (color < 16) return String(base + 60 + color - 8);
  return `${base + 8};5;${color}`;
}

/** invert: 마우스로 고른 칸이다. 이미 반전인 칸은 반전을 풀어 고른 것이 눈에 띄게 한다 */
function styleOf(cell: IBufferCell, truecolor: boolean, invert = false): CellStyle {
  const flags = [cell.isBold() ? '1' : '', cell.isDim() ? '2' : '', cell.isItalic() ? '3' : '', cell.isUnderline() ? '4' : '', (cell.isInverse() !== 0) !== invert ? '7' : '', cell.isInvisible() ? '8' : '', cell.isStrikethrough() ? '9' : '']
    .filter(Boolean)
    .join(';');
  return { fg: colorCode(cell, 'fg', truecolor), bg: colorCode(cell, 'bg', truecolor), flags };
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.flags === b.flags;
}

function sgr(style: CellStyle): string {
  const parts = [style.flags, style.fg, style.bg].filter(Boolean).join(';');
  return parts ? `\x1b[0;${parts}m` : RESET;
}

/** 칸의 CLI가 켠 모드. desk가 입력을 CLI가 기대하는 꼴로 바꾸고 커서를 그릴지 정하는 데 쓴다 */
export interface PaneModes {
  bracketedPaste: boolean;
  appCursor: boolean;
  cursorHidden: boolean;
  /** CLI가 마우스 알림을 켰다(1000·1002·1003). 켰으면 desk가 칸 안의 마우스를 넘긴다(#874) */
  mouse: boolean;
  /** CLI가 단추를 누른 채 움직임(1002)이나 모든 움직임(1003)을 켰다. 켰을 때만 움직임 이벤트를 넘긴다 */
  mouseMotion: boolean;
  /** 마우스를 SGR 꼴(1006)로 받는다. 아니면 옛 꼴(X10)로 넘긴다 */
  sgrMouse: boolean;
}

/** 복사 모드에서 보는 것. 들어갈 때 화면과 지난 줄을 떠 두어, 새 출력이 와도 보던 자리가 움직이지 않는다 */
interface CopyView {
  styled: string[];
  plain: string[];
  cols: number;
  top: number;
  cursor: number;
  anchor?: number;
  query?: string;
}

/** 마우스로 고른 범위의 한쪽 끝. 줄은 버퍼의 절대 줄을 표식(marker)으로 들어, 새 출력으로 화면이 밀려도 같은 글을 가리킨다 */
interface SelectionEnd {
  /** 일반 화면: 새 출력으로 밀려도 같은 줄을 가리키는 표식. 대체 화면은 표식을 만들 수 없고 지난 줄이 없어 줄이 밀리지 않으므로 없다 */
  marker?: IMarker;
  /** 표식이 없을 때의 절대 줄 */
  line: number;
  col: number;
}

const lineOf = (end: SelectionEnd): number => (end.marker ? end.marker.line : end.line);

interface Selection {
  anchor: SelectionEnd;
  end: SelectionEnd;
  /** 단어 고르기: 한 칸짜리 단어도 고른 것이다 */
  word: boolean;
}

/** 고른 범위: 앞에서 뒤 순서, 끝 칸 포함 */
interface SelectionSpan {
  from: { line: number; col: number };
  to: { line: number; col: number };
}

/** 단어를 자르는 글자. 공백과 흔한 구분자다. 경로(/ . - _ ~)와 :(파일:줄, 주소)는 단어 안에 둔다 */
const WORD_BREAK = /[\s"'`()[\]{}<>,;|=!*]/u;

export class PaneTerminal {
  readonly #term: HeadlessTerminal;
  #cursorHidden = false;
  #sgrMouse = false;
  #copy: CopyView | undefined;
  #selection: Selection | undefined;
  readonly #truecolor: boolean;

  constructor(cols: number, rows: number, options: { truecolor?: boolean } = {}) {
    this.#truecolor = options.truecolor !== false;
    this.#term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.#term.loadAddon(new Unicode11Addon());
    this.#term.unicode.activeVersion = '11';
    // 커서 숨김(DECTCEM)은 공개 모드에 없어 직접 따라간다. false를 돌려 xterm 기본 처리도 그대로 하게 한다
    const cursorMode = (hidden: boolean) => (params: (number | number[])[]) => {
      if (params.includes(25)) this.#cursorHidden = hidden;
      // 마우스의 SGR 꼴도 공개 모드에 없어 같이 따라간다
      if (params.includes(1006)) this.#sgrMouse = !hidden;
      return false;
    };
    // 일반 화면과 대체 화면은 줄이 따로라 고른 범위는 화면이 바뀌면 푼다
    this.#term.buffer.onBufferChange(() => this.clearSelection());
    this.#term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, cursorMode(false));
    this.#term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, cursorMode(true));
    this.#term.parser.registerEscHandler({ final: 'c' }, () => {
      this.#cursorHidden = false;
      this.#sgrMouse = false;
      return false;
    });
  }

  get cols(): number {
    return this.#term.cols;
  }

  get rows(): number {
    return this.#term.rows;
  }

  /** 출력을 넣는다. 해석이 끝나면 풀린다 */
  write(data: string | Uint8Array): Promise<void> {
    return new Promise((resolve) => this.#term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols !== this.#term.cols || rows !== this.#term.rows) this.#term.resize(cols, rows);
  }

  /**
   * 처음부터 다시 받을 때(통로를 다시 열면 스튜디오가 최근 출력을 다시 보낸다) 앞 내용을 지운다.
   * 바로 지우면 아직 해석하지 않고 쌓여 있던 옛 출력이 지운 뒤에 그려진다. 그래서 초기화도 쓰기 줄에 넣는다
   */
  restart(): void {
    this.#term.write(FULL_RESET);
  }

  modes(): PaneModes {
    const modes = this.#term.modes;
    return {
      bracketedPaste: modes.bracketedPasteMode,
      appCursor: modes.applicationCursorKeysMode,
      cursorHidden: this.#cursorHidden,
      mouse: modes.mouseTrackingMode !== 'none',
      mouseMotion: modes.mouseTrackingMode === 'drag' || modes.mouseTrackingMode === 'any',
      sgrMouse: this.#sgrMouse,
    };
  }

  /** 칸 안 CLI가 벨(BEL)을 울렸다(#864) */
  onBell(listener: () => void): void {
    this.#term.onBell(listener);
  }

  /** 프로그램의 질의(커서 위치·장치 속성)에 터미널이 내는 응답. 실제 터미널처럼 CLI에 돌려줘야 한다 */
  onResponse(listener: (data: string) => void): void {
    this.#term.onData(listener);
  }

  /** 지금 보이는 화면의 줄. 줄마다 정확히 cols칸(복사 모드면 들어갈 때의 폭)이고 색은 SGR로, 줄 끝에서 되돌린다 */
  lines(): string[] {
    if (this.#copy) return this.#copyLines(this.#copy);
    const buffer = this.#term.buffer.active;
    const out: string[] = [];
    const selection = this.#selectionSpan();
    for (let y = 0; y < this.#term.rows; y++) {
      const absolute = buffer.viewportY + y;
      out.push(this.#styled(buffer.getLine(absolute), selection ? this.#selectedCols(selection, absolute) : undefined));
    }
    return out;
  }

  /** lines()의 폭. 복사 모드면 들어갈 때 떠 둔 폭이다 */
  get viewCols(): number {
    return this.#copy?.cols ?? this.#term.cols;
  }

  /** selected: 이 줄에서 고른 칸 범위(양 끝 포함) */
  #styled(line: IBufferLine | undefined, selected?: { from: number; to: number }): string {
    const nullCell = this.#term.buffer.active.getNullCell();
    let text = '';
    let used = 0;
    let current: CellStyle = { fg: '', bg: '', flags: '' };
    if (line) {
      for (let x = 0; x < this.#term.cols; x++) {
        const cell = line.getCell(x, nullCell);
        if (!cell) break;
        const width = cell.getWidth();
        // 두 칸 글자의 뒷칸은 앞칸이 이미 그렸다
        if (width === 0) continue;
        if (used + width > this.#term.cols) break;
        const style = styleOf(cell, this.#truecolor, selected !== undefined && x >= selected.from && x <= selected.to);
        if (!sameStyle(style, current)) {
          text += sgr(style);
          current = style;
        }
        text += cell.getChars() || ' ';
        used += width;
      }
    }
    if (current.fg || current.bg || current.flags) text += RESET;
    return `${text}${' '.repeat(Math.max(0, this.#term.cols - used))}${RESET}`;
  }

  get inCopy(): boolean {
    return this.#copy !== undefined;
  }

  /** 복사 모드에 들어간다: 지난 줄과 화면을 떠 두고, 지금 커서 줄에서 시작한다 */
  enterCopy(): void {
    this.clearSelection();
    const buffer = this.#term.buffer.active;
    const styled: string[] = [];
    const plain: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      styled.push(this.#styled(line));
      plain.push(line?.translateToString(true) ?? '');
    }
    const cursor = Math.min(plain.length - 1, buffer.baseY + buffer.cursorY);
    this.#copy = { styled, plain, cols: this.#term.cols, top: buffer.viewportY, cursor };
    this.#follow();
  }

  exitCopy(): void {
    this.#copy = undefined;
  }

  copyMove(by: number): void {
    if (!this.#copy) return;
    this.#copy.cursor = Math.max(0, Math.min(this.#copy.plain.length - 1, this.#copy.cursor + by));
    this.#follow();
  }

  copyPage(direction: 1 | -1): void {
    this.copyMove(direction * Math.max(1, this.#term.rows - 1));
  }

  copyTop(): void {
    this.copyMove(-Infinity);
  }

  copyBottom(): void {
    this.copyMove(Infinity);
  }

  /** 고르기 시작 자리를 지금 줄로 둔다. 이미 있으면 고르기를 푼다 */
  copyMark(): void {
    if (!this.#copy) return;
    this.#copy.anchor = this.#copy.anchor === undefined ? this.#copy.cursor : undefined;
  }

  /** 고른 줄(시작 자리부터 지금 줄까지, 없으면 지금 줄)의 글. 줄 끝의 빈칸은 뺀다 */
  copyYank(): string {
    if (!this.#copy) return '';
    const { anchor, cursor, plain } = this.#copy;
    const from = Math.min(anchor ?? cursor, cursor);
    const to = Math.max(anchor ?? cursor, cursor);
    return plain
      .slice(from, to + 1)
      .map((line) => line.trimEnd())
      .join('\n');
  }

  /** 지금 줄보다 위에서 글을 찾아(대소문자 무시) 그 줄로 간다. query를 주지 않으면 앞서 찾은 글을 더 위에서 찾는다 */
  copySearch(query?: string): boolean {
    if (!this.#copy) return false;
    const text = (query ?? this.#copy.query ?? '').toLowerCase();
    if (query !== undefined) this.#copy.query = query;
    if (!text) return false;
    for (let y = this.#copy.cursor - 1; y >= 0; y--) {
      if (this.#copy.plain[y]!.toLowerCase().includes(text)) {
        this.#copy.cursor = y;
        this.#follow();
        return true;
      }
    }
    return false;
  }

  /** 지금 줄(1부터)과 떠 둔 줄 수 */
  copyStatus(): { line: number; total: number } {
    return { line: (this.#copy?.cursor ?? 0) + 1, total: this.#copy?.plain.length ?? 0 };
  }

  /** 지금 줄이 보이게 보는 자리를 옮긴다 */
  #follow(): void {
    const copy = this.#copy!;
    const rows = this.#term.rows;
    if (copy.cursor < copy.top) copy.top = copy.cursor;
    if (copy.cursor >= copy.top + rows) copy.top = copy.cursor - rows + 1;
    copy.top = Math.max(0, Math.min(copy.top, copy.plain.length - rows));
  }

  #copyLines(copy: CopyView): string[] {
    const from = Math.min(copy.anchor ?? copy.cursor, copy.cursor);
    const to = Math.max(copy.anchor ?? copy.cursor, copy.cursor);
    const out: string[] = [];
    for (let y = copy.top; y < copy.top + this.#term.rows; y++) {
      if (y >= copy.plain.length) {
        out.push(' '.repeat(copy.cols));
        continue;
      }
      // 고른 줄(고르기 전에는 지금 줄)은 반전으로 그린다. 색을 빼야 반전이 줄 끝까지 이어진다
      if (y >= from && y <= to) {
        const plain = copy.plain[y]!;
        out.push(`${INVERSE}${plain}${' '.repeat(Math.max(0, copy.cols - stringWidth(plain)))}${RESET}`);
      } else out.push(copy.styled[y]!);
    }
    return out;
  }

  // ---- 마우스로 고르기(copyOnSelect). 좌표는 화면 안의 칸(0부터)이고 줄은 지금 보이는 화면 기준이다. 안쪽 저장은 절대 줄이다 ----

  get hasSelection(): boolean {
    return this.#selectionSpan() !== undefined;
  }

  /** 고르기를 시작한다. 같은 칸에서 끝나면 고른 것이 없다 */
  selectBegin(x: number, y: number): void {
    this.clearSelection();
    const at = this.#selectionEnd(x, y);
    this.#selection = { anchor: at, end: this.#selectionEnd(x, y), word: false };
  }

  /** 고르기의 끝을 옮긴다. 화면 밖 좌표는 화면 안으로 맞춘다 */
  selectTo(x: number, y: number): void {
    const selection = this.#selection;
    if (!selection) return;
    selection.end.marker?.dispose();
    selection.end = this.#selectionEnd(x, y);
  }

  /** 누른 자리의 단어를 고른다. 공백이나 구분자를 눌렀으면 고르지 않고 false */
  selectWord(x: number, y: number): boolean {
    this.clearSelection();
    const buffer = this.#term.buffer.active;
    const absolute = buffer.viewportY + Math.max(0, Math.min(this.#term.rows - 1, y));
    const line = buffer.getLine(absolute);
    if (!line) return false;
    const cols = this.#term.cols;
    const nullCell = buffer.getNullCell();
    const isWord = (col: number): boolean => {
      const cell = line.getCell(col, nullCell);
      if (!cell) return false;
      // 두 칸 글자의 뒷칸은 앞칸과 같은 글자로 본다
      if (cell.getWidth() === 0) return col > 0 && isWord(col - 1);
      const chars = cell.getChars();
      return chars !== '' && !WORD_BREAK.test(chars);
    };
    let col = Math.max(0, Math.min(cols - 1, x));
    if (!isWord(col)) return false;
    let from = col;
    while (from > 0 && isWord(from - 1)) from--;
    let to = col;
    while (to < cols - 1 && isWord(to + 1)) to++;
    const first = this.#selectionEnd(from, y);
    const last = this.#selectionEnd(to, y);
    this.#selection = { anchor: first, end: last, word: true };
    return true;
  }

  clearSelection(): void {
    if (!this.#selection) return;
    this.#selection.anchor.marker?.dispose();
    this.#selection.end.marker?.dispose();
    this.#selection = undefined;
  }

  /**
   * 고른 글. 두 칸 글자는 한 번만, 줄바꿈으로 이어진 줄은 줄바꿈 없이 잇고, 줄 끝의 빈칸은 뺀다.
   * 고른 줄이 지난 줄 상한(SCROLLBACK)을 넘어 밀려났으면 고른 것이 없다
   */
  selectedText(): string {
    const span = this.#selectionSpan();
    if (!span) return '';
    const buffer = this.#term.buffer.active;
    const nullCell = buffer.getNullCell();
    let out = '';
    for (let absolute = span.from.line; absolute <= span.to.line; absolute++) {
      const line = buffer.getLine(absolute);
      const range = this.#selectedCols(span, absolute)!;
      let text = '';
      if (line) {
        for (let col = range.from; col <= range.to; col++) {
          const cell = line.getCell(col, nullCell);
          if (!cell || cell.getWidth() === 0) continue;
          text += cell.getChars() || ' ';
        }
      }
      const last = absolute === span.to.line;
      if (!last && buffer.getLine(absolute + 1)?.isWrapped) out += text;
      else out += last ? text.trimEnd() : `${text.trimEnd()}\n`;
    }
    return out;
  }

  /** 화면 안 칸을 고르기의 한쪽 끝으로 바꾼다: 절대 줄의 표식과 칸. 두 칸 글자의 뒷칸은 앞칸으로 맞춘다 */
  #selectionEnd(x: number, y: number): SelectionEnd {
    const buffer = this.#term.buffer.active;
    const row = Math.max(0, Math.min(this.#term.rows - 1, y));
    const absolute = buffer.viewportY + row;
    let col = Math.max(0, Math.min(this.#term.cols - 1, x));
    if (col > 0 && buffer.getLine(absolute)?.getCell(col)?.getWidth() === 0) col--;
    // 표식은 커서 줄에서의 거리로 건다. 대체 화면이면 xterm이 표식을 만들지 않는다(undefined): 그때는 줄 번호를 그대로 든다
    // (대체 화면은 지난 줄이 없어 밀리지 않고, 화면이 바뀌면 onBufferChange가 고른 것을 푼다). 마우스 처리 안에서 던지면 desk가 죽는다
    const marker = buffer.type === 'normal' ? this.#term.registerMarker(absolute - (buffer.baseY + buffer.cursorY)) : undefined;
    return marker ? { marker, line: absolute, col } : { line: absolute, col };
  }

  /** 고른 범위를 앞에서 뒤 순서로. 표식이 밀려나 없어졌거나 한 칸도 고르지 않았으면 undefined */
  #selectionSpan(): SelectionSpan | undefined {
    const selection = this.#selection;
    if (!selection) return undefined;
    const a = { line: lineOf(selection.anchor), col: selection.anchor.col };
    const b = { line: lineOf(selection.end), col: selection.end.col };
    if (a.line < 0 || b.line < 0) return undefined;
    if (!selection.word && a.line === b.line && a.col === b.col) return undefined;
    const forward = a.line < b.line || (a.line === b.line && a.col <= b.col);
    return forward ? { from: a, to: b } : { from: b, to: a };
  }

  /** 절대 줄 하나에서 고른 칸 범위(양 끝 포함). 고른 줄이 아니면 undefined */
  #selectedCols(span: SelectionSpan, absolute: number): { from: number; to: number } | undefined {
    if (absolute < span.from.line || absolute > span.to.line) return undefined;
    return { from: absolute === span.from.line ? span.from.col : 0, to: absolute === span.to.line ? span.to.col : this.#term.cols - 1 };
  }

  /** 화면 안의 커서 자리(0부터). 복사 모드에서는 쓰지 않는다 */
  cursor(): { x: number; y: number } {
    const buffer = this.#term.buffer.active;
    return { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY - buffer.viewportY };
  }

  dispose(): void {
    this.clearSelection();
    this.#term.dispose();
  }
}
