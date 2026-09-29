import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  projectRepositoryPulls: vi.fn(async (): Promise<unknown> => {
    throw new Error('테스트가 준비되지 않았습니다');
  }),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: spies.requireUser }));
vi.mock('@/lib/server/repository-panel', () => ({ projectRepositoryPulls: spies.projectRepositoryPulls }));

import { StudioError } from '@/lib/server/errors';
import { GET } from './route';

const context = { params: Promise.resolve({ id: 'orders' }) } as Parameters<typeof GET>[1];

function request(query = ''): Request {
  return new Request(`http://studio.local/api/projects/orders/repository/pulls${query}`);
}

beforeEach(() => {
  spies.requireUser.mockReset();
  spies.requireUser.mockReturnValue('kim');
  spies.projectRepositoryPulls.mockReset();
  spies.projectRepositoryPulls.mockResolvedValue({ ok: true, remote: { kind: 'github', display: 'github.com/acme/orders' }, pulls: [] });
});

describe('GET /api/projects/[id]/repository/pulls', () => {
  it('state 없이 부르면 open으로 조회한다', async () => {
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(spies.projectRepositoryPulls).toHaveBeenCalledWith('orders', 'open');
    expect((await response.json()).ok).toBe(true);
  });

  it('모르는 state는 400이고 조회하지 않는다', async () => {
    const response = await GET(request('?state=merged'), context);

    expect(response.status).toBe(400);
    expect(spies.projectRepositoryPulls).not.toHaveBeenCalled();
  });

  it('로그인하지 않으면 401이고 아무것도 읽지 않는다', async () => {
    spies.requireUser.mockImplementation(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await GET(request(), context);

    expect(response.status).toBe(401);
    expect(spies.projectRepositoryPulls).not.toHaveBeenCalled();
  });
});
