import { allowedAccountBackends, requireAccountsAccess } from '@/lib/server/ai-account-routes';
import { addAiAccount, listAiAccounts } from '@/lib/server/ai-accounts';
import { errorResponse, StudioError } from '@/lib/server/errors';

/**
 * 여러 AI 계정(#885). 허용한 CLI마다 기본 계정과 더한 계정을 돌려준다. 로그인 상태는 CLI를 띄워야 해서 느리므로
 * 계정마다 `/api/ai-accounts/{id}/status`로 따로 묻는다
 */
export async function GET(request: Request) {
  try {
    requireAccountsAccess(request);
    return Response.json({ accounts: await listAiAccounts(process.env, allowedAccountBackends()) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 계정을 더한다: { name, backend, configDir, sprite? }. 설정 폴더는 만들지 않는다(로그인할 때 CLI가 만든다) */
export async function POST(request: Request) {
  try {
    requireAccountsAccess(request);
    const body = (await request.json().catch(() => undefined)) as { backend?: unknown } | undefined;
    if (body && typeof body.backend === 'string' && !(allowedAccountBackends() as string[]).includes(body.backend)) {
      throw new StudioError(400, `이 스튜디오가 허용하지 않는 CLI입니다(B_STUDIO_BACKENDS): ${body.backend}`);
    }
    return Response.json({ account: await addAiAccount(body) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
