import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Board, externalBoardAccess } from '@b-studio/agent';

const mocks = vi.hoisted(() => ({ resolveBoardToken: vi.fn() }));

vi.mock('@/lib/server/task-plans', () => ({ resolveBoardToken: mocks.resolveBoardToken }));

import { POST } from './route';

const context = { params: Promise.resolve({ id: 'plan-1' }) } as Parameters<typeof POST>[1];

function rpc(body: unknown): Request {
  return new Request('http://studio.local/api/task-plans/plan-1/board/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer whatever' },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };

beforeEach(() => {
  mocks.resolveBoardToken.mockReset();
});

describe('POST /api/task-plans/[id]/board/mcp', () => {
  it('토큰을 찾지 못하면(없거나 틀리거나 거둠) 로그인 없이도 401을 돌려준다 — task-plans.ts가 신원을 확인한다', async () => {
    mocks.resolveBoardToken.mockReturnValue(undefined);

    const response = await POST(rpc(INITIALIZE), context);

    expect(response.status).toBe(401);
    expect(mocks.resolveBoardToken).toHaveBeenCalledWith('plan-1', 'Bearer whatever');
  });

  it('토큰이 맞으면 initialize를 받아 MCP 서버로 응답한다(그 접근으로 도구 두 개를 연다)', async () => {
    const board = new Board({ topology: 'mesh' });
    mocks.resolveBoardToken.mockReturnValue({ access: externalBoardAccess(board, { lane: 'guest-codex' }) });

    const response = await POST(rpc(INITIALIZE), context);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.serverInfo.name).toBe('b-studio-board');
  });
});
