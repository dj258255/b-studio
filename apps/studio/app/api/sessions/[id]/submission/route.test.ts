import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { SubmissionReport } from '@/lib/submission-checklist';

function emptyReport(): SubmissionReport {
  return { items: [], score: { passed: 0, total: 0 } };
}

const mocks = vi.hoisted(() => ({
  submissionReport: vi.fn<(id: string) => Promise<unknown>>(async () => ({ items: [], score: { passed: 0, total: 0 } })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ submissionReport: mocks.submissionReport }));

import { StudioError } from '@/lib/server/errors';
import { GET } from './route';

function get(id = 's1'): Promise<Response> {
  return GET(new Request(`http://localhost/api/sessions/${id}/submission`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.submissionReport.mockClear();
  mocks.submissionReport.mockImplementation(async () => emptyReport());
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('GET /api/sessions/[id]/submission', () => {
  it('점검표를 돌려준다', async () => {
    const report: SubmissionReport = {
      items: [{ id: 'requirements', title: '요구사항', status: 'pass', reason: '모두 완료' }],
      score: { passed: 1, total: 1 },
    };
    mocks.submissionReport.mockResolvedValueOnce(report);

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ id: 'requirements', title: '요구사항', status: 'pass', reason: '모두 완료' }],
      score: { passed: 1, total: 1 },
    });
    expect(mocks.submissionReport).toHaveBeenCalledWith('s1');
  });

  it('권한이 없으면 403을 돌려주고 점검표를 부르지 않는다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만 볼 수 있습니다'));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mocks.submissionReport).not.toHaveBeenCalled();
  });

  it('세션을 찾지 못하면 404를 그대로 전한다', async () => {
    mocks.submissionReport.mockRejectedValueOnce(new StudioError(404, '세션을 찾을 수 없습니다'));

    const response = await get();

    expect(response.status).toBe(404);
  });
});
