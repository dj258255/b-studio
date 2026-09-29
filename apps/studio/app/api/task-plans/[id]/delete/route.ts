import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { deleteTaskPlan } from '@/lib/server/task-plans';

export async function POST(request: Request, context: RouteContext<'/api/task-plans/[id]/delete'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await deleteTaskPlan(id, user);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
