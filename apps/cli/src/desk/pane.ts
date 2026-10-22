/**
 * desk 칸 하나의 터미널 해석. 스튜디오가 흘려 주는 CLI 출력(화면 제어 문자 포함)을 `@xterm/headless`로 해석해 두고,
 * 그릴 때 화면 줄(색은 SGR로)과 커서 자리를 꺼낸다. 브라우저의 터미널 격자(ADR-177)가 xterm으로 하는 일을 CLI 안에서 한다
 */
import { createRequire } from 'node:module';
import type { IBufferCell, Terminal as HeadlessTerminal } from '@xterm/headless';

// 패키지가 CommonJS 진입점만 실제로 싣고 있어(module 필드의 파일이 없다) require로 읽는다
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');

const RESET = '\x1b[0m';
/** 칸 하나가 기억하는 지난 줄 수. 화면만 그리므로 크게 둘 까닭이 없다 */
const SCROLLBACK = 200;

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

export class PaneTerminal {
  readonly #term: HeadlessTerminal;

  constructor(cols: number, rows: number) {
    this.#term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
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

  /** 처음부터 다시 받을 때(통로를 다시 열면 스튜디오가 최근 출력을 다시 보낸다) 앞 내용을 지운다 */
  reset(): void {
    this.#term.reset();
  }

  /** 프로그램의 질의(커서 위치·장치 속성)에 터미널이 내는 응답. 실제 터미널처럼 CLI에 돌려줘야 한다 */
  onResponse(listener: (data: string) => void): void {
    this.#term.onData(listener);
  }

  /** 지금 보이는 화면의 줄. 줄마다 정확히 cols칸이고 색은 SGR로, 줄 끝에서 되돌린다 */
  lines(): string[] {
    const buffer = this.#term.buffer.active;
    const nullCell = buffer.getNullCell();
    const out: string[] = [];
    for (let y = 0; y < this.#term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
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
      out.push(`${text}${' '.repeat(Math.max(0, this.#term.cols - used))}${RESET}`);
    }
    return out;
  }

  /** 화면 안의 커서 자리(0부터) */
  cursor(): { x: number; y: number } {
    const buffer = this.#term.buffer.active;
    return { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY - buffer.viewportY };
  }

  dispose(): void {
    this.#term.dispose();
  }
}
