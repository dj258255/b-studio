import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn(() => true),
  checkAccountStatus: vi.fn(async (backend: string) => ({ backend, label: '로컬 Codex Agent', connected: true, installed: true })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/sessions', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/cli-accounts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/cli-accounts')>('@/lib/server/cli-accounts');
  return { ...actual, checkAccountStatus: mocks.checkAccountStatus };
});

import { POST } from './route';

function post(backend: string) {
  return POST(new Request('http://localhost/api/accounts/x/refresh', { method: 'POST' }), { params: Promise.resolve({ backend }) });
}

beforeEach(() => {
  mocks.requireUser.mockClear().mockImplementation(() => 'kim');
  mocks.localFolderAllowed.mockClear().mockReturnValue(true);
  mocks.checkAccountStatus.mockClear();
});

describe('POST /api/accounts/[backend]/refresh', () => {
  it('허용된 백엔드면 다시 확인한 상태를 돌려준다', async () => {
    const response = await post('codex');

    expect(response.status).toBe(200);
    expect(mocks.checkAccountStatus).toHaveBeenCalledWith('codex');
    expect((await response.json()).status.connected).toBe(true);
  });

  it('허용 목록에 없는 백엔드면 400을 돌려주고 확인하지 않는다', async () => {
    const response = await post('shell-exec');

    expect(response.status).toBe(400);
    expect(mocks.checkAccountStatus).not.toHaveBeenCalled();
  });

  it('개인 PC 모드가 아니면 403을 돌려준다', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);

    const response = await post('codex');

    expect(response.status).toBe(403);
    expect(mocks.checkAccountStatus).not.toHaveBeenCalled();
  });

  it('로그인하지 않았으면 401을 돌려준다', async () => {
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });

    const response = await post('codex');

    expect(response.status).toBe(401);
  });
});
