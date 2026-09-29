import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { bootSession } from '@/lib/server/sessions';

/** 샌드박스를 지금 켠다(지연 기동 세션의 "지금 켜기"). 켜는 동안의 진행은 이벤트로 알린다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/boot'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await bootSession(id), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
