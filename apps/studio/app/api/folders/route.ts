import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { listFolder } from '@/lib/server/folder-browser';
import { localFolderAllowed } from '@/lib/server/sessions';

/**
 * 폴더 선택 모달(ADR-085)이 쓰는 하위 폴더 목록. `?path=`가 없으면 홈 폴더부터 보여준다.
 * `?showHidden=1`이면 점으로 시작하는 폴더도 보여준다(node_modules·.git 내부는 항상 뺀다).
 * 폴더 열기(`POST /api/projects/open`)와 같은 가드를 쓴다 — 서버가 아무 경로나 읽게 되므로 개인 PC 모드에서만 받는다
 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '이 서버에서는 폴더를 둘러볼 수 없습니다. 개인 PC 모드(로컬 CLI)에서만 씁니다');
    const url = new URL(request.url);
    const path = url.searchParams.get('path') ?? undefined;
    const showHidden = url.searchParams.get('showHidden') === '1';
    return Response.json(await listFolder({ path, showHidden }));
  } catch (error) {
    return errorResponse(error);
  }
}
