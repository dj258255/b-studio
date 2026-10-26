import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { localFolderAllowed } from '@/lib/server/repo-token';
import { spendStore, summarizeSpend } from '@/lib/server/spend-state';
import { tokenPricing } from '@/lib/server/token-report';

/**
 * 오늘과 최근 7일 동안 CLI·모델별로 쓴 토큰과 비용(#925). 터미널 작업대의 사용량 화면이 쓴다.
 * 이 컴퓨터에서 돌린 모든 세션의 합이라 사용량 한도와 같이 개인 PC 모드에서만 연다
 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '쓴 양은 개인 PC 모드(로컬 CLI)에서만 봅니다');
    return Response.json(summarizeSpend(spendStore().read(), Date.now(), tokenPricing(process.env)));
  } catch (error) {
    return errorResponse(error);
  }
}
