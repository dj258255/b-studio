import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { sessionHistory } from '@/lib/server/sessions';
import { buildTokenReports, pricesFromEnv } from '@/lib/server/token-report';

/** 세션 기록에서 만든 실행별 토큰 보고서. 세션을 바꾸지 않고 읽기만 한다(이벤트 라우트와 같은 권한 규칙) */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/tokens'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    return Response.json({ runs: buildTokenReports(sessionHistory(id), pricesFromEnv(process.env)) });
  } catch (error) {
    return errorResponse(error);
  }
}
