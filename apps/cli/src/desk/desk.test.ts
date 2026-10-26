import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError, type StartInput } from './client';
import type { DeskLayout } from './config';
import { DeskApp, type DeskClient, type DeskIo, type DeskAppOptions, type DeskLayoutStore, type ShellPty, type SpawnShell, type SpriteCatalog } from './desk';
import { spaceScreen } from './cards';
import { spaceRect } from './render';
import { stripAnsi } from './screen';
import { sidebarRows } from './sidebar';
import { spriteFromRows, type Sprite } from './sprite';
import type { DeskAccount, DeskAccountLimits, DeskFleet, DeskFleetCandidate, DeskFleetMember, DeskItem, DeskSpend, DeskStartResult, DeskTerminalMessage } from './types';

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
  accountList: DeskAccount[] = [];
  started: StartInput[] = [];
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
  async start(input: StartInput) {
    this.started.push(input);
    return this.startResult;
  }
  async accounts() {
    return this.accountList;
  }
  /** 기록 화면과 세션 자세히(#891)가 부른 것: 이름과 인자 */
  recordCalls: Array<[string, ...unknown[]]> = [];
  failNext: Record<string, string> = {};
  #record(name: string, ...args: unknown[]) {
    this.recordCalls.push([name, ...args]);
    const error = this.failNext[name];
    if (error) {
      delete this.failNext[name];
      throw new StudioRequestError(error, 409);
    }
  }
  async routingStats() {
    this.#record('routingStats');
    return { rows: [], excluded: { asks: 0, unfinished: 0 }, byAccount: [{ backend: 'claude-code', runs: 4, passed: 3, failed: 1, errors: 0, passRate: 0.75, averageTokens: 20_000 }] };
  }
  async tokenReport(projectId: string, from?: string) {
    this.#record('tokenReport', projectId, from);
    const usage = { inputTokens: 50_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return { projectId, projectName: 'shop', generatedAt: '2026-10-23T00:00:00Z', sessions: 1, requests: [{ sessionId: 'a', kind: 'normal' as const, request: 'r', usage, result: 'changed' as const }], totals: usage, usageByModel: { sonnet: usage }, modelCosts: {} };
  }
  sessionSnapshot = {
    id: 'a',
    status: 'ready',
    running: false,
    checkpoints: [{ sha: 'c0ffee11', shortSha: 'c0ffee1', message: '주문 나누기', createdAt: '2026-10-23T00:00:00Z', files: ['a.ts'], passedStages: ['test'] }],
    repository: { remote: 'r', base: 'main', branch: 'b', canCreatePullRequest: true },
  };
  async session(id: string) {
    this.#record('session', id);
    return { ...this.sessionSnapshot, id };
  }
  async checkpointPatch(id: string, sha: string) {
    this.#record('checkpointPatch', id, sha);
    return 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new';
  }
  async restoreCheckpoint(id: string, sha: string) {
    this.#record('restoreCheckpoint', id, sha);
  }
  async reverify(id: string, sha: string) {
    this.#record('reverify', id, sha);
  }
  async deleteSession(id: string) {
    this.#record('deleteSession', id);
  }
  async exportPreview(id: string) {
    this.#record('exportPreview', id);
    return { title: '주문 나누기', canCreate: true, issues: [], checks: [{ id: 'stages_passed', ok: true, detail: '검증 통과' }] };
  }
  async exportSession(id: string, pullRequest: boolean) {
    this.#record('exportSession', id, pullRequest);
    return { sha: 'c0ffee11', commits: 1, forced: false, pullRequest: { url: 'https://example.test/pr/7', created: true } };
  }
  async reviewRound(id: string, restart: boolean) {
    this.#record('reviewRound', id, restart);
  }
  async resolveFinding(id: string, input: { round: number; findingIndex: number; reason: string }) {
    this.#record('resolveFinding', id, input);
  }
  /** 사용량을 물은 기록(refresh 값). 답은 부른 뒤에 정해도 된다(한 박자 뒤에 읽는다) */
  limitsCalls: boolean[] = [];
  limitsResult: { accounts: DeskAccountLimits[]; warning?: string } = { accounts: [] };
  limitsError: Error | undefined;
  limits: ((refresh?: boolean) => Promise<{ accounts: DeskAccountLimits[]; warning?: string }>) | undefined = async (refresh = false) => {
    this.limitsCalls.push(refresh);
    await Promise.resolve();
    if (this.limitsError) throw this.limitsError;
    return this.limitsResult;
  };
  /** 오늘·최근 7일 쓴 양(#925). undefined면 옛 스튜디오처럼 묻지 않는다 */
  spendCalls = 0;
  spendResult: DeskSpend | Error = { today: { tokens: 0, estimated: false, missingPrice: false, rows: [] }, week: { tokens: 0, estimated: false, missingPrice: false, rows: [] } };
  spend: (() => Promise<DeskSpend>) | undefined = async () => {
    this.spendCalls += 1;
    await Promise.resolve();
    if (this.spendResult instanceof Error) throw this.spendResult;
    return this.spendResult;
  };
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

  it('같은 CLI의 계정이 둘 이상이면 계정까지 고르고, 그 계정으로 보낸다(#885)', async () => {
    const ctx = setup();
    ctx.client.allowed = ['claude-code', 'codex'];
    ctx.client.accountList = [
      { id: 'claude-code', name: '기본', backend: 'claude-code', builtin: true },
      { id: 'codex', name: '마르코', backend: 'codex' },
      { id: 'acct-1a2b3c4d', name: '피오', backend: 'codex', configDir: '/home/kim/.codex-fio' },
    ];
    ctx.io.type('\x02n');
    await tick();
    expect(ctx.app.state.prompt?.choices).toEqual(['rules', 'claude-code', 'codex', 'codex@acct-1a2b3c4d']);
    ctx.io.type('\t\t\t');
    await tick();
    expect(ctx.io.all).toContain('피오');
    ctx.io.type('고쳐 줘\r');
    await tick();
    expect(ctx.client.started.at(-1)).toMatchObject({ choice: 'codex@acct-1a2b3c4d' });
  });

  it('계정 목록을 받지 못하는 스튜디오(옛 판, 개인 PC 모드 아님)면 지금처럼 CLI만 고른다', async () => {
    const ctx = setup();
    ctx.client.allowed = ['claude-code', 'codex'];
    ctx.client.accounts = async () => {
      throw new Error('404');
    };
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
    expect(plain(ctx.io.all)).toMatch(/● 요청 b +! /);
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
    expect(plain(ctx.io.all)).toMatch(/● 요청 b +! /);
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

describe('desk 작업대: 그냥 셸 칸(#873)', () => {
  class FakeShell implements ShellPty {
    written: string[] = [];
    sizes: Array<[number, number]> = [];
    killed = false;
    #data: (data: string) => void = () => {};
    #exit: (event: { exitCode: number }) => void = () => {};
    write(data: string) {
      this.written.push(data);
    }
    resize(cols: number, rows: number) {
      this.sizes.push([cols, rows]);
    }
    kill() {
      this.killed = true;
    }
    onData(listener: (data: string) => void) {
      this.#data = listener;
    }
    onExit(listener: (event: { exitCode: number }) => void) {
      this.#exit = listener;
    }
    emit(data: string) {
      this.#data(data);
    }
    end(code = 0) {
      this.#exit({ exitCode: code });
    }
  }

  function withShell(env: Record<string, string | undefined> = { SHELL: '/bin/zsh', HOME: '/home/me', PATH: '/usr/bin', B_STUDIO_GATE_TOKEN: 'secret', B_STUDIO_LOCAL_TOKEN_FILE: '/x', B_STUDIO_EXPERIMENTAL: '1' }) {
    const shells: FakeShell[] = [];
    const spawns: Array<{ file: string; args: string[]; options: Parameters<SpawnShell>[2] }> = [];
    const spawnShell: SpawnShell = (file, args, options) => {
      spawns.push({ file, args, options });
      const shell = new FakeShell();
      shells.push(shell);
      return shell;
    };
    const ctx = setup(undefined, { spawnShell, shellEnv: env, shellCwd: '/work/shop' });
    return { ...ctx, shells, spawns };
  }

  it('Ctrl-b c는 desk가 직접 띄운 로그인 셸을 고른 칸에 열고, 칸 머리에 검증 밖이라고 보인다', async () => {
    const ctx = withShell();
    ctx.io.type('\x02c');
    await tick();
    expect(ctx.spawns).toHaveLength(1);
    const { file, args, options } = ctx.spawns[0]!;
    expect(file).toBe('/bin/zsh');
    expect(args).toEqual(['-l']);
    expect(options.cwd).toBe('/work/shop');
    expect(options.env.TERM).toBe('xterm-256color');
    expect(options.env.COLORTERM).toBe('truecolor');
    expect(options.env.PATH).toBe('/usr/bin');
    // b-studio의 토큰·설정은 셸에 넘기지 않는다(관문 밖이다)
    expect(Object.keys(options.env).filter((name) => name.startsWith('B_STUDIO_'))).toEqual([]);
    expect(ctx.app.state.slots[0]).toMatch(/^shell:/);
    expect(ctx.io.all).toContain('셸 · 검증 밖');
    // 스튜디오에는 열기·통로를 보내지 않는다
    expect(ctx.client.calls).toEqual([]);
    expect(ctx.client.streams).toEqual([]);
  });

  it('SHELL이 없으면 /bin/sh를 띄운다', async () => {
    const ctx = withShell({ PATH: '/usr/bin' });
    ctx.io.type('\x02c');
    await tick();
    expect(ctx.spawns[0]!.file).toBe('/bin/sh');
  });

  it('친 글자와 붙여 넣은 글은 셸로 가고, 셸 출력은 칸에 그려지며, 크기는 셸에만 맞춘다', async () => {
    const ctx = withShell();
    ctx.io.type('\x02c');
    await tick();
    const shell = ctx.shells[0]!;
    ctx.io.type('ls\r');
    ctx.io.type('\x1b[200~a\nb\x1b[201~');
    await tick();
    expect(shell.written).toEqual(['ls\r', 'a\nb']);
    expect(ctx.client.of('input')).toEqual([]);
    shell.emit('hello-from-shell');
    await tick();
    expect(ctx.io.all).toContain('hello-from-shell');
    ctx.io.resize(100, 24);
    await tick(300);
    expect(shell.sizes.length).toBeGreaterThan(0);
    expect(ctx.client.of('resize')).toEqual([]);
  });

  it('셸이 끝나면 칸 머리에 끝났다고 보이고, Ctrl-b x는 셸을 끝내고 칸을 비운다', async () => {
    const ctx = withShell();
    ctx.io.type('\x02c');
    await tick();
    ctx.shells[0]!.end(0);
    await tick();
    expect(ctx.io.all).toContain('셸이 끝났습니다');
    ctx.io.type('\x02c');
    await tick();
    // 끝난 셸 칸은 묻지 않고 비운다
    expect(ctx.shells).toHaveLength(1);
    ctx.io.type('\x02x');
    await tick();
    expect(ctx.app.state.slots[0]).toBeUndefined();
    expect(ctx.app.state.confirm).toBeUndefined();
  });

  it('살아 있는 셸 칸의 x는 한 번 묻고, 그만두면 셸이 그대로이고 y면 끝낸다', async () => {
    const ctx = withShell();
    ctx.io.type('\x02c');
    await tick();
    const shell = ctx.shells[0]!;
    ctx.io.type('\x02x');
    await tick();
    expect(ctx.app.state.confirm?.action).toBe('close');
    ctx.io.type('n');
    await tick();
    expect(shell.killed).toBe(false);
    expect(ctx.app.state.slots[0]).toMatch(/^shell:/);
    ctx.io.type('\x02x');
    await tick();
    ctx.io.type('y');
    await tick();
    expect(shell.killed).toBe(true);
    expect(ctx.app.state.slots[0]).toBeUndefined();
  });

  it('칸 수를 줄여 가려진 셸 칸은 끝나지 않고 출력을 계속 받으며, 칸 수를 늘리면 그 자리에 다시 보인다', async () => {
    const ctx = withShell();
    ctx.io.type('\x02l');
    ctx.io.type('\x022');
    ctx.io.type('\x02c');
    await tick();
    const shell = ctx.shells[0]!;
    expect(ctx.app.state.slots[1]).toMatch(/^shell:/);
    // 2 → 4 → 1
    ctx.io.type('\x02l');
    ctx.io.type('\x02l');
    await tick();
    expect(ctx.app.state.layout).toBe(1);
    expect(shell.killed).toBe(false);
    expect(ctx.io.all).toContain('가려짐');
    shell.emit('built-while-hidden');
    await tick();
    // 1 → 2: 같은 자리에 다시 보이고, 가려진 동안의 출력도 남아 있다
    ctx.io.type('\x02l');
    await tick();
    expect(ctx.app.state.slots[1]).toMatch(/^shell:/);
    expect(ctx.io.all).toContain('built-while-hidden');
  });

  it('크게 보기로 가린 셸 칸도 끝나지 않는다', async () => {
    const ctx = withShell();
    ctx.io.type('\x02l');
    ctx.io.type('\x022');
    ctx.io.type('\x02c');
    await tick();
    ctx.io.type('\x021\x02z');
    await tick();
    expect(ctx.app.state.zoom).toBe(true);
    expect(ctx.shells[0]!.killed).toBe(false);
  });

  it('셸 칸을 고른 채 새 요청을 보내면 세션은 만들되 셸 칸을 덮지 않는다', async () => {
    const ctx = withShell();
    ctx.io.type('\x02c');
    await tick();
    ctx.io.type('\x02n');
    await tick();
    ctx.io.type('고쳐 줘\r');
    await tick(400);
    expect(ctx.app.state.slots[0]).toMatch(/^shell:/);
    expect(ctx.shells[0]!.killed).toBe(false);
    expect(ctx.app.state.message).toContain('셸');
  });

  it('셸 칸이 살아 있으면 나가기 전에 한 번 묻고, y면 셸을 끝내고 나간다', async () => {
    const ctx = withShell();
    ctx.io.type('\x02c');
    await tick();
    ctx.io.type('\x02q');
    await tick();
    expect(ctx.app.state.confirm?.action).toBe('quit');
    ctx.io.type('n');
    await tick();
    expect(ctx.app.state.confirm).toBeUndefined();
    ctx.io.type('\x02q');
    await tick();
    ctx.io.type('y');
    await expect(ctx.done).resolves.toBe(0);
    expect(ctx.shells[0]!.killed).toBe(true);
  });

  it('배치를 저장할 때 셸 칸은 남기지 않는다(desk를 나가면 셸은 끝난다)', async () => {
    const saved: DeskLayout[] = [];
    const spawnShell: SpawnShell = () => new FakeShell();
    const ctx = setup(undefined, { spawnShell, shellEnv: {}, shellCwd: '/tmp', layoutStore: { load: () => undefined, save: (layout) => void saved.push(layout) } });
    ctx.io.type('\x02c');
    await tick();
    expect(ctx.app.state.slots[0]).toMatch(/^shell:/);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)?.slots[0]).toBeUndefined();
  });
});

describe('desk 작업대: 스페이스 화면(#887)', () => {
  const click = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`;
  const size = { cols: 120, rows: 30 };
  const items = [item('a'), item('b', { backend: 'codex' }), item('c', { projectName: 'blog' })];

  it('열린 칸이 없으면 스페이스 화면(카드)부터 보이고, 되살린 칸이 있으면 칸 화면이다', async () => {
    const fresh = setup(items);
    expect(fresh.app.state.view).toBe('space');
    expect(fresh.io.all).toContain('╭');
    const store: DeskLayoutStore = { load: () => ({ layout: 1, slots: ['a', undefined, undefined, undefined], focus: 0, zoom: false, sidebarHidden: false }), save: () => {} };
    expect(setup(items, { layoutStore: store }).app.state.view).toBeUndefined();
  });

  it('카드를 누르면 고르고, 고른 카드를 한 번 더 누르면 고른 칸에 열고 칸 화면으로 간다', async () => {
    const ctx = setup(items);
    const cards = spaceScreen(ctx.app.state, spaceRect(ctx.app.state, size)).cards;
    const second = cards.find((card) => card.index === 1)!;
    ctx.io.type(click(second.rect.x + 2, second.rect.y + 1));
    await tick();
    expect(ctx.app.state.selected).toBe(1);
    expect(ctx.client.of('open')).toEqual([]);
    ctx.io.type(click(second.rect.x + 2, second.rect.y + 1));
    await tick();
    expect(ctx.app.state.slots[0]).toBe('b');
    expect(ctx.app.state.view).toBeUndefined();
    expect(ctx.client.of('open', 'b')).toHaveLength(1);
  });

  it('사이드바의 스페이스를 누르면 그 스페이스의 스페이스 화면을 연다', async () => {
    const ctx = setup(items);
    ctx.io.type('\x1b');
    await tick();
    expect(ctx.app.state.view).toBeUndefined();
    const rows = sidebarRows(ctx.app.state.items, ctx.app.state.selected, new Map(), 32);
    const blog = rows.findIndex((row) => row.space === 'blog');
    ctx.io.type(click(3, 1 + blog));
    await tick();
    expect(ctx.app.state.view).toBe('space');
    expect(ctx.app.state.selected).toBe(2);
  });

  it('카드 그림은 옵션으로 받은 그림을 쓴다', async () => {
    const red = spriteFromRows(['rr', 'rr'], { r: '#ff0000' });
    const ctx = setup(items, { sprites: { 'claude-code': red } });
    expect(ctx.io.all).toContain('\x1b[38;2;255;0;0m\x1b[48;2;255;0;0m▀');
  });

  it('desk.json의 밝은 팔레트와 256색 낮춤을 따른다', async () => {
    const ctx = setup(items, { theme: 'light', truecolor: false });
    expect(ctx.app.state.theme).toEqual({ name: 'light', depth: '256' });
    expect(ctx.io.all).not.toMatch(/\x1b\[[34]8;2;/);
  });
});

describe('desk 작업대: 카드 움짤(#902)', () => {
  const items = [item('a'), item('b', { backend: 'codex' })];
  const red = spriteFromRows(['r'], { r: '#ff0000' }).pixels;
  const green = spriteFromRows(['g'], { g: '#00ff00' }).pixels;
  const animated: Sprite = { width: 1, height: 1, pixels: red, frames: [{ pixels: red, delay: 100 }, { pixels: green, delay: 100 }] };
  const catalog = (sprite: Sprite = animated): SpriteCatalog & { picked: string[] } => {
    const picked: string[] = [];
    return { picked, pick: (id) => (picked.push(id), { sprite }) };
  };
  /** 마지막으로 쓴 프레임부터 지금까지 쓴 것 */
  const since = (io: { out: string[] }, from: number) => io.out.slice(from).join('');

  it('이름 붙인 그림이 없는 세션은 그림 폴더에서 고른 그림을 쓰고, AI 이름으로 붙인 그림이 있으면 그것이 먼저다', async () => {
    const named = spriteFromRows(['b'], { b: '#0000ff' });
    const spriteCatalog = catalog();
    const ctx = setup(items, { spriteCatalog, sprites: { codex: named } });
    await tick();
    expect(spriteCatalog.picked).toEqual(['a']);
    expect(ctx.app.state.sprites?.a).toBe(animated);
    expect(ctx.app.state.sprites?.b).toBeUndefined();
  });

  it('스페이스 화면에서는 움짤 프레임마다 다시 그리고, 칸 화면·도움말·창 포커스를 잃으면 멈춘다', async () => {
    const ctx = setup([item('a')], { spriteCatalog: catalog() });
    await tick();
    expect(ctx.io.all).toContain('38;2;255;0;0m▄');
    let mark = ctx.io.out.length;
    await tick(120);
    expect(since(ctx.io, mark)).toContain('38;2;0;255;0m▄');
    // 창이 포커스를 잃으면 멈춘다(포커스 알림은 키로 다루지 않는다)
    ctx.io.type('\x1b[O');
    await tick(50);
    mark = ctx.io.out.length;
    const clock = ctx.app.state.spriteClock;
    await tick(500);
    expect(ctx.app.state.spriteClock).toBe(clock);
    expect(since(ctx.io, mark)).not.toContain('▄');
    ctx.io.type('\x1b[I');
    await tick(150);
    expect(ctx.app.state.spriteClock).not.toBe(clock);
    // 도움말에서는 멈춘다
    ctx.io.type('?');
    await tick(50);
    const helpClock = ctx.app.state.spriteClock;
    await tick(500);
    expect(ctx.app.state.spriteClock).toBe(helpClock);
    ctx.io.type('x');
    await tick(150);
    // 칸 화면에서는 멈춘다
    ctx.io.type('\x1b');
    await tick(50);
    expect(ctx.app.state.view).toBeUndefined();
    const paneClock = ctx.app.state.spriteClock;
    await tick(500);
    expect(ctx.app.state.spriteClock).toBe(paneClock);
  });

  it('animate가 꺼져 있으면 움직이지 않고 창 포커스 알림도 켜지 않는다', async () => {
    const ctx = setup([item('a')], { spriteCatalog: catalog(), animate: false });
    await tick(500);
    expect(ctx.app.state.spriteClock).toBeUndefined();
    expect(ctx.io.all).not.toContain('\x1b[?1004h');
  });

  it('Kitty 그래픽이면 그림을 그 자리 글자보다 먼저 보내고, 나갈 때 보낸 그림을 지운다', async () => {
    const ctx = setup([item('a')], { spriteCatalog: catalog(), graphics: 'kitty' });
    await tick();
    const all = ctx.io.all;
    const sent = all.indexOf('\x1b_Ga=T,U=1,f=100,');
    expect(sent).toBeGreaterThan(-1);
    expect(all.indexOf('\u{10EEEE}')).toBeGreaterThan(sent);
    expect(all).not.toContain('▄');
    // 둘째 프레임은 처음 보일 때 보낸다
    const mark = ctx.io.out.length;
    await tick(120);
    expect(since(ctx.io, mark)).toContain('\x1b_Ga=T,U=1,f=100,');
    ctx.io.type('\x02q');
    await expect(ctx.done).resolves.toBe(0);
    const leave = ctx.io.out.at(-1)!;
    expect(leave.match(/\x1b_Ga=d,d=I,i=\d+,q=2\x1b\\/g)).toHaveLength(2);
    expect(leave).toContain('\x1b[?1004l');
  });
});

describe('desk 작업대: 기록 화면과 세션 자세히(#891)', () => {
  const plain = (ctx: ReturnType<typeof setup>) => ctx.io.all.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '');

  it('Ctrl-b h로 AI별 결과를 불러와 보이고, Tab으로 고른 세션 프로젝트의 토큰 보고서를 불러온다', async () => {
    const ctx = setup();
    ctx.io.type('\x02h');
    await tick();
    expect(ctx.client.recordCalls.map(([name]) => name)).toEqual(['routingStats']);
    expect(plain(ctx)).toMatch(/Claude · 기본\s+4/);
    ctx.io.type('\t');
    await tick();
    expect(ctx.client.recordCalls.at(-1)).toEqual(['tokenReport', 'p1', undefined]);
    expect(plain(ctx)).toContain('합계 5만 토큰');
    ctx.io.type('q');
    await tick();
    ctx.io.type('x');
    await tick();
    // 기록 화면을 닫은 뒤에는 키가 다시 칸으로 간다(빈 칸이라 보낼 곳은 없다)
    expect(ctx.client.of('input')).toEqual([]);
  });

  it('세션 자세히에서 체크포인트 diff를 보고, 묻고 나서 되돌리고, 다시 불러온다', async () => {
    const ctx = setup();
    ctx.io.type('\x02i');
    await tick();
    expect(ctx.client.recordCalls).toEqual([['session', 'a']]);
    expect(plain(ctx)).toContain('주문 나누기');
    ctx.io.type('\r');
    await tick();
    expect(ctx.client.recordCalls.at(-1)).toEqual(['checkpointPatch', 'a', 'c0ffee11']);
    expect(plain(ctx)).toMatch(/a\.ts\s+\+1 -1/);
    ctx.io.type('\x1b');
    await tick(100);
    ctx.io.type('u');
    await tick();
    expect(ctx.client.recordCalls.map(([name]) => name)).not.toContain('restoreCheckpoint');
    ctx.io.type('y');
    await tick();
    expect(ctx.client.recordCalls.slice(-2)).toEqual([['restoreCheckpoint', 'a', 'c0ffee11'], ['session', 'a']]);
    expect(plain(ctx)).toContain('되돌리기를 시작했습니다');
  });

  it('기록 API를 모르는 옛 손님이면 기록 화면에 그 까닭을 보인다', async () => {
    const ctx = setup();
    Object.assign(ctx.client, { routingStats: undefined });
    ctx.io.type('\x02h');
    await tick();
    expect(plain(ctx)).toContain('이 스튜디오는 이 기능을 지원하지 않습니다');
  });

  it('실패하면 그 까닭을 보이고 세션은 그대로 둔다', async () => {
    const ctx = setup();
    ctx.client.failNext.reverify = '지금 체크포인트만 다시 검증할 수 있습니다';
    ctx.io.type('\x02i');
    await tick();
    ctx.io.type('v');
    await tick();
    expect(plain(ctx)).toContain('다시 검증하지 못했습니다: 지금 체크포인트만 다시 검증할 수 있습니다');
  });

  it('두 번 물은 뒤 세션을 지우면 자세히를 닫고 목록을 다시 받는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02i');
    await tick();
    const polls = ctx.client.agentsCalls;
    ctx.io.type('Dy');
    await tick();
    expect(ctx.client.recordCalls.map(([name]) => name)).not.toContain('deleteSession');
    expect(plain(ctx)).toContain('되돌릴 수 없습니다');
    ctx.io.type('y');
    await tick();
    expect(ctx.client.recordCalls.at(-1)).toEqual(['deleteSession', 'a']);
    expect(ctx.client.agentsCalls).toBeGreaterThan(polls);
    expect(plain(ctx)).toContain('세션을 지웠습니다');
  });

  it('올리기 탭은 점검을 부르고, 묻고 나서 PR을 만들어 주소를 링크로 보인다', async () => {
    const ctx = setup();
    ctx.io.type('\x02i');
    await tick();
    ctx.io.type('\t\t');
    await tick();
    expect(ctx.client.recordCalls.at(-1)).toEqual(['exportPreview', 'a']);
    ctx.io.type('py');
    await tick();
    expect(ctx.client.recordCalls.find(([name]) => name === 'exportSession')).toEqual(['exportSession', 'a', true]);
    expect(ctx.io.all).toContain('\x1b]8;;https://example.test/pr/7');
  });
});

describe('desk 작업대: 사용량(#889)', () => {
  const items = [item('a', { accountId: 'acct-1' }), item('b', { backend: 'codex' })];
  const accounts: DeskAccountLimits[] = [
    { id: 'acct-1', backend: 'claude-code', name: '피오', status: 'warn', windows: [{ kind: 'five_hour', usedPercent: 37 }, { kind: 'weekly', usedPercent: 90 }], source: 'claude-oauth', sprite: 'fio.gif' },
    { id: 'codex', backend: 'codex', name: '마르코', status: 'ok', windows: [{ kind: 'weekly', usedPercent: 26 }], source: 'codex-app-server' },
  ];

  it('시작할 때 사용량을 읽어 세션 카드의 막대에 잇고, 1분마다 다시 읽는다', async () => {
    const ctx = setup(items);
    ctx.client.limitsResult = { accounts };
    await tick();
    expect(ctx.client.limitsCalls).toEqual([false]);
    expect(ctx.app.state.limits).toEqual({ a: { fiveHour: { usedPercent: 37 }, weekly: { usedPercent: 90 } }, b: { weekly: { usedPercent: 26 } } });
    expect(ctx.io.all).toContain('90%');
    await tick(58_000);
    expect(ctx.client.limitsCalls).toEqual([false]);
    await tick(2_000);
    expect(ctx.client.limitsCalls).toEqual([false, false]);
  });

  it('Ctrl-b u로 사용량 화면을 열고(방금 읽었으면 다시 묻지 않는다), r로 다시 읽기를 청한다', async () => {
    const ctx = setup(items);
    ctx.client.limitsResult = { accounts };
    await tick();
    ctx.io.type('\x02u');
    await tick();
    expect(ctx.app.state.view).toBe('usage');
    expect(ctx.client.limitsCalls).toEqual([false]);
    const screen = ctx.io.all;
    expect(screen).toContain('사용량');
    expect(screen).toContain('피오');
    expect(screen).toContain('마르코');
    ctx.io.type('r');
    await tick();
    expect(ctx.client.limitsCalls).toEqual([false, true]);
    ctx.io.type('\x1b');
    await tick(50);
    expect(ctx.app.state.view).toBe('space');
  });

  it('계정 그림은 계정의 그림 파일, 없으면 계정 id로 그림 폴더에서 고른다', async () => {
    const blue = spriteFromRows(['b'], { b: '#0000ff' });
    const picked: string[] = [];
    const files: string[] = [];
    const spriteCatalog: SpriteCatalog = { pick: (id) => (picked.push(id), { sprite: blue }), file: (name) => (files.push(name), { sprite: blue }) };
    const ctx = setup(items, { spriteCatalog });
    ctx.client.limitsResult = { accounts };
    await tick();
    ctx.io.type('\x02u');
    await tick();
    expect(files).toEqual(['fio.gif']);
    expect(picked).toContain('codex');
    expect(ctx.app.state.sprites?.['acct:acct-1']).toBe(blue);
    expect(ctx.app.state.sprites?.['acct:codex']).toBe(blue);
  });

  it('사용량을 알려 주지 않는 스튜디오면 묻지 않고, 사용량 화면에 그렇다고 보인다', async () => {
    const client = new FakeClient(items);
    client.limits = undefined;
    const io = new FakeIo();
    const app = new DeskApp(client, items, io);
    void app.run();
    await tick();
    io.type('\x02u');
    await tick();
    expect(app.state.view).toBe('usage');
    expect(io.all).toContain('사용량을 알려 주지 않는 스튜디오');
  });

  it('가장 빠듯한 계정을 맨 위에 두고, 쓴 양도 함께 읽어 사이드바 맨 아래에 가장 빠듯한 한도를 보인다(#925)', async () => {
    const ctx = setup(items);
    ctx.client.limitsResult = { accounts: [accounts[1]!, accounts[0]!] };
    const week = { tokens: 4_000_000, costUsd: 6, estimated: false, missingPrice: false, rows: [] };
    ctx.client.spendResult = { today: { ...week, tokens: 3_000_000 }, week };
    await tick();
    expect(ctx.app.state.usage?.accounts.map((entry) => entry.id)).toEqual(['acct-1', 'codex']);
    expect(ctx.client.spendCalls).toBe(1);
    expect(ctx.app.state.usage?.spend?.today.tokens).toBe(3_000_000);
    expect(stripAnsi(ctx.io.all)).toContain('한도 Claude 주간 90%');
    ctx.io.type('\x02u');
    await tick();
    expect(stripAnsi(ctx.io.all)).toContain('300만 토큰');
  });

  it('쓴 양을 읽지 못해도(옛 스튜디오) 한도는 그대로 보인다(#925)', async () => {
    const ctx = setup(items);
    ctx.client.limitsResult = { accounts };
    ctx.client.spendResult = new Error('스튜디오가 404로 답했습니다');
    await tick();
    expect(ctx.app.state.usage?.accounts).toHaveLength(2);
    expect(ctx.app.state.usage?.spend).toBeUndefined();
    expect(ctx.app.state.usage?.error).toBeUndefined();
  });

  it('사용량을 읽지 못하면 사용량 화면에 까닭을 보이고, 카드 막대는 지난 값을 둔다', async () => {
    const ctx = setup(items);
    ctx.client.limitsResult = { accounts };
    await tick();
    ctx.client.limitsError = new Error('스튜디오가 500으로 답했습니다');
    ctx.io.type('\x02u');
    await tick();
    ctx.io.type('r');
    await tick();
    expect(ctx.app.state.usage?.error).toBe('스튜디오가 500으로 답했습니다');
    expect(ctx.app.state.limits?.a).toBeDefined();
    expect(ctx.io.all).toContain('스튜디오가 500으로 답했습니다');
  });
});

describe('desk 작업대: 여러 AI 비교(#892)', () => {
  const member = (sessionId: string, patch: Partial<DeskFleetMember> = {}): DeskFleetMember => ({ sessionId, backend: 'claude-code', label: '계정 기본', provider: 'claude-code', status: 'done', ...patch });
  const fleetOf = (patch: Partial<DeskFleet> = {}): DeskFleet => ({
    id: 'f1',
    projectId: 'p1',
    projectName: 'shop',
    request: '검색을 추가해줘',
    createdAt: '2026-10-23T00:00:00Z',
    members: [member('m1'), member('m2', { backend: 'codex', status: 'running' })],
    ...patch,
  });

  /** 비교 API까지 있는 가짜 스튜디오 */
  class FleetClient extends FakeClient {
    list: DeskFleet[] = [fleetOf()];
    created: Array<{ projectId: string; request: string; candidates: DeskFleetCandidate[] }> = [];
    winners: Array<[string, string]> = [];
    deleted: string[] = [];
    createError: string | undefined;
    async fleets() {
      return this.list;
    }
    async fleet(id: string) {
      const found = this.list.find((entry) => entry.id === id);
      if (!found) throw new StudioRequestError('Agent Fleet을 찾을 수 없습니다', 404);
      return found;
    }
    async createFleet(input: { projectId: string; request: string; candidates: DeskFleetCandidate[] }) {
      this.created.push(input);
      if (this.createError) throw new StudioRequestError(this.createError, 409);
      const made = fleetOf({ id: 'f2', request: input.request, members: [member('n1'), member('n2')] });
      this.list = [made, ...this.list];
      return made;
    }
    async chooseFleetWinner(id: string, sessionId: string) {
      this.winners.push([id, sessionId]);
      const chosen = { ...(await this.fleet(id)), winnerSessionId: sessionId };
      this.list = this.list.map((entry) => (entry.id === id ? chosen : entry));
      return chosen;
    }
    async deleteFleet(id: string) {
      this.deleted.push(id);
      this.list = this.list.filter((entry) => entry.id !== id);
    }
  }

  function fleetSetup(items: DeskItem[] = [item('a'), item('m1'), item('m2', { backend: 'codex' })], options: DeskAppOptions = {}) {
    const client = new FleetClient(items);
    const io = new FakeIo();
    const app = new DeskApp(client, items, io, options);
    const done = app.run();
    return { client, io, app, done };
  }

  it('Ctrl-b f로 목록을 받아 그리고, Enter로 비교를 연 뒤 a로 참가자 둘을 칸 두 개에 나란히 연다', async () => {
    const ctx = fleetSetup();
    ctx.io.type('\x02f');
    await tick();
    expect(ctx.app.state.fleets).toMatchObject({ mode: 'list', loading: false });
    expect(ctx.io.all).toContain('검색을 추가해줘');
    ctx.io.type('\r');
    await tick();
    expect(ctx.app.state.fleets).toMatchObject({ mode: 'detail', detail: 'f1' });
    ctx.io.type('a');
    await tick();
    expect(ctx.app.state.fleets).toBeUndefined();
    expect(ctx.app.state).toMatchObject({ layout: 2, slots: ['m1', 'm2', undefined, undefined], focus: 0 });
    expect(ctx.client.of('open').map((call) => call.id).sort()).toEqual(['m1', 'm2']);
  });

  it('새 비교: 프로젝트와 허용된 AI·계정을 받아 고르고, 보내면 만든 비교를 보기로 연다', async () => {
    const ctx = fleetSetup();
    ctx.client.allowed = ['claude-code', 'codex'];
    ctx.client.accountList = [
      { id: 'codex', name: 'Codex', backend: 'codex', builtin: true },
      { id: 'acct-pio', name: '피오', backend: 'codex', configDir: '/home/me/.b-studio/accounts/codex-1' },
    ];
    ctx.io.type('\x02f');
    await tick();
    ctx.io.type('n');
    await tick();
    expect(ctx.app.state.fleets?.form).toMatchObject({ loading: false, projects: [{ id: 'p1', name: 'shop' }] });
    expect(ctx.app.state.fleets?.form?.options.map((option) => option.label)).toEqual(['Claude', 'Codex · Codex', 'Codex · 피오']);
    // 요청을 쓰고 Claude와 Codex · 피오를 더해 보낸다
    ctx.io.type('\t검색\t\r\x1b[B\x1b[B\r\t\t\t\r');
    await tick();
    expect(ctx.client.created).toEqual([{ projectId: 'p1', request: '검색', candidates: [{ backend: 'claude-code' }, { backend: 'codex', accountId: 'acct-pio' }] }]);
    expect(ctx.app.state.fleets).toMatchObject({ mode: 'detail', detail: 'f2' });
  });

  it('스튜디오가 비교를 만들지 못하면 입력을 그대로 두고 까닭을 보인다', async () => {
    const ctx = fleetSetup();
    ctx.client.createError = '로컬 Codex를 쓸 수 없습니다: 로그인이 필요합니다';
    ctx.io.type('\x02f');
    await tick();
    ctx.io.type('n');
    await tick();
    ctx.io.type('\t검색\t\r\r\t\t\t\r');
    await tick();
    expect(ctx.app.state.fleets?.form).toMatchObject({ sending: false, error: expect.stringContaining('로그인이 필요합니다'), request: '검색' });
  });

  it('w로 승자를 묻고 y면 고르며, d로 묻고 y면 지운 뒤 목록으로 돌아간다', async () => {
    const ctx = fleetSetup();
    ctx.io.type('\x02f');
    await tick();
    ctx.io.type('\r');
    await tick();
    ctx.io.type('wy');
    await tick();
    expect(ctx.client.winners).toEqual([['f1', 'm1']]);
    expect(ctx.app.state.fleets?.fleets[0]?.winnerSessionId).toBe('m1');
    ctx.io.type('dy');
    await tick();
    expect(ctx.client.deleted).toEqual(['f1']);
    expect(ctx.app.state.fleets).toMatchObject({ mode: 'list', fleets: [] });
  });

  it('진행 중인 참가자가 있으면 보기를 몇 초마다 다시 받고, 닫으면 멈춘다', async () => {
    const ctx = fleetSetup();
    ctx.io.type('\x02f');
    await tick();
    ctx.io.type('\r');
    await tick();
    ctx.client.list = [fleetOf({ members: [member('m1'), member('m2', { backend: 'codex', status: 'done', summary: '검증 통과' })] })];
    await tick(3_100);
    expect(ctx.app.state.fleets?.fleets[0]?.members[1]?.status).toBe('done');
    const spy = vi.spyOn(ctx.client, 'fleet');
    ctx.io.type('\x1b');
    await tick(30);
    ctx.io.type('\x1b');
    await tick(10_000);
    expect(ctx.app.state.fleets).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('비교 API가 없는 옛 스튜디오면 열지 않고 알린다', async () => {
    const ctx = setup();
    ctx.io.type('\x02f');
    await tick();
    expect(ctx.app.state.fleets).toBeUndefined();
    expect(ctx.app.state.message).toContain('여러 AI 비교');
  });
});
