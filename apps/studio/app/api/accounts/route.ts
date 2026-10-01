import { requireUser } from '@/lib/server/access';
import { listAccountStatuses } from '@/lib/server/cli-accounts';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { localFolderAllowed } from '@/lib/server/sessions';

/**
 * 구독 CLI 계정 연결 상태(ADR-093). 내 폴더에서 바로 작업하기와 같은 이유로, 이 서버의 CLI를 그대로 쓰는 개인 PC
 * 모드(B_STUDIO_AUTH=none)에서만 연다 — 여러 사람이 쓰는 서버에서는 "이 서버의 CLI 로그인"이라는 개념 자체가 안전하지 않다.
 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '계정 연결은 개인 PC 모드(로컬 CLI)에서만 씁니다');
    return Response.json({ accounts: await listAccountStatuses() });
  } catch (error) {
    return errorResponse(error);
  }
}
