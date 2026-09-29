import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@b-studio/agent';
import type { StudioEvent } from '../studio-events';
import { buildTokenReports, estimateCostUsd, pricesFromEnv, summarizeInput, type TokenPrices } from './token-report';

const agent = (runId: string, event: Exclude<AgentEvent, { type: 'tokens' }>): StudioEvent => ({ type: 'agent', runId, event });

/** E2 실행 하나를 흉내 낸 기록: 1턴에서 큰 명령 결과, 2턴에서 컨텍스트가 크게 늘고 node_modules를 읽는다 */
function sampleEvents(): StudioEvent[] {
  return [
    { type: 'run_started', runId: 'r1', request: '주문 필터 추가' },
    agent('r1', { type: 'turn', turn: 1 }),
    agent('r1', { type: 'turn_usage', turn: 1, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 1000 }),
    agent('r1', { type: 'tool_call', name: 'run_in_service', input: { service: 'api', command: ['./gradlew', 'test'] } }),
    agent('r1', { type: 'tool_result', name: 'run_in_service', ok: true, content: 'x'.repeat(6000), chars: 6000, rawChars: 30_452 }),
    agent('r1', { type: 'turn', turn: 2 }),
    agent('r1', { type: 'turn_usage', turn: 2, inputTokens: 2000, outputTokens: 60, cacheReadTokens: 30_000, cacheWriteTokens: 100, contextTokens: 32_100 }),
    agent('r1', { type: 'tool_call', name: 'read_file', input: { path: 'node_modules/next/dist/docs/a.md' } }),
    agent('r1', { type: 'tool_result', name: 'read_file', ok: true, content: '(앞의 1번째 호출 결과와 같습니다)', chars: 28, rawChars: 12_000 }),
    { type: 'run_finished', runId: 'r1', status: 'done', summary: 'ok', turns: 2, usage: { inputTokens: 3000, outputTokens: 110, cacheReadTokens: 30_000, cacheWriteTokens: 100 } },
  ];
}

describe('buildTokenReports', () => {
  it('턴별 컨텍스트·증가량과 그 턴의 가장 큰 도구 결과를 낸다', () => {
    const [report] = buildTokenReports(sampleEvents());
    expect(report!.runId).toBe('r1');
    expect(report!.turns).toEqual([
      { turn: 1, contextTokens: 1000, delta: 1000, output: 50, cacheRead: 0, biggestTool: { name: 'run_in_service', input: 'api ./gradlew test', chars: 6000 } },
      { turn: 2, contextTokens: 32_100, delta: 31_100, output: 60, cacheRead: 30_000, biggestTool: { name: 'read_file', input: 'node_modules/next/dist/docs/a.md', chars: 28 } },
    ]);
  });

  it('도구별 비중·큰 결과 상위·합계·캐시 적중률을 낸다', () => {
    const [report] = buildTokenReports(sampleEvents());
    expect(report!.toolTotals).toEqual([
      { name: 'run_in_service', calls: 1, chars: 6000, share: 6000 / 6028 },
      { name: 'read_file', calls: 1, chars: 28, share: 28 / 6028 },
    ]);
    expect(report!.biggest).toEqual([
      { name: 'run_in_service', input: 'api ./gradlew test', chars: 6000, rawChars: 30_452, turn: 1 },
      { name: 'read_file', input: 'node_modules/next/dist/docs/a.md', chars: 28, rawChars: 12_000, turn: 2 },
    ]);
    expect(report!.totals).toEqual({ inputTokens: 3000, outputTokens: 110, cacheReadTokens: 30_000, cacheWriteTokens: 100 });
    expect(report!.cacheHitRatio).toBeCloseTo(30_000 / 33_100, 5);
  });

  it('글자 수로 낭비 신호를 찾는다: 큰 결과·같은 결과 반복·node_modules·컨텍스트 급증', () => {
    const [report] = buildTokenReports(sampleEvents());
    const kinds = report!.warnings.map((warning) => warning.kind);
    expect(kinds).toContain('big_result');
    expect(kinds).toContain('repeated_result');
    expect(kinds).toContain('node_modules');
    expect(kinds).toContain('context_jump');
    // 큰 결과 경고는 원래 글자와 모델에 간 글자를 함께 알린다
    const big = report!.warnings.find((warning) => warning.kind === 'big_result')!;
    expect(big.message).toContain('30,452');
    expect(big.tool).toBe('run_in_service');
    // 컨텍스트 급증은 턴을 알린다(20,000 초과)
    expect(report!.warnings.find((warning) => warning.kind === 'context_jump')!.turn).toBe(2);
  });

  it('단가가 있으면 추정 비용을, 없으면 "단가 미설정"을 남긴다', () => {
    const prices: TokenPrices = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
    const [priced] = buildTokenReports(sampleEvents(), prices);
    expect(priced!.estimatedCostUsd).toBeCloseTo(estimateCostUsd({ inputTokens: 3000, outputTokens: 110, cacheReadTokens: 30_000, cacheWriteTokens: 100 }, prices), 8);
    expect(priced!.priceNote).toBeUndefined();

    const [unpriced] = buildTokenReports(sampleEvents());
    expect(unpriced!.estimatedCostUsd).toBeUndefined();
    expect(unpriced!.priceNote).toBe('단가 미설정');
  });

  it('여러 실행은 최신이 먼저 오고, 도구 결과가 없는 실행도 남는다', () => {
    const events: StudioEvent[] = [
      { type: 'run_started', runId: 'r1', request: '첫 요청' },
      agent('r1', { type: 'turn', turn: 1 }),
      agent('r1', { type: 'turn_usage', turn: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 10 }),
      { type: 'run_finished', runId: 'r1', status: 'done', summary: 'ok', turns: 1, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'run_started', runId: 'r2', request: '둘째 요청' },
      { type: 'run_finished', runId: 'r2', status: 'done', summary: 'ok', turns: 0 },
    ];
    const reports = buildTokenReports(events);
    expect(reports.map((report) => report.runId)).toEqual(['r2', 'r1']);
    expect(reports[0]!.turns).toEqual([]);
    expect(reports[0]!.toolTotals).toEqual([]);
    expect(reports[0]!.warnings).toEqual([]);
  });

  it('tokens 누적값도 실행 합계로 받아 둔다(로컬 러너)', () => {
    const events: StudioEvent[] = [
      { type: 'run_started', runId: 'r1', request: '요청' },
      agent('r1', { type: 'turn', turn: 1 }),
      agent('r1', { type: 'turn_usage', turn: 1, inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, contextTokens: 6 }),
      { type: 'tokens', runId: 'r1', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 }, sessionTokens: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } },
      { type: 'run_finished', runId: 'r1', status: 'done', summary: 'ok', turns: 1 },
    ];
    const [report] = buildTokenReports(events);
    expect(report!.totals).toEqual({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 });
  });

  it('오래된 도구 결과를 비운 기록을 턴 표와 실행 합계에 담는다', () => {
    const events: StudioEvent[] = [
      { type: 'run_started', runId: 'r1', request: '요청' },
      agent('r1', { type: 'turn', turn: 1 }),
      agent('r1', { type: 'turn_usage', turn: 1, inputTokens: 60_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 60_000 }),
      agent('r1', { type: 'turn', turn: 2 }),
      // 비우기는 그 턴의 모델 호출 **전**에 일어나 turn_usage보다 먼저 온다
      agent('r1', { type: 'context_cleared', turn: 2, clearedCount: 3, clearedChars: 24_000 }),
      agent('r1', { type: 'turn_usage', turn: 2, inputTokens: 20_000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 20_000 }),
      { type: 'run_finished', runId: 'r1', status: 'done', summary: 'ok', turns: 2 },
    ];

    const [report] = buildTokenReports(events);

    expect(report!.turns[0]!.cleared).toBeUndefined();
    expect(report!.turns[1]!.cleared).toEqual({ count: 3, chars: 24_000 });
    expect(report!.cleared).toEqual({ count: 3, chars: 24_000 });
  });

  it('비운 적이 없으면 합계가 0이다', () => {
    const [report] = buildTokenReports(sampleEvents());
    expect(report!.cleared).toEqual({ count: 0, chars: 0 });
    expect(report!.turns.every((turn) => turn.cleared === undefined)).toBe(true);
  });
});

describe('summarizeInput', () => {
  it('도구별로 사람이 읽을 한 줄을 만들고 80자로 줄인다', () => {
    expect(summarizeInput('read_file', { path: 'api/src/Order.java' })).toBe('api/src/Order.java');
    expect(summarizeInput('run_in_service', { service: 'api', command: ['./gradlew', 'test'] })).toBe('api ./gradlew test');
    expect(summarizeInput('http_request', { service: 'web', method: 'GET', path: '/orders' })).toBe('web GET /orders');
    const long = 'run_in_service';
    expect(summarizeInput(long, { service: 'api', command: ['x'.repeat(200)] })).toHaveLength(81); // 80자 + 말줄임표
  });
});

describe('pricesFromEnv', () => {
  it('네 단가가 모두 있어야 하고, 잘못된 값은 없는 것으로 본다', () => {
    const complete = { B_STUDIO_PRICE_INPUT_PER_M: '3', B_STUDIO_PRICE_OUTPUT_PER_M: '15', B_STUDIO_PRICE_CACHE_READ_PER_M: '0.3', B_STUDIO_PRICE_CACHE_WRITE_PER_M: '3.75' };
    expect(pricesFromEnv(complete)).toEqual({ inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 });
    expect(pricesFromEnv({ ...complete, B_STUDIO_PRICE_CACHE_WRITE_PER_M: undefined })).toBeUndefined();
    expect(pricesFromEnv({ ...complete, B_STUDIO_PRICE_OUTPUT_PER_M: '-1' })).toBeUndefined();
    expect(pricesFromEnv({})).toBeUndefined();
  });
});
