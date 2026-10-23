/**
 * 여러 AI 계정 API(#885). 계정 목록은 진짜 모듈(ai-accounts.ts)에 임시 HOME을 주어 쓰고, CLI는 부르지 않는다
 * (상태 확인·로그인은 가짜로 바꾼다). 사용자의 ~/.claude·~/.codex는 건드리지 않는다.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  localFolderAllowed: vi.fn(() => true),
  allowedBackends: vi.fn(() => new Set(['claude-code', 'codex', 'api'])),
  checkAccountStatus: vi.fn(async (backend: string) => ({ backend, label: '로컬 Codex Agent', connected: true, installed: true })),
  startLogin: vi.fn((backend: string) => ({ backend, state: 'running', lines: [], startedAt: 0 })),
  getLoginProgress: vi.fn(),
  cancelLogin: vi.fn(),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/sessions', () => ({ localFolderAllowed: mocks.localFolderAllowed, allowedBackends: mocks.allowedBackends }));
vi.mock('@/lib/server/cli-accounts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/cli-accounts')>('@/lib/server/cli-accounts');
  return { ...actual, checkAccountStatus: mocks.checkAccountStatus, startLogin: mocks.startLogin, getLoginProgress: mocks.getLoginProgress, cancelLogin: mocks.cancelLogin };
});

import { GET, POST } from './route';
import { DELETE as DELETE_ONE, PATCH } from './[id]/route';
import { GET as STATUS } from './[id]/status/route';
import { DELETE as LOGIN_DELETE, GET as LOGIN_GET, POST as LOGIN_POST } from './[id]/login/route';

let home: string;
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'b-studio-ai-accounts-route-'));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.localFolderAllowed.mockReturnValue(true);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

const json = (method: string, body?: unknown) => new Request('http://localhost/api/ai-accounts', { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function add(body: unknown): Promise<{ id: string }> {
  const response = await POST(json('POST', body));
  expect(response.status).toBe(201);
  return ((await response.json()) as { account: { id: string } }).account;
}

describe('/api/ai-accounts', () => {
  it('허용한 CLI의 기본 계정과 더한 계정을 돌려준다(API·데모 같은 CLI 아닌 백엔드는 없다)', async () => {
    const added = await add({ name: '피오', backend: 'claude-code', configDir: '~/.claude-fio' });
    const body = (await (await GET(json('GET'))).json()) as { accounts: Array<{ id: string; name: string }> };
    expect(body.accounts.map((account) => account.id)).toEqual(['claude-code', added.id, 'codex']);
  });

  it('개인 PC 모드가 아니면 403이고, 로그인하지 않았으면 그 오류를 그대로 돌려준다', async () => {
    mocks.localFolderAllowed.mockReturnValue(false);
    expect((await GET(json('GET'))).status).toBe(403);
    expect((await POST(json('POST', { name: 'x', backend: 'codex', configDir: '~/.codex-x' }))).status).toBe(403);
    mocks.localFolderAllowed.mockReturnValue(true);
    const { StudioError } = await import('@/lib/server/errors');
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    expect((await GET(json('GET'))).status).toBe(401);
  });

  it('허용하지 않는 CLI의 계정은 더하지 않는다', async () => {
    mocks.allowedBackends.mockReturnValueOnce(new Set(['claude-code']));
    expect((await POST(json('POST', { name: 'x', backend: 'codex', configDir: '~/.codex-x' }))).status).toBe(400);
  });

  it('이름·그림을 고치고, 지우면 목록에서 빠진다', async () => {
    const added = await add({ name: '나디아', backend: 'claude-code', configDir: '~/.claude-nadia' });
    const patched = await PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ name: '나디아 2', sprite: 'nadia.png' }) }), params(added.id));
    expect(await patched.json()).toMatchObject({ account: { name: '나디아 2', sprite: 'nadia.png' } });
    expect((await DELETE_ONE(new Request('http://localhost', { method: 'DELETE' }), params(added.id))).status).toBe(200);
    expect((await DELETE_ONE(new Request('http://localhost', { method: 'DELETE' }), params(added.id))).status).toBe(404);
    expect((await DELETE_ONE(new Request('http://localhost', { method: 'DELETE' }), params('codex'))).status).toBe(400);
  });

  it('계정의 상태는 그 계정의 설정 폴더로 확인한다', async () => {
    const added = await add({ name: '마르코', backend: 'codex', configDir: '~/.codex-marco' });
    const response = await STATUS(new Request('http://localhost'), params(added.id));
    expect(response.status).toBe(200);
    expect(mocks.checkAccountStatus).toHaveBeenCalledWith('codex', {}, { env: expect.objectContaining({ CODEX_HOME: path.join(home, '.codex-marco') }) });
    // 기본 계정은 지금처럼 process.env 그대로다
    await STATUS(new Request('http://localhost'), params('codex'));
    expect(mocks.checkAccountStatus).toHaveBeenLastCalledWith('codex', {}, {});
    expect((await STATUS(new Request('http://localhost'), params('acct-00000000'))).status).toBe(404);
  });

  it('로그인은 계정마다 따로 시작하고 진행·취소한다', async () => {
    const added = await add({ name: '마르코', backend: 'codex', configDir: '~/.codex-marco' });
    const started = await LOGIN_POST(new Request('http://localhost', { method: 'POST' }), params(added.id));
    expect(started.status).toBe(200);
    expect(mocks.startLogin).toHaveBeenCalledWith('codex', { key: added.id, env: expect.objectContaining({ CODEX_HOME: path.join(home, '.codex-marco') }) });

    mocks.getLoginProgress.mockReturnValueOnce({ backend: 'codex', state: 'exited', lines: [], startedAt: 0 });
    const progress = await LOGIN_GET(new Request('http://localhost'), params(added.id));
    expect(mocks.getLoginProgress).toHaveBeenCalledWith(added.id);
    expect(await progress.json()).toMatchObject({ progress: { state: 'exited', status: { connected: true } } });

    mocks.cancelLogin.mockReturnValueOnce({ backend: 'codex', state: 'cancelled', lines: [], startedAt: 0 });
    expect((await LOGIN_DELETE(new Request('http://localhost', { method: 'DELETE' }), params(added.id))).status).toBe(200);
    expect(mocks.cancelLogin).toHaveBeenCalledWith(added.id);
  });
});
