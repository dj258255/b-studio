import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { approveTaskPlan, rejectTaskPlan } from '@/lib/server/task-plans';

export async function POST(request: Request, context: RouteContext<'/api/task-plans/[id]/approval'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { approve?: unknown; reason?: unknown };
    if (typeof body.approve !== 'boolean') throw new StudioError(400, 'approve는 true나 false여야 합니다');
    if (body.approve) return Response.json(approveTaskPlan(id, user));
    return Response.json(rejectTaskPlan(id, user, typeof body.reason === 'string' ? body.reason : undefined));
  } catch (error) {
    return errorResponse(error);
  }
}
