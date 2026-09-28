import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { recoverSessions, sessionDesignThumbnail } from '@/lib/server/sessions';

/** 디자인 목록에 쓸 프레임 썸네일(PNG). Figma 이미지 URL은 서버가 대신 내려받는다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/design/thumbnail'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const frameId = new URL(request.url).searchParams.get('frame') ?? '';
    if (!frameId) throw new StudioError(400, 'frame이 필요합니다');
    const png = await sessionDesignThumbnail(id, frameId);
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
  } catch (error) {
    return errorResponse(error);
  }
}
