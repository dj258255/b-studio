import { z } from 'zod';
import { authorizeSession } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { sessionTerminalActivityLog } from '@/lib/server/sessions';
import { assertTerminalAccess } from '@/lib/server/terminal-access';

/** 에이전트 id 하나(메인은 `main`). 훅이 준 id를 80자로 자른 값과 맞춘다 */
const agentSchema = z
  .string()
  .min(1)
  .max(80)
  // 제어 글자가 든 값은 어느 에이전트의 id도 아니다
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), '제어 글자가 들어 있습니다');

/**
 * 세션 터미널 CLI의 에이전트별 최근 활동 기록(#1411, ADR-232): 메인과 서브에이전트마다 최근 도구 호출과 코드 조각(고치기·쓰기의 diff, Bash의 명령과 결과 끝 줄).
 * 기억에만 있는 기록이고(세션 기록에 저장하지 않는다), 크기에 상한이 있다. 선택 인자 `agent`로 에이전트 하나만 받는다.
 *
 * 권한 검사는 터미널 출력 통로(GET /api/sessions/[id]/terminal)와 같은 함수를 같은 순서로 거친다: 이 컴퓨터 주소 → 로컬 토큰 → 사용자 → 세션 복구
 * (assertTerminalAccess) → 세션을 만든 사람이나 관리자(authorizeSession) → 쓸 수 있는 서버인가(sessionTerminalActivityLog 안, 터미널 통로의 sessionTerminalTarget과 같은 조건).
 * 터미널 화면에 이미 보이는 내용이라 "보기" 권한이다. 터미널을 여는 쪽의 부수 효과(열려는 시도 표시)가 있는 sessionTerminalTarget은 부르지 않는다
 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/agents/activity'>) {
  try {
    const user = await assertTerminalAccess(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const raw = new URL(request.url).searchParams.get('agent');
    let agent: string | undefined;
    if (raw !== null) {
      const parsed = agentSchema.safeParse(raw);
      if (!parsed.success) throw new StudioError(400, `에이전트 id가 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? '형식 오류'}`);
      agent = parsed.data;
    }
    return Response.json(sessionTerminalActivityLog(id, agent), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
