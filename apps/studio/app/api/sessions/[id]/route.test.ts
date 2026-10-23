import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '@/lib/server/errors';

const mocks = vi.hoisted(() => ({
  authorizeSession: vi.fn(async () => {}),
  setSessionLabel: vi.fn(async (id: string, label: string) => ({ id, label: label.trim() || undefined })),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({
  recoverSessions: async () => {},
  getSnapshot: () => undefined,
  stopSession: async () => ({}),
  setSessionLabel: mocks.setSessionLabel,
}));

import { PATCH } from './route';

const context = { params: Promise.resolve({ id: 's1' }) };
const patch = (body: unknown): Promise<Response> =>
  PATCH(new Request('http://localhost/api/sessions/s1', { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) }), context);

beforeEach(() => {
  mocks.authorizeSession.mockReset();
  mocks.authorizeSession.mockImplementation(async () => {});
  mocks.setSessionLabel.mockClear();
});

describe('PATCH /api/sessions/[id] 세션 이름(#864)', () => {
  it('세션을 바꿀 수 있는 사람이면 이름을 바꾼다', async () => {
    const response = await patch({ label: '결제 화면' });
    expect(response.status).toBe(200);
    expect(mocks.authorizeSession).toHaveBeenCalledWith('s1', 'kim');
    expect(mocks.setSessionLabel).toHaveBeenCalledWith('s1', '결제 화면');
    expect(await response.json()).toEqual({ id: 's1', label: '결제 화면' });
  });

  it('세션을 바꿀 권한이 없으면 바꾸지 않는다', async () => {
    mocks.authorizeSession.mockImplementation(async () => {
      throw new StudioError(403, '이 세션을 바꿀 권한이 없습니다');
    });
    const response = await patch({ label: '남의 세션' });
    expect(response.status).toBe(403);
    expect(mocks.setSessionLabel).not.toHaveBeenCalled();
  });

  it('label이 문자열이 아니면 400', async () => {
    expect((await patch({ label: 3 })).status).toBe(400);
    expect((await patch('깨진 JSON')).status).toBe(400);
    expect(mocks.setSessionLabel).not.toHaveBeenCalled();
  });
});
