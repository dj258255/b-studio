import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { endpointFor } from '@/lib/server/sessions';
import type { ProxyResponse } from '@/lib/studio-events';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY = 200_000;

/**
 * 응답 본문을 글자 상한(maxChars)까지만 읽는다(#815). 예전에는 text()로 끝까지 읽은 뒤 잘라, 서비스가 큰 응답을 보내면
 * studio 서버가 그만큼 메모리를 썼다. 넘으면 읽기를 멈추고 연결을 끊는다. UTF-8 한 글자는 4바이트를 넘지 않으므로 바이트는
 * 그 네 배까지만 받는다
 */
async function readCapped(response: Response, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), truncated: false };
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars || bytes > maxChars * 4) return { text: text.slice(0, maxChars), truncated: true };
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

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
    const { text, truncated } = await readCapped(response, MAX_BODY);

    const result: ProxyResponse = {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: text.slice(0, MAX_BODY),
      truncated: truncated || text.length > MAX_BODY,
      durationMs: Math.round(performance.now() - started),
    };
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
