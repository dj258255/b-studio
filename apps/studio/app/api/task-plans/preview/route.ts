import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { previewTaskCards } from '@/lib/server/task-plans';

/**
 * 사람이 쓴 작업 카드를 레인으로만 묶어 보여 준다(#B6b). 계획도 세션도 만들지 않는다.
 * 본문은 `{ projectId, cards }`다. 검사(로그인·터미널·프로젝트·카드 형식)는 previewTaskCards가 한다
 */
export async function POST(request: Request) {
  try {
    requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; cards?: unknown };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    return Response.json(await previewTaskCards(body.projectId, body.cards));
  } catch (error) {
    return errorResponse(error);
  }
}
