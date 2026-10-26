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

  it('둥근 테두리 안에 그림, 이름·AI 배지·칸·상태, 지금 하는 일, 서브에이전트를 놓는다(검증·토큰은 고른 카드에만, #934)', () => {
    const lines = card({ slot: 1 });
    const plain = lines.map(stripAnsi);
    // 그림이 카드 높이를 채운다: 넓은 카드는 그림 자리 14칸 × 7줄
    expect(plain).toHaveLength(ART_WIDE.rows + 2);
    for (const line of plain) expect(stringWidth(line)).toBe(84);
    expect(plain[0]!.startsWith('╭')).toBe(true);
    expect(plain[1]).toMatch(/│ .{14} {2}주문 모듈 +Claude +칸1 +◐ 작업 중 │/);
    expect(plain[2]).toContain('Edit src/order.ts');
    expect(plain[3]).toContain('↳ Explore · 모델 요청 2회');
    expect(plain.join('\n')).not.toContain('토큰');
    expect(card({ selected: true }).map(stripAnsi).join('\n')).toContain('검증 통과 · 토큰 1.2만 · $0.42 · 체크포인트 2');
    // 그림 자리에 반칸 블록이 있다
    expect(plain.slice(1, 5).join('')).toMatch(/[▀▄]/);
  });

  it('메인 에이전트 활동이 없으면 마지막 활동 때를 적는다', () => {
    const plain = cardLines({ item: item('b'), selected: false, flagged: false, withLimits: false, sprite: defaultSprite(undefined) }, 60, DEFAULT_THEME, NOW).map(stripAnsi);
    expect(plain[2]).toContain('마지막 활동 3분 전');
  });

  it('고른 카드는 강조색 테두리에 서브에이전트·범위를 펼친다', () => {
    const selected = card({ selected: true });
    expect(selected[0]).toContain(fg(DEFAULT_THEME, 'accent'));
    const plain = selected.map(stripAnsi);
    // 카드 몸에 보인 서브에이전트는 펼친 줄에 다시 넣지 않는다(#934)
    expect(plain.filter((line) => line.includes('모델 요청 2회')).length).toBe(1);
    expect(plain.length).toBeGreaterThan(card().length);
  });

  it('끝났지만 아직 보지 않은 세션은 초록 "끝남", 본 뒤에는 흐린 "CLI 대기"(#922)', () => {
    const settled = item('u', { terminal: { cli: 'up' } });
    const draw = (unseen: boolean) => cardLines({ item: settled, selected: false, flagged: false, withLimits: false, unseen, sprite: defaultSprite(undefined) }, 84, DEFAULT_THEME, NOW);
    expect(stripAnsi(draw(true)[1]!)).toContain('✓ 끝남');
    expect(draw(true)[1]).toContain(fg(DEFAULT_THEME, 'green'));
    expect(stripAnsi(draw(false)[1]!)).toContain('CLI 대기');
    const screen = spaceScreen({ ...initialState(), items: [settled], view: 'space', unseenDone: ['u'] }, { x: 0, y: 1, w: 120, h: 20 }, NOW);
    expect(screen.lines.map(stripAnsi).join('\n')).toContain('✓ 끝남');
  });

  it('알린 뒤 보지 않은 세션은 이름 옆에 !', () => {
    expect(stripAnsi(card({ flagged: true })[1]!)).toMatch(/Claude +! /);
  });

  it('계정 한도가 80%를 넘으면 가장 빠듯한 창 하나를 경고 한 줄로, 다시 차는 때와 함께(#934)', () => {
    const limits = { fiveHour: { usedPercent: 85, resetsAt: new Date(NOW + 110 * 60_000).toISOString() }, weekly: { usedPercent: 90, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() } };
    const plain = card({ withLimits: true, limits }).map(stripAnsi);
    expect(plain).toHaveLength(ART_WIDE.rows + 2);
    const warn = plain.find((line) => line.includes('⚠ 이 계정'))!;
    expect(warn).toContain('⚠ 이 계정 주간 90%');
    expect(warn).toMatch(/\d+\/\d+\([일월화수목금토]\) \d\d:\d\d 다시 참/);
    expect(card({ withLimits: true }).map(stripAnsi).join('\n')).not.toContain('⚠ 이 계정');
  });
});

describe('카드가 보이는 지금 하는 일·할 일·문맥·마지막 답(#921)', () => {
  const rich = item('r', {
    title: '결제',
    state: 'working',
    now: { tool: 'Edit', target: 'src/pay.ts', at: '2026-10-23T11:59:40Z' },
    todos: { done: 3, total: 7, current: '결제 테스트 작성' },
    context: { usedPct: 62, used: 124_000, size: 200_000 },
    lastMessage: '결제 모듈에 테스트 세 개를 더했습니다',
  });
  const card = (target: DeskItem, patch: Partial<Parameters<typeof cardLines>[0]> = {}, width = 84) =>
    cardLines({ item: target, selected: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code'), ...patch }, width, DEFAULT_THEME, NOW).map(stripAnsi);

  it('지금 줄은 도구를 우리말로, 대상과 지난 시간을 붙인다', () => {
    expect(card(rich)[2]).toContain('편집 src/pay.ts · 20초 전');
    expect(card(item('x', { now: { tool: 'Bash', target: 'pnpm test', at: '2026-10-23T11:58:00Z' } }))[2]).toContain('실행 pnpm test · 2분 전');
    expect(card(item('x', { now: { tool: 'mcp__github__create_pr', at: '2026-10-23T11:59:59Z' } }))[2]).toContain('mcp__github__create_pr');
  });

  it('할 일 진행과 문맥 창 막대를 한 줄에, 마지막 답을 한 줄에 놓는다', () => {
    const plain = card(rich);
    const progress = plain.find((line) => line.includes('3/7'));
    expect(progress).toMatch(/3\/7 결제 테스트 작성/);
    expect(progress).toMatch(/문맥 .*62%/);
    expect(plain.some((line) => line.includes('답 결제 모듈에 테스트 세 개를 더했습니다'))).toBe(true);
    for (const line of plain) expect(stringWidth(line)).toBe(84);
  });

  it('문맥 창은 많이 찰수록 노랑, 빨강으로 칠한다', () => {
    const colored = (pct: number) => cardLines({ item: item('x', { context: { usedPct: pct } }), selected: false, flagged: false, withLimits: false, sprite: defaultSprite(undefined) }, 84, DEFAULT_THEME, NOW).join('');
    expect(colored(30)).toContain(fg(DEFAULT_THEME, 'green'));
    expect(colored(70)).toContain(fg(DEFAULT_THEME, 'yellow'));
    expect(colored(90)).toContain(fg(DEFAULT_THEME, 'red'));
  });

  it('입력을 기다리면 지금 줄 자리에 기다리는 까닭을 보인다', () => {
    const waiting = item('w', { now: rich.now!, terminal: { cli: 'up', waiting: 'permission', message: 'Bash rm -rf dist 실행 허락' } });
    const plain = card(waiting);
    expect(plain[1]).toContain('권한 대기');
    expect(plain[2]).toContain('› Bash rm -rf dist 실행 허락');
    expect(card(item('q', { terminal: { cli: 'up', waiting: 'question', message: '어느 결제사를 쓸까요?' } }))[2]).toContain('› 어느 결제사를 쓸까요?');
  });

  it('서브에이전트 요약은 인스턴스의 설명과 도구를 쓴다', () => {
    const agents = [
      { id: 'main', name: '메인', kind: 'main' as const, state: 'working' as const, tokens: usage(1) },
      { id: 'a1', name: 'Explore', type: 'Explore', description: '결제 흐름 찾기', tool: 'Grep order', kind: 'subagent' as const, state: 'working' as const, tokens: usage(10) },
      { id: 'a2', name: 'Explore', type: 'Explore', description: '테스트 찾기', kind: 'subagent' as const, state: 'working' as const, tokens: usage(10) },
    ];
    const plain = card(item('s', { agents }));
    expect(plain[3]).toContain('↳ Explore 결제 흐름 찾기 · Grep order');
    expect(plain[4]).toContain('↳ Explore 테스트 찾기');
  });

  it('고른 카드는 마지막 답을 두 줄까지 펼친다', () => {
    const long = item('l', { lastMessage: '가'.repeat(120) });
    const plain = cardLines({ item: long, selected: true, flagged: false, withLimits: false, sprite: defaultSprite(undefined) }, 84, DEFAULT_THEME, NOW).map(stripAnsi);
    expect(plain.filter((line) => line.includes('가가가가')).length).toBe(3);
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

  it('카드에는 계정 막대를 그리지 않고, 80%를 넘은 계정이 있을 때만 경고 줄 자리를 둔다(#934)', () => {
    const calm = spaceScreen(state({ limits: { b: { weekly: { usedPercent: 10 } } } }), rect, NOW).lines.map(stripAnsi).join('\n');
    expect(calm).not.toContain('주간');
    const tight = spaceScreen(state({ limits: { b: { weekly: { usedPercent: 92 } } } }), rect, NOW);
    expect(tight.lines.map(stripAnsi).join('\n')).toContain('⚠ 이 계정 주간 92%');
    // 경고가 없는 카드도 같은 자리를 둔다(높이를 맞춘다). 고른 카드는 펼쳐서 더 크니 고르지 않은 둘을 본다
    const [, second, third] = tight.cards;
    expect(second!.rect.h).toBe(third!.rect.h);
  });

  it('새 필드가 있는 카드가 있으면 스페이스의 모든 카드에 그 줄 자리를 둔다', () => {
    const rich = item('r', { todos: { done: 1, total: 2 }, lastMessage: '끝났습니다' });
    const screen = spaceScreen(state({ items: [rich, item('b')] }), rect, NOW);
    const [first, second] = screen.cards;
    expect(first!.rect.h).toBe(second!.rect.h);
    expect(screen.lines.map(stripAnsi).join('\n')).toContain('답 끝났습니다');
  });

  it('높이가 모자라면 마지막 답, 할 일·문맥, 한도 경고 차례로 줄을 뺀다', () => {
    const agents = [1, 2].map((n) => ({ id: `s${n}`, name: 'Explore', type: 'Explore', description: `찾기 ${n}`, kind: 'subagent' as const, state: 'working' as const, tokens: usage(1) }));
    const rich = item('r', { state: 'working', todos: { done: 1, total: 2 }, context: { usedPct: 40 }, lastMessage: '끝났습니다', agents });
    const limits = { r: { weekly: { usedPercent: 90 } } };
    // 좁은 카드(그림 5줄): 글 줄 7개(머리·지금·할 일·서브에이전트 2·답·한도 경고)에 테두리 2줄, 스페이스 머리 2줄
    const text = (h: number) => spaceScreen(state({ items: [rich], limits }), { x: 0, y: 1, w: 60, h }, NOW).lines.map(stripAnsi).join('\n');
    expect(text(11)).toContain('답 끝났습니다');
    expect(text(11)).toContain('1/2');
    expect(text(11)).toContain('⚠ 이 계정');
    expect(text(10)).not.toContain('답 끝났습니다');
    expect(text(10)).toContain('1/2');
    expect(text(9)).not.toContain('1/2');
    expect(text(9)).toContain('⚠ 이 계정');
    // 그림(5줄)보다 낮아지지 않으니 그 아래로는 더 빼지 않는다
    expect(text(8)).toContain('찾기 2');
  });

  it('세션이 없으면 폴더 등록(a)과 새 요청(n) 안내(#916)', () => {
    const screen = spaceScreen(state({ items: [] }), rect, NOW);
    const text = screen.lines.map(stripAnsi).join('\n');
    expect(text).toContain('a 를 눌러 내 폴더를 프로젝트로 등록');
    expect(text).toContain('n 으로 새 요청');
    expect(screen.cards).toEqual([]);
  });
});
