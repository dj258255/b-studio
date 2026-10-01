import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { parseIssueList, previewExport, sessionRequirementIssueNumbers } from '@/lib/server/sessions';
import { integrationIssues, planRequirementIds } from '@/lib/server/task-plans';

/** 올리기 전 미리보기. PR 생성은 사람이 확인한 뒤 결정하므로, 여기서는 아무것도 올리지 않는다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/export/preview'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { issue?: unknown; issues?: unknown };
    // 이 세션이 작업 분해 계획의 통합 세션이면 그 계획이 언급한 요구사항 id들(ADR-113) — 레인을 하나로 합친
    // 병합 커밋 하나로는 못 찾는 요구사항까지 기본 연결·제목에 반영한다
    const planIds = planRequirementIds(id);
    // 이슈 입력이 없으면 통합 세션이면 그 계획의 하위 이슈를, 이 세션이 구현한 요구사항이 이슈로 발행돼 있으면 그 번호도 기본값으로 더한다(ADR-092)
    const issues = parseIssueList(body) ?? [...new Set([...integrationIssues(id), ...(await sessionRequirementIssueNumbers(id, planIds))])];
    return Response.json(await previewExport(id, { issues, planRequirementIds: planIds }));
  } catch (error) {
    return errorResponse(error);
  }
}
