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

type Step = ({ tool: string; input: Record<string, unknown> } | { text: string }) & {
  /** 이 assistant 메시지의 usage. 주면 실행 지표(maxContextTokens) 계산에 쓰인다 */
  usage?: Record<string, number>;
  /** 같은 id를 여러 메시지에 쓰면 지표상 한 번의 호출로 센다 */
  id?: string;
};

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
            const id = step.id ?? `msg_${++ids}`;
            const usage = step.usage ? { usage: step.usage } : {};
            if ('tool' in step) {
              const content = [{ type: 'tool_use', id: `toolu_${ids}`, name: `mcp__b-studio__${step.tool}`, input: step.input }];
              yield { type: 'assistant', message: { id, content, ...usage }, parent_tool_use_id: null, session_id: sessionId } as unknown as SDKMessage;
              await tools.find((definition) => definition.name === step.tool)!.handler(step.input, {});
            } else {
              lastText = step.text;
              const content = [{ type: 'text', text: step.text }];
              yield { type: 'assistant', message: { id, content, ...usage }, parent_tool_use_id: null, session_id: sessionId } as unknown as SDKMessage;
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
  it('질문 모드는 요청 앞에 읽기 전용 안내를 붙이고, 쓰기 도구를 거부하며, 게이트 없이 끝난다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order {}' } }, { text: '계획입니다.' }]],
    });
    const sandbox = fakeSandbox(project, []);
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '어떻게 바꿔?',
      intent: 'ask',
      project,
      sandbox,
      sdk,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', summary: '계획입니다.', changedFiles: [], verifyAttempts: 0 });
    expect(state.prompts[0]).toContain('[b-studio question mode]');
    expect(state.prompts[0]).toContain('mcp__b-studio__write_file');
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ ok: false });
    expect(events.some((event) => event.type === 'verify_start')).toBe(false);
    expect(sandbox.restarts).toEqual([]);
  });

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
    // 턴을 끝낼 때마다 그때까지의 누적값을 알린다
    expect(events.flatMap((e) => (e.type === 'tokens' ? [e.usage.inputTokens] : []))).toEqual([20, 40]);

    expect(state.prompts).toHaveLength(2);
    expect(state.prompts[1]).toContain('[b-studio 검증 게이트]');
    expect(state.prompts[1]).toContain('cannot find symbol');
    expect(events[0]).toEqual({ type: 'session', backend: '로컬 Claude Agent (CLI 9.9.9)', model: 'test-model', auth: 'Claude Max 구독' });
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && e.ok)).toEqual([true, true]);
  });

  it('실행 지표로 호출 수·최대 입력 크기·단계별 시간을 남기고 modelMs는 0으로 둔다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [
        [
          { tool: 'read_file', input: { path: 'api/src/Order.java' }, id: 'm1', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 5 } },
          { text: '읽었습니다.', id: 'm1', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 7 } },
          { text: '주문 API입니다.', id: 'm2', usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
        ],
      ],
    });

    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });

    expect(result.status).toBe('done');
    // 서로 다른 assistant 메시지 id가 2개다 (id 2개, 메시지 3개)
    expect(result.metrics?.modelCalls).toBe(2);
    // 호출 한 번의 입력 크기 최댓값: 200 + 2,000 + 7 = 2,207
    expect(result.metrics?.maxContextTokens).toBe(2_207);
    // 모델 응답 대기는 SDK 안에서 일어나 이 러너가 관찰하지 못한다. 0은 "재지 않음"이다
    expect(result.metrics?.modelMs).toBe(0);
    for (const ms of [result.metrics!.toolMs, result.metrics!.gateMs]) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
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

  it('취소하면 Claude Code에 중단을 넘기고 결과 대신 취소 이유를 던진다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }, { tool: 'read_file', input: { path: 'api/src/New.java' } }, { text: '추가했습니다.' }]],
    });
    const controller = new AbortController();
    const events: AgentEvent[] = [];

    await expect(
      runClaudeCodeAgent({
        request: '추가해줘',
        project,
        sandbox: fakeSandbox(project, [true]),
        sdk,
        signal: controller.signal,
        fetcher: async () => contract,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'tool_result') controller.abort(new DOMException('요청을 취소했습니다', 'AbortError'));
        },
      }),
    ).rejects.toThrow('요청을 취소했습니다');

    expect(state.options?.abortController?.signal.aborted).toBe(true);
    // 취소 뒤에 온 도구 호출은 실행하지 않는다
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.type === 'tool_call' && e.name)).toEqual(['write_file']);
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
