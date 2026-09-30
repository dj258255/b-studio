import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { importRequirementDraftFromIssue } from '@/lib/server/sessions';

/** 저장소 이슈 하나를 요구사항 초안으로 가져온다(ADR-089, "이슈에서 가져오기"). docs/requirements.md에는 쓰지 않는다 — 화면이 "적용"으로 반영한다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/import-issue'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => undefined)) as { issueNumber?: unknown } | undefined;
    const issueNumber = typeof body?.issueNumber === 'number' ? body.issueNumber : Number(body?.issueNumber);
    if (!Number.isFinite(issueNumber)) throw new StudioError(400, '{ issueNumber } 형태가 필요합니다');
    return Response.json(await importRequirementDraftFromIssue(id, issueNumber));
  } catch (error) {
    return errorResponse(error);
  }
}
