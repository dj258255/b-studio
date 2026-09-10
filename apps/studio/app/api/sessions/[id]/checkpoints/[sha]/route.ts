import { errorResponse } from '@/lib/server/errors';
import { checkpointPatch } from '@/lib/server/sessions';

export async function GET(_request: Request, context: RouteContext<'/api/sessions/[id]/checkpoints/[sha]'>) {
  try {
    const { id, sha } = await context.params;
    return Response.json({ patch: await checkpointPatch(id, sha) });
  } catch (error) {
    return errorResponse(error);
  }
}
