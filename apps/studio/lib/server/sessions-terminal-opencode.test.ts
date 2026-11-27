import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OPENCODE_PLUGIN, OPENCODE_PLUGIN_NAME } from '@b-studio/sandbox';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * OpenCode 세션 터미널(ADR-241, 실험). **진짜 플러그인 파일**을 불러 훅 함수를 부르는 가짜 CLI와, **진짜 훅 서버**(관문)와, 진짜 sessions.ts의 판정을 잇는다.
 * 가짜는 샌드박스(Docker)와 터미널 모듈의 바깥 일(PTY)뿐이다. 진짜 opencode도 모델도 띄우지 않는다.
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
    id: 'studio-termoc-fake',
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
// opencode 백엔드 세션은 만들 때 실제 CLI 로그인을 확인한다. 여기서는 CLI를 부르지 않고 통과시킨다
vi.mock('@b-studio/agent', async (importOriginal) => ({ ...(await importOriginal<typeof import('@b-studio/agent')>()), preflightOpenCode: async () => ({ ok: true as const }) }));
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

import { createSession, getSnapshot, sessionTerminalTarget, setTerminalTaskContext, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';
import { armModClock, disarmModClock } from './session-terminal-mod';
import { startTerminalGateway, type TerminalGateway } from './terminal-gateway';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR, backends: process.env.B_STUDIO_BACKENDS, terminal: process.env.B_STUDIO_TERMINAL, gatewayDir: process.env.B_STUDIO_GATEWAY_DIR };

const STUDIO_YAML = `version: 1
name: termoc
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termoc-session-'));
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
  process.env.B_STUDIO_BACKENDS = 'opencode';
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
  const id = (await createSession('termoc', 'kim', 'copy', { backend: 'opencode', ...(modelId ? { modelId } : {}) })).id;
  const started = Date.now();
  while (getSnapshot(id)?.status !== 'ready') {
    if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events: StudioEvent[] = [];
  subscribe(id, (event) => events.push(event));
  return { id, work: sessionTerminalTarget(id).root, events, ofType: (type) => events.filter((event): event is Extract<StudioEvent, { type: typeof type }> => event.type === type) };
}

// 가짜 OpenCode가 플러그인의 훅을 부르는 자리다. 훅마다 인자·답의 모양이 달라 시험이 꺼내 본다
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Hook = (...args: any[]) => any;
interface FakeCli {
  hooks: Record<string, Hook>;
  /** 플러그인이 `client.session.promptAsync`로 다음 요청으로 보낸 글(게이트의 사유) */
  prompted: string[];
  toasts: string[];
  fire(type: string, properties: unknown): Promise<void>;
  /** 설정 확인 훅. 기본은 우리 플러그인 하나뿐인 설정 */
  configure(plugins?: unknown[]): Promise<void>;
}

/**
 * 진짜 훅 서버(관문)를 띄우고, 관문 폴더에 플러그인 파일과 주소 파일을 쓴 뒤, 그 플러그인을 진짜로 불러 훅을 모은다.
 * 감싸개가 하는 일(환경 변수로 관문 폴더 알리기)도 여기서 한다. `override`를 주면 그 주소 파일을 쓴다(닿지 못하는 주소·틀린 토큰)
 */
async function launchCli(session: Opened, override?: (real: { url: string; token: string }) => { url: string; token: string }, directory: string = session.work): Promise<{ cli: FakeCli; gateway: TerminalGateway; dir: string }> {
  const gateway = await startTerminalGateway(terminalGatewayHandlersForTest(session.id), '127.0.0.1');
  gateways.push(gateway);
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-termoc-gw-'));
  const real = { url: gateway.address.hookUrl, token: gateway.address.hookToken };
  await writeFile(path.join(dir, 'b-studio-gateway.json'), `${JSON.stringify(override ? override(real) : real)}\n`);
  process.env.B_STUDIO_GATEWAY_DIR = dir;
  const copy = path.join(dir, `${OPENCODE_PLUGIN_NAME}.loaded.mjs`);
  await writeFile(copy, OPENCODE_PLUGIN);
  await writeFile(path.join(dir, OPENCODE_PLUGIN_NAME), OPENCODE_PLUGIN);
  const loaded = (await import(/* @vite-ignore */ copy)) as { default: (input: unknown) => Promise<Record<string, Hook>> };
  const prompted: string[] = [];
  const toasts: string[] = [];
  const hooks = await loaded.default({
    directory,
    client: {
      session: {
        promptAsync: async (request: { body: { parts: Array<{ text: string }> } }) => {
          prompted.push(request.body.parts.map((part) => part.text).join(''));
          return { data: undefined, error: undefined };
        },
        get: async (request: { path: { id: string } }) => ({ data: { id: request.path.id }, error: undefined }),
      },
      tui: { showToast: async (request: { body: { message: string } }) => void toasts.push(request.body.message) },
    },
  });
  const ours = pathToFileURL(path.join(dir, OPENCODE_PLUGIN_NAME)).href;
  return {
    cli: {
      hooks,
      prompted,
      toasts,
      fire: async (type, properties) => {
        await hooks.event!({ event: { id: 'e', type, properties } });
      },
      configure: async (plugins) => {
        await hooks.config!({ plugin: plugins ?? [ours] });
      },
    },
    gateway,
    dir,
  };
}

let callCounter = 0;
/**
 * OpenCode가 하는 대로: 쓰기 직전 훅을 부르고(던지면 도구는 실행되지 않는다), 막히지 않았으면 파일을 쓰고, 쓰기 뒤 훅을 부른다.
 * 도구 이름과 입력 열쇠는 OpenCode의 것이다(`write` + `filePath`·`content`)
 */
async function toolCall(cli: FakeCli, tool: string, args: Record<string, unknown>, effect?: () => Promise<void>): Promise<{ blocked?: string }> {
  callCounter += 1;
  const callID = `call-${callCounter}`;
  try {
    await cli.hooks['tool.execute.before']!({ tool, sessionID: 'ses_1', callID }, { args });
  } catch (error) {
    return { blocked: error instanceof Error ? error.message : String(error) };
  }
  await effect?.();
  await cli.hooks['tool.execute.after']!({ tool, sessionID: 'ses_1', callID, args }, { title: tool, output: '', metadata: {} });
  return {};
}
const writeTool = (session: Opened, cli: FakeCli, file: string, content: string) => toolCall(cli, 'write', { filePath: path.join(session.work, file), content }, () => writeFile(path.join(session.work, file), content));
const fileOf = (session: Opened, file = 'api/src/Order.java') => readFile(path.join(session.work, file), 'utf8');
const ORIGINAL = 'class Order {}\n';

/** 사용자가 요청을 보낸다(`chat.message`). 막히면 던진 글을 돌려준다 */
async function userPrompt(cli: FakeCli, text: string): Promise<{ error?: string; text: string }> {
  const part = { type: 'text', text };
  try {
    await cli.hooks['chat.message']!({ sessionID: 'ses_1', agent: 'build' }, { message: {}, parts: [part] });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), text: part.text };
  }
  return { text: part.text };
}
/** 모델이 턴을 끝낸다: 마지막 답 글을 알리고 `session.idle`을 보낸다(OpenCode는 기다려 주지 않으므로 소식이 처리될 때까지 우리가 기다린다) */
async function endTurn(cli: FakeCli, lastText = '끝냈습니다.'): Promise<void> {
  await cli.fire('message.updated', { info: { id: `m-${callCounter}`, sessionID: 'ses_1', role: 'assistant' } });
  await cli.fire('message.part.updated', { part: { id: 'p1', messageID: `m-${callCounter}`, sessionID: 'ses_1', type: 'text', text: lastText } });
  await cli.fire('session.idle', { sessionID: 'ses_1' });
}

describe('OpenCode 터미널: 진짜 플러그인 → 진짜 훅 서버 → 진짜 판정', () => {
  it('통과 흐름: 설정 확인 → 요청 → 읽기 → 쓰기 → 턴 끝 게이트 통과 → 체크포인트. 기록의 백엔드는 opencode다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    const before = getSnapshot(session.id)!.checkpoints.length;

    // 설정 확인이 끝나면 CLI가 떴다고 알린다
    await cli.configure();
    const started = Date.now();
    while (!fake.cli.includes(true)) {
      if (Date.now() - started > 3000) throw new Error('세션 시작 신호가 오지 않았습니다');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect((await userPrompt(cli, '주문에 메모 필드 추가')).error).toBeUndefined();
    expect(session.ofType('run_started')).toMatchObject([{ request: '주문에 메모 필드 추가', via: 'terminal', backend: 'opencode' }]);
    // 읽기 도구는 막지 않는다(OpenCode의 이름: read, glob)
    expect((await toolCall(cli, 'read', { filePath: path.join(session.work, 'api/src/Order.java') })).blocked).toBeUndefined();
    expect((await toolCall(cli, 'glob', { pattern: '**/*.java' })).blocked).toBeUndefined();

    expect((await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n')).blocked).toBeUndefined();
    await endTurn(cli, '메모 필드를 추가했습니다.');

    const snapshot = getSnapshot(session.id)!;
    expect(snapshot.checkpoints).toHaveLength(before + 1);
    expect(snapshot.checkpoints[0]).toMatchObject({ message: 'feat: 주문에 메모 필드 추가', files: ['api/src/Order.java'] });
    expect(snapshot.checkpoints[0]!.passedStages).toEqual(expect.arrayContaining(['run', 'contract_check', 'test', 'review']));
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
    expect(cli.toasts.some((text) => text.includes('검증 통과 — 체크포인트'))).toBe(true);
    // 통과하면 다음 요청으로 보낼 것이 없다
    expect(cli.prompted).toEqual([]);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
    expect(snapshot.running).toBe(false);
    // 모델 고르기 인자는 목표에 없다: 터미널 대상에 모델이 실리지 않는다
    expect(sessionTerminalTarget(session.id).cli).toBe('opencode');
    expect(sessionTerminalTarget(session.id).model).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('읽기 도구(OpenCode의 이름)는 실행을 열지 않고 바로 통과한다. 모르는 이름(skill·lsp·task·MCP 도구)은 바꾸는 도구로 본다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    for (const [name, input] of [
      ['read', { filePath: path.join(session.work, 'api/src/Order.java') }],
      ['glob', { pattern: '**/*.java' }],
      ['grep', { pattern: 'Order' }],
      ['webfetch', { url: 'https://example.com' }],
      ['todowrite', { todos: [] }],
    ] as const) {
      expect((await toolCall(cli, name, input)).blocked, name).toBeUndefined();
    }
    expect(session.ofType('run_started')).toEqual([]);
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 대조: 셸·그 밖의 이름은 실행을 연다
    await toolCall(cli, 'bash', { command: 'ls' });
    expect(session.ofType('run_started')).toHaveLength(1);
    await cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'x' } } });
    await cli.fire('session.idle', { sessionID: 'ses_1' });
    await stopSession(session.id);
  }, 30_000);

  it('카드의 쓰기 범위 밖 쓰기는 막히고 파일이 만들어지지 않는다. 상대 경로도 같다. 범위 안은 통과한다(대조)', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await userPrompt(cli, '주문에 메모 필드 추가');

    const denied = await writeTool(session, cli, 'web/other.txt', 'x');
    expect(denied.blocked).toContain('이 카드가 쓸 수 있는 경로는 api/src입니다');
    expect(denied.blocked).toContain('web/other.txt');
    await expect(fileOf(session, 'web/other.txt')).rejects.toThrow();
    const relative = await toolCall(cli, 'edit', { filePath: 'web/other.txt', oldString: 'a', newString: 'b' });
    expect(relative.blocked).toContain('web/other.txt');
    // 경로가 별칭 열쇠로 오거나 모르는 열쇠가 끼면 어느 파일인지 알 수 없어 막는다
    for (const key of ['file_path', 'path', 'target_file']) {
      const viaAlias = await toolCall(cli, 'write', { filePath: path.join(session.work, 'api/src/ok.txt'), [key]: path.join(session.work, 'web/other.txt'), content: 'x' });
      expect(viaAlias.blocked, key).toContain('알 수 없어');
    }
    expect((await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n')).blocked).toBeUndefined();
    // 패치 도구는 이름을 바꾼 대상도 범위에서 본다
    const patch = ['*** Begin Patch', '*** Update File: api/src/Order.java', '*** Move to: web/moved.java', '@@', '-class Order { String memo; }', '+class Order { String memo; }', '*** End Patch'].join('\n');
    expect((await toolCall(cli, 'apply_patch', { patchText: patch })).blocked).toContain('web/moved.java');
    setTerminalTaskContext(session.id, undefined);
    await cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'x' } } });
    await cli.fire('session.idle', { sessionID: 'ses_1' });
    await stopSession(session.id);
  }, 30_000);

  it('보호 경로: 작업 복사본 밖을 가리키는 링크를 지나는 쓰기는 범위 안의 글자여도 막힌다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    await symlink(outside, path.join(session.work, 'api/src/escape'));
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await userPrompt(cli, '주문에 메모 필드 추가');
    const denied = await toolCall(cli, 'write', { filePath: path.join(session.work, 'api/src/escape/x.txt'), content: 'x' });
    expect(denied.blocked).toContain('범위 밖이라 쓰지 않았습니다');
    await expect(readFile(path.join(outside, 'x.txt'), 'utf8')).rejects.toThrow();
    expect((await toolCall(cli, 'write', { filePath: path.join(session.work, 'api/src/real/x.txt'), content: 'x' })).blocked).toBeUndefined();
    setTerminalTaskContext(session.id, undefined);
    await cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'x' } } });
    await cli.fire('session.idle', { sessionID: 'ses_1' });
    await stopSession(session.id);
  }, 30_000);

  it('게이트가 실패하면 사유가 같은 세션의 다음 요청으로 가고 체크포인트는 없다. 그 요청은 새 요청이 아니다. 고친 뒤 턴이 끝나면 통과한다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await userPrompt(cli, '주문에 메모 필드 추가');
    await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo }\n');

    fake.failCommands = ['test'];
    await endTurn(cli, '추가했습니다.');
    expect(cli.prompted).toHaveLength(1);
    expect(cli.prompted[0]).toContain('[b-studio 검증 게이트]');
    expect(cli.prompted[0]).toContain('unit');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(true);

    // OpenCode가 그 요청을 받는다: 사용자의 새 요청으로 서버에 알리지 않는다(실행이 새로 열리지 않는다)
    const feedback = cli.prompted[0]!;
    expect((await userPrompt(cli, feedback)).error).toBeUndefined();
    expect(session.ofType('run_started')).toHaveLength(1);

    fake.failCommands = [];
    await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    await endTurn(cli, '고쳤습니다.');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(cli.prompted).toHaveLength(1);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
    await stopSession(session.id);
  }, 30_000);

  it('서버에 닿지 못하면 쓰기 직전 훅이 던져 막는다: 관문을 닫으면 도구가 실행되지 않는다. 대조로 열려 있을 때는 같은 쓰기가 실행된다', async () => {
    const session = await open();
    const { cli, gateway } = await launchCli(session);
    await cli.configure();
    await userPrompt(cli, '주문에 메모 필드 추가');
    expect((await writeTool(session, cli, 'api/src/First.java', 'class First {}\n')).blocked).toBeUndefined();
    expect(await fileOf(session, 'api/src/First.java')).toBe('class First {}\n');

    await gateway.close();
    const denied = await writeTool(session, cli, 'api/src/Second.java', 'class Second {}\n');
    expect(denied.blocked).toContain('[b-studio] 관문에 닿지 못해');
    await expect(fileOf(session, 'api/src/Second.java')).rejects.toThrow();
    // 읽기 도구도 관문에 묻는다(읽기 표는 서버에 한 곳이다): 닿지 못하면 막힌다
    expect((await toolCall(cli, 'read', { filePath: 'a' })).blocked).toContain('[b-studio] 관문에 닿지 못해');
    // 요청 받기도 막는다
    expect((await userPrompt(cli, '다음')).error).toContain('요청을 보내지 않았습니다');
    // 턴 끝은 통과로 읽지 않는다: 체크포인트가 없고, 검증하지 못했다는 글이 다음 요청으로 간다
    await endTurn(cli, '');
    expect(cli.prompted).toHaveLength(1);
    expect(cli.prompted[0]).toContain('검증하지 못했습니다');
    expect(getSnapshot(session.id)!.checkpoints.length).toBe(1);
    await stopSession(session.id);
  }, 30_000);

  it('틀린 토큰(서버가 401로 거절)·닿지 않는 주소는 이상한 응답이라 막는다', async () => {
    const session = await open();
    const wrongToken = await launchCli(session, (real) => ({ url: real.url, token: 'wrong-token' }));
    await wrongToken.cli.configure();
    expect((await userPrompt(wrongToken.cli, '요청')).error).toContain('HTTP');
    expect((await writeTool(session, wrongToken.cli, 'api/src/A.java', 'class A {}\n')).blocked).toContain('HTTP');
    await expect(fileOf(session, 'api/src/A.java')).rejects.toThrow();
    const dead = await launchCli(session, () => ({ url: 'http://127.0.0.1:1', token: 'x' }));
    await dead.cli.configure();
    expect((await writeTool(session, dead.cli, 'api/src/B.java', 'class B {}\n')).blocked).toContain('[b-studio] 관문에 닿지 못해');
    await expect(fileOf(session, 'api/src/B.java')).rejects.toThrow();
    await stopSession(session.id);
  }, 30_000);

  it('읽기만 요청: 요청이 읽기만이면 맥락 글이 요청에 덧붙고, 그 실행의 쓰기는 막힌다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    const sent = await userPrompt(cli, '[읽기만] 구조를 설명해 줘');
    expect(sent.error).toBeUndefined();
    expect(sent.text.startsWith('[읽기만] 구조를 설명해 줘\n\n')).toBe(true);
    const denied = await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(denied.blocked).toBeTruthy();
    expect(await fileOf(session)).toBe(ORIGINAL);
    await endTurn(cli, '설명했습니다.');
    await stopSession(session.id);
  }, 30_000);

  it('오류로 끝난 턴(API 오류 등)은 게이트 없이 StopFailure로 알려 실패로 닫고 이번 변경을 되돌린다. 사람이 누른 중단은 닫지 않는다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await userPrompt(cli, '주문에 메모 필드 추가');
    await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    // 중단: 실행은 열린 채 남는다
    await cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    await cli.fire('session.idle', { sessionID: 'ses_1' });
    expect(session.ofType('run_finished')).toEqual([]);
    expect(getSnapshot(session.id)!.running).toBe(true);
    // 오류로 끝났다
    await cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'rate limit' } } });
    await cli.fire('session.idle', { sessionID: 'ses_1' });
    const finished = session.ofType('run_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'failed' });
    expect(await fileOf(session)).toBe(ORIGINAL);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(false);
    await stopSession(session.id);
  }, 30_000);
});

describe('OpenCode 터미널: 설정이 훅을 비켜 가는 길을 닫는다(ADR-241)', () => {
  it('작업 폴더의 .opencode·opencode.json 쓰기는 카드가 없어도 막힌다: 대소문자·상대 경로·.. 표기·패치의 이름 바꾸기도 막고, 관계없는 파일은 통과한다(대조)', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    await userPrompt(cli, '설정 정리');
    const targets = [
      path.join(session.work, '.opencode/plugins/evil.js'),
      path.join(session.work, '.opencode/opencode.json'),
      path.join(session.work, 'opencode.json'),
      path.join(session.work, 'opencode.jsonc'),
      path.join(session.work, 'tui.json'),
      path.join(session.work, '.OpenCode/Plugin/x.ts'),
      path.join(session.work, 'api/../.opencode/plugin/x.ts'),
      '.opencode/plugins/relative.js',
    ];
    for (const file of targets) {
      const written = await toolCall(cli, 'write', { filePath: file, content: 'export default async () => ({})' });
      expect(written.blocked, `write ${file}`).toContain('OpenCode의 설정·플러그인 자리');
      const edited = await toolCall(cli, 'edit', { filePath: file, oldString: 'a', newString: 'b' });
      expect(edited.blocked, `edit ${file}`).toContain('OpenCode의 설정·플러그인 자리');
    }
    const patch = ['*** Begin Patch', '*** Add File: .opencode/plugins/evil.js', '+x', '*** End Patch'].join('\n');
    expect((await toolCall(cli, 'apply_patch', { patchText: patch })).blocked).toContain('OpenCode의 설정·플러그인 자리');
    const moved = ['*** Begin Patch', '*** Update File: api/src/Order.java', '*** Move to: opencode.json', '@@', '-class Order {}', '+class Order {}', '*** End Patch'].join('\n');
    expect((await toolCall(cli, 'apply_patch', { patchText: moved })).blocked).toContain('OpenCode의 설정·플러그인 자리');
    await expect(readFile(path.join(session.work, '.opencode/plugins/evil.js'), 'utf8')).rejects.toThrow();
    // 대조: 관계없는 파일은 통과한다
    expect((await writeTool(session, cli, 'api/src/Order.java', 'class Order { int a; }\n')).blocked).toBeUndefined();
    await cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'x' } } });
    await cli.fire('session.idle', { sessionID: 'ses_1' });
    await stopSession(session.id);
  }, 30_000);

  it('카드가 없어도 바꿀 파일을 알 수 없는 파일 도구(모르는 열쇠·패치 본문)는 막는다. 셸 도구는 그대로다(대조)', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    const unknownKey = await toolCall(cli, 'write', { filePath: path.join(session.work, 'api/src/Order.java'), destination: path.join(session.work, '.opencode/plugins/x.js'), content: 'x' });
    expect(unknownKey.blocked).toContain('알 수 없어');
    expect((await toolCall(cli, 'apply_patch', { patchText: '*** Begin Patch\n*** Rename File: a\n*** End Patch' })).blocked).toContain('알 수 없어');
    await expect(readFile(path.join(session.work, '.opencode/plugins/x.js'), 'utf8')).rejects.toThrow();
    expect((await toolCall(cli, 'bash', { command: 'ls' })).blocked).toBeUndefined();
    await cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'x' } } });
    await cli.fire('session.idle', { sessionID: 'ses_1' });
    await stopSession(session.id);
  }, 30_000);
});

describe('OpenCode 터미널: 작업 복사본이 아닌 폴더에서 일하면 막는다(ADR-241)', () => {
  it('다른 폴더에서 뜬 OpenCode(`opencode <경로>`·`--dir`)의 쓰기 도구는 막힌다. 읽기 도구와 같은 폴더(링크로 돌아온 경로 포함)는 통과한다(대조)', async () => {
    const session = await open();
    const elsewhere = await launchCli(session, undefined, outside);
    await elsewhere.cli.configure();
    await userPrompt(elsewhere.cli, '주문에 메모 필드 추가');
    const denied = await toolCall(elsewhere.cli, 'write', { filePath: 'api/src/New.java', content: 'class New {}\n' }, () => writeFile(path.join(session.work, 'api/src/New.java'), 'x'));
    expect(denied.blocked).toContain('세션의 작업 복사본이 아닌 폴더');
    await expect(fileOf(session, 'api/src/New.java')).rejects.toThrow();
    // 글자는 같아 보여도 다른 폴더(작업 복사본 안의 하위 폴더)는 같은 폴더가 아니다
    const sub = await launchCli(session, undefined, path.join(session.work, 'api'));
    await sub.cli.configure();
    expect((await toolCall(sub.cli, 'bash', { command: 'ls' })).blocked).toContain('세션의 작업 복사본이 아닌 폴더');
    // 플러그인이 폴더를 알리지 못해도(입력에 directory가 없다) 같다고 말할 수 없어 막는다
    const unknown = await launchCli(session, undefined, null as unknown as string);
    await unknown.cli.configure();
    expect((await toolCall(unknown.cli, 'bash', { command: 'ls' })).blocked).toContain('세션의 작업 복사본이 아닌 폴더');
    // 대조: 읽기 도구는 막지 않는다
    expect((await toolCall(elsewhere.cli, 'read', { filePath: path.join(session.work, 'api/src/Order.java') })).blocked).toBeUndefined();
    // 링크로 같은 폴더를 가리키는 경로는 통과한다
    const link = path.join(path.dirname(session.work), 'work-link');
    await symlink(session.work, link);
    const viaLink = await launchCli(session, undefined, link);
    await viaLink.cli.configure();
    expect((await writeTool(session, viaLink.cli, 'api/src/Order.java', 'class Order { int a; }\n')).blocked).toBeUndefined();
    await viaLink.cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'x' } } });
    await viaLink.cli.fire('session.idle', { sessionID: 'ses_1' });
    await stopSession(session.id);
  }, 30_000);
});

describe('OpenCode 터미널: 플러그인이 불러와졌다는 신호는 진짜 플러그인과 훅 서버를 거쳐 시계에 닿는다', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('설정 확인을 통과해 session-start가 오면 시계가 선다. 다른 플러그인이 설정에 있으면 신호를 보내지 않아 시계가 위반으로 본다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    const violations: string[] = [];
    armModClock(session.id, (reason) => violations.push(reason), 150, 'opencode');
    await cli.configure();
    await wait(300);
    expect(violations).toEqual([]);
    disarmModClock(session.id);

    // 대조: 다른 플러그인이 설정에 있다
    const other = await launchCli(session);
    armModClock(session.id, (reason) => violations.push(reason), 150, 'opencode');
    await other.cli.configure([pathToFileURL(path.join(other.dir, OPENCODE_PLUGIN_NAME)).href, 'opencode-evil@1.0.0']);
    await wait(300);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('OpenCode');
    // 그 플러그인은 모든 도구를 막는다(읽기 도구도)
    expect((await toolCall(other.cli, 'read', { filePath: 'a' })).blocked).toContain('플러그인');
    disarmModClock(session.id);
    await stopSession(session.id);
  }, 30_000);

  it('플러그인이 끝을 알려도(dispose) 열린 실행을 닫지 않는다: CLI 표시만 내린다. 인스턴스를 다시 만든 것과 CLI의 끝을 가를 수 없다', async () => {
    const session = await open();
    const { cli } = await launchCli(session);
    await cli.configure();
    await userPrompt(cli, '주문에 메모 필드 추가');
    await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    fake.cli = [];
    await cli.hooks.dispose!();
    expect(fake.cli).toContain(false);
    expect(getSnapshot(session.id)!.running).toBe(true);
    expect(session.ofType('run_finished')).toEqual([]);
    expect(await fileOf(session)).toBe('class Order { String memo; }\n');
    // 다시 뜬 플러그인의 session-start가 CLI 표시를 올린다
    const again = await launchCli(session);
    fake.cli = [];
    await again.cli.configure();
    const started = Date.now();
    while (!fake.cli.includes(true)) {
      if (Date.now() - started > 3000) throw new Error('세션 시작 신호가 오지 않았습니다');
      await wait(10);
    }
    await again.cli.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'x' } } });
    await again.cli.fire('session.idle', { sessionID: 'ses_1' });
    await stopSession(session.id);
  }, 30_000);
});

describe('OpenCode 터미널은 실험이고 이 컴퓨터 방식에서만 열린다', () => {
  it('실험 스위치가 꺼져 있으면 열지 않는다(claude를 대신 띄우지도 않는다). 켜면 열린다(대조)', async () => {
    const session = await open();
    expect(sessionTerminalTarget(session.id).cli).toBe('opencode');
    process.env.B_STUDIO_EXPERIMENTAL = '0';
    expect(() => sessionTerminalTarget(session.id)).toThrow('B_STUDIO_EXPERIMENTAL=1');
    process.env.B_STUDIO_EXPERIMENTAL = '1';
    expect(sessionTerminalTarget(session.id).cli).toBe('opencode');
    await stopSession(session.id);
  }, 30_000);

  it('컨테이너 방식은 거절한다(컨테이너에는 opencode가 없다). claude를 대신 띄우지 않는다', async () => {
    const session = await open();
    process.env.B_STUDIO_TERMINAL = 'container';
    fake.terminalMode = 'container';
    expect(() => sessionTerminalTarget(session.id)).toThrow('컨테이너 방식은 지원하지 않습니다');
    await stopSession(session.id);
  }, 30_000);

  it('세션에 고른 모델이 있어도 터미널 대상에 모델을 싣지 않는다(기본 모델로만 띄운다)', async () => {
    const session = await open('anthropic/claude-sonnet-4-5');
    const target = sessionTerminalTarget(session.id);
    expect(target.cli).toBe('opencode');
    expect(target.model).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);
});
