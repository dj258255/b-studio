import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { applySessionRequirements } from '@/lib/server/sessions';

/**
 * 사람이 검토·수정한 요구사항 목록(+"## 가정" 절 초안, +"사람이 할 일" 절 초안)을 docs/requirements.md로 저장한다
 * (세션 작업 복사본 — 다음 체크포인트·PR에 실린다). 요청 본문은 `{ requirements: [...], assumptions?: [...], manualSteps?: [...] }`.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/apply'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = await request.json().catch(() => undefined);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioError(400, '{ requirements, assumptions?, manualSteps? } 형태가 필요합니다');
    return Response.json(await applySessionRequirements(id, body));
  } catch (error) {
    return errorResponse(error);
  }
}
