import { errorResponse, StudioError } from '@/lib/server/errors';
import { createSession } from '@/lib/server/sessions';

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    return Response.json(await createSession(body.projectId), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
