import { errorResponse } from '@/lib/server/errors';
import { cancelRun } from '@/lib/server/sessions';

/** 되돌리기와 서비스 재시작은 오래 걸리므로 바로 돌아가고 결과는 이벤트로 알린다 */
export async function POST(_request: Request, context: RouteContext<'/api/sessions/[id]/runs/[runId]/cancel'>) {
  try {
    const { id, runId } = await context.params;
    cancelRun(id, runId);
    return Response.json({ runId }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
