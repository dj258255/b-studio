import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccountInfo, McpServerConfig, ModelInfo, Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  describeAccount,
  fetchClaudeCodeModels,
  preflightClaudeCode,
  runClaudeCodeAgent,
  zodShape,
  type ClaudeCodeQuery,
  type ClaudeCodeSdk,
} from './claude-code-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, fakeSteering, ORDERS_CONTRACT as contract } from './test-helpers';
import { buildTools } from './tools';

let project: LoadedProject;

beforeEach(async () => {
  project = await createOrdersProject('claude-code-test-');
});

/** 러너가 넘긴 지시문의 글. 러너는 지시문을 기록하지 않게 객체 꼴로 넘긴다(트러블슈팅 130) */
function promptOf(options: Options | undefined): string {
  const prompt = options?.systemPrompt;
  if (typeof prompt === 'object' && prompt !== null && !Array.isArray(prompt) && prompt.type === 'custom') return Array.isArray(prompt.prompt) ? prompt.prompt.join('') : prompt.prompt;
  return typeof prompt === 'string' ? prompt : '';
}

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
  /** 사용자 메시지(게이트 재시도 포함)마다 돌려줄 modelUsage. 없으면 기본 계산을 쓴다 */
  modelUsages?: Array<Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>>;
  /** supportedModels()가 돌려줄 목록(fetchClaudeCodeModels 테스트용) */
  models?: ModelInfo[];
  /** result마다 실어 보낼 duration_api_ms(순서대로). 비면 그 필드 없이 보낸다 */
  apiDurations?: number[];
  /** 결과를 준 뒤에 이 문구로 예외를 던진다. 실제 SDK는 오류 결과(턴 상한 등) 뒤에 같은 사유로 예외도 던진다 */
  throwAfterResult?: string;
}

/**
 * Claude Code 프로세스를 흉내 내는 가짜 SDK.
 * 사용자 메시지를 받을 때마다 준비된 단계를 실행하고, 도구 단계는 러너가 등록한 MCP 도구 핸들러를 실제로 부른다.
 */
function fakeClaudeCode({ turns = [], result = {}, account = {}, modelUsages = [], models = [], apiDurations = [], throwAfterResult }: FakeOptions = {}) {
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
          const modelUsage = modelUsages.shift() ?? { 'test-model': { inputTokens: 10 * ids, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: lastText,
            stop_reason: 'end_turn',
            errors: [],
            modelUsage,
            session_id: sessionId,
            ...(apiDurations.length > 0 ? { duration_api_ms: apiDurations.shift() } : {}),
            ...result,
          } as unknown as SDKMessage;
          if (throwAfterResult) throw new Error(throwAfterResult);
        }
      }

      const query: ClaudeCodeQuery = Object.assign(run(), {
        accountInfo: async () => account,
        supportedModels: async () => models,
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

  it('조사 모드(질문+research)는 b-studio 도구에 더해 WebSearch·WebFetch를 열고, 요청 앞에 조사 안내를 붙인다', async () => {
    const { sdk, state } = fakeClaudeCode({ turns: [[{ text: '찾은 내용입니다.' }]] });
    const sandbox = fakeSandbox(project, []);

    const result = await runClaudeCodeAgent({
      request: '최신 결제 PG 수수료 비교',
      intent: 'ask',
      research: true,
      project,
      sandbox,
      sdk,
      fetcher: async () => contract,
    });

    expect(result).toMatchObject({ status: 'done' });
    expect(state.prompts[0]).toContain('[조사 모드]');
    expect(state.prompts[0]).toContain('WebSearch/WebFetch');
    expect(state.options?.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(state.options?.allowedTools).toContain('WebSearch');
    expect(state.options?.allowedTools).toContain('WebFetch');
    expect(state.options?.allowedTools?.some((name) => name.startsWith('mcp__b-studio__'))).toBe(true);
  });

  it('질문 모드라도 조사(research)를 켜지 않으면 WebSearch·WebFetch를 열지 않는다(지금과 같다)', async () => {
    const { sdk, state } = fakeClaudeCode({ turns: [[{ text: '답입니다.' }]] });
    const sandbox = fakeSandbox(project, []);

    await runClaudeCodeAgent({ request: '이 함수는 뭐해?', intent: 'ask', project, sandbox, sdk, fetcher: async () => contract });

    expect(state.options?.tools).toEqual([]);
    expect(state.options?.allowedTools).not.toContain('WebSearch');
    expect(state.prompts[0]).not.toContain('[조사 모드]');
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
    expect(promptOf(state.options)).toEqual(expect.stringContaining('mcp__b-studio__read_file'));

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 4, sessionId: 'new-session' });
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
    expect(sandbox.restarts).toEqual(['api', 'api']);
    // modelUsage는 누적값이라 마지막 결과로 바꾼다
    expect(result.usage.inputTokens).toBe(40);
    // 턴을 끝낼 때마다 그때까지의 누적값을 알린다
    expect(events.flatMap((e) => (e.type === 'tokens' ? [e.usage.inputTokens] : []))).toEqual([20, 40]);
    // 이 스크립트는 assistant usage를 주지 않으므로 턴 사용량 이벤트가 없다(기록된 값만 남긴다)
    expect(events.filter((e) => e.type === 'turn_usage')).toEqual([]);

    expect(state.prompts).toHaveLength(2);
    expect(state.prompts[1]).toContain('[b-studio 검증 게이트]');
    expect(state.prompts[1]).toContain('cannot find symbol');
    // effort를 넘기지 않으면 기본값 'high'가 그대로 query 옵션과 세션 알림에 실린다
    expect(state.options?.effort).toBe('high');
    expect(events[0]).toEqual({ type: 'session', backend: '로컬 Claude Agent (CLI 9.9.9)', model: 'test-model', auth: 'Claude Max 구독', effort: 'high' });
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && e.ok)).toEqual([true, true]);
  });

  it('실행 지표로 호출 수·최대 입력 크기·단계별 시간을 남기고, SDK가 API 시간을 알려 주지 않으면 modelMs를 비워 둔다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [
        [
          { tool: 'read_file', input: { path: 'api/src/Order.java' }, id: 'm1', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 5 } },
          { text: '읽었습니다.', id: 'm1', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 7 } },
          { text: '주문 API입니다.', id: 'm2', usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
        ],
      ],
    });

    const events: AgentEvent[] = [];
    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract, onEvent: (event) => events.push(event) });

    expect(result.status).toBe('done');
    // 서로 다른 assistant 메시지 id가 2개다 (id 2개, 메시지 3개)
    expect(result.metrics?.modelCalls).toBe(2);
    // 호출 한 번의 입력 크기 최댓값: 200 + 2,000 + 7 = 2,207
    expect(result.metrics?.maxContextTokens).toBe(2_207);
    // 같은 메시지 id가 여러 번 와도 그 턴의 사용량은 처음 값으로 한 번만 남긴다(컨텍스트 = input + cacheRead + cacheWrite)
    expect(events.flatMap((e) => (e.type === 'turn_usage' ? [e] : []))).toEqual([
      { type: 'turn_usage', turn: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 1_000, cacheWriteTokens: 5, contextTokens: 1_105 },
      { type: 'turn_usage', turn: 2, inputTokens: 50, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, contextTokens: 150 },
    ]);
    // 모델 응답 대기는 SDK 안에서 일어나 이 러너가 직접 재지 못한다. 값이 없는 것이 "재지 않음"이고 0초와 다르다
    expect(result.metrics).not.toHaveProperty('modelMs');
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

  it('지시문을 대화에 기록하지 않게 넘긴다 — 이어받은 대화도 지금의 지시문으로 돈다 (트러블슈팅 130)', async () => {
    const { sdk, state } = fakeClaudeCode({ turns: [[{ text: '네.' }]] });

    await runClaudeCodeAgent({ request: '이어서', project, sandbox: fakeSandbox(project, []), sdk, resume: 'previous-session', fetcher: async () => contract });

    // 글만 넘기면 SDK가 처음 만들 때의 지시문을 기록해 두고, 이어받을 때 새로 넘긴 지시문을 무시한다
    expect(state.options?.systemPrompt).toMatchObject({ type: 'custom', snapshot: false });
    expect(promptOf(state.options)).toContain('[b-studio workflow]');
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

  it('인증 오류 같은 영구 오류는 기다리지 않고 바로 실패한다(네트워크 사유를 달지 않는다)', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }]],
      result: { is_error: true, result: 'authentication_error: invalid x-api-key' },
    });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '추가해줘',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
      // 재시도 판정이 잘못 걸리면 이 대기 함수가 불려 테스트가 실패한다
      networkRetry: { wait: async () => { throw new Error('영구 오류인데 대기 함수가 불렸습니다'); } },
    });

    expect(result).toMatchObject({ status: 'failed', summary: '모델 호출이 실패했습니다: authentication_error: invalid x-api-key' });
    expect(result.failureReason).toBeUndefined();
    expect(events.some((event) => event.type === 'warning')).toBe(false);
  });

  it('SDK가 result에 실어 주는 API 호출 시간 합을 modelMs로 남긴다', async () => {
    const { sdk } = fakeClaudeCode({ turns: [[{ text: '주문 API입니다.' }]], apiDurations: [3_333.4] });
    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });
    expect(result.status).toBe('done');
    expect(result.metrics?.modelMs).toBe(3_333);
  });

  it('한 query에서 result가 여러 번 오면 modelMs를 더하지 않고 마지막 누적값을 쓴다', async () => {
    // 게이트가 한 번 실패해 같은 query에서 턴이 두 번 끝난다. duration_api_ms는 그 query의 누적값이다(실측 3,333 → 5,997)
    const { sdk } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }, { text: '1' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }, { text: '2' }],
      ],
      apiDurations: [3_333, 5_997],
    });
    const result = await runClaudeCodeAgent({ request: '주문에 메모 필드 추가', project, sandbox: fakeSandbox(project, [false, true]), sdk, fetcher: async () => contract });
    expect(result.status).toBe('done');
    expect(result.metrics?.modelMs).toBe(5_997);
  });

  it('숫자가 아닌 duration_api_ms는 재지 않은 것으로 본다', async () => {
    const { sdk } = fakeClaudeCode({ turns: [[{ text: '주문 API입니다.' }]], result: { duration_api_ms: 'n/a' } as never });
    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });
    expect(result.metrics).not.toHaveProperty('modelMs');
  });

  it('첫 시도가 ENOTFOUND로 끝나면 기다렸다가 같은 세션을 resume으로 이어받아 이어서 성공한다', async () => {
    const prompts: string[] = [];
    const resumes: Array<string | undefined> = [];
    const waits: number[] = [];
    let queryCalls = 0;

    const sdk: ClaudeCodeSdk = {
      createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }) as unknown as McpServerConfig,
      query({ prompt, options }) {
        queryCalls += 1;
        const call = queryCalls;
        resumes.push(options.resume);
        const sessionId = 'session-1';

        async function* run(): AsyncGenerator<SDKMessage> {
          yield { type: 'system', subtype: 'init', claude_code_version: '9.9.9', model: 'test-model', session_id: sessionId } as unknown as SDKMessage;
          for await (const user of prompt) {
            prompts.push(String(user.message.content));
            if (call === 1) {
              // 네트워크가 끊겨 모델 호출이 ENOTFOUND로 끝난다. CLI는 더 읽지 않고 바로 끝난다
              yield {
                type: 'result',
                subtype: 'success',
                is_error: true,
                result: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
                stop_reason: 'end_turn',
                errors: [],
                modelUsage: {},
                duration_api_ms: 1_000,
                session_id: sessionId,
              } as unknown as SDKMessage;
              return;
            }
            const content = [{ type: 'text', text: '이어서 완료했습니다.' }];
            yield { type: 'assistant', message: { id: 'm1', content }, parent_tool_use_id: null, session_id: sessionId } as unknown as SDKMessage;
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: '이어서 완료했습니다.',
              stop_reason: 'end_turn',
              errors: [],
              modelUsage: { 'test-model': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } },
              duration_api_ms: 2_500,
              session_id: sessionId,
            } as unknown as SDKMessage;
          }
        }

        return Object.assign(run(), {
          accountInfo: async () => ({}),
          supportedModels: async () => [],
          interrupt: async () => {},
          close: () => {},
        }) as unknown as ClaudeCodeQuery;
      },
    };

    const events: AgentEvent[] = [];
    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
      // 실제 sleep 대신 기다린 시간만 기록한다(시간을 흐르게 하지 않는다)
      networkRetry: { wait: async (ms) => { waits.push(ms); }, maxAttempts: 3, maxWaitMs: 60_000, baseDelayMs: 1_000 },
    });

    expect(result).toMatchObject({ status: 'done', summary: '이어서 완료했습니다.' });
    // query를 다시 열면 누적값이 0부터 다시 시작한다. 끝난 query의 값(1,000)에 새 query의 값(2,500)을 더한다
    expect(result.metrics?.modelMs).toBe(3_500);
    expect(queryCalls).toBe(2);
    expect(resumes).toEqual([undefined, 'session-1']);
    expect(waits).toEqual([1_000]);
    // 이미 한 작업을 다시 하지 않도록 원래 요청 대신 짧은 이어서 진행 안내만 보낸다
    expect(prompts[1]).toBe('네트워크가 끊겼다가 돌아왔습니다. 하던 작업을 처음부터 다시 하지 말고 그대로 이어서 진행하세요.');
    expect(events.some((event) => event.type === 'warning' && event.message.includes('네트워크'))).toBe(true);
  });

  it('네트워크 오류가 상한(재시도 횟수)을 넘기면 네트워크 사유로 실패한다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [[], [], []],
      result: { is_error: true, result: 'ENOTFOUND api.anthropic.com' },
    });
    const waits: number[] = [];
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '추가해줘',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
      networkRetry: { wait: async (ms) => { waits.push(ms); }, maxAttempts: 2, maxWaitMs: 60_000, baseDelayMs: 1_000 },
    });

    expect(result).toMatchObject({ status: 'failed', failureReason: 'network' });
    expect(result.summary).toContain('네트워크');
    // 재시도 상한(2번)만큼만 기다리고, 더는 시도하지 않는다
    expect(waits).toEqual([1_000, 2_000]);
    expect(events.filter((event) => event.type === 'warning')).toHaveLength(2);
  });

  it('네트워크 재시도 대기 중 취소 신호가 오면 더 기다리지 않고 취소를 그대로 던진다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [[]],
      result: { is_error: true, result: 'ENOTFOUND registry.npmjs.org' },
    });
    const controller = new AbortController();

    await expect(
      runClaudeCodeAgent({
        request: '추가해줘',
        project,
        sandbox: fakeSandbox(project, []),
        sdk,
        signal: controller.signal,
        fetcher: async () => contract,
        networkRetry: {
          maxAttempts: 3,
          // 기다리는 동안 취소 신호가 온 상황을 흉내 낸다(실제 대기를 쓰지 않는다)
          wait: async () => {
            controller.abort(new DOMException('요청을 취소했습니다', 'AbortError'));
          },
        },
      }),
    ).rejects.toThrow('요청을 취소했습니다');
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

  it('ask_user가 질문을 남기면 쿼리를 중단하고 awaiting_input으로 끝내 세션 id를 남긴다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [[{ tool: 'ask_user', input: { question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: true } }]],
    });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문 화면 만들어줘',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      interactive: true,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'awaiting_input', summary: '어떤 형태로 만들까요?', sessionId: 'new-session' });
    expect(result.question).toEqual({ question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: true });
    expect(events.find((event) => event.type === 'question')).toMatchObject({ allowOther: true });
    // 되묻기 도구는 interactive일 때만 허용 목록에 들어간다
    expect(state.options?.allowedTools).toContain('mcp__b-studio__ask_user');
    // 변경 파일이 없으면 게이트를 돌리지 않는다
    expect(events.some((event) => event.type === 'verify_start')).toBe(false);
  });

  it('interactive가 아니면 허용 목록에 ask_user가 없다(레인·벤치·CLI)', async () => {
    const { sdk, state } = fakeClaudeCode({ turns: [[{ text: '주문 API입니다.' }]] });
    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });

    expect(result.status).toBe('done');
    expect(state.options?.allowedTools).not.toContain('mcp__b-studio__ask_user');
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

describe('fetchClaudeCodeModels', () => {
  const MODELS: ModelInfo[] = [
    { value: '', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
  ];

  it('로그인한 계정의 supportedModels()를 그대로 돌려주고, 프롬프트를 보내지 않고 바로 닫는다', async () => {
    const { sdk, state } = fakeClaudeCode({ models: MODELS });

    const models = await fetchClaudeCodeModels({ sdk, cwd: '/tmp/project' });

    expect(models).toEqual(MODELS);
    expect(state.prompts).toEqual([]);
    expect(state.options).toMatchObject({ cwd: '/tmp/project', tools: [], settingSources: [], strictMcpConfig: true, permissionMode: 'dontAsk', persistSession: false });
    expect(state.closed).toBe(true);
  });

  it('제한 시간 안에 응답하지 않으면 실패하고, 그래도 연결을 정리한다', async () => {
    let closed = false;
    const sdk: ClaudeCodeSdk = {
      createSdkMcpServer: () => ({ type: 'sdk', name: 'b-studio', instance: {} }) as unknown as McpServerConfig,
      query: () =>
        ({
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
          accountInfo: () => new Promise(() => {}),
          supportedModels: () => new Promise(() => {}), // 응답하지 않는 CLI를 흉내 낸다
          interrupt: async () => {},
          close: () => {
            closed = true;
          },
        }) as unknown as ClaudeCodeQuery,
    };

    await expect(fetchClaudeCodeModels({ sdk, timeoutMs: 5 })).rejects.toThrow('초 안에 응답하지 않았습니다');
    expect(closed).toBe(true);
  });
});

describe('zodShape', () => {
  it('buildTools의 입력 스키마를 그대로 검사한다', () => {
    const tools = Object.fromEntries(buildTools(project).map((tool) => [tool.name, z.object(zodShape(tool.input_schema))]));

    expect(tools.run_in_service!.safeParse({ service: 'api', command: ['./gradlew', 'test'] }).success).toBe(true);
    expect(tools.run_in_service!.safeParse({ service: 'db', command: ['psql'] }).success).toBe(false);
    expect(tools.service_logs!.safeParse({ service: 'api', lines: 1.5 }).success).toBe(false);
    expect(tools.http_request!.safeParse({ service: 'api', method: 'TRACE', path: '/', body: '' }).success).toBe(false);

    // ask_user의 boolean 필드도 zod 형태로 옮긴다
    const interactive = Object.fromEntries(buildTools(project, { interactive: true }).map((tool) => [tool.name, z.object(zodShape(tool.input_schema))]));
    expect(interactive.ask_user!.safeParse({ question: 'q', options: ['a', 'b'], allowOther: true }).success).toBe(true);
    expect(interactive.ask_user!.safeParse({ question: 'q', options: ['a', 'b'], allowOther: 'yes' }).success).toBe(false);
  });

  it('실행 중 지시를 스트리밍 입력 큐에 넣어 다음 턴에 반영한다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [
        [{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }, { text: '추가했습니다.' }],
        [{ text: '지시를 반영했습니다.' }],
        // 지시가 먼저 들어간 뒤 게이트 피드백이 큐에 남는다. 러너가 결과를 받은 뒤 큐를 비우며 처리한다
        [{ text: '게이트 피드백을 처리했습니다.' }],
      ],
    });
    const queue = fakeSteering();
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '새 클래스를 추가해줘',
      project,
      sandbox: fakeSandbox(project, [false, true]),
      sdk,
      steering: queue.steering,
      fetcher: async () => contract,
      onEvent: (event) => {
        events.push(event);
        // 도구가 끝난 뒤(턴이 끝나기 전) 사용자가 지시를 보낸다 → 입력 큐에 들어간다
        if (event.type === 'tool_result') queue.push('테스트도 추가해줘');
      },
    });

    expect(result).toMatchObject({ status: 'done', verifyAttempts: 1 });
    // 지시가 입력 큐에 들어가 다음 사용자 메시지로 처리된다
    expect(state.prompts[1]).toBe('[진행 중 지시] 테스트도 추가해줘');
    expect(events.filter((event): event is Extract<AgentEvent, { type: 'steer_applied' }> => event.type === 'steer_applied')).toMatchObject([{ count: 1 }]);
  });

  it('게이트가 같은 실패를 반복하면 같은 세션을 이어받아 모델만 바꾼 다음 query를 연다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }, { text: '1' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }, { text: '2' }],
        [{ text: '3' }],
      ],
    });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, [false, false, true]),
      sdk,
      model: 'haiku',
      escalation: { to: 'sonnet', sameSignatureTimes: 2 },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', sessionId: 'forked-session', verifyAttempts: 2 });
    // 두 번째 query는 첫 query가 만든 세션을 이어받고 모델만 바뀐다
    expect(state.options).toMatchObject({ model: 'sonnet', resume: 'new-session', forkSession: true });
    const escalated = events.filter((event): event is Extract<AgentEvent, { type: 'model_escalated' }> => event.type === 'model_escalated');
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({ from: 'haiku', to: 'sonnet', attempt: 2, sameSignatureTimes: 2 });
    expect(result.metrics?.escalatedAt).toBe(2);
  });

  it('서명이 반복되지 않아도 afterFailures번 실패하면 승격하고, 승격 예산만큼 더 시도한다', async () => {
    // 파일 내용을 매번 다르게 써서 편집 충돌 없이 턴을 끝낸다
    const write = (n: number) => [
      { tool: 'write_file', input: { path: 'api/src/Order.java', content: `class Order { String customerName; /* ${n} */ }\n` } },
      { text: `${n}` },
    ];
    const { sdk, state } = fakeClaudeCode({ turns: [write(1), write(2), write(3), [{ text: '승격 뒤 고쳤습니다.' }]] });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      // 기본 상한(3)을 넘긴 지점에서 승격하므로, 예산이 없으면 이어 가지 못한다
      sandbox: fakeSandbox(project, [false, false, false, true]),
      sdk,
      model: 'haiku',
      // 서명 규칙은 사실상 끄고 실패 횟수 규칙만 본다
      escalation: { to: 'sonnet', sameSignatureTimes: 99, afterFailures: 3, retryBudget: 2 },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', verifyAttempts: 3 });
    expect(result.metrics?.escalatedAt).toBe(3);
    // 승격 뒤 query는 같은 세션을 이어받고 모델만 바뀐다(네 번째 시도가 승격 모델로 돌았다)
    expect(state.options).toMatchObject({ model: 'sonnet', resume: 'new-session', forkSession: true });
    const escalated = events.filter((event): event is Extract<AgentEvent, { type: 'model_escalated' }> => event.type === 'model_escalated');
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({ from: 'haiku', to: 'sonnet', attempt: 3 });
    // 상한이 소진된 뒤의 승격이라 마지막 실패 안내를 다시 보낸다
    expect(state.prompts.at(-1)).toContain('직전 검증 결과를 다시 보냅니다');
  });

  it('escalation을 주지 않으면 게이트가 반복 실패해도 query를 다시 열지 않는다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }, { text: '1' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }, { text: '2' }],
      ],
    });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, [false, true]),
      sdk,
      model: 'haiku',
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', sessionId: 'new-session' });
    expect(state.options).toMatchObject({ model: 'haiku' });
    expect(state.options?.resume).toBeUndefined();
    expect(events.some((event) => event.type === 'model_escalated')).toBe(false);
  });

  it('승격 뒤에 보낸 지시는 새 query의 입력 큐로 들어간다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }, { text: '1' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }, { text: '2' }],
        // 승격 뒤 새 query의 첫 턴. 지시를 넣을 도구 결과 하나가 필요하다
        [{ tool: 'read_file', input: { path: 'api/src/Order.java' } }, { text: '3' }],
        [{ text: '지시를 반영했습니다.' }],
        // 지시가 먼저 처리되고 게이트 피드백이 큐에 남아, 끝난 뒤 큐를 비우며 한 번 더 든다
        [{ text: '게이트 피드백을 처리했습니다.' }],
      ],
    });
    const queue = fakeSteering();
    const events: AgentEvent[] = [];
    // 승격이 일어난 뒤에만 지시를 보낸다(승격 직후 도구가 끝날 때). 그 지시가 새 query의 입력 큐로 가야 한다
    let escalated = false;

    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, [false, false, false, true]),
      sdk,
      model: 'haiku',
      escalation: { to: 'sonnet' },
      steering: queue.steering,
      // 승격 뒤 실패 한 번, 지시 반영 한 번까지 돌도록 재시도 여유를 둔다
      maxVerifyAttempts: 4,
      fetcher: async () => contract,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'model_escalated') escalated = true;
        if (escalated && event.type === 'tool_result') queue.push('승격 뒤 지시');
      },
    });

    expect(result.status).toBe('done');
    // 새 query의 첫 입력은 게이트 피드백이고, 그 뒤에 지시가 들어간다
    expect(state.prompts[2]).toContain('[b-studio 검증 게이트]');
    expect(state.prompts[3]).toBe('[진행 중 지시] 승격 뒤 지시');
    expect(events.some((event) => event.type === 'steer_applied')).toBe(true);
  });

  it('승격해도 승격 전 사용량을 잃지 않고 모델별로 남긴다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }, { text: '1' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }, { text: '2' }],
        [{ text: '3' }],
      ],
      // query 하나의 modelUsage는 누적값이라 시도마다 커진다. 승격 뒤에는 다른 모델(sonnet)의 값이 온다
      modelUsages: [
        { haiku: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        { haiku: { inputTokens: 150, outputTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        { sonnet: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      ],
    });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, [false, false, true]),
      sdk,
      model: 'haiku',
      escalation: { to: 'sonnet' },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('done');
    // 승격 전(haiku 150) + 승격 뒤(sonnet 200). 합계가 이벤트에도 반영된다
    expect(result.usage).toEqual({ inputTokens: 350, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(events.flatMap((event) => (event.type === 'tokens' ? [event.usage.inputTokens] : []))).toEqual([100, 150, 350]);
    expect(result.metrics?.usageByModel).toEqual({
      haiku: { inputTokens: 150, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sonnet: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it('승격 순간에 보낸 지시는 닫히는 query가 아니라 새 query 입력으로 들어간다', async () => {
    const { sdk, state } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }, { text: '1' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }, { text: '2' }],
        [{ tool: 'read_file', input: { path: 'api/src/Order.java' } }, { text: '3' }],
        [{ text: '지시 반영' }],
        [{ text: '게이트 피드백 처리' }],
      ],
    });
    const queue = fakeSteering();
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, [false, false, false, true]),
      sdk,
      model: 'haiku',
      escalation: { to: 'sonnet' },
      steering: queue.steering,
      maxVerifyAttempts: 4,
      fetcher: async () => contract,
      onEvent: (event) => {
        events.push(event);
        // 승격이 일어나 지시 연결을 끊은 직후(model_escalated 시점)에 들어온 지시
        if (event.type === 'model_escalated') queue.push('승격 순간 지시');
      },
    });

    expect(result.status).toBe('done');
    expect(state.prompts[2]).toContain('[b-studio 검증 게이트]');
    expect(state.prompts[3]).toBe('[진행 중 지시] 승격 순간 지시');
    expect(events.some((event) => event.type === 'steer_applied')).toBe(true);
  });

  it('연결 시 flush는 쌓인 지시가 없으면 아무 이벤트도 내지 않는다', async () => {
    const { sdk } = fakeClaudeCode({ turns: [[{ text: '주문 API입니다.' }]] });
    const queue = fakeSteering();
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '설명해줘',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      steering: queue.steering,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('done');
    expect(events.some((event) => event.type === 'steer_applied')).toBe(false);
  });
});

describe('claude-code 러너의 샌드박스 지연 기동(ensureSandbox)', () => {
  it('읽기 도구만 쓰는 요청은 샌드박스를 켜지 않고 게이트도 만들지 않는다(계약 기준을 잡지 않는다)', async () => {
    const { sdk } = fakeClaudeCode({ turns: [[{ tool: 'read_file', input: { path: 'api/src/Order.java' } }, { text: '읽었습니다.' }]] });
    let boots = 0;
    let fetches = 0;

    const result = await runClaudeCodeAgent({
      request: '읽고 설명해줘',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      fetcher: async () => {
        fetches += 1;
        return contract;
      },
      ensureSandbox: async () => void (boots += 1),
    });

    expect(result).toMatchObject({ status: 'done', summary: '읽었습니다.', changedFiles: [] });
    expect(boots).toBe(0);
    // 게이트를 만들지 않았으므로 계약 기준도 잡지 않는다
    expect(fetches).toBe(0);
    expect(result.report).toBeUndefined();
  });

  it('쓰기 도구 첫 호출 때 한 번 켜고, 계약 기준을 그때 잡은 뒤 결과에서 게이트가 돈다', async () => {
    const { sdk } = fakeClaudeCode({ turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }, { text: '추가했습니다.' }]] });
    let boots = 0;
    let fetches = 0;
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '새 클래스 추가',
      project,
      sandbox: fakeSandbox(project, [true]),
      sdk,
      fetcher: async () => {
        fetches += 1;
        return contract;
      },
      ensureSandbox: async () => void (boots += 1),
      onEvent: (event) => events.push(event),
    });

    expect(boots).toBe(1);
    // 게이트를 만들며 계약 기준을 잡았다(샌드박스가 켜진 뒤, 아직 바뀌지 않은 코드에서).
    // 기준(1회) + 변경 뒤 계약 확인(1회)이라 2회 이상이다(읽기만 하는 지연 기동은 0회)
    expect(fetches).toBeGreaterThan(0);
    expect(result).toMatchObject({ status: 'done' });
    expect(result.changedFiles).toContain('api/src/New.java');
    expect(events.some((event) => event.type === 'verify_start')).toBe(true);
  });

  it('eager(ensureSandbox 없음)는 지금처럼 시작할 때 게이트를 만든다', async () => {
    const { sdk } = fakeClaudeCode({ turns: [[{ tool: 'read_file', input: { path: 'api/src/Order.java' } }, { text: '읽었습니다.' }]] });
    let fetches = 0;

    const result = await runClaudeCodeAgent({
      request: '읽어줘',
      project,
      sandbox: fakeSandbox(project, []),
      sdk,
      fetcher: async () => {
        fetches += 1;
        return contract;
      },
    });

    expect(result.status).toBe('done');
    // 시작할 때 게이트를 만들어 계약 기준을 잡았다(지연 기동이 아니다)
    expect(fetches).toBe(1);
  });
});

describe('runClaudeCodeAgent 프로젝트 지침 주입(ADR-077)', () => {
  it('project.root의 AGENTS.md를 systemPrompt 옵션에 명확히 구분된 절로 넣고, metrics.guideChars에 글자 수를 남긴다', async () => {
    await writeFile(path.join(project.root, 'AGENTS.md'), '## 스크립트\n- pnpm test 대신 scripts/web-test.sh를 실행\n');
    const { sdk, state } = fakeClaudeCode({ turns: [[{ text: '읽었습니다.' }]] });

    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });

    expect(promptOf(state.options)).toContain('[b-studio project guide: AGENTS.md]');
    expect(promptOf(state.options)).toContain('scripts/web-test.sh');
    expect(result.metrics!.guideChars).toBe('## 스크립트\n- pnpm test 대신 scripts/web-test.sh를 실행\n'.length);
  });

  it('AGENTS.md가 없으면 systemPrompt에 절을 더하지 않는다', async () => {
    const { sdk, state } = fakeClaudeCode({ turns: [[{ text: '읽었습니다.' }]] });

    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), sdk, fetcher: async () => contract });

    expect(promptOf(state.options)).not.toContain('[b-studio project guide');
    expect(result.metrics!.guideChars).toBeUndefined();
  });
});

describe('runClaudeCodeAgent 턴 상한에 걸리면 되돌리기 전에 게이트를 한 번 더 본다(ADR-131)', () => {
  it('Claude Code 자신이 턴 상한(error_max_turns)으로 끝냈어도 지금까지의 변경이 게이트를 통과하면 done으로 남긴다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [[{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }]],
      result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
    });
    const sandbox = fakeSandbox(project, [true]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, sdk, fetcher: async () => contract });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('최대 턴 수(60)를 넘었습니다');
    expect(result.summary).toContain('검증 게이트를 통과해');
    expect(result.failureReason).toBeUndefined();
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
    expect(sandbox.restarts).toEqual(['api']);
  });

  it('턴 상한(error_max_turns)에 걸렸는데 지금까지의 변경이 게이트를 통과하지 못하면 실패로 끝내 되돌리기 경로를 타게 한다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [[{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String broken;' } }]],
      result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
    });
    // 재시작이 실패로 와서(false) 게이트가 통과하지 못한다
    const sandbox = fakeSandbox(project, [false]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, sdk, fetcher: async () => contract });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('max_turns');
    expect(result.summary).toBe('최대 턴 수(60)를 넘었습니다');
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
  });

  it('SDK가 턴 상한 결과 뒤에 예외를 던져도, 게이트를 통과한 변경은 done으로 남긴다 (트러블슈팅 131)', async () => {
    // 실제 SDK(0.3.267)의 동작: error_max_turns 결과를 준 뒤 "Claude Code returned an error result: …"를 던진다.
    // 그 예외가 밖으로 나가면 세션이 실행을 오류로 끝내고 변경을 되돌린다
    const { sdk } = fakeClaudeCode({
      turns: [[{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }]],
      result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
      throwAfterResult: 'Claude Code returned an error result: Reached maximum number of turns (60)',
    });
    const sandbox = fakeSandbox(project, [true]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, sdk, fetcher: async () => contract });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('검증 게이트를 통과해 체크포인트로 남깁니다');
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
  });

  it('SDK가 턴 상한 결과 뒤에 예외를 던져도, 게이트를 통과하지 못했으면 실패(max_turns)로 끝난다', async () => {
    const { sdk } = fakeClaudeCode({
      turns: [[{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String broken;' } }]],
      result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
      throwAfterResult: 'Claude Code returned an error result: Reached maximum number of turns (60)',
    });
    const sandbox = fakeSandbox(project, [false]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, sdk, fetcher: async () => contract });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('max_turns');
    expect(result.summary).toBe('최대 턴 수(60)를 넘었습니다');
  });

  it('결과를 받기 전에 난 예외는 그대로 던진다(삼키지 않는다)', async () => {
    const { sdk } = fakeClaudeCode({ turns: [] });
    await expect(runClaudeCodeAgent({ request: '고쳐줘', project, sandbox: fakeSandbox(project, [true]), sdk, fetcher: async () => contract })).rejects.toThrow('스크립트에 남은 턴이 없습니다');
  });

  it('러너 자신의 턴 카운터가 상한을 넘겨도(assistant 메시지 수 기준) 같은 방식으로 게이트를 한 번 더 본다', async () => {
    // 한 번의 사용자 턴 안에서 도구 호출 3번(메시지 3개)을 내 maxTurns=2를 넘긴다 — Claude Code 쪽 error_max_turns 없이
    // 러너 자신의 messageIds 카운터만으로 걸리는 경로를 재현한다
    const { sdk } = fakeClaudeCode({
      turns: [
        [
          { tool: 'read_file', input: { path: 'api/src/Order.java' } },
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } },
          { tool: 'read_file', input: { path: 'api/src/Order.java' } },
        ],
      ],
    });
    const sandbox = fakeSandbox(project, [true]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, sdk, fetcher: async () => contract, maxTurns: 2 });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('최대 턴 수(2)를 넘었습니다');
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
  });
});
