import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mintBoardToken: vi.fn() }));

vi.mock('@/lib/server/access', () => ({ requireUser: () => 'kim' }));
vi.mock('@/lib/server/task-plans', () => ({ mintBoardToken: mocks.mintBoardToken }));

import { StudioError } from '@/lib/server/errors';
import { POST } from './route';

const context = { params: Promise.resolve({ id: 'plan-1' }) } as Parameters<typeof POST>[1];

function request(body: unknown): Request {
  return new Request('http://studio.local/api/task-plans/plan-1/board/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  mocks.mintBoardToken.mockReset();
});

describe('POST /api/task-plans/[id]/board/tokens', () => {
  it('lane을 서버로 넘기고, 토큰·MCP 연결 정보와 함께 201을 돌려준다', async () => {
    mocks.mintBoardToken.mockReturnValue({ tokenId: 'tok-1', token: 'secret-token-value', lane: 'guest-codex', plan: { id: 'plan-1' } });

    const response = await POST(request({ lane: 'guest-codex' }), context);

    expect(response.status).toBe(201);
    expect(mocks.mintBoardToken).toHaveBeenCalledWith('plan-1', 'kim', { lane: 'guest-codex' });
    const body = await response.json();
    expect(body.token).toBe('secret-token-value');
    expect(body.tokenId).toBe('tok-1');
    expect(body.mcp.url).toBe('http://studio.local/api/task-plans/plan-1/board/mcp');
    expect(body.mcp.header).toBe('Authorization: Bearer secret-token-value');
  });

  it('group을 같이 보내면 서버로 넘긴다', async () => {
    mocks.mintBoardToken.mockReturnValue({ tokenId: 'tok-1', token: 'x', lane: 'guest-codex', group: 'web/a', plan: { id: 'plan-1' } });

    await POST(request({ lane: 'guest-codex', group: 'web/a' }), context);

    expect(mocks.mintBoardToken).toHaveBeenCalledWith('plan-1', 'kim', { lane: 'guest-codex', group: 'web/a' });
  });

  it('lane이 없거나 문자열이 아니면 400이고 서버를 부르지 않는다', async () => {
    const response = await POST(request({}), context);

    expect(response.status).toBe(400);
    expect(mocks.mintBoardToken).not.toHaveBeenCalled();
  });

  it('서버가 던진 오류(소유자 아님·게시판 없음 등)를 그대로 전한다', async () => {
    mocks.mintBoardToken.mockImplementation(() => {
      throw new StudioError(403, '이 작업 계획을 볼 수 없습니다');
    });

    const response = await POST(request({ lane: 'guest-codex' }), context);

    expect(response.status).toBe(403);
  });

  it('없는 계획은 404를 그대로 전한다', async () => {
    mocks.mintBoardToken.mockImplementation(() => {
      throw new StudioError(404, '작업 계획을 찾을 수 없습니다');
    });

    const response = await POST(request({ lane: 'guest-codex' }), context);

    expect(response.status).toBe(404);
  });
});
