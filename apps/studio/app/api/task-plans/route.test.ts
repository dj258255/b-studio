import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTaskPlan: vi.fn(async (input: Record<string, unknown>) => ({ id: 'plan-1', ...input })),
  localToken: 'f'.repeat(64),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({
  createTaskPlan: mocks.createTaskPlan,
  listTaskPlans: () => [],
}));
vi.mock('@/lib/server/sessions', () => ({ recoverSessions: async () => {} }));
vi.mock('@/lib/server/local-token', () => ({
  LOCAL_TOKEN_COOKIE: 'b_studio_local',
  hasLocalToken: (cookie: string | undefined) => cookie === mocks.localToken,
  localToken: () => mocks.localToken,
  localTokenPath: () => '/tmp/b-studio-local-token',
}));

import { POST } from './route';

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request('http://localhost/api/task-plans', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
  );
}

/** 세션 터미널 통로와 같은 조건(이 컴퓨터 주소 + 로컬 토큰)을 갖춘 요청 머리 */
const LOCAL = { host: '127.0.0.1:3000', cookie: `b_studio_local=${'f'.repeat(64)}` };

beforeEach(() => {
  mocks.createTaskPlan.mockClear();
});

describe('POST /api/task-plans', () => {
  it('본문에 presetPlan·coordination·integrationChecks·verify가 있어도 createTaskPlan에 넘기지 않는다', async () => {
    const response = await post({
      projectId: 'orders',
      request: '요청',
      modelId: 'model-a',
      presetPlan: { tasks: [{ id: 'a', paths: ['web/a'] }] },
      coordination: { strategy: 'S3', topology: 'star' },
      integrationChecks: { pageChecks: [{ service: 'web', path: '/orders' }] },
      verify: 'light',
    });

    expect(response.status).toBe(201);
    expect(mocks.createTaskPlan).toHaveBeenCalledTimes(1);
    const input = mocks.createTaskPlan.mock.calls[0]![0];
    // presetPlan·coordination·integrationChecks·verify는 서버 안에서만 넘긴다. HTTP 라우트는 이 필드를 넘기지 않는다
    expect(input).toEqual({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim' });
    expect(Object.keys(input)).not.toContain('presetPlan');
    expect(Object.keys(input)).not.toContain('coordination');
    expect(Object.keys(input)).not.toContain('integrationChecks');
    expect(Object.keys(input)).not.toContain('verify');
  });

  it('필수 필드가 없으면 400을 돌려주고 계획을 만들지 않는다', async () => {
    const response = await post({ request: '요청' });

    expect(response.status).toBe(400);
    expect(mocks.createTaskPlan).not.toHaveBeenCalled();
  });

  it('sourceSessionId(ADR-096, 세션의 "나눠서 병렬로 하기")를 받으면 그대로 createTaskPlan에 넘긴다', async () => {
    const response = await post({ projectId: 'orders', request: '요청', modelId: 'model-a', sourceSessionId: 'origin-1' });

    expect(response.status).toBe(201);
    expect(mocks.createTaskPlan).toHaveBeenCalledWith({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim', sourceSessionId: 'origin-1' });
  });

  it('sourceSessionId가 문자열이 아니면 400으로 거부한다', async () => {
    const response = await post({ projectId: 'orders', request: '요청', modelId: 'model-a', sourceSessionId: 42 });

    expect(response.status).toBe(400);
    expect(mocks.createTaskPlan).not.toHaveBeenCalled();
  });

  it('카드(cards)를 넘기면 그대로 createTaskPlan에 넘긴다', async () => {
    const cards = [{ title: 'A', request: 'A 작업', paths: ['web/a'], doneCommand: 'pnpm test', doneService: 'web' }];

    const response = await post({ projectId: 'orders', request: '요청', owner: 'kim', cards }, LOCAL);

    expect(response.status).toBe(201);
    expect(mocks.createTaskPlan).toHaveBeenCalledWith({ projectId: 'orders', request: '요청', owner: 'kim', cards });
  });

  it('카드가 있으면 request 없이도 받아 그대로 createTaskPlan에 넘긴다 (수정 2-3)', async () => {
    const cards = [{ title: 'A', request: 'A 작업', paths: ['web/a'] }];

    const response = await post({ projectId: 'orders', owner: 'kim', cards }, LOCAL);

    expect(response.status).toBe(201);
    expect(mocks.createTaskPlan).toHaveBeenCalledWith({ projectId: 'orders', owner: 'kim', cards });
  });

  it('카드가 없으면 request는 여전히 필요하다 (수정 2-3)', async () => {
    const response = await post({ projectId: 'orders' });

    expect(response.status).toBe(400);
    expect(mocks.createTaskPlan).not.toHaveBeenCalled();
  });

  it('카드 계획은 레인을 세션 터미널에서 돌리므로 세션 터미널 통로와 같은 조건(이 컴퓨터 주소·로컬 토큰)을 갖춘 요청만 받는다', async () => {
    const cards = [{ title: 'A', request: 'A 작업', paths: ['web/a'] }];
    const refused: Record<string, string>[] = [{}, { host: '127.0.0.1:3000' }, { host: '127.0.0.1:3000', cookie: 'b_studio_local=wrong' }, { host: 'evil.example:3000', cookie: LOCAL.cookie }];
    for (const headers of refused) {
      const response = await post({ projectId: 'orders', cards }, headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    expect(mocks.createTaskPlan).not.toHaveBeenCalled();
  });

  it('runner(chat·terminal)를 그대로 넘기고, 다른 값은 400으로 거절한다', async () => {
    const response = await post({ projectId: 'orders', request: '요청', runner: 'terminal' }, LOCAL);
    expect(response.status).toBe(201);
    expect(mocks.createTaskPlan).toHaveBeenCalledWith({ projectId: 'orders', request: '요청', owner: 'kim', runner: 'terminal' });

    mocks.createTaskPlan.mockClear();
    for (const runner of ['pty', 3, null]) {
      const wrong = await post({ projectId: 'orders', request: '요청', runner }, LOCAL);
      expect(wrong.status, JSON.stringify(runner)).toBe(400);
    }
    expect(mocks.createTaskPlan).not.toHaveBeenCalled();
  });

  it('터미널 방식 계획은 세션 터미널 통로와 같은 조건(이 컴퓨터 주소·로컬 토큰)을 갖춘 요청만 받는다', async () => {
    const refused: Record<string, string>[] = [{}, { host: '127.0.0.1:3000' }, { host: '127.0.0.1:3000', cookie: 'b_studio_local=wrong' }, { host: 'evil.example:3000', cookie: LOCAL.cookie }];
    for (const headers of refused) {
      const response = await post({ projectId: 'orders', request: '요청', runner: 'terminal' }, headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    expect(mocks.createTaskPlan).not.toHaveBeenCalled();
    // 채팅 방식은 지금처럼 로그인만 본다
    expect((await post({ projectId: 'orders', request: '요청', runner: 'chat' })).status).toBe(201);
  });
});
