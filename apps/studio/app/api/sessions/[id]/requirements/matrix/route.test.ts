import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TraceabilityMatrix {
  rows: Array<Record<string, unknown>>;
  orphanTests: Array<Record<string, unknown>>;
  mustHavesWithoutTests: Array<Record<string, unknown>>;
}

const mocks = vi.hoisted(() => ({
  getSessionRequirementsMatrix: vi.fn<() => Promise<TraceabilityMatrix>>(async () => ({ rows: [], orphanTests: [], mustHavesWithoutTests: [] })),
  getSessionRequirementsMatrixCsv: vi.fn<() => Promise<string>>(async () => '종류,id\n'),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({
  getSessionRequirementsMatrix: mocks.getSessionRequirementsMatrix,
  getSessionRequirementsMatrixCsv: mocks.getSessionRequirementsMatrixCsv,
}));

import { StudioError } from '@/lib/server/errors';
import { GET } from './route';

function get(query = '', id = 's1'): Promise<Response> {
  return GET(new Request(`http://localhost/api/sessions/${id}/requirements/matrix${query}`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.getSessionRequirementsMatrix.mockClear();
  mocks.getSessionRequirementsMatrix.mockImplementation(async () => ({ rows: [], orphanTests: [], mustHavesWithoutTests: [] }));
  mocks.getSessionRequirementsMatrixCsv.mockClear();
  mocks.getSessionRequirementsMatrixCsv.mockImplementation(async () => '종류,id\n');
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('GET /api/sessions/[id]/requirements/matrix', () => {
  it('추적 매트릭스를 JSON으로 돌려준다', async () => {
    mocks.getSessionRequirementsMatrix.mockResolvedValueOnce({
      rows: [{ kind: 'requirement', id: 'R1', title: '로그인', rev: 1, priority: 'must', checkpoints: [], tests: [], gateChecks: [], status: '검증됨' }],
      orphanTests: [],
      mustHavesWithoutTests: [],
    });

    const response = await get();

    expect(response.status).toBe(200);
    expect(mocks.getSessionRequirementsMatrix).toHaveBeenCalledWith('s1');
    const body = await response.json();
    expect(body.rows).toHaveLength(1);
  });

  it('?format=csv면 CSV 파일로 내려준다', async () => {
    mocks.getSessionRequirementsMatrixCsv.mockResolvedValueOnce('종류,id\n요구사항,R1\n');

    const response = await get('?format=csv');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('requirements-matrix-s1.csv');
    expect(await response.text()).toBe('종류,id\n요구사항,R1\n');
    expect(mocks.getSessionRequirementsMatrix).not.toHaveBeenCalled();
  });

  it('권한이 없으면 403을 돌려준다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만 볼 수 있습니다'));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mocks.getSessionRequirementsMatrix).not.toHaveBeenCalled();
  });
});
