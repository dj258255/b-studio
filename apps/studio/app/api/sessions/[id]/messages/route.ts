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
    // 사람이 보낸 단일 세션 요청이므로 되묻기(ask_user) 도구를 켠다
    return Response.json(sendMessage(id, body.text, { allowBreaking: body.allowBreaking === true, by: user, intent, interactive: true }), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
