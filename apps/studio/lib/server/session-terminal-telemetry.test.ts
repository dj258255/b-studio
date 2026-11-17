import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideTurnLimit, modelCallsFromOtlp, usageUnverifiable, type ModelCall } from './session-terminal-telemetry';
import { legacyApiRequestsFromOtlp, legacyTurnLimit, type LegacyLimitReason } from './session-terminal-telemetry-legacy';
import type { ApiRequestUsage } from './terminal-telemetry';

/**
 * 텔레메트리 본문 해석과 턴 상한 전이(ADR-216, 4f B5b)의 차등 시험. 기준은 옛 판정(`session-terminal-telemetry-legacy.ts`)이다.
 * 옛 판정과 다른 칸은 목록으로 고정하고, 모두 닫는 쪽(더 세거나 모름으로 처리)이어야 한다.
 */
const NOW = 1_750_000_000_000;
afterEach(() => vi.useRealTimers());

const attr = (key: string, value: unknown) => ({ key, value });
const str = (value: string) => ({ stringValue: value });
const base = (): Array<{ key: string; value: unknown }> => [
  attr('event.name', str('claude_code.api_request')),
  attr('model', str('claude-sonnet-5')),
  attr('input_tokens', { intValue: '1000' }),
  attr('output_tokens', { intValue: 200 }),
  attr('cache_read_tokens', { doubleValue: 3000 }),
  attr('cache_creation_tokens', { intValue: '50' }),
  attr('cost_usd', { doubleValue: 0.0123 }),
  attr('duration_ms', { intValue: 1234 }),
  attr('request_id', str('req-1')),
  attr('prompt.id', str('prompt-1')),
  attr('session.id', str('session-1')),
];
const rec = (attributes: unknown[] = base(), extra: Record<string, unknown> = {}) => ({ timeUnixNano: String(BigInt(NOW) * 1_000_000n), attributes, ...extra });
const otlp = (records: unknown[]): unknown => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });

/** 옛 항목과 새 호출이 같은 호출을 가리키는가(시각은 따로 본다) */
function same(old: ApiRequestUsage, call: ModelCall): boolean {
  return (
    old.model === call.model &&
    old.inputTokens === call.inputTokens &&
    old.outputTokens === call.outputTokens &&
    old.cacheReadTokens === call.cacheReadTokens &&
    old.cacheWriteTokens === call.cacheWriteTokens &&
    old.requestId === call.requestId &&
    old.promptId === call.promptId &&
    old.sessionId === call.sessionId &&
    old.costUsd === call.costUsd &&
    old.durationMs === call.durationMs &&
    old.agent === call.agent &&
    old.conversationId === call.conversationId &&
    call.tokensComplete
  );
}

/** 다른 칸 이름. 목록으로 고정한다 */
type Cell = 'same' | 'extra-incomplete' | 'extra-optional' | 'extra-over-cap' | 'time-off-clock';

/**
 * 옛 목록(L)과 새 목록(N)을 견준다. 새 목록은 옛 항목을 같은 순서로 모두 담고(시각만 받은 시각으로 바뀔 수 있다), 나머지는 읽지 못한 호출이거나 옛 상한을 넘은 호출이다.
 * 돌려주는 값은 본문 하나가 만든 칸들이다
 */
function compare(body: unknown): Cell[] {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const old = legacyApiRequestsFromOtlp(body);
  const fresh = modelCallsFromOtlp(body, NOW);
  vi.useRealTimers();
  const cells: Cell[] = [];
  let index = 0;
  fresh.calls.forEach((call, position) => {
    const expected = old[index];
    if (expected && same(expected, call)) {
      index += 1;
      if (expected.at === call.at) cells.push('same');
      else {
        // 시각만 다르다: 옛 시각이 받은 시각의 앞뒤 60초 밖이었고 새 시각은 받은 시각이다
        expect(Math.abs(expected.at - NOW), `시각 ${expected.at}`).toBeGreaterThan(60_000);
        expect(call.at).toBe(NOW);
        expect(call.timeSource).toBe('received_off_clock');
        cells.push('time-off-clock');
      }
      return;
    }
    // 옛 항목에 없는 호출: 읽지 못한 호출이거나 옛 상한(1,000개)을 넘은 호출뿐이다
    if (!call.tokensComplete) cells.push('extra-incomplete');
    else if (position < 1000) {
      // 토큰은 다 읽었는데 옛 판정이 버린 호출: 모델 이름이 없거나, 비용·시간이 이상했다(그 값만 싣지 않고 호출은 센다)
      expect(call.model === 'unknown' || call.costUsd === undefined || call.durationMs === undefined, '옛 판정이 버린 까닭이 선택 속성이다').toBe(true);
      cells.push('extra-optional');
    } else {
      expect(position, '상한 밖이 아닌 완전한 호출이 옛 목록에 없다').toBeGreaterThanOrEqual(1000);
      cells.push('extra-over-cap');
    }
  });
  // 옛 항목은 하나도 잃지 않는다
  expect(index, '옛 항목을 모두 이어 담는다').toBe(old.length);
  expect(fresh.calls.length).toBeGreaterThanOrEqual(old.length);
  return cells;
}

describe('본문 해석: 기존 시험의 입력과 실제 CLI 자료', () => {
  it('옛 시험이 쓰는 모양들은 시각 말고는 옛 판정과 같다', () => {
    const required = (skip: string) => base().filter((entry) => entry.key !== skip);
    const bodies: unknown[] = [
      otlp([rec()]),
      otlp([rec(base().map((e) => (e.key === 'event.name' ? attr('event.name', str('claude_code.tool_result')) : e)))]),
      otlp([{ timeUnixNano: '1750000000000000000', body: str('claude_code.api_request'), attributes: required('event.name') }]),
      otlp([rec(), rec(required('model'))]),
      otlp([rec([...base(), attr('agent.name', str('Explore'))])]),
      otlp([rec([...base(), attr('query_source', str('agent:custom:foo'))])]),
      [],
      null,
      '문자열',
      42,
      {},
      { resourceLogs: 'x' },
      { resourceLogs: [null, 7] },
      { resourceLogs: [{ scopeLogs: [{ logRecords: 'x' }] }] },
      otlp([{ observedTimeUnixNano: '1750000000500000000', attributes: base() }]),
      otlp([{ attributes: base() }]),
      otlp([{ timeUnixNano: '0', observedTimeUnixNano: '1750000000500000000', attributes: base() }]),
    ];
    // 옛 시험의 입력은 시각 말고는 같다. 읽지 못한 호출(필수 속성 빠짐)과 선택 속성이 없는 호출만 더 센다
    for (const body of bodies) for (const cell of compare(body)) expect(['same', 'extra-incomplete', 'extra-optional']).toContain(cell);
  });

  it('Codex의 response.completed는 옛 판정과 같다(실험: 옛 규칙 그대로)', () => {
    const codex = (over: Array<{ key: string; value: unknown }> = []) => ({
      timeUnixNano: '0',
      observedTimeUnixNano: String(BigInt(NOW) * 1_000_000n),
      attributes: [
        attr('event.name', str('codex.sse_event')),
        attr('event.kind', str('response.completed')),
        attr('input_token_count', str('100')),
        attr('output_token_count', str('20')),
        attr('cached_token_count', str('80')),
        attr('cache_write_token_count', str('0')),
        attr('event.timestamp', str('2026-10-22T03:02:15.381Z')),
        attr('conversation.id', str('conv-1')),
        attr('model', str('gpt-5.5')),
        ...over,
      ],
    });
    for (const over of [[], [attr('cached_token_count', str('101'))], [attr('output_token_count', str('-1'))], [attr('model', str(''))], [attr('input_token_count', { intValue: 'x' })]]) {
      const cells = compare(otlp([codex(over)]));
      expect(cells.every((cell) => cell === 'same')).toBe(true);
    }
  });

  it('실제 CLI(2.1.326)가 보낸 api_request 한 건(개인 정보를 지운 판)을 옛 판정과 같게 읽는다', () => {
    const body = JSON.parse(readFileSync(path.join(__dirname, '__fixtures__/claude-cli-2.1.326-api-request.json'), 'utf8')) as unknown;
    // 실제 자료의 시각을 받은 시각으로 쓴다(자료는 이미 지난 시각이라, 지금 시각으로 읽으면 받은 시각으로 바뀐다)
    const atNs = (body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ timeUnixNano: string }> }> }> }).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.timeUnixNano;
    const at = Number(BigInt(atNs) / 1_000_000n);
    const parsed = modelCallsFromOtlp(body, at + 1_000);
    expect(parsed.defects).toBe(0);
    expect(parsed.calls).toEqual([
      {
        at,
        timeSource: 'cli',
        model: 'claude-haiku-5-5',
        inputTokens: 2,
        outputTokens: 5,
        cacheReadTokens: 11457,
        cacheWriteTokens: 37930,
        tokensComplete: true,
        requestId: 'req_redacted',
        promptId: '4c82bc26-6b45-4c18-9e88-499090f86be4',
        sessionId: '11111111-1111-4111-8111-111111111111',
        costUsd: 0.00770327,
        durationMs: 1690,
      },
    ]);
    const old = legacyApiRequestsFromOtlp(body);
    expect(old).toHaveLength(1);
    expect(same(old[0]!, parsed.calls[0]!)).toBe(true);
    expect(old[0]!.at).toBe(at);
    // 받은 시각이 한참 뒤면(자료가 옛것이면) 시각만 받은 시각으로 바뀐다
    expect(modelCallsFromOtlp(body, at + 3_600_000).calls[0]).toMatchObject({ at: at + 3_600_000, timeSource: 'received_off_clock' });
  });
});

/** 씨앗을 주면 같은 수열을 내는 작은 난수(시험이 되풀이되게) */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('본문 해석: 무작위로 망가뜨린 레코드 3000건', () => {
  const BAD_VALUES: unknown[] = [
    null,
    'x',
    '12',
    7,
    -3,
    1e12,
    [],
    {},
    { intValue: 'abc' },
    { intValue: '-1' },
    { intValue: '0x10' },
    { intValue: ' 5 ' },
    { intValue: '' },
    { doubleValue: 1e10 },
    { doubleValue: '1e3' },
    { stringValue: '9' },
    { stringValue: 'nope' },
    { boolValue: true },
    { intValue: 1.5 },
    { intValue: { nested: 1 } },
  ];
  const TIMES: unknown[] = [undefined, '0', 0, '1', 'abc', '9'.repeat(40), -5, 1.75e18, String(BigInt(NOW + 3_600_000) * 1_000_000n), String(BigInt(NOW - 3_600_000) * 1_000_000n), String(BigInt(NOW + 5_000) * 1_000_000n), [], {}];

  it('옛 항목은 모두 이어 담고, 다른 칸은 읽지 못한 호출·옛 상한 밖·엉뚱한 시각뿐이다', () => {
    const random = prng(20261118);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const seen = new Map<Cell, number>();
    for (let i = 0; i < 3000; i += 1) {
      let attributes: unknown[] = base();
      const edits = 1 + Math.floor(random() * 3);
      for (let edit = 0; edit < edits; edit += 1) {
        const kind = Math.floor(random() * 5);
        const target = pick(['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'duration_ms', 'request_id', 'event.name']);
        if (kind === 0) attributes = attributes.filter((entry) => (entry as { key?: string } | null)?.key !== target);
        else if (kind === 1) attributes = [...attributes.filter((entry) => (entry as { key?: string } | null)?.key !== target), attr(target, pick(BAD_VALUES))];
        else if (kind === 2) attributes = [...attributes, attr(target, pick(BAD_VALUES))];
        else if (kind === 3) attributes = [...attributes, pick([null, 7, 'x', { key: 5 }, { value: 1 }, [] as unknown])];
        else attributes = [...attributes, { key: target }];
      }
      const time = pick(TIMES);
      const record: Record<string, unknown> = { attributes };
      if (time !== undefined) record.timeUnixNano = time;
      if (random() < 0.2) record.observedTimeUnixNano = pick(TIMES);
      if (random() < 0.1) record.body = pick([str('claude_code.api_request'), str('x'), null]);
      let body: unknown = otlp([record, random() < 0.3 ? null : rec()]);
      const shape = random();
      if (shape < 0.05) body = { resourceLogs: [{ scopeLogs: pick(['x', null, [null], [{ logRecords: 'x' }]]) }] };
      else if (shape < 0.08) body = pick([[], null, 'x', 5, { resourceLogs: {} }]);
      for (const cell of compare(body)) seen.set(cell, (seen.get(cell) ?? 0) + 1);
    }
    // 어떤 칸이 나왔는지 고정한다
    expect([...seen.keys()].sort()).toEqual(['extra-incomplete', 'extra-optional', 'same', 'time-off-clock']);
    expect(seen.get('same')!).toBeGreaterThan(1000);
    expect(seen.get('extra-incomplete')!).toBeGreaterThan(500);
  });

  it('옛 상한(1,000개)을 넘는 호출도 센다', () => {
    const cells = compare(otlp(Array.from({ length: 1500 }, () => rec())));
    expect(cells.filter((cell) => cell === 'same')).toHaveLength(1000);
    expect(cells.filter((cell) => cell === 'extra-over-cap')).toHaveLength(500);
  });

  it('본문을 JSON으로 만들 수 없으면(순환) 읽지 못한 것으로 센다', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(modelCallsFromOtlp(loop, NOW)).toEqual({ calls: [], defects: 1 });
  });
});

describe('턴 상한 전이: 옛 판정과 모든 칸이 같다', () => {
  it('사유 3종 × 상한(없음·0·1·3·소수·NaN) × 호출 수 × 멈춤', () => {
    const reasons: LegacyLimitReason[] = [undefined, 'max_turns', 'budget'];
    const caps = [undefined, 0, 1, 3, 2.5, Number.NaN, 100];
    let cells = 0;
    for (const reason of reasons)
      for (const maxTurns of caps)
        for (const modelCalls of [0, 1, 2, 3, 4, 100])
          for (const aborted of [false, true]) {
            expect(decideTurnLimit({ reason, maxTurns, modelCalls, aborted }), `${reason} ${maxTurns} ${modelCalls} ${aborted}`).toEqual(legacyTurnLimit(reason, maxTurns, modelCalls, aborted));
            cells += 1;
          }
    expect(cells).toBe(3 * 7 * 6 * 2);
  });

  it('budget이 선 뒤에는 턴을 보지 않고, max_turns는 풀리지 않고, 상한이 없으면 턴을 보지 않는다', () => {
    expect(decideTurnLimit({ reason: 'budget', maxTurns: 1, modelCalls: 50, aborted: false })).toEqual({ reason: 'budget', checkBudget: false });
    expect(decideTurnLimit({ reason: 'max_turns', maxTurns: undefined, modelCalls: 0, aborted: false })).toEqual({ reason: 'max_turns', checkBudget: true });
    expect(decideTurnLimit({ reason: undefined, maxTurns: undefined, modelCalls: 999, aborted: false })).toEqual({ reason: undefined, checkBudget: true });
  });

  it('확인할 수 없음: 끊김은 늘, 읽지 못한 호출은 토큰 한도가 있을 때만', () => {
    expect(usageUnverifiable(true, false, false)).toBe(true);
    expect(usageUnverifiable(false, true, true)).toBe(true);
    expect(usageUnverifiable(false, true, false)).toBe(false);
    expect(usageUnverifiable(false, false, true)).toBe(false);
  });
});
