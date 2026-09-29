import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(async () => {}),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ deleteSession: mocks.deleteSession }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(id = 's1'): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions/s1/delete', { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.deleteSession.mockClear();
  mocks.deleteSession.mockImplementation(async () => {});
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/delete', () => {
  it('세션 기록을 지우고 ok를 돌려준다', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(mocks.deleteSession).toHaveBeenCalledWith('s1');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('권한이 없으면 403을 돌려주고 지우지 않는다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만 바꿀 수 있습니다'));

    const response = await post();

    expect(response.status).toBe(403);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it('실행 중이면 409를 그대로 전한다', async () => {
    mocks.deleteSession.mockRejectedValueOnce(new StudioError(409, '실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요'));

    const response = await post();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('먼저 샌드박스를 중지');
  });
});
