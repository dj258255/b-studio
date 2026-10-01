import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { applyRegeneratedFilesToSession } from '@/lib/server/sessions';

/**
 * "이 세션에도 적용"(ADR-0XX). 방금 "생성 파일 다시 만들기"로 원본 폴더에 다시 쓴 파일을, 이미 떠 있는
 * 이 세션의 작업 복사본에도 반영하고 영향받은 서비스를 다시 띄운다. 금방 끝나는 재시작이라(에이전트 요청이 아니다)
 * 다른 세션 동작(services·base 등)처럼 바로 기다려 결과를 돌려준다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/regenerate'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const body = (await request.json().catch(() => ({}))) as { files?: unknown };
    const files = Array.isArray(body.files) ? body.files.filter((value): value is string => typeof value === 'string') : [];
    return Response.json(await applyRegeneratedFilesToSession(id, files));
  } catch (error) {
    return errorResponse(error);
  }
}
