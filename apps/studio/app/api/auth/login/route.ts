import { cookies } from 'next/headers';
import { setTimeout as sleep } from 'node:timers/promises';
import { authConfig, SESSION_COOKIE, signSession, verifyLogin } from '@/lib/server/auth';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { LoginThrottle } from '@/lib/server/login-throttle';

// 개발 서버의 HMR로 모듈이 다시 불러와져도 실패 기록을 잃지 않게 전역에 둔다
const globalThrottle = globalThis as typeof globalThis & { __bStudioLoginThrottle?: LoginThrottle };
const throttle = (globalThrottle.__bStudioLoginThrottle ??= new LoginThrottle());

/**
 * 이름과 접근 토큰을 확인하고, 새 세션 ID를 넣어 서명한 세션 쿠키를 준다.
 * 쿠키는 스크립트가 읽지 못하고 다른 사이트의 요청에는 실리지 않는다
 */
export async function POST(request: Request) {
  try {
    const config = authConfig();
    if (config.mode !== 'token') throw new StudioError(404, '이 스튜디오는 토큰으로 로그인하지 않습니다');
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; token?: unknown };
    if (typeof body.name !== 'string' || typeof body.token !== 'string' || !body.name || !body.token) throw new StudioError(400, '이름과 접근 토큰을 입력하세요');

    const now = Date.now();
    // 토큰 목록에 없는 이름은 한 묶음으로 센다. 없는 이름을 대량으로 보내도 기록이 늘지 않고, 실제 계정의 기록을 밀어내지 못한다
    const key = config.tokens.has(body.name) ? body.name : '';
    // 잠긴 동안에는 토큰을 확인하지 않아, 잠금 중의 시도로 토큰을 알아내지 못하게 한다
    const gate = throttle.check(key, now);
    if (!gate.allowed) {
      const seconds = Math.ceil(gate.retryAfterMs / 1_000);
      return Response.json({ error: `로그인에 여러 번 실패해 ${seconds}초 동안 막았습니다. 잠시 뒤 다시 시도하세요` }, { status: 429, headers: { 'retry-after': String(seconds) } });
    }
    const user = verifyLogin(config, body.name, body.token);
    if (!user) {
      throttle.fail(key, now);
      // 틀리면 늦게 답해 한 계정에 잠금 전까지 보낼 수 있는 시도도 느리게 한다
      await sleep(500);
      throw new StudioError(401, '이름이나 접근 토큰이 맞지 않습니다');
    }
    throttle.succeed(key);

    const secure = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
    (await cookies()).set({
      name: SESSION_COOKIE,
      value: signSession(user, config.secret, now, config.sessionHours),
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
