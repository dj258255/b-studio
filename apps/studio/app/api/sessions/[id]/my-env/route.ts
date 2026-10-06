import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { discoverMyEnv, requireSameOrigin } from '@/lib/server/my-env';

/** "내 환경" 탭의 한 번 읽기 스냅샷(GET만 받는다). 재시작·중지 같은 쓰기 라우트는 두지 않는다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/my-env'>) {
  try {
    requireSameOrigin(request.headers);
    requireUser(request.headers);
    const { id } = await context.params;
    return Response.json(await discoverMyEnv(id));
  } catch (error) {
    return errorResponse(error);
  }
}
