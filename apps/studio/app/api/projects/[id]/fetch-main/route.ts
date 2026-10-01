import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { findRegisteredProject } from '@/lib/server/project-registry';
import { fetchOriginMain } from '@/lib/server/project-source-sync';
import { localFolderAllowed } from '@/lib/server/sessions';

/**
 * "원격 main 받아오기"(ADR-101). 폴더 열기(ADR-067)로 연 프로젝트의 원본 폴더를 원격(origin)의 같은 브랜치로
 * fast-forward만 받는다(힘으로 되돌리거나 덮지 않는다). 폴더 열기와 같은 가드: 개인 PC 모드에서만 받는다.
 */
export async function POST(request: Request, context: RouteContext<'/api/projects/[id]/fetch-main'>) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '이 서버에서는 원격을 받아올 수 없습니다. 개인 PC 모드(로컬 CLI)에서만 씁니다');
    const { id } = await context.params;
    const registered = await findRegisteredProject(id);
    if (!registered) throw new StudioError(404, '등록한 폴더 프로젝트를 찾지 못했습니다');
    return Response.json(await fetchOriginMain(registered.path));
  } catch (error) {
    return errorResponse(error);
  }
}
