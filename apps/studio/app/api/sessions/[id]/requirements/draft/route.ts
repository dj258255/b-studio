import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { discardSessionRequirementExtractionDraft } from '@/lib/server/sessions';

/**
 * 저장 안 한(아직 apply하지 않은) 추출 결과를 버린다("버리기" 버튼, ADR-0XX). 그 결과 자체는 요구사항
 * 스냅샷(`GET /api/sessions/[id]/requirements`)의 `draft` 필드로 이미 함께 내려가므로 따로 GET은 없다.
 */
export async function DELETE(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/draft'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    await discardSessionRequirementExtractionDraft(id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
