import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { runReviewRound } from '@/lib/server/sessions';

/**
 * PR 자동 리뷰 라운드(ADR-074)를 사람이 직접 부른다: PR이 있지만 아직 리뷰를 돌리지 않았을 때의 "AI 리뷰 돌리기",
 * 리뷰가 끝난(통과·상한·멈춤) 뒤의 "다시 돌리기". 라운드는 오래 걸리므로 시작만 하고 바로 돌아가며, 진행은 이벤트로 온다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/review'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { restart?: unknown; reviewerModelId?: unknown };
    // 설계 파이프라인(ADR-100): 구현과 다른 모델 계열로 검토하고 싶을 때 리뷰어 모델을 명시적으로 고를 수 있다(선택)
    await runReviewRound(id, { restart: body.restart === true, reviewerModelId: typeof body.reviewerModelId === 'string' ? body.reviewerModelId : undefined });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
