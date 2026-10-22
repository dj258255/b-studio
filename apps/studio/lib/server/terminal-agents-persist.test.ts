import { describe, expect, it } from 'vitest';
import { agentRows, newAgentLedger, noteAgentSignal, noteAgentUsage, restoreAgentLedger, serializeAgentLedger, AGENT_LEDGER_LIMIT } from './terminal-agents';
import type { ApiRequestUsage } from './terminal-telemetry';

function request(over: Partial<ApiRequestUsage>): ApiRequestUsage {
  return { at: 1_000, model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, ...over };
}

/** 메인·Claude 서브에이전트·Codex 자식·그 밖을 모두 가진 장부 */
function fullLedger() {
  const ledger = newAgentLedger();
  noteAgentUsage(ledger, request({ inputTokens: 1000, costUsd: 0.01 }));
  noteAgentUsage(ledger, request({ agent: 'Explore', inputTokens: 200, at: 2_000 }));
  noteAgentSignal(ledger, { kind: 'subagent-done', agent: 'Explore', toolUses: 3 }, 3_000);
  noteAgentUsage(ledger, request({ conversationId: 'main-conv', inputTokens: 50, model: 'gpt-5.5' }));
  noteAgentSignal(ledger, { kind: 'spawned-name', parent: 'main-conv', name: '/root/ping' }, 4_000);
  noteAgentSignal(ledger, { kind: 'spawn', parent: 'main-conv', child: 'child-conv', task: '핑을 보낸다' }, 4_100);
  noteAgentUsage(ledger, request({ conversationId: 'child-conv', inputTokens: 70, model: 'gpt-5.5', at: 4_200 }));
  noteAgentSignal(ledger, { kind: 'tool', conversation: 'child-conv', tool: 'shell' }, 4_300);
  for (let index = 0; index < AGENT_LEDGER_LIMIT; index += 1) noteAgentUsage(ledger, request({ agent: `kind-${index}`, inputTokens: 1, at: 5_000 + index }));
  return ledger;
}

// 스튜디오를 다시 띄워도 내역이 남도록 세션 기록에 싣는다(#849)
describe('에이전트 장부 저장과 복원(#849)', () => {
  it('JSON으로 저장했다가 되살리면 화면 행이 그대로다', () => {
    const ledger = fullLedger();
    const restored = restoreAgentLedger(JSON.parse(JSON.stringify(serializeAgentLedger(ledger))));
    expect(restored).toBeDefined();
    expect(agentRows(restored!, {}, 'working')).toEqual(agentRows(ledger, {}, 'working'));
  });

  it('되살린 장부에 이어 넣어도 같은 규칙으로 센다(같은 종류는 같은 행)', () => {
    const ledger = fullLedger();
    const restored = restoreAgentLedger(JSON.parse(JSON.stringify(serializeAgentLedger(ledger))))!;
    noteAgentUsage(ledger, request({ agent: 'Explore', inputTokens: 5, at: 9_000 }));
    noteAgentUsage(restored, request({ agent: 'Explore', inputTokens: 5, at: 9_000 }));
    expect(agentRows(restored, {})).toEqual(agentRows(ledger, {}));
  });

  it('모양이 틀린 기록은 버린다(없는 것으로)', () => {
    expect(restoreAgentLedger(undefined)).toBeUndefined();
    expect(restoreAgentLedger('x')).toBeUndefined();
    expect(restoreAgentLedger({ version: 2 })).toBeUndefined();
    expect(restoreAgentLedger({ version: 1, main: { usageByModel: { m: { inputTokens: 'many' } } } })).toBeUndefined();
  });

  it('기록에 상한보다 많은 서브에이전트가 있어도 상한까지만 되살린다', () => {
    const value = serializeAgentLedger(newAgentLedger());
    const bucket = { usageByModel: { m: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, calls: 1, lastUsageAt: 1 };
    const claude = Array.from({ length: AGENT_LEDGER_LIMIT + 10 }, (_, index) => [`kind-${index}`, bucket]);
    const restored = restoreAgentLedger({ ...value, claude });
    expect(restored?.claude.size).toBe(AGENT_LEDGER_LIMIT);
  });
});
