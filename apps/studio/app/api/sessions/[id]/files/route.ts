import { errorResponse } from '@/lib/server/errors';
import { listCodeFiles } from '@/lib/server/sessions';

/** 코드 화면의 파일 목록과 마지막 체크포인트 이후 바뀐 파일 */
export async function GET(_request: Request, context: RouteContext<'/api/sessions/[id]/files'>) {
  try {
    const { id } = await context.params;
    return Response.json(await listCodeFiles(id));
  } catch (error) {
    return errorResponse(error);
  }
}
