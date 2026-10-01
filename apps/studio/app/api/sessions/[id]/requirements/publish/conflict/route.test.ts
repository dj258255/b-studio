import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSessionRequirementConflict: vi.fn(async () => ({ action: 'ignore' as const })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ resolveSessionRequirementConflict: mocks.resolveSessionRequirementConflict }));

import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/requirements/publish/conflict`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.resolveSessionRequirementConflict.mockClear().mockImplementation(async () => ({ action: 'ignore' }));
  mocks.authorizeSession.mockClear().mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/requirements/publish/conflict', () => {
  it('requirementId·resolution을 그대로 전달한다', async () => {
    const response = await post({ requirementId: 'R1', resolution: 'overwrite' });
    expect(response.status).toBe(200);
    expect(mocks.resolveSessionRequirementConflict).toHaveBeenCalledWith('s1', 'R1', 'overwrite');
  });

  it('resolution이 목록 밖이면 400', async () => {
    const response = await post({ requirementId: 'R1', resolution: 'delete' });
    expect(response.status).toBe(400);
    expect(mocks.resolveSessionRequirementConflict).not.toHaveBeenCalled();
  });

  it('requirementId가 없으면 400', async () => {
    const response = await post({ resolution: 'ignore' });
    expect(response.status).toBe(400);
  });
});
