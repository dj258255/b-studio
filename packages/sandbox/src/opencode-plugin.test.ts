import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENCODE_PLUGIN, OPENCODE_PLUGIN_NAME } from './opencode-plugin';

/**
 * OpenCode의 플러그인 파일(관문 폴더에 쓰는 글)을 **진짜로 불러** 훅 함수를 직접 부른다. 진짜 opencode도 모델도 띄우지 않는다.
 * 가짜는 플러그인 입력(`client`·`directory` 등)과 관문의 훅 서버(작은 로컬 HTTP 서버)뿐이다. OpenCode가 훅을 어떻게 부르는지는 설치된 1.18.33의 소스에서 읽은 대로 흉내 냈다
 * (`tool.execute.before`가 던지면 도구가 실행되지 않는다, `event`는 기다려 주지 않는다, 모듈의 내보내기는 함수만 받는다).
 * 서버가 어떻게 판정하는지는 여기서 보지 않는다(studio의 시험이 진짜 판정 코드로 본다). 여기서는 플러그인이 닫힘으로 실패하는지 본다.
 */

const TOKEN = 'test-token-0123456789';
const dirs: string[] = [];
const servers: Server[] = [];
const envBefore = { gateway: process.env.B_STUDIO_GATEWAY_DIR, timeout: process.env.B_STUDIO_MOD_TIMEOUT_MS };

beforeEach(() => {
  delete process.env.B_STUDIO_MOD_TIMEOUT_MS;
});
afterEach(async () => {
  for (const server of servers.splice(0)) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  for (const [key, value] of [
    ['B_STUDIO_GATEWAY_DIR', envBefore.gateway],
    ['B_STUDIO_MOD_TIMEOUT_MS', envBefore.timeout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Seen {
  event: string;
  token: string | undefined;
  body: Record<string, unknown>;
}
type Reply = { status?: number; body?: unknown; raw?: string; hang?: boolean };
async function gateway(replies: Record<string, Reply | ((body: Record<string, unknown>) => Reply)>): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const event = (request.url ?? '').slice(1);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      seen.push({ event, token: request.headers.authorization?.replace(/^Bearer /, ''), body });
      const entry = replies[event];
      const reply = typeof entry === 'function' ? entry(body) : entry;
      if (!reply || reply.hang) {
        if (!reply) response.writeHead(404).end();
        return;
      }
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function gatewayDir(address: { url: string; token?: string } | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-ocplug-'));
  dirs.push(dir);
  await writeFile(path.join(dir, OPENCODE_PLUGIN_NAME), OPENCODE_PLUGIN);
  if (address) await writeFile(path.join(dir, 'b-studio-gateway.json'), `${JSON.stringify({ url: address.url, token: address.token ?? TOKEN })}\n`);
  process.env.B_STUDIO_GATEWAY_DIR = dir;
  return dir;
}

type Hook = (...args: any[]) => any;
interface Loaded {
  hooks: Record<string, Hook>;
  /** 플러그인이 `client.session.promptAsync`로 보낸 글 */
  prompted: Array<{ id: string; text: string }>;
  toasts: string[];
  moduleExports: string[];
  /** 설정 훅을 부른다. 기본은 우리 플러그인 하나만 든 설정(정상) */
  configure(plugin?: unknown): Promise<void>;
  fire(type: string, properties: unknown): Promise<void>;
  sessionLookups: string[];
}

interface LoadOptions {
  /** `promptAsync`가 이렇게 답한다 */
  promptAsync?: 'ok' | 'error-result' | 'throws';
  /** `session.get`이 알려 주는 parentID(없으면 루트) */
  parents?: Record<string, string | undefined>;
  noClient?: boolean;
}

async function load(dir: string, options: LoadOptions = {}): Promise<Loaded> {
  const copy = path.join(dir, `loaded-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(copy, OPENCODE_PLUGIN);
  const loaded = (await import(/* @vite-ignore */ copy)) as Record<string, unknown>;
  const prompted: Array<{ id: string; text: string }> = [];
  const toasts: string[] = [];
  const sessionLookups: string[] = [];
  const client = {
    session: {
      promptAsync: async (request: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) => {
        if (options.promptAsync === 'throws') throw new Error('연결이 끊겼다');
        if (options.promptAsync === 'error-result') return { data: undefined, error: { name: 'NotFoundError' } };
        prompted.push({ id: request.path.id, text: request.body.parts.map((part) => part.text).join('') });
        return { data: undefined, error: undefined };
      },
      get: async (request: { path: { id: string } }) => {
        sessionLookups.push(request.path.id);
        return { data: { id: request.path.id, parentID: options.parents?.[request.path.id] }, error: undefined };
      },
    },
    tui: { showToast: async (request: { body: { message: string } }) => void toasts.push(request.body.message) },
  };
  const factory = loaded.default as (input: unknown, options?: unknown) => Promise<Record<string, Hook>>;
  const hooks = await factory({ ...(options.noClient ? {} : { client }), project: { id: 'p' }, directory: '/work', worktree: '/work', serverUrl: new URL('http://localhost:4096') });
  return {
    hooks,
    prompted,
    toasts,
    sessionLookups,
    moduleExports: Object.keys(loaded),
    configure: async (plugin) => {
      const ours = pathToFileURL(path.join(dir, OPENCODE_PLUGIN_NAME)).href;
      await hooks.config!({ plugin: [plugin === undefined ? ours : plugin] });
    },
    fire: async (type, properties) => {
      await hooks.event!({ event: { id: 'evt', type, properties } });
    },
  };
}

const before = (tool: string, args: unknown, callID = 'call-1') => [{ tool, sessionID: 'ses_1', callID }, { args }] as const;
const eventually = async (check: () => boolean): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 3000) throw new Error('기다리던 요청이 오지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('플러그인 파일의 모양', () => {
  it('의존성 없는 한 파일이다: 가져오는 것은 node 내장뿐이고, 토큰이나 주소를 글자로 박지 않는다', () => {
    const imports = [...OPENCODE_PLUGIN.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier, specifier).toMatch(/^node:/);
    expect(OPENCODE_PLUGIN).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(OPENCODE_PLUGIN).not.toContain(TOKEN);
    // 모델 고르기·권한을 건너뛰는 인자를 다루지 않는다
    expect(OPENCODE_PLUGIN).not.toMatch(/--model|dangerously|skip-permissions/);
  });

  it('내보내기는 기본 함수 하나뿐이다: 함수가 아닌 내보내기가 있으면 OpenCode가 플러그인을 불러오지 않는다(설치된 1.18.33의 `Plugin export is not a function`)', async () => {
    const dir = await gatewayDir(undefined);
    const plugin = await load(dir);
    expect(plugin.moduleExports).toEqual(['default']);
  });

  it('설치된 1.18.33의 훅 이름만 등록한다', async () => {
    const dir = await gatewayDir(undefined);
    const { hooks } = await load(dir);
    const documented = new Set(['event', 'config', 'tool', 'auth', 'provider', 'chat.message', 'chat.params', 'chat.headers', 'permission.ask', 'command.execute.before', 'tool.execute.before', 'shell.env', 'tool.execute.after', 'experimental.chat.messages.transform', 'experimental.chat.system.transform', 'experimental.provider.small_model', 'experimental.session.compacting', 'experimental.compaction.autocontinue', 'experimental.text.complete', 'tool.definition', 'dispose']);
    for (const name of Object.keys(hooks)) expect(documented.has(name), name).toBe(true);
    for (const name of ['config', 'event', 'chat.message', 'tool.execute.before', 'tool.execute.after', 'dispose']) expect(typeof hooks[name], name).toBe('function');
  });
});

describe('설정 확인과 세션 시작 신호', () => {
  it('설정에 우리 플러그인 하나뿐이면 세션 시작 신호를 보낸다', async () => {
    const server = await gateway({ 'session-start': { body: { systemMessage: '안내' } } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await eventually(() => server.seen.some((request) => request.event === 'session-start'));
    expect(server.seen.find((request) => request.event === 'session-start')?.body).toMatchObject({ hook_event_name: 'SessionStart', source: 'startup', cwd: '/work' });
  });

  it('설정에 다른 플러그인이 하나라도 있으면 신호를 보내지 않고 모든 도구를 막는다(읽기 도구도)', async () => {
    const server = await gateway({ 'pre-tool': { body: {} }, 'session-start': { body: {} } });
    const dir = await gatewayDir(server);
    for (const config of [
      ['file:///somewhere/else.js'],
      [pathToFileURL(path.join(dir, OPENCODE_PLUGIN_NAME)).href, 'opencode-other@1.0.0'],
      [[pathToFileURL(path.join(dir, OPENCODE_PLUGIN_NAME)).href, {}], ['npm-plugin', {}]],
      [],
    ]) {
      const plugin = await load(dir);
      await plugin.hooks.config!({ plugin: config });
      await expect(plugin.hooks['tool.execute.before']!(...before('read', { filePath: 'a' }))).rejects.toThrow(/플러그인/);
    }
    expect(server.seen.filter((request) => request.event === 'session-start')).toEqual([]);
    expect(server.seen.filter((request) => request.event === 'pre-tool')).toEqual([]);
  });

  it('plugin_origins에 다른 출처가 있어도 막는다', async () => {
    const server = await gateway({ 'session-start': { body: {} } });
    const dir = await gatewayDir(server);
    const ours = pathToFileURL(path.join(dir, OPENCODE_PLUGIN_NAME)).href;
    const plugin = await load(dir);
    await plugin.hooks.config!({ plugin: [ours], plugin_origins: [{ spec: ours, source: 'x', scope: 'global' }, { spec: 'file:///evil.js', source: 'y', scope: 'local' }] });
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow();
    expect(server.seen).toEqual([]);
  });

  it('설정이 이상한 모양(배열이 아님·없음)이면 막는다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const dir = await gatewayDir(server);
    for (const config of [undefined, null, {}, { plugin: 'x' }, { plugin: [1] }]) {
      const plugin = await load(dir);
      await plugin.hooks.config!(config);
      await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow();
    }
    expect(server.seen).toEqual([]);
  });

  it('설정 확인이 돌기 전에는 도구를 막는다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow();
    expect(server.seen).toEqual([]);
  });
});

describe('쓰기 직전(tool.execute.before): 모든 실패는 던져서 막는다', () => {
  it('관문이 허용하면 던지지 않고, 도구 이름·입력·호출 id·작업 폴더를 /pre-tool로 보낸다(토큰은 주소 파일에서)', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'src/a.ts', oldString: 'a', newString: 'b' }, 'call-9'))).resolves.toBeUndefined();
    const sent = server.seen.find((request) => request.event === 'pre-tool')!;
    expect(sent.token).toBe(TOKEN);
    expect(sent.body).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'edit', tool_input: { filePath: 'src/a.ts', oldString: 'a', newString: 'b' }, tool_use_id: 'call-9', cwd: '/work' });
  });

  it('관문이 거절하면 그 사유를 담아 던진다', async () => {
    const server = await gateway({ 'pre-tool': { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[b-studio] 범위 밖입니다' } } } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.before']!(...before('write', { filePath: '/etc/x', content: '' }))).rejects.toThrow('[b-studio] 범위 밖입니다');
  });

  it.each([
    ['HTTP 500', { status: 500, body: {} }],
    ['HTTP 404(길이 없다)', undefined],
    ['JSON이 아닌 응답', { raw: 'not json' }],
    ['빈 응답', { raw: '' }],
    ['배열 응답', { body: [] }],
    ['모르는 필드', { body: { surprise: true } }],
    ['allow 결정(우리 관문은 내지 않는다)', { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'ok' } } }],
    ['ask 결정', { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'ok' } } }],
    ['사유가 빈 거절', { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '' } } }],
    ['이벤트 이름이 다른 거절', { body: { hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'deny', permissionDecisionReason: 'x' } } }],
    ['거절 옆에 모르는 필드', { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' }, extra: 1 } }],
    ['systemMessage가 글이 아님', { body: { systemMessage: 3 } }],
  ] as Array<[string, Reply | undefined]>)('%s이면 던진다', async (_name, reply) => {
    const server = await gateway(reply === undefined ? {} : { 'pre-tool': reply });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow(/관문|응답|HTTP|막았습니다|\[b-studio\]/);
  });

  it('관문 주소 파일이 없거나 이상하면 던진다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const dir = await gatewayDir(undefined);
    const plugin = await load(dir);
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow();
    for (const text of ['not json', '[]', JSON.stringify({ url: server.url }), JSON.stringify({ token: 't' }), JSON.stringify({ url: 'http://example.com:80', token: 't' }), JSON.stringify({ url: 'https://127.0.0.1:1', token: 't' }), JSON.stringify({ url: 'http://user:pw@127.0.0.1:1', token: 't' })]) {
      await writeFile(path.join(dir, 'b-studio-gateway.json'), text);
      await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' })), text).rejects.toThrow();
    }
    expect(server.seen).toEqual([]);
  });

  it('열려 있는 서버여도 주소가 127.0.0.1이 아니면(localhost 이름·다른 포트 표기) 보내지 않고 던진다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const dir = await gatewayDir(server);
    const plugin = await load(dir);
    await plugin.configure();
    const port = new URL(server.url).port;
    for (const url of [`http://localhost:${port}`, `http://[::1]:${port}`, `http://0.0.0.0:${port}`]) {
      await writeFile(path.join(dir, 'b-studio-gateway.json'), JSON.stringify({ url, token: TOKEN }));
      await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' })), url).rejects.toThrow(/루프백/);
    }
    expect(server.seen.filter((request) => request.event === 'pre-tool')).toEqual([]);
  });

  it('관문 폴더 환경 변수가 없거나 상대 경로면 던진다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    delete process.env.B_STUDIO_GATEWAY_DIR;
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow();
    process.env.B_STUDIO_GATEWAY_DIR = 'relative/dir';
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow();
  });

  it('관문이 닫혀 연결하지 못하면 던진다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await server.close();
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow(/관문에 닿지 못해/);
  });

  it('틀린 토큰으로 관문이 거절(HTTP 오류)하면 던진다', async () => {
    const server = await gateway({ 'pre-tool': { status: 401, body: { error: 'unauthorized' } } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow(/401/);
  });

  it('답이 없어 시간이 지나면 던진다(시간 상한은 낮추기만 할 수 있다)', async () => {
    const server = await gateway({ 'pre-tool': { hang: true } });
    // 상한은 플러그인을 불러올 때 읽는다
    process.env.B_STUDIO_MOD_TIMEOUT_MS = '150';
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    const started = Date.now();
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow(/시간 초과/);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('입력을 직렬화하지 못하면(순환·BigInt) 던진다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', cycle))).rejects.toThrow();
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { big: 1n }))).rejects.toThrow();
    expect(server.seen).toEqual([]);
  });

  it('훅 인자가 이상하면(도구 이름이 글이 아님·인자 없음) 던진다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.before']!({ tool: 3, sessionID: 's', callID: 'c' }, { args: {} })).rejects.toThrow();
    await expect(plugin.hooks['tool.execute.before']!({ tool: '', sessionID: 's', callID: 'c' }, { args: {} })).rejects.toThrow();
    await expect(plugin.hooks['tool.execute.before']!(undefined, undefined)).rejects.toThrow();
    await expect(plugin.hooks['tool.execute.before']!({ tool: 'edit', sessionID: 's', callID: 'c' }, undefined)).rejects.toThrow();
    expect(server.seen).toEqual([]);
  });

  it('관문의 안내 글(systemMessage)은 알림으로만 보이고 도구는 막지 않는다', async () => {
    const server = await gateway({ 'pre-tool': { body: { systemMessage: '샌드박스를 켰습니다' } } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.before']!(...before('bash', { command: 'ls' }))).resolves.toBeUndefined();
    await eventually(() => plugin.toasts.length > 0);
    expect(plugin.toasts).toEqual(['샌드박스를 켰습니다']);
  });
});

describe('요청 받기(chat.message)', () => {
  const message = (text: string, extra: Record<string, unknown> = {}) => [{ sessionID: 'ses_1', agent: 'build' }, { message: { id: 'm' }, parts: [{ type: 'text', text, ...extra }] }] as const;

  it('요청 글을 /prompt로 보낸다. 맥락 글이 오면 요청 뒤에 덧붙인다', async () => {
    const server = await gateway({ prompt: { body: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[읽기만] 표시' } } } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    const [input, output] = message('파일을 고쳐 줘');
    await plugin.hooks['chat.message']!(input, output);
    expect(server.seen.find((request) => request.event === 'prompt')?.body).toEqual({ hook_event_name: 'UserPromptSubmit', prompt: '파일을 고쳐 줘', cwd: '/work' });
    expect(output.parts[0]!.text).toBe('파일을 고쳐 줘\n\n[읽기만] 표시');
  });

  it('서버가 요청을 막으면 그 사유로 던진다(요청은 저장되지 않는다)', async () => {
    const server = await gateway({ prompt: { body: { decision: 'block', reason: '[b-studio] 토큰 한도를 넘었습니다' } } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['chat.message']!(...message('안녕'))).rejects.toThrow('[b-studio] 토큰 한도를 넘었습니다');
  });

  it.each([
    ['닿지 못함', undefined],
    ['HTTP 500', { status: 500, body: {} }],
    ['JSON 아님', { raw: '<html>' }],
    ['모르는 필드', { body: { foo: 1 } }],
    ['사유 없는 block', { body: { decision: 'block' } }],
    ['모르는 결정', { body: { decision: 'approve', reason: 'x' } }],
  ] as Array<[string, Reply | undefined]>)('%s이면 요청을 보내지 않고 던진다', async (_name, reply) => {
    const server = await gateway(reply === undefined ? {} : { prompt: reply });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['chat.message']!(...message('안녕'))).rejects.toThrow(/요청을 보내지 않았습니다/);
  });

  it('요청의 글을 읽을 수 없으면(parts가 없음) 던진다', async () => {
    const server = await gateway({ prompt: { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['chat.message']!({ sessionID: 'ses_1' }, { message: {}, parts: undefined })).rejects.toThrow();
    expect(server.seen.filter((request) => request.event === 'prompt')).toEqual([]);
  });

  it('하위 에이전트(parentID가 있는 세션)의 요청은 사용자의 요청이 아니라서 보내지 않는다', async () => {
    const server = await gateway({ prompt: { body: {} } });
    const plugin = await load(await gatewayDir(server), { parents: { child_1: 'ses_1' } });
    await plugin.configure();
    await plugin.fire('session.created', { info: { id: 'ses_1' } });
    await plugin.fire('session.created', { info: { id: 'child_1', parentID: 'ses_1' } });
    await plugin.hooks['chat.message']!({ sessionID: 'child_1' }, { message: {}, parts: [{ type: 'text', text: '하위 작업' }] });
    expect(server.seen.filter((request) => request.event === 'prompt')).toEqual([]);
    // 알지 못하는 세션은 물어서 안다(재개한 세션은 created 소식이 없다)
    await plugin.hooks['chat.message']!({ sessionID: 'child_1' }, { message: {}, parts: [{ type: 'text', text: '하위 작업' }] });
    const other = await load(await gatewayDir(server), { parents: { child_2: 'ses_9' } });
    await other.configure();
    await other.hooks['chat.message']!({ sessionID: 'child_2' }, { message: {}, parts: [{ type: 'text', text: '하위 작업' }] });
    expect(other.sessionLookups).toEqual(['child_2']);
    expect(server.seen.filter((request) => request.event === 'prompt')).toEqual([]);
  });
});

describe('쓰기 뒤(tool.execute.after)와 끝', () => {
  it('도구의 끝을 /activity로 지켜보기만 한다: 출력은 보내지 않고, 던지지 않는다', async () => {
    const server = await gateway({ activity: { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.after']!({ tool: 'edit', sessionID: 's', callID: 'c1', args: { filePath: 'a' } }, { title: 't', output: '비밀 출력', metadata: {} })).resolves.toBeUndefined();
    await eventually(() => server.seen.some((request) => request.event === 'activity'));
    const sent = server.seen.find((request) => request.event === 'activity')!;
    expect(sent.body).toEqual({ hook_event_name: 'PostToolUse', tool_name: 'edit', tool_input: { filePath: 'a' }, tool_use_id: 'c1', cwd: '/work' });
    expect(JSON.stringify(sent.body)).not.toContain('비밀 출력');
  });

  it('관문이 닫혀 있어도 던지지 않는다', async () => {
    const server = await gateway({});
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await server.close();
    await expect(plugin.hooks['tool.execute.after']!({ tool: 'edit', sessionID: 's', callID: 'c1', args: {} }, { output: '' })).resolves.toBeUndefined();
    await expect(plugin.hooks['tool.execute.after']!(undefined, undefined)).resolves.toBeUndefined();
  });

  it('dispose는 /session-end를 보내고 던지지 않는다', async () => {
    const server = await gateway({ 'session-end': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await plugin.hooks.dispose!();
    expect(server.seen.some((request) => request.event === 'session-end')).toBe(true);
    await server.close();
    await expect(plugin.hooks.dispose!()).resolves.toBeUndefined();
  });
});

describe('턴 끝(session.idle): OpenCode에는 턴 끝을 막는 훅이 없어 게이트 실패를 다음 요청으로 보낸다', () => {
  const idle = (plugin: Loaded, sessionID = 'ses_1') => plugin.fire('session.idle', { sessionID });

  async function ready(replies: Record<string, Reply | ((body: Record<string, unknown>) => Reply)>, options: LoadOptions = {}) {
    const server = await gateway({ 'session-start': { body: {} }, ...replies });
    const plugin = await load(await gatewayDir(server), options);
    await plugin.configure();
    await plugin.fire('session.created', { info: { id: 'ses_1' } });
    return { server, plugin };
  }

  it('게이트가 통과하면 /stop만 부르고 요청을 보내지 않는다. 마지막 답 글을 함께 보낸다', async () => {
    const { server, plugin } = await ready({ stop: { body: { systemMessage: '통과했습니다' } } });
    await plugin.fire('message.updated', { info: { id: 'm1', sessionID: 'ses_1', role: 'assistant' } });
    await plugin.fire('message.part.updated', { part: { id: 'p1', messageID: 'm1', sessionID: 'ses_1', type: 'text', text: '끝냈습니다.' } });
    await idle(plugin);
    expect(server.seen.find((request) => request.event === 'stop')?.body).toEqual({ hook_event_name: 'Stop', last_assistant_message: '끝냈습니다.', cwd: '/work' });
    expect(plugin.prompted).toEqual([]);
    expect(plugin.toasts).toEqual(['통과했습니다']);
  });

  it('게이트가 돌려보내면 그 사유를 같은 세션의 다음 요청으로 보낸다. 그 요청은 사용자의 새 요청이 아니라서 /prompt를 거치지 않는다', async () => {
    const { server, plugin } = await ready({ stop: { body: { decision: 'block', reason: '[b-studio] 테스트가 실패했습니다: OrderTest' } }, prompt: { body: {} } });
    await idle(plugin);
    expect(plugin.prompted).toEqual([{ id: 'ses_1', text: '[b-studio] 테스트가 실패했습니다: OrderTest' }]);
    // 보낸 글이 요청 받기 훅으로 돌아온다: 서버에는 새 요청으로 알리지 않는다
    await plugin.hooks['chat.message']!({ sessionID: 'ses_1' }, { message: {}, parts: [{ type: 'text', text: '[b-studio] 테스트가 실패했습니다: OrderTest' }] });
    expect(server.seen.filter((request) => request.event === 'prompt')).toEqual([]);
    // 같은 글을 사용자가 다시 치면 새 요청이다(한 번만 건너뛴다)
    await plugin.hooks['chat.message']!({ sessionID: 'ses_1' }, { message: {}, parts: [{ type: 'text', text: '[b-studio] 테스트가 실패했습니다: OrderTest' }] });
    expect(server.seen.filter((request) => request.event === 'prompt')).toHaveLength(1);
  });

  it('사유를 보내지 못하면(응답 오류·던짐·client 없음) 통과로 읽지 않고 실패로 닫는다(stop-failure)', async () => {
    for (const options of [{ promptAsync: 'error-result' as const }, { promptAsync: 'throws' as const }, { noClient: true }]) {
      const { server, plugin } = await ready({ stop: { body: { decision: 'block', reason: '실패' } }, 'stop-failure': { body: {} } }, options);
      await idle(plugin);
      expect(server.seen.find((request) => request.event === 'stop-failure')?.body, JSON.stringify(options)).toMatchObject({ hook_event_name: 'StopFailure', error: 'stop_feedback_not_delivered' });
    }
  });

  it('관문에 닿지 못하면 한 번은 검증하지 못했다고 알려 다시 끝내게 하고, 연달아 닿지 못하면 멈추되 stop_unverified로 알린다', async () => {
    const { server, plugin } = await ready({ 'stop-failure': { body: {} } });
    // stop 길이 없다(404) = 닿지 못함과 같다
    await idle(plugin);
    expect(plugin.prompted).toHaveLength(1);
    expect(plugin.prompted[0]!.text).toMatch(/검증하지 못했습니다/);
    await idle(plugin);
    expect(plugin.prompted).toHaveLength(1);
    expect(plugin.toasts.some((text) => /검증하지 못했습니다/.test(text))).toBe(true);
    expect(server.seen.find((request) => request.event === 'stop-failure')?.body).toMatchObject({ error: 'stop_unverified' });
  });

  it('이상한 /stop 응답은 통과가 아니다', async () => {
    const { plugin } = await ready({ stop: { body: { decision: 'approve' } } });
    await idle(plugin);
    expect(plugin.prompted).toHaveLength(1);
    expect(plugin.prompted[0]!.text).toMatch(/검증하지 못했습니다/);
  });

  it('돌려보내기가 8번을 넘으면 통과하지 못한 채 끝난 것으로 알리고 멈춘다(stop_gate_not_passed)', async () => {
    const { server, plugin } = await ready({ stop: { body: { decision: 'block', reason: '계속 실패' } }, 'stop-failure': { body: {} } });
    for (let round = 0; round < 9; round += 1) await idle(plugin);
    expect(plugin.prompted).toHaveLength(8);
    expect(server.seen.find((request) => request.event === 'stop-failure')?.body).toMatchObject({ error: 'stop_gate_not_passed' });
  });

  it('사람이 누른 중단(MessageAbortedError)은 게이트도 실패 알림도 부르지 않는다', async () => {
    const { server, plugin } = await ready({ stop: { body: {} }, 'stop-failure': { body: {} } });
    await plugin.fire('session.error', { sessionID: 'ses_1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    await idle(plugin);
    expect(server.seen.filter((request) => request.event === 'stop' || request.event === 'stop-failure')).toEqual([]);
    // 중단은 한 번만 건너뛴다: 다음 정상 끝은 게이트를 돈다
    await idle(plugin);
    expect(server.seen.filter((request) => request.event === 'stop')).toHaveLength(1);
  });

  it('API 오류 등으로 끝난 턴은 게이트 없이 /stop-failure로 알린다', async () => {
    const { server, plugin } = await ready({ stop: { body: {} }, 'stop-failure': { body: {} } });
    await plugin.fire('session.error', { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'rate limit' } } });
    await idle(plugin);
    expect(server.seen.filter((request) => request.event === 'stop')).toEqual([]);
    expect(server.seen.find((request) => request.event === 'stop-failure')?.body).toMatchObject({ hook_event_name: 'StopFailure', error: 'run_end:error:APIError' });
  });

  it('하위 에이전트(parentID가 있는 세션)의 끝은 게이트를 돌리지 않는다', async () => {
    const { server, plugin } = await ready({ stop: { body: {} } });
    await plugin.fire('session.created', { info: { id: 'child_1', parentID: 'ses_1' } });
    await idle(plugin, 'child_1');
    expect(server.seen.filter((request) => request.event === 'stop')).toEqual([]);
  });

  it('설정 확인이 실패한 플러그인은 턴이 끝나도 통과시키지 않고 아무것도 보내지 않는다', async () => {
    const server = await gateway({ stop: { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.hooks.config!({ plugin: ['file:///evil.js'] });
    await idle(plugin);
    expect(server.seen).toEqual([]);
  });

  it('event 훅은 어떤 소식에도 던지지 않는다', async () => {
    const { plugin } = await ready({});
    for (const [type, properties] of [['session.idle', undefined], ['session.idle', null], ['session.error', 3], ['message.part.updated', { part: 1 }], ['x.unknown', {}], [undefined, undefined]] as Array<[string | undefined, unknown]>) {
      await expect(plugin.hooks.event!({ event: { type, properties } })).resolves.toBeUndefined();
    }
    await expect(plugin.hooks.event!(undefined)).resolves.toBeUndefined();
  });
});

describe('빈틈을 막는 마무리', () => {
  it('글이 없는 요청(자동으로 끼워 넣은 글뿐)은 /prompt로 보내지 않는다. 사용자의 요청이 아니다', async () => {
    const server = await gateway({ prompt: { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await plugin.hooks['chat.message']!({ sessionID: 'ses_1' }, { message: {}, parts: [{ type: 'text', text: '자동으로 끼운 글', synthetic: true }] });
    await plugin.hooks['chat.message']!({ sessionID: 'ses_1' }, { message: {}, parts: [{ type: 'file', url: 'data:' }] });
    expect(server.seen.filter((request) => request.event === 'prompt')).toEqual([]);
    // 대조: 사용자의 글이 있으면 보낸다
    await plugin.hooks['chat.message']!({ sessionID: 'ses_1' }, { message: {}, parts: [{ type: 'text', text: '자동 글', synthetic: true }, { type: 'text', text: '진짜 요청' }] });
    expect(server.seen.find((request) => request.event === 'prompt')?.body.prompt).toBe('진짜 요청');
  });

  it('관문의 응답이 상한(4MB)보다 크면 이상한 응답이다(읽기 전에 센다)', async () => {
    const server = await gateway({ 'pre-tool': { raw: `{"systemMessage":"${'가'.repeat(2_000_000)}"}` } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await expect(plugin.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).rejects.toThrow(/너무 큽니다/);
    // 대조: 상한 안이면 읽는다
    const small = await gateway({ 'pre-tool': { raw: `{"systemMessage":"${'가'.repeat(1000)}"}` } });
    const other = await load(await gatewayDir(small));
    await other.configure();
    await expect(other.hooks['tool.execute.before']!(...before('edit', { filePath: 'a' }))).resolves.toBeUndefined();
  });

  it('우리가 보낸 돌려보내기 글은 10분이 지나면 잊는다: 사용자가 같은 글을 치면 새 요청이다', async () => {
    const server = await gateway({ stop: { body: { decision: 'block', reason: '[b-studio] 실패' } }, prompt: { body: {} }, 'session-start': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    await plugin.fire('session.created', { info: { id: 'ses_1' } });
    await plugin.fire('session.idle', { sessionID: 'ses_1' });
    expect(plugin.prompted).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      await plugin.hooks['chat.message']!({ sessionID: 'ses_1' }, { message: {}, parts: [{ type: 'text', text: '[b-studio] 실패' }] });
    } finally {
      vi.useRealTimers();
    }
    expect(server.seen.filter((request) => request.event === 'prompt')).toHaveLength(1);
  });

  it('턴 끝을 처리하다 예상 밖의 오류가 나도 통과로 읽지 않는다: 검증하지 못한 끝으로 알린다', async () => {
    const server = await gateway({ stop: { body: {} }, 'stop-failure': { body: {} }, 'session-start': { body: {} } });
    const plugin = await load(await gatewayDir(server));
    await plugin.configure();
    // `/stop`이 사유를 주는데 client의 promptAsync를 읽다 던진다(deliver 안의 try 바깥)
    const broken = await gateway({ stop: { body: { decision: 'block', reason: '실패' } }, 'stop-failure': { body: {} }, 'session-start': { body: {} } });
    const dir = await gatewayDir(broken);
    const copy = path.join(dir, 'broken.mjs');
    await writeFile(copy, OPENCODE_PLUGIN);
    const loaded = (await import(/* @vite-ignore */ copy)) as { default: (input: unknown) => Promise<Record<string, Hook>> };
    const client = {
      session: {
        get promptAsync(): never {
          throw new Error('읽을 수 없다');
        },
      },
    };
    const hooks = await loaded.default({ directory: '/work', client });
    await hooks.config!({ plugin: [pathToFileURL(path.join(dir, OPENCODE_PLUGIN_NAME)).href] });
    await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    expect(broken.seen.find((request) => request.event === 'stop-failure')?.body).toMatchObject({ error: 'stop_unverified' });
    expect(server.seen.filter((request) => request.event === 'stop-failure')).toEqual([]);
  });
});
