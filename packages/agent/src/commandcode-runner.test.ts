import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCommandCodeModels, runCommandCodeAgent, type CommandCodeProcess } from './commandcode-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT as contract } from './test-helpers';

let project: LoadedProject;
/** 이 PC의 진짜 ~/.commandcode 대신 테스트가 만든 원본 홈. 러너가 여기서 auth.json만 링크한다 */
let originalHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  project = await createOrdersProject('commandcode-runner-test-');
  savedHome = process.env.HOME;
  originalHome = await mkdtemp(path.join(tmpdir(), 'commandcode-home-original-'));
  await mkdir(path.join(originalHome, '.commandcode'), { recursive: true });
  await writeFile(path.join(originalHome, '.commandcode', 'auth.json'), '{"token":"secret"}\n');
  process.env.HOME = originalHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(originalHome, { recursive: true, force: true }).catch(() => {});
});

/** 한 번의 `cmd -p` 실행이 낼 NDJSON과 종료 코드 */
interface FakeRun {
  /** `{"type":"event","event":…}`의 event 페이로드 */
  events?: Array<Record<string, unknown>>;
  /** 마지막 `{"type":"result",…}`의 나머지 필드 */
  result?: Record<string, unknown>;
  exitCode?: number;
}

interface FakeHooks {
  /** 실행이 시작될 때(임시 폴더가 살아 있는 동안) 파일·인자를 확인하는 훅 */
  onStart?: (info: { args: string[]; cwd: string; env: Record<string, string> }) => Promise<void>;
}

/**
 * `cmd`를 흉내 내는 가짜 프로세스. 넘긴 인자·환경·cwd를 그대로 기록하고, 스크립트의 NDJSON과 종료 코드를 돌려준다.
 * onStart에서 `.mcp.json`을 읽어 러너의 MCP 서버에 실제로 붙을 수 있다(도구 라우팅 검증).
 */
function fakeCommandCode(script: FakeRun[], hooks: FakeHooks = {}) {
  const state = { calls: [] as Array<{ args: string[]; cwd: string; env: Record<string, string> }> };
  const process: CommandCodeProcess = {
    run({ args, cwd, env }) {
      state.calls.push({ args, cwd, env });
      const next = script.shift();
      if (!next) throw new Error('스크립트에 남은 실행이 없습니다');
      const events = next.events ?? [];
      const result = next.result;
      const exitCode = next.exitCode ?? 0;
      async function* lines(): AsyncGenerator<string> {
        await hooks.onStart?.({ args, cwd, env });
        for (const event of events) yield JSON.stringify({ type: 'event', event });
        if (result) yield JSON.stringify({ type: 'result', ...result });
      }
      return { lines: lines(), exitCode: Promise.resolve(exitCode) };
    },
  };
  return { process, state };
}

/** 러너가 작업 폴더에 쓴 `.mcp.json`을 읽어 그대로 MCP 서버에 붙는다. 토큰은 환경 변수 참조를 실제 값으로 바꾼다 */
async function callStudioTool(cwd: string, env: Record<string, string>, name: string, args: unknown) {
  const config = JSON.parse(await readFile(path.join(cwd, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
  };
  const server = config.mcpServers.b_studio!;
  const token = env.B_STUDIO_MCP_TOKEN;
  if (!token) throw new Error('MCP 토큰이 환경에 없습니다');
  const authorization = server.headers.Authorization.replace(/\$\{(\w+)\}/g, (_, key: string) => env[key] ?? '');
  const client = new Client({ name: 'fake-cmd', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization } } });
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args as Record<string, unknown> });
  } finally {
    await client.close().catch(() => {});
  }
}

function success(id: string, text: string, usage?: Record<string, number>): FakeRun {
  return {
    events: [
      { type: 'run_start', sessionId: id },
      { type: 'message_end', content: [{ type: 'text', text }] },
    ],
    result: { subtype: 'success', sessionId: id, stopReason: 'end_turn', finalText: text, usage: usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  };
}

const OK_USAGE = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('runCommandCodeAgent', () => {
  it('도구 호출이 MCP 서버를 거쳐 executeTool로 가 작업 공간을 바꾸고, 인자·임시 폴더·설정을 남긴다', async () => {
    const { process, state } = fakeCommandCode(
      [success('session-1', '메모 필드를 추가했습니다.', OK_USAGE)],
      {
        onStart: async ({ cwd, env }) => {
          // 작업 폴더(cwd)에 실행별 MCP 설정과 허용 규칙이 있다
          const mcp = JSON.parse(await readFile(path.join(cwd, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
          const server = mcp.mcpServers.b_studio!;
          expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
          // 토큰 값은 파일에 없고 환경 변수 참조만 있다
          expect(server.headers.Authorization).toBe('Bearer ${B_STUDIO_MCP_TOKEN}');
          expect(JSON.stringify(mcp)).not.toContain(env.B_STUDIO_MCP_TOKEN!);

          const settings = JSON.parse(await readFile(path.join(cwd, '.commandcode', 'settings.json'), 'utf8')) as { permissions: { allow: string[]; deny?: string[] } };
          expect(settings.permissions.allow).toEqual(['mcp__b_studio__*']);
          expect(settings.permissions.deny).toBeUndefined();

          // cwd와 HOME은 서로 다른 임시 폴더이고 둘 다 tmpdir 안이다
          const home = env.HOME!;
          expect(home).not.toBe(cwd);
          expect(cwd.startsWith(tmpdir())).toBe(true);
          expect(home.startsWith(tmpdir())).toBe(true);
          // 작업 폴더에는 설정 파일만, 임시 홈에는 auth.json 링크 하나만 있다
          expect((await readdir(cwd)).sort()).toEqual(['.commandcode', '.mcp.json']);
          expect(await readdir(home)).toEqual(['.commandcode']);
          const link = path.join(home, '.commandcode', 'auth.json');
          expect((await lstat(link)).isSymbolicLink()).toBe(true);
          expect(await readlink(link)).toBe(path.join(originalHome, '.commandcode', 'auth.json'));

          // 도구 호출은 MCP 서버 → executeTool → 작업 공간으로 간다
          await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
        },
      },
    );
    const sandbox = fakeSandbox(project, [true]);
    const events: AgentEvent[] = [];

    const result = await runCommandCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox,
      process,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', summary: '메모 필드를 추가했습니다.', verifyAttempts: 0, turns: 1, sessionId: 'session-1' });
    expect(result.changedFiles).toEqual(['api/src/Order.java']);

    const { args, cwd, env } = state.calls[0]!;
    expect(args.slice(0, 2)).toEqual(['-p', expect.stringContaining('mcp__b_studio__read_file')]);
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--skip-onboarding');
    expect(args).toContain('--no-auto-update');
    expect(args).toContain('--no-skills');
    expect(args).toEqual(expect.arrayContaining(['--max-turns', '60']));
    // 헤드리스 기본 차단을 그대로 유지해야 한다 — 이 둘은 절대 붙이지 않는다
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--tools-all');
    expect(args).not.toContain('--resume');
    expect(env.B_STUDIO_MCP_TOKEN).toMatch(/^[0-9a-f]{48}$/);

    expect(events.find((event) => event.type === 'session')).toMatchObject({ backend: '로컬 Command Code Agent' });
    expect(events.flatMap((event) => (event.type === 'tool_call' ? [event.name] : []))).toEqual(['edit_file']);
    expect(events.flatMap((event) => (event.type === 'tool_result' ? [event.ok] : []))).toEqual([true]);

    // 실행이 끝나면 임시 폴더는 지워지고 원본 auth.json은 그대로 남는다
    await expect(stat(cwd)).rejects.toThrow();
    await expect(stat(env.HOME!)).rejects.toThrow();
    expect(await readFile(path.join(originalHome, '.commandcode', 'auth.json'), 'utf8')).toBe('{"token":"secret"}\n');
  });

  it('게이트가 실패하면 같은 세션을 갈라 이어받아 다시 돌리고(새 sessionId), 통과하면 끝난다', async () => {
    const { process, state } = fakeCommandCode(
      [
        { ...success('session-1', '메모를 추가했습니다.', OK_USAGE) },
        { ...success('session-2', '컴파일 에러를 고쳤습니다.', OK_USAGE) },
      ],
      {
        onStart: async ({ cwd, env }) => {
          await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
        },
      },
    );
    const sandbox = fakeSandbox(project, [false, true]);

    const result = await runCommandCodeAgent({ request: '주문에 메모 필드 추가', project, sandbox, process, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 2, sessionId: 'session-2' });
    expect(sandbox.restarts).toEqual(['api', 'api']);
    expect(state.calls).toHaveLength(2);
    // 첫 실행은 새 세션, 재시도는 이전 세션을 갈라 이어받는다
    expect(state.calls[0]!.args).not.toContain('--resume');
    expect(state.calls[1]!.args).toEqual(expect.arrayContaining(['--resume', 'session-1', '--fork-session']));
    expect(state.calls[1]!.args[1]).toContain('[b-studio 검증 게이트]');
    expect(state.calls[1]!.args[1]).toContain('cannot find symbol');
  });

  it('사용 한도 오류를 한도 문구로 분류하고 게이트를 돌리지 않는다', async () => {
    // 0단계에서 확인한 실제 문구 계열. 계정이 이 오류로 실패한다
    const limit = "You've reached your weekly usage limit. Resets in 15h 47m (Sat 2:39 PM).";
    const { process } = fakeCommandCode([{ result: { subtype: 'error', error: limit }, exitCode: 5 }]);
    const sandbox = fakeSandbox(project, []);

    const result = await runCommandCodeAgent({ request: '추가해줘', project, sandbox, process, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'failed', summary: `Command Code 사용 한도에 걸렸습니다: ${limit}`, turns: 0 });
    expect(sandbox.restarts).toEqual([]);
  });

  it('크레딧·로그인·최대 턴 종료 코드를 각각 분류한다', async () => {
    const credit = await runCommandCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), process: fakeCommandCode([{ result: { subtype: 'error' }, exitCode: 10 }]).process, fetcher: async () => contract });
    expect(credit.summary).toBe('Command Code 크레딧이 부족합니다: 종료 코드 10');

    const login = await runCommandCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), process: fakeCommandCode([{ exitCode: 3 }]).process, fetcher: async () => contract });
    expect(login.summary).toContain('로그인돼 있지 않습니다');

    const capped = await runCommandCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), process: fakeCommandCode([{ exitCode: 8 }]).process, fetcher: async () => contract });
    expect(capped.summary).toBe('최대 턴 수(60)를 넘었습니다');
  });

  it('턴별 usage를 실행 합계로 더하고, modelCalls·maxContextTokens를 이벤트에서 남긴다', async () => {
    const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
    const run = (id: string, text: string, u: Record<string, number>): FakeRun => ({
      events: [
        { type: 'run_start', sessionId: id },
        { type: 'model_request_end', usage: u },
        { type: 'message_end', content: [{ type: 'text', text }] },
      ],
      result: { subtype: 'success', sessionId: id, finalText: text, usage: u },
    });
    const { process } = fakeCommandCode([run('session-1', '메모를 추가했습니다.', usage(100, 10, 1, 5)), run('session-2', '고쳤습니다.', usage(200, 20, 2, 7))], {
      onStart: async ({ cwd, env }) => {
        await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
      },
    });
    const events: AgentEvent[] = [];

    const result = await runCommandCodeAgent({ request: '주문에 메모 필드 추가', project, sandbox: fakeSandbox(project, [false, true]), process, fetcher: async () => contract, onEvent: (event) => events.push(event) });

    // 실행 단위 합계를 더한다(누적이면 마지막 값만 남는다)
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 3 });
    // 실행을 끝낼 때마다 그때까지의 누적값을 알린다
    expect(events.flatMap((event) => (event.type === 'tokens' ? [event.usage.inputTokens] : []))).toEqual([100, 300]);
    expect(result.metrics?.modelCalls).toBe(2);
    expect(result.metrics?.maxContextTokens).toBe(222);
    // 이벤트에 시간이 없으므로 0("재지 않음")이다
    expect(result.metrics?.modelMs).toBe(0);
  });

  it('stateDir과 함께 resume을 주면 첫 실행부터 --fork-session으로 이어받고 새 sessionId를 남긴다', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'commandcode-state-'));
    const { process, state } = fakeCommandCode([success('forked-1', 'ok')]);

    try {
      const result = await runCommandCodeAgent({ request: '이어서 해줘', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, stateDir, resume: 'previous-session', fetcher: async () => contract });

      expect(result).toMatchObject({ status: 'done', sessionId: 'forked-1' });
      expect(state.calls[0]!.args).toEqual(expect.arrayContaining(['--resume', 'previous-session', '--fork-session']));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('stateDir 없이 resume을 주면 이어받지 않고 새 대화로 시작하며 한 번 알린다', async () => {
    const { process, state } = fakeCommandCode([success('session-9', 'ok')]);
    const events: AgentEvent[] = [];

    const result = await runCommandCodeAgent({
      request: '이어서 해줘',
      intent: 'ask',
      project,
      sandbox: fakeSandbox(project, []),
      process,
      resume: 'previous-session',
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    // 이어받을 수 없다는 것을 알면서 --resume을 넘기지 않는다(HOME·cwd가 달라지므로 찾지 못한다)
    expect(result).toMatchObject({ status: 'done', sessionId: 'session-9' });
    expect(state.calls[0]!.args).not.toContain('--resume');
    expect(events.filter((event) => event.type === 'warning')).toEqual([{ type: 'warning', message: '이 실행은 이전 대화를 이어받지 못합니다: 상태 폴더 없음' }]);
  });

  it('stateDir을 주면 실행 사이에 같은 HOME·같은 cwd를 쓰고, 두 번째 실행이 그 세션을 이어받는다', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'commandcode-state-'));
    const { process, state } = fakeCommandCode([success('session-1', '첫 작업을 끝냈습니다.'), success('session-2', '이어서 끝냈습니다.')]);

    try {
      const first = await runCommandCodeAgent({ request: '첫 작업', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, stateDir, fetcher: async () => contract });
      const second = await runCommandCodeAgent({ request: '이어서', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, stateDir, resume: first.sessionId, fetcher: async () => contract });

      expect(first).toMatchObject({ status: 'done', sessionId: 'session-1' });
      expect(second).toMatchObject({ status: 'done', sessionId: 'session-2' });
      expect(state.calls).toHaveLength(2);
      // cmd가 세션을 HOME과 cwd로 찾으므로 두 값이 실행 사이에도 같아야 한다
      expect(state.calls[0]!.cwd).toBe(path.join(stateDir, 'work'));
      expect(state.calls[1]!.cwd).toBe(state.calls[0]!.cwd);
      expect(state.calls[0]!.env.HOME).toBe(path.join(stateDir, 'home'));
      expect(state.calls[1]!.env.HOME).toBe(state.calls[0]!.env.HOME);
      // 첫 실행은 새 세션, 두 번째 실행은 그 세션을 갈라 이어받는다(이어받지 못해 실패하지 않는다)
      expect(state.calls[0]!.args).not.toContain('--resume');
      expect(state.calls[1]!.args).toEqual(expect.arrayContaining(['--resume', 'session-1', '--fork-session']));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('stateDir의 home은 실행 뒤에도 남고, work는 다음 실행이 시작할 때 비워진다', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'commandcode-state-'));
    const home = path.join(stateDir, 'home');
    const workdir = path.join(stateDir, 'work');

    try {
      const first = fakeCommandCode([success('session-1', 'ok')]);
      await runCommandCodeAgent({ request: '질문', intent: 'ask', project, sandbox: fakeSandbox(project, []), process: first.process, stateDir, fetcher: async () => contract });

      // HOME은 지우지 않는다. auth.json 링크도 그대로 남아 다음 실행이 다시 쓰지 않는다
      expect((await lstat(path.join(home, '.commandcode', 'auth.json'))).isSymbolicLink()).toBe(true);
      // 지난 실행이 남긴 파일을 심어 두고 다음 실행이 비우는지 본다
      await writeFile(path.join(workdir, 'model-output.txt'), '남은 파일\n');

      const second = fakeCommandCode([success('session-2', 'ok')]);
      await runCommandCodeAgent({ request: '질문', intent: 'ask', project, sandbox: fakeSandbox(project, []), process: second.process, stateDir, fetcher: async () => contract });

      // 실행 시작 때 비우므로 이번 실행의 설정만 남는다("빈 작업 폴더" 성질 유지)
      expect((await readdir(workdir)).sort()).toEqual(['.commandcode', '.mcp.json']);
      // HOME은 실행이 끝나도 남는다(세션 저장 위치)
      expect((await readdir(home)).sort()).toEqual(['.commandcode']);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('승격 옵션을 받으면 무시하지 않고 경고 이벤트를 한 번 알린다', async () => {
    const { process } = fakeCommandCode([success('session-1', 'ok')]);
    const events: AgentEvent[] = [];

    const result = await runCommandCodeAgent({
      request: '안녕',
      intent: 'ask',
      project,
      sandbox: fakeSandbox(project, []),
      process,
      // 이 러너는 승격을 지원하지 않는다. 조용히 무시하면 재는 사람이 승격이 걸린 줄 안다
      escalation: { to: 'sonnet' },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done' });
    const warnings = events.filter((event): event is Extract<AgentEvent, { type: 'warning' }> => event.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('승격을 지원하지 않습니다');
  });

  it('b-studio 도구가 아닌 호출을 실제 이벤트대로 기록한다: 거부는 deny, 실행된 것은 allow, b-studio 도구는 기록하지 않는다', async () => {
    const { process } = fakeCommandCode([
      {
        events: [
          { type: 'run_start', sessionId: 'session-1' },
          // 거부된 호출 → policy deny (같은 toolCallId는 한 번만)
          { type: 'tool_denied', toolCallId: 't1', toolName: 'write_file', denyMessage: 'Tool "write_file" is not pre-approved' },
          { type: 'tool_denied', toolCallId: 't1', toolName: 'write_file', denyMessage: 'Tool "write_file" is not pre-approved' },
          // 실행된 호출 → policy allow (running 뒤 completed)
          { type: 'tool_running', toolCallId: 't3', toolName: 'shell_command' },
          { type: 'tool_completed', toolCallId: 't3', toolName: 'shell_command' },
          // 실행됐지만 오류로 끝난 호출도 실행된 것이다 → policy allow
          { type: 'tool_running', toolCallId: 't4', toolName: 'grep' },
          { type: 'tool_errored', toolCallId: 't4', toolName: 'grep', error: 'boom' },
          // b-studio MCP 도구는 서버 핸들러가 알리므로 여기서 기록하지 않는다
          { type: 'tool_running', toolCallId: 't2', toolName: 'mcp__b_studio__list_files' },
          { type: 'tool_completed', toolCallId: 't2', toolName: 'mcp__b_studio__list_files' },
          { type: 'message_end', content: [{ type: 'text', text: 'ok' }] },
        ],
        result: { subtype: 'success', sessionId: 'session-1', finalText: 'ok', usage: OK_USAGE },
      },
    ]);
    const events: AgentEvent[] = [];

    await runCommandCodeAgent({ request: '파일 목록을 보고 x.txt도 만들어 봐', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, fetcher: async () => contract, onEvent: (event) => events.push(event) });

    expect(events.filter((event) => event.type === 'policy')).toEqual([
      { type: 'policy', tool: 'write_file', decision: 'deny', reason: 'Tool "write_file" is not pre-approved' },
      { type: 'policy', tool: 'shell_command', decision: 'allow', reason: '내장 도구가 실행됨(b-studio 도구 밖)' },
      { type: 'policy', tool: 'grep', decision: 'allow', reason: '내장 도구가 실행됨(b-studio 도구 밖)' },
    ]);
  });
});

describe('parseCommandCodeModels', () => {
  it('실제 `cmd --list-models` 출력에서 그룹·무료·기본 표시를 파싱한다', async () => {
    const text = await readFile(new URL('./fixtures/commandcode-models.txt', import.meta.url), 'utf8');
    const models = parseCommandCodeModels(text);

    const byId = new Map(models.map((model) => [model.id, model]));
    // 기본 모델은 DeepSeek V4 Flash이고 Open Source 그룹이다
    expect(byId.get('deepseek/deepseek-v4-flash')).toMatchObject({ group: 'Open Source', free: false, isDefault: true });
    // 무료 표시: 설명이 FREE / id에 :free / Stealth 그룹
    expect(byId.get('poolside/laguna-s-2.1-free')?.free).toBe(true);
    expect(byId.get('inclusionai/ling-3.0-flash-sante:free')?.free).toBe(true);
    expect(byId.get('stealth/space-bunny-alpha')).toMatchObject({ group: 'Stealth', free: true });
    // 일반 모델은 무료가 아니다
    expect(byId.get('deepseek/deepseek-v4-pro')?.free).toBe(false);
    // 꼬리말·사용 예시·첫 줄은 모델로 파싱하지 않는다
    expect(models.some((model) => model.id === 'Docs:' || model.id === 'Available' || model.id === 'cmd')).toBe(false);
    expect(models.every((model) => model.id.length > 0 && model.description.length > 0)).toBe(true);
    // 같은 id가 여러 그룹에 나와도 한 번만 남긴다
    expect(models.filter((model) => model.id === 'deepseek/deepseek-v4-flash')).toHaveLength(1);
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    // Decision models 그룹(예: typesafe/jev)은 채팅 모델이 아니라 목록에서 뺀다
    expect(models.some((model) => model.group.startsWith('Decision models'))).toBe(false);
    expect(byId.has('typesafe/jev')).toBe(false);
    expect(text).toContain('typesafe/jev'); // fixture에는 있지만 파서가 거른다
  });
});
