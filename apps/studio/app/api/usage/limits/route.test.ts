import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn(() => true),
  listAiAccounts: vi.fn(async (): Promise<unknown[]> => [
    { id: 'codex', name: '기본', backend: 'codex', builtin: true },
    { id: 'acct-1', name: '피오', backend: 'claude-code', configDir: '/home/kim/.claude-fio', sprite: 'fio.gif' },
  ]),
  read: vi.fn(async (accounts: Array<{ id: string; backend: string }>) =>
    accounts.map((account) => ({ id: account.id, backend: account.backend, status: 'ok', windows: [], source: 'codex-app-server', ...(account.id === 'codex' ? { recommended: true } : {}) })),
  ),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/repo-token', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/ai-accounts', () => ({ listAiAccounts: mocks.listAiAccounts }));
vi.mock('@/lib/server/usage-limits', async (original) => ({
  ...(await original<typeof import('@/lib/server/usage-limits')>()),
  usageLimits: () => ({ read: mocks.read }),
}));

import { GET } from './route';

beforeEach(() => {
  mocks.requireUser.mockClear().mockImplementation(() => 'kim');
  mocks.localFolderAllowed.mockClear().mockReturnValue(true);
  mocks.read.mockClear();
  mocks.listAiAccounts.mockClear();
});

describe('GET /api/usage/limits', () => {
  it('계정 목록의 계정마다 한도를 읽고, 이름과 그림을 붙여 돌려준다', async () => {
    const response = await GET(new Request('http://localhost/api/usage/limits'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: [
        { id: 'codex', backend: 'codex', name: '기본', builtin: true, status: 'ok', windows: [], source: 'codex-app-server', recommended: true },
        { id: 'acct-1', backend: 'claude-code', name: '피오', sprite: 'fio.gif', status: 'ok', windows: [], source: 'codex-app-server' },
      ],
    });
    expect(mocks.listAiAccounts).toHaveBeenCalledWith(process.env, ['claude-code', 'codex', 'gemini']);
    expect(mocks.read).toHaveBeenCalledWith(
      [
        { id: 'codex', backend: 'codex' },
        { id: 'acct-1', backend: 'claude-code', configDir: '/home/kim/.claude-fio' },
      ],
      { refresh: false },
    );
  });

  it('refresh=1이면 다시 읽기를 청한다', async () => {
    await GET(new Request('http://localhost/api/usage/limits?refresh=1'));

    expect(mocks.read).toHaveBeenCalledWith(expect.any(Array), { refresh: true });
  });

  it('계정 목록 파일이 깨졌으면 기본 계정들로 읽고 그 까닭을 함께 알린다', async () => {
    mocks.listAiAccounts.mockRejectedValueOnce(new StudioError(500, '계정 목록 파일을 읽지 못했습니다'));

    const response = await GET(new Request('http://localhost/api/usage/limits'));
    const body = (await response.json()) as { accounts: Array<{ id: string; name?: string }>; warning?: string };

    expect(response.status).toBe(200);
    expect(body.accounts.map((account) => account.id)).toEqual(['claude-code', 'codex', 'gemini']);
    expect(body.accounts[0]!.name).toBe('기본');
    expect(body.warning).toContain('계정 목록 파일을 읽지 못했습니다');
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
