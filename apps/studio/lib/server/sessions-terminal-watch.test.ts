import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 세션 터미널 감시(훅 없이 뜬 CLI, 관문 파일 검사)가 실행의 열기·턴 끝에 닿는 길(N15·N17·N20·N16, ADR-219)을 실제 sessions.ts와 실제 `HOST_BACKEND.watch`로 본다.
 * 가짜는 샌드박스(Docker), 터미널 프로세스, `ps`(가짜 프로세스 목록)와 관문 파일 검사뿐이다. CLI가 하는 일은 훅을 부르는 것과 작업 복사본의 파일을 고치는 것이므로 테스트가 그 둘을 직접 한다.
 * 감시 검사는 관문 폴더(임시 폴더)에 파일을 써서 `fs.watch` 신호로 부른다 — 실제 `ps`나 이 컴퓨터의 다른 프로세스에 기대지 않는다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  execCalls: [] as string[][],
  failCommands: [] as string[],
  /** 켜면 샌드박스를 켜지 못한다(샌드박스·도커 쪽 문제) */
  startFails: false as boolean,
  starts: 0,
  /** 값이 있으면 `start`가 이 약속이 풀릴 때까지 끝나지 않는다(샌드박스를 켜는 중으로 붙잡아 둔다) */
  startHold: undefined as Promise<void> | undefined,
  /** holdWord가 든 명령은 hold가 풀릴 때까지 끝나지 않는다(검증을 도는 중으로 붙잡아 둔다) */
  holdWord: undefined as string | undefined,
  hold: undefined as Promise<void> | undefined,
  /** 세션 터미널(CLI)에 보낸 Esc의 기록 */
  interrupts: [] as string[],
  /** 서비스가 떠 있는 주소(시험마다 계약을 내놓는 작은 서버) */
  serviceUrl: 'http://127.0.0.1:1',
  /** 세션 터미널 방식. 'host'(이 컴퓨터 방식)면 작업 복사본의 Git을 더 의심한다(이슈 #706) */
  terminalMode: 'container' as 'container' | 'host',
  /** 시험이 studio.yaml에 쓸 턴 상한 */
  maxTurns: undefined as number | undefined,
  /** 가짜 `ps`의 프로세스 목록과, 켜면 던지는 스위치. 부른 횟수 */
  processes: [] as Array<{ pid: number; ppid: number; args: string }>,
  psFails: false,
  listCalls: 0,
  /** 관문 파일 검사를 부른 횟수(검사 한 회차마다 한 번) */
  fileCalls: 0,
  /** 진짜 argv를 읽는 가짜: pid별로 정해 두면 그 값(null은 끝남, Error는 읽지 못함), 없으면 ps 한 줄을 공백으로 자른 것 */
  argv: new Map<number, string[] | null | Error>(),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-termwatch-fake',
    name: 'fake',
    async start() {
      fake.starts += 1;
      if (fake.startHold) await fake.startHold;
      if (fake.startFails) throw new actual.SandboxError('도커에 닿지 못했습니다', 'Cannot connect to the Docker daemon', { platform: true });
      return [];
    },
    async restart(service: string) {
      return { service, containerPort: 8080, url: fake.serviceUrl };
    },
    async sync() {
      return { elapsedMs: 0, checks: 1 };
    },
    async endpoint(service: string) {
      return { service, containerPort: 8080, url: fake.serviceUrl };
    },
    async state() {
      return 'running';
    },
    async stats() {
      return [];
    },
    async *logs() {},
    async exec(_service: string, command: string[]) {
      if (command[0] === 'sh' && command[2]?.startsWith('rm -f /tmp/b-studio-test-report.json ')) return { exitCode: 0, stdout: '', stderr: '' };
      fake.execCalls.push(command);
      if (fake.holdWord && command.includes(fake.holdWord)) await fake.hold;
      if (fake.failCommands.some((word) => command.includes(word))) return { exitCode: 1, stdout: '', stderr: 'FAILED: OrderTest' };
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    async execToFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execFromFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    redact: (text: string) => text,
    findSecrets: () => [],
    async callExternal() {
      return { decision: 'deny' as const, status: 404, body: '', masked: 0 };
    },
    async destroy() {},
  } as unknown as Sandbox;
  return { ...actual, listProcesses: async () => {
    fake.listCalls += 1;
    if (fake.psFails) throw new Error('ps를 읽지 못했습니다');
    return fake.processes.map((entry) => ({ ...entry }));
  }, processArgv: (pid: number) => {
    const given = fake.argv.get(pid);
    if (given instanceof Error) throw given;
    if (given !== undefined) return given;
    const entry = fake.processes.find((candidate) => candidate.pid === pid);
    return entry ? entry.args.split(' ') : null;
  },
  checkHostGatewayConfig: async () => {
    fake.fileCalls += 1;
    return [];
  }, writeHostGatewayConfig: async () => '', providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({ findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root) }));
vi.mock('@b-studio/agent', async (importOriginal) => ({ ...(await importOriginal<typeof import('@b-studio/agent')>()), preflightCodex: async () => ({ ok: true as const }) }));
// 감시(`HOST_BACKEND.watch`)와 터미널 상태는 진짜 코드가 돈다. 가짜는 프로세스 목록과 관문 파일 검사, 그리고 도커·홈 폴더에 닿는 정리뿐이다
vi.mock('./session-terminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-terminal')>();
  const noRemove = { ...actual.terminalBackend('host'), remove: async () => {} };
  return {
    ...actual,
    disposeSessionTerminal: (sessionId: string, sandboxId: string) => actual.disposeSessionTerminal(sessionId, sandboxId, noRemove),
    removeTerminalLeftovers: async () => {},
    interruptSessionTerminal: (sessionId: string) => {
      fake.interrupts.push(sessionId);
    },
    sessionTerminalMode: () => fake.terminalMode,
    warnSessionTerminal: () => {},
    terminalPause: () => undefined,
  };
});

import { createSession, getSnapshot, sessionTerminalTarget, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';
import { openSessionTerminal, terminalBackend, type TerminalBackend } from './session-terminal';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: termwatch
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
`;

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termwatch-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), STUDIO_YAML);
  fake.maxTurns = undefined;
  fake.terminalMode = 'host';
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = project;
  fake.execCalls = [];
  fake.failCommands = [];
  fake.startFails = false;
  fake.starts = 0;
  fake.startHold = undefined;
  fake.holdWord = undefined;
  fake.hold = undefined;
  fake.interrupts = [];
  fake.processes = [];
  fake.psFails = false;
  fake.listCalls = 0;
  fake.fileCalls = 0;
  fake.argv = new Map();
  await serveContract();
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_EXPERIMENTAL = '1';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.B_STUDIO_USAGE_DIR = path.join(root, 'usage');
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'verify',
    GIT_AUTHOR_EMAIL: 'verify@example.com',
    GIT_COMMITTER_NAME: 'verify',
    GIT_COMMITTER_EMAIL: 'verify@example.com',
    B_STUDIO_GIT_AUTHOR_NAME: 'verify',
    B_STUDIO_GIT_AUTHOR_EMAIL: 'verify@example.com',
  });
});

const servers: Server[] = [];
const contract = {
  openapi: '3.0.1',
  paths: { '/api/orders': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } } } } } },
  components: { schemas: { OrderResponse: { type: 'object', properties: { id: { type: 'string' }, memo: { type: 'string' } } } } },
};

/** 게이트가 계약을 뽑는 서비스 */
async function serveContract(): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(contract));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.serviceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const openSessions: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  // 붙잡아 둔 약속을 풀고 세션을 멈춘다(남은 비동기 일이 다음 시험에 새지 않게)
  for (const id of openSessions.splice(0)) await stopSession(id).catch(() => {});
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_AUTH', saved.auth],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
    ['B_STUDIO_EXPERIMENTAL', saved.experimental],
    ['B_STUDIO_USAGE_DIR', saved.usage],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});


interface Opened {
  id: string;
  work: string;
  gateway: ReturnType<typeof terminalGatewayHandlersForTest>;
  events: StudioEvent[];
  ofType<T extends StudioEvent['type']>(type: T): Array<Extract<StudioEvent, { type: T }>>;
}

async function open(): Promise<Opened> {
  const id = (await createSession('termwatch', 'kim', 'copy', {})).id;
  openSessions.push(id);
  const started = Date.now();
  while (getSnapshot(id)?.status !== 'ready') {
    if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events: StudioEvent[] = [];
  subscribe(id, (event) => events.push(event));
  const { root } = sessionTerminalTarget(id);
  return { id, work: root, gateway: terminalGatewayHandlersForTest(id), events, ofType: (type) => events.filter((event): event is Extract<StudioEvent, { type: typeof type }> => event.type === type) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 10_000) throw new Error(`${what}이(가) 오지 않았습니다`);
    await sleep(10);
  }
}

const CHANGED = 'class Order { String memo; }\n';
const WRITE = { tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: CHANGED } };
const edit = (session: Opened, file: string, content: string) => writeFile(path.join(session.work, file), content);

/** 만들기 실행을 열고 파일을 바꾼다(쓰기 훅이 허용했다) */
async function startWork(session: Opened, request = '주문에 메모 필드 추가'): Promise<void> {
  await session.gateway.prompt({ prompt: request });
  expect(await session.gateway.preTool(WRITE)).toEqual({});
  await edit(session, 'api/src/Order.java', CHANGED);
}

async function finishedRuns(session: Opened, count: number): Promise<Array<Extract<StudioEvent, { type: 'run_finished' }>>> {
  await until(`실행 닫힘 ${count}개`, () => session.ofType('run_finished').length >= count);
  return session.ofType('run_finished');
}

// ── 가짜 터미널과 감시 ──

const PTY_PID = 4242;
const STRAY = { pid: 5000, ppid: PTY_PID, args: '/x/fake/claude 90' };
const SHELL = { pid: PTY_PID, ppid: 1, args: '/bin/zsh -l -i' };

interface Watched {
  place: string;
  /** 관문 폴더에 파일을 써서 감시의 검사를 한 번 일으키고, 그 검사가 끝나기를 기다린다 */
  scan: () => Promise<void>;
}

/** 이 컴퓨터 방식의 감시를 진짜 코드로 붙인다. pid가 null이면 pid를 모르는 터미널이다 */
async function watching(session: Opened, pid: number | null = PTY_PID): Promise<Watched> {
  const place = await mkdtemp(path.join(tmpdir(), 'b-studio-termwatch-gateway-'));
  const store = globalThis as typeof globalThis & { __bStudioHostGateways?: Map<string, unknown> };
  store.__bStudioHostGateways!.set(place, {
    address: { hookUrl: 'http://127.0.0.1:1', hookToken: 't', mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 't' },
    cli: { kind: 'claude', cliPath: '/x/fake/claude-real' },
    root: place,
    expected: {},
  });
  const terminal = { id: 'main', ...(pid !== null ? { pid } : {}), write() {}, async resize() {}, onData() {}, onExit() {}, close() {} };
  const backend: TerminalBackend = {
    ...terminalBackend('host'),
    prepare: async () => place,
    open: async () => terminal,
    reachable: async () => true,
    remove: async () => {},
  };
  // 관문(훅 서버)은 띄우지 않는다: 감시만 진짜 코드로 본다
  const full = sessionTerminalTarget(session.id);
  const target = Object.fromEntries(Object.entries(full).filter(([key]) => key !== 'gateway')) as Omit<typeof full, 'gateway'>;
  await openSessionTerminal(session.id, target, {}, backend);
  let poke = 0;
  return {
    place,
    scan: async () => {
      const before = fake.fileCalls;
      await writeFile(path.join(place, `poke-${(poke += 1)}`), 'x');
      await until('감시 검사', () => fake.fileCalls > before);
      // 검사가 끝나고 알림이 처리되도록 한 박자 더 둔다
      await sleep(40);
    },
  };
}

describe('N15: 위반이 이어지는 동안 새로 열린 실행도 위반을 받는다', () => {
  it('훅 없는 CLI가 계속 도는 동안 앞 실행이 실패로 닫힌 뒤 연 실행도 턴 끝에서 실패로 닫힌다', async () => {
    const session = await open();
    const watch = await watching(session);
    await startWork(session);
    fake.processes = [SHELL, STRAY];
    await watch.scan();
    // 첫 알림: 열려 있던 실행 A가 실패로 닫힌다
    const [a] = await finishedRuns(session, 1);
    expect(a).toMatchObject({ status: 'failed' });
    // 같은 CLI가 계속 돈다. 알림은 다시 오지 않지만 새 실행 B는 위반을 이어 받는다
    await watch.scan();
    await startWork(session, '다음 요청');
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('검증을 우회할 수 있는 일');
    expect(answer.message).toContain('pid 5000');
    const runs = await finishedRuns(session, 2);
    expect(runs[1]).toMatchObject({ status: 'failed' });
  }, 40_000);

  it('실행이 열려 있는 동안 위반이 시작돼 턴 끝 전에 끝나도, 열릴 때 살아 있던 위반은 그 실행의 것이다', async () => {
    const session = await open();
    const watch = await watching(session);
    await startWork(session);
    fake.processes = [SHELL, STRAY];
    await watch.scan();
    await finishedRuns(session, 1);
    // 같은 CLI가 아직 돈다: 실행 B가 열린다. B가 도는 사이 그 CLI가 끝나고 검사가 그것을 본다
    await startWork(session, '다음 요청');
    fake.processes = [SHELL];
    await watch.scan();
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('pid 5000');
    expect((await finishedRuns(session, 2))[1]).toMatchObject({ status: 'failed' });
  }, 40_000);

  it('그 CLI가 끝나면 다음 실행은 통과한다(위반이 영원히 남지 않는다)', async () => {
    const session = await open();
    const watch = await watching(session);
    await startWork(session);
    fake.processes = [SHELL, STRAY];
    await watch.scan();
    await finishedRuns(session, 1);
    fake.processes = [SHELL];
    await startWork(session, '다음 요청');
    // 실행을 열 때 한 번 더 검사해 이미 없어진 것을 오탐하지 않는다
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message ?? '').not.toContain('검증을 우회할 수 있는 일');
    const runs = await finishedRuns(session, 2);
    expect(runs[1]).toMatchObject({ status: 'done' });
  }, 40_000);

  it('N16: 두 검사 사이에 끝난 훅 없는 CLI의 변경은 검사에 걸리지 않고, 다음 요청의 변경으로 섞여 게이트를 지난다(알려진 한계)', async () => {
    const session = await open();
    const watch = await watching(session);
    // 훅 없는 CLI가 돌다 끝났다: 목록에는 한 번도 나타나지 않았다. 그 사이 파일을 고쳤다
    await watch.scan();
    await edit(session, 'api/src/Sneaked.java', 'class Sneaked {}\n');
    await watch.scan();
    // 다음 요청은 위반 없이 열린다. 그 변경은 "실행 전부터 있던 변경"이라 이 요청의 변경과 구별되지 않고, 턴 끝의 게이트가 이 요청의 변경으로 본다
    await session.gateway.prompt({ prompt: '아무것도 바꾸지 않는 요청' });
    expect(session.ofType('agent').filter((event) => event.event.type === 'warning')).toEqual([]);
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message ?? '').not.toContain('검증을 우회');
    expect(fake.execCalls).toContainEqual(['./gradlew', 'test']);
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'done' });
    expect(await readFile(path.join(session.work, 'api/src/Sneaked.java'), 'utf8')).toBe('class Sneaked {}\n');
  }, 40_000);
});

describe('진짜 argv로 훅이 붙었는지 본다(ADR-219 후속)', () => {
  it('첫 요청 글에 --settings가 든 붙은 CLI는 위반이 아니다', async () => {
    const session = await open();
    const watch = await watching(session);
    const settings = path.join(watch.place, 'settings.json');
    // 감싸개가 `exec <cli> --mcp-config M --settings S "$@"`로 부른다. 첫 요청 글은 한 인자다
    const prompt = 'claude의 --settings 옵션 문서를 써 줘';
    fake.processes = [SHELL, { pid: 5100, ppid: PTY_PID, args: `/x/fake/claude-real --mcp-config /m/mcp.json --settings ${settings} ${prompt}` }];
    fake.argv.set(5100, ['/x/fake/claude-real', '--mcp-config', '/m/mcp.json', '--settings', settings, prompt]);
    await watch.scan();
    await startWork(session);
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message ?? '').not.toContain('검증을 우회할 수 있는 일');
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'done' });
  }, 40_000);

  it('붙은 것처럼 보이는 요청 글만 받은 훅 없는 CLI는 위반이다(요청 글 자리의 표식은 진짜 --settings가 아니다)', async () => {
    const session = await open();
    const watch = await watching(session);
    const settings = path.join(watch.place, 'settings.json');
    const faked = `--settings ${settings}`;
    fake.processes = [SHELL, { pid: 5200, ppid: PTY_PID, args: `/x/fake/claude-real ${faked}` }];
    fake.argv.set(5200, ['/x/fake/claude-real', faked]);
    await startWork(session);
    await watch.scan();
    // 알림이 열려 있던 실행을 곧바로 실패로 닫는다
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'failed' });
    expect(session.ofType('agent').some((event) => event.event.type === 'warning' && event.event.message.includes('pid 5200'))).toBe(true);
  }, 40_000);

  it('argv를 읽지 못하면 그 회차의 프로세스 검사는 실패이고 턴 끝을 통과로 닫지 않는다', async () => {
    const session = await open();
    const watch = await watching(session);
    const settings = path.join(watch.place, 'settings.json');
    fake.processes = [SHELL, { pid: 5300, ppid: PTY_PID, args: `/x/fake/claude-real --settings ${settings}` }];
    fake.argv.set(5300, new Error('권한이 없습니다'));
    await watch.scan();
    await startWork(session);
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('관문 감시가 확인하지 못했습니다');
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'failed' });
  }, 40_000);

  it('후보가 그 사이 끝났으면(argv 없음) 건너뛴다', async () => {
    const session = await open();
    const watch = await watching(session);
    fake.processes = [SHELL, { pid: 5400, ppid: PTY_PID, args: '/x/fake/claude-real --resume' }];
    fake.argv.set(5400, null);
    await watch.scan();
    await startWork(session);
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message ?? '').not.toContain('검증을 우회할 수 있는 일');
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'done' });
  }, 40_000);
});

describe('N17: 감시가 실패를 세는 중에 온 턴 끝은 통과로 닫지 않는다', () => {
  it('프로세스 검사가 한 번 실패한 상태의 턴 끝은 한 번 더 검사하고, 그래도 실패하면 실패로 닫는다', async () => {
    const session = await open();
    const watch = await watching(session);
    await watch.scan();
    fake.psFails = true;
    await watch.scan();
    await startWork(session);
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('관문 감시가 확인하지 못했습니다');
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'failed' });
  }, 40_000);

  it('실패하던 검사가 턴 끝의 다시 검사에서 성공하면 통과한다', async () => {
    const session = await open();
    const watch = await watching(session);
    fake.psFails = true;
    await watch.scan();
    fake.psFails = false;
    await startWork(session);
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message ?? '').not.toContain('확인하지 못했습니다');
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'done' });
  }, 40_000);

  it('한 번도 검사하지 않은 채 온 턴 끝도 그 자리에서 검사하고 통과한다(회귀 방지)', async () => {
    const session = await open();
    await watching(session);
    expect(fake.fileCalls).toBe(0);
    await startWork(session);
    await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(fake.fileCalls).toBeGreaterThan(0);
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'done' });
  }, 40_000);
});

describe('N20: pid를 모르면 프로세스 검사는 할 수 없는 것이고 통과가 아니다', () => {
  it('pid가 없는 터미널의 턴 끝은 실패로 닫힌다', async () => {
    const session = await open();
    const watch = await watching(session, null);
    await watch.scan();
    await startWork(session);
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('프로세스 번호를 알 수 없어');
    expect((await finishedRuns(session, 1))[0]).toMatchObject({ status: 'failed' });
  }, 40_000);

  it('pid 0인 터미널은 모든 프로세스를 훑지 않는다: 관련 없는 claude를 위반으로 알리지 않는다', async () => {
    const session = await open();
    const reports: string[] = [];
    const watch = await watching(session, 0);
    // 이 컴퓨터의 다른 프로세스(ppid 0의 자식과 그 아래의 claude)
    fake.processes = [{ pid: 1, ppid: 0, args: '/sbin/launchd' }, { pid: 900, ppid: 1, args: '/usr/local/bin/claude --resume' }];
    session.events.length = 0;
    await watch.scan();
    for (const event of session.ofType('notice')) reports.push(event.text);
    for (const event of session.ofType('agent')) if (event.event.type === 'warning') reports.push(event.event.message);
    expect(reports.some((text) => text.includes('pid 900'))).toBe(false);
  }, 40_000);
});
