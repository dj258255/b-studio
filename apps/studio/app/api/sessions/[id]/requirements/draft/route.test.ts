import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discardSessionRequirementExtractionDraft: vi.fn(async () => {}),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ discardSessionRequirementExtractionDraft: mocks.discardSessionRequirementExtractionDraft }));

import { StudioError } from '@/lib/server/errors';
import { DELETE } from './route';

function del(id = 's1'): Promise<Response> {
  return DELETE(new Request(`http://localhost/api/sessions/${id}/requirements/draft`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.discardSessionRequirementExtractionDraft.mockClear();
  mocks.discardSessionRequirementExtractionDraft.mockImplementation(async () => {});
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('DELETE /api/sessions/[id]/requirements/draft(ADR-0XX, 버그 리포트 A)', () => {
  it('저장 안 한 추출 결과를 버린다', async () => {
    const response = await del();

    expect(response.status).toBe(200);
    expect(mocks.discardSessionRequirementExtractionDraft).toHaveBeenCalledWith('s1');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('권한이 없으면 403', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만'));

    const response = await del();

    expect(response.status).toBe(403);
    expect(mocks.discardSessionRequirementExtractionDraft).not.toHaveBeenCalled();
  });
});
