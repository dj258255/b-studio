import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bootSession: vi.fn(async () => ({ id: 's1', status: 'ready' })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ bootSession: mocks.bootSession }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(id = 's1'): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions/s1/boot', { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.bootSession.mockClear();
  mocks.bootSession.mockImplementation(async () => ({ id: 's1', status: 'ready' }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/boot', () => {
  it('샌드박스를 지금 켜고 202로 스냅샷을 돌려준다', async () => {
    const response = await post();

    expect(response.status).toBe(202);
    expect(mocks.bootSession).toHaveBeenCalledWith('s1');
    expect(await response.json()).toMatchObject({ id: 's1', status: 'ready' });
  });

  it('권한이 없으면 403을 돌려주고 켜지 않는다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만 바꿀 수 있습니다'));

    const response = await post();

    expect(response.status).toBe(403);
    expect(mocks.bootSession).not.toHaveBeenCalled();
  });

  it('켜지 못하면 그 이유를 그대로 전한다', async () => {
    mocks.bootSession.mockRejectedValueOnce(new StudioError(502, '샌드박스를 켜지 못했습니다: 포트 부족'));

    const response = await post();

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('포트 부족');
  });
});
