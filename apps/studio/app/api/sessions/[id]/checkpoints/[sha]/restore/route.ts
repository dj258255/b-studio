import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { restoreCheckpoint } from '@/lib/server/sessions';

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/checkpoints/[sha]/restore'>) {
  try {
    const user = requireUser(request.headers);
    const { id, sha } = await context.params;
    await authorizeSession(id, user);
    restoreCheckpoint(id, sha);
    return Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
