import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { getFleet } from '@/lib/server/fleets';

export async function GET(request: Request, context: RouteContext<'/api/fleets/[id]'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    return Response.json(getFleet(id, user));
  } catch (error) {
    return errorResponse(error);
  }
}
