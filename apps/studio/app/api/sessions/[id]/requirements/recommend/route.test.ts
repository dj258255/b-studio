import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RecommendationReply {
  recommendations: Array<{ question: string; answer: string; rationale: string; sources: Array<{ url: string; title?: string }> }>;
  sourced: 'web' | 'model';
}

const mocks = vi.hoisted(() => ({
  recommendSessionRequirementQuestions: vi.fn<() => Promise<RecommendationReply>>(async () => ({ recommendations: [], sourced: 'model' })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ recommendSessionRequirementQuestions: mocks.recommendSessionRequirementQuestions }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/requirements/recommend`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.recommendSessionRequirementQuestions.mockClear();
  mocks.recommendSessionRequirementQuestions.mockImplementation(async () => ({ recommendations: [], sourced: 'model' }));
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/requirements/recommend', () => {
  it('질문마다 추천 답·근거·출처를 돌려준다', async () => {
    mocks.recommendSessionRequirementQuestions.mockResolvedValueOnce({
      recommendations: [{ question: '비밀번호 최소 길이는?', answer: '8자 이상', rationale: '업계 관행', sources: [{ url: 'https://example.com', title: 'OWASP' }] }],
      sourced: 'web',
    });

    const response = await post({ questions: ['비밀번호 최소 길이는?'], specText: '로그인 기능을 만드세요' });

    expect(response.status).toBe(200);
    expect(mocks.recommendSessionRequirementQuestions).toHaveBeenCalledWith(
      's1',
      { questions: ['비밀번호 최소 길이는?'], specText: '로그인 기능을 만드세요' },
      { signal: expect.any(AbortSignal) },
    );
    const body = await response.json();
    expect(body.sourced).toBe('web');
    expect(body.recommendations[0].answer).toBe('8자 이상');
  });

  it('질문이 없으면 400', async () => {
    const response = await post({ questions: [] });

    expect(response.status).toBe(400);
    expect(mocks.recommendSessionRequirementQuestions).not.toHaveBeenCalled();
  });

  it('추천 호출이 거부되면 그 이유를 그대로 전한다', async () => {
    mocks.recommendSessionRequirementQuestions.mockRejectedValueOnce(new StudioError(400, '이 세션 백엔드는 추천 답 호출을 지원하지 않습니다'));

    const response = await post({ questions: ['q'] });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('지원하지 않습니다');
  });

  it('권한이 없으면 403', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만'));

    const response = await post({ questions: ['q'] });

    expect(response.status).toBe(403);
  });
});
