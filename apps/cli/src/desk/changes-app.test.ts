/**
 * desk에 붙은 지금 변경 화면(#924): Ctrl-b d로 열고, 스튜디오의 지금 변경 API·의견 저장·세션 터미널과 주고받는 것을 가짜로 본다.
 * S로 묶은 의견은 화면을 닫고 그 세션의 칸 입력에 넣는다. 보내기(Enter)는 사람이 한다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskComment, LiveChangesView } from './changes';
import { DeskApp, type DeskClient, type DeskCommentStore, type DeskIo } from './desk';
import { stripAnsi } from './screen';
import type { DeskItem } from './types';

const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z', ...patch });

class FakeIo implements DeskIo {
  out: string[] = [];
  #input: (chunk: string) => void = () => {};
  write(data: string) {
    this.out.push(data);
  }
  size() {
    return { cols: 120, rows: 30 };
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

const CHANGES: LiveChangesView = {
  files: [
    {
      file: 'api/Order.java',
      change: 'modified',
      patch: '--- a/api/Order.java\n+++ b/api/Order.java\n@@ -1,2 +1,2 @@\n class Order {\n-  int sum;\n+  int total;\n',
      added: 1,
      removed: 1,
    },
  ],
  truncated: false,
  head: 'abc1234',
};

class FakeClient implements DeskClient {
  calls: string[] = [];
  inputs: Array<{ id: string; data: string }> = [];
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
  async open(id: string) {
    this.calls.push(`open ${id}`);
  }
  async resize() {}
  async input(id: string, data: string) {
    this.inputs.push({ id, data });
  }
  async stop() {}
  async resume() {}
  async rename() {}
  stream(_ids: readonly string[], _on: unknown, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
  }
  async liveChanges(id: string) {
    this.calls.push(`changes ${id}`);
    return CHANGES;
  }
}

function memoryStore(initial: Record<string, DeskComment[]> = {}): DeskCommentStore & { saved: Record<string, DeskComment[]> } {
  const saved: Record<string, DeskComment[]> = { ...initial };
  return { saved, load: (id) => [...(saved[id] ?? [])], save: (id, comments) => void (saved[id] = [...comments]) };
}

function setup(options: { oldStudio?: boolean; items?: DeskItem[]; comments?: Record<string, DeskComment[]> } = {}) {
  const items = options.items ?? [item('a', { title: '주문 모듈' }), item('b')];
  const client = new FakeClient(items);
  // 옛 손님: 지금 변경 API를 모른다
  if (options.oldStudio) Object.assign(client, { liveChanges: undefined });
  const io = new FakeIo();
  const commentStore = memoryStore(options.comments);
  const app = new DeskApp(client, items, io, { commentStore });
  const done = app.run();
  return { client, io, app, done, commentStore };
}

async function tick(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('지금 변경 화면(#924)', () => {
  it('Ctrl-b d는 고른 세션의 지금 변경을 받아 보이고, 친 글자는 칸으로 보내지 않는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02d');
    await tick();
    expect(ctx.client.calls).toContain('changes a');
    expect(ctx.app.state.changes?.id).toBe('a');
    expect(screenText(ctx.io)).toContain('지금 변경 · 주문 모듈');
    expect(screenText(ctx.io)).toContain('api/Order.java');
    ctx.io.type('jk');
    await tick();
    expect(ctx.client.inputs).toEqual([]);
    ctx.io.type('\x02d');
    await tick();
    expect(ctx.app.state.changes).toBeUndefined();
  });

  it('남겨 둔 의견을 읽어 오고, 새 의견은 저장한다', async () => {
    const old: DeskComment = { id: 'c0', file: 'api/Order.java', line: 2, side: 'old', code: '  int sum;', text: '예전 의견', createdAt: '2026-10-25T00:00:00Z' };
    const ctx = setup({ comments: { a: [old] } });
    ctx.io.type('\x02d');
    await tick();
    expect(ctx.app.state.changes?.comments).toEqual([old]);
    ctx.io.type('\r');
    ctx.io.type('\x1b[B');
    ctx.io.type('\x1b[B');
    ctx.io.type('\x1b[B');
    ctx.io.type('c');
    ctx.io.type('이름을 amount로');
    ctx.io.type('\r');
    await tick();
    expect(ctx.commentStore.saved.a).toHaveLength(2);
    expect(ctx.commentStore.saved.a![1]).toMatchObject({ file: 'api/Order.java', line: 2, side: 'new', text: '이름을 amount로' });
  });

  it('S는 화면을 닫고 세션을 칸에 연 뒤 묶은 의견을 줄바꿈으로 보내지 않고 넣는다', async () => {
    const open: DeskComment = { id: 'c1', file: 'api/Order.java', line: 2, side: 'new', code: '  int total;', text: '이름을 amount로', createdAt: '2026-10-25T00:00:00Z' };
    const ctx = setup({ comments: { a: [open] } });
    ctx.io.type('\x02d');
    await tick();
    ctx.io.type('S');
    await tick(4_000);
    expect(ctx.app.state.changes).toBeUndefined();
    expect(ctx.app.state.slots[ctx.app.state.focus]).toBe('a');
    expect(ctx.client.calls).toContain('open a');
    const sent = ctx.client.inputs.filter((entry) => entry.id === 'a').map((entry) => entry.data).join('');
    expect(sent).toContain('api/Order.java:2');
    expect(sent).toContain('이름을 amount로');
    expect(sent).not.toMatch(/\r/);
    expect(ctx.app.state.message).toContain('Enter');
    // 보낸 의견은 해결 표시 전까지 남는다
    expect(ctx.commentStore.saved.a![0]!.sentAt).toBeDefined();
    expect(ctx.commentStore.saved.a![0]!.resolved).toBeUndefined();
  });

  it('앞글쇠 다음 다른 화면 키는 지금 변경을 닫고 그 화면으로 간다', async () => {
    const ctx = setup();
    // 칸이 비어 있으면 스페이스 화면으로 시작한다. 거기서는 d만으로 연다
    expect(ctx.app.state.view).toBe('space');
    ctx.io.type('d');
    await tick();
    expect(ctx.app.state.changes?.id).toBe('a');
    ctx.io.type('\x02u');
    await tick();
    expect(ctx.app.state.changes).toBeUndefined();
    expect(ctx.app.state.view).toBe('usage');
  });

  it('옛 스튜디오면 받을 수 없다고 화면에 알린다', async () => {
    const ctx = setup({ oldStudio: true });
    ctx.io.type('\x02d');
    await tick();
    expect(ctx.app.state.changes?.error).toContain('지원하지 않습니다');
    expect(screenText(ctx.io)).toContain('지금 변경을 받지 못했습니다');
  });

  it('세션이 없으면 열지 않는다', async () => {
    const ctx = setup({ items: [] });
    ctx.io.type('\x02d');
    await tick();
    expect(ctx.app.state.changes).toBeUndefined();
    expect(ctx.app.state.message).toContain('지금 변경');
  });
});
