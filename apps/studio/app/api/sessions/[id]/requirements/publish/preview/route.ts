import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { previewRequirementIssuePublish } from '@/lib/server/sessions';

/** "이슈로 발행" 미리보기(dry-run, ADR-092). 원격 이슈를 읽기만 하고 아무것도 쓰지 않는다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/publish/preview'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await previewRequirementIssuePublish(id));
  } catch (error) {
    return errorResponse(error);
  }
}
