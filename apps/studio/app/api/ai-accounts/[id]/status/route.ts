import { requireAccount, requireAccountsAccess } from '@/lib/server/ai-account-routes';
import { accountProcessEnv } from '@/lib/server/ai-accounts';
import { checkAccountStatus } from '@/lib/server/cli-accounts';
import { errorResponse } from '@/lib/server/errors';

/** 계정 하나의 로그인 상태(#885). 그 계정의 설정 폴더로 각 CLI의 상태 확인 명령만 부른다(토큰 파일은 읽지 않는다) */
export async function GET(request: Request, context: RouteContext<'/api/ai-accounts/[id]/status'>) {
  try {
    requireAccountsAccess(request);
    const account = await requireAccount((await context.params).id);
    const env = accountProcessEnv(account);
    return Response.json({ status: await checkAccountStatus(account.backend, {}, env ? { env } : {}) });
  } catch (error) {
    return errorResponse(error);
  }
}
