import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createSession } from '@/lib/server/sessions';

export async function POST(request: Request) {
  try {
    const user = requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; workspace?: unknown };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    const workspace = body.workspace ?? 'copy';
    if (workspace !== 'copy' && workspace !== 'local') throw new StudioError(400, 'workspace는 copy나 local이어야 합니다');
    return Response.json(await createSession(body.projectId, user, workspace), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
