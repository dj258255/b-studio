import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestsSnapshot {
  services: Array<Record<string, unknown>>;
  requirementsWithoutTests: Array<Record<string, unknown>>;
}

const mocks = vi.hoisted(() => ({
  getSessionTests: vi.fn<() => Promise<TestsSnapshot>>(async () => ({ services: [], requirementsWithoutTests: [] })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ getSessionTests: mocks.getSessionTests }));

import { StudioError } from '@/lib/server/errors';
import { GET } from './route';

function get(id = 's1'): Promise<Response> {
  return GET(new Request(`http://localhost/api/sessions/${id}/tests`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.getSessionTests.mockClear();
  mocks.getSessionTests.mockImplementation(async () => ({ services: [], requirementsWithoutTests: [] }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('GET /api/sessions/[id]/tests', () => {
  it('서비스별 테스트 목록을 돌려준다(ADR-084)', async () => {
    mocks.getSessionTests.mockResolvedValueOnce({
      services: [{ service: 'api', template: 'spring-boot', running: false, supported: true, counts: { pass: 1, fail: 0, skip: 0, notRun: 0 }, rows: [] }],
      requirementsWithoutTests: [],
    });

    const response = await get();

    expect(response.status).toBe(200);
    expect(mocks.getSessionTests).toHaveBeenCalledWith('s1');
    const body = await response.json();
    expect(body.services).toHaveLength(1);
    expect(body.services[0].service).toBe('api');
  });

  it('권한이 없으면 403을 돌려준다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만 볼 수 있습니다'));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mocks.getSessionTests).not.toHaveBeenCalled();
  });
});
