import { readFile } from 'node:fs/promises';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { ArtifactError } from '@/lib/server/artifacts';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { readSessionArtifact, recoverSessions } from '@/lib/server/sessions';

/** 세션 산출물(화면 확인·요소 선택 스크린샷)을 내려준다. 세션 산출물 폴더 안의 파일만, 세션을 바꿀 수 있는 사람에게 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/artifacts/[...path]'>) {
  try {
    const user = requireUser(request.headers);
    const { id, path: segments } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    const { file, contentType } = await readSessionArtifact(id, segments);
    const data = await readFile(file);
    return new Response(new Uint8Array(data), {
      headers: { 'content-type': contentType, 'cache-control': 'private, max-age=3600' },
    });
  } catch (error) {
    if (error instanceof ArtifactError) return errorResponse(new StudioError(error.status, error.message));
    return errorResponse(error);
  }
}
