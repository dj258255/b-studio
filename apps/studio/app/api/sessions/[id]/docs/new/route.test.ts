import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSessionDoc: vi.fn(async (_id: string, input: { kind: string; title: string }) => ({ path: `docs/01-${input.title}.md`, content: '# 템플릿' })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ createSessionDoc: mocks.createSessionDoc }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/docs/new`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.createSessionDoc.mockClear();
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/docs/new', () => {
  it('kind·title로 새 문서를 만든다', async () => {
    const response = await post({ kind: 'design', title: '결제 재시도' });
    expect(response.status).toBe(200);
    expect(mocks.createSessionDoc).toHaveBeenCalledWith('s1', { kind: 'design', title: '결제 재시도' });
  });

  it('body를 주면(대화 메시지 저장) 함께 전달한다', async () => {
    await post({ kind: 'adr', title: '결정 제목', body: '대화에서 가져온 본문' });
    expect(mocks.createSessionDoc).toHaveBeenCalledWith('s1', { kind: 'adr', title: '결정 제목', body: '대화에서 가져온 본문' });
  });

  it('kind가 네 가지 밖이면 400', async () => {
    const response = await post({ kind: 'etc', title: '제목' });
    expect(response.status).toBe(400);
    expect(mocks.createSessionDoc).not.toHaveBeenCalled();
  });

  it('제목이 없으면 400', async () => {
    const response = await post({ kind: 'design' });
    expect(response.status).toBe(400);
  });

  it('만들기 함수가 거부하면 그 이유를 그대로 전한다', async () => {
    mocks.createSessionDoc.mockRejectedValueOnce(new StudioError(409, '샌드박스가 준비된 뒤에 만들 수 있습니다'));
    const response = await post({ kind: 'design', title: '제목' });
    expect(response.status).toBe(409);
  });
});
