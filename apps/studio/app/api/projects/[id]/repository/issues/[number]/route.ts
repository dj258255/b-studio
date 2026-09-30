import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { projectRepositoryIssue } from '@/lib/server/repository-panel';
import { parseRepositoryItemNumber } from '@/lib/server/repository-state';

/** 저장소 화면 이슈 상세(ADR-081). 보기는 로그인한 누구나 할 수 있다(목록 라우트와 같은 기준) */
export async function GET(request: Request, context: RouteContext<'/api/projects/[id]/repository/issues/[number]'>) {
  try {
    requireUser(request.headers);
    const { id, number } = await context.params;
    return Response.json(await projectRepositoryIssue(id, parseRepositoryItemNumber(number)));
  } catch (error) {
    return errorResponse(error);
  }
}
