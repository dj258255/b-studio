/**
 * desk가 목록 통로(#923)를 쓰는 방식: 통로가 살아 있으면 1.5초 묻기를 쉬고, 끊기면 묻기로 돌아가며 다시 붙는다.
 * 옛 스튜디오(404)면 통로를 다시 열지 않고 묻기만 쓴다. 같은 목록이 오면 다시 그리지 않는다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError } from './client';
import { DeskApp, type DeskClient, type DeskIo } from './desk';
import type { DeskItem, DeskOverview } from './types';

const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-26T00:00:00Z', ...patch });

class FakeIo implements DeskIo {
  out: string[] = [];
  write(data: string) {
    this.out.push(data);
  }
  size() {
    return { cols: 140, rows: 40 };
  }
  onInput() {}
  onResize() {}
  setRaw() {}
}

class FakeClient implements DeskClient {
  agentsCalls = 0;
  opens: Array<{ push: (overview: DeskOverview) => void; end: (error?: Error) => void; signal: AbortSignal; ended: boolean }> = [];
  constructor(public items: DeskItem[]) {}
  async agents() {
    this.agentsCalls += 1;
    return { items: this.items };
  }
  agentsStream: ((onUpdate: (overview: DeskOverview) => void, signal: AbortSignal) => Promise<void>) | undefined = (onUpdate, signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => resolve());
      const open = {
        push: onUpdate,
        end: (error?: Error) => {
          open.ended = true;
          if (error) reject(error);
          else resolve();
        },
        signal,
        ended: false,
      };
      this.opens.push(open);
    });
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
  get live() {
    return this.opens.filter((open) => !open.signal.aborted && !open.ended);
  }
}

async function tick(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function setup(client: DeskClient & { items: DeskItem[] }) {
  const io = new FakeIo();
  const app = new DeskApp(client, client.items, io, {});
  const done = app.run();
  return { io, app, done };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('목록 통로(#923)', () => {
  it('통로가 살아 있으면 묻지 않고, 통로로 온 목록을 바로 쓴다', async () => {
    const client = new FakeClient([item('a')]);
    const ctx = setup(client);
    await tick();
    expect(client.live).toHaveLength(1);
    client.live[0]!.push({ items: [item('a', { state: 'working' })] });
    await tick();
    expect(ctx.app.state.items[0]!.state).toBe('working');
    const before = client.agentsCalls;
    await tick(6_000);
    expect(client.agentsCalls).toBe(before);
  });

  it('통로가 끊기면 묻기로 돌아가고, 잠시 뒤 다시 붙는다', async () => {
    const client = new FakeClient([item('a')]);
    setup(client);
    await tick();
    client.live[0]!.push({ items: [item('a')] });
    await tick();
    client.live[0]!.end(new Error('끊김'));
    await tick();
    const before = client.agentsCalls;
    await tick(1_600);
    expect(client.agentsCalls).toBeGreaterThan(before);
    await tick(2_000);
    expect(client.opens).toHaveLength(2);
    expect(client.live).toHaveLength(1);
  });

  it('옛 스튜디오(404)면 통로를 다시 열지 않고 묻기만 쓴다', async () => {
    const client = new FakeClient([item('a')]);
    setup(client);
    await tick();
    client.live[0]!.end(new StudioRequestError('없는 주소', 404));
    await tick(10_000);
    expect(client.opens).toHaveLength(1);
    expect(client.agentsCalls).toBeGreaterThan(3);
  });

  it('같은 목록이 오면 화면을 다시 그리지 않는다', async () => {
    const client = new FakeClient([item('a')]);
    const ctx = setup(client);
    await tick();
    client.live[0]!.push({ items: [item('a')] });
    await tick();
    const written = ctx.io.out.length;
    client.live[0]!.push({ items: [item('a')] });
    await tick();
    expect(ctx.io.out.length).toBe(written);
    client.live[0]!.push({ items: [item('a', { state: 'working' })] });
    await tick();
    expect(ctx.io.out.length).toBeGreaterThan(written);
  });

  it('통로가 없는 손님이면 지금처럼 묻는다', async () => {
    const client = new FakeClient([item('a')]);
    client.agentsStream = undefined;
    setup(client);
    await tick(3_100);
    expect(client.opens).toHaveLength(0);
    expect(client.agentsCalls).toBeGreaterThanOrEqual(2);
  });
});
