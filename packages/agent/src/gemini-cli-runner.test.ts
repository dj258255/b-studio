import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GEMINI_MODEL_REQUIRED, geminiSettingsJson, runGeminiAgent, type GeminiProcess } from './gemini-cli-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT as contract } from './test-helpers';

/** 테스트가 쓰는 모델. 러너는 모델을 추측하지 않고 항상 명시받는다 */
const MODEL = 'gemini-2.5-pro';

let project: LoadedProject;
/** 이 PC의 진짜 ~/.gemini 대신 테스트가 만든 원본 홈. 러너가 여기서 oauth_creds.json을 링크한다 */
let originalHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  project = await createOrdersProject('gemini-runner-test-');
  savedHome = process.env.HOME;
  originalHome = await mkdtemp(path.join(tmpdir(), 'gemini-home-original-'));
  await mkdir(path.join(originalHome, '.gemini'), { recursive: true });
  await writeFile(path.join(originalHome, '.gemini', 'oauth_creds.json'), '{"token":"secret"}\n');
  process.env.HOME = originalHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(originalHome, { recursive: true, force: true }).catch(() => {});
});

/** 한 번의 `gemini -p` 실행이 낼 stdout(JSON 문서 하나)과 종료 코드 */
interface FakeRun {
  stdout?: string;
  exitCode?: number;
  stderr?: string;
}

interface FakeHooks {
  /** 실행이 시작될 때(임시 폴더가 살아 있는 동안) 파일·인자를 확인하는 훅 */
  onStart?: (info: { args: string[]; cwd: string; env: Record<string, string> }) => Promise<void>;
}

/**
 * `gemini`를 흉내 내는 가짜 프로세스. 넘긴 인자·환경·cwd를 그대로 기록하고, 스크립트의 stdout(JSON 문서)과 종료 코드를 돌려준다.
 * onStart에서 `.gemini/settings.json`을 읽어 러너의 MCP 서버에 실제로 붙을 수 있다(도구 라우팅 검증).
 */
function fakeGemini(script: FakeRun[], hooks: FakeHooks = {}) {
  const state = { calls: [] as Array<{ args: string[]; cwd: string; env: Record<string, string> }> };
  const process: GeminiProcess = {
    run({ args, cwd, env }) {
      state.calls.push({ args, cwd, env });
      const next = script.shift();
      if (!next) throw new Error('스크립트에 남은 실행이 없습니다');
      const stdout = next.stdout ?? '';
      const exitCode = next.exitCode ?? 0;
      const stderr = next.stderr ?? '';
      const stdoutPromise = (async () => {
        await hooks.onStart?.({ args, cwd, env });
        return stdout;
      })();
      return { stdout: stdoutPromise, exitCode: Promise.resolve(exitCode), stderr: async () => stderr };
    },
  };
  return { process, state };
}

/** 러너가 작업 폴더에 쓴 `.gemini/settings.json`을 읽어 그대로 MCP 서버에 붙는다. 토큰은 환경 변수에서 꺼낸 실제 값을 쓴다 */
async function callStudioTool(cwd: string, env: Record<string, string>, name: string, args: unknown) {
  const config = JSON.parse(await readFile(path.join(cwd, '.gemini', 'settings.json'), 'utf8')) as {
    mcpServers: Record<string, { httpUrl: string; headers: { Authorization: string } }>;
  };
  const server = config.mcpServers.b_studio!;
  const token = env.B_STUDIO_MCP_TOKEN;
  if (!token) throw new Error('MCP 토큰이 환경에 없습니다');
  const client = new Client({ name: 'fake-gemini', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.httpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args as Record<string, unknown> });
  } finally {
    await client.close().catch(() => {});
  }
}

const OK_TOKENS = { prompt: 10, candidates: 2, cached: 0, thoughts: 0, total: 12 };

function success(text: string, tokens: Record<string, unknown> = OK_TOKENS, sessionId?: string): FakeRun {
  return { stdout: JSON.stringify({ response: text, ...(sessionId ? { session_id: sessionId } : {}), stats: { models: { [MODEL]: { tokens } } } }) };
}

describe('runGeminiAgent', () => {
  it('모델을 주지 않으면 추측하지 않고 오류를 낸다', async () => {
    await expect(runGeminiAgent({ request: '질문', intent: 'ask', project, sandbox: fakeSandbox(project, []), process: fakeGemini([]).process, fetcher: async () => contract })).rejects.toThrow(GEMINI_MODEL_REQUIRED);
  });

  it('도구 호출이 MCP 서버를 거쳐 executeTool로 가 작업 공간을 바꾸고, 인자·임시 폴더·설정을 남긴다', async () => {
    const { process, state } = fakeGemini([success('메모 필드를 추가했습니다.')], {
      onStart: async ({ cwd, env }) => {
        const config = JSON.parse(await readFile(path.join(cwd, '.gemini', 'settings.json'), 'utf8')) as {
          mcpServers: Record<string, { httpUrl: string; headers: Record<string, string>; trust: boolean }>;
          excludeTools: string[];
        };
        const server = config.mcpServers.b_studio!;
        expect(server.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(server.trust).toBe(true);
        // 토큰 값은 파일에 없고 환경 변수 참조만 있다
        expect(server.headers.Authorization).toBe('Bearer $B_STUDIO_MCP_TOKEN');
        expect(JSON.stringify(config)).not.toContain(env.B_STUDIO_MCP_TOKEN!);
        // 알려진 내장 도구가 블록리스트에 있다(allowlist가 아니라 블록리스트라는 한계를 테스트로도 고정한다)
        expect(config.excludeTools).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_shell_command']));

        // cwd와 HOME은 서로 다른 임시 폴더이고 둘 다 tmpdir 안이다
        const home = env.HOME!;
        expect(home).not.toBe(cwd);
        expect(cwd.startsWith(tmpdir())).toBe(true);
        expect(home.startsWith(tmpdir())).toBe(true);
        // 작업 폴더에는 설정 파일만 있다. 사용자 설정이 실리지 않는다
        expect(await readdir(cwd)).toEqual(['.gemini']);
        // 로그인 파일이 있으면 임시 HOME에 링크한다(복사하지 않는다)
        const link = path.join(home, '.gemini', 'oauth_creds.json');
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readlink(link)).toBe(path.join(originalHome, '.gemini', 'oauth_creds.json'));

        // 도구 호출은 MCP 서버 → executeTool → 작업 공간으로 간다
        await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
      },
    });
    const sandbox = fakeSandbox(project, [true]);
    const events: AgentEvent[] = [];

    const result = await runGeminiAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox,
      model: MODEL,
      process,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', summary: '메모 필드를 추가했습니다.', verifyAttempts: 0, turns: 1 });
    expect(result.changedFiles).toEqual(['api/src/Order.java']);

    const { args, cwd, env } = state.calls[0]!;
    expect(args).toEqual(['-p', expect.stringContaining('mcp__b_studio__read_file'), '--output-format', 'json', '-m', MODEL]);
    // 이어받기 옵션은 첫 실행에 없다(세션 id가 없다)
    expect(args).not.toContain('--resume');
    expect(env.B_STUDIO_MCP_TOKEN).toMatch(/^[0-9a-f]{48}$/);

    expect(events.find((event) => event.type === 'session')).toMatchObject({ backend: '로컬 Gemini Agent', model: MODEL });
    expect(events.flatMap((event) => (event.type === 'tool_call' ? [event.name] : []))).toEqual(['edit_file']);
    expect(events.flatMap((event) => (event.type === 'tool_result' ? [event.ok] : []))).toEqual([true]);

    // 실행이 끝나면 임시 폴더는 지워지고 원본 oauth_creds.json은 그대로 남는다
    await expect(stat(cwd)).rejects.toThrow();
    await expect(stat(env.HOME!)).rejects.toThrow();
    expect(await readFile(path.join(originalHome, '.gemini', 'oauth_creds.json'), 'utf8')).toBe('{"token":"secret"}\n');
  });

  it('응답에 session_id가 실리면 받아서 다음 턴에 --resume으로 이어받는다(게이트 재시도)', async () => {
    const { process, state } = fakeGemini([success('메모를 추가했습니다.', OK_TOKENS, 'ses_1'), success('컴파일 에러를 고쳤습니다.', OK_TOKENS, 'ses_2')], {
      onStart: async ({ cwd, env }) => {
        await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
      },
    });
    const sandbox = fakeSandbox(project, [false, true]);

    const result = await runGeminiAgent({ request: '주문에 메모 필드 추가', project, sandbox, process, model: MODEL, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 2, sessionId: 'ses_2' });
    expect(sandbox.restarts).toEqual(['api', 'api']);
    expect(state.calls).toHaveLength(2);
    // 첫 실행은 세션 id가 없어 --resume을 넘기지 않고, 재시도는 받은 id로 이어받는다
    expect(state.calls[0]!.args).not.toContain('--resume');
    expect(state.calls[1]!.args).toEqual(expect.arrayContaining(['--resume', 'ses_1']));
    // 프롬프트는 언제나 두 번째 인자(-p 다음)다. 게이트 실패 피드백이 거기에 실린다
    expect(state.calls[1]!.args[1]).toContain('[b-studio 검증 게이트]');
    expect(state.calls[1]!.args[1]).toContain('cannot find symbol');
  });

  it('세션 id를 한 번도 받지 못하면 --resume 없이 매 턴을 새 대화로 시작한다', async () => {
    const { process, state } = fakeGemini([success('메모를 추가했습니다.'), success('컴파일 에러를 고쳤습니다.')], {
      onStart: async ({ cwd, env }) => {
        await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
      },
    });
    const sandbox = fakeSandbox(project, [false, true]);

    const result = await runGeminiAgent({ request: '주문에 메모 필드 추가', project, sandbox, process, model: MODEL, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done', sessionId: undefined });
    expect(state.calls[0]!.args).not.toContain('--resume');
    expect(state.calls[1]!.args).not.toContain('--resume');
  });

  it('stateDir과 함께 resume을 주면 첫 실행부터 --resume <id>로 이어받는다', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'gemini-state-'));
    const { process, state } = fakeGemini([success('ok', OK_TOKENS, 'forked-1')]);

    try {
      const result = await runGeminiAgent({ request: '이어서 해줘', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, stateDir, resume: 'previous-session', fetcher: async () => contract });

      expect(result).toMatchObject({ status: 'done', sessionId: 'forked-1' });
      expect(state.calls[0]!.args).toEqual(expect.arrayContaining(['--resume', 'previous-session']));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('stateDir 없이 resume을 주면 이어받지 않고 새 대화로 시작하며 한 번 알린다', async () => {
    const { process, state } = fakeGemini([success('ok', OK_TOKENS, 'ses_9')]);
    const events: AgentEvent[] = [];

    const result = await runGeminiAgent({
      request: '이어서 해줘',
      intent: 'ask',
      project,
      sandbox: fakeSandbox(project, []),
      process,
      model: MODEL,
      resume: 'previous-session',
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', sessionId: 'ses_9' });
    expect(state.calls[0]!.args).not.toContain('--resume');
    expect(events.filter((event) => event.type === 'warning')).toEqual(expect.arrayContaining([{ type: 'warning', message: '이 실행은 이전 대화를 이어받지 못합니다: 상태 폴더 없음' }]));
  });

  it('stateDir을 주면 실행 사이에 같은 HOME·같은 cwd를 쓰고, 두 번째 실행이 받은 세션 id로 이어받는다', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'gemini-state-'));
    const { process, state } = fakeGemini([success('첫 작업을 끝냈습니다.', OK_TOKENS, 'ses_1'), success('이어서 끝냈습니다.', OK_TOKENS, 'ses_2')]);

    try {
      const first = await runGeminiAgent({ request: '첫 작업', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, stateDir, fetcher: async () => contract });
      const second = await runGeminiAgent({ request: '이어서', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, stateDir, resume: first.sessionId, fetcher: async () => contract });

      expect(first).toMatchObject({ status: 'done', sessionId: 'ses_1' });
      expect(second).toMatchObject({ status: 'done', sessionId: 'ses_2' });
      expect(state.calls).toHaveLength(2);
      expect(state.calls[0]!.cwd).toBe(path.join(stateDir, 'work'));
      expect(state.calls[1]!.cwd).toBe(state.calls[0]!.cwd);
      expect(state.calls[0]!.env.HOME).toBe(path.join(stateDir, 'home'));
      expect(state.calls[1]!.env.HOME).toBe(state.calls[0]!.env.HOME);
      expect(state.calls[0]!.args).not.toContain('--resume');
      expect(state.calls[1]!.args).toEqual(expect.arrayContaining(['--resume', 'ses_1']));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('승격 옵션을 받으면 무시하지 않고 경고 이벤트를 한 번 알린다', async () => {
    const { process } = fakeGemini([success('ok')]);
    const events: AgentEvent[] = [];

    const result = await runGeminiAgent({
      request: '안녕',
      intent: 'ask',
      project,
      sandbox: fakeSandbox(project, []),
      process,
      model: MODEL,
      escalation: { to: 'gemini-2.5-flash' },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done' });
    const warnings = events.filter((event): event is Extract<AgentEvent, { type: 'warning' }> => event.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('승격을 지원하지 않습니다');
  });

  it('노력 단계를 받으면 무시하지 않고 경고 이벤트를 한 번 알리고, CLI 인자에는 넣지 않는다(플래그를 확인하지 못했다)', async () => {
    const { process, state } = fakeGemini([success('ok')]);
    const events: AgentEvent[] = [];

    await runGeminiAgent({ request: '안녕', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, effort: 'high', fetcher: async () => contract, onEvent: (event) => events.push(event) });

    const warnings = events.filter((event): event is Extract<AgentEvent, { type: 'warning' }> => event.type === 'warning');
    expect(warnings.some((warning) => warning.message.includes('노력 단계'))).toBe(true);
    expect(state.calls[0]!.args.join(' ')).not.toContain('effort');
  });

  it('사용 한도·인증 실패·취소를 각각 분류하고 게이트를 돌리지 않는다', async () => {
    const limited = await runGeminiAgent({
      request: '추가해줘',
      project,
      sandbox: fakeSandbox(project, []),
      model: MODEL,
      process: fakeGemini([{ stdout: JSON.stringify({ error: { type: 'RESOURCE_EXHAUSTED', message: '하루 요청 한도를 넘었습니다', code: 429 } }) }]).process,
      fetcher: async () => contract,
    });
    expect(limited).toMatchObject({ status: 'failed', summary: 'Gemini 사용 한도에 걸렸습니다: 하루 요청 한도를 넘었습니다', turns: 0 });

    const login = await runGeminiAgent({
      request: '추가해줘',
      project,
      sandbox: fakeSandbox(project, []),
      model: MODEL,
      process: fakeGemini([{ exitCode: 1, stderr: 'Error: not authenticated, please log in' }]).process,
      fetcher: async () => contract,
    });
    expect(login.summary).toContain('로그인돼 있지 않습니다');

    const interrupted = await runGeminiAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), model: MODEL, process: fakeGemini([{ exitCode: 130 }]).process, fetcher: async () => contract });
    expect(interrupted.summary).toBe('요청을 취소했습니다');
  });

  it('JSON이 아닌 응답(예상과 다른 출력)은 원문 일부를 그대로 보여주고 지어내지 않는다', async () => {
    const result = await runGeminiAgent({
      request: '추가해줘',
      project,
      sandbox: fakeSandbox(project, []),
      model: MODEL,
      process: fakeGemini([{ stdout: '이것은 JSON이 아닙니다' }]).process,
      fetcher: async () => contract,
    });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('예상한 JSON 형식으로 응답하지 않았습니다');
    expect(result.summary).toContain('이것은 JSON이 아닙니다');
  });

  it('토큰을 모델별로 합치고(prompt→input, candidates+thoughts→output, cached→cacheRead), modelCalls·maxContextTokens를 남긴다', async () => {
    const { process } = fakeGemini(
      [
        { stdout: JSON.stringify({ response: '메모를 추가했습니다.', stats: { models: { [MODEL]: { tokens: { prompt: 100, candidates: 5, cached: 10, thoughts: 3 } } } } }) },
        { stdout: JSON.stringify({ response: '고쳤습니다.', stats: { models: { [MODEL]: { tokens: { prompt: 200, candidates: 7, cached: 20, thoughts: 2 } } } } }) },
      ],
      {
        onStart: async ({ cwd, env }) => {
          await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
        },
      },
    );
    const events: AgentEvent[] = [];

    const result = await runGeminiAgent({ request: '주문에 메모 필드 추가', project, sandbox: fakeSandbox(project, [false, true]), process, model: MODEL, fetcher: async () => contract, onEvent: (event) => events.push(event) });

    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: (5 + 3) + (7 + 2), cacheReadTokens: 30, cacheWriteTokens: 0 });
    expect(result.metrics?.modelCalls).toBe(2);
    expect(result.metrics?.maxContextTokens).toBe(220);
    expect(events.flatMap((event) => (event.type === 'tokens' ? [event.usage.inputTokens] : []))).toEqual([100, 300]);
  });
});

describe('geminiSettingsJson', () => {
  it('토큰 값 없이 환경 변수 참조만 쓰고, trust:true와 블록리스트를 둔다', () => {
    const config = JSON.parse(geminiSettingsJson('http://127.0.0.1:9999/mcp')) as {
      mcpServers: Record<string, { httpUrl: string; headers: Record<string, string>; trust: boolean }>;
      excludeTools: string[];
    };
    expect(config.mcpServers.b_studio!.httpUrl).toBe('http://127.0.0.1:9999/mcp');
    expect(config.mcpServers.b_studio!.headers.Authorization).toBe('Bearer $B_STUDIO_MCP_TOKEN');
    expect(config.mcpServers.b_studio!.trust).toBe(true);
    expect(geminiSettingsJson('http://127.0.0.1:9999/mcp')).not.toContain('Bearer B');
    expect(config.excludeTools.length).toBeGreaterThan(0);
  });
});
