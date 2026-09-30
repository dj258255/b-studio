import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { exportSession, parseIssueList } from '@/lib/server/sessions';
import { integrationIssues } from '@/lib/server/task-plans';

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/export'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { pullRequest?: unknown; issue?: unknown; issues?: unknown; review?: unknown };
    // 이슈 입력이 없으면 통합 세션이면 그 계획의 하위 이슈를 기본값으로 쓴다
    const issues = parseIssueList(body) ?? integrationIssues(id);
    // review를 안 보내면(체크박스가 없던 예전 화면 등) studio.yaml의 기본값을 그대로 따른다(ADR-074)
    const review = typeof body.review === 'boolean' ? body.review : undefined;
    return Response.json(await exportSession(id, { pullRequest: body.pullRequest === true, issues, review }));
  } catch (error) {
    return errorResponse(error);
  }
}
