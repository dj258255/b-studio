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
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; request?: unknown; modelId?: unknown; sourceSessionId?: unknown };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    if (typeof body.request !== 'string') throw new StudioError(400, 'request가 필요합니다');
    // modelId는 API 모드에서만 필요하다. 로컬 Claude Code 모드는 그 CLI가 모델을 정한다(createTaskPlan이 확인한다)
    if (body.modelId !== undefined && typeof body.modelId !== 'string') throw new StudioError(400, 'modelId는 문자열이어야 합니다');
    // 대화의 "나눠서 병렬로 하기"(ADR-068)만 보낸다. 넘긴 세션이 같은 프로젝트·소유자인지는 createTaskPlan이 확인한다
    if (body.sourceSessionId !== undefined && typeof body.sourceSessionId !== 'string') throw new StudioError(400, 'sourceSessionId는 문자열이어야 합니다');
    // 쓰기 범위와 작업 목록은 받지 않는다. 서버가 모델 계획을 검증해 정한다
    const input = {
      projectId: body.projectId,
      request: body.request,
      owner: user,
      ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
      ...(typeof body.sourceSessionId === 'string' ? { sourceSessionId: body.sourceSessionId } : {}),
    };
    return Response.json(await createTaskPlan(input), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
