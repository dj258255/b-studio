import { requireAccountsAccess } from '@/lib/server/ai-account-routes';
import { removeAiAccount, updateAiAccount } from '@/lib/server/ai-accounts';
import { errorResponse } from '@/lib/server/errors';

type Context = RouteContext<'/api/ai-accounts/[id]'>;

/** 이름·그림을 고친다(#885). 설정 폴더와 CLI는 바꾸지 않는다 */
export async function PATCH(request: Request, context: Context) {
  try {
    requireAccountsAccess(request);
    const body = await request.json().catch(() => undefined);
    return Response.json({ account: await updateAiAccount((await context.params).id, body) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 목록에서 뺀다. 설정 폴더(로그인 정보, 대화 기록)는 지우지 않는다 */
export async function DELETE(request: Request, context: Context) {
  try {
    requireAccountsAccess(request);
    await removeAiAccount((await context.params).id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
