import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { resolveBaseConflictsWithAgent } from '@/lib/server/sessions';

/**
 * "에이전트에게 충돌 해결 맡기기"(ADR-076). 병합을 시도해 충돌이 없으면 그대로 따라잡고, 충돌하면(병합은 이미
 * 시도 전으로 되돌린 뒤) 대화 입력창에 미리 채울 요청 문구를 돌려준다. 진행은 이벤트로도 함께 알린다
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/base/resolve'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await resolveBaseConflictsWithAgent(id));
  } catch (error) {
    return errorResponse(error);
  }
}
