import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 세션 터미널 실행의 닫기(ADR-210, 4f B4a)를 실제 sessions.ts로 본다. 가짜는 샌드박스(Docker)와 세션 터미널(컨테이너의 CLI)뿐이다.
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
    id: 'studio-termclose-fake',
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

import { cancelRun, createSession, getSnapshot, openTerminalRunId, sessionTerminalTarget, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: termclose
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termclose-session-'));
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
  const id = (await createSession('termclose', 'kim', 'copy', lazy ? { boot: 'on-demand' as const } : {})).id;
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
const VIOLATION = '관문 파일이 바뀌어 되돌렸습니다: settings.json';
const WRITE = { tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: 'class Order { String memo; }\n' } };

/** 어느 쪽이 먼저 오는가: 약속이 `ms` 안에 끝나지 않으면 'pending' */
async function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([work, sleep(ms).then(() => 'pending' as const)]);
}

describe('닫기는 그 실행의 중단 신호를 끊는다: 샌드박스를 켜는 동안 기다리던 훅은 닫힌 뒤 허용하지 않는다 (결함 1)', () => {
  it('쓰기 직전 훅이 샌드박스 준비를 기다리는 동안 위반으로 실행이 닫히면, 훅은 거절로 답한다(허용 {}가 아니다)', async () => {
    const session = await open({ lazy: true });
    let release = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (release = resolve));
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const waiting = session.gateway.preTool(WRITE);
    await until('샌드박스 켜기 시작', () => fake.starts === 1);

    sessionTerminalTarget(session.id).onViolation(VIOLATION);
    const [finished] = await finishedRuns(session, 1);
    expect(finished.status).toBe('failed');
    expect(getSnapshot(session.id)!.running).toBe(false);

    // 켜기는 아직 끝나지 않았다. 닫기가 중단 신호를 끊었으면 기다리던 훅은 켜기를 기다리지 않고 거절로 돌아온다
    const answer = await settledWithin(waiting, 300);
    release();
    expect(answer).toMatchObject({ deny: expect.stringContaining('요청을 닫아 도구를 쓰지 않았습니다') });
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);

  it('MCP 도구도 같다: 닫힌 실행의 도구는 샌드박스가 켜진 뒤에도 실행되지 않는다', async () => {
    const session = await open({ lazy: true });
    let release = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (release = resolve));
    await session.gateway.prompt({ prompt: '주문 목록을 확인' });
    const waiting = session.gateway.runTool('run_in_service', { service: 'api', command: ['ls'] });
    await until('샌드박스 켜기 시작', () => fake.starts === 1);

    sessionTerminalTarget(session.id).onViolation(VIOLATION);
    await finishedRuns(session, 1);

    const answer = await settledWithin(waiting, 300);
    release();
    expect(answer).toMatchObject({ ok: false });
    // 켜기가 끝난 뒤에도 도구는 돌지 않았다
    await sleep(100);
    expect(fake.execCalls).toEqual([]);
  }, 30_000);

  it('줄을 서는 사이 실행이 닫혀도 같다: 앞선 턴 끝이 통과로 닫은 실행의 도구는 줄 끝에서 돌지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.preTool(WRITE);
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    // 턴 끝 검사가 도는 중이다
    let release = (): void => {};
    fake.holdWord = 'test';
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await until('검사 시작', () => fake.execCalls.some((command) => command.includes('test')));
    // 그 사이 도구가 온다. 기준은 이미 잡혀 있어 줄에서 턴 끝 검사 뒤에 선다
    const tool = session.gateway.runTool('run_in_service', { service: 'api', command: ['ls'] });
    await sleep(50);
    release();
    expect((await stopping).message).toContain('검증 통과');
    expect(await tool).toMatchObject({ ok: false, content: expect.stringContaining('요청을 닫아 도구를 쓰지 않았습니다') });
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
  }, 30_000);

  it('위반·통과·CLI 종료로 닫는 것은 CLI에 Esc를 보내지 않고 점유를 취소 중으로 바꾸지 않는다. 화면의 취소는 Esc를 한 번 보내고 한 번만 닫는다', async () => {
    // 위반으로 닫는다
    const violated = await open();
    await violated.gateway.prompt({ prompt: '첫 요청' });
    await violated.gateway.preTool(WRITE);
    await edit(violated, 'api/src/Order.java', 'class Order { String memo; }\n');
    sessionTerminalTarget(violated.id).onViolation(VIOLATION);
    await finishedRuns(violated, 1);
    expect(violated.ofType('run_cancelling')).toEqual([]);
    expect(getSnapshot(violated.id)!.cancelling).toBeUndefined();
    expect(fake.interrupts).toEqual([]);

    // 통과로 닫는다
    await violated.gateway.prompt({ prompt: '둘째 요청' });
    await violated.gateway.preTool(WRITE);
    await edit(violated, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await violated.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과');
    expect(violated.ofType('run_cancelling')).toEqual([]);
    expect(fake.interrupts).toEqual([]);

    // CLI 종료로 닫는다
    await violated.gateway.prompt({ prompt: '셋째 요청' });
    await violated.gateway.preTool(WRITE);
    await violated.gateway.sessionEnd({});
    expect(violated.ofType('run_finished')).toHaveLength(3);
    expect(violated.ofType('run_cancelling')).toEqual([]);
    expect(fake.interrupts).toEqual([]);

    // 화면의 취소: Esc는 한 번, 닫기는 한 번
    await violated.gateway.prompt({ prompt: '넷째 요청' });
    await violated.gateway.preTool(WRITE);
    await edit(violated, 'api/src/Order.java', 'class Order { String memo; }\n');
    const runId = openTerminalRunId(violated.id)!;
    expect(runId).toBeDefined();
    cancelRun(violated.id, runId);
    await finishedRuns(violated, 4);
    expect(violated.ofType('run_cancelling')).toHaveLength(1);
    expect(fake.interrupts).toEqual([violated.id]);
    await sleep(100);
    expect(violated.ofType('run_finished')).toHaveLength(4);
    expect(violated.ofType('reverted').filter((event) => event.runId === runId)).toHaveLength(1);
    expect(getSnapshot(violated.id)!.running).toBe(false);
  }, 60_000);
});

describe('CLI가 검사 중에 끝나고 그 검사가 재시도로 끝나면 실행을 닫는다 (의심 2)', () => {
  it('Stop 검사가 도는 중에 SessionEnd가 오고 검사가 피드백으로 끝나면, 받을 CLI가 없으므로 실패로 닫고 점유를 푼다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.preTool(WRITE);
    await edit(session, 'api/src/Order.java', 'class Order { String memo }\n');

    // 선언한 테스트가 끝나지 않고 멈춰 있다(검사가 도는 중). 풀리면 실패로 끝난다
    let release = (): void => {};
    fake.holdWord = 'test';
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    fake.failCommands = ['test'];
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await until('검사 시작', () => fake.execCalls.some((command) => command.includes('test')));

    // 검사 중에 CLI가 끝난다. 검사가 닫을 것이라 이 알림은 아무것도 닫지 않는다
    await session.gateway.sessionEnd({ reason: 'other' });
    expect(session.ofType('run_finished')).toEqual([]);
    release();
    const answer = await stopping;

    // 검사가 재시도(피드백)로 끝났지만 받을 CLI가 없다. 열린 채 두지 않고 실패로 닫는다
    expect(answer.feedback).toBeUndefined();
    expect(openTerminalRunId(session.id)).toBeUndefined();
    expect(getSnapshot(session.id)!.running).toBe(false);
    const finished = await finishedRuns(session, 1);
    expect(finished[0]).toMatchObject({ status: 'failed' });
    expect(finished[0]!.summary).toContain('검증을 통과하지 못한 채 CLI가 끝났습니다');
    expect(await fileOf(session)).toBe(ORIGINAL);
    // 점유가 풀려 다음 요청을 받는다
    expect(await session.gateway.prompt({ prompt: '다시' })).toMatchObject({ note: expect.stringContaining('되돌렸습니다') });
    expect(getSnapshot(session.id)!.running).toBe(true);
  }, 30_000);
});

describe('닫는 도중 던져도 점유는 풀린다 (의심 3)', () => {
  it('플랫폼 실패로 닫는 알림을 받는 쪽이 던져도 실행은 닫히고 점유는 풀린다', async () => {
    const session = await open({ lazy: true });
    // 알림(notice)을 받는 쪽(구독자)이 던진다. 닫기가 이 알림을 내는 도중이다
    subscribe(session.id, (event) => {
      if (event.type === 'notice' && event.text.includes('b-studio 쪽(샌드박스·도커) 문제')) throw new Error('구독자가 던졌습니다');
    });
    fake.startFails = true;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.stop({ last_assistant_message: '추가했습니다.' }).catch(() => {});

    expect(openTerminalRunId(session.id)).toBeUndefined();
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 다음 요청을 받는다(점유가 남아 있으면 앞선 요청을 처리하는 중이라고 거절한다)
    fake.startFails = false;
    expect(await session.gateway.prompt({ prompt: '다시' })).toEqual({});
    expect(getSnapshot(session.id)!.running).toBe(true);
  }, 30_000);
});

describe('열린 실행이 없을 때 온 위반은 판정을 낸 실행만 가져간다 (의심 4: 의도한 동작을 고정한다)', () => {
  it('미뤄 둔 위반이 있을 때 다음 실행이 취소나 CLI 종료로 닫혀도 위반은 소비되지 않고, 그 뒤 처음 판정을 내는 실행의 것이 된다', async () => {
    const session = await open();
    sessionTerminalTarget(session.id).onViolation('검증이 붙지 않은 CLI가 터미널에서 돌고 있습니다(pid 4321)');

    // 취소로 닫히는 실행: 판정(게이트·턴의 끝)을 내지 않으므로 위반을 가져가지 않는다
    await session.gateway.prompt({ prompt: '첫 요청' });
    await session.gateway.preTool(WRITE);
    cancelRun(session.id, openTerminalRunId(session.id)!);
    await finishedRuns(session, 1);
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'cancelled' });

    // CLI 종료로 닫히는 실행도 같다
    await session.gateway.prompt({ prompt: '둘째 요청' });
    await session.gateway.preTool(WRITE);
    await session.gateway.sessionEnd({});
    expect(session.ofType('run_finished')[1]).toMatchObject({ status: 'cancelled' });

    // 그 뒤 처음 턴의 끝을 맞는 실행이 위반으로 닫힌다
    await session.gateway.prompt({ prompt: '셋째 요청' });
    await session.gateway.preTool(WRITE);
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('검증을 우회할 수 있는 일이 감지되어');
    expect(answer.message).toContain('pid 4321');
    expect(session.ofType('run_finished')[2]).toMatchObject({ status: 'failed' });

    // 소비되었다: 그다음 실행은 평소대로 통과한다
    await session.gateway.prompt({ prompt: '넷째 요청' });
    await session.gateway.preTool(WRITE);
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과');
  }, 60_000);
});
