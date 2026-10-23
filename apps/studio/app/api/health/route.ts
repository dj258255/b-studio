import { experimentalEnabled } from '@b-studio/agent';
import { localFolderAllowed } from '@/lib/server/repo-token';

/**
 * 컨테이너 헬스체크와 `studio launch`의 확인. 인증 없이 서버 프로세스가 요청을 받는지만 알리고, Docker 연결처럼 느린 확인은 넣지 않는다.
 * `app`은 이 포트의 서버가 b-studio인지 가르는 표지다(launch는 첫 화면을 컴파일하지 않고 이것만 부른다).
 * `terminal`은 세션 터미널을 쓸 수 있는 서버인지(실험 기능을 켠 개인 PC 모드) — `pnpm studio`가 desk를 열기 전에 본다
 */
export function GET() {
  return Response.json({ status: 'ok', app: 'b-studio', terminal: experimentalEnabled() && localFolderAllowed() });
}

// 중첩 라우트(동적 세그먼트가 있는 API)가 스테일해도 이 최상위 라우트는 그대로 응답한다.
// 그 차이를 이용한 확인은 `app/api/health/routes/route.ts`에 있다.
