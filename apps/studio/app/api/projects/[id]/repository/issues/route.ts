import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { projectRepositoryIssues } from '@/lib/server/repository-panel';
import { parseRepositoryListState } from '@/lib/server/repository-state';

/** 저장소 화면 이슈 탭. 보기는 로그인한 누구나 할 수 있다(ADR-040과 같은 기준, 이슈·PR을 바꾸지 않는다) */
export async function GET(request: Request, context: RouteContext<'/api/projects/[id]/repository/issues'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const url = new URL(request.url);
    const state = parseRepositoryListState(url.searchParams.get('state'));
    return Response.json(await projectRepositoryIssues(id, state));
  } catch (error) {
    return errorResponse(error);
  }
}
