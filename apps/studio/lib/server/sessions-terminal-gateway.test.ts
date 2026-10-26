import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  /** 켜면 서비스 재시작이 샌드박스 쪽 문제로 실패한다. 'code'는 코드가 원인일 수 있는 실패(서비스가 준비되지 않음, #943) */
  startFails: false as boolean | 'code',
  starts: 0,
  /** 서비스를 다시 띄운 횟수 */
  restarts: 0,
  /** 서비스를 다시 띄우지 못하게 한다. 'platform'은 샌드박스·도커 쪽 문제(바꾼 코드의 탓이 아니다) */
  restartFails: false as false | 'platform',
  interrupts: [] as string[],
  /** 화면에 알린 "에이전트 CLI가 떠 있는가"의 기록 */
  cli: [] as boolean[],
  /** 터미널 패널로 보낸 경고 줄(#B5) */
  warnings: [] as string[],
  /** holdWord가 든 명령은 hold가 풀릴 때까지 끝나지 않는다(실행이나 검증을 열어 둔 채로 두는 데 쓴다) */
  holdWord: undefined as string | undefined,
  hold: undefined as Promise<void> | undefined,
  /** 서비스가 떠 있는 주소. 테스트마다 계약을 내놓는 작은 서버를 띄운다 */
  serviceUrl: 'http://127.0.0.1:1',
  /** 세션 터미널 방식. 'host'(이 컴퓨터 방식)면 작업 복사본의 Git을 더 의심한다(이슈 #706) */
  terminalMode: 'container' as 'container' | 'host',
  /** 검사 동안 멈춘 컨테이너와 다시 움직인 컨테이너의 샌드박스 id(이슈 #765) */
  pauses: [] as string[],
  unpauses: [] as string[],
  pauseAttempts: 0,
  /** 값이 있으면 pause가 그 사유로 실패한다 */
  pauseFails: undefined as string | undefined,
  /** 값이 있으면 unpause가 그 사유로 실패한다 */
  unpauseFails: undefined as string | undefined,
  /** 게이트가 도는 동안(멈춘 채) 서비스 안 명령이 돈 횟수 */
  execsWhilePaused: 0,
  /** 남은 횟수만큼 시크릿 검사가 던진다(게이트를 예외로 끝내는 데 쓴다) */
  findSecretsFailures: 0,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-termgw-fake',
    name: 'fake',
    async start() {
      fake.starts += 1;
      if (fake.startFails === 'code') throw new actual.SandboxError('서비스가 준비되지 않았습니다', 'readiness GET /health → 404');
      if (fake.startFails) throw new actual.SandboxError('도커에 닿지 못했습니다', 'Cannot connect to the Docker daemon', { platform: true });
      return [];
    },
    async restart(service: string) {
      fake.restarts += 1;
      if (fake.restartFails === 'platform') throw new actual.SandboxError('도커에 닿지 못했습니다', 'Cannot connect to the Docker daemon', { platform: true });
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
      // 게이트가 테스트 전에 보고서 자리를 비우는 명령(#756)은 테스트 명령으로 세지 않는다
      if (command[0] === 'sh' && command[2]?.startsWith('rm -f /tmp/b-studio-test-report.json ')) return { exitCode: 0, stdout: '', stderr: '' };
      if (fake.pauses.length > fake.unpauses.length) fake.execsWhilePaused += 1;
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
    findSecrets: () => {
      if (fake.findSecretsFailures > 0) {
        fake.findSecretsFailures -= 1;
        throw new Error('시크릿 검사 오류');
      }
      return [];
    },
    async callExternal() {
      return { decision: 'deny' as const, status: 404, body: '', masked: 0 };
    },
    async destroy() {},
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({ findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root) }));
// codex 백엔드 세션(#825)은 만들 때 실제 CLI 로그인을 확인한다. 여기서는 CLI를 부르지 않고 통과시킨다
vi.mock('@b-studio/agent', async (importOriginal) => ({ ...(await importOriginal<typeof import('@b-studio/agent')>()), preflightCodex: async () => ({ ok: true as const }) }));
vi.mock('./session-terminal', () => ({
  disposeSessionTerminal: async () => {},
  interruptSessionTerminal: (sessionId: string) => {
    fake.interrupts.push(sessionId);
  },
  noteSessionTerminalCli: (_sessionId: string, alive: boolean) => {
    fake.cli.push(alive);
  },
  sessionTerminalMode: () => fake.terminalMode,
  warnSessionTerminal: (_sessionId: string, message: string) => {
    fake.warnings.push(message);
  },
  terminalPause: () =>
    fake.terminalMode === 'container'
      ? {
          pause: async (sandboxId: string) => {
            fake.pauseAttempts += 1;
            if (fake.pauseFails) throw new Error(fake.pauseFails);
            fake.pauses.push(sandboxId);
          },
          unpause: async (sandboxId: string) => {
            if (fake.unpauseFails) throw new Error(fake.unpauseFails);
            fake.unpauses.push(sandboxId);
          },
        }
      : undefined,
}));

import { sessionFile, stateDirOf } from './session-store';
import { agentRows, restoreAgentLedger } from './terminal-agents';
import { cancelRun, createSession, getSnapshot, setTerminalCheckChanges, rememberedGitForTest, restoreCheckpoint, resumeSession, sendMessage, sessionCapabilities, sessionHistory, sessionTerminalActivity, sessionTerminalAgents, sessionTerminalTarget, setGitMemoryForTest, setTerminalTaskContext, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

/** 게이트를 도는 기본 프로젝트. maxTurns를 주면 턴 상한 테스트가 쓴다(#B5) */
function studioYaml(maxTurns?: number): string {
  return `version: 1
name: termgw
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]${maxTurns !== undefined ? `\n  maxTurns: ${maxTurns}` : ''}
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
`;
}

/** unit 테스트는 그대로 두고 테스트 하나를 더한 studio.yaml. 다시 읽기가 실제로 새 값을 집어오는지 보려고 쓴다(수정 1) */
function studioYamlWithExtraTest(name: string, command: string): string {
  return `version: 1
name: termgw
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
    - name: ${name}
      service: api
      command: [${command}]
`;
}

/** unit 테스트를 다른 테스트 하나로 바꾼 studio.yaml. 사용자가 선언한 테스트를 지우는 경우를 볼 때 쓴다 */
function studioYamlWithoutUnitTest(name: string): string {
  return `version: 1
name: termgw
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: ${name}
      service: api
      command: [echo, ${name}]
`;
}

/** required에서 test를 뺀 studio.yaml. 카드 완료 검사가 test를 도로 끼워 넣어 약화 판정을 가리는지 본다(수정 2) */
function studioYamlWithoutRequiredTest(): string {
  return `version: 1
name: termgw
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
`;
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termgw-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), studioYaml());
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = project;
  fake.execCalls = [];
  fake.failCommands = [];
  fake.startFails = false;
  fake.starts = 0;
  fake.restarts = 0;
  fake.restartFails = false;
  fake.cli = [];
  fake.warnings = [];
  fake.interrupts = [];
  fake.holdWord = undefined;
  fake.hold = undefined;
  fake.terminalMode = 'container';
  fake.pauses = [];
  fake.unpauses = [];
  fake.pauseAttempts = 0;
  fake.pauseFails = undefined;
  fake.unpauseFails = undefined;
  fake.execsWhilePaused = 0;
  fake.findSecretsFailures = 0;
  await serveContract();
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_EXPERIMENTAL = '1';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  // 사람별 토큰 사용량을 이 테스트의 임시 폴더에만 쓴다(실제 ~/.cache를 건드리지 않는다)
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
  /** 세션의 작업 복사본. 컨테이너 안의 CLI가 /workspace로 보는 폴더다 */
  work: string;
  gateway: ReturnType<typeof terminalGatewayHandlersForTest>;
  events: StudioEvent[];
  ofType<T extends StudioEvent['type']>(type: T): Array<Extract<StudioEvent, { type: T }>>;
}

async function open({ lazy = false, workspace = 'copy', backend }: { lazy?: boolean; workspace?: 'copy' | 'local'; backend?: 'codex' } = {}): Promise<Opened> {
  // lazy: 사람이 만든 일반 세션처럼 샌드박스를 필요할 때 켠다(개인 PC 모드의 기본)
  const id = (await createSession('termgw', 'kim', workspace, { ...(lazy ? { boot: 'on-demand' as const } : {}), ...(backend ? { backend } : {}) })).id;
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

/** 실행이 닫혔다는 알림이 count개 올 때까지 기다린다(화면의 취소처럼 답을 기다리지 않는 길에서 쓴다) */
async function finishedRuns(session: Opened, count: number): Promise<Array<Extract<StudioEvent, { type: 'run_finished' }>>> {
  const started = Date.now();
  while (session.ofType('run_finished').length < count) {
    if (Date.now() - started > 10_000) throw new Error(`실행이 닫히지 않았습니다 (${session.ofType('run_finished').length}/${count})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return session.ofType('run_finished');
}
const ORIGINAL = 'class Order {}\n';
const fileOf = (session: Opened, file = 'api/src/Order.java') => readFile(path.join(session.work, file), 'utf8');

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

  it('재시도 상한까지 통과하지 못하면 실패로 끝내고, 대화 창의 요청처럼 이번 실행의 변경을 되돌린다(보관본은 남는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo }\n');
    await edit(session, 'api/src/Extra.java', 'class Extra {}\n');
    fake.failCommands = ['test'];
    expect((await session.gateway.stop({})).feedback).toBeDefined();
    expect((await session.gateway.stop({})).feedback).toBeDefined();
    const last = await session.gateway.stop({ last_assistant_message: '더는 못 고치겠습니다.' });
    // 상한을 다 쓰면 더 막지 않는다(막으면 CLI가 끝나지 않는다). 실패로 닫고 되돌린다
    expect(last.feedback).toBeUndefined();
    expect(last.message).toContain('검증 게이트를 3번 통과하지 못했습니다');
    expect(last.message).toContain('바뀐 파일 2개를 되돌렸습니다');

    const snapshot = getSnapshot(session.id)!;
    expect(snapshot.checkpoints).toHaveLength(before);
    expect(snapshot.running).toBe(false);
    const finished = session.ofType('run_finished')[0]!;
    expect(finished.status).toBe('failed');
    expect(finished.summary).toContain('검증 게이트를 3번 통과하지 못했습니다');
    // 작업 복사본은 마지막 체크포인트 그대로다. 새로 만든 파일도 없다
    expect(await fileOf(session)).toBe(ORIGINAL);
    await expect(fileOf(session, 'api/src/Extra.java')).rejects.toThrow();
    expect(await git(session, 'status', '--porcelain')).toBe('');
    // 되돌린 것은 보관본으로 남아 화면에서 되살릴 수 있다
    const reverted = session.ofType('reverted');
    expect(reverted).toHaveLength(1);
    expect(reverted[0]!.files.sort()).toEqual(['api/src/Extra.java', 'api/src/Order.java']);
    expect(reverted[0]!.backup).toBeDefined();

    // CLI는 파일이 되돌려진 것을 모른다. 다음 요청의 맥락에 한 번 알린다
    fake.failCommands = [];
    const next = await session.gateway.prompt({ prompt: '다시 해줘' });
    expect(next.note).toContain('되돌렸습니다');
    expect(next.note).toContain('api/src/Order.java');
    expect(next.note).toContain('다시 읽으세요');
    await session.gateway.stop({ last_assistant_message: '네' });
    expect((await session.gateway.prompt({ prompt: '또' })).note).toBeUndefined();
    await session.gateway.stop({ last_assistant_message: '네' });
    await stopSession(session.id);
  }, 30_000);

  it('샌드박스·도커 쪽 문제로 검증하지 못한 실행은 되돌리지 않는다(바꾼 코드의 문제가 아니다). 체크포인트도 남기지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    fake.restartFails = 'platform';
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toBeUndefined();
    expect(answer.message).toContain('b-studio 쪽(샌드박스·도커) 문제');
    expect(await fileOf(session)).toBe('class Order { String memo; }\n');
    expect(session.ofType('reverted')).toEqual([]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
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

  it('화면에서 취소하면 CLI에 멈추라고 알리고, 대화 창의 취소처럼 이번 실행의 변경을 되돌린다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const runId = session.ofType('run_started')[0]!.runId;

    // 되돌린 직후, 실행이 닫혔다는 알림이 나가기 전의 순간에 대화 창에서 요청을 보내 본다
    const duringRevert: string[] = [];
    subscribe(session.id, (event) => {
      if (event.type !== 'reverted') return;
      try {
        sendMessage(session.id, '끼어드는 요청', { allowBreaking: false, scriptedTurns: [{ text: '네' }] });
        duringRevert.push('받았다');
      } catch (error) {
        duringRevert.push(error instanceof Error ? error.message : String(error));
      }
    });

    cancelRun(session.id, runId);
    expect(fake.interrupts).toEqual([session.id]);
    // 되돌리는 동안에는 실행이 걸려 있어 다른 요청이 끼어들지 못한다
    expect(() => sendMessage(session.id, '다른 요청', { allowBreaking: false })).toThrow('이전 요청을 처리하는 중입니다');
    expect((await session.gateway.prompt({ prompt: '끼어드는 요청' })).blocked).toContain('앞선 요청을 처리하는 중입니다');
    const [finished] = await finishedRuns(session, 1);
    expect(finished).toMatchObject({ runId, status: 'cancelled', summary: '요청을 취소하고 바뀐 파일 1개를 되돌렸습니다' });
    expect(duringRevert).toEqual(['이전 요청을 처리하는 중입니다']);
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await fileOf(session)).toBe(ORIGINAL);
    expect(session.ofType('reverted')).toMatchObject([{ runId, cancelled: true, files: ['api/src/Order.java'] }]);
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
    expect(answer.message).toContain('요청을 취소하고 바뀐 파일 1개를 되돌렸습니다');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'cancelled' }]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 테스트는 통과했지만(가짜는 0으로 끝난다) 취소한 실행은 체크포인트가 되지 않고 되돌려진다
    expect(await fileOf(session)).toBe(ORIGINAL);
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

describe('샌드박스를 켜지 못한 세션도 살아 있는 CLI에 답할 수 있다 (#943)', () => {
  it('켜지 못한(failed) 세션의 터미널은 열린 채로 입력을 받고, 그 사이 위반도 버리지 않는다', async () => {
    const session = await open({ lazy: true });
    fake.startFails = true;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    expect((await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).deny).toBeDefined();
    expect(getSnapshot(session.id)!.status).toBe('failed');

    // CLI는 살아서 사람을 기다린다. 터미널을 막으면 권한 창에 답할 길이 없다
    const target = sessionTerminalTarget(session.id);
    expect(target.alive()).toBe(true);
    // 켜지 못한 세션에서도 관문 위반은 기록한다(멈춘 세션처럼 버리지 않는다)
    target.onViolation('관문 파일이 바뀌어 되돌렸습니다: settings.json');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.ofType('agent').some((event) => event.event.type === 'warning' && JSON.stringify(event.event).includes('settings.json'))).toBe(true);
    fake.startFails = false;
    await stopSession(session.id);
  }, 30_000);

  it('검증하려는데 샌드박스를 켜지 못해 끝난 실행은 플랫폼 실패로 남고 변경은 되돌리지 않는다', async () => {
    const session = await open({ lazy: true });
    const before = getSnapshot(session.id)!.checkpoints.length;
    fake.startFails = true;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    // 훅을 거치지 않은 셸 변경(관문이 막지 못한 것)이 남은 채 턴이 끝난다
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    const finished = session.ofType('run_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ platformFailure: expect.stringContaining('도커에 닿지 못했습니다') });
    // 체크포인트는 남지 않는다(검증하지 못한 변경은 나가지 않는다). 변경은 작업 복사본에 남아 다음 요청의 게이트가 본다
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await readFile(path.join(session.work, 'api/src/Order.java'), 'utf8')).toContain('memo');
    fake.startFails = false;
    await stopSession(session.id);
  }, 30_000);

  it('코드가 원인일 수 있는 실패(서비스가 준비되지 않음)로 켜지 못했으면 플랫폼 실패로 세지 않는다', async () => {
    const session = await open({ lazy: true });
    fake.startFails = 'code';
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    const finished = session.ofType('run_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'error' });
    expect(finished[0]).not.toHaveProperty('platformFailure');
    fake.startFails = false;
    await stopSession(session.id);
  }, 30_000);
});

describe('통과하지 못한 실행의 변경은 남지 않는다 (다음 실행은 체크포인트 그대로에서 시작한다)', () => {
  it('계약을 깨는 변경은 실행을 바꿔도 통과하지 못한다. 실패한 실행의 변경이 다음 실행의 기준에 섞이지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    const breakIt = async () => {
      await write(session, 'api/src/Order.java', 'class Order { /* memo 없음 */ }\n');
      // 고친 코드로 서비스가 다시 뜨면 계약에서 필드가 사라진다
      service.doc = contractWith(['id']);
    };
    await session.gateway.prompt({ prompt: '주문 응답에서 memo를 빼줘' });
    await breakIt();
    expect((await session.gateway.stop({ last_assistant_message: 'memo를 뺐습니다.' })).feedback).toContain('memo');
    await session.gateway.stop({});
    expect((await session.gateway.stop({})).message).toContain('되돌렸습니다');
    expect(await fileOf(session)).toBe(ORIGINAL);
    // 되돌린 코드로 서비스가 다시 뜬다(계약도 원래대로)
    service.doc = contractWith(['id', 'memo']);

    // 새 실행이 같은 변경을 다시 해도, 화면에서 닫고 다시 해도 같다: 매번 체크포인트 그대로에서 시작하므로 매번 깨는 변경으로 잡힌다
    await session.gateway.prompt({ prompt: '다시 memo를 빼줘' });
    await breakIt();
    expect((await session.gateway.stop({})).feedback).toContain('memo');
    cancelRun(session.id, session.ofType('run_started')[1]!.runId);
    await finishedRuns(session, 2);
    expect(await fileOf(session)).toBe(ORIGINAL);
    service.doc = contractWith(['id', 'memo']);

    await session.gateway.prompt({ prompt: '또 memo를 빼줘' });
    await breakIt();
    expect((await session.gateway.stop({})).feedback).toContain('memo');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);

    // 계약을 깨지 않는 변경은 통과한다
    await write(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    service.doc = contractWith(['id', 'memo', 'note']);
    expect((await session.gateway.stop({ last_assistant_message: 'note를 더했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    await stopSession(session.id);
  }, 60_000);

  it('터미널에서 막힌 변경은 대화 창의 요청으로 넘어가지 않는다(남아 있지 않다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문 응답에서 memo를 빼줘' });
    await write(session, 'api/src/Order.java', 'class Order { /* memo 없음 */ }\n');
    service.doc = contractWith(['id']);
    await session.gateway.stop({});
    await session.gateway.stop({});
    await session.gateway.stop({});
    service.doc = contractWith(['id', 'memo']);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);

    // 대화 창에서 아무 요청이나 보낸다. 남은 변경이 있었다면 "실행 전부터 있던 변경"으로 게이트에 들어가 체크포인트가 됐을 것이다
    const finished = new Promise<Extract<StudioEvent, { type: 'run_finished' }>>((resolve) => subscribe(session.id, (event) => event.type === 'run_finished' && event.runId !== session.ofType('run_started')[0]!.runId && resolve(event)));
    sendMessage(session.id, '마무리해줘', { allowBreaking: false, scriptedTurns: [{ text: '마무리했습니다.' }] });
    expect((await finished).status).toBe('done');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await git(session, 'log', '--oneline', '-S', 'memo 없음')).toBe('');
    await stopSession(session.id);
  }, 60_000);

  it('실패한 실행이 만든 비밀 파일과 링크도 남지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '설정 파일 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await edit(session, '.env', 'API_KEY=secret\n');
    await symlink('/etc/hosts', path.join(session.work, 'api/src/hosts'));
    expect((await session.gateway.stop({})).feedback).toContain('게이트가 검증할 수 없는 경로');
    await session.gateway.stop({});
    expect((await session.gateway.stop({})).message).toContain('되돌렸습니다');
    await expect(fileOf(session, '.env')).rejects.toThrow();
    await expect(fileOf(session, 'api/src/hosts')).rejects.toThrow();

    await session.gateway.prompt({ prompt: '메모 필드만 추가해줘' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(getSnapshot(session.id)!.checkpoints[0]!.files).toEqual(['api/src/Order.java']);
    await stopSession(session.id);
  }, 30_000);

  it('실행보다 먼저 있던 다루지 못하는 경로도 봐주지 않는다(체크포인트에 실리게 두지 않는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    // 쓰기 직전의 훅이 처음 불리기 전에 이미 있다(사람이 셸에서 만들었다)
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
    // 통과하지 못한 채 끝났으니 되돌린다
    expect(await fileOf(session)).toBe(ORIGINAL);
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

  it('CLI가 끝나면 열려 있던 실행을 닫고 변경을 되돌린다. 검증에 막힌 채 끝났으면 그 사유로 실패를 남긴다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '첫 요청' });
    await write(session, 'api/src/Order.java', 'class Order { String half; }\n');
    await session.gateway.sessionEnd({ reason: 'prompt_input_exit' });
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'cancelled' });
    expect(session.ofType('run_finished')[0]!.summary).toContain('CLI가 끝나 요청을 닫았습니다');
    expect(session.ofType('run_finished')[0]!.summary).toContain('바뀐 파일 1개를 되돌렸습니다');
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(await fileOf(session)).toBe(ORIGINAL);

    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo }\n');
    fake.failCommands = ['test'];
    await session.gateway.stop({});
    await session.gateway.sessionEnd({ reason: 'other' });
    const finished = session.ofType('run_finished')[1]!;
    expect(finished.status).toBe('failed');
    expect(finished.summary).toContain('검증을 통과하지 못한 채 CLI가 끝났습니다');
    expect(finished.summary).toContain('unit');
    expect(await fileOf(session)).toBe(ORIGINAL);
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

describe('읽기만 요청은 훅으로 막는다 (이슈 #689)', () => {
  it('표시로 시작하는 요청에서는 파일을 바꾸거나 명령을 돌리는 도구를 모두 거절한다. 샌드박스도 켜지 않는다', async () => {
    const session = await open({ lazy: true });
    const answer = await session.gateway.prompt({ prompt: '[읽기만] Order가 어디서 쓰이는지 알려줘' });
    // 에이전트가 헛돌지 않게 미리 알린다
    expect(answer.note).toContain('읽기만');
    for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit', 'mcp__b-studio__run_in_service']) {
      const denied = await session.gateway.preTool({ tool_name: tool, tool_input: { file_path: '/workspace/api/src/Order.java', content: 'class Hacked {}\n', command: 'rm -rf .' } });
      expect(denied.deny, tool).toContain('읽기만 요청');
    }
    // 훅을 거치지 않고 도구 서버로 바로 불려도 돌지 않는다
    expect(await session.gateway.runTool('run_in_service', { service: 'api', command: ['sh', '-c', 'echo hi > api/src/x'] })).toMatchObject({ ok: false, content: expect.stringContaining('읽기만 요청') });
    expect(fake.execCalls).toEqual([]);
    expect(getSnapshot(session.id)!.status).toBe('idle');
    // 읽기 도구는 그대로 쓴다
    expect(await session.gateway.preTool({ tool_name: 'Read', tool_input: { file_path: '/workspace/api/src/Order.java' } })).toEqual({});
    expect(await fileOf(session)).toBe(ORIGINAL);
    expect(await session.gateway.stop({ last_assistant_message: 'Order는 한 곳에서 씁니다.' })).toEqual({});
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'done', summary: 'Order는 한 곳에서 씁니다.' });
    await stopSession(session.id);
  }, 30_000);

  it('다음 요청에 표시가 없으면 다시 쓸 수 있다. 표시는 요청마다 본다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '[읽기만] 구조를 설명해줘' });
    expect((await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).deny).toContain('읽기만 요청');
    await session.gateway.stop({ last_assistant_message: '설명했습니다.' });

    expect((await session.gateway.prompt({ prompt: '메모 필드를 추가해줘' })).note).toBeUndefined();
    expect((await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).deny).toBeUndefined();
    await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(session.ofType('checkpoint')).toHaveLength(1);
    await stopSession(session.id);
  }, 30_000);

  it('읽기만은 실행이 닫힐 때까지 풀리지 않는다: 같은 실행에 표시 없는 요청이 이어 와도 쓰기를 열어 주지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '[읽기만] 구조를 설명해줘' });
    // 도중에 끊고 한마디 더 했다(같은 실행에 잇는다). 표시가 없다고 쓰기로 바뀌지 않는다
    expect((await session.gateway.prompt({ prompt: '더 자세히, 필요하면 고쳐도 돼' })).note).toContain('읽기만');
    expect((await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).deny).toContain('읽기만 요청');
    expect(await fileOf(session)).toBe(ORIGINAL);
    // 실행이 끝난 뒤의 새 요청은 쓸 수 있다
    await session.gateway.stop({ last_assistant_message: '설명했습니다.' });
    expect((await session.gateway.prompt({ prompt: '메모 필드를 추가해줘' })).note).toBeUndefined();
    expect((await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).deny).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('쓰던 실행에 읽기만 요청이 이어 오면 그때부터 막는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '메모 필드를 추가해줘' });
    expect((await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).deny).toBeUndefined();
    expect((await session.gateway.prompt({ prompt: '[읽기만] 잠깐, 방금 바꾼 것만 설명해줘' })).note).toContain('읽기만');
    expect((await write(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n')).deny).toContain('읽기만 요청');
    await stopSession(session.id);
  }, 30_000);

  it('표시 앞의 빈칸·보이지 않는 글자, 조합형 한글로 들어온 표시도 읽기만으로 본다', async () => {
    for (const prompt of ['   [읽기만] 설명해줘', `${String.fromCharCode(0x200b, 0xfeff, 0x202e)}[읽기만] 설명해줘`, '[읽기만] 설명해줘'.normalize('NFD')]) {
      const session = await open();
      await session.gateway.prompt({ prompt });
      expect((await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).deny, JSON.stringify(prompt)).toContain('읽기만 요청');
      await stopSession(session.id);
    }
  }, 60_000);

  it('글 중간에 표시가 있는 것은 읽기만이 아니다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '문서의 [읽기만] 표기를 고쳐줘' });
    expect((await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).deny).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('붙여 넣은 요청의 감싸개를 벗겨서 읽기만으로 본다. 실행 이름에도 감싸개가 남지 않는다', async () => {
    const session = await open({ lazy: true });
    const wrapped = '<pasted_content id="e4a3">\n[읽기만] Order가 어디서 쓰이는지 알려줘\n</pasted_content id="e4a3">';
    expect((await session.gateway.prompt({ prompt: wrapped })).note).toContain('읽기만');
    for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit', 'mcp__b-studio__run_in_service']) {
      const denied = await session.gateway.preTool({ tool_name: tool, tool_input: { file_path: '/workspace/api/src/Order.java', content: 'class Hacked {}\n', command: 'rm -rf .' } });
      expect(denied.deny, tool).toContain('읽기만 요청');
    }
    // 실행 이름(체크포인트 제목의 바탕)에 감싸개가 남지 않는다
    expect(session.ofType('run_started')[0]!.request).toBe('[읽기만] Order가 어디서 쓰이는지 알려줘');
    expect(await fileOf(session)).toBe(ORIGINAL);
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

  it('CLI의 세션 시작·끝 훅으로 에이전트 CLI가 떠 있는지를 화면에 알린다(떠 있을 때만 다른 패널의 글을 붙여 넣는다, 이슈 #689)', async () => {
    const session = await open();
    expect(fake.cli).toEqual([]);
    await session.gateway.note();
    expect(fake.cli).toEqual([true]);
    await session.gateway.sessionEnd({});
    expect(fake.cli).toEqual([true, false]);
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

describe('감시가 찾은 위반은 그 실행을 통과로 남기지 않는다 (이슈 #695)', () => {
  it('열린 실행 중 위반이 오면 그 실행을 실패로 닫고 바뀐 파일을 되돌린다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    sessionTerminalTarget(session.id).onViolation('관문 파일이 바뀌어 되돌렸습니다: settings.json');

    const [finished] = await finishedRuns(session, 1);
    expect(finished.status).toBe('failed');
    expect(finished.summary).toContain('검증을 우회할 수 있는 일이 감지되어');
    expect(finished.summary).toContain('바뀐 파일 1개를 되돌렸습니다');
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await fileOf(session)).toBe(ORIGINAL);
    expect(session.ofType('reverted')).toMatchObject([{ files: ['api/src/Order.java'] }]);
    // 활동 기록에도 경고가 남는다
    expect(session.ofType('agent').some((event) => event.event.type === 'warning' && event.event.message.includes('settings.json'))).toBe(true);
    await stopSession(session.id);
  }, 30_000);

  it('열린 실행이 없을 때 위반이 오면 담아 두었다가 그 뒤 처음 끝나는 실행을 실패로 닫고, 그다음 실행은 평소대로다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    sessionTerminalTarget(session.id).onViolation('검증이 붙지 않은 CLI가 터미널에서 돌고 있습니다(pid 4321)');
    // 담아 둔 위반은 세션 수준의 경고 이벤트로 활동 기록에 남는다. 아직 닫을 실행이 없다
    expect(session.ofType('notice').some((event) => event.text.includes('검증을 우회할 수 있는 일이 감지'))).toBe(true);
    expect(session.ofType('run_finished')).toEqual([]);

    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toBeUndefined();
    expect(answer.message).toContain('검증을 우회할 수 있는 일이 감지되어');
    expect(answer.message).toContain('pid 4321');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
    expect(await fileOf(session)).toBe(ORIGINAL);
    // 되돌린 것은 보관본으로 남는다
    expect(session.ofType('reverted')).toMatchObject([{ files: ['api/src/Order.java'] }]);

    // 그다음 실행은 평소대로 게이트를 지나 체크포인트가 된다
    await session.gateway.prompt({ prompt: '다시 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    await stopSession(session.id);
  }, 30_000);
});

describe('읽기만 실행은 파일이 바뀐 채 끝나면 게이트를 돌리지 않고 되돌린다 (이슈 #695)', () => {
  it('읽기만 실행 중 파일이 바뀐 채 턴이 끝나면 실패로 닫고 되돌린다(게이트를 돌리지 않는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '[읽기만] Order가 어디서 쓰이는지 알려줘' });
    // 훅을 거치지 않고 파일이 바뀐다(훅이 우회된 경우)
    await edit(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    const answer = await session.gateway.stop({ last_assistant_message: '한 곳에서 씁니다.' });
    expect(answer.feedback).toBeUndefined();
    expect(answer.message).toContain('읽기만 요청인데 파일이 바뀌어 되돌렸습니다');
    expect(fake.execCalls).toEqual([]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
    expect(await fileOf(session)).toBe(ORIGINAL);
    await stopSession(session.id);
  }, 30_000);

  it('읽기만 실행에서 파일이 그대로면 지금처럼 게이트 없이 끝난다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '[읽기만] Order가 어디서 쓰이는지 알려줘' });
    expect(await session.gateway.stop({ last_assistant_message: '한 곳에서 씁니다.' })).toEqual({});
    expect(fake.execCalls).toEqual([]);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done', summary: '한 곳에서 씁니다.' }]);
    await stopSession(session.id);
  }, 30_000);
});

describe('검증이 도는 중에 온 위반은 통과로 남지 않는다 (이슈 #695 수정)', () => {
  it('게이트가 도는 동안 위반이 오면 그 실행을 실패로 닫고 체크포인트를 남기지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    // 선언한 테스트가 끝나지 않고 멈춰 있게 만든다(게이트가 도는 중)
    let release = (): void => {};
    fake.holdWord = 'test';
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    while (!fake.execCalls.some((command) => command.includes('test'))) await new Promise((resolve) => setTimeout(resolve, 10));

    // 게이트가 도는 중에 위반이 온다. 큐를 기다리지 않고 곧바로 표시되어야 한다
    sessionTerminalTarget(session.id).onViolation('관문 파일이 바뀌어 되돌렸습니다: settings.json');
    release();
    const answer = await stopping;

    expect(answer.feedback).toBeUndefined();
    expect(answer.message).toContain('검증을 우회할 수 있는 일이 감지되어');
    expect(answer.message).toContain('바뀐 파일 1개를 되돌렸습니다');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
    expect(await fileOf(session)).toBe(ORIGINAL);
    // 되돌린 것은 한 번만 남는다(큐에 넣은 abandon과 겹쳐 두 번 닫지 않는다)
    expect(session.ofType('reverted')).toHaveLength(1);
    await stopSession(session.id);
  }, 30_000);
});

describe('멈춘 세션에 온 위반은 남지 않는다 (이슈 #695 수정)', () => {
  it('세션을 멈춘 뒤 온 위반은 경고도 담아 둔 위반도 남기지 않는다', async () => {
    const session = await open();
    const target = sessionTerminalTarget(session.id);
    await stopSession(session.id);
    const notices = session.ofType('notice').length;
    const warnings = session.ofType('agent').filter((event) => event.event.type === 'warning').length;

    target.onViolation('관문 파일이 바뀌어 되돌렸습니다: settings.json');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(session.ofType('notice')).toHaveLength(notices);
    expect(session.ofType('agent').filter((event) => event.event.type === 'warning')).toHaveLength(warnings);
    expect(session.ofType('run_finished')).toEqual([]);
    expect(getSnapshot(session.id)!.status).toBe('stopped');
  }, 30_000);
});

describe('읽기만 실행은 사람이 미리 고쳐 둔 파일로 오탐하지 않는다 (이슈 #695 수정)', () => {
  it('사람이 고쳐 둔 파일이 있는 채 읽기만 요청이 아무것도 안 바꾸고 끝나면 done이고 그 파일은 그대로다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    // 사람이 요청 전에 셸에서 파일을 고쳐 둔다
    await edit(session, 'api/src/Human.java', 'class Human {}\n');

    await session.gateway.prompt({ prompt: '[읽기만] Order가 어디서 쓰이는지 알려줘' });
    expect(await session.gateway.stop({ last_assistant_message: '한 곳에서 씁니다.' })).toEqual({});
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
    // 게이트를 돌리지 않았고 체크포인트도 만들지 않았다
    expect(fake.execCalls).toEqual([]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    // 사람의 파일은 그대로 남아 있다
    expect(await fileOf(session, 'api/src/Human.java')).toBe('class Human {}\n');
    await stopSession(session.id);
  }, 30_000);

  it('같은 상태에서 요청 도중 파일이 하나 더 바뀌면 실패로 닫고 되돌린다', async () => {
    const session = await open();
    await edit(session, 'api/src/Human.java', 'class Human {}\n');
    await session.gateway.prompt({ prompt: '[읽기만] Order가 어디서 쓰이는지 알려줘' });
    // 요청 도중 훅을 거치지 않고 파일이 바뀐다
    await edit(session, 'api/src/Order.java', 'class Order { String hacked; }\n');

    const answer = await session.gateway.stop({ last_assistant_message: '한 곳에서 씁니다.' });
    expect(answer.message).toContain('읽기만 요청인데 파일이 바뀌어 되돌렸습니다');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'failed' }]);
    await stopSession(session.id);
  }, 30_000);
});

describe('터미널의 사람 기다림을 알린다 (B7)', () => {
  const otlp = (records: Array<Record<string, unknown>>): unknown => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
  const req = (): Record<string, unknown> => ({
    timeUnixNano: String(Date.now() * 1_000_000),
    attributes: [
      { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
      { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
      { key: 'input_tokens', value: { intValue: '10' } },
      { key: 'output_tokens', value: { intValue: '1' } },
      { key: 'cache_read_tokens', value: { intValue: '0' } },
      { key: 'cache_creation_tokens', value: { intValue: '0' } },
    ],
  });

  it('권한 확인 알림은 스냅샷·이벤트에 걸리고, CLI가 다음 도구를 쓰면 풀린다(풀림엔 kind가 없다)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });

    await session.gateway.notification({ notification_type: 'permission_prompt', message: 'Do you want to create api/src/Order.java?' });
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'permission_prompt', message: 'Do you want to create api/src/Order.java?' });
    expect(session.ofType('terminal_attention')).toMatchObject([{ kind: 'permission_prompt', message: 'Do you want to create api/src/Order.java?' }]);

    // 사람이 확인하고(답하는 데는 잠시 걸린다, #955) CLI가 도구를 쓴다 → 신호가 왔으니 표시가 풀린다
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(getSnapshot(session.id)!.terminalAttention).toBeUndefined();
    const events = session.ofType('terminal_attention');
    expect(events).toHaveLength(2);
    expect(events[1]!.kind).toBeUndefined();
    expect(events[1]!.message).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('입력 대기(idle_prompt)는 열린 실행이 없으면 무시하고, 있으면 건다', async () => {
    const session = await open();
    // 실행이 하나도 없을 때의 입력 대기는 사람이 볼 일이 아니다
    await session.gateway.notification({ notification_type: 'idle_prompt', message: '입력 대기' });
    expect(getSnapshot(session.id)!.terminalAttention).toBeUndefined();
    expect(session.ofType('terminal_attention')).toEqual([]);

    // 실행이 열려 있으면 건다
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.notification({ notification_type: 'idle_prompt', message: '입력 대기' });
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'idle_prompt', message: '입력 대기' });
    await stopSession(session.id);
  }, 30_000);

  it('모르는 알림 종류는 건지 않는다', async () => {
    const session = await open();
    await session.gateway.notification({ notification_type: 'some_future_kind', message: 'x' });
    expect(getSnapshot(session.id)!.terminalAttention).toBeUndefined();
    expect(session.ofType('terminal_attention')).toEqual([]);
    await stopSession(session.id);
  }, 30_000);

  it('되묻기(agent_needs_input)는 텔레메트리(모델 요청)가 오면 풀린다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.notification({ notification_type: 'agent_needs_input', message: '무엇을 할까요?' });
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'agent_needs_input' });
    // 걸린 직후에 늦게 온 텔레메트리는 풀지 않는다(#955)
    await session.gateway.telemetry(otlp([req()]));
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'agent_needs_input' });

    // 사람이 답한 뒤의 모델 요청은 푼다
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await session.gateway.telemetry(otlp([req()]));
    expect(getSnapshot(session.id)!.terminalAttention).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('CLI가 끝나면(session-end)와 세션을 멈추면 각각 풀린다', async () => {
    const first = await open();
    await first.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await first.gateway.notification({ notification_type: 'permission_prompt', message: 'm' });
    expect(getSnapshot(first.id)!.terminalAttention).toBeDefined();
    await first.gateway.sessionEnd({});
    expect(getSnapshot(first.id)!.terminalAttention).toBeUndefined();
    await stopSession(first.id);

    const second = await open();
    await second.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await second.gateway.notification({ notification_type: 'permission_prompt', message: 'm' });
    expect(getSnapshot(second.id)!.terminalAttention).toBeDefined();
    await stopSession(second.id);
    expect(getSnapshot(second.id)!.terminalAttention).toBeUndefined();
  }, 30_000);
});

describe('작업 복사본의 Git을 믿지 않는다 (이슈 #699)', () => {
  const headOf = async (session: Opened) => (await git(session, 'rev-parse', 'HEAD')).trim();
  /** 기억한 Git 상태(작업 복사본 밖)의 마지막 체크포인트가 지금 HEAD와 같은지 본다 */
  const expectMemoryIsHead = async (session: Opened) => {
    expect(rememberedGitForTest(session.id)!.lastCheckpoint).toBe(await headOf(session));
  };
  /** 이 세션 기록에 이 종류의 이벤트가 count개 올 때까지 기다린다 */
  async function waitForEvent(session: Opened, type: StudioEvent['type'], count: number): Promise<void> {
    const started = Date.now();
    while (session.events.filter((event) => event.type === type).length < count) {
      if (Date.now() - started > 10_000) throw new Error(`${type} 이벤트가 오지 않았습니다`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('세션 생성·체크포인트·되돌리기·버리기 뒤에 기억한 마지막 체크포인트가 실제 HEAD와 같다', async () => {
    const session = await open();
    // 세션 생성: 시작 체크포인트가 HEAD이고 브랜치는 main이다(원격이 없어 기억한 주소는 없다)
    expect(rememberedGitForTest(session.id)).toEqual({ branch: 'main', lastCheckpoint: await headOf(session) });

    // 체크포인트를 남기면 기억도 지금 HEAD로 갱신된다
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.stop({ last_assistant_message: '했습니다.' });
    await expectMemoryIsHead(session);

    // 실패로 되돌리기(discard) 뒤에도 기억이 실제 HEAD와 같다
    await session.gateway.prompt({ prompt: '메모에 note도 넣어줘' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    fake.failCommands = ['test'];
    await session.gateway.stop({});
    await session.gateway.stop({});
    await session.gateway.stop({ last_assistant_message: '못 고치겠습니다.' });
    await expectMemoryIsHead(session);

    // 되돌리기(restoreCheckpoint)로 시작 체크포인트로 가면 기억도 그 HEAD로 맞춰진다
    fake.failCommands = [];
    const start = getSnapshot(session.id)!.checkpoints.at(-1)!;
    restoreCheckpoint(session.id, start.sha);
    await waitForEvent(session, 'restored', 1);
    expect(await headOf(session)).toBe(start.sha);
    await expectMemoryIsHead(session);
    await stopSession(session.id);
  }, 30_000);

  it('에이전트가 직접 만든 커밋은 턴 끝에 풀어 검증에 넣는다 — 기록에 남지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    const remembered = rememberedGitForTest(session.id)!;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    // 에이전트가 습관적으로 직접 커밋한다(두 번)
    await git(session, 'add', '-A');
    await git(session, 'commit', '-q', '-m', 'agent commit 1');
    await edit(session, 'api/src/Extra.java', 'class Extra {}\n');
    await git(session, 'add', '-A');
    await git(session, 'commit', '-q', '-m', 'agent commit 2');

    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('검증 통과');
    const snapshot = getSnapshot(session.id)!;
    // 기억한 체크포인트 위에 b-studio의 체크포인트 하나만 있다(에이전트의 커밋은 풀려 기록에 남지 않는다)
    expect(snapshot.checkpoints).toHaveLength(before + 1);
    const subjects = (await git(session, 'log', '--format=%s', `${remembered.lastCheckpoint}..HEAD`)).trim().split('\n');
    expect(subjects).toHaveLength(1);
    expect(subjects.join(' ')).not.toContain('agent commit');
    await expectMemoryIsHead(session);
    // 다음 요청에 "풀었다"는 안내가 붙고, 커밋하지 말라고 알린다
    const next = await session.gateway.prompt({ prompt: '고마워' });
    expect(next.note).toContain('커밋');
    await session.gateway.stop({ last_assistant_message: '네' });
    await stopSession(session.id);
  }, 30_000);

  it('에이전트가 브랜치를 바꿔 커밋하면(풀 수 없는 모양) 되돌리고 실행을 실패로 닫는다(보관본이 남는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    const remembered = rememberedGitForTest(session.id)!;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await git(session, 'checkout', '-q', '-b', 'agent-branch');
    await git(session, 'add', '-A');
    await git(session, 'commit', '-q', '-m', 'agent on other branch');

    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('되돌렸습니다');
    const snapshot = getSnapshot(session.id)!;
    expect(snapshot.checkpoints).toHaveLength(before);
    expect(snapshot.running).toBe(false);
    expect(session.ofType('run_finished')[0]!).toMatchObject({ status: 'failed' });
    // 세션 브랜치로 돌아와 기억한 체크포인트에 있다
    expect((await git(session, 'symbolic-ref', '--short', 'HEAD')).trim()).toBe(remembered.branch);
    expect(await headOf(session)).toBe(remembered.lastCheckpoint);
    await expectMemoryIsHead(session);
    // 에이전트의 변경은 보관본으로 남았다(되살릴 수 있다)
    const backupDir = path.join(session.work, '.git/b-studio/discarded');
    const ids = await readdir(backupDir);
    expect(ids.length).toBeGreaterThan(0);
    const meta = JSON.parse(await readFile(path.join(backupDir, ids[0]!, 'meta.json'), 'utf8')) as { files: string[] };
    expect(meta.files).toContain('api/src/Order.java');
    await stopSession(session.id);
  }, 30_000);

  it('에이전트가 기록을 되감으면(reset --hard) 되돌리고 복구한다', async () => {
    const session = await open();
    // 체크포인트를 하나 만들어 되감을 여지를 만든다
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.stop({ last_assistant_message: '했습니다.' });
    const before = getSnapshot(session.id)!.checkpoints.length;
    const remembered = rememberedGitForTest(session.id)!;

    await session.gateway.prompt({ prompt: 'note도 넣어줘' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    // 에이전트가 직전 체크포인트를 되감는다(기억한 체크포인트가 HEAD의 조상이 아니다)
    await git(session, 'reset', '--hard', 'HEAD~1');

    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('되돌렸습니다');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished').at(-1)!).toMatchObject({ status: 'failed' });
    expect(await headOf(session)).toBe(remembered.lastCheckpoint);
    await expectMemoryIsHead(session);
    await stopSession(session.id);
  }, 30_000);

  it('읽기만 실행 도중 훅을 우회해 커밋이 생기면 되돌리고 실패로 닫는다(읽기만은 Git도 바꾸지 않는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    const remembered = rememberedGitForTest(session.id)!;
    await session.gateway.prompt({ prompt: '[읽기만] Order가 어디서 쓰이는지 알려줘' });
    // 훅을 우회해 파일을 바꾸고 커밋한다(읽기만에서는 있을 수 없는 일)
    await edit(session, 'api/src/Order.java', 'class Order { String hacked; }\n');
    await git(session, 'add', '-A');
    await git(session, 'commit', '-q', '-m', 'readonly bypass commit');

    const answer = await session.gateway.stop({ last_assistant_message: '한 곳에서 씁니다.' });
    expect(answer.message).toContain('되돌렸습니다');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished').at(-1)!).toMatchObject({ status: 'failed' });
    // 기억한 체크포인트로 되돌아왔고 파일도 원래대로다
    expect(await headOf(session)).toBe(remembered.lastCheckpoint);
    expect(await fileOf(session)).toBe(ORIGINAL);
    await stopSession(session.id);
  }, 30_000);

  it('기억이 없으면(확인하지 못했으면) 턴 끝 검사가 통과로 두지 않고 실패로 닫는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setGitMemoryForTest(session.id, undefined);
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('기억하지 못해');
    // 게이트를 돌리지 않았고 체크포인트도 만들지 않았다
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished').at(-1)!).toMatchObject({ status: 'failed' });
    await stopSession(session.id);
  }, 30_000);
});

describe('끼워 넣은 커밋을 체크포인트로 받아들이지 않는다 (이슈 #706)', () => {
  const FORGED = '꾸민 체크포인트';
  /** b-studio의 체크포인트처럼 꾸민 커밋을 넣는다(같은 작성자 이메일, 통과 트레일러). 무시되는 파일만 강제로 더한다 */
  async function forge(gitArgs: string[], work: string): Promise<string> {
    const run = async (...args: string[]) => (await execFileAsync('git', [...gitArgs, ...args])).stdout.trim();
    await mkdir(path.join(work, 'node_modules'), { recursive: true });
    await writeFile(path.join(work, 'node_modules/forged.js'), 'forged\n');
    await run('add', '-f', 'node_modules/forged.js');
    await run('-c', 'user.name=b-studio', '-c', 'user.email=verify@example.com', 'commit', '-q', '-m', FORGED, '-m', 'Workflow-Passed: run, contract_check, test, review');
    return run('rev-parse', 'HEAD');
  }

  it('게이트가 도는 동안 뒤에서 커밋을 끼워 넣으면 그 위에 체크포인트를 남기지 않고, 끼워 넣은 커밋도 기록에 남지 않는다', async () => {
    fake.terminalMode = 'host';
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    const remembered = rememberedGitForTest(session.id)!;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    let release = (): void => {};
    fake.holdWord = 'test';
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    while (!fake.execCalls.some((command) => command.includes('test'))) await new Promise((resolve) => setTimeout(resolve, 10));
    // 게이트가 도는 사이에 뒤에서 돌던 프로세스가 커밋을 끼워 넣는다
    await forge(['-C', session.work], session.work);
    release();

    const answer = await stopping;
    expect(answer.message).not.toContain('검증 통과');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished').at(-1)!).toMatchObject({ status: 'failed' });
    // 기억한 체크포인트로 돌아왔고, 꾸민 커밋은 세션 기록에 없다
    expect((await git(session, 'rev-parse', 'HEAD')).trim()).toBe(remembered.lastCheckpoint);
    expect(rememberedGitForTest(session.id)!.lastCheckpoint).toBe(remembered.lastCheckpoint);
    expect(await git(session, 'log', '--format=%s', 'HEAD')).not.toContain(FORGED);
    await stopSession(session.id);
  }, 30_000);

  it('턴 사이에 끼워 넣은 커밋은 다음 요청을 시작할 때 사람의 수정과 함께 체크포인트로 굳히지 않는다(내 폴더)', async () => {
    fake.terminalMode = 'host';
    const session = await open({ workspace: 'local' });
    const remembered = rememberedGitForTest(session.id)!;
    const gitDir = path.join(getSnapshot(session.id)!.stateDir!, '.git');
    // 턴 사이: 사람이 파일을 고쳐 두고, 뒤에서 돌던 프로세스가 체크포인트 저장소에 커밋을 끼워 넣는다
    await edit(session, 'api/src/Order.java', 'class Order { String human; }\n');
    const forged = await forge(['--git-dir', gitDir, '--work-tree', session.work], session.work);

    await session.gateway.prompt({ prompt: '주문 설명을 알려줘' });
    const log = (await execFileAsync('git', ['--git-dir', gitDir, 'log', '--format=%H %s', 'HEAD'])).stdout;
    // 꾸민 커밋은 기록에 없고, 기억한 체크포인트는 b-studio가 남긴 커밋이다
    expect(log).not.toContain(forged);
    expect(log).not.toContain(FORGED);
    const now = rememberedGitForTest(session.id)!;
    expect(now.lastCheckpoint).not.toBe(forged);
    expect(getSnapshot(session.id)!.checkpoints.some((checkpoint) => checkpoint.passedStages !== undefined)).toBe(false);
    // 사람의 수정은 잃지 않았다
    expect(await fileOf(session)).toBe('class Order { String human; }\n');
    expect(now.lastCheckpoint === remembered.lastCheckpoint || log.includes(now.lastCheckpoint)).toBe(true);
    await session.gateway.stop({ last_assistant_message: '설명했습니다.' });
    await stopSession(session.id);
  }, 30_000);
});

describe('CLI의 텔레메트리가 실행의 사용량이 된다 (이슈 #726)', () => {
  /** OTLP/HTTP JSON 로그 한 묶음. 문서의 속성 이름으로 만든다 */
  const otlp = (records: Array<Record<string, unknown>>): unknown => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
  const req = (inputTokens: number, outputTokens: number, requestId?: string): Record<string, unknown> => ({
    timeUnixNano: String(Date.now() * 1_000_000),
    attributes: [
      { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
      { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
      { key: 'input_tokens', value: { intValue: String(inputTokens) } },
      { key: 'output_tokens', value: { intValue: String(outputTokens) } },
      { key: 'cache_read_tokens', value: { intValue: '0' } },
      { key: 'cache_creation_tokens', value: { intValue: '0' } },
      ...(requestId !== undefined ? [{ key: 'request_id', value: { stringValue: requestId } }] : []),
    ],
  });

  it('열린 실행 중에 온 사용량이 그 실행의 run_usage로 남고 run_finished.usage·metrics에 실린다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.telemetry(otlp([req(1000, 100), req(2000, 200)]));

    const runId = session.ofType('run_started')[0]!.runId;
    expect(session.ofType('run_usage')).toHaveLength(2);
    expect(session.ofType('run_usage').every((event) => event.runId === runId)).toBe(true);
    expect(session.ofType('run_usage')[0]).toMatchObject({ model: 'claude-sonnet-5', usage: { inputTokens: 1000, outputTokens: 100 } });

    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    const finished = session.ofType('run_finished')[0]!;
    expect(finished.usage).toEqual({ inputTokens: 3000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(finished.metrics?.modelCalls).toBe(2);
    expect(finished.metrics?.usageByModel).toEqual({ 'claude-sonnet-5': { inputTokens: 3000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    await stopSession(session.id);
  }, 30_000);

  it('실행이 닫힌 뒤 5초 안에 온 것도 그 실행에 붙는다(내보내기 주기)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    const runId = session.ofType('run_started')[0]!.runId;

    await session.gateway.telemetry(otlp([req(40, 4)]));
    expect(session.ofType('run_usage')).toMatchObject([{ runId, usage: { inputTokens: 40, outputTokens: 4 } }]);
    // 닫힌 실행의 것이라 그 실행의 사용량을 다시 바꾸지는 않는다(run_finished는 그대로다)
    expect(session.ofType('run_finished')[0]!.usage).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('같은 requestId는 한 번만 센다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '요청' });
    await session.gateway.telemetry(otlp([req(100, 10, 'req-1')]));
    await session.gateway.telemetry(otlp([req(100, 10, 'req-1')]));
    expect(session.ofType('run_usage')).toHaveLength(1);
    await stopSession(session.id);
  }, 30_000);

  it('세션 합계에 더한 사용량은 날마다의 CLI·모델별 기록에도 한 번씩 더한다(#925)', async () => {
    const { spendStore, dayKey } = await import('./spend-state');
    const session = await open();
    const backend = getSnapshot(session.id)!.backend ?? getSnapshot(session.id)!.mode;
    const callsOf = () => spendStore().read().days[dayKey(new Date())]?.[backend]?.['claude-sonnet-5']?.calls ?? 0;
    const before = callsOf();
    await session.gateway.prompt({ prompt: '요청' });
    await session.gateway.telemetry(otlp([req(100, 10, 'spend-1')]));
    await session.gateway.telemetry(otlp([req(100, 10, 'spend-1'), req(50, 5, 'spend-2')]));
    expect(callsOf() - before).toBe(2);
    await stopSession(session.id);
  }, 30_000);

  it('실행 밖에서 버린 requestId는 기억하지 않는다(뒤에 맞는 실행 창 안에서 오면 센다)', async () => {
    const session = await open();
    // 실행이 하나도 없을 때 온 것 — 버려진다. 이때 번호를 기억하면 뒤에서 놓친다
    await session.gateway.telemetry(otlp([req(100, 10, 'req-1')]));
    expect(session.ofType('run_usage')).toEqual([]);

    await session.gateway.prompt({ prompt: '요청' });
    await session.gateway.telemetry(otlp([req(100, 10, 'req-1')]));
    expect(session.ofType('run_usage')).toHaveLength(1);
    await stopSession(session.id);
  }, 30_000);

  it('메인과 서브에이전트의 사용량을 갈라 모으고, 내역의 합은 세션 합계에 더한 것과 같다(같은 요청 번호는 한 번만, #843)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.tokens;
    const sub = (inputTokens: number, requestId: string): Record<string, unknown> => {
      const record = req(inputTokens, 10, requestId);
      return { ...record, attributes: [...(record.attributes as unknown[]), { key: 'agent.name', value: { stringValue: 'Explore' } }, { key: 'query_source', value: { stringValue: 'agent:builtin:Explore' } }] };
    };
    await session.gateway.prompt({ prompt: '주문 목록을 살펴봐 줘' });
    await session.gateway.telemetry(otlp([req(1000, 100, 'm-1'), sub(200, 's-1')]));
    await session.gateway.telemetry(otlp([sub(200, 's-1'), sub(300, 's-2'), { attributes: [{ key: 'event.name', value: { stringValue: 'subagent_completed' } }, { key: 'agent_type', value: { stringValue: 'Explore' } }, { key: 'total_tool_uses', value: { stringValue: '3' } }] }]));

    const rows = sessionTerminalAgents(session.id, {})!;
    expect(rows.map((row) => [row.id, row.tokens.inputTokens])).toEqual([
      ['main', 1000],
      ['claude:Explore', 500],
    ]);
    expect(rows[1]).toMatchObject({ state: 'done', activity: '끝남 · 도구 3회' });
    const after = getSnapshot(session.id)!.tokens!;
    const total = (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined) =>
      (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
    const ledgerTotal = rows.reduce((sum, row) => sum + total(row.tokens), 0);
    expect(ledgerTotal).toBe(total(after) - total(before));
    expect(sessionCapabilities(session.id)).toMatchObject({ backend: getSnapshot(session.id)!.backend ?? getSnapshot(session.id)!.mode, tools: 'cli-default', permission: 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트' });
    await stopSession(session.id);
  }, 30_000);

  it('에이전트 내역을 세션 기록에 남겨, 다시 띄운 뒤에도 같은 행으로 되살린다(#849)', async () => {
    const session = await open();
    const sub = (inputTokens: number, requestId: string): Record<string, unknown> => {
      const record = req(inputTokens, 10, requestId);
      return { ...record, attributes: [...(record.attributes as unknown[]), { key: 'agent.name', value: { stringValue: 'Explore' } }] };
    };
    await session.gateway.prompt({ prompt: '주문 목록을 살펴봐 줘' });
    await session.gateway.telemetry(otlp([req(1000, 100, 'p-1'), sub(200, 'p-2')]));
    const rows = sessionTerminalAgents(session.id, {})!;
    const snapshot = getSnapshot(session.id)!;
    await stopSession(session.id);
    const saved = JSON.parse(await readFile(sessionFile(stateDirOf(snapshot)), 'utf8')) as { agentLedger?: unknown };
    expect(saved.agentLedger).toBeDefined();
    const restored = restoreAgentLedger(saved.agentLedger)!;
    expect(agentRows(restored, {}).map((row) => [row.id, row.tokens.inputTokens])).toEqual(rows.map((row) => [row.id, row.tokens.inputTokens]));
  }, 30_000);

  it('훅으로 온 CLI 대화 id를 세션 기록에 남겨, 멈췄다가 이어서 작업한 뒤에도 터미널이 그 대화를 이어 붙이게 한다(#872)', async () => {
    const session = await open();
    const conversation = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    expect(sessionTerminalTarget(session.id).resumeConversation?.()).toBeUndefined();
    session.gateway.conversation?.(conversation);
    expect(sessionTerminalTarget(session.id).resumeConversation?.()).toBe(conversation);
    // 꼴이 아닌 값(옵션처럼 보이는 것, 셸 글자)은 기억하지 않는다. 앞서 기억한 것이 그대로 남는다
    session.gateway.conversation?.('--dangerously-skip-permissions');
    session.gateway.conversation?.('a;rm -rf ~');
    expect(sessionTerminalTarget(session.id).resumeConversation?.()).toBe(conversation);
    const snapshot = getSnapshot(session.id)!;
    await stopSession(session.id);
    const saved = JSON.parse(await readFile(sessionFile(stateDirOf(snapshot)), 'utf8')) as { terminalConversation?: unknown };
    expect(saved.terminalConversation).toEqual({ cli: 'claude', id: conversation });
    await resumeSession(session.id);
    const started = Date.now();
    while (getSnapshot(session.id)?.status !== 'ready') {
      if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(session.id)?.status})`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sessionTerminalTarget(session.id).resumeConversation?.()).toBe(conversation);
    await stopSession(session.id);
  }, 30_000);

  it('실행 밖에서 온 것(사람이 CLI에서 대화만 한 것)은 활동 기록에 남기지 않는다', async () => {
    const session = await open();
    await session.gateway.telemetry(otlp([req(100, 10)]));
    expect(session.ofType('run_usage')).toEqual([]);
    expect(session.ofType('run_finished')).toEqual([]);
    await stopSession(session.id);
  }, 30_000);
});

describe('터미널 실행에도 턴 상한·토큰 한도·정체 알림을 건다 (#B5)', () => {
  const otlp = (records: Array<Record<string, unknown>>): unknown => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
  const req = (inputTokens: number, outputTokens: number, requestId?: string): Record<string, unknown> => ({
    timeUnixNano: String(Date.now() * 1_000_000),
    attributes: [
      { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
      { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
      { key: 'input_tokens', value: { intValue: String(inputTokens) } },
      { key: 'output_tokens', value: { intValue: String(outputTokens) } },
      { key: 'cache_read_tokens', value: { intValue: '0' } },
      { key: 'cache_creation_tokens', value: { intValue: '0' } },
      ...(requestId !== undefined ? [{ key: 'request_id', value: { stringValue: requestId } }] : []),
    ],
  });
  /** 텔레메트리 시각(at, ms)을 직접 정하는 요청. 앞 실행의 늦은 사용량을 흉내 낼 때 쓴다 */
  const reqAt = (at: number, inputTokens: number, outputTokens: number, requestId?: string): Record<string, unknown> => ({ ...req(inputTokens, outputTokens, requestId), timeUnixNano: String(at * 1_000_000) });

  it('텔레메트리로 세션 토큰 한도를 넘으면 실행을 멈추고 되돌리며, 다음 요청을 막는다', async () => {
    process.env.B_STUDIO_SESSION_TOKEN_LIMIT = '1000';
    try {
      const session = await open();
      const before = getSnapshot(session.id)!.checkpoints.length;
      await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
      await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

      await session.gateway.telemetry(otlp([req(1000, 0)]));

      // 대화 실행처럼 멈춘다: 취소 중(budget) 표시를 남기고 CLI에 Esc를 보낸다
      expect(session.ofType('run_cancelling')).toMatchObject([{ reason: 'budget' }]);
      expect(fake.interrupts).toEqual([session.id]);
      const [finished] = await finishedRuns(session, 1);
      expect(finished.status).toBe('cancelled');
      expect(finished.summary).toContain('세션 토큰 한도');
      expect(finished.summary).toContain('바뀐 파일 1개를 되돌렸습니다');
      expect(getSnapshot(session.id)!.running).toBe(false);
      expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
      expect(await fileOf(session)).toBe(ORIGINAL);
      // 세션 합계와 사람 몫에 더해졌고 대화 실행과 같은 tokens 이벤트가 남았다
      expect(getSnapshot(session.id)!.tokens).toMatchObject({ inputTokens: 1000 });
      expect(session.ofType('tokens').at(-1)).toMatchObject({ usage: { inputTokens: 1000 } });

      // 한도를 넘은 뒤의 새 요청은 대화 실행의 409와 같은 문구로 막힌다
      const blocked = await session.gateway.prompt({ prompt: '다시 해줘' });
      expect(blocked.blocked).toContain('이 세션은 토큰 한도');
      expect(session.ofType('run_started')).toHaveLength(1);
      await stopSession(session.id);
    } finally {
      delete process.env.B_STUDIO_SESSION_TOKEN_LIMIT;
    }
  }, 30_000);

  it('사람별 토큰 한도를 넘어도 같은 방식으로 멈추고, 다음 요청을 막는다', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '1000';
    try {
      const session = await open();
      const before = getSnapshot(session.id)!.checkpoints.length;
      await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
      await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

      await session.gateway.telemetry(otlp([req(1000, 0)]));

      const [finished] = await finishedRuns(session, 1);
      expect(finished.status).toBe('cancelled');
      expect(finished.summary).toContain('오늘 쓸 수 있는 토큰 한도');
      expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
      expect(await fileOf(session)).toBe(ORIGINAL);

      const blocked = await session.gateway.prompt({ prompt: '다시 해줘' });
      expect(blocked.blocked).toContain('오늘 쓸 수 있는 토큰 한도');
      await stopSession(session.id);
    } finally {
      delete process.env.B_STUDIO_USER_TOKEN_LIMIT;
    }
  }, 30_000);

  it('턴 상한에 닿으면 그 뒤 쓰기 도구를 거절하고, 턴이 끝나 게이트를 통과하면 하다 만 체크포인트로 남긴다', async () => {
    await writeFile(path.join(fake.root, 'studio.yaml'), studioYaml(2));
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    // 모델 호출 2번 = 턴 상한(2)에 닿는다
    await session.gateway.telemetry(otlp([req(10, 1, 'turn-1'), req(10, 1, 'turn-2')]));
    const denied = await session.gateway.preTool({ tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: 'class Order { String memo; String note; }\n' } });
    expect(denied.deny).toContain('턴 상한(2)에 닿았습니다');
    expect(await fileOf(session)).toBe('class Order { String memo; }\n');

    // 턴이 끝나면 평소처럼 게이트를 돌리고, 통과하면 하다 만 것으로 표시해 체크포인트를 남긴다
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(getSnapshot(session.id)!.checkpoints[0]!.incomplete).toBe('max_turns');
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'done', incomplete: 'max_turns' });
    await stopSession(session.id);
  }, 30_000);

  it('턴 상한에 닿았는데 게이트를 통과하지 못하면 재시도하지 않고 실패로 닫고 되돌린다', async () => {
    await writeFile(path.join(fake.root, 'studio.yaml'), studioYaml(1));
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.telemetry(otlp([req(10, 1, 'turn-1')]));

    fake.failCommands = ['test'];
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    // 게이트가 실패를 돌려주면 대화 실행처럼 재시도하지 않고 실패로 닫는다
    expect(answer.feedback).toBeUndefined();
    expect(answer.message).toContain('최대 턴 수(1)를 넘었습니다');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(false);
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'failed' });
    expect(await fileOf(session)).toBe(ORIGINAL);
    await stopSession(session.id);
  }, 30_000);

  it('한도가 없으면 텔레메트리가 와도 멈추지 않고 평소처럼 체크포인트를 남긴다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    await session.gateway.telemetry(otlp([req(10, 1, 'no-limit')]));
    expect(session.ofType('run_cancelling')).toEqual([]);
    expect(getSnapshot(session.id)!.running).toBe(true);

    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(getSnapshot(session.id)!.checkpoints[0]!.incomplete).toBeUndefined();
    expect(session.ofType('run_finished')[0]!.incomplete).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('정체를 한 번만 알리고, 다시 움직인 뒤 또 멈추면 다시 알린다. 실행이 닫히면 타이머도 멈춘다', async () => {
    const session = await open();
    // 120초를 기다리지 않도록 가짜 타이머로 시계와 setInterval만 돌린다(setTimeout은 실제로 두어 async가 흐르게 한다)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
      const stalled = (): Array<Extract<StudioEvent, { type: 'agent' }>> =>
        session.ofType('agent').filter((event) => event.event.type === 'warning' && event.event.message.includes('움직임이 없습니다'));
      const panelWarnings = (): string[] => fake.warnings.filter((message) => message.includes('움직임이 없습니다'));

      vi.advanceTimersByTime(120_000);
      expect(stalled()).toHaveLength(1);
      expect(panelWarnings()).toHaveLength(1);
      // 기본 120초는 "2분"으로 표기된다(#B5 수정 3)
      expect(stalled()[0]!.event).toMatchObject({ message: expect.stringContaining('2분 넘게') });
      // 정체는 알리기만 한다(멈추거나 되돌리지 않는다)
      expect(getSnapshot(session.id)!.running).toBe(true);

      // 더 기다려도 한 번뿐이다
      vi.advanceTimersByTime(120_000);
      expect(stalled()).toHaveLength(1);

      // 움직임이 생기면(텔레메트리) 다음 정체에 다시 알린다
      await session.gateway.telemetry(otlp([req(10, 1, 'act-1')]));
      vi.advanceTimersByTime(120_000);
      expect(stalled()).toHaveLength(2);
      expect(panelWarnings()).toHaveLength(2);

      // 실행이 닫히면 타이머가 멈춘다
      await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
      expect(getSnapshot(session.id)!.running).toBe(false);
      vi.advanceTimersByTime(120_000);
      expect(stalled()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    await stopSession(session.id);
  }, 30_000);

  it('실행이 닫힌 뒤 늦게 온 사용량도 세션 합계·사람 몫에 더해져, 다음 요청을 막는다', async () => {
    process.env.B_STUDIO_SESSION_TOKEN_LIMIT = '1000';
    try {
      const session = await open();
      await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
      await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
      expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
      const runId = session.ofType('run_started')[0]!.runId;
      // 실행 도중에는 텔레메트리가 없어 세션 합계가 비어 있다
      expect(getSnapshot(session.id)!.tokens).toBeUndefined();

      // 실행이 닫힌 뒤(내보내기 주기) 5초 안에 온 사용량도 그 실행의 몫으로 세션 합계에 더해진다
      await session.gateway.telemetry(otlp([req(1000, 0)]));
      expect(session.ofType('run_usage').at(-1)).toMatchObject({ runId, usage: { inputTokens: 1000 } });
      expect(getSnapshot(session.id)!.tokens).toMatchObject({ inputTokens: 1000 });
      expect(session.ofType('tokens').at(-1)).toMatchObject({ runId, sessionTokens: { inputTokens: 1000 } });

      // 실행은 이미 닫혔으니 멈출 것은 없고, 넘었으니 다음 요청 시작이 막힌다
      expect(session.ofType('run_finished')).toHaveLength(1);
      const blocked = await session.gateway.prompt({ prompt: '다시 해줘' });
      expect(blocked.blocked).toContain('이 세션은 토큰 한도');
      expect(session.ofType('run_started')).toHaveLength(1);
      await stopSession(session.id);
    } finally {
      delete process.env.B_STUDIO_SESSION_TOKEN_LIMIT;
    }
  }, 30_000);

  it('텔레메트리가 여러 건 연달아 와도 사람 한도를 실제 합계에서 넘긴다(일찍 넘기지 않는다)', async () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '1000';
    try {
      const session = await open();
      await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
      await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

      // 400씩 두 번 = 800. 한도(1000) 아래라 여기서 멈추면 안 된다
      await session.gateway.telemetry(otlp([req(400, 0, 'p-1')]));
      await session.gateway.telemetry(otlp([req(400, 0, 'p-2')]));
      expect(getSnapshot(session.id)!.tokens).toMatchObject({ inputTokens: 800 });
      expect(session.ofType('run_cancelling')).toEqual([]);
      expect(getSnapshot(session.id)!.running).toBe(true);

      // 세 번째에서 실제 합계 1200이 한도를 넘어 그때 멈춘다
      await session.gateway.telemetry(otlp([req(400, 0, 'p-3')]));
      expect(session.ofType('run_cancelling')).toMatchObject([{ reason: 'budget' }]);
      const [finished] = await finishedRuns(session, 1);
      expect(finished.status).toBe('cancelled');
      expect(finished.summary).toContain('오늘 쓸 수 있는 토큰 한도');
      await stopSession(session.id);
    } finally {
      delete process.env.B_STUDIO_USER_TOKEN_LIMIT;
    }
  }, 30_000);

  it('정체 알림 문구는 설정한 시간으로 만든다(60초의 배수면 분, 아니면 초)', async () => {
    process.env.B_STUDIO_TERMINAL_STALL_SECONDS = '90';
    try {
      const session = await open();
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
        vi.advanceTimersByTime(90_000);
        const warning = session.ofType('agent').find((event) => event.event.type === 'warning' && event.event.message.includes('움직임이 없습니다'));
        expect(warning?.event).toMatchObject({ message: expect.stringContaining('90초 넘게') });
        expect(fake.warnings.some((message) => message.includes('90초 넘게'))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
      await stopSession(session.id);
    } finally {
      delete process.env.B_STUDIO_TERMINAL_STALL_SECONDS;
    }
  }, 30_000);

  it('어느 실행에도 붙지 않는 사용량으로도 세션 한도를 넘기면 다음 요청이 막힌다', async () => {
    process.env.B_STUDIO_SESSION_TOKEN_LIMIT = '1000';
    try {
      const session = await open();
      // 실행을 한 번도 열지 않았다: 사용량이 붙을 실행 창이 없다(붙지 않아도 한도에는 든다)
      await session.gateway.telemetry(otlp([req(1000, 0)]));
      expect(session.ofType('run_usage')).toEqual([]);
      expect(getSnapshot(session.id)!.tokens).toMatchObject({ inputTokens: 1000 });
      expect(session.ofType('tokens').at(-1)).toMatchObject({ sessionTokens: { inputTokens: 1000 } });

      const blocked = await session.gateway.prompt({ prompt: '해줘' });
      expect(blocked.blocked).toContain('이 세션은 토큰 한도');
      expect(session.ofType('run_started')).toEqual([]);
      await stopSession(session.id);
    } finally {
      delete process.env.B_STUDIO_SESSION_TOKEN_LIMIT;
    }
  }, 30_000);

  it('앞 실행의 늦은 사용량이 새 실행이 열린 뒤 더해져도 세션 합계에서 사라지지 않는다', async () => {
    const session = await open();
    // 앞 실행(A)을 열고 끝낸다(닫힘). A의 창 안 시각을 하나 잡아 둔다
    await session.gateway.prompt({ prompt: '첫 요청' });
    const aStarted = Date.now();
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await session.gateway.stop({ last_assistant_message: '했습니다.' });
    const runA = session.ofType('run_started')[0]!.runId;

    // 새 실행(B)을 연다
    await session.gateway.prompt({ prompt: '두 번째 요청' });
    const runB = session.ofType('run_started')[1]!.runId;

    // A의 늦은 사용량이 B가 열린 뒤 도착한다(시각은 A의 창 안). 열린 B가 아니라 닫힌 A에 붙는다
    await session.gateway.telemetry(otlp([reqAt(aStarted, 300, 0, 'late-a')]));
    expect(session.ofType('run_usage').at(-1)).toMatchObject({ runId: runA, usage: { inputTokens: 300 } });
    expect(getSnapshot(session.id)!.tokens).toMatchObject({ inputTokens: 300 });

    // 이어서 B에 붙는 사용량이 와도 A의 몫이 덮이지 않는다(합계 = 300 + 400)
    await session.gateway.telemetry(otlp([req(400, 0, 'b-1')]));
    expect(session.ofType('run_usage').at(-1)).toMatchObject({ runId: runB, usage: { inputTokens: 400 } });
    expect(getSnapshot(session.id)!.tokens).toMatchObject({ inputTokens: 700 });
    await stopSession(session.id);
  }, 30_000);

  it('같은 요청 번호가 두 번 와도 붙지 않은 사용량은 합계에 한 번만 들어간다', async () => {
    process.env.B_STUDIO_SESSION_TOKEN_LIMIT = '1000';
    try {
      const session = await open();
      await session.gateway.telemetry(otlp([req(600, 0, 'dup-x')]));
      await session.gateway.telemetry(otlp([req(600, 0, 'dup-x')]));
      expect(session.ofType('run_usage')).toEqual([]);
      // 두 번 더하면 1200이라 한도를 넘지만, 한 번만 세므로 600이다
      expect(getSnapshot(session.id)!.tokens).toMatchObject({ inputTokens: 600 });
      // 한도를 넘지 않았으니 다음 요청은 막히지 않는다
      expect((await session.gateway.prompt({ prompt: '해줘' })).blocked).toBeUndefined();
      await stopSession(session.id);
    } finally {
      delete process.env.B_STUDIO_SESSION_TOKEN_LIMIT;
    }
  }, 30_000);
});

describe('카드의 쓰기 범위와 완료 검사가 터미널 실행에 걸린다 (#B6a)', () => {
  it('쓰기 범위 밖 파일로의 Write는 거절하고, 범위 안은 지금처럼 게이트를 지나 체크포인트가 된다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });

    const denied = await write(session, 'web/other.txt', 'x');
    expect(denied.deny).toContain('이 카드가 쓸 수 있는 경로는 api/src입니다');
    expect(denied.deny).toContain('web/other.txt');
    // 거절된 도구는 파일을 만들지 못했다
    await expect(fileOf(session, 'web/other.txt')).rejects.toThrow();

    expect(await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).toEqual({});
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('훅을 거치지 않고 범위 밖 파일을 바꾼 턴은 게이트를 돌리지 않고 돌려보낸다. 되돌리고 턴을 끝내면 통과한다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });

    // 셸 명령처럼 훅을 거치지 않은 경로로 범위 밖 파일이 바뀐다
    await edit(session, 'outside.txt', 'x');
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('이 카드의 쓰기 범위(api/src) 밖 파일을 바꿨습니다');
    expect(answer.feedback).toContain('outside.txt');
    expect(answer.feedback).toContain('되돌린 뒤 턴을 끝내세요');
    // 게이트를 돌리지 않았다(선언한 테스트도 안 돌았다). 체크포인트도 남기지 않았다
    expect(fake.execCalls).toEqual([]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished')).toEqual([]);

    // 되돌리고 턴을 끝내면 통과한다
    await rm(path.join(session.work, 'outside.txt'));
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '되돌렸습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('카드의 완료 검사가 그 실행의 게이트 test 단계에서 돌고, 실패하면 feedback으로 돌려준다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }] });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    // 완료 검사가 통과하지 못하면 그 회차로 돌려준다(선언한 unit과 함께 게이트의 test 단계에서 돌았다)
    fake.failCommands = ['echo done'];
    const failed = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(failed.feedback).toContain('[b-studio 검증 게이트]');
    expect(failed.feedback).toContain('done-card-1');
    expect(fake.execCalls).toEqual([['./gradlew', 'test'], ['sh', '-c', 'echo done']]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);

    // 완료 검사를 통과하면 체크포인트를 남긴다
    fake.failCommands = [];
    expect((await session.gateway.stop({ last_assistant_message: '고쳤습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('맥락을 지우면 완료 검사도 쓰기 범위도 풀리고 원래 workflow로 돌아온다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }] });
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    // 맥락이 걸려 있는 동안에는 범위 밖을 쓸 수 없다
    expect((await write(session, 'api/other.txt', 'x')).deny).toContain('범위 밖이라 쓰지 않았습니다');
    setTerminalTaskContext(session.id, undefined);

    // 맥락을 지우면 범위 밖 파일도 쓸 수 있다
    expect(await write(session, 'api/other.txt', 'x')).toEqual({});
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    // 완료 검사는 돌지 않고 원래 선언한 테스트만 돌았다
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    await stopSession(session.id);
  }, 30_000);

  it('맥락을 건 뒤 studio.yaml을 다시 읽어도 완료 검사가 남고, 지우면 다시 읽은 workflow로 돌아간다 (수정 1)', async () => {
    const session = await open();
    setTerminalTaskContext(session.id, {
      writableScope: ['api/src', 'studio.yaml'],
      doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }],
    });

    // 첫 턴: 파일을 바꾸고 studio.yaml도 바꿔, 체크포인트 때 project를 다시 읽게 한다
    await session.gateway.prompt({ prompt: '메모 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await write(session, 'studio.yaml', studioYamlWithExtraTest('smoke', 'echo, added'));
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    // 이번 턴은 시작할 때의 선언으로 돌았다(더한 테스트는 아직 돌지 않는다)
    expect(fake.execCalls.map((command) => command.join(' ')).sort()).toEqual(['./gradlew test', 'sh -c echo done']);

    // 다시 읽은 뒤에도 완료 검사가 남아 있다: 다음 턴은 다시 읽은 workflow(unit + smoke)와 완료 검사가 함께 돈다
    fake.execCalls = [];
    await session.gateway.prompt({ prompt: 'note도 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(fake.execCalls.map((command) => command.join(' ')).sort()).toEqual(['./gradlew test', 'echo added', 'sh -c echo done']);

    // 맥락을 지우면 다시 읽은 workflow(unit + smoke)로 돌아간다: 완료 검사는 더 돌지 않는다
    setTerminalTaskContext(session.id, undefined);
    fake.execCalls = [];
    await session.gateway.prompt({ prompt: '한 번 더' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; String note; String extra; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(fake.execCalls.map((command) => command.join(' ')).sort()).toEqual(['./gradlew test', 'echo added']);
    await stopSession(session.id);
  }, 60_000);

  it('카드 맥락이 걸려 있어도 사용자가 선언한 테스트를 지우면 약해진 선언으로 돌려보낸다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, {
      writableScope: ['api/src', 'studio.yaml'],
      doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }],
    });
    await session.gateway.prompt({ prompt: '메모 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await write(session, 'studio.yaml', studioYamlWithoutUnitTest('smoke'));

    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('weakened-declarations');
    expect(answer.feedback).toContain('삭제: 테스트 unit');
    // 카드의 완료 검사는 파일에 적힌 선언이 아니므로 견줌에 들어가지 않는다
    expect(answer.feedback).not.toContain('done-card-1');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('카드 맥락에서 required의 test를 지워도 완료 검사 덧입힘이 약화를 가리지 않는다 (수정 2)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, {
      writableScope: ['api/src', 'studio.yaml'],
      doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }],
    });
    await session.gateway.prompt({ prompt: '메모 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await write(session, 'studio.yaml', studioYamlWithoutRequiredTest());

    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('weakened-declarations');
    expect(answer.feedback).toContain('변경: 필수 단계');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('카드 맥락에서 studio.yaml의 형식을 깨뜨리면 읽을 수 없게 바꾼 것으로 실패한다 (수정 2)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, {
      writableScope: ['api/src', 'studio.yaml'],
      doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }],
    });
    await session.gateway.prompt({ prompt: '메모 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    await write(session, 'studio.yaml', 'workflow: [unclosed');

    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('읽을 수 없게 바꿨습니다');
    expect(answer.feedback).toContain('되돌리세요');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('바꾼 파일이 없어도 카드에 완료 검사가 있으면 완료 명령을 돌린다 (수정 2-1)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }] });
    await session.gateway.prompt({ prompt: '아무것도 바꾸지 말고 설명만' });

    // 아무 파일도 바꾸지 않았어도 완료 검사는 돌고, 실패하면 게이트 실패처럼 feedback으로 돌려준다
    fake.failCommands = ['echo done'];
    const failed = await session.gateway.stop({ last_assistant_message: '설명했습니다.' });
    expect(failed.feedback).toContain('done-card-1');
    expect(fake.execCalls).toEqual([['sh', '-c', 'echo done']]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(true);

    // 완료 검사를 통과하면 체크포인트 없이 done으로 끝난다
    fake.failCommands = [];
    expect(await session.gateway.stop({ last_assistant_message: '설명했습니다.' })).toEqual({});
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'done' });
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('바꾼 파일이 없고 완료 검사도 없으면 지금처럼 게이트 없이 끝난다 (수정 2-1)', async () => {
    const session = await open();
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await session.gateway.prompt({ prompt: '아무것도 바꾸지 말고 설명만' });
    expect(await session.gateway.stop({ last_assistant_message: '설명했습니다.' })).toEqual({});
    expect(fake.execCalls).toEqual([]);
    expect(session.ofType('run_finished')[0]).toMatchObject({ status: 'done', summary: '설명했습니다.' });
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('검증 상태가 세워져 있어도 바뀐 파일이 없으면 카드의 완료 검사를 돌린다 (수정 3)', async () => {
    // (a) b-studio 도구 호출로 검증 상태가 세워진 뒤, 바뀐 파일 없이 턴을 끝낸다
    const viaTool = await open();
    setTerminalTaskContext(viaTool.id, { writableScope: ['api/src'], doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }] });
    await viaTool.gateway.prompt({ prompt: '서비스 상태만 확인' });
    expect((await viaTool.gateway.runTool('run_in_service', { service: 'api', command: ['ls'] })).ok).toBe(true);

    // 완료 검사가 실패하면 feedback으로 돌려주고 done이 아니다(실행은 열린 채)
    fake.failCommands = ['echo done'];
    const failed = await viaTool.gateway.stop({ last_assistant_message: '확인했습니다.' });
    expect(failed.feedback).toContain('done-card-1');
    expect(fake.execCalls).toContainEqual(['sh', '-c', 'echo done']);
    expect(viaTool.ofType('run_finished')).toEqual([]);
    expect(getSnapshot(viaTool.id)!.running).toBe(true);

    // 완료 검사를 통과하면 체크포인트 없이 done으로 끝난다
    fake.failCommands = [];
    expect((await viaTool.gateway.stop({ last_assistant_message: '확인했습니다.' })).message).toContain('체크포인트는 만들지 않았습니다');
    expect(viaTool.ofType('run_finished')[0]).toMatchObject({ status: 'done' });
    setTerminalTaskContext(viaTool.id, undefined);
    await stopSession(viaTool.id);

    // (b) 쓰기 직전 훅으로 검증 상태가 세워졌지만 실제로 파일을 안 바꾼 경우
    const viaHook = await open();
    const before = getSnapshot(viaHook.id)!.checkpoints.length;
    setTerminalTaskContext(viaHook.id, { writableScope: ['api/src'], doneTests: [{ name: 'done-card-1', service: 'api', command: ['sh', '-c', 'echo done'] }] });
    await viaHook.gateway.prompt({ prompt: '메모 추가' });
    expect(await viaHook.gateway.preTool({ tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Order.java', content: 'class Order { String memo; }\n' } })).toEqual({});
    // 실제로는 파일을 쓰지 않았다(바뀐 파일 0개)
    fake.execCalls = [];
    expect((await viaHook.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('체크포인트는 만들지 않았습니다');
    expect(fake.execCalls).toEqual([['sh', '-c', 'echo done']]);
    expect(getSnapshot(viaHook.id)!.checkpoints).toHaveLength(before);
    expect(viaHook.ofType('run_finished')[0]).toMatchObject({ status: 'done' });
    setTerminalTaskContext(viaHook.id, undefined);
    await stopSession(viaHook.id);
  }, 60_000);

  it('이 컴퓨터 방식에서는 /workspace/… 를 작업 복사본으로 보지 않는다 (수정 2)', async () => {
    fake.terminalMode = 'host';
    const session = await open();
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await session.gateway.prompt({ prompt: '메모 추가' });

    // 이 컴퓨터 방식에서 /workspace/api/src/Order.java 는 작업 복사본 밖이다 — 범위 안으로 오인하지 않는다
    const denied = await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(denied.deny).toContain('범위 밖이라 쓰지 않았습니다');
    expect(await fileOf(session)).toBe(ORIGINAL);
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('범위 안 경로라도 작업 복사본 밖을 가리키는 링크를 지나면 거절한다 (수정 3)', async () => {
    const session = await open();
    // 범위 안(api)에 있지만 실제로는 작업 복사본 밖을 가리키는 링크
    await symlink('/etc', path.join(session.work, 'api/link'));
    setTerminalTaskContext(session.id, { writableScope: ['api'], doneTests: [] });
    await session.gateway.prompt({ prompt: '링크를 통해 쓰기' });

    const denied = await write(session, 'api/link/a.txt', 'x');
    expect(denied.deny).toContain('범위 밖이라 쓰지 않았습니다');
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);
});

describe('검사 동안 에이전트 컨테이너를 멈춘다 (이슈 #765)', () => {
  /** 가짜 샌드박스의 id. 멈추고 푸는 대상이다 */
  const containerId = 'studio-termgw-fake';

  it('이 컴퓨터 방식은 멈출 컨테이너가 없어, 통과한 실행과 체크포인트에 다른 프로세스의 쓰기를 막지 않았다고 남긴다(#850)', async () => {
    fake.terminalMode = 'host';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    // 판정은 그대로다: 통과한다
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(fake.pauses).toEqual([]);
    expect(session.ofType('run_finished').at(-1)!).toMatchObject({ status: 'done', unguardedWrites: true });
    expect(await git(session, 'log', '-1', '--format=%b')).toContain('검사 동안 다른 프로세스의 쓰기를 막지 않았습니다');
    await stopSession(session.id);
  }, 30_000);

  it('컨테이너 방식은 검사 동안 멈추므로 그 표시를 남기지 않는다(#850)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(session.ofType('run_finished').at(-1)!).not.toHaveProperty('unguardedWrites');
    expect(await git(session, 'log', '-1', '--format=%b')).not.toContain('다른 프로세스의 쓰기');
    await stopSession(session.id);
  }, 30_000);

  it('게이트를 도는 동안 멈추고, 통과하면 다시 움직인다. 끝나기 전에 서비스 안 명령이 돌지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');

    // 게이트의 첫 지문 동기화 전에 멈추고, 마지막 지문 동기화 뒤에 풀었다
    expect(fake.pauses).toEqual([containerId]);
    expect(fake.unpauses).toEqual([containerId]);
    // 게이트의 테스트는 멈춘 동안 돌았다(멈춘 것은 에이전트 컨테이너뿐이다)
    expect(fake.execsWhilePaused).toBeGreaterThan(0);
    await stopSession(session.id);
  }, 30_000);

  it('검증이 실패해 돌려보낼 때도 다시 움직인다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo }\n');

    fake.failCommands = ['test'];
    const failed = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(failed.feedback).toContain('[b-studio 검증 게이트]');
    expect(fake.pauses).toEqual([containerId]);
    expect(fake.unpauses).toEqual([containerId]);
    await stopSession(session.id);
  }, 30_000);

  it('게이트가 예외로 끝나도 다시 움직인다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    // 게이트의 검증 단계에서 예외가 난다(시크릿 검사가 던진다)
    fake.findSecretsFailures = 1;
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('검증을 끝내지 못했습니다');
    expect(answer.message).toContain('시크릿 검사 오류');
    expect(fake.pauses).toEqual([containerId]);
    expect(fake.unpauses).toEqual([containerId]);
    await stopSession(session.id);
  }, 30_000);

  it('멈추지 못하면 게이트를 돌리지 않고 돌려보낸다(풀지도 않는다)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    fake.pauseFails = '도커에 닿지 못했습니다';
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.feedback).toContain('검증 동안 에이전트 컨테이너를 멈추지 못해 통과로 인정하지 않았습니다');
    expect(answer.feedback).toContain('도커에 닿지 못했습니다');
    expect(answer.feedback).toContain('턴을 다시 끝내 주세요');
    // 게이트를 돌리지 않았다(테스트도, 지문 동기화도). 멈추지 못했으니 풀지도 않는다
    expect(fake.pauseAttempts).toBe(1);
    expect(fake.execCalls).toEqual([]);
    expect(fake.pauses).toEqual([]);
    expect(fake.unpauses).toEqual([]);
    // 실행은 열린 채로 다음 턴을 기다린다. 상한까지 가면 지금 규칙대로 실패로 닫힌다
    expect(getSnapshot(session.id)!.running).toBe(true);
    await stopSession(session.id);
  }, 30_000);

  it('풀지 못하면 알림을 남기고, 통과한 검증은 그대로 둔다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');

    fake.unpauseFails = '도커에 닿지 못했습니다';
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    const notices = session.ofType('notice').filter((event) => event.text.includes('다시 움직이지 못했습니다'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('도커에 닿지 못했습니다');
    await stopSession(session.id);
  }, 30_000);

  it('이 컴퓨터 방식은 멈출 컨테이너가 없어 부르지 않는다', async () => {
    fake.terminalMode = 'host';
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await write(session, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(fake.pauseAttempts).toBe(0);
    expect(fake.pauses).toEqual([]);
    expect(fake.unpauses).toEqual([]);
    await stopSession(session.id);
  }, 30_000);
});


describe('Codex 터미널(#825)', () => {
  /** codex 세션을 이 컴퓨터 방식으로 연다. 서버가 codex를 허용해야 세션을 만들 수 있다 */
  async function openCodex(): Promise<Opened> {
    process.env.B_STUDIO_BACKENDS = 'codex';
    fake.terminalMode = 'host';
    return open({ backend: 'codex' });
  }
  afterEach(() => {
    delete process.env.B_STUDIO_BACKENDS;
  });

  /** codex가 하는 대로: apply_patch의 쓰기 직전 훅을 부르고, 막히지 않았으면 패치의 파일을 쓴다 */
  async function patch(session: Opened, files: Record<string, string>) {
    const body = ['*** Begin Patch', ...Object.entries(files).flatMap(([file, content]) => [`*** Add File: ${file}`, `+${content}`]), '*** End Patch', ''].join('\n');
    const answer = await session.gateway.preTool({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: body } });
    if (!answer.deny) for (const [file, content] of Object.entries(files)) await edit(session, file, `${content}\n`);
    return answer;
  }

  it('세션의 백엔드가 codex면 이 컴퓨터 방식 터미널이 codex를 띄우고, 실행 기록의 백엔드도 codex다', async () => {
    const session = await openCodex();
    expect(sessionTerminalTarget(session.id).cli).toBe('codex');
    await session.gateway.prompt({ hook_event_name: 'UserPromptSubmit', prompt: '주문에 메모 필드 추가' });
    expect(session.ofType('run_started').at(-1)).toMatchObject({ via: 'terminal', backend: 'codex', taskKind: { complexity: 'simple', risk: 'normal' } });
    await stopSession(session.id);
  }, 30_000);

  it('기억한 대화가 다른 CLI의 것이면 이어 붙이지 않는다(#872)', async () => {
    const session = await openCodex();
    session.gateway.conversation?.('019a2b3c-0000-7000-8000-000000000001');
    expect(sessionTerminalTarget(session.id).resumeConversation?.()).toBe('019a2b3c-0000-7000-8000-000000000001');
    // 컨테이너 방식으로 바뀌면 claude가 뜬다. codex의 대화를 claude에 넘기지 않는다
    fake.terminalMode = 'container';
    expect(sessionTerminalTarget(session.id).cli).toBe('claude');
    expect(sessionTerminalTarget(session.id).resumeConversation?.()).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('컨테이너 방식은 백엔드가 codex여도 claude를 띄운다(컨테이너에는 claude만 깐다)', async () => {
    process.env.B_STUDIO_BACKENDS = 'codex';
    const session = await open({ backend: 'codex' });
    expect(sessionTerminalTarget(session.id).cli).toBe('claude');
    await stopSession(session.id);
  }, 30_000);

  it('apply_patch가 바꾸는 파일 중 하나라도 카드의 쓰기 범위 밖이면 패치 전체를 막고, 범위 안이면 게이트를 지나 체크포인트가 된다', async () => {
    const session = await openCodex();
    const before = getSnapshot(session.id)!.checkpoints.length;
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await session.gateway.prompt({ hook_event_name: 'UserPromptSubmit', prompt: '주문에 메모 필드 추가' });

    const denied = await patch(session, { 'api/src/Memo.java': 'class Memo {}', 'web/other.txt': 'x' });
    expect(denied.deny).toContain('web/other.txt');
    await expect(fileOf(session, 'api/src/Memo.java')).rejects.toThrow();

    expect(await patch(session, { 'api/src/Memo.java': 'class Memo {}' })).toEqual({});
    expect((await session.gateway.stop({ hook_event_name: 'Stop', last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과 — 체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    setTerminalTaskContext(session.id, undefined);
    await stopSession(session.id);
  }, 30_000);

  it('codex의 읽기 도구는 실행을 열거나 샌드박스를 기다리지 않고 바로 통과한다', async () => {
    const session = await openCodex();
    expect(await session.gateway.preTool({ hook_event_name: 'PreToolUse', tool_name: 'view_image', tool_input: { path: 'a.png' } })).toEqual({});
    expect(session.ofType('run_started')).toEqual([]);
    await stopSession(session.id);
  }, 30_000);

  it('PermissionRequest 훅은 권한 확인 대기로 보이고, 답을 주지 않는다', async () => {
    const session = await openCodex();
    await session.gateway.prompt({ hook_event_name: 'UserPromptSubmit', prompt: '테스트 돌려 줘' });
    await session.gateway.notification({ hook_event_name: 'PermissionRequest', tool_name: 'exec_command', tool_input: { command: './gradlew test' } });
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'permission_prompt', message: 'exec_command 허락 필요: ./gradlew test' });
    await stopSession(session.id);
  }, 30_000);

  it('권한 알림(Notification)이 뒤늦게 와도 PermissionRequest의 자세한 문구(무엇을 묻는지)를 덮지 않는다(#942)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '빌드 폴더 지워 줘' });
    await session.gateway.notification({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    await session.gateway.notification({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'permission_prompt', message: 'Bash 허락 필요: rm -rf build' });
    await stopSession(session.id);
  }, 30_000);

  it('권한 창 직후 늦게 온 앞 도구의 끝 훅(비동기)이 권한 대기를 풀지 않아, 뒤에 온 알림도 자세한 문구를 덮지 않는다(#955)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '빌드 폴더 지워 줘' });
    await session.gateway.activity!({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.ts' } });
    await session.gateway.notification({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    // 앞 도구(Read)의 끝 훅이 따로 돌다 늦게 닿았다(2차 실사용 점검: 1ms 뒤 대기가 풀리고 2초 뒤 알림이 문구를 덮었다)
    await session.gateway.activity!({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1' });
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'permission_prompt', message: 'Bash 허락 필요: rm -rf build' });
    await session.gateway.notification({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'permission_prompt', message: 'Bash 허락 필요: rm -rf build' });
    // 사람이 답한 뒤(잠시 뒤) 도구가 움직이면 대기가 풀린다
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await session.gateway.activity!({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1' });
    expect(getSnapshot(session.id)!.terminalAttention).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);

  it('PermissionRequest 없이 온 영어 권한 알림은 우리말로 싣는다(#942)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '빌드 폴더 지워 줘' });
    await session.gateway.notification({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(getSnapshot(session.id)!.terminalAttention).toMatchObject({ kind: 'permission_prompt', message: 'Bash 허락 필요' });
    await stopSession(session.id);
  }, 30_000);
});

describe('터미널 세션의 확인 선언 변경 허용(#916, ADR-164): 켜 두면 다음 요청 하나만 바뀐 선언으로 검증한다', () => {
  const FIXED = studioYaml().replace('command: [./gradlew, test]', 'command: [./gradlew, check]');

  /** 선언을 고치고 코드를 바꾼 뒤 턴을 끝낸다 */
  async function fixDeclaration(session: Opened): Promise<void> {
    expect(await write(session, 'studio.yaml', FIXED)).toEqual({});
    expect(await write(session, 'api/src/Order.java', 'class Order { String memo; }\n')).toEqual({});
  }

  it('켜지 않으면 실행을 시작할 때의 선언으로 돈다(지금과 같다)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '테스트 선언을 ./gradlew check로 바꿔 줘' });
    await fixDeclaration(session);
    await session.gateway.stop({ last_assistant_message: '바꿨습니다.' });
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
    await stopSession(session.id);
  }, 30_000);

  it('켜 두면 다음 요청에서 바뀐 선언으로 검증하고, 그 요청이 쓰면 꺼진다. CLI에도 켜졌다고 알린다', async () => {
    const session = await open();
    expect(setTerminalCheckChanges(session.id, true)).toBe(true);
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBe(true);
    const answer = await session.gateway.prompt({ prompt: '테스트 선언을 ./gradlew check로 바꿔 줘' });
    expect(answer.note).toContain("'확인 선언 변경 허용'");
    // 요청 하나가 가져갔다
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBeUndefined();
    await fixDeclaration(session);
    await session.gateway.stop({ last_assistant_message: '바꿨습니다.' });
    expect(fake.execCalls).toEqual([['./gradlew', 'check']]);
    expect(getSnapshot(session.id)!.checkpoints[0]!.message).toContain('테스트 선언을 ./gradlew check로');
    await stopSession(session.id);
  }, 30_000);

  it('읽기만 요청은 허용을 가져가지 않는다(게이트를 돌리지 않는다). 끄면 다시 꺼진다', async () => {
    const session = await open();
    setTerminalCheckChanges(session.id, true);
    await session.gateway.prompt({ prompt: '[읽기만] 선언이 뭐였지?' });
    await session.gateway.stop({ last_assistant_message: './gradlew test입니다.' });
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBe(true);
    expect(setTerminalCheckChanges(session.id, false)).toBe(false);
    expect(getSnapshot(session.id)!.allowCheckChangesNext).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);
});

describe('터미널 CLI가 지금 하는 일을 훅으로 모은다(#920)', () => {
  it('읽기 도구(지켜보는 훅)·쓰기 직전·상태 줄·할 일이 쌓이고, 턴이 끝나면 지금 하는 일을 지우고 마지막 답을 남긴다', async () => {
    const session = await open();
    expect(sessionTerminalActivity(session.id)).toBeUndefined();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.activity!({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'Order' } });
    expect(sessionTerminalActivity(session.id)?.now).toMatchObject({ tool: 'Grep', target: 'Order' });
    await session.gateway.preTool({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(sessionTerminalActivity(session.id)?.now).toMatchObject({ tool: 'Bash', target: 'ls' });
    await session.gateway.statusline!({ context_window: { used_percentage: 30 } });
    expect(sessionTerminalActivity(session.id)?.context).toEqual({ usedPct: 30 });
    await session.gateway.activity!({ hook_event_name: 'TaskCreated', task_id: '1', task_subject: '메모 필드' });
    expect(sessionTerminalActivity(session.id)?.todos).toEqual({ done: 0, total: 1 });
    await session.gateway.stop({ last_assistant_message: '바꾼 것이 없습니다.' });
    const after = sessionTerminalActivity(session.id)!;
    expect(after.now).toBeUndefined();
    expect(after.lastMessage).toBe('바꾼 것이 없습니다.');
    await stopSession(session.id);
  }, 30_000);

  it('관문이 거절한 도구는 도는 중이 아니고 거절 까닭이 지금 하는 일에 남는다(#942)', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '[읽기만] 구조를 설명해줘' });
    const denied = await session.gateway.preTool({ tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'pnpm test' } });
    expect(denied.deny).toContain('읽기만 요청');
    expect(sessionTerminalActivity(session.id)?.now).toMatchObject({ tool: 'Bash', target: 'pnpm test', running: false, error: expect.stringContaining('거절됨: 읽기만 요청') });
    await stopSession(session.id);
  }, 30_000);
});
