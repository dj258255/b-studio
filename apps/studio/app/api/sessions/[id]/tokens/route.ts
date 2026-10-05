import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { getSnapshot, sessionHistory } from '@/lib/server/sessions';
import { buildTokenReports, reviewTokenReports, tokenPricing } from '@/lib/server/token-report';

/** 세션 기록에서 만든 실행별 토큰 보고서. 세션을 바꾸지 않고 읽기만 한다(이벤트 라우트와 같은 권한 규칙) */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/tokens'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const pricing = tokenPricing(process.env);
    // PR 자동 리뷰(ADR-074)의 리뷰어 호출은 세션 실행 기록(run_started/run_finished)에 남지 않아(도구 없는 한 번의 질문) 스냅샷의 review.rounds에서 따로 가져와 붙인다
    const runs = [...buildTokenReports(sessionHistory(id), pricing), ...reviewTokenReports(getSnapshot(id)?.review, pricing)];
    return Response.json({ runs });
  } catch (error) {
    return errorResponse(error);
  }
}
