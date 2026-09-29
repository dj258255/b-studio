import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  steerRun: vi.fn(() => ({ runId: 'r1' })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ steerRun: mocks.steerRun }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions/s1/steer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  mocks.steerRun.mockClear();
  mocks.steerRun.mockImplementation(() => ({ runId: 'r1' }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/steer', () => {
  it('본문의 text를 실행에 넣고 runId를 돌려준다', async () => {
    const response = await post({ text: '테스트도 추가해줘' });

    expect(response.status).toBe(202);
    expect(mocks.steerRun).toHaveBeenCalledWith('s1', '테스트도 추가해줘');
    expect(await response.json()).toEqual({ runId: 'r1' });
  });

  it('text가 없거나 비었거나 2,000자를 넘으면 400을 돌려주고 실행에 넣지 않는다', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ text: '' })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(2_001) })).status).toBe(400);
    expect(mocks.steerRun).not.toHaveBeenCalled();
  });

  it('권한이 없으면 403을 돌려주고 실행에 넣지 않는다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만 바꿀 수 있습니다'));

    const response = await post({ text: '지시' });

    expect(response.status).toBe(403);
    expect(mocks.steerRun).not.toHaveBeenCalled();
  });

  it('실행 중이 아니면 409를 그대로 전한다', async () => {
    mocks.steerRun.mockImplementationOnce(() => {
      throw new StudioError(409, '실행 중이 아닙니다. 새 요청으로 보내세요');
    });

    const response = await post({ text: '지시' });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('실행 중이 아닙니다');
  });
});
