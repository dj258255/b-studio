import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from './errors';
import type { StudioEvent } from '../studio-events';

/**
 * 세션 터미널의 에이전트별 활동 기록(#1411, ADR-232)을 실제 sessions.ts로 본다: 훅이 기록을 채우고, 샌드박스가 아는 비밀 값을 가리고, 세션 기록에는 남기지 않고, 세션을 멈추면 비운다. 가짜는 샌드박스(Docker)와 세션 터미널(컨테이너의 CLI)뿐이다.
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
  /** 샌드박스가 아는 비밀 값 */
  secret: 'SANDBOX-SECRET-4711',
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
    redact: (text: string) => text.split(fake.secret).join('[비밀]'),
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

import { createSession, getSnapshot, sessionTerminalActivityLog, sessionTerminalTarget, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';

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

const WRITE_OF = (content: string) => ({ tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: '/workspace/api/src/Order.java', content } });

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

describe('에이전트별 활동 기록(#1411): 실제 세션의 훅 → 기록 → 멈춤', () => {
  it('쓰기 직전·읽기·끝 훅이 메인과 서브에이전트의 기록을 채우고, 샌드박스가 아는 비밀 값은 가려진다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.preTool(WRITE_OF(`class Order { String key = "${fake.secret}"; String memo; }\n`));
    await session.gateway.activity!({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_response: {} });
    await session.gateway.activity!({ hook_event_name: 'SubagentStart', agent_id: 'sub1', agent_type: 'Explore' });
    await session.gateway.preTool({ tool_name: 'Read', tool_use_id: 'r1', agent_id: 'sub1', tool_input: { file_path: '/workspace/api/src/Order.java' } });
    await session.gateway.activity!({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', agent_id: 'sub1' });

    const log = sessionTerminalActivityLog(session.id);
    expect(log.agents.map((agent) => [agent.id, agent.entries.map((entry) => `${entry.tool}:${entry.state}`)])).toEqual([
      ['main', ['Write:done']],
      ['sub1', ['Read:done']],
    ]);
    expect(log.agents[1]).toMatchObject({ type: 'Explore', state: 'working' });
    const write = log.agents[0]!.entries[0]!;
    expect(write.changes?.[0]?.added).toContain('[비밀]');
    expect(JSON.stringify(log)).not.toContain(fake.secret);
    // 에이전트 하나만
    expect(sessionTerminalActivityLog(session.id, 'sub1').agents.map((agent) => agent.id)).toEqual(['sub1']);
  }, 30_000);

  it('기록(명령 결과)은 세션 기록(디스크)에 남지 않는다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문 목록을 확인' });
    await session.gateway.preTool({ tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls api' } });
    await session.gateway.activity!({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_response: { stdout: 'OUTPUT_MARKER_ON_DISK' } });
    expect(JSON.stringify(sessionTerminalActivityLog(session.id))).toContain('OUTPUT_MARKER_ON_DISK');
    await stopSession(session.id);
    const sessionsDir = process.env.B_STUDIO_SESSIONS_DIR!;
    const files = await filesUnder(sessionsDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(await readFile(file, 'utf8').catch(() => ''), file).not.toContain('OUTPUT_MARKER_ON_DISK');
  }, 30_000);

  it('세션을 멈추면 기록이 비워진다', async () => {
    const session = await open();
    await session.gateway.prompt({ prompt: '주문에 메모 필드 추가' });
    await session.gateway.preTool(WRITE_OF('class Order {}\n'));
    expect(sessionTerminalActivityLog(session.id).agents).toHaveLength(1);
    await stopSession(session.id);
    expect(sessionTerminalActivityLog(session.id)).toEqual({ agents: [] });
  }, 30_000);

  it('없는 세션은 404, 쓸 수 없는 서버는 403이다', async () => {
    expect(() => sessionTerminalActivityLog('없는-세션')).toThrowError(expect.objectContaining({ status: 404 }) as never);
    const saved = process.env.B_STUDIO_EXPERIMENTAL;
    delete process.env.B_STUDIO_EXPERIMENTAL;
    process.env.B_STUDIO_MODE = 'server';
    try {
      expect(() => sessionTerminalActivityLog('x')).toThrow(StudioError);
    } finally {
      process.env.B_STUDIO_MODE = 'api';
      if (saved !== undefined) process.env.B_STUDIO_EXPERIMENTAL = saved;
    }
  });
});
