import type { LoadResult } from '@b-studio/sandbox';
import type { WorkflowLoadCheck } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { describeLoadExpect, judgeLoad, loadRequestFor } from './load-check';

const check = (over: Partial<WorkflowLoadCheck> = {}): WorkflowLoadCheck => ({
  name: 'orders-p95',
  service: 'api',
  method: 'POST',
  path: '/orders',
  concurrent: 1000,
  warmup: 0,
  expect: { p95Ms: 200 },
  ...over,
});

const result = (over: Partial<LoadResult> = {}): LoadResult => ({
  requests: 1000,
  concurrent: 1000,
  threads: 4,
  completed: 1000,
  elapsedMs: 640,
  statuses: { '201': 50, '409': 950 },
  errors: {},
  latency: { count: 1000, p50: 40.2, p95: 120.5, p99: 180.1, max: 199.9 },
  connect: { count: 1000, p50: 60, p95: 80.4, p99: 85, max: 90, errors: 0 },
  loopDelay: { p99: 3.1, max: 9.9 },
  warmup: { requests: 0, errors: 0 },
  ...over,
});

describe('loadRequestFor', () => {
  it('requests를 생략하면 연결마다 한 건을 보내고, latencyOf를 러너에 넘긴다', () => {
    expect(loadRequestFor(check({ expect: { p95Ms: 200, latencyOf: [409] } }))).toEqual({
      service: 'api',
      method: 'POST',
      path: '/orders',
      concurrent: 1000,
      requests: 1000,
      warmup: 0,
      latencyOf: [409],
    });
    expect(loadRequestFor(check({ requests: 5000, body: '{}', headers: { 'X-Key': '{{uuid}}' }, warmup: 20 }))).toMatchObject({ requests: 5000, body: '{}', headers: { 'X-Key': '{{uuid}}' }, warmup: 20 });
  });
});

describe('judgeLoad', () => {
  it('기준 안이면 통과하고, 판정에 쓴 값을 근거로 남긴다', () => {
    const judged = judgeLoad(check(), result());
    expect(judged.problems).toEqual([]);
    expect(judged.note).toContain('동시 1000 · 1000건 중 응답 1000건 (640ms, 초당 1563건)');
    expect(judged.note).toContain('상태 201:50, 409:950');
    expect(judged.note).toContain('p95 120.5ms');
    expect(judged.evidence).toEqual([
      '샌드박스 네트워크 안에서 POST /orders · 동시 1000 · 1000건 (640ms)',
      'p95 120.5ms (기준 200ms 이하, 1000건)',
      '상태 201:50, 409:950 · 응답을 받지 못한 요청 0건',
      '러너 밀림 p99 3.1ms · 연결 p95 80.4ms',
    ]);
  });

  it('기준과 같은 값은 통과, 넘으면 실패다', () => {
    expect(judgeLoad(check(), result({ latency: { count: 10, p50: 1, p95: 200, p99: 200, max: 200 } })).problems).toEqual([]);
    expect(judgeLoad(check(), result({ latency: { count: 10, p50: 1, p95: 200.1, p99: 300, max: 300 } })).problems).toEqual(['p95 200.1ms (기준: 200ms 이하)']);
  });

  it('기준을 여럿 적으면 넘긴 것을 모두 알린다', () => {
    const judged = judgeLoad(check({ expect: { p50Ms: 30, p95Ms: 100, p99Ms: 500, maxMs: 150 } }), result());
    expect(judged.problems).toEqual(['p50 40.2ms (기준: 30ms 이하)', 'p95 120.5ms (기준: 100ms 이하)', 'max 199.9ms (기준: 150ms 이하)']);
  });

  it('응답을 받지 못한 요청이 하나라도 있으면 응답 시간이 기준 안이어도 실패다', () => {
    const judged = judgeLoad(check(), result({ completed: 997, statuses: { '409': 997 }, errors: { TIMEOUT: 2, ECONNRESET: 1 }, latency: { count: 997, p50: 1, p95: 2, p99: 3, max: 4 } }));
    expect(judged.problems).toEqual(['응답을 받지 못한 요청 3건 (ECONNRESET:1, TIMEOUT:2)']);
  });

  it('응답 시간을 잴 응답이 없으면 실패다(확인하지 못한 기준을 통과로 세지 않는다)', () => {
    const judged = judgeLoad(check({ expect: { p95Ms: 200, latencyOf: [409] } }), result({ statuses: { '201': 1000 }, latency: { count: 0 } }));
    expect(judged.problems).toEqual(['응답 시간을 잴 409 응답이 없습니다 (기준: p95 200ms 이하, 409 응답만)']);
    expect(judged.note).toContain('응답 시간을 잴 409 응답 없음');
  });

  it('latencyOf를 주면 그 상태 코드의 응답만으로 쟀다는 것을 근거에 적는다', () => {
    const judged = judgeLoad(check({ expect: { p95Ms: 200, latencyOf: [409], successCount: { exactly: 50 }, allStatusIn: [201, 409] } }), result({ latency: { count: 950, p50: 10, p95: 30.6, p99: 32, max: 33 } }));
    expect(judged.problems).toEqual([]);
    expect(judged.evidence[1]).toBe('409 응답 p95 30.6ms (기준 200ms 이하, 950건)');
  });

  it('성공 건수와 상태 코드 기대가 어긋나면 실패다', () => {
    const judged = judgeLoad(check({ expect: { p95Ms: 200, successCount: { exactly: 50 }, allStatusIn: [201, 409] } }), result({ statuses: { '201': 51, '409': 940, '500': 9 } }));
    expect(judged.problems).toEqual(['성공 51/1000 (기대: 정확히 50)', '기대 밖 상태 코드: 500 (기대: 201, 409)']);
    expect(judgeLoad(check({ expect: { p95Ms: 200, successCount: { atMost: 10 } } }), result()).problems).toEqual(['성공 50/1000 (기대: 최대 10)']);
  });

  it('상태 코드 기대를 적지 않았어도 서버 오류는 통과로 세지 않는다(빨리 실패하는 서비스가 통과하지 않게)', () => {
    const broken = result({ statuses: { '500': 990, '503': 10 }, latency: { count: 1000, p50: 1, p95: 2, p99: 3, max: 4 } });
    expect(judgeLoad(check(), broken).problems).toEqual(['서버 오류 응답 1000건 (500:990, 503:10). 의도한 응답이면 expect.allStatusIn에 적으세요']);
    // latencyOf로 다른 상태 코드만 재도 마찬가지다
    expect(judgeLoad(check({ expect: { p95Ms: 200, latencyOf: [409] } }), result({ statuses: { '409': 1, '500': 999 }, latency: { count: 1, p50: 1, p95: 1, p99: 1, max: 1 } })).problems).toEqual([
      '서버 오류 응답 999건 (500:999). 의도한 응답이면 expect.allStatusIn에 적으세요',
    ]);
    // 일부러 받는 것이면 적으면 된다. 4xx는 막지 않는다(거절 응답을 재는 것이 흔하다)
    expect(judgeLoad(check({ expect: { p95Ms: 200, allStatusIn: [503] } }), result({ statuses: { '503': 1000 } })).problems).toEqual([]);
    expect(judgeLoad(check(), result({ statuses: { '429': 1000 } })).problems).toEqual([]);
  });

  it('기준을 넘겼고 러너가 많이 밀렸으면 그 값이 섞였을 수 있다고 알린다. 통과에는 덧붙이지 않는다', () => {
    const slow = judgeLoad(check(), result({ latency: { count: 1000, p50: 100, p95: 230, p99: 250, max: 260 }, loopDelay: { p99: 42, max: 80 } }));
    expect(slow.problems).toEqual(['p95 230ms (기준: 200ms 이하)', '러너 자신이 p99 42ms 밀렸습니다. 이 값이 응답 시간에 섞였을 수 있습니다 — concurrent나 requests를 줄여 다시 재 보세요']);
    // 밀림이 기준의 10%보다 작으면 덧붙이지 않는다
    expect(judgeLoad(check(), result({ latency: { count: 1000, p50: 100, p95: 230, p99: 250, max: 260 }, loopDelay: { p99: 12, max: 80 } })).problems).toHaveLength(1);
    expect(judgeLoad(check(), result({ loopDelay: { p99: 150, max: 300 } })).problems).toEqual([]);
  });

  it('준비 요청을 보냈으면 요약에 건수와 실패 수를 남긴다', () => {
    expect(judgeLoad(check({ warmup: 20 }), result({ warmup: { requests: 20, errors: 2 } })).note).toContain('준비 요청 20건 (실패 2건)');
  });
});

describe('describeLoadExpect', () => {
  it('기준을 한 줄로 적는다', () => {
    expect(describeLoadExpect({ p95Ms: 200 })).toBe('p95 200ms 이하');
    expect(describeLoadExpect({ p50Ms: 50, p99Ms: 400, latencyOf: [409, 429] })).toBe('p50 50ms 이하, p99 400ms 이하, 409·429 응답만');
  });
});
