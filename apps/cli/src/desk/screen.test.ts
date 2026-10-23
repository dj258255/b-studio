import { describe, expect, it } from 'vitest';
import { computeLayout, fit, fitAnsi, placePanes, stringWidth, stripAnsi } from './screen';

describe('글자 폭', () => {
  it('한글·전각은 두 칸, 영문은 한 칸으로 센다', () => {
    expect(stringWidth('abc')).toBe(3);
    expect(stringWidth('작업 중')).toBe(7);
    expect(stringWidth('ＡＢ')).toBe(4);
  });

  it('맞춤은 넘치면 말줄임표로 자르고 모자라면 빈칸으로 채워 정확히 그 폭이 된다', () => {
    expect(fit('abc', 5)).toBe('abc  ');
    expect(fit('abcdef', 4)).toBe('abc…');
    // 두 칸 글자를 반만 넣을 수는 없다: 자른 뒤 남는 한 칸은 빈칸으로 채운다
    expect(fit('가나다라', 5)).toBe('가나…');
    expect(fit('가나다라', 6)).toBe('가나… ');
    expect(stringWidth(fit('가나다라', 6))).toBe(6);
    expect(fit('', 0)).toBe('');
  });
});

describe('칸 배치', () => {
  it('1칸이면 사이드바 옆의 남은 자리를 모두 쓴다(머리 줄과 아래 줄은 뺀다)', () => {
    const layout = computeLayout(100, 30, 1);
    expect(layout.sidebar).toEqual({ x: 0, y: 1, w: 30, h: 28 });
    expect(layout.panes).toEqual([{ x: 31, y: 1, w: 69, h: 28 }]);
  });

  it('2칸은 좌우로, 4칸은 2×2로 나누고 사이에 구분선 한 줄을 둔다', () => {
    const two = computeLayout(100, 30, 2);
    expect(two.panes).toEqual([
      { x: 31, y: 1, w: 34, h: 28 },
      { x: 66, y: 1, w: 34, h: 28 },
    ]);
    const four = computeLayout(100, 30, 4);
    expect(four.panes).toEqual([
      { x: 31, y: 1, w: 34, h: 13 },
      { x: 66, y: 1, w: 34, h: 13 },
      { x: 31, y: 15, w: 34, h: 14 },
      { x: 66, y: 15, w: 34, h: 14 },
    ]);
  });

  it('좁은 화면에서도 칸의 폭과 높이가 1보다 작아지지 않는다(그릴 자리가 모자라면 칸이 겹치지 않게 줄인다)', () => {
    const layout = computeLayout(20, 6, 4);
    for (const pane of layout.panes) {
      expect(pane.w).toBeGreaterThanOrEqual(1);
      expect(pane.h).toBeGreaterThanOrEqual(1);
    }
  });

  it('풀어쓴 한글의 가운뎃소리·끝소리는 0칸, 1F680대 그림 문자는 2칸이다(#860)', () => {
    expect(stringWidth('한'.normalize('NFD'))).toBe(2);
    expect(stringWidth('🚀')).toBe(2);
    expect(stringWidth('🧪')).toBe(2);
  });
});

describe('칸 놓기(#863)', () => {
  it('사이드바를 숨기면 칸이 화면 왼쪽 끝부터 전체 폭을 쓴다', () => {
    const layout = computeLayout(100, 30, 1, { sidebar: false });
    expect(layout.sidebar.w).toBe(0);
    expect(layout.panes[0]).toEqual({ x: 0, y: 1, w: 100, h: 28 });
  });

  it('크게 보기면 고른 칸 하나만 1칸 배치의 자리에 놓는다', () => {
    const placed = placePanes(100, 30, { layout: 4, focus: 2, zoom: true });
    expect(placed.panes).toEqual([{ slot: 2, rect: computeLayout(100, 30, 1).panes[0] }]);
    const normal = placePanes(100, 30, { layout: 2, focus: 0 });
    expect(normal.panes.map((pane) => pane.slot)).toEqual([0, 1]);
  });
});

describe('누를 수 있는 링크(OSC 8, #890)', () => {
  it('링크 열은 폭에 넣지 않고 그대로 두며, 색을 지울 때 함께 지운다', () => {
    const link = '\x1b]8;;https://example.com/a?b=1\x07열기\x1b]8;;\x07';
    const out = fitAnsi(`> ${link} 끝`, 12);
    expect(out).toContain('\x1b]8;;https://example.com/a?b=1\x07');
    expect(stripAnsi(out)).toBe('> 열기 끝   ');
    expect(stringWidth(stripAnsi(out))).toBe(12);
  });

  it('링크 가운데서 잘리면 링크를 닫는다', () => {
    const out = fitAnsi('\x1b]8;;https://example.com\x07아주 긴 링크 글\x1b]8;;\x07', 6);
    expect(out.endsWith('\x1b]8;;\x07\x1b[0m') || out.includes('\x1b]8;;\x07\x1b[0m')).toBe(true);
    expect(stringWidth(stripAnsi(out))).toBe(6);
  });
});
