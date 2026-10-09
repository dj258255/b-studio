import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@b-studio/agent';
import type { StudioEvent } from './studio-events';
import { JUMP_MIN_RATIO, JUMP_MIN_TOKENS, analyzeContextGrowth, isContextJump } from './context-growth';

const agent = (event: Exclude<AgentEvent, { type: 'tokens' }>): StudioEvent => ({ type: 'agent', runId: 'r1', event });

describe('isContextJump', () => {
  it('절대 증가량(4,000 토큰) 또는 직전 컨텍스트의 25% 중 큰 쪽을 넘어야 급증이다', () => {
    expect(isContextJump(JUMP_MIN_TOKENS - 1, 0)).toBe(false);
    expect(isContextJump(JUMP_MIN_TOKENS, 0)).toBe(true);
    // 직전 컨텍스트가 커서 25% 기준이 절대 기준(4,000)보다 크면 그 기준을 쓴다
    expect(isContextJump(5_000, 100_000)).toBe(false); // 100,000×25% = 25,000
    expect(isContextJump(25_000, 100_000)).toBe(true);
    expect(isContextJump(JUMP_MIN_RATIO * 100_000, 100_000)).toBe(true);
  });
});

describe('analyzeContextGrowth', () => {
  it('첫 턴은 delta가 contextTokens와 같고 sources가 비어 있다', () => {
    const events: StudioEvent[] = [agent({ type: 'turn', turn: 1 }), agent({ type: 'turn_usage', turn: 1, inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 1000 })];
    const report = analyzeContextGrowth(events);
    expect(report.turns).toEqual([{ turn: 1, contextTokens: 1000, delta: 1000, sources: [] }]);
    expect(report.jumps).toEqual([]);
  });

  it('직전 턴의 도구 결과·모델 출력을 글자 수 큰 순으로 다음 턴 증가의 원인으로 묶는다', () => {
    const events: StudioEvent[] = [
      agent({ type: 'turn', turn: 1 }),
      agent({ type: 'turn_usage', turn: 1, inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 1000 }),
      agent({ type: 'text', text: 'x'.repeat(50) }),
      agent({ type: 'tool_call', name: 'read_file', input: { path: 'api/src/Order.java' } }),
      agent({ type: 'tool_result', name: 'read_file', ok: true, content: 'y'.repeat(9000), chars: 9000, rawChars: 9000 }),
      agent({ type: 'turn', turn: 2 }),
      agent({ type: 'turn_usage', turn: 2, inputTokens: 2000, outputTokens: 20, cacheReadTokens: 7000, cacheWriteTokens: 0, contextTokens: 9500 }),
    ];
    const report = analyzeContextGrowth(events);
    expect(report.turns).toHaveLength(2);
    const turn2 = report.turns[1]!;
    expect(turn2.delta).toBe(8500);
    // read_file 결과(9000자)가 모델 출력(text 50자 + tool_call 입력 JSON)보다 훨씬 커서 맨 앞에 온다
    expect(turn2.sources[0]).toMatchObject({ kind: 'tool_result', name: 'read_file', chars: 9000 });
    expect(turn2.sources[1]!.kind).toBe('model_output');
    expect(turn2.sources[0]!.share).toBeGreaterThan(turn2.sources[1]!.share);
    expect(turn2.sources[0]!.hint).toContain('read_lines');
  });

  it('임계치를 넘는 증가만 급증 목록에 들어가고, 남은 턴 수만큼 다시 읽힐 비용을 추정한다', () => {
    const events: StudioEvent[] = [
      agent({ type: 'turn', turn: 1 }),
      agent({ type: 'turn_usage', turn: 1, inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 1000 }),
      agent({ type: 'tool_call', name: 'run_in_service', input: { service: 'api', command: ['npm', 'test'] } }),
      agent({ type: 'tool_result', name: 'run_in_service', ok: true, content: 'z'.repeat(20_000), chars: 20_000, rawChars: 20_000 }),
      agent({ type: 'turn', turn: 2 }),
      agent({ type: 'turn_usage', turn: 2, inputTokens: 2000, outputTokens: 20, cacheReadTokens: 20_000, cacheWriteTokens: 0, contextTokens: 22_000 }),
      agent({ type: 'turn', turn: 3 }),
      agent({ type: 'turn_usage', turn: 3, inputTokens: 2100, outputTokens: 20, cacheReadTokens: 20_000, cacheWriteTokens: 0, contextTokens: 22_100 }),
      agent({ type: 'turn', turn: 4 }),
      agent({ type: 'turn_usage', turn: 4, inputTokens: 2200, outputTokens: 20, cacheReadTokens: 20_000, cacheWriteTokens: 0, contextTokens: 22_200 }),
    ];
    const report = analyzeContextGrowth(events);
    expect(report.jumps).toHaveLength(1);
    const jump = report.jumps[0]!;
    expect(jump.turn).toBe(2);
    expect(jump.delta).toBe(21_000);
    expect(jump.previousContext).toBe(1000);
    // 급증 뒤 남은 턴은 3, 4로 2턴
    expect(jump.remainingTurns).toBe(2);
    expect(jump.estimatedRereadTokens).toBe(21_000 * 2);
    expect(jump.sources[0]).toMatchObject({ kind: 'tool_result', name: 'run_in_service' });
    expect(jump.hints[0]).toContain('grep/tail');
    expect(jump.repeatedCall).toBe(false);
  });

  it('같은 도구를 같은 입력으로 두 번 부르면 반복 호출 힌트를 붙인다', () => {
    const input = { path: 'api/src/Order.java' };
    const events: StudioEvent[] = [
      agent({ type: 'turn', turn: 1 }),
      agent({ type: 'turn_usage', turn: 1, inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 1000 }),
      agent({ type: 'tool_call', name: 'read_file', input }),
      agent({ type: 'tool_result', name: 'read_file', ok: true, content: 'a'.repeat(5000), chars: 5000, rawChars: 5000 }),
      agent({ type: 'turn', turn: 2 }),
      agent({ type: 'turn_usage', turn: 2, inputTokens: 2000, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 0, contextTokens: 7000 }),
      agent({ type: 'tool_call', name: 'read_file', input }),
      agent({ type: 'tool_result', name: 'read_file', ok: true, content: 'a'.repeat(5000), chars: 5000, rawChars: 5000 }),
      agent({ type: 'turn', turn: 3 }),
      agent({ type: 'turn_usage', turn: 3, inputTokens: 3000, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 0, contextTokens: 8000 }),
    ];
    const report = analyzeContextGrowth(events);
    // 턴 2는 5000자 도구 결과로 급증(4,000 이상)
    const jump = report.jumps.find((entry) => entry.turn === 2);
    expect(jump).toBeDefined();
    expect(jump!.repeatedCall).toBe(true);
    expect(jump!.hints).toContain('같은 도구를 같은 입력으로 반복 호출했습니다. 같은 결과를 반복해서 읽고 있습니다');
  });

  it('앞 결과와 같아 참조로 대체된 결과(반복 표시)도 반복 호출로 잡는다', () => {
    const events: StudioEvent[] = [
      agent({ type: 'turn', turn: 1 }),
      agent({ type: 'turn_usage', turn: 1, inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 1000 }),
      agent({ type: 'tool_call', name: 'run_in_service', input: { service: 'api', command: ['x'] } }),
      agent({ type: 'tool_result', name: 'run_in_service', ok: true, content: 'w'.repeat(5000), chars: 5000, rawChars: 5000 }),
      agent({ type: 'tool_call', name: 'run_in_service', input: { service: 'api', command: ['y'] } }),
      agent({ type: 'tool_result', name: 'run_in_service', ok: true, content: '(앞의 1번째 호출 결과와 같습니다)', chars: 20, rawChars: 5000 }),
      agent({ type: 'turn', turn: 2 }),
      agent({ type: 'turn_usage', turn: 2, inputTokens: 2000, outputTokens: 20, cacheReadTokens: 5020, cacheWriteTokens: 0, contextTokens: 7020 }),
    ];
    const report = analyzeContextGrowth(events);
    const jump = report.jumps.find((entry) => entry.turn === 2);
    expect(jump).toBeDefined();
    expect(jump!.repeatedCall).toBe(true);
  });

  it('컨텍스트가 줄어들면(비우기 등) 급증이 아니다', () => {
    const events: StudioEvent[] = [
      agent({ type: 'turn', turn: 1 }),
      agent({ type: 'turn_usage', turn: 1, inputTokens: 60_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 60_000 }),
      agent({ type: 'turn', turn: 2 }),
      agent({ type: 'context_cleared', turn: 2, clearedCount: 3, clearedChars: 24_000 }),
      agent({ type: 'turn_usage', turn: 2, inputTokens: 20_000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 20_000 }),
    ];
    const report = analyzeContextGrowth(events);
    expect(report.turns[1]!.delta).toBe(-40_000);
    expect(report.jumps).toEqual([]);
  });

  it('대화 압축으로 줄어든 턴과 그 뒤의 정상 증가를 급증으로 보지 않는다', () => {
    const events: StudioEvent[] = [
      agent({ type: 'turn', turn: 1 }),
      agent({ type: 'turn_usage', turn: 1, inputTokens: 961_058, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 961_058 }),
      agent({ type: 'turn', turn: 2 }),
      agent({ type: 'context_compacted', trigger: 'auto', preTokens: 961_058, postTokens: 270_474 }),
      agent({ type: 'turn_usage', turn: 2, inputTokens: 270_474, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 270_474 }),
      agent({ type: 'turn', turn: 3 }),
      agent({ type: 'turn_usage', turn: 3, inputTokens: 272_000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 272_000 }),
    ];
    const report = analyzeContextGrowth(events);
    expect(report.turns[1]!.delta).toBe(-690_584);
    expect(report.jumps).toEqual([]);
  });

  it('턴 사용량이 없으면 빈 보고서를 낸다', () => {
    expect(analyzeContextGrowth([])).toEqual({ turns: [], jumps: [] });
  });
});
