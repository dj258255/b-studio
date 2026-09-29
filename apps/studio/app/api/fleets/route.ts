import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createFleet, listFleets } from '@/lib/server/fleets';
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
    const user = requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as {
      projectId?: unknown;
      request?: unknown;
      candidates?: unknown;
      modelIds?: unknown;
      allowBreaking?: unknown;
    };
    if (typeof body.projectId !== 'string') throw new StudioError(400, 'projectId가 필요합니다');
    if (typeof body.request !== 'string') throw new StudioError(400, 'request가 필요합니다');
    // 후보는 {backend, model?} 짝이거나 기존 입력(모델 id 목록)이다. 둘 다 없으면 서버가 기본 후보를 만든다
    const candidates = parseCandidates(body.candidates);
    const modelIds = parseModelIds(body.modelIds);
    return Response.json(
      await createFleet({
        projectId: body.projectId,
        request: body.request,
        ...(candidates ? { candidates } : {}),
        ...(modelIds ? { modelIds } : {}),
        owner: user,
        allowBreaking: body.allowBreaking === true,
      }),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** `{backend, model?}` 배열. 없으면 undefined라 서버가 기본 후보를 만든다 */
function parseCandidates(value: unknown): FleetCandidate[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new StudioError(400, 'candidates는 배열이어야 합니다');
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new StudioError(400, 'candidates의 각 항목은 {backend, model?}이어야 합니다');
    const candidate = entry as { backend?: unknown; model?: unknown };
    if (typeof candidate.backend !== 'string') throw new StudioError(400, 'candidates의 각 항목에 backend가 필요합니다');
    if (candidate.model !== undefined && typeof candidate.model !== 'string') throw new StudioError(400, 'candidates의 model은 문자열이어야 합니다');
    return { backend: candidate.backend as SessionMode, ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}) };
  });
}

/** 기존 입력(모델 레지스트리 id 목록). 서버가 `{backend:'api', model:<id>}`로 본다 */
function parseModelIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new StudioError(400, 'modelIds가 필요합니다');
  return value as string[];
}
