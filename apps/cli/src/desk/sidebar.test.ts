import { describe, expect, it } from 'vitest';
import { agentStatus, compactTokens, gateStatus, sidebarRows } from './sidebar';
import type { DeskItem } from './types';

const base: DeskItem = { kind: 'session', id: 's1', title: '주문 목록', projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-22T00:00:00Z' };

describe('사이드바 상태', () => {
  it('권한을 묻는 터미널은 작업 중보다 먼저 "권한 대기"로 보인다', () => {
    expect(agentStatus({ ...base, state: 'working', terminal: { cli: 'up', waiting: 'permission' } })).toEqual({ label: '권한 대기', tone: 'warn' });
  });

  it('작업 중, 답 기다림, CLI 대기, 쉼, 오류를 가른다', () => {
    expect(agentStatus({ ...base, state: 'working' }).label).toBe('작업 중');
    expect(agentStatus({ ...base, attention: 'question' }).label).toBe('답 기다림');
    expect(agentStatus({ ...base, terminal: { cli: 'up' } }).label).toBe('CLI 대기');
    expect(agentStatus({ ...base, terminal: { cli: 'down' } }).label).toBe('쉼');
    expect(agentStatus({ ...base, state: 'error' })).toEqual({ label: '오류', tone: 'fail' });
    // 계획이 끝나 자원을 돌려준 레인은 멈춤이 아니라 끝남이다(#868)
    expect(agentStatus({ ...base, state: 'done' })).toEqual({ label: '끝남', tone: 'ok' });
  });

  it('게이트 상태를 싣는 서버면 그것을, 아니면 개입 사유로 실패만 보인다', () => {
    expect(gateStatus({ ...base, gate: { state: 'verifying', checkpoints: 2 } })).toEqual({ label: '검증 중', tone: 'busy' });
    expect(gateStatus({ ...base, gate: { state: 'passed', checkpoints: 2 } })).toEqual({ label: '통과', tone: 'ok' });
    expect(gateStatus({ ...base, gate: { state: 'failed', checkpoints: 0 } })).toEqual({ label: '실패', tone: 'fail' });
    expect(gateStatus({ ...base, gate: { state: 'none', checkpoints: 0 } })).toBeUndefined();
    expect(gateStatus({ ...base, attention: 'gate_failed' })).toEqual({ label: '실패', tone: 'fail' });
    expect(gateStatus(base)).toBeUndefined();
  });

  it('통과했어도 확인 필요로 표시된 실행은 "확인 필요"가 이긴다', () => {
    expect(gateStatus({ ...base, attention: 'needs_review', gate: { state: 'passed', checkpoints: 1 } })).toEqual({ label: '확인 필요', tone: 'warn' });
  });
});

describe('사이드바 줄', () => {
  it('항목마다 두 줄: AI·프로젝트, 그 아래 상태·게이트·체크포인트·비용', () => {
    const rows = sidebarRows([{ ...base, state: 'working', gate: { state: 'passed', checkpoints: 3 }, costUsd: 0.1234 }], 0, new Map(), 40);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toContain('Claude');
    expect(rows[0]!.text).toContain('shop');
    expect(rows[0]!.selected).toBe(true);
    expect(rows[1]!.text).toContain('작업 중');
    expect(rows[1]!.text).toContain('통과');
    expect(rows[1]!.text).toContain('체크포인트 3');
    expect(rows[1]!.text).toContain('$0.12');
  });

  it('칸에 열린 세션은 칸 번호를 붙이고, 계획 승인 같은 세션 밖 항목은 뺀다', () => {
    const rows = sidebarRows([base, { ...base, id: 'plan:p1', kind: 'lane' }], 0, new Map([['s1', 2]]), 40);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toContain('[2]');
  });

  it('항목이 없으면 새 요청 안내 한 줄', () => {
    const rows = sidebarRows([], 0, new Map(), 40);
    expect(rows.map((row) => row.text).join('\n')).toContain('Ctrl-b n');
  });
});

describe('에이전트 내역과 범위(#843)', () => {
  const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const detailed: DeskItem = {
    ...base,
    state: 'working',
    tokens: usage(12_345),
    agents: [
      { id: 'main', name: '메인', kind: 'main', state: 'working', tokens: usage(10_000) },
      { id: 'claude:Explore', name: 'Explore', kind: 'subagent', state: 'working', activity: '모델 요청 2회', tokens: usage(2_000) },
      { id: 'claude:Plan', name: 'Plan', kind: 'subagent', state: 'done', activity: '끝남 · 도구 3회', tokens: usage(345) },
    ],
    capabilities: { backend: 'claude-code', model: 'opus', tools: 'cli-default', writeScope: '세션 작업 복사본 전체', permission: 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트' },
  };

  it('줄마다 토큰 합을 짧게 보인다', () => {
    expect(compactTokens(950)).toBe('950');
    expect(compactTokens(12_345)).toBe('1.2만');
    expect(compactTokens(5_100)).toBe('5.1천');
    expect(compactTokens(250_000_000)).toBe('2.5억');
    const rows = sidebarRows([{ ...detailed }], 1, new Map(), 60);
    expect(rows[1]!.text).toContain('토큰 1.2만');
  });

  it('고른 줄 아래에 서브에이전트마다 한 줄과 범위 두 줄을 펼친다. 고르지 않은 줄은 두 줄 그대로다', () => {
    const other: DeskItem = { ...detailed, id: 's2' };
    const rows = sidebarRows([detailed, other], 0, new Map(), 70);
    const texts = rows.map((row) => row.text.trimEnd());
    expect(texts[2]).toContain('↳ Explore 작업 중 · 토큰 2,000 · 모델 요청 2회');
    expect(texts[3]).toContain('↳ Plan 끝남 · 토큰 345 · 끝남 · 도구 3회');
    expect(texts[4]).toContain('도구 CLI 기본 · 쓰기 세션 작업 복사본 전체');
    expect(texts[5]).toContain('권한 CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트');
    // 둘째 항목은 펼치지 않는다
    expect(rows).toHaveLength(6 + 2);
    expect(rows.every((row) => row.item !== undefined)).toBe(true);
    expect(rows.filter((row) => row.item === 0)).toHaveLength(6);
  });

  it('서브에이전트는 여섯까지 보이고 나머지는 "외 N개"', () => {
    const many: DeskItem = {
      ...detailed,
      agents: [detailed.agents![0]!, ...Array.from({ length: 9 }, (_, index) => ({ id: `claude:a${index}`, name: `a${index}`, kind: 'subagent' as const, state: 'done' as const, tokens: usage(1) }))],
      capabilities: undefined,
    };
    const texts = sidebarRows([many], 0, new Map(), 60).map((row) => row.text.trimEnd());
    expect(texts.filter((text) => text.includes('↳ a'))).toHaveLength(6);
    expect(texts.at(-1)).toContain('↳ 외 3개');
  });

  it('허용 도구 목록이 있으면 그 목록을 보인다', () => {
    const listed: DeskItem = { ...detailed, agents: undefined, capabilities: { ...detailed.capabilities!, tools: ['Read', 'Edit'] } };
    const texts = sidebarRows([listed], 0, new Map(), 60).map((row) => row.text.trimEnd());
    expect(texts[2]).toContain('도구 Read, Edit');
  });
});
