import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { getSessionRequirements } from '@/lib/server/sessions';

/** "명세" 탭(ADR-079)이 연다: docs/requirements.md를 읽어 체크포인트·테스트·게이트 결과에서 모은 증거와 상태를 돌려준다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/requirements'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await getSessionRequirements(id));
  } catch (error) {
    return errorResponse(error);
  }
}
