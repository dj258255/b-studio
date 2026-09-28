import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { exportSession, parseIssueInput } from '@/lib/server/sessions';

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/export'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { pullRequest?: unknown; issue?: unknown };
    return Response.json(await exportSession(id, { pullRequest: body.pullRequest === true, issue: parseIssueInput(body.issue) }));
  } catch (error) {
    return errorResponse(error);
  }
}
