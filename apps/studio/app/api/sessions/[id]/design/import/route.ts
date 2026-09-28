import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { importDesign, recoverSessions } from '@/lib/server/sessions';

const bodySchema = z.object({
  frameIds: z.array(z.string().min(1)).min(1).max(50),
  scale: z.union([z.literal(1), z.literal(2)]).optional(),
});

/** 고른 Figma 프레임을 세션 작업 복사본의 design/에 저장한다(=세션 변경으로 남아 체크포인트·게이트를 탄다) */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/design/import'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'frameIds(1~50개)와 scale(1 또는 2)이 필요합니다');
    return Response.json(await importDesign(id, parsed.data.frameIds, parsed.data.scale ?? 1));
  } catch (error) {
    return errorResponse(error);
  }
}
