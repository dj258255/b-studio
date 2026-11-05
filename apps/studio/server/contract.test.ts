import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * b-terminal·studio desk가 기대는 계약, 바꾸면 b-terminal에 먼저 알린다(이슈 #1002).
 *
 * 별도 터미널 앱(b-terminal)과 `studio desk`는 같은 경로·같은 JSON 모양으로 스튜디오를 부른다(apps/cli/src/desk/client.ts).
 * 이 파일은 그 계약을 실제 HTTP로 고정한다: 서버(server/app.ts)를 임시 포트에 띄우고, 쿠키 `b_studio_local`·127.0.0.1·Origin 없음으로
 * 부른 응답을 zod 스키마로 확인한다. 스키마는 desk 클라이언트의 타입(apps/cli/src/desk/types.ts)에서 가져왔다.
 * 서버가 더 많은 키를 내도 되고(looseObject), 계약은 "읽는 키가 있고 형이 맞는 것"이다. 선택 키(?)는 선택으로 둔다.
 *
 * 2단계 목록(sessions/:id/events, fleets, task-plans 등)과 WebSocket 통로는 이번 범위가 아니다.
 *
 * 무엇이 진짜이고 무엇이 가짜인가(서버를 Rust로 다시 쓸 때 이 테스트의 HTTP 부분만 새 서버에 돌린다):
 * - 진짜: HTTP 서버·라우터·인증 판단·라우트 핸들러·세션 표(sessions.ts)·프로젝트 목록·AI 계정 목록·터미널 상태기계(session-terminal.ts)·
 *   목록 통로(agents-stream)·규칙으로 AI 고르기. 프로젝트와 상태 폴더는 임시 폴더다.
 * - 가짜: 샌드박스 제공자(도커 없음), CLI 로그인 확인(preflight), 터미널 백엔드(진짜 CLI·컨테이너 대신 가짜 터미널, 관문은 띄우지 않음),
 *   구독 한도 읽기(Keychain·네트워크 대신 고정 값).
 * - 못 한 것: 터미널의 첫 요청을 CLI가 받아 실행이 시작되는 길(`pasted: true`)은 CLI 훅이 필요해서 하지 않았다. 항목의
 *   `now`·`todos`·`context`·`lastMessage`·`terminal.waiting`·`costUsd`·`tokens`도 CLI 훅·텔레메트리가 채우는 값이라 값을 만들지 못했다.
 *   스키마에는 있으나(있으면 형을 본다) 이 테스트가 값을 실어 확인한 것은 아니다.
 */

const execFileAsync = promisify(execFile);

const fake = vi.hoisted(() => ({
  root: '',
  /** 켜면 샌드박스를 만드는 데서 던진다(시작에 실패한 세션 = 오류 상태, attention: 'error') */
  failBoot: false,
  /** 가짜 터미널이 쓴 입력과 지금까지 연 터미널 */
  terminals: [] as Array<{ id: string; written: string[]; sizes: Array<{ cols: number; rows: number }>; emit: (data: string) => void; exit: (code: number | null) => void }>,
  /** 가짜 구독 한도 읽기가 받은 refresh 값 */
  limitReads: [] as boolean[],
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-contract-fake',
    name: 'fake',
    async start() {
      if (fake.failBoot) throw new Error('가짜 제공자: 샌드박스를 켤 수 없습니다');
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
    async *logs() {},
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
    async destroy() {},
  } as unknown as Sandbox;
  return {
    ...actual,
    providerFromEnv: () => ({
      name: 'fake',
      isolation: undefined,
      create: async () => sandbox,
    }),
  };
});

// 진짜 CLI 로그인 확인을 부르지 않는다
vi.mock('@b-studio/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@b-studio/agent')>()),
  preflightClaudeCode: async () => ({ ok: true as const }),
  preflightCodex: async () => ({ ok: true as const }),
  fetchClaudeCodeModels: async () => {
    throw new Error('테스트에서는 실제 Claude Code를 부르지 않습니다');
  },
}));

// 터미널 백엔드만 가짜로 바꾼다. 상태기계(열기·구독·입력 상한·메시지)는 진짜 session-terminal.ts다.
vi.mock('@/lib/server/session-terminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/session-terminal')>();
  const backend: import('@/lib/server/session-terminal').TerminalBackend = {
    async prepare(target) {
      return `${target.sandboxId}-fake`;
    },
    open(_place, { id, size }) {
      let dataListener: ((chunk: Buffer) => void) | undefined;
      let exitListener: ((code: number | null) => void) | undefined;
      const record = {
        id,
        written: [] as string[],
        sizes: [{ cols: Number(size.cols), rows: Number(size.rows) }],
        emit: (data: string) => dataListener?.(Buffer.from(data)),
        exit: (code: number | null) => exitListener?.(code),
      };
      fake.terminals.push(record);
      return {
        id,
        write: (data: string) => {
          record.written.push(data);
        },
        resize: async (next: { cols: number; rows: number }) => {
          record.sizes.push({ cols: next.cols, rows: next.rows });
        },
        onData: (listener: (chunk: Buffer) => void) => {
          dataListener = listener;
        },
        onExit: (listener: (code: number | null) => void) => {
          exitListener = listener;
        },
        close: () => {},
      };
    },
    // 첫 요청을 CLI 실행 인자로 넘기는 방식이 아니다 → 터미널은 열고 pasted: false로 답한다
    acceptsInitialPrompt: false,
    async remove() {},
    async reachable() {
      return true;
    },
    unreachable: '가짜',
  };
  return {
    ...actual,
    terminalBackend: () => backend,
    terminalPause: () => undefined,
    disposeSessionTerminal: (sessionId: string, sandboxId: string) => actual.disposeSessionTerminal(sessionId, sandboxId, backend),
    removeTerminalLeftovers: () => Promise.resolve(),
    // 관문(로컬 서버)은 띄우지 않는다
    openSessionTerminal: (sessionId: string, target: import('@/lib/server/session-terminal').TerminalTarget, size: { cols?: unknown; rows?: unknown }, _backend?: unknown, options?: { initialPrompt?: string }) =>
      actual.openSessionTerminal(sessionId, { ...target, gateway: undefined }, size, backend, options),
  };
});

// Keychain·네트워크를 읽지 않게 한도 읽기만 가짜로 바꾼다. 계정 목록·이름 붙이기·상태 코드는 진짜 라우트다
vi.mock('@/lib/server/usage-limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/usage-limits')>();
  return {
    ...actual,
    usageLimits: () => ({
      read: async (accounts: Array<{ id: string; backend: string }>, options: { refresh?: boolean }) => {
        fake.limitReads.push(options.refresh === true);
        return accounts.map((account, index) => ({
          id: account.id,
          backend: account.backend,
          plan: 'Max',
          status: 'ok' as const,
          windows: [
            { kind: 'five_hour' as const, usedPercent: 12.5, resetsAt: '2026-11-05T05:00:00.000Z', minutes: 300 },
            { kind: 'weekly' as const, usedPercent: 40, resetsAt: '2026-11-09T00:00:00.000Z', minutes: 10080 },
          ],
          source: 'claude-oauth' as const,
          fetchedAt: '2026-11-05T00:00:00.000Z',
          stale: false,
          recommended: index === 0,
        }));
      },
    }),
  };
});

import { routes } from './routes.gen';
import { createStudioHandler } from './app';

// ─── 스키마: desk 클라이언트가 기대하는 모양(apps/cli/src/desk/types.ts) ───

const looseObject = z.looseObject;
const iso = z.string().min(1);

const usageSchema = looseObject({ inputTokens: z.number(), outputTokens: z.number() });

export const deskItemSchema = looseObject({
  kind: z.enum(['session', 'lane', 'fleet']),
  id: z.string().min(1),
  title: z.string(),
  projectName: z.string(),
  state: z.enum(['working', 'idle', 'booting', 'dormant', 'stopped', 'done', 'error']),
  attention: z.string().optional(),
  reason: z.string().optional(),
  backend: z.string().optional(),
  lastActivityAt: iso,
  workingSince: iso.optional(),
  terminal: looseObject({ cli: z.enum(['up', 'down']), waiting: z.enum(['permission', 'question', 'input', 'idle']).optional(), message: z.string().optional() }).optional(),
  gate: looseObject({ state: z.enum(['verifying', 'passed', 'failed', 'none']), checkpoints: z.number() }).optional(),
  costUsd: z.number().optional(),
  tokens: usageSchema.optional(),
  now: looseObject({ tool: z.string(), target: z.string().optional(), at: iso, running: z.boolean().optional(), error: z.string().optional() }).optional(),
  todos: looseObject({ done: z.number(), total: z.number(), current: z.string().optional() }).optional(),
  context: looseObject({ usedPct: z.number() }).optional(),
  lastMessage: z.string().optional(),
  accountId: z.string().optional(),
});

const agentsBodySchema = looseObject({ items: z.array(deskItemSchema) });

const agentsMessageSchema = z.discriminatedUnion('type', [
  looseObject({ type: z.literal('full'), items: z.array(deskItemSchema) }),
  looseObject({ type: z.literal('delta'), items: z.array(deskItemSchema), removed: z.array(z.string()), order: z.array(z.string()) }),
]);

const projectSchema = looseObject({ id: z.string().min(1), name: z.string(), error: z.string().optional(), folder: z.string().optional() });

const startResultSchema = looseObject({
  session: looseObject({ id: z.string().min(1) }),
  routing: looseObject({ backend: z.string().optional(), model: z.string().optional(), matched: z.string().optional() }).optional(),
  terminal: looseObject({ opened: z.boolean(), pasted: z.boolean(), pasteError: z.string().optional() }).optional(),
  sendError: z.string().optional(),
});

const terminalMessageSchema = z.discriminatedUnion('kind', [
  looseObject({ kind: z.literal('data'), data: z.string() }),
  looseObject({ kind: z.literal('status'), state: z.enum(['closed', 'opening', 'open']), message: z.string().optional() }),
  looseObject({ kind: z.literal('exit'), code: z.number().nullable() }),
  looseObject({ kind: z.literal('cli'), alive: z.boolean() }),
  looseObject({ kind: z.literal('warning'), message: z.string() }),
]);
const terminalEnvelopeSchema = looseObject({ id: z.string().min(1), message: terminalMessageSchema });

const accountLimitsSchema = looseObject({
  id: z.string().min(1),
  backend: z.string(),
  name: z.string().optional(),
  status: z.enum(['ok', 'warn', 'exhausted', 'idle', 'unknown', 'unsupported']),
  windows: z.array(looseObject({ kind: z.enum(['five_hour', 'weekly', 'other']), usedPercent: z.number(), resetsAt: z.string().optional(), minutes: z.number().optional() })),
  source: z.string(),
  fetchedAt: z.string().optional(),
  stale: z.boolean().optional(),
  error: z.string().optional(),
  recommended: z.boolean().optional(),
});

const accountSchema = looseObject({ id: z.string().min(1), name: z.string(), backend: z.string(), configDir: z.string().optional(), builtin: z.boolean().optional() });

const errorBodySchema = looseObject({ error: z.string().min(1) });

// ─── 서버와 손님 ───

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'B_STUDIO_MODE',
  'B_STUDIO_AUTH',
  'B_STUDIO_EXPERIMENTAL',
  'B_STUDIO_BACKENDS',
  'B_STUDIO_SESSIONS_DIR',
  'B_STUDIO_PROJECTS_DIR',
  'B_STUDIO_PROJECT_REGISTRY',
  'B_STUDIO_LOCAL_TOKEN_FILE',
  'B_STUDIO_BACKEND_RULES_FILE',
  'B_STUDIO_MODEL_DEFAULTS_FILE',
  'B_STUDIO_TERMINAL',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

let server: Server;
let origin = '';
let token = '';

/** b-terminal과 같은 연결: 쿠키 b_studio_local, 127.0.0.1, Origin 없음. cookie=false면 쿠키를 싣지 않는다 */
async function call(method: string, pathname: string, body?: unknown, options: { cookie?: boolean } = {}): Promise<{ status: number; json: unknown; headers: Headers }> {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: { ...(options.cookie === false ? {} : { cookie: `b_studio_local=${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: response.status, json, headers: response.headers };
}

interface Sse {
  /** 조건에 맞는 데이터 조각이 올 때까지 기다린다(지금까지 온 것도 본다). 시간 안에 오지 않으면 던진다 */
  until<T>(predicate: (data: unknown) => T | undefined, timeoutMs?: number): Promise<T>;
  /** 지금까지 받은 모든 조각 */
  seen: unknown[];
  headers: Headers;
  close(): void;
}

/** SSE 통로를 연다: `data:` 줄의 JSON만 모으고 주석 줄은 버린다 */
async function openSse(pathname: string): Promise<Sse> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${pathname}`, { headers: { cookie: `b_studio_local=${token}`, accept: 'text/event-stream' }, signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const seen: unknown[] = [];
  const waiters = new Set<() => void>();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let rest = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = rest.indexOf('\n\n')) >= 0) {
          const block = rest.slice(0, end);
          rest = rest.slice(end + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) seen.push(JSON.parse(data));
        }
        for (const wake of waiters) wake();
      }
    } catch {
      // 닫았다
    }
  })();
  return {
    seen,
    headers: response.headers,
    close: () => controller.abort(),
    until: (predicate, timeoutMs = 8_000) =>
      new Promise((resolve, reject) => {
        const check = (): boolean => {
          for (const data of seen) {
            const found = predicate(data);
            if (found !== undefined) {
              waiters.delete(check);
              clearTimeout(timer);
              resolve(found);
              return true;
            }
          }
          return false;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`기다린 조각이 오지 않았습니다. 받은 것: ${JSON.stringify(seen).slice(0, 600)}`));
        }, timeoutMs);
        if (!check()) waiters.add(check);
      }),
  };
}

async function waitForAttention(id: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const { json } = await call('GET', '/api/agents');
    if (agentsBodySchema.parse(json).items.find((entry) => entry.id === id)?.attention) return;
    if (Date.now() - started > 15_000) throw new Error(`세션 ${id}에 attention이 생기지 않았습니다`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForState(id: string, state: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const { json } = await call('GET', '/api/agents');
    const item = agentsBodySchema.parse(json).items.find((entry) => entry.id === id);
    if (item?.state === state) return;
    if (Date.now() - started > 15_000) throw new Error(`세션 ${id}가 ${state}가 되지 않았습니다 (${item?.state})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-contract-'));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'orders');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), 'version: 1\nname: orders\nservices:\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }\n');
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  const git = (...args: string[]) => execFileAsync('git', ['-C', project, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  await git('init', '-q', '-b', 'main');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  // 읽지 못하는 프로젝트(error 키가 있는 항목)
  await mkdir(path.join(projects, 'broken'), { recursive: true });
  await writeFile(path.join(projects, 'broken/studio.yaml'), 'version: [깨진\n');
  fake.root = project;

  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    B_STUDIO_MODE: 'claude-code',
    B_STUDIO_BACKENDS: 'claude-code,codex',
    B_STUDIO_AUTH: 'none',
    B_STUDIO_EXPERIMENTAL: '1',
    B_STUDIO_SESSIONS_DIR: path.join(root, 'sessions'),
    B_STUDIO_PROJECTS_DIR: projects,
    B_STUDIO_PROJECT_REGISTRY: path.join(root, 'projects.json'),
    B_STUDIO_LOCAL_TOKEN_FILE: path.join(root, 'local-token'),
    B_STUDIO_BACKEND_RULES_FILE: path.join(root, 'rules.json'),
    B_STUDIO_MODEL_DEFAULTS_FILE: path.join(root, 'models.json'),
    GIT_AUTHOR_NAME: 'verify',
    GIT_AUTHOR_EMAIL: 'verify@example.com',
    GIT_COMMITTER_NAME: 'verify',
    GIT_COMMITTER_EMAIL: 'verify@example.com',
  });
  delete process.env.B_STUDIO_TERMINAL;

  server = createServer(createStudioHandler({ routes, env: { B_STUDIO_AUTH: 'none' } }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 토큰 파일은 서버가 처음 토큰을 만들 때 생긴다. b-terminal처럼 그 파일을 읽어 쿠키로 싣는다
  await call('GET', '/api/health', undefined, { cookie: false });
  const { localToken } = await import('@/lib/server/local-token');
  localToken();
  token = (await readFile(process.env.B_STUDIO_LOCAL_TOKEN_FILE!, 'utf8')).trim();
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// ─── 계약 ───

let ruleSessionId = '';
let directSessionId = '';
let failedSessionId = '';

describe('계약: GET /api/health의 b-studio 표지', () => {
  it('status·app 표지와 apiVersion 1을 준다(인증·쿠키 없이도)', async () => {
    const { status, json } = await call('GET', '/api/health', undefined, { cookie: false });
    expect(status).toBe(200);
    expect(
      looseObject({ status: z.literal('ok'), app: z.literal('b-studio'), terminal: z.boolean(), apiVersion: z.literal(1) }).parse(json),
    ).toMatchObject({ status: 'ok', app: 'b-studio', apiVersion: 1 });
  });
});

describe('계약: GET /api/projects', () => {
  it('프로젝트 배열을 준다. 읽지 못한 프로젝트는 error를 싣는다', async () => {
    const { status, json } = await call('GET', '/api/projects');
    expect(status).toBe(200);
    const projects = z.array(projectSchema).parse(json);
    expect(projects.find((entry) => entry.id === 'orders')).toMatchObject({ id: 'orders', name: 'orders' });
    expect(projects.find((entry) => entry.id === 'orders')?.error).toBeUndefined();
    expect(projects.find((entry) => entry.id === 'broken')?.error).toEqual(expect.any(String));
  });
});

describe('계약: POST /api/sessions', () => {
  it('규칙으로 보내면 201과 {session:{id}, routing, terminal}을 준다(터미널은 열고 첫 요청은 넘기지 못한 경우)', async () => {
    const { status, json } = await call('POST', '/api/sessions', { projectId: 'orders', route: 'rules', request: '주문 목록 API를 만든다', intent: 'build', terminal: true });
    expect(status, JSON.stringify(json)).toBe(201);
    const result = startResultSchema.parse(json);
    ruleSessionId = result.session.id;
    expect(result.routing?.backend).toEqual(expect.any(String));
    expect(result.terminal).toMatchObject({ opened: true, pasted: false });
    expect(result.terminal?.pasteError).toEqual(expect.any(String));
    expect(result.sendError).toBeUndefined();
  });

  it('직접 고르면(route: direct + backend) 그 백엔드로 만든다', async () => {
    const { status, json } = await call('POST', '/api/sessions', { projectId: 'orders', route: 'direct', backend: 'claude-code', request: '주문 검증을 더한다', intent: 'build', terminal: true });
    expect(status, JSON.stringify(json)).toBe(201);
    const result = startResultSchema.parse(json);
    directSessionId = result.session.id;
    expect(result.routing?.backend).toBe('claude-code');
    expect(result.terminal?.opened).toBe(true);
  });

  it('계정을 함께 보낼 수 있다(규칙 모드와는 함께 보내지 않는다 → 400 {error})', async () => {
    const rejected = await call('POST', '/api/sessions', { projectId: 'orders', route: 'rules', accountId: 'claude-code', request: 'x', terminal: true });
    expect(rejected.status).toBe(400);
    errorBodySchema.parse(rejected.json);
    const accepted = await call('POST', '/api/sessions', { projectId: 'orders', route: 'direct', backend: 'claude-code', accountId: 'claude-code', request: '계정을 지정한다', intent: 'build', terminal: true });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(201);
    startResultSchema.parse(accepted.json);
  });

  it('오류는 {error: string}이다: projectId 없음 400, 없는 프로젝트 404', async () => {
    const missing = await call('POST', '/api/sessions', { route: 'rules', request: 'x', terminal: true });
    expect(missing.status).toBe(400);
    errorBodySchema.parse(missing.json);
    const unknown = await call('POST', '/api/sessions', { projectId: 'nope', route: 'rules', request: 'x', terminal: true });
    expect(unknown.status).toBe(404);
    errorBodySchema.parse(unknown.json);
  });

  it('샌드박스를 켜지 못한 세션도 만들어진다(이 세션은 아래 목록에서 오류 상태로 보인다)', async () => {
    const created = await call('POST', '/api/sessions', { projectId: 'orders', route: 'direct', backend: 'claude-code', request: '부팅이 실패한다', intent: 'build', terminal: true });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    failedSessionId = startResultSchema.parse(created.json).session.id;
    // 세션은 샌드박스를 지연 기동한다. 켜는 길(boot)에서 제공자가 실패하게 한다
    fake.failBoot = true;
    try {
      const boot = await call('POST', `/api/sessions/${failedSessionId}/boot`);
      // 켜기는 기다려서 답한다: 켜지 못하면 오류 응답({error})이고, 세션은 오류 상태로 남는다
      expect(boot.status).toBeGreaterThanOrEqual(400);
      errorBodySchema.parse(boot.json);
      await waitForAttention(failedSessionId);
    } finally {
      fake.failBoot = false;
    }
  });
});

describe('계약: GET /api/agents', () => {
  it('{items: DeskItem[]}를 준다', async () => {
    await waitForState(ruleSessionId, 'dormant').catch(() => undefined);
    const { status, json } = await call('GET', '/api/agents');
    expect(status).toBe(200);
    const body = agentsBodySchema.parse(json);
    const ids = body.items.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([ruleSessionId, directSessionId]));
    const item = body.items.find((entry) => entry.id === ruleSessionId)!;
    expect(item).toMatchObject({ kind: 'session', projectName: 'orders', backend: expect.any(String) });
    // 터미널을 연 세션은 terminal.cli를 싣는다
    expect(item.terminal?.cli).toMatch(/^(up|down)$/);
    expect(item.gate).toMatchObject({ state: expect.any(String), checkpoints: expect.any(Number) });
  });

  it('개입이 필요한 세션은 attention과 reason을 싣는다', async () => {
    const body = agentsBodySchema.parse((await call('GET', '/api/agents')).json);
    const item = body.items.find((entry) => entry.id === failedSessionId)!;
    expect(item.attention).toBe('error');
    expect(item.reason).toEqual(expect.any(String));
  });

  it('쿠키 없는 요청도 개인 PC 모드의 인증 판단을 지난다(목록은 로그인 판단만 본다)', async () => {
    const { status } = await call('GET', '/api/agents', undefined, { cookie: false });
    expect(status).toBe(200);
  });
});

describe('계약: GET /api/agents/stream (SSE)', () => {
  it('처음에 {type:"full", items}를, 바뀌면 {type:"delta", items, removed, order}를 보낸다', async () => {
    const stream = await openSse('/api/agents/stream');
    try {
      const full = await stream.until((data) => {
        const parsed = agentsMessageSchema.safeParse(data);
        return parsed.success && parsed.data.type === 'full' ? parsed.data : undefined;
      });
      expect(full.items.map((entry) => entry.id)).toEqual(expect.arrayContaining([ruleSessionId, directSessionId]));

      // 세션 이름을 바꾸면 그 항목이 조각으로 온다
      const renamed = await call('PATCH', `/api/sessions/${ruleSessionId}`, { label: '계약 확인용 이름' });
      expect(renamed.status).toBe(200);
      const delta = await stream.until((data) => {
        const parsed = agentsMessageSchema.safeParse(data);
        return parsed.success && parsed.data.type === 'delta' && parsed.data.items.some((entry) => entry.id === ruleSessionId) ? parsed.data : undefined;
      });
      expect(delta.removed).toEqual(expect.any(Array));
      expect(delta.order).toContain(ruleSessionId);
      expect(delta.items.find((entry) => entry.id === ruleSessionId)?.title).toContain('계약 확인용 이름');
    } finally {
      stream.close();
    }
  });
});

describe('계약: POST /api/sessions/:id/terminal', () => {
  it('open·resize를 {ok:true}로 받는다', async () => {
    const opened = await call('POST', `/api/sessions/${directSessionId}/terminal`, { action: 'open', cols: 100, rows: 30 });
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ ok: true });
    const resized = await call('POST', `/api/sessions/${directSessionId}/terminal`, { action: 'resize', cols: 132, rows: 43 });
    expect(resized.status).toBe(200);
    expect(resized.json).toMatchObject({ ok: true });
    const terminal = fake.terminals.find((entry) => entry.written !== undefined && entry.sizes.some((size) => size.cols === 132 && size.rows === 43));
    expect(terminal).toBeDefined();
  });

  it('input은 64KiB 조각을 받고 순서대로 터미널에 닿는다', async () => {
    const chunk = 'a'.repeat(64 * 1024);
    for (const data of [chunk, 'b'.repeat(64 * 1024), '한글 입력\r']) {
      const { status, json } = await call('POST', `/api/sessions/${directSessionId}/terminal`, { action: 'input', data });
      expect(status).toBe(200);
      expect(json).toMatchObject({ ok: true });
    }
    const terminal = fake.terminals.find((entry) => entry.written.includes('한글 입력\r'))!;
    expect(terminal.written.slice(-3).map((data) => data.length)).toEqual([64 * 1024, 64 * 1024, '한글 입력\r'.length]);
  });

  it('서버 상한은 256KiB(262144자)다: 상한까지는 받고 넘으면 400 {error}', async () => {
    const atLimit = await call('POST', `/api/sessions/${directSessionId}/terminal`, { action: 'input', data: 'x'.repeat(256 * 1024) });
    expect(atLimit.status).toBe(200);
    const over = await call('POST', `/api/sessions/${directSessionId}/terminal`, { action: 'input', data: 'x'.repeat(256 * 1024 + 1) });
    expect(over.status).toBe(400);
    errorBodySchema.parse(over.json);
  });

  it('모양이 틀린 요청 400, 쿠키 없는 요청 403, 없는 세션은 {error}', async () => {
    const wrong = await call('POST', `/api/sessions/${directSessionId}/terminal`, { action: 'exec', command: 'x' });
    expect(wrong.status).toBe(400);
    errorBodySchema.parse(wrong.json);
    const noCookie = await call('POST', `/api/sessions/${directSessionId}/terminal`, { action: 'resize', cols: 80, rows: 24 }, { cookie: false });
    expect(noCookie.status).toBe(403);
    errorBodySchema.parse(noCookie.json);
    const none = await call('POST', '/api/sessions/없는-세션/terminal', { action: 'resize', cols: 80, rows: 24 });
    expect(none.status).toBeGreaterThanOrEqual(400);
    errorBodySchema.parse(none.json);
  });
});

describe('계약: GET /api/terminals/stream?ids= (SSE)', () => {
  it('{id, message}로 싣는다: status·cli는 구독하자마자, data·exit·warning은 일어날 때', async () => {
    const stream = await openSse(`/api/terminals/stream?ids=${directSessionId},${ruleSessionId}`);
    try {
      const messages = () => stream.seen.map((data) => terminalEnvelopeSchema.parse(data));
      await stream.until((data) => {
        const parsed = terminalEnvelopeSchema.safeParse(data);
        return parsed.success && parsed.data.id === directSessionId && parsed.data.message.kind === 'cli' ? true : undefined;
      });
      expect(messages().some((entry) => entry.id === directSessionId && entry.message.kind === 'status' && entry.message.state === 'open')).toBe(true);

      const terminal = fake.terminals.find((entry) => entry.written.length > 0)!;
      terminal.emit('hello');
      const data = await stream.until((raw) => {
        const parsed = terminalEnvelopeSchema.safeParse(raw);
        return parsed.success && parsed.data.message.kind === 'data' && Buffer.from(parsed.data.message.data, 'base64').toString().includes('hello') ? parsed.data : undefined;
      });
      expect(data.id).toBe(directSessionId);

      const { noteSessionTerminalCli, warnSessionTerminal } = await import('@/lib/server/session-terminal');
      noteSessionTerminalCli(directSessionId, true);
      await stream.until((raw) => {
        const parsed = terminalEnvelopeSchema.safeParse(raw);
        return parsed.success && parsed.data.message.kind === 'cli' && parsed.data.message.alive ? true : undefined;
      });
      warnSessionTerminal(directSessionId, '관문 파일이 바뀌었습니다');
      await stream.until((raw) => {
        const parsed = terminalEnvelopeSchema.safeParse(raw);
        return parsed.success && parsed.data.message.kind === 'warning' && parsed.data.message.message === '관문 파일이 바뀌었습니다' ? true : undefined;
      });

      terminal.exit(0);
      await stream.until((raw) => {
        const parsed = terminalEnvelopeSchema.safeParse(raw);
        return parsed.success && parsed.data.message.kind === 'exit' && parsed.data.message.code === 0 ? true : undefined;
      });
    } finally {
      stream.close();
    }
  });

  it('쿠키 없는 연결은 SSE가 아니라 403 {error}다', async () => {
    const { status, json } = await call('GET', `/api/terminals/stream?ids=${directSessionId}`, undefined, { cookie: false });
    expect(status).toBe(403);
    errorBodySchema.parse(json);
  });

  it('없는 id는 통로를 닫지 않고 그 id만 status: closed로 알린다', async () => {
    const stream = await openSse(`/api/terminals/stream?ids=없는-세션,${ruleSessionId}`);
    try {
      await stream.until((raw) => {
        const parsed = terminalEnvelopeSchema.safeParse(raw);
        return parsed.success && parsed.data.id === '없는-세션' && parsed.data.message.kind === 'status' && parsed.data.message.state === 'closed' ? true : undefined;
      });
      await stream.until((raw) => {
        const parsed = terminalEnvelopeSchema.safeParse(raw);
        return parsed.success && parsed.data.id === ruleSessionId ? true : undefined;
      });
    } finally {
      stream.close();
    }
  });
});

describe('계약: PATCH·resume·DELETE /api/sessions/:id', () => {
  it('PATCH {label}는 200과 이름이 바뀐 세션을 준다', async () => {
    const { status, json } = await call('PATCH', `/api/sessions/${directSessionId}`, { label: '이름 바꿈' });
    expect(status).toBe(200);
    expect(looseObject({ id: z.literal(directSessionId) }).parse(json)).toBeDefined();
    const bad = await call('PATCH', `/api/sessions/${directSessionId}`, { label: 7 });
    expect(bad.status).toBe(400);
    errorBodySchema.parse(bad.json);
  });

  it('DELETE는 멈추고 200, 멈춘 세션을 resume하면 202', async () => {
    const stopped = await call('DELETE', `/api/sessions/${directSessionId}`);
    expect(stopped.status).toBe(200);
    expect(looseObject({ id: z.literal(directSessionId) }).parse(stopped.json)).toBeDefined();
    await waitForState(directSessionId, 'stopped');
    const resumed = await call('POST', `/api/sessions/${directSessionId}/resume`);
    expect(resumed.status).toBe(202);
    expect(looseObject({ id: z.literal(directSessionId) }).parse(resumed.json)).toBeDefined();
  });

  it('없는 세션은 {error: string}으로 거절한다', async () => {
    for (const [method, pathname] of [['DELETE', '/api/sessions/없는-세션'], ['POST', '/api/sessions/없는-세션/resume']] as const) {
      const { status, json } = await call(method, pathname);
      expect(status, `${method} ${pathname}`).toBeGreaterThanOrEqual(400);
      errorBodySchema.parse(json);
    }
  });
});

describe('계약: GET /api/usage/limits', () => {
  it('{accounts: DeskAccountLimits[]}를 준다. ?refresh=1은 다시 읽기를 청한다', async () => {
    const plain = await call('GET', '/api/usage/limits');
    expect(plain.status).toBe(200);
    const body = looseObject({ accounts: z.array(accountLimitsSchema).min(1), warning: z.string().optional() }).parse(plain.json);
    expect(body.accounts[0]).toMatchObject({ id: expect.any(String), backend: expect.any(String), name: expect.any(String) });
    expect(body.accounts.filter((account) => account.recommended === true)).toHaveLength(1);
    const refreshed = await call('GET', '/api/usage/limits?refresh=1');
    expect(refreshed.status).toBe(200);
    looseObject({ accounts: z.array(accountLimitsSchema) }).parse(refreshed.json);
    expect(fake.limitReads.slice(-2)).toEqual([false, true]);
  });
});

describe('계약: GET /api/ai-accounts', () => {
  it('{accounts}를 준다: CLI마다 기본 계정이 있다', async () => {
    const { status, json } = await call('GET', '/api/ai-accounts');
    expect(status).toBe(200);
    const body = looseObject({ accounts: z.array(accountSchema).min(1) }).parse(json);
    expect(body.accounts.map((account) => account.backend)).toContain('claude-code');
  });
});

describe('계약: 오류 본문', () => {
  it('없는 경로·없는 메서드는 {error: string}이다', async () => {
    const notFound = await call('GET', '/api/없는-경로');
    expect(notFound.status).toBe(404);
    errorBodySchema.parse(notFound.json);
    const method = await call('PUT', '/api/agents');
    expect(method.status).toBe(405);
    errorBodySchema.parse(method.json);
  });
});
