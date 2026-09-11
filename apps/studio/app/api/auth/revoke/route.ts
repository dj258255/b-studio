import { requireUser } from '@/lib/server/access';
import { authConfig } from '@/lib/server/auth';
import { revokeUser } from '@/lib/server/auth-state';
import { errorResponse, StudioError } from '@/lib/server/errors';

/**
 * 한 사람의 로그인을 모든 기기에서 무효로 한다. 쿠키가 새어 나갔을 때 서명 키를 바꾸지 않고 그 사람만 다시 로그인하게 한다.
 * 토큰 자체가 새어 나갔으면 토큰 목록에서 바꿔야 한다
 */
export async function POST(request: Request) {
  try {
    const actor = requireUser(request.headers);
    const config = authConfig();
    if (config.mode !== 'token') throw new StudioError(404, '로그인 무효화는 token 모드에서만 씁니다');
    if (!config.admins.has(actor)) throw new StudioError(403, '관리자만 로그인을 무효화할 수 있습니다');
    const body = (await request.json().catch(() => ({}))) as { user?: unknown };
    if (typeof body.user !== 'string' || !config.tokens.has(body.user)) throw new StudioError(400, '토큰 목록에 있는 사용자 이름을 넣으세요');
    const at = Date.now();
    await revokeUser(body.user, at);
    return Response.json({ user: body.user, revokedAt: new Date(at).toISOString() });
  } catch (error) {
    return errorResponse(error);
  }
}
