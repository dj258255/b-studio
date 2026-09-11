import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { userUsage } from '@/lib/server/usage-state';
import { parseUsageWindow, parseUserTokenLimit, periodKey, totalTokens } from '@/lib/usage';

/**
 * 부른 사람 자신의 모델 토큰 사용량과 한도. 세션 스냅샷은 세션을 보는 모든 사람에게 전해지므로,
 * 개인 사용량은 거기에 담지 않고 이 경로로만 돌려준다
 */
export async function GET(request: Request) {
  try {
    const user = requireUser(request.headers);
    const window = parseUsageWindow(process.env.B_STUDIO_USER_TOKEN_WINDOW);
    const limit = parseUserTokenLimit(process.env.B_STUDIO_USER_TOKEN_LIMIT);
    const usage = userUsage(user, window);
    return Response.json({ user, window, period: periodKey(window), tokens: usage, used: totalTokens(usage), limit });
  } catch (error) {
    return errorResponse(error);
  }
}
