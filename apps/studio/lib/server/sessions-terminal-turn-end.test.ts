import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    id: 'studio-termturn-fake',
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

import { cancelRun, createSession, getSnapshot, openTerminalRunId, sessionTerminalTarget, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: termturn
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termturn-session-'));
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
  const id = (await createSession('termturn', 'kim', workspace, lazy ? { boot: 'on-demand' as const } : {})).id;
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



const ORIGINAL = 'class Order {}\n';
const CHANGED = 'class Order { String memo; }\n';
const fileOf = (session: Opened, file = 'api/src/Order.java') => readFile(path.join(session.work, file), 'utf8');
const edit = (session: Opened, file: string, content: string) => writeFile(path.join(session.work, file), content);
const WRITE = { tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: CHANGED } };
const VIOLATION = '관문 파일이 바뀌어 되돌렸습니다: settings.json';

interface TestSession {
  checkpoints: { commit: (...args: unknown[]) => Promise<unknown>; stagedFingerprints: (...args: unknown[]) => Promise<unknown>; pendingFingerprint: () => Promise<string> };
  pendingViolation?: string;
  terminal?: unknown;
}
/** 세션 저장소(전역). 시험이 체크포인트 저장을 붙잡는 자리다 */
const sessionOf = (id: string) => (globalThis as unknown as { __bStudio: { sessions: Map<string, TestSession> } }).__bStudio.sessions.get(id)!;

async function finishedRuns(session: Opened, count: number): Promise<Array<Extract<StudioEvent, { type: 'run_finished' }>>> {
  await until(`실행 닫힘 ${count}개`, () => session.ofType('run_finished').length >= count);
  return session.ofType('run_finished');
}

/** 만들기 실행을 열고 파일을 바꾼다(쓰기 훅이 허용했다) */
async function startWork(session: Opened, request = '주문에 메모 필드 추가'): Promise<void> {
  await session.gateway.prompt({ prompt: request });
  expect(await session.gateway.preTool(WRITE)).toEqual({});
  await edit(session, 'api/src/Order.java', CHANGED);
}

/** 체크포인트 저장(`commit`)을 붙잡는다. 부르면 `entered`가 풀리고 `release`를 부를 때까지 끝나지 않는다. `after`는 진짜 커밋이 끝난 뒤 부른다 */
function holdCommit(session: Opened, after?: () => void | Promise<void>): { entered: Promise<void>; release: () => void } {
  const checkpoints = sessionOf(session.id).checkpoints;
  const original = checkpoints.commit.bind(checkpoints);
  let enter = (): void => {};
  let release = (): void => {};
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  checkpoints.commit = async (...args: unknown[]) => {
    enter();
    await gate;
    const result = await original(...args);
    await after?.();
    return result;
  };
  return { entered, release };
}

describe('S6: 실행 도중 [읽기만]이 이어 와도 앞선 변경은 게이트를 지난다', () => {
  it('앞선 변경이 있는 실행에 [읽기만]이 이어 오면, 턴 끝에서 그 변경을 게이트에 넣어 통과하면 체크포인트를 남긴다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    await session.gateway.prompt({ prompt: '[읽기만] 방금 한 것을 설명해줘' });
    const answer = await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    // 옛 코드: 읽기만 지문이 이미 바뀐 파일을 품어 "바뀐 것 없음"으로 게이트 없이 done이 됐다
    expect(fake.execCalls).toContainEqual(['./gradlew', 'test']);
    expect(answer.message).toContain('검증 통과');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(await fileOf(session)).toBe(CHANGED);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
  }, 30_000);

  it('그 변경이 게이트를 통과하지 못하면 되돌린다(체크포인트 없이 파일이 남지 않는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    fake.failCommands = ['test'];
    await startWork(session);
    await session.gateway.prompt({ prompt: '[읽기만] 방금 한 것을 설명해줘' });
    const first = await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    expect(first.feedback).toBeDefined();
    expect(session.ofType('run_finished')).toEqual([]);
    // 읽기만이라 고칠 수 없다. 상한까지 돌려보낸 뒤 실패로 닫고 되돌린다
    await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    const last = await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    expect(last.message).toContain('검증 게이트');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);

  it('처음부터 읽기만인 실행은 지금처럼 게이트를 돌리지 않고 done으로 닫는다(회귀 방지)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '[읽기만] 주문 구조를 설명해줘' });
    expect(await session.gateway.stop({ last_assistant_message: '설명합니다.' })).toEqual({});
    expect(fake.execCalls).toEqual([]);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
  }, 30_000);

  it('읽기만 실행의 지문을 턴 끝에서 재지 못하면 확인하지 못한 것이다: 통과(done)가 아니라 실패로 닫는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '[읽기만] 주문 구조를 설명해줘' });
    sessionOf(session.id).checkpoints.pendingFingerprint = async () => {
      throw new Error('지문을 재지 못했습니다');
    };
    const answer = await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    expect(answer.message).toContain('읽기만 요청인데 파일이 바뀌었는지 확인하지 못했습니다');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
  }, 30_000);

  it('앞선 변경 없이(검증 상태 없이) 읽기만이 이어 온 실행은 읽기만 규칙이다: 훅을 우회해 바뀌면 실패로 닫고 되돌린다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.prompt({ prompt: '[읽기만] 설명해줘' });
    await edit(session, 'api/src/Order.java', CHANGED);
    const answer = await session.gateway.stop({ last_assistant_message: '설명합니다.' });
    expect(answer.message).toContain('읽기만 요청인데 파일이 바뀌었습니다');
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);
});

describe('게이트 뒤 판정에 쓰는 사실은 판정을 부르는 순간 값이다', () => {
  it('게이트가 끝난 뒤(마지막 지문 동기화 중)에 취소가 오면 통과로 저장하지 않고 취소로 닫는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    const runId = openTerminalRunId(session.id)!;
    const checkpoints = sessionOf(session.id).checkpoints;
    const original = checkpoints.stagedFingerprints.bind(checkpoints);
    let cancelled = false;
    checkpoints.stagedFingerprints = async (...args: unknown[]) => {
      // 게이트의 test 단계가 끝난 뒤 처음 부르는 지문 동기화에서 취소한다(게이트는 이미 통과를 돌려줬다)
      if (!cancelled && fake.execCalls.some((command) => command.includes('test'))) {
        cancelled = true;
        cancelRun(session.id, runId);
      }
      return original(...args);
    };
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(cancelled).toBe(true);
    expect(answer.message).toContain('취소');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'cancelled' }]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);
});

describe('S1: 체크포인트를 남기는 동안 온 위반은 통과로 묻히지 않는다', () => {
  it('저장 중 위반이 오면 그 실행을 실패로 닫는다. 체크포인트는 게이트가 본 내용이라 남기고, 다음 실행을 위반으로 닫지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    const held = holdCommit(session);
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await held.entered;
    sessionTerminalTarget(session.id).onViolation(VIOLATION);
    held.release();
    const answer = await stopping;
    // 옛 코드: 열린 실행이 없어 위반이 미뤄지고 이 실행은 done으로 닫혔다
    const [finished] = await finishedRuns(session, 1);
    expect(finished!.status).toBe('failed');
    expect(answer.message).toContain(VIOLATION);
    // 체크포인트는 남아 있고(검증한 내용과 같다) 작업 복사본은 그 체크포인트와 같다
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(await fileOf(session)).toBe(CHANGED);
    expect(sessionOf(session.id).pendingViolation).toBeUndefined();

    // 위반은 그 실행의 것이었다. 다음 실행은 평소대로 통과한다
    await session.gateway.prompt({ prompt: '둘째 요청' });
    await session.gateway.preTool(WRITE);
    await edit(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과');
  }, 30_000);

  it('저장 뒤 아직 닫기 전에 작업 복사본에 생긴 검증 밖 변경은 방금 남긴 체크포인트로 되돌린다', async () => {
    const session = await open();
    await startWork(session);
    const held = holdCommit(session, () => edit(session, 'api/src/Sneaked.java', 'class Sneaked {}\n'));
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await held.entered;
    sessionTerminalTarget(session.id).onViolation(VIOLATION);
    held.release();
    await stopping;
    expect(await fileOf(session)).toBe(CHANGED);
    expect(await readFile(path.join(session.work, 'api/src/Sneaked.java'), 'utf8').catch(() => 'gone')).toBe('gone');
  }, 30_000);

  it('저장 중이 아닐 때의 위반은 지금처럼 담아 두었다가 그 뒤 처음 끝나는 실행을 실패로 닫는다(회귀 방지)', async () => {
    const session = await open();
    sessionTerminalTarget(session.id).onViolation(VIOLATION);
    expect(sessionOf(session.id).pendingViolation).toBe(VIOLATION);
    await startWork(session);
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain(VIOLATION);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);
});

describe('S14: 체크포인트를 남긴 뒤에는 되돌리지 않는다', () => {
  it('저장은 끝났는데 그 아래 단계가 던지면 체크포인트와 작업 복사본을 그대로 두고 실행만 실패로 닫는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    let armed = true;
    subscribe(session.id, (event) => {
      if (armed && event.type === 'agent' && event.event.type === 'done') {
        armed = false;
        throw new Error('알림 구독자가 던졌습니다');
      }
    });
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    const [finished] = await finishedRuns(session, 1);
    expect(finished!.status).toBe('failed');
    expect(answer.message).toContain('알림 구독자가 던졌습니다');
    expect(answer.message).toContain('체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(await fileOf(session)).toBe(CHANGED);
    expect(session.ofType('reverted')).toEqual([]);
  }, 30_000);

  it('저장 안에서 커밋이 끝난 뒤 던지면 화면의 체크포인트 목록을 Git에 맞추고 되돌리지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    const held = holdCommit(session, () => {
      throw new Error('커밋 뒤 단계가 던졌습니다');
    });
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await held.entered;
    held.release();
    const answer = await stopping;
    await finishedRuns(session, 1);
    expect(answer.message).toContain('커밋 뒤 단계가 던졌습니다');
    // 옛 코드: 커밋은 Git에 있는데 화면의 목록에는 없고, 낡은 기준으로 되돌렸다
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(await fileOf(session)).toBe(CHANGED);
  }, 30_000);

  it('저장 전에 던지면(게이트가 던졌다) 지금처럼 되돌린다(회귀 방지)', async () => {
    const session = await open();
    await startWork(session);
    const checkpoints = sessionOf(session.id).checkpoints;
    checkpoints.commit = async () => {
      throw new Error('커밋하지 못했습니다');
    };
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('커밋하지 못했습니다');
    expect(await fileOf(session)).toBe(ORIGINAL);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'error' }]);
  }, 30_000);
});

describe('S11: 미룬 위반은 세션을 멈추면 잊는다(멈춘 세션에는 판정을 낼 다음 턴이 없다)', () => {
  it('멈추면 담아 둔 위반을 지우고 저장 파일에도 싣지 않는다', async () => {
    const session = await open();
    sessionTerminalTarget(session.id).onViolation(VIOLATION);
    expect(sessionOf(session.id).pendingViolation).toBe(VIOLATION);
    const file = path.join(getSnapshot(session.id)!.workDir, '.git', 'b-studio', 'session.json');
    await stopSession(session.id);
    expect(sessionOf(session.id)?.pendingViolation).toBeUndefined();
    expect(await readFile(file, 'utf8')).not.toContain('pendingViolation');
  }, 30_000);
});

describe('S12: 검증 재시도 상한은 게이트 쪽과 게이트 밖 사유를 합쳐 센다', () => {
  it('게이트가 두 번 실패한 뒤 게이트 밖 사유(검증 중 파일이 바뀜)로 돌려보낼 차례에 상한에 닿아 실패로 닫는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    fake.failCommands = ['test'];
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).feedback).toBeDefined();
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).feedback).toBeDefined();
    // 셋째: 게이트는 통과하지만 도는 동안 파일이 바뀐다(게이트 밖 사유 1번)
    fake.failCommands = [];
    fake.holdWord = 'test';
    let release = (): void => {};
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const calls = fake.execCalls.length;
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await until('검사 시작', () => fake.execCalls.length > calls);
    await edit(session, 'api/src/Order.java', 'class Order { String memo; /* 바뀜 */ }\n');
    release();
    const answer = await stopping;
    // 옛 코드: 게이트 2번 + 게이트 밖 1번을 따로 세어 한 번 더 돌려보냈다(feedback)
    expect(answer.feedback).toBeUndefined();
    expect(answer.message).toContain('검증');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);

  it('게이트 밖 사유만 세 번이면 지금처럼 세 번째에 닫는다(회귀 방지)', async () => {
    const session = await open();
    await startWork(session);
    fake.holdWord = 'test';
    for (let round = 1; round <= 3; round++) {
      let release = (): void => {};
      fake.hold = new Promise<void>((resolve) => (release = resolve));
      const calls = fake.execCalls.length;
      const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
      await until('검사 시작', () => fake.execCalls.length > calls);
      await edit(session, 'api/src/Order.java', `class Order { String memo; /* ${round} */ }\n`);
      release();
      const answer = await stopping;
      if (round < 3) expect(answer.feedback).toContain('검증하는 동안 바뀐 파일');
      else expect(answer.message).toContain('검증하는 동안 파일이 계속 바뀌어 통과시키지 않았습니다');
    }
  }, 30_000);
});
