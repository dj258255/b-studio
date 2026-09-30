import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { submissionReport } from '@/lib/server/sessions';

/** "제출 준비" 패널이 쓰는 점검표. 읽기만 하고 아무것도 바꾸지 않는다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/submission'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await submissionReport(id));
  } catch (error) {
    return errorResponse(error);
  }
}
