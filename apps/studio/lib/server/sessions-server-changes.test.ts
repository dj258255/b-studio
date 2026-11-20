import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 서버가 레인 결과를 작업 폴더에 쓰고 터미널 턴 끝과 같은 판정으로 닫는 길(`applyServerChanges`, ADR-224, #1340)을 실제 sessions.ts로 본다.
 * 가짜는 샌드박스(Docker)와 세션 터미널 모듈뿐이다. 작업 복사본·체크포인트·게이트는 실제 코드가 돈다.
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
    id: 'studio-servchg-fake',
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

import { StudioError } from './errors';
import { registerWatch, unregisterWatch } from './session-terminal-watch';
import { applyServerChanges, createSession, getSnapshot, openTerminalRunId, sessionTerminalTarget, setTerminalCheckChanges, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR };

const STUDIO_YAML = `version: 1
name: servchg
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
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-servchg-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), STUDIO_YAML);
  fake.maxTurns = undefined;
  fake.terminalMode = 'host';
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
  events: StudioEvent[];
}

/** links: 프로젝트 원본에 미리 둘 링크([프로젝트 안 경로, 가리키는 곳]). 세션은 이 링크를 가진 채 시작하므로 쓰기 전의 거절이 "되돌릴 것 없음"으로 보인다 */
async function open(links: ReadonlyArray<readonly [string, string]> = []): Promise<Opened> {
  for (const [link, target] of links) await symlink(target, path.join(fake.root, link));
  const id = (await createSession('servchg', 'kim', 'copy', {})).id;
  openSessions.push(id);
  const started = Date.now();
  while (getSnapshot(id)?.status !== 'ready') {
    if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events: StudioEvent[] = [];
  subscribe(id, (event) => events.push(event));
  return { id, work: getSnapshot(id)!.workDir, events };
}

const ORIGINAL = 'class Order {}\n';
const CHANGED = 'class Order { String memo; }\n';
const GOOD = { path: 'api/src/Order.java', content: CHANGED };
const read = (session: Opened, file: string) => readFile(path.join(session.work, file), 'utf8');
const apply = (session: Opened, input: Partial<Parameters<typeof applyServerChanges>[1]> = {}) =>
  applyServerChanges(session.id, { request: '작업 분해 통합: 메모 추가', writes: [GOOD], deletes: [], writableScope: ['api'], ...input });
const gradleTests = () => fake.execCalls.filter((command) => command.join(' ') === './gradlew test').length;

describe('applyServerChanges: 서버가 쓴 레인 결과를 터미널 턴 끝과 같은 판정으로 닫는다', () => {
  it('범위 안 파일을 쓰고 게이트가 통과하면 체크포인트가 남고 그 파일이 들어 있다. 실행은 서버가 연 것으로 남는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    const result = await apply(session);
    expect(result).toMatchObject({ status: 'done' });
    expect(result.checkpoint?.files).toContain('api/src/Order.java');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(getSnapshot(session.id)!.checkpoints[0]!.sha).toBe(result.checkpoint!.sha);
    expect(await read(session, 'api/src/Order.java')).toBe(CHANGED);
    // 터미널 판정과 같은 게이트가 돌았다(시험 명령을 한 번). 체크포인트는 통과한 단계의 트레일러를 달고 있다(채팅 통합의 체크포인트와 같은 함수가 만든다)
    expect(gradleTests()).toBe(1);
    expect(result.checkpoint?.passedStages).toEqual(expect.arrayContaining(['contract_check', 'test', 'review']));
    expect(session.events.filter((event) => event.type === 'run_started')).toMatchObject([{ via: 'server', request: '작업 분해 통합: 메모 추가', runId: result.runId }]);
    expect(session.events.filter((event) => event.type === 'run_finished')).toMatchObject([{ status: 'done', runId: result.runId }]);
    // 실행은 닫혔다: 다음 요청이 바쁨으로 막히지 않는다
    expect(openTerminalRunId(session.id)).toBeUndefined();
    expect(await apply(session, { writes: [{ path: 'api/src/Order.java', content: 'class Order { String memo; String note; }\n' }] })).toMatchObject({ status: 'done' });
  }, 30_000);

  it('파일을 지우는 변경도 같은 길로 합쳐 체크포인트에 남는다', async () => {
    const session = await open();
    await writeFile(path.join(session.work, 'api/src/Old.java'), 'class Old {}\n');
    // 지울 파일은 마지막 체크포인트에 있어야 한다
    expect(await apply(session, { writes: [GOOD, { path: 'api/src/Old.java', content: 'class Old {}\n' }] })).toMatchObject({ status: 'done' });
    const result = await apply(session, { writes: [], deletes: ['api/src/Old.java'] });
    expect(result).toMatchObject({ status: 'done' });
    expect(result.checkpoint?.files).toContain('api/src/Old.java');
    await expect(readFile(path.join(session.work, 'api/src/Old.java'), 'utf8')).rejects.toThrow();
  }, 30_000);

  describe('쓰기 전에 거르는 것: 하나라도 걸리면 아무것도 쓰지 않고 실패로 닫는다', () => {
    /** pendingFiles: 시험이 작업 폴더에 미리 둔 바뀐 파일 수(링크). 실행을 닫으며 그것만 되돌린다 — 서버가 쓴 파일이 하나라도 더 되돌려졌으면 쓰기 전에 거르지 못한 것이다 */
    async function rejected(session: Opened, input: Partial<Parameters<typeof applyServerChanges>[1]>, reason: RegExp, pendingFiles = 0): Promise<void> {
      const before = getSnapshot(session.id)!.checkpoints.length;
      const result = await apply(session, { writes: [{ path: 'api/src/Good.java', content: 'class Good {}\n' }, ...(input.writes ?? [])], ...(input.deletes ? { deletes: input.deletes } : {}), ...(input.writableScope ? { writableScope: input.writableScope } : {}) });
      expect(result.status).toBe('failed');
      expect(result.summary).toMatch(reason);
      // 쓰기 전에 걸렀다: 되돌릴 것이 없다(쓴 뒤 되돌린 것이 아니다)
      expect(result.summary).toContain(pendingFiles === 0 ? '바뀐 파일은 없었습니다' : `바뀐 파일 ${pendingFiles}개를 되돌렸습니다`);
      // 걸리지 않은 파일도 쓰지 않았다
      await expect(readFile(path.join(session.work, 'api/src/Good.java'), 'utf8')).rejects.toThrow();
      expect(await read(session, 'api/src/Order.java')).toBe(ORIGINAL);
      expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
      expect(openTerminalRunId(session.id)).toBeUndefined();
      expect(gradleTests()).toBe(0);
      expect(session.events.filter((event) => event.type === 'run_finished')).toMatchObject([{ status: 'failed' }]);
    }

    it('쓰기 범위 밖 경로', async () => {
      await rejected(await open(), { writes: [{ path: 'web/app.ts', content: 'x' }] }, /범위/);
    }, 30_000);

    it('쓰기 범위가 빈 목록이면 어디에도 쓰지 못한다', async () => {
      await rejected(await open(), { writes: [GOOD], writableScope: [] }, /범위/);
    }, 30_000);

    it.each([
      ['..이 든 경로', '../escape.txt', /\.\./],
      ['..이 중간에 든 경로', 'api/../web/x.txt', /\.\./],
      ['절대 경로', '/etc/hosts', /절대 경로/],
      ['빈 조각', 'api//x.java', /빈 조각/],
      ['역슬래시', 'api\\x.java', /역슬래시/],
      ['NUL', 'api/x\0.java', /NUL/],
    ])('%s', async (_name, file, reason) => {
      await rejected(await open(), { writes: [{ path: file, content: 'x' }] }, reason);
    }, 30_000);

    it('지우기 목록의 나쁜 경로도 같은 검사를 지난다', async () => {
      await rejected(await open(), { deletes: ['../escape.txt'] }, /\.\./);
    }, 30_000);

    it('보호 경로(.git)와 비밀 파일(.env)은 범위 안이어도 거절한다', async () => {
      await rejected(await open(), { writes: [{ path: '.git/hooks/post-commit', content: '#!/bin/sh\n' }], writableScope: ['api', '.git'] }, /생성물이나 비밀 파일/);
      await rejected(await open(), { writes: [{ path: 'api/.env', content: 'SECRET=1\n' }] }, /생성물이나 비밀 파일/);
    }, 60_000);

    it('작업 폴더 밖을 가리키는 링크를 지나는 경로: 링크 너머의 파일이 바뀌지 않는다', async () => {
      const outside = await mkdtemp(path.join(tmpdir(), 'b-studio-servchg-outside-'));
      await writeFile(path.join(outside, 'victim.txt'), 'untouched\n');
      const session = await open([['api/escape', outside]]);
      await rejected(session, { writes: [{ path: 'api/escape/victim.txt', content: 'overwritten\n' }] }, /./);
      expect(await readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('untouched\n');
    }, 30_000);

    it('작업 폴더 안의 다른 범위 안 경로를 가리키는 링크도 지나지 않는다(글자와 realpath로는 안이다)', async () => {
      const session = await open();
      // 작업 폴더 안에서 만든 링크라 가리키는 곳이 작업 폴더 안이다(원본에 둔 링크는 복사하며 원본 위치로 풀린다)
      await symlink(path.join(session.work, 'api/src'), path.join(session.work, 'api/alias'));
      await rejected(session, { writes: [{ path: 'api/alias/Order.java', content: 'overwritten\n' }] }, /링크|프로젝트 밖/, 1);
      expect(await read(session, 'api/src/Order.java')).toBe(ORIGINAL);
    }, 30_000);

    it('지우기는 일반 파일만이다: 링크와 없는 파일은 지우지 않는다', async () => {
      const session = await open();
      await symlink(path.join(session.work, 'api/src/Order.java'), path.join(session.work, 'api/src/Alias.java'));
      await rejected(session, { deletes: ['api/src/Alias.java'] }, /링크|일반 파일/, 1);
      await rejected(await open(), { deletes: ['api/src/Missing.java'] }, /일반 파일|없습니다/);
    }, 60_000);

    it('같은 경로를 쓰고 지우거나 두 번 쓰면 거절한다', async () => {
      await rejected(await open(), { writes: [GOOD, GOOD] }, /두 번/);
    }, 30_000);
  });

  it('게이트가 실패하면 재시도 없이 실패로 닫고 쓴 파일을 되돌린다. 실행이 열린 채 남지 않는다', async () => {
    const session = await open();
    const before = getSnapshot(session.id)!.checkpoints.length;
    fake.failCommands = ['test'];
    const result = await apply(session);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('되돌려 고칠 에이전트가 없어 다시 시도하지 않고');
    // 재시도를 기다리지 않았다: 시험은 한 번만 돌았다
    expect(gradleTests()).toBe(1);
    expect(await read(session, 'api/src/Order.java')).toBe(ORIGINAL);
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(result.checkpoint).toBeUndefined();
    expect(openTerminalRunId(session.id)).toBeUndefined();
    expect(session.events.filter((event) => event.type === 'run_finished')).toMatchObject([{ status: 'failed' }]);
    // 다음 요청이 바쁨이 아니다
    fake.failCommands = [];
    expect(await apply(session)).toMatchObject({ status: 'done' });
  }, 60_000);

  it('게이트가 정체 감시 시간보다 오래 돌아도 "터미널이 움직이지 않는다"는 경고를 내지 않는다(서버가 쓰는 실행에는 CLI가 없다)', async () => {
    const saved = process.env.B_STUDIO_TERMINAL_STALL_SECONDS;
    process.env.B_STUDIO_TERMINAL_STALL_SECONDS = '1';
    try {
      const session = await open();
      let release = (): void => {};
      fake.hold = new Promise<void>((resolve) => (release = resolve));
      fake.holdWord = 'test';
      const running = apply(session);
      await new Promise((resolve) => setTimeout(resolve, 2_600));
      release();
      expect(await running).toMatchObject({ status: 'done' });
      expect(session.events.filter((event) => event.type === 'agent' && event.event.type === 'warning')).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.B_STUDIO_TERMINAL_STALL_SECONDS;
      else process.env.B_STUDIO_TERMINAL_STALL_SECONDS = saved;
    }
  }, 30_000);

  it('쓰기 범위는 실행이 끝나면 풀린다(성공·실패 모두)', async () => {
    const session = await open();
    fake.failCommands = ['test'];
    await apply(session);
    fake.failCommands = [];
    await apply(session);
    // 맥락이 남아 있으면 이 세션의 다음 서버 쓰기가 "이미 쓰기 범위가 걸린 세션"으로 거절된다
    expect(await apply(session, { writes: [{ path: 'api/src/Order.java', content: 'class Order { int n; }\n' }] })).toMatchObject({ status: 'done' });
  }, 60_000);

  describe('터미널을 쓰는 세션은 받지 않는다(409): 같은 작업 폴더에 CLI·사람이 쓸 수 있다', () => {
    async function refused(session: Opened, openRun?: string): Promise<void> {
      const error = await apply(session).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(StudioError);
      expect((error as StudioError).status).toBe(409);
      // 아무것도 쓰지 않았고 실행도 열지 않았다
      expect(await read(session, 'api/src/Order.java')).toBe(ORIGINAL);
      expect(session.events.filter((event) => event.type === 'run_started' && event.via === 'server')).toEqual([]);
      // 이미 열려 있던 실행은 그대로이고, 아니면 열린 실행이 없다
      expect(openTerminalRunId(session.id)).toBe(openRun);
    }

    it('터미널을 연 적이 있는 세션', async () => {
      const session = await open();
      sessionTerminalTarget(session.id);
      await refused(session);
    }, 30_000);

    it('열린 터미널 감시가 있는 세션', async () => {
      const session = await open();
      const control = { view: () => ({ live: [], problems: [] }), recheck: async () => {} };
      registerWatch(session.id, control);
      try {
        await refused(session);
      } finally {
        unregisterWatch(control);
      }
    }, 30_000);

    it('열린 터미널 실행이 있는 세션', async () => {
      const session = await open();
      await terminalGatewayHandlersForTest(session.id).prompt({ prompt: '주문에 메모 필드 추가' });
      const openRun = openTerminalRunId(session.id);
      expect(openRun).toBeDefined();
      await refused(session, openRun);
    }, 30_000);

    it('컨테이너 방식은 검사 동안 멈출 에이전트 컨테이너가 없어 받지 않는다', async () => {
      const session = await open();
      fake.terminalMode = 'container';
      await refused(session);
    }, 30_000);
  });

  it('멈춘 세션은 받지 않는다', async () => {
    const session = await open();
    await stopSession(session.id);
    await expect(apply(session)).rejects.toBeInstanceOf(StudioError);
  }, 30_000);

  describe('켜 둔 확인 선언 변경 허용(allowCheckChangesNext)을 가져가지 않는다: 서버가 연 실행은 사람의 요청이 아니다', () => {
    const WITHOUT_UNIT_TEST = STUDIO_YAML.replace(/ {2}tests:[\s\S]*$/, '  tests:\n    - name: smoke\n      service: api\n      command: [echo, smoke]\n');

    it('서버 실행 뒤에도 허용이 남아 있다', async () => {
      const session = await open();
      expect(setTerminalCheckChanges(session.id, true)).toBe(true);
      expect(await apply(session)).toMatchObject({ status: 'done' });
      expect(getSnapshot(session.id)!.allowCheckChangesNext).toBe(true);
    }, 30_000);

    it('허용이 켜져 있어도 확인 선언을 약하게 바꾸는 쓰기는 통과하지 못한다(되돌려진다)', async () => {
      const session = await open();
      setTerminalCheckChanges(session.id, true);
      const result = await apply(session, { writes: [GOOD, { path: 'studio.yaml', content: WITHOUT_UNIT_TEST }], writableScope: ['api', 'studio.yaml'] });
      expect(result.status).toBe('failed');
      expect(result.summary).toContain('weakened-declarations');
      expect(await read(session, 'studio.yaml')).toBe(STUDIO_YAML);
      expect(await read(session, 'api/src/Order.java')).toBe(ORIGINAL);
      expect(getSnapshot(session.id)!.allowCheckChangesNext).toBe(true);
    }, 60_000);
  });
});
