import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  regenerateSessionDocsIndex: vi.fn(async () => ({ path: 'docs/README.md', content: '# 문서\n\n<!-- b-studio:docs-index -->\n...\n<!-- /b-studio:docs-index -->\n' })),
  authorizeSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ regenerateSessionDocsIndex: mocks.regenerateSessionDocsIndex }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

function post(id = 's1'): Promise<Response> {
  return POST(new Request(`http://localhost/api/sessions/${id}/docs/reindex`, { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.regenerateSessionDocsIndex.mockClear();
  mocks.authorizeSession.mockClear();
  mocks.authorizeSession.mockImplementation(async () => {});
});

describe('POST /api/sessions/[id]/docs/reindex', () => {
  it('docs/README.md 색인을 다시 만들고 그 내용을 돌려준다', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.path).toBe('docs/README.md');
    expect(mocks.regenerateSessionDocsIndex).toHaveBeenCalledWith('s1');
  });

  it('권한이 없으면 403', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '만든 사람만'));
    const response = await post();
    expect(response.status).toBe(403);
    expect(mocks.regenerateSessionDocsIndex).not.toHaveBeenCalled();
  });
});
