import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 세션 터미널 턴 끝의 나머지(예외 경로 분류·게이트 밖 사유·게이트 시간 상한, B5c, ADR-217)를 실제 sessions.ts로 본다. 가짜는 샌드박스(Docker)와 세션 터미널(컨테이너의 CLI)뿐이다.
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

import * as sessionsModule from './sessions';
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termrest-session-'));
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
    commit: (...args: unknown[]) => Promise<unknown>;
    list: (...args: unknown[]) => Promise<unknown>;
    stagedFingerprints: (...args: unknown[]) => Promise<unknown>;
    pendingFingerprint: () => Promise<string>;
    pendingFiles: () => Promise<string[]>;
  };
  snapshot: { status: string; error?: string; checkpoints: Array<{ sha: string }> };
  bootPlatformFailure?: boolean;
  terminalSaving?: { cancel: AbortController };
  run?: { cancel: AbortController };
  pendingViolation?: string;
}
/** 세션 저장소(전역). 시험이 체크포인트 저장을 붙잡거나 상태를 세우는 자리다 */
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

const NOTICE_PLATFORM = 'b-studio 쪽(샌드박스·도커) 문제로 검증하지 못했습니다';
const noticeTexts = (session: Opened): string[] => session.ofType('notice').map((event) => event.text);

describe('N7(a): 플랫폼 실패는 이번 실행의 켜기 실패일 때만 인정한다', () => {
  it('세션에 남은 실패 표시(status failed + bootPlatformFailure)만으로는 코드 탓 오류를 플랫폼 실패로 분류하지 않는다: 되돌리고 오류로 닫는다', async () => {
    const session = await open();
    await startWork(session);
    const live = sessionOf(session.id);
    // 앞선 켜기 실패에서 남은 표시를 세운다(이번 실행의 켜기는 실패하지 않았다)
    live.snapshot.status = 'failed';
    live.snapshot.error = '앞서 도커에 닿지 못했습니다';
    live.bootPlatformFailure = true;
    live.checkpoints.commit = async () => {
      throw new Error('커밋하지 못했습니다');
    };
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    const [finished] = await finishedRuns(session, 1);
    expect(finished!.status).toBe('error');
    expect(finished!.platformFailure ?? '').toBe('');
    expect(noticeTexts(session).join('\n')).not.toContain(NOTICE_PLATFORM);
    expect(answer.message).toContain('커밋하지 못했습니다');
  }, 30_000);

  it('이번 실행에서 샌드박스를 켜지 못했으면 플랫폼 실패다: 되돌리지 않고 남기고 AI의 실패로 세지 않는다(회귀 방지)', async () => {
    const session = await open({ lazy: true });
    fake.startFails = true;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.preTool(WRITE);
    await edit(session, 'api/src/Order.java', CHANGED);
    await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    const [finished] = await finishedRuns(session, 1);
    expect(finished!.platformFailure).toContain('샌드박스를 켜지 못했습니다');
    expect(noticeTexts(session).join('\n')).toContain(NOTICE_PLATFORM);
    expect(await fileOf(session)).toBe(CHANGED);
  }, 30_000);
});

describe('N7(b): 겹친 칸의 순서(멈춤 → 남은 체크포인트 → 취소 → 플랫폼 실패 → 오류)', () => {
  it('취소와 켜기 실패가 함께 서면 취소로 닫는다(플랫폼 실패 표시를 붙이지 않는다)', async () => {
    const session = await open({ lazy: true });
    let releaseStart = (): void => {};
    fake.startHold = new Promise<void>((resolve) => (releaseStart = resolve));
    fake.startFails = true;
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    const writing = session.gateway.preTool(WRITE);
    await until('켜기 시작', () => fake.starts > 0);
    const runId = openTerminalRunId(session.id)!;
    await edit(session, 'api/src/Order.java', CHANGED);
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await sleep(50);
    cancelRun(session.id, runId);
    releaseStart();
    await writing;
    await stopping;
    const [finished] = await finishedRuns(session, 1);
    expect(finished!.status).toBe('cancelled');
    expect(finished!.platformFailure ?? '').toBe('');
  }, 30_000);

  it('저장이 커밋을 남긴 뒤 던지고 그때 취소 신호도 서 있으면 남은 체크포인트가 이긴다: 체크포인트와 작업 복사본을 되돌리지 않고 실패로 닫는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    const held = holdCommit(session, () => {
      sessionOf(session.id).terminalSaving?.cancel.abort(new DOMException('취소', 'AbortError'));
      throw new Error('커밋 뒤 단계가 던졌습니다');
    });
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await held.entered;
    held.release();
    const answer = await stopping;
    const [finished] = await finishedRuns(session, 1);
    expect(finished!.status).toBe('failed');
    expect(answer.message).toContain('체크포인트');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(await fileOf(session)).toBe(CHANGED);
  }, 30_000);
});

describe('N7(c): 남은 체크포인트를 Git에서 읽지 못하면 남았다고 보지 않는다', () => {
  it('커밋 뒤 목록을 읽지 못한 채 던지면 "남겼다"고 닫지 않는다(확인한 것만 받아들인다)', async () => {
    const session = await open();
    await startWork(session);
    const held = holdCommit(session, () => {
      sessionOf(session.id).checkpoints.list = async () => {
        throw new Error('git을 읽지 못했습니다');
      };
      throw new Error('커밋 뒤 단계가 던졌습니다');
    });
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await held.entered;
    held.release();
    const answer = await stopping;
    const [finished] = await finishedRuns(session, 1);
    expect(answer.message).toContain('확인하지 못했습니다');
    expect(finished!.summary ?? '').not.toContain('체크포인트를 남겼지만');
    // 조용히 "없음"으로 닫지 않는다: 확인하지 못했다고 사유에 적는다
    expect(finished!.summary).toContain('Git에서 읽지 못해 확인하지 못했습니다');
    expect(finished!.status).toBe('error');
  }, 30_000);
});

describe('N9: 시험 보고를 모으지 못하면 근거가 빠진다고 알린다', () => {
  it('게이트를 통과해 체크포인트를 남겼는데 시험 보고 수집이 던지면 알림을 남긴다(체크포인트와 실행 결과는 그대로다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    // 시험 보고 수집이 처음 읽는 자리(저장된 결과 복원)가 던지게 한다
    let reached = false;
    const failing = Promise.reject(new Error('보고서 저장소를 읽지 못했습니다'));
    failing.catch(() => {});
    Object.defineProperty(sessionOf(session.id), 'testResultsLoadPromise', {
      get: () => {
        reached = true;
        return failing;
      },
      set: () => {},
    });
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('검증 통과');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    await until('시험 보고 수집 시작', () => reached);
    await until('시험 보고 알림', () => noticeTexts(session).some((text) => text.includes('시험 보고')));
    expect(noticeTexts(session).join('\n')).toContain('보고서 저장소를 읽지 못했습니다');
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
  }, 30_000);
});

describe('N10: 실행이 닫힌 뒤 바뀐 파일의 사실', () => {
  it('열린 실행이 없을 때 온 Stop 훅은 아무것도 보지 않는다: 파일이 남고 실행도 체크포인트도 만들지 않는다', async () => {
    const session = await open();
    await startWork(session);
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과');
    const checkpoints = getSnapshot(session.id)!.checkpoints.length;
    // 닫힌 뒤 뒤에서 도는 프로세스가 파일을 바꾼다
    await edit(session, 'api/src/Late.java', 'class Late {}\n');
    const answer = await session.gateway.stop({ last_assistant_message: '끝' });
    expect(answer).toEqual({});
    expect(session.ofType('run_finished')).toHaveLength(1);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(checkpoints);
    expect(await fileOf(session, 'api/src/Late.java')).toBe('class Late {}\n');
  }, 30_000);

  it('닫힌 뒤 바뀐 파일은 다음 실행의 게이트가 검증 대상으로 넣는다(복사본 세션): 통과하면 다음 체크포인트에 들어간다', async () => {
    const session = await open();
    await startWork(session);
    await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await edit(session, 'api/src/Late.java', 'class Late {}\n');
    await session.gateway.prompt({ prompt: '둘째 요청' });
    expect(await session.gateway.preTool(WRITE)).toEqual({});
    await edit(session, 'api/src/Order.java', 'class Order { String memo; String note; }\n');
    const answer = await session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    expect(answer.message).toContain('검증 통과');
    const latest = getSnapshot(session.id)!.checkpoints[0]!;
    expect(latest.files).toContain('api/src/Late.java');
  }, 30_000);
});

/** 게이트 시간 상한을 시험에서만 짧게 한다. 이 함수가 없는 옛 코드에서는 상한이 걸리지 않는다 */
const setDeadline = (ms: number | undefined): void => {
  (sessionsModule as unknown as { setTerminalGateDeadlineForTest?: (ms: number | undefined) => void }).setTerminalGateDeadlineForTest?.(ms);
};
afterEach(() => setDeadline(undefined));

describe('N8: Stop 훅의 상한보다 오래 도는 게이트는 통과로 남기지 않는다', () => {
  it('게이트가 시간 상한을 넘기면 실패로 닫고 되돌린다. 뒤늦게 끝난 게이트가 체크포인트를 남기지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    setDeadline(700);
    fake.holdWord = 'test';
    let release = (): void => {};
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    // 검사가 처음 중단 신호를 받는 순간 실행 자체의 취소 신호는 아직 서 있지 않아야 한다: 상한이 직접 검사를 멈춘다(실행을 닫는 쪽이 멈추기 전에)
    const cancelAtFirstAbort: boolean[] = [];
    fake.onAbort = () => cancelAtFirstAbort.push(sessionOf(session.id).run?.cancel.signal.aborted === true);
    const calls = fake.execCalls.length;
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    const first = await Promise.race([stopping, sleep(4_000).then(() => 'hung' as const)]);
    expect(first).not.toBe('hung');
    const answer = first as { feedback?: string; message?: string };
    expect(fake.execCalls.length).toBeGreaterThan(calls);
    expect(answer.feedback).toBeUndefined();
    expect(answer.message).toContain('시간 상한');
    // 상한이 검사에 중단 신호로 닿는다(붙잡힌 명령이 신호로 끝났다)
    await until('검사 중단', () => fake.abortedExecs > 0);
    expect(cancelAtFirstAbort[0]).toBe(false);
    const [finished] = await finishedRuns(session, 1);
    expect(finished!.status).toBe('failed');
    expect(finished!.summary).toContain('시간 상한');
    expect(await fileOf(session)).toBe(ORIGINAL);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    // 뒤늦게 게이트가 끝나도 이미 닫힌 실행이다: 체크포인트도 두 번째 닫힘도 없다
    release();
    await sleep(500);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(session.ofType('run_finished')).toHaveLength(1);
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);

  it('상한 안에 끝나는 게이트는 그대로 통과한다(회귀 방지)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    await startWork(session);
    setDeadline(60_000);
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
  }, 30_000);

  it('상한으로 닫은 뒤 다음 요청은 새 실행으로 열려 평소대로 통과한다(상한이 다음 실행에 남지 않는다)', async () => {
    const session = await open();
    await startWork(session);
    setDeadline(500);
    fake.holdWord = 'test';
    let release = (): void => {};
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const first = await Promise.race([session.gateway.stop({ last_assistant_message: '추가했습니다.' }), sleep(4_000).then(() => 'hung' as const)]);
    expect(first).not.toBe('hung');
    release();
    fake.holdWord = undefined;
    setDeadline(60_000);
    await sleep(100);
    await startWork(session, '둘째 요청');
    expect((await session.gateway.stop({ last_assistant_message: '추가했습니다.' })).message).toContain('검증 통과');
  }, 30_000);
});

describe('게이트 밖 사유: 통과 뒤 지문이 바뀐 사이 취소·멈춤이 오면 통과로 남기지 않는다', () => {
  async function movedDuringGate(session: Opened, whileHeld: () => void | Promise<void>): Promise<{ feedback?: string; message?: string }> {
    await startWork(session);
    fake.holdWord = 'test';
    let release = (): void => {};
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const calls = fake.execCalls.length;
    const stopping = session.gateway.stop({ last_assistant_message: '추가했습니다.' });
    await until('검사 시작', () => fake.execCalls.length > calls);
    await edit(session, 'api/src/Order.java', 'class Order { String memo; /* 바뀜 */ }\n');
    await whileHeld();
    release();
    return stopping;
  }

  it('취소가 오면 취소로 닫고 되돌린다(돌려보내기 피드백으로 남기지 않는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    const runId = (): string => openTerminalRunId(session.id)!;
    const answer = await movedDuringGate(session, () => cancelRun(session.id, runId()));
    expect(answer.feedback).toBeUndefined();
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'cancelled' }]);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(await fileOf(session)).toBe(ORIGINAL);
  }, 30_000);

  it('세션을 멈추면 멈춘 것으로 닫는다(체크포인트를 남기지 않는다)', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    let stopped: Promise<unknown> | undefined;
    const answer = await movedDuringGate(session, () => {
      stopped = stopSession(session.id);
    });
    await stopped;
    expect(answer.feedback).toBeUndefined();
    expect(getSnapshot(session.id)?.checkpoints.length ?? before).toBe(before);
  }, 30_000);
});
