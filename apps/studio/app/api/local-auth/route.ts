import { authConfig, isLoopbackHost, isSameOrigin } from '@/lib/server/auth';
import { errorResponse } from '@/lib/server/errors';
import { hasLocalToken, LOCAL_TOKEN_COOKIE } from '@/lib/server/local-token';

/**
 * 로컬 토큰을 쿠키로 바꾸는 교환(ADR-173 덧붙임). 토큰은 교환 페이지가 주소의 `#` 뒤에서 읽어 **본문으로** 옮겨 보낸다 —
 * 쿼리로 보내면 개발 서버 로그에 토큰이 그대로 남고, 그 로그는 같은 컴퓨터의 다른 사용자 계정도 읽을 수 있다.
 * 개인 PC 모드에서 이 컴퓨터 주소로 온 같은 출처 요청만 받는다(다른 출처는 proxy가 먼저 막고, 여기서도 확인한다).
 * 인증을 켠 서버(token·proxy)에는 이 경로가 아무 일도 하지 않는다(404). 토큰 값은 로그나 오류 글에 찍지 않는다
 */
export async function POST(request: Request): Promise<Response> {
  try {
    if (authConfig().mode !== 'none') return Response.json({ error: '없는 경로입니다' }, { status: 404 });
    if (!isLoopbackHost(request.headers)) {
      return Response.json({ error: '터미널 토큰은 이 컴퓨터의 주소(127.0.0.1 · localhost)로만 받습니다' }, { status: 403 });
    }
    if (!isSameOrigin(request.headers)) {
      return Response.json({ error: '다른 출처에서 보낸 요청은 받지 않습니다' }, { status: 403 });
    }
    const body = (await request.json().catch(() => undefined)) as { token?: unknown } | undefined;
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!hasLocalToken(token)) {
      return Response.json({ error: '터미널 토큰이 올바르지 않습니다. `pnpm studio launch`가 찍은 주소로 다시 여세요' }, { status: 403 });
    }
    // http라 Secure는 붙이지 않는다. 토큰은 hex라 쿠키 값으로 그대로 넣어도 안전하다
    return Response.json({ ok: true }, { headers: { 'set-cookie': `${LOCAL_TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict` } });
  } catch (error) {
    return errorResponse(error);
  }
}
