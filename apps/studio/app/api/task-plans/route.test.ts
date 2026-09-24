import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTaskPlan: vi.fn(async (input: Record<string, unknown>) => ({ id: 'plan-1', ...input })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({
  createTaskPlan: mocks.createTaskPlan,
  listTaskPlans: () => [],
}));

import { POST } from './route';

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/task-plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  mocks.createTaskPlan.mockClear();
});

describe('POST /api/task-plans', () => {
  it('본문에 presetPlan이 있어도 createTaskPlan에 넘기지 않는다', async () => {
    const response = await post({
      projectId: 'orders',
      request: '요청',
      modelId: 'model-a',
      presetPlan: { tasks: [{ id: 'a', paths: ['web/a'] }] },
    });

    expect(response.status).toBe(201);
    expect(mocks.createTaskPlan).toHaveBeenCalledTimes(1);
    const input = mocks.createTaskPlan.mock.calls[0]![0];
    // presetPlan은 서버 안에서만 넘긴다. HTTP 라우트는 이 필드를 넘기지 않는다
    expect(input).toEqual({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim' });
    expect(Object.keys(input)).not.toContain('presetPlan');
  });

  it('필수 필드가 없으면 400을 돌려주고 계획을 만들지 않는다', async () => {
    const response = await post({ request: '요청' });

    expect(response.status).toBe(400);
    expect(mocks.createTaskPlan).not.toHaveBeenCalled();
  });
});
