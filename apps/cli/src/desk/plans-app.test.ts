/**
 * desk에 붙은 작업 나누기 화면(#893): Ctrl-b t로 열고, 스튜디오의 task-plans API와 주고받는 것을 가짜로 본다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError } from './client';
import { DeskApp, type DeskClient, type DeskIo } from './desk';
import type { DeskPlan } from './plans';
import { stripAnsi } from './screen';
import type { DeskAccount, DeskItem } from './types';

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

const waiting = (): DeskPlan => ({
  id: 'p1',
  projectId: 'shop',
  request: '주문 모듈 나누기',
  status: 'awaiting_approval',
  createdAt: '2026-10-23T00:00:00Z',
  lanes: [
    { id: 'lane-1', paths: [], status: 'queued', tasks: [{ id: 'a', title: '저장소', dependsOn: [], status: 'queued' }] },
    { id: 'lane-2', paths: [], status: 'queued', tasks: [{ id: 'b', title: '결제', dependsOn: ['a'], status: 'queued' }] },
  ],
});

class FakeClient implements DeskClient {
  calls: string[] = [];
  planList: DeskPlan[] = [waiting()];
  approveError: Error | undefined;
  accountList: DeskAccount[] = [
    { id: 'codex', name: '기본', backend: 'codex', builtin: true },
    { id: 'marco', name: '마르코', backend: 'codex', configDir: '/h/.codex-marco' },
  ];
  constructor(readonly items: DeskItem[]) {}
  async agents() {
    return { items: this.items };
  }
  async projects() {
    return [{ id: 'shop', name: 'shop' }];
  }
  async accounts() {
    this.calls.push('accounts');
    return this.accountList;
  }
  async rules() {
    return { allowed: ['claude-code', 'codex'], defaultBackend: 'claude-code' };
  }
  async preview() {
    return { backend: 'codex', rule: 0 as const, matched: '' };
  }
  async start(): Promise<never> {
    throw new Error('쓰지 않는다');
  }
  async open(id: string) {
    this.calls.push(`open ${id}`);
  }
  async resize() {}
  async input() {}
  async stop() {}
  async resume() {}
  async rename() {}
  stream(_ids: readonly string[], _on: unknown, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
  }
  async plans() {
    this.calls.push('plans');
    return this.planList;
  }
  async plan(id: string) {
    this.calls.push(`plan ${id}`);
    const found = this.planList.find((plan) => plan.id === id);
    if (!found) throw new StudioRequestError('계획을 찾을 수 없습니다', 404);
    return found;
  }
  async createPlan(projectId: string, request: string) {
    this.calls.push(`create ${projectId} ${request}`);
    const plan: DeskPlan = { id: 'p9', projectId, request, status: 'planning', createdAt: '2026-10-23T01:00:00Z', lanes: [] };
    this.planList = [plan, ...this.planList];
    return plan;
  }
  async approvePlan(id: string, publishIssues: boolean) {
    this.calls.push(`approve ${id} ${publishIssues}`);
    if (this.approveError) throw this.approveError;
    return this.#patch(id, { status: 'running' });
  }
  async rejectPlan(id: string) {
    this.calls.push(`reject ${id}`);
    return this.#patch(id, { status: 'rejected' });
  }
  async deletePlan(id: string) {
    this.calls.push(`delete ${id}`);
    this.planList = this.planList.filter((plan) => plan.id !== id);
  }
  async resumePlan(id: string) {
    this.calls.push(`resume-plan ${id}`);
    return this.#patch(id, { status: 'integrating' });
  }
  async laneBackends() {
    this.calls.push('lane-backends');
    return ['claude-code', 'codex'];
  }
  async setLane(id: string, laneId: string, backend: string, accountId?: string) {
    this.calls.push(`lane ${id} ${laneId} ${backend} ${accountId ?? '-'}`);
    const plan = this.planList.find((entry) => entry.id === id)!;
    return this.#patch(id, { lanes: plan.lanes.map((lane) => (lane.id === laneId ? { ...lane, backend, ...(accountId ? { accountId } : {}) } : lane)) });
  }
  #patch(id: string, patch: Partial<DeskPlan>): DeskPlan {
    this.planList = this.planList.map((plan) => (plan.id === id ? { ...plan, ...patch } : plan));
    return this.planList.find((plan) => plan.id === id)!;
  }
}

function setup(items: DeskItem[] = [item('a')]) {
  const client = new FakeClient(items);
  const io = new FakeIo();
  const opened: string[] = [];
  const app = new DeskApp(client, items, io, { openUrl: (url) => opened.push(url), accounts: client.accountList });
  const done = app.run();
  return { client, io, app, done, opened };
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

describe('작업 나누기 화면(#893)', () => {
  it('Ctrl-b t로 열면 계획 목록을 받아 보이고, Enter로 계획을 열어 단계별 레인을 보인다', async () => {
    const ctx = setup();
    ctx.io.type('\x02t');
    await tick();
    expect(ctx.client.calls).toContain('plans');
    expect(screenText(ctx.io)).toContain('주문 모듈 나누기');
    expect(screenText(ctx.io)).toContain('승인 대기');
    ctx.io.type('\r');
    await tick();
    expect(ctx.client.calls).toContain('plan p1');
    const text = screenText(ctx.io);
    expect(text).toContain('1단계');
    expect(text).toContain('2단계');
    expect(text).toContain('결제');
  });

  it('열려 있는 동안 계획을 다시 받아 바뀐 상태를 보이고, 닫으면 그만 받는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02t');
    await tick();
    ctx.io.type('\r');
    await tick();
    ctx.client.planList = [{ ...waiting(), status: 'running' }];
    await tick(2_100);
    expect(ctx.app.state.plans?.detail?.status).toBe('running');
    ctx.io.type('\x1b\x1b');
    await tick();
    expect(ctx.app.state.plans).toBeUndefined();
    const before = ctx.client.calls.length;
    await tick(5_000);
    expect(ctx.client.calls.filter((call) => call.startsWith('plan')).length).toBe(ctx.client.calls.slice(0, before).filter((call) => call.startsWith('plan')).length);
  });

  it('b로 레인 AI·계정을 고르면 계정 목록까지 보이고, 고른 계정으로 바꾼다', async () => {
    const ctx = setup();
    ctx.io.type('\x02t');
    await tick();
    ctx.io.type('\r');
    await tick();
    ctx.io.type('b');
    await tick();
    expect(ctx.client.calls).toContain('lane-backends');
    const labels = ctx.app.state.plans?.choices?.map((choice) => choice.label);
    expect(labels).toEqual(['세션과 같음(계획 기본)', 'Claude', 'Codex', 'Codex · 마르코']);
    ctx.io.type('\x1b[B\x1b[B\x1b[B\r');
    await tick();
    expect(ctx.client.calls).toContain('lane p1 lane-1 codex marco');
    expect(screenText(ctx.io)).toContain('Codex · 마르코');
  });

  it('a 다음 i는 승인하고 이슈로 올린다. 실패하면 까닭을 알린다', async () => {
    const ctx = setup();
    ctx.client.approveError = new StudioRequestError('승인을 기다리는 계획이 아닙니다', 409);
    ctx.io.type('\x02t');
    await tick();
    ctx.io.type('\r');
    await tick();
    ctx.io.type('a');
    await tick();
    expect(screenText(ctx.io)).toContain('이슈로 올리기');
    ctx.io.type('i');
    await tick();
    expect(ctx.client.calls).toContain('approve p1 true');
    expect(screenText(ctx.io)).toContain('승인을 기다리는 계획이 아닙니다');
  });

  it('n으로 새 계획을 만들면 그 계획 보기로 간다', async () => {
    const ctx = setup();
    ctx.io.type('\x02t');
    await tick();
    ctx.io.type('n');
    await tick();
    ctx.io.type('\r');
    ctx.io.type('문서 정리\r');
    await tick();
    expect(ctx.client.calls).toContain('create shop 문서 정리');
    expect(ctx.app.state.plans?.mode).toBe('detail');
    expect(ctx.app.state.plans?.detail?.id).toBe('p9');
    expect(screenText(ctx.io)).toContain('레인으로 나누는 중');
  });

  it('Enter는 레인 세션을 고른 칸에 열고, g는 세션 있는 레인을 칸에 나란히 연다', async () => {
    const ctx = setup([item('a'), item('s-1', { kind: 'lane' }), item('s-2', { kind: 'lane' })]);
    ctx.client.planList = [
      {
        ...waiting(),
        status: 'running',
        lanes: waiting().lanes.map((lane, index) => ({ ...lane, status: 'running' as const, sessionId: `s-${index + 1}` })),
      },
    ];
    ctx.io.type('\x02t');
    await tick();
    ctx.io.type('\r');
    await tick();
    ctx.io.type('\r');
    await tick();
    expect(ctx.app.state.plans).toBeUndefined();
    expect(ctx.app.state.slots[ctx.app.state.focus]).toBe('s-1');
    ctx.io.type('\x02t');
    await tick();
    ctx.io.type('\r');
    await tick();
    ctx.io.type('g');
    await tick();
    expect(ctx.app.state.layout).toBe(2);
    expect(ctx.app.state.slots.slice(0, 2)).toEqual(['s-1', 's-2']);
    expect(ctx.app.state.view).toBeUndefined();
  });

  it('d는 묻고 지운 뒤 목록을 다시 받는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02t');
    await tick();
    ctx.io.type('d');
    await tick();
    ctx.io.type('y');
    await tick();
    expect(ctx.client.calls).toContain('delete p1');
    expect(ctx.app.state.plans?.list).toEqual([]);
  });

  it('작업 나누기 API를 모르는 스튜디오면 열 수 없다고 알린다', async () => {
    const client: DeskClient = Object.assign(new FakeClient([item('a')]), { plans: undefined });
    const io = new FakeIo();
    const other = new DeskApp(client, [item('a')], io);
    void other.run();
    io.type('\x02t');
    await tick();
    expect(other.state.plans).toBeUndefined();
    expect(other.state.message).toContain('작업 나누기');
  });
});
