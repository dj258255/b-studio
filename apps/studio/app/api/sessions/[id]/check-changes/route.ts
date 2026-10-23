import { authorizeSession } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { setTerminalCheckChanges } from '@/lib/server/sessions';
import { assertTerminalAccess } from '@/lib/server/terminal-access';

/**
 * 터미널 세션의 다음 요청 하나에서 확인 선언의 변경을 받아들일지 켜고 끈다(#916, ADR-164). 대화 창 입력의 "확인 선언 변경 허용"과 같은 뜻이다.
 * 에이전트가 켤 방법이 없어야 하므로 터미널 통로와 같은 검사(이 컴퓨터 주소, launch가 만든 로컬 토큰)를 거친다 — 같은 컴퓨터에서 도는 CLI가
 * 스튜디오 포트로 직접 보내는 요청은 로컬 토큰이 없다
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/check-changes'>) {
  try {
    const user = await assertTerminalAccess(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { allow?: unknown };
    if (typeof body.allow !== 'boolean') throw new StudioError(400, 'allow는 true나 false여야 합니다');
    return Response.json({ armed: setTerminalCheckChanges(id, body.allow) });
  } catch (error) {
    return errorResponse(error);
  }
}
