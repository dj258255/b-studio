/**
 * desk 칸 하나의 터미널 해석. 스튜디오가 흘려 주는 CLI 출력(화면 제어 문자 포함)을 `@xterm/headless`로 해석해 두고,
 * 그릴 때 화면 줄(색은 SGR로)과 커서 자리를 꺼낸다. 브라우저의 터미널 격자(ADR-177)가 xterm으로 하는 일을 CLI 안에서 한다
 */
import { createRequire } from 'node:module';
import type { Unicode11Addon as Unicode11AddonType } from '@xterm/addon-unicode11';
import type { IBufferCell, IBufferLine, Terminal as HeadlessTerminal } from '@xterm/headless';
import { stringWidth } from './screen';

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

function colorCode(cell: IBufferCell, ground: 'fg' | 'bg'): string {
  const base = ground === 'fg' ? 30 : 40;
  if (ground === 'fg' ? cell.isFgDefault() : cell.isBgDefault()) return '';
  const color = ground === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (ground === 'fg' ? cell.isFgRGB() : cell.isBgRGB()) return `${base + 8};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`;
  if (color < 8) return String(base + color);
  if (color < 16) return String(base + 60 + color - 8);
  return `${base + 8};5;${color}`;
}

function styleOf(cell: IBufferCell): CellStyle {
  const flags = [cell.isBold() ? '1' : '', cell.isDim() ? '2' : '', cell.isItalic() ? '3' : '', cell.isUnderline() ? '4' : '', cell.isInverse() ? '7' : '', cell.isInvisible() ? '8' : '', cell.isStrikethrough() ? '9' : '']
    .filter(Boolean)
    .join(';');
  return { fg: colorCode(cell, 'fg'), bg: colorCode(cell, 'bg'), flags };
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

export class PaneTerminal {
  readonly #term: HeadlessTerminal;
  #cursorHidden = false;
  #copy: CopyView | undefined;

  constructor(cols: number, rows: number) {
    this.#term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.#term.loadAddon(new Unicode11Addon());
    this.#term.unicode.activeVersion = '11';
    // 커서 숨김(DECTCEM)은 공개 모드에 없어 직접 따라간다. false를 돌려 xterm 기본 처리도 그대로 하게 한다
    const cursorMode = (hidden: boolean) => (params: (number | number[])[]) => {
      if (params.includes(25)) this.#cursorHidden = hidden;
      return false;
    };
    this.#term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, cursorMode(false));
    this.#term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, cursorMode(true));
    this.#term.parser.registerEscHandler({ final: 'c' }, () => {
      this.#cursorHidden = false;
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
    return { bracketedPaste: modes.bracketedPasteMode, appCursor: modes.applicationCursorKeysMode, cursorHidden: this.#cursorHidden };
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
    for (let y = 0; y < this.#term.rows; y++) out.push(this.#styled(buffer.getLine(buffer.viewportY + y)));
    return out;
  }

  /** lines()의 폭. 복사 모드면 들어갈 때 떠 둔 폭이다 */
  get viewCols(): number {
    return this.#copy?.cols ?? this.#term.cols;
  }

  #styled(line: IBufferLine | undefined): string {
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
        const style = styleOf(cell);
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

  /** 화면 안의 커서 자리(0부터). 복사 모드에서는 쓰지 않는다 */
  cursor(): { x: number; y: number } {
    const buffer = this.#term.buffer.active;
    return { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY - buffer.viewportY };
  }

  dispose(): void {
    this.#term.dispose();
  }
}
