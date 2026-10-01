import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(() => ({ runId: 'r1' })),
  authorizeSession: vi.fn(async () => {}),
  assertDesignApprovedForRequest: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ sendMessage: mocks.sendMessage }));
vi.mock('@/lib/server/design-pipeline', () => ({ assertDesignApprovedForRequest: mocks.assertDesignApprovedForRequest }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions/s1/messages', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 's1' }) });
}

beforeEach(() => {
  mocks.sendMessage.mockClear();
  mocks.assertDesignApprovedForRequest.mockClear();
  mocks.assertDesignApprovedForRequest.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/messages — 설계 파이프라인 승인 게이트(ADR-100)', () => {
  it('구현(build) 요청은 보내기 전에 설계 승인을 확인한다', async () => {
    const response = await post({ text: '[R1] 구현해 주세요', intent: 'build' });

    expect(response.status).toBe(202);
    expect(mocks.assertDesignApprovedForRequest).toHaveBeenCalledWith('s1', '[R1] 구현해 주세요');
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
  });

  it('승인되지 않은 설계가 걸리면 409를 돌려주고 보내지 않는다', async () => {
    mocks.assertDesignApprovedForRequest.mockRejectedValueOnce(new StudioError(409, '설계 승인 전에는 구현을 시작할 수 없습니다'));

    const response = await post({ text: '[R1] 구현해 주세요', intent: 'build' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: '설계 승인 전에는 구현을 시작할 수 없습니다' });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('질문(ask)은 설계 승인을 확인하지 않는다 — 파일을 바꾸지 않기 때문이다', async () => {
    const response = await post({ text: '[R1] 어떻게 하면 좋을까요', intent: 'ask' });

    expect(response.status).toBe(202);
    expect(mocks.assertDesignApprovedForRequest).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
  });
});
