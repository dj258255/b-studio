import { requireUser } from './access';
import { authConfig, isLoopbackHost } from './auth';
import { StudioError } from './errors';
import { hasLocalToken, LOCAL_TOKEN_COOKIE } from './local-token';
import { recoverSessions } from './sessions';

/**
 * 세션 터미널 통로의 공통 검사(#673, B4). 터미널 통로가 둘(한 세션용, 나란히 보기의 묶음용)이라
 * 같은 규칙을 두 번 쓰지 않도록 한 곳에 둔다. 두 통로가 이 함수들을 함께 쓴다
 */

/**
 * 터미널 통로 앞부분의 검사 순서(두 통로가 같은 순서를 쓰게 한 곳에 둔다):
 * 이 컴퓨터 주소 → 로컬 토큰 → 사용자 → 세션 복구 → (그다음 각 통로가 id마다 권한·자리를 본다).
 * 복구를 권한 확인보다 먼저 부르지 않으면, 스튜디오를 다시 띄운 뒤 세션 표가 채워지기 전에 첫 요청이 와서 없는 세션처럼 보인다
 */
export async function assertTerminalAccess(headers: Headers): Promise<string> {
  assertLocalRequest(headers);
  assertLocalToken(headers);
  const user = requireUser(headers);
  await recoverSessions();
  return user;
}

/**
 * 터미널은 컨테이너 안의 셸에 닿는 통로다. 이 컴퓨터의 주소로 들어온 요청만 받는다.
 * 개인 PC 모드에는 인증이 없어서, 다른 사이트가 자기 도메인을 127.0.0.1로 풀리게 하면(DNS 리바인딩) 같은 출처로 보인다
 */
export function assertLocalRequest(headers: Headers): void {
  if (!isLoopbackHost(headers)) throw new StudioError(403, '세션 터미널은 이 컴퓨터의 주소(127.0.0.1 · localhost)로 연 화면에서만 씁니다');
}

/**
 * 개인 PC 모드의 터미널 통로는 `studio launch`가 심은 로컬 토큰 쿠키가 있어야 쓴다(ADR-173 덧붙임).
 * 같은 컴퓨터의 다른 프로세스가 스튜디오 포트로 보내는 요청을 가릴 수단이 인증에는 없기 때문이다. 인증을 켠 서버(token·proxy)는 로그인으로 충분하다
 */
export function assertLocalToken(headers: Headers): void {
  if (authConfig().mode !== 'none') return;
  if (!hasLocalToken(cookieValue(headers, LOCAL_TOKEN_COOKIE))) {
    throw new StudioError(403, '터미널은 `pnpm studio launch`가 연 창에서 씁니다. 다른 창이면 launch가 찍은 주소로 여세요');
  }
}

/** Cookie 헤더에서 이름 하나의 값을 꺼낸다 */
export function cookieValue(headers: Headers, name: string): string | undefined {
  const header = headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
