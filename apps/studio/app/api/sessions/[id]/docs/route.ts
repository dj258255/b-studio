import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { listSessionDocs } from '@/lib/server/sessions';

/** "문서" 탭의 파일 목록(docs/**\/*.md·README.md·CHANGELOG.md·CONTRIBUTING.md). 각 파일의 첫 H1을 제목으로 보여 준다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/docs'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    return Response.json(await listSessionDocs(id));
  } catch (error) {
    return errorResponse(error);
  }
}
