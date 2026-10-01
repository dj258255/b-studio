import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../studio-events';
import { pickWorkspace, workspaceChoiceFor } from './workspace-entry';

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    projectId: 'orders',
    projectName: 'orders',
    status: 'stopped',
    mode: 'claude-code',
    owner: 'me',
    workspace: 'copy',
    checkpoints: 1,
    updatedAt: '2026-09-30T01:00:00.000Z',
    ...overrides,
  };
}

const base = {
  excluded: new Set<string>(),
  viewer: 'me',
  canManage: (viewer: string, owner: string | undefined) => owner === undefined || owner === viewer,
  projectIds: ['orders', 'shop'],
  localAllowed: true,
};

describe('pickWorkspace', () => {
  it('가장 최근 세션의 프로젝트에서 켜진 세션을 먼저 연다', () => {
    // 최근 순: 중지된 s1이 가장 최근이지만 같은 프로젝트에 켜진 s2가 있으면 그것을 연다
    const pick = pickWorkspace({ ...base, sessions: [summary({ id: 's1' }), summary({ id: 's2', status: 'ready' }), summary({ id: 's3', projectId: 'shop', status: 'ready' })] });

    expect(pick).toMatchObject({ projectId: 'orders', session: { id: 's2' } });
  });

  it('켜진 세션이 없으면 가장 최근 세션(중지·지연 기동)을 연다', () => {
    const pick = pickWorkspace({ ...base, sessions: [summary({ id: 's1', status: 'idle' }), summary({ id: 's2' })] });

    expect(pick.session?.id).toBe('s1');
  });

  it('프로젝트를 지정하면 그 프로젝트에서만 고르고, 세션이 없으면 새로 만든다', () => {
    const pick = pickWorkspace({ ...base, projectId: 'shop', sessions: [summary({ id: 's1', status: 'ready' })] });

    expect(pick.session).toBeUndefined();
    expect(pick.projectId).toBe('shop');
  });

  it('비교 참가자·병렬 레인, 남의 세션, 켜지 못한 세션, 없는 프로젝트의 세션은 고르지 않는다', () => {
    const pick = pickWorkspace({
      ...base,
      excluded: new Set(['lane']),
      sessions: [
        summary({ id: 'lane', status: 'ready' }),
        summary({ id: 'other', owner: 'you', status: 'ready' }),
        summary({ id: 'broken', status: 'failed' }),
        summary({ id: 'gone', projectId: 'deleted', status: 'ready' }),
        summary({ id: 'mine' }),
      ],
    });

    expect(pick.session?.id).toBe('mine');
  });

  it('세션이 하나도 없으면 첫 프로젝트로 새로 만든다', () => {
    expect(pickWorkspace({ ...base, sessions: [] })).toEqual({ projectId: 'orders', workspace: 'copy' });
  });

  it('새로 만들 때 작업 위치는 마지막 세션을 따르되, 내 폴더를 쓸 수 없으면 복사본이다', () => {
    const sessions = [summary({ id: 's1', projectId: 'shop', workspace: 'local' })];

    expect(pickWorkspace({ ...base, projectId: 'orders', sessions }).workspace).toBe('local');
    expect(pickWorkspace({ ...base, projectId: 'orders', sessions, localAllowed: false }).workspace).toBe('copy');
  });
});

describe('workspaceChoiceFor', () => {
  it('켜져 있거나 켜는 중이면 바로 연다(live)', () => {
    expect(workspaceChoiceFor({ session: summary({ id: 's1', status: 'ready' }), projectId: 'orders', workspace: 'copy' })).toEqual({ kind: 'live', id: 's1' });
    expect(workspaceChoiceFor({ session: summary({ id: 's1', status: 'starting' }), projectId: 'orders', workspace: 'copy' })).toEqual({ kind: 'live', id: 's1' });
  });

  it('지연 기동(idle)·중지(stopped) 세션은 곧바로 켜지 않고 이어서 열기 선택을 돌려준다(resumable)', () => {
    expect(workspaceChoiceFor({ session: summary({ id: 's1', projectId: 'orders', projectName: '주문', status: 'idle', updatedAt: '2026-01-01T00:00:00.000Z' }), projectId: 'orders', workspace: 'copy' })).toEqual({
      kind: 'resumable',
      sessionId: 's1',
      projectId: 'orders',
      projectName: '주문',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(workspaceChoiceFor({ session: summary({ id: 's2', status: 'stopped' }), projectId: 'orders', workspace: 'copy' }).kind).toBe('resumable');
  });

  it('고를 세션이 없으면(새 프로젝트) 바로 만들 수밖에 없다(start)', () => {
    expect(workspaceChoiceFor({ projectId: 'orders', workspace: 'copy' })).toEqual({ kind: 'start', projectId: 'orders' });
    expect(workspaceChoiceFor({ workspace: 'copy' })).toEqual({ kind: 'start' });
  });
});
