import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFleet: vi.fn(async (input: Record<string, unknown>) => ({ id: 'fleet-1', ...input })),
  listFleets: vi.fn(() => []),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/fleets', () => ({ createFleet: mocks.createFleet, listFleets: mocks.listFleets }));

import { POST } from './route';

function post(body: unknown): Promise<Response> {
  return POST(new Request('http://localhost/api/fleets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

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

  it('후보를 주지 않으면 서버가 기본 후보를 만들도록 비워 둔다', async () => {
    const response = await post({ projectId: 'orders', request: '요청' });

    expect(response.status).toBe(201);
    expect(mocks.createFleet).toHaveBeenCalledWith({ projectId: 'orders', request: '요청', owner: 'kim', allowBreaking: false });
  });

  it('후보 모양이 틀리면 400을 돌려주고 Fleet을 만들지 않는다', async () => {
    const wrong = [[{ model: 'model-a' }], [{ backend: 3 }], 'nope', [{ backend: 'api', model: 5 }]];

    for (const candidates of wrong) {
      const response = await post({ projectId: 'orders', request: '요청', candidates });
      expect(response.status, JSON.stringify(candidates)).toBe(400);
    }
    expect(mocks.createFleet).not.toHaveBeenCalled();
  });
});
