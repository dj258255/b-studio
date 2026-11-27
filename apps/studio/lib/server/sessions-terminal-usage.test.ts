import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userTokens } from './usage-state';
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
  /** 세션 터미널에 쓴 바이트의 기록과 CLI가 떠 있는가(정체 재촉 시험) */
  writes: [] as string[],
  cliAlive: true as boolean,
  writeFails: false as boolean,
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
    id: 'studio-termusage-fake',
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
  sessionTerminalCliAlive: () => fake.cliAlive,
  writeSessionTerminal: (_sessionId: string, data: string) => {
    if (fake.writeFails) throw new Error('터미널이 열려 있지 않습니다');
    fake.writes.push(data);
  },
  terminalPause: () => undefined,
}));

import { createSession, getSnapshot, sessionTerminalTarget, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: termusage
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termusage-session-'));
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
  fake.writes = [];
  fake.cliAlive = true;
  fake.writeFails = false;
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
  const id = (await createSession('termusage', 'kim', workspace, lazy ? { boot: 'on-demand' as const } : {})).id;
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
  delete process.env.B_STUDIO_SESSION_TOKEN_LIMIT;
  delete process.env.B_STUDIO_TERMINAL_STALL_SECONDS;
  delete process.env.B_STUDIO_TERMINAL_STALL_NUDGE;
  delete process.env.B_STUDIO_TERMINAL_STALL_NUDGE_MAX;
});

describe('U1: 사람 몫을 기록하지 못한 요청이 끝내 세지지 않는다', () => {
  it('기록 파일을 쓰지 못한 요청은 파일이 돌아온 뒤 다음 기록에 함께 더해지고, 같은 묶음을 다시 받아도 두 번 세지 않는다', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '100000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const good = process.env.B_STUDIO_USAGE_DIR!;
    await writeFile(path.join(path.dirname(good), 'blocker'), 'x');
    // 사용량 폴더가 파일 아래라 쓰지 못한다
    process.env.B_STUDIO_USAGE_DIR = path.join(path.dirname(good), 'blocker', 'usage');
    await session.gateway.telemetry(otlp([rec('r1')]));
    process.env.B_STUDIO_USAGE_DIR = good;
    expect(userTokens('kim', 'day')).toBe(0);
    // 파일이 돌아왔다. 내보내기가 같은 묶음(r1)만 다시 보내도 쓰지 못한 몫이 이어서 쓰인다(이미 센 번호라 새로 더하지는 않는다)
    await session.gateway.telemetry(otlp([rec('r1')]));
    expect(userTokens('kim', 'day')).toBe(11);
    // 새 요청(r2)이 오고 r1이 또 와도 두 번 세지 않는다
    await session.gateway.telemetry(otlp([rec('r1'), rec('r2', { input: 20 })]));
    expect(userTokens('kim', 'day')).toBe(11 + 21);
    // 더 다시 와도 늘지 않는다
    await session.gateway.telemetry(otlp([rec('r1'), rec('r2', { input: 20 })]));
    expect(userTokens('kim', 'day')).toBe(11 + 21);
  }, 30_000);

  it('기록하지 못한 몫도 그 실행의 한도 판정은 센다(ADR-209): 못 쓴 채로 사람 한도를 넘으면 실행을 멈춘다', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '20';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const good = process.env.B_STUDIO_USAGE_DIR!;
    await writeFile(path.join(path.dirname(good), 'blocker'), 'x');
    process.env.B_STUDIO_USAGE_DIR = path.join(path.dirname(good), 'blocker', 'usage');
    await session.gateway.telemetry(otlp([rec('r1', { input: 30 })]));
    process.env.B_STUDIO_USAGE_DIR = good;
    // 사용량 파일을 읽을 수 없는 판정이거나 한도 판정이다. 어느 쪽이든 실행은 멈춘다
    expect(session.ofType('run_cancelling')).toMatchObject([{ reason: 'budget' }]);
  }, 30_000);
});

describe('U1: 다시 쓴 몫은 그 실행의 한도 판정을 두 번 세지 않는다', () => {
  it('쓰기만 막혔다 돌아온 뒤 다시 쓴 몫이 원장에서 저장을 마친 몫으로 옮겨 가 한도(50) 아래에 머문다', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '50';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const dir = process.env.B_STUDIO_USAGE_DIR!;
    await session.gateway.telemetry(otlp([rec('r1', { input: 29 })]));
    expect(userTokens('kim', 'day')).toBe(30);
    // 읽기는 되고 쓰기만 막힌다
    await chmod(dir, 0o500);
    try {
      await session.gateway.telemetry(otlp([rec('r2', { input: 10 })]));
    } finally {
      await chmod(dir, 0o700);
    }
    expect(userTokens('kim', 'day')).toBe(30);
    // 같은 묶음만 다시 와도 쓰지 못한 11토큰이 쓰인다. 그다음 8토큰이 와도 합 49라 한도 아래다
    await session.gateway.telemetry(otlp([rec('r2', { input: 10 })]));
    expect(userTokens('kim', 'day')).toBe(41);
    await session.gateway.telemetry(otlp([rec('r3', { input: 7 })]));
    expect(userTokens('kim', 'day')).toBe(49);
    expect(session.ofType('run_cancelling')).toEqual([]);
  }, 30_000);
});

describe('U2: 텔레메트리가 오지 않으면 한도를 볼 수 없다', () => {
  /** 실행을 열고 쓰기 훅을 count번 보낸다. 거절이 나오면 그 글을 돌려준다 */
  async function writes(session: Opened, count: number): Promise<string | undefined> {
    for (let i = 0; i < count; i += 1) {
      const answer = await session.gateway.preTool(WRITE);
      if (answer.deny) return answer.deny;
    }
    return undefined;
  }

  it('텔레메트리 없이 시간이 지나고 쓰기 훅이 이어지면 쓰기를 막는다(턴 상한을 볼 수 없다)', async () => {
    const session = await open({ maxTurns: 1 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    const deny = await writes(session, 12);
    expect(deny).toContain('사용량');
  }, 30_000);

  it('텔레메트리가 한 번이라도 왔으면 막지 않는다(정상 세션)', async () => {
    const session = await open({ maxTurns: 100 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1')]));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    expect(await writes(session, 12)).toBeUndefined();
  }, 30_000);

  it('열린 직후 쓰기가 몰려도(텔레메트리가 1초 안팎으로 늦어도) 막지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    expect(await writes(session, 12)).toBeUndefined();
  }, 30_000);

  it('시간이 지나도 쓰기 훅이 몇 번 없으면 막지 않는다(긴 생각)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    expect(await writes(session, 3)).toBeUndefined();
  }, 30_000);

  it('막힌 뒤 텔레메트리가 오면 다시 풀린다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    expect(await writes(session, 12)).toContain('사용량');
    await session.gateway.telemetry(otlp([rec('r1')]));
    expect(await writes(session, 1)).toBeUndefined();
  }, 30_000);

  it('실행이 닫히고 새 실행이 열리면 앞 실행의 침묵이 이어지지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '[읽기만] 설명해줘' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    expect(await writes(session, 12)).toBeUndefined();
  }, 30_000);
});

describe('U2: 끊김으로 판정된 세션은 다음 실행에서도 소식이 올 때까지 막는다', () => {
  async function writes(session: Opened, count: number): Promise<string | undefined> {
    for (let i = 0; i < count; i += 1) {
      const answer = await session.gateway.preTool(WRITE);
      if (answer.deny) return answer.deny;
    }
    return undefined;
  }

  it('끊김으로 막힌 실행을 닫고 새 실행을 열어도, 소식이 오기 전의 첫 쓰기부터 막는다(실행마다 셈 없는 쓰기를 다시 주지 않는다)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 40_000);
    expect(await writes(session, 12)).toContain('사용량');
    await session.gateway.stop({ last_assistant_message: '막혔습니다.' });
    await session.gateway.prompt({ prompt: '다시 해 줘' });
    // 옛 판(실행마다 새로 셈): 새 실행은 쓰기 10번·30초를 셈 없이 받는다
    expect(await writes(session, 1)).toContain('사용량');
    // 소식이 오면 세션 표시도 풀린다
    await session.gateway.telemetry(otlp([rec('s1')]));
    expect(await writes(session, 1)).toBeUndefined();
  }, 30_000);
});

describe('U3: 실행을 연 사람은 세션 주인이다', () => {
  it('터미널 실행의 by는 늘 세션 주인이라 사용량이 주인의 한도에 센다', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '100000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    expect(session.ofType('run_started')).toMatchObject([{ by: 'kim' }]);
    await session.gateway.telemetry(otlp([rec('r1')]));
    expect(userTokens('kim', 'day')).toBe(11);
  }, 30_000);
});

describe('U4: 중복 제거 기억은 세션의 최근 2000개다', () => {
  it('2001번째 요청 뒤에 첫 요청 번호가 다시 오면 두 번 센다(닫는 쪽이라 고치지 않는다)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    for (let start = 0; start < 2001; start += 500) {
      const batch = [];
      for (let i = start; i < Math.min(start + 500, 2001); i += 1) batch.push(rec(`q${i}`));
      await session.gateway.telemetry(otlp(batch));
    }
    expect(getSnapshot(session.id)!.tokens!.inputTokens).toBe(2001 * 10);
    await session.gateway.telemetry(otlp([rec('q0')]));
    expect(getSnapshot(session.id)!.tokens!.inputTokens).toBe(2002 * 10);
  }, 60_000);
});

describe('U5: 열린 실행 안의 요청이 시작 시각보다 조금 앞서 찍혔다', () => {
  it('도구 호출이 연 실행에는 그 도구를 정한 모델 요청(열기 직전에 끝난)이 턴으로 붙는다', async () => {
    const session = await open({ maxTurns: 1 });
    // 요청 훅 없이 쓰기 훅이 실행을 연다
    expect(await session.gateway.preTool(WRITE)).toEqual({});
    await session.gateway.telemetry(otlp([rec('r1', { at: Date.now() - 1_500 })]));
    expect((await session.gateway.preTool(WRITE)).deny).toContain('턴 상한');
  }, 30_000);

  it('도구 호출이 연 실행이라도 5초보다 오래전 요청은 붙지 않는다', async () => {
    const session = await open({ maxTurns: 1 });
    expect(await session.gateway.preTool(WRITE)).toEqual({});
    await session.gateway.telemetry(otlp([rec('r1', { at: Date.now() - 20_000 })]));
    expect(await session.gateway.preTool(WRITE)).toEqual({});
  }, 30_000);

  it('요청 훅이 연 실행에서는 시작 앞의 요청이 붙지 않는다(앞 턴의 몫이다)', async () => {
    const session = await open({ maxTurns: 1 });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1', { at: Date.now() - 1_500 })]));
    expect(await session.gateway.preTool(WRITE)).toEqual({});
  }, 30_000);
});

describe('U6: 정체 알림이 정체 시간의 두 배까지 늦지 않는다', () => {
  it('마지막 움직임 뒤 정체 시간의 1.25배 안에 알린다', async () => {
    process.env.B_STUDIO_TERMINAL_STALL_SECONDS = '8';
    const session = await open();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await session.gateway.prompt({ prompt: '[읽기만] 설명해줘' });
    vi.advanceTimersByTime(1_000);
    // 1초 지점의 움직임(훅)
    await session.gateway.preTool({ tool_name: 'Read', tool_input: {} });
    vi.advanceTimersByTime(10_000);
    const warnings = session.events.filter((event) => event.type === 'agent' && event.event.type === 'warning');
    expect(warnings).toHaveLength(1);
  }, 30_000);
});

describe('정체 재촉(#1454)', () => {
  const NUDGE = '\x1b[200~멈춘 것 같습니다. 진행 상황을 확인하고 이어서 하거나, 막혔으면 이유를 알려 주세요.\x1b[201~';
  const warnings = (session: Opened) => session.events.filter((event) => event.type === 'agent' && event.event.type === 'warning');
  /** 정체 시간 8초, 켠 세션에서 요청을 열고 가짜 시계로 간다 */
  async function stalled(env: { nudge?: string; max?: string } = { nudge: '1' }): Promise<Opened> {
    process.env.B_STUDIO_TERMINAL_STALL_SECONDS = '8';
    if (env.nudge !== undefined) process.env.B_STUDIO_TERMINAL_STALL_NUDGE = env.nudge;
    if (env.max !== undefined) process.env.B_STUDIO_TERMINAL_STALL_NUDGE_MAX = env.max;
    const session = await open();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await session.gateway.prompt({ prompt: '[읽기만] 설명해줘' });
    return session;
  }

  it('꺼짐이 기본이다: 정체해도 글을 보내지 않고 알리기만 한다', async () => {
    const session = await stalled({});
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toEqual([]);
    expect(warnings(session)).toHaveLength(1);
  }, 30_000);

  it('켜면 정체가 이어질 때 재촉 글을 입력창에 한 번 보내고(붙여 넣기 + Enter), 보낸 글과 시각을 실행의 기록에 남긴다', async () => {
    const session = await stalled();
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toEqual([NUDGE, '\r']);
    const sent = warnings(session);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toMatch(/재촉 글을 보냈습니다\(\d{4}-\d\d-\d\dT[\d:.]+Z, 1\/1\).*멈춘 것 같습니다/);
  }, 30_000);

  it('재촉 뒤에도 멈춰 있으면 정체 시간을 더 기다린 뒤 알리기만 하고 더 보내지 않는다', async () => {
    const session = await stalled();
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toHaveLength(2);
    vi.advanceTimersByTime(2_000); // 재촉(8초 지점) 뒤 6초라 정체 시간(8초) 전이다
    expect(warnings(session)).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(fake.writes).toHaveLength(2);
    expect(warnings(session)).toHaveLength(2);
    expect(JSON.stringify(warnings(session)[1])).not.toContain('재촉 글을 보냈습니다');
  }, 30_000);

  it('상한을 올리면 그 수만큼만 보낸다. 움직임이 다시 생겨도 이 실행의 센 수는 되돌리지 않는다', async () => {
    const session = await stalled({ nudge: '1', max: '2' });
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toHaveLength(2);
    await session.gateway.preTool({ tool_name: 'Read', tool_input: {} }); // 움직임
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toHaveLength(4);
    await session.gateway.preTool({ tool_name: 'Read', tool_input: {} });
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toHaveLength(4);
  }, 30_000);

  it('사람 차례(권한 요청)에는 보내지 않고 지금처럼 알리기만 한다', async () => {
    const session = await stalled();
    await session.gateway.notification({ notification_type: 'permission_prompt', message: '권한' });
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toEqual([]);
    expect(warnings(session)).toHaveLength(1);
  }, 30_000);

  it('요청이 끝나 열린 실행이 없으면 보내지 않는다', async () => {
    const session = await stalled();
    await session.gateway.prompt({ prompt: '/clear' });
    await session.gateway.stop({});
    vi.advanceTimersByTime(30_000);
    expect(fake.writes).toEqual([]);
  }, 30_000);

  it('CLI가 떠 있지 않으면(셸일 수 있다) 글을 보내지 않고 알리기만 한다', async () => {
    fake.cliAlive = false;
    const session = await stalled();
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toEqual([]);
    expect(warnings(session)).toHaveLength(1);
  }, 30_000);

  it('쓰기가 실패해도 알리기로 돌아가고 같은 실패를 되풀이하지 않는다', async () => {
    fake.writeFails = true;
    const session = await stalled();
    vi.advanceTimersByTime(30_000);
    expect(warnings(session)).toHaveLength(1);
    fake.writeFails = false;
    vi.advanceTimersByTime(30_000);
    expect(fake.writes).toEqual([]);
  }, 30_000);

  it('재촉 상한은 실행마다 센다: 다음 실행은 다시 한 번 보낸다', async () => {
    const session = await stalled();
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toHaveLength(2);
    await session.gateway.stop({});
    await session.gateway.prompt({ prompt: '[읽기만] 다른 설명' });
    vi.advanceTimersByTime(12_000);
    expect(fake.writes).toHaveLength(4);
  }, 30_000);

  it('잘못된 값은 조용히 넘기지 않고 실행을 열 때 던진다', async () => {
    process.env.B_STUDIO_TERMINAL_STALL_NUDGE = 'yes';
    const session = await open();
    await expect(session.gateway.prompt({ prompt: '설명해줘' })).rejects.toThrow(/B_STUDIO_TERMINAL_STALL_NUDGE는 1/);
    process.env.B_STUDIO_TERMINAL_STALL_NUDGE = '1';
    process.env.B_STUDIO_TERMINAL_STALL_NUDGE_MAX = '0';
    await expect(session.gateway.prompt({ prompt: '설명해줘' })).rejects.toThrow(/NUDGE_MAX/);
  }, 30_000);
});

describe('토큰 한도 단계 알림(#1427)', () => {
  /** 한도 단계 알림(notice) 글만 */
  const stageNotices = (session: Opened) => session.ofType('notice').filter((event) => event.text.includes('토큰 한도의'));

  it('세션 한도의 50%·80%를 처음 넘을 때 한 번씩 알리고, 같은 단계는 다시 알리지 않는다', async () => {
    process.env.B_STUDIO_SESSION_TOKEN_LIMIT = '1000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1', { input: 99 })])); // 100 = 10%
    expect(stageNotices(session)).toEqual([]);
    await session.gateway.telemetry(otlp([rec('r2', { input: 449 })])); // 550 = 55%
    expect(stageNotices(session)).toHaveLength(1);
    expect(stageNotices(session)[0]?.text).toContain('50%');
    await session.gateway.telemetry(otlp([rec('r3', { input: 99 })])); // 650: 같은 단계
    expect(stageNotices(session)).toHaveLength(1);
    await session.gateway.telemetry(otlp([rec('r4', { input: 199 })])); // 850 = 85%
    expect(stageNotices(session)).toHaveLength(2);
    expect(stageNotices(session)[1]?.text).toContain('80%');
    expect(session.ofType('run_cancelling')).toEqual([]);
  }, 30_000);

  it('한 번에 두 단계를 넘으면 높은 단계만 알린다', async () => {
    process.env.B_STUDIO_SESSION_TOKEN_LIMIT = '1000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1', { input: 849 })]));
    expect(stageNotices(session).map((event) => event.text.includes('80%'))).toEqual([true]);
  }, 30_000);

  it('한도를 넘는 요청은 알리지 않고 지금처럼 멈춘다(막는 판정은 그대로)', async () => {
    process.env.B_STUDIO_SESSION_TOKEN_LIMIT = '1000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1', { input: 1199 })]));
    expect(stageNotices(session)).toEqual([]);
    expect(session.ofType('run_cancelling')).toMatchObject([{ reason: 'budget' }]);
  }, 30_000);

  it('한도가 없으면 아무것도 알리지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1', { input: 99999 })]));
    expect(stageNotices(session)).toEqual([]);
  }, 30_000);

  it('사람 한도의 단계도 알린다. 사용량 파일을 읽지 못하면 알리지 않고, 막는 쪽은 그대로 멈춘다', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '1000';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.telemetry(otlp([rec('r1', { input: 599 })]));
    expect(stageNotices(session)).toHaveLength(1);
    expect(stageNotices(session)[0]?.text).toContain('50%');
    // 사용량 폴더를 읽을 수 없는 쪽으로 돌린다: 알림은 0%로 읽지 않고 조용하며, 한도 판정은 실행을 멈춘다
    const good = process.env.B_STUDIO_USAGE_DIR!;
    await writeFile(path.join(path.dirname(good), 'blocker2'), 'x');
    process.env.B_STUDIO_USAGE_DIR = path.join(path.dirname(good), 'blocker2', 'usage');
    try {
      await session.gateway.telemetry(otlp([rec('r2', { input: 299 })]));
    } finally {
      process.env.B_STUDIO_USAGE_DIR = good;
    }
    expect(stageNotices(session)).toHaveLength(1);
    expect(session.ofType('run_cancelling')).toMatchObject([{ reason: 'budget' }]);
  }, 30_000);
});
