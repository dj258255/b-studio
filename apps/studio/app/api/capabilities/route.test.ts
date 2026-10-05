import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  studioCapabilities: vi.fn(() => ({
    mode: 'claude-code',
    single: { enabled: true },
    fleet: { enabled: false, reason: '여러 모델을 나란히 비교하는 방식은 B_STUDIO_MODE=api에서만 쓸 수 있습니다 (지금 모드: claude-code)' },
    split: { enabled: true },
    backends: ['claude-code'],
  })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/server/capabilities', () => ({ studioCapabilities: mocks.studioCapabilities }));

import { GET } from './route';

beforeEach(() => {
  mocks.requireUser.mockImplementation(() => 'kim');
  mocks.studioCapabilities.mockClear();
});

describe('GET /api/capabilities', () => {
  it('지금 쓸 수 있는 방식을 그대로 돌려준다', async () => {
    const response = await GET(new Request('http://localhost/api/capabilities'));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string; single: { enabled: boolean }; fleet: { enabled: boolean; reason?: string }; split: { enabled: boolean }; backends: string[] };
    expect(body.mode).toBe('claude-code');
    expect(body.single.enabled).toBe(true);
    expect(body.fleet.enabled).toBe(false);
    expect(body.fleet.reason).toContain('api');
    expect(body.split.enabled).toBe(true);
    expect(body.backends).toEqual(['claude-code']);
    expect(mocks.studioCapabilities).toHaveBeenCalledTimes(1);
  });

  it('로그인하지 않았으면 401을 돌려주고 값을 만들지 않는다', async () => {
    mocks.requireUser.mockImplementationOnce(() => {
      throw new StudioError(401, '로그인이 필요합니다');
    });

    const response = await GET(new Request('http://localhost/api/capabilities'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: '로그인이 필요합니다' });
    expect(mocks.studioCapabilities).not.toHaveBeenCalled();
  });
});
