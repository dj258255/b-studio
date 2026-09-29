import { requireUser } from '@/lib/server/access';
import { validateCommandCodeModelSelection } from '@/lib/server/commandcode-models';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createSession, resolveSessionBackend } from '@/lib/server/sessions';

export async function POST(request: Request) {
  try {
    const user = requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; workspace?: unknown; modelId?: unknown; model?: unknown; backend?: unknown };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    const workspace = body.workspace ?? 'copy';
    if (workspace !== 'copy' && workspace !== 'local') throw new StudioError(400, 'workspace는 copy나 local이어야 합니다');
    // 모델 선택은 model(새 이름)이나 modelId(기존 화면) 둘 다 받는다
    const requestedModel = body.model ?? body.modelId;
    if (requestedModel !== undefined && typeof requestedModel !== 'string') throw new StudioError(400, 'model은 문자열이어야 합니다');
    if (body.backend !== undefined && typeof body.backend !== 'string') throw new StudioError(400, 'backend는 문자열이어야 합니다');
    // 고른 백엔드는 서버가 정한 허용 목록에서만 받는다(B_STUDIO_BACKENDS). 없으면 서버 모드라 지금과 같다
    const backend = resolveSessionBackend(body.backend);
    // commandcode 백엔드에서는 고른 값이 Command Code 모델 id다. 목록에 있는 id만 받는다(목록을 못 불러오면 형식만 본다).
    // 서버 모드가 아니라 이 세션의 백엔드를 본다(레인이 서버 모드와 다른 백엔드를 고를 수 있다)
    const modelId = backend === 'commandcode' ? await validateCommandCodeModelSelection(requestedModel) : requestedModel;
    return Response.json(await createSession(body.projectId, user, workspace, { modelId, backend }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
