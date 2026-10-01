import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewStateView } from '@/lib/studio-events';

const resolvedReview: ReviewStateView = { state: 'resolved', maxRounds: 2, rounds: [] };

const mocks = vi.hoisted(() => ({
  resolveReviewFinding: vi.fn(async () => ({ review: resolvedReview }) as never),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ resolveReviewFinding: mocks.resolveReviewFinding }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions/s1/review/resolve', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.resolveReviewFinding.mockClear();
  mocks.resolveReviewFinding.mockImplementation(async () => ({ review: resolvedReview }) as never);
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/review/resolve', () => {
  it('지적을 오탐으로 닫고 요청한 사람을 by로 남긴다', async () => {
    const response = await post({ round: 1, findingIndex: 0, reason: '실제 PostgreSQL에서 새 글 id 43·44 확인' });

    expect(response.status).toBe(200);
    expect(mocks.resolveReviewFinding).toHaveBeenCalledWith('s1', { round: 1, findingIndex: 0, reason: '실제 PostgreSQL에서 새 글 id 43·44 확인', by: 'kim' });
    expect((await response.json()).review).toEqual(resolvedReview);
  });

  it('round·findingIndex·reason이 빠지면 400을 돌려준다', async () => {
    const response = await post({ round: 1, findingIndex: 0 });

    expect(response.status).toBe(400);
    expect(mocks.resolveReviewFinding).not.toHaveBeenCalled();
  });

  it('권한이 없으면 403을 돌려주고 닫지 않는다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만 바꿀 수 있습니다'));

    const response = await post({ round: 1, findingIndex: 0, reason: '근거' });

    expect(response.status).toBe(403);
    expect(mocks.resolveReviewFinding).not.toHaveBeenCalled();
  });

  it('지적을 찾지 못하면 그 이유를 그대로 전한다', async () => {
    mocks.resolveReviewFinding.mockRejectedValueOnce(new StudioError(404, '지적을 찾을 수 없습니다'));

    const response = await post({ round: 1, findingIndex: 0, reason: '근거' });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('지적을 찾을 수 없습니다');
  });
});
