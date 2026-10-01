import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { createSessionDoc } from '@/lib/server/sessions';

const bodySchema = z.object({
  kind: z.enum(['design', 'adr', 'troubleshooting', 'roadmap']),
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).optional(),
});

/**
 * "새 문서": 템플릿으로 다음 번호의 설계 문서(docs/NN-제목.md)나 ADR(docs/adr/ADR-NNN-제목.md)을 만들거나,
 * 트러블슈팅 항목·로드맵 트레이드오프 항목을 해당 문서 끝에 이어 붙인다. body를 주면(대화 메시지 저장 등)
 * 템플릿 대신 그 내용을 쓴다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/docs/new'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, '{ kind, title, body? } 형태가 필요합니다');
    return Response.json(await createSessionDoc(id, parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
