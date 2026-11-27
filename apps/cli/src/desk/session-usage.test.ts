import { describe, expect, it } from 'vitest';
import { cardLines, usageLine } from './cards';
import { openInside, renderInside } from './inside';
import { initialState } from './keys';
import { stringWidth, stripAnsi } from './screen';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME, fg } from './theme';
import type { DeskItem } from './types';

// 세션 사용량 한 줄(상태 줄 입력에서 온 5시간·주간 한도, 캐시 적중률, 비용, 시간, effort). 표시만 한다
const NOW = Date.parse('2026-11-27T12:00:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const item = (patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id: 's1', title: '주문 모듈', projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: at(-1), ...patch });
const FULL = {
  fiveHour: { usedPct: 23.5, resetsAt: at(110) },
  sevenDay: { usedPct: 41.2, resetsAt: at(23 * 60) },
  cacheHitRatio: 0.876,
  costUsd: 1.2345,
  durationMs: 42 * 60_000,
  effort: 'high',
};
const line = (target: DeskItem, width: number, options: { withCost?: boolean } = {}) => stripAnsi(usageLine(target, width, DEFAULT_THEME, NOW, options)).trimEnd();

describe('사용량 한 줄: 넓은 폭', () => {
  it('5시간·주간 한도(초기화까지), 캐시, 비용, 시간, effort를 차례로 보인다', () => {
    expect(line(item({ usage: FULL }), 120)).toBe('5시간 24% (1시간 50분 뒤) · 주간 41% (23시간 0분 뒤) · 캐시 88% · $1.23 · 세션 42분 · 추론 강도 high');
  });

  it('없는 값은 빈칸이 아니라 생략한다: 한도가 없으면 캐시부터 시작한다', () => {
    expect(line(item({ usage: { cacheHitRatio: 0.5, effort: 'low' } }), 80)).toBe('캐시 50% · 추론 강도 low');
  });

  it('usage가 없고 토큰도 없으면 빈 줄이다(0%를 지어내지 않는다)', () => {
    expect(line(item(), 80)).toBe('');
    expect(line(item({ usage: {} }), 80)).toBe('');
  });
});

describe('사용량 한 줄: 캐시 적중률의 출처', () => {
  const tokens = (read: number, write: number, input: number) => ({ inputTokens: input, outputTokens: 99, cacheReadTokens: read, cacheWriteTokens: write });
  it('상태 줄의 값이 없으면 세션 토큰의 cache read / (입력 + cache read + cache write)로 계산한다', () => {
    expect(line(item({ tokens: tokens(800, 100, 100) }), 80)).toBe('캐시 80%');
  });
  it('분모가 0이면 표시하지 않는다', () => {
    expect(line(item({ tokens: tokens(0, 0, 0) }), 80)).toBe('');
  });
  it('상태 줄의 값이 있으면 그것을 우선한다', () => {
    expect(line(item({ usage: { cacheHitRatio: 0.1 }, tokens: tokens(800, 100, 100) }), 80)).toBe('캐시 10%');
  });
});

describe('사용량 한 줄: 좁은 폭에서 자르는 순서', () => {
  const widths = (w: number) => line(item({ usage: FULL }), w);
  it('먼저 주간의 초기화 시각, 다음 5시간의 초기화 시각을 뺀다', () => {
    expect(widths(100)).toBe('5시간 24% (1시간 50분 뒤) · 주간 41% (23시간 0분 뒤) · 캐시 88% · $1.23 · 세션 42분 · 추론 강도 high');
    expect(widths(99)).toBe('5시간 24% (1시간 50분 뒤) · 주간 41% · 캐시 88% · $1.23 · 세션 42분 · 추론 강도 high');
    expect(widths(83)).toBe('5시간 24% · 주간 41% · 캐시 88% · $1.23 · 세션 42분 · 추론 강도 high');
  });
  it('그다음 뒤에서부터 통째로 뺀다: effort, 시간, 비용, 캐시, 주간 순(5시간이 마지막까지 남는다)', () => {
    expect(widths(67)).toBe('5시간 24% · 주간 41% · 캐시 88% · $1.23 · 세션 42분');
    expect(widths(50)).toBe('5시간 24% · 주간 41% · 캐시 88% · $1.23');
    expect(widths(38)).toBe('5시간 24% · 주간 41% · 캐시 88%');
    expect(widths(30)).toBe('5시간 24% · 주간 41%');
    expect(widths(19)).toBe('5시간 24%');
    expect(widths(9)).toBe('5시간 24%');
  });
  it('어느 폭에서도 폭을 넘지 않는다', () => {
    for (let w = 1; w <= 130; w++) {
      const raw = usageLine(item({ usage: FULL }), w, DEFAULT_THEME, NOW);
      expect(stringWidth(stripAnsi(raw)), `width ${w}`).toBeLessThanOrEqual(w);
    }
  });
});

describe('사용량 한 줄: 색과 비용 중복', () => {
  it('한도 %가 80을 넘으면 노랑, 95를 넘으면 빨강으로 칠한다. 글은 그대로다', () => {
    const calm = usageLine(item({ usage: { fiveHour: { usedPct: 79, resetsAt: at(60) } } }), 80, DEFAULT_THEME, NOW);
    const warn = usageLine(item({ usage: { fiveHour: { usedPct: 80, resetsAt: at(60) } } }), 80, DEFAULT_THEME, NOW);
    const hot = usageLine(item({ usage: { fiveHour: { usedPct: 95, resetsAt: at(60) } } }), 80, DEFAULT_THEME, NOW);
    expect(calm).not.toContain(fg(DEFAULT_THEME, 'yellow'));
    expect(warn).toContain(fg(DEFAULT_THEME, 'yellow'));
    expect(hot).toContain(fg(DEFAULT_THEME, 'red'));
    expect(stripAnsi(hot).trimEnd()).toBe('5시간 95% (1시간 0분 뒤)');
  });
  it('이미 세션 비용이 있는 자리에서는 비용을 다시 적지 않는다(withCost: false)', () => {
    expect(line(item({ usage: { costUsd: 2, effort: 'max' } }), 80, { withCost: false })).toBe('추론 강도 max');
  });
});

describe('사용량 한 줄이 놓이는 곳', () => {
  it('고른 카드의 펼침에 보이고, 고르지 않은 카드에는 없다', () => {
    const target = item({ usage: FULL, costUsd: 3.5 });
    const draw = (selected: boolean) => cardLines({ item: target, selected, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 100, DEFAULT_THEME, NOW).map(stripAnsi);
    expect(draw(true).some((row) => row.includes('캐시 88%'))).toBe(true);
    expect(draw(false).some((row) => row.includes('캐시 88%'))).toBe(false);
    // 카드의 비용($3.50)과 상태 줄의 비용($1.23)을 함께 적지 않는다
    expect(draw(true).join('\n')).not.toContain('$1.23');
  });

  it('에이전트 안(깊이 1)의 머리 아래에 보인다', () => {
    const target = item({ usage: FULL });
    const lines = renderInside({ ...initialState(), items: [target], inside: { ...openInside('s1', '주문 모듈'), loading: false } }, { w: 100, h: 20 }, NOW).lines.map(stripAnsi);
    expect(lines[0]).toContain('에이전트 안');
    expect(lines[1]).toContain('5시간 24%');
    expect(lines[1]).toContain('추론 강도 high');
  });

  it('사용량이 없으면 에이전트 안에 줄을 더하지 않는다', () => {
    const target = item();
    const lines = renderInside({ ...initialState(), items: [target], inside: { ...openInside('s1', '주문 모듈'), loading: false } }, { w: 100, h: 20 }, NOW).lines.map(stripAnsi);
    expect(lines.some((row) => row.includes('캐시') || row.includes('5시간'))).toBe(false);
  });
});
