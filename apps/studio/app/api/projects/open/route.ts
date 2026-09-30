import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { listProjects } from '@/lib/server/projects';
import { proposeFolder, registerFolder } from '@/lib/server/project-registry';
import { localFolderAllowed } from '@/lib/server/sessions';

/**
 * 아무 폴더나 프로젝트로 연다(ADR-067). `{ path }`면 무엇을 할지 제안만 하고, `{ path, apply: true }`면 파일을 쓰고 등록한다.
 * 서버가 이 PC의 아무 경로나 읽고 쓰게 되므로, 내 폴더에서 작업하도록 허용한 개인 PC 모드에서만 받는다
 */
export async function POST(request: Request) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '이 서버에서는 폴더를 열 수 없습니다. 개인 PC 모드(로컬 CLI)에서만 씁니다');
    const body = (await request.json().catch(() => ({}))) as { path?: unknown; apply?: unknown; selectedInfra?: unknown };
    const folder = typeof body.path === 'string' ? body.path.trim() : '';
    if (!folder) throw new StudioError(400, '폴더 경로를 적어 주세요');
    if (!folder.startsWith('/') && !folder.startsWith('~')) throw new StudioError(400, '절대 경로(/로 시작)나 ~로 시작하는 경로를 적어 주세요');
    const resolved = folder.startsWith('~') ? folder.replace(/^~/, process.env.HOME ?? '~') : folder;
    try {
      if (body.apply !== true) return Response.json(await proposeFolder(resolved));
      const taken = new Set((await listProjects()).filter((project) => !project.folder).map((project) => project.id));
      // 폴더 열기 미리보기에서 고른, 기본으로 띄울 부가 서비스(ADR-083). 안 주면 detection.defaultInfra를 쓴다
      const selectedInfra = Array.isArray(body.selectedInfra) ? body.selectedInfra.filter((name): name is string => typeof name === 'string') : undefined;
      return Response.json(await registerFolder(resolved, taken, undefined, { selectedInfra }), { status: 201 });
    } catch (error) {
      // 경로·스택 문제는 사람이 고칠 수 있는 입력 오류로 돌려준다
      if (error instanceof StudioError) throw error;
      throw new StudioError(400, error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    return errorResponse(error);
  }
}
