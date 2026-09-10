import { errorResponse } from '@/lib/server/errors';
import { exportSession } from '@/lib/server/sessions';

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/export'>) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { pullRequest?: unknown };
    return Response.json(await exportSession(id, { pullRequest: body.pullRequest === true }));
  } catch (error) {
    return errorResponse(error);
  }
}
