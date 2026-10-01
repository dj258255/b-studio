import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncSessionRequirementIssueStatus: vi.fn(async () => ({ updated: [], errors: [] })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ syncSessionRequirementIssueStatus: mocks.syncSessionRequirementIssueStatus }));

import { POST } from './route';

function post(id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/requirements/publish/sync`, { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.syncSessionRequirementIssueStatus.mockClear();
  mocks.authorizeSession.mockClear().mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/requirements/publish/sync', () => {
  it('상태 동기화 결과를 돌려준다', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.syncSessionRequirementIssueStatus).toHaveBeenCalledWith('s1');
  });
});
