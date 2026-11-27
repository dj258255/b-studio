import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_CODE_MOD, COMMAND_CODE_MOD_NAME } from './commandcode-mod';

/**
 * Command Code의 mod 파일(관문 폴더에 쓰는 글)을 **진짜로 불러** 훅을 부른다. 진짜 commandcode도 모델도 부르지 않는다.
 * 가짜는 ModApi(`cmd.hooks`·`cmd.on`·`cmd.ui`)와 관문의 훅 서버(작은 로컬 HTTP 서버)뿐이다.
 * 서버가 어떻게 판정하는지는 여기서 보지 않는다(그것은 studio의 시험이 진짜 판정 코드로 본다). 여기서는 mod가 닫힘으로 실패하는지 본다.
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

/** 관문의 훅 서버 자리. 경로별로 답을 정한다. `hang`이면 답하지 않는다 */
type Reply = { status?: number; body?: unknown; raw?: string; hang?: boolean };
async function gateway(replies: Record<string, Reply | ((body: Record<string, unknown>) => Reply)>): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const event = (request.url ?? '').slice(1);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      seen.push({ event, token, body });
      const entry = replies[event];
      const reply = typeof entry === 'function' ? entry(body) : entry;
      if (!reply || reply.hang) {
        if (!reply) {
          response.writeHead(404).end();
        }
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

/** 관문 폴더를 만들고 mod 파일과 주소 파일을 쓴다. 환경 변수로 폴더를 알린다(감싸개가 하는 일) */
async function gatewayDir(address: { url: string; token?: string } | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-ccmod-'));
  dirs.push(dir);
  await writeFile(path.join(dir, COMMAND_CODE_MOD_NAME), COMMAND_CODE_MOD);
  if (address) await writeFile(path.join(dir, 'b-studio-gateway.json'), `${JSON.stringify({ url: address.url, token: address.token ?? TOKEN })}\n`);
  process.env.B_STUDIO_GATEWAY_DIR = dir;
  return dir;
}

type Hook = (...args: unknown[]) => unknown;
/** 진짜 Command Code의 모드 호스트처럼 `cmd.hooks`로 받은 훅을 모으고, `cmd.on`의 이벤트 처리기를 모은다 */
async function loadMod(dir: string): Promise<{ hooks: Record<string, Hook>; emit: (event: string, payload: unknown) => Promise<void>; notices: string[]; registered: { hooksCalls: number } }> {
  // 글 안에 TS 문법이 없으므로(Command Code는 .ts를 jiti로 불러온다) .mjs 사본으로 불러도 같은 글이다
  const copy = path.join(dir, `loaded-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(copy, COMMAND_CODE_MOD);
  const loaded = (await import(/* @vite-ignore */ copy)) as { default: (cmd: unknown) => unknown };
  const hooks: Record<string, Hook> = {};
  const handlers = new Map<string, Hook[]>();
  const notices: string[] = [];
  const registered = { hooksCalls: 0 };
  const cmd = {
    name: 'b-studio-mod',
    cwd: '/work',
    hooks: (value: Record<string, Hook>) => {
      registered.hooksCalls += 1;
      Object.assign(hooks, value);
      return { dispose() {} };
    },
    on: (event: string, handler: Hook) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return { dispose() {} };
    },
    ui: { notify: (text: string) => void notices.push(text) },
  };
  await loaded.default(cmd);
  return {
    hooks,
    registered,
    notices,
    emit: async (event, payload) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload);
    },
  };
}

const toolCall = (toolName: string, input: unknown, toolCallId = 'call-1') => ({ toolCallId, toolName, input, state: {} });
const eventually = async (check: () => boolean): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 3000) throw new Error('기다리던 요청이 오지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('mod 파일의 모양', () => {
  it('의존성 없는 한 파일이다: 가져오는 것은 node 내장뿐이고, 토큰이나 주소를 글자로 박지 않는다', () => {
    const imports = [...COMMAND_CODE_MOD.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier, specifier).toMatch(/^node:/);
    expect(COMMAND_CODE_MOD).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(COMMAND_CODE_MOD).not.toContain(TOKEN);
    // 모델 고르기 인자를 넘기지 않는다
    expect(COMMAND_CODE_MOD).not.toMatch(/--model|setModel|beforeModelRequest/);
  });

  it('문서에 있는 훅 이름만 등록한다', async () => {
    const dir = await gatewayDir(undefined);
    const { hooks } = await loadMod(dir);
    const documented = new Set(['transformContext', 'appendSystemPrompt', 'transformSystemPrompt', 'transformMessage', 'transformTextDelta', 'beforeModelRequest', 'beforeToolCall', 'afterToolCall', 'onTurnStart', 'onTurnEnd', 'shouldStopAfterTurn', 'prepareNextTurn', 'onRunEnd', 'onStop', 'transformInput', 'onPermissionRequest', 'onSessionStart', 'onSessionEnd']);
    for (const name of Object.keys(hooks)) expect(documented.has(name), name).toBe(true);
    expect(Object.keys(hooks)).toEqual(expect.arrayContaining(['transformInput', 'beforeToolCall', 'afterToolCall', 'onStop', 'onRunEnd']));
  });
});

describe('beforeToolCall: 쓰기 직전 (닫힘으로 실패한다)', () => {
  it('관문이 비워서 답하면 도구를 막지 않는다(막는 것이 기본이 아니라는 대조). 요청에는 도구 이름·입력·호출 id가 실리고 토큰이 붙는다', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    const answer = await hooks.beforeToolCall!(toolCall('write_file', { file_path: '/work/a.ts', content: 'x' }));
    expect(answer).toBeUndefined();
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toMatchObject({ event: 'pre-tool', token: TOKEN });
    expect(server.seen[0]!.body).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: '/work/a.ts', content: 'x' }, tool_use_id: 'call-1', cwd: '/work' });
    await server.close();
  });

  it('관문이 거절하면 도구를 막고 까닭을 additionalContext로 돌려준다', async () => {
    const reason = '[b-studio] 이 카드가 쓸 수 있는 경로는 api/src입니다.';
    const server = await gateway({ 'pre-tool': { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.beforeToolCall!(toolCall('write_file', { file_path: '/work/web/x.txt' }))).toEqual({ block: true, additionalContext: reason });
  });

  it('사용자에게만 알리는 글(systemMessage)이 오면 막지 않고 알림 한 줄을 낸다', async () => {
    const server = await gateway({ 'pre-tool': { body: { systemMessage: '[b-studio] 알림' } } });
    const { hooks, notices } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.beforeToolCall!(toolCall('edit_file', { file_path: '/work/a.ts' }))).toBeUndefined();
    expect(notices).toEqual(['[b-studio] 알림']);
  });

  it('서버에 닿지 못하면 막는다(포트가 닫혀 있다)', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const dir = await gatewayDir({ url: server.url });
    await server.close();
    const { hooks } = await loadMod(dir);
    const answer = (await hooks.beforeToolCall!(toolCall('write_file', { file_path: '/work/a.ts' }))) as { block?: boolean; additionalContext?: string };
    expect(answer.block).toBe(true);
    expect(answer.additionalContext).toContain('[b-studio] 관문에 닿지 못해');
  });

  it('주소 파일이 없거나 환경 변수가 없으면 막는다', async () => {
    const dir = await gatewayDir(undefined);
    const { hooks } = await loadMod(dir);
    expect(await hooks.beforeToolCall!(toolCall('write_file', {}))).toMatchObject({ block: true });
    delete process.env.B_STUDIO_GATEWAY_DIR;
    expect(await hooks.beforeToolCall!(toolCall('write_file', {}))).toMatchObject({ block: true });
  });

  it('주소가 루프백 http가 아니면 막는다(변조된 주소 파일로 다른 곳에 입력을 보내지 않는다)', async () => {
    const hits = await gateway({ 'pre-tool': { body: {} } });
    for (const url of ['https://127.0.0.1:1', 'http://example.com:80', 'ftp://127.0.0.1', 'not a url', `http://localhost:${new URL(hits.url).port}`]) {
      const { hooks } = await loadMod(await gatewayDir({ url }));
      expect(await hooks.beforeToolCall!(toolCall('write_file', {})), url).toMatchObject({ block: true });
    }
    expect(hits.seen).toEqual([]);
  });

  it('이상한 응답이면 막는다: 오류 상태, JSON이 아님, 객체가 아님, 모르는 필드, allow 결정, 까닭 없는 거절', async () => {
    const odd: Reply[] = [
      { status: 500, body: { error: 'boom' } },
      { status: 404 },
      { raw: 'not json' },
      { raw: '' },
      { body: [] },
      { body: 'ok' },
      { raw: 'null' },
      { body: { decision: 'allow' } },
      { body: { systemMessage: 7 } },
      { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } },
      { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } } },
      { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '' } } },
      { body: { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'x' }, extra: 1 } },
    ];
    for (const reply of odd) {
      const server = await gateway({ 'pre-tool': reply });
      const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
      expect(await hooks.beforeToolCall!(toolCall('write_file', { file_path: '/work/a.ts' })), JSON.stringify(reply)).toMatchObject({ block: true });
    }
  });

  it('시간 안에 답이 없으면 막는다(시간 상한은 낮추기만 할 수 있다)', async () => {
    const server = await gateway({ 'pre-tool': { hang: true } });
    process.env.B_STUDIO_MOD_TIMEOUT_MS = '150';
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    const answer = (await hooks.beforeToolCall!(toolCall('shell_command', { command: 'ls' }))) as { block?: boolean; additionalContext?: string };
    expect(answer.block).toBe(true);
    expect(answer.additionalContext).toContain('시간 초과');
  });

  it('입력을 직렬화하지 못하거나 훅의 인자가 이상해도 던지지 않고 막는다(던지면 CLI는 이 훅을 건너뛰고 도구를 돌린다)', async () => {
    const server = await gateway({ 'pre-tool': { body: {} } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await hooks.beforeToolCall!(toolCall('write_file', circular))).toMatchObject({ block: true });
    expect(await hooks.beforeToolCall!(toolCall('write_file', { n: 10n }))).toMatchObject({ block: true });
    expect(await hooks.beforeToolCall!(undefined)).toMatchObject({ block: true });
    expect(await hooks.beforeToolCall!(null)).toMatchObject({ block: true });
    expect(server.seen).toEqual([]);
  });
});

describe('transformInput: 요청 받기', () => {
  it('관문이 비워서 답하면 그대로 통과시킨다', async () => {
    const server = await gateway({ prompt: { body: {} } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    const answer = await hooks.transformInput!({ text: '주문에 메모 필드 추가' });
    expect(answer === undefined || (answer as { action: string }).action === 'continue').toBe(true);
    expect(server.seen[0]!.body).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: '주문에 메모 필드 추가' });
  });

  it('관문이 막으면 요청을 삼키고(handled) 까닭을 보인다', async () => {
    const server = await gateway({ prompt: { body: { decision: 'block', reason: '[b-studio] 앞 요청이 아직 끝나지 않았습니다' } } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.transformInput!({ text: '다음 요청' })).toEqual({ action: 'handled', message: '[b-studio] 앞 요청이 아직 끝나지 않았습니다' });
  });

  it('관문이 맥락 글을 주면 요청 글 뒤에 덧붙여 에이전트에게 알린다', async () => {
    const server = await gateway({ prompt: { body: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '읽기만 요청이다' } } } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.transformInput!({ text: '[읽기만] 구조를 설명해 줘' })).toEqual({ action: 'transform', text: '[읽기만] 구조를 설명해 줘\n\n읽기만 요청이다' });
  });

  it('서버에 닿지 못하거나 응답이 이상하면 요청을 보내지 않는다(handled). 던지면 CLI가 훅을 건너뛰고 요청이 간다', async () => {
    const server = await gateway({ prompt: { status: 500 } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.transformInput!({ text: '요청' })).toMatchObject({ action: 'handled', message: expect.stringContaining('[b-studio] 관문에 닿지 못해') });
    const odd = await gateway({ prompt: { body: { decision: 'allow' } } });
    const second = await loadMod(await gatewayDir({ url: odd.url }));
    expect(await second.hooks.transformInput!({ text: '요청' })).toMatchObject({ action: 'handled' });
    expect(await second.hooks.transformInput!(undefined)).toMatchObject({ action: 'handled' });
  });
});

describe('onStop: 턴 끝 게이트', () => {
  it('통과하면 더 이어가지 않는다. 사용자에게 보이는 글은 알림으로 낸다', async () => {
    const server = await gateway({ stop: { body: { systemMessage: '[b-studio] 검증 통과 — 체크포인트 abc1234' } } });
    const { hooks, notices } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 2, lastAssistantText: '추가했습니다.' })).toEqual({ continue: false });
    expect(server.seen[0]!.body).toMatchObject({ hook_event_name: 'Stop', last_assistant_message: '추가했습니다.' });
    expect(notices).toEqual(['[b-studio] 검증 통과 — 체크포인트 abc1234']);
  });

  it('게이트가 실패하면 사유를 reason으로 돌려주며 이어가게 한다', async () => {
    const feedback = '[b-studio 검증 게이트] unit 실패: FAILED: OrderTest';
    const server = await gateway({ stop: { body: { decision: 'block', reason: feedback } } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 2, lastAssistantText: '' })).toEqual({ continue: true, reason: feedback });
  });

  it('서버에 닿지 못하면 통과로 읽지 않는다: 한 번은 검증하지 못했다고 알리며 이어가게 하고, 연달아 닿지 못하면 멈추되 경고를 낸다', async () => {
    const server = await gateway({ stop: { status: 500 } });
    const { hooks, notices } = await loadMod(await gatewayDir({ url: server.url }));
    const first = (await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: 'x' })) as { continue: boolean; reason?: string };
    expect(first.continue).toBe(true);
    expect(first.reason).toContain('검증하지 못했습니다');
    const second = (await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 2, lastAssistantText: 'x' })) as { continue: boolean };
    expect(second.continue).toBe(false);
    expect(notices.some((text) => text.includes('검증하지 못했습니다'))).toBe(true);
  });

  it('이상한 응답은 통과가 아니다', async () => {
    for (const reply of [{ raw: 'nope' }, { body: [] }, { body: { decision: 'allow' } }, { body: { decision: 'block' } }, { body: { decision: 'block', reason: '' } }, { body: { continue: false } }] as Reply[]) {
      const server = await gateway({ stop: reply });
      const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
      const answer = (await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: '' })) as { continue: boolean; reason?: string };
      expect(answer.continue, JSON.stringify(reply)).toBe(true);
      expect(answer.reason, JSON.stringify(reply)).toContain('검증하지 못했습니다');
    }
  });
});

describe('afterToolCall·onRunEnd·서브에이전트·세션', () => {
  it('afterToolCall은 도구의 끝을 알린다(지켜보기만). 실패한 도구는 PostToolUseFailure다. 답을 바꾸지 않는다', async () => {
    const server = await gateway({ activity: { body: {} } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.afterToolCall!({ toolCallId: 'c1', toolName: 'write_file', input: { file_path: '/work/a.ts' }, result: [{ type: 'text', text: 'SECRET-OUTPUT' }], isError: false, state: {} })).toBeUndefined();
    expect(await hooks.afterToolCall!({ toolCallId: 'c2', toolName: 'shell_command', input: { command: 'false' }, result: [], isError: true, state: {} })).toBeUndefined();
    await eventually(() => server.seen.length === 2);
    const events = server.seen.map((entry) => entry.body.hook_event_name).sort();
    expect(events).toEqual(['PostToolUse', 'PostToolUseFailure']);
    // 도구의 출력은 보내지 않는다
    expect(JSON.stringify(server.seen.map((entry) => entry.body))).not.toContain('SECRET-OUTPUT');
    // 서버가 없어도 던지지 않는다
    await server.close();
    expect(await hooks.afterToolCall!({ toolCallId: 'c3', toolName: 'write_file', input: {}, result: [], isError: false, state: {} })).toBeUndefined();
  });

  it('훅 없이 끝난 실행(턴 상한·권한 거절)은 StopFailure로 알린다. 자연스럽게 끝난 실행과 사람이 누른 중단은 알리지 않는다', async () => {
    const server = await gateway({ 'stop-failure': { body: {} } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    await hooks.onRunEnd!({ state: {}, result: { stopReason: 'end_turn', turnCount: 3, finalText: 'x' } });
    // 중단(Esc)은 실패가 아니다: 실행을 열어 두고 다음 요청이 이어 간다
    await hooks.onRunEnd!({ state: {}, result: { stopReason: 'interrupted', turnCount: 3, finalText: '' } });
    expect(server.seen).toEqual([]);
    for (const stopReason of ['max_turns', 'permission_denied']) {
      await hooks.onRunEnd!({ state: {}, result: { stopReason, turnCount: 3, finalText: '' } });
    }
    expect(server.seen.map((entry) => entry.event)).toEqual(['stop-failure', 'stop-failure']);
    expect(server.seen.map((entry) => entry.body.error)).toEqual([expect.stringContaining('max_turns'), expect.stringContaining('permission_denied')]);
    // 알 수 없는 끝 사유는 자연스러운 끝이 아니다
    await hooks.onRunEnd!({ state: {}, result: {} });
    expect(server.seen).toHaveLength(3);
  });

  it('턴 끝 확인이 관문에 닿지 못한 채 끝난 실행은 StopFailure(stop_unverified)로 알린다. 확인이 닿아 통과한 실행은 알리지 않는다', async () => {
    let stops = 0;
    const server = await gateway({
      // 처음 두 번은 이상한 응답(검증하지 못함), 그 뒤는 통과
      stop: () => (stops++ < 2 ? { body: { nope: true } } : { body: {} }),
      'stop-failure': { body: {} },
    });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    expect(await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: '' })).toMatchObject({ continue: true });
    expect(await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 2, lastAssistantText: '' })).toEqual({ continue: false });
    await hooks.onRunEnd!({ state: {}, result: { stopReason: 'end_turn' } });
    const failures = () => server.seen.filter((entry) => entry.event === 'stop-failure');
    expect(failures().map((entry) => entry.body.error)).toEqual(['stop_unverified']);
    // 대조: 확인이 닿아 통과한 실행의 끝은 알리지 않는다
    expect(await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: '' })).toEqual({ continue: false });
    await hooks.onRunEnd!({ state: {}, result: { stopReason: 'end_turn' } });
    expect(failures()).toHaveLength(1);
  });

  it('게이트가 실패해 이어가게 했는데 이어갈 수 없어 끝난 실행(end_turn)도 StopFailure로 알린다. 통과한 뒤의 끝은 알리지 않는다', async () => {
    let answers = 0;
    const server = await gateway({
      stop: () => (answers++ < 1 ? { body: { decision: 'block', reason: '실패' } } : { body: { systemMessage: '통과' } }),
      'stop-failure': { body: {} },
    });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: '' });
    await hooks.onRunEnd!({ state: {}, result: { stopReason: 'end_turn' } });
    expect(server.seen.filter((entry) => entry.event === 'stop-failure')).toHaveLength(1);
    // 다음 요청에서는 통과해 끝난다
    await hooks.onStop!({ state: {}, stopReason: 'end_turn', turnNumber: 1, lastAssistantText: '' });
    await hooks.onRunEnd!({ state: {}, result: { stopReason: 'end_turn' } });
    expect(server.seen.filter((entry) => entry.event === 'stop-failure')).toHaveLength(1);
  });

  it('onRunEnd는 서버에 닿지 못해도 던지지 않는다', async () => {
    const server = await gateway({});
    const dir = await gatewayDir({ url: server.url });
    await server.close();
    const { hooks } = await loadMod(dir);
    await expect(Promise.resolve(hooks.onRunEnd!({ state: {}, result: { stopReason: 'max_turns' } }))).resolves.toBeUndefined();
  });

  it('subagent_start·subagent_stop 이벤트를 서브에이전트의 시작·끝으로 알린다', async () => {
    const server = await gateway({ activity: { body: {} } });
    const { emit } = await loadMod(await gatewayDir({ url: server.url }));
    await emit('subagent_start', { type: 'subagent_start', toolCallId: 'agent-1', subagentType: 'general', description: '조사' });
    await emit('subagent_stop', { type: 'subagent_stop', toolCallId: 'agent-1', subagentType: 'general', tokensUsed: 10 });
    await eventually(() => server.seen.length === 2);
    const bodies = server.seen.map((entry) => entry.body);
    expect(bodies).toContainEqual(expect.objectContaining({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'general' }));
    expect(bodies).toContainEqual(expect.objectContaining({ hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'general' }));
  });

  it('세션이 시작되면 CLI가 떴다고 알리고, 끝나면 알린다', async () => {
    const server = await gateway({ 'session-start': { body: {} }, 'session-end': { body: {} } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    await hooks.onSessionStart!({ source: 'startup' });
    await hooks.onSessionEnd!({ reason: 'shutdown' });
    expect(server.seen.map((entry) => entry.event)).toEqual(['session-start', 'session-end']);
    expect(server.seen[0]!.body).toMatchObject({ hook_event_name: 'SessionStart', source: 'startup' });
    expect(server.seen[1]!.body).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'shutdown' });
  });

  it('mod만 다시 불러온 것(reload)도 서버에 알린다: 끝날 때 reason=reload, 다시 뜰 때 source=reload. reload 뒤 설정이 mod를 껐다면 뒤의 알림이 오지 않는 것으로 서버가 안다(보안 검토)', async () => {
    const server = await gateway({ 'session-start': { body: {} }, 'session-end': { body: {} } });
    const { hooks } = await loadMod(await gatewayDir({ url: server.url }));
    await hooks.onSessionEnd!({ reason: 'reload' });
    await hooks.onSessionStart!({ source: 'reload' });
    expect(server.seen.map((entry) => entry.event)).toEqual(['session-end', 'session-start']);
    expect(server.seen[0]!.body).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'reload' });
    expect(server.seen[1]!.body).toMatchObject({ hook_event_name: 'SessionStart', source: 'reload' });
  });

  it('알림이 닿지 못해도 던지지 않는다(알리기만 한다)', async () => {
    const { hooks } = await loadMod(await gatewayDir(undefined));
    await expect(hooks.onSessionEnd!({ reason: 'reload' })).resolves.toBeUndefined();
    await expect(hooks.onSessionStart!({ source: 'reload' })).resolves.toBeUndefined();
  });

  it('시스템 프롬프트에 덧붙이는 글은 매번 같다(캐시를 깨지 않는다)', async () => {
    const dir = await gatewayDir(undefined);
    const { hooks } = await loadMod(dir);
    const first = await hooks.appendSystemPrompt!({ state: {} });
    expect(typeof first).toBe('string');
    expect(first).toContain('커밋하지 않는다');
    expect(await hooks.appendSystemPrompt!({ state: { messages: [1] } })).toBe(first);
  });
});
