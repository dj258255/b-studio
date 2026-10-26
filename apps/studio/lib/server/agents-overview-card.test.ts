import { describe, expect, it } from 'vitest';
import { cardLines } from '../../../cli/src/desk/cards';
import { stripAnsi } from '../../../cli/src/desk/screen';
import { defaultSprite } from '../../../cli/src/desk/sprite';
import { DEFAULT_THEME } from '../../../cli/src/desk/theme';
import type { DeskItem } from '../../../cli/src/desk/types';
import type { SessionSnapshot } from '@/lib/studio-events';
import { buildAgentOverview, type SessionOverviewSource } from './agents-overview';
import type { TerminalAgentRow } from './terminal-agents';

// 서버가 만든 /api/agents 항목을 JSON으로 한 번 오간 그대로 desk 카드가 그린다(#920·#921 약속)

const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const NOW = Date.parse('2026-10-26T10:01:00.000Z');

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { id: 's1', projectId: 'orders', projectName: 'orders', workDir: '/tmp/orders', status: 'ready', mode: 'claude-code', running: true, services: [], checkpoints: [], ...overrides };
}

const ledger: TerminalAgentRow[] = [
  { id: 'main', name: '메인', kind: 'main', state: 'idle', tokens: usage(1_000) },
  { id: 'claude:Explore', name: 'Explore', kind: 'subagent', state: 'working', activity: '모델 요청 3회', tokens: usage(2_000) },
];

function served(source: Partial<SessionOverviewSource>): DeskItem {
  const built = buildAgentOverview({ sessions: [{ snapshot: snapshot(), recent: [], updatedAt: '2026-10-26T10:00:00.000Z', lastRequest: '주문에 메모', ...source }], plans: [], fleets: [], now: NOW }).items[0]!;
  return JSON.parse(JSON.stringify(built)) as DeskItem;
}

describe('서버 응답 모양 그대로 카드를 그린다', () => {
  it('서브에이전트 인스턴스는 agents의 subagent 행(종류·맡은 일·도구)으로 실린다. 종류 단위 토큰은 그 종류의 첫 인스턴스 행에 싣는다', () => {
    const item = served({
      agents: ledger,
      live: {
        subagents: [
          { id: 'a1', type: 'Explore', description: '훅 찾기', state: 'working', tool: 'Grep' },
          { id: 'a2', type: 'Explore', description: '테스트 찾기', state: 'done' },
        ],
      },
    });
    expect(item).not.toHaveProperty('subagents');
    const subagents = item.agents!.filter((agent) => agent.kind === 'subagent');
    expect(subagents.map(({ id, type, description, tool, state }) => ({ id, type, description, tool, state }))).toEqual([
      { id: 'claude:agent:a1', type: 'Explore', description: '훅 찾기', tool: 'Grep', state: 'working' },
      { id: 'claude:agent:a2', type: 'Explore', description: '테스트 찾기', tool: undefined, state: 'done' },
    ]);
    // 행의 토큰 합은 그대로다
    const sum = item.agents!.reduce((total, agent) => total + agent.tokens.inputTokens, 0);
    expect(sum).toBe(3_000);
  });

  it('지금 하는 일·기다리는 까닭·서브에이전트가 카드 줄에 나온다', () => {
    const item = served({
      snapshot: snapshot({ terminalAttention: { kind: 'permission_prompt', message: 'Bash 실행 권한을 묻습니다', at: '2026-10-26T10:00:30.000Z' } }),
      terminal: { cliAlive: true },
      agents: ledger,
      live: {
        now: { tool: 'Bash', target: 'pnpm test', at: '2026-10-26T10:00:00.000Z' },
        todos: { done: 1, total: 3, current: '구현하는 중' },
        context: { usedPct: 42 },
        lastMessage: '고쳤습니다.',
        subagents: [{ id: 'a1', type: 'Explore', description: '훅 찾기', state: 'working', tool: 'Grep' }],
      },
    });
    const plain = cardLines({ item, selected: true, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 100, DEFAULT_THEME, NOW).map(stripAnsi).join('\n');
    expect(plain).toContain('Bash 실행 권한을 묻습니다');
    expect(plain).toContain('↳ Explore 훅 찾기 · Grep');
  });

  it('요청을 시작한 때와 도는 도구, 서브에이전트 시작 때가 카드의 "작업 N분째"·"N분째"로 나온다(#933·#934)', () => {
    const item = served({
      terminal: { cliAlive: true },
      agents: ledger,
      live: {
        workingSince: '2026-10-26T09:38:00.000Z',
        now: { tool: 'Bash', target: 'pnpm test', at: '2026-10-26T09:55:00.000Z', running: true },
        lastAt: '2026-10-26T09:55:00.000Z',
        subagents: [{ id: 'a1', type: 'Explore', description: '훅 찾기', state: 'working', tool: 'Grep', startedAt: '2026-10-26T09:57:00.000Z', lastAt: '2026-10-26T10:00:50.000Z' }],
      },
    });
    expect(item.state).toBe('working');
    const plain = cardLines({ item, selected: false, flagged: false, withLimits: false, sprite: defaultSprite('claude-code') }, 100, DEFAULT_THEME, NOW).map(stripAnsi).join('\n');
    expect(plain).toContain('작업 23분째');
    // 도구가 6분째 돌고 있으니 소식이 없어도 멈춘 듯이 아니다
    expect(plain).toContain('실행 pnpm test · 6분째');
    expect(plain).not.toContain('소식 없음');
    expect(plain).toContain('↳ Explore 훅 찾기 · Grep · 4분째');
  });
});
