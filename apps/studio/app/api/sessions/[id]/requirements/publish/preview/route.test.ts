import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  previewRequirementIssuePublish: vi.fn(async () => ({ plan: [], summary: { total: 0, create: 0, update: 0, unchanged: 0, conflict: 0, reverify: 0, closedButRequirementExists: 0 } })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ previewRequirementIssuePublish: mocks.previewRequirementIssuePublish }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/requirements/publish/preview`, { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.previewRequirementIssuePublish.mockClear();
  mocks.authorizeSession.mockClear().mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/requirements/publish/preview', () => {
  it('발행 계획 미리보기를 돌려준다', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.previewRequirementIssuePublish).toHaveBeenCalledWith('s1');
  });

  it('원격·토큰이 없으면 오류를 그대로 전한다', async () => {
    mocks.previewRequirementIssuePublish.mockRejectedValueOnce(new StudioError(409, '토큰이 없습니다'));
    const response = await post();
    expect(response.status).toBe(409);
  });

  it('권한이 없으면 403', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만'));
    const response = await post();
    expect(response.status).toBe(403);
  });
});
