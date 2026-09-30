import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { previewSessionRequirementsExtraction } from '@/lib/server/sessions';

const bodySchema = z
  .object({
    specText: z.string().min(1).max(200_000).optional(),
    filePath: z.string().min(1).max(500).optional(),
    issueNumber: z.number().int().positive().optional(),
    answers: z.array(z.object({ question: z.string().min(1).max(300), answer: z.string().min(1).max(2_000) })).max(5).optional(),
  })
  .refine((value) => value.specText !== undefined || value.filePath !== undefined || value.issueNumber !== undefined, {
    message: 'specText·filePath·issueNumber 중 하나가 필요합니다',
  });

/**
 * 명세를 요구사항 미리보기로 뽑는다(POST apply와 달리 파일을 쓰지 않는다). 붙여넣은 글·작업 복사본 파일·저장소 이슈 중
 * 하나를 명세로 쓰고, "스펙을 고치고 다시 뽑기"는 answers로 지난 질문의 답을 실어 다시 부른다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/extract'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'specText·filePath·issueNumber 중 하나와, 선택적으로 answers가 필요합니다');
    return Response.json(await previewSessionRequirementsExtraction(id, parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
