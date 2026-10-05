import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applySessionRequirements: vi.fn(async () => ({ exists: true, requirements: [], assumptions: [] })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ applySessionRequirements: mocks.applySessionRequirements }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/requirements/apply`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

const sample = { id: 'R1', title: '로그인', kind: 'api', priority: 'must', acceptance: ['a'] };

beforeEach(() => {
  mocks.applySessionRequirements.mockClear();
  mocks.applySessionRequirements.mockImplementation(async () => ({ exists: true, requirements: [], assumptions: [] }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/requirements/apply', () => {
  it('요구사항 목록(+가정)을 저장하고 다시 읽은 목록을 돌려준다', async () => {
    const response = await post({ requirements: [sample], assumptions: ['seed 데이터 기준 게시글 42건'] });

    expect(response.status).toBe(200);
    expect(mocks.applySessionRequirements).toHaveBeenCalledWith('s1', { requirements: [sample], assumptions: ['seed 데이터 기준 게시글 42건'] });
  });

  it('가정 없이 요구사항만 보내도 된다', async () => {
    const response = await post({ requirements: [sample] });

    expect(response.status).toBe(200);
    expect(mocks.applySessionRequirements).toHaveBeenCalledWith('s1', { requirements: [sample] });
  });

  it('배열만 보내면(옛 형식) 400', async () => {
    const response = await post([sample]);

    expect(response.status).toBe(400);
    expect(mocks.applySessionRequirements).not.toHaveBeenCalled();
  });

  it('저장 함수가 거부하면 그 이유를 그대로 전한다', async () => {
    mocks.applySessionRequirements.mockRejectedValueOnce(new StudioError(400, '요구사항 id가 중복됩니다'));

    const response = await post({ requirements: [sample, sample] });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('중복됩니다');
  });

  it('권한이 없으면 403', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만'));

    const response = await post({ requirements: [sample] });

    expect(response.status).toBe(403);
  });
});
