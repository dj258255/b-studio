import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 세션 터미널의 턴 끝(Stop 훅) 판정(ADR-212, 4f B4c)을 실제 sessions.ts로 본다. 가짜는 샌드박스(Docker)와 세션 터미널(컨테이너의 CLI)뿐이다.
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
    id: 'studio-termtelin-fake',
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

import { createSession, getSnapshot, sessionTerminalTarget, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: termtelin
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termtelin-session-'));
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
  const id = (await createSession('termtelin', 'kim', workspace, lazy ? { boot: 'on-demand' as const } : {})).id;
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



const CHANGED = 'class Order { String memo; }\n';
const WRITE = { tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: CHANGED } };

/**
 * 세션 터미널의 사용량 귀속·중복 제거·정체 판정(ADR-213, 4f B4d)을 실제 sessions.ts로 본다. 가짜는 샌드박스와 세션 터미널뿐이고,
 * CLI가 보내는 텔레메트리(OTLP 로그)와 훅은 테스트가 직접 보낸다. 사용량 폴더는 시험마다 임시 폴더다.
 */
const otlp = (records: Array<Record<string, unknown>>): unknown => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
/** 모델 요청 하나(api_request). 토큰은 input + 1(출력)이다 */
const rec = (id: string | undefined, { at = Date.now(), input = 10 }: { at?: number; input?: number } = {}): Record<string, unknown> => ({
  timeUnixNano: String(BigInt(Math.round(at)) * 1_000_000n),
  attributes: [
    { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
    { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
    { key: 'input_tokens', value: { intValue: String(input) } },
    { key: 'output_tokens', value: { intValue: '1' } },
    { key: 'cache_read_tokens', value: { intValue: '0' } },
    { key: 'cache_creation_tokens', value: { intValue: '0' } },
    ...(id !== undefined ? [{ key: 'request_id', value: { stringValue: id } }] : []),
  ],
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.B_STUDIO_USER_TOKEN_LIMIT;
  delete process.env.B_STUDIO_TERMINAL_STALL_SECONDS;
});

/** 속성 하나를 뺀 모델 요청 */
function recWithout(id: string, key: string, over: { at?: number } = {}): Record<string, unknown> {
  const base = rec(id, over);
  return { ...base, attributes: (base.attributes as Array<{ key: string }>).filter((entry) => entry.key !== key) };
}

/** 속성 하나의 값을 바꾼 모델 요청 */
function recWith(id: string, key: string, value: unknown, over: { at?: number } = {}): Record<string, unknown> {
  const base = rec(id, over);
  return { ...base, attributes: [...(base.attributes as Array<{ key: string }>).filter((entry) => entry.key !== key), { key, value }] };
}

/** 쓰기 훅을 count번 보낸다. 거절이 나오면 그 글을 돌려준다 */
async function writes(session: Opened, count: number): Promise<string | undefined> {
  for (let i = 0; i < count; i += 1) {
    const answer = await session.gateway.preTool(WRITE);
    if (answer.deny) return answer.deny;
  }
  return undefined;
}

describe('N5: 앞 실행의 늦은 사용량은 새 실행의 사용량 소식 표시를 세우지 않는다', () => {
  /** 실행 A를 열고(A의 시각을 받아 두고) 닫은 뒤 새 실행 B를 연다. 돌려주는 값은 A 안의 시각이다 */
  async function closeAThenOpenB(session: Opened): Promise<number> {
    await session.gateway.prompt({ prompt: '[읽기만] 설명해줘' });
    const aAt = Date.now();
    await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    return aAt;
  }

  it('A가 닫히고 B가 열린 뒤 A의 시각을 단 요청이 늦게 와도, B의 텔레메트리가 끊기면 쓰기를 막는다', async () => {
    const session = await open();
    const aAt = await closeAThenOpenB(session);
    // 늦게 온 A의 사용량(닫힌 실행 A의 몫이다)
    await session.gateway.telemetry(otlp([rec('late-a', { at: aAt })]));
    // 그 뒤 B에는 사용량이 한 번도 오지 않는다
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    expect(await writes(session, 12)).toContain('사용량');
  }, 30_000);

  it('B에 실제로 붙은 요청이 오면 B의 표시는 선다(정상 세션은 막지 않는다)', async () => {
    const session = await open();
    const aAt = await closeAThenOpenB(session);
    await session.gateway.telemetry(otlp([rec('late-a', { at: aAt }), rec('b-1')]));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    expect(await writes(session, 12)).toBeUndefined();
  }, 30_000);

  it('늦은 사용량은 세션 단위 끊김 표시를 풀지만(소식이 흐른다는 증거), 새 실행의 끊김 판정은 그 실행이 받은 것으로만 한다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    expect(await writes(session, 12)).toContain('사용량');
    // 앞 실행(B)이 끊김으로 막혀 있던 동안의 시각. 이 실행의 요청이 늦게 온다
    const lateAt = Date.now() - 1_000;
    await session.gateway.stop({ last_assistant_message: '막혔습니다.' });
    await session.gateway.prompt({ prompt: '다시 해 줘' });
    // 끊김 표시가 이어진다: 소식이 오기 전 첫 쓰기부터 막는다
    expect(await writes(session, 1)).toContain('사용량');
    // B의 늦은 사용량이 오면 세션 표시는 풀린다. 그러나 이 실행(C)은 받은 것이 없어 여유(쓰기 10번·30초)를 다시 센다
    await session.gateway.telemetry(otlp([rec('late-b', { at: lateAt })]));
    expect(await writes(session, 1)).toBeUndefined();
    // 소식이 더 없으면 C도 다시 막힌다
    vi.setSystemTime(Date.now() + 40_000);
    expect(await writes(session, 12)).toContain('사용량');
  }, 30_000);
});

describe('N6a: 모양이 틀린 api_request도 모델 호출 하나로 센다', () => {
  it('필수 속성(cache_creation_tokens)이 빠진 요청도 턴으로 센다: 턴 상한 1이면 다음 쓰기가 막힌다', async () => {
    const session = await open({ maxTurns: 1 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([recWithout('r1', 'cache_creation_tokens')]));
    expect((await session.gateway.preTool(WRITE)).deny).toContain('턴 상한');
  }, 30_000);

  it('값이 음수인 요청도 턴으로 센다', async () => {
    const session = await open({ maxTurns: 1 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([recWith('r1', 'output_tokens', { intValue: '-4' })]));
    expect((await session.gateway.preTool(WRITE)).deny).toContain('턴 상한');
  }, 30_000);

  it('모델 이름이 빠진 요청도 턴으로 센다(읽을 수 있는 토큰은 세션 합계에 더한다)', async () => {
    const session = await open({ maxTurns: 1 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([recWithout('r1', 'model')]));
    expect((await session.gateway.preTool(WRITE)).deny).toContain('턴 상한');
    expect(getSnapshot(session.id)!.tokens!.inputTokens).toBe(10);
  }, 30_000);

  it('토큰을 읽지 못한 요청이 있으면 토큰 한도가 있는 세션은 쓰기를 막는다(확인할 수 없음)', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '100000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([recWithout('r1', 'cache_creation_tokens')]));
    expect(await writes(session, 1)).toContain('읽지 못해');
    // 읽은 토큰은 더해졌다(내려잡은 값)
    expect(getSnapshot(session.id)!.tokens!.inputTokens).toBe(10);
  }, 30_000);

  it('토큰 한도가 없으면 읽지 못한 요청이 있어도 턴만 센다(쓰기를 막지 않는다)', async () => {
    const session = await open({ maxTurns: 100 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([recWithout('r1', 'cache_creation_tokens')]));
    expect(await writes(session, 3)).toBeUndefined();
  }, 30_000);

  it('읽지 못한 요청의 표시는 그 실행에서만 선다(다음 실행에 남지 않는다)', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '100000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([recWithout('r1', 'cache_creation_tokens')]));
    expect(await writes(session, 1)).toContain('읽지 못해');
    await session.gateway.stop({ last_assistant_message: '막혔습니다.' });
    await session.gateway.prompt({ prompt: '다시 해 줘' });
    expect(await writes(session, 1)).toBeUndefined();
  }, 30_000);

  it('본문의 모양이 깨져 모델 호출이 있었는지 알 수 없으면 토큰 한도가 있는 세션은 쓰기를 막는다', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '100000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry({ resourceLogs: [{ scopeLogs: [{ logRecords: 'x' }] }] });
    expect(await writes(session, 1)).toContain('읽지 못해');
  }, 30_000);

  it('같은 묶음을 다시 받아도 읽지 못한 요청은 두 번 세지 않는다(요청 번호 중복 제거)', async () => {
    const session = await open({ maxTurns: 2 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([recWithout('r1', 'cache_creation_tokens')]));
    await session.gateway.telemetry(otlp([recWithout('r1', 'cache_creation_tokens')]));
    expect(await writes(session, 1)).toBeUndefined();
  }, 30_000);
});

describe('N6b: CLI가 준 시각이 엉뚱해도 실행 중에 온 요청은 턴에서 빠지지 않는다', () => {
  for (const [name, at] of [
    ['한 시간 전', () => Date.now() - 3_600_000],
    ['한 시간 뒤', () => Date.now() + 3_600_000],
    ['1970년', () => 1_000],
  ] as const) {
    it(`요청 시각이 ${name}이어도 받은 시각으로 열린 실행에 붙어 턴으로 센다`, async () => {
      const session = await open({ maxTurns: 1 });
      await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
      await session.gateway.telemetry(otlp([rec('r1', { at: at() })]));
      expect((await session.gateway.preTool(WRITE)).deny).toContain('턴 상한');
    }, 30_000);
  }

  it('시각이 읽을 수 없는 글이거나 너무 커도 센다', async () => {
    const session = await open({ maxTurns: 1 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const huge = { ...rec('r1'), timeUnixNano: '9'.repeat(60) };
    await session.gateway.telemetry(otlp([huge]));
    expect((await session.gateway.preTool(WRITE)).deny).toContain('턴 상한');
  }, 30_000);

  it('앞 실행 안의 시각을 단 늦은 요청은 새 실행의 턴으로 세지 않는다(시각을 받은 시각으로 바꾸는 것은 엉뚱한 시각만이다)', async () => {
    const session = await open({ maxTurns: 1 });
    await session.gateway.prompt({ prompt: '[읽기만] 설명해줘' });
    const aAt = Date.now();
    await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('late-a', { at: aAt })]));
    expect(await session.gateway.preTool(WRITE)).toEqual({});
  }, 30_000);
});

describe('N4: 턴 상한 전이', () => {
  it('턴 상한이 없으면 호출이 아무리 많아도 턴을 보지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp(Array.from({ length: 120 }, (_, i) => rec(`r${i}`))));
    expect(await session.gateway.preTool(WRITE)).toEqual({});
  }, 30_000);

  it('턴 상한에 닿으면 풀리지 않는다: 이어 오는 요청이 없어도 쓰기는 계속 막힌다', async () => {
    const session = await open({ maxTurns: 2 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1')]));
    expect(await session.gateway.preTool(WRITE)).toEqual({});
    await session.gateway.telemetry(otlp([rec('r2')]));
    for (let i = 0; i < 3; i += 1) expect((await session.gateway.preTool(WRITE)).deny).toContain('턴 상한');
  }, 30_000);

  it('토큰 한도로 멈춘 실행(budget)은 턴을 더 세도 사유가 턴 상한으로 바뀌지 않는다', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '20';
    const session = await open({ maxTurns: 2 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1', { input: 30 })]));
    expect(session.ofType('run_cancelling')).toMatchObject([{ reason: 'budget' }]);
    await session.gateway.telemetry(otlp([rec('r2'), rec('r3')]));
    const deny = (await session.gateway.preTool(WRITE)).deny;
    expect(deny).not.toContain('턴 상한');
  }, 30_000);
});
