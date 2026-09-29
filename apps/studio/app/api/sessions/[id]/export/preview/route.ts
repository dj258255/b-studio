import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { parseIssueInput, previewExport } from '@/lib/server/sessions';

/** 올리기 전 미리보기. PR 생성은 사람이 확인한 뒤 결정하므로, 여기서는 아무것도 올리지 않는다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/export/preview'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { issue?: unknown };
    return Response.json(await previewExport(id, { issue: parseIssueInput(body.issue) }));
  } catch (error) {
    return errorResponse(error);
  }
}
