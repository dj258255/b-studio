import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { recommendSessionRequirementQuestions } from '@/lib/server/sessions';

const bodySchema = z.object({
  questions: z.array(z.string().min(1).max(300)).min(1).max(5),
  specText: z.string().max(200_000).optional(),
});

/**
 * "모호한 점" 질문마다 업계 관례에 근거한 추천 답·근거·출처를 받는다("추천 값으로 채우기" 버튼).
 * claude-code 백엔드는 이 호출에서만 WebSearch로 실제 출처를 찾고, 그 밖의 백엔드는 모델 지식만으로 답해
 * 응답의 `sourced: 'model'`로 "출처 확인 필요"임을 알린다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/recommend'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'questions(1~5개)와, 선택적으로 specText가 필요합니다');
    return Response.json(await recommendSessionRequirementQuestions(id, parsed.data, { signal: request.signal }));
  } catch (error) {
    return errorResponse(error);
  }
}
