import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { ignoreRepeatedAction } from '@/lib/server/repeated-actions';

/** 되풀이 후보 하나를 무시 목록에 더한다(프로젝트별, 스튜디오 상태 폴더에만 남는다) */
export async function POST(request: Request, context: RouteContext<'/api/projects/[id]/repeated-actions/ignore'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { candidateId?: unknown };
    if (typeof body.candidateId !== 'string' || !body.candidateId) throw new StudioError(400, 'candidateId가 필요합니다');
    ignoreRepeatedAction(id, body.candidateId);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
