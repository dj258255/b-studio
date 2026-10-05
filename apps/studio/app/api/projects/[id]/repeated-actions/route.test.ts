import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepeatedActionsReport } from '@/lib/server/repeated-actions';

const spies = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  projectRepeatedActions: vi.fn(async (): Promise<RepeatedActionsReport> => {
    throw new Error('테스트가 준비되지 않았습니다');
  }),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: spies.requireUser }));
vi.mock('@/lib/server/repeated-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/repeated-actions')>();
  return { ...actual, projectRepeatedActions: spies.projectRepeatedActions };
});

import { StudioError } from '@/lib/server/errors';
import { GET } from './route';

const report: RepeatedActionsReport = {
  projectId: 'orders',
  projectName: 'orders',
  generatedAt: '2026-09-30T00:00:00.000Z',
  sessionsAnalyzed: 3,
  candidates: [],
  ignoredCount: 0,
};

const context = { params: Promise.resolve({ id: 'orders' }) } as Parameters<typeof GET>[1];

function request(): Request {
  return new Request('http://studio.local/api/projects/orders/repeated-actions');
}

beforeEach(() => {
  spies.requireUser.mockReset();
  spies.requireUser.mockReturnValue('kim');
  spies.projectRepeatedActions.mockReset();
  spies.projectRepeatedActions.mockResolvedValue(report);
});

describe('GET /api/projects/[id]/repeated-actions', () => {
  it('되풀이 후보 보고서를 돌려준다', async () => {
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(spies.projectRepeatedActions).toHaveBeenCalledWith('orders');
    expect((await response.json()).report).toEqual(report);
  });

  it('로그인하지 않으면 401이고 아무것도 읽지 않는다', async () => {
    spies.requireUser.mockImplementation(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await GET(request(), context);

    expect(response.status).toBe(401);
    expect(spies.projectRepeatedActions).not.toHaveBeenCalled();
  });

  it('프로젝트가 없으면 404다', async () => {
    spies.projectRepeatedActions.mockImplementation(() => {
      throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
    });
    const response = await GET(request(), context);

    expect(response.status).toBe(404);
  });
});
