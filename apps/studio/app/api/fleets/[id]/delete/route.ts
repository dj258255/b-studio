import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { deleteFleet } from '@/lib/server/fleets';

export async function POST(request: Request, context: RouteContext<'/api/fleets/[id]/delete'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await deleteFleet(id, user);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
