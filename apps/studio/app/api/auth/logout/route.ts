import { cookies } from 'next/headers';
import { authConfig, SESSION_COOKIE, sessionClaims } from '@/lib/server/auth';
import { readRevocations, revokeSession } from '@/lib/server/auth-state';
import { errorResponse } from '@/lib/server/errors';

/** 브라우저의 쿠키를 지우고, 서버에도 이 로그인 세션을 무효로 남긴다. 복사해 둔 쿠키로도 더는 들어오지 못한다 */
export async function POST() {
  try {
    const store = await cookies();
    const config = authConfig();
    if (config.mode === 'token') {
      const claims = sessionClaims(store.get(SESSION_COOKIE)?.value, config, Date.now(), readRevocations());
      if (claims) await revokeSession(claims);
    }
    store.delete(SESSION_COOKIE);
    return Response.json({ loggedOut: true });
  } catch (error) {
    return errorResponse(error);
  }
}
