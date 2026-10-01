import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { syncSessionRequirementIssueStatus } from '@/lib/server/sessions';

/** 발행된 하위 이슈의 상태(고정 댓글·라벨)를 지금 증거로 다시 맞춘다(ADR-092). 체크포인트마다 자동으로도 불리지만, 사람이 바로 확인하고 싶을 때 쓴다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/publish/sync'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await syncSessionRequirementIssueStatus(id));
  } catch (error) {
    return errorResponse(error);
  }
}
