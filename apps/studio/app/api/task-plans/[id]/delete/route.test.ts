import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteTaskPlan: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({ deleteTaskPlan: mocks.deleteTaskPlan }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(id = 'plan-1'): Promise<Response> {
  return POST(new Request('http://localhost/api/task-plans/plan-1/delete', { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.deleteTaskPlan.mockClear();
  mocks.deleteTaskPlan.mockImplementation(async () => {});
});

describe('POST /api/task-plans/[id]/delete', () => {
  it('로그인한 사람 이름으로 계획을 지우고 ok를 돌려준다', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(mocks.deleteTaskPlan).toHaveBeenCalledWith('plan-1', 'kim');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('실행·통합 중이면 409를 그대로 전한다', async () => {
    mocks.deleteTaskPlan.mockRejectedValueOnce(new StudioError(409, '진행 중인 작업 계획은 지울 수 없습니다'));

    const response = await post();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('진행 중인 작업 계획');
  });
});
