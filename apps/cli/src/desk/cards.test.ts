import { describe, expect, it } from 'vitest';
import { ART_WIDE, cardLines, resetText, spaceScreen, spriteFor } from './cards';
import { initialState, type DeskState } from './keys';
import { stringWidth, stripAnsi } from './screen';
import { KittyImages } from './kitty';
import { defaultSprite, spriteFromRows } from './sprite';
import { DEFAULT_THEME, fg } from './theme';
import type { DeskItem } from './types';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T11:57:00Z', ...patch });
const busy = item('a', {
  title: '주문 모듈',
  state: 'working',
  gate: { state: 'passed', checkpoints: 2 },
  tokens: usage(12_345),
  costUsd: 0.42,
  agents: [
    { id: 'main', name: '메인', kind: 'main', state: 'working', activity: 'Edit src/order.ts', tokens: usage(1) },
    { id: 'claude:Explore', name: 'Explore', kind: 'subagent', state: 'working', activity: '모델 요청 2회', tokens: usage(2_000) },
  ],
});

describe('카드 한 장', () => {
  const card = (patch: Partial<Parameters<typeof cardLines>[0]> = {}) =>
    cardLines({ item: busy, selected: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code'), ...patch }, 84, DEFAULT_THEME, NOW);

  it('둥근 테두리 안에 그림, 이름·AI 배지·상태, 지금 하는 일, 서브에이전트, 게이트·토큰을 놓는다', () => {
    const lines = card({ slot: 1 });
    const plain = lines.map(stripAnsi);
    // 그림이 카드 높이를 채운다: 넓은 카드는 그림 자리 14칸 × 7줄
    expect(plain).toHaveLength(ART_WIDE.rows + 2);
    for (const line of plain) expect(stringWidth(line)).toBe(84);
    expect(plain[0]!.startsWith('╭')).toBe(true);
    expect(plain[1]).toMatch(/│ .{14} {2}주문 모듈 +Claude +◐ 작업 중 │/);
    expect(plain[2]).toContain('지금 Edit src/order.ts');
    expect(plain[3]).toContain('↳ 서브에이전트 1개 작업 중 · Explore: 모델 요청 2회');
    expect(plain[4]).toContain('검증 통과 · 체크포인트 2 · 토큰 1.2만 · $0.42 · 칸 1');
    // 그림 자리에 반칸 블록이 있다
    expect(plain.slice(1, 5).join('')).toMatch(/[▀▄]/);
  });

  it('메인 에이전트 활동이 없으면 마지막 활동 때를, 게이트 기록이 없으면 그렇다고 적는다', () => {
    const plain = cardLines({ item: item('b'), selected: false, flagged: false, withLimits: false, sprite: defaultSprite(undefined) }, 60, DEFAULT_THEME, NOW).map(stripAnsi);
    expect(plain[2]).toContain('지금 마지막 활동 3분 전');
    expect(plain[4]).toContain('검증 기록 없음');
  });

  it('고른 카드는 강조색 테두리에 서브에이전트·범위를 펼친다', () => {
    const selected = card({ selected: true });
    expect(selected[0]).toContain(fg(DEFAULT_THEME, 'accent'));
    const plain = selected.map(stripAnsi);
    expect(plain.some((line) => line.includes('↳ Explore 작업 중 · 토큰 2,000 · 모델 요청 2회'))).toBe(true);
    expect(plain.length).toBeGreaterThan(card().length);
  });

  it('알린 뒤 보지 않은 세션은 이름 옆에 !', () => {
    expect(stripAnsi(card({ flagged: true })[1]!)).toMatch(/Claude +! /);
  });

  it('사용량이 있으면 5시간·주간 막대와 %, 그 아래 다시 차는 때. 없으면 "사용량 정보 없음"', () => {
    const limits = { fiveHour: { usedPercent: 37, resetsAt: new Date(NOW + 110 * 60_000).toISOString() }, weekly: { usedPercent: 90, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() } };
    const plain = card({ withLimits: true, limits }).map(stripAnsi);
    expect(plain).toHaveLength(ART_WIDE.rows + 2);
    expect(plain[5]).toMatch(/5시간 █+.* 37% +주간 █+.* 90%/);
    expect(plain[6]).toContain('1시간 50분 뒤');
    expect(plain[6]).toMatch(/\d+\/\d+\([일월화수목금토]\) \d\d:\d\d/);
    const none = card({ withLimits: true }).map(stripAnsi);
    expect(none[5]).toContain('사용량 정보 없음');
  });
});

describe('카드 그림(#902)', () => {
  const frames = [
    { pixels: spriteFromRows(['r'], { r: '#ff0000' }).pixels, delay: 100 },
    { pixels: spriteFromRows(['g'], { g: '#00ff00' }).pixels, delay: 100 },
  ];
  const animated = { width: 1, height: 1, pixels: frames[0]!.pixels, frames };
  const draw = (patch: Partial<Parameters<typeof cardLines>[0]>, width = 70) =>
    cardLines({ item: busy, selected: false, flagged: false, withLimits: false, sprite: animated, ...patch }, width, DEFAULT_THEME, NOW);

  it('좁은 카드는 그림 자리를 줄인다(12칸 × 5줄)', () => {
    const plain = draw({ sprite: defaultSprite('codex') }, 60).map(stripAnsi);
    expect(plain).toHaveLength(5 + 2);
    expect(plain[1]).toMatch(/│ .{12} {2}주문 모듈/);
  });

  it('움짤은 받은 프레임을 그린다', () => {
    expect(draw({ frame: 0 }).join('')).toContain('38;2;255;0;0');
    expect(draw({ frame: 1 }).join('')).toContain('38;2;0;255;0');
  });

  it('Kitty 그래픽이면 그림 자리에 placeholder 글자를 놓고, 처음 보이는 프레임을 보낼 것으로 모은다', () => {
    const kitty = new KittyImages(0x123456);
    const lines = draw({ kitty, frame: 1 });
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(70);
    // 둘째 프레임의 이미지 id(0x123457)가 글자색이다
    expect(lines[1]).toContain('\x1b[38;2;18;52;87m\u{10EEEE}');
    const sent = kitty.drain();
    expect(sent).toContain('a=T,U=1,f=100,i=1193047,c=14,r=7');
    expect(kitty.drain()).toBe('');
    // 같은 프레임은 다시 보내지 않는다
    draw({ kitty, frame: 1 });
    expect(kitty.drain()).toBe('');
  });
});

describe('다시 차는 때', () => {
  it('하루 안이면 남은 시간, 아니면 날짜와 요일', () => {
    expect(resetText(new Date(NOW + 40 * 60_000).toISOString(), NOW)).toBe('40분 뒤');
    expect(resetText(new Date(NOW + 2 * 3_600_000 + 40 * 60_000).toISOString(), NOW)).toBe('2시간 40분 뒤');
    expect(resetText(new Date(NOW - 1000).toISOString(), NOW)).toBe('곧 다시 참');
    const later = new Date(NOW + 3 * 86_400_000);
    expect(resetText(later.toISOString(), NOW)).toBe(`${later.getMonth() + 1}/${later.getDate()}(${'일월화수목금토'[later.getDay()]}) ${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`);
    expect(resetText(undefined, NOW)).toBe('');
    expect(resetText('nope', NOW)).toBe('');
  });
});

describe('카드 그림 고르기', () => {
  it('세션 id, AI 이름, default 차례로 찾고 없으면 기본 그림', () => {
    const mine = spriteFromRows(['a'], { a: '#ffffff' });
    const other = spriteFromRows(['b'], { b: '#000000' });
    expect(spriteFor(busy, { a: mine, 'claude-code': other })).toBe(mine);
    expect(spriteFor(busy, { 'claude-code': other, default: mine })).toBe(other);
    expect(spriteFor(busy, { default: mine })).toBe(mine);
    expect(spriteFor(busy, {}).width).toBe(10);
  });
});

describe('스페이스 화면', () => {
  const rect = { x: 33, y: 1, w: 120, h: 28 };
  const state = (patch: Partial<DeskState> = {}): DeskState => ({
    ...initialState(),
    items: [busy, item('b', { backend: 'codex' }), item('c'), item('d', { projectName: 'blog' })],
    view: 'space',
    ...patch,
  });

  it('고른 세션의 스페이스 카드만, 넓으면 두 열로 놓는다. 모든 줄은 본문 폭이다', () => {
    const screen = spaceScreen(state(), rect, NOW);
    expect(screen.lines).toHaveLength(rect.h);
    for (const line of screen.lines) expect(stringWidth(stripAnsi(line))).toBe(rect.w);
    expect(screen.cards.map((card) => card.index)).toEqual([0, 1, 2]);
    const [first, second, third] = screen.cards;
    // 첫째와 둘째는 같은 줄, 셋째는 다음 줄
    expect(first!.rect.y).toBe(second!.rect.y);
    expect(second!.rect.x).toBeGreaterThan(first!.rect.x);
    expect(third!.rect.y).toBeGreaterThan(first!.rect.y);
    const plain = screen.lines.map(stripAnsi).join('\n');
    expect(plain).toMatch(/shop +에이전트 3/);
    expect(plain).not.toContain('요청 d');
  });

  it('좁으면 한 열이고, 고른 카드가 아래쪽이면 위 카드를 건너뛰어 보인다', () => {
    const items = Array.from({ length: 8 }, (_, index) => item(`s${index}`));
    const screen = spaceScreen(state({ items, selected: 7 }), { x: 0, y: 1, w: 60, h: 20 }, NOW);
    expect(new Set(screen.cards.map((card) => card.rect.x)).size).toBe(1);
    expect(screen.cards.map((card) => card.index)).toContain(7);
    expect(screen.cards.map((card) => card.index)).not.toContain(0);
  });

  it('스페이스의 카드 하나라도 사용량이 있으면 모든 카드에 사용량 자리를 둔다', () => {
    const screen = spaceScreen(state({ limits: { b: { weekly: { usedPercent: 10 } } } }), rect, NOW);
    const plain = screen.lines.map(stripAnsi).join('\n');
    expect(plain).toContain('주간');
    expect(plain).toContain('사용량 정보 없음');
  });

  it('세션이 없으면 새 요청 안내', () => {
    const screen = spaceScreen(state({ items: [] }), rect, NOW);
    expect(screen.lines.map(stripAnsi).join('\n')).toContain('Ctrl-b n');
    expect(screen.cards).toEqual([]);
  });
});
