import { requireUser } from '@/lib/server/access';
import { readBackendRules, saveBackendRules } from '@/lib/server/backend-rules';
import { errorResponse } from '@/lib/server/errors';
import { allowedBackends, resolveSessionBackend } from '@/lib/server/sessions';

/**
 * 내가 정한 규칙(#822). GET은 저장한 규칙과 고를 수 있는 백엔드를, PUT은 규칙 전체를 바꾼다.
 * 규칙은 이 스튜디오 하나에 하나다(혼자 쓰는 도구로 만든다, #820).
 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    const { rules, error } = readBackendRules();
    return Response.json({ rules, ...(error ? { error } : {}), allowed: [...allowedBackends()], defaultBackend: resolveSessionBackend(undefined) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireUser(request.headers);
    const body: unknown = await request.json().catch(() => undefined);
    return Response.json({ rules: saveBackendRules(body) });
  } catch (error) {
    return errorResponse(error);
  }
}
