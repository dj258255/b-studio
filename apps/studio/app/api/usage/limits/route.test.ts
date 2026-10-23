import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn(() => true),
  read: vi.fn(async () => [{ id: 'codex', backend: 'codex', status: 'ok', windows: [], source: 'codex-app-server', recommended: true }]),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/repo-token', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/usage-limits', () => ({ DEFAULT_LIMIT_ACCOUNTS: [{ id: 'codex', backend: 'codex' }], usageLimits: () => ({ read: mocks.read }) }));

import { GET } from './route';

beforeEach(() => {
  mocks.requireUser.mockClear().mockImplementation(() => 'kim');
  mocks.localFolderAllowed.mockClear().mockReturnValue(true);
  mocks.read.mockClear();
});

describe('GET /api/usage/limits', () => {
  it('기본 계정들의 한도를 돌려준다', async () => {
    const response = await GET(new Request('http://localhost/api/usage/limits'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accounts: [{ id: 'codex', backend: 'codex', status: 'ok', windows: [], source: 'codex-app-server', recommended: true }] });
    expect(mocks.read).toHaveBeenCalledWith([{ id: 'codex', backend: 'codex' }], { refresh: false });
  });

  it('refresh=1이면 다시 읽기를 청한다', async () => {
    await GET(new Request('http://localhost/api/usage/limits?refresh=1'));

    expect(mocks.read).toHaveBeenCalledWith([{ id: 'codex', backend: 'codex' }], { refresh: true });
  });

  it('개인 PC 모드가 아니면 403이고 자격을 읽지 않는다', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);

    const response = await GET(new Request('http://localhost/api/usage/limits'));

    expect(response.status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('로그인하지 않았으면 401이다', async () => {
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });

    const response = await GET(new Request('http://localhost/api/usage/limits'));

    expect(response.status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
