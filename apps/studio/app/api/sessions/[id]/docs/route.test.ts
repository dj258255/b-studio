import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listSessionDocs: vi.fn(async () => ({ docs: [{ path: 'docs/02-결제도메인.md', title: '02. 결제 도메인' }] })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/sessions', () => ({ listSessionDocs: mocks.listSessionDocs }));

import { GET } from './route';

function get(id = 's1'): Promise<Response> {
  return GET(new Request(`http://localhost/api/sessions/${id}/docs`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.listSessionDocs.mockClear();
});

describe('GET /api/sessions/[id]/docs', () => {
  it('문서 목록을 돌려준다', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ docs: [{ path: 'docs/02-결제도메인.md', title: '02. 결제 도메인' }] });
    expect(mocks.listSessionDocs).toHaveBeenCalledWith('s1');
  });
});
