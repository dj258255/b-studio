import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TERMINAL_FONT_FAMILY, TERMINAL_HANGUL_FONT, TERMINAL_LINE_HEIGHT } from './terminal';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

describe('세션 터미널의 한글 글꼴(#865)', () => {
  it('한글 고정폭 글꼴이 없을 때 쓰는 한글 대체 글꼴이 monospace 앞, 깔린 한글 고정폭 글꼴 뒤에 있다', () => {
    const fonts = TERMINAL_FONT_FAMILY.split(',').map((font) => font.trim().replace(/"/g, ''));
    expect(fonts[0]).toBe('ui-monospace');
    expect(fonts.at(-1)).toBe('monospace');
    expect(fonts.at(-2)).toBe(TERMINAL_HANGUL_FONT);
    expect(fonts.indexOf('D2Coding')).toBeLessThan(fonts.indexOf(TERMINAL_HANGUL_FONT));
  });

  it('한글 대체 글꼴은 한글 범위에만 걸리고, 2칸에 가깝게 키운다(글자 사이가 반 칸씩 벌어지지 않는다)', () => {
    const face = css.match(new RegExp(`@font-face\\s*{[^}]*font-family:\\s*"${TERMINAL_HANGUL_FONT}"[^}]*}`))?.[0];
    expect(face).toBeDefined();
    expect(face).toMatch(/unicode-range:[^;]*U\+AC00-D7A3/);
    expect(face).toMatch(/unicode-range:[^;]*U\+3130-318F/);
    expect(face).toMatch(/src:[^;]*local\("Apple SD Gothic Neo"\)/);
    expect(face).toMatch(/src:[^;]*local\("Malgun Gothic"\)/);
    expect(face).toMatch(/size-adjust:\s*118%/);
  });

  it('키운 한글이 윗줄에 닿지 않게 줄 높이를 조금 둔다', () => {
    expect(TERMINAL_LINE_HEIGHT).toBe(1.1);
  });
});
