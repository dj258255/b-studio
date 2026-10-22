import { describe, expect, it } from 'vitest';
import { agentRows, capabilitiesOf, newAgentLedger, noteAgentSignal, noteAgentUsage, AGENT_LEDGER_LIMIT } from './terminal-agents';
import type { ApiRequestUsage } from './terminal-telemetry';

const MAIN = 'conv-main';
const CHILD = 'conv-child';

function request(over: Partial<ApiRequestUsage>): ApiRequestUsage {
  return { at: 1_000, model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, ...over };
}

const sum = (rows: ReturnType<typeof agentRows>) =>
  rows.reduce((total, row) => total + row.tokens.inputTokens + row.tokens.outputTokens + row.tokens.cacheReadTokens + row.tokens.cacheWriteTokens, 0);

describe('터미널 에이전트 장부(#843)', () => {
  it('아무것도 받지 않았으면 행이 없다', () => {
    expect(agentRows(newAgentLedger(), {})).toEqual([]);
  });

  it('Claude: agent가 붙은 요청은 그 종류의 서브에이전트로, 나머지는 메인으로 센다. 행의 합은 넣은 사용량의 합과 같다', () => {
    const ledger = newAgentLedger();
    noteAgentUsage(ledger, request({ inputTokens: 1000, outputTokens: 100, costUsd: 0.01 }));
    noteAgentUsage(ledger, request({ agent: 'general-purpose', inputTokens: 200, outputTokens: 20, at: 2_000, costUsd: 0.002 }));
    noteAgentUsage(ledger, request({ agent: 'general-purpose', inputTokens: 300, outputTokens: 30, at: 3_000, costUsd: 0.003 }));
    noteAgentUsage(ledger, request({ inputTokens: 2000, outputTokens: 200, at: 4_000, costUsd: 0.02 }));
    const rows = agentRows(ledger, {});
    expect(rows.map((row) => [row.id, row.kind, row.name, row.tokens.inputTokens, row.tokens.outputTokens])).toEqual([
      ['main', 'main', '메인', 3000, 300],
      ['claude:general-purpose', 'subagent', 'general-purpose', 500, 50],
    ]);
    expect(sum(rows)).toBe(1000 + 100 + 200 + 20 + 300 + 30 + 2000 + 200);
    // 단가가 없으면 CLI가 보고한 비용을 더한다
    expect(rows[1]?.costUsd).toBeCloseTo(0.005);
    expect(rows[1]?.state).toBe('working');
    expect(rows[1]?.activity).toBe('모델 요청 2회');
  });

  it('Claude: subagent_completed가 그 종류의 마지막 요청 뒤에 오면 끝남이고 도구 횟수를 보인다. 그 뒤 다시 요청이 오면 다시 작업 중이다', () => {
    const ledger = newAgentLedger();
    noteAgentUsage(ledger, request({ agent: 'Explore', at: 1_000 }));
    noteAgentSignal(ledger, { kind: 'subagent-done', agent: 'Explore', toolUses: 4 }, 2_000);
    expect(agentRows(ledger, {}).find((row) => row.id === 'claude:Explore')).toMatchObject({ state: 'done', activity: '끝남 · 도구 4회' });
    noteAgentUsage(ledger, request({ agent: 'Explore', at: 3_000 }));
    expect(agentRows(ledger, {}).find((row) => row.id === 'claude:Explore')).toMatchObject({ state: 'working' });
  });

  it('Codex: spawn으로 알린 자식 대화의 사용량은 하위 에이전트 행이다. 붙인 이름·맡은 일·도구 활동·끝남을 보인다', () => {
    const ledger = newAgentLedger();
    noteAgentUsage(ledger, request({ model: 'gpt-5.5', conversationId: MAIN, inputTokens: 1000, at: 1_000 }));
    // 자식의 사용량이 spawn 신호보다 먼저 와도 자식으로 센다(같은 묶음 안에서 순서가 바뀔 수 있다)
    noteAgentUsage(ledger, request({ model: 'gpt-5.5', conversationId: CHILD, inputTokens: 300, at: 1_500 }));
    noteAgentSignal(ledger, { kind: 'spawned-name', parent: MAIN, name: '/root/ping_sub' }, 1_100);
    noteAgentSignal(ledger, { kind: 'spawn', parent: MAIN, child: CHILD, task: 'SUBTASK-PING answer pong' }, 1_200);
    noteAgentSignal(ledger, { kind: 'tool', conversation: CHILD, tool: 'exec_command' }, 1_600);
    let child = agentRows(ledger, {}).find((row) => row.kind === 'subagent');
    expect(child).toMatchObject({ id: `codex:${CHILD}`, name: '/root/ping_sub', state: 'working', activity: '도구: exec_command' });
    expect(child?.tokens.inputTokens).toBe(300);
    noteAgentSignal(ledger, { kind: 'result', child: CHILD }, 2_000);
    child = agentRows(ledger, {}).find((row) => row.kind === 'subagent');
    expect(child).toMatchObject({ state: 'done', activity: '끝남 · SUBTASK-PING answer pong' });
    const main = agentRows(ledger, {}).find((row) => row.kind === 'main');
    expect(main?.tokens.inputTokens).toBe(1000);
  });

  it('Codex: 자식으로 알린 적 없는 대화(다시 띄운 CLI 등)는 메인에 합친다', () => {
    const ledger = newAgentLedger();
    noteAgentUsage(ledger, request({ model: 'gpt-5.5', conversationId: 'a', inputTokens: 10 }));
    noteAgentUsage(ledger, request({ model: 'gpt-5.5', conversationId: 'b', inputTokens: 20 }));
    expect(agentRows(ledger, {}).map((row) => [row.id, row.tokens.inputTokens])).toEqual([['main', 30]]);
  });

  it('단가 표가 있으면 모델별 단가로, 단일 단가만 있으면 그것으로 비용을 계산한다', () => {
    const ledger = newAgentLedger();
    noteAgentUsage(ledger, request({ agent: 'Explore', inputTokens: 1_000_000, outputTokens: 0, costUsd: 99 }));
    const prices = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
    expect(agentRows(ledger, { byModel: { sonnet: prices } })[1]?.costUsd).toBeCloseTo(3);
    expect(agentRows(ledger, { single: { ...prices, inputPerM: 1 } })[1]?.costUsd).toBeCloseTo(1);
  });

  it(`서브에이전트는 ${AGENT_LEDGER_LIMIT}개까지 따로 세고, 넘는 것은 "그 밖" 한 행에 합친다(합은 그대로)`, () => {
    const ledger = newAgentLedger();
    for (let index = 0; index < AGENT_LEDGER_LIMIT + 5; index += 1) noteAgentUsage(ledger, request({ agent: `custom-${index}`, inputTokens: 1, outputTokens: 0 }));
    const rows = agentRows(ledger, {});
    expect(rows.filter((row) => row.kind === 'subagent')).toHaveLength(AGENT_LEDGER_LIMIT + 1);
    expect(rows.at(-1)).toMatchObject({ id: 'other', name: '그 밖의 서브에이전트' });
    expect(sum(rows)).toBe(AGENT_LEDGER_LIMIT + 5);
  });

  it('메인 행의 상태는 부르는 쪽이 준 것을 쓴다(세션의 실행 상태)', () => {
    const ledger = newAgentLedger();
    noteAgentUsage(ledger, request({}));
    expect(agentRows(ledger, {}, 'working')[0]).toMatchObject({ id: 'main', state: 'working' });
    expect(agentRows(ledger, {})[0]).toMatchObject({ id: 'main', state: 'idle' });
  });
});

describe('capabilitiesOf(#843)', () => {
  it('허용 도구가 없으면 CLI 기본, 카드 범위가 있으면 그 범위, 없으면 작업 공간으로 쓰기 범위를 말한다', () => {
    expect(capabilitiesOf({ backend: 'claude-code', model: 'opus', workspace: 'copy', terminal: true })).toEqual({
      backend: 'claude-code',
      model: 'opus',
      tools: 'cli-default',
      writeScope: '세션 작업 복사본 전체',
      permission: 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트',
    });
    expect(capabilitiesOf({ backend: 'codex', allowedTools: ['Read', 'Edit'], workspace: 'local', terminal: false })).toMatchObject({
      tools: ['Read', 'Edit'],
      writeScope: '프로젝트 폴더 전체',
      permission: 'b-studio 실행 정책 + 게이트',
    });
    expect(capabilitiesOf({ backend: 'codex', cardScope: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], terminal: true }).writeScope).toBe('카드 범위: a, b, c, d, e 외 2곳');
    expect(capabilitiesOf({ backend: 'codex', cardScope: [], terminal: true }).writeScope).toBe('카드 범위: 없음(읽기만)');
  });
});
