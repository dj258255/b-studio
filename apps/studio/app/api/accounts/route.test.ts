import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn(() => true),
  listAccountStatuses: vi.fn(async () => [{ backend: 'claude-code', label: '로컬 Claude Agent', connected: true, installed: true }]),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/sessions', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/cli-accounts', () => ({ listAccountStatuses: mocks.listAccountStatuses }));

import { GET } from './route';

beforeEach(() => {
  mocks.requireUser.mockClear().mockImplementation(() => 'kim');
  mocks.localFolderAllowed.mockClear().mockReturnValue(true);
  mocks.listAccountStatuses.mockClear();
});

describe('GET /api/accounts', () => {
  it('개인 PC 모드면 네 백엔드 상태를 돌려준다', async () => {
    const response = await GET(new Request('http://localhost/api/accounts'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accounts: [{ backend: 'claude-code', label: '로컬 Claude Agent', connected: true, installed: true }] });
  });

  it('개인 PC 모드가 아니면 403을 돌려주고 상태를 확인하지 않는다', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);

    const response = await GET(new Request('http://localhost/api/accounts'));

    expect(response.status).toBe(403);
    expect(mocks.listAccountStatuses).not.toHaveBeenCalled();
  });

  it('로그인하지 않았으면 401을 돌려준다', async () => {
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });

    const response = await GET(new Request('http://localhost/api/accounts'));

    expect(response.status).toBe(401);
    expect(mocks.listAccountStatuses).not.toHaveBeenCalled();
  });
});
