import { NextResponse, type NextRequest } from 'next/server';
import { decideRequest, PROXY_SECRET_HEADER, SESSION_COOKIE, USER_HEADER } from './lib/server/auth';

/**
 * 모든 화면과 API 앞에서 사용자를 확인한다. 라우트는 여기서 넣은 사용자 헤더로 한 번 더 확인하고 권한을 따진다.
 * 브라우저가 보낸 내부 헤더는 지우고, 확인한 사용자만 넣어 넘긴다
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const decision = decideRequest({
    method: request.method,
    pathname,
    search,
    headers: request.headers,
    cookie: request.cookies.get(SESSION_COOKIE)?.value,
  });

  if (decision.kind === 'redirect') return NextResponse.redirect(new URL(decision.location, request.url));
  if (decision.kind === 'reject') {
    return pathname.startsWith('/api/')
      ? NextResponse.json({ error: decision.message }, { status: decision.status })
      : new NextResponse(decision.message, { status: decision.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  const headers = new Headers(request.headers);
  headers.delete(USER_HEADER);
  headers.delete(PROXY_SECRET_HEADER);
  if (decision.kind === 'allow') headers.set(USER_HEADER, decision.user);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // 정적 파일과 개발 서버 연결(_next)은 사용자 데이터가 없어 확인하지 않는다
  matcher: ['/((?!_next/|favicon.ico).*)'],
};
