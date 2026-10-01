import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { resolveReviewFinding } from '@/lib/server/sessions';

/**
 * AI 리뷰 라운드의 지적 하나를 사람이 오탐으로 닫는다(과제 67-b). 화면의 "오탐으로 닫기"가 이유를 받아 부른다.
 * 리뷰어는 diff만 보고 실제 코드·데이터베이스 상태를 보지 못해 틀린 지적을 라운드마다 되풀이할 수 있다 —
 * 이 결정은 세션 리뷰 상태에 남고, 막는 지적을 모두 닫으면 그 라운드를 더는 막는 것으로 보지 않는다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/review/resolve'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { round?: unknown; findingIndex?: unknown; reason?: unknown };
    if (typeof body.round !== 'number' || typeof body.findingIndex !== 'number' || typeof body.reason !== 'string') {
      throw new StudioError(400, 'round·findingIndex·reason을 모두 보내세요');
    }
    const snapshot = await resolveReviewFinding(id, { round: body.round, findingIndex: body.findingIndex, reason: body.reason, by: user });
    return Response.json({ review: snapshot.review });
  } catch (error) {
    return errorResponse(error);
  }
}
