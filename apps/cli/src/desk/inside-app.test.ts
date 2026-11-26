/**
 * desk에 붙은 에이전트 안(#1411): 열려 있는 동안만 활동 기록을 주기적으로 받는다. 가짜 스튜디오로 간격·멈춤·겹침·실패를 본다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError } from './client';
import { DeskApp, INSIDE_POLL_MS, type DeskClient, type DeskIo } from './desk';
import { stripAnsi } from './screen';
import type { ActivityLogView, DeskItem } from './types';

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

function screenText(io: FakeIo): string {
  const rows: string[] = [];
  for (const chunk of io.out) {
    for (const match of chunk.matchAll(/\x1b\[(\d+);1H([^\x1b]*(?:\x1b(?!\[\d+;1H)[^\x1b]*)*)/g)) rows[Number(match[1]) - 1] = stripAnsi(match[2]!);
  }
  return rows.join('\n');
}

const DATA: ActivityLogView = { agents: [{ id: 'main', main: true, entries: [{ at: '2026-10-23T00:00:00Z', tool: 'Edit', kind: 'edit', state: 'done', target: 'a.ts', changes: [{ file: 'a.ts', removed: 'x', added: 'y' }] }] }] };

class FakeClient implements DeskClient {
  activityCalls: string[] = [];
  pending: Array<(value: ActivityLogView) => void> = [];
  failWith: Error | undefined;
  hold = false;
  constructor(readonly items: DeskItem[]) {}
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
  async open() {}
  async resize() {}
  async input() {}
  async stop() {}
  async resume() {}
  async rename() {}
  stream(_ids: readonly string[], _on: unknown, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
  }
  agentActivity(id: string): Promise<ActivityLogView> {
    this.activityCalls.push(id);
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.hold) return new Promise((resolve) => this.pending.push(resolve));
    return Promise.resolve(DATA);
  }
}

function setup(options: { oldStudio?: boolean } = {}) {
  const items = [item('a', { title: '주문 모듈' }), item('b')];
  const client = new FakeClient(items);
  if (options.oldStudio) Object.assign(client, { agentActivity: undefined });
  const io = new FakeIo();
  const app = new DeskApp(client, items, io, {});
  const done = app.run();
  return { client, io, app, done };
}

const tick = (ms = 50) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('에이전트 안 자료 받기(#1411)', () => {
  it('열면 바로 받고, 열려 있는 동안 INSIDE_POLL_MS마다 다시 받는다', async () => {
    const ctx = setup();
    ctx.io.type('s');
    await tick();
    expect(ctx.client.activityCalls).toEqual(['a']);
    expect(screenText(ctx.io)).toContain('에이전트 안');
    expect(screenText(ctx.io)).toContain('a.ts');
    await tick(INSIDE_POLL_MS);
    expect(ctx.client.activityCalls).toHaveLength(2);
    await tick(INSIDE_POLL_MS);
    expect(ctx.client.activityCalls).toHaveLength(3);
  });

  it('닫으면 더 받지 않는다', async () => {
    const ctx = setup();
    await tick();
    const idle = vi.getTimerCount();
    ctx.io.type('s');
    await tick();
    expect(vi.getTimerCount()).toBeGreaterThan(idle);
    ctx.io.type('s');
    await tick();
    expect(ctx.app.state.inside).toBeUndefined();
    const before = ctx.client.activityCalls.length;
    await tick(INSIDE_POLL_MS * 5);
    expect(ctx.client.activityCalls).toHaveLength(before);
    // 받기 타이머도 남지 않는다
    expect(vi.getTimerCount()).toBeLessThanOrEqual(idle);
  });

  it('앞 요청이 끝나기 전에는 새 요청을 보내지 않는다', async () => {
    const ctx = setup();
    ctx.client.hold = true;
    ctx.io.type('s');
    await tick(INSIDE_POLL_MS * 4);
    expect(ctx.client.activityCalls).toHaveLength(1);
    ctx.client.pending.shift()!(DATA);
    await tick();
    await tick(INSIDE_POLL_MS);
    expect(ctx.client.activityCalls).toHaveLength(2);
  });

  it('받기에 실패하면 마지막 자료를 두고 아래에 한 줄 알린다. 다시 받으면 알림이 사라진다', async () => {
    const ctx = setup();
    ctx.io.type('s');
    await tick();
    ctx.client.failWith = new StudioRequestError('권한이 없습니다', 403);
    await tick(INSIDE_POLL_MS);
    expect(screenText(ctx.io)).toContain('활동 기록을 받지 못했습니다: 권한이 없습니다');
    expect(screenText(ctx.io)).toContain('a.ts');
    ctx.client.failWith = undefined;
    await tick(INSIDE_POLL_MS);
    expect(screenText(ctx.io)).not.toContain('활동 기록을 받지 못했습니다');
  });

  it('옛 스튜디오(404)여도 화면이 깨지지 않고 까닭을 적는다', async () => {
    const ctx = setup();
    ctx.client.failWith = new StudioRequestError('Not Found', 404);
    ctx.io.type('s');
    await tick();
    expect(screenText(ctx.io)).toContain('이 스튜디오는 활동 기록을 보내지 않습니다');
    const old = setup({ oldStudio: true });
    old.io.type('s');
    await tick();
    expect(screenText(old.io)).toContain('이 스튜디오는 활동 기록을 보내지 않습니다');
  });

  it('메인 카드에서 Enter하면 이 화면을 닫고 받기를 멈춘다', async () => {
    const ctx = setup();
    ctx.io.type('s');
    await tick();
    ctx.io.type('\r');
    await tick();
    expect(ctx.app.state.inside).toBeUndefined();
    expect(ctx.app.state.slots[ctx.app.state.focus]).toBe('a');
    const before = ctx.client.activityCalls.length;
    await tick(INSIDE_POLL_MS * 4);
    expect(ctx.client.activityCalls).toHaveLength(before);
  });
});
