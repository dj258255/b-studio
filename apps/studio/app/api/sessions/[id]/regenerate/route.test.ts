import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn((): string => 'kim'),
  authorizeSession: vi.fn(async () => undefined),
  applyRegeneratedFilesToSession: vi.fn(async () => ({ restarted: [], skippedOff: [] })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: mocks.requireUser, authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({ applyRegeneratedFilesToSession: mocks.applyRegeneratedFilesToSession }));

import { POST } from './route';

const context = { params: Promise.resolve({ id: 's1' }) } as Parameters<typeof POST>[1];

beforeEach(() => {
  mocks.requireUser.mockReset().mockReturnValue('kim');
  mocks.authorizeSession.mockReset().mockResolvedValue(undefined);
  mocks.applyRegeneratedFilesToSession.mockReset().mockResolvedValue({ restarted: [], skippedOff: [] });
});

describe('POST /api/sessions/[id]/regenerate', () => {
  it('body의 files 배열을 그대로 넘기고 세션 소유권을 확인한다', async () => {
    const request = new Request('http://studio.local/api/sessions/s1/regenerate', {
      method: 'POST',
      body: JSON.stringify({ files: ['studio.yaml', 42] }),
    });
    const response = await POST(request, context);
    expect(response.status).toBe(200);
    expect(mocks.authorizeSession).toHaveBeenCalledWith('s1', 'kim');
    expect(mocks.applyRegeneratedFilesToSession).toHaveBeenCalledWith('s1', ['studio.yaml']);
  });

  it('body가 없으면 files를 빈 배열로 본다', async () => {
    const response = await POST(new Request('http://studio.local/api/sessions/s1/regenerate', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(mocks.applyRegeneratedFilesToSession).toHaveBeenCalledWith('s1', []);
  });

  it('세션이 준비 상태가 아니면 409를 그대로 돌려준다', async () => {
    mocks.applyRegeneratedFilesToSession.mockRejectedValue(new StudioError(409, '샌드박스가 준비된 뒤에 적용할 수 있습니다'));
    const response = await POST(new Request('http://studio.local/api/sessions/s1/regenerate', { method: 'POST', body: '{}' }), context);
    expect(response.status).toBe(409);
  });

  it('다른 사람의 세션이면 authorizeSession이 막는다', async () => {
    mocks.authorizeSession.mockRejectedValue(new StudioError(403, '만든 사람이나 관리자만 바꿀 수 있습니다'));
    const response = await POST(new Request('http://studio.local/api/sessions/s1/regenerate', { method: 'POST', body: '{}' }), context);
    expect(response.status).toBe(403);
    expect(mocks.applyRegeneratedFilesToSession).not.toHaveBeenCalled();
  });
});
