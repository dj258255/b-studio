import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 세션 터미널의 요청 시작·쓰기 직전·MCP 판정(ADR-211, 4f B4b)을 실제 sessions.ts로 본다. 가짜는 샌드박스(Docker)와 세션 터미널(컨테이너의 CLI)뿐이다.
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
  /** 세션 터미널 방식. 'host'(이 컴퓨터 방식)면 작업 복사본의 Git을 더 의심한다(이슈 #706) */
  terminalMode: 'container' as 'container' | 'host',
  /** 시험이 studio.yaml에 쓸 턴 상한 */
  maxTurns: undefined as number | undefined,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-termprompt-fake',
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
  sessionTerminalMode: () => fake.terminalMode,
  warnSessionTerminal: () => {},
  terminalPause: () => undefined,
}));

import { createSession, getSnapshot, openTerminalRunId, sessionTerminalTarget, setTerminalCheckChanges, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: termprompt
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termprompt-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), STUDIO_YAML);
  fake.maxTurns = undefined;
  fake.terminalMode = 'container';
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

async function open({ lazy = false, workspace = 'copy', maxTurns }: { lazy?: boolean; workspace?: 'copy' | 'local'; maxTurns?: number } = {}): Promise<Opened> {
  if (maxTurns !== undefined) await writeFile(path.join(fake.root, 'studio.yaml'), `${STUDIO_YAML}  maxTurns: ${maxTurns}\n`);
  const id = (await createSession('termprompt', 'kim', workspace, lazy ? { boot: 'on-demand' as const } : {})).id;
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

const edit = (session: Opened, file: string, content: string) => writeFile(path.join(session.work, file), content);
const WRITE = { tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: 'class Order { String memo; }\n' } };

/** 어느 쪽이 먼저 오는가: 약속이 `ms` 안에 끝나지 않으면 'pending' */
async function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([work, sleep(ms).then(() => 'pending' as const)]);
}


/** 세션 저장소(전역). 시험이 실행·점유를 직접 붙잡는 자리다 */
const sessionOf = (id: string) => (globalThis as unknown as { __bStudio: { sessions: Map<string, { life: { claims: { beginRun(runId: string): number | { busy: string }; release(ticket: number): boolean } }; relaying: Promise<void> }> } }).__bStudio.sessions.get(id)!;

const otlp = (records: Array<Record<string, unknown>>): unknown => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
const modelCall = (requestId: string): Record<string, unknown> => ({
  timeUnixNano: String(Date.now() * 1_000_000),
  attributes: [
    { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
    { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
    { key: 'input_tokens', value: { intValue: '10' } },
    { key: 'output_tokens', value: { intValue: '1' } },
    { key: 'cache_read_tokens', value: { intValue: '0' } },
    { key: 'cache_creation_tokens', value: { intValue: '0' } },
    { key: 'request_id', value: { stringValue: requestId } },
  ],
});

describe('P1: 샌드박스 켜기를 기다리는 사이 바뀐 사실을 켜기가 끝난 뒤 다시 본다', () => {
  it('쓰기 직전 훅: 기다리는 사이 [읽기만] 요청이 이어 오면 켜기가 끝난 뒤 거절한다', async () => {
    const session = await open({ lazy: true });
    let release = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (release = resolve));
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const waiting = session.gateway.preTool(WRITE);
    await until('샌드박스 켜기 시작', () => fake.starts === 1);
    expect(await session.gateway.prompt({ prompt: '[읽기만] 주문 구조를 설명해줘' })).toMatchObject({ note: expect.stringContaining('읽기만') });
    release();
    expect(await waiting).toMatchObject({ deny: expect.stringContaining('읽기만 요청') });
  }, 30_000);

  it('쓰기 직전 훅: 기다리는 사이 턴 상한에 닿으면 켜기가 끝난 뒤 거절한다', async () => {
    const session = await open({ lazy: true, maxTurns: 1 });
    let release = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (release = resolve));
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const waiting = session.gateway.preTool(WRITE);
    await until('샌드박스 켜기 시작', () => fake.starts === 1);
    await session.gateway.telemetry(otlp([modelCall('turn-1')]));
    release();
    expect(await waiting).toMatchObject({ deny: expect.stringContaining('턴 상한(1)에 닿았습니다') });
  }, 30_000);

  it('MCP 도구: 기다리는 사이 [읽기만] 요청이 이어 오면 도구를 돌리지 않는다', async () => {
    const session = await open({ lazy: true });
    let release = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (release = resolve));
    await session.gateway.prompt({ prompt: '주문 목록을 확인' });
    const waiting = session.gateway.runTool('run_in_service', { service: 'api', command: ['ls'] });
    await until('샌드박스 켜기 시작', () => fake.starts === 1);
    await session.gateway.prompt({ prompt: '[읽기만] 주문 구조를 설명해줘' });
    release();
    expect(await waiting).toMatchObject({ ok: false, content: expect.stringContaining('읽기만 요청') });
    await sleep(100);
    expect(fake.execCalls).toEqual([]);
  }, 30_000);

  it('MCP 도구: 기다리는 사이 턴 상한에 닿으면 도구를 돌리지 않는다', async () => {
    const session = await open({ lazy: true, maxTurns: 1 });
    let release = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (release = resolve));
    await session.gateway.prompt({ prompt: '주문 목록을 확인' });
    const waiting = session.gateway.runTool('run_in_service', { service: 'api', command: ['ls'] });
    await until('샌드박스 켜기 시작', () => fake.starts === 1);
    await session.gateway.telemetry(otlp([modelCall('turn-1')]));
    release();
    expect(await waiting).toMatchObject({ ok: false, content: expect.stringContaining('턴 상한(1)에 닿았습니다') });
    await sleep(100);
    expect(fake.execCalls).toEqual([]);
  }, 30_000);

  it('기다리는 사이 아무것도 바뀌지 않으면 켜기가 끝난 뒤 허용한다(회귀 방지)', async () => {
    const session = await open({ lazy: true });
    let release = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (release = resolve));
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const waiting = session.gateway.preTool(WRITE);
    await until('샌드박스 켜기 시작', () => fake.starts === 1);
    release();
    expect(await waiting).toEqual({});
  }, 30_000);
});

describe('P2: 점유를 먼저 잡고 준비한다(내 폴더 세션)', () => {
  it('준비(스튜디오 밖 수정 저장)를 기다리는 사이 다른 실행은 점유를 잡지 못한다: 사람의 수정은 이 요청의 점유 아래에서만 체크포인트가 된다', async () => {
    fake.terminalMode = 'host';
    const session = await open({ workspace: 'local' });
    const before = getSnapshot(session.id)!.checkpoints.length;
    // 사람이 폴더의 파일을 고쳐 두었다. 요청 시작은 이것을 "직접 수정" 체크포인트로 남긴 뒤 시작한다
    await edit(session, 'api/src/Order.java', 'class Order { String human; }\n');
    // 준비의 첫 기다림을 붙잡는다
    let release = (): void => {};
    sessionOf(session.id).relaying = new Promise<void>((resolve) => (release = resolve));
    const waiting = session.gateway.prompt({ prompt: '주문 설명을 고쳐줘' });
    await sleep(50);
    // 그 사이 대화 창의 요청 같은 다른 실행이 점유를 잡으려 한다. 옛 코드는 점유가 비어 있어 잡혔고, 준비가 끝난 뒤 이 요청이 바쁨으로 거절됐다
    // (그 사이에 사람의 수정이 남의 실행 도중에 커밋됐다). 이제는 점유가 이미 이 요청의 것이라 다른 실행이 거절된다
    expect(() => sessionOf(session.id).life.claims.beginRun('chat-run')).toThrow();
    release();
    expect(await waiting).toEqual({});
    // 이 요청이 점유한 채 수정을 저장했고 그 실행이 열렸다
    expect(session.ofType('local_edits_saved')).toHaveLength(1);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(openTerminalRunId(session.id)).toBeDefined();
  }, 30_000);

  it('점유를 잡은 채 준비하는 동안 온 다른 훅은 바쁨으로 거절되고, 준비가 끝나면 그 실행이 열린다', async () => {
    fake.terminalMode = 'host';
    const session = await open({ workspace: 'local' });
    let release = (): void => {};
    sessionOf(session.id).relaying = new Promise<void>((resolve) => (release = resolve));
    const first = session.gateway.prompt({ prompt: '주문 설명을 고쳐줘' });
    await sleep(50);
    // 준비 중이다. 다른 요청은 이 실행에 이어 붙지 않고 바쁨이다. 같은 준비를 기다리지도 않는다
    const second = await settledWithin(session.gateway.prompt({ prompt: '둘째 요청' }), 1_000);
    const tool = await settledWithin(session.gateway.preTool(WRITE), 1_000);
    release();
    expect(second).toMatchObject({ blocked: expect.any(String) });
    expect(tool).toMatchObject({ deny: expect.any(String) });
    expect(await first).toEqual({});
    expect(openTerminalRunId(session.id)).toBeDefined();
    expect(session.ofType('run_started')).toHaveLength(1);
  }, 30_000);

  it('준비가 실패하면 점유를 풀고 지금과 같은 글로 거절한다', async () => {
    fake.terminalMode = 'host';
    const session = await open({ workspace: 'local' });
    let fail: (error: Error) => void = () => {};
    sessionOf(session.id).relaying = new Promise<void>((_resolve, reject) => (fail = reject));
    const waiting = session.gateway.prompt({ prompt: '주문 설명을 고쳐줘' });
    await sleep(50);
    fail(new Error('알리지 못했습니다'));
    const failed = await waiting;
    expect(failed.blocked).toContain('체크포인트로 남기지 못해 요청을 시작하지 않았습니다');
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 점유가 풀려 다음 요청을 받는다
    sessionOf(session.id).relaying = Promise.resolve();
    expect((await session.gateway.prompt({ prompt: '다시' })).blocked).toBeUndefined();
    expect(openTerminalRunId(session.id)).toBeDefined();
  }, 30_000);
});

describe('P3: 확인 선언 변경 허용은 사람의 요청이 연 실행만 가져간다', () => {
  it('요청 훅 없이 쓰기 직전 훅이 연 실행은 허용을 가져가지 않는다', async () => {
    const session = await open();
    expect(setTerminalCheckChanges(session.id, true)).toBe(true);
    expect(await session.gateway.preTool(WRITE)).toEqual({});
    expect(openTerminalRunId(session.id)).toBeDefined();
    // 도구 호출이 연 실행이다. 사람이 다음 요청에 준 허용은 그대로 남아 있다
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBe(true);
  }, 30_000);

  it('그다음 사람의 요청이 연 실행은 허용을 가져가고 CLI에 알린다', async () => {
    const session = await open();
    setTerminalCheckChanges(session.id, true);
    await session.gateway.preTool(WRITE);
    await session.gateway.sessionEnd({});
    expect(openTerminalRunId(session.id)).toBeUndefined();
    const answer = await session.gateway.prompt({ prompt: '확인 선언을 고쳐줘' });
    expect(answer.note).toContain('확인 선언 변경 허용');
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBeUndefined();
  }, 30_000);

  it('요청이 읽기만이면 허용을 남겨 둔다(기존 동작)', async () => {
    const session = await open();
    setTerminalCheckChanges(session.id, true);
    await session.gateway.prompt({ prompt: '[읽기만] 설명해줘' });
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBe(true);
  }, 30_000);
});
