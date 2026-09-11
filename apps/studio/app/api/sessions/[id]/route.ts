import { errorResponse, StudioError } from '@/lib/server/errors';
import { getSnapshot, recoverSessions, stopSession } from '@/lib/server/sessions';

export async function GET(_request: Request, context: RouteContext<'/api/sessions/[id]'>) {
  const { id } = await context.params;
  await recoverSessions();
  const snapshot = getSnapshot(id);
  return snapshot ? Response.json(snapshot) : errorResponse(new StudioError(404, '세션을 찾을 수 없습니다'));
}

export async function DELETE(_request: Request, context: RouteContext<'/api/sessions/[id]'>) {
  try {
    const { id } = await context.params;
    return Response.json(await stopSession(id));
  } catch (error) {
    return errorResponse(error);
  }
}
