import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  ignoreRepeatedAction: vi.fn(),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: spies.requireUser }));
vi.mock('@/lib/server/repeated-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/repeated-actions')>();
  return { ...actual, ignoreRepeatedAction: spies.ignoreRepeatedAction };
});

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

const context = { params: Promise.resolve({ id: 'orders' }) } as Parameters<typeof POST>[1];

function request(body: unknown): Request {
  return new Request('http://studio.local/api/projects/orders/repeated-actions/ignore', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  spies.requireUser.mockReset();
  spies.requireUser.mockReturnValue('kim');
  spies.ignoreRepeatedAction.mockReset();
});

describe('POST /api/projects/[id]/repeated-actions/ignore', () => {
  it('candidateId를 무시 목록에 더한다', async () => {
    const response = await POST(request({ candidateId: 'command-abc123' }), context);

    expect(response.status).toBe(200);
    expect(spies.ignoreRepeatedAction).toHaveBeenCalledWith('orders', 'command-abc123');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('candidateId가 없으면 400이고 아무것도 남기지 않는다', async () => {
    const response = await POST(request({}), context);

    expect(response.status).toBe(400);
    expect(spies.ignoreRepeatedAction).not.toHaveBeenCalled();
  });

  it('로그인하지 않으면 401이다', async () => {
    spies.requireUser.mockImplementation(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });
    const response = await POST(request({ candidateId: 'x' }), context);

    expect(response.status).toBe(401);
    expect(spies.ignoreRepeatedAction).not.toHaveBeenCalled();
  });
});
