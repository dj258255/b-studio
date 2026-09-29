import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { openWorkspace } from '@/lib/server/workspace-entry';

/**
 * 첫 화면이 여는 개발 세션을 고르고(없으면 만들고) 샌드박스 켜기를 시작한다. 켜기는 기다리지 않는다.
 * 세션을 만들 수 있어 GET이 아니라 POST다(링크 미리 읽기가 세션을 만들지 않게)
 */
export async function POST(request: Request) {
  try {
    const user = requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown };
    const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined;
    return Response.json(await openWorkspace(user, projectId ? { projectId } : {}));
  } catch (error) {
    return errorResponse(error);
  }
}
