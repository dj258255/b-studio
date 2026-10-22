import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@/lib/studio-events';
import { buildAgentOverview, withDeskFacts, type SessionOverviewSource } from './agents-overview';
import type { TerminalAgentRow } from './terminal-agents';

// 대시보드의 에이전트별 토큰·하는 일·할 수 있는 범위(#843)

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { id: 's1', projectId: 'orders', projectName: 'orders', workDir: '/tmp/orders', status: 'ready', mode: 'claude-code', running: false, services: [], checkpoints: [], ...overrides };
}

function source(overrides: Partial<SessionOverviewSource> = {}): SessionOverviewSource {
  return { snapshot: snapshot(), recent: [], updatedAt: '2026-10-22T11:00:00.000Z', ...overrides };
}

function item(input: SessionOverviewSource) {
  return buildAgentOverview({ sessions: [input], plans: [], fleets: [] }).items[0]!;
}

const usage = (input: number) => ({ inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
const rows: TerminalAgentRow[] = [
  { id: 'main', name: '메인', kind: 'main', state: 'idle', tokens: usage(3000), costUsd: 0.03 },
  { id: 'claude:Explore', name: 'Explore', kind: 'subagent', state: 'working', activity: '모델 요청 2회', tokens: usage(500) },
];
const capabilities = { backend: 'claude-code', model: 'opus', tools: 'cli-default' as const, writeScope: '세션 작업 복사본 전체', permission: 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트' };

describe('에이전트 내역과 범위', () => {
  it('내역이 없으면 agents가 없고, 범위가 없으면 capabilities가 없다(옛 화면은 그대로)', () => {
    const plain = item(source());
    expect(plain.agents).toBeUndefined();
    expect(plain.capabilities).toBeUndefined();
  });

  it('내역과 범위를 그대로 싣되, 메인 행의 상태는 그 항목의 실행 상태를 따른다', () => {
    const idle = item(source({ agents: rows, capabilities }));
    expect(idle.agents?.map((agent) => [agent.id, agent.state])).toEqual([
      ['main', 'idle'],
      ['claude:Explore', 'working'],
    ]);
    expect(idle.capabilities).toEqual(capabilities);
    const running = item(source({ snapshot: snapshot({ running: true }), agents: rows, capabilities }));
    expect(running.agents?.[0]).toMatchObject({ id: 'main', state: 'working' });
  });

  it('withDeskFacts가 세션마다 내역과 범위를 붙인다. 의존성을 주지 않으면 붙이지 않는다', () => {
    const [withRows] = withDeskFacts([source()], { terminal: () => undefined, costUsd: () => undefined, agents: () => rows, capabilities: () => capabilities });
    expect(withRows?.agents).toBe(rows);
    expect(withRows?.capabilities).toBe(capabilities);
    const [without] = withDeskFacts([source()], { terminal: () => undefined, costUsd: () => undefined });
    expect(without?.agents).toBeUndefined();
    expect(without?.capabilities).toBeUndefined();
  });
});
