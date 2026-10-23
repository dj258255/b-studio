import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskApp, type DeskClient, type DeskIo } from './desk';
import type { DeskItem, DeskStartResult, DeskTerminalMessage } from './types';

const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z', ...patch });

interface Call {
  type: 'open' | 'resize' | 'input';
  id: string;
  data?: string;
}

/** 가짜 스튜디오 손님: 부른 것을 기록하고, 통로로 보낼 메시지를 테스트가 넣는다 */
class FakeClient implements DeskClient {
  calls: Call[] = [];
  items: DeskItem[];
  agentsCalls = 0;
  agentsGate: Promise<void> | undefined;
  openError: string | undefined;
  startResult: DeskStartResult = { session: { id: 'new' }, routing: { backend: 'claude-code' }, terminal: { opened: true, pasted: true } };
  allowed: string[] = ['claude-code'];
  streams: Array<{ ids: readonly string[]; onMessage: (id: string, message: DeskTerminalMessage) => void; end: (error?: Error) => void; signal: AbortSignal }> = [];

  constructor(items: DeskItem[]) {
    this.items = items;
  }

  async agents() {
    this.agentsCalls += 1;
    const snapshot = this.items;
    if (this.agentsGate) await this.agentsGate;
    return { items: snapshot };
  }
  async projects() {
    return [{ id: 'p1', name: 'shop' }];
  }
  async rules() {
    return { allowed: this.allowed, defaultBackend: 'claude-code' };
  }
  async preview() {
    return { backend: 'claude-code', rule: 'default' as const, matched: '' };
  }
  async start() {
    return this.startResult;
  }
  async open(id: string) {
    this.calls.push({ type: 'open', id });
    if (this.openError) throw new Error(this.openError);
  }
  async resize(id: string) {
    this.calls.push({ type: 'resize', id });
  }
  async input(id: string, data: string) {
    this.calls.push({ type: 'input', id, data });
  }
  stream(ids: readonly string[], onMessage: (id: string, message: DeskTerminalMessage) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const end = (error?: Error) => (error ? reject(error) : resolve());
      signal.addEventListener('abort', () => resolve());
      this.streams.push({ ids, onMessage, end, signal });
    });
  }

  /** 지금 열린 통로로 칸 출력을 보낸다 */
  emit(id: string, message: DeskTerminalMessage): void {
    const live = this.streams.filter((stream) => !stream.signal.aborted && stream.ids.includes(id));
    for (const stream of live) stream.onMessage(id, message);
  }
  data(id: string, text: string): void {
    this.emit(id, { kind: 'data', data: Buffer.from(text).toString('base64') });
  }
  of(type: Call['type'], id?: string): Call[] {
    return this.calls.filter((call) => call.type === type && (id === undefined || call.id === id));
  }
}

class FakeIo implements DeskIo {
  out: string[] = [];
  raw: boolean[] = [];
  cols = 120;
  rows = 30;
  #input: (chunk: string) => void = () => {};
  #resize: () => void = () => {};
  write(data: string) {
    this.out.push(data);
  }
  size() {
    return { cols: this.cols, rows: this.rows };
  }
  onInput(listener: (chunk: string) => void) {
    this.#input = listener;
  }
  onResize(listener: () => void) {
    this.#resize = listener;
  }
  setRaw(on: boolean) {
    this.raw.push(on);
  }
  type(chunk: string) {
    this.#input(chunk);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.#resize();
  }
  get all(): string {
    return this.out.join('');
  }
}

async function tick(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function setup(items: DeskItem[] = [item('a'), item('b')]) {
  const client = new FakeClient(items);
  const io = new FakeIo();
  const app = new DeskApp(client, items, io);
  const done = app.run();
  return { client, io, app, done };
}

/** 사이드바 첫 세션을 칸 1에 연다 */
async function openFirst(ctx: ReturnType<typeof setup>): Promise<void> {
  ctx.io.type('\x02\r');
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('desk 작업대(#860)', () => {
  it('시작할 때 밖 터미널의 bracketed paste를 켜고, 나갈 때 끈다', async () => {
    const ctx = setup();
    expect(ctx.io.all).toContain('\x1b[?2004h');
    expect(ctx.io.raw).toEqual([true]);
    ctx.io.type('\x02q');
    await expect(ctx.done).resolves.toBe(0);
    expect(ctx.io.all.endsWith('\x1b[?1049l')).toBe(true);
    expect(ctx.io.all).toContain('\x1b[?2004l');
    expect(ctx.io.raw).toEqual([true, false]);
  });

  it('붙여 넣은 글 안의 Ctrl-b x는 칸을 닫지 않고, CLI가 bracketed paste를 켰으면 표지로 감싸 보낸다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', '\x1b[?2004h> ');
    await tick();
    ctx.io.type('\x1b[200~line1\rline2\x02x\x1b[201~');
    await tick();
    expect(ctx.client.of('input', 'a').map((call) => call.data)).toEqual(['\x1b[200~line1\rline2\x02x\x1b[201~']);
    // 칸이 그대로 열려 있다: 친 글자가 계속 a로 간다
    ctx.io.type('y');
    await tick();
    expect(ctx.client.of('input', 'a').at(-1)?.data).toBe('y');
  });

  it('CLI가 bracketed paste를 켜지 않았으면 내용만 보낸다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.io.type('\x1b[200~a\nb\x1b[201~');
    await tick();
    expect(ctx.client.of('input', 'a').map((call) => call.data)).toEqual(['a\nb']);
  });

  it('CLI가 응용 커서 키 모드를 켰으면 방향키를 그 꼴로 보낸다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', '\x1b[?1h');
    await tick();
    ctx.io.type('\x1b[A');
    await tick();
    expect(ctx.client.of('input', 'a').at(-1)?.data).toBe('\x1bOA');
  });

  it('끝에 혼자 온 Esc는 잠깐 기다렸다가 CLI로 보낸다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.io.type('\x1b');
    expect(ctx.client.of('input', 'a')).toEqual([]);
    await tick(100);
    expect(ctx.client.of('input', 'a').map((call) => call.data)).toEqual(['\x1b']);
  });

  it('목록 순서가 바뀌어도 고르던 세션을 연다', async () => {
    const ctx = setup([item('a'), item('b'), item('c')]);
    ctx.io.type('\x02\x1b[B');
    ctx.io.type('\x1b');
    await tick();
    // b를 고른 채로 c가 작업 중이 되어 맨 위로 올라온다
    ctx.client.items = [item('c', { state: 'working' }), item('a'), item('b')];
    await tick(1_600);
    ctx.io.type('\x02\r');
    await tick();
    expect(ctx.client.of('open').map((call) => call.id)).toEqual(['b']);
  });

  it('터미널이 끝난 칸은 Ctrl-b Enter로 다시 연다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    expect(ctx.client.of('open', 'a')).toHaveLength(1);
    ctx.client.emit('a', { kind: 'exit', code: 0 });
    await tick();
    expect(ctx.io.all).toContain('터미널이 끝났습니다');
    ctx.io.type('\x02\r');
    await tick();
    expect(ctx.client.of('open', 'a')).toHaveLength(2);
  });

  it('열기에 실패하면 까닭을 칸 머리에 보이고, 다음 Ctrl-b Enter에서 다시 연다', async () => {
    const ctx = setup();
    ctx.client.openError = '세션을 이어서 작업한 뒤 다시 여세요';
    await openFirst(ctx);
    expect(ctx.io.all).toContain('세션을 이어서 작업한 뒤 다시 여세요');
    ctx.client.openError = undefined;
    ctx.io.type('\x02\r');
    await tick();
    expect(ctx.client.of('open', 'a')).toHaveLength(2);
    expect(ctx.client.of('resize', 'a')).toHaveLength(0);
  });

  it('통로가 끊겼다가 다시 붙으면 보이는 칸의 터미널을 다시 연다(스튜디오를 다시 띄운 뒤)', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.streams.at(-1)!.end(new Error('fetch failed'));
    await tick();
    expect(ctx.io.all).toContain('다시 붙는 중');
    await tick(2_100);
    // 끊긴 통로 다음에 새 통로를 하나 열었다
    expect(ctx.client.streams).toHaveLength(2);
    expect(ctx.client.of('open', 'a')).toHaveLength(2);
  });

  it('새 요청을 보냈지만 서버가 실패 까닭(sendError)을 돌려주면 그것을 보인다', async () => {
    const ctx = setup();
    ctx.client.startResult = { session: { id: 'new' }, routing: { backend: 'claude-code' }, sendError: '설계를 먼저 승인하세요' };
    ctx.io.type('\x02n');
    await tick();
    ctx.io.type('고쳐 줘\r');
    await tick();
    expect(ctx.io.all).toContain('설계를 먼저 승인하세요');
    expect(ctx.io.all).not.toContain('아직 터미널로 첫 요청을 넣지 않습니다');
  });

  it('직접 고르는 AI는 터미널로 띄울 수 있는 것(Claude Code·Codex)만 보인다', async () => {
    const ctx = setup();
    ctx.client.allowed = ['claude-code', 'gemini', 'codex', 'opencode'];
    ctx.io.type('\x02n');
    await tick();
    expect(ctx.app.state.prompt?.choices).toEqual(['rules', 'claude-code', 'codex']);
  });

  it('CLI가 커서를 숨기면 desk도 커서를 보이지 않는다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', 'hi\x1b[?25l');
    await tick();
    ctx.io.out = [];
    ctx.client.data('a', 'x');
    await tick();
    expect(ctx.io.all).not.toContain('\x1b[?25h');
    ctx.client.data('a', '\x1b[?25h');
    await tick();
    expect(ctx.io.all).toContain('\x1b[?25h');
  });

  it('사이드바를 받는 요청이 끝나기 전에는 새로 보내지 않고, 늦게 온 옛 응답이 새 목록을 덮지 않는다', async () => {
    const ctx = setup([item('a')]);
    let release!: () => void;
    ctx.client.agentsGate = new Promise((resolve) => (release = resolve));
    await tick(1_600);
    const first = ctx.client.agentsCalls;
    await tick(3_200);
    expect(ctx.client.agentsCalls).toBe(first);
    ctx.client.agentsGate = undefined;
    ctx.client.items = [item('a'), item('z')];
    release();
    await tick(1_600);
    expect(ctx.app.state.items.map((entry) => entry.id)).toEqual(['a', 'z']);
  });

  it('창 크기를 끌어 바꾸는 동안에는 스튜디오에 크기를 한 번만 알린다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    for (let cols = 100; cols < 110; cols++) {
      ctx.io.resize(cols, 30);
      await tick(10);
    }
    await tick(300);
    expect(ctx.client.of('resize', 'a')).toHaveLength(1);
  });
});

describe('desk 작업대: 칸마다 통로, 복사 모드, 크게 보기, 도움말(#863)', () => {
  /** 두 칸 배치로 a를 칸 1, b를 칸 2에 연다 */
  async function openTwo(ctx: ReturnType<typeof setup>): Promise<void> {
    ctx.io.type('\x02l');
    await openFirst(ctx);
    ctx.io.type('\x022\x02\x1b[B');
    ctx.io.type('\x1b');
    await tick();
    ctx.io.type('\x02\r');
    await tick();
  }

  it('칸을 하나 더 열어도 이미 보던 칸의 통로를 끊거나 화면을 지우지 않는다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', 'hello from a');
    await tick();
    const first = ctx.client.streams[0]!;
    expect(first.ids).toEqual(['a']);
    await openTwo(ctx);
    expect(first.signal.aborted).toBe(false);
    expect(ctx.client.streams.map((stream) => stream.ids)).toEqual([['a'], ['b']]);
    ctx.io.out = [];
    ctx.client.data('b', 'hi b');
    await tick();
    // a의 내용은 그대로 남아 있다(다시 그리면 그대로 보인다)
    ctx.io.resize(121, 30);
    await tick();
    expect(ctx.io.all).toContain('hello from a');
  });

  it('새로 연 칸이 최근 출력을 다시 받는 동안에도 다른 칸의 질의에는 답한다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    await tick(1_000);
    await openTwo(ctx);
    ctx.client.data('a', '\x1b[6n');
    await tick();
    expect(ctx.client.of('input', 'a').some((call) => /\x1b\[\d+;\d+R/.test(call.data ?? ''))).toBe(true);
  });

  it('복사 모드에서 고른 줄을 OSC 52로 밖 터미널 클립보드에 넣고, 그동안 친 키는 CLI로 가지 않는다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', 'first\r\nsecond\r\nthird');
    await tick();
    ctx.io.type('\x02[');
    await tick();
    expect(ctx.io.all).toContain('복사');
    ctx.io.type('kvky');
    await tick();
    expect(ctx.client.of('input', 'a')).toEqual([]);
    const osc = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(ctx.io.all);
    expect(osc).not.toBeNull();
    expect(Buffer.from(osc![1]!, 'base64').toString()).toBe('first\nsecond');
    ctx.io.type('z');
    await tick();
    expect(ctx.client.of('input', 'a').map((call) => call.data)).toEqual(['z']);
  });

  it('크게 보기 중에는 고른 칸만 크기를 바꿔 알리고, 다른 칸 세션은 통로를 그대로 둔다', async () => {
    const ctx = setup();
    await openTwo(ctx);
    await tick(300);
    const before = { a: ctx.client.of('resize', 'a').length, b: ctx.client.of('resize', 'b').length };
    ctx.io.type('\x02z');
    await tick(300);
    expect(ctx.client.of('resize', 'b').length).toBe(before.b + 1);
    expect(ctx.client.of('resize', 'a').length).toBe(before.a);
    expect(ctx.client.streams.filter((stream) => !stream.signal.aborted).map((stream) => stream.ids)).toEqual([['a'], ['b']]);
  });

  it('Ctrl-b ?는 도움말 화면을 보이고, 아무 키나 누르면 닫히며 그 키는 CLI로 가지 않는다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.io.type('\x02?');
    await tick();
    expect(ctx.io.all).toContain('도움말');
    expect(ctx.io.all).toContain('복사 모드');
    ctx.io.type('x');
    await tick();
    expect(ctx.client.of('input', 'a')).toEqual([]);
    expect(ctx.app.state.help).toBe(false);
  });
});

