import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { getSnapshot, recoverSessions, setSessionLabel, stopSession } from '@/lib/server/sessions';

const patchSchema = z.object({ label: z.string().max(1_000) });

export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    const snapshot = getSnapshot(id);
    if (!snapshot) throw new StudioError(404, '세션을 찾을 수 없습니다');
    return Response.json(snapshot);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext<'/api/sessions/[id]'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json(await stopSession(id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 세션 이름을 바꾼다(studio desk의 Ctrl-b ,, #864). 빈 이름은 이름을 지운다. 길이·제어 글자는 setSessionLabel이 본다 */
export async function PATCH(request: Request, context: RouteContext<'/api/sessions/[id]'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const parsed = patchSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'label은 문자열이어야 합니다');
    return Response.json(await setSessionLabel(id, parsed.data.label));
  } catch (error) {
    return errorResponse(error);
  }
}
