import { requireUser } from '@/lib/server/access';
import { validateCommandCodeModelSelection } from '@/lib/server/commandcode-models';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { projectEffortDefault, projectModelDefault } from '@/lib/server/model-defaults';
import { validateOpenCodeModelSelection } from '@/lib/server/opencode-models';
import { createSession, listSessions, resolveSessionBackend } from '@/lib/server/sessions';
import { recentSessionsFor } from '@/lib/project-menu';

/** 개발 화면 머리의 프로젝트 메뉴(ADR-070)가 "최근 세션"에 쓴다. projectId를 주면 그 프로젝트만, limit로 앞의 몇 개만 자른다 */
const DEFAULT_LIMIT = 20;

export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');
    const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
    const sessions = await listSessions();
    return Response.json(projectId ? recentSessionsFor(sessions, projectId, Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT) : sessions);
  } catch (error) {
    return errorResponse(error);
  }
}

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
    // 요청이 모델을 따로 고르지 않았으면, 이 프로젝트·백엔드에서 대화로 마지막에 고른 모델을 새 세션의 기본값으로 쓴다.
    // 기록된 값이 "기본"(빈 문자열)이면 오버라이드가 없다는 뜻이므로 undefined로 되돌린다(레지스트리 id는 항상 비어 있지 않다)
    const requestedOrRemembered = (requestedModel ?? (typeof body.projectId === 'string' ? projectModelDefault(body.projectId, backend) : undefined)) || undefined;
    // commandcode·opencode 백엔드에서는 고른 값이 그 CLI의 모델 id다. 목록에 있는 id만 받는다(목록을 못 불러오면 형식만 본다).
    // 서버 모드가 아니라 이 세션의 백엔드를 본다(레인이 서버 모드와 다른 백엔드를 고를 수 있다)
    const modelId =
      backend === 'commandcode'
        ? await validateCommandCodeModelSelection(requestedOrRemembered)
        : backend === 'opencode'
          ? await validateOpenCodeModelSelection(requestedOrRemembered)
          : requestedOrRemembered;
    // 노력 단계는 이 새 세션에서 직접 고를 수 없다(모델처럼 요청 바디로 받지 않는다) — 대화로 마지막에 고른 값만 이어받는다
    const effort = (typeof body.projectId === 'string' ? projectEffortDefault(body.projectId, backend) : undefined) || undefined;
    // 사람이 만든 일반 세션은 샌드박스를 지연 기동한다(첫 만들기 요청·"지금 켜기" 때 켠다).
    // 레인·플릿·벤치는 createSession을 직접 불러 기본 eager로 켠다
    return Response.json(await createSession(body.projectId, user, workspace, { modelId, effort, backend, boot: 'on-demand' }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
