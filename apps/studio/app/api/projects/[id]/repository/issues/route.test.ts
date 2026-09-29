import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  projectRepositoryIssues: vi.fn(async (): Promise<unknown> => {
    throw new Error('테스트가 준비되지 않았습니다');
  }),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: spies.requireUser }));
vi.mock('@/lib/server/repository-panel', () => ({ projectRepositoryIssues: spies.projectRepositoryIssues }));

import { StudioError } from '@/lib/server/errors';
import { GET } from './route';

const context = { params: Promise.resolve({ id: 'orders' }) } as Parameters<typeof GET>[1];

function request(query = ''): Request {
  return new Request(`http://studio.local/api/projects/orders/repository/issues${query}`);
}

beforeEach(() => {
  spies.requireUser.mockReset();
  spies.requireUser.mockReturnValue('kim');
  spies.projectRepositoryIssues.mockReset();
  spies.projectRepositoryIssues.mockResolvedValue({ ok: true, remote: { kind: 'github', display: 'github.com/acme/orders' }, issues: [] });
});

describe('GET /api/projects/[id]/repository/issues', () => {
  it('state 없이 부르면 open으로 조회한다', async () => {
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(spies.projectRepositoryIssues).toHaveBeenCalledWith('orders', 'open');
    expect((await response.json()).ok).toBe(true);
  });

  it('state를 그대로 넘긴다', async () => {
    await GET(request('?state=closed'), context);
    expect(spies.projectRepositoryIssues).toHaveBeenCalledWith('orders', 'closed');

    await GET(request('?state=all'), context);
    expect(spies.projectRepositoryIssues).toHaveBeenCalledWith('orders', 'all');
  });

  it('모르는 state는 400이고 조회하지 않는다', async () => {
    const response = await GET(request('?state=merged'), context);

    expect(response.status).toBe(400);
    expect(spies.projectRepositoryIssues).not.toHaveBeenCalled();
  });

  it('로그인하지 않으면 401이고 아무것도 읽지 않는다', async () => {
    spies.requireUser.mockImplementation(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await GET(request(), context);

    expect(response.status).toBe(401);
    expect(spies.projectRepositoryIssues).not.toHaveBeenCalled();
  });

  it('원격 저장소가 없거나 토큰이 없어도 200과 이유를 돌려준다(오류로 만들지 않는다)', async () => {
    spies.projectRepositoryIssues.mockResolvedValue({ ok: false, reason: 'no_token', detail: 'B_STUDIO_GITHUB_TOKEN을 설정하거나 gh auth login으로 로그인하세요' });
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: false, reason: 'no_token', detail: 'B_STUDIO_GITHUB_TOKEN을 설정하거나 gh auth login으로 로그인하세요' });
  });
});
