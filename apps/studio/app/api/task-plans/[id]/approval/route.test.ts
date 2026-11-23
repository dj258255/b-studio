import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn(), get: vi.fn(), localToken: 'f'.repeat(64) }));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({ approveTaskPlan: spies.approve, rejectTaskPlan: spies.reject, getTaskPlan: spies.get }));
vi.mock('@/lib/server/sessions', () => ({ recoverSessions: async () => {} }));
vi.mock('@/lib/server/local-token', () => ({
  LOCAL_TOKEN_COOKIE: 'b_studio_local',
  hasLocalToken: (cookie: string | undefined) => cookie === spies.localToken,
  localToken: () => spies.localToken,
  localTokenPath: () => '/tmp/b-studio-local-token',
}));

import { POST } from './route';

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://studio.local/api/task-plans/plan-1/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: 'plan-1' }) } as Parameters<typeof POST>[1];

describe('작업 계획 승인 라우트', () => {
  beforeEach(() => {
    spies.approve.mockReset();
    spies.reject.mockReset();
    spies.get.mockReset();
    spies.get.mockReturnValue({ id: 'plan-1' });
    spies.approve.mockReturnValue({ id: 'plan-1' });
    spies.reject.mockReturnValue({ id: 'plan-1' });
  });

  it('승인할 때 publishIssues만 넘기고 다른 필드는 무시한다', async () => {
    const response = await POST(request({ approve: true, publishIssues: true, writableScope: ['web'], tasks: [1] }), context);

    expect(response.status).toBe(200);
    expect(spies.approve).toHaveBeenCalledWith('plan-1', 'kim', { publishIssues: true });
    // 쓰기 범위·작업 목록 같은 필드는 승인 입력으로 넘기지 않는다
    expect(spies.approve.mock.calls[0]![2]).toEqual({ publishIssues: true });
  });

  it('publishIssues가 없거나 true가 아니면 꺼진 것으로 넘긴다', async () => {
    await POST(request({ approve: true }), context);
    expect(spies.approve).toHaveBeenCalledWith('plan-1', 'kim', { publishIssues: false });

    await POST(request({ approve: true, publishIssues: 'yes' }), context);
    expect(spies.approve).toHaveBeenLastCalledWith('plan-1', 'kim', { publishIssues: false });
  });

  it('approve가 boolean이 아니면 400이고, 거부면 사유와 함께 rejectTaskPlan을 부른다', async () => {
    const bad = await POST(request({ approve: 'yes' }), context);
    expect(bad.status).toBe(400);
    expect(spies.approve).not.toHaveBeenCalled();

    const rejected = await POST(request({ approve: false, reason: '범위가 이상함' }), context);
    expect(rejected.status).toBe(200);
    expect(spies.reject).toHaveBeenCalledWith('plan-1', 'kim', '범위가 이상함');
  });

  it('터미널 방식 계획의 승인은 이 컴퓨터 주소·로컬 토큰이 없으면 403이고 승인하지 않는다(승인이 레인 터미널을 연다)', async () => {
    spies.get.mockReturnValue({ id: 'plan-1', runner: 'terminal' });
    const refused: Record<string, string>[] = [{}, { host: '127.0.0.1:3000' }, { host: '127.0.0.1:3000', cookie: 'b_studio_local=wrong' }, { host: 'evil.example:3000', cookie: `b_studio_local=${'f'.repeat(64)}` }];
    for (const headers of refused) {
      const response = await POST(request({ approve: true }, headers), context);
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    expect(spies.approve).not.toHaveBeenCalled();

    const allowed = await POST(request({ approve: true }, { host: '127.0.0.1:3000', cookie: `b_studio_local=${'f'.repeat(64)}` }), context);
    expect(allowed.status).toBe(200);
    expect(spies.approve).toHaveBeenCalledTimes(1);
  });

  it('채팅 방식 계획의 승인과 터미널 방식 계획의 거부는 로그인만 본다', async () => {
    expect((await POST(request({ approve: true }), context)).status).toBe(200);
    spies.get.mockReturnValue({ id: 'plan-1', runner: 'terminal' });
    expect((await POST(request({ approve: false }), context)).status).toBe(200);
    expect(spies.reject).toHaveBeenCalledTimes(1);
  });
});
