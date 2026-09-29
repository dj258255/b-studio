import { requireUser } from '@/lib/server/access';
import { listAgentOverview } from '@/lib/server/agents-overview';
import { errorResponse } from '@/lib/server/errors';

/**
 * 관제 화면의 목록·합계. 세션·작업 분해 레인·플릿 구성원을 한 번에 준다.
 * 가볍게 유지한다: 세션 기록 전체를 읽지 않고 스냅샷과 최근 이벤트 몇 개만 쓴다.
 */
export async function GET(request: Request) {
  try {
    const user = requireUser(request.headers);
    return Response.json(await listAgentOverview(user));
  } catch (error) {
    return errorResponse(error);
  }
}
