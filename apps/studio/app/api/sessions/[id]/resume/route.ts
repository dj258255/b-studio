import { errorResponse } from '@/lib/server/errors';
import { resumeSession } from '@/lib/server/sessions';

/** 중지된 세션을 같은 작업 복사본으로 새 샌드박스에서 띄운다. 기동 과정은 이벤트로 알린다 */
export async function POST(_request: Request, context: RouteContext<'/api/sessions/[id]/resume'>) {
  try {
    const { id } = await context.params;
    return Response.json(await resumeSession(id), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
