import { errorResponse } from '@/lib/server/errors';
import { listProjects } from '@/lib/server/projects';

export async function GET() {
  try {
    return Response.json(await listProjects());
  } catch (error) {
    return errorResponse(error);
  }
}
