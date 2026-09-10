import { errorResponse } from '@/lib/server/errors';
import { contractFor } from '@/lib/server/sessions';

export async function GET(_request: Request, context: RouteContext<'/api/sessions/[id]/services/[service]/contract'>) {
  try {
    const { id, service } = await context.params;
    return Response.json(await contractFor(id, service));
  } catch (error) {
    return errorResponse(error);
  }
}
