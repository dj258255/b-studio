import { describe, expect, it } from 'vitest';
import type { TaskPlanMetrics } from '../../lib/task-plan-metrics';
import { summarize, type BenchRow, type SummaryMeta } from './summary';

const meta: SummaryMeta = { backend: 'openai', requestedModel: 'test-model' };

function metrics(over: Partial<TaskPlanMetrics> = {}): TaskPlanMetrics {
  return {
    endToEndMs: 1_000,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    modelCalls: 0,
    maxContextTokens: 0,
    bootMsTotal: 0,
    bootMsMax: 0,
    bootRxBytesTotal: 0,
    modelMs: 0,
    toolMs: 0,
    gateMs: 0,
    sessions: 1,
    ...over,
  };
}

function row(over: Partial<BenchRow>): BenchRow {
  return {
    escalation: { after: 2, retryBudget: 2, escalated: false },
    order: 0,
    repeat: 1,
    taskId: 'orders-list',
    coupled: true,
    strategy: 'S0',
    model: 'm',
    observedModels: [],
    startedAt: '',
    finishedAt: '',
    planStatus: 'done',
    lanes: [],
    traces: [],
    explore: { filesReadTotal: 0, filesReadUnionAcrossLanes: 0, readCallsTotal: 0 },
    failures: { signaturesTotal: 0, distinctSignatures: 0, repeatedFailures: 0 },
    contextCleared: { count: 0, chars: 0 },
    integrationChecks: false,
    verify: 'full',
    success: true,
    category: 'none',
    detail: '',
    proxy: { forwardedCalls: 0, requestBytes: 0, responseBytes: 0, plannerCalls: 0, upstreamErrors: 0 },
    leftoverContainers: [],
    estimatedCostUsd: 0,
    ...over,
  };
}

const rows: BenchRow[] = [
  row({
    taskId: 'orders-list',
    strategy: 'S0',
    success: true,
    metrics: metrics({ endToEndMs: 30_000, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, modelCalls: 5, maxContextTokens: 1_000, bootMsTotal: 5_000 }),
    lanes: [{ id: 'lane-1', sessionId: 's1', status: 'done', tasks: [] }],
    explore: { filesReadTotal: 4, filesReadUnionAcrossLanes: 3, readCallsTotal: 6 },
    failures: { signaturesTotal: 1, distinctSignatures: 1, repeatedFailures: 0 },
    contextCleared: { count: 2, chars: 24_000 },
  }),
  row({
    taskId: 'orders-list',
    strategy: 'S0',
    success: false,
    category: 'lane_gate',
    metrics: undefined,
    lanes: [{ id: 'lane-1', sessionId: 's2', status: 'failed', tasks: [] }],
    explore: { filesReadTotal: 2, filesReadUnionAcrossLanes: 2, readCallsTotal: 2 },
    failures: { signaturesTotal: 3, distinctSignatures: 1, repeatedFailures: 2 },
  }),
  row({
    taskId: 'orders-list',
    strategy: 'S1',
    success: true,
    metrics: metrics({ endToEndMs: 20_000, usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, modelCalls: 4, maxContextTokens: 900, bootMsTotal: 4_000 }),
  }),
  row({
    taskId: 'independent',
    coupled: false,
    strategy: 'S0',
    success: true,
    metrics: metrics({ endToEndMs: 10_000, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, modelCalls: 3, maxContextTokens: 500, bootMsTotal: 2_000 }),
  }),
  row({ taskId: 'independent', coupled: false, strategy: 'S1', success: true, metrics: undefined }),
  row({ taskId: 'independent', coupled: false, strategy: 'S1', success: true, metrics: undefined }),
];

describe('summarize', () => {
  it('과제·전략별 성공 건수와 중앙값을 낸다', () => {
    const markdown = summarize(rows, meta);

    // orders-list S0: 2회 중 1회 성공, 값이 있는 실행만으로 중앙값을 낸다. 기동 수신은 0KiB
    // 비운 도구 결과는 [2, 0]의 중앙값 1이다
    expect(markdown).toContain('| orders-list | O | S0 | 1/2 | 110 | 30.0 | 100 | 10 | 5 | 1,000 | 5.0 | 0KiB | 3 | 2 | 1 | — | 1 |');
    // 나머지 행은 레인 세션이 없어 탐색·실패 열이 —다
    expect(markdown).toContain('| orders-list | O | S1 | 1/1 | 220 | 20.0 | 200 | 20 | 4 | 900 | 4.0 | 0KiB | — | — | — | — | — |');
    expect(markdown).toContain('| independent | X | S0 | 1/1 | 55 | 10.0 | 50 | 5 | 3 | 500 | 2.0 | 0KiB | — | — | — | — | — |');
  });

  it('탐색·실패 열을 표 1에 더한다', () => {
    const markdown = summarize(rows, meta);
    expect(markdown).toContain('| 기동 시간 합 중앙값(s) | 기동 수신(중앙값) | 읽은 파일 수 중앙값 | 실패 서명 중앙값 | 반복 실패 중앙값 | 게시·읽기 바이트 중앙값 | 비운 도구 결과 중앙값 |');
  });

  it('기동 수신(중앙값) 열에 bootRxBytesTotal 중앙값을 사람이 읽는 크기로 낸다', () => {
    const markdown = summarize(
      [
        row({ taskId: 'orders-list', strategy: 'S0', metrics: metrics({ bootRxBytesTotal: 1_048_576 }) }),
        row({ taskId: 'orders-list', strategy: 'S0', metrics: metrics({ bootRxBytesTotal: 3 * 1_048_576 }) }),
      ],
      meta,
    );
    // 중앙값 = 2MiB
    expect(markdown).toContain('| orders-list | O | S0 | 2/2 |');
    expect(markdown).toContain('| 2.0MiB |');

    expect(summarize([row({ metrics: metrics({ bootRxBytesTotal: 2_048 }) })], meta)).toContain('| 2KiB |');
  });

  it('레인 세션이 없던 실행은 탐색·실패 중앙값에서 뺀다', () => {
    const markdown = summarize(
      [
        row({
          taskId: 'orders-list',
          strategy: 'S0',
          lanes: [{ id: 'lane-1', sessionId: 's1', status: 'done', tasks: [] }],
          explore: { filesReadTotal: 10, filesReadUnionAcrossLanes: 10, readCallsTotal: 10 },
          failures: { signaturesTotal: 4, distinctSignatures: 4, repeatedFailures: 0 },
        }),
        // 세션을 만들기 전에 실패한 실행: 값이 0이어도 중앙값에 섞지 않는다
        row({
          taskId: 'orders-list',
          strategy: 'S0',
          success: false,
          category: 'plan_rejected',
          lanes: [],
          explore: { filesReadTotal: 0, filesReadUnionAcrossLanes: 0, readCallsTotal: 0 },
          failures: { signaturesTotal: 0, distinctSignatures: 0, repeatedFailures: 0 },
        }),
      ],
      meta,
    );
    expect(markdown).toContain('| orders-list | O | S0 | 1/2 | — | — | — | — | — | — | — | — | 10 | 4 | 0 | — | 0 |');
  });

  it('값이 하나도 없으면 —로 둔다', () => {
    const markdown = summarize(rows, meta);
    // independent S1의 두 실행 모두 metrics가 없다. 레인 세션도 없어 탐색·실패 열까지 —다
    expect(markdown).toContain('| independent | X | S1 | 2/2 | — | — | — | — | — | — | — | — | — | — | — |');
  });

  it('전략별 실패 원인에 rate_limited 열을 포함해 건수로 센다', () => {
    const markdown = summarize(rows, meta);
    // 열 순서: none | plan_rejected | scope_violation | lane_gate | integration_gate | acceptance | rate_limited | provider_gate | environment | timeout | unknown
    expect(markdown).toContain('| 전략 | none | plan_rejected | scope_violation | lane_gate | integration_gate | acceptance | rate_limited | provider_gate | environment | timeout | unknown |');
    // S0: none 2 (orders-list, independent), lane_gate 1
    expect(markdown).toContain('| S0 | 2 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
    // S1: none 3
    expect(markdown).toContain('| S1 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');

    const limited = summarize([row({ category: 'rate_limited', success: false })], meta);
    expect(limited).toContain('| S0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |');
    const gated = summarize([row({ category: 'provider_gate', success: false })], meta);
    expect(gated).toContain('| S0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |');
  });

  it('계약 호출 토큰을 성공 1건당 토큰에 포함하고, 계약 출처를 맨 위에 적는다', () => {
    const markdown = summarize(
      [
        row({
          taskId: 'orders-list',
          strategy: 'S2',
          success: true,
          metrics: metrics({ usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
          contracts: { source: 'model', count: 1, usage: { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        }),
      ],
      { ...meta, contracts: 'model' },
    );

    // (100+10) + 계약(40+4) = 154 / 성공 1건. 빼면 모델 계약이 공짜처럼 보인다
    expect(markdown).toContain('| orders-list | O | S2 | 1/1 | 154 |');
    expect(markdown).toContain('계약 model');

    // 사람 계약은 호출이 없어 usage가 없다 → 계약 토큰을 더하지 않는다
    const human = summarize(
      [row({ taskId: 'orders-list', strategy: 'S2', success: true, metrics: metrics({ usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }), contracts: { source: 'human', count: 1 } })],
      meta,
    );
    expect(human).toContain('| orders-list | O | S2 | 1/1 | 110 |');
    expect(human).toContain('계약 human');
  });

  it('맨 위에 백엔드·요청한 모델·관측한 모델·실행 수를 적는다', () => {
    const withObserved = [
      row({ observedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'] }),
      row({ observedModels: ['claude-sonnet-4-5'] }),
    ];
    expect(summarize(withObserved, { backend: 'claude-code', requestedModel: 'sonnet' })).toContain(
      '백엔드 claude-code · 요청한 모델 sonnet · 관측한 모델 claude-sonnet-4-5, claude-haiku-4-5 · 실행 2회',
    );
    // 관측한 모델이 없으면 '없음'
    expect(summarize([row({})], meta)).toContain('관측한 모델 없음 · 실행 1회');
  });

  it('맨 위에 검증 범위(--verify)를 적는다. 기본은 full', () => {
    expect(summarize([row({})], meta)).toContain('검증 full');
    expect(summarize([row({ verify: 'light' })], { ...meta, verify: 'light' })).toContain('검증 light(가볍게)');
  });

  it('계획-실행 분리(ADR-075)를 설정했으면 맨 위 줄에 계획·실행 모델을 적고, 설정하지 않으면 아무것도 더하지 않는다', () => {
    expect(summarize([row({})], meta)).not.toContain('계획-실행 분리');
    expect(summarize([row({})], { ...meta, planModel: 'opus' })).toContain('계획-실행 분리: 계획 opus → 실행 test-model');
    expect(summarize([row({})], { ...meta, planModel: 'opus', executeModel: 'haiku' })).toContain('계획-실행 분리: 계획 opus → 실행 haiku');
  });

  it('계획 호출이 남긴 계획 원문이 있으면 건수·평균 길이 줄을 더하고, 없으면 더하지 않는다', () => {
    expect(summarize([row({})], meta)).not.toContain('계획 호출');

    const withBriefs = summarize(
      [
        row({
          planExecute: { plan: 'opus', execute: 'haiku' },
          planBriefs: [
            { sessionId: 's1', runId: 'run-1', model: 'opus', text: 'a'.repeat(100), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 10 },
          ],
        }),
        row({
          planExecute: { plan: 'opus', execute: 'haiku' },
          planBriefs: [
            { sessionId: 's2', runId: 'run-2', model: 'opus', text: 'b'.repeat(200), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 20 },
          ],
        }),
      ],
      { ...meta, planModel: 'opus', executeModel: 'haiku' },
    );
    // 평균 길이 = (100 + 200) / 2 = 150
    expect(withBriefs).toContain('계획 호출 2건, 계획 글 평균 길이 150자.');
  });

  it('claude-code 백엔드면 modelMs 한계 줄을 더한다', () => {
    const local = summarize([row({})], { backend: 'claude-code', requestedModel: 'sonnet' });
    expect(local).toContain('Codex·Gemini CLI는 재지 못해 들어가지 않습니다');
    expect(summarize([row({})], meta)).not.toContain('modelMs`가 0입니다');
  });

  it('한계 문구를 표 아래에 넣는다', () => {
    expect(summarize(rows, meta)).toContain('반복 수가 적어 비율 대신 건수로 적습니다. 이 결과는 이 저장소·이 모델·이 과제에 한정됩니다.');
  });

  it('행이 없으면 표 머리만 낸다', () => {
    const markdown = summarize([], meta);
    expect(markdown).toContain('| 과제 | 엮임 | 전략 | 성공 |');
    expect(markdown).not.toContain('orders-list');
  });

  it('탐색·실패·조율 열을 표 1에 더한다', () => {
    const markdown = summarize(rows, meta);
    expect(markdown).toContain('| 기동 시간 합 중앙값(s) | 기동 수신(중앙값) | 읽은 파일 수 중앙값 | 실패 서명 중앙값 | 반복 실패 중앙값 | 게시·읽기 바이트 중앙값 | 비운 도구 결과 중앙값 |');
  });

  it('조율 게시판의 읽은 바이트 중앙값을 낸다', () => {
    const markdown = summarize(
      [
        row({
          strategy: 'S3',
          coordination: { strategy: 'S3', topology: 'mesh', posts: 2, rejected: 0, reads: 3, bytesRead: 4_096, byKind: { contract: 1, failure: 0, fact: 1 } },
        }),
      ],
      meta,
    );
    expect(markdown).toContain('| S3 | 1/1 |');
    expect(markdown).toContain('| 4,096 |');
  });

  it('승격 건수 열에 escalated 실행 수를 센다', () => {
    const markdown = summarize(
      [
        row({ taskId: 'orders-list', strategy: 'S0', escalation: { to: 'sonnet', after: 2, retryBudget: 2, escalated: true, attempt: 2 } }),
        row({ taskId: 'orders-list', strategy: 'S0', escalation: { to: 'sonnet', after: 2, retryBudget: 2, escalated: false } }),
        row({ taskId: 'orders-list', strategy: 'S0' }),
      ],
      meta,
    );
    expect(markdown).toMatch(/\| \S+ 건수 \|/);
    expect(markdown).toContain('| orders-list | O | S0 | 3/3 | — | — | — | — | — | — | — | — | — | — | — | — | — | 1 |');
  });

  it('수리 열에 S4 수리를 요청한 실행 수와 수리가 done으로 끝난 수를 낸다', () => {
    const markdown = summarize(
      [
        row({ taskId: 'orders-list', strategy: 'S4', integration: { status: 'done', repair: { attempted: true, status: 'done' } } }),
        row({ taskId: 'orders-list', strategy: 'S4', integration: { status: 'failed', repair: { attempted: true, status: 'failed' } } }),
        row({ taskId: 'orders-list', strategy: 'S4', integration: { status: 'done' } }),
      ],
      meta,
    );
    expect(markdown).toContain('| 수리(시도/성공) |');
    expect(markdown).toMatch(/\| orders-list \| O \| S4 \| .*\| 0 \| 2\/1 \| — \|/);
  });

  it('API 환산 비용 열에 costUsd가 있는 실행만으로 합계/중앙값을 낸다', () => {
    const markdown = summarize(
      [
        row({ taskId: 'orders-list', strategy: 'S0', costUsd: 0.01 }),
        row({ taskId: 'orders-list', strategy: 'S0', costUsd: 0.03 }),
        row({ taskId: 'orders-list', strategy: 'S0' }),
      ],
      meta,
    );
    expect(markdown).toContain('| API 환산 비용($) |');
    expect(markdown).toContain('| orders-list | O | S0 | 3/3 | — | — | — | — | — | — | — | — | — | — | — | — | — | 0 | 0/0 | 0.0400 / 0.0200 |');
    // costUsd가 하나도 없으면 —로 둔다
    expect(summarize([row({})], meta)).toContain('| orders-list | O | S0 | 1/1 | — | — | — | — | — | — | — | — | — | — | — | — | — | 0 | 0/0 | — |');
  });

  it('성공 1건당 토큰은 (입력+캐시+출력) 합을 성공 수로 나누고, 성공이 없으면 —다', () => {
    const markdown = summarize(
      [
        row({ taskId: 'orders-list', strategy: 'P0', success: true, metrics: metrics({ usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 } }) }),
        row({
          taskId: 'orders-list',
          strategy: 'P0',
          success: false,
          category: 'acceptance',
          metrics: metrics({ usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
        }),
      ],
      meta,
    );
    // (100+20+5+10) + (50+0+0+5) = 190 / 성공 1건 = 190
    expect(markdown).toContain('| orders-list | O | P0 | 1/2 | 190 |');

    const none = summarize(
      [row({ taskId: 'order-detail', strategy: 'P0', success: false, category: 'acceptance', metrics: metrics({ usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }) })],
      meta,
    );
    expect(none).toContain('| order-detail | O | P0 | 0/1 | — |');
  });
});

describe('레인 백엔드 열(--lane-backend)', () => {
  it('레인별 backend·model을 레인 그룹과 함께 적는다', () => {
    const markdown = summarize(
      [
        row({
          taskId: 'orders-list',
          strategy: 'S1',
          lanes: [
            { id: 'lane-1', sessionId: 's1', status: 'done', group: 'api', backend: 'claude-code', model: 'sonnet', tasks: [] },
            { id: 'lane-2', sessionId: 's2', status: 'done', group: 'web', backend: 'commandcode', tasks: [] },
          ],
        }),
      ],
      meta,
    );

    expect(markdown).toContain('레인 백엔드');
    expect(markdown).toContain('api:claude-code:sonnet web:commandcode');
  });

  it('고른 레인이 없으면 —로 둔다', () => {
    const markdown = summarize([row({ taskId: 'orders-list', strategy: 'S1', lanes: [{ id: 'lane-1', sessionId: 's1', status: 'done', tasks: [] }] })], meta);
    expect(markdown.split('\n').find((line) => line.includes('orders-list'))).toContain('| — |');
  });
});

describe('테스트를 건넨 실행(handoff) 열', () => {
  const handoff = (over: Partial<NonNullable<BenchRow['handoff']>> = {}): NonNullable<BenchRow['handoff']> => ({
    variant: 'conflict',
    protected: false,
    file: 'api/src/test/java/com/example/api/OrdersListHandoffTest.java',
    changed: false,
    writeAttempts: 0,
    denied: 0,
    apiUnit: 'fail',
    ...over,
  });
  const headerOf = (markdown: string) => markdown.split('\n').find((line) => line.startsWith('| 과제 |'))!;

  it('handoff가 있는 행이 하나도 없으면 요약은 글자까지 예전과 같다(열을 더하지 않는다)', () => {
    const markdown = summarize(
      [
        row({ taskId: 'orders-list', strategy: 'S0', metrics: metrics({ endToEndMs: 30_000 }) }),
        row({ taskId: 'orders-list', strategy: 'S1', success: false, category: 'acceptance', metrics: metrics({ endToEndMs: 50_000 }) }),
      ],
      meta,
    );
    expect(markdown).toMatchInlineSnapshot(`
      "# 협업 벤치마크 요약

      백엔드 openai · 요청한 모델 test-model · 관측한 모델 없음 · 실행 2회 · 검증 full · 컨텍스트 비우기 off · 계약 human

      ## 과제 × 전략

      | 과제 | 엮임 | 전략 | 성공 | 성공 1건당 토큰 | 종단 시간 중앙값(s) | 입력 토큰 중앙값 | 출력 토큰 중앙값 | 모델 호출 중앙값 | 최대 컨텍스트 중앙값 | 기동 시간 합 중앙값(s) | 기동 수신(중앙값) | 읽은 파일 수 중앙값 | 실패 서명 중앙값 | 반복 실패 중앙값 | 게시·읽기 바이트 중앙값 | 비운 도구 결과 중앙값 | 승격 건수 | 수리(시도/성공) | API 환산 비용($) | 레인 백엔드 |
      |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
      | orders-list | O | S0 | 1/1 | 0 | 30.0 | 0 | 0 | 0 | 0 | 0.0 | 0KiB | — | — | — | — | — | 0 | 0/0 | — | — |
      | orders-list | O | S1 | 0/1 | — | 50.0 | 0 | 0 | 0 | 0 | 0.0 | 0KiB | — | — | — | — | — | 0 | 0/0 | — | — |

      ## 전략별 실패 원인

      | 전략 | none | plan_rejected | scope_violation | lane_gate | integration_gate | acceptance | rate_limited | provider_gate | environment | timeout | unknown |
      |---|---|---|---|---|---|---|---|---|---|---|---|
      | S0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
      | S1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |

      반복 수가 적어 비율 대신 건수로 적습니다. 이 결과는 이 저장소·이 모델·이 과제에 한정됩니다.
      "
    `);
    expect(markdown).not.toContain('건넨 테스트');
  });

  it('하나라도 있으면 열 5개를 표 끝에 더하고, 건넨 테스트가 없는 행은 —로 둔다', () => {
    const markdown = summarize(
      [
        row({ taskId: 'orders-list', strategy: 'S0', handoff: handoff({ changed: true, writeAttempts: 2, denied: 1, apiUnit: 'pass' }) }),
        row({ taskId: 'orders-list', strategy: 'S0', repeat: 2, handoff: handoff({ changed: false, writeAttempts: 0, denied: 0, apiUnit: 'fail' }) }),
        row({ taskId: 'order-detail', strategy: 'S0' }),
      ],
      meta,
    );
    const header = headerOf(markdown);
    expect(header.endsWith('| 건넨 테스트 | 파일 바뀜 | 쓰기 시도 합 | 보호 거절 합 | api-unit 통과 |')).toBe(true);
    const listLine = markdown.split('\n').find((line) => line.startsWith('| orders-list'))!;
    expect(listLine.endsWith('| conflict | 1/2 | 2 | 1 | 1/2 |')).toBe(true);
    const detailLine = markdown.split('\n').find((line) => line.startsWith('| order-detail'))!;
    expect(detailLine.endsWith('| — | — | — | — | — |')).toBe(true);
  });

  it('보호를 켠 실행은 변형 뒤에 +protect를 붙인다', () => {
    const markdown = summarize([row({ taskId: 'orders-list', strategy: 'S0', handoff: handoff({ protected: true }) })], meta);
    expect(markdown.split('\n').find((line) => line.startsWith('| orders-list'))!).toContain('| conflict+protect |');
  });

  it('unknown은 0이나 false로 합치지 않고 따로 적는다', () => {
    const markdown = summarize(
      [
        row({ taskId: 'orders-list', strategy: 'S0', handoff: handoff({ changed: 'unknown', writeAttempts: 'unknown', denied: 'unknown', apiUnit: 'unknown' }) }),
        row({ taskId: 'orders-list', strategy: 'S0', repeat: 2, handoff: handoff({ changed: true, writeAttempts: 3, denied: 2, apiUnit: 'pass' }) }),
        row({ taskId: 'orders-list', strategy: 'S0', repeat: 3, handoff: handoff({ changed: false, writeAttempts: 0, denied: 0, apiUnit: 'fail' }) }),
      ],
      meta,
    );
    const line = markdown.split('\n').find((candidate) => candidate.startsWith('| orders-list'))!;
    expect(line.endsWith('| conflict | 1/3 (모름 1) | 3 (모름 1) | 2 (모름 1) | 1/3 (모름 1) |')).toBe(true);
  });

  it('모든 값을 모르면 0이 아니라 모름으로 적는다', () => {
    const markdown = summarize(
      [row({ taskId: 'orders-list', strategy: 'S0', handoff: handoff({ changed: 'unknown', writeAttempts: 'unknown', denied: 'unknown', apiUnit: 'unknown' }) })],
      meta,
    );
    const line = markdown.split('\n').find((candidate) => candidate.startsWith('| orders-list'))!;
    expect(line.endsWith('| conflict | 모름 | 모름 | 모름 | 모름 |')).toBe(true);
  });
});
