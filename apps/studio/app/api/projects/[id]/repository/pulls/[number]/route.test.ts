import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  projectRepositoryPull: vi.fn(async (): Promise<unknown> => {
    throw new Error('테스트가 준비되지 않았습니다');
  }),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: spies.requireUser }));
vi.mock('@/lib/server/repository-panel', () => ({ projectRepositoryPull: spies.projectRepositoryPull }));

import { StudioError } from '@/lib/server/errors';
import { GET } from './route';

function context(number: string): Parameters<typeof GET>[1] {
  return { params: Promise.resolve({ id: 'orders', number }) } as Parameters<typeof GET>[1];
}

function request(): Request {
  return new Request('http://studio.local/api/projects/orders/repository/pulls/21');
}

beforeEach(() => {
  spies.requireUser.mockReset();
  spies.requireUser.mockReturnValue('kim');
  spies.projectRepositoryPull.mockReset();
  spies.projectRepositoryPull.mockResolvedValue({ ok: true, remote: { kind: 'github', display: 'github.com/acme/orders' }, pull: { number: 21 } });
});

describe('GET /api/projects/[id]/repository/pulls/[number]', () => {
  it('번호를 그대로 넘겨 상세를 돌려준다', async () => {
    const response = await GET(request(), context('21'));

    expect(response.status).toBe(200);
    expect(spies.projectRepositoryPull).toHaveBeenCalledWith('orders', 21);
    expect((await response.json()).ok).toBe(true);
  });

  it('번호가 아니거나 0 이하이면 400이고 조회하지 않는다', async () => {
    for (const bad of ['abc', '0', '-1']) {
      const response = await GET(request(), context(bad));
      expect(response.status).toBe(400);
    }
    expect(spies.projectRepositoryPull).not.toHaveBeenCalled();
  });

  it('로그인하지 않으면 401이고 아무것도 읽지 않는다', async () => {
    spies.requireUser.mockImplementation(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await GET(request(), context('21'));

    expect(response.status).toBe(401);
    expect(spies.projectRepositoryPull).not.toHaveBeenCalled();
  });
});
