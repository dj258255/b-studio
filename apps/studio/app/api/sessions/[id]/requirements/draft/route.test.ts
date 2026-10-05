import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discardSessionRequirementExtractionDraft: vi.fn(async () => {}),
  updateSessionRequirementExtractionDraft: vi.fn(async () => ({ requirements: [], questions: [], source: 'model', referencedFiles: [], outOfScope: [], assumptions: [], manualSteps: [], savedAt: '', updatedAt: '' })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({
  discardSessionRequirementExtractionDraft: mocks.discardSessionRequirementExtractionDraft,
  updateSessionRequirementExtractionDraft: mocks.updateSessionRequirementExtractionDraft,
}));

import { StudioError } from '@/lib/server/errors';
import { DELETE, PATCH } from './route';

function del(id = 's1'): Promise<Response> {
  return DELETE(new Request(`http://localhost/api/sessions/${id}/requirements/draft`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
}

function patch(body: unknown, id = 's1'): Promise<Response> {
  return PATCH(
    new Request(`http://localhost/api/sessions/${id}/requirements/draft`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  mocks.discardSessionRequirementExtractionDraft.mockClear();
  mocks.discardSessionRequirementExtractionDraft.mockImplementation(async () => {});
  mocks.updateSessionRequirementExtractionDraft.mockClear();
  mocks.updateSessionRequirementExtractionDraft.mockImplementation(async () => ({
    requirements: [],
    questions: [],
    source: 'model',
    referencedFiles: [],
    outOfScope: [],
    assumptions: [],
    manualSteps: [],
    savedAt: '',
    updatedAt: '',
  }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('DELETE /api/sessions/[id]/requirements/draft(ADR-097, 버그 리포트 A)', () => {
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

describe('PATCH /api/sessions/[id]/requirements/draft(자동 저장, ADR-097 개정)', () => {
  it('편집 내용을 자동 저장한다', async () => {
    const response = await patch({ assumptions: ['동시 접속자 100명'] });

    expect(response.status).toBe(200);
    expect(mocks.updateSessionRequirementExtractionDraft).toHaveBeenCalledWith('s1', { assumptions: ['동시 접속자 100명'] });
  });

  it('저장 안 한 추출 결과가 없으면(서버가 404를 던지면) 그대로 전달한다', async () => {
    mocks.updateSessionRequirementExtractionDraft.mockRejectedValueOnce(new StudioError(404, '저장 안 한 추출 결과가 없습니다'));

    const response = await patch({ assumptions: [] });

    expect(response.status).toBe(404);
  });

  it('권한이 없으면 403이고 자동 저장을 부르지 않는다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만'));

    const response = await patch({ assumptions: [] });

    expect(response.status).toBe(403);
    expect(mocks.updateSessionRequirementExtractionDraft).not.toHaveBeenCalled();
  });
});
