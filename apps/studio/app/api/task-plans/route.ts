import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createTaskPlan, listTaskPlans } from '@/lib/server/task-plans';
import { assertTerminalAccess } from '@/lib/server/terminal-access';

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
    requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as {
      projectId?: unknown;
      request?: unknown;
      modelId?: unknown;
      effort?: unknown;
      sourceSessionId?: unknown;
      /** 사람이 쓴 작업 카드(#B6a). 형식은 createTaskPlan(cardsToPlan)이 본다 */
      cards?: unknown;
      /** 레인을 돌리는 방식: terminal 하나뿐이다(없으면 terminal). chat과 모르는 값은 createTaskPlan이 400으로 거절한다 */
      runner?: unknown;
    };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    if (body.runner !== undefined && typeof body.runner !== 'string') throw new StudioError(400, 'runner는 terminal이어야 합니다');
    const runner = typeof body.runner === 'string' ? body.runner : undefined;
    // 작업 분해는 레인을 세션 터미널에서 돌린다(그 안의 CLI를 몬다). 세션 터미널 통로와 같은 검사(이 컴퓨터 주소·로컬 토큰)를 거친다
    const user = await assertTerminalAccess(request.headers);
    // request는 카드가 있으면 없어도 된다(계획 요청을 카드 제목으로 만든다). 그 밖의 계획에서는 필요하다
    if (body.cards === undefined && typeof body.request !== 'string') throw new StudioError(400, 'request가 필요합니다');
    if (body.request !== undefined && typeof body.request !== 'string') throw new StudioError(400, 'request는 문자열이어야 합니다');
    // modelId는 API 모드에서만 필요하다(로컬 Claude Code 모드는 보통 그 CLI가 정하지만, 세션에서 이어받은 별칭을 넘길 수도 있다)
    if (body.modelId !== undefined && typeof body.modelId !== 'string') throw new StudioError(400, 'modelId는 문자열이어야 합니다');
    // effort는 세션에서 이어받은 노력 단계(나눠서 병렬 제안 수락 경로)나 계획 폼에서 고른 값이다. 없어도 된다
    if (body.effort !== undefined && typeof body.effort !== 'string') throw new StudioError(400, 'effort는 문자열이어야 합니다');
    // 대화의 "나눠서 병렬로 하기"(ADR-068)만 보낸다. 넘긴 세션이 같은 프로젝트·소유자인지는 createTaskPlan이 확인한다
    if (body.sourceSessionId !== undefined && typeof body.sourceSessionId !== 'string') throw new StudioError(400, 'sourceSessionId는 문자열이어야 합니다');
    // 쓰기 범위와 작업 목록은 받지 않는다. 서버가 모델 계획을 검증해 정한다
    const input = {
      projectId: body.projectId,
      owner: user,
      ...(typeof body.request === 'string' ? { request: body.request } : {}),
      ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
      ...(typeof body.effort === 'string' ? { effort: body.effort } : {}),
      ...(typeof body.sourceSessionId === 'string' ? { sourceSessionId: body.sourceSessionId } : {}),
      // 카드는 사람이 쓴 계획이다. 형식 검증은 createTaskPlan(cardsToPlan)이 한다
      ...(body.cards !== undefined ? { cards: body.cards } : {}),
      ...(runner !== undefined ? { runner } : {}),
    };
    return Response.json(await createTaskPlan(input), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
