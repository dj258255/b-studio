import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn() }));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({ approveTaskPlan: spies.approve, rejectTaskPlan: spies.reject }));

import { POST } from './route';

function request(body: unknown): Request {
  return new Request('http://studio.local/api/task-plans/plan-1/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: 'plan-1' }) } as Parameters<typeof POST>[1];

describe('작업 계획 승인 라우트', () => {
  beforeEach(() => {
    spies.approve.mockReset();
    spies.reject.mockReset();
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
});
