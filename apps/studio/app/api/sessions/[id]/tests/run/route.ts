import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { runSessionTests } from '@/lib/server/sessions';

const bodySchema = z.object({
  service: z.string().min(1),
  /** 없으면 서비스의 테스트 전체를 돌린다 */
  file: z.string().min(1).max(500).optional(),
  /** 파일 안의 스위트 경로(바깥→안쪽). @Nested·중첩 describe·class Test*를 좁힐 때 쓴다 */
  suitePath: z.array(z.string().min(1)).max(10).optional(),
  /** 테스트 하나로 좁힐 때 */
  testName: z.string().min(1).max(500).optional(),
});

/**
 * 서비스 하나의 테스트를 돌린다("전체 실행"·"서비스 실행"·"파일 실행"·"이 테스트만 실행"이 모두 이 라우트를 쓰고 좁히는 정도만 다르다).
 * 서비스당 한 번에 하나만 돌고(먼저 도는 게 있으면 409), 끝날 때까지 기다렸다가 새 결과를 돌려준다.
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/tests/run'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'service가 필요합니다');
    return Response.json(await runSessionTests(id, parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
