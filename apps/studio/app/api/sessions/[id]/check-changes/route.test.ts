import { describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  authorizeSession: vi.fn(async () => {}),
  setTerminalCheckChanges: vi.fn((_id: string, allow: boolean) => allow),
  localToken: 'e'.repeat(64),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ recoverSessions: async () => {}, setTerminalCheckChanges: mocks.setTerminalCheckChanges }));
vi.mock('@/lib/server/local-token', () => ({
  LOCAL_TOKEN_COOKIE: 'b_studio_local',
  hasLocalToken: (cookie: string | undefined) => cookie === mocks.localToken,
  localToken: () => mocks.localToken,
  localTokenPath: () => '/tmp/b-studio-local-token',
}));

import { POST } from './route';

const context = { params: Promise.resolve({ id: 's1' }) };
const post = (body: unknown, cookie: string | null = `b_studio_local=${mocks.localToken}`, host = '127.0.0.1:3000'): Promise<Response> =>
  POST(new Request('http://localhost/api/sessions/s1/check-changes', { method: 'POST', headers: { host, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), context);

describe('POST /api/sessions/[id]/check-changes (#916, ADR-164)', () => {
  it('켜고 끄고, 지금 켜져 있는지 돌려준다', async () => {
    const on = await post({ allow: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ armed: true });
    expect(mocks.setTerminalCheckChanges).toHaveBeenLastCalledWith('s1', true);
    expect(await (await post({ allow: false })).json()).toEqual({ armed: false });
  });

  it('로컬 토큰이 없거나 이 컴퓨터 주소가 아니면 받지 않는다(같은 컴퓨터의 에이전트가 켜지 못하게)', async () => {
    mocks.setTerminalCheckChanges.mockClear();
    expect((await post({ allow: true }, null)).status).toBe(403);
    expect((await post({ allow: true }, 'b_studio_local=wrong')).status).toBe(403);
    expect((await post({ allow: true }, undefined, 'evil.example:3000')).status).toBe(403);
    expect(mocks.setTerminalCheckChanges).not.toHaveBeenCalled();
  });

  it('allow가 참거짓이 아니면 400, 세션 권한이 없으면 그 오류다', async () => {
    expect((await post({ allow: 'yes' })).status).toBe(400);
    mocks.authorizeSession.mockImplementationOnce(async () => {
      throw new StudioError(404, '세션을 찾을 수 없습니다');
    });
    expect((await post({ allow: true })).status).toBe(404);
  });
});
