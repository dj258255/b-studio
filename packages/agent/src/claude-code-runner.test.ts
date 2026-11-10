import { existsSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  describeAccount,
  fetchClaudeCodeModels,
  preflightClaudeCode,
  runClaudeCodeAgent,
  zodShape,
} from './claude-code-runner';
import { FAKE_FORKED_SESSION, FAKE_NEW_SESSION, FAKE_PREVIOUS_SESSION, fakeClaudeCli, type FakeCliLog, type FakeCliScenario, type FakeInvocation, type FakeStep } from './fake-claude-cli';
import type { AgentEvent } from './loop';
import { AGENT_LANGUAGE_REMINDER } from './prompts';
import { createOrdersProject, fakeSandbox, fakeSteering, ORDERS_CONTRACT as contract } from './test-helpers';
import { buildTools } from './tools';

let project: LoadedProject;

beforeEach(async () => {
  project = await createOrdersProject('claude-code-test-');
});

/** 가짜 CLI가 받은 인자를 옛 SDK 옵션과 같은 꼴로 읽는다. 같은 기대값으로 같은 결과를 견주려는 것이다 */
function optionsOf(fake: ReturnType<typeof fakeClaudeCli>, log: FakeCliLog | undefined) {
  if (!log) return undefined;
  const list = (flag: string): string[] | undefined => {
    const value = fake.argOf(log, flag);
    return value === undefined ? undefined : value === '' ? [] : value.split(',');
  };
  return {
    cwd: log.cwd,
    tools: list('--tools'),
    allowedTools: list('--allowedTools'),
    permissionMode: fake.argOf(log, '--permission-mode'),
    strictMcpConfig: log.args.includes('--strict-mcp-config'),
    settingSources: list('--setting-sources'),
    model: fake.argOf(log, '--model'),
    effort: fake.argOf(log, '--effort'),
    resume: fake.argOf(log, '--resume'),
    forkSession: log.args.includes('--fork-session'),
    // 지시문은 기록하지 않게 매번 새로 보낸다(--system-prompt-snapshot off, 트러블슈팅 130)
    systemPrompt: log.systemPrompt ? { type: 'custom' as const, prompt: log.systemPrompt.text, snapshot: fake.argOf(log, '--system-prompt-snapshot') !== 'off' } : undefined,
    env: log.env,
  };
}

/** 러너가 시스템 프롬프트 파일에 쓴 글 */
function promptOf(options: ReturnType<typeof optionsOf>): string {
  return options?.systemPrompt?.prompt ?? '';
}

type Step = FakeStep;

interface FakeOptions {
  /** 사용자 메시지마다 모델이 할 일 */
  turns?: Step[][];
  result?: Record<string, unknown>;
  /** 사용자 메시지(게이트 재시도 포함)마다 돌려줄 modelUsage. 없으면 기본 계산을 쓴다 */
  modelUsages?: FakeCliScenario['modelUsages'];
  /** result마다 실어 보낼 duration_api_ms(순서대로). 비면 그 필드 없이 보낸다 */
  apiDurations?: number[];
  /** 결과를 준 뒤에 이 코드·문구로 끝난다. 진짜 CLI는 오류 결과(턴 상한 등) 뒤에 0이 아닌 코드로 끝난다 */
  exitAfterResult?: { code: number; stderr: string };
  invocations?: FakeInvocation[];
}

/**
 * claude CLI를 흉내 내는 가짜 실행 파일(fixtures/fake-claude-cli.mjs)을 러너에 끼운다.
 * 사용자 메시지(표준 입력 줄)를 받을 때마다 준비된 단계를 실행하고, 도구 단계는 --mcp-config의 HTTP MCP 서버를 실제로 부른다.
 * 프로세스를 다시 띄워도 남은 턴을 이어서 꺼낸다.
 */
function fakeClaudeCode({ turns = [], result = {}, modelUsages = [], apiDurations = [], exitAfterResult, invocations }: FakeOptions = {}) {
  const fake = fakeClaudeCli({
    turns,
    result,
    modelUsages,
    apiDurations,
    ...(invocations ? { invocations } : {}),
    ...(exitAfterResult ? { exitCodeAfterResult: exitAfterResult.code, stderrAfterResult: exitAfterResult.stderr } : {}),
  });
  const state = {
    /** 모든 프로세스의 표준 입력으로 들어간 사용자 메시지 글 */
    get prompts(): string[] {
      return fake.prompts();
    },
    /** 마지막으로 띄운 프로세스의 옵션 */
    get options() {
      return optionsOf(fake, fake.logs().at(-1));
    },
    fake,
  };
  return { cli: fake.cli, state };
}

describe('runClaudeCodeAgent', () => {
  it('질문 모드는 요청 앞에 읽기 전용 안내를 붙이고, 쓰기 도구를 거부하며, 게이트 없이 끝난다', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order {}' } }, { text: '계획입니다.' }]],
    });
    const sandbox = fakeSandbox(project, []);
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '어떻게 바꿔?',
      intent: 'ask',
      project,
      sandbox,
      ...cli,
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
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '찾은 내용입니다.' }]] });
    const sandbox = fakeSandbox(project, []);

    const result = await runClaudeCodeAgent({
      request: '최신 결제 PG 수수료 비교',
      intent: 'ask',
      research: true,
      project,
      sandbox,
      ...cli,
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
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '답입니다.' }]] });
    const sandbox = fakeSandbox(project, []);

    await runClaudeCodeAgent({ request: '이 함수는 뭐해?', intent: 'ask', project, sandbox, ...cli, fetcher: async () => contract });

    expect(state.options?.tools).toEqual([]);
    expect(state.options?.allowedTools).not.toContain('WebSearch');
    expect(state.prompts[0]).not.toContain('[조사 모드]');
  });

  it('기본 도구와 사용자 설정을 끄고 b-studio 도구만 허용한다. 게이트가 실패하면 같은 대화에 결과를 넣는다', async () => {
    const { cli, state } = fakeClaudeCode({
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
      ...cli,
      account: { subscriptionType: 'Claude Max' },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(state.options).toMatchObject({ tools: [], settingSources: [], permissionMode: 'dontAsk', strictMcpConfig: true });
    // 작업 폴더는 프로젝트 루트다(macOS의 /var는 /private/var로 풀려 보인다)
    expect(realpathSync(state.options!.cwd)).toBe(realpathSync(project.root));
    expect(state.options?.allowedTools).toContain('mcp__b-studio__edit_file');
    expect(state.options?.allowedTools?.every((name) => name.startsWith('mcp__b-studio__'))).toBe(true);
    expect(state.options?.resume).toBeUndefined();
    expect(promptOf(state.options)).toEqual(expect.stringContaining('mcp__b-studio__read_file'));

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 4, sessionId: FAKE_NEW_SESSION });
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
    const { cli } = fakeClaudeCode({
      turns: [
        [
          { tool: 'read_file', input: { path: 'api/src/Order.java' }, id: 'm1', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 5 } },
          { text: '읽었습니다.', id: 'm1', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 7 } },
          { text: '주문 API입니다.', id: 'm2', usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
        ],
      ],
    });

    const events: AgentEvent[] = [];
    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract, onEvent: (event) => events.push(event) });

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
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '앞에서 말한 주문 API입니다.' }]] });

    const result = await runClaudeCodeAgent({
      request: '거기에 뭘 더할 수 있어?',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
      resume: FAKE_PREVIOUS_SESSION,
      fetcher: async () => contract,
    });

    expect(state.options).toMatchObject({ resume: FAKE_PREVIOUS_SESSION, forkSession: true });
    expect(result).toMatchObject({ status: 'done', sessionId: FAKE_FORKED_SESSION, turns: 1 });
  });

  it('모델에게 보내는 요청 글 끝에 언어 알림을 붙인다. 게이트가 되돌려 보내는 글에는 붙이지 않는다 (트러블슈팅 132)', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String broken;' } }, { text: '고쳤습니다.' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam; String broken;', new_text: 'customerName;' } }, { text: '다시 고쳤습니다.' }],
      ],
    });
    // 첫 검증은 실패(재시작 실패), 둘째는 통과
    await runClaudeCodeAgent({ request: '주문에 메모 필드를 더해 주세요', project, sandbox: fakeSandbox(project, [false, true]), ...cli, fetcher: async () => contract });

    expect(state.prompts[0]).toBe(`주문에 메모 필드를 더해 주세요\n\n${AGENT_LANGUAGE_REMINDER}`);
    expect(AGENT_LANGUAGE_REMINDER).toContain('진행 문장도 한국어');
    // 게이트의 안내는 이미 한국어이고 같은 실행 안의 글이다
    expect(state.prompts[1]).toContain('[b-studio 검증 게이트]');
    expect(state.prompts[1]).not.toContain(AGENT_LANGUAGE_REMINDER);
  });

  it('지시문을 대화에 기록하지 않게 넘긴다 — 이어받은 대화도 지금의 지시문으로 돈다 (트러블슈팅 130)', async () => {
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '네.' }]] });

    await runClaudeCodeAgent({ request: '이어서', project, sandbox: fakeSandbox(project, []), ...cli, resume: FAKE_PREVIOUS_SESSION, fetcher: async () => contract });

    // 글만 넘기면 SDK가 처음 만들 때의 지시문을 기록해 두고, 이어받을 때 새로 넘긴 지시문을 무시한다
    expect(state.options?.systemPrompt).toMatchObject({ type: 'custom', snapshot: false });
    expect(promptOf(state.options)).toContain('[b-studio workflow]');
  });

  it('모델 호출이 오류로 끝나면 게이트를 돌리지 않고 실패한다', async () => {
    const { cli } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }]],
      result: { is_error: true, result: 'rate limit reached' },
    });
    const sandbox = fakeSandbox(project, []);

    const result = await runClaudeCodeAgent({ request: '추가해줘', project, sandbox, ...cli, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'failed', summary: '모델 호출이 실패했습니다: rate limit reached' });
    expect(sandbox.restarts).toEqual([]);
  });

  it('인증 오류 같은 영구 오류는 기다리지 않고 바로 실패한다(네트워크 사유를 달지 않는다)', async () => {
    const { cli } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }]],
      result: { is_error: true, result: 'authentication_error: invalid x-api-key' },
    });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '추가해줘',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
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
    const { cli } = fakeClaudeCode({ turns: [[{ text: '주문 API입니다.' }]], apiDurations: [3_333.4] });
    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract });
    expect(result.status).toBe('done');
    expect(result.metrics?.modelMs).toBe(3_333);
  });

  it('한 query에서 result가 여러 번 오면 modelMs를 더하지 않고 마지막 누적값을 쓴다', async () => {
    // 게이트가 한 번 실패해 같은 query에서 턴이 두 번 끝난다. duration_api_ms는 그 query의 누적값이다(실측 3,333 → 5,997)
    const { cli } = fakeClaudeCode({
      turns: [
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }, { text: '1' }],
        [{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }, { text: '2' }],
      ],
      apiDurations: [3_333, 5_997],
    });
    const result = await runClaudeCodeAgent({ request: '주문에 메모 필드 추가', project, sandbox: fakeSandbox(project, [false, true]), ...cli, fetcher: async () => contract });
    expect(result.status).toBe('done');
    expect(result.metrics?.modelMs).toBe(5_997);
  });

  it('숫자가 아닌 duration_api_ms는 재지 않은 것으로 본다', async () => {
    const { cli } = fakeClaudeCode({ turns: [[{ text: '주문 API입니다.' }]], result: { duration_api_ms: 'n/a' } as never });
    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract });
    expect(result.metrics).not.toHaveProperty('modelMs');
  });

  it('첫 시도가 ENOTFOUND로 끝나면 기다렸다가 같은 세션을 resume으로 이어받아 이어서 성공한다', async () => {
    const waits: number[] = [];
    // 첫 프로세스는 네트워크가 끊겨 모델 호출이 ENOTFOUND로 끝나고 바로 끝난다. 둘째 프로세스가 이어받는다
    const { cli, state } = fakeClaudeCode({
      turns: [[{ text: '이어서 완료했습니다.' }]],
      apiDurations: [2_500],
      invocations: [
        { sessionId: '11111111-1111-4111-8111-111111111111', failFirst: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", failApiMs: 1_000 },
        { sessionId: '11111111-1111-4111-8111-111111111111' },
      ],
    });

    const events: AgentEvent[] = [];
    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
      // 실제 sleep 대신 기다린 시간만 기록한다(시간을 흐르게 하지 않는다)
      networkRetry: { wait: async (ms) => { waits.push(ms); }, maxAttempts: 3, maxWaitMs: 60_000, baseDelayMs: 1_000 },
    });

    expect(result).toMatchObject({ status: 'done', summary: '이어서 완료했습니다.' });
    // 프로세스를 다시 띄우면 누적값이 0부터 다시 시작한다. 끝난 프로세스의 값(1,000)에 새 프로세스의 값(2,500)을 더한다
    expect(result.metrics?.modelMs).toBe(3_500);
    const logs = state.fake.logs();
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => state.fake.argOf(log, '--resume'))).toEqual([undefined, '11111111-1111-4111-8111-111111111111']);
    expect(waits).toEqual([1_000]);
    // 이미 한 작업을 다시 하지 않도록 원래 요청 대신 짧은 이어서 진행 안내만 보낸다
    expect(state.prompts[1]).toBe('네트워크가 끊겼다가 돌아왔습니다. 하던 작업을 처음부터 다시 하지 말고 그대로 이어서 진행하세요.');
    expect(events.some((event) => event.type === 'warning' && event.message.includes('네트워크'))).toBe(true);
  });

  it('네트워크 오류가 상한(재시도 횟수)을 넘기면 네트워크 사유로 실패한다', async () => {
    const { cli } = fakeClaudeCode({
      turns: [[], [], []],
      result: { is_error: true, result: 'ENOTFOUND api.anthropic.com' },
    });
    const waits: number[] = [];
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '추가해줘',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
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
    const { cli } = fakeClaudeCode({
      turns: [[]],
      result: { is_error: true, result: 'ENOTFOUND registry.npmjs.org' },
    });
    const controller = new AbortController();

    await expect(
      runClaudeCodeAgent({
        request: '추가해줘',
        project,
        sandbox: fakeSandbox(project, []),
        ...cli,
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

  it('취소하면 입력을 닫고 프로세스를 끝내고(SIGTERM) 결과 대신 취소 이유를 던진다', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }, { tool: 'read_file', input: { path: 'api/src/New.java' } }, { text: '추가했습니다.' }]],
    });
    const controller = new AbortController();
    const events: AgentEvent[] = [];

    await expect(
      runClaudeCodeAgent({
        request: '추가해줘',
        project,
        sandbox: fakeSandbox(project, [true]),
        ...cli,
        signal: controller.signal,
        fetcher: async () => contract,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'tool_result') controller.abort(new DOMException('요청을 취소했습니다', 'AbortError'));
        },
      }),
    ).rejects.toThrow('요청을 취소했습니다');

    // 취소하면 자식 프로세스에 입력 닫기 → SIGTERM이 간다(진행 중인 턴을 끝까지 기다리지 않는다)
    const [log] = state.fake.logs();
    expect(log?.stdinClosed || log?.signals.includes('SIGTERM')).toBe(true);
    // 취소 뒤에 온 도구 호출은 실행하지 않는다
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.type === 'tool_call' && e.name)).toEqual(['write_file']);
  });

  it('모델 응답을 기다리며 멈춰 있는 CLI도 취소하면 끝내고(입력 닫기 → SIGTERM) 취소 이유를 던진다', async () => {
    const { cli, state } = fakeClaudeCode({ turns: [[{ hang: true }]] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('요청을 취소했습니다', 'AbortError')), 300);

    await expect(runClaudeCodeAgent({ request: '고쳐줘', project, sandbox: fakeSandbox(project, []), ...cli, signal: controller.signal, fetcher: async () => contract })).rejects.toThrow('요청을 취소했습니다');

    // 멈춰 있는 턴은 입력을 닫아도 끝나지 않으므로 SIGTERM이 가야 끝난다
    expect(state.fake.logs()[0]!.signals).toContain('SIGTERM');
  });

  it('CLI가 결과 없이 끝나면 통과로 남기지 않고 종료 코드와 표준 오류를 담아 실패로 던진다', async () => {
    const { cli } = fakeClaudeCode({ turns: [] });

    await expect(
      runClaudeCodeAgent({ request: '읽어줘', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract }),
    ).rejects.toThrow(/결과를 보내지 않고 종료됐습니다.*종료 코드 1.*스크립트에 남은 턴이 없습니다/s);
  });

  it('CLI 실행 파일을 띄우지 못하면 실패로 던진다', async () => {
    await expect(
      runClaudeCodeAgent({ request: '읽어줘', project, sandbox: fakeSandbox(project, []), command: path.join(project.root, 'no-such-claude'), fetcher: async () => contract }),
    ).rejects.toThrow(/결과를 보내지 않고 종료됐습니다.*ENOENT/s);
  });

  it('ask_user가 질문을 남기면 쿼리를 중단하고 awaiting_input으로 끝내 세션 id를 남긴다', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [[{ tool: 'ask_user', input: { question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: true } }]],
    });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문 화면 만들어줘',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
      interactive: true,
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'awaiting_input', summary: '어떤 형태로 만들까요?', sessionId: FAKE_NEW_SESSION });
    expect(result.question).toEqual({ question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: true });
    expect(events.find((event) => event.type === 'question')).toMatchObject({ allowOther: true });
    // 되묻기 도구는 interactive일 때만 허용 목록에 들어간다
    expect(state.options?.allowedTools).toContain('mcp__b-studio__ask_user');
    // 변경 파일이 없으면 게이트를 돌리지 않는다
    expect(events.some((event) => event.type === 'verify_start')).toBe(false);
  });

  it('report_mismatch로 알린 어긋남을 결과에 싣는다. 레인처럼 interactive가 아니어도 허용 목록에 있다 (#666)', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [
        [
          { tool: 'report_mismatch', input: { request_value: '배송비 3,000원', check_value: 'OrderTest는 2,500원', followed: 'check', note: '테스트를 따랐습니다' } },
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } },
          { text: '고쳤습니다.' },
        ],
      ],
    });
    const result = await runClaudeCodeAgent({ request: '배송비를 3,000원으로', project, sandbox: fakeSandbox(project, [true]), ...cli, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done', gateOutcome: 'pass' });
    expect(result.mismatches).toEqual([{ requestValue: '배송비 3,000원', checkValue: 'OrderTest는 2,500원', followed: 'check', note: '테스트를 따랐습니다' }]);
    expect(state.options?.allowedTools).toContain('mcp__b-studio__report_mismatch');
  });

  it('interactive가 아니면 허용 목록에 ask_user가 없다(레인·벤치·CLI)', async () => {
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '주문 API입니다.' }]] });
    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract });

    expect(result.status).toBe('done');
    expect(state.options?.allowedTools).not.toContain('mcp__b-studio__ask_user');
  });
});

describe('runClaudeCodeAgent의 CLI 입출력(이슈 #1091, ADR-194)', () => {
  it('공식 문서에 있는 플래그만, 인자 배열로 넘긴다. 요청 글·프로젝트 안내는 인자에 넣지 않고 표준 입력으로 보낸다', async () => {
    await writeFile(path.join(project.root, 'AGENTS.md'), '--dangerously-skip-permissions 같은 글\n');
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '네.' }]] });

    await runClaudeCodeAgent({ request: '--help 를 실행해 줘', project, sandbox: fakeSandbox(project, []), ...cli, model: 'sonnet', effort: 'max', maxTurns: 7, fetcher: async () => contract });

    const [log] = state.fake.logs();
    expect(log).toBeDefined();
    // 가짜 CLI 앞의 인자(스크립트 경로 등)는 commandArgs이고, 러너가 붙인 인자만 본다
    const args = log!.args;
    expect(args.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
    expect(state.fake.argOf(log!, '--permission-mode')).toBe('dontAsk');
    expect(state.fake.argOf(log!, '--setting-sources')).toBe('');
    expect(state.fake.argOf(log!, '--tools')).toBe('');
    expect(state.fake.argOf(log!, '--model')).toBe('sonnet');
    expect(state.fake.argOf(log!, '--effort')).toBe('max');
    expect(state.fake.argOf(log!, '--max-turns')).toBe('7');
    expect(args).toContain('--strict-mcp-config');
    expect(state.fake.argOf(log!, '--system-prompt-snapshot')).toBe('off');
    expect(args).not.toContain('--resume');
    // 바깥에서 온 글은 인자에 없다
    expect(args.join('\n')).not.toContain('--help 를');
    expect(args.join('\n')).not.toContain('dangerously');
    expect(log!.systemPrompt?.text).toContain('dangerously-skip-permissions 같은 글');
    expect(log!.appendSystemPrompt).toBeUndefined();
    // 요청은 문서의 스트리밍 입력 꼴(사용자 메시지 한 줄)로 표준 입력에 들어간다
    expect(log!.stdin[0]).toEqual({ type: 'user', message: { role: 'user', content: `--help 를 실행해 줘\n\n${AGENT_LANGUAGE_REMINDER}` }, parent_tool_use_id: null });
  });

  it('MCP 설정은 0600 파일이고 토큰을 담지 않는다. 토큰은 자식 환경 변수로만 간다. 끝나면 파일을 지운다', async () => {
    const { cli, state } = fakeClaudeCode({ turns: [[{ tool: 'read_file', input: { path: 'api/src/Order.java' } }, { text: '읽었습니다.' }]] });

    await runClaudeCodeAgent({ request: '읽어줘', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract });

    const [log] = state.fake.logs();
    const config = JSON.parse(log!.mcp!.text) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    expect(log!.mcp!.mode).toBe(0o600);
    expect(log!.systemPrompt!.mode).toBe(0o600);
    expect(config.mcpServers['b-studio']).toMatchObject({ type: 'http', headers: { Authorization: 'Bearer ${B_STUDIO_MCP_TOKEN}' } });
    expect(config.mcpServers['b-studio']!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(log!.env.hasMcpToken).toBe(true);
    // 도구는 HTTP MCP로 실제로 불렸고 성공했다
    expect(log!.tools).toMatchObject([{ name: 'read_file', status: 200, isError: false }]);
    expect(existsSync(state.fake.argOf(log!, '--mcp-config')!)).toBe(false);
    expect(existsSync(state.fake.argOf(log!, '--system-prompt-file')!)).toBe(false);
  });

  it('이어받을 세션 id가 UUID 꼴이 아니면 인자에 넣지 않고 새 대화로 시작한다고 알린다', async () => {
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '네.' }]] });
    const events: AgentEvent[] = [];

    await runClaudeCodeAgent({ request: '이어서', project, sandbox: fakeSandbox(project, []), ...cli, resume: '--not-a-session', fetcher: async () => contract, onEvent: (event) => events.push(event) });

    expect(state.fake.logs()[0]!.args).not.toContain('--resume');
    expect(state.fake.logs()[0]!.args).not.toContain('--not-a-session');
    expect(events.some((event) => event.type === 'warning' && event.message.includes('새 대화'))).toBe(true);
  });

  it('조사 모드는 --tools에 WebSearch,WebFetch를 열고 허용 목록에도 넣는다', async () => {
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '찾았습니다.' }]] });

    await runClaudeCodeAgent({ request: '최신 PG 수수료', intent: 'ask', research: true, project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract });

    expect(state.fake.argOf(state.fake.logs()[0]!, '--tools')).toBe('WebSearch,WebFetch');
  });

  it('실행 중 지시는 같은 표준 입력에 사용자 메시지 한 줄로 들어간다', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }, { text: '추가했습니다.' }], [{ text: '반영했습니다.' }]],
    });
    const queue = fakeSteering();

    await runClaudeCodeAgent({
      request: '새 클래스를 추가해줘',
      project,
      sandbox: fakeSandbox(project, [true]),
      ...cli,
      steering: queue.steering,
      fetcher: async () => contract,
      onEvent: (event) => {
        if (event.type === 'tool_result') queue.push('테스트도 추가해줘');
      },
    });

    expect(state.fake.logs()[0]!.stdin[1]).toEqual({ type: 'user', message: { role: 'user', content: '[진행 중 지시] 테스트도 추가해줘' }, parent_tool_use_id: null });
  });

  it('판정이 끝난 뒤(대기 중이던 지시로 시작한 다음 턴에서) 도착하는 도구 호출은 파일을 바꾸지 않는다', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [
        [{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }, { text: '추가했습니다.' }],
        // 지시가 큐에 남아 CLI가 다음 턴을 시작한다. 이 턴의 쓰기는 이미 낸 판정 뒤에 닿는다
        [{ tool: 'write_file', delay: 400, input: { path: 'api/src/Late.java', content: 'class Late {}' } }, { text: '지시를 반영했습니다.' }],
      ],
    });
    const queue = fakeSteering();

    const result = await runClaudeCodeAgent({
      request: '새 클래스를 추가해줘',
      project,
      sandbox: fakeSandbox(project, [true]),
      ...cli,
      steering: queue.steering,
      fetcher: async () => contract,
      stop: { termAfterMs: 1_500, killAfterMs: 500 },
      onEvent: (event) => {
        if (event.type === 'tool_result') queue.push('Late도 추가해줘');
      },
    });

    expect(result).toMatchObject({ status: 'done' });
    expect(result.changedFiles).toEqual(['api/src/New.java']);
    const late = state.fake.logs()[0]!.tools.filter((tool) => tool.input && (tool.input as { path?: string }).path === 'api/src/Late.java');
    expect(late.every((tool) => tool.isError === true || tool.error !== null)).toBe(true);
  });

  it('JSON이 아닌 줄이나 모르는 type은 무시하고 끝까지 읽는다', async () => {
    const { cli } = fakeClaudeCode({ turns: [[{ text: '끝.' }]], invocations: [{ pre: ['이건 JSON이 아닙니다', '[1,2]', { type: 'future_message_type', payload: 1 }, { type: 'system', subtype: 'future_subtype' }] }] });

    const result = await runClaudeCodeAgent({ request: '설명해줘', intent: 'ask', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done', summary: '끝.' });
  });

  it('결과 subtype별 처리: 비용 한도·기타 오류·거절은 게이트 없이 실패로 끝낸다', async () => {
    const budget = fakeClaudeCode({ turns: [[{ text: '1' }]], result: { subtype: 'error_max_budget_usd', is_error: true, errors: [] } });
    expect(await runClaudeCodeAgent({ request: 'a', project, sandbox: fakeSandbox(project, []), ...budget.cli, fetcher: async () => contract })).toMatchObject({ status: 'failed', summary: 'Claude Code의 비용 한도를 넘었습니다' });

    const other = fakeClaudeCode({ turns: [[{ text: '1' }]], result: { subtype: 'error_during_execution', is_error: true, errors: ['도구 오류', '두 번째'] } });
    expect(await runClaudeCodeAgent({ request: 'a', project, sandbox: fakeSandbox(project, []), ...other.cli, fetcher: async () => contract })).toMatchObject({ status: 'failed', summary: 'Claude Code 실행 중 오류가 났습니다: 도구 오류; 두 번째' });

    const refusal = fakeClaudeCode({ turns: [[{ text: '1' }]], result: { stop_reason: 'refusal' } });
    expect(await runClaudeCodeAgent({ request: 'a', project, sandbox: fakeSandbox(project, []), ...refusal.cli, fetcher: async () => contract })).toMatchObject({ status: 'failed', summary: '모델이 요청을 거절했습니다' });
  });

  it('b-studio 도구 서버에 연결하지 못했다고 init이 알리면 도구 없이 돌리지 않고 실패로 끝낸다', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [[{ text: '도구 없이 끝냈습니다.' }]],
      invocations: [{ initExtra: { mcp_servers: [{ name: 'b-studio', status: 'failed' }], mcp_server_errors: [{ name: 'b-studio', type: 'invalid_config', message: 'x' }] } }],
    });
    const sandbox = fakeSandbox(project, [true]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, ...cli, fetcher: async () => contract, stop: { termAfterMs: 20, killAfterMs: 20 } });

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.summary).toContain('도구 서버');
    // 도구 없이 턴을 돌지 않는다: 입력 닫기·SIGTERM 중 어느 쪽으로든 끝났고, 모델 턴은 하나도 처리하지 않았다
    const [log] = state.fake.logs();
    expect(log!.stdinClosed || log!.signals.includes('SIGTERM')).toBe(true);
    expect(log!.tools).toEqual([]);
  });

  it('도구 서버가 연결됐다고 확인하지 못하면(목록에 없음·needs-auth·pending·disabled·init 없음) 통과로 끝내지 않는다', async () => {
    const cases: Array<{ label: string; invocation: Record<string, unknown> }> = [
      { label: '목록이 빔', invocation: { initExtra: { mcp_servers: [] } } },
      { label: '다른 서버만', invocation: { initExtra: { mcp_servers: [{ name: 'other', status: 'connected' }] } } },
      { label: 'mcp_servers가 null', invocation: { initExtra: { mcp_servers: null } } },
      { label: 'needs-auth', invocation: { initExtra: { mcp_servers: [{ name: 'b-studio', status: 'needs-auth' }] } } },
      { label: 'pending', invocation: { initExtra: { mcp_servers: [{ name: 'b-studio', status: 'pending' }] } } },
      { label: 'disabled', invocation: { initExtra: { mcp_servers: [{ name: 'b-studio', status: 'disabled' }] } } },
      { label: 'init 없음', invocation: { noInit: true } },
    ];
    for (const { label, invocation } of cases) {
      const { cli } = fakeClaudeCode({ turns: [[{ text: '도구 없이 끝냈습니다.' }]], invocations: [invocation] });
      const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox: fakeSandbox(project, [true]), ...cli, fetcher: async () => contract, stop: { termAfterMs: 20, killAfterMs: 20 } });
      expect(result.status, label).toBe('failed');
      expect(result.summary, label).toContain('도구 서버');
    }
  });

  it('ask_user로 되묻고 멈출 때는 입력을 닫아 CLI가 스스로 끝나게 하고, 세션 id를 남긴다', async () => {
    const { cli, state } = fakeClaudeCode({ turns: [[{ tool: 'ask_user', input: { question: '어떤 형태?', options: ['표', '카드'], allowOther: false } }]] });

    const result = await runClaudeCodeAgent({ request: '화면 만들어줘', project, sandbox: fakeSandbox(project, []), ...cli, interactive: true, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'awaiting_input', sessionId: FAKE_NEW_SESSION });
    const [log] = state.fake.logs();
    expect(log!.stdinClosed).toBe(true);
    // 결과를 이미 받았으므로 신호로 죽일 필요가 없다
    expect(log!.signals).toEqual([]);
  });

  it('입력을 닫아도 끝나지 않는 CLI는 SIGTERM, 그래도 안 끝나면 SIGKILL로 끝내고 실행은 결과를 돌려준다', async () => {
    const { cli, state } = fakeClaudeCode({
      turns: [[{ tool: 'ask_user', input: { question: '어떤 형태?', options: ['표', '카드'], allowOther: false } }]],
      invocations: [{ hangAfterEof: true, ignoreSigterm: true }],
    });

    const result = await runClaudeCodeAgent({
      request: '화면 만들어줘',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
      interactive: true,
      fetcher: async () => contract,
      stop: { termAfterMs: 30, killAfterMs: 30 },
    });

    expect(result).toMatchObject({ status: 'awaiting_input', sessionId: FAKE_NEW_SESSION });
    // SIGTERM을 무시했는데도 runner가 끝났다 = SIGKILL로 끝났다
    expect(state.fake.logs()[0]!.signals).toContain('SIGTERM');
  });

  it('턴 상한을 넘으면(진행 중인 턴) 바로 SIGTERM으로 끝내고, 그 뒤에 들어온 도구 호출은 실행하지 않는다', async () => {
    // SIGTERM을 무시하고 턴을 이어 가는 CLI: 신호가 가도 이미 보낸 요청이 더 도착하는 상황
    const { cli, state } = fakeClaudeCode({
      turns: [
        [
          { tool: 'read_file', input: { path: 'api/src/Order.java' } },
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } },
          { tool: 'read_file', input: { path: 'api/src/Order.java' } },
          // 상한을 넘겨 끝내는 중(마지막 검증이 도는 동안)에 도착하는 쓰기
          { tool: 'write_file', delay: 150, input: { path: 'api/src/Late.java', content: 'class Late {}' } },
        ],
      ],
      invocations: [{ ignoreSigterm: true }],
    });
    // 마지막 검증(재시작)이 느려 그 사이에 늦은 도구 호출이 닿는다
    const sandbox = fakeSandbox(project, [true]);
    const restart = sandbox.restart.bind(sandbox);
    sandbox.restart = async (service) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return restart(service);
    };

    const result = await runClaudeCodeAgent({
      request: '고쳐줘',
      project,
      sandbox,
      ...cli,
      fetcher: async () => contract,
      maxTurns: 2,
      stop: { termAfterMs: 0, killAfterMs: 500 },
    });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('최대 턴 수(2)를 넘었습니다');
    // 끝난 뒤에 도착한 쓰기는 실행하지 않았다
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
    const [log] = state.fake.logs();
    expect(log!.signals).toContain('SIGTERM');
    expect(log!.tools.filter((tool) => tool.name === 'write_file').every((tool) => tool.isError === true || tool.error !== null)).toBe(true);
  });

  it('프로세스를 다시 띄워도 사용량은 모델별로 더해 남기고, 승격 전 값을 잃지 않는다', async () => {
    // 서로 다른 모델의 modelUsage가 프로세스마다 온다. 같은 프로세스의 누적값은 덮어쓴다
    const { cli } = fakeClaudeCode({
      turns: [[{ text: '1' }], [{ text: '2' }]],
      modelUsages: [
        { haiku: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 1 } },
        { sonnet: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      ],
    });

    const result = await runClaudeCodeAgent({
      request: '설명해줘',
      project,
      sandbox: fakeSandbox(project, [false, true]),
      ...cli,
      model: 'haiku',
      fetcher: async () => contract,
    });

    // 질문이 아니라 만들기 요청이고 변경이 없으므로 게이트는 검증할 것 없이 통과한다. 첫 프로세스의 값 그대로다
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 });
    expect(result.metrics?.usageByModel).toEqual({ haiku: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 } });
  });
});

describe('preflightClaudeCode (claude auth status)', () => {
  it('로그인한 계정이면 이메일 없이 인증 정보만 돌려준다', async () => {
    const fake = fakeClaudeCli({ auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'Claude Max', email: 'someone@example.com', orgName: 'Acme' } });

    const preflight = await preflightClaudeCode({ ...fake.cli });

    expect(preflight).toEqual({ ok: true, account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty', apiKeySource: undefined } });
    expect(JSON.stringify(preflight)).not.toContain('someone@example.com');
    // 프롬프트를 보내지 않는다: 인증 상태 명령만 부른다
    expect(fake.authLog().args).toEqual(['auth', 'status']);
    expect(fake.logs()).toEqual([]);
    expect(describeAccount({ apiKeySource: 'ANTHROPIC_API_KEY' })).toBe('API 키 (ANTHROPIC_API_KEY)');
  });

  it('API 키로 로그인했으면 그 방식을 계정 표시에 남긴다', async () => {
    const fake = fakeClaudeCli({ auth: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' } });
    const preflight = await preflightClaudeCode({ ...fake.cli });
    expect(preflight).toEqual({ ok: true, account: { subscriptionType: undefined, apiProvider: 'firstParty', apiKeySource: 'api_key' } });
  });

  it('넘긴 환경(계정의 CLAUDE_CONFIG_DIR)으로 CLI를 띄운다(#885)', async () => {
    const fake = fakeClaudeCli();
    await preflightClaudeCode({ ...fake.cli, env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/home/kim/.claude-2' } });
    expect(fake.authLog().env.CLAUDE_CONFIG_DIR).toBe('/home/kim/.claude-2');
  });

  it('로그인하지 않았으면(종료 코드 1, loggedIn false) 로그인을 안내한다', async () => {
    const fake = fakeClaudeCli({ auth: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' } });
    const preflight = await preflightClaudeCode({ ...fake.cli });
    expect(preflight).toMatchObject({ ok: false, reason: expect.stringContaining('/login') });
  });

  it('출력을 읽을 수 없으면 로그인된 것으로 보지 않는다', async () => {
    const preflight = await preflightClaudeCode({ command: process.execPath, commandArgs: ['-e', "console.log('not json')"] });
    expect(preflight).toMatchObject({ ok: false, reason: expect.stringContaining('로컬 Claude Code를 실행하지 못했습니다') });
  });

  it('실행 파일이 없으면 실패로 알린다', async () => {
    const preflight = await preflightClaudeCode({ command: path.join(project.root, 'no-such-claude') });
    expect(preflight).toMatchObject({ ok: false, reason: expect.stringContaining('ENOENT') });
  });

  it('제한 시간 안에 응답하지 않으면 실패로 알리고 프로세스를 끝낸다', async () => {
    const fake = fakeClaudeCli({ authHang: true });
    const preflight = await preflightClaudeCode({ ...fake.cli, timeoutMs: 200 });
    expect(preflight).toMatchObject({ ok: false, reason: expect.stringContaining('초 안에 응답하지 않았습니다') });
  });
});

describe('fetchClaudeCodeModels', () => {
  it('공개 CLI 입출력에는 모델 목록을 묻는 방법이 없어 실패로 알린다(화면은 알려진 표로 되돌아간다)', async () => {
    const fake = fakeClaudeCli();
    await expect(fetchClaudeCodeModels({ ...fake.cli })).rejects.toThrow('모델 목록');
    // 프로세스를 띄우지도, 프롬프트를 보내지도 않는다
    expect(fake.logs()).toEqual([]);
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
    const { cli, state } = fakeClaudeCode({
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
      ...cli,
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
    const { cli, state } = fakeClaudeCode({
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
      ...cli,
      model: 'haiku',
      escalation: { to: 'sonnet', sameSignatureTimes: 2 },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', sessionId: FAKE_FORKED_SESSION, verifyAttempts: 2 });
    // 두 번째 query는 첫 query가 만든 세션을 이어받고 모델만 바뀐다
    expect(state.options).toMatchObject({ model: 'sonnet', resume: FAKE_NEW_SESSION, forkSession: true });
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
    const { cli, state } = fakeClaudeCode({ turns: [write(1), write(2), write(3), [{ text: '승격 뒤 고쳤습니다.' }]] });
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '주문에 메모 필드 추가',
      project,
      // 기본 상한(3)을 넘긴 지점에서 승격하므로, 예산이 없으면 이어 가지 못한다
      sandbox: fakeSandbox(project, [false, false, false, true]),
      ...cli,
      model: 'haiku',
      // 서명 규칙은 사실상 끄고 실패 횟수 규칙만 본다
      escalation: { to: 'sonnet', sameSignatureTimes: 99, afterFailures: 3, retryBudget: 2 },
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', verifyAttempts: 3 });
    expect(result.metrics?.escalatedAt).toBe(3);
    // 승격 뒤 query는 같은 세션을 이어받고 모델만 바뀐다(네 번째 시도가 승격 모델로 돌았다)
    expect(state.options).toMatchObject({ model: 'sonnet', resume: FAKE_NEW_SESSION, forkSession: true });
    const escalated = events.filter((event): event is Extract<AgentEvent, { type: 'model_escalated' }> => event.type === 'model_escalated');
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({ from: 'haiku', to: 'sonnet', attempt: 3 });
    // 상한이 소진된 뒤의 승격이라 마지막 실패 안내를 다시 보낸다
    expect(state.prompts.at(-1)).toContain('직전 검증 결과를 다시 보냅니다');
  });

  it('escalation을 주지 않으면 게이트가 반복 실패해도 query를 다시 열지 않는다', async () => {
    const { cli, state } = fakeClaudeCode({
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
      ...cli,
      model: 'haiku',
      fetcher: async () => contract,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: 'done', sessionId: FAKE_NEW_SESSION });
    expect(state.options).toMatchObject({ model: 'haiku' });
    expect(state.options?.resume).toBeUndefined();
    expect(events.some((event) => event.type === 'model_escalated')).toBe(false);
  });

  it('승격 뒤에 보낸 지시는 새 query의 입력 큐로 들어간다', async () => {
    const { cli, state } = fakeClaudeCode({
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
      ...cli,
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
    const { cli } = fakeClaudeCode({
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
      ...cli,
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
    const { cli, state } = fakeClaudeCode({
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
      ...cli,
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
    const { cli } = fakeClaudeCode({ turns: [[{ text: '주문 API입니다.' }]] });
    const queue = fakeSteering();
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '설명해줘',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
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
    const { cli } = fakeClaudeCode({ turns: [[{ tool: 'read_file', input: { path: 'api/src/Order.java' } }, { text: '읽었습니다.' }]] });
    let boots = 0;
    let fetches = 0;

    const result = await runClaudeCodeAgent({
      request: '읽고 설명해줘',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
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
    const { cli } = fakeClaudeCode({ turns: [[{ tool: 'write_file', input: { path: 'api/src/New.java', content: 'class New {}' } }, { text: '추가했습니다.' }]] });
    let boots = 0;
    let fetches = 0;
    const events: AgentEvent[] = [];

    const result = await runClaudeCodeAgent({
      request: '새 클래스 추가',
      project,
      sandbox: fakeSandbox(project, [true]),
      ...cli,
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
    const { cli } = fakeClaudeCode({ turns: [[{ tool: 'read_file', input: { path: 'api/src/Order.java' } }, { text: '읽었습니다.' }]] });
    let fetches = 0;

    const result = await runClaudeCodeAgent({
      request: '읽어줘',
      project,
      sandbox: fakeSandbox(project, []),
      ...cli,
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
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '읽었습니다.' }]] });

    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract });

    expect(promptOf(state.options)).toContain('[b-studio project guide: AGENTS.md]');
    expect(promptOf(state.options)).toContain('scripts/web-test.sh');
    expect(result.metrics!.guideChars).toBe('## 스크립트\n- pnpm test 대신 scripts/web-test.sh를 실행\n'.length);
  });

  it('AGENTS.md가 없으면 systemPrompt에 절을 더하지 않는다', async () => {
    const { cli, state } = fakeClaudeCode({ turns: [[{ text: '읽었습니다.' }]] });

    const result = await runClaudeCodeAgent({ request: '설명해줘', project, sandbox: fakeSandbox(project, []), ...cli, fetcher: async () => contract });

    expect(promptOf(state.options)).not.toContain('[b-studio project guide');
    expect(result.metrics!.guideChars).toBeUndefined();
  });
});

describe('runClaudeCodeAgent 턴 상한에 걸리면 되돌리기 전에 게이트를 한 번 더 본다(ADR-131)', () => {
  it('Claude Code 자신이 턴 상한(error_max_turns)으로 끝냈어도 지금까지의 변경이 게이트를 통과하면 done으로 남긴다', async () => {
    const { cli } = fakeClaudeCode({
      turns: [[{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }]],
      result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
    });
    const sandbox = fakeSandbox(project, [true]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, ...cli, fetcher: async () => contract });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('최대 턴 수(60)를 넘었습니다');
    expect(result.summary).toContain('검증 게이트를 통과해');
    expect(result.failureReason).toBeUndefined();
    expect(result.incomplete).toBe('max_turns');
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
    expect(sandbox.restarts).toEqual(['api']);
  });

  it('턴 상한(error_max_turns)에 걸렸는데 지금까지의 변경이 게이트를 통과하지 못하면 실패로 끝내 되돌리기 경로를 타게 한다', async () => {
    const { cli } = fakeClaudeCode({
      turns: [[{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String broken;' } }]],
      result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
    });
    // 재시작이 실패로 와서(false) 게이트가 통과하지 못한다
    const sandbox = fakeSandbox(project, [false]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, ...cli, fetcher: async () => contract });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('max_turns');
    expect(result.summary).toBe('최대 턴 수(60)를 넘었습니다');
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
  });

  it('CLI가 턴 상한 결과를 낸 뒤 0이 아닌 종료 코드로 끝나도, 게이트를 통과한 변경은 done으로 남긴다 (트러블슈팅 131)', async () => {
    // 진짜 CLI는 error_max_turns 결과를 낸 뒤 0이 아닌 종료 코드로 끝난다. 결과가 이미 있으면 그 종료 코드를 오류로 던지면 안 된다.
    // 던지면 세션이 실행을 오류로 끝내고 변경을 되돌린다
    const { cli } = fakeClaudeCode({
      turns: [[{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }]],
      result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
      exitAfterResult: { code: 1, stderr: 'Error: Reached maximum number of turns (60)' },
    });
    const sandbox = fakeSandbox(project, [true]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, ...cli, fetcher: async () => contract });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('검증 게이트를 통과해 체크포인트로 남깁니다');
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
  });

  it('CLI가 턴 상한 결과를 낸 뒤 0이 아닌 종료 코드로 끝나도, 게이트를 통과하지 못했으면 실패(max_turns)로 끝난다', async () => {
    const { cli } = fakeClaudeCode({
      turns: [[{ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String broken;' } }]],
      result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
      exitAfterResult: { code: 1, stderr: 'Error: Reached maximum number of turns (60)' },
    });
    const sandbox = fakeSandbox(project, [false]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, ...cli, fetcher: async () => contract });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('max_turns');
    expect(result.summary).toBe('최대 턴 수(60)를 넘었습니다');
  });

  it('결과를 받기 전에 난 예외는 그대로 던진다(삼키지 않는다)', async () => {
    const { cli } = fakeClaudeCode({ turns: [] });
    await expect(runClaudeCodeAgent({ request: '고쳐줘', project, sandbox: fakeSandbox(project, [true]), ...cli, fetcher: async () => contract })).rejects.toThrow('스크립트에 남은 턴이 없습니다');
  });

  it('러너 자신의 턴 카운터가 상한을 넘겨도(assistant 메시지 수 기준) 같은 방식으로 게이트를 한 번 더 본다', async () => {
    // 한 번의 사용자 턴 안에서 도구 호출 3번(메시지 3개)을 내 maxTurns=2를 넘긴다 — Claude Code 쪽 error_max_turns 없이
    // 러너 자신의 messageIds 카운터만으로 걸리는 경로를 재현한다
    const { cli } = fakeClaudeCode({
      turns: [
        [
          { tool: 'read_file', input: { path: 'api/src/Order.java' } },
          { tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } },
          { tool: 'read_file', input: { path: 'api/src/Order.java' } },
        ],
      ],
    });
    const sandbox = fakeSandbox(project, [true]);

    const result = await runClaudeCodeAgent({ request: '고쳐줘', project, sandbox, ...cli, fetcher: async () => contract, maxTurns: 2 });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('최대 턴 수(2)를 넘었습니다');
    expect(result.incomplete).toBe('max_turns');
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
  });
});
