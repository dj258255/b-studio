import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { publishSessionRequirementIssues } from '@/lib/server/sessions';

/** 미리보기를 확인한 뒤 실제로 발행한다(ADR-089): 하위 이슈·추적 이슈를 만들거나 갱신한다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/publish'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await publishSessionRequirementIssues(id));
  } catch (error) {
    return errorResponse(error);
  }
}
