import { cookies } from 'next/headers';
import { requireUser } from '@/lib/server/access';
import { authConfig, SESSION_COOKIE, sessionClaims } from '@/lib/server/auth';
import { readRevocations } from '@/lib/server/auth-state';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { previewAccessUrl, recoverSessions } from '@/lib/server/sessions';

/** 미리보기 iframe이 열 주소. 세션은 로그인한 누구나 볼 수 있으므로 미리보기도 로그인한 누구에게나 준다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/preview-access'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    const body = (await request.json().catch(() => ({}))) as { service?: unknown; path?: unknown };
    if (typeof body.service !== 'string') throw new StudioError(400, '서비스 이름이 필요합니다');
    const config = authConfig();
    // 티켓을 이 로그인 세션에 묶어, 로그아웃하면 미리보기 쿠키도 함께 거부되게 한다
    const claims = config.mode === 'token' ? sessionClaims((await cookies()).get(SESSION_COOKIE)?.value, config, Date.now(), readRevocations()) : undefined;
    if (config.mode === 'token' && !claims) throw new StudioError(401, '로그인이 필요합니다');
    const url = previewAccessUrl(id, body.service, typeof body.path === 'string' ? body.path : '/', { user, sid: claims?.sid, sessionExpiresAt: claims?.expiresAt });
    return Response.json({ url });
  } catch (error) {
    return errorResponse(error);
  }
}
