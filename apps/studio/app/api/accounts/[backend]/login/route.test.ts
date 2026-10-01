import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn(() => true),
  startLogin: vi.fn(() => ({ backend: 'codex', state: 'running', lines: [], startedAt: 0 })),
  getLoginProgress: vi.fn(),
  cancelLogin: vi.fn(),
  checkAccountStatus: vi.fn(async (backend: string) => ({ backend, label: '로컬 Codex Agent', connected: true, installed: true })),
  attachStatus: vi.fn((progress: { status?: unknown }, status: unknown) => {
    progress.status = status;
  }),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/sessions', () => ({ localFolderAllowed: mocks.localFolderAllowed }));
vi.mock('@/lib/server/cli-accounts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/cli-accounts')>('@/lib/server/cli-accounts');
  return {
    ...actual,
    startLogin: mocks.startLogin,
    getLoginProgress: mocks.getLoginProgress,
    cancelLogin: mocks.cancelLogin,
    checkAccountStatus: mocks.checkAccountStatus,
    attachStatus: mocks.attachStatus,
  };
});

import { DELETE, GET, POST } from './route';

function call(method: 'GET' | 'POST' | 'DELETE', backend: string) {
  const fn = { GET, POST, DELETE }[method];
  return fn(new Request(`http://localhost/api/accounts/${backend}/login`, { method }), { params: Promise.resolve({ backend }) });
}

beforeEach(() => {
  mocks.requireUser.mockClear().mockImplementation(() => 'kim');
  mocks.localFolderAllowed.mockClear().mockReturnValue(true);
  mocks.startLogin.mockClear().mockReturnValue({ backend: 'codex', state: 'running', lines: [], startedAt: 0 });
  mocks.getLoginProgress.mockClear();
  mocks.cancelLogin.mockClear();
  mocks.checkAccountStatus.mockClear();
  mocks.attachStatus.mockClear();
});

describe('POST /api/accounts/[backend]/login', () => {
  it('spawn 가능한 백엔드는 로그인을 시작하고 진행 상황을 돌려준다', async () => {
    const response = await call('POST', 'codex');

    expect(response.status).toBe(200);
    expect(mocks.startLogin).toHaveBeenCalledWith('codex');
    const body = (await response.json()) as { spawnable: boolean; progress: { state: string } };
    expect(body.spawnable).toBe(true);
    expect(body.progress.state).toBe('running');
  });

  it('대화형 CLI(opencode)는 프로세스를 띄우지 않고 명령만 돌려준다', async () => {
    const response = await call('POST', 'opencode');

    expect(response.status).toBe(200);
    expect(mocks.startLogin).not.toHaveBeenCalled();
    const body = (await response.json()) as { spawnable: boolean; command: string; note?: string };
    expect(body.spawnable).toBe(false);
    expect(body.command).toBe('opencode auth login');
    expect(body.note).toBeTruthy();
  });

  it('허용 목록에 없는 백엔드는 400', async () => {
    const response = await call('POST', 'rm-rf');
    expect(response.status).toBe(400);
    expect(mocks.startLogin).not.toHaveBeenCalled();
  });

  it('개인 PC 모드가 아니면 403이고 아무것도 시작하지 않는다', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);
    const response = await call('POST', 'codex');
    expect(response.status).toBe(403);
    expect(mocks.startLogin).not.toHaveBeenCalled();
  });

  it('로그인하지 않았으면 401', async () => {
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await call('POST', 'codex');
    expect(response.status).toBe(401);
  });
});

describe('GET /api/accounts/[backend]/login', () => {
  it('진행 중이면 상태를 다시 확인하지 않는다', async () => {
    mocks.getLoginProgress.mockReturnValue({ backend: 'codex', state: 'running', lines: ['로그인 대기 중'], startedAt: 0 });

    const response = await call('GET', 'codex');

    expect(response.status).toBe(200);
    expect(mocks.checkAccountStatus).not.toHaveBeenCalled();
    expect((await response.json()).progress.lines).toEqual(['로그인 대기 중']);
  });

  it('끝났고 아직 재확인하지 않았으면 한 번만 상태를 다시 확인해 채운다', async () => {
    mocks.getLoginProgress.mockReturnValue({ backend: 'codex', state: 'exited', lines: [], startedAt: 0, exitCode: 0 });

    const response = await call('GET', 'codex');

    expect(mocks.checkAccountStatus).toHaveBeenCalledTimes(1);
    expect(mocks.attachStatus).toHaveBeenCalledTimes(1);
    expect((await response.json()).progress.status.connected).toBe(true);
  });

  it('끝났고 이미 재확인했으면 다시 부르지 않는다', async () => {
    mocks.getLoginProgress.mockReturnValue({
      backend: 'codex',
      state: 'exited',
      lines: [],
      startedAt: 0,
      exitCode: 0,
      status: { backend: 'codex', label: '로컬 Codex Agent', connected: true, installed: true },
    });

    await call('GET', 'codex');

    expect(mocks.checkAccountStatus).not.toHaveBeenCalled();
  });

  it('시작한 적 없으면 404', async () => {
    mocks.getLoginProgress.mockReturnValue(undefined);
    const response = await call('GET', 'codex');
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/accounts/[backend]/login', () => {
  it('진행 중인 로그인을 취소한다', async () => {
    mocks.cancelLogin.mockReturnValue({ backend: 'codex', state: 'cancelled', lines: [], startedAt: 0 });

    const response = await call('DELETE', 'codex');

    expect(response.status).toBe(200);
    expect(mocks.cancelLogin).toHaveBeenCalledWith('codex');
    expect((await response.json()).progress.state).toBe('cancelled');
  });

  it('취소할 로그인이 없으면 404', async () => {
    mocks.cancelLogin.mockReturnValue(undefined);
    const response = await call('DELETE', 'codex');
    expect(response.status).toBe(404);
  });
});
