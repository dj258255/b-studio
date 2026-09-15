import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createTaskPlan, listTaskPlans } from '@/lib/server/task-plans';

export function GET(request: Request) {
  try {
    const user = requireUser(request.headers);
    return Response.json(listTaskPlans(user));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; request?: unknown; modelId?: unknown };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    if (typeof body.request !== 'string') throw new StudioError(400, 'request가 필요합니다');
    if (typeof body.modelId !== 'string') throw new StudioError(400, 'modelId가 필요합니다');
    // 쓰기 범위와 작업 목록은 받지 않는다. 서버가 모델 계획을 검증해 정한다
    return Response.json(await createTaskPlan({ projectId: body.projectId, request: body.request, modelId: body.modelId, owner: user }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
