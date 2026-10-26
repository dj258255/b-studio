/**
 * desk의 작은 그림 조각(#887): 둥근 테두리 상자, 한 칸을 8단계로 나눈 막대, 배지, 상태 점.
 * 모두 색이 섞인 글을 돌려주고, 보이는 폭은 늘 받은 폭과 같다(색 제어 문자는 폭에 넣지 않는다)
 */
import { fit, fitAnsi, stringWidth } from './screen';
import type { StatusBadge, Tone } from './sidebar';
import { bg, BOLD, fg, RESET, type ColorToken, type Theme } from './theme';

/** 한 칸의 1/8부터 7/8까지 왼쪽에서 차는 블록 */
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export const TONE_COLOR: Record<Tone, ColorToken> = { warn: 'yellow', busy: 'accent', ok: 'green', fail: 'red', muted: 'muted' };
const TONE_MARK: Record<Tone, string> = { warn: '●', busy: '◐', ok: '●', fail: '×', muted: '○' };

/** 사용률의 색: 70% 아래는 강조색, 95% 아래는 노랑, 그 위는 빨강 */
export function usageColor(percent: number): ColorToken {
  if (percent >= 95) return 'red';
  if (percent >= 70) return 'yellow';
  return 'accent';
}

/** 문맥 창의 색: 50% 아래는 초록, 80% 아래는 노랑, 그 위는 빨강(압축이 가까움, #921) */
export function contextColor(percent: number): ColorToken {
  if (percent >= 80) return 'red';
  if (percent >= 50) return 'yellow';
  return 'green';
}

/** 사용률 막대. 빈 곳은 어두운 바탕으로 칠해 막대 길이가 보이고, 끝 칸은 1/8 단위로 찬다. 색은 color로 바꿀 수 있다 */
export function bar(percent: number, width: number, theme: Theme, color: (percent: number) => ColorToken = usageColor): string {
  if (width <= 0) return '';
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const eighths = Math.round((clamped / 100) * width * 8);
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  const empty = width - full - (rest ? 1 : 0);
  return `${fg(theme, color(clamped))}${bg(theme, 'active')}${'█'.repeat(full)}${PARTIAL[rest]}${' '.repeat(empty)}${RESET}`;
}

/** 글자에 바탕색을 칠한 작은 표(AI 이름 등). 폭은 글 폭 + 2 */
export function badge(text: string, theme: Theme): string {
  return `${bg(theme, 'badge')}${fg(theme, 'text')} ${text} ${RESET}`;
}

/** 상태를 점 하나와 색으로. 끝남은 ✓ */
export function statusMark(status: StatusBadge, theme: Theme): string {
  const mark = status.label === '끝남' ? '✓' : TONE_MARK[status.tone];
  return `${fg(theme, status.label === '끝남' ? 'teal' : statusColor(status))}${mark}${RESET}`;
}

/** 점과 상태 글. 폭은 글 폭 + 2 */
export function statusText(status: StatusBadge, theme: Theme): string {
  return `${statusMark(status, theme)} ${fg(theme, statusColor(status))}${status.label}${RESET}`;
}

/** 상태의 색: 종류 색이 있으면 그것, 아니면 급함의 색 */
export function statusColor(status: StatusBadge): ColorToken {
  return status.color ?? TONE_COLOR[status.tone];
}

/** 왼쪽 글과 오른쪽 글을 width칸 한 줄에 놓는다. 넘치면 왼쪽을 줄인다 */
export function spread(left: string, right: string, width: number, rightWidth: number): string {
  if (rightWidth + 1 >= width) return fitAnsi(left, width);
  return fitAnsi(left, width - rightWidth - 1) + ' ' + right;
}

/**
 * 둥근 테두리 상자. 제목은 위 테두리 선에 끼운다(`╭─ 제목 ───╮`). 안쪽 줄은 좌우 한 칸씩 띄우고 정확히 width-4칸으로 맞춘다.
 * focused면 테두리를 강조색으로, 아니면 테두리 색으로 그린다
 */
export function box(inner: readonly string[], width: number, theme: Theme, options: { title?: string; focused?: boolean } = {}): string[] {
  if (width < 4) return inner.map(() => ' '.repeat(Math.max(0, width)));
  const line = fg(theme, options.focused ? 'accent' : 'border');
  const span = width - 2;
  let top = '─'.repeat(span);
  if (options.title && span > 4) {
    const title = fit(options.title, Math.min(stringWidth(options.title), span - 4)).trimEnd();
    top = `─ ${RESET}${BOLD}${fg(theme, 'text')}${title}${RESET}${line} ${'─'.repeat(Math.max(0, span - 3 - stringWidth(title)))}`;
  }
  return [
    `${line}╭${top}╮${RESET}`,
    ...inner.map((row) => `${line}│${RESET} ${fitAnsi(row, width - 4)} ${line}│${RESET}`),
    `${line}╰${'─'.repeat(span)}╯${RESET}`,
  ];
}
