import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { lintSessionDocText } from '@/lib/server/sessions';

/**
 * "모호한 표현" 린트(ADR-0XX). 문서 탭 편집기와 "올리기" 미리보기(PR 본문)가 같은 엔드포인트를 쓴다 — 저장하지
 * 않고 본문만 검사하는 읽기 전용 계산이라 authorizeSession(쓰기 권한)까지는 요구하지 않는다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/docs/lint'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== 'string') throw new StudioError(400, 'text가 필요합니다');
    return Response.json({ findings: lintSessionDocText(id, body.text) });
  } catch (error) {
    return errorResponse(error);
  }
}
