import { errorResponse } from '@/lib/server/errors';
import { syncRemote } from '@/lib/server/sessions';

/** 원격 세션 브랜치에 다른 사람이 올린 커밋을 가져온다. 검증까지 오래 걸리므로 결과는 이벤트로 알린다 */
export async function POST(_request: Request, context: RouteContext<'/api/sessions/[id]/sync'>) {
  try {
    const { id } = await context.params;
    syncRemote(id);
    return Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
