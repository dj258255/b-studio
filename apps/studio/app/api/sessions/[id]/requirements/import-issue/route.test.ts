import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  importRequirementDraftFromIssue: vi.fn(async () => ({ title: '제목', kind: 'api', priority: 'must', acceptance: ['a'], guessed: false })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ importRequirementDraftFromIssue: mocks.importRequirementDraftFromIssue }));

import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/requirements/import-issue`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.importRequirementDraftFromIssue.mockClear().mockImplementation(async () => ({ title: '제목', kind: 'api', priority: 'must', acceptance: ['a'], guessed: false }));
  mocks.authorizeSession.mockClear().mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/requirements/import-issue', () => {
  it('이슈 번호로 초안을 가져온다', async () => {
    const response = await post({ issueNumber: 57 });
    expect(response.status).toBe(200);
    expect(mocks.importRequirementDraftFromIssue).toHaveBeenCalledWith('s1', 57);
  });

  it('숫자가 아니면 400', async () => {
    const response = await post({ issueNumber: 'abc' });
    expect(response.status).toBe(400);
    expect(mocks.importRequirementDraftFromIssue).not.toHaveBeenCalled();
  });
});
