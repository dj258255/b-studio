import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelSessionTests: vi.fn<(id: string, service: string) => void>(),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ cancelSessionTests: mocks.cancelSessionTests }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/tests/cancel`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.cancelSessionTests.mockClear();
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/tests/cancel', () => {
  it('service의 실행을 취소한다', async () => {
    const response = await post({ service: 'api' });

    expect(response.status).toBe(200);
    expect(mocks.cancelSessionTests).toHaveBeenCalledWith('s1', 'api');
  });

  it('실행 중이 아니면 404', async () => {
    mocks.cancelSessionTests.mockImplementationOnce(() => {
      throw new StudioError(404, '실행 중인 테스트가 없습니다');
    });

    const response = await post({ service: 'api' });

    expect(response.status).toBe(404);
  });

  it('service가 없으면 400', async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect(mocks.cancelSessionTests).not.toHaveBeenCalled();
  });
});
