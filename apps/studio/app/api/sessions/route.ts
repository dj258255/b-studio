import { requireUser } from '@/lib/server/access';
import { commandCodeMode, validateCommandCodeModelSelection } from '@/lib/server/commandcode-models';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createSession } from '@/lib/server/sessions';

export async function POST(request: Request) {
  try {
    const user = requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; workspace?: unknown; modelId?: unknown };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    const workspace = body.workspace ?? 'copy';
    if (workspace !== 'copy' && workspace !== 'local') throw new StudioError(400, 'workspace는 copy나 local이어야 합니다');
    if (body.modelId !== undefined && typeof body.modelId !== 'string') throw new StudioError(400, 'modelId는 문자열이어야 합니다');
    // commandcode 모드에서는 고른 값이 Command Code 모델 id다. 목록에 있는 id만 받는다(목록을 못 불러오면 형식만 본다)
    const modelId = commandCodeMode() ? await validateCommandCodeModelSelection(body.modelId) : body.modelId;
    return Response.json(await createSession(body.projectId, user, workspace, { modelId }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
