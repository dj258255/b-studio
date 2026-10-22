import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { newSessionModel } from '@/lib/server/new-session';
import { startRoutedSession } from '@/lib/server/routed-session';
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
    const body = (await request.json().catch(() => ({}))) as {
      projectId?: unknown;
      workspace?: unknown;
      modelId?: unknown;
      model?: unknown;
      backend?: unknown;
      route?: unknown;
      request?: unknown;
      intent?: unknown;
      terminal?: unknown;
    };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    const workspace = body.workspace ?? 'copy';
    if (workspace !== 'copy' && workspace !== 'local') throw new StudioError(400, 'workspace는 copy나 local이어야 합니다');
    // 내가 정한 규칙으로 AI를 고르고 첫 요청까지 보낸다(#822). 백엔드·모델을 직접 주면 규칙을 쓰지 않으므로 함께 받지 않는다.
    // route: direct는 같은 흐름에서 규칙 대신 이번 요청만 고른 AI(backend, model?)를 쓴다(#827)
    if (body.route !== undefined) {
      if (body.route !== 'rules' && body.route !== 'direct') throw new StudioError(400, 'route는 rules나 direct여야 합니다');
      if (body.route === 'rules' && (body.backend !== undefined || body.model !== undefined || body.modelId !== undefined)) throw new StudioError(400, '규칙으로 고를 때는 backend·model을 함께 보내지 않습니다');
      if (body.route === 'direct') {
        if (typeof body.backend !== 'string' || !body.backend) throw new StudioError(400, '직접 고를 때는 backend가 필요합니다');
        if (body.model !== undefined && typeof body.model !== 'string') throw new StudioError(400, 'model은 문자열이어야 합니다');
        if (body.modelId !== undefined) throw new StudioError(400, '직접 고를 때는 modelId 대신 model을 씁니다');
      }
      if (typeof body.request !== 'string' || !body.request.trim()) throw new StudioError(400, '규칙이나 직접 고름으로 보낼 때는 request(첫 요청)가 필요합니다');
      const intent = body.intent ?? 'build';
      if (intent !== 'build' && intent !== 'ask') throw new StudioError(400, 'intent는 build나 ask여야 합니다');
      // terminal: true면 대화 러너 대신 고른 AI의 CLI 터미널을 열고 첫 요청을 붙여 넣는다(#836)
      if (body.terminal !== undefined && body.terminal !== true) throw new StudioError(400, 'terminal은 true만 받습니다');
      const direct = body.route === 'direct' ? { backend: body.backend as string, ...(typeof body.model === 'string' ? { model: body.model } : {}) } : undefined;
      return Response.json(
        await startRoutedSession({ projectId: body.projectId, user, workspace, request: body.request, intent, ...(direct ? { direct } : {}), ...(body.terminal === true ? { terminal: true as const } : {}) }),
        { status: 201 },
      );
    }
    if (body.terminal !== undefined) throw new StudioError(400, 'terminal은 route(rules·direct)와 함께만 받습니다');
    // 모델 선택은 model(새 이름)이나 modelId(기존 화면) 둘 다 받는다
    const requestedModel = body.model ?? body.modelId;
    if (requestedModel !== undefined && typeof requestedModel !== 'string') throw new StudioError(400, 'model은 문자열이어야 합니다');
    if (body.backend !== undefined && typeof body.backend !== 'string') throw new StudioError(400, 'backend는 문자열이어야 합니다');
    // 고른 백엔드는 서버가 정한 허용 목록에서만 받는다(B_STUDIO_BACKENDS). 없으면 서버 모드라 지금과 같다
    const backend = resolveSessionBackend(body.backend);
    const { modelId, effort } = await newSessionModel(body.projectId, backend, requestedModel);
    // 사람이 만든 일반 세션은 샌드박스를 지연 기동한다(첫 만들기 요청·"지금 켜기" 때 켠다).
    // 레인·플릿·벤치는 createSession을 직접 불러 기본 eager로 켠다
    return Response.json(await createSession(body.projectId, user, workspace, { modelId, effort, backend, boot: 'on-demand' }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
