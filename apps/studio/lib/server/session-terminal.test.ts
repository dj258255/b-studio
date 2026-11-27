import type { AgentGatewayAddress, AgentTerminal, TerminalSize } from '@b-studio/sandbox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSessionTerminal,
  containerOpenOptions,
  disposeSessionTerminal,
  interruptSessionTerminal,
  isTerminalRunnableBackend,
  MAX_TERMINAL_INPUT,
  openSessionTerminal,
  removeContainerAndConfig,
  removeTerminalLeftovers,
  resizeSessionTerminal,
  reviewFixRunner,
  noteSessionTerminalCli,
  sessionTerminalMode,
  sessionTerminalPresence,
  subscribeSessionTerminal,
  terminalBackend,
  writeSessionTerminal,
  type TerminalBackend,
  type TerminalMessage,
  type TerminalTarget,
} from './session-terminal';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noteModReloading, noteModStarted } from './session-terminal-mod';
import { geminiTerminalReason, terminalHomeUser } from './terminal-allowed';

/** 도커 없이 도는 가짜. 자리를 준비한 횟수, 연 터미널, 쓴 입력, 지운 것을 기록한다 */
const address: AgentGatewayAddress = { hookUrl: 'http://host.docker.internal:41001', hookToken: 'hook-token', mcpUrl: 'http://host.docker.internal:41002/mcp', mcpToken: 'mcp-token' };
const CONTAINER_UNREACHABLE = '컨테이너에서 b-studio에 닿지 못합니다. 이 도커 환경에서는 컨테이너가 이 컴퓨터의 루프백 주소(host.docker.internal)에 닿아야 세션 터미널을 쓸 수 있습니다';

function fakeBackend(options: { failPrepare?: string; unreachable?: boolean } = {}) {
  const record = { ensured: [] as string[], removed: [] as string[], terminals: [] as Array<FakeTerminal>, gateways: [] as Array<AgentGatewayAddress | undefined>, probed: [] as string[], targets: [] as TerminalTarget[], prompts: [] as Array<string | undefined>, resumes: [] as Array<string | undefined> };
  const backend: TerminalBackend = {
    async prepare(target, gateway) {
      record.ensured.push(target.sandboxId);
      record.gateways.push(gateway);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (options.failPrepare) throw new Error(options.failPrepare);
      return `${target.sandboxId}-agent`;
    },
    open(place, { id, size, target, initialPrompt, resumeConversation }) {
      record.targets.push(target);
      record.prompts.push(initialPrompt);
      record.resumes.push(resumeConversation);
      const terminal = new FakeTerminal(place, id, size);
      record.terminals.push(terminal);
      return terminal;
    },
    async remove(sandboxId) {
      record.removed.push(sandboxId);
    },
    async reachable(place) {
      record.probed.push(place);
      return options.unreachable !== true;
    },
    unreachable: CONTAINER_UNREACHABLE,
  };
  return { backend, record };
}

class FakeTerminal implements AgentTerminal {
  written: string[] = [];
  sizes: TerminalSize[] = [];
  closed = false;
  #data: Array<(chunk: Buffer) => void> = [];
  #exit: Array<(code: number | null) => void> = [];
  constructor(
    readonly container: string,
    readonly id: string,
    size: TerminalSize,
  ) {
    this.sizes.push(size);
  }
  write(data: string) {
    this.written.push(data);
  }
  async resize(size: TerminalSize) {
    this.sizes.push(size);
  }
  onData(listener: (chunk: Buffer) => void) {
    this.#data.push(listener);
  }
  onExit(listener: (code: number | null) => void) {
    this.#exit.push(listener);
  }
  close() {
    this.closed = true;
  }
  emit(text: string | Buffer) {
    for (const listener of this.#data) listener(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'));
  }
  exit(code: number | null) {
    for (const listener of this.#exit) listener(code);
  }
}

const target = { sandboxId: 'studio-orders-abc123', root: '/work/orders', projectId: 'orders' };
const decode = (messages: TerminalMessage[]) => messages.flatMap((message) => (message.kind === 'data' ? [Buffer.from(message.data, 'base64').toString('utf8')] : [])).join('');
let session = 0;
let id: string;

beforeEach(() => {
  // 터미널 상태는 전역에 있다. 테스트마다 다른 세션 id를 쓴다
  id = `s-${++session}`;
});

describe('세션 터미널 (이슈 #673)', () => {
  it('동시에 여러 번 열어도 컨테이너와 터미널은 하나다. 이미 열려 있으면 크기만 맞춘다', async () => {
    const { backend, record } = fakeBackend();
    await Promise.all([openSessionTerminal(id, target, { cols: 100, rows: 30 }, backend), openSessionTerminal(id, target, { cols: 100, rows: 30 }, backend)]);
    expect(record.ensured).toEqual(['studio-orders-abc123']);
    expect(record.terminals).toHaveLength(1);
    expect(record.terminals[0]!.container).toBe('studio-orders-abc123-agent');

    await openSessionTerminal(id, target, { cols: 132, rows: 45 }, backend);
    expect(record.terminals).toHaveLength(1);
    expect(record.terminals[0]!.sizes.at(-1)).toEqual({ cols: 132, rows: 45 });
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('출력을 구독자에게 base64로 전하고, 나중에 붙은 화면에는 최근 출력과 상태를 곧바로 준다', async () => {
    const { backend, record } = fakeBackend();
    const first: TerminalMessage[] = [];
    const stop = subscribeSessionTerminal(id, (message) => first.push(message));
    expect(first).toEqual([{ kind: 'status', state: 'closed' }, { kind: 'cli', alive: false }]);

    await openSessionTerminal(id, target, { cols: 100, rows: 30 }, backend);
    record.terminals[0]!.emit(Buffer.from([0x1b, 0x5b, 0x32, 0x4a]));
    record.terminals[0]!.emit('한글 출력\r\n');
    expect(first.map((message) => (message.kind === 'status' ? message.state : message.kind))).toEqual(['closed', 'cli', 'opening', 'open', 'data', 'data']);
    expect(decode(first)).toBe('\u001b[2J한글 출력\r\n');

    const late: TerminalMessage[] = [];
    const stopLate = subscribeSessionTerminal(id, (message) => late.push(message));
    expect(decode(late)).toBe('\u001b[2J한글 출력\r\n');
    expect(late.at(-2)).toEqual({ kind: 'status', state: 'open' });
    expect(late.at(-1)).toEqual({ kind: 'cli', alive: false });

    stop();
    stopLate();
    // 화면이 모두 닫혀도 터미널은 살아 있다
    expect(() => writeSessionTerminal(id, 'ls\r')).not.toThrow();
    expect(record.terminals[0]!.written).toEqual(['ls\r']);
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('에이전트 CLI가 떠 있는지를 화면에 알린다. 터미널이 닫히거나 끝나면 떠 있지 않은 것으로 돌린다(이슈 #689)', async () => {
    const { backend, record } = fakeBackend();
    const alive = (messages: TerminalMessage[]) => messages.flatMap((message) => (message.kind === 'cli' ? [message.alive] : []));
    const seen: TerminalMessage[] = [];
    subscribeSessionTerminal(id, (message) => seen.push(message));
    // 터미널이 열려 있지 않으면 떴다는 알림을 받지 않는다(닫힌 터미널에 "떠 있음"이 남지 않게)
    noteSessionTerminalCli(id, true);
    expect(alive(seen)).toEqual([false]);

    await openSessionTerminal(id, target, {}, backend);
    noteSessionTerminalCli(id, true);
    noteSessionTerminalCli(id, true);
    expect(alive(seen)).toEqual([false, true]);
    // 나중에 붙은 화면도 지금 값을 받는다
    const late: TerminalMessage[] = [];
    subscribeSessionTerminal(id, (message) => late.push(message))();
    expect(alive(late)).toEqual([true]);

    // CLI가 끝났다고 알려 오면
    noteSessionTerminalCli(id, false);
    expect(alive(seen)).toEqual([false, true, false]);

    // 알림 없이 터미널이 끝나도(프로세스가 죽었다) 떠 있지 않은 것으로 돌린다
    noteSessionTerminalCli(id, true);
    record.terminals[0]!.exit(137);
    expect(alive(seen)).toEqual([false, true, false, true, false]);

    // 닫을 때도 같다
    await openSessionTerminal(id, target, {}, backend);
    noteSessionTerminalCli(id, true);
    closeSessionTerminal(id);
    expect(alive(seen).at(-1)).toBe(false);
    // 모르는 세션은 조용히 넘어간다
    expect(() => noteSessionTerminalCli('없는-세션', true)).not.toThrow();
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('첫 요청을 넘겨 연 터미널은 CLI가 떴다고 알려 오기 전까지 시작을 기다린다고 남긴다(#966). 뜨거나 닫히면 지운다', async () => {
    const { backend } = fakeBackend();
    const accepting: TerminalBackend = { ...backend, acceptsInitialPrompt: true };
    const before = Date.now();
    await openSessionTerminal(id, target, {}, accepting, { initialPrompt: '주문 화면 고쳐 줘' });
    const pending = sessionTerminalPresence(id);
    expect(pending?.cliAlive).toBe(false);
    expect(pending?.startPendingSince).toBeGreaterThanOrEqual(before);
    // 폴더 신뢰에 답해 CLI가 뜨면 기다림이 아니다
    noteSessionTerminalCli(id, true);
    expect(sessionTerminalPresence(id)).toEqual({ cliAlive: true });
    // CLI가 끝나도 다시 시작을 기다리는 것은 아니다(첫 요청은 이미 넘겼다)
    noteSessionTerminalCli(id, false);
    expect(sessionTerminalPresence(id)).toEqual({ cliAlive: false });
    await disposeSessionTerminal(id, target.sandboxId, backend);

    // 신뢰 창에서 답하지 않고 닫으면 기다림도 지운다
    await openSessionTerminal(id, target, {}, accepting, { initialPrompt: '주문 화면 고쳐 줘' });
    expect(sessionTerminalPresence(id)?.startPendingSince).toBeDefined();
    closeSessionTerminal(id);
    expect(sessionTerminalPresence(id)?.startPendingSince).toBeUndefined();
    await disposeSessionTerminal(id, target.sandboxId, backend);

    // 첫 요청 없이 연 터미널은 기다리지 않는다
    await openSessionTerminal(id, target, {}, accepting);
    expect(sessionTerminalPresence(id)?.startPendingSince).toBeUndefined();
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('되돌려 주는 최근 출력에는 상한이 있다(오래된 것부터 버린다)', async () => {
    const { backend, record } = fakeBackend();
    await openSessionTerminal(id, target, {}, backend);
    for (let index = 0; index < 20; index++) record.terminals[0]!.emit(Buffer.alloc(64 * 1024, 65 + index));
    const late: TerminalMessage[] = [];
    subscribeSessionTerminal(id, (message) => late.push(message))();
    const replay = Buffer.concat(late.flatMap((message) => (message.kind === 'data' ? [Buffer.from(message.data, 'base64')] : [])));
    expect(replay.length).toBeLessThanOrEqual(512 * 1024);
    expect(replay.length).toBeGreaterThan(256 * 1024);
    // 마지막 조각은 남아 있다
    expect(replay.at(-1)).toBe(65 + 19);
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('터미널이 끝나면 알리고, 다시 열면 새 터미널이 된다. 옛 터미널의 늦은 종료가 새것을 지우지 않는다', async () => {
    const { backend, record } = fakeBackend();
    const messages: TerminalMessage[] = [];
    subscribeSessionTerminal(id, (message) => messages.push(message));
    await openSessionTerminal(id, target, {}, backend);
    record.terminals[0]!.exit(0);
    expect(messages.at(-1)).toEqual({ kind: 'exit', code: 0 });
    expect(() => writeSessionTerminal(id, 'x')).toThrow('터미널이 열려 있지 않습니다');

    await openSessionTerminal(id, target, {}, backend);
    expect(record.terminals).toHaveLength(2);
    closeSessionTerminal(id);
    await openSessionTerminal(id, target, {}, backend);
    expect(record.terminals).toHaveLength(3);
    // 닫은 두 번째 터미널의 종료가 뒤늦게 온다
    record.terminals[1]!.exit(143);
    expect(() => writeSessionTerminal(id, 'y')).not.toThrow();
    expect(record.terminals[2]!.written).toEqual(['y']);
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('세션을 다시 열어 샌드박스가 바뀌면 옛 터미널과 컨테이너를 정리하고 새로 연다', async () => {
    const { backend, record } = fakeBackend();
    await openSessionTerminal(id, target, {}, backend);
    await openSessionTerminal(id, { sandboxId: 'studio-orders-def456', root: '/work/orders', projectId: 'orders' }, {}, backend);
    expect(record.terminals[0]!.closed).toBe(true);
    expect(record.removed).toEqual(['studio-orders-abc123']);
    expect(record.terminals[1]!.container).toBe('studio-orders-def456-agent');
    await disposeSessionTerminal(id, 'studio-orders-def456', backend);
  });

  it('화면이 출력 통로를 먼저 열고 그다음에 "열기"를 보내도, 먼저 붙은 화면이 출력을 받는다', async () => {
    const { backend, record } = fakeBackend();
    const messages: TerminalMessage[] = [];
    subscribeSessionTerminal(id, (message) => messages.push(message));
    await openSessionTerminal(id, target, {}, backend);
    record.terminals[0]!.emit('ready\r\n');
    expect(decode(messages)).toBe('ready\r\n');
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('컨테이너를 띄우지 못하면 사유를 던지고 화면에도 알린다. 다시 열 수 있다', async () => {
    const failing = fakeBackend({ failPrepare: '에이전트 컨테이너의 .git 보호를 확인하지 못해 컨테이너를 지웠습니다' });
    const messages: TerminalMessage[] = [];
    subscribeSessionTerminal(id, (message) => messages.push(message));
    await expect(openSessionTerminal(id, target, {}, failing.backend)).rejects.toThrow('터미널을 열지 못했습니다: 에이전트 컨테이너의 .git 보호');
    expect(messages.at(-1)).toMatchObject({ kind: 'status', state: 'closed', message: expect.stringContaining('.git 보호') });
    expect(failing.record.terminals).toHaveLength(0);

    const working = fakeBackend();
    await openSessionTerminal(id, target, {}, working.backend);
    expect(working.record.terminals).toHaveLength(1);
    await disposeSessionTerminal(id, target.sandboxId, working.backend);
  });

  it('컨테이너를 띄우는 동안 세션이 멈추면 방금 띄운 컨테이너를 지우고 터미널을 열지 않는다', async () => {
    const { backend, record } = fakeBackend();
    let alive = true;
    const opening = openSessionTerminal(id, { ...target, alive: () => alive }, {}, backend);
    // prepare가 도는 사이에 세션이 멈춘다
    alive = false;
    await expect(opening).rejects.toThrow('세션이 멈췄습니다');
    expect(record.ensured).toEqual(['studio-orders-abc123']);
    expect(record.removed).toEqual(['studio-orders-abc123']);
    expect(record.terminals).toHaveLength(0);

    // 이미 멈춘 세션이면 컨테이너를 띄우지도 않는다
    const again = fakeBackend();
    await expect(openSessionTerminal(id, { ...target, alive: () => false }, {}, again.backend)).rejects.toThrow('세션이 멈췄습니다');
    expect(again.record.ensured).toEqual([]);
  });

  it('여는 도중에 정리가 오면 열기가 끝나기를 기다렸다가 닫고 지운다(지운 뒤에 터미널이 생기지 않는다)', async () => {
    const { backend, record } = fakeBackend();
    const opening = openSessionTerminal(id, target, {}, backend);
    const disposing = disposeSessionTerminal(id, target.sandboxId, backend);
    await Promise.all([opening, disposing]);
    expect(record.terminals).toHaveLength(1);
    expect(record.terminals[0]!.closed).toBe(true);
    expect(record.removed).toEqual(['studio-orders-abc123']);
    expect(() => writeSessionTerminal(id, 'x')).toThrow('터미널이 열려 있지 않습니다');
  });

  it('너무 긴 입력은 받지 않는다. 열려 있지 않으면 크기 변경은 조용히 넘긴다', async () => {
    const { backend } = fakeBackend();
    await expect(resizeSessionTerminal(id, { cols: 80, rows: 24 })).resolves.toBeUndefined();
    await openSessionTerminal(id, target, {}, backend);
    expect(() => writeSessionTerminal(id, 'a'.repeat(MAX_TERMINAL_INPUT + 1))).toThrow('너무 깁니다');
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('세션이 멈추면 터미널을 닫고 컨테이너를 지운다. 터미널을 연 적이 없어도 컨테이너는 지운다', async () => {
    const { backend, record } = fakeBackend();
    await disposeSessionTerminal(id, target.sandboxId, backend);
    expect(record.removed).toEqual(['studio-orders-abc123']);

    await openSessionTerminal(id, target, {}, backend);
    await disposeSessionTerminal(id, target.sandboxId, backend);
    expect(record.terminals[0]!.closed).toBe(true);
    expect(record.removed).toEqual(['studio-orders-abc123', 'studio-orders-abc123']);
    expect(() => writeSessionTerminal(id, 'x')).toThrow('터미널이 열려 있지 않습니다');
  });

  it('관문이 있으면 먼저 띄우고, 그 주소를 적은 설정을 컨테이너에 붙이고, 컨테이너에서 닿는 것을 확인한 뒤에 연다', async () => {
    const { backend, record } = fakeBackend();
    const order: string[] = [];
    const gateway = async () => {
      order.push('gateway');
      return address;
    };
    const watched: TerminalBackend = {
      ...backend,
      prepare: async (given, config) => {
        order.push('container');
        return backend.prepare(given, config);
      },
      reachable: async (container) => {
        order.push('probe');
        return backend.reachable(container);
      },
      open: (container, options) => {
        order.push('open');
        return backend.open(container, options);
      },
    };
    await openSessionTerminal(id, { ...target, gateway }, { cols: 80, rows: 24 }, watched);
    // CLI는 뜨자마자 훅을 부른다. 관문이 먼저 떠 있어야 하고, 닿는 것을 본 뒤에 연다
    expect(order).toEqual(['gateway', 'container', 'probe', 'open']);
    expect(record.gateways).toEqual([address]);
    expect(record.probed).toEqual([`${target.sandboxId}-agent`]);
    await disposeSessionTerminal(id, target.sandboxId, backend);

    // 관문 없이 여는 호출(옛 호출자)은 설정을 붙이지 않고 닿는지도 묻지 않는다
    const plain = fakeBackend();
    id = `s-${++session}`;
    await openSessionTerminal(id, target, { cols: 80, rows: 24 }, plain.backend);
    expect(plain.record.gateways).toEqual([undefined]);
    expect(plain.record.probed).toEqual([]);
    await disposeSessionTerminal(id, target.sandboxId, plain.backend);
  });

  it('관문을 띄우지 못하면 터미널을 열지 않는다(훅 없는 CLI를 관문이 붙은 것처럼 내주지 않는다)', async () => {
    const { backend, record } = fakeBackend();
    const gateway = async (): Promise<AgentGatewayAddress> => {
      throw new Error('포트를 열지 못했습니다');
    };
    await expect(openSessionTerminal(id, { ...target, gateway }, { cols: 80, rows: 24 }, backend)).rejects.toThrow('터미널을 열지 못했습니다: 포트를 열지 못했습니다');
    expect(record.ensured).toEqual([]);
    expect(record.terminals).toEqual([]);
  });

  it('컨테이너에서 관문에 닿지 못하면 터미널을 열지 않고 사유를 알린다(관문 없이 열어 주지 않는다). 닿게 되면 다시 열 수 있다', async () => {
    const { backend, record } = fakeBackend({ unreachable: true });
    const messages: TerminalMessage[] = [];
    subscribeSessionTerminal(id, (message) => messages.push(message));
    await expect(openSessionTerminal(id, { ...target, gateway: async () => address }, { cols: 80, rows: 24 }, backend)).rejects.toThrow('컨테이너에서 b-studio에 닿지 못합니다');
    expect(record.terminals).toEqual([]);
    expect(messages.at(-1)).toMatchObject({ kind: 'status', state: 'closed', message: expect.stringContaining('host.docker.internal') });

    const reachable = fakeBackend();
    await openSessionTerminal(id, { ...target, gateway: async () => address }, { cols: 80, rows: 24 }, reachable.backend);
    expect(reachable.record.terminals).toHaveLength(1);
    expect(messages.at(-1)).toEqual({ kind: 'status', state: 'open' });
    await disposeSessionTerminal(id, target.sandboxId, reachable.backend);
  });

  it('실행을 취소하면 CLI에 Esc를 보낸다. 터미널이 없으면 아무 일도 하지 않는다', async () => {
    const { backend, record } = fakeBackend();
    interruptSessionTerminal(id);
    await openSessionTerminal(id, target, { cols: 80, rows: 24 }, backend);
    interruptSessionTerminal(id);
    expect(record.terminals[0]!.written).toEqual(['\x1b']);
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('sessionTerminalMode: 없음·빈 값은 host(기본), container는 container, host는 host, 그 밖은 던진다', () => {
    expect(sessionTerminalMode({})).toBe('host');
    expect(sessionTerminalMode({ B_STUDIO_TERMINAL: '' })).toBe('host');
    expect(sessionTerminalMode({ B_STUDIO_TERMINAL: 'container' })).toBe('container');
    expect(sessionTerminalMode({ B_STUDIO_TERMINAL: 'host' })).toBe('host');
    expect(() => sessionTerminalMode({ B_STUDIO_TERMINAL: 'hosts' })).toThrow('B_STUDIO_TERMINAL은 container, host 중 하나여야 합니다');
  });

  it('관문에 닿지 못하면 그 백엔드의 안내 글을 그대로 보인다(방식마다 다르다)', async () => {
    const { backend } = fakeBackend({ unreachable: true });
    const host: TerminalBackend = { ...backend, unreachable: '이 컴퓨터에서 b-studio의 관문에 닿지 못합니다' };
    const messages: TerminalMessage[] = [];
    subscribeSessionTerminal(id, (message) => messages.push(message));
    await expect(openSessionTerminal(id, { ...target, gateway: async () => address }, {}, host)).rejects.toThrow('이 컴퓨터에서 b-studio의 관문에 닿지 못합니다');
    expect(messages.at(-1)).toMatchObject({ kind: 'status', state: 'closed', message: '이 컴퓨터에서 b-studio의 관문에 닿지 못합니다' });
  });

  it('첫 요청(#836): 받는 백엔드면 새로 열 때만 넘기고 넘겼다고 알린다. 이미 열렸거나 남이 여는 중이거나 받지 않는 백엔드면 넘기지 않는다', async () => {
    const { backend, record } = fakeBackend();
    const accepting: TerminalBackend = { ...backend, acceptsInitialPrompt: true };
    const [first, second] = await Promise.all([
      openSessionTerminal(id, target, {}, accepting, { initialPrompt: '주문 화면 고쳐 줘' }),
      openSessionTerminal(id, target, {}, accepting, { initialPrompt: '다른 요청' }),
    ]);
    expect(first).toEqual({ initialPromptUsed: true });
    expect(second).toEqual({ initialPromptUsed: false });
    expect(record.prompts).toEqual(['주문 화면 고쳐 줘']);
    expect(await openSessionTerminal(id, target, {}, accepting, { initialPrompt: '또' })).toEqual({ initialPromptUsed: false });
    expect(record.prompts).toHaveLength(1);
    await disposeSessionTerminal(id, target.sandboxId, backend);

    const other = `${id}-container`;
    expect(await openSessionTerminal(other, target, {}, backend, { initialPrompt: '주문 화면 고쳐 줘' })).toEqual({ initialPromptUsed: false });
    expect(record.prompts.at(-1)).toBeUndefined();
    await disposeSessionTerminal(other, target.sandboxId, backend);
  });

  it('지난 대화(#872): 이 스튜디오에서 그 샌드박스의 터미널을 처음 열 때만 이어 붙인다. 첫 요청이 있거나 받지 않는 백엔드면 넘기지 않는다', async () => {
    const { backend, record } = fakeBackend();
    const accepting: TerminalBackend = { ...backend, acceptsInitialPrompt: true, acceptsResume: true };
    const resuming = { ...target, resumeConversation: () => 'c-1' };
    // 스튜디오를 다시 띄운 뒤 처음 연다: 이어 붙인다
    await openSessionTerminal(id, resuming, {}, accepting);
    expect(record.resumes).toEqual(['c-1']);
    // 같은 스튜디오에서 CLI·셸이 끝나 다시 연다: 사람이 끝낸 것일 수 있어 새로 띄운다
    record.terminals.at(-1)!.exit(0);
    await openSessionTerminal(id, resuming, {}, accepting);
    expect(record.resumes).toEqual(['c-1', undefined]);
    closeSessionTerminal(id);
    await openSessionTerminal(id, resuming, {}, accepting);
    expect(record.resumes.at(-1)).toBeUndefined();
    // 이어서 작업으로 샌드박스가 바뀌었다: 다시 이어 붙인다
    await openSessionTerminal(id, { ...resuming, sandboxId: 'studio-orders-def456' }, {}, accepting);
    expect(record.resumes.at(-1)).toBe('c-1');
    await disposeSessionTerminal(id, 'studio-orders-def456', backend);

    // 첫 요청이 있으면 새 대화다
    const withPrompt = `${id}-prompt`;
    await openSessionTerminal(withPrompt, resuming, {}, accepting, { initialPrompt: '주문 화면 고쳐 줘' });
    expect(record.resumes.at(-1)).toBeUndefined();
    await disposeSessionTerminal(withPrompt, target.sandboxId, backend);
    // 받지 않는 백엔드(컨테이너 방식)에는 넘기지 않는다
    const container = `${id}-container`;
    await openSessionTerminal(container, resuming, {}, backend);
    expect(record.resumes.at(-1)).toBeUndefined();
    await disposeSessionTerminal(container, target.sandboxId, backend);
    // 기억한 대화가 없으면 넘기지 않는다
    const none = `${id}-none`;
    await openSessionTerminal(none, { ...target, resumeConversation: () => undefined }, {}, accepting);
    expect(record.resumes.at(-1)).toBeUndefined();
    await disposeSessionTerminal(none, target.sandboxId, backend);
  });

  it('open이 Promise를 돌려줘도 열리고, open에 target이 그대로 넘어온다', async () => {
    const { backend, record } = fakeBackend();
    const promiseOpen: TerminalBackend = { ...backend, open: (place, options) => Promise.resolve(backend.open(place, options)) };
    await openSessionTerminal(id, target, {}, promiseOpen);
    expect(record.terminals).toHaveLength(1);
    expect(record.targets).toEqual([target]);
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('찌꺼기 정리는 한쪽이 던져도 다른 쪽을 부른다', async () => {
    const calls: string[] = [];
    const make = (name: string, fail: boolean): TerminalBackend => ({
      async prepare() {
        return name;
      },
      open() {
        throw new Error('이 테스트는 터미널을 열지 않는다');
      },
      async remove() {
        calls.push(name);
        if (fail) throw new Error(`${name} 실패`);
      },
      async reachable() {
        return true;
      },
      unreachable: '',
    });
    await removeTerminalLeftovers('studio-orders-abc123', [make('docker', true), make('host', false)]);
    expect(calls).toEqual(['docker', 'host']);
  });

  it('컨테이너 지우기가 실패해도 토큰이 든 설정은 지우고, 그 실패는 그대로 나온다', async () => {
    const calls: string[] = [];
    const removeContainer = async (id: string) => {
      calls.push(`container:${id}`);
      throw new Error('도커에 닿지 못했습니다');
    };
    const removeConfig = async (id: string) => {
      calls.push(`config:${id}`);
    };
    await expect(removeContainerAndConfig('studio-orders-abc123', removeContainer, removeConfig)).rejects.toThrow('도커에 닿지 못했습니다');
    expect(calls).toEqual(['container:studio-orders-abc123', 'config:studio-orders-abc123']);
  });

  it('설정 지우기가 실패해도 컨테이너 지우기가 성공했으면 던지지 않는다', async () => {
    const calls: string[] = [];
    const removeContainer = async (id: string) => {
      calls.push(`container:${id}`);
    };
    const removeConfig = async (id: string) => {
      calls.push(`config:${id}`);
      throw new Error('설정을 지우지 못했습니다');
    };
    await expect(removeContainerAndConfig('studio-orders-abc123', removeContainer, removeConfig)).resolves.toBeUndefined();
    expect(calls).toEqual(['container:studio-orders-abc123', 'config:studio-orders-abc123']);
  });
});

describe('터미널 감시(백엔드의 watch, 이슈 #695)', () => {
  it('감시가 위반을 알리면 구독자에게 경고를 보내고 target.onViolation을 같은 글로 부른다', async () => {
    const { backend } = fakeBackend();
    let report: ((reason: string) => void) | undefined;
    let stops = 0;
    const watching: TerminalBackend = {
      ...backend,
      watch: (_place, _terminal, _target, reportViolation) => {
        report = reportViolation;
        return () => {
          stops += 1;
        };
      },
    };
    const messages: TerminalMessage[] = [];
    const violations: string[] = [];
    subscribeSessionTerminal(id, (message) => messages.push(message));
    await openSessionTerminal(id, { ...target, onViolation: (reason) => violations.push(reason) }, {}, watching);
    expect(typeof report).toBe('function');
    report!('관문 파일이 바뀌어 되돌렸습니다: settings.json');
    expect(violations).toEqual(['관문 파일이 바뀌어 되돌렸습니다: settings.json']);
    expect(messages.at(-1)).toEqual({ kind: 'warning', message: '관문 파일이 바뀌어 되돌렸습니다: settings.json' });

    // 닫으면 감시가 멈춘다. 두 번 닫아도 한 번만 멈춘다
    closeSessionTerminal(id);
    closeSessionTerminal(id);
    expect(stops).toBe(1);
    await disposeSessionTerminal(id, target.sandboxId, watching);
    expect(stops).toBe(1);
  });

  it('터미널이 끝나면(onExit) 감시가 멈춘다', async () => {
    const { backend, record } = fakeBackend();
    let stops = 0;
    const watching: TerminalBackend = { ...backend, watch: () => () => void (stops += 1) };
    await openSessionTerminal(id, target, {}, watching);
    record.terminals[0]!.exit(0);
    expect(stops).toBe(1);
    await disposeSessionTerminal(id, target.sandboxId, watching);
    expect(stops).toBe(1);
  });

  it('세션을 정리하면(dispose) 감시가 멈춘다', async () => {
    const { backend } = fakeBackend();
    let stops = 0;
    const watching: TerminalBackend = { ...backend, watch: () => () => void (stops += 1) };
    await openSessionTerminal(id, target, {}, watching);
    await disposeSessionTerminal(id, target.sandboxId, watching);
    expect(stops).toBe(1);
  });

  it('watch가 없는 백엔드는 지금과 같이 연다', async () => {
    const { backend, record } = fakeBackend();
    await openSessionTerminal(id, target, {}, backend);
    expect(record.terminals).toHaveLength(1);
    await disposeSessionTerminal(id, target.sandboxId, backend);
  });

  it('기억한 관문이 없으면 조용히 넘어가지 않고 알린다(개발 서버가 모듈을 다시 읽은 경우)', () => {
    const reports: string[] = [];
    const backend = terminalBackend('host');
    expect(typeof backend.watch).toBe('function');
    const stop = backend.watch!('/nonexistent/gateway', new FakeTerminal('/nonexistent/gateway', 'main', { cols: 80, rows: 24 }), target, (reason) => reports.push(reason));
    expect(reports).toEqual(['관문 감시를 시작하지 못했습니다(기억한 관문이 없습니다). 터미널을 닫았다가 다시 여세요']);
    // 멈춤 함수는 안전한 no-op이다
    expect(() => stop()).not.toThrow();
  });
});

describe('Command Code 터미널: mod가 불러와졌다는 신호를 기다린다(보안 검토, ADR-233)', () => {
  const savedEnv = { timeout: process.env.B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS };
  const ccTarget = { ...target, cli: 'commandcode' as const };
  afterEach(() => {
    if (savedEnv.timeout === undefined) delete process.env.B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS;
    else process.env.B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS = savedEnv.timeout;
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('session-start가 시간 안에 오지 않으면 훅 없이 뜬 것으로 본다: 경고를 보내고, 위반으로 알리고, 터미널을 닫는다', async () => {
    process.env.B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS = '40';
    const { backend, record } = fakeBackend();
    const messages: TerminalMessage[] = [];
    const violations: string[] = [];
    subscribeSessionTerminal(id, (message) => messages.push(message));
    await openSessionTerminal(id, { ...ccTarget, onViolation: (reason) => violations.push(reason) }, {}, backend);
    expect(record.terminals[0]!.closed).toBe(false);
    await wait(150);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('session-start');
    expect(messages.some((message) => message.kind === 'warning' && message.message.includes('session-start'))).toBe(true);
    expect(record.terminals[0]!.closed).toBe(true);
    expect(messages.at(-1)).toEqual({ kind: 'status', state: 'closed' });
    await disposeSessionTerminal(id, ccTarget.sandboxId, backend);
  });

  it('session-start가 시간 안에 오면 아무 일도 없다(대조). reload로 끝난 뒤 새 session-start가 오지 않으면 위반이고, 오면 아니다', async () => {
    process.env.B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS = '60';
    const { backend, record } = fakeBackend();
    const violations: string[] = [];
    await openSessionTerminal(id, { ...ccTarget, onViolation: (reason) => violations.push(reason) }, {}, backend);
    await wait(20);
    noteModStarted(id);
    await wait(150);
    expect(violations).toEqual([]);
    expect(record.terminals[0]!.closed).toBe(false);
    // reload 뒤 새 session-start가 온다
    noteModReloading(id);
    await wait(20);
    noteModStarted(id);
    await wait(150);
    expect(violations).toEqual([]);
    // reload 뒤 오지 않는다
    noteModReloading(id);
    await wait(150);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('reload');
    expect(record.terminals[0]!.closed).toBe(true);
    await disposeSessionTerminal(id, ccTarget.sandboxId, backend);
  });

  it('터미널을 닫으면 시계가 선다. commandcode가 아닌 CLI에는 걸지 않는다', async () => {
    process.env.B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS = '40';
    const { backend } = fakeBackend();
    const violations: string[] = [];
    await openSessionTerminal(id, { ...ccTarget, onViolation: (reason) => violations.push(reason) }, {}, backend);
    closeSessionTerminal(id);
    const other = `${id}-claude`;
    await openSessionTerminal(other, { ...target, sandboxId: 'studio-other', onViolation: (reason) => violations.push(reason) }, {}, backend);
    await wait(150);
    expect(violations).toEqual([]);
    await disposeSessionTerminal(id, ccTarget.sandboxId, backend);
    await disposeSessionTerminal(other, 'studio-other', backend);
  });
});

describe('Command Code 터미널: 띄우기 전에 설정이 b-studio의 mod를 끄는지 본다(보안 검토, ADR-233)', () => {
  const dirs: string[] = [];
  const savedHome = process.env.HOME;
  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ home: string; work: string }> {
    const base = await mkdtemp(path.join(tmpdir(), 'b-studio-ccpre-'));
    dirs.push(base);
    const home = path.join(base, 'home');
    const work = path.join(base, 'work');
    await mkdir(path.join(home, '.commandcode'), { recursive: true });
    await mkdir(work, { recursive: true });
    process.env.HOME = home;
    return { home, work };
  }

  it('이 컴퓨터 방식 백엔드는 commandcode 터미널을 열기 전에 설정을 읽는다. 끄는 설정이면 409로 거절하고 터미널도 관문도 만들지 않는다', async () => {
    const { work } = await fixture();
    await mkdir(path.join(work, '.commandcode'), { recursive: true });
    await writeFile(path.join(work, '.commandcode/settings.local.json'), JSON.stringify({ mods: { disableAll: true } }));
    const host = terminalBackend('host');
    let gatewayCalls = 0;
    await expect(
      openSessionTerminal(id, { ...target, root: work, cli: 'commandcode', gateway: async () => { gatewayCalls += 1; return address; } }, {}, host),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('mods.disableAll') });
    expect(gatewayCalls).toBe(0);
    expect(sessionTerminalPresence(id)?.cliAlive ?? false).toBe(false);
  });

  it('우리 mod 이름이 mods.disabled에 있어도, 설정을 읽지 못해도 409다. 한국어 사유에 ADR 번호는 없다', async () => {
    const { home, work } = await fixture();
    await writeFile(path.join(home, '.commandcode/settings.json'), JSON.stringify({ mods: { disabled: ['B-Studio-Mod'] } }));
    const host = terminalBackend('host');
    const refused = await openSessionTerminal(id, { ...target, root: work, cli: 'commandcode' }, {}, host).catch((error: unknown) => error as { status: number; message: string });
    expect(refused).toMatchObject({ status: 409 });
    expect((refused as { message: string }).message).toContain('mods.disabled');
    expect((refused as { message: string }).message).not.toMatch(/ADR/);
    await writeFile(path.join(home, '.commandcode/settings.json'), '{ not json');
    const unreadable = await openSessionTerminal(`${id}-b`, { ...target, root: work, cli: 'commandcode' }, {}, host).catch((error: unknown) => error as { status: number });
    expect(unreadable).toMatchObject({ status: 409 });
  });

  it('claude 터미널은 이 검사를 받지 않는다(같은 설정이 있어도 열린다 — 대조는 백엔드 점검 없이 가짜 백엔드로)', async () => {
    const { home } = await fixture();
    await writeFile(path.join(home, '.commandcode/settings.json'), JSON.stringify({ mods: { disableAll: true } }));
    const host = terminalBackend('host');
    expect(typeof host.preflight).toBe('function');
    expect(await host.preflight!({ ...target, cli: 'claude' })).toBeUndefined();
    expect(await host.preflight!({ ...target, cli: 'commandcode' })).toContain('mods.disableAll');
  });
});

describe('Gemini 터미널: 훅이 불러와졌다는 신호를 기다린다(ADR-242)', () => {
  const savedEnv = { timeout: process.env.B_STUDIO_GEMINI_MOD_TIMEOUT_MS };
  const gmTarget = { ...target, cli: 'gemini' as const };
  afterEach(() => {
    if (savedEnv.timeout === undefined) delete process.env.B_STUDIO_GEMINI_MOD_TIMEOUT_MS;
    else process.env.B_STUDIO_GEMINI_MOD_TIMEOUT_MS = savedEnv.timeout;
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('session-start가 시간 안에 오지 않으면 훅 없이 뜬 것으로 본다: Gemini의 환경 변수로 줄인 시간 뒤 경고·위반·터미널 닫기. 오면 아무 일도 없다(대조)', async () => {
    process.env.B_STUDIO_GEMINI_MOD_TIMEOUT_MS = '40';
    const { backend, record } = fakeBackend();
    const messages: TerminalMessage[] = [];
    const violations: string[] = [];
    subscribeSessionTerminal(id, (message) => messages.push(message));
    await openSessionTerminal(id, { ...gmTarget, onViolation: (reason) => violations.push(reason) }, {}, backend);
    await wait(150);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Gemini가');
    expect(messages.some((message) => message.kind === 'warning' && message.message.includes('session-start'))).toBe(true);
    expect(record.terminals[0]!.closed).toBe(true);
    await disposeSessionTerminal(id, gmTarget.sandboxId, backend);

    const other = `${id}-ok`;
    const second = fakeBackend();
    const okViolations: string[] = [];
    await openSessionTerminal(other, { ...gmTarget, sandboxId: 'studio-gm-ok', onViolation: (reason) => okViolations.push(reason) }, {}, second.backend);
    noteModStarted(other);
    await wait(150);
    expect(okViolations).toEqual([]);
    expect(second.record.terminals[0]!.closed).toBe(false);
    await disposeSessionTerminal(other, 'studio-gm-ok', second.backend);
  });
});

describe('Gemini 터미널: 띄우기 전에 판과 설정을 본다(ADR-242)', () => {
  const dirs: string[] = [];
  const saved = { bin: process.env.B_STUDIO_GEMINI_BIN, home: process.env.HOME };
  afterEach(async () => {
    for (const [key, value] of [
      ['B_STUDIO_GEMINI_BIN', saved.bin],
      ['HOME', saved.home],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** `--version`에 판을 답하는 가짜 gemini. 부를 때의 GEMINI_CLI_HOME을 파일에 적는다(진짜 홈에 쓰지 않는지 본다) */
  async function fixture(version: string): Promise<{ work: string; home: string; seen: string }> {
    const base = await mkdtemp(path.join(tmpdir(), 'b-studio-gmpre-'));
    dirs.push(base);
    const home = path.join(base, 'home');
    const work = path.join(base, 'work');
    const seen = path.join(base, 'seen-home.txt');
    await mkdir(home, { recursive: true });
    await mkdir(work, { recursive: true });
    const bin = path.join(base, 'fake-gemini.sh');
    await writeFile(bin, `#!/bin/sh\nprintf '%s' "$GEMINI_CLI_HOME" > ${JSON.stringify(seen)}\nprintf '%s\\n' ${JSON.stringify(version)}\n`);
    await chmod(bin, 0o755);
    process.env.B_STUDIO_GEMINI_BIN = bin;
    process.env.HOME = home;
    return { work, home, seen };
  }

  it('훅이 없는 옛 판(0.1.22)은 까닭을 적어 409로 거절하고 터미널도 관문도 만들지 않는다. 진짜 홈에는 쓰지 않는다', async () => {
    const { work, home, seen } = await fixture('0.1.22');
    const host = terminalBackend('host');
    let gatewayCalls = 0;
    const refused = await openSessionTerminal(id, { ...target, root: work, cli: 'gemini', gateway: async () => { gatewayCalls += 1; return address; } }, {}, host).catch((error: unknown) => error as { status: number; message: string });
    expect(refused).toMatchObject({ status: 409 });
    expect((refused as { message: string }).message).toContain('0.1.22');
    expect((refused as { message: string }).message).toContain('0.71.1');
    expect((refused as { message: string }).message).not.toMatch(/ADR/);
    expect(gatewayCalls).toBe(0);
    // 판을 읽는 gemini는 임시 홈으로 불렸고 그 폴더는 치워졌다
    const usedHome = await readFile(seen, 'utf8');
    expect(usedHome).not.toBe(home);
    expect(usedHome).toContain('b-studio-gemini-version-');
    await expect(stat(usedHome)).rejects.toThrow();
    expect(await readdir(home)).toEqual([]);
  });

  it('읽어 본 판이면 설정을 본다: 작업 폴더 설정의 hooks·hooksConfig는 거절하고 깨끗하면 연다(대조). claude는 이 검사를 받지 않는다', async () => {
    const { work } = await fixture('0.71.1');
    const host = terminalBackend('host');
    expect(await host.preflight!({ ...target, root: work, cli: 'gemini' })).toBeUndefined();
    expect(await host.preflight!({ ...target, root: work, cli: 'claude' })).toBeUndefined();
    await mkdir(path.join(work, '.gemini'), { recursive: true });
    await writeFile(path.join(work, '.gemini/settings.json'), JSON.stringify({ hooksConfig: { enabled: false } }));
    expect(await host.preflight!({ ...target, root: work, cli: 'gemini' })).toContain('hooksConfig');
    await writeFile(path.join(work, '.gemini/settings.json'), JSON.stringify({ hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
    expect(await host.preflight!({ ...target, root: work, cli: 'gemini' })).toContain('hooks');
  });

  it('판을 읽지 못하거나(실행 실패·모르는 출력) gemini가 없으면 열지 않는다', async () => {
    const { work } = await fixture('판 모름');
    const host = terminalBackend('host');
    expect(await host.preflight!({ ...target, root: work, cli: 'gemini' })).toContain('읽지 못해');
    process.env.B_STUDIO_GEMINI_BIN = '/nonexistent/gemini';
    expect(await host.preflight!({ ...target, root: work, cli: 'gemini' })).toBeDefined();
  });

  it('gemini 터미널은 기본 계정만 쓴다: 다른 계정을 고른 세션을 기본 계정으로 조용히 띄우지 않는다', async () => {
    await expect(terminalBackend('host').prepare({ ...target, cli: 'gemini', accountDir: async () => '/home/kim/.gemini-2' }, address)).rejects.toThrow('기본 계정');
  });
});

describe('세션의 AI 계정으로 터미널 CLI를 띄운다(#885)', () => {
  const address: AgentGatewayAddress = { hookUrl: 'http://127.0.0.1:41234', hookToken: 'hook-token', mcpUrl: 'http://127.0.0.1:41235/mcp', mcpToken: 'mcp-token' };

  it('이 컴퓨터 방식: 감싸개가 계정의 설정 폴더를 CLI에 넘긴다', async () => {
    const { mkdtemp, readFile, rm, writeFile, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-account-terminal-'));
    const saved = { bin: process.env.B_STUDIO_CLAUDE_BIN, gateway: process.env.B_STUDIO_AGENT_GATEWAY_DIR };
    try {
      const fake = path.join(root, 'claude');
      await writeFile(fake, '#!/bin/sh\n');
      await chmod(fake, 0o755);
      process.env.B_STUDIO_CLAUDE_BIN = fake;
      process.env.B_STUDIO_AGENT_GATEWAY_DIR = path.join(root, 'gateway');
      const backend = terminalBackend('host');
      const configDir = path.join(root, '.claude-fio');
      const place = await backend.prepare({ ...target, sandboxId: 'studio-orders-acct', accountDir: async () => configDir }, address);
      expect(await readFile(path.join(place, 'bin', 'claude'), 'utf8')).toContain(`export CLAUDE_CONFIG_DIR='${configDir}'`);
      await backend.remove('studio-orders-acct');
      // 기본 계정이면 감싸개가 변수를 건드리지 않는다
      const plain = await backend.prepare({ ...target, sandboxId: 'studio-orders-plain', accountDir: async () => undefined }, address);
      expect(await readFile(path.join(plain, 'bin', 'claude'), 'utf8')).not.toContain('CLAUDE_CONFIG_DIR');
      await backend.remove('studio-orders-plain');
    } finally {
      for (const [key, value] of [['B_STUDIO_CLAUDE_BIN', saved.bin], ['B_STUDIO_AGENT_GATEWAY_DIR', saved.gateway]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('계정을 찾지 못하면 열지 않는다(다른 계정으로 띄우지 않는다)', async () => {
    const backend = terminalBackend('host');
    await expect(backend.prepare({ ...target, accountDir: async () => Promise.reject(new Error('이 세션의 AI 계정이 계정 목록에 없습니다')) }, address)).rejects.toThrow('계정 목록에 없습니다');
  });

  it('컨테이너 방식은 기본 계정만 쓴다', async () => {
    await expect(terminalBackend('container').prepare({ ...target, accountDir: async () => '/home/kim/.claude-2' }, address)).rejects.toThrow('기본 계정');
  });
});

describe('터미널로 돌릴 수 있는 백엔드와 AI 리뷰 고침의 길', () => {
  const host = { B_STUDIO_TERMINAL: 'host' };
  const container = { B_STUDIO_TERMINAL: 'container' };

  it('api는 이 컴퓨터 방식에서만 터미널로 돌릴 수 있다(컨테이너 방식은 claude를 띄운다)', () => {
    expect(isTerminalRunnableBackend('api', host)).toBe(true);
    expect(isTerminalRunnableBackend('api', container)).toBe(false);
    expect(isTerminalRunnableBackend('codex', host)).toBe(true);
    expect(isTerminalRunnableBackend('codex', container)).toBe(false);
    expect(isTerminalRunnableBackend('claude-code', container)).toBe(true);
    // commandcode는 실험이라 스위치 없이는 터미널로 돌리지 않는다(ADR-233)
    expect(isTerminalRunnableBackend('commandcode', host)).toBe(false);
  });

  it('commandcode는 이 컴퓨터 방식이고 실험 스위치가 켜졌을 때만 터미널로 돌릴 수 있다. 컨테이너 방식이면 스위치가 켜져도 거절한다', () => {
    const on = { B_STUDIO_EXPERIMENTAL: '1' };
    expect(isTerminalRunnableBackend('commandcode', { ...host, ...on })).toBe(true);
    expect(isTerminalRunnableBackend('commandcode', { ...container, ...on })).toBe(false);
    expect(isTerminalRunnableBackend('commandcode', { B_STUDIO_EXPERIMENTAL: '1' })).toBe(true);
    expect(isTerminalRunnableBackend('commandcode', { ...host, B_STUDIO_EXPERIMENTAL: '0' })).toBe(false);
    expect(reviewFixRunner({ allowed: true, backend: 'commandcode', apiKeyReady: true }, { ...host, ...on })).toBe('terminal');
    expect(reviewFixRunner({ allowed: true, backend: 'commandcode', apiKeyReady: true }, { ...container, ...on })).toBe('chat');
    // 아직 열지 않은 새 갈래는 열지 않는다
    for (const backend of ['opencode']) expect(isTerminalRunnableBackend(backend, { ...host, ...on }), backend).toBe(false);
  });

  it('gemini도 같다(ADR-242): 이 컴퓨터 방식이고 실험 스위치가 켜졌을 때만 터미널로 돌릴 수 있다. 모르는 방식 값·컨테이너 방식·스위치 꺼짐은 거절한다', () => {
    const on = { B_STUDIO_EXPERIMENTAL: '1' };
    expect(isTerminalRunnableBackend('gemini', host)).toBe(false);
    expect(isTerminalRunnableBackend('gemini', { ...host, ...on })).toBe(true);
    expect(isTerminalRunnableBackend('gemini', { ...container, ...on })).toBe(false);
    expect(isTerminalRunnableBackend('gemini', { ...host, B_STUDIO_EXPERIMENTAL: '0' })).toBe(false);
    expect(reviewFixRunner({ allowed: true, backend: 'gemini', apiKeyReady: true }, { ...host, ...on })).toBe('terminal');
    expect(reviewFixRunner({ allowed: true, backend: 'gemini', apiKeyReady: true }, { ...container, ...on })).toBe('chat');
    expect(geminiTerminalReason('container', on)).toContain('이 컴퓨터 방식');
    expect(geminiTerminalReason('host', {})).toContain('B_STUDIO_EXPERIMENTAL=1');
    expect(geminiTerminalReason('host', on)).toBeUndefined();
  });

  it('commandcode 터미널은 기본 계정만 쓴다: 다른 계정을 고른 세션을 기본 계정으로 조용히 띄우지 않는다', async () => {
    const address2: AgentGatewayAddress = { hookUrl: 'http://127.0.0.1:41234', hookToken: 'hook-token', mcpUrl: 'http://127.0.0.1:41235/mcp', mcpToken: 'mcp-token' };
    await expect(terminalBackend('host').prepare({ ...target, cli: 'commandcode', accountDir: async () => '/home/kim/.commandcode-2' }, address2)).rejects.toThrow('기본 계정');
  });

  it('AI 리뷰의 고침은 터미널을 쓸 수 있으면 터미널, 아니면 채팅식이다. api는 키가 있을 때만 터미널이다', () => {
    expect(reviewFixRunner({ allowed: true, backend: 'claude-code', apiKeyReady: false }, host)).toBe('terminal');
    expect(reviewFixRunner({ allowed: true, backend: 'api', apiKeyReady: true }, host)).toBe('terminal');
    expect(reviewFixRunner({ allowed: true, backend: 'api', apiKeyReady: false }, host)).toBe('chat');
    expect(reviewFixRunner({ allowed: true, backend: 'api', apiKeyReady: true }, container)).toBe('chat');
    expect(reviewFixRunner({ allowed: false, backend: 'claude-code', apiKeyReady: true }, host)).toBe('chat');
    expect(reviewFixRunner({ allowed: true, backend: 'commandcode', apiKeyReady: true }, host)).toBe('chat');
  });
});

describe('컨테이너 터미널의 첫 요청과 사용자별 홈 (#1401)', () => {
  it('컨테이너 백엔드도 첫 요청을 받는다. 받는 백엔드면 openSessionTerminal이 첫 요청을 넘기고 썼다고 돌려준다', async () => {
    expect(terminalBackend('container').acceptsInitialPrompt).toBe(true);
    expect(terminalBackend('host').acceptsInitialPrompt).toBe(true);
    const { backend } = fakeBackend();
    const accepting: TerminalBackend = { ...backend, acceptsInitialPrompt: terminalBackend('container').acceptsInitialPrompt };
    const result = await openSessionTerminal('s-1401', target, {}, accepting, { initialPrompt: '주문 화면 고쳐 줘' });
    expect(result.initialPromptUsed).toBe(true);
    await disposeSessionTerminal('s-1401', target.sandboxId, backend);
  });

  it('openAgentTerminal에 넘기는 값은 호스트 방식과 같은 꼴로 맞춘 첫 요청이다', () => {
    const size = { cols: 80, rows: 24 };
    expect(containerOpenOptions({ id: 'main', size, initialPrompt: '주문 화면 고쳐 줘' })).toEqual({ id: 'main', size, firstPrompt: '주문 화면 고쳐 줘' });
    // 옵션이나 하위 명령으로 읽힐 글에는 앞말이 붙는다
    expect(containerOpenOptions({ id: 'main', size, initialPrompt: '-x' }).firstPrompt).toBe('요청: -x');
    expect(containerOpenOptions({ id: 'main', size, initialPrompt: 'update' }).firstPrompt).toBe('요청: update');
    expect('firstPrompt' in containerOpenOptions({ id: 'main', size })).toBe(false);
    // 너무 길거나 비었으면 호스트 방식과 같이 던진다
    expect(() => containerOpenOptions({ id: 'main', size, initialPrompt: 'a '.repeat(6000) })).toThrow('너무 깁니다');
    expect(() => containerOpenOptions({ id: 'main', size, initialPrompt: '   ' })).toThrow('비어');
  });

  it('인증을 끈 개인 PC 방식은 사용자별로 가르지 않는다. 그 밖의 방식은 세션 주인으로 가른다(모르는 값도)', () => {
    expect(terminalHomeUser('none', 'local')).toBeUndefined();
    expect(terminalHomeUser('token', 'alice')).toBe('alice');
    expect(terminalHomeUser('proxy', 'bob')).toBe('bob');
    expect(terminalHomeUser('모르는-방식', 'alice')).toBe('alice');
    // 인증을 켠 서버에 'local'이라는 사용자가 있어도 개인 PC의 볼륨을 같이 쓰지 않는다
    expect(terminalHomeUser('token', 'local')).toBe('local');
    // 인증을 켰는데 주인을 모르면 공용 볼륨으로 떨어지지 않고 던진다
    expect(() => terminalHomeUser('token', undefined)).toThrow('세션 주인');
    expect(() => terminalHomeUser('token', '')).toThrow('세션 주인');
    expect(terminalHomeUser('none', undefined)).toBeUndefined();
  });
});
