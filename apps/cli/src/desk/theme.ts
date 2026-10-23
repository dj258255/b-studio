/**
 * desk의 색(#887). 이름 붙인 팔레트 둘(어두운 것·밝은 것)에서 색 토큰을 골라 SGR로 바꾼다.
 * 강조색은 하나(accent)만 쓰고, 상태는 점과 색으로만 보인다. 밖 터미널이 24비트 색을 알리지 않으면 256색 근사로 낮춘다(#874)
 */

export type ThemeName = 'dark' | 'light';
export type ColorDepth = 'truecolor' | '256';

export type ColorToken =
  /** 머리 줄·사이드바 바탕 */
  | 'chrome'
  /** 고른 줄·고른 카드의 바탕, 막대의 빈 칸 */
  | 'active'
  /** 테두리, 구분선 */
  | 'border'
  | 'text'
  | 'muted'
  | 'accent'
  | 'green'
  | 'yellow'
  | 'red'
  | 'teal'
  /** 배지 바탕 */
  | 'badge';

export interface Theme {
  name: ThemeName;
  depth: ColorDepth;
}

/** catppuccin(MIT) 계열의 색 값. 어두운 것은 mocha, 밝은 것은 latte에서 골랐다 */
const PALETTES: Record<ThemeName, Record<ColorToken, string>> = {
  dark: {
    chrome: '#181825',
    active: '#313244',
    border: '#45475a',
    text: '#cdd6f4',
    muted: '#7f849c',
    accent: '#89b4fa',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    red: '#f38ba8',
    teal: '#94e2d5',
    badge: '#45475a',
  },
  light: {
    chrome: '#e6e9ef',
    active: '#ccd0da',
    border: '#bcc0cc',
    text: '#4c4f69',
    muted: '#8c8fa1',
    accent: '#1e66f5',
    green: '#40a02b',
    yellow: '#df8e1d',
    red: '#d20f39',
    teal: '#179299',
    badge: '#bcc0cc',
  },
};

export const THEMES: readonly ThemeName[] = ['dark', 'light'];

export const DEFAULT_THEME: Theme = { name: 'dark', depth: 'truecolor' };

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';

/** 6단계 색 정육면체의 값(xterm 256색표) */
const CUBE = [0, 95, 135, 175, 215, 255];

/** 24비트 색에 가장 가까운 256색 번호: 색 정육면체(16~231)와 회색 띠(232~255) 가운데 거리가 짧은 쪽 */
export function rgbTo256(r: number, g: number, b: number): number {
  const nearest = (value: number) => CUBE.reduce((best, level, index) => (Math.abs(level - value) < Math.abs(CUBE[best]! - value) ? index : best), 0);
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDistance = (CUBE[ri]! - r) ** 2 + (CUBE[gi]! - g) ** 2 + (CUBE[bi]! - b) ** 2;
  const grayIndex = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const level = 8 + 10 * grayIndex;
  const grayDistance = (level - r) ** 2 + (level - g) ** 2 + (level - b) ** 2;
  return grayDistance < cubeDistance ? 232 + grayIndex : cube;
}

/** 색 값(r,g,b)을 글자색(38)이나 바탕색(48) SGR로 */
export function rgbSgr(rgb: readonly [number, number, number], ground: 'fg' | 'bg', depth: ColorDepth): string {
  const base = ground === 'fg' ? 38 : 48;
  const [r, g, b] = rgb;
  return depth === 'truecolor' ? `\x1b[${base};2;${r};${g};${b}m` : `\x1b[${base};5;${rgbTo256(r, g, b)}m`;
}

function hexRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function fg(theme: Theme, token: ColorToken): string {
  return rgbSgr(hexRgb(PALETTES[theme.name][token]), 'fg', theme.depth);
}

export function bg(theme: Theme, token: ColorToken): string {
  return rgbSgr(hexRgb(PALETTES[theme.name][token]), 'bg', theme.depth);
}
