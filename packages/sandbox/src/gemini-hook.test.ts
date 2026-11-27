import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GEMINI_HOOK, GEMINI_HOOK_NAME } from './gemini-hook';
import { geminiSettingsContent } from './gemini-config';

/**
 * Gemini의 훅 명령 파일(관문 폴더에 쓰는 글)을 **진짜로 실행**한다: node 자식 프로세스에 훅 입력 JSON을 표준 입력으로 주고 출력(JSON)과 종료 코드를 본다.
 * Gemini가 하는 일과 같다(0.71.1 `executeCommandHook`: 표준 입력으로 JSON, 종료 코드 0이면 표준 출력을 JSON으로 읽음). 진짜 gemini도 모델도 띄우지 않는다.
 * 가짜는 관문의 훅 서버(작은 로컬 HTTP 서버)뿐이다. 서버가 어떻게 판정하는지는 여기서 보지 않는다(studio의 시험이 진짜 판정 코드로 본다).
 */

const TOKEN = 'test-token-0123456789';
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Seen {
  route: string;
  token: string | undefined;
  body: Record<string, unknown>;
}
type Reply = { status?: number; body?: unknown; raw?: string; hang?: boolean };

async function gateway(replies: Record<string, Reply>): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const route = (request.url ?? '').slice(1);
      seen.push({ route, token: request.headers.authorization?.replace(/^Bearer /, ''), body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
      const reply = replies[route];
      if (!reply) return void response.writeHead(404).end();
      if (reply.hang) return;
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

/** 관문 폴더에 훅 파일과 주소 파일을 쓴다. address가 없으면 주소 파일이 없다 */
async function hookDir(address: { url: string; token?: string } | string | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-gmhook-'));
  dirs.push(dir);
  await writeFile(path.join(dir, GEMINI_HOOK_NAME), GEMINI_HOOK);
  if (typeof address === 'string') await writeFile(path.join(dir, 'b-studio-gateway.json'), address);
  else if (address) await writeFile(path.join(dir, 'b-studio-gateway.json'), `${JSON.stringify({ url: address.url, token: address.token ?? TOKEN })}\n`);
  return dir;
}

interface Ran {
  code: number | null;
  out: Record<string, unknown>;
  raw: string;
}

async function run(dir: string, event: string, input: unknown, env: Record<string, string> = {}): Promise<Ran> {
  const child = spawn(process.execPath, [path.join(dir, GEMINI_HOOK_NAME), event], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (part: Buffer) => (stdout += part.toString('utf8')));
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, out: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {}, raw: stdout };
}

const DENY_MARK = '[b-studio]';
const preTool = { hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: 'a.txt', content: 'x' }, cwd: '/work', session_id: 'abc' };
const isDeny = (ran: Ran): boolean => ran.out.decision === 'deny' && typeof ran.out.reason === 'string' && ran.out.reason.includes(DENY_MARK);

describe('Gemini 훅 명령: 쓰기 직전(BeforeTool)은 모든 실패를 막는 쪽으로 답한다', () => {
  it('관문이 허용하면 빈 답(허용)이다. 서버는 도구 이름·입력·토큰을 받는다. 대화 id는 보내지 않는다', async () => {
    const gw = await gateway({ 'pre-tool': { body: {} } });
    const ran = await run(await hookDir(gw), 'pre-tool', preTool);
    expect(ran.code).toBe(0);
    expect(ran.out).toEqual({});
    expect(gw.seen).toHaveLength(1);
    expect(gw.seen[0]).toMatchObject({ route: 'pre-tool', token: TOKEN, body: { hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: { file_path: 'a.txt', content: 'x' }, cwd: '/work' } });
    expect(gw.seen[0]!.body).not.toHaveProperty('session_id');
  });

  it('관문이 거절하면 Gemini의 꼴(decision: deny, reason)로 옮겨 종료 코드 0으로 낸다', async () => {
    const gw = await gateway({ 'pre-tool': { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[b-studio] 범위 밖입니다' } } } });
    const ran = await run(await hookDir(gw), 'pre-tool', preTool);
    expect(ran).toMatchObject({ code: 0, out: { decision: 'deny', reason: '[b-studio] 범위 밖입니다' } });
  });

  it('사용자에게만 보이는 알림은 systemMessage로 간다(막지 않는다)', async () => {
    const gw = await gateway({ 'pre-tool': { body: { systemMessage: '알림' } } });
    expect((await run(await hookDir(gw), 'pre-tool', preTool)).out).toEqual({ systemMessage: '알림' });
  });

  it.each([
    ['주소 파일 없음', undefined],
    ['주소 파일이 JSON 아님', '이건 JSON이 아님'],
    ['주소에 토큰 없음', '{"url":"http://127.0.0.1:1"}'],
    ['닿지 못하는 주소', '{"url":"http://127.0.0.1:1","token":"t"}'],
  ] as Array<[string, string | undefined]>)('닿지 못함(%s)이면 막는다', async (_name, raw) => {
    const dir = await hookDir(raw);
    const ran = await run(dir, 'pre-tool', preTool);
    expect(ran.code).toBe(0);
    expect(isDeny(ran)).toBe(true);
  });

  it('주소가 루프백 IP(127.0.0.1) http가 아니면 닿는 서버여도 부르지 않고 막는다(이름 localhost·사용자 정보가 든 주소·https)', async () => {
    const gw = await gateway({ 'pre-tool': { body: {} } });
    const port = new URL(gw.url).port;
    for (const url of [`http://localhost:${port}`, `http://user:pw@127.0.0.1:${port}`, `https://127.0.0.1:${port}`, `http://127.0.0.2:${port}`]) {
      const ran = await run(await hookDir(JSON.stringify({ url, token: TOKEN })), 'pre-tool', preTool);
      expect(isDeny(ran), url).toBe(true);
    }
    expect(gw.seen).toHaveLength(0);
    // 대조: 루프백 IP면 닿는다
    expect((await run(await hookDir(gw), 'pre-tool', preTool)).out).toEqual({});
    expect(gw.seen).toHaveLength(1);
  });

  it.each([
    ['HTTP 500', { status: 500, body: {} }],
    ['JSON 아님', { raw: '이건 JSON이 아님' }],
    ['모르는 필드', { body: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'x' } } }],
    ['객체가 아닌 응답', { body: ['deny'] }],
    ['다른 이벤트 이름', { body: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', permissionDecision: 'deny', permissionDecisionReason: 'x' } } }],
    ['모르는 최상위 필드', { body: { systemMessage: 'x', decision: 'allow' } }],
  ] as Array<[string, Reply]>)('이상한 응답(%s)이면 막는다', async (_name, reply) => {
    const gw = await gateway({ 'pre-tool': reply });
    const ran = await run(await hookDir(gw), 'pre-tool', preTool);
    expect(isDeny(ran)).toBe(true);
  });

  it('응답이 오지 않으면(시간 초과) 막는다', async () => {
    const gw = await gateway({ 'pre-tool': { hang: true } });
    const started = Date.now();
    const ran = await run(await hookDir(gw), 'pre-tool', preTool, { B_STUDIO_HOOK_TIMEOUT_MS: '300' });
    expect(isDeny(ran)).toBe(true);
    expect(ran.out.reason).toContain('시간 초과');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('상한 환경 변수는 낮추기만 한다: 터무니없이 큰 값은 무시되어 훅의 상한(수 초 뒤)으로 끊긴다', async () => {
    // 높이는 길은 없다. 낮추는 길만 시험한다(위). 여기서는 값이 글자여도 막는 동작이 그대로인지 본다
    const gw = await gateway({ 'pre-tool': { status: 500 } });
    const ran = await run(await hookDir(gw), 'pre-tool', preTool, { B_STUDIO_HOOK_TIMEOUT_MS: 'abc' });
    expect(isDeny(ran)).toBe(true);
  });

  it('입력이 JSON이 아니거나 도구 이름이 없으면 막는다(본문을 읽지 못한 도구 호출)', async () => {
    const gw = await gateway({ 'pre-tool': { body: {} } });
    const dir = await hookDir(gw);
    expect(isDeny(await run(dir, 'pre-tool', '이건 JSON이 아님'))).toBe(true);
    expect(isDeny(await run(dir, 'pre-tool', { tool_input: {} }))).toBe(true);
    expect(isDeny(await run(dir, 'pre-tool', []))).toBe(true);
    // 서버에는 묻지도 않았다
    expect(gw.seen).toHaveLength(0);
  });

  it('모르는 훅 종류는 빈 답이다(막지도 허용을 만들지도 않는다)', async () => {
    const gw = await gateway({});
    const ran = await run(await hookDir(gw), 'nope', preTool);
    expect(ran).toMatchObject({ code: 0, out: {} });
    expect(gw.seen).toHaveLength(0);
  });
});

describe('Gemini 훅 명령: 요청 받기(BeforeAgent)', () => {
  const input = { hook_event_name: 'BeforeAgent', prompt: '주문에 메모 필드 추가', cwd: '/work' };

  it('통과하면 빈 답, 맥락 글이 있으면 BeforeAgent의 additionalContext로 옮긴다', async () => {
    const gw = await gateway({ prompt: { body: {} } });
    expect((await run(await hookDir(gw), 'prompt', input)).out).toEqual({});
    expect(gw.seen[0]!.body).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: '주문에 메모 필드 추가' });
    const withNote = await gateway({ prompt: { body: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '메모' } } } });
    expect((await run(await hookDir(withNote), 'prompt', input)).out).toEqual({ hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: '메모' } });
  });

  it('요청 막기는 decision: deny와 사유로 옮긴다', async () => {
    const gw = await gateway({ prompt: { body: { decision: 'block', reason: '[b-studio] 막음' } } });
    expect((await run(await hookDir(gw), 'prompt', input)).out).toEqual({ decision: 'deny', reason: '[b-studio] 막음' });
  });

  it('닿지 못하거나 이상한 응답이거나 본문이 이상하면 요청을 보내지 않는다', async () => {
    expect(isDeny(await run(await hookDir(undefined), 'prompt', input))).toBe(true);
    const bad = await gateway({ prompt: { body: { decision: 'allow' } } });
    expect(isDeny(await run(await hookDir(bad), 'prompt', input))).toBe(true);
    const ok = await gateway({ prompt: { body: {} } });
    expect(isDeny(await run(await hookDir(ok), 'prompt', { cwd: '/work' }))).toBe(true);
    expect(ok.seen).toHaveLength(0);
  });
});

describe('Gemini 훅 명령: 턴 끝(AfterAgent)', () => {
  const input = { hook_event_name: 'AfterAgent', prompt: '요청', prompt_response: '끝냈습니다', stop_hook_active: false, cwd: '/work' };

  it('통과하면 빈 답(또는 알림), 마지막 답은 last_assistant_message로 간다', async () => {
    const gw = await gateway({ stop: { body: { systemMessage: '검증 통과' } } });
    const ran = await run(await hookDir(gw), 'stop', input);
    expect(ran.out).toEqual({ systemMessage: '검증 통과' });
    expect(gw.seen[0]!.body).toMatchObject({ hook_event_name: 'Stop', last_assistant_message: '끝냈습니다', stop_hook_active: false });
  });

  it('게이트가 돌려보내면 decision: deny와 사유로 이어가게 한다', async () => {
    const gw = await gateway({ stop: { body: { decision: 'block', reason: '[b-studio 검증 게이트] 실패' } } });
    expect((await run(await hookDir(gw), 'stop', input)).out).toEqual({ decision: 'deny', reason: '[b-studio 검증 게이트] 실패' });
  });

  it('관문에 닿지 못하면 한 번은 에이전트에게 알려 이어가게 하고, 이미 이어간 턴(stop_hook_active)이면 사용자에게 알리고 끝낸다', async () => {
    const dir = await hookDir(undefined);
    const first = await run(dir, 'stop', input);
    expect(first.out.decision).toBe('deny');
    expect(first.out.reason).toContain('검증하지 못했습니다');
    const second = await run(dir, 'stop', { ...input, stop_hook_active: true });
    expect(second.out.decision).toBeUndefined();
    expect(String(second.out.systemMessage)).toContain('검증하지 못했습니다');
  });
});

describe('Gemini 훅 명령: 알리기만 하는 통로', () => {
  it('세션 시작은 관문의 안내 글을 SessionStart의 additionalContext로 옮긴다. 닿지 못해도 빈 답이다', async () => {
    const gw = await gateway({ 'session-start': { body: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '안내' } } } });
    const ran = await run(await hookDir(gw), 'session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd: '/work' });
    expect(ran.out).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '안내' } });
    expect(gw.seen[0]!.body).toMatchObject({ hook_event_name: 'SessionStart', source: 'startup' });
    expect((await run(await hookDir(undefined), 'session-start', {})).out).toEqual({});
  });

  it('쓰기 뒤는 PostToolUse(실패면 PostToolUseFailure)로 지켜보기 통로에 보낸다', async () => {
    const gw = await gateway({ activity: { body: {} } });
    const dir = await hookDir(gw);
    await run(dir, 'post-tool', { tool_name: 'write_file', tool_input: { file_path: 'a' }, tool_response: { llmContent: 'ok' } });
    await run(dir, 'post-tool', { tool_name: 'write_file', tool_input: { file_path: 'a' }, tool_response: { error: { message: 'x' } } });
    expect(gw.seen.map((entry) => entry.body.hook_event_name)).toEqual(['PostToolUse', 'PostToolUseFailure']);
    expect((await run(await hookDir(undefined), 'post-tool', { tool_name: 'x' })).out).toEqual({});
  });

  it('권한 확인 알림은 permission_prompt로 보낸다', async () => {
    const gw = await gateway({ notification: { body: {} } });
    await run(await hookDir(gw), 'notification', { notification_type: 'ToolPermission', message: 'Tool write_file requires editing' });
    expect(gw.seen[0]!.body).toMatchObject({ notification_type: 'permission_prompt', message: 'Tool write_file requires editing' });
  });

  it('세션 끝은 알린다. /clear(reason: clear)는 CLI의 끝이 아니라 알리지 않는다', async () => {
    const gw = await gateway({ 'session-end': { body: {} } });
    const dir = await hookDir(gw);
    await run(dir, 'session-end', { reason: 'clear' });
    expect(gw.seen).toHaveLength(0);
    await run(dir, 'session-end', { reason: 'exit' });
    expect(gw.seen).toHaveLength(1);
    expect(gw.seen[0]).toMatchObject({ route: 'session-end', body: { reason: 'exit' } });
  });
});

describe('Gemini 설정 파일의 훅 명령(bash가 실행한다)', () => {
  it('훅 명령은 빈 환경에서 절대 경로의 node로 돈다: NODE_OPTIONS·NODE_PATH·LD_PRELOAD 등 Gemini의 환경이 훅 안으로 들어가지 않는다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-gmenv-'));
    dirs.push(dir);
    const marker = path.join(dir, 'preloaded.txt');
    await writeFile(path.join(dir, 'preload.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\n`);
    // 진짜 훅 파일 대신 환경을 찍는 파일을 둔다(설정의 명령이 부르는 이름과 같다)
    await writeFile(path.join(dir, GEMINI_HOOK_NAME), "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));\n");
    const settings = JSON.parse(geminiSettingsContent(dir, process.execPath)) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const command = settings.hooks.SessionStart![0]!.hooks[0]!.command;
    const child = spawn('/bin/bash', ['-c', command], {
      env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: `--require ${path.join(dir, 'preload.cjs')}`, NODE_PATH: '/evil', NODE_EXTRA_CA_CERTS: '/evil.pem', LD_PRELOAD: '/evil.so', DYLD_INSERT_LIBRARIES: '/evil.dylib', FOO: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (part: Buffer) => (stdout += part.toString('utf8')));
    child.stdin.end('{}');
    await new Promise<number | null>((resolve) => child.on('close', resolve));
    const names = (JSON.parse(stdout) as string[]).filter((name) => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(name));
    expect(names).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it('설정의 명령은 막는 훅(요청 받기·쓰기 직전)에 실패 꼬리를 붙이고, 훅 파일이 실행되지 못하면 종료 코드 2와 표준 오류의 글을 낸다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-gmcmd-'));
    dirs.push(dir);
    // node가 없는 경우를 흉내 낸다: 실행할 수 없는 경로
    const settings = JSON.parse(geminiSettingsContent(dir, path.join(dir, '없는-node'))) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const command = settings.hooks.BeforeTool![0]!.hooks[0]!.command;
    const child = spawn('/bin/bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (part: Buffer) => (stderr += part.toString('utf8')));
    child.stdin.end('{}');
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(2);
    // Gemini는 표준 오류의 글이 있어야 거절로 읽는다(글이 비면 출력이 없는 것으로 읽혀 허용)
    expect(stderr).toContain('[b-studio]');
  });
});
