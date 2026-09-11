import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { listProjects } from '@/lib/server/projects';

export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    return Response.json(await listProjects());
  } catch (error) {
    return errorResponse(error);
  }
}
