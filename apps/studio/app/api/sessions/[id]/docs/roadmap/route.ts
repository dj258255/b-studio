import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { regenerateSessionRoadmap } from '@/lib/server/sessions';

/** "ROADMAP 갱신": docs/ROADMAP.md의 "진행 현황" 구간만 저장된 요구사항 상태로 다시 만든다(단계·마일스톤·현재 위치는 그대로 둔다) */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/docs/roadmap'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await regenerateSessionRoadmap(id));
  } catch (error) {
    return errorResponse(error);
  }
}
