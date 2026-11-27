import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GEMINI_HOOK, GEMINI_HOOK_NAME } from '@b-studio/sandbox';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * Gemini 세션 터미널(ADR-242, 실험). **진짜 훅 명령 파일**을 node 자식 프로세스로 돌려 훅 입력을 주는 가짜 CLI와, **진짜 훅 서버**(관문)와, 진짜 sessions.ts의 판정을 잇는다.
 * 가짜는 샌드박스(Docker)와 터미널 모듈의 바깥 일(PTY)뿐이다. 진짜 gemini도 모델도 띄우지 않는다(이 시험은 `openSessionTerminal`을 부르지 않는다).
 * 쓰기 범위·보호 경로·턴 끝 게이트·체크포인트는 Claude Code 터미널과 같은 코드(sessions.ts의 terminalToolDecision·finishTerminalTurn)를 지난다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  execCalls: [] as string[][],
  failCommands: [] as string[],
  serviceUrl: 'http://127.0.0.1:1',
  terminalMode: 'host' as 'container' | 'host',
  cli: [] as boolean[],
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-termgm-fake',
    name: 'fake',
    async start() {
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
// gemini 백엔드 세션은 만들 때 실제 CLI 로그인을 확인한다. 여기서는 CLI를 부르지 않고 통과시킨다
vi.mock('@b-studio/agent', async (importOriginal) => ({ ...(await importOriginal<typeof import('@b-studio/agent')>()), preflightGemini: async () => ({ ok: true as const }) }));
vi.mock('./session-terminal', () => ({
  disposeSessionTerminal: async () => {},
  interruptSessionTerminal: () => {},
  noteSessionTerminalCli: (_sessionId: string, alive: boolean) => {
    fake.cli.push(alive);
  },
  sessionTerminalMode: () => fake.terminalMode,
  warnSessionTerminal: () => {},
  terminalPause: () => undefined,
}));

import { createSession, getSnapshot, sessionTerminalTarget, setTerminalTaskContext, stopSession, subscribe, terminalGatewayHandlersForTest } from './sessions';
import { armModClock, disarmModClock } from './session-terminal-mod';
import { startTerminalGateway, type TerminalGateway } from './terminal-gateway';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR, experimental: process.env.B_STUDIO_EXPERIMENTAL, usage: process.env.B_STUDIO_USAGE_DIR, backends: process.env.B_STUDIO_BACKENDS, terminal: process.env.B_STUDIO_TERMINAL, gatewayDir: process.env.B_STUDIO_GATEWAY_DIR };

const STUDIO_YAML = `version: 1
name: termgm
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi, contract: { extract: /v3/api-docs } }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
`;

const servers: Server[] = [];
const gateways: TerminalGateway[] = [];
let outside = '';

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-termgm-session-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), STUDIO_YAML);
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  outside = path.join(root, 'outside');
  await mkdir(outside);
  fake.root = project;
  fake.execCalls = [];
  fake.failCommands = [];
  fake.cli = [];
  fake.terminalMode = 'host';
  await serveContract();
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_EXPERIMENTAL = '1';
  process.env.B_STUDIO_BACKENDS = 'gemini';
  delete process.env.B_STUDIO_TERMINAL;
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

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_AUTH', saved.auth],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
    ['B_STUDIO_EXPERIMENTAL', saved.experimental],
    ['B_STUDIO_USAGE_DIR', saved.usage],
    ['B_STUDIO_BACKENDS', saved.backends],
    ['B_STUDIO_TERMINAL', saved.terminal],
    ['B_STUDIO_GATEWAY_DIR', saved.gatewayDir],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function serveContract(): Promise<void> {
  const doc = { openapi: '3.0.1', paths: { '/api/orders': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } } } } } }, components: { schemas: { OrderResponse: { type: 'object', properties: { id: { type: 'string' } } } } } };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(doc));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.serviceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Opened {
  id: string;
  work: string;
  events: StudioEvent[];
  ofType<T extends StudioEvent['type']>(type: T): Array<Extract<StudioEvent, { type: T }>>;
}

async function open(modelId?: string): Promise<Opened> {
  const id = (await createSession('termgm', 'kim', 'copy', { backend: 'gemini', ...(modelId ? { modelId } : {}) })).id;
  const started = Date.now();
  while (getSnapshot(id)?.status !== 'ready') {
    if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events: StudioEvent[] = [];
  subscribe(id, (event) => events.push(event));
  return { id, work: sessionTerminalTarget(id).root, events, ofType: (type) => events.filter((event): event is Extract<StudioEvent, { type: typeof type }> => event.type === type) };
}

interface HookOut {
  [key: string]: unknown;
}
interface FakeCli {
  dir: string;
  gateway: TerminalGateway;
  /** 훅 명령을 진짜로 실행한다(Gemini가 하는 대로: 표준 입력으로 JSON, 종료 코드 0이면 표준 출력을 JSON으로 읽는다) */
  hook(event: string, input: Record<string, unknown>): Promise<HookOut>;
  cwd: string;
}

/**
 * 진짜 훅 서버(관문)를 띄우고, 관문 폴더에 훅 명령 파일과 주소 파일을 쓴다. `override`를 주면 그 주소 파일을 쓴다(닿지 못하는 주소·틀린 토큰).
 * 훅은 Gemini의 훅 입력(`cwd`·`hook_event_name`·…)을 그대로 흉내 낸다
 */
async function launchCli(session: Opened, override?: (real: { url: string; token: string }) => { url: string; token: string }, cwd: string = session.work): Promise<FakeCli> {
  const gateway = await startTerminalGateway(terminalGatewayHandlersForTest(session.id), '127.0.0.1');
  gateways.push(gateway);
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-termgm-gw-'));
  const real = { url: gateway.address.hookUrl, token: gateway.address.hookToken };
  await writeFile(path.join(dir, 'b-studio-gateway.json'), `${JSON.stringify(override ? override(real) : real)}\n`);
  await writeFile(path.join(dir, GEMINI_HOOK_NAME), GEMINI_HOOK);
  return {
    dir,
    gateway,
    cwd,
    hook: async (event, input) => {
      const child = spawn(process.execPath, [path.join(dir, GEMINI_HOOK_NAME), event], { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (part: Buffer) => (stdout += part.toString('utf8')));
      child.stdin.end(JSON.stringify({ session_id: 'gm-1', transcript_path: '', cwd, timestamp: new Date().toISOString(), ...input }));
      await new Promise((resolve) => child.on('close', resolve));
      return stdout ? (JSON.parse(stdout) as HookOut) : {};
    },
  };
}

/** Gemini가 하는 대로: 훅이 거절하면 도구는 실행되지 않고, 아니면 실행(effect)하고 쓰기 뒤 훅을 부른다 */
async function toolCall(cli: FakeCli, tool: string, input: Record<string, unknown>, effect?: () => Promise<void>): Promise<{ blocked?: string }> {
  const before = await cli.hook('pre-tool', { hook_event_name: 'BeforeTool', tool_name: tool, tool_input: input });
  if (before.decision === 'deny' || before.decision === 'block') return { blocked: String(before.reason) };
  await effect?.();
  await cli.hook('post-tool', { hook_event_name: 'AfterTool', tool_name: tool, tool_input: input, tool_response: { llmContent: 'ok' } });
  return {};
}
const writeTool = (session: Opened, cli: FakeCli, file: string, content: string) => toolCall(cli, 'write_file', { file_path: path.join(session.work, file), content }, () => writeFile(path.join(session.work, file), content));
const fileOf = (session: Opened, file = 'api/src/Order.java') => readFile(path.join(session.work, file), 'utf8');
const ORIGINAL = 'class Order {}\n';

/** 사용자가 요청을 보낸다(BeforeAgent). 막히면 사유를 돌려준다 */
async function userPrompt(cli: FakeCli, text: string): Promise<{ error?: string; note?: string }> {
  const out = await cli.hook('prompt', { hook_event_name: 'BeforeAgent', prompt: text });
  if (out.decision === 'deny') return { error: String(out.reason) };
  const note = (out.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
  return note ? { note } : {};
}
/** 모델이 턴을 끝낸다(AfterAgent). 이어가게 하면 그 사유(다음 요청이 될 글)를 돌려준다 */
async function endTurn(cli: FakeCli, lastText = '끝냈습니다.', active = false): Promise<{ continueWith?: string; message?: string }> {
  const out = await cli.hook('stop', { hook_event_name: 'AfterAgent', prompt: '요청', prompt_response: lastText, stop_hook_active: active });
  if (out.decision === 'deny') return { continueWith: String(out.reason) };
  return typeof out.systemMessage === 'string' ? { message: out.systemMessage } : {};
}
/** 열린 실행을 정리한다(시험 끝) */
async function abandon(session: Opened, cli: FakeCli): Promise<void> {
  await cli.hook('session-end', { hook_event_name: 'SessionEnd', reason: 'exit' });
  await stopSession(session.id);
}

describe('Gemini 터미널: 진짜 훅 명령 → 진짜 훅 서버 → 진짜 판정', () => {
  it('통과 흐름: 세션 시작 → 요청 → 읽기 → 쓰기 → 턴 끝 게이트 통과 → 체크포인트. 기록의 백엔드는 gemini다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    const before = getSnapshot(session.id)!.checkpoints.length;

    const start = await cli.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
    expect((start.hookSpecificOutput as { hookEventName: string }).hookEventName).toBe('SessionStart');
    expect(fake.cli).toContain(true);

    expect((await userPrompt(cli, '주문에 메모 필드 추가')).error).toBeUndefined();
    expect(session.ofType('run_started')).toMatchObject([{ request: '주문에 메모 필드 추가', via: 'terminal', backend: 'gemini' }]);
    // 읽기 도구는 막지 않는다(Gemini의 이름: read_file, glob)
    expect((await toolCall(cli, 'read_file', { file_path: path.join(session.work, 'api/src/Order.java') })).blocked).toBeUndefined();
    expect((await toolCall(cli, 'glob', { pattern: '**/*.java' })).blocked).toBeUndefined();

    expect((await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n')).blocked).toBeUndefined();
    const ended = await endTurn(cli, '메모 필드를 추가했습니다.');
    expect(ended.continueWith).toBeUndefined();

    const snapshot = getSnapshot(session.id)!;
    expect(snapshot.checkpoints).toHaveLength(before + 1);
    expect(snapshot.checkpoints[0]).toMatchObject({ message: 'feat: 주문에 메모 필드 추가', files: ['api/src/Order.java'] });
    expect(snapshot.checkpoints[0]!.passedStages).toEqual(expect.arrayContaining(['run', 'contract_check', 'test', 'review']));
    expect(fake.execCalls).toEqual([['./gradlew', 'test']]);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
    expect(snapshot.running).toBe(false);
    // 모델 고르기 인자는 목표에 없다: 터미널 대상에 모델이 실리지 않는다
    expect(sessionTerminalTarget(session.id).cli).toBe('gemini');
    expect(sessionTerminalTarget(session.id).model).toBeUndefined();
    await abandon(session, cli);
  }, 30_000);

  it('읽기 도구(Gemini의 이름)는 실행을 열지 않고 바로 통과한다. 그 밖의 도구(셸·MCP)는 바꾸는 도구로 본다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    for (const [name, input] of [
      ['read_file', { file_path: path.join(session.work, 'api/src/Order.java') }],
      ['read_many_files', { include: ['**/*.java'] }],
      ['list_directory', { dir_path: '.' }],
      ['glob', { pattern: '**/*.java' }],
      ['grep_search', { pattern: 'Order' }],
      ['web_fetch', { prompt: 'x' }],
      ['write_todos', { todos: [] }],
    ] as const) {
      expect((await toolCall(cli, name, input)).blocked, name).toBeUndefined();
    }
    expect(session.ofType('run_started')).toEqual([]);
    expect(getSnapshot(session.id)!.running).toBe(false);
    // 대조: 셸은 실행을 연다
    await userPrompt(cli, '점검');
    await toolCall(cli, 'run_shell_command', { command: 'ls' });
    expect(session.ofType('run_started')).toHaveLength(1);
    await cli.hook('stop', { hook_event_name: 'AfterAgent', prompt: '요청', prompt_response: '끝', stop_hook_active: false });
    await abandon(session, cli);
  }, 30_000);

  it('카드의 쓰기 범위 밖 쓰기는 막히고 파일이 만들어지지 않는다. 상대 경로·모르는 열쇠·앞의 @도 같다. 범위 안은 통과한다(대조)', async () => {
    const session = await open();
    const cli = await launchCli(session);
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await userPrompt(cli, '주문에 메모 필드 추가');

    const denied = await writeTool(session, cli, 'web/other.txt', 'x');
    expect(denied.blocked).toContain('이 카드가 쓸 수 있는 경로는 api/src입니다');
    await expect(fileOf(session, 'web/other.txt')).rejects.toThrow();
    const relative = await toolCall(cli, 'write_file', { file_path: 'web/other.txt', content: 'x' });
    expect(relative.blocked).toContain('web/other.txt');
    // 모르는 열쇠가 끼면 어느 파일인지 알 수 없어 막는다
    for (const key of ['path', 'filePath', 'target_file']) {
      const viaAlias = await toolCall(cli, 'write_file', { file_path: path.join(session.work, 'api/src/ok.txt'), [key]: path.join(session.work, 'web/other.txt'), content: 'x' });
      expect(viaAlias.blocked, key).toContain('알 수 없어');
    }
    // Gemini는 글자 그대로의 파일이 없으면 앞의 @를 뗀다: 우리가 본 경로와 쓰는 경로가 달라지므로 막는다
    expect((await toolCall(cli, 'write_file', { file_path: '@web/other.txt', content: 'x' })).blocked).toContain('알 수 없어');
    // 서브에이전트 도구는 막는다(카드의 쓰기 범위가 걸린 세션)
    expect((await toolCall(cli, 'invoke_agent', { agent_name: 'a', prompt: 'p' })).blocked).toContain('알 수 없어');
    expect((await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n')).blocked).toBeUndefined();
    setTerminalTaskContext(session.id, undefined);
    await abandon(session, cli);
  }, 30_000);

  it('replace가 글자 그대로의 경로에 없는 상대 경로를 받으면 막는다(Gemini가 같은 이름의 다른 파일을 대신 고친다). 있는 경로와 새 파일 만들기는 통과한다(대조)', async () => {
    const session = await open();
    const cli = await launchCli(session);
    await userPrompt(cli, '주문에 메모 필드 추가');
    const missing = await toolCall(cli, 'replace', { file_path: 'Order.java', instruction: 'i', old_string: 'Order', new_string: 'Order2' });
    expect(missing.blocked).toContain('같은 이름으로 끝나는 다른 파일');
    // 대조: 정확한 상대 경로
    expect((await toolCall(cli, 'replace', { file_path: 'api/src/Order.java', instruction: 'i', old_string: 'Order', new_string: 'Order2' })).blocked).toBeUndefined();
    // 대조: old_string이 빈 글이면 새 파일을 만든다(그 길은 파일 찾기를 타지 않는다)
    expect((await toolCall(cli, 'replace', { file_path: 'api/src/New.java', instruction: 'i', old_string: '', new_string: 'class New {}' })).blocked).toBeUndefined();
    await cli.hook('stop', { hook_event_name: 'AfterAgent', prompt: 'x', prompt_response: 'y', stop_hook_active: false });
    await abandon(session, cli);
  }, 30_000);

  it('Gemini 설정(.gemini) 쓰기는 카드가 없어도 막힌다: 대소문자·상대 경로·.. 표기도 막고 관계없는 파일은 통과한다(대조). 셸 도구는 그대로다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    await userPrompt(cli, '설정 정리');
    const targets = [path.join(session.work, '.gemini/settings.json'), path.join(session.work, '.GEMINI/settings.json'), path.join(session.work, 'api/../.gemini/x.json'), '.gemini/settings.json'];
    for (const file of targets) {
      const written = await toolCall(cli, 'write_file', { file_path: file, content: '{"hooksConfig":{"enabled":false}}' });
      expect(written.blocked, `write_file ${file}`).toContain('Gemini의 설정 자리');
      const edited = await toolCall(cli, 'replace', { file_path: file, instruction: 'i', old_string: 'a', new_string: 'b' });
      expect(edited.blocked, `replace ${file}`).toContain('Gemini의 설정 자리');
    }
    await expect(readFile(path.join(session.work, '.gemini/settings.json'), 'utf8')).rejects.toThrow();
    expect((await toolCall(cli, 'run_shell_command', { command: 'ls' })).blocked).toBeUndefined();
    expect((await writeTool(session, cli, 'api/src/Order.java', 'class Order { int a; }\n')).blocked).toBeUndefined();
    await cli.hook('stop', { hook_event_name: 'AfterAgent', prompt: 'x', prompt_response: 'y', stop_hook_active: false });
    await abandon(session, cli);
  }, 30_000);

  it('작업 복사본이 아닌 폴더에서 뜬 Gemini의 쓰기 도구는 막힌다. 읽기 도구와 링크로 돌아온 같은 폴더는 통과한다(대조)', async () => {
    const session = await open();
    const elsewhere = await launchCli(session, undefined, outside);
    await userPrompt(elsewhere, '주문에 메모 필드 추가');
    const denied = await toolCall(elsewhere, 'write_file', { file_path: 'api/src/New.java', content: 'class New {}\n' }, () => writeFile(path.join(session.work, 'api/src/New.java'), 'x'));
    expect(denied.blocked).toContain('세션의 작업 복사본이 아닌 폴더');
    await expect(fileOf(session, 'api/src/New.java')).rejects.toThrow();
    const sub = await launchCli(session, undefined, path.join(session.work, 'api'));
    expect((await toolCall(sub, 'run_shell_command', { command: 'ls' })).blocked).toContain('세션의 작업 복사본이 아닌 폴더');
    expect((await toolCall(elsewhere, 'read_file', { file_path: path.join(session.work, 'api/src/Order.java') })).blocked).toBeUndefined();
    const link = path.join(path.dirname(session.work), 'work-link');
    await symlink(session.work, link);
    const viaLink = await launchCli(session, undefined, link);
    expect((await writeTool(session, viaLink, 'api/src/Order.java', 'class Order { int a; }\n')).blocked).toBeUndefined();
    await viaLink.hook('stop', { hook_event_name: 'AfterAgent', prompt: 'x', prompt_response: 'y', stop_hook_active: false });
    await abandon(session, viaLink);
  }, 30_000);

  it('보호 경로: 작업 복사본 밖을 가리키는 링크를 지나는 쓰기는 범위 안의 글자여도 막힌다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    await symlink(outside, path.join(session.work, 'api/src/escape'));
    setTerminalTaskContext(session.id, { writableScope: ['api/src'], doneTests: [] });
    await userPrompt(cli, '주문에 메모 필드 추가');
    const denied = await toolCall(cli, 'write_file', { file_path: path.join(session.work, 'api/src/escape/x.txt'), content: 'x' });
    expect(denied.blocked).toContain('범위 밖이라 쓰지 않았습니다');
    await expect(readFile(path.join(outside, 'x.txt'), 'utf8')).rejects.toThrow();
    setTerminalTaskContext(session.id, undefined);
    await abandon(session, cli);
  }, 30_000);

  it('게이트가 실패하면 사유가 이어가기 요청으로 가고 체크포인트는 없다. 그 요청(BeforeAgent로 다시 온다)은 새 요청이 아니다. 고친 뒤 턴이 끝나면 통과한다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    const before = getSnapshot(session.id)!.checkpoints.length;
    await userPrompt(cli, '주문에 메모 필드 추가');
    await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo }\n');

    fake.failCommands = ['test'];
    const first = await endTurn(cli, '추가했습니다.');
    expect(first.continueWith).toContain('[b-studio 검증 게이트]');
    expect(first.continueWith).toContain('unit');
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before);
    expect(getSnapshot(session.id)!.running).toBe(true);

    // Gemini가 그 사유를 새 요청으로 보낸다(BeforeAgent가 다시 불린다): 서버는 새 실행을 열지 않는다
    expect((await userPrompt(cli, first.continueWith!)).error).toBeUndefined();
    expect(session.ofType('run_started')).toHaveLength(1);

    fake.failCommands = [];
    await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect((await endTurn(cli, '고쳤습니다.', true)).continueWith).toBeUndefined();
    expect(getSnapshot(session.id)!.checkpoints).toHaveLength(before + 1);
    expect(session.ofType('run_finished')).toMatchObject([{ status: 'done' }]);
    await abandon(session, cli);
  }, 30_000);

  it('서버에 닿지 못하면 막는다: 관문을 닫으면 쓰기·읽기 도구와 요청 받기가 막히고, 턴 끝은 통과로 읽지 않는다. 대조로 열려 있을 때는 같은 쓰기가 실행된다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    await userPrompt(cli, '주문에 메모 필드 추가');
    expect((await writeTool(session, cli, 'api/src/First.java', 'class First {}\n')).blocked).toBeUndefined();
    expect(await fileOf(session, 'api/src/First.java')).toBe('class First {}\n');

    await cli.gateway.close();
    const denied = await writeTool(session, cli, 'api/src/Second.java', 'class Second {}\n');
    expect(denied.blocked).toContain('[b-studio] 관문에 닿지 못해');
    await expect(fileOf(session, 'api/src/Second.java')).rejects.toThrow();
    expect((await toolCall(cli, 'read_file', { file_path: 'a' })).blocked).toContain('[b-studio] 관문에 닿지 못해');
    expect((await userPrompt(cli, '다음')).error).toContain('요청을 보내지 않았습니다');
    const stopped = await endTurn(cli, '');
    expect(stopped.continueWith).toContain('검증하지 못했습니다');
    expect((await endTurn(cli, '', true)).message).toContain('검증하지 못했습니다');
    expect(getSnapshot(session.id)!.checkpoints.length).toBe(1);
    await stopSession(session.id);
  }, 30_000);

  it('틀린 토큰(서버가 401로 거절)·닿지 않는 주소는 이상한 응답이라 막는다', async () => {
    const session = await open();
    const wrongToken = await launchCli(session, (real) => ({ url: real.url, token: 'wrong-token' }));
    expect((await userPrompt(wrongToken, '요청')).error).toContain('HTTP');
    expect((await writeTool(session, wrongToken, 'api/src/A.java', 'class A {}\n')).blocked).toContain('HTTP');
    await expect(fileOf(session, 'api/src/A.java')).rejects.toThrow();
    const dead = await launchCli(session, () => ({ url: 'http://127.0.0.1:1', token: 'x' }));
    expect((await writeTool(session, dead, 'api/src/B.java', 'class B {}\n')).blocked).toContain('[b-studio] 관문에 닿지 못해');
    await stopSession(session.id);
  }, 30_000);

  it('읽기만 요청: 요청이 읽기만이면 맥락 글이 요청에 덧붙고, 그 실행의 쓰기는 막힌다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    const sent = await userPrompt(cli, '[읽기만] 구조를 설명해 줘');
    expect(sent.error).toBeUndefined();
    expect(sent.note).toBeTruthy();
    const denied = await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    expect(denied.blocked).toBeTruthy();
    expect(await fileOf(session)).toBe(ORIGINAL);
    await endTurn(cli, '설명했습니다.');
    await abandon(session, cli);
  }, 30_000);

  it('세션 끝(exit)은 열린 실행을 닫는다. /clear(clear)는 CLI의 끝이 아니라 알리지 않는다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    await cli.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
    await userPrompt(cli, '주문에 메모 필드 추가');
    await writeTool(session, cli, 'api/src/Order.java', 'class Order { String memo; }\n');
    fake.cli = [];
    await cli.hook('session-end', { hook_event_name: 'SessionEnd', reason: 'clear' });
    expect(fake.cli).toEqual([]);
    expect(getSnapshot(session.id)!.running).toBe(true);
    await cli.hook('session-end', { hook_event_name: 'SessionEnd', reason: 'exit' });
    expect(fake.cli).toContain(false);
    await stopSession(session.id);
  }, 30_000);
});

describe('Gemini 터미널: 훅이 불러와졌다는 신호(session-start)는 진짜 훅 명령과 훅 서버를 거쳐 시계에 닿는다', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('session-start가 오면 시계가 서고, 오지 않으면 Gemini 이름으로 위반을 알린다', async () => {
    const session = await open();
    const cli = await launchCli(session);
    const violations: string[] = [];
    armModClock(session.id, (reason) => violations.push(reason), 150, 'gemini');
    await cli.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
    await wait(300);
    expect(violations).toEqual([]);
    // 대조: 신호가 없다(믿지 않는 폴더라 훅이 하나도 등록되지 않은 경우)
    armModClock(session.id, (reason) => violations.push(reason), 120, 'gemini');
    await wait(300);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Gemini');
    expect(violations[0]).toContain('session-start');
    disarmModClock(session.id);
    await stopSession(session.id);
  }, 30_000);
});

describe('Gemini 터미널은 실험이고 이 컴퓨터 방식에서만 열린다', () => {
  it('실험 스위치가 꺼져 있으면 열지 않는다(claude를 대신 띄우지도 않는다). 켜면 열린다(대조)', async () => {
    const session = await open();
    expect(sessionTerminalTarget(session.id).cli).toBe('gemini');
    process.env.B_STUDIO_EXPERIMENTAL = '0';
    expect(() => sessionTerminalTarget(session.id)).toThrow('B_STUDIO_EXPERIMENTAL=1');
    process.env.B_STUDIO_EXPERIMENTAL = '1';
    expect(sessionTerminalTarget(session.id).cli).toBe('gemini');
    await stopSession(session.id);
  }, 30_000);

  it('컨테이너 방식은 거절한다(컨테이너에는 gemini가 없다). claude를 대신 띄우지 않는다', async () => {
    const session = await open();
    process.env.B_STUDIO_TERMINAL = 'container';
    fake.terminalMode = 'container';
    expect(() => sessionTerminalTarget(session.id)).toThrow('컨테이너 방식은 지원하지 않습니다');
    await stopSession(session.id);
  }, 30_000);

  it('세션에 고른 모델이 있어도 터미널 대상에 모델을 싣지 않는다(기본 모델로만 띄운다)', async () => {
    const session = await open('gemini-2.5-pro');
    const target = sessionTerminalTarget(session.id);
    expect(target.cli).toBe('gemini');
    expect(target.model).toBeUndefined();
    await stopSession(session.id);
  }, 30_000);
});
