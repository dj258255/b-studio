import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RequirementsSnapshot {
  exists: boolean;
  requirements: Array<Record<string, unknown>>;
  coverage?: Record<string, unknown>;
  allMustHavesPrefill?: string;
}

const mocks = vi.hoisted(() => ({
  getSessionRequirements: vi.fn<() => Promise<RequirementsSnapshot>>(async () => ({ exists: false, requirements: [] })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ getSessionRequirements: mocks.getSessionRequirements }));

import { StudioError } from '@/lib/server/errors';
import { GET } from './route';

function get(id = 's1'): Promise<Response> {
  return GET(new Request(`http://localhost/api/sessions/${id}/requirements`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.getSessionRequirements.mockClear();
  mocks.getSessionRequirements.mockImplementation(async () => ({ exists: false, requirements: [] }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('GET /api/sessions/[id]/requirements', () => {
  it('요구사항 목록과 증거를 돌려준다', async () => {
    mocks.getSessionRequirements.mockResolvedValueOnce({
      exists: true,
      requirements: [{ id: 'R1', title: '로그인', kind: 'api', priority: 'must', acceptance: ['a'], status: '검증됨', confidence: '🟢', evidence: { checkpoints: [], tests: [], gateChecks: [] }, workPrefill: '...' }],
      coverage: { total: 1, verified: 1, mustTotal: 1, mustVerified: 1, text: '1개 중 1개 검증됨' },
    });

    const response = await get();

    expect(response.status).toBe(200);
    expect(mocks.getSessionRequirements).toHaveBeenCalledWith('s1');
    const body = await response.json();
    expect(body.requirements).toHaveLength(1);
    expect(body.coverage.text).toBe('1개 중 1개 검증됨');
  });

  it('권한이 없으면 403을 돌려준다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만 볼 수 있습니다'));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mocks.getSessionRequirements).not.toHaveBeenCalled();
  });
});
