import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { steerRun } from '@/lib/server/sessions';

const bodySchema = z.object({ text: z.string().min(1).max(2_000) });

/** 실행 중인 요청에 진행 중 지시를 넣는다. 다음 모델 호출(또는 다음 턴)에 대화로 들어간다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/steer'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'text는 1~2,000자여야 합니다');
    return Response.json(steerRun(id, parsed.data.text), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
