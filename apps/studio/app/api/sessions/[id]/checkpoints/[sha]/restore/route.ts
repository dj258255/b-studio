import { errorResponse } from '@/lib/server/errors';
import { restoreCheckpoint } from '@/lib/server/sessions';

export async function POST(_request: Request, context: RouteContext<'/api/sessions/[id]/checkpoints/[sha]/restore'>) {
  try {
    const { id, sha } = await context.params;
    restoreCheckpoint(id, sha);
    return Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
