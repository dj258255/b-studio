import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publishSessionRequirementIssues: vi.fn(async () => ({
    plan: [],
    summary: { total: 0, create: 0, update: 0, unchanged: 0, conflict: 0, reverify: 0, closedButRequirementExists: 0 },
    errors: [],
  })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ publishSessionRequirementIssues: mocks.publishSessionRequirementIssues }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/requirements/publish`, { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.publishSessionRequirementIssues.mockClear();
  mocks.authorizeSession.mockClear().mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/requirements/publish', () => {
  it('발행 결과를 돌려준다', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.publishSessionRequirementIssues).toHaveBeenCalledWith('s1');
  });

  it('저장된 요구사항이 없으면 400', async () => {
    mocks.publishSessionRequirementIssues.mockRejectedValueOnce(new StudioError(400, '저장된 요구사항이 없습니다'));
    const response = await post();
    expect(response.status).toBe(400);
  });
});
