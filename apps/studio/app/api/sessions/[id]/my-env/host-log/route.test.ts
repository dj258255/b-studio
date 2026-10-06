import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  fetchHostLog: vi.fn(async () => ({ connected: true, logfileAvailable: true, logExcerpt: '최근 로그' })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/my-env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/my-env')>();
  return { ...actual, fetchHostLog: mocks.fetchHostLog };
});

import { GET } from './route';

function get(url: string, headers: HeadersInit = { host: 'localhost:3000' }, id = 's1'): Promise<Response> {
  return GET(new Request(url, { headers }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.fetchHostLog.mockClear();
  mocks.fetchHostLog.mockImplementation(async () => ({ connected: true, logfileAvailable: true, logExcerpt: '최근 로그' }));
});

describe('GET /api/sessions/[id]/my-env/host-log', () => {
  it('port를 주면 Actuator 결과를 돌려준다', async () => {
    const response = await get('http://localhost/api/sessions/s1/my-env/host-log?port=8080');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true, logfileAvailable: true, logExcerpt: '최근 로그' });
    expect(mocks.fetchHostLog).toHaveBeenCalledWith('s1', 8080);
  });

  it('port가 없으면 400', async () => {
    const response = await get('http://localhost/api/sessions/s1/my-env/host-log');
    expect(response.status).toBe(400);
    expect(mocks.fetchHostLog).not.toHaveBeenCalled();
  });

  it('선언하지 않은 포트면 서버가 던진 403을 그대로 전한다', async () => {
    mocks.fetchHostLog.mockRejectedValueOnce(new StudioError(403, '이 프로젝트가 studio.yaml에 선언한 포트만 확인할 수 있습니다'));
    const response = await get('http://localhost/api/sessions/s1/my-env/host-log?port=9999');
    expect(response.status).toBe(403);
  });

  it('다른 출처 요청은 403으로 거부한다', async () => {
    const response = await get('http://localhost/api/sessions/s1/my-env/host-log?port=8080', { host: 'localhost:3000', origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(mocks.fetchHostLog).not.toHaveBeenCalled();
  });
});
