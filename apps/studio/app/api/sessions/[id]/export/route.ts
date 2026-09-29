import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { exportSession, parseIssueList } from '@/lib/server/sessions';
import { integrationIssues } from '@/lib/server/task-plans';

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/export'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { pullRequest?: unknown; issue?: unknown; issues?: unknown };
    // 이슈 입력이 없으면 통합 세션이면 그 계획의 하위 이슈를 기본값으로 쓴다
    const issues = parseIssueList(body) ?? integrationIssues(id);
    return Response.json(await exportSession(id, { pullRequest: body.pullRequest === true, issues }));
  } catch (error) {
    return errorResponse(error);
  }
}
