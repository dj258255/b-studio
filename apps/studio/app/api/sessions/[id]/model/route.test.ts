import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recoverSessions: vi.fn(async () => {}),
  authorizeSession: vi.fn(async () => {}),
  sessionModelPicker: vi.fn(),
  setSessionModel: vi.fn(),
}));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim', authorizeSession: mocks.authorizeSession }));
vi.mock('@/lib/server/sessions', () => ({
  recoverSessions: mocks.recoverSessions,
  sessionModelPicker: mocks.sessionModelPicker,
  setSessionModel: mocks.setSessionModel,
}));

import { StudioError } from '@/lib/server/errors';
import { GET, POST } from './route';

const PICKER = { backend: 'claude-code', current: undefined, options: [{ id: '', label: '기본' }, { id: 'opus', label: 'Opus' }] };

function get(id = 's1'): Promise<Response> {
  return GET(new Request('http://localhost/api/sessions/s1/model'), { params: Promise.resolve({ id }) });
}

function post(body: unknown, id = 's1'): Promise<Response> {
  return POST(new Request('http://localhost/api/sessions/s1/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  mocks.recoverSessions.mockClear().mockResolvedValue(undefined);
  mocks.authorizeSession.mockClear().mockResolvedValue(undefined);
  mocks.sessionModelPicker.mockClear().mockResolvedValue(PICKER);
  mocks.setSessionModel.mockClear().mockResolvedValue({ ...PICKER, current: 'opus' });
});

describe('GET /api/sessions/[id]/model', () => {
  it('이 세션 백엔드의 모델 목록과 지금 값을 돌려준다', async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PICKER);
    expect(mocks.sessionModelPicker).toHaveBeenCalledWith('s1');
  });

  it('권한이 없으면 403을 돌려주고 목록을 읽지 않는다', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new StudioError(403, '읽기 전용입니다'));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mocks.sessionModelPicker).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/[id]/model', () => {
  it('modelId를 세션에 저장하고 바뀐 목록을 돌려준다', async () => {
    const response = await post({ modelId: 'opus' });

    expect(response.status).toBe(200);
    expect(mocks.setSessionModel).toHaveBeenCalledWith('s1', 'opus');
    expect((await response.json()).current).toBe('opus');
  });

  it('modelId를 비우면 "기본"으로 되돌린다', async () => {
    await post({ modelId: '' });
    expect(mocks.setSessionModel).toHaveBeenCalledWith('s1', '');
  });

  it('modelId가 문자열이 아니면 400을 돌려주고 저장하지 않는다', async () => {
    const response = await post({ modelId: 5 });

    expect(response.status).toBe(400);
    expect(mocks.setSessionModel).not.toHaveBeenCalled();
  });

  it('목록에 없는 모델이면(서버가 400을 던지면) 그대로 전한다', async () => {
    mocks.setSessionModel.mockRejectedValueOnce(new StudioError(400, '이 백엔드에서 고를 수 없는 모델입니다: gpt-5'));

    const response = await post({ modelId: 'gpt-5' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('고를 수 없는 모델');
  });

  it('요청을 처리하는 중이면(서버가 409를 던지면) 그대로 전한다', async () => {
    mocks.setSessionModel.mockRejectedValueOnce(new StudioError(409, '요청을 처리하는 동안에는 모델을 바꿀 수 없습니다'));

    const response = await post({ modelId: 'opus' });

    expect(response.status).toBe(409);
  });
});
