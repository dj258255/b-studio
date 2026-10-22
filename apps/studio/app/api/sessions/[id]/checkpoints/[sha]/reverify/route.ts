import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { reverifySession } from '@/lib/server/sessions';

/**
 * 다시 검증(#798). 에이전트 실행 없이 지금 체크포인트를 같은 게이트로 처음부터 돌린다. 막는 조건(실행 중, 체크포인트에 없는 변경,
 * 지금 체크포인트가 아님)은 409로 바로 알리고, 검사 결과는 이벤트(reverify_finished)로 알린다
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/checkpoints/[sha]/reverify'>) {
  try {
    const user = requireUser(request.headers);
    const { id, sha } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await reverifySession(id, user, sha), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
