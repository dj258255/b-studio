import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { getSessionDesignPipeline } from '@/lib/server/design-pipeline-view';

/**
 * "요구사항" 탭의 "파이프라인" 하위 화면이 연다: 요구사항 → 설계 → 작업 묶음 → 구현 → 검토 → 검증 단계를
 * 설계 문서마다 모아 "완료"(구현이 끝났다)와 "성공"(독립 검토 + 검증 재실행 통과)을 따로 보여 준다
 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/design-pipeline'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json({ docs: await getSessionDesignPipeline(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
