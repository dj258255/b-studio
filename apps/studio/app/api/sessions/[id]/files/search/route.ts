import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { searchCodeFiles } from '@/lib/server/sessions';

/** 코드 화면의 내용 찾기. 파일 내용은 서버에서 훑고, 시크릿 값은 가려서 보낸다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/files/search'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const query = new URL(request.url).searchParams.get('q');
    if (!query) throw new StudioError(400, 'q가 필요합니다');
    return Response.json(await searchCodeFiles(id, query));
  } catch (error) {
    return errorResponse(error);
  }
}
