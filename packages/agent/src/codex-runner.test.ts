import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import type { ThreadEvent, ThreadOptions, Usage } from '@openai/codex-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCodexAgent, type CodexConfig, type CodexSdk, type CodexThread } from './codex-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT as contract } from './test-helpers';

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
}

/** 첫 turn.runStreamed가 시작될 때(임시 CODEX_HOME이 살아 있는 동안) 실행할 확인 훅 */
interface FakeHooks {
  onStart?: (env: Record<string, string>) => Promise<void>;
}

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
  };
  let id: string | null = null;

  const sdk: CodexSdk = {
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
            if (turn.fail !== undefined) {
              yield { type: 'turn.failed', error: { message: turn.fail } };
              return;
            }
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

    // 설정 덮어쓰기로만 넘긴다: 셸 도구 끄기 + b-studio MCP 서버. 사용자 config.toml은 건드리지 않는다
    const config = state.configs[0]!;
    expect(config.features).toEqual({ shell_tool: false });
    const mcp = config.mcp_servers.b_studio as { url: string; bearer_token_env_var: string };
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

  it('사용 한도 오류를 한도 문구로 분류하고 게이트를 돌리지 않는다', async () => {
    // 0단계에서 확인한 실제 문구. 계정이 이 오류로 실패한다
    const limit = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits";
    const { sdk } = fakeCodex([{ steps: [], fail: limit }]);
    const sandbox = fakeSandbox(project, []);

    const result = await runCodexAgent({ request: '추가해줘', project, sandbox, sdk, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'failed', summary: `ChatGPT 구독 사용 한도에 걸렸습니다: ${limit}`, turns: 0 });
    expect(sandbox.restarts).toEqual([]);
  });

  it('한도 문구가 아니면 원문을 그대로 실패 이유로 쓴다', async () => {
    const { sdk } = fakeCodex([{ steps: [], fail: 'stream disconnected before completion' }]);

    const result = await runCodexAgent({ request: '추가해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });

    expect(result.summary).toBe('stream disconnected before completion');
  });

  it('턴별 usage를 더하고, modelCalls는 완료된 턴 수, maxContextTokens는 턴별 입력(+캐시) 최댓값으로 남긴다', async () => {
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
        usage: usage(200, 20, 2, 7),
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

    // 턴별 값을 더한다(누적이면 200+20+2가 마지막 값이 된다)
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 3 });
    // 턴을 끝낼 때마다 그때까지의 누적값을 알린다
    expect(events.flatMap((event) => (event.type === 'tokens' ? [event.usage.inputTokens] : []))).toEqual([100, 300]);
    expect(result.metrics?.modelCalls).toBe(2);
    expect(result.metrics?.maxContextTokens).toBe(222);
    // 모델 응답 대기는 SDK 안에서 일어나 이 러너가 관찰하지 못한다. 0은 "재지 않음"이다
    expect(result.metrics?.modelMs).toBe(0);
    for (const ms of [result.metrics!.toolMs, result.metrics!.gateMs]) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('이어받기는 지원하지 않는다. resume을 주면 오류를 낸다', async () => {
    const { sdk } = fakeCodex([]);

    await expect(
      runCodexAgent({ request: '이어서 해줘', project, sandbox: fakeSandbox(project, []), sdk, resume: 'previous-thread', fetcher: async () => contract }),
    ).rejects.toThrow('이어받기를 지원하지 않습니다');
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
});
