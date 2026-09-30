import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { recoverSessions, sessionModelPicker, setSessionModel } from '@/lib/server/sessions';

const bodySchema = z.object({ modelId: z.string().max(200).optional() });

/** 이 세션 백엔드에서 고를 수 있는 모델 목록과 지금 고른 값 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/model'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    return Response.json(await sessionModelPicker(id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 대화 입력창에서 모델을 바꾼다. 다음 요청부터 적용된다. modelId를 비우면 "기본"으로 되돌린다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/model'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new StudioError(400, 'modelId는 문자열이어야 합니다');
    return Response.json(await setSessionModel(id, parsed.data.modelId));
  } catch (error) {
    return errorResponse(error);
  }
}
