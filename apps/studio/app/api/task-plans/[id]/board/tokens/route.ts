import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { mintBoardToken } from '@/lib/server/task-plans';

/**
 * 이 계획의 게시판에 외부 에이전트(다른 Claude Code 세션·herdr·Codex CLI 등) 하나를 위한 토큰을 내준다.
 * 소유자만 부를 수 있다. 토큰 평문은 이 응답에만 있다 — 서버는 해시가 아니라 평문을 메모리에 들고 있지만
 * (미리보기 토큰과 같은 패턴), 그 평문을 다시 보여주는 API는 없다. 화면은 받은 값을 한 번 보여주고 가린다.
 */
export async function POST(request: Request, context: RouteContext<'/api/task-plans/[id]/board/tokens'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { lane?: unknown; group?: unknown };
    if (typeof body.lane !== 'string' || !body.lane.trim()) throw new StudioError(400, 'lane이 필요합니다');
    if (body.group !== undefined && typeof body.group !== 'string') throw new StudioError(400, 'group은 문자열이어야 합니다');
    const minted = mintBoardToken(id, user, { lane: body.lane, ...(typeof body.group === 'string' && body.group.trim() ? { group: body.group } : {}) });
    const mcpUrl = new URL(`/api/task-plans/${encodeURIComponent(id)}/board/mcp`, request.url).toString();
    return Response.json(
      {
        plan: minted.plan,
        tokenId: minted.tokenId,
        token: minted.token,
        lane: minted.lane,
        ...(minted.group !== undefined ? { group: minted.group } : {}),
        mcp: { url: mcpUrl, header: `Authorization: Bearer ${minted.token}` },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
