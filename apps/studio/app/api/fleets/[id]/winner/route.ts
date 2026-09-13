import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { chooseFleetWinner } from '@/lib/server/fleets';

export async function POST(request: Request, context: RouteContext<'/api/fleets/[id]/winner'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { sessionId?: unknown };
    if (typeof body.sessionId !== 'string') throw new StudioError(400, 'sessionId가 필요합니다');
    return Response.json(chooseFleetWinner(id, body.sessionId, user));
  } catch (error) {
    return errorResponse(error);
  }
}
