import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { projectRepeatedActions } from '@/lib/server/repeated-actions';

/**
 * 프로젝트의 되풀이 행동 후보(ADR-077). 최근 세션 기록만 훑고 아무것도 바꾸지 않는다.
 * 보기는 로그인한 누구나 할 수 있다(token-report 라우트와 같은 규칙, ADR-040).
 */
export async function GET(request: Request, context: RouteContext<'/api/projects/[id]/repeated-actions'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const report = await projectRepeatedActions(id);
    return Response.json({ report });
  } catch (error) {
    return errorResponse(error);
  }
}
