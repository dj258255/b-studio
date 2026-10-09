import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { parseExploreQaRequest } from '@/lib/server/explore-qa-request';
import { ExploreQaError, getExploreQaRun, saveExploreQaRun, startExploreQa, stopExploreQa } from '@/lib/server/explore-qa-runs';
import { recoverSessions } from '@/lib/server/sessions';

/** 탐색형 QA를 시작·중지하고, 끝난 실행을 게이트 화면 확인(studio.yaml)으로 저장한다. 상태 조회는 GET으로 폴링한다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/explore-qa'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const parsed = parseExploreQaRequest(await request.json().catch(() => undefined));
    if (!parsed.ok) throw new StudioError(400, parsed.message);
    const body = parsed.data;

    switch (body.action) {
      case 'start': {
        const { service, goal, startPath, confirmText, maxActions, maxMs } = body;
        const run = startExploreQa(id, { service, goal, startPath, ...(confirmText ? { confirmText } : {}), ...(maxActions !== undefined ? { maxActions } : {}), ...(maxMs !== undefined ? { maxMs } : {}) });
        return Response.json(run);
      }
      case 'stop':
        stopExploreQa(id);
        return Response.json({ ok: true });
      case 'save': {
        const result = await saveExploreQaRun(id, { service: body.service });
        return Response.json(result);
      }
    }
  } catch (error) {
    if (error instanceof ExploreQaError) return errorResponse(new StudioError(error.status, error.message));
    return errorResponse(error);
  }
}

/** 지금 도는(또는 마지막으로 끝난) 탐색형 QA 실행 상태. 화면이 1초 간격으로 폴링한다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/explore-qa'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const run = getExploreQaRun(id);
    return Response.json(run ?? null);
  } catch (error) {
    return errorResponse(error);
  }
}
