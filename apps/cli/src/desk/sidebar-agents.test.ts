/**
 * 사이드바에서 서브에이전트 펼치기(#1411): 세션 줄 아래에 서브에이전트를 한 줄씩 편다.
 * 작업 중인 것이 있는 세션은 자동으로 펴고(끝난 것은 "끝남 N"), →로 모두 펴고 ←로 접는다. 줄 수에 상한이 있고 모든 줄 폭은 사이드바 폭이다
 */
import { describe, expect, it } from 'vitest';
import { handleInput, initialState, sideAgentOf, type DeskState } from './keys';
import { stringWidth, stripAnsi } from './screen';
import { SIDE_AGENT_MAX, sideAgents, sideTargets, sidebarRows } from './sidebar';
import type { DeskAgent, DeskItem } from './types';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: ago(30), ...patch });
const sub = (id: string, patch: Partial<DeskAgent> = {}): DeskAgent => ({ id: `claude:agent:${id}`, name: 'Explore', type: 'Explore', kind: 'subagent', state: 'working', tokens: usage, startedAt: ago(120), lastAt: ago(5), ...patch });

const busy = item('a', {
  title: '주문 모듈',
  state: 'working',
  agents: [
    sub('a1', { description: '결제 흐름 찾기', tool: 'Grep order' }),
    sub('a2', { type: 'general-purpose', name: 'general-purpose', description: '테스트 돌리기', tool: 'Bash pnpm test' }),
    sub('a3', { state: 'done', description: '문서 찾기', result: '세 곳' }),
  ],
});
const quiet = item('b', { title: '혼자 하는 일' });
const finished = item('c', { title: '끝난 일', agents: [sub('c1', { state: 'done', description: '끝난 탐색' })] });
const other = item('d', { title: '다른 곳', projectName: 'blog', agents: [sub('d1', { description: '글 찾기' })] });

const rows = (items: DeskItem[], selected: number, width = 30, side: Parameters<typeof sidebarRows>[8] = {}) =>
  sidebarRows(items, selected, new Map(), width, new Set(), undefined, new Set(), NOW, side);
const text = (items: DeskItem[], selected: number, width = 30, side: Parameters<typeof sidebarRows>[8] = {}) => rows(items, selected, width, side).map((row) => stripAnsi(row.text).trimEnd());

describe('사이드바 서브에이전트: 펼침 규칙', () => {
  it('작업 중인 서브에이전트가 있는 세션만 자동으로 펴고, 끝난 것은 접는다', () => {
    expect(sideAgents(busy)?.agents.map((agent) => agent.id)).toEqual(['claude:agent:a1', 'claude:agent:a2']);
    expect(sideAgents(busy)).toMatchObject({ finished: 1, more: 0 });
    expect(sideAgents(quiet)).toBeUndefined();
    // 끝난 것만 있으면 자동으로는 접힌 채다
    expect(sideAgents(finished)).toBeUndefined();
  });

  it('→로 연 세션은 끝난 것까지 모두, ←로 접은 세션은 작업 중이어도 접힌다', () => {
    expect(sideAgents(finished, { open: ['c'] })?.agents).toHaveLength(1);
    expect(sideAgents(busy, { open: ['a'] })?.agents).toHaveLength(3);
    expect(sideAgents(busy, { open: ['a'] })?.finished).toBe(0);
    expect(sideAgents(busy, { closed: ['a'] })).toBeUndefined();
  });

  it('세션당 줄 수에 상한이 있고 넘친 것은 "외 N개"로 센다', () => {
    const many = item('m', { agents: Array.from({ length: 7 }, (_, at) => sub(`m${at}`, { description: `일 ${at}` })) });
    const shown = sideAgents(many)!;
    expect(shown.agents).toHaveLength(SIDE_AGENT_MAX);
    expect(shown.more).toBe(7 - SIDE_AGENT_MAX);
    const lines = text([many], 0);
    expect(lines.filter((line) => /[├└] ◐/.test(line))).toHaveLength(SIDE_AGENT_MAX);
    expect(lines.at(-2)).toContain(`└ 외 ${7 - SIDE_AGENT_MAX}개`);
  });

  it('고를 수 있는 줄은 세션과 고른 세션이 든 스페이스의 펴진 서브에이전트 줄이다', () => {
    const items = [busy, quiet, other];
    expect(sideTargets(items, 0).map((target) => `${target.index}:${target.agent ?? '-'}`)).toEqual(['0:-', '0:claude:agent:a1', '0:claude:agent:a2', '1:-', '2:-']);
    // 다른 스페이스의 세션을 고르면 그 스페이스가 열려 서브에이전트 줄이 거기 생긴다
    expect(sideTargets(items, 2).map((target) => `${target.index}:${target.agent ?? '-'}`)).toEqual(['0:-', '1:-', '2:-', '2:claude:agent:d1']);
  });
});

describe('사이드바 서브에이전트: 그림', () => {
  it('세션 줄 아래에 가지(├ └)·상태 표시·한국어 종류·지금 도구를 한 줄씩 보이고 끝난 것은 "끝남 N"이다', () => {
    const lines = text([busy, quiet], 0, 32);
    const at = lines.findIndex((line) => line.includes('주문 모듈'));
    expect(lines[at + 1]).toMatch(/^ {3}├ ◐ 탐색 결제 흐름 찾기/);
    expect(lines[at + 2]).toMatch(/^ {3}├ ◐ 범용 테스트 돌리기/);
    expect(lines[at + 3]).toMatch(/^ {3}└ 끝남 1$/);
    expect(lines[at + 4]).toContain('혼자 하는 일');
  });

  it('줄에 지금 쓰는 도구를 우리말로 보인다(자리가 있을 때)', () => {
    expect(text([busy], 0, 60).find((line) => line.includes('결제 흐름'))).toContain('찾기 order');
  });

  it('고른 서브에이전트 줄이 고른 줄이고 세션 줄은 아니다', () => {
    const picked = rows([busy, quiet], 0, 30, { agent: 'claude:agent:a2' });
    expect(picked.filter((row) => row.selected).map((row) => stripAnsi(row.text))).toEqual([expect.stringContaining('테스트 돌리기')]);
    const plain = rows([busy, quiet], 0, 30);
    expect(plain.filter((row) => row.selected).map((row) => stripAnsi(row.text))).toEqual([expect.stringContaining('주문 모듈')]);
    // 서브에이전트 줄은 그 세션의 번호와 자기 id를 갖는다(눌렀을 때 쓴다)
    expect(picked.find((row) => row.agent === 'claude:agent:a2')?.item).toBe(0);
  });

  it('고르지 않은 스페이스의 세션은 서브에이전트가 작업 중이어도 줄을 펴지 않는다', () => {
    expect(text([busy, other], 0).some((line) => line.includes('글 찾기'))).toBe(false);
    expect(text([busy, other], 1).some((line) => line.includes('글 찾기'))).toBe(true);
  });

  it('모든 줄의 폭이 사이드바 폭이다(넓은 글자·긴 이름·소식 없음 표시 포함)', () => {
    const wide = item('w', {
      title: '全角ＡＢＣ 요청 제목이 아주 길다',
      agents: [
        sub('w1', { type: '아주긴사용자정의종류이름', name: '아주긴사용자정의종류이름', description: '漢字와ＡＢ가 섞인 맡긴 일의 설명이 길다', tool: 'Grep 한글패턴😀😀', startedAt: ago(3 * 3600) }),
        sub('w2', { state: 'done', description: '끝난 일', result: '결과가 길다 '.repeat(8), startedAt: ago(7200), lastAt: ago(60) }),
        sub('w3', { state: 'idle', description: '대기' }),
        sub('w4', { lastAt: ago(20 * 60), description: '소식 없는 일' }),
      ],
    });
    for (const width of [12, 16, 20, 24, 32]) {
      for (const side of [{}, { fold: { open: ['w'] } }, { fold: { open: ['w'] }, agent: 'claude:agent:w2' }]) {
        for (const row of rows([wide, busy], 0, width, side)) expect(stringWidth(stripAnsi(row.text)), `${width}칸 ${stripAnsi(row.text)}`).toBe(width);
      }
    }
  });
});

describe('사이드바 서브에이전트: 키(앞글쇠 다음)', () => {
  const press = (start: DeskState, ...keys: string[]) => keys.reduce((result, key) => handleInput(result.state, key), { state: start, effects: [] as ReturnType<typeof handleInput>['effects'] });
  const start = (patch: Partial<DeskState> = {}): DeskState => ({ ...initialState(), items: [busy, quiet, other], ...patch });
  const DOWN = '\x1b[B';
  const UP = '\x1b[A';
  const RIGHT = '\x1b[C';
  const LEFT = '\x1b[D';

  it('↓가 세션 줄 아래 서브에이전트 줄을 차례로 지나 다음 세션으로 간다. ↑는 거꾸로다', () => {
    let result = press(start(), '\x02', DOWN);
    expect([result.state.selected, sideAgentOf(result.state)]).toEqual([0, 'claude:agent:a1']);
    result = press(result.state, DOWN);
    expect([result.state.selected, sideAgentOf(result.state)]).toEqual([0, 'claude:agent:a2']);
    result = press(result.state, DOWN);
    expect([result.state.selected, sideAgentOf(result.state)]).toEqual([1, undefined]);
    result = press(result.state, UP, UP);
    expect([result.state.selected, sideAgentOf(result.state)]).toEqual([0, 'claude:agent:a1']);
  });

  it('→는 세션의 서브에이전트를 모두 펴고, 한 번 더 누르면 첫 줄로 들어간다. ←는 줄에서 세션으로 나오고, 세션에서는 접는다', () => {
    let result = press(start(), '\x02', RIGHT);
    expect(result.state.sideOpen).toEqual(['a']);
    expect(sideAgentOf(result.state)).toBeUndefined();
    result = press(result.state, RIGHT);
    expect(sideAgentOf(result.state)).toBe('claude:agent:a1');
    result = press(result.state, LEFT);
    expect(sideAgentOf(result.state)).toBeUndefined();
    result = press(result.state, LEFT);
    expect(result.state.sideClosed).toEqual(['a']);
    expect(result.state.sideOpen).toEqual([]);
    // 접은 세션 아래로는 내려가지 않는다
    result = press(result.state, DOWN);
    expect(result.state.selected).toBe(1);
    // 다시 →면 편다
    result = press(result.state, UP, RIGHT);
    expect(result.state.sideClosed).toEqual([]);
    expect(result.state.sideOpen).toEqual(['a']);
  });

  it('서브에이전트가 없는 세션에서 →는 아무것도 펴지 않고 까닭을 알린다', () => {
    const result = press(start({ selected: 1 }), '\x02', RIGHT);
    expect(result.state.sideOpen).toBeUndefined();
    expect(result.state.message).toContain('서브에이전트가 없습니다');
  });

  it('서브에이전트 줄에서 Enter하면 그 활동 기록(깊이 2)으로 가고, 세션 줄의 Enter는 그대로 칸에 연다', () => {
    let result = press(start(), '\x02', DOWN, '\r');
    expect(result.effects).toContainEqual({ type: 'inside-open', id: 'a' });
    expect(result.state.inside).toMatchObject({ id: 'a', depth: 2, agent: 'claude:agent:a1' });
    expect(result.effects.some((effect) => effect.type === 'open')).toBe(false);
    result = press(start(), '\x02', '\r');
    expect(result.effects).toContainEqual({ type: 'open', slot: 0, id: 'a' });
    expect(result.state.inside).toBeUndefined();
  });

  it('고른 서브에이전트가 사라지면(끝나 줄이 접히면) 고른 줄은 세션으로 돌아간다', () => {
    const picked = press(start(), '\x02', DOWN).state;
    const gone = { ...picked, items: [{ ...busy, agents: [sub('a1', { state: 'done' })] }, quiet, other] };
    expect(sideAgentOf(gone)).toBeUndefined();
    // 그 상태의 Enter는 세션을 연다
    expect(handleInput({ ...gone, prefix: true }, '\r').effects).toContainEqual({ type: 'open', slot: 0, id: 'a' });
  });
});
