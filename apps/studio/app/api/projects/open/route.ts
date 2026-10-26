import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { listProjects } from '@/lib/server/projects';
import { proposeFolder, registerFolder, type WorkspaceChoice } from '@/lib/server/project-registry';
import { localFolderAllowed } from '@/lib/server/sessions';

/**
 * 아무 폴더나 프로젝트로 연다(ADR-067). `{ path }`면 무엇을 할지 제안만 하고, `{ path, apply: true }`면 파일을 쓰고 등록한다.
 * 서버가 이 PC의 아무 경로나 읽고 쓰게 되므로, 내 폴더에서 작업하도록 허용한 개인 PC 모드에서만 받는다
 */
export async function POST(request: Request) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '이 서버에서는 폴더를 열 수 없습니다. 개인 PC 모드(로컬 CLI)에서만 씁니다');
    const body = (await request.json().catch(() => ({}))) as { path?: unknown; apply?: unknown; selectedInfra?: unknown; workspace?: unknown };
    const workspace = workspaceChoice(body.workspace);
    const folder = typeof body.path === 'string' ? body.path.trim() : '';
    if (!folder) throw new StudioError(400, '폴더 경로를 적어 주세요');
    if (!folder.startsWith('/') && !folder.startsWith('~')) throw new StudioError(400, '절대 경로(/로 시작)나 ~로 시작하는 경로를 적어 주세요');
    const resolved = folder.startsWith('~') ? folder.replace(/^~/, process.env.HOME ?? '~') : folder;
    try {
      if (body.apply !== true) return Response.json(await proposeFolder(resolved, undefined, workspace ? { workspace } : {}));
      const taken = new Set((await listProjects()).filter((project) => !project.folder).map((project) => project.id));
      // 폴더 열기 미리보기에서 고른, 기본으로 띄울 부가 서비스(ADR-083). 안 주면 detection.defaultInfra를 쓴다
      const selectedInfra = Array.isArray(body.selectedInfra) ? body.selectedInfra.filter((name): name is string => typeof name === 'string') : undefined;
      return Response.json(await registerFolder(resolved, taken, undefined, { selectedInfra, ...(workspace ? { workspace } : {}) }), { status: 201 });
    } catch (error) {
      // 경로·스택 문제는 사람이 고칠 수 있는 입력 오류로 돌려준다
      if (error instanceof StudioError) throw error;
      throw new StudioError(400, error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    return errorResponse(error);
  }
}

/** 테스트 명령 한 조각의 길이와 조각 수 상한. 사람이 고르거나 쓴 명령 하나라 넉넉하되 끝이 있다 */
const MAX_TEST_PARTS = 64;
const MAX_TEST_PART_LENGTH = 4_000;

/**
 * 코드·테스트만 등록의 선택(#946). 없으면 undefined, 꼴이 틀리면 400이다(조용히 버리지 않는다 — 버리면 지금처럼 거절되어 까닭을 알 수 없다).
 * 명령은 셸을 거치지 않는 exec 꼴로 workflow.tests에 들어가고 샌드박스 컨테이너 안에서만 돈다
 */
function workspaceChoice(value: unknown): WorkspaceChoice | undefined {
  if (value === undefined || value === null) return undefined;
  const test = typeof value === 'object' ? (value as { test?: unknown }).test : undefined;
  const valid =
    Array.isArray(test) &&
    test.length <= MAX_TEST_PARTS &&
    test.every((part) => typeof part === 'string' && part.length <= MAX_TEST_PART_LENGTH && !part.includes('\u0000'));
  if (!valid) throw new StudioError(400, `workspace.test는 문자열 ${MAX_TEST_PARTS}개 이하의 배열이어야 합니다(조각마다 ${MAX_TEST_PART_LENGTH}자 이하)`);
  return { test: test as string[] };
}
