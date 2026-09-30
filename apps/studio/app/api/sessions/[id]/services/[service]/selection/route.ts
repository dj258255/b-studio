import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { setSessionServiceSelection } from '@/lib/server/sessions';

/**
 * 서비스 하나를 켜거나 끈다(ADR-083). 껐는데 지금 선택된 다른 서비스가 여기에 기대고 있으면 막지 않고
 * 응답의 warning에 경고 문구를 담아 돌려준다(끄는 것 자체는 허용한다)
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/services/[service]/selection'>) {
  try {
    const user = requireUser(request.headers);
    const { id, service } = await context.params;
    await authorizeSession(id, user);
    const input = (await request.json().catch(() => ({}))) as { on?: unknown };
    if (typeof input.on !== 'boolean') throw new StudioError(400, 'on(불리언)이 필요합니다');
    return Response.json(await setSessionServiceSelection(id, service, input.on));
  } catch (error) {
    return errorResponse(error);
  }
}
