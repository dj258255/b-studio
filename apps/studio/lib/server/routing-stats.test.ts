import { describe, expect, it } from 'vitest';
import { taskKindLabel, UNKNOWN_KIND, UNKNOWN_MODEL_LABEL } from '../routing-types';
import type { StudioEvent } from '../studio-events';
import { buildRoutingStats } from './routing-stats';

/**
 * AI별 결과표(#821). 세션 기록만 읽어 백엔드 × 시작 모델 × 작업 종류로 모은다.
 * 손으로 센 값과 같은지, 플랫폼 실패와 질문이 AI의 성적에 섞이지 않는지 본다.
 */
const usage = { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
const simple = { complexity: 'simple', risk: 'normal' } as const;
const risky = { complexity: 'normal', risk: 'high' } as const;

function started(runId: string, extra: Partial<Extract<StudioEvent, { type: 'run_started' }>> = {}): StudioEvent {
  return { type: 'run_started', runId, request: `요청 ${runId}`, at: '2026-10-22T00:00:00.000Z', ...extra };
}

function finished(runId: string, status: 'done' | 'failed' | 'error' | 'cancelled' | 'awaiting_input', durationMs = 1_000): StudioEvent {
  return { type: 'run_finished', runId, status, summary: '', usage, durationMs };
}

function checkpoint(runId: string): StudioEvent {
  return { type: 'checkpoint', runId, checkpoint: { sha: `sha-${runId}`, shortSha: runId, message: '', files: ['a.ts'], createdAt: '2026-10-22T00:00:01.000Z' } } as StudioEvent;
}

function verifyResult(runId: string, ok: boolean, platformFailure?: string): StudioEvent {
  return { type: 'agent', runId, event: { type: 'verify_result', report: { ok, ...(platformFailure ? { platformFailure } : {}) } } } as unknown as StudioEvent;
}

describe('buildRoutingStats', () => {
  it('백엔드 × 시작 모델 × 작업 종류로 통과·실패·오류를 센다', () => {
    const stats = buildRoutingStats({
      sessions: [
        {
          sessionId: 's1',
          backend: 'claude-code',
          events: [
            started('a', { backend: 'claude-code', model: 'sonnet', taskKind: simple }),
            checkpoint('a'),
            finished('a', 'done', 1_000),
            started('b', { backend: 'claude-code', model: 'sonnet', taskKind: simple }),
            verifyResult('b', false),
            finished('b', 'failed', 3_000),
            started('c', { backend: 'claude-code', model: 'sonnet', taskKind: simple }),
            checkpoint('c'),
            finished('c', 'done', 2_000),
          ],
        },
        {
          sessionId: 's2',
          backend: 'codex',
          events: [started('d', { backend: 'codex', taskKind: risky }), finished('d', 'error')],
        },
      ],
    });

    const sonnet = stats.rows.find((row) => row.backend === 'claude-code');
    expect(sonnet).toMatchObject({ model: 'sonnet', kind: simple, runs: 3, passed: 2, failed: 1, errors: 0, platformFailures: 0, noChange: 0 });
    expect(sonnet?.passRate).toBeCloseTo(2 / 3);
    expect(sonnet?.medianDurationMs).toBe(2_000);

    const codex = stats.rows.find((row) => row.backend === 'codex');
    expect(codex).toMatchObject({ model: UNKNOWN_MODEL_LABEL, kind: risky, runs: 1, passed: 0, failed: 0, errors: 1 });
    expect(codex?.passRate).toBe(0);
  });

  it('플랫폼 쪽 실패는 그 AI의 실패로 세지 않고 통과율에서 뺀다', () => {
    const stats = buildRoutingStats({
      sessions: [
        {
          sessionId: 's1',
          backend: 'claude-code',
          events: [
            started('a', { backend: 'claude-code', model: 'sonnet', taskKind: simple }),
            verifyResult('a', false, 'docker compose up 실패'),
            finished('a', 'failed'),
            started('b', { backend: 'claude-code', model: 'sonnet', taskKind: simple }),
            checkpoint('b'),
            finished('b', 'done'),
          ],
        },
      ],
    });
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]).toMatchObject({ runs: 2, passed: 1, failed: 0, platformFailures: 1 });
    expect(stats.rows[0]?.passRate).toBe(1);
  });

  it('질문, 취소, 되묻기, 끝나지 않은 실행은 세지 않고 따로 알린다', () => {
    const stats = buildRoutingStats({
      sessions: [
        {
          sessionId: 's1',
          backend: 'claude-code',
          events: [
            started('q', { intent: 'ask', backend: 'claude-code', taskKind: simple }),
            finished('q', 'done'),
            started('x', { backend: 'claude-code', taskKind: simple }),
            finished('x', 'cancelled'),
            started('w', { backend: 'claude-code', taskKind: simple }),
            finished('w', 'awaiting_input'),
            started('r', { backend: 'claude-code', taskKind: simple }),
          ],
        },
      ],
    });
    expect(stats.rows).toEqual([]);
    expect(stats.excluded).toEqual({ asks: 1, unfinished: 3 });
  });

  it('바꾼 파일 없이 끝난 만들기 요청은 통과로 세지 않고 따로 센다', () => {
    const stats = buildRoutingStats({
      sessions: [{ sessionId: 's1', backend: 'claude-code', events: [started('a', { backend: 'claude-code', model: 'sonnet', taskKind: simple }), finished('a', 'done')] }],
    });
    expect(stats.rows[0]).toMatchObject({ runs: 1, passed: 0, noChange: 1 });
    expect(stats.rows[0]?.passRate).toBeUndefined();
  });

  it('새 필드가 없는 옛 기록은 세션의 백엔드로 채우고, 모델은 사용량의 가장 큰 모델로, 종류는 모름으로 센다', () => {
    const stats = buildRoutingStats({
      sessions: [
        {
          sessionId: 'old',
          backend: 'api',
          events: [
            started('a'),
            checkpoint('a'),
            {
              type: 'run_finished',
              runId: 'a',
              status: 'done',
              summary: '',
              usage,
              metrics: {
                modelCalls: 2,
                maxContextTokens: 0,
                toolMs: 0,
                gateMs: 0,
                usageByModel: {
                  '계획: claude-opus': { ...usage, inputTokens: 9_000 },
                  'claude-haiku': { ...usage, inputTokens: 10 },
                  'claude-sonnet': usage,
                },
              },
            },
          ],
        },
      ],
    });
    expect(stats.rows[0]).toMatchObject({ backend: 'api', model: 'claude-sonnet', kind: UNKNOWN_KIND, passed: 1 });
  });

  it('단가를 주면 실행별 환산 비용의 중앙값을 싣는다', () => {
    const stats = buildRoutingStats({
      pricing: { single: { inputPerM: 1, outputPerM: 10, cacheReadPerM: 0, cacheWritePerM: 0 } },
      sessions: [
        {
          sessionId: 's1',
          backend: 'claude-code',
          events: [
            started('a', { backend: 'claude-code', model: 'sonnet', taskKind: simple }),
            { type: 'tokens', runId: 'a', usage, sessionTokens: usage },
            checkpoint('a'),
            finished('a', 'done'),
          ],
        },
      ],
    });
    // 입력 1천 토큰 × $1/M + 출력 100 토큰 × $10/M = $0.002
    expect(stats.rows[0]?.medianCostUsd).toBeCloseTo(0.002);
  });

  it('작업 종류를 사람이 읽는 말로 바꾼다', () => {
    expect(taskKindLabel(simple)).toBe('단순');
    expect(taskKindLabel(risky)).toBe('보통 · 위험');
    expect(taskKindLabel({ complexity: 'complex', risk: 'normal' })).toBe('복잡');
    expect(taskKindLabel(UNKNOWN_KIND)).toBe('모름');
  });
});
