import { cookies } from 'next/headers';
import { setTimeout as sleep } from 'node:timers/promises';
import { authConfig, SESSION_COOKIE, signSession, userForToken } from '@/lib/server/auth';
import { errorResponse, StudioError } from '@/lib/server/errors';

/** 접근 토큰을 확인하고 서명한 세션 쿠키를 준다. 쿠키는 스크립트가 읽지 못하고 다른 사이트의 요청에는 실리지 않는다 */
export async function POST(request: Request) {
  try {
    const config = authConfig();
    if (config.mode !== 'token') throw new StudioError(404, '이 스튜디오는 토큰으로 로그인하지 않습니다');
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };
    const user = typeof body.token === 'string' ? userForToken(config, body.token) : undefined;
    if (!user) {
      // 토큰을 빠르게 대입해 보지 못하게 틀리면 늦게 답한다
      await sleep(500);
      throw new StudioError(401, '토큰이 맞지 않습니다');
    }
    const secure = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
    (await cookies()).set({
      name: SESSION_COOKIE,
      value: signSession(user, config.secret, Date.now(), config.sessionHours),
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: Math.round(config.sessionHours * 3600),
    });
    return Response.json({ user });
  } catch (error) {
    return errorResponse(error);
  }
}
