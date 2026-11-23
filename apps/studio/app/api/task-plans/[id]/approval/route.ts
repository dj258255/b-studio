import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { approveTaskPlan, getTaskPlan, rejectTaskPlan } from '@/lib/server/task-plans';
import { assertTerminalAccess } from '@/lib/server/terminal-access';

export async function POST(request: Request, context: RouteContext<'/api/task-plans/[id]/approval'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    // 승인할 때 이슈로 올릴지만 더 받는다. 쓰기 범위·작업 목록처럼 계획 실행을 바꾸는 필드는 받지 않는다
    const body = (await request.json().catch(() => ({}))) as { approve?: unknown; reason?: unknown; publishIssues?: unknown };
    if (typeof body.approve !== 'boolean') throw new StudioError(400, 'approve는 true나 false여야 합니다');
    if (body.approve) {
      // 터미널 방식 계획은 승인이 레인 터미널을 연다 — 만들 때와 같은 검사(이 컴퓨터 주소·로컬 토큰)를 승인 전에 거친다.
      // 순서: 로그인 → 계획 확인(runner, 남의 계획이면 여기서 404) → 터미널 통로 검사 → 승인
      if (getTaskPlan(id, user).runner === 'terminal') await assertTerminalAccess(request.headers);
      return Response.json(approveTaskPlan(id, user, { publishIssues: body.publishIssues === true }));
    }
    return Response.json(rejectTaskPlan(id, user, typeof body.reason === 'string' ? body.reason : undefined));
  } catch (error) {
    return errorResponse(error);
  }
}
