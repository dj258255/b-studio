import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { listServiceSelection } from '@/lib/server/sessions';

/** 헤더의 "+N" 팝오버·서비스 메뉴가 보여 줄 서비스 목록과 선택 상태(ADR-083) */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/services'>) {
  try {
    requireUser(request.headers);
    const { id } = await context.params;
    return Response.json(listServiceSelection(id));
  } catch (error) {
    return errorResponse(error);
  }
}
