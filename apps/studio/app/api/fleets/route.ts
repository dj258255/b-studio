import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createFleet, listFleets } from '@/lib/server/fleets';
import { assertTerminalAccess } from '@/lib/server/terminal-access';
import type { FleetCandidate } from '@/lib/fleet-types';
import type { SessionMode } from '@/lib/studio-events';

export function GET(request: Request) {
  try {
    const user = requireUser(request.headers);
    return Response.json(listFleets(user));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as {
      projectId?: unknown;
      request?: unknown;
      candidates?: unknown;
      modelIds?: unknown;
      allowBreaking?: unknown;
      runner?: unknown;
    };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    if (typeof body.request !== 'string') throw new StudioError(400, 'request가 필요합니다');
    // 후보는 {backend, model?} 짝이거나 기존 입력(모델 id 목록)이다. 둘 다 없으면 서버가 기본 후보를 만든다
    const candidates = parseCandidates(body.candidates);
    const modelIds = parseModelIds(body.modelIds);
    // runner는 terminal 하나뿐이다(없으면 terminal). 'chat'(채팅식)과 모르는 값은 createFleet이 세션을 만들기 전에 400으로 거절한다
    if (body.runner !== undefined && typeof body.runner !== 'string') throw new StudioError(400, 'runner는 terminal이어야 합니다');
    // Fleet은 멤버마다 세션 터미널을 열고 그 안의 CLI를 몬다(이 컴퓨터 방식이면 이 컴퓨터에서 돈다). 세션 터미널 통로와 같은 검사
    // (이 컴퓨터 주소·로컬 토큰)를 거친다 — 로그인만으로 열면 같은 컴퓨터의 다른 프로세스가 터미널 통로의 검사를 비켜 간다
    const user = await assertTerminalAccess(request.headers);
    return Response.json(
      await createFleet({
        projectId: body.projectId,
        request: body.request,
        ...(candidates ? { candidates } : {}),
        ...(modelIds ? { modelIds } : {}),
        owner: user,
        allowBreaking: body.allowBreaking === true,
        ...(body.runner !== undefined ? { runner: body.runner } : {}),
      }),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** `{backend, model?, accountId?}` 배열. 없으면 undefined라 서버가 기본 후보를 만든다 */
function parseCandidates(value: unknown): FleetCandidate[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new StudioError(400, 'candidates는 배열이어야 합니다');
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new StudioError(400, 'candidates의 각 항목은 {backend, model?, accountId?}이어야 합니다');
    const candidate = entry as { backend?: unknown; model?: unknown; accountId?: unknown };
    if (typeof candidate.backend !== 'string') throw new StudioError(400, 'candidates의 각 항목에 backend가 필요합니다');
    if (candidate.model !== undefined && typeof candidate.model !== 'string') throw new StudioError(400, 'candidates의 model은 문자열이어야 합니다');
    if (candidate.accountId !== undefined && typeof candidate.accountId !== 'string') throw new StudioError(400, 'candidates의 accountId는 문자열이어야 합니다');
    return {
      backend: candidate.backend as SessionMode,
      ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
      ...(typeof candidate.accountId === 'string' ? { accountId: candidate.accountId } : {}),
    };
  });
}

/** 기존 입력(모델 레지스트리 id 목록). 서버가 `{backend:'api', model:<id>}`로 본다 */
function parseModelIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new StudioError(400, 'modelIds가 필요합니다');
  return value as string[];
}
