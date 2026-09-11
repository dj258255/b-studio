import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { rollbackSessionDeploy } from '@/lib/server/sessions';

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/deploys/rollback'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { releaseId?: unknown };
    if (typeof body.releaseId !== 'string' || !/^r\d{14}$/.test(body.releaseId)) throw new StudioError(400, 'releaseId가 필요합니다');
    rollbackSessionDeploy(id, body.releaseId, { by: user });
    return Response.json({ started: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
