import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFleet: vi.fn(async (input: Record<string, unknown>) => ({ id: 'fleet-1', ...input })),
  listFleets: vi.fn(() => []),
  localToken: 'f'.repeat(64),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/fleets', () => ({ createFleet: mocks.createFleet, listFleets: mocks.listFleets }));
vi.mock('@/lib/server/sessions', () => ({ recoverSessions: async () => {} }));
vi.mock('@/lib/server/local-token', () => ({
  LOCAL_TOKEN_COOKIE: 'b_studio_local',
  hasLocalToken: (cookie: string | undefined) => cookie === mocks.localToken,
  localToken: () => mocks.localToken,
  localTokenPath: () => '/tmp/b-studio-local-token',
}));

import { POST } from './route';

function post(body: unknown, headers: Record<string, string> = LOCAL): Promise<Response> {
  return POST(new Request('http://localhost/api/fleets', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
}

/** 세션 터미널 통로와 같은 조건(이 컴퓨터 주소 + 로컬 토큰)을 갖춘 요청 머리 */
const LOCAL = { host: '127.0.0.1:3000', cookie: `b_studio_local=${'f'.repeat(64)}` };

beforeEach(() => {
  mocks.createFleet.mockClear();
});

describe('POST /api/fleets', () => {
  it('기존 입력(모델 id 목록)을 그대로 넘긴다', async () => {
    const response = await post({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], allowBreaking: true });

    expect(response.status).toBe(201);
    expect(mocks.createFleet).toHaveBeenCalledWith({ projectId: 'orders', request: '요청', modelIds: ['model-a', 'model-b'], owner: 'kim', allowBreaking: true });
  });

  it('backend+model 후보를 그대로 넘긴다', async () => {
    const response = await post({
      projectId: 'orders',
      request: '요청',
      candidates: [
        { backend: 'claude-code', model: 'sonnet' },
        { backend: 'api' },
      ],
    });

    expect(response.status).toBe(201);
    expect(mocks.createFleet).toHaveBeenCalledWith({
      projectId: 'orders',
      request: '요청',
      candidates: [
        { backend: 'claude-code', model: 'sonnet' },
        { backend: 'api' },
      ],
      owner: 'kim',
      allowBreaking: false,
    });
  });

  it('후보의 계정(accountId)도 그대로 넘긴다', async () => {
    const response = await post({ projectId: 'orders', request: '요청', candidates: [{ backend: 'codex', accountId: 'acct-pio' }, { backend: 'codex' }] });

    expect(response.status).toBe(201);
    expect(mocks.createFleet).toHaveBeenCalledWith({
      projectId: 'orders',
      request: '요청',
      candidates: [{ backend: 'codex', accountId: 'acct-pio' }, { backend: 'codex' }],
      owner: 'kim',
      allowBreaking: false,
    });
  });

  it('후보를 주지 않으면 서버가 기본 후보를 만들도록 비워 둔다', async () => {
    const response = await post({ projectId: 'orders', request: '요청' });

    expect(response.status).toBe(201);
    expect(mocks.createFleet).toHaveBeenCalledWith({ projectId: 'orders', request: '요청', owner: 'kim', allowBreaking: false });
  });

  it('후보 모양이 틀리면 400을 돌려주고 Fleet을 만들지 않는다', async () => {
    const wrong = [[{ model: 'model-a' }], [{ backend: 3 }], 'nope', [{ backend: 'api', model: 5 }], [{ backend: 'codex', accountId: 7 }]];

    for (const candidates of wrong) {
      const response = await post({ projectId: 'orders', request: '요청', candidates });
      expect(response.status, JSON.stringify(candidates)).toBe(400);
    }
    expect(mocks.createFleet).not.toHaveBeenCalled();
  });

  it('runner는 문자열이면 그대로 넘기고(chat·모르는 값은 createFleet이 세션 전에 거절한다), 문자열이 아니면 400으로 거절한다', async () => {
    const response = await post({ projectId: 'orders', request: '요청', runner: 'terminal' }, LOCAL);
    expect(response.status).toBe(201);
    expect(mocks.createFleet).toHaveBeenCalledWith({ projectId: 'orders', request: '요청', owner: 'kim', allowBreaking: false, runner: 'terminal' });

    mocks.createFleet.mockClear();
    for (const runner of [3, null, ['terminal']]) {
      const wrong = await post({ projectId: 'orders', request: '요청', runner });
      expect(wrong.status, JSON.stringify(runner)).toBe(400);
    }
    expect(mocks.createFleet).not.toHaveBeenCalled();
  });

  it('터미널 방식은 세션 터미널 통로와 같은 조건(이 컴퓨터 주소·로컬 토큰)을 갖춘 요청만 받는다(세션 터미널을 열고 그 안의 CLI를 몰기 때문에)', async () => {
    const refused: Record<string, string>[] = [{}, { host: '127.0.0.1:3000' }, { host: '127.0.0.1:3000', cookie: 'b_studio_local=wrong' }, { host: 'evil.example:3000', cookie: LOCAL.cookie }];
    for (const headers of refused) {
      const response = await post({ projectId: 'orders', request: '요청', runner: 'terminal', allowBreaking: true }, headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    expect(mocks.createFleet).not.toHaveBeenCalled();
    // runner를 빼도 같다: 이제 Fleet은 늘 세션 터미널에서 돌므로 로그인만으로는 열지 못한다
    expect((await post({ projectId: 'orders', request: '요청' }, {})).status).toBe(403);
    // chat은 접근 검사를 거친 뒤 createFleet이 400으로 거절한다(여기서는 createFleet을 가짜로 바꿨으므로 넘어간다)
    expect((await post({ projectId: 'orders', request: '요청', runner: 'chat' })).status).toBe(201);
  });
});
