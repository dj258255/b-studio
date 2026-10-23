import { requireAccount, requireAccountsAccess } from '@/lib/server/ai-account-routes';
import { accountProcessEnv } from '@/lib/server/ai-accounts';
import { attachStatus, cancelLogin, checkAccountStatus, getLoginProgress, loginCommandFor, loginCommandText, startLogin } from '@/lib/server/cli-accounts';
import { errorResponse, StudioError } from '@/lib/server/errors';

type Context = RouteContext<'/api/ai-accounts/[id]/login'>;

/**
 * 계정 하나의 로그인을 시작한다(#885). 계정 연결(/api/accounts/{backend}/login)과 같은 흐름이고, 그 계정의 설정 폴더로 CLI를 띄워
 * CLI가 그 폴더에 로그인을 남긴다. 로그인은 계정마다 하나씩 돈다
 */
export async function POST(request: Request, context: Context) {
  try {
    requireAccountsAccess(request);
    const account = await requireAccount((await context.params).id);
    const spec = loginCommandFor(account.backend);
    if (!spec.spawnable) return Response.json({ spawnable: false, command: loginCommandText(account.backend), note: spec.note });
    const env = accountProcessEnv(account);
    return Response.json({ spawnable: true, progress: startLogin(account.backend, { key: account.id, ...(env ? { env } : {}) }) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 진행 상황. 끝났으면 한 번만 그 계정의 상태를 다시 확인해 붙인다 */
export async function GET(request: Request, context: Context) {
  try {
    requireAccountsAccess(request);
    const account = await requireAccount((await context.params).id);
    const progress = getLoginProgress(account.id);
    if (!progress) throw new StudioError(404, '시작한 로그인이 없습니다');
    if (progress.state !== 'running' && !progress.status) {
      const env = accountProcessEnv(account);
      attachStatus(progress, await checkAccountStatus(account.backend, {}, env ? { env } : {}));
    }
    return Response.json({ progress });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireAccountsAccess(request);
    const account = await requireAccount((await context.params).id);
    const progress = cancelLogin(account.id);
    if (!progress) throw new StudioError(404, '취소할 로그인이 없습니다');
    return Response.json({ progress });
  } catch (error) {
    return errorResponse(error);
  }
}
