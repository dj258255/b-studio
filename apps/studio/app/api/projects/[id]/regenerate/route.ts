import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { applyRegeneration, proposeRegeneration } from '@/lib/server/project-registry';
import { localFolderAllowed } from '@/lib/server/sessions';

/**
 * "생성 파일 다시 만들기"(ADR-0XX, 폴더 열기 ADR-067의 후속). 폴더 열기와 같은 가드를 쓴다 — 서버가 이 PC의
 * 프로젝트 폴더에 파일을 다시 쓰므로 개인 PC 모드에서만 받는다.
 * GET은 미리보기(아무것도 쓰지 않는다), POST는 사람이 고른 파일만 실제로 다시 쓴다.
 */
export async function GET(request: Request, context: RouteContext<'/api/projects/[id]/regenerate'>) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '이 서버에서는 생성 파일을 다시 만들 수 없습니다. 개인 PC 모드(로컬 CLI)에서만 씁니다');
    const { id } = await context.params;
    return Response.json(await proposeRegeneration(id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext<'/api/projects/[id]/regenerate'>) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '이 서버에서는 생성 파일을 다시 만들 수 없습니다. 개인 PC 모드(로컬 CLI)에서만 씁니다');
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { overwrite?: unknown };
    const overwrite = Array.isArray(body.overwrite) ? body.overwrite.filter((value): value is string => typeof value === 'string') : [];
    return Response.json(await applyRegeneration(id, overwrite));
  } catch (error) {
    return errorResponse(error);
  }
}
