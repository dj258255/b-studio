import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { localPreviewUrl, recoverSessions } from '@/lib/server/sessions';

/**
 * 화면 미리보기 iframe이 열 로컬 프록시 주소(ADR-113). 세션은 로그인한 누구나 볼 수 있으므로
 * 미리보기(와 그 프록시)도 로그인한 누구에게나 준다(preview-access 라우트와 같은 규칙)
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/services/[service]/preview-proxy'>) {
  try {
    requireUser(request.headers);
    const { id, service } = await context.params;
    await recoverSessions();
    const url = await localPreviewUrl(id, service);
    return Response.json({ url });
  } catch (error) {
    return errorResponse(error);
  }
}
