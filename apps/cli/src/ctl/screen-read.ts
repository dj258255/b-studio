/**
 * 세션 터미널의 지금 화면을 글로 읽는다(studio read). 스튜디오는 구독하자마자 최근 출력(화면 제어 문자 포함)과 지금 상태를 주므로,
 * desk 칸과 같은 해석기(@xterm/headless)에 그 출력을 넣어 화면을 되살린다. 새 라우트를 더하지 않고 desk가 쓰는 터미널 통로를 그대로 읽는다 —
 * 그래서 검사도 그 통로와 같다(로그인·이 컴퓨터 주소·세션 접근 권한)
 */
import { PaneTerminal } from '../desk/pane';
import { stripAnsi } from '../desk/screen';
import type { StudioClient } from '../desk/client';
import type { DeskTerminalMessage } from '../desk/types';

/** 크기를 알려 주지 않는 옛 스튜디오에서 쓰는 크기(스튜디오가 처음 여는 크기와 같다) */
const FALLBACK_SIZE = { cols: 120, rows: 32 };

export interface ScreenRead {
  cols: number;
  rows: number;
  /** 터미널이 열려 있는가 */
  open: boolean;
  /** CLI가 떠 있는가(알렸을 때) */
  cli?: boolean;
  /** 터미널이 닫혔다고 알린 까닭(권한이 없거나 쓸 수 없는 서버) */
  closedReason?: string;
  /** 지난 줄과 지금 화면의 글(서식 없음). 끝의 빈 줄은 지웠다 */
  lines: string[];
  /** 그 가운데 지금 화면이 시작하는 줄 */
  viewportStart: number;
  /** 지금 화면의 줄(색 등 서식 제어 문자 포함). 끝의 빈 줄은 지웠다 */
  rawLines: string[];
  /** CLI가 붙여넣기 표지를 켰는가 */
  bracketedPaste: boolean;
}

function trimEndBlank<T>(lines: T[], text: (line: T) => string): T[] {
  let end = lines.length;
  while (end > 0 && text(lines[end - 1]!).trim() === '') end -= 1;
  return lines.slice(0, end);
}

export interface ReadOptions {
  /** 처음 상태(status·cli)를 받은 뒤 더 기다리는 시간. 그 사이 오는 출력까지 화면에 넣는다 */
  settleMs?: number;
  /** 아무것도 받지 못해도 끝내는 상한 */
  timeoutMs?: number;
}

/** 터미널 통로를 잠깐 열어 화면을 읽는다. 읽는 일뿐이라 입력·크기 변경은 하지 않는다 */
export async function readScreen(client: StudioClient, id: string, options: ReadOptions = {}): Promise<ScreenRead> {
  const settleMs = options.settleMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const chunks: Buffer[] = [];
  let size: { cols: number; rows: number } | undefined;
  let open = false;
  let cli: boolean | undefined;
  let closedReason: string | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const hard = setTimeout(() => controller.abort(), timeoutMs);

  const onMessage = (_id: string, message: DeskTerminalMessage): void => {
    switch (message.kind) {
      case 'data':
        chunks.push(Buffer.from(message.data, 'base64'));
        break;
      case 'status':
        open = message.state === 'open';
        if (message.size) size = message.size;
        if (message.state === 'closed' && message.message) closedReason = message.message;
        // 권한이 없거나 쓸 수 없는 서버면 status 하나만 오고 끝난다. 그때도 오래 기다리지 않는다
        settle ??= setTimeout(() => controller.abort(), settleMs);
        break;
      case 'cli':
        cli = message.alive;
        // 구독하자마자 오는 것 가운데 마지막이다. 그 뒤 잠깐만 더 받고 끝낸다
        settle ??= setTimeout(() => controller.abort(), settleMs);
        break;
      default:
        break;
    }
  };
  try {
    await client.stream([id], onMessage, controller.signal);
  } finally {
    clearTimeout(hard);
    if (settle) clearTimeout(settle);
  }

  const dimensions = size ?? FALLBACK_SIZE;
  const pane = new PaneTerminal(dimensions.cols, dimensions.rows, { truecolor: false });
  try {
    for (const chunk of chunks) await pane.write(chunk);
    const plain = pane.plainText();
    const trimmed = trimEndBlank(plain.lines, (line) => line);
    const viewport = pane.lines();
    const rawLines = trimEndBlank(viewport, (line) => stripAnsi(line));
    return {
      cols: dimensions.cols,
      rows: dimensions.rows,
      open,
      ...(cli === undefined ? {} : { cli }),
      ...(closedReason === undefined ? {} : { closedReason }),
      lines: trimmed,
      viewportStart: Math.min(plain.viewportStart, trimmed.length),
      rawLines,
      bracketedPaste: pane.modes().bracketedPaste,
    };
  } finally {
    pane.dispose();
  }
}

/** 보여 줄 줄. 기본은 지금 화면, lines를 주면 지난 줄까지 합친 마지막 N줄 */
export function pickLines(screen: ScreenRead, options: { lines?: number; raw?: boolean }): string[] {
  if (options.raw) {
    const rows = screen.rawLines;
    return options.lines === undefined ? rows : rows.slice(-options.lines);
  }
  if (options.lines === undefined) return screen.lines.slice(screen.viewportStart);
  return screen.lines.slice(-options.lines);
}
