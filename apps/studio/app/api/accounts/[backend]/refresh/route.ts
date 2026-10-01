import { checkAccountStatus, isCliAccountBackend } from '@/lib/server/cli-accounts';
import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { localFolderAllowed } from '@/lib/server/sessions';

/** 로그인 뒤(또는 터미널에서 직접 로그인한 뒤) "다시 확인"을 누르면 preflight를 한 번 더 부른다 */
export async function POST(request: Request, context: RouteContext<'/api/accounts/[backend]/refresh'>) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '계정 연결은 개인 PC 모드(로컬 CLI)에서만 씁니다');
    const { backend } = await context.params;
    if (!isCliAccountBackend(backend)) throw new StudioError(400, `알 수 없는 백엔드입니다: ${backend}`);
    return Response.json({ status: await checkAccountStatus(backend) });
  } catch (error) {
    return errorResponse(error);
  }
}
