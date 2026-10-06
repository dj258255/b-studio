import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { fetchHostLog, requireSameOrigin } from '@/lib/server/my-env';

/** 호스트에서 직접 뜬 프로세스의 Actuator logfile을 다시 읽는다(화면의 "더 보기"). 127.0.0.1의 선언된 포트로만 나간다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/my-env/host-log'>) {
  try {
    requireSameOrigin(request.headers);
    requireUser(request.headers);
    const { id } = await context.params;
    const portText = new URL(request.url).searchParams.get('port');
    const port = Number.parseInt(portText ?? '', 10);
    if (!Number.isFinite(port)) throw new StudioError(400, 'port 쿼리 파라미터가 필요합니다');
    return Response.json(await fetchHostLog(id, port));
  } catch (error) {
    return errorResponse(error);
  }
}
