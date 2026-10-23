import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TERMINAL_FONT, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT } from './terminal';

const appDir = new URL('../app/', import.meta.url);
const css = readFileSync(new URL('globals.css', appDir), 'utf8');
const face = css.match(new RegExp(`@font-face\\s*{[^}]*font-family:\\s*"${TERMINAL_FONT}"[^}]*}`))?.[0];

describe('세션 터미널 글꼴(#865, #867)', () => {
  it('묶은 터미널 글꼴이 맨 앞이다: 영문과 한글을 한 글꼴로 그려 한글이 영문 2칸에 꼭 맞는다', () => {
    const fonts = TERMINAL_FONT_FAMILY.split(',').map((font) => font.trim().replace(/"/g, ''));
    expect(fonts[0]).toBe(TERMINAL_FONT);
    expect(fonts.at(-1)).toBe('monospace');
  });

  it('글꼴 파일을 앱과 함께 묶는다(woff2, 1MB 미만, 라이선스 원문을 옆에 둔다)', () => {
    expect(face).toBeDefined();
    const src = face?.match(/src:\s*url\("\.\/([^"]+)"\)\s*format\("woff2"\)/)?.[1];
    expect(src).toBeDefined();
    const file = new URL(src!, appDir);
    expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(statSync(file).size).toBeLessThan(1024 * 1024);
    expect(existsSync(new URL('OFL.txt', file))).toBe(true);
  });

  it('시스템 한글 글꼴을 키워 맞추던 대체 글꼴은 남기지 않는다', () => {
    expect(css).not.toContain('b-studio-hangul');
    expect(TERMINAL_FONT_FAMILY).not.toContain('b-studio-hangul');
  });

  it('한글을 키우지 않으므로 줄 높이는 xterm 기본값이다', () => {
    expect(TERMINAL_LINE_HEIGHT).toBe(1);
  });

  it('묶은 글꼴의 영문이 작아 15px로 그린다(칸 폭 7.5px, 전의 13px 영문 글꼴 7.8px와 비슷하다)', () => {
    expect(TERMINAL_FONT_SIZE).toBe(15);
  });
});
