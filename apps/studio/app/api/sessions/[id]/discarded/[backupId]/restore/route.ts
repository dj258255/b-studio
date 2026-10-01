import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { restoreDiscardedBackup } from '@/lib/server/sessions';

/** 체크포인트로 되돌리며 버린 변경(ADR-0XX)의 백업을 작업 복사본에 되살린다. 결과는 세션 이벤트로 알린다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/discarded/[backupId]/restore'>) {
  try {
    const user = requireUser(request.headers);
    const { id, backupId } = await context.params;
    await authorizeSession(id, user);
    restoreDiscardedBackup(id, backupId);
    return Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
