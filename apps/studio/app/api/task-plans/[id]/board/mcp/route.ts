import { handleBoardMcpRequest } from '@b-studio/agent';
import { resolveBoardToken } from '@/lib/server/task-plans';

/**
 * 외부 에이전트(다른 Claude Code 세션·herdr·Codex CLI 등)가 이 계획의 게시판에 붙는 MCP 표면.
 * 로그인 쿠키가 아니라 `/board/tokens`가 내준 Authorization: Bearer 토큰으로만 인증한다 — 그래서 이
 * 경로는 auth.ts의 로그인 게이트 밖에 있다(BOARD_MCP_PATH). 토큰이 없거나 틀리거나 거뒀으면 401이다.
 */
async function handle(request: Request, context: RouteContext<'/api/task-plans/[id]/board/mcp'>): Promise<Response> {
  const { id } = await context.params;
  const resolved = resolveBoardToken(id, request.headers.get('authorization'));
  if (!resolved) return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: '토큰이 없거나 올바르지 않습니다' } }, { status: 401 });
  return handleBoardMcpRequest(request, resolved.access);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
