/**
 * desk에 붙은 폴더 열기(#916): Ctrl-b a로 열고, 스튜디오의 폴더 목록·폴더 열기 API와 주고받는 것을 가짜로 본다.
 * 등록하면 그 프로젝트로 새 요청이 이어 열린다. 프로젝트가 없으면 새 요청(Ctrl-b n)이 폴더 열기로 간다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskApp, type DeskClient, type DeskIo } from './desk';
import type { FolderListingView, FolderProposalView } from './folder';
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
    return { cols: 140, rows: 40 };
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

const listings: Record<string, FolderListingView> = {
  '': {
    path: '/Users/me',
    parent: '/Users',
    children: [
      { name: 'blog', path: '/Users/me/blog', hasChildren: true, hints: ['git'] },
      { name: 'shop', path: '/Users/me/shop', hasChildren: true, hints: ['git', 'nextjs'] },
    ],
    truncated: false,
    totalCount: 2,
  },
  '/Users/me/shop': { path: '/Users/me/shop', parent: '/Users/me', children: [{ name: 'web', path: '/Users/me/shop/web', hasChildren: true, hints: ['nextjs'] }], truncated: false, totalCount: 1 },
};

const proposal: FolderProposalView = {
  detection: { folder: '/Users/me/shop', name: 'shop', hasSpec: false, services: [{ name: 'web', template: 'nextjs', path: 'web', port: 3000 }], infra: [], defaultInfra: [], warnings: [] },
  files: [{ path: 'studio.yaml' }],
};

class FakeClient implements DeskClient {
  calls: string[] = [];
  projectList: Array<{ id: string; name: string }> = [];
  constructor(readonly items: DeskItem[]) {}
  async agents() {
    return { items: this.items };
  }
  async projects() {
    this.calls.push('projects');
    return this.projectList;
  }
  async accounts() {
    return [];
  }
  async rules() {
    return { allowed: ['claude-code', 'codex'], defaultBackend: 'claude-code' };
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
  async folders(folder: string) {
    this.calls.push(`folders ${folder}`);
    const listing = listings[folder];
    if (!listing) throw new Error(`폴더를 찾을 수 없습니다: ${folder}`);
    return listing;
  }
  async proposeFolder(folder: string) {
    this.calls.push(`propose ${folder}`);
    return proposal;
  }
  async registerFolder(folder: string) {
    this.calls.push(`register ${folder}`);
    this.projectList = [...this.projectList, { id: 'shop', name: 'shop' }];
    return { id: 'shop', created: true, written: ['studio.yaml'], excluded: true };
  }
}

function setup(items: DeskItem[] = [item('a')], client = new FakeClient(items)) {
  const io = new FakeIo();
  const app = new DeskApp(client, items, io, {});
  const done = app.run();
  return { client, io, app, done };
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

describe('폴더 열기(#916)', () => {
  it('Ctrl-b a로 열면 홈 목록을 받고, Tab으로 채우고, Enter로 살피고, y로 등록한 뒤 그 프로젝트로 새 요청을 연다', async () => {
    const ctx = setup();
    ctx.io.type('\x02a');
    await tick();
    expect(ctx.client.calls).toContain('folders ');
    expect(screenText(ctx.io)).toContain('/Users/me');
    expect(screenText(ctx.io)).toContain('shop/');
    ctx.io.type('sh\t');
    await tick();
    expect(ctx.app.state.folder?.text).toBe('/Users/me/shop/');
    expect(ctx.client.calls).toContain('folders /Users/me/shop');
    expect(screenText(ctx.io)).toContain('web/');
    ctx.io.type('\r');
    await tick();
    expect(ctx.client.calls).toContain('propose /Users/me/shop');
    expect(screenText(ctx.io)).toContain('studio.yaml');
    ctx.io.type('y');
    await tick();
    expect(ctx.client.calls).toContain('register /Users/me/shop');
    expect(ctx.app.state.folder).toBeUndefined();
    expect(ctx.app.state.prompt).toMatchObject({ step: 'request', projects: [{ id: 'shop', name: 'shop' }], projectIndex: 0 });
    expect(ctx.app.state.message).toContain('‹shop›을 프로젝트로 등록했습니다');
  });

  it('없는 폴더를 쓰면 까닭을 보이고, 고쳐 쓰면 다시 받는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02a');
    await tick();
    ctx.io.type('nope/');
    await tick();
    expect(screenText(ctx.io)).toContain('폴더를 찾을 수 없습니다');
  });

  it('프로젝트가 하나도 없으면 새 요청(Ctrl-b n)이 폴더 열기로 간다', async () => {
    const ctx = setup([]);
    ctx.io.type('\x02n');
    await tick();
    expect(ctx.app.state.prompt).toBeUndefined();
    expect(ctx.app.state.folder).toMatchObject({ from: 'prompt' });
    expect(ctx.client.calls).toContain('folders ');
    expect(screenText(ctx.io)).toContain('폴더 열기');
  });

  it('사이드바의 "+ 폴더 열기" 줄을 누르면 연다', async () => {
    const ctx = setup([]);
    await tick();
    const rows = screenText(ctx.io).split('\n');
    const y = rows.findIndex((row) => row.includes('+ 폴더 열기'));
    expect(y).toBeGreaterThan(0);
    ctx.io.type(`\x1b[<0;3;${y + 1}M`);
    await tick();
    expect(ctx.app.state.folder).toBeDefined();
  });

  it('폴더 API를 모르는 옛 스튜디오면 그렇다고 보인다', async () => {
    const client = new FakeClient([item('a')]);
    const old = Object.assign(Object.create(Object.getPrototypeOf(client)), client) as FakeClient & { folders?: unknown };
    Object.defineProperty(old, 'folders', { value: undefined });
    const ctx = setup([item('a')], old);
    ctx.io.type('\x02a');
    await tick();
    expect(screenText(ctx.io)).toContain('지원하지 않습니다');
  });
});
