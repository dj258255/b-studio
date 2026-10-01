import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { listSessionDesignDocs, saveSessionDesignDoc } from '@/lib/server/design-pipeline';

/** 설계 파이프라인(ADR-0XX) "파이프라인" 하위 화면: 이 세션의 설계 문서 목록을 읽거나 새로 만든다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/design-docs'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    return Response.json({ docs: await listSessionDesignDocs(id) });
  } catch (error) {
    return errorResponse(error);
  }
}

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
  requirementIds: z.array(z.string()).max(100).optional(),
});

/**
 * 새 설계 문서를 "초안"으로 만든다. body는 보통 "조사"(읽기만) 모드로 받은 설계 답을 그대로 붙여 넣는다.
 * 구현 작업은 이 문서가 "승인됨"이 되기 전까지 이 설계가 다루는 요구사항에서 막힌다(서버가 강제한다)
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/design-docs'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, '{ title, body, requirementIds? } 형태가 필요합니다');
    return Response.json(await saveSessionDesignDoc(id, { ...parsed.data, createdBy: user }));
  } catch (error) {
    return errorResponse(error);
  }
}
