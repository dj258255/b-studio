import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { listSelectableModels } from '@/lib/server/model-picker';
import { setLaneBackend } from '@/lib/server/task-plans';

/**
 * 승인 대기 중인 작업 분해 계획에서 레인 하나의 백엔드·모델·노력 단계를 바꾼다(이슈 #398).
 * backend를 비우면(빈 문자열) "세션과 같음"(상속)으로 되돌린다. 레인 세션을 이미 만든 뒤에는(승인 뒤) 바꿀 수 없다
 * (setLaneBackend가 409를 던진다). 쓰기 범위·작업 목록처럼 계획 실행을 바꾸는 다른 필드는 이 라우트로 받지 않는다.
 *
 * 바뀐 계획과 함께, 레인이 지금 고른 백엔드의 모델 목록(picker)도 같이 돌려준다 — 화면이 모델을 바꾼 뒤 다시
 * 목록을 불러오지 않고 바로 다음 선택지를 보여줄 수 있게 한다. 레인이 "세션과 같음"이면 picker가 없다.
 */
export async function POST(request: Request, context: RouteContext<'/api/task-plans/[id]/lanes/[laneId]/backend'>) {
  try {
    const user = requireUser(request.headers);
    const { id, laneId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { backend?: unknown; model?: unknown; effort?: unknown };
    if (body.backend !== undefined && typeof body.backend !== 'string') throw new StudioError(400, 'backend는 문자열이어야 합니다');
    if (body.model !== undefined && typeof body.model !== 'string') throw new StudioError(400, 'model은 문자열이어야 합니다');
    if (body.effort !== undefined && typeof body.effort !== 'string') throw new StudioError(400, 'effort는 문자열이어야 합니다');
    const plan = setLaneBackend(id, user, laneId, {
      ...(typeof body.backend === 'string' ? { backend: body.backend } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.effort === 'string' ? { effort: body.effort } : {}),
    });
    const lane = plan.lanes.find((candidate) => candidate.id === laneId);
    const picker = lane?.backend ? await listSelectableModels(lane.backend, lane.model, lane.effort) : undefined;
    return Response.json({ plan, ...(picker ? { picker } : {}) });
  } catch (error) {
    return errorResponse(error);
  }
}
