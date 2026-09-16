import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { resumeTaskPlan } from '@/lib/server/task-plans';

/** 재시작으로 멈춘 계획의 통합을 다시 시작한다. 레인은 다시 돌리지 않고 남겨 둔 결과만 합친다 */
export async function POST(request: Request, context: RouteContext<'/api/task-plans/[id]/resume'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    return Response.json(resumeTaskPlan(id, user));
  } catch (error) {
    return errorResponse(error);
  }
}
