import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { deleteSession } from '@/lib/server/sessions';

/**
 * 세션 기록 자체를 지운다(기존 `DELETE /api/sessions/[id]`는 샌드박스만 멈추므로 그대로 둔다).
 * 실행 중이면 서버가 409로 거부한다 — 화면은 먼저 "샌드박스 중지"를 누르게 안내한다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/delete'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    await deleteSession(id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
