import { authorizeSession, requireUser } from '@/lib/server/access';
import { sessionDeployStatus } from '@/lib/server/deploys';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { deploySession } from '@/lib/server/sessions';

export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/deploys'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    return Response.json(await sessionDeployStatus(id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/deploys'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { sha?: unknown };
    if (body.sha !== undefined && typeof body.sha !== 'string') throw new StudioError(400, 'sha는 문자열이어야 합니다');
    deploySession(id, { by: user, sha: body.sha });
    return Response.json({ started: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
