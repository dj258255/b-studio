import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { localFolderAllowed } from '@/lib/server/repo-token';
import { DEFAULT_LIMIT_ACCOUNTS, usageLimits } from '@/lib/server/usage-limits';

/**
 * 계정마다 구독 한도(5시간·주간)와 상태, 추천 계정(ADR-187). 이 컴퓨터의 CLI 로그인 정보를 읽으므로 계정 연결과 같이
 * 개인 PC 모드에서만 연다. `?refresh=1`은 다시 읽기를 청하지만 계정마다 최소 간격(Claude 10분, Codex 1분)은 지킨다
 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '구독 한도는 개인 PC 모드(로컬 CLI)에서만 봅니다');
    const refresh = new URL(request.url).searchParams.get('refresh') === '1';
    return Response.json({ accounts: await usageLimits().read(DEFAULT_LIMIT_ACCOUNTS, { refresh }) });
  } catch (error) {
    return errorResponse(error);
  }
}
