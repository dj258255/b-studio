import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createFleet, listFleets } from '@/lib/server/fleets';

export function GET(request: Request) {
  try {
    const user = requireUser(request.headers);
    return Response.json(listFleets(user));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as {
      projectId?: unknown;
      request?: unknown;
      modelIds?: unknown;
      allowBreaking?: unknown;
    };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    if (typeof body.request !== 'string') throw new StudioError(400, 'request가 필요합니다');
    if (!Array.isArray(body.modelIds) || body.modelIds.some((id) => typeof id !== 'string')) throw new StudioError(400, 'modelIds가 필요합니다');
    return Response.json(
      await createFleet({ projectId: body.projectId, request: body.request, modelIds: body.modelIds, owner: user, allowBreaking: body.allowBreaking === true }),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
