/** desk 화면의 글자 폭과 칸 배치. 상태를 갖지 않는 순수 함수만 둔다 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PaneLayout = 1 | 2 | 4;

/** 사이드바 폭의 상한(칸). 화면 폭의 30%를 넘지 않는다 */
const SIDEBAR_MAX = 32;

/** 터미널에서 한 글자가 차지하는 칸 수(0·1·2). 결합 문자는 0, 한글·한자·전각·그림 문자는 2. 칸 해석기(유니코드 11 폭)와 어긋나지 않게 맞춘다 */
export function charWidth(code: number): number {
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  // 결합 문자, 풀어쓴(NFD) 한글의 가운뎃소리·끝소리(앞 첫소리와 한 칸에 모인다)
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x1160 && code <= 0x11ff) ||
    (code >= 0xd7b0 && code <= 0xd7ff) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** 색 제어 문자가 없는 글의 칸 수 */
export function stringWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0)!);
  return width;
}

/** 글을 정확히 width칸으로 맞춘다. 넘치면 끝을 말줄임표로 자르고, 모자라면 빈칸으로 채운다 */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const clean = text.replace(/[\r\n\t]/g, ' ');
  if (stringWidth(clean) <= width) return clean + ' '.repeat(width - stringWidth(clean));
  let out = '';
  let used = 0;
  for (const char of clean) {
    const w = charWidth(char.codePointAt(0)!);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  out += '…';
  used += 1;
  return out + ' '.repeat(Math.max(0, width - used));
}

/**
 * 화면(cols×rows)을 나눈다: 맨 위 한 줄은 머리, 맨 아래 한 줄은 안내, 그 사이 왼쪽은 사이드바, 구분선 한 칸, 오른쪽은 칸.
 * 칸은 1개, 좌우 2개, 2×2 4개다. 칸 사이에도 구분선 한 줄을 둔다. 칸마다 첫 줄은 칸 머리이고 나머지가 터미널이다
 */
export function computeLayout(cols: number, rows: number, layout: PaneLayout, options: { sidebar?: boolean } = {}): { sidebar: Rect; panes: Rect[] } {
  const top = 1;
  const height = Math.max(1, rows - 2);
  // 사이드바를 숨기면 구분선도 없이 칸이 왼쪽 끝부터 쓴다(#863)
  const showSidebar = options.sidebar !== false;
  const sidebarWidth = showSidebar ? Math.max(1, Math.min(SIDEBAR_MAX, Math.floor(cols * 0.3))) : 0;
  const x0 = showSidebar ? sidebarWidth + 1 : 0;
  const main = Math.max(1, cols - x0);
  const sidebar = { x: 0, y: top, w: sidebarWidth, h: height };
  if (layout === 1) return { sidebar, panes: [{ x: x0, y: top, w: main, h: height }] };
  const left = Math.max(1, Math.floor((main - 1) / 2));
  const right = Math.max(1, main - left - 1);
  const columns = [
    { x: x0, w: left },
    { x: x0 + left + 1, w: right },
  ];
  if (layout === 2) return { sidebar, panes: columns.map((column) => ({ ...column, y: top, h: height })) };
  const upper = Math.max(1, Math.floor((height - 1) / 2));
  const lower = Math.max(1, height - upper - 1);
  return {
    sidebar,
    panes: [
      ...columns.map((column) => ({ ...column, y: top, h: upper })),
      ...columns.map((column) => ({ ...column, y: top + upper + 1, h: lower })),
    ],
  };
}

/** 화면에 놓는 칸과 그 자리. 크게 보기(zoom)면 고른 칸 하나만 1칸 배치의 자리에 놓는다. 가려진 칸의 세션은 계속 돈다 */
export function placePanes(
  cols: number,
  rows: number,
  view: { layout: PaneLayout; focus: number; zoom?: boolean; sidebarHidden?: boolean },
): { sidebar: Rect; panes: Array<{ slot: number; rect: Rect }> } {
  const zoomed = view.zoom === true;
  const layout = computeLayout(cols, rows, zoomed ? 1 : view.layout, { sidebar: !view.sidebarHidden });
  if (zoomed) return { sidebar: layout.sidebar, panes: [{ slot: view.focus, rect: layout.panes[0]! }] };
  return { sidebar: layout.sidebar, panes: layout.panes.map((rect, slot) => ({ slot, rect })) };
}

/** 칸 안의 터미널 크기(머리 한 줄을 뺀다) */
export function terminalSize(rect: Rect): { cols: number; rows: number } {
  return { cols: Math.max(1, rect.w), rows: Math.max(1, rect.h - 1) };
}
