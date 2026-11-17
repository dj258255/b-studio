import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 세션 터미널의 턴이 API 오류로 끝났을 때(StopFailure 훅, #1284, ADR-214)의 실행 닫기를 실제 sessions.ts로 본다. 가짜는 샌드박스(Docker)와 세션 터미널(컨테이너의 CLI)뿐이다.
 * CLI가 하는 일은 훅을 부르는 것과 작업 복사본의 파일을 고치는 것이므로 테스트가 그 둘을 직접 한다. 작업 복사본·체크포인트·게이트는 실제 코드가 돈다.
 * 기존 터미널 시험(`sessions-terminal-gateway.test.ts`)의 가짜 샌드박스·가짜 훅 방식과 같다.
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
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-stopfail-fake',
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
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({ findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root) }));
vi.mock('@b-studio/agent', async (importOriginal) => ({ ...(await importOriginal<typeof import('@b-studio/agent')>()), preflightCodex: async () => ({ ok: true as const }) }));
vi.mock('./session-terminal', () => ({
  disposeSessionTerminal: async () => {},
  interruptSessionTerminal: (sessionId: string) => {
    fake.interrupts.push(sessionId);
  },
  noteSessionTerminalCli: () => {},
  sessionTerminalMode: () => 'container',
  warnSessionTerminal: () => {},
  terminalPause: () => undefined,
}));

import { createSession, getSnapshot, openTerminalRunId, sessionTerminalTarget, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: stopfail
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-stopfail-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), STUDIO_YAML);
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

async function open({ lazy = false }: { lazy?: boolean } = {}): Promise<Opened> {
  const id = (await createSession('stopfail', 'kim', 'copy', lazy ? { boot: 'on-demand' as const } : {})).id;
  openSessions.push(id);
  const started = Date.now();
  while (getSnapshot(id)?.status !== (lazy ? 'idle' : 'ready')) {
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

async function finishedRuns(session: Opened, count: number): Promise<Array<Extract<StudioEvent, { type: 'run_finished' }>>> {
  await until(`실행 닫힘 ${count}개`, () => session.ofType('run_finished').length >= count);
  return session.ofType('run_finished');
}

const ORIGINAL = 'class Order {}\n';
const fileOf = (session: Opened, file = 'api/src/Order.java') => readFile(path.join(session.work, file), 'utf8');
const edit = (session: Opened, file: string, content: string) => writeFile(path.join(session.work, file), content);
const WRITE = { tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: 'class Order { String memo; }\n' } };


/** 사용 한도 같은 API 오류로 턴이 끝났을 때 CLI가 Stop 대신 보내는 훅의 입력(error가 종류다. CLI 2.1.326 실행 파일에서 읽었다) */
const failure = (error?: unknown) => ({ hook_event_name: 'StopFailure', ...(error === undefined ? {} : { error }), last_assistant_message: 'API Error: usage limit reached' });

/** 훅 처리를 부른다. 고치기 전 코드에는 이 처리가 없어 이름이 없다는 오류로 실패한다 */
function stopFailure(session: Opened, input: Record<string, unknown>): Promise<void> {
  const handler = (session.gateway as unknown as { stopFailure?: (input: Record<string, unknown>) => Promise<void> }).stopFailure;
  if (!handler) throw new Error('관문에 StopFailure 처리가 없습니다');
  return handler(input);
}

async function openRunWithEdit(session: Opened, prompt = '주문에 메모 필드 추가'): Promise<void> {
  await session.gateway.prompt({ prompt });
  expect(await session.gateway.preTool(WRITE)).toEqual({});
  await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
}

describe('결함의 증상(#1284): Stop 훅이 오지 않으면 실행은 열린 채 남고 다음 요청을 삼킨다', () => {
  it('API 오류로 턴이 끝나 Stop이 오지 않으면, 실행은 열려 있고 다음 prompt 훅이 같은 실행에 붙는다', async () => {
    const session = await open();
    await openRunWithEdit(session);
    const runId = openTerminalRunId(session.id)!;
    expect(runId).toBeDefined();
    // Stop도 StopFailure도 오지 않았다. 사용자가 다음 요청을 보낸다
    await session.gateway.prompt({ prompt: '다시 해 줘' });
    expect(openTerminalRunId(session.id)).toBe(runId);
    expect(session.ofType('run_finished')).toEqual([]);
    expect(await fileOf(session)).toBe('class Order { String memo; }\n');
  }, 30_000);
});

describe('StopFailure는 열린 실행을 실패로 닫고 되돌린다 (#1284)', () => {
  it('파일을 바꾼 실행: 실패로 닫고 되돌리며, 게이트는 돌리지 않고, 점유가 풀려 다음 요청을 받는다. 사유에 오류 종류가 든다', async () => {
    const session = await open();
    await openRunWithEdit(session);
    expect(await fileOf(session)).toBe('class Order { String memo; }\n');

    await stopFailure(session, failure('rate_limit'));

    const [finished] = await finishedRuns(session, 1);
    expect(finished).toMatchObject({ status: 'failed' });
    expect(finished!.summary).toContain('API 오류(rate_limit)로 턴이 끝나 요청을 닫았습니다');
    // 되돌렸다
    expect(await fileOf(session)).toBe(ORIGINAL);
    expect(openTerminalRunId(session.id)).toBeUndefined();
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 게이트(선언한 테스트)를 돌리지 않았다: 오류로 끊긴 턴은 일을 마친 것이 아니다
    expect(fake.execCalls.filter((command) => command.includes('test'))).toEqual([]);
    expect(session.ofType('run_finished')).toHaveLength(1);
    // 다음 요청을 받는다(새 실행)
    expect(await session.gateway.prompt({ prompt: '다시' })).toMatchObject({ note: expect.stringContaining('되돌렸습니다') });
    expect(getSnapshot(session.id)!.running).toBe(true);
  }, 30_000);

  it('오류 종류를 알 수 없으면(필드가 없거나 문자열이 아니거나 비었거나 길다) 모르는 오류로 적고 그래도 닫는다', async () => {
    for (const [index, error] of [undefined, 42, { kind: 'rate_limit' }, '', '   ', 'x'.repeat(500)].entries()) {
      const session = await open();
      await openRunWithEdit(session);
      await stopFailure(session, failure(error));
      const [finished] = await finishedRuns(session, 1);
      expect(finished, String(index)).toMatchObject({ status: 'failed' });
      if (index === 5) {
        expect(finished!.summary).not.toContain('x'.repeat(100));
        expect(finished!.summary).toContain('API 오류(알 수 없는 오류)');
      } else {
        expect(finished!.summary).toContain('API 오류(알 수 없는 오류)로 턴이 끝나 요청을 닫았습니다');
      }
      expect(await fileOf(session)).toBe(ORIGINAL);
      expect(openTerminalRunId(session.id)).toBeUndefined();
    }
  }, 60_000);

  it('열린 실행이 없으면 아무것도 하지 않는다(닫힌 일도, 되돌림도, 사람 기다림 표시도 없다)', async () => {
    const session = await open();
    await stopFailure(session, failure('rate_limit'));
    await sleep(50);
    expect(session.ofType('run_finished')).toEqual([]);
    expect(session.ofType('reverted')).toEqual([]);
    expect(session.ofType('terminal_attention')).toEqual([]);
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 이미 닫은 실행에 두 번 와도 같다
    await openRunWithEdit(session);
    await stopFailure(session, failure('rate_limit'));
    await finishedRuns(session, 1);
    await stopFailure(session, failure('rate_limit'));
    await sleep(50);
    expect(session.ofType('run_finished')).toHaveLength(1);
  }, 30_000);

  it('검사가 도는 중이면 미룬다: 검사가 재시도로 끝나면 피드백 대신 실패로 닫고 되돌리며 점유를 푼다', async () => {
    const session = await open();
    await openRunWithEdit(session);
    let release = (): void => {};
    fake.holdWord = 'test';
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    fake.failCommands = ['test'];
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await until('검사 시작', () => fake.execCalls.some((command) => command.includes('test')));

    await stopFailure(session, failure('overloaded'));
    // 미뤘다: 검사가 닫을 것이라 이 훅은 닫지 않는다
    expect(session.ofType('run_finished')).toEqual([]);
    release();
    const answer = await stopping;
    expect(answer.feedback).toBeUndefined();
    expect(openTerminalRunId(session.id)).toBeUndefined();
    expect(getSnapshot(session.id)!.running).toBe(false);
    const finished = await finishedRuns(session, 1);
    expect(finished[0]).toMatchObject({ status: 'failed' });
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);

  it('앞선 피드백이 있으면 사유에 함께 적는다. 닫은 뒤 새 실행에는 그 피드백이 남지 않는다', async () => {
    const session = await open();
    await openRunWithEdit(session);
    fake.failCommands = ['test'];
    const first = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(first.feedback).toContain('OrderTest');
    expect(openTerminalRunId(session.id)).toBeDefined();

    await stopFailure(session, failure('rate_limit'));
    const [finished] = await finishedRuns(session, 1);
    expect(finished).toMatchObject({ status: 'failed' });
    expect(finished!.summary).toContain('API 오류(rate_limit)로 턴이 끝나 요청을 닫았습니다');
    expect(finished!.summary).toContain('OrderTest');

    // 새 실행은 피드백 없이 시작한다
    fake.failCommands = [];
    await openRunWithEdit(session, '둘째 요청');
    await stopFailure(session, failure('rate_limit'));
    const second = (await finishedRuns(session, 2))[1]!;
    expect(second.summary).toContain('API 오류(rate_limit)');
    expect(second.summary).not.toContain('OrderTest');
  }, 30_000);

  it('CLI가 나중에 같은 턴을 이어 가면(자동 재개) 그때 오는 도구 훅이 새 실행을 연다. 닫은 실행에는 붙지 않는다', async () => {
    const session = await open();
    await openRunWithEdit(session);
    const closed = openTerminalRunId(session.id)!;
    await stopFailure(session, failure('rate_limit'));
    await finishedRuns(session, 1);
    expect(openTerminalRunId(session.id)).toBeUndefined();

    // 이어 가는 턴의 첫 쓰기 도구
    expect(await session.gateway.preTool(WRITE)).toEqual({});
    const reopened = openTerminalRunId(session.id);
    expect(reopened).toBeDefined();
    expect(reopened).not.toBe(closed);
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('검증 통과');
  }, 30_000);

  it('멈춘 세션이면 다른 훅과 같이 거절한다(409). 아무것도 닫지 않는다', async () => {
    const session = await open();
    await openRunWithEdit(session);
    await stopSession(session.id);
    await expect(stopFailure(session, failure('rate_limit'))).rejects.toMatchObject({ status: 409 });
  }, 30_000);

  it('사람 기다림 표시(terminal_attention)를 만들지 않는다: 닫힌 실행의 실패 결과가 신호다', async () => {
    const session = await open();
    await openRunWithEdit(session);
    await stopFailure(session, failure('rate_limit'));
    await finishedRuns(session, 1);
    expect(session.ofType('terminal_attention')).toEqual([]);
    expect(getSnapshot(session.id)!.terminalAttention).toBeUndefined();
  }, 30_000);
});
