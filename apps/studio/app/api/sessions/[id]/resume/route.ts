import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { resumeSession } from '@/lib/server/sessions';

/** 중지된 세션을 같은 작업 복사본으로 새 샌드박스에서 띄운다. 기동 과정은 이벤트로 알린다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/resume'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await resumeSession(id), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
