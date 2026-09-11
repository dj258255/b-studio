import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { readCodeFile } from '@/lib/server/sessions';

/** 코드 화면에서 연 파일의 내용과 변경 내용. 경로는 프로젝트 루트 기준이고 작업 공간 규칙으로 검사한다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/files/content'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const file = new URL(request.url).searchParams.get('path');
    if (!file) throw new StudioError(400, 'path가 필요합니다');
    return Response.json(await readCodeFile(id, file));
  } catch (error) {
    return errorResponse(error);
  }
}
