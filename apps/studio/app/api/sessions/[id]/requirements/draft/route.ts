import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { discardSessionRequirementExtractionDraft, updateSessionRequirementExtractionDraft } from '@/lib/server/sessions';

/**
 * 추출 결과를 지운다("지우기" 버튼, ADR-097 개정 — 확인 문구는 화면이 보여준다). 그 결과 자체는 요구사항
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

/**
 * 추출 결과를 부분적으로 고쳐 쓴다(자동 저장, ADR-097 개정). "추출 결과" 화면이 요구사항·가정·사람이 할 일을
 * 고치거나 질문에 답하거나 추천 값을 받으면 800ms 정지 뒤 이 라우트로 보낸다 — 저장 안 한 추출 결과가 아예
 * 없으면(지웠거나 한 번도 추출한 적 없음) 404.
 */
export async function PATCH(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/draft'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = await request.json().catch(() => undefined);
    return Response.json(await updateSessionRequirementExtractionDraft(id, body));
  } catch (error) {
    return errorResponse(error);
  }
}
