import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { ExploreQaError, getExploreQaRun, saveExploreQaRun, startExploreQa, stopExploreQa } from '@/lib/server/explore-qa-runs';
import { recoverSessions } from '@/lib/server/sessions';

const GOAL_MAX = 500;
const PATH_MAX = 300;

const startSchema = z.object({
  action: z.literal('start'),
  service: z.string().min(1).max(63),
  goal: z.string().min(1).max(GOAL_MAX),
  startPath: z.string().min(1).max(PATH_MAX),
  confirmText: z.string().min(1).max(GOAL_MAX).optional(),
  maxActions: z.number().int().min(1).max(60).optional(),
  maxMs: z.number().int().min(10_000).max(15 * 60_000).optional(),
});

const requestSchema = z.union([startSchema, z.object({ action: z.literal('stop') }), z.object({ action: z.literal('save'), service: z.string().min(1).max(63) })]);

/** 탐색형 QA를 시작·중지하고, 끝난 실행을 게이트 화면 확인(studio.yaml)으로 저장한다. 상태 조회는 GET으로 폴링한다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/explore-qa'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const parsed = requestSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, `탐색형 QA 요청이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? '형식 오류'}`);
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
