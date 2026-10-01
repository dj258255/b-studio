import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { readSessionDoc, writeSessionDoc } from '@/lib/server/sessions';

/** 문서 하나의 내용. 경로는 "문서" 탭이 다루는 범위(docs/**\/*.md·루트 세 파일) 안이어야 한다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/docs/content'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    const file = new URL(request.url).searchParams.get('path');
    if (!file) throw new StudioError(400, 'path가 필요합니다');
    return Response.json(await readSessionDoc(id, file));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 문서를 고쳐 쓴다(작업 복사본에 바로 반영 — 다음 체크포인트·PR에 그대로 실린다) */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/docs/content'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { path?: unknown; content?: unknown };
    if (typeof body.path !== 'string' || typeof body.content !== 'string') throw new StudioError(400, 'path·content가 필요합니다');
    return Response.json(await writeSessionDoc(id, body.path, body.content));
  } catch (error) {
    return errorResponse(error);
  }
}
