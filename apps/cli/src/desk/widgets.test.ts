import { describe, expect, it } from 'vitest';
import { stringWidth, stripAnsi } from './screen';
import { bg, DEFAULT_THEME, fg, rgbTo256 } from './theme';
import { badge, bar, box, spread, statusMark, statusText, usageColor } from './widgets';

const theme = DEFAULT_THEME;

describe('사용률 막대', () => {
  it('한 칸을 8단계로 나눠 채우고 빈 곳은 어두운 바탕으로 칠한다. 폭은 늘 받은 폭이다', () => {
    expect(stripAnsi(bar(0, 10, theme))).toBe(' '.repeat(10));
    expect(stripAnsi(bar(100, 10, theme))).toBe('█'.repeat(10));
    expect(stripAnsi(bar(50, 10, theme))).toBe(`${'█'.repeat(5)}${' '.repeat(5)}`);
    // 10칸의 37% = 29.6/8칸 → 3칸 + 6/8
    expect(stripAnsi(bar(37, 10, theme))).toBe(`███▊${' '.repeat(6)}`);
    expect(stripAnsi(bar(1, 10, theme))).toBe(`▏${' '.repeat(9)}`);
    for (const percent of [-5, 0, 12.5, 37, 99.9, 100, 140, Number.NaN]) expect(stringWidth(stripAnsi(bar(percent, 13, theme)))).toBe(13);
    expect(bar(10, 4, theme)).toContain(bg(theme, 'active'));
  });

  it('70% 아래는 강조색, 95% 아래는 노랑, 그 위는 빨강', () => {
    expect(usageColor(26)).toBe('accent');
    expect(usageColor(70)).toBe('yellow');
    expect(usageColor(94.9)).toBe('yellow');
    expect(usageColor(95)).toBe('red');
    expect(bar(90, 5, theme)).toContain(fg(theme, 'yellow'));
  });
});

describe('상자와 배지', () => {
  it('둥근 테두리 상자: 제목을 위 선에 끼우고, 모든 줄이 받은 폭이다', () => {
    const lines = box(['첫 줄', 'second'], 20, theme, { title: '주문' });
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toBe('╭─ 주문 ───────────╮');
    expect(plain[1]).toBe('│ 첫 줄            │');
    expect(plain[3]).toBe('╰──────────────────╯');
    for (const line of plain) expect(stringWidth(line)).toBe(20);
  });

  it('고른 상자는 테두리를 강조색으로 그린다', () => {
    expect(box([''], 10, theme, { focused: true })[0]).toContain(fg(theme, 'accent'));
    expect(box([''], 10, theme)[0]).toContain(fg(theme, 'border'));
  });

  it('긴 글은 상자 안에서 자르고, 긴 제목도 테두리를 넘지 않는다', () => {
    const plain = box(['아주 긴 글입니다 아주 긴 글입니다'], 14, theme, { title: '아주 긴 제목입니다' }).map(stripAnsi);
    for (const line of plain) expect(stringWidth(line)).toBe(14);
  });

  it('배지는 글 양옆에 한 칸씩 두고 바탕색을 칠한다', () => {
    expect(stripAnsi(badge('Claude', theme))).toBe(' Claude ');
    expect(badge('Claude', theme)).toContain(bg(theme, 'badge'));
  });

  it('상태 점: 손댈 것 ●, 작업 중 ◐, 오류 ×, 쉼 ○, 끝남 ✓', () => {
    expect(stripAnsi(statusMark({ label: '권한 대기', tone: 'warn' }, theme))).toBe('●');
    expect(stripAnsi(statusMark({ label: '작업 중', tone: 'busy' }, theme))).toBe('◐');
    expect(stripAnsi(statusMark({ label: '오류', tone: 'fail' }, theme))).toBe('×');
    expect(stripAnsi(statusMark({ label: '쉼', tone: 'muted' }, theme))).toBe('○');
    expect(stripAnsi(statusMark({ label: '끝남', tone: 'ok' }, theme))).toBe('✓');
    expect(stripAnsi(statusText({ label: '작업 중', tone: 'busy' }, theme))).toBe('◐ 작업 중');
  });

  it('양쪽 맞추기: 오른쪽 글을 끝에 붙이고 왼쪽을 줄인다', () => {
    expect(stripAnsi(spread('왼쪽', '오른', 12, 4))).toBe('왼쪽    오른');
    expect(stringWidth(stripAnsi(spread('아주 긴 왼쪽 글입니다', '오른', 12, 4)))).toBe(12);
  });
});

describe('색', () => {
  it('24비트 색을 가장 가까운 256색으로 낮춘다', () => {
    expect(rgbTo256(0, 0, 0)).toBe(16);
    expect(rgbTo256(255, 255, 255)).toBe(231);
    expect(rgbTo256(128, 128, 128)).toBe(244);
  });

  it('팔레트마다 같은 토큰이 다른 색이고, 256색이면 38;5 꼴이다', () => {
    expect(fg({ name: 'dark', depth: 'truecolor' }, 'accent')).not.toBe(fg({ name: 'light', depth: 'truecolor' }, 'accent'));
    expect(fg({ name: 'dark', depth: '256' }, 'accent')).toMatch(/^\x1b\[38;5;\d+m$/);
    expect(bg({ name: 'dark', depth: 'truecolor' }, 'chrome')).toBe('\x1b[48;2;24;24;37m');
  });
});
