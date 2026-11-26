import { describe, expect, it } from 'vitest';
import { renderAgentTree, treeKey, treeRows } from './agent-tree';
import { handleInput, initialState, type DeskState } from './keys';
import { stringWidth, stripAnsi } from './screen';
import type { DeskAgent, DeskItem } from './types';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: ago(30), ...patch });
const sub = (id: string, patch: Partial<DeskAgent> = {}): DeskAgent => ({ id, name: 'Explore', type: 'Explore', kind: 'subagent', state: 'working', tokens: usage(10), ...patch });
const main: DeskAgent = { id: 'main', name: '메인', kind: 'main', state: 'working', tokens: usage(1) };

const busy = item('a', {
  title: '주문 모듈',
  state: 'working',
  workingSince: ago(23 * 60),
  now: { tool: 'Bash', target: 'pnpm test', at: ago(6 * 60), running: true },
  agents: [
    main,
    sub('a1', { description: '결제 흐름 찾기', tool: 'Grep order', startedAt: ago(4 * 60), lastAt: ago(10) }),
    sub('a2', { type: 'test-runner', name: 'test-runner', description: 'pnpm test', startedAt: ago(9 * 60), lastAt: ago(6 * 60) }),
    sub('a3', { state: 'done', description: '문서 찾기', startedAt: ago(5 * 60), lastAt: ago(2 * 60), result: 'README에 세 곳이 있습니다' }),
  ],
});
const alone = item('b', { title: '혼자 하는 일', state: 'working', workingSince: ago(60), now: { tool: 'Edit', target: 'a.ts', at: ago(13) }, agents: [main] });
const other = item('c', { title: '다른 곳', projectName: 'blog', agents: [main, sub('c1', { description: '글 찾기', startedAt: ago(30), lastAt: ago(5) })] });

const state = (patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items: [busy, alone, other], tree: { index: 0, all: false }, ...patch });
const rect = { w: 80, h: 14 };
const draw = (patch: Partial<DeskState> = {}, r = rect) => renderAgentTree(state(patch), r, NOW).lines.map(stripAnsi);

describe('에이전트 나무 목록: 줄 모으기', () => {
  it('세션이 부모 줄이고 서브에이전트는 그 아래 자식 줄이다. 서브에이전트가 없는 세션은 부모 줄만이다(메인 에이전트는 줄이 아니다)', () => {
    const rows = treeRows(state());
    expect(rows.map((row) => `${row.item.id}:${row.agent?.id ?? '-'}`)).toEqual(['a:-', 'a:a1', 'a:a2', 'a:a3', 'b:-']);
    expect(rows.filter((row) => row.agent).map((row) => row.last)).toEqual([false, false, true]);
  });

  it('범위는 처음에 고른 세션이 든 스페이스이고, 전체로 바꾸면 모든 스페이스다', () => {
    expect(treeRows(state({ tree: { index: 0, all: true } })).map((row) => row.item.id)).toEqual(['a', 'a', 'a', 'a', 'b', 'c', 'c']);
  });
});

describe('에이전트 나무 목록: 그림', () => {
  it('부모 줄에 상태·제목·AI 배지·지금 하는 일·경과, 자식 줄에 ├ └ 와 종류·맡긴 일·도구·경과', () => {
    const text = draw();
    const parent = text.find((line) => line.includes('주문 모듈'))!;
    expect(parent).toContain('◐');
    expect(parent).toContain('Claude');
    expect(parent).toContain('실행 pnpm test');
    expect(parent).toMatch(/작업 23분째$/);
    expect(text.find((line) => line.includes('결제 흐름 찾기'))).toMatch(/├ ◐ Explore 결제 흐름 찾기 · Grep order .*4분째/);
    expect(text.find((line) => line.includes('문서 찾기'))).toMatch(/└ ✓ Explore 문서 찾기 · 결과 README에 세 곳이 있습니다/);
  });

  it('3분 넘게 소식이 없는 서브에이전트는 카드와 같은 규칙으로 "N분째 소식 없음"을 적는다', () => {
    const line = draw().find((entry) => entry.includes('test-runner'))!;
    expect(line).toContain('⚠ 6분째 소식 없음');
    expect(draw().find((entry) => entry.includes('결제 흐름 찾기'))).not.toContain('소식 없음');
  });

  it('끝난 서브에이전트는 소식 없음 경고를 달지 않는다', () => {
    const done = item('d', { agents: [main, sub('d1', { state: 'done', description: '끝난 일', startedAt: ago(3600), lastAt: ago(3000), result: '다 했습니다' })] });
    expect(draw({ items: [done], tree: { index: 0, all: false } }).join('\n')).not.toContain('소식 없음');
  });

  it('고른 줄에만 › 표시를 달고, 거절·실패한 도구는 부모 줄에 까닭이 보인다', () => {
    const failing = item('f', { title: '막힌 일', state: 'working', now: { tool: 'Bash', target: 'rm -rf x', at: ago(5), error: '거절됨: 위험한 명령' }, agents: [main] });
    const text = draw({ items: [failing], tree: { index: 0, all: false } });
    expect(text.find((line) => line.includes('막힌 일'))).toContain('› ');
    expect(text.find((line) => line.includes('막힌 일'))).toContain('거절됨: 위험한 명령');
    expect(draw({ tree: { index: 2, all: false } }).filter((line) => line.includes('› ')).length).toBe(1);
    expect(draw({ tree: { index: 2, all: false } }).find((line) => line.includes('› '))).toContain('test-runner');
  });

  it('머리에 범위와 개수를 적고, 전체로 바꾸면 스페이스 이름이 줄에 붙는다', () => {
    expect(draw()[0]).toContain('shop');
    expect(draw()[0]).toMatch(/서브에이전트 3/);
    const all = draw({ tree: { index: 0, all: true } });
    expect(all[0]).toContain('전체');
    expect(all.find((line) => line.includes('다른 곳'))).toContain('blog');
  });

  it('80칸에서도 모든 줄이 정확히 그 폭이고, 한글이 걸쳐 깨지지 않는다', () => {
    for (const w of [80, 60, 40, 24]) {
      const lines = renderAgentTree(state({ tree: { index: 1, all: true } }), { w, h: 14 }, NOW).lines;
      expect(lines).toHaveLength(14);
      for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(w);
    }
  });

  it('서브에이전트가 다섯 개 이상인 세션 셋을 한 화면에 그린다', () => {
    const many = (id: string) => item(id, { title: `큰 일 ${id}`, state: 'working', agents: [main, ...[1, 2, 3, 4, 5].map((n) => sub(`${id}${n}`, { description: `일 ${n}`, startedAt: ago(60 * n), lastAt: ago(5) }))] });
    const lines = draw({ items: [many('x'), many('y'), many('z')], tree: { index: 0, all: false } }, { w: 80, h: 20 });
    expect(lines.filter((line) => /[├└] /.test(line))).toHaveLength(15);
  });

  it('줄이 화면보다 많으면 고른 줄이 보이게 내리고 위·아래에 더 있음을 알린다', () => {
    const small = { w: 80, h: 4 };
    const top = draw({ tree: { index: 0, all: false } }, small);
    expect(top.join('\n')).toContain('↓ 아래 ');
    expect(top.join('\n')).not.toContain('↑ 위');
    const bottom = draw({ tree: { index: 4, all: false } }, small);
    expect(bottom.join('\n')).toContain('혼자 하는 일');
    expect(bottom.join('\n')).toContain('↑ 위');
  });

  it('세션이 없으면 안내 한 줄', () => {
    expect(draw({ items: [] }).join('\n')).toContain('에이전트가 없습니다');
  });
});

describe('에이전트 나무 목록: 키', () => {
  it('↑↓로 줄을 옮기고 끝에서 멈춘다. 고른 줄은 줄 순서가 바뀌어도 같은 줄을 따라간다', () => {
    const start = state();
    const down = treeKey(start, '\x1b[B').state!;
    expect(down).toMatchObject({ index: 1, session: 'a', agent: 'a1' });
    expect(treeKey({ ...start, tree: down }, '\x1b[A').state).toMatchObject({ index: 0, session: 'a' });
    expect(treeKey(start, '\x1b[A').state!.index).toBe(0);
    const last = treeKey({ ...start, tree: { index: 4, all: false } }, 'j').state!;
    expect(last.index).toBe(4);
    // a1이 목록 맨 뒤로 가도 고른 줄은 a1이다
    const reordered = { ...start, tree: down, items: [alone, busy, other] };
    expect(treeRows(reordered)[treeRows(reordered).findIndex((row) => row.agent?.id === 'a1')]).toBeDefined();
    expect(treeKey(reordered, '\x1b[B').state).toMatchObject({ session: 'a', agent: 'a2' });
  });

  it('Enter는 고른 줄의 세션을 고르고(자식 줄도 그 세션), Esc와 m은 닫고, Tab은 범위를 바꾼다', () => {
    expect(treeKey({ ...state(), tree: { index: 2, all: false } }, '\r').chosen).toBe('a');
    expect(treeKey(state(), '\x1b')).toEqual({});
    expect(treeKey(state(), 'm')).toEqual({});
    expect(treeKey(state(), '\t').state?.all).toBe(true);
    expect(treeKey({ ...state(), tree: { index: 0, all: true } }, '\t').state?.all).toBe(false);
  });
});

describe('에이전트 나무 목록: desk 키 처리', () => {
  const base = (patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items: [busy, alone, other], ...patch });

  it('Ctrl-b m으로 열고 같은 키로 닫는다. 열려 있는 동안 친 글자는 칸으로 가지 않는다', () => {
    const opened = handleInput(base({ slots: ['a', undefined, undefined, undefined] }), '\x02m').state;
    expect(opened.tree).toBeDefined();
    const typed = handleInput(opened, 'ls\r');
    expect(typed.effects.every((effect) => effect.type !== 'input')).toBe(true);
    expect(handleInput(opened, '\x02m').state.tree).toBeUndefined();
  });

  it('카드 화면에서는 앞글쇠 없이 m으로 연다', () => {
    expect(handleInput(base({ view: 'space' }), 'm').state.tree).toBeDefined();
  });

  it('Enter로 고른 세션을 칸에 열고 닫는다(카드 화면의 Enter와 같은 동작)', () => {
    const opened = handleInput(base({ slots: [undefined, undefined, undefined, undefined] }), '\x02m').state;
    const moved = handleInput(opened, '\x1b[B\x1b[B\x1b[B\x1b[B').state;
    const { state: next, effects } = handleInput(moved, '\r');
    expect(effects).toContainEqual({ type: 'open', slot: 0, id: 'b' });
    expect(next.tree).toBeUndefined();
    expect(next.selected).toBe(1);
  });

  it('앞글쇠 다음 다른 화면 키는 닫고 그 일을 한다. 열면 다른 덮는 화면은 닫는다', () => {
    const opened = handleInput(base(), '\x02m').state;
    const next = handleInput(opened, '\x02w').state;
    expect(next.tree).toBeUndefined();
    expect(next.view).toBe('space');
    const plans = handleInput(base(), '\x02t').state;
    const { state: swapped, effects } = handleInput(plans, '\x02m');
    expect(swapped.plans).toBeUndefined();
    expect(swapped.tree).toBeDefined();
    expect(effects).toContainEqual({ type: 'plans', effect: { type: 'close' } });
  });

  it('붙여 넣은 글과 마우스는 받지 않는다', () => {
    const opened = handleInput(base({ slots: ['a', undefined, undefined, undefined] }), '\x02m').state;
    expect(handleInput(opened, '\x1b[200~hello\x1b[201~').effects).toEqual([]);
    expect(handleInput(opened, '\x1b[<0;5;5M').effects).toEqual([]);
  });
});
