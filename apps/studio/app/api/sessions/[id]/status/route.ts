import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { getSessionStatus } from '@/lib/server/sessions';

/** "현황" 탭: 세션·요구사항·체크포인트를 읽기만 해 한 화면으로 모은다(쓰기 없음) */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/status'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    return Response.json(await getSessionStatus(id));
  } catch (error) {
    return errorResponse(error);
  }
}
