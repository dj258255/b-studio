import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Board } from './coordination';
import type { AgentEvent } from './loop';
import { OPENCODE_FREE_UNUSABLE_REASON, OPENCODE_MODEL_REQUIRED, OPENCODE_PROVIDER_GATE_MESSAGE, openCodeJson, parseOpenCodeModels, runOpenCodeAgent, type OpenCodeProcess } from './opencode-runner';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT as contract } from './test-helpers';

/** 테스트가 쓰는 모델. 러너는 모델을 추측하지 않고 항상 명시받는다 */
const MODEL = 'opencode/space-bunny-free';
/** 무료 Zen 거절 문구(3단계 실측) */
const GATE_MESSAGE = "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode";

let project: LoadedProject;
/** 이 PC의 진짜 ~/.local/share/opencode 대신 테스트가 만든 원본 홈. 러너가 여기서 auth.json을 링크한다 */
let originalHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  project = await createOrdersProject('opencode-runner-test-');
  savedHome = process.env.HOME;
  originalHome = await mkdtemp(path.join(tmpdir(), 'opencode-home-original-'));
  await mkdir(path.join(originalHome, '.local', 'share', 'opencode'), { recursive: true });
  await writeFile(path.join(originalHome, '.local', 'share', 'opencode', 'auth.json'), '{"token":"secret"}\n');
  process.env.HOME = originalHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(originalHome, { recursive: true, force: true }).catch(() => {});
});

/** 한 번의 `opencode run` 실행이 낼 NDJSON과 종료 코드 */
interface FakeRun {
  /** stdout에 한 줄씩 나갈 이벤트 객체 */
  events?: Array<Record<string, unknown>>;
  exitCode?: number;
  stderr?: string;
}

interface FakeHooks {
  /** 실행이 시작될 때(임시 폴더가 살아 있는 동안) 파일·인자를 확인하는 훅 */
  onStart?: (info: { args: string[]; cwd: string; env: Record<string, string> }) => Promise<void>;
}

/**
 * `opencode`를 흉내 내는 가짜 프로세스. 넘긴 인자·환경·cwd를 그대로 기록하고, 스크립트의 NDJSON과 종료 코드를 돌려준다.
 * onStart에서 `opencode.json`을 읽어 러너의 MCP 서버에 실제로 붙을 수 있다(도구 라우팅 검증).
 */
function fakeOpenCode(script: FakeRun[], hooks: FakeHooks = {}) {
  const state = { calls: [] as Array<{ args: string[]; cwd: string; env: Record<string, string> }> };
  const process: OpenCodeProcess = {
    run({ args, cwd, env }) {
      state.calls.push({ args, cwd, env });
      const next = script.shift();
      if (!next) throw new Error('스크립트에 남은 실행이 없습니다');
      const events = next.events ?? [];
      const exitCode = next.exitCode ?? 0;
      const stderr = next.stderr ?? '';
      async function* lines(): AsyncGenerator<string> {
        await hooks.onStart?.({ args, cwd, env });
        for (const event of events) yield JSON.stringify(event);
      }
      return { lines: lines(), exitCode: Promise.resolve(exitCode), stderr: async () => stderr };
    },
  };
  return { process, state };
}

/** 러너가 작업 폴더에 쓴 `opencode.json`을 읽어 그대로 MCP 서버에 연결한다. 토큰은 환경 변수에서 꺼낸 실제 값을 쓴다 */
async function connectStudio(cwd: string, env: Record<string, string>): Promise<Client> {
  const config = JSON.parse(await readFile(path.join(cwd, 'opencode.json'), 'utf8')) as {
    mcp: Record<string, { url: string; headers: { Authorization: string } }>;
  };
  const server = config.mcp.b_studio!;
  const token = env.B_STUDIO_MCP_TOKEN;
  if (!token) throw new Error('MCP 토큰이 환경에 없습니다');
  const client = new Client({ name: 'fake-opencode', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

async function callStudioTool(cwd: string, env: Record<string, string>, name: string, args: unknown) {
  const client = await connectStudio(cwd, env);
  try {
    return await client.callTool({ name, arguments: args as Record<string, unknown> });
  } finally {
    await client.close().catch(() => {});
  }
}

const OK_TOKENS = { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } };

function success(id: string, text: string, tokens: Record<string, unknown> = OK_TOKENS): FakeRun {
  return {
    events: [
      { type: 'step_start', sessionID: id, part: { type: 'step-start', sessionID: id } },
      { type: 'text', sessionID: id, part: { type: 'text', text } },
      { type: 'step_finish', sessionID: id, part: { type: 'step-finish', reason: 'stop', tokens } },
    ],
  };
}

describe('runOpenCodeAgent', () => {
  it('모델을 주지 않으면 추측하지 않고 오류를 낸다', async () => {
    await expect(runOpenCodeAgent({ request: '질문', intent: 'ask', project, sandbox: fakeSandbox(project, []), process: fakeOpenCode([]).process, fetcher: async () => contract })).rejects.toThrow(OPENCODE_MODEL_REQUIRED);
  });

  it('도구 호출이 MCP 서버를 거쳐 executeTool로 가 작업 공간을 바꾸고, 인자·임시 폴더·설정을 남긴다', async () => {
    const { process, state } = fakeOpenCode([success('ses_1', '메모 필드를 추가했습니다.')], {
      onStart: async ({ cwd, env }) => {
        // 작업 폴더(cwd)에 실행별 MCP 설정과 전용 에이전트가 있다
        const config = JSON.parse(await readFile(path.join(cwd, 'opencode.json'), 'utf8')) as {
          mcp: Record<string, { url: string; headers: Record<string, string> }>;
          agent: Record<string, { permission: Record<string, string> }>;
        };
        const server = config.mcp.b_studio!;
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        // 토큰 값은 파일에 없고 환경 변수 참조만 있다(opencode 보간은 {env:VAR})
        expect(server.headers.Authorization).toBe('Bearer {env:B_STUDIO_MCP_TOKEN}');
        expect(JSON.stringify(config)).not.toContain(env.B_STUDIO_MCP_TOKEN!);

        // 권한: 넓은 deny가 먼저, 좁은 allow가 나중(=마지막으로 맞는 규칙이 이긴다)
        // 허용 키는 MCP 도구 이름 글롭이다(실행 캡처로 확인). 내장 도구는 넓은 deny만 맞아 빠진다
        const permission = config.agent['b-studio']!.permission;
        expect(Object.keys(permission)).toEqual(['*', 'b_studio_*']);
        expect(permission['*']).toBe('deny');
        expect(permission['b_studio_*']).toBe('allow');

        // cwd와 HOME은 서로 다른 임시 폴더이고 둘 다 tmpdir 안이다
        const home = env.HOME!;
        expect(home).not.toBe(cwd);
        expect(cwd.startsWith(tmpdir())).toBe(true);
        expect(home.startsWith(tmpdir())).toBe(true);
        // 작업 폴더에는 설정 파일만 있다. 사용자 설정·스킬이 실리지 않는다
        expect(await readdir(cwd)).toEqual(['opencode.json']);
        // 기본(linkAuth=true)은 로그인 파일이 있으면 임시 HOME에 링크한다(복사하지 않는다)
        expect(await readdir(home)).toEqual(['.local']);
        const link = path.join(home, '.local', 'share', 'opencode', 'auth.json');
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readlink(link)).toBe(path.join(originalHome, '.local', 'share', 'opencode', 'auth.json'));
        // 다른 설정 경로가 끼어들지 않게 격리한다
        expect(env.OPENCODE_CONFIG).toBe(path.join(cwd, 'opencode.json'));
        expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
        expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('1');
        expect(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe('1');
        expect(env.XDG_DATA_HOME).toBe(path.join(home, '.local', 'share'));

        // 도구 호출은 MCP 서버 → executeTool → 작업 공간으로 간다
        await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
      },
    });
    const sandbox = fakeSandbox(project, [true]);
    const events: AgentEvent[] = [];

    const result = await runOpenCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox,
      model: MODEL,
      process,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', summary: '메모 필드를 추가했습니다.', verifyAttempts: 0, turns: 1, sessionId: 'ses_1' });
    expect(result.changedFiles).toEqual(['api/src/Order.java']);

    const { args, cwd, env } = state.calls[0]!;
    expect(args[0]).toBe('run');
    expect(args).toEqual(expect.arrayContaining(['--format', 'json', '--pure', '--agent', 'b-studio', '-m', MODEL]));
    // 이어받기 옵션은 첫 실행에 없다
    expect(args).not.toContain('--session');
    expect(args).not.toContain('--fork');
    // 요청은 system prompt·도구 이름과 함께 마지막 위치 인자로 간다
    expect(args.at(-1)).toContain('mcp__b_studio__read_file');
    expect(env.B_STUDIO_MCP_TOKEN).toMatch(/^[0-9a-f]{48}$/);

    expect(events.find((event) => event.type === 'session')).toMatchObject({ backend: '로컬 OpenCode Agent', model: MODEL });
    expect(events.flatMap((event) => (event.type === 'tool_call' ? [event.name] : []))).toEqual(['edit_file']);
    expect(events.flatMap((event) => (event.type === 'tool_result' ? [event.ok] : []))).toEqual([true]);

    // 실행이 끝나면 임시 폴더는 지워지고 원본 auth.json은 그대로 남는다
    await expect(stat(cwd)).rejects.toThrow();
    await expect(stat(env.HOME!)).rejects.toThrow();
    expect(await readFile(path.join(originalHome, '.local', 'share', 'opencode', 'auth.json'), 'utf8')).toBe('{"token":"secret"}\n');
  });

  it('effort를 넘기면 --variant 인자로 전달하고 세션 알림에도 남긴다', async () => {
    const { process, state } = fakeOpenCode([success('ses_1', '완료')]);
    const events: AgentEvent[] = [];

    await runOpenCodeAgent({
      request: '요청',
      project,
      sandbox: fakeSandbox(project, [true]),
      model: MODEL,
      effort: 'high',
      process,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(state.calls[0]!.args).toEqual(expect.arrayContaining(['--variant', 'high']));
    expect(events.find((event) => event.type === 'session')).toMatchObject({ backend: '로컬 OpenCode Agent', effort: 'high' });
  });

  it('effort를 넘기지 않으면 --variant 인자를 붙이지 않는다', async () => {
    const { process, state } = fakeOpenCode([success('ses_1', '완료')]);

    await runOpenCodeAgent({ request: '요청', project, sandbox: fakeSandbox(project, [true]), model: MODEL, process, fetcher: async () => contract });

    expect(state.calls[0]!.args).not.toContain('--variant');
  });

  it('linkAuth=false면 로그인 파일을 링크하지 않는다', async () => {
    const { process } = fakeOpenCode([success('ses_1', 'ok')], {
      onStart: async ({ env }) => {
        await expect(lstat(path.join(env.HOME!, '.local', 'share', 'opencode', 'auth.json'))).rejects.toThrow();
      },
    });
    await runOpenCodeAgent({ request: '질문', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, linkAuth: false, fetcher: async () => contract });
  });

  it('로그인 파일이 없으면(linkAuth 기본) 링크하지 않고 진행한다', async () => {
    await rm(path.join(originalHome, '.local', 'share', 'opencode', 'auth.json'));
    const { process } = fakeOpenCode([success('ses_1', 'ok')], {
      onStart: async ({ env }) => {
        await expect(lstat(path.join(env.HOME!, '.local', 'share', 'opencode', 'auth.json'))).rejects.toThrow();
      },
    });
    await runOpenCodeAgent({ request: '질문', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, fetcher: async () => contract });
  });

  it('게이트가 실패하면 같은 세션을 갈라 이어받아 다시 돌리고(새 sessionId), 통과하면 끝난다', async () => {
    const { process, state } = fakeOpenCode([success('ses_1', '메모를 추가했습니다.'), success('ses_2', '컴파일 에러를 고쳤습니다.')], {
      onStart: async ({ cwd, env }) => {
        await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
      },
    });
    const sandbox = fakeSandbox(project, [false, true]);

    const result = await runOpenCodeAgent({ request: '주문에 메모 필드 추가', project, sandbox, process, model: MODEL, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 2, sessionId: 'ses_2' });
    expect(sandbox.restarts).toEqual(['api', 'api']);
    expect(state.calls).toHaveLength(2);
    // 첫 실행은 새 세션, 재시도는 이전 세션을 갈라 이어받는다
    expect(state.calls[0]!.args).not.toContain('--session');
    expect(state.calls[1]!.args).toEqual(expect.arrayContaining(['--session', 'ses_1', '--fork']));
    expect(state.calls[1]!.args.at(-1)).toContain('[b-studio 검증 게이트]');
    expect(state.calls[1]!.args.at(-1)).toContain('cannot find symbol');
  });

  it('무료 Zen 거절(provider_gate)은 재시도하지 않고 한국어 요약으로 끝난다', async () => {
    // 오류 이벤트로 와도, 자식이 이어서 종료해도 한 번만 돌고 끝난다
    const { process, state } = fakeOpenCode([
      { events: [{ type: 'error', sessionID: 'ses_1', error: GATE_MESSAGE }, { type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: OK_TOKENS } }], exitCode: 1 },
      // 두 번째가 실행되면 재시도한 것이다(스크립트가 소진되면 예외)
      success('ses_2', '다시'),
    ]);
    const events: AgentEvent[] = [];

    const result = await runOpenCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), process, model: MODEL, fetcher: async () => contract, onEvent: (event) => events.push(event) });

    expect(result.status).toBe('failed');
    expect(result.summary).toBe(OPENCODE_PROVIDER_GATE_MESSAGE);
    expect(state.calls).toHaveLength(1);
    // 게이트 재시도를 하지 않았으므로 샌드박스 재시작도 없다
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(1);
  });

  it('stderr의 같은 문구도 provider_gate로 분류한다', async () => {
    const result = await runOpenCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), process: fakeOpenCode([{ exitCode: 1, stderr: GATE_MESSAGE }]).process, model: MODEL, fetcher: async () => contract });
    expect(result.summary).toBe(OPENCODE_PROVIDER_GATE_MESSAGE);
  });

  it('오류 이벤트를 내보낸 뒤 종료하지 않는 자식이면, 러너가 자식을 죽이고 제한 시간 안에 실패로 끝난다', async () => {
    const state = { calls: 0, aborted: false };
    const process: OpenCodeProcess = {
      run({ signal }) {
        state.calls += 1;
        signal?.addEventListener('abort', () => {
          state.aborted = true;
        });
        async function* lines(): AsyncGenerator<string> {
          yield JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start', sessionID: 'ses_1' } });
          yield JSON.stringify({ type: 'error', sessionID: 'ses_1', error: GATE_MESSAGE });
          // 여기서 영원히 멈춘다(스트림을 끝내지 않는다)
          await new Promise(() => {});
        }
        return { lines: lines(), exitCode: new Promise<number>(() => {}), stderr: async () => '' };
      },
    };

    const started = performance.now();
    const result = await runOpenCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), process, model: MODEL, fetcher: async () => contract });

    expect(result.status).toBe('failed');
    expect(result.summary).toBe(OPENCODE_PROVIDER_GATE_MESSAGE);
    expect(state.calls).toBe(1);
    expect(state.aborted).toBe(true);
    // 매달리지 않고 제한 시간 안에 끝난다
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('사용 한도·크레딧·인증 문구를 각각 분류하고 게이트를 돌리지 않는다', async () => {
    const limit = "You've reached your usage limit. Resets in 3h.";
    const limited = await runOpenCodeAgent({
      request: '추가해줘',
      project,
      sandbox: fakeSandbox(project, []),
      model: MODEL,
      process: fakeOpenCode([{ exitCode: 1, stderr: limit }]).process,
      fetcher: async () => contract,
    });
    expect(limited).toMatchObject({ status: 'failed', summary: `OpenCode 사용 한도에 걸렸습니다: ${limit}`, turns: 0 });

    const credit = await runOpenCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), model: MODEL, process: fakeOpenCode([{ exitCode: 1, stderr: 'Insufficient credits for OpenCode' }]).process, fetcher: async () => contract });
    expect(credit.summary).toBe('OpenCode 크레딧이 부족합니다: Insufficient credits for OpenCode');

    const login = await runOpenCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), model: MODEL, process: fakeOpenCode([{ exitCode: 1, stderr: 'Error: not authenticated' }]).process, fetcher: async () => contract });
    expect(login.summary).toContain('로그인돼 있지 않습니다');

    const interrupted = await runOpenCodeAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), model: MODEL, process: fakeOpenCode([{ exitCode: 130 }]).process, fetcher: async () => contract });
    expect(interrupted.summary).toBe('요청을 취소했습니다');
  });

  it('스텝별 tokens를 실행 합계로 더하고, modelCalls·maxContextTokens를 이벤트에서 남긴다', async () => {
    const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, reasoning: 0, cache: { read: cacheRead, write: cacheWrite } });
    const { process } = fakeOpenCode([success('ses_1', '메모를 추가했습니다.', tokens(100, 5, 10, 1)), success('ses_2', '고쳤습니다.', tokens(200, 7, 20, 2))], {
      onStart: async ({ cwd, env }) => {
        await callStudioTool(cwd, env, 'edit_file', { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' });
      },
    });
    const events: AgentEvent[] = [];

    const result = await runOpenCodeAgent({ request: '주문에 메모 필드 추가', project, sandbox: fakeSandbox(project, [false, true]), process, model: MODEL, fetcher: async () => contract, onEvent: (event) => events.push(event) });

    // 실행 단위 합계를 더한다(누적이면 마지막 값만 남는다)
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 3 });
    // 스텝을 끝낼 때마다 그때까지의 누적값을 알린다
    expect(events.flatMap((event) => (event.type === 'tokens' ? [event.usage.inputTokens] : []))).toEqual([100, 300]);
    expect(result.metrics?.modelCalls).toBe(2);
    expect(result.metrics?.maxContextTokens).toBe(222);
    // 스텝 시간이 없으므로 0("재지 않음")이다
    expect(result.metrics?.modelMs).toBe(0);
  });

  it('usageByModel을 고른 모델 이름으로 채운다(이슈 #428, 모델은 항상 명시하므로 백엔드 기본 키로 떨어지지 않는다)', async () => {
    const { process } = fakeOpenCode([success('ses_1', '완료')]);
    const result = await runOpenCodeAgent({ request: '요청', project, sandbox: fakeSandbox(project, [true]), process, model: MODEL, fetcher: async () => contract });
    expect(result.metrics?.usageByModel).toEqual({ [MODEL]: result.usage });
  });

  it('조율 게시판을 켜면 post_note·read_notes가 도구 목록에 오르고 MCP 서버를 거쳐 레인 신원으로 게시·조회된다(이슈 #428, E12)', async () => {
    const board = new Board({ topology: 'mesh' });
    const { process } = fakeOpenCode([success('ses_1', '계약을 남겼습니다.')], {
      onStart: async ({ cwd, env }) => {
        const client = await connectStudio(cwd, env);
        try {
          const listed = await client.listTools();
          expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['post_note', 'read_notes']));
          await client.callTool({ name: 'post_note', arguments: { kind: 'contract', body: 'GET /api/orders → [{ id, amount }]', refs: ['api'] } });
        } finally {
          await client.close().catch(() => {});
        }
      },
    });

    const result = await runOpenCodeAgent({
      request: '계약 남기기',
      project,
      sandbox: fakeSandbox(project, [true]),
      process,
      model: MODEL,
      fetcher: async () => contract,
      board: {
        lane: 'api',
        post: (input) => board.post(input, { lane: 'api', by: 'model' }),
        read: (options) => board.read({ lane: 'api' }, options),
      },
    });

    expect(result.status).toBe('done');
    expect(board.snapshot()).toMatchObject([{ kind: 'contract', author: { lane: 'api', by: 'model' } }]);
  });

  it('읽기 전용 게시판(modelWrites: false)을 켜면 read_notes만 도구 목록에 오르고, 다른 레인이 남긴 메모를 읽는다', async () => {
    const board = new Board({ topology: 'mesh', modelWrites: false });
    board.post({ kind: 'fact', body: '다른 레인이 남긴 사실' }, { lane: 'platform', by: 'platform' });
    const { process } = fakeOpenCode([success('ses_1', '읽었습니다.')], {
      onStart: async ({ cwd, env }) => {
        const client = await connectStudio(cwd, env);
        try {
          const listed = await client.listTools();
          expect(listed.tools.map((tool) => tool.name)).toContain('read_notes');
          expect(listed.tools.map((tool) => tool.name)).not.toContain('post_note');
          const read = await client.callTool({ name: 'read_notes', arguments: { kinds: [] } });
          expect(JSON.stringify(read)).toContain('다른 레인이 남긴 사실');
        } finally {
          await client.close().catch(() => {});
        }
      },
    });

    const result = await runOpenCodeAgent({
      request: '읽기만',
      project,
      sandbox: fakeSandbox(project, [true]),
      process,
      model: MODEL,
      fetcher: async () => contract,
      board: {
        lane: 'api',
        modelWrites: false,
        post: (input) => board.post(input, { lane: 'api', by: 'model' }),
        read: (options) => board.read({ lane: 'api' }, options),
      },
    });

    expect(result.status).toBe('done');
  });

  it('stateDir과 함께 resume을 주면 첫 실행부터 --session <id> --fork로 이어받고 새 sessionId를 남긴다', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'opencode-state-'));
    const { process, state } = fakeOpenCode([success('forked-1', 'ok')]);

    try {
      const result = await runOpenCodeAgent({ request: '이어서 해줘', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, stateDir, resume: 'previous-session', fetcher: async () => contract });

      expect(result).toMatchObject({ status: 'done', sessionId: 'forked-1' });
      expect(state.calls[0]!.args).toEqual(expect.arrayContaining(['--session', 'previous-session', '--fork']));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('stateDir 없이 resume을 주면 이어받지 않고 새 대화로 시작하며 한 번 알린다', async () => {
    const { process, state } = fakeOpenCode([success('ses_9', 'ok')]);
    const events: AgentEvent[] = [];

    const result = await runOpenCodeAgent({
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

    // 이어받을 수 없다는 것을 알면서 --session을 넘기지 않는다(HOME·XDG가 달라지므로 찾지 못한다)
    expect(result).toMatchObject({ status: 'done', sessionId: 'ses_9' });
    expect(state.calls[0]!.args).not.toContain('--session');
    expect(events.filter((event) => event.type === 'warning')).toEqual([{ type: 'warning', message: '이 실행은 이전 대화를 이어받지 못합니다: 상태 폴더 없음' }]);
  });

  it('stateDir을 주면 실행 사이에 같은 HOME·같은 cwd·같은 XDG를 쓰고, 두 번째 실행이 그 세션을 이어받는다', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'opencode-state-'));
    const { process, state } = fakeOpenCode([success('ses_1', '첫 작업을 끝냈습니다.'), success('ses_2', '이어서 끝냈습니다.')]);

    try {
      const first = await runOpenCodeAgent({ request: '첫 작업', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, stateDir, fetcher: async () => contract });
      const second = await runOpenCodeAgent({ request: '이어서', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, stateDir, resume: first.sessionId, fetcher: async () => contract });

      expect(first).toMatchObject({ status: 'done', sessionId: 'ses_1' });
      expect(second).toMatchObject({ status: 'done', sessionId: 'ses_2' });
      expect(state.calls).toHaveLength(2);
      // opencode는 세션·DB를 HOME과 그 아래 XDG에 둔다. 두 값이 실행 사이에도 같아야 이어받는다
      expect(state.calls[0]!.cwd).toBe(path.join(stateDir, 'work'));
      expect(state.calls[1]!.cwd).toBe(state.calls[0]!.cwd);
      expect(state.calls[0]!.env.HOME).toBe(path.join(stateDir, 'home'));
      expect(state.calls[1]!.env.HOME).toBe(state.calls[0]!.env.HOME);
      expect(state.calls[0]!.env.XDG_DATA_HOME).toBe(path.join(stateDir, 'home', '.local', 'share'));
      expect(state.calls[1]!.env.XDG_DATA_HOME).toBe(state.calls[0]!.env.XDG_DATA_HOME);
      // 첫 실행은 새 세션, 두 번째 실행은 그 세션을 갈라 이어받는다
      expect(state.calls[0]!.args).not.toContain('--session');
      expect(state.calls[1]!.args).toEqual(expect.arrayContaining(['--session', 'ses_1', '--fork']));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('stateDir의 home은 실행 뒤에도 남고, work는 다음 실행이 시작할 때 비워진다', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'opencode-state-'));
    const home = path.join(stateDir, 'home');
    const workdir = path.join(stateDir, 'work');

    try {
      const first = fakeOpenCode([success('ses_1', 'ok')]);
      await runOpenCodeAgent({ request: '질문', intent: 'ask', project, sandbox: fakeSandbox(project, []), process: first.process, model: MODEL, stateDir, fetcher: async () => contract });

      // HOME은 지우지 않는다. 로그인 링크도 그대로 남아 다음 실행이 다시 만들지 않는다
      expect((await lstat(path.join(home, '.local', 'share', 'opencode', 'auth.json'))).isSymbolicLink()).toBe(true);
      // 지난 실행이 남긴 파일을 심어 두고 다음 실행이 비우는지 본다
      await writeFile(path.join(workdir, 'model-output.txt'), '남은 파일\n');

      const second = fakeOpenCode([success('ses_2', 'ok')]);
      await runOpenCodeAgent({ request: '질문', intent: 'ask', project, sandbox: fakeSandbox(project, []), process: second.process, model: MODEL, stateDir, fetcher: async () => contract });

      // 실행 시작 때 비우므로 이번 실행의 설정만 남는다("빈 작업 폴더" 성질 유지)
      expect(await readdir(workdir)).toEqual(['opencode.json']);
      // HOME은 실행이 끝나도 남는다(세션 DB 위치). 러너가 만드는 것은 로그인 링크가 있는 .local뿐이다
      expect(await readdir(home)).toEqual(['.local']);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('승격 옵션을 받으면 무시하지 않고 경고 이벤트를 한 번 알린다', async () => {
    const { process } = fakeOpenCode([success('ses_1', 'ok')]);
    const events: AgentEvent[] = [];

    const result = await runOpenCodeAgent({
      request: '안녕',
      intent: 'ask',
      project,
      sandbox: fakeSandbox(project, []),
      process,
      model: MODEL,
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

  it('b-studio 도구가 아닌 호출을 실제 이벤트대로 기록한다: 실행은 allow, 거부는 deny, b-studio 도구는 기록하지 않는다', async () => {
    const { process } = fakeOpenCode([
      {
        events: [
          { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start', sessionID: 'ses_1' } },
          // 실행된 호출 → policy allow
          { type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 't1', state: { status: 'completed', output: 'hi\n' } } },
          // 거부된 호출 → policy deny (헤드리스 auto-reject 문구)
          { type: 'tool_use', part: { type: 'tool', tool: 'write', callID: 't2', state: { status: 'error', output: 'Tool execution denied by user.' } } },
          // 같은 callID는 한 번만
          { type: 'tool_use', part: { type: 'tool', tool: 'write', callID: 't2', state: { status: 'error', output: 'Tool execution denied by user.' } } },
          // b-studio MCP 도구는 서버 핸들러가 알리므로 여기서 기록하지 않는다
          { type: 'tool_use', part: { type: 'tool', tool: 'b_studio_list_files', callID: 't3', state: { status: 'completed', output: 'notes.txt' } } },
          { type: 'text', part: { type: 'text', text: 'ok' } },
          { type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: OK_TOKENS } },
        ],
      },
    ]);
    const events: AgentEvent[] = [];

    await runOpenCodeAgent({ request: '파일 목록을 보고 x.txt도 만들어 봐', intent: 'ask', project, sandbox: fakeSandbox(project, []), process, model: MODEL, fetcher: async () => contract, onEvent: (event) => events.push(event) });

    expect(events.filter((event) => event.type === 'policy')).toEqual([
      { type: 'policy', tool: 'bash', decision: 'allow', reason: '내장 도구가 실행됨(b-studio 도구 밖)' },
      { type: 'policy', tool: 'write', decision: 'deny', reason: 'Tool execution denied by user.' },
    ]);
  });
});

describe('openCodeJson', () => {
  it('토큰 값 없이 환경 변수 참조만 쓰고, 권한 규칙은 넓은 deny 다음에 좁은 allow를 둔다', () => {
    const config = JSON.parse(openCodeJson('http://127.0.0.1:9999/mcp')) as {
      mcp: Record<string, { headers: Record<string, string> }>;
      agent: Record<string, { permission: Record<string, string> }>;
    };
    expect(config.mcp.b_studio!.headers.Authorization).toBe('Bearer {env:B_STUDIO_MCP_TOKEN}');
    expect(openCodeJson('http://127.0.0.1:9999/mcp')).not.toContain('Bearer B');
    const permission = config.agent['b-studio']!.permission;
    expect(Object.keys(permission)).toEqual(['*', 'b_studio_*']);
    expect(permission['*']).toBe('deny');
    expect(permission['b_studio_*']).toBe('allow');
  });
});

describe('parseOpenCodeModels', () => {
  it('`opencode models` 출력에서 id·제공자·무료 여부·쓸 수 있는지를 파싱한다', () => {
    const text = [
      'opencode/big-pickle',
      'opencode/ling-3.0-flash-fin-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/space-bunny-free',
      'anthropic/claude-sonnet-4-6',
      '',
      'Pass the full id, or just the short name after the last "/":',
      'opencode models',
    ].join('\n');
    const models = parseOpenCodeModels(text);
    const byId = new Map(models.map((model) => [model.id, model]));

    expect(models.map((model) => model.id)).toEqual([
      'opencode/big-pickle',
      'opencode/ling-3.0-flash-fin-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/space-bunny-free',
      'anthropic/claude-sonnet-4-6',
    ]);
    // 무료 Zen 모델은 내장 도구를 끈 b-studio 구성에서 거절되므로 쓸 수 없다
    expect(byId.get('opencode/mimo-v2.6-flash-free')).toMatchObject({ provider: 'opencode', name: 'mimo-v2.6-flash-free', free: true, usable: false, reason: OPENCODE_FREE_UNUSABLE_REASON });
    expect(byId.get('opencode/space-bunny-free')).toMatchObject({ free: true, usable: false, reason: OPENCODE_FREE_UNUSABLE_REASON });
    // 무료가 아닌 opencode 모델은 지금까지 확인한 사실만으로는 쓸 수 있다고 본다
    expect(byId.get('opencode/big-pickle')).toMatchObject({ free: false, usable: true });
    expect(byId.get('opencode/big-pickle')?.reason).toBeUndefined();
    // 다른 제공자는 이 규칙의 대상이 아니다
    expect(byId.get('anthropic/claude-sonnet-4-6')).toMatchObject({ provider: 'anthropic', free: false, usable: true });
    // 안내 줄은 모델이 아니다
    expect(models).toHaveLength(5);
  });
});
