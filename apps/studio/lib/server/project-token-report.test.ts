import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@b-studio/agent';
import type { StudioEvent } from '../studio-events';
import { TRIM_ESTIMATE_METHOD, UNKNOWN_MODEL } from '../project-token-types';
import type { TokenPrices } from '../token-types';
import { StudioError } from './errors';
import { buildProjectTokenReport, projectTokenMarkdown, rangeBounds, runTimestamps, type ProjectSessionEvents } from './project-token-report';

const agent = (runId: string, event: Exclude<AgentEvent, { type: 'tokens' }>): StudioEvent => ({ type: 'agent', runId, event });
const usageEvent = (at: string): StudioEvent => ({ type: 'usage', at, services: [] });

/**
 * 파일을 바꾼 실행 하나(모델 두 개, 턴 2).
 * 도구 결과 둘: 잘린 것(2,400→400자)과 앞과 같은 것(800→20자) → 추정 (2000/4)×2 + (780/4)×1 = 1,195 토큰.
 * haiku 1,000/50, sonnet 2,000/60 + 캐시 읽기 30,000·쓰기 100.
 */
function changedSession(): StudioEvent[] {
  return [
    { type: 'run_started', runId: 'r1', request: '주문 목록에 필터를 추가하고 테스트를 돌려줘' },
    usageEvent('2026-09-01T10:00:00.000Z'),
    agent('r1', { type: 'turn', turn: 1 }),
    agent('r1', { type: 'turn_usage', turn: 1, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 1000 }),
    agent('r1', { type: 'tool_call', name: 'run_in_service', input: { service: 'api', command: ['./gradlew', 'test'] } }),
    agent('r1', { type: 'tool_result', name: 'run_in_service', ok: true, content: 'x'.repeat(400), chars: 400, rawChars: 2400 }),
    agent('r1', { type: 'turn', turn: 2 }),
    agent('r1', { type: 'turn_usage', turn: 2, inputTokens: 2000, outputTokens: 60, cacheReadTokens: 30_000, cacheWriteTokens: 100, contextTokens: 32_100 }),
    agent('r1', { type: 'tool_call', name: 'read_file', input: { path: 'web/orders/page.tsx' } }),
    agent('r1', { type: 'tool_result', name: 'read_file', ok: true, content: '(앞의 1번째 호출 결과와 같습니다)', chars: 20, rawChars: 800 }),
    agent('r1', { type: 'context_cleared', turn: 2, clearedCount: 2, clearedChars: 1200 }),
    { type: 'checkpoint', runId: 'r1', checkpoint: { sha: 'abc1234', shortSha: 'abc1234', message: '주문 필터', createdAt: '2026-09-01T10:05:00.000Z', files: ['web/orders/page.tsx'] } },
    {
      type: 'run_finished',
      runId: 'r1',
      status: 'done',
      summary: '필터를 추가했습니다',
      turns: 2,
      usage: { inputTokens: 3000, outputTokens: 110, cacheReadTokens: 30_000, cacheWriteTokens: 100 },
      metrics: {
        modelCalls: 2,
        maxContextTokens: 32_100,
        modelMs: 0,
        toolMs: 0,
        gateMs: 0,
        usageByModel: {
          haiku: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          sonnet: { inputTokens: 2000, outputTokens: 60, cacheReadTokens: 30_000, cacheWriteTokens: 100 },
        },
      },
    },
  ];
}

/** 가볍게 확인으로 끝난 실행 하나: 모델별 내역을 남기지 않는 러너(구독 CLI) 흉내 */
function lightSession(): StudioEvent[] {
  return [
    { type: 'run_started', runId: 'r2', request: '문구만 고쳐 줘' },
    usageEvent('2026-09-02T09:00:00.000Z'),
    { type: 'checkpoint', runId: 'r2', checkpoint: { sha: 'def5678', shortSha: 'def5678', message: '문구', createdAt: '2026-09-02T09:01:00.000Z', files: ['web/orders/page.tsx'], verify: 'light' } },
    {
      type: 'run_finished',
      runId: 'r2',
      status: 'done',
      summary: '고쳤습니다',
      turns: 1,
      usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      metrics: { modelCalls: 1, maxContextTokens: 500, modelMs: 0, toolMs: 0, gateMs: 0 },
      verify: 'light',
      skippedStages: ['test', 'browser_check', 'review'],
    },
  ];
}

/** 실패한 실행 하나(시각 없음)와 아직 끝나지 않은 실행 하나 */
function failingSession(): StudioEvent[] {
  return [
    { type: 'run_started', runId: 'r3', request: '결제를 붙여 줘' },
    {
      type: 'run_finished',
      runId: 'r3',
      status: 'failed',
      summary: '게이트 실패',
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      metrics: { modelCalls: 1, maxContextTokens: 100, modelMs: 0, toolMs: 0, gateMs: 0 },
    },
    { type: 'run_started', runId: 'r4', request: '아직 도는 요청' },
    { type: 'tokens', runId: 'r4', usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionTokens: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  ];
}

const sessions: ProjectSessionEvents[] = [
  { sessionId: 's-normal', kind: 'normal', events: changedSession() },
  { sessionId: 's-lane', kind: 'lane', events: lightSession() },
  { sessionId: 's-fleet', kind: 'fleet', events: failingSession() },
];

const prices = (inputPerM: number, outputPerM: number, cacheReadPerM = 0, cacheWritePerM = 0): TokenPrices => ({ inputPerM, outputPerM, cacheReadPerM, cacheWritePerM });

/** 모델별 단가: haiku $0.0015 + sonnet $0.016275 = $0.017775 */
const byModelPricing = { byModel: { haiku: prices(1, 10, 0.1, 1.25), sonnet: prices(3, 15, 0.3, 3.75) } };

function build(over: Partial<Parameters<typeof buildProjectTokenReport>[0]> = {}) {
  return buildProjectTokenReport({ projectId: 'orders', projectName: 'orders', sessions, generatedAt: '2026-09-03T00:00:00.000Z', ...over });
}

describe('buildProjectTokenReport', () => {
  it('모든 세션의 토큰·요청·모델 호출을 합치고 캐시 적중률을 낸다', () => {
    const report = build();

    expect(report.sessions).toBe(3);
    // 실행 넷: r1 33,210 + r2 520 + r3 110 + 아직 도는 r4 45
    expect(report.totals).toEqual({ inputTokens: 3640, outputTokens: 145, cacheReadTokens: 30_000, cacheWriteTokens: 100 });
    expect(report.requests).toHaveLength(4);
    expect(report.modelCalls).toBe(4);
    // 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기)
    expect(report.cacheHitRatio).toBeCloseTo(30_000 / 33_740, 5);
    expect(report.usageByModel.haiku).toEqual({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(report.usageByModel.sonnet).toEqual({ inputTokens: 2000, outputTokens: 60, cacheReadTokens: 30_000, cacheWriteTokens: 100 });
  });

  it('모델별 단가가 있으면 모델별로 계산하고 요청별 비용도 같은 값으로 낸다', () => {
    const report = build({ pricing: byModelPricing, sessions: [{ sessionId: 's-normal', kind: 'normal', events: changedSession() }] });

    expect(report.priceSource).toBe('by-model');
    expect(report.estimatedCostUsd).toBeCloseTo(0.0015 + 0.016275, 10);
    expect(report.modelCosts.haiku).toBeCloseTo(0.0015, 10);
    expect(report.modelCosts.sonnet).toBeCloseTo(0.016275, 10);
    expect(report.requests[0]!.costUsd).toBeCloseTo(0.017775, 10);
  });

  it('모델별 내역이 없는 러너의 토큰은 "(모름)"으로 묶는다', () => {
    const report = build({ pricing: byModelPricing });

    // r2 500/20 + r3 100/10 + r4 40/5
    expect(report.usageByModel[UNKNOWN_MODEL]).toEqual({ inputTokens: 640, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(report.notes).toContain(`모델별 내역을 남기지 않는 러너(구독 CLI 등)의 토큰은 "${UNKNOWN_MODEL}"으로 묶었습니다`);
  });

  it('단가를 찾지 못한 실행이 있으면 합계 비용을 쓰지 않고 사유를 남긴다', () => {
    // 단가 표에는 haiku·sonnet이 있지만 "(모름)"의 단가를 알 수 없다
    const report = build({ pricing: byModelPricing });

    expect(report.estimatedCostUsd).toBeUndefined();
    expect(report.notes).toContain('단가를 찾지 못한 실행 3개가 있어 합계 환산 비용을 쓰지 않았습니다');
  });

  it('단가가 없으면 비용 칸을 비우고 "단가 미설정"을 남긴다', () => {
    const report = build();

    expect(report.priceSource).toBe('none');
    expect(report.estimatedCostUsd).toBeUndefined();
    expect(report.priceNote).toBe('단가 미설정');
    expect(report.requests.every((request) => request.costUsd === undefined)).toBe(true);
  });

  it('일부 모델의 단가가 없으면 합계 비용을 쓰지 않고 사유를 남긴다', () => {
    const report = build({ pricing: { byModel: { sonnet: prices(3, 15, 0.3, 3.75) } } });

    // haiku 단가가 없어 일부만 계산하면 실제보다 싸 보이므로 합계를 쓰지 않는다
    expect(report.estimatedCostUsd).toBeUndefined();
    expect(report.priceNote).toBe('단가 없음: haiku');
    expect(report.priceSource).toBe('none');
  });

  it('단일 단가만 있으면 그 단가로 계산하고, 모델별 표의 "(모름)" 칸도 채운다', () => {
    const report = build({ pricing: { single: prices(3, 15, 0.3, 3.75) } });

    expect(report.priceSource).toBe('single');
    // (3640×3 + 145×15 + 30000×0.3 + 100×3.75) / 1e6
    expect(report.estimatedCostUsd).toBeCloseTo((3640 * 3 + 145 * 15 + 30_000 * 0.3 + 100 * 3.75) / 1e6, 10);
    expect(report.modelCosts[UNKNOWN_MODEL]).toBeCloseTo((640 * 3 + 35 * 15) / 1e6, 10);
  });

  it('줄인 양(측정)과 줄인 토큰(추정)을 손계산과 같게 낸다', () => {
    const report = build({ pricing: byModelPricing });

    // 잘라낸 글자 (2400-400) + (800-20) = 2,780자, 그중 반복 대체 1회, 묶어서 비운 결과 2개·1,200자
    expect(report.saved.trimmedChars).toBe(2780);
    expect(report.saved.repeatedResults).toBe(1);
    expect(report.saved.clearedCount).toBe(2);
    expect(report.saved.clearedChars).toBe(1200);
    // 추정: (2000/4)×(뒤 1회+1) + (780/4)×(뒤 0회+1) = 1,000 + 195
    expect(report.saved.trimmedTokensEstimated).toBe(1195);
    // 가장 많이 쓴 모델(sonnet)의 캐시 읽기 단가 0.3으로 환산
    expect(report.saved.trimmedCostModel).toBe('sonnet');
    expect(report.saved.trimmedCostUsd).toBeCloseTo((1195 / 1_000_000) * 0.3, 12);
  });

  it('가볍게 확인 실행 수와 건너뛴 단계를 센다', () => {
    const report = build();

    expect(report.saved.lightRuns).toBe(1);
    expect(report.saved.lightSkipped).toEqual([
      { stage: 'browser_check', runs: 1 },
      { stage: 'review', runs: 1 },
      { stage: 'test', runs: 1 },
    ]);
  });

  it('요청 결과를 바꿈·답만·가볍게·실패·진행 중으로 나눈다', () => {
    const answered = buildProjectTokenReport({
      projectId: 'orders',
      projectName: 'orders',
      generatedAt: '2026-09-03T00:00:00.000Z',
      sessions: [
        {
          sessionId: 's-ask',
          kind: 'normal',
          events: [
            { type: 'run_started', runId: 'q1', request: '이 파일 뭐야?', intent: 'ask' },
            { type: 'run_finished', runId: 'q1', status: 'done', summary: '설명', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          ],
        },
      ],
    });

    expect(answered.requests[0]!.result).toBe('answered');
    const results = Object.fromEntries(build().requests.map((request) => [`${request.sessionId}:${request.result}`, request.result]));
    expect(results['s-normal:changed']).toBe('changed');
    expect(results['s-lane:light']).toBe('light');
    expect(results['s-fleet:failed']).toBe('failed');
    expect(results['s-fleet:running']).toBe('running');
  });

  it('실행 환경 알림(agent session 이벤트)에 실린 노력 단계를 요청 행에 남긴다', () => {
    const report = buildProjectTokenReport({
      projectId: 'orders',
      projectName: 'orders',
      generatedAt: '2026-09-03T00:00:00.000Z',
      sessions: [
        {
          sessionId: 's-effort',
          kind: 'normal',
          events: [
            { type: 'run_started', runId: 'e1', request: '깊게 봐줘' },
            agent('e1', { type: 'session', backend: 'Anthropic API', model: 'claude-opus-5', effort: 'max' }),
            { type: 'run_finished', runId: 'e1', status: 'done', summary: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          ],
        },
      ],
    });

    expect(report.requests[0]!.effort).toBe('max');
  });

  it('러너가 노력 단계를 알리지 않으면 요청 행에 effort가 없다', () => {
    const report = buildProjectTokenReport({ projectId: 'orders', projectName: 'orders', generatedAt: '2026-09-03T00:00:00.000Z', sessions: [{ sessionId: 's', kind: 'normal', events: changedSession() }] });

    expect(report.requests[0]!.effort).toBeUndefined();
  });

  it('세션 종류별 합을 낸다', () => {
    const report = build({ pricing: byModelPricing });

    expect(report.kinds.map((entry) => entry.kind)).toEqual(['normal', 'lane', 'fleet']);
    expect(report.kinds.find((entry) => entry.kind === 'lane')).toMatchObject({ sessions: 1, requests: 1, usage: { inputTokens: 500, outputTokens: 20 } });
    expect(report.kinds.find((entry) => entry.kind === 'fleet')).toMatchObject({ sessions: 1, requests: 2 });
  });

  it('기간을 주면 그 기간의 실행만 세고, 시각을 남기지 않은 실행은 뺐다고 알린다', () => {
    const report = build({ range: { from: '2026-09-02', to: '2026-09-02' } });

    expect(report.range).toEqual({ from: '2026-09-02T00:00:00.000Z', to: '2026-09-02T23:59:59.999Z' });
    expect(report.requests).toHaveLength(1);
    expect(report.requests[0]!.sessionId).toBe('s-lane');
    expect(report.totals).toEqual({ inputTokens: 500, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(report.notes).toContain('시각을 남기지 않은 실행 2개는 기간 필터에서 뺐습니다');
  });

  it('빈 프로젝트는 0으로 시작하고 요청이 없다', () => {
    const report = buildProjectTokenReport({ projectId: 'new', projectName: 'new', generatedAt: '2026-09-03T00:00:00.000Z', sessions: [] });

    expect(report.sessions).toBe(0);
    expect(report.requests).toEqual([]);
    expect(report.totals).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(report.modelCalls).toBe(0);
    expect(report.cacheHitRatio).toBe(0);
    expect(report.kinds).toEqual([]);
    expect(report.priceSource).toBe('none');
    expect(report.priceNote).toBe('단가 미설정');
    expect(report.notes).toEqual([]);
  });

  it('마크다운으로 과제 README에 붙일 보고서를 만든다', () => {
    const report = build({
      pricing: byModelPricing,
      range: { from: '2026-09-01', to: '2026-09-02' },
      sessions: [{ sessionId: 's-normal', kind: 'normal', events: changedSession() }],
    });

    expect(projectTokenMarkdown(report)).toBe(`# b-studio 토큰 사용 보고서 — orders

- 프로젝트: \`orders\`
- 기간: 2026-09-01 ~ 2026-09-02
- 만든 시각: 2026-09-03 00:00 UTC
- 세션: 1개 (일반 1)

## 요약

| 항목 | 값 |
| --- | --- |
| 총 토큰 | 33,210 |
| 입력 | 3,000 |
| 캐시 읽기 | 30,000 |
| 캐시 쓰기 | 100 |
| 출력 | 110 |
| 환산 비용 | $0.0178 (모델별 단가) |
| 요청 수 | 1 |
| 모델 호출 수 | 2 |
| 캐시 적중률 | 90.6% |

## 모델별

| 모델 | 입력 | 캐시 읽기 | 캐시 쓰기 | 출력 | 비용 |
| --- | --- | --- | --- | --- | --- |
| \`haiku\` | 1,000 | 0 | 0 | 50 | $0.0015 |
| \`sonnet\` | 2,000 | 30,000 | 100 | 60 | $0.0163 |

## 줄인 양 (측정)

기록에 남은 사실입니다. 아래 추정 절과 섞지 마세요.

| 항목 | 값 |
| --- | --- |
| 도구 결과 예산이 잘라낸 글자 | 2,780자 |
| 앞과 같은 결과를 참조로 대체 | 1회 |
| 묶어서 비운 도구 결과 | 2개 · 1,200자 |
| 가볍게 확인으로 끝난 실행 | 0회 |

## 줄인 토큰 (추정)

- 잘린 결과가 남은 호출마다 다시 읽혔을 양: **1,195 토큰**
- 환산 금액: $0.0004 (캐시 읽기 단가 · sonnet 기준)
- 방식: ${TRIM_ESTIMATE_METHOD}
- 이 값은 **추정**입니다. 자르지 않았다면 그 글자가 남은 호출마다 다시 실려 갔을 양을 근사한 값이라, 위의 측정값과 다릅니다.

## 요청별 (최근 순, 최대 50)

| 시각 (UTC) | 세션 | 요청 | 토큰 | 비용 | 노력 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-01 10:00 UTC | 일반 · s-normal | 주문 목록에 필터를 추가하고 테스트를 돌려줘 | 33,210 | $0.0178 | — | 바꿈 |

비용은 공식 단가로 환산한 추정치이며 구독 요금과 다릅니다
`);
  });

  it('요청별 표는 최근 순으로 최대 50줄만 적는다', () => {
    const many: StudioEvent[] = [];
    for (let index = 0; index < 60; index += 1) {
      many.push({ type: 'run_started', runId: `m${index}`, request: `요청 ${index}` });
      many.push(usageEvent(`2026-09-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`));
      many.push({ type: 'run_finished', runId: `m${index}`, status: 'done', summary: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    }
    const report = buildProjectTokenReport({ projectId: 'orders', projectName: 'orders', generatedAt: '2026-09-03T00:00:00.000Z', sessions: [{ sessionId: 's', kind: 'normal', events: many }] });
    const markdown = projectTokenMarkdown(report);

    expect(report.requests).toHaveLength(60);
    // 최신 실행이 먼저 온다
    expect(report.requests[0]!.request).toBe('요청 59');
    expect(markdown).toContain('| 요청 59 |');
    expect(markdown).not.toContain('| 요청 9 |');
    expect(markdown).toContain('(최근 50개만 적었습니다. 전체 60개)');
  });

  it('형식이 틀린 기간은 400으로 알린다', () => {
    expect(() => build({ range: { from: '어제' } })).toThrow(StudioError);
    expect(() => rangeBounds({ from: '2026-09-02', to: '2026-09-01' })).toThrow(/from은 to보다 앞이어야 합니다/);
  });
});

describe('runTimestamps', () => {
  it('실행마다 첫 기록 시각을 찾고, 없으면 비워 둔다', () => {
    const times = runTimestamps([
      { type: 'run_started', runId: 'a', request: '1' },
      { type: 'log', service: 'web', text: '켜는 중', at: '2026-09-01T10:00:00.000Z' },
      { type: 'log', service: 'web', text: '또', at: '2026-09-01T10:00:05.000Z' },
      { type: 'run_finished', runId: 'a', status: 'done', summary: 'ok' },
      { type: 'run_started', runId: 'b', request: '2' },
      { type: 'run_finished', runId: 'b', status: 'done', summary: 'ok' },
    ]);

    expect(times.get('a')).toBe('2026-09-01T10:00:00.000Z');
    expect(times.has('b')).toBe(false);
  });

  it('run_started에 시각이 있으면 뒤의 로그보다 그 값을 쓴다', () => {
    const times = runTimestamps([
      { type: 'run_started', runId: 'a', request: '1', at: '2026-09-01T09:59:58.000Z' },
      { type: 'log', service: 'web', text: '켜는 중', at: '2026-09-01T10:00:00.000Z' },
      { type: 'run_finished', runId: 'a', status: 'done', summary: 'ok' },
    ]);

    expect(times.get('a')).toBe('2026-09-01T09:59:58.000Z');
  });
});
