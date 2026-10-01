import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { regenerateSessionDocsIndex } from '@/lib/server/sessions';

/** "색인 갱신": docs/README.md의 관리 구간만 문서들의 첫 H1·첫 문단으로 다시 만든다(그 밖의 손으로 쓴 글은 그대로 둔다) */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/docs/reindex'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await regenerateSessionDocsIndex(id));
  } catch (error) {
    return errorResponse(error);
  }
}
