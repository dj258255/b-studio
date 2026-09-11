import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { externalRequest } from '@/lib/server/sessions';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * API 탐색기 요청을 등록한 사내 API로 보낸다.
 * 스튜디오 서버가 직접 부르지 않고 edge 컨테이너 안에서 studio 호출자로 정책·인증·가림을 거친다.
 * 사내 API에 인증 헤더를 붙여 부르므로 세션을 바꿀 수 있는 사람만 보낼 수 있다
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/externals/[name]/request'>) {
  try {
    const user = requireUser(request.headers);
    const { id, name } = await context.params;
    await authorizeSession(id, user);
    const input = (await request.json().catch(() => ({}))) as { method?: unknown; path?: unknown; body?: unknown };

    const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
    if (!METHODS.has(method)) throw new StudioError(400, '지원하지 않는 메서드입니다');
    if (typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//')) {
      throw new StudioError(400, '경로는 "/"로 시작해야 합니다');
    }
    const body = typeof input.body === 'string' && method !== 'GET' && method !== 'HEAD' ? input.body : '';

    return Response.json(await externalRequest(id, name, { method, path: input.path, body }));
  } catch (error) {
    return errorResponse(error);
  }
}
