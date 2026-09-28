import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { sendMessage } from '@/lib/server/sessions';

export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/messages'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { text?: unknown; allowBreaking?: unknown; intent?: unknown };
    if (typeof body.text !== 'string') throw new StudioError(400, 'text가 필요합니다');
    const intent = body.intent ?? 'build';
    if (intent !== 'build' && intent !== 'ask') throw new StudioError(400, 'intent는 build나 ask여야 합니다');
    // 사람이 보는 단일 세션에서 시작한 실행이라 실행 중 지시를 받는다(레인·플릿은 이 라우트를 쓰지 않는다)
    return Response.json(sendMessage(id, body.text, { allowBreaking: body.allowBreaking === true, by: user, intent, steering: true }), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
