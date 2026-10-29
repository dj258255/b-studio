import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import type { ThreadEvent, ThreadOptions, Usage } from '@openai/codex-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Board } from './coordination';
import { checkCodexFeatures, codexFeatureConfig, DEFAULT_SDK, runCodexAgent, type CodexConfig, type CodexSdk, type CodexThread } from './codex-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, fakeSteering, ORDERS_CONTRACT as contract } from './test-helpers';

let project: LoadedProject;
/** 이 PC의 진짜 ~/.codex 대신 테스트가 만든 원본 CODEX_HOME. 러너가 여기서 auth.json만 링크한다 */
let originalHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  project = await createOrdersProject('codex-runner-test-');
  savedHome = process.env.CODEX_HOME;
  originalHome = await mkdtemp(path.join(tmpdir(), 'codex-home-original-'));
  await writeFile(path.join(originalHome, 'auth.json'), '{"token":"secret"}\n');
  process.env.CODEX_HOME = originalHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  await rm(originalHome, { recursive: true, force: true }).catch(() => {});
});

type Step = { tool: string; input: Record<string, unknown> } | { text: string };

interface FakeTurn {
  steps: Step[];
  /** 이 턴의 turn.completed.usage. 턴별로 더해지는지 확인한다 */
  usage?: Usage;
  /** 주면 이 턴을 turn.failed로 끝낸다 */
  fail?: string;
  /** 주면 turn.failed 뒤 이 문구로 예외를 던진다. 실제 SDK는 CLI가 종료 코드 1로 끝나면 이벤트를 다 넘긴 뒤 던진다(#983) */
  exitError?: string;
}

/** 첫 turn.runStreamed가 시작될 때(임시 CODEX_HOME이 살아 있는 동안) 실행할 확인 훅 */
interface FakeHooks {
  onStart?: (env: Record<string, string>) => Promise<void>;
  /** `codex features list`의 출력(#980). 주지 않으면 묶인 0.157.0이 러너 설정에서 낸 출력. Error면 목록을 읽지 못한 것 */
  features?: string | Error;
}

/** 묶인 Codex 0.157.0에 러너의 기능 끄기 설정을 넘겨 `codex features list`를 돌린 실제 출력 */
const FEATURES_0157 = readFileSync(path.join(import.meta.dirname, 'fixtures/codex-0.157.0-features.txt'), 'utf8');

/**
 * Codex CLI를 흉내 내는 가짜 SDK.
 * 실제 돌려준 설정(config)·환경(env) 그대로 러너의 MCP 서버에 붙어 도구를 부른다.
 * 그래서 도구 호출이 정말 MCP 서버 → executeTool → 작업 공간으로 가는지 이 테스트에서 확인된다.
 */
function fakeCodex(turns: FakeTurn[], hooks: FakeHooks = {}) {
  const state = {
    prompts: [] as string[],
    configs: [] as Array<Record<string, any>>,
    envs: [] as Array<Record<string, string>>,
    options: [] as ThreadOptions[],
    featureConfigs: [] as Array<Record<string, any>>,
    featureEnvs: [] as Array<Record<string, string>>,
  };
  let id: string | null = null;

  const sdk: CodexSdk = {
    async listFeatures({ config, env }) {
      state.featureConfigs.push(config);
      state.featureEnvs.push(env);
      if (hooks.features instanceof Error) throw hooks.features;
      return hooks.features ?? FEATURES_0157;
    },
    startThread({ config, env, options }) {
      state.configs.push(config);
      state.envs.push(env);
      state.options.push(options);
      const thread: CodexThread = {
        get id() {
          return id;
        },
        async runStreamed(input) {
          state.prompts.push(input);
          await hooks.onStart?.(env);
          const next = turns.shift();
          if (!next) throw new Error('스크립트에 남은 턴이 없습니다');
          const turn: FakeTurn = next;
          let items = 0;

          async function* events(): AsyncGenerator<ThreadEvent> {
            id = 'thread-1';
            yield { type: 'thread.started', thread_id: 'thread-1' };
            yield { type: 'turn.started' };
            if (turn.fail !== undefined) yield { type: 'turn.failed', error: { message: turn.fail } };
            if (turn.exitError !== undefined) throw new Error(turn.exitError);
            if (turn.fail !== undefined) return;
            for (const step of turn.steps) {
              items += 1;
              if ('tool' in step) {
                await callTool(config, env, step.tool, step.input);
                yield {
                  type: 'item.completed',
                  item: { id: `item-${items}`, type: 'mcp_tool_call', server: 'b_studio', tool: step.tool, arguments: step.input, status: 'completed' },
                };
              } else {
                yield { type: 'item.completed', item: { id: `item-${items}`, type: 'agent_message', text: step.text } };
              }
            }
            yield { type: 'turn.completed', usage: turn.usage ?? usage(0) };
          }

          return { events: events() };
        },
      };
      return thread;
    },
  };
  return { sdk, state };
}

/** 러너가 넘긴 설정 그대로 MCP 서버에 붙는다. 토큰은 환경 변수 이름으로 받은 자리에서 꺼낸다 */
async function callTool(config: CodexConfig, env: Record<string, string>, name: string, args: unknown) {
  const { url, bearer_token_env_var: tokenVar } = (config.mcp_servers as Record<string, { url: string; bearer_token_env_var: string }>).b_studio!;
  const token = env[tokenVar];
  if (!token) throw new Error('MCP 토큰이 환경에 없습니다');
  const client = new Client({ name: 'fake-codex', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args as Record<string, unknown> });
  } finally {
    await client.close().catch(() => {});
  }
}

function usage(input: number, cached = 0, cacheWrite = 0, output = 0): Usage {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_output_tokens: 0 };
}

describe('runCodexAgent', () => {
  it('도구 호출이 MCP 서버를 거쳐 executeTool로 가 작업 공간을 바꾸고, 설정·임시 폴더·이벤트를 남긴다', async () => {
    const { sdk, state } = fakeCodex([
      {
        steps: [
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } },
          { text: '메모 필드를 추가했습니다.' },
        ],
        usage: usage(100),
      },
    ]);
    const sandbox = fakeSandbox(project, [true]);
    const events: AgentEvent[] = [];

    const result = await runCodexAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox,
      sdk,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', summary: '메모 필드를 추가했습니다.', verifyAttempts: 0, turns: 1, threadId: 'thread-1' });
    expect(result.changedFiles).toEqual(['api/src/Order.java']);

    // 설정 덮어쓰기로만 넘긴다: 관문 밖에서 일하는 내장 기능 끄기 + b-studio MCP 서버. 사용자 config.toml은 건드리지 않는다
    const config = state.configs[0]!;
    // #976: Codex 0.157은 앱 커넥터·웹·코드 모드(exec) 등을 기본으로 켠다. 셸만 끄면 64개 도구가 관문 밖에 남았다(실측)
    for (const feature of ['shell_tool', 'apps', 'plugins', 'remote_plugin', 'image_generation', 'goals', 'browser_use', 'computer_use', 'multi_agent']) {
      expect(config.features[feature], feature).toBe(false);
    }
    expect(Object.values(config.features).every((value) => value === false)).toBe(true);
    expect(config.web_search).toBe('disabled');
    // #979: 0.157은 MCP 도구를 코드 모드로만 보인다. 끄면 b-studio 도구가 사라진다
    expect(config.features).not.toHaveProperty('code_mode_host');
    const mcp = config.mcp_servers.b_studio as { url: string; bearer_token_env_var: string; default_tools_approval_mode: string };
    // #979: 승인 없음(never)이면 0.157은 MCP 도구 호출을 거절한다. b-studio 도구가 관문이라 Codex 쪽 승인은 미리 허락한다
    expect(mcp.default_tools_approval_mode).toBe('approve');
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // 토큰은 값이 아니라 환경 변수 이름으로 넘기고, 그 환경에 실제 토큰이 들어 있다
    expect(mcp.bearer_token_env_var).toBe('B_STUDIO_MCP_TOKEN');
    expect(state.envs[0]![mcp.bearer_token_env_var]).toMatch(/^[0-9a-f]{48}$/);

    // Codex 작업 폴더는 project.root가 아니라 실행마다 만드는 빈 임시 폴더이고, 끝나면 지운다
    const options = state.options[0]!;
    expect(options).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', skipGitRepoCheck: true });
    expect(options.workingDirectory).not.toBe(project.root);
    expect(options.workingDirectory!.startsWith(tmpdir())).toBe(true);
    await expect(stat(options.workingDirectory!)).rejects.toThrow();

    // 시스템 프롬프트는 SDK에 자리가 없어 첫 요청 앞에 붙는다. 도구 이름은 Codex가 보는 MCP 이름으로 알려 준다
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0]).toContain('mcp__b_studio__read_file');
    expect(state.prompts[0]).toContain('주문에 메모 필드 추가');

    expect(events.find((event) => event.type === 'session')).toMatchObject({ backend: '로컬 ChatGPT Agent' });
    expect(events.flatMap((event) => (event.type === 'tool_call' ? [event.name] : []))).toEqual(['edit_file']);
    expect(events.flatMap((event) => (event.type === 'tool_result' ? [event.ok] : []))).toEqual([true]);
  });

  it('effort를 넘기면 Codex 설정의 modelReasoningEffort로 전달하고 세션 알림에도 남긴다', async () => {
    const { sdk, state } = fakeCodex([{ steps: [{ text: '완료' }], usage: usage(10) }]);
    const events: AgentEvent[] = [];

    await runCodexAgent({
      request: '요청',
      project,
      sandbox: fakeSandbox(project, [true]),
      sdk,
      effort: 'low',
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(state.options[0]).toMatchObject({ modelReasoningEffort: 'low' });
    expect(events.find((event) => event.type === 'session')).toMatchObject({ backend: '로컬 ChatGPT Agent', effort: 'low' });
  });

  it('effort를 넘기지 않으면 Codex 설정에 modelReasoningEffort를 넣지 않는다(계정 기본값을 그대로 쓴다)', async () => {
    const { sdk, state } = fakeCodex([{ steps: [{ text: '완료' }], usage: usage(10) }]);

    await runCodexAgent({ request: '요청', project, sandbox: fakeSandbox(project, [true]), sdk, fetcher: async () => contract });

    expect(state.options[0]).not.toHaveProperty('modelReasoningEffort');
  });

  it('조율 게시판을 켜면 post_note가 MCP 서버를 거쳐 레인 신원으로 게시된다', async () => {
    const board = new Board({ topology: 'mesh' });
    const { sdk } = fakeCodex([
      {
        steps: [
          { tool: 'post_note', input: { kind: 'contract', body: 'GET /api/orders → [{ id, amount }]', refs: ['api'] } },
          { text: '계약을 남겼습니다.' },
        ],
      },
    ]);
    const result = await runCodexAgent({
      request: '계약 남기기',
      project,
      sandbox: fakeSandbox(project, [true]),
      sdk,
      fetcher: async () => contract,
      onEvent: () => {},
      board: {
        lane: 'api',
        post: (input) => board.post(input, { lane: 'api', by: 'model' }),
        read: (options) => board.read({ lane: 'api' }, options),
      },
    });
    expect(result.status).toBe('done');
    expect(board.snapshot()).toMatchObject([{ kind: 'contract', author: { lane: 'api', by: 'model' } }]);
  });

  it('게이트가 실패하면 같은 스레드에 결과를 넣어 다시 돌리고, 통과하면 끝난다', async () => {
    const { sdk, state } = fakeCodex([
      {
        steps: [
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } },
          { text: '메모를 추가했습니다.' },
        ],
      },
      {
        steps: [
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } },
          { text: '컴파일 에러를 고쳤습니다.' },
        ],
      },
    ]);
    const sandbox = fakeSandbox(project, [false, true]);

    const result = await runCodexAgent({ request: '주문에 메모 필드 추가', project, sandbox, sdk, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 2 });
    expect(sandbox.restarts).toEqual(['api', 'api']);
    expect(state.prompts).toHaveLength(2);
    expect(state.prompts[1]).toContain('[b-studio 검증 게이트]');
    expect(state.prompts[1]).toContain('cannot find symbol');
  });

  it('턴 상한에 닿은 뒤의 재검증이 통과하면 done으로 남기되 하다 만 것으로 표시한다(ADR-131 덧붙임)', async () => {
    // 상한이 1이라 게이트의 실패를 돌려줄 턴이 없다. 재검증이 통과하면(같은 변경이 두 번째에는 통과) 체크포인트로 남는다
    const { sdk, state } = fakeCodex([
      {
        steps: [
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } },
          { text: '메모를 추가했습니다.' },
        ],
      },
    ]);
    const sandbox = fakeSandbox(project, [false, true]);

    const result = await runCodexAgent({ request: '주문에 메모 필드 추가', project, sandbox, sdk, fetcher: async () => contract, maxTurns: 1 });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('최대 턴 수(1)를 넘었습니다');
    expect(result.incomplete).toBe('max_turns');
    expect(state.prompts).toHaveLength(1);
    expect(sandbox.restarts).toEqual(['api', 'api']);
  });

  it('턴 상한에 닿은 뒤의 재검증도 실패하면 실패로 끝나고 표시는 없다', async () => {
    const { sdk } = fakeCodex([
      {
        steps: [
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } },
          { text: '메모를 추가했습니다.' },
        ],
      },
    ]);

    const result = await runCodexAgent({ request: '주문에 메모 필드 추가', project, sandbox: fakeSandbox(project, [false, false]), sdk, fetcher: async () => contract, maxTurns: 1 });

    expect(result).toMatchObject({ status: 'failed', failureReason: 'max_turns' });
    expect(result.incomplete).toBeUndefined();
  });

  it('사용 한도 오류를 한도 문구로 분류하고 게이트를 돌리지 않는다', async () => {
    // 0단계에서 확인한 실제 문구. 계정이 이 오류로 실패한다
    const limit = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits";
    const { sdk } = fakeCodex([{ steps: [], fail: limit }]);
    const sandbox = fakeSandbox(project, []);

    const result = await runCodexAgent({ request: '추가해줘', project, sandbox, sdk, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'failed', summary: `ChatGPT 구독 사용 한도에 걸렸습니다: ${limit}`, turns: 0 });
    expect(sandbox.restarts).toEqual([]);
  });

  it('SDK가 turn.failed 뒤 종료 예외를 던져도 이벤트로 받은 한도 문구를 실패 이유로 쓴다(#983)', async () => {
    const limit = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits";
    const { sdk } = fakeCodex([{ steps: [], fail: limit, exitError: 'Codex Exec exited with code 1: Reading prompt from stdin...\n' }]);
    const sandbox = fakeSandbox(project, []);

    const result = await runCodexAgent({ request: '추가해줘', project, sandbox, sdk, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'failed', summary: `ChatGPT 구독 사용 한도에 걸렸습니다: ${limit}`, turns: 0 });
    expect(sandbox.restarts).toEqual([]);
  });

  it('이벤트로 받은 실패 이유가 없으면 SDK 종료 예외를 그대로 던진다', async () => {
    const { sdk } = fakeCodex([{ steps: [], exitError: 'Codex Exec exited with code 1: boom' }]);

    await expect(runCodexAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract })).rejects.toThrow('boom');
  });

  it('한도 문구가 아니면 원문을 그대로 실패 이유로 쓴다', async () => {
    const { sdk } = fakeCodex([{ steps: [], fail: 'stream disconnected before completion' }]);

    const result = await runCodexAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });

    expect(result.summary).toBe('stream disconnected before completion');
  });

  it('턴마다 스레드 누적 usage와의 차이를 그 턴의 사용량으로 쓰고, input_tokens에 든 캐시 몫은 입력에서 뺀다(#977)', async () => {
    // 실측(Codex 0.157.0): 같은 스레드를 이어 가면 turn.completed.usage는 스레드 누적값이고, input_tokens는 캐시 읽기를 포함한다
    const { sdk } = fakeCodex([
      {
        steps: [
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } },
          { text: '메모를 추가했습니다.' },
        ],
        usage: usage(100, 10, 1, 5),
      },
      {
        steps: [
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } },
          { text: '고쳤습니다.' },
        ],
        // 누적: 둘째 턴 하나는 input 200(캐시 20, 쓰기 2 포함), output 7
        usage: usage(300, 30, 3, 12),
      },
    ]);
    const events: AgentEvent[] = [];

    const result = await runCodexAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, [false, true]),
      sdk,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    // 입력은 캐시를 뺀 값이다: (100-10-1) + (200-20-2). 누적값을 그대로 더하면 300+100이 되어 겹쳐 센다
    expect(result.usage).toEqual({ inputTokens: 267, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 3 });
    // 턴을 끝낼 때마다 그때까지의 누적값을 알린다
    expect(events.flatMap((event) => (event.type === 'tokens' ? [event.usage.inputTokens] : []))).toEqual([89, 267]);
    // turn_usage는 그 턴 하나의 사용량이다. 컨텍스트는 그 턴의 input_tokens(캐시 포함)다
    expect(events.flatMap((event) => (event.type === 'turn_usage' ? [event] : []))).toEqual([
      { type: 'turn_usage', turn: 1, inputTokens: 89, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 1, contextTokens: 100 },
      { type: 'turn_usage', turn: 2, inputTokens: 178, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 2, contextTokens: 200 },
    ]);
    expect(result.metrics?.modelCalls).toBe(2);
    expect(result.metrics?.maxContextTokens).toBe(200);
    // 모델 응답 대기는 SDK 안에서 일어나 이 러너가 관찰하지 못한다. 값이 없는 것이 "재지 않음"이다(0초와 다르다)
    expect(result.metrics).not.toHaveProperty('modelMs');
    for (const ms of [result.metrics!.toolMs, result.metrics!.gateMs]) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('model을 고르면 usageByModel을 그 이름으로, 고르지 않으면 codex:default로 채운다(이슈 #428)', async () => {
    const { sdk: namedModel } = fakeCodex([{ steps: [{ text: '완료' }], usage: usage(10) }]);
    const named = await runCodexAgent({ request: '요청', project, sandbox: fakeSandbox(project, [true]), sdk: namedModel, model: 'gpt-5-codex', fetcher: async () => contract });
    expect(named.metrics?.usageByModel).toEqual({ 'gpt-5-codex': named.usage });

    const { sdk: defaultModel } = fakeCodex([{ steps: [{ text: '완료' }], usage: usage(10) }]);
    const unnamed = await runCodexAgent({ request: '요청', project, sandbox: fakeSandbox(project, [true]), sdk: defaultModel, fetcher: async () => contract });
    expect(unnamed.metrics?.usageByModel).toEqual({ 'codex:default': unnamed.usage });
  });

  it('이어받기는 지원하지 않는다. resume을 주면 오류를 낸다', async () => {
    const { sdk } = fakeCodex([]);

    await expect(
      runCodexAgent({ request: '이어서 해줘', project, sandbox: fakeSandbox(project, []), sdk, resume: 'previous-thread', fetcher: async () => contract }),
    ).rejects.toThrow('이어받기를 지원하지 않습니다');
  });

  it('턴 사이에 실행 중 지시를 다음 턴 입력 뒤에 붙인다', async () => {
    const { sdk, state } = fakeCodex([
      {
        steps: [
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } },
          { text: '메모를 추가했습니다.' },
        ],
      },
      { steps: [{ text: '지시를 반영했습니다.' }] },
    ]);
    const queue = fakeSteering();
    const events: AgentEvent[] = [];

    const result = await runCodexAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, [false, true]),
      sdk,
      steering: queue.steering,
      fetcher: async () => contract,
      onEvent: (event) => {
        events.push(event);
        // 첫 턴이 도는 동안 사용자가 지시를 보낸다 → 다음 턴 입력에 들어간다
        if (event.type === 'tool_result') queue.push('테스트도 추가해줘');
      },
    });

    expect(result).toMatchObject({ status: 'done', verifyAttempts: 1, turns: 2 });
    expect(state.prompts).toHaveLength(2);
    // 게이트 피드백 뒤에 지시가 붙는다
    const second = state.prompts[1]!;
    expect(second).toContain('[b-studio 검증 게이트]');
    expect(second).toContain('[진행 중 지시] 테스트도 추가해줘');
    expect(second.indexOf('[b-studio 검증 게이트]')).toBeLessThan(second.indexOf('[진행 중 지시]'));
    expect(events.filter((event) => event.type === 'steer_applied')).toHaveLength(1);
  });

  it('사용자 ~/.codex 대신 임시 CODEX_HOME을 넘기고, 로그인 파일만 링크한다', async () => {
    let tempHome = '';
    let entries: string[] = [];
    let linked = false;
    let linkTarget = '';
    const { sdk, state } = fakeCodex([{ steps: [{ text: 'ok' }] }], {
      onStart: async (env) => {
        tempHome = env.CODEX_HOME!;
        entries = (await readdir(tempHome)).sort();
        linked = (await lstat(path.join(tempHome, 'auth.json'))).isSymbolicLink();
        linkTarget = await readlink(path.join(tempHome, 'auth.json'));
      },
    });

    const result = await runCodexAgent({ request: '안녕', intent: 'ask', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done' });
    // 넘긴 env의 CODEX_HOME은 임시 폴더이고, Codex 작업 폴더·project.root와 다르다
    expect(tempHome).toMatch(/b-studio-codex-home-/);
    expect(tempHome).not.toBe(project.root);
    expect(tempHome).not.toBe(state.options[0]!.workingDirectory);
    expect(state.envs[0]!.CODEX_HOME).toBe(tempHome);
    // 그 폴더에는 auth.json 링크 하나만 있고, 원본을 가리킨다(내용을 복사하지 않는다)
    expect(entries).toEqual(['auth.json']);
    expect(linked).toBe(true);
    expect(linkTarget).toBe(path.join(originalHome, 'auth.json'));
    // 실행이 끝나면 임시 CODEX_HOME은 지워지고 원본 auth.json은 그대로 남는다
    await expect(stat(tempHome)).rejects.toThrow();
    expect(await readFile(path.join(originalHome, 'auth.json'), 'utf8')).toBe('{"token":"secret"}\n');
  });

  it('계정의 CODEX_HOME(authHome)을 주면 그 폴더의 로그인 파일을 링크한다(#885)', async () => {
    const accountHome = await mkdtemp(path.join(tmpdir(), 'b-studio-codex-account-'));
    await writeFile(path.join(accountHome, 'auth.json'), '{"token":"second"}\n');
    let linkTarget = '';
    const { sdk } = fakeCodex([{ steps: [{ text: 'ok' }] }], {
      onStart: async (env) => {
        linkTarget = await readlink(path.join(env.CODEX_HOME!, 'auth.json'));
      },
    });
    try {
      await runCodexAgent({ request: '안녕', intent: 'ask', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract, authHome: accountHome });
      expect(linkTarget).toBe(path.join(accountHome, 'auth.json'));
    } finally {
      await rm(accountHome, { recursive: true, force: true });
    }
  });

  it('원본 로그인 파일이 없으면 링크를 만들지 않고 예외 없이 진행한다', async () => {
    process.env.CODEX_HOME = path.join(originalHome, '없는폴더');
    let tempHome = '';
    let entries: string[] = [];
    const { sdk } = fakeCodex([{ steps: [{ text: 'ok' }] }], {
      onStart: async (env) => {
        tempHome = env.CODEX_HOME!;
        entries = await readdir(tempHome);
      },
    });

    const result = await runCodexAgent({ request: '안녕', intent: 'ask', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done' });
    expect(entries).toEqual([]);
    await expect(stat(tempHome)).rejects.toThrow();
  });

  it('ask_user가 질문을 남기면 그 턴이 끝날 때 멈추고 awaiting_input으로 끝낸다', async () => {
    const { sdk } = fakeCodex([
      { steps: [{ tool: 'ask_user', input: { question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: false } }], usage: usage(50) },
    ]);
    const sandbox = fakeSandbox(project, []);
    const events: AgentEvent[] = [];

    const result = await runCodexAgent({
      request: '주문 화면 만들어줘',
      project,
      sandbox,
      sdk,
      interactive: true,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'awaiting_input', summary: '어떤 형태로 만들까요?', turns: 1 });
    expect(result.question).toEqual({ question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: false });
    expect(events.find((event) => event.type === 'question')).toBeTruthy();
    // 변경 파일이 없으면 게이트를 돌리지 않는다
    expect(events.some((event) => event.type === 'verify_start')).toBe(false);
    expect(sandbox.restarts).toEqual([]);
  });

  it('승격 옵션을 받으면 지원하지 않는다고 경고를 한 번 낸다', async () => {
    const { sdk } = fakeCodex([{ steps: [{ text: 'ok' }] }]);
    const events: AgentEvent[] = [];

    const result = await runCodexAgent({
      request: '안녕',
      intent: 'ask',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      escalation: { to: 'sonnet' },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done' });
    const warnings = events.filter((event): event is Extract<AgentEvent, { type: 'warning' }> => event.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('승격을 지원하지 않습니다');
  });
});

describe('켜진 Codex 기능을 닫힌 목록으로 확인한다(#980)', () => {
  const run = (features: string | Error) => {
    const { sdk, state } = fakeCodex([{ steps: [{ text: '끝' }] }], { features });
    const started = () => state.configs.length;
    return { state, started, result: runCodexAgent({ request: '메모 추가', project, sandbox: fakeSandbox(project, [true]), sdk, fetcher: async () => contract }) };
  };

  it('묶인 0.157.0의 실제 출력은 거부하지 않는다', () => {
    expect(checkCodexFeatures(FEATURES_0157)).toEqual({ ok: true });
  });

  it('안전 목록에도 끄는 목록에도 없는 기능이 켜져 있으면 모델을 부르기 전에 까닭과 함께 실패한다', async () => {
    const { result, started } = run(`${FEATURES_0157}new_magic_tool                           stable             true\n`);
    const done = await result;
    expect(done.status).toBe('failed');
    expect(done.summary).toContain('new_magic_tool');
    expect(started()).toBe(0);
  });

  it('끄라고 넘긴 기능이 켜진 채로 보이면(덮어쓰기가 먹지 않음) 실패한다', async () => {
    const { result, started } = run(FEATURES_0157.replace(/^(apps\s+\S+\s+)false$/m, '$1true'));
    const done = await result;
    expect(done.status).toBe('failed');
    expect(done.summary).toContain('apps');
    expect(started()).toBe(0);
  });

  it('목록을 읽지 못하거나 한 줄도 해석하지 못하면 실패한다(모르면 막는다)', async () => {
    for (const features of [new Error('codex를 찾지 못했습니다'), '', 'Error: unknown command\n']) {
      const { result, started } = run(features);
      const done = await result;
      expect(done.status, String(features)).toBe('failed');
      expect(started()).toBe(0);
    }
  });

  it('기능 목록은 스레드와 같은 끄기 설정과 임시 CODEX_HOME으로 읽는다', async () => {
    const { result, state } = run(FEATURES_0157);
    await result;
    expect(state.featureConfigs[0]).toEqual(codexFeatureConfig());
    expect(state.configs[0]!.features).toEqual(codexFeatureConfig().features);
    expect(state.featureEnvs[0]!.CODEX_HOME).toBe(state.envs[0]!.CODEX_HOME);
  });

  it('묶인 바이너리로 지금 설정을 읽으면 거부하지 않는다(모델 호출 없음)', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'codex-features-test-'));
    try {
      const listed = await DEFAULT_SDK.listFeatures({ config: codexFeatureConfig(), env: { ...process.env, CODEX_HOME: home } as Record<string, string> });
      expect(checkCodexFeatures(listed)).toEqual({ ok: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
