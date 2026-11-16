import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

/**
 * 토큰 한도 판정(ADR-209, 4f B3c): 대화 경로(`runPlan`의 tokens 이벤트)와 요청 시작이 같은 판정을 쓰고, 사람별 사용량 파일을 읽을 수 없을 때도 한도가 조용히 꺼지지 않는다.
 * 샌드박스(Docker)·CLI 러너·로그인 확인은 가짜다. 러너는 시험이 보내는 tokens 이벤트를 그대로 알린다(실제 모델·docker·네트워크 없음). 사용량 폴더는 임시 폴더만 쓴다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  destroyCalls: 0,
  destroyGate: undefined as Promise<void> | undefined,
  /** 러너가 시작된 횟수와 그때 받은 중지 신호·풀 수 있는 문 */
  runs: [] as Array<{ signal: AbortSignal; release: () => void; emit: (event: unknown) => void }>,
  /** 러너가 중지 신호를 보면 던지는가(false면 신호를 무시하고 문이 열릴 때까지 기다린다) */
  honorAbort: true,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-busy-fake-abcdef',
    name: 'fake',
    async start() {
      return [];
    },
    async restart(service: string) {
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async sync() {
      return { elapsedMs: 0, checks: 1 };
    },
    async endpoint(service: string) {
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async state() {
      return 'running';
    },
    async stats() {
      return [];
    },
    async *logs() {
      await new Promise(() => {});
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
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
    async destroy() {
      fake.destroyCalls += 1;
      await fake.destroyGate;
    },
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

const done = { status: 'done', summary: '설명했습니다.', changedFiles: [], verifyAttempts: 0, turns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
vi.mock('@b-studio/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@b-studio/agent')>()),
  preflightClaudeCode: async () => ({ ok: true as const, account: {} }),
  runClaudeCodeAgent: (options: { signal: AbortSignal; onEvent?: (event: unknown) => void }) =>
    new Promise((resolve, reject) => {
      const entry = { signal: options.signal, release: () => resolve(done), emit: (event: unknown) => options.onEvent?.(event) };
      fake.runs.push(entry);
      options.signal.addEventListener('abort', () => {
        if (fake.honorAbort) reject(options.signal.reason ?? new Error('중단'));
      });
    }),
}));

import { createSession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, backend: process.env.B_STUDIO_BACKENDS, sessions: process.env.B_STUDIO_SESSIONS_DIR, usage: process.env.B_STUDIO_USAGE_DIR, limit: process.env.B_STUDIO_USER_TOKEN_LIMIT };
const opened: Array<() => void> = [];
const ids: string[] = [];

async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error(`기다린 조건이 되지 않았습니다: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const tokens = (n: number) => ({ type: 'tokens', usage: { inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const usageFile = () => path.join(root, 'usage', 'tokens.json');

/** 파일에 저장된 kim의 오늘 합계(입력 토큰) */
async function storedInput(): Promise<number> {
  try {
    const periods = (JSON.parse(await readFile(usageFile(), 'utf8')) as { periods: Record<string, Record<string, { inputTokens: number }>> }).periods;
    return Object.values(periods).reduce((sum, people) => sum + (people.kim?.inputTokens ?? 0), 0);
  } catch {
    return 0;
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-token-limits-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: busyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
review:
  auto: false
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  fake.root = path.join(root, 'project');
  fake.destroyCalls = 0;
  fake.destroyGate = undefined;
  fake.runs = [];
  fake.honorAbort = true;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_BACKENDS = 'claude-code';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.B_STUDIO_USAGE_DIR = path.join(root, 'usage');
  process.env.B_STUDIO_USER_TOKEN_LIMIT = '1000';
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'busy', GIT_AUTHOR_EMAIL: 'busy@example.com', GIT_COMMITTER_NAME: 'busy', GIT_COMMITTER_EMAIL: 'busy@example.com' });
});

afterEach(async () => {
  for (const run of fake.runs) run.release();
  for (const close of opened.splice(0)) close();
  for (const id of ids.splice(0)) await stopSession(id).catch(() => {});
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_BACKENDS', saved.backend], ['B_STUDIO_SESSIONS_DIR', saved.sessions], ['B_STUDIO_USAGE_DIR', saved.usage], ['B_STUDIO_USER_TOKEN_LIMIT', saved.limit]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function open(): Promise<{ id: string; events: StudioEvent[] }> {
  const id = (await createSession('busyproj', 'kim', 'copy', { backend: 'claude-code', boot: 'eager' })).id;
  ids.push(id);
  await until(() => getSnapshot(id)?.status === 'ready', '상태 ready');
  const events: StudioEvent[] = [];
  opened.push(subscribe(id, (event) => events.push(event)));
  return { id, events };
}

const ask = (id: string) => sendMessage(id, '구조를 설명해 줘', { allowBreaking: false, by: 'kim', intent: 'ask', steering: true });

describe('사람 한도: 대화 경로는 이 실행이 저장한 몫을 겹쳐 세지 않는다(결함 1)', () => {
  it('누적값이 여러 번 와도 실제 합계가 한도 아래면 멈추지 않고, 한도에 닿는 순간 멈춘다', async () => {
    const { id, events } = await open();
    ask(id);
    await until(() => fake.runs.length === 1, '러너 시작');
    const run = fake.runs[0]!;

    run.emit(tokens(400));
    await until(async () => (await storedInput()) === 400, '첫 몫 저장');
    // 누적 800은 한도(1000) 아래다. 옛 판정은 저장된 400에 누적 800을 다시 더해 1200으로 보고 멈췄다
    run.emit(tokens(800));
    await until(async () => (await storedInput()) === 800, '둘째 몫 저장');
    await settle();
    expect(run.signal.aborted).toBe(false);
    expect(events.filter((event) => event.type === 'run_cancelling')).toEqual([]);

    run.emit(tokens(1000));
    await until(() => run.signal.aborted, '한도에서 멈춤');
    expect(events.filter((event) => event.type === 'run_cancelling')).toMatchObject([{ reason: 'budget' }]);
    await until(() => events.some((event) => event.type === 'run_finished'), '실행 끝');
    expect(events.find((event) => event.type === 'run_finished')).toMatchObject({ status: 'cancelled', summary: expect.stringContaining('오늘 쓸 수 있는 토큰 한도') });
  });

  it('요청 시작은 같은 판정으로 저장된 합계가 한도 이상이면 409다', async () => {
    const { id } = await open();
    await mkdir(path.join(root, 'usage'), { recursive: true });
    const day = new Date();
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    await writeFile(usageFile(), JSON.stringify({ version: 1, periods: { [key]: { kim: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } } }));
    expect(() => ask(id)).toThrowError(expect.objectContaining({ status: 409, message: expect.stringContaining('오늘 쓸 수 있는 토큰 한도(1천)에 도달해 새 요청을 받지 않습니다') }));
    expect(fake.runs).toHaveLength(0);
  });
});

describe('사용량 파일이 깨졌을 때 한도는 조용히 꺼지지 않는다(결함 3)', () => {
  it('요청 시작은 읽지 못했다고 알리고 요청을 시작하지 않는다', async () => {
    const { id } = await open();
    await mkdir(path.join(root, 'usage'), { recursive: true });
    await writeFile(usageFile(), '{깨진');
    expect(() => ask(id)).toThrowError(/tokens\.json/);
    expect(fake.runs).toHaveLength(0);
    expect(getSnapshot(id)?.running).toBe(false);
  });

  it('실행 중에 깨지면 tokens 이벤트가 러너로 던지지 않고, 그 실행을 멈추고 되돌린다(한도 판정을 못 하므로 계속하지 않는다)', async () => {
    const { id, events } = await open();
    ask(id);
    await until(() => fake.runs.length === 1, '러너 시작');
    const run = fake.runs[0]!;
    await mkdir(path.join(root, 'usage'), { recursive: true });
    await writeFile(usageFile(), '{깨진');

    expect(() => run.emit(tokens(100))).not.toThrow();
    await until(() => run.signal.aborted, '멈춤');
    await until(() => events.some((event) => event.type === 'run_finished'), '실행 끝');
    expect(events.find((event) => event.type === 'run_finished')).toMatchObject({ status: 'cancelled', summary: expect.stringContaining('사람별 토큰 사용량 기록을 읽지 못해') });
    expect(getSnapshot(id)?.running).toBe(false);
    // 깨진 파일은 덮어쓰지 않는다
    expect(await readFile(usageFile(), 'utf8')).toBe('{깨진');
  });
});
