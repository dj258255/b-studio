import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { endpointFor } from '@/lib/server/sessions';
import type { ProxyResponse } from '@/lib/studio-events';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY = 200_000;

/**
 * API 탐색기 요청을 샌드박스 서비스로 전달한다.
 * 서비스 포트는 루프백에만 열려 있으므로 브라우저가 직접 부르지 않고 스튜디오 서버를 거친다.
 * 서비스 데이터를 바꿀 수 있으므로 세션을 바꿀 수 있는 사람만 보낼 수 있다
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/services/[service]/request'>) {
  try {
    const user = requireUser(request.headers);
    const { id, service } = await context.params;
    await authorizeSession(id, user);
    const input = (await request.json().catch(() => ({}))) as { method?: unknown; path?: unknown; body?: unknown };

    const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
    if (!METHODS.has(method)) throw new StudioError(400, '지원하지 않는 메서드입니다');
    if (typeof input.path !== 'string' || !input.path.startsWith('/')) throw new StudioError(400, '경로는 "/"로 시작해야 합니다');
    const body = typeof input.body === 'string' ? input.body : '';

    const base = await endpointFor(id, service);
    const url = new URL(input.path, base);
    // "//other-host" 같은 경로로 서비스 밖에 요청하지 못하게 한다
    if (url.origin !== new URL(base).origin) throw new StudioError(400, '서비스 밖의 주소로는 요청할 수 없습니다');

    const started = performance.now();
    const response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body && method !== 'GET' ? body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();

    const result: ProxyResponse = {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: text.slice(0, MAX_BODY),
      truncated: text.length > MAX_BODY,
      durationMs: Math.round(performance.now() - started),
    };
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
