import { describe, expect, it } from 'vitest';
import { ATTENTION_PRIORITY, type AgentItem } from './server/agents-overview';
import { MAX_SPLIT } from './split';
import { filterWork, groupWork, initialWorkTab, membersSummary, splitSelection, WORK_ATTENTION_PRIORITY, workCounts } from './work-list';

function item(overrides: Partial<AgentItem> & Pick<AgentItem, 'id'>): AgentItem {
  return {
    kind: 'session',
    title: '주문 목록 API와 화면을 만들어줘',
    projectName: 'orders',
    href: `/sessions/${overrides.id}`,
    state: 'idle',
    lastActivityAt: '2026-09-30T01:00:00.000Z',
    ...overrides,
  };
}

const usage = (input: number) => ({ inputTokens: input, outputTokens: 1, cacheReadTokens: 10, cacheWriteTokens: 0 });

describe('groupWork', () => {
  it('같은 비교·계획의 항목을 한 줄로 묶고, 소속이 없으면 한 명으로 둔다', () => {
    const fleet = { kind: 'fleet' as const, id: 'f1', href: '/fleets?id=f1' };
    const works = groupWork([
      item({ id: 's1' }),
      item({ id: 'm1', kind: 'fleet', group: fleet, state: 'working', tokens: usage(5) }),
      item({ id: 'm2', kind: 'fleet', group: fleet, state: 'idle', tokens: usage(7), lastActivityAt: '2026-09-30T02:00:00.000Z' }),
      item({ id: 'l1', kind: 'lane', group: { kind: 'plan', id: 'p1', href: '/task-plans?id=p1' }, lastActivityAt: '2026-09-30T01:30:00.000Z' }),
    ]);

    // 작업 중인 비교가 먼저, 나머지는 최근 활동 순
    expect(works.map((work) => [work.key, work.mode, work.members.length])).toEqual([
      ['fleet:f1', 'fleet', 2],
      ['plan:p1', 'split', 1],
      ['session:s1', 'single', 1],
    ]);
    const fleetWork = works[0]!;
    // 묶음은 비교 화면으로, 대표 상태는 움직이는 쪽, 활동 시각은 가장 최근, 토큰은 합
    expect(fleetWork).toMatchObject({ href: '/fleets?id=f1', state: 'working', lastActivityAt: '2026-09-30T02:00:00.000Z', sessionIds: ['m1', 'm2'] });
    expect(fleetWork.tokens).toEqual({ inputTokens: 12, outputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 0 });
    expect(works[2]).toMatchObject({ href: '/sessions/s1', sessionIds: ['s1'] });
    expect(works[2]!.tokens).toBeUndefined();
  });

  it('구성원 중 하나라도 개입이 필요하면 그 줄이 개입 필요이고, 우선순위가 높은 사유를 고른다', () => {
    const plan = { kind: 'plan' as const, id: 'p1', href: '/task-plans?id=p1' };
    const works = groupWork([
      item({ id: 's1', state: 'working', lastActivityAt: '2026-09-30T09:00:00.000Z' }),
      item({ id: 'l1', kind: 'lane', group: plan, attention: 'error' }),
      item({ id: 'l2', kind: 'lane', group: plan, attention: 'question' }),
    ]);

    // 개입 필요가 작업 중보다 먼저 선다
    expect(works[0]).toMatchObject({ key: 'plan:p1', attention: 'question' });
    expect(works[1]).toMatchObject({ key: 'session:s1', state: 'working' });
  });

  it('승인 대기 계획은 세션이 없어 나란히 볼 세션이 비어 있다', () => {
    const [work] = groupWork([item({ id: 'plan:p1', kind: 'lane', group: { kind: 'plan', id: 'p1', href: '/task-plans?id=p1' }, attention: 'approval' })]);

    expect(work!.sessionIds).toEqual([]);
    expect(membersSummary(work!)).toBe('계획 승인 대기');
  });

  it('화면의 개입 사유 우선순위는 서버와 같다', () => {
    expect(WORK_ATTENTION_PRIORITY).toEqual(ATTENTION_PRIORITY);
  });
});

describe('탭·개수', () => {
  const works = groupWork([
    item({ id: 's1', attention: 'gate_failed' }),
    item({ id: 's2' }),
    item({ id: 'm1', kind: 'fleet', group: { kind: 'fleet', id: 'f1', href: '/fleets?id=f1' } }),
  ]);

  it('방식과 개입 필요로 거른다', () => {
    expect(filterWork(works, 'all')).toHaveLength(3);
    expect(filterWork(works, 'attention').map((work) => work.key)).toEqual(['session:s1']);
    expect(filterWork(works, 'single')).toHaveLength(2);
    expect(filterWork(works, 'fleet').map((work) => work.key)).toEqual(['fleet:f1']);
    expect(filterWork(works, 'split')).toEqual([]);
    expect(workCounts(works)).toEqual({ all: 3, attention: 1, single: 2, fleet: 1, split: 0 });
  });

  it('개입 필요가 있으면 그 탭부터, 없으면 전체부터 연다', () => {
    expect(initialWorkTab(works)).toBe('attention');
    expect(initialWorkTab(filterWork(works, 'fleet'))).toBe('all');
  });
});

describe('splitSelection', () => {
  const fleet = { kind: 'fleet' as const, id: 'f1', href: '/fleets?id=f1' };
  const works = groupWork([
    item({ id: 's1' }),
    item({ id: 'm1', kind: 'fleet', group: fleet }),
    item({ id: 'm2', kind: 'fleet', group: fleet }),
    item({ id: 'm3', kind: 'fleet', group: fleet }),
  ]);

  it('고른 작업의 세션을 고른 순서대로 모은다', () => {
    expect(splitSelection(works, ['session:s1', 'fleet:f1'])).toEqual({ ids: ['s1', 'm1', 'm2', 'm3'], dropped: 0 });
  });

  it('상한을 넘으면 뒤의 것을 버리고 몇 개인지 알린다', () => {
    const extra = groupWork([...works.flatMap((work) => work.members), item({ id: 's9' })]);
    const result = splitSelection(extra, ['fleet:f1', 'session:s1', 'session:s9']);

    expect(result.ids).toHaveLength(MAX_SPLIT);
    expect(result.dropped).toBe(1);
  });

  it('없는 키는 무시한다', () => {
    expect(splitSelection(works, ['session:gone'])).toEqual({ ids: [], dropped: 0 });
  });
});

describe('membersSummary', () => {
  it('비교는 참가자 수, 병렬은 레인 수와 작업 중 수를 적고, 한 명은 없다', () => {
    const works = groupWork([
      item({ id: 's1' }),
      item({ id: 'm1', kind: 'fleet', group: { kind: 'fleet', id: 'f1', href: '/fleets?id=f1' }, state: 'working' }),
      item({ id: 'm2', kind: 'fleet', group: { kind: 'fleet', id: 'f1', href: '/fleets?id=f1' } }),
      item({ id: 'l1', kind: 'lane', group: { kind: 'plan', id: 'p1', href: '/task-plans?id=p1' } }),
    ]);
    const byKey = new Map(works.map((work) => [work.key, work]));

    expect(membersSummary(byKey.get('fleet:f1')!)).toBe('참가자 2명 · 작업 중 1');
    expect(membersSummary(byKey.get('plan:p1')!)).toBe('레인 1개');
    expect(membersSummary(byKey.get('session:s1')!)).toBeUndefined();
  });
});
