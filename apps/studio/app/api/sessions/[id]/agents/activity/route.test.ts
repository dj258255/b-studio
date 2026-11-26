import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  authorizeSession: vi.fn<(id: string, user: string) => Promise<void>>(async () => {}),
  recoverSessions: vi.fn(async () => {}),
  sessionTerminalActivityLog: vi.fn<(id: string, agent?: string) => { agents: unknown[] }>(() => ({ agents: [] })),
  localToken: 'f'.repeat(64),
}));

vi.mock('@/lib/server/access', () => ({
  requireUser: () => {
    mocks.calls.push('requireUser');
    return 'kim';
  },
  authorizeSession: async (id: string, user: string) => {
    mocks.calls.push('authorizeSession');
    return mocks.authorizeSession(id, user);
  },
}));
vi.mock('@/lib/server/sessions', () => ({
  recoverSessions: async () => {
    mocks.calls.push('recoverSessions');
    return mocks.recoverSessions();
  },
  sessionTerminalActivityLog: (id: string, agent?: string) => {
    mocks.calls.push('sessionTerminalActivityLog');
    return mocks.sessionTerminalActivityLog(id, agent);
  },
}));
vi.mock('@/lib/server/local-token', () => ({
  LOCAL_TOKEN_COOKIE: 'b_studio_local',
  hasLocalToken: (cookie: string | undefined) => cookie === mocks.localToken,
  localToken: () => mocks.localToken,
  localTokenPath: () => '/tmp/b-studio-local-token',
}));

import { GET } from './route';

const COOKIE = `b_studio_local=${mocks.localToken}`;
const context = { params: Promise.resolve({ id: 's1' }) };
const get = (query = '', host = '127.0.0.1:3000', cookie: string | null = COOKIE): Promise<Response> =>
  GET(new Request(`http://localhost/api/sessions/s1/agents/activity${query}`, { headers: { host, ...(cookie ? { cookie } : {}) } }), context);

beforeEach(() => {
  mocks.calls.length = 0;
  for (const mock of [mocks.authorizeSession, mocks.recoverSessions, mocks.sessionTerminalActivityLog]) mock.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
  mocks.sessionTerminalActivityLog.mockImplementation(() => ({ agents: [{ id: 'main', main: true, entries: [] }] }));
});

describe('GET /api/sessions/[id]/agents/activity (이슈 #1411)', () => {
  it('터미널 출력 통로와 같은 검사를 같은 순서로 거친 뒤 기록을 준다: 사용자 → 세션 복구 → 보기 권한 → 기록', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ agents: [{ id: 'main', main: true, entries: [] }] });
    expect(mocks.calls).toEqual(['requireUser', 'recoverSessions', 'authorizeSession', 'sessionTerminalActivityLog']);
    expect(mocks.authorizeSession).toHaveBeenCalledWith('s1', 'kim');
    expect(mocks.sessionTerminalActivityLog).toHaveBeenCalledWith('s1', undefined);
  });

  it('agent 인자는 그대로 넘기고, 올바르지 않은 값은 기록을 읽기 전에 400으로 거절한다', async () => {
    expect((await get('?agent=a1')).status).toBe(200);
    expect(mocks.sessionTerminalActivityLog).toHaveBeenLastCalledWith('s1', 'a1');
    mocks.sessionTerminalActivityLog.mockClear();
    for (const query of ['?agent=', `?agent=${'x'.repeat(81)}`, '?agent=a%00b', '?agent=a%0Ab']) expect((await get(query)).status, query).toBe(400);
    expect(mocks.sessionTerminalActivityLog).not.toHaveBeenCalled();
  });

  it('이 컴퓨터의 주소가 아닌 Host로 온 요청은 받지 않는다(권한 검사에도 닿지 않는다)', async () => {
    for (const host of ['evil.example:3000', '127.0.0.1.evil.example:3000', '192.168.0.10:3000', '']) expect((await get('', host)).status, host).toBe(403);
    expect(mocks.authorizeSession).not.toHaveBeenCalled();
    expect(mocks.sessionTerminalActivityLog).not.toHaveBeenCalled();
    for (const host of ['localhost:3000', '[::1]:3000']) expect((await get('', host)).status, host).toBe(200);
  });

  it('로컬 토큰 쿠키가 없으면 개인 PC 모드에서 거절한다', async () => {
    const response = await get('', '127.0.0.1:3000', null);
    expect(response.status).toBe(403);
    expect(mocks.sessionTerminalActivityLog).not.toHaveBeenCalled();
  });

  it('보기 권한(만든 사람·관리자)이 없으면 기록을 읽지 않고 거절한다', async () => {
    mocks.authorizeSession.mockRejectedValue(new StudioError(403, '이 세션은 lee님이 만들었습니다'));
    const response = await get();
    expect(response.status).toBe(403);
    expect(mocks.sessionTerminalActivityLog).not.toHaveBeenCalled();
  });

  it('쓸 수 없는 서버나 없는 세션의 오류는 그대로 알린다', async () => {
    mocks.sessionTerminalActivityLog.mockImplementation(() => {
      throw new StudioError(404, '세션을 찾을 수 없습니다');
    });
    expect((await get()).status).toBe(404);
  });
});
