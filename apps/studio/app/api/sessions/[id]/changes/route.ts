import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { liveChanges } from '@/lib/server/sessions';

/** 마지막 체크포인트 이후의 지금 변경(#924). desk의 지금 변경 화면이 diff를 보고 줄마다 의견을 단다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/changes'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await liveChanges(id));
  } catch (error) {
    return errorResponse(error);
  }
}
