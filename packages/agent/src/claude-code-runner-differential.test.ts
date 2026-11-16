import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runClaudeCodeAgent, type ClaudeCodeResult, type ClaudeCodeRunOptions } from './claude-code-runner';
import { runClaudeCodeAgentLegacy } from './claude-code-runner-loop-legacy';
import { Gen, readEnvNumber } from './differential-kit';
import { fakeClaudeCli, type FakeCliScenario, type FakeInvocation, type FakeStep } from './fake-claude-cli';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, fakeSteering, ORDERS_CONTRACT as contract } from './test-helpers';

/**
 * 지원 러너의 메시지 루프와 실행 상태를 Rust로 옮기면서(ADR-202, 4f A8b), 같은 가짜 CLI 시나리오·같은 가짜 샌드박스로 옛 루프
 * (`claude-code-runner-loop-legacy.ts`: TS 변수·`serialQueue`·`spawnClaudeCli`)와 새 루프(Rust 러너 코어)를 돌려 이벤트 목록·결과·오류·가짜 CLI가 받은 것을 견준다.
 * 시간 지표(`toolMs`·`gateMs`와 검증 보고서의 걸린 시간)는 뺀다. `modelMs`는 가짜 CLI가 `duration_api_ms`로 주는 값이므로 견준다.
 */

type Impl = (options: ClaudeCodeRunOptions) => Promise<ClaudeCodeResult>;

interface Ctx {
  queue: ReturnType<typeof fakeSteering>;
  controller: AbortController;
  /** 지금까지 받은 이벤트 */
  events: AgentEvent[];
}

interface Case {
  name: string;
  turns?: FakeStep[][];
  result?: Record<string, unknown>;
  modelUsages?: FakeCliScenario['modelUsages'];
  apiDurations?: number[];
  invocations?: FakeInvocation[];
  exitAfterResult?: { code: number; stderr: string };
  noResult?: boolean;
  /** 가짜 샌드박스의 재시작 결과(false면 게이트 실패) */
  restarts?: boolean[];
  /** 요청마다 새로 만드는 옵션 덮어쓰기 */
  options?: (ctx: Ctx) => Partial<ClaudeCodeRunOptions>;
  /** 이벤트마다 부르는 시험용 계기(지시 넣기·취소 등) */
  onEvent?: (event: AgentEvent, ctx: Ctx) => void;
  /** 실행을 시작하고 이만큼 뒤에 취소한다(ms) */
  abortAfterMs?: number;
  /** 가짜 샌드박스의 재시작(게이트의 확인)이 걸리는 시간(ms). 기본은 곧바로 끝난다 */
  gateDelayMs?: number;
  /** 가짜 CLI가 받은 도구 응답의 기록을 견주지 않는다. 취소(SIGTERM)와 응답이 CLI에 닿는 순서의 경쟁이라 시각에 따라 갈린다(트러블슈팅 216) */
  skipToolLog?: boolean;
  /**
   * 취소를 건 이벤트 뒤의 이벤트를 견주지 않는다. 옛 루프는 취소 신호 뒤에도 이미 읽어 둔 줄을 계속 읽었고(턴·게이트 시작 이벤트), Rust 코어는 취소한 뒤의 줄을 버린다
   * (트러블슈팅 216). 어디까지 읽었는지는 SIGTERM이 CLI에 닿는 시각에 달려 있어 견줄 수 없다
   */
  untilAbort?: boolean;
}

const SCRUB_KEYS = new Set(['toolMs', 'gateMs', 'elapsedMs', 'ms', 'durationMs', 'startedAt', 'at']);

/** 시간 지표를 뺀 값(깊게). 같은 꼴로 견주려고 JSON을 한 번 거친다 */
function scrub(value: unknown, root: string): unknown {
  const text = JSON.stringify(value, (key, item) => (SCRUB_KEYS.has(key) ? undefined : item)) ?? 'null';
  return JSON.parse(text.split(root).join('<root>'));
}

interface Observed {
  outcome: { result: unknown } | { error: { name: string; message: string } };
  events: unknown[];
  prompts: string[];
  tools: unknown[];
  argv: string[][];
  spawns: number;
}

/** 재시작이 이만큼 걸리는 가짜 샌드박스(게이트가 느린 환경을 흉내 낸다) */
function slowGate<T extends { restart: (service: string) => Promise<unknown> }>(sandbox: T, ms: number): T {
  if (ms <= 0) return sandbox;
  const restart = sandbox.restart.bind(sandbox);
  sandbox.restart = async (service) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return restart(service);
  };
  return sandbox;
}

async function observe(impl: Impl, c: Case): Promise<Observed> {
  const project = await createOrdersProject('claude-code-diff-');
  const fake = fakeClaudeCli({
    turns: c.turns ?? [],
    result: c.result ?? {},
    modelUsages: c.modelUsages ?? [],
    apiDurations: c.apiDurations ?? [],
    ...(c.invocations ? { invocations: c.invocations } : {}),
    ...(c.noResult ? { noResult: true } : {}),
    ...(c.exitAfterResult ? { exitCodeAfterResult: c.exitAfterResult.code, stderrAfterResult: c.exitAfterResult.stderr } : {}),
  });
  const events: AgentEvent[] = [];
  /** 취소가 처음 보인 시점까지 받은 이벤트 수 */
  let abortedAt: number | undefined;
  const ctx: Ctx = { queue: fakeSteering(), controller: new AbortController(), events };
  const waits: number[] = [];
  const options: ClaudeCodeRunOptions = {
    request: '고쳐줘',
    project,
    sandbox: slowGate(fakeSandbox(project, [...(c.restarts ?? [true, true, true, true])]), c.gateDelayMs ?? 0),
    ...fake.cli,
    fetcher: async () => contract,
    signal: ctx.controller.signal,
    stop: { termAfterMs: 1_500, killAfterMs: 500 },
    // 시간을 흐르게 하지 않는다
    networkRetry: { wait: async (ms) => void waits.push(ms), maxAttempts: 2, maxWaitMs: 60_000, baseDelayMs: 1_000 },
    onEvent: (event) => {
      events.push(event);
      c.onEvent?.(event, ctx);
      if (abortedAt === undefined && ctx.controller.signal.aborted) abortedAt = events.length;
    },
    ...(c.options?.(ctx) ?? {}),
  };
  if (c.abortAfterMs !== undefined) setTimeout(() => ctx.controller.abort(new DOMException('요청을 취소했습니다', 'AbortError')), c.abortAfterMs);
  let outcome: Observed['outcome'];
  try {
    outcome = { result: scrub(await impl(options), project.root) };
  } catch (error) {
    outcome = { error: { name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) } };
  }
  const logs = fake.logs();
  return {
    outcome,
    events: scrub(c.untilAbort && abortedAt !== undefined ? events.slice(0, abortedAt) : events, project.root) as unknown[],
    prompts: fake.prompts(),
    // 닫힌 뒤 거절된 요청의 응답은 가짜 CLI가 SIGTERM으로 죽기 전에 기록했는지가 경쟁이라 견주지 않는다(거절됐다는 사실은 `tool_call` 이벤트가 없다는 것과 파일이 그대로라는 것으로 본다)
    tools: c.skipToolLog ? [] : logs.flatMap((log) => log.tools.filter((tool) => !(tool.isError === true && tool.text.includes('이미 끝나 도구를 쓸 수 없습니다'))).map((tool) => ({ call: log.call, name: tool.name, input: tool.input, isError: tool.isError, error: tool.error, text: tool.text, images: tool.images }))),
    // 임시 파일 경로(MCP 설정·지시문)와 프로세스마다 다른 값은 자리 표시로 바꾼다
    argv: logs.map((log) => log.args.map((arg, at) => (['--mcp-config', '--system-prompt-file'].includes(log.args[at - 1] ?? '') ? '<file>' : arg))),
    spawns: logs.length,
  };
}

async function compare(c: Case): Promise<void> {
  const legacy = await observe(runClaudeCodeAgentLegacy, c);
  const current = await observe(runClaudeCodeAgent, c);
  expect(current).toEqual(legacy);
}

const edit = (to: string): FakeStep => ({ tool: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: to } });
const read: FakeStep = { tool: 'read_file', input: { path: 'api/src/Order.java' } };
const write = (name: string, n = 0): FakeStep => ({ tool: 'write_file', input: { path: `api/src/${name}.java`, content: `class ${name} { /* ${n} */ }\n` } });
const UUID = '11111111-1111-4111-8111-111111111111';
const NETWORK = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";

/**
 * 승격 순간의 지시(트러블슈팅 212). 지시는 `verify_start`와 `model_escalated`마다 들어간다. `verify_start`의 지시는 승격 전 프로세스의 입력에 쓰여
 * 그 프로세스가 곧바로 모델 턴을 하나 더 소비하고, 승격 뒤 프로세스도 지시마다 턴을 소비한다. 가짜 CLI는 턴이 떨어지면 종료 코드 1로 죽는데,
 * 그 시각과 러너가 다음 줄(게이트 실패 안내)을 쓰는 시각이 경주하면 가짜 CLI의 기록에 안내가 한 번 더 남거나 남지 않는다(러너의 동작이 아니라 기록의 경합).
 * 남는 턴을 넉넉히 줘 가짜 CLI가 죽지 않게 하면 러너가 쓴 줄이 모두 기록되어 게이트 시간과 무관하게 같다.
 */
function escalationSteerCase(name: string, extra: Partial<Case>, spareTurns = 4): Case {
  return {
    name,
    turns: [[write('Order', 1), { text: '1' }], [write('Order', 2), { text: '2' }], [{ text: '3' }], ...Array.from({ length: spareTurns }, () => [{ text: '여분' }])],
    restarts: [false, false, true],
    options: (ctx) => ({ model: 'haiku', escalation: { to: 'sonnet', sameSignatureTimes: 1 }, steering: ctx.queue.steering }),
    onEvent: (event, ctx) => {
      if (event.type === 'verify_start' || event.type === 'model_escalated') ctx.queue.push('승격 순간의 지시');
    },
    ...extra,
  };
}

const NAMED: Case[] = [
  { name: '통과(읽기만)', turns: [[read, { text: '읽었습니다.' }]] },
  { name: '통과(파일 수정 + 게이트 통과)', turns: [[edit('customerName;'), { text: '고쳤습니다.' }]], restarts: [true] },
  {
    name: '게이트 실패 뒤 통과',
    turns: [[edit('customerNam; String memo;'), { text: '메모 필드를 추가했습니다.' }], [edit('customerName;'), { text: '컴파일 에러를 고쳤습니다.' }]],
    restarts: [false, true],
  },
  {
    name: '게이트 소진',
    turns: [[write('A', 1), { text: '1' }], [write('A', 2), { text: '2' }], [write('A', 3), { text: '3' }]],
    restarts: [false, false, false],
    options: () => ({ maxVerifyAttempts: 3 }),
  },
  {
    name: '턴 상한: 러너 카운터(게이트 통과)',
    turns: [[read, edit('customerName;'), read]],
    restarts: [true],
    options: () => ({ maxTurns: 2 }),
  },
  {
    name: '턴 상한: 러너 카운터(게이트 실패)',
    turns: [[read, edit('customerNam; String broken;'), read]],
    restarts: [false],
    options: () => ({ maxTurns: 2 }),
  },
  {
    name: '턴 상한: error_max_turns(통과)',
    turns: [[edit('customerName;')]],
    result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
    restarts: [true],
  },
  {
    name: '턴 상한: error_max_turns(실패, 종료 코드 1)',
    turns: [[edit('customerNam; String broken;')]],
    result: { subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (60)'] },
    exitAfterResult: { code: 1, stderr: 'Error: Reached maximum number of turns (60)' },
    restarts: [false],
  },
  {
    name: '턴 상한 정확히 같음(넘지 않음)',
    turns: [[read, { text: '끝' }]],
    options: () => ({ maxTurns: 2 }),
  },
  {
    name: '턴 상한: 요청이 메시지보다 먼저 와도 실행하지 않는다',
    turns: [[read, { ...edit('customerName;'), callFirst: 150 }]],
    restarts: [true],
    options: () => ({ maxTurns: 1 }),
  },
  {
    name: '턴 상한 뒤 늦게 도착하는 쓰기',
    turns: [[read, edit('customerName;'), read, { tool: 'write_file', delay: 150, input: { path: 'api/src/Late.java', content: 'class Late {}' } }]],
    invocations: [{ ignoreSigterm: true }],
    restarts: [true],
    options: () => ({ maxTurns: 2, stop: { termAfterMs: 0, killAfterMs: 500 } }),
  },
  {
    name: '되묻기(변경 없음)',
    turns: [[{ tool: 'ask_user', input: { question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: true } }]],
    options: () => ({ interactive: true }),
  },
  {
    name: '되묻기(변경 있음, 게이트 통과)',
    turns: [[edit('customerName;'), { tool: 'ask_user', input: { question: '계속할까요?', options: ['예', '아니오'], allowOther: false } }]],
    restarts: [true],
    options: () => ({ interactive: true }),
  },
  {
    name: '되묻기(변경 있음, 게이트 실패)',
    turns: [[edit('customerNam; String broken;'), { tool: 'ask_user', input: { question: '계속할까요?', options: ['예', '아니오'], allowOther: false } }]],
    restarts: [false],
    options: () => ({ interactive: true }),
  },
  {
    name: '승격(서명 반복, retry)',
    turns: [[edit('customerNam; String memo;'), { text: '1' }], [edit('customerName;'), { text: '2' }], [{ text: '3' }]],
    restarts: [false, false, true],
    options: () => ({ model: 'haiku', escalation: { to: 'sonnet', sameSignatureTimes: 2 } }),
  },
  {
    name: '승격(소진 뒤, afterFailures·예산)',
    turns: [[write('Order', 1), { text: '1' }], [write('Order', 2), { text: '2' }], [write('Order', 3), { text: '3' }], [{ text: '승격 뒤 고쳤습니다.' }]],
    restarts: [false, false, false, true],
    options: () => ({ model: 'haiku', escalation: { to: 'sonnet', sameSignatureTimes: 99, afterFailures: 3, retryBudget: 2 } }),
  },
  {
    name: '승격 한 번만(두 번째 계기는 무시)',
    turns: [[write('Order', 1), { text: '1' }], [write('Order', 2), { text: '2' }], [write('Order', 3), { text: '3' }], [write('Order', 4), { text: '4' }], [write('Order', 5), { text: '5' }]],
    restarts: [false, false, false, false, false],
    options: () => ({ maxVerifyAttempts: 5, model: 'haiku', escalation: { to: 'sonnet', sameSignatureTimes: 1, afterFailures: 1, retryBudget: 1 } }),
  },
  {
    name: '승격 없음(escalation 미지정)',
    turns: [[edit('customerNam; String memo;'), { text: '1' }], [edit('customerName;'), { text: '2' }]],
    restarts: [false, true],
    options: () => ({ model: 'haiku' }),
  },
  {
    name: '네트워크 재시도 성공',
    turns: [[{ text: '이어서 완료했습니다.' }]],
    apiDurations: [2_500],
    invocations: [{ sessionId: UUID, failFirst: NETWORK, failApiMs: 1_000 }, { sessionId: UUID }],
  },
  {
    name: '네트워크 재시도 상한',
    turns: [[], [], []],
    result: { is_error: true, result: 'ENOTFOUND api.anthropic.com' },
  },
  {
    name: '네트워크 재시도: 세션 없이 첫 호출이 끊김',
    turns: [[{ text: '완료' }]],
    invocations: [{ noInit: true, failFirst: NETWORK }, {}],
    options: () => ({ resume: UUID }),
  },
  {
    name: '네트워크 재시도 중 취소',
    turns: [[]],
    result: { is_error: true, result: 'ENOTFOUND registry.npmjs.org' },
    options: (ctx) => ({
      networkRetry: {
        maxAttempts: 3,
        wait: async () => {
          ctx.controller.abort(new DOMException('요청을 취소했습니다', 'AbortError'));
        },
      },
    }),
  },
  { name: '영구 오류는 재시도하지 않는다', turns: [[{ text: '1' }]], result: { is_error: true, result: '401 unauthorized' } },
  { name: '비용 한도', turns: [[{ text: '1' }]], result: { subtype: 'error_max_budget_usd', is_error: true, errors: [] } },
  { name: '실행 오류 목록', turns: [[{ text: '1' }]], result: { subtype: 'error_during_execution', is_error: true, errors: ['도구 오류', '두 번째'] } },
  { name: '거절', turns: [[{ text: '1' }]], result: { stop_reason: 'refusal' } },
  { name: 'init 없음', turns: [[{ text: '도구 없이 끝냈습니다.' }]], invocations: [{ noInit: true }], options: () => ({ stop: { termAfterMs: 20, killAfterMs: 20 } }) },
  {
    name: '도구 서버 연결 실패',
    turns: [[{ text: '도구 없이 끝냈습니다.' }]],
    invocations: [{ initExtra: { mcp_servers: [{ name: 'b-studio', status: 'failed' }], mcp_server_errors: [{ name: 'b-studio', type: 'invalid_config', message: 'x' }] } }],
    options: () => ({ stop: { termAfterMs: 20, killAfterMs: 20 } }),
  },
  {
    name: '도구 서버 목록에 없음',
    turns: [[{ text: '도구 없이 끝냈습니다.' }]],
    invocations: [{ initExtra: { mcp_servers: [] } }],
    options: () => ({ stop: { termAfterMs: 20, killAfterMs: 20 } }),
  },
  { name: '결과 없이 끝남(noResult)', turns: [[{ text: '모델은 끝냈지만' }]], noResult: true },
  { name: '결과 없이 끝남(종료 코드와 표준 오류)', turns: [], invocations: [{ exitWithoutResult: 3, stderr: '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄' }] },
  { name: '남은 턴이 없음', turns: [] },
  { name: '실행 파일을 띄우지 못함', turns: [[]], options: () => ({ command: path.join('/nonexistent-dir-for-diff', 'no-such-claude') }) },
  {
    name: '요약 상태(compacting 두 번, compact_boundary)',
    turns: [[{ text: '요약 뒤 응답' }]],
    invocations: [
      {
        pre: [
          { type: 'system', subtype: 'status', status: 'compacting' },
          { type: 'system', subtype: 'status', status: 'compacting' },
          { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 190000, post_tokens: 20000, duration_ms: 1234 } },
          { type: 'system', subtype: 'status', status: 'compacting' },
          { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 5 } },
          { type: 'system', subtype: 'compact_boundary' },
          { type: 'system', subtype: 'compact_boundary', compact_metadata: 5 },
        ],
      },
    ],
  },
  {
    name: '하위 에이전트 메시지는 턴으로 세지 않는다',
    turns: [
      [
        { raw: { type: 'assistant', message: { id: 'sub1', content: [{ type: 'text', text: '하위' }] }, parent_tool_use_id: 'toolu_x', session_id: UUID } },
        { raw: { type: 'assistant', message: { id: 'sub2', content: [{ type: 'tool_use', id: 'toolu_s', name: 'mcp__b-studio__read_file', input: {} }] }, parent_tool_use_id: 'toolu_x', session_id: UUID } },
        { text: '본 대화' },
      ],
    ],
    options: () => ({ maxTurns: 1 }),
  },
  {
    name: '같은 메시지 id 반복',
    turns: [
      [
        { ...read, id: 'm1', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 5 } },
        { text: '읽었습니다.', id: 'm1', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 7 } },
        { text: '주문 API입니다.', id: 'm2', usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
      ],
    ],
  },
  {
    name: '사용량: 승격으로 프로세스 둘',
    turns: [[edit('customerNam; String memo;'), { text: '1' }], [edit('customerName;'), { text: '2' }], [{ text: '3' }]],
    restarts: [false, false, true],
    modelUsages: [
      { 'haiku-x': { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 } },
      { 'haiku-x': { inputTokens: 25, outputTokens: 4, cacheReadInputTokens: 6, cacheCreationInputTokens: 7 } },
      { 'sonnet-x': { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 0 } },
    ],
    apiDurations: [100, 250, 40],
    options: () => ({ model: 'haiku', escalation: { to: 'sonnet', sameSignatureTimes: 2 } }),
  },
  {
    name: '사용량: result 두 번(누적값)',
    turns: [[write('U', 1), { text: '1' }], [{ text: '2' }]],
    restarts: [false, true],
    modelUsages: [{ m: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, { m: { inputTokens: 30, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }],
    apiDurations: [3_333, 5_997],
  },
  {
    name: '진행 중 지시',
    turns: [[write('New'), { text: '추가했습니다.' }], [{ text: '반영했습니다.' }]],
    restarts: [true],
    options: (ctx) => ({ steering: ctx.queue.steering }),
    onEvent: (event, ctx) => {
      if (event.type === 'tool_result') ctx.queue.push('테스트도 추가해줘');
    },
  },
  {
    name: '진행 중 지시(게이트 피드백과 겹침)',
    turns: [[write('New'), { text: '추가했습니다.' }], [{ text: '지시를 반영했습니다.' }], [{ text: '게이트 피드백을 처리했습니다.' }]],
    restarts: [false, true],
    options: (ctx) => ({ steering: ctx.queue.steering }),
    onEvent: (event, ctx) => {
      if (event.type === 'tool_result') ctx.queue.push('테스트도 추가해줘');
    },
  },
  escalationSteerCase('진행 중 지시(승격 순간)', {}),
  escalationSteerCase('진행 중 지시(승격 순간, 느린 게이트)', { gateDelayMs: 600 }),
  { name: '취소: 첫 tool_result', turns: [[write('N'), read, { text: '추가했습니다.' }]], restarts: [true], skipToolLog: true, untilAbort: true, onEvent: (event, ctx) => event.type === 'tool_result' && ctx.controller.abort(new DOMException('요청을 취소했습니다', 'AbortError')) },
  { name: '취소: session 이벤트', turns: [[read, { text: '읽었습니다.' }]], skipToolLog: true, untilAbort: true, onEvent: (event, ctx) => event.type === 'session' && ctx.controller.abort(new DOMException('요청을 취소했습니다', 'AbortError')) },
  { name: '취소: 첫 turn 이벤트', turns: [[read, { text: '읽었습니다.' }]], skipToolLog: true, untilAbort: true, onEvent: (event, ctx) => event.type === 'turn' && ctx.controller.abort(new DOMException('요청을 취소했습니다', 'AbortError')) },
  { name: '취소: 멈춰 있는 CLI', turns: [[{ hang: true }]], abortAfterMs: 300 },
  { name: '취소: 이유가 오류가 아님', turns: [[{ hang: true }]], onEvent: (event, ctx) => event.type === 'session' && ctx.controller.abort('글자 이유') },
  { name: '트러블슈팅 206: callFirst', turns: [[{ ...read, callFirst: 150 }, { text: '읽었습니다.' }]] },
  { name: '트러블슈팅 206: callFirst(쓰기, 상한 안)', turns: [[{ ...edit('customerName;'), callFirst: 150 }, { text: '끝' }]], restarts: [true] },
  { name: '트러블슈팅 206: tool_use가 아닌 블록', turns: [[{ raw: { type: 'assistant', message: { id: 'm1', content: [{ type: 'server_tool_use', id: 'srv_1', name: 'mcp__b-studio__edit_file', input: {} }] }, parent_tool_use_id: null } }, { ...read, id: 'm1' }, { ...edit('customerName;'), callFirst: 150 }]], restarts: [true], options: () => ({ maxTurns: 1 }) },
  { name: '트러블슈팅 206: noMessage + 둘째 메시지가 상한을 넘김', turns: [[{ text: '첫 턴.' }, { ...edit('customerName;'), noMessage: true }, { text: '', delay: 300 }, { text: '둘째 턴.' }]], restarts: [true], options: () => ({ maxTurns: 1 }) },
  { name: '트러블슈팅 206: noMessage + 결과로 끝남', turns: [[{ text: '첫 턴.' }, { ...edit('customerName;'), noMessage: true }, { text: '', delay: 300 }]], restarts: [true] },
  {
    name: '결과를 만든 뒤 done 이벤트 처리가 던져도 판정을 지킨다(트러블슈팅 131)',
    turns: [[{ text: '끝' }]],
    onEvent: (event) => {
      if (event.type === 'done') throw new Error('이벤트 처리 실패');
    },
  },
  {
    name: '결과를 만든 뒤 failed 이벤트 처리가 던져도 판정을 지킨다',
    turns: [[{ text: '끝' }]],
    result: { is_error: true, result: 'boom' },
    onEvent: (event) => {
      if (event.type === 'failed') throw new Error('이벤트 처리 실패');
    },
  },
  {
    name: '결과를 받기 전 이벤트 처리가 던지면 그대로 던진다',
    turns: [[{ text: '끝' }]],
    onEvent: (event) => {
      if (event.type === 'turn') throw new Error('이벤트 처리 실패');
    },
  },
  { name: '질문 모드', turns: [[write('Q'), { text: '계획입니다.' }]], options: () => ({ intent: 'ask' }) },
  { name: '조사 모드', turns: [[{ text: '찾았습니다.' }]], options: () => ({ intent: 'ask', research: true }) },
  { name: '이어받기(유효한 UUID)', turns: [[{ text: '이어서' }]], options: () => ({ resume: UUID }), invocations: [{ sessionId: '22222222-2222-4222-8222-222222222222' }] },
  { name: '이어받기(UUID가 아님)', turns: [[{ text: '새 대화' }]], options: () => ({ resume: 'not-a-uuid' }) },
  { name: '이어받기(16진수와 줄표뿐이지만 UUID 꼴이 아님)', turns: [[{ text: '새 대화' }]], options: () => ({ resume: 'abcd-ef01-abcd' }) },
  { name: '이어받기(길이는 맞지만 줄표 자리가 어긋남)', turns: [[{ text: '새 대화' }]], options: () => ({ resume: '1111111111111-4111-8111-111111111111' }) },
  { name: '글자 그대로의 예약 글자(U+E010)가 든 줄', turns: [[{ text: '앞\ue010\ue000\ue000\ue000뒤' }, { text: '\ue011\ue001\ue000' }]] },
  { name: '세션 id가 결과 뒤에 바뀜', turns: [[{ text: '끝' }]], invocations: [{ pre: [] }], result: { session_id: '33333333-3333-4333-8333-333333333333' } },
  { name: '짝 없는 서로게이트가 든 글', turns: [[{ raw: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'A\\ud800B' }] }, session_id: UUID } }]], invocations: [{ pre: ['{"type":"assistant","message":{"id":"m0","content":[{"type":"text","text":"x\\ud800y"}]}}'] }] },
  { name: '이상한 줄(JSON 아님·배열·모르는 type)', turns: [[{ text: '끝.' }]], invocations: [{ pre: ['이건 JSON이 아닙니다', '[1,2]', '', '   ', '"문자열"', 'null', { type: 'future_message_type', payload: 1 }, { type: 'system', subtype: 'future_subtype' }] }] },
  {
    name: '이상한 assistant(id 없음·숫자·사용량 문자열)',
    turns: [[{ raw: { type: 'assistant', message: { content: [] } } }, { raw: { type: 'assistant', message: { id: 5, content: [], usage: { input_tokens: '7', output_tokens: null } } } }, { raw: { type: 'assistant', message: { id: 6, content: 'x', usage: { input_tokens: 1.5, cache_read_input_tokens: 2 } } } }, { text: '끝' }]],
  },
];

describe('claude-code 러너: 옛 루프와 Rust 러너 코어의 차등(ADR-202)', () => {
  for (const c of NAMED) {
    it(c.name, async () => {
      await compare(c);
    }, 60_000);
  }
});

describe('취소 뒤에는 도구도 메시지도 일을 하지 않는다(트러블슈팅 216)', () => {
  // SIGTERM을 무시하는 CLI는 취소 신호가 CLI에 가장 늦게 닿는 경우다(부하에서 SIGTERM이 늦는 것을 결정적으로 만든다). 취소는 첫 tool_result에서 건다.
  // 옛 루프는 이 경우 취소 뒤의 메시지(턴 2·3·4, 게이트 시작)를 그대로 읽었다. Rust 코어는 읽지 않는다
  const aborted: Case = {
    name: '취소 뒤 CLI가 계속 쓴다',
    turns: [[write('N'), write('M'), read, { text: '추가했습니다.' }]],
    restarts: [true],
    invocations: [{ ignoreSigterm: true }],
    onEvent: (event, ctx) => event.type === 'tool_result' && ctx.controller.abort(new DOMException('요청을 취소했습니다', 'AbortError')),
  };

  it('취소한 뒤 도착한 메시지는 턴·텍스트 이벤트를 내지 않고 게이트도 돌지 않는다. 결과 줄의 사용량만 센다', async () => {
    const current = await observe(runClaudeCodeAgent, aborted);
    expect(current.outcome).toEqual({ error: { name: 'AbortError', message: '요청을 취소했습니다' } });
    // 가짜 CLI의 result는 modelUsage에 입력 토큰 10 × 메시지 수(4)를 싣는다. 모델이 이미 쓴 토큰이라 한도에서 빠지면 안 된다
    expect(current.events.slice(4)).toEqual([{ type: 'tool_result', name: 'write_file', ok: true, content: 'wrote api/src/N.java', chars: 20, rawChars: 20 }, { type: 'tokens', usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 } }]);
  }, 60_000);

  it('취소한 뒤 도착한 결과 줄의 modelUsage를 읽지 못하면 던지지 않고 경고만 남긴다(취소는 AbortError로 끝난다)', async () => {
    const current = await observe(runClaudeCodeAgent, { ...aborted, result: { modelUsage: { 'test-model': null } } });
    expect(current.outcome).toEqual({ error: { name: 'AbortError', message: '요청을 취소했습니다' } });
    expect((current.events as Array<{ type: string }>).map((event) => event.type)).toEqual(['session', 'turn', 'tool_call', 'policy', 'tool_result', 'warning']);
  }, 60_000);

  it('취소한 뒤 도착한 도구 요청은 실행하지 않고 취소 이유로 거절한다', async () => {
    const current = await observe(runClaudeCodeAgent, aborted);
    const later = (current.tools as Array<{ name: string; input: { path?: string }; isError: boolean; text: string }>).slice(1);
    expect(later.map((tool) => [tool.name, tool.isError, tool.text])).toEqual([
      ['write_file', true, '요청을 취소했습니다'],
      ['read_file', true, '요청을 취소했습니다'],
    ]);
    // 취소 전의 첫 쓰기만 실행됐다(도구 이벤트도 하나뿐이다)
    expect((current.events as Array<{ type: string }>).filter((event) => event.type === 'tool_call')).toHaveLength(1);
  }, 60_000);
});

describe('승격 순간의 지시: 가짜 CLI의 기록이 게이트가 걸리는 시간과 무관하다(트러블슈팅 212)', () => {
  it('같은 러너를 게이트 지연만 바꿔 돌려도 프롬프트와 실행 횟수가 같다', async () => {
    const fast = await observe(runClaudeCodeAgent, escalationSteerCase('빠른 게이트', {}));
    const slow = await observe(runClaudeCodeAgent, escalationSteerCase('느린 게이트', { gateDelayMs: 600 }));
    expect(slow.prompts).toEqual(fast.prompts);
    expect(slow.spawns).toEqual(fast.spawns);
  }, 60_000);
});

// ── 시드 있는 무작위 시나리오 ──

function randomCase(seed: number): Case {
  const g = new Gen(seed);
  let written = 0;
  const step = (): FakeStep => {
    const usage = g.chance(0.5) ? { usage: { input_tokens: g.int(500), output_tokens: g.int(50), cache_read_input_tokens: g.int(3_000), cache_creation_input_tokens: g.int(20) } } : {};
    const id = g.chance(0.3) ? { id: g.pick(['m1', 'm2', 'm3']) } : {};
    return g.weighted<FakeStep>([
      [3, { ...read, ...usage, ...id }],
      [2, { text: g.pick(['', '  ', '끝났습니다.', '  앞뒤 공백  ', '둘째 줄\n셋째 줄']), ...usage, ...id }],
      [2, { ...write(`R${seed}x${written++}`, seed), ...usage, ...id }],
      [1, { ...edit(`customerNam; /* ${seed} */`), ...usage }],
      [1, { raw: { type: 'assistant', message: { id: `sub${g.int(3)}`, content: [{ type: 'text', text: '하위' }, { type: 'tool_use', id: `tu${g.int(9)}`, name: 'mcp__b-studio__read_file', input: {} }] }, parent_tool_use_id: 'toolu_p' } }],
    ]);
  };
  const turns = g.list(1, 4, () => g.list(0, 4, step));
  const failure = g.weighted<Record<string, unknown>>([
    [6, {}],
    [1, { is_error: true, result: 'boom' }],
    [1, { is_error: true, result: 'ENOTFOUND x' }],
    [1, { subtype: 'error_max_turns', is_error: true, errors: ['limit'] }],
    [1, { stop_reason: 'refusal' }],
    [1, { subtype: 'error_during_execution', is_error: true, errors: ['하나', '둘'] }],
  ]);
  const invocation = (): FakeInvocation => ({
    ...(g.chance(0.08) ? { noInit: true } : {}),
    ...(g.chance(0.08) ? { initExtra: { mcp_servers: [{ name: 'b-studio', status: g.pick(['failed', 'pending', 'needs-auth']) }] } } : {}),
    ...(g.chance(0.2) ? { pre: [{ type: 'system', subtype: 'status', status: 'compacting' }, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: g.int(9_000) } }] } : {}),
    ...(g.chance(0.15) ? { sessionId: UUID } : {}),
  });
  const escalate = g.chance(0.4);
  return {
    name: `seed ${seed}`,
    turns,
    result: failure,
    ...(g.chance(0.5) ? { modelUsages: g.list(1, 3, () => ({ [g.pick(['m-a', 'm-b'])]: { inputTokens: g.int(900), outputTokens: g.int(90), cacheReadInputTokens: g.int(90), cacheCreationInputTokens: g.int(9) } })) } : {}),
    ...(g.chance(0.5) ? { apiDurations: g.list(1, 3, () => 100 + g.int(900)) } : {}),
    invocations: g.list(1, 3, invocation),
    ...(g.chance(0.1) ? { noResult: true } : {}),
    restarts: g.list(2, 5, () => g.chance(0.5)),
    options: (ctx) => ({
      maxTurns: 1 + g.int(6),
      maxVerifyAttempts: 1 + g.int(3),
      ...(g.chance(0.3) ? { resume: g.pick([UUID, 'bad-id']) } : {}),
      ...(g.chance(0.3) ? { model: 'haiku' } : {}),
      ...(escalate ? { model: 'haiku', escalation: { to: 'sonnet', sameSignatureTimes: 1 + g.int(2), ...(g.chance(0.5) ? { afterFailures: 1 + g.int(3) } : {}), ...(g.chance(0.5) ? { retryBudget: g.int(3) } : {}) } } : {}),
      ...(g.chance(0.3) ? { steering: ctx.queue.steering } : {}),
      ...(g.chance(0.15) ? { intent: 'ask' as const } : {}),
      networkRetry: { wait: async () => {}, maxAttempts: g.int(3), maxWaitMs: 60_000, baseDelayMs: 1_000 },
    }),
    onEvent: (event, ctx) => {
      if (event.type === 'tool_result' && ctx.queue && g.chance(0.3)) ctx.queue.push(`지시 ${g.int(9)}`);
    },
  };
}

describe('claude-code 러너: 시드 있는 무작위 시나리오(옛 루프와 새 루프의 차등)', () => {
  const count = readEnvNumber('B_STUDIO_RUNNER_DIFF_CASES', 48);
  for (let seed = 1; seed <= count; seed++) {
    it(`seed ${seed}`, async () => {
      // 옵션·계기를 만드는 난수는 요청마다 같은 순서로 써야 하므로 양쪽에 같은 시드로 새로 만든다
      const legacy = await observe(runClaudeCodeAgentLegacy, randomCase(seed));
      const current = await observe(runClaudeCodeAgent, randomCase(seed));
      expect(current).toEqual(legacy);
    }, 120_000);
  }
});

// ── 의도한 차이 ──

describe('claude-code 러너: 의도한 차이', () => {
  it('너무 깊게 중첩된 줄은 건너뛰지 않고 실행을 실패로 끝낸다(옛 구현은 읽고 처리했다)', async () => {
    const deep = `{"type":"assistant","message":{"id":"deep","content":[]},"x":${'['.repeat(3_000)}1${']'.repeat(3_000)}}`;
    const c: Case = { name: 'deep', turns: [[{ text: '끝' }]], invocations: [{ pre: [deep] }] };
    const legacy = await observe(runClaudeCodeAgentLegacy, c);
    const current = await observe(runClaudeCodeAgent, c);
    expect('result' in legacy.outcome).toBe(true);
    expect(current.outcome).toMatchObject({ error: { message: expect.stringContaining('깊게 중첩된') } });
  }, 60_000);

  it('Object.prototype 속성과 같은 모델 이름도 사용량에 보통 키로 센다(옛 구현은 Object를 오염시켰다)', async () => {
    const c: Case = { name: 'proto', turns: [[{ text: '끝' }]], modelUsages: [{ constructor: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }] };
    const current = await observe(runClaudeCodeAgent, c);
    expect(current.outcome).toMatchObject({ result: { metrics: { usageByModel: { constructor: { inputTokens: 5 } } } } });
  }, 60_000);

  it('content 배열에 null이 있으면 옛 구현과 같게 TypeError로 끝난다', async () => {
    const c: Case = { name: 'null-block', turns: [[{ raw: { type: 'assistant', message: { id: 'm1', content: [null] } } }]] };
    const legacy = await observe(runClaudeCodeAgentLegacy, c);
    const current = await observe(runClaudeCodeAgent, c);
    expect(current.outcome).toEqual(legacy.outcome);
    expect(current.outcome).toMatchObject({ error: { name: 'TypeError' } });
  }, 60_000);
});
