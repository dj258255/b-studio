import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { resolveSessionRequirementConflict } from '@/lib/server/sessions';

const RESOLUTIONS = new Set(['import', 'overwrite', 'ignore']);

/** 발행된 요구사항 하나의 충돌을 가져오기·덮어쓰기·무시 중 하나로 푼다(ADR-089). 본문은 `{ requirementId, resolution }` */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/publish/conflict'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => undefined)) as { requirementId?: unknown; resolution?: unknown } | undefined;
    const requirementId = typeof body?.requirementId === 'string' ? body.requirementId : undefined;
    const resolution = typeof body?.resolution === 'string' ? body.resolution : undefined;
    if (!requirementId || !resolution || !RESOLUTIONS.has(resolution)) {
      throw new StudioError(400, '{ requirementId, resolution: "import"|"overwrite"|"ignore" } 형태가 필요합니다');
    }
    return Response.json(await resolveSessionRequirementConflict(id, requirementId, resolution as 'import' | 'overwrite' | 'ignore'));
  } catch (error) {
    return errorResponse(error);
  }
}
