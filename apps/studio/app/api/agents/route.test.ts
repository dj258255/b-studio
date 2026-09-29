import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  listAgentOverview: vi.fn(async () => ({
    items: [{ kind: 'session', id: 's1', title: '요청', projectName: 'orders', href: '/sessions/s1', state: 'working', lastActivityAt: '2026-09-29T00:00:00.000Z' }],
    totals: { total: 1, attention: 0, working: 1, tokens: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
  })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/agents-overview', () => ({ listAgentOverview: mocks.listAgentOverview }));

import { GET } from './route';

beforeEach(() => {
  mocks.requireUser.mockImplementation(() => 'kim');
  mocks.listAgentOverview.mockClear();
});

describe('GET /api/agents', () => {
  it('로그인한 사람의 관제 목록과 합계를 돌려준다', async () => {
    const response = await GET(new Request('http://localhost/api/agents'));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; totals: { total: number } };
    expect(body.items).toHaveLength(1);
    expect(body.totals.total).toBe(1);
    // 범위는 기존 목록 함수와 같다: 로그인한 사람을 수집기에 넘긴다
    expect(mocks.listAgentOverview).toHaveBeenCalledWith('kim');
  });

  it('로그인하지 않았으면 401을 돌려주고 목록을 만들지 않는다', async () => {
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });

    const response = await GET(new Request('http://localhost/api/agents'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: '로그인이 필요합니다' });
    expect(mocks.listAgentOverview).not.toHaveBeenCalled();
  });
});
