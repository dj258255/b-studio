import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@b-studio/agent';
import type { StudioEvent } from '../studio-events';
import { buildTokenReports, estimateCostUsd, pricesFromEnv, summarizeInput, tokenPricing, type TokenPrices } from './token-report';

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

/** 승격으로 모델이 바뀐 실행 하나: haiku 100/10 뒤 sonnet 200/20 */
function modelEvents(): StudioEvent[] {
  return [
    { type: 'run_started', runId: 'r1', request: '주문 필터 추가' },
    agent('r1', { type: 'turn', turn: 1 }),
    agent('r1', { type: 'turn_usage', turn: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 100 }),
    agent('r1', { type: 'model_escalated', from: 'haiku', to: 'sonnet', attempt: 2, signature: 'run|api|x', sameSignatureTimes: 2 }),
    {
      type: 'run_finished',
      runId: 'r1',
      status: 'done',
      summary: 'ok',
      turns: 1,
      usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
      metrics: {
        modelCalls: 2,
        maxContextTokens: 100,
        modelMs: 0,
        toolMs: 0,
        gateMs: 0,
        usageByModel: {
          haiku: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          sonnet: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    },
  ];
}

const prices = (inputPerM: number, outputPerM: number, cacheReadPerM = 0, cacheWritePerM = 0): TokenPrices => ({ inputPerM, outputPerM, cacheReadPerM, cacheWritePerM });

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

  it('도구 결과가 잘라낸 글자와 남은 호출마다 다시 읽혔을 양(추정)을 낸다', () => {
    const [report] = buildTokenReports(sampleEvents());

    // (30,452-6,000) + (12,000-28) = 36,424자, 그중 반복 대체 1회
    expect(report!.trimmed.chars).toBe(36_424);
    expect(report!.trimmed.repeated).toBe(1);
    // (24452/4)×(뒤 1턴+1) + (11972/4)×(뒤 0턴+1) = 12,226 + 2,993
    expect(report!.trimmed.estimatedTokens).toBe(15_219);
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
    const [priced] = buildTokenReports(sampleEvents(), { single: prices });
    expect(priced!.estimatedCostUsd).toBeCloseTo(estimateCostUsd({ inputTokens: 3000, outputTokens: 110, cacheReadTokens: 30_000, cacheWriteTokens: 100 }, prices), 8);
    expect(priced!.priceNote).toBeUndefined();
    expect(priced!.priceSource).toBe('single');

    const [unpriced] = buildTokenReports(sampleEvents());
    expect(unpriced!.estimatedCostUsd).toBeUndefined();
    expect(unpriced!.priceNote).toBe('단가 미설정');
    expect(unpriced!.priceSource).toBe('none');
  });

  it('턴별 컨텍스트 증가 원인(문맥 급증) 분석을 함께 싣는다', () => {
    const [report] = buildTokenReports(sampleEvents());
    expect(report!.contextGrowth).toBeDefined();
    expect(report!.contextGrowth!.turns).toHaveLength(2);
    // 턴 2는 31,100 토큰 증가로 급증(4,000 토큰 이상)이고, 원인에 run_in_service 도구 결과가 잡힌다
    const jump = report!.contextGrowth!.jumps.find((entry) => entry.turn === 2);
    expect(jump).toBeDefined();
    expect(jump!.sources.some((source) => source.name === 'run_in_service')).toBe(true);
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

  it('실행이 남긴 모델별 사용량과 승격 정보를 보고서에 싣는다', () => {
    const [report] = buildTokenReports(modelEvents());
    expect(report!.usageByModel).toEqual({
      haiku: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sonnet: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(report!.escalation).toEqual({ from: 'haiku', to: 'sonnet', attempt: 2 });
  });

  it('토큰을 쓰지 않은 모델(고정 계획의 scripted)은 모델별 표와 비용에서 뺀다', () => {
    const events = modelEvents();
    const finished = events.find((event) => event.type === 'run_finished') as Extract<StudioEvent, { type: 'run_finished' }>;
    finished.metrics!.usageByModel!.scripted = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const [report] = buildTokenReports(events, { byModel: { haiku: prices(1, 5), sonnet: prices(3, 15) } });
    expect(Object.keys(report!.usageByModel ?? {})).toEqual(['haiku', 'sonnet']);
    expect(report!.priceNote).toBeUndefined();
    expect(report!.priceSource).toBe('by-model');
  });

  it('모델별 단가 표가 있으면 모델별로 계산하고(단일 단가보다 우선) 모델별 비용도 남긴다', () => {
    const byModel = { haiku: prices(1, 5), sonnet: prices(3, 15) };
    const [report] = buildTokenReports(modelEvents(), { byModel, single: prices(100, 100) });

    expect(report!.priceSource).toBe('by-model');
    const haiku = estimateCostUsd({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, byModel.haiku);
    const sonnet = estimateCostUsd({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, byModel.sonnet);
    expect(report!.estimatedCostUsd).toBeCloseTo(haiku + sonnet, 8);
    expect(report!.modelCosts).toEqual({ haiku, sonnet });
    expect(report!.priceNote).toBeUndefined();
  });

  it('모델별 단가가 없는 모델이 하나라도 있으면 합계 비용 대신 사유를 남긴다', () => {
    const [report] = buildTokenReports(modelEvents(), { byModel: { haiku: prices(1, 5) } });

    expect(report!.priceSource).toBe('by-model');
    expect(report!.estimatedCostUsd).toBeUndefined();
    expect(report!.priceNote).toBe('단가 없음: sonnet');
    // 값을 찾은 모델의 비용은 표에 남는다
    expect(report!.modelCosts).toEqual({ haiku: estimateCostUsd({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, prices(1, 5)) });
  });

  it('모델별 사용량이 없으면 모델별 표가 있어도 단일 단가로 계산한다', () => {
    const single = prices(3, 15);
    const [report] = buildTokenReports(sampleEvents(), { byModel: { haiku: prices(1, 5) }, single });

    expect(report!.priceSource).toBe('single');
    expect(report!.estimatedCostUsd).toBeCloseTo(estimateCostUsd({ inputTokens: 3000, outputTokens: 110, cacheReadTokens: 30_000, cacheWriteTokens: 100 }, single), 8);
  });

  it('단가 표 JSON을 읽지 못하면 경고를 남기고 단가 없음으로 취급한다', () => {
    const [report] = buildTokenReports(modelEvents(), tokenPricing({ B_STUDIO_TOKEN_PRICES_JSON: '{' }));

    expect(report!.priceSource).toBe('none');
    expect(report!.warnings.find((warning) => warning.kind === 'price_table')?.message).toContain('단가 표를 읽지 못했습니다');
  });
});

describe('tokenPricing', () => {
  it('모델별 표 JSON과 단일 단가를 함께 싣는다', () => {
    const json = JSON.stringify({ haiku: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0, cacheWritePerM: 0 } });
    const pricing = tokenPricing({
      B_STUDIO_TOKEN_PRICES_JSON: json,
      B_STUDIO_PRICE_INPUT_PER_M: '3',
      B_STUDIO_PRICE_OUTPUT_PER_M: '15',
      B_STUDIO_PRICE_CACHE_READ_PER_M: '0.3',
      B_STUDIO_PRICE_CACHE_WRITE_PER_M: '3.75',
    });

    expect(pricing.byModel).toEqual({ haiku: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0, cacheWritePerM: 0 } });
    expect(pricing.single).toEqual({ inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 });
    expect(pricing.error).toBeUndefined();
  });

  it('잘못된 JSON이면 서버를 죽이지 않고 error에 이유를 담는다', () => {
    const pricing = tokenPricing({ B_STUDIO_TOKEN_PRICES_JSON: '{ not json' });
    expect(pricing.error).toContain('단가 표를 읽지 못했습니다');
    expect(pricing.byModel).toBeUndefined();
  });

  it('환경 변수가 없으면 빈 설정이다', () => {
    expect(tokenPricing({})).toEqual({});
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
