import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { getSnapshot, recoverSessions, stopSession } from '@/lib/server/sessions';

export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    const snapshot = getSnapshot(id);
    if (!snapshot) throw new StudioError(404, '세션을 찾을 수 없습니다');
    return Response.json(snapshot);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext<'/api/sessions/[id]'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await stopSession(id));
  } catch (error) {
    return errorResponse(error);
  }
}
