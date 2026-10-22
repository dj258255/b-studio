import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { routingStats } from '@/lib/server/routing-stats';

/**
 * AI별 결과표(#821). `?projectId=`를 주면 그 프로젝트의 세션만 모은다.
 * 보기는 로그인한 누구나 할 수 있다(프로젝트 토큰 보고서와 같다, ADR-040). 세션 기록을 바꾸지 않는다.
 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    const projectId = new URL(request.url).searchParams.get('projectId')?.trim() || undefined;
    return Response.json(await routingStats({ projectId }));
  } catch (error) {
    return errorResponse(error);
  }
}
