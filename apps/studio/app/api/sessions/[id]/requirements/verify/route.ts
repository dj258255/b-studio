import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { clearRequirementManualVerification, markRequirementManualVerification } from '@/lib/server/sessions';

const bodySchema = z.object({ requirementId: z.string().min(1), note: z.string().min(1).max(500) });
const clearBodySchema = z.object({ requirementId: z.string().min(1) });

/**
 * "직접 확인함"(owner/admin만, ADR-0XX). 테스트·게이트가 돌지 않는 요구사항도 사람이 직접 보고 확인했다는 사실을
 * "누가·언제·어느 체크포인트·무엇을 어떻게"로 docs/requirements.md에 남긴다. 요청 본문은 `{ requirementId, note }`.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/verify'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, '{ requirementId, note } 형태가 필요합니다(note는 무엇을 어떻게 확인했는지 적습니다)');
    return Response.json(await markRequirementManualVerification(id, parsed.data.requirementId, { note: parsed.data.note }, user));
  } catch (error) {
    return errorResponse(error);
  }
}

/** "확인 취소". 요청 본문은 `{ requirementId }`. */
export async function DELETE(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/verify'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = clearBodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, '{ requirementId } 형태가 필요합니다');
    return Response.json(await clearRequirementManualVerification(id, parsed.data.requirementId));
  } catch (error) {
    return errorResponse(error);
  }
}
