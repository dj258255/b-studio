import { describe, expect, it } from 'vitest';
import type { FleetView } from '@/lib/fleet-types';
import type { SessionSnapshot, StudioEvent } from '@/lib/studio-events';
import type { TaskPlanView } from '@/lib/task-plan-types';
import { activityOf, buildAgentOverview, TITLE_CHARS, type SessionOverviewSource } from './agents-overview';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    projectId: 'orders',
    projectName: 'orders',
    workDir: '/tmp/orders',
    status: 'ready',
    mode: 'api',
    running: false,
    services: [],
    checkpoints: [],
    ...overrides,
  };
}

function source(overrides: Partial<SessionOverviewSource> = {}): SessionOverviewSource {
  return { snapshot: snapshot(), recent: [], updatedAt: '2026-09-29T11:00:00.000Z', ...overrides };
}

const finished = (runId: string, status: 'done' | 'failed' | 'error' | 'cancelled'): StudioEvent => ({ type: 'run_finished', runId, status, summary: '' });
const cancelling = (runId: string, reason?: 'budget'): StudioEvent => ({ type: 'run_cancelling', runId, reason });

function overview(input: { sessions?: SessionOverviewSource[]; plans?: TaskPlanView[]; fleets?: FleetView[] }) {
  return buildAgentOverview({ sessions: input.sessions ?? [], plans: input.plans ?? [], fleets: input.fleets ?? [], now: NOW });
}

describe('state 판정', () => {
  const cases: Array<[Partial<SessionSnapshot>, string]> = [
    [{ status: 'starting' }, 'booting'],
    [{ status: 'ready', running: true }, 'working'],
    [{ status: 'ready', running: false }, 'idle'],
    [{ status: 'stopped' }, 'stopped'],
    [{ status: 'failed', error: '샌드박스를 시작하지 못했습니다' }, 'error'],
  ];

  it('세션 상태·실행 여부로 state를 정한다', () => {
    for (const [patch, expected] of cases) {
      const { items } = overview({ sessions: [source({ snapshot: snapshot(patch) })] });
      expect(items[0]!.state, JSON.stringify(patch)).toBe(expected);
    }
  });

  it('스냅샷이 없으면 fallbackState를 쓰고, 그것도 없으면 stopped다', () => {
    const lane = plan({ lanes: [{ id: 'a', paths: ['web'], status: 'failed', tasks: [], sessionId: 'gone', error: '게이트 실패' }] });
    const { items } = overview({ plans: [lane] });
    expect(items[0]).toMatchObject({ kind: 'lane', state: 'error', attention: 'gate_failed' });
  });
});

describe('attention 판정', () => {
  it('되묻기(pendingQuestion)가 있으면 question', () => {
    const withQuestion = snapshot({ pendingQuestion: { runId: 'r0', question: '어느 쪽으로 할까요?', options: ['표', '카드'], allowOther: false } });
    const { items } = overview({ sessions: [source({ snapshot: withQuestion })] });
    expect(items[0]!.attention).toBe('question');
  });

  it('pendingQuestion 필드가 없는 스냅샷은 question이 아니다', () => {
    const { items } = overview({ sessions: [source({ snapshot: snapshot({ running: true }) })] });
    expect(items[0]!.attention).toBeUndefined();
  });

  it('승인 대기 계획은 approval이고, 승인 전에는 레인 세션이 아직 없다', () => {
    const awaiting = plan({ status: 'awaiting_approval', id: 'p1', request: '주문에 필터 추가', planning: { usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 10 } });
    const { items, totals } = overview({ plans: [awaiting] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'lane', id: 'plan:p1', href: '/task-plans', attention: 'approval', title: '주문에 필터 추가' });
    expect(items[0]!.tokens).toEqual({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(totals).toMatchObject({ total: 1, attention: 1, working: 0 });
  });

  it('마지막 실행이 failed면 gate_failed, 세션 오류면 error', () => {
    const failed = overview({ sessions: [source({ snapshot: snapshot(), recent: [finished('r1', 'failed')] })] });
    expect(failed.items[0]!.attention).toBe('gate_failed');

    const errored = overview({ sessions: [source({ snapshot: snapshot({ status: 'failed', error: '기동 실패' }) })] });
    expect(errored.items[0]!.attention).toBe('error');
  });

  it('토큰 한도로 취소된 마지막 실행은 budget', () => {
    const budget = overview({ sessions: [source({ snapshot: snapshot(), recent: [cancelling('r1', 'budget'), finished('r1', 'cancelled')] })] });
    expect(budget.items[0]!.attention).toBe('budget');

    // 사용자가 취소한 것(reason 없음)은 개입 필요가 아니다
    const user = overview({ sessions: [source({ snapshot: snapshot(), recent: [cancelling('r1'), finished('r1', 'cancelled')] })] });
    expect(user.items[0]!.attention).toBeUndefined();
  });

  it('여러 사유가 겹치면 우선순위가 높은 하나만 남긴다(question > approval > gate_failed > error > budget)', () => {
    const withQuestion = snapshot({ status: 'failed', error: '오류', pendingQuestion: { runId: 'r0', question: '어느 쪽으로 할까요?', options: ['표', '카드'], allowOther: false } });
    const { items } = overview({ sessions: [source({ snapshot: withQuestion, recent: [cancelling('r1', 'budget'), finished('r1', 'failed')] })] });
    // question이 이기고, gate_failed·error·budget은 남지 않는다
    expect(items[0]!.attention).toBe('question');

    const gateAndError = overview({ sessions: [source({ snapshot: snapshot({ status: 'failed', error: '오류' }), recent: [finished('r1', 'failed')] })] });
    expect(gateAndError.items[0]!.attention).toBe('gate_failed');
  });
});

describe('활동 한 줄', () => {
  it('마지막 에이전트 이벤트를 사람이 읽는 한 줄로 만든다', () => {
    expect(activityOf([{ type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'run_in_service', input: {} } }])).toBe('도구 run_in_service');
    expect(activityOf([{ type: 'agent', runId: 'r1', event: { type: 'stage', stage: 'implement', source: 'platform' } }])).toBe('단계: 구현');
    expect(activityOf([{ type: 'agent', runId: 'r1', event: { type: 'workflow_check', check: { stage: 'test', name: 'api-unit', ok: true, attempts: 1 } } }])).toBe('게이트: api-unit');
    // 설명할 수 없는 이벤트뿐이면 모델 응답 대기다
    expect(activityOf([{ type: 'agent', runId: 'r1', event: { type: 'session', backend: 'api', model: 'm' } }])).toBe('모델 응답 대기');
    expect(activityOf([])).toBe('모델 응답 대기');
  });

  it('작업 중일 때만 activity를 붙인다', () => {
    const working = overview({ sessions: [source({ snapshot: snapshot({ running: true }), recent: [{ type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'read_file', input: {} } }] })] });
    expect(working.items[0]!.activity).toBe('도구 read_file');

    const idle = overview({ sessions: [source({ snapshot: snapshot({ running: false }), recent: [{ type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'read_file', input: {} } }] })] });
    expect(idle.items[0]!.activity).toBeUndefined();
  });
});

describe('목록·합계·정렬', () => {
  it('레인 세션은 session으로 중복해 올리지 않는다', () => {
    const lane = plan({ status: 'running', lanes: [{ id: 'a', paths: ['web'], status: 'running', tasks: [], sessionId: 's1' }] });
    const { items, totals } = overview({
      sessions: [source({ snapshot: snapshot({ id: 's1', running: true, tokens: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0 } }) })],
      plans: [lane],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'lane', id: 's1' });
    expect(totals.tokens).toEqual({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0 });
  });

  it('플릿 구성원은 fleet 종류로 올린다', () => {
    const fleet = fleetView({
      members: [{ sessionId: 's1', backend: 'api', modelId: 'm', label: 'M', provider: 'openai', status: 'running', usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
    });
    const { items } = overview({ sessions: [source({ snapshot: snapshot({ id: 's1', running: true }) })], fleets: [fleet] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'fleet', id: 's1', projectName: 'orders', title: '같은 요청' });
  });

  it('개입 필요 → 작업 중 → 나머지 순으로 정렬한다', () => {
    const { items } = overview({
      sessions: [
        source({ snapshot: snapshot({ id: 'idle', running: false }), updatedAt: '2026-09-29T11:59:00.000Z', lastRequest: '쉬는 세션' }),
        source({ snapshot: snapshot({ id: 'work', running: true }), updatedAt: '2026-09-29T11:58:00.000Z', lastRequest: '작업 중 세션' }),
        source({ snapshot: snapshot({ id: 'need', running: false }), updatedAt: '2026-09-29T11:57:00.000Z', lastRequest: '실패한 세션', recent: [finished('r1', 'failed')] }),
      ],
    });
    expect(items.map((item) => item.id)).toEqual(['need', 'work', 'idle']);
  });

  it('합계에 전체·개입 필요·작업 중 수와 토큰 합을 담는다', () => {
    const usage = (input: number) => ({ inputTokens: input, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 });
    const { totals } = overview({
      sessions: [
        source({ snapshot: snapshot({ id: 'a', running: true, tokens: usage(10) }) }),
        source({ snapshot: snapshot({ id: 'b', tokens: usage(20) }), recent: [finished('r1', 'failed')] }),
      ],
    });
    expect(totals).toEqual({ total: 2, attention: 1, working: 1, tokens: { inputTokens: 30, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6 } });
  });

  it('실행 중이면 요청 시작부터의 진행 시간을 잰다', () => {
    const { items } = overview({ sessions: [source({ snapshot: snapshot({ running: true }), runningSince: '2026-09-29T11:30:00.000Z' })] });
    expect(items[0]!.runningForMs).toBe(30 * 60_000);

    const idle = overview({ sessions: [source({ snapshot: snapshot({ running: false }), runningSince: '2026-09-29T11:30:00.000Z' })] });
    expect(idle.items[0]!.runningForMs).toBeUndefined();
  });

  it('제목은 요청 앞 80자로 줄이고, 요청이 없으면 프로젝트 이름을 쓴다', () => {
    const long = 'ㄱ'.repeat(TITLE_CHARS + 5);
    const { items } = overview({ sessions: [source({ lastRequest: long }), source({ snapshot: snapshot({ id: 's2' }) })] });
    expect(items.find((item) => item.id === 's1')!.title).toBe(`${'ㄱ'.repeat(TITLE_CHARS)}…`);
    expect(items.find((item) => item.id === 's2')!.title).toBe('orders');
  });
});

function plan(overrides: Partial<TaskPlanView> = {}): TaskPlanView {
  return { id: 'p1', owner: 'kim', projectId: 'orders', request: '요청', modelId: 'm', status: 'running', createdAt: '2026-09-29T11:00:00.000Z', lanes: [], ...overrides };
}

function fleetView(overrides: Partial<FleetView> = {}): FleetView {
  return {
    id: 'f1',
    owner: 'kim',
    projectId: 'orders',
    projectName: 'orders',
    request: '같은 요청',
    allowBreaking: false,
    createdAt: '2026-09-29T11:00:00.000Z',
    members: [],
    ...overrides,
  };
}
