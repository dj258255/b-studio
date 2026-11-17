import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * Git 맞추기·되돌리기 조합·직접 수정 가르기(B5d, ADR-218)를 실제 sessions.ts로 본다. 임시 폴더의 진짜 git 저장소가 돈다. 가짜는 샌드박스(Docker)와 세션 터미널(컨테이너의 CLI)뿐이다.
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
  /** 붙잡힌 명령이 중단 신호로 끝난 횟수 */
  abortedExecs: 0,
  onAbort: undefined as (() => void) | undefined,
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
    async exec(_service: string, command: string[], options?: { signal?: AbortSignal }) {
      if (command[0] === 'sh' && command[2]?.startsWith('rm -f /tmp/b-studio-test-report.json ')) return { exitCode: 0, stdout: '', stderr: '' };
      fake.execCalls.push(command);
      if (fake.holdWord && command.includes(fake.holdWord)) {
        // 붙잡힌 명령은 풀리거나 넘겨받은 중단 신호가 서면 끝난다(신호가 선 횟수를 센다)
        await new Promise<void>((resolve) => {
          void fake.hold?.then(resolve);
          options?.signal?.addEventListener(
            'abort',
            () => {
              fake.abortedExecs += 1;
              fake.onAbort?.();
              resolve();
            },
            { once: true },
          );
        });
      }
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

import { createSession, getSnapshot, rememberedGitForTest, restoreCheckpoint, resumeSession, sessionTerminalTarget, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-gitrealign-session-'));
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
  fake.abortedExecs = 0;
  fake.onAbort = undefined;
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

interface TestSession {
  checkpoints: {
    uncommitTo: (sha: string) => Promise<number>;
    discard: () => Promise<unknown>;
    pendingFiles: () => Promise<string[]>;
  };
  databases: { restore: (...args: unknown[]) => Promise<unknown> };
  snapshot: { status: string; checkpoints: Array<{ sha: string; message: string; files: string[]; verify?: string; passedStages?: string[] }> };
  keptAgentChanges?: string[];
}
/** 세션 저장소(전역). 시험이 체크포인트 저장을 붙잡거나 상태를 세우는 자리다 */
const sessionOf = (id: string) => (globalThis as unknown as { __bStudio: { sessions: Map<string, TestSession> } }).__bStudio.sessions.get(id)!;

async function finishedRuns(session: Opened, count: number): Promise<Array<Extract<StudioEvent, { type: 'run_finished' }>>> {
  await until(`실행 닫힘 ${count}개`, () => session.ofType('run_finished').length >= count);
  return session.ofType('run_finished');
}


const execFileAsync = promisify(execFile);

/** 세션의 작업 복사본(내 폴더 세션은 git 폴더가 따로 있다)에 git을 부른다 */
function gitArgsOf(session: Opened): string[] {
  const stateDir = getSnapshot(session.id)?.stateDir;
  return stateDir ? ['--git-dir', path.join(stateDir, '.git'), '--work-tree', session.work] : ['-C', session.work];
}
const git = async (session: Opened, ...args: string[]): Promise<string> => (await execFileAsync('git', [...gitArgsOf(session), ...args])).stdout;
const headOf = async (session: Opened): Promise<string> => (await git(session, 'rev-parse', 'HEAD')).trim();
const branchOf = async (session: Opened): Promise<string> => (await git(session, 'symbolic-ref', '--short', 'HEAD')).trim();
const write = (session: Opened, file: string, content: string) => writeFile(path.join(session.work, file), content);
/** 이 시험이 만든 커밋(b-studio의 체크포인트가 아니다) */
async function interloper(session: Opened, file = 'interloper.txt'): Promise<string> {
  await write(session, file, 'interloper\n');
  await git(session, 'add', '-f', '--', file);
  await git(session, '-c', 'user.name=other', '-c', 'user.email=other@example.com', 'commit', '-q', '-m', 'interloper');
  return headOf(session);
}

describe('N11: 복원이 기다리는 사이 끼어든 커밋을 복원 뒤 기억에 넣지 않는다', () => {
  it('이 컴퓨터 방식: 복원 대상을 기억하고, 끼어든 커밋은 다음 요청의 맞추기가 푼다', async () => {
    fake.terminalMode = 'host';
    const session = await open();
    const start = getSnapshot(session.id)!.checkpoints.at(-1)!;
    // 체크포인트를 하나 더 만들어 두어 시작 체크포인트로 되돌릴 거리를 만든다
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await edit(session, 'api/src/Order.java', CHANGED);
    await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(getSnapshot(session.id)!.checkpoints.length).toBe(2);

    // 복원이 DB를 맞추는 동안 붙잡고, 그 사이에 작업 복사본에 커밋이 끼어든다
    let release = (): void => {};
    let entered = (): void => {};
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const databases = sessionOf(session.id).databases;
    const original = databases.restore.bind(databases);
    databases.restore = async (...args: unknown[]) => {
      entered();
      await gate;
      return original(...args);
    };
    restoreCheckpoint(session.id, start.sha);
    await enteredPromise;
    const forged = await interloper(session);
    release();
    await until('복원 끝', () => session.ofType('restored').length === 1);

    // 복원이 스스로 맞춘 곳(복원 대상)을 기억한다. 끼어든 커밋을 기억하지 않는다
    expect(rememberedGitForTest(session.id)!.lastCheckpoint).toBe(start.sha);
    expect(await headOf(session)).toBe(forged);
    // 다음 요청의 맞추기가 끼어든 커밋을 풀어 변경으로 돌린다(믿지 않는다)
    const next = await session.gateway.prompt({ prompt: '주문 설명을 알려줘' });
    expect(next).not.toHaveProperty('blocked');
    expect(await headOf(session)).toBe(start.sha);
    expect(rememberedGitForTest(session.id)!.lastCheckpoint).toBe(start.sha);
  }, 30_000);
});

describe('N12: 남긴 에이전트 변경을 직접 수정으로 커밋하지 않는다', () => {
  /** 내 폴더 세션에서 켜는 중에 닫혀 변경이 남은(kept) 상태를 만든다. 파일은 에이전트가 바꾼 것이다 */
  async function keptAgentChange(): Promise<Opened> {
    const session = await open({ lazy: true, workspace: 'local' });
    let release = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (release = resolve));
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const waiting = session.gateway.preTool(WRITE);
    await until('샌드박스 켜기 시작', () => fake.starts === 1);
    // 에이전트가 파일을 바꾼다
    await edit(session, 'api/src/Order.java', CHANGED);
    sessionTerminalTarget(session.id).onViolation('시험이 낸 위반');
    const [finished] = await finishedRuns(session, 1);
    expect(finished!.summary).toContain('변경을 되돌리지 못했습니다');
    release();
    await waiting;
    await until('샌드박스 준비', () => getSnapshot(session.id)!.status === 'ready');
    expect(await fileOf(session)).toBe(CHANGED);
    return session;
  }

  it('다음 요청이 그 파일을 "직접 수정"으로 커밋하지 않고 변경으로 남겨 게이트가 검증한다', async () => {
    const session = await keptAgentChange();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '이어서 작업해 줘' });
    const after = getSnapshot(session.id)!.checkpoints;
    // 게이트 없이 남긴 체크포인트가 없다
    expect(after).toHaveLength(before);
    expect(after.some((checkpoint) => checkpoint.message.startsWith('직접 수정'))).toBe(false);
    expect(await sessionOf(session.id).checkpoints.pendingFiles()).toEqual(['api/src/Order.java']);

    // 그 요청이 다른 파일을 바꾸고 끝나면 게이트가 둘을 함께 검증해 체크포인트로 남긴다
    await session.gateway.preTool({ tool_name: 'Write', tool_input: { file_path: '/workspace/api/src/Extra.java', content: 'class Extra {}\n' } });
    await edit(session, 'api/src/Extra.java', 'class Extra {}\n');
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message).toContain('검증 통과');
    const head = getSnapshot(session.id)!.checkpoints[0]!;
    expect(head.passedStages).toBeDefined();
    expect(head.files).toEqual(expect.arrayContaining(['api/src/Order.java', 'api/src/Extra.java']));
    // 게이트를 지나 체크포인트가 되면 기억을 지운다
    expect(sessionOf(session.id).keptAgentChanges ?? []).toEqual([]);
  }, 30_000);

  it('같은 틈에 사람이 고친 다른 파일은 직접 수정으로 남기고, 남긴 에이전트 변경만 변경으로 둔다', async () => {
    const session = await keptAgentChange();
    await write(session, 'api/src/Human.java', 'class Human {}\n');
    await session.gateway.prompt({ prompt: '이어서 작업해 줘' });
    const head = getSnapshot(session.id)!.checkpoints[0]!;
    expect(head.message).toBe('직접 수정: 파일 1개');
    expect(head.files).toEqual(['api/src/Human.java']);
    expect(await sessionOf(session.id).checkpoints.pendingFiles()).toEqual(['api/src/Order.java']);
  }, 30_000);

  it('멈춘 뒤 이어서 작업해도 직접 수정으로 커밋하지 않는다(기억이 저장 파일에 실려 서버가 다시 떠도 남는다)', async () => {
    const session = await keptAgentChange();
    // 다음 요청이 열린 채로 멈춘다: 그 실행이 바꾼 파일도 되돌려지지 않으므로 모든 파일을 에이전트 변경으로 기억한다
    await session.gateway.prompt({ prompt: '이어서 작업해 줘' });
    const stateDir = getSnapshot(session.id)!.stateDir!;
    await stopSession(session.id);
    const saved = JSON.parse(await readFile(path.join(stateDir, '.git/b-studio/session.json'), 'utf8')) as { keptAgentChanges?: string[] };
    expect(saved.keptAgentChanges).toEqual(expect.arrayContaining(['api/src/Order.java']));

    await write(session, 'api/src/Human.java', 'class Human {}\n');
    const before = getSnapshot(session.id)!.checkpoints.length;
    await resumeSession(session.id);
    const after = getSnapshot(session.id)!.checkpoints;
    // 사람이 멈춘 사이 고친 파일도 에이전트 변경과 구분할 수 없어(모든 파일) 직접 수정으로 커밋하지 않는다
    expect(after).toHaveLength(before);
    expect(after.some((checkpoint) => checkpoint.message.startsWith('직접 수정'))).toBe(false);
    expect(await sessionOf(session.id).checkpoints.pendingFiles()).toEqual(['api/src/Human.java', 'api/src/Order.java']);
  }, 30_000);

  it('옛 저장 파일(기억 없음)을 이어서 작업하면 지금까지처럼 바뀐 파일을 직접 수정으로 커밋한다', async () => {
    const session = await open({ workspace: 'local' });
    const stateDir = getSnapshot(session.id)!.stateDir!;
    await stopSession(session.id);
    const saved = JSON.parse(await readFile(path.join(stateDir, '.git/b-studio/session.json'), 'utf8')) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('keptAgentChanges');
    await write(session, 'api/src/Human.java', 'class Human {}\n');
    await resumeSession(session.id);
    expect(getSnapshot(session.id)!.checkpoints[0]!.message).toBe('직접 수정: 파일 1개');
  }, 30_000);
});

describe('N13: 읽기만 요청이 위반으로 끝나면 문서까지 되돌린다', () => {
  it('읽기만 요청이 문서 경로를 바꾼 채 끝나면 문서 체크포인트로 남기지 않고 되돌린다(보관본이 남는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await session.gateway.prompt({ prompt: '[읽기만] Order가 어디서 쓰이는지 알려줘' });
    // 훅을 우회해 문서를 쓴다(읽기만에서는 있을 수 없는 일)
    await mkdir(path.join(session.work, 'docs'), { recursive: true });
    await write(session, 'docs/notes.md', '읽기만 요청이 쓴 문서\n');
    await session.gateway.stop({ last_assistant_message: '알려 드립니다.' });

    expect(session.ofType('docs_checkpoint')).toEqual([]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    await expect(readFile(path.join(session.work, 'docs/notes.md'), 'utf8')).rejects.toThrow();
    // 조용히 지우지 않는다: 보관본에 남는다
    const backupDir = path.join(session.work, '.git/b-studio/discarded');
    const ids = await readdir(backupDir);
    const meta = JSON.parse(await readFile(path.join(backupDir, ids[0]!, 'meta.json'), 'utf8')) as { files: string[] };
    expect(meta.files).toContain('docs/notes.md');
  }, 30_000);

  it('대조: 만들기 요청이 실패로 끝나면 문서는 지금처럼 문서 체크포인트로 지킨다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.preTool(WRITE);
    await edit(session, 'api/src/Order.java', CHANGED);
    await mkdir(path.join(session.work, 'docs'), { recursive: true });
    await write(session, 'docs/notes.md', '실패한 요청이 쓴 문서\n');
    fake.failCommands = ['test'];
    await session.gateway.stop({});
    await session.gateway.stop({});
    await session.gateway.stop({ last_assistant_message: '못 고치겠습니다.' });
    expect(session.ofType('docs_checkpoint')).toHaveLength(1);
    expect(await readFile(path.join(session.work, 'docs/notes.md'), 'utf8')).toBe('실패한 요청이 쓴 문서\n');
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);
});

describe('N14: 맞추기의 읽기와 행동 사이', () => {
  it('풀기 직전에 브랜치가 바뀌면 끝 상태가 기억과 맞지 않으므로 되돌려 맞춘다(다른 브랜치에 체크포인트를 쌓지 않는다)', async () => {
    fake.terminalMode = 'host';
    const session = await open();
    const remembered = rememberedGitForTest(session.id)!;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await edit(session, 'api/src/Order.java', CHANGED);
    // 에이전트가 직접 커밋한다 → 맞추기는 같은 브랜치 위의 커밋이라 보고 풀려 한다
    await git(session, 'add', '-A');
    await git(session, '-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-q', '-m', 'agent commit');
    // 읽은 뒤 풀기 직전에 브랜치가 바뀐다
    const checkpoints = sessionOf(session.id).checkpoints;
    const original = checkpoints.uncommitTo.bind(checkpoints);
    checkpoints.uncommitTo = async (sha: string) => {
      await git(session, 'checkout', '-q', '-b', 'agent-branch');
      return original(sha);
    };
    const answer = await session.gateway.stop({ last_assistant_message: '했습니다.' });
    expect(answer.message ?? '').not.toContain('검증 통과');
    expect(answer.message).toContain('맞추는 동안');
    expect(await branchOf(session)).toBe(remembered.branch);
    expect(await headOf(session)).toBe(remembered.lastCheckpoint);
    expect(rememberedGitForTest(session.id)).toMatchObject({ branch: remembered.branch, lastCheckpoint: remembered.lastCheckpoint });
    expect(session.ofType('run_finished').at(-1)!).toMatchObject({ status: 'failed' });
  }, 30_000);

  it('되돌리는 사이(버리기 직전) 끼어든 커밋이 있으면 끝 상태를 다시 읽어 기억한 체크포인트로 맞춘다', async () => {
    fake.terminalMode = 'host';
    const session = await open();
    const remembered = rememberedGitForTest(session.id)!;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await edit(session, 'api/src/Order.java', CHANGED);
    fake.failCommands = ['test'];
    const checkpoints = sessionOf(session.id).checkpoints;
    const original = checkpoints.discard.bind(checkpoints);
    checkpoints.discard = async () => {
      await interloper(session);
      return original();
    };
    await session.gateway.stop({});
    await session.gateway.stop({});
    await session.gateway.stop({ last_assistant_message: '못 고치겠습니다.' });
    expect(await headOf(session)).toBe(remembered.lastCheckpoint);
    expect(rememberedGitForTest(session.id)!.lastCheckpoint).toBe(remembered.lastCheckpoint);
  }, 30_000);

  it('원격 주소를 읽지 못하면 기억하지 않는다(없는 주소로 기억해 나중 확인이 열리지 않게)', async () => {
    const { CheckpointStore } = await import('@b-studio/agent');
    const spy = vi.spyOn(CheckpointStore.prototype, 'remoteUrl').mockRejectedValue(new Error('git config를 읽지 못했습니다'));
    try {
      const session = await open();
      expect(rememberedGitForTest(session.id)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
