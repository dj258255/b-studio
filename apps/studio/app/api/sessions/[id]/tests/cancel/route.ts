import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { cancelSessionTests } from '@/lib/server/sessions';

const bodySchema = z.object({ service: z.string().min(1) });

/** 도는 중인 테스트를 취소한다. 실행 중이 아니면 404 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/tests/cancel'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'service가 필요합니다');
    cancelSessionTests(id, parsed.data.service);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
