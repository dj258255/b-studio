import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { revokeBoardToken } from '@/lib/server/task-plans';

/** 외부 에이전트 토큰 하나를 거둔다(소유자만). 거둔 뒤로는 그 토큰으로 온 MCP 요청이 전부 401이다 */
export async function DELETE(request: Request, context: RouteContext<'/api/task-plans/[id]/board/tokens/[tokenId]'>) {
  try {
    const user = requireUser(request.headers);
    const { id, tokenId } = await context.params;
    return Response.json(revokeBoardToken(id, user, tokenId));
  } catch (error) {
    return errorResponse(error);
  }
}
