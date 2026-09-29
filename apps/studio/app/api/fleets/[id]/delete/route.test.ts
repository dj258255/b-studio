import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteFleet: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/fleets', () => ({ deleteFleet: mocks.deleteFleet }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(id = 'fleet-1'): Promise<Response> {
  return POST(new Request('http://localhost/api/fleets/fleet-1/delete', { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.deleteFleet.mockClear();
  mocks.deleteFleet.mockImplementation(async () => {});
});

describe('POST /api/fleets/[id]/delete', () => {
  it('로그인한 사람 이름으로 Fleet을 지우고 ok를 돌려준다', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(mocks.deleteFleet).toHaveBeenCalledWith('fleet-1', 'kim');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('진행 중인 참가자가 있으면 409를 그대로 전한다', async () => {
    mocks.deleteFleet.mockRejectedValueOnce(new StudioError(409, '진행 중인 참가자가 있어 지울 수 없습니다'));

    const response = await post();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('진행 중인 참가자');
  });

  it('내가 만든 Fleet이 아니면 403을 그대로 전한다', async () => {
    mocks.deleteFleet.mockRejectedValueOnce(new StudioError(403, '이 Agent Fleet을 지울 수 없습니다'));

    const response = await post();

    expect(response.status).toBe(403);
  });
});
