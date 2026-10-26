import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, StudioEvent } from '@/lib/studio-events';
import { buildAgentOverview, withDeskFacts, type SessionOverviewSource } from './agents-overview';

// studio desk(#834)의 사이드바가 쓰는 칸: 터미널 CLI 상태·권한 대기, 게이트 상태와 체크포인트 수, 비용(#835)

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { id: 's1', projectId: 'orders', projectName: 'orders', workDir: '/tmp/orders', status: 'ready', mode: 'claude-code', running: false, services: [], checkpoints: [], ...overrides };
}

function source(overrides: Partial<SessionOverviewSource> = {}): SessionOverviewSource {
  return { snapshot: snapshot(), recent: [], updatedAt: '2026-10-22T11:00:00.000Z', ...overrides };
}

function item(input: SessionOverviewSource) {
  return buildAgentOverview({ sessions: [input], plans: [], fleets: [] }).items[0]!;
}

const started = (runId: string): StudioEvent => ({ type: 'run_started', runId, request: '주문 목록에 필터' });
const verifyStart = (runId: string): StudioEvent => ({ type: 'agent', runId, event: { type: 'verify_start', files: ['a.ts'] } });
const verifyResult = (runId: string, ok: boolean): StudioEvent => ({ type: 'agent', runId, event: { type: 'verify_result', report: { ok } } } as unknown as StudioEvent);
const finished = (runId: string, status: 'done' | 'failed' | 'error' | 'cancelled'): StudioEvent => ({ type: 'run_finished', runId, status, summary: '' });
const checkpoint = (sha: string, passed: boolean) => ({ sha, shortSha: sha.slice(0, 7), message: 'm', createdAt: '2026-10-22T10:00:00.000Z', files: [], ...(passed ? { passedStages: ['test' as const] } : {}) });

describe('세션 이름(#864)', () => {
  it('이름을 붙였으면 제목은 이름이고, 없으면 마지막 요청이다', () => {
    expect(item(source({ lastRequest: '주문 목록에 필터' })).title).toBe('주문 목록에 필터');
    expect(item(source({ snapshot: snapshot({ label: '필터 작업' }), lastRequest: '주문 목록에 필터' })).title).toBe('필터 작업');
  });
});

describe('터미널 상태', () => {
  it('터미널을 연 적 없는 세션에는 terminal이 없다', () => {
    expect(item(source()).terminal).toBeUndefined();
  });

  it('CLI가 떠 있으면 up, 아니면 down', () => {
    expect(item(source({ terminal: { cliAlive: true } })).terminal).toEqual({ cli: 'up' });
    expect(item(source({ terminal: { cliAlive: false } })).terminal).toEqual({ cli: 'down' });
  });

  it('권한 확인 창에서 기다리면 waiting: permission, 입력 대기·되묻기는 권한 대기가 아니다', () => {
    const asking = snapshot({ terminalAttention: { kind: 'permission_prompt', message: 'Bash 실행 권한을 묻습니다', at: '2026-10-22T11:00:00.000Z' } });
    expect(item(source({ snapshot: asking, terminal: { cliAlive: true } })).terminal).toEqual({ cli: 'up', waiting: 'permission' });
    const idle = snapshot({ terminalAttention: { kind: 'idle_prompt', message: '', at: '2026-10-22T11:00:00.000Z' } });
    expect(item(source({ snapshot: idle, terminal: { cliAlive: true } })).terminal).toEqual({ cli: 'up' });
  });
});

describe('게이트 상태', () => {
  it('기록이 없으면 none이고, 게이트를 통과한 체크포인트만 센다(세션 시작 체크포인트는 빼고)', () => {
    expect(item(source()).gate).toEqual({ state: 'none', checkpoints: 0 });
    const withCheckpoints = snapshot({ checkpoints: [checkpoint('b'.repeat(40), true), checkpoint('c'.repeat(40), true), checkpoint('a'.repeat(40), false)] });
    expect(item(source({ snapshot: withCheckpoints })).gate).toEqual({ state: 'none', checkpoints: 2 });
  });

  it('실행 중이고 이번 실행의 마지막 검증 이벤트가 시작이면 verifying', () => {
    const running = snapshot({ running: true });
    expect(item(source({ snapshot: running, recent: [started('r1'), verifyStart('r1')] })).gate?.state).toBe('verifying');
  });

  it('검증 결과가 났으면 그 결과(실행 중이어도 다시 시작하기 전까지는 마지막 판정)', () => {
    const running = snapshot({ running: true });
    expect(item(source({ snapshot: running, recent: [started('r1'), verifyStart('r1'), verifyResult('r1', false)] })).gate?.state).toBe('failed');
    expect(item(source({ recent: [started('r1'), verifyStart('r1'), verifyResult('r1', false), verifyStart('r1'), verifyResult('r1', true), finished('r1', 'done')] })).gate?.state).toBe('passed');
  });

  it('끝난 실행의 verify_start는 검증 중으로 남지 않는다(취소·오류로 결과 없이 끝남)', () => {
    expect(item(source({ recent: [started('r1'), verifyStart('r1'), finished('r1', 'cancelled')] })).gate?.state).toBe('none');
    expect(item(source({ recent: [started('r1'), verifyStart('r1'), finished('r1', 'failed')] })).gate?.state).toBe('failed');
  });

  it('검증 이벤트가 잘려 나갔으면 마지막 실행의 끝 상태로 본다', () => {
    expect(item(source({ recent: [finished('r1', 'failed')] })).gate?.state).toBe('failed');
    expect(item(source({ recent: [finished('r1', 'done')] })).gate?.state).toBe('none');
  });

  it('새 실행이 시작되면 앞 실행의 판정을 들고 오지 않는다', () => {
    const running = snapshot({ running: true });
    expect(item(source({ snapshot: running, recent: [started('r1'), verifyResult('r1', false), finished('r1', 'failed'), started('r2')] })).gate?.state).toBe('none');
  });
});

describe('비용', () => {
  it('수집기가 준 세션 비용을 싣고, 모르면 싣지 않는다', () => {
    expect(item(source({ costUsd: 0.42 })).costUsd).toBe(0.42);
    expect('costUsd' in item(source())).toBe(false);
  });
});

describe('withDeskFacts', () => {
  it('터미널을 연 세션에만 CLI 상태를 붙이고, 비용은 기록에서 계산한 값을 붙인다', () => {
    const sources = [source({ snapshot: snapshot({ id: 'a' }) }), source({ snapshot: snapshot({ id: 'b' }) })];
    const out = withDeskFacts(sources, {
      terminal: (id) => (id === 'a' ? { cliAlive: true } : undefined),
      costUsd: (id) => (id === 'b' ? 1.5 : undefined),
    });
    expect(out[0]).toMatchObject({ terminal: { cliAlive: true } });
    expect(out[0]).not.toHaveProperty('costUsd');
    expect(out[1]).toMatchObject({ costUsd: 1.5 });
    expect(out[1]).not.toHaveProperty('terminal');
  });
});

describe('지금 하는 일·할 일·문맥 창·마지막 답·서브에이전트(#920)', () => {
  const live = {
    now: { tool: 'Bash', target: 'pnpm test', at: '2026-10-26T10:00:00.000Z' },
    todos: { done: 1, total: 3, current: '구현하는 중' },
    context: { usedPct: 42, used: 84000, size: 200000 },
    lastMessage: '고쳤습니다.',
    subagents: [{ id: 'a1', type: 'Explore', description: '훅 찾기', state: 'working' as const, tool: 'Grep' }],
  };

  it('세션의 활동을 항목에 그대로 싣는다. 없으면 싣지 않는다', () => {
    const got = item(source({ live }));
    expect(got).toMatchObject(live);
    const none = item(source());
    for (const key of ['now', 'todos', 'context', 'lastMessage', 'subagents']) expect(none, key).not.toHaveProperty(key);
  });

  it('withDeskFacts가 활동을 붙인다(모르면 붙이지 않는다)', () => {
    const [withLive] = withDeskFacts([source()], { terminal: () => undefined, costUsd: () => undefined, live: () => live });
    expect(withLive!.live).toEqual(live);
    const [without] = withDeskFacts([source()], { terminal: () => undefined, costUsd: () => undefined, live: () => undefined });
    expect(without).not.toHaveProperty('live');
  });

  it('사람을 기다리는 까닭: 권한·되묻기·입력 필요·입력 대기를 종류와 문구로 싣는다. CLI가 내려갔거나 모르는 종류면 없다', () => {
    const at = '2026-10-26T10:00:00.000Z';
    const waiting = (kind: string, message: string, cliAlive = true) => item(source({ snapshot: snapshot({ terminalAttention: { kind, message, at } }), terminal: { cliAlive } })).waitingFor;
    expect(waiting('permission_prompt', 'Bash 실행 권한을 묻습니다')).toEqual({ kind: 'permission', message: 'Bash 실행 권한을 묻습니다', at });
    expect(waiting('elicitation_dialog', '어느 쪽?')).toEqual({ kind: 'question', message: '어느 쪽?', at });
    expect(waiting('agent_needs_input', '')).toEqual({ kind: 'input', at });
    expect(waiting('idle_prompt', '입력 대기')).toEqual({ kind: 'idle', message: '입력 대기', at });
    expect(waiting('some_future_kind', 'x')).toBeUndefined();
    expect(waiting('permission_prompt', 'x', false)).toBeUndefined();
    // 권한 대기 표시(terminal.waiting)는 지금처럼 그대로 간다
    expect(item(source({ snapshot: snapshot({ terminalAttention: { kind: 'permission_prompt', message: 'x', at } }), terminal: { cliAlive: true } })).terminal).toEqual({ cli: 'up', waiting: 'permission' });
  });
});
