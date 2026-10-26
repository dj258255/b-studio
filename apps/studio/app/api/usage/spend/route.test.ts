import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn(() => true),
  read: vi.fn(),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/repo-token', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/spend-state', async (original) => ({
  ...(await original<typeof import('@/lib/server/spend-state')>()),
  spendStore: () => ({ read: mocks.read }),
}));

import { GET } from './route';

beforeEach(() => {
  mocks.requireUser.mockClear().mockImplementation(() => 'kim');
  mocks.localFolderAllowed.mockClear().mockReturnValue(true);
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  mocks.read.mockReset().mockReturnValue({ version: 1, days: { [key]: { codex: { 'gpt-5.5': { usage: usage(1000), calls: 1 } } } } });
});

describe('GET /api/usage/spend', () => {
  it('오늘과 최근 7일의 토큰·비용을 돌려준다(단가가 없으면 비용 없이)', async () => {
    const response = await GET(new Request('http://localhost/api/usage/spend'));
    const body = (await response.json()) as { today: { tokens: number; missingPrice: boolean; rows: unknown[] }; week: { tokens: number } };

    expect(response.status).toBe(200);
    expect(body.today.tokens).toBe(1000);
    expect(body.week.tokens).toBe(1000);
    expect(body.today.rows).toHaveLength(1);
  });

  it('개인 PC 모드가 아니면 403이다', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);
    const response = await GET(new Request('http://localhost/api/usage/spend'));
    expect(response.status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('로그인하지 않았으면 401이다', async () => {
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await GET(new Request('http://localhost/api/usage/spend'));
    expect(response.status).toBe(401);
  });
});
