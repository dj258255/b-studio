import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { getTaskPlan } from '@/lib/server/task-plans';

export async function GET(request: Request, context: RouteContext<'/api/task-plans/[id]'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    return Response.json(getTaskPlan(id, user));
  } catch (error) {
    return errorResponse(error);
  }
}
