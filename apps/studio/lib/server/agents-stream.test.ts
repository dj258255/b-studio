import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentItem, AgentTotals } from './agents-overview';
import { createAgentsFeed, diffOverview, type AgentsStreamMessage } from './agents-stream';
import { notifyAgentsChanged, onAgentsChanged, pulseAfterCalls } from './agents-pulse';

const item = (id: string, patch: Partial<AgentItem> = {}): AgentItem =>
  ({ kind: 'session', id, href: `/sessions/${id}`, title: `요청 ${id}`, projectName: 'shop', state: 'idle', lastActivityAt: '2026-10-26T00:00:00Z', ...patch }) as AgentItem;

const totals = (total: number): AgentTotals => ({ total, attention: 0, working: 0, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });

describe('diffOverview(#923)', () => {
  it('바뀐 항목만, 사라진 id, 순서를 보낸다', () => {
    const prev = { items: [item('a'), item('b'), item('c')], totals: totals(3) };
    const next = { items: [item('b', { state: 'working' }), item('a'), item('d')], totals: totals(3) };
    expect(diffOverview(prev, next)).toEqual({ type: 'delta', items: [item('b', { state: 'working' }), item('d')], removed: ['c'], order: ['b', 'a', 'd'] });
  });

  it('하나도 바뀌지 않았으면 보내지 않는다', () => {
    const prev = { items: [item('a')], totals: totals(1) };
    expect(diffOverview(prev, { items: [item('a')], totals: totals(1) })).toBeUndefined();
  });

  it('합계만 바뀌면 합계만 싣는다', () => {
    const prev = { items: [item('a')], totals: totals(1) };
    expect(diffOverview(prev, { items: [item('a')], totals: totals(2) })).toEqual({ type: 'delta', items: [], removed: [], order: ['a'], totals: totals(2) });
  });
});

describe('createAgentsFeed(#923)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function feed(overviews: Array<{ items: AgentItem[]; totals: AgentTotals }>) {
    const sent: AgentsStreamMessage[] = [];
    let listener: () => void = () => {};
    let unsubscribed = false;
    let calls = 0;
    const current = { value: overviews[0]! };
    const handle = createAgentsFeed({
      compute: async () => {
        calls += 1;
        return current.value;
      },
      onChange: (next) => {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
      send: (message) => sent.push(message),
      debounceMs: 100,
      refreshMs: 5_000,
    });
    return { handle, sent, current, change: () => listener(), calls: () => calls, unsubscribed: () => unsubscribed };
  }

  it('처음에 전체를 보내고, 바뀌었다는 신호가 오면 묶어서 한 번 다시 계산해 바뀐 것만 보낸다', async () => {
    const ctx = feed([{ items: [item('a')], totals: totals(1) }]);
    await ctx.handle.start();
    expect(ctx.sent).toEqual([{ type: 'full', items: [item('a')], totals: totals(1) }]);
    ctx.current.value = { items: [item('a', { state: 'working' })], totals: totals(1) };
    ctx.change();
    ctx.change();
    ctx.change();
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.calls()).toBe(2);
    expect(ctx.sent.at(-1)).toEqual({ type: 'delta', items: [item('a', { state: 'working' })], removed: [], order: ['a'] });
  });

  it('신호가 없어도 일정 간격으로 다시 보고, 같으면 아무것도 보내지 않는다', async () => {
    const ctx = feed([{ items: [item('a')], totals: totals(1) }]);
    await ctx.handle.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.calls()).toBe(2);
    expect(ctx.sent).toHaveLength(1);
  });

  it('멈추면 구독을 풀고 더는 계산하지 않는다', async () => {
    const ctx = feed([{ items: [item('a')], totals: totals(1) }]);
    await ctx.handle.start();
    ctx.handle.stop();
    expect(ctx.unsubscribed()).toBe(true);
    ctx.change();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.calls()).toBe(1);
  });

  it('계산이 실패하면 그 차례만 건너뛰고 다음 신호에서 다시 본다', async () => {
    const sent: AgentsStreamMessage[] = [];
    let fail = false;
    let listener: () => void = () => {};
    let value = { items: [item('a')], totals: totals(1) };
    const handle = createAgentsFeed({
      compute: async () => {
        if (fail) throw new Error('읽지 못함');
        return value;
      },
      onChange: (next) => {
        listener = next;
        return () => {};
      },
      send: (message) => sent.push(message),
      debounceMs: 10,
      refreshMs: 60_000,
    });
    await handle.start();
    fail = true;
    listener();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(1);
    fail = false;
    value = { items: [item('b')], totals: totals(1) };
    listener();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.at(-1)).toEqual({ type: 'delta', items: [item('b')], removed: ['a'], order: ['b'] });
    handle.stop();
  });
});

describe('agents-pulse(#923)', () => {
  it('바뀜 알림을 구독자에게 전하고, 풀면 더는 전하지 않는다', () => {
    const seen: number[] = [];
    const off = onAgentsChanged(() => seen.push(1));
    notifyAgentsChanged();
    off();
    notifyAgentsChanged();
    expect(seen).toEqual([1]);
  });

  it('한 구독자가 던져도 다른 구독자에게 전한다', () => {
    const seen: string[] = [];
    const offA = onAgentsChanged(() => {
      throw new Error('깨짐');
    });
    const offB = onAgentsChanged(() => seen.push('b'));
    expect(() => notifyAgentsChanged()).not.toThrow();
    expect(seen).toEqual(['b']);
    offA();
    offB();
  });
});

describe('pulseAfterCalls(#923)', () => {
  it('부른 뒤(비동기면 끝난 뒤, 실패해도) 알리고 결과는 그대로 돌려준다. 뺀 이름은 알리지 않는다', async () => {
    let count = 0;
    const off = onAgentsChanged(() => {
      count += 1;
    });
    let resolve: () => void = () => {};
    const handlers = pulseAfterCalls({
      sync: (value: number) => value + 1,
      later: () => new Promise<string>((done) => (resolve = () => done('끝'))),
      broken: () => {
        throw new Error('깨짐');
      },
      toolSpecs: () => [],
    });
    expect(handlers.sync(1)).toBe(2);
    expect(count).toBe(1);
    const pending = handlers.later();
    expect(count).toBe(1);
    resolve();
    await expect(pending).resolves.toBe('끝');
    expect(count).toBe(2);
    expect(() => handlers.broken()).toThrow('깨짐');
    expect(count).toBe(3);
    handlers.toolSpecs();
    expect(count).toBe(3);
    off();
  });
});
