import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COMMAND_CODE_MOD, COMMAND_CODE_MOD_NAME } from '@b-studio/sandbox';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * Command Code 세션 터미널(ADR-233, 실험). **진짜 mod 파일**을 불러 훅을 부르는 가짜 CLI와, **진짜 훅 서버**(관문)와, 진짜 sessions.ts의 판정을 잇는다.
 * 가짜는 샌드박스(Docker)와 터미널 모듈의 바깥 일(PTY)뿐이다. 진짜 commandcode도 모델도 부르지 않는다.
 * 쓰기 범위·보호 경로·턴 끝 게이트·체크포인트는 Claude Code 터미널과 같은 코드(sessions.ts의 terminalToolDecision·finishTerminalTurn)를 지난다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  execCalls: [] as string[][],
  failCommands: [] as string[],
  serviceUrl: 'http://127.0.0.1:1',
  terminalMode: 'host' as 'container' | 'host',
  cli: [] as boolean[],
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-termcc-fake',
    name: 'fake',
    async start() {
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
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({ findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root) }));
// commandcode 백엔드 세션은 만들 때 실제 CLI 로그인을 확인한다. 여기서는 CLI를 부르지 않고 통과시킨다
vi.mock('@b-studio/agent', async (importOriginal) => ({ ...(await importOriginal<typeof import('@b-studio/agent')>()), preflightCommandCode: async () => ({ ok: true as const }) }));
vi.mock('./session-terminal', () => ({
  disposeSessionTerminal: async () => {},
  interruptSessionTerminal: () => {},
  noteSessionTerminalCli: (_sessionId: string, alive: boolean) => {
    fake.cli.push(alive);
  },
  sessionTerminalMode: () => fake.terminalMode,
  warnSessionTerminal: () => {},
  terminalPause: () => undefined,
}));

import { createSession, getSnapshot, sessionTerminalActivity, sessionTerminalTarget, setTerminalTaskContext, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';
import { startTerminalGateway, type TerminalGateway } from './terminal-gateway';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR, backends: process.env.B_STUDIO_BACKENDS, terminal: process.env.B_STUDIO_TERMINAL, gatewayDir: process.env.B_STUDIO_GATEWAY_DIR };

const STUDIO_YAML = `version: 1
name: termcc
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
`;

const servers: Server[] = [];
const gateways: TerminalGateway[] = [];
let outside = '';

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termcc-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), STUDIO_YAML);
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  outside = path.join(root, 'outside');
  await mkdir(outside);
  fake.root = project;
  fake.execCalls = [];
  fake.failCommands = [];
  fake.cli = [];
  fake.terminalMode = 'host';
  await serveContract();
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_EXPERIMENTAL = '1';
  process.env.B_STUDIO_BACKENDS = 'commandcode';
  delete process.env.B_STUDIO_TERMINAL;
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

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_AUTH', saved.auth],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
    ['B_STUDIO_EXPERIMENTAL', saved.experimental],
    ['B_STUDIO_USAGE_DIR', saved.usage],
    ['B_STUDIO_BACKENDS', saved.backends],
    ['B_STUDIO_TERMINAL', saved.terminal],
    ['B_STUDIO_GATEWAY_DIR', saved.gatewayDir],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function serveContract(): Promise<void> {
  const doc = { openapi: '3.0.1', paths: { '/api/orders': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } } } } } }, components: { schemas: { OrderResponse: { type: 'object', properties: { id: { type: 'string' } } } } } };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(doc));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.serviceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Opened {
  id: string;
  work: string;
  events: StudioEvent[];
  ofType<T extends StudioEvent['type']>(type: T): Array<Extract<StudioEvent, { type: T }>>;
}

async function open(modelId?: string): Promise<Opened> {
  const id = (await createSession('termcc', 'kim', 'copy', { backend: 'commandcode', ...(modelId ? { modelId } : {}) })).id;
  const started = Date.now();
  while (getSnapshot(id)?.status !== 'ready') {
    if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events: StudioEvent[] = [];
  subscribe(id, (event) => events.push(event));
  return { id, work: sessionTerminalTarget(id).root, events, ofType: (type) => events.filter((event): event is Extract<StudioEvent, { type: typeof type }> => event.type === type) };
}

// 가짜 CLI가 mod의 훅을 부르는 자리다. 훅마다 인자·답의 모양이 달라 시험이 꺼내 본다
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Hook = (...args: any[]) => any;
interface FakeCli {
  hooks: Record<string, Hook>;
  emit(event: string, payload: unknown): Promise<void>;
  notices: string[];
}

/**
 * 진짜 훅 서버(관문)를 띄우고, 관문 폴더에 mod 파일과 주소 파일을 쓴 뒤, 그 mod를 진짜로 불러 훅을 모은다.
 * 감싸개가 하는 일(환경 변수로 관문 폴더 알리기)도 여기서 한다. `address`를 주면 그 주소 파일을 쓴다(닿지 못하는 주소·틀린 토큰)
 */
async function launchCli(session: Opened, override?: (real: { url: string; token: string }) => { url: string; token: string }): Promise<{ cli: FakeCli; gateway: TerminalGateway; dir: string }> {
  const gateway = await startTerminalGateway(terminalGatewayHandlersForTest(session.id), '127.0.0.1');
  gateways.push(gateway);
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-termcc-gw-'));
  const real = { url: gateway.address.hookUrl, token: gateway.address.hookToken };
  await writeFile(path.join(dir, COMMAND_CODE_MOD_NAME), COMMAND_CODE_MOD);
  await writeFile(path.join(dir, 'b-studio-gateway.json'), `${JSON.stringify(override ? override(real) : real)}\n`);
  process.env.B_STUDIO_GATEWAY_DIR = dir;
  const copy = path.join(dir, 'loaded.mjs');
  await writeFile(copy, COMMAND_CODE_MOD);
  const loaded = (await import(/* @vite-ignore */ copy)) as { default: (cmd: unknown) => unknown };
  const hooks: Record<string, Hook> = {};
  const handlers = new Map<string, Hook[]>();
  const notices: string[] = [];
  await loaded.default({
    name: 'b-studio-mod',
    cwd: session.work,
    hooks: (value: Record<string, Hook>) => {
      Object.assign(hooks, value);
      return { dispose() {} };
    },
    on: (event: string, handler: Hook) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return { dispose() {} };
    },
    ui: { notify: (text: string) => void notices.push(text) },
  });
  return {
    cli: {
      hooks,
      notices,
      emit: async (event, payload) => {
        for (const handler of handlers.get(event) ?? []) await handler(payload);
      },
    },
    gateway,
    dir,
  };
}

let callCounter = 0;
/**
 * Command Code가 하는 대로: 쓰기 직전 훅을 부르고, 막히지 않았으면 파일을 쓰고, 쓰기 뒤 훅을 부른다.
 * 도구 이름과 입력 열쇠는 Command Code의 것이다(`write_file` + `file_path`)
 */
async function toolCall(session: Opened, cli: FakeCli, toolName: string, input: Record<string, unknown>, effect?: () => Promise<void>): Promise<{ blocked?: string }> {
  callCounter += 1;
  const toolCallId = `call-${callCounter}`;
  const before = await cli.hooks.beforeToolCall!({ toolCallId, toolName, input, state: {} });
  if (before?.block) return { blocked: before.additionalContext };
  await effect?.();
  await cli.hooks.afterToolCall!({ toolCallId, toolName, input, result: [], isError: false, state: {} });
  return {};
}
const writeFileTool = (session: Opened, cli: FakeCli, file: string, content: string) =>
  toolCall(session, cli, 'write_file', { file_path: path.join(session.work, file), content }, () => writeFile(path.join(session.work, file), content));
const fileOf = (session: Opened, file = 'api/src/Order.java') => readFile(path.join(session.work, file), 'utf8');
const ORIGINAL = 'class Order {}\n';

describe('Command Code 터미널: 진짜 mod → 진짜 훅 서버 → 진짜 판정', () => {
  it('통과 흐름: 요청 → 읽기 → 쓰기 → 턴 끝 게이트 통과 → 체크포인트. 기록의 백엔드는 commandcode다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    const before = getSnapshot(session.id)!.checkpoints.length;

    // CLI가 떴다고 알린다(화면은 그때부터 다른 패널의 글을 터미널에 붙여 넣는다)
    await cli.hooks.onSessionStart!({ source: 'startup' });
    expect(fake.cli).toContain(true);

    const input = await cli.hooks.transformInput!({ text: '주문에 메모 필드 추가' });
    expect(input).toEqual({ action: 'continue' });
    expect(session.ofType('run_started')).toMatchObject([{ request: '주문에 메모 필드 추가', via: 'terminal', backend: 'commandcode' }]);
    // 읽기 도구는 막지 않는다(Command Code의 이름: read_file, read_directory)
    expect((await toolCall(session, cli, 'read_file', { file_path: path.join(session.work, 'api/src/Order.java') })).blocked).toBeUndefined();
    expect((await toolCall(session, cli, 'read_directory', { path: session.work })).blocked).toBeUndefined();

    expect((await writeFileTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n')).blocked).toBeUndefined();
    const stop = await cli.hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 2, lastAssistantText: '메모 필드를 추가했습니다.' });
    expect(stop).toEqual({ continue: false });
    await cli.hooks.onRunEnd!({ state: {}, result: { stopReason: 'end_turn', turnCount: 2, finalText: '' } });

    const snapshot = getSnapshot(session.id)!;
    expect(snapshot.checkpoints).toHaveLength(before + 1);
    expect(snapshot.checkpoints[0]).toMatchObject({ message: 'feat: 주문에 메모 필드 추가', files: ['api/src/Order.java'] });
    expect(snapshot.checkpoints[0]!.passedStages).toEqual(expect.arrayContaining(['run', 'contract_check', 'test', 'review']));
    // 선언한 테스트가 서비스 컨테이너에서 실제로 돌았다
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
    expect(cli.notices.some((text) => text.includes('검증 통과 — 체크포인트'))).toBe(true);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
    expect(snapshot.running).toBe(false);
    // 모델 고르기 인자는 목표에 없다: 터미널 대상에 모델이 실리지 않는다
    expect(sessionTerminalTarget(session.id).cli).toBe('commandcode');
    expect(sessionTerminalTarget(session.id).model).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('읽기 도구(Command Code의 이름)는 실행을 열지 않고 바로 통과한다. 이름을 claude의 표로 읽으면 읽기만 해도 실행이 열린다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    for (const [name, input] of [
      ['read_file', { file_path: path.join(session.work, 'api/src/Order.java') }],
      ['read_directory', { path: session.work }],
      ['grep', { pattern: 'Order' }],
      ['glob', { pattern: '**/*.java' }],
    ] as const) {
      expect((await toolCall(session, cli, name, input)).blocked, name).toBeUndefined();
    }
    expect(session.ofType('run_started')).toEqual([]);
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 대조: 모르는 이름(바꾸는 도구로 본다)은 실행을 연다
    await toolCall(session, cli, 'shell_command', { command: 'ls' });
    expect(session.ofType('run_started')).toHaveLength(1);
    await cli.hooks.onRunEnd!({ state: {}, result: { stopReason: 'max_turns' } });
    await stopSession(session.id);
  }, 30_000);

  it('카드의 쓰기 범위 밖 쓰기는 막히고 파일이 만들어지지 않는다. 범위 안은 통과한다(대조)', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await cli.hooks.transformInput!({ text: '주문에 메모 필드 추가' });

    const denied = await writeFileTool(session, cli, 'web/other.txt', 'x');
    expect(denied.blocked).toContain('이 카드가 쓸 수 있는 경로는 api/src입니다');
    expect(denied.blocked).toContain('web/other.txt');
    await expect(fileOf(session, 'web/other.txt')).rejects.toThrow();
    // `path`·`filePath` 열쇠로 와도 같다
    for (const key of ['path', 'filePath']) {
      const viaKey = await toolCall(session, cli, 'edit_file', { [key]: path.join(session.work, 'web/other.txt'), old_string: 'a', new_string: 'b' });
      expect(viaKey.blocked, key).toContain('web/other.txt');
    }
    expect((await writeFileTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n')).blocked).toBeUndefined();
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('카드의 쓰기 범위가 걸린 세션에서는 서브에이전트 도구를 막는다(그 안의 쓰기를 쓰기 직전에 볼 수 없다). 카드가 없으면 통과한다(대조)', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await cli.hooks.transformInput!({ text: '주문에 메모 필드 추가' });
    for (const tool of ['agent', 'task']) {
      const denied = await toolCall(session, cli, tool, { prompt: 'api/src/Order.java에 메모 필드를 더해 줘', subagent_type: 'general' });
      expect(denied.blocked, tool).toContain('바꾸는 파일을 알 수 없어 쓰지 않았습니다');
    }
    setTerminalTaskContext(session.id, undefined);
    expect((await toolCall(session, cli, 'agent', { prompt: '고쳐 줘', subagent_type: 'general' })).blocked).toBeUndefined();
    await cli.hooks.onRunEnd!({ state: {}, result: { stopReason: 'max_turns' } });
    await stopSession(session.id);
  }, 30_000);

  it('보호 경로: 작업 복사본 밖을 가리키는 링크를 지나는 쓰기는 범위 안의 글자여도 막힌다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await symlink(outside, path.join(session.work, 'api/src/escape'));
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await cli.hooks.transformInput!({ text: '주문에 메모 필드 추가' });
    const denied = await toolCall(session, cli, 'write_file', { file_path: path.join(session.work, 'api/src/escape/x.txt'), content: 'x' });
    expect(denied.blocked).toContain('범위 밖이라 쓰지 않았습니다');
    await expect(readFile(path.join(outside, 'x.txt'), 'utf8')).rejects.toThrow();
    // 대조: 링크가 아닌 같은 모양의 경로는 통과한다
    expect((await toolCall(session, cli, 'write_file', { file_path: path.join(session.work, 'api/src/real/x.txt'), content: 'x' })).blocked).toBeUndefined();
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('경로를 꺼내지 못한 쓰기 도구는 쓰기 범위 밖으로 막는다. 셸 도구는 경로가 없어도 지금처럼 턴 끝 검사가 맡는다(대조)', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await cli.hooks.transformInput!({ text: '주문에 메모 필드 추가' });
    for (const input of [{ content: 'x' }, { file_path: 5, content: 'x' }, { file_path: '' }, {}]) {
      const denied = await toolCall(session, cli, 'write_file', input);
      expect(denied.blocked, JSON.stringify(input)).toContain('알 수 없어');
    }
    expect((await toolCall(session, cli, 'shell_command', { command: 'ls' })).blocked).toBeUndefined();
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('게이트가 실패하면 사유가 onStop의 reason으로 돌아오고 체크포인트는 없다. 고친 뒤 턴이 끝나면 통과한다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    const before = getSnapshot(session.id)!.checkpoints.length;
    await cli.hooks.transformInput!({ text: '주문에 메모 필드 추가' });
    await writeFileTool(session, cli, 'api/src/Order.java', 'class Order { String memo }\n');

    fake.failCommands = ['test'];
    const failed = await cli.hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 2, lastAssistantText: '추가했습니다.' });
    expect(failed.continue).toBe(true);
    expect(failed.reason).toContain('[b-studio 검증 게이트]');
    expect(failed.reason).toContain('unit');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(true);

    fake.failCommands = [];
    await writeFileTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(await cli.hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 3, lastAssistantText: '고쳤습니다.' })).toEqual({ continue: false });
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    await cli.hooks.onRunEnd!({ state: {}, result: { stopReason: 'end_turn' } });
    // 통과한 실행은 StopFailure로 닫히지 않는다
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
    await stopSession(session.id);
  }, 30_000);

  it('서버에 닿지 못하면 쓰기 직전 훅이 막는다: 관문을 닫으면 도구가 실행되지 않는다. 대조로 열려 있을 때는 같은 쓰기가 실행된다', async () => {
    const session = await open();
    const { cli, gateway } = await launchCli(session);
    await cli.hooks.transformInput!({ text: '주문에 메모 필드 추가' });
    expect((await writeFileTool(session, cli, 'api/src/First.java', 'class First {}\n')).blocked).toBeUndefined();
    expect(await fileOf(session, 'api/src/First.java')).toBe('class First {}\n');

    await gateway.close();
    const denied = await writeFileTool(session, cli, 'api/src/Second.java', 'class Second {}\n');
    expect(denied.blocked).toContain('[b-studio] 관문에 닿지 못해');
    await expect(fileOf(session, 'api/src/Second.java')).rejects.toThrow();
    // 요청 받기도 막는다
    expect(await cli.hooks.transformInput!({ text: '다음' })).toMatchObject({ action: 'handled' });
    // 턴 끝은 통과로 읽지 않는다: 체크포인트가 없고, 이어가라는 답이 간다
    const stop = await cli.hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: '' });
    expect(stop.continue).toBe(true);
    expect(getSnapshot(session.id)!.checkpoints.length).toBe(1);
    await stopSession(session.id);
  }, 30_000);

  it('틀린 토큰(서버가 401로 거절)·닿지 않는 주소는 이상한 응답이라 막는다', async () => {
    const session = await open();
    const wrongToken = await launchCli(session, (real) => ({ url: real.url, token: 'wrong-token' }));
    await wrongToken.cli.hooks.transformInput!({ text: '요청' });
    expect((await writeFileTool(session, wrongToken.cli, 'api/src/A.java', 'class A {}\n')).blocked).toContain('HTTP');
    await expect(fileOf(session, 'api/src/A.java')).rejects.toThrow();
    const dead = await launchCli(session, () => ({ url: 'http://127.0.0.1:1', token: 'x' }));
    expect((await writeFileTool(session, dead.cli, 'api/src/B.java', 'class B {}\n')).blocked).toContain('[b-studio] 관문에 닿지 못해');
    await expect(fileOf(session, 'api/src/B.java')).rejects.toThrow();
    await stopSession(session.id);
  }, 30_000);

  it('읽기만 요청: 요청이 읽기만이면 맥락 글이 요청에 덧붙고, 그 실행의 쓰기는 막힌다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    const input = await cli.hooks.transformInput!({ text: '[읽기만] 구조를 설명해 줘' });
    expect(input.action).toBe('transform');
    expect(input.text.startsWith('[읽기만] 구조를 설명해 줘\n\n')).toBe(true);
    const denied = await writeFileTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(denied.blocked).toBeTruthy();
    expect(await fileOf(session)).toBe(ORIGINAL);
    await cli.hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: '설명했습니다.' });
    await stopSession(session.id);
  }, 30_000);

  it('훅 없이 끝난 실행(턴 상한 등)은 StopFailure로 알려 실패로 닫고 이번 변경을 되돌린다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    const before = getSnapshot(session.id)!.checkpoints.length;
    await cli.hooks.transformInput!({ text: '주문에 메모 필드 추가' });
    await writeFileTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    await cli.hooks.onRunEnd!({ state: {}, result: { stopReason: 'max_turns', turnCount: 50, finalText: '' } });
    const finished = session.ofType('run_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'failed' });
    expect(await fileOf(session)).toBe(ORIGINAL);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(false);
    await stopSession(session.id);
  }, 30_000);

  it('서브에이전트의 시작·끝이 활동에 남는다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.hooks.transformInput!({ text: '조사해 줘' });
    await cli.emit('subagent_start', { type: 'subagent_start', toolCallId: 'agent-1', subagentType: 'explore', description: '구조 조사' });
    const started = Date.now();
    while (!sessionTerminalActivity(session.id)?.subagents?.some((agent) => agent.id === 'agent-1')) {
      if (Date.now() - started > 3000) throw new Error('서브에이전트 시작이 활동에 오지 않았습니다');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await cli.emit('subagent_stop', { type: 'subagent_stop', toolCallId: 'agent-1', subagentType: 'explore', tokensUsed: 5 });
    while (sessionTerminalActivity(session.id)?.subagents?.find((agent) => agent.id === 'agent-1')?.state !== 'done') {
      if (Date.now() - started > 3000) throw new Error('서브에이전트 끝이 활동에 오지 않았습니다');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await cli.hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: '' });
    await stopSession(session.id);
  }, 30_000);
});

describe('Command Code 터미널은 실험이고 이 컴퓨터 방식에서만 열린다', () => {
  it('실험 스위치가 꺼져 있으면 열지 않는다(claude를 대신 띄우지도 않는다). 켜면 열린다(대조)', async () => {
    const session = await open();
    expect(sessionTerminalTarget(session.id).cli).toBe('commandcode');
    process.env.B_STUDIO_EXPERIMENTAL = '0';
    expect(() => sessionTerminalTarget(session.id)).toThrow('B_STUDIO_EXPERIMENTAL=1');
    process.env.B_STUDIO_EXPERIMENTAL = '1';
    expect(sessionTerminalTarget(session.id).cli).toBe('commandcode');
    await stopSession(session.id);
  }, 30_000);

  it('컨테이너 방식은 거절한다(컨테이너에는 commandcode가 없다). claude를 대신 띄우지 않는다', async () => {
    const session = await open();
    process.env.B_STUDIO_TERMINAL = 'container';
    fake.terminalMode = 'container';
    expect(() => sessionTerminalTarget(session.id)).toThrow('컨테이너 방식은 지원하지 않습니다');
    await stopSession(session.id);
  }, 30_000);

  it('세션에 고른 모델이 있어도 터미널 대상에 모델을 싣지 않는다(기본 모델로만 띄운다)', async () => {
    const session = await open('deepseek/deepseek-v4-flash');
    const target = sessionTerminalTarget(session.id);
    expect(target.cli).toBe('commandcode');
    expect(target.model).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);
});
