import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ExtractionPreview {
  requirements: Array<{ id: string; title: string; kind: string; priority: string; acceptance: string[] }>;
  questions: string[];
  source: 'model' | 'fallback';
  reason?: string;
}

const mocks = vi.hoisted(() => ({
  previewSessionRequirementsExtraction: vi.fn<() => Promise<ExtractionPreview>>(async () => ({ requirements: [], questions: [], source: 'fallback', reason: 'test' })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ previewSessionRequirementsExtraction: mocks.previewSessionRequirementsExtraction }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/requirements/extract`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.previewSessionRequirementsExtraction.mockClear();
  mocks.previewSessionRequirementsExtraction.mockImplementation(async () => ({ requirements: [], questions: [], source: 'fallback' as const, reason: 'test' }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/requirements/extract', () => {
  it('명세 글을 넘기면 미리보기를 돌려준다(아직 파일에 쓰지 않는다)', async () => {
    mocks.previewSessionRequirementsExtraction.mockResolvedValueOnce({
      requirements: [{ id: 'R1', title: '로그인', kind: 'api', priority: 'must', acceptance: ['a'] }],
      questions: ['비밀번호 최소 길이는?'],
      source: 'model',
    });

    const response = await post({ specText: '로그인 기능을 만드세요' });

    expect(response.status).toBe(200);
    expect(mocks.previewSessionRequirementsExtraction).toHaveBeenCalledWith('s1', { specText: '로그인 기능을 만드세요' });
    const body = await response.json();
    expect(body.source).toBe('model');
    expect(body.questions).toHaveLength(1);
  });

  it('입력이 하나도 없으면 400', async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect(mocks.previewSessionRequirementsExtraction).not.toHaveBeenCalled();
  });

  it('권한이 없으면 403', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만'));

    const response = await post({ specText: 'x' });

    expect(response.status).toBe(403);
  });
});
