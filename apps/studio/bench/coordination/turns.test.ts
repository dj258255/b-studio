import { describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../lib/studio-events';
import { breakdownByCondition, breakdownMarkdown } from './breakdown';
import type { BenchRow } from './summary';
import { tokenBreakdown, turnsFromEvents, TurnRecorder, type TurnRecord } from './turns';

function turn(context: number, output: number, tools: Array<[string, number]> = []): TurnRecord {
  return { context, output, cacheRead: 0, cacheWrite: 0, tools: tools.map(([name, chars]) => ({ name, chars })) };
}

function reread(breakdown: ReturnType<typeof tokenBreakdown>): number {
  return Object.values(breakdown.toolReread).reduce((sum, value) => sum + value, 0);
}

describe('tokenBreakdown', () => {
  it('고정 문맥과 재읽기로 나누고, 합이 문맥 합과 맞는다', () => {
    // 호출 0: 문맥 10,000, 출력 100, read_file 결과 → 호출 1은 10,500(+500: 출력 100 + 도구 400)
    // 호출 1: 출력 50, http_request 결과 → 호출 2는 10,750(+250: 출력 50 + 도구 200)
    const turns = [turn(10_000, 100, [['read_file', 1_600]]), turn(10_500, 50, [['http_request', 800]]), turn(10_750, 30)];
    const result = tokenBreakdown(turns);

    expect(result.calls).toBe(3);
    expect(result.contextTotal).toBe(31_250);
    expect(result.fixed).toBe(30_000);
    // 호출 0 뒤 늘어난 양은 뒤 두 호출이, 호출 1 뒤 늘어난 양은 마지막 호출이 다시 읽는다
    expect(result.outputReread).toBe(100 * 2 + 50 * 1);
    expect(result.toolReread).toEqual({ read_file: 400 * 2, http_request: 200 * 1 });
    expect(result.fixed + result.outputReread + reread(result) - result.clearedSaving).toBe(result.contextTotal);
    expect(result.toolResults).toEqual({ read_file: { calls: 1, chars: 1_600 }, http_request: { calls: 1, chars: 800 } });
  });

  it('한 호출이 도구를 여럿 부르면 늘어난 양을 결과 글자 수 비율로 나눈다', () => {
    const result = tokenBreakdown([turn(1_000, 0, [['read_file', 300], ['list_files', 100]]), turn(1_400, 0)]);

    expect(result.toolReread).toEqual({ read_file: 300, list_files: 100 });
  });

  it('비워서 문맥이 줄면 줄어든 양을 따로 세고, 합은 그대로 맞는다', () => {
    const turns = [turn(5_000, 0, [['run_in_service', 400]]), turn(6_000, 0), turn(4_000, 0), turn(4_000, 0)];
    const result = tokenBreakdown(turns);

    expect(result.clearedSaving).toBe(2_000 * 2);
    expect(result.fixed + result.outputReread + reread(result) - result.clearedSaving).toBe(result.contextTotal);
  });

  it('도구 결과 없이 문맥이 늘면 출력 재읽기로 센다', () => {
    const result = tokenBreakdown([turn(1_000, 10), turn(1_200, 10)]);

    expect(result.outputReread).toBe(200);
    expect(result.toolReread).toEqual({});
  });

  it('호출이 없으면 모두 0이다', () => {
    expect(tokenBreakdown([])).toMatchObject({ calls: 0, contextTotal: 0, fixed: 0, outputReread: 0, clearedSaving: 0 });
  });
});

describe('turnsFromEvents', () => {
  it('turn_usage가 턴을 열고 뒤따르는 도구 결과를 그 턴에 붙인다', () => {
    const events: StudioEvent[] = [
      { type: 'run_started', runId: 'r1', request: 'x' },
      { type: 'agent', runId: 'r1', event: { type: 'turn_usage', turn: 1, inputTokens: 3, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 100, contextTokens: 1_003 } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'read_file', input: { path: 'a.ts' } } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_result', name: 'read_file', ok: true, content: 'abcdef', chars: 6, rawChars: 6 } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_result', name: 'list_files', ok: true, content: 'abc' } },
      { type: 'agent', runId: 'r1', event: { type: 'turn_usage', turn: 2, inputTokens: 1, outputTokens: 5, cacheReadTokens: 1_000, cacheWriteTokens: 20, contextTokens: 1_021 } },
    ];

    expect(turnsFromEvents(events)).toEqual([
      { context: 1_003, output: 40, cacheRead: 900, cacheWrite: 100, tools: [{ name: 'read_file', chars: 6 }, { name: 'list_files', chars: 3 }] },
      { context: 1_021, output: 5, cacheRead: 1_000, cacheWrite: 20, tools: [] },
    ]);
  });
});

describe('TurnRecorder', () => {
  it('같은 id의 응답 조각을 한 턴으로 묶고, 도구 결과를 tool_use id로 찾아 붙인다', () => {
    const recorder = new TurnRecorder();
    const usage = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 };
    recorder.observeAssistant({ id: 'm1', usage, content: [{ type: 'text', text: '읽어 볼게요' }] });
    recorder.observeAssistant({ id: 'm1', usage: { ...usage, output_tokens: 30 }, content: [{ type: 'tool_use', id: 't1', name: 'Read' }] });
    recorder.observeUser([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '12345' }] }]);
    recorder.observeUser([{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }]);
    recorder.observeUser('문자열 내용은 무시');
    recorder.observeAssistant({ id: 'm2', usage: { input_tokens: 1, output_tokens: 3, cache_read_input_tokens: 560 }, content: [] });

    expect(recorder.turns).toEqual([
      { context: 552, output: 30, cacheRead: 500, cacheWrite: 50, tools: [{ name: 'Read', chars: 5 }] },
      { context: 561, output: 3, cacheRead: 560, cacheWrite: 0, tools: [] },
    ]);
  });
});

describe('breakdownByCondition', () => {
  const lane = (turns: TurnRecord[]) => ({ sessionId: 's', toolCalls: {}, filesRead: [], dirsListed: [], failureSignatures: [], repeatedFailures: 0, turns });

  it('세션마다 나눈 뒤 조건별로 더하고, 호출별 기록이 없는 행은 건너뛴다', () => {
    const rows = [
      { strategy: 'S0', verify: 'full', success: true, traces: [lane([turn(1_000, 0, [['read_file', 100]]), turn(1_100, 0)])], integrationTrace: lane([turn(800, 0)]) },
      { strategy: 'S0', verify: 'light', success: false, traces: [lane([turn(2_000, 0)])] },
      { strategy: 'P0', verify: 'full', success: true, traces: [], plainTurns: [turn(500, 0), turn(600, 0)] },
      { strategy: 'S0', verify: 'full', success: true, traces: [{ ...lane([]), turns: undefined }] },
    ] as unknown as BenchRow[];

    const { conditions, skipped } = breakdownByCondition(rows);

    expect(skipped).toBe(1);
    expect(conditions.map((c) => [c.label, c.rows, c.successes, c.sessions, c.breakdown.calls, c.breakdown.fixed])).toEqual([
      ['P0', 1, 1, 1, 2, 1_000],
      ['S0', 1, 1, 2, 3, 2_000 + 800],
      ['S0 (light)', 1, 0, 1, 1, 2_000],
    ]);
    expect(conditions[1]!.breakdown.firstContext).toBe(900);
    expect(conditions[1]!.breakdown.toolReread).toEqual({ read_file: 100 });

    const markdown = breakdownMarkdown(conditions, skipped);
    expect(markdown).toContain('| S0 | 1 (1) | 2 | 3 | 2,900 | 2,800 (96.6%)');
    expect(markdown).toContain('호출별 기록이 없는 옛 결과 1행은 건너뛰었습니다.');
  });
});
