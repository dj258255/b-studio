import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { recoverSessions, sessionDesignFrames, setSessionDesign } from '@/lib/server/sessions';

const bodySchema = z.object({ fileUrl: z.string().max(2_048) });

/** 세션의 디자인(Figma) 설정 상태와 프레임 목록. 토큰 값은 내려보내지 않는다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/design'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    return Response.json(await sessionDesignFrames(id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 세션 단위로 Figma URL을 저장한다(studio.yaml은 스튜디오가 고치지 않는다). 빈 값이면 세션 설정을 지운다 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/design'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'fileUrl이 필요합니다');
    return Response.json({ design: setSessionDesign(id, parsed.data.fileUrl) });
  } catch (error) {
    return errorResponse(error);
  }
}
