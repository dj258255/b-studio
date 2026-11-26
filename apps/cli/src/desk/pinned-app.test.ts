/**
 * desk에 붙은 활동 기록 칸(#1411): 고정한 칸이 있는 세션은 활동 기록을 INSIDE_POLL_MS마다 받는다.
 * 에이전트 안 화면과 고정한 칸이 같은 세션을 보면 요청은 하나다. 칸을 닫으면 멈춘다. 입력은 터미널로 가지 않고 배치에 저장하지 않는다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError } from './client';
import { DeskApp, INSIDE_POLL_MS, type DeskClient, type DeskIo } from './desk';
import type { DeskLayout } from './config';
import { pinId } from './pinned';
import { stripAnsi } from './screen';
import type { ActivityLogView, DeskAgent, DeskItem } from './types';

const usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const sub = (id: string, description: string): DeskAgent => ({ id: `claude:agent:${id}`, name: 'Explore', type: 'Explore', kind: 'subagent', state: 'working', description, tokens: usage });
const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z', ...patch });

class FakeIo implements DeskIo {
  out: string[] = [];
  #input: (chunk: string) => void = () => {};
  write(data: string) {
    this.out.push(data);
  }
  size() {
    return { cols: 120, rows: 40 };
  }
  onInput(listener: (chunk: string) => void) {
    this.#input = listener;
  }
  onResize() {}
  setRaw() {}
  type(chunk: string) {
    this.#input(chunk);
  }
}

/** 지금 화면(마지막으로 그린 줄들) */
function screenText(io: FakeIo): string {
  const rows: string[] = [];
  for (const chunk of io.out) {
    for (const match of chunk.matchAll(/\x1b\[(\d+);1H([^\x1b]*(?:\x1b(?!\[\d+;1H)[^\x1b]*)*)/g)) rows[Number(match[1]) - 1] = stripAnsi(match[2]!);
  }
  return rows.join('\n');
}

const logs = (marker: string, ids: string[]): ActivityLogView => ({
  agents: [
    { id: 'main', main: true, entries: [{ at: '2026-10-23T00:00:00Z', tool: 'Read', kind: 'read', state: 'done', target: `main-${marker}.ts` }] },
    ...ids.map((id) => ({ id, type: 'Explore', description: `일 ${id}`, state: 'working' as const, entries: [{ at: '2026-10-23T00:00:01Z', tool: 'Grep', kind: 'search' as const, state: 'done' as const, target: `${id}-${marker}` }] })),
  ],
});

class FakeClient implements DeskClient {
  activityCalls: string[] = [];
  inputs: Array<[string, string]> = [];
  opened: string[] = [];
  streamed: string[] = [];
  reply: (id: string) => ActivityLogView = () => logs('v1', ['x1', 'x2']);
  failWith: Error | undefined;
  constructor(public items: DeskItem[]) {}
  async agents() {
    return { items: this.items };
  }
  async projects() {
    return [];
  }
  async accounts() {
    return [];
  }
  async rules() {
    return { allowed: ['claude-code'], defaultBackend: 'claude-code' };
  }
  async preview() {
    return { backend: 'claude-code', rule: 'default' as const, matched: '' };
  }
  async start(): Promise<never> {
    throw new Error('쓰지 않는다');
  }
  async open(id: string) {
    this.opened.push(id);
  }
  async resize() {}
  async input(id: string, data: string) {
    this.inputs.push([id, data]);
  }
  async stop() {}
  async resume() {}
  async rename() {}
  stream(ids: readonly string[], _on: unknown, signal: AbortSignal): Promise<void> {
    this.streamed.push(...ids);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
  }
  agentActivity(id: string): Promise<ActivityLogView> {
    this.activityCalls.push(id);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.reply(id));
  }
}

function setup(options: { items?: DeskItem[]; layout?: DeskLayout; saved?: DeskLayout[] } = {}) {
  const items = options.items ?? [item('a', { title: '주문 모듈', agents: [sub('x1', '결제 찾기'), sub('x2', '테스트 돌리기')] }), item('b', { title: '다른 일' })];
  const client = new FakeClient(items);
  const io = new FakeIo();
  const saved = options.saved ?? [];
  const app = new DeskApp(client, items, io, { layoutStore: { load: () => options.layout, save: (layout) => void saved.push(layout) } });
  const done = app.run();
  return { client, io, app, done, saved };
}

const tick = (ms = 50) => vi.advanceTimersByTimeAsync(ms);
const countOf = (client: FakeClient, id: string) => client.activityCalls.filter((call) => call === id).length;

/** a 세션 터미널을 1번 칸에 열고, 카드 화면에서 에이전트 안으로 들어가 x1 카드를 골라 p로 고정한다 */
async function pinX1(ctx: ReturnType<typeof setup>) {
  ctx.io.type('\x02\r');
  await tick();
  ctx.io.type('\x02w');
  await tick();
  ctx.io.type('s');
  await tick();
  ctx.io.type('\x1b[C');
  ctx.io.type('p');
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('활동 기록 칸 자료 받기(#1411)', () => {
  it('에이전트 안 화면과 고정한 칸이 같은 세션을 보면 요청은 간격마다 하나다(두 벌 나가지 않는다)', async () => {
    const ctx = setup();
    await pinX1(ctx);
    expect(ctx.app.state.slots[1]).toBe(pinId('a', 'x1'));
    expect(ctx.app.state.inside).toBeDefined();
    const before = countOf(ctx.client, 'a');
    await tick(INSIDE_POLL_MS);
    expect(countOf(ctx.client, 'a')).toBe(before + 1);
    await tick(INSIDE_POLL_MS);
    expect(countOf(ctx.client, 'a')).toBe(before + 2);
  });

  it('활동 기록 칸에는 터미널을 열거나 출력 통로를 만들지 않는다', async () => {
    const ctx = setup();
    await pinX1(ctx);
    ctx.io.type('\x1b');
    await tick(INSIDE_POLL_MS);
    expect(ctx.client.opened).toEqual(['a']);
    expect(ctx.client.streamed).toEqual(['a']);
  });

  it('에이전트 안 화면을 닫아도 고정한 칸이 있으면 계속 받고, 칸 화면에 그 기록이 보인다', async () => {
    const ctx = setup();
    await pinX1(ctx);
    ctx.io.type('\x1b'); // 깊이 1에서 Esc: 에이전트 안 닫기
    await tick();
    expect(ctx.app.state.inside).toBeUndefined();
    const before = countOf(ctx.client, 'a');
    ctx.client.reply = () => logs('v2', ['x1', 'x2']);
    await tick(INSIDE_POLL_MS);
    expect(countOf(ctx.client, 'a')).toBe(before + 1);
    const text = screenText(ctx.io);
    expect(text).toContain('x1-v2');
    expect(text).not.toContain('x2-v2');
    expect(text).toContain('활동 기록 · 탐색 결제 찾기');
  });

  it('서로 다른 세션이면 세션마다 하나씩 받는다', async () => {
    const items = [item('a', { agents: [sub('x1', '결제 찾기')] }), item('b', { agents: [sub('y1', '다른 탐색')] })];
    const ctx = setup({ items });
    await pinX1(ctx);
    ctx.io.type('\x1b');
    await tick();
    // b 세션의 에이전트 안을 연다(사이드바에서 b를 고르고 카드 화면의 s)
    // 사이드바: a 세션 줄 → 그 아래 서브에이전트 줄 → b 세션 줄
    ctx.io.type('\x02\x1b[B');
    ctx.io.type('\x1b[B');
    ctx.io.type('\x02w');
    ctx.io.type('s');
    await tick();
    expect(ctx.app.state.inside?.id).toBe('b');
    const a = countOf(ctx.client, 'a');
    const b = countOf(ctx.client, 'b');
    await tick(INSIDE_POLL_MS);
    expect(countOf(ctx.client, 'a')).toBe(a + 1);
    expect(countOf(ctx.client, 'b')).toBe(b + 1);
  });

  it('칸을 닫으면 받기를 멈추고 시계도 남지 않는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02\r');
    await tick();
    const idle = vi.getTimerCount();
    ctx.io.type('\x02w');
    ctx.io.type('s');
    await tick();
    ctx.io.type('\x1b[C');
    ctx.io.type('p');
    ctx.io.type('\x1b');
    ctx.io.type('\x1b');
    await tick();
    expect(ctx.app.state.inside).toBeUndefined();
    expect(ctx.app.state.view).toBeUndefined();
    // 활동 기록 칸(2번)을 고르고 비운다
    ctx.io.type('\x022');
    ctx.io.type('\x02x');
    await tick();
    expect(ctx.app.state.slots[1]).toBeUndefined();
    expect(ctx.app.state.pins).toBeUndefined();
    const before = ctx.client.activityCalls.length;
    await tick(INSIDE_POLL_MS * 5);
    expect(ctx.client.activityCalls).toHaveLength(before);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(idle);
  });

  it('앞 요청이 끝나기 전에는 같은 세션에 새 요청을 보내지 않는다', async () => {
    const ctx = setup();
    const pending: Array<(value: ActivityLogView) => void> = [];
    ctx.client.agentActivity = (id: string) => {
      ctx.client.activityCalls.push(id);
      return new Promise((resolve) => pending.push(resolve));
    };
    await pinX1(ctx);
    await tick(INSIDE_POLL_MS * 4);
    expect(countOf(ctx.client, 'a')).toBe(1);
    pending.shift()!(logs('v1', ['x1']));
    await tick();
    await tick(INSIDE_POLL_MS);
    expect(countOf(ctx.client, 'a')).toBe(2);
  });

  it('받기에 실패하면 마지막 기록을 두고 칸 아래에 한 줄 알린다. 다시 받으면 사라진다', async () => {
    const ctx = setup();
    await pinX1(ctx);
    ctx.io.type('\x1b');
    await tick();
    ctx.client.failWith = new StudioRequestError('권한이 없습니다', 403);
    await tick(INSIDE_POLL_MS);
    const text = screenText(ctx.io);
    expect(text).toContain('x1-v1');
    expect(text).toContain('활동 기록을 받지 못했습니다');
    ctx.client.failWith = undefined;
    await tick(INSIDE_POLL_MS);
    expect(screenText(ctx.io)).not.toContain('활동 기록을 받지 못했습니다');
  });

  it('서브에이전트가 끝나 서버에서 사라지면 마지막 기록을 두고 알린다', async () => {
    const ctx = setup();
    await pinX1(ctx);
    ctx.io.type('\x1b');
    await tick();
    ctx.client.reply = () => logs('v3', ['x2']);
    await tick(INSIDE_POLL_MS);
    const text = screenText(ctx.io);
    expect(text).toContain('x1-v1');
    // 칸이 좁아 알림이 줄을 나눠 적힌다
    expect(text.replace(/\s/g, '')).toContain('끝난서브에이전트입니다(마지막으로받은');
  });

  it('세션이 멈추면 까닭을 적고 칸을 자동으로 닫지 않는다', async () => {
    const ctx = setup();
    await pinX1(ctx);
    ctx.io.type('\x1b');
    await tick();
    ctx.client.items = [item('a', { title: '주문 모듈', state: 'stopped', agents: [sub('x1', '결제 찾기')] }), item('b')];
    await tick(INSIDE_POLL_MS * 2);
    expect(screenText(ctx.io).replace(/\s/g, '')).toContain('세션이멈췄습니다');
    expect(ctx.app.state.slots[1]).toBe(pinId('a', 'x1'));
  });

  it('옛 스튜디오는 칸에 까닭을 적는다', async () => {
    const ctx = setup();
    Object.assign(ctx.client, { agentActivity: undefined });
    ctx.io.type('\x02\r');
    ctx.io.type('\x02w');
    ctx.io.type('s');
    await tick();
    ctx.io.type('\x1b[C');
    ctx.io.type('p');
    ctx.io.type('\x1b');
    ctx.io.type('\x1b');
    await tick();
    expect(screenText(ctx.io).replace(/\s/g, '')).toContain('이스튜디오는활동기록을보내지않습니다');
  });
});

describe('활동 기록 칸의 입력과 배치 저장(#1411)', () => {
  it('고른 활동 기록 칸에 친 글자와 붙여넣기는 어떤 세션 터미널로도 가지 않는다', async () => {
    const ctx = setup();
    await pinX1(ctx);
    ctx.io.type('\x1b');
    ctx.io.type('\x1b');
    await tick();
    ctx.io.type('\x022');
    await tick();
    expect(ctx.app.state.focus).toBe(1);
    const before = ctx.client.inputs.length;
    ctx.io.type('hello\r');
    ctx.io.type('\x1b[200~붙여넣기\x1b[201~');
    ctx.io.type('\x02\x02');
    await tick();
    expect(ctx.client.inputs).toHaveLength(before);
    // 1번 칸으로 돌아가면 그 칸의 터미널로 간다
    ctx.io.type('\x021');
    ctx.io.type('x');
    await tick();
    expect(ctx.client.inputs.at(-1)).toEqual(['a', 'x']);
  });

  it('활동 기록 칸은 배치에 저장하지 않고, 저장한 배치에 있어도 되살리지 않아도 깨지지 않는다', async () => {
    const saved: DeskLayout[] = [];
    const ctx = setup({ saved });
    await pinX1(ctx);
    expect(saved.at(-1)!.slots.some((id) => id?.startsWith('pin:'))).toBe(false);
    expect(saved.at(-1)!.slots[0]).toBe('a');
    ctx.io.type('\x02q');
    await ctx.done;
    // 되살릴 때: 다른 값이 섞여 있어도 터미널을 열지 않고 칸은 비어 있다
    const restored = setup({ layout: { layout: 2, slots: ['a', pinId('a', 'x1'), undefined, undefined], focus: 0, zoom: false, sidebarHidden: false } });
    await tick();
    expect(restored.app.state.slots[1]).toBeUndefined();
    expect(restored.client.activityCalls).toHaveLength(0);
    expect(screenText(restored.io)).not.toContain('pin:');
  });
});
