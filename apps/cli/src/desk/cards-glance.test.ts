import { describe, expect, it } from 'vitest';
import { cardLines, clipWords, needsYou, spaceScreen } from './cards';
import { handleInput, initialState, type DeskState } from './keys';
import { stringWidth, stripAnsi } from './screen';
import { deskSessions } from './sidebar';
import { defaultSprite } from './sprite';
import { DEFAULT_THEME, fg } from './theme';
import type { DeskAgent, DeskItem } from './types';

// #934: 카드를 짧게, 몇 분째·멈춘 듯·남은 시간(추정), 확인 필요 줄
const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: ago(30), ...patch });
const draw = (target: DeskItem, patch: Partial<Parameters<typeof cardLines>[0]> = {}, width = 84) =>
  cardLines({ item: target, selected: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code'), ...patch }, width, DEFAULT_THEME, NOW).map(stripAnsi);
const sub = (id: string, patch: Partial<DeskAgent> = {}): DeskAgent => ({ id, name: 'Explore', type: 'Explore', kind: 'subagent', state: 'working', tokens: usage(10), ...patch });

describe('카드 머리: 상태와 몇 분째', () => {
  it('작업 중이면 요청을 시작한 뒤 지난 시간을 "작업 23분째"로 보인다', () => {
    const plain = draw(item('a', { state: 'working', workingSince: ago(23 * 60) }));
    expect(plain[1]).toMatch(/◐ 작업 23분째 │$/);
  });

  it('검증 실패는 머리 배지로 올리고, 지금 줄에 그 까닭을 적는다(초록 CLI 대기와 섞지 않는다)', () => {
    const failed = item('f', { terminal: { cli: 'up' }, gate: { state: 'failed', checkpoints: 2 }, reason: '테스트 3건 실패' });
    const plain = draw(failed);
    expect(plain[1]).toContain('검증 실패');
    expect(plain[1]).not.toContain('CLI 대기');
    expect(plain[2]).toContain('› 테스트 3건 실패');
    expect(draw(item('v', { terminal: { cli: 'up' }, gate: { state: 'verifying', checkpoints: 1 } }))[1]).toContain('검증 중');
  });
});

describe('지금 줄: 마지막 소식과 멈춘 듯', () => {
  it('도구가 끝났으면 대상과 "13초 전"', () => {
    const plain = draw(item('a', { state: 'working', now: { tool: 'Edit', target: 'apps/shop/order.ts', at: ago(13) } }));
    expect(plain[2]).toContain('편집 apps/shop/order.ts · 13초 전');
  });

  it('도구가 아직 돌면 "pnpm test 실행 6분째"로 보이고, 오래 걸려도 멈춘 듯으로 보지 않는다', () => {
    const plain = draw(item('a', { state: 'working', now: { tool: 'Bash', target: 'pnpm test', at: ago(6 * 60), running: true } }));
    expect(plain[2]).toContain('실행 pnpm test · 6분째');
    expect(plain.join('\n')).not.toContain('소식 없음');
  });

  it('작업 중인데 도구도 돌지 않고 3분 넘게 소식이 없으면 "⚠ 4분째 소식 없음"을 노랑으로', () => {
    const stale = item('s', { state: 'working', now: { tool: 'Read', target: 'a.ts', at: ago(4 * 60) }, lastActivityAt: ago(4 * 60) });
    const plain = draw(stale);
    expect(plain[2]).toContain('⚠ 4분째 소식 없음');
    const raw = cardLines({ item: stale, selected: false, flagged: false, withLimits: false, sprite: defaultSprite(undefined) }, 84, DEFAULT_THEME, NOW).join('');
    expect(raw).toContain(`${fg(DEFAULT_THEME, 'yellow')}⚠ 4분째 소식 없음`);
    // 쉬는 세션은 오래 조용해도 멈춘 듯이 아니다
    expect(draw(item('i', { lastActivityAt: ago(30 * 60) })).join('\n')).not.toContain('소식 없음');
  });
});

describe('할 일과 남은 시간(추정)', () => {
  it('끝낸 할 일이 둘 이상이면 지금까지의 속도로 남은 시간을 추정해 적는다', () => {
    const plain = draw(item('t', { state: 'working', workingSince: ago(12 * 60), todos: { done: 3, total: 7, current: '전이 테스트' } }));
    const line = plain.find((text) => text.includes('3/7'))!;
    expect(line).toContain('전이 테스트');
    // 12분에 3개 → 하나에 4분, 남은 4개 → 약 16분
    expect(line).toContain('약 16분 남음(추정)');
  });

  it('하나만 끝냈거나 시작 시각을 모르면 남은 시간을 지어내지 않는다', () => {
    expect(draw(item('t', { state: 'working', workingSince: ago(600), todos: { done: 1, total: 4 } })).join('\n')).not.toContain('남음');
    expect(draw(item('t', { state: 'working', todos: { done: 3, total: 4 } })).join('\n')).not.toContain('남음');
  });
});

describe('서브에이전트 줄', () => {
  const agents: DeskAgent[] = [
    { id: 'main', name: '메인', kind: 'main', state: 'working', tokens: usage(1) },
    sub('a1', { description: '주문 호출부 찾기', tool: 'Grep', startedAt: ago(4 * 60), lastAt: ago(10) }),
    sub('a2', { type: 'test-runner', name: 'test-runner', description: 'pnpm test', startedAt: ago(9 * 60), lastAt: ago(6 * 60) }),
    sub('a3', { description: '문서 찾기', startedAt: ago(60) }),
  ];

  it('작업 중인 것을 둘까지 한 줄씩 "4분째"로, 나머지는 "외 N개"', () => {
    const plain = draw(item('m', { state: 'working', agents })).join('\n');
    expect(plain).toContain('↳ Explore 주문 호출부 찾기 · Grep · 4분째');
    expect(plain).toContain('↳ 외 1개 작업 중');
  });

  it('서브에이전트가 3분 넘게 소식이 없으면 그 줄에 멈춘 듯을 적는다', () => {
    expect(draw(item('m', { state: 'working', agents })).join('\n')).toContain('↳ test-runner pnpm test · ⚠ 6분째 소식 없음');
  });

  it('고른 카드를 펼쳐도 이미 보인 서브에이전트를 다시 그리지 않는다', () => {
    const plain = draw(item('m', { state: 'working', agents }), { selected: true });
    expect(plain.filter((line) => line.includes('주문 호출부 찾기')).length).toBe(1);
    expect(plain.some((line) => line.includes('문서 찾기'))).toBe(true);
  });
});

describe('계정 사용량', () => {
  it('카드에 5시간·주간 막대를 그리지 않고, 80%를 넘었을 때만 경고 한 줄', () => {
    const calm = draw(item('a'), { withLimits: true, limits: { fiveHour: { usedPercent: 37 }, weekly: { usedPercent: 26 } } }).join('\n');
    expect(calm).not.toContain('5시간');
    expect(calm).not.toContain('주간');
    const tight = draw(item('a'), { withLimits: true, limits: { fiveHour: { usedPercent: 37 }, weekly: { usedPercent: 90 } } }).join('\n');
    expect(tight).toContain('⚠ 이 계정 주간 90%');
  });
});

describe('낱말 경계 말줄임', () => {
  it('넘치면 낱말 사이에서 자르고 …를 붙인다', () => {
    expect(clipWords('주문 상태를 한 곳에서 바꾸게 묶었습니다', 16)).toBe('주문 상태를 한…');
    expect(clipWords('짧은 글', 20)).toBe('짧은 글');
    expect(stringWidth(clipWords('가'.repeat(30), 11))).toBeLessThanOrEqual(11);
  });

  it('긴 대상은 카드 폭 안에서 …로 끝난다', () => {
    const plain = draw(item('a', { state: 'working', now: { tool: 'Bash', target: 'pnpm --filter @b-studio/studio test -- --run apps/studio/lib/server/sessions-terminal-gateway.test.ts', at: ago(5) } }), {}, 60);
    for (const line of plain) expect(stringWidth(line)).toBe(60);
    expect(plain[2]).toMatch(/…/);
  });
});

describe('확인 필요 줄', () => {
  const items = [
    item('w', { title: '주문 리팩터링', state: 'working' }),
    item('p', { title: '결제 테스트 보강', terminal: { cli: 'up', waiting: 'permission', message: 'pnpm test 실행 허락' } }),
    item('g', { title: '로그인 오류 고치기', projectName: 'auth', terminal: { cli: 'up' }, gate: { state: 'failed', checkpoints: 1 }, reason: '검증 실패 3건' }),
  ];
  const state = (patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items, view: 'space', ...patch });

  it('권한·질문·입력과 검증 실패를 스페이스와 상관없이 모아 번호를 붙인다', () => {
    const list = needsYou(state());
    expect(list.map((entry) => entry.item.id)).toEqual(['p', 'g']);
    const text = spaceScreen(state(), { x: 0, y: 1, w: 120, h: 30 }, NOW).lines.map(stripAnsi).join('\n');
    expect(text).toMatch(/확인 필요 2/);
    expect(text).toMatch(/1 +결제 테스트 보강 .*권한 대기 · pnpm test 실행 허락/);
    expect(text).toMatch(/2 +로그인 오류 고치기 .*검증 실패 3건/);
  });

  it('스페이스 화면에서 숫자로 고르고 Enter로 그 칸에 연다(키를 CLI로 보내지 않는다)', () => {
    const picked = handleInput(state(), '2');
    expect(picked.effects).toEqual([]);
    expect(deskSessions(picked.state.items)[picked.state.selected]?.id).toBe('g');
    const text = spaceScreen(picked.state, { x: 0, y: 1, w: 120, h: 30 }, NOW).lines.map(stripAnsi).join('\n');
    expect(text).toMatch(/auth +에이전트 1/);
    const opened = handleInput(picked.state, '\r');
    expect(opened.effects).toContainEqual(expect.objectContaining({ type: 'open', id: 'g' }));
    // 없는 번호는 아무것도 하지 않는다
    expect(handleInput(state(), '7').state.selected).toBe(state().selected);
  });

  it('손댈 것이 없으면 줄을 감춘다', () => {
    const text = spaceScreen(state({ items: [items[0]!] }), { x: 0, y: 1, w: 120, h: 30 }, NOW).lines.map(stripAnsi).join('\n');
    expect(text).not.toContain('확인 필요');
  });
});

describe('고른 카드의 마지막 답', () => {
  it('첫 줄과 펼친 줄이 이어져 글이 빠지지 않는다', () => {
    const message = '주문 상태를 한 곳에서 바꾸게 묶었습니다. 이제 전이 테스트를 씁니다.';
    const plain = draw(item('l', { lastMessage: message }), { selected: true }, 60);
    // 테두리와 그림 글자, 빈칸을 걷고 이어 붙인다
    const joined = plain.join('').replace(/[\s│╭╮╰╯─▀▄█]/g, '');
    expect(joined).toContain(`답${message}`.replace(/\s/g, ''));
  });
});
