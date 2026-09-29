import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { recordHandoff } from '@/lib/server/sessions';

const bodySchema = z.object({ runId: z.string().min(1), to: z.enum(['split', 'fleet']), href: z.string().min(1).max(200) });

/** 에이전트의 제안을 받아 요청을 다른 방식으로 넘겼다고 남기고 질문 카드를 치운다(ADR-068) */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/handoff'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'runId·to(split|fleet)·href가 필요합니다');
    return Response.json(recordHandoff(id, parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
