import { authorizeSession, requireUser } from '@/lib/server/access';
import { assertDesignApprovedForRequest } from '@/lib/server/design-pipeline';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { sendMessage } from '@/lib/server/sessions';

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/messages'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { text?: unknown; allowBreaking?: unknown; allowCheckChanges?: unknown; intent?: unknown; verify?: unknown; research?: unknown; maxTurns?: unknown };
    if (typeof body.text !== 'string') throw new StudioError(400, 'text가 필요합니다');
    const intent = body.intent ?? 'build';
    if (intent !== 'build' && intent !== 'ask') throw new StudioError(400, 'intent는 build나 ask여야 합니다');
    if (body.verify !== undefined && body.verify !== 'full' && body.verify !== 'light') throw new StudioError(400, 'verify는 full이나 light여야 합니다');
    // 턴 상한 요청 옵션(ADR-131). studio.yaml(workflow.maxTurns)보다 우선한다
    if (body.maxTurns !== undefined && (typeof body.maxTurns !== 'number' || !Number.isInteger(body.maxTurns) || body.maxTurns < 1 || body.maxTurns > 300)) {
      throw new StudioError(400, 'maxTurns는 1 이상 300 이하의 정수여야 합니다');
    }
    // 설계 파이프라인(ADR-100): 구현(build) 요청이 승인되지 않은 설계가 다루는 요구사항을 언급하면 시작하기 전에 막는다.
    // 질문(ask)은 파일을 바꾸지 않으므로 대상이 아니다. 그 요구사항을 다루는 설계 문서가 없으면(옵트인) 통과한다
    if (intent === 'build') await assertDesignApprovedForRequest(id, body.text);
    // 사람이 보낸 단일 세션 요청: 되묻기(ask_user) 도구를 켜고, 실행 중 지시를 받는다(레인·플릿은 이 라우트를 쓰지 않는다)
    return Response.json(
      sendMessage(id, body.text, {
        allowBreaking: body.allowBreaking === true,
        // 확인 선언 변경 허용(ADR-164): 사람이 보낸 이 요청에서만 켜진다
        allowCheckChanges: body.allowCheckChanges === true,
        by: user,
        intent,
        // "조사" 모드: 질문(ask)에서만 뜻이 있다(화면도 읽기만일 때만 보여 준다)
        research: body.research === true,
        interactive: true,
        steering: true,
        verify: body.verify === 'light' ? 'light' : undefined,
        maxTurns: typeof body.maxTurns === 'number' ? body.maxTurns : undefined,
      }),
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
