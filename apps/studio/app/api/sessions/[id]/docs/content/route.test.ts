import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readSessionDoc: vi.fn(async (_id: string, path: string) => ({ path, content: '# 제목\n\n본문' })),
  writeSessionDoc: vi.fn(async (_id: string, path: string, content: string) => ({ path, content })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ readSessionDoc: mocks.readSessionDoc, writeSessionDoc: mocks.writeSessionDoc }));

import { StudioError } from '@/lib/server/errors';
import { GET, POST } from './route';

function get(path: string, id = 's1'): Promise<Response> {
  return GET(new Request(`http://localhost/api/sessions/${id}/docs/content?path=${encodeURIComponent(path)}`), { params: Promise.resolve({ id }) });
}

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/docs/content`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.readSessionDoc.mockClear();
  mocks.writeSessionDoc.mockClear();
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('GET /api/sessions/[id]/docs/content', () => {
  it('path로 문서 내용을 돌려준다', async () => {
    const response = await get('docs/02-결제도메인.md');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: 'docs/02-결제도메인.md', content: '# 제목\n\n본문' });
  });

  it('path가 없으면 400', async () => {
    const response = await GET(new Request('http://localhost/api/sessions/s1/docs/content'), { params: Promise.resolve({ id: 's1' }) });
    expect(response.status).toBe(400);
    expect(mocks.readSessionDoc).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/[id]/docs/content', () => {
  it('path·content를 작업 복사본에 저장한다', async () => {
    const response = await post({ path: 'docs/02-결제도메인.md', content: '# 새 내용' });
    expect(response.status).toBe(200);
    expect(mocks.writeSessionDoc).toHaveBeenCalledWith('s1', 'docs/02-결제도메인.md', '# 새 내용');
  });

  it('path나 content가 없으면 400', async () => {
    const response = await post({ path: 'docs/02-결제도메인.md' });
    expect(response.status).toBe(400);
    expect(mocks.writeSessionDoc).not.toHaveBeenCalled();
  });

  it('저장 함수가 거부하면 그 이유를 그대로 전한다', async () => {
    mocks.writeSessionDoc.mockRejectedValueOnce(new StudioError(400, '문서 탭은 docs/ 아래 마크다운만 다룹니다'));
    const response = await post({ path: 'api/src/Order.java', content: 'x' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('문서 탭은');
  });
});
