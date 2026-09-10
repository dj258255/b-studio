import type { AccountInfo, McpServerConfig, Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  describeAccount,
  preflightClaudeCode,
  runClaudeCodeAgent,
  zodShape,
  type ClaudeCodeQuery,
  type ClaudeCodeSdk,
} from './claude-code-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT as contract } from './test-helpers';
import { buildTools } from './tools';

let project: LoadedProject;

beforeEach(async () => {
  project = await createOrdersProject('claude-code-test-');
});

type Step = { tool: string; input: Record<string, unknown> } | { text: string };

interface FakeOptions {
  /** 사용자 메시지마다 모델이 할 일 */
  turns?: Step[][];
  result?: Record<string, unknown>;
  account?: AccountInfo;
}

/**
 * Claude Code 프로세스를 흉내 내는 가짜 SDK.
 * 사용자 메시지를 받을 때마다 준비된 단계를 실행하고, 도구 단계는 러너가 등록한 MCP 도구 핸들러를 실제로 부른다.
 */
function fakeClaudeCode({ turns = [], result = {}, account = {} }: FakeOptions = {}) {
  const state = { prompts: [] as string[], options: undefined as Options | undefined, closed: false };
  let tools: Array<SdkMcpToolDefinition<any>> = [];

  const sdk: ClaudeCodeSdk = {
    createSdkMcpServer(config) {
      tools = config.tools ?? [];
      return { type: 'sdk', name: config.name, instance: {} } as unknown as McpServerConfig;
    },
    query({ prompt, options }) {
      state.options = options;
      const sessionId = options.resume ? 'forked-session' : 'new-session';

      async function* run(): AsyncGenerator<SDKMessage> {
        yield { type: 'system', subtype: 'init', claude_code_version: '9.9.9', model: 'test-model', session_id: sessionId } as unknown as SDKMessage;
        let ids = 0;
        for await (const user of prompt) {
          state.prompts.push(String(user.message.content));
          const steps = turns.shift();
          if (!steps) throw new Error('스크립트에 남은 턴이 없습니다');
          let lastText = '';
          for (const step of steps) {
            const id = `msg_${++ids}`;
            if ('tool' in step) {
              const content = [{ type: 'tool_use', id: `toolu_${ids}`, name: `mcp__b-studio__${step.tool}`, input: step.input }];
              yield { type: 'assistant', message: { id, content }, parent_tool_use_id: null, session_id: sessionId } as unknown as SDKMessage;
              await tools.find((definition) => definition.name === step.tool)!.handler(step.input, {});
            } else {
              lastText = step.text;
              const content = [{ type: 'text', text: step.text }];
              yield { type: 'assistant', message: { id, content }, parent_tool_use_id: null, session_id: sessionId } as unknown as SDKMessage;
            }
          }
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: lastText,
            stop_reason: 'end_turn',
            errors: [],
            modelUsage: { 'test-model': { inputTokens: 10 * ids, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } },
            session_id: sessionId,
            ...result,
          } as unknown as SDKMessage;
        }
      }

      const query: ClaudeCodeQuery = Object.assign(run(), {
        accountInfo: async () => account,
        interrupt: async () => {},
        close: () => {
          state.closed = true;
        },
      });
      return query;
    },
  };
  return { sdk, state };
}

describe('runClaudeCodeAgent', () => {
  it('기본 도구와 사용자 설정을 끄고 b-studio 도구만 허용한다. 게이트가 실패하면 같은 대화에 결과를 넣는다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }, { text: '메모 필드를 추가했습니다.' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }, { text: '컴파일 에러를 고쳤습니다.' }],
      ],
    });
    const sandbox = fakeSandbox(project, [false, true]);
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox,
      sdk,
      account: { subscriptionType: 'Claude Max' },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(state.options).toMatchObject({ tools: [], settingSources: [], permissionMode: 'dontAsk', strictMcpConfig: true, cwd: project.root });
    expect(state.options?.allowedTools).toContain('mcp__b-studio__edit_file');
    expect(state.options?.allowedTools?.every((name) => name.startsWith('mcp__b-studio__'))).toBe(true);
    expect(state.options?.resume).toBeUndefined();
    expect(state.options?.systemPrompt).toEqual(expect.stringContaining('mcp__b-studio__read_file'));

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 4, sessionId: 'new-session' });
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
    expect(sandbox.restarts).toEqual(['api', 'api']);
    // modelUsage는 누적값이라 마지막 결과로 바꾼다
    expect(result.usage.inputTokens).toBe(40);

    expect(state.prompts).toHaveLength(2);
    expect(state.prompts[1]).toContain('[b-studio 검증 게이트]');
    expect(state.prompts[1]).toContain('cannot find symbol');
    expect(events[0]).toEqual({ type: 'session', backend: '로컬 Claude Agent (CLI 9.9.9)', model: 'test-model', auth: 'Claude Max 구독' });
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && e.ok)).toEqual([true, true]);
  });

  it('이전 세션을 넘기면 갈라서 이어받고, 새 세션 ID를 돌려준다', async () => {
    const { sdk, state } = fakeClaudeCode({ turns: [[{ text: '앞에서 말한 주문 API입니다.' }]] });

    const result = await runClaudeCodeAgent({
      request: '거기에 뭘 더할 수 있어?',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      resume: 'previous-session',
      fetcher: async () => contract,
    });

    expect(state.options).toMatchObject({ resume: 'previous-session', forkSession: true });
    expect(result).toMatchObject({ status: 'done', sessionId: 'forked-session', turns: 1 });
  });

  it('모델 호출이 오류로 끝나면 게이트를 돌리지 않고 실패한다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }]],
      result: { is_error: true, result: 'rate limit reached' },
    });
    const sandbox = fakeSandbox(project, []);

    const result = await runClaudeCodeAgent({ request: '추가해줘', project, sandbox, sdk, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'failed', summary: '모델 호출이 실패했습니다: rate limit reached' });
    expect(sandbox.restarts).toEqual([]);
  });

  it('Claude Code가 예외를 던지면 프로세스를 닫고 그대로 던진다', async () => {
    const { sdk, state } = fakeClaudeCode({ turns: [] });

    await expect(
      runClaudeCodeAgent({ request: '읽어줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract }),
    ).rejects.toThrow('스크립트에 남은 턴이 없습니다');
    expect(state.closed).toBe(true);
  });
});

describe('preflightClaudeCode', () => {
  it('로그인한 계정이면 이메일 없이 인증 정보만 돌려준다', async () => {
    const { sdk, state } = fakeClaudeCode({
      account: { email: 'someone@example.com', subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
    });

    const preflight = await preflightClaudeCode({ sdk });

    expect(preflight).toEqual({ ok: true, account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty', apiKeySource: undefined } });
    expect(state.options).toMatchObject({ tools: [], settingSources: [], persistSession: false });
    expect(state.closed).toBe(true);
    expect(describeAccount({ apiKeySource: 'ANTHROPIC_API_KEY' })).toBe('API 키 (ANTHROPIC_API_KEY)');
  });

  it('인증 정보가 하나도 없으면 로그인을 안내한다', async () => {
    const { sdk } = fakeClaudeCode({ account: { apiProvider: 'firstParty' } });
    const preflight = await preflightClaudeCode({ sdk });
    expect(preflight).toMatchObject({ ok: false, reason: expect.stringContaining('/login') });
  });
});

describe('zodShape', () => {
  it('buildTools의 입력 스키마를 그대로 검사한다', () => {
    const tools = Object.fromEntries(buildTools(project).map((tool) => [tool.name, z.object(zodShape(tool.input_schema))]));

    expect(tools.run_in_service!.safeParse({ service: 'api', command: ['./gradlew', 'test'] }).success).toBe(true);
    expect(tools.run_in_service!.safeParse({ service: 'db', command: ['psql'] }).success).toBe(false);
    expect(tools.service_logs!.safeParse({ service: 'api', lines: 1.5 }).success).toBe(false);
    expect(tools.http_request!.safeParse({ service: 'api', method: 'TRACE', path: '/', body: '' }).success).toBe(false);
  });
});
