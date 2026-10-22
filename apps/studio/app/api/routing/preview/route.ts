import { requireUser } from '@/lib/server/access';
import { previewBackend } from '@/lib/server/backend-rules';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { routingStats } from '@/lib/server/routing-stats';
import { kindRecords } from '@/lib/routing-types';

/**
 * 보내기 전에 이 요청이 어느 AI로 갈지(#822). 로그인은 확인하지 않는다 — 보낼 때 확인하고, 안 되면 다음 후보로 간다.
 * records는 같은 작업 종류에서 AI별로 게이트가 판정한 결과다(#827). 보이기만 하고 고르는 데 쓰지 않는다
 */
export async function POST(request: Request) {
  try {
    requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as { request?: unknown; intent?: unknown };
    if (typeof body.request !== 'string' || !body.request.trim()) throw new StudioError(400, 'request가 필요합니다');
    if (body.request.length > 20_000) throw new StudioError(400, 'request는 2만 자 이하여야 합니다');
    const intent = body.intent ?? 'build';
    if (intent !== 'build' && intent !== 'ask') throw new StudioError(400, 'intent는 build나 ask여야 합니다');
    const decision = previewBackend({ request: body.request, intent });
    return Response.json({ ...decision, records: kindRecords((await routingStats()).rows, decision.kind) });
  } catch (error) {
    return errorResponse(error);
  }
}
