import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { baseStatus, catchUpBase } from '@/lib/server/sessions';

/**
 * 기준 브랜치(main 등)가 이 세션보다 얼마나 앞서 있는지(ADR-076). repository-bar가 가볍게(60초마다) 물어 따라잡기 버튼을 보여준다.
 * ?force=1이면 60초 이내라도 새로 가져온다(사람이 직접 "새로고침"할 때 쓴다)
 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/base'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const force = new URL(request.url).searchParams.get('force') === '1';
    return Response.json(await baseStatus(id, { force }));
  } catch (error) {
    return errorResponse(error);
  }
}

/** main 따라잡기(ADR-076)를 시작한다. 병합·검증까지 오래 걸리므로 결과는 이벤트로 알린다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/base'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    catchUpBase(id);
    return Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
