import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

const execFileAsync = promisify(execFile);

/**
 * 세션 터미널의 관문(이슈 #673 2단계)을 실제 sessions.ts로 본다: 터미널에서 온 요청이 게이트와 체크포인트로 이어지는가.
 * 가짜는 샌드박스(Docker)와 터미널(컨테이너의 CLI)뿐이다. CLI가 하는 일은 훅을 부르는 것과 작업 복사본의 파일을 고치는 것이므로,
 * 테스트가 그 둘을 직접 한다. 작업 복사본·체크포인트·게이트는 실제 코드가 돈다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  execCalls: [] as string[][],
  /** 이 낱말이 든 명령은 종료 코드 1로 끝난다(선언한 테스트를 실패시킬 때 쓴다) */
  failCommands: [] as string[],
  /** 켜면 서비스 재시작이 샌드박스 쪽 문제로 실패한다 */
  startFails: false,
  starts: 0,
  /** 서비스를 다시 띄운 횟수 */
  restarts: 0,
  /** 켜면 서비스를 다시 띄우지 못한다 */
  restartFails: false,
  interrupts: [] as string[],
  /** holdWord가 든 명령은 hold가 풀릴 때까지 끝나지 않는다(실행이나 검증을 열어 둔 채로 두는 데 쓴다) */
  holdWord: undefined as string | undefined,
  hold: undefined as Promise<void> | undefined,
  /** 서비스가 떠 있는 주소. 테스트마다 계약을 내놓는 작은 서버를 띄운다 */
  serviceUrl: 'http://127.0.0.1:1',
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-termgw-fake',
    name: 'fake',
    async start() {
      fake.starts += 1;
      if (fake.startFails) throw new actual.SandboxError('도커에 닿지 못했습니다', 'Cannot connect to the Docker daemon', { platform: true });
      return [];
    },
    async restart(service: string) {
      fake.restarts += 1;
      if (fake.restartFails) throw new Error('컨테이너가 종료됐습니다');
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
vi.mock('./session-terminal', () => ({
  disposeSessionTerminal: async () => {},
  interruptSessionTerminal: (sessionId: string) => {
    fake.interrupts.push(sessionId);
  },
}));

import { cancelRun, createSession, getSnapshot, sendMessage, sessionHistory, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL };

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termgw-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(
    path.join(project, 'studio.yaml'),
    `version: 1
name: termgw
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
`,
  );
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = project;
  fake.execCalls = [];
  fake.failCommands = [];
  fake.startFails = false;
  fake.starts = 0;
  fake.restarts = 0;
  fake.restartFails = false;
  fake.interrupts = [];
  fake.holdWord = undefined;
  fake.hold = undefined;
  await serveContract();
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_EXPERIMENTAL = '1';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
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
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 서비스가 지금 내놓는 API 계약. 테스트가 doc을 바꾸면 "고친 코드로 다시 뜬 서비스의 계약"이 바뀐다 */
const service = { doc: undefined as unknown, down: false, onFetch: undefined as (() => void) | undefined };
async function serveContract(): Promise<void> {
  service.doc = contractWith(['id', 'memo']);
  service.down = false;
  service.onFetch = undefined;
  const server = createServer((_request, response) => {
    service.onFetch?.();
    response.writeHead(service.down ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(service.down ? { error: 'starting' } : service.doc));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.serviceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const contractWith = (fields: string[]) => ({
  openapi: '3.0.1',
  paths: { '/api/orders': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } } } } } },
  components: { schemas: { OrderResponse: { type: 'object', properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])) } } },
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_AUTH', saved.auth], ['B_STUDIO_SESSIONS_DIR', saved.sessions], ['B_STUDIO_EXPERIMENTAL', saved.experimental]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Opened {
  id: string;
  /** 세션의 작업 복사본. 컨테이너 안의 CLI가 /workspace로 보는 폴더다 */
  work: string;
  gateway: ReturnType<typeof terminalGatewayHandlersForTest>;
  events: StudioEvent[];
  ofType<T extends StudioEvent['type']>(type: T): Array<Extract<StudioEvent, { type: T }>>;
}

async function open({ lazy = false }: { lazy?: boolean } = {}): Promise<Opened> {
  // lazy: 사람이 만든 일반 세션처럼 샌드박스를 필요할 때 켠다(개인 PC 모드의 기본)
  const id = (await createSession('termgw', 'kim', 'copy', lazy ? { boot: 'on-demand' } : {})).id;
  const started = Date.now();
  while (getSnapshot(id)?.status !== (lazy ? 'idle' : 'ready')) {
    if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events: StudioEvent[] = [];
  subscribe(id, (event) => events.push(event));
  const { root } = (await import('./sessions')).sessionTerminalTarget(id);
  return { id, work: root, gateway: terminalGatewayHandlersForTest(id), events, ofType: (type) => events.filter((event): event is Extract<StudioEvent, { type: typeof type }> => event.type === type) };
}

const edit = (session: Opened, file: string, content: string) => writeFile(path.join(session.work, file), content);
const git = async (session: Opened, ...args: string[]) => (await execFileAsync('git', ['-C', session.work, ...args])).stdout;
/** CLI가 하는 대로: 쓰기 직전의 훅을 부르고 파일을 고친다 */
async function write(session: Opened, file: string, content: string): Promise<Awaited<ReturnType<Opened['gateway']['preTool']>>> {
  const answer = await session.gateway.preTool({ tool_name: 'Write', tool_input: { file_path: `/workspace/${file}`, content } });
  if (!answer.deny) await edit(session, file, content);
  return answer;
}

describe('터미널에서 온 요청은 게이트를 지나야 체크포인트가 된다 (이슈 #673 2단계)', () => {
  it('요청 → 파일 변경 → 턴의 끝: 게이트(선언한 테스트 포함)가 돌고, 통과하면 요청 글로 체크포인트를 남긴다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;

    expect(await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' })).toEqual({});
    expect(getSnapshot(session.id)!.running).toBe(true);
    const started = session.ofType('run_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ request: '주문에 메모 필드 추가', via: 'terminal', by: 'kim' });

    expect(await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).toEqual({});
    const answer = await session.gateway.stop({ last_assistant_message: '메모 필드를 추가했습니다.' });

    const snapshot = getSnapshot(session.id)!;
    expect(snapshot.checkpoints).toHaveLength(before + 1);
    const checkpoint = snapshot.checkpoints[0]!;
    expect(checkpoint.message).toBe('feat: 주문에 메모 필드 추가');
    expect(checkpoint.files).toEqual(['api/src/Order.java']);
    expect(checkpoint.passedStages).toEqual(expect.arrayContaining(['run', 'contract_check', 'test', 'review']));
    // 선언한 테스트가 서비스 컨테이너에서 실제로 돌았다
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
    // 터미널의 사용자에게는 한 줄로 알린다. 에이전트에게 돌려주는 글(feedback)은 없다
    expect(answer).toEqual({ message: `[b-studio] 검증 통과 — 체크포인트 ${checkpoint.shortSha}` });
    expect(snapshot.running).toBe(false);
    const finished = session.ofType('run_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ runId: started[0]!.runId, status: 'done', summary: '메모 필드를 추가했습니다.' });
    // 작업 복사본은 체크포인트와 같다(남은 변경이 없다)
    expect(await git(session, 'status', '--porcelain')).toBe('');
    await stopSession(session.id);
  }, 30_000);

  it('검증이 실패하면 체크포인트를 남기지 않고 결과를 에이전트에게 돌려준다. 고친 뒤 턴이 끝나면 다시 검증한다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo }\n');

    fake.failCommands = ['test'];
    const failed = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(failed.feedback).toContain('[b-studio 검증 게이트]');
    expect(failed.feedback).toContain('unit');
    expect(failed.message).toBeUndefined();
    // 실행은 열려 있고 체크포인트는 없다
    expect(getSnapshot(session.id)!.running).toBe(true);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished')).toEqual([]);

    fake.failCommands = [];
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const passed = await session.gateway.stop({ last_assistant_message: '세미콜론을 고쳤습니다.' });
    expect(passed.feedback).toBeUndefined();
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'done' });
    // 요청 하나에 실행 하나다(다시 검증했다고 실행이 늘지 않는다)
    expect(session.ofType('run_started')).toHaveLength(1);
    await stopSession(session.id);
  }, 30_000);

  it('재시도 상한까지 통과하지 못하면 실패로 끝낸다. 변경은 되돌리지 않지만 체크포인트도 남기지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo }\n');
    fake.failCommands = ['test'];
    expect((await session.gateway.stop({})).feedback).toBeDefined();
    expect((await session.gateway.stop({})).feedback).toBeDefined();
    const last = await session.gateway.stop({ last_assistant_message: '더는 못 고치겠습니다.' });
    // 상한을 다 쓰면 더 막지 않는다(막으면 CLI가 끝나지 않는다). 대신 실패로 닫는다
    expect(last.feedback).toBeUndefined();
    expect(last.message).toContain('체크포인트를 남기지 않았습니다');

    const snapshot = getSnapshot(session.id)!;
    expect(snapshot.checkpoints).toHaveLength(before);
    expect(snapshot.running).toBe(false);
    const finished = session.ofType('run_finished')[0]!;
    expect(finished.status).toBe('failed');
    expect(finished.summary).toContain('검증 게이트를 3번 통과하지 못했습니다');
    expect(finished.summary).toContain('변경은 작업 폴더에 그대로 있습니다');
    // 되돌리지 않았다: CLI가 고친 내용이 그대로 있다
    expect(await readFile(path.join(session.work, 'api/src/Order.java'), 'utf8')).toBe('class Order { String memo }\n');
    expect(session.ofType('reverted')).toEqual([]);

    // 다음 요청의 검증은 남은 변경을 함께 본다. 테스트가 통과하게 되면 그때 체크포인트가 된다
    fake.failCommands = [];
    await session.gateway.prompt({ prompt: '이어서 고쳐줘' });
    expect((await session.gateway.stop({ last_assistant_message: '확인했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(getSnapshot(session.id)!.checkpoints[0]!.files).toEqual(['api/src/Order.java']);
    await stopSession(session.id);
  }, 30_000);

  it('파일을 바꾸지 않은 턴은 검증 없이 끝난다(답만 한 요청). 체크포인트도 서비스 재시작도 없다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '이 프로젝트 구조를 설명해줘' });
    expect(await session.gateway.stop({ last_assistant_message: 'api 서비스 하나로 된 프로젝트입니다.' })).toEqual({});
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(fake.execCalls).toEqual([]);
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'done', summary: 'api 서비스 하나로 된 프로젝트입니다.' });
    expect(getSnapshot(session.id)!.running).toBe(false);
    await stopSession(session.id);
  }, 30_000);

  it('훅을 거치지 않고 바뀐 파일도 턴의 끝에서 검증한다(쓰기 직전의 훅이 불리지 않아도 체크포인트는 게이트를 지난다)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    // 훅이 걸리지 않은 경로로 바뀌었다(예: 백그라운드 명령)
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    fake.failCommands = ['test'];
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('[b-studio 검증 게이트]');
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
    await stopSession(session.id);
  }, 30_000);

  it('게이트가 검증할 수 없는 경로(비밀 파일, 밖을 가리키는 링크)가 바뀌었으면 통과시키지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '설정 파일 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await edit(session, '.env', 'API_KEY=secret\n');
    await symlink('/etc/hosts', path.join(session.work, 'api/src/hosts'));

    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('게이트가 검증할 수 없는 경로');
    expect(answer.feedback).toContain('.env');
    expect(answer.feedback).toContain('api/src/hosts');
    // 다른 파일이 멀쩡해도 체크포인트는 없다
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    // 게이트의 나머지 단계는 돌리지 않았다
    expect(fake.execCalls).toEqual([]);

    // 지우면 통과한다
    await rm(path.join(session.work, '.env'));
    await rm(path.join(session.work, 'api/src/hosts'));
    expect((await session.gateway.stop({ last_assistant_message: '지웠습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints[0]!.files).toEqual(['api/src/Order.java']);
    await stopSession(session.id);
  }, 30_000);
});

describe('터미널의 실행과 대화 창의 요청은 겹치지 않는다', () => {
  it('터미널의 실행이 열려 있는 동안 대화 창의 요청은 받지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    expect(() => sendMessage(session.id, '다른 요청', { allowBreaking: false })).toThrow('이전 요청을 처리하는 중입니다');
    await session.gateway.stop({ last_assistant_message: '끝' });
    await stopSession(session.id);
  }, 30_000);

  it('대화 창의 요청이 도는 동안 터미널의 요청은 막고, 쓰기 직전의 도구도 거절한다', async () => {
    const session = await open();
    let release = (): void => {};
    fake.holdWord = 'hold';
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const finished = new Promise<void>((resolve) => subscribe(session.id, (event) => event.type === 'run_finished' && resolve()));
    // 대화 창의 요청이 서비스 안 명령에서 오래 머문다: 그동안 대화 창의 실행이 열려 있다
    sendMessage(session.id, '빌드해줘', { allowBreaking: false, scriptedTurns: [{ toolCalls: [{ name: 'run_in_service', input: { service: 'api', command: ['hold'] } }] }, { text: '끝났습니다.' }] });
    while (!fake.execCalls.some((command) => command.includes('hold'))) await new Promise((resolve) => setTimeout(resolve, 10));
    const blocked = await session.gateway.prompt({ prompt: '터미널에서 보낸 요청' });
    expect(blocked.blocked).toContain('앞선 요청을 처리하는 중입니다');
    expect((await session.gateway.preTool({ tool_name: 'Write', tool_input: {} })).deny).toContain('앞선 요청을 처리하는 중입니다');
    expect((await session.gateway.runTool('run_in_service', { service: 'api', command: ['ls'] })).ok).toBe(false);
    expect(fake.execCalls).toEqual([['hold']]);
    // 터미널의 실행은 열리지 않았다
    expect(session.ofType('run_started').filter((event) => event.via === 'terminal')).toEqual([]);
    release();
    await finished;
    await stopSession(session.id);
  }, 30_000);

  it('화면에서 취소하면 실행을 닫고 CLI에 멈추라고 알린다. 변경은 되돌리지 않고 체크포인트도 남기지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const runId = session.ofType('run_started')[0]!.runId;

    cancelRun(session.id, runId);
    expect(fake.interrupts).toEqual([session.id]);
    const finished = session.ofType('run_finished')[0]!;
    expect(finished).toMatchObject({ runId, status: 'cancelled' });
    expect(finished.summary).toContain('변경은 작업 폴더에 그대로 있습니다');
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await readFile(path.join(session.work, 'api/src/Order.java'), 'utf8')).toBe('class Order { String memo; }\n');
    // 닫힌 실행의 턴이 늦게 끝나도 체크포인트는 생기지 않는다
    expect(await session.gateway.stop({ last_assistant_message: '끝' })).toEqual({});
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    // 대화 창은 다시 요청을 받는다
    expect(() => sendMessage(session.id, '다른 요청', { allowBreaking: false, scriptedTurns: [{ text: '네' }] })).not.toThrow();
    await stopSession(session.id);
  }, 30_000);
});

describe('턴의 끝이 겹치거나 도중에 끊길 때', () => {
  it('턴의 끝이 두 번 겹쳐 와도 검증과 체크포인트는 한 번이다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const [first, second] = await Promise.all([session.gateway.stop({ last_assistant_message: '추가했습니다.' }), session.gateway.stop({ last_assistant_message: '추가했습니다.' })]);
    expect(first.message).toContain('검증 통과 — 체크포인트');
    expect(second).toEqual({});
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(session.ofType('run_finished')).toHaveLength(1);
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
    await stopSession(session.id);
  }, 30_000);

  it('검증이 도는 중에 취소하면 그 검증은 체크포인트를 남기지 않고 끝난다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    let release = (): void => {};
    fake.holdWord = 'test';
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    while (!fake.execCalls.some((command) => command.includes('test'))) await new Promise((resolve) => setTimeout(resolve, 10));

    cancelRun(session.id, session.ofType('run_started')[0]!.runId);
    // 검증이 도는 동안에는 그 검증이 닫는다. 두 번 닫지 않는다
    expect(session.ofType('run_finished')).toEqual([]);
    release();
    const answer = await stopping;
    expect(answer.feedback).toBeUndefined();
    expect(answer.message).toContain('요청을 닫았습니다');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'cancelled' }]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 테스트는 통과했지만(가짜는 0으로 끝난다) 취소한 실행은 체크포인트가 되지 않는다
    expect(await readFile(path.join(session.work, 'api/src/Order.java'), 'utf8')).toBe('class Order { String memo; }\n');
    await stopSession(session.id);
  }, 30_000);
});

describe('통과한 뒤', () => {
  it('검증을 통과해 체크포인트를 남기는 동안에는 취소를 받지 않는다(대화 창의 요청과 같다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const runId = session.ofType('run_started')[0]!.runId;
    const refused: string[] = [];
    // 체크포인트가 막 생긴 순간(저장이 아직 끝나지 않았다)에 취소를 누른다
    subscribe(session.id, (event) => {
      if (event.type !== 'checkpoint') return;
      try {
        cancelRun(session.id, runId);
      } catch (error) {
        refused.push(error instanceof Error ? error.message : String(error));
      }
    });
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('취소할 수 있는 요청이 없습니다');
    expect(answer.message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
    expect(session.ofType('run_cancelling')).toEqual([]);
    expect(fake.interrupts).toEqual([]);
    await stopSession(session.id);
  }, 30_000);
});

describe('샌드박스를 필요할 때 켜는 세션(개인 PC 모드의 기본)', () => {
  it('답만 한 턴은 샌드박스를 켜지 않는다. 파일을 바꿀 수 있는 도구를 쓰기 직전에 켜고, 그때 변경 전 기준을 잡는다', async () => {
    const session = await open({ lazy: true });
    await session.gateway.prompt({ prompt: '이 프로젝트 구조를 설명해줘' });
    await session.gateway.stop({ last_assistant_message: 'api 서비스 하나입니다.' });
    expect(fake.starts).toBe(0);
    expect(getSnapshot(session.id)!.status).toBe('idle');

    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    expect(fake.starts).toBe(0);
    expect(await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).toEqual({});
    // 쓰기 직전의 훅이 돌아왔을 때는 이미 켜져 있다
    expect(fake.starts).toBe(1);
    expect(getSnapshot(session.id)!.status).toBe('ready');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    await stopSession(session.id);
  }, 30_000);

  it('샌드박스를 켜지 못하면 파일을 바꿀 수 있는 도구를 막는다(변경 전 기준 없이 바뀌게 두지 않는다). 읽기 도구는 그대로 쓴다', async () => {
    const session = await open({ lazy: true });
    const before = getSnapshot(session.id)!.checkpoints.length;
    fake.startFails = true;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    // 읽기 도구는 샌드박스를 켜지도, 실패를 겪지도 않는다
    expect(await session.gateway.preTool({ tool_name: 'Read', tool_input: { file_path: '/workspace/api/src/Order.java' } })).toEqual({});
    expect(fake.starts).toBe(0);

    const answer = await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(answer.deny).toContain('샌드박스를 준비하지 못해 파일을 바꿀 수 있는 도구를 막았습니다');
    expect(answer.deny).toContain('도커에 닿지 못했습니다');
    // 막힌 도구는 파일을 바꾸지 못했다
    expect(await readFile(path.join(session.work, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');
    // 셸도, 이름을 모르는 도구도 같다
    expect((await session.gateway.preTool({ tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ api/src/Order.java' } })).deny).toBeDefined();
    expect((await session.gateway.preTool({ tool_name: 'SomeNewTool', tool_input: {} })).deny).toBeDefined();
    expect(await session.gateway.stop({ last_assistant_message: '막혀서 하지 못했습니다.' })).toEqual({});
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);

    // 켤 수 있게 되면 그때 기준을 잡고 진행한다
    fake.startFails = false;
    await session.gateway.prompt({ prompt: '다시 해줘' });
    expect(await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).toEqual({});
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    await stopSession(session.id);
  }, 30_000);
});

describe('실패한 실행이 남긴 변경은 다음 실행에서도 같은 기준으로 본다 (변경을 되돌리지 않는 대신)', () => {
  it('계약을 깨는 변경은 실행을 바꿔도 통과하지 못한다(다음 실행이 남은 변경을 기준으로 삼지 않는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문 응답에서 memo를 빼줘' });
    await write(session, 'api/src/Order.java', 'class Order { /* memo 없음 */ }\n');
    // 고친 코드로 서비스가 다시 뜨면 계약에서 필드가 사라진다
    service.doc = contractWith(['id']);
    const first = await session.gateway.stop({ last_assistant_message: 'memo를 뺐습니다.' });
    expect(first.feedback).toContain('memo');
    await session.gateway.stop({});
    expect((await session.gateway.stop({})).message).toContain('체크포인트를 남기지 않았습니다');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);

    // 새 실행: 아무것도 고치지 않고 턴만 끝낸다. 기준을 새로 잡았다면 "원래 그랬던 계약"이 되어 통과했을 것이다
    await session.gateway.prompt({ prompt: '됐어, 그대로 끝내줘' });
    const second = await session.gateway.stop({ last_assistant_message: '끝냈습니다.' });
    expect(second.feedback).toContain('memo');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);

    // 화면에서 닫고 다시 시작해도, CLI를 끝냈다 다시 띄워도 같다
    cancelRun(session.id, session.ofType('run_started')[1]!.runId);
    await session.gateway.prompt({ prompt: '다시' });
    await session.gateway.sessionEnd({});
    await session.gateway.prompt({ prompt: '또 다시' });
    expect((await session.gateway.stop({})).feedback).toContain('memo');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);

    // 계약을 되돌려 놓으면(필드를 다시 넣으면) 통과한다
    service.doc = contractWith(['id', 'memo']);
    expect((await session.gateway.stop({ last_assistant_message: '되돌렸습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);

    // 체크포인트가 생기면 그 계약이 새 기준이다: 필드를 더하는 것은 깨는 변경이 아니다
    await session.gateway.prompt({ prompt: 'note 필드를 더해줘' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    service.doc = contractWith(['id', 'memo', 'note']);
    expect((await session.gateway.stop({ last_assistant_message: '더했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    await stopSession(session.id);
  }, 60_000);

  it('터미널에서 막힌 계약 변경은 대화 창의 요청으로도 통과하지 못한다(같은 기준으로 본다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문 응답에서 memo를 빼줘' });
    await write(session, 'api/src/Order.java', 'class Order { /* memo 없음 */ }\n');
    service.doc = contractWith(['id']);
    await session.gateway.stop({});
    await session.gateway.stop({});
    await session.gateway.stop({});
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);

    // 대화 창에서 아무 요청이나 보낸다. 남은 변경은 "실행 전부터 있던 변경"으로 게이트에 들어간다
    const finished = new Promise<Extract<StudioEvent, { type: 'run_finished' }>>((resolve) => subscribe(session.id, (event) => event.type === 'run_finished' && event.runId !== session.ofType('run_started')[0]!.runId && resolve(event)));
    sendMessage(session.id, '마무리해줘', { allowBreaking: false, scriptedTurns: [{ text: '마무리했습니다.' }, { text: '고칠 수 없습니다.' }, { text: '고칠 수 없습니다.' }, { text: '고칠 수 없습니다.' }] });
    const outcome = await finished;
    // 기준을 새로 읽었다면 통과해 체크포인트가 됐을 것이다
    expect(outcome.status).toBe('failed');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    await stopSession(session.id);
  }, 60_000);

  it('대화 창의 요청이 남긴 체크포인트도 그때의 계약을 기준으로 잡아 둔다(그 뒤 터미널에서 실패한 변경이 그 기준과 견줘진다)', async () => {
    const session = await open();
    // 대화 창의 요청이 필드를 더해 체크포인트를 남긴다
    const done = new Promise<void>((resolve) => subscribe(session.id, (event) => event.type === 'run_finished' && resolve()));
    service.doc = contractWith(['id', 'memo', 'note']);
    sendMessage(session.id, 'note 필드를 더해줘', { allowBreaking: false, scriptedTurns: [{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order { String memo; String note; }\n' } }] }, { text: '더했습니다.' }] });
    await done;
    const before = getSnapshot(session.id)!.checkpoints.length;

    // 방금 더한 note가 훅을 거치지 않고 빠진다(사람이 셸에서 고쳤거나 훅이 닿지 못했다). 터미널의 첫 검증은 이미 바뀐 상태에서 시작한다.
    // 그래도 기준은 대화 창의 체크포인트 때 잡아 둔 계약이라 깨는 변경으로 잡힌다(지금 계약을 기준으로 읽으면 놓친다)
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    service.doc = contractWith(['id', 'memo']);
    await session.gateway.prompt({ prompt: '정리해줘' });
    expect((await session.gateway.stop({})).feedback).toContain('note');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    await stopSession(session.id);
  }, 60_000);

  it('기준은 체크포인트 곁의 파일에서만 온다. 기록이 없는 체크포인트에서는 서비스를 그 코드로 다시 띄운 직후에 읽은 계약을 남긴다', async () => {
    const session = await open();
    const recordFile = (sha: string) => path.join(session.work, '.git/b-studio/contracts', `${sha}.json`);
    const fieldsAt = async (sha: string) => Object.keys((JSON.parse(await readFile(recordFile(sha), 'utf8')) as { api: ReturnType<typeof contractWith> }).api.components.schemas.OrderResponse.properties);
    const start = getSnapshot(session.id)!.checkpoints[0]!.sha;
    await expect(readFile(recordFile(start), 'utf8')).rejects.toThrow();

    await session.gateway.prompt({ prompt: 'note 필드를 더해줘' });
    const restartsBefore = fake.restarts;
    await write(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    // 이미 떠 있던 서비스가 이 체크포인트의 코드로 떠 있다는 보장이 없다. 다시 띄운 뒤에 읽어 기록으로 남겼다
    expect(fake.restarts).toBe(restartsBefore + 1);
    expect(await fieldsAt(start)).toEqual(['id', 'memo']);

    service.doc = contractWith(['id', 'memo', 'note']);
    await session.gateway.stop({ last_assistant_message: '더했습니다.' });
    const head = getSnapshot(session.id)!.checkpoints[0]!.sha;
    expect(head).not.toBe(start);
    // 통과한 검증이 본 계약이 새 체크포인트의 기록이다
    expect(await fieldsAt(head)).toEqual(['id', 'memo', 'note']);

    // 체크포인트 뒤에 서비스가 다른 계약을 내놓아도(코드가 또 바뀌었다) 기록은 게이트가 본 것 그대로다
    service.doc = contractWith(['id']);
    await session.gateway.prompt({ prompt: '아무것도 하지 마' });
    await session.gateway.stop({ last_assistant_message: '네' });
    expect(await fieldsAt(head)).toEqual(['id', 'memo', 'note']);
    // 그 기록이 다음 실행의 기준이다: 작업 복사본이 체크포인트 그대로여도 지금 서비스의 계약(필드 둘이 빠짐)을 기준으로 다시 읽지 않고,
    // 기록이 있으니 서비스를 다시 띄우지도 않는다
    const restartsAtHead = fake.restarts;
    await session.gateway.prompt({ prompt: '필드를 빼줘' });
    await write(session, 'api/src/Order.java', 'class Order {}\n');
    expect(fake.restarts).toBe(restartsAtHead);
    const answer = await session.gateway.stop({});
    expect(answer.feedback).toContain('memo');
    expect(answer.feedback).toContain('note');
    await stopSession(session.id);
  }, 60_000);

  it('이 호출이 샌드박스를 막 켰으면 서비스는 지금의 코드로 뜬 것이다. 다시 띄우지 않고 읽어 남긴다', async () => {
    const session = await open({ lazy: true });
    const start = getSnapshot(session.id)!.checkpoints[0]!.sha;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(fake.starts).toBe(1);
    expect(fake.restarts).toBe(0);
    expect(await readFile(path.join(session.work, '.git/b-studio/contracts', `${start}.json`), 'utf8')).toContain('memo');
    await stopSession(session.id);
  }, 30_000);

  it('계약을 다 읽지 못했으면 그 체크포인트의 기록으로 남기지 않는다(일부만 읽힌 계약이 기준으로 굳지 않는다)', async () => {
    const session = await open();
    const start = getSnapshot(session.id)!.checkpoints[0]!.sha;
    const recordFile = path.join(session.work, '.git/b-studio/contracts', `${start}.json`);
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    // 쓰기 직전에 서비스가 아직 계약을 내놓지 못한다
    service.down = true;
    expect(await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).toEqual({});
    await expect(readFile(recordFile, 'utf8')).rejects.toThrow();
    service.down = false;
    // 이 실행은 그대로 돈다(게이트가 읽은 것으로). 통과하면 그 검증이 본 계약이 새 체크포인트의 기록이 된다
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    const head = getSnapshot(session.id)!.checkpoints[0]!.sha;
    expect(await readFile(path.join(session.work, '.git/b-studio/contracts', `${head}.json`), 'utf8')).toContain('memo');
    await expect(readFile(recordFile, 'utf8')).rejects.toThrow();
    await stopSession(session.id);
  }, 30_000);

  it('서비스를 다시 띄우지 못했거나 계약을 읽는 동안 작업 복사본이 바뀌었으면 기록으로 남기지 않는다', async () => {
    const failing = await open();
    const recordOf = (session: Opened) => path.join(session.work, '.git/b-studio/contracts', `${getSnapshot(session.id)!.checkpoints[0]!.sha}.json`);
    await failing.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    fake.restartFails = true;
    const record = recordOf(failing);
    await write(failing, 'api/src/Order.java', 'class Order { String memo; }\n');
    // 서비스가 이 체크포인트의 코드로 떴다는 것을 확인하지 못했다
    await expect(readFile(record, 'utf8')).rejects.toThrow();
    fake.restartFails = false;
    await stopSession(failing.id);

    const racing = await open();
    await racing.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const racingRecord = recordOf(racing);
    // 계약을 읽는 바로 그때 뒤에서 파일이 바뀐다: 읽은 계약이 체크포인트의 코드와 맞는지 알 수 없다
    service.onFetch = () => {
      service.onFetch = undefined;
      writeFileSync(path.join(racing.work, 'api/src/Sneaked.java'), 'class Sneaked {}\n');
    };
    await write(racing, 'api/src/Order.java', 'class Order { String memo; }\n');
    await expect(readFile(racingRecord, 'utf8')).rejects.toThrow();
    await stopSession(racing.id);
  }, 60_000);

  it('파일을 되돌려 놓았을 뿐 서비스는 고친 코드로 떠 있어도, 그 서비스의 계약을 기준으로 삼지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: 'memo를 빼줘' });
    await write(session, 'api/src/Order.java', 'class Order { /* memo 없음 */ }\n');
    service.doc = contractWith(['id']);
    await session.gateway.stop({});
    await session.gateway.stop({});
    await session.gateway.stop({});
    // 파일을 원래대로 돌려놓는다. 작업 복사본은 체크포인트 그대로지만 서비스는 여전히 고친 코드로 떠 있다(계약에 memo가 없다)
    await edit(session, 'api/src/Order.java', 'class Order {}\n');
    expect(await git(session, 'status', '--porcelain')).toBe('');

    // 새 실행이 같은 변경을 다시 한다. 지금 서비스의 계약을 다시 읽었다면 "원래 없던 필드"가 되어 통과했을 것이다
    await session.gateway.prompt({ prompt: '다시 memo를 빼줘' });
    await write(session, 'api/src/Order.java', 'class Order { /* memo 없음 */ }\n');
    expect((await session.gateway.stop({})).feedback).toContain('memo');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    await stopSession(session.id);
  }, 60_000);

  it('검증을 통과한 체크포인트가 하나도 없는데 변경이 먼저 있으면, 지금 계약이 기준이 된다는 것을 실행에 알린다', async () => {
    const session = await open();
    // 어떤 실행보다 먼저 파일이 바뀌어 있다(사람이 셸에서 고쳤다)
    await edit(session, 'api/src/Order.java', 'class Order { /* memo 없음 */ }\n');
    service.doc = contractWith(['id']);
    await session.gateway.prompt({ prompt: '정리해줘' });
    const answer = await session.gateway.stop({ last_assistant_message: '정리했습니다.' });
    const warnings = session.ofType('agent').flatMap((event) => (event.event.type === 'warning' ? [event.event.message] : []));
    expect(warnings.some((message) => message.includes('API 계약 기록이 없어'))).toBe(true);
    // 남긴 한계: 이 경우는 통과한다. 조용히 지나가지 않고 알린 것을 확인한다
    expect(answer.message).toContain('검증 통과');
    await stopSession(session.id);
  }, 30_000);

  it('앞 실행이 남긴 비밀 파일과 링크는 다음 실행에서도 통과시키지 않는다("원래 있던 것"으로 봐주지 않는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '설정 파일 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await edit(session, '.env', 'API_KEY=secret\n');
    await symlink('/etc/hosts', path.join(session.work, 'api/src/hosts'));
    await session.gateway.stop({});
    await session.gateway.stop({});
    expect((await session.gateway.stop({})).message).toContain('체크포인트를 남기지 않았습니다');

    await session.gateway.prompt({ prompt: '이어서' });
    fake.execCalls = [];
    const answer = await session.gateway.stop({ last_assistant_message: '끝냈습니다.' });
    // 게이트를 돌리기 전에 막는다(커밋 전 대조에 기대지 않는다)
    expect(answer.feedback).toContain('게이트가 검증할 수 없는 경로');
    expect(answer.feedback).toContain('.env');
    expect(answer.feedback).toContain('api/src/hosts');
    expect(fake.execCalls).toEqual([]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await git(session, 'log', '--oneline', '--', '.env', 'api/src/hosts')).toBe('');
    await stopSession(session.id);
  }, 30_000);

  it('훅보다 먼저 생긴 다루지 못하는 경로도 통과시키지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    // 쓰기 직전의 훅이 처음 불리기 전에 이미 있다(사람이 셸에서 만들었거나, 훅이 닿지 못한 사이에 생겼다)
    await edit(session, '.env', 'API_KEY=secret\n');
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('게이트가 검증할 수 없는 경로');
    expect(answer.feedback).toContain('.env');
    expect(fake.execCalls).toEqual([]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    await stopSession(session.id);
  }, 30_000);
});

describe('체크포인트에는 검증한 내용만 들어간다 (검증과 커밋 사이)', () => {
  it('게이트가 통과시킨 뒤 커밋되기 전에 내용이 바뀌면 체크포인트를 남기지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    // 게이트가 통과시키고 체크포인트를 남기려는 바로 그 순간에, 뒤에서 돌던 명령이 파일을 바꾼다
    let swapped = false;
    subscribe(session.id, (event) => {
      if (swapped || event.type !== 'agent' || event.event.type !== 'stage' || event.event.stage !== 'checkpoint') return;
      swapped = true;
      writeFileSync(path.join(session.work, 'api/src/Order.java'), 'class Order { String memo; /* 검증하지 않은 줄 */ }\n');
    });
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(swapped).toBe(true);
    expect(answer.feedback).toContain('검증하는 동안 바뀐 파일이 있어 통과로 인정하지 않았습니다');
    expect(answer.feedback).toContain('api/src/Order.java');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await git(session, 'log', '--oneline', '-S', '검증하지 않은 줄')).toBe('');
    // 스테이징도 남기지 않았고 실행은 열려 있다
    expect(await git(session, 'diff', '--cached', '--name-only')).toBe('');
    expect(getSnapshot(session.id)!.running).toBe(true);
    expect(session.ofType('run_finished')).toEqual([]);

    // 다음 턴의 끝에서 바뀐 내용을 다시 검증하고, 그 내용으로 체크포인트를 남긴다
    expect((await session.gateway.stop({ last_assistant_message: '끝냈습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(await git(session, 'show', 'HEAD:api/src/Order.java')).toContain('검증하지 않은 줄');
    await stopSession(session.id);
  }, 30_000);

  it('통과시킨 뒤에 새로 생긴 파일도 같다. 검증에 없던 파일은 체크포인트에 실리지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    let added = false;
    subscribe(session.id, (event) => {
      if (added || event.type !== 'agent' || event.event.type !== 'stage' || event.event.stage !== 'checkpoint') return;
      added = true;
      writeFileSync(path.join(session.work, 'api/src/Sneaked.java'), 'class Sneaked {}\n');
    });
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('api/src/Sneaked.java');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    await stopSession(session.id);
  }, 30_000);

  it('게이트가 도는 동안 파일이 바뀌어도 통과로 인정하지 않는다. 계속 바뀌면 실패로 끝낸다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    fake.holdWord = 'test';
    for (let round = 1; round <= 3; round++) {
      let release = (): void => {};
      fake.hold = new Promise<void>((resolve) => (release = resolve));
      const calls = fake.execCalls.length;
      const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
      while (fake.execCalls.length === calls) await new Promise((resolve) => setTimeout(resolve, 10));
      // 선언한 테스트가 도는 동안 파일이 바뀐다
      await edit(session, 'api/src/Order.java', `class Order { String memo; /* ${round} */ }\n`);
      release();
      const answer = await stopping;
      if (round < 3) expect(answer.feedback).toContain('검증하는 동안 바뀐 파일');
      else expect(answer.message).toContain('검증하는 동안 파일이 계속 바뀌어 통과시키지 않았습니다');
    }
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
    await stopSession(session.id);
  }, 30_000);
});

describe('요청의 경계', () => {
  it('앞 요청이 끝나기 전에 다시 말하면(도중에 끊고 고쳐 말한 경우) 같은 실행에 잇는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.prompt({ prompt: '아니, note라는 이름으로' });
    expect(session.ofType('run_started')).toHaveLength(1);
    expect(session.ofType('terminal_prompt')).toMatchObject([{ runId: session.ofType('run_started')[0]!.runId, text: '아니, note라는 이름으로' }]);
    await write(session, 'api/src/Order.java', 'class Order { String note; }\n');
    await session.gateway.stop({ last_assistant_message: 'note로 바꿨습니다.' });
    // 제목은 실행을 연 첫 요청에서 나온다
    expect(getSnapshot(session.id)!.checkpoints[0]!.message).toBe('feat: 주문에 메모 필드 추가');
    await stopSession(session.id);
  }, 30_000);

  it('앞 실행의 검증이 도는 동안 보낸 요청은 그 실행에 이어 붙고, 그 뒤에 시작된 작업은 그 요청의 이름으로 새 실행이 된다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    let release = (): void => {};
    fake.holdWord = 'test';
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    while (!fake.execCalls.some((command) => command.includes('test'))) await new Promise((resolve) => setTimeout(resolve, 10));
    // CLI는 검증을 기다리는 동안 친 요청을 받아 두었다가, 검증이 끝나면 처리한다
    expect(await session.gateway.prompt({ prompt: 'note 필드도 더해줘' })).toEqual({});
    release();
    expect((await stopping).message).toContain('검증 통과 — 체크포인트');
    fake.holdWord = undefined;

    await write(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    expect(session.ofType('run_started').map((event) => event.request)).toEqual(['주문에 메모 필드 추가', 'note 필드도 더해줘']);
    expect((await session.gateway.stop({ last_assistant_message: '더했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints[0]!.message).toBe('feat: note 필드도 더한다');
    await stopSession(session.id);
  }, 30_000);

  it('"/"로 시작하는 명령은 실행을 열지 않는다. 작업이 실제로 시작되면 그 이름으로 연다', async () => {
    const session = await open();
    expect(await session.gateway.prompt({ prompt: '/model' })).toEqual({});
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(await session.gateway.stop({})).toEqual({});
    expect(session.ofType('run_started')).toEqual([]);

    await session.gateway.prompt({ prompt: '/fix-order 메모 필드' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(session.ofType('run_started')).toMatchObject([{ request: '/fix-order 메모 필드', via: 'terminal' }]);
    expect((await session.gateway.stop({ last_assistant_message: '끝' })).message).toContain('체크포인트');
    await stopSession(session.id);
  }, 30_000);

  it('요청의 시작을 알리는 훅 없이 시작된 작업도 실행으로 잡는다(게이트 밖에서 체크포인트가 생기는 길이 없다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(session.ofType('run_started')).toMatchObject([{ request: '터미널에서 이어진 작업', via: 'terminal' }]);
    fake.failCommands = ['test'];
    expect((await session.gateway.stop({})).feedback).toContain('[b-studio 검증 게이트]');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    await stopSession(session.id);
  }, 30_000);

  it('CLI가 끝나면 열려 있던 실행을 닫는다. 검증에 막힌 채 끝났으면 그 사유로 실패를 남긴다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '첫 요청' });
    await session.gateway.sessionEnd({ reason: 'prompt_input_exit' });
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'cancelled' });
    expect(getSnapshot(session.id)!.running).toBe(false);

    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo }\n');
    fake.failCommands = ['test'];
    await session.gateway.stop({});
    await session.gateway.sessionEnd({ reason: 'other' });
    const finished = session.ofType('run_finished')[1]!;
    expect(finished.status).toBe('failed');
    expect(finished.summary).toContain('검증을 통과하지 못한 채 CLI가 끝났습니다');
    expect(finished.summary).toContain('unit');
    // 닫힌 뒤의 종료 알림은 아무 일도 하지 않는다
    await session.gateway.sessionEnd({});
    expect(session.ofType('run_finished')).toHaveLength(2);
    await stopSession(session.id);
  }, 30_000);

  it('긴 요청 글과 큰 도구 입력은 줄여서 기록한다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: 'x'.repeat(20_000) });
    expect(session.ofType('run_started')[0]!.request.length).toBeLessThan(8_100);
    await session.gateway.preTool({ tool_name: 'Write', tool_input: { file_path: '/workspace/a.txt', content: 'y'.repeat(50_000) } });
    const call = session.ofType('agent').find((event) => event.event.type === 'tool_call')!;
    expect(JSON.stringify(call).length).toBeLessThan(3_000);
    expect(call.event).toMatchObject({ type: 'tool_call', name: 'Write', input: { file_path: '/workspace/a.txt' } });
    await stopSession(session.id);
  }, 30_000);
});

describe('b-studio 도구와 세션의 수명', () => {
  it('도구 호출은 서비스 컨테이너에서 돌고 대화 기록에 남는다. 실행이 없으면 실행을 연다', async () => {
    const session = await open();
    const outcome = await session.gateway.runTool('run_in_service', { service: 'api', command: ['./gradlew', 'build'] });
    expect(outcome.ok).toBe(true);
    expect(fake.execCalls).toEqual([['./gradlew', 'build']]);
    expect(session.ofType('run_started')).toHaveLength(1);
    const agent = session.ofType('agent').map((event) => event.event.type);
    expect(agent).toContain('tool_call');
    expect(agent).toContain('tool_result');
    // 내주는 도구는 샌드박스가 있어야 도는 것뿐이다. 파일 도구는 CLI의 것을 쓴다
    const names = session.gateway.toolSpecs().map((spec) => spec.name);
    expect(names).toContain('run_in_service');
    expect(names).not.toContain('write_file');
    expect(await session.gateway.note()).toContain('mcp__b-studio__run_in_service');
    // 내주지 않은 도구는 이 길로 불러도 돌지 않는다(파일 도구가 불리면 변경 추적과 쓰기 직전의 훅을 건너뛴다)
    const refused = await session.gateway.runTool('write_file', { path: 'api/src/Order.java', content: 'class Hacked {}\n' });
    expect(refused).toEqual({ ok: false, content: '[b-studio] write_file: 터미널에 내주지 않는 도구입니다' });
    expect(await readFile(path.join(session.work, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');
    await stopSession(session.id);
  }, 30_000);

  it('세션을 멈추면 훅을 받지 않는다. 열려 있던 실행은 체크포인트 없이 끝난다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await stopSession(session.id);
    await expect(session.gateway.stop({ last_assistant_message: '끝' })).rejects.toThrow('멈춘 세션입니다');
    await expect(session.gateway.prompt({ prompt: '또' })).rejects.toThrow('멈춘 세션입니다');
    expect((await session.gateway.runTool('run_in_service', { service: 'api', command: ['ls'] })).ok).toBe(false);
    expect(sessionHistory(session.id).filter((event) => event.type === 'checkpoint')).toHaveLength(0);
    expect(getSnapshot(session.id)?.checkpoints.length ?? before).toBe(before);
  }, 30_000);

  it('실험 기능을 끄면 훅을 받지 않는다(관문은 세션 터미널과 같은 자리에서만 연다)', async () => {
    const session = await open();
    delete process.env.B_STUDIO_EXPERIMENTAL;
    await expect(session.gateway.prompt({ prompt: '요청' })).rejects.toThrow('실험 기능을 켠 개인 PC 모드에서만');
    process.env.B_STUDIO_AUTH = 'proxy';
    process.env.B_STUDIO_EXPERIMENTAL = '1';
    await expect(session.gateway.stop({})).rejects.toThrow('실험 기능을 켠 개인 PC 모드에서만');
    process.env.B_STUDIO_AUTH = 'none';
    await stopSession(session.id);
  }, 30_000);
});
