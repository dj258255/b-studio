import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { getSessionTests } from '@/lib/server/sessions';

/** "테스트" 탭(ADR-084)이 연다: 서비스마다 백엔드·프론트 테스트 케이스를 찾고, 마지막으로 저장해 둔 결과를 이어 붙여 돌려준다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/tests'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await getSessionTests(id));
  } catch (error) {
    return errorResponse(error);
  }
}
