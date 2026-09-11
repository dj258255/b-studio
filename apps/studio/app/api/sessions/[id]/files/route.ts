import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { listCodeFiles } from '@/lib/server/sessions';

const MAX_PAGE = 1_000;

/** 코드 화면의 파일 목록과 마지막 체크포인트 이후 바뀐 파일. 경로로 좁히고 쪽 단위로 받는다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/files'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const number = (name: string, fallback: number) => {
      const value = Number(params.get(name));
      return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    };
    return Response.json(await listCodeFiles(id, { query: params.get('query') ?? '', offset: number('offset', 0), limit: Math.min(number('limit', 500) || 500, MAX_PAGE) }));
  } catch (error) {
    return errorResponse(error);
  }
}
