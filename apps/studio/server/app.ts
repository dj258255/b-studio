import type { IncomingMessage, ServerResponse } from 'node:http';
import { decideRequest, PROXY_SECRET_HEADER, SESSION_COOKIE, USER_HEADER } from '@/lib/server/auth';
import { readRevocations } from '@/lib/server/auth-state';
import { cookieValue } from '@/lib/server/cookies';
import { BodyTooLargeError, toWebRequest, writeWebResponse } from './http';
import { compileRoutes, matchRoute, type RouteEntry, type RouteModule } from './router';

/**
 * 스튜디오 서버의 요청 처리. 순서:
 * 1) 인증 판단(decideRequest)과 사용자 헤더 넣기 → 2) 라우트 맞추기 → 3) 메서드 핸들러에 Request와 { params } 넘기기.
 * 화면은 터미널(studio desk)이라 페이지를 그리지 않는다. 첫 화면(`/`)은 b-studio 표지가 든 짧은 안내만 준다
 */

/** 요청 본문 한도 10MB(예전 Next 앞단과 같은 값). 넘으면 413 */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

type Handler = (request: Request, context: { params: Promise<Record<string, string | string[]>> }) => Response | Promise<Response>;

export interface StudioHandlerOptions {
  routes: readonly RouteEntry[];
  /** 인증 판단에 쓰는 환경. 라우트 자신은 process.env를 읽는다 */
  env?: Record<string, string | undefined>;
  maxBodyBytes?: number;
  now?: () => number;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function allowedMethods(module: RouteModule): string[] {
  const allowed = new Set<string>();
  for (const method of METHODS) if (typeof module[method] === 'function') allowed.add(method);
  if (allowed.has('GET')) allowed.add('HEAD');
  allowed.add('OPTIONS');
  return [...allowed].sort();
}

function pickHandler(module: RouteModule, method: string): Handler | undefined {
  const direct = module[method];
  if (typeof direct === 'function') return direct as Handler;
  if (method === 'HEAD' && typeof module.GET === 'function') return module.GET as Handler;
  return undefined;
}

export function createStudioHandler(options: StudioHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = compileRoutes(options.routes);
  const modules = new Map<string, Promise<RouteModule>>();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;

  const loadModule = (route: RouteEntry): Promise<RouteModule> => {
    let loaded = modules.get(route.pattern);
    if (!loaded) {
      loaded = route.load();
      // 불러오기가 실패하면 다음 요청에서 다시 해 본다
      loaded.catch(() => modules.delete(route.pattern));
      modules.set(route.pattern, loaded);
    }
    return loaded;
  };

  const respond = async (req: IncomingMessage, signal: AbortSignal): Promise<Response> => {
    let request: Request;
    try {
      request = await toWebRequest(req, { maxBodyBytes, signal });
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json(413, { error: '요청 본문이 너무 큽니다' });
      throw error;
    }
    const url = new URL(request.url);

    // 1. 인증
    const decision = decideRequest(
      { method: request.method, pathname: url.pathname, search: url.search, headers: request.headers, cookie: cookieValue(request.headers, SESSION_COOKIE) },
      env,
      now(),
      () => readRevocations(),
    );
    if (decision.kind === 'reject') {
      return url.pathname.startsWith('/api/')
        ? json(decision.status, { error: decision.message })
        : new Response(decision.message, { status: decision.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    // 손님이 보낸 내부 헤더는 지우고, 확인한 사용자만 넣는다(서버 쪽 Request의 헤더는 고칠 수 있다)
    request.headers.delete(USER_HEADER);
    request.headers.delete(PROXY_SECRET_HEADER);
    if (decision.kind === 'allow') request.headers.set(USER_HEADER, decision.user);

    // 2. 라우트
    const match = matchRoute(routes, url.pathname);
    if (!match) {
      if (url.pathname === '/') return json(200, { app: 'b-studio', message: '화면은 터미널 작업대입니다. pnpm studio로 여세요' });
      return json(404, { error: '없는 경로입니다' });
    }
    const routeModule = await loadModule(match.route);
    const method = request.method.toUpperCase();
    const handler = pickHandler(routeModule, method);
    if (!handler) {
      const allow = allowedMethods(routeModule).join(', ');
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow } });
      return json(405, { error: '이 경로는 그 메서드를 받지 않습니다' }, { allow });
    }

    // 3. 핸들러. params는 Promise로 넘긴다(라우트의 RouteContext 타입, route-context.d.ts)
    return await handler(request, { params: Promise.resolve(match.params) });
  };

  return async (req, res) => {
    const controller = new AbortController();
    // 응답을 다 쓰기 전에 연결이 닫히면 손님이 끊은 것이다
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    let response: Response;
    try {
      response = await respond(req, controller.signal);
    } catch (error) {
      console.error('[b-studio] 요청을 처리하지 못했습니다:', req.method, req.url?.split('?')[0], error instanceof Error ? (error.stack ?? error.message) : String(error));
      response = json(500, { error: '서버 안에서 오류가 났습니다' });
    }
    if (res.destroyed) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    await writeWebResponse(req, res, response);
  };
}
