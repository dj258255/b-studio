import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { approveSessionDesignDoc } from '@/lib/server/design-pipeline';

const bodySchema = z.object({ path: z.string().min(1) });

/**
 * 사람이 설계를 승인한다("초안" → "승인됨"). 승인되기 전까지는 assertDesignApprovedForRequest가
 * 이 설계가 다루는 요구사항의 구현(메시지·작업 분해)을 409로 막는다 — 이 라우트가 그 상태를 바꾸는 유일한 자리다
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/design-docs/approve'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, '{ path } 형태가 필요합니다');
    return Response.json(await approveSessionDesignDoc(id, parsed.data.path, user));
  } catch (error) {
    return errorResponse(error);
  }
}
