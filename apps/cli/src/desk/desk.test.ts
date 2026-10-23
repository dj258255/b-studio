import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError } from './client';
import type { DeskLayout } from './config';
import { DeskApp, type DeskClient, type DeskIo, type DeskAppOptions, type DeskLayoutStore } from './desk';
import { sidebarRows } from './sidebar';
import type { DeskItem, DeskStartResult, DeskTerminalMessage } from './types';

const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z', ...patch });

interface Call {
  type: 'open' | 'resize' | 'input' | 'stop' | 'resume' | 'rename';
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
  /** 열기 실패의 HTTP 상태(없으면 상태 없는 오류) */
  openStatus: number | undefined;
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
    if (this.openError) throw this.openStatus ? new StudioRequestError(this.openError, this.openStatus) : new Error(this.openError);
  }
  async stop(id: string) {
    this.calls.push({ type: 'stop', id });
  }
  async resume(id: string) {
    this.calls.push({ type: 'resume', id });
  }
  async rename(id: string, label: string) {
    this.calls.push({ type: 'rename', id, data: label });
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

function setup(items: DeskItem[] = [item('a'), item('b')], options: DeskAppOptions = {}) {
  const client = new FakeClient(items);
  const io = new FakeIo();
  const app = new DeskApp(client, items, io, options);
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


describe('desk 작업대: 세션 조작과 알림(#864)', () => {
  const OSC9 = /\x1b\]9;([^\x07]*)\x07/g;
  const notices = (out: string): string[] => [...out.matchAll(OSC9)].map((match) => match[1]!);
  /** 색 코드를 뺀 출력 */
  const plain = (out: string): string => out.replace(/\x1b\[[0-9;]*m/g, '');
  /** 사이드바를 받아 오는 주기를 한 번 넘긴다 */
  const poll = () => tick(1_600);

  it('Ctrl-b p 다음 y로 고른 세션을 멈춘다', async () => {
    const ctx = setup();
    ctx.io.type('\x02p');
    await tick();
    expect(ctx.io.all).toContain('멈출까요');
    ctx.io.type('y');
    await tick();
    expect(ctx.client.of('stop').map((call) => call.id)).toEqual(['a']);
    expect(ctx.client.of('input')).toEqual([]);
  });

  it('멈춘 세션을 열다 409를 받으면 Ctrl-b r을 안내하고, 이어서 작업한 세션이 켜지면 칸을 다시 연다', async () => {
    const ctx = setup([item('a', { state: 'stopped' })]);
    ctx.client.openError = '중지된 세션입니다. 이어서 작업하면 새 샌드박스를 띄웁니다';
    ctx.client.openStatus = 409;
    await openFirst(ctx);
    expect(ctx.io.all).toContain('Ctrl-b r');
    ctx.client.openError = undefined;
    ctx.io.type('\x02r');
    await tick();
    ctx.io.type('y');
    await tick();
    expect(ctx.client.of('resume').map((call) => call.id)).toEqual(['a']);
    // 켜는 중에는 다시 열지 않는다
    ctx.client.items = [item('a', { state: 'booting' })];
    await poll();
    expect(ctx.client.of('open', 'a')).toHaveLength(1);
    ctx.client.items = [item('a', { state: 'idle' })];
    await poll();
    expect(ctx.client.of('open', 'a')).toHaveLength(2);
  });

  it('Ctrl-b ,로 고른 세션의 이름을 바꾸고 목록을 새로 받는다', async () => {
    const ctx = setup();
    const before = ctx.client.agentsCalls;
    ctx.io.type('\x02,');
    await tick();
    ctx.io.type('결제 화면\r');
    await tick();
    expect(ctx.client.of('rename')).toEqual([{ type: 'rename', id: 'a', data: '결제 화면' }]);
    expect(ctx.client.agentsCalls).toBeGreaterThan(before);
  });

  it('처음 받은 목록으로는 알리지 않고, 작업 중이던 세션이 권한을 기다리면 벨과 OS 알림을 낸다', async () => {
    const ctx = setup([item('a', { state: 'working' }), item('b', { state: 'working' })]);
    await poll();
    expect(notices(ctx.io.all)).toEqual([]);
    expect(ctx.io.all).not.toContain('\x07');
    ctx.client.items = [item('a', { state: 'working' }), item('b', { state: 'idle', terminal: { cli: 'up', waiting: 'permission' } })];
    await poll();
    expect(notices(ctx.io.all)).toEqual(['b-studio: Claude · 요청 b · 권한 대기']);
    // 사이드바에 손댈 세션 표시가 붙는다
    expect(plain(ctx.io.all)).toContain('! Claude · shop · 요청 b');
  });

  it('게이트가 실패로 바뀌면 알리고, 작업이 끝나면 끝났다고 알린다', async () => {
    const ctx = setup([item('a', { state: 'working', gate: { state: 'verifying', checkpoints: 0 } })]);
    ctx.client.items = [item('a', { state: 'working', gate: { state: 'failed', checkpoints: 0 } })];
    await poll();
    expect(notices(ctx.io.all).at(-1)).toContain('실패');
    ctx.client.items = [item('a', { state: 'idle', terminal: { cli: 'up' }, gate: { state: 'failed', checkpoints: 0 } })];
    await poll();
    expect(notices(ctx.io.all).at(-1)).toContain('끝남');
  });

  it('고른 칸에서 보고 있는 세션은 OS 알림을 내지 않는다', async () => {
    const ctx = setup([item('a', { state: 'working' })]);
    await openFirst(ctx);
    ctx.client.items = [item('a', { state: 'idle', terminal: { cli: 'up', waiting: 'permission' } })];
    await poll();
    expect(notices(ctx.io.all)).toEqual([]);
    // 벨과 아래 줄 알림은 낸다
    expect(ctx.io.all).toContain('\x07');
    expect(ctx.io.all).toContain('알림: Claude · 요청 a · 권한 대기');
  });

  it('알림을 끄면 벨과 OS 알림을 내지 않는다', async () => {
    const ctx = setup([item('a'), item('b', { state: 'working' })], { notify: false });
    ctx.client.items = [item('a'), item('b', { state: 'idle', terminal: { cli: 'up', waiting: 'permission' } })];
    await poll();
    expect(notices(ctx.io.all)).toEqual([]);
    expect(ctx.io.all).not.toContain('\x07');
    // 사이드바 표시는 그대로 붙는다
    expect(plain(ctx.io.all)).toContain('! Claude · shop · 요청 b');
  });

  it('칸 안 CLI의 벨은 밖 터미널 벨과 칸 머리 표시로 잇고, 다시 받는 옛 출력의 벨은 울리지 않는다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', 'old\x07');
    await tick();
    expect(ctx.io.all).not.toContain('\x07');
    await tick(600);
    // 두 칸으로 늘려 다른 칸을 고른다: a는 보고 있는 칸이 아니다
    ctx.io.type('\x02l');
    ctx.io.type('\x022');
    await tick();
    ctx.client.data('a', 'ding\x07');
    await tick();
    expect(ctx.io.all).toContain('\x07');
    expect(ctx.io.all).toContain('벨');
  });
});

describe('desk 작업대: 마우스, 배치 기억, 설정(#874)', () => {
  /** SGR 마우스 열(화면 좌표는 0부터) */
  const click = (x: number, y: number, button = 0) => `\x1b[<${button};${x + 1};${y + 1}M`;
  const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
  // 120×30 화면: 사이드바 32칸, 구분선, 칸들은 x=33부터. 2칸이면 왼쪽 43칸, 구분선, 오른쪽은 x=77부터. 맨 위 줄은 머리, 칸 첫 줄은 칸 머리
  const LEFT_BODY = { x: 40, y: 5 };
  const RIGHT_BODY = { x: 90, y: 5 };

  class MemoryStore implements DeskLayoutStore {
    saved: DeskLayout[] = [];
    fail = false;
    initial: DeskLayout | undefined;
    load() {
      return this.initial;
    }
    save(layout: DeskLayout) {
      if (this.fail) throw new Error('읽기 전용 폴더');
      this.saved.push(layout);
    }
  }

  async function openTwo(ctx: ReturnType<typeof setup>): Promise<void> {
    ctx.io.type('\x02l');
    await openFirst(ctx);
    ctx.io.type('\x022\x02\x1b[B');
    ctx.io.type('\x1b');
    await tick();
    ctx.io.type('\x02\r');
    await tick();
  }

  it('밖 터미널의 마우스(SGR)를 켜고 나갈 때 끈다. 끄는 설정이면 켜지 않는다', async () => {
    const on = setup();
    expect(on.io.all).toContain('\x1b[?1000h\x1b[?1006h');
    on.io.type('\x02q');
    await on.done;
    expect(on.io.all).toContain('\x1b[?1006l\x1b[?1000l');
    const off = setup(undefined, { mouse: false });
    expect(off.io.all).not.toContain('\x1b[?1000h');
  });

  it('칸을 누르면 그 칸을 고르고, 이어 친 글자는 그 칸의 CLI로 간다', async () => {
    const ctx = setup();
    await openTwo(ctx);
    ctx.io.type(click(LEFT_BODY.x, LEFT_BODY.y) + release(LEFT_BODY.x, LEFT_BODY.y));
    await tick();
    expect(ctx.app.state.focus).toBe(0);
    ctx.io.type('k');
    await tick();
    expect(ctx.client.of('input', 'a').map((call) => call.data)).toEqual(['k']);
    expect(ctx.client.of('input', 'a').some((call) => call.data?.includes('\x1b[<'))).toBe(false);
  });

  it('휠을 위로 굴리면 그 칸이 복사 모드로 올라가고, 맨 아래까지 내리면 복사 모드를 나온다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\r\n'));
    await tick();
    ctx.io.type(click(LEFT_BODY.x, LEFT_BODY.y, 64));
    await tick();
    expect(ctx.app.state.copy).toEqual({});
    expect(ctx.io.all).toContain('복사 모드');
    ctx.io.type(click(LEFT_BODY.x, LEFT_BODY.y, 65).repeat(5));
    await tick();
    expect(ctx.app.state.copy).toBeUndefined();
    expect(ctx.client.of('input', 'a')).toEqual([]);
  });

  it('안쪽 CLI가 마우스를 켰으면 고른 칸 안의 마우스를 칸 좌표로 바꿔 넘긴다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', '\x1b[?1000h\x1b[?1006h');
    await tick();
    ctx.io.type(click(LEFT_BODY.x, LEFT_BODY.y) + release(LEFT_BODY.x, LEFT_BODY.y));
    await tick();
    // 칸은 x=33부터, 터미널 몸은 칸 머리 다음 줄(y=2)부터다
    expect(ctx.client.of('input', 'a').map((call) => call.data)).toEqual(['\x1b[<0;8;4M', '\x1b[<0;8;4m']);
  });

  it('안쪽 CLI가 SGR 꼴을 켜지 않았으면 옛 꼴(X10)로 넘긴다', async () => {
    const ctx = setup();
    await openFirst(ctx);
    ctx.client.data('a', '\x1b[?1000h');
    await tick();
    ctx.io.type(click(LEFT_BODY.x, LEFT_BODY.y));
    await tick();
    expect(ctx.client.of('input', 'a').map((call) => call.data)).toEqual([`\x1b[M${String.fromCharCode(32 + 0, 32 + 8, 32 + 4)}`]);
  });

  it('사이드바를 누르면 그 세션을 고르고, 고른 세션을 한 번 더 누르면 고른 칸에 연다', async () => {
    const ctx = setup();
    const rows = sidebarRows(ctx.app.state.items, 0, new Map(), 32);
    const rowOfB = rows.findIndex((row) => row.item === 1);
    // 사이드바는 화면 둘째 줄(y=1)부터다
    ctx.io.type(click(3, 1 + rowOfB) + release(3, 1 + rowOfB));
    await tick();
    expect(ctx.app.state.selected).toBe(1);
    expect(ctx.client.of('open')).toEqual([]);
    const again = sidebarRows(ctx.app.state.items, 1, new Map(), 32).findIndex((row) => row.item === 1);
    ctx.io.type(click(3, 1 + again));
    await tick();
    expect(ctx.app.state.slots[0]).toBe('b');
    expect(ctx.client.of('open', 'b')).toHaveLength(1);
  });

  it('저장해 둔 배치(칸 수·칸의 세션·사이드바 숨김)를 되살리고, 없어진 세션 자리는 비운다', async () => {
    const store = new MemoryStore();
    store.initial = { layout: 2, slots: ['b', 'gone', undefined, undefined], focus: 1, zoom: false, sidebarHidden: true };
    const ctx = setup(undefined, { layoutStore: store });
    await tick();
    expect(ctx.app.state).toMatchObject({ layout: 2, slots: ['b', undefined, undefined, undefined], focus: 1, sidebarHidden: true });
    expect(ctx.client.of('open', 'b')).toHaveLength(1);
    expect(ctx.client.of('open', 'gone')).toEqual([]);
  });

  it('칸 구성이 바뀔 때 배치를 저장하고, 저장하지 못하면 아래 줄에 한 번만 알린다', async () => {
    const store = new MemoryStore();
    const ctx = setup(undefined, { layoutStore: store });
    await openFirst(ctx);
    ctx.io.type('\x02l');
    await tick();
    expect(store.saved.at(-1)).toMatchObject({ layout: 2, slots: ['a', undefined, undefined, undefined] });
    store.fail = true;
    ctx.io.out = [];
    ctx.io.type('\x02s');
    await tick();
    expect(ctx.app.state.message).toMatch(/배치를 저장하지 못했습니다/);
    ctx.io.type('\x02s');
    await tick();
    expect(ctx.app.state.message ?? '').not.toMatch(/배치를 저장하지 못했습니다/);
  });

  it('나갈 때도 배치를 저장한다', async () => {
    const store = new MemoryStore();
    const ctx = setup(undefined, { layoutStore: store });
    await openFirst(ctx);
    ctx.io.type('\x02z');
    await tick();
    ctx.io.type('\x02q');
    await ctx.done;
    expect(store.saved.at(-1)).toMatchObject({ zoom: true, slots: ['a', undefined, undefined, undefined] });
  });

  it('설정한 앞글쇠로 조작하고, 안내에도 그 글쇠를 보인다', async () => {
    const ctx = setup(undefined, { prefix: { key: '\x01', label: 'Ctrl-a' } });
    ctx.io.type('\x01\r');
    await tick();
    expect(ctx.app.state.slots[0]).toBe('a');
    ctx.io.type('\x01');
    await tick();
    expect(ctx.io.all).toContain('Ctrl-a › 숫자');
    expect(ctx.io.all).not.toContain('Ctrl-b › 숫자');
  });

  it('256색 터미널이면 칸의 24비트 색을 낮춰 그린다', async () => {
    const ctx = setup(undefined, { truecolor: false });
    await openFirst(ctx);
    ctx.client.data('a', '\x1b[38;2;255;0;0mRED');
    await tick();
    expect(ctx.io.all).toContain('38;5;196');
    expect(ctx.io.all).not.toContain('38;2;255;0;0');
  });
});
