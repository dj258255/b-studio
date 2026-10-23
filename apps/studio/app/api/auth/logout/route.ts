import { authConfig, SESSION_COOKIE, sessionClaims } from '@/lib/server/auth';
import { readRevocations, revokeSession } from '@/lib/server/auth-state';
import { clearCookie, cookieValue } from '@/lib/server/cookies';
import { errorResponse } from '@/lib/server/errors';

/** 브라우저의 쿠키를 지우고, 서버에도 이 로그인 세션을 무효로 남긴다. 복사해 둔 쿠키로도 더는 들어오지 못한다 */
export async function POST(request: Request) {
  try {
    const config = authConfig();
    if (config.mode === 'token') {
      const claims = sessionClaims(cookieValue(request.headers, SESSION_COOKIE), config, Date.now(), readRevocations());
      if (claims) await revokeSession(claims);
    }
    return Response.json({ loggedOut: true }, { headers: { 'set-cookie': clearCookie(SESSION_COOKIE) } });
  } catch (error) {
    return errorResponse(error);
  }
}
