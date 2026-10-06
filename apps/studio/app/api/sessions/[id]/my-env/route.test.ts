import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';
import type { MyEnvSnapshot } from '@/lib/server/my-env';

const SNAPSHOT: MyEnvSnapshot = {
  generatedAt: '2026-10-07T00:00:00.000Z',
  projectRoot: '/Users/me/myapp',
  dockerAvailable: true,
  composeGroups: [],
  hostProcesses: [],
};

const mocks = vi.hoisted(() => ({
  discoverMyEnv: vi.fn<(id: string) => Promise<MyEnvSnapshot>>(async () => SNAPSHOT),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/my-env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/my-env')>();
  return { ...actual, discoverMyEnv: mocks.discoverMyEnv };
});

import { GET } from './route';

function get(headers: HeadersInit = {}, id = 's1'): Promise<Response> {
  return GET(new Request(`http://localhost/api/sessions/${id}/my-env`, { headers }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.discoverMyEnv.mockClear();
  mocks.discoverMyEnv.mockImplementation(async () => SNAPSHOT);
});

describe('GET /api/sessions/[id]/my-env', () => {
  it('같은 출처 요청은 스냅샷을 돌려준다', async () => {
    const response = await get({ host: 'localhost:3000', origin: 'http://localhost:3000' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SNAPSHOT);
    expect(mocks.discoverMyEnv).toHaveBeenCalledWith('s1');
  });

  it('Origin 헤더가 없는 요청도 통과시킨다(curl 등, 인증으로 걸러진다)', async () => {
    const response = await get({ host: 'localhost:3000' });
    expect(response.status).toBe(200);
  });

  it('다른 출처 요청은 403으로 거부하고 조사를 부르지 않는다', async () => {
    const response = await get({ host: 'localhost:3000', origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(mocks.discoverMyEnv).not.toHaveBeenCalled();
  });

  it('세션을 찾지 못하면 404를 그대로 전한다', async () => {
    mocks.discoverMyEnv.mockRejectedValueOnce(new StudioError(404, '세션을 찾을 수 없습니다'));
    const response = await get({ host: 'localhost:3000' });
    expect(response.status).toBe(404);
  });
});
