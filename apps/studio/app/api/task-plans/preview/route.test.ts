import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  previewTaskCards: vi.fn(async () => ({ lanes: [{ id: 'lane-1', cards: [{ id: 'card-1', title: '카드1' }], paths: ['web/a'] }] })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({ previewTaskCards: mocks.previewTaskCards }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/task-plans/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  mocks.previewTaskCards.mockClear();
});

describe('POST /api/task-plans/preview', () => {
  it('projectId와 cards를 previewTaskCards로 넘기고 돌려준 레인을 그대로 응답한다', async () => {
    const cards = [{ title: '카드1', request: '작업', paths: ['web/a'] }];

    const response = await post({ projectId: 'orders', cards });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lanes: [{ id: 'lane-1', cards: [{ id: 'card-1', title: '카드1' }], paths: ['web/a'] }] });
    expect(mocks.previewTaskCards).toHaveBeenCalledWith('orders', cards);
  });

  it('projectId가 없으면 400을 돌려주고 미리보기를 만들지 않는다', async () => {
    const response = await post({ cards: [] });

    expect(response.status).toBe(400);
    expect(mocks.previewTaskCards).not.toHaveBeenCalled();
  });

  it('서버가 낸 오류의 상태와 문구를 그대로 돌려준다(터미널을 못 쓰면 409)', async () => {
    mocks.previewTaskCards.mockRejectedValueOnce(new StudioError(409, '작업 카드는 세션 터미널을 쓸 수 있을 때(B_STUDIO_EXPERIMENTAL=1, 개인 PC 모드) 씁니다'));

    const response = await post({ projectId: 'orders', cards: [] });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: '작업 카드는 세션 터미널을 쓸 수 있을 때(B_STUDIO_EXPERIMENTAL=1, 개인 PC 모드) 씁니다' });
  });
});
