import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runClaudeCodeAgent, type ClaudeCodeResult, type ClaudeCodeRunOptions } from './claude-code-runner';
import { fakeClaudeCli, type FakeCliScenario, type FakeInvocation, type FakeStep } from './fake-claude-cli';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, fakeSteering, ORDERS_CONTRACT as contract } from './test-helpers';

/**
 * 지원 러너의 메시지 루프와 실행 상태(Rust 러너 코어, ADR-202, 4f A8b)를 가짜 CLI 시나리오·가짜 샌드박스로 확인한다: 취소 뒤의 동작,
 * 승격 순간의 지시, 의도한 차이(깊은 중첩·프로토타입 모델 이름·null 블록). 옛 TS 루프(사본)와 시나리오 수십 개를 견주던 부분은 걷어냈다(#1347).
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

// ── 의도한 차이 ──

describe('claude-code 러너: 의도한 차이', () => {
  it('너무 깊게 중첩된 줄은 건너뛰지 않고 실행을 실패로 끝낸다', async () => {
    const deep = `{"type":"assistant","message":{"id":"deep","content":[]},"x":${'['.repeat(3_000)}1${']'.repeat(3_000)}}`;
    const c: Case = { name: 'deep', turns: [[{ text: '끝' }]], invocations: [{ pre: [deep] }] };
    const current = await observe(runClaudeCodeAgent, c);
    expect(current.outcome).toMatchObject({ error: { message: expect.stringContaining('깊게 중첩된') } });
  }, 60_000);

  it('Object.prototype 속성과 같은 모델 이름도 사용량에 보통 키로 센다', async () => {
    const c: Case = { name: 'proto', turns: [[{ text: '끝' }]], modelUsages: [{ constructor: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }] };
    const current = await observe(runClaudeCodeAgent, c);
    expect(current.outcome).toMatchObject({ result: { metrics: { usageByModel: { constructor: { inputTokens: 5 } } } } });
  }, 60_000);

  it('content 배열에 null이 있으면 TypeError로 끝난다', async () => {
    const c: Case = { name: 'null-block', turns: [[{ raw: { type: 'assistant', message: { id: 'm1', content: [null] } } }]] };
    const current = await observe(runClaudeCodeAgent, c);
    expect(current.outcome).toMatchObject({ error: { name: 'TypeError' } });
  }, 60_000);
});
