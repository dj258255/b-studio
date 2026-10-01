import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentDevStatus: vi.fn(async (): Promise<unknown> => undefined),
}));

vi.mock('@/lib/server/dev-status', () => ({ currentDevStatus: mocks.currentDevStatus }));

import { GET } from './route';

describe('GET /api/dev-status', () => {
  it('운영 빌드면(undefined) active:false만 돌려준다', async () => {
    mocks.currentDevStatus.mockResolvedValueOnce(undefined);

    const response = await GET();

    expect(await response.json()).toEqual({ active: false });
  });

  it('dev 모드면 active:true와 함께 상태를 펼쳐서 돌려준다', async () => {
    mocks.currentDevStatus.mockResolvedValueOnce({ bootHead: 'abc1234', headNow: 'def5678', codeChanged: true, lockfileChanged: false });

    const response = await GET();

    expect(await response.json()).toEqual({ active: true, bootHead: 'abc1234', headNow: 'def5678', codeChanged: true, lockfileChanged: false });
  });
});
