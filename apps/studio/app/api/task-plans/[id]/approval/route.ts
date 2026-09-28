import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { approveTaskPlan, rejectTaskPlan } from '@/lib/server/task-plans';

export async function POST(request: Request, context: RouteContext<'/api/task-plans/[id]/approval'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    // 승인할 때 이슈로 올릴지만 더 받는다. 쓰기 범위·작업 목록처럼 계획 실행을 바꾸는 필드는 받지 않는다
    const body = (await request.json().catch(() => ({}))) as { approve?: unknown; reason?: unknown; publishIssues?: unknown };
    if (typeof body.approve !== 'boolean') throw new StudioError(400, 'approve는 true나 false여야 합니다');
    if (body.approve) return Response.json(approveTaskPlan(id, user, { publishIssues: body.publishIssues === true }));
    return Response.json(rejectTaskPlan(id, user, typeof body.reason === 'string' ? body.reason : undefined));
  } catch (error) {
    return errorResponse(error);
  }
}
