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

  it('sourceSessionId(ADR-0XX, 세션의 "나눠서 병렬로 하기")를 받으면 그대로 createTaskPlan에 넘긴다', async () => {
    const response = await post({ projectId: 'orders', request: '요청', modelId: 'model-a', sourceSessionId: 'origin-1' });

    expect(response.status).toBe(201);
    expect(mocks.createTaskPlan).toHaveBeenCalledWith({ projectId: 'orders', request: '요청', modelId: 'model-a', owner: 'kim', sourceSessionId: 'origin-1' });
  });

  it('sourceSessionId가 문자열이 아니면 400으로 거부한다', async () => {
    const response = await post({ projectId: 'orders', request: '요청', modelId: 'model-a', sourceSessionId: 42 });

    expect(response.status).toBe(400);
    expect(mocks.createTaskPlan).not.toHaveBeenCalled();
  });
});
