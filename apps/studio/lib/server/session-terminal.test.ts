import type { AgentGatewayAddress, AgentTerminal, TerminalSize } from '@b-studio/sandbox';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeSessionTerminal,
  disposeSessionTerminal,
  interruptSessionTerminal,
  MAX_TERMINAL_INPUT,
  openSessionTerminal,
  removeContainerAndConfig,
  removeTerminalLeftovers,
  resizeSessionTerminal,
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
