import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ revokeBoardToken: vi.fn() }));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({ revokeBoardToken: mocks.revokeBoardToken }));

import { StudioError } from '@/lib/server/errors';
import { DELETE } from './route';

const context = { params: Promise.resolve({ id: 'plan-1', tokenId: 'tok-1' }) } as Parameters<typeof DELETE>[1];

function request(): Request {
  return new Request('http://studio.local/api/task-plans/plan-1/board/tokens/tok-1', { method: 'DELETE' });
}

beforeEach(() => {
  mocks.revokeBoardToken.mockReset();
});

describe('DELETE /api/task-plans/[id]/board/tokens/[tokenId]', () => {
  it('로그인한 사람 이름으로 토큰을 거두고 바뀐 계획을 돌려준다', async () => {
    mocks.revokeBoardToken.mockReturnValue({ id: 'plan-1', externalAgents: [{ id: 'tok-1', lane: 'guest-codex', createdAt: 'now', revokedAt: 'now' }] });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(200);
    expect(mocks.revokeBoardToken).toHaveBeenCalledWith('plan-1', 'kim', 'tok-1');
    expect((await response.json()).externalAgents[0].revokedAt).toBe('now');
  });

  it('모르는 토큰은 404를 그대로 전한다', async () => {
    mocks.revokeBoardToken.mockImplementation(() => {
      throw new StudioError(404, '토큰을 찾을 수 없습니다');
    });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(404);
  });

  it('내 계획이 아니면 403을 그대로 전한다', async () => {
    mocks.revokeBoardToken.mockImplementation(() => {
      throw new StudioError(403, '이 작업 계획을 볼 수 없습니다');
    });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(403);
  });
});
